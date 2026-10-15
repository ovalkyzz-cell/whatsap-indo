'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('./auth');
const quota = require('./storage');
const db = require('./db');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const useBlob = Boolean(BLOB_TOKEN);

// mime yang aman ditampilkan inline; sisanya dipaksa unduh (cegah XSS)
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|ico)|video\/(mp4|webm|mov|m4v)|audio\/(mp3|ogg|wav|m4a|opus|aac|flac)|application\/(pdf)|text\/(plain|csv))$/i;
const SVG_EXT_MIME = /svg/i;

let fsWritable = false;
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.accessSync(UPLOAD_DIR, fs.constants.W_OK);
  fsWritable = true;
} catch { /* filesystem read-only (mis. serverless) -> pakai Blob */ }

const storageEnabled = useBlob || fsWritable;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB (mode filesystem)
// batas permintaan Vercel 4,5MB per request -> di hosting file dikirim via Blob
const HOSTED_MAX_FILE_SIZE = 4 * 1024 * 1024;

const storage = useBlob
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(0, 16);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    });

const upload = multer({
  storage,
  limits: { fileSize: useBlob ? HOSTED_MAX_FILE_SIZE : MAX_FILE_SIZE },
});

const router = express.Router();

function classify(mime, original) {
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^text\/|^application\/(pdf|zip|json|msword|vnd\.)/.test(mime)) return 'file';
  const ext = path.extname(original).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video';
  if (['.mp3', '.ogg', '.wav', '.m4a', '.opus'].includes(ext)) return 'audio';
  return 'file';
}

// pemeriksaan awal kuota storage sebelum file diproses (hemat bandwidth).
// Reservasi yang sesungguhnya & otoritatif terjadi saat pesan benar-benar
// dikirim di handleSend; ini hanya penolakan cepat bila sudah jelas penuh.
async function rejectIfQuotaFull(req, res, size) {
  const q = await quota.quotaOf(req.user);
  if (q === null) return false; // admin / tanpa batas
  const u = await quota.usage(req.user);
  if (u.used + size <= q) return false;
  const gb = (b) => (b >= 1000 ** 3
    ? `${(b / 1000 ** 3).toFixed(b >= 10 * 1000 ** 3 ? 0 : 1)} GB`
    : `${Math.max(1, Math.round(b / 1000 ** 2))} MB`);
  res.status(413).json({
    error: `Storage penuh (${gb(u.used)} dari ${gb(q)}). Hapus media lama atau upgrade paket.`,
    storage: u,
  });
  return true;
}

