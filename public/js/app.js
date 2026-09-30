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
  viewOncePending: false, // lampiran berikutnya = foto sekali lihat
  peerCache: {},  // userId -> user
  statusFeed: [], // hasil /api/status (per pengguna)
  groupDraft: { name: '', members: [] },
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
    const code = (data && data.code) || '';
    const isAuthCall = path === '/api/auth/login' || path === '/api/auth/register';
    if (res.status === 401 && S.token && !isAuthCall) {
      logout(false, (data && data.error) || 'Sesi berakhir. Silakan masuk kembali.');
    } else if (res.status === 403 && ['banned', 'pending', 'rejected'].includes(code)) {
      // akun diblokir / ditolak / belum disetujui: hentikan sesi berjalan
      logout(false, (data && data.error) || 'Akun tidak dapat digunakan.');
    }
    throw new Error((data && data.error) || `Error ${res.status}`);
  }
  return data;
}

/* ================= auth ================= */
const AUTH_ERROR_TEXT = {
  'auth:tidak-terautentikasi': 'Sesi berakhir. Silakan masuk kembali.',
  'auth:akun-tidak-ditemukan': 'Akun tidak ditemukan.',
  'auth:sesi-diganti': 'Akun ini dibuka di perangkat lain. Silakan masuk kembali.',
  'auth:diblokir': 'Akun Anda diblokir admin.',
  'auth:menunggu-persetujuan': 'Pendaftaran Anda menunggu persetujuan admin.',
  'auth:ditolak': 'Pendaftaran Anda ditolak admin.',
};

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

function logout(callServer = true, message) {
  if (S.call) {
    try { S.socket?.emit('call:hangup', { to: S.call.peer.id, callId: S.call.callId }); } catch { /* noop */ }
    closeCall();
  }
  const token = S.token;
  if (callServer && token) {
    // cabut sesi di server (satu akun satu device)
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }).catch(() => { /* sesi sudah mati */ });
  }
  if (callServer && S.socket) S.socket.disconnect();
  void unsubscribePush();
  S.token = null; S.me = null; S.chats = []; S.activeChatId = null;
  localStorage.removeItem('wa_token');
  showAuth(message);
  void loadHomeBg(); // kembali ke latar global/bawaan setelah keluar
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
    if (data.pending) {
      // akun baru harus disetujui admin sebelum bisa masuk
      e.target.reset();
      showAuth(data.message || 'Pendaftaran menunggu persetujuan admin.');
      return;
    }
    await bootSession(data);
  } catch (err) { showAuth(err.message); }
});

async function bootSession(data) {
  S.token = data.token;
  S.me = data.user;
  localStorage.setItem('wa_token', S.token);
  if ('Notification' in window && Notification.permission === 'default') {
    // gesture klik tombol Masuk: izin notifikasi agar bisa tampil saat aplikasi ditutup
    Notification.requestPermission().then((perm) => {
      syncNotifUI();
      if (perm === 'granted') void subscribePush();
    }).catch(() => {});
  }
  await startApp();
}

/* ================= boot ================= */
async function startApp() {
  showApp();
  renderMe();
  applyWallpaper();
  void loadHomeBg();
  await loadChats();
  updateComposerButtons();
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
  const isAdmin = S.me.role === 'admin';
  $('menuAdmin').classList.toggle('hidden', !isAdmin);
  $('btnOpenAdminPanel').classList.toggle('hidden', !isAdmin);
}

const PLAN_LABELS = { 'lima-hari': '5 Hari', mingguan: 'Mingguan', bulanan: 'Bulanan' };

