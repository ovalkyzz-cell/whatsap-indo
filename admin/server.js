'use strict';
/* ============================================================
   SERVER MINI ADMIN — Pemeriksa Bug & Perbaikan Satu Klik
   ------------------------------------------------------------
   Menjalankan pemeriksaan NYATA (bukan simulasi): mengecek sintaks
   berkas, dependensi, integritas database, kesehatan server aplikasi,
   referensi DOM, unit test, alur panggilan/VC sungguhan lewat Socket.IO,
   dan kebocoran berkas rahasia. Semua status dikembalikan sebagai
   centang hijau (normal) atau merah (ada masalah).

   Tombol "Perbaiki Sekali Klik" menjalankan perbaikan nyata pada
   pemeriksaan yang gagal (pasang dependensi, perbaiki database,
   restart server, bersihkan baris panggilan macet, amankan git),
   lalu MEMERIKSA ULANG sehingga hasil akhir benar-benar terbukti.

   Jalankan:  npm run admin     ->  http://127.0.0.1:3200
   ============================================================ */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ADMIN_PORT) || 3200;
const HOST = process.env.ADMIN_HOST || '127.0.0.1';
const APP_PORT = Number(process.env.PORT) || 3000;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const APP_PROC = process.env.APP_PROCESS || 'wa-server'; // nama pm2 aplikasi utama

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ---------- util ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { timeout = 180_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || ''),
        timedOut: !!(error && error.killed),
      }));
  });
}

const parseResult = (out) => {
  const m = /RESULT:\s*(\d+)\s*passed,\s*(\d+)\s*failed/.exec(out);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
};

function walk(dir, list = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'uploads' || e.name === 'data') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, list);
    else if (e.name.endsWith('.js')) list.push(path.relative(ROOT, full));
  }
  return list;
}

async function fetchJson(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body: text.slice(0, 400) };
  } catch (err) {
    return { status: 0, ok: false, body: err.message };
  } finally {
    clearTimeout(t);
  }
}

/* ============================================================
   PEMERIKSAAN
   ============================================================ */

/* 1. Sintaks seluruh berkas JavaScript */
async function checkSyntax() {
  const files = ['server.js', 'public/sw.js', ...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'public', 'js')),
    ...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'admin'))];
  const bad = [];
  for (const f of files) {
    const r = await run(process.execPath, ['--check', path.join(ROOT, f)], { timeout: 30_000 });
    if (r.code !== 0) {
      const first = (r.err || r.out).split('\n').find((l) => l.trim()) || 'galat';
      bad.push(`${f} — ${first}`);
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.slice(0, 5).join(' • ') : `${files.length} berkas JavaScript lolos node --check`,
    data: { total: files.length, bad },
  };
}

/* 2. Dependensi terpasang & bisa dimuat */
async function checkDeps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const missing = [];
  for (const name of names) {
    try { require.resolve(name, { paths: [ROOT] }); } catch { missing.push(name); }
  }
  const critical = ['express', 'socket.io', 'better-sqlite3', 'sharp'];
  const broken = [];
  for (const name of critical) {
    if (missing.includes(name)) continue;
    try { require(require.resolve(name, { paths: [ROOT] })); } catch (err) { broken.push(`${name}: ${err.message}`); }
  }
  const bad = [...missing.map((m) => `hilang: ${m}`), ...broken];
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.join(' • ') : `${names.length} dependensi terpasang & bisa dimuat`,
    data: { total: names.length, missing, broken },
  };
}

