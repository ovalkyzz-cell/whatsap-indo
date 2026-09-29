'use strict';

const db = require('./db');
const webpush = require('web-push');

const DEFAULT_PLANS = [
  { id: 'lima-hari', label: '5 Hari', days: 5 },
  { id: 'mingguan', label: 'Mingguan', days: 7 },
  { id: 'bulanan', label: 'Bulanan', days: 30 },
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

function normalizePlans(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const item of input.slice(0, 6)) {
    const label = String(item?.label || '').trim().slice(0, 30);
    const days = Math.round(Number(item?.days));
    if (!label || !Number.isFinite(days) || days < 1 || days > 3650) return null;
    const id = String(item?.id || '').trim().slice(0, 30) || `paket-${out.length + 1}`;
    out.push({ id, label, days });
  }
  return out.length >= 3 ? out : null;
}

async function getPlans() {
  const saved = normalizePlans(await get('plans', null));
  return saved || DEFAULT_PLANS.map((p) => ({ ...p }));
}

async function setPlans(input) {
  const plans = normalizePlans(input);
  if (!plans) return null;
  return set('plans', plans);
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
  get,
  set,
  getPlans,
  setPlans,
  getHomeBg,
  setHomeBg,
  validBgUrl,
  getVapid,
};
