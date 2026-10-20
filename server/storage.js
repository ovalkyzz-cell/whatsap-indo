'use strict';

/* Kuota storage (foto/video/file) yang NYATA ditegakkan per paket.
   - Pemakaian disimpan di kolom users.storage_used (byte) dan dijaga atomik:
     reserve() menambah hanya bila muat batas paket, release() mengurangi.
   - Model hitung tunggal (aman untuk 900k pengguna):
     * baris db_files (unggahan chunked/multipart ke db/GitHub) dihitung SEKALI
       saat init/unggahan sukses (counted=1) — tanpa itu klien jahat bisa
       menumpuk file tanpa pernah mengirim pesan;
     * pesan/file tersimpan ber-url dbfile TIDAK menghitung lagi (sudah ada di
       baris db_files), dan tidak melepas kuota saat dihapus — cukup jika
       berkasnya benar-benar dibuang lewat maybeDropDbfile();
     * url non-dbfile (/uploads/, Blob) tetap dihitung saat kirim/simpan
       seperti model lama;
     * recompute() = SUM(db_files) + pesan/file non-dbfile (sumber kebenaran).
   - Kuota berasal dari paket aktif (settings.planOf) atau FREE_STORAGE.
     Admin berstatus role=admin TIDAK dibatasi (quota = null = tanpa batas).
   - Bot internal TIDAK melewati jalur ini (handleSend hanya untuk pengguna),
     jadi kiriman bot tidak terpotong kuota. */

const db = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const crypto = require('crypto');
const ghstore = require('./ghstore');

// batas ukuran satu media yang dilaporkan klien (sinkron dengan upload.js)
const MAX_MEDIA = 2 * 1024 * 1024 * 1024;

// url /api/storage/dbfiles/<id> -> id; selain itu null
function dbfileIdOf(url) {
  const m = /^\/api\/storage\/dbfiles\/([\w-]{1,64})$/.exec(String(url || ''));
  return m ? m[1] : null;
}

function isDbfileUrl(url) {
  return dbfileIdOf(url) !== null;
}

// buang karakter kontrol (mencegah injeksi CR/LF pada header & teks aneh)
function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

// mime harus berbentuk tipe/subtipe[;param] — selain itu pakai default aman
function cleanMime(v) {
  const m = String(v == null ? '' : v).trim();
  return /^[\w.+-]{1,40}\/[\w.+-]{1,40}(\s*;[\w\s.=+-]{0,80})?$/.test(m)
    ? m.slice(0, 127)
    : 'application/octet-stream';
}

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

// hitung ulang dari sumber kebenaran: ukuran berkas db_files (sudah termasuk
// unggahan yang belum dikirim sebagai pesan) + pesan/file non-dbfile.
// url dbfile tidak ikut dijumlah di pesan/saved karena sudah mewakili baris
// db_files — inilah model hitung tunggal yang sama dengan jalur runtime.
async function recompute(userId) {
  const files = await db.get(
    `SELECT COALESCE(SUM(size), 0) AS total FROM db_files WHERE user_id = ?`,
    userId
  );
  const msg = await db.get(
    `SELECT COALESCE(SUM(media_size), 0) AS total
       FROM messages
      WHERE sender_id = ? AND deleted_at IS NULL AND media_url IS NOT NULL
        AND media_url NOT LIKE '/api/storage/dbfiles/%'`,
    userId
  );
  const saved = await db.get(
    `SELECT COALESCE(SUM(media_size), 0) AS total
       FROM saved_files
      WHERE user_id = ? AND (media_url IS NULL OR media_url NOT LIKE '/api/storage/dbfiles/%')`,
    userId
  );
  const total = Math.max(0,
    (Number(files && files.total) || 0) +
    (Number(msg && msg.total) || 0) +
    (Number(saved && saved.total) || 0));
  await db.run('UPDATE users SET storage_used = ? WHERE id = ?', total, userId);
  return total;
}