function planLabel(id) {
  if (!id) return null;
  return PLAN_LABELS[id] || String(id).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
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
  const scope = S.chats.filter((c) => (sideTab === 'groups' ? c.type === 'group' : true));
  const list = scope.filter((c) => {
    if (!q) return true;
    return chatTitle(c).toLowerCase().includes(q) || (c.peer?.email || '').toLowerCase().includes(q);
  });
  const el = $('chatList');
  if (!list.length) {
    const empty = q
      ? 'Tidak ada hasil'
      : sideTab === 'groups'
        ? 'Belum ada grup. Tekan "Buat grup" di atas untuk memulai.'
        : 'Belum ada chat. Tekan ✏️ untuk chat baru.';
    el.innerHTML = `<div class="empty-state">${empty}</div>`;
    updateNavBadges();
    return;
  }
  el.innerHTML = list.map((c) => {
    const last = c.lastMessage;
    const time = last ? fmtListTime(last.createdAt) : '';
    const mine = last && last.senderId === S.me.id;
    const ticks = mine && !last.deleted ? tickHtml(last.status) : '';
    const nameBadge = badge(c.peer?.verified);
    const isGroup = c.type === 'group';
    return `
    <div class="chat-item ${c.id === S.activeChatId ? 'active' : ''} ${isGroup ? 'is-group' : ''}" data-chat="${c.id}">
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
    if (av) setAvatar(av, c.type === 'group' ? { name: c.name, avatar: c.avatar } : c.peer);
  });

  el.querySelectorAll('.chat-item').forEach((item) => {
    item.addEventListener('click', () => openChat(item.dataset.chat));
  });

  updateNavBadges();
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
  setAvatar($('chatAvatar'), chat.type === 'group' ? { name: chat.name, avatar: chat.avatar } : chat.peer);
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
  } else if (chat.type === 'group') {
    $('chatStatus').textContent = `${chat.memberCount || 0} anggota${chat.role === 'admin' ? ' • Anda admin' : ''}`;
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
  const sender = out
    ? S.me
    : (chat.type === 'group' ? { name: m.senderName || 'Anggota', avatar: m.senderAvatar } : (chat.peer || {}));
  let inner = '';

  if (m.deleted) {
    inner = `<div class="deleted">🚫 Pesan dihapus</div>`;
  } else if (m.viewOnce) {
    inner += m.opened
      ? `<div class="vo-bubble opened">👁️ Foto sekali lihat sudah dibuka</div>`
      : `<button type="button" class="vo-bubble" data-vo="${esc(m.id)}"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-lock" /></svg>Buka foto sekali lihat</button>`;
    if (m.body) inner += `<div class="msg-text">${esc(m.body)}</div>`;
  } else {
    if (m.type === 'image' && m.mediaUrl) {
      inner += `<div class="msg-media"><a href="${esc(m.mediaUrl)}" target="_blank" rel="noopener"><img src="${esc(m.mediaUrl)}" alt="${esc(m.mediaName || '')}" loading="lazy"></a></div>`;
    } else if (m.type === 'video' && m.mediaUrl) {
      inner += `<div class="msg-media"><video src="${esc(m.mediaUrl)}" controls preload="metadata"></video></div>`;
    } else if (m.type === 'audio' && m.mediaUrl) {
      inner += audioPlayerHtml(m);
    } else if (m.type === 'file' && m.mediaUrl) {
      inner += `<a class="msg-file" href="${esc(m.mediaUrl)}" download="${esc(m.mediaName || 'file')}">
        <span class="file-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-doc" /></svg></span>
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
    ${out && !m.deleted && m.status !== 'sending' ? `<div class="msg-actions"><button data-del="${m.id}" title="Hapus"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-trash" /></svg></button></div>` : ''}
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
  document.querySelectorAll('[data-vo]').forEach((b) => {
    b.addEventListener('click', () => openViewOnce(b.dataset.vo));
  });
  bindAudioPlayers();
}

/* ---------- pemutar pesan suara ---------- */
let apAudio = null;
let apWrap = null;

function fmtDur(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function audioPlayerHtml(m) {
  return `<div class="audio-player" data-ap="${esc(m.id)}" data-src="${esc(m.mediaUrl)}">
    <button type="button" class="ap-play" aria-label="Putar"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-play" /></svg></button>
    <div class="ap-track"><i style="width:0%"></i></div>
    <span class="ap-time">${fmtDur((m.duration || 0) / 1000)}</span>
  </div>`;
}

function stopAudio() {
  if (apAudio) { try { apAudio.pause(); } catch { /* noop */ } }
  apAudio = null;
  if (apWrap) {
    apWrap.classList.remove('playing');
    const btn = apWrap.querySelector('.ap-play');
    if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><use href="#ic-play" /></svg>';
    const fill = apWrap.querySelector('.ap-track i');
    if (fill) fill.style.width = '0%';
    const time = apWrap.querySelector('.ap-time');
    if (time) time.textContent = fmtDur((apWrap._dur || 0) / 1000);
  }
  apWrap = null;
}

function bindAudioPlayers() {
  document.querySelectorAll('.audio-player').forEach((wrap) => {
    if (wrap._bound) return;
    wrap._bound = true;
    const btn = wrap.querySelector('.ap-play');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (apWrap === wrap) { stopAudio(); return; }
      stopAudio();
      const audio = new Audio(wrap.dataset.src);
      apAudio = audio;
      apWrap = wrap;
      wrap.classList.add('playing');
      btn.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><use href="#ic-pause" /></svg>';
      audio.addEventListener('loadedmetadata', () => {
        wrap._dur = audio.duration;
        if (isFinite(audio.duration)) wrap.querySelector('.ap-time').textContent = fmtDur(audio.duration);
      });
      audio.addEventListener('timeupdate', () => {
        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        const fill = wrap.querySelector('.ap-track i');
        if (fill) fill.style.width = `${pct}%`;
        wrap.querySelector('.ap-time').textContent = fmtDur(audio.currentTime);
      });
      audio.addEventListener('ended', stopAudio);
      audio.play().catch(() => { stopAudio(); toast('Gagal memutar pesan suara'); });
    });
  });
}

/* ---------- foto sekali lihat ---------- */
function openViewOnce(messageId) {
  const arr = S.messages[S.activeChatId] || [];
  const m = arr.find((x) => x.id === messageId);
  if (!m || !m.mediaUrl) { toast('Foto sekali lihat sudah dibuka'); return; }
  const viewer = $('voViewer');
  const img = $('voImage');
  img.onload = () => {
    // server menandai "sudah dibuka" saat berkas pertama kali diminta
    m.opened = true;
    renderMessages();
  };
  img.onerror = () => {
    m.opened = true;
    renderMessages();
    toast('Foto sekali lihat sudah dibuka');
  };
  img.src = m.mediaUrl;
  viewer.classList.remove('hidden');
}

$('btnCloseVo').addEventListener('click', () => {
  $('voViewer').classList.add('hidden');
  const img = $('voImage');
  img.removeAttribute('src');
});

/* ================= socket ================= */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const socket = io({
    auth: { token: S.token },
    // di hosting Vercel long-polling tidak menempel ke instance yang sama,
    // jadi wajib pakai transport WebSocket saja
    ...(isLocalhost ? {} : { transports: ['websocket'] }),
  });
  S.socket = socket;

  socket.on('connect_error', (err) => {
    // hanya penolakan otentikasi eksplisit (auth:...) yang mengeluarkan user;
    // gangguan sesaat (server:...) dibiarkan dicoba ulang oleh socket.io
    const code = err.message || '';
    if (/^auth:/.test(code)) logout(true, AUTH_ERROR_TEXT[code] || 'Sesi berakhir. Silakan masuk kembali.');
  });

  // sesi diambil alih perangkat lain / dicabut admin
  socket.on('auth:session-replaced', ({ reason } = {}) => {
    const text = reason === 'login-baru'
      ? 'Akun ini dibuka di perangkat lain. Silakan masuk kembali.'
      : 'Sesi Anda dicabut. Silakan masuk kembali.';
    try { socket.disconnect(); } catch { /* sudah putus */ }
    logout(false, text);
  });

  // panel admin: peristiwa pengguna secara real-time
  socket.on('admin:event', (ev) => onAdminEvent(ev));

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

  socket.on('message:viewed', ({ messageId, chatId }) => {
    const arr = S.messages[chatId];
    if (!arr) return;
    const m = arr.find((x) => x.id === messageId);
    if (m) { m.opened = true; renderMessages(); }
  });

  socket.on('status:new', () => {
    if (sideTab === 'status') loadStatus().catch(() => {});
  });

  // premium / peran admin berubah (diberikan lewat panel admin)
  socket.on('profile:updated', async () => {
    try {
      const data = await api('/api/auth/me');
      S.me = data.user;
      renderMe();
      if (!$('profileDrawer').classList.contains('hidden')) openProfile();
      if (!$('menuDrawer').classList.contains('hidden')) {
        $('menuVerified').classList.toggle('hidden', !S.me.verified);
      }
    } catch { /* biarkan */ }
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

/* ================= notifikasi (melayang + sistem + push offline) ================= */
const NOTIF = {
  sound: localStorage.getItem('wa_notif_sound') !== '0',
  sw: null,
  seen: new Map(),
};

function notifPerm() {
  return ('Notification' in window) ? Notification.permission : 'unsupported';
}

function markSeen(id) {
  if (!id) return;
  NOTIF.seen.set(id, Date.now());
  if (NOTIF.seen.size > 120) {
    const cutoff = Date.now() - 120000;
    for (const [k, t] of NOTIF.seen) if (t < cutoff) NOTIF.seen.delete(k);
  }
}

function seenRecently(id) {
  if (!id) return false;
  const t = NOTIF.seen.get(id);
  return !!t && Date.now() - t < 60000;
}

function buildNotifPayload(m) {
  const chat = S.chats.find((c) => c.id === m.chatId);
  const isGroup = !!chat && chat.type === 'group';
  const sender = m.senderName || (chat ? chatTitle(chat) : 'Pesan baru');
  const kind = { image: '📷 Foto', video: '🎬 Video', audio: '🎵 Pesan suara', file: '📄 File' }[m.type];
  let body;
  if (m.deleted) body = 'Pesan dihapus';
  else if (m.viewOnce) body = '📷 Foto sekali lihat';
  else if (m.body) body = kind ? `${kind} • ${m.body}` : m.body;
  else body = kind || 'Pesan baru';
  return {
    title: isGroup ? `${sender} @ ${chatTitle(chat)}` : sender,
    body: body.slice(0, 160),
    chatId: m.chatId,
    messageId: m.id,
    icon: m.senderAvatar || null,
    tag: `msg-${m.chatId}`,
  };
}

// dipanggil setiap pesan masuk lewat socket
function notify(m) {
  if (!m || !S.me || m.senderId === S.me.id) return;
  const payload = buildNotifPayload(m);
  const visible = document.visibilityState === 'visible';
  if (!visible) {
    if (NOTIF.sound) notifSound();
    void showSystemNotif(payload);
    return;
  }
  const reading = S.activeChatId === m.chatId && document.hasFocus();
  if (reading) { if (NOTIF.sound) beep('notif'); return; }
  showNotifCard(payload);
}

// notifikasi push dari service worker (aplikasi tertutup / tab tersembunyi)
function notifyFromPush(data) {
  if (!data || !data.chatId) return;
  if (data.messageId && seenRecently(data.messageId)) return;
  const visible = document.visibilityState === 'visible';
  const reading = S.activeChatId === data.chatId && document.hasFocus();
  if (visible) {
    if (reading) return;
    showNotifCard(data);
  } else {
    void showSystemNotif(data);
  }
}

function showNotifCard(data) {
  const layer = $('notifLayer');
  if (!layer) return;
  if (data.messageId) {
    if (seenRecently(data.messageId)) return;
    markSeen(data.messageId);
  }
  const card = document.createElement('div');
  card.className = 'notif-card';
  card.innerHTML = `
    <div class="notif-av avatar">${data.icon
      ? `<img src="${esc(data.icon)}" alt="">`
      : `<span>${esc(String(data.title || '?').charAt(0).toUpperCase())}</span>`}</div>
    <div class="notif-txt">
      <div class="notif-top"><strong>${esc(data.title || 'Pesan baru')}</strong><span class="notif-time">sekarang</span></div>
      <p>${esc(data.body || '')}</p>
    </div>
    <button class="notif-x" aria-label="Tutup notifikasi"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-close" /></svg></button>`;
  card.querySelector('.notif-x').addEventListener('click', (e) => {
    e.stopPropagation();
    dismissNotif(card);
  });
  card.addEventListener('click', () => {
    dismissNotif(card);
    window.focus();
    if (data.chatId && S.activeChatId !== data.chatId) openChat(data.chatId);
  });
  layer.appendChild(card);
  while (layer.children.length > 3) dismissNotif(layer.firstElementChild, true);
  if (NOTIF.sound) notifSound();
  try { navigator.vibrate && navigator.vibrate([50, 30, 50]); } catch { /* getar tidak tersedia */ }
  card._t = setTimeout(() => dismissNotif(card), 5200);
  card.addEventListener('mouseenter', () => clearTimeout(card._t));
  card.addEventListener('mouseleave', () => { card._t = setTimeout(() => dismissNotif(card), 2600); });
}

function dismissNotif(card, instant) {
  if (!card || card._gone) return;
  card._gone = true;
  clearTimeout(card._t);
  if (instant) { card.remove(); return; }
  card.classList.add('leaving');
  setTimeout(() => card.remove(), 260);
}

async function showSystemNotif(data) {
  if (notifPerm() !== 'granted') return;
  if (data.messageId) markSeen(data.messageId);
  const options = {
    body: data.body || '',
    tag: data.tag || 'wa-message',
    data,
  };
  if (data.icon) options.icon = data.icon;
  try {
    const reg = NOTIF.sw || (await navigator.serviceWorker?.ready);
    if (reg && reg.showNotification) {
      await reg.showNotification(data.title || 'Pesan baru', options);
      return;
    }
  } catch { /* fallback di bawah */ }
  try { new Notification(data.title || 'Pesan baru', options); } catch { /* izin/dukungan */ }
}

function notifSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1174.7, 0.11]].forEach(([freq, delay]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(.17, t + delay + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t + delay + .17);
      o.start(t + delay);
      o.stop(t + delay + .22);
    });
  } catch { beep('notif'); }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    NOTIF.sw = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'wa-push') notifyFromPush(msg.data || {});
      else if (msg.type === 'wa-open-chat' && msg.chatId) {
        window.focus();
        if (S.activeChatId !== msg.chatId) openChat(msg.chatId);
      }
    });
    if (notifPerm() === 'granted') await subscribePush();
  } catch { /* service worker tidak tersedia */ }
}

async function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || notifPerm() !== 'granted') return;
    const reg = NOTIF.sw || await navigator.serviceWorker.ready;
    const key = await api('/api/push/vapid-public-key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key.publicKey),
    });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch (err) { console.warn('push subscribe:', err.message); }
}

async function unsubscribePush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = NOTIF.sw || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  } catch { /* langganan sudah lepas */ }
}

async function enableNotif() {
  if (!('Notification' in window)) { toast('Browser ini tidak mendukung notifikasi'); return; }
  try {
    const perm = await Notification.requestPermission();
    syncNotifUI();
    if (perm === 'granted') {
      await subscribePush();
      try {
        await showSystemNotif({ title: 'Notifikasi aktif ✓', body: 'Anda akan diberi tahu saat ada pesan masuk.', tag: 'wa-test' });
      } catch { /* opsional */ }
      toast('Notifikasi aktif ✓');
    } else if (perm === 'denied') {
      toast('Izin notifikasi diblokir. Izinkan lewat ikon gembok di bilah alamat.');
    }
  } catch (err) { toast(err.message); }
}

