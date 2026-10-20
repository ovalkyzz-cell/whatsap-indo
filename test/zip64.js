'use strict';

/* Uji ZIP64 (server/zipwriter.js) — jaminan bahwa ekspor TANPA batas ukuran
   benar-benar menghasilkan arsip yang sah.

   [A] arsip kecil: WAJIB selalu-ZIP64 (ukuran 0xFFFFFFFF + extra 0x0001),
       divalidasi python3 zipfile DAN unzip -t.
   [B] >65535 entri: sentinel jumlah entri di EOCD klasik, jumlah asli di
       ZIP64 EOCD, isi seluruh entri lulus testzip() python.
   [C] arsip >4 GiB: divalidasi parser independen (python3) lewat berkas
       SPARSE — hanya header awal & tail (central directory + EOCD) yang
       disimpan nyata, sisanya lubang, jadi offset 64-bit NYATA terbaca
       tanpa mengisi disk (mesin ini tinggal ~5 GB).
   [D] entri tunggal >4 GiB sungguhan ke disk: hanya bila ZIP64_BIG=1
       (butuh ~5 GB kosong), hasilnya divalidasi python testzip() penuh.
   [E] timestamp rusak (1970, NaN, tahun 2300) tidak menjatuhkan ekspor —
       regresi: DOS date hanya mewakili 1980..2107 dan dulu melempar.

   Jalankan: node test/zip64.js
*/

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const zlib = require('zlib');
const zip = require('../server/zipwriter');

const TMP = path.join('/tmp', `rtc-zip64-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

// ---------- util ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} keluar ${code}: ${err || out}`))));
  });
}

async function pyJson(code) {
  return JSON.parse(await run('python3', ['-c', code]));
}

// sink menangkap hanya head (8 KB pertama) & tail (256 KB terakhir), sisanya
// dibuang — O(1) memori & O(1) disk meski arsip virtualnya >4 GiB
class CaptureSink {
  constructor(headLen, tailLen) {
    this.headCap = headLen;
    this.tailCap = tailLen;
    this.head = Buffer.alloc(headLen);
    this.headN = 0;
    this.parts = [];
    this.tailN = 0;
    this.pos = 0;
  }

  write(buf) {
    if (this.headN < this.headCap) {
      const n = Math.min(buf.length, this.headCap - this.headN);
      buf.copy(this.head, this.headN, 0, n);
      this.headN += n;
    }
    this.parts.push(buf);
    this.tailN += buf.length;
    while (this.tailN > this.tailCap) this.tailN -= this.parts.shift().length;
    this.pos += buf.length;
    return true;
  }

  tail() {
    return Buffer.concat(this.parts, this.tailN);
  }
}

function fileSink(file) {
  const raw = {
    fd: fs.openSync(file, 'w'),
    // tulis penuh lalu selalu 'true' — file biasa tak punya event 'drain'
    write(buf) {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off);
      return true;
    },
  };
  const sink = new zip.Sink(raw);
  sink.close = () => fs.closeSync(raw.fd);
  return sink;
}

function closeSink(s) {
  if (s.close) s.close();
}

// sumber nol (zeros) terpadu ulang — O(1) memori, CRC tetap dihitung native
function zerosSource(bytes, chunkSize = 1 << 23) {
  const buf = Buffer.alloc(chunkSize);
  return (async function* gen() {
    let left = bytes;
    while (left > 0) {
      const n = Math.min(left, chunkSize);
      yield n === chunkSize ? buf : buf.subarray(0, n);
      left -= n;
    }
  }());
}

const r32 = (b, off) => b.readUInt32LE(off);

// urutan byte signature little-endian (PK\x03\x04, dst.) — jangan tertukar
// dengan urutan nilai heksadesimalnya
const SIG = {
  local: Buffer.from('504b0304', 'hex'),
  eocd: Buffer.from('504b0506', 'hex'),
  zip64: Buffer.from('504b0606', 'hex'),
  locator: Buffer.from('504b0607', 'hex'),
  descriptor: Buffer.from('504b0708', 'hex'),
};
// setelah central dir: ZIP64 EOCD (56) + locator (20) + EOCD klasik (22)
const TAIL_OVERHEAD = 98;

