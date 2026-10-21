'use strict';

/* ================= state ================= */
const S = {
  token: localStorage.getItem('wa_token') || null,
  me: null,
  socket: null,
  chats: [],
  activeChatId: null,
  messages: {},   // chatId -> array
  loaded: {},     // chatId -> riwayat awal sudah ditarik dari server
  everConnected: false, // socket pernah tersambung (untuk deteksi reconnect)
  typing: {},     // chatId -> { userId: timeoutId }
  pendingFile: null,
  pendingFileUrl: null, // object URL pratinjau lampiran (di-revoke saat dibersihkan)
  viewOncePending: false, // lampiran berikutnya = foto/video sekali lihat
  replyTo: null,        // pesan yang sedang dibalas (objek pesan)
  peerCache: {},  // userId -> user
  statusFeed: [], // hasil /api/status (per pengguna)
  groupDraft: { name: '', members: [] },
  more: {},         // chatId -> masih ada pesan lebih lama di server
  // call
  call: null, // { callId, peer, kind, pc, incoming, state, startedAt, timer }
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
  archivedOpen: false, // panel "Arsip" di daftar chat sedang dibuka
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

/* Fallback media: bila foto/video gagal dimuat (file hilang/rusak), tampilkan
   placeholder rapi "media tidak tersedia" alih-alih ikon rusak. */
function mediaBroken(el) {
  const box = (el && el.closest && (el.closest('.msg-media') || el.closest('.st-thumb') || el.closest('.st-thumb-video'))) || (el && el.parentElement);
  if (box && !box.classList.contains('media-broken')) {
    box.classList.add('media-broken');
    const label = (el && el.tagName === 'VIDEO') ? 'Video tidak tersedia' : 'Media tidak tersedia';
    box.innerHTML = `<span class="media-broken-ico"><svg viewBox="0 0 24 24"><use href="#ic-${el && el.tagName === 'VIDEO' ? 'video' : 'image'}" /></svg></span><span class="media-broken-txt">${label}</span>`;
  }
}

/* media selesai dimuat: tinggi bubble bisa melonjak -> bila sedang di bawah,
   ikut turun ke pesan terakhir supaya posisi baca tidak meleset */
function mediaLoaded() {
  if (!UI.nearBottom) return;
  const box = $('messages');
  if (box) box.scrollTop = box.scrollHeight;
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
  if (err) {
    e.textContent = err;
    e.classList.remove('hidden');
    e.classList.remove('anim'); void e.offsetWidth; e.classList.add('anim'); // animasi ulang tiap muncul
  } else e.classList.add('hidden');
  // kartu sapaan mengikuti tab yang sedang aktif
  showRegGreet(!!document.querySelector('.auth-tab[data-tab="register"].active'));
}

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}

function logout(callServer = true, message) {
  if (rec && !rec.done) stopRecording(false); // jangan tinggalkan mikrofon menyala
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
  // socket selalu diputus — juga saat dipaksa keluar (401 / diblokir) supaya
  // server tidak terus mengirim pesan ke tab yang sudah keluar
  if (S.socket) { try { S.socket.disconnect(); } catch { /* sudah putus */ } }
  void unsubscribePush();
  S.token = null; S.me = null; S.chats = []; S.activeChatId = null;
  // bersihkan seluruh state milik akun sebelumnya supaya tidak bocor ke sesi berikutnya
  const hadFile = !!(S.pendingFile || S.viewOncePending);
  S.messages = {}; S.more = {}; S.loaded = {}; S.typing = {}; S.peerCache = {};
  S.statusFeed = []; S.pendingFile = null; S.viewOncePending = false;
  S.storyComments = []; S.storyReplyTo = null; S.storyCmtLoaded = null;
  S.groupDraft = { name: '', members: [] }; S.everConnected = false;
  if (hadFile) clearAttachPreview();
  UI.chatId = null; UI.hasMore = true; UI.loadingOlder = false;
  UI.newWhileUp = 0; UI.nearBottom = true;
  NC.items = []; ncSave(); ncRenderBell();
  $('appView').classList.remove('chat-open');
  $('chatEmpty').classList.remove('hidden');
  $('chatActive').classList.add('hidden');
  $('messageInput').value = '';
  localStorage.removeItem('wa_token');
  showAuth(message);
  void loadHomeBg(); // kembali ke latar global/bawaan setelah keluar
}

/* ================= sapaan halaman daftar =================
   Teks disunting admin (GET /api/settings/public -> regGreet). Placeholder
   {nama} diganti otomatis dengan nama yang diketik pendaftar; pesan blokir
   anti-spam (code ip_diblokir) juga tampil di kartu ini. Tidak ada media
   yang dimuat ke memori perangkat — hanya teks dari server. */
const REG_GREETING_FALLBACK = 'Selamat datang, {nama}! Lengkapi data di bawah untuk bergabung dengan RTC-Core.';
let regGreetTpl = REG_GREETING_FALLBACK;
let regGreetLoaded = false;
let regGreetRevealed = false;
let regGreetSwapTimer = null;
let regGreetTypeTimer = null;

function regGreetRendered() {
  const input = document.querySelector('#registerForm input[name="name"]');
  const name = ((input && input.value) || '').trim().slice(0, 40);
  return regGreetTpl.replace(/\{nama\}|\{name\}/gi, name || 'Pengguna');
}

function paintRegGreet(mode) {
  const card = $('regGreet');
  const out = $('regGreetText');
  if (!card || !out) return;
  const txt = regGreetRendered();
  clearInterval(regGreetTypeTimer); regGreetTypeTimer = null;
  if (mode === 'type' && !regGreetRevealed && txt.length <= 140) {
    // reveal huruf demi huruf sekali saat kartu pertama muncul
    let i = 0;
    out.textContent = '';
    regGreetTypeTimer = setInterval(() => {
      i += 2;
      out.textContent = txt.slice(0, i);
      if (i >= txt.length) {
        clearInterval(regGreetTypeTimer); regGreetTypeTimer = null;
        regGreetRevealed = true;
      }
    }, 16);
    return;
  }
  regGreetRevealed = true;
  if (mode === 'swap') {
    card.classList.remove('swapping'); void card.offsetWidth; card.classList.add('swapping');
  }
  out.textContent = txt;
}

async function ensureRegGreet() {
  if (regGreetLoaded) return;
  try {
    const d = await api('/api/settings/public');
    if (d && typeof d.regGreet === 'string') regGreetTpl = d.regGreet || REG_GREETING_FALLBACK;
    regGreetLoaded = true;
    const card = $('regGreet');
    if (card && !card.classList.contains('hidden')) paintRegGreet(regGreetRevealed ? 'swap' : 'type');
  } catch { /* offline — pakai sapaan bawaan, coba lagi saat kunjungan berikut */ }
}

function showRegGreet(on) {
  const card = $('regGreet');
  if (!card) return;
  card.classList.toggle('hidden', !on);
  if (!on) {
    clearInterval(regGreetTypeTimer); regGreetTypeTimer = null;
    return;
  }
  card.classList.remove('blocked', 'shake');
  regGreetRevealed = false;
  paintRegGreet('type');
  void ensureRegGreet();
}

// IP diblokir anti-spam: pesan dari admin tampil di kartu sapaan + animasi
function showRegBlocked(msg) {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'register'));
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('authError').classList.add('hidden');
  const card = $('regGreet');
  if (!card) { showAuth(msg); return; }
  clearInterval(regGreetTypeTimer); regGreetTypeTimer = null;
  card.classList.remove('hidden');
  card.classList.add('blocked');
  regGreetRevealed = true;
  $('regGreetText').textContent = msg;
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
}

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('registerForm').classList.toggle('hidden', tab.dataset.tab !== 'register');
    $('authError').classList.add('hidden');
    showRegGreet(tab.dataset.tab === 'register');
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
  } catch (err) {
    if (err.data && err.data.code === 'ip_diblokir') { showRegBlocked(err.message); return; }
    showAuth(err.message);
  }
});

// sapaan menyapa pendaftar saat nama diketik (misal "Daffa" -> teks menyebut Daffa)
const regNameInput = document.querySelector('#registerForm input[name="name"]');
if (regNameInput) {
  regNameInput.addEventListener('input', () => {
    const card = $('regGreet');
    if (!card || card.classList.contains('hidden') || card.classList.contains('blocked')) return;
    clearTimeout(regGreetSwapTimer);
    regGreetSwapTimer = setTimeout(() => { regGreetRevealed = true; paintRegGreet('swap'); }, 220);
  });
}

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
  // izin notifikasi tidak lagi diminta diam-diam di sini: pengantar izin
  // (maybeShowPermIntro) yang menjelaskan lalu memintanya dengan sadar
  await startApp();
}

/* ================= boot ================= */
async function startApp() {
  showApp();
  renderMe();
  applyWallpaper();
  void loadHomeBg();
  await loadChats();
  void syncMissedCalls(); // riwayat panggilan tak terjawab -> pusat notifikasi
  updateComposerButtons();
  connectSocket();
  void handleDeepLinks(); // ?join=<kode grup> & ?u=<id kontak>
  void refreshPermUI();
  setSWPref('vibrate', NOTIF.vibrate); // selaraskan preferensi getar untuk service worker
  setTimeout(maybeShowPermIntro, 600); // pengantar izin bertahap (sekali per perangkat)
}

/* deep link: ?join=<kode> -> bergabung ke grup; ?u=<id> -> buka chat kontak.
   Berjalan setelah sesi valid; parameter dibersihkan dari URL agar tidak
   terproses ulang saat reload. */
