'use strict';

/* Katalog 15 tools untuk halaman web /tools.html.
   Sumber daftar & aturan field ada di satu tempat ini sehingga:
   - GET  /api/tools/web/list  -> daftar tool + definisi formulir (tanpa rahasia)
   - POST /api/tools/web/run   -> validasi allowlist lalu panggil api-mazval
   Kunci API TIDAK PERNAH dikirim ke browser (semua lewat bots.callApi). */

const bots = require('./bots');

const MAX_FIELD = 500;      // panjang maksimum tiap isian (karakter)
const MAX_FIELDS = 8;       // jumlah field maksimum per permintaan

const TOOLS = [
  {
    id: 'terjemah', name: 'Terjemah', icon: '🌐', category: 'Teks',
    desc: 'Terjemahkan teks Inggris → Indonesia.',
    example: 'good morning', path: '/api/tools/translate',
    fields: [
      { key: 'text', label: 'Teks', placeholder: 'good morning', required: true },
      { key: 'from', label: 'Dari bahasa', placeholder: 'en', value: 'en' },
      { key: 'to', label: 'Ke bahasa', placeholder: 'id', value: 'id' },
    ],
  },
  {
    id: 'cuaca', name: 'Cuaca', icon: '🌤️', category: 'Informasi',
    desc: 'Cuaca kota saat ini: suhu, kelembaban & angin.',
    example: 'Jakarta', path: '/api/info/cuaca',
    fields: [{ key: 'kota', label: 'Kota', placeholder: 'Jakarta', required: true }],
  },
  {
    id: 'ip', name: 'Cek IP', icon: '📍', category: 'Jaringan',
    desc: 'Info alamat IP / domain: lokasi, ISP & ASN.',
    example: '8.8.8.8', path: '/api/tools/ip-lookup',
    fields: [{ key: 'ip', label: 'IP atau domain', placeholder: '8.8.8.8', required: true }],
  },
  {
    id: 'qr', name: 'QR Code', icon: '🔳', category: 'Media',
    desc: 'Buat gambar QR Code dari teks atau tautan.',
    example: 'https://whatsap-indo.vercel.app', path: '/api/tools/qr-create',
    fields: [
      { key: 'text', label: 'Isi QR', placeholder: 'https://example.com', required: true },
      { key: 'size', label: 'Ukuran', placeholder: '400x400', value: '400x400' },
    ],
  },
  {
    id: 'npm', name: 'Info npm', icon: '📦', category: 'Developer',
    desc: 'Info paket registry npm: versi, lisensi & deskripsi.',
    example: 'express', path: '/api/tools/npmjs',
    fields: [{ key: 'package', label: 'Nama paket', placeholder: 'express', required: true }],
  },
  {
    id: 'kurs', name: 'Kurs Mata Uang', icon: '💱', category: 'Keuangan',
    desc: 'Konversi mata uang dunia dengan kurs terkini.',
    example: 'USD → IDR', path: '/api/tools/currency',
    fields: [
      { key: 'from', label: 'Dari', placeholder: 'USD', value: 'USD', required: true },
      { key: 'to', label: 'Ke', placeholder: 'IDR', value: 'IDR', required: true },
      { key: 'amount', label: 'Jumlah', placeholder: '100', value: '1', type: 'number' },
    ],
  },
  {
    id: 'kripto', name: 'Harga Kripto', icon: '🪙', category: 'Keuangan',
    desc: 'Harga kripto terkini dalam USD & IDR.',
    example: 'bitcoin', path: '/api/info/crypto',
    fields: [
      { key: 'coin', label: 'Koin (opsional)', placeholder: 'bitcoin',
        options: ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'binancecoin'] },
    ],
  },
  {
    id: 'gempa', name: 'Info Gempa', icon: '🌍', category: 'Informasi',
    desc: 'Gempa bumi terkini dari BMKG.',
    example: 'data terkini', path: '/api/info/gempa', fields: [],
  },
  {
    id: 'kodepos', name: 'Kode Pos', icon: '📮', category: 'Wilayah',
    desc: 'Cari kode pos berdasarkan desa / kecamatan / kota.',
    example: 'gambir', path: '/api/tools/kodepos',
    fields: [{ key: 'q', label: 'Area', placeholder: 'gambir', required: true }],
  },
  {
    id: 'nomor', name: 'Cek Nomor', icon: '📱', category: 'Telekomunikasi',
    desc: 'Info operator & prefix nomor HP Indonesia.',
    example: '081234567890', path: '/api/tools/cek-nomor',
    fields: [{ key: 'nomor', label: 'Nomor HP', placeholder: '081234567890', required: true }],
  },
  {
    id: 'negara', name: 'Info Negara', icon: '🚩', category: 'Wilayah',
    desc: 'Data negara: populasi, PDB & luas wilayah.',
    example: 'Indonesia', path: '/api/tools/countryInfo',
    fields: [{ key: 'name', label: 'Nama negara', placeholder: 'Indonesia', required: true }],
  },
  {
    id: 'jarak', name: 'Jarak Antar Kota', icon: '🧭', category: 'Wilayah',
    desc: 'Hitung jarak antara dua kota (Haversine).',
    example: 'Jakarta → Bandung', path: '/api/info/jarakkota',
    fields: [
      { key: 'dari', label: 'Dari kota', placeholder: 'Jakarta', required: true },
      { key: 'ke', label: 'Ke kota', placeholder: 'Bandung', required: true },
    ],
  },
  {
    id: 'sholat', name: 'Jadwal Sholat', icon: '🕌', category: 'Informasi',
    desc: 'Jadwal sholat kota hari ini lengkap.',
    example: 'Jakarta', path: '/api/info/jadwal-sholat',
    fields: [{ key: 'kota', label: 'Kota', placeholder: 'Jakarta', required: true }],
  },
  {
    id: 'github', name: 'Stalk GitHub', icon: '🐙', category: 'Developer',
    desc: 'Profil GitHub: bio, followers & jumlah repo.',
    example: 'octocat', path: '/api/stalk/github',
    fields: [{ key: 'user', label: 'Username', placeholder: 'octocat', required: true }],
  },
  {
    id: 'ocr', name: 'OCR Gambar', icon: '🖼️', category: 'Media',
    desc: 'Baca / ambil teks dari sebuah gambar (URL).',
    example: 'https://placehold.co/600x200.png?text=Halo', path: '/api/tools/ocr',
    fields: [{ key: 'url', label: 'URL gambar', placeholder: 'https://…/foto.png', required: true }],
  },
];

