'use strict';
/* Uji fitur "simpan dari galeri": daftarkan file ke storage langsung
   (tanpa jadi pesan) lewat POST /api/storage/files — kuota naik, muncul di
   daftar (kind=saved), hapus bebaskan kuota kembali, URL palsu ditolak. */
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
async function upload(token, buf, name, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const res = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  console.log('\n=== Uji simpan dari galeri ke storage ===');
  await admLogin();
  const stamp = Date.now();

  const u = await signup({ email: `stsave-${stamp}@uji.mail`, name: 'Uji Simpan Galeri', password: 'rahasia123' });
  ok(u.status === 201 && u.data.token, 'user baru siap');
  const tok = u.data.token;

  const before = (await api('/api/me/storage', { token: tok })).data;
  ok(typeof before.used === 'number', 'kuota awal terbaca');

  // unggah berkas kecil lalu daftarkan ke storage
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]);
  const up = await upload(tok, jpeg, 'dari-galeri.jpg', 'image/jpeg');
  ok(up.status === 201 && up.data.url, 'unggah file: ' + up.data.url);

  const reg = await api('/api/storage/files', { method: 'POST', token: tok, body: { url: up.data.url, name: up.data.name, size: up.data.size, mime: up.data.mime, type: up.data.type } });
  ok(reg.status === 201 && reg.data.item, 'daftar ke storage: ' + reg.status);
  ok(reg.data.item && reg.data.item.kind === 'saved', 'item bertandakan kind=saved');
  ok(reg.data.item && reg.data.item.size === jpeg.length, 'ukuran tercatat benar (' + jpeg.length + ' B)');

  const list = (await api('/api/me/storage/media', { token: tok })).data;
  const saved = (list.items || []).find((i) => i.kind === 'saved');
  ok(!!saved, 'muncul di daftar penyimpanan (kind=saved)');
  ok(list.usage.used === before.used + jpeg.length, 'kuota naik sesuai ukuran (' + list.usage.used + ')');
  ok((list.totals.image || 0) >= jpeg.length, 'total ikut terhitung');

  // URL palsu (bukan /uploads atau blob) harus ditolak
  const bad = await api('/api/storage/files', { method: 'POST', token: tok, body: { url: 'https://evil.contoh.com/x.jpg', name: 'x', size: 10, mime: 'image/jpeg', type: 'image' } });
  ok(bad.status === 400, 'URL palsu ditolak (400)');

  // hapus -> kuota dibebaskan kembali (tanpa drift)
  const del = await api(`/api/storage/files/${saved.id}`, { method: 'DELETE', token: tok });
  ok(del.status === 200 && del.data.ok, 'hapus file tersimpan');
  const after = (await api('/api/me/storage', { token: tok })).data;
  ok(after.used === before.used, 'kuota kembali persis (tanpa drift): ' + after.used);

  // hapus dua kali -> 404 (id sudah tidak ada)
  const del2 = await api(`/api/storage/files/${saved.id}`, { method: 'DELETE', token: tok });
  ok(del2.status === 404, 'hapus ulang -> 404');

  console.log(`\n=== hasil: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
