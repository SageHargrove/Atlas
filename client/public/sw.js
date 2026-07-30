/* Atlas service worker — makes the app installable and instant on reopen.

   HARD RULE: /api/ responses are never cached. They carry balances, transactions
   and account names; a cache entry would leave financial data sitting in the
   browser's storage long after sign-out. Only the public app shell (hashed JS/CSS
   bundles and icons) is stored, so a stale cache can never show stale money. */
const CACHE = "atlas-shell-v2";
const SHELL = ["/", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never touch financial data

  /* Navigations: network first so a deploy is picked up immediately; the cached
     shell is only a fallback for being offline. */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {}); return r; })
        .catch(() => caches.match("/").then((hit) => hit || Response.error()))
    );
    return;
  }

  /* Static assets: cache first. Vite fingerprints bundle filenames, so a new
     build requests new URLs and never reads an old entry. */
  const cacheable = url.pathname.startsWith("/assets/") || /\.(png|svg|webmanifest|ico)$/.test(url.pathname);
  if (!cacheable) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return r;
    }))
  );
});