async function handleDeepLinks() {
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  const u = params.get('u');
  if (!join && !u) return;
  // bersihkan URL tanpa reload
  try {
    const clean = location.pathname + (params.toString() ? '' : '') + location.hash;
    history.replaceState(null, '', clean);
  } catch { /* abaikan */ }

  if (join) {
    try {
      const data = await api(`/api/chats/join/${encodeURIComponent(join)}`, { method: 'POST' });
      await loadChats();
      if (data.chatId) openChat(data.chatId);
      toast(data.already ? `Anda sudah anggota grup ${data.name || ''}` : `Berhasil bergabung ke grup ${data.name || ''} ✓`);
    } catch (err) { toast(err.message); }
  } else if (u) {
    await openChatWithUser(u);
  }
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
  loadTermAccess(); // tampilkan menu Terminal bila berhak (admin/permanen/bisnis)
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

/* Koneksi pulih setelah putus: daftar chat & percakapan aktif disinkronkan
   ulang supaya pesan yang terlewat saat luring tidak hilang (ala WhatsApp). */
async function resyncAfterReconnect() {
  try {
    await loadChats();
  } catch { /* daftar chat lama tetap dipakai */ }
  const chatId = S.activeChatId;
  if (!chatId) return;
  try {
    const data = await api(`/api/chats/${chatId}/messages?limit=100`);
    const fresh = Array.isArray(data.messages) ? data.messages : [];
    const local = S.messages[chatId] || [];
    const realLocal = local.filter((m) => !String(m.id).startsWith('local-'));
    const freshIds = new Set(fresh.map((m) => m.id));
    // jendela lokal tidak lagi beririsan dengan yang terbaru -> riwayat lama
    // sedang dibuka, biarkan apa adanya agar tidak menggulir balik
    if (realLocal.length && !realLocal.some((m) => freshIds.has(m.id))) return;
    const pendingUploads = local.filter((m) => String(m.id).startsWith('local-') && !freshIds.has(m.id));
    S.messages[chatId] = [...fresh, ...pendingUploads];
    S.more[chatId] = !!data.hasMore;
    S.loaded[chatId] = true;
    UI.hasMore = S.more[chatId] !== false;
    UI.loadingOlder = false;
    if (UI.chatId === chatId) { renderMessages(); scrollToBottom(false); }
    markRead(chatId);
  } catch { /* biarkan tampilan lama */ }
}

function chatTitle(chat) {
  return chat.type === 'group' ? chat.name : (chat.peer?.name || 'Pengguna');
}

function previewText(chat) {
  const m = chat.lastMessage;
  if (!m) return 'Mulai percakapan';
  if (m.deleted) return 'Pesan dihapus';
  if (m.type === 'contact') {
    let name = 'Kontak';
    try { name = (JSON.parse(m.body) || {}).name || 'Kontak'; } catch { /* body bukan JSON */ }
    return '👤 ' + name;
  }
  const kind = { image: '📷 ', video: '🎬 ', audio: '🎵 ', file: '📄 ', sticker: '🏷️ ' }[m.type] || '';
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
  const matches = scope.filter((c) => {
    if (!q) return true;
    return chatTitle(c).toLowerCase().includes(q) || (c.peer?.email || '').toLowerCase().includes(q);
  });
  const el = $('chatList');

  const itemHtml = (c) => {
    const last = c.lastMessage;
    const time = last ? fmtListTime(last.createdAt) : '';
    const mine = last && last.senderId === S.me.id;
    // di grup preview juga menampilkan centang pesan siapa pun agar
    // status baca terakhir terlihat seluruh anggota
    const showTicks = !!last && !last.deleted && (mine || c.type === 'group');
    const ticks = showTicks ? tickHtml(last.status === 'sent' && !mine ? 'delivered' : last.status) : '';
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
      <button class="chat-item-arch" type="button" data-arch="${esc(c.id)}" title="${c.archived ? 'Keluarkan dari arsip' : 'Arsipkan chat'}">
        <svg viewBox="0 0 24 24" class="ico"><use href="#ic-archive" /></svg>
      </button>
    </div>`;
  };

  const wire = (container) => {
    container.querySelectorAll('.chat-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-arch]')) return;
        openChat(item.dataset.chat);
      });
    });
    container.querySelectorAll('[data-arch]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggleArchive(btn.dataset.arch); });
    });
    container.querySelectorAll('.chat-item').forEach((item) => {
      const c = S.chats.find((x) => x.id === item.dataset.chat);
      const av = item.querySelector('.avatar');
      if (c && av) setAvatar(av, c.type === 'group' ? { name: c.name, avatar: c.avatar } : c.peer);
    });
  };

  if (!matches.length) {
    const empty = q
      ? 'Tidak ada hasil'
      : sideTab === 'groups'
        ? 'Belum ada grup. Tekan "Buat grup" di atas untuk memulai.'
        : 'Belum ada chat. Tekan ✏️ untuk chat baru.';
    el.innerHTML = `<div class="empty-state">${empty}</div>`;
    updateNavBadges();
    return;
  }

  // pencarian: semua hasil (termasuk yang diarsipkan) ditampilkan datar
  if (q) {
    el.innerHTML = matches.map(itemHtml).join('');
    wire(el);
    updateNavBadges();
    return;
  }

  const archived = matches.filter((c) => c.archived);
  const main = matches.filter((c) => !c.archived);
  let html = '';
  if (archived.length) {
    html += `
    <button class="arch-bar ${UI.archivedOpen ? 'open' : ''}" id="archBar" type="button">
      <svg viewBox="0 0 24 24" class="ico"><use href="#ic-archive" /></svg>
      <span>Arsip</span>
      <span class="arch-count">${archived.length}</span>
    </button>`;
    if (UI.archivedOpen) html += archived.map(itemHtml).join('');
  }
  html += main.map(itemHtml).join('');
  el.innerHTML = html;
  wire(el);
  const archBar = $('archBar');
  if (archBar) archBar.addEventListener('click', () => { UI.archivedOpen = !UI.archivedOpen; renderChatList(); });
  updateNavBadges();
}

async function toggleArchive(chatId) {
  const c = S.chats.find((x) => x.id === chatId);
  if (!c) return;
  const next = !c.archived;
  try {
    await api(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived: next } });
    c.archived = next;
    if (next) UI.archivedOpen = true; // langsung terlihat di panel arsip
    toast(next ? 'Chat diarsipkan' : 'Chat dikeluarkan dari arsip');
    renderChatList();
  } catch (err) {
    toast(err.message || 'Gagal mengubah arsip');
  }
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
  clearReply(); // bar balasan tidak boleh ikut pindah chat
  $('appView').classList.add('chat-open');
  $('chatEmpty').classList.add('hidden');
  $('chatActive').classList.remove('hidden');

  $('chatName').innerHTML = esc(chatTitle(chat)) + badge(chat.peer?.verified);
  setAvatar($('chatAvatar'), chat.type === 'group' ? { name: chat.name, avatar: chat.avatar } : chat.peer);
  updateChatStatus();
  renderChatList();

  if (!S.loaded[chatId]) {
    try {
      const data = await api(`/api/chats/${chatId}/messages?limit=100`);
      const fresh = Array.isArray(data.messages) ? data.messages : [];
      const ids = new Set(fresh.map((m) => m.id));
      const local = S.messages[chatId] || [];
      // pesan yang datang selagi riwayat dimuat (dan bubble optimis) tidak boleh hilang
      S.messages[chatId] = [...fresh, ...local.filter((m) => !ids.has(m.id))];
      S.more[chatId] = !!data.hasMore;
      S.loaded[chatId] = true;
    } catch (err) {
      // muat gagal: jangan menampilkan panel lama di bawah judul chat baru
      S.activeChatId = null;
      $('appView').classList.remove('chat-open');
      $('chatEmpty').classList.remove('hidden');
      $('chatActive').classList.add('hidden');
      renderChatList();
      toast(err.message || 'Riwayat percakapan gagal dimuat');
      return;
    }
  }
  UI.hasMore = S.more[chatId] !== false;
  UI.loadingOlder = false;
  renderMessages();
  // kunci posisi pesan terakhir: render pertama + frame berikutnya (tinggi layout bisa berubah seketika)
  requestAnimationFrame(() => {
    const box = $('messages');
    if (box && UI.nearBottom) box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => { if (box && UI.nearBottom) box.scrollTop = box.scrollHeight; });
  });
  markRead(chatId);
  ncMarkChatRead(chatId);
  $('messageInput').focus();
}

function updateChatStatus() {
  const chat = currentChat();
  if (!chat) return;
  const peer = chat.peer;
  // bot & grup tidak punya jalur panggilan 1-ke-1: tombol disembunyikan
  const botPeer = !!(peer && peer.isBot);
  const hideCall = botPeer || chat.type === 'group';
  for (const id of ['btnCallVoice', 'btnCallVideo']) {
    const el = $(id);
    if (el) el.style.display = hideCall ? 'none' : '';
  }
  const t = S.typing[chat.id];
  if (t && Object.keys(t).length) {
    $('chatStatus').textContent = 'sedang mengetik...';
  } else if (chat.type === 'group') {
    const botNote = chat.bot ? ` • 🤖 ${chat.bot.name}` : '';
    const youAdmin = chat.role === 'admin' || (S.me && S.me.role === 'admin') ? ' • Anda admin' : '';
    $('chatStatus').textContent = `${chat.memberCount || 0} anggota${youAdmin}${botNote}`;
  } else if (peer && peer.online) {
    $('chatStatus').textContent = 'online';
  } else if (peer) {
    $('chatStatus').textContent = peer.lastSeen ? `terakhir dilihat ${fmtListTime(peer.lastSeen)} ${fmtTime(peer.lastSeen)}` : 'offline';
  } else {
    $('chatStatus').textContent = 'grup';
  }
  syncBotMentionButton(chat);
}

/* pintu @mention: tampil hanya di grup yang punya bot & pengguna boleh memakai bot */
function syncBotMentionButton(chat) {
  const btn = $('btnBotMention');
  if (!btn) return;
  const canUse = !!(S.me && (S.me.role === 'admin' || (S.me.premium && S.me.premium.active)));
  const show = !!(chat && chat.type === 'group' && chat.bot && canUse);
  btn.classList.toggle('hidden', !show);
}

function insertBotMention() {
  const chat = currentChat();
  if (!chat || !chat.bot) return;
  const ta = $('messageInput');
  const mention = `@${chat.bot.name} `;
  const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
  const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
  // jangan duplikat kalau baris sudah diawali sebutan bot yang sama
  const already = new RegExp(`@${chat.bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (already.test(ta.value)) {
    ta.focus();
    toast(`Sebutkan perintah setelah @${chat.bot.name}`);
    return;
  }
  ta.value = ta.value.slice(0, start) + mention + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + mention.length;
  ta.dispatchEvent(new Event('input'));
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
  // tag semua anggota: @all/@semua/@everyone tampil sebagai chip mention
  h = h.replace(/(^|\s)@(all|everyone|semua|semuanya|anggota)\b/gi, '$1<span class="mention-chip">@$2</span>');
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

function replyPreviewHtml(m) {
  const rp = m.replyPreview;
  if (!m.replyTo || !rp) return '';
  const mine = rp.senderId === (S.me && S.me.id);
  const name = mine ? 'Anda' : (rp.senderName || 'Pengirim');
  let body;
  if (rp.deleted) body = '🚫 Pesan dihapus';
  else if (rp.viewOnce) body = `📷 ${rp.type === 'video' ? 'Video' : 'Foto'} sekali lihat`;
  else if (rp.type === 'image') body = '📷 Foto';
  else if (rp.type === 'video') body = '🎬 Video';
  else if (rp.type === 'audio') body = '🎤 Pesan suara';
  else if (rp.type === 'file') body = '📎 Berkas';
  else if (rp.type === 'contact') body = '👤 Kontak';
  else if (rp.type === 'sticker') body = `😀 ${String(rp.body || 'Stiker').slice(0, 40)}`;
  else body = String(rp.body || '').slice(0, 140) || 'Pesan';
  return `<button type="button" class="reply-quote" data-jump="${esc(m.replyTo)}" title="Ke pesan asli">
    <span class="rq-bar" aria-hidden="true"></span>
    <span class="rq-text">
      <strong>${esc(name)}</strong>
      <small>${esc(body)}</small>
    </span>
  </button>`;
}

/* kartu kontak: pesan berbagi kontak (body = JSON {userId,name,email,avatar}) */
function contactCardHtml(m) {
  let c = null;
  try { c = JSON.parse(m.body); } catch { c = null; }
  if (!c || !c.userId) return `<div class="contact-card broken">Kontak tidak valid</div>`;
  const initial = esc((c.name || '?').charAt(0).toUpperCase());
  return `<button type="button" class="contact-card" data-opencontact="${esc(c.userId)}">
    <span class="cc-avatar">${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : initial}</span>
    <span class="cc-info">
      <strong>${esc(c.name || 'Kontak')}</strong>
      <small>${esc(c.email || '')}</small>
    </span>
    <span class="cc-go"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-chat" /></svg></span>
  </button>`;
}

function messageHtml(m, chat, opts = {}) {
  const out = m.senderId === S.me.id;
  const sender = out
    ? S.me
    : (chat.type === 'group' ? { name: m.senderName || 'Anggota', avatar: m.senderAvatar } : (chat.peer || {}));
  let inner = '';

  if (m.deleted) {
    inner = `<div class="deleted">🚫 Pesan dihapus</div>`;
  } else {
    inner += replyPreviewHtml(m);
    if (m.viewOnce) {
      const voLabel = m.type === 'video' ? 'Video' : 'Foto';
      inner += m.opened
        ? `<div class="vo-bubble opened">👁️ ${voLabel} sekali lihat sudah dibuka</div>`
        : `<button type="button" class="vo-bubble" data-vo="${esc(m.id)}"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-lock" /></svg>Buka ${voLabel.toLowerCase()} sekali lihat</button>`;
      if (m.body) inner += renderMsgBody(m.body);
    } else {
      if (m.type === 'sticker' && m.mediaUrl) {
        inner += `<div class="msg-sticker"><img src="${esc(m.mediaUrl)}" alt="${esc(m.body || 'Stiker')}" loading="lazy" onload="mediaLoaded()" onerror="mediaBroken(this)"></div>`;
      } else if (m.type === 'image' && m.mediaUrl) {
        inner += `<div class="msg-media"><a href="${esc(m.mediaUrl)}" target="_blank" rel="noopener"><img src="${esc(m.mediaUrl)}" alt="${esc(m.mediaName || '')}" loading="lazy" onload="mediaLoaded()" onerror="mediaBroken(this)"></a></div>`;
      } else if (m.type === 'video' && m.mediaUrl) {
        inner += `<div class="msg-media"><video src="${esc(m.mediaUrl)}" controls preload="metadata" onloadedmetadata="mediaLoaded()" onerror="mediaBroken(this)"></video></div>`;
      } else if (m.type === 'audio' && m.mediaUrl) {
        inner += audioPlayerHtml(m);
      } else if (m.type === 'file' && m.mediaUrl) {
        inner += `<a class="msg-file" href="${esc(m.mediaUrl)}" download="${esc(m.mediaName || 'file')}">
          <span class="file-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-doc" /></svg></span>
          <span class="msg-file-info"><strong>${esc(m.mediaName || 'file')}</strong><small>${esc(fmtSize(m.mediaSize))}</small></span>
        </a>`;
      } else if (m.type === 'contact') {
        inner += contactCardHtml(m);
      }
      if (m.body && m.type !== 'contact') inner += renderMsgBody(m.body);
    }
  }

  // di grup centang tampil di SEMUA pesan (milik sendiri maupun anggota lain)
  // supaya status baca terlihat oleh seluruh anggota
  let tickStatus = m.status;
  if (!out && tickStatus === 'sent') tickStatus = 'delivered'; // pesan masuk pasti sudah sampai ke layar ini
  const ticks = !m.deleted && (out || chat.type === 'group') ? tickHtml(tickStatus) : '';
  let progress = '';
  if (m.status === 'sending' && m.mediaSize != null) {
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
  bindSwipeReply();
}

async function onMessagesClick(e) {
  const jumpBtn = e.target.closest('[data-jump]');
  if (jumpBtn) {
    jumpToMessage(jumpBtn.dataset.jump);
    return;
  }
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
  const contactBtn = e.target.closest('[data-opencontact]');
  if (contactBtn) { await openChatWithUser(contactBtn.dataset.opencontact); return; }
  const playBtn = e.target.closest('.ap-play');
  if (playBtn) toggleAudioPlayer(playBtn.closest('.audio-player'));
}

/* ---------- balasan (usap bubble ke kanan) ---------- */
function setReply(m) {
  if (!m || m.deleted) return;
  S.replyTo = m;
  const rp = m.replyPreview || {
    senderId: m.senderId,
    senderName: m.senderId === (S.me && S.me.id) ? 'Anda' : null,
    type: m.type,
    body: m.body || '',
    viewOnce: !!m.viewOnce,
    deleted: false,
  };
  const mine = rp.senderId === (S.me && S.me.id);
  $('replyBarName').textContent = mine ? 'Anda' : (rp.senderName || (currentChat()?.type === 'group' ? 'Anggota' : (currentChat()?.peer?.name || 'Pengirim')));
  let preview;
  if (rp.deleted) preview = '🚫 Pesan dihapus';
  else if (rp.viewOnce) preview = `📷 ${rp.type === 'video' ? 'Video' : 'Foto'} sekali lihat`;
  else if (rp.type === 'image') preview = '📷 Foto';
  else if (rp.type === 'video') preview = '🎬 Video';
  else if (rp.type === 'audio') preview = '🎤 Pesan suara';
  else if (rp.type === 'file') preview = '📎 Berkas';
  else if (rp.type === 'contact') preview = '👤 Kontak';
  else preview = String(rp.body || '').slice(0, 120) || 'Pesan';
  $('replyBarPreview').textContent = preview;
  $('replyBar').classList.remove('hidden');
  $('messageInput').focus();
}

function clearReply() {
  S.replyTo = null;
  const bar = $('replyBar');
  if (bar) bar.classList.add('hidden');
}

$('btnCancelReply').addEventListener('click', () => {
  clearReply();
  $('messageInput').focus();
});

// lompat ke pesan asli kutipan (bila masih ada di panel)
function jumpToMessage(id) {
  const node = msgNode(id);
  if (!node) { toast('Pesan asli tidak ada di daftar ini'); return; }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1100);
}

// gesture usap bubble ke kanan -> balas (touch & mouse)
function bindSwipeReply() {
  const box = $('messages');
  if (!box) return;
  let msg = null, startX = 0, startY = 0, pulling = false, decided = false, lastDx = 0;

  const resetSwipe = () => {
    if (msg) {
      msg.classList.remove('swiping');
      msg.style.transform = '';
      msg.style.transition = '';
    }
    box.classList.remove('swiping-any');
    msg = null; pulling = false; decided = false; lastDx = 0;
  };

  const onDown = (e) => {
    if (e.target.closest('button, a, video, audio, input, textarea')) return;
    const target = e.target.closest('.msg');
    if (!target || !target.dataset.msg) return;
    const p = e.touches ? e.touches[0] : e;
    // tepi kiri khusus gesture "back" (bindEdgeBack) — jangan berebut
    if (p.clientX <= 30) return;
    msg = target;
    startX = p.clientX; startY = p.clientY;
    pulling = false; decided = false; lastDx = 0;
  };

  const onMove = (e) => {
    if (!msg) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - startX;
    const dy = p.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      // hanya tarikan horizontal dominan ke KANAN yang memicu balasan
      if (!(dx > 0 && dx > Math.abs(dy) * 1.25)) { resetSwipe(); return; }
      pulling = true;
      msg.classList.add('swiping');
      box.classList.add('swiping-any');
      msg.style.transition = 'none';
    }
    if (!pulling) return;
    if (e.cancelable && e.touches) e.preventDefault();
    const d = Math.max(0, Math.min(104, dx));
    lastDx = d;
    msg.style.transform = `translateX(${d}px)`;
  };

  const onUp = () => {
    if (!msg) return;
    const node = msg;
    const fired = pulling && lastDx >= 60;
    if (pulling) {
      node.style.transition = 'transform .18s cubic-bezier(.22, 1, .36, 1)';
      node.style.transform = '';
    }
    if (fired) {
      const m = (S.messages[S.activeChatId] || []).find((x) => x.id === node.dataset.msg);
      if (m && !m.deleted) setReply(m);
      else if (m && m.deleted) toast('Pesan sudah dihapus');
    }
    resetSwipe();
  };

  box.addEventListener('touchstart', onDown, { passive: true });
  box.addEventListener('touchmove', onMove, { passive: false });
  box.addEventListener('touchend', onUp);
  box.addEventListener('touchcancel', resetSwipe);
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
  // kursor keyset (created_at, id) supaya pesan dengan milidetik yang sama
  // tidak terlewat saat menggulir ke atas
  const first = msgs.find((m) => !String(m.id).startsWith('local-'));
  if (!first) { UI.hasMore = false; return; }
  UI.loadingOlder = true;
  showOlderLoading(true);
  try {
    const url = `/api/chats/${chat.id}/messages?limit=50&before=${first.createdAt}`
      + `&beforeId=${encodeURIComponent(first.id)}`;
    const data = await api(url);
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

/* ---------- foto/video sekali lihat ----------
   Server menjaga "sekali lihat" secara atomik lewat /api/messages/media/:id
   (penerima pertama menang; sisanya 410). <img>/<video> biasa tidak mengirim
   header Authorization, jadi media diambil lewat fetch ber-token lalu
   ditampilkan sebagai blob URL — hanya sekali, sesuai aturan server. */
let voBlobUrl = null;

function releaseVoBlob() {
  if (voBlobUrl) { URL.revokeObjectURL(voBlobUrl); voBlobUrl = null; }
}

async function openViewOnce(messageId) {
  const arr = S.messages[S.activeChatId] || [];
  const m = arr.find((x) => x.id === messageId);
  if (!m || !m.mediaUrl) { toast('Media sekali lihat sudah dibuka'); return; }
  const isVideo = m.type === 'video';
  const label = isVideo ? 'Video' : 'Foto';
  const viewer = $('voViewer');
  const stage = $('voStage');
  const note = $('voNote');
  releaseVoBlob();
  stage.innerHTML = `<div class="vo-loading">Memuat ${label.toLowerCase()}…</div>`;
  note.textContent = `${label} ini hanya bisa dilihat satu kali.`;
  viewer.classList.remove('hidden');

  try {
    const r = await fetch(m.mediaUrl, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!r.ok) {
      // 410 = sudah dikonsumsi penerima lain -> tandai; error lain biarkan tombol agar bisa coba lagi
      if (r.status === 410) { m.opened = true; patchMessage(m); }
      stage.innerHTML = `<div class="vo-gone">${r.status === 410 ? '⏱' : '⚠️'} ${r.status === 410 ? `${label} sekali lihat sudah dibuka.` : 'Gagal memuat media.'}</div>`;
      note.textContent = '';
      return;
    }
    const blob = await r.blob();
    voBlobUrl = URL.createObjectURL(blob);
    if (isVideo) {
      const v = document.createElement('video');
      v.className = 'vo-video';
      v.src = voBlobUrl;
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      stage.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.className = 'vo-img';
      img.alt = label;
      img.src = voBlobUrl;
      stage.appendChild(img);
    }
    // server sudah menandai opened_at pada pengambilan pertama -> sinkronkan UI
    m.opened = true;
    patchMessage(m);
  } catch {
    stage.innerHTML = `<div class="vo-gone">⚠️ Gagal memuat media. Periksa koneksi lalu coba lagi.</div>`;
    note.textContent = '';
  }
}

$('btnCloseVo').addEventListener('click', () => closeViewOnce());

/* ================= socket ================= */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.everConnected = false;
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const socket = io({
    auth: { token: S.token },
    // di hosting Vercel long-polling tidak menempel ke instance yang sama,
    // jadi wajib pakai transport WebSocket saja
    ...(isLocalhost ? {} : { transports: ['websocket'] }),
  });
  S.socket = socket;

  socket.on('connect', () => {
    $('connBar')?.classList.add('hidden');
    // koneksi pertama diserahkan ke startApp(); koneksi ulang perlu disinkronkan
    if (S.everConnected) void resyncAfterReconnect();
    S.everConnected = true;
  });

  socket.on('disconnect', () => {
    if (!S.token) return; // bukan putusnya koneksi — pengguna memang sudah keluar
    $('connBar')?.classList.remove('hidden');
  });

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
      chat.archived = false; // server mengeluarkan chat dari arsip saat ada pesan baru
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

  // fitur tag: seseorang menyebut saya di statusnya
  socket.on('status:tagged', ({ byName } = {}) => {
    const who = byName || 'Seseorang';
    toast(`${who} menandai Anda di status`);
    ncAdd({
      kind: 'status',
      title: 'Ditandai di status',
      body: `${who} menyebut Anda di status baru`,
      chatId: null,
      at: Date.now(),
    });
    if (sideTab === 'status') loadStatus().catch(() => {});
  });

  // komentar masuk / dibalas di status yang sedang dibuka atau status milik saya
  socket.on('status:comment', ({ statusId, comment, byName, isReply } = {}) => {
    const who = byName || 'Seseorang';
    const active = currentStoryStatus();
    if (active && active.id === statusId && comment) {
      if (S.storyCmtLoaded === active.id) {
        S.storyComments = S.storyComments || [];
        if (!S.storyComments.some((c) => c.id === comment.id)) S.storyComments.push(comment);
        active.commentCount = S.storyComments.length;
        renderStoryComments();
      } else {
        active.commentCount = Number(active.commentCount || 0) + 1;
        $('storyCmtCount').textContent = String(active.commentCount);
      }
    }
    const feedSt = findFeedStatus(statusId);
    if (feedSt && feedSt.isMine && comment && comment.userId !== S.me?.id) {
      if (!(active && active.id === statusId)) feedSt.commentCount = Number(feedSt.commentCount || 0) + 1;
      toast(isReply ? `${who} membalas komentar di status Anda` : `${who} mengomentari status Anda`);
      ncAdd({
        kind: 'status',
        title: 'Komentar status',
        body: `${who}: ${String(comment.body || '').slice(0, 80)}`,
        chatId: null,
        at: Date.now(),
      });
      if (sideTab === 'status') loadStatus().catch(() => {});
    }
  });

  socket.on('status:comment:deleted', ({ statusId, commentId } = {}) => {
    const active = currentStoryStatus();
    if (active && active.id === statusId) {
      S.storyComments = (S.storyComments || []).filter((c) => c.id !== commentId);
      if (S.storyCmtLoaded === active.id) active.commentCount = S.storyComments.length;
      else active.commentCount = Math.max(0, Number(active.commentCount || 1) - 1);
      renderStoryComments();
    }
    const feedSt = findFeedStatus(statusId);
    if (feedSt) feedSt.commentCount = Math.max(0, Number(feedSt.commentCount || 0) - 1);
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

  // calls
  socket.on('call:incoming', onCallIncoming);
  socket.on('call:signal', onCallSignal);
  socket.on('call:ended', onCallEnded);
  socket.on('call:missed', onCallMissed);
  socket.on('call:log', onCallLog);
}

/* ================= notifikasi (melayang + sistem + push offline) ================= */
const NOTIF = {
  sound: localStorage.getItem('wa_notif_sound') !== '0',
  vibrate: localStorage.getItem('wa_notif_vibrate') !== '0',
  sw: null,
  seen: new Map(),
};

function notifPerm() {
  return ('Notification' in window) ? Notification.permission : 'unsupported';
}

// jejak pesan sudah dinotifikasi -> penanda deduplikasi (5 menit, mencegah
// notifikasi ganda saat socket mengirim ulang / push & socket berbarengan)
const SEEN_TTL_MS = 300000;

function markSeen(id) {
  if (!id) return;
  NOTIF.seen.set(id, Date.now());
  if (NOTIF.seen.size > 240) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, t] of NOTIF.seen) if (t < cutoff) NOTIF.seen.delete(k);
  }
}

function seenRecently(id) {
  if (!id) return false;
  const t = NOTIF.seen.get(id);
  return !!t && Date.now() - t < SEEN_TTL_MS;
}

function vibrate(pattern) {
  if (!NOTIF.vibrate) return;
  try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* getar tidak tersedia */ }
}

function buildNotifPayload(m) {
  const chat = S.chats.find((c) => c.id === m.chatId);
  const isGroup = !!chat && chat.type === 'group';
  const sender = m.senderName || (chat ? chatTitle(chat) : 'Pesan baru');
  const kind = { image: '📷 Foto', video: '🎬 Video', audio: '🎵 Pesan suara', file: '📄 File', sticker: '🏷️ Stiker' }[m.type];
  let body;
  if (m.deleted) body = 'Pesan dihapus';
  else if (m.viewOnce) body = `📷 ${m.type === 'video' ? 'Video' : 'Foto'} sekali lihat`;
  else if (m.type === 'contact') {
    let n = 'Kontak';
    try { n = (JSON.parse(m.body) || {}).name || 'Kontak'; } catch { /* bukan JSON */ }
    body = `👤 ${n}`;
  } else if (m.body) body = kind ? `${kind} • ${m.body}` : m.body;
  else body = kind || 'Pesan baru';
  // privasi layar kunci: nama pengirim tetap di judul, isi pesan disembunyikan
  const hideBody = !!(S.me && S.me.privacy && S.me.privacy.hideNotifContent);
  return {
    title: isGroup ? `${sender} @ ${chatTitle(chat)}` : sender,
    body: hideBody ? 'Pesan baru' : body.slice(0, 160),
    hidePreview: hideBody,
    chatId: m.chatId,
    messageId: m.id,
    icon: m.senderAvatar || null,
    tag: `msg-${m.chatId}`,
  };
}

// dipanggil setiap pesan masuk lewat socket
function notify(m) {
  if (!m || !S.me || m.senderId === S.me.id) return;
  // deduplikasi: pengiriman ulang dari socket / push tidak boleh dobel
  if (m.id && seenRecently(m.id)) return;
  const payload = buildNotifPayload(m);
  const visible = document.visibilityState === 'visible';
  const focused = visible && document.hasFocus();
  const reading = focused && S.activeChatId === m.chatId;
  const chat = S.chats.find((c) => c.id === m.chatId);
  const muted = !!(chat && chat.muted);
  // riwayat pusat notifikasi selalu dicatat; yang sedang dibaca langsung ditandai
  ncAdd({ kind: 'message', title: payload.title, body: payload.body, chatId: payload.chatId, messageId: payload.messageId, icon: payload.icon, at: m.createdAt || Date.now(), read: reading });
  // chat dibisukan pengguna: hanya riwayat, tanpa bunyi/banner/notifikasi sistem
  if (muted) { if (m.id) markSeen(m.id); return; }
  if (reading) { if (m.id) markSeen(m.id); if (NOTIF.sound) beep('notif'); return; }
  if (!visible) {
    // luring: bunyikan di sini (showNotifCard tidak dipanggil)
    if (NOTIF.sound) notifSound();
    void showSystemNotif(payload);
    if (m.id) markSeen(m.id);
    return;
  }
  showNotifCard(payload); // sudah membunyikan notifikasi sendiri — jangan dobel
  if (m.id) markSeen(m.id);
  // jendela terbuka tapi sedang tidak fokus -> notifikasi sistem ala WhatsApp
  if (!focused) void showSystemNotif(payload);
}

// notifikasi push dari service worker (aplikasi tertutup / tab tersembunyi)
function notifyFromPush(data) {
  if (!data) return;
  if (data.type === 'call') { onCallPush(data); return; }
  if (!data.chatId) return;
  if (data.messageId && seenRecently(data.messageId)) return;
  const mutedChat = (S.chats || []).find((c) => c.id === data.chatId);
  if (mutedChat && mutedChat.muted) return; // server sudah menyaring push; jaga-jaga bila tiba bersamaan
  ncAdd({ kind: 'message', title: data.title, body: data.body, chatId: data.chatId, messageId: data.messageId, icon: data.icon, at: Date.now() });
  const visible = document.visibilityState === 'visible';
  const reading = S.activeChatId === data.chatId && document.hasFocus();
  if (visible) {
    if (reading) { if (data.messageId) markSeen(data.messageId); return; }
    showNotifCard(data);
  } else {
    void showSystemNotif(data);
  }
  // penandaan setelah tampil supaya kartu/sendiri tidak melewati deduplikasi
  if (data.messageId) markSeen(data.messageId);
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
  // silent = pemanggil sudah membunyikan bunyi sendiri (mis. bunyi khusus admin)
  if (NOTIF.sound && !data.silent) notifSound();
  vibrate([50, 30, 50]);
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
  if (NOTIF.vibrate) options.vibrate = data.type === 'call' ? [400, 200, 400, 200, 400] : [200, 100, 200];
  try {
    // aplikasi terpasang: tunggu SW aktif (beri batas waktu) sebelum memakainya
    const reg = NOTIF.sw || await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
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

// bunyi khusus panel admin (pendaftar baru, persetujuan, blokir):
// empat nada naik berbeda jelas dari notifikasi pesan biasa
function adminAlert() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    [[784, 0], [987.77, .1], [1318.5, .2], [1567.98, .3]].forEach(([freq, delay]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(.2, t + delay + .015);
      g.gain.exponentialRampToValueAtTime(.0001, t + delay + .17);
      o.start(t + delay);
      o.stop(t + delay + .21);
    });
    vibrate([40, 60, 40, 60, 80]);
  } catch { beep('out'); }
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
    await waitForSW(); // aplikasi terpasang: SW aktif dulu supaya dialog izin tampil
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
  const vib = $('notifVibrateToggle');
  if (snd) snd.checked = NOTIF.sound;
  if (vib) vib.checked = NOTIF.vibrate;
  if (!btn || !txt) return;
  const p = notifPerm();
  if (p === 'granted') { txt.textContent = 'Sistem • aktif (online & offline)'; btn.textContent = 'Aktif'; btn.disabled = true; }
  else if (p === 'denied') { txt.textContent = 'Sistem • diblokir oleh browser'; btn.textContent = 'Diblokir'; btn.disabled = true; }
  else if (p === 'unsupported') { txt.textContent = 'Sistem • tidak didukung browser ini'; btn.textContent = 'Tidak didukung'; btn.disabled = true; }
  else { txt.textContent = 'Sistem • izinkan agar muncul walau aplikasi ditutup'; btn.textContent = 'Aktifkan'; btn.disabled = false; }
}

/* ================= izin perangkat: bertahap, sesuai fitur yang dipakai =================
   mikrofon -> hanya saat panggilan dimulai; kamera -> hanya saat panggilan video;
   kontak -> hanya saat tombol "Pilih dari kontak perangkat" ditekan;
   notifikasi -> saat onboarding / tombol Aktifkan; latar belakang & layar kunci -> info + panduan. */
const PERM = { active: null };

/* Aplikasi terpasang (PWA / "Tambahkan ke Layar Utama"): izin notifikasi &
   kontak dikelola berbeda dari tab biasa — panduan menyesuaikan otomatis. */
function isInstalledPwa() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch { /* matchMedia tidak tersedia */ }
  try { if (navigator.standalone === true) return true; } catch { /* non-iOS */ }
  return false;
}

/* Aplikasi terpasang menuntut service worker sudah aktif sebelum dialog izin
   notifikasi berani tampil — tunggu dulu (beri batas waktu agar tidak menggantung). */
async function waitForSW(ms = 4000) {
  if (!('serviceWorker' in navigator)) return NOTIF.sw || null;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(NOTIF.sw || null), ms)),
    ]);
  } catch { return NOTIF.sw || null; }
}

function permSupported(kind) {
  if (kind === 'notifications' || kind === 'lockscreen') return 'Notification' in window;
  if (kind === 'microphone' || kind === 'camera') return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (kind === 'contacts') return !!(navigator.contacts && typeof navigator.contacts.select === 'function');
  if (kind === 'background') return 'serviceWorker' in navigator && 'PushManager' in window;
  return false;
}

