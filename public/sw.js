// AquaCast service worker: lets the dashboard be installed on the home screen, opens the
// app shell when the network is flaky, and shows / handles risk-alert notifications.
// API calls (/api/*) are NEVER cached: monitoring data always comes live from the server.
const CACHE = 'aquacast-shell-v4';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/aquacast.css', '/css/aquacast-extra.css',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/icons.js', '/js/chart.js', '/js/alerts.js',
  '/js/pages/live.js', '/js/pages/forecast.js', '/js/pages/history.js', '/js/pages/alerts.js', '/js/pages/activities.js',
  '/js/pages/sensors.js', '/js/pages/evaluation.js', '/js/pages/users.js', '/js/pages/settings.js', '/js/pages/shared.js',
  '/img/aquacast-logo.webp', '/img/aquacast-logo.png', '/img/icons/icon-192.png', '/img/icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates appear immediately), cached copy only when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        const isShellPage = req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
        caches.open(CACHE).then((c) => c.put(isShellPage ? '/index.html' : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = (await caches.match(req, { ignoreSearch: req.mode === 'navigate' }))
        || (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? await caches.match('/index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

// Tapping an alert notification opens (or focuses) the dashboard on Live Status.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/#live';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'navigate', hash: new URL(target, self.location.origin).hash });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Instant risk alerts pushed by the server (Web Push). Arrives even when AquaCast is closed.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data?.text() }; }
  const critical = d.level === 'CRITICAL';
  event.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'AquaCast alert', {
      body: d.body || 'Open AquaCast for details.',
      tag: d.tag || 'aquacast-risk', renotify: true, requireInteraction: critical,
      icon: '/img/icons/icon-192.png', badge: '/img/icons/favicon-64.png',
      vibrate: critical ? [500, 200, 500, 200, 500, 200, 500] : [300, 150, 300],
      data: { url: d.url || '/#live' },
    });
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(1); } catch { /* unsupported */ }
    // an open dashboard refreshes at once (shows the alert screen and plays the alarm)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'refresh' }));
  })());
});

// The browser rotated the subscription: register the new one with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const key = event.oldSubscription?.options?.applicationServerKey;
      const sub = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!sub) return;
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-AquaCast-Client': 'dashboard' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch { /* re-registered next time the app opens */ }
  })());
});
