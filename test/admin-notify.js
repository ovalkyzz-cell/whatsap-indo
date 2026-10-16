'use strict';

/* Uji notifikasi admin saat ada pendaftar baru — dua bagian:

   A) integrasi Socket.IO sungguhan: server menerima pendaftaran lalu
      mengirim `admin:event` ke sesi admin (tipe `registered`, `online`,
      dan `approved` setelah disetujui).

   B) handler klien `onAdminEvent` yang sebenarnya diekstrak dari
      public/js/app.js dan dijalankan dengan stub, memastikan pendaftar baru
      benar-benar: masuk Pusat Notifikasi, membunyikan bunyi khusus admin,
      dan memunculkan kartu notifikasi (bila panel tertutup). */

const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3459;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

/* ---------- A. pendaftaran -> admin:event sungguhan ---------- */

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
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, buf, json });
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

async function testAdminEvents() {
  console.log('\n[A] pendaftaran -> admin:event (Socket.IO sungguhan)');

  const server = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer();

    let r = await req('POST', '/api/auth/register', { body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD } });
    if (r.status !== 201) r = await req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const adminToken = r.json && r.json.token;
    if (!adminToken) throw new Error(`login admin gagal: ${r.status}`);

    const socket = await connectAdmin(adminToken);
    ok(socket.connected, 'sesi admin terhubung ke Socket.IO');

    // peristiwa daring langsung dikirim saat admin tersambung
    try {
      const online = await waitForEvent(socket, 5000, (e) => e.type === 'online');
      ok(online.userId && typeof online.at === 'number', 'admin:event `online` diterima (rute event berfungsi)');
    } catch (err) { ok(false, err.message); }

    // pendaftar baru -> notifikasi pendaftaran
    const email = `notif${crypto.randomBytes(5).toString('hex')}@test.local`;
    const pending = waitForEvent(socket, 6000, (e) => e.type === 'registered' && e.user && e.user.email === email);
    const reg = await req('POST', '/api/auth/register', {
      body: { email, name: 'Pengguna Uji Notif', password: 'rahasia123' },
    });
    ok(reg.status === 201 && reg.json && reg.json.pending === true, `pendaftaran baru -> ${reg.status} (pending)`);

    let ev = null;
    try { ev = await pending; } catch (err) { ok(false, err.message); }
    if (ev) {
      ok(ev.user.name === 'Pengguna Uji Notif', 'payload memuat nama pendaftar');
      ok(ev.user.status === 'pending', 'payload memuat status pending');
      ok(typeof ev.at === 'number', 'payload memuat stempel waktu');
    }

    // setujui -> peristiwa kedua juga sampai
    if (ev && ev.user && ev.user.id) {
      const approved = waitForEvent(socket, 6000, (e) => e.type === 'approved' && e.user && e.user.id === ev.user.id);
      const ap = await req('POST', `/api/admin/users/${ev.user.id}/approve`, { token: adminToken });
      ok(ap.status === 200, `persetujuan admin -> ${ap.status}`);
      try {
        const a = await approved;
        ok(a.user.status === 'active', 'admin:event `approved` diterima dengan status aktif');
      } catch (err) { ok(false, err.message); }
    }

    socket.close();
  } finally {
    server.kill('SIGTERM');
    await new Promise((s) => setTimeout(s, 250));
    try { server.kill('SIGKILL'); } catch { /* sudah mati */ }
    if (fail) console.log('\nlog server:\n' + serverLog.split('\n').filter((l) => /admin event|register/i.test(l)).join('\n'));
  }
}

/* ---------- B. handler klien onAdminEvent (kode asli dari app.js) ---------- */

function loadAdminHandler({ drawerOpen = false, sound = true, visible = true, focused = true } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const a = src.indexOf('const ADMIN_EVENT_LABEL');
  const b = src.indexOf('async function openAdminPanel');
  const c = src.indexOf('const ADMIN_ALERT_EVENTS');
  const d = src.indexOf('function renderAdmStats');
  if ([a, b, c, d].some((n) => n < 0) || b <= a || d <= c) {
    throw new Error('blok onAdminEvent tidak ditemukan di public/js/app.js');
  }

  const spy = { nc: [], card: [], system: [], alerts: 0, admMsg: 0, refresh: 0 };
  const sandbox = {
    NOTIF: { sound },
    adm: { timer: null },
    document: { visibilityState: visible ? 'visible' : 'hidden', hasFocus: () => focused },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
    clearTimeout,
    $: () => ({ classList: { contains: (c2) => (c2 === 'hidden' ? !drawerOpen : false) } }),
    adminAlert: () => { spy.alerts += 1; },
    ncAdd: (item) => { spy.nc.push(item); },
    showNotifCard: (p) => { spy.card.push(p); },
    showSystemNotif: async (p) => { spy.system.push(p); },
    admMsg: () => { spy.admMsg += 1; },
    refreshAdminMonitor: () => { spy.refresh += 1; },
  };
  vm.runInNewContext(
    src.slice(a, b) + '\n' + src.slice(c, d) + '\n'
    + 'globalThis.__labels = ADMIN_EVENT_LABEL; globalThis.__alerts = [...ADMIN_ALERT_EVENTS];',
    sandbox,
    { filename: 'app-admin-block.js' }
  );
  return { onAdminEvent: sandbox.onAdminEvent, spy, labels: sandbox.__labels, alerts: sandbox.__alerts };
}

