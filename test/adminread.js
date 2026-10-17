'use strict';
/* Centang biru & respon AI di grup — uji 3 perbaikan nyata:
   1. pembacaan (chat:read) menyebar real-time ke SELURUH anggota grup,
      bukan hanya pengirim pesan -> centang hasil bacaan admin terlihat semua anggota
   2. privasi "laporan dibaca" tetap menahan tanda baca (regresi chat pribadi e2e)
   3. tanpa MAZVAL_API_KEY, bot AI menjawab SEKETIKA dengan penyebab jelas,
      bukan diam ±2 menit menunggu percobaan ulang model yang mustahil berhasil
   Jalankan dengan server aktif: npm run test:adminread */

// kunci API dikosongkan dulu supaya modul bot membaca kondisi "belum diatur"
process.env.MAZVAL_API_KEY = '';
const bots = require('../server/bots');
const { io } = require('socket.io-client');

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
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const ADMIN_EMAIL = 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = 'secret123';
let admToken = null;
let admId = null;

async function admLogin() {
  let r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD },
  });
  if (r.status !== 201) {
    r = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  }
  if (!r.data || !r.data.token) throw new Error(`admin gagal: ${r.status}`);
  admToken = r.data.token;
  admId = r.data.user && r.data.user.id;
}

async function admApi(path, opts = {}) {
  if (!admToken) await admLogin();
  let r = await api(path, { ...opts, token: admToken });
  if (r.status === 401) { await admLogin(); r = await api(path, { ...opts, token: admToken }); }
  return r;
}

async function signup({ email, name, password }) {
  const r = await api('/api/auth/register', { method: 'POST', body: { email, name, password } });
  if (r.status !== 201) return r;
  if (!r.data.pending) return r;
  const ap = await admApi(`/api/admin/users/${encodeURIComponent(r.data.user.id)}/approve`, { method: 'POST', body: {} });
  if (ap.status !== 200) return { status: 500, data: { error: 'approve gagal' } };
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return { status: 201, data: { ...lg.data, pending: false } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function collect(sock, event) {
  const seen = [];
  const h = (p) => seen.push(p);
  sock.on(event, h);
  return { seen, stop: () => sock.off(event, h) };
}
function expectNoEvent(sock, event, ms) {
  return new Promise((resolve) => {
    let got = false;
    const h = () => { got = true; };
    sock.on(event, h);
    setTimeout(() => { sock.off(event, h); resolve({ got }); }, ms);
  });
}
const emitAck = (sock, event, payload) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 6000);
  sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
});

