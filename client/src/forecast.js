/* ------------------------------------------------------------------
   Day-level balance forecast.

   Answers the only cash question that is actually daily: "is it safe
   to spend $400 right now, or does rent on the 3rd take me under?"
   A monthly budget can't answer that — the whole problem is timing.

   Three ingredients, each from data Atlas already has:
     1. Scheduled bills — the recurring list, projected onto real dates.
     2. Scheduled income — recurring deposits detected from history
        (same payroll name arriving ~monthly or ~biweekly).
     3. Variable burn — what's left of a typical month's spending after
        the bills above are taken out, spread across the days.

   The bills already in the recurring list are subtracted from the burn,
   not counted twice — double-counting is this codebase's house demon.
------------------------------------------------------------------ */

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);

/* Recurring deposits, from history alone: same normalized payer, 2+ arrivals,
   with a roughly stable gap of ~7, ~14, ~15 or ~30 days. */
export function detectIncome(txns, today = new Date()) {
  const by = new Map();
  for (const t of txns || []) {
    if (t.kind !== "in" || !t.date) continue;
    const k = norm(t.note);
    if (!k) continue;
    (by.get(k) || by.set(k, []).get(k)).push(t);
  }
  const out = [];
  for (const [k, rows] of by) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push((Date.parse(rows[i].date) - Date.parse(rows[i - 1].date)) / DAY);
    const med = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const cadence = [7, 14, 15, 30, 31].find((c) => Math.abs(med - c) <= 3);
    if (!cadence) continue;
    const amts = rows.map((r) => Number(r.amount) || 0).sort((a, b) => a - b);
    const amount = amts[Math.floor(amts.length / 2)];
    const last = Date.parse(rows[rows.length - 1].date);
    /* stale sources don't get projected — a payroll that stopped two cycles ago
       is a job that ended, and projecting it forward is wishful thinking */
    if (Date.parse(iso(today)) - last > cadence * 2.5 * DAY) continue;
    out.push({ name: rows[rows.length - 1].note, key: k, amount, cadence: cadence >= 28 ? 30.44 : cadence, last });
  }
  return out;
}

/* Median TOTAL monthly outflow across complete months (all categories — timing
   doesn't care whether a dollar was essential), minus the recurring bills that
   get scheduled explicitly. What remains is the variable daily burn. */
export function dailyBurn(txns, recurring, today = new Date()) {
  const thisMonth = iso(today).slice(0, 7);
  const by = {};
  for (const t of txns || []) {
    if (t.kind !== "out" || !t.date) continue;
    const m = t.date.slice(0, 7);
    if (m === thisMonth) continue;
    by[m] = (by[m] || 0) + (Number(t.amount) || 0);
  }
  const v = Object.values(by).filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const medMonth = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const billTotal = (recurring || []).reduce((s, r) => s + (Number(r.amount) || 0) / (r.freq === "y" ? 12 : 1), 0);
  return Math.max(0, (medMonth - billTotal) / 30.44);
}

/* Walk forward `days` days. Returns one point per day plus the minimum. */
export function forecast({ startBalance, recurring = [], income = [], burn = 0, days = 60, today = new Date() }) {
  const t0 = Date.parse(iso(today));
  let bal = Number(startBalance) || 0;
  const points = [{ date: iso(t0), bal: Math.round(bal * 100) / 100, events: [] }];
  let min = { date: iso(t0), bal };
  for (let i = 1; i <= days; i++) {
    const ts = t0 + i * DAY;
    const d = new Date(ts);
    const events = [];
    for (const r of recurring) {
      const due = Number(r.day) || 1;
      const dom = d.getUTCDate();
      const hit = r.freq === "y"
        ? d.getUTCMonth() + 1 === (Number(r.month) || 1) && dom === due
        : dom === Math.min(due, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate());
      if (hit) { bal -= Number(r.amount) || 0; events.push({ name: r.name || "bill", amt: -(Number(r.amount) || 0) }); }
    }
    for (const inc of income) {
      const since = (ts - inc.last) / DAY;
      const phase = since / inc.cadence;
      /* a deposit lands each time we cross a whole multiple of its cadence */
      if (phase > 0.2 && Math.abs(phase - Math.round(phase)) * inc.cadence <= 0.5) {
        bal += inc.amount; events.push({ name: inc.name, amt: inc.amount });
      }
    }
    bal -= burn;
    points.push({ date: iso(ts), bal: Math.round(bal * 100) / 100, events });
    if (bal < min.bal) min = { date: iso(ts), bal };
  }
  const under = points.find((p) => p.bal < 0);
  return { points, min: { ...min, bal: Math.round(min.bal * 100) / 100 }, underDate: under ? under.date : null };
}
