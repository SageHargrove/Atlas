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
const WORKDAY_DETAIL_CAP = 90;               // bounded extra requests per Workday board per poll

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

/* Read the pay out of the FULL text, then truncate — the range is always in the
   last paragraph, so doing this the other way round loses all of it. */
const withPay = (full, base) => {
  const clean = txt(full);
  const p = payFromText(clean);
  return { ...base, desc: clean.slice(0, DESC_CHARS), _full: clean, ...(p && base.comp == null ? p : {}) };
};

const ADAPTERS = {
  async greenhouse(src) {
    const j = await jget("https://boards-api.greenhouse.io/v1/boards/" + src.token + "/jobs?content=true");
    return (j.jobs || []).map((x) => withPay(x.content, {
      id: "gh:" + src.token + ":" + x.id,
      title: txt(x.title),
      location: txt(x.location?.name),
      url: x.absolute_url,
      posted: (x.first_published || x.updated_at || "").slice(0, 10),
      comp: null,
    }));
  },
  async lever(src) {
    const j = await jget("https://api.lever.co/v0/postings/" + src.token + "?mode=json");
    /* Lever splits a posting: `description` is the intro blurb, and everything
       that matters — Requirements, Qualifications, the years of experience —
       lives in `lists`. Reading only the description meant IDMWORKS asking for
       "3+ years IAM implementation, 4+ years security consulting" looked like a
       posting with no stated requirement at all. */
    const body = (x) => [x.descriptionPlain || x.description,
      ...(Array.isArray(x.lists) ? x.lists.map((l) => (l.text || "") + " " + (l.content || "")) : []),
      x.additionalPlain || x.additional || ""].filter(Boolean).join(" \n");
    return (Array.isArray(j) ? j : []).map((x) => withPay(body(x), {
      id: "lv:" + src.token + ":" + x.id,
      title: txt(x.text),
      location: txt(x.categories?.location),
      url: x.hostedUrl || x.applyUrl,
      posted: x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : "",
      comp: (x.salaryRange && Number(x.salaryRange.min) > 0)
        ? Math.round((Number(x.salaryRange.min) + Number(x.salaryRange.max || x.salaryRange.min)) / 2) : null,
    }));
  },
  async ashby(src) {
    const j = await jget("https://api.ashbyhq.com/posting-api/job-board/" + src.token + "?includeCompensation=true");
    return (j.jobs || []).filter((x) => x.isListed !== false).map((x) => withPay(x.descriptionPlain || x.description, {
      id: "ab:" + src.token + ":" + x.id,
      title: txt(x.title),
      location: txt(x.location),
      url: x.jobUrl || x.applyUrl,
      posted: (x.publishedAt || "").slice(0, 10),
      remoteHint: !!x.isRemote,
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
          _path: x.externalPath,
        });
      }
      if (rows.length < 20 || out.length >= (j.total || 0)) break;
      await sleep(BETWEEN_MS);
    }

    /* Workday's LIST endpoint returns a one-line subtitle and nothing else, so
       pay, clearance and years-required were all invisible for these employers.
       The detail endpoint has the full posting. One extra request per row is
       the price of a CACI job showing its real $58,400–$116,900 instead of an
       estimate — but only for rows that survive the security filter, so we
       aren't fetching 300 program-manager pages to throw them away. */
    const keep = out.filter((p) => classifyPosting({ ...p }, src.cat));
    let spent = 0;
    for (const p of out) {
      if (!keep.some((k) => k.id === p.id) || spent >= WORKDAY_DETAIL_CAP) { delete p._path; continue; }
      try {
        const dj = await jget(base + "/wday/cxs/" + src.tenant + "/" + src.site + p._path);
        const full = txt(dj?.jobPostingInfo?.jobDescription);
        if (full) {
          p.desc = full.slice(0, DESC_CHARS);
          p._full = full;
          const pay = payFromText(full);
          if (pay) Object.assign(p, pay);
        }
        spent++;
      } catch { /* one unreachable detail page must not lose the posting */ }
      delete p._path;
      await sleep(120);
    }
    return out;
  },
};

