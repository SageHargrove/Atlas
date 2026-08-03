import React, { useState, useMemo, useEffect } from "react";
import { DEFAULT_CITIES, partnerLabel, partnerColor, CAT_GROWTH, cityMatch, money, yearsFromResume, offerValue } from "./careerData.js";
import { SEED_LINKS } from "./Career.jsx";
import { scoreOdds, oddsParts, explainRow, scoreFit, scoreGrowth, tokensOf, LEVEL_ORDER as ODDS_ORDER } from "./odds.js";
export { yearsFromResume };

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

/* WHO is hiring, as opposed to what the role is. "Show me the IAM
   consultancies" was not expressible before — you could filter to IAM work and
   still get it from a bank, a utility and a trading firm mixed together. These
   are the same categories the pay bands and selectivity already use, so the
   filter costs nothing new to maintain. */
export const CAT_LABELS = [
  ["consulting", "Consultancies"], ["enterprise", "Vendors / enterprise"], ["utility", "Utilities"],
  ["financial", "Financial"], ["cleared", "Cleared / defense"], ["bigtech", "Big tech"], ["quant", "Quant"],
];

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

function scoreJob(j, ctx) {
  const { S, myLevel, resumeTokens, hasClearance, hasResume, myYears } = ctx;
  const city = cityMatch(j.location, S.cities);
  /* The server now fills most gaps from what comparable postings actually pay;
     the static table is only the floor for a band with too few real samples. */
  const comp = j.comp || estComp(j.cat, j.level);
  const col = j.remote ? (S.remoteCol || 90) : (city?.col || 100);
  const adj = comp ? Math.round(comp / (col / 100)) : null;

  /* --- Fit and Growth, both measured against him rather than constants. Live
     in odds.js so the saturation that made every card read 97 can be tested
     for rather than eyeballed. --- */
  const scored_ = { ...j, adj, city };
  const fitMe = { myLevel, floorAdj: ctx.floorAdj, tierT1: S.tierT1 || 98000 };
  const fit = scoreFit(scored_, fitMe);
  const moveUp = scoreGrowth(scored_, fitMe);

  /* --- Odds: could you actually land it. Lives in odds.js so it can be tested
     without a browser — it is the number most likely to be quietly wrong. --- */
  const me = { myLevel, myYears, resume: S.resume, hasResume, hasClearance };
  const odds = scoreOdds(j, me);
  const { shared, shortfall, build } = oddsParts(j, me);
  const gap = ODDS_ORDER.indexOf(j.level) - ODDS_ORDER.indexOf(myLevel || "entry");

  const row = { ...j, city, comp, adj, estimated: !j.comp || !!j.compEst, fit, odds, moveUp, gap, shortfall, build, shared };
  row.why = explainRow(row, { myYears, floorAdj: ctx.floorAdj, growth: CAT_GROWTH[j.cat]?.[0] ?? 3, myLevel });
  return row;
}

/* Three numbers side by side beat one number and a paragraph: you can scan a
   list and see the shape of each row without reading any of it. They answer
   different questions on purpose — can I get it, do I want it, does it go
   anywhere — and a row that is strong on two and weak on one is the
   interesting case, which an average would erase. */
function Meter({ label, value, color, title }) {
  return (
    <div style={{ flex: 1, minWidth: 84 }} title={title}>
      <div className="row" style={{ justifyContent: "space-between", gap: 4 }}>
        <span className="note" style={{ margin: 0, fontSize: 9.5, letterSpacing: ".06em" }}>{label}</span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color }}>{value == null ? "—" : value}</span>
      </div>
      {/* a 7/100 bar at 2% is invisible, so a long shot read as "no data" rather
          than as bad news. Minimum 6% and a red that actually looks red. */}
      <div className="bar" style={{ height: 4, marginTop: 2 }}>
        <i style={{ width: (value == null ? 0 : Math.max(6, value)) + "%", background: color }} />
      </div>
    </div>
  );
}
const meterColor = (n) => (n == null ? "var(--faint)" : n >= 70 ? "var(--up)" : n >= 50 ? "var(--acc)" : n >= 32 ? "var(--gold)" : "var(--down)");
const STATUS_CLR = { Target: "var(--faint)", Applied: "var(--gold)", Interviewing: "var(--acc)", Offer: "var(--up)" };

/* If the poll has ever seen a posting from this employer, we know their board
   and can link straight at it instead of guessing via a search engine. */
function careersFor(company, data) {
  /* Quant shops and the big enterprises don't use a readable ATS, so they never
     appear in the polled feed and every one of them fell through to a search.
     Their real careers pages are already on file — check there first. */
  const known = SEED_LINKS[String(company || "").toLowerCase()];
  if (known) return known;
  const hit = (data?.jobs || []).find((j) => j.company === company && j.url);
  if (!hit) return null;
  const m = /^(https:\/\/(?:job-boards|boards)\.greenhouse\.io\/[^/]+|https:\/\/jobs\.lever\.co\/[^/]+|https:\/\/jobs\.ashbyhq\.com\/[^/]+|https:\/\/[^/]+\.myworkdayjobs\.com\/[^/]+\/[^/]+)/.exec(hit.url);
  return m ? m[1] : hit.url;
}

