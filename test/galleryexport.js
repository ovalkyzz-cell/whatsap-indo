'use strict';

/* Uji Ekspor Galeri (ZIP streaming) — server sungguhan, dua port.

   A) gerbang: anon -> 401.
   B) siapkan data nyata: file di disk (nama duplikat, nama tak aman,
      file hilang), dbfiles (potongan di database), stiker dirender ulang,
      Blob tak terjangkau, dan media dari pesan yang dikirim sendiri.
   C) ekspor SEMUA -> SATU arsip ZIP valid (divalidasi python3 zipfile):
      entri per folder, nama aman + dedupe, tanpa traversal, metode STORE,
      isi identik dengan sumber, manifest.json sebagai entri terakhir
      dengan hitungan exported/skipped tepat.
   D) ekspor terpilih (item tertentu / campuran pesan) -> hanya entri itu.
   D2) alur tiket unduhan native: POST ticket -> GET stream ZIP satu-kali
       pakai (bekas -> 410 HTML), tanpa res.blob() di klien.
   E) id bodong -> 404; server kedua dengan EXPORT_MAX_ITEMS/BYTES rendah
       -> 413 jumlah & 413 ukuran (jalur batas benar-benar dieksekusi).
   F) statis: tombol/handler ekspor ada di halaman & klien. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT1 = 3462;
const PORT2 = 3463;
const ROOT = path.join(__dirname, '..');
const UP = path.join(ROOT, 'uploads');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';

const stamp = Date.now();
const EXP_PREFIX = `exp-${stamp}`;
const USER_EMAIL = `galeri${stamp}@test.local`;
const USER_PASS = 'SandiUji123';
const TMP_ZIP1 = path.join('/tmp', `rtc-galeri-${stamp}-all.zip`);
const TMP_ZIP2 = path.join('/tmp', `rtc-galeri-${stamp}-sel.zip`);
const TMP_ZIP3 = path.join('/tmp', `rtc-galeri-${stamp}-msg.zip`);
const TMP_ZIP4 = path.join('/tmp', `rtc-galeri-${stamp}-ticket.zip`);
const TMP_PAYLOAD = path.join('/tmp', `rtc-galeri-${stamp}-payload.bin`);

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

function req(base, method, urlPath, { token, body, buffer, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    let payload = null;
    if (buffer) payload = buffer;
    else if (body !== undefined) payload = Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload
          ? {
              'Content-Type': contentType || 'application/json',
              'Content-Length': String(payload.length),
            }
          : {}),
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function spawnServer(port, extraEnv = {}) {
  const child = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      BLOB_READ_WRITE_TOKEN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return {
    child,
    base: `http://127.0.0.1:${port}`,
    getLog: () => log,
    async kill() {
      child.kill('SIGTERM');
      await new Promise((s) => setTimeout(s, 250));
      try { child.kill('SIGKILL'); } catch { /* sudah mati */ }
    },
  };
}

async function waitForServer(base, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req(base, 'GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* belum siap */ }
    await new Promise((s) => setTimeout(s, 300));
  }
  throw new Error(`server ${base} tidak siap`);
}

async function adminToken(base) {
  const body = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
  const r = await req(base, 'POST', '/api/auth/login', { body });
  if (r.status === 200 && r.json && r.json.token) return r.json.token;
  throw new Error(`login admin gagal: ${r.status}`);
}

function runPython(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-c', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python3 gagal (${code}): ${err.slice(0, 400)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`keluaran python tak terbaca: ${out.slice(0, 300)}`)); }
    });
  });
}

// ---------- data uji ----------
const ids = { saved: [], dbFile: null, msg: null, chat: null };
const filesToUnlink = [];

