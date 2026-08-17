/* Push alerts.

   The whole point of this file is to tell you something you would not otherwise
   have looked for: money landed, money is running low, a new subscription
   quietly started charging you. That only works if it stays quiet the rest of
   the time. A notification channel that cries wolf gets muted within a week and
   is then worth less than nothing, because you will also miss the real one.

   So three rules run through everything here:

     1. Every alert has a stable KEY and is sent at most once. Not once per sync,
        not once per day: once, ever.
     2. Turning alerts on does NOT fire a backlog. The first pass runs silently
        and records what already exists as "seen", so enabling notifications on
        an account with two years of history sends nothing.
     3. A threshold alert fires on the CROSSING, not on the state. Being below
        your low-balance line for a fortnight is one notification, not fourteen. */

import webpush from "web-push";

const PUB = process.env.VAPID_PUBLIC || "";
const PRIV = process.env.VAPID_PRIVATE || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:atlas@localhost";
export const pushReady = !!(PUB && PRIV);
if (pushReady) {
  try { webpush.setVapidDetails(SUBJECT, PUB, PRIV); }
  catch (e) { console.error("VAPID setup failed:", e.message); }
}
export const publicKey = () => PUB;

const SENT_CAP = 400;                  // bounded: this lives in the user's data file
const DEBT = ["Credit card", "Auto loan", "Student loan", "Mortgage", "Personal loan", "Other debt"];
const LIQUID = ["Checking", "Savings / HYSA"];
const money = (n) => "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
const monthOf = (d) => String(d || "").slice(0, 7);
const todayISO = () => new Date().toISOString().slice(0, 10);

export const defaultSettings = () => ({
  on: false,
  paid: true,          // income landed
  low: true, lowAt: 300,
  big: true, bigAt: 400,
  sub: true,           // a new recurring charge started
  budget: true,        // a category went over its limit
  bill: true, billDays: 3,
});

/* ---------------- rules ----------------
   Each returns zero or more { key, title, body, tag }. They are pure: they read
   the data file and decide, and never send anything themselves, so the same
   code can run in silent baseline mode. */

function ruleIncome(d, s) {
  if (!s.paid) return [];
  const out = [];
  /* only the last week, so a first run after a long gap cannot avalanche */
  const cutoff = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  for (const t of d.txns || []) {
    if (t.kind !== "in" || t.type === "transfer") continue;
    if ((t.date || "") < cutoff) continue;
    out.push({
      key: "paid:" + t.id,
      title: money(t.amount) + " landed",
      body: (t.note || "Income") + " on " + t.date,
      tag: "paid",
    });
  }
  return out;
}

function ruleBigCharge(d, s) {
  if (!s.big || !(s.bigAt > 0)) return [];
  const out = [];
  const cutoff = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  for (const t of d.txns || []) {
    if (t.kind !== "out" || t.type === "transfer") continue;
    if ((t.date || "") < cutoff) continue;
    if ((+t.amount || 0) < s.bigAt) continue;
    out.push({
      key: "big:" + t.id,
      title: "Large charge: " + money(t.amount),
      body: (t.note || "A charge") + " on " + t.date,
      tag: "big",
    });
  }
  return out;
}

/* Balance is a CROSSING, not a state. The key carries the crossing number, so
   dipping under, recovering, and dipping under again is two notifications while
   sitting under it for a month is one. */
function ruleLowBalance(d, s, mem) {
  if (!s.low || !(s.lowAt > 0)) return { alerts: [], mem };
  const liquid = (d.accounts || [])
    .filter((a) => LIQUID.includes(a.type))
    .reduce((sum, a) => sum + (+a.balance || 0), 0);
  const wasLow = !!mem.low;
  /* recover with a 10% buffer so hovering on the line cannot flap */
  const isLow = wasLow ? liquid < s.lowAt * 1.1 : liquid < s.lowAt;
  const n = mem.lowN || 0;
  if (isLow && !wasLow) {
    return {
      alerts: [{
        key: "low:" + (n + 1),
        title: "Running low: " + money(liquid),
        body: "Checking and savings are under your " + money(s.lowAt) + " line.",
        tag: "low",
      }],
      mem: { ...mem, low: true, lowN: n + 1 },
    };
  }
  return { alerts: [], mem: { ...mem, low: isLow } };
}

/* A new recurring charge is the one Rocket Money is genuinely useful for: the
   trial that started billing, the service you forgot. Detected as three or more
   charges to the same merchant, at a stable amount, roughly a month apart. */
