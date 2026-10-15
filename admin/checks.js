'use strict';
/* ============================================================
   MESIN PEMERIKSAAN & PERBAIKAN SERVER MINI ADMIN
   ------------------------------------------------------------
   Modul ini dipakai DUA tempat dengan kode yang sama:
     1. server lokal      -> npm run admin  (pemeriksaan penuh)
     2. aplikasi di domain -> /admin         (pemeriksaan adaptif)

   Lingkungan serverless (Vercel) tidak punya git maupun pm2.
   Pemeriksaan yang dahulu butuh akses mesin (child_process / git) kini
   dijalankan dengan logika serverless-tetap-NYATA:
     sintaks  -> parse vm.Script (bukan node --check)
     unit     -> run() yang diekspor tiap berkas uji, in-process
     callflow -> handshake Socket.IO sungguhan ke aplikasi yang hidup
     secrets  -> pindai fs bundel deployment (tanpa git)
   Pemeriksaan yang berjalan di mana pun tetap NYATA:
      koneksi & skema database, baris macet, endpoint aplikasi,
      referensi DOM frontend, dan ketersediaan modul runtime.
   ============================================================ */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execFile } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { timeout = 180_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || ''),
      }));
  });
}

const parseResult = (out) => {
  const m = /RESULT:\s*(\d+)\s*passed,\s*(\d+)\s*failed/.exec(out);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
};

function walk(dir, root, list = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'uploads' || e.name === 'data') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, list);
    else if (e.name.endsWith('.js')) list.push(path.relative(root, full));
  }
  return list;
}

async function fetchJson(url, timeout = 8000, maxLen = 300, { retries = 0 } = {}) {
  const attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text().catch(() => '');
      return { status: res.status, ok: res.ok, body: text.slice(0, maxLen) };
    } catch (err) {
      return { status: 0, ok: false, body: err.message };
    } finally {
      clearTimeout(t);
    }
  };
  let out = await attempt();
  // serverless (Vercel) cold-start: percobaan pertama sering putus/timeout walau
  // server sehat. Ulangi beberapa kali dengan jeda singkat supaya pemeriksaan
  // "cek sekali klik" tidak menampilkan merah palsu.
  for (let i = 0; i < retries && !out.ok; i++) {
    await sleep(600);
    out = await attempt();
  }
  return out;
}

/* ---------- deteksi lingkungan ---------- */
function detectEnv({ root = process.cwd(), base = '', db = null, adminEmails = [], token = '' } = {}) {
  const serverless = !!process.env.VERCEL;
  const hasSource = fs.existsSync(path.join(root, 'server', 'index.js'))
    && fs.existsSync(path.join(root, 'public', 'index.html'));
  const hasTests = fs.existsSync(path.join(root, 'test', 'callflow.js'));
  return {
    root,
    base: String(base || '').replace(/\/+$/, ''),
    db,
    adminEmails,
    token,
    serverless,
    full: !serverless && hasSource && hasTests,
    hasSource,
    hasTests,
  };
}

/* ============================================================
   PEMERIKSAAN
   ============================================================ */

/* 1. Sintaks seluruh berkas JavaScript — parse nyata memakai vm.Script.
   Tidak lagi memakai `node --check` (child_process) sehingga berjalan
   di server lokal maupun lingkungan serverless (Vercel). vm.Script
   mem-parses kode sungguhan sehingga galat sintaks nyata terdeteksi. */
async function checkSyntax(ctx) {
  const { root } = ctx;
  const files = ['server.js', 'public/sw.js',
    ...walk(path.join(root, 'server'), root),
    ...walk(path.join(root, 'public', 'js'), root),
    ...walk(path.join(root, 'test'), root),
    ...walk(path.join(root, 'admin'), root)];
  const bad = [];
  for (const f of files) {
    let code;
    try {
      code = fs.readFileSync(path.join(root, f), 'utf8');
    } catch (err) {
      bad.push(`${f} — tidak bisa dibaca: ${err.message}`);
      continue;
    }
    try {
      // eslint-disable-next-line no-new
      new vm.Script(code, { filename: f });
    } catch (err) {
      bad.push(`${f} — ${String(err.message).split('\n')[0]}`);
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.slice(0, 5).join(' • ') : `${files.length} berkas JavaScript lolos parse vm.Script`,
    data: { total: files.length, bad },
  };
}

/* 2. Dependensi terpasang & bisa dimuat */
async function checkDeps(ctx) {
  const { root, full } = ctx;
  const names = full
    ? Object.keys({ ...JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies })
    : ['express', 'socket.io', 'jsonwebtoken', 'bcryptjs', 'multer', 'web-push', 'pg', 'sharp', '@vercel/blob'];
  const missing = [];
  const broken = [];
  for (const name of names) {
    try {
      const resolved = full ? require.resolve(name, { paths: [root] }) : require.resolve(name);
      require(resolved);
    } catch (err) {
      if (String(err && err.code) === 'MODULE_NOT_FOUND') missing.push(name);
      else broken.push(`${name}: ${err.message}`);
    }
  }
  const bad = [...missing.map((m) => `hilang: ${m}`), ...broken];
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.join(' • ')
      : `${names.length} modul${full ? ' di package.json' : ' runtime'} terpasang & bisa dimuat`,
    data: { total: names.length, missing, broken },
  };
}

