'use strict';

/* Uji Konsol Server (khusus admin) — server sungguhan di port terpisah.

   Yang diuji:
   A) Gerbang ketat: /api/server/* anon -> 401, pengguna non-admin -> 403.
   B) overview: angka proses/database/storage lengkap + info vault.
   C) storage: total per sumber, konsumen terbesar, unggahan terakhir.
   D) audit: aksi admin (setujui akun, beri premium, ubah pengaturan,
      ekspor) tercatat di jejak audit dan disiarkan real-time
      (admin:event type 'audit') ke admin yang tersambung.
   E) socket: ticker server:stats sampai ke layar konsol.
   F) ekspor: arsip .rtcenc terenkripsi AES-256-GCM (RTC1:), verifikasi
      round-trip, tanpa email plaintext, dicatat di audit.
   G) statis: /server.html, pintu masuk di panel admin, header noindex. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3461;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';

const stamp = Date.now();
const mail = (n) => `${n}${stamp}@test.local`;
const USER_EMAIL = mail('konsole');
const USER_NAME = 'Konsumen Uji';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

function req(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
          : {}),
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* belum siap */ }
    await new Promise((s) => setTimeout(s, 300));
  }
  throw new Error('server tidak siap');
}

async function adminToken() {
  const login = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
  let r = await req('POST', '/api/auth/login', { body: login });
  if (r.status === 200 && r.json && r.json.token) return r.json.token;
  r = await req('POST', '/api/auth/register', { body: { ...login, name: 'Admin Test' } });
  if (r.status === 201 && r.json && r.json.token) return r.json.token;
  if (r.status === 409) {
    const again = await req('POST', '/api/auth/login', { body: login });
    if (again.status === 200 && again.json && again.json.token) return again.json.token;
  }
  throw new Error(`login admin gagal: ${r.status}`);
}

function connectAdmin(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    const t = setTimeout(() => { socket.close(); reject(new Error('koneksi socket admin gagal')); }, 8000);
    socket.once('connect', () => { clearTimeout(t); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(t); reject(err); });
  });
}

function waitForEvent(socket, ms, name, pred) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(name, on);
      reject(new Error(`${name} tidak terima dalam ${ms}ms`));
    }, ms);
    const on = (ev) => {
      if (pred(ev)) { clearTimeout(t); socket.off(name, on); resolve(ev); }
    };
    socket.on(name, on);
  });
}

function hasEntry(entries, action, targetSub) {
  return (entries || []).some(
    (e) => e.action === action && (!targetSub || String(e.target || '').includes(targetSub))
  );
}

let savedRegText = null;
let userId = null;

async function testGates(adminTok) {
  console.log('\n[A] Gerbang ketat (anon 401 / non-admin 403)');
  for (const p of ['/api/server/overview', '/api/server/storage', '/api/server/audit']) {
    const r = await req('GET', p);
    ok(r.status === 401, `${p} anon -> 401`);
  }
  const exAnon = await req('POST', '/api/server/export', { body: {} });
  ok(exAnon.status === 401, '/api/server/export anon -> 401');

  const reg = await req('POST', '/api/auth/register', {
    body: { email: USER_EMAIL, password: 'SandiUji123', name: USER_NAME },
  });
  ok(reg.status === 201 && reg.json && reg.json.pending, 'pendaftaran pengguna uji dibuat (menunggu)');
  userId = reg.json.user.id;
  const apv = await req('POST', `/api/admin/users/${userId}/approve`, { token: adminTok, body: {} });
  ok(apv.status === 200, 'admin menyetujui pengguna uji');
  const lg = await req('POST', '/api/auth/login', { body: { email: USER_EMAIL, password: 'SandiUji123' } });
  const userTok = lg.json && lg.json.token;
  ok(!!userTok, 'pengguna uji masuk dan mendapat token');

  for (const p of ['/api/server/overview', '/api/server/storage', '/api/server/audit']) {
    const r = await req('GET', p, { token: userTok });
    ok(r.status === 403, `${p} non-admin -> 403`);
  }
  const exUser = await req('POST', '/api/server/export', { token: userTok, body: {} });
  ok(exUser.status === 403, '/api/server/export non-admin -> 403');
  const ovMsg = await req('GET', '/api/server/overview', { token: userTok });
  ok(
    ovMsg.json && /admin/i.test(String(ovMsg.json.error || '')),
    'pesan 403 menegaskan akses admin'
  );
  return { userTok };
}

