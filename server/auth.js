'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const referral = require('./referral');

const JWT_SECRET = process.env.JWT_SECRET || resolveSecret();
const TOKEN_TTL = '30d';

function resolveSecret() {
  if (process.env.VERCEL) {
    console.error('JWT_SECRET belum diatur: sesi tidak akan bertahan antar cold start');
    return crypto.randomBytes(48).toString('hex');
  }
  const file = path.join(__dirname, '..', 'data', '.jwt-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* belum ada */ }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch { /* gagal tulis file -> pakai secret di memori */ }
  return secret;
}

const VERIFIED_EMAILS = ['ovalkyzz@gmail.com'];
const ADMIN_EMAILS = [
  ...VERIFIED_EMAILS,
  ...(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
].map((e) => e.toLowerCase());

function isVerifiedEmail(email) {
  return VERIFIED_EMAILS.includes(String(email || '').trim().toLowerCase());
}

// centang biru hanya untuk premium (atau admin); kolom verified ikut disinkronkan
function isPremium(row) {
  return Number(row && row.premium_until) > Date.now();
}

function isAdmin(row) {
  if (!row) return false;
  return row.role === 'admin' || ADMIN_EMAILS.includes(String(row.email || '').trim().toLowerCase());
}

// centang biru: admin, premium, atau bot resmi internal
function verifiedOf(row) {
  return isAdmin(row) || isPremium(row) || Number(row && row.is_bot) === 1;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    about: row.about,
    verified: verifiedOf(row),
    role: isAdmin(row) ? 'admin' : (row.role || 'user'),
    premium: {
      plan: row.premium_plan || null,
      until: Number(row.premium_until) || 0,
      active: isPremium(row),
    },
    privacy: {
      lastSeen: !!row.priv_last_seen,
      receipts: !!row.priv_receipts,
      email: !!row.priv_email,
      bio: !!row.priv_bio,
      status: !!row.priv_status,
      avatar: !!row.priv_avatar,
    },
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    wallpaper: {
      type: row.wallpaper_type || 'default',
      url: row.wallpaper_url || null,
      mode: row.wallpaper_mode || 'cover',
      scale: Number(row.wallpaper_scale) || 100,
      dim: row.wallpaper_dim === null || row.wallpaper_dim === undefined ? 20 : Number(row.wallpaper_dim),
    },
    homeBg: {
      type: row.home_bg_type || 'default',
      url: row.home_bg_url || null,
    },
  };
}

async function register({ email, name, password, ref }, meta = {}) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, 'Email tidak valid');
  }
  if (!name || name.trim().length < 2) {
    throw httpError(400, 'Nama minimal 2 karakter');
  }
  if (!password || password.length < 6) {
    throw httpError(400, 'Password minimal 6 karakter');
  }
  // kode undangan divalidasi dulu supaya tidak ada baris tersisip separuh jalan
  const inviter = await referral.findInviter(ref);
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email.trim().toLowerCase());
  if (existing) throw httpError(409, 'Email sudah terdaftar');

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();
  // akun baru wajib disetujui admin lebih dulu, kecuali email admin/verifikasi
  const status = ADMIN_EMAILS.includes(email.trim().toLowerCase()) ? 'active' : 'pending';
  await db.run(
    `INSERT INTO users (id, email, name, password_hash, verified, account_status, created_at, last_seen,
       referred_by, bot_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    email.trim().toLowerCase(),
    name.trim(),
    hash,
    isVerifiedEmail(email) ? 1 : 0,
    status,
    now,
    now,
    inviter ? inviter.id : null,
    inviter ? referral.WELCOME_TOKENS : 0
  );

  const row = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (status !== 'active') {
    return {
      user: publicUser(row),
      pending: true,
      refApplied: !!inviter,
      message: inviter
        ? `Pendaftaran diterima (kode undangan ${referral.normalizeCode(ref)} dipakai). Menunggu persetujuan admin sebelum bisa masuk.`
        : 'Pendaftaran diterima. Menunggu persetujuan admin sebelum bisa masuk.',
    };
  }
  // akun aktif langsung: pengundang langsung mendapat token undangannya
  if (inviter) await referral.rewardInviter(id);
  const fresh = await startSession(row, meta);
  return { user: publicUser(fresh), token: sign(fresh), refApplied: !!inviter };
}

async function login({ email, password }, meta = {}) {
  const row = await db.get(
    'SELECT * FROM users WHERE email = ?',
    String(email || '').trim().toLowerCase()
  );
  if (!row) throw httpError(401, 'Email atau password salah', 'invalid_credentials');
  const ok = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!ok) throw httpError(401, 'Email atau password salah', 'invalid_credentials');

  const blocked = statusError(row);
  if (blocked) throw blocked;

  const fresh = await startSession(row, meta);
  await db.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), row.id);
  return { user: publicUser({ ...fresh, last_seen: Date.now() }), token: sign(fresh) };
}

// akun yang belum disetujui / ditolak / diblokir tidak boleh masuk
function statusError(row) {
  if (Number(row.banned)) {
    return httpError(403, row.banned_reason ? `Akun diblokir admin: ${row.banned_reason}` : 'Akun ini diblokir admin', 'banned');
  }
  if (row.account_status === 'pending') {
    return httpError(403, 'Pendaftaran Anda menunggu persetujuan admin', 'pending');
  }
  if (row.account_status === 'rejected') {
    return httpError(
      403,
      row.reject_reason ? `Pendaftaran ditolak admin: ${row.reject_reason}` : 'Pendaftaran Anda ditolak admin',
      'rejected'
    );
  }
  return null;
}

// satu akun hanya boleh hidup di satu perangkat: sesi baru mematikan sesi lama
async function startSession(row, meta = {}) {
  const sid = crypto.randomUUID();
  const now = Date.now();
  const device = cleanMeta(meta.device, 180);
  const ip = cleanMeta(meta.ip, 60);
  await db.run(
    `UPDATE users SET session_id = ?, session_at = ?, last_login_at = ?,
       last_device = ?, last_ip = ? WHERE id = ?`,
    sid,
    now,
    now,
    device,
    ip,
    row.id
  );
  return { ...row, session_id: sid, session_at: now, last_login_at: now, last_device: device, last_ip: ip };
}

async function clearSession(userId) {
  await db.run('UPDATE users SET session_id = NULL WHERE id = ?', userId);
}

function cleanMeta(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function sign(row) {
  return jwt.sign({ sub: row.id, email: row.email, sid: row.session_id || '' }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

// pengecekan tunggal dipakai bersama oleh HTTP (requireAuth) dan socket handshake
function sessionCheck(payload, row) {
  if (!row) return { ok: false, code: 'auth:akun-tidak-ditemukan', error: 'Akun tidak ditemukan' };
  if (Number(row.banned)) {
    return { ok: false, code: 'auth:diblokir', error: row.banned_reason ? `Akun diblokir admin: ${row.banned_reason}` : 'Akun ini diblokir admin' };
  }
  if (row.account_status === 'pending') {
    return { ok: false, code: 'auth:menunggu-persetujuan', error: 'Pendaftaran menunggu persetujuan admin' };
  }
  if (row.account_status === 'rejected') {
    return { ok: false, code: 'auth:ditolak', error: 'Pendaftaran ditolak admin' };
  }
  if (!row.session_id || payload.sid !== row.session_id) {
    return { ok: false, code: 'auth:sesi-diganti', error: 'Akun ini dibuka di perangkat lain. Silakan masuk kembali.' };
  }
  return { ok: true };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token && verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Tidak terautentikasi', code: 'unauthenticated' });
    let row = await db.get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!row) return res.status(401).json({ error: 'Akun tidak ditemukan', code: 'akun-hilang' });
    if (ADMIN_EMAILS.includes(String(row.email || '').trim().toLowerCase()) && row.role !== 'admin') {
      await db.run(`UPDATE users SET role = 'admin', verified = 1 WHERE id = ?`, row.id);
      row = { ...row, role: 'admin', verified: 1 };
    }
    const blocked = statusError(row);
    if (blocked) {
      return res.status(blocked.status).json({ error: blocked.message, code: blocked.code });
    }
    const check = sessionCheck(payload, row);
    if (!check.ok) {
      return res.status(401).json({ error: check.error, code: check.code.replace('auth:', '') });
    }
    req.user = row;
    next();
  } catch (err) {
    next(err);
  }
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

module.exports = {
  register,
  login,
  verifyToken,
  requireAuth,
  publicUser,
  httpError,
  isAdmin,
  isPremium,
  verifiedOf,
  sessionCheck,
  clearSession,
  ADMIN_EMAILS,
};
