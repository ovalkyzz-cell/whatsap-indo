'use strict';

/* Enam bot internal khusus admin:
   - Verif AM Prem : verifikasi & kirim tautan Alight Motion Premium
   - Generate NFToken : generator NFToken (respon JSON + tombol Copy)
   - AI : ChatGPT, Gemini, Deepseek, Claude (kode muncul sebagai blok kode)
   - Downloader : unduh video TikTok/IG/YouTube/FB/X & lainnya
   - Email Generator : email sementara, inbox, OTP & baca pesan
   - Tools : terjemah, cuaca, IP, QR, npm
   Semua memanggil API api-mazval (base + key lewat env, tidak disimpan di kode). */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

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
  const arg = rest(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return AI_MENU;

  const model = AI_MODELS.find((m) => m.words.includes(cmd)) || AI_DEFAULT;
  const prompt = ((model === AI_DEFAULT ? text : arg) + CODING_HINT).trim();

  if (!prompt) {
    return [
      '❌ Pertanyaan masih kosong',
      '',
      'Gunakan format:',
      `  ${model.words[0]} <pertanyaan>`,
      '',
      'Balas "menu" untuk melihat semua model.',
    ].join('\n');
  }

  // jawaban AI wajib keluar: coba ulang model pilihan, lalu model cadangan lain
  // sebelum menyerah, semua dalam satu anggaran waktu supaya tidak bikin nunggu lama
  const chain = [model, ...AI_MODELS.filter((m) => m.path !== model.path)];
  const startedAt = Date.now();
  const errors = [];
  let answer = null;
  let used = model;

  for (const candidate of chain) {
    const tries = candidate.path === model.path ? 3 : 1;
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

  const header = used.path === model.path
    ? `🤖 ${model.label}`
    : `🤖 ${model.label} (cadangan: ${used.label})`;

  return [
    header,
    HR,
    sanitize(answer, 7200),
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
  { re: /(youtube\.com|youtu\.be)/i, path: '/api/download/youtube', label: 'YouTube' },
  { re: /tiktok\.com/i, path: '/api/download/tiktok', label: 'TikTok' },
  { re: /(instagram\.com|instagr\.am)/i, path: '/api/download/instagram', label: 'Instagram' },
  { re: /(facebook\.com|fb\.watch)/i, path: '/api/download/facebook', label: 'Facebook' },
  { re: /(twitter\.com|x\.com)/i, path: '/api/download/twitter', label: 'Twitter / X' },
  { re: /pinterest\./i, path: '/api/download/pinterest', label: 'Pinterest' },
  { re: /spotify\.com/i, path: '/api/download/spotify', label: 'Spotify' },
  { re: /soundcloud\.com/i, path: '/api/download/soundcloud', label: 'SoundCloud' },
  { re: /douyin\.com/i, path: '/api/download/douyin', label: 'Douyin' },
  { re: /mediafire\.com/i, path: '/api/download/mediafire', label: 'MediaFire' },
  { re: /terabox|1024tera/i, path: '/api/download/terabox', label: 'Terabox' },
];

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

async function downReply(raw) {
  const text = String(raw || '').trim();
  const cmd = firstWord(text);

  if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) return DOWN_MENU;

  const url = (text.match(/https?:\/\/\S+/i) || [])[0];
  if (!url) {
    return errBlock('Tautan tidak ditemukan', 'Kirim tautan video yang valid, contoh: https://youtu.be/xxxxxxx');
  }

  const platform = DOWN_PLATFORMS.find((p) => p.re.test(url));
  const path = platform ? platform.path : '/api/download/aio';

  let body;
  try {
    body = await callApi(path, { url });
  } catch (e) {
    return errBlock('Video tidak dapat diunduh', e.message);
  }
  if (body && body.success === false) return errBlock('Video tidak dapat diunduh', body.error);

  const data = body && body.data !== undefined ? body.data : body;
  const res = data && typeof data === 'object' && data.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});

  const title = res.title || res.name || res.caption || res.description || '';
  const author = res.author || res.author_name || res.uploader || res.owner || res.username || res.channel || '';
  const source = res.url || res.link || url;
  const note = res.download && res.download.note ? String(res.download.note) : '';
  const links = downloadLinks(res.download || res.media || {}, [], 0)
    .filter((l) => !/^(https?:\/\/)?(www\.)?(cobalt\.tools|api\.qrcode)/i.test(l) || /cobalt\.tools\/api/i.test(l));

  const label = platform ? platform.label : 'Media';

  const out = [
    `✅ Media ditemukan — ${label}`,
    '',
    ...(title ? [`Judul   : ${title}`] : []),
    ...(author ? [`Kreator : ${author}`] : []),
    '',
  ];

  if (links.length) {
    out.push('Tautan unduh:');
    links.slice(0, 6).forEach((l) => {
      const key = Object.keys(DL_ICON).find((k) => l.toLowerCase().includes(`format=${k}`) || l.toLowerCase().includes(`.${k}`));
      out.push(`${DL_ICON[key] || '🔗'} ${l}`);
    });
    out.push('');
  }

  out.push(`Tautan sumber: ${source}`);
  if (note) out.push('', `Catatan : ${note}`);
  out.push(
    '',
    'Klik tautan untuk membuka, atau salin tempel di aplikasi unduh favoritmu.',
    'Balas "menu" bila butuh perintah lain.'
  );
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

module.exports = {
  BOTS,
  isBot,
  seed,
  get,
  peerInChat,
  reply,
};