// ---------- [A] arsip kecil selalu-ZIP64 ----------
async function testSmall() {
  console.log('\n[A] arsip kecil selalu-ZIP64');
  const file = path.join(TMP, 'kecil.zip');
  const sink = fileSink(file);
  const entries = [];
  try {
    entries.push(await zip.writeEntry(sink, 'foto/ujian.txt', Buffer.from('isi ujian\n'), new Date('2026-10-20')));
    entries.push(await zip.writeEntry(sink, 'video/klip.bin', Buffer.alloc(300, 7), new Date('2026-01-02')));
    entries.push(await zip.writeEntry(sink, 'berkas/a.txt', Buffer.from('a'), new Date('2026-01-03')));
    entries.push(await zip.writeEntry(sink, 'berkas/b.txt', Buffer.from('b'), new Date('2026-01-04')));
    entries.push(await zip.writeEntry(sink, 'manifest.json', Buffer.from('{"ok":true}'), new Date()));
    await zip.finish(sink, entries);
  } finally {
    closeSink(sink);
  }

  const head = fs.readFileSync(file);
  ok(r32(head, 0) === 0x04034b50, 'local header signature benar');
  ok(head.readUInt16LE(4) === 45, 'local header meminta versi 45 (zip64)');
  ok(head.readUInt16LE(6) === 0x0808, 'flag UTF-8 + data descriptor aktif');
  ok(head.readUInt16LE(8) === 0, 'metode STORE');
  ok(r32(head, 18) === 0xffffffff, 'ukuran kompresi lokal = 0xFFFFFFFF (zip64)');
  ok(r32(head, 22) === 0xffffffff, 'ukuran asli lokal = 0xFFFFFFFF (zip64)');
  ok(head.readUInt16LE(28) === 20, 'extra lokal = zip64 20 byte');

  const tail = head.subarray(head.length - 22);
  ok(r32(tail, 0) === 0x06054b50, 'EOCD klasik ada di akhir');
  ok(head.includes(SIG.zip64), 'ZIP64 EOCD ada di arsip');
  ok(head.includes(SIG.locator), 'ZIP64 EOCD locator ada');
  ok(head.includes(SIG.descriptor), 'data descriptor pakai signature');

  const meta = await pyJson(
    `import zipfile,sys,json
z=zipfile.ZipFile(${JSON.stringify(file)})
bad=z.testzip()
i=z.infolist()
print(json.dumps({'bad':bad,'n':len(i),'names':z.namelist(),'ok':z.read('foto/ujian.txt')==b'isi ujian\\n','man':z.read('manifest.json').decode()=='{"ok":true}','stored':all(x.compress_type==zipfile.ZIP_STORED for x in i)}))`
  );
  ok(meta.bad === null, 'python testzip: seluruh CRC utuh');
  ok(meta.n === 5 && meta.ok === true && meta.man === true, 'isi entri identik dengan sumber');
  ok(meta.stored === true, 'semua entri metode STORE');

  const un = await run('unzip', ['-t', file]);
  ok(/No errors detected/.test(un), 'unzip -t: tanpa error (Info-ZIP menerima zip64)');
}

