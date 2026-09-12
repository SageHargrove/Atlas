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