/* 3. Integritas database: koneksi, skema, kolom, baris macet */
async function checkDb(ctx) {
  const db = ctx.db;
  if (!db) return { ok: false, detail: 'modul database tidak tersedia' };
  try { await (typeof db.ready === 'function' ? db.ready() : db.ready); } catch { /* biarkan query berikutnya melaporkan galatnya */ }
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

/* 4. Aplikasi hidup: halaman, manifest, service worker & /api/health */
async function checkServer(ctx) {
  const base = ctx.base;
  if (!base) return { ok: false, detail: 'alamat aplikasi tidak diketahui' };
  const probes = [
    ['halaman utama', `${base}/`],
    ['manifest PWA', `${base}/manifest.json`],
    ['service worker', `${base}/sw.js`],
    ['kesehatan API', `${base}/api/health`],
  ];
  // retries: tahan cold-start serverless — percobaan pertama sering putus
  const results = await Promise.all(probes.map(([, url]) => fetchJson(url, 8000, 300, { retries: 2 })));
  const down = [];
  results.forEach((r, i) => { if (!r.ok) down.push(`${probes[i][0]} → HTTP ${r.status || 'putus'}`); });
  return {
    ok: down.length === 0,
    detail: down.length ? down.join(' • ') : `server menjawab di ${base} (4 endpoint)`,
    data: { base, down },
  };
}

/* 5. Referensi frontend: id DOM ganda & $() yang menunjuk id tak ada */
async function checkStatic(ctx) {
  const { root, full, base } = ctx;
  let html;
  let js;
  let sumber = 'berkas lokal';
  if (full) {
    html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  } else {
    const [h, j] = await Promise.all([
      fetchJson(`${base}/`, 15000, 400_000, { retries: 2 }),
      fetchJson(`${base}/js/app.js`, 20000, 900_000, { retries: 2 }),
    ]);
    if (!h.ok || !j.ok) {
      return { ok: false, detail: `berkas frontend tidak bisa diambil — index ${h.status || 'putus'}, app.js ${j.status || 'putus'}` };
    }
    html = h.body;
    js = j.body;
    sumber = 'hasil unduhan dari domain';
  }
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
    detail: problems.length ? problems.join(' • ')
      : `${ids.length} id DOM unik, 0 duplikat, seluruh $() terpetakan (${sumber})`,
    data: { ids: ids.length, dupes: [...dupes], missing },
  };
}

/* 2b. Unit test: pemotong foto & mesin panggilan.
   Dijalankan in-process lewat run() yang diekspor tiap berkas uji,
   sehingga berjalan di server lokal maupun serverless tanpa child_process.
   crop: murni vm/DOM tiruan (aman). calls: menyentuh database sungguhan
   dengan id ber-namespace unit-* dan membersihkan dirinya sendiri. */
async function checkUnit(ctx) {
  const out = [];
  let failed = 0;
  for (const file of ['test/crop.js', 'test/calls.js']) {
    let res = null;
    let err = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(path.join(ctx.root, file));
      if (typeof mod.run !== 'function') throw new Error('modul tidak mengekspor run()');
      res = await mod.run();
    } catch (e) {
      err = e;
    }
    if (res) {
      out.push(`${file}: ${res.pass} lulus / ${res.fail} gagal`);
      if (res.fail > 0) failed++;
    } else {
      out.push(`${file}: gagal — ${err ? err.message : 'tidak menghasilkan hasil'}`);
      failed++;
    }
  }
  return { ok: failed === 0, detail: out.join(' • '), data: { failed } };
}

/* 3b. Alur panggilan/VC sungguhan lewat Socket.IO.
   Di server lokal (full) dijalankan uji alur penuh test/callflow.js.
   Di serverless (Vercel) tidak bisa memanggil server, tetapi kita
   melakukan handshake Socket.IO NYATA ke aplikasi yang sedang hidup
   (ctx.base): koneksi websocket sungguhan, connect event, lalu putus.
   Ini pemeriksaan nyata lapisan Socket.IO produksi, bukan simulasi. */
