'use strict';
/* Penyimpanan objek dingin lewat GitHub Releases (repo private).
   Setiap file dipecah menjadi potongan yang diunggah sebagai aset rilis;
   metadata (db_files + db_file_parts) tetap di Postgres. Kombinasi ini
   bertahan lama: tidak bergantung pada kuota Vercel Blob dan tidak ikut
   rotasi database Neon yang berumur 72 jam — cukup simpan URL-nya. */

const zlib = require('zlib');
const db = require('./db');

const OWNER = process.env.GH_STORAGE_OWNER || 'ovalkyzz-cell';
const REPO = process.env.GH_STORAGE_REPO || 'whatsap-media';
const TOKEN = process.env.GITHUB_STORAGE_TOKEN || '';
const API = 'https://api.github.com';
// unggah aset memakai host khusus uploads.github.com (api.github.com 404)
const UPLOADS = 'https://uploads.github.com';

function enabled() {
  return Boolean(TOKEN);
}

async function gh(pathname, init) {
  const opts = init || {};
  const headers = Object.assign(
    {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'whatsap-storage',
    },
    opts.headers
  );
  const base = opts._uploads ? UPLOADS : API;
  const rest = Object.assign({}, opts);
  delete rest._uploads;
  const res = await fetch(base + pathname, Object.assign(rest, { headers }));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub ${res.status} ${pathname}: ${String(body).slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('json')) return res.json();
  return res;
}

let releaseCache = null;

async function createRelease() {
  const tag = 'cold-' + Date.now().toString(36);
  const rel = await gh(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: 'Media dingin', make_latest: 'false' }),
  });
  const val = JSON.stringify({ id: rel.id, tag: rel.tag_name });
  try {
    await db.run(
      `INSERT INTO gh_storage (k, v) VALUES ('release_id', ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      val
    );
  } catch (err) {
    console.error('gh release simpan:', err.message);
  }
  releaseCache = { id: rel.id, tag: rel.tag_name };
  return releaseCache;
}

async function ensureRelease() {
  if (releaseCache) return releaseCache;
  try {
    const row = await db.get('SELECT v FROM gh_storage WHERE k = ?', 'release_id');
    if (row && row.v) {
      const saved = JSON.parse(row.v);
      const rel = await gh(`/repos/${OWNER}/${REPO}/releases/${saved.id}`);
      releaseCache = { id: rel.id, tag: rel.tag_name };
      return releaseCache;
    }
  } catch (err) {
    console.error('gh release muat:', err.message);
  }
  return createRelease();
}

/* Unggah satu potongan sebagai aset rilis. Nama aset unik per file+indeks,
   jadi unggah ulang (retry) berarti menimpa: aset lama dihapus lebih dulu. */
async function uploadPart(fileId, idx, bytes) {
  const rel = await ensureRelease();
  const name = `${fileId}.${idx}`;
  const doUpload = (releaseId) =>
    gh(
      `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
        },
        body: bytes,
        _uploads: true,
      }
    );
  try {
    const asset = await doUpload(rel.id);
    return asset.id;
  } catch (err) {
    if (err.status !== 422) throw err;
    // 422: kemungkinan nama aset bentrok (retry) atau rilis penuh
    let old = null;
    try {
      const assets = await gh(`/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?per_page=100`);
      if (Array.isArray(assets)) old = assets.find((a) => a.name === name) || null;
    } catch { /* lanjut */ }
    if (old) {
      await gh(`/repos/${OWNER}/${REPO}/releases/assets/${old.id}`, { method: 'DELETE' });
      return (await doUpload(rel.id)).id;
    }
    const fresh = await createRelease();
    return (await doUpload(fresh.id)).id;
  }
}

/* Unduh seluruh isi satu potongan. GitHub me-redirect ke URL bertanda tangan;
   header Authorization otomatis dibuang pada redirect lintas-origin. */
async function downloadAsset(assetId) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/assets/${assetId}`, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'whatsap-storage',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GitHub aset ${assetId}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* Hapus aset; tidak pernah melempar galat (dipakai saat pembersihan). */
async function deleteAsset(assetId) {
  try {
    await gh(`/repos/${OWNER}/${REPO}/releases/assets/${assetId}`, { method: 'DELETE' });
  } catch { /* sudah hilang / tak terjangkau — bukan masalah */ }
}

function compressBuf(buf) {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function decompressBuf(buf) {
  return new Promise((resolve, reject) => {
    zlib.zstdDecompress(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

module.exports = { enabled, uploadPart, downloadAsset, deleteAsset, compressBuf, decompressBuf };