async function setupData(base, tok) {
  console.log('\n[B] Siapkan data nyata (disk, dbfiles, stiker, blob, pesan)');
  const bytesA = Buffer.concat([Buffer.from('PNG-UJI-A|'), Buffer.from('x'.repeat(2049))]);
  const bytesB = Buffer.concat([Buffer.from('PNG-UJI-B|'), Buffer.from('y'.repeat(1025))]);
  const bytesEvil = Buffer.from(`PNG-UJI-EVIL-${stamp}`);
  const bytesGone = Buffer.from(`PNG-UJI-GONE-${stamp}`);
  const bytesMsg = Buffer.concat([Buffer.from('JPG-UJI-MSG|'), Buffer.from('m'.repeat(4097))]);
  const payload = Buffer.concat([Buffer.from('DBFIL-UJI|'), Buffer.from('z'.repeat(64 * 1024 + 13))]);

  const put = (name, buf) => {
    const p = path.join(UP, name);
    fs.writeFileSync(p, buf);
    filesToUnlink.push(p);
    return p;
  };
  const pA = put(`${EXP_PREFIX}-a.png`, bytesA);
  const pB = put(`${EXP_PREFIX}-b.png`, bytesB);
  const pEvil = put(`${EXP_PREFIX}-evil.png`, bytesEvil);
  const pGone = put(`${EXP_PREFIX}-gone.png`, bytesGone);
  const pMsg = put(`${EXP_PREFIX}-msg.jpg`, bytesMsg);
  fs.writeFileSync(TMP_PAYLOAD, payload);

  const reg = (url, name, size, mime, type) =>
    req(base, 'POST', '/api/storage/files', { token: tok, body: { url, name, size, mime, type } });

  const rA = await reg(`/uploads/${EXP_PREFIX}-a.png`, 'Foto Uji.png', bytesA.length, 'image/png', 'image');
  ok(rA.status === 201, 'daftar file A (nama "Foto Uji.png")');
  ids.saved.push(rA.json.item.id);

  const rB = await reg(`/uploads/${EXP_PREFIX}-b.png`, 'Foto Uji.png', bytesB.length, 'image/png', 'image');
  ok(rB.status === 201, 'daftar file B dengan nama sama (uji dedupe)');
  ids.saved.push(rB.json.item.id);

  const rEv = await reg(`/uploads/${EXP_PREFIX}-evil.png`, '../jelek ?.png', bytesEvil.length, 'image/png', 'image');
  ok(rEv.status === 201, 'daftar file dengan nama tak aman "../jelek ?.png"');
  ids.saved.push(rEv.json.item.id);

  const rGone = await reg(`/uploads/${EXP_PREFIX}-gone.png`, 'Hilang.png', bytesGone.length, 'image/png', 'image');
  ok(rGone.status === 201, 'daftar file yang lalu dihapus dari disk');
  ids.saved.push(rGone.json.item.id);
  fs.unlinkSync(pGone); // file fisik hilang -> wajib dilewati + dicatat manifest

  // dbfiles: init -> potongan raw -> complete
  const init = await req(base, 'POST', '/api/storage/dbfiles/init', {
    token: tok,
    body: { name: 'Dokumen DB.bin', size: payload.length, mime: 'application/octet-stream' },
  });
  ok(init.status === 201 && init.json && init.json.id, 'init unggahan dbfiles');
  const chunkPut = await req(base, 'PUT', `/api/storage/dbfiles/${init.json.id}/chunk/0`, {
    token: tok,
    buffer: payload,
    contentType: 'application/octet-stream',
  });
  ok(chunkPut.status === 200, 'unggah potongan dbfiles (raw octet-stream)');
  const comp = await req(base, 'POST', `/api/storage/dbfiles/${init.json.id}/complete`, { token: tok, body: {} });
  ok(comp.status === 200 && comp.json && comp.json.url, 'finalisasi dbfiles -> url lengkap');
  const rDb = await reg(comp.json.url, 'Dokumen DB.bin', payload.length, 'application/octet-stream', 'file');
  ok(rDb.status === 201, 'daftar dbfiles ke galeri');
  ids.saved.push(rDb.json.item.id);
  ids.dbFile = init.json.id;

  const rSt = await reg('/api/stickers/senyum.svg', 'senyum.svg', 1103, 'image/svg+xml', 'file');
  ok(rSt.status === 201, 'daftar stiker lokal (/api/stickers/senyum.svg)');
  ids.saved.push(rSt.json.item.id);

  const blobUrl = `https://galeri-tidak-ada-${stamp}.public.blob.vercel-storage.com/tak-ada.png`;
  const rBl = await reg(blobUrl, 'Tak Ada.png', 999, 'image/png', 'image');
  ok(rBl.status === 201, 'daftar Blob tak terjangkau (uji skip sumber jaringan)');
  ids.saved.push(rBl.json.item.id);

  // pesan media milik sendiri (chat + insert langsung ke database)
  const db = require(path.join(ROOT, 'server', 'db'));
  await db.ready;
  const me = await req(base, 'GET', '/api/auth/me', { token: tok });
  ids.chat = `chat_exp_${stamp}`;
  ids.msg = `msg_exp_${stamp}`;
  const now = Date.now();
  await db.run('INSERT INTO chats (id, type, created_at) VALUES (?, ?, ?)', ids.chat, 'direct', now);
  await db.run(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_size, mime, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    ids.msg, ids.chat, me.json.user.id,
    'image', `/uploads/${EXP_PREFIX}-msg.jpg`, 'Pesan Uji.jpg', bytesMsg.length, 'image/jpeg', now
  );
  ok(true, 'pesan media milik sendiri masuk database');

  return { pA, pB, pEvil, pMsg };
}

