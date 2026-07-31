/* ------------------------------------------------------------------
   Job discovery — the half a browser artifact could never do.

   Every source here is the employer's OWN public job board API: the same
   endpoint their careers page calls to render itself. No scraping, no
   logged-in sites, no terms-of-service grey area. LinkedIn and Indeed are
   deliberately absent — they block programmatic access and say so.

   Postings are public and identical for everyone, so one shared cache
   serves all users. Only which jobs you saved, dismissed or applied to
   lives in your own file.
------------------------------------------------------------------ */
import fs from "fs";
import path from "path";

const UA = "atlas-job-finder/1.0 (personal job search; contact via repo)";
const TIMEOUT_MS = 25000;   // Palantir's Lever board is ~280 postings and timed out at 12s
const POLL_EVERY_MS = 6 * 60 * 60 * 1000;   // 4x/day is plenty; postings don't churn hourly
const BETWEEN_MS = 250;                      // be a polite guest on someone else's API
const MAX_KEEP = 1200;                       // hard ceiling on the cache
const DESC_CHARS = 700;                      // enough to keyword-match; not enough to bloat

/* ---------------- adapters ----------------
   Each returns a normalized posting or null. Anything that throws is caught
   by the caller and the previous cache entry for that source is kept. */

const jget = async (url, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", "user-agent": UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(url.slice(0, 60) + " -> " + r.status);
  return r.json();
};

const txt = (v) => String(v == null ? "" : v).replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

const ADAPTERS = {
  async greenhouse(src) {
    const j = await jget("https://boards-api.greenhouse.io/v1/boards/" + src.token + "/jobs?content=true");
    return (j.jobs || []).map((x) => ({
      id: "gh:" + src.token + ":" + x.id,
      title: txt(x.title),
      location: txt(x.location?.name),
      url: x.absolute_url,
      posted: (x.first_published || x.updated_at || "").slice(0, 10),
      desc: txt(x.content).slice(0, DESC_CHARS),
    }));
  },
  async lever(src) {
    const j = await jget("https://api.lever.co/v0/postings/" + src.token + "?mode=json");
    return (Array.isArray(j) ? j : []).map((x) => ({
      id: "lv:" + src.token + ":" + x.id,
      title: txt(x.text),
      location: txt(x.categories?.location),
      url: x.hostedUrl || x.applyUrl,
      posted: x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : "",
      desc: txt(x.descriptionPlain || x.description).slice(0, DESC_CHARS),
    }));
  },
  async ashby(src) {
    const j = await jget("https://api.ashbyhq.com/posting-api/job-board/" + src.token + "?includeCompensation=true");
    return (j.jobs || []).filter((x) => x.isListed !== false).map((x) => ({
      id: "ab:" + src.token + ":" + x.id,
      title: txt(x.title),
      location: txt(x.location),
      url: x.jobUrl || x.applyUrl,
      posted: (x.publishedAt || "").slice(0, 10),
      remoteHint: !!x.isRemote,
      desc: txt(x.descriptionPlain || x.description).slice(0, DESC_CHARS),
      comp: compFromAshby(x),
    }));
  },
  /* Workday's careers page renders itself from this POST. Tenant + site have to
     be exact, which is why they come from a pasted careers URL rather than a
     guess — see parseBoardUrl. */
  async workday(src) {
    const base = "https://" + src.tenant + "." + (src.wd || "wd1") + ".myworkdayjobs.com";
    const out = [];
    for (let offset = 0; offset < 100; offset += 20) {
      const j = await jget(base + "/wday/cxs/" + src.tenant + "/" + src.site + "/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: src.query || "cyber security" }),
      });
      const rows = j.jobPostings || [];
      for (const x of rows) {
        out.push({
          id: "wd:" + src.tenant + ":" + (x.bulletFields?.[0] || x.externalPath),
          title: txt(x.title),
          location: txt(x.locationsText),
          url: base + "/en-US/" + src.site + (x.externalPath || ""),
          posted: postedFromWorkday(x.postedOn),
          desc: txt(x.subtitle),
        });
      }
      if (rows.length < 20 || out.length >= (j.total || 0)) break;
      await sleep(BETWEEN_MS);
    }
    return out;
  },
};

