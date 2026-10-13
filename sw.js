// Lưu vỏ ứng dụng để mở được khi mất mạng. Không lưu các lệnh gọi tới relay.
const CACHE = "quet-phieu-v4";
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./js/app.js", "./js/db.js", "./js/relay.js", "./js/corners.js", "./js/detect-worker.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
