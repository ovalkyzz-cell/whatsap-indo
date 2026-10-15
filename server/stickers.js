'use strict';

/* Sistem stiker & emot khusus WA Indo.
   Semua stiker adalah SVG vektor buatan sendiri (bukan hasil API eksternal) —
   tajam di segala ukuran, berat file kecil, dan khas WA Indo (tema Nusantara,
   kilau premium, efek legendaris). Tiap paket terkunci pada ladder paket plan:
   makin tinggi paketnya, makin banyak & makin langka koleksinya. */

const path = require('path');

/* peringkat paket: dipakai untuk membandingkan "pakET ini setidaknya X?" */
const PLAN_RANK = {
  free: 0,
  harian: 1,
  mingguan: 2,
  bulanan: 3,
  bisnis: 4,
  'reseller-bulanan': 5,
  permanen: 6,
};

// paket minimum yang dibutuhkan tiap koleksi stiker (null = gratis untuk semua)
const PACK_MIN_PLAN = {
  dasar: null,
  nusantara: 'harian',
  mood: 'mingguan',
  premium: 'bulanan',
  bisnis: 'bisnis',
  legendaris: 'permanen', // reseller-bulanan juga (rank >= permanen tidak; dicek khusus)
};

// legendaris terbuka untuk dua paket teratas
const PACK_ALSO_OPEN = { legendaris: ['permanen', 'reseller-bulanan'] };

function rankOf(planId) {
  if (!planId) return 0;
  return PLAN_RANK[planId] != null ? PLAN_RANK[planId] : 0;
}

function packOpenFor(packId, planId) {
  const min = PACK_MIN_PLAN[packId];
  if (min == null) return true;
  if (PACK_ALSO_OPEN[packId] && PACK_ALSO_OPEN[packId].includes(planId)) return true;
  return rankOf(planId) >= rankOf(min);
}

/* akses stiker untuk sebuah baris user (butuh kolom premium_plan & role) */
function accessOf(user) {
  const isAdmin = user && (user.role === 'admin');
  const planId = isAdmin ? 'permanen' : (user && user.premium_plan) || null;
  const packs = Object.keys(PACK_MIN_PLAN).filter((id) => packOpenFor(id, planId));
  return {
    planId: isAdmin ? 'permanen' : planId,
    isAdmin: !!isAdmin,
    unlocked: packs,
    locked: Object.keys(PACK_MIN_PLAN).filter((id) => !packs.includes(id)),
  };
}

/* ============================================================
   Primitif SVG — dipakai ulang oleh seluruh stiker supaya konsisten
   ============================================================ */

// filter bercahaya (glow) lembut
function glow(id, color, strength = 1) {
  return `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="${10 * strength}" result="b"/>
    <feFlood flood-color="${color}" flood-opacity="${0.9 * strength}" result="c"/>
    <feComposite in="c" in2="b" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

// gradien linear dua henti
function lg(id, c1, c2, x1 = '0%', y1 = '0%', x2 = '0%', y2 = '100%') {
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </linearGradient>`;
}

