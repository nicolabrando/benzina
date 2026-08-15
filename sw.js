/* sw.js — service worker.
 *
 * Strategia: "stale-while-revalidate" sui file dell'app.
 * La pagina si apre subito dalla cache (funziona offline e senza rete), e in
 * parallelo si controlla il server: se un file è cambiato, la copia nuova
 * finisce in cache e verrà usata alla prossima apertura.
 *
 * Nessuna richiesta di rete tocca mai i DATI: quelli stanno solo in
 * localStorage/IndexedDB e non passano da qui.
 *
 * Cambiando VERSION si forza la pulizia delle cache vecchie.
 */

const VERSION = 'v2';
const CACHE = 'benzina-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './compute.js',
  './store.js',
  './charts.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fallisce in blocco se un solo file manca: si aggiunge uno a uno
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      // navigazione offline senza copia in cache: si serve la pagina principale
      if (req.mode === 'navigate') {
        const idx = await cache.match('./index.html');
        if (idx) return idx;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