/* Pay-transparency laws (CO, NY, CA, WA, IL) mean a large share of postings now
   state a real range — but always in the last paragraph, so truncating the
   description from the top threw every one of them away. This runs on the FULL
   text before truncation.

   Deliberately conservative: two amounts, a separator, both landing in a sane
   annual salary band. A single number is ignored (could be revenue, equity, a
   bonus cap), and hourly rates are only annualised when the text says hour. */
const PAY_RANGE = /\$\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?)\s?([kK])?\s*(?:-|–|—|to|through)\s*\$?\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?)\s?([kK])?/g;
const PAY_CONTEXT = /salary|compensation|pay range|base pay|base salary|hiring range|target range|annual(?:ized)? (?:pay|salary|rate)|\bUSD\b|per hour|hourly|\/\s?hr\b/i;
/* "Save clients $100,000 - $200,000 per year in licensing" is money the JOB
   saves, not money it pays. Checked in a window around each match rather than
   across the whole document, because a real posting mentions both. */
const NOT_PAY = /\b(sav(?:e|ed|ing|ings)|revenue|arr\b|budget|funding|raised|series [a-e]\b|contract value|cost|spend|deal|portfolio|assets under)\b/i;
export function payFromText(text) {
  const t = String(text || "");
  if (!t || !PAY_CONTEXT.test(t)) return null;
  const hourly = /per hour|hourly|\/\s?hr\b|an hour/i.test(t);
  const out = [];
  PAY_RANGE.lastIndex = 0;
  let m;
  while ((m = PAY_RANGE.exec(t))) {
    const near = t.slice(Math.max(0, m.index - 90), m.index + m[0].length + 40);
    if (NOT_PAY.test(near) || !PAY_CONTEXT.test(near)) continue;
    const num = (v, k) => {
      let n = Number(String(v).replace(/,/g, ""));
      if (k) n *= 1000;
      /* "$120.5K" and "$120,000" both land right; a bare "120" with a k suffix
         missing is ambiguous, so anything under 1000 is treated as hourly-ish */
      return n;
    };
    let lo = num(m[1], m[2]), hi = num(m[3], m[4]);
    if (hourly && lo < 400 && hi < 400) { lo *= 2080; hi *= 2080; }
    if (!(lo > 0) || !(hi >= lo)) continue;
    if (lo < 25000 || hi > 900000) continue;   // not a salary: equity, revenue, a cap
    out.push({ lo, hi });
  }
  if (!out.length) return null;
  /* several ranges usually means multiple geographic tiers — take the widest
     span's midpoint rather than the first one, which is often the cheapest zone */
  const best = out.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))[0];
  return { comp: Math.round((best.lo + best.hi) / 2), compLow: Math.round(best.lo), compHigh: Math.round(best.hi) };
}

