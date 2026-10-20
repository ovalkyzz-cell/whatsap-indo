'use strict';

/* Penulis ZIP streaming dengan ZIP64 penuh — metode STORE (tanpa kompresi),
   nama UTF-8, general purpose flag bit 3 (data descriptor) sehingga CRC &
   ukuran dihitung sambil data mengalir: file tidak pernah ditampung penuh di RAM.

   Mengapa ZIP64 SELALU aktif:
   - ZIP klasik dibatasi 4 GB per arsip & 65535 entri; tanpa zip64 arsip besar
     gagal ditulis;
   - satu jalur kode = tidak ada risiko entri "salah klasifikasi" yang diam-diam
     menghasilkan arsip korup. Ukuran asli tetap ditulis di data descriptor dan
     central directory, jadi pembaca selalu memperoleh nilai sebenarnya;
   - didukung semua pembaca umum: Windows Explorer, macOS Archive Utility,
     unzip/Info-ZIP, python zipfile, 7-Zip — diverifikasi test/zip64.js.

   Format yang ditulis (little-endian):
   - local file header (30 byte) + nama + extra zip64 0x0001 (20 byte)
   - data (stream)
   - data descriptor ZIP64: sig 0x08074b50, crc32, kompresi 8 byte, asli 8 byte (24)
   - central directory (46 byte + nama + extra zip64 28 byte) di akhir
   - ZIP64 EOCD (56 byte) + ZIP64 EOCD locator (20 byte)
   - EOCD klasik (22 byte): nilai asli bila muat, sentinel 0xFFFF/0xFFFFFFFF bila tidak

   CRC memakai zlib.crc32 native (sama persis dengan tabel di bawah) supaya
   ekspor beberapa GB tetap ringan; tabel jadi cadangan Node tanpa native. */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

const NATIVE_CRC = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

// crc berjalan dengan konvensi akhir (0 = muat kosong, tanpa XOR penutup)
function crc32Next(prev, buf) {
  if (NATIVE_CRC) return NATIVE_CRC(buf, prev);
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// konvensi lama (dipertahankan agar kompatibel pemakai eksternal):
// menerima nilai internal (dihitung dari 0xffffffff) tanpa XOR penutup.
function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/* Waktu DOS (little-endian, tanpa zona). Field 16-bit hanya mewakili
   1980-01-01 .. 2107-12-31 — tanggal di luar rentang itu membuat writeUInt16LE
   melempar dan menjatuhkan SELURUH ekspor. created_at yang rusak/kecil pernah
   memicu kegagalan itu, jadi nilai apa pun dijepit ke rentang yang sah. */
const DOS_MIN_DATE = (0 << 9) | (1 << 5) | 1;              // 1980-01-01
const DOS_MAX_DATE = (127 << 9) | (12 << 5) | 31;           // 2107-12-31
const DOS_MAX_TIME = (23 << 11) | (59 << 5) | 29;           // 23:59:58

function dosDateTime(input) {
  const d = input instanceof Date
    ? input
    : Number.isFinite(Number(input)) ? new Date(Number(input)) : new Date();
  if (!Number.isFinite(d.getTime())) return { date: DOS_MIN_DATE, time: 0 };

  const y = d.getFullYear();
  if (y < 1980) return { date: DOS_MIN_DATE, time: 0 };
  if (y > 2107) return { date: DOS_MAX_DATE, time: DOS_MAX_TIME };

  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return {
    date: date < 0 || date > 0xffff ? DOS_MIN_DATE : date,
    time: time < 0 || time > 0xffff ? 0 : time,
  };
}

// versi yang dibutuhkan pembaca untuk format zip64
const ZIP64_VERSION = 45;
// kelas 0 (MS-DOS/FAT) — sama dengan perilaku lama, atribut eksternal 0
const VERSION_MADE_BY = 45;

// pembungkus response: menghitung posisi absolut (offset entri) + backpressure
class Sink {
  constructor(res) {
    this.res = res;
    this.pos = 0;
    this.closed = false;
  }

  async write(buf) {
    if (!buf.length) return;
    if (this.closed) throw new Error('koneksi ditutup');
    this.pos += buf.length;
    // jaga presisi: posisi dipakai sebagai offset 64-bit, kehilangan presisi
    // akan menghasilkan arsip yang salah secara diam-diam
    if (!Number.isSafeInteger(this.pos)) throw new Error('Ukuran arsip melebihi batas aman');
    if (this.res.write(buf)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.res.off('drain', onDrain);
        this.res.off('close', onClose);
        this.res.off('error', onError);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { this.closed = true; cleanup(); reject(new Error('koneksi ditutup')); };
      const onError = (err) => { this.closed = true; cleanup(); reject(err); };
      this.res.once('drain', onDrain);
      this.res.once('close', onClose);
      this.res.once('error', onError);
    });
  }
}

/* Tulis satu entri lengkap. source: Buffer | Readable (async-iterable).
   Mengembalikan { name, crc, size, offset, when } untuk central directory. */