// gradien radial (untuk bola/mata/wajah)
function rg(id, c1, c2, cx = '50%', cy = '38%', r = '70%') {
  return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </radialGradient>`;
}

// bayangan lembut di bawah objek
function shadow(id, op = 0.28) {
  return `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="${op}"/>
  </filter>`;
}

// kilau (highlight) di kiri-atas bola
function gloss() {
  return `<ellipse cx="200" cy="170" rx="120" ry="80" fill="#fff" opacity="0.28"/>`;
}

function defs(inner) { return `<defs>${inner}</defs>`; }

/* ============================================================
   Wajah parametrik — dipakai banyak stiker ekspresi
   ============================================================ */

// mata: 'open' | 'happy' | 'wink' | 'heart' | 'cool' | 'closed' | 'x' | 'star' | 'sad'
function eyes(kind, ex = 256) {
  const L = ex - 70, R = ex + 70;
  switch (kind) {
    case 'happy':
      return `<path d="M${L - 34} 250 q34 -40 68 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>
              <path d="M${R - 34} 250 q34 -40 68 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'wink':
      return `<ellipse cx="${L}" cy="250" rx="20" ry="24" fill="#20232b"/>
              <path d="M${R - 34} 250 q34 -34 68 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'heart':
      return `<path d="M${L} 264 c-30 -30 -56 -50 -56 -78 a26 26 0 0 1 56 -10 a26 26 0 0 1 56 10 c0 28 -26 48 -56 78z" fill="#ff3b6b"/>
              <path d="M${R} 264 c-30 -30 -56 -50 -56 -78 a26 26 0 0 1 56 -10 a26 26 0 0 1 56 10 c0 28 -26 48 -56 78z" fill="#ff3b6b"/>`;
    case 'cool':
      return `<path d="M${L - 46} 232 h92 a10 10 0 0 1 10 10 v18 a26 26 0 0 1 -26 26 h-30 a26 26 0 0 1 -26 -26 v-18 a10 10 0 0 1 10 -10z
                       M${R - 46} 232 h92 a10 10 0 0 1 10 10 v18 a26 26 0 0 1 -26 26 h-30 a26 26 0 0 1 -26 -26 v-18 a10 10 0 0 1 10 -10z" fill="#20232b"/>
              <rect x="${L - 24}" y="238" width="48" height="14" rx="7" fill="#3a3f4b"/>
              <rect x="${R - 24}" y="238" width="48" height="14" rx="7" fill="#3a3f4b"/>
              <rect x="${L + 52}" y="244" width="38" height="10" rx="5" fill="#20232b"/>
              <rect x="${R - 90}" y="244" width="38" height="10" rx="5" fill="#20232b"/>`;
    case 'closed':
      return `<path d="M${L - 34} 252 q34 24 68 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>
              <path d="M${R - 34} 252 q34 24 68 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'x':
      return `<path d="M${L - 22} 232 l44 44 M${L + 22} 232 l-44 44" stroke="#20232b" stroke-width="15" stroke-linecap="round"/>
              <path d="M${R - 22} 232 l44 44 M${R + 22} 232 l-44 44" stroke="#20232b" stroke-width="15" stroke-linecap="round"/>`;
    case 'star':
      return `<path d="M${L} 224 l12 26 28 3 -21 19 6 28 -25 -15 -25 15 6 -28 -21 -19 28 -3z" fill="#ffd12e"/>
              <path d="M${R} 224 l12 26 28 3 -21 19 6 28 -25 -15 -25 15 6 -28 -21 -19 28 -3z" fill="#ffd12e"/>`;
    case 'sad':
      return `<ellipse cx="${L}" cy="252" rx="20" ry="24" fill="#20232b"/>
              <ellipse cx="${R}" cy="252" rx="20" ry="24" fill="#20232b"/>
              <path d="M${L - 40} 214 q40 -22 80 -6" stroke="#20232b" stroke-width="12" fill="none" stroke-linecap="round"/>
              <path d="M${R - 40} 208 q40 -16 80 6" stroke="#20232b" stroke-width="12" fill="none" stroke-linecap="round"/>`;
    case 'wide':
    default:
      return `<ellipse cx="${L}" cy="250" rx="26" ry="30" fill="#fff"/>
              <ellipse cx="${R}" cy="250" rx="26" ry="30" fill="#fff"/>
              <circle cx="${L}" cy="252" r="15" fill="#20232b"/>
              <circle cx="${R}" cy="252" r="15" fill="#20232b"/>
              <circle cx="${L + 5}" cy="246" r="5" fill="#fff"/>
              <circle cx="${R + 5}" cy="246" r="5" fill="#fff"/>`;
  }
}

