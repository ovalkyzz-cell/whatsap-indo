'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

module.exports = { router, UPLOAD_DIR, MAX_FILE_SIZE, storageEnabled, useBlob };