// ---------- [B] >65535 entri ----------
async function testManyEntries() {
  console.log('\n[B] arsip dengan lebih dari 65535 entri');
  const COUNT = 66000;
  const file = path.join(TMP, 'banyak.zip');
  const sink = fileSink(file);
  const entries = [];
  try {
    for (let i = 0; i < COUNT; i += 1) {
      entries.push(await zip.writeEntry(sink, `f/${i}.txt`, Buffer.from(`e${i}`), new Date(1700000000000 + i * 1000)));
    }
    await zip.finish(sink, entries);
  } finally {
    closeSink(sink);
  }

  const st = fs.statSync(file);
  const tail = Buffer.alloc(22);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, tail, 0, 22, st.size - 22);
  fs.closeSync(fd);

  ok(r32(tail, 0) === 0x06054b50, 'EOCD klasik valid');
  ok(tail.readUInt16LE(8) === 0xffff, 'jumlah entri EOCD klasik = sentinel 0xFFFF');
  ok(tail.readUInt16LE(10) === 0xffff, 'jumlah entri kumulatif = sentinel 0xFFFF');
  // jumlah entri melampaui 16-bit, tetapi ukuran/offset CD masih muat 32-bit
  // -> field yang muat tetap diisi nilai asli (boleh menurut spesifikasi)
  const cdSize = r32(tail, 12);
  const cdStart = r32(tail, 16);
  ok(cdSize > 0 && cdSize < 0xffffffff, 'ukuran central dir tetap nilai asli (muat 32-bit)');
  ok(cdStart > 0 && cdStart < 0xffffffff, 'offset central dir tetap nilai asli (muat 32-bit)');
  ok(cdStart + cdSize + TAIL_OVERHEAD === st.size, 'cdStart + cdSize + EOCD/zip64 == ukuran arsip');

  const meta = await pyJson(
    `import zipfile,json
z=zipfile.ZipFile(${JSON.stringify(file)})
i=z.infolist()
print(json.dumps({'n':len(i),'bad':z.testzip(),'first':i[0].filename,'last':i[-1].filename}))`
  );
  ok(meta.n === COUNT, `python membaca ${COUNT} entri (zip64 dipakai untuk jumlah)`);
  ok(meta.bad === null, `python testzip: ${COUNT} entri CRC utuh`);
  ok(meta.last === `f/${COUNT - 1}.txt`, 'entri terakhir ikut terekam');

  const un = await run('unzip', ['-t', file]);
  ok(/No errors detected/.test(un), 'unzip -t menerima EOCD dengan sentinel campuran');

  console.log(`  (ukuran arsip ${(st.size / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------- [C] arsip >4 GiB (sparse, validasi independen) ----------
async function testOver4GB() {
  console.log('\n[C] arsip >4 GiB — struktur divalidasi lewat berkas sparse');
  const GIB = 1024 ** 3;
  const BIG = 4 * GIB + 12345;   // melewati batas 32-bit (4.294.967.295)
  const raw = new CaptureSink(8 * 1024, 256 * 1024);
  const cap = new zip.Sink(raw);
  const entries = [];

  entries.push(await zip.writeEntry(cap, 'kecil.txt', Buffer.from('batang-ukuran\n'), new Date('2026-05-05')));
  const t0 = Date.now();
  entries.push(await zip.writeEntry(cap, 'raksasa.bin', zerosSource(BIG), new Date('2026-05-06')));
  await zip.finish(cap, entries);
  console.log(`  (menyusun arsip virtual ${(cap.pos / GIB).toFixed(2)} GiB dalam ${((Date.now() - t0) / 1000).toFixed(1)} s, memori O(1))`);

  ok(cap.pos > 0xffffffff, 'total arsip melebihi 4 GiB (0xFFFFFFFF)');
  ok(entries[1].size === BIG, 'ukuran entri raksasa sesuai (di atas batas 32-bit)');
  ok(entries[1].offset < 0xffffffff, 'offset entri kedua masih 32-bit');

  const head = raw.head;
  const tail = raw.tail();
  const totalLen = cap.pos;

  ok(r32(head, 0) === 0x04034b50, 'local header entri pertama ada di head');
  const eocd = tail.subarray(tail.length - 22);
  ok(r32(eocd, 0) === 0x06054b50, 'EOCD klasik ada di tail');
  ok(eocd.readUInt16LE(8) === 2, 'jumlah entri tetap muat di field 16-bit (2 entri)');
  // hanya offset yang melewati 4 GiB yang wajib disentinel-kan; ukuran CD
  // (beberapa ratus byte) tetap ditulis apa adanya
  ok(r32(eocd, 16) === 0xffffffff, 'offset central dir = sentinel 0xFFFFFFFF (melebihi 4 GiB)');
  ok(r32(eocd, 12) > 0 && r32(eocd, 12) < 0xffffffff, 'ukuran central dir kecil -> tetap nilai asli');

  const z64i = tail.lastIndexOf(SIG.zip64);
  ok(z64i >= 0, 'ZIP64 EOCD ada di tail');
  if (z64i >= 0) {
    ok(tail.readBigUInt64LE(z64i + 4) === 44n, 'ZIP64 EOCD: sisa ukuran record = 44');
    ok(tail.readBigUInt64LE(z64i + 32) === 2n, 'ZIP64 EOCD: jumlah entri = 2');
    const cdSize64 = tail.readBigUInt64LE(z64i + 40);
    const cdStart64 = tail.readBigUInt64LE(z64i + 48);
    ok(cdStart64 > 0xffffffffn, 'ZIP64 EOCD: offset central dir > 4 GiB (8 byte penuh)');
    ok(cdStart64 + cdSize64 === BigInt(totalLen - TAIL_OVERHEAD), 'cdStart + cdSize + penutup == panjang arsip');
    ok(Number(cdSize64) === r32(eocd, 12), 'ukuran CD 64-bit konsisten dengan EOCD klasik');
  }

  // tulis sparse: head di awal, tail di akhir — sisa lubang (nyaris 0 disk)
  const file = path.join(TMP, 'raksasa.zip');
  fs.writeFileSync(file, Buffer.alloc(0));
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, head, 0, raw.headN, 0);
  fs.writeSync(fd, tail, 0, tail.length, totalLen - tail.length);
  fs.closeSync(fd);

  const disk = fs.statSync(file);
  ok(disk.size === totalLen, 'berkas sparse berukuran logis penuh');
  const fisik = disk.blocks * 512;
  ok(fisik < 1024 * 1024, `pemakaian disk fisik hanya ${(fisik / 1024).toFixed(0)} KB (sparse)`);

  const meta = await pyJson(
    `import zipfile,json
z=zipfile.ZipFile(${JSON.stringify(file)})
info={x.filename:x for x in z.infolist()}
big=info['raksasa.bin']
small=info['kecil.txt']
print(json.dumps({
 'n':len(info),
 'names':sorted(info),
 'big_size':big.file_size,
 'big_method':big.compress_type,
 'small_size':small.file_size,
 'small_ok':z.read('kecil.txt')==b'batang-ukuran\\n',
 'big_offset_gt4g':big.header_offset>0xffffffff or big.file_size>0xffffffff,
}))`
  );
  ok(meta.n === 2 && meta.small_ok === true, 'python membuka arsip & membaca entri kecil utuh');
  ok(meta.big_size === BIG, `python membaca ukuran entri >4 GiB (${BIG} byte) dari extra zip64`);
  ok(meta.big_method === 0, 'entri raksasa tetap STORE');
  ok(meta.big_offset_gt4g === true, 'nilai 64-bit benar-benar terbaca parser independen');

  fs.unlinkSync(file);
}

// ---------- [D] arsip >4 GiB sungguhan (opsional) ----------
async function testRealBig() {
  if (process.env.ZIP64_BIG !== '1') {
    console.log('\n[D] arsip >4 GiB sungguhan: dilewati (set ZIP64_BIG=1, butuh ~5 GB kosong)');
    return;
  }
  console.log('\n[D] arsip >4 GiB sungguhan ke disk');
  const GIB = 1024 ** 3;
  const BIG = 4 * GIB + 999;
  const file = path.join(TMP, 'nyata.zip');
  const sink = fileSink(file);
  const entries = [];
  try {
    entries.push(await zip.writeEntry(sink, 'kecil.txt', Buffer.from('sungguhan\n'), new Date('2026-05-05')));
    const t0 = Date.now();
    entries.push(await zip.writeEntry(sink, 'raksasa.bin', zerosSource(BIG), new Date('2026-05-06')));
    await zip.finish(sink, entries);
    console.log(`  (menulis ${(BIG / GIB).toFixed(2)} GiB + arsip dalam ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    closeSink(sink);
  }

  const meta = await pyJson(
    `import zipfile,json
z=zipfile.ZipFile(${JSON.stringify(file)})
i={x.filename:x for x in z.infolist()}
print(json.dumps({'bad':z.testzip(),'n':len(i),'big':i['raksasa.bin'].file_size,'small':z.read('kecil.txt')==b'sungguhan\\n'}))`
  );
  ok(meta.bad === null, 'python testzip penuh: CRC entri 4 GiB utuh');
  ok(meta.big === BIG && meta.small === true, 'ukuran & isi sesuai');
  fs.unlinkSync(file);
}

