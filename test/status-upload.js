'use strict';

/* Uji unggah media Status WA (foto & video) — dua bagian:

   A) logika klien `uploadFile` yang sebenarnya diekstrak dari public/js/app.js
      dan dijalankan dengan stub, memastikan jalur yang dipilih benar:
      - Blob rusak (500) + file > 4MB -> potongan (dulunya 413, bug status)
      - mode lokal (501)            -> multipart ke server (disk 2GB)
      - file kecil + server 413     -> cadangan potongan
      - presigned gagal / PUT Blob gagal -> potongan

   B) server sungguhan dengan BLOB_READ_WRITE_TOKEN tak valid, meniru kondisi
      produksi (store disuspend): tanda tangan 500, multipart 5MB 413,
      tetapi jalur potongan tetap menghasilkan URL yang bisa diputar, lalu
      status foto & video terposting dan muncul di /api/status. */

const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 3458;
const BASE = `http://127.0.0.1:${PORT}`;
const CHUNK = 4 * 1024 * 1024;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';
// token Blob tak valid: SDK @vercel/blob melempar 'Access denied'
// (perilaku sama seperti store produksi yang disuspend)
const BAD_BLOB_TOKEN = 'vcp_uji-blokir-untuk-pengujian-0000';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

/* ---------- A. logika klien: blok uploadFile asli dari app.js ---------- */

function loadUploadFns({ sign, putPresigned, xhr }) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf('function uploadViaServer');
  const end = src.indexOf('async function uploadAndSend');
  if (start < 0 || end <= start) throw new Error('blok uploadFile tidak ditemukan di public/js/app.js');

  const calls = { chunked: 0, server: 0, presigned: 0 };
  const sandbox = {
    S: { token: 'uji' },
    api: sign,
    putPresigned: putPresigned || (async () => { calls.presigned += 1; return { url: 'https://blob/p' }; }),
    uploadFileChunked: async () => { calls.chunked += 1; return { url: '/api/storage/dbfiles/uji' }; },
    FormData: class { append() {} },
    XMLHttpRequest: xhr,
  };
  vm.runInNewContext(src.slice(start, end), sandbox, { filename: 'app-upload-block.js' });
  return { uploadFile: sandbox.uploadFile, calls };
}

// XMLHttpRequest tiruan yang mencatat URL tujuan & membalas sesuai skenario
function makeXhr(record, reply) {
  return class FakeXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = '{}'; }
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    send() {
      if (this.url === '/api/upload') record.server += 1;
      const r = reply(this.url);
      Promise.resolve().then(() => {
        this.status = r.status;
        this.responseText = JSON.stringify(r.json || {});
        if (this.onload) this.onload();
      });
    }
  };
}

const signFailed = (status) => async () => {
  const err = new Error(`Error ${status}`);
  err.status = status;
  throw err;
};
const file = (size, type = 'video/mp4') => ({ name: 'status.mp4', size, type });

