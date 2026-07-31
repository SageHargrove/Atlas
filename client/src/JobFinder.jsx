import React, { useState, useMemo, useEffect } from "react";
import { DEFAULT_CITIES, partnerLabel, partnerColor, CAT_GROWTH, cityMatch, money } from "./careerData.js";

/* ------------------------------------------------------------------
   Job finder — the half that actually finds things.

   The server polls each employer's own public board API a few times a
   day and caches the result. This component never talks to a job site;
   it reads that cache and ranks it against you.

   Two separate numbers, deliberately not blended into one:
     Fit  — how good this job is for you (money, place, growth, focus)
     Odds — how likely you are to actually get it (level, overlap, barriers)
   A blended score hides the case that matters most: a great job you
   can't get yet, which is a thing you want to SEE, not have averaged away.
------------------------------------------------------------------ */

export const LEVELS = [
  ["intern", "Internship"], ["entry", "Entry / new grad"], ["mid", "Mid"],
  ["senior", "Senior"], ["lead", "Lead / manager"], ["principal", "Staff / principal"],
  ["executive", "Director+"],
];
const LEVEL_ORDER = LEVELS.map(([k]) => k);

/* Mirrors the server's families. Kept short here because these are buttons in a
   wrapping row, not prose. */
export const FAMILY_LABELS = [
  ["iam", "IAM / identity"], ["eng", "Security eng"], ["analyst", "Security analyst"],
  ["appsec", "AppSec"], ["grc", "GRC / compliance"], ["cloud", "Cloud / infra"],
  ["soc", "SOC / detection"], ["offsec", "Offensive"], ["other", "Other"],
];
/* What he actually wants to do, so the finder opens filtered instead of showing
   500 rows of work he has said he doesn't want. Every other area stays one
   click away — this is a default, not a decision. */
export const DEFAULT_FAMILIES = ["iam", "eng", "analyst"];

/* Postings almost never state pay, so a comp figure has to be an estimate or
   nothing. These are deliberately conservative national midpoints; anything
   shown from them is labelled "est" in the UI and never silently treated as
   a real number. A posting that DOES state pay always wins over this. */
const BASE_COMP = {
  //              intern  entry   mid     senior  lead    principal exec
  bigtech:       [45000, 130000, 165000, 205000, 250000, 275000, 330000],
  quant:         [60000, 175000, 225000, 290000, 340000, 380000, 450000],
  financial:     [40000, 95000,  125000, 155000, 185000, 205000, 260000],
  enterprise:    [38000, 90000,  120000, 150000, 180000, 200000, 250000],
  consulting:    [35000, 82000,  108000, 138000, 165000, 185000, 235000],
  cleared:       [35000, 80000,  105000, 135000, 160000, 180000, 225000],
  utility:       [32000, 74000,  96000,  122000, 145000, 165000, 205000],
};
const estComp = (cat, level) => (BASE_COMP[cat] || BASE_COMP.enterprise)[Math.max(0, LEVEL_ORDER.indexOf(level))] || null;

/* Vocabulary, not raw word overlap — "the" and "team" appear in every posting
   and would drown the signal. Only terms that mean something in this field. */
const SKILLS = [
  "iam", "identity", "iga", "pam", "privileged", "sso", "saml", "oidc", "oauth", "scim", "mfa", "rbac", "abac",
  "okta", "sailpoint", "saviynt", "cyberark", "ping", "entra", "azure ad", "active directory", "ldap", "kerberos",
  "splunk", "sentinel", "qradar", "siem", "soar", "edr", "crowdstrike", "defender", "wazuh", "elastic",
  "nist", "800-53", "800-171", "cmmc", "iso 27001", "soc 2", "pci", "hipaa", "fedramp", "nerc", "cip", "gdpr",
  "python", "powershell", "bash", "terraform", "ansible", "kubernetes", "docker", "aws", "azure", "gcp",
  "sql", "rest", "api", "git", "linux", "windows server", "vmware", "networking", "tcp/ip", "firewall", "vpn",
  "zero trust", "threat", "incident response", "forensics", "malware", "vulnerability", "pentest", "red team",
  "risk", "audit", "compliance", "grc", "governance", "access review", "provisioning", "deprovisioning",
  "security+", "cissp", "cisa", "cism", "gsec", "gcih", "gcia", "ceh", "oscp", "az-500", "sc-200",
];
const tokensOf = (text) => {
  const lc = " " + String(text || "").toLowerCase().replace(/[^a-z0-9+\-./ ]/g, " ").replace(/\s+/g, " ") + " ";
  return new Set(SKILLS.filter((s) => lc.includes(" " + s + " ") || lc.includes(" " + s + ",") || lc.includes(" " + s + ".")));
};

