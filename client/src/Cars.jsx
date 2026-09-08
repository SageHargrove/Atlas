import React, { useMemo, useState } from "react";
import { SELLERS, TIER_LABEL, rank, maxPrice, replacement, tierFor, brandKey } from "./carMath.js";

/* Car search and replacement planning.

   No feed, for the same reason as housing: Autotrader, Cars.com and Marketplace
   block scraping and say so. What this does is rank the listings you paste in
   the way a careful buyer would, with your priorities weighing in VISIBLY. A
   preferred brand or model gets a mark and extra weight; it never hides the
   others, because the point of a preference is to notice the exception. */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const EMPTY = {
  budget: { mode: "monthly", maxPrice: 20000, monthly: 350, aprPct: 6.99, months: 60, down: 2000 },
  prefs: { brands: ["Toyota", "Honda"], models: ["Corolla", "Civic"] },
  current: { year: "", make: "", model: "", mileage: "", milesPerYear: 12000 },
  options: [],
};
const BLANK = { year: "", make: "", model: "", trim: "", mileage: "", price: "", seller: "franchise", location: "", link: "", notes: "" };
const TIER_CLR = { 1: "var(--up)", 2: "var(--up)", 3: "var(--gold)", 4: "var(--down)", 5: "var(--down)" };

function Chips({ list, onRemove, onAdd, placeholder }) {
  const [v, setV] = useState("");
  const add = () => { const t = v.trim(); if (t && !list.map((x) => x.toLowerCase()).includes(t.toLowerCase())) onAdd(t); setV(""); };
  return (
    <div className="row" style={{ gap: 5, flexWrap: "wrap", alignItems: "center" }}>
      {list.map((x) => (
        <span key={x} className="achip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
          {"★ "}{x}<button onClick={() => onRemove(x)} title="Remove">{"×"}</button>
        </span>
      ))}
      <input className="in" style={{ width: 130 }} placeholder={placeholder} value={v}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} onBlur={add} />
    </div>
  );
}

