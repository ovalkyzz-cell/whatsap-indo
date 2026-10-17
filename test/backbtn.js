'use strict';
/* Smoke test TOMBOL BACK: ‹ di header chat harus keluar dari percakapan —
   chat-open terhapus, S.activeChatId di-reset, panel chat disembunyikan,
   dan daftar chat dirender ulang. */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra || ''); }
};

function makeEl() {
  const classes = new Set();
  const listeners = {};
  const el = {
    innerHTML: '', value: '', style: {}, dataset: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else { force ? classes.add(c) : classes.delete(c); } },
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    listeners,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    appendChild() {}, remove() {}, focus() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    offsetWidth: 360, offsetHeight: 640, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    textContent: '', checked: false, disabled: false, parentNode: null,
    fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {} })); },
  };
  return el;
}

const els = {};
const doc = {
  getElementById: (id) => (els[id] = els[id] || makeEl()),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {}, body: makeEl(), documentElement: makeEl(),
  title: 'RTC',
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
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

const code = fs.readFileSync(process.argv[2] || 'public/js/app.js', 'utf8');
const sandbox = vm.createContext(ctx);
try {
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  console.log('  (info) load app.js melempar:', String(e.message).slice(0, 140));
}

const back = doc.getElementById('btnBack');
ok(typeof back.fire === 'function' && (back.listeners.click || []).length > 0, 'listener click terpasang di #btnBack');

let setupErr = null;
try {
  vm.runInContext(`
    S.me = { id: 'u-me', name: 'Saya', email: 'me@x.id' };
    S.chats = [{ id: 'c1', type: 'direct', peer: { id: 'p1', name: 'Teman', email: '' }, unread: 0, archived: false,
                 lastMessage: { id: 'm1', senderId: 'p1', status: 'read', createdAt: Date.now(), body: 'halo', type: 'text', deleted: false } }];
    S.activeChatId = 'c1';
    $('appView').classList.add('chat-open');
    $('chatActive').classList.remove('hidden');
    $('chatEmpty').classList.add('hidden');
  `, sandbox);
} catch (e) { setupErr = e; }
if (setupErr) { console.log('  setup gagal:', String(setupErr.message)); process.exit(2); }

ok(doc.getElementById('appView').classList.contains('chat-open'), 'kondisi awal: chat terbuka (chat-open)');

let clickErr = null;
try { back.fire('click'); } catch (e) { clickErr = e; }
ok(!clickErr, 'klik #btnBack TANPA error', clickErr && String(clickErr.message));
ok(!doc.getElementById('appView').classList.contains('chat-open'), 'chat-open terhapus — tampilan kembali ke daftar');
const activeAfter = vm.runInContext('S.activeChatId', sandbox);
ok(activeAfter === null, 'S.activeChatId di-reset ke null', activeAfter);
ok(doc.getElementById('chatActive').classList.contains('hidden'), 'panel chat aktif disembunyikan');
ok(!doc.getElementById('chatEmpty').classList.contains('hidden'), 'layar kosong (pilih chat) ditampilkan kembali');
ok(typeof sandbox.phoneUI === 'function', 'helper phoneUI tersedia (Esc & animasi ikut mode HP)');
ok(sandbox.phoneUI() === true, 'phoneUI() true pada container 360px (mode HP aktif)');

console.log(`\n==== HASIL BACK: ${pass} lulus, ${fail} gagal ====`);
process.exit(fail ? 1 : 0);
