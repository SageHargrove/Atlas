import React, { useState, useMemo, useEffect, useRef } from "react";
import { DEFAULT_CITIES, AZA_JOBS, partnerLabel, partnerColor, CAT_GROWTH, cityMatch, parseWindow, absMonth,
  offerValue, baseToMatch, PENSION_DEFAULT_PCT, MARKET_PREMIUM } from "./careerData.js";
import JobFinder, { guessMyLevel, yearsFromResume, LEVELS } from "./JobFinder.jsx";
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

/* `wide` is for the profile workspace: a resume PDF at 540px is unreadable, and
   the whole point of moving it off the page was to get room to actually work. */
function Sheet({ title, onClose, children, wide }) {
  /* A full-window workspace over a page that still scrolls means the wheel moves
     the thing behind it the moment the document pane hits its end. Lock it. */
  useEffect(() => {
    if (!wide) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [wide]);
  return (
    <div className={"ov" + (wide ? " ovfull" : "")} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " wide" : "")}>
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
/* Renders at device pixel ratio and lets CSS size it, so the page is sharp on a
   retina screen instead of the upscaled blur a fixed 300px canvas produced. */
function PdfView({ slot = 1, nonce, big }) {
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
        const max = big ? 8 : 4;
        for (let p = 1; p <= Math.min(doc.numPages, max); p++) {
          const page = await doc.getPage(p);
          const scale = big ? 2.6 : 1.4;
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
  }, [slot, nonce, big]);

  if (err) return <div className="note">Preview unavailable{err !== "no file" ? " — " + err : ""}.</div>;
  if (!pages) return <div className="note">Rendering preview…</div>;

  /* Stacked down the page, full width, like reading the actual document. The
     old side-by-side 300px thumbnails were a filmstrip, not a resume. */
  if (big) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "center" }}>
      {pages.map((src, i) => (
        <img key={i} src={src} alt={"Resume page " + (i + 1)}
          style={{ width: "100%", maxWidth: 820, borderRadius: 8, border: "1px solid var(--line2)", background: "#fff", display: "block" }} />
      ))}
    </div>
  );
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
  const [view, setView] = useState("pdf");  // the document pane: rendered PDF or editable text
  const autoYears = useMemo(() => yearsFromResume(S.resume), [S.resume]);

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

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="card">
      {/* Document centre stage, controls in a rail beside it — a resume you can
          only see at thumbnail size is a resume you can't actually work on. */}
      <div className="rwork">
        <div className="rdoc">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <div className="tabs" style={{ flexWrap: "wrap" }}>
              {resumes.map((r, i) => (
                <button key={r.slot} className={"tab" + (i === idx ? " on" : "")} onClick={() => { setActive(i); setNonce((n) => n + 1); }}>
                  {r.label || "Resume " + r.slot}
                </button>
              ))}
              {resumes.length > 0 && resumes.length < 5 && (
                <button className="tab" disabled={!!busy} onClick={() => document.getElementById("resume-add").click()}>+</button>
              )}
            </div>
            {text.trim() && (
              <div className="pills">
                <button className={"pill" + (view === "pdf" ? " on" : "")} onClick={() => setView("pdf")}>PDF</button>
                <button className={"pill" + (view === "text" ? " on" : "")} onClick={() => setView("text")}>Text</button>
              </div>
            )}
          </div>

          <div className="rpane">
          {!cur ? (
            <div className="rempty">
              <div style={{ fontSize: 15, fontWeight: 600 }}>No resume yet</div>
              <div className="note" style={{ maxWidth: 380 }}>
                Upload the PDF you actually send. Atlas keeps the original file and pulls its text out so you — and the
                AI — can work on it. Stored with your finances: same private directory, same encrypted backups.
              </div>
              <button className="btn primary" disabled={!!busy} onClick={() => document.getElementById("resume-pick").click()}>
                {busy === "read" ? "Reading…" : "Upload a PDF"}
              </button>
            </div>
          ) : view === "text" ? (
            <textarea className="in mono rtext" value={text}
              onChange={(e) => patch(cur.slot, { text: e.target.value.slice(0, MAX_RESUME_CHARS) })} />
          ) : meta ? (
            <PdfView slot={cur.slot} nonce={nonce} big />
          ) : (
            <div className="rempty"><div className="note">This one has text but no stored PDF — <b>Save edits as the PDF</b> builds one.</div></div>
          )}
          </div>
        </div>

        <div className="rside">
          {cur && (
            <>
              <label className="f" style={{ marginTop: 0 }}>Name</label>
              <input className="in" value={cur.label || ""} placeholder="e.g. IAM / utilities"
                onChange={(e) => patch(cur.slot, { label: e.target.value.slice(0, 24) })} />
              <div className="note" style={{ fontSize: 11.5 }}>
                {meta ? meta.name + " · " + meta.pages + " pg · " + meta.uploaded : "no PDF stored"}
                {words ? " · " + words + " words" : ""}
                {resumes.length > 1 && (idx === 0
                  ? " · fit scoring reads this one"
                  : " · fit scoring reads " + (resumes[0].label || "Resume 1") + ", not this")}
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn small primary" disabled={!!busy} onClick={() => document.getElementById("resume-pick").click()}>
                  {busy === "read" ? "Reading…" : "Replace PDF"}
                </button>
                {meta && <a className="btn small" href={"/api/resume/" + cur.slot} target="_blank" rel="noreferrer noopener">Open</a>}
              </div>
              {text.trim() && (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn small" disabled={!!busy} title="Rebuild the stored PDF from your edited text"
                    onClick={publish}>{busy === "pub" ? "Rebuilding…" : "Save edits as PDF"}</button>
                  <button className="btn small" disabled={!!busy}
                    onClick={() => buildPdf(text).then((doc) => doc.save(((cur.label || "resume") + "-" + new Date().toISOString().slice(0, 10) + ".pdf").replace(/[^\w.() -]/g, ""))).catch((e) => toast("Export failed — " + e.message, "err"))}>
                    Download
                  </button>
                </div>
              )}

              {config?.aiEnabled && text.trim() && (
                <>
                  <label className="f">Ask the AI to change it</label>
                  <textarea className="in" style={{ minHeight: 62, fontSize: 12.5 }}
                    placeholder="e.g. make it IAM-focused and cut it to one page"
                    value={instr} onChange={(e) => setInstr(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) aiEdit(); }} />
                  <button className="btn small" style={{ marginTop: 6 }} disabled={!!busy} onClick={aiEdit}>
                    {busy === "ai" ? "Rewriting…" : "Rewrite — you approve first"}
                  </button>

                  <label className="f">Tailored copy for a target</label>
                  <select className="in" value={tailorTarget} onChange={(e) => setTailorTarget(e.target.value)}>
                    <option value="">— use the instruction above —</option>
                    {apps.map((a) => <option key={a.id} value={a.id}>{a.company} · {a.role}</option>)}
                  </select>
                  <button className="btn small" style={{ marginTop: 6 }} disabled={!!busy || !freeSlot()}
                    title={freeSlot() ? "Writes a new resume into its own tab — this one is untouched" : "Five resumes is the limit — delete one first"}
                    onClick={makeVariant}>{busy === "variant" ? "Writing…" : "New tailored resume"}</button>

                  <label className="f">Your level</label>
                  <div className="note" style={{ marginTop: 0, fontSize: 11.5 }}>
                    Reads as <b style={{ color: "var(--acc)" }}>{(LEVELS.find(([k]) => k === myLevel) || [, myLevel])[1]}</b>
                    {levelSource === "ai" ? " (AI)" : " (from keywords)"}. {S.levelAI?.why || ""}
                    {S.levelAI?.next ? " To move up: " + S.levelAI.next : ""}
                  </div>
                  <button className="btn small" style={{ marginTop: 6 }} disabled={!!busy} onClick={estimateLevel}>
                    {busy === "level" ? "Reading…" : "Re-check my level"}
                  </button>

                  {/* the number that decides whether a "3+ years" posting is a
                      real option — counted off the resume's own dates, editable
                      because dates can't see freelance work or a gap */}
                  <label className="f">Years of experience</label>
                  <div className="row">
                    <input className="in mono" type="number" step="0.5" min="0" max="40" style={{ width: 84 }}
                      value={S.myYears ?? autoYears} onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, myYears: e.target.value === "" ? null : Number(e.target.value) } }))} />
                    {S.myYears != null && (
                      <button className="btn small" onClick={() => setCareer((c) => ({ ...c, settings: { ...c.settings, myYears: null } }))}>Use {autoYears}</button>
                    )}
                  </div>
                  <div className="note" style={{ fontSize: 11.5 }}>
                    {S.myYears == null ? "Counted from the dates on your resume — overlapping stints aren't double-counted." : "Yours, overriding the " + autoYears + " counted from your resume."}
                    {" "}A posting asking for more than this drops its odds sharply, because recruiters filter on years before they ever read the skills.
                  </div>
                </>
              )}

              {/* its own line, away from the harmless buttons — this one deletes a file */}
              <button className="btn small danger" style={{ marginTop: 18, display: "block" }} disabled={!!busy} onClick={async () => {
                if (!confirm("Delete “" + (cur.label || "this resume") + "” — its PDF and its text?")) return;
                const r = await fetch("/api/resume/" + cur.slot, { method: "DELETE" });
                if (!r.ok) return toast("Couldn't delete it on the server — nothing changed.", "err");
                writeResumes((list) => list.filter((x) => x.slot !== cur.slot));
                setActive(0);
                toast("Resume deleted.");
              }}>Delete this resume</button>
            </>
          )}
        </div>
      </div>

      <input id="resume-pick" type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
        onChange={(e) => { pick(e.target.files[0]); e.target.value = ""; }} />
      <input id="resume-add" type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
        onChange={(e) => { pick(e.target.files[0], freeSlot()); e.target.value = ""; }} />

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
/* Your ranking of a city, not Atlas's. The old column was "their side", which
   answered a question you can already see in the org list — what you actually
   want at a glance is how much YOU want to live there, and that is a judgement
   only you can make. S through F, editable, defaulting to the shipped tiers. */
