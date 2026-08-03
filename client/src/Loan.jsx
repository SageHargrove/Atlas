import React, { useState, useMemo } from "react";

/* ------------------------------------------------------------------
   Manual loan tracking.

   A synced account reports its own balance. A manual one — a credit
   union auto loan that no aggregator can reach — does not, so its
   balance sits frozen at whatever you last typed while you go on
   paying it every month. Filing a payment under "Car / loan payment"
   records the expense; it has never touched the loan.

   This closes that gap by doing the arithmetic the lender does:
   interest accrues monthly on the outstanding balance, each payment
   pays that interest first and the remainder comes off principal.

   It does NOT silently overwrite your number. It shows what the maths
   says, what you have on file, and lets you accept the difference —
   because a balance that changes on its own without saying why is
   worse than one that is merely stale.
------------------------------------------------------------------ */

const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());
const money2 = (n) => (!isFinite(n) ? "—" : "$" + n.toFixed(2));

/* Walk the loan forward one month at a time. Returns the schedule so the caller
   can show a payoff date rather than just a count. */
export function amortize(balance, aprPct, payment, { extra = 0, lump = 0, maxMonths = 600 } = {}) {
  const r = Number(aprPct) / 100 / 12;
  let bal = Number(balance) - Number(lump || 0);
  const pay = Number(payment) + Number(extra || 0);
  let interest = 0, months = 0;
  if (bal <= 0) return { months: 0, interest: 0, impossible: false, paidOff: true };
  /* A payment that doesn't cover the first month's interest never retires the
     loan — say so instead of looping to the cap and reporting 600 months. */
  if (pay <= bal * r) return { months: Infinity, interest: Infinity, impossible: true, minToBeat: bal * r };
  while (bal > 0 && months < maxMonths) {
    const i = bal * r;
    interest += i;
    bal = bal + i - pay;
    months++;
    if (bal < 0) { interest += bal * 0; bal = 0; }
  }
  return { months, interest, impossible: false, paidOff: true };
}

/* What monthly payment clears the balance in exactly N months. */
function paymentFor(balance, aprPct, months) {
  const r = Number(aprPct) / 100 / 12;
  const b = Number(balance);
  if (months <= 0) return Infinity;
  if (Math.abs(r) < 1e-9) return b / months;
  return (b * r) / (1 - Math.pow(1 + r, -months));
}