function syncNotifUI() {
  const btn = $('btnEnableNotif');
  const txt = $('notifPermText');
  const snd = $('notifSoundToggle');
  if (snd) snd.checked = NOTIF.sound;
  if (!btn || !txt) return;
  const p = notifPerm();
  if (p === 'granted') { txt.textContent = 'Sistem • aktif (online & offline)'; btn.textContent = 'Aktif'; btn.disabled = true; }
  else if (p === 'denied') { txt.textContent = 'Sistem • diblokir oleh browser'; btn.textContent = 'Diblokir'; btn.disabled = true; }
  else if (p === 'unsupported') { txt.textContent = 'Sistem • tidak didukung browser ini'; btn.textContent = 'Tidak didukung'; btn.disabled = true; }
  else { txt.textContent = 'Sistem • izinkan agar muncul walau aplikasi ditutup'; btn.textContent = 'Aktifkan'; btn.disabled = false; }
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
  updateComposerButtons();
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
    const viewOnce = S.viewOncePending;
    S.pendingFile = null;
    clearAttachPreview();
    await uploadAndSend(file, text, chatId, { viewOnce });
    ta.value = '';
    ta.style.height = 'auto';
    updateComposerButtons();
    return;
  }

  if (!text) return;
  ta.value = '';
  ta.style.height = 'auto';
  updateComposerButtons();
  sendViaSocket({ chatId, type: 'text', body: text });
}

function updateComposerButtons() {
  if (rec) return;
  const hasText = !!$('messageInput').value.trim();
  const showSend = hasText || !!S.pendingFile;
  $('btnSend').classList.toggle('hidden', !showSend);
  $('btnMic').classList.toggle('hidden', showSend || !$('btnMic'));
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
function putPresigned(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.url) resolve(data);
        else reject(new Error(data.error || 'Upload gagal'));
      } catch { reject(new Error('Upload gagal')); }
    };
    xhr.onerror = () => reject(new Error('Gagal terhubung ke penyimpanan'));
    xhr.send(file);
  });
}

async function uploadFile(file, onProgress) {
  // di hosting file dikirim langsung ke Blob (lolos batas 4,5MB per request);
  // bila endpoint tanda tangan tidak ada (mode lokal) -> upload lewat server
  try {
    const sign = await api('/api/uploads/sign', {
      method: 'POST',
      body: { name: file.name, size: file.size, mime: file.type },
    });
    const stored = await putPresigned(sign.presignedUrl, file, onProgress);
    return { url: stored.url, name: sign.name, size: file.size, mime: sign.mime, type: sign.type };
  } catch { /* lanjutkan dengan upload server */ }

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

async function uploadAndSend(file, text, chatId, opts = {}) {
  const localId = 'local-' + Date.now();
  const tmp = {
    id: localId, chatId, senderId: S.me.id,
    type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file',
    body: text || '', mediaUrl: null, mediaName: file.name, mediaSize: file.size,
    mime: file.type, createdAt: Date.now(), status: 'sending', _progress: 0,
    viewOnce: !!opts.viewOnce, duration: opts.duration || 0,
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
    sendViaSocket({
      chatId,
      type: meta.type,
      body: text || '',
      media: meta,
      viewOnce: !!opts.viewOnce,
      duration: opts.duration || 0,
    }, localId);
    beep('out');
  } catch (err) {
    toast(err.message);
    const arr = S.messages[chatId];
    const i = arr.findIndex((x) => x.id === localId);
    if (i >= 0) arr.splice(i, 1);
    renderMessages();
  } finally {
    updateComposerButtons();
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
    if (kind === 'viewonce') {
      S.viewOncePending = true;
      input.accept = 'image/*';
      input.value = '';
      input.click();
      return;
    }
    S.viewOncePending = false;
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
    S.viewOncePending = false;
    return;
  }
  if (S.viewOncePending && !file.type.startsWith('image/')) {
    toast('Foto sekali lihat hanya untuk gambar');
    S.viewOncePending = false;
    return;
  }
  S.pendingFile = file;
  const info = $('attachInfo');
  let preview = '';
  if (file.type.startsWith('image/')) {
    preview = `<img src="${URL.createObjectURL(file)}" alt="">`;
  }
  info.innerHTML = `<strong>${esc(file.name)}</strong><small>${esc(fmtSize(file.size))} • ${S.viewOncePending ? 'sekali lihat • ' : ''}siap dikirim</small>`;
  const box = $('attachPreview');
  const oldImg = box.querySelector('img');
  if (oldImg) oldImg.remove();
  box.insertAdjacentHTML('afterbegin', preview);
  box.classList.toggle('view-once', S.viewOncePending);
  box.classList.remove('hidden');
});

$('btnCancelAttach').addEventListener('click', clearAttachPreview);
function clearAttachPreview() {
  S.pendingFile = null;
  S.viewOncePending = false;
  $('attachPreview').classList.add('hidden');
  $('attachPreview').classList.remove('view-once');
  $('fileInput').value = '';
}

/* ================= drawer manager ================= */
const DRAWERS = ['menuDrawer', 'newChatDrawer', 'profileDrawer', 'wallpaperDrawer', 'homeBgDrawer', 'contactDrawer',
  'groupDrawer', 'groupInfoDrawer', 'statusComposer', 'privacyDrawer', 'adminDrawer'];

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
          <div class="chat-item-bottom"><div class="chat-item-preview">${esc(u.email || "Email disembunyikan")}</div></div>
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

/* ================= tema: terang / gelap ================= */
function themeNow() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function renderTheme() {
  const t = themeNow();
  const title = $('themeTitle');
  const label = $('themeLabel');
  const ico = $('themeIco');
  if (title) title.textContent = t === 'dark' ? 'Mode Terang' : 'Mode Gelap';
  if (label) label.textContent = t === 'dark' ? 'Mode gelap aktif — ketuk untuk mode terang'
    : 'Mode terang aktif — ketuk untuk mode gelap';
  const use = ico && ico.querySelector('use');
  if (use) use.setAttribute('href', t === 'dark' ? '#ic-sun' : '#ic-moon');
}

function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('wa_theme', theme); } catch (e) { /* storage diblokir */ }
  renderTheme();
}

function toggleTheme() { applyTheme(themeNow() === 'dark' ? 'light' : 'dark'); }

renderTheme();

