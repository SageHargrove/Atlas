import React, { useState, useMemo, useEffect } from "react";

/* ------------------------------------------------------------------
   Career tab — the IAM job tracker, moved into Atlas.

   The domain logic is kept as-written (seed list, COL-adjusted tiers,
   fit rules, hiring windows, board routing). Two things changed on the
   way in, both mandatory:

   1. AI calls go through Atlas's /api/ai proxy. The standalone version
      POSTed to api.anthropic.com from the browser, which only works
      inside a Claude artifact — and would mean shipping a key to the
      client anywhere else. The proxy already holds the key server-side,
      enforces per-user daily caps, and adds web search.
   2. Data lives in the same per-user file as the money side instead of
      localStorage, so it syncs across devices, rides along in the
      encrypted backups, and survives clearing your browser.

   Being in Atlas also buys the thing a standalone tracker can't do:
   an offer's effect on your actual budget, runway and goals.
------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const money = (n) => (n == null || n === "" || isNaN(n) ? "—" : "$" + Math.round(Number(n) / 1000) + "k");
const dollars = (n) => (n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());

const STATUSES = ["Target", "Applied", "Interviewing", "Offer", "Rejected", "Withdrawn"];
const CLEARANCES = ["Not required", "Required", "Preferred", "Unsure"];
const LOC_TYPES = ["Remote", "Hybrid", "Onsite"];
const TIERS = ["1", "2", "3"];

const DEFAULT_CITIES = [
  { name: "San Antonio", tier: "S", col: 91 }, { name: "Tampa", tier: "S", col: 97 },
  { name: "Dallas", tier: "A", col: 99 }, { name: "Fort Worth", tier: "A", col: 96 },
  { name: "DFW", tier: "A", col: 98 }, { name: "Orlando", tier: "A", col: 99 },
  { name: "Houston", tier: "A", col: 94 }, { name: "Little Rock", tier: "A", col: 86 },
  { name: "Washington DC", tier: "B", col: 140 }, { name: "Arlington VA", tier: "B", col: 145 },
  { name: "Columbus", tier: "B", col: 92 }, { name: "St. Louis", tier: "B", col: 88 },
  { name: "Jacksonville", tier: "B", col: 93 }, { name: "Atlanta", tier: "C", col: 99 },
  { name: "Cincinnati", tier: "C", col: 91 }, { name: "Omaha", tier: "C", col: 90 },
  { name: "Miami", tier: "C", col: 117 }, { name: "Seattle", tier: "C", col: 150 },
  { name: "Bay Area", tier: "C", col: 180 }, { name: "New York", tier: "C", col: 168 },
  { name: "San Diego", tier: "A", col: 144 }, { name: "Chicago", tier: "A", col: 107 },
  { name: "Oklahoma City", tier: "A", col: 86 }, { name: "Wichita", tier: "A", col: 84 },
  { name: "Indianapolis", tier: "A", col: 92 }, { name: "Minneapolis", tier: "A", col: 100 },
  { name: "Toledo", tier: "A", col: 84 }, { name: "Colorado Springs", tier: "B", col: 102 },
  { name: "Denver", tier: "B", col: 111 }, { name: "Phoenix", tier: "B", col: 104 },
  { name: "Tucson", tier: "B", col: 93 }, { name: "Albuquerque", tier: "B", col: 92 },
  { name: "Tulsa", tier: "B", col: 85 }, { name: "Kansas City", tier: "B", col: 92 },
  { name: "Memphis", tier: "B", col: 85 }, { name: "Nashville", tier: "B", col: 100 },
  { name: "Knoxville", tier: "B", col: 89 }, { name: "Louisville", tier: "B", col: 91 },
  { name: "Cleveland", tier: "B", col: 89 }, { name: "Detroit", tier: "B", col: 91 },
  { name: "Pittsburgh", tier: "B", col: 93 }, { name: "Philadelphia", tier: "B", col: 104 },
  { name: "Baltimore", tier: "B", col: 106 }, { name: "Greensboro", tier: "B", col: 90 },
  { name: "Columbia SC", tier: "B", col: 89 }, { name: "Salt Lake City", tier: "B", col: 108 },
  { name: "Portland", tier: "B", col: 116 }, { name: "Milwaukee", tier: "B", col: 95 },
  { name: "Providence", tier: "B", col: 112 }, { name: "Fort Wayne", tier: "B", col: 84 },
  { name: "Fresno", tier: "B", col: 100 }, { name: "Boston", tier: "B", col: 148 },
  { name: "Los Angeles", tier: "B", col: 148 }, { name: "Austin", tier: "A", col: 103 },
  { name: "Ruston", tier: "A", col: 84 },
];

/* [company, tier, clearance, expected comp, city, locType?] */
const SEED = [
  ["SPP (Southwest Power Pool)", "1", "Not required", 66000, "Little Rock"],
  ["AEP", "1", "Not required", 72000, "Columbus"],
  ["Ameren", "1", "Not required", 72000, "St. Louis"],
  ["Southern Company", "1", "Not required", 76000, "Atlanta"],
  ["Oncor", "1", "Not required", 75000, "Dallas"],
  ["CenterPoint Energy", "1", "Not required", 74000, "Houston"],
  ["Duke Energy", "1", "Not required", 78000, ""],
  ["Evergy", "1", "Not required", 70000, ""],
  ["ERCOT", "1", "Not required", 82000, "Austin"],
  ["Entergy", "1", "Not required", 72000, "Little Rock"],
  ["MISO", "1", "Not required", 76000, "Little Rock"],
  ["Exelon", "1", "Not required", 78000, ""],
  ["Dominion Energy", "1", "Not required", 74000, ""],
  ["NextEra", "1", "Not required", 76000, ""],
  ["TVA", "1", "Not required", 70000, ""],
  ["Simeio", "1", "Not required", 85000, "", "Remote"],
  ["Optiv", "1", "Not required", 84000, "", "Remote"],
  ["GuidePoint Security", "1", "Not required", 85000, "", "Remote"],
  ["SDG", "1", "Not required", 80000, "", "Remote"],
  ["Edgile / Wipro", "1", "Not required", 78000, "", "Remote"],
  ["IDMWORKS", "1", "Not required", 82000, "", "Remote"],
  ["KeyData", "1", "Not required", 80000, "", "Remote"],
  ["iC Consult", "1", "Not required", 82000, "", "Remote"],
  ["Deloitte Identity", "1", "Not required", 80000, "", "Remote"],
  ["PwC Identity", "1", "Not required", 80000, "", "Remote"],
  ["EY Identity", "1", "Not required", 78000, "", "Remote"],
  ["KPMG Identity", "1", "Not required", 78000, "", "Remote"],
  ["Protiviti", "1", "Not required", 78000, "", "Remote"],
  ["WWT", "1", "Not required", 78000, "St. Louis"],
  ["CDW", "1", "Not required", 75000, "", "Remote"],
  ["Slalom", "1", "Not required", 80000, "", "Remote"],
  ["MITRE", "2", "Required", 92000, ""],
  ["Booz Allen", "2", "Required", 72000, ""],
  ["NSA Development Programs", "2", "Required", 68000, "San Antonio"],
  ["Lockheed Martin (Fort Worth)", "2", "Required", 82000, "Fort Worth"],
  ["Lockheed Martin (Orlando)", "2", "Required", 82000, "Orlando"],
  ["Northrop Grumman", "2", "Required", 82000, ""],
  ["L3Harris", "2", "Required", 80000, "Orlando"],
  ["SAIC", "2", "Required", 78000, ""],
  ["Leidos", "2", "Required", 78000, ""],
  ["CACI", "2", "Required", 76000, ""],
  ["Peraton", "2", "Required", 76000, ""],
  ["Accenture Federal", "2", "Required", 75000, ""],
  ["Deloitte GPS", "2", "Required", 75000, ""],
  ["AF Civilian Cyber (JBSA)", "2", "Required", 62000, "San Antonio"],
  ["Edward Jones", "2", "Not required", 74000, "St. Louis"],
  ["Charles Schwab", "2", "Not required", 80000, "Dallas"],
  ["Fidelity", "2", "Not required", 82000, "Dallas"],
  ["Comerica", "2", "Not required", 74000, "Dallas"],
  ["Bank of America", "2", "Not required", 82000, ""],
  ["Wells Fargo", "2", "Not required", 80000, ""],
  ["Discover", "2", "Not required", 82000, ""],
  ["Raymond James", "2", "Not required", 74000, "Tampa"],
  ["FIS", "2", "Not required", 72000, "Jacksonville"],
  ["Bank OZK", "2", "Not required", 68000, "Little Rock"],
  ["Simmons Bank", "2", "Not required", 66000, "Little Rock"],
  ["AT&T", "3", "Not required", 78000, "Dallas"],
  ["Southwest Airlines", "3", "Not required", 76000, "Dallas"],
  ["American Airlines", "3", "Not required", 76000, "Fort Worth"],
  ["Toyota North America", "3", "Not required", 80000, "Dallas"],
  ["H-E-B", "3", "Not required", 76000, "San Antonio"],
  ["Valero", "3", "Not required", 76000, "San Antonio"],
  ["Rackspace", "3", "Not required", 72000, "San Antonio"],
  ["Home Depot", "3", "Not required", 80000, "Atlanta"],
  ["Delta", "3", "Not required", 76000, "Atlanta"],
  ["NCR", "3", "Not required", 72000, "Atlanta"],
  ["Global Payments", "3", "Not required", 74000, "Atlanta"],
  ["Equifax", "3", "Not required", 76000, "Atlanta"],
  ["Kroger", "3", "Not required", 72000, "Cincinnati"],
  ["P&G", "3", "Not required", 80000, "Cincinnati"],
  ["GE Aerospace", "3", "Not required", 78000, "Cincinnati"],
  ["Boeing", "3", "Not required", 82000, "St. Louis"],
  ["Centene", "3", "Not required", 74000, "St. Louis"],
  ["Emerson", "3", "Not required", 74000, "St. Louis"],
  ["Union Pacific", "3", "Not required", 76000, "Omaha"],
  ["Mutual of Omaha", "3", "Not required", 72000, "Omaha"],
  ["Jabil", "3", "Not required", 72000, "Tampa"],
  ["ReliaQuest", "3", "Not required", 70000, "Tampa"],
  ["Windstream", "3", "Not required", 68000, "Little Rock"],
  ["Acxiom", "3", "Not required", 70000, "Little Rock"],
  ["Arkansas BCBS", "3", "Not required", 66000, "Little Rock"],
  ["Disney Corporate Security", "3", "Not required", 74000, "Orlando"],
  ["Universal Corporate Security", "3", "Not required", 72000, "Orlando"],
  ["Florida Blue", "3", "Not required", 70000, "Jacksonville"],
  ["CSX", "3", "Not required", 74000, "Jacksonville"],
  ["SailPoint", "Lottery", "Not required", 95000, "Austin"],
  ["Okta", "Lottery", "Not required", 115000, "", "Remote"],
  ["Saviynt", "Lottery", "Not required", 90000, "", "Remote"],
  ["Google", "Lottery", "Not required", 190000, "Bay Area"],
  ["Amazon", "Lottery", "Not required", 160000, "Seattle"],
  ["Microsoft", "Lottery", "Not required", 155000, "Seattle"],
  ["Meta", "Lottery", "Not required", 200000, "Bay Area"],
  ["Jane Street", "Lottery", "Not required", 325000, "New York"],
  ["Hudson River Trading", "Lottery", "Not required", 300000, "New York"],
  ["Citadel", "Lottery", "Not required", 300000, "Chicago"],
  ["Jump Trading", "Lottery", "Not required", 275000, "Chicago"],
  ["Optiver", "Lottery", "Not required", 250000, "Chicago"],
  ["Two Sigma", "Lottery", "Not required", 235000, "New York"],
  ["DRW", "Lottery", "Not required", 235000, "Chicago"],
  ["IMC Trading", "Lottery", "Not required", 235000, "Chicago"],
  ["SIG (Susquehanna)", "Lottery", "Not required", 210000, "Philadelphia"],
  ["Akuna Capital", "Lottery", "Not required", 190000, "Chicago"],
];

