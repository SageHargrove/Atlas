/* Odds. The whole value of this number is that it is not flattering, so the
   cases below are the ones that WERE flattering and shouldn't have been.
   Run: npm test */
import { scoreOdds } from "../client/src/odds.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log("  ok   " + label + " -> " + got); }
  else { fail++; console.log("  FAIL " + label + ": got " + got + ", wanted " + want); }
};
const lt = (label, got, ceiling) => {
  if (got < ceiling) { pass++; console.log("  ok   " + label + " -> " + got + " (under " + ceiling + ")"); }
  else { fail++; console.log("  FAIL " + label + ": got " + got + ", wanted under " + ceiling); }
};

/* his actual resume, trimmed to what the scorer reads */
const RESUME = `Liam (Sage) Hargrove — Identity & Access Management (IAM) Engineer — SailPoint IdentityIQ, RBAC, Active Directory
IAM Analyst Intern | Southwest Power Pool   May 2026 – Aug. 2026
Designed and implemented a complete RBAC role model in SailPoint IdentityIQ 8.4 with NERC CIP regulated access.
Automated per-team entitlement analysis with BeanShell pipeline scripts and reusable export tooling.
Built an entitlement review pipeline — SQL queries against the IdentityIQ database feeding a Python scoring engine.
ServiceNow Software Developer Intern | GDIT   June 2025 – Aug. 2025
SOC Analyst | Louisiana Tech University   Jan. 2025 – May 2025
Monitored and responded to security alerts using Splunk Cloud, SOAR, IDS.
Skills: SailPoint IdentityIQ, RBAC, BeanShell, Active Directory, Python, SQL, Go, PowerShell, Splunk, NERC CIP
Certifications: CompTIA Security+, CompTIA Network+`;

const base = { myYears: 0.9, myLevel: "entry", resume: RESUME, hasResume: true, hasClearance: false };
const job = (o) => scoreOdds({ cat: "enterprise", level: "mid", family: "iam", title: "", desc: "", yearsReq: null, ...o }, base);

console.log("the ones that were wrong:");
/* Tailscale, Backend Engineer, Identity — real posting text. It matches on sso,
   oauth, saml, scim and identity, every one of them genuinely present, and came
   back a 41. It is a distributed-systems role at a VC-backed infra startup. */
const tailscale = job({
  company: "Tailscale", cat: "enterprise", family: "eng", level: "mid",
  title: "Backend Engineer, Identity",
  desc: "Develop features that support a broad range of sign-on functionality, such as SSO, OAuth2, SAML, and WebAuthn. "
      + "Develop and maintain SCIM style capabilities. Experience with distributed systems and building observable, secure, "
      + "scalable, and resilient services. Most of the non-front-end portions are developed in the Go programming language. "
      + "This role requires participation in our on-call rotation.",
});
lt("Backend Engineer, Identity is not a realistic shot", tailscale, 30);

/* IDMWORKS Identity Advisor — asks 3+ years IAM and 4+ years security consulting */
const idmworks = job({ company: "IDMWORKS", cat: "consulting", family: "iam", level: "mid",
  title: "Identity Advisor", yearsReq: 4,
  desc: "Knowledge and hands-on experience with IAM components: Access Management, SSO/Federation, enterprise directories. "
      + "3+ year of experience with IAM implementation/architecture. 4+ years of experience in security consulting. RBAC. NIST." });
lt("a 4-year requirement against 0.9 years is a long shot", idmworks, 30);

/* Jane Street new grad — genuinely open to new grads, genuinely near-impossible */
lt("quant new grad stays a long shot", job({ cat: "quant", family: "analyst", level: "entry",
  title: "Cybersecurity Analyst: New Grad", desc: "SIEM, incident response, python" }), 25);

console.log("\nthe ones that should look reachable:");
/* the level-1 IAM role he could actually go back to */
const spp = job({ cat: "utility", family: "iam", level: "entry", title: "IAM Analyst I",
  desc: "SailPoint IdentityIQ, RBAC, Active Directory, access reviews, NERC CIP, entitlement provisioning, python" });
eq("a level-1 IAM analyst role in his own field beats every one above",
  spp > tailscale && spp > idmworks, true);
console.log("       (IAM Analyst I " + spp + " vs Tailscale " + tailscale + ", IDMWORKS " + idmworks + ")");

console.log("\nthe pieces, in isolation:");
const plain = job({ family: "iam", title: "IAM Engineer", desc: "sailpoint rbac active directory python sql" });
lt("a build role costs a real multiple", job({ family: "eng", title: "Software Engineer, Platform",
  desc: "distributed systems, scalable services, Go, algorithms" }), plain);
lt("years shortfall costs a real multiple", job({ family: "iam", title: "IAM Engineer", yearsReq: 5,
  desc: "sailpoint rbac active directory python sql" }), plain);
eq("no resume means no number at all", job({ family: "iam", title: "IAM Engineer" }, {}) === null || scoreOdds(
  { cat: "utility", level: "entry", family: "iam", title: "IAM Analyst I", desc: "", yearsReq: null },
  { ...base, hasResume: false }) === null, true);
/* an operations role is not penalised for being one */
eq("an analyst role takes no build penalty", job({ family: "analyst", level: "entry",
  title: "Cybersecurity Analyst", desc: "splunk siem access reviews" }) > 0, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