/* ================= menu drawer ================= */
document.querySelectorAll('.menu-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.menu;
    if (action === 'profile') openProfile();
    else if (action === 'wallpaper') openWallpaper();
    else if (action === 'homebg') openHomeBg();
    else if (action === 'theme') toggleTheme();
    else if (action === 'privacy') openPrivacy();
    else if (action === 'admin') openAdminPanel();
    else if (action === 'about') {
      closeDrawers();
      toast('Whatsap Indo v1.0.0 — chat real-time, media 2GB, panggilan WebRTC • MIT • © mazval-developer-java', 4200);
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

  document.querySelectorAll('.wp-option[data-wp]').forEach((o) => {
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

document.querySelectorAll('.wp-option[data-wp]').forEach((btn) => {
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

/* ================= latar halaman utama (milik pengguna) ================= */
let pendingHbType = 'image';

function homeBgOf() {
  const own = S.me && S.me.homeBg;
  if (own && own.type !== 'default' && own.url) return own;
  return { type: 'default', url: null };
}

function openHomeBg() {
  $('hbStatus').classList.add('hidden');
  $('hbStatus').textContent = '';
  renderHomeBgPreview();
  openDrawer('homeBgDrawer');
}

function renderHomeBgPreview() {
  const bg = homeBgOf();
  const layer = $('hbPreviewLayer');
  layer.className = 'wp-preview-layer';
  layer.innerHTML = '';
  layer.style.backgroundImage = '';
  if (bg.type === 'image' && bg.url) {
    layer.style.backgroundImage = `url("${bg.url}")`;
    layer.classList.add('has-shade');
  } else if (bg.type === 'video' && bg.url) {
    const v = document.createElement('video');
    v.src = bg.url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', '');
    layer.appendChild(v);
    layer.classList.add('has-shade');
    safePlay(v);
  }
  $('hbLabel').textContent = bg.type === 'video' ? 'Video' : bg.type === 'image' ? 'Foto' : 'Bawaan Whatsap Indo';
  document.querySelectorAll('[data-hb]').forEach((o) => {
    const kind = o.dataset.hb;
    o.classList.toggle('active', kind === 'clear'
      ? bg.type === 'default'
      : (kind === bg.type && !!bg.url));
  });
}

function hbSay(msg, isError) {
  const st = $('hbStatus');
  st.classList.remove('hidden');
  st.style.color = isError ? '#d5504f' : '';
  st.textContent = msg;
}

async function saveHomeBg(type, url) {
  try {
    const data = await api('/api/me', { method: 'PATCH', body: { homeBg: { type, url: url || null } } });
    S.me = data.user;
    renderHomeBgPreview();
    await loadHomeBg();
    hbSay('Latar halaman utama tersimpan ✓');
    toast(type === 'default' ? 'Latar dikembalikan ke bawaan' : 'Latar halaman utama diperbarui');
  } catch (err) {
    hbSay(err.message, true);
  }
}

document.querySelectorAll('[data-hb]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.hb;
    if (kind === 'clear') { saveHomeBg('default', null); return; }
    pendingHbType = kind;
    const input = $('homeBgInput');
    input.accept = kind === 'image' ? 'image/*' : 'video/*';
    input.value = '';
    input.click();
  });
});

$('homeBgInput').addEventListener('change', async () => {
  const file = $('homeBgInput').files[0];
  if (!file) return;
  const maxMB = pendingHbType === 'image' ? 50 : 200;
  if (file.size > maxMB * 1024 * 1024) { toast(`Ukuran maksimal ${maxMB}MB`); return; }
  const expected = pendingHbType === 'image' ? 'image/' : 'video/';
  if (!file.type.startsWith(expected)) { toast('Format file tidak didukung'); return; }
  const st = $('hbStatus');
  st.classList.remove('hidden');
  st.style.color = '';
  try {
    const meta = await uploadFile(file, (p) => { st.textContent = `Mengunggah ${Math.round(p * 100)}%...`; });
    await saveHomeBg(pendingHbType, meta.url);
  } catch (err) {
    st.style.color = '#d5504f';
    st.textContent = err.message;
  }
});

$('btnSaveHomeBg').addEventListener('click', async () => {
  const bg = homeBgOf();
  await saveHomeBg(bg.type, bg.url);
});
$('btnCloseHomeBg').addEventListener('click', closeDrawers);

/* ================= info kontak ================= */
$('btnContactInfo').addEventListener('click', openContactInfo);

// khusus admin: ganti foto profil bot lewat panel info kontak
function bindBotAvatarEdit(user, peer) {
  const input = $('ciAvatarInput');
  $('ciAvatarBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Foto profil maksimal 5MB'); return; }
    try {
      const meta = await uploadFile(file, () => {});
      const res = await api(`/api/admin/bots/${user.id}`, { method: 'PATCH', body: { avatar: meta.url } });
      const updated = res.user;
      S.peerCache[updated.id] = updated;
      S.chats.forEach((c) => {
        if (c.peer && c.peer.id === updated.id) c.peer = { ...c.peer, ...updated };
      });
      setAvatar($('contactAvatar'), { ...peer, ...updated });
      renderChatList();
      if (currentChat()?.peer?.id === updated.id) updateChatStatus();
      toast('Foto profil bot diperbarui');
    } catch (err) { toast(err.message); }
  });
}

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
    const canEditBot = !!u.isBot && S.me.role === 'admin';
    body.innerHTML = `
      <div class="contact-hero">
        <div class="gi-avatar-wrap">
          <div class="avatar avatar-xl ring" id="contactAvatar"></div>
          ${canEditBot ? '<button class="avatar-edit" id="ciAvatarBtn" type="button" title="Ganti foto profil bot"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-image" /></svg></button>' : ''}
        </div>
        <input type="file" id="ciAvatarInput" accept="image/*" class="hidden" />
        <h3>${esc(u.name)}${badge(u.verified)}</h3>
        <p class="bio">${esc(u.about || 'Tidak ada bio')}</p>
        <span class="presence">${u.isBot
          ? 'Bot resmi • Siap membantu'
          : (peer.online ? 'Online' : (u.lastSeen ? `Terakhir dilihat ${fmtListTime(u.lastSeen)} ${fmtTime(u.lastSeen)}` : 'Offline'))}</span>
        ${u.verified ? '<span class="chip chip-verified"><svg viewBox="0 0 24 24"><use href="#ic-verified"></use></svg> Akun resmi terverifikasi</span>' : ''}
      </div>
      <div class="contact-card">
        <div class="contact-row"><span class="cr-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-mail" /></svg></span><div><small>Email</small><strong>${u.email ? esc(u.email) : "<span class=\"muted\">Disembunyikan</span>"}</strong></div></div>
        <div class="contact-row"><span class="cr-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-id" /></svg></span><div><small>ID Pengguna</small><strong class="mono">${esc(u.id)}</strong></div></div>
        <div class="contact-row"><span class="cr-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-calendar" /></svg></span><div><small>Bergabung</small><strong>${fmtDate(u.createdAt)}</strong></div></div>
        <div class="contact-row"><span class="cr-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-lock" /></svg></span><div><small>Enkripsi</small><strong>Pesan tersimpan aman di server</strong></div></div>
      </div>
      <div class="contact-actions">
        <button class="btn-ghost" id="ciChat"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-chat" /></svg> Pesan</button>
        ${u.isBot ? '' : `
        <button class="btn-ghost" id="ciVoice"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-phone" /></svg> Suara</button>
        <button class="btn-ghost" id="ciVideo"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-video" /></svg> Video</button>`}
      </div>`;
    setAvatar($('contactAvatar'), peer);
    $('ciChat').addEventListener('click', () => { closeDrawers(); $('messageInput').focus(); });
    if (!u.isBot) {
      $('ciVoice').addEventListener('click', () => { closeDrawers(); startCall('audio'); });
      $('ciVideo').addEventListener('click', () => { closeDrawers(); startCall('video'); });
    }
    if (canEditBot) bindBotAvatarEdit(u, peer);
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
  const prem = S.me.premium || {};
  $('factPlan').textContent = prem.active
    ? `${planLabel(prem.plan) || 'Premium'} • s/d ${fmtDate(prem.until)}`
    : 'Gratis';
  $('factPlan').style.color = prem.active ? '#0a6ed1' : '';
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

/* ================= privasi ================= */
const PV_KEYS = ['lastSeen', 'receipts', 'email', 'bio', 'status', 'avatar'];

function pvStatus(msg, isError) {
  const el = $('pvStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#d33' : '#00a884';
  el.classList.remove('hidden');
}

function openPrivacy() {
  PV_KEYS.forEach((key) => {
    const input = document.querySelector(`[data-pv="${key}"]`);
    if (input) input.checked = !!(S.me && S.me.privacy && S.me.privacy[key]);
  });
  $('pvStatus').classList.add('hidden');
  syncNotifUI();
  openDrawer('privacyDrawer');
}

document.querySelectorAll('[data-pv]').forEach((input) => {
  input.addEventListener('change', async () => {
    const key = input.dataset.pv;
    const prev = input.checked;
    try {
      const data = await api('/api/me', { method: 'PATCH', body: { privacy: { [key]: prev } } });
      S.me = data.user;
      renderMe();
      pvStatus('Tersimpan ✓');
    } catch (err) {
      input.checked = !prev;
      pvStatus(err.message, true);
    }
  });
});

$('btnOpenPrivacy').addEventListener('click', openPrivacy);
$('btnClosePrivacy').addEventListener('click', closeDrawers);
$('btnOpenAdminPanel').addEventListener('click', () => { closeDrawers(); openAdminPanel(); });
$('btnEnableNotif').addEventListener('click', enableNotif);
$('notifSoundToggle').addEventListener('change', (e) => {
  NOTIF.sound = e.target.checked;
  localStorage.setItem('wa_notif_sound', NOTIF.sound ? '1' : '0');
  if (NOTIF.sound) beep('notif');
});

/* ================= panel admin ================= */
const adm = { plans: [], homeBg: { type: 'default', url: null }, pendingBg: null, users: [], pending: [], logs: [], timer: null };

const ADMIN_EVENT_LABEL = {
  registered: 'mendaftar — menunggu persetujuan',
  approved: 'disetujui admin',
  rejected: 'ditolak admin',
  banned: 'diblokir admin',
  unbanned: 'dibuka blokirnya',
  login: 'masuk ke akun',
  logout: 'keluar dari akun',
  online: 'daring',
  offline: 'luring',
};

async function openAdminPanel() {
  if (!S.me || S.me.role !== 'admin') { toast('Hanya admin yang bisa membuka panel ini'); return; }
  openDrawer('adminDrawer');
  $('admMsg').classList.add('hidden');
  $('admBgMsg').classList.add('hidden');
  try {
    const [data, mon] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/monitor'),
    ]);
    adm.plans = data.plans || [];
    adm.homeBg = data.homeBg || { type: 'default', url: null };
    adm.pendingBg = null;
    renderAdmStats(data.stats);
    renderAdmPlans();
    renderAdmPlanSelect();
    renderAdmBg();
    renderAdmUsers(data.recent || []);
    renderAdmMonitor(mon);
  } catch (err) { toast(err.message); }
}

async function refreshAdminMonitor() {
  if (!S.me || S.me.role !== 'admin') return;
  if ($('adminDrawer').classList.contains('hidden')) return;
  try {
    const mon = await api('/api/admin/monitor');
    renderAdmMonitor(mon);
  } catch { /* panel akan memuat ulang saat dibuka lagi */ }
}

function renderAdmMonitor(mon) {
  adm.users = mon.users || [];
  adm.pending = mon.pending || [];
  adm.logs = mon.logs || [];
  if (mon.stats) renderAdmStats(mon.stats);

  const onlineCount = adm.users.filter((u) => u.online).length;
  $('admLiveText').textContent = `${onlineCount} daring • ${adm.users.length} pengguna • ${adm.logs.length} upaya masuk terakhir`;
  $('admLive').classList.toggle('is-offline', onlineCount === 0);

  const badgeCount = $('admPendingCount');
  badgeCount.textContent = adm.pending.length;
  badgeCount.classList.toggle('hidden', adm.pending.length === 0);

  $('admPending').innerHTML = adm.pending.map((u) => `
    <div class="adm-user" data-row="${esc(u.id)}">
      <div class="adm-user-info">
        <strong>${esc(u.name)}</strong>
        <small>${esc(u.email)} • daftar ${fmtListTime(u.createdAt)}</small>
      </div>
      <div class="adm-user-tags">
        <button class="tag tag-grant" data-act="approve" data-id="${esc(u.id)}">Setujui</button>
        <button class="tag tag-revoke" data-act="reject" data-id="${esc(u.id)}">Tolak</button>
      </div>
    </div>`).join('') || '<div class="empty-state">Tidak ada pendaftaran menunggu.</div>';

  $('admLogs').innerHTML = adm.logs.slice(0, 12).map((l) => `
    <div class="adm-log log-${esc(l.result)}">
      <span class="adm-log-time">${fmtTime(l.at)}</span>
      <span class="adm-log-mail">${esc(l.email || '—')}</span>
      <span class="adm-log-res">${logLabel(l.result)}</span>
    </div>`).join('') || '<div class="empty-state">Belum ada upaya masuk.</div>';

  $('admMonitor').innerHTML = adm.users.map((u) => `
    <div class="adm-user" data-row="${esc(u.id)}">
      <div class="adm-user-info">
        <strong><i class="adm-dot${u.online ? ' on' : ''}"></i>${esc(u.name)}${badge(u.verified)}</strong>
        <small>${esc(u.email)}${u.lastDevice ? ` • ${esc(uaShort(u.lastDevice))}` : ''} • ${u.online ? 'daring' : (u.lastSeen ? `terakhir ${fmtListTime(u.lastSeen)}` : 'belum pernah')}</small>
      </div>
      <div class="adm-user-tags">${admTags(u)}</div>
    </div>`).join('') || '<div class="empty-state">Tidak ada pengguna.</div>';
}

function logLabel(result) {
  return ({
    success: 'masuk', pending: 'menunggu', rejected: 'ditolak', banned: 'diblokir',
    failed: 'gagal', logout: 'keluar',
  })[result] || result;
}

function uaShort(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Perangkat lain';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows'
    : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} • ${os}` : browser;
}