const merchantKey = (note) => String(note || "").toLowerCase()
  .replace(/[#*\d]+/g, " ").replace(/[^a-z& ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 28);

function ruleNewSubscription(d, s) {
  if (!s.sub) return [];
  const by = {};
  for (const t of d.txns || []) {
    if (t.kind !== "out" || t.type === "transfer") continue;
    const k = merchantKey(t.note);
    if (k.length < 3) continue;
    (by[k] ||= []).push(t);
  }
  const out = [];
  for (const [k, list] of Object.entries(by)) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const amts = sorted.map((t) => +t.amount || 0);
    const avg = amts.reduce((a, b) => a + b, 0) / amts.length;
    if (avg <= 0) continue;
    /* stable amount: every charge within 15% of the average */
    if (!amts.every((a) => Math.abs(a - avg) <= avg * 0.15)) continue;
    /* roughly monthly: consecutive gaps of 24-38 days */
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(Math.round((Date.parse(sorted[i].date) - Date.parse(sorted[i - 1].date)) / 86400e3));
    }
    if (!gaps.length || !gaps.every((g) => g >= 24 && g <= 38)) continue;
    /* only flag it while it is genuinely NEW: the third charge is recent */
    const third = sorted[2];
    if (Date.now() - Date.parse(third.date) > 45 * 86400e3) continue;
    out.push({
      key: "sub:" + k,
      title: "New subscription: " + money(avg) + "/mo",
      body: (sorted[sorted.length - 1].note || k) + " has billed " + sorted.length + " months running.",
      tag: "sub",
    });
  }
  return out;
}

function ruleBudget(d, s) {
  if (!s.budget) return [];
  const m = monthOf(todayISO());
  const spent = {};
  for (const t of d.txns || []) {
    if (t.kind !== "out" || t.type === "transfer") continue;
    if (monthOf(t.date) !== m || !t.catId) continue;
    spent[t.catId] = (spent[t.catId] || 0) + (+t.amount || 0);
  }
  const out = [];
  for (const c of d.cats || []) {
    const lim = +c.limit || 0;
    if (lim <= 0) continue;
    const got = spent[c.id] || 0;
    if (got <= lim) continue;
    out.push({
      key: "budget:" + c.id + ":" + m,
      title: c.name + " is over budget",
      body: money(got) + " spent of a " + money(lim) + " limit this month.",
      tag: "budget",
    });
  }
  return out;
}

function ruleBillDue(d, s) {
  if (!s.bill) return [];
  const days = Math.max(1, Math.min(14, +s.billDays || 3));
  const now = new Date();
  const out = [];
  for (const r of d.recurring || []) {
    if (!r.watch || !(+r.amount > 0)) continue;
    const day = Math.max(1, Math.min(31, +r.day || 1));
    /* next occurrence of this day-of-month, clamped for short months */
    for (const addMonth of [0, 1]) {
      const y = now.getFullYear(), mo = now.getMonth() + addMonth;
      const last = new Date(y, mo + 1, 0).getDate();
      const due = new Date(y, mo, Math.min(day, last));
      const diff = Math.ceil((due - now) / 86400e3);
      if (diff < 0 || diff > days) continue;
      const iso = due.toISOString().slice(0, 10);
      out.push({
        key: "bill:" + r.id + ":" + iso,
        title: r.name + " due " + (diff <= 0 ? "today" : "in " + diff + " day" + (diff === 1 ? "" : "s")),
        body: money(r.amount) + " on " + iso,
        tag: "bill",
      });
      break;
    }
  }
  return out;
}

/* ---------------- evaluation ---------------- */

/* Returns { alerts, state } without mutating anything. `silent` is how enabling
   notifications avoids firing a backlog: same rules, results recorded as seen
   rather than sent. */
export function evaluate(d, { silent = false } = {}) {
  const a = d.alerts || {};
  const s = { ...defaultSettings(), ...(a.settings || {}) };
  const seen = new Set(a.sent || []);
  const memIn = a.mem || {};

  const lowRes = ruleLowBalance(d, s, memIn);
  const found = [
    ...ruleIncome(d, s),
    ...ruleBigCharge(d, s),
    ...lowRes.alerts,
    ...ruleNewSubscription(d, s),
    ...ruleBudget(d, s),
    ...ruleBillDue(d, s),
  ];

  const fresh = found.filter((x) => !seen.has(x.key));
  for (const x of fresh) seen.add(x.key);

  const state = {
    ...a,
    settings: s,
    mem: lowRes.mem,
    sent: [...seen].slice(-SENT_CAP),
    lastRun: new Date().toISOString(),
  };
  return { alerts: silent ? [] : fresh, state };
}

/* ---------------- delivery ----------------
   Returns the subscriptions that are permanently dead (404/410) so the caller
   can drop them. A phone that has uninstalled the app should not be retried
   forever. */
export async function send(subs, payload) {
  if (!pushReady || !subs?.length) return { sent: 0, dead: [] };
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 12 * 3600 },
      );
      sent++;
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) dead.push(sub.endpoint);
      else console.error("push failed:", code || e.message);
    }
  }));
  return { sent, dead };
}

/* Several alerts at once become ONE notification. Six separate buzzes for one
   sync is how people turn notifications off. */
export function bundle(alerts) {
  if (alerts.length === 1) {
    return { title: alerts[0].title, body: alerts[0].body, tag: alerts[0].tag };
  }
  return {
    title: alerts.length + " updates in Atlas",
    body: alerts.slice(0, 4).map((a) => a.title).join(" · ")
      + (alerts.length > 4 ? " and " + (alerts.length - 4) + " more" : ""),
    tag: "digest",
  };
}
