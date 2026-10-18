'use strict';
/* Smoke test PENYIMPANAN HEMAT RAM: drawer Penyimpanan tidak boleh menarik
   byte foto/video ke memori perangkat saat daftar ditelusuri — semua kartu
   memakai placeholder, media hanya dimuat satu per satu saat diketuk
   (openStViewer) dan dilepas saat ditutup; file dibuka streaming tanpa
   atribut unduh. Berjalan di sandbox vm (tanpa server, tanpa jaringan). */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra || ''); }
};

function makeEl(tag) {
  const cls = new Set();
  let html = '';
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    textContent: '', value: '', href: '', src: '', preload: '',
    style: {}, dataset: {}, files: [], children: [],
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !cls.has(c) : !!force;
        if (on) cls.add(c); else cls.delete(c);
        return on;
      },
      contains: (c) => cls.has(c),
    },
    offsetWidth: 360, offsetHeight: 640, scrollHeight: 0, scrollTop: 0, clientHeight: 480,
    addEventListener() {}, removeEventListener() {}, focus() {}, pause() {}, load() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {}, closest: () => null,
    setAttribute(k, v) { this['_attr_' + k] = v; },
    getAttribute(k) { return this['_attr_' + k] === undefined ? null : this['_attr_' + k]; },
    removeAttribute(k) { delete this['_attr_' + k]; if (k === 'src') this.src = ''; },
    querySelector: () => null,
    querySelectorAll(sel) {
      const tags = String(sel).split(',').map((s) => s.trim().toUpperCase());
      const out = [];
      const walk = (node) => {
        (node.children || []).forEach((c) => {
          if (tags.includes(String(c.tagName || '').toUpperCase())) out.push(c);
          walk(c);
        });
      };
      walk(this);
      return out;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 360, height: 640 }),
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); if (html === '') el.children = []; },
  });
  return el;
}

