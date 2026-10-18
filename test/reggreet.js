'use strict';
/* Smoke test SAPAAN HALAMAN DAFTAR: teks disunting admin, placeholder {nama}
   diganti otomatis dengan nama yang diketik pendaftar, dan pesan blokir
   anti-spam tampil beranimasi di kartu yang sama. Semua berjalan di sandbox
   vm (tanpa server) memakai DOM tiruan. */

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
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '', href: '', type: '',
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
    addEventListener() {}, removeEventListener() {}, focus() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {}, closest: () => null,
    setAttribute(k, v) { this['_attr_' + k] = v; },
    getAttribute(k) { return this['_attr_' + k] === undefined ? null : this['_attr_' + k]; },
    removeAttribute(k) { delete this['_attr_' + k]; },
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 360, height: 640 }),
  };
  return el;
}

const els = {};
const selectorMap = {};
const doc = {
  getElementById: (id) => (els[id] = els[id] || makeEl()),
  querySelector(sel) {
    if (Object.prototype.hasOwnProperty.call(selectorMap, sel)) return selectorMap[sel];
    if (sel.includes('.active')) return null; // tab daftar belum aktif saat boot
    return makeEl();
  },
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'),
  title: 'RTC',
};

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  URL, URLSearchParams, TextEncoder, TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  location: { href: 'http://localhost:3000/', search: '', origin: 'http://localhost:3000', pathname: '/' },
  history: { replaceState() {}, pushState() {} },
  navigator: { onLine: true, clipboard: { writeText: async () => {} }, vibrate() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  document: doc,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  alert() {}, confirm: () => true, prompt: () => null,
  addEventListener() {}, removeEventListener() {},
  io: () => ({ on() {}, emit() {}, off() {}, disconnect() {} }),
  QRCode: class { constructor() {} clear() {} },
  ClipboardItem: class {},
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  notification: null,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;

// input nama dipakai untuk interpolasi {nama}
selectorMap['#registerForm input[name="name"]'] = makeEl('input');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const sandbox = vm.createContext(ctx);
try {
  vm.runInContext(code, sandbox, { filename: 'app.js' } );
} catch (e) {
  console.log('  (info) load app.js melempar:', String(e.message).slice(0, 140));
}

const need = ['showRegGreet', 'showRegBlocked', 'paintRegGreet', 'regGreetRendered'];
const missing = need.filter((f) => typeof sandbox[f] !== 'function');
ok(!missing.length, 'fungsi sapaan daftar ter-ekspos di sandbox', missing.join(','));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(40); }
  return false;
}