async function writeEntry(sink, name, source, when) {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 0xffff) throw new Error('Nama berkas terlalu panjang');
  const offset = sink.pos;
  const stamp = when instanceof Date ? when : new Date();
  const { date, time } = dosDateTime(stamp);

  // local file header: ukuran 0xFFFFFFFF -> nilai ada di data descriptor (bit 3)
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);    // signature local file header
  head.writeUInt16LE(ZIP64_VERSION, 4); // versi dibutuhkan (zip64)
  head.writeUInt16LE(0x0808, 6);        // UTF-8 nama + data descriptor
  head.writeUInt16LE(0, 8);             // metode STORE
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(date, 12);
  head.writeUInt32LE(0, 14);            // crc -> di descriptor
  head.writeUInt32LE(0xffffffff, 18);   // ukuran kompresi -> zip64
  head.writeUInt32LE(0xffffffff, 22);   // ukuran asli -> zip64
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(20, 28);           // extra = zip64 (id 2 + len 2 + 2 x 8)
  await sink.write(head);
  await sink.write(nameBuf);

  // extra zip64 lokal: 0 = belum diketahui saat header ditulis,
  // nilai sebenarnya menyusul di data descriptor
  const z64 = Buffer.alloc(20);
  z64.writeUInt16LE(0x0001, 0);
  z64.writeUInt16LE(16, 2);
  z64.writeBigUInt64LE(0n, 4);  // ukuran asli
  z64.writeBigUInt64LE(0n, 12); // ukuran kompresi
  await sink.write(z64);

  let crc = 0;
  let size = 0;
  const chunks = Buffer.isBuffer(source) ? [source] : source;
  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf.length) continue;
    crc = crc32Next(crc, buf);
    size += buf.length;
    if (!Number.isSafeInteger(size)) throw new Error('Ukuran berkas melebihi batas aman');
    await sink.write(buf);
  }

  // data descriptor ZIP64: 24 byte (2 ukuran 8 byte)
  const desc = Buffer.alloc(24);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc, 4);
  desc.writeBigUInt64LE(BigInt(size), 8);
  desc.writeBigUInt64LE(BigInt(size), 16);
  await sink.write(desc);

  return { name, crc, size, offset, when: stamp };
}

// tutup arsip: central directory + ZIP64 EOCD + locator + EOCD klasik
async function finish(sink, entries) {
  const cdStart = sink.pos;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { date, time } = dosDateTime(e.when);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);      // signature central directory
    h.writeUInt16LE(VERSION_MADE_BY, 4);  // versi dibuat
    h.writeUInt16LE(ZIP64_VERSION, 6);    // versi dibutuhkan
    h.writeUInt16LE(0x0808, 8);           // UTF-8 + data descriptor
    h.writeUInt16LE(0, 10);               // metode STORE
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(0xffffffff, 20);      // ukuran kompresi -> zip64
    h.writeUInt32LE(0xffffffff, 24);      // ukuran asli -> zip64
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt16LE(28, 30);              // extra = zip64 (id 2 + len 2 + 3 x 8)
    h.writeUInt16LE(0, 32);               // komentar
    h.writeUInt16LE(0, 34);               // disk
    h.writeUInt16LE(0, 36);               // atribut internal
    h.writeUInt32LE(0, 38);               // atribut eksternal
    h.writeUInt32LE(0xffffffff, 42);      // offset local header -> zip64

    // urutan field wajib: asli, kompresi, offset lokal, disk (hanya yang overflow
    // ditulis, tetapi di sini semuanya memakai sentinel jadi ketiganya ditulis)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(e.size), 4);
    extra.writeBigUInt64LE(BigInt(e.size), 12);
    extra.writeBigUInt64LE(BigInt(e.offset), 20);

    await sink.write(h);
    await sink.write(nameBuf);
    await sink.write(extra);
  }
  const cdSize = sink.pos - cdStart;
  if (!Number.isSafeInteger(cdStart) || !Number.isSafeInteger(cdSize)) {
    throw new Error('Ukuran central directory melebihi batas aman');
  }

  // ZIP64 EOCD — sumber kebenaran untuk angka 64-bit
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);   // signature ZIP64 EOCD
  z64.writeBigUInt64LE(44n, 4);       // sisa ukuran record (konstan)
  z64.writeUInt16LE(VERSION_MADE_BY, 12);
  z64.writeUInt16LE(ZIP64_VERSION, 14);
  z64.writeUInt32LE(0, 16);           // disk
  z64.writeUInt32LE(0, 20);           // disk awal central directory
  z64.writeBigUInt64LE(BigInt(entries.length), 24);
  z64.writeBigUInt64LE(BigInt(entries.length), 32);
  z64.writeBigUInt64LE(BigInt(cdSize), 40);
  z64.writeBigUInt64LE(BigInt(cdStart), 48);
  const z64Offset = sink.pos;
  await sink.write(z64);

  // locator: selalu tepat sebelum EOCD klasik
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeUInt32LE(0, 4);
  loc.writeBigUInt64LE(BigInt(z64Offset), 8);
  loc.writeUInt32LE(1, 16);
  await sink.write(loc);

  // EOCD klasik: nilai asli bila muat (kompatibel pembaca lama),
  // sentinel bila melampaui -> pembaca wajib memakai ZIP64 EOCD di atas
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length > 0xffff ? 0xffff : entries.length, 8);
  end.writeUInt16LE(entries.length > 0xffff ? 0xffff : entries.length, 10);
  end.writeUInt32LE(cdSize > 0xffffffff ? 0xffffffff : cdSize, 12);
  end.writeUInt32LE(cdStart > 0xffffffff ? 0xffffffff : cdStart, 16);
  end.writeUInt16LE(0, 20);
  await sink.write(end);
}

module.exports = { Sink, writeEntry, finish, crc32Update, crc32Next };
