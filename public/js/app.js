'use strict';

/* ================= state ================= */
const S = {
  token: localStorage.getItem('wa_token') || null,
  me: null,
  socket: null,
  chats: [],
  activeChatId: null,
  messages: {},   // chatId -> array
  typing: {},     // chatId -> { userId: timeoutId }
  pendingFile: null,
  peerCache: {},  // userId -> user
  // call
  call: null, // { callId, peer, kind, pc, incoming, state, startedAt, timer }
};

/* ================= helpers ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

function badge(verified, big) {
  if (!verified) return '';
  return `<span class="verified-badge${big ? ' lg' : ''}" title="Akun resmi terverifikasi"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-verified"></use></svg></span>`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const today = now.toDateString() === d.toDateString();
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (today) return 'HARI INI';
  if (y.toDateString() === d.toDateString()) return 'KEMARIN';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtListTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' });
}
function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/* ================= API ================= */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 && S.token && path !== '/api/auth/login' && path !== '/api/auth/register') {
      logout(false);
    }
    throw new Error((data && data.error) || `Error ${res.status}`);
  }
  return data;
}

/* ================= auth ================= */
function showAuth(err) {
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  const e = $('authError');
  if (err) { e.textContent = err; e.classList.remove('hidden'); }
  else e.classList.add('hidden');
}

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}

function logout(callServer = true) {
  if (S.call) {
    try { S.socket?.emit('call:hangup', { to: S.call.peer.id, callId: S.call.callId }); } catch { /* noop */ }
    closeCall();
  }
  if (callServer && S.socket) S.socket.disconnect();
  S.token = null; S.me = null; S.chats = []; S.activeChatId = null;
  localStorage.removeItem('wa_token');
  showAuth();
}

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('registerForm').classList.toggle('hidden', tab.dataset.tab !== 'register');
    $('authError').classList.add('hidden');
  });
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    await bootSession(data);
  } catch (err) { showAuth(err.message); }
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), password: f.get('password') } });
    await bootSession(data);
  } catch (err) { showAuth(err.message); }
});

async function bootSession(data) {
  S.token = data.token;
  S.me = data.user;
  localStorage.setItem('wa_token', S.token);
  await startApp();
}

/* ================= boot ================= */
async function startApp() {
  showApp();
  renderMe();
  applyWallpaper();
  await loadChats();
  connectSocket();
}

function renderMe() {
  $('meName').innerHTML = esc(S.me.name) + badge(S.me.verified);
  $('meEmail').textContent = S.me.email;
  setAvatar($('meAvatar'), S.me);

  setAvatar($('menuAvatar'), S.me);
  $('menuName').innerHTML = esc(S.me.name) + badge(S.me.verified);
  $('menuBio').textContent = S.me.about || 'Belum ada bio. Ketuk Profil & Info untuk menambahkan.';
  $('menuVerified').classList.toggle('hidden', !S.me.verified);
}

function setAvatar(el, user) {
  if (!user) return;
  if (user.avatar) {
    el.innerHTML = `<img src="${esc(user.avatar)}" alt="">`;
  } else {
    el.innerHTML = `<span>${esc((user.name || '?').charAt(0).toUpperCase())}</span>`;
  }
  el.querySelectorAll('.online-dot').forEach((d) => d.remove());
  if (user.online) {
    const dot = document.createElement('i');
    dot.className = 'online-dot';
    el.appendChild(dot);
  }
}

/* ================= chats ================= */
async function loadChats() {
  const data = await api('/api/chats');
  S.chats = data.chats || [];
  renderChatList();
}

function chatTitle(chat) {
  return chat.type === 'group' ? chat.name : (chat.peer?.name || 'Pengguna');
}

function previewText(chat) {
  const m = chat.lastMessage;
  if (!m) return 'Mulai percakapan';
  if (m.deleted) return 'Pesan dihapus';
  const kind = { image: '📷 ', video: '🎬 ', audio: '🎵 ', file: '📄 ' }[m.type] || '';
  return kind + (m.body || m.mediaName || '');
}

