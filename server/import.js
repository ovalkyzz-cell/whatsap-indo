'use strict';
/* ============================================================
   Impor arsip chat lama (khusus admin)
   ------------------------------------------------------------
   Dipakai scripts/migrate.js untuk memulihkan chat dari basis data
   SQLite lama ke produksi. Dua tanggung jawab:
   - /rows : menerima batch baris tabel chat, menyimpannya idempoten
     (ON CONFLICT DO NOTHING sesuai primary key) dan mengenkripsi
     kolom rahasia (body pesan dsb) dengan vault milik server ini,
     sehingga data lama ikut terlindungi at-rest seperti data baru.
   - /ping : pemeriksaan awal — memberi tahu sumber kunci vault bila
     kunci ternyata volatil (bisa dipakai klien untuk jatuh ke mode
     plaintext daripada menghasilkan baris yang tak terbaca).
   Audit setiap batch dicatat di admin_audit.
   ============================================================ */

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const vault = require('./vault');
const serverConsole = require('./console');

const router = express.Router();

const MAX_ROWS = 400;

// tabel yang boleh diimpor + primary key untuk ON CONFLICT
const ALLOWED = {
  users: ['id'],
  chats: ['id'],
  chat_members: ['chat_id', 'user_id'],
  messages: ['id'],
  message_status: ['message_id', 'user_id'],
  statuses: ['id'],
  status_comments: ['id'],
  status_tags: ['status_id', 'user_id'],
  saved_files: ['id'],
  calls: ['id'],
};

// kolom yang wajib disimpan terenkripsi (sama dengan jalur kirim pesan)
const SEAL = {
  messages: ['body', 'reply_preview'],
  statuses: ['body'],
  status_comments: ['body'],
};

function requireAdmin(req, res, next) {
  if (!auth.isAdmin(req.user)) return res.status(403).json({ error: 'Hanya admin yang diizinkan' });
  next();
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const colCache = new Map();
async function tableColumns(table) {
  if (colCache.has(table)) return colCache.get(table);
  let cols;
  if (db.dialect === 'pg') {
    const rows = await db.all(
      'SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position',
      table
    );
    cols = rows.map((r) => r.name);
  } else {
    const rows = await db.all(`PRAGMA table_info("${table}")`);
    cols = rows.map((r) => r.name);
  }
  colCache.set(table, cols);
  return cols;
}

router.get('/ping', auth.requireAuth, requireAdmin, ah(async (_req, res) => {
  const info = vault.info();
  res.json({ ok: true, keySource: info.keySource, algo: info.algo, dialect: db.dialect });
}));

router.post('/rows', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const table = String(req.body?.table || '');
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, table)) {
    return res.status(400).json({ error: 'Tabel tidak diizinkan' });
  }
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) {
    return res.status(400).json({ error: `rows harus berupa array berisi 1-${MAX_ROWS} baris` });
  }

  const pk = ALLOWED[table];
  const cols = await tableColumns(table);
  const colSet = new Set(cols);
  for (const c of pk) {
    if (!colSet.has(c)) return res.status(500).json({ error: `kolom kunci ${c} tidak ada di tabel ${table}` });
  }

  const requested = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') return res.status(400).json({ error: 'setiap baris harus objek' });
    for (const k of Object.keys(r)) requested.add(k);
  }
  const fields = cols.filter((c) => requested.has(c));
  const omitted = [...requested].filter((c) => !colSet.has(c));
  if (!fields.length) return res.status(400).json({ error: 'Tidak ada kolom yang cocok dengan skema' });

  const info = vault.info();
  const volatileKey = info.keySource === 'volatile';
  const seal = SEAL[table] || [];

  const sql =
    `INSERT INTO ${table} (${fields.join(', ')}) ` +
    `VALUES (${fields.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${pk.join(', ')}) DO NOTHING`;

  let inserted = 0;
  let skipped = 0;
  const failures = [];
  let sampleId = null;

  for (let i = 0; i < rows.length && failures.length < 20; i++) {
    const r = rows[i];
    const vals = fields.map((f) => {
      let v = r[f];
      if (v === undefined) v = null;
      if (seal.includes(f) && v !== null && v !== '' && typeof v === 'string' && !vault.isEncrypted(v)) {
        // kunci volatil (proses serverless) TIDAK dipakai: menyimpan
        // plaintext lebih baik daripada ciphertext yang tak terbaca
        v = volatileKey ? v : vault.encrypt(v);
      }
      return v;
    });
    try {
      const out = await db.run(sql, ...vals);
      if (out && out.changes) {
        inserted += 1;
        if (table === 'messages' && sampleId === null) sampleId = r.id;
      } else {
        skipped += 1;
      }
    } catch (err) {
      failures.push({ i, error: String(err.message || err).slice(0, 140) });
    }
  }

  // bukti terdekripsi: baris pesan pertama yang masuk dibaca kembali oleh
  // server ini sendiri — memastikan data ter-impor benar-benar terbaca
  let sample = null;
  if (table === 'messages' && sampleId) {
    try {
      const row = await db.get('SELECT body FROM messages WHERE id = ?', sampleId);
      const body = row ? vault.decrypt(row.body) : null;
      sample = { id: sampleId, readable: body !== null && body !== '', preview: String(body || '').slice(0, 120) };
    } catch { /* sampel bersifat opsional */ }
  }

  try {
    await serverConsole.recordAudit(
      { id: req.user.id, name: req.user.name },
      'import',
      table,
      `${inserted} baris masuk, ${skipped} dilewati, ${failures.length} gagal (kunci vault: ${info.keySource})`
    );
  } catch { /* audit tidak boleh menjatuhkan impor */ }

  res.json({
    ok: true,
    table,
    received: rows.length,
    inserted,
    skipped,
    failures,
    omitted,
    keySource: info.keySource,
    storedEncrypted: !volatileKey,
    sample,
  });
}));

module.exports = router;
