/* Service Worker: notifikasi WhatsApp-style (online & offline) */
'use strict';

const CACHE = 'rtc-core-v14';
const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
      } catch { /* URL opsional, lanjut */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Cache hanya aset statis milik aplikasi (jaringan dulu, fallback cache saat offline).
   /api, /uploads, dan socket.io sengaja tidak pernah di-cache supaya data tetap segar. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads')
    || url.pathname.startsWith('/socket.io')) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await caches.match('/index.html')) || (await caches.match('/'));
        if (shell) return shell;
      }
      return new Response('Tidak ada koneksi internet', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});


function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return { title: 'RTC-Core', body: event.data ? event.data.text() : '' };
  }
}

/* Preferensi pengguna disimpan klien di IndexedDB (localStorage tidak ada di
   service worker) — dipakai saat notifikasi dibuat tanpa ada jendela terbuka. */
function getSWPref(key, def) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('rtc-prefs', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('kv'); };
      open.onsuccess = () => {
        const dbx = open.result;
        try {
          const req = dbx.transaction('kv', 'readonly').objectStore('kv').get(key);
          req.onsuccess = () => { resolve(req.result === undefined ? def : req.result); try { dbx.close(); } catch { /* noop */ } };
          req.onerror = () => { resolve(def); try { dbx.close(); } catch { /* noop */ } };
        } catch { resolve(def); }
      };
      open.onerror = () => resolve(def);
    } catch { resolve(def); }
  });
}

// simpan preferensi klien agar notifikasi tanpa jendela tetap mengikutinya
function setSWPref(key, value) {
  try {
    const open = indexedDB.open('rtc-prefs', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('kv'); };
    open.onsuccess = () => {
      const dbx = open.result;
      try {
        dbx.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
      } catch { /* noop */ }
      try { dbx.close(); } catch { /* noop */ }
    };
  } catch { /* IndexedDB tidak tersedia */ }
}

// lencana aplikasi (angka/ titik pada ikon) — jumlah belum dibaca bila diketahui
function setBadgeCount(n) {
  try {
    if (!self.navigator || typeof self.navigator.setAppBadge !== 'function') return;
    const p = (typeof n === 'number' && n > 0) ? self.navigator.setAppBadge(n) : self.navigator.setAppBadge();
    if (p && p.catch) p.catch(() => {});
  } catch { /* badge tidak didukung */ }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const isCall = data.type === 'call';
  const title = data.title || (isCall ? 'Panggilan masuk' : 'Pesan baru');
  event.waitUntil((async () => {
    // ada jendela yang sedang tampil -> teruskan ke halaman (banner melayang, tanpa dobel)
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.find((c) => c.visibilityState === 'visible');
    if (visible) {
      visible.postMessage({ type: 'wa-push', data });
      for (const c of windows) if (c !== visible) c.postMessage({ type: 'wa-push', data });
      return;
    }
    // tidak ada jendela aktif (aplikasi ditutup / tab disembunyikan) -> notifikasi sistem
    const options = {
      body: data.body || '',
      tag: data.tag || (isCall ? 'wa-call' : 'wa-message'),
      renotify: true,
      data,
    };
    if (data.icon) options.icon = data.icon;
    // getar mengikuti pengaturan "Getar" pengguna (disimpan di IndexedDB)
    const vibrate = await getSWPref('vibrate', true);
    if (vibrate) options.vibrate = isCall ? [400, 200, 400, 200, 400] : [200, 100, 200];
    // panggilan: notifikasi menempel sampai disentuh (apa pun status daringnya)
    if (isCall) options.requireInteraction = true;
    // lencana ikon aplikasi: pesan baru tanpa jendela -> tandai ada yang belum dibaca
    if (!isCall) setBadgeCount(typeof data.badge === 'number' ? data.badge : undefined);
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const chatId = data.chatId || '';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find((c) => 'focus' in c);
    if (target) {
      await target.focus();
      target.postMessage({ type: 'wa-open-chat', chatId, data });
      return;
    }
    await clients.openWindow(chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') { self.skipWaiting(); return; }
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'wa-badge') setBadgeCount(Number(event.data.n) || 0);
  if (event.data.type === 'wa-pref' && event.data.key) setSWPref(event.data.key, event.data.value);
});