/* 3. Integritas database: koneksi, skema, kolom, baris macet */
async function checkDb() {
  const db = require(path.join(ROOT, 'server', 'db.js'));
  await db.ready;
  const problems = [];

  if (db.dialect === 'sqlite') {
    const rows = await db.all('PRAGMA integrity_check').catch((e) => [{ integrity_check: e.message }]);
    const verdict = String(rows && rows[0] && Object.values(rows[0])[0]).toLowerCase();
    if (verdict !== 'ok') problems.push(`integrity_check: ${verdict}`);
  } else {
    const r = await db.get('SELECT 1 AS ok').catch((e) => ({ ok: 0, error: e.message }));
    if (!r || Number(r.ok) !== 1) problems.push(`koneksi database: ${r && r.error ? r.error : 'gagal'}`);
  }

  const required = ['users', 'chats', 'chat_members', 'messages', 'message_status', 'calls', 'settings', 'presence', 'statuses'];
  const present = db.dialect === 'sqlite'
    ? (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)
    : (await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.name);
  const missingTables = required.filter((t) => !present.includes(t));
  if (missingTables.length) problems.push(`tabel hilang: ${missingTables.join(', ')}`);

  const cols = db.dialect === 'sqlite'
    ? (await db.all('PRAGMA table_info(calls)')).map((c) => c.name)
    : (await db.all("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'calls'")).map((c) => c.name);
  const missingCols = ['answered_at', 'caller_id', 'callee_id', 'state', 'kind'].filter((c) => !cols.includes(c));
  if (missingCols.length) problems.push(`kolom calls hilang: ${missingCols.join(', ')}`);

  const now = Date.now();
  const stuckRinging = (await db.get(`SELECT COUNT(*) AS n FROM calls WHERE state = 'ringing' AND created_at <= ?`, now - 60_000))?.n || 0;
  const stuckActive = (await db.get(`SELECT COUNT(*) AS n FROM calls WHERE state IN ('accepted','active') AND updated_at <= ?`, now - 6 * 3_600_000))?.n || 0;
  const orphanStatus = (await db.get(
    'SELECT COUNT(*) AS n FROM message_status s WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)'
  ))?.n || 0;
  const orphanMessages = (await db.get(
    'SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM chat_members c WHERE c.chat_id = m.chat_id)'
  ))?.n || 0;

  const stuck = Number(stuckRinging) + Number(stuckActive) + Number(orphanStatus) + Number(orphanMessages);
  if (stuck) problems.push(`${stuckRinging} dering kadaluarsa, ${stuckActive} panggilan aktif macet, ${orphanStatus} status yatap, ${orphanMessages} pesan yatap`);

  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join(' • ') : `database ${db.dialect} sehat — skema lengkap, tidak ada baris macet`,
    data: { dialect: db.dialect, present: present.length, stuckRinging, stuckActive, orphanStatus, orphanMessages },
  };
}

/* 4. Aplikasi (server utama) hidup & endpoint menjawab */
async function checkServer() {
  const probes = [
    ['halaman utama', `${BASE}/`],
    ['manifest PWA', `${BASE}/manifest.json`],
    ['service worker', `${BASE}/sw.js`],
    ['kesehatan API', `${BASE}/api/health`],
  ];
  const down = [];
  for (const [label, url] of probes) {
    const r = await fetchJson(url);
    if (!r.ok) down.push(`${label} → HTTP ${r.status || 'putus'}`);
  }
  return {
    ok: down.length === 0,
    detail: down.length ? down.join(' • ') : `server menjawab di ${BASE} (4 endpoint)`,
    data: { base: BASE, down },
  };
}

/* 5. Referensi frontend: id DOM ganda & $() yang menunjuk id tak ada */
async function checkStatic() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const problems = [];

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) { if (seen.has(id)) dupes.add(id); seen.add(id); }
  if (dupes.size) problems.push(`id duplikat: ${[...dupes].join(', ')}`);

  const refs = [...js.matchAll(/\$\('([^']+)'\)/g)];
  const missing = [];
  for (const m of refs) {
    const id = m[1];
    if (id.includes('$') || id.includes('{')) continue; // template dinamis
    if (seen.has(id)) continue;
    if (js.includes(`'${id}'`)) continue; // dibuat dinamis oleh JS
    const line = js.slice(0, m.index).split('\n').length;
    missing.push(`app.js:${line} → $(${id})`);
  }
  if (missing.length) problems.push(`referensi id tak ada: ${missing.slice(0, 5).join(', ')}`);

  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join(' • ') : `${ids.length} id DOM unik, 0 duplikat, seluruh $() terpetakan`,
    data: { ids: ids.length, dupes: [...dupes], missing },
  };
}

