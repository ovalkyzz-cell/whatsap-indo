'use strict';
/* ============================================================
   Migrasi arsip chat lama SQLite -> produksi
   ------------------------------------------------------------
   Memulihkan chat (tabel, media, URL) dari basis data SQLite lokal
   ke produksi lewat dua jalur resmi aplikasi:
   - baris tabel : POST /api/admin/import/rows (dienkripsi vault di server)
   - media       : POST /api/storage/dbfiles/{init,chunk,complete}
                   (alur unggah berpotongan yang sama dengan klien asli,
                    di produksi otomatis tersimpan ke GitHub Releases)
   lalu memutar URL /uploads/<file> menjadi /api/storage/dbfiles/<id>
   dan menghitung ulang kuota storage.

   Pemakaian:
     node scripts/migrate.js --email <admin-import> --pass <password> \
       [--base https://whatsap-indo.vercel.app] \
       [--env-file /tmp/bridge.env] \
       [--source data/whatsap.db] \
       [--state /tmp/opencode/migrate-state.json] \
       [--skip-media] [--skip-rows] [--verify sample|all|none]

   Sumber kebenaran tujuan (DATABASE_URL) diambil dari --env-file bila
   variabel DATABASE_URL tidak di-set. Skrip ini idempoten: batch yang
   sudah tercatat di --state tidak diulang.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

// ---------- argumen ----------
function parseArgs(argv) {
  const out = { base: 'https://whatsap-indo.vercel.app', source: path.join(__dirname, '..', 'data', 'whatsap.db'),
    uploads: path.join(__dirname, '..', 'uploads'),
    state: '/tmp/opencode/migrate-state.json', verify: 'sample', envFile: '', email: '', pass: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') out.base = next();
    else if (a === '--source') out.source = next();
    else if (a === '--uploads') out.uploads = next();
    else if (a === '--state') out.state = next();
    else if (a === '--env-file') out.envFile = next();
    else if (a === '--email') out.email = next();
    else if (a === '--pass') out.pass = next();
    else if (a === '--verify') out.verify = next();
    else if (a === '--media-limit') out.mediaLimit = Number(next());
    else if (a === '--skip-media') out.skipMedia = true;
    else if (a === '--skip-rows') out.skipRows = true;
    else if (a === '--only') out.only = next();
  }
  return out;
}
const ARGS = parseArgs(process.argv);
if (!ARGS.email || !ARGS.pass) {
  console.error('wajib: --email dan --pass (akun admin untuk impor)');
  process.exit(2);
}

// ---------- state (resumable) ----------
let STATE = { media: {}, rows: {} };
try { STATE = Object.assign(STATE, JSON.parse(fs.readFileSync(ARGS.state, 'utf8'))); } catch { /* baru */ }
const saveState = () => fs.writeFileSync(ARGS.state, JSON.stringify(STATE, null, 1));

// ---------- util ----------
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (i < tries - 1) await sleep(1000 * Math.pow(3, i));
    }
  }
  throw new Error(`${label}: ${last && last.message}`);
}

let TOKEN = '';
async function api(p, opts = {}) {
  const res = await fetch(ARGS.base + p, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.raw ? opts.body : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------- database sumber (SQLite) & tujuan (Postgres) ----------
const sqlite = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))(ARGS.source, { readonly: true, fileMustExist: true });
const vault = require(path.join(__dirname, '..', 'server', 'vault'));

function pgUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (ARGS.envFile) {
    const txt = fs.readFileSync(ARGS.envFile, 'utf8');
    const line = txt.split('\n').find((l) => l.startsWith('DATABASE_URL_UNPOOLED=') || l.startsWith('DATABASE_URL='));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL tidak tersedia (pakai env atau --env-file)');
}

let pg = null; // koneksi PG dibuat lazis (bila fase baris/rewrite jalan)
function newPg() {
  const c = new Client({ connectionString: pgUrl() });
  // koneksi idle lama bisa diputus server -> jangan biarkan jadi unhandled error
  c.on('error', (e) => log('pg: koneksi error (akan disambung ulang):', String(e.message).slice(0, 80)));
  return c;
}
async function pgQ(sql, params) {
  if (!pg) { pg = newPg(); await pg.connect(); }
  try {
    return await pg.query(sql, params);
  } catch (e) {
    log('pg: query gagal, sambung ulang:', String(e.message).slice(0, 80));
    try { await pg.end(); } catch { /* koneksi mungkin sudah mati */ }
    pg = newPg();
    await pg.connect();
    return await pg.query(sql, params);
  }
}