// status izin: granted | denied | prompt | unsupported (tanpa memicu dialog)
async function permState(kind) {
  if (!permSupported(kind)) return 'unsupported';
  if (kind === 'notifications') return notifPerm();
  if (kind === 'background') {
    try {
      // .ready bisa menggantung bila pendaftaran service worker gagal -> beri batas waktu
      const reg = NOTIF.sw || await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (reg && reg.pushManager) {
        const sub = await reg.pushManager.getSubscription();
        if (sub && notifPerm() === 'granted') return 'granted';
      }
    } catch { /* langganan push belum ada */ }
    return notifPerm();
  }
  if (kind === 'lockscreen') return notifPerm();
  try {
    const st = await navigator.permissions.query({ name: kind });
    return st.state || 'prompt';
  } catch { return 'prompt'; } // browser tak mendukung pengecekan -> minta saat fitur dipakai
}

const PERM_STATE_DESC = {
  granted: 'Diizinkan oleh perangkat',
  denied: 'Diblokir — ikuti panduan untuk mengaktifkan',
  prompt: 'Belum diminta — akan muncul saat fitur dipakai',
  unsupported: 'Tidak didukung browser/perangkat ini',
};

function permBtnText(kind, state) {
  if (kind === 'lockscreen') return { text: 'Panduan', disabled: false };
  if (state === 'granted') return { text: 'Diizinkan', disabled: true };
  if (state === 'denied') return { text: 'Panduan', disabled: false };
  if (state === 'unsupported') return { text: 'Tidak didukung', disabled: true };
  return { text: 'Aktifkan', disabled: false };
}

// perbarui baris status di drawer Privasi & Notifikasi
async function refreshPermUI() {
  const rows = [
    ['microphone', 'permMicText', 'Dipinta saat memulai panggilan suara', 'btnPermMic'],
    ['camera', 'permCamText', 'Dipinta saat memulai panggilan video', 'btnPermCam'],
    ['contacts', 'permContactsText', 'Dipinta saat memilih kontak di Chat baru', 'btnPermContacts'],
    ['background', 'permBgText', 'Dikirim lewat push saat aplikasi ditutup', 'btnPermBg'],
    ['lockscreen', 'permLockText', 'Cara notifikasi tampil saat layar terkunci', 'btnPermLock'],
  ];
  for (const [kind, txtId, base, btnId] of rows) {
    const state = await permState(kind);
    const txt = $(txtId);
    const btn = $(btnId);
    if (txt) {
      if (kind === 'background' && state === 'granted') txt.textContent = 'Push aktif • notifikasi tetap masuk walau aplikasi ditutup';
      else if (kind === 'background') txt.textContent = state === 'denied' ? PERM_STATE_DESC.denied : 'Push belum aktif • buka panduan';
      else if (kind === 'lockscreen') txt.textContent = 'Nama pengirim & isi pesan sesuai pengaturan privasi';
      else txt.textContent = (state === 'prompt' || state === 'unsupported') ? base : PERM_STATE_DESC[state] || base;
    }
    if (btn) {
      const cfg = permBtnText(kind, state);
      btn.textContent = cfg.text;
      btn.disabled = cfg.disabled;
    }
  }
  syncNotifUI();
}

// minta satu izin (dipanggil saat fitur dipakai atau lewat tombol di Pengaturan)
async function requestPerm(kind) {
  if (kind === 'notifications' || kind === 'lockscreen') {
    if (!('Notification' in window)) return 'unsupported';
    await waitForSW(); // aplikasi terpasang: SW aktif dulu supaya dialog izin tampil
    const p = await Notification.requestPermission();
    if (p === 'granted') void subscribePush();
    return p;
  }
  if (kind === 'microphone' || kind === 'camera') {
    // hanya memeriksa izin: stream langsung dihentikan, tidak direkam/dikirim
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'camera' ? { video: { width: { ideal: 640 } }, audio: false } : { audio: true, video: false }
    );
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  }
  if (kind === 'background') { await enableNotif(); return notifPerm(); }
  return permState(kind);
}

async function tryRequestPerm(kind) {
  if (!permSupported(kind)) { toast('Fitur ini tidak didukung browser/perangkat Anda'); return 'unsupported'; }
  try {
    const state = await requestPerm(kind);
    if (state === 'granted') toast('Izin diberikan ✓');
    else if (state === 'denied') { toast('Izin diblokir — ikuti panduan untuk mengaktifkannya'); openPermHelp(kind); }
    return state;
  } catch (err) {
    const info = mediaErrorInfo(err, kind === 'contacts' ? 'contacts' : kind);
    toast(info.msg);
    if (info.perm) openPermHelp(kind);
    return 'denied';
  } finally {
    void refreshPermUI();
    syncNotifUI();
  }
}

// pesan ramah per jenis kegagalan izin/perangkat
function mediaErrorInfo(err, kind) {
  const name = (err && err.name) || '';
  const label = kind === 'camera' ? 'Kamera' : kind === 'contacts' ? 'Kontak' : kind === 'notifications' ? 'Notifikasi' : 'Mikrofon';
  const lower = label.toLowerCase();
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return { perm: true, kind, title: `${label} diblokir`, msg: `Izin ${lower} ditolak oleh browser` };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { perm: false, kind, title: `${label} tidak ditemukan`, msg: `${label} tidak ada di perangkat ini` };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { perm: false, kind, title: `${label} sedang dipakai`, msg: `${label} sedang digunakan aplikasi lain — tutup aplikasi itu lalu coba lagi` };
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return { perm: false, kind, title: 'Pengaturan tidak didukung', msg: `Perangkat tidak mendukung pengaturan ${lower}` };
  }
  if (name === 'TypeError' || name === 'NotSupportedError') {
    return { perm: false, kind, title: 'Tidak didukung', msg: `${label} hanya bisa diakses lewat HTTPS atau localhost` };
  }
  return { perm: false, kind, title: `Gagal mengakses ${lower}`, msg: (err && err.message) ? String(err.message) : 'Kesalahan tidak diketahui' };
}

const PERM_HELP = {
  microphone: {
    ico: '🎙️',
    title: 'Izin mikrofon',
    why: 'Mikrofon dibutuhkan agar lawan bicara dapat mendengar Anda. Izin hanya diminta ketika Anda menekan tombol panggil.',
    steps: [
      ['Chrome / Edge (Android & desktop)', 'Klik ikon gembok 🔒 di bilah alamat → Izin → Mikrofon → Izinkan, lalu muat ulang halaman.'],
      ['Safari (iPhone / iPad)', 'Pengaturan → Safari → Mikrofon → Izinkan; atau pilih "Izinkan" pada dialog saat panggilan dimulai.'],
      ['Firefox', 'Klik ikon gembok di bilah alamat → hapus pembatasan situs → muat ulang halaman.'],
    ],
  },
  camera: {
    ico: '📷',
    title: 'Izin kamera',
    why: 'Kamera hanya dipakai untuk panggilan video. Panggilan suara tidak pernah meminta kamera.',
    steps: [
      ['Chrome / Edge (Android & desktop)', 'Klik ikon gembok 🔒 di bilah alamat → Izin → Kamera → Izinkan, lalu muat ulang halaman.'],
      ['Safari (iPhone / iPad)', 'Pengaturan → Safari → Kamera → Izinkan; atau pilih "Izinkan" saat panggilan video dimulai.'],
      ['Firefox', 'Klik ikon gembok di bilah alamat → hapus pembatasan situs → muat ulang halaman.'],
    ],
  },
  notifications: {
    ico: '🔔',
    title: 'Izin notifikasi',
    why: 'Notifikasi membuat pesan & panggilan tetap terlihat walau aplikasi ditutup atau tab tersembunyi.',
    steps: [
      ['Chrome / Edge / Firefox (desktop & Android)', 'Klik ikon gembok 🔒 di bilah alamat → Izin → Notifikasi → Izinkan.'],
      ['Safari (iPhone / iPad)', 'Pengaturan → Safari → Notifikasi → Izinkan, lalu muat ulang halaman.'],
      ['Android (aplikasi terpasang)', 'Pengaturan perangkat → Aplikasi → RTC-Core → Notifikasi → aktifkan.'],
    ],
  },
  contacts: {
    ico: '👥',
    title: 'Izin kontak perangkat',
    why: 'Kontak hanya dibaca saat Anda menekan "Pilih dari kontak perangkat" di Chat baru — tidak pernah diam-diam.',
    steps: [
      ['Chrome / Edge (Android)', 'Ketuk "Pilih dari kontak perangkat" lalu pilih Izinkan pada dialog sistem.'],
      ['Browser lain (desktop/iOS)', 'Contact Picker API belum didukung — gunakan pencarian manual berdasarkan email atau nama.'],
      ['Jika sebelumnya diblokir', 'Buka Pengaturan situs perangkat → Kontak → Izinkan, lalu muat ulang halaman.'],
    ],
  },
  background: {
    ico: '📲',
    title: 'Notifikasi latar belakang',
    why: 'Push service memberi tahu saat ada pesan/panggilan walau aplikasi ditutup. Izin notifikasi harus aktif lebih dulu.',
    steps: [
      ['Aktifkan notifikasi', 'Tekan tombol Aktifkan pada baris "Notifikasi sistem" di atas, lalu izinkan notifikasi.'],
      ['Chrome (Android)', 'Pastikan "Izinkan notifikasi" aktif dan penghemat baterai tidak mematikan situs ini.'],
      ['Safari (iPhone / iPad)', 'Tambahkan ke Layar Utama (Share → Tambahkan ke Layar Utama) agar notifikasi berjalan penuh.'],
    ],
  },
  lockscreen: {
    ico: '🔒',
    title: 'Notifikasi layar kunci',
    why: 'Saat layar terkunci, notifikasi tetap menampilkan nama pengirim. Isi pesan mengikuti pengaturan "Sembunyikan isi pesan".',
    steps: [
      ['Sembunyikan isi pesan', 'Aktifkan sakelar "Sembunyikan isi pesan" di bagian Layar kunci & latar belakang.'],
      ['Android', 'Pengaturan perangkat → Notifikasi → aplikasi ini → "Sembunyikan konten saat terkunci".'],
      ['iPhone / iPad', 'Pengaturan → Notifikasi → aplikasi ini → Tampilan → "Saat Terkunci".'],
      ['Chrome (desktop)', 'Pengaturan sistem notifikasi Windows/macOS mengatur isi notifikasi yang tampil.'],
    ],
  },
};

const PERM_STATE_TEXT = {
  granted: 'diizinkan ✓',
  denied: 'diblokir ✗',
  prompt: 'menunggu izin',
  unsupported: 'tidak didukung',
};

async function openPermHelp(kind) {
  const info = PERM_HELP[kind];
  if (!info || !$('permHelpModal')) return;
  PERM.active = kind;
  $('permHelpIco').textContent = info.ico;
  $('permHelpTitle').textContent = info.title;
  $('permHelpWhy').textContent = info.why;
  const steps = $('permHelpSteps');
  const installed = isInstalledPwa();
  const render = (state) => {
    const list = info.steps.slice();
    if (installed) {
      // aplikasi terpasang tidak punya bilah alamat -> arahkan ke izin aplikasi sistem
      list.push(['Dibuka sebagai aplikasi (layar utama)',
        'Karena ini aplikasi terpasang, buka Pengaturan perangkat → Aplikasi → RTC-Core → Izin & Notifikasi (setelan situs di bilah alamat tidak ada di sini). Bila perlu, hapus aplikasi lalu pasang ulang dari menu browser.']);
    }
    steps.innerHTML = list.map(([plat, text]) => `<li><strong>${esc(plat)}</strong> — ${esc(text)}</li>`).join('')
      + `<li><strong>Status saat ini</strong> — ${PERM_STATE_TEXT[state] || state}.</li>`;
  };
  render('memeriksa...');
  $('permHelpModal').classList.remove('hidden');
  const state = await permState(kind).catch(() => 'prompt');
  if (PERM.active === kind) render(state);
}

function closePermHelp() {
  $('permHelpModal').classList.add('hidden');
  PERM.active = null;
}

document.querySelectorAll('[data-perm]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.perm;
    if (btn.disabled) return;
    if (kind === 'lockscreen') { openPermHelp(kind); return; }
    const state = await permState(kind);
    if (state === 'denied') { openPermHelp(kind); return; }
    await tryRequestPerm(kind);
  });
});
$('btnPermHelpClose').addEventListener('click', closePermHelp);
$('btnPermHelpRetry').addEventListener('click', () => {
  const kind = PERM.active;
  closePermHelp();
  if (kind) void tryRequestPerm(kind);
});
$('notifVibrateToggle').addEventListener('change', (e) => {
  NOTIF.vibrate = !!e.target.checked;
  try { localStorage.setItem('wa_notif_vibrate', NOTIF.vibrate ? '1' : '0'); } catch { /* storage diblokir */ }
  setSWPref('vibrate', NOTIF.vibrate); // notifikasi saat aplikasi tutup ikut mengikuti
  if (!NOTIF.vibrate) { try { navigator.vibrate && navigator.vibrate(0); } catch { /* noop */ } }
});

/* ---------- pengantar izin (sekali di perangkat, tanpa meminta mikrofon/kamera) ---------- */
function maybeShowPermIntro() {
  try { if (localStorage.getItem('wa_perm_intro_v1')) return; } catch { /* storage diblokir */ }
  const btn = $('btnPermIntroNotif');
  if (btn) {
    const granted = notifPerm() === 'granted';
    btn.textContent = granted ? 'Lanjutkan' : 'Aktifkan notifikasi';
  }
  $('permIntroModal').classList.remove('hidden');
}

function closePermIntro() {
  $('permIntroModal').classList.add('hidden');
  try { localStorage.setItem('wa_perm_intro_v1', '1'); } catch { /* storage diblokir */ }
}

$('btnPermIntroSkip').addEventListener('click', closePermIntro);
$('btnPermIntroNotif').addEventListener('click', () => {
  closePermIntro();
  if (notifPerm() !== 'granted') void tryRequestPerm('notifications');
});

/* ---------- lencana aplikasi (badge jumlah belum dibaca) ---------- */
function updateAppBadge() {
  let n = 0;
  for (const c of S.chats || []) n += Number(c.unread) || 0;
  try {
    if ('setAppBadge' in navigator) {
      if (n > 0) { const p = navigator.setAppBadge(n); if (p && p.catch) p.catch(() => {}); }
      else if (navigator.clearAppBadge) { const p = navigator.clearAppBadge(); if (p && p.catch) p.catch(() => {}); }
    }
  } catch { /* badge tidak didukung */ }
  // diteruskan ke service worker supaya lencana ikut terbawa saat tab ditutup
  try { NOTIF.sw && NOTIF.sw.postMessage({ type: 'wa-badge', n }); } catch { /* noop */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') updateAppBadge();
});

/* preferensi ditulis ke IndexedDB (dipakai service worker saat notifikasi
   dibuat tanpa ada jendela terbuka — localStorage tidak terbaca di sana) */
function setSWPref(key, value) {
  try {
    const req = indexedDB.open('rtc-prefs', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => {
      try { req.result.transaction('kv', 'readwrite').objectStore('kv').put(value, key); } catch { /* noop */ }
      try { req.result.close(); } catch { /* noop */ }
    };
  } catch { /* IndexedDB tidak tersedia */ }
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
    ref: item.ref || null,
    icon: item.icon || null,
    at: item.at || Date.now(),
    read: !!item.read,
  };
  if (entry.messageId && NC.items.some((i) => i.messageId === entry.messageId)) return;
  if (entry.ref && NC.items.some((i) => i.ref === entry.ref)) return;
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
    : `<span>${esc(i.kind === 'status' ? '◉' : i.kind === 'system' ? '★' : i.kind === 'admin' ? '⚑' : i.kind === 'call' ? '☎' : (i.title || '?').charAt(0).toUpperCase())}</span>`;
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
  else if (item.kind === 'admin' && S.me && S.me.role === 'admin') openAdminPanel();
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
$('btnBotMention').addEventListener('click', insertBotMention);
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
  const reply = S.replyTo;

  if (S.pendingFile) {
    const file = S.pendingFile;
    const viewOnce = S.viewOncePending;
    S.pendingFile = null;
    clearAttachPreview();
    await uploadAndSend(file, text, chatId, { viewOnce, replyTo: reply });
    ta.value = '';
    ta.style.height = 'auto';
    updateComposerButtons();
    clearReply();
    return;
  }

  if (!text) { if (reply) toast('Ketik pesan untuk membalas'); return; }
  ta.value = '';
  ta.style.height = 'auto';
  updateComposerButtons();
  sendViaSocket({ chatId, type: 'text', body: text, replyTo: reply ? reply.id : undefined });
  clearReply();
}

/* buka / buat chat langsung dengan pengguna tertentu (dipakai kartu kontak & ?u=) */
async function openChatWithUser(userId) {
  if (!userId || userId === (S.me && S.me.id)) { toast('Tidak bisa membuka chat dengan diri sendiri di sini'); return; }
  try {
    const data = await api('/api/chats/direct', { method: 'POST', body: { peerId: userId } });
    await loadChats();
    openChat(data.chat.id);
    closeDrawers();
  } catch (err) { toast(err.message); }
}

/* kirim kartu kontak ke chat aktif (body = JSON kontak) */
function sendContact(contact) {
  const chatId = S.activeChatId;
  if (!chatId || !contact || !contact.userId) return;
  const payload = {
    userId: contact.userId,
    name: contact.name || null,
    email: contact.email || null,
    avatar: contact.avatar || null,
  };
  sendViaSocket({ chatId, type: 'contact', body: JSON.stringify(payload) });
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
  // bubble optimis supaya pesan langsung terlihat — penting saat koneksi
  // sedang pulih, socket.io menahan emit sampai tersambung lagi
  let tempId = localId || null;
  if (!tempId && payload.type === 'text' && payload.chatId) {
    tempId = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const rep = payload.replyTo
      ? (S.messages[payload.chatId] || []).find((x) => x.id === payload.replyTo)
      : null;
    const tmp = {
      id: tempId, chatId: payload.chatId, senderId: S.me.id, type: 'text',
      body: payload.body || '', createdAt: Date.now(), status: 'sending',
      replyTo: payload.replyTo || null,
      replyPreview: rep ? {
        senderId: rep.senderId,
        senderName: rep.senderId === S.me.id ? 'Anda' : (rep.senderName || null),
        type: rep.type, body: String(rep.body || '').slice(0, 140),
        viewOnce: !!rep.viewOnce, deleted: !!rep.deleted,
      } : null,
    };
    const box0 = S.messages[payload.chatId] || (S.messages[payload.chatId] = []);
    box0.push(tmp);
    if (S.activeChatId === payload.chatId) { appendMessage(tmp); scrollToBottom(false); }
    renderChatList();
  }
  S.socket.emit('message:send', payload, (res) => {
    if (!res?.ok) {
      toast(res?.error || 'Gagal mengirim pesan');
      if (tempId && S.messages[payload.chatId]) removeLocalMessage(payload.chatId, tempId);
      return;
    }
    const arr = S.messages[payload.chatId] || (S.messages[payload.chatId] = []);
    if (tempId) removeLocalMessage(payload.chatId, tempId);
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

/* unggah potongan (chunked) ke database: melewati batas 4,5MB per request.
   File dipotong menjadi bagian <chunkSize>, masing-masing dikirim sebagai
   octet-stream mentah, lalu disatukan ulang oleh server (HTTP Range). */
function putDbChunk(id, idx, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/storage/dbfiles/${id}/chunk/${idx}`);
    xhr.setRequestHeader('Authorization', `Bearer ${S.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Gagal mengunggah potongan'));
      } catch { reject(new Error('Gagal mengunggah potongan')); }
    };
    xhr.onerror = () => reject(new Error('Gagal terhubung ke server'));
    xhr.send(blob);
  });
}

async function uploadFileChunked(file, onProgress = () => {}) {
  const init = await api('/api/storage/dbfiles/init', {
    method: 'POST',
    body: { name: file.name, size: file.size, mime: file.type },
  });
  const { id, chunkSize, totalChunks } = init;
  let sent = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    await putDbChunk(id, i, blob);
    sent += blob.size;
    if (typeof onProgress === 'function') onProgress(sent / file.size);
  }
  const done = await api(`/api/storage/dbfiles/${id}/complete`, { method: 'POST' });
  return { url: done.url, name: file.name, size: file.size, mime: file.type, type: done.type };
}

/* Unggah multipart lewat server. Batas permintaan di hosting 4,5MB, di lokal 2GB. */
function uploadViaServer(file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${S.token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && typeof onProgress === 'function') onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else { const err = new Error(data.error || 'Upload gagal'); err.status = xhr.status; reject(err); }
      } catch { const err = new Error('Upload gagal'); err.status = xhr.status; reject(err); }
    };
    xhr.onerror = () => { const err = new Error('Gagal terhubung ke server'); err.status = 0; reject(err); };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

// batas body permintaan Vercel (4,5MB) -> multipart ditahan lebih rendah di server
const HOSTED_MULTIPART_LIMIT = 4 * 1024 * 1024;

async function uploadFile(file, onProgress = () => {}) {
  // di hosting file dikirim langsung ke Blob (lolos batas 4,5MB per request);
  // bila endpoint tanda tangan tidak ada (mode lokal) -> upload lewat server
  let sign = null;
  let signErr = null;
  try {
    sign = await api('/api/uploads/sign', {
      method: 'POST',
      body: { name: file.name, size: file.size, mime: file.type },
    });
  } catch (err) { signErr = err; }

  if (sign && sign.presignedUrl) {
    try {
      const stored = await putPresigned(sign.presignedUrl, file, onProgress);
      return { url: stored.url, name: sign.name, size: file.size, mime: sign.mime, type: sign.type };
    } catch {
      // Blob mati/tangguh -> unggah potongan ke database (ukuran berapa pun)
      return uploadFileChunked(file, onProgress);
    }
  }

  // 501 = hosting tanpa Blob (mode lokal, unggah ke disk 2GB).
  // Selain itu tanda tangan gagal (mis. store disuspend): jalur multipart
  // dibatasi ~4MB sehingga file besar wajib lewat potongan.
  const localNoBlob = !!signErr && signErr.status === 501;
  if (!localNoBlob && file.size > HOSTED_MULTIPART_LIMIT) {
    return uploadFileChunked(file, onProgress);
  }

  try {
    return await uploadViaServer(file, onProgress);
  } catch (err) {
    // server menolak ukuran / koneksi putus -> cadangan terakhir lewat potongan
    const st = err && err.status;
    if (!st || st === 413 || st >= 500) return uploadFileChunked(file, onProgress);
    throw err;
  }
}