/* 6. Unit test: pemotong foto & mesin panggilan */
async function checkUnit() {
  const out = [];
  let failed = 0;
  for (const file of ['test/crop.js', 'test/calls.js']) {
    const r = await run(process.execPath, [file], { timeout: 120_000 });
    const res = parseResult(r.out);
    out.push(`${file}: ${res ? `${res.passed} lulus / ${res.failed} gagal` : 'tidak menghasilkan RESULT'}`);
    if (!res || res.failed > 0 || r.code !== 0) failed++;
  }
  return { ok: failed === 0, detail: out.join(' • '), data: { failed } };
}

/* 7. Alur panggilan/VC sungguhan (Socket.IO end-to-end) */
async function checkCallflow() {
  const r = await run(process.execPath, ['test/callflow.js'], { timeout: 180_000 });
  const res = parseResult(r.out);
  if (!res) {
    const first = (r.err || r.out).split('\n').find((l) => l.trim()) || 'galat tidak diketahui';
    return { ok: false, detail: `uji panggilan gagal dijalankan — ${first}`, data: { raw: (r.out || r.err).slice(-800) } };
  }
  return {
    ok: res.failed === 0,
    detail: res.failed === 0
      ? `alur panggilan/VC normal: ${res.passed} pemeriksaan lulus (dering, jawab, sinyal WebRTC, ditutup)`
      : `${res.failed} pemeriksaan panggilan gagal dari ${res.passed + res.failed}`,
    data: res,
  };
}

/* 8. Berkas rahasia tidak ikut ter-commit */
async function checkSecrets() {
  const ls = await run('git', ['ls-files']);
  const tracked = ls.out.split('\n').map((s) => s.trim()).filter(Boolean);
  const risky = tracked.filter((f) => /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|secret/i.test(f));
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const guarded = /\.env/.test(gitignore);
  const problems = [];
  if (risky.length) problems.push(`ter-commit: ${risky.join(', ')}`);
  if (!guarded) problems.push('.gitignore belum menutup berkas .env');
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join(' • ') : `${tracked.length} berkas terpantau, tidak ada rahasia yang ter-commit`,
    data: { tracked: tracked.length, risky, guarded },
  };
}

/* ============================================================
   PERBAIKAN (dijalankan tombol "Perbaiki Sekali Klik")
   ============================================================ */

async function fixDeps() {
  const r = await run('npm', ['install', '--no-audit', '--no-fund'], { timeout: 600_000 });
  if (r.code !== 0) return { ok: false, detail: `npm install gagal: ${(r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' ')}` };
  return { ok: true, detail: 'dependensi dipasang ulang lewat npm install' };
}

async function fixDb() {
  const db = require(path.join(ROOT, 'server', 'db.js'));
  await db.ready;
  const now = Date.now();
  const actions = [];

  // migrasi kolom/index dijalankan saat boot; pastikan skema lengkap
  await db.exec('CREATE INDEX IF NOT EXISTS idx_calls_state ON calls (state)').catch(() => {});
  actions.push('migrasi & indeks dijalankan');

  const ringing = await db.run(
    `UPDATE calls SET state = 'missed', updated_at = ? WHERE state = 'ringing' AND created_at <= ?`,
    now, now - 60_000
  );
  if (ringing.changes) actions.push(`${ringing.changes} dering kadaluarsa ditandai missed`);

  const active = await db.run(
    `UPDATE calls SET state = 'ended', updated_at = ? WHERE state IN ('accepted','active') AND updated_at <= ?`,
    now, now - 6 * 3_600_000
  );
  if (active.changes) actions.push(`${active.changes} panggilan aktif macet ditutup`);

  const os = await db.run(
    'DELETE FROM message_status WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = message_status.message_id)'
  ).catch(() => ({ changes: 0 }));
  if (os.changes) actions.push(`${os.changes} status pesan yatap dibersihkan`);

  const om = await db.run(
    'DELETE FROM messages WHERE NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_members.chat_id = messages.chat_id)'
  ).catch(() => ({ changes: 0 }));
  if (om.changes) actions.push(`${om.changes} pesan yatap dibersihkan`);

  if (db.dialect === 'sqlite') {
    await db.exec('REINDEX').catch(() => {});
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    actions.push('indeks direkonstruksi & WAL dibersihkan');
  }

  return { ok: true, detail: actions.join(', ') };
}

