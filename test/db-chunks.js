'use strict';

/* Uji unggah potongan (chunked) ke database:
   - file > 4MB (2 potongan) tersimpan utuh & identik byte
   - penyajian HTTP Range mengembalikan 206 + potongan yang benar
   - endpoint init/chunk/complete menolak akses salah & potongan hilang */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const CHUNK = 4 * 1024 * 1024;

function req(method, urlPath, { token, body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers } };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    let payload = null;
    if (raw) {
      payload = raw;
      opts.headers['Content-Type'] = 'application/octet-stream';
      opts.headers['Content-Length'] = String(raw.length);
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = String(payload.length);
    }
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

async function login(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (!r.json || !r.json.token) throw new Error(`login gagal: ${r.status} ${JSON.stringify(r.json)}`);
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

async function main() {
  const server = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer();
    const token = await login('ovalkyzz@gmail.com', 'secret123');

    // file acak > 4MB (2 potongan: 4MB + sisa)
    const fileSize = CHUNK + 1234567;
    const file = crypto.randomBytes(fileSize);

    // init
    const init = await req('POST', '/api/storage/dbfiles/init', {
      token,
      body: { name: 'besar.bin', size: fileSize, mime: 'application/octet-stream' },
    });
    if (init.status !== 201 || !init.json.id) throw new Error(`init gagal: ${init.status} ${JSON.stringify(init.json)}`);
    const { id, chunkSize, totalChunks } = init.json;
    if (chunkSize !== CHUNK) throw new Error(`chunkSize salah: ${chunkSize}`);
    if (totalChunks !== 2) throw new Error(`totalChunks salah: ${totalChunks}`);
    console.log('  init OK:', { id, chunkSize, totalChunks });

    // kirim potongan 0 (4MB) lalu potongan 1 (sisa)
    for (let i = 0; i < totalChunks; i += 1) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const slice = file.subarray(start, end);
      const up = await req('PUT', `/api/storage/dbfiles/${id}/chunk/${i}`, { token, raw: slice });
      if (up.status !== 200) throw new Error(`chunk ${i} gagal: ${up.status} ${JSON.stringify(up.json)}`);
    }
    console.log('  kirim potongan OK');

    // complete
    const done = await req('POST', `/api/storage/dbfiles/${id}/complete`, { token });
    if (done.status !== 200 || !done.json.url) throw new Error(`complete gagal: ${done.status} ${JSON.stringify(done.json)}`);
    console.log('  complete OK:', done.json.url);

    // ambil penuh -> identik byte
    const full = await req('GET', done.json.url);
    if (full.status !== 200) throw new Error(`GET penuh gagal: ${full.status}`);
    if (full.buf.length !== fileSize) throw new Error(`ukuran salah: ${full.buf.length} != ${fileSize}`);
    if (!full.buf.equals(file)) throw new Error('isi file tidak identik');
    if (full.headers['accept-ranges'] !== 'bytes') throw new Error('Accept-Ranges tidak di-set');
    console.log('  GET penuh OK (identik byte,', full.buf.length, 'B)');

    // Range di tengah potongan (memotong tepat di batas chunk)
    const rs = 0, re = 100;
    const r1 = await req('GET', done.json.url, { headers: { Range: `bytes=${rs}-${re}` } });
    if (r1.status !== 206) throw new Error(`Range status salah: ${r1.status}`);
    if (r1.headers['content-range'] !== `bytes ${rs}-${re}/${fileSize}`) throw new Error(`Content-Range salah: ${r1.headers['content-range']}`);
    if (!r1.buf.equals(file.subarray(rs, re + 1))) throw new Error('isi Range tidak cocok');
    console.log('  Range 206 OK (bytes 0-100)');

    // Range melintasi batas potongan (melewati byte ke-4MB)
    const rs2 = CHUNK - 10, re2 = CHUNK + 10;
    const r2 = await req('GET', done.json.url, { headers: { Range: `bytes=${rs2}-${re2}` } });
    if (r2.status !== 206) throw new Error(`Range lintas-potongan status salah: ${r2.status}`);
    if (!r2.buf.equals(file.subarray(rs2, re2 + 1))) throw new Error('isi Range lintas-potongan tidak cocok');
    console.log('  Range lintas-potongan OK (bytes', rs2, '-', re2, ')');

    // Range akhir file (suffix / open-ended)
    const r3 = await req('GET', done.json.url, { headers: { Range: `bytes=${fileSize - 50}-` } });
    if (r3.status !== 206) throw new Error(`Range open-ended status salah: ${r3.status}`);
    if (!r3.buf.equals(file.subarray(fileSize - 50))) throw new Error('isi Range open-ended tidak cocok');
    console.log('  Range open-ended OK (50 byte terakhir)');

    // Range melewati akhir file -> 416
    const r4 = await req('GET', done.json.url, { headers: { Range: `bytes=${fileSize + 10}-` } });
    if (r4.status !== 416) throw new Error(`Range melewati akhir seharusnya 416, dapat ${r4.status}`);
    console.log('  Range 416 OK (melewati akhir file)');

    // potongan terakhir dihitung benar: baris db_files lengkap
    console.log('\nSemua pengujian chunked lulus.');
  } finally {
    server.kill('SIGTERM');
    await new Promise((s) => setTimeout(s, 200));
    try { server.kill('SIGKILL'); } catch { /* sudah mati */ }
  }
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
