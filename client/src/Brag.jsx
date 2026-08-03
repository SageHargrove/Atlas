import React, { useState } from "react";

/* ------------------------------------------------------------------
   The brag document.

   Résumé writing is agonising for one reason: nobody remembers what
   they did eighteen months ago. You end up writing "assisted with
   various IAM projects" about a quarter in which you actually built a
   role model covering 11,600 entitlements, because the specifics are
   gone.

   The fix is to write it down the week it happens, when you still know
   the number. That's the whole feature. It is deliberately not a
   résumé builder — it's the raw material, kept in your words, dated,
   so the résumé can be written from evidence later.
------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const monthOf = (d) => {
  const [y, m] = String(d || "").split("-");
  return m ? ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"][+m - 1] + " " + y : "Undated";
};

export default function Brag({ S, setCareer }) {
  const wins = S.wins || [];
  const [text, setText] = useState("");
  const [date, setDate] = useState(today());
  const [shown, setShown] = useState(8);

  const add = () => {
    if (!text.trim()) return;
    setCareer((c) => ({ ...c, settings: { ...c.settings,
      wins: [{ id: uid(), date, text: text.trim() }, ...(c.settings.wins || [])] } }));
    setText(""); setDate(today());
  };
  const del = (id) => setCareer((c) => ({ ...c, settings: { ...c.settings, wins: (c.settings.wins || []).filter((w) => w.id !== id) } }));

  /* group by month so a year reads as a story rather than a list */
  const groups = [];
  for (const w of [...wins].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    const k = monthOf(w.date);
    if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, rows: [] });
    groups[groups.length - 1].rows.push(w);
  }
  let count = 0;

  return (
    <>
      <div className="note" style={{ marginTop: 0 }}>
        Write it down the week it happens, while you still know the number. "Cut entitlements 28%" is a résumé line;
        "worked on access reviews" is what you'll write in a year if you don't note it now.
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "flex-end" }}>
        <div style={{ flex: "0 0 140px" }}>
          <label className="f">When</label>
          <input className="in" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="f">What you did</label>
          <input className="in" value={text} placeholder="Automated entitlement analysis — 40h per business unit down to under 2"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        </div>
        <button className="btn small primary" disabled={!text.trim()} onClick={add}>Add</button>
      </div>

      {!wins.length ? (
        <div className="note" style={{ marginTop: 10 }}>
          Nothing logged yet. The best time to add the first one is right after something goes well — a shipped project,
          a number that moved, a thing someone thanked you for.
        </div>
      ) : (
        <>
          <div style={{ marginTop: 12 }}>
            {groups.map((g) => {
              if (count >= shown) return null;
              return (
                <div key={g.k} style={{ marginBottom: 10 }}>
                  <div className="tlabel" style={{ margin: "0 0 4px" }}>{g.k}</div>
                  {g.rows.map((w) => {
                    if (count++ >= shown) return null;
                    return (
                      <div className="bragrow" key={w.id}>
                        <span>{w.text}</span>
                        <button className="x" title="Delete" onClick={() => del(w.id)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {wins.length > shown && (
            <div className="mrow" style={{ justifyContent: "center" }}>
              <button className="btn small" onClick={() => setShown((n) => n + 8)}>Show 8 more — {wins.length - shown} left</button>
            </div>
          )}
          <div className="note">
            {wins.length} logged. When you next rewrite the résumé, work from this rather than from memory — and copy the
            numbers across verbatim, since those are the part that survives a recruiter's skim.
          </div>
        </>
      )}
    </>
  );
}
