'use strict';

/* Tiga bot internal khusus admin:
   - Verif AM Prem : verifikasi & kirim tautan Alight Motion Premium
   - Generate NFToken : generator NFToken
   - AI : ChatGPT, Gemini, Deepseek, Claude
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
];

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
    return [
      '✅ Tautan verifikasi terkirim',
      '',
      `Email   : ${email}`,
      'Status  : Tautan verifikasi Alight Motion Premium dikirim ke email.',
      ...(detail.length ? ['', ...detail] : []),
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

  const meta = [];
  const expiry = items[0] && items[0].expiry;
  const plan = items[0] && items[0].plan;
  const country = items[0] && items[0].country;
  if (expiry) meta.push(`Berlaku : ${expiry}`);
  if (plan && plan !== 'Tidak diketahui') meta.push(`Plan    : ${plan}`);
  if (country && country !== 'Tidak diketahui') meta.push(`Negara  : ${country}`);

  const failed = Number(outer && outer.failed) || 0;
  return [
    `✅ ${tokens.length} NFToken berhasil dibuat`,
    '',
    ...tokens.map((token, i) => `${i + 1})\n${token}`),
    ...(meta.length ? ['', ...meta] : []),
    '',
    failed ? `Ringkasan : ${tokens.length} sukses · ${failed} gagal` : `Ringkasan : ${tokens.length} token siap dipakai.`,
    '',
    'Salin token, lalu tempel di aplikasi Alight Motion.',
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
  'Contoh:',
  '  gpt ringkas artikel ini dalam 3 kalimat',
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
  const prompt = model === AI_DEFAULT ? text : arg;

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
    sanitize(answer, 6000),
    HR,
    'Balas "menu" untuk memilih model lain.',
  ].join('\n');
}

/* ---------- manajemen akun bot ---------- */

async function seed() {
  const now = Date.now();
  for (const bot of BOTS) {
    try {
      const existing = await db.get('SELECT id FROM users WHERE id = ? OR email = ?', bot.id, bot.email);
      if (existing) {
        if (String(existing.id) === bot.id) {
          await db.run(
            `UPDATE users SET is_bot = 1, verified = 1, account_status = 'active', banned = 0, name = ?, about = ?
             WHERE id = ?`,
            bot.name,
            bot.about,
            bot.id
          );
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
