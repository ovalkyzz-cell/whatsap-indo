'use strict';

/* Sembilan bot internal khusus admin:
   - Verif AM Prem : verifikasi & kirim tautan Alight Motion Premium
   - Generate NFToken : generator NFToken Alight Motion
   - AI : ChatGPT, Gemini, Deepseek, Claude (kode muncul sebagai blok kode)
   - Downloader : unduh video TikTok/IG/YouTube/FB/X & lainnya
   - Email Generator : email sementara, inbox, OTP & baca pesan
   - Tools : terjemah, cuaca, IP, QR, npm
   - Screenshot Kode : render kode jadi gambar PNG (codesnap)
   - Unduh Kode npm : unduh source code paket npm sebagai zip
   - Katalog Model AI : daftar model AI (mimo/models)
   Semua memanggil API api-mazval (base + key lewat env, tidak disimpan di kode). */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { storeBuffer } = require('./upload');

const BASE = String(process.env.MAZVAL_API_BASE || 'https://api-mazval.zone.id').replace(/\/+$/, '');
const API_KEY = String(process.env.MAZVAL_API_KEY || '');
const API_TIMEOUT = Number(process.env.MAZVAL_API_TIMEOUT) || 45000;
// AI: timeout lebih panjang karena api-mazval melakukan fallback internal hingga ±75 detik,
// sedangkan total waktu satu pertanyaan dibatasi AI_BUDGET supaya admin tidak menunggu lama
const AI_TIMEOUT = Math.max(Number(process.env.MAZVAL_API_TIMEOUT) || 45000, 75000);
const AI_BUDGET = Number(process.env.MAZVAL_AI_BUDGET_MS) || 120000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HR = '────────────────────────';

const BOTS = [
  {
    id: 'bot-verif-am',
    email: 'verif-am@bot.whatsap-indo',
    name: 'Verif AM Prem',
    about: 'Verifikasi & pengiriman tautan Alight Motion Premium. Ketik "menu".',
    reply: verifReply,
  },
  {
    id: 'bot-nftoken',
    email: 'nftoken@bot.whatsap-indo',
    name: 'Generate NFToken',
    about: 'Generator NFToken Alight Motion. Ketik "menu".',
    reply: nftokenReply,
  },
  {
    id: 'bot-ai',
    email: 'ai@bot.whatsap-indo',
    name: 'AI',
    about: 'ChatGPT · Gemini · Deepseek · Claude. Kirim pertanyaanmu.',
    reply: aiReply,
  },
  {
    id: 'bot-down',
    email: 'downloader@bot.whatsap-indo',
    name: 'Downloader',
    about: 'Download video TikTok, Instagram, YouTube, Facebook, X & lainnya. Kirim tautannya.',
    reply: downReply,
  },
  {
    id: 'bot-email',
    email: 'generator@bot.whatsap-indo',
    name: 'Email Generator',
    about: 'Email sementara lengkap: buat, cek inbox, baca pesan & OTP. Ketik "menu".',
    reply: emailReply,
  },
  {
    id: 'bot-tools',
    email: 'tools@bot.whatsap-indo',
    name: 'Tools',
    about: 'Terjemah · Cuaca · IP · QR · npm. Ketik "menu".',
    reply: toolsReply,
  },
  {
    id: 'bot-kodesnap',
    email: 'kodesnap@bot.whatsap-indo',
    name: 'Screenshot Kode',
    about: 'Render potongan kode jadi gambar ala VS Code. Contoh: kode console.log("halo").',
    reply: kodesnapReply,
  },
  {
    id: 'bot-npm-zip',
    email: 'npmzip@bot.whatsap-indo',
    name: 'Unduh Kode npm',
    about: 'Unduh source code paket npm sebagai file zip. Contoh: zip express.',
    reply: npmZipReply,
  },
  {
    id: 'bot-model-ai',
    email: 'modelai@bot.whatsap-indo',
    name: 'Katalog Model AI',
    about: 'Daftar model AI: gratis, berbayar & provider. Contoh: daftar.',
    reply: modelListReply,
  },
];

// nama bawaan (termasuk nama lama) — dipakai seed supaya nama/bio hasil edit
// admin oleh pengguna tidak tertimpa saat restart
const DEFAULT_NAMES = new Set(BOTS.map((b) => b.name).concat(['Verif AM Prem', 'Generate NFToken', 'AI']));

const byId = new Map(BOTS.map((b) => [b.id, b]));

function isBot(row) {
  return !!row && Number(row.is_bot) === 1;
}

function firstWord(text) {
  const m = String(text || '').trim().match(/^\S+/);
  return m ? m[0].toLowerCase() : '';
}

function rest(text) {
  return String(text || '').trim().replace(/^\S+\s*/, '').trim();
}

function sanitize(text, max) {
  return String(text || '').slice(0, max || 8000);
}

// potongan blok kode harus tetap seimbang walau jawaban terpotong (sanitize):
// sisipkan penutup ``` bila jumlah fence ganjil supaya footer tidak ikut jadi kode
function balanceFences(text) {
  const s = String(text || '');
  if ((s.match(/```/g) || []).length % 2 === 0) return s;
  return s.replace(/\s+$/, '').replace(/`{1,2}$/, '') + '\n```';
}

function errBlock(title, reason) {
  return [
    '❌ ' + title,
    '',
    'Alasan: ' + (reason || 'Permintaan gagal diproses.'),
    '',
    'Ketik "menu" untuk melihat perintah yang tersedia.',
  ].join('\n');
}

/* ---------- format blok ----------
   Frontend mengenali tiga penanda berikut:
   ```<lang> ... ```  -> blok kode ala VS Code (ada tombol Copy)
   ```angka ... ```   -> kartu khusus angka/token (font profesional)
   ```json ... ```    -> blok JSON rapi (di-format ulang frontend + Copy) */

function fence(lang, code) {
  const body = String(code === undefined || code === null ? '' : code)
    // kalau isi sudah mengandung fence, pecah supaya rendering tetap utuh
    .replace(/```/g, '`\u200b``')
    .replace(/\s+$/, '');
  return '```' + String(lang || '').trim() + '\n' + body + '\n```';
}

function jsonFence(obj) {
  return fence('json', JSON.stringify(obj, null, 2));
}

function angkaFence(value) {
  return fence('angka', String(value === undefined || value === null ? '' : value));
}

/* ---------- pemanggilan API api-mazval ---------- */

async function callApi(path, params, opts) {
  if (!API_KEY) throw new Error('Konfigurasi API bot belum lengkap (MAZVAL_API_KEY belum diatur).');
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('apikey', API_KEY);

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'WhatsapIndo-Bot/1.0' },
      signal: AbortSignal.timeout((opts && opts.timeout) || API_TIMEOUT),
    });
  } catch (e) {
    throw new Error('Layanan api-mazval tidak dapat dihubungi. Coba lagi sebentar lagi.');
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }

  if (body && body.success === false) throw new Error(body.error || 'Permintaan ditolak API.');
  if (!res.ok) {
    throw new Error((body && (body.error || body.message)) || `Permintaan gagal (HTTP ${res.status}).`);
  }
  return body || {};
}

// versi biner callApi: untuk endpoint yang mengembalikan file langsung
// (kode PNG codesnap, arsip zip npm2zip) alih-alih JSON
async function callApiBuffer(path, params, opts) {
  if (!API_KEY) throw new Error('Konfigurasi API bot belum lengkap (MAZVAL_API_KEY belum diatur).');
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('apikey', API_KEY);

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': 'WhatsapIndo-Bot/1.0' },
      signal: AbortSignal.timeout((opts && opts.timeout) || API_TIMEOUT),
    });
  } catch (e) {
    throw new Error('Layanan api-mazval tidak dapat dihubungi. Coba lagi sebentar lagi.');
  }

  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('json')) {
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (body && body.success === false) throw new Error(body.error || 'Permintaan ditolak API.');
    if (!res.ok) throw new Error((body && (body.error || body.message)) || `Permintaan gagal (HTTP ${res.status}).`);
  } else if (!res.ok) {
    throw new Error(`Permintaan gagal (HTTP ${res.status}).`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Layanan tidak mengembalikan file.');
  const cd = String(res.headers.get('content-disposition') || '');
  const filename = (cd.match(/filename="?([^";]+)"?/i) || [])[1] || '';
  return { buffer, contentType: ct, filename };
}

function asObject(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  if (typeof data === 'string') return { message: data };
  if (Array.isArray(data)) return { data };
  return {};
}

const FIELD_LABELS = [
  ['email', 'Email'],
  ['message', 'Pesan'],
  ['msg', 'Pesan'],
  ['status', 'Status'],
  ['verified', 'Terverifikasi'],
  ['is_verified', 'Terverifikasi'],
  ['uid', 'UID'],
  ['name', 'Nama'],
  ['link', 'Tautan'],
  ['url', 'Tautan'],
  ['expires', 'Berlaku sampai'],
  ['expired_at', 'Berlaku sampai'],
];

function fieldLines(data) {
  const obj = asObject(data);
  const out = [];
  for (const [key, label] of FIELD_LABELS) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (value === null || value === undefined || typeof value === 'object') continue;
    out.push(`${label} : ${String(value)}`);
  }
  return out;
}

// ambil nilai kode/tautan dari baris detail untuk ditampilkan di kartu angka
function pickCodeValue(lines) {
  const hit = lines.find((l) => /^(Tautan|Link|URL|Kode|Token|Kode Verifikasi|UID)\s*:/i.test(l));
  return hit ? hit.replace(/^[^:]+:\s*/, '').trim() : null;
}

/* ---------- Bot 1: Verif AM Prem ---------- */