const QUANT = new Set(["jane street", "hudson river trading", "citadel", "jump trading", "optiver",
  "two sigma", "drw", "imc trading", "sig (susquehanna)", "akuna capital"]);
const CAT_EXTRAS = { utility: 14, cleared: 6, financial: 10, consulting: 6, enterprise: 7, bigtech: 0, quant: 0 };
const SEED_EXTRAS = { "spp (southwest power pool)": 18, mitre: 8, "nsa development programs": 12, "af civilian cyber (jbsa)": 12 };
const CAT_GROWTH = {
  consulting: [5, "Up-or-out promo culture — fastest comp compounding"],
  bigtech: [4, "Structured ladders; entry→next level typically ~2 yrs"],
  quant: [5, "Flat titles — comp compounds through bonus, not ladder"],
  financial: [3, "Steady ladders, VP-track pacing"],
  cleared: [3, "Clearance depth + program moves drive growth"],
  enterprise: [3, "Slower ladders; lateral moves common"],
  utility: [2, "Stable and seniority-paced; low churn, slower climbs"],
};
const SEED_ROW = Object.fromEntries(SEED.map(([c, tier, clearance, comp, city, locType]) => {
  const cat =
    QUANT.has(c.toLowerCase()) ? "quant" :
    tier === "Lottery" ? "bigtech" :
    tier === "3" ? "enterprise" :
    tier === "2" ? (clearance === "Required" ? "cleared" : "financial") :
    (locType === "Remote" || c === "WWT" ? "consulting" : "utility");
  return [c.toLowerCase(), { comp, city, locType, cat }];
}));
const extrasFor = (company, cat) => SEED_EXTRAS[company.toLowerCase()] ?? CAT_EXTRAS[cat] ?? 0;

