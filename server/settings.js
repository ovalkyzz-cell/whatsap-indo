'use strict';

const db = require('./db');
const webpush = require('web-push');

// bot eksklusif: hanya bisa dipakai paket di atas Harian
const EXCLUSIVE_BOTS = ['bot-verif-am', 'bot-nik', 'bot-pos', 'bot-wilayah', 'bot-nftoken'];

// daftar paket premium resmi Whatsap Indo (judul/harga/limit bisa diedit admin)
const DEFAULT_PLANS = [
  { id: 'harian', label: 'Harian', days: 1, price: 1000, dailyLimit: 50, excluded: [...EXCLUSIVE_BOTS], permanent: false },
  { id: 'mingguan', label: 'Mingguan', days: 7, price: 10000, dailyLimit: 200, excluded: [], permanent: false },
  { id: 'bulanan', label: 'Bulanan', days: 30, price: 25000, dailyLimit: 0, excluded: [], permanent: false },
  { id: 'permanen', label: 'Permanen', days: 3650, price: 50000, dailyLimit: 0, excluded: [], permanent: true },
];

const cache = new Map();

async function get(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
  let value = fallback;
  if (row) {
    try {
      value = JSON.parse(row.value);
    } catch {
      value = row.value;
    }
  }
  cache.set(key, value);
  return value;
}

async function set(key, value) {
  const json = JSON.stringify(value);
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    json
  );
  cache.set(key, value);
  return value;
}

function normalizeExcluded(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((v) => String(v || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
}

function normalizePlans(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const item of input.slice(0, 12)) {
    const label = String(item?.label || '').trim().slice(0, 30);
    const days = Math.round(Number(item?.days));
    if (!label || !Number.isFinite(days) || days < 1 || days > 3650) return null;
    const id = String(item?.id || '').trim().slice(0, 30) || `paket-${out.length + 1}`;
    const price = item?.price === undefined || item?.price === null || item?.price === ''
      ? 0
      : Math.round(Number(item.price));
    const dailyLimit = item?.dailyLimit === undefined || item?.dailyLimit === null || item?.dailyLimit === ''
      ? 0
      : Math.round(Number(item.dailyLimit));
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) return null;
    if (!Number.isFinite(dailyLimit) || dailyLimit < 0 || dailyLimit > 1_000_000) return null;
    out.push({
      id,
      label,
      days,
      price,
      dailyLimit,
      excluded: normalizeExcluded(item?.excluded),
      permanent: !!item?.permanent,
    });
  }
  return out.length >= 3 ? out : null;
}

// data paket lama (sebelum ada harga/limit) dianggap usang -> pakai paket resmi
function isLegacyPlans(raw) {
  return Array.isArray(raw) && raw.length > 0 && !raw.some((p) => p && p.price !== undefined);
}

async function getPlans() {
  const raw = await get('plans', null);
  const saved = normalizePlans(raw);
  if (!saved || isLegacyPlans(raw)) return DEFAULT_PLANS.map((p) => ({ ...p, excluded: [...p.excluded] }));
  // paket custom admin tetap dipakai; paket resmi yang hilang ditambahkan di belakang
  const out = saved.map((p) => ({ ...p }));
  for (const def of DEFAULT_PLANS) {
    if (!out.some((p) => p.id === def.id)) out.push({ ...def, excluded: [...def.excluded] });
  }
  return out.slice(0, 12);
}

async function setPlans(input) {
  const plans = normalizePlans(input);
  if (!plans) return null;
  return set('plans', plans);
}

// paket milik satu pengguna (null kalau bukan premium / paketnya tak dikenal)
async function planOf(user) {
  if (!user || !user.premium_plan) return null;
  const plans = await getPlans();
  return plans.find((p) => p.id === user.premium_plan) || null;
}

const BG_TYPES = ['default', 'image', 'video'];

function validBgUrl(url) {
  return /^\/uploads\/[\w.\-]+$/.test(String(url || ''))
    || /^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\/[\w.%\-/~]+$/.test(String(url || ''));
}

async function getHomeBg() {
  const saved = await get('home_bg', null);
  if (saved && BG_TYPES.includes(saved.type) && (saved.type === 'default' || validBgUrl(saved.url))) {
    return saved;
  }
  return { type: 'default', url: null };
}

async function setHomeBg(input) {
  const type = BG_TYPES.includes(input?.type) ? input.type : null;
  if (!type) return null;
  const url = type === 'default' ? null : String(input.url || '');
  if (type !== 'default' && !validBgUrl(url)) return null;
  return set('home_bg', { type, url });
}

// kunci VAPID untuk Web Push: dibuat sekali lalu disimpan di settings
// (publik dibagikan ke klien, privat hanya dipakai server)
async function getVapid() {
  const saved = await get('vapid', null);
  if (saved && saved.publicKey && saved.privateKey) return saved;
  const keys = webpush.generateVAPIDKeys();
  const value = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:ovalkyzz@gmail.com',
  };
  await set('vapid', value);
  return value;
}

module.exports = {
  DEFAULT_PLANS,
  EXCLUSIVE_BOTS,
  get,
  set,
  getPlans,
  setPlans,
  planOf,
  getHomeBg,
  setHomeBg,
  validBgUrl,
  getVapid,
};
