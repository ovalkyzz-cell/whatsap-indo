'use strict';

const crypto = require('crypto');
const db = require('./db');

// format kode undangan resmi: WA-MAZ-VAL-XXXX
const CODE_RE = /^WA-MAZ-VAL-[A-Z0-9]{4}$/;
// huruf ambigu (0/O, 1/I/L) dibuang supaya kode mudah diketik ulang
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WELCOME_TOKENS = 5; // bonus awal untuk teman yang join
const INVITE_TOKENS = 5; // bonus per teman yang berhasil bergabung

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function genCode() {
  let body = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `WA-MAZ-VAL-${body}`;
}

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase();
}

function validCode(input) {
  return CODE_RE.test(normalizeCode(input));
}

// kode unik per pengguna: dibuat saat pertama kali dibuka (dan dipakai saat mendaftar)
async function ensureCode(user) {
  if (user.ref_code) return user.ref_code;
  for (let i = 0; i < 12; i++) {
    const code = genCode();
    const taken = await db.get('SELECT id FROM users WHERE ref_code = ?', code);
    if (taken && taken.id !== user.id) continue;
    await db.run('UPDATE users SET ref_code = ? WHERE id = ?', code, user.id);
    user.ref_code = code;
    return code;
  }
  return null;
}

// cek kode milik pengundang; dipanggil sebelum akun baru dibuat supaya tidak ada tulis parsial
async function findInviter(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  if (!validCode(code)) {
    throw httpError(400, 'Kode undangan tidak valid. Contoh: WA-MAZ-VAL-7K2M');
  }
  const inviter = await db.get('SELECT * FROM users WHERE ref_code = ?', code);
  if (!inviter) throw httpError(400, 'Kode undangan tidak ditemukan. Kosongkan kolom ini untuk mendaftar.');
  return inviter;
}

// pendaftar baru dicatat sebagai tamu undangan + langsung dapat bonus token awal
async function applyReferral(newUser, inviter) {
  if (!inviter) return null;
  if (inviter.id === newUser.id) throw httpError(400, 'Tidak bisa memakai kode undangan sendiri');
  await db.run(
    'UPDATE users SET referred_by = ?, bot_tokens = bot_tokens + ? WHERE id = ?',
    inviter.id,
    WELCOME_TOKENS,
    newUser.id
  );
  return inviter;
}

// sekali saja: pengundang dapat 5 token ketika temannya resmi bergabung (disetujui admin)
async function rewardInviter(referredUserId) {
  const target = await db.get('SELECT id, referred_by, ref_rewarded FROM users WHERE id = ?', referredUserId);
  if (!target || !target.referred_by || Number(target.ref_rewarded)) return null;
  await db.run(
    `UPDATE users SET bot_tokens = bot_tokens + ?, invite_count = invite_count + 1 WHERE id = ?`,
    INVITE_TOKENS,
    target.referred_by
  );
  await db.run('UPDATE users SET ref_rewarded = 1 WHERE id = ?', target.id);
  return db.get('SELECT * FROM users WHERE id = ?', target.referred_by);
}

async function stats(user) {
  const code = await ensureCode(user);
  const fresh = await db.get(
    'SELECT ref_code, invite_count, bot_tokens, referred_by FROM users WHERE id = ?',
    user.id
  );
  return {
    code: code || fresh.ref_code,
    invited: Number(fresh.invite_count) || 0,
    tokens: Number(fresh.bot_tokens) || 0,
    welcomeTokens: WELCOME_TOKENS,
    inviteTokens: INVITE_TOKENS,
    referred: !!fresh.referred_by,
  };
}

module.exports = {
  CODE_RE,
  WELCOME_TOKENS,
  INVITE_TOKENS,
  genCode,
  normalizeCode,
  validCode,
  ensureCode,
  findInviter,
  applyReferral,
  rewardInviter,
  stats,
};
