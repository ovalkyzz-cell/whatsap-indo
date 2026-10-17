'use strict';
/* Smoke test RENDER daftar chat: chat tanpa pesan (lastMessage null) dulu membuat
   renderChatListNow melempar TypeError sehingga seluruh daftar chat tampak hilang. */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra || ''); }
};

function makeEl() {
  const el = {
    innerHTML: '', value: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, appendChild() {}, remove() {}, focus() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    offsetWidth: 360, offsetHeight: 640, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    textContent: '', checked: false, disabled: false, parentNode: null,
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
  console.log('  (info) load app.js melempar:', String(e.message).slice(0, 120));
}

// siapkan state lewat binding asli di dalam sandbox (S dideklarasikan const/let)
let setupErr = null;
try {
  vm.runInContext(`
    S.me = { id: 'u-admin', name: 'Admin', email: 'a@b.c' };
    S.chats = [
      { id: 'c-kosong', type: 'direct', peer: { id: 'p1', name: 'Tanpa Pesan', email: '' }, lastMessage: null, unread: 0, archived: false },
      { id: 'c-kosong-grup', type: 'group', name: 'Grup Kosong', lastMessage: null, unread: 0, archived: false },
      { id: 'c-ada', type: 'direct', peer: { id: 'p2', name: 'Ada Pesan', email: '' }, unread: 1, archived: false,
        lastMessage: { id: 'm1', senderId: 'p2', status: 'sent', createdAt: Date.now() - 60000, body: 'halo', type: 'text', deleted: false } },
      { id: 'c-grup', type: 'group', name: 'Grup Kerja', unread: 2, archived: false,
        lastMessage: { id: 'm2', senderId: 'u-lain', status: 'read', createdAt: Date.now() - 30000, body: 'laporan', type: 'text', deleted: false } },
    ];
    S.activeChatId = null;
  `, sandbox);
} catch (e) { setupErr = e; }
if (setupErr) { console.log('  setup gagal:', String(setupErr.message)); process.exit(2); }
sandbox.$ = sandbox.$ || ((id) => doc.getElementById(id));
if (typeof sandbox.renderChatListNow !== 'function') {
  console.log('  ✗ renderChatListNow tidak ter-ekspos di sandbox — smoke test tidak bisa berjalan');
  process.exit(2);
}

let err = null;
try { sandbox.renderChatListNow(); } catch (e) { err = e; }
ok(!err, 'renderChatListNow TANPA error untuk chat tanpa pesan', err && String(err.message));
const html = doc.getElementById('chatList').innerHTML || '';
ok(html.includes('c-kosong'), 'chat tanpa pesan tampil di daftar');
ok(html.includes('c-kosong-grup'), 'grup tanpa pesan tampil di daftar');
ok(html.includes('c-ada'), 'chat dengan pesan tampil di daftar');
ok(html.includes('c-grup'), 'grup dengan pesan tampil di daftar');
ok(!/undefined|NaN/.test(html.replace(/&nbsp;/g, '')), 'tidak ada teks undefined/NaN di HTML');
const ticksInGroup = (html.match(/tick/g) || []).length;
console.log('  (info) jumlah elemen tick di HTML:', ticksInGroup);

console.log(`\n==== HASIL RENDER: ${pass} lulus, ${fail} gagal ====`);
process.exit(fail ? 1 : 0);