async function testClientRouting() {
  console.log('\n[A] logika klien uploadFile (kode asli dari public/js/app.js)');

  // A1. Blob rusak (500) + 5MB -> wajib potongan, jangan multipart (dulunya 413)
  {
    const rec = { server: 0 };
    const { uploadFile, calls } = loadUploadFns({ sign: signFailed(500), xhr: makeXhr(rec, () => ({ status: 413, json: { error: 'File terlalu besar untuk hosting (maksimal 4MB)' } })) });
    const r = await uploadFile(file(CHUNK + 1));
    ok(r.url === '/api/storage/dbfiles/uji', 'Blob rusak + 5MB -> memakai unggah potongan');
    ok(calls.chunked === 1 && calls.server === 0, 'Blob rusak + 5MB -> tidak lewat multipart (bug status)');
  }

  // A2. mode lokal (501) -> multipart ke server, potongan tidak dipakai
  {
    const rec = { server: 0 };
    const { uploadFile, calls } = loadUploadFns({ sign: signFailed(501), xhr: makeXhr(rec, () => ({ status: 201, json: { url: '/uploads/lokal.png' } })) });
    const r = await uploadFile(file(CHUNK + 1, 'image/png'));
    ok(calls.chunked === 0 && rec.server === 1, 'mode lokal (501) + 5MB -> unggah multipart ke disk');
    ok(r.url === '/uploads/lokal.png', 'mode lokal -> URL /uploads/ dikembalikan utuh');
  }

  // A3. Blob rusak + file kecil -> multipart dulu (server 201 lewat cadangan DB)
  {
    const rec = { server: 0 };
    const { uploadFile, calls } = loadUploadFns({ sign: signFailed(500), xhr: makeXhr(rec, () => ({ status: 201, json: { url: '/api/storage/dbfiles/kecil' } })) });
    const r = await uploadFile(file(1024 * 1024, 'image/jpeg'));
    ok(rec.server === 1 && calls.chunked === 0, 'Blob rusak + 1MB -> multipart lebih dulu');
    ok(r.url === '/api/storage/dbfiles/kecil', 'file kecil tersimpan lewat cadangan database');
  }

  // A4. Blob rusak + file kecil tapi server menolak 413 -> cadangan potongan
  {
    const rec = { server: 0 };
    const { uploadFile, calls } = loadUploadFns({ sign: signFailed(500), xhr: makeXhr(rec, () => ({ status: 413, json: { error: 'File terlalu besar untuk hosting (maksimal 4MB)' } })) });
    const r = await uploadFile(file(2 * 1024 * 1024, 'image/jpeg'));
    ok(rec.server === 1 && calls.chunked === 1, 'server 413 -> jatuh ke unggah potongan');
    ok(r.url === '/api/storage/dbfiles/uji', 'cadangan potongan mengembalikan URL dbfiles');
  }

  // A5. Blob rusak + server 500 -> tetap dicoba potongan
  {
    const rec = { server: 0 };
    const { uploadFile } = loadUploadFns({ sign: signFailed(500), xhr: makeXhr(rec, () => ({ status: 500, json: { error: 'Gagal menyimpan file' } })) });
    const r = await uploadFile(file(1024 * 1024, 'image/png'));
    ok(r.url === '/api/storage/dbfiles/uji', 'server 500 -> unggah potongan sebagai penyelamat');
  }

  // A6. tanda tangan OK tapi PUT presigned gagal -> potongan
  {
    const { uploadFile, calls } = loadUploadFns({
      sign: async () => ({ presignedUrl: 'https://blob/put', name: 'a.mp4', mime: 'video/mp4', type: 'video' }),
      putPresigned: async () => { throw new Error('store disuspend'); },
      xhr: makeXhr({ server: 0 }, () => ({ status: 200, json: {} })),
    });
    const r = await uploadFile(file(CHUNK + 1));
    ok(calls.chunked === 1 && r.url === '/api/storage/dbfiles/uji', 'PUT presigned gagal -> unggah potongan');
  }

  // A7. presigned sukses -> langsung ke Blob, tanpa jalur lain
  {
    const rec = { server: 0 };
    const { uploadFile, calls } = loadUploadFns({
      sign: async () => ({ presignedUrl: 'https://blob/put', name: 'a.mp4', mime: 'video/mp4', type: 'video' }),
      xhr: makeXhr(rec, () => ({ status: 200, json: {} })),
    });
    const r = await uploadFile(file(CHUNK + 1));
    ok(calls.presigned === 1 && calls.chunked === 0 && rec.server === 0, 'presigned sukses -> hanya PUT langsung ke Blob');
    ok(r.url === 'https://blob/p', 'URL Blob dikembalikan');
  }
}

/* ---------- B. server sungguhan dengan Blob tak tersedia ---------- */

function req(method, urlPath, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function login() {
  let r = await req('POST', '/api/auth/register', { body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD } });
  if (r.status !== 201) r = await req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!r.json || !r.json.token) throw new Error(`login admin gagal: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* belum siap */ }
    await new Promise((s) => setTimeout(s, 300));
  }
  throw new Error('server tidak siap');
}

// unggah multipart sungguhan lewat fetch/FormData
async function uploadMultipart(token, buf, name, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function chunkedUpload(token, buf, name, mime) {
  const init = await req('POST', '/api/storage/dbfiles/init', {
    token,
    body: { name, size: buf.length, mime },
  });
  if (init.status !== 201 || !init.json.id) throw new Error(`init gagal: ${init.status} ${JSON.stringify(init.json)}`);
  const { id, chunkSize, totalChunks } = init.json;
  for (let i = 0; i < totalChunks; i += 1) {
    const slice = buf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buf.length));
    const up = await putChunk(token, id, i, slice);
    if (up.status !== 200) throw new Error(`chunk ${i} gagal: ${up.status}`);
  }
  const done = await req('POST', `/api/storage/dbfiles/${id}/complete`, { token });
  if (done.status !== 200 || !done.json.url) throw new Error(`complete gagal: ${done.status}`);
  return { id, url: done.json.url };
}

function putChunk(token, id, idx, slice) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/storage/dbfiles/${id}/chunk/${idx}`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(slice.length),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.write(slice);
    r.end();
  });
}

