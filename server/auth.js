'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

const TOKEN_TTL = '30d';

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    about: row.about,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
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
  const existing = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(email.trim().toLowerCase());
  if (existing) throw httpError(409, 'Email sudah terdaftar');

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email.trim().toLowerCase(), name.trim(), hash, now, now);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { user: publicUser(row), token: sign(row) };
}

async function login({ email, password }) {
  const row = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());
  if (!row) throw httpError(401, 'Email atau password salah');
  const ok = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!ok) throw httpError(401, 'Email atau password salah');
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
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

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Tidak terautentikasi' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!row) return res.status(401).json({ error: 'Akun tidak ditemukan' });
  req.user = row;
  next();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { register, login, verifyToken, requireAuth, publicUser, httpError };