async function testGates(base) {
  console.log('\n[A] Gerbang (anon -> 401)');
  const r = await req(base, 'POST', '/api/storage/export', { body: {} });
  ok(r.status === 401, 'POST /api/storage/export anon -> 401');
}

/* Pengguna uji SEGAR: galerinya hanya berisi data buatan uji ini,
   sehingga hitungan manifest deterministik. */
async function makeFreshUser(base, adminTok) {
  const reg = await req(base, 'POST', '/api/auth/register', {
    body: { email: USER_EMAIL, password: USER_PASS, name: 'Galeri Uji' },
  });
  ok(reg.status === 201 && reg.json && reg.json.user && reg.json.user.id, 'pendaftaran pengguna uji segar');
  const apv = await req(base, 'POST', `/api/admin/users/${reg.json.user.id}/approve`, { token: adminTok, body: {} });
  ok(apv.status === 200, 'admin menyetujui pengguna uji');
  const lg = await req(base, 'POST', '/api/auth/login', { body: { email: USER_EMAIL, password: USER_PASS } });
  ok(lg.status === 200 && lg.json && lg.json.token, 'pengguna uji masuk');
  return lg.json.token;
}

const PY_ALL = `
import zipfile, json, sys
p, pa, pb, pmsg, ppay, gone_id, blob_id, pevil = sys.argv[1:9]
z = zipfile.ZipFile(p)
names = z.namelist()
info = {i.filename: i for i in z.infolist()}
def good(n):
    if n == 'manifest.json':
        return True
    parts = n.split('/')
    return len(parts) == 2 and parts[0] in ('foto','video','audio','berkas') and bool(parts[1]) and '..' not in n
c = {}
c['testzip'] = z.testzip() is None
c['magic'] = open(p,'rb').read(4) == b'PK\\x03\\x04'
c['manifest_last'] = names[-1] == 'manifest.json'
c['all_folders_ok'] = all(good(n) for n in names)
c['dup_first'] = 'foto/Foto Uji.png' in names
c['dup_second'] = 'foto/Foto Uji (2).png' in names
c['evil_sanitized'] = 'foto/_jelek _.png' in names
c['no_traversal'] = not any('..' in n for n in names)
c['db_file'] = 'berkas/Dokumen DB.bin' in names
c['sticker_file'] = 'berkas/senyum.svg' in names
c['msg_file'] = 'foto/Pesan Uji.jpg' in names
c['gone_absent'] = not any('Hilang' in n for n in names)
c['blob_absent'] = not any('Tak Ada' in n for n in names)
c['all_store'] = all(info[n].compress_type == 0 for n in names)
ca, cb = z.read('foto/Foto Uji.png'), z.read('foto/Foto Uji (2).png')
c['dup_content'] = sorted([ca, cb]) == sorted([open(pa,'rb').read(), open(pb,'rb').read()])
c['evil_content'] = z.read('foto/_jelek _.png') == open(pevil,'rb').read()
c['db_content'] = z.read('berkas/Dokumen DB.bin') == open(ppay,'rb').read()
c['sticker_is_svg'] = z.read('berkas/senyum.svg').lstrip()[:5] == b'<svg '
c['msg_content'] = z.read('foto/Pesan Uji.jpg') == open(pmsg,'rb').read()
man = json.loads(z.read('manifest.json'))
c['man_total'] = man['total'] == 8
c['man_exported'] = man['exported'] == 6
c['man_skipped'] = man['skipped'] == 2
c['man_skipped_ids'] = sorted(s['id'] for s in man['skippedItems']) == sorted([gone_id, blob_id])
c['man_items_paths'] = sorted(i['path'] for i in man['items']) == sorted(n for n in names if n != 'manifest.json')
c['man_source'] = man.get('source') == 'galeri-penyimpanan'
print(json.dumps(c))
`;