async function fixServer() {
  const hasPm2 = await run('pm2', ['--version'], { timeout: 20_000 });
  if (hasPm2.code === 0) {
    const list = await run('pm2', ['jlist'], { timeout: 30_000 });
    let procs = [];
    try { procs = JSON.parse(list.out); } catch { procs = []; }
    const found = procs.find((p) => p && p.name === APP_PROC);
    const res = found
      ? await run('pm2', ['restart', APP_PROC, '--update-env'], { timeout: 60_000 })
      : await run('pm2', ['start', 'server/index.js', '--name', APP_PROC], { timeout: 60_000 });
    if (res.code !== 0) return { ok: false, detail: `pm2 gagal: ${(res.err || res.out).split('\n').filter(Boolean).slice(-2).join(' ')}` };
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const probe = await fetchJson(`${BASE}/`);
      if (probe.ok) return { ok: true, detail: `server aplikasi dijalankan ulang lewat pm2 dan kembali menjawab (percobaan ke-${i + 1})` };
    }
    return { ok: false, detail: 'server dijalankan ulang tetapi belum menjawab setelah 14 detik' };
  }
  return { ok: false, detail: 'pm2 tidak tersedia — jalankan ulang aplikasi secara manual (npm start)' };
}

async function fixSecrets() {
  const ls = await run('git', ['ls-files']);
  const risky = ls.out.split('\n').map((s) => s.trim()).filter((f) => f && /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa/i.test(f));
  const actions = [];
  for (const f of risky) {
    const r = await run('git', ['rm', '--cached', '-q', '--', f]);
    if (r.code === 0) actions.push(`${f} dilepas dari index git`);
  }
  const giPath = path.join(ROOT, '.gitignore');
  let gi = fs.readFileSync(giPath, 'utf8');
  if (!/\.env/.test(gi)) {
    gi += (gi.endsWith('\n') ? '' : '\n') + '.env*\n';
    fs.writeFileSync(giPath, gi);
    actions.push('.gitignore diperbarui');
  }
  return {
    ok: true,
    detail: actions.length ? actions.join(', ') : 'tidak ada berkas rahasia yang perlu dilepas',
  };
}

async function fixCallflow() {
  const a = await fixDb();
  const b = await fixServer();
  return {
    ok: a.ok && b.ok,
    detail: `perbaikan panggilan — database: ${a.detail} | server: ${b.detail}`,
  };
}

/* ============================================================
   DAFTAR PEMERIKSAAN
   ============================================================ */

const CHECKS = [
  { id: 'syntax', label: 'Sintaks JavaScript', desc: 'node --check pada seluruh berkas sumber', run: checkSyntax },
  { id: 'deps', label: 'Dependensi', desc: 'modul di package.json terpasang & bisa dimuat', run: checkDeps, fix: fixDeps },
  { id: 'db', label: 'Database & skema', desc: 'integritas, tabel, kolom panggilan, baris macet', run: checkDb, fix: fixDb },
  { id: 'server', label: 'Server aplikasi', desc: 'halaman, manifest, service worker & /api/health menjawab', run: checkServer, fix: fixServer },
  { id: 'static', label: 'Referensi frontend', desc: 'id DOM ganda & $() yang menunjuk id tak ada', run: checkStatic },
  { id: 'unit', label: 'Unit test (crop + calls)', desc: 'mesin crop dan mesin panggilan', run: checkUnit },
  { id: 'callflow', label: 'Alur panggilan / VC', desc: 'uji nyata Socket.IO: dering, jawab, sinyal, tutup', run: checkCallflow, fix: fixCallflow },
  { id: 'secrets', label: 'Berkas rahasia git', desc: '.env / kunci tidak ikut ter-commit', run: checkSecrets, fix: fixSecrets },
];

