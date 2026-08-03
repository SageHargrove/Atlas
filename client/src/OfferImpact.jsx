import React, { useState, useMemo } from "react";
import { offerValue } from "./careerData.js";

/* ------------------------------------------------------------------
   What a specific offer does to your actual life.

   Every other tool stops at the number. Monarch can't model an offer
   because it doesn't know about jobs; Teal can't tell you what an offer
   changes because it doesn't know about your money. Atlas holds both,
   and this is the one thing that falls out of that which nothing else
   can do: take a real offer, run it through the budget you actually
   have, and re-date every goal you've actually set.

   Deliberately crude about tax and deliberately loud about it. A rough
   effective rate applied honestly beats a precise-looking figure built
   on assumptions the reader can't see — and the comparison between two
   offers barely moves with the tax model anyway, because both sides
   get the same treatment.
------------------------------------------------------------------ */

const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());
const money0 = (n) => (!isFinite(n) ? "—" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : "$" + Math.round(n / 1000) + "k");

/* Federal + FICA + a typical state bite, as one blended effective rate by
   income band. Not a tax engine — the Tax card is the tax engine. */
function takeHome(gross) {
  const g = Number(gross) || 0;
  if (g <= 0) return 0;
  const rate = g < 45000 ? 0.19 : g < 70000 ? 0.23 : g < 100000 ? 0.26 : g < 160000 ? 0.30 : g < 250000 ? 0.34 : 0.38;
  return g * (1 - rate);
}

