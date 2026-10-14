'use strict';

/* Kuota storage (foto/video/file) yang NYATA ditegakkan per paket.
   - Pemakaian disimpan di kolom users.storage_used (byte) dan dijaga atomik:
     reserve() menambah hanya bila muat batas paket, release() mengurangi
     (dipakai saat pesan media dihapus). recompute() menghitung ulang dari
     sumber kebenaran (SUM media_size pesan aktif) untuk perbaikan drift.
   - Kuota berasal dari paket aktif (settings.planOf) atau FREE_STORAGE.
     Admin berstatus role=admin TIDAK dibatasi (quota = null = tanpa batas).
   - Bot internal TIDAK melewati jalur ini (handleSend hanya untuk pengguna),
     jadi kiriman bot tidak terpotong kuota. */

const db = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const crypto = require('crypto');

// batas ukuran satu media yang dilaporkan klien (sinkron dengan upload.js)
const MAX_MEDIA = 2 * 1024 * 1024 * 1024;

// kuota (byte) untuk satu baris pengguna; null = tanpa batas (admin)
async function quotaOf(user) {
  if (!user) return settings.FREE_STORAGE;
  if (user.role === 'admin') return null;
  if (!auth.isPremium(user)) return settings.FREE_STORAGE;
  const plan = await settings.planOf(user);
  const limit = plan && Number(plan.storageLimit);
  return limit > 0 ? limit : settings.FREE_STORAGE;
}

async function usedOf(userId) {
  const row = await db.get('SELECT storage_used FROM users WHERE id = ?', userId);
  return Number(row && row.storage_used) || 0;
}

// tambah pemakaian secara atomik; hanya berhasil bila muat batas paket.
// pengembalian: true = reservasi sukses, false = melebihi kuota.
async function reserve(userId, bytes, quota) {
  const size = Math.max(0, Math.round(Number(bytes) || 0));
  if (!size) return true; // nol byte tidak perlu reservasi
  if (size > MAX_MEDIA) return false;
  if (quota === null) {
    // admin / tanpa batas
    await db.run('UPDATE users SET storage_used = storage_used + ? WHERE id = ?', size, userId);
    return true;
  }
  const res = await db.run(
    'UPDATE users SET storage_used = storage_used + ? WHERE id = ? AND storage_used + ? <= ?',
    size, userId, size, Math.round(quota)
  );
  return res.changes === 1;
}

async function release(userId, bytes) {
  const size = Math.max(0, Math.round(Number(bytes) || 0));
  if (!size) return;
  const floor = db.dialect === 'pg' ? 'GREATEST' : 'MAX';
  await db.run(
    `UPDATE users SET storage_used = ${floor}(0, storage_used - ?) WHERE id = ?`,
    size, userId
  );
}

// gambaran pemakaian untuk ditampilkan (bar, kartu paket, profil)
async function usage(user) {
  const [quota, used] = await Promise.all([quotaOf(user), usedOf(user.id)]);
  const unlimited = quota === null;
  const percent = unlimited ? 0 : Math.min(100, quota > 0 ? (used / quota) * 100 : 0);
  let planId = null;
  let planLabel = null;
  if (user.role !== 'admin' && auth.isPremium(user)) {
    const plan = await settings.planOf(user);
    if (plan) { planId = plan.id; planLabel = plan.label; }
  }
  return {
    used,
    quota,            // null = tanpa batas
    unlimited,
    percent: Math.round(percent * 10) / 10,
    left: unlimited ? null : Math.max(0, quota - used),
    planId,
    planLabel,
    freeStorage: settings.FREE_STORAGE,
  };
}

// hitung ulang dari sumber kebenaran: total ukuran media pesan aktif + file tersimpan
async function recompute(userId) {
  const msg = await db.get(
    `SELECT COALESCE(SUM(media_size), 0) AS total
       FROM messages
      WHERE sender_id = ? AND deleted_at IS NULL AND media_url IS NOT NULL`,
    userId
  );
  const saved = await db.get(
    `SELECT COALESCE(SUM(media_size), 0) AS total FROM saved_files WHERE user_id = ?`,
    userId
  );
  const total = Math.max(0, (Number(msg && msg.total) || 0) + (Number(saved && saved.total) || 0));
  await db.run('UPDATE users SET storage_used = ? WHERE id = ?', total, userId);
  return total;
}