const TEXT_TABLES = ['users', 'chats', 'messages', 'statuses', 'status_comments', 'saved_files'];
const REMAP = {
  users: ['referred_by'],
  chats: ['created_by'],
  chat_members: ['user_id'],
  messages: ['sender_id', 'opened_by'],
  message_status: ['user_id'],
  statuses: ['user_id'],
  status_comments: ['user_id'],
  status_tags: ['user_id'],
  saved_files: ['user_id'],
  calls: ['caller_id', 'callee_id'],
};
const SEAL = { messages: ['body', 'reply_preview'], statuses: ['body'], status_comments: ['body'] };
const ORDER = ['users', 'chats', 'chat_members', 'messages', 'message_status', 'statuses', 'status_comments', 'status_tags', 'saved_files', 'calls'];

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.bin': 'application/octet-stream' };

function scanUploadRefs() {
  const refs = new Set();
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of tables) {
    if (t === 'sqlite_sequence') continue;
    const cols = sqlite.prepare(`PRAGMA table_info("${t}")`).all();
    for (const c of cols) {
      let rows;
      try { rows = sqlite.prepare(`SELECT "${c.name}" AS v FROM "${t}" WHERE "${c.name}" LIKE '%/uploads/%'`).all(); } catch { continue; }
      for (const r of rows) {
        if (typeof r.v !== 'string') continue;
        for (const m of r.v.matchAll(/\/uploads\/([\w.\-]+)/g)) refs.add(m[1]);
      }
    }
  }
  return refs;
}

