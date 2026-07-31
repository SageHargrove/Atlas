/* ------------------------------------------------------------------
   Odds — how likely you are to actually get this job.

   Kept separate from the component, and separate from Fit, for two
   reasons. It is the number most likely to be quietly wrong, so it needs
   to be testable without a browser. And its whole value is that it isn't
   flattering: a score that tells a rising senior he has a realistic shot
   at a Jane Street role, or at a distributed-systems job because the
   posting says "SSO", wastes the one recruiting season he has.

   Everything here is a multiplier on a points base rather than a
   deduction from it, because the things that stop an application are
   gates, not gradients. A recruiter filtering on years never reaches the
   skills section to be impressed by it.
------------------------------------------------------------------ */

export const LEVEL_ORDER = ["intern", "entry", "mid", "senior", "lead", "principal", "executive"];

/* How hard the front door is, independent of you. Quant shops take low
   single-digit percentages of applicants and screen on competitive-programming
   ability; utilities and consultancies hire volume from campus. */
export const SELECTIVITY = {
  quant: 0.22, bigtech: 0.45, financial: 0.72, cleared: 0.82,
  enterprise: 0.85, consulting: 0.92, utility: 0.95,
};

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
export const tokensOf = (text) => {
  const lc = " " + String(text || "").toLowerCase().replace(/[^a-z0-9+\-./ ]/g, " ").replace(/\s+/g, " ") + " ";
  return new Set(SKILLS.filter((s) => lc.includes(" " + s + " ") || lc.includes(" " + s + ",") || lc.includes(" " + s + ".")));
};

/* Keyword overlap cannot tell "administers an identity platform" from "writes
   the identity platform in Go". Tailscale's Backend Engineer, Identity matches
   on sso, oauth, saml, scim and identity — every one of them genuinely present —
   and scored a 41, when it is a distributed-systems role at a VC-backed infra
   startup and the resume's engineering evidence is one ServiceNow internship.
   Shared vocabulary is not shared discipline. */
const BUILD_TITLE = /\b(software|backend|back-end|frontend|front-end|full ?stack|platform|systems?|infrastructure|distributed)\s+(engineer|developer)\b|\b(engineer|developer)\b.*\b(golang|rust|scala|kotlin|c\+\+)\b/i;
const BUILD_DEMANDS = /\b(distributed systems|microservices|scalab|latency|throughput|concurren|data structures|algorithms|design patterns|api design|production services|on-call rotation|observability)\b/i;
/* Evidence of actually shipping software, not of having listed a language */
const BUILD_EVIDENCE = /\b(software (engineer|developer)|developer|swe\b|built|shipped|implemented|deployed|refactor|codebase|pull request|unit test|ci\/cd|open source|microservice)\b/i;

export function buildGap(job, resume) {
  const isBuild = BUILD_TITLE.test(job.title || "")
    || (job.family === "eng" && BUILD_DEMANDS.test(job.desc || ""));
  if (!isBuild) return 1;
  const t = String(resume || "");
  const hits = (t.match(new RegExp(BUILD_EVIDENCE.source, "gi")) || []).length;
  const devRole = /\b(software|backend|full ?stack|application)\s+(engineer|developer)\b/i.test(t);
  if (devRole && hits >= 6) return 0.95;   // clearly a builder
  if (devRole || hits >= 6) return 0.62;   // some real evidence, not a specialist
  return 0.4;                              // an analyst applying to an engineering role
}

/* Returns 1–100, or null when there is no resume to judge against. Null rather
   than a default, because a confident number built on nothing is worse than an
   admission that the tool cannot answer yet. */