/* Where you sit on the ladder today, read off your own resume. Cheap and always
   on; the AI estimate (Career tab) overrides it when you've run one. */
export function guessMyLevel(resume) {
  const t = String(resume || "").toLowerCase();
  if (!t.trim()) return null;
  const yrs = [...t.matchAll(/(\d+)\+?\s*years?/g)].map((m) => Number(m[1])).filter((n) => n < 45);
  const maxYears = yrs.length ? Math.max(...yrs) : 0;
  const senior = /\b(senior|staff|principal|lead engineer|manager|architect)\b/.test(t);
  const intern = /\bintern(ship)?\b/.test(t);
  const grad = /\b(expected|graduat\w+)\s*(may|june|dec|\d{4})|b\.?s\.?|bachelor/.test(t);
  if (maxYears >= 8 || /\bprincipal\b/.test(t)) return "principal";
  if (maxYears >= 5 || senior) return "senior";
  if (maxYears >= 3) return "mid";
  if (intern && grad) return "entry";
  return maxYears >= 1 ? "entry" : "entry";
}

/* How hard the front door is, independent of you. A new grad's odds at Jane
   Street are not "stretch" — quant shops take low single-digit percentages of
   applicants and screen on competitive-programming ability, and telling someone
   otherwise is the kind of flattery that wastes a recruiting season. Utilities
   and consultancies hire volume from campus; the trading firms do not. */
const SELECTIVITY = {
  quant: 0.22, bigtech: 0.45, financial: 0.72, cleared: 0.82,
  enterprise: 0.85, consulting: 0.92, utility: 0.95,
};

function scoreJob(j, ctx) {
  const { S, myLevel, resumeTokens, hasClearance, hasResume } = ctx;
  const city = cityMatch(j.location, S.cities);
  /* The server now fills most gaps from what comparable postings actually pay;
     the static table is only the floor for a band with too few real samples. */
  const comp = j.comp || estComp(j.cat, j.level);
  const col = j.remote ? (S.remoteCol || 90) : (city?.col || 100);
  const adj = comp ? Math.round(comp / (col / 100)) : null;

  /* --- Fit: is this a job worth wanting --- */
  let money_ = 0;
  if (adj != null) money_ = Math.max(0, Math.min(35, Math.round(((adj - 60000) / ((S.tierT1 || 98000) - 60000)) * 35)));
  /* Remote is the strongest possible location outcome here: it means the city
     question goes away entirely and the partner's search picks the city. */
  const place = j.remote ? 35
    : city ? Math.round(({ S: 22, A: 19, B: 15, C: 11 }[city.tier] ?? 11) + (city.partner ?? 0) * 4.3)
    : 4;
  const growth = Math.round(((CAT_GROWTH[j.cat]?.[0] ?? 3) / 5) * 15);
  const focus = j.iam ? 15 : 8;
  const fit = Math.max(0, Math.min(100, money_ + place + growth + focus));

  /* --- Odds: could you actually land it --- */
  const rawGap = LEVEL_ORDER.indexOf(j.level) - LEVEL_ORDER.indexOf(myLevel || "entry");
  /* An unstated level defaulted to mid. Scoring that as a hard rung gap punishes
     the posting for the employer's vagueness rather than for anything true about
     you, so uncertainty is capped at one rung instead of counted in full. */
  const gap = j.levelSure === false && !j.levelBasis ? Math.min(rawGap, 1) : rawGap;
  const levelPts = gap <= -2 ? 38 : gap === -1 ? 46 : gap === 0 ? 50 : gap === 1 ? 26 : gap === 2 ? 9 : 2;
  const jt = tokensOf(j.title + " " + (j.desc || ""));
  const shared = [...jt].filter((t) => resumeTokens.has(t));
  /* With no resume there is nothing to overlap, so a neutral 12 was being handed
     out and then read as a real signal. Without one, odds are not computed at
     all — the UI says to upload instead of showing a number built on nothing. */
  const overlapPts = jt.size ? Math.round(Math.min(1, shared.length / Math.min(8, Math.max(3, jt.size))) * 35) : 12;
  const clearPts = j.clearance ? (hasClearance ? 10 : -22) : 10;
  const yearsPts = j.yearsReq == null ? 5 : j.yearsReq <= 2 ? 5 : j.yearsReq <= 4 ? 2 : -6;
  const raw = levelPts + overlapPts + clearPts + yearsPts;
  const sel = SELECTIVITY[j.cat] ?? 0.85;
  const odds = hasResume ? Math.max(1, Math.min(100, Math.round(raw * sel))) : null;

  return { ...j, city, comp, adj, estimated: !j.comp || !!j.compEst, fit, odds, sel, gap, shared, place, growth, money_ };
}

