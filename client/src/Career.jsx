import React, { useState, useMemo, useEffect, useRef } from "react";
import { DEFAULT_CITIES, AZA_JOBS, partnerLabel, partnerColor, CAT_GROWTH, cityMatch } from "./careerData.js";
import JobFinder, { guessMyLevel, LEVELS } from "./JobFinder.jsx";
import Projects, { projectsBrief } from "./Projects.jsx";
import Timeline, { compoundGap } from "./Timeline.jsx";

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

/* a resume is a page or three; a 40-page PDF would otherwise put ~200KB of text
   into the data blob that autosaves every half second */
const MAX_RESUME_CHARS = 40000;
const FIT_LABELS = ["Strong", "Good", "Stretch", "Long shot"];

/* Model output goes straight into saved state and then into JSX, so a stray
   shape ("gaps": "no cloud experience", or a number where a string belongs)
   would persist and then crash the tab on every render — unrecoverable without
   hand-editing the data file. Coerce everything at the boundary. */
function cleanFit(j) {
  const score = Math.max(1, Math.min(10, Math.round(Number(j?.score))));
  if (!Number.isFinite(score)) return null;
  const label = FIT_LABELS.includes(j?.label) ? j.label
    : score >= 8 ? "Strong" : score >= 6 ? "Good" : score >= 4 ? "Stretch" : "Long shot";
  const gaps = (Array.isArray(j?.gaps) ? j.gaps : [j?.gaps])
    .filter((g) => typeof g === "string" && g.trim()).slice(0, 3).map((g) => g.slice(0, 120));
  return { fitScore: score, fitLabel: label, fitWhy: typeof j?.why === "string" ? j.why.slice(0, 200) : "", fitBreak: gaps };
}

