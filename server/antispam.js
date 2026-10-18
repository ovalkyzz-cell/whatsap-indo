'use strict';

/* ============================================================
   ANTI-SPAM PENDAFTARAN
   ------------------------------------------------------------
   Aturan yang berlaku:

   1. Satu email hanya boleh mendaftar sekali (users.email UNIQUE).
   2. Satu IP maksimal 1 pendaftaran sukses per 24 jam. Percobaan
      berikutnya dari IP yang sama dianggap spam -> IP diblokir
      OTOMATIS dan permanen sampai admin membukanya.
   3. IP dengan percobaan gagal berulang (>= failLimit dalam 10
      menit) juga diblokir otomatis.
   4. Blokir HANYA menahan pendaftaran; masuk (login) dengan akun
      lama tetap diizinkan.
   5. IP loopback (server lokal / suite test) tidak dibatasi
      supaya lingkungan pengembangan tidak mengunci dirinya sendiri.
   6. Saat admin membuka blokir, kuota pendaftaran IP ikut direset
      supaya blokir benar-benar terbuka (bukan langsung kena lagi).
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEDGER_TTL = 30 * DAY; // ledger percobaan lama dibersihkan berkala

const DEFAULT_RULES = {
  perIp: 1, // pendaftaran sukses yang diizinkan per IP dalam 24 jam
  windowMs: DAY,
  failLimit: 10, // percobaan gagal per IP sebelum diblokir
  failWindowMs: 10 * MINUTE,
};

const BLOCKED_MSG =
  'IP ini diblokir karena aktivitas pendaftaran melanggar aturan. Hubungi admin untuk membuka blokir.';

let notify = null;
let lastPrune = 0;

// panel admin: server mendaftarkan pemberitahuan saat IP diblokir otomatis
function setNotify(fn) {
  notify = typeof fn === 'function' ? fn : null;
}

function normalizeIp(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  s = s.replace(/^\[/, '').replace(/\]$/, '');
  const withPort = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/); // 1.2.3.4:5678
  if (withPort) s = withPort[1];
  if (s.startsWith('::ffff:')) s = s.slice(7); // IPv4-mapped IPv6
  return s.slice(0, 60);
}

function isLoopback(ip) {
  const s = String(ip || '');
  return !s || s === '::1' || s === '::' || s === '0.0.0.0' || s === '127.0.0.1' || s.startsWith('127.');
}

function blockedError(message) {
  const err = new Error(message || BLOCKED_MSG);
  err.status = 403;
  err.code = 'ip_diblokir';
  return err;
}

// ganti {nama}/{name} dengan nama pendaftar (fallback: Pengguna)
function fillName(text, name) {
  const who = String(name || '').trim().slice(0, 60) || 'Pengguna';
  return String(text).replace(/\{nama\}|\{name\}/gi, who);
}

// pesan blokir bisa disunting admin (kunci settings `reg_text.blocked`);
// kosong/tak terbaca -> pakai pesan bawaan. Selalu ada {nama} yang terisi.
async function blockMessage(fallback, name) {
  let custom = '';
  try {
    const saved = await settings.getRegText();
    custom = saved ? saved.blocked : '';
  } catch { /* settings belum siap -> pesan bawaan */ }
  return fillName(custom || fallback, name);
}

// ambang batas bisa diubah lewat tabel settings (kunci `antispam`)
async function rules() {
  const out = { ...DEFAULT_RULES };
  let saved = null;
  try {
    saved = await settings.get('antispam', null);
  } catch { /* settings belum siap -> pakai bawaan */ }
  if (saved && typeof saved === 'object') {
    const perIp = Math.round(Number(saved.perIp));
    if (Number.isFinite(perIp) && perIp >= 1 && perIp <= 1000) out.perIp = perIp;
    const failLimit = Math.round(Number(saved.failLimit));
    if (Number.isFinite(failLimit) && failLimit >= 3 && failLimit <= 10000) out.failLimit = failLimit;
  }
  return out;
}

async function isBanned(ip) {
  const norm = normalizeIp(ip);
  if (isLoopback(norm)) return null;
  const row = await db.get('SELECT * FROM ip_bans WHERE ip = ?', norm);
  return row || null;
}

async function listBans(limit = 200) {
  const n = Math.min(Math.max(Math.round(Number(limit)) || 200, 1), 500);
  return db.all('SELECT * FROM ip_bans ORDER BY at DESC LIMIT ' + n);
}

