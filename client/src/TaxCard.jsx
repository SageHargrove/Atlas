import React, { useState, useMemo, useEffect } from "react";
import { estimateTax, suggestSources, FILING, TAX_YEAR } from "./taxMath.js";

/* ------------------------------------------------------------------
   Tax estimate for mixed income.

   Opens pre-filled from your own transactions — it can already see the
   payroll deposits and the contractor payments — and every field is
   editable, because the guess about which income was already taxed is
   the one place being wrong is expensive.

   No documents. A W-2 PDF carries your SSN and employer EIN, which is a
   different risk class from a resume; one stray backup of that is
   identity-theft-grade. Numbers only, and they live in the same
   encrypted file as everything else.
------------------------------------------------------------------ */

const dollars = (n) => (n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());
const pct = (n) => Math.round(n * 1000) / 10 + "%";

export default function TaxCard({ d, setD }) {
  const t = d.tax || {};
  const year = t.year || new Date().getFullYear();
  const [open, setOpen] = useState(false);
  const set = (patch) => setD((p) => ({ ...p, tax: { ...(p.tax || {}), year, ...patch } }));

  const suggested = useMemo(() => suggestSources(d.txns, year), [d.txns, year]);
  const sources = t.sources || [];

  /* Pull the suggestions in once. Not on every render — that would fight you
     every time you deleted a row it thought should exist. */
  useEffect(() => {
    if (t.sources || !suggested.length) return;
    set({ sources: suggested.map((s) => ({ id: s.key, label: s.label, amount: s.amount, type: s.type, withheld: 0 })) });
  }, [suggested.length]);

  const patch = (id, ch) => set({ sources: sources.map((s) => (s.id === id ? { ...s, ...ch } : s)) });
  const unknown = sources.filter((s) => s.type === "unknown");

  const est = useMemo(() => estimateTax({
    w2: sources.filter((s) => s.type === "w2").reduce((a, s) => a + (Number(s.amount) || 0), 0),
    w2Withheld: sources.filter((s) => s.type === "w2").reduce((a, s) => a + (Number(s.withheld) || 0), 0),
    se: sources.filter((s) => s.type === "se").reduce((a, s) => a + (Number(s.amount) || 0), 0),
    seExpenses: Number(t.seExpenses) || 0,
    filing: t.filing || "single",
    deduction: t.deduction === "" || t.deduction == null ? null : Number(t.deduction),
    extraWithheld: Number(t.paidAlready) || 0,
    buffer: 0.1,
  }), [sources, t.seExpenses, t.filing, t.deduction, t.paidAlready]);

  const seTotal = sources.filter((s) => s.type === "se").reduce((a, s) => a + (Number(s.amount) || 0), 0);

  if (!sources.length && !suggested.length) return null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Tax estimate — {year}</h3>
        <button className="btn small" onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Edit income"}</button>
      </div>
      <div className="note" style={{ marginTop: 0 }}>
        Contractor income has nothing withheld, so it's the half that surprises people in April — in both directions.
        Filled in from your own deposits; correct anything it got wrong. No documents, just numbers.
      </div>

      {unknown.length > 0 && (
        <div className="note bad" style={{ marginTop: 8 }}>
          {unknown.length} income source{unknown.length === 1 ? "" : "s"} — {unknown.map((s) => s.label).join(", ")} — need
          you to say whether tax was already withheld. Until then they're excluded, so the number below is too low.
        </div>
      )}

      <div className="grid4" style={{ marginTop: 10 }}>
        <div><div className="sub">Income counted</div><div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{dollars(est.gross)}</div></div>
        <div><div className="sub">Estimated tax</div><div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{dollars(est.totalTax)}</div></div>
        <div><div className="sub">Already paid</div><div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{dollars(est.withheld)}</div></div>
        <div>
          <div className="sub">{est.balance >= 0 ? "Still owed" : "Refund due"}</div>
          <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: est.balance >= 0 ? "var(--down)" : "var(--up)" }}>
            {dollars(Math.abs(est.balance))}
          </div>
        </div>
      </div>

      {seTotal > 0 && (
        <div className="note" style={{ marginTop: 10, color: "var(--gold)" }}>
          <b>Set aside {pct(est.setAside)} of every contractor dollar.</b> On {dollars(seTotal)} of untaxed income that's{" "}
          {dollars(seTotal * est.setAside)} held back. It's your marginal rate ({pct(est.marginal)}) plus self-employment
          tax (15.3% on 92.35% of it), plus a 10% cushion — being short costs a penalty, being over just means a refund.
          {est.needsQuarterly && " You'll owe over $1,000, which is the line where the IRS expects quarterly estimated payments rather than one April cheque."}
        </div>
      )}

      {open && (
        <>
          <label className="f" style={{ marginTop: 12 }}>Where the money came from</label>
          {sources.map((s) => (
            <div className="row" key={s.id} style={{ marginTop: 6 }}>
              <input className="in" style={{ flex: 1, minWidth: 140 }} value={s.label}
                onChange={(e) => patch(s.id, { label: e.target.value.slice(0, 40) })} />
              <input className="in mono" type="number" style={{ width: 110 }} value={s.amount}
                onChange={(e) => patch(s.id, { amount: e.target.value === "" ? "" : Number(e.target.value) })} />
              <select className="in" style={{ width: 180 }} value={s.type} onChange={(e) => patch(s.id, { type: e.target.value })}>
                <option value="unknown">— taxed already? —</option>
                <option value="w2">W-2 · tax withheld</option>
                <option value="se">1099 / contractor · nothing withheld</option>
              </select>
              {s.type === "w2" && (
                <input className="in mono" type="number" style={{ width: 110 }} placeholder="withheld" value={s.withheld ?? ""}
                  onChange={(e) => patch(s.id, { withheld: e.target.value === "" ? "" : Number(e.target.value) })} />
              )}
              <button className="x" title="Remove" onClick={() => set({ sources: sources.filter((x) => x.id !== s.id) })}>✕</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => set({ sources: [...sources, { id: "m" + Date.now(), label: "", amount: 0, type: "unknown", withheld: 0 }] })}>+ Source</button>
            <button className="btn small" onClick={() => set({ sources: suggested.map((s) => ({ id: s.key, label: s.label, amount: s.amount, type: s.type, withheld: 0 })) })}>
              Re-read from transactions
            </button>
          </div>

          <div className="grid3" style={{ marginTop: 12 }}>
            <div><label className="f">Filing status</label>
              <select className="in" value={t.filing || "single"} onChange={(e) => set({ filing: e.target.value })}>
                {Object.entries(FILING).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select></div>
            <div><label className="f">Business expenses (1099 only)</label>
              <input className="in mono" type="number" value={t.seExpenses ?? ""} placeholder="0"
                onChange={(e) => set({ seExpenses: e.target.value })} />
              <div className="note">Laptop, software, home office — these reduce contractor income before tax.</div></div>
            <div><label className="f">Estimated payments already made</label>
              <input className="in mono" type="number" value={t.paidAlready ?? ""} placeholder="0"
                onChange={(e) => set({ paidAlready: e.target.value })} />
              <div className="note">Quarterly payments you've sent the IRS directly.</div></div>
          </div>

          <label className="f" style={{ marginTop: 12 }}>The arithmetic</label>
          <div className="kv"><span className="k">Self-employment tax (15.3% of 92.35% of contractor income)</span><span className="mono">{dollars(est.seTax)}</span></div>
          <div className="kv"><span className="k">Half of that, deducted before brackets</span><span className="mono">−{dollars(est.seDeduction)}</span></div>
          <div className="kv"><span className="k">Standard deduction</span><span className="mono">−{dollars(est.deduction)}</span></div>
          <div className="kv"><span className="k">Taxable income</span><span className="mono">{dollars(est.taxable)}</span></div>
          <div className="kv"><span className="k">Federal income tax on that</span><span className="mono">{dollars(est.incomeTax)}</span></div>
          {est.addlMedicare > 0 && <div className="kv"><span className="k">Additional Medicare</span><span className="mono">{dollars(est.addlMedicare)}</span></div>}
          <div className="kv"><span className="k"><b>Total federal</b></span><span className="mono"><b>{dollars(est.totalTax)}</b> · {pct(est.effectiveRate)} of gross</span></div>

          <div className="note" style={{ marginTop: 10 }}>
            Federal only — no state tax, no credits, no itemising, and the {TAX_YEAR} brackets here are projections until the
            IRS publishes the final figures. The self-employment part is a fixed statutory rate and is the reliable half;
            the income-tax part is the estimate. Treat it as "roughly what to hold back", not as a return.
          </div>
        </>
      )}
    </div>
  );
}