export default function OfferImpact({ d, setD }) {
  const S = d.career?.settings || {};
  const cities = S.cities || [];
  const floor = S.floorOffer || null;

  const [o, setO] = useState({ company: "", base: "", bonusPct: 0, matchPct: 0, matchNeedsPct: 0, city: "", remote: false, ptoDays: 15 });
  const set = (k, v) => setO((p) => ({ ...p, [k]: v }));

  const m = useMemo(() => {
    const base = Number(o.base) || 0;
    if (!base) return null;
    const val = offerValue({ ...o, base });
    const col = o.remote ? (S.remoteCol || 90) : (cities.find((c) => c.name === o.city)?.col || 100);
    const adj = val.total ? Math.round(val.total / (col / 100)) : 0;

    const floorVal = floor ? offerValue(floor) : null;
    const floorCol = floor ? (floor.remote ? (S.remoteCol || 90) : (cities.find((c) => c.name === floor.city)?.col || 100)) : 100;
    const floorAdj = floorVal ? Math.round(floorVal.total / (floorCol / 100)) : 0;

    /* Monthly cash, then the budget you actually have. */
    const netMonth = takeHome(base + base * (Number(o.bonusPct) || 0) / 100) / 12;
    const spendMonth = (() => {
      /* median of complete months, same rule Trends uses */
      const by = new Map();
      const thisMonth = new Date().toISOString().slice(0, 7);
      for (const t of d.txns || []) {
        if (t.kind !== "out" || !t.date) continue;
        const k = t.date.slice(0, 7);
        if (k === thisMonth) continue;
        by.set(k, (by.get(k) || 0) + (Math.abs(Number(t.amount)) || 0));
      }
      const v = [...by.values()].sort((a, b) => a - b);
      if (!v.length) return 0;
      return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    })();
    /* Cost of living travels with you — the same basket costs more in a dearer city. */
    const spendThere = spendMonth * (col / 100);
    const surplus = netMonth - spendThere;

    /* Re-date every goal at that surplus. */
    const goals = (d.goals || []).map((g) => {
      const target = Number(g.target) || 0;
      const have = Number(g.saved) || 0;
      const need = Math.max(0, target - have);
      const nowRate = Number(g.monthly) || 0;
      const monthsNow = nowRate > 0 ? Math.ceil(need / nowRate) : null;
      /* assume the whole surplus goes at it, which is the upper bound and is
         labelled as such rather than presented as a plan */
      const monthsNew = surplus > 0 ? Math.ceil(need / surplus) : null;
      return { name: g.name, need, monthsNow, monthsNew };
    }).filter((g) => g.need > 0);

    return { val, adj, floorVal, floorAdj, netMonth, spendMonth, spendThere, surplus, goals, col };
  }, [o, d.txns, d.goals, cities, floor, S.remoteCol]);

  const cmp = m && m.floorAdj ? m.adj - m.floorAdj : null;

  return (
    <>
      <div className="note" style={{ marginTop: 0 }}>
        Put in a real offer and Atlas runs it through the budget you actually have — not a generic one — and re-dates the
        goals you've actually set. Nothing else can do this, because nothing else holds both halves.
      </div>

      <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 150px" }}>
          <label className="f">Company</label>
          <input className="in" value={o.company} placeholder="e.g. GuidePoint" onChange={(e) => set("company", e.target.value)} />
        </div>
        <div style={{ flex: "0 0 130px" }}>
          <label className="f">Base salary</label>
          <input className="in mono" type="number" value={o.base} placeholder="95000" onChange={(e) => set("base", e.target.value)} />
        </div>
        <div style={{ flex: "0 0 92px" }}>
          <label className="f">Bonus %</label>
          <input className="in mono" type="number" value={o.bonusPct} onChange={(e) => set("bonusPct", e.target.value)} />
        </div>
        <div style={{ flex: "0 0 100px" }}>
          <label className="f">401k match %</label>
          <input className="in mono" type="number" step="0.25" value={o.matchPct} onChange={(e) => set("matchPct", e.target.value)} />
        </div>
        <div style={{ flex: "1 1 140px" }}>
          <label className="f">City</label>
          <select className="in" value={o.remote ? "__remote" : o.city}
            onChange={(e) => { if (e.target.value === "__remote") { set("remote", true); } else { setO((p) => ({ ...p, remote: false, city: e.target.value })); } }}>
            <option value="">—</option>
            <option value="__remote">Remote</option>
            {cities.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {!m ? (
        <div className="note" style={{ marginTop: 10 }}>Enter a base salary to see what it changes.</div>
      ) : (
        <>
          <div className="glance" style={{ marginTop: 14 }}>
            <div className="gtile">
              <div className="gtl">Worth all in</div>
              <div className="gtv">{money0(m.val.total)}</div>
              <div className="gts">{money0(m.adj)} adjusted for {m.col}% cost of living</div>
            </div>
            <div className="gtile">
              <div className="gtl">vs your floor</div>
              <div className="gtv" style={{ color: cmp == null ? undefined : cmp > 0 ? "var(--up)" : "var(--down)" }}>
                {cmp == null ? "—" : (cmp > 0 ? "+" : "") + money(cmp)}
              </div>
              <div className="gts">{floor ? floor.company + " at " + money0(m.floorAdj) : "set a floor offer first"}</div>
            </div>
            <div className="gtile">
              <div className="gtl">Left over each month</div>
              <div className="gtv" style={{ color: m.surplus > 0 ? "var(--up)" : "var(--down)" }}>{money(m.surplus)}</div>
              <div className="gts">{money(m.netMonth)} take-home − {money(m.spendThere)} spending</div>
            </div>
            <div className="gtile">
              <div className="gtl">Savings rate there</div>
              <div className="gtv">{m.netMonth > 0 ? Math.round((m.surplus / m.netMonth) * 100) + "%" : "—"}</div>
              <div className="gts">at your current habits</div>
            </div>
          </div>

          {m.spendMonth > 0 && m.col !== 100 && (
            <div className="note" style={{ marginTop: 2 }}>
              Your spending travels with you: <b className="mono">{money(m.spendMonth)}</b> a month here becomes about{" "}
              <b className="mono">{money(m.spendThere)}</b> at {m.col}% cost of living. That is the part a salary comparison
              usually misses — {cmp != null && cmp > 0 && m.spendThere > m.spendMonth
                ? "the raise is real, but it buys less than the headline suggests."
                : "it can turn a bigger number into less money."}
            </div>
          )}

          {m.goals.length > 0 && (
            <>
              <div className="tlabel" style={{ marginTop: 14 }}>What it does to your goals</div>
              <div className="ttable">
                <div className="tth"><span>Goal</span><span>Still needs</span><span>At today's rate</span><span>On this offer</span></div>
                {m.goals.map((g) => (
                  <div className="ttr" key={g.name} style={{ cursor: "default" }}>
                    <span className="tname">{g.name}</span>
                    <span className="mono">{money(g.need)}</span>
                    <span className="mono" style={{ color: "var(--faint)" }}>{g.monthsNow ? g.monthsNow + " mo" : "—"}</span>
                    <span className="mono" style={{ color: g.monthsNew && g.monthsNow && g.monthsNew < g.monthsNow ? "var(--up)" : undefined }}>
                      {g.monthsNew ? g.monthsNew + " mo" : "never at this surplus"}
                      {g.monthsNew && g.monthsNow && g.monthsNew < g.monthsNow && <> · {g.monthsNow - g.monthsNew} sooner</>}
                    </span>
                  </div>
                ))}
              </div>
              <div className="note">
                The right-hand column assumes the <b>whole</b> surplus goes at each goal, so treat it as the ceiling rather
                than the plan — it's what the offer makes possible, not what will happen.
              </div>
            </>
          )}

          <div className="note" style={{ marginTop: 10 }}>
            Tax here is one blended effective rate by income band, not a real calculation — the Tax card does that properly.
            It's deliberately crude because the comparison between two offers barely moves with the tax model: both sides
            get the same treatment, so the difference survives.
            {cmp != null && (
              <> {cmp > 0
                ? <> On adjusted value this beats your floor by <b className="mono">{money(cmp)}</b>. Before saying yes, check the
                    things this doesn't price: whether the work is what you want to be doing in three years, and what it does to
                    the next offer after it.</>
                : <> On adjusted value this is <b className="mono">{money(-cmp)}</b> <b>behind</b> your floor. That can still be
                    the right move — for the work, the people, or the door it opens — but it should be a decision, not a surprise.</>}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