async function checkCallflow(ctx) {
  if (ctx.full) {
    const r = await run(process.execPath, ['test/callflow.js'], { timeout: 180_000, cwd: ctx.root });
    const res = parseResult(r.out);
    if (!res) {
      const first = (r.err || r.out).split('\n').find((l) => l.trim()) || 'galat tidak diketahui';
      return { ok: false, detail: `uji panggilan gagal dijalankan — ${first}`, data: { raw: (r.out || r.err).slice(-600) } };
    }
    return {
      ok: res.failed === 0,
      detail: res.failed === 0
        ? `alur panggilan/VC normal: ${res.passed} pemeriksaan lulus (dering, jawab, sinyal WebRTC, ditutup)`
        : `${res.failed} pemeriksaan panggilan gagal dari ${res.passed + res.failed}`,
      data: res,
    };
  }
  // serverless: handshake Socket.IO NYATA ke aplikasi hidup.
  // io.use() mewajibkan token valid yang ditandatangani server yang SAMA,
  // jadi kita memakai token sesi admin yang sudah dilewatkan panel (ctx.token)
  // — bukan token yang diminta ulang dengan proses/JWT_SECRET berbeda.
  const base = ctx.base;
  if (!base) return { ok: false, detail: 'alamat aplikasi tidak diketahui untuk uji Socket.IO' };
  const token = String(ctx.token || '').trim();
  if (!token) {
    return { ok: false, detail: 'token sesi admin tidak tersedia untuk uji Socket.IO terautentikasi' };
  }
  let ioClient;
  try {
    // eslint-disable-next-line global-require
    ({ io: ioClient } = require('socket.io-client'));
  } catch (err) {
    return { ok: false, detail: `socket.io-client tidak tersedia: ${err.message}` };
  }
  const t0 = Date.now();
  const sock = ioClient(base, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: false,
    forceNew: true,
    timeout: 8000,
  });
  const result = await new Promise((resolve) => {
    const done = (ok, detail) => {
      try { sock.close(); } catch { /* abaikan */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => done(false, 'handshake Socket.IO timeout setelah 8 detik'), 8000);
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true, `handshake Socket.IO terautentikasi terhubung (id=${sock.id}, ${Date.now() - t0}ms)`);
    });
    sock.once('connect_error', (e) => {
      clearTimeout(timer);
      done(false, `handshake Socket.IO gagal: ${e && e.message ? e.message : e}`);
    });
  });
  return { ...result, data: { base, ms: Date.now() - t0, auth: !!token } };
}

/* 4b. Berkas rahasia tidak ikut ter-bundle / ter-commit.
   Di server lokal memakai git ls-files (teliti, termasuk riwayat commit).
   Di serverless (tanpa git) memindai berkas sungguhan di dalam bundel
   lewat fs — ini pemeriksaan nyata atas apa yang benar-benar ikut
   ter-deploy, bukan simulasi. */
async function checkSecrets(ctx) {
  const riskyRe = /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|secret/i;
  const { root } = ctx;
  const hasGit = fs.existsSync(path.join(root, '.git'));

  if (hasGit) {
    const ls = await run('git', ['ls-files'], { cwd: root });
    if (ls.code !== 0) return { ok: false, detail: 'perintah git ls-files gagal dijalankan' };
    const tracked = ls.out.split('\n').map((s) => s.trim()).filter(Boolean);
    const risky = tracked.filter((f) => riskyRe.test(f));
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const guarded = /\.env/.test(gitignore);
    const problems = [];
    if (risky.length) problems.push(`ter-commit: ${risky.join(', ')}`);
    if (!guarded) problems.push('.gitignore belum menutup berkas .env');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' • ') : `${tracked.length} berkas terpantau, tidak ada rahasia yang ter-commit`,
      data: { tracked: tracked.length, risky, guarded, via: 'git' },
    };
  }

  // serverless: pindai bundel deployment lewat fs (nyata, tanpa git)
  const risky = [];
  const scan = (dir, rel = '') => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, relPath);
      else if (riskyRe.test(relPath)) risky.push(relPath);
    }
  };
  scan(root);
  const envFiles = risky.filter((f) => /\.env(\.|$)/.test(f) || f === '.env');
  return {
    ok: risky.length === 0,
    detail: risky.length
      ? `berkas berisiko di bundel: ${risky.slice(0, 5).join(', ')}`
      : `pindai fs bundel: tidak ada .env / kunci / rahasia ikut ter-deploy (${envFiles.length} env ditemukan)`,
    data: { risky, via: 'fs-bundle' },
  };
}

