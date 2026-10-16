'use strict';

/* ============================================================
   RTC-Core Vault — enkripsi data privasi saat istirahat (at rest)
   ------------------------------------------------------------
   AES-256-GCM dengan prefix penanda "RTC1:" supaya:
   • Data lama (plaintext, tanpa prefix) tetap terbaca (migrasi malas).
   • Data baru tersimpan terenkripsi sehingga kebocoran berkas
     database / backup tidak serta-merta membocorkan isi percakapan.
   Kunci diambil dari ENCRYPTION_KEY (base64/hex 32 byte) atau
   dibuat & disimpan persistent di data/.enc-key (mode 0600).
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'RTC1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce (rekomendasi GCM)
const TAG_LEN = 16;
const KEY_LEN = 32;

let key = null;
let keySource = 'unset';
let warned = false;

function loadKey() {
  if (key) return key;

  const envKey = String(process.env.ENCRYPTION_KEY || '').trim();
  if (envKey) {
    try {
      // terima base64 maupun hex; langsung atau derive
      let raw = null;
      if (/^[0-9a-f]{64}$/i.test(envKey)) raw = Buffer.from(envKey, 'hex');
      else raw = Buffer.from(envKey, 'base64');
      if (raw.length === KEY_LEN) {
        key = raw;
        keySource = 'env';
        return key;
      }
      // panjang tidak 32 byte -> derive deterministik agar tetap aman & stabil
      key = crypto.scryptSync(envKey, 'rtc-core-vault-salt', KEY_LEN);
      keySource = 'env-derived';
      return key;
    } catch { /* jatuh ke berkas */ }
  }

  if (process.env.VERCEL) {
    // Lingkungan serverless tidak punya filesystem persistent yang bisa diandalkan
    // antar cold start: derive dari JWT_SECRET bila ada (stabil selama secret tetap),
    // supaya enkripsi tetap hidup dan tidak merusak data yang sudah terenkripsi.
    const anchor = String(process.env.JWT_SECRET || '').trim();
    if (anchor.length >= 16) {
      key = crypto.scryptSync(anchor, 'rtc-core-vault-salt', KEY_LEN);
      keySource = 'vercel-derived';
      return key;
    }
    if (!warned) {
      warned = true;
      console.error('[vault] ENCRYPTION_KEY & JWT_SECRET kosong: kunci acak per proses (data terenkripsi bisa tak terbaca setelah cold start)');
    }
    key = crypto.randomBytes(KEY_LEN);
    keySource = 'volatile';
    return key;
  }

  const file = path.join(__dirname, '..', 'data', '.enc-key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    const raw = /^[0-9a-f]{64}$/i.test(existing)
      ? Buffer.from(existing, 'hex')
      : Buffer.from(existing, 'base64');
    if (raw.length === KEY_LEN) {
      key = raw;
      keySource = 'file';
      return key;
    }
  } catch { /* belum ada */ }

  const fresh = crypto.randomBytes(KEY_LEN);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('hex'), { mode: 0o600 });
    keySource = 'file-created';
  } catch {
    keySource = 'memory';
  }
  key = fresh;
  return key;
}

// Tandai nilai sebagai terenkripsi: RTC1:<iv b64>:<tag b64>:<ct b64>
function encrypt(plain) {
  if (plain === null || plain === undefined) return plain;
  const text = String(plain);
  if (text === '') return text;
  const k = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

// Kembalikan plaintext. Nilai tanpa prefix dianggap data lama (plaintext).
function decrypt(stored) {
  if (stored === null || stored === undefined) return stored;
  const text = String(stored);
  if (!text.startsWith(PREFIX)) return text;
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return text; // korup -> biarkan apa adanya
  try {
    const [ivB, tagB, ctB] = parts;
    const iv = Buffer.from(ivB, 'base64');
    const tag = Buffer.from(tagB, 'base64');
    const ct = Buffer.from(ctB, 'base64');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return text;
    const k = loadKey();
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Gagal decrypt (kunci berubah / data rusak) -> jangan crash; tampilkan marker aman
    return '';
  }
}

// true bila nilai sudah terenkripsi
function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// Amankan objek baris: dekripsi daftar kolom tertentu in-place (untuk jalur baca)
function revealRow(row, columns) {
  if (!row) return row;
  for (const col of columns || []) {
    if (col in row) row[col] = decrypt(row[col]);
  }
  return row;
}

// Amankan objek baris: enkripsi da kolom tertentu in-place (untuk jalur tulis)
function sealRow(row, columns) {
  if (!row) return row;
  for (const col of columns || []) {
    if (col in row && row[col] !== null && row[col] !== undefined) row[col] = encrypt(row[col]);
  }
  return row;
}

function info() {
  loadKey();
  return { algo: ALGO, keySource };
}

// Pesan kolom terenkripsi (dipakai DB & admin)
const MESSAGE_COLUMNS = ['body', 'reply_preview'];

module.exports = {
  PREFIX,
  encrypt,
  decrypt,
  isEncrypted,
  revealRow,
  sealRow,
  info,
  MESSAGE_COLUMNS,
};