const byId = new Map(TOOLS.map((t) => [t.id, t]));

// daftar ringkas untuk halaman (tanpa field teknis path/method)
function list() {
  const categories = [];
  const grouped = {};
  for (const tool of TOOLS) {
    if (!grouped[tool.category]) {
      grouped[tool.category] = [];
      categories.push(tool.category);
    }
    grouped[tool.category].push({
      id: tool.id,
      name: tool.name,
      icon: tool.icon,
      category: tool.category,
      desc: tool.desc,
      example: tool.example,
      fields: tool.fields.map((f) => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder || '',
        value: f.value !== undefined ? f.value : '',
        type: f.type || 'text',
        required: !!f.required,
        options: f.options || [],
      })),
    });
  }
  return { total: TOOLS.length, categories, tools: grouped };
}

// validasi input: hanya field yang terdaftar pada tool tsbi yang diteruskan
function buildParams(tool, inputs) {
  if (!inputs || typeof inputs !== 'object') return {};
  const out = {};
  let count = 0;
  for (const field of tool.fields) {
    const raw = inputs[field.key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim().slice(0, MAX_FIELD);
    if (!value) continue;
    count += 1;
    if (field.type === 'number' && !/^\d+(\.\d+)?$/.test(value)) {
      const err = new Error(`Isian "${field.label}" harus berupa angka.`);
      err.status = 400;
      throw err;
    }
    if (field.options && field.options.length && !field.options.includes(value.toLowerCase())) {
      const err = new Error(`Pilihan "${field.label}" tidak valid. Contoh: ${field.options.slice(0, 3).join(', ')}.`);
      err.status = 400;
      throw err;
    }
    out[field.key] = value;
  }
  // tolak isian tak dikenal yang berisi nilai (nilai kosong diabaikan)
  for (const [key, raw] of Object.entries(inputs)) {
    if (raw === undefined || raw === null || !String(raw).trim()) continue;
    if (!tool.fields.some((f) => f.key === key)) {
      const err = new Error(`Isian "${key}" tidak dikenal untuk tool ${tool.name}.`);
      err.status = 400;
      throw err;
    }
  }
  if (count > MAX_FIELDS) {
    const err = new Error('Terlalu banyak isian.');
    err.status = 400;
    throw err;
  }
  for (const field of tool.fields) {
    if (field.required && !out[field.key]) {
      const err = new Error(`Isian "${field.label}" wajib diisi.`);
      err.status = 400;
      throw err;
    }
  }
  return out;
}

// jalankan satu tool -> { tool, name, data }
async function run(id, inputs) {
  const tool = byId.get(String(id || ''));
  if (!tool) {
    const err = new Error(`Tool "${id}" tidak ditemukan. Lihat GET /api/tools/web/list.`);
    err.status = 404;
    throw err;
  }
  const params = buildParams(tool, inputs);
  const body = await bots.callApi(tool.path, params, { timeout: 45000 });
  if (body && (body.success === false || body.status === false)) {
    const err = new Error(body.error || body.message || 'Data tidak ditemukan.');
    err.status = 502;
    throw err;
  }
  const data = bots.unwrapBody(body);
  if (data === null) {
    const err = new Error('Layanan tidak mengembalikan data.');
    err.status = 502;
    throw err;
  }
  return { tool: tool.id, name: tool.name, data: typeof data === 'object' ? data : { hasil: data } };
}

module.exports = { TOOLS, list, run };