/* 9. Panel admin terproteksi: minimal satu jalur terkunci aktif */
async function checkGuard(ctx) {
  const problems = [];
  const hasKey = !!process.env.ADMIN_KEY;
  const keyLemah = hasKey && String(process.env.ADMIN_KEY).length < 12;
  const emailBawaan = Array.isArray(ctx.adminEmails) ? ctx.adminEmails.filter(Boolean) : [];
  const emailEnv = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  const protectedBySession = emailBawaan.length + emailEnv.length > 0;

  if (!hasKey && !protectedBySession) {
    problems.push('tidak ada ADMIN_KEY maupun daftar email admin — siapkan minimal satu supaya panel terkunci');
  }
  if (keyLemah) problems.push('ADMIN_KEY terlalu pendek (minimal 12 karakter)');

  let admins = 0;
  if (ctx.db) {
    admins = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").catch(() => ({ n: 0 })))?.n || 0);
  }

  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join(' • ')
      : [
          hasKey ? (keyLemah ? 'kunci ADMIN_KEY lemah' : 'kunci ADMIN_KEY aktif') : 'kunci ADMIN_KEY belum diset (opsional)',
          `${emailBawaan.length + emailEnv.length} email admin terdaftar`,
          `${admins} akun role=admin di database`,
        ].join(' • '),
    data: { hasKey, keyLemah, emails: emailBawaan.length + emailEnv.length, admins },
  };
}

/* ============================================================
   PERBAIKAN SATU KLIK
   ============================================================ */

async function fixDb(ctx) {
  const db = ctx.db;
  if (!db) return { ok: false, detail: 'modul database tidak tersedia' };
  const now = Date.now();
  const actions = [];

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

async function fixDeps(ctx) {
  const r = await run('npm', ['install', '--no-audit', '--no-fund'], { timeout: 600_000, cwd: ctx.root });
  if (r.code !== 0) return { ok: false, detail: `npm install gagal: ${(r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' ')}` };
  return { ok: true, detail: 'dependensi dipasang ulang lewat npm install' };
}

async function fixServer(ctx) {
  const appProc = process.env.APP_PROCESS || 'wa-server';
  const hasPm2 = await run('pm2', ['--version'], { timeout: 20_000 });
  if (hasPm2.code === 0) {
    const list = await run('pm2', ['jlist'], { timeout: 30_000 });
    let procs = [];
    try { procs = JSON.parse(list.out); } catch { procs = []; }
    const found = procs.find((p) => p && p.name === appProc);
    const res = found
      ? await run('pm2', ['restart', appProc, '--update-env'], { timeout: 60_000 })
      : await run('pm2', ['start', 'server/index.js', '--name', appProc], { timeout: 60_000 });
    if (res.code !== 0) return { ok: false, detail: `pm2 gagal: ${(res.err || res.out).split('\n').filter(Boolean).slice(-2).join(' ')}` };
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const probe = await fetchJson(`${ctx.base}/`);
      if (probe.ok) return { ok: true, detail: `server aplikasi dijalankan ulang lewat pm2 dan kembali menjawab (percobaan ke-${i + 1})` };
    }
    return { ok: false, detail: 'server dijalankan ulang tetapi belum menjawab setelah 14 detik' };
  }
  return { ok: false, detail: 'pm2 tidak tersedia — jalankan ulang aplikasi secara manual (npm start)' };
}

async function fixSecrets(ctx) {
  const ls = await run('git', ['ls-files'], { cwd: ctx.root });
  const risky = ls.out.split('\n').map((s) => s.trim()).filter((f) => f && /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa/i.test(f));
  const actions = [];
  for (const f of risky) {
    const r = await run('git', ['rm', '--cached', '-q', '--', f], { cwd: ctx.root });
    if (r.code === 0) actions.push(`${f} dilepas dari index git`);
  }
  const giPath = path.join(ctx.root, '.gitignore');
  let gi = fs.readFileSync(giPath, 'utf8');
  if (!/\.env/.test(gi)) {
    gi += (gi.endsWith('\n') ? '' : '\n') + '.env*\n';
    fs.writeFileSync(giPath, gi);
    actions.push('.gitignore diperbarui');
  }
  return { ok: true, detail: actions.length ? actions.join(', ') : 'tidak ada berkas rahasia yang perlu dilepas' };
}

async function fixCallflow(ctx) {
  const a = await fixDb(ctx);
  const b = await fixServer(ctx);
  return { ok: a.ok && b.ok, detail: `perbaikan panggilan — database: ${a.detail} | server: ${b.detail}` };
}