const PY_SEL = `
import zipfile, json, sys
p, want_id = sys.argv[1:3]
z = zipfile.ZipFile(p)
names = z.namelist()
man = json.loads(z.read('manifest.json'))
print(json.dumps({
  'testzip': z.testzip() is None,
  'only_one': sorted(names) == sorted(['foto/Foto Uji.png', 'manifest.json']),
  'man_total': man['total'] == 1,
  'man_exported': man['exported'] == 1,
  'man_skipped': man['skipped'] == 0,
  'man_id': man['items'][0]['id'] == want_id,
}))
`;

const PY_MSG_SEL = `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
man = json.loads(z.read('manifest.json'))
print(json.dumps({
  'testzip': z.testzip() is None,
  'only_msg': sorted(names) == sorted(['foto/Pesan Uji.jpg', 'manifest.json']),
  'man_id': man['items'][0]['kind'] == 'msg' and man['items'][0]['id'] == sys.argv[2],
}))
`;

async function testExportAll(base, tok, paths) {
  console.log('\n[C] Ekspor SEMUA -> satu arsip ZIP');
  const r = await req(base, 'POST', '/api/storage/export', { token: tok, body: {} });
  ok(r.status === 200, 'ekspor semua -> 200');
  ok(String(r.headers['content-type'] || '').includes('application/zip'), 'Content-Type application/zip');
   ok(
    /^attachment; filename="galeri-\d{4}-\d{2}-\d{2}-\d{6}\.zip"$/.test(String(r.headers['content-disposition'] || '')),
    'Content-Disposition unduhan galeri-YYYY-MM-DD-HHMMSS.zip'
  );
  ok(r.buf.length > 200 && r.buf.slice(0, 2).toString() === 'PK', 'badan respons benar-benar ZIP (magic PK)');
  ok(String(r.headers['cache-control'] || '').includes('no-store'), 'Cache-Control no-store');
  fs.writeFileSync(TMP_ZIP1, r.buf);

  const c = await runPython(PY_ALL, [
    TMP_ZIP1,
    paths.pA, paths.pB, paths.pMsg, TMP_PAYLOAD,
    ids.saved[3], ids.saved[6], paths.pEvil,
  ]);
  const labels = {
    testzip: 'python: arsip lolos testzip (CRC utuh)',
    magic: 'python: magic ZIP PK\\x03\\x04',
    manifest_last: 'python: manifest.json entri TERAKHIR',
    all_folders_ok: 'python: semua entri tepat 1 folder + tanpa ..',
    dup_first: 'python: "foto/Foto Uji.png" ada',
    dup_second: 'python: dedupe "foto/Foto Uji (2).png" ada',
    evil_sanitized: 'python: nama tak aman jadi "foto/_jelek _.png"',
    no_traversal: 'python: nol nama berisi ".."',
    db_file: 'python: entri dbfiles "berkas/Dokumen DB.bin" ada',
    sticker_file: 'python: stiker "berkas/senyum.svg" ada',
    msg_file: 'python: media pesan "foto/Pesan Uji.jpg" ada',
    gone_absent: 'python: file hilang TIDAK ada di arsip',
    blob_absent: 'python: Blob tak terjangkau TIDAK ada di arsip',
    all_store: 'python: semua entri metode STORE (0)',
    dup_content: 'python: isi kedua nama duplikat identik sumbernya',
    evil_content: 'python: isi file "jelek" identik sumbernya',
    db_content: 'python: isi dbfiles identik potongan DB',
    sticker_is_svg: 'python: stiker terekspor sebagai SVG asli',
    msg_content: 'python: isi media pesan identik sumbernya',
    man_total: 'manifest: total = 8 item',
    man_exported: 'manifest: exported = 6',
    man_skipped: 'manifest: skipped = 2 (hilang + blob)',
    man_skipped_ids: 'manifest: id yang dilewati tepat (file hilang + blob)',
    man_items_paths: 'manifest: daftar path = isi arsip (selain manifest)',
    man_source: 'manifest: source = galeri-penyimpanan',
  };
  for (const [k, label] of Object.entries(labels)) ok(c[k] === true, label);
}

