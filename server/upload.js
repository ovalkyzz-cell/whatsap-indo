'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('./auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const useBlob = Boolean(BLOB_TOKEN);

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
  upload.single('file')(req, res, (err) => {
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

    if (!useBlob) {
      return res.status(201).json({ url: `/uploads/${req.file.filename}`, ...meta });
    }

    const ext = path.extname(req.file.originalname).slice(0, 16);
    const pathname = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const { put } = require('@vercel/blob');
    put(pathname, req.file.buffer, {
      access: 'public',
      token: BLOB_TOKEN || undefined,
      addRandomSuffix: true,
      contentType: req.file.mimetype || undefined,
    })
      .then((object) => res.status(201).json({ url: object.url, ...meta }))
      .catch((blobErr) => {
        console.error('upload blob:', blobErr.message);
        res.status(500).json({ error: 'Gagal menyimpan file' });
      });
  });
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

async function storeBuffer(buffer, kind, filename) {
  if (!storageEnabled || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const limit = REMOTE_LIMITS[kind] || REMOTE_LIMITS.file;
  if (buffer.length > limit) return null;
  const name = safeName(filename, kind);
  if (!looksLike(buffer, kind, name)) return null;
  const ext = safeExt(name, kind);
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
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

module.exports = { router, UPLOAD_DIR, MAX_FILE_SIZE, storageEnabled, useBlob, storeBuffer, storeRemoteFile };