// mulut: 'smile' | 'grin' | 'frown' | 'open' | 'tongue' | 'flat' | 'wow' | 'smirk'
function mouth(kind, cy = 350) {
  switch (kind) {
    case 'grin':
      return `<path d="M176 ${cy - 6} q80 84 160 0 z" fill="#20232b"/>
              <path d="M196 ${cy + 2} q60 30 120 0 q-60 60 -120 0z" fill="#ff5b7a"/>`;
    case 'frown':
      return `<path d="M196 ${cy + 14} q60 -52 120 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'open':
      return `<ellipse cx="256" cy="${cy + 6}" rx="58" ry="66" fill="#20232b"/>
              <ellipse cx="256" cy="${cy + 34}" rx="34" ry="30" fill="#ff5b7a"/>`;
    case 'tongue':
      return `<path d="M186 ${cy - 8} q70 66 140 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>
              <path d="M232 ${cy + 8} q24 60 48 0 q-24 40 -48 0z" fill="#ff5b7a"/>`;
    case 'flat':
      return `<path d="M190 ${cy} h132" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'wow':
      return `<ellipse cx="256" cy="${cy + 4}" rx="44" ry="50" fill="#20232b"/>`;
    case 'smirk':
      return `<path d="M210 ${cy - 4} q54 40 104 -12" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    case 'smile':
    default:
      return `<path d="M192 ${cy - 10} q64 58 128 0" stroke="#20232b" stroke-width="16" fill="none" stroke-linecap="round"/>`;
  }
}

function blush() {
  return `<ellipse cx="176" cy="312" rx="26" ry="16" fill="#ff6b8a" opacity="0.55"/>
          <ellipse cx="336" cy="312" rx="26" ry="16" fill="#ff6b8a" opacity="0.55"/>`;
}

// wajah lengkap (bola + mata + mulut + kilau)
function face(o) {
  const gid = o.gid || 'f';
  const c1 = o.c1 || '#ffd24a', c2 = o.c2 || '#ff9d2e';
  return `
    ${defs(rg(`${gid}r`, c1, c2) + shadow(`${gid}s`))}
    <circle cx="256" cy="262" r="196" fill="url(#${gid}r)" filter="url(#${gid}s)"/>
    ${gloss()}
    ${eyes(o.eyes || 'wide')}
    ${blush()}
    ${mouth(o.mouth || 'smile')}`;
}

// bingkai + latar opsional lalu bungkus konten
function wrap(inner, o = {}) {
  const bg = o.bg
    ? `<circle cx="256" cy="256" r="256" fill="${o.bg}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${bg}${inner}</svg>`;
}

/* ============================================================
   Katalog stiker — tiap entry: { id, label, svg }
   svg dihasilkan on-demand lewat render(id) supaya file tetap ringan
   ============================================================ */

// stiker berbasis wajah parametrik
const FACE_STICKERS = {
  // --- dasar ---
  senyum:   { pack: 'dasar', label: 'Senyum',       face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'happy',  mouth: 'smile' } },
  tertawa:  { pack: 'dasar', label: 'Tertawa',      face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'closed', mouth: 'grin' } },
  sedih:    { pack: 'dasar', label: 'Sedih',        face: { c1: '#bfe3ff', c2: '#5aa9ff', eyes: 'sad',    mouth: 'frown' } },
  marah:    { pack: 'dasar', label: 'Marah',        face: { c1: '#ff9a8b', c2: '#ff3b3b', eyes: 'x',      mouth: 'frown' } },
  kaget:    { pack: 'dasar', label: 'Kaget',        face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'wide',   mouth: 'wow' } },
  cinta:    { pack: 'dasar', label: 'Jatuh Cinta',  face: { c1: '#ffc0d9', c2: '#ff5b8d', eyes: 'heart',  mouth: 'smile' } },
  keren:    { pack: 'dasar', label: 'Keren',        face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'cool',   mouth: 'smirk' } },
  tidur:    { pack: 'dasar', label: 'Tidur',        face: { c1: '#dfe6ff', c2: '#9aa8ff', eyes: 'closed', mouth: 'flat' } },
  jempol:   { pack: 'dasar', label: 'Jempol',       face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'happy',  mouth: 'grin' } },
  malu:     { pack: 'dasar', label: 'Malu',         face: { c1: '#ffd0c2', c2: '#ff8a6b', eyes: 'closed', mouth: 'smile', blush: true } },
  bingung:  { pack: 'dasar', label: 'Bingung',      face: { c1: '#d7f5e3', c2: '#43c59e', eyes: 'wide',   mouth: 'flat' } },
  wow:      { pack: 'dasar', label: 'Wow',          face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'star',   mouth: 'open' } },

  // --- nusantara ---
  senyuman:  { pack: 'nusantara', label: 'Senyuman Nusantara', face: { c1: '#ffd98a', c2: '#e8890c', eyes: 'happy',  mouth: 'smile' } },
  semangat:  { pack: 'nusantara', label: 'Semangat!',          face: { c1: '#ffb36b', c2: '#ff5a1f', eyes: 'star',   mouth: 'grin' } },
  santai:    { pack: 'nusantara', label: 'Santai Wis',         face: { c1: '#c8f0d8', c2: '#2fae6a', eyes: 'closed', mouth: 'smirk' } },
  bangga:    { pack: 'nusantara', label: 'Bangga',             face: { c1: '#ffe08a', c2: '#f39200', eyes: 'star',   mouth: 'grin' } },
  makasih:   { pack: 'nusantara', label: 'Makasih ya',         face: { c1: '#ffd0e0', c2: '#ff5b8d', eyes: 'happy',  mouth: 'smile', blush: true } },
  maafkan:   { pack: 'nusantara', label: 'Maafkan',            face: { c1: '#d6ecff', c2: '#4aa3ff', eyes: 'sad',    mouth: 'frown' } },
  setuju:    { pack: 'nusantara', label: 'Setuju!',            face: { c1: '#d7f5e3', c2: '#22a06b', eyes: 'happy',  mouth: 'grin' } },
  lucu:      { pack: 'nusantara', label: 'Lucu Banget',        face: { c1: '#ffe27a', c2: '#ffb02e', eyes: 'happy',  mouth: 'tongue' } },
  tenang:    { pack: 'nusantara', label: 'Tenang Saja',        face: { c1: '#e6f0ff', c2: '#6d8bff', eyes: 'closed', mouth: 'smile' } },
  hebat:     { pack: 'nusantara', label: 'Hebat!',             face: { c1: '#fff0b3', c2: '#ffa62b', eyes: 'star',   mouth: 'grin' } },

  // --- mood ---
  mood_cinta:   { pack: 'mood', label: 'Mood Cinta',    face: { c1: '#ffc9dd', c2: '#ff3f77', eyes: 'heart',  mouth: 'smile' } },
  mood_semangat:{ pack: 'mood', label: 'Mood Semangat', face: { c1: '#ffb86b', c2: '#ff4d00', eyes: 'star',   mouth: 'grin' } },
  mood_dongkol: { pack: 'mood', label: 'Mood Dongkol',  face: { c1: '#ff9a8b', c2: '#e02424', eyes: 'x',      mouth: 'flat' } },
  mood_ngantuk: { pack: 'mood', label: 'Mood Ngantuk',  face: { c1: '#e3e9ff', c2: '#7c8cff', eyes: 'closed', mouth: 'flat' } },
  mood_keren:   { pack: 'mood', label: 'Mood Keren',    face: { c1: '#d9d9d9', c2: '#4b4b4b', eyes: 'cool',   mouth: 'smirk' } },
  mood_nangis:  { pack: 'mood', label: 'Mood Nangis',   face: { c1: '#cfe6ff', c2: '#3f8dff', eyes: 'sad',    mouth: 'frown' } },
  mood_ketawa:  { pack: 'mood', label: 'Mood Ketawa',   face: { c1: '#ffe27a', c2: '#ff9d00', eyes: 'closed', mouth: 'grin' } },
  mood_bingung: { pack: 'mood', label: 'Mood Bingung',  face: { c1: '#d7f5e3', c2: '#1f9e6b', eyes: 'wide',   mouth: 'flat' } },
  mood_santai:  { pack: 'mood', label: 'Mood Santai',   face: { c1: '#e8ffe8', c2: '#4bbf6b', eyes: 'happy',  mouth: 'smirk' } },
  mood_wow:     { pack: 'mood', label: 'Mood Wow',      face: { c1: '#ffe9a8', c2: '#ff7b00', eyes: 'star',   mouth: 'wow' } },

  // --- premium ---
  prem_emas:   { pack: 'premium', label: 'Emas',        face: { c1: '#fff2b0', c2: '#d4a017', eyes: 'star',   mouth: 'smile' } },
  prem_bintang: { pack: 'premium', label: 'Bintang',    face: { c1: '#fff6cf', c2: '#e0a800', eyes: 'star',   mouth: 'grin' } },
  prem_kilau:  { pack: 'premium', label: 'Kilau',       face: { c1: '#ffffff', c2: '#c9b8ff', eyes: 'star',   mouth: 'smile' } },
  prem_vip:    { pack: 'premium', label: 'VIP',         face: { c1: '#ffe9a8', c2: '#b8860b', eyes: 'cool',   mouth: 'smirk' } },
  prem_gagah:  { pack: 'premium', label: 'Gagah',       face: { c1: '#e0d0ff', c2: '#6b3fa0', eyes: 'cool',   mouth: 'smile' } },
  prem_senyum: { pack: 'premium', label: 'Senyum Emas', face: { c1: '#fff0b3', c2: '#e09600', eyes: 'happy',  mouth: 'smile' } },
  prem_ketawa: { pack: 'premium', label: 'Ketawa Emas', face: { c1: '#fff2b0', c2: '#d99400', eyes: 'closed', mouth: 'grin' } },
  prem_cinta:  { pack: 'premium', label: 'Cinta Emas',  face: { c1: '#ffd6e6', c2: '#e0518a', eyes: 'heart',  mouth: 'smile' } },

  // --- bisnis ---
  bis_lo:      { pack: 'bisnis', label: 'Salam Kenal', face: { c1: '#d6ecff', c2: '#2b7fd4', eyes: 'happy',  mouth: 'smile' } },
  bis_ok:      { pack: 'bisnis', label: 'Siap!',       face: { c1: '#d7f5e3', c2: '#1f8f5f', eyes: 'happy',  mouth: 'grin' } },
  bis_fokus:   { pack: 'bisnis', label: 'Fokus',       face: { c1: '#e0e0e0', c2: '#333',    eyes: 'cool',   mouth: 'flat' } },
  bis_mikir:   { pack: 'bisnis', label: 'Berpikir',    face: { c1: '#e6f0ff', c2: '#4a6bff', eyes: 'wide',   mouth: 'flat' } },
  bis_sukses:  { pack: 'bisnis', label: 'Sukses!',     face: { c1: '#fff0b3', c2: '#e09600', eyes: 'star',   mouth: 'grin' } },
  bis_keren:   { pack: 'bisnis', label: 'Keren!',      face: { c1: '#d9d9d9', c2: '#2b2b2b', eyes: 'cool',   mouth: 'smirk' } },
  bis_hore:    { pack: 'bisnis', label: 'Hore!',       face: { c1: '#ffd6e6', c2: '#ff3f77', eyes: 'star',   mouth: 'grin' } },
  bis_tenang:  { pack: 'bisnis', label: 'Tenang',      face: { c1: '#e8f6ff', c2: '#3aa0d4', eyes: 'closed', mouth: 'smile' } },

  // --- legendaris ---
  leg_naga:    { pack: 'legendaris', label: 'Naga Api',     face: { c1: '#ffb36b', c2: '#c41e00', eyes: 'x',      mouth: 'grin' } },
  leg_petir:   { pack: 'legendaris', label: 'Petir',        face: { c1: '#fff6a8', c2: '#e0b400', eyes: 'star',   mouth: 'wow' } },
  leg_mahkota: { pack: 'legendaris', label: 'Mahkota',      face: { c1: '#fff2b0', c2: '#b8860b', eyes: 'star',   mouth: 'smile' } },
  leg_ember:   { pack: 'legendaris', label: 'Api Abadi',    face: { c1: '#ffc98a', c2: '#a01800', eyes: 'x',      mouth: 'open' } },
  leg_bintang: { pack: 'legendaris', label: 'Bintang Emas', face: { c1: '#fff6cf', c2: '#d4a017', eyes: 'star',   mouth: 'grin' } },
  leg_ghadir:  { pack: 'legendaris', label: 'Legendaris',   face: { c1: '#e0c8ff', c2: '#5b21b6', eyes: 'star',   mouth: 'smile' } },
};