async function testExportSelected(base, tok) {
  console.log('\n[D] Ekspor terpilih (item & campuran pesan)');
  const idA = ids.saved[0];
  const r1 = await req(base, 'POST', '/api/storage/export', { token: tok, body: { items: [{ kind: 'saved', id: idA }] } });
  ok(r1.status === 200 && r1.buf.slice(0, 2).toString() === 'PK', 'ekspor 1 item -> 200 berupa ZIP');
  fs.writeFileSync(TMP_ZIP2, r1.buf);
  const c1 = await runPython(PY_SEL, [TMP_ZIP2, idA]);
  ok(c1.testzip === true, 'pilihan: arsip lolos testzip');
  ok(c1.only_one === true, 'pilihan: HANYA "foto/Foto Uji.png" + manifest');
  ok(c1.man_total === true && c1.man_exported === true && c1.man_skipped === true, 'pilihan: manifest total=1 exported=1 skipped=0');
  ok(c1.man_id === true, 'pilihan: item di manifest = id yang diminta');

  const r2 = await req(base, 'POST', '/api/storage/export', { token: tok, body: { items: [{ kind: 'msg', id: ids.msg }] } });
  ok(r2.status === 200 && r2.buf.slice(0, 2).toString() === 'PK', 'ekspor media pesan terpilih -> ZIP');
  fs.writeFileSync(TMP_ZIP3, r2.buf);
  const c2 = await runPython(PY_MSG_SEL, [TMP_ZIP3, ids.msg]);
  ok(c2.testzip === true, 'campuran: arsip lolos testzip');
  ok(c2.only_msg === true, 'campuran: HANYA "foto/Pesan Uji.jpg" + manifest');
  ok(c2.man_id === true, 'campuran: kind=+id pesan tepat di manifest');

  const bad = await req(base, 'POST', '/api/storage/export', {
    token: tok,
    body: { items: [{ kind: 'saved', id: 'id-bodong-bukan-uuid' }] },
  });
  ok(bad.status === 404, 'id bodong / tak dikenal -> 404');
}

/* Alur unduhan NATIVE: tiket satu-kali -> GET stream ZIP (tanpa buffer JS).
   Membuktikan kecepatan/keandalan path baru: tiket sah sekali pakai,
   GET men-STREAM zip valid, tiket bekas -> 410 HTML, tiket bodong -> ditolak. */