const SEED_LINKS = {
  "jane street": "https://www.janestreet.com/join-jane-street/open-roles/",
  "hudson river trading": "https://www.hudsonrivertrading.com/careers/",
  citadel: "https://www.citadel.com/careers/open-opportunities/",
  "jump trading": "https://www.jumptrading.com/careers/",
  optiver: "https://optiver.com/working-at-optiver/career-opportunities/",
  "two sigma": "https://careers.twosigma.com/careers/SearchJobs",
  drw: "https://www.drw.com/work-at-drw/listings",
  "imc trading": "https://careers.imc.com/us/en/search-results",
  "sig (susquehanna)": "https://careers.sig.com/",
  "akuna capital": "https://akunacapital.com/careers",
  google: "https://www.google.com/about/careers/applications/jobs/results/?q=security",
  amazon: "https://www.amazon.jobs/en/search?base_query=security+engineer",
  microsoft: "https://jobs.careers.microsoft.com/global/en/search?q=security",
  meta: "https://www.metacareers.com/jobs?q=security",
  okta: "https://www.okta.com/company/careers/",
  sailpoint: "https://www.sailpoint.com/company/careers/open-positions",
};

const DEFAULT_CAREER = {
  apps: [],
  settings: {
    tierT1: 98000, tierT2: 90000, remoteCol: 90, homeCol: 84,
    takeHomePct: 76, resume: "", referralNames: [],
    families: ["IAM", "Security Ops", "GRC", "Cyber — general"],
    cities: DEFAULT_CITIES,
  },
};

/* ---------------- domain math (unchanged from the original) ---------------- */

function cityMatch(city, cities) {
  if (!city) return null;
  const c = city.trim().toLowerCase();
  return cities.find((x) => { const n = x.name.toLowerCase(); return c === n || c.includes(n) || n.includes(c); }) || null;
}
function computeFit(app, cities) {
  if (app.fitOverride === true) return { fit: true, cityTier: null };
  if (app.fitOverride === false) return { fit: false, cityTier: null };
  if (app.locationType === "Remote") return { fit: true, cityTier: "S" };
  const m = cityMatch(app.city, cities);
  return m ? { fit: true, cityTier: m.tier } : { fit: false, cityTier: null };
}
const colOf = (app, S) => (app.locationType === "Remote" ? S.remoteCol || 90 : (cityMatch(app.city, S.cities)?.col) || 100);
const totalComp = (app) => (app.comp == null || app.comp === "" ? null : Math.round(Number(app.comp) * (1 + (Number(app.extrasPct) || 0) / 100)));
const adjComp = (app, S) => { const t = totalComp(app); return t == null ? null : Math.round(t / (colOf(app, S) / 100)); };
function effTier(app, S) {
  if (app.tierManual && app.tier) return app.tier;
  const adj = adjComp(app, S);
  if (adj == null) return app.tier || "3";
  if (adj >= (S.tierT1 || 98000)) return "1";
  if (adj >= (S.tierT2 || 90000)) return "2";
  return "3";
}
function seedApps() {
  return SEED.map(([company, tier, clearance, comp, city, locType]) => {
    const cat = SEED_ROW[company.toLowerCase()]?.cat || "enterprise";
    return {
      id: uid(), company, role: "IAM / Security — target", status: "Target", dateApplied: "",
      comp, compEst: true, extrasPct: extrasFor(company, cat),
      locationType: locType || (city ? "Onsite" : "Hybrid"), city, clearance,
      tier: tier === "Lottery" ? "3" : tier, tierManual: false, cat,
      growth: CAT_GROWTH[cat]?.[0] ?? null, growthNote: CAT_GROWTH[cat]?.[1] ?? "",
      family: "IAM", source: "Cold", referralName: "", fitOverride: null, nextDate: "",
      window: QUANT.has(company.toLowerCase()) ? "Jul–Sep 2026 — rolling, apply ASAP"
        : tier === "1" ? "Aug–Oct 2026 + rolling" : tier === "2" ? "Aug–Oct 2026"
        : tier === "3" ? "Jan–Apr 2027" : "Aug 2026 — apply early",
      sponsor: clearance === "Required" ? "They sponsor" : "Unknown",
      link: "", notes: "", created: Date.now(),
    };
  });
}
const googleFind = (a) => "https://www.google.com/search?q=" +
  encodeURIComponent('"' + a.company + '" ' + (a.role.includes("target") ? "security new grad 2027" : a.role) + " careers apply");
function findDest(a) {
  const lc = a.company.toLowerCase();
  if (SEED_LINKS[lc]) return { label: "official careers", url: SEED_LINKS[lc] };
  if (a.cat === "quant") return { label: "Google", url: googleFind(a) };
  const kw = a.role.includes("target") ? (a.family || "IAM identity") : a.role;
  if (lc.includes("nsa development")) return { label: "USAJOBS", url: "https://www.usajobs.gov/Search/Results?k=NSA%20cybersecurity" };
  if (lc.includes("af civilian") || lc.includes("jbsa"))
    return { label: "USAJOBS", url: "https://www.usajobs.gov/Search/Results?k=cybersecurity&l=San%20Antonio%2C%20Texas" };
  if (a.cat === "cleared" || a.clearance === "Required")
    return { label: "ClearanceJobs", url: "https://www.clearancejobs.com/jobs?keywords=" + encodeURIComponent(a.company + " " + kw) };
  return { label: "LinkedIn", url: "https://www.linkedin.com/jobs/search/?f_E=2%2C3&f_TPR=r2592000&geoId=103644278&keywords=" + encodeURIComponent('"' + a.company + '" ' + kw) };
}

/* ---------------- AI through Atlas's proxy ---------------- */

