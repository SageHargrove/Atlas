import React, { useMemo, useState } from "react";
import { TYPES, DIFFICULTY, IRS_MILE, rank, affordability } from "./housingMath.js";

/* Housing search.

   Listing sites block scraping and say so, so there is no feed here. What there
   is: every option you are considering, priced ALL-IN against your real
   take-home, with a real driving commute to every place you work. Rent is the
   number listings show you; total monthly cost is the number that decides it. */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const BAND = { good: "var(--up)", stretch: "var(--gold)", high: "var(--down)", unknown: "var(--muted)" };

async function geocode(q) {
  const r = await fetch("/api/geo/geocode?q=" + encodeURIComponent(q));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "lookup failed");
  if (!j.found) throw new Error("Could not find that address. Try adding the city and state.");
  return j;
}
async function routeTo(from, to) {
  const r = await fetch("/api/geo/route?" + new URLSearchParams({ flat: from.lat, flon: from.lon, tlat: to.lat, tlon: to.lon }));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "route failed");
  return j;
}

const BLANK = { name: "", address: "", type: "Apartment", rent: "", utilities: "", beds: "", baths: "", sqft: "",
  deposit: "", difficulty: "normal", available: "", link: "", notes: "" };
const EMPTY = { works: [], options: [], daysPerWeek: 5 };

