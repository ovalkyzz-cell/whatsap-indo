'use strict';
/* Uji: (1) hapus percakapan per-pengguna (riwayat hanya hilang untuk penghapus,
   chat hidup lagi saat pesan baru) (2) blokir kontak dua arah
   (pesan/typing/panggilan ditolak, grup tak terpengaruh, buka blokir pulih). */
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
function callInvite(sock, to, callId, kind) {
  return new Promise((res) => { const t = setTimeout(() => res(null), 6000); sock.emit('call:invite', { to, callId, kind }, (r) => { clearTimeout(t); res(r); }); });
}
// menunggu event 'typing' dari pengguna tertentu di chat tertentu (true=datang)
function waitTyping(sock, chatId, userId, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off('typing', h); res(false); }, ms);
    const h = (p) => {
      if (p && p.chatId === chatId && p.userId === userId) { clearTimeout(t); sock.off('typing', h); res(true); }
    };
    sock.on('typing', h);
  });
}

(async () => {
  console.log('\n=== Uji hapus percakapan + blokir kontak ===');
  await admLogin();
  const stamp = Date.now();

  const a = await signup({ email: `blk-a${stamp}@mail.com`, name: `BlokAlice${stamp}`, password: 'rahasia123' });
  const b = await signup({ email: `blk-b${stamp}@mail.com`, name: `BlokBob${stamp}`, password: 'rahasia123' });
  const c = await signup({ email: `blk-c${stamp}@mail.com`, name: `BlokCitra${stamp}`, password: 'rahasia123' });
  ok(!!a.data.token && !!b.data.token && !!c.data.token, 'tiga pengguna terdaftar & login');
  const tokA = a.data.token, tokB = b.data.token, tokC = c.data.token;
  const idA = a.data.user.id, idB = b.data.user.id, idC = c.data.user.id;

  const dc = await api('/api/chats/direct', { method: 'POST', body: { peerId: idB }, token: tokA });
  const chatId = dc.data.chat && dc.data.chat.id;
  ok(!!chatId, 'chat direct a<->b terbentuk');

  const sockA = await connect(tokA);
  const sockB = await connect(tokB);

  /* ============ 1. HAPUS PERCAKAPAN ============ */
  ok((await send(sockA, { chatId, type: 'text', body: 'pesan-1-dari-a' }))?.ok, 'a mengirim pesan 1');
  await sleep(30);
  ok((await send(sockB, { chatId, type: 'text', body: 'pesan-2-dari-b' }))?.ok, 'b membalas pesan 2');
  await sleep(30);
  ok((await send(sockA, { chatId, type: 'text', body: 'pesan-3-dari-a' }))?.ok, 'a mengirim pesan 3');
  await sleep(60);

  const del1 = await api(`/api/chats/${chatId}`, { method: 'DELETE', token: tokA });
  ok(del1.status === 200 && del1.data.ok === true && Number(del1.data.clearedAt) > 0, 'DELETE /api/chats/:id oleh a -> 200 ok');

  const listA1 = await api('/api/chats', { token: tokA });
  const chatA1 = (listA1.data.chats || []).find((x) => x.id === chatId);
  ok(!!chatA1 && chatA1.hidden === true, 'daftar a: chat hidden=true');
  ok(!!chatA1 && chatA1.lastMessage === null, 'daftar a: lastMessage=null');
  ok(!!chatA1 && chatA1.unread === 0, 'daftar a: unread=0');
  ok(!!chatA1 && Number(chatA1.clearedAt) > 0, 'daftar a: clearedAt terisi');

  const listB1 = await api('/api/chats', { token: tokB });
  const chatB1 = (listB1.data.chats || []).find((x) => x.id === chatId);
  ok(!!chatB1 && chatB1.hidden !== true, 'daftar b: chat TIDAK ikut tersembunyi');
  ok(!!chatB1 && !!chatB1.lastMessage, 'daftar b: lastMessage tetap ada');

  const msgA1 = await api(`/api/chats/${chatId}/messages`, { token: tokA });
  ok(msgA1.status === 200 && msgA1.data.messages.length === 0, 'riwayat a: 0 pesan setelah hapus');
  const msgB1 = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  ok(msgB1.data.messages.length === 3, `riwayat b: tetap 3 pesan (dapat ${msgB1.data.messages.length})`);

  // pesan baru dari b -> chat a hidup lagi dengan HANYA pesan baru
  await sleep(30);
  ok((await send(sockB, { chatId, type: 'text', body: 'pesan-baru-setelah-hapus' }))?.ok, 'b mengirim pesan baru setelah a menghapus');
  await sleep(150);

  const listA2 = await api('/api/chats', { token: tokA });
  const chatA2 = (listA2.data.chats || []).find((x) => x.id === chatId);
  ok(!!chatA2 && chatA2.hidden === false, 'chat a muncul kembali (hidden=false)');
  ok(!!chatA2 && chatA2.lastMessage && chatA2.lastMessage.body === 'pesan-baru-setelah-hapus', 'lastMessage a = hanya pesan baru');
  ok(!!chatA2 && chatA2.unread === 1, `unread a = 1 (dapat ${chatA2 && chatA2.unread})`);

  const msgA2 = await api(`/api/chats/${chatId}/messages`, { token: tokA });
  ok(msgA2.data.messages.length === 1, `riwayat a: hanya 1 pesan (dapat ${msgA2.data.messages.length})`);
  ok(msgA2.data.messages[0] && msgA2.data.messages[0].body === 'pesan-baru-setelah-hapus', 'isi riwayat a = pesan baru saja');

  const delC = await api(`/api/chats/${chatId}`, { method: 'DELETE', token: tokC });
  ok(delC.status === 403, 'c (bukan anggota) menghapus -> 403');

  // hapus percakapan GRUP juga per-pengguna
  const gr = await api('/api/chats/group', { method: 'POST', body: { name: `GrupHapus${stamp}`, memberIds: [idB] }, token: tokA });
  ok(gr.status === 201 && !!(gr.data.chat && gr.data.chat.id), 'grup a+b terbentuk');
  const groupId = gr.data.chat.id;
  const delG1 = await api(`/api/chats/${groupId}`, { method: 'DELETE', token: tokA });
  ok(delG1.status === 200, 'a menghapus percakapan grup -> 200');
  const listGa = (await api('/api/chats', { token: tokA })).data.chats.find((x) => x.id === groupId);
  const listGb = (await api('/api/chats', { token: tokB })).data.chats.find((x) => x.id === groupId);
  ok(!!listGa && listGa.hidden === true, 'grup: hidden untuk a');
  ok(!!listGb && listGb.hidden !== true, 'grup: TIDAK hidden untuk b');

  /* ============ 2. BLOKIR KONTAK ============ */
  // kontrol positif: typing b diterima a SEBELUM diblokir
  const typePre = waitTyping(sockA, chatId, idB, 2500);
  sockB.emit('typing', { chatId, typing: true });
  ok(await typePre, 'typing b -> a diterima (sebelum blokir)');

  const blk1 = await api(`/api/blocks/${idB}`, { method: 'POST', token: tokA });
  ok(blk1.status === 200 && blk1.data.blocked === true, 'a memblokir b -> 200 ok');
  await sleep(120); // biarkan event chat:updated merambat dulu

  const blkSelf = await api(`/api/blocks/${idA}`, { method: 'POST', token: tokA });
  ok(blkSelf.status === 400, 'blokir diri sendiri -> 400');
  const blkNone = await api('/api/blocks/tidak-ada-id', { method: 'POST', token: tokA });
  ok(blkNone.status === 404, 'blokir pengguna tidak ada -> 404');
  const cs = await api('/api/cs', { token: tokA });
  if (cs.data.user && cs.data.user.id) {
    const blkAdm = await api(`/api/blocks/${cs.data.user.id}`, { method: 'POST', token: tokA });
    ok(blkAdm.status === 400, 'blokir akun admin/CS -> 400');
  } else {
    ok(false, 'blokir akun admin/CS -> 400 (kontak CS tak tersedia)');
  }

  const blkList = await api('/api/blocks', { token: tokA });
  ok((blkList.data.users || []).some((u) => u.id === idB), 'GET /api/blocks memuat b');

  // dua arah: b dan a sama-sama ditolak mengirim pesan
  const sB1 = await send(sockB, { chatId, type: 'text', body: 'b-coba-kirim' });
  ok(sB1 && sB1.ok === false && !!sB1.error, `b ditolak kirim pesan: "${sB1 && sB1.error}"`);
  const sA1 = await send(sockA, { chatId, type: 'text', body: 'a-coba-kirim' });
  ok(sA1 && sA1.ok === false && !!sA1.error, `a ditolak kirim pesan: "${sA1 && sA1.error}"`);

  // typing b -> a TIDAK diterima selama blokir
  const typeBlk = waitTyping(sockA, chatId, idB, 2000);
  sockB.emit('typing', { chatId, typing: true });
  ok(!(await typeBlk), 'typing b -> a TIDAK diterima (diblokir)');

  // panggilan ditolak dua arah
  const callAB = await callInvite(sockA, idB, `call-a-${stamp}`, 'audio');
  ok(callAB && callAB.ok === false, `panggilan a->b ditolak: "${callAB && callAB.error}"`);
  const callBA = await callInvite(sockB, idA, `call-b-${stamp}`, 'audio');
  ok(callBA && callBA.ok === false, `panggilan b->a ditolak: "${callBA && callBA.error}"`);

  // flag blokir di berbagai API
  const uA = await api(`/api/users/${idB}`, { token: tokA });
  ok(uA.data.user && uA.data.user.blockedByMe === true && uA.data.user.blockedMe === false, 'users/:idB (dari a): blockedByMe=true');
  const uB = await api(`/api/users/${idA}`, { token: tokB });
  ok(uB.data.user && uB.data.user.blockedMe === true && uB.data.user.blockedByMe === false, 'users/:idA (dari b): blockedMe=true');

  const chatA3 = ((await api('/api/chats', { token: tokA })).data.chats || []).find((x) => x.id === chatId);
  ok(!!chatA3 && chatA3.peer && chatA3.peer.blockedByMe === true, 'daftar a: peer.blockedByMe=true');
  const chatB3 = ((await api('/api/chats', { token: tokB })).data.chats || []).find((x) => x.id === chatId);
  ok(!!chatB3 && chatB3.peer && chatB3.peer.blockedMe === true, 'daftar b: peer.blockedMe=true');

  const contactsB = await api('/api/contacts?limit=100', { token: tokB });
  const contactA = (contactsB.data.users || []).find((u) => u.id === idA);
  ok(!!contactA && contactA.blockedMe === true, 'contacts (dari b): a.blockedMe=true');

  // riwayat tetap bisa dibaca meski diblokir
  const msgB2 = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  ok(msgB2.status === 200 && msgB2.data.messages.length === 4, `b tetap membaca riwayat (dapat ${msgB2.data.messages.length}/4)`);

  // grup tidak terpengaruh blokir: b tetap boleh kirim di grup
  const sGrp = await send(sockB, { chatId: groupId, type: 'text', body: 'b-kirim-di-grup-saat-diblokir' });
  ok(sGrp && sGrp.ok === true, 'grup: b tetap bisa kirim pesan saat diblokir');

  /* ============ 3. BUKA BLOKIR ============ */
  const unblk = await api(`/api/blocks/${idB}`, { method: 'DELETE', token: tokA });
  ok(unblk.status === 200 && unblk.data.blocked === false, 'a membuka blokir b -> 200 ok');
  await sleep(120);

  const sB2 = await send(sockB, { chatId, type: 'text', body: 'b-setelah-buka-blokir' });
  ok(sB2 && sB2.ok === true, 'b bisa kirim pesan lagi setelah blokir dibuka');
  const sA2 = await send(sockA, { chatId, type: 'text', body: 'a-setelah-buka-blokir' });
  ok(sA2 && sA2.ok === true, 'a bisa kirim pesan lagi setelah blokir dibuka');

  const chatA4 = ((await api('/api/chats', { token: tokA })).data.chats || []).find((x) => x.id === chatId);
  ok(!!chatA4 && chatA4.peer && chatA4.peer.blockedByMe === false, 'daftar a: peer.blockedByMe=false setelah dibuka');

  const typePost = waitTyping(sockA, chatId, idB, 2500);
  sockB.emit('typing', { chatId, typing: true });
  ok(await typePost, 'typing b -> a diterima lagi setelah blokir dibuka');

  sockA.close();
  sockB.close();
  console.log(`\n=== hapus percakapan + blokir: ${pass} lulus, ${fail} gagal ===`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('GAGAL:', err);
  process.exit(1);
});