const VERIF_MENU = [
  '╭─────────────────────────────',
  '│ VERIF AM PREM',
  '│ Verifikasi & tautan Alight Motion Premium',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. send <email>',
  '   Kirim tautan verifikasi ke email.',
  '',
  '2. cek <email> <token>',
  '   Cek status verifikasi memakai token dari email.',
  '',
  'Contoh:',
  '  send nama@mail.com',
  '  cek nama@mail.com abc123',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

async function verifReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return VERIF_MENU;

  if (['send', 'kirim'].includes(cmd)) {
    const email = arg.trim();
    if (!email || !EMAIL_RE.test(email)) {
      return [
        '❌ Format email belum benar',
        '',
        'Gunakan:',
        '  send nama@mail.com',
        '',
        'Balas "menu" untuk melihat semua perintah.',
      ].join('\n');
    }
    let body;
    try {
      body = await callApi('/api/tools/am-verif-send', { email });
    } catch (e) {
      return errBlock('Tautan tidak dapat dikirim', e.message);
    }
    if (body.success === false) return errBlock('Tautan tidak dapat dikirim', body.error);
    const detail = fieldLines(body.data !== undefined ? body.data : body).filter((l) => !/^Email/.test(l));
    const codeLine = detail.find((l) => /^(Tautan|Link|URL|Kode|Token|Kode Verifikasi|UID)\s*:/i.test(l));
    const codeValue = codeLine ? pickCodeValue([codeLine]) : email;
    const restDetail = codeLine ? detail.filter((l) => l !== codeLine) : detail;
    return [
      '✅ Tautan verifikasi terkirim',
      '',
      `Email   : ${email}`,
      'Status  : Tautan verifikasi Alight Motion Premium dikirim ke email.',
      '',
      'Kode / tautan verifikasi:',
      angkaFence(codeValue),
      '',
      ...(restDetail.length ? restDetail : []),
      '',
      'Langkah selanjutnya:',
      '1. Buka kotak masuk email (cek folder Spam/Promosi bila tidak ada).',
      '2. Salin tautan verifikasi atau kode oobCode dari email.',
      '3. Kirim perintah:',
      `   cek ${email} <token>`,
      '',
      'Catatan: kode bersifat rahasia, jangan dibagikan ke siapa pun.',
    ].join('\n');
  }

  if (['cek', 'check', 'verifikasi', 'verify'].includes(cmd)) {
    const parts = arg.split(/\s+/).filter(Boolean);
    const [email, token] = parts;
    if (!email || !token || !EMAIL_RE.test(email)) {
      return [
        '❌ Format perintah belum benar',
        '',
        'Gunakan:',
        '  cek <email> <token>',
        '  cek nama@mail.com abc123',
        '',
        'Token diambil dari email verifikasi yang masuk.',
      ].join('\n');
    }
    let body;
    try {
      body = await callApi('/api/tools/am-verif-check', { email, token });
    } catch (e) {
      return errBlock('Verifikasi belum berhasil', e.message);
    }
    if (body.success === false) return errBlock('Verifikasi belum berhasil', body.error);
    const data = body.data !== undefined ? body.data : body;
    const detail = fieldLines(data);
    return [
      '✅ Verifikasi berhasil',
      '',
      `Email   : ${email}`,
      'Token   :',
      angkaFence(token),
      ...(detail.length ? detail : ['Status  : Akun Alight Motion Premium terverifikasi.']),
      '',
      'Akun kamu siap digunakan. Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  return errBlock('Perintah tidak dikenal', `Tidak ada perintah "${cmd}".`);
}

/* ---------- Bot 2: Generate NFToken ---------- */

const NFTOKEN_MENU = [
  '╭─────────────────────────────',
  '│ GENERATE NFTOKEN',
  '│ Generator NFToken Alight Motion',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. generate <jumlah>',
  '   Buat token baru (1-10). Jumlah boleh dihilangkan (default 1).',
  '',
  'Contoh:',
  '  generate',
  '  generate 3',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

async function nftokenReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return NFTOKEN_MENU;
  if (!['generate', 'token', 'nftoken', 'buat', 'gen'].includes(cmd)) {
    return errBlock('Perintah tidak dikenal', `Tidak ada perintah "${cmd}".`);
  }

  let count = 1;
  if (arg) {
    if (!/^\d+$/.test(arg)) {
      return [
        '❌ Jumlah tidak valid',
        '',
        'Gunakan angka 1-10, contoh:',
        '  generate 3',
      ].join('\n');
    }
    count = Math.max(1, Math.min(10, Number(arg)));
  }

  let body;
  try {
    body = await callApi('/api/tools/nftoken-generate', { count });
  } catch (e) {
    return errBlock('NFToken tidak dapat dibuat', e.message);
  }
  // respons API berubah bentuk mengikuti jumlah: objek tunggal untuk 1 token, daftar untuk banyak
  const outer = body.data !== undefined ? body.data : body;
  const bucket = Array.isArray(outer)
    ? outer
    : outer && Array.isArray(outer.data)
      ? outer.data
      : outer && Array.isArray(outer.tokens)
        ? outer.tokens
        : outer && typeof outer === 'object' && (outer.token || outer.value || outer.nftoken)
          ? [outer]
          : [];
  const items = bucket
    .map((t) => (typeof t === 'string' ? { token: t } : t || {}))
    .filter((t) => t.token || t.value || t.nftoken);
  const tokens = items.map((t) => t.token || t.value || t.nftoken);

  if (!tokens.length) {
    const reason = body.error || (outer && outer.error)
      || (Number(outer && outer.failed) > 0 ? `${outer.failed} token gagal dibuat` : 'Token tidak ditemukan pada respons API');
    return errBlock('NFToken tidak dapat dibuat', reason);
  }

  const expiry = items[0] && items[0].expiry;
  const plan = items[0] && items[0].plan;
  const country = items[0] && items[0].country;

  const failed = Number(outer && outer.failed) || 0;
  const payload = {
    success: true,
    count: tokens.length,
    failed,
    ...(expiry ? { expires: expiry } : {}),
    ...(plan ? { plan } : {}),
    ...(country ? { country } : {}),
    tokens: items.map((item, i) => {
      const entry = { no: i + 1, token: tokens[i] };
      if (item.expiry) entry.expires = item.expiry;
      return entry;
    }),
    generated_at: new Date().toISOString(),
  };
  return [
    `✅ ${tokens.length} NFToken berhasil dibuat`,
    '',
    jsonFence(payload),
    '',
    failed ? `Ringkasan : ${tokens.length} sukses · ${failed} gagal` : `Ringkasan : ${tokens.length} token siap dipakai.`,
    '',
    'Salin JSON di atas lewat tombol Copy, lalu tempel token di aplikasi Alight Motion.',
    'Balas "menu" bila butuh perintah lain.',
  ].join('\n');
}

/* ---------- Bot 3: AI ---------- */

const AI_MODELS = [
  { words: ['gpt', 'chatgpt'], path: '/api/ai/chatgpt', label: 'ChatGPT' },
  { words: ['gemini'], path: '/api/ai/gemini', label: 'Gemini' },
  { words: ['deepseek', 'ds', 'deepseekr1'], path: '/api/ai/deepseekr1', label: 'DeepSeek R1' },
  { words: ['claude'], path: '/api/ai/claude-ai', label: 'Claude' },
];
const AI_DEFAULT = AI_MODELS[0];

// instruksi format: model diminta menuangkan kode ke blok ```<bahasa>```
// supaya frontend bisa menampilkannya ala VS Code lengkap dengan tombol Copy
const CODING_HINT = [
  '',
  '',
  'Aturan format jawaban (wajib dipatuhi):',
  '- Untuk kode pemrograman, tulis kode DI DALAM blok kode pakai tiga backtick dan nama bahasa, contoh: ```js, ```python, ```json, ```html. Jangan taruh kode di luar blok.',
  '- Jangan menjelaskan kode baris per baris di luar blok; cukup satu-dua kalimat ringkas sebelum/sesudah blok.',
  '- Gunakan poin-poin (•) untuk penjelasan panjang, dan tulis jawaban dengan rapi serta profesional dalam Bahasa Indonesia.',
].join('\n');

const AI_MENU = [
  '╭─────────────────────────────',
  '│ AI ASSISTANT',
  '│ ChatGPT · Gemini · Deepseek · Claude',
  '╰─────────────────────────────',
  '',
  'Kirim pertanyaan apa saja, bot ini otomatis menjawab.',
  'Tanpa awalan perintah, jawaban default memakai ChatGPT.',
  '',
  'Pilih model dengan awalan perintah:',
  '  gpt <pertanyaan>       ChatGPT',
  '  gemini <pertanyaan>    Gemini',
  '  deepseek <pertanyaan>  DeepSeek R1',
  '  claude <pertanyaan>    Claude',
  '',
  'Keunggulan:',
  '  • Kode pemrograman tampil sebagai blok kode ala VS Code',
  '  • Setiap blok kode punya tombol Copy sekali klik',
  '  • Mendukung semua bahasa: js, py, java, cpp, go, dll',
  '',
  'Contoh:',
  '  gpt buatkan kode REST API login dengan JWT',
  '  gemini buatkan fungsi sorting di python',
  '  translate "good morning" ke bahasa Jepang',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

function pickAnswer(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [
    body.result,
    body.answer,
    body.response,
    body.text,
    body.content,
    body.data && body.data.result,
    body.data && body.data.answer,
    body.data && body.data.response,
    body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content,
    body.choices && body.choices[0] && body.choices[0].text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

const aiDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// satu percobaan tanya ke model: wajib menghasilkan jawaban, kalau kosong dianggap gagal
async function aiAsk(model, prompt, timeout) {
  const body = await callApi(model.path, { prompt }, { timeout });
  const answer = pickAnswer(body);
  if (!answer) throw new Error((body && (body.error || body.message)) || 'Respons AI kosong');
  return answer;
}

async function aiReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const key = cmd.replace(/[?:!,.]+$/, '');

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(key)) return AI_MENU;

  // kata perintah model (mis. "gpt") dibuang dari isi pertanyaan;
  // tanpa awalan model, seluruh teks dianggap pertanyaan
  const model = AI_MODELS.find((m) => m.words.includes(key));
  const question = model ? rest(text) : text;

  if (!question) {
    const label = model || AI_DEFAULT;
    return [
      '❌ Pertanyaan masih kosong',
      '',
      'Gunakan format:',
      `  ${label.words[0]} <pertanyaan>`,
      '',
      'Balas "menu" untuk melihat semua model.',
    ].join('\n');
  }

  const active = model || AI_DEFAULT;
  const prompt = question + CODING_HINT;

  // jawaban AI wajib keluar: coba ulang model pilihan, lalu model cadangan lain
  // sebelum menyerah, semua dalam satu anggaran waktu supaya tidak bikin nunggu lama
  const chain = [active, ...AI_MODELS.filter((m) => m.path !== active.path)];
  const startedAt = Date.now();
  const errors = [];
  let answer = null;
  let used = active;

  for (const candidate of chain) {
    const tries = candidate.path === active.path ? 3 : 1;
    for (let attempt = 0; attempt < tries && !answer; attempt += 1) {
      const remaining = AI_BUDGET - (Date.now() - startedAt);
      if (remaining < 25000) break;
      if (attempt) await aiDelay(10000);
      try {
        answer = await aiAsk(candidate, prompt, Math.min(AI_TIMEOUT, remaining));
        used = candidate;
      } catch (err) {
        errors.push(`${candidate.label}: ${String((err && err.message) || err).slice(0, 160)}`);
      }
    }
    if (answer) break;
    await aiDelay(8000);
  }

  if (!answer) {
    return [
      '⚠️ Jawaban AI belum bisa diberikan sekarang',
      '',
      'Semua model sedang mengalami gangguan sesaat. Kirim ulang pertanyaanmu beberapa saat lagi, jawaban langsung muncul.',
      errors.length ? `\nCatatan: ${errors[errors.length - 1]}` : '',
    ].filter(Boolean).join('\n');
  }

  const header = used.path === active.path
    ? `🤖 ${active.label}`
    : `🤖 ${active.label} (cadangan: ${used.label})`;

  return [
    header,
    HR,
    balanceFences(sanitize(answer, 7200)),
    HR,
    'Balas "menu" untuk memilih model lain.',
  ].join('\n');
}

/* ---------- Bot 4: Downloader video sosial ---------- */

const DOWN_MENU = [
  '╭─────────────────────────────',
  '│ DOWNLOADER',
  '│ TikTok · IG · YouTube · FB · X',
  '╰─────────────────────────────',
  '',
  'Kirim tautan video, bot ini otomatis mendeteksi platformnya.',
  'Tautan lengkap (https://…) atau tempelan polos (youtu.be/xxxx) sama-sama diterima.',
  '',
  'Platform yang didukung:',
  '  • TikTok      • Instagram   • YouTube',
  '  • Facebook    • Twitter / X • Pinterest',
  '  • Spotify     • SoundCloud  • Douyin',
  '  • MediaFire   • Terabox     • lainnya',
  '',
  'Contoh:',
  '  https://www.tiktok.com/@akun/video/123',
  '  https://youtu.be/dQw4w9WgXcQ',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

const DOWN_PLATFORMS = [
  { hosts: ['youtube.com', 'youtu.be'], path: '/api/download/youtube', label: 'YouTube' },
  { hosts: ['tiktok.com'], path: '/api/download/tiktok', label: 'TikTok' },
  { hosts: ['instagram.com', 'instagr.am'], path: '/api/download/instagram', label: 'Instagram' },
  { hosts: ['facebook.com', 'fb.watch'], path: '/api/download/facebook', label: 'Facebook' },
  { hosts: ['twitter.com', 'x.com', 't.co'], path: '/api/download/twitter', label: 'Twitter / X' },
  { hosts: ['pinterest.com', 'pin.it'], path: '/api/download/pinterest', label: 'Pinterest' },
  { hosts: ['spotify.com'], path: '/api/download/spotify', label: 'Spotify' },
  { hosts: ['soundcloud.com'], path: '/api/download/soundcloud', label: 'SoundCloud' },
  { hosts: ['douyin.com'], path: '/api/download/douyin', label: 'Douyin' },
  { hosts: ['mediafire.com'], path: '/api/download/mediafire', label: 'MediaFire' },
  { hosts: ['terabox.com', '1024tera.com', 'teraboxapp.com', 'teraboxlink.com'], path: '/api/download/terabox', label: 'Terabox' },
];

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// pencocokan lewat nama domain persis (akar + subdomain), bukan substring —
// supaya "max.com" tidak salah terbaca sebagai "x.com"
function platformFor(u) {
  const host = hostOf(u);
  if (!host) return null;
  return DOWN_PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}

// ambil tautan dari pesan: lengkap (https://), atau tempelan polos seperti
// "youtu.be/xxxx"; tanda baca di ujung (titik, koma, kurung) dibuang
function extractUrl(text) {
  const t = String(text || '');
  let u = (t.match(/https?:\/\/\S+/i) || [])[0] || null;
  if (!u) {
    const bare = t.match(/(?:^|\s)((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s]*)/i);
    if (bare) u = 'https://' + bare[1];
  }
  if (!u) return null;
  u = u.replace(/[),.;:!?'"+]+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return isSafeMediaUrl(u) ? u : null;
}

const DL_ICON = { mp4: '🎬', mp3: '🎵', hd: '🎞️', sd: '🎞️', audio: '🎵', video: '🎬' };

// kumpulkan tautan unduh dari objek respons (dari objek `download` bila ada)
function downloadLinks(node, out, depth) {
  if (!node || depth > 4) return out;
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node) && !out.includes(node)) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => downloadLinks(n, out, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) downloadLinks(value, out, depth + 1);
  }
  return out;
}

function isSafeMediaUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s<>"']{8,600}$/i.test(u.trim());
}

function guessMime(url) {
  const path = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.png$/.test(path)) return 'image/png';
  if (/\.webp$/.test(path)) return 'image/webp';
  if (/\.gif$/.test(path)) return 'image/gif';
  if (/\.(jpg|jpeg)$/.test(path)) return 'image/jpeg';
  if (/\.mp4$/.test(path)) return 'video/mp4';
  if (/\.webm$/.test(path)) return 'video/webm';
  if (/\.mkv$/.test(path)) return 'video/x-matroska';
  if (/\.mov$/.test(path)) return 'video/quicktime';
  return null;
}

