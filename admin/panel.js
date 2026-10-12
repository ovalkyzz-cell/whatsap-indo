'use strict';
/* ============================================================
   PANEL ADMIN — router untuk aplikasi utama & server lokal
   ------------------------------------------------------------
   Dipasang di aplikasi utama pada    ->  https://domain/admin
   Dipasang di server mini terpisah   ->  http://127.0.0.1:3200

   Keamanan (wajib): semua endpoint data & perbaikan TERKUNCI.
   Dibuka lewat salah satu:
     1. kunci ADMIN_KEY  (header x-admin-key atau ?key=)
     2. sesi akun admin aplikasi (JWT Bearer, email di ADMIN_EMAILS
        atau role=admin) — panel otomatis memakai wa_token dari
        localStorage bila admin sudah login di origin yang sama.
   ============================================================ */

const express = require('express');
const db = require('../server/db');
const auth = require('../server/auth');
const { detectEnv, runAll, runFix } = require('./checks');

const ADMIN_KEY = String(process.env.ADMIN_KEY || '');

/* pembatas laju per IP: cek 12/menit, perbaikan 4/10 menit */
const buckets = new Map();
function allowed(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count += 1;
  if (buckets.size > 5000) buckets.clear();
  return b.count <= max;
}

async function guard(req, res, next) {
  try {
    const key = String(req.get('x-admin-key') || req.query.key || '');
    if (ADMIN_KEY && key === ADMIN_KEY) { req.adminVia = 'kunci'; return next(); }

    const header = String(req.get('authorization') || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) {
      const payload = auth.verifyToken(token);
      if (payload && payload.sub) {
        const row = await db.get(
          'SELECT id, email, role, banned, account_status, session_id FROM users WHERE id = ?',
          payload.sub
        ).catch(() => null);
        const live = row
          && !Number(row.banned)
          && row.account_status !== 'pending'
          && row.account_status !== 'rejected'
          && String(payload.sid || '') === String(row.session_id || '');
        if (live && auth.isAdmin(row)) {
          req.adminVia = 'sesi';
          req.adminUser = row;
          return next();
        }
      }
    }
    res.status(401).json({
      error: 'Panel admin terkunci. Masukkan kunci admin, atau masuk ke aplikasi dengan akun admin.',
      code: 'admin-unauthorized',
      ways: ['header x-admin-key / query ?key=', 'JWT akun admin (Authorization: Bearer)'],
    });
  } catch (err) {
    next(err);
  }
}

