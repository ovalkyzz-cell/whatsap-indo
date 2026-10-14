'use strict';
/* Uji: (1) video sekali lihat (konsumsi atomik di server)
   (2) arsip chat per-pengguna + otomatis keluar arsip saat ada pesan baru. */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗ FAIL:', l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const ADMIN_EMAIL = 'ovalkyzz@gmail.com', ADMIN_PASSWORD = 'secret123';
let admToken = null;
async function admLogin() {
  let r = await api('/api/auth/register', { method: 'POST', body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD } });
  if (r.status !== 201) r = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!r.data || !r.data.token) throw new Error('admin gagal');
  admToken = r.data.token; return admToken;
}
async function admApi(p, o = {}) {
  if (!admToken) await admLogin();
  let r = await api(p, { ...o, token: admToken });
  if (r.status === 401) { await admLogin(); r = await api(p, { ...o, token: admToken }); }
  return r;
}
async function signup({ email, name, password }) {
  const r = await api('/api/auth/register', { method: 'POST', body: { email, name, password } });
  if (r.status !== 201) return r;
  if (!r.data.pending) return r;
  const ap = await admApi(`/api/admin/users/${encodeURIComponent(r.data.user.id)}/approve`, { method: 'POST', body: {} });
  if (ap.status !== 200) return { status: 500, data: { error: `approve: ${ap.status}` } };
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return { status: 201, data: { ...lg.data, pending: false } };
}
function connect(token) {
  return new Promise((res, rej) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error('timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}
function send(sock, payload) {
  return new Promise((res) => { const t = setTimeout(() => res(null), 8000); sock.emit('message:send', payload, (ack) => { clearTimeout(t); res(ack); }); });
}

(async () => {
  console.log('\n=== Uji video sekali lihat + arsip chat ===');
  await admLogin();
  const stamp = Date.now();

  const a = await signup({ email: `ava${stamp}@mail.com`, name: 'Alice', password: 'rahasia123' });
  const b = await signup({ email: `bob${stamp}@mail.com`, name: 'Bob', password: 'rahasia123' });
  const tokA = a.data.token, tokB = b.data.token;
  const idB = b.data.user.id;

  const dc = await api('/api/chats/direct', { method: 'POST', body: { peerId: idB }, token: tokA });
  const chatId = dc.data.chat.id;
  ok(!!chatId, 'chat direct a<->b terbentuk');

  // ===== 1. ARSIP CHAT =====
  const ar1 = await api(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived: true }, token: tokA });
  ok(ar1.status === 200 && ar1.data.archived === true, 'a mengarsipkan chat (ok)');

  const listA1 = await api('/api/chats', { token: tokA });
  const chatA1 = (listA1.data.chats || []).find((c) => c.id === chatId);
  ok(chatA1 && chatA1.archived === true, 'daftar chat a: archived=true');

  const listB1 = await api('/api/chats', { token: tokB });
  const chatB1 = (listB1.data.chats || []).find((c) => c.id === chatId);
  ok(chatB1 && chatB1.archived === false, 'arsip per-pengguna: b TIDAK ikut terarsip');

  // b kirim pesan -> a otomatis keluar arsip
  const sockB = await connect(tokB);
  await sleep(50);
  await send(sockB, { chatId, type: 'text', body: 'Halo dari Bob' });
  await sleep(250);
  const listA2 = await api('/api/chats', { token: tokA });
  const chatA2 = (listA2.data.chats || []).find((c) => c.id === chatId);
  ok(chatA2 && chatA2.archived === false, 'pesan baru -> chat a otomatis keluar arsip');

  // a mengarsipkan lagi lalu un-arsip manual
  await api(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived: true }, token: tokA });
  const ar2 = await api(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived: false }, token: tokA });
  const listA3 = await api('/api/chats', { token: tokA });
  const chatA3 = (listA3.data.chats || []).find((c) => c.id === chatId);
  ok(ar2.status === 200 && chatA3 && chatA3.archived === false, 'un-arsip manual mengembalikan chat');

  // non-anggota tidak boleh mengarsipkan
  const stranger = await signup({ email: `str${stamp}@mail.com`, name: 'Stranger', password: 'rahasia123' });
  const arStr = await api(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived: true }, token: stranger.data.token });
  ok(arStr.status === 403, 'non-anggota ditolak mengarsipkan (403)');

  // ===== 2. VIDEO SEKALI LIHAT (A kirim, B buka) =====
  const sockA = await connect(tokA);
  // a unggah video
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-mp4-bytes')], { type: 'video/mp4' }), 'rahasia.mp4');
  const upRes = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fd });
  const up = await upRes.json();
  ok(upRes.status === 201 && up.url && up.type === 'video', `video terunggah (${up.type})`);

  const waitVo = Promise.race([
    new Promise((r) => sockB.once('message:new', r)),
    sleep(6000).then(() => null),
  ]);
  const voAck = await send(sockA, { chatId, type: 'video', body: '', media: up, viewOnce: true });
  const voMsg = await waitVo;
  await sleep(80);
  ok(voAck?.ok && voAck.message.viewOnce === true, 'video sekali lihat tersimpan (viewOnce=true)');
  ok(voMsg && voMsg.viewOnce === true && /\/api\/messages\/media\//.test(voMsg.mediaUrl || ''), 'penerima mendapat URL tergates');

  const voUrl = `${BASE}/api/messages/media/${voMsg.id}`;
  // tanpa auth -> 401 (terproteksi)
  const voNo = await fetch(voUrl, { redirect: 'manual' });
  ok(voNo.status === 401, 'akses tanpa token ditolak (401)');
  // buka pertama -> 302 (konsumsi)
  const vo1 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokB}` }, redirect: 'manual' });
  ok(vo1.status === 302, 'buka pertama -> 302 (redirect ke media)');
  // buka kedua -> 410
  const vo2 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokB}` }, redirect: 'manual' });
  ok(vo2.status === 410, 'buka kedua -> 410 (sudah dibuka)');
  // pengirim tetap boleh
  const vo3 = await fetch(voUrl, { headers: { Authorization: `Bearer ${tokA}` }, redirect: 'manual' });
  ok(vo3.status === 302, 'pengirim masih boleh membuka video miliknya');

  // penerima melihat status terkonsumsi
  const rm = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  const voInB = (rm.data.messages || []).find((m) => m.id === voMsg.id);
  ok(voInB && voInB.opened === true && voInB.mediaUrl === null, 'penerima melihat status sudah dibuka');

  sockA.close();
  sockB.close();
  console.log(`\n=== Selesai: ${pass} lulus, ${fail} gagal ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