async function callClaude(prompt, useSearch) {
  const r = await fetch("/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, search: !!useSearch }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.text || "";
}
function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("["), o = clean.indexOf("{");
  let s = -1, e = -1;
  if (a !== -1 && (o === -1 || a < o)) { s = a; e = clean.lastIndexOf("]"); }
  else if (o !== -1) { s = o; e = clean.lastIndexOf("}"); }
  if (s === -1 || e === -1) throw new Error("No JSON found");
  return JSON.parse(clean.slice(s, e + 1));
}

/* ---------------- UI ---------------- */

function Sheet({ title, onClose, children }) {
  return (
    <div className="ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh"><h2>{title}</h2><button className="x" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

const STATUS_CLR = { Target: "var(--faint)", Applied: "var(--gold)", Interviewing: "var(--acc)", Offer: "var(--up)", Rejected: "var(--red)", Withdrawn: "var(--faint)" };
const FIT_CLR = { Strong: "var(--up)", Good: "var(--acc)", Stretch: "var(--gold)", "Long shot": "var(--red)" };

const BLANK = {
  company: "", role: "", status: "Target", dateApplied: "", comp: "", extrasPct: "", growth: null, growthNote: "",
  locationType: "Onsite", city: "", clearance: "Unsure", tier: "3", tierManual: false, family: "IAM",
  source: "Cold", referralName: "", fitOverride: null, nextDate: "", window: "", link: "", notes: "",
};

function AppForm({ initial, S, resume, onSave, onDelete, onClose, toast }) {
  const [f, setF] = useState({ ...BLANK, ...initial });
  const [busy, setBusy] = useState("");
  const [info, setInfo] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const editing = !!initial?.id;
  const fit = computeFit(f, S.cities);

  const research = async (what) => {
    if (!f.company.trim()) return setInfo("Enter a company first.");
    setBusy(what); setInfo("");
    try {
      if (what === "comp") {
        const out = await callClaude(
          "Search the web for current entry-level / new-grad total compensation for a " +
          (f.role && !f.role.includes("target") ? f.role : "IAM / security analyst") + " role at " + f.company +
          (f.city ? " (" + f.city + ")" : "") + " in the US. Use salary data sites and postings. " +
          'Respond with ONLY JSON (no fences): {"low": number, "high": number, "note": string under 15 words describing the basis}. ' +
          "Annual USD for entry level. If you truly find nothing, give your best market estimate and say so in note.", true);
        const j = extractJSON(out);
        if (j.low && j.high) {
          setF((p) => ({ ...p, comp: Math.round((j.low + j.high) / 2), compEst: false }));
          setInfo("Found " + money(j.low) + "–" + money(j.high) + (j.note ? " — " + j.note : "") + ". Midpoint filled in; edit freely.");
        } else setInfo("Couldn't pin a range — " + (j.note || "enter it manually."));
      } else if (what === "growth") {
        const out = await callClaude(
          "Search the web for how good career growth and internal mobility are at " + f.company +
          " — Glassdoor career-opportunities rating, promotion speed, levels progression. " +
          'Respond with ONLY JSON (no fences): {"score": integer 1-5 (5 = fast promotions, strong mobility), "note": string under 15 words}.', true);
        const j = extractJSON(out);
        if (j.score) setF((p) => ({ ...p, growth: Math.max(1, Math.min(5, Math.round(j.score))), growthNote: j.note || "" }));
        setInfo("Growth " + j.score + "/5 — " + (j.note || ""));
      } else if (what === "fit") {
        if (!resume.trim()) { setInfo("Paste your resume in the Career tab first — fit scoring reads it."); setBusy(""); return; }
        const out = await callClaude(
          "Resume:\n" + resume.slice(0, 6000) +
          "\n\nRole: " + (f.role || "IAM / security analyst") + " at " + f.company +
          (f.city ? " in " + f.city : "") + (f.clearance === "Required" ? " (security clearance required)" : "") +
          "\n\nHonestly rate how strong a candidate this resume is for that role. " +
          'Respond with ONLY JSON (no fences): {"score": integer 1-10, "label": one of "Strong"|"Good"|"Stretch"|"Long shot", ' +
          '"why": string under 20 words, "gaps": [up to 3 short strings naming what is missing]}. Be realistic, not encouraging.');
        const j = extractJSON(out);
        setF((p) => ({ ...p, fitScore: j.score, fitLabel: j.label, fitWhy: j.why, fitBreak: j.gaps || [] }));
        setInfo("Scored " + j.score + "/10 — " + j.label);
      }
    } catch (e) { setInfo(what + " research failed — " + e.message); }
    setBusy("");
  };

  const save = () => {
    if (!f.company.trim() || !f.role.trim()) return setInfo("Company and role are both required.");
    onSave({ ...f, id: f.id || uid(), comp: f.comp === "" || f.comp == null ? null : Number(f.comp), created: f.created || Date.now() });
  };

  return (
    <Sheet title={editing ? "Edit application" : "Add application"} onClose={onClose}>
      <div className="grid2">
        <div><label className="f">Company *</label><input className="in" value={f.company} onChange={(e) => set("company", e.target.value)} /></div>
        <div><label className="f">Role *</label><input className="in" value={f.role} onChange={(e) => set("role", e.target.value)} /></div>
        <div><label className="f">Status</label>
          <select className="in" value={f.status} onChange={(e) => set("status", e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div><label className="f">Date applied</label><input type="date" className="in" value={f.dateApplied} onChange={(e) => set("dateApplied", e.target.value)} /></div>
        <div><label className="f">Comp ($/yr){f.compEst ? " — estimate" : ""}</label>
          <input type="number" className="in mono" value={f.comp ?? ""} onChange={(e) => setF((p) => ({ ...p, comp: e.target.value, compEst: false }))} /></div>
        <div><label className="f">Bonus / benefits uplift %</label>
          <input type="number" className="in mono" placeholder="e.g. 18" value={f.extrasPct ?? ""} onChange={(e) => set("extrasPct", e.target.value)} /></div>
        <div><label className="f">Location type</label>
          <select className="in" value={f.locationType} onChange={(e) => set("locationType", e.target.value)}>{LOC_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
        {f.locationType !== "Remote" && (
          <div><label className="f">City</label><input className="in" value={f.city} onChange={(e) => set("city", e.target.value)} placeholder="e.g. San Antonio" /></div>
        )}
        <div><label className="f">Clearance</label>
          <select className="in" value={f.clearance} onChange={(e) => set("clearance", e.target.value)}>{CLEARANCES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="f">Role family</label>
          <select className="in" value={f.family} onChange={(e) => set("family", e.target.value)}>{(S.families || ["IAM"]).map((x) => <option key={x}>{x}</option>)}</select></div>
        <div><label className="f">Tier</label>
          <select className="in" value={f.tierManual ? f.tier : "auto"}
            onChange={(e) => e.target.value === "auto" ? setF((p) => ({ ...p, tierManual: false })) : setF((p) => ({ ...p, tier: e.target.value, tierManual: true }))}>
            <option value="auto">Auto — Tier {effTier({ ...f, tierManual: false, comp: f.comp === "" ? null : Number(f.comp) }, S)}</option>
            {TIERS.map((t) => <option key={t} value={t}>Override: Tier {t}</option>)}
          </select></div>
        <div><label className="f">Location fit</label>
          <select className="in" value={f.fitOverride === null ? "auto" : f.fitOverride ? "yes" : "no"}
            onChange={(e) => set("fitOverride", e.target.value === "auto" ? null : e.target.value === "yes")}>
            <option value="auto">Auto ({fit.fit ? "fits" : "no fit"})</option>
            <option value="yes">Override: fits</option>
            <option value="no">Override: no fit</option>
          </select></div>
        <div><label className="f">Next step date</label><input type="date" className="in" value={f.nextDate || ""} onChange={(e) => set("nextDate", e.target.value)} /></div>
        <div><label className="f">Hiring window</label><input className="in" value={f.window || ""} onChange={(e) => set("window", e.target.value)} placeholder="Aug–Oct 2026" /></div>
        <div><label className="f">Source</label>
          <select className="in" value={f.source} onChange={(e) => set("source", e.target.value)}><option>Cold</option><option>Warm</option><option>Referral</option></select></div>
        {f.source === "Referral" && (
          <div><label className="f">Referred by</label><input className="in" value={f.referralName} onChange={(e) => set("referralName", e.target.value)} /></div>
        )}
      </div>
      <label className="f">Posting link</label>
      <input className="in" value={f.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…" />
      <label className="f">Notes</label>
      <textarea className="in" style={{ minHeight: 80 }} value={f.notes} onChange={(e) => set("notes", e.target.value)} />

      {f.fitScore != null && (
        <div className="note">
          Fit: <b style={{ color: FIT_CLR[f.fitLabel] || "var(--muted)" }}>{f.fitScore}/10 · {f.fitLabel}</b>
          {f.fitWhy ? " — " + f.fitWhy : ""}
          {(f.fitBreak || []).map((b, i) => <div key={i} style={{ marginLeft: 8 }}>• {b}</div>)}
        </div>
      )}
      {info && <div className="note">{info}</div>}

      <div className="mrow" style={{ justifyContent: "flex-start" }}>
        <button className="btn small" disabled={!!busy} onClick={() => research("comp")}>{busy === "comp" ? "Researching…" : "Research comp"}</button>
        <button className="btn small" disabled={!!busy} onClick={() => research("growth")}>{busy === "growth" ? "Researching…" : "Research growth"}</button>
        <button className="btn small" disabled={!!busy} onClick={() => research("fit")}>{busy === "fit" ? "Scoring…" : "Score my fit"}</button>
      </div>
      <div className="mrow">
        {editing && !confirmDel && <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => setConfirmDel(true)}>Delete</button>}
        {editing && confirmDel && (
          <>
            <span className="note" style={{ alignSelf: "center", marginRight: "auto" }}>Delete this one?</span>
            <button className="btn danger" onClick={() => onDelete(f.id)}>Yes, delete</button>
            <button className="btn" onClick={() => setConfirmDel(false)}>Keep</button>
          </>
        )}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>{editing ? "Save changes" : "Add"}</button>
      </div>
    </Sheet>
  );
}

/* ---------------- resume: PDF in, edit, PDF out ----------------
   The uploaded PDF is the artifact you actually send, so it's kept byte-for-byte
   on the server. Its text is extracted once so the AI (and you) can work on it,
   and export rebuilds a clean PDF from that text. Both libraries load only when
   you touch this card — they never enter the main bundle. */

async function extractPdfText(buffer) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  /* pdf.js transfers this buffer to its worker, which DETACHES it — hand over a
     copy or the caller's bytes are gone before they can be uploaded */
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  let out = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    /* PDFs store loose glyph runs, not lines — rebuild lines by vertical
       position, then order each one left to right and restore the gaps. */
    const lines = new Map();
    for (const it of content.items) {
      if (typeof it.str !== "string") continue;
      const y = Math.round(it.transform[5]);
      const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    for (const [, parts] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
      let line = "", end = null;
      for (const o of parts.sort((a, b) => a.x - b.x)) {
        if (end != null && o.x - end > 1) line += " ";
        line += o.s;
        end = o.x + o.w;
      }
      out += line.replace(/\s+/g, " ").trim() + "\n";
    }
    out += "\n";
  }
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), pages: doc.numPages };
}

/* renders the stored PDF to canvases so you can see the real document,
   not just a filename */
function PdfView({ nonce }) {
  const [pages, setPages] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/api/resume");
        if (!r.ok) { if (!dead) setErr("no file"); return; }
        const buf = await r.arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
        const out = [];
        for (let p = 1; p <= Math.min(doc.numPages, 4); p++) {
          const page = await doc.getPage(p);
          const scale = 1.4;
          const vp = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
          out.push(canvas.toDataURL("image/png"));
        }
        if (!dead) setPages(out);
      } catch (e) { if (!dead) setErr(e.message); }
    })();
    return () => { dead = true; };
  }, [nonce]);

  if (err) return <div className="note">Preview unavailable{err !== "no file" ? " — " + err : ""}.</div>;
  if (!pages) return <div className="note">Rendering preview…</div>;
  return (
    <div className="hscroll" style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 10, flexWrap: "nowrap", alignItems: "flex-start" }}>
        {pages.map((src, i) => (
          <img key={i} src={src} alt={"Resume page " + (i + 1)}
            style={{ width: 300, borderRadius: 8, border: "1px solid var(--line2)", background: "#fff", flexShrink: 0 }} />
        ))}
      </div>
    </div>
  );
}