async function testTicketFlow(base, tok, paths) {
  console.log('\n[D2] Tiket unduhan native (POST tiket -> GET stream ZIP)');
  const anon = await req(base, 'POST', '/api/storage/export/ticket', { body: {} });
  ok(anon.status === 401, 'POST ticket anon -> 401');

  const t = await req(base, 'POST', '/api/storage/export/ticket', {
    token: tok,
    body: { items: [{ kind: 'saved', id: ids.saved[0] }] },
  });
  ok(t.status === 200 && t.json && /^[a-f0-9]{48}$/.test(String(t.json.ticket || '')), 'ticket POST -> 200 + id 48-hex', t.json && t.json.ticket);
  ok(String(t.json.url || '').startsWith('/api/storage/export?ticket='), 'url unduhan menunjuk GET ?ticket=');
  ok(Number(t.json.expiresIn) >= 60, 'ticket punya masa berlaku');

  const g = await req(base, 'GET', String(t.json.url));
  ok(g.status === 200, 'GET ?ticket= -> 200');
  ok(String(g.headers['content-type'] || '').includes('application/zip'), 'GET: Content-Type application/zip');
  ok(/^attachment; filename="galeri-/.test(String(g.headers['content-disposition'] || '')), 'GET: Content-Disposition unduhan');
  ok(String(g.headers['cache-control'] || '').includes('no-store'), 'GET: Cache-Control no-store');
  ok(g.buf.slice(0, 2).toString() === 'PK', 'GET: badan benar-benar ZIP (stream native)');
  fs.writeFileSync(TMP_ZIP4, g.buf);
  const c = await runPython(PY_SEL, [TMP_ZIP4, ids.saved[0]]);
  ok(c.testzip === true && c.only_one === true && c.man_id === true, 'GET: arsip valid, isi sesuai pilihan, manifest benar');

  const reuse = await req(base, 'GET', String(t.json.url));
  ok(reuse.status === 410, 'ticket bekas pakai -> 410');
  ok(String(reuse.headers['content-type'] || '').includes('text/html'), '410 berupa HTML (navigasi aman, bukan JSON mentah)');

  const bogus = await req(base, 'GET', '/api/storage/export?ticket=' + 'f'.repeat(48));
  ok(bogus.status === 410, 'ticket tak dikenal -> 410');

  const malformed = await req(base, 'GET', '/api/storage/export?ticket=abc');
  ok(malformed.status === 410, 'ticket format salah -> 410');

  const noTok = await req(base, 'GET', '/api/storage/export');
  ok(noTok.status === 410, 'tanpa ticket -> 410 (tidak ada unduhan liar)');

  // ticket untuk "semua" (items null) juga bekerja
  const tall = await req(base, 'POST', '/api/storage/export/ticket', { token: tok, body: {} });
  ok(tall.status === 200 && tall.json && tall.json.url, 'ticket "semua" -> 200');
  const g2 = await req(base, 'GET', String(tall.json.url));
  ok(g2.status === 200 && g2.buf.slice(0, 2).toString() === 'PK', 'GET ticket "semua" -> ZIP valid');
}

async function testLimits() {
  console.log('\n[E] Jalur batas 413 (server terpisah, batas rendah)');
  const s2 = spawnServer(PORT2, { EXPORT_MAX_ITEMS: '3', EXPORT_MAX_BYTES: '1500' });
  let hit = false;
  try {
    await waitForServer(s2.base);
    hit = true;
    ok(true, 'server batas rendah siap');
    const lg = await req(s2.base, 'POST', '/api/auth/login', { body: { email: USER_EMAIL, password: USER_PASS } });
    ok(lg.status === 200 && lg.json && lg.json.token, 'pengguna uji masuk di server batas');
    const tok = lg.json.token;

    const all = await req(s2.base, 'POST', '/api/storage/export', { token: tok, body: {} });
    ok(all.status === 413, 'galeri > EXPORT_MAX_ITEMS -> 413');
    ok(/terlalu besar|terlalu banyak/i.test(String((all.json && all.json.error) || '')), 'pesan 413 jumlah menegaskan batas');

    const sel = await req(s2.base, 'POST', '/api/storage/export', {
      token: tok,
      body: { items: [{ kind: 'saved', id: ids.saved[0] }, { kind: 'saved', id: ids.saved[4] }] },
    });
    ok(sel.status === 413, 'total terpilih > EXPORT_MAX_BYTES -> 413');
    ok(/batas arsip/i.test(String((sel.json && sel.json.error) || '')), 'pesan 413 ukuran menegaskan batas arsip');
  } finally {
    await s2.kill();
    if (!hit) console.log('  (log server2:\n' + s2.getLog().split('\n').slice(-20).join('\n') + ')');
  }
}

async function testStatics() {
  console.log('\n[F] Statis: tombol & handler ekspor terpasang');
  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const marker of ['btnStExportAll', 'btnStBulkExport', 'st-export-btn', 'ic-archive', 'st-bulk-export', 'st-export-extra']) {
    ok(idx.includes(marker), `index.html memuat "${marker}"`);
  }
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  for (const marker of ['exportGalleryZip', 'runGalleryExport', "$('btnStExportAll')", "$('btnStBulkExport')", '/api/storage/export/ticket']) {
    ok(js.includes(marker), `app.js memuat "${marker}"`);
  }
  ok(!/await res\.blob\(\)/.test(js), 'app.js TIDAK memakai res.blob() (tanpa buffer arsip di memori)');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  ok(css.includes('.st-bulk-export'), 'style.css memuat .st-bulk-export');
  ok(css.includes('.st-export-btn'), 'style.css memuat .st-export-btn');
  const srv = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok(srv.includes("'/api/storage/export'"), 'server/index.js memuat route /api/storage/export');
  ok(srv.includes("'/api/storage/export/ticket'"), 'server/index.js memuat route ticket');
  ok(srv.includes('consumeTicket'), 'server/index.js memakai consumeTicket');
  const gz = fs.readFileSync(path.join(ROOT, 'server', 'galleryzip.js'), 'utf8');
  ok(gz.includes('createTicket') && gz.includes('consumeTicket'), 'galleryzip.js memuat tiket satu-kali');
  ok(gz.includes('openSafe'), 'galleryzip.js memakai prefetch pipelined (openSafe)');
  const zipw = fs.readFileSync(path.join(ROOT, 'server', 'zipwriter.js'), 'utf8');
  ok(zipw.includes('0x08074b50') && zipw.includes('0x02014b50'), 'zipwriter.js memuat signature data descriptor + central dir');
}

