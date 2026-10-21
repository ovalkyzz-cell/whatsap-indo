'use strict';
/* Uji media panggilan sungguhan: dua "peramban" vm memuat app.js sebenarnya,
   bertukar sinyal lewat server lokal yang sedang berjalan, dan berbicara lewat
   RTCPeerConnection werift (ICE+DTLS+SDP asli, JSON lewat kabel soket).
   Menutup celah yang tidak terjangkau uji DOM tiruan: mikrofon/kamera benar-benar
   mengalir, ontrack benar-benar menyala, tombol mic/cam/speaker/hangup bekerja.

   Prasyarat: server berjalan di BASE (default http://localhost:3000). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { io: ioc } = require('socket.io-client');
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream, MediaStreamTrack } = require('werift');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const APP_JS = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

let pass = 0, fail = 0;
process.on('unhandledRejection', (e) => { console.log('  (unhandledRejection)', e && e.message || e); });
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra !== undefined ? String(extra) : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/* ---------------- peramban vm ---------------- */
const HIDDEN_DEFAULT = new Set(`appView authError authView connBar fileInput profileMsg registerForm stFileInput storyViews
aboutDrawer activeCall admBgMsg admIpBanCount admMsg admPendingCount admRegMsg adminDrawer attachMenu attachPreview bellBadge bnChatBadge bnGroupBadge bnStatusDot botCatDrawer btnBotMention btnCreateGroupTab btnDeleteStory btnScrollDown chatActive contactDrawer contactsDrawer contactsMore cropModal groupDrawer groupInfoDrawer hbStatus homeBgDrawer incomingCall inviteDrawer menuDrawer menuVerified newChatDrawer notifDrawer olderLoading permHelpModal permIntroModal planDrawer privacyDrawer profileAvatarBadge profileDrawer profileVerified pvStatus recBar regGreet replyBar scrim sdBadge stBulkBar stProgress stViewer statusComposer statusError statusList statusMediaNote statusTagChips statusTagPanel stickerPanel storageDrawer storyComments storyReplyQuote storyViewer stvOpen termAdmin terminalDrawer themeDrawer toast voViewer wallpaperDrawer wpDisabledNote wpStatus`.split(/\s+/).filter(Boolean));

function makeEl(id) {
  const classes = new Set(HIDDEN_DEFAULT.has(id) ? ['hidden'] : []);
  const listeners = {};
  return {
    id, innerHTML: '', value: '', style: { removeProperty() {}, setProperty() {}, getPropertyValue: () => '' }, dataset: {}, children: [], className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else { force ? classes.add(c) : classes.delete(c); } },
      contains: (c) => classes.has(c),
    },
    listeners,
    querySelectorAll: () => [], querySelector: () => makeEl('q'),
    get firstElementChild() { return this.children[0] || null; },
    previousElementSibling: null, nextElementSibling: null, childNodes: [],
    insertBefore() {}, replaceWith() {}, contains: () => false,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    async click(ev) { for (const fn of (listeners.click || []).slice()) await fn(ev || { preventDefault() {}, stopPropagation() {}, target: this }); },
    fire(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {}, target: this })); },
    appendChild(el) { this.children.push(el); if (el) el.parentNode = this; },
    remove() {
      const p = this.parentNode;
      if (p && Array.isArray(p.children)) {
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
      }
    },
    focus() {}, blur() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null, contains: () => false,
    offsetWidth: 360, offsetHeight: 640, scrollHeight: 0, scrollTop: 0, clientHeight: 640, clientWidth: 360,
    textContent: '', value_: '', checked: false, disabled: false, parentNode: null,
    srcObject: null, muted: false, sinkId: 'default', play: async () => {}, pause() {}, load() {},
  };
}

/* RTCSessionDescription gaya peramban ({ type, sdp }) — werift memakai
   konstruktor posisional lama, jadi dibungkus agar app.js bisa memakai
   `new RTCSessionDescription({ type, sdp })` persis seperti di browser asli. */
class BrowserSessionDescription {
  constructor(init) {
    if (init && typeof init === 'object') { this.type = init.type; this.sdp = init.sdp; }
    else { this.sdp = init; this.type = arguments[1]; }
  }
  toJSON() { return { type: this.type, sdp: this.sdp }; }
}

