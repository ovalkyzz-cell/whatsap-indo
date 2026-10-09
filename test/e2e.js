'use strict';
/* E2E test: register 2 users, chat realtime, upload, read receipts */
const { io } = require('socket.io-client');
const fs = require('fs');
const BASE = 'http://localhost:3000';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/* ---------- harness: admin, persetujuan & sesi ----------
   Akun baru berstatus "menunggu" dan harus disetujui admin lebih dulu,
   jadi setiap pembuatan akun uji lewat signup() yang menyetujuinya. */
const ADMIN_EMAIL = 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = 'secret123';
let admToken = null;

async function admLogin() {
  let r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD },
  });
  if (r.status !== 201) {
    r = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  }
  if (!r.data || !r.data.token) {
    throw new Error(`gagal menyiapkan admin: ${r.status} ${JSON.stringify(r.data)}`);
  }
  admToken = r.data.token;
  return admToken;
}

// sesi admin bisa diganti proses lain -> coba ulang satu kali dengan login baru
async function admApi(path, opts = {}) {
  if (!admToken) await admLogin();
  let r = await api(path, { ...opts, token: admToken });
  if (r.status === 401) {
    await admLogin();
    r = await api(path, { ...opts, token: admToken });
  }
  return r;
}

async function signup({ email, name, password }) {
  const r = await api('/api/auth/register', { method: 'POST', body: { email, name, password } });
  if (r.status !== 201) return r;
  if (!r.data.pending) return r; // akun admin: langsung aktif + dapat token
  const ap = await admApi(`/api/admin/users/${encodeURIComponent(r.data.user.id)}/approve`, {
    method: 'POST',
    body: {},
  });
  if (ap.status !== 200) {
    return { status: 500, data: { error: `persetujuan gagal: ${JSON.stringify(ap.data)}` } };
  }
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (lg.status !== 200) {
    return { status: 500, data: { error: `login setelah disetujui gagal: ${JSON.stringify(lg.data)}` } };
  }
  return { status: 201, data: { ...lg.data, pending: false } };
}

function waitAdmin(sock, type, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const onEvent = (ev) => {
      if (!ev || ev.type !== type) return;
      clearTimeout(timer);
      sock.off('admin:event', onEvent);
      resolve(ev);
    };
    const timer = setTimeout(() => {
      sock.off('admin:event', onEvent);
      reject(new Error(`timeout menunggu admin:event ${type}`));
    }, timeout);
    sock.on('admin:event', onEvent);
  });
}

