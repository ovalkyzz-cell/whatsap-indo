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
  more: {},         // chatId -> masih ada pesan lebih lama di server
};

/* status render panel pesan — dipakai untuk render inkrementen & scroll */
const UI = {
  chatId: null,        // chat yang sedang dirender
  hasMore: true,       // masih ada riwayat sebelumnya di server
  loadingOlder: false,
  nearBottom: true,    // posisi scroll dekat bagian bawah
  newWhileUp: 0,       // pesan baru masuk ketika sedang membaca ke atas
  raf: 0,              // frame pending untuk listener scroll
  chatsRaf: 0,         // frame pending untuk render daftar chat
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
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
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
    const body = { name: f.get('name'), email: f.get('email'), password: f.get('password') };
    const ref = String(f.get('ref') || '').trim();
    if (ref) body.ref = ref;
    const data = await api('/api/auth/register', { method: 'POST', body });
    if (data.pending) {
      // akun baru harus disetujui admin sebelum bisa masuk
      e.target.reset();
      showAuth(data.message || 'Pendaftaran menunggu persetujuan admin.');
      return;
    }
    await bootSession(data);
    if (data.refApplied) toast('Kode undangan diterapkan — selamat datang! 🎁');
  } catch (err) { showAuth(err.message); }
});

// kode undangan dari link ?ref=WA-MAZ-VAL-XXXX langsung terisi di form daftar
(function prefillRef() {
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref) {
      const input = $('refInput');
      if (input) input.value = ref.trim().toUpperCase();
      document.querySelector('.auth-tab[data-tab="register"]')?.click();
    }
  } catch { /* query tidak valid */ }
})();

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

const PLAN_LABELS = { harian: 'Harian', mingguan: 'Mingguan', bulanan: 'Bulanan', permanen: 'Permanen', 'lima-hari': '5 Hari' };

