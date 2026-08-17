/* Atlas service worker — makes the app installable and instant on reopen.

   HARD RULE: /api/ responses are never cached. They carry balances, transactions
   and account names; a cache entry would leave financial data sitting in the
   browser's storage long after sign-out. Only the public app shell (hashed JS/CSS
   bundles and icons) is stored, so a stale cache can never show stale money. */
const CACHE = "atlas-shell-v3";
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
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy).then(() => trim(c))).catch(() => {});
      }
      return r;
    }))
  );
});

/* ---------------- push ----------------
   The payload carries only what the notification shows: a title, a line of body
   text, and a tag. No balances, no transaction lists, no account names beyond
   what is already in the text you asked to be shown. A push payload is decrypted
   by the browser and can sit in the OS notification shade on a lock screen, so
   it gets the same treatment as the cache rule above: the minimum. */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Atlas", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Atlas";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    /* same tag replaces rather than stacks, so ten "over budget" alerts never
       become ten rows in the shade */
    tag: d.tag || "atlas",
    renotify: false,
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    /* focus an open tab rather than opening a second copy of the app */
    for (const c of all) {
      if (c.url.startsWith(self.location.origin) && "focus" in c) {
        if ("navigate" in c && c.url !== target) { try { await c.navigate(target); } catch { } }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

/* Every deploy ships new fingerprinted filenames, and this worker's own file
   rarely changes — so without pruning, the cache accumulates one dead bundle
   set per release forever. Keep the newest entries and drop the rest. */
const MAX_ENTRIES = 40;
async function trim(cache) {
  const keys = await cache.keys();
  const assets = keys.filter((k) => new URL(k.url).pathname.startsWith("/assets/"));
  if (assets.length <= MAX_ENTRIES) return;
  await Promise.all(assets.slice(0, assets.length - MAX_ENTRIES).map((k) => cache.delete(k)));
}
