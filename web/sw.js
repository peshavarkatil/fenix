// Keeps the app's own files (not your data) so it opens instantly and offline.
// Your data is stored separately, still scrambled, by the app itself.
const CACHE = "fenix-shell-v1";
const SHELL = ["./", "./index.html", "./app.js", "./charts.js", "./data.js", "./style.css", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  "./fonts/barlow-semi-condensed-latin-400-normal.woff2", "./fonts/barlow-semi-condensed-latin-500-normal.woff2",
  "./fonts/barlow-semi-condensed-latin-600-normal.woff2", "./fonts/barlow-semi-condensed-latin-700-normal.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.endsWith("/data.bin") || u.pathname.endsWith("/status.json")) return; // data: always straight to the network
  // Files of the app: show the saved copy at once, refresh it in the background.
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