async function cleanup() {
  for (const p of filesToUnlink) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* lewati */ }
  }
  for (const p of [TMP_ZIP1, TMP_ZIP2, TMP_ZIP3, TMP_ZIP4, TMP_PAYLOAD]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* lewati */ }
  }
  try {
    const db = require(path.join(ROOT, 'server', 'db'));
    await db.ready;
    if (ids.msg) await db.run('DELETE FROM messages WHERE id = ?', ids.msg);
    if (ids.chat) await db.run('DELETE FROM chats WHERE id = ?', ids.chat);
    for (const id of ids.saved) await db.run('DELETE FROM saved_files WHERE id = ?', id);
    if (ids.dbFile) {
      await db.run('DELETE FROM db_file_chunks WHERE file_id = ?', ids.dbFile);
      await db.run('DELETE FROM db_files WHERE id = ?', ids.dbFile);
    }
    await db.run('DELETE FROM reg_logs WHERE email = ?', USER_EMAIL);
    await db.run('DELETE FROM login_logs WHERE email = ?', USER_EMAIL);
    await db.run('DELETE FROM users WHERE email = ?', USER_EMAIL);
  } catch (err) {
    console.log('  (pembersihan database dilewati:', err.message + ')');
  }
}

async function main() {
  const s1 = spawnServer(PORT1);
  let s2done = false;
  try {
    await waitForServer(s1.base);
    const adminTok = await adminToken(s1.base);
    await testGates(s1.base);
    const userTok = await makeFreshUser(s1.base, adminTok);
    const paths = await setupData(s1.base, userTok);
    await testExportAll(s1.base, userTok, paths);
    await testExportSelected(s1.base, userTok);
    await testTicketFlow(s1.base, userTok, paths);
  } finally {
    await s1.kill();
  }

  try {
    await testLimits();
    s2done = true;
    await testStatics();
  } finally {
    await cleanup();
    if (!s2done) console.log('  (log server1:\n' + s1.getLog().split('\n').slice(-30).join('\n') + ')');
  }

  console.log(`\nEkspor Galeri: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
