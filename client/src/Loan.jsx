import React, { useState, useMemo, useEffect } from "react";

/* ------------------------------------------------------------------
   Manual loan tracking, from the loan's own terms.

   The first version inferred the balance by replaying whatever payments
   happened to be categorised correctly. That works until a payment is
   miscategorised, or the category is shared with a second loan, or you
   started tracking halfway through — and then the number is quietly
   wrong with no way to tell.

   A loan is a closed-form thing: principal, rate, term, start date. From
   those four you get the scheduled payment and the exact balance on any
   date, with no dependence on what the ledger happens to know. Payments
   filed in the ledger then become a CHECK on the schedule rather than
   its source: ahead, behind, or on track.
------------------------------------------------------------------ */

const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());
const money2 = (n) => (!isFinite(n) ? "—" : "$" + n.toFixed(2));
const LOAN_TYPES = ["Auto loan", "Student loan", "Mortgage", "Other debt"];

/* The level payment that retires `principal` over `months` at `aprPct`. */
export function scheduledPayment(principal, aprPct, months) {
  const r = Number(aprPct) / 100 / 12;
  const p = Number(principal), n = Number(months);
  if (!(p > 0) || !(n > 0)) return 0;
  if (Math.abs(r) < 1e-9) return p / n;
  return (p * r) / (1 - Math.pow(1 + r, -n));
}

/* Balance after `k` scheduled payments — the closed form, so it doesn't drift
   the way a month-by-month loop can over a 72-month term. */
export function balanceAfter(principal, aprPct, months, k) {
  const r = Number(aprPct) / 100 / 12;
  const p = Number(principal);
  if (!(p > 0)) return 0;
  if (k <= 0) return p;
  if (k >= months) return 0;
  if (Math.abs(r) < 1e-9) return Math.max(0, p - (p / months) * k);
  const pay = scheduledPayment(p, aprPct, months);
  return Math.max(0, p * Math.pow(1 + r, k) - pay * ((Math.pow(1 + r, k) - 1) / r));
}