async function uploadAndSend(file, text, chatId, opts = {}) {
  const localId = 'local-' + Date.now();
  const rep = opts.replyTo || null;
  const tmp = {
    id: localId, chatId, senderId: S.me.id,
    type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file',
    body: text || '', mediaUrl: null, mediaName: file.name, mediaSize: file.size,
    mime: file.type, createdAt: Date.now(), status: 'sending', _progress: 0,
    viewOnce: !!opts.viewOnce, duration: opts.duration || 0,
    replyTo: rep ? rep.id : null,
    replyPreview: rep ? {
      senderId: rep.senderId,
      senderName: rep.senderId === (S.me && S.me.id) ? 'Anda' : (rep.senderName || null),
      type: rep.type, body: String(rep.body || '').slice(0, 140),
      viewOnce: !!rep.viewOnce, deleted: !!rep.deleted,
    } : null,
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
      replyTo: rep ? rep.id : undefined,
    }, localId); // beep('out') sudah dibunyikan di dalam sendViaSocket
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
    if (kind === 'sticker') {
      S.viewOncePending = false;
      toggleStickerPanel();
      return;
    }
    if (kind === 'viewonce') {
      S.viewOncePending = true;
      input.accept = 'image/*,video/*';
      input.value = '';
      input.click();
      return;
    }
    if (kind === 'contact') {
      // chat pribadi -> bagikan kontak lawan bicara; grup -> bagikan kontak Anda
      const chat = currentChat();
      if (!chat) return;
      if (chat.type === 'group') {
        sendContact({ userId: S.me.id, name: S.me.name, email: S.me.email, avatar: S.me.avatar });
      } else if (chat.peer && chat.peer.id) {
        sendContact({ userId: chat.peer.id, name: chat.peer.name, email: chat.peer.email, avatar: chat.peer.avatar });
      } else {
        toast('Kontak lawan bicara belum dimuat');
      }
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
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (S.viewOncePending && !isImage && !isVideo) {
    toast('Sekali lihat hanya untuk gambar atau video');
    S.viewOncePending = false;
    return;
  }
  S.pendingFile = file;
  const info = $('attachInfo');
  let preview = '';
  if (isImage || isVideo) {
    if (S.pendingFileUrl) URL.revokeObjectURL(S.pendingFileUrl);
    S.pendingFileUrl = URL.createObjectURL(file);
    preview = isVideo
      ? `<video src="${S.pendingFileUrl}" muted playsinline></video>`
      : `<img src="${S.pendingFileUrl}" alt="">`;
  }
  info.innerHTML = `<strong>${esc(file.name)}</strong><small>${esc(fmtSize(file.size))} • ${S.viewOncePending ? 'sekali lihat • ' : ''}siap dikirim</small>`;
  const box = $('attachPreview');
  const oldMedia = box.querySelector('img, video');
  if (oldMedia) oldMedia.remove();
  box.insertAdjacentHTML('afterbegin', preview);
  box.classList.toggle('view-once', S.viewOncePending);
  box.classList.remove('hidden');
});

$('btnCancelAttach').addEventListener('click', clearAttachPreview);
function clearAttachPreview() {
  S.pendingFile = null;
  S.viewOncePending = false;
  if (S.pendingFileUrl) { URL.revokeObjectURL(S.pendingFileUrl); S.pendingFileUrl = null; }
  $('attachPreview').classList.add('hidden');
  $('attachPreview').classList.remove('view-once');
  $('fileInput').value = '';
}

/* ================= pemilih stiker & emot khusus ================= */
let _stickerData = null;      // cache katalog (sudah difilter paket)
let _stickerActivePack = null;

function closeStickerPanel() {
  const p = $('stickerPanel');
  if (p) p.classList.add('hidden');
}

async function toggleStickerPanel() {
  const p = $('stickerPanel');
  const opening = p.classList.contains('hidden');
  p.classList.toggle('hidden', !opening);
  if (!opening) return;
  try {
    if (!_stickerData) _stickerData = await api('/api/stickers');
    renderStickerPicker();
  } catch (err) {
    p.classList.add('hidden');
    toast(err.message || 'Gagal memuat stiker');
  }
}

function renderStickerPicker() {
  const data = _stickerData;
  if (!data || !data.packs || !data.packs.length) {
    $('stickerTabs').innerHTML = '';
    $('stickerGrid').innerHTML = '<div class="sticker-empty">Belum ada stiker terbuka untuk paket Anda.</div>';
    return;
  }
  if (!_stickerActivePack || !data.packs.some((p) => p.id === _stickerActivePack)) {
    _stickerActivePack = data.packs[0].id;
  }
  $('stickerTabs').innerHTML = data.packs.map((p) => `
    <button class="sticker-tab${p.id === _stickerActivePack ? ' active' : ''}" data-pack="${esc(p.id)}">${esc(p.label)}</button>
  `).join('');
  const pack = data.packs.find((p) => p.id === _stickerActivePack) || data.packs[0];
  $('stickerGrid').innerHTML = pack.stickers.map((s) => `
    <button class="sticker-cell" data-sticker="${esc(s.id)}" title="${esc(s.label)}">
      <img src="/api/stickers/${encodeURIComponent(s.id)}.svg" alt="${esc(s.label)}" loading="lazy">
    </button>
  `).join('');
}

$('stickerTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.sticker-tab');
  if (!t) return;
  _stickerActivePack = t.dataset.pack;
  renderStickerPicker();
});

$('stickerGrid').addEventListener('click', (e) => {
  const c = e.target.closest('.sticker-cell');
  if (!c) return;
  sendSticker(c.dataset.sticker);
});

async function sendSticker(id) {
  const chatId = S.activeChatId;
  if (!chatId) return;
  const data = _stickerData;
  let label = id;
  if (data && data.packs) {
    for (const p of data.packs) {
      const s = p.stickers.find((x) => x.id === id);
      if (s) { label = s.label; break; }
    }
  }
  closeStickerPanel();
  const url = `/api/stickers/${encodeURIComponent(id)}.svg`;
  const reply = S.replyTo ? S.replyTo.id : undefined;
  sendViaSocket({ chatId, type: 'sticker', body: label, media: { url }, replyTo: reply });
  clearReply();
}

document.addEventListener('click', () => closeStickerPanel());
$('stickerPanel').addEventListener('click', (e) => e.stopPropagation());
$('btnAttach').addEventListener('click', (e) => e.stopPropagation());

/* ================= drawer manager ================= */
const DRAWERS = ['menuDrawer', 'newChatDrawer', 'profileDrawer', 'wallpaperDrawer', 'homeBgDrawer', 'contactDrawer',
  'groupDrawer', 'groupInfoDrawer', 'statusComposer', 'privacyDrawer', 'adminDrawer', 'notifDrawer', 'botCatDrawer',
  'planDrawer', 'inviteDrawer', 'aboutDrawer', 'storageDrawer', 'themeDrawer', 'contactsDrawer', 'terminalDrawer'];

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

/* Kontak perangkat (Contact Picker API): izin hanya diminta ketika tombol ini
   ditekan — tidak pernah diam-diam saat aplikasi dibuka. */
$('btnPickContact').addEventListener('click', async () => {
  if (!permSupported('contacts')) {
    toast('Pemilih kontak tidak didukung browser ini — cari manual berdasarkan email/nama');
    openPermHelp('contacts');
    return;
  }
  let picked;
  try {
    picked = await navigator.contacts.select(['name', 'email', 'tel'], { multiple: false });
  } catch {
    toast('Kontak tidak dapat diakses');
    openPermHelp('contacts');
    return;
  }
  const c = (picked && picked[0]) || null;
  if (!c) return;
  void refreshPermUI(); // izin baru saja dipakai -> perbarui baris status
  const email = (c.email && c.email[0]) || '';
  const name = (c.name && c.name[0]) || '';
  const q = email || name;
  if (!q) { toast('Kontak tidak memiliki email atau nama yang bisa dicari'); return; }
  $('userSearchInput').value = q;
  clearTimeout(searchTimer);
  await searchUsers();
  if (!email) toast(`Mencari "${name}" — cocokkan hasilnya dengan email pengguna`);
});

/* ================= tema: mode +10 warna (aksen) ================= */
const THEME_ACCENTS = [
  { id: 'teal',   name: 'Teal',   grad: '#00a884,#008069' },
  { id: 'biru',   name: 'Biru',   grad: '#1b8fd4,#1565c0' },
  { id: 'ungu',   name: 'Ungu',   grad: '#7c5cff,#6438e0' },
  { id: 'nila',   name: 'Nila',   grad: '#5b54e6,#4338ca' },
  { id: 'toska',  name: 'Toska',  grad: '#0891b2,#0e7490' },
  { id: 'hijau',  name: 'Hijau',  grad: '#16a34a,#15803d' },
  { id: 'mawar',  name: 'Mawar',  grad: '#e11d48,#be123c' },
  { id: 'oranye', name: 'Oranye', grad: '#ea580c,#c2410c' },
  { id: 'emas',   name: 'Emas',   grad: '#d97706,#b45309' },
  { id: 'batu',   name: 'Batu',   grad: '#475569,#334155' },
];

function themeNow() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function accentNow() {
  return document.documentElement.getAttribute('data-accent') || 'teal';
}
function accentName(id) {
  const a = THEME_ACCENTS.find((x) => x.id === id);
  return a ? a.name : 'Teal';
}

function renderTheme() {
  const t = themeNow();
  const label = $('themeLabel');
  const ico = $('themeIco');
  if (label) label.textContent = `${t === 'dark' ? 'Mode gelap' : 'Mode terang'} · Warna ${accentName(accentNow())}`;
  const use = ico && ico.querySelector('use');
  if (use) use.setAttribute('href', t === 'dark' ? '#ic-sun' : '#ic-moon');
  const toggle = $('themeModeToggle');
  if (toggle) toggle.checked = t === 'dark';
  const desc = $('tmModeDesc');
  if (desc) desc.textContent = t === 'dark' ? 'Mode gelap aktif' : 'Mode terang aktif';
}

function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('wa_theme', theme); } catch (e) { /* storage diblokir */ }
  renderTheme();
}

function applyAccent(id) {
  const accent = THEME_ACCENTS.some((a) => a.id === id) ? id : 'mawar';
  document.documentElement.setAttribute('data-accent', accent);
  try { localStorage.setItem('wa_accent', accent); } catch (e) { /* storage diblokir */ }
  document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.accent === accent));
  renderTheme();
}

function buildThemeGrid() {
  const grid = $('themeGrid');
  if (!grid) return;
  grid.innerHTML = THEME_ACCENTS.map((a) => `
    <button class="theme-swatch" data-accent="${a.id}" title="${a.name}" style="background:linear-gradient(145deg, ${a.grad})" aria-label="Warna ${a.name}">
      <span class="dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
      <span class="name">${a.name}</span>
    </button>`).join('');
  grid.querySelectorAll('.theme-swatch').forEach((sw) => {
    sw.addEventListener('click', () => applyAccent(sw.dataset.accent));
  });
}

function openThemeDrawer() {
  buildThemeGrid();
  applyAccent(accentNow());
  renderTheme();
  openDrawer('themeDrawer');
}

/* muat tema tersimpan lalu bangun pemilih warna */
(function initTheme() {
  let savedTheme = 'dark';
  let savedAccent = 'mawar';
  try {
    savedTheme = localStorage.getItem('wa_theme') || 'dark';
    savedAccent = localStorage.getItem('wa_accent') || 'mawar';
  } catch (e) { /* storage diblokir */ }
  applyTheme(savedTheme);
  applyAccent(savedAccent);
})();

const themeModeEl = $('themeModeToggle');
if (themeModeEl) themeModeEl.addEventListener('change', () => applyTheme(themeModeEl.checked ? 'dark' : 'light'));
const btnCloseTheme = $('btnCloseTheme');
if (btnCloseTheme) btnCloseTheme.addEventListener('click', closeDrawers);

/* ================= kontak: daftar kontak & email tersimpan ================= */
let contactsOffset = 0;
let contactsHasMore = false;
let contactsQuery = '';
let contactsLoading = false;
let contactsSearchTimer;

function contactRow(u) {
  const email = u.email || 'Email disembunyikan';
  return `
    <div class="chat-item" data-cuser="${u.id}">
      <div class="avatar"></div>
      <div class="chat-item-body">
        <div class="chat-item-top"><strong>${esc(u.name)}${badge(u.verified)}</strong></div>
        <div class="chat-item-bottom"><div class="chat-item-preview">${esc(email)}</div></div>
      </div>
    </div>`;
}

async function loadContacts(reset) {
  if (contactsLoading) return;
  if (reset) { contactsOffset = 0; contactsHasMore = true; }
  if (!contactsHasMore && !reset) return;
  contactsLoading = true;
  const list = $('contactsList');
  const moreBtn = $('contactsMore');
  if (reset) list.innerHTML = '<div class="empty-state">Memuat kontak...</div>';
  try {
    const q = encodeURIComponent(contactsQuery);
    const data = await api(`/api/contacts?q=${q}&offset=${contactsOffset}&limit=40`);
    const users = data.users || [];
    contactsHasMore = !!data.hasMore;
    contactsOffset += users.length;
    if (reset && !users.length) {
      list.innerHTML = '<div class="empty-state">Belum ada kontak lain yang terdaftar.</div>';
    } else {
      if (reset) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', users.map(contactRow).join(''));
      users.forEach((u) => {
        const el = list.querySelector(`[data-cuser="${u.id}"] .avatar`);
        if (el) setAvatar(el, u);
      });
      list.querySelectorAll('[data-cuser]').forEach((el) => {
        if (el.dataset.bound) return;
        el.dataset.bound = '1';
        el.addEventListener('click', () => startDirect(el.dataset.cuser));
      });
    }
    if (moreBtn) moreBtn.classList.toggle('hidden', !contactsHasMore);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  } finally {
    contactsLoading = false;
  }
}

function openContacts() {
  openDrawer('contactsDrawer');
  contactsQuery = '';
  const inp = $('contactsSearch');
  if (inp) inp.value = '';
  loadContacts(true);
  if (inp) inp.focus();
}

(function initContactsUI() {
  const inp = $('contactsSearch');
  if (inp) inp.addEventListener('input', () => {
    clearTimeout(contactsSearchTimer);
    contactsSearchTimer = setTimeout(() => {
      contactsQuery = inp.value.trim();
      loadContacts(true);
    }, 320);
  });
  const moreBtn = $('contactsMore');
  if (moreBtn) moreBtn.addEventListener('click', () => loadContacts(false));
  const btnClose = $('btnCloseContacts');
  if (btnClose) btnClose.addEventListener('click', closeDrawers);
})();

/* ================= terminal mini (admin / permanen / bisnis) ================= */
let termAccess = null;

async function loadTermAccess() {
  try {
    termAccess = await api('/api/terminal/access');
  } catch (e) {
    termAccess = { allowed: false };
  }
  const menu = $('menuTerminal');
  if (menu) menu.classList.toggle('hidden', !(termAccess && termAccess.allowed));
}

function termRenderQuota() {
  const q = termAccess;
  const el = $('termQuota');
  if (el) {
    if (!q || !q.allowed) el.textContent = '';
    else if (q.isAdmin) el.textContent = 'Admin · tanpa limit';
    else el.textContent = `${q.plan} · ${q.used}/${q.limit}`;
  }
  const adm = $('termAdmin');
  if (adm) adm.classList.toggle('hidden', !(q && q.isAdmin));
  if (q && q.isAdmin && q.limits) {
    const p = $('termLimPerm');
    const b = $('termLimBiz');
    if (p) p.value = q.limits.permanen;
    if (b) b.value = q.limits.bisnis;
  }
  if (q && q.isAdmin) {
    const lb = $('termLinkBase');
    if (lb && q.nftokenLink) lb.value = q.nftokenLink;
  }
}

function termAppend(kind, text) {
  const out = $('termOut');
  if (!out) return null;
  const div = document.createElement('div');
  div.className = 'term-line term-' + kind;
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  return div;
}

async function termRun(cmd) {
  cmd = String(cmd || '').trim();
  if (!cmd) return;
  const input = $('termInput');
  if (input) input.value = '';
  termAppend('cmd', '$ ' + cmd);
  if (cmd.toLowerCase() === 'clear') {
    const out = $('termOut');
    if (out) out.innerHTML = '';
    return;
  }
  const loading = termAppend('res', '… memproses');
  try {
    const data = await api('/api/terminal/run', { method: 'POST', body: { cmd } });
    if (loading) loading.remove();
    if (data.clear) {
      const out = $('termOut');
      if (out) out.innerHTML = '';
      return;
    }
    termAppend(data.error ? 'err' : 'res', data.error ? '✕ ' + data.error : (data.output || '(tanpa keluaran)'));
    termAccess = data;
    termRenderQuota();
  } catch (e) {
    if (loading) loading.remove();
    termAppend('err', '✕ ' + e.message);
    if (e.status === 429 || e.status === 403) loadTermAccess();
  }
}

function openTerminal() {
  openDrawer('terminalDrawer');
  const out = $('termOut');
  if (out && !out.childElementCount) {
    termAppend('res', 'Terminal Mini — RTC-Core');
    termAppend('res', 'Verif AM · Parse NIK · Generate NFToken');
    termAppend('res', 'Ketik "menu" untuk daftar perintah.');
    termAppend('res', '────────────────────────');
  }
  termRenderQuota();
  if (!termAccess) loadTermAccess().then(termRenderQuota);
  const inp = $('termInput');
  if (inp) inp.focus();
}

(function initTerminalUI() {
  const form = $('termForm');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    termRun(($('termInput') || {}).value);
  });
  const quick = $('termQuick');
  if (quick) quick.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => termRun(b.dataset.cmd));
  });
  const btnClose = $('btnCloseTerminal');
  if (btnClose) btnClose.addEventListener('click', closeDrawers);
  const save = $('termSaveLimits');
  if (save) save.addEventListener('click', async () => {
    const permanen = Number(($('termLimPerm') || {}).value);
    const bisnis = Number(($('termLimBiz') || {}).value);
    const base = String(($('termLinkBase') || {}).value || '').trim();
    try {
      const data = await api('/api/terminal/limits', { method: 'POST', body: { permanen, bisnis } });
      if (data && data.limits) {
        termAccess = { ...(termAccess || {}), limits: data.limits };
      }
      if (base) {
        const lb = await api('/api/terminal/nftoken-link', { method: 'POST', body: { base } });
        if (lb && lb.base) termAccess = { ...(termAccess || {}), nftokenLink: lb.base };
      }
      termRenderQuota();
      toast('Pengaturan terminal disimpan.');
    } catch (e) { toast(e.message); }
  });
})();

/* ================= menu drawer ================= */
document.querySelectorAll('.menu-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.menu;
    if (action === 'profile') openProfile();
    else if (action === 'plans') openPlanDrawer();
    else if (action === 'storage') openStorageDrawer();
    else if (action === 'invite') openInviteDrawer();
    else if (action === 'wallpaper') openWallpaper();
    else if (action === 'homebg') openHomeBg();
    else if (action === 'theme') openThemeDrawer();
    else if (action === 'contacts') openContacts();
    else if (action === 'terminal') openTerminal();
    else if (action === 'privacy') openPrivacy();
    else if (action === 'bots') openBotCatalog();
    else if (action === 'toolsw') { closeDrawers(); window.location.href = '/tools.html'; }
    else if (action === 'admin') openAdminPanel();
    else if (action === 'about') openAboutDrawer();
    else if (action === 'logout') {
      closeDrawers();
      logout();
    }
  });
});

/* tautan dari halaman /tools.html (/#plans) membuka drawer paket sekali saat ini */
if (location.hash === '#plans' && S.token) {
  setTimeout(() => { try { openPlanDrawer(); } catch (e) { /* drawer belum siap */ } }, 600);
}

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
      <p class="bc-hint">Pilih paket lalu aktifkan lewat admin RTC-Core. Begitu aktif, menu Daftar Bot langsung terbuka.</p>
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