function planLabel(id) {
  if (!id) return null;
  return PLAN_LABELS[id] || String(id).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function setAvatar(el, user) {
  if (!user) return;
  const letter = esc((user.name || '?').charAt(0).toUpperCase());
  const paintDot = () => {
    el.querySelectorAll('.online-dot').forEach((d) => d.remove());
    if (user.online) {
      const dot = document.createElement('i');
      dot.className = 'online-dot';
      el.appendChild(dot);
    }
  };
  const paintLetter = () => { el.innerHTML = `<span>${letter}</span>`; paintDot(); };
  el.querySelectorAll('.online-dot').forEach((d) => d.remove());
  if (!user.avatar) { paintLetter(); return; }
  el.innerHTML = '';
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', paintLetter, { once: true });
  el.appendChild(img);
  paintDot();
  img.src = user.avatar;
  if (img.complete && img.naturalWidth === 0) paintLetter();
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

// render daftar chat dikoordinasi per frame supaya tidak menumpuk
// saat banyak event presence/pesan masuk bersamaan (scroll tetap mulus)
function renderChatList() {
  if (UI.chatsRaf) return;
  UI.chatsRaf = requestAnimationFrame(() => {
    UI.chatsRaf = 0;
    renderChatListNow();
  });
}

function renderChatListNow() {
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
    S.more[chatId] = !!data.hasMore;
  }
  UI.hasMore = S.more[chatId] !== false;
  UI.loadingOlder = false;
  renderMessages();
  markRead(chatId);
  ncMarkChatRead(chatId);
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

/* ================= body pesan: blok kode ala VS Code ================= */
const NUM_LANGS = ['angka', 'number', 'num', 'token', 'kode', 'code-num', 'am'];

function splitFences(text) {
  const parts = [];
  let idx = 0;
  for (;;) {
    const open = text.indexOf('```', idx);
    if (open === -1) { parts.push({ text: text.slice(idx) }); break; }
    if (open > idx) parts.push({ text: text.slice(idx, open) });
    const nl = text.indexOf('\n', open + 3);
    if (nl === -1) { parts.push({ lang: '', code: text.slice(open + 3) }); break; }
    const head = text.slice(open + 3, nl);
    let lang = '';
    let bodyStart = nl + 1;
    if (/^[\w+.#-]{0,20}$/.test(head)) lang = head;
    else bodyStart = open + 3;
    const close = text.indexOf('```', bodyStart);
    if (close === -1) { parts.push({ lang, code: text.slice(bodyStart) }); break; }
    parts.push({ lang, code: text.slice(bodyStart, close) });
    idx = close + 3;
  }
  return parts;
}

// tokenisasi kode mentah lalu di-escape per potongan -> tidak ada HTML liar
function highlightCode(code, lang) {
  const l = String(lang || '').toLowerCase();
  const hashLangs = ['py', 'python', 'sh', 'bash', 'zsh', 'rb', 'ruby', 'yml', 'yaml', 'toml', 'perl', 'r', 'ps1'];
  const slashLangs = ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
    'cs', 'go', 'rust', 'rs', 'swift', 'kt', 'kotlin', 'php', 'dart', 'scala', 'lua', 'css', 'scss', 'less',
    'sql', 'r', 'groovy'];
  const plain = ['text', 'txt', 'plaintext', ''];
  if (plain.includes(l)) return esc(code);

  const alts = [];
  if (slashLangs.includes(l)) alts.push('\\/\\/[^\\n]*', '\\/\\*[\\s\\S]*?\\*\\/');
  if (hashLangs.includes(l)) alts.push('#[^\\n]*');
  alts.push('"(?:[^"\\\\\\n]|\\\\.)*"', "'(?:[^'\\\\\\n]|\\\\.)*'", '`(?:[^`\\\\]|\\\\.)*`', '\\b\\d[\\w.]*\\b',
    '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|import|export|default|from|as|def|elif|lambda|None|True|False|null|undefined|true|false|void|public|private|protected|static|int|float|double|char|string|bool|boolean|package|func|struct|interface|enum|require|module|print|echo|end|then|fi|self|not|and|or|with|pass|yield|global|nonlocal|is|public)\\b');

  let re;
  try { re = new RegExp(alts.join('|'), 'g'); } catch { return esc(code); }

  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    const tok = m[0];
    const cls = (tok.startsWith('//') || tok.startsWith('/*') || (tok.startsWith('#') && hashLangs.includes(l)))
      ? 'com'
      : (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`'))
        ? 'str'
        : (/^\d/.test(tok) ? 'num' : 'kw');
    out += `<span class="hl-${cls}">${esc(tok)}</span>`;
    last = m.index + tok.length;
  }
  out += esc(code.slice(last));
  return out;
}

function inlineMsgHtml(text) {
  if (!text) return '';
  let h = esc(text).replace(/`([^`\n]+)`/g, '<code class="mi">$1</code>');
  h = h.split(/(<[^>]+>)/g).map((seg) => {
    if (seg.startsWith('<')) return seg;
    return seg.replace(/https?:\/\/[^\s<>"']+/g, (m) => {
      const clean = m.replace(/[.,;:!?)\]}]+$/, '');
      const trail = m.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${trail}`;
    });
  }).join('');
  return `<div class="msg-text">${h}</div>`;
}

const COPY_ICO = '<svg viewBox="0 0 24 24" class="ico"><use href="#ic-copy"></use></svg>';

function codeBlockHtml(lang, raw) {
  const l = String(lang || '').toLowerCase();
  let code = String(raw === undefined || raw === null ? '' : raw).replace(/\s+$/, '');
  if (l === 'json') { try { code = JSON.stringify(JSON.parse(code), null, 2); } catch { /* JSON tidak valid */ } }

  if (NUM_LANGS.includes(l)) {
    return `<div class="numcard">
      <div class="numcard-head">
        <span class="cb-label">KODE SPESIAL</span>
        <button type="button" class="cb-copy" data-copy title="Salin"><span class="cb-ico">${COPY_ICO}</span><span class="cb-copy-text">Copy</span></button>
      </div>
      <pre class="numcard-body"><code>${esc(code)}</code></pre>
    </div>`;
  }

  const lines = code.split('\n');
  const gutter = lines.map((_, i) => i + 1).join('\n');
  const label = l || 'teks';
  return `<div class="code-block">
    <div class="cb-head">
      <span class="cb-dots"><i></i><i></i><i></i></span>
      <span class="cb-label">${esc(label)}</span>
      <button type="button" class="cb-copy" data-copy title="Salin kode"><span class="cb-ico">${COPY_ICO}</span><span class="cb-copy-text">Copy</span></button>
    </div>
    <div class="cb-body">
      <pre class="cb-gutter" aria-hidden="true">${gutter}</pre>
      <div class="cb-scroll"><pre class="cb-code"><code>${highlightCode(code, l)}</code></pre></div>
    </div>
  </div>`;
}

function renderMsgBody(raw) {
  const parts = splitFences(String(raw || ''));
  let html = '';
  parts.forEach((p, i) => {
    if (p.code !== undefined) {
      html += codeBlockHtml(p.lang, p.code);
      return;
    }
    let t = p.text;
    if (parts.length > 1) {
      const prevBlock = i > 0 && parts[i - 1].code !== undefined;
      const nextIsBlock = i + 1 < parts.length && parts[i + 1].code !== undefined;
      if (prevBlock) t = t.replace(/^\n+/, '');
      if (nextIsBlock) t = t.replace(/\n+$/, '');
    }
    html += inlineMsgHtml(t);
  });
  return html;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* lanjut ke fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ================= messages render ================= */
/* Render inkrementen: hanya node yang berubah yang disentuh sehingga
   scroll ke atas/bawah tetap lancar tanpa jeda (tanpa rebuild penuh). */
function cssSel(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}

function msgNode(id) {
  return $('messages').querySelector(`[data-msg="${cssSel(id)}"]`);
}

function typingHtml() {
  return '<div class="typing-indicator" id="typingIndicator"><span></span><span></span><span></span></div>';
}

function messagesInnerHtml(msgs, chat) {
  let html = '';
  let lastDay = '';
  for (const m of msgs) {
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) { html += `<div class="day-divider">${esc(day)}</div>`; lastDay = day; }
    html += messageHtml(m, chat);
  }
  if (S.typing[chat.id] && Object.keys(S.typing[chat.id]).length) html += typingHtml();
  return html;
}

function renderMessages() {
  const chat = currentChat();
  if (!chat) return;
  const box = $('messages');
  const msgs = S.messages[chat.id] || [];
  const switching = UI.chatId !== chat.id;
  const prevTop = box.scrollTop;
  const prevHeight = box.scrollHeight;
  if (!msgs.length) {
    box.innerHTML = `<div class="empty-state">Belum ada pesan. Sapa ${esc(chatTitle(chat))} sekarang 👋</div>`;
    UI.chatId = chat.id;
    UI.nearBottom = true;
    UI.newWhileUp = 0;
    syncScrollFab();
    return;
  }
  box.innerHTML = messagesInnerHtml(msgs, chat);
  UI.chatId = chat.id;
  if (switching) {
    UI.nearBottom = true;
    UI.newWhileUp = 0;
    box.scrollTop = box.scrollHeight;
  } else {
    // pertahankan posisi baca (juga mengunci saat riwayat lama ditambahkan di atas)
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  }
  syncScrollFab();
}

// tambahkan tepat satu pesan ke panel tanpa merender ulang seluruh daftar
function appendMessage(m, { animate = true } = {}) {
  const chat = currentChat();
  const box = $('messages');
  if (!chat || !box || UI.chatId !== chat.id || m.chatId !== chat.id) return false;
  if (msgNode(m.id)) return patchMessage(m);
  const empty = box.querySelector('.empty-state');
  if (empty) empty.remove();
  let html = '';
  const lastDivider = box.querySelector('.day-divider:last-of-type');
  const day = fmtDay(m.createdAt);
  if (!lastDivider || lastDivider.textContent !== day) html += `<div class="day-divider">${esc(day)}</div>`;
  html += messageHtml(m, chat, { enter: animate });
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const frag = document.createDocumentFragment();
  while (wrap.firstElementChild) frag.appendChild(wrap.firstElementChild);
  box.insertBefore(frag, $('typingIndicator'));
  return true;
}

// perbarui satu node pesan (centang, hapus, sekali lihat) tanpa rebuild penuh
function patchMessage(m) {
  const chat = currentChat();
  const node = msgNode(m.id);
  if (!chat || !node) return false;
  const wrap = document.createElement('div');
  wrap.innerHTML = messageHtml(m, chat);
  const fresh = wrap.firstElementChild;
  if (!fresh) return false;
  node.replaceWith(fresh);
  return true;
}

// gabungkan pesan (balasan server / pesan optimis) ke panel aktif
function upsertMessage(m) {
  if (UI.chatId !== m.chatId) return false;
  if (msgNode(m.id)) return patchMessage(m);
  return appendMessage(m);
}

function removeMessageNode(id) {
  const node = msgNode(id);
  if (!node) return;
  const prev = node.previousElementSibling;
  node.remove();
  // buang pemisah hari yang kini menggantung
  if (prev && prev.classList.contains('day-divider')) {
    const next = prev.nextElementSibling;
    if (!next || next.classList.contains('day-divider')) prev.remove();
  }
  const box = $('messages');
  const chat = currentChat();
  if (box && chat && UI.chatId === chat.id && !box.querySelector('.msg')) {
    renderMessages(); // kembalikan layar kosong
  }
}

function removeLocalMessage(chatId, localId) {
  const arr = S.messages[chatId];
  if (arr) {
    const i = arr.findIndex((x) => x.id === localId);
    if (i >= 0) arr.splice(i, 1);
  }
  removeMessageNode(localId);
}

// buang bubble optimis milik pengirim ketika pesan asli dari server tiba
function dropMatchingLocal(m) {
  const arr = S.messages[m.chatId] || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const x = arr[i];
    if (x.id.startsWith('local-') && x.type === m.type && (x.body || '') === (m.body || '')) {
      arr.splice(i, 1);
      removeMessageNode(x.id);
      return;
    }
  }
}

function messageHtml(m, chat, opts = {}) {
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
    if (m.body) inner += renderMsgBody(m.body);
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
    if (m.body) inner += renderMsgBody(m.body);
  }

  const ticks = out && !m.deleted ? tickHtml(m.status) : '';
  let progress = '';
  if (m.status === 'sending') {
    progress = `<div class="uploading-label">Mengunggah ${m._progress || 0}% • ${esc(fmtSize(m.mediaSize))}</div>
      <div class="uploading-bar"><i style="width:${m._progress || 0}%"></i></div>`;
  }
  const hasBlock = !!m.body && m.body.includes('```');
  return `
  <div class="msg ${out ? 'out' : 'in'}${hasBlock ? ' has-block' : ''}${opts.enter ? ' enter' : ''}" data-msg="${m.id}">
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

/* ---------- aksi pesan: satu listener delegasi (ringan & cepat) ---------- */
function bindMessageActions() {
  $('messages').addEventListener('click', onMessagesClick);
}

async function onMessagesClick(e) {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const wrap = copyBtn.closest('.code-block, .numcard');
    const codeEl = wrap && wrap.querySelector('code');
    if (!codeEl) return;
    const ok = await copyToClipboard(codeEl.innerText);
    if (!ok) { toast('Gagal menyalin — coba klik kanan lalu Salin'); return; }
    copyBtn.classList.add('copied');
    const label = copyBtn.querySelector('.cb-copy-text');
    if (label) label.textContent = 'Copied';
    toast('Disalin ke papan klip');
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      if (label) label.textContent = 'Copy';
    }, 1600);
    return;
  }
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    try { await api(`/api/messages/${delBtn.dataset.del}`, { method: 'DELETE' }); }
    catch (err) { toast(err.message); }
    return;
  }
  const voBtn = e.target.closest('[data-vo]');
  if (voBtn) { openViewOnce(voBtn.dataset.vo); return; }
  const playBtn = e.target.closest('.ap-play');
  if (playBtn) toggleAudioPlayer(playBtn.closest('.audio-player'));
}

/* ---------- scroll: lancar, tanpa lompat ---------- */
function scrollToBottom(smooth) {
  const box = $('messages');
  if (!box) return;
  if (smooth) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  else box.scrollTop = box.scrollHeight;
}

function updateNearBottom() {
  const box = $('messages');
  if (!box) return;
  const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
  UI.nearBottom = gap < 140;
  if (UI.nearBottom) UI.newWhileUp = 0;
  syncScrollFab();
}

function syncScrollFab() {
  const btn = $('btnScrollDown');
  if (!btn) return;
  btn.classList.toggle('hidden', UI.nearBottom && !UI.newWhileUp);
  const b = $('sdBadge');
  if (b) {
    b.classList.toggle('hidden', !UI.newWhileUp);
    b.textContent = UI.newWhileUp > 99 ? '99+' : String(UI.newWhileUp);
  }
}

function showOlderLoading(on) {
  const el = $('olderLoading');
  if (el) el.classList.toggle('hidden', !on);
}

// muat riwayat lebih lama saat mendekati bagian atas (infinite scroll)
async function loadOlderMessages() {
  const chat = currentChat();
  if (!chat || UI.loadingOlder || !UI.hasMore) return;
  const msgs = S.messages[chat.id] || [];
  const first = msgs[0];
  if (!first) { UI.hasMore = false; return; }
  UI.loadingOlder = true;
  showOlderLoading(true);
  try {
    const data = await api(`/api/chats/${chat.id}/messages?limit=50&before=${first.createdAt}`);
    const older = (data.messages || []).filter((m) => !msgs.some((x) => x.id === m.id));
    S.more[chat.id] = !!data.hasMore && older.length > 0;
    UI.hasMore = S.more[chat.id];
    if (older.length && UI.chatId === chat.id) {
      S.messages[chat.id] = older.concat(msgs);
      renderMessages(); // posisi baca dikunci otomatis oleh renderMessages
    }
  } catch { /* biarkan; bisa dicoba lagi */ }
  finally {
    UI.loadingOlder = false;
    showOlderLoading(false);
  }
}

// indikator "sedang mengetik" ditambah/dihapus tanpa merender ulang daftar
function syncTypingIndicator() {
  const chat = currentChat();
  const box = $('messages');
  if (!chat || !box || UI.chatId !== chat.id) return;
  const on = !!(S.typing[chat.id] && Object.keys(S.typing[chat.id]).length);
  let el = $('typingIndicator');
  if (on && !el) {
    const wrap = document.createElement('div');
    wrap.innerHTML = typingHtml();
    el = wrap.firstElementChild;
    box.appendChild(el);
    if (UI.nearBottom) scrollToBottom(false);
  } else if (!on && el) {
    el.remove();
  }
}

function bindMessagesScroll() {
  const box = $('messages');
  box.addEventListener('scroll', () => {
    if (UI.raf) return;
    UI.raf = requestAnimationFrame(() => {
      UI.raf = 0;
      updateNearBottom();
      if (box.scrollTop < 60) void loadOlderMessages();
    });
  }, { passive: true });

  $('btnScrollDown').addEventListener('click', () => {
    UI.newWhileUp = 0;
    UI.nearBottom = true;
    scrollToBottom(true);
    syncScrollFab();
  });
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

function toggleAudioPlayer(wrap) {
  if (!wrap) return;
  if (apWrap === wrap) { stopAudio(); return; }
  stopAudio();
  const btn = wrap.querySelector('.ap-play');
  if (!btn) return;
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
    patchMessage(m);
  };
  img.onerror = () => {
    m.opened = true;
    patchMessage(m);
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
    const known = arr.some((x) => x.id === m.id);
    if (!known) {
      dropMatchingLocal(m); // buang bubble optimis milik pengirim
      arr.push(m);
    } else {
      arr[arr.findIndex((x) => x.id === m.id)] = m;
    }

    const chat = S.chats.find((c) => c.id === m.chatId);
    if (chat) {
      chat.lastMessage = m;
      if (m.senderId !== S.me.id && S.activeChatId !== m.chatId) chat.unread = (chat.unread || 0) + 1;
      S.chats.sort((a, b) => (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
    }
    renderChatList();
    if (S.activeChatId === m.chatId) {
      appendMessage(m); // hanya node baru yang ditambahkan — scroll tidak lompat
      if (m.senderId === S.me.id || UI.nearBottom) {
        UI.newWhileUp = 0;
        scrollToBottom(false); // instan: terasa cepat tanpa jeda
      } else {
        UI.newWhileUp++;
      }
      syncScrollFab();
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
    if (m) { m.status = status; patchMessage(m); renderChatList(); }
  });

  socket.on('message:deleted', (m) => {
    const arr = S.messages[m.chatId];
    if (!arr) return;
    const i = arr.findIndex((x) => x.id === m.id);
    if (i >= 0) { arr[i] = m; patchMessage(m); }
    const chat = S.chats.find((c) => c.id === m.chatId);
    if (chat && chat.lastMessage?.id === m.id) { chat.lastMessage = m; renderChatList(); }
  });

  socket.on('message:viewed', ({ messageId, chatId }) => {
    const arr = S.messages[chatId];
    if (!arr) return;
    const m = arr.find((x) => x.id === messageId);
    if (m) { m.opened = true; patchMessage(m); }
  });

  socket.on('status:new', ({ userId } = {}) => {
    if (sideTab === 'status') loadStatus().catch(() => {});
    if (userId && userId !== S.me?.id) {
      const chat = S.chats.find((c) => c.type !== 'group' && c.peer?.id === userId);
      ncAdd({
        kind: 'status',
        title: 'Status baru',
        body: `${chat ? chatTitle(chat) : 'Kontak Anda'} membagikan status baru`,
        chatId: chat ? chat.id : null,
        at: Date.now(),
      });
    }
  });

  // premium / peran admin berubah (diberikan lewat panel admin)
  socket.on('profile:updated', async () => {
    try {
      const wasVerified = !!(S.me && S.me.verified);
      const wasPremium = !!(S.me && S.me.premiumUntil > Date.now());
      const data = await api('/api/auth/me');
      S.me = data.user;
      const isPremium = !!(S.me.premiumUntil > Date.now());
      if (!wasVerified && S.me.verified) {
        ncAdd({ kind: 'system', title: 'Akun terverifikasi ✓', body: 'Centang biru resmi kini aktif di profil Anda.', at: Date.now() });
      } else if (!wasPremium && isPremium) {
        ncAdd({ kind: 'system', title: 'Paket premium aktif', body: 'Masa aktif premium Anda telah dimulai. Selamat menikmati!', at: Date.now() });
      }
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
      S.typing[chatId][userId] = setTimeout(() => { delete S.typing[chatId][userId]; updateChatStatus(); syncTypingIndicator(); }, 3000);
    } else {
      clearTimeout(S.typing[chatId][userId]);
      delete S.typing[chatId][userId];
    }
    if (S.activeChatId === chatId) { updateChatStatus(); syncTypingIndicator(); }
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
  const reading = visible && S.activeChatId === m.chatId && document.hasFocus();
  // riwayat pusat notifikasi selalu dicatat; yang sedang dibaca langsung ditandai
  ncAdd({ kind: 'message', title: payload.title, body: payload.body, chatId: payload.chatId, messageId: payload.messageId, icon: payload.icon, at: m.createdAt || Date.now(), read: reading });
  if (!visible) {
    if (NOTIF.sound) notifSound();
    void showSystemNotif(payload);
    return;
  }
  if (reading) { if (NOTIF.sound) beep('notif'); return; }
  showNotifCard(payload);
}

// notifikasi push dari service worker (aplikasi tertutup / tab tersembunyi)
function notifyFromPush(data) {
  if (!data || !data.chatId) return;
  if (data.messageId && seenRecently(data.messageId)) return;
  ncAdd({ kind: 'message', title: data.title, body: data.body, chatId: data.chatId, messageId: data.messageId, icon: data.icon, at: Date.now() });
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

/* ================= pusat notifikasi (riwayat in-app) ================= */
const NC = { key: 'wa_notif_center_v1', items: [], max: 60 };

function ncLoad() {
  try {
    const raw = localStorage.getItem(NC.key);
    NC.items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(NC.items)) NC.items = [];
  } catch { NC.items = []; }
}

function ncSave() {
  try { localStorage.setItem(NC.key, JSON.stringify(NC.items.slice(0, NC.max))); }
  catch { /* storage penuh / diblokir */ }
}

function ncUnread() {
  return NC.items.filter((i) => !i.read).length;
}

function ncAdd(item) {
  if (!item) return;
  const entry = {
    id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    kind: item.kind || 'message',
    title: String(item.title || 'Notifikasi').slice(0, 90),
    body: String(item.body || '').slice(0, 200),
    chatId: item.chatId || null,
    messageId: item.messageId || null,
    icon: item.icon || null,
    at: item.at || Date.now(),
    read: !!item.read,
  };
  if (entry.messageId && NC.items.some((i) => i.messageId === entry.messageId)) return;
  NC.items.unshift(entry);
  if (NC.items.length > NC.max) NC.items.length = NC.max;
  ncSave();
  ncRenderBell();
  if (!$('notifDrawer').classList.contains('hidden')) ncRenderList();
  ringBell();
}

function ringBell() {
  const b = $('btnNotifCenter');
  if (!b) return;
  b.classList.remove('ring');
  void b.offsetWidth; // paksa-ulang animasi lonceng
  b.classList.add('ring');
}

function ncRenderBell() {
  const el = $('bellBadge');
  if (!el) return;
  const n = ncUnread();
  el.classList.toggle('hidden', !n);
  el.textContent = n > 99 ? '99+' : String(n);
}

function ncItemHtml(i) {
  const face = i.icon
    ? `<img src="${esc(i.icon)}" alt="">`
    : `<span>${esc(i.kind === 'status' ? '◉' : i.kind === 'system' ? '★' : (i.title || '?').charAt(0).toUpperCase())}</span>`;
  return `
  <button type="button" class="nc-item${i.read ? '' : ' unread'}" data-nc="${esc(i.id)}">
    <span class="nc-ico avatar">${face}</span>
    <span class="nc-txt"><strong>${esc(i.title)}</strong><small>${esc(i.body || '')}</small></span>
    <time>${esc(fmtListTime(i.at))}</time>
  </button>`;
}

function ncRenderList() {
  const body = $('notifCenterBody');
  if (!body) return;
  if (!NC.items.length) {
    body.innerHTML = '<div class="empty-state">Belum ada notifikasi.</div>';
    return;
  }
  let html = '';
  let lastDay = '';
  for (const i of NC.items) {
    const day = fmtDay(i.at);
    if (day !== lastDay) { html += `<div class="day-divider">${esc(day)}</div>`; lastDay = day; }
    html += ncItemHtml(i);
  }
  body.innerHTML = html;
}

function ncOpen() {
  openDrawer('notifDrawer');
  ncRenderList();
  ncMarkAllRead();
}

function ncMarkAllRead() {
  let changed = false;
  for (const i of NC.items) if (!i.read) { i.read = true; changed = true; }
  if (changed) { ncSave(); ncRenderBell(); ncRenderList(); }
}

// buka chat -> notifikasi milik chat itu langsung dianggap sudah dibaca
function ncMarkChatRead(chatId) {
  if (!chatId) return;
  let changed = false;
  for (const i of NC.items) if (!i.read && i.chatId === chatId) { i.read = true; changed = true; }
  if (changed) {
    ncSave();
    ncRenderBell();
    if (!$('notifDrawer').classList.contains('hidden')) ncRenderList();
  }
}

function ncClear() {
  NC.items = [];
  ncSave();
  ncRenderBell();
  ncRenderList();
  toast('Semua notifikasi dihapus');
}

function ncClick(id) {
  const item = NC.items.find((i) => i.id === id);
  if (!item) return;
  item.read = true;
  ncSave();
  ncRenderBell();
  closeDrawers();
  if (item.chatId && S.activeChatId !== item.chatId) openChat(item.chatId);
}

$('btnNotifCenter').addEventListener('click', ncOpen);
$('btnCloseNotif').addEventListener('click', closeDrawers);
$('btnClearNotif').addEventListener('click', ncClear);
$('btnMarkAllNotif').addEventListener('click', ncMarkAllRead);
$('notifCenterBody').addEventListener('click', (e) => {
  const el = e.target.closest('[data-nc]');
  if (el) ncClick(el.dataset.nc);
});

ncLoad();
ncRenderBell();

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
      if (localId && S.messages[payload.chatId]) removeLocalMessage(payload.chatId, localId);
      return;
    }
    const arr = S.messages[payload.chatId] || (S.messages[payload.chatId] = []);
    if (localId) removeLocalMessage(payload.chatId, localId);
    if (res.message && !arr.some((x) => x.id === res.message.id)) arr.push(res.message);
    if (res.message && payload.chatId === S.activeChatId) {
      upsertMessage(res.message); // perbarui panel secara selektif
      if (UI.nearBottom) scrollToBottom(false);
    }
    renderChatList();
  });
}

/* upload with progress (XHR for progress events) */
function putPresigned(url, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && typeof onProgress === 'function') onProgress(e.loaded / e.total); };
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

async function uploadFile(file, onProgress = () => {}) {
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
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && typeof onProgress === 'function') onProgress(e.loaded / e.total); };
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
  if (S.activeChatId === chatId) {
    appendMessage(tmp); // bubble optimis muncul seketika
    scrollToBottom(false);
  }

  try {
    const meta = await uploadFile(file, (p) => {
      tmp._progress = Math.round(p * 100);
      const bar = S.activeChatId === chatId ? msgNode(localId) : null;
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
    removeLocalMessage(chatId, localId);
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
  'groupDrawer', 'groupInfoDrawer', 'statusComposer', 'privacyDrawer', 'adminDrawer', 'notifDrawer', 'botCatDrawer',
  'planDrawer', 'inviteDrawer', 'aboutDrawer'];

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
    else if (action === 'plans') openPlanDrawer();
    else if (action === 'invite') openInviteDrawer();
    else if (action === 'wallpaper') openWallpaper();
    else if (action === 'homebg') openHomeBg();
    else if (action === 'theme') toggleTheme();
    else if (action === 'privacy') openPrivacy();
    else if (action === 'bots') openBotCatalog();
    else if (action === 'admin') openAdminPanel();
    else if (action === 'about') openAboutDrawer();
    else if (action === 'logout') {
      closeDrawers();
      logout();
    }
  });
});

/* ================= daftar bot (khusus premium) ================= */
$('btnCloseBotCat').addEventListener('click', closeDrawers);

async function openBotCatalog() {
  openDrawer('botCatDrawer');
  $('bcCount').textContent = '';
  const body = $('bcBody');
  body.innerHTML = '<div class="bc-loading">Memuat daftar bot…</div>';
  try {
    renderBotCatalog(await api('/api/bots'));
  } catch (err) {
    if (err.status === 403 && err.data && err.data.locked) renderBotLocked(err.data);
    else renderBotError(err.message);
  }
}

function renderBotError(message) {
  $('bcBody').innerHTML = `
    <div class="bc-locked">
      <div class="bc-lock-ico"><svg viewBox="0 0 24 24"><use href="#ic-info" /></svg></div>
      <h3>Daftar bot belum bisa dimuat</h3>
      <p>${esc(message || 'Terjadi gangguan sesaat, silakan coba lagi.')}.</p>
      <button class="btn-ghost" id="bcRetry" type="button">Coba lagi</button>
    </div>`;
  $('bcRetry').addEventListener('click', openBotCatalog);
}

function renderBotCatalog(data) {
  const groups = data.groups || [];
  const total = Number(data.total) || groups.reduce((sum, g) => sum + g.bots.length, 0);
  $('bcCount').textContent = `${total} bot`;
  const body = $('bcBody');
  body.innerHTML = groups.map((g) => `
    <section class="bc-group">
      <div class="bc-group-head">
        <h4>${esc(g.label)}</h4>
        <span class="bc-group-count">${g.bots.length}</span>
      </div>
      <p class="bc-group-desc">${esc(g.desc || '')}</p>
      <div class="bc-list">
        ${g.bots.map((b) => `
          <button class="bc-card" type="button" data-bot="${esc(b.id)}">
            <span class="avatar bc-avatar"></span>
            <span class="bc-info">
              <span class="bc-name">${esc(b.name)}${badge(true)}</span>
              <span class="bc-about">${esc(b.about || b.tagline || '')}</span>
            </span>
            <span class="bc-go" aria-hidden="true">›</span>
          </button>`).join('')}
      </div>
    </section>`).join('');
  body.querySelectorAll('[data-bot]').forEach((el) => {
    const bot = groups.flatMap((g) => g.bots).find((b) => b.id === el.dataset.bot);
    const av = el.querySelector('.bc-avatar');
    if (av) setAvatar(av, bot || {});
    el.addEventListener('click', () => startDirect(el.dataset.bot));
  });
  body.scrollTop = 0;
}

function renderBotLocked(data) {
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const total = Number(data.total) || 0;
  $('bcCount').textContent = 'Premium';
  $('bcBody').innerHTML = `
    <div class="bc-locked">
      <div class="bc-lock-ico"><svg viewBox="0 0 24 24"><use href="#ic-crown" /></svg></div>
      <h3>Daftar Bot Khusus Premium</h3>
      <p>${total ? `${total} bot` : 'Seluruh bot'} siap dipakai — AI multi-model, pencarian, media, info, hiburan, sampai alat produktivitas. Semuanya hanya untuk admin &amp; pengguna premium.</p>
      ${plans.length ? `
      <div class="bc-plans">
        ${plans.map((p) => `<span class="bc-plan">${esc(p.label)}<small>${p.price ? `Rp${Number(p.price).toLocaleString('id-ID')}/` : ''}${Number(p.days) || 0} hari</small></span>`).join('')}
      </div>` : ''}
      <p class="bc-hint">Pilih paket lalu aktifkan lewat admin Whatsap Indo. Begitu aktif, menu Daftar Bot langsung terbuka.</p>
      <button class="btn-primary" id="bcOpenPlans" type="button">Lihat Paket &amp; Harga</button>
      <button class="btn-ghost" id="bcClose" type="button">Mengerti</button>
    </div>`;
  $('bcOpenPlans').addEventListener('click', () => openPlanDrawer());
  $('bcClose').addEventListener('click', closeDrawers);
}

/* ================= paket & harga ================= */
const ADMIN_CS_EMAIL = 'ovalkyzz@gmail.com';

function rupiah(n) {
  return `Rp${(Number(n) || 0).toLocaleString('id-ID')}`;
}

async function openPlanDrawer() {
  openDrawer('planDrawer');
  const body = $('planBody');
  body.innerHTML = '<div class="bc-loading">Memuat paket premium…</div>';
  try {
    renderPlans(await api('/api/plans'));
  } catch (err) {
    body.innerHTML = `
      <div class="bc-locked">
        <div class="bc-lock-ico"><svg viewBox="0 0 24 24"><use href="#ic-info" /></svg></div>
        <h3>Paket belum bisa dimuat</h3>
        <p>${esc(err.message)}</p>
        <button class="btn-ghost" id="planRetry" type="button">Coba lagi</button>
      </div>`;
    $('planRetry').addEventListener('click', openPlanDrawer);
  }
}

// daftar fitur sebuah paket (ok=false = batasan yang mengurangi akses)
function planFeatures(p, botTotal, exclusiveIds) {
  const excluded = Array.isArray(p.excluded) ? p.excluded : [];
  const feats = [];
  if (excluded.length) {
    const open = Math.max(botTotal - excluded.length, 0);
    feats.push({ ok: true, text: `${open} bot umum terbuka (AI, media, info, hiburan)` });
    feats.push({ ok: false, text: `Tanpa bot eksklusif: ${(exclusiveIds || []).map(shortBotId).join(', ')}` });
  } else {
    feats.push({ ok: true, text: `Seluruh ${botTotal} bot premium terbuka` });
  }
  if (Number(p.dailyLimit) > 0) feats.push({ ok: true, text: `Limit ${p.dailyLimit} pesan bot / hari` });
  else feats.push({ ok: true, text: 'Pesan bot tanpa limit harian' });
  feats.push({ ok: true, text: p.permanen ? 'Masa aktif selamanya' : `${Number(p.days) || 0} hari masa aktif` });
  feats.push({ ok: true, text: 'Centang biru terverifikasi' });
  feats.push({ ok: true, text: 'Kirim foto, video & file hingga 2GB' });
  return feats;
}

function shortBotId(id) {
  return {
    'bot-verif-am': 'Verif AM',
    'bot-nik': 'Parse NIK',
    'bot-pos': 'Kodepos',
    'bot-wilayah': 'Wilayah',
    'bot-nftoken': 'Nfotoken',
  }[id] || id;
}

function renderPlans(data) {
  const plans = data.plans || [];
  const me = data.me || {};
  const invite = data.invite || {};
  const botTotal = Number(data.botTotal) || 69;
  const exclusiveIds = data.exclusiveBotIds || [];
  const popularId = plans.some((p) => p.id === 'bulanan')
    ? 'bulanan'
    : (plans[Math.min(1, plans.length - 1)] || {}).id;
  const body = $('planBody');

  const quota = me.limit > 0
    ? `<div class="plan-quota">
         <div class="plan-quota-top"><span>Hari ini ${Math.min(me.used, me.limit)}/${me.limit} pesan bot</span>
           <span class="plan-token"><svg viewBox="0 0 24 24"><use href="#ic-zap" /></svg> ${Number(me.tokens) || 0} token</span></div>
         <div class="plan-quota-bar"><i style="width:${Math.min(100, Math.round(((me.used || 0) / me.limit) * 100))}%"></i></div>
         <small>Habis? Pakai token undangan, atau ajak teman untuk token tambahan.</small>
       </div>`
    : me.active
      ? `<div class="plan-quota on"><div class="plan-quota-top"><span>Kuota bot tanpa limit</span>
           <span class="plan-token"><svg viewBox="0 0 24 24"><use href="#ic-zap" /></svg> ${Number(me.tokens) || 0} token</span></div>
           <div class="plan-quota-bar"><i style="width:100%"></i></div></div>`
      : '';

  body.innerHTML = `
    <div class="plan-hero">
      <span class="plan-hero-orb o1"></span><span class="plan-hero-orb o2"></span>
      <span class="plan-hero-chip"><svg viewBox="0 0 24 24"><use href="#ic-star" /></svg> WHATSAP INDO PREMIUM</span>
      <h3>Semua bot dalam satu paket</h3>
      <p>${botTotal} bot AI, alat produktivitas, media &amp; informasi — pilih durasi sesuai kebutuhanmu.</p>
      <div class="plan-status ${me.active ? 'on' : ''}">
        ${me.active
          ? `<strong>${esc(me.planLabel || 'Premium')}</strong><span>aktif s/d ${fmtDate(me.until)}</span>`
          : `<strong>Belum punya paket</strong><span>Daftar bot masih terkunci — pilih paket di bawah</span>`}
      </div>
      ${quota}
    </div>

    <div class="plan-grid">
      ${plans.map((p, i) => {
        const isCurrent = me.active && me.planId === p.id;
        const feats = planFeatures(p, botTotal, exclusiveIds);
        return `
        <article class="plan-card ${isCurrent ? 'is-current' : ''} ${p.id === popularId ? 'is-popular' : ''}" style="--i:${i}">
          ${p.id === popularId ? '<span class="plan-tag">PALING LARIS</span>' : ''}
          <span class="plan-shine"></span>
          <div class="plan-head">
            <span class="plan-ico"><svg viewBox="0 0 24 24"><use href="#ic-${p.permanen ? 'crown' : 'star'}" /></svg></span>
            <h4>${esc(p.label)}</h4>
            <small>${p.permanen ? 'Selamanya' : `${Number(p.days) || 0} hari`}</small>
          </div>
          <div class="plan-price"><span class="rp">Rp</span><b class="plan-amount" data-price="${Number(p.price) || 0}">0</b><i>/ ${p.permanen ? 'sekali bayar' : `${Number(p.days) || 0} hari`}</i></div>
          <ul class="plan-feats">
            ${feats.map((f) => `<li class="${f.ok ? '' : 'no'}"><svg viewBox="0 0 24 24"><use href="#ic-${f.ok ? 'check' : 'close'}" /></svg><span>${esc(f.text)}</span></li>`).join('')}
          </ul>
          ${isCurrent ? '<div class="plan-current"><svg viewBox="0 0 24 24"><use href="#ic-check" /></svg> Paket Anda saat ini</div>' : ''}
          <button class="plan-cta ${isCurrent ? 'is-active' : ''}" type="button" data-plan-cta="${esc(p.id)}">
            ${isCurrent ? 'Perpanjang / Hubungi CS' : `Pilih ${esc(p.label)}`}
          </button>
        </article>`;
      }).join('')}
    </div>

    <div class="plan-actions">
      <button class="btn-primary" id="planCs" type="button">
        <svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-phone" /></svg> Hubungi Admin / CS
      </button>
      <button class="btn-ghost" id="planInvite" type="button">
        <svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-gift" /></svg> Ajak teman — dapat ${Number(invite.inviteTokens) || 5} token
      </button>
    </div>
    <p class="plan-note">Paket diaktifkan admin setelah pembayaran. <b>Harian</b> tanpa bot eksklusif &amp; berlimit harian,
    <b>Mingguan</b> semua bot dengan limit yang diatur admin, <b>Bulanan</b> &amp; <b>Permanen</b> tanpa limit.
    Semakin banyak teman yang join lewat kode undanganmu, semakin banyak token bot yang kamu dapat.</p>
  `;

  body.querySelectorAll('[data-plan-cta]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const plan = plans.find((p) => p.id === btn.dataset.planCta);
      toast(`Paket ${plan ? plan.label : ''}: ${plan ? rupiah(plan.price) : ''} — hubungi admin untuk mengaktifkan`);
      void chatWithAdmin();
    });
  });
  $('planCs').addEventListener('click', () => void chatWithAdmin());
  $('planInvite').addEventListener('click', () => openInviteDrawer());
  animatePlanCards(body);
}

// harga berjalan dari 0 -> nilai final saat kartu tampil (efek premium)
function animatePlanCards(scope) {
  scope.querySelectorAll('.plan-amount').forEach((el, idx) => {
    const target = Number(el.dataset.price) || 0;
    if (!target) { el.textContent = '0'; return; }
    const dur = 700 + idx * 120;
    const start = performance.now() + idx * 90;
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased).toLocaleString('id-ID');
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = target.toLocaleString('id-ID');
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  });
}

$('btnClosePlan').addEventListener('click', closeDrawers);

/* ================= undang teman ================= */
async function openInviteDrawer() {
  openDrawer('inviteDrawer');
  const body = $('inviteBody');
  body.innerHTML = '<div class="bc-loading">Memuat kode undangan…</div>';
  try {
    renderInvite(await api('/api/referral'));
  } catch (err) {
    body.innerHTML = `
      <div class="bc-locked">
        <div class="bc-lock-ico"><svg viewBox="0 0 24 24"><use href="#ic-gift" /></svg></div>
        <h3>Kode undangan belum bisa dimuat</h3>
        <p>${esc(err.message)}</p>
        <button class="btn-ghost" id="inviteRetry" type="button">Coba lagi</button>
      </div>`;
    $('inviteRetry').addEventListener('click', openInviteDrawer);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* browser lama */ }
    ta.remove();
    return ok;
  }
}

function inviteLink(code) {
  return `${location.origin}/?ref=${code}`;
}

function renderInvite(data) {
  const code = data.code || '—';
  const link = inviteLink(code);
  const body = $('inviteBody');
  body.innerHTML = `
    <div class="inv-hero">
      <span class="inv-gift"><svg viewBox="0 0 24 24"><use href="#ic-gift" /></svg></span>
      <h3>Undang teman, kumpulkan token</h3>
      <p>Setiap teman yang join memakai kodenya memberi kamu <b>+${Number(data.inviteTokens) || 5} token</b> limit bot.
      Temanmu juga langsung dapat <b>+${Number(data.welcomeTokens) || 5} token</b> selamat datang.</p>
    </div>

    <div class="inv-code-card">
      <span class="inv-label">Kode undangan kamu</span>
      <div class="inv-code">${esc(code)}</div>
      <div class="inv-btns">
        <button class="btn-primary" id="invCopyCode" type="button"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-copy" /></svg> Salin kode</button>
        <button class="btn-ghost" id="invCopyLink" type="button"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-chat" /></svg> Salin link</button>
        <button class="btn-ghost" id="invShare" type="button"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-gift" /></svg> Bagikan</button>
      </div>
      <div class="inv-link"><code>${esc(link)}</code></div>
    </div>

    <div class="inv-stats">
      <div class="inv-stat" style="--i:0"><b>${Number(data.invited) || 0}</b><span>Teman bergabung</span></div>
      <div class="inv-stat" style="--i:1"><b>${Number(data.tokens) || 0}</b><span>Token terkumpul</span></div>
    </div>

    <ol class="inv-steps">
      <li style="--i:0"><b>1</b><span>Salin kode atau link undangan kamu</span></li>
      <li style="--i:1"><b>2</b><span>Teman daftar &amp; menempelkan kode di form pendaftaran</span></li>
      <li style="--i:2"><b>3</b><span>Setelah admin menyetujui, kamu &amp; temanmu dapat token bot</span></li>
    </ol>

    <p class="inv-note">${data.referred ? 'Anda terdaftar lewat undangan teman — token selamat datang sudah ditambahkan.' : 'Makin banyak teman diundang, makin banyak token untuk kuota bot harianmu.'}</p>
  `;
  $('invCopyCode').addEventListener('click', async () => {
    const ok = await copyText(code);
    toast(ok ? 'Kode undangan disalin ✓' : 'Gagal menyalin — salin manual: ' + code);
    if (ok) $('invCopyCode').classList.add('done');
  });
  $('invCopyLink').addEventListener('click', async () => {
    toast((await copyText(link)) ? 'Link undangan disalin ✓' : 'Gagal menyalin link');
  });
  $('invShare').addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Gabung Whatsap Indo', text: `Daftar pakai kode undangan saya: ${code}`, url: link });
        return;
      } catch { /* dibatalkan / tidak didukung -> salin */ }
    }
    toast((await copyText(link)) ? 'Link undangan disalin ✓' : 'Gagal menyalin link');
  });
}

$('btnCloseInvite').addEventListener('click', closeDrawers);

/* ================= hubungi admin / CS ================= */
async function chatWithAdmin() {
  try {
    const data = await api('/api/cs');
    if (!data || !data.user) { toast(`Hubungi CS lewat email: ${ADMIN_CS_EMAIL}`); return; }
    await startDirect(data.user.id);
  } catch (err) {
    toast(err.message || `Email CS: ${ADMIN_CS_EMAIL}`);
  }
}

/* ================= tentang aplikasi ================= */
const ABOUT_HTML = `
  <div class="about-hero">
    <div class="about-logo">📱</div>
    <h3>Whatsap Indo</h3>
    <p class="about-sub">APK WhatsApp Indo Developer • Versi 1.0.0</p>
    <span class="about-badge"><svg viewBox="0 0 24 24"><use href="#ic-verified" /></svg> Developer resmi: mazval-developer-java</span>
  </div>

  <section class="about-sec" style="--i:0">
    <h4><svg viewBox="0 0 24 24"><use href="#ic-info" /></svg> Tentang Aplikasi</h4>
    <p>Whatsap Indo adalah aplikasi chat real-time dengan pengiriman foto, video, dan file hingga <b>2GB</b>,
    notifikasi sistem, status 24 jam, grup besar, serta ratusan bot premium (AI, informasi, media, hiburan,
    alat produktivitas) yang bisa dipakai lewat paket premium.</p>
  </section>

  <section class="about-sec" style="--i:1">
    <h4><svg viewBox="0 0 24 24"><use href="#ic-check" /></svg> Cara Menggunakan</h4>
    <ol class="about-steps">
      <li><b>1</b><span><strong>Daftar akun</strong> — isi nama, email &amp; password, lalu tunggu persetujuan admin.</span></li>
      <li><b>2</b><span><strong>Masuk &amp; lengkapi profil</strong> — ketuk Menu → Profil &amp; Info untuk nama, bio, dan foto profil.</span></li>
      <li><b>3</b><span><strong>Mulai chat</strong> — tekan ✏️, cari teman lewat email, atau buat grup baru.</span></li>
      <li><b>4</b><span><strong>Aktifkan paket premium</strong> — Menu → Paket &amp; Harga, pilih paket lalu hubungi admin/CS.</span></li>
      <li><b>5</b><span><strong>Pakai bot</strong> — Menu → Daftar Bot, pilih bot lalu langsung ngobrol dengannya.</span></li>
      <li><b>6</b><span><strong>Undang teman</strong> — Menu → Undang Teman, bagikan kode WA-MAZ-VAL-XXXX untuk token tambahan.</span></li>
    </ol>
  </section>

  <section class="about-sec" style="--i:2">
    <h4><svg viewBox="0 0 24 24"><use href="#ic-phone" /></svg> Kontak Admin / CS Developer</h4>
    <p class="about-cs-lead">Ada masalah, butuh aktivasi paket, atau laporan bug? Hubungi customer service developer:</p>
    <div class="about-cs">
      <div class="about-cs-row"><span class="cs-ico"><svg viewBox="0 0 24 24"><use href="#ic-mail" /></svg></span>
        <span class="cs-text"><strong>Email CS</strong><small>ovalkyzz@gmail.com</small></span>
        <a class="cs-go" href="mailto:ovalkyzz@gmail.com?subject=CS%20Whatsap%20Indo">Kirim</a></div>
      <div class="about-cs-row"><span class="cs-ico"><svg viewBox="0 0 24 24"><use href="#ic-chat" /></svg></span>
        <span class="cs-text"><strong>Chat admin di aplikasi</strong><small>Balasan langsung di kotak masuk</small></span>
        <button class="cs-go" id="aboutCsChat" type="button">Chat</button></div>
      <div class="about-cs-row"><span class="cs-ico"><svg viewBox="0 0 24 24"><use href="#ic-crown" /></svg></span>
        <span class="cs-text"><strong>Aktivasi paket premium</strong><small>Minta admin mengaktifkan paket pilihanmu</small></span>
        <button class="cs-go" id="aboutCsPlans" type="button">Paket</button></div>
    </div>
  </section>

  <section class="about-sec" style="--i:3">
    <h4><svg viewBox="0 0 24 24"><use href="#ic-shield" /></svg> Keamanan &amp; Privasi</h4>
    <ul class="about-list">
      <li>Foto profil dilindungi: klik kanan, seret, simpan &amp; cetak dimatikan.</li>
      <li>Satu akun hanya boleh aktif di satu perangkat.</li>
      <li>Akun baru wajib disetujui admin — mencegah bot &amp; spam.</li>
    </ul>
  </section>

  <p class="about-copy">Whatsap Indo • v1.0.0 • MIT<br/>© mazval-developer-java</p>
`;

function openAboutDrawer() {
  openDrawer('aboutDrawer');
  const body = $('aboutBody');
  if (!body.dataset.ready) {
    body.innerHTML = ABOUT_HTML;
    body.dataset.ready = '1';
    body.querySelector('#aboutCsChat').addEventListener('click', () => void chatWithAdmin());
    body.querySelector('#aboutCsPlans').addEventListener('click', () => openPlanDrawer());
  }
}

$('btnCloseAbout').addEventListener('click', closeDrawers);

/* ================= proteksi gambar profil ================= */
// foto profil tidak bisa diklik kanan, diseret, disalin, dicetak, atau disimpan
function imgProtected(node) {
  const el = node instanceof Element ? node : (node && node.parentElement);
  return !!(el && el.closest && el.closest('.avatar, .protect-img'));
}

document.addEventListener('contextmenu', (e) => {
  if (imgProtected(e.target)) {
    e.preventDefault();
    toast('Foto profil dilindungi — tidak bisa disimpan lewat klik kanan.');
  }
});

document.addEventListener('dragstart', (e) => {
  if (imgProtected(e.target)) e.preventDefault();
});

document.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && imgProtected(sel.anchorNode)) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  const combo = e.ctrlKey || e.metaKey;
  if (key === 'printscreen') {
    // kosongkan papan klip hasil screenshot bila browser mengizinkan
    try { void navigator.clipboard && navigator.clipboard.writeText(' '); } catch { /* ditolak browser */ }
    toast('Screenshot dibatasi — gambar profil Anda dilindungi.');
    return;
  }
  if (combo && (key === 'p' || key === 's')) {
    e.preventDefault();
    toast(key === 'p' ? 'Mencetak halaman dinonaktifkan — gambar dilindungi.' : 'Menyimpan halaman dinonaktifkan — gambar dilindungi.');
  }
});

// tekan-tahan lama di ponsel sering memicu menu simpan gambar
document.addEventListener('touchstart', (e) => {
  if (imgProtected(e.target)) e.preventDefault();
}, { passive: false });

/* ================= foto profil: rapikan & anti-rusak ================= */
// foto dipotong persegi (center-crop 512px) supaya bulat & jelas tanpa terpotong wajah
function squareImage(file, size = 512) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        c.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return reject(new Error('Gagal memproses foto'));
          resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.92);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(new Error('Foto tidak bisa diproses'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('File gambar rusak atau format tidak didukung'));
    };
    img.src = url;
  });
}


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

// khusus admin: edit foto profil, nama & bio bot lewat panel info kontak
function syncBotPeer(updated) {
  S.peerCache[updated.id] = { ...(S.peerCache[updated.id] || {}), ...updated };
  S.chats.forEach((c) => {
    if (c.peer && c.peer.id === updated.id) c.peer = { ...c.peer, ...updated };
  });
  renderChatList();
  if (currentChat()?.peer?.id === updated.id) {
    updateChatStatus();
    if ($('chatName')) $('chatName').innerHTML = esc(chatTitle(currentChat())) + badge(updated.verified);
    setAvatar($('chatAvatar'), currentChat().peer);
  }
}

async function patchBot(user, body) {
  const res = await api(`/api/admin/bots/${user.id}`, { method: 'PATCH', body });
  const updated = res.user;
  syncBotPeer(updated);
  Object.assign(user, updated);
  return updated;
}

function bindBotProfileEdit(user, peer) {
  const input = $('ciAvatarInput');
  $('ciAvatarBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Foto profil maksimal 5MB'); return; }
    try {
      const meta = await uploadFile(file, () => {});
      const updated = await patchBot(user, { avatar: meta.url });
      setAvatar($('contactAvatar'), { ...peer, ...updated });
      toast('Foto profil bot diperbarui');
    } catch (err) { toast(err.message); }
  });

  const nameRow = $('ciNameRow');
  const bioRow = $('ciBioRow');
  if (!nameRow || !bioRow) return;

  $('ciNameBtn').addEventListener('click', () => {
    bioRow.classList.add('hidden');
    nameRow.classList.toggle('hidden');
    if (!nameRow.classList.contains('hidden')) {
      $('ciNameInput').value = user.name || '';
      $('ciNameInput').focus();
    }
  });
  $('ciBioBtn').addEventListener('click', () => {
    nameRow.classList.add('hidden');
    bioRow.classList.toggle('hidden');
    if (!bioRow.classList.contains('hidden')) {
      $('ciBioInput').value = user.about || '';
      $('ciBioInput').focus();
    }
  });
  $('ciNameCancel').addEventListener('click', () => nameRow.classList.add('hidden'));
  $('ciBioCancel').addEventListener('click', () => bioRow.classList.add('hidden'));

  $('ciNameSave').addEventListener('click', async () => {
    const value = $('ciNameInput').value.trim();
    if (value.length < 2) { toast('Nama minimal 2 karakter'); return; }
    try {
      const updated = await patchBot(user, { name: value });
      $('ciName').innerHTML = esc(updated.name) + badge(updated.verified);
      nameRow.classList.add('hidden');
      toast('Nama bot diperbarui');
    } catch (err) { toast(err.message); }
  });

  $('ciBioSave').addEventListener('click', async () => {
    const value = $('ciBioInput').value.trim();
    try {
      const updated = await patchBot(user, { about: value });
      $('ciBio').textContent = updated.about || 'Tidak ada bio';
      bioRow.classList.add('hidden');
      toast('Bio bot diperbarui');
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
        <div class="ci-title">
          <h3 id="ciName">${esc(u.name)}${badge(u.verified)}</h3>
          ${canEditBot ? '<button class="ci-edit" id="ciNameBtn" type="button" title="Ubah nama bot"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-edit" /></svg></button>' : ''}
        </div>
        <div class="ci-title ci-title-bio">
          <p class="bio" id="ciBio">${esc(u.about || 'Tidak ada bio')}</p>
          ${canEditBot ? '<button class="ci-edit" id="ciBioBtn" type="button" title="Ubah bio bot"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-edit" /></svg></button>' : ''}
        </div>
        ${canEditBot ? `
        <div class="ci-editrow hidden" id="ciNameRow">
          <input id="ciNameInput" maxlength="60" placeholder="Nama bot" />
          <div class="ci-editbtns">
            <button class="ci-save" id="ciNameSave" type="button">Simpan</button>
            <button class="ci-cancel" id="ciNameCancel" type="button">Batal</button>
          </div>
        </div>
        <div class="ci-editrow hidden" id="ciBioRow">
          <textarea id="ciBioInput" maxlength="200" rows="3" placeholder="Bio bot"></textarea>
          <div class="ci-editbtns">
            <button class="ci-save" id="ciBioSave" type="button">Simpan</button>
            <button class="ci-cancel" id="ciBioCancel" type="button">Batal</button>
          </div>
        </div>` : ''}
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
      </div>`;
    setAvatar($('contactAvatar'), peer);
    $('ciChat').addEventListener('click', () => { closeDrawers(); $('messageInput').focus(); });
    if (canEditBot) bindBotProfileEdit(u, peer);
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
  $('avatarInput').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('File harus berupa gambar (JPG/PNG/WEBP)'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Avatar maksimal 5MB'); return; }
  try {
    // potong persegi dulu supaya bulat, jelas, dan tidak terpotong saat ditampilkan
    let upload = file;
    try { upload = await squareImage(file); } catch (proc) { toast(proc.message); return; }
    const meta = await uploadFile(upload, () => {});
    const data = await api('/api/me', { method: 'PATCH', body: { avatar: meta.url } });
    S.me = data.user;
    renderMe();
    setAvatar($('profileAvatar'), S.me);
    toast('Foto profil diperbarui ✓');
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
    `<option value="${esc(p.id)}">${esc(p.label)} • ${p.days} hari${p.price ? ` • ${rupiah(p.price)}` : ''}</option>`).join('');
}

function renderAdmPlans() {
  $('admPlans').innerHTML = adm.plans.map((p, i) => `
    <div class="adm-plan-card${p.permanen ? ' is-perm' : ''}">
      <div class="adm-plan-row">
        <input type="text" value="${esc(p.label)}" data-plan-label="${i}" maxlength="30" aria-label="Nama paket" />
        <input type="number" min="1" max="3650" value="${Number(p.days) || 1}" data-plan-days="${i}" aria-label="Durasi hari" />
        <span class="adm-plan-unit">hari</span>
      </div>
      <div class="adm-plan-row">
        <input type="number" min="0" max="1000000000" step="500" value="${Number(p.price) || 0}" data-plan-price="${i}" aria-label="Harga rupiah" />
        <span class="adm-plan-unit">Rp</span>
        <input type="number" min="0" max="1000000" value="${Number(p.dailyLimit) || 0}" data-plan-limit="${i}" aria-label="Limit pesan bot harian" />
        <span class="adm-plan-unit">bot/hari</span>
      </div>
      <small class="adm-plan-hint">${p.permanen ? 'Paket permanen — masa aktif selamanya' : 'Limit 0 = tanpa batas'}${(p.excluded || []).length ? ` • ${p.excluded.length} bot eksklusif ditutup` : ''}</small>
    </div>`).join('') || '<div class="empty-state">Belum ada paket.</div>';
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
  const val = (sel, fallback) => {
    const el = document.querySelector(sel);
    return el && el.value !== '' && el.value !== null ? Number(el.value) : fallback;
  };
  // label/harga/limit diedit; id, bot eksklusif & sifat permanen ikut dikirim utuh
  const plans = adm.plans.map((p, i) => ({
    ...p,
    label: (document.querySelector(`[data-plan-label="${i}"]`)?.value || p.label).trim(),
    days: val(`[data-plan-days="${i}"]`, Number(p.days) || 1),
    price: val(`[data-plan-price="${i}"]`, Number(p.price) || 0),
    dailyLimit: val(`[data-plan-limit="${i}"]`, Number(p.dailyLimit) || 0),
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
    admMsg('admBgMsg', 'Mengunggah file...', false);
    const meta = await uploadFile(file, (p) => admMsg('admBgMsg', `Mengunggah ${Math.round(p * 100)}%...`, false));
    adm.pendingBg = { type: isVideo ? 'video' : 'image', url: meta.url };
    renderAdmBg();
    admMsg('admBgMsg', 'Terpasang di pratinjau — tekan Simpan Background', false);
  } catch (err) { admMsg('admBgMsg', err.message, true); }
});
$('btnSaveHomeBgAdm').addEventListener('click', async () => {
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
          <div class="avatar avatar-xl ring" id="giAvatar"></div>
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

    setAvatar($('giAvatar'), { name: chat.name, avatar: chat.avatar });

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
  bindMessageActions(); // satu listener delegasi untuk semua tombol pesan
  bindMessagesScroll();  // scroll + tombol "ke pesan terbaru"
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