// Tanda tangan presigned: browser mengunggah langsung ke Blob tanpa melewati
// fungsi Vercel, sehingga file > 4,5MB (batas body permintaan) tetap terkirim.
router.post('/uploads/sign', requireAuth, async (req, res) => {
  if (!useBlob) {
    return res.status(501).json({ error: 'Upload langsung belum tersedia' });
  }
  const original = String(req.body?.name || 'file').slice(0, 255);
  const size = Number(req.body?.size) || 0;
  const mime = String(req.body?.mime || '').slice(0, 127);
  if (!(size > 0)) return res.status(400).json({ error: 'Ukuran file tidak valid' });
  if (size > MAX_FILE_SIZE) return res.status(413).json({ error: 'Ukuran file maksimal 2GB' });
  if (await rejectIfQuotaFull(req, res, size)) return;

  try {
    const ext = path.extname(original).slice(0, 16).replace(/[^\w.-]/g, '');
    const pathname = `uploads/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const validUntil = Date.now() + 15 * 60 * 1000;
    const { issueSignedToken, presignUrl } = require('@vercel/blob');
    const token = await issueSignedToken({
      pathname,
      operations: ['put'],
      maximumSizeInBytes: size,
      validUntil,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname,
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      maximumSizeInBytes: size,
      validUntil,
    });
    res.status(201).json({
      presignedUrl,
      pathname,
      validUntil,
      name: original,
      size,
      mime: mime || 'application/octet-stream',
      type: classify(mime, original),
    });
  } catch (err) {
    console.error('sign:', err.message);
    res.status(500).json({ error: 'Gagal menyiapkan upload' });
  }
});

router.post('/upload', requireAuth, (req, res) => {
  if (!storageEnabled) {
    return res.status(501).json({ error: 'Penyimpanan file belum tersedia di hosting ini' });
  }
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: useBlob
            ? 'File terlalu besar untuk hosting (maksimal 4MB)'
            : 'Ukuran file maksimal 2GB',
        });
      }
      return res.status(400).json({ error: err.message || 'Upload gagal' });
    }
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });

    const meta = {
      name: req.file.originalname,
      size: useBlob ? req.file.buffer.length : req.file.size,
      mime: req.file.mimetype || 'application/octet-stream',
      type: classify(req.file.mimetype || '', req.file.originalname),
    };

    // kuota storage: tolak berkas yang sudah jelas melampaui batas paket
    if (await rejectIfQuotaFull(req, res, meta.size)) {
      if (!useBlob && req.file.path) {
        try { await fs.promises.unlink(req.file.path); } catch { /* sudah hilang */ }
      }
      return;
    }

    if (!useBlob) {
      return res.status(201).json({ url: `/uploads/${req.file.filename}`, ...meta });
    }

    const ext = path.extname(req.file.originalname).slice(0, 16);
    const pathname = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const { put } = require('@vercel/blob');
    try {
      const object = await put(pathname, req.file.buffer, {
        access: 'public',
        token: BLOB_TOKEN || undefined,
        addRandomSuffix: true,
        contentType: req.file.mimetype || undefined,
      });
      return res.status(201).json({ url: object.url, ...meta });
    } catch (blobErr) {
      // Blob ditangguhkan/gagal -> cadangan: simpan byttes ke database
      // (Postgres/SQLite) supaya upload tetap berhasil walau Blob mati.
      console.error('upload blob:', blobErr.message);
      try {
        const id = crypto.randomUUID();
        await db.run(
          `INSERT INTO db_files (id, user_id, data, mime, name, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id, req.user.id, req.file.buffer, meta.mime, meta.name, meta.size, Date.now()
        );
        return res.status(201).json({ url: `/api/storage/dbfiles/${id}`, ...meta });
      } catch (dbErr) {
        console.error('upload db fallback:', dbErr.message);
        return res.status(500).json({ error: 'Gagal menyimpan file' });
      }
    }
  });
});

/* Penyaji file yang disimpan di database (cadangan saat Blob mati).
   Akses publik via id acak yang tak terduga (sama seperti URL Blob publik
   & /uploads/). Konten ditentukan dari mime yang tercatat. */
router.get('/storage/dbfiles/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).json({ error: 'ID tidak valid' });
  let row = null;
  try { row = await db.get('SELECT data, mime FROM db_files WHERE id = ?', id); } catch { /* jatuh ke 404 */ }
  if (!row || !row.data) return res.status(404).json({ error: 'File tidak ditemukan' });
  const mime = row.mime || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  // paksa unduh untuk tipe berisiko (mencegah XSS lewat HTML/SVG)
  if (!INLINE_SAFE.test(mime) || SVG_EXT_MIME.test(mime)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  res.send(Buffer.from(row.data));
});

/* ---------- simpan hasil unduhan bot (video/audio/berkas) ----------
   Tautan unduhan dari pihak ketiga cepat kedaluwarsa & diblokir hotlink,
   jadi hasil unduhan disimpan ke penyimpanan yang sama dengan upload
   pengguna: folder uploads/ secara lokal, atau Vercel Blob di hosting. */

