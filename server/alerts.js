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
  /* Income: a floor, because otherwise every $12 Venmo reads as "money landed".
     It is a crude filter and it will let the odd large transfer through, but it
     is the difference between a useful signal and a muted channel. */
  paid: true, paidAt: 150,
  /* Balance: tiers, not one line. The point is not "you are low" once, it is
     noticing again as it gets worse, so moving money over cannot be forgotten. */
  low: true, lowTiers: [300, 200, 100],
  big: true, bigAt: 400,
  sub: true,           // a new recurring charge started
  budget: true,        // OVERALL month spending vs the sum of your limits
  /* Bills: only the ones worth interrupting for. Big ones by size, and any
     bill of any size that your checking cannot currently cover. */
  bill: true, billDays: 3, billBig: 400,
});

const parseTiers = (v) => {
  const list = (Array.isArray(v) ? v : String(v || "").split(","))
    .map((x) => Math.round(Number(x) || 0))
    .filter((x) => x > 0);
  return [...new Set(list)].sort((a, b) => b - a).slice(0, 5);   // high to low
};

/* ---------------- rules ----------------
   Each returns zero or more { key, title, body, tag }. They are pure: they read
   the data file and decide, and never send anything themselves, so the same
   code can run in silent baseline mode. */

function ruleIncome(d, s) {
  if (!s.paid) return [];
  const floor = Math.max(0, +s.paidAt || 0);
  const out = [];
  /* only the last week, so a first run after a long gap cannot avalanche */
  const cutoff = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  for (const t of d.txns || []) {
    if (t.kind !== "in" || t.type === "transfer") continue;
    if ((t.date || "") < cutoff) continue;
    /* a paycheck floor: small incoming money is a friend paying you back, and
       being told about it is what makes people turn notifications off */
    if ((+t.amount || 0) < floor) continue;
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

/* Balance is a CROSSING, not a state, and it is TIERED. One line tells you once
   that you are low and then goes quiet however far it falls, which is exactly
   when you most need telling again. Each tier fires on its own way down, and a
   tier only re-arms once you climb back above it with a buffer, so hovering on
   a line cannot flap.

   Falling past several tiers at once is still ONE notification, naming the
   lowest one crossed. Three buzzes for one bad afternoon is how this gets muted. */
function ruleLowBalance(d, s, mem) {
  const tiers = parseTiers(s.lowTiers ?? s.lowAt);   // lowAt: older saved settings
  if (!s.low || !tiers.length) return { alerts: [], mem };
  const liquid = (d.accounts || [])
    .filter((a) => LIQUID.includes(a.type))
    .reduce((sum, a) => sum + (+a.balance || 0), 0);

  const armed = { ...(mem.lowTiers || {}) };         // tier -> already alerted?
  const crossed = [];
  for (const tier of tiers) {
    const was = !!armed[tier];
    const isUnder = was ? liquid < tier * 1.1 : liquid < tier;
    if (isUnder && !was) crossed.push(tier);
    armed[tier] = isUnder;
  }
  const nextMem = { ...mem, lowTiers: armed };
  if (!crossed.length) return { alerts: [], mem: nextMem };

  const lowest = Math.min(...crossed);
  const n = (mem.lowN || 0) + 1;
  return {
    alerts: [{
      key: "low:" + lowest + ":" + n,
      title: "Running low: " + money(liquid),
      body: "Checking and savings are under " + money(lowest)
        + (lowest === Math.min(...tiers) ? ". That is your lowest line." : ". Move money over."),
      tag: "low",
    }],
    mem: { ...nextMem, lowN: n },
  };
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

/* OVERALL, not per category. Per-category alerts fire five or six times a month
   for normal spending, which is noise wearing the costume of a warning. Going
   over your total budget for the month is a single fact worth one interruption. */
function ruleBudget(d, s) {
  if (!s.budget) return [];
  const m = monthOf(todayISO());
  const total = (d.cats || []).reduce((sum, c) => sum + (+c.limit || 0), 0);
  if (total <= 0) return [];                        // no budget set means nothing to be over
  let spent = 0;
  for (const t of d.txns || []) {
    if (t.kind !== "out" || t.type === "transfer") continue;
    if (monthOf(t.date) !== m) continue;
    spent += +t.amount || 0;
  }
  if (spent <= total) return [];
  return [{
    key: "budget:total:" + m,
    title: "Over budget for the month",
    body: money(spent) + " spent against " + money(total) + " budgeted.",
    tag: "budget",
  }];
}

/* Two reasons to interrupt someone about a bill, and only two.

   It is BIG (rent), so it is worth planning around even when the money is there.
   Or you CANNOT COVER IT, at any size: an $80 charge against $60 in checking is
   the overdraft you actually wanted warning about, and telling you about an $80
   bill you can trivially pay is the noise that gets the channel muted.

   Coverage is checked against CHECKING, not checking plus savings, because the
   bill hits checking. Money sitting in savings is money you still have to move,
   which is the whole thing being warned about. */
function ruleBillDue(d, s) {
  if (!s.bill) return [];
  const days = Math.max(1, Math.min(14, +s.billDays || 3));
  const big = Math.max(0, +s.billBig || 0);
  const accts = d.accounts || [];
  const checkingAccts = accts.filter((a) => a.type === "Checking");
  /* fall back to all liquid if nothing is typed as Checking, otherwise a user
     who never set an account type would be told they can cover nothing */
  const src = checkingAccts.length ? checkingAccts : accts.filter((a) => LIQUID.includes(a.type));
  const checking = src.reduce((sum, a) => sum + (+a.balance || 0), 0);

  const now = new Date();
  const out = [];
  for (const r of d.recurring || []) {
    if (!r.watch || !(+r.amount > 0)) continue;
    const amt = +r.amount;
    const day = Math.max(1, Math.min(31, +r.day || 1));
    /* next occurrence of this day-of-month, clamped for short months */
    for (const addMonth of [0, 1]) {
      const y = now.getFullYear(), mo = now.getMonth() + addMonth;
      const last = new Date(y, mo + 1, 0).getDate();
      const due = new Date(y, mo, Math.min(day, last));
      const diff = Math.ceil((due - now) / 86400e3);
      if (diff < 0 || diff > days) continue;
      const short = src.length > 0 && checking < amt;
      if (!short && !(big > 0 && amt >= big)) break;   // due, but not worth a buzz
      const iso = due.toISOString().slice(0, 10);
      const when = diff <= 0 ? "today" : "in " + diff + " day" + (diff === 1 ? "" : "s");
      out.push({
        key: "bill:" + r.id + ":" + iso + (short ? ":short" : ""),
        title: short
          ? "Can't cover " + r.name + " (" + money(amt) + ")"
          : r.name + " due " + when,
        body: short
          ? "Due " + when + " and checking holds " + money(checking) + ". Move money over."
          : money(amt) + " on " + iso,
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
