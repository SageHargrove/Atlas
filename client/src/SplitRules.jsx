import React, { useState } from "react";

/* ------------------------------------------------------------------
   Standing split rules.

   One payment that is really two things — $750 that is $475 rent and
   $275 car — has to be split every single month or both budget lines
   lie. Doing it by hand is the kind of chore people stop doing in
   month three, at which point the budget quietly goes wrong.

   A rule states the fixed part and lets the rest fall through to a
   remainder category, rather than fixing both halves. That's the shape
   that survives change: the car payment is a contract and doesn't move,
   rent does. When rent goes up, nothing here needs editing.
------------------------------------------------------------------ */

const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();
const uid = () => Math.random().toString(36).slice(2, 10);

export default function SplitRules({ d, setD }) {
  const rules = d.settings?.splitRules || [];
  const [busy, setBusy] = useState("");
  const cats = d.cats || [];

  const setRules = (next) => setD((p) => ({ ...p, settings: { ...p.settings, splitRules: next } }));
  const patch = (id, ch) => setRules(rules.map((r) => (r.id === id ? { ...r, ...ch } : r)));
  const patchPart = (id, pi, ch) => patch(id, {
    parts: (rules.find((r) => r.id === id).parts || []).map((p, i) => (i === pi ? { ...p, ...ch } : p)),
  });

  const add = () => setRules([...rules, {
    id: uid(), match: "", minAmount: "", remainderCatId: cats[0]?.id || "",
    parts: [{ label: "", catId: cats[0]?.id || "", amount: "" }],
  }]);

  /* Apply a rule to transactions already in the ledger. Only untouched synced
     rows — anything already split or hand-edited is left alone. */
  const applyNow = (r) => {
    const m = String(r.match || "").trim().toLowerCase();
    const parts = (r.parts || []).filter((p) => p.catId && Number(p.amount) > 0);
    if (!m || !parts.length) return;
    setBusy(r.id);
    setD((p) => {
      const out = [];
      let n = 0;
      for (const t of p.txns) {
        const hit = t.kind === "out" && !t.splitOf
          && String(t.note || "").toLowerCase().includes(m)
          && (!r.minAmount || Number(t.amount) >= Number(r.minAmount));
        if (!hit) { out.push(t); continue; }
        const fixed = parts.reduce((s, x) => s + Number(x.amount), 0);
        const rest = Math.round((Number(t.amount) - fixed) * 100) / 100;
        if (rest < 0) { out.push(t); continue; }
        parts.forEach((x, i) => out.push({
          ...t, id: i === 0 ? t.id : uid(), amount: Math.round(Number(x.amount) * 100) / 100,
          catId: x.catId, kindSet: true, splitOf: t.tellerId || t.id,
          note: t.note + (x.label ? " (" + x.label + ")" : ""),
          ...(i === 0 ? {} : { tellerId: undefined }),
        }));
        if (rest > 0) out.push({ ...t, id: uid(), tellerId: undefined, amount: rest,
          catId: r.remainderCatId || t.catId, kindSet: true, splitOf: t.tellerId || t.id });
        n++;
      }
      setTimeout(() => setBusy(""), 0);
      return { ...p, txns: out, settings: { ...p.settings, splitRules: rules.map((x) => (x.id === r.id ? { ...x, lastApplied: n } : x)) } };
    });
  };

  const undo = (r) => {
    const m = String(r.match || "").trim().toLowerCase();
    setD((p) => {
      /* rebuild each split back into one row: keep the part that carries the
         bank's id and give it the sum of its siblings */
      const groups = new Map();
      const out = [];
      for (const t of p.txns) {
        if (!t.splitOf || !String(t.note || "").toLowerCase().includes(m)) { out.push(t); continue; }
        const g = groups.get(t.splitOf) || { rows: [], total: 0 };
        g.rows.push(t); g.total += Number(t.amount) || 0;
        groups.set(t.splitOf, g);
      }
      for (const [, g] of groups) {
        const keep = g.rows.find((x) => x.tellerId) || g.rows[0];
        out.push({ ...keep, amount: Math.round(g.total * 100) / 100, splitOf: undefined,
          note: String(keep.note || "").replace(/\s*\([^)]*\)\s*$/, "") });
      }
      return { ...p, txns: out };
    });
  };

  return (
    <>
      <div className="note" style={{ marginTop: 0 }}>
        For one payment that covers two things. State the fixed part — a car payment is a contract and doesn't move —
        and let the rest fall into a remainder category. When rent changes, nothing here needs editing.
        New transactions are split as they sync.
      </div>

      {rules.map((r) => {
        const fixed = (r.parts || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        const catName = (id) => cats.find((c) => c.id === id)?.name || "?";
        return (
          <div className="splitrule" key={r.id}>
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "2 1 180px" }}>
                <label className="f">When the description contains</label>
                <input className="in" value={r.match} placeholder="venmo payment"
                  onChange={(e) => patch(r.id, { match: e.target.value })} />
              </div>
              <div style={{ flex: "0 0 120px" }}>
                <label className="f">and it's at least</label>
                <input className="in mono" type="number" value={r.minAmount} placeholder="500"
                  onChange={(e) => patch(r.id, { minAmount: e.target.value })} />
              </div>
              <button className="x" title="Delete this rule" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>✕</button>
            </div>

            {(r.parts || []).map((p, pi) => (
              <div className="row" style={{ gap: 8, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }} key={pi}>
                <div style={{ flex: "0 0 110px" }}>
                  <label className="f">take exactly</label>
                  <input className="in mono" type="number" value={p.amount} placeholder="275"
                    onChange={(e) => patchPart(r.id, pi, { amount: e.target.value })} />
                </div>
                <div style={{ flex: "1 1 150px" }}>
                  <label className="f">and file it as</label>
                  <select className="in" value={p.catId} onChange={(e) => patchPart(r.id, pi, { catId: e.target.value })}>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: "0 0 120px" }}>
                  <label className="f">labelled</label>
                  <input className="in" value={p.label || ""} placeholder="car"
                    onChange={(e) => patchPart(r.id, pi, { label: e.target.value })} />
                </div>
                {(r.parts || []).length > 1 && (
                  <button className="x" onClick={() => patch(r.id, { parts: r.parts.filter((_, i) => i !== pi) })}>✕</button>
                )}
              </div>
            ))}

            <div className="row" style={{ gap: 8, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 180px" }}>
                <label className="f">everything left over goes to</label>
                <select className="in" value={r.remainderCatId || ""} onChange={(e) => patch(r.id, { remainderCatId: e.target.value })}>
                  <option value="">— fold it into the first part —</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <button className="btn small" onClick={() => patch(r.id, { parts: [...(r.parts || []), { label: "", catId: cats[0]?.id || "", amount: "" }] })}>
                + another part
              </button>
            </div>

            <div className="note" style={{ marginTop: 8 }}>
              A <b className="mono">$750</b> match becomes{" "}
              {(r.parts || []).filter((p) => Number(p.amount) > 0).map((p, i) => (
                <span key={i}><b className="mono">{money(p.amount)}</b> {catName(p.catId)} + </span>
              ))}
              <b className="mono">{money(Math.max(0, 750 - fixed))}</b> {r.remainderCatId ? catName(r.remainderCatId) : catName(r.parts?.[0]?.catId)}.
              {r.lastApplied != null && <> Last run split <b>{r.lastApplied}</b> existing transaction{r.lastApplied === 1 ? "" : "s"}.</>}
            </div>

            <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
              <button className="btn small primary" disabled={busy === r.id || !r.match || !fixed}
                onClick={() => applyNow(r)}>Apply to existing transactions</button>
              <button className="btn small" disabled={!r.match} onClick={() => undo(r)}
                title="Merge previously split transactions back into one">Undo splits</button>
            </div>
          </div>
        );
      })}

      <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 10 }}>
        <button className="btn small" onClick={add}>+ New split rule</button>
      </div>
    </>
  );
}