// format byte -> teks ringkas (KB/MB/GB/TB)
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1000 ** 4) return `${(n / 1000 ** 4).toFixed(n % 1000 ** 4 ? 1 : 0)} TB`;
  if (n >= 1000 ** 3) return `${(n / 1000 ** 3).toFixed(n >= 10 * 1000 ** 3 ? 0 : 1)} GB`;
  if (n >= 1000 ** 2) return `${(n / 1000 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}

// paket yang berhak centang biru (Harian & Mingguan tidak)
const VERIFIED_PLANS = new Set(['bulanan', 'bisnis', 'reseller-bulanan', 'permanen']);

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
  // centang biru hanya untuk paket berhak
  if (VERIFIED_PLANS.has(p.id)) feats.push({ ok: true, text: 'Centang biru terverifikasi' });
  else feats.push({ ok: false, text: 'Tanpa centang biru' });
  feats.push({ ok: true, text: 'Kirim foto, video & file hingga 2GB' });
  // kuota storage nyata per paket
  if (Number(p.storageLimit) > 0) {
    feats.push({ ok: true, text: `Storage ${fmtBytes(p.storageLimit)} foto/video/file` });
  } else {
    feats.push({ ok: true, text: 'Storage 2 GB (paket dasar)' });
  }
  return feats;
}

// simbol khas tiap paket (bukan semua bintang)
function planIcon(id) {
  return {
    harian: 'sun',            // harian — matahari (setiap hari)
    mingguan: 'calendar',     // mingguan — kalender
    bulanan: 'star',          // bulanan — bintang (paling laris)
    bisnis: 'shield',         // bisnis — perisai (profesional & aman)
    'reseller-bulanan': 'users', // reseller — jaringan orang
    permanen: 'crown',        // permanen — mahkota (milik selamanya)
  }[id] || (id && id.startsWith('permanen') ? 'crown' : 'star');
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
  const st = data.storage || null;
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

  // ringkasan pemakaian storage nyata (foto/video/file) milik pengguna
  const storageBar = st
    ? `<div class="plan-storage ${st.unlimited ? 'on' : ''} ${st.percent >= 90 ? 'warn' : ''}">
         <div class="plan-quota-top">
           <span>Storage ${st.unlimited ? 'tanpa batas' : `${fmtBytes(st.used)} / ${fmtBytes(st.quota)}`}</span>
           <span class="plan-storage-ico"><svg viewBox="0 0 24 24"><use href="#ic-image" /></svg></span>
         </div>
         ${st.unlimited ? '' : `<div class="plan-quota-bar"><i style="width:${Math.min(100, st.percent || 0)}%"></i></div>`}
         <small>${st.unlimited
           ? 'Akun admin: seluruh media tanpa batas storage.'
           : `Foto, video & file yang dikirim menempati storage paket Anda. Sisa ${fmtBytes(st.left)}.`}</small>
       </div>`
    : '';

  body.innerHTML = `
    <div class="plan-hero">
      <span class="plan-hero-orb o1"></span><span class="plan-hero-orb o2"></span>
      <span class="plan-hero-chip"><svg viewBox="0 0 24 24"><use href="#ic-star" /></svg> RTC-CORE PREMIUM</span>
      <h3>Semua bot dalam satu paket</h3>
      <p>${botTotal} bot AI, alat produktivitas, media &amp; informasi — pilih durasi sesuai kebutuhanmu.</p>
      <div class="plan-status ${me.active ? 'on' : ''}">
        ${me.active
          ? `<strong>${esc(me.planLabel || 'Premium')}</strong><span>aktif s/d ${fmtDate(me.until)}</span>`
          : `<strong>Belum punya paket</strong><span>Daftar bot masih terkunci — pilih paket di bawah</span>`}
      </div>
      ${quota}
      ${storageBar}
    </div>

    <div class="plan-grid">
      ${plans.map((p, i) => {
        const isCurrent = me.active && me.planId === p.id;
        const feats = planFeatures(p, botTotal, exclusiveIds);
        return `
        <article class="plan-card plan-${esc(p.id)} ${isCurrent ? 'is-current' : ''} ${p.id === popularId ? 'is-popular' : ''}" style="--i:${i}">
          ${p.id === popularId ? '<span class="plan-tag">PALING LARIS</span>' : ''}
          <span class="plan-shine"></span>
          <div class="plan-head">
            <span class="plan-ico"><svg viewBox="0 0 24 24"><use href="#ic-${planIcon(p.id)}" /></svg></span>
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
    <b>Mingguan</b> semua bot dengan limit yang diatur admin, <b>Bulanan</b>, <b>Bisnis</b>, <b>Reseller Bulanan</b> &amp; <b>Permanen</b> tanpa limit.
    Storage foto/video/file mengikuti paket (2&nbsp;GB&nbsp;–&nbsp;5&nbsp;TB) dan berlaku nyata.
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
        await navigator.share({ title: 'Gabung RTC-Core', text: `Daftar pakai kode undangan saya: ${code}`, url: link });
        return;
      } catch { /* dibatalkan / tidak didukung -> salin */ }
    }
    toast((await copyText(link)) ? 'Link undangan disalin ✓' : 'Gagal menyalin link');
  });
}

$('btnCloseInvite').addEventListener('click', closeDrawers);

/* ================= manajer penyimpanan =================
   Menampilkan foto, video, audio & file yang benar-benar tersimpan di storage
   milik pengguna (sumber kebenaran: pesan media aktif), lengkap dengan ukuran,
   total per jenis & total paket. Bisa dihapus per item untuk membebaskan kuota. */
$('btnCloseStorage').addEventListener('click', closeDrawers);

let storageFilter = 'all';
let stSelectMode = false;
let stSelected = new Set(); // kunci "kind:id"
let stLastData = null;

const stKey = (it) => `${it.kind || 'msg'}:${it.id}`;

async function openStorageDrawer() {
  openDrawer('storageDrawer');
  exitStSelectMode(true); // selalu reset mode pilih saat (buka ulang) drawer
  const body = $('storageBody');
  body.innerHTML = '<div class="bc-loading">Memuat penyimpanan…</div>';
  try {
    const data = await api('/api/me/storage/media');
    renderStorage(data);
  } catch (err) {
    body.innerHTML = `
      <div class="bc-locked">
        <div class="bc-lock-ico"><svg viewBox="0 0 24 24"><use href="#ic-info" /></svg></div>
        <h3>Penyimpanan belum bisa dimuat</h3>
        <p>${esc(err.message)}</p>
        <button class="btn-ghost" id="stRetry" type="button">Coba lagi</button>
      </div>`;
    $('stRetry').addEventListener('click', openStorageDrawer);
  }
}

const ST_TABS = [
  { id: 'all', label: 'Semua' },
  { id: 'image', label: 'Foto' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'file', label: 'File' },
];

function renderStorage(data) {
  stLastData = data;
  const body = $('storageBody');
  const usage = data.usage || {};
  const items = data.items || [];
  const totals = data.totals || {};
  const shown = storageFilter === 'all' ? items : items.filter((it) => it.type === storageFilter);

  const percent = usage.unlimited ? 100 : Math.min(100, usage.percent || 0);
  const head = `
    <div class="st-summary ${usage.unlimited ? 'on' : ''} ${usage.percent >= 90 ? 'warn' : ''}">
      <div class="st-summary-top">
        <span><b>${fmtBytes(usage.used || 0)}</b> dari <b>${usage.unlimited ? 'tanpa batas' : fmtBytes(usage.quota || 0)}</b> terpakai</span>
        <span class="st-summary-pct">${usage.unlimited ? '∞' : Math.round(usage.percent || 0) + '%'}</span>
      </div>
      <div class="st-bar"><i style="width:${percent}%"></i></div>
      <small>${usage.unlimited ? 'Akun admin — tanpa batas storage.' : `Sisa ${fmtBytes(usage.left || 0)}. Hapus media lama untuk membebaskan ruang.`}</small>
    </div>
    <div class="st-tools">
      <button type="button" class="st-tool" id="btnStClean" title="Pindai & hapus media yang file-nya rusak/hilang, bebaskan kuotanya">
        <svg viewBox="0 0 24 24" class="ico"><use href="#ic-trash" /></svg> Bersihkan file rusak
      </button>
    </div>
    <div class="st-breakdown">
      ${['image', 'video', 'audio', 'file'].map((k) => `
        <div class="st-bd-item">
          <span class="st-bd-ico"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-${k === 'image' ? 'image' : k === 'video' ? 'video' : k === 'audio' ? 'mic' : 'doc'}" /></svg></span>
          <b>${fmtBytes(totals[k] || 0)}</b>
          <small>${ST_TABS.find((t) => t.id === k).label}</small>
        </div>`).join('')}
    </div>
    <p class="st-ram-note">Hemat RAM — daftar menampilkan placeholder; foto/video hanya dimuat saat diketuk dan berhenti
      dimuat saat ditutup. File dibuka streaming langsung dari server, tanpa tersimpan ke HP Anda.</p>
    <div class="st-tabs">
      ${ST_TABS.map((t) => `
        <button class="st-tab ${storageFilter === t.id ? 'active' : ''}" data-st-filter="${t.id}" type="button">
          ${t.label} <span class="st-tab-n">${t.id === 'all' ? items.length : items.filter((it) => it.type === t.id).length}</span>
        </button>`).join('')}
    </div>`;

  const grid = shown.length
    ? `<div class="st-grid">${shown.map((it) => {
        const key = stKey(it);
        const sel = stSelected.has(key);
        // placeholder saja — TIDAK ada <img>/<video> sehingga telusur daftar
        // sama sekali tidak memuat byte media ke RAM/perangkat pengguna
        const thumb = `<div class="st-thumb st-thumb-ph st-ph-${it.type}" aria-hidden="true" title="Ketuk untuk memuat media">
          <svg viewBox="0 0 24 24"><use href="#ic-${it.type === 'image' ? 'image' : it.type === 'video' ? 'video' : it.type === 'audio' ? 'mic' : 'doc'}" /></svg>
          ${it.type === 'video' ? '<span class="st-play"><svg viewBox="0 0 24 24"><use href="#ic-play" /></svg></span>' : ''}
        </div>`;
        return `
        <div class="st-card st-${it.type} ${stSelectMode ? 'selectable' : ''} ${sel ? 'selected' : ''}" data-st-id="${esc(it.id)}" data-st-kind="${esc(it.kind || 'msg')}" data-st-key="${esc(key)}">
          ${stSelectMode ? `<span class="st-check ${sel ? 'on' : ''}"><svg viewBox="0 0 24 24"><use href="#ic-check" /></svg></span>` : ''}
          ${thumb}
          <div class="st-meta">
            <span class="st-name" title="${esc(it.name || 'Media')}">${esc(it.name || (it.type === 'image' ? 'Foto' : it.type === 'video' ? 'Video' : it.type === 'audio' ? 'Audio' : 'File'))}</span>
            <span class="st-sub">${fmtBytes(it.size)} · ${fmtDate(it.at)}</span>
          </div>
          ${!stSelectMode ? `<button class="st-del" type="button" data-st-del="${esc(it.id)}" data-st-kind="${esc(it.kind || 'msg')}" title="Hapus & bebaskan storage">
            <svg viewBox="0 0 24 24"><use href="#ic-trash" /></svg>
          </button>` : ''}
        </div>`;
      }).join('')}</div>`
    : `<div class="st-empty">
        <svg viewBox="0 0 24 24"><use href="#ic-image" /></svg>
        <p>Belum ada ${storageFilter === 'all' ? 'media' : ST_TABS.find((t) => t.id === storageFilter).label.toLowerCase()} tersimpan.</p>
      </div>`;

  body.innerHTML = head + grid;

  body.querySelectorAll('[data-st-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      storageFilter = btn.dataset.stFilter;
      renderStorage(data); // mode pilih & seleksi tetap (state di luar render)
    });
  });
  body.querySelectorAll('[data-st-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); void deleteStorageItem(btn.dataset.stDel, btn, btn.dataset.stKind); });
  });
  // aksi "Bersihkan file rusak" (dirender, selalu tersedia)
  const cleanBtn = $('btnStClean');
  if (cleanBtn) cleanBtn.addEventListener('click', () => void cleanBrokenStorage(cleanBtn));
  // ketuk kartu: mode pilih -> toggle seleksi; normal -> buka viewer
  body.querySelectorAll('.st-card').forEach((card, i) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-st-del]')) return;
      if (stSelectMode) { toggleStSelect(card.dataset.stKey); return; }
      openStViewer(shown, i);
    });
  });
  updateStBulkBar();
}

/* ---------- mode pilih & hapus massal ---------- */
function toggleStSelect(key) {
  if (stSelected.has(key)) stSelected.delete(key); else stSelected.add(key);
  const on = stSelected.has(key);
  const card = document.querySelector(`.st-card[data-st-key="${key}"]`);
  if (card) { card.classList.toggle('selected', on); const c = card.querySelector('.st-check'); if (c) c.classList.toggle('on', on); }
  updateStBulkBar();
}

function updateStBulkBar() {
  const bar = $('stBulkBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !stSelectMode);
  const body = $('storageBody');
  if (body) body.classList.toggle('has-bulk', stSelectMode); // beri ruang bar di bawah
  const count = $('stBulkCount');
  if (count) count.textContent = `${stSelected.size} dipilih`;
  const delBtn = $('btnStBulkDelete');
  if (delBtn) delBtn.disabled = stSelected.size === 0;
  const exBtn = $('btnStBulkExport');
  if (exBtn && !exBtn.classList.contains('busy')) exBtn.disabled = stSelected.size === 0;
}

function enterStSelectMode() {
  stSelectMode = true;
  const b = $('btnStSelect');
  if (b) { b.classList.add('active'); b.textContent = 'Selesai'; }
  if (stLastData) renderStorage(stLastData);
}

function exitStSelectMode(skipRender) {
  stSelectMode = false;
  stSelected.clear();
  const b = $('btnStSelect');
  if (b) { b.classList.remove('active'); b.textContent = 'Pilih'; }
  updateStBulkBar();
  if (!skipRender && stLastData) renderStorage(stLastData);
}

$('btnStSelect').addEventListener('click', () => {
  if (stSelectMode) exitStSelectMode(); else enterStSelectMode();
});

$('btnStSelectAll').addEventListener('click', () => {
  if (!stLastData) return;
  const items = stLastData.items || [];
  const shown = storageFilter === 'all' ? items : items.filter((it) => it.type === storageFilter);
  const allSel = shown.length > 0 && shown.every((it) => stSelected.has(stKey(it)));
  shown.forEach((it) => { if (allSel) stSelected.delete(stKey(it)); else stSelected.add(stKey(it)); });
  renderStorage(stLastData);
});

$('btnStBulkDelete').addEventListener('click', async () => {
  if (!stSelected.size) return;
  if (!confirm(`Hapus ${stSelected.size} media terpilih? Kuota storage akan dibebaskan.`)) return;
  const btn = $('btnStBulkDelete');
  if (btn) btn.disabled = true;
  try {
    const items = [...stSelected].map((k) => {
      const idx = k.indexOf(':');
      return { kind: k.slice(0, idx), id: k.slice(idx + 1) };
    });
    const r = await api('/api/storage/bulk-delete', { method: 'POST', body: { items } });
    toast(`${r.deleted} media dihapus — ${fmtBytes(r.freed || 0)} dibebaskan`);
    exitStSelectMode(true);
    openStorageDrawer();
  } catch (err) {
    toast(err.message || 'Gagal menghapus media');
    if (btn) btn.disabled = false;
  }
});

$('btnStCancel').addEventListener('click', () => exitStSelectMode());

/* ---------- ekspor galeri: semua / terpilih -> satu arsip ZIP ----------
   api() hanya menerima JSON, jadi unduhan ZIP pakai fetch sendiri:
   balasan non-JSON (error) tetap dibaca sebagai JSON agar pesan tampil. */
async function exportGalleryZip(items) {
  const res = await fetch('/api/storage/export', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
    },
    body: JSON.stringify(items ? { items } : {}),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('json')) {
    let data = null;
    try { data = await res.json(); } catch { /* balasan bukan JSON */ }
    if (res.status === 401 && S.token) {
      logout(false, (data && data.error) || 'Sesi berakhir. Silakan masuk kembali.');
    }
    const err = new Error((data && data.error) || `Gagal mengekspor (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  let name = 'galeri.zip';
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  if (m) name = m[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  return { bytes: blob.size, name };
}

async function runGalleryExport(btn, items, scopeLabel) {
  if (!btn || btn.classList.contains('busy')) return;
  const span = btn.querySelector('span');
  const oldHtml = span ? span.innerHTML : btn.textContent;
  btn.classList.add('busy');
  btn.disabled = true;
  if (span) span.textContent = 'Menyiapkan…'; else btn.textContent = 'Menyiapkan…';
  try {
    const r = await exportGalleryZip(items);
    toast(`Ekspor ${scopeLabel} selesai — ${fmtBytes(r.bytes)} · ${r.name}`, 3200);
  } catch (err) {
    toast(err.message || 'Gagal mengekspor galeri', 3200);
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (span) span.innerHTML = oldHtml; else btn.textContent = oldHtml;
    if (btn.id === 'btnStBulkExport') updateStBulkBar(); // kembalikan status disabled
  }
}

$('btnStExportAll').addEventListener('click', () => {
  void runGalleryExport($('btnStExportAll'), null, 'semua');
});

$('btnStBulkExport').addEventListener('click', () => {
  if (!stSelected.size) return;
  const items = [...stSelected].map((k) => {
    const idx = k.indexOf(':');
    return { kind: k.slice(0, idx), id: k.slice(idx + 1) };
  });
  const n = items.length;
  void runGalleryExport($('btnStBulkExport'), items, `${n} media`);
});

async function cleanBrokenStorage(btn) {
  if (!confirm('Pindai & hapus semua media yang file-nya rusak/hilang? Kuota akan dibebaskan.')) return;
  if (btn) btn.classList.add('busy');
  try {
    const r = await api('/api/storage/cleanup', { method: 'POST', body: {} });
    if (r.removed) toast(`${r.removed} media rusak dihapus — ${fmtBytes(r.freed || 0)} dibebaskan`);
    else toast(`Tidak ada media rusak (diperiksa ${r.checked})`);
    openStorageDrawer();
  } catch (err) {
    toast(err.message || 'Gagal membersihkan');
    if (btn) btn.classList.remove('busy');
  }
}

async function deleteStorageItem(id, btn, kind) {
  if (!confirm('Hapus media ini? Kuota storage akan dibebaskan.')) return;
  if (btn) btn.classList.add('busy');
  try {
    if (kind === 'saved') await api(`/api/storage/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    else await api(`/api/messages/${id}`, { method: 'DELETE' });
    toast('Media dihapus — storage dibebaskan');
    openStorageDrawer(); // muat ulang data
  } catch (err) {
    toast(err.message || 'Gagal menghapus media');
    if (btn) btn.classList.remove('busy');
  }
}

/* ================= simpan dari galeri (satu klik) =================
   Pilih banyak foto/video/file dari galeri perangkat -> unggah lalu
   daftarkan langsung ke storage (tanpa dikirim jadi pesan). Menampilkan
   progress berpersen selama proses agar terasa lancar; kuota dicadangkan
   atomik di server; setelah selesai daftar dimuat ulang. */
$('btnStUpload').addEventListener('click', () => $('stFileInput').click());

function stProgressShow(total) {
  const el = $('stProgress');
  if (!el) return;
  el.classList.remove('hidden');
  const pct = $('stProgressPct'); if (pct) pct.textContent = '0%';
  const fill = $('stProgressFill'); if (fill) fill.style.width = '0%';
  const sub = $('stProgressSub'); if (sub) sub.textContent = `Menyiapkan ${total} file…`;
}
function stProgressUpdate(fileIdx, total, filePct, name) {
  const overall = Math.max(0, Math.min(100, Math.round(((fileIdx + filePct / 100) / total) * 100)));
  const pct = $('stProgressPct'); if (pct) pct.textContent = overall + '%';
  const fill = $('stProgressFill'); if (fill) fill.style.width = overall + '%';
  const sub = $('stProgressSub'); if (sub) sub.textContent = `${name} · file ${fileIdx + 1} dari ${total}`;
}
function stProgressDone(msg) {
  const el = $('stProgress');
  if (!el) return;
  const pct = $('stProgressPct'); if (pct) pct.textContent = '100%';
  const fill = $('stProgressFill'); if (fill) fill.style.width = '100%';
  const sub = $('stProgressSub'); if (sub) sub.textContent = msg || 'Selesai';
  setTimeout(() => el.classList.add('hidden'), 1100);
}

$('stFileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // reset agar file yang sama bisa dipilih lagi
  if (!files.length) return;
  const btn = $('btnStUpload');
  if (btn) { btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); }
  stProgressShow(files.length);
  let ok = 0, fail = 0, lastErr = '';
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      stProgressUpdate(i, files.length, 0, file.name);
      const meta = await uploadFile(file, (p) => stProgressUpdate(i, files.length, Math.round(p * 100), file.name));
      stProgressUpdate(i, files.length, 100, file.name); // unggah beres, siap didaftarkan
      await api('/api/storage/files', {
        method: 'POST',
        body: { url: meta.url, name: meta.name, size: meta.size, mime: meta.mime, type: meta.type },
      });
      ok++;
    } catch (err) {
      fail++;
      lastErr = err.message || 'Gagal menyimpan';
    }
  }
  if (btn) { btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); }
  const summary = ok && !fail ? `${ok} file tersimpan` : `${ok} tersimpan · ${fail} gagal`;
  stProgressDone(summary);
  if (ok && !fail) toast(`${ok} file tersimpan di penyimpanan`);
  else if (ok && fail) toast(`${ok} tersimpan · ${fail} gagal (${lastErr})`);
  else toast(lastErr || 'Gagal menyimpan file');
  openStorageDrawer(); // muat ulang agar file baru tampil
});

/* ================= viewer media penyimpanan =================
   Lihat foto / tonton video / putar audio / buka file langsung dari daftar.
   Hemat RAM: hanya SATU media yang hidup di DOM; video & audio streaming
   (preload="metadata", tanpa unduh penuh); saat tutup/ganti, src dilepas
   & dipanggil load() agar buffer dilepas kembali ke sistem. */
let stvItems = [], stvIdx = 0;

const STV_LABEL = { image: 'Foto', video: 'Video', audio: 'Audio', file: 'File' };

function openStViewer(items, idx) {
  if (!items || !items.length) return;
  stvItems = items;
  stvIdx = Math.min(Math.max(0, idx | 0), items.length - 1);
  $('stViewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderStv();
}

function releaseStvMedia() {
  const stage = $('stvStage');
  if (!stage) return;
  stage.querySelectorAll('img,video,audio').forEach((el) => {
    try { if (el.pause) el.pause(); } catch { /* abaikan */ }
    el.removeAttribute('src');
    try { el.load(); } catch { /* abaikan */ }
  });
  stage.innerHTML = '';
}

function closeStViewer() {
  releaseStvMedia();
  $('stViewer').classList.add('hidden');
  document.body.style.overflow = '';
  stvItems = []; stvIdx = 0;
}

function stvGo(delta) {
  if (stvItems.length < 2) return;
  stvIdx = (stvIdx + delta + stvItems.length) % stvItems.length;
  renderStv();
}

function renderStv() {
  const it = stvItems[stvIdx];
  if (!it) { closeStViewer(); return; }
  const label = it.name || (STV_LABEL[it.type] || 'Media');
  $('stvName').textContent = label;
  $('stvSub').textContent = `${STV_LABEL[it.type] || 'Media'} · ${fmtBytes(it.size)} · ${fmtDate(it.at)}`;
  $('stvCount').textContent = `${stvIdx + 1} / ${stvItems.length}`;

  // lepaskan media sebelumnya (hanya satu yang hidup -> hemat RAM)
  releaseStvMedia();
  const stage = $('stvStage');

  if (it.type === 'image') {
    const img = document.createElement('img');
    img.className = 'stv-img';
    img.decoding = 'async';
    img.alt = label;
    img.src = it.url;
    stage.appendChild(img);
  } else if (it.type === 'video') {
    const v = document.createElement('video');
    v.className = 'stv-video';
    v.controls = true;
    v.preload = 'none'; // streaming on-demand: 0 byte sampai ditekan putar
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.src = it.url;
    stage.appendChild(v);
  } else if (it.type === 'audio') {
    const a = document.createElement('audio');
    a.className = 'stv-audio';
    a.controls = true;
    a.preload = 'none';
    a.src = it.url;
    stage.appendChild(a);
  } else {
    const box = document.createElement('div');
    box.className = 'stv-file';
    box.innerHTML = `
      <span class="stv-file-ico"><svg viewBox="0 0 24 24"><use href="#ic-doc" /></svg></span>
      <b>${esc(label)}</b>
      <small>${fmtBytes(it.size)} · ${fmtDate(it.at)}${it.mime ? ` · ${esc(it.mime)}` : ''}</small>`;
    stage.appendChild(box);
  }

  const open = $('stvOpen');
  if (it.type === 'file' || it.type === 'audio') {
    open.href = it.url;
    // buka streaming di tab baru — TIDAK mengunduh/menyimpan file ke HP
    open.removeAttribute('download');
    open.classList.remove('hidden');
  } else {
    open.classList.add('hidden');
  }

  const many = stvItems.length > 1;
  $('btnStvPrev').style.visibility = many ? 'visible' : 'hidden';
  $('btnStvNext').style.visibility = many ? 'visible' : 'hidden';
}

$('btnStvClose').addEventListener('click', closeStViewer);
$('btnStvPrev').addEventListener('click', () => stvGo(-1));
$('btnStvNext').addEventListener('click', () => stvGo(1));
$('stvStage').addEventListener('click', (e) => { if (e.target === $('stvStage')) closeStViewer(); });
document.addEventListener('keydown', (e) => {
  const v = $('stViewer');
  if (!v || v.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeStViewer();
  else if (e.key === 'ArrowLeft') stvGo(-1);
  else if (e.key === 'ArrowRight') stvGo(1);
});

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
    <h3>RTC-Core</h3>
    <p class="about-sub">Real-Time Chat Core • Versi 2.0.0</p>
    <span class="about-badge"><svg viewBox="0 0 24 24"><use href="#ic-verified" /></svg> Developer resmi: mazval-developer-java</span>
  </div>

  <section class="about-sec" style="--i:0">
    <h4><svg viewBox="0 0 24 24"><use href="#ic-info" /></svg> Tentang Aplikasi</h4>
    <p><b>RTC-Core (Real-Time Chat Core)</b> adalah inti chat real-time dengan pengiriman foto, video, dan file hingga <b>2GB</b>,
    notifikasi sistem, status 24 jam, grup besar, panggilan suara &amp; video WebRTC, serta ratusan bot premium (AI, informasi,
    media, hiburan, alat produktivitas) yang bisa dipakai lewat paket premium.</p>
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
        <a class="cs-go" href="mailto:ovalkyzz@gmail.com?subject=CS%20RTC-Core">Kirim</a></div>
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
      <li>Pesan &amp; status dienkripsi <b>AES-256-GCM</b> saat disimpan — data privat tidak telanjang di database.</li>
      <li>Password di-hash <b>bcrypt</b>; sesi memakai token ber-signature yang dipaku algoritmanya.</li>
      <li>Foto profil dilindungi: klik kanan, seret, simpan &amp; cetak dimatikan.</li>
      <li>Satu akun hanya boleh aktif di satu perangkat.</li>
      <li>Akun baru wajib disetujui admin — mencegah bot &amp; spam.</li>
    </ul>
  </section>

  <p class="about-copy">RTC-Core • v2.0.0 • MIT<br/>© mazval-developer-java</p>
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

/* Catatan: pelindung foto TIDAK memakai preventDefault() di touchstart.
   Dulu tiap sentuhan pada .avatar diblokir sehingga gesture scroll di daftar
   chat & pesan mati kalau jari mulai dari foto — scroll jadi tersendat.
   Menu "simpan gambar" tekan-tahan sudah ditangani event contextmenu di atas
   dan -webkit-touch-callout: none di CSS, jadi scroll tetap lancar. */

/* ================= pemotong foto: rasio bebas, zoom & geser =================
   Foto tidak lagi dipaksa center-crop persegi. Pengguna menggeser foto,
   zoom (geser jari / scroll / slider), dan memilih rasio potongan sendiri
   (Bebas, 1:1, 3:4, 4:3, 16:9, 9:16) sebelum foto dikirim. */
const CROP = {
  open: false, ratio: 0, natural: [1, 1], base: 1, scale: 1, minScale: 1, maxScale: 1,
  ox: 0, oy: 0, rect: { x: 0, y: 0, w: 0, h: 0 }, stage: { w: 0, h: 0 },
  url: null, pointers: new Map(), pinch: null, mode: null, handle: null, start: null,
  onDone: null,
};
const CROP_MIN = 64;
const CROP_MAX_OUT = 1024;

function cropEl(id) { return document.getElementById(id); }

function cropSize() {
  const st = cropEl('cropStage');
  CROP.stage.w = st.clientWidth;
  CROP.stage.h = st.clientHeight;
}

function cropCenterRect() {
  const { w: SW, h: SH } = CROP.stage;
  const ratio = CROP.ratio;
  const pad = 0.88;
  let w = SW * pad;
  let h = SH * pad;
  if (ratio) {
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
  } else {
    const side = Math.min(w, h);
    w = h = side;
  }
  CROP.rect = { x: (SW - w) / 2, y: (SH - h) / 2, w, h };
}

function cropScales() {
  const nw = CROP.natural[0];
  const nh = CROP.natural[1];
  const r = CROP.rect;
  CROP.minScale = Math.max(r.w / nw, r.h / nh);
  CROP.maxScale = Math.max(CROP.minScale, CROP.base) * 6;
  CROP.scale = Math.min(Math.max(CROP.scale, CROP.minScale), CROP.maxScale);
}

function cropClamp() {
  const { w: SW, h: SH } = CROP.stage;
  const r = CROP.rect;
  const imgW = CROP.natural[0] * CROP.scale;
  const imgH = CROP.natural[1] * CROP.scale;
  const minX = r.x + r.w - SW / 2 - imgW / 2;
  const maxX = r.x - SW / 2 + imgW / 2;
  const minY = r.y + r.h - SH / 2 - imgH / 2;
  const maxY = r.y - SH / 2 + imgH / 2;
  CROP.ox = minX > maxX ? (minX + maxX) / 2 : Math.min(Math.max(CROP.ox, minX), maxX);
  CROP.oy = minY > maxY ? (minY + maxY) / 2 : Math.min(Math.max(CROP.oy, minY), maxY);
}

function cropRender() {
  const img = cropEl('cropImg');
  const frame = cropEl('cropFrame');
  const r = CROP.rect;
  img.style.width = `${CROP.natural[0]}px`;
  img.style.height = `${CROP.natural[1]}px`;
  img.style.transform = `translate(-50%, -50%) translate(${CROP.ox}px, ${CROP.oy}px) scale(${CROP.scale})`;
  frame.style.left = `${r.x}px`;
  frame.style.top = `${r.y}px`;
  frame.style.width = `${r.w}px`;
  frame.style.height = `${r.h}px`;
  const zoom = cropEl('cropZoom');
  const val = Math.round((CROP.scale / CROP.minScale) * 100);
  zoom.value = String(Math.min(600, Math.max(100, val)));
  updateRangeFill(zoom);
  cropEl('cropZoomVal').textContent = `${(Number(zoom.value) / 100).toFixed(1)}x`;
}

function cropSync() {
  cropScales();
  cropClamp();
  cropRender();
}

/* zoom ke titik tertentu supaya bagian yang disentuh tetap di tempat */
function cropZoomAt(mult, px, py) {
  const { w: SW, h: SH } = CROP.stage;
  const s0 = CROP.scale;
  const s1 = Math.min(Math.max(s0 * mult, CROP.minScale), CROP.maxScale);
  if (s1 === s0) return;
  const cx0 = SW / 2 + CROP.ox;
  const cy0 = SH / 2 + CROP.oy;
  const ux = (px - cx0) / s0;
  const uy = (py - cy0) / s0;
  CROP.scale = s1;
  CROP.ox = px - ux * s1 - SW / 2;
  CROP.oy = py - uy * s1 - SH / 2;
  cropClamp();
  cropRender();
}

function cropLocalPoint(e) {
  const box = cropEl('cropStage').getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

function cropSetRatio(ratio) {
  CROP.ratio = ratio;
  cropEl('cropRatios').querySelectorAll('.crop-ratio').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.ratio) === ratio);
  });
  if (ratio) cropCenterRect();
  cropSync();
}

function cropResizeFrom(handle, p) {
  const { w: SW, h: SH } = CROP.stage;
  const r = CROP.rect;
  const ratio = CROP.ratio;
  const left = handle[0] === 'l';
  const top = handle[0] === 't';
  const ax = left ? r.x + r.w : r.x;
  const ay = top ? r.y + r.h : r.y;
  let dx = Math.abs(p.x - ax);
  let dy = Math.abs(p.y - ay);
  if (ratio) {
    let w = Math.max(dx, dy * ratio);
    const limW = left ? ax : SW - ax;
    const limH = top ? ay : SH - ay;
    w = Math.min(w, limW, limH * ratio);
    w = Math.max(w, Math.max(CROP_MIN, CROP_MIN * ratio));
    CROP.rect = {
      x: left ? ax - w : ax,
      y: top ? ay - w / ratio : ay,
      w,
      h: w / ratio,
    };
  } else {
    let w = Math.min(dx, left ? ax : SW - ax);
    let h = Math.min(dy, top ? ay : SH - ay);
    w = Math.max(w, CROP_MIN);
    h = Math.max(h, CROP_MIN);
    CROP.rect = {
      x: left ? ax - w : ax,
      y: top ? ay - h : ay,
      w,
      h,
    };
  }
  // jaga bingkai selalu di dalam panggung
  CROP.rect.x = Math.min(Math.max(CROP.rect.x, 0), Math.max(0, SW - CROP.rect.w));
  CROP.rect.y = Math.min(Math.max(CROP.rect.y, 0), Math.max(0, SH - CROP.rect.h));
  CROP.rect.w = Math.min(CROP.rect.w, SW);
  CROP.rect.h = Math.min(CROP.rect.h, SH);
  cropSync();
}

function cropPointerDown(e) {
  if (!CROP.open) return;
  const st = cropEl('cropStage');
  st.setPointerCapture(e.pointerId);
  CROP.pointers.set(e.pointerId, cropLocalPoint(e));
  if (CROP.pointers.size === 2) {
    const [a, b] = [...CROP.pointers.values()];
    CROP.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale: CROP.scale,
    };
    CROP.mode = 'pinch';
    return;
  }
  const h = e.target && e.target.dataset ? e.target.dataset.h : null;
  CROP.start = cropLocalPoint(e);
  if (h) {
    CROP.mode = 'handle';
    CROP.handle = h;
  } else {
    CROP.mode = 'pan';
    CROP.startOx = CROP.ox;
    CROP.startOy = CROP.oy;
  }
}

function cropPointerMove(e) {
  if (!CROP.open || !CROP.pointers.has(e.pointerId)) return;
  CROP.pointers.set(e.pointerId, cropLocalPoint(e));
  const p = CROP.pointers.get(e.pointerId);
  if (CROP.mode === 'pinch' && CROP.pointers.size >= 2) {
    const [a, b] = [...CROP.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const { w: SW, h: SH } = CROP.stage;
    const s0 = CROP.pinch.scale;
    const ux = (CROP.pinch.mid.x - (SW / 2 + CROP.ox)) / s0;
    const uy = (CROP.pinch.mid.y - (SH / 2 + CROP.oy)) / s0;
    const s1 = Math.min(Math.max(s0 * (dist / (CROP.pinch.dist || 1)), CROP.minScale), CROP.maxScale);
    CROP.scale = s1;
    CROP.ox = mid.x - ux * s1 - SW / 2;
    CROP.oy = mid.y - uy * s1 - SH / 2;
    cropClamp();
    cropRender();
    return;
  }
  if (CROP.mode === 'pan') {
    CROP.ox = CROP.startOx + (p.x - CROP.start.x);
    CROP.oy = CROP.startOy + (p.y - CROP.start.y);
    cropClamp();
    cropRender();
  } else if (CROP.mode === 'handle') {
    cropResizeFrom(CROP.handle, p);
  }
}

function cropPointerUp(e) {
  CROP.pointers.delete(e.pointerId);
  if (CROP.pointers.size < 2) {
    CROP.pinch = null;
    if (CROP.pointers.size === 0) {
      CROP.mode = null;
      CROP.handle = null;
    } else {
      CROP.mode = 'pan';
      CROP.start = [...CROP.pointers.values()][0];
      CROP.startOx = CROP.ox;
      CROP.startOy = CROP.oy;
    }
  }
}

function cropWheel(e) {
  if (!CROP.open) return;
  e.preventDefault();
  const p = cropLocalPoint(e);
  cropZoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, p.x, p.y);
}

/* hasilkan berkas JPEG dari area yang dipilih */
function cropExport() {
  return new Promise((resolve, reject) => {
    const img = cropEl('cropImg');
    const { w: SW, h: SH } = CROP.stage;
    const r = CROP.rect;
    const s = CROP.scale;
    const imgLeft = SW / 2 + CROP.ox - (CROP.natural[0] * s) / 2;
    const imgTop = SH / 2 + CROP.oy - (CROP.natural[1] * s) / 2;
    const sx = Math.max(0, (r.x - imgLeft) / s);
    const sy = Math.max(0, (r.y - imgTop) / s);
    const sw = Math.min(CROP.natural[0] - sx, r.w / s);
    const sh = Math.min(CROP.natural[1] - sy, r.h / s);
    if (!(sw > 0 && sh > 0)) { reject(new Error('Area potongan tidak valid')); return; }
    const longest = Math.max(sw, sh);
    // hasil minimal 512 sisi terpanjang (tajam saat tampil bulat), maksimal 1024
    const out = Math.min(CROP_MAX_OUT, Math.max(512, Math.round(longest)));
    const q = out / longest;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * q));
    c.height = Math.max(1, Math.round(sh * q));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    } catch (err) {
      reject(new Error('Foto tidak bisa diproses'));
      return;
    }
    c.toBlob((blob) => {
      if (!blob) { reject(new Error('Gagal memproses foto')); return; }
      resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  });
}

function cropClose(result) {
  if (!CROP.open) return;
  CROP.open = false;
  if (CROP.url) { URL.revokeObjectURL(CROP.url); CROP.url = null; }
  document.body.classList.remove('crop-open');
  cropEl('cropModal').classList.add('hidden');
  const cb = CROP.onDone;
  CROP.onDone = null;
  CROP.pointers.clear();
  CROP.pinch = null;
  CROP.mode = null;
  if (cb) cb(result);
}

/* buka pemotong; resolve File saat ditekan "Pakai Foto", null saat batal */
function openCropper(file, opts = {}) {
  return new Promise((resolve) => {
    if (CROP.open) { resolve(null); return; }
    if (!file || !file.type.startsWith('image/')) {
      toast('File harus berupa gambar (JPG/PNG/WEBP)');
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = cropEl('cropImg');
    const fail = (msg) => {
      URL.revokeObjectURL(url);
      if (CROP.url === url) CROP.url = null;
      img.removeAttribute('src');
      // pastikan tidak ada modal setengah terbuka bila gagal di tengah jalan
      if (CROP.open) {
        CROP.open = false;
        CROP.onDone = null;
        document.body.classList.remove('crop-open');
        cropEl('cropModal').classList.add('hidden');
      }
      toast(msg);
      resolve(null);
    };
    img.onload = () => {
      try {
        CROP.url = url;
        CROP.natural = [img.naturalWidth || 1, img.naturalHeight || 1];
        CROP.open = true;
        CROP.ratio = 0;
        CROP.onDone = resolve;
        CROP.pointers.clear();
        CROP.pinch = null;
        CROP.mode = null;
        cropEl('cropTitle').textContent = opts.title || 'Atur foto profil';
        cropEl('cropModal').classList.remove('hidden');
        document.body.classList.add('crop-open');
        cropSize();
        cropCenterRect();
        CROP.base = Math.min(
          CROP.stage.w / CROP.natural[0],
          CROP.stage.h / CROP.natural[1],
        );
        CROP.scale = CROP.base;
        CROP.ox = 0;
        CROP.oy = 0;
        cropEl('cropRatios').querySelectorAll('.crop-ratio').forEach((b) => {
          b.classList.toggle('active', Number(b.dataset.ratio) === 0);
        });
        cropSync();
      } catch (err) {
        fail('Foto tidak bisa diproses');
      }
    };
    img.onerror = () => fail('File gambar rusak atau format tidak didukung');
    img.src = url;
  });
}

(function bindCropper() {
  const st = cropEl('cropStage');
  if (!st) return;
  st.addEventListener('pointerdown', cropPointerDown);
  st.addEventListener('pointermove', cropPointerMove);
  st.addEventListener('pointerup', cropPointerUp);
  st.addEventListener('pointercancel', cropPointerUp);
  st.addEventListener('wheel', cropWheel, { passive: false });
  cropEl('cropRatios').addEventListener('click', (e) => {
    const b = e.target.closest('.crop-ratio');
    if (b) cropSetRatio(Number(b.dataset.ratio));
  });
  cropEl('cropZoom').addEventListener('input', () => {
    const m = Number(cropEl('cropZoom').value) / 100;
    CROP.scale = Math.min(Math.max(CROP.minScale * m, CROP.minScale), CROP.maxScale);
    cropClamp();
    cropRender();
  });
  cropEl('btnCropOk').addEventListener('click', async () => {
    try {
      const out = await cropExport();
      cropClose(out);
    } catch (err) {
      toast(err.message || 'Gagal memproses foto');
    }
  });
  cropEl('btnCropCancel').addEventListener('click', () => cropClose(null));
  cropEl('btnCropClose').addEventListener('click', () => cropClose(null));
  // klik area gelap di luar kotak = batal
  cropEl('cropModal').addEventListener('click', (e) => {
    if (e.target === cropEl('cropModal')) cropClose(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && CROP.open) cropClose(null);
  });
  window.addEventListener('resize', () => {
    if (!CROP.open) return;
    const prev = { ...CROP.stage };
    cropSize();
    if (prev.w && prev.h) {
      CROP.rect.x *= CROP.stage.w / prev.w;
      CROP.rect.y *= CROP.stage.h / prev.h;
      CROP.rect.w *= CROP.stage.w / prev.w;
      CROP.rect.h *= CROP.stage.h / prev.h;
    }
    cropSync();
  });
})();



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
  let label = 'Bawaan RTC-Core';

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
  $('hbLabel').textContent = bg.type === 'video' ? 'Video' : bg.type === 'image' ? 'Foto' : 'Bawaan RTC-Core';
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
      const upload = await openCropper(file, { title: 'Atur foto profil bot' });
      if (!upload) return;
      const meta = await uploadFile(upload, () => {});
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

/* ---------- notifikasi per chat (bisukan percakapan ini) ---------- */
async function setChatMuted(chatId, muted) {
  const chat = (S.chats || []).find((c) => c.id === chatId);
  if (!chat) return;
  const prev = !!chat.muted;
  chat.muted = !!muted;
  renderChatList();
  try {
    await api(`/api/chats/${chatId}/notifications`, { method: 'POST', body: { muted: !!muted } });
    toast(muted ? 'Notifikasi chat ini dimatikan' : 'Notifikasi chat ini dinyalakan ✓');
  } catch (err) {
    chat.muted = prev;
    renderChatList();
    toast(err.message);
  }
}

function muteRowHtml(chat, inputId) {
  const on = !!(chat && chat.muted);
  return `
    <div class="pv-row">
      <div class="pv-text"><strong>Notifikasi chat ini</strong><small id="${inputId}Text">${on ? 'Senyap — pesan tetap masuk tanpa bunyi, getar & banner' : 'Bunyi, getar & notifikasi saat pesan masuk'}</small></div>
      <label class="switch"><input type="checkbox" id="${inputId}" ${on ? 'checked' : ''} /><span></span></label>
    </div>`;
}

function bindMuteRow(chatId, inputId) {
  const el = $(inputId);
  if (!el) return;
  el.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    await setChatMuted(chatId, on);
    const txt = $(`${inputId}Text`);
    if (txt) txt.textContent = on
      ? 'Senyap — pesan tetap masuk tanpa bunyi, getar & banner'
      : 'Bunyi, getar & notifikasi saat pesan masuk';
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
      ${muteRowHtml(chat, 'ciMuteToggle')}
      <div class="contact-actions">
        <button class="btn-ghost" id="ciChat"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-chat" /></svg> Pesan</button>
        ${u.isBot ? '' : `
        <button class="btn-ghost" id="ciVoice"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-phone" /></svg> Suara</button>
        <button class="btn-ghost" id="ciVideo"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-video" /></svg> Video</button>`}
      </div>`;
    setAvatar($('contactAvatar'), peer);
    bindMuteRow(chat.id, 'ciMuteToggle');
    $('ciChat').addEventListener('click', () => { closeDrawers(); $('messageInput').focus(); });
    if (!u.isBot) {
      $('ciVoice').addEventListener('click', () => { closeDrawers(); startCall('audio'); });
      $('ciVideo').addEventListener('click', () => { closeDrawers(); startCall('video'); });
    }
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
  // link kontak pribadi: ?u=<id> -> penerima langsung bisa membuka chat
  const clInput = $('myContactLink');
  if (clInput) {
    const origin = location.origin;
    clInput.value = S.me.id ? `${origin}/?u=${S.me.id}` : '—';
  }
  $('profileMsg').classList.add('hidden');
  openDrawer('profileDrawer');
}

// salin / bagikan link kontak dari drawer profil
$('btnCopyContactLink') && $('btnCopyContactLink').addEventListener('click', async () => {
  const v = $('myContactLink') && $('myContactLink').value;
  if (!v || v === '—') return;
  const ok = await copyToClipboard(v);
  toast(ok ? 'Link kontak disalin' : 'Gagal menyalin');
});
$('btnShareContactLink') && $('btnShareContactLink').addEventListener('click', async () => {
  const v = $('myContactLink') && $('myContactLink').value;
  if (!v || v === '—') return;
  if (navigator.share) {
    try { await navigator.share({ title: `Hubungi ${S.me.name || 'saya'}`, text: 'Obrolan lewat RTC-Core:', url: v }); } catch { /* dibatalkan */ }
  } else {
    const ok = await copyToClipboard(v);
    toast(ok ? 'Link disalin — tempel di mana saja' : 'Gagal menyalin');
  }
});

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
    // pemotong rasio bebas: pengatur sendiri area, zoom & rasio potongan
    const upload = await openCropper(file, { title: 'Atur foto profil' });
    if (!upload) return;
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
const PV_KEYS = ['lastSeen', 'receipts', 'email', 'bio', 'status', 'avatar', 'hideNotifContent'];

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
  void refreshPermUI(); // status izin perangkat dibaca ulang setiap panel dibuka
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
const adm = { plans: [], homeBg: { type: 'default', url: null }, pendingBg: null, regText: { greeting: '', blocked: '' }, users: [], pending: [], logs: [], ipBans: [], timer: null };

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
  ip_banned: 'diblokir otomatis — anti-spam pendaftaran',
};

async function openAdminPanel() {
  if (!S.me || S.me.role !== 'admin') { toast('Hanya admin yang bisa membuka panel ini'); return; }
  openDrawer('adminDrawer');
  $('admMsg').classList.add('hidden');
  $('admBgMsg').classList.add('hidden');
  $('admRegMsg').classList.add('hidden');
  try {
    const [data, mon] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/monitor'),
    ]);
    adm.plans = data.plans || [];
    adm.homeBg = data.homeBg || { type: 'default', url: null };
    adm.pendingBg = null;
    adm.regText = data.regText || { greeting: '', blocked: '' };
    $('admRegGreet').value = adm.regText.greeting || '';
    $('admRegBlock').value = adm.regText.blocked || '';
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
  adm.ipBans = mon.ipBans || [];
  if (mon.stats) renderAdmStats(mon.stats);

  const onlineCount = adm.users.filter((u) => u.online).length;
  $('admLiveText').textContent = `${onlineCount} daring • ${adm.users.length} pengguna • ${adm.logs.length} upaya masuk terakhir`
    + (adm.ipBans.length ? ` • ${adm.ipBans.length} IP diblokir` : '');
  $('admLive').classList.toggle('is-offline', onlineCount === 0);

  const badgeCount = $('admPendingCount');
  badgeCount.textContent = adm.pending.length;
  badgeCount.classList.toggle('hidden', adm.pending.length === 0);

  const banCount = $('admIpBanCount');
  if (banCount) {
    banCount.textContent = adm.ipBans.length;
    banCount.classList.toggle('hidden', adm.ipBans.length === 0);
  }

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
    <div class="adm-log log-${esc(l.result)}" title="${esc(l.detail || '')}">
      <span class="adm-log-time">${fmtTime(l.at)}</span>
      <span class="adm-log-mail">${esc(l.email || '—')}</span>
      <span class="adm-log-res">${logLabel(l.result)}</span>
    </div>`).join('') || '<div class="empty-state">Belum ada upaya masuk.</div>';

  $('admIpBans').innerHTML = adm.ipBans.map((b) => `
    <div class="adm-log log-failed" title="${esc(b.detail || '')}">
      <span class="adm-log-time">${fmtTime(b.at)}</span>
      <span class="adm-log-mail">${esc(b.ip)}</span>
      <span class="adm-log-res">${b.reason === 'manual' ? 'admin' : 'spam'}${Number(b.hits) > 1 ? ` ×${Number(b.hits)}` : ''}</span>
      <button class="tag tag-grant" data-act="unban-ip" data-id="${esc(b.ip)}">Buka blokir</button>
    </div>`).join('') || '<div class="empty-state">Tidak ada IP yang diblokir.</div>';

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
    failed: 'gagal', logout: 'keluar', blocked: 'daftar diblokir',
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
  // blokir / buka blokir IP (anti-spam pendaftaran)
  if (act === 'unban-ip') {
    try {
      await api('/api/admin/ip-bans/unban', { method: 'POST', body: { ip: id } });
      admMsg('admMsg', `IP ${id} dibuka blokirnya — kuota pendaftaran IP direset`, false);
      await refreshAdminMonitor();
    } catch (err) { admMsg('admMsg', err.message, true); }
    return;
  }
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

// peristiwa admin yang layak ditonjolkan: kartu notifikasi + bunyi khusus
const ADMIN_ALERT_EVENTS = new Set(['registered', 'approved', 'rejected', 'banned', 'unbanned', 'ip_banned']);

// peristiwa real-time dari server (pendaftaran, masuk/daring, blokir)
function onAdminEvent(ev) {
  if (!ev || !ev.type) return;
  const who = ev.user?.name || ev.name || ev.user?.email || '';
  const label = ADMIN_EVENT_LABEL[ev.type];
  const drawerOpen = $('adminDrawer') && !$('adminDrawer').classList.contains('hidden');
  const isAlert = ADMIN_ALERT_EVENTS.has(ev.type);
  const title = ev.type === 'registered' ? 'Pendaftar baru'
    : ev.type === 'ip_banned' ? 'IP Diblokir (Anti-Spam)'
    : 'Panel admin';
  const body = `${who} ${label || 'memperbarui akun'}`;
  const payload = { title, body, tag: 'wa-admin', silent: true };

  // tersimpan di pusat notifikasi (badge lonceng) supaya tak terlewat.
  // ref memuat waktu peristiwa: tab lain yang menerima event identik tidak
  // menduplikasi, sedangkan peristiwa berulang tetap tercatat terpisah.
  if (isAlert || ev.type === 'login') {
    const at = ev.at || Date.now();
    ncAdd({
      kind: 'admin',
      title,
      body,
      ref: `admin-${ev.type}-${ev.user?.id || ev.userId || who}-${at}`,
      at,
    });
  }

  // bunyi khusus panel admin — berbeda dari nada pesan masuk
  if (isAlert && NOTIF.sound) adminAlert();

  if (drawerOpen) {
    if (label) admMsg('admMsg', body, ev.type === 'rejected' || ev.type === 'banned');
    clearTimeout(adm.timer);
    adm.timer = setTimeout(refreshAdminMonitor, 250);
    return;
  }

  // panel tertutup: kartu notifikasi ala WhatsApp, lalu notifikasi sistem
  const visible = document.visibilityState === 'visible';
  const focused = visible && document.hasFocus();
  if (isAlert && visible) showNotifCard(payload);
  if (!focused) void showSystemNotif(payload);
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
      <div class="adm-plan-row">
        <input type="number" min="0" max="100000" step="1" value="${Math.round((Number(p.storageLimit) || 0) / 1000 ** 3)}" data-plan-storage="${i}" aria-label="Storage GB" />
        <span class="adm-plan-unit">GB storage</span>
      </div>
      <small class="adm-plan-hint">${p.permanen ? 'Paket permanen — masa aktif selamanya' : 'Limit 0 = tanpa batas'} • Storage foto/video/file (0 = pakai dasar 2&nbsp;GB)${(p.excluded || []).length ? ` • ${p.excluded.length} bot eksklusif ditutup` : ''}</small>
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
  // label/harga/limit/storageGB diedit; id, bot eksklusif & sifat permanen ikut dikirim utuh
  const plans = adm.plans.map((p, i) => ({
    ...p,
    label: (document.querySelector(`[data-plan-label="${i}"]`)?.value || p.label).trim(),
    days: val(`[data-plan-days="${i}"]`, Number(p.days) || 1),
    price: val(`[data-plan-price="${i}"]`, Number(p.price) || 0),
    dailyLimit: val(`[data-plan-limit="${i}"]`, Number(p.dailyLimit) || 0),
    storageLimit: Math.max(0, Math.round(val(`[data-plan-storage="${i}"]`, Math.round((Number(p.storageLimit) || 0) / 1000 ** 3)) * 1000 ** 3)),
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

// simpan teks halaman daftar (sapaan {nama} + pesan blokir anti-spam)
$('btnSaveRegText').addEventListener('click', async () => {
  const body = { regText: { greeting: $('admRegGreet').value, blocked: $('admRegBlock').value } };
  try {
    const data = await api('/api/admin/settings', { method: 'PUT', body });
    adm.regText = data.regText || body.regText;
    $('admRegGreet').value = adm.regText.greeting || '';
    $('admRegBlock').value = adm.regText.blocked || '';
    regGreetLoaded = false; // teks terbaru diambil lagi saat halaman daftar dibuka
    admMsg('admRegMsg', 'Teks halaman daftar disimpan ✓', false);
  } catch (err) { admMsg('admRegMsg', err.message, true); }
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

/* dering berulang selama menunggu jawaban: nada ganda untuk panggilan masuk
   (plus getar loop), ringback pelan untuk panggilan keluar */
const RING = { timer: null, mode: null };

function ringBurst(mode) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const notes = mode === 'in'
      ? [[941.2, 0], [1477.7, .05], [941.2, .62], [1477.7, .67]]
      : [[425, 0], [450, .5]];
    notes.forEach(([freq, delay]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine';
      o.frequency.value = freq;
      const s = t + delay;
      const dur = mode === 'in' ? .34 : .42;
      g.gain.setValueAtTime(.0001, s);
      g.gain.exponentialRampToValueAtTime(.15, s + .02);
      g.gain.exponentialRampToValueAtTime(.0001, s + dur);
      o.start(s);
      o.stop(s + dur + .04);
    });
  } catch { beep('notif'); }
}

function startRingTone(mode) {
  stopRingTone();
  RING.mode = mode;
  const tick = () => {
    if (NOTIF.sound) ringBurst(mode);
    if (mode === 'in') vibrate([350, 180, 350, 180, 350]);
  };
  tick();
  RING.timer = setInterval(tick, mode === 'in' ? 2600 : 4600);
}

function stopRingTone() {
  if (RING.timer) clearInterval(RING.timer);
  RING.timer = null;
  RING.mode = null;
  try { navigator.vibrate && navigator.vibrate(0); } catch { /* noop */ }
}

function blankCall(fields) {
  return {
    startedAt: null, timer: null, ringTimer: null, connectTimer: null, dropTimer: null,
    pendingSignals: [], pc: null, localStream: null, peerReady: null, speaker: true,
    ...fields,
  };
}

$('btnCallVoice').addEventListener('click', () => startCall('audio'));
$('btnCallVideo').addEventListener('click', () => startCall('video'));

function startCall(kind) {
  const chat = currentChat();
  if (chat && chat.type === 'group') { toast('Panggilan hanya tersedia di chat pribadi'); return; }
  if (!chat || !chat.peer) { toast('Pilih chat terlebih dahulu'); return; }
  if (chat.peer.isBot) { toast('Bot tidak bisa dipanggil'); return; }
  if (S.call) { toast('Sedang dalam panggilan lain'); return; }
  if (!S.socket || !S.socket.connected) { toast('Tidak terhubung ke server'); return; }

  const call = blankCall({
    callId: newCallId(), peer: chat.peer, kind,
    incoming: false, state: 'calling', mic: true, cam: kind === 'video',
  });
  S.call = call;
  openCallUI(call);
  setCallState('Menghubungkan...');
  // minta mikrofon/kamera SEKARANG juga, masih dalam rangkaian klik pengguna —
  // aplikasi terpasang (PWA) kadang menuntut getUserMedia lahir dari gestur
  void ensurePeer().catch(() => {});

  S.socket.emit('call:invite', { to: chat.peer.id, callId: call.callId, kind }, (res) => {
    if (S.call !== call) {
      // panggilan sudah dibatalkan lokal (mis. izin media ditolak) SEBELUM server
      // sempat membalas — hangup tadi bisa tiba di server lebih dulu dan jadi
      // no-op, jadi tutup lagi setelah server mengonfirmasi panggilan dibuat
      if (res?.ok) S.socket?.emit('call:hangup', { to: chat.peer.id, callId: call.callId });
      return;
    }
    if (!res?.ok) {
      toast(res?.error || 'Tidak dapat menghubungi pengguna');
      closeCall();
      return;
    }
    call.state = 'ringing';
    setCallState('Berdering...');
    startRingTone('out'); // nada ringback berulang sampai dijawab / ditutup
    armRingTimeout(call);
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
  // dering yang sama dikirim ulang saat perangkat kembali daring: jangan dobel
  if (S.call && S.call.callId === callId) return;
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
  startRingTone('in'); // dering ganda + getar loop selama layar dering tampil
  // layar terbuka tanpa fokus tetap memberi tahu sistem ala WhatsApp
  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    void showSystemNotif({
      type: 'call',
      title: cleanKind === 'video' ? 'Panggilan video masuk' : 'Panggilan suara masuk',
      body: from.name,
      tag: `call-${callId}`,
      icon: from.avatar || null,
      chatId: null,
    });
  }
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

  stopRingTone();
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

// tentukan izin mana yang bermasalah dari kegagalan getUserMedia
async function mediaFailKind(call, err) {
  const name = (err && err.name) || '';
  if (call.kind !== 'video') return 'microphone';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'camera';
  try {
    if (navigator.permissions) {
      const cam = await navigator.permissions.query({ name: 'camera' }).catch(() => null);
      if (cam && cam.state === 'denied') return 'camera';
      const mic = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
      if (mic && mic.state === 'denied') return 'microphone';
    }
  } catch { /* fallback di bawah */ }
  return 'camera';
}

async function createPeer(call) {
  const pc = new RTCPeerConnection(ICE);
  call.pc = pc;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('Akses kamera/mikrofon butuh HTTPS atau localhost');
    abortCall(call, err.message);
    openPermHelp(call.kind === 'video' ? 'camera' : 'microphone');
    throw err;
  }

  /* Catatan penting untuk aplikasi terpasang (PWA / "Tambahkan ke Layar Utama"):
     status dari navigator.permissions.query() bisa keliru (sering "denied"
     padahal izin asli masih ada), sehingga dulu panggilan mati sebelum
     mikrofon sempat dicoba. Sekarang getUserMedia SELALU dicoba lebih dulu —
     galat nyatalah yang menentukan (lalu diarahkan ke panduan). */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call.kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (err) {
    const kind = await mediaFailKind(call, err);
    const info = mediaErrorInfo(err, kind);
    abortCall(call, info.msg);
    if (info.perm) openPermHelp(kind);
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
    clearTimeout(call.ringTimer); // jalur media terbentuk: dering tak boleh mematikan panggilan
    stopRingTone();
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
      clearTimeout(call.ringTimer);
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
      clearTimeout(call.ringTimer); // penerima sudah menjawab: masa dering selesai
      stopRingTone();
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

function chatIdForPeer(peerId) {
  if (!peerId) return null;
  const chat = S.chats.find((c) => c.type !== 'group' && c.peer && c.peer.id === peerId);
  return chat ? chat.id : null;
}

function callNotifVisible() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/* Panggilan tak terjawab (masuk) — notifikasi ala WhatsApp:
   lewat socket saat daring, lewat push saat luring, disinkronkan saat aplikasi dibuka */
function onCallMissed(data) {
  if (!data || !data.callId) return;
  const chatId = data.chatId || chatIdForPeer(data.from && data.from.id);
  ncAdd({
    kind: 'call',
    title: data.title || 'Panggilan tak terjawab',
    body: data.body || (data.from ? data.from.name : ''),
    chatId,
    icon: data.icon || (data.from ? data.from.avatar : null),
    at: data.at || Date.now(),
    ref: `call-${data.callId}`,
  });
  if (NOTIF.sound) notifSound();
  vibrate([70, 40, 70]);
  if (!callNotifVisible()) {
    void showSystemNotif({ ...data, chatId, tag: data.tag || `call-${data.callId}` });
  }
}

/* Riwayat panggilan keluar (tidak dijawab / ditolak) masuk pusat notifikasi */
function onCallLog(data) {
  if (!data || !data.callId) return;
  ncAdd({
    kind: 'call',
    title: data.title || 'Panggilan',
    body: data.body || '',
    chatId: data.chatId || chatIdForPeer(data.peerId),
    icon: data.icon || null,
    at: data.at || Date.now(),
    ref: `calllog-${data.callId}`,
  });
}

/* Notifikasi push bertipe panggilan dari service worker */
function onCallPush(data) {
  if (!data) return;
  if (data.action === 'ring' && data.callId && data.from) {
    onCallIncoming({ callId: data.callId, kind: data.kind, from: data.from });
    return;
  }
  if (data.action === 'missed' && data.callId) onCallMissed(data);
}

/* Tarik riwayat panggilan tak terjawab sekali saat aplikasi dibuka supaya
   notifikasi yang terlewat (aplikasi tertutup) tetap muncul di Pusat Notifikasi */
async function syncMissedCalls() {
  try {
    const since = Date.now() - 7 * 86_400_000;
    const data = await api(`/api/calls?since=${since}`);
    for (const c of data.calls || []) {
      if (!c || !c.id) continue;
      ncAdd({
        kind: 'call',
        title: c.direction === 'incoming' ? 'Panggilan tak terjawab' : 'Panggilan tidak dijawab',
        body: `${c.peer ? c.peer.name : 'Kontak'} • ${c.kind === 'video' ? 'Video' : 'Suara'}`,
        chatId: c.chatId || chatIdForPeer(c.peer && c.peer.id),
        icon: c.peer ? c.peer.avatar : null,
        at: c.at,
        ref: `call-${c.id}`,
      });
    }
  } catch { /* riwayat pelengkap, bukan kewajiban */ }
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
  call.speaker = true;
  $('btnToggleSpeaker').classList.remove('off');
  $('btnToggleSpeaker').disabled = false;
  void applySpeaker(true); // keluaran bawaan: speaker menyala
  $('callTimer').textContent = '00:00';
  $('activeCall').classList.remove('hidden');
}

// speaker aktif = keluaran bawaan; mati = earpiece bila tersedia, kalau tidak
// tidak ada earpiece di perangkat -> suara lawan dibisukan (fallback aman)
async function applySpeaker(on) {
  const v = $('remoteVideo');
  if (!v) return;
  try {
    if (!on && typeof v.setSinkId === 'function' && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const ear = devices.find((d) => d.kind === 'audiooutput' && /earpiece|receiver|ear.?phone|hands-free/i.test(d.label || ''));
      if (ear && ear.deviceId) {
        await v.setSinkId(ear.deviceId);
        v.muted = false;
        return;
      }
    }
    if (typeof v.setSinkId === 'function' && v.sinkId && v.sinkId !== 'default') await v.setSinkId('default');
    v.muted = !on;
  } catch { v.muted = !on; }
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
  stopRingTone(); // dering/getar berhenti apa pun penyebab penutupan
  if (!call) return;
  clearInterval(call.timer);
  clearTimeout(call.ringTimer);
  clearTimeout(call.connectTimer);
  clearTimeout(call.dropTimer);
  call.pendingSignals.length = 0;
  // rantai proses sinyal lama tidak boleh menahan offer/ICE panggilan berikutnya
  drainChain = Promise.resolve();
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

/* Purna tugas halaman: tutup panggilan & perekam supaya mikrofon tidak tetap
   menyala dan panggilan lawan tidak ditinggal menggantung sampai sapu bersih. */
window.addEventListener('pagehide', () => {
  if (rec && !rec.done) stopRecording(false);
  const call = S.call;
  if (!call) return;
  try { S.socket?.emit('call:hangup', { to: call.peer.id, callId: call.callId }); } catch { /* noop */ }
  closeCall();
});

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
$('btnToggleSpeaker').addEventListener('click', async () => {
  const call = S.call;
  if (!call) return;
  call.speaker = !call.speaker;
  $('btnToggleSpeaker').classList.toggle('off', !call.speaker);
  await applySpeaker(call.speaker);
  toast(call.speaker ? 'Speaker aktif' : 'Speaker mati');
});

/* ================= misc ui ================= */
/* mode "layar HP": viewport sempit ATAU container aplikasi 480px (frame desktop) */
function phoneUI() {
  if (window.matchMedia('(max-width: 760px)').matches) return true;
  const v = $('appView');
  return !!v && v.offsetWidth <= 480;
}

// kembali ke daftar chat (tombol ‹ di action bar atas percakapan & gesture tepi)
function closeChat(opts = {}) {
  clearReply();
  const view = $('appView');
  if (opts.animate && phoneUI()) {
    view.style.transition = 'transform .2s ease';
    view.style.transform = 'translateX(24px)';
    view.style.opacity = '.55';
    setTimeout(() => {
      view.style.transition = '';
      view.style.transform = '';
      view.style.opacity = '';
    }, 210);
  } else {
    view.style.transition = '';
    view.style.transform = '';
    view.style.opacity = '';
  }
  view.classList.remove('chat-open');
  S.activeChatId = null;
  $('chatActive').classList.add('hidden');
  $('chatEmpty').classList.remove('hidden');
  renderChatList();
}
$('btnBack').addEventListener('click', () => closeChat());

// tutup foto/video sekali lewat satu jalur (tombol X, Esc, gesture tepi)
function closeViewOnce() {
  const viewer = $('voViewer');
  if (!viewer || viewer.classList.contains('hidden')) return false;
  releaseVoBlob();
  const stage = $('voStage');
  if (stage) {
    stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch { /* abaikan */ } });
    stage.innerHTML = '';
  }
  viewer.classList.add('hidden');
  return true;
}

// gesture tepi: usap dari kiri ke kanan untuk kembali (rasa iOS/native)
function bindEdgeBack() {
  let st = null;
  const view = () => $('appView');
  const EASE_OUT = 'cubic-bezier(.22,1,.36,1)'; // close: cepat lalu pelan (spring keluar)
  const EASE_BACK = 'cubic-bezier(.32,.72,0,1)'; // batal: kembali mengikuti jari (spring balik)
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX > 26) return; // hanya dari tepi kiri
    const voOpen = $('voViewer') && !$('voViewer').classList.contains('hidden');
    const storyOpen = $('storyViewer') && !$('storyViewer').classList.contains('hidden');
    const drawerOpen = DRAWERS.some((d) => !$(d).classList.contains('hidden'))
      || ($('scrim') && !$('scrim').classList.contains('hidden'));
    // drawer/panel lain sedang menutupi layar -> gesture tepi dibiarkan untuk mereka
    if (drawerOpen && !voOpen && !storyOpen) return;
    if (!view().classList.contains('chat-open') && !voOpen) return;
    st = { x: t.clientX, y: t.clientY, t0: performance.now(), lastX: t.clientX, lastT: performance.now(), active: false, dx: 0, vx: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st) return;
    const t = e.touches[0];
    const dx = t.clientX - st.x;
    const dy = Math.abs(t.clientY - st.y);
    const now = performance.now();
    if (!st.active) {
      // tentukan arah setelah jarak cukup; geser ke kanan dominan -> aktif
      if (dx > 10 && dx > dy * 1.15) st.active = true;
      else if (dx < -8 || dy > 16) { st = null; return; }
      else return;
    }
    if (e.cancelable) e.preventDefault();
    st.dx = dx;
    // kecepatan sentuh (px/ms) utk trigger usapan cepat ala WA
    const dt = now - st.lastT;
    if (dt > 0) st.vx = (t.clientX - st.lastX) / dt;
    st.lastX = t.clientX;
    st.lastT = now;
    const v = view();
    const over = $('voViewer') && !$('voViewer').classList.contains('hidden');
    const d = Math.max(0, Math.min(window.innerWidth * 0.85, dx));
    if (over) {
      const el = $('voViewer');
      el.style.willChange = 'transform, opacity';
      el.style.transition = 'none';
      el.style.transform = `translateX(${d}px)`;
      el.style.opacity = String(Math.max(0.25, 1 - (d / window.innerWidth) * 0.45));
    } else {
      v.style.willChange = 'transform, opacity';
      v.style.transition = 'none';
      v.style.transform = `translateX(${d}px)`;
      // parallax: view sedikit redup mengikuti jari (rasa native)
      v.style.opacity = String(Math.max(0.4, 1 - (d / window.innerWidth) * 0.5));
    }
  }, { passive: false });
  const finish = () => {
    if (!st) return;
    const over = $('voViewer') && !$('voViewer').classList.contains('hidden');
    const v = view();
    // trigger: jarak cukup ATAU usapan cepat (velocity tinggi walau jarak sedang)
    const fired = st.active && (st.dx >= 72 || (st.vx > 0.55 && st.dx > 28));
    const resetStyles = (el) => {
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
      el.style.willChange = '';
    };
    if (over) {
      const el = $('voViewer');
      el.style.transition = `transform .26s ${EASE_OUT}, opacity .26s ${EASE_OUT}`;
      if (fired) { el.style.transform = 'translateX(100%)'; el.style.opacity = '0'; }
      else { el.style.transform = ''; el.style.opacity = ''; }
      setTimeout(() => {
        resetStyles(el);
        if (fired) closeViewOnce();
      }, fired ? 270 : 0);
    } else if (v.classList.contains('chat-open')) {
      v.style.transition = `transform .26s ${EASE_OUT}, opacity .26s ${EASE_OUT}`;
      if (fired) {
        v.style.transform = 'translateX(100%)';
        v.style.opacity = '0';
        setTimeout(() => {
          resetStyles(v);
          closeChat();
        }, 265);
      } else {
        v.style.transition = `transform .24s ${EASE_BACK}, opacity .24s ${EASE_BACK}`;
        v.style.transform = '';
        v.style.opacity = '';
        setTimeout(() => { resetStyles(v); }, 250);
      }
    }
    st = null;
  };
  document.addEventListener('touchend', finish);
  document.addEventListener('touchcancel', finish);
}

// keyboard: composer tidak boleh tertutup keyboard (visualViewport, rasa app native)
// ukur jarak nyata composer vs tepi keyboard -> aman dari dobel-offset saat 100dvh ikut mengecil
function bindViewportKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
    const open = kb > 90;
    document.documentElement.classList.toggle('kb-open', open);
    let inset = 0;
    if (open) {
      const composer = document.querySelector('#appView.chat-open .composer') || document.querySelector('.composer');
      if (composer) {
        const r = composer.getBoundingClientRect();
        const covered = r.bottom - (vv.height + (vv.offsetTop || 0));
        if (covered > 4) inset = Math.min(covered, kb);
      }
    }
    document.documentElement.style.setProperty('--kb-inset', inset + 'px');
    // saat keyboard muncul, tetap di posisi pesan terakhir bila memang sedang di bawah
    if (open && S.activeChatId && UI.nearBottom) {
      const box = $('messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // hierarki tutup: overlay foto -> drawer -> menu lampiran -> story -> chat
    if (closeViewOnce()) return;
    if (!$('storyViewer').classList.contains('hidden')) { closeStory(); return; }
    const anyDrawer = DRAWERS.some((d) => !$(d).classList.contains('hidden'));
    closeDrawers();
    if (anyDrawer) return;
    if (!$('attachMenu').classList.contains('hidden')) { $('attachMenu').classList.add('hidden'); return; }
    if ($('appView').classList.contains('chat-open') && phoneUI()) closeChat();
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
  updateAppBadge(); // lencana aplikasi (icon dock/taskbar) mengikuti jumlah tak terbaca
}

/* ================= status wa ================= */
const STATUS_BG = ['#008069', '#1d6fd1', '#7c3aed', '#d5504f', '#c2410c', '#111b21'];
S.statusBg = STATUS_BG[0];
S.statusDraft = { media: null };
S.statusTags = [];
S.statusTagGroups = [];
S.statusTagTab = 'users';
initStatusColors();

/* ---- tag status: pilih pengguna / grup yang ditandai ---- */
let statusTagUsers = null;

function renderStatusTagTabs() {
  document.querySelectorAll('.status-tag-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tagtab === S.statusTagTab));
}

function renderStatusTagList() {
  const list = $('statusTagList');
  if (S.statusTagTab === 'groups') {
    const groups = (S.chats || []).filter((c) => c.type === 'group');
    if (!groups.length) { list.innerHTML = '<div class="status-tag-hint">Belum ada grup untuk ditandai.</div>'; return; }
    list.innerHTML = groups.map((g) => `
      <button type="button" class="status-tag-item ${S.statusTagGroups.includes(g.id) ? 'picked' : ''}" data-taggroup="${g.id}">
        <span class="avatar"><span>${esc((g.name || 'G').charAt(0).toUpperCase())}</span></span>
        <span><strong>${esc(g.name || 'Grup')}</strong><small>${esc(String(g.memberCount || ''))}</small></span>
        <span class="status-tag-check">✓</span>
      </button>`).join('');
    list.querySelectorAll('[data-taggroup]').forEach((b) => {
      const g = groups.find((x) => x.id === b.dataset.taggroup);
      if (g) setAvatar(b.querySelector('.avatar'), { name: g.name, avatar: g.avatar });
      b.addEventListener('click', () => toggleStatusTagGroup(b.dataset.taggroup));
    });
    return;
  }
  if (!statusTagUsers) { list.innerHTML = '<div class="status-tag-hint">Memuat kontak...</div>'; return; }
  if (!statusTagUsers.length) { list.innerHTML = '<div class="status-tag-hint">Belum ada kontak untuk ditandai.</div>'; return; }
  list.innerHTML = statusTagUsers.map((u) => `
    <button type="button" class="status-tag-item ${S.statusTags.includes(u.id) ? 'picked' : ''}" data-taguser="${u.id}">
      <span class="avatar"><span>${esc((u.name || '?').charAt(0).toUpperCase())}</span></span>
      <span><strong>${esc(u.name)}${badge(u.verified)}</strong><small>${esc(u.email || '')}</small></span>
      <span class="status-tag-check">✓</span>
    </button>`).join('');
  list.querySelectorAll('[data-taguser]').forEach((b) => {
    const u = statusTagUsers.find((x) => x.id === b.dataset.taguser);
    if (u) setAvatar(b.querySelector('.avatar'), { name: u.name, avatar: u.avatar });
    b.addEventListener('click', () => toggleStatusTag(b.dataset.taguser));
  });
}

function renderStatusTagChips() {
  const wrap = $('statusTagChips');
  const groups = (S.chats || []).filter((c) => c.type === 'group' && S.statusTagGroups.includes(c.id));
  wrap.classList.toggle('hidden', !S.statusTags.length && !groups.length);
  const userChips = S.statusTags.map((id) => {
    const u = (statusTagUsers || []).find((x) => x.id === id);
    return `<span class="tag-chip">@ ${esc(u ? u.name : 'Pengguna')}<button type="button" class="tag-x" data-untag="${id}" aria-label="Hapus tanda">✕</button></span>`;
  }).join('');
  const groupChips = groups.map((g) =>
    `<span class="tag-chip">@ ${esc(g.name || 'Grup')}<button type="button" class="tag-x" data-untaggroup="${g.id}" aria-label="Hapus tanda grup">✕</button></span>`
  ).join('');
  wrap.innerHTML = userChips + groupChips;
  wrap.querySelectorAll('[data-untag]').forEach((b) => b.addEventListener('click', () => toggleStatusTag(b.dataset.untag)));
  wrap.querySelectorAll('[data-untaggroup]').forEach((b) => b.addEventListener('click', () => toggleStatusTagGroup(b.dataset.untaggroup)));
}

function toggleStatusTag(id) {
  const i = S.statusTags.indexOf(id);
  if (i >= 0) S.statusTags.splice(i, 1);
  else {
    if (S.statusTags.length >= 10) { toast('Maksimal 10 orang yang bisa ditandai'); return; }
    S.statusTags.push(id);
  }
  renderStatusTagChips();
  renderStatusTagList();
}

function toggleStatusTagGroup(id) {
  const i = S.statusTagGroups.indexOf(id);
  if (i >= 0) S.statusTagGroups.splice(i, 1);
  else {
    if (S.statusTagGroups.length >= 3) { toast('Maksimal 3 grup yang bisa ditandai'); return; }
    S.statusTagGroups.push(id);
  }
  renderStatusTagChips();
  renderStatusTagList();
}

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
      ? `<video src="${esc(media.url)}" muted playsinline controls preload="metadata"></video>`
      : `<img src="${esc(media.url)}" alt="">`;
  } else {
    box.style.background = S.statusBg;
    box.innerHTML = `<span>${esc(text) || 'Tulis status Anda...'}</span>`;
  }
}

function openStatusComposer() {
  $('statusText').value = '';
  S.statusDraft = { media: null };
  S.statusTags = [];
  S.statusTagGroups = [];
  S.statusTagTab = 'users';
  renderStatusTagTabs();
  $('statusTagPanel').classList.add('hidden');
  $('btnStatusTag').setAttribute('aria-pressed', 'false');
  renderStatusTagChips();
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
      <div class="chat-item-top"><strong>${esc(u.name)}${badge(u.verified)}</strong>${!isMine && s && s.taggedMe ? '<span class="status-tagged-chip">＠ Anda ditandai</span>' : ''}</div>
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
  $('storyComments').classList.add('hidden');
  clearStoryReply();
  S.storyCmtLoaded = null;
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
  $('storyCaption').textContent = s.body || '';
  $('storyCaption').classList.toggle('hidden', !s.body);
  $('btnDeleteStory').classList.toggle('hidden', !s.isMine);
  $('storyViews').classList.toggle('hidden', !s.isMine);
  if (s.isMine) $('storyViews').textContent = `👁 ${s.viewCount} dilihat`;
  $('storyTime').textContent = fmtStatusTime(s.createdAt) + (s.taggedMe ? ' • menyebut Anda' : '');
  $('storyCmtCount').textContent = String(s.commentCount || 0);
  $('scCount').textContent = String(s.commentCount || 0);
  S.storyComments = [];
  S.storyCmtLoaded = null;
  clearStoryReply();
  $('storyComments').classList.add('hidden');
  syncStoryReplyForm();

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
    // bilah progres mengikuti durasi video nyata (bukan timer tetap 7 detik)
    const tick = () => {
      if (story.video !== video || !bar) return;
      const d = video.duration;
      const p = Number.isFinite(d) && d > 0 ? Math.min(1, video.currentTime / d) : 0;
      bar.style.setProperty('--p', `${p * 100}%`);
    };
    video.addEventListener('loadedmetadata', tick);
    video.addEventListener('timeupdate', tick);
    video.addEventListener('seeked', tick);
    tick();
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

/* ---- komentar status: buka panel, kirim, balas, hapus ---- */
function currentStoryStatus() {
  const g = story.groups[story.gi];
  return g && g.statuses[story.si] ? g.statuses[story.si] : null;
}

function findFeedStatus(id) {
  for (const g of S.statusFeed || []) {
    for (const s of g.statuses || []) if (s.id === id) return s;
  }
  return null;
}

function syncStoryReplyForm() {
  const st = currentStoryStatus();
  const show = st && !st.isMine ? true : !!S.storyReplyTo;
  $('storyReplyForm').classList.toggle('hidden', !show);
}

async function loadStoryComments() {
  const st = currentStoryStatus();
  if (!st) return;
  S.storyCmtLoaded = null;
  try {
    const data = await api(`/api/status/${st.id}/comments`);
    if (currentStoryStatus() !== st) return;
    S.storyComments = data.comments || [];
    S.storyCmtLoaded = st.id;
    st.commentCount = S.storyComments.length;
    renderStoryComments();
  } catch (err) { /* status mungkin kedaluwarsa */ }
}

function renderStoryComments() {
  const list = $('scList');
  const comments = S.storyComments || [];
  const st = currentStoryStatus();
  $('scCount').textContent = String(comments.length);
  if (st) $('storyCmtCount').textContent = String(st.commentCount || 0);
  if (!comments.length) {
    list.innerHTML = '<div class="sc-empty">Belum ada komentar. Jadilah yang pertama!</div>';
    return;
  }
  list.innerHTML = comments.map((c) => `
    <div class="sc-item" data-cmt="${c.id}">
      <span class="avatar"><span>${esc((c.name || '?').charAt(0).toUpperCase())}</span></span>
      <div class="sc-body-wrap">
        <div class="sc-meta"><strong>${esc(c.name || 'Pengguna')}${badge(c.verified)}</strong><small>${fmtStatusTime(c.createdAt)}</small></div>
        ${c.replyTo ? `<div class="sc-quote"><strong>Balasan untuk ${esc(c.replyToName || 'seseorang')}</strong><small>${esc(c.replyToBody || '')}</small></div>` : ''}
        <div class="sc-text">${esc(c.body)}</div>
        <div class="sc-actions">
          <button type="button" data-reply="${c.id}">Balas</button>
          ${(c.mine || (st && st.isMine)) ? `<button type="button" class="danger" data-delcmt="${c.id}">Hapus</button>` : ''}
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('.sc-item').forEach((item) => {
    const c = comments.find((x) => x.id === item.dataset.cmt);
    if (c) setAvatar(item.querySelector('.avatar'), { name: c.name, avatar: c.avatar });
    const rb = item.querySelector('[data-reply]');
    if (rb) rb.addEventListener('click', () => setStoryReply(c));
    const del = item.querySelector('[data-delcmt]');
    if (del) del.addEventListener('click', () => deleteStoryComment(item.dataset.cmt));
  });
}

function setStoryReply(c) {
  S.storyReplyTo = c;
  $('storyReplyName').textContent = c.name || 'Pengguna';
  $('storyReplyBody').textContent = c.body || '';
  $('storyReplyQuote').classList.remove('hidden');
  syncStoryReplyForm();
  $('storyReplyInput').focus();
}

function clearStoryReply() {
  S.storyReplyTo = null;
  $('storyReplyQuote').classList.add('hidden');
  $('storyReplyName').textContent = '';
  $('storyReplyBody').textContent = '';
  syncStoryReplyForm();
}

$('btnOpenComments').addEventListener('click', () => {
  const panel = $('storyComments');
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  if (willOpen) {
    S.storyComments = [];
    syncStoryReplyForm();
    loadStoryComments();
  } else {
    clearStoryReply();
  }
});
$('btnCloseComments').addEventListener('click', () => {
  $('storyComments').classList.add('hidden');
  clearStoryReply();
});
$('btnCancelStoryReply').addEventListener('click', clearStoryReply); // tombol ✕ di form komentar story

$('storyReplyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = currentStoryStatus();
  if (!st) return;
  const body = $('storyReplyInput').value.trim();
  if (!body) return;
  try {
    const payload = { body };
    if (S.storyReplyTo) payload.replyTo = S.storyReplyTo.id;
    const data = await api(`/api/status/${st.id}/comments`, { method: 'POST', body: payload });
    $('storyReplyInput').value = '';
    S.storyComments = S.storyComments || [];
    if (!S.storyComments.some((c) => c.id === data.comment.id)) S.storyComments.push(data.comment);
    S.storyCmtLoaded = st.id;
    st.commentCount = S.storyComments.length;
    renderStoryComments();
    clearStoryReply();
  } catch (err) { toast(err.message); }
});

async function deleteStoryComment(id) {
  const st = currentStoryStatus();
  if (!st) return;
  try {
    await api(`/api/status/${st.id}/comments/${id}`, { method: 'DELETE' });
    S.storyComments = (S.storyComments || []).filter((c) => c.id !== id);
    if (S.storyCmtLoaded === st.id) st.commentCount = S.storyComments.length;
    else st.commentCount = Math.max(0, Number(st.commentCount || 1) - 1);
    renderStoryComments();
  } catch (err) { toast(err.message); }
}

$('statusText').addEventListener('input', renderStatusPreview);
$('btnCloseStatus').addEventListener('click', closeDrawers);
$('btnStatusMedia').addEventListener('click', () => $('statusInput').click());

document.querySelectorAll('.status-tag-tab').forEach((t) => {
  t.addEventListener('click', () => {
    S.statusTagTab = t.dataset.tagtab;
    renderStatusTagTabs();
    renderStatusTagList();
  });
});

$('btnStatusTag').addEventListener('click', async () => {
  const panel = $('statusTagPanel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('btnStatusTag').setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) {
    renderStatusTagTabs();
    renderStatusTagList();
    if (statusTagUsers === null) {
      try {
        const data = await api('/api/contacts?limit=100');
        statusTagUsers = (data.users || []).filter((u) => u.id !== S.me?.id);
      } catch (err) {
        statusTagUsers = [];
        toast(err.message);
      }
      renderStatusTagList();
      renderStatusTagChips();
    }
  }
});

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
    const tags = (S.statusTags || []).slice(0, 10);
    const tagGroups = (S.statusTagGroups || []).slice(0, 3);
    if (media) {
      payload = { type: media.type === 'video' ? 'video' : 'image', media: { url: media.url, name: media.name, mime: media.mime }, body, tags, tagGroups };
    } else {
      payload = { type: 'text', body, bg: S.statusBg, tags, tagGroups };
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
$('btnCloseGroupInfo').addEventListener('click', closeDrawers);

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
    const isAdmin = chat.role === 'admin' || !!(S.me && S.me.role === 'admin');
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
      <div class="profile-section" id="giBotSection">
        <span class="ps-label">Bot grup</span>
        ${(() => {
          const bot = members.find((m) => m.isBot);
          if (bot) {
            return `
              <div class="member-item">
                <div class="avatar"><span>🤖</span></div>
                <div class="member-meta">
                  <strong>${esc(bot.name)}${badge(true)}</strong>
                  <small>Bot aktif di grup ini</small>
                </div>
                ${isAdmin ? `<button class="icon-btn" id="giBotRemove" type="button" title="Keluarkan bot"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-exit" /></svg></button>` : ''}
              </div>
              <p class="wp-hint">Sebut bot dengan @${esc(bot.name)} atau balas pesan bot untuk memakainya. Hanya anggota premium yang bisa memanggil bot.</p>`;
          }
          if (!isAdmin) return `<p class="wp-hint">Belum ada bot di grup ini. Hanya admin grup yang bisa memasang bot.</p>`;
          return `
            <p class="wp-hint">Pasang satu bot untuk memperkaya grup — khusus admin &amp; pengguna premium. Sebut dengan @NamaBot untuk memakainya.</p>
            <button class="btn-ghost" id="giBotAdd" type="button">🤖 Pasang bot ke grup</button>
            <div class="chat-list hidden" id="giBotPicker"></div>`;
        })()}
      </div>
      <div class="profile-section" id="giInviteSection">
        <span class="ps-label">Link undangan grup</span>
        <div class="invite-row">
          <input type="text" id="giInviteLink" readonly value="Memuat link..." />
          <button class="icon-btn" id="giInviteCopy" type="button" title="Salin link"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-copy" /></svg></button>
        </div>
        <div class="invite-actions">
          <button class="btn-ghost" id="giInviteShare" type="button">Bagikan</button>
          ${isAdmin ? '<button class="btn-ghost" id="giInviteReset" type="button">Regenerate</button>' : ''}
        </div>
        <p class="wp-hint">Siapa pun yang membuka link ini (dan sudah punya akun aktif) bisa langsung bergabung ke grup.</p>
      </div>
      ${muteRowHtml(chat, 'giMuteToggle')}
      <div class="ps-label" style="padding:0 4px 8px">Anggota</div>
      <div class="member-list" id="giMembers"></div>
      <button class="btn-ghost danger" id="giLeave"><svg viewBox="0 0 24 24" class="btn-ico"><use href="#ic-exit" /></svg> Keluar dari grup</button>`;

    setAvatar($('giAvatar'), { name: chat.name, avatar: chat.avatar });
    bindMuteRow(chat.id, 'giMuteToggle');

    const list = body.querySelector('#giMembers');
    list.innerHTML = members.map((m) => `
      <div class="member-item">
        <div class="avatar"><span>${m.isBot ? '🤖' : esc((m.name || '?').charAt(0).toUpperCase())}</span></div>
        <div class="member-meta">
          <strong>${esc(m.name)}${m.isBot ? badge(true) : ''}${m.id === S.me.id ? ' (Anda)' : ''}</strong>
          <small>${m.isBot ? 'Bot' : esc(m.email)}${m.online ? ' • online' : ''}</small>
        </div>
        ${m.role === 'admin' ? '<span class="role-badge">Admin</span>' : ''}
      </div>`).join('');
    list.querySelectorAll('.avatar').forEach((av, i) => { if (!members[i].isBot) setAvatar(av, members[i]); });

    // kelola bot grup: pasang (admin premium) / keluarkan (admin)
    const botRemoveBtn = body.querySelector('#giBotRemove');
    if (botRemoveBtn) {
      botRemoveBtn.addEventListener('click', async () => {
        const bot = members.find((m) => m.isBot);
        if (!bot) return;
        if (!confirm(`Keluarkan bot ${bot.name} dari grup?`)) return;
        try {
          await api(`/api/chats/${chat.id}/members/${bot.id}`, { method: 'DELETE' });
          await loadChats();
          toast('Bot dikeluarkan dari grup');
          openGroupInfo();
        } catch (err) { toast(err.message); }
      });
    }
    const botAddBtn = body.querySelector('#giBotAdd');
    if (botAddBtn) {
      botAddBtn.addEventListener('click', async () => {
        const picker = body.querySelector('#giBotPicker');
        if (!picker) return;
        if (!picker.classList.contains('hidden')) { picker.classList.add('hidden'); return; }
        picker.classList.remove('hidden');
        picker.innerHTML = '<div class="empty-state">Memuat daftar bot…</div>';
        try {
          const data = await api('/api/bots');
          const all = (data.groups || []).flatMap((g) => g.bots);
          picker.innerHTML = all.map((b) => `
            <div class="chat-item" data-gbot="${esc(b.id)}">
              <div class="avatar"><span>🤖</span></div>
              <div class="chat-item-body">
                <div class="chat-item-top"><strong>${esc(b.name)}</strong></div>
                <div class="chat-item-bottom"><div class="chat-item-preview">${esc(b.about || b.tagline || '')}</div></div>
              </div>
              <span class="mi-arrow"><svg viewBox="0 0 24 24" class="ico"><use href="#ic-plus" /></svg></span>
            </div>`).join('');
          picker.querySelectorAll('[data-gbot]').forEach((el) => {
            el.addEventListener('click', async () => {
              try {
                await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: { userId: el.dataset.gbot } });
                await loadChats();
                toast('Bot dipasang di grup ✓');
                openGroupInfo();
              } catch (err2) { toast(err2.message); }
            });
          });
        } catch (err) {
          if (err.status === 403 && err.data && err.data.locked) {
            picker.innerHTML = '<div class="empty-state">Pemasangan bot khusus pengguna premium. Buka menu Paket &amp; Harga untuk upgrade.</div>';
          } else {
            picker.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
          }
        }
      });
    }

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
            // foto besar dilewati pemotong supaya aman di memori WebView
            let upload = file;
            if (file.size <= 25 * 1024 * 1024) {
              upload = await openCropper(file, { title: 'Atur foto grup' });
              if (!upload) return;
            }
            toast('Mengunggah foto grup...');
            const meta = await uploadFile(upload);
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

    // link undangan grup: muat sekali, salin/bagikan/regenerate
    const inviteLinkInput = body.querySelector('#giInviteLink');
    const loadInvite = async (regenerate) => {
      try {
        const data = await api(`/api/chats/${chat.id}/invite`, { method: 'POST', body: { regenerate } });
        if (inviteLinkInput) inviteLinkInput.value = data.link || '';
        return data.link || '';
      } catch (err) {
        if (inviteLinkInput) inviteLinkInput.value = 'Gagal memuat link';
        return '';
      }
    };
    loadInvite(false);
    const invCopy = body.querySelector('#giInviteCopy');
    if (invCopy) invCopy.addEventListener('click', async () => {
      const ok = await copyToClipboard(inviteLinkInput.value);
      toast(ok ? 'Link undangan disalin' : 'Gagal menyalin');
    });
    const invShare = body.querySelector('#giInviteShare');
    if (invShare) invShare.addEventListener('click', async () => {
      const link = inviteLinkInput.value;
      if (!link || link.startsWith('Gagal')) return;
      if (navigator.share) {
        try { await navigator.share({ title: `Gabung grup ${chat.name}`, text: `Undangan ke grup ${chat.name}:`, url: link }); } catch { /* dibatalkan */ }
      } else {
        const ok = await copyToClipboard(link);
        toast(ok ? 'Link disalin — tempel di mana saja' : 'Gagal menyalin');
      }
    });
    const invReset = body.querySelector('#giInviteReset');
    if (invReset) invReset.addEventListener('click', async () => {
      if (!confirm('Regenerate link? Link lama otomatis tidak berlaku.')) return;
      await loadInvite(true);
      toast('Link undangan baru dibuat ✓');
    });

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
  bindEdgeBack();        // gesture tepi kiri -> kembali
  bindViewportKeyboard(); // composer tetap di atas keyboard saat mengetik
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