async function main() {
  if (missing.length) { report(); return; }

  const nameInput = selectorMap['#registerForm input[name="name"]'];
  const card = doc.getElementById('regGreet');
  const out = doc.getElementById('regGreetText');
  const errBox = doc.getElementById('authError');

  // ---------- 1. kartu sapaan & interpolasi {nama} ----------
  vm.runInContext(`
    regGreetTpl = 'Halo {nama} — cuki pulang bobo';
    regGreetLoaded = true;
  `, sandbox);

  // boot: tanpa token -> showAuth() -> kartu tersembunyi (tab masuk)
  ok(card.classList.contains('hidden'), 'saat boot kartu sapaan tersembunyi (tab login)');

  nameInput.value = 'Daffa';
  sandbox.showRegGreet(true);
  ok(!card.classList.contains('hidden'), 'buka tab daftar -> kartu sapaan tampil');
  ok(!card.classList.contains('blocked'), 'kartu dalam keadaan sapaan biasa');
  const typedOk = await until(() => out.textContent === 'Halo Daffa — cuki pulang bobo');
  ok(typedOk, 'typewriter selesai: teks menyapa "Daffa" sesuai kolom Nama', out.textContent);

  // ---------- 2. nama diganti -> teks ikut berganti ----------
  vm.runInContext(`
    document.querySelector('#registerForm input[name="name"]').value = 'Budi';
    regGreetRevealed = true;
    paintRegGreet('swap');
  `, sandbox);
  ok(out.textContent.includes('Budi') && !out.textContent.includes('Daffa'),
    'ganti nama -> sapaan otomatis menyebut nama baru', out.textContent);

  vm.runInContext(`
    document.querySelector('#registerForm input[name="name"]').value = '';
    regGreetRevealed = true;
    paintRegGreet('swap');
  `, sandbox);
  ok(out.textContent.includes('Pengguna'), 'kolom nama kosong -> sapaan memakai fallback "Pengguna"', out.textContent);

  // ---------- 3. placeholder {name} (versi Inggris) juga dikenali ----------
  vm.runInContext(`
    regGreetTpl = 'Welcome {name}!';
    document.querySelector('#registerForm input[name="name"]').value = 'Sari';
    regGreetRevealed = true;
    paintRegGreet('swap');
  `, sandbox);
  ok(out.textContent === 'Welcome Sari!', 'placeholder {name} juga tergantikan', out.textContent);

  // ---------- 4. pesan blokir anti-spam tampil di kartu ----------
  const blockMsg = 'Daffa, jangan spam daftar terus ya — hubungi admin.';
  sandbox.showRegBlocked(blockMsg);
  ok(card.classList.contains('blocked'), 'kartu masuk mode blokir (akcent merah)');
  ok(card.classList.contains('shake'), 'kartu beranimasi shake saat diblokir');
  ok(out.textContent === blockMsg, 'pesan blokir tampil utuh di kartu', out.textContent);
  ok(errBox.classList.contains('hidden'), 'authError tidak duplikat — kartu yang menjadi tampilan');
  ok(!card.classList.contains('hidden'), 'kartu tetap terlihat setelah blokir');

  // ---------- 5. kembali ke sapaan ----------
  nameInput.value = 'Daffa';
  sandbox.showRegGreet(true);
  ok(!card.classList.contains('blocked') && !card.classList.contains('shake'),
    'buka ulang tab daftar -> mode blokir dibersihkan');
  const backOk = await until(() => out.textContent.includes('Daffa'));
  ok(backOk, 'kartu kembali menyapa nama pendaftar', out.textContent);

  // bersihkan timer agar proses bisa keluar
  vm.runInContext('showRegGreet(false);', sandbox);

  // ---------- 6. cek statis wiring admin & server ----------
  const idx = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  ok(idx.includes('id="regGreet"') && idx.includes('id="regGreetText"'),
    'index.html memuat kartu #regGreet');
  ok(/class="reg-greet hidden" id="regGreet"/.test(idx),
    'kartu sapaan default tersembunyi sampai tab Daftar dibuka');
  ok(idx.includes('id="admRegGreet"') && idx.includes('id="admRegBlock"') && idx.includes('id="btnSaveRegText"'),
    'panel admin memuat editor Teks Halaman Daftar');
  ok(idx.includes('{nama}'), 'petunjuk placeholder {nama} ada di panel admin');

  ok(code.includes("code === 'ip_diblokir'"), 'app.js mengarahkan galat ip_diblokir ke kartu');
  ok(code.includes('/api/admin/settings') && code.includes('regText'),
    'app.js menyimpan regText lewat /api/admin/settings');
  ok(code.includes('/api/settings/public'), 'app.js mengambil sapaan dari /api/settings/public');

  const srv = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  ok(srv.includes('regGreet') && srv.includes('getRegText'), 'server index.js menyajikan regGreet + regText admin');
  const stg = fs.readFileSync(path.join(root, 'server', 'settings.js'), 'utf8');
  ok(stg.includes('getRegText') && stg.includes('setRegText'), 'settings.js menyimpan teks daftar di DB (server-side)');
  const anti = fs.readFileSync(path.join(root, 'server', 'antispam.js'), 'utf8');
  ok(anti.includes('blockMessage') && anti.includes('fillName'), 'antispam.js memakai pesan admin + interpolasi {nama}');

  report();
}

function report() {
  console.log(`\n==== SAPAAN HALAMAN DAFTAR: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