async function buildPdf(text) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const M = 54, W = 612 - M * 2, BOTTOM = 792 - M;
  let y = M, first = true;
  const nl = (h) => { y += h; if (y > BOTTOM) { doc.addPage(); y = M; } };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { nl(8); continue; }
    const bullet = /^[-•*]\s+/.test(line);
    const heading = !bullet && line.length <= 60 && line === line.toUpperCase() && /[A-Z]/.test(line);
    if (first) {
      doc.setFont("helvetica", "bold").setFontSize(19);
      doc.text(line, M, y); nl(24); first = false; continue;
    }
    if (heading) {
      nl(6);
      doc.setFont("helvetica", "bold").setFontSize(11.5);
      doc.text(line.toUpperCase(), M, y);
      doc.setDrawColor(180).line(M, y + 3.5, M + W, y + 3.5);
      nl(15); continue;
    }
    doc.setFont("helvetica", "normal").setFontSize(10.5);
    const body = bullet ? line.replace(/^[-•*]\s+/, "") : line;
    const indent = bullet ? 14 : 0;
    const wrapped = doc.splitTextToSize(body, W - indent);
    wrapped.forEach((w, i) => {
      if (bullet && i === 0) doc.text("•", M, y);
      doc.text(w, M + indent, y);
      nl(13.5);
    });
  }
  return doc;
}

