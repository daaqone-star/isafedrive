const CACHE_NAME = "isafedrive-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/js/util.js",
  "/js/sim.js",
  "/js/api.js",
  "/js/map.js",
  "/js/passenger.js",
  "/js/driver.js",
  "/js/admin.js",
  "/js/app.js",
  "/logo.png",
  "/manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (e.request.url.includes("/api/")) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