export default function Cars({ d, setD }) {
  const C = { ...EMPTY, ...(d.cars || {}) };
  const budget = { ...EMPTY.budget, ...(C.budget || {}) };
  const prefs = { ...EMPTY.prefs, ...(C.prefs || {}) };
  const cur = { ...EMPTY.current, ...(C.current || {}) };
  const options = C.options || [];
  const save = (patch) => setD((p) => ({ ...p, cars: { ...EMPTY, ...(p.cars || {}), ...patch } }));
  const setBudget = (patch) => save({ budget: { ...budget, ...patch } });
  const setCur = (patch) => save({ current: { ...cur, ...patch } });

  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);
  const [showWhy, setShowWhy] = useState(null);

  /* the effective cap: a monthly budget becomes a sticker price through the
     same amortisation the loan card uses */
  const cap = budget.mode === "monthly"
    ? maxPrice({ monthly: budget.monthly, aprPct: budget.aprPct, months: budget.months, down: budget.down })
    : Number(budget.maxPrice) || 0;

  /* prefill "what you drive now" from an asset that looks like a car */
  const carAsset = useMemo(() => (d.accounts || []).find((a) => a.type === "Other asset" && /^(19|20)\d{2}\b/.test(a.name || "")), [d.accounts]);
  const curYear = cur.year || (carAsset ? carAsset.name.match(/^(19|20)\d{2}/)?.[0] : "");
  const curModel = cur.model || (carAsset ? carAsset.name.replace(/^(19|20)\d{2}\s*/, "").split(" ")[0] : "");
  const rep = useMemo(() => (curYear && cur.mileage)
    ? replacement({ year: curYear, mileage: cur.mileage, milesPerYear: cur.milesPerYear, make: cur.make })
    : null, [curYear, cur.mileage, cur.milesPerYear, cur.make]);

  const ranked = useMemo(() => rank(options, prefs, { maxPrice: cap }), [options, prefs, cap]);
  const f = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const addCar = () => {
    if (!form.make.trim() || !form.price) return;
    save({ options: [...options, { id: uid(), ...form, added: new Date().toISOString().slice(0, 10) }] });
    setForm(BLANK); setOpen(false);
  };

  return (
    <div>
      <div className="note" style={{ marginTop: 0 }}>
        Paste in the cars you are looking at and they are ranked against your budget, mileage, age, the brand's
        reliability record, and how much the seller can be trusted. Your preferred brands and models get a
        {" ★ "}and extra weight, but nothing is hidden. Listing sites block lookups, so this is by hand.
      </div>

      {/* ---- what you drive now ---- */}
      <div className="sgrow" style={{ marginTop: 12, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <b style={{ fontSize: 13 }}>What you drive now</b>
          <span className="note" style={{ margin: 0, fontSize: 12 }}>so this can say when to start planning, not just what to buy</span>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="in mono" type="number" style={{ width: 80 }} placeholder="Year" value={curYear} onChange={(e) => setCur({ year: e.target.value })} />
          <input className="in" style={{ width: 110 }} placeholder="Make" value={cur.make} onChange={(e) => setCur({ make: e.target.value })} />
          <input className="in" style={{ width: 120 }} placeholder="Model" value={curModel} onChange={(e) => setCur({ model: e.target.value })} />
          <input className="in mono" type="number" style={{ width: 110 }} placeholder="Mileage now" value={cur.mileage} onChange={(e) => setCur({ mileage: e.target.value })} />
          <span className="note" style={{ margin: 0, fontSize: 12 }}>miles per year</span>
          <input className="in mono" type="number" style={{ width: 90 }} value={cur.milesPerYear} onChange={(e) => setCur({ milesPerYear: e.target.value })} />
        </div>
        {rep ? (
          <div>
            <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 600 }}>{rep.pctUsed}% of typical life used</span>
              <span className="note" style={{ margin: 0, fontSize: 12 }}>
                {tierFor(cur.make) ? TIER_LABEL[rep.tier] + " reliability" : ""}: about {rep.life.toLocaleString()} mi typical,
                {" "}{rep.milesLeft.toLocaleString()} left, roughly {rep.yearsLeft} years at your pace, so around <b>{rep.targetYear}</b>.
              </span>
            </div>
            <div style={{ height: 6, background: "var(--line2)", borderRadius: 3, margin: "6px 0" }}>
              <div style={{ width: rep.pctUsed + "%", height: "100%", borderRadius: 3, background: rep.pctUsed < 65 ? "var(--up)" : rep.pctUsed < 85 ? "var(--gold)" : "var(--down)" }} />
            </div>
            <div className="note" style={{ margin: 0, fontSize: 12 }}>{rep.read}</div>
          </div>
        ) : <div className="note" style={{ margin: 0, fontSize: 12 }}>Add the mileage to get a replacement read.</div>}
      </div>

      {/* ---- budget and priorities ---- */}
      <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "stretch" }}>
        <div className="sgrow" style={{ flex: 1, minWidth: 300, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="row" style={{ gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
            <b style={{ fontSize: 13 }}>Budget</b>
            <span className="pills">
              <button className={"pill" + (budget.mode === "monthly" ? " on" : "")} onClick={() => setBudget({ mode: "monthly" })}>By payment</button>
              <button className={"pill" + (budget.mode === "price" ? " on" : "")} onClick={() => setBudget({ mode: "price" })}>By price</button>
            </span>
          </div>
          {budget.mode === "monthly" ? (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input className="in mono" type="number" style={{ width: 90 }} value={budget.monthly} onChange={(e) => setBudget({ monthly: Number(e.target.value) || 0 })} title="Monthly payment" />
              <span className="note" style={{ margin: 0, fontSize: 12 }}>/mo at</span>
              <input className="in mono" type="number" step="0.01" style={{ width: 70 }} value={budget.aprPct} onChange={(e) => setBudget({ aprPct: Number(e.target.value) || 0 })} title="APR %" />
              <span className="note" style={{ margin: 0, fontSize: 12 }}>% for</span>
              <input className="in mono" type="number" style={{ width: 60 }} value={budget.months} onChange={(e) => setBudget({ months: Number(e.target.value) || 0 })} title="Months" />
              <span className="note" style={{ margin: 0, fontSize: 12 }}>mo, down</span>
              <input className="in mono" type="number" style={{ width: 90 }} value={budget.down} onChange={(e) => setBudget({ down: Number(e.target.value) || 0 })} title="Down payment" />
              <span className="mono" style={{ fontWeight: 600, marginLeft: "auto" }}>up to {money(cap)}</span>
            </div>
          ) : (
            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              <span className="note" style={{ margin: 0, fontSize: 12 }}>Max price</span>
              <input className="in mono" type="number" style={{ width: 110 }} value={budget.maxPrice} onChange={(e) => setBudget({ maxPrice: Number(e.target.value) || 0 })} />
            </div>
          )}
        </div>
        <div className="sgrow" style={{ flex: 1, minWidth: 300, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <b style={{ fontSize: 13 }}>Priorities</b>
          <span className="note" style={{ margin: 0, fontSize: 12 }}>Brands</span>
          <Chips list={prefs.brands} placeholder="Add a brand" onAdd={(x) => save({ prefs: { ...prefs, brands: [...prefs.brands, x] } })}
            onRemove={(x) => save({ prefs: { ...prefs, brands: prefs.brands.filter((b) => b !== x) } })} />
          <span className="note" style={{ margin: 0, fontSize: 12 }}>Models</span>
          <Chips list={prefs.models} placeholder="Add a model" onAdd={(x) => save({ prefs: { ...prefs, models: [...prefs.models, x] } })}
            onRemove={(x) => save({ prefs: { ...prefs, models: prefs.models.filter((b) => b !== x) } })} />
        </div>
      </div>

      {/* ---- listings ---- */}
      <div className="row" style={{ gap: 8, alignItems: "baseline", marginTop: 16, justifyContent: "space-between" }}>
        <b style={{ fontSize: 13 }}>Cars you are looking at</b>
        <button className={"btn small" + (open ? "" : " primary")} onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "+ Add a car"}</button>
      </div>
      {open && (
        <div className="sgrow" style={{ marginTop: 8, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="in mono" type="number" style={{ width: 80 }} placeholder="Year" value={form.year} onChange={f("year")} />
            <input className="in" style={{ width: 110 }} placeholder="Make" value={form.make} onChange={f("make")} />
            <input className="in" style={{ width: 120 }} placeholder="Model" value={form.model} onChange={f("model")} />
            <input className="in" style={{ width: 90 }} placeholder="Trim" value={form.trim} onChange={f("trim")} />
            <input className="in mono" type="number" style={{ width: 100 }} placeholder="Mileage" value={form.mileage} onChange={f("mileage")} />
            <input className="in mono" type="number" style={{ width: 100 }} placeholder="Price" value={form.price} onChange={f("price")} />
            <select className="in" value={form.seller} onChange={f("seller")} title="Who is selling it">
              {SELLERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="in" style={{ width: 160 }} placeholder="Location" value={form.location} onChange={f("location")} />
            <input className="in" style={{ flex: 1, minWidth: 180 }} placeholder="Listing link" value={form.link} onChange={f("link")} />
            <input className="in" style={{ flex: 2, minWidth: 200 }} placeholder="Notes: accidents, owners, service history, what you noticed" value={form.notes} onChange={f("notes")} />
            <button className="btn small primary" disabled={!form.make.trim() || !form.price} onClick={addCar}>Add</button>
          </div>
          <div className="note" style={{ margin: 0, fontSize: 11.5 }}>{SELLERS.find(([k]) => k === form.seller)?.[3]}</div>
        </div>
      )}

      {!ranked.length && !open && <div className="note" style={{ marginTop: 10 }}>Nothing added yet.</div>}
      <div className="sglist" style={{ marginTop: 10 }}>
        {ranked.map((c, i) => {
          const s = c._s;
          const over = cap > 0 && Number(c.price) > cap;
          const sellerRow = SELLERS.find(([k]) => k === c.seller) || SELLERS[2];
          return (
            <div key={c.id} className="sgrow" style={{ borderColor: i === 0 && ranked.length > 1 ? "var(--up)" : undefined, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                    {(s.brandHit || s.modelHit) && <span title={s.modelHit ? "Preferred model" : "Preferred brand"} style={{ color: "var(--gold)", fontSize: 15 }}>{"★"}</span>}
                    <b style={{ fontSize: 14 }}>{c.year} {c.make} {c.model}{c.trim ? " " + c.trim : ""}</b>
                    <span className="pill" style={{ borderColor: TIER_CLR[s.tier], color: TIER_CLR[s.tier] }}>{TIER_LABEL[s.tier]} reliability</span>
                    <span className="pill">{sellerRow[1]}</span>
                    {over && <span className="pill" style={{ borderColor: "var(--down)", color: "var(--down)" }}>over budget</span>}
                  </div>
                  <div className="note" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    {Number(c.mileage) ? Number(c.mileage).toLocaleString() + " mi" : "mileage unknown"}{s.age ? ", " + s.age + " yr" + (s.age === 1 ? "" : "s") + " old" : ""}
                    {c.location ? ", " + c.location : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{money(c.price)}</div>
                  {cap > 0 && <div className="note" style={{ margin: 0, fontSize: 11.5 }}>{over ? "+" : ""}{money(Number(c.price) - cap)} vs budget</div>}
                  <div className="row" style={{ gap: 6, alignItems: "center", justifyContent: "flex-end", marginTop: 2 }}>
                    <div style={{ width: 90, height: 6, background: "var(--line2)", borderRadius: 3 }}>
                      <div style={{ width: s.total + "%", height: "100%", borderRadius: 3, background: s.total >= 70 ? "var(--up)" : s.total >= 45 ? "var(--gold)" : "var(--down)" }} />
                    </div>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{s.total}</span>
                    <button className="btn small" onClick={() => setShowWhy(showWhy === c.id ? null : c.id)} title="What went into this score">why</button>
                  </div>
                </div>
              </div>
              {showWhy === c.id && (
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  {Object.entries(s.parts).map(([k, v]) => (
                    <span key={k} className="note" style={{ margin: 0, fontSize: 12 }}><b>{k}</b> {v}</span>
                  ))}
                  <span className="note" style={{ margin: 0, fontSize: 12 }}>{sellerRow[3]}</span>
                </div>
              )}
              <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {c.notes && <span className="note" style={{ margin: 0, fontSize: 12 }}>{c.notes}</span>}
                {c.link && <a className="btn small" href={c.link} target="_blank" rel="noreferrer">Listing</a>}
                <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => save({ options: options.filter((x) => x.id !== c.id) })}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      {ranked.length > 0 && (
        <div className="note" style={{ fontSize: 11.5, marginTop: 8 }}>
          Score out of 100: price against budget, mileage, age, brand reliability tier, and seller trust, plus a
          bonus for your preferred brands and models. The reliability tiers are a coarse built-in table reflecting
          the broad consensus of the major surveys, not live data. Look up the specific model year before buying.
          Whatever the seller, a pre-purchase inspection by an independent mechanic is the cheapest insurance there is.
        </div>
      )}
    </div>
  );
}