const oddsWord = (n) => (n >= 70 ? "Strong" : n >= 52 ? "Realistic" : n >= 34 ? "Stretch" : "Long shot");
const oddsColor = (n) => (n >= 70 ? "var(--up)" : n >= 52 ? "var(--acc)" : n >= 34 ? "var(--gold)" : "var(--down)");
const ago = (d) => {
  if (!d) return "";
  const days = Math.round((Date.now() - new Date(d + "T00:00:00Z").getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : days < 30 ? days + " days ago" : Math.round(days / 30) + " mo ago";
};

/* A tracked application, shaped like a posting so one list can hold both.

   They were two cards showing the same thing twice: the tracker had 102 rows of
   companies you're aiming at, the finder had 500 live postings, and moving
   between them meant scrolling past one to reach the other. They are one list
   with a source filter now — "everything I'm looking at", however it got there. */
function appAsRow(a, S) {
  const city = cityMatch(a.city, S.cities);
  const comp = a.comp == null || a.comp === "" ? null : Math.round(Number(a.comp) * (1 + (Number(a.extrasPct) || 0) / 100));
  const remote = a.locationType === "Remote";
  return {
    id: "app:" + a.id,
    tracked: true, appId: a.id, status: a.status,
    company: a.company, title: a.role || "target", location: remote ? "Remote" : (a.city || ""),
    comp, compEst: !!a.compEst, remote, us: true,
    city, cat: a.cat || "enterprise", family: a.family === "IAM" ? "iam" : "analyst",
    iam: (a.family || "").toUpperCase().includes("IAM"),
    clearance: a.clearance === "Required",
    level: "entry", levelSure: false, levelBasis: null, yearsReq: null,
    desc: a.notes || "", url: a.link || "", window: a.window || "",
    posted: "", firstSeen: "", ageDays: null,
  };
}

export default function JobFinder({ S, apps, setCareer, toast, myLevel, onTailor, onCoverLetter, onImpact, onEdit, header, focusCompany, onFocused, focusSource, onSourceFocused, onlyCompanies, onOnlyApplied, onStats }) {
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
  const [limit, setLimit] = useState(9);
  const [boardUrl, setBoardUrl] = useState("");
  const [boardCo, setBoardCo] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [fams, setFams] = useState(() => new Set(S.jobFamilies || DEFAULT_FAMILIES));
  const [cats, setCats] = useState(() => new Set(S.jobCats || []));
  const [minPay, setMinPay] = useState(0);
  const [hideStale, setHideStale] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [found, setFound] = useState(null);   // discovered boards awaiting your yes
  const [whyId, setWhy] = useState(null);     // which row's city detail is expanded
  const [menuId, setMenuId] = useState(null); // which card's overflow menu is open
  const [contracts, setContracts] = useState({}); // company -> USAspending result
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [source, setSource] = useState("all");
  /* The offer you're near-certain of, adjusted the same way every row is, so the
     comparison is like for like: a $70k utility job in Little Rock is not
     beaten by an $80k one in Boston. */
  const floor = S.floorOffer || null;
  const floorVal = useMemo(() => {
    if (!floor?.base) return null;
    const col = cityMatch(floor.city, S.cities)?.col || (floor.remote ? (S.remoteCol || 90) : 100);
    return offerValue({ ...floor, col });
  }, [floor, S.cities, S.remoteCol]);
  const floorAdj = floorVal?.adjusted || 0;

  const load = async () => {
    try {
      const r = await fetch("/api/jobs");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "could not load");
      setData(await r.json());
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  /* Asked to show a company from elsewhere on the page: search for it, clear
     whatever filters would hide it, and scroll it into view. Filtering to a
     company and getting nothing because a level chip excluded it is the kind of
     dead end that makes people stop trusting a link. */
  /* An explicit set of companies the caller wants shown. */
  const [pinned, setPinned] = useState(null);
  const [pinLabel, setPinLabel] = useState("");
  const boxRef = React.useRef(null);

  /* ---- persistent preferences vs transient narrowing -------------------
     The finder's counts kept lying because a number computed in one pipeline
     was clicked into a view rendered through another: "20 live roles" counted
     the raw cache, then the view applied family filters and showed 9. One
     rule now: persistent preferences (families, US-only, never-show words)
     travel with EVERY count; everything else is transient and any jump
     clears it. A button's number is the number of cards you land on. */
  const excludeWords = S.excludeWords || [];
  const exclRes = useMemo(() => excludeWords.map((w) => {
    const esc = String(w).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!esc) return null;
    try { return new RegExp("\\b" + esc.replace(/\s+/g, "\\s+") + "\\b", "i"); } catch { return null; }
  }).filter(Boolean), [excludeWords.join("¦")]);
  const prefPass = (j) => (!usOnly || j.us)
    && (!fams.size || fams.has(j.family))
    && !exclRes.some((re) => re.test(j.title || ""));
  const clearTransient = () => {
    setQ(""); setLevels(new Set()); setCats(new Set()); setMinPay(0); setLimit(9);
    setOnlyNew(false); setRemoteOnly(false); setIamOnly(false); setHideStale(false); setFitCities(false);
  };
  /* live board rows for one employer, through the same prefs every view uses */
  const liveFor = (company) => scored.filter((x) => !x.tracked && x.company === company
    && !dismissed.has(x.id) && prefPass(x));
  const jumpToCompany = (company) => {
    clearTransient(); setSource("board");
    setPinned(new Set([String(company).toLowerCase()]));
    setPinLabel(company);
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    if (!focusCompany) return;
    setQ(focusCompany);
    setSource("all"); setLevels(new Set()); setFams(new Set()); setCats(new Set());
    setMinPay(0); setOnlyNew(false); setRemoteOnly(false); setIamOnly(false); setHideStale(false); setFitCities(false);
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    onFocused?.();
  }, [focusCompany]);
  /* "Open right now" from the timeline means VERIFIED: live postings, from
     target employers whose boards demonstrably have matching roles today.
     Unreadable boards are unknown — they don't get to pad an "open" count.
     Transient narrowing clears; your families and never-show words do not,
     so the number on the tile is the number of cards you land on. */
  useEffect(() => {
    if (onlyCompanies !== "__liveopen__") return;
    clearTransient();
    setSource("board");
    const cos = [...new Set(scored.filter((j) => j.tracked && j.status === "Target").map((j) => j.company))]
      .filter((c) => liveFor(c).length > 0);
    setPinned(new Set(cos.map((c) => c.toLowerCase())));
    setPinLabel("Open now — verified live at " + cos.length + " of your targets"
      + (targetStats.unverifiable ? " (" + targetStats.unverifiable + " more have no readable board)" : ""));
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    onOnlyApplied?.();
  }, [onlyCompanies]);

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
  /* editable, because a resume's dates can't see freelance work or a gap */
  const myYears = S.myYears != null ? Number(S.myYears) : yearsFromResume(S.resume);
  const scored = useMemo(() => {
    const ctx = { S, myLevel, resumeTokens, hasClearance, hasResume, myYears, floorAdj };
    const board = (data?.jobs || []).map((j) => scoreJob(j, ctx));
    /* your own tracked targets, scored the same way, so a company you added by
       hand sits next to a live posting rather than in a separate table */
    const mine = apps
      .filter((a) => a.status !== "Rejected" && a.status !== "Withdrawn")
      .map((a) => scoreJob(appAsRow(a, S), ctx));
    return [...board, ...mine];
  }, [data, apps, S, myLevel, resumeTokens, hasClearance, hasResume, myYears, floorAdj]);

  /* What the timeline's "open right now" should actually mean: targets whose
     boards VERIFIABLY have matching roles today. Unreadable boards are unknown,
     not open — they get their own count instead of padding this one. */
  const targetStats = useMemo(() => {
    const cos = [...new Set(scored.filter((j) => j.tracked && j.status === "Target").map((j) => j.company))];
    let liveRoles = 0, liveCos = 0, watchedNone = 0, unverifiable = 0;
    for (const c of cos) {
      const n = liveFor(c).length;
      const src = data?.sources?.[c];
      if (n > 0) { liveCos++; liveRoles += n; }
      else if (src && src.ok) watchedNone++;
      else unverifiable++;
    }
    return { liveRoles, liveCos, watchedNone, unverifiable };
  }, [scored, data, fams, usOnly, exclRes, dismissed]);
  useEffect(() => { onStats?.(targetStats); }, [targetStats]);

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
      prefPass(j) &&
      /* an explicit list from the timeline wins over every other filter */
      (!pinned || pinned.has(String(j.company || "").toLowerCase())) &&
      (source === "all" || (source === "board" ? !j.tracked
        : source === "tracked" ? j.tracked
        : source === "applied" ? j.status && j.status !== "Target"
        : true)) &&
      (!levels.size || levels.has(j.level) || (wantsUnlabelled && unknown(j))) &&
      (!fams.size || fams.has(j.family)) &&
      (!cats.size || cats.has(j.cat)) &&
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
  }, [pinned, scored, source, levels, showUnlabelled, fams, cats, minPay, hideStale, onlyNew, lastSeen, dismissed,
      remoteOnly, usOnly, iamOnly, hideCleared, fitCities, q, sort]);

  const unlabelled = useMemo(() => scored.filter((j) => j.levelSure === false && !j.levelBasis && (!usOnly || j.us)).length, [scored, usOnly]);

  const toggleLevel = (k) => setLevels((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  /* one helper for the two remembered chip groups, so adding a third later
     doesn't mean a third copy of the same set-toggle-and-persist dance */
  const toggleSet = (setter, current, k, settingKey) => setter(() => {
    const s = new Set(current); s.has(k) ? s.delete(k) : s.add(k);
    setCareer((c) => ({ ...c, settings: { ...c.settings, [settingKey]: [...s] } }));
    return s;
  });

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
  /* Returns the application it created, so the overflow menu can track a posting
     and immediately act on it — tailoring a resume "for this job" needs the job
     to exist as a tracked row first, and making the user do that in two steps
     is a step they'd skip. `quiet` suppresses the toast when something else is
     about to open on top of it. */
  const track = (j, quiet) => {
    const app = {
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
    };
    /* already tracked? reuse it rather than creating a duplicate every time the
       menu is used on the same posting */
    const existing = apps.find((a) => (a.company + "|" + a.role).toLowerCase() === (app.company + "|" + app.role).toLowerCase());
    if (existing) return existing;
    setCareer((c) => ({ ...c, apps: [...c.apps, app] }));
    if (!quiet) toast("Tracking " + j.company + " — it's in your list with comp, city and level filled in.");
    return app;
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
  const inLevel = useMemo(() => {
    const wantsUnlabelled = showUnlabelled && levels.size && !levels.has("mid");
    return base.filter((j) => !levels.size || levels.has(j.level) || (wantsUnlabelled && j.levelSure === false && !j.levelBasis));
  }, [base, levels, showUnlabelled]);
  const famCounts = useMemo(() => {
    const m = {};
    for (const j of inLevel) if (!cats.size || cats.has(j.cat)) m[j.family] = (m[j.family] || 0) + 1;
    return m;
  }, [inLevel, cats]);
  const catCounts = useMemo(() => {
    const m = {};
    for (const j of inLevel) if (!fams.size || fams.has(j.family)) m[j.cat] = (m[j.cat] || 0) + 1;
    return m;
  }, [inLevel, fams]);
  const newCount = useMemo(() =>
    lastSeen ? scored.filter((j) => (j.firstSeen || "") > lastSeen && (!usOnly || j.us) && !dismissed.has(j.id)).length : 0,
    [scored, lastSeen, usOnly, dismissed]);

  /* The plain on/off filters, defined once so the drawer and the active-chip
     summary can't drift apart. */
  const TOGGLES = [
    { key: "remote", label: "Remote only", on: remoteOnly, toggle: () => setRemoteOnly((v) => !v), off: () => setRemoteOnly(false) },
    { key: "us", label: "US only", on: usOnly, toggle: () => setUsOnly((v) => !v), off: () => setUsOnly(false) },
    { key: "iam", label: "IAM / identity only", on: iamOnly, toggle: () => setIamOnly((v) => !v), off: () => setIamOnly(false) },
    { key: "cities", label: "My cities or remote", on: fitCities, toggle: () => setFitCities((v) => !v), off: () => setFitCities(false) },
    { key: "clear", label: "Hide clearance", on: hideCleared, toggle: () => setHideCleared((v) => !v), off: () => setHideCleared(false),
      title: "Best effort — Workday employers publish too little text to detect this reliably" },
    { key: "stale", label: "Hide stale", on: hideStale, toggle: () => setHideStale((v) => !v), off: () => setHideStale(false),
      title: "Reqs open 60+ days are often filled, frozen, or evergreen pipeline postings" },
    ...(newCount > 0 ? [{ key: "new", label: "New since last visit " + newCount, on: onlyNew, toggle: () => setOnlyNew((v) => !v), off: () => setOnlyNew(false) }] : []),
  ];
  const activeCount = fams.size + cats.size + levels.size + TOGGLES.filter((t) => t.on).length + (minPay ? 1 : 0);
  const clearAll = () => {
    setPinned(null); setPinLabel("");
    setFams(new Set()); setCats(new Set()); setLevels(new Set()); setMinPay(0);
    TOGGLES.forEach((t) => t.off());
    setCareer((c) => ({ ...c, settings: { ...c.settings, jobFamilies: [], jobCats: [] } }));
  };
  /* a menu left open behind a click elsewhere is a stuck menu */
  useEffect(() => {
    if (menuId == null) return;
    const close = () => setMenuId(null);
    window.addEventListener("click", close, { capture: true });
    return () => window.removeEventListener("click", close, { capture: true });
  }, [menuId]);

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
    <div className="card" ref={boxRef}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Find jobs</h3>
        <span className="row" style={{ gap: 6 }}>
          {header}
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

      {floorAdj > 0 && (
        <div className="note" style={{ marginTop: 8 }}>
          <b>Your floor: {floor.company || "current offer"} — {money(Number(floor.base))} base, worth {money(floorVal.total)} all in,
          {" "}{money(floorAdj)} adjusted.</b>{" "}
          {(() => {
            const beat = rows.filter((r) => r.adj > floorAdj).length;
            const good = rows.filter((r) => r.adj > floorAdj && r.odds >= 45).length;
            return beat === 0
              ? "Nothing showing beats it — widen the filters, or take the floor and plan to move in two years."
              : beat + " of these pay more" + (hasResume ? ", and " + good + " of those you'd have a realistic shot at" : "") + ".";
          })()}
        </div>
      )}

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

      {/* Search, sort, and a count. Everything else lives behind the drawer:
          thirty controls on screen is not a filter bar, it's a cockpit. */}
      <div className="fbar" style={{ marginTop: 10 }}>
        <input className="in" style={{ flex: 1, minWidth: 150 }} placeholder="Search company, title, city…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" style={{ width: 148 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">Everything ({scored.length})</option>
          <option value="board">Live postings ({scored.filter((j) => !j.tracked).length})</option>
          <option value="tracked">My targets ({scored.filter((j) => j.tracked).length})</option>
          <option value="applied">Applied ({scored.filter((j) => j.status && j.status !== "Target").length})</option>
        </select>
        <select className="in" style={{ width: 160 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="fit">Sort: best for me</option>
          <option value="odds">Sort: most gettable</option>
          <option value="comp">Sort: adjusted pay</option>
          <option value="new">Sort: newest</option>
        </select>
        <button className={"btn small" + (activeCount ? " primary" : "")} onClick={() => setFiltersOpen((v) => !v)}>
          Filters{activeCount ? " · " + activeCount : ""} {filtersOpen ? "▴" : "▾"}
        </button>
        <span className="note" style={{ margin: 0 }}>
          {rows.length} match{dismissed.size ? " · " + dismissed.size + " hidden" : ""}
        </span>
      </div>

      {/* A pin narrows the list harder than any other filter, so it must be
          visible and removable — an invisible filter reads as missing data. */}
      {pinned && (
        <div className="row" style={{ marginTop: 6, gap: 5, flexWrap: "wrap" }}>
          <span className="achip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
            {pinLabel || "Pinned — " + pinned.size + " employer" + (pinned.size === 1 ? "" : "s")}
            <button onClick={() => { setPinned(null); setPinLabel(""); }} title="Show everything again">×</button>
          </span>
        </div>
      )}
      {/* what's on, at a glance, without opening anything */}
      {!filtersOpen && activeCount > 0 && (
        <div className="row" style={{ marginTop: 6, gap: 5, flexWrap: "wrap" }}>
          {[...fams].map((k) => (
            <span className="achip" key={"f" + k}>{(FAMILY_LABELS.find(([x]) => x === k) || [, k])[1]}
              <button onClick={() => toggleSet(setFams, fams, k, "jobFamilies")} title="Remove">×</button></span>
          ))}
          {[...cats].map((k) => (
            <span className="achip" key={"c" + k}>{(CAT_LABELS.find(([x]) => x === k) || [, k])[1]}
              <button onClick={() => toggleSet(setCats, cats, k, "jobCats")} title="Remove">×</button></span>
          ))}
          {[...levels].map((k) => (
            <span className="achip" key={"l" + k}>{(LEVELS.find(([x]) => x === k) || [, k])[1]}
              <button onClick={() => toggleLevel(k)} title="Remove">×</button></span>
          ))}
          {TOGGLES.filter((t) => t.on).map((t) => (
            <span className="achip" key={t.key}>{t.label}<button onClick={t.off} title="Remove">×</button></span>
          ))}
          {minPay > 0 && <span className="achip">{money(minPay)}+<button onClick={() => setMinPay(0)}>×</button></span>}
          <button className="btn small" onClick={clearAll}>Clear all</button>
        </div>
      )}

      {filtersOpen && (
        <div className="fdrawer">
          <label className="f">Level {levels.size ? "· " + levels.size + " selected" : ""}</label>
          <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
            {LEVELS.map(([k, label]) => {
              const n = counts[k] || 0;
              return (
                <button key={k} className={"btn small" + (levels.has(k) ? " primary" : "")} onClick={() => toggleLevel(k)}
                  disabled={!n && !levels.has(k)} style={!n && !levels.has(k) ? { opacity: 0.35 } : undefined}
                  title={myLevel === k ? "Where your resume reads today" : undefined}>
                  {label} {n}{myLevel === k ? " ●" : ""}
                </button>
              );
            })}
            {!!levels.size && !levels.has("mid") && (
              <button className={"btn small" + (showUnlabelled ? " primary" : "")} onClick={() => setShowUnlabelled((v) => !v)}
                title="Most postings never state a band. Hiding them makes the market look far smaller than it is.">
                + {unlabelled} unlabelled
              </button>
            )}
          </div>

          <label className="f">Area of work</label>
          <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
            {FAMILY_LABELS.map(([k, label]) => {
              const n = famCounts[k] || 0;
              if (!n && !fams.has(k)) return null;
              return (
                <button key={k} className={"btn small" + (fams.has(k) ? " primary" : "")}
                  onClick={() => toggleSet(setFams, fams, k, "jobFamilies")}>{label} {n}</button>
              );
            })}
          </div>

          <label className="f">Employer</label>
          <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
            {CAT_LABELS.map(([k, label]) => {
              const n = catCounts[k] || 0;
              if (!n && !cats.has(k)) return null;
              return (
                <button key={k} className={"btn small" + (cats.has(k) ? " primary" : "")}
                  onClick={() => toggleSet(setCats, cats, k, "jobCats")}>{label} {n}</button>
              );
            })}
          </div>

          {/* The loudest power-user demand in every job-search community: a
              persistent blocklist. Words here hide any title containing them,
              from every view AND every count — physical security, network
              engineering, whatever this search has taught you that you're not. */}
          <label className="f">Never show (words in the title)</label>
          <div className="row" style={{ gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {excludeWords.map((w) => (
              <span className="achip" key={w} style={{ borderColor: "var(--down)", color: "var(--down)" }}>
                {w}
                <button title="Allow again" onClick={() => setCareer((c) => ({ ...c, settings: { ...c.settings,
                  excludeWords: (c.settings.excludeWords || []).filter((x) => x !== w) } }))}>×</button>
              </span>
            ))}
            <input className="in" style={{ width: 180, padding: "4px 8px", fontSize: 12.5 }} placeholder="e.g. physical security"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const w = e.currentTarget.value.trim().toLowerCase();
                if (!w) return;
                e.currentTarget.value = "";
                setCareer((c) => ({ ...c, settings: { ...c.settings,
                  excludeWords: [...new Set([...(c.settings.excludeWords || []), w])] } }));
              }} />
          </div>
          <label className="f">Narrow it down</label>
          <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
            {TOGGLES.map((t) => (
              <button key={t.key} className={"btn small" + (t.on ? " primary" : "")} onClick={t.toggle} title={t.title}>{t.label}</button>
            ))}
            <select className="in" style={{ width: 140 }} value={minPay} onChange={(e) => setMinPay(Number(e.target.value))}>
              <option value={0}>Any pay</option>
              <option value={70000}>$70k+ adjusted</option>
              <option value={90000}>$90k+ adjusted</option>
              <option value={110000}>$110k+ adjusted</option>
              <option value={140000}>$140k+ adjusted</option>
            </select>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn small" onClick={clearAll}>Clear all</button>
            {!!dismissed.size && (
              <button className="btn small" onClick={() => setCareer((c) => ({ ...c, settings: { ...c.settings, dismissed: [] } }))}>
                Bring back {dismissed.size} dismissed
              </button>
            )}
            <button className="btn small primary" onClick={() => setFiltersOpen(false)}>Done</button>
          </div>
        </div>
      )}

      {!rows.length && data && (
        <div className="note" style={{ marginTop: 10 }}>
          Nothing matches those filters. Widen the ladder — the boards skew senior, and most new-grad
          security roles post between August and October for the following year.
        </div>
      )}

      <div className="jgrid">
        {rows.slice(0, limit).map((j) => {
          const already = tracked.has((j.company + "|" + j.title.slice(0, 90)).toLowerCase());
          /* A tracked target with a placeholder role is an INTENTION, not a
             posting — but the card dressed it as one: estimated pay, a fit
             score, "+$183k vs floor", all describing a job nobody has verified
             exists. Three honest states instead:
               - board watched, 0 matches  -> say so; no phantom numbers
               - board watched, N matches  -> point at the real postings
               - no readable board         -> keep estimates, labelled as such */
          const placeholder = j.tracked && /target/i.test(j.title || "");
          /* through the same prefs as every view, so this count IS the landing count */
          const liveN = placeholder ? liveFor(j.company).length : 0;
          const src = data?.sources?.[j.company];
          const bs = !placeholder ? null
            : liveN > 0 ? { kind: "live", n: liveN }
            : src && src.ok ? { kind: "none", scanned: src.scanned, filtered: src.matched || 0 }
            : { kind: "unwatched" };
          const phantom = bs && bs.kind === "none";
          return (
            <div className="jcard" key={j.id}>
              <div className="jtop">
                <span style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 14.5, display: "block", lineHeight: 1.25 }}>{j.company}</b>
                  <span style={{ display: "block", fontSize: 12.5, marginTop: 1 }}>{j.title}</span>
                </span>
                <span style={{ textAlign: "right", flexShrink: 0 }}>
                  {phantom
                    ? <div className="note" style={{ margin: 0, fontSize: 11.5 }}>no opening<br />to price</div>
                    : <>
                        <div className="mono" style={{ fontSize: 14.5, fontWeight: 600 }}>{money(j.adj)}</div>
                        {floorAdj > 0 && j.adj > 0 && (() => {
                          const d = j.adj - floorAdj;
                          if (Math.abs(d) < 2500) return <div className="note" style={{ margin: 0, fontSize: 10.5 }}>same as floor</div>;
                          return <div className="mono" style={{ fontSize: 11, fontWeight: 600, color: d > 0 ? "var(--up)" : "var(--down)" }}>
                            {d > 0 ? "+" : "−"}{money(Math.abs(d))} vs floor</div>;
                        })()}
                      </>}
                </span>
              </div>
              {contracts[j.company] && (() => {
                const c = contracts[j.company];
                const m = (x) => "$" + (x >= 1e9 ? (x / 1e9).toFixed(1) + "B" : x >= 1e6 ? Math.round(x / 1e6) + "M" : Math.round(x / 1e3) + "k");
                return (
                  <div className="note" style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.5 }}>
                    {c.loading ? "Checking USAspending…"
                      : c.error ? "Federal contracts: " + c.error
                      : c.count === 0 ? "No federal prime contracts on file — their revenue is private-sector."
                      : <>Federal contracts: <b className="mono">{m(c.total)}</b> across {c.count} awards.
                          {c.atRisk > 0 && <> <b style={{ color: "var(--gold)" }}>{m(c.atRisk)} expires within a year</b>
                            {c.expiringWithinAYear[0] && " (next: " + c.expiringWithinAYear[0].end + ", " + (c.expiringWithinAYear[0].agency || "").split("|")[0] + ")"} — a recompete lost is a team gone.</>}
                          {c.atRisk === 0 && " Nothing expiring within a year — stable federal book."}
                          <button className="x" style={{ marginLeft: 6 }} onClick={() => setContracts((p) => { const q = { ...p }; delete q[j.company]; return q; })}>✕</button></>}
                  </div>
                );
              })()}

              <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
                {j.tracked && <span className="tag" style={{ color: STATUS_CLR[j.status] || "var(--faint)", borderColor: STATUS_CLR[j.status] || "var(--line2)" }}>{j.status}</span>}
                {lastSeen && (j.firstSeen || "") > lastSeen && <span className="tag" style={{ color: "var(--gold)", borderColor: "var(--gold)" }}>New</span>}
                {j.remote ? (
                  <span className="tag" style={{ color: "var(--up)", borderColor: "var(--up)" }}
                    title="Remote is the best location outcome here: the city question disappears">Remote · S</span>
                ) : j.city ? (
                  <button className="tag" style={{ cursor: "pointer", background: "none", color: partnerColor(j.city.partner), borderColor: partnerColor(j.city.partner) }}
                    onClick={() => setWhy(whyId === j.id ? null : j.id)} title="What's there for a partner">
                    {j.city.name} · {j.city.tier} ▾
                  </button>
                ) : <span className="tag" style={{ color: "var(--faint)" }}>Unranked city</span>}
                {j.iam && <span className="tag" style={{ color: "var(--acc)", borderColor: "var(--acc)" }}>IAM</span>}
                {j.clearance && <span className="tag" style={{ color: "var(--gold)", borderColor: "var(--gold)" }}>Clearance</span>}
                <span className="tag" style={j.levelBasis && j.levelBasis !== "stated" ? { borderStyle: "dashed" } : undefined}
                  title={j.levelBasis === "pay" ? "Estimated from the salary the posting lists"
                    : j.levelBasis === "scope" ? "Estimated from what the posting asks you to do"
                    : j.levelSure === false ? "The posting states no level" : undefined}>
                  {(LEVELS.find(([k]) => k === j.level) || [, j.level])[1]}{j.levelSure === false && !j.levelBasis ? " ?" : ""}
                </span>
              </div>

              {whyId === j.id && j.city && (
                <span className="note" style={{ margin: 0, fontSize: 11.5, color: partnerColor(j.city.partner) }}>
                  Cost of living {j.city.col} · {partnerLabel(j.city.partner)} for a partner{j.city.orgs ? " — " + j.city.orgs : ""}
                </span>
              )}

              {bs && bs.kind === "none" ? (
                <div className="note" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--gold)" }}>
                  {bs.filtered > 0
                    ? <>Their board is watched — <b>{bs.filtered} security role{bs.filtered === 1 ? "" : "s"} live, but none in your areas of work</b>.
                        Widen the family filters if you want to see {bs.filtered === 1 ? "it" : "them"}.</>
                    : <>Their board is watched — <b>{bs.scanned} open roles right now, none in security/IAM</b>. It'll appear here the day one does.</>}
                </div>
              ) : bs && bs.kind === "live" ? (
                <div className="mrow" style={{ justifyContent: "flex-start", margin: 0 }}>
                  {/* count and landing view share one pipeline — this number is the card count you get */}
                  <button className="btn small primary" onClick={() => jumpToCompany(j.company)}>
                    {bs.n} live matching role{bs.n === 1 ? "" : "s"} on their board — see {bs.n === 1 ? "it" : "them"}
                  </button>
                </div>
              ) : (
                <>
                  {bs && bs.kind === "unwatched" && (
                    <span className="note" style={{ margin: 0, fontSize: 10.5, color: "var(--gold)" }}>
                      No readable board — role and pay are assumptions, not a posting. Open checks their careers page.
                    </span>
                  )}
                  <div className="row" style={{ gap: 12 }}>
                    <Meter label="LIKELIHOOD" value={j.odds} color={meterColor(j.odds)}
                      title={j.odds == null ? "Upload a resume and this turns on" : "Your rung, resume overlap, years, clearance, and how selective this employer is"} />
                    <Meter label="FIT" value={j.fit} color={meterColor(j.fit)}
                      title="Pay after cost of living, place, growth, and whether it's the work you want" />
                    <Meter label="GROWTH" value={j.moveUp} color={meterColor(j.moveUp)}
                      title={CAT_GROWTH[j.cat]?.[1] || "How fast this kind of employer promotes"} />
                  </div>
                  {j.why && <span className="note" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45 }}>{j.why}</span>}
                </>
              )}

              <span className="note" style={{ margin: 0, fontSize: 10.5 }}>
                {j.location || "location not stated"}{j.posted ? " · " + ago(j.posted) : ""}
                {j.compLow ? " · posted " + money(j.compLow) + "–" + money(j.compHigh) : j.compEst ? " · pay estimated" : ""}
                {j.ageDays > 120 ? " · open 4+ months" : ""}
                {/* A closed-and-reopened req resets its own posted date — the age
                    people judge it by. The registry keeps the true first sighting,
                    and a role reposted repeatedly is usually pipeline-farming. */}
                {j.reposts > 0 && (
                  <span style={{ color: "var(--gold)" }} title={"First seen " + (j.firstEverSeen || "earlier") + " — reposting resets the visible age, so treat “" + ago(j.posted || j.firstSeen) + "” with suspicion."}>
                    {" · reposted " + j.reposts + "×" + (j.trueAgeDays > (j.ageDays || 0) + 14 ? ", really " + Math.round(j.trueAgeDays / 30) + " mo old" : "")}
                  </span>
                )}
                {data?.velocity?.[j.company] && (
                  <span style={{ color: data.velocity[j.company].delta < 0 ? "var(--down)" : "var(--up)" }}
                    title={"Open roles at " + j.company + ": " + data.velocity[j.company].then + " → " + data.velocity[j.company].now + " over " + data.velocity[j.company].days + " days. A shrinking board often precedes a freeze."}>
                    {" · hiring " + (data.velocity[j.company].delta > 0 ? "up " : "down ") + Math.abs(data.velocity[j.company].delta) + " in 30d"}
                  </span>
                )}
              </span>

              <div className="jfoot">
                {/* A live posting has its own URL. A tracked target usually
                    doesn't, but Atlas often knows the employer's board from the
                    poll registry — so go to their real careers page, and only
                    fall back to a search when there genuinely isn't one. The
                    query also drops the placeholder role, which was producing
                    searches for "IAM / Security — target". */}
                {(() => {
                  const direct = j.url || careersFor(j.company, data);
                  if (direct) return <a className="btn small primary" href={direct} target="_blank" rel="noreferrer noopener">Open</a>;
                  const role = /target|^$/i.test(j.title) ? (j.iam ? "IAM analyst" : "security analyst") : j.title;
                  return <a className="btn small primary" title="No board on file for this employer — searching their careers page"
                    href={"https://duckduckgo.com/?q=" + encodeURIComponent(j.company + " careers " + role)}
                    target="_blank" rel="noreferrer noopener">Find it</a>;
                })()}
                {j.tracked
                  ? <button className="btn small" onClick={() => onEdit(apps.find((a) => a.id === j.appId))}>Edit</button>
                  : <button className="btn small" disabled={already} onClick={() => track(j)}>{already ? "Tracked ✓" : "Track"}</button>}
                <span className="menuwrap">
                  <button className="btn small" onClick={() => setMenuId(menuId === j.id ? null : j.id)} title="More">···</button>
                  {menuId === j.id && (
                    <div className="menu">
                      <button onClick={() => { setMenuId(null); onTailor(track(j, true)); }}>✦ Tailor my resume to this</button>
                      <button onClick={() => { setMenuId(null); onCoverLetter(track(j, true)); }}>✦ Draft a cover letter</button>
                      <button onClick={() => { setMenuId(null); onImpact(track(j, true)); }}>What it pays me</button>
                      <hr />
                      <button onClick={() => { setMenuId(null); setWhy(whyId === j.id ? null : j.id); }}>Why this city</button>
                      {/* Cleared and defense-adjacent employers live on federal money,
                          and a recompete they lose takes the team with it. USAspending
                          is public and free — the layoff calendar, months in advance. */}
                      {["cleared", "consulting", "utility"].includes(j.cat) && (
                        <button onClick={async () => {
                          setMenuId(null);
                          setContracts((p) => ({ ...p, [j.company]: { loading: true } }));
                          try {
                            const r = await fetch("/api/company/contracts?name=" + encodeURIComponent(j.company));
                            const jj = await r.json();
                            setContracts((p) => ({ ...p, [j.company]: r.ok ? jj : { error: jj.error || "lookup failed" } }));
                          } catch { setContracts((p) => ({ ...p, [j.company]: { error: "lookup failed" } })); }
                        }}>Federal contracts</button>
                      )}
                      <button className="danger" onClick={() => { setMenuId(null); dismiss(j.id); }}>Not interested</button>
                    </div>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {rows.length > limit && (
        <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
          <button className="btn small" onClick={() => setLimit((n) => n + 9)}>Show 9 more — {rows.length - limit} hidden</button>
        </div>
      )}
    </div>
  );
}
