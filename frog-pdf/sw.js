// Frog PDF service worker: precache the app shell, cache-first for everything else (cmaps load on demand).
var CACHE = 'frogpdf-v1';
var CORE = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon-180.png', 'icons/frog.svg', 'icons/icon-192.png',
  'vendor/standard_fonts/FoxitDingbats.pfb',
  'vendor/standard_fonts/FoxitFixedBoldItalic.pfb',
  'vendor/standard_fonts/FoxitFixedBold.pfb',
  'vendor/standard_fonts/FoxitFixedItalic.pfb',
  'vendor/standard_fonts/FoxitFixed.pfb',
  'vendor/standard_fonts/FoxitSansBoldItalic.pfb',
  'vendor/standard_fonts/FoxitSansBold.pfb',
  'vendor/standard_fonts/FoxitSansItalic.pfb',
  'vendor/standard_fonts/FoxitSans.pfb',
  'vendor/standard_fonts/FoxitSerifBoldItalic.pfb',
  'vendor/standard_fonts/FoxitSerifBold.pfb',
  'vendor/standard_fonts/FoxitSerifItalic.pfb',
  'vendor/standard_fonts/FoxitSerif.pfb',
  'vendor/standard_fonts/FoxitSymbol.pfb',
  'vendor/standard_fonts/LiberationSans-BoldItalic.ttf',
  'vendor/standard_fonts/LiberationSans-Bold.ttf',
  'vendor/standard_fonts/LiberationSans-Italic.ttf',
  'vendor/standard_fonts/LiberationSans-Regular.ttf',
  'vendor/standard_fonts/LICENSE_FOXIT',
  'vendor/standard_fonts/LICENSE_LIBERATION',
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || e.request.url.indexOf(self.location.origin) !== 0) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(e.request).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
      return res;
    });
  }));
});