// ---------- 1. media ----------
async function uploadMedia(dir, filenames) {
  const map = {};
  let done = 0, skipped = 0;
  const failed = [], missing = [];
  const list = [...filenames].sort();
  for (const name of list) {
    if (ARGS.mediaLimit && done >= ARGS.mediaLimit) { log('batas --media-limit tercapai'); break; }
    if (STATE.media[name] && STATE.media[name].url) { map[name] = STATE.media[name].url; skipped++; continue; }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    const buf = fs.readFileSync(file);
    const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    try {
      const init = await withRetry(() => api('/api/storage/dbfiles/init', { method: 'POST', body: { name, size: buf.length, mime } }), `init ${name}`);
      if (init.status !== 201 || !init.data.id) throw new Error(`init ${init.status} ${JSON.stringify(init.data).slice(0, 120)}`);
      const { id, chunkSize, totalChunks } = init.data;
      for (let i = 0; i < totalChunks; i++) {
        const slice = buf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buf.length));
        await withRetry(async () => {
          const r = await api(`/api/storage/dbfiles/${id}/chunk/${i}`, { method: 'PUT', raw: true, body: slice });
          if (r.status === 409) return; // sudah selesai sebelumnya
          if (r.status !== 200) throw new Error(`chunk ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
          return r;
        }, `chunk ${name}#${i}`);
      }
      const end = await withRetry(() => api(`/api/storage/dbfiles/${id}/complete`, { method: 'POST', body: {} }), `complete ${name}`);
      if (end.status !== 200 || !end.data.url) throw new Error(`complete ${end.status} ${JSON.stringify(end.data).slice(0, 120)}`);
      STATE.media[name] = { url: end.data.url, size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex'), dedup: !!end.data.dedup };
      saveState();
      map[name] = end.data.url;
      done++;
      if (done % 10 === 0) log(`media: ${done + skipped}/${list.length} (${(buf.length / 1e6).toFixed(1)} MB terakhir)`);
    } catch (err) {
      failed.push({ name, error: err.message });
      log('GAGAL media', name, '-', err.message);
    }
  }
  if (missing.length) log(`hilang di disk (dilewati): ${missing.length} berkas — contoh: ${missing.slice(0, 3).join(', ')}`);
  log(`media selesai: ${done} baru, ${skipped} dari state, ${missing.length} hilang, ${failed.length} gagal`);
  return { map, failed, missing };
}

// ---------- 2. baris ----------
async function importRows(idMap, skipIds) {
  const skip = skipIds || new Set();
  const summary = {};
  for (const table of ORDER) {
    if (ARGS.only && ARGS.only !== table) continue;
    if (STATE.rows[table] && STATE.rows[table].done) { log('rows (state):', table, 'sudah selesai'); continue; }
    const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
    const pgCols = (await pgQ(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
    )).rows.map((r) => r.column_name);
    const fields = cols.filter((c) => pgCols.includes(c));
    const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    log(`rows ${table}: ${total} baris (${fields.length}/${cols.length} kolom dipakai)`);

    let inserted = 0, skipped = 0, failed = 0;
    const flushOne = async (rows) => {
      const r = await withRetry(() => api('/api/admin/import/rows', { method: 'POST', body: { table, rows } }), `rows ${table}`);
      if (r.status !== 200 || !r.data.ok) throw new Error(`rows ${table} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      inserted += r.data.inserted; skipped += r.data.skipped; failed += r.data.failures.length;
      if (r.data.sample) log('  sampel terdekripsi:', JSON.stringify(r.data.sample));
      if (r.data.keySource === 'volatile') log('  PERINGATAN: kunci vault volatil — body tersimpan plaintext');
    };

    let batch = [];
    const flush = async () => {
      while (batch.length) {
        let take = batch.splice(0, 300);
        while (JSON.stringify({ table, rows: take }).length > 900_000 && take.length > 1) {
          const half = Math.ceil(take.length / 2);
          const head = take.slice(0, half);
          take = take.slice(half);
          await flushOne(head);
        }
        await flushOne(take);
      }
    };

    for (let off = 0; off < total; off += 300) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}" LIMIT 300 OFFSET ?`).all(off);
      for (const raw of rows) {
        if (table === 'users' && skip.has(raw.id)) continue;
        const row = {};
        for (const f of fields) {
          let v = raw[f];
          if (SEAL[table] && SEAL[table].includes(f) && typeof v === 'string') v = vault.decrypt(v); // enkripsi ulang di server
          if (REMAPPABLE(table, f) && typeof v === 'string' && idMap[v]) v = idMap[v];
          row[f] = v === undefined ? null : v;
        }
        batch.push(row);
        if (JSON.stringify({ table, rows: batch }).length > 850_000) {
          await flush();
        }
      }
      await flush();
    }
    await flush();
    STATE.rows[table] = { done: failed === 0, inserted, skipped, failed };
    saveState();
    summary[table] = { total, inserted, skipped, failed };
    log(`  -> masuk ${inserted}, dilewati ${skipped}, gagal ${failed}`);
  }
  return summary;
}
function REMAPPABLE(table, field) {
  return Array.isArray(REMAP[table]) && REMAP[table].includes(field);
}

// ---------- 3. putar URL media ----------
async function rewriteUrls(map) {
  const entries = Object.entries(map);
  if (!entries.length) { log('rewrite: tidak ada peta media'); return 0; }
  let changed = 0;
  for (const table of TEXT_TABLES) {
    const cols = (await pgQ(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND data_type IN ($2,$3)', [table, 'text', 'character varying']
    )).rows.map((r) => r.column_name);
    for (const col of cols) {
      const has = await pgQ(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} LIKE '%/uploads/%'`);
      if (!has.rows[0].n) continue;
      for (const [name, url] of entries) {
        const r = await pgQ(
          `UPDATE ${table} SET ${col} = REPLACE(${col}, $1, $2) WHERE ${col} LIKE $1`,
          [`/uploads/${name}`, url]
        );
        changed += r.rowCount;
      }
      log(`rewrite ${table}.${col}: selesai`);
    }
  }
  return changed;
}

// ---------- 4. verifikasi ----------
async function verifyMedia(map, mode) {
  if (mode === 'none') return { checked: 0, bad: [] };
  const entries = Object.entries(map);
  let targets = entries;
  if (mode === 'sample') {
    const small = entries.filter(([n]) => (STATE.media[n] || {}).size <= 2 * 1024 * 1024);
    const big = entries.filter(([n]) => (STATE.media[n] || {}).size > 2 * 1024 * 1024);
    targets = small.concat(big.filter((_, i) => i % 15 === 0));
  }
  const bad = [];
  let checked = 0;
  for (const [name, url] of targets) {
    const meta = STATE.media[name] || {};
    try {
      const res = await fetch(ARGS.base + url, { headers: { Range: 'bytes=0-0' } });
      if (![200, 206].includes(res.status)) { bad.push({ name, error: `HTTP ${res.status}` }); continue; }
      if (res.status === 206) {
        const cr = res.headers.get('content-range') || '';
        const total = Number(cr.split('/')[1]);
        if (meta.size && total !== meta.size) { bad.push({ name, error: `ukuran ${total} != ${meta.size}` }); continue; }
        await res.arrayBuffer();
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (meta.size && buf.length !== meta.size) { bad.push({ name, error: `ukuran ${buf.length} != ${meta.size}` }); continue; }
        if (meta.sha && buf.length <= 2 * 1024 * 1024) {
          const sha = crypto.createHash('sha256').update(buf).digest('hex');
          if (sha !== meta.sha) { bad.push({ name, error: 'sha256 beda' }); continue; }
        }
      }
      checked++;
    } catch (err) { bad.push({ name, error: err.message }); }
  }
  log(`verifikasi media: ${checked} ok, ${bad.length} bermasalah`);
  return { checked, bad };
}

// ---------- utama ----------
(async () => {
  log('== migrasi arsip chat lama -> produksi ==');
  log('sumber :', ARGS.source);
  log('tujuan :', ARGS.base);

  // login admin impor
  const lg = await withRetry(() => api('/api/auth/login', { method: 'POST', body: { email: ARGS.email, password: ARGS.pass } }), 'login');
  if (!lg.data || !lg.data.token) {
    console.error('LOGIN GAGAL:', lg.status, JSON.stringify(lg.data).slice(0, 200));
    process.exit(1);
  }
  TOKEN = lg.data.token;
  log('login ok (admin impor)');

  const ping = await api('/api/admin/import/ping');
  log('vault:', JSON.stringify(ping.data));
  if (ping.status !== 200) { console.error('ping gagal — endpoint impor tidak tersedia?', ping.status); process.exit(1); }

  const report = { startedAt: new Date().toISOString(), base: ARGS.base };

  // media
  if (!ARGS.skipMedia) {
    const refs = scanUploadRefs();
    log(`referensi /uploads/ unik di SQLite: ${refs.size}`);
    const { map, failed, missing } = await uploadMedia(ARGS.uploads, refs);
    report.media = { total: refs.size, mapped: Object.keys(map).length, missing: missing.length, failed };
    report.mediaMap = map;
    report.verify = await verifyMedia(map, ARGS.verify);
  }

  // baris
  if (!ARGS.skipRows) {
    const prodUsers = (await pgQ('SELECT id, email FROM users')).rows;
    const prodByEmail = new Map(prodUsers.map((u) => [String(u.email).toLowerCase(), u.id]));
    const localUsers = sqlite.prepare('SELECT id, email FROM users').all();
    const idMap = {};
    const skipIds = new Set();
    let conflicts = 0, fresh = 0;
    for (const u of localUsers) {
      const hit = prodByEmail.get(String(u.email).toLowerCase());
      if (hit) {
        if (hit !== u.id) idMap[u.id] = hit;
        skipIds.add(u.id);
        conflicts++;
      } else fresh++;
    }
    log(`users: ${conflicts} sudah ada di produksi (dilewati, id lama dipetakan bila perlu), ${fresh} akun baru`);
    report.rows = await importRows(idMap, skipIds);
    report.userRemap = { conflicts, fresh };
  }

  // putar URL
  if (report.mediaMap && !ARGS.skipRows) {
    report.rewritten = await rewriteUrls(report.mediaMap);
    log('total baris di-update URL:', report.rewritten);
  } else if (report.mediaMap) {
    log('rewrite dilewati (mode tanpa PG)');
  }

  // hitung ulang kuota
  const rec = await api('/api/admin/storage/recompute', { method: 'POST', body: {} });
  log('recompute kuota:', rec.status, JSON.stringify(rec.data));

  // perbandingan akhir
  report.finalCounts = {};
  if (!ARGS.skipRows) {
    for (const t of ORDER) {
      const src = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const dst = (await pgQ(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
      report.finalCounts[t] = { source: src, prod: dst };
    }
  }
  report.finishedAt = new Date().toISOString();
  console.log('\n=== RINGKASAN ===');
  console.log(JSON.stringify(report, null, 1).slice(0, 4000));
  fs.writeFileSync('/tmp/opencode/migrate-report.json', JSON.stringify(report, null, 1));
  log('laporan lengkap: /tmp/opencode/migrate-report.json');

  if (pg) { try { await pg.end(); } catch { /* koneksi mungkin sudah mati */ } }
  sqlite.close();
})().catch((err) => {
  console.error('MIGRASI GAGAL:', err);
  process.exit(1);
});