async function testOverview(adminTok) {
  console.log('\n[B] Overview proses & database');
  const r = await req('GET', '/api/server/overview', { token: adminTok });
  ok(r.status === 200, 'admin mendapat 200');
  const d = r.json || {};
  ok(d.users && d.users.total >= 1, 'jumlah pengguna terhitung');
  ok(d.memory && d.memory.rss > 0, 'memori RSS terbaca');
  ok(d.uptimeMs > 0, 'uptime server terhitung');
  ok(typeof d.dialect === 'string' && ['sqlite', 'pg'].includes(d.dialect), 'dialek database diketahui');
  ok(d.vault && d.vault.algo === 'aes-256-gcm', 'algo enkripsi at-rest (AES-256-GCM)');
  ok(!!(d.vault && d.vault.keySource), 'sumber kunci enkripsi dilaporkan');
  ok(d.requests && d.requests.total > 0, 'penghitung permintaan HTTP aktif');
  ok(typeof d.dbBytes === 'number' && d.dbBytes >= 0, 'ukuran basis data diketahui');
}

async function testStorage(adminTok) {
  console.log('\n[C] Laporan storage');
  const r = await req('GET', '/api/server/storage', { token: adminTok });
  ok(r.status === 200, 'admin mendapat 200');
  const t = (r.json && r.json.totals) || {};
  for (const k of ['accounted', 'chatMediaBytes', 'drawerBytes', 'dbFileBytes']) {
    ok(typeof t[k] === 'number', `total.${k} berupa angka`);
  }
  ok(Array.isArray(r.json.topUsers), 'daftar konsumen terbesar tersedia');
  ok(Array.isArray(r.json.byType), 'rincian media per tipe tersedia');
  ok(Array.isArray(r.json.recentUploads), 'daftar unggahan terakhir tersedia');
}

async function testAuditTrailAndRealtime(adminTok) {
  console.log('\n[D] Jejak audit + siaran real-time');
  const before = await req('GET', '/api/server/audit', { token: adminTok });
  ok(before.status === 200 && Array.isArray(before.json.entries), 'daftar audit terbaca');

  const settings = await req('GET', '/api/admin/settings', { token: adminTok });
  savedRegText = settings.json && settings.json.regText;
  const plans = (settings.json && settings.json.plans) || [];
  ok(plans.length >= 1, 'daftar paket tersedia untuk uji premium');

  const socket = await connectAdmin(adminTok);
  ok(true, 'socket admin tersambung');

  // beri premium ke pengguna uji -> audit + siaran 'audit'
  const auditWait = waitForEvent(socket, 9000, 'admin:event', (ev) =>
    ev.type === 'audit' && ev.entry && ev.entry.action === 'premium_grant'
  );
  const gp = await req('POST', '/api/admin/premium', {
    token: adminTok,
    body: { email: USER_EMAIL, plan: plans[0].id },
  });
  ok(gp.status === 200, 'premium diberikan oleh admin');
  let gotAudit = null;
  try { gotAudit = await auditWait; } catch (e) { ok(false, e.message); }
  ok(gotAudit && gotAudit.entry.adminName, 'peristiwa audit terkirim real-time via socket');

  const list = await req('GET', '/api/server/audit?limit=100', { token: adminTok });
  const entries = (list.json && list.json.entries) || [];
  ok(hasEntry(entries, 'user_approve', USER_EMAIL), 'persetujuan akun tercatat di audit');
  ok(hasEntry(entries, 'premium_grant', USER_EMAIL), 'pemberian premium tercatat di audit');

  const put = await req('PUT', '/api/admin/settings', {
    token: adminTok,
    body: { regText: { greeting: 'Halo {nama}, uji konsol server.', blocked: '' } },
  });
  ok(put.status === 200, 'teks halaman daftar diubah');
  const list2 = await req('GET', '/api/server/audit?limit=100', { token: adminTok });
  ok(
    hasEntry((list2.json && list2.json.entries) || [], 'settings_update', 'teks-daftar'),
    'perubahan pengaturan tercatat di audit'
  );

  // ticker statistik konsol
  try {
    const stats = await waitForEvent(socket, 9000, 'server:stats', (d) => d && d.users && d.users.total >= 1);
    ok(stats.memory && stats.memory.rss > 0, 'server:stats memuat ringkasan proses live');
  } catch (e) {
    ok(false, e.message);
  }
  socket.close();
}

