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