const b64 = (buf) => {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
};

function ResumeCard({ S, setCareer, config, toast }) {
  const meta = S.resumeMeta || null;
  const [busy, setBusy] = useState("");
  const [instr, setInstr] = useState("");
  const [draft, setDraft] = useState(null); // AI rewrite awaiting your yes/no
  const [nonce, setNonce] = useState(0);    // bump to re-render the preview

  const store = async (buf, name, pages, text) => {
    const r = await fetch("/api/resume", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf: b64(buf) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "upload failed");
    setCareer((c) => ({ ...c, settings: { ...c.settings, resume: text,
      resumeMeta: { name, pages, bytes: buf.byteLength, uploaded: new Date().toISOString().slice(0, 10) } } }));
    setNonce((n) => n + 1);
  };

  const pick = async (file) => {
    if (!file) return;
    setBusy("read");
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 2.5 * 1024 * 1024) throw new Error("that PDF is over 2.5 MB");
      const { text, pages } = await extractPdfText(buf);
      await store(buf, file.name, pages, text);
      toast("Resume uploaded — " + pages + (pages === 1 ? " page" : " pages") + ", text extracted and editable below.");
    } catch (e) { toast("Couldn't read that PDF — " + e.message, "err"); }
    setBusy("");
  };

  /* the round trip that makes the edits real: rebuild the PDF from your text,
     store it as the new original, and re-extract so text and file agree */
  const publish = async () => {
    setBusy("pub");
    try {
      const doc = await buildPdf(S.resume);
      const buf = doc.output("arraybuffer");
      const { text, pages } = await extractPdfText(buf);
      await store(buf, (meta?.name || "resume.pdf").replace(/\.pdf$/i, "") + " (edited).pdf", pages, text);
      toast("Your edits are now the stored PDF — preview and download both use it.");
    } catch (e) { toast("Couldn't rebuild the PDF — " + e.message, "err"); }
    setBusy("");
  };

  const aiEdit = async () => {
    if (!S.resume.trim()) return toast("Upload a resume first.", "err");
    setBusy("ai");
    try {
      setDraft((await callClaude(
        "Here is the plain text of someone's resume:\n\n" + S.resume.slice(0, 9000) +
        "\n\nRewrite it with this instruction: " + (instr.trim() || "tighten the writing and lead every bullet with the outcome") +
        "\n\nRules: keep every claim truthful to the original — reword, reorder, cut, but never invent a job, a date, a tool, or a number. " +
        "Keep the same section structure (name and contact first, then sections). Section headings in ALL CAPS on their own line. " +
        "Bullets start with '- '. Plain text only, no markdown, no commentary before or after."
      )).trim());
    } catch (e) { toast("AI edit failed — " + e.message, "err"); }
    setBusy("");
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Resume</h3>
        {meta && <span className="note" style={{ margin: 0 }}>{meta.name} · {meta.pages} pg · uploaded {meta.uploaded}</span>}
      </div>
      <div className="note" style={{ marginTop: 0 }}>
        Upload the PDF you actually send. Atlas keeps the original file and pulls its text out so you — and the AI — can work on it.
        Everything is stored with your finances: same private directory, same encrypted backups, same passkey.
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small primary" disabled={!!busy} onClick={() => document.getElementById("resume-pick").click()}>
          {busy === "read" ? "Reading…" : meta ? "Replace PDF" : "Upload PDF"}
        </button>
        <input id="resume-pick" type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
          onChange={(e) => { pick(e.target.files[0]); e.target.value = ""; }} />
        {meta && <a className="btn small" href="/api/resume" target="_blank" rel="noreferrer noopener">Open PDF</a>}
        {S.resume.trim() && (
          <>
            <button className="btn small" disabled={!!busy}
              onClick={() => buildPdf(S.resume).then((doc) => doc.save("resume-" + new Date().toISOString().slice(0, 10) + ".pdf")).catch((e) => toast("Export failed — " + e.message, "err"))}>
              Download edited
            </button>
            <button className="btn small" disabled={!!busy} title="Rebuild the PDF from your edited text and make it the stored version"
              onClick={publish}>{busy === "pub" ? "Rebuilding…" : "Save edits as the PDF"}</button>
          </>
        )}
        {meta && (
          <button className="btn small danger" onClick={async () => {
            if (!confirm("Remove the stored resume PDF and its text?")) return;
            await fetch("/api/resume", { method: "DELETE" });
            setCareer((c) => ({ ...c, settings: { ...c.settings, resume: "", resumeMeta: null } }));
            toast("Resume removed.");
          }}>Remove</button>
        )}
      </div>

      {meta && <PdfView nonce={nonce} />}

      {S.resume.trim() ? (
        <>
          <label className="f">Resume text — edit freely</label>
          <textarea className="in mono" style={{ minHeight: 240, fontSize: 12.5, lineHeight: 1.5 }} value={S.resume}
            onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, resume: e.target.value } }))} />
          <div className="note">
            {S.resume.trim().split(/\s+/).length} words. Edits feed fit scoring, tailoring and the assistant.
            <b> Download edited</b> gives you a file; <b>Save edits as the PDF</b> makes them the stored version you see above.
          </div>
          {config?.aiEnabled && (
            <div className="row" style={{ marginTop: 8 }}>
              <input className="in" style={{ flex: 1, minWidth: 180 }} placeholder="Tell the AI how to edit it — e.g. 'make it IAM-focused, cut to one page'"
                value={instr} onChange={(e) => setInstr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && aiEdit()} />
              <button className="btn small" disabled={!!busy} onClick={aiEdit}>{busy === "ai" ? "Rewriting…" : "Edit with AI"}</button>
            </div>
          )}
        </>
      ) : (
        <div className="note">Nothing uploaded yet — the AI features here stay off until there's a resume to read.</div>
      )}

      {draft && (
        <Sheet title="AI rewrite — review before it replaces yours" onClose={() => setDraft(null)}>
          <div className="note" style={{ marginTop: 0 }}>Nothing is saved until you accept. Your current text is untouched behind this.</div>
          <textarea className="in mono" style={{ minHeight: 300, fontSize: 12.5 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="mrow">
            <button className="btn" onClick={() => setDraft(null)}>Discard</button>
            <button className="btn primary" onClick={() => {
              setCareer((c) => ({ ...c, settings: { ...c.settings, resume: draft } }));
              setDraft(null); toast("Resume text replaced — export a PDF when you're happy with it.");
            }}>Use this version</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/* What an offer actually does to your money — the reason this lives in Atlas */
function OfferImpact({ app, d, S, onClose }) {
  const gross = totalComp(app);
  const takeHome = gross == null ? null : (gross * (S.takeHomePct || 76)) / 100 / 12;

  const byMonth = {};
  d.txns.filter((t) => t.kind === "out").forEach((t) => {
    const m = (t.date || "").slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + (Number(t.amount) || 0);
  });
  const months = Object.keys(byMonth).sort().slice(-3);
  const avgSpend = months.length ? months.reduce((s, m) => s + byMonth[m], 0) / months.length : 0;
  const destCol = colOf(app, S), homeCol = S.homeCol || 84;
  const scaledSpend = avgSpend * (destCol / homeCol);
  const surplus = takeHome == null ? null : takeHome - scaledSpend;
  const rate = takeHome ? (surplus / takeHome) * 100 : null;

  const goals = (d.goals || []).map((g) => {
    const cur = g.accountId ? Number(d.accounts.find((a) => a.id === g.accountId)?.balance || 0) : Number(g.current) || 0;
    const remain = Math.max(0, Number(g.target) - cur);
    return { name: g.name, remain, months: surplus > 0 ? Math.ceil(remain / surplus) : null };
  });

  return (
    <Sheet title={app.company + " — what it does to your money"} onClose={onClose}>
      <div className="note" style={{ marginTop: 0 }}>
        Base {money(app.comp)}{app.extrasPct ? " + " + app.extrasPct + "% bonus/benefits = " + money(gross) : ""} ·
        {" "}{app.locationType === "Remote" ? "remote" : app.city || "location unset"} (cost of living {destCol} vs your {homeCol}).
      </div>
      <div className="kv"><span className="k">Take-home / month</span><span className="mono">{dollars(takeHome)} <span style={{ color: "var(--faint)" }}>at {S.takeHomePct}%</span></span></div>
      <div className="kv"><span className="k">Your spending, moved there</span><span className="mono">{dollars(scaledSpend)}<span style={{ color: "var(--faint)" }}> (now {dollars(avgSpend)})</span></span></div>
      <div className="kv"><span className="k">Left over each month</span>
        <span className="mono"><b className={surplus >= 0 ? "good" : "bad"}>{dollars(surplus)}</b>{rate != null ? " · " + Math.round(rate) + "% saved" : ""}</span></div>
      {goals.length > 0 && (
        <>
          <label className="f">If every spare dollar went to your goals</label>
          {goals.map((g) => (
            <div className="kv" key={g.name}>
              <span className="k">{g.name}</span>
              <span className="mono">{g.remain <= 0 ? "already funded" : g.months == null ? "no surplus to fund it" : "~" + g.months + " mo"}</span>
            </div>
          ))}
        </>
      )}
      <div className="note">
        Rough by design: take-home uses a flat {S.takeHomePct}% of gross (federal, FICA and state vary), and your spending is
        scaled by cost-of-living index, which moves rent far more than groceries. Treat it as the shape of the answer, not the answer.
      </div>
      <div className="mrow"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Sheet>
  );
}

export default function Career({ d, setD, config, toast }) {
  const career = d.career || DEFAULT_CAREER;
  const S = { ...DEFAULT_CAREER.settings, ...(career.settings || {}) };
  const apps = career.apps || [];

  const [editing, setEditing] = useState(null);
  const [impact, setImpact] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("All");
  const [fitOnly, setFitOnly] = useState(false);
  const [sort, setSort] = useState("adj");
  const [limit, setLimit] = useState(20);
  const [tailorFor, setTailorFor] = useState(null);
  const [tailorOut, setTailorOut] = useState("");
  const [busy, setBusy] = useState(false);

  const setCareer = (fn) => setD((p) => {
    const cur = p.career || DEFAULT_CAREER;
    return { ...p, career: fn({ apps: cur.apps || [], settings: { ...DEFAULT_CAREER.settings, ...(cur.settings || {}) } }) };
  });
  const saveApp = (a) => { setCareer((c) => ({ ...c, apps: c.apps.some((x) => x.id === a.id) ? c.apps.map((x) => (x.id === a.id ? a : x)) : [...c.apps, a] })); setEditing(null); };
  const deleteApp = (id) => { setCareer((c) => ({ ...c, apps: c.apps.filter((x) => x.id !== id) })); setEditing(null); };

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = apps.filter((a) =>
      (status === "All" || a.status === status) &&
      (!fitOnly || computeFit(a, S.cities).fit) &&
      (!ql || (a.company + " " + a.role + " " + (a.city || "")).toLowerCase().includes(ql)));
    const cmp = {
      adj: (a, b) => (adjComp(b, S) || 0) - (adjComp(a, S) || 0),
      comp: (a, b) => (totalComp(b) || 0) - (totalComp(a) || 0),
      company: (a, b) => a.company.localeCompare(b.company),
      next: (a, b) => (a.nextDate || "9999").localeCompare(b.nextDate || "9999"),
    };
    return list.sort(cmp[sort]);
  }, [apps, q, status, fitOnly, sort, S]);

  const counts = STATUSES.reduce((m, s) => ({ ...m, [s]: apps.filter((a) => a.status === s).length }), {});
  const applied = apps.filter((a) => a.status !== "Target").length;

  const tailor = async (a) => {
    if (!S.resume.trim()) return toast("Paste your resume below first — tailoring rewrites it against the role.", "err");
    setTailorFor(a); setTailorOut(""); setBusy(true);
    try {
      setTailorOut((await callClaude(
        "Resume:\n" + S.resume.slice(0, 8000) +
        "\n\nTarget role: " + a.role + " at " + a.company + (a.city ? " in " + a.city : "") +
        (a.clearance === "Required" ? " (requires a security clearance)" : "") +
        "\n\nRewrite the 5–7 resume bullets that matter most for THIS role. Keep every claim truthful to the resume — " +
        "reword and reorder, never invent experience. Lead each bullet with the outcome, name the tool or standard where the " +
        "resume gives you one, and keep each under 22 words. Plain text, one bullet per line starting with '- '. " +
        "After the bullets add a line 'GAPS:' and name up to three things this resume genuinely lacks for the role."
      )).trim());
    } catch (e) { toast("Tailoring failed — " + e.message, "err"); setTailorFor(null); }
    setBusy(false);
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Career</h3>
          <span className="row" style={{ gap: 6 }}>
            {!apps.length && <button className="btn small" onClick={() => { setCareer((c) => ({ ...c, apps: seedApps() })); toast("Loaded " + SEED.length + " starter targets — tiers recomputed from cost-of-living."); }}>Load starter targets</button>}
            <button className="btn small primary" onClick={() => setEditing({})}>+ Add</button>
          </span>
        </div>
        {apps.length ? (
          <>
            <div className="grid4" style={{ marginTop: 10 }}>
              <div><div className="sub">Tracked</div><div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{apps.length}</div></div>
              <div><div className="sub">In flight</div><div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{applied}</div></div>
              <div><div className="sub">Interviewing</div><div className="mono" style={{ fontSize: 20, fontWeight: 600, color: "var(--acc)" }}>{counts.Interviewing || 0}</div></div>
              <div><div className="sub">Offers</div><div className="mono" style={{ fontSize: 20, fontWeight: 600, color: "var(--up)" }}>{counts.Offer || 0}</div></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <input className="in" style={{ flex: 1, minWidth: 150 }} placeholder="Search company, role, city…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="in" style={{ width: 140 }} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option>All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <select className="in" style={{ width: 170 }} value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="adj">Sort: adjusted comp</option>
                <option value="comp">Sort: raw comp</option>
                <option value="next">Sort: next step</option>
                <option value="company">Sort: company</option>
              </select>
              <button className={"btn small" + (fitOnly ? " primary" : "")} onClick={() => setFitOnly((v) => !v)}>Fits my cities</button>
            </div>
            <div className="note">
              Tier is computed from comp adjusted for cost of living — Tier 1 above {money(S.tierT1)} adjusted, Tier 2 above {money(S.tierT2)}.
              A $66k job in Little Rock can outrank a $95k job in the Bay Area.
            </div>
          </>
        ) : (
          <div className="note">
            Nothing tracked yet. <b>Load starter targets</b> brings in the {SEED.length}-company list — utilities, IAM consultancies,
            cleared primes, financials, enterprises in zoo cities, and the lottery tickets — each with an expected comp, hiring window,
            and the right board to apply through.
          </div>
        )}
      </div>

      {rows.slice(0, limit).map((a) => {
        const f = computeFit(a, S.cities);
        const t = effTier(a, S);
        const adj = adjComp(a, S);
        const dest = findDest(a);
        return (
          <div className="card" key={a.id} style={{ marginTop: 8, padding: "12px 16px" }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
              <span style={{ overflow: "hidden", flex: 1 }}>
                <span className="row" style={{ gap: 7, flexWrap: "nowrap" }}>
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.company}</b>
                  <span className="tag" style={{ color: STATUS_CLR[a.status], borderColor: STATUS_CLR[a.status] }}>{a.status}</span>
                  <span className="tag">Tier {t}</span>
                  {a.fitScore != null && <span className="tag" style={{ color: FIT_CLR[a.fitLabel] }}>{a.fitScore}/10</span>}
                </span>
                <span className="note" style={{ margin: 0, fontSize: 12 }}>
                  {a.role} · {a.locationType === "Remote" ? "Remote" : a.city || "city TBD"}
                  {f.fit ? <span className="good"> · fits{f.cityTier ? " (" + f.cityTier + ")" : ""}</span> : <span className="bad"> · outside your cities</span>}
                  {a.clearance === "Required" && " · clearance"}
                  {a.window && " · " + a.window}
                </span>
              </span>
              <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                <span style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{money(totalComp(a))}</div>
                  <div className="note" style={{ margin: 0, fontSize: 11 }}>{money(adj)} adjusted</div>
                </span>
                <button className="btn small" onClick={() => setEditing(a)}>Edit</button>
              </span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <a className="btn small" href={dest.url} target="_blank" rel="noreferrer noopener">Find on {dest.label}</a>
              {config?.aiEnabled && <button className="btn small" onClick={() => tailor(a)}>Tailor resume</button>}
              {a.comp != null && <button className="btn small" onClick={() => setImpact(a)}>What it pays me</button>}
              {a.growthNote && <span className="note" style={{ margin: 0, fontSize: 11.5 }}>growth {a.growth}/5 · {a.growthNote}</span>}
            </div>
          </div>
        );
      })}

      {rows.length > limit && (
        <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
          <button className="btn small" onClick={() => setLimit((n) => n + 40)}>
            Show more — {rows.length - limit} of {rows.length} hidden
          </button>
        </div>
      )}

      <ResumeCard S={S} setCareer={setCareer} config={config} toast={toast} />

      <div className="card">
        <h3>Assumptions</h3>
        <div className="grid3" style={{ marginTop: 8 }}>
          <div><label className="f">Take-home % of gross</label>
            <input className="in mono" type="number" value={S.takeHomePct}
              onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, takeHomePct: Number(e.target.value) || 0 } }))} /></div>
          <div><label className="f">Your current cost of living</label>
            <input className="in mono" type="number" value={S.homeCol}
              onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, homeCol: Number(e.target.value) || 0 } }))} />
            <div className="note">100 = US average. Ruston ≈ 84.</div></div>
          <div><label className="f">Tier 1 cutoff (adjusted)</label>
            <input className="in mono" type="number" value={S.tierT1}
              onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, tierT1: Number(e.target.value) || 0 } }))} /></div>
        </div>
      </div>

      {editing && (
        <AppForm initial={editing} S={S} resume={S.resume} toast={toast}
          onSave={saveApp} onDelete={deleteApp} onClose={() => setEditing(null)} />
      )}
      {impact && <OfferImpact app={impact} d={d} S={S} onClose={() => setImpact(null)} />}
      {tailorFor && (
        <Sheet title={"Tailored for " + tailorFor.company} onClose={() => setTailorFor(null)}>
          {busy ? <div className="note">Rewriting your bullets against this role…</div>
                : <div className="aiout">{tailorOut}</div>}
          <div className="mrow">
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(tailorOut); toast("Copied."); }}>Copy</button>
            <button className="btn primary" onClick={() => setTailorFor(null)}>Done</button>
          </div>
        </Sheet>
      )}
    </>
  );
}