// ---------- [E] timestamp rusak tidak menjatuhkan ekspor ----------
async function testBadDates() {
  console.log('\n[E] timestamp rusak (1970 / NaN / 2300) aman dijepit');
  const cases = [
    ['d1.txt', new Date(0), '1980-01-01'],
    ['d2.txt', new Date(-86400000 * 400), '1980-01-01'],
    ['d3.txt', new Date('invalid'), '1980-01-01'],
    ['d4.txt', new Date(Date.UTC(2300, 0, 1)), '2107-12-31'],
    ['d5.txt', new Date('2026-10-20'), '2026-10-20'],
  ];
  const file = path.join(TMP, 'tanggal.zip');
  const sink = fileSink(file);
  const entries = [];
  let threw = null;
  try {
    for (const [name, when] of cases) entries.push(await zip.writeEntry(sink, name, Buffer.from(name), when));
    await zip.finish(sink, entries);
  } catch (e) {
    threw = e;
  } finally {
    closeSink(sink);
  }
  ok(!threw, `writeEntry tidak melempar untuk timestamp rusak (${threw ? threw.message : 'ok'})`);

  if (!threw) {
    const meta = await pyJson(
      `import zipfile,json
z=zipfile.ZipFile(${JSON.stringify(file)})
print(json.dumps({'bad':z.testzip(),'dates':{i.filename:'%04d-%02d-%02d'%i.date_time[:3] for i in z.infolist()}}))`
    );
    ok(meta.bad === null, 'CRC seluruh entri utuh');
    ok(meta.dates['d1.txt'] === '1980-01-01', 'tanggal 1970 dijepit ke 1980-01-01');
    ok(meta.dates['d3.txt'] === '1980-01-01', 'tanggal NaN dijepit ke 1980-01-01');
    ok(meta.dates['d4.txt'] === '2107-12-31', 'tahun 2300 dijepit ke 2107-12-31');
    ok(meta.dates['d5.txt'] === '2026-10-20', 'tanggal normal tidak berubah');
  }
}

