'use strict';

/* Generator gambar lokal untuk bot "Generator Gambar".
   Dipakai sebagai cadangan saat API eksternal tidak tersedia
   (MAZVAL_API_KEY belum diatur / layanan sedang turun), supaya
   perintah brat, brathd & smeme tetap menghasilkan gambar sungguhan. */

const crypto = require('crypto');
const { storeBuffer } = require('./upload');

const MAX_TEXT = 600;

const STYLES = {
  brat: { size: 1000, bg: '#8ace00', fg: '#000000', stroke: null, weight: 'bold', font: 'DejaVu Sans, Arial, Helvetica, sans-serif', pad: 64, base: 92, min: 30 },
  brathd: { size: 1600, bg: '#a6ff00', fg: '#000000', stroke: null, weight: 'bold', font: 'DejaVu Sans, Arial, Helvetica, sans-serif', pad: 96, base: 150, min: 44 },
  smeme: { size: 1000, bg: '#111111', fg: '#ffffff', stroke: '#000000', weight: 'bold', font: 'DejaVu Sans, Arial, Helvetica, sans-serif', pad: 48, base: 84, min: 28 },
};

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// pemotongan baris tanpa pustaka: perkiraan lebar huruf tebal ~0.58em
function wrapLines(text, maxChars) {
  const paragraphs = String(text).split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      let w = word;
      while (w.length > maxChars) {
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, maxChars - 1) + '-');
        w = w.slice(maxChars - 1);
      }
      const next = line ? `${line} ${w}` : w;
      if (next.length > maxChars && line) { lines.push(line); line = w; }
      else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ukurkan font sampai muat di kanvas (turunkan ukuran bila teks panjang)
function layout(text, style) {
  const usable = style.size - style.pad * 2;
  const height = style.size - style.pad * 2;
  for (let size = style.base; size >= style.min; size -= 6) {
    const maxChars = Math.max(4, Math.floor(usable / (size * 0.58)));
    const lines = wrapLines(text, maxChars);
    const lh = size * 1.16;
    if (lines.length * lh <= height || size === style.min) return { lines, size, lh };
  }
  return null;
}

function svgDocument(style, lines, size, lh) {
  const S = style.size;
  const half = S / 2;
  const blockHeight = lines.length * lh;
  const offsetY = Math.max(style.pad + size * 0.82, (S - blockHeight) / 2 + size * 0.82);
  const stroke = style.stroke
    ? ` stroke="${style.stroke}" stroke-width="${Math.round(size / 14)}" paint-order="stroke" stroke-linejoin="round"`
    : '';
  const textNodes = lines
    .map((line, i) => `<tspan x="${half}" y="${offsetY + i * lh}">${escapeXml(line) || ' '}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${style.bg}"/>
  <text font-family="${style.font}" font-size="${size}" font-weight="${style.weight}" fill="${style.fg}"${stroke} text-anchor="middle">${textNodes}</text>
</svg>`;
}

// meme: baris pertama di atas, sisanya di bawah (pemisah "|")
function memeSvg(style, text) {
  const parts = String(text).split('|');
  const topText = (parts[0] || '').trim();
  const bottomText = parts.slice(1).join('|').trim();
  const S = style.size;
  const block = (txt, place) => {
    if (!txt) return '';
    const fitted = layout(txt, { ...style, base: 78, min: 26, pad: 40 }) || layout(txt, style);
    if (!fitted) return '';
    const { lines, size, lh } = fitted;
    const startY = place === 'bottom'
      ? S - style.pad - (lines.length - 1) * lh - size * 0.2
      : style.pad + size * 0.85;
    const stroke = style.stroke
      ? ` stroke="${style.stroke}" stroke-width="${Math.round(size / 10)}" paint-order="stroke" stroke-linejoin="round"`
      : '';
    const nodes = lines
      .map((l, i) => `<tspan x="${S / 2}" y="${startY + i * lh}">${escapeXml(l) || ' '}</tspan>`)
      .join('');
    return `<text font-family="${style.font}" font-size="${size}" font-weight="${style.weight}" fill="${style.fg}"${stroke} text-anchor="middle">${nodes}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${style.bg}"/>
  ${block(topText, 'top')}
  ${block(bottomText, 'bottom')}
</svg>`;
}

async function renderPng(svg) {
  const sharp = require('sharp');
  return sharp(Buffer.from(svg, 'utf8')).png({ compressionLevel: 9 }).toBuffer();
}

/* render teks -> buffer PNG */
async function renderImage(styleName, rawText) {
  const style = STYLES[styleName] || STYLES.brat;
  const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) return null;
  try {
    const svg = styleName === 'smeme' ? memeSvg(style, text) : (() => {
      const { lines, size, lh } = layout(text, style);
      if (!lines || !lines.length) return null;
      return svgDocument(style, lines, size, lh);
    })();
    if (!svg) return null;
    const buffer = await renderPng(svg);
    if (!buffer || !buffer.length) return null;
    return {
      buffer,
      filename: `brattxt-${styleName}-${crypto.randomBytes(4).toString('hex')}.png`,
      mime: 'image/png',
    };
  } catch {
    return null;
  }
}

/* render -> simpan ke penyimpanan -> media siap kirim */
async function generateLocalImage(styleName, rawText) {
  const img = await renderImage(styleName, rawText);
  if (!img) return null;
  const stored = await storeBuffer(img.buffer, 'image', img.filename, { keepName: true });
  if (!stored) return null;
  return {
    type: 'image',
    url: stored.url,
    name: stored.name,
    mime: img.mime,
    size: stored.size,
    cached: true,
  };
}

module.exports = { renderImage, generateLocalImage, STYLES };