async function recomputeAll() {
  const fileRows = await db.all(
    `SELECT user_id AS id, COALESCE(SUM(size), 0) AS total
       FROM db_files GROUP BY user_id`
  );
  const msgRows = await db.all(
    `SELECT m.sender_id AS id, COALESCE(SUM(m.media_size), 0) AS total
       FROM messages m
      WHERE m.deleted_at IS NULL AND m.media_url IS NOT NULL AND m.sender_id IS NOT NULL
        AND m.media_url NOT LIKE '/api/storage/dbfiles/%'
      GROUP BY m.sender_id`
  );
  const savedRows = await db.all(
    `SELECT user_id AS id, COALESCE(SUM(media_size), 0) AS total
       FROM saved_files
      WHERE media_url IS NULL OR media_url NOT LIKE '/api/storage/dbfiles/%'
      GROUP BY user_id`
  );
  const byId = new Map();
  for (const r of fileRows) byId.set(r.id, (byId.get(r.id) || 0) + Math.max(0, Number(r.total) || 0));
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
  // berkas dbfile yang sudah tercatat di kuota (counted) tidak dihitung dua
  const fileId = dbfileIdOf(url);
  const file = fileId ? await db.get('SELECT id, counted FROM db_files WHERE id = ?', fileId) : null;
  const alreadyCounted = Boolean(file) && Number(file.counted) === 1;
  const quota = await quotaOf(user);
  const reserved = alreadyCounted ? true : await reserve(user.id, size, quota);
  if (!reserved) return { ok: false, error: 'Storage penuh — hapus media lama atau upgrade paket', full: true };
  const id = crypto.randomUUID();
  try {
    await db.run(
      `INSERT INTO saved_files (id, user_id, media_url, media_name, media_size, mime, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      url,
      input.name ? cleanStr(input.name, 255) : null,
      size,
      input.mime ? cleanMime(input.mime) : null,
      type,
      Date.now()
    );
  } catch (err) {
    if (!alreadyCounted) await release(user.id, size); // gagal catat -> bebaskan reservasi
    throw err;
  }
  const row = await db.get('SELECT * FROM saved_files WHERE id = ?', id);
  return { ok: true, item: serializeSaved(row) };
}

// hapus file tersimpan milik user; bebaskan kuotanya hanya untuk url non-dbfile
// (dbfile dihitung lewat baris db_files — dibuang hanya bila tak lagi dirujuk)
async function deleteFile(user, id) {
  const row = await db.get('SELECT * FROM saved_files WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) return { ok: false, error: 'File tidak ditemukan', notFound: true };
  await db.run('DELETE FROM saved_files WHERE id = ?', id);
  let freed = 0;
  if (dbfileIdOf(row.media_url)) {
    const d = await maybeDropDbfile(row.media_url);
    if (d.dropped) freed = d.freed;
    else if (!d.exists) {
      // berkasnya sudah hilang: sisa hitungan lama (lewat saved) dilepas
      freed = Math.max(0, Number(row.media_size) || 0);
      if (freed) await release(user.id, freed);
    }
    // ada, masih dirujuk: tetap terhitung — tidak ada yang dilepas
  } else {
    freed = Math.max(0, Number(row.media_size) || 0);
    await release(user.id, freed);
  }
  return { ok: true, freed };
}

/* ---------- pembuangan berkas dbfile (rujukan & GC) ---------- */

// Buang isi + baris berkas dbfile. Bebaskan kuota owner bila baris ber-`counted`
// (unggahan model baru selalu counted=1; baris lama sudah distempel saat migrasi).
async function cleanupDbfile(file) {
  const id = String(file.id || '');
  if (!id) return 0;
  try {
    const parts = await db.all('SELECT asset_id FROM db_file_parts WHERE file_id = ?', id);
    for (const p of parts) if (p.asset_id) await ghstore.deleteAsset(p.asset_id);
    await db.run('DELETE FROM db_file_parts WHERE file_id = ?', id);
    await db.run('DELETE FROM db_file_chunks WHERE file_id = ?', id);
    await db.run('DELETE FROM db_files WHERE id = ?', id);
    let freed = 0;
    if (Number(file.counted) === 1) {
      freed = Math.max(0, Number(file.size) || 0);
      if (freed) await release(file.user_id, freed);
    }
    return freed;
  } catch (err) {
    console.error('cleanup dbfile:', err.message);
    return 0;
  }
}

// Jatuhkan berkas dbfile bila tak lagi dirujuk pesan aktif maupun file tersimpan.
// pengembalian: { exists, dropped, freed }.
async function maybeDropDbfile(url) {
  const id = dbfileIdOf(url);
  if (!id) return { exists: false, dropped: false, freed: 0 };
  const file = await db.get(
    'SELECT id, user_id, size, counted FROM db_files WHERE id = ?', id
  );
  if (!file) return { exists: false, dropped: false, freed: 0 };
  const refs = await db.get(
    `SELECT (SELECT COUNT(*) FROM messages WHERE media_url = ? AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM saved_files WHERE media_url = ?) AS n`,
    url, url
  );
  if (Number(refs && refs.n) > 0) return { exists: true, dropped: false, freed: 0 };
  const freed = await cleanupDbfile(file);
  return { exists: true, dropped: true, freed };
}

// GC unggahan yang ditinggalkan (belum selesai > maxAgeMs): bebaskan kuota dan
// buang potongan aset/barisnya supaya tak menumpuk. Dijalankan interval dari
// server/index.js (sweepStaleUploads).
async function sweepStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const rows = await db.all(
    'SELECT id, user_id, size, counted FROM db_files WHERE complete = 0 AND created_at < ?',
    cutoff
  );
  let freed = 0;
  for (const row of rows) freed += await cleanupDbfile(row);
  return { removed: rows.length, freed };
}

module.exports = {
  MAX_MEDIA, quotaOf, usedOf, reserve, release, usage, recompute, recomputeAll, mediaList,
  saveFile, deleteFile,
  dbfileIdOf, isDbfileUrl, cleanStr, cleanMime,
  cleanupDbfile, maybeDropDbfile, sweepStaleUploads,
};
