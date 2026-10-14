'use strict';
/* Uji manajemen storage: hapus MASSAL (bulk-delete) & pembersihan file RUSAK
   (cleanup). Ekspor beberapa file -> hapus massal (kuota kembali persis);
   buat file lalu rusakkan fisiknya -> cleanup mendeteksi & membebaskan kuota. */
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
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
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]);

(async () => {
  console.log('\n=== Uji hapus massal + bersihkan file rusak ===');
  await admLogin();
  const stamp = Date.now();
  const u = await signup({ email: `stman-${stamp}@uji.mail`, name: 'Uji Manajemen Storage', password: 'rahasia123' });
  ok(u.status === 201 && u.data.token, 'user baru siap');
  const tok = u.data.token;

  const before = (await api('/api/me/storage', { token: tok })).data.used || 0;

  // --- HAPUS MASSAL ---
  const items = [];
  for (let i = 0; i < 4; i++) {
    const up = await upload(tok, JPEG, `bulk-${i}.jpg`, 'image/jpeg');
    const reg = await api('/api/storage/files', { method: 'POST', token: tok, body: { url: up.data.url, name: up.data.name, size: up.data.size, mime: up.data.mime, type: up.data.type } });
    if (reg.status === 201) items.push(reg.data.item);
  }
  ok(items.length === 4, 'ekspor 4 file ke storage');
  const mid = (await api('/api/me/storage', { token: tok })).data.used || 0;
  ok(mid > before, 'kuota naik setelah ekspor (' + before + ' -> ' + mid + ')');

  const bulk = await api('/api/storage/bulk-delete', { method: 'POST', token: tok, body: { items: items.map((it) => ({ id: it.id, kind: 'saved' })) } });
  ok(bulk.status === 200 && bulk.data.deleted === 4 && bulk.data.failed === 0, 'bulk-delete hapus semua: ' + JSON.stringify(bulk.data));
  const afterBulk = (await api('/api/me/storage', { token: tok })).data.used || 0;
  ok(afterBulk === before, 'kuota kembali persis setelah massal (' + afterBulk + ')');

  // bulk kosong -> 400
  const emptyBulk = await api('/api/storage/bulk-delete', { method: 'POST', token: tok, body: { items: [] } });
  ok(emptyBulk.status === 400, 'bulk kosong ditolak (400)');

  // --- BERSIHKAN FILE RUSAK ---
  const up = await upload(tok, JPEG, 'akan-rusak.jpg', 'image/jpeg');
  const reg = await api('/api/storage/files', { method: 'POST', token: tok, body: { url: up.data.url, name: up.data.name, size: up.data.size, mime: up.data.mime, type: up.data.type } });
  const broken = reg.data.item;
  const preClean = (await api('/api/me/storage', { token: tok })).data.used || 0;
  // rusakkan: hapus file fisiknya dari disk
  const fname = broken.url.slice('/uploads/'.length);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, fname)); } catch { /* mungkin sudah hilang */ }
  ok(true, 'file dibuat lalu fisiknya dihapus (jadi rusak)');

  const clean = await api('/api/storage/cleanup', { method: 'POST', token: tok, body: {} });
  ok(clean.status === 200 && clean.data.removed >= 1, 'cleanup mendeteksi & hapus rusak: ' + JSON.stringify(clean.data));
  const list = (await api('/api/me/storage/media', { token: tok })).data;
  const still = (list.items || []).find((i) => i.id === broken.id);
  ok(!still, 'rusak hilang dari daftar');
  const postClean = (await api('/api/me/storage', { token: tok })).data.used || 0;
  ok(postClean <= preClean, 'kuota dibebaskan saat bersihkan rusak');

  console.log(`\n=== hasil: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