async function testProductionLikeServer() {
  console.log('\n[B] server dengan Blob tak tersedia (meniru kondisi produksi)');

  const server = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: BAD_BLOB_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer();
    const token = await login();

    // B1. tanda tangan presigned gagal -> 500 (persis produksi: store disuspend)
    const sign = await req('POST', '/api/uploads/sign', {
      token,
      body: { name: 'status.mp4', size: CHUNK + 1, mime: 'video/mp4' },
    });
    ok(sign.status === 500, `POST /api/uploads/sign -> ${sign.status} (Blob tak tersedia, seperti produksi)`);

    // B2. jalur multipart lama menolak file 5MB -> inilah bug status
    const big = crypto.randomBytes(CHUNK + 512 * 1024);
    const bigUp = await uploadMultipart(token, big, 'besar.mp4', 'video/mp4');
    ok(bigUp.status === 413, `multipart 5MB -> ${bigUp.status} (jalur lama gagal untuk video besar)`);

    // B3. file kecil tetap lolos lewat cadangan database
    const small = crypto.randomBytes(1024 * 1024);
    const smallUp = await uploadMultipart(token, small, 'kecil.jpg', 'image/jpeg');
    ok(smallUp.status === 201 && smallUp.json.url, `multipart 1MB -> ${smallUp.status} (cadangan database)`);
    const smallUrl = smallUp.json && smallUp.json.url;

    // B4. jalur potongan tetap bekerja walau Blob mati
    const chunked = await chunkedUpload(token, big, 'status.mp4', 'video/mp4');
    ok(!!chunked.url, `unggah potongan 5MB -> ${chunked.url}`);

    const full = await fetch(`${BASE}${chunked.url}`);
    ok(full.status === 200, `GET media potongan -> ${full.status}`);
    const ranged = await fetch(`${BASE}${chunked.url}`, { headers: { Range: 'bytes=0-99' } });
    ok(ranged.status === 206, `Range (seek video) -> ${ranged.status}`);

    // B5. status video terposting memakai URL potongan
    const postVideo = await req('POST', '/api/status', {
      token,
      body: { type: 'video', media: { url: chunked.url, name: 'status.mp4', mime: 'video/mp4' }, body: 'Video uji status' },
    });
    ok(postVideo.status === 201 && postVideo.json.status && postVideo.json.status.type === 'video', `POST status video -> ${postVideo.status}`);

    // B6. status foto terposting memakai hasil multipart kecil
    const postImage = await req('POST', '/api/status', {
      token,
      body: { type: 'image', media: { url: smallUrl, name: 'kecil.jpg', mime: 'image/jpeg' }, body: 'Foto uji status' },
    });
    ok(postImage.status === 201 && postImage.json.status && postImage.json.status.type === 'image', `POST status foto -> ${postImage.status}`);

    // B7. keduanya muncul di feed status pemilik & medianya bisa dimuat
    const feed = await req('GET', '/api/status', { token });
    const mine = ((feed.json && feed.json.groups) || []).find((g) => g.isSelf);
    const urls = mine ? mine.statuses.map((s) => s.mediaUrl) : [];
    ok(feed.status === 200 && mine, 'GET /api/status -> grup status sendiri ada');
    ok(urls.includes(chunked.url), 'status video muncul di feed dengan URL potongan');
    ok(urls.includes(smallUrl), 'status foto muncul di feed dengan URL hasil multipart');

    const viewVideo = await fetch(`${BASE}${chunked.url}`, { headers: { Range: 'bytes=10-19' } });
    ok(viewVideo.status === 206, `media status video bisa di-seek -> ${viewVideo.status}`);

    // B8. URL media sembarangan ditolak
    const bad = await req('POST', '/api/status', {
      token,
      body: { type: 'image', media: { url: 'https://contoh.com/x.png', name: 'x.png', mime: 'image/png' }, body: 'tidak sah' },
    });
    ok(bad.status === 400, `media URL asing ditolak -> ${bad.status}`);

    // B9. status tekstual tetap jalan (regresi)
    const text = await req('POST', '/api/status', { token, body: { type: 'text', body: 'Status teks uji' } });
    ok(text.status === 201, `POST status teks -> ${text.status}`);

    // bersihkan status yang dibuat test ini
    for (const st of [postVideo.json && postVideo.json.status, postImage.json && postImage.json.status, text.json && text.json.status]) {
      if (st && st.id) await req('DELETE', `/api/status/${st.id}`, { token });
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise((s) => setTimeout(s, 250));
    try { server.kill('SIGKILL'); } catch { /* sudah mati */ }
    if (fail) console.log('\nlog server:\n' + serverLog.split('\n').filter((l) => /sign:|upload blob|status/i.test(l)).join('\n'));
  }
}

async function main() {
  await testClientRouting();
  await testProductionLikeServer();
  console.log(`\nStatus upload: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