function admTags(u) {
  const tags = [];
  if (u.status === 'banned') {
    tags.push(`<span class="tag tag-ban" title="${esc(u.bannedReason || '')}">Diblokir</span>`);
    tags.push(`<button class="tag tag-grant" data-act="unban" data-id="${esc(u.id)}">Buka blokir</button>`);
    return tags.join('');
  }
  if (u.status === 'pending') {
    tags.push('<span class="tag tag-pending">Menunggu</span>');
    tags.push(`<button class="tag tag-grant" data-act="approve" data-id="${esc(u.id)}">Setujui</button>`);
    tags.push(`<button class="tag tag-revoke" data-act="reject" data-id="${esc(u.id)}">Tolak</button>`);
    return tags.join('');
  }
  if (u.status === 'rejected') {
    tags.push(`<span class="tag tag-rej" title="${esc(u.rejectReason || '')}">Ditolak</span>`);
    tags.push(`<button class="tag tag-grant" data-act="approve" data-id="${esc(u.id)}">Setujui</button>`);
    return tags.join('');
  }
  if (u.role === 'admin') tags.push('<span class="tag tag-admin">Admin</span>');
  else tags.push('<span class="tag tag-on">Aktif</span>');
  if (u.premiumActive) tags.push(`<span class="tag tag-prem">${esc(planLabel(u.plan) || 'Premium')}</span>`);
  tags.push(`<button class="tag tag-revoke" data-act="ban" data-id="${esc(u.id)}">Blokir</button>`);
  return tags.join('');
}

const ADM_ACTION_MSG = {
  approve: 'disetujui — akun bisa masuk',
  reject: 'ditolak — akun tidak bisa masuk',
  banned: 'diblokir — sesi diputus',
  unbanned: 'dibuka blokirnya',
  unban: 'dibuka blokirnya',
};

async function admAction(act, id, name) {
  const body = {};
  if (act === 'reject' || act === 'ban') {
    const reason = window.prompt(act === 'ban' ? `Alasan memblokir ${name || 'akun'}:` : `Alasan menolak ${name || 'akun'}:`, '');
    if (reason === null) return; // dibatalkan
    body.reason = reason.trim();
  }
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(id)}/${act}`, { method: 'POST', body });
    admMsg('admMsg', `${name || 'Akun'} ${ADM_ACTION_MSG[act] || act}`, false);
    if (data.stats) renderAdmStats(data.stats);
    await refreshAdminMonitor();
    await searchAdminUsers();
  } catch (err) { admMsg('admMsg', err.message, true); }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act][data-id]');
  if (!btn || !$('adminDrawer') || $('adminDrawer').classList.contains('hidden')) return;
  const row = btn.closest('.adm-user');
  const name = row ? (row.querySelector('.adm-user-info strong')?.textContent || '').trim() : '';
  void admAction(btn.dataset.act, btn.dataset.id, name);
});

// peristiwa real-time dari server (pendaftaran, masuk/daring, blokir)
function onAdminEvent(ev) {
  if (!ev || !ev.type) return;
  const who = ev.user?.name || ev.name || ev.user?.email || '';
  const label = ADMIN_EVENT_LABEL[ev.type];
  const drawerOpen = $('adminDrawer') && !$('adminDrawer').classList.contains('hidden');
  if (!drawerOpen) {
    if (ev.type === 'registered') toast(`${who} mendaftar — menunggu persetujuan`);
    return;
  }
  if (label) admMsg('admMsg', `${who} ${label}`, ev.type === 'rejected' || ev.type === 'banned');
  clearTimeout(adm.timer);
  adm.timer = setTimeout(refreshAdminMonitor, 250);
}

function renderAdmStats(stats) {
  const items = [
    ['Pengguna', stats.users], ['Chat', stats.chats], ['Pesan', stats.messages],
    ['Status', stats.statuses], ['Premium aktif', stats.premium],
    ['Menunggu', stats.pending], ['Diblokir', stats.banned],
  ];
  $('admStats').innerHTML = items.map(([label, val]) => `
    <div class="adm-stat"><strong>${Number(val) || 0}</strong><span>${label}</span></div>`).join('');
}

function renderAdmPlanSelect() {
  $('admPlan').innerHTML = adm.plans.map((p) =>
    `<option value="${esc(p.id)}">${esc(p.label)} • ${p.days} hari</option>`).join('');
}

function renderAdmPlans() {
  $('admPlans').innerHTML = adm.plans.map((p, i) => `
    <div class="adm-plan-row">
      <input type="text" value="${esc(p.label)}" data-plan-label="${i}" maxlength="30" />
      <input type="number" min="1" max="3650" value="${p.days}" data-plan-days="${i}" />
      <span>hari</span>
    </div>`).join('');
}

function admMsg(elId, msg, isError) {
  const el = $(elId);
  el.textContent = msg;
  el.style.color = isError ? '#d33' : '#00a884';
  el.classList.remove('hidden');
}

function renderAdmUsers(users) {
  $('admUsers').innerHTML = users.map((u) => `
    <div class="adm-user">
      <div class="adm-user-info">
        <strong><i class="adm-dot${u.online ? ' on' : ''}"></i>${esc(u.name)}${badge(u.verified)}</strong>
        <small>${esc(u.email)}</small>
      </div>
      <div class="adm-user-tags">
        ${u.role === 'admin' ? '<span class="tag tag-admin">Admin</span>' : ''}
        ${u.status === 'banned' ? `<span class="tag tag-ban" title="${esc(u.bannedReason || '')}">Diblokir</span>` : ''}
        ${u.status === 'pending' ? '<span class="tag tag-pending">Menunggu</span>' : ''}
        ${u.status === 'rejected' ? `<span class="tag tag-rej" title="${esc(u.rejectReason || '')}">Ditolak</span>` : ''}
        ${u.premiumActive ? `<span class="tag tag-prem">${esc(planLabel(u.plan) || 'Premium')}</span>` : ''}
        ${u.premiumActive
          ? `<button class="tag tag-revoke" data-revoke="${esc(u.email)}">Cabut</button>`
          : `<button class="tag tag-grant" data-grant="${esc(u.email)}">Beri premium</button>`}
        ${u.status === 'pending' ? `<button class="tag tag-grant" data-act="approve" data-id="${esc(u.id)}">Setujui</button>` : ''}
        ${u.status === 'pending' ? `<button class="tag tag-revoke" data-act="reject" data-id="${esc(u.id)}">Tolak</button>` : ''}
        ${u.status === 'rejected' ? `<button class="tag tag-grant" data-act="approve" data-id="${esc(u.id)}">Setujui</button>` : ''}
        ${u.role !== 'admin' && u.status !== 'pending'
          ? (u.status === 'banned'
              ? `<button class="tag tag-grant" data-act="unban" data-id="${esc(u.id)}">Buka blokir</button>`
              : `<button class="tag tag-revoke" data-act="ban" data-id="${esc(u.id)}">Blokir</button>`)
          : ''}
      </div>
    </div>`).join('') || '<div class="empty-state">Tidak ada pengguna.</div>';

  $('admUsers').querySelectorAll('[data-grant]').forEach((b) => {
    b.addEventListener('click', () => {
      $('admEmail').value = b.dataset.grant;
      $('adminDrawer').scrollTo({ top: 0, behavior: 'smooth' });
      $('admEmail').focus();
    });
  });
  $('admUsers').querySelectorAll('[data-revoke]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        const data = await api('/api/admin/premium/revoke', { method: 'POST', body: { email: b.dataset.revoke } });
        admMsg('admMsg', `Premium dicabut dari ${b.dataset.revoke}`, false);
        renderAdmStats(data.stats);
        const row = b.closest('.adm-user');
        if (row) row.outerHTML = '';
      } catch (err) { admMsg('admMsg', err.message, true); }
    });
  });
}

$('btnGrantPremium').addEventListener('click', async () => {
  const email = $('admEmail').value.trim();
  const plan = $('admPlan').value;
  if (!email) { admMsg('admMsg', 'Masukkan email pengguna dulu', true); return; }
  try {
    const data = await api('/api/admin/premium', { method: 'POST', body: { email, plan } });
    const until = fmtDate(data.user.premiumUntil);
    admMsg('admMsg', `${email} → ${data.plan.label} aktif s/d ${until} + centang biru menyala`, false);
    renderAdmStats(data.stats);
    await searchAdminUsers();
  } catch (err) { admMsg('admMsg', err.message, true); }
});

let admSearchTimer;
$('admSearch').addEventListener('input', () => {
  clearTimeout(admSearchTimer);
  admSearchTimer = setTimeout(searchAdminUsers, 300);
});

async function searchAdminUsers() {
  try {
    const q = $('admSearch').value.trim();
    const data = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
    renderAdmUsers(data.users || []);
  } catch { /* daftar terakhir dipertahankan */ }
}

$('btnSavePlans').addEventListener('click', async () => {
  const plans = adm.plans.map((p, i) => ({
    id: p.id,
    label: (document.querySelector(`[data-plan-label="${i}"]`)?.value || p.label).trim(),
    days: Number(document.querySelector(`[data-plan-days="${i}"]`)?.value || p.days),
  }));
  try {
    const data = await api('/api/admin/settings', { method: 'PUT', body: { plans } });
    adm.plans = data.plans;
    renderAdmPlans();
    renderAdmPlanSelect();
    admMsg('admMsg', 'Paket disimpan ✓', false);
  } catch (err) { admMsg('admMsg', err.message, true); }
});

function renderAdmBg() {
  const bg = adm.pendingBg || adm.homeBg || { type: 'default', url: null };
  const box = $('admBgPreview');
  if (!bg.url) {
    box.innerHTML = '<span class="adm-bg-default">Background bawaan</span>';
    return;
  }
  box.innerHTML = bg.type === 'video'
    ? `<video src="${esc(bg.url)}" muted autoplay loop playsinline></video>`
    : `<img src="${esc(bg.url)}" alt="">`;
}

$('admBgPhoto').addEventListener('click', () => {
  $('admBgInput').accept = 'image/*';
  $('admBgInput').value = '';
  $('admBgInput').click();
});
$('admBgVideo').addEventListener('click', () => {
  $('admBgInput').accept = 'video/*';
  $('admBgInput').value = '';
  $('admBgInput').click();
});
$('admBgDefault').addEventListener('click', () => {
  adm.pendingBg = { type: 'default', url: null };
  renderAdmBg();
});
$('admBgInput').addEventListener('change', async () => {
  const file = $('admBgInput').files[0];
  if (!file) return;
  const isVideo = file.type.startsWith('video/');
  if (isVideo && file.size > 200 * 1024 * 1024) { admMsg('admBgMsg', 'Video maksimal 200MB', true); return; }
  if (!isVideo && file.size > 50 * 1024 * 1024) { admMsg('admBgMsg', 'Foto maksimal 50MB', true); return; }
  try {
    const meta = await uploadFile(file, () => {});
    adm.pendingBg = { type: isVideo ? 'video' : 'image', url: meta.url };
    renderAdmBg();
    admMsg('admBgMsg', 'Terpasang di pratinjau — tekan Simpan Background', false);
  } catch (err) { admMsg('admBgMsg', err.message, true); }
});
$('btnSaveHomeBg').addEventListener('click', async () => {
  const bg = adm.pendingBg || adm.homeBg;
  try {
    const data = await api('/api/admin/settings', { method: 'PUT', body: { homeBg: bg } });
    adm.homeBg = data.homeBg;
    adm.pendingBg = null;
    renderAdmBg();
    void loadHomeBg(); // hormati latar milik pengguna bila ada, baru setelan global
    admMsg('admBgMsg', 'Background beranda disimpan ✓', false);
  } catch (err) { admMsg('admBgMsg', err.message, true); }
});

$('btnCloseAdmin').addEventListener('click', closeDrawers);

/* ================= background beranda (halaman masuk) ================= */
function setHomeLayer(el, bg) {
  if (!el) return;
  const hasBg = !!(bg && bg.url && bg.type !== 'default');
  el.innerHTML = '';
  if (!hasBg) return;
  if (bg.type === 'video') {
    const v = document.createElement('video');
    v.src = bg.url;
    v.autoplay = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    el.appendChild(v);
    safePlay(v);
  } else {
    const img = document.createElement('img');
    img.src = bg.url;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    el.appendChild(img);
  }
}

// latar beranda tampil di tiga tempat: layar masuk, sidebar (daftar chat), layar kosong
function applyHomeBg(bg) {
  setHomeLayer($('homeBg'), bg);
  setHomeLayer($('sideHomeBg'), bg);
  setHomeLayer($('emptyHomeBg'), bg);
}

async function loadHomeBg() {
  try {
    const own = S.me && S.me.homeBg;
    if (own && own.type !== 'default' && own.url) {
      applyHomeBg(own);
      return;
    }
    const data = await api('/api/settings/public');
    applyHomeBg(data.homeBg);
  } catch { /* latar bawaan */ }
}

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
    $('voViewer').classList.add('hidden');
    if (!$('storyViewer').classList.contains('hidden')) closeStory();
  }
});

$('chatAvatar').addEventListener('click', openChatInfo);
$('chatTitleBox').addEventListener('click', openChatInfo);

/* ================= tab sidebar: chats / status ================= */
let sideTab = 'chats';

document.querySelectorAll('.bn-item').forEach((btn) => {
  btn.addEventListener('click', () => switchSide(btn.dataset.side));
});
$('btnCreateGroupTab').addEventListener('click', () => $('btnNewGroup').click());

function switchSide(tab) {
  sideTab = tab === 'status' ? 'status' : tab === 'groups' ? 'groups' : 'chats';
  document.querySelectorAll('.bn-item').forEach((b) => b.classList.toggle('active', b.dataset.side === sideTab));
  const onStatus = sideTab === 'status';
  $('chatList').classList.toggle('hidden', onStatus);
  $('statusList').classList.toggle('hidden', !onStatus);
  $('btnCreateGroupTab').classList.toggle('hidden', sideTab !== 'groups');
  if (onStatus) loadStatus().catch((e) => toast(e.message));
  else renderChatList();
}

// badge tak terbaca di nav bawah: Chat = total, Grup = khusus grup, Status = titik baru
function updateNavBadges() {
  const setBadge = (el, n) => {
    if (!el) return;
    el.classList.toggle('hidden', !n);
    el.textContent = n > 99 ? '99+' : String(n);
  };
  let all = 0, groups = 0;
  for (const c of S.chats || []) {
    if (!c.unread) continue;
    all += c.unread;
    if (c.type === 'group') groups += c.unread;
  }
  setBadge($('bnChatBadge'), all);
  setBadge($('bnGroupBadge'), groups);
  const dot = $('bnStatusDot');
  if (dot) {
    const hasNew = (S.statusFeed || []).some((g) => !g.isSelf && (g.statuses || []).some((s) => !s.viewed));
    dot.classList.toggle('hidden', !hasNew);
  }
}

/* ================= status wa ================= */
const STATUS_BG = ['#008069', '#1d6fd1', '#7c3aed', '#d5504f', '#c2410c', '#111b21'];
S.statusBg = STATUS_BG[0];
S.statusDraft = { media: null };
initStatusColors();

function fmtStatusTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay) return `Hari ini, ${fmtTime(ts)}`;
  if (y.toDateString() === d.toDateString()) return `Kemarin, ${fmtTime(ts)}`;
  return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}, ${fmtTime(ts)}`;
}