// stiker objek/gaya khusus (SVG tangan) — menambah keragaman pilihan
function objSvg(inner, o) { return wrap(inner, o); }

const OBJ_STICKERS = {
  cinta_hatinya: { pack: 'dasar', label: 'Hati', svg: objSvg(`
    ${defs(lg('hg', '#ff5b8d', '#ff1f5a') + shadow('hs'))}
    <path d="M256 430 C120 330 60 250 60 176 A96 96 0 0 1 256 128 A96 96 0 0 1 452 176 C452 250 392 330 256 430z" fill="url(#hg)" filter="url(#hs)"/>
    <ellipse cx="180" cy="180" rx="46" ry="30" fill="#fff" opacity="0.4"/>`) },

  jempol_ok: { pack: 'dasar', label: 'Jempol', svg: objSvg(`
    ${defs(lg('jg', '#ffd24a', '#ff9d2e') + shadow('js'))}
    <path d="M180 250 h60 v180 h-60z M250 250 l40 -130 a30 30 0 0 1 56 18 l-20 90 h96 a34 34 0 0 1 33 44 l-34 120 a40 40 0 0 1 -39 30 H250z" fill="url(#jg)" filter="url(#js)" stroke="#e07b00" stroke-width="6"/>`) },

  bintang_lima: { pack: 'nusantara', label: 'Bintang', svg: objSvg(`
    ${defs(lg('bg', '#fff2b0', '#ff9d00') + shadow('bs') + glow('bgl', '#ffd24a'))}
    <path d="M256 60 l48 108 118 10 -90 78 28 116 -104 -62 -104 62 28 -116 -90 -78 118 -10z" fill="url(#bg)" filter="url(#bs)"/>`) },

  api_semarang: { pack: 'nusantara', label: 'Api Semangat', svg: objSvg(`
    ${defs(lg('fg', '#fff6a8', '#ff3b00') + shadow('fs') + glow('fglow', '#ff7b00'))}
    <path d="M256 60 C300 150 360 180 360 280 A104 104 0 0 1 152 280 C152 180 212 150 256 60z" fill="url(#fg)" filter="url(#fs)"/>
    <path d="M256 200 C280 250 300 260 300 300 A44 44 0 0 1 212 300 C212 260 232 250 256 200z" fill="#fff6a8"/>`) },

  kopi: { pack: 'nusantara', label: 'Kopi', svg: objSvg(`
    ${defs(lg('kg', '#c8956b', '#6b3f1f') + shadow('ks'))}
    <path d="M140 200 h180 v120 a90 90 0 0 1 -180 0z" fill="url(#kg)" filter="url(#ks)"/>
    <path d="M320 220 h40 a50 50 0 0 1 0 100 h-40" fill="none" stroke="#6b3f1f" stroke-width="22"/>
    <path d="M200 150 q10 -40 0 -70 M240 150 q10 -40 0 -70 M280 150 q10 -40 0 -70" stroke="#fff" stroke-width="12" fill="none" opacity="0.7" stroke-linecap="round"/>
    <ellipse cx="230" cy="200" rx="60" ry="16" fill="#fff" opacity="0.3"/>`) },

  mahkota_emas: { pack: 'premium', label: 'Mahkota', svg: objSvg(`
    ${defs(lg('mg', '#fff2b0', '#d4a017') + shadow('ms') + glow('mgl', '#ffd24a'))}
    <path d="M90 360 L120 160 L200 260 L256 120 L312 260 L392 160 L422 360z" fill="url(#mg)" filter="url(#ms)"/>
    <rect x="90" y="360" width="332" height="46" rx="16" fill="#d4a017"/>
    <circle cx="120" cy="160" r="22" fill="#ff3f77"/><circle cx="256" cy="120" r="26" fill="#3aa0d4"/><circle cx="392" cy="160" r="22" fill="#22a06b"/>`) },

  berlian: { pack: 'premium', label: 'Berlian', svg: objSvg(`
    ${defs(lg('dg', '#eafaff', '#3aa0d4') + shadow('ds') + glow('dgl', '#8fd8ff'))}
    <path d="M160 140 h192 l64 96 -160 200 -160 -200z" fill="url(#dg)" filter="url(#ds)"/>
    <path d="M160 140 l-64 96 256 200 256 -200 -64 -96z" fill="#bfeaff" opacity="0.5"/>
    <path d="M96 236 h320 M256 140 v296" stroke="#fff" stroke-width="6" opacity="0.7"/>`) },

  roket: { pack: 'bisnis', label: 'Roket', svg: objSvg(`
    ${defs(lg('rg2', '#ff6b6b', '#c41e3a') + shadow('rs'))}
    <path d="M256 60 c60 60 80 160 80 240 h-160 c0 -80 20 -180 80 -240z" fill="url(#rg2)" filter="url(#rs)"/>
    <circle cx="256" cy="220" r="34" fill="#bfeaff" stroke="#fff" stroke-width="8"/>
    <path d="M176 260 l-50 90 70 -30z M336 260 l50 90 -70 -30z" fill="#c41e3a"/>
    <path d="M226 320 q30 80 30 120 q0 -40 30 -120z" fill="#ffd24a"/>`) },

  piala: { pack: 'bisnis', label: 'Piala', svg: objSvg(`
    ${defs(lg('tg', '#fff2b0', '#d4a017') + shadow('ts') + glow('tgl', '#ffd24a'))}
    <path d="M170 100 h172 v120 a86 86 0 0 1 -172 0z" fill="url(#tg)" filter="url(#ts)"/>
    <path d="M170 120 h-50 a40 40 0 0 0 40 80 M342 120 h50 a40 40 0 0 1 -40 80" fill="none" stroke="#d4a017" stroke-width="18"/>
    <rect x="236" y="300" width="40" height="60" fill="#d4a017"/>
    <rect x="186" y="360" width="140" height="40" rx="12" fill="#b8860b"/>
    <path d="M256 150 l14 30 32 4 -24 22 6 32 -28 -16 -28 16 6 -32 -24 -22 32 -4z" fill="#fff6cf"/>`) },

  naga_api: { pack: 'legendaris', label: 'Naga', svg: objSvg(`
    ${defs(lg('ng', '#ffb36b', '#a01800') + shadow('ns') + glow('ngl', '#ff4d00'))}
    <path d="M120 360 q40 -180 160 -200 q120 20 120 120 q0 90 -110 110 q-120 20 -170 -30z" fill="url(#ng)" filter="url(#ns)"/>
    <path d="M300 150 l40 -50 10 60 M340 190 l50 -30 -20 55" fill="#ff7b00"/>
    <circle cx="220" cy="230" r="20" fill="#fff6a8"/><circle cx="226" cy="230" r="10" fill="#20232b"/>
    <path d="M150 320 q60 30 120 0" stroke="#a01800" stroke-width="12" fill="none" stroke-linecap="round"/>`) },

  mahkota_legenda: { pack: 'legendaris', label: 'Mahkota Legenda', svg: objSvg(`
    ${defs(lg('lg2', '#ffe9a8', '#8a5a00') + shadow('ls') + glow('lgl', '#ffd24a', 1.2))}
    <path d="M90 350 L130 140 L210 250 L256 100 L302 250 L382 140 L422 350z" fill="url(#lg2)" filter="url(#ls)"/>
    <rect x="90" y="350" width="332" height="50" rx="18" fill="#8a5a00"/>
    <circle cx="130" cy="140" r="26" fill="#ff1f5a"/><circle cx="256" cy="100" r="32" fill="#3aa0d4"/><circle cx="382" cy="140" r="26" fill="#22a06b"/>
    <path d="M256 100 l10 22 24 3 -18 16 5 24 -21 -12 -21 12 5 -24 -18 -16 24 -3z" fill="#fff6cf"/>`) },
};