export default function Housing({ d, setD }) {
  const H = d.housing || EMPTY;
  const works = H.works || [];
  const options = H.options || [];
  const takeHome = Number(d.settings?.incomeMonthly) || 0;
  const save = (patch) => setD((p) => ({ ...p, housing: { ...(p.housing || EMPTY), ...patch } }));

  const [wName, setWName] = useState("");
  const [wAddr, setWAddr] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);

  /* what you pay now, so every option can say "vs now" */
  const currentRent = useMemo(() => {
    const rentCat = (d.cats || []).find((c) => /rent|mortgage/i.test(c.name));
    if (!rentCat) return 0;
    const byMonth = {};
    for (const t of d.txns || []) {
      if (t.catId !== rentCat.id || t.kind !== "out") continue;
      const m = String(t.date || "").slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + (+t.amount || 0);
    }
    const v = Object.values(byMonth).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }, [d.cats, d.txns]);

  const addWork = async () => {
    if (!wAddr.trim()) return;
    setBusy("work"); setMsg("");
    try {
      const g = await geocode(wAddr.trim());
      const w = { id: uid(), name: wName.trim() || "Work", address: wAddr.trim(), lat: g.lat, lon: g.lon, label: g.label };
      /* every existing option needs a leg to the new workplace */
      const nextOpts = [];
      for (const o of options) {
        let leg = { workId: w.id, km: null, minutes: null, driving: false };
        if (Number.isFinite(o.lat)) {
          try { const r = await routeTo({ lat: o.lat, lon: o.lon }, w); leg = { workId: w.id, ...r }; } catch { /* keep the null leg */ }
        }
        nextOpts.push({ ...o, legs: [...(o.legs || []), leg] });
      }
      save({ works: [...works, w], options: nextOpts });
      setWName(""); setWAddr("");
    } catch (e) { setMsg(e.message); }
    setBusy("");
  };
  const removeWork = (id) => save({
    works: works.filter((w) => w.id !== id),
    options: options.map((o) => ({ ...o, legs: (o.legs || []).filter((l) => l.workId !== id) })),
  });

  const addOption = async () => {
    if (!form.address.trim()) { setMsg("An address is what makes the commute real. Add one."); return; }
    setBusy("opt"); setMsg("");
    try {
      const g = await geocode(form.address.trim());
      const legs = [];
      for (const w of works) {
        try { legs.push({ workId: w.id, ...(await routeTo(g, w)) }); }
        catch { legs.push({ workId: w.id, km: null, minutes: null, driving: false }); }
      }
      const o = { id: uid(), ...form, name: form.name.trim() || form.address.trim().split(",")[0],
        lat: g.lat, lon: g.lon, label: g.label, legs, added: new Date().toISOString().slice(0, 10) };
      save({ options: [...options, o] });
      setForm(BLANK); setOpen(false);
    } catch (e) { setMsg(e.message); }
    setBusy("");
  };
  const removeOption = (id) => save({ options: options.filter((o) => o.id !== id) });

  const ranked = useMemo(
    () => rank(options, works, takeHome, { daysPerWeek: Number(H.daysPerWeek) || 5 }),
    [options, works, takeHome, H.daysPerWeek]);
  const f = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div>
      <div className="note" style={{ marginTop: 0 }}>
        Rent is the number a listing shows you. <b>Total monthly cost</b>, with utilities and the real driving
        commute to everywhere you work, is the number that decides it. Add where you work, then every place
        you are considering. Listing sites block lookups, so the details are pasted in by hand.
      </div>

      <div className="row" style={{ gap: 8, alignItems: "baseline", marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>Where you work</b>
        <span className="note" style={{ margin: 0, fontSize: 12 }}>one or several; the commute is averaged across them</span>
      </div>
      <div className="sglist" style={{ marginTop: 6 }}>
        {works.map((w) => (
          <div key={w.id} className="sgrow">
            <div style={{ minWidth: 0, flex: 1 }}>
              <b style={{ fontSize: 13 }}>{w.name}</b>
              <div className="note" style={{ margin: "2px 0 0", fontSize: 12 }}>{w.label || w.address}</div>
            </div>
            <button className="btn small" onClick={() => removeWork(w.id)} title="Remove">Remove</button>
          </div>
        ))}
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="in" style={{ width: 140 }} placeholder="Name (e.g. Optiv)" value={wName} onChange={(e) => setWName(e.target.value)} />
          <input className="in" style={{ flex: 1, minWidth: 220 }} placeholder="Work address, with city and state" value={wAddr}
            onChange={(e) => setWAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWork()} />
          <button className="btn small primary" disabled={!!busy || !wAddr.trim()} onClick={addWork}>
            {busy === "work" ? "Finding..." : "Add workplace"}</button>
          <span className="note" style={{ margin: 0, fontSize: 12 }}>Days on site per week</span>
          <input className="in" type="number" min="0" max="7" style={{ width: 60 }} value={H.daysPerWeek ?? 5}
            onChange={(e) => save({ daysPerWeek: Math.max(0, Math.min(7, Number(e.target.value) || 0)) })} />
        </div>
      </div>

      <div className="row" style={{ gap: 8, alignItems: "baseline", marginTop: 16, justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <b style={{ fontSize: 13 }}>Places you are considering</b>
          {takeHome > 0
            ? <span className="note" style={{ margin: 0, fontSize: 12 }}>against {money(takeHome)}/mo take-home{currentRent ? ", paying " + money(currentRent) + " now" : ""}</span>
            : <span className="note" style={{ margin: 0, fontSize: 12 }}>set monthly take-home in Settings to see affordability</span>}
        </span>
        <button className={"btn small" + (open ? "" : " primary")} onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "+ Add a place"}</button>
      </div>

      {open && (
        <div className="sgrow" style={{ marginTop: 8, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="in" style={{ width: 160 }} placeholder="Nickname" value={form.name} onChange={f("name")} />
            <input className="in" style={{ flex: 1, minWidth: 240 }} placeholder="Address, with city and state" value={form.address} onChange={f("address")} />
            <select className="in" value={form.type} onChange={f("type")}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="in mono" type="number" style={{ width: 110 }} placeholder="Rent /mo" value={form.rent} onChange={f("rent")} />
            <input className="in mono" type="number" style={{ width: 120 }} placeholder="Utilities est." value={form.utilities} onChange={f("utilities")} />
            <input className="in mono" type="number" style={{ width: 110 }} placeholder="Deposit" value={form.deposit} onChange={f("deposit")} />
            <input className="in mono" type="number" style={{ width: 70 }} placeholder="Beds" value={form.beds} onChange={f("beds")} />
            <input className="in mono" type="number" style={{ width: 70 }} placeholder="Baths" value={form.baths} onChange={f("baths")} />
            <input className="in mono" type="number" style={{ width: 80 }} placeholder="Sq ft" value={form.sqft} onChange={f("sqft")} />
            <select className="in" value={form.difficulty} onChange={f("difficulty")} title="How hard it looks to actually get">
              {DIFFICULTY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input className="in" type="date" style={{ width: 150 }} value={form.available} onChange={f("available")} title="Available from" />
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="in" style={{ flex: 1, minWidth: 200 }} placeholder="Listing link" value={form.link} onChange={f("link")} />
            <input className="in" style={{ flex: 2, minWidth: 200 }} placeholder="Notes: parking, pets, lease length, what you noticed" value={form.notes} onChange={f("notes")} />
            <button className="btn small primary" disabled={!!busy} onClick={addOption}>{busy === "opt" ? "Finding + routing..." : "Add"}</button>
          </div>
          <div className="note" style={{ margin: 0, fontSize: 11.5 }}>
            {DIFFICULTY.find(([k]) => k === form.difficulty)?.[2]}
          </div>
        </div>
      )}
      {msg && <div className="note bad" style={{ marginTop: 6 }}>{msg}</div>}

      {!ranked.length && !open && <div className="note" style={{ marginTop: 10 }}>Nothing added yet.</div>}
      <div className="sglist" style={{ marginTop: 10 }}>
        {ranked.map((o, i) => {
          const t = o._t;
          const aff = affordability(t.total, takeHome);
          const cm = t.commuteDetail;
          const best = i === 0 && ranked.length > 1;
          return (
            <div key={o.id} className="sgrow" style={{ borderColor: best ? "var(--up)" : undefined, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                    {best && <span className="pill" style={{ borderColor: "var(--up)", color: "var(--up)" }}>best all-in</span>}
                    <b style={{ fontSize: 14 }}>{o.name}</b>
                    <span className="pill">{o.type}</span>
                    {(o.beds || o.baths) && <span className="note" style={{ margin: 0, fontSize: 12 }}>
                      {o.beds || "?"} bd, {o.baths || "?"} ba{o.sqft ? ", " + o.sqft + " sq ft" : ""}</span>}
                    {o.difficulty === "hard" && <span className="pill" style={{ borderColor: "var(--down)", color: "var(--down)" }}>competitive</span>}
                    {o.difficulty === "easy" && <span className="pill" style={{ borderColor: "var(--up)", color: "var(--up)" }}>easy to get</span>}
                  </div>
                  <div className="note" style={{ margin: "2px 0 0", fontSize: 12 }}>{o.label || o.address}{o.available ? " (from " + o.available + ")" : ""}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{money(t.total)}<span className="note" style={{ fontSize: 11, margin: 0 }}> /mo all-in</span></div>
                  <div className="note" style={{ margin: 0, fontSize: 11.5 }}>
                    {money(t.rent)} rent{t.utilities ? " + " + money(t.utilities) + " utilities" : ""}{t.commute ? " + " + money(t.commute) + " commute" : ""}
                  </div>
                  {aff.pct != null && <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: BAND[aff.band] }}>{aff.pct}% of take-home</div>}
                  {currentRent > 0 && <div className="note" style={{ margin: 0, fontSize: 11 }}>{t.rent > currentRent ? "+" : ""}{money(t.rent - currentRent)} vs now</div>}
                </div>
              </div>
              {works.length > 0 && (
                <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                  {works.map((w) => {
                    const leg = (cm.legs || []).find((l) => l.workId === w.id);
                    if (!leg || !Number.isFinite(leg.km)) return <span key={w.id} className="note" style={{ margin: 0, fontSize: 12 }}>{w.name}: no route</span>;
                    return (
                      <span key={w.id} className="note" style={{ margin: 0, fontSize: 12 }}>
                        <b>{w.name}</b>: {leg.miles} mi{leg.minutes != null ? ", " + leg.minutes + " min drive" : " straight line"}
                      </span>
                    );
                  })}
                  {cm.miles != null && <span className="note" style={{ margin: 0, fontSize: 12 }}>
                    {cm.miles.toLocaleString()} mi/mo at ${IRS_MILE}/mi{cm.minutes != null ? ", " + Math.round(cm.minutes / 60) + " h/mo driving" : ""}
                  </span>}
                </div>
              )}
              <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {o.deposit && <span className="note" style={{ margin: 0, fontSize: 12 }}>deposit {money(o.deposit)}</span>}
                {o.notes && <span className="note" style={{ margin: 0, fontSize: 12 }}>{o.notes}</span>}
                {o.link && <a className="btn small" href={o.link} target="_blank" rel="noreferrer">Listing</a>}
                <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => removeOption(o.id)}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      {ranked.length > 0 && (
        <div className="note" style={{ fontSize: 11.5, marginTop: 8 }}>
          Ranked by all-in monthly cost, with a mild penalty for commute time and for listings marked competitive.
          Commute uses the IRS all-in mileage rate, which includes wear and insurance rather than just fuel.
          Driving times come from OpenStreetMap routing. A leg marked "straight line" means the router was
          unavailable and the distance is as the crow flies.
        </div>
      )}
    </div>
  );
}