async function testExport(adminTok) {
  console.log('\n[E] Ekspor arsip terenkripsi');
  const r = await req('POST', '/api/server/export', { token: adminTok, body: {} });
  ok(r.status === 200, 'admin mendapat 200');
  const p = r.json || {};
  ok(p.verified === true, 'verifikasi round-trip enkripsi lulus');
  ok(typeof p.data === 'string' && p.data.startsWith('RTC1:'), 'arsip memakai pola RTC1: (AES-256-GCM)');
  ok(/\.rtcenc$/.test(String(p.filename || '')), 'nama berkas .rtcenc');
  ok(p.bytes > 0 && p.cipherBytes > 0, 'ukuran mentah & terenkripsi tercatat');
  ok(!String(p.data).includes(ADMIN_EMAIL), 'arsip tanpa email admin plaintext');
  ok(!String(p.data).includes(USER_EMAIL), 'arsip tanpa email pengguna plaintext');

  const list = await req('GET', '/api/server/audit?limit=100', { token: adminTok });
  ok(hasEntry((list.json && list.json.entries) || [], 'export'), 'ekspor tercatat di audit');
}

async function testStatics() {
  console.log('\n[F] Statis & header keamanan');
  const health = await req('GET', '/api/health');
  ok(
    health.headers && String(health.headers['x-robots-tag'] || '').includes('noindex'),
    'header X-Robots-Tag: noindex terpasang'
  );
  const page = await req('GET', '/server.html');
  ok(page.status === 200, '/server.html disajikan 200');
  const html = page.text || '';
  for (const marker of ['scGate', 'scStats', 'scFeed', 'scExport', 'scSecurity', 'server:stats', 'socket.io']) {
    ok(html.includes(marker), `server.html memuat penanda "${marker}"`);
  }
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(idx.includes('adm-oss-link') && idx.includes('/server.html'), 'pintu masuk konsol ada di panel admin');
}

async function cleanup(adminTok) {
  try {
    const db = require(path.join(__dirname, '..', 'server', 'db'));
    await db.ready;
    if (savedRegText !== null) {
      const settings = require(path.join(__dirname, '..', 'server', 'settings'));
      await settings.setRegText(savedRegText);
    }
    await db.run('DELETE FROM admin_audit WHERE target LIKE ?', `%@test.local`);
    if (userId) await db.run('DELETE FROM users WHERE id = ?', userId);
    await db.run('DELETE FROM reg_logs WHERE email LIKE ?', `%@test.local`);
    await db.run('DELETE FROM login_logs WHERE email LIKE ?', `%@test.local`);
  } catch (err) {
    console.log('  (pembersihan database dilewati:', err.message + ')');
  }
}

async function main() {
  const server = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: '',
      BLOB_READ_WRITE_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let adminTok = null;
  try {
    await waitForServer();
    adminTok = await adminToken();
    await testGates(adminTok);
    await testOverview(adminTok);
    await testStorage(adminTok);
    await testAuditTrailAndRealtime(adminTok);
    await testExport(adminTok);
    await testStatics();
  } finally {
    await cleanup(adminTok);
    server.kill('SIGTERM');
    await new Promise((s) => setTimeout(s, 250));
    try { server.kill('SIGKILL'); } catch { /* sudah mati */ }
    if (fail) console.log('\nlog server:\n' + serverLog.split('\n').slice(-30).join('\n'));
  }

  console.log(`\nKonsol Server: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