function initStatusColors() {
  const box = $('statusColors');
  box.innerHTML = STATUS_BG.map((c, i) =>
    `<button type="button" class="status-color ${i === 0 ? 'active' : ''}" data-bg="${c}" style="background:${c}" aria-label="Warna ${c}"></button>`
  ).join('');
  box.querySelectorAll('.status-color').forEach((b) => {
    b.addEventListener('click', () => {
      box.querySelectorAll('.status-color').forEach((x) => x.classList.toggle('active', x === b));
      S.statusBg = b.dataset.bg;
      renderStatusPreview();
    });
  });
}

function renderStatusPreview() {
  const box = $('statusPreview');
  const text = $('statusText').value.trim();
  const media = S.statusDraft.media;
  if (media) {
    box.style.background = '#0b141a';
    box.innerHTML = media.type === 'video'
      ? `<video src="${esc(media.url)}" muted playsinline></video>`
      : `<img src="${esc(media.url)}" alt="">`;
  } else {
    box.style.background = S.statusBg;
    box.innerHTML = `<span>${esc(text) || 'Tulis status Anda...'}</span>`;
  }
}

function openStatusComposer() {
  $('statusText').value = '';
  S.statusDraft = { media: null };
  S.statusBg = STATUS_BG[0];
  document.querySelectorAll('.status-color').forEach((x, i) => x.classList.toggle('active', i === 0));
  $('statusMediaNote').classList.add('hidden');
  $('statusError').classList.add('hidden');
  renderStatusPreview();
  openDrawer('statusComposer', false);
  $('statusText').focus();
}

async function loadStatus() {
  const data = await api('/api/status');
  S.statusFeed = data.groups || [];
  renderStatusList();
  updateNavBadges();
}

