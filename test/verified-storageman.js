'use strict';
/* Uji: (1) centang biru hanya utk bulanan/bisnis/reseller/permanen (bukan harian/mingguan)
   (2) endpoint /api/me/storage/media mengembalikan daftar media + total. */
const { io } = require('socket.io-client');
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
function connect(token) { return new Promise((res, rej) => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); const t = setTimeout(() => rej(new Error('timeout')), 8000); s.on('connect', () => { clearTimeout(t); res(s); }); s.on('connect_error', (e) => { clearTimeout(t); rej(e); }); }); }

(async () => {
  console.log('\n=== Uji centang biru per paket + media storage ===');
  await admLogin();
  const stamp = Date.now();

  // --- 1. verified restriction ---
  const plans = ['harian', 'mingguan', 'bulanan', 'bisnis', 'reseller-bulanan', 'permanen'];
  for (const plan of plans) {
    const email = `${plan}${stamp}@mail.com`;
    await signup({ email, name: `U-${plan}`, password: 'rahasia123' });
    await admApi('/api/admin/premium', { method: 'POST', body: { email, plan } });
    // login ulang agar token dijamin valid & pantau verified terbaru
    const lg = await api('/api/auth/login', { method: 'POST', body: { email, password: 'rahasia123' } });
    const prof = await api('/api/auth/me', { token: lg.data.token });
    const verified = prof.data.user ? prof.data.user.verified : prof.data.verified;
    const expectVerified = ['bulanan', 'bisnis', 'reseller-bulanan', 'permanen'].includes(plan);
    ok(verified === expectVerified, `${plan}: verified=${verified} (harus ${expectVerified})`);
  }

  // --- 2. media storage endpoint ---
  const a = await signup({ email: `stman${stamp}@mail.com`, name: 'StorageMan', password: 'rahasia123' });
  const b = await signup({ email: `stmanb${stamp}@mail.com`, name: 'PeerB', password: 'rahasia123' });
  const sockA = await connect(a.data.token);
  const st = await api('/api/chats/direct', { method: 'POST', body: { peerId: b.data.user.id }, token: a.data.token });
  const chatId = st.data.chat.id;

  // kirim 2 media (foto + file)
  const send = (media) => new Promise((res) => { const t = setTimeout(() => res(null), 8000); sockA.emit('message:send', { chatId, type: media.type, body: '', media }, (ack) => { clearTimeout(t); res(ack); }); });
  await send({ url: `/uploads/stman-${stamp}.jpg`, name: 'foto.jpg', size: 2000, mime: 'image/jpeg', type: 'image' });
  await send({ url: `/uploads/stman-${stamp}.txt`, name: 'dokumen.txt', size: 500, mime: 'text/plain', type: 'file' });

  const media = await api('/api/me/storage/media', { token: a.data.token });
  ok(media.status === 200, 'GET /api/me/storage/media OK');
  ok(media.data.items && media.data.items.length === 2, `2 media terdaftar (aktual ${media.data.items && media.data.items.length})`);
  ok(media.data.totals && media.data.totals.image === 2000 && media.data.totals.file === 500, `total image=2000 file=500 (aktual ${JSON.stringify(media.data.totals)})`);
  ok(media.data.totals.all === 2500, `total semua=2500 (aktual ${media.data.totals && media.data.totals.all})`);
  ok(media.data.usage && media.data.usage.used === 2500, `usage.used=2500 (aktual ${media.data.usage && media.data.usage.used})`);
  const imgItem = media.data.items.find((i) => i.type === 'image');
  ok(imgItem && imgItem.name === 'foto.jpg' && imgItem.size === 2000, 'item foto lengkap (name+size)');

  sockA.close();
  console.log(`\n=== Selesai: ${pass} lulus, ${fail} gagal ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
