'use strict';
/* ============================================================
   Konsol Server — lapisan data khusus admin.

   Menyediakan:
   - overview(): statistik proses (uptime, memori), database,
     pengguna, chat, pesan, storage & permintaan HTTP — untuk
     layar pemantauan real-time.
   - storageReport(): rincian pemakaian storage per sumber/tipe,
     konsumen terbesar, dan unggahan terakhir.
   - recordAudit()/auditList(): jejak aksi admin (tabel
     admin_audit) — setiap aksi sensitif dicatat di sini.
   - buildExport(): arsip JSON data akun & storage yang
     dienkripsi AES-256-GCM lewat vault (tampalan RTC1:),
     diverifikasi round-trip sebelum dikirim.

   Semua pemanggilan dari HTTP wajib melewati
   auth.requireAuth + requireAdmin di server/index.js.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const vault = require('./vault');
const settings = require('./settings');

const STARTED_AT = Date.now();
const DATA_DIR = path.join(__dirname, '..', 'data');
const EXPORT_MAX_JSON = 25 * 1024 * 1024; // batas arsip mentah 25 MB
const AUDIT_KEEP = 5000; // jejak audit disimpan paling banyak 5000 baris
const POOL_CAPACITY = 508.21 * 1000 ** 4; // Total pool kapasitas: 508.21 TB
const ONLINE_TTL = 90_000; // sama dengan TTL presence server

// penghitung permintaan HTTP (dipanggil dari middleware di index.js)
let reqTotal = 0;
let reqWindow = 0;
let reqWindowAt = Date.now();
let auditInserts = 0;

function hitRequest() {
  reqTotal += 1;
  const now = Date.now();
  if (now - reqWindowAt >= 60_000) {
    reqWindowAt = now;
    reqWindow = 0;
  }
  reqWindow += 1;
}

// query ringkas: gagal pun tidak boleh meruntuhkan layar monitoring
async function one(sql, ...args) {
  try {
    return (await db.get(sql, ...args)) || {};
  } catch (err) {
    console.error('console query:', err.message);
    return {};
  }
}

async function all(sql, ...args) {
  try {
    return (await db.all(sql, ...args)) || [];
  } catch (err) {
    console.error('console query:', err.message);
    return [];
  }
}

function n(v) {
  const out = Number(v);
  return Number.isFinite(out) ? out : 0;
}

// info enkripsi untuk layar keamanan; tidak boleh ikut menjatuhkan overview
function vaultInfo() {
  try {
    return vault.info();
  } catch {
    return { algo: 'aes-256-gcm', keySource: 'unavailable' };
  }
}

function dbSizeBytes() {
  if (db.dialect === 'sqlite') {
    let total = 0;
    for (const name of ['whatsap.db', 'whatsap.db-wal', 'whatsap.db-shm']) {
      try {
        total += fs.statSync(path.join(DATA_DIR, name)).size;
      } catch { /* berkas belum ada */ }
    }
    return total;
  }
  return null; // pg: dihitung terpisah (butuh hak pg_database_size)
}

