/* Report a client-side exception to the server.

   A button that "does nothing" is almost always a handler that threw. The
   exception lands in a devtools console nobody has open, so the failure is
   invisible to the person it happened to AND to whoever has to fix it. This
   sends the message and stack, and nothing else: never page state, which holds
   balances and a resume. Best effort by design, and a failure to report must
   never itself become an error. */
export function report(where, e) {
  try {
    const body = JSON.stringify({
      where: String(where || "?").slice(0, 60),
      message: String(e?.message || e || "unknown").slice(0, 300),
      stack: String(e?.stack || "").slice(0, 1500),
    });
    fetch("/api/clientlog", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
      .catch(() => {});
  } catch { /* reporting must never throw */ }
}

/* Anything that escapes a handler entirely. Installed once at boot. */
export function installGlobalReporter() {
  if (typeof window === "undefined" || window.__atlasReporter) return;
  window.__atlasReporter = true;
  window.addEventListener("error", (ev) => report("window.onerror", ev?.error || { message: ev?.message }));
  window.addEventListener("unhandledrejection", (ev) => report("unhandledrejection", ev?.reason));
}

/* ---------------- stale client detection ----------------
   Vite fingerprints the main bundle, so the script this page is running names
   the build it came from. Ask the server which build it would serve now. If
   they differ, this tab is running old code, which is indistinguishable from
   "the feature is broken" unless somebody says so out loud.

   onStale is called with a reload function that clears every cache and
   unregisters the service worker first, because a plain reload is exactly what
   fails when a stale worker is the thing serving the old shell. */
export function watchForStaleBuild(onStale) {
  if (typeof document === "undefined") return;
  const mine = [...document.querySelectorAll('script[src*="/assets/index-"]')]
    .map((s) => s.src.split("/").pop())[0];
  if (!mine) return;
  const check = async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j.main && j.main !== mine) onStale(hardReload);
    } catch { /* offline is not stale */ }
  };
  check();
  /* and again when the tab comes back, which is when a deploy has usually
     happened since you last looked */
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

export async function hardReload() {
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* clearing is best effort; reload regardless */ }
  location.reload();
}