const CITY_TIERS = ["S", "A", "B", "C", "D", "F"];
const TIER_CLR = { S: "var(--up)", A: "var(--acc)", B: "var(--gold)", C: "var(--faint)", D: "var(--faint)", F: "var(--down)" };

function TwoCareerCities({ S, apps, setCareer, onShow }) {
  const [minPartner, setMinPartner] = useState(2);
  const [sort, setSort] = useState("adj");
  const [shown, setShown] = useState(8);
  const [openCity, setOpenCity] = useState(null);

  const setTier = (name, tier) => setCareer((c) => ({ ...c, settings: { ...c.settings,
    cities: withPartnerData(c.settings.cities).map((x) => (x.name === name ? { ...x, tier } : x)) } }));

  const rows = useMemo(() => {
    /* every tracked target in each city, not just the best one — "what could I
       do in Tampa" is the question, and one company name doesn't answer it */
    const byCity = {};
    for (const a of apps) {
      if (a.status === "Rejected" || a.status === "Withdrawn") continue;
      const m = cityMatch(a.city, S.cities);
      if (!m) continue;
      (byCity[m.name] ||= []).push({ id: a.id, company: a.company, role: a.role, comp: totalComp(a), status: a.status });
    }
    return S.cities
      .filter((c) => (c.partner ?? 0) >= minPartner)
      .map((c) => {
        const mine = (byCity[c.name] || []).sort((x, y) => (y.comp || 0) - (x.comp || 0));
        const best = mine[0] || null;
        return { ...c, targets: mine, best, adj: best?.comp ? Math.round(best.comp / (c.col / 100)) : null };
      })
      .sort({
        adj: (a, b) => (b.adj || 0) - (a.adj || 0) || (b.partner - a.partner) || (a.col - b.col),
        tier: (a, b) => CITY_TIERS.indexOf(a.tier) - CITY_TIERS.indexOf(b.tier) || (b.adj || 0) - (a.adj || 0),
        partner: (a, b) => (b.partner - a.partner) || (b.adj || 0) - (a.adj || 0),
        col: (a, b) => a.col - b.col || (b.partner - a.partner),
        name: (a, b) => a.name.localeCompare(b.name),
      }[sort]);
  }, [S.cities, apps, minPartner, sort]);

  const withTargets = rows.filter((r) => r.targets.length > 0);

  return (
    <>
      <div className="note" style={{ marginTop: 0 }}>
        Cities you'd both be able to work in. Tier is <b>your</b> ranking of the place; the org list is what's there for
        her. A city you can't both work in isn't an option, however good the salary looks.
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <span className="note" style={{ margin: 0 }}>Her side at least</span>
        <select className="in" style={{ width: 148 }} value={minPartner} onChange={(e) => setMinPartner(Number(e.target.value))}>
          <option value={3}>Excellent only</option>
          <option value={2}>Solid or better</option>
          <option value={1}>Anything at all</option>
          <option value={0}>Every city</option>
        </select>
        <select className="in" style={{ width: 176 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="adj">Sort: adjusted pay</option>
          <option value="tier">Sort: my tier</option>
          <option value="partner">Sort: best for her</option>
          <option value="col">Sort: cheapest</option>
          <option value="name">Sort: A–Z</option>
        </select>
        <span className="note" style={{ margin: 0 }}>{rows.length} cities · {withTargets.length} with a target</span>
        <a className="btn small" href={AZA_JOBS} target="_blank" rel="noreferrer noopener">AZA jobs</a>
      </div>

      <div className="hscroll" style={{ marginTop: 8 }}>
        <table className="tbl" style={{ minWidth: 620 }}>
          <thead>
            <tr>
              {/* no separate "for her" column: a C-tier city showing "Excellent
                  for her" is a contradiction on its face. The tier IS the
                  combined verdict — your work and hers — and the org list under
                  the city name is the evidence behind it. */}
              <th style={{ width: 74 }}>Tier</th><th>City</th>
              <th style={{ textAlign: "right" }}>COL</th>
              <th>What you could do there</th>
              <th style={{ textAlign: "right" }}>Adjusted</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((c) => (
              <tr key={c.name}>
                {/* always a select, never behind an edit mode — a ranking you
                    have to unlock before changing is a ranking you won't keep
                    current */}
                <td>
                  <select className="in mono" style={{ width: 58, padding: "2px 5px", fontSize: 13, fontWeight: 600, color: TIER_CLR[c.tier] }}
                    value={c.tier} onChange={(e) => setTier(c.name, e.target.value)} title="Your ranking of this city">
                    {CITY_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td>
                  <b>{c.name}</b>
                  <div className="note" style={{ margin: 0, fontSize: 11, maxWidth: 320, color: partnerColor(c.partner) }}>
                    {c.orgs || "nothing local for her"}
                  </div>
                </td>
                <td className="mono" style={{ textAlign: "right", color: c.col <= 95 ? "var(--up)" : c.col >= 130 ? "var(--down)" : undefined }}>{c.col}</td>
                {/* clicking a company takes you to it in the finder, where the
                    pay, odds and reasoning already live — a list of names with
                    nowhere to go was just a second, worse copy of that card */}
                <td>
                  {c.targets.length === 0 ? <span className="note" style={{ margin: 0 }}>nothing tracked</span> : (
                    <div className="row" style={{ gap: 4, flexWrap: "wrap", maxWidth: 320 }}>
                      {(openCity === c.name ? c.targets : c.targets.slice(0, 2)).map((t) => (
                        <button key={t.id} className="tag" style={{ cursor: "pointer", background: "none", borderColor: "var(--line2)" }}
                          title={"Open " + t.company + " in the finder"} onClick={() => onShow(t.company)}>
                          {t.company} · {money(t.comp)}
                        </button>
                      ))}
                      {c.targets.length > 2 && (
                        <button className="tag" style={{ cursor: "pointer", background: "none", color: "var(--acc)", borderColor: "var(--acc)" }}
                          onClick={() => setOpenCity(openCity === c.name ? null : c.name)}>
                          {openCity === c.name ? "fewer" : "+" + (c.targets.length - 2) + " more"}
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{c.adj ? money(c.adj) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > shown && (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setShown((n) => n + 5)}>
          Show 5 more — {rows.length - shown} hidden
        </button>
      )}
      {!withTargets.length && (
        <div className="note">
          None of your tracked targets sit in these cities yet — track a few from the finder and this starts comparing
          real money instead of just cost of living.
        </div>
      )}
    </>
  );
}

/* A card that starts shut. Five open cards stacked down a page is the same
   mistake as thirty filter controls in a row: everything is visible, so nothing
   is. The one you use constantly stays open; the rest announce what's inside
   and wait to be asked. */
function Fold({ title, sub, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="card">
      <button className="foldhead" onClick={() => setOpen((v) => !v)}>
        <span className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {sub && <span className="note" style={{ margin: 0, fontSize: 12 }}>{sub}</span>}
        </span>
        <span className="note" style={{ margin: 0 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

/* The offer you already have, priced properly.

   A base salary is not an offer. A utility's $67k with a company-paid pension,
   a 4.75% match and insurance at a third of market is not beaten by a $75k
   consultancy — but the opposite error is just as easy, and worse: counting a
   pension you'll never vest in. So the vest horizon is an input, and the number
   changes when you change your mind about how long you'd stay. */
/* One field per row-cell with its label above it, rather than a run of inputs
   with labels wedged between them. The old layout put "401k match %" beside a
   72px box and the number itself got clipped — a form that hides the value you
   just typed is worse than one that takes more vertical space. */
function Field({ label, hint, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label className="f" style={{ marginTop: 0 }}>{label}</label>
      {children}
      {hint && <div className="note" style={{ margin: "3px 0 0", fontSize: 11 }}>{hint}</div>}
    </div>
  );
}

function FloorOffer({ S, setCareer }) {
  const f = S.floorOffer || {};
  const set = (k, v) => setCareer((c) => ({ ...c, settings: { ...c.settings, floorOffer: { ...(c.settings.floorOffer || {}), [k]: v } } }));
  const num = (k) => (e) => set(k, e.target.value === "" ? null : Number(e.target.value));
  const col = cityMatch(f.city, S.cities)?.col || (f.remote ? (S.remoteCol || 90) : 100);
  const v = offerValue({ ...f, col });
  const [open, setOpen] = useState(false);
  const wide = { width: "100%" };

  return (
    <>
      <div className="note" style={{ marginTop: 0 }}>
        The offer you're confident of. Everything in the finder is measured against it, so a posting reads
        <b> +$18k vs floor</b> rather than a bare number — the question isn't whether you can get a job, it's whether
        anything beats the one you already have.
      </div>

      <div className="grid4" style={{ marginTop: 12 }}>
        <Field label="Company">
          <input className="in" style={wide} placeholder="e.g. SPP" value={f.company || ""}
            onChange={(e) => set("company", e.target.value.slice(0, 40))} />
        </Field>
        <Field label="Base salary">
          <input className="in mono" style={wide} type="number" placeholder="67000" value={f.base ?? ""} onChange={num("base")} />
        </Field>
        <Field label="City" hint="leave blank if remote">
          <input className="in" style={wide} placeholder="Little Rock" value={f.city || ""}
            onChange={(e) => set("city", e.target.value.slice(0, 40))} />
        </Field>
        <Field label="Remote">
          <label className="row" style={{ gap: 7, margin: "6px 0 0" }}>
            <input type="checkbox" checked={!!f.remote} onChange={(e) => set("remote", e.target.checked)} />
            <span className="note" style={{ margin: 0 }}>works from anywhere</span>
          </label>
        </Field>
      </div>

      <label className="f">What the benefits are worth</label>
      <div className="grid4">
        <Field label="Bonus target %" hint="on-target annual bonus">
          <input className="in mono" style={wide} type="number" placeholder="10" value={f.bonusPct ?? ""} onChange={num("bonusPct")} />
        </Field>
        <Field label="Employer 401k %" hint="what THEY put in, as a % of your pay">
          <input className="in mono" style={wide} type="number" step="0.25" placeholder="4.75" value={f.matchPct ?? ""} onChange={num("matchPct")} />
        </Field>
        {/* the part a single "match %" cannot express */}
        <Field label="…if you contribute %" hint={f.matchNeedsPct ? "costs you " + dollars((Number(f.base) || 0) * (Number(f.matchNeedsPct) / 100)) + "/yr to unlock" : "leave 0 if they match regardless"}>
          <input className="in mono" style={wide} type="number" step="0.5" placeholder="6" value={f.matchNeedsPct ?? ""} onChange={num("matchNeedsPct")} />
        </Field>
        <Field label="PTO days" hint="valued against a 10-day norm">
          <input className="in mono" style={wide} type="number" placeholder="15" value={f.ptoDays ?? ""} onChange={num("ptoDays")} />
        </Field>
      </div>

      <div className="grid4" style={{ marginTop: 12 }}>
        <Field label="Pension %" hint="employer's contribution; ~7% is typical for a utility">
          <input className="in mono" style={wide} type="number" step="0.5" placeholder={String(PENSION_DEFAULT_PCT)} value={f.pensionPct ?? ""} onChange={num("pensionPct")} />
        </Field>
        <Field label="Vests after (years)">
          <input className="in mono" style={wide} type="number" placeholder="5" value={f.vestYears ?? ""} onChange={num("vestYears")} />
        </Field>
        <Field label="You'd stay (years)" hint="a pension you won't vest in is worth nothing">
          <input className="in mono" style={wide} type="number" placeholder="3" value={f.stayYears ?? ""} onChange={num("stayYears")} />
        </Field>
        <Field label="You pay for insurance $/yr" hint={"valued against " + dollars(MARKET_PREMIUM) + " at market"}>
          <input className="in mono" style={wide} type="number" placeholder="1200" value={f.premiumPaid ?? ""} onChange={num("premiumPaid")} />
        </Field>
      </div>

      {v && (
        <>
          <div className="note" style={{ marginTop: 14 }}>
            <b>Worth {dollars(v.total)}/yr</b> — {dollars(v.adjusted)} once {f.city || "that market"}'s cost of living is
            taken out{f.remote ? " (remote)" : ""}.
            {v.matchNeeds > 0 && <> The match needs {v.matchNeeds}% of your own pay ({dollars(v.matchCost)}/yr) to unlock.</>}
            {v.pensionForfeited > 0 && (
              <span style={{ color: "var(--gold)" }}>
                {" "}The pension is excluded: it vests at {f.vestYears || 5} years and you'd stay {f.stayYears || 0}, so
                you'd walk away from {dollars(v.pensionForfeited)}/yr of it.
              </span>
            )}
            {v.vests && v.pension > 0 && <> The pension counts because you'd stay long enough to vest.</>}
          </div>
          <div className="note" style={{ marginTop: 6 }}>
            A <b>remote</b> offer needs a base near <b>{dollars(baseToMatch(v.adjusted, { bonusPct: 5, matchPct: 4, col: S.remoteCol || 90, insurance: 2000 }))}</b> to
            match it; in a 100-index city, near <b>{dollars(baseToMatch(v.adjusted, { bonusPct: 5, matchPct: 4, col: 100, insurance: 2000 }))}</b>.
            Below that you'd be taking a pay cut for the title.
          </div>
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => setOpen((x) => !x)}>
            {open ? "Hide the maths" : "Show the maths"}
          </button>
          {open && (
            <div style={{ marginTop: 8 }}>
              {v.parts.map(([label, amt]) => (
                <div className="kv" key={label} style={{ padding: "3px 0" }}>
                  <span className="k">{label}</span><span className="mono">{dollars(amt)}</span>
                </div>
              ))}
              <div className="note" style={{ fontSize: 11.5 }}>
                The pension rate is an estimate of the employer's contribution — check the plan document, it's the one
                number here that can move the answer by thousands.
              </div>
            </div>
          )}
        </>
      )}
    </>
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
/* `orgs` and `partner` are Atlas's data, not yours, so they refresh from the
   shipped list every load. The first version only filled them in when missing,
   which meant the aquariums stayed on screen forever after they were removed —
   a saved copy of a list you don't own silently outranked the corrected one.
   `tier` and `col` are yours and are never overwritten. */
function withPartnerData(cities) {
  if (!Array.isArray(cities) || !cities.length) return DEFAULT_CITIES;
  return cities.map((c) => {
    const d = DEFAULT_CITIES.find((x) => x.name.toLowerCase() === String(c.name || "").toLowerCase());
    return d ? { ...c, partner: d.partner, orgs: d.orgs } : { ...c, partner: c.partner ?? 0, orgs: c.orgs || "" };
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
  /* 20 rows of 102 was a wall. Ten is a screenful. */
  const [limit, setLimit] = useState(10);
  const [tiers, setTiers] = useState(() => new Set());
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [noClear, setNoClear] = useState(false);
  const [openNow, setOpenNow] = useState(false);
  const [tailorFor, setTailorFor] = useState(null);
  const [tailorOut, setTailorOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [letterFor, setLetterFor] = useState(null);
  const [letterOut, setLetterOut] = useState("");
  const [letterBusy, setLetterBusy] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState("resume");
  /* clicking a company anywhere on the page takes you to it in the finder,
     rather than repeating its details in a second, worse place */
  const [focusCompany, setFocusCompany] = useState(null);
  const [prepFor, setPrepFor] = useState(null);
  const [prepOut, setPrepOut] = useState("");
  const [prepBusy, setPrepBusy] = useState(false);

  const setCareer = (fn) => setD((p) => {
    const cur = p.career || DEFAULT_CAREER;
    return { ...p, career: fn({ apps: cur.apps || [], settings: { ...DEFAULT_CAREER.settings, ...(cur.settings || {}) } }) };
  });
  const saveApp = (a) => { setCareer((c) => ({ ...c, apps: c.apps.some((x) => x.id === a.id) ? c.apps.map((x) => (x.id === a.id ? a : x)) : [...c.apps, a] })); setEditing(null); };
  const deleteApp = (id) => { setCareer((c) => ({ ...c, apps: c.apps.filter((x) => x.id !== id) })); setEditing(null); };

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const now = absMonth(new Date());
    let list = apps.filter((a) => {
      if (status !== "All" && a.status !== status) return false;
      if (fitOnly && !computeFit(a, S.cities).fit) return false;
      if (tiers.size && !tiers.has(effTier(a, S))) return false;
      if (remoteOnly && a.locationType !== "Remote") return false;
      if (noClear && a.clearance === "Required") return false;
      /* "open now" is the filter that actually changes behaviour — everything
         else is browsing, this is a deadline */
      if (openNow) {
        const w = parseWindow(a.window);
        if (!w) return false;
        if (w.from != null && !(now >= w.from && (now <= w.to || w.rolling))) return false;
      }
      if (ql && !(a.company + " " + a.role + " " + (a.city || "")).toLowerCase().includes(ql)) return false;
      return true;
    });
    const cmp = {
      adj: (a, b) => (adjComp(b, S) || 0) - (adjComp(a, S) || 0),
      comp: (a, b) => (totalComp(b) || 0) - (totalComp(a) || 0),
      company: (a, b) => a.company.localeCompare(b.company),
      next: (a, b) => (a.nextDate || "9999").localeCompare(b.nextDate || "9999"),
    };
    return list.sort(cmp[sort]);
  }, [apps, q, status, fitOnly, tiers, remoteOnly, noClear, openNow, sort, S]);

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

  /* Glassdoor and Levels have real reported questions but block programmatic
     access, so this asks the model to SEARCH for what candidates actually report
     for this company and role, and to say plainly when it found nothing rather
     than dressing up generic advice as inside knowledge. */
  const prepReq = useRef(0);
  const prep = async (a) => {
    if (prepBusy) return;
    const req = ++prepReq.current;
    setPrepFor(a); setPrepOut(a.prep || ""); setPrepBusy(true);
    try {
      const base = readResumes(S)[0]?.text || "";
      const out = (await callClaude(
        "Search for interview questions candidates report being asked at " + a.company +
        " for " + (a.role || "a security role") + " or similar security/IAM roles there.\n\n" +
        (base ? "Their resume:\n" + base.slice(0, 4000) + "\n\n" : "") +
        projectsBrief(S, a.company + " " + a.role) +
        "\n\nWrite a prep sheet in plain text with these exact sections:\n" +
        "REPORTED AT THIS COMPANY — questions candidates actually report for this employer. If you found none, write " +
        "'Nothing specific found for this company' and say so plainly; do NOT invent reported questions.\n" +
        "LIKELY TECHNICAL — 6 questions for this role type, each with a one-line note on what a good answer covers.\n" +
        "THEY WILL ASK ABOUT — 3 things on this resume an interviewer will probe, quoting the resume.\n" +
        "YOUR WEAK SPOT — the gap most likely to be exposed, and the honest way to answer it.\n" +
        "ASK THEM — 4 questions worth asking, specific to this employer rather than generic.\n" +
        "No markdown, no preamble.", true)).trim();
      if (req !== prepReq.current) return;
      if (!out) throw new Error("the model returned nothing");
      setPrepOut(out);
    } catch (e) {
      if (req !== prepReq.current) return;
      toast("Couldn't build a prep sheet — " + e.message, "err"); setPrepFor(null);
    }
    if (req === prepReq.current) setPrepBusy(false);
  };

  return (
    <>
      {/* Three cards, not five, and the one you actually use is first and open.
          The tracker used to be its own card listing the same companies the
          finder already shows — it's a source filter inside the finder now. */}
      <JobFinder S={S} apps={apps} setCareer={setCareer} toast={toast} myLevel={myLevel}
        onTailor={tailor} onCoverLetter={coverLetter} onImpact={setImpact} onEdit={setEditing}
        focusCompany={focusCompany} onFocused={() => setFocusCompany(null)}
        header={
          <span className="row" style={{ gap: 6 }}>
            <button className={"btn small" + (S.resume ? "" : " primary")} onClick={() => setProfileOpen(true)}>
              {S.resume ? "Your profile" : "Add your resume"}
            </button>
            {!apps.length && (
              <button className="btn small" onClick={() => { setCareer((c) => ({ ...c, apps: seedApps() })); toast("Loaded " + SEED.length + " starter targets."); }}>
                Load starter targets
              </button>
            )}
            <button className="btn small" onClick={() => setEditing({})}>+ Add</button>
          </span>
        } />

      <Fold title="Timeline" sub={apps.length ? "when to apply, and what's left to do" : "add targets to see one"}>
        <Timeline S={S} apps={apps} setCareer={setCareer} setEditing={setEditing} />
      </Fold>

      <Fold title="Where you could both work" sub="cities that work for both of you">
        <TwoCareerCities S={S} apps={apps} setCareer={setCareer} onShow={setFocusCompany} />
      </Fold>

      {profileOpen && (
        <Sheet title={
          <span className="row" style={{ gap: 10 }}>
            <span>Your profile</span>
            <span className="pills">
              <button className={"pill" + (profileTab === "resume" ? " on" : "")} onClick={() => setProfileTab("resume")}>Resume</button>
              <button className={"pill" + (profileTab === "projects" ? " on" : "")} onClick={() => setProfileTab("projects")}>
                Projects{(S.projects || []).length ? " " + S.projects.length : ""}
              </button>
              {/* the numbers every score depends on belong with the rest of "who
                  you are", not stranded in a card at the bottom of the page */}
              <button className={"pill" + (profileTab === "assume" ? " on" : "")} onClick={() => setProfileTab("assume")}>Assumptions</button>
            </span>
          </span>
        } onClose={() => setProfileOpen(false)} wide>
          <div className="wbody">
            {profileTab === "resume" ? (
              <ResumeCard S={S} setCareer={setCareer} config={config} toast={toast} apps={apps}
                myLevel={myLevel} levelSource={S.levelAI?.level ? "ai" : S.resume ? "resume" : null} />
            ) : (
              <div style={{ overflowY: "auto", minHeight: 0, paddingRight: 6 }}>
                {profileTab === "projects" ? (
                  <Projects S={S} setCareer={setCareer} toast={toast} aiEnabled={config?.aiEnabled} />
                ) : (
                  <>
                    <FloorOffer S={S} setCareer={setCareer} />
                    <div className="grid3" style={{ marginTop: 18 }}>
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
                    <div className="note" style={{ marginTop: 12 }}>
                      Tier is comp adjusted for cost of living — Tier 1 above {money(S.tierT1)} adjusted, Tier 2 above {money(S.tierT2)}.
                      A {money(66000)} job in Little Rock can outrank a {money(95000)} job in the Bay Area.
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </Sheet>
      )}

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
      {prepFor && (
        <Sheet title={"Interview prep — " + prepFor.company} onClose={() => setPrepFor(null)}>
          <div className="note" style={{ marginTop: 0 }}>
            Glassdoor and Levels hold real reported questions but block automated access, so this searched the open web
            for what candidates report. If a section says nothing was found for this employer, believe it — that's more
            useful than generic advice wearing a company name.
          </div>
          {prepBusy ? <div className="note">Searching for what people report being asked…</div>
            : <div className="aiout" style={{ whiteSpace: "pre-wrap" }}>{prepOut}</div>}
          <div className="mrow">
            <button className="btn" disabled={prepBusy} onClick={() => { navigator.clipboard?.writeText(prepOut); toast("Copied."); }}>Copy</button>
            <button className="btn primary" disabled={prepBusy} onClick={() => {
              saveApp({ ...prepFor, prep: prepOut }); setPrepFor(null); toast("Saved to " + prepFor.company + ".");
            }}>Save to this application</button>
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
