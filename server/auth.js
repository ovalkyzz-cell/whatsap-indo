'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

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

function isVerifiedEmail(email) {
  return VERIFIED_EMAILS.includes(String(email || '').trim().toLowerCase());
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    about: row.about,
    verified: !!row.verified,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    wallpaper: {
      type: row.wallpaper_type || 'default',
      url: row.wallpaper_url || null,
      mode: row.wallpaper_mode || 'cover',
      scale: Number(row.wallpaper_scale) || 100,
      dim: row.wallpaper_dim === null || row.wallpaper_dim === undefined ? 20 : Number(row.wallpaper_dim),
    },
  };
}

async function register({ email, name, password }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, 'Email tidak valid');
  }
  if (!name || name.trim().length < 2) {
    throw httpError(400, 'Nama minimal 2 karakter');
  }
  if (!password || password.length < 6) {
    throw httpError(400, 'Password minimal 6 karakter');
  }
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email.trim().toLowerCase());
  if (existing) throw httpError(409, 'Email sudah terdaftar');

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();
  await db.run(
    `INSERT INTO users (id, email, name, password_hash, verified, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    email.trim().toLowerCase(),
    name.trim(),
    hash,
    isVerifiedEmail(email) ? 1 : 0,
    now,
    now
  );

  const row = await db.get('SELECT * FROM users WHERE id = ?', id);
  return { user: publicUser(row), token: sign(row) };
}

async function login({ email, password }) {
  const row = await db.get(
    'SELECT * FROM users WHERE email = ?',
    String(email || '').trim().toLowerCase()
  );
  if (!row) throw httpError(401, 'Email atau password salah');
  const ok = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!ok) throw httpError(401, 'Email atau password salah');
  await db.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), row.id);
  return { user: publicUser({ ...row, last_seen: Date.now() }), token: sign(row) };
}

function sign(row) {
  return jwt.sign({ sub: row.id, email: row.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
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
    if (!payload) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const row = await db.get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!row) return res.status(401).json({ error: 'Akun tidak ditemukan' });
    req.user = row;
    next();
  } catch (err) {
    next(err);
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { register, login, verifyToken, requireAuth, publicUser, httpError };