async function testClientHandler() {
  console.log('\n[B] handler onAdminEvent (kode asli dari public/js/app.js)');

  // B1. panel tertutup + pendaftar baru -> notif center + bunyi khusus + kartu
  {
    const { onAdminEvent, spy, labels } = loadAdminHandler();
    onAdminEvent({ type: 'registered', at: Date.now(), user: { id: 'u1', name: 'Budi', email: 'b@t.local', status: 'pending' } });
    ok(spy.nc.length === 1, 'pendaftar masuk Pusat Notifikasi');
    ok(spy.nc[0] && spy.nc[0].kind === 'admin', 'notifikasi bertanda kind admin');
    ok(spy.nc[0] && spy.nc[0].title === 'Pendaftar baru', `judul kartu: "${spy.nc[0] && spy.nc[0].title}"`);
    ok(spy.nc[0] && spy.nc[0].body === 'Budi mendaftar — menunggu persetujuan', `isi: "${spy.nc[0] && spy.nc[0].body}"`);
    ok(spy.alerts === 1, 'bunyi khusus admin dibunyikan');
    ok(spy.card.length === 1 && spy.card[0].silent === true, 'kartu notifikasi muncul (bunyi tidak dobel)');
    ok(!!labels.registered, 'label terjemahan event pendaftaran tersedia');
  }

  // B2. bunyi dimatikan -> riwayat tetap tercatat, tapi senyap
  {
    const { onAdminEvent, spy } = loadAdminHandler({ sound: false });
    onAdminEvent({ type: 'registered', at: Date.now(), user: { id: 'u2', name: 'Sari', email: 's@t.local' } });
    ok(spy.nc.length === 1, 'dengan bunyi mati: riwayat notifikasi tetap tercatat');
    ok(spy.alerts === 0, 'dengan bunyi mati: bunyi khusus tidak dibunyikan');
    ok(spy.card.length === 1, 'dengan bunyi mati: kartu tetap tampil');
  }

  // B3. panel admin terbuka -> pesan panel + refresh, tanpa kartu menumpuk
  {
    const { onAdminEvent, spy } = loadAdminHandler({ drawerOpen: true });
    onAdminEvent({ type: 'registered', at: Date.now(), user: { id: 'u3', name: 'Andi', email: 'a@t.local' } });
    ok(spy.nc.length === 1, 'panel terbuka: tetap tercatat di pusat notifikasi');
    ok(spy.alerts === 1, 'panel terbuka: bunyi khusus tetap berbunyi');
    ok(spy.card.length === 0, 'panel terbuka: tidak ada kartu menumpuk (panel sudah menampilkan)');
    ok(spy.admMsg === 1, 'panel terbuka: pesan tampil di panel');
    await new Promise((r) => setTimeout(r, 40));
    ok(spy.refresh === 1, 'panel terbuka: data panel diperbarui otomatis');
  }

  // B4. tab tersembunyi / tidak fokus -> notifikasi sistem ikut dikirim
  {
    const { onAdminEvent, spy } = loadAdminHandler({ visible: false });
    onAdminEvent({ type: 'registered', at: Date.now(), user: { id: 'u4', name: 'Cia', email: 'c@t.local' } });
    ok(spy.system.length === 1, 'tab tersembunyi: notifikasi sistem browser dikirim');
    ok(spy.card.length === 0, 'tab tersembunyi: kartu tidak dipaksakan');
  }

  // B5. peristiwa sepele (daring/luring) tidak membanjiri notifikasi
  {
    const { onAdminEvent, spy } = loadAdminHandler();
    onAdminEvent({ type: 'online', at: Date.now(), userId: 'u5', name: 'Dewi' });
    onAdminEvent({ type: 'offline', at: Date.now(), userId: 'u5', name: 'Dewi' });
    ok(spy.nc.length === 0 && spy.alerts === 0 && spy.card.length === 0, 'event daring/luring tidak mengirim notifikasi/bunyi');
  }

  // B6. event penting lain (blokir) juga berbunyi & tercatat
  {
    const { onAdminEvent, spy } = loadAdminHandler();
    onAdminEvent({ type: 'banned', at: Date.now(), user: { id: 'u6', name: 'Eko', email: 'e@t.local' } });
    ok(spy.nc.length === 1 && spy.alerts === 1 && spy.card.length === 1, 'event `banned` ikut ditonjolkan');
  }

  // B7. ref per peristiwa -> tab lain tidak menduplikasi, peristiwa ulang tetap tercatat
  {
    const { onAdminEvent, spy } = loadAdminHandler();
    const payload = { type: 'registered', at: 1700000000000, user: { id: 'u7', name: 'Fajar', email: 'f@t.local' } };
    onAdminEvent(payload);
    onAdminEvent(payload);
    ok(spy.nc.length === 2 && spy.nc[0].ref === spy.nc[1].ref, 'peristiwa identik memakai ref sama (dedupe lintas tab)');

    const { onAdminEvent: h2, spy: s2 } = loadAdminHandler();
    h2({ type: 'login', at: 1700000000000, userId: 'u7', name: 'Fajar' });
    h2({ type: 'login', at: 1700000060000, userId: 'u7', name: 'Fajar' });
    ok(s2.nc.length === 2 && s2.nc[0].ref !== s2.nc[1].ref, 'peristiwa berulang (login ke-2) tetap tercatat terpisah');
  }
}

async function main() {
  await testAdminEvents();
  await testClientHandler();
  console.log(`\nNotifikasi admin: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