function renderStatusList() {
  const el = $('statusList');
  const mine = S.statusFeed.find((g) => g.isSelf && g.statuses.length) || null;
  const others = S.statusFeed.filter((g) => !g.isSelf && g.statuses.length);
  let html = `
    <button class="status-create" id="btnCreateStatus">
      <span class="status-create-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-plus" /></svg></span>
      <span class="status-create-text"><strong>Buat status</strong><small>Bagikan momen Anda • hilang 24 jam</small></span>
    </button>`;

  if (mine) {
    const s = mine.statuses[mine.statuses.length - 1];
    const gi = S.statusFeed.indexOf(mine);
    html += statusRowHtml(mine, gi, mine.statuses.length - 1, s, true);
  }
  others.forEach((g) => {
    const gi = S.statusFeed.indexOf(g);
    const unreadIndex = g.statuses.findIndex((s) => !s.viewed);
    const idx = unreadIndex >= 0 ? unreadIndex : 0;
    html += statusRowHtml(g, gi, idx, g.statuses[idx], false, unreadIndex >= 0);
  });

  if (!mine && !others.length) {
    html += `<div class="empty-state">Belum ada status. Jadilah yang pertama!</div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll('.status-item').forEach((row) => {
    setAvatar(row.querySelector('.avatar'), {
      name: row.dataset.name,
      avatar: row.dataset.avatar || null,
    });
    row.addEventListener('click', () => openStory(Number(row.dataset.gi), Number(row.dataset.si)));
  });
  const create = $('btnCreateStatus');
  if (create) create.addEventListener('click', openStatusComposer);
}

function statusRowHtml(group, gi, si, s, isMine, unread) {
  const u = group.user;
  const count = group.statuses.length;
  const sub = isMine
    ? `Status saya • ${count} status${s ? ' • ' + fmtStatusTime(s.createdAt) : ''}`
    : `${unread ? 'Belum dilihat' : fmtStatusTime(s ? s.createdAt : 0)} • ${count} status`;
  return `
  <div class="status-item ${unread ? 'unread' : ''} ${isMine ? 'mine' : ''}" data-gi="${gi}" data-si="${si}"
       data-name="${esc(u.name)}" data-avatar="${esc(u.avatar || '')}">
    <div class="avatar status-avatar"><span>${esc((u.name || '?').charAt(0).toUpperCase())}</span></div>
    <div class="chat-item-body">
      <div class="chat-item-top"><strong>${esc(u.name)}${badge(u.verified)}</strong></div>
      <div class="chat-item-bottom"><div class="chat-item-preview">${esc(sub)}</div></div>
    </div>
    ${isMine ? '<span class="status-add"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-plus" /></svg></span>' : ''}
  </div>`;
}

/* ---- pemontok status ---- */
const story = { groups: [], gi: 0, si: 0, timer: null, started: 0, dur: 5000, video: null };

function openStory(gi, si) {
  const groups = S.statusFeed.filter((g) => g.statuses.length);
  if (!groups.length) { openStatusComposer(); return; }
  story.groups = groups;
  story.gi = Math.max(0, Math.min(gi, groups.length - 1));
  story.si = Math.max(0, si || 0);
  $('storyViewer').classList.remove('hidden');
  showStory();
}

function stopStoryTimer() {
  clearInterval(story.timer);
  story.timer = null;
  if (story.video) {
    try { story.video.pause(); } catch { /* noop */ }
    story.video = null;
  }
}

function closeStory() {
  stopStoryTimer();
  $('storyViewer').classList.add('hidden');
  loadStatus().catch(() => {});
}

function showStory() {
  const g = story.groups[story.gi];
  if (!g) { closeStory(); return; }
  if (story.si >= g.statuses.length) { story.si = 0; story.gi += 1; return showStory(); }
  if (story.gi >= story.groups.length) { closeStory(); return; }

  const s = g.statuses[story.si];
  stopStoryTimer();

  setAvatar($('storyAvatar'), { name: g.user.name, avatar: g.user.avatar });
  $('storyName').textContent = g.user.name + (s.isMine ? ' (Anda)' : '');
  $('storyTime').textContent = fmtStatusTime(s.createdAt);
  $('storyCaption').textContent = s.body || '';
  $('storyCaption').classList.toggle('hidden', !s.body);
  $('btnDeleteStory').classList.toggle('hidden', !s.isMine);
  $('storyViews').classList.toggle('hidden', !s.isMine);
  if (s.isMine) $('storyViews').textContent = `👁 ${s.viewCount} dilihat`;

  $('storyProgress').innerHTML = g.statuses.map((_, i) =>
    `<i class="${i < story.si ? 'done' : i === story.si ? 'active' : ''}"></i>`
  ).join('');

  const stage = $('storyStage');
  stage.className = 'story-stage';
  if (s.type === 'image' && s.mediaUrl) {
    stage.innerHTML = `<img src="${esc(s.mediaUrl)}" alt="">`;
  } else if (s.type === 'video' && s.mediaUrl) {
    stage.innerHTML = `<video src="${esc(s.mediaUrl)}" autoplay playsinline controls></video>`;
  } else {
    stage.classList.add('text');
    stage.style.background = s.bg || '#008069';
    stage.innerHTML = `<p>${esc(s.body || '')}</p>`;
  }

  if (!s.isMine && !s.viewed) {
    s.viewed = true;
    api(`/api/status/${s.id}/view`, { method: 'POST' }).catch(() => {});
    renderStatusList();
  }

  const bar = $('storyProgress').querySelector('.active');
  story.started = Date.now();
  story.dur = s.type === 'text' ? 5000 : 7000;

  const video = stage.querySelector('video');
  if (video) {
    story.video = video;
    video.addEventListener('ended', nextStory, { once: true });
    video.addEventListener('error', nextStory, { once: true });
    return;
  }

  story.timer = setInterval(() => {
    const p = Math.min(1, (Date.now() - story.started) / story.dur);
    if (bar) bar.style.setProperty('--p', `${p * 100}%`);
    if (p >= 1) nextStory();
  }, 80);
}

function nextStory() {
  const g = story.groups[story.gi];
  if (g && story.si + 1 < g.statuses.length) {
    story.si += 1;
    showStory();
    return;
  }
  if (story.gi + 1 < story.groups.length) {
    story.gi += 1;
    story.si = 0;
    showStory();
    return;
  }
  closeStory();
}

function prevStory() {
  if (story.si > 0) {
    story.si -= 1;
    showStory();
    return;
  }
  if (story.gi > 0) {
    story.gi -= 1;
    story.si = (story.groups[story.gi].statuses.length || 1) - 1;
    showStory();
    return;
  }
  showStory();
}

$('btnCloseStory').addEventListener('click', closeStory);
$('storyNext').addEventListener('click', nextStory);
$('storyPrev').addEventListener('click', prevStory);
$('btnDeleteStory').addEventListener('click', async () => {
  const g = story.groups[story.gi];
  const s = g && g.statuses[story.si];
  if (!s) return;
  try {
    await api(`/api/status/${s.id}`, { method: 'DELETE' });
    toast('Status dihapus');
    closeStory();
  } catch (err) { toast(err.message); }
});

$('statusText').addEventListener('input', renderStatusPreview);
$('btnCloseStatus').addEventListener('click', closeDrawers);
$('btnStatusMedia').addEventListener('click', () => $('statusInput').click());

$('statusInput').addEventListener('change', async () => {
  const file = $('statusInput').files[0];
  if (!file) return;
  if (!/^image\//.test(file.type) && !/^video\//.test(file.type)) {
    toast('Status media hanya gambar atau video');
    return;
  }
  const note = $('statusMediaNote');
  note.classList.remove('hidden');
  note.textContent = 'Mengunggah media...';
  try {
    const meta = await uploadFile(file, (p) => { note.textContent = `Mengunggah ${Math.round(p * 100)}%`; });
    S.statusDraft = { media: meta };
    note.textContent = `${meta.type === 'video' ? 'Video' : 'Foto'} siap dibagikan`;
    renderStatusPreview();
  } catch (err) {
    note.textContent = err.message;
  } finally {
    $('statusInput').value = '';
  }
});

$('btnPostStatus').addEventListener('click', async () => {
  const body = $('statusText').value.trim();
  const media = S.statusDraft.media;
  const errBox = $('statusError');
  errBox.classList.add('hidden');
  try {
    let payload;
    if (media) {
      payload = { type: media.type === 'video' ? 'video' : 'image', media: { url: media.url, name: media.name, mime: media.mime }, body };
    } else {
      payload = { type: 'text', body, bg: S.statusBg };
    }
    await api('/api/status', { method: 'POST', body: payload });
    closeDrawers();
    toast('Status dibagikan');
    await loadStatus();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

/* ================= grup ================= */
$('btnNewGroup').addEventListener('click', () => {
  S.groupDraft = { name: '', members: [] };
  $('groupName').value = '';
  $('groupSearch').value = '';
  $('groupChips').innerHTML = '';
  $('groupResults').innerHTML = '<div class="empty-state">Ketik nama atau email teman untuk menambahkan anggota.</div>';
  openDrawer('groupDrawer', false);
  $('groupName').focus();
});
$('btnCloseGroup').addEventListener('click', closeDrawers);

let groupSearchTimer;
$('groupSearch').addEventListener('input', () => {
  clearTimeout(groupSearchTimer);
  groupSearchTimer = setTimeout(searchGroupMembers, 300);
});

async function searchGroupMembers() {
  const q = $('groupSearch').value.trim();
  const box = $('groupResults');
  if (!q) {
    box.innerHTML = '<div class="empty-state">Ketik nama atau email teman untuk menambahkan anggota.</div>';
    return;
  }
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    const users = (data.users || []).filter((u) => !S.groupDraft.members.some((m) => m.id === u.id));
    if (!users.length) { box.innerHTML = '<div class="empty-state">Tidak ada hasil.</div>'; return; }
    box.innerHTML = users.map((u) => `
      <div class="chat-item" data-add="${u.id}">
        <div class="avatar"></div>
        <div class="chat-item-body">
          <div class="chat-item-top"><strong>${esc(u.name)}${badge(u.verified)}</strong></div>
          <div class="chat-item-bottom"><div class="chat-item-preview">${esc(u.email || "Email disembunyikan")}</div></div>
        </div>
        <span class="mi-arrow"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-plus" /></svg></span>
      </div>`).join('');
    users.forEach((u) => setAvatar(box.querySelector(`[data-add="${u.id}"] .avatar`), u));
    box.querySelectorAll('[data-add]').forEach((el) => {
      el.addEventListener('click', () => {
        const u = users.find((x) => x.id === el.dataset.add);
        if (!u) return;
        if (!S.groupDraft.members.some((m) => m.id === u.id)) S.groupDraft.members.push(u);
        renderGroupChips();
        searchGroupMembers();
      });
    });
  } catch (err) { toast(err.message); }
}

function renderGroupChips() {
  const box = $('groupChips');
  box.innerHTML = S.groupDraft.members.map((m) => `
    <span class="group-chip" data-chip="${esc(m.id)}">${esc(m.name)} <i data-remove="${esc(m.id)}"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-close" /></svg></i></span>
  `).join('');
  box.querySelectorAll('[data-remove]').forEach((x) => {
    x.addEventListener('click', () => {
      S.groupDraft.members = S.groupDraft.members.filter((m) => m.id !== x.dataset.remove);
      renderGroupChips();
      searchGroupMembers();
    });
  });
}

$('btnCreateGroup').addEventListener('click', async () => {
  const name = $('groupName').value.trim();
  if (name.length < 3) { toast('Nama grup minimal 3 karakter'); return; }
  if (!S.groupDraft.members.length) { toast('Pilih minimal satu anggota lain'); return; }
  try {
    const data = await api('/api/chats/group', {
      method: 'POST',
      body: { name, memberIds: S.groupDraft.members.map((m) => m.id) },
    });
    closeDrawers();
    await loadChats();
    toast('Grup dibuat');
    openChat(data.chat.id);
  } catch (err) { toast(err.message); }
});

async function openGroupInfo() {
  const chat = currentChat();
  if (!chat || chat.type !== 'group') return;
  openDrawer('groupInfoDrawer');
  const body = $('groupInfoBody');
  body.innerHTML = '<div class="empty-state">Memuat info grup...</div>';
  try {
    const data = await api(`/api/chats/${chat.id}/members`);
    const members = data.members || [];
    const isAdmin = chat.role === 'admin';
    body.innerHTML = `
      <div class="group-hero">
        <div class="gi-avatar-wrap">
          <div class="avatar avatar-xl ring">${chat.avatar ? `<img src="${esc(chat.avatar)}" alt="">` : `<span>${esc((chat.name || 'G').charAt(0).toUpperCase())}</span>`}</div>
          ${isAdmin ? `<button class="avatar-edit" id="giAvatarBtn" type="button" title="Ganti foto grup"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-image" /></svg></button>` : ''}
        </div>
        <input type="file" id="giAvatarInput" accept="image/*" class="hidden" />
        <h3>${esc(chat.name)}${badge(false)}</h3>
        <p class="group-sub">${members.length} anggota • Dibuat oleh ${esc((members.find((m) => m.role === 'admin') || {}).name || 'admin')}</p>
      </div>
      ${isAdmin ? `
        <div class="profile-section">
          <span class="ps-label">Nama grup (admin)</span>
          <input type="text" id="giName" maxlength="60" value="${esc(chat.name || '')}" />
          <button class="btn-ghost" id="giSaveName">Simpan nama</button>
        </div>
        <div class="profile-section">
          <span class="ps-label">Tambah anggota</span>
          <div class="search-wrap"><input type="search" id="giSearch" placeholder="Cari nama / email..." /></div>
          <div class="chat-list" id="giResults"></div>
        </div>` : ''}
      <div class="ps-label" style="padding:0 4px 8px">Anggota</div>
      <div class="member-list" id="giMembers"></div>
      <button class="btn-ghost danger" id="giLeave"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-exit" /></svg> Keluar dari grup</button>`;

    const list = body.querySelector('#giMembers');
    list.innerHTML = members.map((m) => `
      <div class="member-item">
        <div class="avatar"><span>${esc((m.name || '?').charAt(0).toUpperCase())}</span></div>
        <div class="member-meta">
          <strong>${esc(m.name)}${m.id === S.me.id ? ' (Anda)' : ''}</strong>
          <small>${esc(m.email)}${m.online ? ' • online' : ''}</small>
        </div>
        ${m.role === 'admin' ? '<span class="role-badge">Admin</span>' : ''}
      </div>`).join('');
    list.querySelectorAll('.avatar').forEach((av, i) => setAvatar(av, members[i]));

    if (isAdmin) {
      const avBtn = body.querySelector('#giAvatarBtn');
      const avInput = body.querySelector('#giAvatarInput');
      if (avBtn && avInput) {
        avBtn.addEventListener('click', () => avInput.click());
        avInput.addEventListener('change', async () => {
          const file = avInput.files && avInput.files[0];
          if (!file) return;
          if (!file.type.startsWith('image/')) { toast('Pilih file gambar (JPG/PNG/WEBP)'); return; }
          if (file.size > 50 * 1024 * 1024) { toast('Ukuran maksimal 50MB'); return; }
          try {
            toast('Mengunggah foto grup...');
            const meta = await uploadFile(file);
            await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { avatar: meta.url } });
            await loadChats();
            const updated = S.chats.find((c) => c.id === chat.id);
            if (updated && S.activeChatId === updated.id) {
              setAvatar($('chatAvatar'), { name: updated.name, avatar: updated.avatar });
            }
            toast('Foto grup diperbarui ✓');
            openGroupInfo();
          } catch (err) { toast(err.message); }
        });
      }

      body.querySelector('#giSaveName').addEventListener('click', async () => {
        const name = body.querySelector('#giName').value.trim();
        if (name.length < 3) { toast('Nama grup minimal 3 karakter'); return; }
        try {
          await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { name } });
          await loadChats();
          $('chatName').innerHTML = esc(name);
          toast('Nama grup diperbarui');
          openGroupInfo();
        } catch (err) { toast(err.message); }
      });

      const searchBox = body.querySelector('#giResults');
      const searchInput = body.querySelector('#giSearch');
      let t;
      searchInput.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = searchInput.value.trim();
          if (!q) { searchBox.innerHTML = ''; return; }
          try {
            const res = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
            const users = (res.users || []).filter((u) => !members.some((m) => m.id === u.id));
            searchBox.innerHTML = users.map((u) => `
              <div class="chat-item" data-gadd="${esc(u.id)}">
                <div class="avatar"></div>
                <div class="chat-item-body">
                  <div class="chat-item-top"><strong>${esc(u.name)}</strong></div>
                  <div class="chat-item-bottom"><div class="chat-item-preview">${esc(u.email || "Email disembunyikan")}</div></div>
                </div>
                <span class="mi-arrow"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-plus" /></svg></span>
              </div>`).join('');
            users.forEach((u) => setAvatar(searchBox.querySelector(`[data-gadd="${u.id}"] .avatar`), u));
            searchBox.querySelectorAll('[data-gadd]').forEach((el) => {
              el.addEventListener('click', async () => {
                try {
                  await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: { userId: el.dataset.gadd } });
                  await loadChats();
                  toast('Anggota ditambahkan');
                  openGroupInfo();
                } catch (err2) { toast(err2.message); }
              });
            });
          } catch (err) { toast(err.message); }
        }, 300);
      });
    }

    body.querySelector('#giLeave').addEventListener('click', async () => {
      try {
        await api(`/api/chats/${chat.id}/leave`, { method: 'POST' });
        closeDrawers();
        if (S.activeChatId === chat.id) {
          S.activeChatId = null;
          $('chatActive').classList.add('hidden');
          $('chatEmpty').classList.remove('hidden');
        }
        await loadChats();
        toast('Anda keluar dari grup');
      } catch (err) { toast(err.message); }
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function openChatInfo() {
  const chat = currentChat();
  if (chat && chat.type === 'group') openGroupInfo();
  else openContactInfo();
}

/* ================= pesan suara (voice note) ================= */
let rec = null;

function setRecording(on) {
  $('recBar').classList.toggle('hidden', !on);
  $('messageInput').classList.toggle('hidden', on);
  $('btnAttach').classList.toggle('hidden', on);
  if (on) {
    $('btnSend').classList.add('hidden');
    $('btnMic').classList.add('hidden');
  } else {
    updateComposerButtons();
  }
}

async function startRecording() {
  if (!S.activeChatId) { toast('Buka chat dulu untuk merekam'); return; }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    toast('Browser ini tidak mendukung perekaman suara');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
    rec = { recorder, chunks, stream, startedAt: Date.now(), timer: null, done: false };
    rec.timer = setInterval(() => {
      $('recTime').textContent = fmtDur((Date.now() - rec.startedAt) / 1000);
    }, 200);
    setRecording(true);
    beep('notif');
  } catch (err) {
    toast('Mikrofon tidak bisa diakses: ' + (err.message || 'izin ditolak'));
  }
}

function stopRecording(send) {
  if (!rec || rec.done) return;
  rec.done = true;
  const current = rec;
  clearInterval(current.timer);
  const finish = async () => {
    try { current.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    rec = null;
    $('recTime').textContent = '0:00';
    setRecording(false);
    if (!send) return;
    const duration = Date.now() - current.startedAt;
    if (duration < 700) { toast('Rekaman terlalu pendek'); return; }
    const type = current.recorder.mimeType || 'audio/webm';
    const blob = new Blob(current.chunks, { type });
    if (!blob.size) { toast('Rekaman kosong'); return; }
    const file = new File([blob], `pesan-suara-${Date.now()}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type });
    await uploadAndSend(file, '', S.activeChatId, { duration });
  };
  current.recorder.onstop = () => { void finish(); };
  try { current.recorder.stop(); } catch { void finish(); }
}

$('btnMic').addEventListener('click', startRecording);
$('btnRecCancel').addEventListener('click', () => stopRecording(false));
$('btnRecSend').addEventListener('click', () => stopRecording(true));

/* ================= init ================= */
(async function init() {
  void loadHomeBg();
  void registerSW();
  const deepChat = new URLSearchParams(location.search).get('chat');
  if (S.token) {
    try {
      const data = await api('/api/auth/me');
      S.me = data.user;
      await startApp();
      if (deepChat) {
        try { await openChat(deepChat); } catch { /* chat tidak bisa dibuka */ }
        history.replaceState(null, '', location.pathname);
      }
      return;
    } catch { /* token invalid */ }
  }
  showAuth();
})();
