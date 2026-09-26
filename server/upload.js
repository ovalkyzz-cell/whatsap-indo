'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('./auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 16);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
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

router.post('/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Ukuran file maksimal 2GB' });
      }
      return res.status(400).json({ error: err.message || 'Upload gagal' });
    }
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });

    res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype || 'application/octet-stream',
      type: classify(req.file.mimetype || '', req.file.originalname),
    });
  });
});

module.exports = { router, UPLOAD_DIR, MAX_FILE_SIZE };
