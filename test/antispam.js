'use strict';

/* Uji sistem anti-spam pendaftaran — memakai server sungguhan dengan
   TRUST_PROXY=1 supaya header X-Forwarded-For dipercaya, persis seperti
   aplikasi di belakang proxy produksi/Vercel. Yang diuji:

   A) 1 pendaftaran sukses per IP per 24 jam -> percobaan ke-2 dari IP yang
      sama memblokir IP OTOMATIS, notifikasi `admin:event ip_banned` sampai
      ke panel admin, dan pendaftaran berikutnya tetap ditolak.
   B) IP diblokir hanya menahan pendaftaran — masuk (login) tetap diizinkan.
   C) Satu email hanya boleh mendaftar sekali.
   D) Percobaan pendaftaran gagal beruntun -> IP diblokir.
   E) IP loopback (tanpa X-Forwarded-For) tidak dibatasi: server lokal &
      suite test tidak mengunci dirinya sendiri.
   F) Admin bisa melihat daftar IP diblokir, membuka blokirnya (kuota
      pendaftaran ikut direset) dan memblokir IP manual.
   G) Endpoint blokir IP hanya untuk admin. */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3460;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';

const IP_A = '203.0.113.10'; // melewati limit per IP -> diblokir otomatis
const IP_B = '198.51.100.21'; // dipakai untuk uji email ganda
const IP_C = '192.0.2.33'; // percobaan gagal beruntun -> diblokir
const IP_D = '203.0.113.77'; // blokir manual oleh admin
const IP_E = '198.51.100.201'; // pesan blokir disunting admin (isi {nama})

const stamp = Date.now();
const mail = (n) => `${n}${stamp}@test.local`;

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

function req(method, urlPath, { token, body, ip } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        ...(ip ? { 'x-forwarded-for': ip } : {}),
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
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json });
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

function waitForEvent(socket, ms, pred) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off('admin:event', on); reject(new Error(`admin:event tidak terima dalam ${ms}ms`)); }, ms);
    const on = (ev) => { if (pred(ev)) { clearTimeout(t); socket.off('admin:event', on); resolve(ev); } };
    socket.on('admin:event', on);
  });
}

async function testIpLimitAndBan() {
  console.log('\n[A] limit 1 IP / 24 jam -> blokir otomatis');
  const token = await adminToken();
  const socket = await connectAdmin(token);

  const first = await req('POST', '/api/auth/register', {
    ip: IP_A,
    body: { email: mail('a1'), name: 'Pengguna A', password: 'rahasia123' },
  });
  ok(first.status === 201 && first.json && first.json.pending, `pendaftaran pertama dari IP -> ${first.status} (diterima)`);

  const watch = waitForEvent(socket, 6000, (e) => e.type === 'ip_banned' && e.ip === IP_A);
  const second = await req('POST', '/api/auth/register', {
    ip: IP_A,
    body: { email: mail('a2'), name: 'Spammer A', password: 'rahasia123' },
  });
  ok(second.status === 403 && /diblokir/i.test(String(second.json && second.json.error)),
    `pendaftaran ke-2 dari IP sama -> ${second.status} (blokir otomatis)`);
  ok(second.json && second.json.code === 'ip_diblokir', 'kode galat ip_diblokir dikirim ke klien');

  try {
    const ev = await watch;
    ok(!!ev.detail && /pendaftaran sukses/i.test(ev.detail), 'admin:event `ip_banned` sampai ke panel admin');
  } catch (err) { ok(false, err.message); }

  const again = await req('POST', '/api/auth/register', {
    ip: IP_A,
    body: { email: mail('a3'), name: 'Spammer A2', password: 'rahasia123' },
  });
  ok(again.status === 403, `pendaftaran berikutnya dari IP yang sama -> ${again.status} (masih diblokir)`);

  const bans = await req('GET', '/api/admin/ip-bans', { token });
  const listed = bans.status === 200 && (bans.json.bans || []).some((b) => b.ip === IP_A);
  ok(listed, 'IP muncul di daftar /api/admin/ip-bans');

  const mon = await req('GET', '/api/admin/monitor', { token });
  ok(mon.status === 200 && (mon.json.ipBans || []).some((b) => b.ip === IP_A), 'monitor admin ikut membawa daftar IP diblokir');

  const seen = (mon.json.logs || []).some((l) => l.result === 'blocked');
  ok(seen, 'upaya pendaftaran yang diblokir tercatat di riwayat monitor admin');

  // login dari IP yang diblokir: sesi admin lama ikut diputar (satu akun satu
  // perangkat), jadi token diambil ulang setelah langkah ini
  const login = await req('POST', '/api/auth/login', {
    ip: IP_A,
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  ok(login.status === 200 && login.json && login.json.token,
    `login dengan akun lama dari IP yang diblokir -> ${login.status} (blokir hanya menahan pendaftaran)`);

  socket.close();
  return adminToken();
}

async function testEmailOnce(token) {
  console.log('\n[B] satu email satu kali pendaftaran');
  const r = await req('POST', '/api/auth/register', {
    ip: IP_B,
    body: { email: 'ovalkyzz@gmail.com', name: 'Palsu', password: 'rahasia123' },
  });
  ok(r.status === 409 && /sudah terdaftar/i.test(String(r.json && r.json.error)),
    `email admin dipakai lagi -> ${r.status} (email satu kali)`);

  const dup = await req('POST', '/api/auth/register', {
    ip: IP_B,
    body: { email: 'bukan-email', name: 'Salah', password: 'rahasia123' },
  });
  ok(dup.status === 400, `format email rusak -> ${dup.status}`);
}

async function testFailFlood() {
  console.log('\n[C] percobaan gagal beruntun -> IP diblokir');
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/api/auth/register', {
      ip: IP_C,
      body: { email: `gagal${i}`, name: 'Flood', password: 'rahasia123' },
    });
    if (r.status !== 400) { ok(false, `percobaan gagal ke-${i + 1} -> ${r.status} (diharapkan 400)`); return; }
  }
  ok(true, '10 percobaan pendaftaran gagal terkirim');

  const r = await req('POST', '/api/auth/register', {
    ip: IP_C,
    body: { email: mail('c1'), name: 'Flood Berakhir', password: 'rahasia123' },
  });
  ok(r.status === 403 && /diblokir/i.test(String(r.json && r.json.error)),
    `percobaan sah berikutnya -> ${r.status} (IP diblokir karena gagal beruntun)`);
}

