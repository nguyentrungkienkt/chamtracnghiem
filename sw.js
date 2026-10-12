// Lưu toàn bộ vỏ ứng dụng để mở được khi mất mạng. Mã nguồn mới được tải khi có mạng.
const CACHE = "chamtn-v1";
const SHELL = ["./", "./index.html", "./styles.css", "./manifest.webmanifest", "./icon.svg",
  "./app/app.js", "./app/db.js", "./lib/answer-key.js"];
const CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).then(() => c.add(CDN)).catch(() => c.addAll(SHELL))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && (new URL(e.request.url).origin === self.location.origin || e.request.url === CDN)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