// batas unduhan bot: mode filesystem dialirkan langsung ke disk (hemat RAM),
// mode blob (serverless tanpa filesystem) menampung di memori
const REMOTE_LIMITS = { video: 512 * 1024 * 1024, audio: 64 * 1024 * 1024, file: 64 * 1024 * 1024, image: 16 * 1024 * 1024 };
const REMOTE_MEMORY_LIMITS = { video: 64 * 1024 * 1024, audio: 32 * 1024 * 1024, file: 32 * 1024 * 1024, image: 16 * 1024 * 1024 };
const REMOTE_TIMEOUTS = { video: 180000, audio: 90000, file: 120000, image: 60000 };

function filenameFromDisposition(cd) {
  const s = String(cd || '');
  const star = s.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]).trim(); } catch { /* lanjut */ }
  }
  const plain = s.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

const EXT_MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.zip': 'application/zip', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

function safeExt(filename, kind) {
  const ext = path.extname(String(filename || '')).toLowerCase().slice(0, 8);
  if (ext && Object.prototype.hasOwnProperty.call(EXT_MIME, ext)) return ext;
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.mp3';
  if (kind === 'image') return '.png';
  return '.bin';
}

function safeName(filename, kind) {
  const base = path.basename(String(filename || '')).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120).trim();
  if (base) return base;
  return `hasil-unduhan${safeExt('', kind)}`;
}

// tolak halaman error berkedup file (HTML/JSON) dan jenis yang tidak cocok
function looksLike(buffer, kind, name) {
  const head = buffer.slice(0, 64).toString('latin1');
  if (/^\s*<(!doctype|html|head|script|body)/i.test(head)) return false;
  if (kind === 'video') return /ftyp|moov|mdat|webm/i.test(head) || head.startsWith('\x1aE\xdf\xa3');
  if (kind === 'audio') return head.startsWith('ID3') || /OggS|fLaC|ftyp/i.test(head) || /^[\xff][\xfb\xf3\xf2\xe3\xfa]/.test(head);
  if (kind === 'image') return head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('GIF8') || head.startsWith('RIFF');
  if (kind === 'file') return /\.zip$/i.test(name || '') ? head.startsWith('PK') : true;
  return true;
}

