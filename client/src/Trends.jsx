/* ------------------------------------------------------------------
   Trends — spending over time, rather than spending this month.

   The Budget tab answers "what did I spend in July". It cannot answer
   "is July normal", which is the question that actually changes
   behaviour, and it's the one the app has never been able to answer.

   Two rules run through everything here, both learned the hard way when
   the budget recommender confidently priced rent at $19:

   1. Averages use COMPLETE months only. The current month is always a
      partial, and averaging it in drags every baseline down by however
      far through the month you happen to be.
   2. Transfers are not spending. Moving $500 from checking to savings
      is not a $500 expense, and counting it makes a good month look
      like a catastrophe.
------------------------------------------------------------------ */
import React, { useMemo, useState } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthKey = (d) => String(d || "").slice(0, 7);
const label = (k) => { const [y, m] = k.split("-"); return MONTHS[+m - 1] + " " + y.slice(2); };
const longLabel = (k) => { const [y, m] = k.split("-"); return MONTHS[+m - 1] + " " + y; };
const money = (n) => (n == null || !isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString());
const signed = (n) => (n >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString();

/* A spend row is an outflow that isn't a transfer. Everything in this file
   agrees on that definition; disagreeing on it between two panels is how a
   dashboard starts contradicting itself. */
const isSpend = (t) => t.kind === "out";

export default function Trends({ d }) {
  const [mode, setMode] = useState("month");   // month | year
  const [openCat, setOpenCat] = useState("");

  const catName = (id) => d.cats.find((c) => c.id === id)?.name || "Uncategorized";
  const thisMonth = monthKey(new Date().toISOString());

  const model = useMemo(() => {
    const spend = (d.txns || []).filter((t) => isSpend(t) && t.date);
    if (!spend.length) return null;

    /* A month Atlas has NO data for is not a month you spent nothing in, and
       conflating the two is how a baseline collapses: fill a year of empty
       months between an old straggler transaction and today, average them in,
       and "your typical month" becomes $0. Observed = the month contains at
       least one transaction of any kind, so a real no-spend month (income and
       transfers only) still counts while a data gap doesn't. */
    const observed = new Set((d.txns || []).map((t) => monthKey(t.date)).filter(Boolean));

    /* Bucket by month, and by category within each month. */
    const byMonth = new Map();
    for (const t of spend) {
      const k = monthKey(t.date);
      if (!k) continue;
      let m = byMonth.get(k);
      if (!m) { m = { key: k, total: 0, n: 0, cats: new Map() }; byMonth.set(k, m); }
      const amt = Math.abs(Number(t.amount) || 0);
      m.total += amt; m.n++;
      const c = t.catId || "";
      m.cats.set(c, (m.cats.get(c) || 0) + amt);
    }

    const keys = [...byMonth.keys()].sort();
    /* Fill gaps so a month with no spending reads as a zero bar rather than
       vanishing — an absent month silently compresses the x-axis and makes
       the series look continuous when it isn't. */
    const filled = [];
    if (keys.length) {
      let [y, m] = keys[0].split("-").map(Number);
      const [ey, em] = keys[keys.length - 1].split("-").map(Number);
      while (y < ey || (y === ey && m <= em)) {
        const k = y + "-" + String(m).padStart(2, "0");
        filled.push(byMonth.get(k) || { key: k, total: 0, n: 0, cats: new Map(), gap: !observed.has(k) });
        m++; if (m > 12) { m = 1; y++; }
      }
    }

    /* Trailing 12 observed, finished months. Trailing because a baseline built
       from three-year-old spending describes someone else's life. */
    const complete = filled.filter((m) => m.key !== thisMonth && !m.gap).slice(-12);
    const avg = complete.length ? complete.reduce((s, m) => s + m.total, 0) / complete.length : null;
    const sorted = complete.map((m) => m.total).sort((a, b) => a - b);
    const median = sorted.length
      ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      : null;

    /* Per-category: current month against the baseline of complete months. */
    const allCatIds = new Set();
    filled.forEach((m) => m.cats.forEach((_, c) => allCatIds.add(c)));
    const cur = byMonth.get(thisMonth);
    const catRows = [...allCatIds].map((id) => {
      const vals = complete.map((m) => m.cats.get(id) || 0);
      const base = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      const now = cur ? (cur.cats.get(id) || 0) : 0;
      return { id, name: id ? catName(id) : "Uncategorized", now, base,
        delta: base == null ? null : now - base,
        series: filled.map((m) => ({ key: m.key, v: m.cats.get(id) || 0 })) };
    }).filter((r) => r.now > 0 || (r.base || 0) > 0)
      .sort((a, b) => (b.base ?? b.now) - (a.base ?? a.now));

    /* Year over year, only where the same calendar month exists in two years. */
    const byYear = new Map();
    filled.forEach((m) => {
      const [y, mm] = m.key.split("-");
      if (!byYear.has(y)) byYear.set(y, new Map());
      /* null, not 0 — otherwise a month the bank never covered reads as "you
         spent nothing that August" and generates a confident change figure
         against it. Same trap as the monthly baseline, one table over. */
      byYear.get(y).set(mm, m.gap ? null : m.total);
    });
    const years = [...byYear.keys()].sort();
    const yoy = years.length >= 2
      ? MONTHS.map((nm, i) => {
          const mm = String(i + 1).padStart(2, "0");
          return { month: nm, vals: years.map((y) => ({ year: y, v: byYear.get(y).get(mm) ?? null })) };
        }).filter((r) => r.vals.filter((v) => v.v != null).length >= 2)
      : [];

    return { months: filled, complete, avg, median, cur, catRows, years, yoy,
      first: keys[0], last: keys[keys.length - 1] };
  }, [d.txns, d.cats, thisMonth]);

  /* No card and no heading of its own: the caller wraps this in a fold that
     supplies both. Rendering them here too showed the title twice. */
  if (!model) return <div className="note">Nothing to compare yet — this fills in once there are expenses recorded.</div>;

  const { months, complete, avg, median, cur, catRows, years, yoy } = model;
  const shown = months.slice(-14);
  const peak = Math.max(...shown.map((m) => m.total), 1);
  const curTotal = cur ? cur.total : 0;
  /* Compare against the number actually shown as "typical". Showing the median
     and differencing the mean is a small inconsistency that makes the two tiles
     silently disagree — the kind of thing that quietly destroys trust in a
     dashboard, because the reader can't tell which number is lying. */
  const typical = median ?? avg;
  const vsAvg = typical != null ? curTotal - typical : null;

  /* One partial month and nothing to compare it against is not a trend. Say so
     rather than drawing a chart of a single bar and implying otherwise. */
  const thin = complete.length < 2;

  return (
    <>
      <div className="mrow" style={{ margin: "0 0 6px", justifyContent: "flex-start" }}>
        <select className="in" style={{ width: 152 }} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="month">Month by month</option>
          <option value="year">Year over year</option>
        </select>
      </div>

      {thin && (
        <div className="note">
          Only {complete.length} complete month{complete.length === 1 ? "" : "s"} of history so far, so these
          comparisons are thin. <b>Backfill history</b> on the Accounts tab asks your banks for everything they still hold.
        </div>
      )}

      {mode === "month" ? (
        <>
          {/* Hero: the one number that answers "is this month normal" */}
          <div className="trow">
            {/* On the 1st or 2nd of a month "so far: $0" against "typical:
                $2,705" reads as a catastrophic drop rather than as "the month
                just started". Say the day count instead of a scary delta. */}
            <Stat label={longLabel(thisMonth) + (curTotal ? " so far" : "")}
              value={curTotal ? money(curTotal) : "—"}
              sub={curTotal ? "" : "nothing recorded yet this month"} />
            <Stat label={"Typical month" + (complete.length ? " (" + complete.length + " complete)" : "")}
              value={money(median ?? avg)} sub={avg != null && median != null && Math.abs(avg - median) > 1 ? "avg " + money(avg) : ""} />
            <Stat label="Against typical"
              value={!curTotal || vsAvg == null ? "—" : signed(vsAvg)}
              tone={!curTotal || vsAvg == null ? null : vsAvg > 0 ? "down" : "up"}
              sub={!curTotal ? "too early to compare" : vsAvg == null ? "" : vsAvg > 0 ? "more than usual" : "less than usual"} />
          </div>

          {/* Single series, so one hue and no legend — the heading names it. */}
          <div className="tlabel">Total spending by month</div>
          <div className="bars" role="img" aria-label={"Monthly spending from " + longLabel(shown[0].key) + " to " + longLabel(shown[shown.length - 1].key)}>
            {shown.map((m) => {
              const partial = m.key === thisMonth;
              /* A gap draws as an empty slot, never as a zero bar — a zero bar
                 asserts "you spent nothing", which Atlas has no basis to claim. */
              return (
                <div className="bcol" key={m.key}
                  title={m.gap ? longLabel(m.key) + " — no data (your banks didn't go back this far)"
                    : longLabel(m.key) + " — " + money(m.total) + (partial ? " (still in progress)" : "") + " · " + m.n + " transactions"}>
                  <div className="bval">{m.gap ? "" : m.total ? money(m.total) : ""}</div>
                  <div className="btrack">
                    {m.gap
                      ? <div className="bgap" />
                      : <div className={"bfill" + (partial ? " partial" : "")}
                          style={{ height: Math.max(m.total > 0 ? 3 : 0, Math.round((m.total / peak) * 100)) + "%" }} />}
                  </div>
                  <div className="blab" style={m.gap ? { color: "var(--line2)" } : null}>{label(m.key)}</div>
                </div>
              );
            })}
          </div>
          <div className="note" style={{ marginTop: 2 }}>
            The striped bar is the month you're in — it isn't finished, so it's excluded from every average here.
            {shown.some((m) => m.gap) && " Dotted slots are months your banks had no data for; they're left out too, rather than counted as $0."}
          </div>

          {/* Per category. Direction is stated in words as well as colour. */}
          <div className="tlabel" style={{ marginTop: 16 }}>By category — this month against your typical month</div>
          <div className="ttable">
            <div className="tth"><span>Category</span><span>This month</span><span>Typical</span><span>Difference</span></div>
            {catRows.map((r) => (
              <React.Fragment key={r.id || "none"}>
                <div className="ttr" onClick={() => setOpenCat(openCat === r.id ? "" : r.id)}>
                  <span className="tname">{openCat === r.id ? "▾" : "▸"} {r.name}</span>
                  <span className="mono">{money(r.now)}</span>
                  <span className="mono" style={{ color: "var(--faint)" }}>{r.base == null ? "—" : money(r.base)}</span>
                  <span className="mono" style={{ color: r.delta == null ? "var(--faint)" : Math.abs(r.delta) < 1 ? "var(--faint)" : r.delta > 0 ? "var(--down)" : "var(--up)" }}>
                    {r.delta == null ? "—" : Math.abs(r.delta) < 1 ? "level" : signed(r.delta)}
                  </span>
                </div>
                {openCat === r.id && (
                  <div className="ttx">
                    <Spark series={r.series.slice(-14)} current={thisMonth} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </>
      ) : yoy.length ? (
        <>
          <div className="tlabel">Same month, different years</div>
          <div className="ttable">
            <div className="tth" style={{ gridTemplateColumns: "1.2fr repeat(" + years.length + ", 1fr) 1fr" }}>
              <span>Month</span>{years.map((y) => <span key={y}>{y}</span>)}<span>Change</span>
            </div>
            {yoy.map((r) => {
              const vals = r.vals.map((v) => v.v);
              const firstV = vals.find((v) => v != null);
              const lastV = [...vals].reverse().find((v) => v != null);
              const delta = firstV != null && lastV != null && firstV !== lastV ? lastV - firstV : null;
              return (
                <div className="ttr" key={r.month} style={{ gridTemplateColumns: "1.2fr repeat(" + years.length + ", 1fr) 1fr", cursor: "default" }}>
                  <span className="tname">{r.month}</span>
                  {r.vals.map((v) => <span className="mono" key={v.year}>{v.v == null ? "—" : money(v.v)}</span>)}
                  <span className="mono" style={{ color: delta == null ? "var(--faint)" : delta > 0 ? "var(--down)" : "var(--up)" }}>
                    {delta == null ? "—" : signed(delta)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="note">
          Year over year needs the same calendar month in two different years. Atlas has {longLabel(model.first)} to {longLabel(model.last)} —
          come back once there's a full year, or use <b>Backfill history</b> on the Accounts tab to reach further back.
        </div>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="tstat">
      <div className="tstatl">{label}</div>
      <div className="tstatv" style={tone ? { color: "var(--" + tone + ")" } : null}>{value}</div>
      {sub ? <div className="tstats">{sub}</div> : null}
    </div>
  );
}

/* A sparkline, not a second full chart — it exists to show shape, and a shape
   with axis furniture around it is just a small bad chart. */
function Spark({ series, current }) {
  const peak = Math.max(...series.map((s) => s.v), 1);
  return (
    <div className="spark">
      {series.map((s) => (
        <div className="scol" key={s.key} title={longLabel(s.key) + " — " + money(s.v)}>
          <div className="strack">
            <div className={"sfill" + (s.key === current ? " partial" : "")}
              style={{ height: Math.max(s.v > 0 ? 4 : 0, Math.round((s.v / peak) * 100)) + "%" }} />
          </div>
          <div className="slab">{label(s.key).split(" ")[0]}</div>
        </div>
      ))}
    </div>
  );
}
