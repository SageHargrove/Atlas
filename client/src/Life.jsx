import React, { useMemo, useState } from "react";

/* ------------------------------------------------------------------
   Life — your own timeline.

   The career timeline answers "what should I do next". This one answers
   "what actually happened": the car you financed, the lump you threw at
   the loan, the tax bill, the internship turning into a contract, the
   month net worth crossed zero. Atlas already knows most of it — the
   events are DERIVED from data that exists, so the timeline builds
   itself and stays true, and anything it can't know (moved apartments,
   got engaged) you add by hand in one line.

   Money apps show balances; almost none show the story. The story is
   the part you'll actually want to look back on.
------------------------------------------------------------------ */

const money = (n) => "$" + Math.abs(Math.round(Number(n) || 0)).toLocaleString();
const uid = () => Math.random().toString(36).slice(2, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthOf = (d) => { const [y, m] = String(d || "").split("-"); return m ? MONTHS[+m - 1] + " " + y : "Undated"; };

/* Everything Atlas can already prove happened, as {date, icon, text, kind}. */
export function deriveEvents(d) {
  const ev = [];
  const push = (date, icon, text, kind) => date && ev.push({ id: kind + "|" + date + "|" + text.slice(0, 30), date: String(date).slice(0, 10), icon, text, kind });

  /* loans: origination is a life event; so is every oversized payment */
  for (const a of d.accounts || []) {
    if (a.type === "Auto loan" && a.startDate && Number(a.principal) > 0)
      push(a.startDate, "🚗", "Financed " + (a.name || "a vehicle") + " — " + money(a.principal) + " at " + (a.rate || "?") + "%", "loan");
    if (a.payCatId) {
      const typical = Number(a.minPay) || 0;
      for (const t of d.txns || []) {
        if (t.kind !== "out" || t.catId !== a.payCatId) continue;
        if (typical > 0 && Number(t.amount) >= Math.max(typical * 2.5, 1000))
          push(t.date, "💥", money(t.amount) + " extra onto " + (a.name || "the loan") + " — ahead of schedule", "lump");
      }
    }
  }
  /* the big one-offs that aren't loan payments: top of the spending tail */
  const outs = (d.txns || []).filter((t) => t.kind === "out" && Number(t.amount) >= 1500);
  for (const t of outs) {
    const cat = (d.cats || []).find((c) => c.id === t.catId)?.name || "";
    if (/car ?\/ ?loan/i.test(cat)) continue;   // already covered above
    push(t.date, /tax/i.test(cat) ? "🏛️" : "💸", money(t.amount) + (cat ? " — " + cat : "") + " (" + String(t.note || "").slice(0, 34) + ")", "big");
  }
  /* career, from the tracker and the brag doc */
  for (const a of d.career?.apps || []) {
    if (a.status === "Offer") push(a.updatedOn || a.appliedOn, "🎉", "Offer from " + a.company, "career");
    else if (a.status === "Interviewing" && a.appliedOn) push(a.appliedOn, "🗣️", "Interviewing at " + a.company, "career");
  }
  for (const w of d.career?.settings?.wins || []) push(w.date, "🏆", w.text, "win");
  /* accounts connected */
  for (const c of d.simplefin || []) push(c.added, "🏦", "Connected " + (c.institution || "a bank"), "bank");
  /* goals reached */
  for (const g of d.goals || []) {
    if (Number(g.saved) >= Number(g.target) && Number(g.target) > 0)
      push(g.reachedOn || g.updatedOn, "🎯", "Goal reached: " + g.name + " (" + money(g.target) + ")", "goal");
  }
  /* net worth crossing zero — from reconstructed history, a real milestone */
  const h = d.history || [];
  for (let i = 1; i < h.length; i++) {
    if (h[i - 1].nw < 0 && h[i].nw >= 0) push(h[i].date, "📈", "Net worth crossed zero — " + money(h[i].nw) + " and climbing", "nw");
    if (h[i - 1].nw >= 0 && h[i].nw < 0) push(h[i].date, "📉", "Net worth went negative — usually a car loan arriving, not a crisis", "nw");
  }
  return ev;
}

export default function Life({ d, setD }) {
  const [text, setText] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [shown, setShown] = useState(12);

  const manual = d.settings?.lifeEvents || [];
  const events = useMemo(() => {
    const auto = deriveEvents(d);
    const all = [...auto, ...manual.map((m) => ({ ...m, icon: m.icon || "📌", kind: "manual" }))];
    /* newest first, deduped on id so a derived event can't repeat */
    const seen = new Set();
    return all.filter((e) => e.date && !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [d, manual]);

  const add = () => {
    if (!text.trim()) return;
    setD((p) => ({ ...p, settings: { ...p.settings, lifeEvents: [...(p.settings.lifeEvents || []), { id: uid(), date, text: text.trim() }] } }));
    setText("");
  };
  const del = (id) => setD((p) => ({ ...p, settings: { ...p.settings, lifeEvents: (p.settings.lifeEvents || []).filter((e) => e.id !== id) } }));

  let lastMonth = "";
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3>Your timeline</h3>
        <span className="note" style={{ margin: 0 }}>{events.length} events — most derived from your own data, the rest yours to add</span>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 140px" }}>
          <label className="f">When</label>
          <input className="in" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="f">What happened</label>
          <input className="in" value={text} placeholder="Moved to the new apartment · got engaged · passed Security+"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        </div>
        <button className="btn small primary" disabled={!text.trim()} onClick={add}>Add</button>
      </div>

      {!events.length ? (
        <div className="note" style={{ marginTop: 12 }}>
          Nothing yet — it fills in as Atlas sees things happen: a loan starting, a big payment, an offer, a goal reached.
        </div>
      ) : (
        <>
          <ol className="tline" style={{ marginTop: 14 }}>
            {events.slice(0, shown).map((e) => {
              const m = monthOf(e.date);
              const head = m !== lastMonth; lastMonth = m;
              return (
                <React.Fragment key={e.id}>
                  {head && <div className="tlabel" style={{ margin: "10px 0 4px 66px" }}>{m}</div>}
                  <li className="tli done" style={{ padding: "5px 0" }}>
                    <div className="tlwhen">{e.date.slice(5)}</div>
                    <span className="tlmark" style={{ cursor: "default", background: "var(--panel2)", borderColor: "var(--line2)", fontSize: 10 }}>{e.icon}</span>
                    <div className="tlbody">
                      <div className="tlname" style={{ fontWeight: 500 }}>
                        {e.text}
                        {e.kind === "manual" && <button className="x" style={{ marginLeft: 8 }} title="Remove" onClick={() => del(e.id)}>✕</button>}
                      </div>
                    </div>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>
          {events.length > shown && (
            <div className="mrow" style={{ justifyContent: "center" }}>
              <button className="btn small" onClick={() => setShown((n) => n + 12)}>Show 12 more — {events.length - shown} earlier</button>
            </div>
          )}
        </>
      )}
      <div className="note" style={{ marginTop: 10 }}>
        Derived events update themselves — pay off the car and the payoff shows up here on its own. Only the 📌 ones are stored.
      </div>
    </div>
  );
}
