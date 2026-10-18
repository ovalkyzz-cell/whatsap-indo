'use strict';

/* Ekspor galeri (drawer Penyimpanan) ke SATU arsip ZIP streaming.

   Cakupan: media milik pengguna sendiri — file tersimpan (saved_files) dan
   media dari pesan yang dikirim sendiri (messages.sender_id), sama persis
   dengan isi layar galeri. Pilihan opsional {items:[{id,kind}]}.

   Sumber media yang didukung (validChatUrl):
   - /uploads/<nama>            -> berkas di disk
   - /api/storage/dbfiles/<id>  -> potongan BLOB di database (atau kolom data lama)
   - https://*.public.blob...    -> Blob (di-stream via fetch)
   - /api/stickers/<id>.svg     -> dirender ulang oleh modul stickers

   Berkas hilang/tak didukung TIDAK menjatuhkan seluruh ekspor: dilewati dan
   dicatat di manifest.json terakhir. Satu ekspor berjalan per pengguna
   (mencegah klik ganda menggandakan beban). */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const db = require('./db');
const stickers = require('./stickers');
const zip = require('./zipwriter');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_ITEMS = Math.max(1, Number(process.env.EXPORT_MAX_ITEMS) || 5000);
const MAX_BYTES = Math.max(1024, Number(process.env.EXPORT_MAX_BYTES) || Math.floor(3.8 * 1024 ** 3));

const TYPE_DIR = { image: 'foto', video: 'video', audio: 'audio', file: 'berkas' };
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt',
  'application/json': '.json',
};

const ID_RE = /^[\w-]{1,64}$/;
const activeExports = new Set();

function placeholders(list) {
  return list.map(() => '?').join(', ');
}

function rowToItem(kind, r) {
  return {
    kind,
    id: r.id,
    url: r.media_url,
    name: r.media_name || null,
    mime: r.mime || null,
    type: r.type || 'file',
    size: Math.max(0, Number(r.media_size) || 0),
    at: Number(r.created_at) || 0,
  };
}

