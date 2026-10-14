'use strict';
/* Smoke test fitur kuota storage nyata per paket.
   Alur: admin daftar -> user daftar & disetujui -> cek storage awal ->
   grant paket bulanan -> kirim media (reserve) -> cek used naik ->
   hapus pesan (release) -> cek used turun -> admin recompute. */
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
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

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
  if (!r.data || !r.data.token) throw new Error(`admin gagal: ${r.status}`);
  admToken = r.data.token;
  return admToken;
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
  if (ap.status !== 200) return { status: 500, data: { error: `approve gagal: ${JSON.stringify(ap.data)}` } };
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return { status: 201, data: { ...lg.data, pending: false } };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error('socket timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}
function waitEvent(sock, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${type}`)), timeout);
    sock.once(type, (d) => { clearTimeout(t); resolve(d); });
  });
}

(async () => {
  console.log('\n=== Smoke test kuota storage ===');
  await admLogin();
  console.log('admin siap');

  const stamp = Date.now();
  const a = await signup({ email: `stoA${stamp}@mail.com`, name: 'StorageA', password: 'rahasia123' });
  ok(a.status === 201 && a.data.token, 'user A terdaftar & disetujui');
  const tokA = a.data.token;
  const b = await signup({ email: `stoB${stamp}@mail.com`, name: 'StorageB', password: 'rahasia123' });
  const tokB = b.data.token;

  // storage awal (free = 2GB)
  let u = await api('/api/me/storage', { token: tokA });
  console.log('  [dbg] storage A:', u.status, JSON.stringify(u.data).slice(0, 200));
  ok(u.status === 200, 'GET /api/me/storage OK');
  ok(u.data.freeStorage === 2 * 1000 ** 3, 'freeStorage = 2GB');
  ok(u.data.quota === 2 * 1000 ** 3, 'quota free = 2GB');
  ok(u.data.used === 0 && u.data.unlimited === false, 'used awal 0, terbatas');

  // paket di /api/plans kini punya storageLimit
  const pl = await api('/api/plans', { token: tokA });
  ok(pl.status === 200 && pl.data.storage, '/api/plans mengandung ringkasan storage');
  ok(Array.isArray(pl.data.plans) && pl.data.plans.some((p) => p.id === 'bisnis'), 'ada paket bisnis');
  ok(pl.data.plans.some((p) => p.id === 'reseller-bulanan'), 'ada paket reseller-bulanan');
  const bulanan = pl.data.plans.find((p) => p.id === 'bulanan');
  ok(bulanan && bulanan.storageLimit === 2 * 1000 ** 4, 'bulanan storageLimit = 2TB');

  // grant paket bulanan ke A
  const gp = await admApi('/api/admin/premium', { method: 'POST', body: { email: `stoA${stamp}@mail.com`, plan: 'bulanan' } });
  ok(gp.status === 200, 'admin grant paket bulanan');
  u = await api('/api/me/storage', { token: tokA });
  ok(u.data.quota === 2 * 1000 ** 4 && u.data.planId === 'bulanan', 'quota A = 2TB setelah upgrade');

  // kirim media lewat socket (reserve nyata)
  const sockA = await connect(tokA);
  const sockB = await connect(tokB);
  // A mulai chat dengan B
  const st = await api('/api/chats/direct', { method: 'POST', body: { peerId: b.data.user.id }, token: tokA });
  ok(st.status === 201, 'chat direct A->B');
  const chatId = st.data.chat && st.data.chat.id;
  ok(!!chatId, 'dapat chatId');

  const mediaSize = 1000;
  const gotB = waitEvent(sockB, 'message:new').catch(() => null);
  const sent = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    sockA.emit('message:send', {
      chatId,
      type: 'file',
      body: '',
      media: { url: `/uploads/uji-${stamp}.txt`, name: 'uji.txt', size: mediaSize, mime: 'text/plain' },
    }, (ack) => { clearTimeout(t); resolve(ack); });
  });
  ok(sent && sent.ok === true, `kirim media diterima server (${sent && sent.error ? sent.error : 'ok'})`);
  u = await api('/api/me/storage', { token: tokA });
  ok(u.data.used === mediaSize, `used A = ${mediaSize} setelah kirim media (aktual ${u.data.used})`);

  let mid = sent && sent.message && sent.message.id;
  if (!mid) {
    const ev = await gotB;
    mid = ev && ev.id;
  }
  ok(!!mid, 'dapat id pesan media');

  // hapus pesan -> release
  if (mid) {
    const del = await api(`/api/messages/${mid}`, { method: 'DELETE', token: tokA });
    ok(del.status === 200, 'hapus pesan media');
    u = await api('/api/me/storage', { token: tokA });
    ok(u.data.used === 0, `used kembali 0 setelah hapus (aktual ${u.data.used})`);
  }

  // admin recompute
  const rc = await admApi('/api/admin/storage/recompute', { method: 'POST', body: {} });
  ok(rc.status === 200 && rc.data.ok, 'admin recompute OK');

  // admin unlimited
  u = await api('/api/me/storage', { token: admToken });
  ok(u.data.unlimited === true && u.data.quota === null, 'admin tanpa batas (quota null)');

  // --- enforcement batas: turunkan kuota paket bulanan jadi 500 byte ---
  const cfg = await admApi('/api/admin/settings');
  const tinyPlans = cfg.data.plans.map((p) => (p.id === 'bulanan' ? { ...p, storageLimit: 500 } : p));
  const sv = await admApi('/api/admin/settings', { method: 'PUT', body: { plans: tinyPlans } });
  ok(sv.status === 200 && sv.data.plans.find((p) => p.id === 'bulanan').storageLimit === 500, 'kuota bulanan disetel 500 byte');

  // A (masih premium bulanan) coba kirim media 1000 byte -> harus ditolak
  const reject = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    sockA.emit('message:send', {
      chatId,
      type: 'file',
      body: '',
      media: { url: `/uploads/uji-lewat-${stamp}.txt`, name: 'lewat.txt', size: 1000, mime: 'text/plain' },
    }, (ack) => { clearTimeout(t); resolve(ack); });
  });
  ok(reject && reject.ok === false && /Storage penuh/.test(reject.error || ''), `media > kuota ditolak (${reject && reject.error})`);
  u = await api('/api/me/storage', { token: tokA });
  ok(u.data.used === 0, 'used tetap 0 setelah penolakan (tanpa bocor reservasi)');

  // restore kuota normal (bulan 2TB) agar tidak mengganggu data lain
  const restore = cfg.data.plans;
  await admApi('/api/admin/settings', { method: 'PUT', body: { plans: restore } });
  ok(true, 'kuota paket dikembalikan');

  sockA.close(); sockB.close();
  console.log(`\n=== Selesai: ${pass} lulus, ${fail} gagal ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
