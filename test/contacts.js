'use strict';
/* Uji: endpoint daftar kontak /api/contacts (direktori, pencarian, halaman, privasi). */
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗ FAIL:', l); } };

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

(async () => {
  console.log('\n=== Uji daftar kontak /api/contacts ===');
  await admLogin();
  const stamp = Date.now();
  const NA = `KontakAlice${stamp}`;
  const NB = `KontakBob${stamp}`;
  const NC = `KontakCitra${stamp}`;
  const a = await signup({ email: `kontak-a${stamp}@mail.com`, name: NA, password: 'rahasia123' });
  const b = await signup({ email: `kontak-b${stamp}@mail.com`, name: NB, password: 'rahasia123' });
  const c = await signup({ email: `kontak-c${stamp}@mail.com`, name: NC, password: 'rahasia123' });
  ok(!!a.data.token && !!b.data.token && !!c.data.token, 'tiga pengguna terdaftar & login');
  const tokA = a.data.token, idA = a.data.user.id;

  // 1. daftar dasar
  const r1 = await api('/api/contacts?limit=100', { token: tokA });
  ok(r1.status === 200 && Array.isArray(r1.data.users), 'GET /api/contacts ->200 & array users');
  ok(!r1.data.users.some((u) => u.id === idA), 'daftar tidak memuat diri sendiri');

  // 2. cari Bob via q (nama unik per-run)
  const rb = await api(`/api/contacts?q=${encodeURIComponent(NB)}`, { token: tokA });
  const bob = rb.data.users.find((u) => u.name === NB);
  ok(!!bob, 'pencarian menemukan KontakBob');
  ok(!!bob && typeof bob.email === 'string' && bob.email.includes('kontak-b'), 'email kontak tampil (belum dipribatkan)');
  ok(!!bob && 'verified' in bob && 'online' in bob, 'field verified & online tersedia');

  // 3. pencarian (q) menyaring
  const r2 = await api(`/api/contacts?q=${encodeURIComponent(NC)}`, { token: tokA });
  ok(r2.status === 200 && r2.data.users.length >= 1 && r2.data.users.every((u) => u.name.includes(NC)), 'pencarian q hanya mengembalikan Citra');
  const r2b = await api(`/api/contacts?q=${encodeURIComponent(stamp + '@mail')}`, { token: tokA });
  ok(r2b.status === 200 && r2b.data.users.some((u) => u.name === NB || u.name === NC), 'pencarian lewat email menemukan kontak (Bob/Citra, bukan diri sendiri)');

  // 4. halaman / paginasi
  const r3 = await api('/api/contacts?limit=1&offset=0', { token: tokA });
  ok(r3.status === 200 && r3.data.users.length <= 1, 'limit=1 mengembalikan <=1 hasil');
  ok(typeof r3.data.hasMore === 'boolean', 'hasMore berupa boolean');

  // 5. privasi email: b memprivatkan email -> email jadi null di mata a
  await api('/api/me', { method: 'PATCH', body: { privacy: { email: true } }, token: b.data.token });
  const r4 = await api(`/api/contacts?q=${encodeURIComponent(NB)}`, { token: tokA });
  const bob2 = r4.data.users.find((u) => u.name === NB);
  ok(!!bob2 && bob2.email === null, 'email privat disembunyikan (null) di daftar kontak');

  // 6. tanpa token -> 401
  const r5 = await api('/api/contacts');
  ok(r5.status === 401, 'tanpa token ditolak 401');

  console.log(`\n=== hasil: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