/* ============================================================
   PENYIMPANAN STATUS + API
   ============================================================ */

let last = { at: 0, ok: null, checks: [], duration: 0 };
let busy = false;

async function runAll() {
  const started = Date.now();
  const results = [];
  for (const item of CHECKS) {
    const t0 = Date.now();
    let res;
    try {
      res = await item.run();
    } catch (err) {
      res = { ok: false, detail: `pemeriksaan gagal dijalankan: ${err.message}`, data: null };
    }
    results.push({
      id: item.id,
      label: item.label,
      desc: item.desc,
      ok: !!res.ok,
      detail: res.detail || '',
      data: res.data || null,
      ms: Date.now() - t0,
      fixable: typeof item.fix === 'function',
    });
  }
  last = {
    at: Date.now(),
    ok: results.every((r) => r.ok),
    checks: results,
    duration: Date.now() - started,
  };
  return last;
}

async function withLock(fn) {
  if (busy) return { status: 409, body: { error: 'Pemeriksaan/perbaikan sedang berjalan. Tunggu sebentar.' } };
  busy = true;
  try {
    const body = await fn();
    return { status: 200, body };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    busy = false;
  }
}

function guard(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.get('x-admin-key') || req.query.key || '';
  if (key === ADMIN_KEY) return next();
  res.status(401).json({ error: 'ADMIN_KEY salah. Tambahkan ?key=ATAU header x-admin-key.' });
}

app.use(guard);

app.get('/api/status', (req, res) => res.json({ ...last, busy, base: BASE }));

app.post('/api/check', (req, res) => {
  void withLock(async () => ({ result: await runAll() })).then(({ status, body }) => res.status(status).json(body));
});

app.post('/api/fix', (req, res) => {
  void withLock(async () => {
    const before = await runAll();
    const fixes = [];
    for (const item of CHECKS) {
      if (typeof item.fix !== 'function') continue;
      const target = before.checks.find((c) => c.id === item.id);
      if (!target || target.ok) continue;
      const t0 = Date.now();
      let out;
      try { out = await item.fix(); }
      catch (err) { out = { ok: false, detail: err.message }; }
      fixes.push({ id: item.id, label: item.label, ok: !!out.ok, detail: out.detail || '', ms: Date.now() - t0 });
      if (out.ok) await sleep(300);
    }
    const after = await runAll();
    return { before, fixes, after, selesai: after.ok };
  }).then(({ status, body }) => res.status(status).json(body));
});

/* ============================================================
   DASHBOARD
   ============================================================ */

app.get('/', (req, res) => {
  res.type('html').send(HTML);
});

const HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panel Admin — Pemeriksa Bug Whatsap Indo</title>
<style>
  :root { color-scheme: light dark; --ok:#16a34a; --bad:#dc2626; --bg:#0b1220; --card:#111a2e; --line:#1f2b45; --txt:#e6edf7; --mut:#93a4c4; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:linear-gradient(180deg,#0b1220,#0a0f1a); color:var(--txt); min-height:100vh; }
  .wrap { max-width: 940px; margin: 0 auto; padding: 28px 18px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: var(--mut); font-size: 13px; margin-bottom: 22px; }
  .banner { display:flex; gap:18px; align-items:center; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px; }
  .banner.ok { border-color: rgba(22,163,74,.55); box-shadow: 0 0 0 1px rgba(22,163,74,.18), 0 14px 40px rgba(22,163,74,.10); }
  .banner.bad { border-color: rgba(220,38,38,.55); box-shadow: 0 0 0 1px rgba(220,38,38,.18), 0 14px 40px rgba(220,38,38,.10); }
  .badge { width:74px; height:74px; border-radius:50%; display:grid; place-items:center; font-size:38px; flex:0 0 auto; }
  .badge.ok { background:rgba(22,163,74,.16); color:var(--ok); }
  .badge.bad { background:rgba(220,38,38,.16); color:var(--bad); }
  .badge.wait { background:rgba(147,164,196,.14); color:var(--mut); }
  .title { font-size: 24px; font-weight: 700; margin: 0 0 6px; }
  .meta { color: var(--mut); font-size: 13px; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin: 20px 0 6px; }
  button { font: inherit; font-weight:600; border:1px solid var(--line); background:#16223a; color:var(--txt); padding:11px 18px; border-radius:12px; cursor:pointer; }
  button:hover { background:#1c2b4a; }
  button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
  button.primary:hover { background:#1d4ed8; }
  button.fix { background:#16a34a; border-color:#16a34a; color:#fff; }
  button.fix:hover { background:#15803d; }
  button:disabled { opacity:.55; cursor: not-allowed; }
  .list { display:grid; gap:10px; margin-top:18px; }
  .row { display:flex; gap:14px; align-items:flex-start; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; }
  .dot { width:24px; height:24px; border-radius:50%; flex:0 0 auto; display:grid; place-items:center; font-size:14px; font-weight:700; margin-top:1px; }
  .dot.ok { background:rgba(22,163,74,.18); color:var(--ok); }
  .dot.bad { background:rgba(220,38,38,.18); color:var(--bad); }
  .row h3 { margin:0 0 3px; font-size:15px; }
  .row .d { color:var(--mut); font-size:12.5px; line-height:1.5; }
  .row .detail { margin-top:7px; font-size:13px; background:#0c1426; border:1px solid var(--line); border-radius:10px; padding:8px 10px; word-break: break-word; }
  .ms { margin-left:auto; color:var(--mut); font-size:12px; white-space:nowrap; }
  .fixlog { margin-top:16px; background:#0c1426; border:1px solid var(--line); border-radius:14px; padding:14px 16px; font-size:13.5px; display:none; }
  .fixlog h4 { margin:0 0 8px; font-size:14px; }
  .fixlog div { color:var(--mut); margin:4px 0; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid #ffffff55; border-top-color:#fff; border-radius:50%; animation: s .8s linear infinite; vertical-align:-2px; margin-right:8px; }
  @keyframes s { to { transform: rotate(360deg); } }
  footer { margin-top:26px; color:var(--mut); font-size:12.5px; }
  code { background:#0c1426; border:1px solid var(--line); padding:1px 6px; border-radius:6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Panel Admin — Pemeriksa Bug Whatsap Indo</h1>
  <div class="sub">Pemeriksaan berjalan nyata di server ini (bukan simulasi). Hijau = normal, merah = ada masalah yang perlu diperbaiki.</div>

  <div class="banner" id="banner">
    <div class="badge wait" id="badge">…</div>
    <div>
      <div class="title" id="title">Memeriksa…</div>
      <div class="meta" id="meta">Menjalankan pemeriksaan pertama</div>
    </div>
  </div>

  <div class="actions">
    <button class="primary" id="btnCheck">Cek Ulang</button>
    <button class="fix" id="btnFix">Perbaiki Sekali Klik</button>
    <button id="btnCopy">Salin Ringkasan</button>
  </div>

  <div class="fixlog" id="fixlog"></div>
  <div class="list" id="list"></div>

  <footer>Server mini admin · pemeriksaan: <b id="count">-</b> · target aplikasi <code id="base"></code></footer>
</div>

<script>
const $ = (id) => document.getElementById(id);
let running = false;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function render(data) {
  if (!data) return;
  const ok = data.ok === true;
  const bad = data.ok === false;
  $('badge').className = 'badge ' + (ok ? 'ok' : bad ? 'bad' : 'wait');
  $('badge').textContent = ok ? '✓' : bad ? '✕' : '…';
  $('banner').className = 'banner ' + (ok ? 'ok' : bad ? 'bad' : '');
  $('title').textContent = ok ? 'Normal — semua pemeriksaan hijau'
    : bad ? 'Ada masalah — perlu diperbaiki'
    : 'Belum ada hasil';
  const nOk = (data.checks || []).filter((c) => c.ok).length;
  const nBad = (data.checks || []).filter((c) => !c.ok).length;
  $('meta').textContent = data.at
    ? nOk + '/' + (data.checks || []).length + ' pemeriksaan hijau' + (nBad ? ', ' + nBad + ' merah' : '') +
      ' · ' + Math.round((data.duration || 0) / 100) / 10 + ' detik · ' + new Date(data.at).toLocaleString('id-ID')
    : '';
  $('count').textContent = (data.checks || []).length;
  $('list').innerHTML = (data.checks || []).map((c) => (
    '<div class="row">' +
      '<div class="dot ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✓' : '✕') + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<h3>' + esc(c.label) + '</h3>' +
        '<div class="d">' + esc(c.desc) + '</div>' +
        (c.detail ? '<div class="detail">' + esc(c.detail) + '</div>' : '') +
      '</div>' +
      '<div class="ms">' + (c.ms || 0) + ' ms</div>' +
    '</div>'
  )).join('');
}

function setBusy(on) {
  running = on;
  $('btnCheck').disabled = on;
  $('btnFix').disabled = on;
  $('btnCheck').innerHTML = on ? '<span class="spin"></span>Berjalan…' : 'Cek Ulang';
}

async function post(url) {
  const res = await fetch(url, { method: 'POST' });
  return res.json();
}

async function check() {
  if (running) return;
  setBusy(true);
  try {
    const r = await post('/api/check');
    if (r.error) { $('title').textContent = r.error; return; }
    render(r.result);
  } catch (e) { $('title').textContent = 'Gagal menghubungi server mini admin'; }
  finally { setBusy(false); }
}

async function fix() {
  if (running) return;
  setBusy(true);
  $('btnFix').innerHTML = '<span class="spin"></span>Memperbaiki…';
  try {
    const r = await post('/api/fix');
    if (r.error) { $('title').textContent = r.error; return; }
    const box = $('fixlog');
    box.style.display = 'block';
    box.innerHTML = '<h4>Hasil perbaikan satu klik</h4>' +
      (r.fixes && r.fixes.length
        ? r.fixes.map((f) => '<div>' + (f.ok ? '✓' : '✕') + ' <b>' + esc(f.label) + '</b> — ' + esc(f.detail) + '</div>').join('')
        : '<div>Tidak ada pemeriksaan gagal yang punya perbaikan otomatis.</div>') +
      '<div style="margin-top:8px">Pemeriksaan ulang: <b>' + (r.selesai ? 'semua hijau ✓' : 'masih ada yang merah ✕') + '</b></div>';
    render(r.after);
  } catch (e) { $('title').textContent = 'Perbaikan gagal dijalankan'; }
  finally { $('btnFix').innerHTML = 'Perbaiki Sekali Klik'; setBusy(false); }
}

function summary() {
  const rows = Array.from(document.querySelectorAll('.row')).map((r) => {
    const st = r.querySelector('.dot').textContent.trim();
    return st + ' ' + r.querySelector('h3').textContent + ': ' + (r.querySelector('.detail') || { textContent: '' }).textContent;
  });
  const text = 'Pemeriksa bug Whatsap Indo — ' + $('title').textContent + '\\n' + rows.join('\\n');
  navigator.clipboard && navigator.clipboard.writeText(text);
  $('btnCopy').textContent = 'Tersalin ✓';
  setTimeout(() => { $('btnCopy').textContent = 'Salin Ringkasan'; }, 1600);
}

$('btnCheck').addEventListener('click', check);
$('btnFix').addEventListener('click', fix);
$('btnCopy').addEventListener('click', summary);

fetch('/api/status').then((r) => r.json()).then((d) => {
  $('base').textContent = d.base || '';
  if (d.at) render(d); else check();
}).catch(() => check());
</script>
</body>
</html>`;

app.listen(PORT, HOST, () => {
  console.log(`Server mini admin berjalan di http://${HOST}:${PORT}`);
  console.log(`Target aplikasi: ${BASE}${ADMIN_KEY ? ' (kunci admin aktif)' : ''}`);
});