function createAdminPanel(opts = {}) {
  const router = express.Router();

  const page = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'same-origin');
    res.type('html').send(HTML);
  };

  router.get('/', page);
  router.get('/api/status', guard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...last, busy, base: baseOf(req, opts), via: req.adminVia });
  });
  router.post('/api/check', guard, (req, res) => {
    if (!allowed(`c:${req.ip}`, 12, 60_000)) {
      return res.status(429).json({ error: 'Terlalu sering memeriksa. Coba lagi sebentar lagi.' });
    }
    void withLock(async () => ({ result: await runAll(ctxOf(req, opts)) }))
      .then(({ status, body }) => { res.set('Cache-Control', 'no-store'); res.status(status).json(body); });
  });
  router.post('/api/fix', guard, (req, res) => {
    if (!allowed(`f:${req.ip}`, 4, 600_000)) {
      return res.status(429).json({ error: 'Perbaikan terlalu sering dijalankan. Coba lagi 10 menit lagi.' });
    }
    void withLock(async () => runFix(ctxOf(req, opts)))
      .then((body) => { res.set('Cache-Control', 'no-store'); res.status(200).json(body); })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

  return router;
}

function baseOf(req, opts) {
  if (opts.base) return String(opts.base).replace(/\/+$/, '');
  const host = req.get('host') || '';
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

function ctxOf(req, opts) {
  return detectEnv({
    root: opts.root || process.cwd(),
    base: baseOf(req, opts),
    db: opts.db || db,
    adminEmails: auth.ADMIN_EMAILS,
  });
}

let last = { at: 0, ok: null, checks: [], duration: 0, env: null };
let busy = false;

async function withLock(fn) {
  if (busy) return { status: 409, body: { error: 'Pemeriksaan/perbaikan sedang berjalan. Tunggu sebentar.' } };
  busy = true;
  try {
    const body = await fn();
    if (body && (body.result || body.after)) last = body.result || body.after;
    return { status: 200, body };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    busy = false;
  }
}

const HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Panel Admin — Pemeriksa Bug Whatsap Indo</title>
<style>
  :root { color-scheme: light dark; --ok:#16a34a; --bad:#dc2626; --skip:#64748b; --bg:#0b1220; --card:#111a2e; --line:#1f2b45; --txt:#e6edf7; --mut:#93a4c4; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:linear-gradient(180deg,#0b1220,#0a0f1a); color:var(--txt); min-height:100vh; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 28px 18px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: var(--mut); font-size: 13px; margin-bottom: 18px; }
  .env { display:inline-flex; gap:8px; align-items:center; background:var(--card); border:1px solid var(--line); border-radius:999px; padding:6px 14px; font-size:12.5px; color:var(--mut); margin-bottom:18px; }
  .env b { color:var(--txt); }
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
  .dot.skip { background:rgba(100,116,139,.18); color:var(--skip); }
  .row h3 { margin:0 0 3px; font-size:15px; }
  .row .d { color:var(--mut); font-size:12.5px; line-height:1.5; }
  .row .detail { margin-top:7px; font-size:13px; background:#0c1426; border:1px solid var(--line); border-radius:10px; padding:8px 10px; word-break: break-word; }
  .row.skip { opacity:.78; }
  .ms { margin-left:auto; color:var(--mut); font-size:12px; white-space:nowrap; }
  .fixlog { margin-top:16px; background:#0c1426; border:1px solid var(--line); border-radius:14px; padding:14px 16px; font-size:13.5px; display:none; }
  .fixlog h4 { margin:0 0 8px; font-size:14px; }
  .fixlog div { color:var(--mut); margin:4px 0; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid #ffffff55; border-top-color:#fff; border-radius:50%; animation: s .8s linear infinite; vertical-align:-2px; margin-right:8px; }
  @keyframes s { to { transform: rotate(360deg); } }
  footer { margin-top:26px; color:var(--mut); font-size:12.5px; }
  code { background:#0c1426; border:1px solid var(--line); padding:1px 6px; border-radius:6px; }
  .overlay { position:fixed; inset:0; background:rgba(6,10,20,.72); display:grid; place-items:center; padding:18px; z-index:50; }
  .overlay[hidden] { display:none; }
  .card { width:min(460px,100%); background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px; }
  .card h2 { margin:0 0 8px; font-size:18px; }
  .card p { color:var(--mut); font-size:13px; line-height:1.6; margin:0 0 14px; }
  .card input { width:100%; font:inherit; background:#0c1426; color:var(--txt); border:1px solid var(--line); border-radius:10px; padding:11px 12px; margin-bottom:12px; }
  .card .row-btn { display:flex; gap:10px; flex-wrap:wrap; }
  .msg { margin-top:10px; font-size:12.5px; color:var(--bad); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Panel Admin — Pemeriksa Bug Whatsap Indo</h1>
  <div class="sub">Pemeriksaan berjalan nyata di server ini (bukan simulasi). Hijau = normal, merah = ada masalah, abu-abu = pemeriksaan berat yang hanya bisa dijalankan di mesin server.</div>
  <div class="env" id="envBox">Lingkungan: <b id="env">…</b></div>

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
    <button id="btnKey">Kunci Admin</button>
  </div>

  <div class="fixlog" id="fixlog"></div>
  <div class="list" id="list"></div>

  <footer>Panel admin terproteksi · pemeriksaan: <b id="count">-</b> · target <code id="base">-</code></footer>
</div>

<div class="overlay" id="login" hidden>
  <div class="card">
    <h2>Masuk panel admin</h2>
    <p>Panel ini terkunci. Masukkan kunci <b>ADMIN_KEY</b> dari pengaturan server, atau masuk ke aplikasi dengan akun admin — panel otomatis memakai sesi tersebut.</p>
    <input id="keyInput" type="password" placeholder="Kunci admin" autocomplete="off">
    <div class="row-btn">
      <button class="primary" id="btnLogin">Simpan &amp; Coba Lagi</button>
      <button id="btnClear">Hapus Kunci</button>
    </div>
    <div class="msg" id="loginMsg"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const API = location.pathname.replace(/\\/+$/, '');
let running = false;
let lastResult = null;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  const key = sessionStorage.getItem('wa_admin_key') || '';
  const tok = localStorage.getItem('wa_token') || '';
  if (key) headers['x-admin-key'] = key;
  if (tok) headers['authorization'] = 'Bearer ' + tok;
  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await res.json(); } catch (e) { data = { error: 'respons bukan JSON' }; }
  if (res.status === 401) { showLogin(data && data.error); throw new Error('401'); }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function showLogin(msg) {
  $('login').hidden = false;
  $('loginMsg').textContent = msg || '';
  $('keyInput').focus();
}
function hideLogin() { $('login').hidden = true; $('loginMsg').textContent = ''; }

function render(data) {
  if (!data) return;
  lastResult = data;
  const ok = data.ok === true;
  const bad = data.ok === false;
  $('badge').className = 'badge ' + (ok ? 'ok' : bad ? 'bad' : 'wait');
  $('badge').textContent = ok ? '✓' : bad ? '✕' : '…';
  $('banner').className = 'banner ' + (ok ? 'ok' : bad ? 'bad' : '');
  $('title').textContent = ok ? 'Normal — semua pemeriksaan hijau'
    : bad ? 'Ada masalah — perlu diperbaiki'
    : 'Belum ada hasil';
  const checks = data.checks || [];
  const nOk = checks.filter((c) => c.state === 'ok' || (c.state === undefined && c.ok)).length;
  const nBad = checks.filter((c) => c.state === 'bad' || (c.state === undefined && c.ok === false)).length;
  const nSkip = checks.filter((c) => c.state === 'skip').length;
  $('meta').textContent = data.at
    ? nOk + '/' + checks.length + ' hijau' + (nBad ? ', ' + nBad + ' merah' : '') + (nSkip ? ', ' + nSkip + ' dilewati' : '') +
      ' · ' + Math.round((data.duration || 0) / 100) / 10 + ' detik · ' + new Date(data.at).toLocaleString('id-ID')
    : '';
  if (data.env) {
    $('env').textContent = data.env.full
      ? 'server lokal (pemeriksaan penuh)'
      : (data.env.serverless ? 'server produksi · serverless' : 'server produksi');
  }
  $('base').textContent = (data.env && data.env.base) || '';
  $('count').textContent = checks.length;
  $('list').innerHTML = checks.map((c) => {
    const st = c.state || (c.ok ? 'ok' : 'bad');
    const mark = st === 'ok' ? '✓' : st === 'skip' ? '–' : '✕';
    return '<div class="row ' + st + '">' +
      '<div class="dot ' + st + '">' + mark + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<h3>' + esc(c.label) + '</h3>' +
        '<div class="d">' + esc(c.desc) + '</div>' +
        (c.detail ? '<div class="detail">' + esc(c.detail) + '</div>' : '') +
      '</div>' +
      '<div class="ms">' + (c.ms || 0) + ' ms</div>' +
    '</div>';
  }).join('');
}

function setBusy(on) {
  running = on;
  $('btnCheck').disabled = on;
  $('btnFix').disabled = on;
  $('btnCheck').innerHTML = on ? '<span class="spin"></span>Berjalan…' : 'Cek Ulang';
}

async function check() {
  if (running) return;
  setBusy(true);
  $('loginMsg').textContent = '';
  try {
    const r = await api('/api/check', { method: 'POST' });
    hideLogin();
    render(r.result);
  } catch (e) {
    if (String(e.message) !== '401') $('title').textContent = 'Gagal menghubungi server: ' + e.message;
  } finally { setBusy(false); }
}

async function fix() {
  if (running) return;
  setBusy(true);
  $('btnFix').innerHTML = '<span class="spin"></span>Memperbaiki…';
  try {
    const r = await api('/api/fix', { method: 'POST' });
    hideLogin();
    const box = $('fixlog');
    box.style.display = 'block';
    box.innerHTML = '<h4>Hasil perbaikan satu klik</h4>' +
      (r.fixes && r.fixes.length
        ? r.fixes.map((f) => '<div>' + (f.ok ? '✓' : '✕') + ' <b>' + esc(f.label) + '</b> — ' + esc(f.detail) + '</div>').join('')
        : '<div>Tidak ada pemeriksaan gagal yang punya perbaikan otomatis.</div>') +
      '<div style="margin-top:8px">Pemeriksaan ulang: <b>' + (r.selesai ? 'semua hijau ✓' : 'masih ada yang merah ✕') + '</b></div>';
    render(r.after);
  } catch (e) {
    if (String(e.message) !== '401') $('title').textContent = 'Perbaikan gagal: ' + e.message;
  } finally { $('btnFix').innerHTML = 'Perbaiki Sekali Klik'; setBusy(false); }
}

function summary() {
  const rows = Array.from(document.querySelectorAll('.row')).map((r) => {
    const st = r.querySelector('.dot').textContent.trim();
    return st + ' ' + r.querySelector('h3').textContent + ': ' + ((r.querySelector('.detail') || {}).textContent || '');
  });
  const text = 'Pemeriksa bug Whatsap Indo — ' + $('title').textContent + '\\n' + rows.join('\\n');
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  $('btnCopy').textContent = 'Tersalin ✓';
  setTimeout(() => { $('btnCopy').textContent = 'Salin Ringkasan'; }, 1600);
}

$('btnCheck').addEventListener('click', check);
$('btnFix').addEventListener('click', fix);
$('btnCopy').addEventListener('click', summary);
$('btnKey').addEventListener('click', () => { $('keyInput').value = sessionStorage.getItem('wa_admin_key') || ''; showLogin(''); });
$('btnLogin').addEventListener('click', () => {
  const v = $('keyInput').value.trim();
  if (!v) { $('loginMsg').textContent = 'Kunci tidak boleh kosong.'; return; }
  sessionStorage.setItem('wa_admin_key', v);
  $('keyInput').value = '';
  check();
});
$('btnClear').addEventListener('click', () => {
  sessionStorage.removeItem('wa_admin_key');
  $('keyInput').value = '';
  $('loginMsg').textContent = 'Kunci dihapus.';
});

api('/api/status')
  .then((d) => { if (d.at) { render(d); hideLogin(); } else check(); })
  .catch((e) => { if (String(e.message) !== '401') check(); });
</script>
</body>
</html>`;

module.exports = { createAdminPanel };