function renderChatList() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = S.chats.filter((c) => {
    if (!q) return true;
    return chatTitle(c).toLowerCase().includes(q) || (c.peer?.email || '').toLowerCase().includes(q);
  });
  const el = $('chatList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">${q ? 'Tidak ada hasil' : 'Belum ada chat. Tekan ✏️ untuk chat baru.'}</div>`;
    return;
  }
  el.innerHTML = list.map((c) => {
    const last = c.lastMessage;
    const time = last ? fmtListTime(last.createdAt) : '';
    const mine = last && last.senderId === S.me.id;
    const ticks = mine && !last.deleted ? tickHtml(last.status) : '';
    const nameBadge = badge(c.peer?.verified);
    return `
    <div class="chat-item ${c.id === S.activeChatId ? 'active' : ''}" data-chat="${c.id}">
      <div class="avatar" data-peer="${esc(c.peer?.id || '')}"></div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <strong>${esc(chatTitle(c))}${nameBadge}</strong>
          <time class="${c.unread ? 'unread-time' : ''}">${esc(time)}</time>
        </div>
        <div class="chat-item-bottom">
          <div class="chat-item-preview">${ticks}<span>${esc(previewText(c))}</span></div>
          ${c.unread ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  list.forEach((c) => {
    const av = el.querySelector(`.chat-item[data-chat="${c.id}"] .avatar`);
    if (av) setAvatar(av, c.peer);
  });

  el.querySelectorAll('.chat-item').forEach((item) => {
    item.addEventListener('click', () => openChat(item.dataset.chat));
  });
}

function tickHtml(status) {
  if (status === 'read') return '<span class="msg-ticks read">✓✓</span>';
  if (status === 'delivered') return '<span class="msg-ticks">✓✓</span>';
  return '<span class="msg-ticks">✓</span>';
}

$('searchInput').addEventListener('input', renderChatList);

/* ================= open chat ================= */
async function openChat(chatId) {
  const chat = S.chats.find((c) => c.id === chatId);
  if (!chat) return;
  S.activeChatId = chatId;
  $('appView').classList.add('chat-open');
  $('chatEmpty').classList.add('hidden');
  $('chatActive').classList.remove('hidden');

  $('chatName').innerHTML = esc(chatTitle(chat)) + badge(chat.peer?.verified);
  setAvatar($('chatAvatar'), chat.peer);
  updateChatStatus();
  renderChatList();

  if (!S.messages[chatId]) {
    const data = await api(`/api/chats/${chatId}/messages?limit=100`);
    S.messages[chatId] = data.messages;
  }
  renderMessages();
  markRead(chatId);
  $('messageInput').focus();
}

function updateChatStatus() {
  const chat = currentChat();
  if (!chat) return;
  const peer = chat.peer;
  const t = S.typing[chat.id];
  if (t && Object.keys(t).length) {
    $('chatStatus').textContent = 'sedang mengetik...';
  } else if (peer && peer.online) {
    $('chatStatus').textContent = 'online';
  } else if (peer) {
    $('chatStatus').textContent = peer.lastSeen ? `terakhir dilihat ${fmtListTime(peer.lastSeen)} ${fmtTime(peer.lastSeen)}` : 'offline';
  } else {
    $('chatStatus').textContent = 'grup';
  }
}

function currentChat() {
  return S.chats.find((c) => c.id === S.activeChatId) || null;
}

function markRead(chatId) {
  if (!S.socket) return;
  S.socket.emit('chat:read', { chatId });
  api(`/api/chats/${chatId}/read`, { method: 'POST' }).catch(() => {});
  const chat = S.chats.find((c) => c.id === chatId);
  if (chat) chat.unread = 0;
  renderChatList();
}

/* ================= messages render ================= */
function renderMessages() {
  const chat = currentChat();
  if (!chat) return;
  const msgs = S.messages[chat.id] || [];
  const box = $('messages');
  if (!msgs.length) {
    box.innerHTML = `<div class="empty-state">Belum ada pesan. Sapa ${esc(chatTitle(chat))} sekarang 👋</div>`;
    return;
  }
  let html = '';
  let lastDay = '';
  for (const m of msgs) {
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) { html += `<div class="day-divider">${esc(day)}</div>`; lastDay = day; }
    html += messageHtml(m, chat);
  }
  const typingNow = S.typing[chat.id] && Object.keys(S.typing[chat.id]).length;
  if (typingNow) html += `<div class="typing-indicator" id="typingIndicator"><span></span><span></span><span></span></div>`;
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
  bindMessageActions();
}

function messageHtml(m, chat) {
  const out = m.senderId === S.me.id;
  const sender = out ? S.me : (chat.peer || {});
  let inner = '';

  if (m.deleted) {
    inner = `<div class="deleted">🚫 Pesan dihapus</div>`;
  } else {
    if (m.type === 'image' && m.mediaUrl) {
      inner += `<div class="msg-media"><a href="${esc(m.mediaUrl)}" target="_blank" rel="noopener"><img src="${esc(m.mediaUrl)}" alt="${esc(m.mediaName || '')}" loading="lazy"></a></div>`;
    } else if (m.type === 'video' && m.mediaUrl) {
      inner += `<div class="msg-media"><video src="${esc(m.mediaUrl)}" controls preload="metadata"></video></div>`;
    } else if (m.type === 'audio' && m.mediaUrl) {
      inner += `<div class="msg-media"><audio src="${esc(m.mediaUrl)}" controls style="width:260px;max-width:100%"></audio></div>`;
    } else if (m.type === 'file' && m.mediaUrl) {
      inner += `<a class="msg-file" href="${esc(m.mediaUrl)}" download="${esc(m.mediaName || 'file')}">
        <span class="file-ico">📄</span>
        <span class="msg-file-info"><strong>${esc(m.mediaName || 'file')}</strong><small>${esc(fmtSize(m.mediaSize))}</small></span>
      </a>`;
    }
    if (m.body) inner += `<div class="msg-text">${esc(m.body)}</div>`;
  }

  const ticks = out && !m.deleted ? tickHtml(m.status) : '';
  let progress = '';
  if (m.status === 'sending') {
    progress = `<div class="uploading-label">Mengunggah ${m._progress || 0}% • ${esc(fmtSize(m.mediaSize))}</div>
      <div class="uploading-bar"><i style="width:${m._progress || 0}%"></i></div>`;
  }
  return `
  <div class="msg ${out ? 'out' : 'in'}" data-msg="${m.id}">
    ${!out && chat.type === 'group' ? `<div class="msg-sender">${esc(sender.name || '')}</div>` : ''}
    ${inner}
    ${progress}
    <div class="msg-meta">
      <span class="msg-time">${esc(fmtTime(m.createdAt))}</span>
      ${ticks}
    </div>
    ${out && !m.deleted && m.status !== 'sending' ? `<div class="msg-actions"><button data-del="${m.id}" title="Hapus">🗑</button></div>` : ''}
  </div>`;
}

function bindMessageActions() {
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api(`/api/messages/${b.dataset.del}`, { method: 'DELETE' });
      } catch (err) { toast(err.message); }
    });
  });
}

/* ================= socket ================= */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  const socket = io({ auth: { token: S.token } });
  S.socket = socket;

  socket.on('connect_error', (err) => {
    if (/auth/i.test(err.message)) logout();
  });

  socket.on('message:new', (m) => {
    if (!S.messages[m.chatId]) S.messages[m.chatId] = [];
    const arr = S.messages[m.chatId];
    if (!arr.some((x) => x.id === m.id)) arr.push(m);

    const chat = S.chats.find((c) => c.id === m.chatId);
    if (chat) {
      chat.lastMessage = m;
      if (m.senderId !== S.me.id && S.activeChatId !== m.chatId) chat.unread = (chat.unread || 0) + 1;
      S.chats.sort((a, b) => (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
    }
    renderChatList();
    if (S.activeChatId === m.chatId) {
      renderMessages();
      markRead(m.chatId);
      if (m.senderId !== S.me.id) notify(m);
    } else if (m.senderId !== S.me.id) {
      notify(m);
    }
    if (m.senderId !== S.me.id) beep('in');
  });

  socket.on('message:status', ({ messageId, status, chatId }) => {
    const arr = S.messages[chatId];
    if (!arr) return;
    const m = arr.find((x) => x.id === messageId);
    if (m) { m.status = status; renderMessages(); renderChatList(); }
  });

  socket.on('message:deleted', (m) => {
    const arr = S.messages[m.chatId];
    if (!arr) return;
    const i = arr.findIndex((x) => x.id === m.id);
    if (i >= 0) { arr[i] = m; renderMessages(); }
    const chat = S.chats.find((c) => c.id === m.chatId);
    if (chat && chat.lastMessage?.id === m.id) { chat.lastMessage = m; renderChatList(); }
  });

  socket.on('typing', ({ chatId, userId, typing }) => {
    if (!S.typing[chatId]) S.typing[chatId] = {};
    if (typing) {
      clearTimeout(S.typing[chatId][userId]);
      S.typing[chatId][userId] = setTimeout(() => { delete S.typing[chatId][userId]; updateChatStatus(); renderMessages(); }, 3000);
    } else {
      clearTimeout(S.typing[chatId][userId]);
      delete S.typing[chatId][userId];
    }
    if (S.activeChatId === chatId) { updateChatStatus(); renderMessages(); }
  });

  socket.on('presence', ({ userId, online, lastSeen }) => {
    S.chats.forEach((c) => {
      if (c.peer?.id === userId) { c.peer.online = online; if (lastSeen) c.peer.lastSeen = lastSeen; }
    });
    renderChatList();
    if (currentChat()?.peer?.id === userId) updateChatStatus();
  });

  socket.on('chat:updated', ({ chatId }) => {
    api('/api/chats').then((d) => {
      const prevActive = S.activeChatId;
      S.chats = d.chats;
      renderChatList();
      if (prevActive) updateChatStatus();
    }).catch(() => {});
  });

  // calls
  socket.on('call:incoming', onCallIncoming);
  socket.on('call:signal', onCallSignal);
  socket.on('call:ended', onCallEnded);
}

function notify(m) {
  const chat = S.chats.find((c) => c.id === m.chatId);
  const title = chat ? chatTitle(chat) : 'Pesan baru';
  const body = m.body || ({ image: 'Mengirim foto', video: 'Mengirim video', audio: 'Mengirim pesan suara', file: 'Mengirim file' }[m.type]) || 'Pesan baru';
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
  beep('notif');
}

let audioCtx;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    const cfg = kind === 'out' ? [880, .07] : kind === 'notif' ? [660, .1] : [520, .08];
    o.frequency.value = cfg[0];
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(.15, t + .01);
    g.gain.exponentialRampToValueAtTime(.0001, t + cfg[1]);
    o.start(t); o.stop(t + cfg[1] + .02);
  } catch { /* audio not available */ }
}

/* ================= send ================= */
$('btnSend').addEventListener('click', sendMessage);
$('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

let typingTimer;
$('messageInput').addEventListener('input', () => {
  const ta = $('messageInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  if (S.socket && S.activeChatId) {
    S.socket.emit('typing', { chatId: S.activeChatId, typing: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => S.socket.emit('typing', { chatId: S.activeChatId, typing: false }), 1500);
  }
});

async function sendMessage() {
  const chatId = S.activeChatId;
  if (!chatId) return;
  const ta = $('messageInput');
  const text = ta.value.trim();

  if (S.pendingFile) {
    const file = S.pendingFile;
    S.pendingFile = null;
    clearAttachPreview();
    await uploadAndSend(file, text, chatId);
    ta.value = '';
    ta.style.height = 'auto';
    return;
  }

  if (!text) return;
  ta.value = '';
  ta.style.height = 'auto';
  sendViaSocket({ chatId, type: 'text', body: text });
}

function sendViaSocket(payload, localId) {
  beep('out');
  S.socket.emit('message:send', payload, (res) => {
    if (!res?.ok) {
      toast(res?.error || 'Gagal mengirim pesan');
      if (localId && S.messages[payload.chatId]) {
        const arr = S.messages[payload.chatId];
        const i = arr.findIndex((x) => x.id === localId);
        if (i >= 0) arr.splice(i, 1);
        renderMessages();
      }
      return;
    }
    const arr = S.messages[payload.chatId] || (S.messages[payload.chatId] = []);
    if (localId) {
      const i = arr.findIndex((x) => x.id === localId);
      if (i >= 0) arr.splice(i, 1);
    }
    if (res.message && !arr.some((x) => x.id === res.message.id)) {
      arr.push(res.message);
    }
    renderMessages();
  });
}

/* upload with progress (XHR for progress events) */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${S.token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload gagal'));
      } catch { reject(new Error('Upload gagal')); }
    };
    xhr.onerror = () => reject(new Error('Gagal terhubung ke server'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

async function uploadAndSend(file, text, chatId) {
  const localId = 'local-' + Date.now();
  const tmp = {
    id: localId, chatId, senderId: S.me.id,
    type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file',
    body: text || '', mediaUrl: null, mediaName: file.name, mediaSize: file.size,
    mime: file.type, createdAt: Date.now(), status: 'sending', _progress: 0,
  };
  if (!S.messages[chatId]) S.messages[chatId] = [];
  S.messages[chatId].push(tmp);
  renderMessages();

  try {
    const meta = await uploadFile(file, (p) => {
      tmp._progress = Math.round(p * 100);
      const bar = document.querySelector(`[data-msg="${localId}"]`);
      if (bar) {
        const fill = bar.querySelector('.uploading-bar i');
        const label = bar.querySelector('.uploading-label');
        if (fill) fill.style.width = tmp._progress + '%';
        if (label) label.textContent = `Mengunggah ${tmp._progress}% • ${fmtSize(file.size)}`;
      }
    });
    tmp.status = 'sent';
    sendViaSocket({ chatId, type: meta.type, body: text || '', media: meta }, localId);
    beep('out');
  } catch (err) {
    toast(err.message);
    const arr = S.messages[chatId];
    const i = arr.findIndex((x) => x.id === localId);
    if (i >= 0) arr.splice(i, 1);
    renderMessages();
  }
}

/* attach menu */
$('btnAttach').addEventListener('click', (e) => {
  e.stopPropagation();
  $('attachMenu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('attachMenu').classList.add('hidden'));
$('attachMenu').addEventListener('click', (e) => e.stopPropagation());

$('attachMenu').querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    $('attachMenu').classList.add('hidden');
    const kind = b.dataset.kind;
    const input = $('fileInput');
    input.accept = { image: 'image/*', video: 'video/*', audio: 'audio/*', file: '*' }[kind];
    input.value = '';
    input.click();
  });
});

$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 * 1024) {
    toast('Ukuran file maksimal 2GB');
    return;
  }
  S.pendingFile = file;
  const info = $('attachInfo');
  let preview = '';
  if (file.type.startsWith('image/')) {
    preview = `<img src="${URL.createObjectURL(file)}" alt="">`;
  }
  info.innerHTML = `<strong>${esc(file.name)}</strong><small>${esc(fmtSize(file.size))} • siap dikirim</small>`;
  const box = $('attachPreview');
  const oldImg = box.querySelector('img');
  if (oldImg) oldImg.remove();
  if (preview) box.insertAdjacentHTML('afterbegin', preview);
  box.classList.remove('hidden');
});

$('btnCancelAttach').addEventListener('click', clearAttachPreview);
function clearAttachPreview() {
  S.pendingFile = null;
  $('attachPreview').classList.add('hidden');
  $('fileInput').value = '';
}

/* ================= drawer manager ================= */
const DRAWERS = ['menuDrawer', 'newChatDrawer', 'profileDrawer', 'wallpaperDrawer', 'contactDrawer'];

function openDrawer(id, withScrim = true) {
  DRAWERS.forEach((d) => $(d).classList.toggle('hidden', d !== id));
  $('scrim').classList.toggle('hidden', !withScrim);
  $('btnMenu').classList.toggle('open', id === 'menuDrawer');
}

function closeDrawers() {
  DRAWERS.forEach((d) => $(d).classList.add('hidden'));
  $('scrim').classList.add('hidden');
  $('btnMenu').classList.remove('open');
}

function anyDrawerOpen() {
  return DRAWERS.some((d) => !$(d).classList.contains('hidden'));
}

$('scrim').addEventListener('click', closeDrawers);
$('btnMenu').addEventListener('click', () => {
  if ($('menuDrawer').classList.contains('hidden')) openDrawer('menuDrawer');
  else closeDrawers();
});
$('meBox').addEventListener('click', () => openDrawer('menuDrawer'));

/* ================= new chat drawer ================= */
$('btnNewChat').addEventListener('click', () => { openDrawer('newChatDrawer', false); $('userSearchInput').focus(); });
$('btnCloseDrawer').addEventListener('click', closeDrawers);

let searchTimer;
$('userSearchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchUsers, 350);
});

async function searchUsers() {
  const q = $('userSearchInput').value.trim();
  const box = $('userSearchResults');
  if (!q) { box.innerHTML = '<div class="empty-state">Ketik email atau nama teman untuk mulai chat.</div>'; return; }
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    const users = data.users || [];
    if (!users.length) { box.innerHTML = '<div class="empty-state">Pengguna tidak ditemukan.</div>'; return; }
    box.innerHTML = users.map((u) => `
      <div class="chat-item" data-user="${u.id}">
        <div class="avatar"></div>
        <div class="chat-item-body">
          <div class="chat-item-top"><strong>${esc(u.name)}${badge(u.verified)}</strong></div>
          <div class="chat-item-bottom"><div class="chat-item-preview">${esc(u.email)}</div></div>
        </div>
      </div>`).join('');
    users.forEach((u) => setAvatar(box.querySelector(`[data-user="${u.id}"] .avatar`), u));
    box.querySelectorAll('[data-user]').forEach((el) => {
      el.addEventListener('click', () => startDirect(el.dataset.user));
    });
  } catch (err) { toast(err.message); }
}

async function startDirect(peerId) {
  try {
    const data = await api('/api/chats/direct', { method: 'POST', body: { peerId } });
    closeDrawers();
    $('userSearchInput').value = '';
    await loadChats();
    openChat(data.chat.id);
  } catch (err) { toast(err.message); }
}

/* ================= menu drawer ================= */
document.querySelectorAll('.menu-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.menu;
    if (action === 'profile') openProfile();
    else if (action === 'wallpaper') openWallpaper();
    else if (action === 'about') {
      closeDrawers();
      toast('Whatsap Indo v1.0.0 — chat real-time, media 2GB, panggilan WebRTC • MIT');
    } else if (action === 'logout') {
      closeDrawers();
      logout();
    }
  });
});

/* ================= latar belakang chat ================= */
let pendingWpType = 'image';
let wpDraft = { mode: 'cover', scale: 100, dim: 20 };
let wpSaveTimer = null;

function wpSaved() {
  const w = (S.me && S.me.wallpaper) || {};
  return {
    mode: w.mode || 'cover',
    scale: Number(w.scale) || 100,
    dim: w.dim === undefined || w.dim === null ? 20 : Number(w.dim),
  };
}

function wpHasMedia() {
  const w = S.me && S.me.wallpaper;
  return !!(w && w.type !== 'default' && w.url);
}

function updateRangeFill(el) {
  const min = Number(el.min), max = Number(el.max), val = Number(el.value);
  el.style.setProperty('--fill', `${((val - min) / (max - min)) * 100}%`);
}

function syncWallpaperControls(fromSaved = true) {
  if (fromSaved) wpDraft = wpSaved();
  $('wpScale').value = wpDraft.scale;
  $('wpDim').value = wpDraft.dim;
  $('wpScaleVal').textContent = `${wpDraft.scale}%`;
  $('wpDimVal').textContent = `${wpDraft.dim}%`;
  updateRangeFill($('wpScale'));
  updateRangeFill($('wpDim'));
  document.querySelectorAll('#wpFit button').forEach((b) => {
    b.classList.toggle('active', b.dataset.fit === wpDraft.mode);
  });
  const has = wpHasMedia();
  $('wpSettings').classList.toggle('disabled', !has);
  $('wpDisabledNote').classList.toggle('hidden', has);
}

function wpStyle(el, type, mode, scale) {
  if (type === 'image') {
    el.style.backgroundSize = mode === 'tile' ? 'auto' : mode;
    el.style.backgroundRepeat = mode === 'tile' ? 'repeat' : 'no-repeat';
    el.style.transform = `scale(${scale})`;
  } else {
    el.style.objectFit = mode === 'tile' ? 'cover' : mode;
    el.style.transform = `scale(${scale})`;
  }
}

function applyWallpaper() {
  const box = $('chatBg');
  const w = S.me && S.me.wallpaper;
  box.className = 'chat-bg';
  box.innerHTML = '';
  box.style.removeProperty('--wp-dim');
  if (!w || w.type === 'default' || !w.url) return;

  const mode = w.mode || 'cover';
  const scale = (Number(w.scale) || 100) / 100;
  const dim = (w.dim === undefined || w.dim === null ? 20 : Number(w.dim)) / 100;

  box.classList.add('custom');
  box.style.setProperty('--wp-dim', String(dim));

  if (w.type === 'image') {
    if (mode === 'tile') box.classList.add('tile');
    const photo = document.createElement('div');
    photo.className = 'bg-photo';
    photo.style.backgroundImage = `url("${w.url}")`;
    wpStyle(photo, 'image', mode, scale);
    box.appendChild(photo);
  } else if (w.type === 'video') {
    box.classList.add('video-mode');
    const video = document.createElement('video');
    video.src = w.url;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.preload = 'auto';
    wpStyle(video, 'video', mode, scale);
    box.appendChild(video);
    safePlay(video);
  }
}

function safePlay(el) {
  try {
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* autoplay diblokir */ }
}

function openWallpaper() {
  $('wpStatus').classList.add('hidden');
  $('wpStatus').textContent = '';
  syncWallpaperControls();
  renderWallpaperPreview();
  openDrawer('wallpaperDrawer');
}

function renderWallpaperPreview() {
  const w = (S.me && S.me.wallpaper) || { type: 'default', url: null };
  const layer = $('wpPreviewLayer');
  layer.innerHTML = '';
  layer.className = 'wp-preview-layer';
  layer.style.backgroundImage = '';
  layer.style.transform = '';
  layer.style.objectFit = '';
  layer.style.backgroundSize = '';
  layer.style.backgroundRepeat = '';
  layer.style.removeProperty('--wp-dim');

  const mode = wpDraft.mode;
  const scale = wpDraft.scale / 100;
  let label = 'Bawaan Whatsap Indo';

  if (w.type === 'image' && w.url) {
    layer.style.backgroundImage = `url("${w.url}")`;
    wpStyle(layer, 'image', mode, scale);
    label = 'Foto';
  } else if (w.type === 'video' && w.url) {
    const v = document.createElement('video');
    v.src = w.url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', '');
    wpStyle(v, 'video', mode, scale);
    layer.appendChild(v);
    safePlay(v);
    label = 'Video';
  }
  layer.classList.toggle('has-shade', w.type !== 'default' && !!w.url);
  layer.style.setProperty('--wp-dim', String(wpDraft.dim / 100));
  $('wpLabel').textContent = label;

  document.querySelectorAll('.wp-option').forEach((o) => {
    const kind = o.dataset.wp;
    const isActive = kind === 'default'
      ? (!w.url || w.type === 'default')
      : (kind === w.type && !!w.url);
    o.classList.toggle('active', isActive);
  });
}

async function saveWallpaperSettings(showStatus = true) {
  const w = (S.me && S.me.wallpaper) || {};
  try {
    const data = await api('/api/me', {
      method: 'PATCH',
      body: {
        wallpaper: {
          type: w.type || 'default',
          url: w.url || null,
          mode: wpDraft.mode,
          scale: wpDraft.scale,
          dim: wpDraft.dim,
        },
      },
    });
    S.me = data.user;
    wpDraft = wpSaved();
    applyWallpaper();
    if (showStatus) wpSay('Pengaturan latar tersimpan ✓');
    return true;
  } catch (err) {
    if (showStatus) wpSay(err.message, true);
    else toast(err.message);
    return false;
  }
}

function wpSay(msg, isError) {
  const st = $('wpStatus');
  st.classList.remove('hidden');
  st.style.color = isError ? '#d5504f' : '';
  st.textContent = msg;
}

function scheduleWallpaperSave() {
  clearTimeout(wpSaveTimer);
  wpSaveTimer = setTimeout(() => saveWallpaperSettings(true), 550);
}

async function setWallpaper(type, url, statusEl) {
  try {
    const data = await api('/api/me', {
      method: 'PATCH',
      body: {
        wallpaper: {
          type, url,
          mode: wpDraft.mode, scale: wpDraft.scale, dim: wpDraft.dim,
        },
      },
    });
    S.me = data.user;
    wpDraft = wpSaved();
    renderWallpaperPreview();
    applyWallpaper();
    syncWallpaperControls();
    if (statusEl) { statusEl.style.color = ''; statusEl.textContent = 'Latar belakang diperbarui ✓'; }
    else toast(type === 'default' ? 'Latar dikembalikan ke bawaan' : 'Latar belakang diperbarui');
  } catch (err) {
    if (statusEl) { statusEl.style.color = '#d5504f'; statusEl.textContent = err.message; }
    else toast(err.message);
  }
}

document.querySelectorAll('.wp-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.wp;
    if (kind === 'default' || kind === 'clear') { setWallpaper('default', null); return; }
    pendingWpType = kind;
    const input = $('wallpaperInput');
    input.accept = kind === 'image' ? 'image/*' : 'video/*';
    input.value = '';
    input.click();
  });
});

$('wallpaperInput').addEventListener('change', async () => {
  const file = $('wallpaperInput').files[0];
  if (!file) return;
  const maxMB = pendingWpType === 'image' ? 50 : 200;
  if (file.size > maxMB * 1024 * 1024) { toast(`Ukuran maksimal ${maxMB}MB`); return; }
  const expected = pendingWpType === 'image' ? 'image/' : 'video/';
  if (!file.type.startsWith(expected)) { toast('Format file tidak didukung'); return; }
  const st = $('wpStatus');
  st.classList.remove('hidden');
  st.style.color = '';
  try {
    const meta = await uploadFile(file, (p) => { st.textContent = `Mengunggah ${Math.round(p * 100)}%...`; });
    await setWallpaper(pendingWpType, meta.url, st);
  } catch (err) {
    st.style.color = '#d5504f';
    st.textContent = err.message;
  }
});

/* pengaturan ukuran & redup */
document.querySelectorAll('#wpFit button').forEach((btn) => {
  btn.addEventListener('click', () => {
    wpDraft.mode = btn.dataset.fit;
    document.querySelectorAll('#wpFit button').forEach((b) => b.classList.toggle('active', b === btn));
    renderWallpaperPreview();
    if (wpHasMedia()) scheduleWallpaperSave();
  });
});

$('wpScale').addEventListener('input', () => {
  wpDraft.scale = Number($('wpScale').value);
  $('wpScaleVal').textContent = `${wpDraft.scale}%`;
  updateRangeFill($('wpScale'));
  renderWallpaperPreview();
  if (wpHasMedia()) scheduleWallpaperSave();
});

$('wpDim').addEventListener('input', () => {
  wpDraft.dim = Number($('wpDim').value);
  $('wpDimVal').textContent = `${wpDraft.dim}%`;
  updateRangeFill($('wpDim'));
  renderWallpaperPreview();
  if (wpHasMedia()) scheduleWallpaperSave();
});

$('btnSaveWallpaper').addEventListener('click', () => saveWallpaperSettings(true));
$('btnResetWallpaper').addEventListener('click', async () => {
  wpDraft = { mode: 'cover', scale: 100, dim: 20 };
  syncWallpaperControls(false);
  renderWallpaperPreview();
  if (wpHasMedia()) await saveWallpaperSettings(true);
  else wpSay('Pengaturan diatur ulang');
});

/* ================= info kontak ================= */
$('btnContactInfo').addEventListener('click', openContactInfo);

async function openContactInfo() {
  const chat = currentChat();
  if (!chat || !chat.peer) return;
  const body = $('contactBody');
  body.innerHTML = '<div class="empty-state">Memuat info kontak...</div>';
  openDrawer('contactDrawer');
  try {
    const data = await api(`/api/users/${chat.peer.id}`);
    const u = data.user;
    S.peerCache[u.id] = u;
    const peer = { ...chat.peer, ...u };
    body.innerHTML = `
      <div class="contact-hero">
        <div class="avatar avatar-xl ring" id="contactAvatar"></div>
        <h3>${esc(u.name)}${badge(u.verified)}</h3>
        <p class="bio">${esc(u.about || 'Tidak ada bio')}</p>
        <span class="presence">${peer.online ? 'Online' : (u.lastSeen ? `Terakhir dilihat ${fmtListTime(u.lastSeen)} ${fmtTime(u.lastSeen)}` : 'Offline')}</span>
        ${u.verified ? '<span class="chip chip-verified"><svg viewBox="0 0 24 24"><use href="#ic-verified"></use></svg> Akun resmi terverifikasi</span>' : ''}
      </div>
      <div class="contact-card">
        <div class="contact-row"><span class="cr-ico">📧</span><div><small>Email</small><strong>${esc(u.email)}</strong></div></div>
        <div class="contact-row"><span class="cr-ico">🆔</span><div><small>ID Pengguna</small><strong class="mono">${esc(u.id)}</strong></div></div>
        <div class="contact-row"><span class="cr-ico">📅</span><div><small>Bergabung</small><strong>${fmtDate(u.createdAt)}</strong></div></div>
        <div class="contact-row"><span class="cr-ico">🔒</span><div><small>Enkripsi</small><strong>Pesan tersimpan aman di server</strong></div></div>
      </div>
      <div class="contact-actions">
        <button class="btn-ghost" id="ciChat">💬 Pesan</button>
        <button class="btn-ghost" id="ciVoice">📞 Suara</button>
        <button class="btn-ghost" id="ciVideo">🎥 Video</button>
      </div>`;
    setAvatar($('contactAvatar'), peer);
    $('ciChat').addEventListener('click', () => { closeDrawers(); $('messageInput').focus(); });
    $('ciVoice').addEventListener('click', () => { closeDrawers(); startCall('audio'); });
    $('ciVideo').addEventListener('click', () => { closeDrawers(); startCall('video'); });
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}
$('btnCloseContact').addEventListener('click', closeDrawers);
$('btnCloseMenu').addEventListener('click', closeDrawers);
$('btnCloseWallpaper').addEventListener('click', closeDrawers);

/* ================= profile ================= */
function openProfile() {
  $('profileName').value = S.me.name || '';
  $('profileAbout').value = S.me.about || '';
  $('profileEmail').value = S.me.email || '';
  $('bioCount').textContent = String(($('profileAbout').value || '').length);
  setAvatar($('profileAvatar'), S.me);
  $('profileVerified').classList.toggle('hidden', !S.me.verified);
  $('profileAvatarBadge').classList.toggle('hidden', !S.me.verified);
  $('factVerified').textContent = S.me.verified ? 'Terverifikasi ✓' : 'Belum terverifikasi';
  $('factVerified').style.color = S.me.verified ? '#0a6ed1' : '';
  $('factJoined').textContent = fmtDate(S.me.createdAt);
  $('factId').textContent = S.me.id || '—';
  $('profileMsg').classList.add('hidden');
  openDrawer('profileDrawer');
}

$('btnCloseProfile').addEventListener('click', closeDrawers);
$('btnOpenWallpaper').addEventListener('click', openWallpaper);
$('btnLogout').addEventListener('click', () => { closeDrawers(); logout(); });
$('profileAbout').addEventListener('input', () => {
  $('bioCount').textContent = String($('profileAbout').value.length);
});

$('avatarInput').addEventListener('change', async () => {
  const file = $('avatarInput').files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Avatar maksimal 5MB'); return; }
  try {
    const meta = await uploadFile(file, () => {});
    const data = await api('/api/me', { method: 'PATCH', body: { avatar: meta.url } });
    S.me = data.user;
    renderMe();
    setAvatar($('profileAvatar'), S.me);
    toast('Foto profil diperbarui');
  } catch (err) { toast(err.message); }
});

$('btnSaveProfile').addEventListener('click', async () => {
  const msg = $('profileMsg');
  try {
    const data = await api('/api/me', {
      method: 'PATCH',
      body: { name: $('profileName').value, about: $('profileAbout').value },
    });
    S.me = data.user;
    renderMe();
    msg.textContent = 'Tersimpan ✓';
    msg.style.color = '#00a884';
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = '#d33';
    msg.classList.remove('hidden');
  }
});

/* ================= WebRTC calls ================= */
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] };
const RING_TIMEOUT_MS = 60000;    // maksimal menunggu jawaban
const CONNECT_TIMEOUT_MS = 20000; // maksimal menunggu koneksi WebRTC terbentuk
const DROP_GRACE_MS = 8000;       // toleransi 'disconnected' sebelum menutup panggilan

function newCallId() { return 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

function blankCall(fields) {
  return {
    startedAt: null, timer: null, ringTimer: null, connectTimer: null, dropTimer: null,
    pendingSignals: [], pc: null, localStream: null, peerReady: null,
    ...fields,
  };
}

$('btnCallVoice').addEventListener('click', () => startCall('audio'));
$('btnCallVideo').addEventListener('click', () => startCall('video'));

function startCall(kind) {
  const chat = currentChat();
  if (!chat || !chat.peer) { toast('Pilih chat terlebih dahulu'); return; }
  if (S.call) { toast('Sedang dalam panggilan lain'); return; }
  if (!S.socket || !S.socket.connected) { toast('Tidak terhubung ke server'); return; }

  const call = blankCall({
    callId: newCallId(), peer: chat.peer, kind,
    incoming: false, state: 'calling', mic: true, cam: kind === 'video',
  });
  S.call = call;
  openCallUI(call);
  setCallState('Menghubungkan...');

  S.socket.emit('call:invite', { to: chat.peer.id, callId: call.callId, kind }, (res) => {
    if (S.call !== call) return;
    if (!res?.ok) {
      toast(res?.error || 'Tidak dapat menghubungi pengguna');
      closeCall();
      return;
    }
    call.state = 'ringing';
    setCallState('Berdering...');
    armRingTimeout(call);
    // aktifkan mic/kamera lebih awal supaya pratinjau tampil saat berdering
    ensurePeer().catch(() => {});
  });
}

function armRingTimeout(call) {
  clearTimeout(call.ringTimer);
  call.ringTimer = setTimeout(() => {
    if (S.call !== call) return;
    S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId, reason: 'timeout' });
    toast('Panggilan tidak dijawab');
    closeCall();
  }, RING_TIMEOUT_MS);
}

function armConnectTimeout(call) {
  clearTimeout(call.connectTimer);
  call.connectTimer = setTimeout(() => {
    if (S.call !== call || call.startedAt) return;
    setCallState('Koneksi gagal');
    S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId });
    toast('Koneksi panggilan gagal');
    closeCall();
  }, CONNECT_TIMEOUT_MS);
}

function onCallIncoming({ callId, kind, from }) {
  if (!callId || !from || !from.id) return;
  if (S.call) { // sudah sibuk -> tolak otomatis
    S.socket?.emit('call:reject', { to: from.id, callId });
    return;
  }
  const cleanKind = kind === 'video' ? 'video' : 'audio';
  S.call = blankCall({
    callId, peer: from, kind: cleanKind,
    incoming: true, state: 'incoming', mic: true, cam: cleanKind === 'video',
  });
  $('inCallerName').innerHTML = esc(from.name) + badge(from.verified);
  $('inCallKind').textContent = cleanKind === 'video' ? 'Panggilan video masuk...' : 'Panggilan suara masuk...';
  setAvatar($('inCallerAvatar'), from);
  $('incomingCall').classList.remove('hidden');
  beep('notif');
}

$('btnRejectCall').addEventListener('click', () => {
  const call = S.call;
  if (!call) return;
  S.socket?.emit('call:reject', { to: call.peer.id, callId: call.callId });
  closeCall();
});
$('btnAcceptCall').addEventListener('click', async () => {
  const call = S.call;
  if (!call || !call.incoming) return;
  if (!S.socket || !S.socket.connected) { toast('Tidak terhubung ke server'); return; }

  $('incomingCall').classList.add('hidden');
  call.incoming = false;
  call.state = 'connecting';
  openCallUI(call);
  setCallState('Menghubungkan...');
  S.socket.emit('call:accept', { callId: call.callId });

  try {
    await ensurePeer();
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    S.socket.emit('call:signal', {
      to: call.peer.id, callId: call.callId,
      signal: { type: 'offer', offer: call.pc.localDescription },
    });
    setCallState('Menunggu koneksi...');
    armConnectTimeout(call);
  } catch (err) {
    console.warn(err);
    if (S.call === call) { // abortCall sudah menangani kasus izin media ditolak
      toast('Gagal memulai panggilan');
      S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId });
      closeCall();
    }
    return;
  }
  drainSignals();
});

$('btnHangup').addEventListener('click', () => {
  const call = S.call;
  if (!call) return;
  S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId });
  closeCall();
});

function onCallSignal({ callId, signal }) {
  if (!S.call || S.call.callId !== callId) return;
  if (!signal || typeof signal !== 'object') return;
  S.call.pendingSignals.push(signal);
  drainSignals();
}

/* Diproses satu per satu (rantai promise) agar offer/answer/ICE tidak
   saling menabrak ketika getUserMedia masih berjalan. */
let drainChain = Promise.resolve();

function drainSignals() {
  drainChain = drainChain.then(runDrain).catch((err) => console.warn('signal drain', err));
}

async function runDrain() {
  const call = S.call;
  if (!call || !call.pendingSignals.length) return;
  // sinyal untuk panggilan masuk ditampung sampai ditekan "Jawab"
  if (call.incoming && !$('incomingCall').classList.contains('hidden')) return;
  await ensurePeer();
  while (S.call === call && call.pendingSignals.length) {
    await handleSignal(call.pendingSignals.shift());
  }
}

function ensurePeer() {
  const call = S.call;
  if (!call) return Promise.reject(new Error('Panggilan sudah berakhir'));
  if (!call.peerReady) call.peerReady = createPeer(call);
  return call.peerReady;
}

async function createPeer(call) {
  const pc = new RTCPeerConnection(ICE);
  call.pc = pc;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('Akses kamera/mikrofon butuh HTTPS atau localhost');
    abortCall(call, err.message);
    throw err;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call.kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (err) {
    abortCall(call, 'Akses kamera/mikrofon ditolak: ' + (err.message || 'izin ditolak'));
    throw err;
  }

  if (S.call !== call) { // panggilan sudah ditutup selama meminta izin
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Panggilan sudah berakhir');
  }

  call.localStream = stream;
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  $('localVideo').srcObject = stream;
  $('localVideo').style.display = call.kind === 'video' ? 'block' : 'none';
  $('btnToggleMic').disabled = false;
  $('btnToggleCam').disabled = call.kind !== 'video';

  pc.ontrack = (e) => {
    if (S.call !== call || !e.streams || !e.streams[0]) return;
    if (!$('remoteVideo').srcObject) $('remoteVideo').srcObject = e.streams[0];
    $('remoteVideo').style.display = 'block';
    // panggilan suara: avatar tetap tampil; video: avatar hilang saat video tiba
    if (e.track && e.track.kind === 'video') $('callAvatarFallback').style.display = 'none';
    setCallState('Tersambung');
    if (!call.startedAt) startCallTimer();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && S.call === call) {
      S.socket?.emit('call:signal', {
        to: call.peer.id, callId: call.callId,
        signal: { type: 'candidate', candidate: e.candidate },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (S.call !== call) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(call.dropTimer);
      setCallState('Tersambung');
      if (!call.startedAt) startCallTimer();
    } else if (st === 'failed') {
      setCallState('Koneksi gagal');
      finishCall(call, 'Koneksi panggilan gagal');
    } else if (st === 'disconnected') {
      setCallState('Koneksi terputus...');
      clearTimeout(call.dropTimer);
      call.dropTimer = setTimeout(() => {
        if (S.call === call && pc.connectionState !== 'connected') finishCall(call, 'Panggilan terputus');
      }, DROP_GRACE_MS);
    }
  };

  return pc;
}

function abortCall(call, message) {
  if (S.call !== call) return;
  toast(message);
  S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId });
  closeCall();
}

function finishCall(call, message) {
  if (S.call !== call) return;
  toast(message);
  S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId });
  closeCall();
}

async function handleSignal(signal) {
  const call = S.call;
  if (!call || !call.pc) return;
  try {
    if (signal.type === 'offer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
      await flushCandidates(call);
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      S.socket?.emit('call:signal', {
        to: call.peer.id, callId: call.callId,
        signal: { type: 'answer', answer: call.pc.localDescription },
      });
      setCallState('Menunggu koneksi...');
      armConnectTimeout(call);
    } else if (signal.type === 'answer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
      await flushCandidates(call);
      setCallState('Menunggu koneksi...');
      armConnectTimeout(call);
    } else if (signal.type === 'candidate') {
      if (!call.pc.remoteDescription) {
        (call.bufferedCandidates = call.bufferedCandidates || []).push(signal.candidate);
      } else {
        await call.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    }
  } catch (err) { console.warn('signal error', err); }
}

async function flushCandidates(call) {
  const list = call.bufferedCandidates || [];
  call.bufferedCandidates = [];
  for (const c of list) {
    try { await call.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (err) { console.warn(err); }
  }
}

function onCallEnded({ callId, reason }) {
  if (!S.call || S.call.callId !== callId) return;
  // diterima/ditolak di tab lain: cukup tutup layar dering, jangan ganggu panggilan aktif
  if (reason === 'accepted' || reason === 'cancelled') {
    if (S.call.incoming) closeCall();
    return;
  }
  if (reason === 'rejected') toast('Panggilan ditolak');
  else if (reason === 'timeout') toast('Panggilan tidak dijawab');
  else toast('Panggilan diakhiri');
  closeCall();
}

function openCallUI(call) {
  $('callPeerName').innerHTML = esc(call.peer.name) + badge(call.peer.verified);
  setAvatar($('callPeerAvatar'), call.peer);
  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('remoteVideo').style.display = 'none';
  $('localVideo').style.display = 'none';
  $('callAvatarFallback').style.display = 'flex';
  $('btnToggleCam').style.display = call.kind === 'video' ? 'inline-flex' : 'none';
  $('btnToggleMic').classList.remove('off');
  $('btnToggleCam').classList.remove('off');
  $('btnToggleMic').disabled = true;
  $('btnToggleCam').disabled = true;
  $('callTimer').textContent = '00:00';
  $('activeCall').classList.remove('hidden');
}

function setCallState(text) {
  const el = $('callStateText');
  if (el) el.textContent = text;
}

function startCallTimer() {
  const call = S.call;
  if (!call || call.startedAt) return;
  call.startedAt = Date.now();
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    if (!S.call || S.call !== call) { clearInterval(call.timer); return; }
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    $('callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function closeCall() {
  const call = S.call;
  if (!call) return;
  clearInterval(call.timer);
  clearTimeout(call.ringTimer);
  clearTimeout(call.connectTimer);
  clearTimeout(call.dropTimer);
  if (call.localStream) call.localStream.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
  if (call.pc) {
    try {
      call.pc.ontrack = null;
      call.pc.onicecandidate = null;
      call.pc.onconnectionstatechange = null;
      call.pc.close();
    } catch { /* noop */ }
  }
  $('activeCall').classList.add('hidden');
  $('incomingCall').classList.add('hidden');
  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('remoteVideo').style.display = 'none';
  $('localVideo').style.display = 'none';
  $('callAvatarFallback').style.display = 'flex';
  S.call = null;
}

$('btnToggleMic').addEventListener('click', () => {
  const call = S.call;
  if (!call?.localStream) { toast('Mikrofon belum siap'); return; }
  const track = call.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  call.mic = track.enabled;
  $('btnToggleMic').classList.toggle('off', !track.enabled);
});
$('btnToggleCam').addEventListener('click', () => {
  const call = S.call;
  if (!call?.localStream) { toast('Kamera belum siap'); return; }
  const track = call.localStream.getVideoTracks()[0];
  if (!track) { toast('Kamera tidak tersedia'); return; }
  track.enabled = !track.enabled;
  call.cam = track.enabled;
  $('btnToggleCam').classList.toggle('off', !track.enabled);
});

/* ================= misc ui ================= */
$('btnBack').addEventListener('click', () => {
  $('appView').classList.remove('chat-open');
  S.activeChatId = null;
  $('chatActive').classList.add('hidden');
  $('chatEmpty').classList.remove('hidden');
  renderChatList();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawers();
    $('attachMenu').classList.add('hidden');
  }
});

$('chatAvatar').addEventListener('click', openContactInfo);
$('chatName').parentElement.addEventListener('click', openContactInfo);

/* ================= init ================= */
(async function init() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  if (S.token) {
    try {
      const data = await api('/api/auth/me');
      S.me = data.user;
      await startApp();
      return;
    } catch { /* token invalid */ }
  }
  showAuth();
})();