// ---------- statistik utama ----------
async function overview(opts = {}) {
  const now = Date.now();
  const [u, chatRow, msgRow, savedRow, dbFileRow, presenceRow, loginRow, regRow] =
    await Promise.all([
      one(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN account_status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN account_status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN account_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN banned = 1 THEN 1 ELSE 0 END) AS banned,
                SUM(CASE WHEN premium_until > ? THEN 1 ELSE 0 END) AS premium,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin,
                SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS new24h,
                SUM(CASE WHEN last_login_at > ? THEN 1 ELSE 0 END) AS login24h,
                COALESCE(SUM(storage_used), 0) AS storage_used
           FROM users`,
        now, now - 86_400_000, now - 86_400_000
      ),
      one(`SELECT COUNT(*) AS total FROM chats`),
      one(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
                COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN media_size ELSE 0 END), 0) AS media_bytes
           FROM messages`
      ),
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(media_size), 0) AS bytes FROM saved_files`),
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM db_files WHERE complete = 1`),
      one(`SELECT COUNT(DISTINCT user_id) AS online FROM presence WHERE at > ?`, now - ONLINE_TTL),
      one(`SELECT COUNT(*) AS n FROM login_logs WHERE at > ? AND result = 'success'`, now - 86_400_000),
      one(`SELECT COUNT(*) AS n FROM reg_logs WHERE at > ? AND ok = 1`, now - 86_400_000),
    ]);

  let dbBytes = dbSizeBytes();
  if (dbBytes === null && db.dialect === 'pg') {
    try {
      const row = await db.get('SELECT pg_database_size(current_database()) AS size');
      dbBytes = n(row && row.size);
    } catch { /* izin tidak tersedia -> biarkan nol */ }
  }

  const mem = process.memoryUsage();
  return {
    at: now,
    startedAt: STARTED_AT,
    uptimeMs: Math.max(0, Date.now() - STARTED_AT),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    dialect: db.dialect,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    dbBytes: dbBytes || 0,
    sockets: n(opts.sockets),
    users: {
      total: n(u.total),
      active: n(u.active),
      pending: n(u.pending),
      rejected: n(u.rejected),
      banned: n(u.banned),
      premium: n(u.premium),
      admin: n(u.admin),
      new24h: n(u.new24h),
      login24h: n(u.login24h),
      online: n(presenceRow.online),
      storageUsed: n(u.storage_used),
    },
    chats: n(chatRow.total),
    messages: {
      total: n(msgRow.total),
      live: n(msgRow.live),
      mediaBytes: n(msgRow.media_bytes),
    },
    files: {
      drawerCount: n(savedRow.total),
      drawerBytes: n(savedRow.bytes),
      dbCount: n(dbFileRow.total),
      dbBytes: n(dbFileRow.bytes),
    },
    logins24h: n(loginRow.n),
    registers24h: n(regRow.n),
    requests: { total: reqTotal, perMin: reqWindow },
    vault: vaultInfo(), // { algo, keySource } — tanpa kunci sensitif
  };
}

// total kapasitas kuota seluruh pengguna aktif (dilarang diblokir & berstatus
// aktif): premium memakai storageLimit paketnya, sisanya kuota gratis.
// Akun admin tidak dijumlahkan — kuotanya tanpa batas.
function capacityOf(activeRows, planById) {
  let bytes = 0;
  let premium = 0;
  let free = 0;
  let unlimited = 0;
  const now = Date.now();
  for (const u of activeRows) {
    if (u.role === 'admin') {
      unlimited += 1;
      continue;
    }
    const active = n(u.premium_until) > now;
    const plan = active && u.premium_plan ? planById.get(u.premium_plan) : null;
    if (plan && Number(plan.storageLimit) > 0) {
      bytes += Number(plan.storageLimit);
      premium += 1;
    } else {
      bytes += settings.FREE_STORAGE;
      free += 1;
    }
  }
  return { bytes, poolCapacity: POOL_CAPACITY, accounts: premium + free, premium, free, unlimited };
}