export default function Loan({ d, setD }) {
  const debts = d.accounts.filter((a) => ["Auto loan", "Student loan", "Mortgage", "Other debt"].includes(a.type) && !a.tellerId);
  const [sel, setSel] = useState(debts[0]?.id || "");
  const [lump, setLump] = useState("");
  const [extra, setExtra] = useState("");
  const [goalMonths, setGoalMonths] = useState(12);

  const acc = debts.find((a) => a.id === sel) || debts[0];
  if (!acc) return <div className="note">No manually-tracked loans. Accounts your bank syncs report their own balance.</div>;

  const cat = d.cats.find((c) => c.id === acc.payCatId);
  /* Payments made since the balance was last confirmed. */
  const since = acc.balanceAsOf || "";
  const pays = useMemo(() => (d.txns || [])
    .filter((t) => t.kind === "out" && acc.payCatId && t.catId === acc.payCatId && (!since || t.date > since))
    .sort((a, b) => a.date.localeCompare(b.date)), [d.txns, acc.payCatId, since]);

  /* Roll the loan forward through those actual payments, month by month. */
  const derived = useMemo(() => {
    const r = Number(acc.rate) / 100 / 12;
    let bal = Number(acc.balance) || 0;
    let interest = 0;
    const byMonth = new Map();
    for (const p of pays) {
      const k = p.date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) || 0) + (Number(p.amount) || 0));
    }
    for (const [, amt] of [...byMonth.entries()].sort()) {
      const i = bal * r;
      interest += i;
      bal = Math.max(0, bal + i - amt);
    }
    return { bal, interest, months: byMonth.size, paid: [...byMonth.values()].reduce((s, x) => s + x, 0) };
  }, [pays, acc.balance, acc.rate]);

  const typical = pays.length ? derived.paid / Math.max(1, derived.months) : Number(acc.minPay) || 0;
  const base = amortize(derived.bal, acc.rate, typical);
  const withExtra = amortize(derived.bal, acc.rate, typical, { extra: Number(extra) || 0 });
  const withLump = amortize(derived.bal, acc.rate, typical, { lump: Number(lump) || 0 });
  const needFor = paymentFor(derived.bal, acc.rate, Number(goalMonths) || 1);
  const drift = (Number(acc.balance) || 0) - derived.bal;

  const setAcc = (patch) => setD((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === acc.id ? { ...a, ...patch } : a)) }));
  const monthsWord = (m) => (!isFinite(m) ? "never" : m >= 24 ? Math.floor(m / 12) + "y " + (m % 12) + "m" : m + " months");

  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {debts.length > 1 && (
          <div style={{ flex: "0 0 170px" }}>
            <label className="f">Loan</label>
            <select className="in" value={sel} onChange={(e) => setSel(e.target.value)}>
              {debts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ flex: "0 0 150px" }}>
          <label className="f">Balance on file</label>
          <input className="in mono" type="number" value={acc.balance}
            onChange={(e) => setAcc({ balance: Number(e.target.value) || 0 })} />
        </div>
        <div style={{ flex: "0 0 90px" }}>
          <label className="f">APR %</label>
          <input className="in mono" type="number" step="0.01" value={acc.rate || ""}
            onChange={(e) => setAcc({ rate: e.target.value })} />
        </div>
        <div style={{ flex: "1 1 180px" }}>
          <label className="f">Payments come from</label>
          <select className="in" value={acc.payCatId || ""} onChange={(e) => setAcc({ payCatId: e.target.value })}>
            <option value="">— pick the category —</option>
            {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {!acc.payCatId ? (
        <div className="note bad" style={{ marginTop: 10 }}>
          Pick the category your payments are filed under and Atlas can track this loan down —
          otherwise the balance above stays at whatever you last typed while you go on paying it.
        </div>
      ) : (
        <>
          <div className="glance" style={{ marginTop: 12 }}>
            <div className="gtile">
              <div className="gtl">Where it should be</div>
              <div className="gtv">{money(derived.bal)}</div>
              <div className="gts">after {derived.months} month{derived.months === 1 ? "" : "s"} of payments</div>
            </div>
            <div className="gtile">
              <div className="gtl">Interest so far</div>
              <div className="gtv" style={{ color: "var(--down)" }}>{money(derived.interest)}</div>
              <div className="gts">of {money(derived.paid)} paid in</div>
            </div>
            <div className="gtile">
              <div className="gtl">Gone in</div>
              <div className="gtv">{monthsWord(base.months)}</div>
              <div className="gts">at {money(typical)}/mo</div>
            </div>
            <div className="gtile">
              <div className="gtl">Interest left</div>
              <div className="gtv">{money(base.interest)}</div>
              <div className="gts">if nothing changes</div>
            </div>
          </div>

          {Math.abs(drift) >= 1 && (
            <div className="note" style={{ marginTop: 2 }}>
              The balance on file is <b className="mono">{money(Number(acc.balance))}</b>, but {derived.months} payment{derived.months === 1 ? "" : "s"} of{" "}
              <b className="mono">{money(derived.paid)}</b> against {acc.rate}% put it at <b className="mono">{money(derived.bal)}</b>.
              {" "}
              <button className="lnk" onClick={() => setAcc({ balance: Math.round(derived.bal * 100) / 100, balanceAsOf: new Date().toISOString().slice(0, 10) })}>
                Update it to {money(derived.bal)}
              </button>
              {" "}— then payments after today count from there. Check it against your lender before trusting it; they may
              apply payments on a different day of the month than this assumes.
            </div>
          )}

          {/* the two questions people actually ask about a loan */}
          <div className="row" style={{ gap: 12, marginTop: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 150px" }}>
              <label className="f">Pay extra each month</label>
              <input className="in mono" type="number" value={extra} placeholder="0" onChange={(e) => setExtra(e.target.value)} />
            </div>
            <div style={{ flex: "1 1 150px" }}>
              <label className="f">Or throw a lump sum at it</label>
              <input className="in mono" type="number" value={lump} placeholder="0" onChange={(e) => setLump(e.target.value)} />
            </div>
            <div style={{ flex: "1 1 150px" }}>
              <label className="f">Or be rid of it in</label>
              <select className="in" value={goalMonths} onChange={(e) => setGoalMonths(Number(e.target.value))}>
                {[6, 12, 18, 24, 36, 48].map((m) => <option key={m} value={m}>{m} months</option>)}
              </select>
            </div>
          </div>

          <div className="ttable" style={{ marginTop: 10 }}>
            <div className="tth"><span>Approach</span><span>Paid off in</span><span>Interest</span><span>You save</span></div>
            <div className="ttr" style={{ cursor: "default" }}>
              <span className="tname">Carry on at {money(typical)}/mo</span>
              <span className="mono">{monthsWord(base.months)}</span>
              <span className="mono">{money(base.interest)}</span>
              <span className="note mono" style={{ margin: 0 }}>—</span>
            </div>
            {Number(extra) > 0 && (
              <div className="ttr" style={{ cursor: "default" }}>
                <span className="tname">+{money(Number(extra))}/mo</span>
                <span className="mono">{monthsWord(withExtra.months)}</span>
                <span className="mono">{money(withExtra.interest)}</span>
                <span className="mono" style={{ color: "var(--up)" }}>
                  {money(base.interest - withExtra.interest)} · {base.months - withExtra.months}mo sooner
                </span>
              </div>
            )}
            {Number(lump) > 0 && (
              <div className="ttr" style={{ cursor: "default" }}>
                <span className="tname">{money(Number(lump))} lump sum now</span>
                <span className="mono">{monthsWord(withLump.months)}</span>
                <span className="mono">{money(withLump.interest)}</span>
                <span className="mono" style={{ color: "var(--up)" }}>
                  {money(base.interest - withLump.interest)} · {base.months - withLump.months}mo sooner
                </span>
              </div>
            )}
            <div className="ttr" style={{ cursor: "default" }}>
              <span className="tname">Gone in {goalMonths} months</span>
              <span className="mono">{goalMonths} months</span>
              <span className="mono">{money(amortize(derived.bal, acc.rate, needFor).interest)}</span>
              <span className="mono" style={{ color: needFor > typical * 2 ? "var(--down)" : "var(--gold)" }}>
                needs {money(needFor)}/mo
              </span>
            </div>
          </div>

          {Number(extra) > 0 && Number(lump) > 0 && (
            <div className="note" style={{ marginTop: 8 }}>
              {base.interest - withLump.interest > base.interest - withExtra.interest
                ? <>The lump sum wins here — {money((base.interest - withLump.interest) - (base.interest - withExtra.interest))} more saved than the monthly extra.
                    Interest accrues on the balance, so money that arrives sooner works harder.</>
                : <>The monthly extra wins here, because {money(Number(extra))} every month for {monthsWord(withExtra.months)} adds up to more
                    than the {money(Number(lump))} one-off.</>}
            </div>
          )}

          <div className="note" style={{ marginTop: 8 }}>
            Interest is charged on what's left, so every extra dollar removes not just itself but all the interest that dollar
            would have earned for the lender. At {acc.rate}%, paying {money(typical)}/mo means about{" "}
            <b className="mono">{money2((derived.bal * (Number(acc.rate) / 100 / 12)))}</b> of your next payment is interest and the rest is principal —
            and that split improves every month.
          </div>
        </>
      )}
    </>
  );
}
