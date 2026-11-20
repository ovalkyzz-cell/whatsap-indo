'use strict';

/* Konfigurasi ICE (STUN/TURN) untuk panggilan suara/video.
   Dibaca klien lewat GET /api/calls/ice supaya kunci/rahasia TURN tak pernah
   menyentuh browser.

   Urutan sumber (yang pertama cocok menang):
     1. CALL_TURN=off              -> STUN saja (mematikan TURN sepenuhnya)
     2. TURN_ICE_JSON              -> array iceServers penuh, ditempel dari dashboard
     3. TURN_URL (+ TURN_USER/PASS)-> URL TURN statis, dipisah koma bila lebih dari satu
     4. METERED_API_KEY            -> ambil segar dari REST Metered, di-cache
     5. (tanpa apa pun)            -> STUN saja — persis perilaku lama

   Gagal mengambil kredensial TIDAK PERNAH memblokir panggilan: selalu jatuh
   kembali ke daftar STUN, sama seperti sebelum ada dukungan TURN. */

/* STUN publik yang sudah terbukti menjawab (diuji: Binding Success). */
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.twilio.com:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
];

/* Kredensial dari REST Metered dipakai ulang selama ini (detik). */
const METERED_TTL_MS = Math.max(60_000, Number(process.env.METERED_TTL_SEC) * 1000 || 600_000);
/* Setelah gagal, jangan coba lagi sebelum ini (detik) — hindari menumpuk request. */
const METERED_RETRY_MS = Math.max(5_000, Number(process.env.METERED_RETRY_SEC) * 1000 || 30_000);
const FETCH_TIMEOUT_MS = 8_000;

let cache = { iceServers: null, expiresAt: 0, retryAt: 0, source: null };

function stunServers() {
  return STUN_SERVERS.map((s) => ({ ...s }));
}

function isTurnDisabled() {
  const v = String(process.env.CALL_TURN || '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

/* Array penuh yang disalin pengguna dari dashboard ("Show ICE Servers Array").
   Diparse ketat: hanya obyek {urls, username?, credential?} yang lolos. */
function parseIceJson(raw) {
  if (!raw) return null;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const urls = typeof item.urls === 'string' ? item.urls
      : Array.isArray(item.urls) ? item.urls.filter((u) => typeof u === 'string')
        : null;
    if (!urls || (Array.isArray(urls) && !urls.length)) continue;
    const entry = { urls };
    if (typeof item.username === 'string' && item.username) entry.username = item.username;
    if (typeof item.credential === 'string' && item.credential) entry.credential = item.credential;
    out.push(entry);
  }
  return out.length ? out : null;
}

/* TURN_URL statis: satu URL atau beberapa dipisah koma/spasi —
   tiap URL jadi entri sendiri (persis gaya array dari dashboard). */
function staticTurnServers() {
  const urlRaw = String(process.env.TURN_URL || '').trim();
  if (!urlRaw) return null;
  const urls = urlRaw.split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return null;
  const user = String(process.env.TURN_USER || '').trim();
  const pass = String(process.env.TURN_PASS || '');
  return urls.map((u) => {
    const entry = { urls: u };
    if (user) entry.username = user;
    if (pass) entry.credential = pass;
    return entry;
  });
}

function meteredKey() {
  return String(process.env.METERED_API_KEY || '').trim();
}

/* Endpoint REST Metered. `METERED_APP` = nama app di dashboard (xxx.metered.live).
   `METERED_CRED_URL` boleh dipakai untuk menimpa (mis. perubahan provider). */
function meteredUrl() {
  const custom = String(process.env.METERED_CRED_URL || '').trim();
  const app = String(process.env.METERED_APP || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const base = custom || (app ? `https://${app}.metered.live/api/v1/turn/credentials` : '');
  if (!base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}apiKey=${encodeURIComponent(meteredKey())}`;
}

function validIceServers(list) {
  return Array.isArray(list) && list.length > 0 && list.every((s) => s && typeof s === 'object' && s.urls);
}

async function fetchMetered() {
  const url = meteredUrl();
  if (!url) return null;

  const now = Date.now();
  if (cache.iceServers && now < cache.expiresAt) return cache.iceServers;
  if (now < cache.retryAt) return cache.iceServers; // masih dalam masa tunggu setelah gagal

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const ice = parseIceJson(JSON.stringify(list));
    if (!validIceServers(ice)) throw new Error('respons bukan daftar iceServers');
    cache = { iceServers: ice, expiresAt: Date.now() + METERED_TTL_MS, retryAt: 0, source: 'metered' };
    return cache.iceServers;
  } catch {
    /* Jangan pernah menjatuhkan panggilan karena TURN gagal diambil:
       pakai cache lama bila masih ada, kalau tidak STUN saja. */
    cache = {
      ...cache,
      iceServers: cache.iceServers && Date.now() < cache.expiresAt ? cache.iceServers : null,
      retryAt: Date.now() + METERED_RETRY_MS,
    };
    return cache.iceServers;
  } finally {
    clearTimeout(timer);
  }
}

/* Gabungan STUN + TURN. STUN selalu disertakan agar kandidat tetap bisa
   langsung (host/srflx) sebelum jatuh ke relay. */
function merge(stun, turn) {
  if (!turn || !turn.length) return stun;
  const seen = new Set(stun.map((s) => JSON.stringify(s.urls)));
  const extra = turn.filter((t) => {
    const key = JSON.stringify(t.urls);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...stun, ...extra];
}

/* Titik masuk utama. Mengembalikan { iceServers, turn, source }. */
async function buildIceConfig() {
  if (isTurnDisabled()) {
    return { iceServers: stunServers(), turn: false, source: 'stun-off' };
  }

  const json = parseIceJson(String(process.env.TURN_ICE_JSON || ''));
  if (json) return { iceServers: merge(stunServers(), json), turn: true, source: 'static-json' };

  const staticTurn = staticTurnServers();
  if (staticTurn) return { iceServers: merge(stunServers(), staticTurn), turn: true, source: 'static' };

  if (meteredKey()) {
    const remote = await fetchMetered();
    if (remote) return { iceServers: merge(stunServers(), remote), turn: true, source: 'metered' };
    return { iceServers: stunServers(), turn: false, source: 'stun-fallback' };
  }

  return { iceServers: stunServers(), turn: false, source: 'stun' };
}

/* Hanya untuk pengujian: buang cache & paksa baca env ulang. */
function resetCache() {
  cache = { iceServers: null, expiresAt: 0, retryAt: 0, source: null };
}

function status() {
  return {
    turnEnabled: !isTurnDisabled() && (Boolean(parseIceJson(String(process.env.TURN_ICE_JSON || '')))
      || Boolean(staticTurnServers()) || Boolean(meteredKey())),
    source: cache.source,
    cached: Boolean(cache.iceServers),
  };
}

module.exports = {
  STUN_SERVERS,
  stunServers,
  buildIceConfig,
  isTurnDisabled,
  parseIceJson,
  staticTurnServers,
  meteredUrl,
  status,
  resetCache,
};