async function testLoopbackExempt() {
  console.log('\n[D] IP loopback tidak dibatasi (server lokal / suite test)');
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/api/auth/register', {
      body: { email: mail(`lokal${i}`), name: `Lokal ${i}`, password: 'rahasia123' },
    });
    statuses.push(r.status);
  }
  ok(statuses.every((s) => s === 201), `3 pendaftaran dari IP lokal -> ${statuses.join(',')} (semua diterima)`);

  const bans = await req('GET', '/api/admin/ip-bans', { tokenCache });
  const localBanned = (bans.json && bans.json.bans || []).some((b) => /^127\.|^::ffff:127\./.test(b.ip));
  ok(!localBanned, 'IP loopback tidak pernah masuk daftar blokir');
}

async function testUnbanAndManual(token) {
  console.log('\n[E] buka blokir & blokir manual oleh admin');
  const un = await req('POST', '/api/admin/ip-bans/unban', { token, body: { ip: IP_A } });
  ok(un.status === 200 && un.json && un.json.ok, `buka blokir IP -> ${un.status}`);

  const again = await req('POST', '/api/auth/register', {
    ip: IP_A,
    body: { email: mail('a4'), name: 'Dibuka Lagi', password: 'rahasia123' },
  });
  ok(again.status === 201, `pendaftaran setelah blokir dibuka -> ${again.status} (kuota direset)`);

  const gone = await req('GET', '/api/admin/ip-bans', { token });
  ok(!(gone.json.bans || []).some((b) => b.ip === IP_A), 'IP tidak lagi ada di daftar blokir');

  const missing = await req('POST', '/api/admin/ip-bans/unban', { token, body: { ip: IP_A } });
  ok(missing.status === 404, `buka blokir IP yang tidak diblokir -> ${missing.status}`);

  const bad = await req('POST', '/api/admin/ip-bans/ban', { token, body: { ip: '' } });
  ok(bad.status === 400, `blokir IP kosong/tidak valid -> ${bad.status}`);

  const local = await req('POST', '/api/admin/ip-bans/ban', { token, body: { ip: '127.0.0.1' } });
  ok(local.status === 400, `blokir IP loopback -> ${local.status} (ditolak)`);

  const manual = await req('POST', '/api/admin/ip-bans/ban', {
    token,
    body: { ip: IP_D, reason: 'laporan pengguna' },
  });
  ok(manual.status === 200 && manual.json && manual.json.ban && manual.json.ban.reason === 'manual',
    `blokir manual oleh admin -> ${manual.status}`);

  const r = await req('POST', '/api/auth/register', {
    ip: IP_D,
    body: { email: mail('d1'), name: 'Terblokir', password: 'rahasia123' },
  });
  ok(r.status === 403, `pendaftaran dari IP diblokir manual -> ${r.status}`);

  const cleared = await req('POST', '/api/admin/ip-bans/unban', { token, body: { ip: IP_D } });
  ok(cleared.status === 200, `IP manual dibersihkan sebelum uji login -> ${cleared.status}`);

  const login = await req('POST', '/api/auth/login', {
    ip: IP_D,
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  ok(login.status === 200, `login dari IP yang pernah diblokir -> ${login.status} (masuk tidak pernah dibatasi)`);

  return adminToken(); // sesi admin diputar oleh login di atas -> token segar
}

async function testPermissions(token) {
  console.log('\n[F] endpoint blokir IP hanya untuk admin');
  const anon = await req('GET', '/api/admin/ip-bans');
  ok(anon.status === 401, `tanpa token -> ${anon.status}`);

  const reg = await req('POST', '/api/auth/register', {
    body: { email: mail('biasa'), name: 'Pengguna Biasa', password: 'rahasia123' },
  });
  if (reg.status !== 201 || !reg.json || !reg.json.user) {
    ok(false, `pendaftaran pengguna biasa -> ${reg.status}`);
    return;
  }
  const approved = await req('POST', `/api/admin/users/${reg.json.user.id}/approve`, { token });
  ok(approved.status === 200, `persetujuan admin -> ${approved.status}`);

  const login = await req('POST', '/api/auth/login', {
    body: { email: reg.json.user.email, password: 'rahasia123' },
  });
  const userToken = login.json && login.json.token;
  ok(!!userToken, `pengguna biasa masuk -> ${login.status}`);

  if (userToken) {
    const r = await req('GET', '/api/admin/ip-bans', { token: userToken });
    ok(r.status === 403, `pengguna biasa -> ${r.status} (ditolak)`);
    const un = await req('POST', '/api/admin/ip-bans/unban', { token: userToken, body: { ip: IP_C } });
    ok(un.status === 403, `buka blokir oleh non-admin -> ${un.status}`);
  }
}

async function testCustomBlockText(token) {
  console.log('\n[G] pesan blokir & sapaan daftar disunting admin (isi {nama})');
  const set = await req('PUT', '/api/admin/settings', {
    token,
    body: { regText: { greeting: `Selamat datang, {nama}! (${stamp})`, blocked: `Jangan spam terus ya {nama}, paham? (${stamp})` } },
  });
  ok(set.status === 200 && set.json && /{nama}/.test(String(set.json.regText && set.json.regText.greeting)),
    `admin mengatur sapaan + pesan blokir halaman daftar -> ${set.status}`);

  const pub = await req('GET', '/api/settings/public');
  ok(pub.status === 200 && pub.json && String(pub.json.regGreet || '').includes(String(stamp)),
    'sapaan admin tampil di endpoint publik tanpa login');

  const inv = await req('PUT', '/api/admin/settings', { token, body: { regText: 'campur-aduk' } });
  ok(inv.status === 400, `regText bukan objek -> ${inv.status} (ditolak)`);
  const anon = await req('PUT', '/api/admin/settings', { body: { regText: { greeting: 'x', blocked: '' } } });
  ok(anon.status === 401, `pengaturan teks tanpa token -> ${anon.status}`);

  // IP baru: pendaftaran pertama sukses, percobaan ke-2 diblokir ->
  // pesan wajib memakai TULISAN admin dan menyebut nama pendaftar
  const first = await req('POST', '/api/auth/register', {
    ip: IP_E,
    body: { email: mail('e1'), name: 'Daffa', password: 'rahasia123' },
  });
  ok(first.status === 201, `pendaftaran pertama dari IP_E -> ${first.status}`);

  const blocked = await req('POST', '/api/auth/register', {
    ip: IP_E,
    body: { email: mail('e2'), name: 'Daffa', password: 'rahasia123' },
  });
  const msg = String((blocked.json && blocked.json.error) || '');
  ok(blocked.status === 403 && msg.includes(String(stamp)) && msg.includes('Daffa'),
    `pesan blokir memakai teks admin + nama pendaftar (${msg.slice(0, 70)}…)`);

  // kembalikan ke pesan bawaan
  const reset = await req('PUT', '/api/admin/settings', {
    token,
    body: { regText: { greeting: 'Selamat datang, {nama}! Lengkapi data di bawah untuk bergabung dengan RTC-Core.', blocked: '' } },
  });
  ok(reset.status === 200 && reset.json && reset.json.regText && reset.json.regText.blocked === '',
    'teks daftar dikembalikan bawaan');
}

let tokenCache = '';

async function cleanup() {
  // bersihkan jejak uji dari database bersama (ip_bans + ledger percobaan)
  try {
    const db = require(path.join(__dirname, '..', 'server', 'db'));
    await db.ready;
    for (const ip of [IP_A, IP_B, IP_C, IP_D, IP_E]) {
      await db.run('DELETE FROM ip_bans WHERE ip = ?', ip);
      await db.run('DELETE FROM reg_logs WHERE ip = ?', ip);
    }
    await db.run('DELETE FROM reg_logs WHERE email LIKE ?', `%${stamp}@test.local`);
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
      TRUST_PROXY: '1', // X-Forwarded-For dipercaya, seperti di belakang proxy
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer();
    tokenCache = await adminToken();
    tokenCache = await testIpLimitAndBan();
    await testEmailOnce(tokenCache);
    await testFailFlood();
    await testLoopbackExempt();
    tokenCache = await testUnbanAndManual(tokenCache);
    await testPermissions(tokenCache);
    await testCustomBlockText(tokenCache);
  } finally {
    await cleanup();
    server.kill('SIGTERM');
    await new Promise((s) => setTimeout(s, 250));
    try { server.kill('SIGKILL'); } catch { /* sudah mati */ }
    if (fail) console.log('\nlog server:\n' + serverLog.split('\n').slice(-30).join('\n'));
  }

  console.log(`\nAnti-spam pendaftaran: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