// ---------- rincian storage ----------
async function storageReport() {
  const plans = await settings.getPlans().catch(() => []);
  const planById = new Map(plans.map((p) => [p.id, p]));

  const [totals, byType, topRows, recentRows, activeRows] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(storage_used), 0) AS accounted,
              COUNT(*) AS users
         FROM users`
    ),
    all(
      `SELECT type, COUNT(*) AS n, COALESCE(SUM(media_size), 0) AS bytes
         FROM messages
        WHERE deleted_at IS NULL AND media_size IS NOT NULL AND media_size > 0
        GROUP BY type
        ORDER BY bytes DESC`
    ),
    all(
      `SELECT id, name, email, role, account_status, banned, premium_plan,
              premium_until, storage_used, last_login_at
         FROM users
        ORDER BY storage_used DESC
        LIMIT 12`
    ),
    all(
      `SELECT s.created_at, s.media_name, s.media_size, s.type, s.mime, u.name AS user_name
         FROM saved_files s
         JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        LIMIT 10`
    ),
    all(
      `SELECT role, premium_plan, premium_until
         FROM users
        WHERE banned = 0 AND account_status = 'active'`
    ),
  ]);

  const [chatMsg, saved, dbFiles] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(media_size), 0) AS bytes
         FROM messages WHERE deleted_at IS NULL AND media_size > 0`
    ),
    one(`SELECT COUNT(*) AS n, COALESCE(SUM(media_size), 0) AS bytes FROM saved_files`),
    one(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM db_files WHERE complete = 1`),
  ]);

  const topUsers = topRows.map((r) => {
    const plan = r.premium_plan ? planById.get(r.premium_plan) : null;
    const quota =
      r.role === 'admin'
        ? null
        : plan && Number(plan.storageLimit) > 0
          ? Number(plan.storageLimit)
          : settings.FREE_STORAGE;
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.banned ? 'banned' : r.account_status,
      plan: r.premium_plan || null,
      used: n(r.storage_used),
      quota,
      lastLoginAt: n(r.last_login_at),
    };
  });

  return {
    at: Date.now(),
    capacity: capacityOf(activeRows, planById),
    totals: {
      accounted: n(totals.accounted), // total storage_used seluruh pengguna
      chatMediaBytes: n(chatMsg.bytes),
      drawerBytes: n(saved.bytes),
      drawerCount: n(saved.n),
      dbFileBytes: n(dbFiles.bytes),
      dbFileCount: n(dbFiles.n),
    },
    byType: byType.map((r) => ({ type: r.type, count: n(r.n), bytes: n(r.bytes) })),
    topUsers,
    recentUploads: recentRows.map((r) => ({
      at: n(r.created_at),
      name: r.media_name || '-',
      bytes: n(r.media_size),
      type: r.type,
      mime: r.mime,
      user: r.user_name,
    })),
  };
}

// ---------- jejak aksi admin ----------
async function recordAudit(actor, action, target, detail) {
  try {
    const entry = {
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      adminId: actor && actor.id ? String(actor.id) : null,
      adminName: actor && actor.name ? String(actor.name).slice(0, 80) : null,
      action: String(action || 'unknown').slice(0, 40),
      target: target ? String(target).slice(0, 160) : null,
      detail: detail ? String(detail).slice(0, 300) : null,
      at: Date.now(),
    };
    await db.run(
      `INSERT INTO admin_audit (id, admin_id, admin_name, action, target, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry.id, entry.adminId, entry.adminName, entry.action, entry.target, entry.detail, entry.at
    );
    // potong agar tabel tidak tumbuh tanpa batas
    auditInserts += 1;
    if (auditInserts % 50 === 0) {
      const offsetSql =
        db.dialect === 'pg'
          ? `SELECT id FROM admin_audit ORDER BY at DESC LIMIT ALL OFFSET ?`
          : `SELECT id FROM admin_audit ORDER BY at DESC LIMIT -1 OFFSET ?`;
      await db.run(`DELETE FROM admin_audit WHERE id IN (${offsetSql})`, AUDIT_KEEP).catch(
        () => undefined
      );
    }
    return entry;
  } catch (err) {
    console.error('console audit:', err.message);
    return null;
  }
}

async function auditList(limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const rows = await all(
    `SELECT id, admin_id, admin_name, action, target, detail, at
       FROM admin_audit ORDER BY at DESC, id DESC LIMIT ?`,
    cap
  );
  return rows.map((r) => ({
    id: r.id,
    adminId: r.admin_id,
    adminName: r.admin_name,
    action: r.action,
    target: r.target,
    detail: r.detail,
    at: n(r.at),
  }));
}

// ---------- arsip ekspor terenkripsi ----------
async function buildExport() {
  const now = Date.now();
  const users = await all(
    `SELECT id, email, name, role, account_status, banned, banned_reason, verified,
            premium_plan, premium_until, storage_used, bot_tokens, invite_count,
            created_at, last_login_at, last_ip, last_device
       FROM users ORDER BY created_at LIMIT 100000`
  );
  const payload = {
    v: 1,
    product: 'RTC-Core',
    generatedAt: new Date(now).toISOString(),
    counts: { users: users.length },
    users,
    storage: await storageReport(),
    audit: await auditList(200),
  };
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json);
  if (bytes > EXPORT_MAX_JSON) return { oversize: true, bytes };

  const cipher = vault.encrypt(json);
  const verified = vault.decrypt(cipher) === json; // round-trip sebelum diserahkan
  return {
    oversize: false,
    filename: `rtc-core-export-${new Date(now).toISOString().slice(0, 10)}.rtcenc`,
    algo: vaultInfo().algo,
    bytes,
    cipherBytes: Buffer.byteLength(cipher),
    verified,
    data: cipher,
  };
}

module.exports = {
  STARTED_AT,
  hitRequest,
  overview,
  storageReport,
  recordAudit,
  auditList,
  buildExport,
};
