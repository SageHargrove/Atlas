import React, { useState, useMemo } from "react";

/* ------------------------------------------------------------------
   "Can I retire at X" — worked backwards.

   Every other projector in Atlas runs forwards: here's what you save,
   here's what it becomes. This one runs the other way, because the
   question is never "what will I have", it's "what would it take".

   Two things it deliberately refuses to do. It won't quote a single
   confident number — the honest output is a required monthly
   contribution and whether that is a plausible share of your income.
   And it works in TODAY's dollars throughout: a $2.4M target forty
   years out sounds achievable in a way that "$62k a year of spending"
   does not, and the second one is the number you actually live on.
------------------------------------------------------------------ */

const money = (n) => (n == null || !isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString());
const money0 = (n) => (!isFinite(n) ? "—" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : "$" + Math.round(n / 1000) + "k");

/* Real (inflation-adjusted) growth, so every figure below is in today's money.
   Mixing nominal returns with today's spending is the single most common way a
   retirement calculator flatters the person using it. */
const realRate = (nominalPct, inflationPct) =>
  (1 + Number(nominalPct) / 100) / (1 + Number(inflationPct) / 100) - 1;

/* Future value of a lump sum plus a monthly contribution. */
function fv(start, monthly, years, r) {
  const m = Math.pow(1 + r, years);
  if (Math.abs(r) < 1e-9) return start + monthly * 12 * years;
  return start * m + monthly * 12 * ((m - 1) / r);
}

/* What monthly contribution gets you from `start` to `target` in `years`. */
function requiredMonthly(start, target, years, r) {
  if (years <= 0) return Infinity;
  const m = Math.pow(1 + r, years);
  if (Math.abs(r) < 1e-9) return Math.max(0, (target - start) / (years * 12));
  const need = target - start * m;
  if (need <= 0) return 0;
  return need / (12 * ((m - 1) / r));
}