async function recomputeAll() {
  const msgRows = await db.all(
    `SELECT m.sender_id AS id, COALESCE(SUM(m.media_size), 0) AS total
       FROM messages m
      WHERE m.deleted_at IS NULL AND m.media_url IS NOT NULL AND m.sender_id IS NOT NULL
      GROUP BY m.sender_id`
  );
  const savedRows = await db.all(
    `SELECT user_id AS id, COALESCE(SUM(media_size), 0) AS total
       FROM saved_files GROUP BY user_id`
  );
  const byId = new Map();
  for (const r of msgRows) byId.set(r.id, (byId.get(r.id) || 0) + Math.max(0, Number(r.total) || 0));
  for (const r of savedRows) byId.set(r.id, (byId.get(r.id) || 0) + Math.max(0, Number(r.total) || 0));
  const users = await db.all('SELECT id FROM users');
  for (const u of users) {
    const total = byId.get(u.id) || 0;
    await db.run('UPDATE users SET storage_used = ? WHERE id = ?', total, u.id);
  }
  return users.length;
}

// daftar media milik satu pengguna (foto/video/file) yang masih tersimpan —
// gabungan pesan media aktif + file yang disimpan langsung ke storage.
// dipakai manajer penyimpanan; user hanya melihat berkas miliknya sendiri
const VALID_TYPES = ['image', 'video', 'audio', 'file'];

function serializeSaved(r) {
  return {
    id: r.id,
    kind: 'saved',
    chatId: null,
    type: VALID_TYPES.includes(r.type) ? r.type : 'file',
    url: r.media_url,
    name: r.media_name || null,
    size: Math.max(0, Number(r.media_size) || 0),
    mime: r.mime || null,
    at: Number(r.created_at) || 0,
    viewOnce: false,
  };
}

async function mediaList(userId, limit) {
  const cap = Math.min(Math.max(1, Number(limit) || 300), 1000);
  const msgRows = await db.all(
    `SELECT id, chat_id, type, media_url, media_name, media_size, mime, created_at, view_once
       FROM messages
      WHERE sender_id = ? AND media_url IS NOT NULL AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?`,
    userId, cap
  );
  const savedRows = await db.all(
    `SELECT id, media_url, media_name, media_size, mime, type, created_at
       FROM saved_files
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    userId, cap
  );
  const items = msgRows.map((r) => ({
    id: r.id,
    kind: 'msg',
    chatId: r.chat_id,
    type: VALID_TYPES.includes(r.type) ? r.type : 'file',
    url: r.media_url,
    name: r.media_name || null,
    size: Math.max(0, Number(r.media_size) || 0),
    mime: r.mime || null,
    at: Number(r.created_at) || 0,
    viewOnce: !!r.view_once,
  }));
  for (const r of savedRows) items.push(serializeSaved(r));
  items.sort((a, b) => b.at - a.at);
  const capped = items.slice(0, cap);
  const totals = { image: 0, video: 0, audio: 0, file: 0, all: 0 };
  for (const it of capped) {
    totals[it.type] += it.size;
    totals.all += it.size;
  }
  return { items: capped, totals, count: capped.length };
}

// simpan file langsung ke storage (tanpa pesan): reservasi kuota atomik lalu
// catat di saved_files. url wajib tervalidasi validChatUrl oleh pemanggil.
async function saveFile(user, input) {
  const url = String(input.url || '');
  const size = Math.max(0, Math.round(Number(input.size) || 0));
  if (!url) return { ok: false, error: 'URL file tidak valid' };
  if (size > MAX_MEDIA) return { ok: false, error: 'Ukuran file maksimal 2GB' };
  const type = VALID_TYPES.includes(input.type) ? input.type : 'file';
  const quota = await quotaOf(user);
  const reserved = await reserve(user.id, size, quota);
  if (!reserved) return { ok: false, error: 'Storage penuh — hapus media lama atau upgrade paket', full: true };
  const id = crypto.randomUUID();
  try {
    await db.run(
      `INSERT INTO saved_files (id, user_id, media_url, media_name, media_size, mime, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      url,
      input.name ? String(input.name).slice(0, 255) : null,
      size,
      input.mime ? String(input.mime).slice(0, 127) : null,
      type,
      Date.now()
    );
  } catch (err) {
    await release(user.id, size); // gagal catat -> bebaskan reservasi
    throw err;
  }
  const row = await db.get('SELECT * FROM saved_files WHERE id = ?', id);
  return { ok: true, item: serializeSaved(row) };
}

// hapus file tersimpan milik user & bebaskan kuotanya
async function deleteFile(user, id) {
  const row = await db.get('SELECT * FROM saved_files WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) return { ok: false, error: 'File tidak ditemukan', notFound: true };
  await db.run('DELETE FROM saved_files WHERE id = ?', id);
  await release(user.id, Number(row.media_size) || 0);
  return { ok: true };
}

module.exports = {
  MAX_MEDIA, quotaOf, usedOf, reserve, release, usage, recompute, recomputeAll, mediaList,
  saveFile, deleteFile,
};