// ---------- [F] CRC native == CRC tabel ----------
function runSyncPy(code) {
  const r = spawnSync('python3', ['-c', code]);
  if (r.status !== 0) throw new Error(`python keluar ${r.status}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function testCrcAgreement() {
  console.log('\n[F] CRC native zlib == tabel buatan sendiri');
  const samples = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('The quick brown fox jumps over the lazy dog'),
    Buffer.from('Mazvall/RTC-Core', 'utf8'),
    Buffer.alloc(70000, 0xab),
  ];
  let js = 0xffffffff;
  for (const s of samples) js = zip.crc32Update(js, s);
  js = (js ^ 0xffffffff) >>> 0;

  let native = 0;
  for (const s of samples) native = zlib.crc32(s, native);

  ok(js === native, `tabel & zlib.crc32 identik pada ${samples.length} sampel (${js})`);

  const py = Number(runSyncPy(`import zlib
d=b''.join([b'',b'a',b'The quick brown fox jumps over the lazy dog',b'Mazvall/RTC-Core',bytes([0xab])*70000])
print(zlib.crc32(d))`));
  ok(py === native, `CRC identik dengan python zlib.crc32 (${py})`);
}

async function main() {
  console.log('Uji ZIP64 (server/zipwriter.js)');
  try {
    await testSmall();
    await testManyEntries();
    await testOver4GB();
    await testRealBig();
    await testBadDates();
    testCrcAgreement();
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\nZIP64: ${pass} lulus, ${fail} gagal.`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