function compFromAshby(x) {
  const t = x.compensation?.compensationTierSummary || x.compensation?.summary;
  if (!t) return null;
  const p = payFromText(String(t) + " salary");   // the summary is bare, so give the context matcher something
  return p ? p.comp : null;
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

/* Returns whether the level was actually STATED or just defaulted. It matters:
   "Cyber Security Engineer" with no band and no years is not a mid-level role,
   it's a role of unknown level that got filed under mid. A new grad who filters
   to entry and sees 4 results is being told something false — most of the market
   simply doesn't label itself, and those are the ones worth reading. */
/* When the title states nothing, the body and the pay usually do. Scope language
   is checked first because it's what the role actually IS; pay is a decent proxy
   but moves with geography and category, so it's the fallback rather than the
   lead. Both are reported as inferred, never as stated — an estimate that
   presents itself as a fact is worse than no estimate. */
const SCOPE_HIGH = /\b(mentor|coach|set (?:the )?(?:technical )?(?:strategy|direction|vision)|define the roadmap|manage a team|lead a team|people manager|direct reports|org[- ]wide|company[- ]wide|drive alignment across|principal[- ]level)\b/i;
const SCOPE_LOW = /\b(no prior experience|entry[- ]level|recent graduate|new graduate|0[-–]2 years|1[-–]2 years|under (?:the )?(?:direct )?supervision|will learn|training (?:will be )?provided|early[- ]career|rising (?:junior|senior)|pursuing a (?:bachelor|b\.?s\.?))\b/i;
/* National midpoints for security work, before any category adjustment. Pay is
   a coarse signal, so the bands are wide and deliberately overlap-free. */
const PAY_BANDS = [[92000, "entry"], [125000, "mid"], [170000, "senior"], [225000, "lead"], [Infinity, "principal"]];
const CAT_PAY_SCALE = { quant: 1.7, bigtech: 1.35, financial: 1.05, enterprise: 1, consulting: 0.92, cleared: 0.9, utility: 0.85 };

function inferLevel(text, comp, cat) {
  const t = String(text || "");
  if (SCOPE_LOW.test(t)) return { level: "entry", basis: "scope" };
  if (SCOPE_HIGH.test(t)) return { level: "lead", basis: "scope" };
  if (comp > 0) {
    /* normalise out the category so a $150k quant role isn't read as senior
       when it's the going rate for a new grad there */
    const norm = comp / (CAT_PAY_SCALE[cat] || 1);
    for (const [ceiling, level] of PAY_BANDS) if (norm < ceiling) return { level, basis: "pay" };
  }
  return null;
}

function levelOf(title, years) {
  /* an internship is an internship even when titled "Security Engineering Intern,
     Senior Platform Team", so it wins over everything else in the title */
  if (/\b(intern|internship|co-?op|apprentice|trainee)\b/i.test(title)) return { level: "intern", sure: true };
  /* an explicit seniority word beats the number: "Senior Threat Analyst 1" is a
     senior role at a company whose band-1 happens to be its senior band */
  for (const [name, re] of LADDER) if (re.test(title)) return { level: name, sure: true };
  const numbered = numberedRung(title);
  if (numbered) return { level: numbered, sure: true };
  if (ENTRY_WORDS.test(title)) return { level: "entry", sure: true };
  if (years != null) return { level: years >= 8 ? "principal" : years >= 5 ? "senior" : years <= 2 ? "entry" : "mid", sure: true };
  return { level: "mid", sure: false };
}
const CLEARED = /\b(clearance|ts\/sci|top secret|secret clearance|polygraph|poly\b|dod 8570|public trust)\b/i;
const REMOTE = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;
/* Must be tied to experience. A bare /\d+ years/ was fine against a 700-char
   snippet but became actively wrong once it read the whole description: it
   matched prose like "in the last 2 years" and filed a $199k Stripe role as
   entry level on the strength of it. */
const YEARS = /(\d+)\s*\+?\s*(?:(?:-|–|to)\s*\d+\s*)?years?[’']?s?\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?experience|(?:experience|background)\s*(?:of|:)?\s*(\d+)\s*\+?\s*years?|minimum\s+(?:of\s+)?(\d+)\s*\+?\s*years?/i;
/* The HIGHEST bar, not the first one mentioned. A posting reading "3+ years of
   IAM implementation" and then "4+ years in security consulting" gates on four;
   taking the first match understated every multi-requirement posting, which are
   most of the senior ones. */
const yearsFrom = (text) => {
  const t = String(text || "");
  const re = new RegExp(YEARS.source, "gi");
  let m, best = null;
  while ((m = re.exec(t))) {
    const n = Number(m[1] ?? m[2] ?? m[3]);
    /* 30 years of experience is a typo or a company anniversary, not a requirement */
    if (Number.isFinite(n) && n >= 0 && n <= 25 && (best == null || n > best)) best = n;
  }
  return best;
};

/* He can't take a role in Bengaluru or Dublin, and those were a third of the
   first run. Detected rather than dropped, so the filter stays the user's call. */
const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_WORDS = /\b(united states|usa|u\.s\.|remote - us|us remote|america)\b/i;
const NON_US = /\b(india|bengaluru|bangalore|ireland|dublin|spain|barcelona|madrid|germany|berlin|munich|france|paris|netherlands|amsterdam|poland|krakow|warsaw|romania|bucharest|israel|tel aviv|japan|tokyo|singapore|australia|sydney|melbourne|canada|toronto|vancouver|ontario|london|united kingdom|uk\b|scotland|switzerland|zurich|sweden|stockholm|brazil|sao paulo|mexico|costa rica|philippines|manila|china|shanghai|korea|seoul|hong kong|taiwan|dubai|uae|south africa|argentina|chile|colombia|portugal|lisbon|italy|milan|czech|prague|hungary|budapest|denmark|copenhagen|norway|oslo|finland|helsinki|austria|vienna|belgium|brussels|greece|athens|turkey|istanbul|vietnam|thailand|malaysia|indonesia|new zealand)\b/i;

/* "Security" covers a dozen jobs that share almost nothing day to day. 500 rows
   of mixed SOC, GRC, appsec and identity work is not a job feed, it's a wall —
   the family is what makes it filterable into something a person can read.
   Ordered most-specific first: a "Cloud IAM Engineer" is IAM work that happens
   to be in cloud, not cloud work. */
export const FAMILIES = [
  /* \w* on every stem: a trailing \b after "penetration test" refuses to match
     "Penetration Tester", and after "threat intel" refuses "Threat
     Intelligence". Same bug that let "Recruiter" past the block list. */
  ["iam", "IAM / identity", /\b(iam|identit\w*|iga|pam\b|privileged access|sso\b|saml|oidc|scim|okta|sailpoint|saviynt|cyberark|ping identity|entra|active directory|ldap|directory services|access manag\w*|access review\w*|provision\w*|entitlement\w*|zero trust)\b/i],
  ["offsec", "Offensive / red team", /\b(penetration test\w*|pen test\w*|pentest\w*|red team\w*|offensive security|exploit\w*|adversary emulation|vulnerability assessment|bug bounty|purple team)\b/i],
  ["soc", "SOC / detection & response", /\b(soc\b|security operations|detection\w*|incident response|threat\s*(hunt\w*|intel\w*|research\w*|detect\w*|analy\w*|monitor\w*)|hunting|siem|soar|forensic\w*|malware|triage|blue team|csirt|monitoring)\b/i],
  ["grc", "GRC / compliance", /\b(grc\b|governance|\brisk\b|complian\w*|audit\w*|policy|privacy|assurance|isso\b|isse\b|issm\b|system security officer|information system\w* security|nist|fedramp|cmmc|iso 27001|soc 2|controls|third[- ]party risk|vendor risk)\b/i],
  ["appsec", "Application / product security", /\b(appsec|application security|product security|secure (cod\w*|development)|sdlc|devsecops|code review|sast|dast|supply chain security|psirt)\b/i],
  ["cloud", "Cloud & infrastructure security", /\b(cloud security|aws|azure|gcp|kubernetes|container\w*|infrastructure security|network security|firewall\w*|platform security|cspm|cnapp)\b/i],
  /* Generic analyst work is NOT SOC work, and conflating them is the difference
     between a job he wants and one he specifically doesn't. SOC is matched
     first above, so anything with operations/detection/triage language is
     already gone by the time this runs — what's left is the broad
     "Cybersecurity Analyst" title, which was falling through to "other" and
     getting filtered away with the genuine leftovers. */
  ["analyst", "Security analyst", /\b(cyber ?security analyst|security analyst|cyber analyst|information security analyst|infosec analyst|security specialist|cyber ?security specialist|security consultant|security advisor|security administrator)\b/i],
  ["eng", "Security engineering", /\b(security engineer\w*|software engineer\w*|developer|platform|automation|tooling|data scientist|machine learning)\b/i],
];
export function familyOf(title, desc) {
  for (const [key, , re] of FAMILIES) if (re.test(title)) return key;
  for (const [key, , re] of FAMILIES) if (re.test(desc || "")) return key;
  return "other";
}

export function classifyPosting(p, cat) {
  const title = p.title || "";
  const loc = p.location || "";
  /* _full is the untruncated description, carried only this far — it never
     reaches the cache, where 500 postings x 20KB would be a 10MB file. */
  const full = p._full || p.desc || "";
  const hay = title + " " + loc + " " + full;
  if (TITLE_BLOCK.test(title)) return null;
  /* a body-only mention at a security company is boilerplate — the title decides */
  if (!TITLE_HITS.test(title)) return null;

  const years = yearsFrom(full);
  const stated = levelOf(title, years);
  /* Read the pay here too rather than trusting the adapter to have done it —
     inference that silently no-ops when a caller skips a step is worse than
     inference that doesn't exist. */
  const comp = p.comp != null ? p.comp : (payFromText(full)?.comp ?? null);
  /* three states, not two: stated in the title, inferred from the body or the
     pay, or genuinely unknown. Collapsing the last two is what made 87 postings
     silently claim to be mid-level. */
  const guess = stated.sure ? null : inferLevel(full, comp, cat);
  const level = guess ? guess.level : stated.level;

  const remote = !!p.remoteHint || REMOTE.test(loc) || REMOTE.test(title);
  const nonUs = NON_US.test(loc);
  const { _full, ...rest } = p;
  return {
    ...rest,
    comp,
    family: familyOf(title, full),
    level,
    levelSure: stated.sure,
    levelBasis: stated.sure ? "stated" : guess ? guess.basis : null,
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

/* An estimate learned from this corpus beats a table I typed from memory: it's
   this industry, these employers, this year, and it improves every poll as more
   states force pay disclosure. Median, not mean — one $450k quant posting should
   not drag a whole band upward. Needs 3 real samples before it will speak. */
const MIN_SAMPLES = 3;
function buildPayStats(jobs) {
  const buckets = {};
  for (const j of jobs) {
    if (!(j.comp > 0) || j.compEst) continue;
    (buckets[j.cat + "|" + j.level] ||= []).push(j.comp);
    (buckets["*|" + j.level] ||= []).push(j.comp);
  }
  const out = {};
  const scaleSum = {};
  for (const j of jobs) {
    if (!(j.comp > 0) || j.compEst) continue;
    (scaleSum[j.level] ||= []).push(CAT_PAY_SCALE[j.cat] || 1);
  }
  for (const [k, vals] of Object.entries(buckets)) {
    if (vals.length < MIN_SAMPLES) continue;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    out[k] = Math.round((vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2) / 500) * 500;
    out[k + "|n"] = vals.length;
  }
  /* What the average category behind each all-category median actually was, so a
     cross-category estimate can be corrected toward the target's own market. */
  for (const [lvl, arr] of Object.entries(scaleSum)) {
    if (out["*|" + lvl] != null) out["*|" + lvl + "|scale"] = arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  return out;
}

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
        const c = classifyPosting(p, src.cat);
        if (!c) continue;
        const was = prevById.get(c.id);
        /* Age is a real signal: a req that has sat open for months is often
           filled, frozen, or an evergreen pipeline posting rather than a live
           opening. Surfaced, not hidden — some of them are genuinely still open. */
        const seen = c.posted || was?.firstSeen || today;
        const days = Math.round((Date.parse(today) - Date.parse(seen)) / 86400000);
        hits.push({ ...c, company: src.company, cat: src.cat || "enterprise", source: src.kind,
          firstSeen: was?.firstSeen || today, ageDays: Number.isFinite(days) && days >= 0 ? days : null });
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
  const payStats = buildPayStats(jobs);
  /* Fill in what the posting didn't say, from what comparable postings DID say.
     Marked estimated so the UI can label it — but every row having a number
     beats most rows having a dash, because a dash can't be sorted or filtered. */
  for (const j of jobs) {
    if (j.comp > 0) continue;
    const own = payStats[j.cat + "|" + j.level];
    if (own) { j.comp = own; j.compEst = true; continue; }
    /* The all-category median is badly skewed for thin bands: the only three
       entry postings that publish pay are at Stripe, Jane Street and Coalfire,
       so a raw "*|entry" of $150k would tell him a utility analyst job pays
       Bay Area money. Rescale by how the two categories actually differ. */
    const any = payStats["*|" + j.level];
    if (!any) continue;
    const scale = (CAT_PAY_SCALE[j.cat] || 1) / (payStats["*|" + j.level + "|scale"] || 1);
    j.comp = Math.round((any * scale) / 500) * 500;
    j.compEst = true;
    j.compRough = true;   // derived across categories, not within one — a weaker claim
  }
  const seen = new Set(jobs.map((j) => j.id));
  const added = jobs.filter((j) => !prevById.has(j.id)).length;
  const closed = (prev.jobs || []).filter((j) => !seen.has(j.id)).length;

  /* ---- reposts ----------------------------------------------------------
     A requisition that is closed and reopened gets a fresh id and a fresh
     posted date, which resets the "days old" counter the reader is using to
     judge it. Same employer, same title, new id: that is a repost, and a role
     that reappears on a metronome is usually a pipeline-farming advert rather
     than a job someone is trying to fill. Atlas polls the same boards every
     six hours, so it is uniquely placed to notice — it just wasn't looking. */
  const reg = { ...(prev.titles || {}) };
  const tkey = (j) => (j.company + "|" + String(j.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim());
  for (const j of jobs) {
    const k = tkey(j);
    const r = reg[k] || { first: j.firstSeen || today, ids: [], reposts: 0, gone: null };
    if (!r.ids.includes(j.id)) {
      /* a NEW id for a title we already had, after the old one vanished */
      if (r.ids.length && r.gone) { r.reposts += 1; r.lastRepost = today; }
      r.ids.push(j.id);
      if (r.ids.length > 8) r.ids = r.ids.slice(-8);
    }
    r.gone = null;
    r.lastSeen = today;
    reg[k] = r;
  }
  /* mark titles whose every id has disappeared, so a later reappearance counts */
  for (const [k, r] of Object.entries(reg)) {
    if (r.lastSeen !== today && !r.gone) r.gone = today;
    /* forget anything untouched for a year rather than growing without bound */
    if (r.lastSeen && (Date.parse(today) - Date.parse(r.lastSeen)) > 365 * 86400000) delete reg[k];
  }
  /* hand each posting its own history */
  for (const j of jobs) {
    const r = reg[tkey(j)];
    if (!r) continue;
    j.reposts = r.reposts || 0;
    j.firstEverSeen = r.first;
    const trueAge = Math.round((Date.parse(today) - Date.parse(r.first)) / 86400000);
    if (Number.isFinite(trueAge) && trueAge >= 0) j.trueAgeDays = trueAge;
  }

  /* ---- hiring velocity --------------------------------------------------
     How many roles an employer has open, sampled each poll. A hiring freeze
     shows up on a company's own board weeks before any announcement, and this
     is the cheapest possible way to see it: count what we already fetched. */
  const counts = {};
  for (const j of jobs) counts[j.company] = (counts[j.company] || 0) + 1;
  const vel = [...(prev.velocity || []).filter((v) => v.date !== today), { date: today, counts }]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-120);   // roughly a year of daily samples

  writeCache({ jobs, sources: report, payStats, titles: reg, velocity: vel,
    lastRun: new Date().toISOString(), took: Date.now() - started, added, closed });
  running = false;
  return { total: jobs.length, added, closed, took: Date.now() - started,
    withRealPay: jobs.filter((j) => j.comp > 0 && !j.compEst).length };
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

/* Direction of travel per employer: how their open-role count now compares with
   a month ago. Two samples a month apart is a weak signal on its own, which is
   why this returns the samples alongside the verdict rather than just a word. */
export function velocityFor(company) {
  const c = getCache();
  const rows = (c.velocity || []).map((v) => ({ date: v.date, n: v.counts?.[company] ?? null }))
    .filter((r) => r.n != null);
  if (rows.length < 2) return null;
  const now = rows[rows.length - 1];
  const target = Date.parse(now.date) - 30 * 86400000;
  /* the sample closest to a month back, not merely the oldest one */
  const then = rows.reduce((a, b) => (Math.abs(Date.parse(b.date) - target) < Math.abs(Date.parse(a.date) - target) ? b : a));
  if (then.date === now.date) return null;
  const delta = now.n - then.n;
  const days = Math.round((Date.parse(now.date) - Date.parse(then.date)) / 86400000);
  return { now: now.n, then: then.n, delta, days, samples: rows.length,
    dir: delta > 0 ? "growing" : delta < 0 ? "shrinking" : "flat" };
}
