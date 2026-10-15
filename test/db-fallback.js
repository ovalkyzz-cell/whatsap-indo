'use strict';
/* Uji alur cadangan DB: dengan BLOB token palsu (useBlob=true), put() pasti
   gagal -> upload harus jatuh ke penyimpanan database dan mengembalikan URL
   /api/storage/dbfiles/<id>. Lalu URL itu diambil lagi & bytenya harus identik. */
process.env.BLOB_READ_WRITE_TOKEN = 'fake_token_for_test';
process.env.VERCEL_BLOB_RETRIES = '0';
process.env.PORT = '3999';
process.env.DATABASE_URL = '';

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:3999';
const EMAIL = `dbfb-${Date.now()}@mail.com`;
const PASS = 'secret123';

function j(method, p, body, token) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
}

(async () => {
  const srv = spawn('node', ['server/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  srv.stdout.on('data', (d) => { boot += d; });
  srv.stderr.on('data', (d) => { boot += d; });

  // tunggu boot
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  let pass = 0, fail = 0;
  const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label); } };

  // daftar user (butuh approve? daftar aktif jika admin). pakai ovalkyzz admin
  const email = 'ovalkyzz@gmail.com';
  let r = await j('POST', '/api/auth/login', { email, password: PASS });
  let token = r.data && r.data.token;
  if (!token) {
    // daftar dulu lalu pakai token registrasi (admin aktif langsung)
    r = await j('POST', '/api/auth/register', { email, password: PASS, name: 'Admin', username: 'admin' });
    token = r.data && r.data.token;
  }
  ok(!!token, 'dapat token admin (status ' + r.status + ')');
  if (!token) { console.log('TAK BISA LOGIN, boot log:\n' + boot.slice(-800)); srv.kill(); process.exit(1); }

  // unggah via multipart /api/upload -> put() blob gagal -> jatuh ke DB
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'uji.png');
  const up = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const ud = await up.json().catch(() => null);
  console.log('  upload status:', up.status, 'body:', JSON.stringify(ud).slice(0, 200));
  ok(up.status === 201, 'upload sukses 201 walau Blob gagal');
  ok(ud && /^\/api\/storage\/dbfiles\//.test(ud.url || ''), 'URL jatuh ke /api/storage/dbfiles/ (bukan Blob)');

  // ambil lagi file itu -> bytenya harus identik
  if (ud && ud.url) {
    const g = await fetch(BASE + ud.url);
    const gb = Buffer.from(await g.arrayBuffer());
    ok(g.status === 200, 'GET dbfiles 200');
    ok(g.headers.get('content-type') || '', 'content-type diatur: ' + g.headers.get('content-type'));
    ok(gb.length === png.length && gb.equals(png), 'byte identik dengan file asli');
  }

  console.log('\n=== hasil: ' + pass + ' passed, ' + fail + ' failed ===');
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
