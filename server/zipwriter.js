'use strict';

/* Penulis ZIP streaming — metode STORE (tanpa kompresi), nama UTF-8,
   general purpose flag bit 3 (data descriptor) sehingga CRC & ukuran
   dihitung sambil data mengalir: file tidak pernah ditampung penuh di RAM.

   Format yang ditulis (little-endian):
   - local file header (30 byte) + nama
   - data (stream)
   - data descriptor: sig 0x08074b50, crc32, kompresi, asli
   - central directory (46 byte + nama per entri) di akhir
   - EOCD (22 byte)

   Tanpa zip64: pemanggil WAJIB menjaga total arsip < 4 GB dan tiap file
   < 4 GB (batas media aplikasi 2 GB sudah di bawah itu). */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

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

  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); // signature local file header
  head.writeUInt16LE(20, 4);         // versi dibuat
  head.writeUInt16LE(0x0808, 6);     // UTF-8 nama + data descriptor
  head.writeUInt16LE(0, 8);          // metode STORE
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(date, 12);
  head.writeUInt32LE(0, 14);         // crc -> di descriptor
  head.writeUInt32LE(0, 18);         // ukuran kompresi -> di descriptor
  head.writeUInt32LE(0, 22);         // ukuran asli -> di descriptor
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);         // tanpa extra field
  await sink.write(head);
  await sink.write(nameBuf);

  let crc = 0xffffffff;
  let size = 0;
  const chunks = Buffer.isBuffer(source) ? [source] : source;
  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf.length) continue;
    crc = crc32Update(crc, buf);
    size += buf.length;
    if (size >= 0xffffffff || sink.pos + buf.length >= 0xffffffff) {
      throw new Error('Melebihi batas 4 GB format ZIP (zip64 tidak dipakai)');
    }
    await sink.write(buf);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const desc = Buffer.alloc(16);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc, 4);
  desc.writeUInt32LE(size, 8);
  desc.writeUInt32LE(size, 12);
  await sink.write(desc);

  return { name, crc, size, offset, when: stamp };
}

// tutup arsip: central directory + EOCD
async function finish(sink, entries) {
  const cdStart = sink.pos;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { date, time } = dosDateTime(e.when);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // signature central directory
    h.writeUInt16LE(20, 4);         // versi dibuat (store, unix-ish)
    h.writeUInt16LE(20, 6);         // versi minimal
    h.writeUInt16LE(0x0808, 8);     // UTF-8 + data descriptor
    h.writeUInt16LE(0, 10);         // metode STORE
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.size, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt16LE(0, 30);         // extra
    h.writeUInt16LE(0, 32);         // komentar
    h.writeUInt16LE(0, 34);         // disk
    h.writeUInt16LE(0, 36);         // atribut internal
    h.writeUInt32LE(0, 38);         // atribut eksternal
    h.writeUInt32LE(e.offset, 42);  // offset local header
    await sink.write(h);
    await sink.write(nameBuf);
  }
  const cdSize = sink.pos - cdStart;
  if (entries.length > 0xffff) throw new Error('Terlalu banyak entri ZIP');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature EOCD
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  await sink.write(end);
}

module.exports = { Sink, writeEntry, finish, crc32Update };