const waitEvent = (sock, event, timeout = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
  sock.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

const expectNoEvent = (sock, event, ms = 350) => new Promise((resolve) => {
  const handler = (payload) => { clearTimeout(t); sock.off(event, handler); resolve({ got: true, payload }); };
  const t = setTimeout(() => { sock.off(event, handler); resolve({ got: false }); }, ms);
  sock.once(event, handler);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stamp = Date.now();

  console.log('\n[0] Bootstrap admin (persetujuan pendaftaran)');
  await admLogin();
  ok(true, 'akun admin siap memantau & menyetujui');

  console.log('\n[1] Auth');
  const r1 = await signup({ email: `andi${stamp}@test.id`, name: 'Andi', password: 'secret123' });
  ok(r1.status === 201 && r1.data.token, 'register Andi (disetujui admin)');
  const r2 = await signup({ email: `budi${stamp}@test.id`, name: 'Budi', password: 'secret123' });
  ok(r2.status === 201 && r2.data.token, 'register Budi (disetujui admin)');
  const r3 = await api('/api/auth/register', { method: 'POST', body: { email: `andi${stamp}@test.id`, name: 'Duplikat', password: 'secret123' } });
  ok(r3.status === 409, 'duplicate email rejected 409');
  const r4 = await api('/api/auth/login', { method: 'POST', body: { email: `andi${stamp}@test.id`, password: 'salah' } });
  ok(r4.status === 401, 'wrong password rejected 401');
  const r5 = await api('/api/auth/login', { method: 'POST', body: { email: `andi${stamp}@test.id`, password: 'secret123' } });
  ok(r5.status === 200 && r5.data.token, 'login success');

  // login terakhir menentukan sesi aktif (satu akun satu device)
  const tokA = r5.data.token, tokB = r2.data.token;
  const userA = r1.data.user, userB = r2.data.user;

  console.log('\n[2] Token guard');
  const rg = await api('/api/chats');
  ok(rg.status === 401, 'no token -> 401');

  console.log('\n[3] Direct chat');
  const rc = await api('/api/chats/direct', { method: 'POST', token: tokA, body: { peerId: userB.id } });
  ok(rc.status === 201 && rc.data.chat, 'create direct chat');
  const chatId = rc.data.chat.id;
  const rc2 = await api('/api/chats/direct', { method: 'POST', token: tokA, body: { peerId: userB.id } });
  ok(rc2.data.chat.id === chatId, 'same chat returned (idempotent)');

  console.log('\n[4] Realtime messaging');
  const sockA = io(BASE, { auth: { token: tokA } });
  const sockB = io(BASE, { auth: { token: tokB } });
  await Promise.all([
    new Promise((r) => sockA.on('connect', r)),
    new Promise((r) => sockB.on('connect', r)),
  ]);
  ok(true, 'both sockets connected');

  const bGetsMsg = waitEvent(sockB, 'message:new');
  let aAck = null;
  sockA.emit('message:send', { chatId, type: 'text', body: 'Halo Budi!' }, (res) => { aAck = res; });
  const msg1 = await bGetsMsg;
  ok(msg1.body === 'Halo Budi!', 'B receives message in realtime');
  await new Promise((r) => setTimeout(r, 200));
  ok(aAck?.ok && aAck?.message?.id === msg1.id, 'sender ack matches');

  const statusEvent = waitEvent(sockA, 'message:status');
  sockB.emit('chat:read', { chatId });
  const st = await statusEvent;
  ok(st.status === 'read' && st.messageId === msg1.id, 'read receipt received by sender');

  const typingEv = waitEvent(sockB, 'typing');
  sockA.emit('typing', { chatId, typing: true });
  const ty = await typingEv;
  ok(ty.typing === true && ty.userId === userA.id, 'typing indicator received');

  const presenceEv = waitEvent(sockB, 'presence');
  sockA.disconnect();
  const pr = await presenceEv;
  ok(pr.userId === userA.id && pr.online === false, 'presence offline broadcast');

  // reconnect A (auto-reconnect dimatikan oleh disconnect manual)
  const sockA2 = io(BASE, { auth: { token: tokA } });
  await new Promise((r) => sockA2.on('connect', r));
  ok(true, 'socket A reconnected');

  console.log('\n[5] Message history & unread');
  const rm = await api(`/api/chats/${chatId}/messages`, { token: tokA });
  ok(rm.status === 200 && rm.data.messages.length === 1, 'history has 1 message');
  const rchat = await api('/api/chats', { token: tokB });
  const chatB = rchat.data.chats.find((c) => c.id === chatId);
  ok(chatB && chatB.unread === 0, 'unread=0 after read');

  console.log('\n[6] Upload (image + 100MB video simulation ok, real size check)');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'test.png');
  const upRes = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fd });
  const upData = await upRes.json();
  ok(upRes.status === 201 && upData.url && upData.type === 'image', `upload image -> ${upData.url}`);
  const upGet = await fetch(BASE + upData.url);
  ok(upGet.status === 200, 'uploaded file downloadable');

  // send media message
  const bGetsMedia = waitEvent(sockB, 'message:new');
  sockA2.emit('message:send', { chatId, type: 'image', body: 'Lihat ini', media: upData }, (res) => ok(res.ok, 'send image message ack'));
  const mediaMsg = await bGetsMedia;
  ok(mediaMsg.type === 'image' && mediaMsg.mediaUrl, 'B receives image message');

  console.log('\n[7] Validation errors');
  sockA2.emit('message:send', { chatId, type: 'text', body: '   ' }, (res) => ok(!res.ok, 'empty text rejected'));
  sockA2.emit('message:send', { chatId: 'not-a-chat', type: 'text', body: 'x' }, (res) => ok(!res.ok, 'foreign chat rejected'));

  console.log('\n[8] Search users');
  const rs = await api(`/api/users/search?q=${encodeURIComponent(`budi${stamp}`)}`, { token: tokA });
  ok(rs.data.users.some((u) => u.id === userB.id), 'search finds Budi by email');

  console.log('\n[9] Static frontend');
  const idx = await fetch(BASE + '/');
  const html = await idx.text();
  ok(idx.status === 200 && html.includes('Whatsap Indo'), 'index.html served');
  const js = await fetch(BASE + '/js/app.js');
  ok(js.status === 200, 'app.js served');
  const jsText = await js.text();
  const css = await fetch(BASE + '/css/style.css');
  ok(css.status === 200, 'style.css served');
  const styleText = await css.text();
  const saveBgIds = (html.match(/id="btnSaveHomeBg"/g) || []).length;
  ok(saveBgIds === 1, 'id tombol simpan latar pengguna unik (tanpa duplikat)');
  ok(html.includes('id="btnSaveHomeBgAdm"'), 'tombol Simpan Background admin punya id sendiri');
  ok(jsText.includes("btnSaveHomeBgAdm") && jsText.includes("/api/admin/settings"),
    'handler simpan latar admin terikat & memanggil API admin');

  // pemotong foto rasio bebas (menggantikan crop persegi paksa)
  ok(html.includes('id="cropModal"') && html.includes('id="cropFrame"')
    && html.includes('class="crop-ratio active" data-ratio="0"'),
    'markup pemotong foto rasio bebas tersedia & default Bebas');
  ok(jsText.includes('function openCropper') && jsText.includes('function cropExport')
    && !jsText.includes('function squareImage'),
    'app.js memakai pemotong rasio bebas, crop persegi paksa dihapus');
  ok(jsText.includes("openCropper(file, { title: 'Atur foto profil' })"),
    'ganti foto profil diarahkan ke pemotong');
  ok(!/startsWith\('image\/\*'\)/.test(jsText)
    && jsText.includes("file.type.startsWith('image/')"),
    'pemeriksaan tipe gambar memakai prefix image/ (tanpa wildcard literal)');
  ok(/function openCropper\(file, opts = \{\}\)[\s\S]{0,120}if \(CROP\.open\) \{ resolve\(null\); return; \}/.test(jsText),
    'pemotong tidak bisa dibuka ganda saat masih terbuka');
  ok(!/addEventListener\('touchstart'[\s\S]{0,140}imgProtected/.test(jsText),
    'sentuhan pada foto profil tidak lagi memblokir gesture scroll');
  ok(styleText.includes('-webkit-overflow-scrolling: touch') && styleText.includes('overscroll-behavior: contain'),
    'kontainer scroll memakai momentum & overscroll terkandung');
  ok(styleText.includes('@media (hover: hover) and (pointer: fine)'),
    'efek hover dibatasi ke perangkat tetikus agar tidak menempel di sentuh');
  ok(/\.group-form\s*\{[^}]*overflow-y:\s*auto/.test(styleText)
    && /\.group-info-body\s*\{[^}]*overflow-y:\s*auto/.test(styleText)
    && /\.status-body\s*\{[^}]*overflow-y:\s*auto/.test(styleText)
    && /\.menu-list\s*\{[^}]*overflow-y:\s*auto/.test(styleText),
  'seluruh isi drawer punya overflow-y sehingga konten panjang bisa digulir');

  // siap dipasang sebagai APK (Android) maupun aplikasi desktop
  const mf = await (await fetch(BASE + '/manifest.json')).json();
  ok(mf.display === 'standalone' && Array.isArray(mf.display_override)
    && mf.display_override.includes('standalone') && mf.start_url === '/' && mf.scope === '/',
    'manifest siap dipasang sebagai APK / aplikasi desktop');
  ok(Array.isArray(mf.icons) && mf.icons.some((i) => i.purpose === 'maskable')
    && mf.icons.some((i) => i.sizes === '512x512'),
    'manifest memuat ikon 512 & maskable untuk launcher');
  const swText = await (await fetch(BASE + '/sw.js')).text();
  ok(/const CACHE = 'wa-static-v\d+'/.test(swText) && swText.includes("'/js/app.js'"),
    'service worker memakai versi cache terbaru');

  console.log('\n[10] Delete message');
  const del = await api(`/api/messages/${msg1.id}`, { method: 'DELETE', token: tokA });
  ok(del.status === 200, 'delete own message');
  const rm2 = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  ok(rm2.data.messages.find((m) => m.id === msg1.id)?.deleted, 'message marked deleted for receiver');

  console.log('\n[11] Fitur panggilan (suara & video WebRTC) aktif');
  const pathMod = require('path');
  ok(fs.existsSync(pathMod.join(__dirname, '..', 'server', 'calls.js')), 'server/calls.js ada');
  const idxSrc = fs.readFileSync(pathMod.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  ok(idxSrc.includes("require('./calls')"), 'server/index.js memuat modul calls');
  ok(idxSrc.includes("socket.on('call:invite'") && idxSrc.includes("socket.on('call:accept'")
    && idxSrc.includes("socket.on('call:signal'") && idxSrc.includes("socket.on('call:reject'")
    && idxSrc.includes("socket.on('call:hangup'"),
    'server/index.js mendaftarkan seluruh handler call:*');
  ok(idxSrc.includes('cleanupCalls('), 'pembersihan panggilan dipanggil saat disconnect');
  const dbSrc = fs.readFileSync(pathMod.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  ok(/CREATE TABLE IF NOT EXISTS calls/.test(dbSrc), 'skema database punya tabel calls');
  ok(html.includes('id="btnCallVoice"') && html.includes('id="btnCallVideo"'),
    'tombol panggilan suara & video ada di header chat');
  ok(html.includes('id="incomingCall"') && html.includes('id="activeCall"')
    && html.includes('id="btnHangup"'),
    'modal panggilan masuk & aktif (dengan tombol akhiri) ada di index.html');
  ok(html.includes('id="ic-hangup"'), 'ikon sprite #ic-hangup tersedia');
  ok(jsText.includes('startCall') && jsText.includes('RTCPeerConnection')
    && jsText.includes("socket.on('call:signal', onCallSignal)") && jsText.includes('call:invite')
    && jsText.includes('id="ciVoice"'),
    'app.js punya logika panggilan WebRTC + tombol info kontak');
  ok(styleText.includes('.call-modal') && styleText.includes('.call-btn') && styleText.includes('.call-videos'),
    'style.css punya gaya panel panggilan');

  // runtime: sinyal call:* berfungsi end-to-end
  const callId = `call-${stamp}-rt`;
  const bIncoming = waitEvent(sockB, 'call:incoming', 5000).catch(() => null);
  let inviteAck = null;
  sockA2.emit('call:invite', { to: userB.id, callId, kind: 'video' }, (res) => { inviteAck = res; });
  const incoming = await bIncoming;
  await sleep(50);
  ok(inviteAck?.ok === true && incoming && incoming.callId === callId && incoming.kind === 'video',
    'call:invite dijawab ack ok & call:incoming sampai ke penerima');
  const bEnded = waitEvent(sockB, 'call:ended', 5000).catch(() => null);
  sockA2.emit('call:hangup', { to: userB.id, callId, reason: 'ended' });
  const ended = await bEnded;
  await sleep(50);
  ok(ended && ended.callId === callId && ended.reason === 'ended', 'call:hangup memicu call:ended di penerima');

  console.log('\n[12] Upload safety (mencegah XSS file buatan pengguna)');
  const fdHtml = new FormData();
  fdHtml.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  const upHtml = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fdHtml });
  const upHtmlData = await upHtml.json();
  ok(upHtml.status === 201 && upHtmlData.url, 'html upload stored');
  const evilRes = await fetch(BASE + upHtmlData.url);
  ok(evilRes.headers.get('x-content-type-options') === 'nosniff', 'nosniff header set on /uploads');
  ok((evilRes.headers.get('content-type') || '').indexOf('text/html') === -1, 'uploaded html is not served as text/html');
  ok((evilRes.headers.get('content-disposition') || '').includes('attachment'), 'uploaded html forced download');

  console.log('\n[13] Grup');
  const bGroupUpd = waitEvent(sockB, 'chat:updated');
  const rg1 = await api('/api/chats/group', {
    method: 'POST', token: tokA,
    body: { name: `Teman ${stamp}`, memberIds: [userB.id] },
  });
  ok(rg1.status === 201 && rg1.data.chat?.type === 'group', 'create group');
  const gid = rg1.data.chat.id;
  ok(rg1.data.chat.memberCount === 2, 'group reports 2 members');
  ok(rg1.data.chat.role === 'admin', 'creator gets admin role');
  await bGroupUpd;
  ok(true, 'member notified about new group');

  const rMembers = await api(`/api/chats/${gid}/members`, { token: tokA });
  ok(rMembers.status === 200 && rMembers.data.members.length === 2, 'group member list');
  ok(rMembers.data.members.filter((m) => m.role === 'admin').length === 1, 'exactly one admin');

  const bGroupMsg = waitEvent(sockB, 'message:new');
  let groupAck = null;
  sockA2.emit('message:send', { chatId: gid, type: 'text', body: 'Halo grup!' }, (res) => { groupAck = res; });
  const gm = await bGroupMsg;
  ok(gm.senderId === userA.id && gm.senderName === 'Andi', 'group message carries sender name');
  await sleep(100);
  ok(groupAck?.ok === true, 'group message acknowledged');

  const rRenameBad = await api(`/api/chats/${gid}`, { method: 'PATCH', token: tokB, body: { name: 'Hacked' } });
  ok(rRenameBad.status === 403, 'non-admin rename rejected 403');
  const rRename = await api(`/api/chats/${gid}`, { method: 'PATCH', token: tokA, body: { name: `Grup ${stamp}` } });
  ok(rRename.status === 200 && rRename.data.chat.name === `Grup ${stamp}`, 'admin renames group');

  const rAdd = await api(`/api/chats/${gid}/members`, { method: 'POST', token: tokB, body: { userId: userB.id } });
  ok(rAdd.status === 403, 'non-admin cannot add members');

  const rLeave = await api(`/api/chats/${gid}/leave`, { method: 'POST', token: tokB });
  ok(rLeave.status === 200, 'member leaves group');
  const rMembersAfter = await api(`/api/chats/${gid}/members`, { token: tokB });
  ok(rMembersAfter.status === 403, 'excluded member loses access');

  console.log('\n[14] Status WA');
  const rs1 = await api('/api/status', {
    method: 'POST', token: tokA,
    body: { type: 'text', body: `Halo dari ${stamp}`, bg: '#008069' },
  });
  ok(rs1.status === 201 && rs1.data.status?.id, 'create text status');
  const sid = rs1.data.status.id;

  const feedA = await api('/api/status', { token: tokA });
  ok(feedA.data.groups.some((g) => g.isSelf && g.statuses.some((s) => s.id === sid)), 'own status appears in feed');

  const feedB1 = await api('/api/status', { token: tokB });
  const groupB = feedB1.data.groups.find((g) => g.user.id === userA.id);
  ok(groupB && groupB.statuses.some((s) => s.id === sid && !s.viewed), 'contact sees unviewed status');

  const rv = await api(`/api/status/${sid}/view`, { method: 'POST', token: tokB });
  ok(rv.status === 200, 'mark status as viewed');
  const feedB2 = await api('/api/status', { token: tokB });
  ok(feedB2.data.groups.find((g) => g.user.id === userA.id)
    .statuses.find((s) => s.id === sid).viewed === true, 'viewed flag persists');

  const viewers = await api(`/api/status/${sid}/viewers`, { token: tokA });
  ok(viewers.status === 200 && viewers.data.viewers.some((v) => v.id === userB.id), 'owner sees viewer list');

  const rDelOther = await api(`/api/status/${sid}`, { method: 'DELETE', token: tokB });
  ok(rDelOther.status === 403, 'cannot delete someone else status');
  const rDel = await api(`/api/status/${sid}`, { method: 'DELETE', token: tokA });
  ok(rDel.status === 200, 'owner deletes own status');
  const feedB3 = await api('/api/status', { token: tokB });
  ok(!feedB3.data.groups.find((g) => g.user.id === userA.id)
    ?.statuses.some((s) => s.id === sid), 'deleted status disappears from feed');

  console.log('\n[15] Foto sekali lihat');
  const fdVo = new FormData();
  fdVo.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'sekali.png');
  const upVoRes = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fdVo });
  const upVo = await upVoRes.json();
  ok(upVoRes.status === 201 && upVo.url, 'view-once photo uploaded');

  const bVoMsg = waitEvent(sockB, 'message:new');
  let voAck = null;
  sockA2.emit('message:send', { chatId, type: 'image', body: '', media: upVo, viewOnce: true }, (res) => { voAck = res; });
  const voMsg = await bVoMsg;
  await sleep(100);
  ok(voAck?.ok && voAck.message.viewOnce === true, 'view-once flag stored');
  ok(voMsg.viewOnce === true && /\/api\/messages\/media\//.test(voMsg.mediaUrl || ''), 'receiver gets gated media url');

  const voUrl = `${BASE}/api/messages/media/${voMsg.id}`;
  const vo1 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokB}` }, redirect: 'manual' });
  ok(vo1.status === 302, 'first open redirects to photo');
  const vo2 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokB}` }, redirect: 'manual' });
  ok(vo2.status === 410, 'second open rejected 410');
  const vo3 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokA}` }, redirect: 'manual' });
  ok(vo3.status === 302, 'sender may still open own view-once photo');

  const rmVo = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  const voInB = rmVo.data.messages.find((m) => m.id === voMsg.id);
  ok(voInB && voInB.opened === true && voInB.mediaUrl === null, 'receiver sees consumed state');

  console.log('\n[16] Anti spam / anti flood');
  let dup1 = null;
  let dup2 = null;
  sockA2.emit('message:send', { chatId, type: 'text', body: `Duplikat ${stamp}` }, (r) => { dup1 = r; });
  await sleep(80);
  sockA2.emit('message:send', { chatId, type: 'text', body: `Duplikat ${stamp}` }, (r) => { dup2 = r; });
  await sleep(400);
  ok(dup1?.ok === true, 'first message accepted');
  ok(dup2 && dup2.ok === false && /anti-spam/i.test(dup2.error || ''), 'rapid duplicate rejected (anti-spam)');

  const floodResults = [];
  for (let i = 0; i < 40; i++) {
    sockA2.emit('message:send', { chatId, type: 'text', body: `Banjir ${stamp} ${i}` }, (r) => floodResults.push(r));
  }
  await sleep(1500);
  const blocked = floodResults.filter((r) => r && r.ok === false);
  ok(floodResults.length === 40, 'every flood message answered');
  ok(blocked.length > 0, `flood rate-limited (${blocked.length}/40 blocked)`);

  console.log('\n[17] Panel admin, premium & privasi');
  const adminEmail = ADMIN_EMAIL;
  let rAdm = await api('/api/auth/register', {
    method: 'POST', body: { email: adminEmail, name: 'Admin Test', password: 'secret123' },
  });
  if (rAdm.status === 409) {
    rAdm = await api('/api/auth/login', { method: 'POST', body: { email: adminEmail, password: 'secret123' } });
  }
  ok((rAdm.status === 200 || rAdm.status === 201) && rAdm.data.token, 'akun admin siap');
  const tokAdm = rAdm.data.token;
  const meAdm = await api('/api/auth/me', { token: tokAdm });
  ok(meAdm.data.user.role === 'admin' && meAdm.data.user.verified === true, 'ovalkyzz = admin + terverifikasi');

  const noOv = await api('/api/admin/overview', { token: tokA });
  ok(noOv.status === 403, 'bukan admin ditolak 403');
  const ov = await api('/api/admin/overview', { token: tokAdm });
  ok(ov.status === 200 && ov.data.stats.users > 0 && Array.isArray(ov.data.plans) && ov.data.plans.length >= 3,
    'overview admin (statistik + paket)');

  const grant1 = await api('/api/admin/premium', {
    method: 'POST', token: tokAdm, body: { email: userA.email, plan: 'mingguan' },
  });
  ok(grant1.status === 200 && grant1.data.user.premiumActive === true && grant1.data.user.verified === true,
    'premium diberikan lewat email');
  const meA2 = await api('/api/auth/me', { token: tokA });
  ok(meA2.data.user.verified === true && meA2.data.user.premium.active === true && meA2.data.user.premium.plan === 'mingguan',
    'centang biru premium aktif di akun');
  const meB2 = await api('/api/auth/me', { token: tokB });
  ok(meB2.data.user.verified === false && meB2.data.user.premium.active === false, 'non-premium tanpa centang biru');

  const listU = await api(`/api/admin/users?q=${encodeURIComponent(userA.email)}`, { token: tokAdm });
  ok(listU.status === 200 && listU.data.users.length === 1 && listU.data.users[0].plan === 'mingguan',
    'daftar pengguna admin mencari lewat email');

  const setPlans = await api('/api/admin/settings', {
    method: 'PUT', token: tokAdm,
    body: {
      plans: [
        { id: 'uji-sehari', label: '1 Hari', days: 1, price: 1000, dailyLimit: 0, excluded: [] },
        { id: 'mingguan', label: 'Mingguan', days: 7, price: 10000, dailyLimit: 200, excluded: [] },
        { id: 'bulanan', label: 'Bulanan', days: 30, price: 25000, dailyLimit: 0, excluded: [] },
      ],
    },
  });
  ok(setPlans.status === 200 && setPlans.data.plans[0].days === 1, 'admin mengatur durasi paket');

  const grant2 = await api('/api/admin/premium', {
    method: 'POST', token: tokAdm, body: { email: userB.email, plan: 'uji-sehari' },
  });
  const expectUntil = Date.now() + 24 * 3600 * 1000;
  ok(grant2.status === 200 && Math.abs(grant2.data.user.premiumUntil - expectUntil) < 10_000,
    'durasi paket kustom (1 hari) dipakai');

  const noGrant = await api('/api/admin/premium', {
    method: 'POST', token: tokB, body: { email: userA.email, plan: 'mingguan' },
  });
  ok(noGrant.status === 403, 'pemberian premium hanya admin');

  const revoke = await api('/api/admin/premium/revoke', {
    method: 'POST', token: tokAdm, body: { email: userB.email },
  });
  ok(revoke.status === 200 && revoke.data.user.premiumActive === false && revoke.data.user.verified === false,
    'premium dicabut + centang biru hilang');
  const meB3 = await api('/api/auth/me', { token: tokB });
  ok(meB3.data.user.verified === false, 'status verifikasi menyesuaikan premium');

  const bgSet = await api('/api/admin/settings', {
    method: 'PUT', token: tokAdm, body: { homeBg: { type: 'image', url: '/uploads/bg-test.png' } },
  });
  ok(bgSet.status === 200 && bgSet.data.homeBg.type === 'image', 'background beranda diatur (foto)');
  const bgPub = await api('/api/settings/public');
  ok(bgPub.status === 200 && bgPub.data.homeBg.url === '/uploads/bg-test.png', 'background publik terbaca tanpa login');
  const bgBad = await api('/api/admin/settings', {
    method: 'PUT', token: tokAdm, body: { homeBg: { type: 'video', url: 'https://evil.example/x.js' } },
  });
  ok(bgBad.status === 400, 'URL background asing ditolak');
  const bgReset = await api('/api/admin/settings', {
    method: 'PUT', token: tokAdm, body: { homeBg: { type: 'default' } },
  });
  ok(bgReset.status === 200 && bgReset.data.homeBg.type === 'default', 'background dikembalikan default');

  // ---------- privasi ----------
  await api('/api/me', {
    method: 'PATCH', token: tokA,
    body: { about: 'Bio rahasia', avatar: '/uploads/ava-privasi.png', name: `Andi ${stamp}` },
  });
  const pv = await api('/api/me', {
    method: 'PATCH', token: tokA,
    body: {
      privacy: { email: true, bio: true, lastSeen: true, receipts: true, status: true, avatar: true },
    },
  });
  ok(pv.status === 200 && pv.data.user.privacy.email === true && pv.data.user.privacy.receipts === true,
    'pengaturan privasi tersimpan');

  const seEmail = await api(`/api/users/search?q=${encodeURIComponent(userA.email)}`, { token: tokB });
  ok(seEmail.status === 200 && seEmail.data.users.length === 0, 'email terprivat tidak bisa dicari');
  const seName = await api(`/api/users/search?q=${encodeURIComponent(`Andi ${stamp}`)}`, { token: tokB });
  const hit = seName.data.users.find((u) => u.id === userA.id);
  ok(hit && (hit.email === null || hit.email === undefined) && hit.verified === true,
    'hasil pencarian tanpa email, tetap ada centang biru premium');

  const profOther = await api(`/api/users/${userA.id}`, { token: tokB });
  const po = profOther.data.user;
  ok(po.email === null && po.about === '' && po.avatar === null && po.lastSeen === 0 && po.online === false,
    'profil orang lain termaskir (email/bio/foto/last seen)');
  const profSelf = await api(`/api/users/${userA.id}`, { token: tokA });
  ok(profSelf.data.user.email === userA.email && profSelf.data.user.about === 'Bio rahasia'
    && profSelf.data.user.avatar === '/uploads/ava-privasi.png', 'profil sendiri tetap lengkap');

  const sockB3 = io(BASE, { auth: { token: tokB } });
  await new Promise((r) => sockB3.on('connect', r));
  const sentPriv = await new Promise((r) => {
    sockB3.emit('message:send', { chatId, type: 'text', body: `Uji privasi baca ${stamp}` }, r);
  });
  ok(sentPriv && sentPriv.ok === true, 'pesan dikirim untuk uji laporan dibaca');
  await sleep(500);
  const noReadEv = expectNoEvent(sockB3, 'message:status', 700);
  await api(`/api/chats/${chatId}/read`, { method: 'POST', token: tokA });
  ok((await noReadEv).got === false, 'event "dibaca" tidak diteruskan ke pengirim');
  const msgsPriv = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  const lastPriv = msgsPriv.data.messages.filter((m) => m.senderId === userB.id).pop();
  ok(lastPriv && lastPriv.status !== 'read', 'status "read" disembunyikan dari pengirim');

  const myStatus = await api('/api/status', { method: 'POST', token: tokA, body: { type: 'text', body: 'Status privat' } });
  ok(myStatus.status === 201, 'status privat dibuat');
  const feedB = await api('/api/status', { token: tokB });
  ok(!(feedB.data.groups || []).some((g) => g.user.id === userA.id), 'status privat tidak tampil di kontak');
  const blockView = await api(`/api/status/${myStatus.data.status.id}/view`, { method: 'POST', token: tokB });
  ok(blockView.status === 404, 'status privat tidak bisa dibuka paksa lewat id');

  await api('/api/me', { method: 'PATCH', token: tokA, body: { privacy: { status: false } } });
  const myStatus2 = await api('/api/status', { method: 'POST', token: tokA, body: { type: 'text', body: 'Status terbuka' } });
  ok(myStatus2.status === 201, 'status publik dibuat');
  const feedBPub = await api('/api/status', { token: tokB });
  ok((feedBPub.data.groups || []).some((g) => g.user.id === userA.id), 'status tampil lagi setelah privasi dimatikan');

  sockB3.close();
  sockB.close();

  console.log('\n[18] Notifikasi push & batas 500 anggota');
  const vk = await api('/api/push/vapid-public-key', { token: tokA });
  ok(vk.status === 200 && typeof vk.data.publicKey === 'string' && vk.data.publicKey.length > 60,
    'public key VAPID tersedia');

  const nodeCrypto = require('crypto');
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://127.0.0.1:9/push/${stamp}`;
  const subBody = {
    subscription: {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey('base64url'),
        auth: nodeCrypto.randomBytes(16).toString('base64url'),
      },
    },
  };
  const sub1 = await api('/api/push/subscribe', { method: 'POST', token: tokA, body: subBody });
  ok(sub1.status === 201, 'subscribe push diterima');
  const sub2 = await api('/api/push/subscribe', { method: 'POST', token: tokA, body: subBody });
  ok(sub2.status === 200 && sub2.data.updated === true, 'subscribe ulang idempoten (update, bukan dobel)');
  const subBad = await api('/api/push/subscribe', { method: 'POST', token: tokB, body: subBody });
  ok(subBad.status === 403 || subBad.status === 400, 'endpoint milik pengguna lain ditolak');

  const bigIds = Array.from({ length: 501 }, (_, i) => `ghost-${i}`);
  const big = await api('/api/chats/group', {
    method: 'POST', token: tokA,
    body: { name: `Raksasa ${stamp}`, memberIds: bigIds },
  });
  ok(big.status === 400 && /500/.test(String(big.data.error || '')), 'grup menolak lebih dari 500 anggota');

  const justBelow = await api('/api/chats/group', {
    method: 'POST', token: tokA,
    body: { name: `Maksimal ${stamp}`, memberIds: bigIds.slice(0, 500) },
  });
  ok(justBelow.status === 400 && /tidak ditemukan/.test(String(justBelow.data.error || '')),
    'tepat 500 anggota lolos validasi jumlah (gagal hanya karena anggota fiktif)');

  sockA2.close(); // A offline, agar server mencoba push ke langganannya
  const sockB4 = io(BASE, { auth: { token: tokB } });
  await new Promise((r) => sockB4.on('connect', r));
  const sendWhilePush = await new Promise((r) => {
    sockB4.emit('message:send', { chatId, type: 'text', body: `Uji push ${stamp}` }, r);
  });
  ok(sendWhilePush && sendWhilePush.ok === true, 'pesan tetap terkirim walau push ke perangkat offline gagal');

  const unsub = await api('/api/push/unsubscribe', {
    method: 'POST', token: tokA, body: { endpoint },
  });
  ok(unsub.status === 200, 'unsubscribe push diterima');
  const sub3 = await api('/api/push/subscribe', { method: 'POST', token: tokA, body: subBody });
  ok(sub3.status === 201, 'unsubscribe benar-benar menghapus langganan');

  sockB4.close();

  console.log('\n[19] Foto profil grup & latar halaman utama');
  const gAvOk = await api(`/api/chats/${gid}`, {
    method: 'PATCH', token: tokA, body: { avatar: '/uploads/grup-avatar-test.jpg' },
  });
  ok(gAvOk.status === 200 && gAvOk.data.chat.avatar === '/uploads/grup-avatar-test.jpg',
    'admin mengganti foto profil grup');
  const gAvMember = await api(`/api/chats/${gid}`, {
    method: 'PATCH', token: tokB, body: { avatar: '/uploads/dicuri.jpg' },
  });
  ok(gAvMember.status === 403, 'anggota biasa tidak bisa mengganti foto grup');
  const gAvForeign = await api(`/api/chats/${gid}`, {
    method: 'PATCH', token: tokA, body: { avatar: 'https://evil.example.com/x.png' },
  });
  ok(gAvForeign.status === 400, 'URL foto grup asing ditolak');
  const gAvClear = await api(`/api/chats/${gid}`, {
    method: 'PATCH', token: tokA, body: { avatar: null },
  });
  ok(gAvClear.status === 200 && gAvClear.data.chat.avatar === null, 'foto grup bisa dihapus');

  const bgSaveMe = await api('/api/me', {
    method: 'PATCH', token: tokA, body: { homeBg: { type: 'image', url: '/uploads/home-bg.jpg' } },
  });
  ok(bgSaveMe.status === 200 && bgSaveMe.data.user.homeBg
    && bgSaveMe.data.user.homeBg.type === 'image' && bgSaveMe.data.user.homeBg.url === '/uploads/home-bg.jpg',
    'latar halaman utama tersimpan di akun');
  const bgReloadMe = await api('/api/auth/me', { token: tokA });
  ok(bgReloadMe.data.user.homeBg && bgReloadMe.data.user.homeBg.url === '/uploads/home-bg.jpg',
    'latar halaman utama ikut diambil saat muat profil');
  const bgUrlAsing = await api('/api/me', {
    method: 'PATCH', token: tokA, body: { homeBg: { type: 'image', url: 'https://evil.example.com/bg.jpg' } },
  });
  ok(bgUrlAsing.status === 400, 'URL latar halaman utama asing ditolak');
  const bgTipeSalah = await api('/api/me', {
    method: 'PATCH', token: tokA, body: { homeBg: { type: 'animasi', url: '/uploads/x.jpg' } },
  });
  ok(bgTipeSalah.status === 400, 'tipe latar tidak valid ditolak');
  const bgKembaliBawaan = await api('/api/me', {
    method: 'PATCH', token: tokA, body: { homeBg: { type: 'default', url: null } },
  });
  ok(bgKembaliBawaan.status === 200 && bgKembaliBawaan.data.user.homeBg.type === 'default'
    && bgKembaliBawaan.data.user.homeBg.url === null, 'latar halaman utama bisa dikembalikan ke bawaan');

  console.log('\n[20] Satu akun satu device (sesi tunggal)');
  const devCred = { email: `device${stamp}@test.id`, name: 'Tester Sesi', password: 'secret123' };
  const rd = await signup(devCred);
  ok(rd.status === 201 && rd.data.token, 'akun uji sesi disiapkan');
  const tokDev1 = rd.data.token;
  const meDev1 = await api('/api/auth/me', { token: tokDev1 });
  ok(meDev1.status === 200, 'token perangkat pertama valid');

  const rd2 = await api('/api/auth/login', { method: 'POST', body: devCred });
  ok(rd2.status === 200 && rd2.data.token, 'perangkat kedua berhasil masuk');
  const meDevOld = await api('/api/auth/me', { token: tokDev1 });
  ok(meDevOld.status === 401 && meDevOld.data.code === 'sesi-diganti',
    'token lama ditolak 401 sesi-diganti');
  const meDevNew = await api('/api/auth/me', { token: rd2.data.token });
  ok(meDevNew.status === 200, 'token perangkat kedua tetap valid');

  const sockLama = io(BASE, { auth: { token: tokDev1 } });
  const hasilHandshake = await new Promise((resolve) => {
    sockLama.on('connect', () => resolve('connected'));
    sockLama.on('connect_error', (e) => resolve(e.message));
    setTimeout(() => resolve('timeout'), 4000);
  });
  ok(hasilHandshake === 'auth:sesi-diganti', `socket token lama ditolak (${hasilHandshake})`);
  sockLama.close();

  const outDev = await api('/api/auth/logout', { method: 'POST', token: rd2.data.token });
  ok(outDev.status === 200, 'logout mematikan sesi');
  const meDevOut = await api('/api/auth/me', { token: rd2.data.token });
  ok(meDevOut.status === 401, 'token mati setelah logout');

  console.log('\n[21] Persetujuan pendaftaran baru (approve / reject)');
  const pendEmail = `menunggu${stamp}@test.id`;
  const rp = await api('/api/auth/register', {
    method: 'POST', body: { email: pendEmail, name: 'Menunggu', password: 'secret123' },
  });
  ok(rp.status === 201 && rp.data.pending === true && !rp.data.token,
    'pendaftaran baru berstatus menunggu (tanpa token)');
  const rlPend = await api('/api/auth/login', { method: 'POST', body: { email: pendEmail, password: 'secret123' } });
  ok(rlPend.status === 403 && rlPend.data.code === 'pending', 'login ditolak sebelum disetujui');

  const monPend = await admApi('/api/admin/monitor');
  ok(monPend.status === 200 && (monPend.data.pending || []).some((u) => u.email === pendEmail),
    'admin melihat pendaftaran menunggu di monitor');

  const noApprove = await api(`/api/admin/users/${rp.data.user.id}/approve`, {
    method: 'POST', token: tokA, body: {},
  });
  ok(noApprove.status === 403, 'persetujuan hanya untuk admin');

  const rj = await admApi(`/api/admin/users/${rp.data.user.id}/reject`, {
    method: 'POST', body: { reason: 'uji coba penolakan' },
  });
  ok(rj.status === 200 && rj.data.user.status === 'rejected', 'admin menolak pendaftaran');
  const rlRej = await api('/api/auth/login', { method: 'POST', body: { email: pendEmail, password: 'secret123' } });
  ok(rlRej.status === 403 && rlRej.data.code === 'rejected', 'login ditolak setelah reject');

  const apv = await admApi(`/api/admin/users/${rp.data.user.id}/approve`, { method: 'POST', body: {} });
  ok(apv.status === 200 && apv.data.user.status === 'active', 'admin menyetujui pendaftaran');
  const rlOk = await api('/api/auth/login', { method: 'POST', body: { email: pendEmail, password: 'secret123' } });
  ok(rlOk.status === 200 && rlOk.data.token, 'login berhasil setelah disetujui');

  console.log('\n[22] Blokir & buka blokir akun');
  const banEmail = `diblokir${stamp}@test.id`;
  const rb = await signup({ email: banEmail, name: 'Diblokir', password: 'secret123' });
  ok(rb.status === 201 && rb.data.token, 'akun uji blokir disiapkan');
  const tokDiblokir = rb.data.token;
  const sebelumBlokir = await api('/api/auth/me', { token: tokDiblokir });
  ok(sebelumBlokir.status === 200, 'akun aktif sebelum diblokir');

  const noBan = await api(`/api/admin/users/${rb.data.user.id}/ban`, {
    method: 'POST', token: tokA, body: { reason: 'bukan admin' },
  });
  ok(noBan.status === 403, 'pemblokiran hanya untuk admin');

  const ban = await admApi(`/api/admin/users/${rb.data.user.id}/ban`, {
    method: 'POST', body: { reason: 'melanggar aturan' },
  });
  ok(ban.status === 200 && ban.data.user.status === 'banned' && ban.data.stats, 'admin memblokir akun');
  const sesiMati = await api('/api/auth/me', { token: tokDiblokir });
  ok(sesiMati.status === 403 && sesiMati.data.code === 'banned', 'sesi aktif langsung ditolak 403 banned');
  const loginDiblokir = await api('/api/auth/login', { method: 'POST', body: { email: banEmail, password: 'secret123' } });
  ok(loginDiblokir.status === 403 && loginDiblokir.data.code === 'banned', 'login akun diblokir ditolak 403');

  const unban = await admApi(`/api/admin/users/${rb.data.user.id}/unban`, { method: 'POST', body: {} });
  ok(unban.status === 200 && unban.data.user.status === 'active', 'buka blokir mengaktifkan kembali akun');
  const loginUlang = await api('/api/auth/login', { method: 'POST', body: { email: banEmail, password: 'secret123' } });
  ok(loginUlang.status === 200 && loginUlang.data.token, 'login kembali setelah blokir dibuka');

  console.log('\n[23] Pemantauan admin real-time');
  await admLogin(); // sesi admin segar sebelum socket dipasang
  const admSock = io(BASE, { auth: { token: admToken } });
  await new Promise((r) => admSock.on('connect', r));
  ok(true, 'socket admin terhubung ke monitor');

  const liveEmail = `live${stamp}@test.id`;
  const evRegistered = waitAdmin(admSock, 'registered');
  const rLive = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'User-Agent': 'WhatsapTest/1.0 (Android 14)' },
    body: { email: liveEmail, name: 'Live User', password: 'secret123' },
  });
  ok(rLive.status === 201 && rLive.data.pending, 'pendaftaran live dibuat');
  const evReg = await evRegistered;
  ok(evReg.user && evReg.user.email === liveEmail, 'admin menerima event pendaftaran real-time');

  const evApproved = waitAdmin(admSock, 'approved');
  const apLive = await admApi(`/api/admin/users/${rLive.data.user.id}/approve`, { method: 'POST', body: {} });
  ok(apLive.status === 200, 'pendaftaran live disetujui');
  const evAp = await evApproved;
  ok(evAp.user && evAp.user.email === liveEmail, 'admin menerima event persetujuan real-time');

  const evLogin = waitAdmin(admSock, 'login');
  const lgLive = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'User-Agent': 'WhatsapTest/1.0 (Android 14)' },
    body: { email: liveEmail, password: 'secret123' },
  });
  ok(lgLive.status === 200 && lgLive.data.token, 'user live masuk');
  const evLg = await evLogin;
  ok(evLg.email === liveEmail && /WhatsapTest/.test(evLg.device || ''), 'admin menerima event masuk + device');

  const evOnline = waitAdmin(admSock, 'online');
  const liveSock = io(BASE, { auth: { token: lgLive.data.token } });
  await new Promise((r) => liveSock.on('connect', r));
  const evOn = await evOnline;
  ok(evOn.userId === rLive.data.user.id, 'admin menerima event daring real-time');

  const monLive = await admApi('/api/admin/monitor');
  const rowLive = (monLive.data.users || []).find((u) => u.email === liveEmail);
  ok(monLive.status === 200 && rowLive && rowLive.online === true, 'monitor menampilkan status daring');
  ok(rowLive && /WhatsapTest/.test(rowLive.lastDevice || ''), 'device terakhir tercatat di monitor');
  ok(rowLive && rowLive.lastIp, 'IP terakhir tercatat di monitor');
  ok((monLive.data.logs || []).some((l) => l.email === liveEmail && l.result === 'success'),
    'riwayat upaya masuk tercatat');

  const evOffline = waitAdmin(admSock, 'offline');
  liveSock.disconnect();
  const evOff = await evOffline;
  ok(evOff.userId === rLive.data.user.id, 'admin menerima event luring real-time');

  admSock.close();

  console.log('\n[24] Bot admin: Verif AM Prem, Generate NFToken, AI');
  const emitAck = (sock, event, payload) => new Promise((resolve) => sock.emit(event, payload, resolve));

  const sVerif = await admApi('/api/users/search?q=Verif');
  const bVerif = (sVerif.data.users || []).find((u) => u.id === 'bot-verif-am');
  ok(sVerif.status === 200 && !!bVerif, 'admin menemukan bot Verif AM Prem di pencarian');
  ok(!!bVerif && bVerif.verified === true, 'bot Verif AM Prem memakai centang biru');

  const sNft = await admApi('/api/users/search?q=NFToken');
  const bNft = (sNft.data.users || []).find((u) => u.id === 'bot-nftoken');
  ok(!!bNft && bNft.verified === true, 'bot Generate NFToken tampil terverifikasi');

  const sAi = await admApi('/api/users/bot-ai');
  ok(sAi.status === 200 && !!sAi.data.user && sAi.data.user.verified === true, 'bot AI terverifikasi untuk admin');

  const lgBotUser = await api('/api/auth/login', {
    method: 'POST',
    body: { email: liveEmail, password: 'secret123' },
  });
  ok(lgBotUser.status === 200 && !!lgBotUser.data.token, 'user biasa masuk kembali');
  const tokBiasa = lgBotUser.data.token;
  const suBiasa = await api('/api/users/search?q=Verif', { token: tokBiasa });
  ok(suBiasa.status === 200 && (suBiasa.data.users || []).every((u) => !String(u.id).startsWith('bot-')),
    'bot disembunyikan dari pencarian user non-premium');
  const profBiasa = await api('/api/users/bot-verif-am', { token: tokBiasa });
  ok(profBiasa.status === 404, 'profil bot tidak terbuka untuk user non-premium');
  const bukaBiasa = await api('/api/chats/direct', {
    method: 'POST',
    token: tokBiasa,
    body: { peerId: 'bot-verif-am' },
  });
  ok(bukaBiasa.status === 403 && /admin dan pengguna premium/i.test(bukaBiasa.data.error || ''),
    'user non-premium ditolak membuka chat bot');

  // ---- pengguna premium: bot khusus admin & premium ----
  const premEmail = `prem${stamp}@test.id`;
  const rpPrem = await signup({ email: premEmail, name: 'Pengguna Premium', password: 'secret123' });
  ok(rpPrem.status === 201 && !!rpPrem.data.token, 'akun uji premium disiapkan');
  const tokPrem = rpPrem.data.token;
  // id paket diambil dinamis (bisa berubah lewat pengaturan admin);
  // pakai paket tanpa bot eksklusif agar daftar bot lengkap untuk pengujian
  const cfgPrem = await admApi('/api/admin/settings');
  const planPrem = (cfgPrem.data.plans || []).find((p) => !(p.excluded && p.excluded.length))
    || (cfgPrem.data.plans || [])[0];
  ok(!!planPrem, 'daftar paket premium tersedia');
  const grantPrem = await admApi('/api/admin/premium', {
    method: 'POST',
    body: { email: premEmail, plan: planPrem ? planPrem.id : '' },
  });
  ok(grantPrem.status === 200 && grantPrem.data.user.premiumActive === true,
    `admin memberikan premium (aktif) ke akun uji${grantPrem.status === 200 ? '' : ' — ' + JSON.stringify(grantPrem.data)}`);

  const cariPrem = await api('/api/users/search?q=Verif', { token: tokPrem });
  ok((cariPrem.data.users || []).some((u) => u.id === 'bot-verif-am'),
    'user premium melihat bot di pencarian');
  const profPrem = await api('/api/users/bot-verif-am', { token: tokPrem });
  ok(profPrem.status === 200 && profPrem.data.user.isBot === true, 'user premium membuka profil bot');
  const bukaPrem = await api('/api/chats/direct', {
    method: 'POST',
    token: tokPrem,
    body: { peerId: 'bot-verif-am' },
  });
  ok(bukaPrem.status === 201 && !!bukaPrem.data.chat, 'user premium membuka chat bot');

  const premSock = io(BASE, { auth: { token: tokPrem } });
  await new Promise((r) => premSock.on('connect', r));
  const premMenuWait = waitEvent(premSock, 'message:new', 12000).catch(() => null);
  const premAck = await emitAck(premSock, 'message:send', {
    chatId: bukaPrem.data.chat ? bukaPrem.data.chat.id : null, type: 'text', body: 'menu',
  });
  ok(premAck && premAck.ok === true, 'pesan user premium ke bot diterima server');
  const premMenu = await premMenuWait;
  ok(premMenu && premMenu.senderId === 'bot-verif-am' && /VERIF AM PREM/.test(premMenu.body),
    `bot membalas pengguna premium${premMenu ? '' : ' (timeout)'}`);
  premSock.close();

  // premium dicabut -> akses bot tertutup kembali
  const revokePrem = await admApi('/api/admin/premium/revoke', {
    method: 'POST',
    body: { email: premEmail },
  });
  ok(revokePrem.status === 200 && revokePrem.data.user.premiumActive === false,
    'admin mencabut premium akun uji');
  const bukaPasca = await api('/api/chats/direct', {
    method: 'POST',
    token: tokPrem,
    body: { peerId: 'bot-verif-am' },
  });
  ok(bukaPasca.status === 403, 'setelah premium dicabut, buka chat bot ditolak lagi');
  const cariPasca = await api('/api/users/search?q=Verif', { token: tokPrem });
  ok(!(cariPasca.data.users || []).some((u) => String(u.id).startsWith('bot-')),
    'bot hilang dari pencarian setelah premium dicabut');
  const chatsPasca = await api('/api/chats', { token: tokPrem });
  ok(!(chatsPasca.data.chats || []).some((c) => c.peer && c.peer.isBot),
    'chat bot disembunyikan dari daftar chat user non-premium');

  await admLogin(); // sesi admin segar sebelum socket bot dipasang
  const botSock = io(BASE, { auth: { token: admToken } });
  await new Promise((r) => botSock.on('connect', r));

  const chatVerif = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-verif-am' } });
  ok(chatVerif.status === 201 && !!chatVerif.data.chat.peer && chatVerif.data.chat.peer.verified === true,
    'admin membuka chat bot (badge aktif)');
  const vChat = chatVerif.data.chat.id;

  const tMenu = waitEvent(botSock, 'typing', 9000);
  const sMenu = waitEvent(botSock, 'message:status', 9000);
  const mMenu = waitEvent(botSock, 'message:new', 12000);
  const ackMenu = await emitAck(botSock, 'message:send', { chatId: vChat, type: 'text', body: 'menu' });
  ok(ackMenu && ackMenu.ok === true, 'pesan "menu" ke bot diterima server');
  const tpMenu = await tMenu;
  ok(tpMenu && tpMenu.userId === 'bot-verif-am' && tpMenu.typing === true, 'bot menampilkan indikator mengetik');
  const stMenu = await sMenu;
  ok(stMenu && stMenu.status === 'read', 'bot membaca pesan -> pengirim dapat centang biru');
  const mm = await mMenu;
  ok(mm && mm.senderId === 'bot-verif-am' && /VERIF AM PREM/.test(mm.body), 'bot membalas menu profesional');

  const mEmail = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: vChat, type: 'text', body: 'send bukan-email' });
  const me = await mEmail;
  ok(me && /Format email belum benar/.test(me.body), 'bot menolak input salah dengan pesan rapi');

  const chatNft = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-nftoken' } });
  ok(chatNft.status === 201, 'admin membuka chat bot NFToken');
  const nChat = chatNft.data.chat.id;
  const mNft = waitEvent(botSock, 'message:new', 70000);
  await emitAck(botSock, 'message:send', { chatId: nChat, type: 'text', body: 'generate 1' });
  const mn = await mNft;
  ok(mn && mn.senderId === 'bot-nftoken' && /token/i.test(mn.body),
    'bot NFToken menjawab permintaan generate (API api-mazval)');

  const chatAi = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-ai' } });
  ok(chatAi.status === 201, 'admin membuka chat bot AI');
  const aChat = chatAi.data.chat.id;
  for (const perintah of ['gemini halo dari uji', 'gpt halo dari uji', 'deepseek halo dari uji', 'claude halo dari uji']) {
    const tunggu = waitEvent(botSock, 'message:new', 130000);
    await emitAck(botSock, 'message:send', { chatId: aChat, type: 'text', body: perintah });
    const balas = await tunggu;
    const namaModel = perintah.split(' ')[0];
    ok(balas && balas.senderId === 'bot-ai' && String(balas.body).startsWith('🤖'),
      `bot AI model ${namaModel} menjawab nyata tanpa error`);
  }

  const aiEmptyWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: aChat, type: 'text', body: 'gemini' });
  const aiEmpty = await aiEmptyWait;
  ok(aiEmpty && /Pertanyaan masih kosong/.test(aiEmpty.body),
    'bot AI menolak perintah model tanpa pertanyaan');

  console.log('\n[25] Bot baru: Downloader, Email Generator, Tools');

  const chatDown = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-down' } });
  ok(chatDown.status === 201, 'admin membuka chat bot Downloader');
  const dChat = chatDown.data.chat.id;

  const downMenuWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: dChat, type: 'text', body: 'menu' });
  const downMenu = await downMenuWait;
  ok(downMenu && downMenu.senderId === 'bot-down' && /DOWNLOADER/.test(downMenu.body),
    'bot Downloader membalas menu profesional');

  const downErrWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: dChat, type: 'text', body: 'bukan tautan' });
  const downErr = await downErrWait;
  ok(downErr && /Tautan tidak ditemukan/.test(downErr.body),
    'bot Downloader menolak input tanpa tautan dengan rapi');

  // unduhan video bisa ratusan MB -> beri waktu stream ke server lebih longgar
  const downMediaWait = waitEvent(botSock, 'message:new', 180000);
  await emitAck(botSock, 'message:send', {
    chatId: dChat,
    type: 'text',
    body: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  const downMedia = await downMediaWait;
  ok(downMedia && (downMedia.type === 'image' || downMedia.type === 'video') && !!downMedia.mediaUrl,
    'bot Downloader menampilkan video/gambar langsung di chat');
  const downTersimpan = !!(downMedia && downMedia.type === 'video' && /^\/uploads\//.test(downMedia.mediaUrl || ''));
  ok(!downTersimpan || /Hasil unduhan/.test(downMedia.body || ''),
    'file video hasil unduhan tersimpan di server + kapsi "Hasil unduhan"');
  ok(downMedia && /Judul|Tautan unduh|Tautan sumber/.test(downMedia.body || ''),
    'bot Downloader tetap menyertakan judul & tautan');

  const downBareWait = waitEvent(botSock, 'message:new', 180000);
  await emitAck(botSock, 'message:send', {
    chatId: dChat,
    type: 'text',
    body: 'tolong youtu.be/dQw4w9WgXcQ',
  });
  const downBare = await downBareWait;
  ok(downBare && (downBare.type === 'image' || downBare.type === 'video') && !!downBare.mediaUrl,
    'bot Downloader menerima URL polos tanpa https://');

  const chatMail = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-email' } });
  ok(chatMail.status === 201, 'admin membuka chat bot Email Generator');
  const eChat = chatMail.data.chat.id;

  const mailMenuWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: eChat, type: 'text', body: 'menu' });
  const mailMenu = await mailMenuWait;
  ok(mailMenu && mailMenu.senderId === 'bot-email' && /EMAIL GENERATOR/.test(mailMenu.body),
    'bot Email Generator membalas menu profesional');

  const mailErrWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: eChat, type: 'text', body: 'cek bukan-email' });
  const mailErr = await mailErrWait;
  ok(mailErr && /Format email belum benar/.test(mailErr.body),
    'bot Email Generator menolak email salah dengan rapi');

  const mailDomainsWait = waitEvent(botSock, 'message:new', 45000);
  await emitAck(botSock, 'message:send', { chatId: eChat, type: 'text', body: 'domains' });
  const mailDomains = await mailDomainsWait;
  ok(mailDomains && /domain tersedia/.test(mailDomains.body) && mailDomains.body.includes('```'),
    'bot Email Generator menampilkan daftar domain dalam blok kode');

  const chatTools = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: 'bot-tools' } });
  ok(chatTools.status === 201, 'admin membuka chat bot Tools');
  const tChat = chatTools.data.chat.id;

  const toolsMenuWait = waitEvent(botSock, 'message:new', 12000);
  await emitAck(botSock, 'message:send', { chatId: tChat, type: 'text', body: 'menu' });
  const toolsMenu = await toolsMenuWait;
  ok(toolsMenu && toolsMenu.senderId === 'bot-tools' && /Terjemah/.test(toolsMenu.body),
    'bot Tools membalas menu profesional');

  const toolsCuacaWait = waitEvent(botSock, 'message:new', 45000);
  await emitAck(botSock, 'message:send', { chatId: tChat, type: 'text', body: 'cuaca Jakarta' });
  const toolsCuaca = await toolsCuacaWait;
  ok(toolsCuaca && /Cuaca Jakarta/.test(toolsCuaca.body) && toolsCuaca.body.includes('```angka'),
    'bot Tools menampilkan cuaca dengan kartu angka');

  botSock.close();

  console.log('\n[26] Edit nama & foto profil bot (khusus admin)');
  const profBot = await admApi('/api/users/bot-verif-am');
  ok(profBot.status === 200 && profBot.data.user.isBot === true, 'profil bot ditandai isBot');

  const gantiNama = await admApi('/api/admin/bots/bot-down', {
    method: 'PATCH',
    body: { name: 'Downloader Pro' },
  });
  ok(gantiNama.status === 200 && gantiNama.data.user.name === 'Downloader Pro',
    'admin mengganti nama bot');

  const namaPendek = await admApi('/api/admin/bots/bot-down', {
    method: 'PATCH',
    body: { name: 'A' },
  });
  ok(namaPendek.status === 400, 'nama bot minimal 2 karakter');

  await admApi('/api/admin/bots/bot-down', { method: 'PATCH', body: { name: 'Downloader' } });

  const editBiasa = await api('/api/admin/bots/bot-verif-am', {
    method: 'PATCH',
    token: tokBiasa,
    body: { avatar: '/uploads/hack.png' },
  });
  ok(editBiasa.status === 403, 'user biasa ditolak mengubah foto bot');

  const gantiFoto = await admApi('/api/admin/bots/bot-verif-am', {
    method: 'PATCH',
    body: { avatar: '/uploads/bot-verif-avatar.png' },
  });
  ok(gantiFoto.status === 200 && gantiFoto.data.user.avatar === '/uploads/bot-verif-avatar.png'
    && gantiFoto.data.user.isBot === true && gantiFoto.data.user.verified === true,
    'admin mengganti foto profil bot (badge tetap aktif)');

  const fotoAsing = await admApi('/api/admin/bots/bot-verif-am', {
    method: 'PATCH',
    body: { avatar: 'https://evil.example.com/x.png' },
  });
  ok(fotoAsing.status === 400, 'URL foto dari domain asing ditolak');

  const keUserBiasa = await admApi(`/api/admin/bots/${rLive.data.user.id}`, {
    method: 'PATCH',
    body: { avatar: '/uploads/x.png' },
  });
  ok(keUserBiasa.status === 404, 'endpoint hanya menerima akun bot');

  const gantiBio = await admApi('/api/admin/bots/bot-nftoken', {
    method: 'PATCH',
    body: { about: 'Generator NFToken uji.' },
  });
  ok(gantiBio.status === 200 && gantiBio.data.user.about === 'Generator NFToken uji.', 'admin mengubah bio bot');

  const daftarChat = await admApi('/api/chats');
  const chatFoto = (daftarChat.data.chats || []).find((c) => c.peer && c.peer.id === 'bot-verif-am');
  ok(!!chatFoto && chatFoto.peer.avatar === '/uploads/bot-verif-avatar.png', 'daftar chat menampilkan foto bot terbaru');
  ok(!!chatFoto && chatFoto.peer.verified === true && chatFoto.peer.isBot === true, 'peer chat tetap terverifikasi & bertanda bot');

  const resetFoto = await admApi('/api/admin/bots/bot-verif-am', { method: 'PATCH', body: { avatar: null } });
  ok(resetFoto.status === 200 && resetFoto.data.user.avatar === null, 'foto profil bot bisa dikosongkan');
  await admApi('/api/admin/bots/bot-nftoken', {
    method: 'PATCH',
    body: { about: 'Generator NFToken Alight Motion. Ketik "menu".' },
  });

  console.log('\n[27] Total 69 bot: seed, menu, media, rename & tanpa panggilan');

  // socket uji bisa terputus di tengah run panjang (sesi baru / ping) — sambung ulang
  let feedSock = botSock;
  if (!botSock.connected) {
    feedSock = io(BASE, { auth: { token: admToken } });
    await new Promise((r) => feedSock.on('connect', r));
  }
  ok(feedSock.connected === true, 'socket admin uji terhubung saat [27]');
  const cariBot = await admApi('/api/users/search?q=bot.whatsap-indo');
  const daftarBot = (cariBot.data.users || []).filter((u) => u.isBot);
  ok(daftarBot.length === 69, `terdeteksi 69 bot admin (dapat ${daftarBot.length})`);
  ok(daftarBot.every((u) => u.verified === true), 'seluruh bot terverifikasi');

  const chatByBot = {};
  const gagalBuka = [];
  for (const u of daftarBot) {
    const buka = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: u.id } });
    if (buka.status !== 201 || !buka.data.chat) gagalBuka.push(`${u.id}:${buka.status}`);
    else chatByBot[u.id] = buka.data.chat.id;
  }
  ok(gagalBuka.length === 0,
    `chat dengan semua 69 bot bisa dibuka${gagalBuka.length ? ' — gagal: ' + gagalBuka.join(', ') : ''}`);
  ok(!!chatByBot['bot-brat'] && !!chatByBot['bot-pos'], 'chat bot-brat & bot-pos siap dipakai uji balasan');

  const menuWait = waitEvent(feedSock, 'message:new', 12000).catch(() => null);
  const menuAck = await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-brat'], type: 'text', body: 'menu' });
  ok(menuAck && menuAck.ok === true,
    `pesan "menu" ke bot-brat diterima server${menuAck && menuAck.ok ? '' : ' — ' + (menuAck && menuAck.error)}`);
  const menuGenerik = await menuWait;
  ok(menuGenerik && menuGenerik.senderId === 'bot-brat'
    && /GENERATOR GAMBAR/.test(menuGenerik.body)
    && menuGenerik.body.includes('brat <teks>')
    && menuGenerik.body.includes('smeme <teks>'),
    `bot generik membalas menu profesional (dapat: ${menuGenerik ? menuGenerik.senderId : 'timeout'})`);

  const bratWait = waitEvent(feedSock, 'message:new', 30000).catch(() => null);
  const bratAck = await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-brat'], type: 'text', body: 'brat halo dari uji' });
  ok(bratAck && bratAck.ok === true, 'perintah brat diterima server');
  const bratMsg = await bratWait;
  ok(bratMsg && bratMsg.senderId === 'bot-brat' && bratMsg.type === 'image'
    && !!bratMsg.mediaUrl && /brattxt/.test(bratMsg.mediaUrl),
    `bot Generator Gambar mengirim gambar langsung (dapat: ${bratMsg ? bratMsg.type : 'timeout'})`);

  const provWait = waitEvent(feedSock, 'message:new', 25000).catch(() => null);
  const provAck = await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-pos'], type: 'text', body: 'provinsi' });
  ok(provAck && provAck.ok === true, 'perintah provinsi diterima server');
  const provMsg = await provWait;
  ok(provMsg && provMsg.senderId === 'bot-pos' && /✅ Provinsi/.test(provMsg.body)
    && provMsg.body.includes('```json'),
    `bot Kode Pos & Wilayah menjawab daftar provinsi dengan blok JSON (dapat: ${provMsg ? 'balasan' : 'timeout'})`);

  const kurangArgWait = waitEvent(feedSock, 'message:new', 12000).catch(() => null);
  const kurangAck = await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-pos'], type: 'text', body: 'jarak Jakarta' });
  ok(kurangAck && kurangAck.ok === true, 'perintah jarak tanpa argumen diterima server');
  const kurangArg = await kurangArgWait;
  ok(kurangArg && /jarak <dari> <ke>/.test(kurangArg.body) && /Contoh/.test(kurangArg.body),
    'perintah dengan argumen kurang dibalas blok error rapi');

  const renameBiasa = await api('/api/admin/bots/bot-cuaca', {
    method: 'PATCH',
    token: tokBiasa,
    body: { name: 'Hacked' },
  });
  ok(renameBiasa.status === 403, 'user biasa tidak bisa mengganti nama bot');

  const renameBotBaru = await admApi('/api/admin/bots/bot-cuaca', { method: 'PATCH', body: { name: 'Cuaca Resmi' } });
  ok(renameBotBaru.status === 200 && renameBotBaru.data.user.name === 'Cuaca Resmi',
    'admin mengganti nama bot generik baru');
  await admApi('/api/admin/bots/bot-cuaca', { method: 'PATCH', body: { name: 'Cuaca' } });

  let callBotAck = null;
  feedSock.emit('call:invite', { to: 'bot-ai', callId: `call-bot-${stamp}`, kind: 'audio' }, (r) => { callBotAck = r; });
  await new Promise((r) => setTimeout(r, 500));
  ok(callBotAck && callBotAck.ok === false && /Bot tidak dapat dipanggil/.test(callBotAck.error || ''),
    `server menolak panggilan ke bot (dapat: ${callBotAck ? callBotAck.error : 'tanpa balasan'})`);
  ok(jsText.includes('Bot tidak bisa dipanggil') && jsText.includes('botPeer'),
    'frontend menyembunyikan tombol & menjaga startCall untuk bot');

  console.log('\n[28] 15 bot baru: kodesnap, npm zip, katalog model & bot generik');

  const ksWait = waitEvent(feedSock, 'message:new', 30000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-kodesnap'], type: 'text', body: 'kode console.log(1)' });
  const ksMsg = await ksWait;
  ok(ksMsg && ksMsg.senderId === 'bot-kodesnap' && ksMsg.type === 'image'
    && /^\/uploads\//.test(ksMsg.mediaUrl || ''),
    `bot Screenshot Kode mengirim gambar hasil render tersimpan (dapat: ${ksMsg ? ksMsg.type : 'timeout'})`);

  const nzWait = waitEvent(feedSock, 'message:new', 60000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-npm-zip'], type: 'text', body: 'zip left-pad' });
  const nzMsg = await nzWait;
  ok(nzMsg && nzMsg.senderId === 'bot-npm-zip' && nzMsg.type === 'file'
    && /^\/uploads\//.test(nzMsg.mediaUrl || '') && /\.zip/i.test(nzMsg.mediaUrl || ''),
    `bot Unduh Kode npm mengirim berkas zip tersimpan (dapat: ${nzMsg ? nzMsg.type : 'timeout'})`);
  ok(nzMsg && /siap diunduh/.test(nzMsg.body || ''),
    'kapsi npm zip menjelaskan hasil unduhan');

  const mlWait = waitEvent(feedSock, 'message:new', 15000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-model-ai'], type: 'text', body: 'daftar' });
  const mlMsg = await mlWait;
  ok(mlMsg && mlMsg.senderId === 'bot-model-ai' && /Katalog Model AI|Daftar model/.test(mlMsg.body || ''),
    `bot Katalog Model AI menampilkan daftar model (dapat: ${mlMsg ? 'balasan' : 'timeout'})`);

  const ocrWait = waitEvent(feedSock, 'message:new', 15000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-ocr'], type: 'text', body: 'menu' });
  const ocrMenu = await ocrWait;
  ok(ocrMenu && ocrMenu.senderId === 'bot-ocr' && /OCR/.test(ocrMenu.body || '') && /baca /.test(ocrMenu.body || ''),
    'bot OCR Gambar membalas menu profesional');

  const tjWait = waitEvent(feedSock, 'message:new', 25000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-terjemah'], type: 'text', body: 'terjemah good morning' });
  const tjMsg = await tjWait;
  ok(tjMsg && tjMsg.senderId === 'bot-terjemah' && /Terjemahan/.test(tjMsg.body || ''),
    `bot Terjemah menerjemahkan kalimat (dapat: ${tjMsg ? 'balasan' : 'timeout'})`);

  const ipWait = waitEvent(feedSock, 'message:new', 15000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-ip'], type: 'text', body: 'ip 1.1.1.1' });
  const ipMsg = await ipWait;
  ok(ipMsg && ipMsg.senderId === 'bot-ip' && /Info IP/.test(ipMsg.body || ''),
    `bot Cek IP menjawab info IP (dapat: ${ipMsg ? 'balasan' : 'timeout'})`);

  const tw2Wait = waitEvent(feedSock, 'message:new', 25000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-stalker-x'], type: 'text', body: 'twitter nasa' });
  const tw2Msg = await tw2Wait;
  ok(tw2Msg && tw2Msg.senderId === 'bot-stalker-x' && /Profil Twitter/.test(tw2Msg.body || ''),
    `bot Stalk Twitter menjawab profil (dapat: ${tw2Msg ? 'balasan' : 'timeout'})`);

  console.log('\n[29] 20 bot baru: AI, Wilayah Indonesia & Simbol Provinsi');

  const bardMenuWait = waitEvent(feedSock, 'message:new', 12000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-bard'], type: 'text', body: 'menu' });
  const bardMenuMsg = await bardMenuWait;
  ok(bardMenuMsg && bardMenuMsg.senderId === 'bot-bard' && /BARD GOOGLE/.test(bardMenuMsg.body || '')
    && /bard <pertanyaan>/.test(bardMenuMsg.body || ''),
    `bot Bard Google membalas menu profesional (dapat: ${bardMenuMsg ? 'balasan' : 'timeout'})`);

  const bardWait = waitEvent(feedSock, 'message:new', 130000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-bard'], type: 'text', body: 'bard halo dari uji' });
  const bardMsg = await bardWait;
  ok(bardMsg && bardMsg.senderId === 'bot-bard' && String(bardMsg.body || '').startsWith('🤖'),
    `bot AI Bard menjawab pertanyaan nyata tanpa error (dapat: ${bardMsg ? String(bardMsg.body).slice(0, 30) : 'timeout'})`);

  const wlWait = waitEvent(feedSock, 'message:new', 30000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-wilayah'], type: 'text', body: 'provinsi' });
  const wlMsg = await wlWait;
  ok(wlMsg && wlMsg.senderId === 'bot-wilayah' && /✅ Provinsi/.test(wlMsg.body || '')
    && wlMsg.body.includes('```json'),
    `bot Wilayah Indonesia menjawab daftar provinsi (dapat: ${wlMsg ? 'balasan' : 'timeout'})`);

  const symWait = waitEvent(feedSock, 'message:new', 30000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-simbol'], type: 'text', body: 'simbol' });
  const symMsg = await symWait;
  ok(symMsg && symMsg.senderId === 'bot-simbol' && /Simbol Provinsi/.test(symMsg.body || '')
    && symMsg.body.includes('```json'),
    `bot Simbol Provinsi menjawab daftar simbol (dapat: ${symMsg ? 'balasan' : 'timeout'})`);

  const wlKabWait = waitEvent(feedSock, 'message:new', 30000).catch(() => null);
  await emitAck(feedSock, 'message:send', { chatId: chatByBot['bot-wilayah'], type: 'text', body: 'kabupaten 31' });
  const wlKabMsg = await wlKabWait;
  ok(wlKabMsg && wlKabMsg.senderId === 'bot-wilayah' && /Kabupaten \/ Kota/.test(wlKabMsg.body || '')
    && wlKabMsg.body.includes('```json'),
    `bot Wilayah Indonesia menjawab kabupaten dalam provinsi (dapat: ${wlKabMsg ? 'balasan' : 'timeout'})`);

  console.log('\n[30] Daftar bot khusus premium (menu Daftar Bot)');
  const katalogBiasa = await api('/api/bots', { token: tokBiasa });
  ok(katalogBiasa.status === 403 && katalogBiasa.data.locked === true
    && katalogBiasa.data.total === 69 && Array.isArray(katalogBiasa.data.plans)
    && katalogBiasa.data.plans.length >= 3,
    'user non-premium ditolak: panel terkunci + daftar paket premium');

  // premium akun uji sudah dicabut di [24], dikembalikan untuk menguji daftar bot
  const grantKatalog = await admApi('/api/admin/premium', {
    method: 'POST',
    body: { email: premEmail, plan: planPrem ? planPrem.id : '' },
  });
  ok(grantKatalog.status === 200 && grantKatalog.data.user.premiumActive === true,
    'premium akun uji dikembalikan untuk pengujian daftar bot');

  const katalogPrem = await api('/api/bots', { token: tokPrem });
  const grupPrem = katalogPrem.data.groups || [];
  const idPrem = grupPrem.flatMap((g) => g.bots.map((b) => b.id));
  ok(katalogPrem.status === 200 && katalogPrem.data.total === 69 && idPrem.length === 69,
    'user premium menerima daftar lengkap 69 bot');
  ok(new Set(idPrem).size === idPrem.length && grupPrem.every((g) => g.label && g.desc && g.bots.length),
    'daftar terkelompok per kategori tanpa duplikat');
  ok(grupPrem.every((g) => g.bots.every((b) => b.id && b.name && b.about))
    && katalogPrem.data.premiumOnly === true,
    'tiap bot punya nama & deskripsi, daftar ditandai premium-only');

  const katalogAdm = await admApi('/api/bots');
  ok(katalogAdm.status === 200 && (katalogAdm.data.groups || []).length === grupPrem.length,
    'admin melihat daftar bot yang sama');

  const chatDariKatalog = await api('/api/chats/direct', {
    method: 'POST',
    token: tokPrem,
    body: { peerId: 'bot-glm' },
  });
  ok(chatDariKatalog.status === 201 && !!chatDariKatalog.data.chat.id,
    'premium bisa membuka chat bot langsung dari daftar');

  const revokeKatalog = await admApi('/api/admin/premium/revoke', {
    method: 'POST',
    body: { email: premEmail },
  });
  ok(revokeKatalog.status === 200 && revokeKatalog.data.user.premiumActive === false,
    'premium akun uji dicabut kembali setelah pengujian');

  console.log('\n[31] Paket premium, kuota bot & undangan teman');

  // daftar paket resmi dibuka dari aplikasi (tanpa edit admin)
  const paketApi = await api('/api/plans', { token: tokB });
  ok(paketApi.status === 200 && Array.isArray(paketApi.data.plans) && paketApi.data.plans.length >= 4,
    'halaman paket menerima daftar paket premium');
  const harga = Object.fromEntries((paketApi.data.plans || []).map((p) => [p.id, p.price]));
  ok(harga.harian === 1000 && harga.mingguan === 10000 && harga.bulanan === 25000 && harga.permanen === 50000,
    'harga paket resmi: Rp1.000 / Rp10.000 / Rp25.000 / Rp50.000');
  const paketHarian = (paketApi.data.plans || []).find((p) => p.id === 'harian');
  ok(!!paketHarian && (paketHarian.excluded || []).length === 5 && paketHarian.dailyLimit === 50,
    'paket Harian: 5 bot eksklusif ditutup + limit 50 pesan/hari');
  const paketPermanen = (paketApi.data.plans || []).find((p) => p.id === 'permanen');
  ok(!!paketPermanen && paketPermanen.permanent === true && paketPermanen.dailyLimit === 0,
    'paket Permanen: permanen + tanpa limit');
  ok(paketApi.data.botTotal === 69 && Array.isArray(paketApi.data.exclusiveBotIds)
    && paketApi.data.exclusiveBotIds.length === 5,
    'total bot & daftar bot eksklusif dikirim ke halaman paket');
  ok(!!paketApi.data.me && typeof paketApi.data.me.tokens === 'number' && typeof paketApi.data.me.used === 'number'
    && paketApi.data.invite && /^WA-MAZ-VAL-[A-Z0-9]{4}$/.test(paketApi.data.invite.code || ''),
    'status paket + kode undangan saya');

  // undangan: kode format resmi, tamu join, kedua pihak dapat token
  const refA = await api('/api/referral', { token: tokA });
  ok(refA.status === 200 && /^WA-MAZ-VAL-[A-Z0-9]{4}$/.test(refA.data.code || '')
    && String(refA.data.link || '').includes(`?ref=${refA.data.code}`),
    'kode undangan WA-MAZ-VAL-XXXX + link siap dibagikan');
  const tokenSebelum = refA.data.tokens;
  const tamuEmail = `tamu${stamp}@test.id`;
  const regTamu = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Tamu Undangan', email: tamuEmail, password: 'secret123', ref: refA.data.code },
  });
  ok(regTamu.status === 201 && regTamu.data.pending === true && regTamu.data.refApplied === true,
    'pendaftar baru memakai kode undangan');
  const refA2 = await api('/api/referral', { token: tokA });
  ok(refA2.data.tokens === tokenSebelum,
    'token pengundang baru masuk setelah tamu disetujui');
  const apTamu = await admApi(`/api/admin/users/${regTamu.data.user.id}/approve`, { method: 'POST', body: {} });
  ok(apTamu.status === 200, 'tamu undangan disetujui admin');
  const refA3 = await api('/api/referral', { token: tokA });
  ok(refA3.data.tokens === tokenSebelum + 5 && refA3.data.invited === 1,
    'pengundang mendapat +5 token & 1 undangan tercatat');
  const lgTamu = await api('/api/auth/login', { method: 'POST', body: { email: tamuEmail, password: 'secret123' } });
  const refTamu = await api('/api/referral', { token: lgTamu.data.token });
  ok(refTamu.status === 200 && refTamu.data.tokens === 5 && refTamu.data.referred === true,
    'tamu mendapat 5 token selamat datang');
  const regSalah = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Salah Kode', email: `salah${stamp}@test.id`, password: 'secret123', ref: 'WA-MAZ-VAL-99' },
  });
  ok(regSalah.status === 400 && /undangan/i.test(regSalah.data.error || ''),
    'kode undangan tidak valid ditolak 400');

  // paket uji limit harian 1 pesan
  const setLimit = await admApi('/api/admin/settings', {
    method: 'PUT',
    body: {
      plans: [
        { id: 'uji-sehari', label: '1 Hari', days: 1, price: 1000, dailyLimit: 0, excluded: [] },
        { id: 'mingguan', label: 'Mingguan', days: 7, price: 10000, dailyLimit: 200, excluded: [] },
        { id: 'bulanan', label: 'Bulanan', days: 30, price: 25000, dailyLimit: 0, excluded: [] },
        { id: 'uji-limit', label: 'Uji Limit', days: 2, price: 5000, dailyLimit: 1, excluded: [] },
      ],
    },
  });
  ok(setLimit.status === 200 && setLimit.data.plans.some((p) => p.id === 'uji-limit'),
    'admin menambah paket dengan limit harian');

  const limEmail = `limit${stamp}@test.id`;
  const rpLim = await signup({ email: limEmail, name: 'Uji Limit', password: 'secret123' });
  ok(rpLim.status === 201, 'akun uji limit disiapkan');
  const grantLim = await admApi('/api/admin/premium', {
    method: 'POST', body: { email: limEmail, plan: 'uji-limit' },
  });
  ok(grantLim.status === 200 && grantLim.data.user.premiumActive === true,
    'premium paket limit harian diberikan');
  const chatLim = await api('/api/chats/direct', {
    method: 'POST', token: rpLim.data.token, body: { peerId: 'bot-glm' },
  });
  ok(chatLim.status === 201 && !!chatLim.data.chat.id, 'paket limit tetap bisa membuka bot');

  const limSock = io(BASE, { auth: { token: rpLim.data.token } });
  await new Promise((r) => limSock.on('connect', r));
  const limAck1 = await emitAck(limSock, 'message:send', {
    chatId: chatLim.data.chat.id, type: 'text', body: 'halo pertama',
  });
  ok(limAck1 && limAck1.ok === true, 'pesan pertama (sesuai limit harian) diterima');
  const limAck2 = await emitAck(limSock, 'message:send', {
    chatId: chatLim.data.chat.id, type: 'text', body: 'halo kedua beda',
  });
  ok(limAck2 && limAck2.ok === false && /Kuota bot/i.test(limAck2.error || ''),
    'pesan kedua ditolak: kuota harian habis & token 0');
  limSock.close();

  // paket Harian menyembunyikan bot eksklusif
  const grantHarian = await admApi('/api/admin/premium', {
    method: 'POST', body: { email: limEmail, plan: 'harian' },
  });
  ok(grantHarian.status === 200 && grantHarian.data.user.premiumActive === true,
    'akun uji dipindah ke paket Harian');
  const katHarian = await api('/api/bots', { token: rpLim.data.token });
  const idHarian = (katHarian.data.groups || []).flatMap((g) => g.bots.map((b) => b.id));
  ok(katHarian.status === 200 && katHarian.data.total === 64 && idHarian.length === 64
    && !idHarian.includes('bot-verif-am') && !idHarian.includes('bot-nftoken'),
    'paket Harian menyembunyikan 5 bot eksklusif (69 - 5 = 64)');
  const bukaEks = await api('/api/chats/direct', {
    method: 'POST', token: rpLim.data.token, body: { peerId: 'bot-nik' },
  });
  ok(bukaEks.status === 403 && /tidak termasuk paket/i.test(bukaEks.data.error || ''),
    'chat bot eksklusif ditolak dengan pesan upgrade');
  const cariEks = await api('/api/users/search?q=Verif', { token: rpLim.data.token });
  ok((cariEks.data.users || []).every((u) => u.id !== 'bot-verif-am'),
    'bot eksklusif tidak muncul di pencarian paket Harian');
  const profilEks = await api('/api/users/bot-verif-am', { token: rpLim.data.token });
  ok(profilEks.status === 404, 'profil bot eksklusif 404 untuk paket Harian');

  // admin tetap melihat semua bot + bisa atur paket
  const katAdmAkhir = await admApi('/api/bots');
  ok(katAdmAkhir.status === 200 && katAdmAkhir.data.total === 69, 'admin tetap melihat 69 bot');
  const setBalik = await admApi('/api/admin/settings', {
    method: 'PUT',
    body: {
      plans: [
        { id: 'uji-sehari', label: '1 Hari', days: 1, price: 1000, dailyLimit: 0, excluded: [] },
        { id: 'mingguan', label: 'Mingguan', days: 7, price: 10000, dailyLimit: 200, excluded: [] },
        { id: 'bulanan', label: 'Bulanan', days: 30, price: 25000, dailyLimit: 0, excluded: [] },
      ],
    },
  });
  ok(setBalik.status === 200, 'pengaturan paket dikembalikan');

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
