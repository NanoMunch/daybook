/*
 * Daybook service worker: keeps the app's own code on the phone so it works offline.
 * It only ever fetches Daybook's files from its own address. It never sees notes.
 * A new version waits until the person taps "Update available, tap to reload".
 */
'use strict';

var VERSION = '1.3.0';
var CACHE = 'daybook-code-' + VERSION;
var FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/db.js',
  'js/backup.js',
  'js/photos.js',
  'js/search.js',
  'js/lines.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache: 'reload' skips the browser's HTTP cache so every file matches this version.
      return cache.addAll(FILES.map(function (url) { return new Request(url, { cache: 'reload' }); }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      // Only old copies of Daybook's code are removed. Notes live in IndexedDB and are never touched here.
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('daybook-code-') === 0 && k !== CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match('index.html').then(function (hit) {
          return hit || fetch(req);
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || fetch(req);
      });
    })
  );
});