// ambil URL pertama yang valid dari berbagai bentuk field (string / array / {url})
function urlOf(x) {
  if (isSafeMediaUrl(x)) return String(x).trim();
  if (Array.isArray(x)) {
    for (const item of x) { const u = urlOf(item); if (u) return u; }
    return null;
  }
  if (x && typeof x === 'object') return urlOf(x.url || x.src || x.href || null);
  return null;
}

// pilih media preview: video langsung bila ada file .mp4, selain itu thumbnail
// (sumber diurutkan: result -> data -> body, karena field bisa ada di lapis mana pun)
function pickMedia(sources, links, title) {
  const name = (String(title || 'media').replace(/[^\w.\- ]+/g, '').trim().slice(0, 80)) || 'media';
  const videoUrl = (links || []).find((u) => isSafeMediaUrl(u) && /\.mp4(\?|#|$)/i.test(u));
  if (videoUrl) {
    return { type: 'video', url: videoUrl.trim(), name: name.endsWith('.mp4') ? name : `${name}.mp4`, mime: 'video/mp4' };
  }
  const FIELDS = ['thumbnail', 'thumb', 'image', 'image_url', 'cover', 'poster', 'preview', 'thumbnails', 'images'];
  for (const src of (Array.isArray(sources) ? sources : [sources])) {
    if (!src || typeof src !== 'object') continue;
    for (const field of FIELDS) {
      const u = urlOf(src[field]);
      if (u) return { type: 'image', url: u, name, mime: guessMime(u) || 'image/jpeg' };
    }
  }
  return null;
}

// ---- resolver file video langsung ----
// Sebagian platform hanya mengembalikan metadata + tautan cobalt.tools
// (bukan file). Supaya hasil unduhan benar-benar tampil di chat dan bisa
// disimpan, coba dua jalur: endpoint aio api-mazval, lalu instance Piped
// untuk YouTube (mp4 muxed: audio + video dalam satu file).
function linksFromBody(body) {
  const data = body && body.data !== undefined ? body.data : body;
  const res = data && typeof data === 'object' && data.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});
  const links = [];
  if (typeof data === 'object' && typeof data.result === 'string' && /^https?:\/\//i.test(data.result)) {
    links.push(data.result.trim());
  }
  [res.download, res.media, res.links, res.formats]
    .filter((x) => x && typeof x === 'object')
    .forEach((x) => downloadLinks(x, links, 0));
  const all = [...new Set(links)]
    .filter((l) => isSafeMediaUrl(l))
    .filter((l) => !/^(https?:\/\/)?(www\.)?(cobalt\.tools|api\.qrcode)/i.test(l) || /cobalt\.tools\/api/i.test(l));
  return { data, res, all };
}

function ytIdFrom(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return x.pathname.split('/')[1] || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = x.searchParams.get('v');
      if (v) return v;
      const m = x.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch { /* bukan URL YouTube */ }
  return null;
}

const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
];

// probe ringan (Range 1KB) untuk memastikan tautan benar-benar bisa diunduh
// dan tipenya bukan halaman HTML/JSON; sebagian CDN menolak tanpa kredensial.
async function videoUrlPlayable(url) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (WhatsapIndo Bot)', Accept: 'video/*,*/*' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    const ct = String(res.headers.get('content-type') || '');
    const ok = (res.status === 200 || res.status === 206) && !/text\/html|application\/json|text\/plain/i.test(ct);
    if (res.body && typeof res.body.cancel === 'function') { try { await res.body.cancel(); } catch { /* abaikan */ } }
    return ok;
  } catch {
    return false;
  }
}