const oddsWord = (n) => (n >= 70 ? "Strong" : n >= 52 ? "Realistic" : n >= 34 ? "Stretch" : "Long shot");
const oddsColor = (n) => (n >= 70 ? "var(--up)" : n >= 52 ? "var(--acc)" : n >= 34 ? "var(--gold)" : "var(--down)");
const ago = (d) => {
  if (!d) return "";
  const days = Math.round((Date.now() - new Date(d + "T00:00:00Z").getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : days < 30 ? days + " days ago" : Math.round(days / 30) + " mo ago";
};

export default function JobFinder({ S, apps, setCareer, toast, myLevel }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [levels, setLevels] = useState(() => new Set());
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [usOnly, setUsOnly] = useState(true);
  const [iamOnly, setIamOnly] = useState(false);
  const [hideCleared, setHideCleared] = useState(false);
  const [fitCities, setFitCities] = useState(false);
  /* Off by default now. Rows wearing "Level not stated" read as noise when most
     of the list has a real rung — they're opt-in, not a permanent tax. */
  const [showUnlabelled, setShowUnlabelled] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("fit");
  /* 25 rows made the page endless. Ten is a screenful you can actually read. */
  const [limit, setLimit] = useState(10);
  const [boardUrl, setBoardUrl] = useState("");
  const [boardCo, setBoardCo] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [fams, setFams] = useState(() => new Set(S.jobFamilies || DEFAULT_FAMILIES));
  const [minPay, setMinPay] = useState(0);
  const [hideStale, setHideStale] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [found, setFound] = useState(null);   // discovered boards awaiting your yes
  const [whyId, setWhy] = useState(null);     // which row's city detail is expanded

  const load = async () => {
    try {
      const r = await fetch("/api/jobs");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "could not load");
      setData(await r.json());
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  /* Stamp the visit AFTER the first render, so this session still sees its own
     "New" badges and only the next visit resets them. */
  useEffect(() => { if (data) { const t = setTimeout(markSeen, 2500); return () => clearTimeout(t); } }, [data]);

  /* default the ladder filter to where you are and the rung above — the rest
     stay one click away rather than being thrown out */
  useEffect(() => {
    if (!myLevel || levels.size) return;
    const i = LEVEL_ORDER.indexOf(myLevel);
    setLevels(new Set([myLevel, LEVEL_ORDER[i + 1]].filter(Boolean)));
  }, [myLevel]);

  const resumeTokens = useMemo(() => tokensOf(S.resume), [S.resume]);
  const hasClearance = !!S.hasClearance;
  const dismissed = useMemo(() => new Set(S.dismissed || []), [S.dismissed]);
  /* Frozen on mount: if this tracked live, every row would stop being new the
     instant you looked at the page and the badge would be useless. */
  const [lastSeen] = useState(() => S.jobsSeenAt || "");
  const markSeen = () => setCareer((c) => ({ ...c, settings: { ...c.settings, jobsSeenAt: new Date().toISOString().slice(0, 10) } }));
  const dismiss = (id) => setCareer((c) => ({ ...c, settings: { ...c.settings,
    /* bounded: this is a permanent list in a file that autosaves on every keystroke */
    dismissed: [...new Set([...(c.settings.dismissed || []), id])].slice(-400) } }));
  const tracked = useMemo(() => new Set(apps.map((a) => (a.company + "|" + a.role).toLowerCase())), [apps]);

  const hasResume = !!String(S.resume || "").trim();
  const scored = useMemo(() => {
    if (!data?.jobs) return [];
    const ctx = { S, myLevel, resumeTokens, hasClearance, hasResume };
    return data.jobs.map((j) => scoreJob(j, ctx));
  }, [data, S, myLevel, resumeTokens, hasClearance, hasResume]);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    /* Most postings never state a level. Filtering to "entry" and hiding all of
       them tells a new grad the market has 4 jobs in it, which is false — those
       unlabelled roles are exactly the ones to read. They're included by default
       and tagged, rather than silently folded into mid. */
    /* Only rows with NO signal at all are the wildcards now — one estimated from
       its own salary or scope has earned its rung and filters like any other. */
    const wantsUnlabelled = showUnlabelled && levels.size && !levels.has("mid");
    const unknown = (j) => j.levelSure === false && !j.levelBasis;
    let out = scored.filter((j) =>
      !dismissed.has(j.id) &&
      (!levels.size || levels.has(j.level) || (wantsUnlabelled && unknown(j))) &&
      (!fams.size || fams.has(j.family)) &&
      (!minPay || (j.adj || 0) >= minPay) &&
      (!hideStale || !(j.ageDays > 60)) &&
      (!onlyNew || (j.firstSeen || "") > lastSeen) &&
      (!remoteOnly || j.remote) &&
      (!usOnly || j.us) &&
      (!iamOnly || j.iam) &&
      (!hideCleared || !j.clearance) &&
      (!fitCities || j.remote || !!j.city) &&
      (!ql || (j.company + " " + j.title + " " + (j.location || "")).toLowerCase().includes(ql)));
    const cmp = {
      fit: (a, b) => b.fit - a.fit || b.odds - a.odds,
      odds: (a, b) => b.odds - a.odds || b.fit - a.fit,
      comp: (a, b) => (b.adj || 0) - (a.adj || 0),
      new: (a, b) => (b.posted || b.firstSeen || "").localeCompare(a.posted || a.firstSeen || ""),
    };
    return out.sort(cmp[sort]);
  }, [scored, levels, showUnlabelled, fams, minPay, hideStale, onlyNew, lastSeen, dismissed,
      remoteOnly, usOnly, iamOnly, hideCleared, fitCities, q, sort]);

  const unlabelled = useMemo(() => scored.filter((j) => j.levelSure === false && !j.levelBasis && (!usOnly || j.us)).length, [scored, usOnly]);

  const toggleLevel = (k) => setLevels((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await fetch("/api/jobs/refresh", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "refresh failed");
      toast("Boards checked — " + j.total + " postings, " + j.added + " new, " + j.closed + " gone.");
      await load();
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  const addBoard = async () => {
    if (!boardCo.trim()) return toast("Give the employer a name first.", "err");
    setBusy("board");
    try {
      const r = await fetch("/api/jobs/parse-board", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: boardUrl }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "could not read that link");
      setCareer((c) => ({ ...c, settings: { ...c.settings,
        boards: [...(c.settings.boards || []).filter((b) => b.company.toLowerCase() !== boardCo.trim().toLowerCase()),
                 { ...j.board, company: boardCo.trim().slice(0, 40), cat: "enterprise" }].slice(0, 40) } }));
      setBoardUrl(""); setBoardCo(""); setAddOpen(false);
      toast(boardCo.trim() + " added — it'll be included from the next refresh.");
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  /* Tracking a posting carries everything already known across, so the row
     lands in the tracker complete instead of as a bare company name. */
  const track = (j) => {
    setCareer((c) => ({ ...c, apps: [...c.apps, {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      company: j.company, role: j.title.slice(0, 90), status: "Target", dateApplied: "",
      comp: j.comp || null, compEst: !!j.estimated, extrasPct: 0,
      locationType: j.remote ? "Remote" : "Onsite",
      /* a remote row must not land with city "Remote" — that then fails every
         city lookup and quietly reads as "outside your cities" in the tracker */
      city: j.remote ? "" : (j.city?.name || (j.location || "").split(",")[0].slice(0, 40)),
      clearance: j.clearance ? "Required" : "Not required",
      tier: "3", tierManual: false, cat: j.cat,
      growth: CAT_GROWTH[j.cat]?.[0] ?? null, growthNote: CAT_GROWTH[j.cat]?.[1] ?? "",
      family: j.iam ? "IAM" : "Cyber — general", source: "Job board", referralName: "", nextDate: "",
      window: j.posted ? "Posted " + ago(j.posted) : "", sponsor: "Unknown",
      link: j.url, notes: "Found by Atlas on " + new Date().toISOString().slice(0, 10), created: Date.now(),
    }] }));
    toast("Tracking " + j.company + " — it's in your list with comp, city and level filled in.");
  };

  /* A chip that says "Internship 2" and then shows nothing when you press it is
     worse than no count: both of those internships were SOC roles, filtered out
     by the area chips above. Each chip counts what you'd get if you clicked it —
     every OTHER filter applied, its own dimension left open. */
  const base = useMemo(() => scored.filter((j) =>
    !dismissed.has(j.id) && (!usOnly || j.us) && (!remoteOnly || j.remote) && (!iamOnly || j.iam) &&
    (!hideCleared || !j.clearance) && (!hideStale || !(j.ageDays > 60)) &&
    (!fitCities || j.remote || !!j.city) && (!minPay || (j.adj || 0) >= minPay)),
    [scored, dismissed, usOnly, remoteOnly, iamOnly, hideCleared, hideStale, fitCities, minPay]);

  const counts = useMemo(() => {
    const m = {};
    for (const j of base) if (!fams.size || fams.has(j.family)) m[j.level] = (m[j.level] || 0) + 1;
    return m;
  }, [base, fams]);
  const famCounts = useMemo(() => {
    const m = {};
    const wantsUnlabelled = showUnlabelled && levels.size && !levels.has("mid");
    for (const j of base) {
      if (levels.size && !levels.has(j.level) && !(wantsUnlabelled && j.levelSure === false && !j.levelBasis)) continue;
      m[j.family] = (m[j.family] || 0) + 1;
    }
    return m;
  }, [base, levels, showUnlabelled]);
  const newCount = useMemo(() =>
    lastSeen ? scored.filter((j) => (j.firstSeen || "") > lastSeen && (!usOnly || j.us) && !dismissed.has(j.id)).length : 0,
    [scored, lastSeen, usOnly, dismissed]);

  /* Coverage is the ceiling on the whole feature — 40 boards against 100+
     tracked companies. Every candidate is fetched and proven server-side before
     it's offered, so nothing enters the registry on a model's say-so. */
  const discover = async () => {
    const missing = [...new Set(apps.map((a) => a.company))]
      .filter((c) => !(data?.seeded || []).includes(c) && !(S.boards || []).some((b) => b.company === c))
      .slice(0, 12);
    if (!missing.length) return toast("Every company you track already has a board.", "err");
    setBusy("discover");
    try {
      const r = await fetch("/api/jobs/discover", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companies: missing }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "discovery failed");
      if (!j.found?.length) { toast("No public boards found for those " + missing.length + " — they're likely on iCIMS or Taleo, which have no open API.", "err"); setBusy(""); return; }
      setFound(j);
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  if (err) return <div className="card"><h3>Job finder</h3><div className="note bad">Couldn't load postings — {err}</div></div>;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Find jobs</h3>
        <span className="row" style={{ gap: 6 }}>
          {apps.length > 0 && <button className="btn small" disabled={!!busy} onClick={discover}
            title="Look up public job boards for the companies you track">{busy === "discover" ? "Looking…" : "Find boards"}</button>}
          <button className="btn small" disabled={!!busy} onClick={() => setAddOpen((v) => !v)}>+ Employer</button>
          <button className="btn small primary" disabled={!!busy} onClick={refresh}>{busy === "refresh" ? "Checking…" : "Check now"}</button>
        </span>
      </div>

      {found && (
        <div className="card" style={{ marginTop: 8, borderColor: "var(--acc)" }}>
          <div className="note" style={{ marginTop: 0 }}>
            Found {found.found.length} board{found.found.length === 1 ? "" : "s"} — each one was fetched and confirmed to return
            postings before being offered, so nothing here is a guess.
            {found.stillMissing?.length ? " No public board for: " + found.stillMissing.join(", ") + " (likely iCIMS or Taleo, which have no open API)." : ""}
          </div>
          {found.found.map((b) => (
            <div className="kv" key={b.company + b.kind}>
              <span className="k">{b.company} <span className="note" style={{ margin: 0, fontSize: 11.5 }}>· {b.kind} · {b.postings} postings</span></span>
            </div>
          ))}
          <div className="mrow">
            <button className="btn" onClick={() => setFound(null)}>Not now</button>
            <button className="btn primary" onClick={() => {
              setCareer((c) => {
                const have = new Set((c.settings.boards || []).map((x) => x.company.toLowerCase()));
                const add = found.found.filter((b) => !have.has(b.company.toLowerCase()))
                  .map(({ postings, ...b }) => ({ ...b, cat: "enterprise" }));
                return { ...c, settings: { ...c.settings, boards: [...(c.settings.boards || []), ...add].slice(0, 40) } };
              });
              setFound(null);
              toast("Added — hit Check now to pull their postings in.");
            }}>Add all {found.found.length}</button>
          </div>
        </div>
      )}
      <div className="note" style={{ marginTop: 0 }}>
        {data ? <>
          <b>{data.jobs.length}</b> security and identity postings pulled straight from {Object.keys(data.sources || {}).length} employers'
          own job boards{data.lastRun ? " · last checked " + new Date(data.lastRun).toLocaleString() : ""}
          {data.added ? " · " + data.added + " new" : ""}{data.closed ? " · " + data.closed + " closed" : ""}.
          Every link goes to the employer, never a job aggregator.
        </> : "Loading postings…"}
      </div>

      {!hasResume && (
        <div className="note bad" style={{ marginTop: 8 }}>
          <b>No resume uploaded, so half of this is guessing.</b> Without one there's nothing to match a posting against —
          the odds column is switched off rather than showing a number built on nothing, and your level is being taken from
          keywords instead of read properly. Upload one in the Resume card below and every score here changes.
        </div>
      )}

      {addOpen && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="note" style={{ marginTop: 0 }}>
            Open a company's job listings page and paste the address. Greenhouse, Lever, Ashby and Workday all work —
            that covers most employers. Workday tenants can't be guessed, which is why this asks for the link instead.
          </div>
          <div className="row">
            <input className="in" style={{ width: 170 }} placeholder="Employer name" value={boardCo} onChange={(e) => setBoardCo(e.target.value)} />
            <input className="in" style={{ flex: 1, minWidth: 200 }} placeholder="https://…myworkdayjobs.com/en-US/Careers"
              value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addBoard()} />
            <button className="btn small primary" disabled={busy === "board" || !boardUrl.trim()} onClick={addBoard}>Add</button>
          </div>
          {!!(S.boards || []).length && (
            <div className="note">
              Yours: {(S.boards || []).map((b) => b.company).join(", ")} —{" "}
              <a href="#" style={{ color: "var(--acc)" }} onClick={(e) => { e.preventDefault();
                setCareer((c) => ({ ...c, settings: { ...c.settings, boards: [] } })); toast("Your added employers were cleared."); }}>clear</a>
            </div>
          )}
        </div>
      )}

      {/* the ladder — the whole point is that it grows with you, so nothing is dropped */}
      <div className="row" style={{ marginTop: 10, gap: 5, flexWrap: "wrap" }}>
        {LEVELS.map(([k, label]) => {
          const n = counts[k] || 0;
          return (
            <button key={k} className={"btn small" + (levels.has(k) ? " primary" : "")} onClick={() => toggleLevel(k)}
              disabled={!n && !levels.has(k)} style={!n && !levels.has(k) ? { opacity: 0.35 } : undefined}
              title={myLevel === k ? "Where your resume reads today" : !n ? "Nothing at this level matches your other filters" : undefined}>
              {label} {n}{myLevel === k ? " ●" : ""}
            </button>
          );
        })}
        {!!levels.size && <button className="btn small" onClick={() => setLevels(new Set())}>All levels</button>}
        {!!levels.size && !levels.has("mid") && (
          <button className={"btn small" + (showUnlabelled ? " primary" : "")} onClick={() => setShowUnlabelled((v) => !v)}
            title="Most postings never state a band. Hiding them makes the market look far smaller than it is.">
            + {unlabelled} unlabelled
          </button>
        )}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <input className="in" style={{ flex: 1, minWidth: 150 }} placeholder="Search company, title, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" style={{ width: 165 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="fit">Sort: best for me</option>
          <option value="odds">Sort: most gettable</option>
          <option value="comp">Sort: adjusted pay</option>
          <option value="new">Sort: newest</option>
        </select>
      </div>
      {/* "Security" covers a dozen jobs that share almost nothing day to day.
          This is the filter that turns 500 rows into something readable. */}
      <div className="row" style={{ marginTop: 6, gap: 5, flexWrap: "wrap" }}>
        {FAMILY_LABELS.map(([k, label]) => {
          const n = famCounts[k] || 0;
          if (!n && !fams.has(k)) return null;
          return (
            <button key={k} className={"btn small" + (fams.has(k) ? " primary" : "")}
              onClick={() => setFams((p) => {
                const s = new Set(p); s.has(k) ? s.delete(k) : s.add(k);
                /* remembered, so the next visit opens the way you left it */
                setCareer((c) => ({ ...c, settings: { ...c.settings, jobFamilies: [...s] } }));
                return s;
              })}>
              {label} {n}
            </button>
          );
        })}
        {!!fams.size && <button className="btn small" onClick={() => {
          setFams(new Set());
          setCareer((c) => ({ ...c, settings: { ...c.settings, jobFamilies: [] } }));
        }}>All areas</button>}
      </div>

      <div className="row" style={{ marginTop: 6, gap: 5, flexWrap: "wrap" }}>
        <button className={"btn small" + (remoteOnly ? " primary" : "")} onClick={() => setRemoteOnly((v) => !v)}>Remote only</button>
        <button className={"btn small" + (usOnly ? " primary" : "")} onClick={() => setUsOnly((v) => !v)}>US only</button>
        <button className={"btn small" + (iamOnly ? " primary" : "")} onClick={() => setIamOnly((v) => !v)}>IAM / identity only</button>
        <button className={"btn small" + (fitCities ? " primary" : "")} onClick={() => setFitCities((v) => !v)}>My cities or remote</button>
        <button className={"btn small" + (hideCleared ? " primary" : "")} onClick={() => setHideCleared((v) => !v)}>Hide clearance-required</button>
        <button className={"btn small" + (hideStale ? " primary" : "")} onClick={() => setHideStale((v) => !v)}
          title="Reqs open 60+ days are often filled, frozen, or evergreen pipeline postings">Hide stale</button>
        {newCount > 0 && (
          <button className={"btn small" + (onlyNew ? " primary" : "")} onClick={() => setOnlyNew((v) => !v)}>New since last visit {newCount}</button>
        )}
        <select className="in" style={{ width: 130 }} value={minPay} onChange={(e) => setMinPay(Number(e.target.value))}>
          <option value={0}>Any pay</option>
          <option value={70000}>$70k+ adjusted</option>
          <option value={90000}>$90k+ adjusted</option>
          <option value={110000}>$110k+ adjusted</option>
          <option value={140000}>$140k+ adjusted</option>
        </select>
        <span className="note" style={{ margin: 0 }}>
          {rows.length} match{dismissed.size ? " · " + dismissed.size + " hidden" : ""}
        </span>
        {!!dismissed.size && (
          <a href="#" className="note" style={{ margin: 0, color: "var(--acc)" }}
            onClick={(e) => { e.preventDefault(); setCareer((c) => ({ ...c, settings: { ...c.settings, dismissed: [] } })); }}>bring back</a>
        )}
      </div>

      {!rows.length && data && (
        <div className="note" style={{ marginTop: 10 }}>
          Nothing matches those filters. Widen the ladder above — the boards skew senior, and most new-grad
          security roles post between August and October for the following year.
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        {rows.slice(0, limit).map((j) => {
          const already = tracked.has((j.company + "|" + j.title.slice(0, 90)).toLowerCase());
          return (
            <div key={j.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {/* the employer is what you actually scan for, so it leads */}
                  <span className="row" style={{ gap: 7, flexWrap: "wrap", alignItems: "baseline" }}>
                    <b style={{ fontSize: 15 }}>{j.company}</b>
                    {/* every row gets a location chip — a blank where the others
                        have a tier reads as a bug, not as "no data" */}
                    {j.remote ? (
                      <span className="tag" style={{ color: "var(--up)", borderColor: "var(--up)" }}
                        title="Remote is the best location outcome here: the city question disappears and she picks where you live">
                        Remote · S-tier
                      </span>
                    ) : j.city ? (
                      <button className="tag" title="Click for what's there for a partner"
                        style={{ cursor: "pointer", color: partnerColor(j.city.partner), borderColor: partnerColor(j.city.partner), background: "none" }}
                        onClick={() => setWhy(whyId === j.id ? null : j.id)}>
                        {j.city.name} · {j.city.tier}-tier ▾
                      </button>
                    ) : (
                      <span className="tag" style={{ color: "var(--faint)" }}
                        title="Not on your city list — add it in Assumptions if you'd move there">Unranked city</span>
                    )}
                    {lastSeen && (j.firstSeen || "") > lastSeen && <span className="tag" style={{ color: "var(--gold)", borderColor: "var(--gold)" }}>New</span>}
                    {j.iam && <span className="tag" style={{ color: "var(--acc)", borderColor: "var(--acc)" }}>IAM</span>}
                    {j.remote && <span className="tag" style={{ color: "var(--up)", borderColor: "var(--up)" }}>Remote</span>}
                    {j.clearance && <span className="tag" style={{ color: "var(--gold)", borderColor: "var(--gold)" }}>Clearance</span>}
                    <span className="tag" style={j.levelBasis && j.levelBasis !== "stated" ? { borderStyle: "dashed" } : undefined}
                      title={j.levelBasis === "pay" ? "The posting doesn't say — estimated from the salary it lists"
                        : j.levelBasis === "scope" ? "The posting doesn't say — estimated from what it asks you to do"
                        : j.levelSure === false ? "The posting states no level at all — worth reading whatever rung you're on" : undefined}>
                      {(LEVELS.find(([k]) => k === j.level) || [, j.level])[1]}
                      {j.levelBasis === "pay" ? " · est from pay" : j.levelBasis === "scope" ? " · est from scope" : j.levelSure === false ? " · not stated" : ""}
                    </span>
                    {j.ageDays > 60 && (
                      <span className="tag" style={{ color: "var(--faint)" }} title="Reqs open this long are often filled, frozen, or evergreen pipeline postings">
                        {j.ageDays > 120 ? "open 4+ months" : "open 2+ months"}
                      </span>
                    )}
                  </span>
                  <span style={{ display: "block", fontSize: 13.5, marginTop: 1 }}>{j.title}</span>
                  <span className="note" style={{ display: "block", margin: 0, fontSize: 12 }}>
                    {j.location || "location not stated"}{j.posted ? " · posted " + ago(j.posted) : ""}
                  </span>
                  {whyId === j.id && j.city && (
                    <span className="note" style={{ display: "block", margin: "3px 0 0", fontSize: 11.5, color: partnerColor(j.city.partner) }}>
                      {j.city.name} is {j.city.tier}-tier for you · cost of living {j.city.col} ·{" "}
                      {partnerLabel(j.city.partner)} for a partner{j.city.orgs ? " — " + j.city.orgs : ""}
                    </span>
                  )}
                  {!!j.shared.length && (
                    <span className="note" style={{ display: "block", margin: 0, fontSize: 11.5 }}>
                      Matches your resume on: {j.shared.slice(0, 7).join(", ")}
                    </span>
                  )}
                </span>
                <span style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{money(j.adj)}</div>
                  <div className="note" style={{ margin: 0, fontSize: 11 }}>
                    {j.adj ? "adjusted" : "no pay data"}{j.estimated && j.adj ? " · est" : ""}
                  </div>
                  {j.odds != null ? (
                    <div className="note" style={{ margin: 0, fontSize: 11.5, color: oddsColor(j.odds) }}>
                      {oddsWord(j.odds)} · {j.odds}/100
                    </div>
                  ) : (
                    <div className="note" style={{ margin: 0, fontSize: 11 }}>odds need a resume</div>
                  )}
                </span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <a className="btn small primary" href={j.url} target="_blank" rel="noreferrer noopener">Open posting</a>
                <button className="btn small" disabled={already} onClick={() => track(j)}>{already ? "Tracked ✓" : "Track this"}</button>
                <button className="x" title="Not interested — hide this one" onClick={() => dismiss(j.id)}>✕</button>
                <span className="note" style={{ margin: 0, fontSize: 11 }}>
                  fit {j.fit}/100{j.gap > 0 ? " · " + j.gap + " rung" + (j.gap > 1 ? "s" : "") + " above you" : j.gap < 0 ? " · below your level" : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {rows.length > limit && (
        <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
          <button className="btn small" onClick={() => setLimit((n) => n + 50)}>Show more — {rows.length - limit} hidden</button>
        </div>
      )}
    </div>
  );
}
