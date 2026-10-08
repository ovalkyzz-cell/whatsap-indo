/* Service Worker: notifikasi WhatsApp-style (online & offline) */
'use strict';

const CACHE = 'wa-static-v1';
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
    return { title: 'Whatsap Indo', body: event.data ? event.data.text() : '' };
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = data.title || 'Pesan baru';
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
      tag: data.tag || 'wa-message',
      renotify: true,
      data,
    };
    if (data.icon) options.icon = data.icon;
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
      target.postMessage({ type: 'wa-open-chat', chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