async function resolveYouTubeVideo(id) {
  const deadline = Date.now() + 30000; // batas total supaya balasan bot tidak terlalu lama
  for (const base of PIPED_INSTANCES) {
    if (Date.now() > deadline) break;
    try {
      const res = await fetch(`${base}/streams/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (WhatsapIndo Bot)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const mux = (Array.isArray(data.videoStreams) ? data.videoStreams : [])
        .filter((s) => s && typeof s.url === 'string' && !s.videoOnly && /mp4/i.test(String(s.mimeType || '')) && /^https?:\/\/[^\s<>"']{8,4000}$/i.test(s.url.trim()))
        .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
      for (const s of mux.slice(0, 5)) {
        if (Date.now() > deadline) break;
        if (await videoUrlPlayable(String(s.url).trim())) {
          return { url: String(s.url).trim(), quality: s.quality || '' };
        }
      }
    } catch { /* instance ini sedang mati, coba berikutnya */ }
  }
  return null;
}

async function downReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const key = cmd.replace(/[?:!,.]+$/, '');

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(key)) return DOWN_MENU;

  const url = extractUrl(text);
  if (!url) {
    return errBlock('Tautan tidak ditemukan', 'Kirim tautan video yang valid, contoh: https://youtu.be/xxxxxxx');
  }

  const platform = platformFor(url);
  const path = platform ? platform.path : '/api/download/aio';

  let body;
  try {
    body = await callApi(path, { url });
  } catch (e) {
    return errBlock('Video tidak dapat diunduh', e.message);
  }
  if (body && (body.success === false || body.status === false)) {
    return errBlock('Video tidak dapat diunduh', body.error || body.message || 'Platform tidak mengembalikan data.');
  }

  const data = body && body.data !== undefined ? body.data : body;
  const res = data && typeof data === 'object' && data.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});

  const title = res.title || res.name || res.caption || res.description || '';
  const author = res.author || res.author_name || res.uploader || res.owner || res.username || res.channel || '';
  const source = res.url || res.link || url;

  // kumpulkan tautan unduh dari struktur respons yang umum dipakai api-mazval
  const links = [];
  if (typeof data === 'object' && typeof data.result === 'string' && /^https?:\/\//i.test(data.result)) {
    links.push(data.result.trim());
  }
  [res.download, res.media, res.links, res.formats]
    .filter((x) => x && typeof x === 'object')
    .forEach((x) => downloadLinks(x, links, 0));

  let media = pickMedia([res, typeof data === 'object' ? data : null, body], links, title);
  const extraLinks = [];

  // jalur 1: platform hanya memberi metadata/cobalt -> coba endpoint aio api-mazval
  if ((!media || media.type !== 'video') && platform && platform.path !== '/api/download/aio') {
    console.log(`[down] fallback aio ${url}`);
    try {
      const fbBody = await callApi('/api/download/aio', { url }, { timeout: 25000 });
      if (fbBody && fbBody.success !== false && fbBody.status !== false) {
        const fb = linksFromBody(fbBody);
        const fbMedia = pickMedia([fb.res, typeof fb.data === 'object' ? fb.data : null, fbBody], fb.all, fb.res.title || fb.res.name || title);
        extraLinks.push(...fb.all);
        if (fbMedia && fbMedia.type === 'video') media = fbMedia;
      }
    } catch { /* upstream aio sedang tidak tersedia, lanjut */ }
  }

  // jalur 2: YouTube -> instance Piped menyediakan file mp4 muxed (audio+video)
  if (!media || media.type !== 'video') {
    const yt = ytIdFrom(url);
    if (yt) {
      console.log(`[down] resolver piped yt=${yt}`);
      const resolved = await resolveYouTubeVideo(yt);
      console.log(`[down] piped result=${resolved ? resolved.url : 'null'}`);
      if (resolved) {
        const base = (title || 'youtube').replace(/[^\w.\- ]+/g, '').trim().slice(0, 70) || 'video';
        media = { type: 'video', url: resolved.url, name: `${base}.mp4`, mime: 'video/mp4' };
        extraLinks.push(resolved.url);
      }
    }
  }

  // batas 4000 karakter: URL video googlevideo/piped biasanya panjang (>1000)
  const all = [...new Set([...links, ...extraLinks])]
    .filter((l) => /^https?:\/\/[^\s<>"']{8,4000}$/i.test(String(l || '')))
    .filter((l) => !/^(https?:\/\/)?(www\.)?(cobalt\.tools|api\.qrcode)/i.test(l) || /cobalt\.tools\/api/i.test(l));

  // tautan sumber tak perlu diulang di daftar unduh, kecuali memang file media langsung
  const DIRECT_FILE = /\.(mp4|mp3|m4a|webm|mkv|mov|png|jpe?g|webp)(\?|#|$)/i;
  const haveVideo = !!(media && media.type === 'video');
  const dl = all
    .filter((l) => l !== source || DIRECT_FILE.test(l))
    .filter((l) => (haveVideo ? !/cobalt\.tools\/api/i.test(l) : true));

  const note = res.download && res.download.note && !haveVideo
    ? String(res.download.note)
    : '';

  const label = platform ? platform.label : 'Media';
  const hasInfo = !!(title || dl.length || media);

  if (!hasInfo && !note) {
    return errBlock('Video tidak dapat diunduh', 'Platform tidak mengembalikan data unduhan. Coba tautan lain.');
  }

  const out = [
    `✅ ${hasInfo ? 'Media ditemukan' : 'Tautan dikenali'} — ${label}`,
    '',
    ...(title ? [`Judul   : ${title}`] : []),
    ...(author ? [`Kreator : ${author}`] : []),
    '',
  ];

  if (dl.length) {
    out.push('Tautan unduh:');
    const hasLong = dl.some((l) => l.length > 250);
    dl.filter((l) => l.length <= 250).slice(0, 6).forEach((l) => {
      const low = l.toLowerCase();
      const keyIcon = Object.keys(DL_ICON).find((k) => low.includes(`format=${k}`) || low.includes(`.${k}`));
      out.push(`${DL_ICON[keyIcon] || '🔗'} ${l}`);
    });
    if (hasLong) out.push('📎 File video langsung ditampilkan di atas pesan ini (tersimpan permanen di server).');
    out.push('');
  } else {
    out.push(
      'Cara unduh:',
      'Buka https://cobalt.tools lalu tempel tautan sumber di sana.',
      ''
    );
  }

  out.push(`Tautan sumber: ${source}`);
  if (note) out.push('', `Catatan : ${note}`);
  out.push(
    '',
    'Klik tautan untuk membuka, atau salin tempel di aplikasi unduh favoritmu.',
    'Balas "menu" bila butuh perintah lain.'
  );

  // tampilan langsung: video .mp4 bila tersedia, selain itu thumbnail/pratinjau
  if (media) return { text: out.join('\n'), media };
  return out.join('\n');
}

/* ---------- Bot 5: Generate email lengkap ---------- */

const EMAIL_MENU = [
  '╭─────────────────────────────',
  '│ EMAIL GENERATOR',
  '│ Email sementara · Inbox · OTP',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. buat [nama]',
  '   Buat email baru (nama & domain opsional).',
  '',
  '2. domains',
  '   Daftar domain yang tersedia.',
  '',
  '3. cek <email>',
  '   Cek kotak masuk + OTP / tautan verifikasi.',
  '',
  '4. baca <email> <nomor>',
  '   Baca isi pesan sesuai nomor dari hasil "cek".',
  '',
  'Contoh:',
  '  buat',
  '  buat rizky@bhap.me',
  '  cek rizky@bhap.me',
  '  baca rizky@bhap.me 1',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

// daftar pesan terakhir per email -> supaya perintah "baca <email> <nomor>" bisa jalan
const inboxCache = new Map();

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function emailReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return EMAIL_MENU;

  if (['buat', 'generate', 'create', 'new', 'email'].includes(cmd)) {
    const spec = arg.trim();
    const params = {};
    if (spec.includes('@')) {
      const [u, d] = spec.split('@');
      if (u) params.username = u;
      if (d) params.domain = d.replace(/^@/, '');
    } else if (spec) {
      params.username = spec;
    }

    let body;
    try {
      body = await callApi('/api/tempmail/generate', params);
    } catch (e) {
      return errBlock('Email tidak dapat dibuat', e.message);
    }
    if (body && body.success === false) return errBlock('Email tidak dapat dibuat', body.error);

    const data = body && body.data !== undefined ? body.data : body;
    const email = data && data.email;
    if (!email) return errBlock('Email tidak dapat dibuat', 'Respons API tidak memuat alamat email.');

    const inboxUrl = (data && data.inbox_url) || `https://generator.email/${email}`;
    return [
      '✅ Email sementara berhasil dibuat',
      '',
      angkaFence(email),
      '',
      `Buka kotak masuk : ${inboxUrl}`,
      `Cek pesan masuk   : cek ${email}`,
      `Baca pesan        : baca ${email} 1`,
      '',
      'Email aktif selama masih bisa menerima pesan di generator.email.',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['domains', 'domain', 'daftar'].includes(cmd)) {
    let body;
    try {
      body = await callApi('/api/tempmail/domains', {});
    } catch (e) {
      return errBlock('Daftar domain tidak tersedia', e.message);
    }
    if (body && body.success === false) return errBlock('Daftar domain tidak tersedia', body.error);
    const data = body && body.data !== undefined ? body.data : body;
    const domains = (data && data.domains) || [];
    if (!Array.isArray(domains) || !domains.length) {
      return errBlock('Daftar domain tidak tersedia', 'API tidak mengembalikan daftar domain.');
    }
    return [
      `✅ ${domains.length} domain tersedia`,
      '',
      fence('text', domains.map((d, i) => `${String(i + 1).padStart(2, '0')}. ${d}`).join('\n')),
      '',
      'Pakai perintah: buat <nama>@<domain>',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['cek', 'check', 'inbox', 'masuk'].includes(cmd)) {
    const email = arg.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return errBlock('Format email belum benar', 'Gunakan: cek nama@domain.com');
    }
    let body;
    try {
      body = await callApi('/api/tempmail/inbox', { email });
    } catch (e) {
      return errBlock('Kotak masuk tidak dapat dibuka', e.message);
    }
    if (body && body.success === false) return errBlock('Kotak masuk tidak dapat dibuka', body.error);

    const data = body && body.data !== undefined ? body.data : body;
    const messages = (data && data.messages) || [];
    const otp = data && data.otp;
    const link = data && data.verification_link;

    if (Array.isArray(messages)) inboxCache.set(email, messages);

    const head = [
      otp ? '🔐 Kode OTP ditemukan' : '📬 Kotak masuk',
      '',
      angkaFence(email),
      '',
    ];

    if (otp) head.push(`Kode OTP: ${otp}`, '');
    if (link) head.push(`Tautan verifikasi: ${link}`, '');

    if (!messages.length) {
      return head.concat([
        'Belum ada pesan masuk.',
        `Tunggu sebentar lalu balas: cek ${email}`,
        '',
        'Buka kotak masuk: ' + `https://generator.email/${email}`,
      ]).join('\n');
    }

    const list = messages.slice(0, 10).map((m, i) => [
      `${i + 1}. ${String(m.subject || '(tanpa subjek)').slice(0, 80)}`,
      `   Dari : ${String(m.from || '-').slice(0, 80)}`,
      `   Waktu: ${String(m.date || '-')}`,
    ].join('\n'));

    return head.concat([
      `${messages.length} pesan masuk:`,
      '',
      ...list,
      '',
      `Baca pesan: baca ${email} <nomor>`,
      `Contoh    : baca ${email} 1`,
    ]).join('\n');
  }

  if (['baca', 'read', 'open', 'lihat'].includes(cmd)) {
    const parts = arg.split(/\s+/).filter(Boolean);
    const email = (parts[0] || '').toLowerCase();
    const no = Number(parts[1]);
    if (!email || !EMAIL_RE.test(email) || !no || no < 1) {
      return errBlock('Format perintah belum benar', 'Gunakan: baca <email> <nomor> — nomor diambil dari hasil "cek".');
    }
    const cached = inboxCache.get(email) || [];
    const msg = cached[no - 1];
    if (!msg) {
      return errBlock('Pesan tidak ditemukan', `Balas dulu: cek ${email} — lalu baca dengan nomor yang tercantum.`);
    }
    if (!msg.link) return errBlock('Pesan tidak dapat dibuka', 'Tautan pesan tidak tersedia di respons API.');

    let body;
    try {
      body = await callApi('/api/tempmail/message', { email, link: msg.link });
    } catch (e) {
      return errBlock('Pesan tidak dapat dibuka', e.message);
    }
    if (body && body.success === false) return errBlock('Pesan tidak dapat dibuka', body.error);

    const data = body && body.data !== undefined ? body.data : body;
    const isi = stripHtml(data && data.body).slice(0, 3500) || '(pesan kosong)';
    const out = [
      `✉️ Pesan ${no} — ${String((data && data.subject) || msg.subject || '(tanpa subjek)').slice(0, 100)}`,
      '',
      `Dari    : ${String((data && data.from) || msg.from || '-')}`,
      `Tanggal : ${String((data && data.date) || msg.date || '-')}`,
    ];
    if (data && data.otp) out.push('', `Kode OTP: ${data.otp}`);
    if (data && data.verification_link) out.push(`Tautan verifikasi: ${data.verification_link}`);
    out.push('', 'Isi pesan:', fence('text', isi), '', 'Balas "menu" bila butuh perintah lain.');
    return out.join('\n');
  }

  return errBlock('Perintah tidak dikenal', `Tidak ada perintah "${cmd}".`);
}

/* ---------- Bot 6: Tools (terjemah, cuaca, IP, QR, npm) ---------- */

const TOOLS_MENU = [
  '╭─────────────────────────────',
  '│ TOOLS',
  '│ Terjemah · Cuaca · IP · QR · npm',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. terjemah <teks>',
  '   Terjemahkan teks en → id.',
  '',
  '2. cuaca <kota>',
  '   Cuaca kota saat ini.',
  '',
  '3. ip <alamat>',
  '   Info IP / domain (lokasi, ISP, ASN).',
  '',
  '4. qr <teks>',
  '   Buat gambar QR Code.',
  '',
  '5. npm <paket>',
  '   Info paket dari registry npm.',
  '',
  'Contoh:',
  '  terjemah good morning',
  '  cuaca Jakarta',
  '  ip 8.8.8.8',
  '  qr https://whatsap-indo.vercel.app',
  '  npm socket.io',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

function pickResult(body) {
  if (!body || typeof body !== 'object') return {};
  const data = body.data !== undefined ? body.data : body;
  if (data && typeof data === 'object' && data.result && typeof data.result === 'object') return data.result;
  return data && typeof data === 'object' ? data : {};
}

async function toolsReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return TOOLS_MENU;

  if (['terjemah', 'translate', 'terjemahkan'].includes(cmd)) {
    if (!arg) return errBlock('Teks belum diisi', 'Gunakan: terjemah good morning');
    let body;
    try {
      body = await callApi('/api/tools/translate', { text: arg, from: 'en', id: 'id' });
    } catch (e) {
      return errBlock('Terjemahan gagal', e.message);
    }
    if (body && body.success === false) return errBlock('Terjemahan gagal', body.error);
    const r = pickResult(body);
    if (!r.translation) return errBlock('Terjemahan gagal', 'Respons API tidak memuat hasil terjemahan.');
    return [
      '🌐 Hasil terjemahan (en → id)',
      '',
      fence('text', r.translation),
      '',
      `Teks asli: ${arg}`,
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['cuaca', 'weather'].includes(cmd)) {
    const kota = arg.trim();
    if (!kota) return errBlock('Kota belum diisi', 'Gunakan: cuaca Jakarta');
    let body;
    try {
      body = await callApi('/api/info/cuaca', { kota });
    } catch (e) {
      return errBlock('Cuaca tidak tersedia', e.message);
    }
    if (body && body.success === false) return errBlock('Cuaca tidak tersedia', body.error);
    const r = pickResult(body);
    if (!r.suhu_c) return errBlock('Cuaca tidak tersedia', 'Data cuaca tidak ditemukan untuk kota tersebut.');
    const hari = r.hari_ini || {};
    return [
      `🌤️ Cuaca ${r.kota || kota}`,
      '',
      angkaFence(`${r.suhu_c}°C · Kelembaban ${r.kelembaban || '-'}% · Angin ${r.angin_kmph || '-'} km/jam ${r.angin_arah || ''}`.trim()),
      '',
      `Kondisi   : ${r.deskripsi || '-'}`,
      ...(hari.max ? [`Hari ini  : maks ${hari.max}°C · min ${hari.min}°C`] : []),
      ...(hari.sunrise ? [`Terbit    : ${hari.sunrise} · Terbenam: ${hari.sunset}`] : []),
      ...(r.curah_hujan_mm ? [`Curah hujan: ${r.curah_hujan_mm} mm`] : []),
      '',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['ip', 'ipinfo', 'geo'].includes(cmd)) {
    const q = arg.trim();
    if (!q) return errBlock('Alamat belum diisi', 'Gunakan: ip 8.8.8.8');
    let body;
    try {
      body = await callApi('/api/tools/ip-lookup', { ip: q });
    } catch (e) {
      return errBlock('IP tidak dapat dicek', e.message);
    }
    if (body && body.success === false) return errBlock('IP tidak dapat dicek', body.error);
    const r = pickResult(body);
    if (!r.ip) return errBlock('IP tidak dapat dicek', 'Alamat IP / domain tidak valid.');
    return [
      '📍 Info alamat IP',
      '',
      angkaFence(`${r.ip} · ${r.type || '-'}${r.asn ? ` · ASN ${r.asn}` : ''}`),
      '',
      `Lokasi   : ${[r.city, r.region, r.country].filter(Boolean).join(', ')} ${r.flag || ''}`,
      `ISP      : ${r.isp || r.org || '-'}`,
      `Timezone : ${r.timezone || '-'} (${r.utc || '-'})`,
      ...(r.latitude ? [`Koordinat: ${r.latitude}, ${r.longitude}`] : []),
      '',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['qr', 'qrcode'].includes(cmd)) {
    if (!arg) return errBlock('Teks belum diisi', 'Gunakan: qr https://example.com');
    let body;
    try {
      body = await callApi('/api/tools/qr-create', { text: arg, size: '400x400' });
    } catch (e) {
      return errBlock('QR tidak dapat dibuat', e.message);
    }
    if (body && body.success === false) return errBlock('QR tidak dapat dibuat', body.error);
    const r = pickResult(body);
    if (!r.url) return errBlock('QR tidak dapat dibuat', 'Respons API tidak memuat gambar QR.');
    return [
      '🔳 QR Code berhasil dibuat',
      '',
      `Isi : ${arg.slice(0, 120)}`,
      `Ukuran: ${r.size || '400x400'}`,
      '',
      `Gambar QR: ${r.url}`,
      '',
      'Klik tautan untuk membuka gambarnya, lalu unduh atau screenshot.',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  if (['npm', 'paket', 'package'].includes(cmd)) {
    const pkg = arg.trim();
    if (!pkg) return errBlock('Nama paket belum diisi', 'Gunakan: npm socket.io');
    let body;
    try {
      body = await callApi('/api/tools/npmjs', { package: pkg });
    } catch (e) {
      return errBlock('Paket tidak ditemukan', e.message);
    }
    if (body && body.success === false) return errBlock('Paket tidak ditemukan', body.error);
    const r = pickResult(body);
    if (!r.name) return errBlock('Paket tidak ditemukan', `Paket "${pkg}" tidak ada di registry npm.`);
    return [
      `📦 ${r.name}@${r.version || 'unknown'}`,
      '',
      ...(r.description ? [`Deskripsi: ${String(r.description).slice(0, 300)}`] : []),
      ...(r.license ? [`Lisensi  : ${r.license}`] : []),
      ...(r.homepage ? [`Homepage : ${r.homepage}`] : []),
      ...(r.author ? [`Penulis  : ${r.author}`] : []),
      ...(r.modified ? [`Update   : ${r.modified}`] : []),
      '',
      `Instal   : npm install ${r.name}`,
      '',
      'Balas "menu" bila butuh perintah lain.',
    ].join('\n');
  }

  return errBlock('Perintah tidak dikenal', `Tidak ada perintah "${cmd}".`);
}

/* ---------- Bot 7: Screenshot Kode (PNG biner codesnap) ---------- */

const KODESNAP_MENU = [
  '╭─────────────────────────────',
  '│ SCREENSHOT KODE',
  '│ Render kode jadi gambar ala VS Code',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. kode <teks>',
  '   Render kode jadi gambar (maks 600 karakter).',
  '',
  'Contoh:',
  '  kode console.log("halo dunia")',
  '  kode const jumlah = 1 + 2;',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

async function kodesnapReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return KODESNAP_MENU;
  if (!['kode', 'kodesnap', 'snapshot', 'code'].includes(cmd)) {
    return errBlock('Perintah tidak dikenal', 'Gunakan: kode <teks>. Contoh: kode console.log("halo")');
  }
  if (!arg) return errBlock('Kode belum diisi', 'Gunakan: kode console.log("halo dunia")');

  let out;
  try {
    out = await callApiBuffer('/api/image/codesnap', { text: arg.slice(0, 600) }, { timeout: 30000 });
  } catch (e) {
    return errBlock('Render kode gagal', e.message);
  }
  const stored = await storeBuffer(out.buffer, 'image', 'kodesnap.png');
  if (!stored) return errBlock('Render kode gagal', 'Gambar hasil render gagal disimpan.');

  return {
    text: [
      '✅ Kode berhasil dirender jadi gambar.',
      '',
      `Panjang kode: ${arg.length} karakter`,
      'Klik gambarnya untuk menyimpan, atau balas "menu" untuk perintah lain.',
    ].join('\n'),
    media: { type: 'image', url: stored.url, name: stored.name, mime: 'image/png', size: stored.size, cached: true },
  };
}

/* ---------- Bot 8: Unduh Kode npm (zip biner npm2zip) ---------- */

const NPMZIP_MENU = [
  '╭─────────────────────────────',
  '│ UNDUH KODE NPM',
  '│ Source code paket npm (.zip)',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. zip <paket> [versi]',
  '   Unduh kode sumber paket npm sebagai zip.',
  '',
  'Contoh:',
  '  zip express',
  '  zip left-pad 1.3.0',
  '  zip @types/node',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

async function npmZipReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return NPMZIP_MENU;
  if (!['zip', 'unduh', 'source', 'kodezip'].includes(cmd)) {
    return errBlock('Perintah tidak dikenal', 'Gunakan: zip <paket>. Contoh: zip express');
  }

  const tokens = arg.split(/\s+/).filter(Boolean);
  const pkg = tokens[0] || '';
  const ver = tokens[1] || '';
  if (!pkg) return errBlock('Nama paket belum diisi', 'Gunakan: zip express');
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(pkg)) {
    return errBlock('Nama paket tidak valid', 'Contoh: zip express, zip left-pad 1.3.0, atau zip @types/node');
  }

  let out;
  try {
    out = await callApiBuffer(
      '/api/tools/npm2zip',
      ver ? { package: pkg, version: ver } : { package: pkg },
      { timeout: 60000 }
    );
  } catch (e) {
    return errBlock('Unduhan kode gagal', e.message);
  }

  const stored = await storeBuffer(out.buffer, 'file', out.filename || `${pkg}.zip`);
  if (!stored) return errBlock('Unduhan kode gagal', 'File zip gagal disimpan.');
  const mb = (stored.size / (1024 * 1024)).toFixed(1);

  return {
    text: [
      `✅ Kode sumber ${pkg}${ver ? `@${ver}` : ''} siap diunduh.`,
      '',
      `File   : ${stored.name}`,
      `Ukuran : ${mb} MB`,
      '',
      'Klik file untuk mengunduh, atau balas "menu" untuk perintah lain.',
    ].join('\n'),
    media: { type: 'file', url: stored.url, name: stored.name, mime: 'application/zip', size: stored.size, cached: true },
  };
}

/* ---------- Bot 9: Katalog Model AI (mimo/models) ---------- */

const MODEL_MENU = [
  '╭─────────────────────────────',
  '│ KATALOG MODEL AI',
  '│ Daftar model mimo & providernya',
  '╰─────────────────────────────',
  '',
  'Perintah yang tersedia:',
  '',
  '1. daftar',
  '   Ringkasan katalog + model teratas.',
  '',
  '2. cari <kata>',
  '   Cari model berdasarkan nama/provider.',
  '',
  '3. gratis',
  '   Hanya model yang gratis dipakai.',
  '',
  'Contoh:',
  '  daftar',
  '  cari xiaomi',
  '  gratis',
  '',
  'Balas "menu" kapan saja untuk membuka daftar perintah.',
].join('\n');

async function modelListReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text).replace(/[?:!,.]+$/, '');
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return MODEL_MENU;
  if (!['daftar', 'list', 'model', 'cari', 'gratis', 'free'].includes(cmd)) {
    return errBlock('Perintah tidak dikenal', 'Gunakan: daftar · cari <kata> · gratis');
  }

  let body;
  try {
    body = await callApi('/api/mimo/models', {}, { timeout: 20000 });
  } catch (e) {
    return errBlock('Katalog model tidak tersedia', e.message);
  }
  if (body && (body.success === false || body.status === 'error')) {
    return errBlock('Katalog model tidak tersedia', body.error || body.message || 'Respons API tidak valid.');
  }

  const data = (body && body.data) || {};
  const models = Array.isArray(data.models) ? data.models : [];
  if (!models.length) return errBlock('Katalog model', 'Daftar model tidak tersedia saat ini.');

  let list = models;
  let heading = 'Daftar model';
  if (cmd === 'cari') {
    const q = arg.trim().toLowerCase();
    if (!q) return errBlock('Kata kunci belum diisi', 'Gunakan: cari xiaomi');
    list = models.filter((m) =>
      [m.id, m.name, m.provider].some((v) => String(v || '').toLowerCase().includes(q))
    );
    if (!list.length) return errBlock('Model tidak ditemukan', `Tidak ada model yang cocok dengan "${arg.trim()}".`);
    heading = `Hasil cari "${arg.trim()}"`;
  } else if (cmd === 'gratis' || cmd === 'free') {
    list = models.filter((m) => !m.premium);
    heading = 'Model gratis';
  }

  const lines = [
    '✅ Katalog Model AI',
    '',
    `Total   : ${data.total ?? models.length} model (${data.free ?? '-'} gratis, ${data.premium ?? '-'} berbayar)`,
    `Provider: ${data.providers ?? '-'}`,
    '',
    `${heading} (${list.length}):`,
  ];
  for (const m of list.slice(0, 12)) {
    lines.push(`• ${m.name || m.id || '-'} — ${m.provider || '-'}${m.premium ? ' (berbayar)' : ' (gratis)'}`);
  }
  if (list.length > 12) lines.push(`• … +${list.length - 12} lainnya`);
  lines.push('', 'Perintah: daftar · cari <kata> · gratis', 'Balas "menu" bila butuh perintah lain.');
  return lines.join('\n');
}

/* ---------- bot generik ----------
   Setiap spesifikasi memetakan perintah ke endpoint api-mazval yang benar-benar
   tersedia. Balasan otomatis: baris ringkas, daftar data (maks 5), blok JSON
   rapi (Copy), dan preview gambar/video bila respons memuat media. */

const NOEXT_MEDIA_HOSTS = ['api.qrserver.com', 'api.brattxt.xyz', 'image.thum.io'];

function prettifyKey(key) {
  return String(key || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

function scalarFields(node, prefix, out, depth) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return out;
  for (const [k, v] of Object.entries(node)) {
    if (v === null || v === undefined || v === '') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object') scalarFields(v, key, out, depth + 1);
    else out.push([key, v]);
    if (out.length >= 18) break;
  }
  return out;
}

function firstArray(node, depth) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) return node.length ? node : null;
  if (typeof node !== 'object') return null;
  for (const v of Object.values(node)) {
    const hit = firstArray(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function mediaFromNode(node, depth) {
  if (!node || depth > 5) return null;
  if (typeof node === 'string') {
    const u = node.trim();
    if (!isSafeMediaUrl(u)) return null;
    const path = u.split(/[?#]/)[0].toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(path)) {
      return { type: 'image', url: u, name: 'pratinjau.jpg', mime: guessMime(u) || 'image/jpeg' };
    }
    if (/\.(mp4|webm|mov|mkv)$/.test(path)) {
      return { type: 'video', url: u, name: 'pratinjau.mp4', mime: guessMime(u) || 'video/mp4' };
    }
    let host = '';
    try { host = new URL(u).hostname; } catch { return null; }
    if (NOEXT_MEDIA_HOSTS.includes(host)) return { type: 'image', url: u, name: 'pratinjau.jpg', mime: 'image/jpeg' };
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const m = mediaFromNode(item, depth + 1);
      if (m) return m;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const k of ['url', 'image', 'thumbnail', 'screenshot', 'preview']) {
      if (k in node) {
        const m = mediaFromNode(node[k], depth + 1);
        if (m) return m;
      }
    }
    for (const v of Object.values(node)) {
      const m = mediaFromNode(v, depth + 1);
      if (m) return m;
    }
  }
  return null;
}

function unwrapBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.result !== undefined && body.result !== null) return body.result;
  if (body.data !== undefined && body.data !== null) return body.data;
  const skip = new Set(['status', 'success', 'creator', 'endpoint', 'message', 'sumber', 'source']);
  const out = {};
  for (const [k, v] of Object.entries(body)) if (!skip.has(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function normalizeArg(key, value) {
  const v = String(value || '').trim();
  if (['url', 'link'].includes(key) && v && !/^https?:\/\//i.test(v)) return 'https://' + v.replace(/^\/+/, '');
  return v;
}

function buildParams(cmd, args) {
  const spec = cmd.params;
  if (!spec) return {};
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    const out = {};
    for (const [key, role] of Object.entries(spec)) {
      if (role === 'rest') {
        if (!args) return null;
        out[key] = normalizeArg(key, args);
      } else if (role === 'rest?') {
        if (args) out[key] = normalizeArg(key, args);
      } else {
        out[key] = role;
      }
    }
    return out;
  }
  const tokens = args
    ? args.split(/[\s,]+/).filter(Boolean).filter((t) => !['ke', '->', '→'].includes(t.toLowerCase()))
    : [];
  const out = { ...(cmd.defaults || {}) };
  for (let i = 0; i < spec.length; i++) {
    if (tokens[i] !== undefined) out[spec[i]] = normalizeArg(spec[i], tokens[i]);
    else if (out[spec[i]] === undefined) return null;
  }
  return out;
}

function genericLines(label, data) {
  const lines = ['✅ ' + label, ''];
  const fields = scalarFields(data, '', [], 0);
  for (const [k, v] of fields.slice(0, 16)) lines.push(`${prettifyKey(k)}: ${String(v).slice(0, 180)}`);
  const list = firstArray(data, 0);
  if (list && list.length) {
    lines.push('', `Data (${list.length}):`);
    for (const item of list.slice(0, 5)) {
      if (item && typeof item === 'object') {
        const parts = scalarFields(item, '', [], 0).slice(0, 4)
          .map(([k, v]) => `${prettifyKey(k)} ${String(v).slice(0, 80)}`);
        lines.push(`• ${parts.join(' · ')}`);
      } else {
        lines.push(`• ${String(item).slice(0, 160)}`);
      }
    }
    if (list.length > 5) lines.push(`• … +${list.length - 5} lainnya`);
  }
  const json = JSON.stringify(data, null, 2);
  if (json && json !== '{}') {
    lines.push('', json.length <= 2600 ? jsonFence(data) : fence('json', json.slice(0, 2400) + '\n… (dipotong)'));
  }
  lines.push('', 'Balas "menu" untuk daftar perintah lain.');
  return lines.join('\n');
}

function specMenu(spec) {
  const lines = [
    '╭─────────────────────────────',
    `│ ${spec.name.toUpperCase()}`,
    `│ ${spec.tagline}`,
    '╰─────────────────────────────',
    '',
    'Perintah:',
  ];
  for (const c of spec.commands) lines.push(`  ${c.usage.padEnd(26)}— ${c.desc}`);
  lines.push('', 'Contoh:');
  for (const c of spec.commands.slice(0, 3)) if (c.example) lines.push(`  ${c.example}`);
  lines.push('', 'Balas "menu" kapan saja untuk membuka daftar ini.');
  return lines.join('\n');
}

async function genericReply(spec, raw) {
  const text = String(raw || '').trim();
  const word = firstWord(text);
  const key = word.replace(/[?:!,.]+$/, '');
  if (!word || ['menu', 'help', 'bantuan', '?'].includes(key)) return specMenu(spec);
  const cmd = spec.commands.find((c) => c.words.includes(key));
  if (!cmd) {
    return errBlock('Perintah tidak dikenal', `Perintah ${spec.name}: ${spec.commands.map((c) => c.usage).join(' · ')}.`);
  }
  const params = buildParams(cmd, rest(text));
  if (params === null) return errBlock(cmd.usage, `Contoh: ${cmd.example || cmd.usage}`);
  let body;
  try {
    body = await callApi(cmd.path, params, { timeout: cmd.timeout });
  } catch (e) {
    return errBlock(cmd.label || spec.name, e.message);
  }
  if (body && (body.success === false || body.status === false)) {
    return errBlock(cmd.label || spec.name, body.error || body.message || 'Data tidak ditemukan.');
  }
  let data = unwrapBody(body);
  if (data === null) return errBlock(cmd.label || spec.name, 'Layanan tidak mengembalikan data.');
  if (typeof data !== 'object') data = { hasil: data };
  const media = mediaFromNode(data, 0) || mediaFromNode(body, 0);
  const out = { text: genericLines(cmd.label || spec.name, data) };
  if (media) out.media = media;
  return out;
}

function makeBotFromSpec(spec) {
  return {
    id: spec.id,
    email: spec.email,
    name: spec.name,
    about: spec.about,
    reply: (text) => genericReply(spec, text),
  };
}

/* ---------- manajemen akun bot ---------- */

async function seed() {
  const now = Date.now();
  for (const bot of BOTS) {
    try {
      const existing = await db.get('SELECT id, name, about FROM users WHERE id = ? OR email = ?', bot.id, bot.email);
      if (existing) {
        if (String(existing.id) === bot.id) {
          // nama/bio khusus admin dipertahankan; hanya baris dengan nama bawaan
          // (atau kosong) yang disegarkan ke default terbaru
          const custom = existing.name && !DEFAULT_NAMES.has(String(existing.name));
          await db.run(
            `UPDATE users SET is_bot = 1, verified = 1, account_status = 'active', banned = 0
             WHERE id = ?`,
            bot.id
          );
          if (!custom) {
            await db.run(
              'UPDATE users SET name = ?, about = ? WHERE id = ?',
              bot.name,
              bot.about,
              bot.id
            );
          }
        }
        continue;
      }
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);
      await db.run(
        `INSERT INTO users (id, email, name, password_hash, about, verified, is_bot, account_status, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, 1, 1, 'active', ?, 0)`,
        bot.id,
        bot.email,
        bot.name,
        hash,
        bot.about,
        now
      );
    } catch (err) {
      console.error('bot seed', bot.id + ':', err.message);
    }
  }
}

async function peerInChat(chatId) {
  const row = await db.get(
    `SELECT u.* FROM users u
     JOIN chat_members m ON m.user_id = u.id
     WHERE m.chat_id = ? AND u.is_bot = 1
     LIMIT 1`,
    chatId
  );
  return row || null;
}

async function get(id) {
  const row = await db.get('SELECT * FROM users WHERE id = ?', String(id || ''));
  return isBot(row) ? row : null;
}

async function reply(bot, text) {
  const def = byId.get(String(bot && bot.id));
  if (!def) return null;
  return def.reply(text);
}

/* ---------- 36 bot generik: total45 bot ----------
   Hanya endpoint api-mazval yang sudah teruji dipakai di sini (lihat tiap
   spesifikasi). Balasan, menu, dan format seluruhnya digenerate dari spesifikasi. */

const GENERIC_SPECS = [
  {
    id: 'bot-cuaca', email: 'cuaca@bot.whatsap-indo', name: 'Cuaca',
    tagline: 'Cuaca kota saat ini',
    about: 'Cuaca kota real-time: suhu, kelembaban & angin. Contoh: cuaca Jakarta.',
    commands: [
      { words: ['cuaca', 'weather'], usage: 'cuaca <kota>', example: 'cuaca Jakarta',
        desc: 'Cuaca kota saat ini', params: { kota: 'rest' }, path: '/api/info/cuaca', label: 'Cuaca' },
    ],
  },
  {
    id: 'bot-gempa', email: 'gempa@bot.whatsap-indo', name: 'Info Gempa',
    tagline: 'Gempa bumi terkini',
    about: 'Gempa bumi terkini dari BMKG. Contoh: gempa.',
    commands: [
      { words: ['gempa', 'quake', 'earthquake'], usage: 'gempa', example: 'gempa',
        desc: 'Gempa terkini (BMKG)', params: null, path: '/api/info/gempa', label: 'Gempa' },
    ],
  },
  {
    id: 'bot-sholat', email: 'sholat@bot.whatsap-indo', name: 'Jadwal Sholat',
    tagline: 'Jadwal sholat & doa harian',
    about: 'Jadwal sholat per kota & kumpulan doa harian. Contoh: sholat Jakarta.',
    commands: [
      { words: ['sholat', 'jadwalsholat', 'salat'], usage: 'sholat <kota>', example: 'sholat Jakarta',
        desc: 'Jadwal sholat kota', params: { kota: 'rest' }, path: '/api/info/jadwal-sholat', label: 'Jadwal Sholat' },
      { words: ['doa'], usage: 'doa <kata>', example: 'doa tidur',
        desc: 'Cari doa harian', params: { q: 'rest' }, path: '/api/info/doa', label: 'Doa' },
    ],
  },
  {
    id: 'bot-quran', email: 'quran@bot.whatsap-indo', name: 'Al-Quran',
    tagline: 'Teks Arab, latin & terjemah',
    about: 'Teks surah Al-Quran lengkap: Arab, latin & terjemah. Contoh: surat 1.',
    commands: [
      { words: ['surat', 'ayat'], usage: 'surat <1-114>', example: 'surat 112',
        desc: 'Teks & terjemah surah', params: { nomor: 'rest' }, path: '/api/info/alquran', label: 'Surah' },
    ],
  },
  {
    id: 'bot-mimpi', email: 'mimpi@bot.whatsap-indo', name: 'Tafsir Mimpi',
    tagline: 'Tafsir mimpi & arti nama',
    about: 'Tafsir mimpi primbon & arti nama lengkap. Contoh: mimpi ular.',
    commands: [
      { words: ['mimpi', 'tafsir'], usage: 'mimpi <teks>', example: 'mimpi ular',
        desc: 'Tafsir mimpi primbon', params: { mimpi: 'rest' }, path: '/api/info/tafsir-mimpi', label: 'Tafsir Mimpi' },
      { words: ['nama', 'arti'], usage: 'nama <nama>', example: 'nama Budi',
        desc: 'Arti sebuah nama', params: { nama: 'rest' }, path: '/api/info/arti-nama', label: 'Arti Nama' },
    ],
  },
  {
    id: 'bot-kurs', email: 'kurs@bot.whatsap-indo', name: 'Kurs & Kripto',
    tagline: 'Mata uang dunia & kripto',
    about: 'Kurs mata uang dunia & harga kripto terkini. Contoh: kurs USD IDR 100.',
    commands: [
      { words: ['kurs', 'konversi'], usage: 'kurs <dari> <ke> [jumlah]', example: 'kurs USD IDR 100',
        desc: 'Konversi mata uang', params: ['from', 'to', 'amount'],
        defaults: { from: 'USD', to: 'IDR', amount: '1' }, path: '/api/tools/currency', label: 'Kurs' },
      { words: ['kripto', 'crypto'], usage: 'kripto <koin>', example: 'kripto bitcoin',
        desc: 'Harga kripto (USD & IDR)', params: { coin: 'rest' }, path: '/api/info/crypto', label: 'Kripto' },
    ],
  },
  {
    id: 'bot-nomor', email: 'nomor@bot.whatsap-indo', name: 'Cek Nomor',
    tagline: 'Info nomor HP & negara',
    about: 'Info operator/prefix nomor HP & data negara. Contoh: nomor 081234567890.',
    commands: [
      { words: ['nomor', 'ceknomor'], usage: 'nomor <08xx>', example: 'nomor 081234567890',
        desc: 'Info operator nomor', params: { nomor: 'rest' }, path: '/api/tools/cek-nomor', label: 'Cek Nomor' },
      { words: ['negara'], usage: 'negara <nama>', example: 'negara Indonesia',
        desc: 'Data sebuah negara', params: { name: 'rest' }, path: '/api/tools/countryInfo', label: 'Negara' },
    ],
  },
  {
    id: 'bot-github', email: 'github@bot.whatsap-indo', name: 'Stalk GitHub',
    tagline: 'Profil GitHub siapa saja',
    about: 'Profil GitHub lengkap: bio, followers, repo. Contoh: github octocat.',
    commands: [
      { words: ['github'], usage: 'github <user>', example: 'github octocat',
        desc: 'Profil GitHub', params: { user: 'rest' }, path: '/api/stalk/github', label: 'Profil GitHub' },
    ],
  },
  {
    id: 'bot-stalk', email: 'stalker@bot.whatsap-indo', name: 'Stalk Sosmed',
    tagline: 'Intip profil sosial media',
    about: 'Intip profil Twitter, YouTube, Pinterest & Threads. Contoh: twitter elonmusk.',
    commands: [
      { words: ['twitter', 'x'], usage: 'twitter <user>', example: 'twitter elonmusk',
        desc: 'Profil Twitter / X', params: { user: 'rest' }, path: '/api/stalk/twitter', label: 'Profil Twitter' },
      { words: ['channel'], usage: 'channel <user>', example: 'channel MrBeast',
        desc: 'Profil channel YouTube', params: { user: 'rest' }, path: '/api/stalk/youtube', label: 'Channel YouTube' },
      { words: ['pinterest'], usage: 'pinterest <user>', example: 'pinterest nasa',
        desc: 'Profil Pinterest', params: { user: 'rest' }, path: '/api/stalk/pinterest', label: 'Profil Pinterest' },
      { words: ['threads'], usage: 'threads <user>', example: 'threads zuck',
        desc: 'Profil Threads', params: { user: 'rest' }, path: '/api/stalk/threads', label: 'Profil Threads' },
    ],
  },
  {
    id: 'bot-quotes', email: 'quotes@bot.whatsap-indo', name: 'Quotes & Pantun',
    tagline: 'Pantun, quote bucin & anime',
    about: 'Pantun, quote bucin & quote anime acak. Contoh: pantun.',
    commands: [
      { words: ['pantun'], usage: 'pantun', example: 'pantun',
        desc: 'Pantun acak', params: null, path: '/api/random/pantun', label: 'Pantun' },
      { words: ['bucin', 'quote'], usage: 'bucin', example: 'bucin',
        desc: 'Quote romantis acak', params: null, path: '/api/random/quote-bucin', label: 'Quote Bucin' },
      { words: ['anime'], usage: 'anime', example: 'anime',
        desc: 'Quote anime acak', params: null, path: '/api/r/quotesanime', label: 'Quote Anime' },
    ],
  },
  {
    id: 'bot-tebak', email: 'tebak@bot.whatsap-indo', name: 'Tebak-Tebakan',
    tagline: 'Teka-teki & asah otak',
    about: 'Tebak-tebakan, teka-teki & asah otak. Contoh: tebak.',
    commands: [
      { words: ['tebak'], usage: 'tebak', example: 'tebak',
        desc: 'Tebak-tebakan acak', params: null, path: '/api/random/tebaktebakan', label: 'Tebak-Tebakan' },
      { words: ['tekateki', 'teka'], usage: 'tekateki', example: 'tekateki',
        desc: 'Teka-teki acak', params: null, path: '/api/random/tekateki', label: 'Teka-Teki' },
      { words: ['asahotak'], usage: 'asahotak', example: 'asahotak',
        desc: 'Asah otak acak', params: null, path: '/api/random/asahotak', label: 'Asah Otak' },
    ],
  },
  {
    id: 'bot-meme', email: 'meme@bot.whatsap-indo', name: 'Meme Random',
    tagline: 'Meme & konten acak',
    about: 'Meme, meme bergambar & konten Reddit acak. Contoh: meme.',
    commands: [
      { words: ['meme'], usage: 'meme', example: 'meme',
        desc: 'Meme acak', params: null, path: '/api/random/meme', label: 'Meme' },
      { words: ['papayang'], usage: 'papayang', example: 'papayang',
        desc: 'Foto random (Papayang)', params: null, path: '/api/random/papayang', label: 'Papayang' },
      { words: ['acak'], usage: 'acak', example: 'acak',
        desc: 'Konten Reddit acak', params: null, path: '/api/r/lahelu', label: 'Konten Acak' },
    ],
  },
  {
    id: 'bot-waifu', email: 'waifu@bot.whatsap-indo', name: 'Waifu Random',
    tagline: 'Gambar waifu acak',
    about: 'Gambar waifu acak setiap kali diminta. Contoh: waifu.',
    commands: [
      { words: ['waifu'], usage: 'waifu', example: 'waifu',
        desc: 'Gambar waifu acak', params: null, path: '/api/random/waifu', label: 'Waifu' },
    ],
  },
  {
    id: 'bot-anime', email: 'animedl@bot.whatsap-indo', name: 'Cari Anime & Game',
    tagline: 'Cari anime, manga & game',
    about: 'Cari anime (Otakotaku), manga (Mangatoon) & game (MCPEDL). Contoh: anime naruto.',
    commands: [
      { words: ['anime'], usage: 'anime <judul>', example: 'anime naruto',
        desc: 'Cari anime (Otakotaku)', params: { q: 'rest' }, path: '/api/s/otakotaku', label: 'Cari Anime' },
      { words: ['manga'], usage: 'manga <judul>', example: 'manga one piece',
        desc: 'Cari manga (Mangatoon)', params: { q: 'rest' }, path: '/api/s/mangatoon', label: 'Cari Manga' },
      { words: ['game'], usage: 'game <judul>', example: 'game minecraft',
        desc: 'Cari game (MCPEDL)', params: { q: 'rest' }, path: '/api/s/mcpedl', label: 'Cari Game' },
    ],
  },
  {
    id: 'bot-web', email: 'websearch@bot.whatsap-indo', name: 'Pencarian Web',
    tagline: 'DuckDuckGo, Brave & gambar',
    about: 'Cari di DuckDuckGo, Brave & gambar Bing. Contoh: ddg nodejs.',
    commands: [
      { words: ['ddg', 'cari'], usage: 'ddg <kata>', example: 'ddg nodejs',
        desc: 'Cari (DuckDuckGo)', params: { q: 'rest' }, path: '/api/s/duckduckgo', label: 'DuckDuckGo' },
      { words: ['brave'], usage: 'brave <kata>', example: 'brave resep nasi goreng',
        desc: 'Cari (Brave)', params: { q: 'rest' }, path: '/api/s/brave', label: 'Brave Search' },
      { words: ['gambar'], usage: 'gambar <kata>', example: 'gambar kucing',
        desc: 'Cari gambar (Bing)', params: { q: 'rest' }, path: '/api/s/bimg', label: 'Gambar' },
    ],
  },
  {
    id: 'bot-media', email: 'mediasearch@bot.whatsap-indo', name: 'Cari Media',
    tagline: 'YouTube, musik & Pinterest',
    about: 'Cari video YouTube, lagu Apple Music & pin Pinterest. Contoh: yt dangdut.',
    commands: [
      { words: ['yt'], usage: 'yt <kata>', example: 'yt judul lagu',
        desc: 'Cari video YouTube', params: { q: 'rest' }, path: '/api/s/youtube', label: 'Cari YouTube' },
      { words: ['musik', 'lagu'], usage: 'musik <kata>', example: 'musik konser live',
        desc: 'Cari musik (Apple Music)', params: { q: 'rest' }, path: '/api/s/applemusic', label: 'Cari Musik' },
      { words: ['pin'], usage: 'pin <kata>', example: 'pin wallpaper aesthetic',
        desc: 'Cari pin Pinterest', params: { q: 'rest' }, path: '/api/s/pinterest', label: 'Cari Pinterest' },
    ],
  },
  {
    id: 'bot-stiker', email: 'stiker@bot.whatsap-indo', name: 'Stiker',
    tagline: 'Stiker WhatsApp & paket stiker',
    about: 'Cari stiker WhatsApp (Stickerly) & paket stiker (Combot). Contoh: stiker kucing.',
    commands: [
      { words: ['stiker', 'sticker'], usage: 'stiker <kata>', example: 'stiker kucing',
        desc: 'Cari stiker (Stickerly)', params: { q: 'rest' }, path: '/api/sticker/stickerly', label: 'Stiker' },
      { words: ['paket'], usage: 'paket <kata>', example: 'paket lucu',
        desc: 'Cari paket stiker (Combot)', params: { q: 'rest' }, path: '/api/sticker/combot-search', label: 'Paket Stiker' },
    ],
  },
  {
    id: 'bot-ss', email: 'screenshot@bot.whatsap-indo', name: 'Screenshot Web',
    tagline: 'Screenshot situs apa pun',
    about: 'Screenshot situs apa pun langsung dari chat. Contoh: ss https://example.com.',
    commands: [
      { words: ['ss', 'screenshot'], usage: 'ss <url>', example: 'ss https://example.com',
        desc: 'Screenshot sebuah situs', params: { url: 'rest' }, path: '/api/tools/ssweb', label: 'Screenshot' },
    ],
  },
  {
    id: 'bot-qr', email: 'qr@bot.whatsap-indo', name: 'QR Code',
    tagline: 'Buat & baca QR',
    about: 'Buat QR dari teks & baca QR dari gambar. Contoh: buat halo dunia.',
    commands: [
      { words: ['buat', 'qrcode'], usage: 'buat <teks>', example: 'buat halo dunia',
        desc: 'QR dari teks/tautan', params: { text: 'rest' }, path: '/api/tools/qr-create', label: 'QR Dibuat' },
      { words: ['baca', 'scan'], usage: 'baca <url gambar>', example: 'baca https://i.imgur.com/contoh.png',
        desc: 'Baca isi QR dari gambar', params: { url: 'rest' }, path: '/api/tools/qr-detect', label: 'QR Terbaca' },
    ],
  },
  {
    id: 'bot-pos', email: 'kodepos@bot.whatsap-indo', name: 'Kode Pos & Wilayah',
    tagline: 'Kode pos, provinsi & jarak',
    about: 'Cari kode pos, daftar provinsi & jarak antar kota. Contoh: kodepos gambir.',
    commands: [
      { words: ['kodepos'], usage: 'kodepos <area>', example: 'kodepos gambir',
        desc: 'Cari kode pos', params: { q: 'rest' }, path: '/api/tools/kodepos', label: 'Kode Pos' },
      { words: ['provinsi'], usage: 'provinsi', example: 'provinsi',
        desc: 'Daftar provinsi + kode', params: null, path: '/api/info/provinsi', label: 'Provinsi' },
      { words: ['jarak'], usage: 'jarak <dari> <ke>', example: 'jarak Jakarta Bandung',
        desc: 'Jarak dua kota', params: ['dari', 'ke'], path: '/api/info/jarakkota', label: 'Jarak Antar Kota' },
    ],
  },
  {
    id: 'bot-bola', email: 'bola@bot.whatsap-indo', name: 'Jadwal Bola',
    tagline: 'Jadwal pertandingan',
    about: 'Jadwal pertandingan sepak bola (TheSportsDB). Contoh: bola.',
    commands: [
      { words: ['bola', 'jadwalbola'], usage: 'bola [tanggal YYYY-MM-DD]', example: 'bola 2026-10-05',
        desc: 'Jadwal pertandingan hari ini', params: { date: 'rest?' }, path: '/api/info/jadwal-bola', label: 'Jadwal Bola' },
    ],
  },
  {
    id: 'bot-brat', email: 'brat@bot.whatsap-indo', name: 'Generator Gambar',
    tagline: 'Brat, Brat HD & meme custom',
    about: 'Gambar teks Brat, Brat HD & meme custom. Contoh: brat halo guys.',
    commands: [
      { words: ['brat'], usage: 'brat <teks>', example: 'brat halo guys',
        desc: 'Gambar teks Brat', params: { text: 'rest' }, path: '/api/image/brat', label: 'Gambar Brat' },
      { words: ['brathd'], usage: 'brathd <teks>', example: 'brathd halo dunia',
        desc: 'Gambar teks Brat HD', params: { text: 'rest' }, path: '/api/image/brathd', label: 'Gambar Brat HD' },
      { words: ['smeme'], usage: 'smeme <teks>', example: 'smeme halo dunia',
        desc: 'Meme custom (memegen)', params: { text: 'rest' }, path: '/api/image/smeme', label: 'Meme Custom' },
    ],
  },
  {
    id: 'bot-domain', email: 'recon@bot.whatsap-indo', name: 'Security Domain',
    tagline: 'Recon DNS & subdomain',
    about: 'Recon DNS & daftar subdomain sebuah domain. Contoh: recon example.com.',
    commands: [
      { words: ['recon'], usage: 'recon <domain>', example: 'recon example.com',
        desc: 'Recon DNS sebuah domain', params: { domain: 'rest' }, path: '/api/tools/domain-recon', label: 'Domain Recon' },
      { words: ['subdomain'], usage: 'subdomain <domain>', example: 'subdomain example.com',
        desc: 'Daftar subdomain', params: { domain: 'rest' }, path: '/api/tools/subdomains', label: 'Subdomain' },
    ],
  },
  {
    id: 'bot-npm', email: 'npmbot@bot.whatsap-indo', name: 'Cari NPM',
    tagline: 'Info paket npm',
    about: 'Info paket npm: versi, lisensi & deskripsi. Contoh: npm express.',
    commands: [
      { words: ['npm'], usage: 'npm <paket>', example: 'npm express',
        desc: 'Info paket npm', params: { query: 'rest' }, path: '/api/tools/npmjs', label: 'Paket NPM' },
    ],
  },
  {
    id: 'bot-ocr', email: 'ocr@bot.whatsap-indo', name: 'OCR Gambar',
    tagline: 'Ambil teks dari gambar',
    about: 'Baca teks di dalam gambar lewat OCR. Contoh: baca https://i.imgur.com/foto.jpg.',
    commands: [
      { words: ['baca', 'ocr'], usage: 'baca <url gambar>', example: 'baca https://placehold.co/600x200.png?text=Halo',
        desc: 'Baca teks dari gambar', params: { url: 'rest' }, path: '/api/tools/ocr', label: 'OCR' },
    ],
  },
  {
    id: 'bot-suara', email: 'suara@bot.whatsap-indo', name: 'Suara MyInstants',
    tagline: 'Sound efek MyInstants',
    about: 'Cari sound efek populer MyInstants. Contoh: suara tik.',
    commands: [
      { words: ['suara', 'sound'], usage: 'suara <kata>', example: 'suara tik',
        desc: 'Cari sound efek', params: { q: 'rest' }, path: '/api/s/myinstants', label: 'Sound MyInstants' },
      { words: ['trending', 'populer'], usage: 'trending', example: 'trending',
        desc: 'Sound sedang naik daun', params: null, path: '/api/s/myinstants', label: 'Sound Trending' },
    ],
  },
  {
    id: 'bot-font', email: 'font@bot.whatsap-indo', name: 'Font Keren',
    tagline: 'Kumpulan gaya font unik',
    about: 'Cari gaya font untuk nickname, bio & caption. Contoh: font love.',
    commands: [
      { words: ['font', 'gaya'], usage: 'font <gaya>', example: 'font love',
        desc: 'Cari gaya font', params: { q: 'rest' }, path: '/api/s/8font', label: 'Font' },
    ],
  },
  {
    id: 'bot-repo', email: 'repo@bot.whatsap-indo', name: 'Cari Repo',
    tagline: 'Pencarian repository kode',
    about: 'Cari repository kode lewat Gitagram. Contoh: repo express.',
    commands: [
      { words: ['repo', 'repository'], usage: 'repo <kata>', example: 'repo express',
        desc: 'Cari repository', params: { search: 'rest' }, path: '/api/s/gitagram', label: 'Repository' },
    ],
  },
  {
    id: 'bot-cari-lahelu', email: 'carilahelu@bot.whatsap-indo', name: 'Pencarian Lahelu',
    tagline: 'Cari konten di Lahelu',
    about: 'Pencarian konten Lahelu. Contoh: lahelu meme.',
    commands: [
      { words: ['lahelu'], usage: 'lahelu <kata>', example: 'lahelu meme',
        desc: 'Cari di Lahelu', params: { query: 'rest' }, path: '/api/s/lahelu', label: 'Lahelu' },
    ],
  },
  {
    id: 'bot-terjemah', email: 'terjemah@bot.whatsap-indo', name: 'Terjemah',
    tagline: 'Inggris ke Indonesia',
    about: 'Terjemahkan kalimat Inggris ke Indonesia. Contoh: terjemah good morning.',
    commands: [
      { words: ['terjemah', 'translate'], usage: 'terjemah <teks>', example: 'terjemah good morning',
        desc: 'Terjemah en → id', params: { text: 'rest', from: 'en', id: 'id' }, path: '/api/tools/translate', label: 'Terjemahan' },
    ],
  },
  {
    id: 'bot-ip', email: 'ipcheck@bot.whatsap-indo', name: 'Cek IP',
    tagline: 'Info IP & domain',
    about: 'Info lokasi, ISP & ASN sebuah IP/domain. Contoh: ip 8.8.8.8.',
    commands: [
      { words: ['ip', 'geo'], usage: 'ip <ip/domain>', example: 'ip 8.8.8.8',
        desc: 'Info alamat IP', params: { ip: 'rest' }, path: '/api/tools/ip-lookup', label: 'Info IP' },
    ],
  },
  {
    id: 'bot-stalker-x', email: 'stalkx@bot.whatsap-indo', name: 'Stalk Twitter / X',
    tagline: 'Profil Twitter siapa saja',
    about: 'Profil Twitter / X lengkap. Contoh: twitter elonmusk.',
    commands: [
      { words: ['twitter', 'x'], usage: 'twitter <user>', example: 'twitter elonmusk',
        desc: 'Profil Twitter / X', params: { user: 'rest' }, path: '/api/stalk/twitter', label: 'Profil Twitter' },
    ],
  },
  {
    id: 'bot-channel', email: 'channel@bot.whatsap-indo', name: 'Stalk Channel',
    tagline: 'Profil channel YouTube',
    about: 'Statistik channel YouTube: subscriber, video & views. Contoh: channel MrBeast.',
    commands: [
      { words: ['channel'], usage: 'channel <user>', example: 'channel MrBeast',
        desc: 'Profil channel YouTube', params: { user: 'rest' }, path: '/api/stalk/youtube', label: 'Channel YouTube' },
    ],
  },
  {
    id: 'bot-gambar', email: 'imgsearch@bot.whatsap-indo', name: 'Cari Gambar',
    tagline: 'Pencarian gambar Bing',
    about: 'Cari gambar lewat Bing Image. Contoh: gambar kucing.',
    commands: [
      { words: ['gambar'], usage: 'gambar <kata>', example: 'gambar kucing',
        desc: 'Cari gambar', params: { q: 'rest' }, path: '/api/s/bimg', label: 'Gambar' },
    ],
  },
  {
    id: 'bot-pin', email: 'pinsearch@bot.whatsap-indo', name: 'Cari Pinterest',
    tagline: 'Pencarian pin Pinterest',
    about: 'Cari pin Pinterest. Contoh: pin wallpaper aesthetic.',
    commands: [
      { words: ['pin', 'pinterest'], usage: 'pin <kata>', example: 'pin wallpaper aesthetic',
        desc: 'Cari pin Pinterest', params: { q: 'rest' }, path: '/api/s/pinterest', label: 'Pinterest' },
    ],
  },
  {
    id: 'bot-game', email: 'gamesearch@bot.whatsap-indo', name: 'Cari Game',
    tagline: 'Cari game & mod di MCPEDL',
    about: 'Cari game, resource pack & mod. Contoh: game minecraft.',
    commands: [
      { words: ['game'], usage: 'game <judul>', example: 'game minecraft',
        desc: 'Cari game (MCPEDL)', params: { q: 'rest' }, path: '/api/s/mcpedl', label: 'Game' },
    ],
  },
];

const GENERIC_BOTS = GENERIC_SPECS.map(makeBotFromSpec);
for (const bot of GENERIC_BOTS) {
  BOTS.push(bot);
  byId.set(bot.id, bot);
  DEFAULT_NAMES.add(bot.name);
}

module.exports = {
  BOTS,
  isBot,
  seed,
  get,
  peerInChat,
  reply,
};