export function scoreOdds(job, me) {
  const { myLevel = "entry", myYears = 0, resume = "", hasResume = false, hasClearance = false } = me || {};
  if (!hasResume) return null;

  const rawGap = LEVEL_ORDER.indexOf(job.level) - LEVEL_ORDER.indexOf(myLevel || "entry");
  /* An unstated level defaulted to mid. Scoring that as a hard rung gap punishes
     the posting for the employer's vagueness rather than for anything true about
     you, so uncertainty is capped at one rung instead of counted in full. */
  const gap = job.levelSure === false && !job.levelBasis ? Math.min(rawGap, 1) : rawGap;
  const levelPts = gap <= -2 ? 38 : gap === -1 ? 46 : gap === 0 ? 50 : gap === 1 ? 26 : gap === 2 ? 9 : 2;

  const jt = tokensOf(job.title + " " + (job.desc || ""));
  const mine = tokensOf(resume);
  const shared = [...jt].filter((t) => mine.has(t));
  const overlapPts = jt.size ? Math.round(Math.min(1, shared.length / Math.min(8, Math.max(3, jt.size))) * 35) : 12;

  const clearPts = job.clearance ? (hasClearance ? 10 : -22) : 10;
  const raw = levelPts + overlapPts + clearPts;

  const shortfall = job.yearsReq == null ? 0 : Math.max(0, job.yearsReq - myYears);
  const yearsMult = [1, 0.82, 0.55, 0.36, 0.24][Math.min(Math.round(shortfall), 4)] ?? 0.18;
  const sel = SELECTIVITY[job.cat] ?? 0.85;

  return Math.max(1, Math.min(100, Math.round(raw * sel * yearsMult * buildGap(job, resume))));
}

/* The same inputs the score used, for the UI to explain itself with. */
export function oddsParts(job, me) {
  const { myYears = 0, resume = "" } = me || {};
  const jt = tokensOf(job.title + " " + (job.desc || ""));
  const mine = tokensOf(resume);
  return {
    shared: [...jt].filter((t) => mine.has(t)),
    shortfall: job.yearsReq == null ? 0 : Math.max(0, job.yearsReq - myYears),
    build: buildGap(job, resume),
  };
}

/* ---------------- saying why, in one line ----------------
   A number without a reason is a number you argue with. These are generated
   from the same components the score used — no model call, so it can't drift
   from the maths it is explaining, and it costs nothing to render on 500 rows.

   Order matters: lead with what makes this worth wanting, then name the single
   biggest thing standing in the way. Listing every factor reads as a spec
   sheet; naming the one that decides it reads as advice. */
