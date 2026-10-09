'use strict';

const db = require('./db');

/* Masa dering panggilan (ms). Penerima boleh putus & tersambung kembali
   selama rentang ini — panggilan tetap berdering seperti WhatsApp. */
const RING_MS = Math.max(3_000, Number(process.env.CALL_RING_MS) || 60_000);
/* Panggilan aktif yang ditinggal tanpa diakhiri ditutup otomatis setelah ini. */
const ACTIVE_MAX_MS = Math.max(60_000, Number(process.env.CALL_ACTIVE_MAX_MS) || 6 * 3_600_000);
/* Riwayat panggilan disimpan (hari) sebelum dibersihkan otomatis. */
const HISTORY_DAYS = Math.max(1, Number(process.env.CALL_HISTORY_DAYS) || 30);

const LIVE = "('ringing', 'accepted', 'active')";

function ringMs() {
  return RING_MS;
}

async function create({ id, callerId, calleeId, kind }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO calls (id, caller_id, callee_id, kind, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ringing', ?, ?)`,
    id,
    callerId,
    calleeId,
    kind === 'video' ? 'video' : 'audio',
    now,
    now
  );
}

async function get(id) {
  return db.get('SELECT * FROM calls WHERE id = ?', id);
}

async function setState(id, state) {
  await db.run('UPDATE calls SET state = ?, updated_at = ? WHERE id = ?', state, Date.now(), id);
}

/* Penerima menekan Jawab: catat waktu dijawab untuk durasi riwayat. */
async function accept(id) {
  const now = Date.now();
  const res = await db.run(
    `UPDATE calls SET state = 'accepted', answered_at = ?, updated_at = ?
      WHERE id = ? AND state = 'ringing'`,
    now,
    now,
    id
  );
  return res.changes > 0;
}

/* Tutup panggilan yang masih berjalan tanpa menghapus baris:
   riwayat dipakai untuk notifikasi "panggilan tak terjawab" ala WhatsApp.
   Mengembalikan true hanya bila panggilan benar-benar masih hidup
   (mencegah notifikasi ganda ketika pembersih jalan bersamaan). */
async function finish(id, state) {
  const res = await db.run(
    `UPDATE calls SET state = ?, updated_at = ?
      WHERE id = ? AND state IN ${LIVE}`,
    state,
    Date.now(),
    id
  );
  return res.changes > 0;
}

async function remove(id) {
  const res = await db.run('DELETE FROM calls WHERE id = ?', id);
  return res.changes > 0;
}

async function listForUser(userId) {
  return db.all('SELECT * FROM calls WHERE caller_id = ? OR callee_id = ?', userId, userId);
}

/* Panggilan yang masih perlu dipantau saat pengguna pergi. */
async function listActiveForUser(userId) {
  return db.all(
    `SELECT * FROM calls
      WHERE (caller_id = ? OR callee_id = ?) AND state IN ${LIVE}`,
    userId,
    userId
  );
}

/* Panggilan masuk yang masih berdering untuk pengguna ini — dikirim ulang
   setiap kali perangkatnya (baru) tersambung, apa pun status daringnya. */
async function pendingIncoming(userId) {
  return db.all(
    `SELECT * FROM calls
      WHERE callee_id = ? AND state = 'ringing' AND created_at > ?
      ORDER BY created_at DESC`,
    userId,
    Date.now() - RING_MS
  );
}

/* Panggilan yang melewati masa dering -> tak terjawab.
   Baris yang keburu diterima/diakhiri tidak tersentuh (guard state=ringing). */
async function expireRinging(now = Date.now()) {
  const rows = await db.all(
    `SELECT * FROM calls WHERE state = 'ringing' AND created_at <= ?`,
    now - RING_MS
  );
  const expired = [];
  for (const row of rows) {
    const res = await db.run(
      `UPDATE calls SET state = 'missed', updated_at = ?
        WHERE id = ? AND state = 'ringing'`,
      now,
      row.id
    );
    if (res.changes > 0) expired.push({ ...row, state: 'missed', updated_at: now });
  }
  return expired;
}

/* Panggilan aktif yang ditinggal perangkatnya tanpa diakhiri -> ditutup. */
async function expireStaleActive(now = Date.now()) {
  const rows = await db.all(
    `SELECT * FROM calls WHERE state IN ('accepted', 'active') AND updated_at <= ?`,
    now - ACTIVE_MAX_MS
  );
  const closed = [];
  for (const row of rows) {
    const res = await db.run(
      `UPDATE calls SET state = 'ended', updated_at = ? WHERE id = ? AND state IN ('accepted', 'active')`,
      now,
      row.id
    );
    if (res.changes > 0) closed.push({ ...row, state: 'ended', updated_at: now });
  }
  return closed;
}

async function listRecent(userId, limit = 30) {
  const max = Math.min(200, Math.max(1, Number(limit) || 30));
  return db.all(
    `SELECT * FROM calls
      WHERE caller_id = ? OR callee_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    userId,
    userId,
    max
  );
}

/* Panggilan tak terjawab yang belum ditandai pada pengguna ini (arah apa pun). */
async function missedFor(userId, since = 0) {
  return db.all(
    `SELECT * FROM calls
      WHERE state = 'missed' AND created_at >= ? AND (callee_id = ? OR caller_id = ?)
      ORDER BY created_at DESC
      LIMIT 50`,
    Number(since) || 0,
    userId,
    userId
  );
}

async function purgeOld(now = Date.now()) {
  const res = await db.run('DELETE FROM calls WHERE created_at < ?', now - HISTORY_DAYS * 86_400_000);
  return res.changes > 0;
}

module.exports = {
  ringMs,
  create,
  get,
  setState,
  accept,
  finish,
  remove,
  listForUser,
  listActiveForUser,
  pendingIncoming,
  expireRinging,
  expireStaleActive,
  listRecent,
  missedFor,
  purgeOld,
};
