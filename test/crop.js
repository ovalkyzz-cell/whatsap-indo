'use strict';
/* Test logika pemotong foto (public/js/app.js) tanpa browser.
   Blok fungsi cROP dievaluasi dengan DOM tiruan sehingga geometri
   bingkai, clamp zoom/geser, dan koordinat ekspor benar-benar diuji. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = SRC.indexOf('const CROP = {');
const end = SRC.indexOf('/* ================= latar belakang chat');
if (start < 0 || end < 0 || end <= start) {
  console.error('blok pemotong foto tidak ditemukan di app.js');
  process.exit(1);
}
const block = SRC.slice(start, end);

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

const drawn = [];
const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      value: '100',
      textContent: '',
      clientWidth: 400,
      clientHeight: 300,
      naturalWidth: 800,
      naturalHeight: 600,
      querySelectorAll: () => [],
      addEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture() {},
      closest: () => null,
    };
  }
  return elements[id];
}

const sandbox = {
  cropEl: el,
  updateRangeFill() {},
  toast() {},
  document: {
    getElementById: el,
    createElement: (tag) => {
      if (tag !== 'canvas') return el(`new-${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          fillStyle: '',
          fillRect() {},
          drawImage(...args) { drawn.push(args); },
        }),
        toBlob(cb) { cb({ size: 10 }); },
      };
    },
    body: { classList: { add() {}, remove() {} } },
    addEventListener() {},
  },
  window: { addEventListener() {} },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  File: class File {
    constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; }
  },
  Math, Promise, Number, String, console, setTimeout, clearTimeout,
};

const ctx = vm.createContext(sandbox);
vm.runInContext(
  `${block}\n;this.CROP=CROP;this.cropCenterRect=cropCenterRect;this.cropScales=cropScales;`
  + 'this.cropClamp=cropClamp;this.cropZoomAt=cropZoomAt;this.cropResizeFrom=cropResizeFrom;'
  + 'this.cropExport=cropExport;this.cropSync=cropSync;',
  ctx,
);

const S = sandbox;

(async () => {
  console.log('[1] Bingkai rasio bebas & rasio terkunci');
  S.CROP.stage = { w: 400, h: 300 };
  S.CROP.natural = [800, 600];
  S.CROP.base = 0.5;
  S.CROP.ratio = 0;
  S.cropCenterRect();
  let r = S.CROP.rect;
  ok(Math.abs(r.w - r.h) < 0.01, 'mode Bebas memakai bingkai persegi awal');
  ok(r.w > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 400 && r.y + r.h <= 300,
    'bingkai awal berada di dalam panggung');

  S.CROP.ratio = 16 / 9;
  S.cropCenterRect();
  r = S.CROP.rect;
  ok(Math.abs(r.w / r.h - 16 / 9) < 0.01, 'preset 16:9 menghasilkan rasio 16:9');
  ok(r.x + r.w <= 400 && r.y + r.h <= 300, 'bingkai 16:9 tetap di dalam panggung');

  S.CROP.ratio = 0.75;
  S.cropCenterRect();
  r = S.CROP.rect;
  ok(Math.abs(r.w / r.h - 0.75) < 0.01, 'preset 3:4 menghasilkan rasio 3:4');

  console.log('\n[2] Clamp zoom & geser (gambar selalu menutupi bingkai)');
  S.CROP.ratio = 0;
  S.cropCenterRect();
  S.CROP.scale = 0.5;
  S.CROP.ox = 5000;
  S.CROP.oy = -5000;
  S.cropScales();
  S.cropClamp();
  ok(S.CROP.ox >= -200 && S.CROP.ox <= 200, `ox dijepit ke rentang wajar (ox=${S.CROP.ox.toFixed(1)})`);
  ok(S.CROP.oy >= -200 && S.CROP.oy <= 200, `oy dijepit ke rentang wajar (oy=${S.CROP.oy.toFixed(1)})`);
  const imgW = S.CROP.natural[0] * S.CROP.scale;
  const imgH = S.CROP.natural[1] * S.CROP.scale;
  const imgLeft = 400 / 2 + S.CROP.ox - imgW / 2;
  const imgTop = 300 / 2 + S.CROP.oy - imgH / 2;
  r = S.CROP.rect;
  ok(imgLeft <= r.x && imgLeft + imgW >= r.x + r.w
    && imgTop <= r.y && imgTop + imgH >= r.y + r.h,
  'area gambar menutup seluruh bingkai potongan setelah clamp');

  S.CROP.scale = 0.001;
  S.cropScales();
  ok(S.CROP.scale >= S.CROP.minScale, 'zoom minimum tidak membuat gambar lebih kecil dari bingkai');

  console.log('\n[3] Hasil ekspor sesuai area yang dipilih');
  S.CROP.scale = 0.5;
  S.CROP.ox = 0;
  S.CROP.oy = 0;
  S.CROP.ratio = 0;
  S.cropCenterRect();
  S.cropScales();
  S.cropClamp();
  drawn.length = 0;
  const out = await S.cropExport();
  r = S.CROP.rect;
  const imLeft = 400 / 2 + S.CROP.ox - (800 * 0.5) / 2;
  const imTop = 300 / 2 + S.CROP.oy - (600 * 0.5) / 2;
  const wantX = (r.x - imLeft) / 0.5;
  const wantY = (r.y - imTop) / 0.5;
  const wantW = r.w / 0.5;
  const wantH = r.h / 0.5;
  const d = drawn[0];
  ok(!!d, 'drawImage dipanggil sekali');
  ok(d && Math.abs(d[1] - wantX) < 0.5 && Math.abs(d[2] - wantY) < 0.5,
    `sumbu X/Y sumber tepat (dapat ${d && d[1]},${d && d[2]} — harap ${wantX},${wantY})`);
  ok(d && Math.abs(d[3] - wantW) < 0.5 && Math.abs(d[4] - wantH) < 0.5,
    `lebar/tinggi sumber tepat (dapat ${d && d[3]}x${d && d[4]} — harap ${wantW}x${wantH})`);
  ok(d && d[1] >= 0 && d[2] >= 0 && d[1] + d[3] <= 800 && d[2] + d[4] <= 600,
    'potongan tidak keluar dari batas gambar asli');
  ok(!!out && out.type === 'image/jpeg' && out.name === 'avatar.jpg', 'hasil berkas JPEG siap unggah');

  console.log('\n[4] Ubah sudut: rasio terkunci & bebas');
  S.CROP.ratio = 1;
  S.CROP.rect = { x: 100, y: 100, w: 150, h: 150 };
  S.cropResizeFrom('br', { x: 260, y: 200 });
  r = S.CROP.rect;
  ok(Math.abs(r.w - r.h) < 0.01, 'tarik sudut dengan rasio 1:1 menjaga persegi');
  ok(r.x === 100 && r.y === 100, 'sudut lawan (kiri-atas) tetap sebagai jangkar');
  ok(r.x + r.w <= 400 && r.y + r.h <= 300, 'bingkai hasil tetap di dalam panggung');

  S.CROP.ratio = 0;
  S.CROP.rect = { x: 100, y: 100, w: 150, h: 150 };
  S.cropResizeFrom('br', { x: 300, y: 240 });
  r = S.CROP.rect;
  ok(r.w === 200 && r.h === 140, `mode Bebas memakai lebar & tinggi berbeda (dapat ${r.w}x${r.h})`);

  S.cropResizeFrom('tl', { x: -50, y: -50 });
  r = S.CROP.rect;
  ok(r.x >= 0 && r.y >= 0, 'menarik melewati tepi dijepit di batas panggung');
  ok(r.w >= 64 && r.h >= 64, 'ukuran minimum bingkai dijaga');

  console.log('\n[5] Zoom ke titik tetap menjaga bagian yang disentuh');
  S.CROP.ratio = 0;
  S.cropCenterRect();
  S.CROP.scale = 0.5;
  S.CROP.ox = 0;
  S.CROP.oy = 0;
  S.cropScales();
  S.cropClamp();
  const px = 300;
  const py = 200;
  const before = {
    u: (px - (400 / 2 + S.CROP.ox)) / S.CROP.scale,
    v: (py - (300 / 2 + S.CROP.oy)) / S.CROP.scale,
  };
  S.cropZoomAt(1.5, px, py);
  const s2 = S.CROP.scale;
  const ux = (px - (400 / 2 + S.CROP.ox)) / s2;
  const uy = (py - (300 / 2 + S.CROP.oy)) / s2;
  ok(Math.abs(ux - before.u) < 0.6 && Math.abs(uy - before.v) < 0.6,
    `titik di bawah kursor tetap di tempat (selisih ${Math.abs(ux - before.u).toFixed(3)})`);
  ok(s2 > 0.5, 'zoom benar-benar memperbesar');

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