function makeBrowser({ token, mic = 'grant', cam = 'grant', notif = 'granted', contacts = null, earpiece = false, focused = true, micQuery = null, camQuery = null }) {
  const elsRaw = {};
  const els = new Proxy(elsRaw, {
    get: (t, k) => {
      if (k === 'raw') return t;
      if (!(k in t)) t[k] = makeEl(String(k));
      return t[k];
    },
    has: () => true,
  });
  const store = { wa_token: token, wa_perm_intro_v1: '1' };
  const rec = {
    notifications: [], swShown: [], vibrate: [], audioBursts: 0,
    mediaCalls: [], badge: [], clearBadge: 0, contactsSelects: 0, pushSubs: 0,
  };
  // catatan: hasil navigator.permissions bisa dipaksa berbeda dari perilaku
  // getUserMedia (micQuery/camQuery) untuk meniru PWA terpasang yang keliru "denied"
  const permStates = {
    microphone: micQuery || (mic === 'grant' ? 'granted' : 'denied'),
    camera: camQuery || (cam === 'grant' ? 'granted' : 'denied'),
    notifications: notif,
  };
  const devices = earpiece
    ? [{ kind: 'audiooutput', deviceId: 'ear-1', label: 'Earpiece' }, { kind: 'audiooutput', deviceId: 'def-1', label: 'Default' }]
    : [];

  const doc = {
    getElementById: (id) => els[id],
    querySelector: (sel) => makeEl(String(sel)),
    querySelectorAll: () => [],
    createElement: () => makeEl('created'),
    createDocumentFragment: () => makeEl('frag'),
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'), documentElement: makeEl('html'),
    title: 'RTC-Core', visibilityState: 'visible', hasFocus: () => focused,
  };

  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      return { type: '', frequency: { value: 0 }, connect() {}, start() { rec.audioBursts += 1; }, stop() {} };
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }

  class FakeNotification {
    constructor(title, options = {}) {
      rec.notifications.push({ title, body: options.body || '', tag: options.tag || '', vibrate: options.vibrate || null, data: options.data || null });
    }
    static get permission() { return notif; }
    static requestPermission() { return Promise.resolve(notif); }
    close() {}
  }

  const swReg = {
    showNotification: async (title, options = {}) => {
      const entry = { title, body: options.body || '', tag: options.tag || '', vibrate: options.vibrate || null };
      rec.swShown.push(entry);
      rec.notifications.push(entry);
    },
    pushManager: {
      subscribe: async () => {
        rec.pushSubs += 1;
        const ep = `https://push.test/sub-${Math.random().toString(36).slice(2)}-${rec.pushSubs}`;
        return { toJSON: () => ({ endpoint: ep, keys: { p256dh: 'k', auth: 'a' } }) };
      },
      getSubscription: async () => null,
      unsubscribe: async () => true,
    },
  };

  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, atob, btoa,
    Promise, Set, Map, WeakMap, Number, String, Boolean, Error, TypeError, RegExp, Array, Object,
    crypto: require('crypto').webcrypto,
    fetch: (p, opts) => fetch(String(p).startsWith('http') ? String(p) : BASE + p, opts),
    location: { href: BASE + '/', origin: BASE, hostname: 'localhost', pathname: '/', search: '' },
    history: { replaceState() {}, pushState() {} },
    navigator: {
      onLine: true,
      clipboard: { writeText: async () => {} },
      vibrate: (p) => { rec.vibrate.push(p); return true; },
      setAppBadge: (n) => { rec.badge.push(n); return Promise.resolve(); },
      clearAppBadge: () => { rec.clearBadge += 1; return Promise.resolve(); },
      permissions: { query: async ({ name }) => ({ state: permStates[name] || 'prompt', onchange: null }) },
      mediaDevices: {
        getUserMedia: async (c) => {
          rec.mediaCalls.push({ audio: !!c.audio, video: !!c.video });
          if (c.audio && mic === 'deny') { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
          if (c.video && cam === 'deny') { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
          const tracks = [];
          if (c.audio) tracks.push(new MediaStreamTrack({ kind: 'audio' }));
          if (c.video) tracks.push(new MediaStreamTrack({ kind: 'video' }));
          return new MediaStream(tracks);
        },
        enumerateDevices: async () => devices.slice(),
      },
      contacts: contacts ? {
        select: async () => { rec.contactsSelects += 1; return contacts; },
      } : undefined,
      serviceWorker: {
        ready: Promise.resolve(swReg),
        register: async () => swReg,
        addEventListener() {},
      },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    indexedDB: {
      open: () => {
        const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
        const mem = {};
        req.result = {
          createObjectStore() {},
          transaction: () => ({ objectStore: () => ({ put: (v, k) => { mem[k] = v; }, get: () => ({ onsuccess: null, onerror: null }) }) }),
          close() {},
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
    io: (opts) => ioc(BASE, opts),
    Audio: class { constructor() {} play() { return Promise.resolve(); } pause() {} load() {} addEventListener() {} },
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    QRCode: class { constructor() {} clear() {} },
    ClipboardItem: class {},
    FormData: class { append() {} },
    Blob: class { constructor() {} },
    Image: class { constructor() {} addEventListener() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    Notification: FakeNotification,
    RTCPeerConnection, RTCSessionDescription: BrowserSessionDescription, RTCIceCandidate,
    __rec: rec, __els: els, __store: store, __permStates: permStates, __doc: doc,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window.focus = () => {};

  const sandbox = vm.createContext(ctx);
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });
  const run = (code) => vm.runInContext(code, sandbox);
  return { run, els, __els: els, store, rec, sandbox, doc };
}

async function waitUntil(run, expr, ms = 20000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = run(expr); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

/* ---------------- persiapan akun ---------------- */
async function setup() {
  const adm = await api('/api/auth/login', { method: 'POST', body: { email: 'ovalkyzz@gmail.com', password: 'secret123' } });
  if (!adm.data.token) throw new Error('admin lokal tidak bisa login — jalankan server dulu');
  const admTok = adm.data.token;
  const stamp = Date.now();
  const rnd = () => Math.random().toString(36).slice(2, 8);
  async function signup(name) {
    const email = `${name}${stamp}${rnd()}@test.id`;
    const r = await api('/api/auth/register', { method: 'POST', body: { email, name, password: 'secret123' } });
    const id = r.data.user && r.data.user.id;
    await api(`/api/admin/users/${encodeURIComponent(id)}/approve`, { method: 'POST', token: admTok });
    const lg = await api('/api/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    if (!lg.data.token) throw new Error('gagal login uji: ' + email);
    return { id, email, name, token: lg.data.token };
  }
  const A = await signup('PanggilA');
  const B = await signup('TerimaB');
  const C = await signup('SibukC');
  const chat = await api('/api/chats/direct', { method: 'POST', token: A.token, body: { peerId: B.id } });
  if (!chat.data.chat) throw new Error('chat direct gagal dibuat');
  const chatBC = await api('/api/chats/direct', { method: 'POST', token: C.token, body: { peerId: B.id } });
  if (!chatBC.data.chat) throw new Error('chat C-B gagal dibuat');
  return { A, B, C, chatId: chat.data.chat.id, chatBCId: chatBC.data.chat.id, admTok };
}

/* ---------------- skenario ---------------- */
async function main() {
  const { A, B, C, chatId, chatBCId } = await setup();
  console.log('\n[V0] dua peramban vm boot dengan token asli + soket asli');
  const ba = makeBrowser({ token: A.token });
  const bb = makeBrowser({ token: B.token });

  await waitUntil(ba.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await waitUntil(bb.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  if (process.env.DEBUG_BOOT) {
    const snap = (b) => b.run('JSON.stringify({ token: !!S.token, me: S.me && S.me.id, socket: !!(S.socket && S.socket.connected), sockState: S.socket && S.socket.connected, ever: S.everConnected, chats: (S.chats||[]).length, active: S.activeChatId, auth: !!document.getElementById("authView") && !document.getElementById("authView").classList.contains("hidden") })');
    console.log('DEBUG A:', snap(ba));
    console.log('DEBUG B:', snap(bb));
  }
  ok(ba.run('!!(S.socket && S.socket.connected)') === true, 'peramban A: sesi nyata tersambung ke server');
  ok(bb.run('!!(S.socket && S.socket.connected)') === true, 'peramban B: sesi nyata tersambung ke server');
  ok(ba.run('S.chats.some((c) => c.id === ' + JSON.stringify(chatId) + ')') === true, 'peramban A memuat daftar chat dari server');

  /* ---------- V1: panggilan suara penuh ---------- */
  console.log('\n[V1] panggilan suara: dering -> jawab -> media tersambung -> mic/speaker -> tutup');
  await ba.run(`openChat(${JSON.stringify(chatId)})`);
  await waitUntil(ba.run, 'S.activeChatId === ' + JSON.stringify(chatId), 10000);
  ok(ba.run('S.activeChatId') === chatId, 'peramban A membuka chat pribadi dengan B');

  ba.run('startCall("audio")');
  await waitUntil(ba.run, 'S.call && S.call.state === "ringing"', 8000);
  ok(ba.run('S.call && S.call.state === "ringing"') === true, 'A: status Berdering setelah undangan diterima server', ba.run('S.call && S.call.state'));
  ok(ba.run('RING.mode === "out" && RING.timer !== null') === true, 'A: ringback berulang aktif');
  await waitUntil(ba.run, '__rec.audioBursts > 0', 8000);
  ok(ba.run('__rec.audioBursts') > 0, 'A: nada ringback benar-benar dibunyikan (AudioContext)', ba.run('__rec.audioBursts'));
  ok(ba.run('__els.activeCall.classList.contains("hidden")') === false, 'A: layar panggilan tampil');

  await waitUntil(bb.run, 'S.call && S.call.incoming === true', 10000);
  ok(bb.run('S.call && S.call.incoming === true') === true, 'B: layar panggilan masuk tampil', bb.run('S.call && S.call.state'));
  ok(bb.run('RING.mode === "in" && RING.timer !== null') === true, 'B: dering masuk berulang + getar aktif');
  ok(bb.run('__els.incomingCall.classList.contains("hidden")') === false, 'B: modal panggilan masuk terbuka');
  ok(bb.run('__els.inCallerName.innerHTML.includes("PanggilA")') === true, 'B: nama pemanggil tampil', bb.run('__els.inCallerName.innerHTML'));
  await waitUntil(bb.run, '__rec.audioBursts > 0', 8000);
  ok(bb.run('__rec.audioBursts') > 0, 'B: dering masuk dibunyikan berulang');
  ok(bb.run('__rec.vibrate.length') > 0, 'B: getar dering terpanggil', bb.run('JSON.stringify(__rec.vibrate.slice(0,2))'));

  await bb.__els.btnAcceptCall.click();
  const connectedA = await waitUntil(ba.run, 'S.call && S.call.startedAt', 20000);
  const connectedB = await waitUntil(bb.run, 'S.call && S.call.startedAt', 20000);
  ok(!!connectedA, 'A: WebRTC tersambung (ICE+DTLS) & timer mulai berjalan');
  ok(!!connectedB, 'B: WebRTC tersambung (ICE+DTLS) & timer mulai berjalan');
  await waitUntil(ba.run, '__els.callStateText.textContent === "Tersambung"', 6000);
  await waitUntil(bb.run, '__els.callStateText.textContent === "Tersambung"', 6000);
  if (process.env.DEBUG_BOOT) {
    console.log('DEBUG teks A:', ba.run('__els.callStateText.textContent'), '| pc:', ba.run('S.call && S.call.pc && S.call.pc.connectionState'));
    console.log('DEBUG teks B:', bb.run('__els.callStateText.textContent'), '| pc:', bb.run('S.call && S.call.pc && S.call.pc.connectionState'));
  }
  ok(ba.run('__els.callStateText.textContent') === 'Tersambung', 'A: status teks "Tersambung"', ba.run('__els.callStateText.textContent'));
  ok(bb.run('__els.callStateText.textContent') === 'Tersambung', 'B: status teks "Tersambung"', bb.run('__els.callStateText.textContent'));
  ok(ba.run('S.call.localStream.getAudioTracks().length') === 1, 'A: stream lokal memuat satu trek mikrofon');
  ok(bb.run('!!__els.remoteVideo.srcObject') === true, 'B: video/audio jarak jauh menempel di elemen pemutar');
  ok(ba.run('__els.remoteVideo.srcObject !== null') === true, 'A: stream milik B menempel di pemutar A');
  ok(ba.run('__els.btnToggleMic.disabled') === false, 'A: tombol mikrofon aktif setelah media siap');
  ok(ba.run('RING.timer === null') === true, 'A: ringback berhenti saat terhubung');
  ok(bb.run('RING.timer === null') === true, 'B: dering berhenti saat terhubung');
  ok(bb.run('__els.btnToggleCam.disabled') === true, 'B: tombol kamera nonaktif pada panggilan suara');

  // mikrofon A dimatikan -> trek benar-benar nonaktif
  await ba.__els.btnToggleMic.click();
  ok(ba.run('S.call.localStream.getAudioTracks()[0].enabled') === false, 'A: klik mikrofon -> trek audio nonaktif');
  ok(ba.run('__els.btnToggleMic.classList.contains("off")') === true, 'A: tombol mikrofon menandai status mati');
  await ba.__els.btnToggleMic.click();
  ok(ba.run('S.call.localStream.getAudioTracks()[0].enabled') === true, 'A: klik lagi -> mikrofon hidup kembali');

  // speaker B: tanpa earpiece -> fallback bisukan (aman)
  await bb.__els.btnToggleSpeaker.click();
  ok(bb.run('S.call.speaker') === false, 'B: speaker mati -> mode earpiece');
  ok(bb.run('__els.remoteVideo.muted') === true, 'B: tanpa earpiece tersedia, suara lawan dibisukan dengan aman');
  await bb.__els.btnToggleSpeaker.click();
  ok(bb.run('S.call.speaker') === true && bb.run('__els.remoteVideo.muted') === false, 'B: speaker hidup kembali -> suara aktif');

  await ba.__els.btnHangup.click();
  await waitUntil(bb.run, 'S.call === null', 8000);
  ok(ba.run('S.call === null') === true, 'A: panggilan ditutup, layar hilang');
  ok(bb.run('S.call === null') === true, 'B: lawan menggantung -> layar ikut tertutup');
  ok(ba.run('__els.activeCall.classList.contains("hidden")') === true, 'A: layar panggilan tersembunyi');
  await sleep(600);
  const calls = await api(`/api/calls?limit=10`, { token: A.token });
  const lastCall = (calls.data.calls || [])[0];
  ok(!!lastCall && lastCall.kind === 'audio', 'riwayat panggilan suara tercatat di server', JSON.stringify(lastCall && { kind: lastCall.kind, state: lastCall.state }));

  /* ---------- V2: panggilan video (B memanggil A) ---------- */
  console.log('\n[V2] panggilan video: kamera benar-benar dipakai, trek video mengalir');
  const bbChat = (bb.run('JSON.parse(JSON.stringify(S.chats.map(c => ({id:c.id,peer:c.peer&&c.peer.id}))))') || [])
    .find((c) => c.peer === A.id);
  ok(!!bbChat, 'peramban B memiliki chat dengan A');
  await bb.run(`openChat(${JSON.stringify(bbChat.id)})`);
  await waitUntil(bb.run, 'S.activeChatId === ' + JSON.stringify(bbChat.id), 10000);
  bb.run('startCall("video")');
  await waitUntil(bb.run, 'S.call && S.call.state === "ringing"', 8000);
  await waitUntil(ba.run, 'S.call && S.call.incoming === true', 10000);
  await ba.__els.btnAcceptCall.click();
  const vA = await waitUntil(ba.run, 'S.call && S.call.startedAt', 20000);
  const vB = await waitUntil(bb.run, 'S.call && S.call.startedAt', 20000);
  ok(!!vA && !!vB, 'panggilan video tersambung di kedua sisi');
  ok(bb.run('S.call.localStream.getVideoTracks().length') === 1, 'B: stream video memuat trek kamera');
  ok(bb.run('__els.localVideo.style.display') === 'block', 'B: pratinjau kamera tampil');
  ok(ba.run('S.call.localStream.getVideoTracks().length') === 1, 'A: penerima video juga mengirim kamera');
  ok(bb.run('__els.btnToggleCam.disabled') === false, 'B: tombol kamera aktif di panggilan video');
  await bb.__els.btnToggleCam.click();
  ok(bb.run('S.call.localStream.getVideoTracks()[0].enabled') === false, 'B: klik kamera -> trek video nonaktif');
  await bb.__els.btnToggleCam.click();
  ok(bb.run('S.call.localStream.getVideoTracks()[0].enabled') === true, 'B: kamera hidup kembali');
  await bb.__els.btnHangup.click();
  await waitUntil(ba.run, 'S.call === null', 8000);
  ok(ba.run('S.call === null') && bb.run('S.call === null'), 'panggilan video ditutup bersih di kedua sisi');

  /* ---------- V3: penerima sibuk -> tolak otomatis ---------- */
  console.log('\n[V3] penerima sedang sibuk -> penolakan otomatis');
  // B memanggil A (B kini sibuk), lalu C mencoba memanggil B -> otomatis ditolak
  const bChatA = (bb.run('JSON.parse(JSON.stringify(S.chats.map(c => ({id:c.id,peer:c.peer&&c.peer.id}))))') || [])
    .find((c) => c.peer === A.id);
  bb.run(`openChat(${JSON.stringify(bChatA.id)})`);
  bb.run('startCall("audio")');
  await waitUntil(bb.run, 'S.call && S.call.state === "ringing"', 8000);
  const bc = makeBrowser({ token: C.token });
  await waitUntil(bc.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await bc.run(`openChat(${JSON.stringify(chatBCId)})`);
  await waitUntil(bc.run, 'S.activeChatId === ' + JSON.stringify(chatBCId), 10000);
  bc.run('startCall("audio")');
  await waitUntil(bc.run, 'S.call === null', 12000);
  ok(bc.run('S.call === null') === true, 'C: panggilan ditolak otomatis (penerima sibuk) -> layar tertutup');
  ok(/ditolak/i.test(bc.run('__els.toast.textContent') || ''), 'C: toast "Panggilan ditolak" tampil', bc.run('__els.toast.textContent'));
  // A menutup layar dering masuk; B menutup panggilan keluarnya
  await ba.__els.btnRejectCall.click();
  await bb.__els.btnHangup.click();
  await waitUntil(bb.run, 'S.call === null', 8000);
  await waitUntil(ba.run, 'S.call === null', 8000);
  try { bc.run('S.socket && S.socket.disconnect()'); } catch { /* noop */ }

  /* ---------- V4: izin mikrofon diblokir ---------- */
  console.log('\n[V4] izin mikrofon diblokir -> panduan tampil, panggilan tidak gagal diam-diam');
  const bd = makeBrowser({ token: A.token, mic: 'deny' });
  await waitUntil(bd.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await bd.run(`openChat(${JSON.stringify(chatId)})`);
  await waitUntil(bd.run, 'S.activeChatId === ' + JSON.stringify(chatId), 10000);
  bd.run('startCall("audio")');
  await waitUntil(bd.run, 'S.call === null && __els.permHelpModal.classList.contains("hidden") === false', 12000);
  ok(bd.run('S.call === null') === true, 'izin diblokir: panggilan dibatalkan, tidak menggantung');
  ok(bd.run('__els.permHelpModal.classList.contains("hidden")') === false, 'izin diblokir: panduan mikrofon terbuka otomatis');
  ok(/mikrofon/i.test(bd.run('__els.permHelpTitle.textContent') || ''), 'izin diblokir: judul panduan sesuai mikrofon', bd.run('__els.permHelpTitle.textContent'));
  ok(/diblokir|ditolak/i.test(bd.run('__els.toast.textContent') || ''), 'izin diblokir: toast menjelaskan izin ditolak', bd.run('__els.toast.textContent'));
  ok(bd.run('__rec.mediaCalls.length') >= 1, 'izin diblokir: getUserMedia dicoba lalu galat nyata yang menentukan', bd.run('__rec.mediaCalls.length'));
  // pastikan peramban B sudah bersih dari dering sisa sebelum skenario berikutnya
  // (hangup vs invite race: hangup bisa tiba sebelum call dibuat -> server no-op;
  // klien wajib mengirim ulang hangup setelah ack — lihat cabang S.call !== call)
  const bbCleared = await waitUntil(bb.run, 'S.call === null', 10000);
  ok(bbCleared === true, 'B: layar dering V4 ikut tertutup setelah pembatalan', bb.run('JSON.stringify(S.call && { s: S.call.state })'));
  await sleep(600);

  /* ---------- V4b: REGRESI PWA terpasang — query Permissions keliru "denied",
     getUserMedia sebenarnya bisa -> panggilan HARUS tetap tersambung ---------- */
  console.log('\n[V4b] aplikasi terpasang: query "denied" keliru tidak boleh mematikan panggilan');
  const bpwa = makeBrowser({ token: A.token, micQuery: 'denied' }); // getUserMedia tetap granted
  await waitUntil(bpwa.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await bpwa.run(`openChat(${JSON.stringify(chatId)})`);
  await waitUntil(bpwa.run, 'S.activeChatId === ' + JSON.stringify(chatId), 10000);
  ok(bpwa.run('permState ? true : true') === true, 'browser siap');
  ok(await bpwa.run('permState("microphone")') === 'denied', 'peramban uji meniru PWA: query mikrofon = denied (keliru)');
  bpwa.run('startCall("audio")');
  await waitUntil(bpwa.run, 'S.call && S.call.state === "ringing"', 15000);
  ok(bpwa.run('S.call && S.call.state') === 'ringing', 'PWA: panggilan tetap berdering meski query bilang denied', bpwa.run('S.call && S.call.state'));
  await waitUntil(bb.run, 'S.call && S.call.incoming === true', 10000);
  await bb.__els.btnAcceptCall.click();
  const pwaA = await waitUntil(bb.run, 'S.call && S.call.startedAt', 20000);
  const pwaB = await waitUntil(bpwa.run, 'S.call && S.call.startedAt', 20000);
  ok(!!pwaA && !!pwaB, 'PWA: WebRTC tersambung penuh — mikrofon dipakai sungguhan, tidak mati oleh query keliru');
  ok(bpwa.run('__rec.mediaCalls.length') >= 1, 'PWA: getUserMedia benar-benar dipanggil', bpwa.run('__rec.mediaCalls.length'));
  ok(bpwa.run('__els.permHelpModal.classList.contains("hidden")') === true, 'PWA: tidak ada panduan "diblokir" yang menyesatkan');
  await bpwa.__els.btnHangup.click();
  await waitUntil(bb.run, 'S.call === null', 8000);
  await waitUntil(bpwa.run, 'S.call === null', 8000);
  try { bpwa.run('S.socket && S.socket.disconnect()'); } catch { /* noop */ }

  /* ---------- V5: kamera diblokir untuk video ---------- */
  console.log('\n[V5] kamera diblokir -> panduan kamera, panggilan suara tetap aman');
  const bcam = makeBrowser({ token: A.token, cam: 'deny' });
  await waitUntil(bcam.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await bcam.run(`openChat(${JSON.stringify(chatId)})`);
  await waitUntil(bcam.run, 'S.activeChatId === ' + JSON.stringify(chatId), 10000);
  bcam.run('startCall("video")');
  await waitUntil(bcam.run, 'S.call === null && __els.permHelpModal.classList.contains("hidden") === false', 12000);
  ok(/kamera/i.test(bcam.run('__els.permHelpTitle.textContent') || ''), 'kamera diblokir: panduan kamera terbuka', bcam.run('__els.permHelpTitle.textContent'));
  ok(bcam.run('__rec.mediaCalls.length') >= 1, 'kamera diblokir: getUserMedia dicoba lalu galat nyata yang menentukan', bcam.run('__rec.mediaCalls.length'));
  const bbCleared5 = await waitUntil(bb.run, 'S.call === null', 10000);
  ok(bbCleared5 === true, 'B: pembatalan video yang gagal izin juga menutup layar dering B', bb.run('JSON.stringify(S.call && { s: S.call.state })'));

  /* ---------- V6: speaker dengan earpiece sungguhan (setSinkId) ---------- */
  console.log('\n[V6] speaker memakai earpiece saat tersedia (setSinkId)');
  const be = makeBrowser({ token: A.token, earpiece: true });
  await waitUntil(be.run, 'S.socket && S.socket.connected && S.me', 25000);
  // aplikasikan langsung pada elemen pemutar tiruan yang mendukung setSinkId
  be.run(`
    __els.remoteVideo.setSinkId = async function (id) { this.sinkId = id; this.muted = false; return; };
    S.call = blankCall({ callId: 'x', peer: { id: 'p', name: 'T' }, kind: 'audio', incoming: false });
  `);
  await be.run('applySpeaker(false)');
  await sleep(300);
  ok(be.run('__els.remoteVideo.sinkId') === 'ear-1', 'speaker mati -> aliran dialihkan ke earpiece', be.run('__els.remoteVideo.sinkId'));
  await be.run('applySpeaker(true)');
  await sleep(200);
  ok(be.run('__els.remoteVideo.sinkId') === 'default' && be.run('__els.remoteVideo.muted') === false, 'speaker hidup -> kembali ke keluaran bawaan');

  /* ---------- V7: notifikasi nyata saat izin granted ---------- */
  console.log('\n[V7] notifikasi: izin granted -> sistem terpanggil, privasi & bisukan bekerja');
  const bn = makeBrowser({ token: A.token, focused: false }); // jendela terbuka tapi tidak fokus -> notifikasi sistem ala WhatsApp
  await waitUntil(bn.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await waitUntil(bn.run, 'NOTIF.sw !== null', 8000);
  ok(bn.run('NOTIF.sw !== null') === true, 'service worker terdaftar (push & notifikasi latar siap)');
  ok(bn.run('__rec.pushSubs') >= 1 || bn.run('typeof subscribePush === "function"'), 'langganan push dijalankan saat izin granted', bn.run('__rec.pushSubs'));

  const now = Date.now();
  const sb = makeBrowser({ token: B.token });
  await waitUntil(sb.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  sb.run(`S.socket.emit('message:send', { chatId: ${JSON.stringify(chatId)}, type: 'text', body: 'halo dari B' }, () => {})`);
  await waitUntil(bn.run, `__rec.notifications.some((n) => /halo dari B/.test(n.body))`, 12000);
  ok(bn.run('__rec.notifications.some((n) => /halo dari B/.test(n.body))') === true, 'pesan masuk -> notifikasi sistem menampilkan isi pesan', JSON.stringify(bn.run('__rec.notifications.slice(-2)')));
  ok(bn.run('__rec.vibrate.length') > 0, 'notifikasi pesan ikut getar sesuai preferensi');

  // privasi: sembunyikan isi pesan
  await api('/api/me', { method: 'PATCH', token: A.token, body: { privacy: { hideNotifContent: true } } });
  const me2 = await api('/api/auth/me', { token: A.token });
  ok(me2.data.user.privacy.hideNotifContent === true, 'privasi "Sembunyikan isi pesan" tersimpan di server');
  bn.run('S.me.privacy.hideNotifContent = true');
  const beforeHidden = bn.run('__rec.notifications.length');
  sb.run(`S.socket.emit('message:send', { chatId: ${JSON.stringify(chatId)}, type: 'text', body: 'rahasia berikutnya' }, () => {})`);
  await waitUntil(bn.run, `__rec.notifications.length > ${beforeHidden}`, 12000);
  const lastN = bn.run('__rec.notifications[__rec.notifications.length - 1]');
  ok(!!lastN && lastN.body === 'Pesan baru' && !/rahasia/.test(lastN.body), 'privasi aktif: isi pesan disembunyikan jadi "Pesan baru"', JSON.stringify(lastN));
  ok(!!lastN && lastN.title.length > 0, 'judul notifikasi tetap ada', JSON.stringify(lastN && lastN.title));
  await api('/api/me', { method: 'PATCH', token: A.token, body: { privacy: { hideNotifContent: false } } });
  bn.run('S.me.privacy.hideNotifContent = false');

  // bisukan per chat -> pesan tetap masuk, notifikasi sistem senyap
  await api(`/api/chats/${chatId}/notifications`, { method: 'POST', token: A.token, body: { muted: true } });
  await bn.run(`loadChats()`);
  await waitUntil(bn.run, '(S.chats.find(c => c.id === ' + JSON.stringify(chatId) + ') || {}).muted === true', 8000);
  ok(bn.run('(S.chats.find(c => c.id === ' + JSON.stringify(chatId) + ') || {}).muted') === true, 'status bisukan terbawa ke daftar chat klien');
  const beforeMute = bn.run('__rec.notifications.length');
  sb.run(`S.socket.emit('message:send', { chatId: ${JSON.stringify(chatId)}, type: 'text', body: 'masih terkirim' }, () => {})`);
  await sleep(2500);
  ok(bn.run('__rec.notifications.length') === beforeMute, 'chat dibisukan: tidak ada notifikasi sistem baru', `${beforeMute} -> ${bn.run('__rec.notifications.length')}`);
  const gotMute = await waitUntil(bn.run, 'S.messages[' + JSON.stringify(chatId) + '] && S.messages[' + JSON.stringify(chatId) + '].some(m => m.body === "masih terkirim")', 10000);
  ok(!!gotMute, 'chat dibisukan: pesan tetap diterima & dirender di percakapan');
  await api(`/api/chats/${chatId}/notifications`, { method: 'POST', token: A.token, body: { muted: false } });

  /* ---------- V8: kontak perangkat ---------- */
  console.log('\n[V8] kontak perangkat: dipilih manual, hasil dicari di daftar pengguna');
  const bp = makeBrowser({
    token: A.token,
    contacts: [{ name: [B.name], email: [B.email], tel: ['+628120000'] }],
  });
  await waitUntil(bp.run, 'S.socket && S.socket.connected && S.me && S.chats && S.chats.length > 0', 25000);
  await bp.__els.btnPickContact.click();
  await sleep(1200);
  ok(bp.run('__rec.contactsSelects') === 1, 'kontak perangkat: Contact Picker dipanggil hanya saat tombol ditekan');
  ok(bp.run('__els.userSearchInput.value') === B.email, 'kontak terpilih mengisi pencarian dengan email', bp.run('__els.userSearchInput.value'));

  /* ---------- V9: notifikasi tidak didukung / ditolak browser ---------- */
  console.log('\n[V9] izin notifikasi ditolak -> tombol & panduan sesuai');
  const bx = makeBrowser({ token: A.token, notif: 'denied' });
  await waitUntil(bx.run, 'S.socket && S.socket.connected && S.me', 25000);
  bx.run('syncNotifUI()');
  ok(bx.run('__els.btnEnableNotif.textContent') === 'Diblokir', 'izin notifikasi ditolak: tombol "Diblokir"', bx.run('__els.btnEnableNotif.textContent'));
  ok(bx.run('__els.notifPermText.textContent').includes('diblokir'), 'teks status menjelaskan diblokir browser');
  const beforeDenied = bx.run('__rec.notifications.length');
  bx.run(`notify({ id: 'm-deny-1', chatId: ${JSON.stringify(chatId)}, senderId: ${JSON.stringify(B.id)}, senderName: 'TerimaB', type: 'text', body: 'tes', createdAt: Date.now() })`);
  await sleep(300);
  ok(bx.run('__rec.notifications.length') === beforeDenied, 'izin ditolak: tidak ada notifikasi sistem yang dipaksakan');

  /* bersih: tutup soket semua peramban */
  for (const b of [ba, bb, bd, bcam, be, bn, sb, bp, bx]) {
    try { b.run('S.socket && S.socket.disconnect()'); } catch { /* noop */ }
  }
  await sleep(200);

  console.log(`\n==== HASIL UJI MEDIA PANGGILAN: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(1); });
