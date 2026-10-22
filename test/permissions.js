'use strict';
/* Uji izin + notifikasi + panggilan: permintaan izin bertahap (mikrofon saat
   panggilan, kamera saat video, kontak saat dipilih), panduan saat diblokir,
   privasi isi pesan, bisukan per chat, deduplikasi notifikasi, lencana aplikasi,
   dering berulang & speaker. Bagian [S] memeriksa sumber, bagian [R] menjalankan
   app.js di sandbox vm dengan DOM tiruan (tanpa server). */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra !== undefined ? String(extra) : ''); }
};
const read = (p) => fs.readFileSync(p, 'utf8');

console.log('\n[S] Sumber & markup');
const html = read('public/index.html');
ok(html.includes('id="permIntroModal"'), 'pengantar izin (permIntroModal) ada di index.html');
ok(html.includes('id="permHelpModal"'), 'panduan izin (permHelpModal) ada di index.html');
ok(html.includes('data-perm="microphone"'), 'baris izin mikrofon ada (diminta saat panggilan)');
ok(html.includes('data-perm="camera"'), 'baris izin kamera ada (diminta saat video)');
ok(html.includes('data-perm="contacts"'), 'baris izin kontak ada');
ok(html.includes('data-perm="lockscreen"'), 'baris layar kunci (panduan) ada');
ok(html.includes('data-pv="hideNotifContent"'), 'sakelar sembunyikan isi pesan ada');
ok(html.includes('id="notifVibrateToggle"'), 'sakelar getar ada');
ok(html.includes('id="btnPickContact"'), 'tombol pilih kontak perangkat ada di Chat baru');
ok(html.includes('id="btnToggleSpeaker"'), 'tombol speaker ada di layar panggilan');
ok(html.includes('id="ic-speaker"'), 'ikon speaker tersedia');
ok(/Pilih dari kontak perangkat/.test(html), 'label tombol kontak perangkat benar');

const sw = read('public/sw.js');
ok(/renotify:\s*true/.test(sw), 'sw: renotify aktif (dering ulang notifikasi)');
ok(/options\.vibrate\s*=/.test(sw), 'sw: pola getar notifikasi diatur');
ok(/getSWPref\('vibrate'/.test(sw), 'sw: getar mengikuti preferensi pengguna');
ok(/setAppBadge/.test(sw), 'sw: lencana aplikasi (badge) ditangani');
  ok(/rtc-core-v16/.test(sw), 'sw: versi cache diperbarui (v16 — ekspor unduhan native + PWA ikut terbaru)');

const sIndex = read('server/index.js');
ok(/async function pushChatTargets/.test(sIndex), 'server: push memakai pushChatTargets (privasi + bisukan)');
ok(/app\.post\('\/api\/chats\/:id\/notifications'/.test(sIndex), 'server: endpoint notifikasi per chat ada');
ok(/priv_hide_notif_content/.test(sIndex), 'server: kolom privasi isi pesan dipakai saat PATCH /api/me');
ok(/hideNotifContent: 'priv_hide_notif_content'/.test(sIndex), 'server: PRIVACY_COLUMNS memuat hideNotifContent');
ok(/body: 'Pesan baru', hidePreview: true/.test(sIndex), 'server: isi pesan disembunyikan jadi "Pesan baru" saat push');

const sDb = read('server/db.js');
ok((sDb.match(/CREATE TABLE IF NOT EXISTS chat_notifs/g) || []).length === 2, 'server: tabel chat_notifs di skema PG & SQLite');
ok((sDb.match(/priv_hide_notif_content/g) || []).length >= 3, 'server: kolom privasi ada di skema ganda + migrasi');
ok(/muted\s+SMALLINT/.test(sDb) && /muted\s+INTEGER/.test(sDb), 'server: kolom muted bertipe sesuai dialek');

const sHelpers = read('server/helpers.js');
ok(/muted: !!bundle\.mutes\.get/.test(sHelpers), 'server: payload chat memuat flag muted per penerima');
ok(/SELECT chat_id FROM chat_notifs WHERE chat_id IN/.test(sHelpers), 'server: daftar bisukan dibaca per pengguna');

/* ---------------- [R] runtime app.js ---------------- */
console.log('\n[R] perilaku aplikasi (sandbox vm)');

function makeEl() {
  const classes = new Set();
  const listeners = {};
  return {
    innerHTML: '', value: '', style: {}, dataset: {}, children: [],
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else { force ? classes.add(c) : classes.delete(c); } },
      contains: (c) => classes.has(c),
    },
    listeners,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    appendChild(el) { this.children.push(el); }, remove() {}, focus() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    offsetWidth: 360, offsetHeight: 640, scrollHeight: 0, scrollTop: 0, clientHeight: 0, clientWidth: 360,
    textContent: '', checked: false, disabled: false, parentNode: null, muted: false, sinkId: 'default',
    fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {} })); },
  };
}

