/* Service Worker: notifikasi WhatsApp-style (online & offline) */
'use strict';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
