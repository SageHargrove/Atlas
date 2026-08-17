import React, { useEffect, useState } from "react";

/* Phone alerts.

   The value of this panel is entirely in what it does NOT send. Every toggle
   here is a promise that Atlas will interrupt you for that and nothing else, so
   the copy states plainly when each one fires and the server sends each alert
   once, ever, rather than once per sync. */

const b64ToU8 = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

const ROWS = [
  ["paid", "Money landed", "When income posts to an account."],
  ["low", "Running low", "When checking plus savings drops under your line."],
  ["big", "Large charge", "A single charge over your threshold."],
  ["sub", "New subscription", "A charge that has quietly billed three months running at the same amount."],
  ["budget", "Over budget", "The first time a category passes its limit in a month."],
  ["bill", "Bill coming due", "A watched recurring bill, a few days ahead."],
];

export default function Alerts({ toast }) {
  const [info, setInfo] = useState(null);
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const supported = typeof window !== "undefined"
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const load = async () => {
    try {
      const j = await fetch("/api/push/key").then((r) => r.json());
      setInfo(j);
      if (supported) {
        const reg = await navigator.serviceWorker.ready;
        setSub(await reg.pushManager.getSubscription());
      }
    } catch { setErr("Couldn't load alert settings"); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const enable = async () => {
    setBusy("on");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error(
        perm === "denied"
          ? "Notifications are blocked for this site. Turn them back on in your browser's site settings, then try again."
          : "Permission wasn't granted.");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const s = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToU8(info.key),
      });
      const r = await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub: s.toJSON() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not register this device");
      setSub(s);
      await load();
      toast("Alerts on for this device. Nothing from your history will be re-sent.");
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  const disable = async () => {
    setBusy("off");
    try {
      const endpoint = sub?.endpoint;
      if (sub) await sub.unsubscribe().catch(() => {});
      await fetch("/api/push/unsubscribe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }),
      });
      setSub(null);
      await load();
      toast("Alerts off for this device.");
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  const save = async (patch) => {
    const next = { ...info.settings, ...patch };
    setInfo((p) => ({ ...p, settings: next }));   // optimistic, so a toggle feels instant
    try {
      const r = await fetch("/api/push/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: patch }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "save failed");
      setInfo((p) => ({ ...p, settings: j.settings }));
    } catch (e) { toast(e.message, "err"); load(); }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await fetch("/api/push/test", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "test failed");
      toast(j.sent ? "Sent to " + j.sent + " device" + (j.sent === 1 ? "" : "s") + "." : "No device accepted it.");
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!info) return <div className="note">Loading…</div>;

  if (!info.ready) return (
    <div className="note">
      Push isn't configured on this server. Generate a VAPID key pair and set
      <code> VAPID_PUBLIC</code>, <code>VAPID_PRIVATE</code> and <code>VAPID_SUBJECT</code> in
      the server's <code>.env</code>, then restart:
      <pre className="pre" style={{ marginTop: 8 }}>npx web-push generate-vapid-keys</pre>
    </div>
  );

  if (!supported) return (
    <div className="note">
      This browser can't do push notifications. On iPhone they work only once the app is
      added to the home screen (Share, then Add to Home Screen), which is an Apple restriction
      rather than a limit here.
    </div>
  );

  const s = info.settings;
  const on = !!sub;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="note" style={{ margin: 0, flex: 1, minWidth: 240 }}>
          {on
            ? "This device will get alerts. Each one is sent once, ever, so nothing repeats every sync."
            : "Get a notification when money lands, a bill is coming, or something is off. Turning this on never replays your history."}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {on && <button className="btn small" disabled={!!busy} onClick={test}>
            {busy === "test" ? "Sending…" : "Send a test"}</button>}
          <button className={"btn small" + (on ? "" : " primary")} disabled={!!busy}
            onClick={on ? disable : enable}>
            {busy === "on" ? "Enabling…" : busy === "off" ? "Turning off…" : on ? "Turn off here" : "Turn on for this device"}
          </button>
        </div>
      </div>

      {info.devices > 1 && (
        <div className="note" style={{ fontSize: 12 }}>{info.devices} devices are subscribed.</div>
      )}

      <div className="sglist" style={{ marginTop: 12, opacity: on ? 1 : 0.55 }}>
        {ROWS.map(([k, label, why]) => (
          <div key={k} className="sgrow">
            <div style={{ minWidth: 0, flex: 1 }}>
              <b style={{ fontSize: 13.5 }}>{label}</b>
              <div className="note" style={{ margin: "2px 0 0", fontSize: 12 }}>{why}</div>
              {k === "low" && s.low && (
                <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
                  <span className="note" style={{ margin: 0, fontSize: 12 }}>Line</span>
                  <input className="in" type="number" min="0" style={{ width: 100 }} value={s.lowAt}
                    disabled={!on} onChange={(e) => save({ lowAt: Number(e.target.value) })} />
                </div>
              )}
              {k === "big" && s.big && (
                <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
                  <span className="note" style={{ margin: 0, fontSize: 12 }}>Over</span>
                  <input className="in" type="number" min="1" style={{ width: 100 }} value={s.bigAt}
                    disabled={!on} onChange={(e) => save({ bigAt: Number(e.target.value) })} />
                </div>
              )}
              {k === "bill" && s.bill && (
                <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
                  <span className="note" style={{ margin: 0, fontSize: 12 }}>Days ahead</span>
                  <input className="in" type="number" min="1" max="14" style={{ width: 80 }} value={s.billDays}
                    disabled={!on} onChange={(e) => save({ billDays: Number(e.target.value) })} />
                </div>
              )}
            </div>
            <button className={"btn small" + (s[k] ? " primary" : "")} disabled={!on}
              onClick={() => save({ [k]: !s[k] })}>{s[k] ? "On" : "Off"}</button>
          </div>
        ))}
      </div>

      <div className="note" style={{ fontSize: 11.5, marginTop: 10 }}>
        Notifications carry only the line of text you see, never balances or account names,
        because they can sit on a lock screen. Alerts are evaluated after each bank sync and
        once an hour for time-based ones like a bill coming due.
      </div>
    </div>
  );
}