async function storeBuffer(buffer, kind, filename, opts = {}) {
  if (!storageEnabled || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const limit = REMOTE_LIMITS[kind] || REMOTE_LIMITS.file;
  if (buffer.length > limit) return null;
  const name = safeName(filename, kind);
  if (!looksLike(buffer, kind, name)) return null;
  const ext = safeExt(name, kind);
  let stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  // keepName: sebagian nama asli (sudah disanitasi) ikut tersimpan di URL —
  // dipakai bot gambar lokal supaya berkasnya mudah dikenali (brattxt-*.png)
  if (opts.keepName) {
    const base = name
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (base) stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${base}${ext}`;
  }
  if (useBlob) {
    try {
      const { put } = require('@vercel/blob');
      const object = await put(`uploads/${stored}`, buffer, {
        access: 'public',
        token: BLOB_TOKEN || undefined,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: EXT_MIME[ext] || 'application/octet-stream',
      });
      return { url: object.url, size: buffer.length, name };
    } catch {
      return null;
    }
  }
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), buffer);
    return { url: `/uploads/${stored}`, size: buffer.length, name };
  } catch {
    return null;
  }
}

// unduh file hasil bot langsung ke disk: hemat RAM untuk video besar,
// magic bytes dicek dari potongan pertama sebelum file resmi disimpan
async function streamToDisk(res, kind, filename, limit) {
  const tmp = path.join(UPLOAD_DIR, `.dl-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`);
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let head = Buffer.alloc(0);
  try {
    const src = (async function* () {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        received += buf.length;
        if (received > limit) throw new Error('ukuran file melebihi batas');
        if (head.length < 64) head = Buffer.concat([head, buf]).slice(0, 64);
        yield buf;
      }
    })();
    await pipeline(src, out);
  } catch {
    try { await fs.promises.unlink(tmp); } catch { /* sudah hilang */ }
    return null;
  }
  if (!received) {
    try { await fs.promises.unlink(tmp); } catch { /* sudah hilang */ }
    return null;
  }
  const name = safeName(filename, kind);
  if (!looksLike(head, kind, name)) {
    try { await fs.promises.unlink(tmp); } catch { /* sudah hilang */ }
    return null;
  }
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt(name, kind)}`;
  try {
    await fs.promises.rename(tmp, path.join(UPLOAD_DIR, stored));
    return { url: `/uploads/${stored}`, size: received, name };
  } catch {
    try { await fs.promises.unlink(tmp); } catch { /* sudah hilang */ }
    return null;
  }
}

async function storeRemoteFile(url, kind, opts) {
  const o = opts || {};
  const timeout = o.timeout || REMOTE_TIMEOUTS[kind] || 60000;
  const limit = (fsWritable ? REMOTE_LIMITS : REMOTE_MEMORY_LIMITS)[kind]
    || (fsWritable ? REMOTE_LIMITS.file : REMOTE_MEMORY_LIMITS.file);

  let res;
  try {
    res = await fetch(String(url), {
      headers: { 'User-Agent': 'Mozilla/5.0 (WhatsapIndo Bot)', Accept: '*/*' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  const ct = String(res.headers.get('content-type') || '');
  if (/text\/html|application\/json|text\/plain/i.test(ct)) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > limit) return null;
  const cdName = filenameFromDisposition(res.headers.get('content-disposition'));
  const name = cdName || o.name || '';

  if (fsWritable && res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    return await streamToDisk(res, kind, name, limit);
  }

  // fallback memori (mode blob / stream tidak tersedia)
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) return null;
    return await storeBuffer(buf, kind, name);
  } catch {
    return null;
  }
}

module.exports = { router, UPLOAD_DIR, MAX_FILE_SIZE, storageEnabled, useBlob, storeBuffer, storeRemoteFile, storedFileExists, storedFileStatus };

/* Status penyimpanan sebuah URL media:
   'exists'  -> file terbukti ada
   'missing' -> file terbukti hilang (404/410) — aman dihapus
   'unknown' -> tak bisa dipastikan (jaringan/timeout/metode tak didukung) — JANGAN dihapus
   Untuk Blob dipakai HEAD; kalau HEAD gagal karena gangguan (bukan 404),
   hasilnya 'unknown' agar pembersihan tak pernah menghapus file valid. */
async function storedFileStatus(url) {
  const s = String(url || '');
  if (s.startsWith('/uploads/')) {
    if (!fsWritable) return 'unknown';
    const name = s.slice('/uploads/'.length);
    if (!/^[\w.\-]+$/.test(name)) return 'missing';
    try {
      const st = await fs.promises.stat(path.join(UPLOAD_DIR, name));
      return st.isFile() ? 'exists' : 'missing';
    } catch { return 'missing'; }
  }
  // file cadangan di database: cek keberadaan barisnya
  if (s.startsWith('/api/storage/dbfiles/')) {
    const id = s.slice('/api/storage/dbfiles/'.length);
    if (!/^[\w-]{1,64}$/.test(id)) return 'missing';
    try {
      const row = await db.get('SELECT id FROM db_files WHERE id = ?', id);
      return row ? 'exists' : 'missing';
    } catch { return 'unknown'; }
  }
  if (/^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\//.test(s)) {
    try {
      const r = await fetch(s, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (r.ok) return 'exists';
      if (r.status === 404 || r.status === 410) return 'missing';
      return 'unknown'; // status lain (403/405/5xx) -> tak bisa dipastikan
    } catch { return 'unknown'; } // gagal jaringan/timeout -> tak bisa dipastikan
  }
  return 'missing';
}

/* true bila file terbukti ada; false untuk lokal yang hilang.
   Untuk Blob yang 'unknown' dianggap ada (tak mau menolak pendaftaran
   hanya karena HEAD tak andal). */
async function storedFileExists(url) {
  const st = await storedFileStatus(url);
  return st !== 'missing';
}