const STATUSES = ["Target", "Applied", "Interviewing", "Offer", "Rejected", "Withdrawn"];
const CLEARANCES = ["Not required", "Required", "Preferred", "Unsure"];
const LOC_TYPES = ["Remote", "Hybrid", "Onsite"];
const TIERS = ["1", "2", "3"];

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
      /* Seed rows with no city are the nationwide employers — they hire in many
         places, so "outside your cities" is the wrong verdict for them. */
      fitOverride: !locType && !city ? true : null,
      tier: tier === "Lottery" ? "3" : tier, tierManual: false, cat,
      growth: CAT_GROWTH[cat]?.[0] ?? null, growthNote: CAT_GROWTH[cat]?.[1] ?? "",
      family: "IAM", source: "Cold", referralName: "", nextDate: "",
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
  /* Straight at the employer rather than through an aggregator: it's where the
     application actually happens, the listings are always current, and no third
     party gets to log that you looked. */
  if (a.link) return { label: "the posting", url: a.link };
  return { label: "their careers page", url: "https://duckduckgo.com/?q=" +
    encodeURIComponent(a.company + " careers " + kw + " site:(*.myworkdayjobs.com OR job-boards.greenhouse.io OR jobs.lever.co OR jobs.ashbyhq.com) OR " + a.company + " official careers " + kw) };
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
        /* the model may hand back "65000" as a string — adding two of those
           concatenates into a $3.25 billion salary that then poisons tiers,
           sorting and the offer math */
        const low = Number(j.low), high = Number(j.high);
        const sane = Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low && high < 2e6;
        if (sane) {
          setF((p) => ({ ...p, comp: Math.round((low + high) / 2), compEst: false }));
          setInfo("Found " + money(low) + "–" + money(high) + (j.note ? " — " + j.note : "") + ". Midpoint filled in; edit freely.");
        } else setInfo("Couldn't pin a believable range — " + (j.note || "enter it manually."));
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
        const fit = cleanFit(extractJSON(out));
        if (!fit) throw new Error("no usable score came back");
        setF((p) => ({ ...p, ...fit }));
        setInfo("Scored " + fit.fitScore + "/10 — " + fit.fitLabel);
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
function PdfView({ slot = 1, nonce }) {
  const [pages, setPages] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let dead = false;
    setErr(""); setPages(null); // otherwise one failed fetch wedges the preview until a reload
    (async () => {
      try {
        const r = await fetch("/api/resume/" + slot);
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
  }, [slot, nonce]);

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

/* Slot 1 keeps the original filename on the server, so a single stored resume
   becomes resume #1 here with nothing to copy or re-upload. */
function readResumes(S) {
  if (Array.isArray(S.resumes) && S.resumes.length) return S.resumes;
  if ((S.resume || "").trim() || S.resumeMeta) {
    return [{ slot: 1, label: "General", text: S.resume || "", meta: S.resumeMeta || null }];
  }
  return [];
}

function ResumeCard({ S, setCareer, config, toast, apps, myLevel, levelSource }) {
  const resumes = readResumes(S);
  const [active, setActive] = useState(0);
  const idx = Math.min(active, Math.max(0, resumes.length - 1));
  const cur = resumes[idx] || null;
  const meta = cur?.meta || null;
  const text = cur?.text || "";
  const [busy, setBusy] = useState("");
  const [instr, setInstr] = useState("");
  const [draft, setDraft] = useState(null); // AI rewrite awaiting your yes/no
  const [nonce, setNonce] = useState(0);    // bump to re-render the preview
  const [tailorTarget, setTailorTarget] = useState("");

  /* every write goes through here so the legacy single-resume shape is migrated
     exactly once, and the old keys stop being the source of truth */
  const writeResumes = (fn) => setCareer((c) => {
    const list = fn(readResumes({ ...c.settings }));
    return { ...c, settings: { ...c.settings, resumes: list, resume: list[0]?.text || "", resumeMeta: list[0]?.meta || null } };
  });
  const patch = (slot, changes) => writeResumes((list) => list.map((r) => (r.slot === slot ? { ...r, ...changes } : r)));
  const freeSlot = () => { for (let n = 1; n <= 5; n++) if (!resumes.some((r) => r.slot === n)) return n; return null; };

  /* text === null means "keep the text I already have" — used by publish, because
     re-extracting our own generated PDF is lossy (blank lines vanish, wrapped
     lines come back as separate lines, and an all-caps wrap tail gets promoted to
     a section heading on the next render). Your text stays the source of truth. */
  const store = async (slot, buf, name, pages, text, label) => {
    const r = await fetch("/api/resume/" + slot, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf: b64(buf) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "upload failed");
    const m = { name, pages, bytes: buf.byteLength, uploaded: new Date().toISOString().slice(0, 10) };
    writeResumes((list) => list.some((x) => x.slot === slot)
      ? list.map((x) => (x.slot === slot ? { ...x, meta: m, ...(text == null ? {} : { text: text.slice(0, MAX_RESUME_CHARS) }), ...(label ? { label } : {}) } : x))
      : [...list, { slot, label: label || "Resume " + slot, text: (text || "").slice(0, MAX_RESUME_CHARS), meta: m }]);
    setNonce((n) => n + 1);
  };

  const pick = async (file, intoSlot) => {
    if (!file) return;
    const slot = intoSlot || cur?.slot || freeSlot();
    if (!slot) { toast("You already have " + resumes.length + " resumes — delete one first.", "err"); return; }
    const isNew = !resumes.some((r) => r.slot === slot);
    setBusy("read");
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 2.5 * 1024 * 1024) throw new Error("that PDF is over 2.5 MB");
      const { text, pages } = await extractPdfText(buf);
      await store(slot, buf, file.name, pages, text, isNew ? file.name.replace(/\.pdf$/i, "").slice(0, 24) : undefined);
      /* a new slot is appended, so it lands at the end; a replacement keeps its place */
      setActive(isNew ? resumes.length : idx);
      toast("Resume uploaded — " + pages + (pages === 1 ? " page" : " pages") + ", text extracted and editable below.");
    } catch (e) { toast("Couldn't read that PDF — " + e.message, "err"); }
    setBusy("");
  };

  /* Build a whole variant of an existing resume aimed at one target, then store
     it as its own slot with its own PDF — a real second resume you can send. */
  const makeVariant = async () => {
    const slot = freeSlot();
    if (!slot) return toast("Five resumes is the limit — delete one first.", "err");
    if (!text.trim()) return toast("This resume has no text to work from.", "err");
    const target = apps.find((a) => a.id === tailorTarget);
    setBusy("variant");
    try {
      const aim = target ? target.role + " at " + target.company + (target.city ? " in " + target.city : "") : instr.trim();
      const out = (await callClaude(
        "Here is the plain text of a resume:\n\n" + text.slice(0, 9000) +
        projectsBrief(S, aim) +
        "\n\nProduce a version of this SAME resume aimed at: " + aim +
        "\n\nRules: every claim must stay truthful to the original — reorder, reword, cut, and re-emphasise, but never invent a job, " +
        "date, tool or number. Put the most relevant experience first and drop what doesn't serve this target. Keep the same overall " +
        "structure (name and contact first, then sections). Section headings in ALL CAPS on their own line. Bullets start with '- '. " +
        "Plain text only, no markdown, no commentary."
      )).trim();
      if (!out) throw new Error("the model returned nothing");
      const doc = await buildPdf(out);
      const buf = doc.output("arraybuffer");
      const label = (target ? target.company : aim).slice(0, 22) || "Variant";
      await store(slot, buf, label.replace(/[^\w ()-]/g, "") + ".pdf", doc.getNumberOfPages(), out, label);
      setActive(resumes.length);
      toast("Made a new resume aimed at " + label + " — review it before you send it anywhere.");
    } catch (e) { toast("Couldn't build that variant — " + e.message, "err"); }
    setBusy("");
  };

  /* the round trip that makes the edits real: rebuild the PDF from your text,
     store it as the new original, and re-extract so text and file agree */
  const publish = async () => {
    setBusy("pub");
    try {
      const doc = await buildPdf(text);
      const buf = doc.output("arraybuffer");
      const base = (meta?.name || "resume.pdf").replace(/\.pdf$/i, "").replace(/ \(edited\)+$/i, "");
      await store(cur.slot, buf, base + " (edited).pdf", doc.getNumberOfPages(), null);
      toast("Your edits are now the stored PDF — preview and download both use it.");
    } catch (e) { toast("Couldn't rebuild the PDF — " + e.message, "err"); }
    setBusy("");
  };

  /* Which rung the resume actually reads at — the thing that decides whether
     "senior" postings are a stretch or your next move. Stored with a date, so
     when it shifts you can see that it shifted rather than guessing. */
  const estimateLevel = async () => {
    if (!text.trim()) return toast("Upload a resume first.", "err");
    setBusy("level");
    try {
      const out = (await callClaude(
        "Resume:\n" + text.slice(0, 7000) +
        "\n\nWhich rung of a security/IT career ladder does this person read at TODAY to a hiring manager? " +
        'Respond with ONLY JSON (no fences): {"level": one of "intern"|"entry"|"mid"|"senior"|"lead"|"principal"|"executive", ' +
        '"why": string under 18 words, "next": what would move them up one rung, under 18 words}. ' +
        "Judge from scope, ownership and years actually shown, not from job titles or confidence of tone. Be realistic, not kind."
      )).trim();
      const j = extractJSON(out);
      const lv = LEVELS.map(([k]) => k);
      if (!j || !lv.includes(j.level)) throw new Error("no usable level came back");
      setCareer((c) => ({ ...c, settings: { ...c.settings, levelAI: {
        level: j.level, why: String(j.why || "").slice(0, 140), next: String(j.next || "").slice(0, 140),
        at: new Date().toISOString().slice(0, 10),
      } } }));
      toast("Reads as " + j.level + " — " + (j.why || "") + (j.next ? " To move up: " + j.next : ""));
    } catch (e) { toast("Couldn't estimate your level — " + e.message, "err"); }
    setBusy("");
  };

  const aiEdit = async () => {
    if (!text.trim()) return toast("Upload a resume first.", "err");
    setBusy("ai");
    try {
      const out = (await callClaude(
        "Here is the plain text of someone's resume:\n\n" + text.slice(0, 9000) +
        "\n\nRewrite it with this instruction: " + (instr.trim() || "tighten the writing and lead every bullet with the outcome") +
        "\n\nRules: keep every claim truthful to the original — reword, reorder, cut, but never invent a job, a date, a tool, or a number. " +
        "Keep the same section structure (name and contact first, then sections). Section headings in ALL CAPS on their own line. " +
        "Bullets start with '- '. Plain text only, no markdown, no commentary before or after."
      )).trim();
      /* an empty completion (it can happen — thinking eats the token budget) would
         otherwise flip the button back with no sheet and no error at all */
      if (!out) throw new Error("the model returned nothing — try again, or shorten the instruction");
      setDraft(out);
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

      {resumes.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 4 }}>
          <div className="tabs" style={{ flexWrap: "wrap" }}>
            {resumes.map((r, i) => (
              <button key={r.slot} className={"tab" + (i === idx ? " on" : "")} onClick={() => { setActive(i); setNonce((n) => n + 1); }}>
                {r.label || "Resume " + r.slot}
              </button>
            ))}
          </div>
          {resumes.length < 5 && (
            <button className="btn small" disabled={!!busy} title="Upload another PDF as a separate resume"
              onClick={() => document.getElementById("resume-add").click()}>+ Another resume</button>
          )}
          <input id="resume-add" type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
            onChange={(e) => { pick(e.target.files[0], freeSlot()); e.target.value = ""; }} />
        </div>
      )}

      {cur && (
        <div className="row" style={{ marginTop: 8 }}>
          <label className="note" style={{ margin: 0 }}>Name this one</label>
          <input className="in" style={{ width: 200, padding: "4px 8px" }} value={cur.label || ""}
            placeholder="e.g. IAM / utilities"
            onChange={(e) => patch(cur.slot, { label: e.target.value.slice(0, 24) })} />
          {resumes.length > 1 && (
            <span className="note" style={{ margin: 0, fontSize: 11.5 }}>
              {idx === 0 ? "This first one is what fit scoring and the assistant read."
                         : "Fit scoring reads the first tab (" + (resumes[0].label || "Resume 1") + "), not this one."}
            </span>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small primary" disabled={!!busy} onClick={() => document.getElementById("resume-pick").click()}>
          {busy === "read" ? "Reading…" : meta ? "Replace PDF" : "Upload PDF"}
        </button>
        <input id="resume-pick" type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
          onChange={(e) => { pick(e.target.files[0]); e.target.value = ""; }} />
        {meta && <a className="btn small" href={"/api/resume/" + cur.slot} target="_blank" rel="noreferrer noopener">Open PDF</a>}
        {text.trim() && (
          <>
            <button className="btn small" disabled={!!busy}
              onClick={() => buildPdf(text).then((doc) => doc.save(((cur.label || "resume") + "-" + new Date().toISOString().slice(0, 10) + ".pdf").replace(/[^\w.() -]/g, ""))).catch((e) => toast("Export failed — " + e.message, "err"))}>
              Download edited
            </button>
            <button className="btn small" disabled={!!busy} title="Rebuild the PDF from your edited text and make it the stored version"
              onClick={publish}>{busy === "pub" ? "Rebuilding…" : "Save edits as the PDF"}</button>
          </>
        )}
        {cur && (
          <button className="btn small danger" disabled={!!busy} onClick={async () => {
            if (!confirm("Delete “" + (cur.label || "this resume") + "” — its PDF and its text?")) return;
            const r = await fetch("/api/resume/" + cur.slot, { method: "DELETE" });
            if (!r.ok) return toast("Couldn't delete it on the server — nothing changed.", "err");
            writeResumes((list) => list.filter((x) => x.slot !== cur.slot));
            setActive(0);
            toast("Resume deleted.");
          }}>Delete</button>
        )}
      </div>

      {meta && <PdfView slot={cur.slot} nonce={nonce} />}

      {text.trim() ? (
        <>
          <label className="f">Resume text — edit freely</label>
          <textarea className="in mono" style={{ minHeight: 240, fontSize: 12.5, lineHeight: 1.5 }} value={text}
            onChange={(e) => patch(cur.slot, { text: e.target.value.slice(0, MAX_RESUME_CHARS) })} />
          <div className="note">
            {text.trim().split(/\s+/).length} words. Edits feed fit scoring, tailoring and the assistant.
            <b> Download edited</b> gives you a file; <b>Save edits as the PDF</b> makes them the stored version you see above.
          </div>
          {config?.aiEnabled && (
            <>
              <div className="row" style={{ marginTop: 8 }}>
                <input className="in" style={{ flex: 1, minWidth: 180 }} placeholder="Tell the AI how to edit it — e.g. 'make it IAM-focused, cut to one page'"
                  value={instr} onChange={(e) => setInstr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && aiEdit()} />
                <button className="btn small" disabled={!!busy} onClick={aiEdit}>{busy === "ai" ? "Rewriting…" : "Edit with AI"}</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="note" style={{ margin: 0 }}>
                  Reads as <b style={{ color: "var(--acc)" }}>{(LEVELS.find(([k]) => k === myLevel) || [, myLevel])[1]}</b>
                  {levelSource === "ai" ? " (AI)" : " (from keywords)"} — the finder defaults to this rung and the one above.
                  {S.levelAI?.why ? " " + S.levelAI.why : ""}
                </span>
                <button className="btn small" disabled={!!busy} onClick={estimateLevel}>
                  {busy === "level" ? "Reading…" : "Re-check my level"}
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="note" style={{ margin: 0 }}>Make a tailored copy for</span>
                <select className="in" style={{ width: 220 }} value={tailorTarget} onChange={(e) => setTailorTarget(e.target.value)}>
                  <option value="">— use the instruction above —</option>
                  {apps.map((a) => <option key={a.id} value={a.id}>{a.company} · {a.role}</option>)}
                </select>
                <button className="btn small" disabled={!!busy || !freeSlot()} title={freeSlot() ? "Writes a new resume into its own tab — this one is untouched" : "Five resumes is the limit — delete one first"}
                  onClick={makeVariant}>{busy === "variant" ? "Writing…" : "New tailored resume"}</button>
              </div>
            </>
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
              patch(cur.slot, { text: draft.slice(0, MAX_RESUME_CHARS) });
              setDraft(null); toast("Resume text replaced — Save edits as the PDF when you're happy with it.");
            }}>Use this version</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/* The original Habitat question, restored: not "where can I get hired" but
   "where can we BOTH get hired, and what is left over after rent." A city only
   counts if it clears both bars, so a $95k offer in a city where the other
   person has nothing to apply to ranks below a $70k one where they do. */
function TwoCareerCities({ S, apps, setCareer }) {
  const [minPartner, setMinPartner] = useState(2);
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    /* what you could actually earn there, from your own tracked targets */
    const byCity = {};
    for (const a of apps) {
      if (a.status === "Rejected" || a.status === "Withdrawn") continue;
      const m = cityMatch(a.city, S.cities);
      if (!m) continue;
      const t = totalComp(a);
      if (t == null) continue;
      (byCity[m.name] ||= []).push({ comp: t, company: a.company });
    }
    return S.cities
      .filter((c) => (c.partner ?? 0) >= minPartner)
      .map((c) => {
        const mine = (byCity[c.name] || []).sort((x, y) => y.comp - x.comp);
        const best = mine[0] || null;
        /* adjusted to your home cost of living so the numbers are comparable */
        const adj = best ? Math.round(best.comp / (c.col / 100)) : null;
        return { ...c, targets: mine.length, best, adj };
      })
      .sort((a, b) => (b.adj || 0) - (a.adj || 0) || (b.partner - a.partner) || (a.col - b.col));
  }, [S.cities, apps, minPartner]);

  const withTargets = rows.filter((r) => r.targets > 0);
  const show = open ? rows : rows.slice(0, 8);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Where you could both work</h3>
        <a className="btn small" href={AZA_JOBS} target="_blank" rel="noreferrer noopener">AZA job board</a>
      </div>
      <div className="note" style={{ marginTop: 0 }}>
        Ranked by what your best tracked target there pays after cost of living, but only showing cities
        where the zoo / aquarium / conservation side is real. A city you can't both work in isn't an option,
        however good the salary looks.
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <span className="note" style={{ margin: 0 }}>Partner-side market at least</span>
        <select className="in" style={{ width: 150 }} value={minPartner} onChange={(e) => setMinPartner(Number(e.target.value))}>
          <option value={3}>Excellent only</option>
          <option value={2}>Solid or better</option>
          <option value={1}>Anything at all</option>
          <option value={0}>Show every city</option>
        </select>
        <span className="note" style={{ margin: 0 }}>
          {rows.length} cities · {withTargets.length} where you already track a target
        </span>
      </div>

      <div className="hscroll" style={{ marginTop: 8 }}>
        <table className="tbl" style={{ minWidth: 620 }}>
          <thead>
            <tr>
              <th>City</th><th>Their side</th><th style={{ textAlign: "right" }}>COL</th>
              <th style={{ textAlign: "right" }}>Your best target</th><th style={{ textAlign: "right" }}>Adjusted</th>
            </tr>
          </thead>
          <tbody>
            {show.map((c) => (
              <tr key={c.name}>
                <td>
                  <b>{c.name}</b>
                  <div className="note" style={{ margin: 0, fontSize: 11, maxWidth: 300 }}>{c.orgs || "—"}</div>
                </td>
                <td><span className="tag" style={{ color: partnerColor(c.partner), borderColor: partnerColor(c.partner) }}>{partnerLabel(c.partner)}</span></td>
                <td className="mono" style={{ textAlign: "right", color: c.col <= 95 ? "var(--up)" : c.col >= 130 ? "var(--down)" : undefined }}>{c.col}</td>
                <td style={{ textAlign: "right" }}>
                  {c.best ? <><span className="mono">{money(c.best.comp)}</span>
                    <div className="note" style={{ margin: 0, fontSize: 11 }}>{c.best.company}{c.targets > 1 ? " +" + (c.targets - 1) : ""}</div></>
                    : <span className="note" style={{ margin: 0 }}>nothing tracked</span>}
                </td>
                <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{c.adj ? money(c.adj) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 8 && (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
          {open ? "Show fewer" : "Show all " + rows.length}
        </button>
      )}
      {!withTargets.length && (
        <div className="note">
          None of your tracked targets sit in these cities yet — <b>Load starter targets</b>, or add a company
          in one of them, and this table starts comparing real money instead of just cost of living.
        </div>
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
      {app.comp > 0 && (
        <>
          <label className="f">Does starting here cap you?</label>
          {(() => {
            /* The real mechanism, not vibes: internal raises are a percentage of
               what you already earn, so a starting gap widens instead of closing.
               Changing employer is what resets the base. Worth SEEING, because
               the conclusion is "take it and move in 2-3 years", not "don't". */
            const higher = Math.round(app.comp * 1.2);
            const stay = compoundGap(app.comp, higher, 10);
            const hop = compoundGap(app.comp, higher, 10, 0.035, 3, 0.18);
            return (
              <>
                <div className="kv"><span className="k">Staying put, 3.5%/yr raises — in 10 years</span>
                  <span className="mono">{money(stay.a)} <span style={{ color: "var(--faint)" }}>vs {money(stay.b)} from a {money(higher)} start</span></span></div>
                <div className="kv"><span className="k">Same start, but moving every 3 years (+18%)</span>
                  <span className="mono good">{money(hop.a)}</span></div>
                <div className="note" style={{ marginTop: 4 }}>
                  A {money(app.comp)} start does follow you — after ten years of internal raises alone it's still
                  about {Math.round(((stay.b - stay.a) / stay.a) * 100)}% behind a start {money(higher - app.comp)} higher, because every raise
                  is a percentage of a smaller number. But changing employer resets the base, and that single lever
                  outruns the whole gap: the third row starts at the <i>lower</i> number and still ends ahead.
                  So a lower first offer with real work on it isn't a trap — staying in it for eight years is.
                </div>
              </>
            );
          })()}
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

/* A city list saved before the Habitat data existed overrides the default wholesale
   and would come back with no partner info at all. Fill the new fields in by name
   without touching anything the user edited (their own col/tier stay theirs). */
function withPartnerData(cities) {
  if (!Array.isArray(cities) || !cities.length) return DEFAULT_CITIES;
  return cities.map((c) => {
    if (c.partner != null) return c;
    const d = DEFAULT_CITIES.find((x) => x.name.toLowerCase() === String(c.name || "").toLowerCase());
    return d ? { ...c, partner: d.partner, orgs: d.orgs } : { ...c, partner: 0, orgs: "" };
  });
}

export default function Career({ d, setD, config, toast }) {
  const career = d.career || DEFAULT_CAREER;
  const S0 = { ...DEFAULT_CAREER.settings, ...(career.settings || {}) };
  const S = { ...S0, cities: withPartnerData(S0.cities) };
  const apps = career.apps || [];
  /* Where you sit on the ladder, read off the resume — the AI estimate wins if
     you've run one, since it can read scope and impact that a regex can't. */
  const myLevel = S.levelAI?.level || guessMyLevel(S.resume) || "entry";

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
  const [letterFor, setLetterFor] = useState(null);
  const [letterOut, setLetterOut] = useState("");
  const [letterBusy, setLetterBusy] = useState(false);

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
  /* "in flight" means still live — a rejection is not in flight */
  const inFlight = apps.filter((a) => a.status === "Applied" || a.status === "Interviewing" || a.status === "Offer").length;

  const tailorReq = useRef(0);
  const tailor = async (a) => {
    if (busy) return;
    if (!S.resume.trim()) return toast("Upload a resume below first — tailoring rewrites it against the role.", "err");
    const req = ++tailorReq.current; // a slow response for company A must not land in company B's sheet
    setTailorFor(a); setTailorOut(""); setBusy(true);
    try {
      const out = (await callClaude(
        "Resume:\n" + S.resume.slice(0, 8000) +
        projectsBrief(S, a.company + " " + a.role + " " + (a.cat || "")) +
        "\n\nTarget role: " + a.role + " at " + a.company + (a.city ? " in " + a.city : "") +
        (a.clearance === "Required" ? " (requires a security clearance)" : "") +
        "\n\nRewrite the 5–7 resume bullets that matter most for THIS role. Keep every claim truthful to the resume — " +
        "reword and reorder, never invent experience. Lead each bullet with the outcome, name the tool or standard where the " +
        "resume gives you one, and keep each under 22 words. Plain text, one bullet per line starting with '- '. " +
        "After the bullets add a line 'GAPS:' and name up to three things this resume genuinely lacks for the role."
      )).trim();
      if (req !== tailorReq.current) return;
      if (!out) throw new Error("the model returned nothing");
      setTailorOut(out);
    } catch (e) {
      if (req !== tailorReq.current) return;
      toast("Tailoring failed — " + e.message, "err"); setTailorFor(null);
    }
    if (req === tailorReq.current) setBusy(false);
  };

  /* A cover letter is a first draft, never a send-as-is artifact. It comes out
     deliberately plain and short, and it lands in an editable box with the
     honest warning attached — a letter that reads like a model wrote it is the
     thing that gets you skipped, not the fact that one helped. */
  const letterReq = useRef(0);
  const coverLetter = async (a) => {
    if (letterBusy) return;
    const base = readResumes(S)[0]?.text || "";
    if (!base.trim()) return toast("Upload a resume below first — the letter is built from it.", "err");
    const req = ++letterReq.current;
    setLetterFor(a); setLetterOut(a.cover || ""); setLetterBusy(true);
    try {
      const out = (await callClaude(
        "Resume:\n" + base.slice(0, 7000) +
        projectsBrief(S, a.company + " " + a.role + " " + (a.cat || "")) +
        "\n\nTarget: " + a.role + " at " + a.company + (a.city ? " in " + a.city : "") +
        (a.notes ? "\nWhat I know about this role: " + String(a.notes).slice(0, 600) : "") +
        "\n\nWrite a cover letter draft in the FIRST PERSON as this candidate. Rules: 200–260 words, four short paragraphs, " +
        "no greeting flourish beyond 'Dear Hiring Team,'. Every specific must come from the resume — never invent a project, " +
        "a number, an employer or an interest. Name two concrete things from the resume that map to this role and say plainly " +
        "why they map. No superlatives, no 'I am excited to', no 'passionate', no 'thrilled', no 'I believe I would be a great " +
        "fit', no restating the job description back at them. Write in short declarative sentences a real person would say out " +
        "loud. Plain text only."
      )).trim();
      if (req !== letterReq.current) return;
      if (!out) throw new Error("the model returned nothing");
      setLetterOut(out);
    } catch (e) {
      if (req !== letterReq.current) return;
      toast("Couldn't draft that letter — " + e.message, "err"); setLetterFor(null);
    }
    if (req === letterReq.current) setLetterBusy(false);
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
              <div><div className="sub">In flight</div><div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{inFlight}</div></div>
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
        const home = cityMatch(a.city, S.cities);
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
                <span className="note" style={{ display: "block", margin: 0, fontSize: 12 }}>
                  {a.role} · {a.locationType === "Remote" ? "Remote" : a.city || "city TBD"}
                  {f.fit ? <span className="good"> · fits{f.cityTier ? " (" + f.cityTier + ")" : ""}</span> : <span className="bad"> · outside your cities</span>}
                  {a.clearance === "Required" && " · clearance"}
                  {a.window && " · " + a.window}
                </span>
                {/* an onsite job in a city with nothing for the other half of the
                    household is a worse offer than its salary suggests */}
                {home && a.locationType !== "Remote" && (
                  <span className="note" style={{ display: "block", margin: 0, fontSize: 11.5, color: partnerColor(home.partner) }}>
                    Their side: {partnerLabel(home.partner)}{home.orgs ? " — " + home.orgs : ""}
                  </span>
                )}
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
              {config?.aiEnabled && <button className="btn small" disabled={busy} onClick={() => tailor(a)}>Tailor resume</button>}
              {config?.aiEnabled && (
                <button className="btn small" disabled={letterBusy} onClick={() => coverLetter(a)}>
                  {a.cover ? "Cover letter ✓" : "Cover letter"}
                </button>
              )}
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

      <Timeline S={S} apps={apps} setCareer={setCareer} setEditing={setEditing} />

      <JobFinder S={S} apps={apps} setCareer={setCareer} toast={toast} myLevel={myLevel} />

      <TwoCareerCities S={S} apps={apps} setCareer={setCareer} />

      <ResumeCard S={S} setCareer={setCareer} config={config} toast={toast} apps={apps}
        myLevel={myLevel} levelSource={S.levelAI?.level ? "ai" : S.resume ? "resume" : null} />

      <Projects S={S} setCareer={setCareer} toast={toast} aiEnabled={config?.aiEnabled} />

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
      {letterFor && (
        <Sheet title={"Cover letter draft — " + letterFor.company} onClose={() => setLetterFor(null)}>
          <div className="note" style={{ marginTop: 0 }}>
            <b>Rewrite this in your own words before you send it.</b> Almost no employer runs an AI detector on cover letters —
            their system parses it for keywords and a human skims it. What gets you skipped is a letter that sounds like every
            other letter: generic praise, the job description read back to them, no specific you could only have written.
            Use this for the structure and the facts, then say it the way you'd say it.
          </div>
          {letterBusy ? <div className="note">Drafting from your resume…</div> : (
            <textarea className="in" style={{ minHeight: 300, fontSize: 13, lineHeight: 1.55 }}
              value={letterOut} onChange={(e) => setLetterOut(e.target.value.slice(0, 8000))} />
          )}
          <div className="mrow">
            <button className="btn" disabled={letterBusy} onClick={() => { navigator.clipboard?.writeText(letterOut); toast("Copied."); }}>Copy</button>
            <button className="btn" disabled={letterBusy || !letterOut.trim()}
              onClick={() => buildPdf(letterOut).then((doc) => doc.save(("cover-" + letterFor.company + ".pdf").replace(/[^\w.() -]/g, "")))
                .catch((e) => toast("Export failed — " + e.message, "err"))}>Download PDF</button>
            <button className="btn primary" disabled={letterBusy} onClick={() => {
              saveApp({ ...letterFor, cover: letterOut });
              setLetterFor(null); toast("Saved to " + letterFor.company + " — it'll be here next time.");
            }}>Save to this application</button>
          </div>
        </Sheet>
      )}
    </>
  );
}