function limitError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function capText() {
  const gb = MAX_BYTES / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1).replace('.', ',')} GB`;
  return `${Math.max(1, Math.round(MAX_BYTES / 1024 ** 2))} MB`;
}

/* Kumpulkan baris galeri milik userId. wanted kosong/tidak ada = SEMUA.
   Melempar Error ber-status 413 bila melewati batas jumlah/ukuran. */
async function collect(userId, wanted) {
  const byKind = { saved: [], msg: [] };
  if (Array.isArray(wanted) && wanted.length) {
    for (const raw of wanted.slice(0, MAX_ITEMS + 1)) {
      const kind = raw && raw.kind === 'saved' ? 'saved' : 'msg';
      const id = String((raw && raw.id) || '');
      if (!ID_RE.test(id)) continue;
      if (byKind[kind].length < MAX_ITEMS + 1) byKind[kind].push(id);
    }
    if (!byKind.saved.length && !byKind.msg.length) return { rows: [], totalBytes: 0 };
    const rows = [];
    if (byKind.saved.length) {
      const rs = await db.all(
        `SELECT id, media_url, media_name, media_size, mime, type, created_at
           FROM saved_files
          WHERE user_id = ? AND id IN (${placeholders(byKind.saved)})
          LIMIT ${MAX_ITEMS + 1}`,
        userId, ...byKind.saved
      );
      for (const r of rs) rows.push(rowToItem('saved', r));
    }
    if (byKind.msg.length) {
      const rs = await db.all(
        `SELECT id, media_url, media_name, media_size, mime, type, created_at
           FROM messages
          WHERE sender_id = ? AND deleted_at IS NULL
            AND media_url IS NOT NULL AND id IN (${placeholders(byKind.msg)})
          LIMIT ${MAX_ITEMS + 1}`,
        userId, ...byKind.msg
      );
      for (const r of rs) rows.push(rowToItem('msg', r));
    }
    // hilangkan duplikat (klien boleh mengirim id ganda)
    const seen = new Set();
    const uniq = rows.filter((r) => {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    uniq.sort((a, b) => b.at - a.at);
    const totalBytes = uniq.reduce((sum, r) => sum + r.size, 0);
    if (uniq.length > MAX_ITEMS) throw limitError(413, `Terlalu banyak media (maks ${MAX_ITEMS})`);
    if (totalBytes > MAX_BYTES) throw limitError(413, `Total ukuran melebihi batas arsip (${capText()}) — ekspor lebih sedikit`);
    return { rows: uniq, totalBytes };
  }

  const [savedRows, msgRows] = await Promise.all([
    db.all(
      `SELECT id, media_url, media_name, media_size, mime, type, created_at
         FROM saved_files WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ${MAX_ITEMS + 1}`,
      userId
    ),
    db.all(
      `SELECT id, media_url, media_name, media_size, mime, type, created_at
         FROM messages
        WHERE sender_id = ? AND deleted_at IS NULL AND media_url IS NOT NULL
        ORDER BY created_at DESC LIMIT ${MAX_ITEMS + 1}`,
      userId
    ),
  ]);
  const rows = [
    ...savedRows.map((r) => rowToItem('saved', r)),
    ...msgRows.map((r) => rowToItem('msg', r)),
  ];
  rows.sort((a, b) => b.at - a.at);
  const totalBytes = rows.reduce((sum, r) => sum + r.size, 0);
  if (rows.length > MAX_ITEMS) throw limitError(413, `Galeri terlalu besar (${rows.length} media, maks ${MAX_ITEMS}) — ekspor lewat mode Pilih`);
  if (totalBytes > MAX_BYTES) throw limitError(413, `Total galeri melebihi batas arsip (${capText()}) — ekspor sebagian lewat mode Pilih`);
  return { rows, totalBytes };
}

// ---------- pembuka sumber (null = gagal -> dilewati) ----------

async function openLocal(url) {
  const name = url.slice('/uploads/'.length);
  if (!/^[\w.\-]+$/.test(name)) return null;
  try {
    const st = await fs.promises.stat(path.join(UPLOAD_DIR, name));
    if (!st.isFile()) return null;
    return fs.createReadStream(path.join(UPLOAD_DIR, name));
  } catch {
    return null;
  }
}

async function openDbFile(url) {
  const id = url.slice('/api/storage/dbfiles/'.length);
  if (!ID_RE.test(id)) return null;
  try {
    const row = await db.get(
      'SELECT data, size, chunk_size, total_chunks, complete FROM db_files WHERE id = ?',
      id
    );
    if (!row || !row.complete) return null;
    if (row.data && row.data.length) return Readable.from([Buffer.from(row.data)]);
    const total = Number(row.total_chunks) || 0;
    if (!(total > 0)) return null;
    const chunks = await db.all(
      'SELECT idx, data FROM db_file_chunks WHERE file_id = ? ORDER BY idx',
      id
    );
    if (chunks.length !== total) return null;
    async function* gen() {
      for (const c of chunks) yield Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data);
    }
    return Readable.from(gen());
  } catch {
    return null;
  }
}

async function openBlob(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000); // batas membuka koneksi
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!r.ok || !r.body) return null;
    const stream = Readable.fromWeb(r.body);
    clearTimeout(timer); // transfer boleh lama; timeout hanya untuk membuka
    return stream;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function openSticker(url) {
  const id = url.slice('/api/stickers/'.length).replace(/\.svg$/, '');
  if (!/^[a-z_]+$/.test(id)) return null;
  try {
    const svg = stickers.render(id);
    return svg ? Readable.from([Buffer.from(svg)]) : null;
  } catch {
    return null;
  }
}

async function openSource(url) {
  const u = String(url || '');
  if (u.startsWith('/uploads/')) return openLocal(u);
  if (u.startsWith('/api/storage/dbfiles/')) return openDbFile(u);
  if (u.startsWith('/api/stickers/')) return openSticker(u);
  if (/^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\//.test(u)) return openBlob(u);
  return null;
}

// ---------- nama berkas aman & unik di dalam arsip ----------

function safeBase(name, fallback) {
  let base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base || base === '.' || base === '..') base = fallback;
  const ext = path.extname(base).slice(0, 12);
  if (base.length > 120) base = base.slice(0, 120 - ext.length) + ext;
  if (!base || base === '.' || base === '..') base = fallback;
  return base;
}

function fallbackName(item) {
  const dirWord = TYPE_DIR[item.type] || 'berkas';
  const ext = MIME_EXT[String(item.mime || '').toLowerCase()] || '';
  return `${dirWord}-${String(item.id).slice(0, 8)}${ext}`;
}

function uniqueName(dir, base, used) {
  let full = `${dir}/${base}`;
  if (!used.has(full.toLowerCase())) {
    used.add(full.toLowerCase());
    return full;
  }
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${dir}/${stem} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const uniq = `${dir}/${stem}-${Date.now().toString(36)}${ext}`;
  used.add(uniq.toLowerCase());
  return uniq;
}

/* ---------- driver ekspor: tulis semua entri lalu tutup arsip ---------- */
async function streamZip(res, rows) {
  const sink = new zip.Sink(res);
  const entries = [];
  const exported = [];
  const skipped = [];
  const used = new Set();

  for (const item of rows) {
    if (res.writableEnded || res.destroyed) throw new Error('Klien menutup koneksi');
    let source = null;
    try {
      source = await openSource(item.url);
    } catch {
      source = null;
    }
    if (!source) {
      skipped.push({
        kind: item.kind,
        id: item.id,
        name: item.name || fallbackName(item),
        source: String(item.url || '').slice(0, 200),
        reason: 'sumber tidak tersedia / file hilang',
      });
      continue;
    }
    const dir = TYPE_DIR[item.type] || 'berkas';
    const entryName = uniqueName(dir, safeBase(item.name, fallbackName(item)), used);
    const entry = await zip.writeEntry(sink, entryName, source, new Date(item.at || Date.now()));
    entries.push(entry);
    exported.push({
      path: entryName,
      kind: item.kind,
      id: item.id,
      size: entry.size,
      at: item.at || null,
    });
  }

  const manifest = {
    product: 'RTC-Core',
    source: 'galeri-penyimpanan',
    exportedAt: new Date().toISOString(),
    total: rows.length,
    exported: exported.length,
    skipped: skipped.length,
    items: exported,
    skippedItems: skipped,
  };
  entries.push(
    await zip.writeEntry(sink, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), new Date())
  );
  await zip.finish(sink, entries);
  if (!res.writableEnded && !res.destroyed) res.end(); // tutup respons setelah EOCD
  return { exported: exported.length, skipped: skipped.length, bytes: sink.pos };
}

/* Satu ekspor aktif per pengguna. true = boleh jalan, false = sudah berjalan. */
function beginExport(userId) {
  if (activeExports.has(userId)) return false;
  activeExports.add(userId);
  return true;
}

function endExport(userId) {
  activeExports.delete(userId);
}

module.exports = {
  MAX_ITEMS,
  MAX_BYTES,
  collect,
  streamZip,
  beginExport,
  endExport,
};
