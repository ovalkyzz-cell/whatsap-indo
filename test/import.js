'use strict';
/* Uji endpoint impor arsip chat lama (/api/admin/import/*):
   - wajib admin (401 tanpa token, 403 user biasa)
   - tolak tabel tak diizinkan / jumlah baris di luar batas
   - impor baris users -> chats -> messages idempoten (ON CONFLICT)
   - body pesan disimpan TERTUTUP di disk (RTC1:) namun terbaca kembali
     oleh vault server (sampel impor)
   - audit impor tercatat di admin_audit
   Semua baris uji dibersihkan setelah selesai. */
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗ FAIL:', l); } };

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
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
  if (!r.data || !r.data.token) throw new Error('login admin gagal');
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

const DB_PATH = path.join(__dirname, '..', 'data', 'whatsap.db');
const stamp = Date.now();
const uid = `imp-u-${stamp}`;
const cid = `imp-c-${stamp}`;
const mid = `imp-m-${stamp}`;
const cleanups = [];

(async () => {
  console.log('\n=== Uji endpoint impor arsip chat lama ===');
  await admLogin();

  // --- otorisasi ---
  const noTok = await api('/api/admin/import/ping');
  ok(noTok.status === 401, 'tanpa token -> 401');
  const u = await signup({ email: `impt-${stamp}@uji.mail`, name: 'Uji Impor', password: 'rahasia123' });
  ok(u.status === 201 && u.data.token, 'user biasa siap');
  const un = await api('/api/admin/import/ping', { token: u.data.token });
  ok(un.status === 403, 'user biasa -> 403');
  const unRows = await api('/api/admin/import/rows', { method: 'POST', token: u.data.token, body: { table: 'users', rows: [{}] } });
  ok(unRows.status === 403, 'user biasa kirim rows -> 403');

  // --- validasi ---
  const ping = await admApi('/api/admin/import/ping');
  ok(ping.status === 200 && ping.data.ok && typeof ping.data.keySource === 'string',
    'ping admin -> keySource=' + ping.data.keySource);
  const badTable = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'sqlite_master', rows: [{}] } });
  ok(badTable.status === 400, 'tabel di luar allowlist -> 400');
  const badRows = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'users', rows: [] } });
  ok(badRows.status === 400, 'rows kosong -> 400');
  const tooMany = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'users', rows: new Array(401).fill({ id: 'x' }) } });
  ok(tooMany.status === 400, '401 baris -> 400 (batas batch)');

  // --- impor berantai: users -> chats -> messages ---
  const now = Date.now();
  const userRow = {
    id: uid, email: `imp-archive-${stamp}@arsip.test`, name: 'Arsip Lama (uji)', password_hash: '$2b$10$invalidhashinvalidhashinvalidhashinvalidhash',
    about: 'akun uji impor', created_at: now, role: 'user', account_status: 'active',
  };
  const rUser = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'users', rows: [userRow] } });
  ok(rUser.status === 200 && rUser.data.inserted === 1, 'impor 1 user -> inserted=1');
  cleanups.push(['users', uid]);

  const rUser2 = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'users', rows: [userRow] } });
  ok(rUser2.status === 200 && rUser2.data.inserted === 0 && rUser2.data.skipped === 1,
    'impor ulang user -> inserted=0 skipped=1 (idempoten)');

  const chatRow = { id: cid, type: 'direct', name: 'Uji Impor Arsip', created_by: uid, created_at: now };
  const rChat = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'chats', rows: [chatRow] } });
  ok(rChat.status === 200 && rChat.data.inserted === 1, 'impor 1 chat -> inserted=1');
  cleanups.push(['chats', cid]);

  const bodyText = `Halo dari arsip lama ${stamp}`;
  const msgRow = {
    id: mid, chat_id: cid, sender_id: uid, type: 'text', body: bodyText, created_at: now, reply_preview: 'pesan dikutip lama',
  };
  const rMsg = await admApi('/api/admin/import/rows', { method: 'POST', body: { table: 'messages', rows: [msgRow] } });
  ok(rMsg.status === 200 && rMsg.data.inserted === 1, 'impor 1 pesan -> inserted=1');
  cleanups.push(['messages', mid]);

  ok(rMsg.data.sample && rMsg.data.sample.readable === true, 'sampel terbaca kembali oleh server: ' + JSON.stringify(rMsg.data.sample && rMsg.data.sample.preview));
  ok(rMsg.data.storedEncrypted === true, 'data dikunci terenkripsi di tujuan (storedEncrypted)');
  ok(Array.isArray(rMsg.data.failures) && rMsg.data.failures.length === 0, 'tanpa baris gagal');
  ok(rMsg.data.keySource !== undefined, 'respons menyebut kunci vault: ' + rMsg.data.keySource);

  // --- verifikasi at-rest langsung dari file basis data lokal ---
  const sqlite = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))(DB_PATH, { readonly: true });
  const row = sqlite.prepare('SELECT body, reply_preview FROM messages WHERE id = ?').get(mid);
  ok(!!row && typeof row.body === 'string' && row.body.startsWith('RTC1:'), 'body di disk tertutup (RTC1:)');
  ok(!!row && typeof row.reply_preview === 'string' && row.reply_preview.startsWith('RTC1:'), 'reply_preview tertutup di disk');
  sqlite.close();
  const vault = require(path.join(__dirname, '..', 'server', 'vault'));
  ok(vault.decrypt(row.body) === bodyText, 'vault lokal mendekripsi persis seperti aslinya');
  ok(vault.decrypt(row.reply_preview) === 'pesan dikutip lama', 'reply_preview terbaca utuh');

  // --- audit ---
  const auditDb = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))(DB_PATH, { readonly: true });
  const aud = auditDb.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'import'").get().n;
  auditDb.close();
  ok(aud >= 4, 'audit impor tercatat (' + aud + ' entri)');

  // --- bersihkan baris uji (jangan sentuh arsip asli) ---
  const w = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))(DB_PATH);
  for (const [t, id] of [...cleanups].reverse()) w.prepare(`DELETE FROM "${t}" WHERE id = ?`).run(id);
  const left = w.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'imp-%'").get().n;
  w.close();
  ok(left === 0, 'baris uji dibersihkan dari basis data sumber');

  console.log(`\n=== hasil: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