export function explainRow(j, me = {}) {
  const { myYears = 0, floorAdj = 0, growth = 0, myLevel = 'entry' } = me;
  const good = [], bad = [];

  /* Lead with what is DIFFERENT about this row. Remote IAM work was mentioned
     first on every card, which is useless when the whole filtered list is remote
     IAM work — the sentence has to earn its space by saying something the card
     beside it wouldn't. Pay against your floor and the specific skills that
     matched are the two facts that actually vary row to row. */
  if (floorAdj && j.adj) {
    const d = j.adj - floorAdj;
    if (d >= 25000) good.push('pays ' + money(d) + ' over your floor');
    else if (d >= 8000) good.push(money(d) + ' over your floor');
    else if (d <= -8000) bad.push(money(Math.abs(d)) + ' under your floor');
    else good.push('about level with your floor');
  }
  if (j.shared?.length >= 3) good.push('matches you on ' + j.shared.slice(0, 3).join(', '));
  else if (j.shared?.length) good.push('matches on ' + j.shared[0]);
  if (j.compLow) good.push('pay is published, not guessed');

  const gap = j.gap ?? 0;
  if (gap === 1) good.push('a rung up from where you read');
  else if (gap === 0 && j.levelSure) good.push('pitched right at your level');
  if ((j.moveUp ?? 0) >= 80) good.push('fast ladder');
  else if ((j.moveUp ?? 0) <= 45) bad.push('a slow ladder — good pay now, less movement later');

  if (!j.remote && j.city && (j.city.tier === 'S' || j.city.tier === 'A')) good.push(j.city.name + ' is ' + j.city.tier + '-tier for you');

  /* blockers, worst first — only the top one is shown */
  if (j.shortfall >= 2) bad.unshift('wants ' + j.yearsReq + ' years and you have ' + myYears);
  else if (j.shortfall > 0) bad.unshift('asks for ' + j.yearsReq + ' years, just past you');
  if (j.build < 0.7) bad.unshift("it's a software engineering role, not an identity one");
  if (j.clearance) bad.unshift("needs a clearance you don't have");
  if ((j.sel ?? 1) <= 0.45) bad.unshift('this tier hires almost entirely from its own interns');
  if (!j.remote && j.city && (j.city.tier === 'D' || j.city.tier === 'F')) bad.unshift(j.city.name + ' is somewhere you ranked low');
  if (j.ageDays > 120) bad.push('open four months, so it may be filled or evergreen');

  const lead = good.slice(0, 2).join(', ');
  const block = bad[0];
  if (!lead && !block) return '';
  if (!block) return cap(lead) + '.';
  if (!lead) return cap(block) + '.';
  return cap(lead) + ' — but ' + block + '.';
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const money = (n) => "$" + Math.round(Number(n) / 1000) + "k";

/* ---------------- Fit and Growth ----------------
   Both were saturating. Fit summed four components that all max out together
   for the profile he actually wants — remote (35/35), IAM (15/15), consulting
   growth (15/15), and pay above a fixed $98k line (35/35) — so every remote IAM
   consultancy scored exactly 100 and the number stopped saying anything. A
   score that gives eleven cards the same 97 is a decoration.

   The fix is to measure against HIM rather than against constants: pay relative
   to the offer he already has, place on a scale where remote and a top city are
   comparable rather than both maxed, and growth that varies per row. */

const BRAND = { quant: 1, bigtech: 1, consulting: .8, financial: .6, enterprise: .5, cleared: .4, utility: .3 };
const LADDER = { consulting: 5, quant: 5, bigtech: 4, financial: 3, cleared: 3, enterprise: 3, utility: 2 };
const CITY_PTS = { S: 25, A: 20, B: 14, C: 8, D: 4, F: 0 };

/* How much this job would move your career, as opposed to how good it is today.
   A utility role paying well now on a two-rung-a-decade ladder and a consultancy
   paying the same with up-or-out promotion are not the same job, and Fit alone
   could never say so. */
export function scoreGrowth(job, me = {}) {
  const ladder = (LADDER[job.cat] ?? 3) / 5;
  const gap = LEVEL_ORDER.indexOf(job.level) - LEVEL_ORDER.indexOf(me.myLevel || "entry");
  /* one rung up is the sweet spot: real stretch, still reachable. Sideways is
     fine but teaches less; three rungs up you will not be hired into. */
  const stretch = gap <= -1 ? 0.2 : gap === 0 ? 0.5 : gap === 1 ? 1 : gap === 2 ? 0.7 : 0.35;
  const brand = BRAND[job.cat] ?? 0.5;
  return Math.max(1, Math.min(100, Math.round(ladder * 55 + stretch * 25 + brand * 20)));
}

/* Is this job worth wanting. Measured against your floor where you have one,
   because "good pay" is meaningless in the abstract and precise the moment
   there's an offer to beat. */
export function scoreFit(job, me = {}) {
  const { floorAdj = 0, tierT1 = 98000 } = me;
  const adj = job.adj;

  let pay = 12;
  if (adj > 0) {
    if (floorAdj > 0) {
      /* −20% to +60% of your floor spans the whole range, so the difference
         between $100k and $156k against a $97k floor is 14 points, not zero */
      const rel = (adj - floorAdj) / floorAdj;
      pay = Math.round(Math.max(0, Math.min(1, (rel + 0.2) / 0.8)) * 40);
    } else {
      pay = Math.round(Math.max(0, Math.min(1, (adj - 60000) / (tierT1 - 60000))) * 40);
    }
  }

  /* Remote is excellent but not automatically better than a city you'd both
     love. They were both pinned to the maximum before, so neither could win. */
  const place = job.remote ? 22 : job.city ? (CITY_PTS[job.city.tier] ?? 8) : 4;
  const partner = job.remote ? 0 : Math.round((job.city?.partner ?? 0) * 1.7);

  const focus = job.iam ? 15 : job.family === "analyst" || job.family === "eng" ? 10 : 5;
  const growthPart = Math.round((scoreGrowth(job, me) / 100) * 18);

  return Math.max(1, Math.min(100, pay + place + partner + focus + growthPart));
}