// gabungkan semua entry jadi katalog final
const CATALOG = {};
for (const [id, def] of Object.entries(FACE_STICKERS)) {
  CATALOG[id] = { id, pack: def.pack, label: def.label, _face: def.face };
}
for (const [id, def] of Object.entries(OBJ_STICKERS)) {
  CATALOG[id] = { id, pack: def.pack, label: def.label, _svg: def.svg };
}

// render SVG on-demand (memoized) supaya file stiker tetap ringan
const _cache = new Map();
function render(id) {
  if (_cache.has(id)) return _cache.get(id);
  const item = CATALOG[id];
  if (!item) return null;
  let svg;
  if (item._svg) {
    svg = item._svg;
  } else if (item._face) {
    svg = wrap(face({ ...item._face, gid: id }));
  } else {
    return null;
  }
  _cache.set(id, svg);
  return svg;
}

/* daftar stiker yang bisa dipakai user (sudah difilter paketnya) */
function catalogFor(user) {
  const acc = accessOf(user);
  const packs = {};
  for (const id of acc.unlocked) packs[id] = [];
  for (const item of Object.values(CATALOG)) {
    if (packs[item.pack]) packs[item.pack].push({ id: item.id, label: item.label });
  }
  return {
    packs: Object.entries(packs).map(([id, stickers]) => ({
      id,
      label: PACK_LABEL[id] || id,
      minPlan: PACK_MIN_PLAN[id],
      stickers,
    })).filter((p) => p.stickers.length),
    total: Object.values(CATALOG).length,
    access: acc,
  };
}

const PACK_LABEL = {
  dasar: 'Dasar',
  nusantara: 'Nusantara',
  mood: 'Mood',
  premium: 'Premium',
  bisnis: 'Bisnis',
  legendaris: 'Legendaris',
};

/* validasi: apakah sebuah URL stiker legal & sesuai paket pengirim */
function stickerUrlValid(user, url) {
  const m = /^\/api\/stickers\/([a-z_]+)\.svg$/.exec(String(url || ''));
  if (!m) return false;
  const id = m[1];
  const item = CATALOG[id];
  if (!item) return false;
  return packOpenFor(item.pack, accessOf(user).planId);
}

module.exports = {
  PLAN_RANK, PACK_MIN_PLAN, accessOf, packOpenFor,
  catalogFor, render, stickerUrlValid, CATALOG, PACK_LABEL,
};