async function ban(ip, opts = {}) {
  const norm = normalizeIp(ip);
  if (isLoopback(norm)) return null;
  const now = Date.now();
  const reason = String(opts.reason || 'spam').slice(0, 40);
  const detail = opts.detail ? String(opts.detail).slice(0, 200) : null;
  const actor = opts.actor ? String(opts.actor).slice(0, 60) : 'system';
  const before = await db.get('SELECT ip FROM ip_bans WHERE ip = ?', norm);
  await db.run(
    `INSERT INTO ip_bans (ip, reason, detail, hits, actor, at, last_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (ip) DO UPDATE SET
       hits = ip_bans.hits + 1,
       last_at = excluded.last_at,
       reason = excluded.reason,
       detail = excluded.detail,
       actor = excluded.actor`,
    norm,
    reason,
    detail,
    actor,
    now,
    now
  );
  const row = await db.get('SELECT * FROM ip_bans WHERE ip = ?', norm);
  if (row && !before && notify) {
    try {
      await notify({ ...row, created: true });
    } catch (err) {
      console.error('ip ban notify:', err.message);
    }
  }
  return row;
}

async function unban(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  const gone = await db.run('DELETE FROM ip_bans WHERE ip = ?', norm);
  if (!gone.changes) return false;
  // kuota pendaftaran ikut dikosongkan: membuka blokir berarti memberi jalan baru
  await db.run('DELETE FROM reg_logs WHERE ip = ?', norm);
  return true;
}

async function recordAttempt({ ip, email, ok, reason } = {}) {
  const norm = normalizeIp(ip) || 'unknown';
  try {
    await db.run(
      'INSERT INTO reg_logs (id, ip, email, ok, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      norm,
      email ? String(email).trim().toLowerCase().slice(0, 200) : null,
      ok ? 1 : 0,
      reason ? String(reason).slice(0, 60) : null,
      Date.now()
    );
    await pruneLedger();
  } catch (err) {
    console.error('reg log:', err.message);
  }
}

// bersihkan ledger percobaan lama (dibatasi sekali per jam supaya murah)
async function pruneLedger() {
  const now = Date.now();
  if (now - lastPrune < HOUR) return;
  lastPrune = now;
  try {
    await db.run('DELETE FROM reg_logs WHERE at < ?', now - LEDGER_TTL);
  } catch (err) {
    console.error('reg log prune:', err.message);
  }
}

async function countOk(ip, windowMs, now = Date.now()) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM reg_logs WHERE ip = ? AND ok = 1 AND at > ?',
    normalizeIp(ip),
    now - windowMs
  );
  return Number(row && row.n) || 0;
}

async function countFail(ip, windowMs, now = Date.now()) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM reg_logs WHERE ip = ? AND ok = 0 AND at > ?',
    normalizeIp(ip),
    now - windowMs
  );
  return Number(row && row.n) || 0;
}

// dilemparkan SEBELUM akun dibuat: IP diblokir -> pendaftaran ditolak 403
// `name` = nama pendaftar, dipakai mengisi {nama} pada pesan blokir admin
async function assertRegisterAllowed(ip, name) {
  const norm = normalizeIp(ip);
  if (isLoopback(norm)) return;

  const banned = await isBanned(norm);
  if (banned) throw blockedError(await blockMessage(BLOCKED_MSG, name));

  const r = await rules();
  const used = await countOk(norm, r.windowMs);
  if (used >= r.perIp) {
    await ban(norm, {
      reason: 'spam',
      detail: `${used} pendaftaran sukses dari IP ini dalam 24 jam (batas ${r.perIp})`,
    });
    throw blockedError(
      await blockMessage(
        `IP ini diblokir otomatis: satu IP hanya boleh mendaftarkan ${r.perIp} akun per 24 jam. ` +
          'Hubungi admin untuk membuka blokir.',
        name
      )
    );
  }

  const fails = await countFail(norm, r.failWindowMs);
  if (fails >= r.failLimit) {
    await ban(norm, {
      reason: 'spam',
      detail: `${fails} percobaan pendaftaran gagal dari IP ini dalam 10 menit`,
    });
    throw blockedError(
      await blockMessage(
        'IP ini diblokir otomatis karena terlalu banyak percobaan pendaftaran gagal. ' +
          'Hubungi admin untuk membuka blokir.',
        name
      )
    );
  }
}

module.exports = {
  DEFAULT_RULES,
  BLOCKED_MSG,
  setNotify,
  normalizeIp,
  isLoopback,
  blockedError,
  fillName,
  rules,
  isBanned,
  listBans,
  ban,
  unban,
  recordAttempt,
  countOk,
  countFail,
  assertRegisterAllowed,
};