const els = {};
const store = {};
const idbStore = {};
const counters = { sys: 0, card: 0, vib: 0, badge: [], clear: 0 };
const doc = {
  getElementById: (id) => (els[id] = els[id] || makeEl()),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {}, body: makeEl(), documentElement: makeEl(),
  title: 'RTC', visibilityState: 'visible', hasFocus: () => false,
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, atob, btoa,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  location: { href: 'http://localhost:3000/', search: '', origin: 'http://localhost:3000', pathname: '/' },
  history: { replaceState() {}, pushState() {} },
  navigator: {
    onLine: true,
    clipboard: { writeText: async () => {} },
    vibrate: (p) => { counters.vib += 1; return Array.isArray(p) ? true : true; },
    setAppBadge: (n) => { counters.badge.push(n); return Promise.resolve(); },
    clearAppBadge: () => { counters.clear += 1; return Promise.resolve(); },
    permissions: { query: async ({ name }) => ({ state: (ctx.__permStates || {})[name] || 'prompt', onchange: null }) },
  },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  indexedDB: {
    open: () => {
      const req = {
        onupgradeneeded: null, onsuccess: null, onerror: null,
        result: {
          createObjectStore() {},
          transaction: () => ({ objectStore: () => ({
            put: (v, k) => { idbStore[k] = v; },
            get: () => ({ onsuccess: null, onerror: null }),
          }) }),
          close() {},
        },
      };
      setTimeout(() => { if (req.onupgradeneeded) req.onupgradeneeded({}); if (req.onsuccess) req.onsuccess({}); }, 0);
      return req;
    },
  },
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
  Notification: { permission: 'default', requestPermission: async () => 'granted' },
  __sys: 0, __card: 0, __permStates: {},
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;

const sandbox = vm.createContext(ctx);
try {
  vm.runInContext(read('public/js/app.js'), sandbox, { filename: 'app.js' });
} catch (e) {
  console.log('  (info) load app.js melempar:', String(e.message).slice(0, 140));
}

const run = (code) => vm.runInContext(code, sandbox);
const fn = (name) => typeof sandbox[name] === 'function';

console.log('\n[R1] izin bertahap');
ok(fn('permSupported') && fn('permState') && fn('requestPerm'), 'modul PERM (permSupported/permState/requestPerm) tersedia');
ctx.navigator.mediaDevices = undefined;
ok(run('permSupported("microphone")') === false, 'mikrofon: tidak didukung tanpa mediaDevices');
ctx.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
ok(run('permSupported("microphone")') === true, 'mikrofon: didukung dengan mediaDevices');
ok(run('permSupported("contacts")') === false, 'kontak: tidak didukung tanpa Contact Picker API');
ctx.navigator.contacts = { select: async () => [] };
ok(run('permSupported("contacts")') === true, 'kontak: didukung saat API tersedia');
ok(run('permSupported("camera")') === true, 'kamera: didukung (hanya dipakai untuk panggilan video)');
ok(run('notifPerm()') === 'default', 'notifPerm() mengikuti Notification.permission', run('notifPerm()'));

ctx.__permStates = { microphone: 'granted', camera: 'denied' };
run('permStatesDone = 0');
const permChecks = run('(async () => { const a = await permState("microphone"); const b = await permState("camera"); return a + "/" + b; })()');
permChecks.then((v) => {
  ok(v === 'granted/denied', 'permState membaca mikrofon & kamera dari Permissions API', v);
  return probeRequests();
}).then(() => finish()).catch((e) => { console.log('  gagal:', e); process.exit(1); });

async function probeRequests() {
  console.log('\n[R2] pemintaan izin sesuai kebutuhan');
  ok(await run('permState("notifications")') === 'default', 'permState(notifikasi) mengikuti Notification.permission', await run('permState("notifications")'));
  let micConstraints = null, camConstraints = null, stopped = 0;
  ctx.navigator.mediaDevices = {
    getUserMedia: async (c) => {
      if (c.video) camConstraints = c; else micConstraints = c;
      return { getTracks: () => [{ stop: () => { stopped += 1; } }] };
    },
  };
  const micState = await run('requestPerm("microphone")');
  ok(micState === 'granted', 'requestPerm(mikrofon) -> granted', micState);
  ok(micConstraints && micConstraints.audio === true && micConstraints.video === false, 'mikrofon: constraint audio saja (kamera tidak disentuh)', JSON.stringify(micConstraints));
  const camState = await run('requestPerm("camera")');
  ok(camState === 'granted', 'requestPerm(kamera) -> granted', camState);
  ok(camConstraints && camConstraints.video && camConstraints.audio === false, 'kamera: constraint video saja (mikrofon tidak dipakai)', JSON.stringify(camConstraints));
  ok(stopped === 2, 'stream pemeriksaan izin langsung dihentikan (tidak bocor)', stopped);

  console.log('\n[R3] pesan galat izin/piranti -> panduan');
  const mk = (name) => ({ name });
  let info = run('mediaErrorInfo({ name: "NotAllowedError" }, "microphone")');
  ok(info.perm === true && /mikrofon/i.test(info.msg), 'NotAllowed -> dianggap izin, pesa menyebut mikrofon', info.msg);
  info = run('mediaErrorInfo({ name: "PermissionDeniedError" }, "camera")');
  ok(info.perm === true && /kamera/i.test(info.msg), 'PermissionDenied (kamera) -> panduan kamera', info.msg);
  info = run('mediaErrorInfo({ name: "NotFoundError" }, "camera")');
  ok(info.perm === false && /tidak ada/i.test(info.msg), 'NotFoundError -> kamera tidak ada', info.msg);
  info = run('mediaErrorInfo({ name: "NotReadableError" }, "microphone")');
  ok(info.perm === false && /aplikasi lain/i.test(info.msg), 'NotReadableError -> perangkat dipakai aplikasi lain', info.msg);
  ok(mk && run('mediaErrorInfo({ name: "OverconstrainedError" }, "camera").perm') === false, 'OverconstrainedError -> bukan masalah izin');

  /* Perbaikan PWA terpasang: status navigator.permissions bisa keliru
     (sering "denied" di aplikasi terpasang) — panggilan tidak boleh mati
     sebelum getUserMedia sempat dicoba. */
  const appSrc = read('public/js/app.js');
  ok(!/mediaDeniedKind/.test(appSrc), 'createPeer tidak lagi memblokir panggilan dari hasil query Permissions API yang bisa keliru');
  ok(/await navigator\.mediaDevices\.getUserMedia\(\{\s*audio: true/.test(appSrc.replace(/\n\s*/g, ' ')) || /stream = await navigator\.mediaDevices\.getUserMedia/.test(appSrc), 'getUserMedia tetap dicoba lebih dulu; galat nyata yang menentukan');
  ok(fn('isInstalledPwa') && fn('waitForSW'), 'modul aplikasi terpasang (isInstalledPwa/waitForSW) tersedia');
  ok(run('typeof isInstalledPwa()') === 'boolean', 'isInstalledPwa() aman dipanggil di tab biasa');
  await run('waitForSW(50)');
  ok(true, 'waitForSW tidak menggantung (beri batas waktu)');
  ok(await run('mediaFailKind({ kind: "audio" }, { name: "NotAllowedError" })') === 'microphone', 'kegagalan panggilan suara menunjuk mikrofon');
  ok(await run('mediaFailKind({ kind: "video" }, { name: "NotFoundError" })') === 'camera', 'kamera hilang pada video -> ditunjuk kamera');

  console.log('\n[R4] panduan izin & pengantar');
  await run('openPermHelp("microphone")');
  ok(doc.getElementById('permHelpModal').classList.contains('hidden') === false, 'panduan mikrofon terbuka');
  ok(doc.getElementById('permHelpTitle').textContent.includes('mikrofon'), 'judul panduan sesuai izin', doc.getElementById('permHelpTitle').textContent);
  ok(doc.getElementById('permHelpSteps').innerHTML.includes('Status saat ini'), 'panduan memuat status izin terkini');
  run('closePermHelp()');
  ok(doc.getElementById('permHelpModal').classList.contains('hidden') === true, 'panduan bisa ditutup');
  run('maybeShowPermIntro()');
  ok(doc.getElementById('permIntroModal').classList.contains('hidden') === false, 'pengantar izin tampil saat pertama kali');
  ok(store.wa_perm_intro_v1 === undefined, 'pengantar belum ditandai sebelum ditutup');
  run('closePermIntro()');
  ok(store.wa_perm_intro_v1 === '1' && doc.getElementById('permIntroModal').classList.contains('hidden'), 'pengantar ditandai sekali per perangkat');
  run('maybeShowPermIntro()');
  ok(doc.getElementById('permIntroModal').classList.contains('hidden') === true, 'pengantar tidak muncul dua kali');
  ok(fn('permBtnText') && run('permBtnText("microphone", "granted").disabled') === true, 'status granted -> tombol Diizinkan (dinonaktifkan)');
  ok(run('permBtnText("microphone", "denied").text') === 'Panduan', 'status denied -> tombol Panduan');
  ok(run('permBtnText("microphone", "prompt").text') === 'Aktifkan', 'status prompt -> tombol Aktifkan');
  ok(run('permBtnText("contacts", "unsupported").disabled') === true, 'tidak didukung -> tombol nonaktif');

  console.log('\n[R5] privasi isi pesan, bisukan per chat, deduplikasi');
  run(`
    __sys = 0; __card = 0;
    showSystemNotif = function () { __sys += 1; return Promise.resolve(); };
    showNotifCard = function () { __card += 1; };
    S.me = { id: 'u-me', name: 'Saya', privacy: {} };
    S.chats = [{ id: 'c1', type: 'direct', peer: { id: 'p1', name: 'Teman' }, unread: 0, muted: false }];
    S.activeChatId = null;
    NOTIF.seen.clear();
    NOTIF.vibrate = true;
  `);
  const msg = `{ id: 'm-perm-1', chatId: 'c1', senderId: 'p1', senderName: 'Teman', type: 'text', body: 'rahasia banget', createdAt: Date.now() }`;
  let payload = run(`buildNotifPayload(${msg})`);
  ok(payload.body.includes('rahasia banget'), 'tanpa privasi: isi pesan tampil di notifikasi', payload.body);
  run('S.me.privacy.hideNotifContent = true');
  payload = run(`buildNotifPayload(${msg})`);
  ok(payload.body === 'Pesan baru' && payload.hidePreview === true, 'privasi aktif: isi disembunyikan, judul pengirim tetap', payload.body);
  ok(/Teman/.test(payload.title), 'nama pengirim tetap tampil', payload.title);
  run('S.me.privacy.hideNotifContent = false');

  run(`notify(${msg})`);
  ok(ctx.__card === 1 && ctx.__sys === 1, 'pesan pertama -> satu banner & satu notifikasi sistem', `${ctx.__card}/${ctx.__sys}`);
  run(`notify(${msg})`);
  ok(ctx.__card === 1 && ctx.__sys === 1, 'pesan sama dikirim ulang -> deduplikasi, tidak dobel', `${ctx.__card}/${ctx.__sys}`);
  run(`
    S.me.id = 'u-other';
    NOTIF.seen.clear();
    __sys = 0; __card = 0;
    S.chats = [{ id: 'c2', type: 'direct', peer: { id: 'p2', name: 'Lain' }, unread: 0, muted: true }];
  `);
  run(`notify({ id: 'm-perm-2', chatId: 'c2', senderId: 'p2', senderName: 'Lain', type: 'text', body: 'halo', createdAt: Date.now() })`);
  ok(ctx.__card === 0 && ctx.__sys === 0, 'chat dibisukan: tidak ada banner/notifikasi sistem', `${ctx.__card}/${ctx.__sys}`);
  ok(run('NC.items.some((i) => i.messageId === "m-perm-2")'), 'chat dibisukan: riwayat pusat notifikasi tetap tercatat');

  console.log('\n[R6] getar, lencana, preferensi service worker');
  counters.vib = 0;
  run('NOTIF.vibrate = false');
  run('vibrate([50, 30, 50])');
  ok(counters.vib === 0, 'getar mati -> navigator.vibrate tidak dipanggil', counters.vib);
  run('NOTIF.vibrate = true');
  run('vibrate([50, 30, 50])');
  ok(counters.vib === 1, 'getar aktif -> navigator.vibrate terpanggil', counters.vib);

  counters.badge.length = 0; counters.clear = 0;
  run('S.chats = [{ id: "c1", type: "direct", peer: { id: "p1" }, unread: 3 }]; updateAppBadge();');
  ok(counters.badge.includes(3), 'lencana aplikasi = jumlah pesan belum dibaca', JSON.stringify(counters.badge));
  run('S.chats = [{ id: "c1", type: "direct", peer: { id: "p1" }, unread: 0 }]; updateAppBadge();');
  ok(counters.clear > 0, 'lencana dihapus saat semua pesan terbaca', counters.clear);

  run('setSWPref("vibrate", false)');
  await new Promise((r) => setTimeout(r, 10));
  ok(idbStore.vibrate === false, 'preferensi getar disimpan ke IndexedDB (dibaca service worker)', JSON.stringify(idbStore));

  console.log('\n[R7] bisukan per chat, dering, speaker, kontak');
  const rowOn = run('muteRowHtml({ muted: true }, "xMute")');
  const rowOff = run('muteRowHtml({ muted: false }, "xMute")');
  ok(/checked/.test(rowOn) && !/checked/.test(rowOff), 'baris bisukan: sakelar mengikuti status muted');
  ok(/Senyap/.test(rowOn) && /Bunyi/.test(rowOff), 'teks baris bisukan sesuai status');
  ok(typeof sandbox.setChatMuted === 'function', 'setChatMuted tersedia (endpoint per chat)');

  ok(fn('startRingTone') && fn('stopRingTone'), 'dering berulang tersedia');
  run('startRingTone("in")');
  ok(run('RING.mode') === 'in' && run('RING.timer !== null'), 'dering masuk: loop dering aktif');
  run('startRingTone("out")');
  ok(run('RING.mode') === 'out' && run('RING.timer !== null'), 'dering keluar: ringback loop aktif');
  run('stopRingTone()');
  ok(run('RING.timer === null') && run('RING.mode === null'), 'stopRingTone menghentikan dering/getar');

  const speaker = doc.getElementById('btnToggleSpeaker');
  ok((speaker.listeners.click || []).length === 1, 'tombol speaker punya handler');
  ok((doc.getElementById('btnPickContact').listeners.click || []).length === 1, 'tombol pilih kontak punya handler');
  ok((doc.getElementById('btnPermHelpRetry').listeners.click || []).length === 1, 'tombol "Coba lagi" panduan punya handler');
  ok((doc.getElementById('notifVibrateToggle').listeners.change || []).length === 1, 'sakelar getar punya handler');
  ok((doc.getElementById('btnPermIntroNotif').listeners.click || []).length === 1, 'tombol aktifkan notifikasi pengantar punya handler');
  ok(fn('applySpeaker') && fn('applySpeaker') !== null, 'fungsi applySpeaker (setSinkId/earpiece) tersedia');

  finish();
}

function finish() {
  console.log(`\n==== HASIL IZIN & NOTIFIKASI: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
}