const els = {};
const doc = {
  getElementById: (id) => (els[id] = els[id] || makeEl()),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'),
  title: 'RTC',
};

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  location: { href: 'http://localhost:3000/', search: '', origin: 'http://localhost:3000', pathname: '/' },
  history: { replaceState() {}, pushState() {} },
  navigator: { onLine: true, clipboard: { writeText: async () => {} } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: doc,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  alert() {}, confirm: () => true, prompt: () => null,
  io: () => ({ on() {}, emit() {}, off() {}, disconnect() {} }),
  QRCode: class { constructor() {} clear() {} },
  ClipboardItem: class {},
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  Event: class { constructor(t) { this.type = t; } },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const sandbox = vm.createContext(ctx);
try {
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
} catch (e) {
  console.log('  (info) load app.js melempar:', String(e.message).slice(0, 140));
}

const need = ['renderStorage', 'openStViewer', 'closeStViewer', 'renderStv'];
const missing = need.filter((f) => typeof sandbox[f] !== 'function');
ok(!missing.length, 'fungsi drawer Penyimpanan ter-ekspos di sandbox', missing.join(','));

const now = Date.now();
const items = [
  { id: 'i1', kind: 'msg', type: 'image', name: 'foto-kota.jpg', url: '/uploads/foto-kota.jpg', size: 1_500_000, at: now - 1000 },
  { id: 'i2', kind: 'msg', type: 'video', name: 'klip.mp4', url: '/uploads/klip.mp4', size: 20_000_000, at: now - 2000 },
  { id: 'i3', kind: 'msg', type: 'audio', name: 'pesan-suara.ogg', url: '/uploads/pesan-suara.ogg', size: 800_000, at: now - 3000 },
  { id: 'i4', kind: 'msg', type: 'file', name: 'laporan.pdf', url: '/uploads/laporan.pdf', size: 400_000, at: now - 4000, mime: 'application/pdf' },
];
const data = {
  usage: { used: 22_700_000, quota: 2_000_000_000, percent: 1.1, left: 1_977_300_000 },
  totals: { image: 1_500_000, video: 20_000_000, audio: 800_000, file: 400_000 },
  items,
};

if (!missing.length) {
  // ---------- 1. daftar: placeholder saja, nol byte media ----------
  let err = null;
  try { sandbox.renderStorage(data); } catch (e) { err = e; }
  ok(!err, 'renderStorage berjalan tanpa error', err && String(err.message));

  const grid = doc.getElementById('storageBody').innerHTML || '';
  ok(!/<img\b/i.test(grid), 'daftar TIDAK memuat <img> (foto tidak masuk RAM)', grid.slice(0, 120));
  ok(!/<video\b/i.test(grid), 'daftar TIDAK memuat <video> (video tidak masuk RAM)');
  ok(!/<audio\b/i.test(grid), 'daftar TIDAK memuat <audio>');
  ok(!/\bsrc\s*=/i.test(grid), 'tidak ada atribut src sama sekali di daftar');
  ok(!/\bonerror=/i.test(grid), 'tanpa onerror pemuat media');
  ok((grid.match(/st-thumb-ph/g) || []).length === items.length,
    `semua ${items.length} kartu memakai placeholder st-thumb-ph`,
    (grid.match(/st-thumb-ph/g) || []).length);
  ok(grid.includes('st-ph-video') && grid.includes('st-play'),
    'kartu video tetap punya lencana play (tanpa memuat video)');
  ok(grid.includes('foto-kota.jpg') && grid.includes('laporan.pdf'),
    'nama & meta file tampil lengkap di placeholder');
  ok(grid.includes('st-ram-note'), 'catatan hemat RAM tampil di drawer');
  ok(grid.includes('fmtBytes') === false && /22,7 MB|22\.7 MB|MB/.test(grid),
    'ringkasan kuota terformat dengan benar', (grid.match(/<b>[^<]*<\/b>/g) || []).slice(0, 2));

  // ---------- 2. ketuk kartu -> media tunggal dimuat on-demand ----------
  sandbox.openStViewer(items, 0);
  const stage = doc.getElementById('stvStage');
  ok(doc.getElementById('stViewer').classList.contains('hidden') === false, 'viewer terbuka');
  ok(stage.children.length === 1 && stage.children[0].tagName === 'IMG',
    'viewer foto: tepat 1 elemen <img> yang dimuat (on-demand)', stage.children.length);
  ok(stage.children[0].src === '/uploads/foto-kota.jpg', 'img memakai URL media yang diketuk');

  sandbox.openStViewer(items, 1);
  ok(stage.children.length === 1 && stage.children[0].tagName === 'VIDEO',
    'ganti ke video: media sebelumnya dilepas, hanya 1 yang hidup');
  ok(stage.children[0].preload === 'none', 'video preload=none (0 byte sampai ditekan putar)', stage.children[0].preload);

  sandbox.openStViewer(items, 2);
  ok(stage.children[0].tagName === 'AUDIO' && stage.children[0].preload === 'none',
    'audio streaming on-demand (preload=none)');

  // ---------- 3. file: buka streaming tanpa unduh ke HP ----------
  sandbox.openStViewer(items, 3);
  ok(stage.children.length === 1 && stage.children[0].tagName === 'DIV',
    'file ditampilkan sebagai kartu info (tanpa memuat isi file)');
  const open = doc.getElementById('stvOpen');
  ok(open.href === '/uploads/laporan.pdf', 'tombol Buka menunjuk URL file di server', open.href);
  ok(open.getAttribute('download') === null, 'TIDAK ada atribut download (tidak menyimpan ke HP)');
  ok(!appSrc.includes("stvOpen.setAttribute('download'"), 'kode sumber tidak pernah memasang atribut unduh');

  // ---------- 4. tutup -> seluruh media dilepas dari memori ----------
  sandbox.closeStViewer();
  ok(stage.children.length === 0, 'tutup viewer -> semua media dilepas dari memori');
  ok(stage.innerHTML === '', 'stage dikosongkan (src dibuang, buffer bebas)');
  ok(doc.getElementById('stViewer').classList.contains('hidden'), 'viewer tertutup');
  ok(doc.body.style.overflow === '', 'scroll halaman dipulihkan');

  // ---------- 5. cek statis ----------
  ok(!/<img[^>]*st-thumb/i.test(appSrc), 'grid lama berbasis <img> sudah dihapus dari sumber');
  ok(!/<video src=/i.test(appSrc.split('function openStViewer')[0].split('function renderStorage')[1] || ''),
    'renderStorage tidak lagi membuat elemen video');
  ok(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8').includes('Buka di Tab'),
    'label tombol viewer: "Buka di Tab" (bukan unduh)');
}

console.log(`\n==== PENYIMPANAN HEMAT RAM: ${pass} lulus, ${fail} gagal ====`);
process.exit(fail ? 1 : 0);