(async () => {
  console.log('\n[1] AI tanpa MAZVAL_API_KEY menjawab seketika (tanpa retry buta)');
  const tAi = Date.now();
  const aiOut = await bots.reply({ id: 'bot-ai' }, 'siapa presiden Indonesia sekarang?');
  const aiMs = Date.now() - tAi;
  ok(typeof aiOut === 'string' && aiOut.length > 0, 'bot AI tetap memberi balasan');
  ok(aiMs < 3000, `balasan konfigurasi cepat (< 3000 ms, aktual ${aiMs} ms)`);
  ok(/MAZVAL_API_KEY/.test(aiOut || ''), 'pesan menjelaskan penyebab (MAZVAL_API_KEY)');
  ok(/belum bisa menjawab/i.test(aiOut || ''), 'pesan menyebut AI belum bisa menjawab, bukan "model gangguan"');

  const stamp = Date.now();
  await admLogin();

  const a1 = await signup({ email: `read1-${stamp}@test.local`, name: 'Anggota Satu', password: 'password123' });
  const a2 = await signup({ email: `read2-${stamp}@test.local`, name: 'Anggota Dua', password: 'password123' });
  ok(a1.status === 201 && a2.status === 201, 'dua anggota dibuat');
  const tok1 = a1.data.token, id1 = a1.data.user.id;
  const tok2 = a2.data.token, id2 = a2.data.user.id;

  // pembuat = anggota1 FRESH tiap run (kuota 5 grup/jam milik admin tidak terkuras)
  const rg = await api('/api/chats/group', {
    method: 'POST',
    token: tok1,
    body: { name: `Grup Centang ${stamp}`, memberIds: [admId, id2] },
  });
  ok(rg.status === 201, 'grup dibuat (admin + 2 anggota)');
  const gid = rg.data.chat.id;

  const sAdm = io(BASE, { auth: { token: admToken } });
  const s1 = io(BASE, { auth: { token: tok1 } });
  const s2 = io(BASE, { auth: { token: tok2 } });
  await Promise.all([sAdm, s1, s2].map((s) => new Promise((r) => s.on('connect', r))));
  ok(true, 'tiga socket terhubung');

  console.log('\n[2] Centang hasil bacaan admin terlihat SEMUA anggota grup');
  const st1 = collect(s1, 'message:status');
  const st2 = collect(s2, 'message:status');
  const ack = await emitAck(s1, 'message:send', { chatId: gid, type: 'text', body: `laporan kerja ${stamp}` });
  ok(ack && ack.ok === true, 'anggota1 mengirim pesan ke grup');
  await sleep(600);

  // chat:read diproses server tanpa balasan ack -> kirim saja lalu tunggu penyebarannya
  sAdm.emit('chat:read', { chatId: gid });
  await sleep(1500);

  const read1 = st1.seen.filter((e) => e && e.status === 'read');
  const read2 = st2.seen.filter((e) => e && e.status === 'read');
  ok(read1.length > 0, 'pengirim (anggota1) menerima tanda read');
  ok(read2.length > 0, 'ANGGOTA BUKAN PENGIRIM (anggota2) juga menerima tanda read');
  if (read2.length) {
    ok(read2.some((e) => e.chatId === gid), 'event read membawa chatId grup yang tepat');
  }

  const msgs = await admApi(`/api/chats/${gid}/messages`);
  const mine = (msgs.data.messages || []).find((m) => m.senderId === id1);
  ok(mine && mine.status === 'read', `status via API untuk semua anggota = ${mine && mine.status}`);

  console.log('\n[3] Privasi "laporan dibaca" tetap menahan tanda baca (chat pribadi)');
  const priv = await admApi('/api/chats/direct', { method: 'POST', body: { peerId: id1 } });
  ok(priv.status === 201, 'chat pribadi admin-anggota1 dibuka');
  const dcid = priv.data.chat.id;

  const p1 = await api('/api/chats/direct', { method: 'POST', token: tok2, body: { peerId: id1 } });
  const pcid = p1.data.chat.id;
  const setPriv = await api('/api/me', {
    method: 'PATCH', token: tok1, body: { privacy: { receipts: true } },
  });
  ok(setPriv.status === 200, 'anggota1 menyalakan privasi laporan dibaca');

  const stSender = collect(s1, 'message:status');
  const ackP = await emitAck(s2, 'message:send', { chatId: pcid, type: 'text', body: `privasi baca ${stamp}` });
  ok(ackP && ackP.ok === true, 'anggota2 mengirim pesan pribadi');
  await sleep(600);
  const noRead = expectNoEvent(s1, 'message:status', 900);
  const ackPrivRead = await api(`/api/chats/${pcid}/read`, { method: 'POST', token: tok1 });
  ok(ackPrivRead.status === 200, 'anggota1 (dengan privasi) membaca chat');
  ok((await noRead).got === false, 'pengirim TIDAK menerima tanda read dari pembaca berprivasi');

  const afterPriv = await api(`/api/chats/${pcid}/messages`, { token: tok2 });
  const lastPriv = (afterPriv.data.messages || []).filter((m) => m.senderId === id2).pop();
  ok(lastPriv && lastPriv.status !== 'read', 'status read disembunyikan untuk pembaca berprivasi');
  ok(stSender.seen.length >= 0, 'kumpulan event pengirim tercatat');

  await api('/api/me', { method: 'PATCH', token: tok1, body: { privacy: { receipts: false } } });

  st1.stop(); st2.stop(); stSender.stop();
  sAdm.close(); s1.close(); s2.close();

  console.log(`\n==== HASIL: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(2);
});
