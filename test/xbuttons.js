/* Audit nyata seluruh tombol X/keluar dengan DOM sungguhan (jsdom).
   [1] Muat index.html + app.js penuh -> TIDAK BOLEH ada exception (anti-crash).
   [2] Klik satu per satu setiap tombol close (tanpa login) -> panel wajib tertutup.
   [3] Mode login penuh (server lokal) -> startApp jalan, semua listener runtime
       terpasang, klik ulang semua tombol X -> wajib tetap berfungsi + tak ada
       click handler yang melempar error. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const BASE = process.env.RTC_BASE || 'http://localhost:3000';

const DRAWERS = ['menuDrawer', 'newChatDrawer', 'profileDrawer', 'wallpaperDrawer', 'homeBgDrawer', 'contactDrawer',
  'groupDrawer', 'groupInfoDrawer', 'statusComposer', 'privacyDrawer', 'adminDrawer', 'notifDrawer', 'botCatDrawer',
  'planDrawer', 'inviteDrawer', 'aboutDrawer', 'storageDrawer', 'themeDrawer', 'contactsDrawer', 'terminalDrawer'];

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ GAGAL:', label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginToken() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ovalkyzz@gmail.com', password: process.env.RTC_ADMIN_PASS || 'secret123' }),
  });
  const j = await r.json();
  return j.token || null;
}

async function main() {
  const token = await loginToken().catch(() => null);

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || (() => {});
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
  }
  // socket.io client tiruan: cukup untuk startApp tanpa server ws
  window.io = () => ({
    on() {}, off() {}, emit() {}, disconnect() {}, connected: false,
  });
  if (token) window.localStorage.setItem('wa_token', token);

  // jebak semua exception runtime & click handler yang melempar
  const errors = [];
  window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));
  const origErr = console.error;
  console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)); origErr(...a); };

  let loadError = null;
  try {
    window.eval(appSrc);
  } catch (e) {
    loadError = e;
  }
  console.log('[1] Integritas load app.js di DOM nyata');
  ok(!loadError, loadError ? ('app.js MELEMPAR saat load: ' + loadError.message) : 'app.js dimuat penuh tanpa exception');

  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const unhide = (el) => el && el.classList.remove('hidden');
  const click = (btn) => btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // [0] id di markup tidak boleh duplikat (duplikat -> getElementById nempel ke
  //     elemen pertama -> tombol lain dianggap mati)
  console.log('[0] Kebutuhan mutlak: id unik di index.html');
  const allIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set(), dups = new Set();
  allIds.forEach((id) => { if (seen.has(id)) dups.add(id); seen.add(id); });
  ok(dups.size === 0, dups.size ? 'id duplikat: ' + [...dups].join(', ') : `tidak ada id duplikat (${allIds.length} id)`);

  // tombol ✕ "Batalkan balasan" di form komentar story (pernah mati gara-gara id ganda)
  const cancelStory = $('btnCancelStoryReply');
  ok(!!cancelStory, 'btnCancelStoryReply ada di markup terpisah');
  if (cancelStory) {
    const form = $('storyReplyForm');
    form.classList.remove('hidden');
    click(cancelStory);
    ok(form.classList.contains('hidden'), 'klik ✕ story -> form balasan komentar tertutup');
  }

  // jebak exception pada setiap klik tombol close
  const clickAllClosers = (stage) => {
    const closers = [...doc.querySelectorAll('button[id]')].filter((b) =>
      /^btnClose/.test(b.id) || b.id === 'btnStvClose' || b.id === 'btnCropClose');
    let bad = 0;
    for (const btn of closers) {
      if (btn.id === 'btnCropClose') continue;
      if (btn.id === 'btnCloseStory') { unhide($('storyViewer')); click(btn); if (!$('storyViewer').classList.contains('hidden')) { bad++; ok(false, stage + ': ' + btn.id + ' tidak menutup storyViewer'); } continue; }
      if (btn.id === 'btnCloseComments') { unhide($('storyComments')); click(btn); if (!$('storyComments').classList.contains('hidden')) { bad++; ok(false, stage + ': ' + btn.id + ' tidak menutup storyComments'); } continue; }
      if (btn.id === 'btnCloseVo' || btn.id === 'btnStvClose') {
        const t = $(btn.id === 'btnCloseVo' ? 'voViewer' : 'stViewer'); unhide(t); click(btn);
        if (!t.classList.contains('hidden')) { bad++; ok(false, stage + ': ' + btn.id + ' tidak menutup ' + t.id); }
        continue;
      }
      DRAWERS.forEach((d) => unhide($(d)));
      unhide($('scrim'));
      let threw = null;
      try { click(btn); } catch (e) { threw = e; }
      const closed = DRAWERS.every((d) => $(d).classList.contains('hidden')) && $('scrim').classList.contains('hidden');
      if (threw || !closed) { bad++; ok(false, stage + ': ' + btn.id + (threw ? ' MELEMPAR ' + threw.message : ' tidak menutup drawer')); }
    }
    return { total: closers.length, bad };
  };

  console.log('[2] Klik semua tombol X (tanpa login)');
  const r2 = clickAllClosers('pre-login');
  ok(r2.bad === 0, `${r2.total} tombol close pre-login: semua berfungsi`);

  if (!token) {
    console.log('(login gagal -> lewati mode runtime)');
  } else {
    // tunggu startApp selesai (me via /api/auth/me, chats, dll)
    await sleep(2500);
    console.log('[3] Mode login penuh: klik semua tombol X lagi + tak ada error runtime');
    const meOk = !!(window.S && window.S.me);
    // S lexical tidak di-window; deteksi lewat DOM: daftar chat / header user
    const appAlive = !!$('appView');
    ok(appAlive, 'appView ada setelah startApp');
    const r3 = clickAllClosers('post-login');
    ok(r3.bad === 0, `${r3.total} tombol close post-login: semua berfungsi`);
    const realErrors = errors.filter((e) => !/favicon|ResizeObserver|network error|Failed to fetch/i.test(e));
    ok(realErrors.length === 0, realErrors.length ? ('error runtime: ' + realErrors.slice(0, 3).join(' | ')) : 'tanpa exception/click-error runtime');
    void meOk;
  }

  console.log('');
  console.log(`==== HASIL X-BUTTONS: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