export default function Retire({ d, invested, monthlySpendNow }) {
  const s = d.settings || {};
  const [age, setAge] = useState(Number(s.retAge) || 22);
  const [target, setTarget] = useState(Number(s.retTarget) || 45);
  const [spend, setSpend] = useState("");
  const [swr, setSwr] = useState(4);
  const [inflation, setInflation] = useState(3);
  const [kids, setKids] = useState(0);
  const [partner, setPartner] = useState(false);
  const [paidOff, setPaidOff] = useState(false);
  const [extra, setExtra] = useState("");

  const nominal = Number(s.expReturn) || 7;
  const r = realRate(nominal, inflation);
  const years = Math.max(0, target - age);

  const model = useMemo(() => {
    /* Base annual spending: what you actually spend today, unless overridden. */
    const baseMonthly = spend !== "" ? Number(spend) : (monthlySpendNow || 0);
    let annual = baseMonthly * 12;

    /* The adjustments people forget. Each is a multiplier on ANNUAL spending,
       stated plainly rather than buried, because the whole value here is being
       able to see what a life change costs. */
    const notes = [];
    if (partner) { annual *= 1.6; notes.push("A partner sharing costs adds roughly 60%, not 100% — housing and utilities don't double."); }
    if (kids > 0) {
      /* USDA's long-running estimate lands near $15-17k/yr per child for a
         middle-income family, tapering after they leave home; this uses a flat
         figure in today's dollars and says so. */
      const perKid = 16000;
      annual += kids * perKid;
      notes.push(kids + " child" + (kids === 1 ? "" : "ren") + " at about " + money(perKid) + "/yr each in today's dollars — and that stops roughly 18 years after each is born, which this does not model.");
    }
    if (paidOff) { annual *= 0.72; notes.push("No housing payment cuts about 28% — the largest single lever available to you."); }
    if (extra !== "" && Number(extra) > 0) { annual += Number(extra) * 12; notes.push("Plus " + money(Number(extra)) + "/mo you added."); }

    const nest = annual * (100 / Number(swr));
    const need = requiredMonthly(invested, nest, years, r);

    /* Whether that's realistic, expressed against income rather than as a verdict. */
    const income = Number(s.incomeMonthly) || 0;
    const share = income > 0 ? need / income : null;

    /* If you can't hit the age, what age COULD you hit at a plausible rate? */
    let reachable = null;
    if (income > 0) {
      const affordable = income * 0.4;   // a hard but real savings rate
      for (let y = 1; y <= 50; y++) {
        if (fv(invested, affordable, y, r) >= nest) { reachable = age + y; break; }
      }
    }

    return { annual, nest, need, share, notes, income, reachable, baseMonthly };
  }, [spend, monthlySpendNow, partner, kids, paidOff, extra, swr, invested, years, r, s.incomeMonthly, age]);

  const { annual, nest, need, share, notes, income, reachable, baseMonthly } = model;
  const verdictColor = share == null ? "var(--muted)" : share <= 0.25 ? "var(--up)" : share <= 0.5 ? "var(--gold)" : "var(--down)";

  return (
    <>
      <div className="row" style={{ gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 92px" }}>
          <label className="f">Your age now</label>
          <input className="in mono" type="number" value={age} onChange={(e) => setAge(Number(e.target.value) || 0)} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label className="f">Retire at <b className="mono" style={{ color: "var(--acc)" }}>{target}</b> — that's {years} years from now</label>
          <input className="rng" type="range" min={Math.max(age + 1, 25)} max={75} value={Math.max(target, age + 1)}
            onChange={(e) => setTarget(Number(e.target.value))} />
        </div>
      </div>

      <div className="glance" style={{ marginTop: 14 }}>
        <div className="gtile">
          <div className="gtl">You'd need</div>
          <div className="gtv">{money0(nest)}</div>
          <div className="gts">in today's dollars</div>
        </div>
        <div className="gtile">
          <div className="gtl">Saving each month</div>
          <div className="gtv" style={{ color: verdictColor }}>{need === Infinity ? "—" : money(need)}</div>
          <div className="gts">{share == null ? "set your income in Settings" : Math.round(share * 100) + "% of your take-home"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">To spend</div>
          <div className="gtv">{money(annual / 12)}<span style={{ fontSize: 12, fontWeight: 400 }}>/mo</span></div>
          <div className="gts">{money(annual)}/yr at a {swr}% withdrawal rate</div>
        </div>
        <div className="gtile">
          <div className="gtl">Invested today</div>
          <div className="gtv">{money0(invested)}</div>
          <div className="gts">growing at {nominal}% − {inflation}% inflation</div>
        </div>
      </div>

      {/* The honest verdict, which is usually "not at that age" for an aggressive
          target — paired with the age that IS reachable, so it's useful rather
          than just discouraging. */}
      <div className={"note " + (share != null && share > 0.5 ? "bad" : "")} style={{ marginTop: 4 }}>
        {share == null ? (
          <>Set your monthly take-home in Settings and Atlas can say whether this is realistic.</>
        ) : share <= 0.25 ? (
          <><b>That's realistic.</b> {Math.round(share * 100)}% of your take-home is a demanding but normal savings rate.</>
        ) : share <= 0.5 ? (
          <><b>Aggressive but possible.</b> {Math.round(share * 100)}% of take-home leaves little room — it works if your income rises and your spending doesn't.</>
        ) : (
          <>
            <b>Not at {target}, on today's income.</b> It would take {Math.round(share * 100)}% of your take-home.
            {reachable && <> Saving a hard-but-real 40% instead, the age you'd actually reach is <b className="mono">{reachable}</b>.</>}
          </>
        )}
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 150px" }}>
          <label className="f">Monthly spending to support</label>
          <input className="in mono" type="number" value={spend} placeholder={baseMonthly ? Math.round(baseMonthly) : "e.g. 3000"}
            onChange={(e) => setSpend(e.target.value)} />
          <div className="note">{monthlySpendNow ? "Yours today: " + money(monthlySpendNow) : "Log some months and this fills itself."}</div>
        </div>
        <div style={{ flex: "0 0 118px" }}>
          <label className="f">Withdrawal rate %</label>
          <select className="in" value={swr} onChange={(e) => setSwr(Number(e.target.value))}>
            {[3, 3.25, 3.5, 3.75, 4, 4.5].map((x) => <option key={x} value={x}>{x}%</option>)}
          </select>
        </div>
        <div style={{ flex: "0 0 110px" }}>
          <label className="f">Inflation %</label>
          <input className="in mono" type="number" step="0.5" value={inflation} onChange={(e) => setInflation(Number(e.target.value) || 0)} />
        </div>
        <div style={{ flex: "0 0 110px" }}>
          <label className="f">Kids to support</label>
          <select className="in" value={kids} onChange={(e) => setKids(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div style={{ flex: "1 1 140px" }}>
          <label className="f">Anything else ($/mo)</label>
          <input className="in mono" type="number" value={extra} placeholder="0" onChange={(e) => setExtra(e.target.value)} />
        </div>
      </div>

      <div className="row" style={{ gap: 16, marginTop: 10, flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 6, margin: 0, cursor: "pointer" }}>
          <input type="checkbox" checked={partner} onChange={(e) => setPartner(e.target.checked)} />
          <span className="note" style={{ margin: 0 }}>Supporting a partner too</span>
        </label>
        <label className="row" style={{ gap: 6, margin: 0, cursor: "pointer" }}>
          <input type="checkbox" checked={paidOff} onChange={(e) => setPaidOff(e.target.checked)} />
          <span className="note" style={{ margin: 0 }}>House paid off by then</span>
        </label>
      </div>

      {notes.length > 0 && (
        <div className="note" style={{ marginTop: 10 }}>
          {notes.map((n, i) => <div key={i}>· {n}</div>)}
        </div>
      )}

      <div className="note" style={{ marginTop: 10 }}>
        Every figure here is in <b>today's dollars</b> — the {nominal}% return is discounted by {inflation}% inflation, so
        "{money0(nest)}" means what {money0(nest)} buys now, not a bigger number decades out. The {swr}% withdrawal rate is
        the assumption doing the most work: it comes from studies of 30-year retirements, and a retirement starting at {target} is
        longer than that, which is why 3–3.5% is the usual advice for retiring early. This is arithmetic, not a forecast.
      </div>
    </>
  );
}