function compFromAshby(x) {
  const t = x.compensation?.compensationTierSummary || x.compensation?.summary;
  if (!t) return null;
  const nums = String(t).replace(/,/g, "").match(/\$?(\d{2,3})(?:\.\d+)?K|\$(\d{5,7})/gi);
  if (!nums) return null;
  const vals = nums.map((n) => (/k$/i.test(n) ? Number(n.replace(/[^\d.]/g, "")) * 1000 : Number(n.replace(/[^\d]/g, ""))))
    .filter((v) => v >= 30000 && v <= 900000);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}
/* Workday says "Posted 3 Days Ago" / "Posted Today", not a date */
function postedFromWorkday(s) {
  const m = /(\d+)\s*\+?\s*day/i.exec(s || "");
  const d = new Date();
  if (/today/i.test(s || "")) return d.toISOString().slice(0, 10);
  if (m) d.setDate(d.getDate() - Number(m[1]));
  else if (/(\d+)\s*\+?\s*month/i.test(s || "")) d.setMonth(d.getMonth() - Number(RegExp.$1));
  else return "";
  return d.toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- which employers ----------------
   Every entry below was verified to return postings before being added. The
   ones that aren't here mostly run Workday or Taleo behind a tenant name that
   can't be guessed — that's what "add by careers URL" is for. */
export const SEED_SOURCES = [
  { company: "GuidePoint Security", kind: "greenhouse", token: "guidepointsecurity", cat: "consulting" },
  { company: "IDMWORKS", kind: "lever", token: "idmworks", cat: "consulting" },
  { company: "Saviynt", kind: "lever", token: "saviynt", cat: "consulting" },
  { company: "Okta", kind: "greenhouse", token: "okta", cat: "enterprise" },
  { company: "Ping Identity", kind: "greenhouse", token: "pingidentity", cat: "enterprise" },
  { company: "BeyondTrust", kind: "greenhouse", token: "beyondtrust", cat: "enterprise" },
  { company: "Cloudflare", kind: "greenhouse", token: "cloudflare", cat: "bigtech" },
  { company: "Datadog", kind: "greenhouse", token: "datadog", cat: "bigtech" },
  { company: "Stripe", kind: "greenhouse", token: "stripe", cat: "bigtech" },
  { company: "Databricks", kind: "greenhouse", token: "databricks", cat: "bigtech" },
  { company: "GitLab", kind: "greenhouse", token: "gitlab", cat: "bigtech" },
  { company: "Snowflake", kind: "ashby", token: "snowflake", cat: "bigtech" },
  { company: "Palantir", kind: "lever", token: "palantir", cat: "bigtech" },
  { company: "Jane Street", kind: "greenhouse", token: "janestreet", cat: "quant" },
  { company: "Jump Trading", kind: "greenhouse", token: "jumptrading", cat: "quant" },
  { company: "IMC Trading", kind: "greenhouse", token: "imc", cat: "quant" },
  { company: "Akuna Capital", kind: "greenhouse", token: "akunacapital", cat: "quant" },
  { company: "Leidos", kind: "workday", tenant: "leidos", wd: "wd5", site: "External", cat: "cleared" },
  { company: "CACI", kind: "workday", tenant: "caci", wd: "wd1", site: "External", cat: "cleared" },
  { company: "Ameren", kind: "workday", tenant: "ameren", wd: "wd1", site: "External", cat: "utility" },
  /* identity and security vendors — the ones whose whole product is IAM */
  { company: "Zscaler", kind: "greenhouse", token: "zscaler", cat: "enterprise" },
  { company: "1Password", kind: "ashby", token: "1password", cat: "enterprise" },
  { company: "Transmit Security", kind: "greenhouse", token: "transmitsecurity", cat: "enterprise" },
  { company: "JumpCloud", kind: "lever", token: "jumpcloud", cat: "enterprise" },
  { company: "WorkOS", kind: "ashby", token: "workos", cat: "enterprise" },
  { company: "Persona", kind: "ashby", token: "persona", cat: "enterprise" },
  { company: "Axonius", kind: "greenhouse", token: "axonius", cat: "enterprise" },
  { company: "Netskope", kind: "greenhouse", token: "netskope", cat: "enterprise" },
  { company: "Sophos", kind: "lever", token: "sophos", cat: "enterprise" },
  { company: "Abnormal Security", kind: "greenhouse", token: "abnormalsecurity", cat: "enterprise" },
  { company: "Huntress", kind: "greenhouse", token: "huntress", cat: "enterprise" },
  { company: "Dragos", kind: "greenhouse", token: "dragos", cat: "utility" },   // OT/ICS — the utility crossover
  { company: "Recorded Future", kind: "greenhouse", token: "recordedfuture", cat: "enterprise" },
  { company: "Coalfire", kind: "lever", token: "coalfire", cat: "consulting" },
  { company: "Vanta", kind: "ashby", token: "vanta", cat: "consulting" },
  { company: "Drata", kind: "ashby", token: "drata", cat: "consulting" },
  { company: "Semgrep", kind: "ashby", token: "semgrep", cat: "enterprise" },
  { company: "Tailscale", kind: "greenhouse", token: "tailscale", cat: "enterprise" },
  { company: "Orca Security", kind: "greenhouse", token: "orcasecurity", cat: "enterprise" },
  /* fintech — GRC and IAM work with financial-sector pay */
  { company: "Plaid", kind: "ashby", token: "plaid", cat: "financial" },
  { company: "Socure", kind: "ashby", token: "socure", cat: "financial" },
  { company: "Brex", kind: "greenhouse", token: "brex", cat: "financial" },
  { company: "Affirm", kind: "greenhouse", token: "affirm", cat: "financial" },
  { company: "Robinhood", kind: "greenhouse", token: "robinhood", cat: "financial" },
  { company: "Block", kind: "greenhouse", token: "block", cat: "financial" },
  { company: "Marqeta", kind: "greenhouse", token: "marqeta", cat: "financial" },
  { company: "Coinbase", kind: "greenhouse", token: "coinbase", cat: "financial" },
  { company: "Virtu Financial", kind: "greenhouse", token: "virtu", cat: "quant" },
];

/* The employer's own listings page, rebuilt from the board we already know.
   Better than routing through a job aggregator: it's where the application
   actually happens, it's always current, and nothing tracks you on the way. */
export function careersUrl(src) {
  if (!src) return null;
  if (src.kind === "greenhouse") return "https://job-boards.greenhouse.io/" + src.token;
  if (src.kind === "lever") return "https://jobs.lever.co/" + src.token;
  if (src.kind === "ashby") return "https://jobs.ashbyhq.com/" + src.token;
  if (src.kind === "workday") return "https://" + src.tenant + "." + (src.wd || "wd1") + ".myworkdayjobs.com/en-US/" + src.site;
  return null;
}

/* A careers URL identifies the board exactly, where guessing a Workday tenant
   does not. Paste the link, get the adapter — no tokens to look up by hand. */
export function parseBoardUrl(raw, company) {
  const u = String(raw || "").trim();
  let m;
  if ((m = /greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i.exec(u)) || (m = /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i.exec(u)))
    return { kind: "greenhouse", token: m[1].toLowerCase() };
  if ((m = /(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([a-z0-9_-]+)/i.exec(u)))
    return { kind: "lever", token: m[1].toLowerCase() };
  if ((m = /ashbyhq\.com\/(?:posting-api\/job-board\/)?([a-z0-9_.-]+)/i.exec(u)))
    return { kind: "ashby", token: m[1].toLowerCase() };
  if ((m = /https?:\/\/([a-z0-9-]+)\.(wd\d)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i.exec(u)))
    return { kind: "workday", tenant: m[1].toLowerCase(), wd: m[2].toLowerCase(), site: m[3] };
  return null;
}

/* ---------------- role filtering ----------------
   The boards return everything — 807 Databricks jobs, most of them sales. Only
   security work survives this, and a title match counts for more than a body
   mention because every job description at a security company says "security". */
/* ISSO / ISSE / ISSM are standard cleared-world titles that carry no other
   security word — they were being dropped as if they weren't security jobs. */
const TITLE_HITS = /\b(iam|identity|access manag|iga|pam|privileged access|sso|isso|isse|issm|okta|sailpoint|saviynt|cyberark|ping identity|security|infosec|cyber|soc analyst|threat|incident response|vulnerabilit|appsec|grc|governance risk|compliance analyst|penetration test|pentest|red team|blue team|detection|siem|zero trust|cryptograph)/i;
/* Security companies title half their sales org "Security Something". These are
   quota-carrying or support roles, not security engineering — they were the
   single biggest source of noise in the first run. */
/* Note the \w* on recruit: \brecruit\b never matches "Recruiter", so recruiting
   roles at security companies were sailing straight through. */
const TITLE_BLOCK = /\b(sales|account executive|account manager|business development|marketing|recruit\w*|talent acquisition|customer success|customer support|solutions?\s+(engineer\w*|architect\w*|consultant\w*)|sales engineer\w*|pre-?sales|technical account manager|partner manager|channel|revenue|renewals|legal counsel|accountant|payroll|procurement|facilities|executive assistant)\b/i;
/* A ladder rather than junior/senior, so the same tool still works in ten years:
   filter to intern today, to lead later, without the finder having thrown the
   other rungs away. Checked top-down — "Senior Director" is a director, and
   "Associate Principal" is a principal, which a naive /associate/ match called
   entry level. */
export const LEVELS = ["intern", "entry", "mid", "senior", "lead", "principal", "executive"];

/* Numbered titles are how most large employers actually band roles, and getting
   them wrong misfiles whole companies. They were being read inconsistently:
   roman II landed in senior (because "ii" sat in the seniority word list) while
   arabic 3 and 4 landed in mid (because digits weren't read at all) — so
   "Security Engineer II" outranked "Information Security Analyst 4".

   One rung per number, romans and digits treated identically:
     I / 1    entry     <- a level 1 IAM analyst is an entry role
     II / 2   mid
     III / 3  senior
     IV / 4   senior
     V / 5+   lead */
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
const NUM_RUNG = { 1: "entry", 2: "mid", 3: "senior", 4: "senior", 5: "lead" };
const NUMBERED = /\b(?:analyst|engineer|specialist|consultant|administrator|architect|associate|officer|technician|developer|scientist)\s*[-–]?\s*(i{1,3}|iv|v|[1-5])\b/i;
const EXPLICIT_LEVEL = /\b(?:level|lvl|tier|band|grade)\s*[-–]?\s*(i{1,3}|iv|v|[1-5])\b/i;
function numberedRung(title) {
  const m = EXPLICIT_LEVEL.exec(title) || NUMBERED.exec(title);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return NUM_RUNG[ROMAN[raw] ?? Number(raw)] || null;
}

const LADDER = [
  ["executive", /\b(chief|c[teifos]o\b|vice president|\bvp\b|svp|evp|head of|director|dir\.?)\b/i],
  ["principal", /\b(principal|distinguished|fellow|staff)\b/i],
  ["lead", /\b(lead|manager|mgr\.?|supervisor)\b/i],
  ["senior", /\b(senior|sr\.?)\b/i],
];
const ENTRY_WORDS = /\b(new ?grad|graduate|entry[- ]level|junior|jr\.?|early career|university|campus|rotational|residency)\b|\bassociate\b(?!\s+(principal|director|vp|partner|manager))/i;

function levelOf(title, years) {
  /* an internship is an internship even when titled "Security Engineering Intern,
     Senior Platform Team", so it wins over everything else in the title */
  if (/\b(intern|internship|co-?op|apprentice|trainee)\b/i.test(title)) return "intern";
  /* an explicit seniority word beats the number: "Senior Threat Analyst 1" is a
     senior role at a company whose band-1 happens to be its senior band */
  for (const [name, re] of LADDER) if (re.test(title)) return name;
  const numbered = numberedRung(title);
  if (numbered) return numbered;
  if (ENTRY_WORDS.test(title)) return "entry";
  if (years != null) return years >= 8 ? "principal" : years >= 5 ? "senior" : years <= 2 ? "entry" : "mid";
  return "mid";
}
const CLEARED = /\b(clearance|ts\/sci|top secret|secret clearance|polygraph|poly\b|dod 8570|public trust)\b/i;
const REMOTE = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;
const YEARS = /(\d+)\s*\+?\s*(?:-\s*\d+\s*)?years?/i;

/* He can't take a role in Bengaluru or Dublin, and those were a third of the
   first run. Detected rather than dropped, so the filter stays the user's call. */
const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_WORDS = /\b(united states|usa|u\.s\.|remote - us|us remote|america)\b/i;
const NON_US = /\b(india|bengaluru|bangalore|ireland|dublin|spain|barcelona|madrid|germany|berlin|munich|france|paris|netherlands|amsterdam|poland|krakow|warsaw|romania|bucharest|israel|tel aviv|japan|tokyo|singapore|australia|sydney|melbourne|canada|toronto|vancouver|ontario|london|united kingdom|uk\b|scotland|switzerland|zurich|sweden|stockholm|brazil|sao paulo|mexico|costa rica|philippines|manila|china|shanghai|korea|seoul|hong kong|taiwan|dubai|uae|south africa|argentina|chile|colombia|portugal|lisbon|italy|milan|czech|prague|hungary|budapest|denmark|copenhagen|norway|oslo|finland|helsinki|austria|vienna|belgium|brussels|greece|athens|turkey|istanbul|vietnam|thailand|malaysia|indonesia|new zealand)\b/i;

export function classifyPosting(p) {
  const title = p.title || "";
  const loc = p.location || "";
  const hay = title + " " + loc + " " + (p.desc || "");
  if (TITLE_BLOCK.test(title)) return null;
  /* a body-only mention at a security company is boilerplate — the title decides */
  if (!TITLE_HITS.test(title)) return null;

  const ym = YEARS.exec(p.desc || "");
  const years = ym ? Number(ym[1]) : null;
  const level = levelOf(title, years);

  const remote = !!p.remoteHint || REMOTE.test(loc) || REMOTE.test(title);
  const nonUs = NON_US.test(loc);
  return {
    ...p,
    level,
    remote,
    /* a remote listing with no country signal is assumed US-eligible rather than
       hidden — being wrong here costs a glance, hiding a real job costs the job */
    us: !nonUs && (US_STATES.test(loc) || US_WORDS.test(loc) || remote || !loc),
    clearance: CLEARED.test(hay),
    yearsReq: years,
    iam: /\b(iam|identity|access manag|iga|pam|privileged|sso|okta|sailpoint|saviynt|cyberark|ping identity|zero trust)\b/i.test(title + " " + (p.desc || "")),
  };
}

/* ---------------- the poll ---------------- */

let CACHE_PATH = "";
let timer = null;
let running = false;

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { return { jobs: [], sources: {}, lastRun: null }; } };
const writeCache = (v) => {
  fs.writeFileSync(CACHE_PATH + ".tmp", JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(CACHE_PATH + ".tmp", CACHE_PATH);
};

/* Setting the cache path is separate from scheduling the poll on purpose: with
   JOB_POLL=0 the server still has to be able to SERVE the last poll's results.
   Tying the two together made the feed return nothing at all whenever polling
   was disabled, which looked like "no jobs found" rather than a misconfiguration. */
export function initCache(dataDir) { CACHE_PATH = path.join(dataDir, "jobs-cache.json"); }
export function getCache() { return CACHE_PATH ? readCache() : { jobs: [], sources: {}, lastRun: null }; }

export async function pollAll(extraSources = []) {
  if (running) return { skipped: "already running" };
  running = true;
  const started = Date.now();
  const prev = readCache();
  const prevById = new Map((prev.jobs || []).map((j) => [j.id, j]));
  const sources = [...SEED_SOURCES, ...extraSources];
  const kept = [];
  const report = {};
  const today = new Date().toISOString().slice(0, 10);

  for (const src of sources) {
    const key = src.company;
    try {
      const raw = await ADAPTERS[src.kind](src);
      const hits = [];
      for (const p of raw) {
        const c = classifyPosting(p);
        if (!c) continue;
        const was = prevById.get(c.id);
        hits.push({ ...c, company: src.company, cat: src.cat || "enterprise", source: src.kind, firstSeen: was?.firstSeen || today });
      }
      kept.push(...hits);
      report[key] = { ok: true, scanned: raw.length, matched: hits.length };
    } catch (e) {
      /* one dead board must not wipe out its postings or stop the others */
      const stale = (prev.jobs || []).filter((j) => j.company === key);
      kept.push(...stale);
      report[key] = { ok: false, error: String(e.message || e).slice(0, 120), stale: stale.length };
    }
    await sleep(BETWEEN_MS);
  }

  /* newest first, then trim — a cache that grows forever is a disk leak */
  kept.sort((a, b) => (b.posted || b.firstSeen || "").localeCompare(a.posted || a.firstSeen || ""));
  const jobs = kept.slice(0, MAX_KEEP);
  const seen = new Set(jobs.map((j) => j.id));
  const added = jobs.filter((j) => !prevById.has(j.id)).length;
  const closed = (prev.jobs || []).filter((j) => !seen.has(j.id)).length;

  writeCache({ jobs, sources: report, lastRun: new Date().toISOString(), took: Date.now() - started, added, closed });
  running = false;
  return { total: jobs.length, added, closed, took: Date.now() - started };
}

export function startPolling(dataDir, extraSourcesFn) {
  initCache(dataDir);
  const run = () => pollAll(extraSourcesFn ? extraSourcesFn() : [])
    .then((r) => console.log("job poll:", JSON.stringify(r)))
    .catch((e) => console.error("job poll failed:", e.message));
  /* a boot-time poll would fight the app for the event loop during startup */
  setTimeout(run, 20000).unref();
  timer = setInterval(run, POLL_EVERY_MS);
  timer.unref();
}