/* Months from `start` to today, which is how many payments should have landed. */
function monthsElapsed(start) {
  if (!start) return 0;
  const s = new Date(start + "T00:00:00");
  if (isNaN(s)) return 0;
  const now = new Date();
  let m = (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
  if (now.getDate() < s.getDate()) m -= 1;   // this month's payment hasn't come due yet
  return Math.max(0, m);
}

/* Pay it down with an extra amount and/or a lump sum; returns months and interest. */
export function payoff(balance, aprPct, payment, { extra = 0, lump = 0, cap = 720 } = {}) {
  const r = Number(aprPct) / 100 / 12;
  let bal = Number(balance) - Number(lump || 0);
  const pay = Number(payment) + Number(extra || 0);
  if (bal <= 0) return { months: 0, interest: 0 };
  if (pay <= bal * r) return { months: Infinity, interest: Infinity, impossible: true };
  let interest = 0, months = 0;
  while (bal > 0 && months < cap) {
    const i = bal * r;
    interest += i;
    bal = bal + i - pay;
    months++;
    if (bal < 0) bal = 0;
  }
  return { months, interest };
}

export default function Loan({ d, setD }) {
  const debts = d.accounts.filter((a) => LOAN_TYPES.includes(a.type) && !a.tellerId);
  const [sel, setSel] = useState(debts[0]?.id || "");
  const [lump, setLump] = useState("");
  const [extra, setExtra] = useState("");
  const [goalMonths, setGoalMonths] = useState(12);

  const acc = debts.find((a) => a.id === sel) || debts[0];
  const setAcc = (patch) => setD((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === acc.id ? { ...a, ...patch } : a)) }));

  const principal = Number(acc?.principal) || 0;
  const term = Number(acc?.termMonths) || 0;
  const apr = Number(acc?.rate) || 0;
  const start = acc?.startDate || "";
  const known = principal > 0 && term > 0 && start && apr >= 0;

  const sched = useMemo(() => {
    if (!known) return null;
    /* The payment on your statement is a FACT. Recomputing one from principal
       and term makes a fitted principal outrank a number you read off the
       lender - which is how this card came to claim $363.21 when the loan
       charges $352.58. Use the stated payment whenever there is one. */
    const stated = Number(acc.minPay) || 0;
    const pay = stated > 0 ? stated : scheduledPayment(principal, apr, term);
    const impliedTerm = stated > 0 && principal > 0
      ? -Math.log(1 - (principal * (apr / 100 / 12)) / stated) / Math.log(1 + apr / 100 / 12) : term;
    const eff = Number.isFinite(impliedTerm) && impliedTerm > 0 ? impliedTerm : term;
    const k = Math.min(eff, monthsElapsed(start));
    /* amortise with the stated payment, not a derived one */
    const bal = (() => { const rr = apr / 100 / 12; let bb = principal;
      for (let i = 0; i < k; i++) bb = Math.max(0, bb + bb * rr - pay); return bb; })();
    const totalInterest = pay * eff - principal;
    const paidSoFar = pay * k;
    const principalPaid = principal - bal;
    const nextInterest = bal * (apr / 100 / 12);
    const end = new Date(start + "T00:00:00");
    end.setMonth(end.getMonth() + Math.round(eff));
    return { pay, k, bal, totalInterest, paidSoFar, principalPaid, stated: stated > 0, eff,
      interestPaid: Math.max(0, paidSoFar - principalPaid), nextInterest, left: Math.max(0, Math.round(eff - k)), end };
  }, [known, principal, apr, term, start, acc?.minPay]);

  /* What the ledger says you've actually paid — a check on the schedule, not
     its source. Being ahead is the interesting case and it's invisible otherwise. */
  const actual = useMemo(() => {
    if (!acc?.payCatId || !start) return null;
    const rows = (d.txns || []).filter((t) => t.kind === "out" && t.catId === acc.payCatId && t.date >= start);
    return { n: rows.length, total: rows.reduce((s, t) => s + (Number(t.amount) || 0), 0) };
  }, [d.txns, acc?.payCatId, start]);

  /* Keep the account balance in step so net worth, the Plan tiles and the
     retirement maths all read the same number this card does. */
  useEffect(() => {
    if (!sched) return;
    const want = Math.round(sched.bal * 100) / 100;
    if (Math.abs((Number(acc.balance) || 0) - want) >= 1) setAcc({ balance: want });
  }, [sched?.bal]);

  if (!acc) return <div className="note">No manually-tracked loans. Accounts your bank syncs report their own balance.</div>;

  const monthsWord = (m) => (!isFinite(m) ? "never" : m >= 24 ? Math.floor(m / 12) + "y " + (m % 12) + "m" : m + " months");
  const base = sched ? payoff(sched.bal, apr, sched.pay) : null;
  const withExtra = sched ? payoff(sched.bal, apr, sched.pay, { extra: Number(extra) || 0 }) : null;
  const withLump = sched ? payoff(sched.bal, apr, sched.pay, { lump: Number(lump) || 0 }) : null;
  const needFor = sched ? scheduledPayment(sched.bal, apr, Number(goalMonths) || 1) : 0;

  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {debts.length > 1 && (
          <div style={{ flex: "0 0 150px" }}>
            <label className="f">Loan</label>
            <select className="in" value={sel} onChange={(e) => setSel(e.target.value)}>
              {debts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ flex: "0 0 140px" }}>
          <label className="f">Amount borrowed</label>
          <input className="in mono" type="number" value={acc.principal ?? ""} placeholder="e.g. 21000"
            onChange={(e) => setAcc({ principal: e.target.value })} />
        </div>
        <div style={{ flex: "0 0 118px" }}>
          <label className="f">Your payment</label>
          <input className="in mono" type="number" step="0.01" value={acc.minPay ?? ""} placeholder="352.58"
            onChange={(e) => setAcc({ minPay: e.target.value })} />
        </div>
        <div style={{ flex: "0 0 86px" }}>
          <label className="f">APR %</label>
          <input className="in mono" type="number" step="0.01" value={acc.rate ?? ""} onChange={(e) => setAcc({ rate: e.target.value })} />
        </div>
        <div style={{ flex: "0 0 148px" }}>
          <label className="f">First payment</label>
          <input className="in" type="date" value={acc.startDate || ""} onChange={(e) => setAcc({ startDate: e.target.value })} />
        </div>
        <div style={{ flex: "0 0 118px" }}>
          <label className="f">Term</label>
          <select className="in" value={acc.termMonths || ""} onChange={(e) => setAcc({ termMonths: e.target.value })}>
            <option value="">—</option>
            {[24, 36, 48, 60, 66, 72, 84, 120, 180, 240, 360].map((m) => <option key={m} value={m}>{m} months</option>)}
          </select>
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <label className="f">Payments filed under</label>
          <select className="in" value={acc.payCatId || ""} onChange={(e) => setAcc({ payCatId: e.target.value })}>
            <option value="">— optional —</option>
            {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {!known ? (
        <div className="note bad" style={{ marginTop: 10 }}>
          Fill in what you borrowed, the rate, when the first payment was due and the term. From those four Atlas can work
          out the exact balance on any date — no guessing from whatever payments happen to be categorised right.
        </div>
      ) : (
        <>
          <div className="glance" style={{ marginTop: 12 }}>
            <div className="gtile">
              <div className="gtl">Owed today</div>
              <div className="gtv">{money(sched.bal)}</div>
              <div className="gts">after {sched.k} of {term} payments</div>
            </div>
            <div className="gtile">
              <div className="gtl">{sched.stated ? "Your payment" : "Scheduled payment"}</div>
              <div className="gtv">{money2(sched.pay)}</div>
              <div className="gts">{sched.left} left · ends {sched.end.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</div>
            </div>
            <div className="gtile">
              <div className="gtl">Interest paid so far</div>
              <div className="gtv" style={{ color: "var(--down)" }}>{money(sched.interestPaid)}</div>
              <div className="gts">of {money(sched.paidSoFar)} paid in</div>
            </div>
            <div className="gtile">
              <div className="gtl">Interest still to come</div>
              <div className="gtv">{money(base.interest)}</div>
              <div className="gts">{money(sched.totalInterest)} over the whole loan</div>
            </div>
          </div>

          <div className="note" style={{ marginTop: 2 }}>
            Next payment of <b className="mono">{money2(sched.pay)}</b> is about <b className="mono">{money2(sched.nextInterest)}</b> interest
            and <b className="mono">{money2(Math.max(0, sched.pay - sched.nextInterest))}</b> principal — and that split shifts toward principal
            every month. Your net worth and the Plan tiles read this balance, so they update on their own now.
          </div>

          {/* the ledger as a cross-check, never as the source */}
          {actual && actual.n > 0 && (() => {
            const expected = sched.pay * sched.k;
            const diff = actual.total - expected;
            return (
              <div className="note" style={{ marginTop: 6, color: diff > 25 ? "var(--up)" : diff < -25 ? "var(--gold)" : undefined }}>
                Your ledger shows <b className="mono">{money(actual.total)}</b> paid across {actual.n} transactions since {start};
                the schedule expects <b className="mono">{money(expected)}</b>.
                {diff > 25 ? <> You're <b className="mono">{money(diff)}</b> ahead — put that in the extra box below to see what it buys you.</>
                  : diff < -25 ? <> That's <b className="mono">{money(-diff)}</b> short, which usually means a payment isn't categorised here rather than a missed payment.</>
                  : <> On track.</>}
              </div>
            );
          })()}

          <div className="row" style={{ gap: 12, marginTop: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 150px" }}>
              <label className="f">Pay extra each month</label>
              <input className="in mono" type="number" value={extra} placeholder="0" onChange={(e) => setExtra(e.target.value)} />
            </div>
            <div style={{ flex: "1 1 150px" }}>
              <label className="f">Or a lump sum now</label>
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
            <div className="tth"><span>Approach</span><span>Paid off in</span><span>Interest</span><span>Against the schedule</span></div>
            <div className="ttr" style={{ cursor: "default" }}>
              <span className="tname">Stick to the schedule</span>
              <span className="mono">{monthsWord(base.months)}</span>
              <span className="mono">{money(base.interest)}</span>
              <span className="note mono" style={{ margin: 0 }}>—</span>
            </div>
            {Number(extra) > 0 && (
              <div className="ttr" style={{ cursor: "default" }}>
                <span className="tname">+{money(Number(extra))}/mo</span>
                <span className="mono">{monthsWord(withExtra.months)}</span>
                <span className="mono">{money(withExtra.interest)}</span>
                <span className="mono" style={{ color: "var(--up)" }}>saves {money(base.interest - withExtra.interest)} · {base.months - withExtra.months}mo sooner</span>
              </div>
            )}
            {Number(lump) > 0 && (
              <div className="ttr" style={{ cursor: "default" }}>
                <span className="tname">{money(Number(lump))} lump sum</span>
                <span className="mono">{monthsWord(withLump.months)}</span>
                <span className="mono">{money(withLump.interest)}</span>
                <span className="mono" style={{ color: "var(--up)" }}>saves {money(base.interest - withLump.interest)} · {base.months - withLump.months}mo sooner</span>
              </div>
            )}
            <div className="ttr" style={{ cursor: "default" }}>
              <span className="tname">Gone in {goalMonths} months</span>
              <span className="mono">{goalMonths} months</span>
              <span className="mono">{money(payoff(sched.bal, apr, needFor).interest)}</span>
              <span className="mono" style={{ color: needFor > sched.pay * 2.5 ? "var(--down)" : "var(--gold)" }}>
                needs {money(needFor)}/mo — {money(needFor - sched.pay)} more
              </span>
            </div>
          </div>

          {Number(extra) > 0 && Number(lump) > 0 && (
            <div className="note" style={{ marginTop: 8 }}>
              {(base.interest - withLump.interest) > (base.interest - withExtra.interest)
                ? <>The lump sum wins by {money((base.interest - withLump.interest) - (base.interest - withExtra.interest))} — interest
                    compounds on what's left, so money that arrives sooner does more work.</>
                : <>The monthly extra wins by {money((base.interest - withExtra.interest) - (base.interest - withLump.interest))} — {money(Number(extra))} a
                    month for {monthsWord(withExtra.months)} simply adds up to more than the one-off.</>}
            </div>
          )}
        </>
      )}
    </>
  );
}
