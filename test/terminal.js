'use strict';
/* Uji: terminal mini — akses (admin/permanen/bisnis), limit harian,
   pengaturan limit admin, rute perintah ke bot, dan perintah lokal. */
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
  console.log('\n=== Uji terminal mini ===');
  await admLogin();
  const stamp = Date.now();
  const perm = await signup({ email: `term-perm${stamp}@mail.com`, name: `Perm${stamp}`, password: 'rahasia123' });
  const biz = await signup({ email: `term-biz${stamp}@mail.com`, name: `Biz${stamp}`, password: 'rahasia123' });
  const free = await signup({ email: `term-free${stamp}@mail.com`, name: `Free${stamp}`, password: 'rahasia123' });
  const tokP = perm.data.token, tokB = biz.data.token, tokF = free.data.token;
  ok(!!tokP && !!tokB && !!tokF, 'tiga pengguna terdaftar & login');

  // beri paket permanen & bisnis
  const gp = await admApi('/api/admin/premium', { method: 'POST', body: { email: `term-perm${stamp}@mail.com`, plan: 'permanen' } });
  const gb = await admApi('/api/admin/premium', { method: 'POST', body: { email: `term-biz${stamp}@mail.com`, plan: 'bisnis' } });
  ok(gp.status === 200 && gb.status === 200, 'admin memberi paket permanen & bisnis');

  //1. pengguna biasa (tanpa paket) ditolak
  const accF = await api('/api/terminal/access', { token: tokF });
  ok(accF.status === 200 && accF.data.allowed === false, 'pengguna tanpa paket: allowed=false');
  const runF = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'nik 3175061509900001' }, token: tokF });
  ok(runF.status === 403, 'pengguna tanpa paket: run ditolak 403');

  //2. admin: tanpa limit
  const accA = await api('/api/terminal/access', { token: admToken });
  ok(accA.status === 200 && accA.data.allowed === true && accA.data.isAdmin === true, 'admin: allowed & isAdmin');
  const menuA = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'menu' }, token: admToken });
  ok(menuA.status === 200 && /TERMINAL/.test(menuA.data.output || ''), 'admin: menu menampilkan bantuan');
  const statA = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'status' }, token: admToken });
  ok(statA.status === 200 && /tanpa limit/i.test(statA.data.output || ''), 'admin: status "tanpa limit"');
  const clearA = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'clear' }, token: admToken });
  ok(clearA.status === 200 && clearA.data.clear === true, 'admin: clear memberi sinyal bersih');

  //3. permanen: allowed dengan limit default
  const accP = await api('/api/terminal/access', { token: tokP });
  ok(accP.status === 200 && accP.data.allowed === true && accP.data.plan === 'permanen', 'permanen: allowed & plan permanen');
  ok(typeof accP.data.limit === 'number' && accP.data.limit > 0, 'permanen: punya limit harian');

  //4. admin mengatur limit
  const setL = await admApi('/api/terminal/limits', { method: 'POST', body: { permanen: 0, bisnis: 5 } });
  ok(setL.status === 200 && setL.data.limits.permanen === 0 && setL.data.limits.bisnis === 5, 'admin mengatur limit permanen=0, bisnis=5');

  //5. permanen dengan limit0 ->429 saat perintah nyata
  const runP = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'nik 3175061509900001' }, token: tokP });
  ok(runP.status === 429, 'permanen limit0: perintah nyata ditolak 429');
  // menu tetap tersedia walau kuota0
  const menuP = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'menu' }, token: tokP });
  ok(menuP.status === 200, 'permanen: menu tetap tersedia walau kuota habis');

  //6. bisnis: limit mengikuti pengaturan admin (5)
  const accB = await api('/api/terminal/access', { token: tokB });
  ok(accB.status === 200 && accB.data.limit === 5, 'bisnis: limit mengikuti pengaturan admin (5)');

  //7. admin tetap jalan walau limit permanen0 (tanpa dicek) — rute ke bot
  const runAdmin = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'nik 3175061509900001' }, token: admToken });
  ok(runAdmin.status !== 429 && runAdmin.status !== 403 && runAdmin.status !== 400, `admin: perintah nik dirutekan (status ${runAdmin.status}, bukan 4xx)`);

  //8. perintah tak dikenal
  const unknown = await api('/api/terminal/run', { method: 'POST', body: { cmd: 'foobarbaz' }, token: admToken });
  ok(unknown.status === 200 && /tidak dikenal/i.test(unknown.data.output || ''), 'perintah tak dikenal diberi pesan');

  //9. non-admin tak bisa atur limit
  const limitByUser = await api('/api/terminal/limits', { method: 'POST', body: { permanen: 99 }, token: tokP });
  ok(limitByUser.status === 403, 'non-admin mengatur limit ditolak 403');

  // kembalikan limit default agar tak mengganggu data lain
  await admApi('/api/terminal/limits', { method: 'POST', body: { permanen: 30, bisnis: 60 } });

  console.log(`\n=== hasil: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