/* ============================================================
   DAFTAR PEMERIKSAAN
   scope: 'semua' = jalan di server lokal & di domain
          'lokal' = butuh berkas sumber / child_process / git
   ============================================================ */

const CHECKS = [
  { id: 'db', label: 'Database & skema', desc: 'koneksi, tabel, kolom panggilan, baris macet', scope: 'semua', run: checkDb, fix: fixDb },
  { id: 'server', label: 'Server aplikasi', desc: 'halaman, manifest, service worker & /api/health menjawab', scope: 'semua', run: checkServer },
  { id: 'static', label: 'Referensi frontend', desc: 'id DOM ganda & $() yang menunjuk id tak ada', scope: 'semua', run: checkStatic },
  { id: 'deps', label: 'Dependensi', desc: 'modul runtime terpasang & bisa dimuat', scope: 'semua', run: checkDeps, fix: fixDeps },
  { id: 'guard', label: 'Panel admin terkunci', desc: 'kunci ADMIN_KEY & daftar email admin', scope: 'semua', run: checkGuard },
  { id: 'syntax', label: 'Sintaks JavaScript', desc: 'parse vm.Script pada seluruh berkas sumber', scope: 'semua', run: checkSyntax },
  { id: 'unit', label: 'Unit test (crop + calls)', desc: 'mesin crop dan mesin panggilan', scope: 'semua', run: checkUnit },
  { id: 'callflow', label: 'Alur panggilan / VC', desc: 'uji nyata Socket.IO: dering, jawab, sinyal, tutup', scope: 'semua', run: checkCallflow, fix: fixCallflow },
  { id: 'secrets', label: 'Berkas rahasia', desc: '.env / kunci tidak ikut ter-bundle / ter-commit', scope: 'semua', run: checkSecrets, fix: fixSecrets },
];

/* ============================================================
   PENJALANAN
   ============================================================ */

async function runOne(item, ctx) {
  if (item.scope === 'lokal' && !ctx.full) {
    return {
      id: item.id,
      label: item.label,
      desc: item.desc,
      state: 'skip',
      ok: true,
      detail: 'butuh akses mesin server (berkas sumber / git / pm2) — jalankan lokal: npm run admin',
      data: null,
      ms: 0,
      fixable: false,
    };
  }
  const t0 = Date.now();
  let res;
  try {
    res = await item.run(ctx);
  } catch (err) {
    res = { ok: false, detail: `pemeriksaan gagal dijalankan: ${err.message}`, data: null };
  }
  return {
    id: item.id,
    label: item.label,
    desc: item.desc,
    state: res.ok ? 'ok' : 'bad',
    ok: !!res.ok,
    detail: res.detail || '',
    data: res.data || null,
    ms: Date.now() - t0,
    fixable: typeof item.fix === 'function',
  };
}

async function runAll(ctx) {
  const started = Date.now();
  // pemeriksaan ringan (database, endpoint, frontend, dependensi) dijalankan
  // bersamaan supaya panel di domain selesai jauh di bawah batas waktu
  // fungsi serverless; pemeriksaan berat berjalan berurutan di server lokal
  const light = CHECKS.filter((i) => i.scope !== 'lokal');
  const rest = CHECKS.filter((i) => i.scope === 'lokal');
  const lightDone = await Promise.all(light.map((item) => runOne(item, ctx)));
  const restDone = [];
  for (const item of rest) restDone.push(await runOne(item, ctx));
  const byId = new Map([...lightDone, ...restDone].map((r) => [r.id, r]));
  const results = CHECKS.map((i) => byId.get(i.id));
  return {
    at: Date.now(),
    ok: results.every((r) => r.state !== 'bad'),
    checks: results,
    duration: Date.now() - started,
    env: {
      full: ctx.full,
      serverless: ctx.serverless,
      base: ctx.base,
      dialect: ctx.db ? ctx.db.dialect : null,
    },
  };
}

async function runFix(ctx) {
  const before = await runAll(ctx);
  const fixes = [];
  for (const item of CHECKS) {
    if (typeof item.fix !== 'function') continue;
    const target = before.checks.find((c) => c.id === item.id);
    if (!target || target.ok || target.state === 'skip') continue;
    const t0 = Date.now();
    let out;
    try { out = await item.fix(ctx); } catch (err) { out = { ok: false, detail: err.message }; }
    fixes.push({ id: item.id, label: item.label, ok: !!out.ok, detail: out.detail || '', ms: Date.now() - t0 });
    if (out.ok) await sleep(300);
  }
  const after = await runAll(ctx);
  return { before, fixes, after, selesai: after.ok };
}

module.exports = { CHECKS, detectEnv, runAll, runFix, fetchJson };
