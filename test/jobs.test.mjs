/* The classifier decides what reaches the finder at all, so a mistake here is
   invisible — a job you never see looks identical to a job that doesn't exist.
   Every case below came from a real posting in an actual poll. Run: npm test */
import { classifyPosting, parseBoardUrl, careersUrl, payFromText, familyOf } from "../server/jobs.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log("  FAIL " + label + ": got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want)); }
};
const c = (title, extra = {}) => classifyPosting({ title, location: "", desc: "", ...extra });

console.log("kept vs dropped:");
/* security roles survive */
for (const t of ["Security Engineer", "IAM Analyst", "Cybersecurity Specialist, Junior",
                 "Identity and Access Management Engineer", "SOC Analyst", "Threat Detection Engineer",
                 "Information Systems Security Officer", "GRC Analyst", "Penetration Tester"])
  eq("kept: " + t, !!c(t), true);

/* the sales org at a security company is not a security job — this was the
   single biggest source of noise in the first live poll */
for (const t of ["Enterprise Sales Executive, Security", "Solutions Engineer, Okta (Enterprise)",
                 "Technical Account Manager, Security", "Security Sales Engineer",
                 "Account Executive - Cyber", "Customer Success Manager, Security",
                 "Recruiter, Security Engineering", "Security Marketing Manager",
                 /* both leaked from a real production poll: \brecruit\b does not
                    match "Recruiter", and "Solutions Engineer" does not match
                    "Solutions Engineering" */
                 "Senior Manager, Solutions Engineering, Okta", "Solutions Architecture Lead, Security",
                 "Talent Acquisition Partner, Security"])
  eq("dropped: " + t, c(t), null);

/* not security at all */
for (const t of ["Staff Software Engineer, Payments", "Data Scientist", "Product Designer"])
  eq("dropped: " + t, c(t), null);

console.log("\nthe ladder:");
const lv = (t, extra) => c(t, extra)?.level;
eq("intern", lv("Security Engineering Intern"), "intern");
eq("intern beats a seniority word", lv("Cybersecurity Intern, Senior Platform Team"), "intern");
eq("new grad", lv("Cybersecurity Analyst: New Grad"), "entry");
eq("junior", lv("Cybersecurity Specialist, Junior"), "entry");
eq("associate", lv("Associate, Vulnerability Assessment"), "entry");
/* "Associate Principal" is a senior title that a naive /associate/ match
   promoted straight to entry level */
eq("associate principal is NOT entry", lv("Associate Principal, IGA Architect"), "principal");
eq("plain title is mid", lv("Cyber Security Engineer"), "mid");
eq("senior", lv("Senior Cyber Security Engineer"), "senior");
eq("sr.", lv("Sr. IAM Engineer"), "senior");
eq("lead", lv("Cybersecurity Lead"), "lead");
eq("manager is a lead", lv("Manager, Security Operations"), "lead");
eq("staff is principal", lv("Staff Platform Security Engineer"), "principal");
eq("principal", lv("Principal Security Researcher"), "principal");
eq("director", lv("Director, AI Security Specialist"), "executive");
eq("head of", lv("Head of Detection and Response"), "executive");
eq("senior director is executive", lv("Senior Director, Information Security"), "executive");
eq("years fill in when the title says nothing", lv("Security Engineer", { desc: "8+ years of experience" }), "principal");
eq("low years read as entry", lv("Security Analyst", { desc: "1-2 years of experience required" }), "entry");

/* A bare /\d+ years/ was fine against a 700-char snippet and became actively
   wrong once it read whole descriptions: it filed a $199k Stripe role as entry
   level off the phrase "in the last 2 years" buried in company boilerplate. */
console.log("\nyears must mean required experience:");
const yr = (d) => c("Security Engineer", { _full: d })?.yearsReq;
eq("plain requirement", yr("Requires 5+ years of experience in security"), 5);
eq("a range takes the floor", yr("3-5 years of relevant experience"), 3);
eq("qualifier words between", yr("7+ years of hands-on professional experience"), 7);
eq("reversed phrasing", yr("Experience: 6+ years"), 6);
eq("minimum phrasing", yr("Minimum of 4 years in an operational role"), 4);
eq("company boilerplate is NOT a requirement", yr("Stripe has grown enormously in the last 2 years."), null);
eq("a founding date is not a requirement", yr("For 15 years we have served customers"), null);
eq("an absurd figure is rejected", yr("40 years of experience"), null);
eq("nothing stated", yr("We value curiosity."), null);

/* Numbered bands, romans and digits alike. These were read inconsistently:
   roman II landed in senior while arabic 3 and 4 landed in mid, so
   "Security Engineer II" outranked "Information Security Analyst 4". */
console.log("\nnumbered bands:");
eq("Analyst I is entry", lv("IAM Analyst I"), "entry");
eq("Analyst 1 is entry", lv("IAM Analyst 1"), "entry");
eq("Level 1 is entry", lv("Cybersecurity Analyst, Level 1"), "entry");
eq("Tier 1 is entry", lv("SOC Analyst Tier 1"), "entry");
eq("Engineer I is entry", lv("Machine Learning Engineer I - Message Security"), "entry");
eq("Engineer II is MID, not senior", lv("Security Engineer II"), "mid");
eq("Analyst 2 is mid", lv("Threat Analyst 2"), "mid");
eq("SOC Analyst II is mid", lv("SOC Analyst II"), "mid");
eq("Engineer III is senior", lv("Cyber Security Engineer III"), "senior");
eq("Analyst 3 is SENIOR, not mid", lv("Threat Analyst 3"), "senior");
eq("Analyst 4 is SENIOR, not mid", lv("Information Security Analyst 4"), "senior");
eq("Engineer V is lead", lv("Security Engineer V"), "lead");
eq("an explicit word beats the number", lv("Senior Threat Analyst 1"), "senior");
eq("staff beats the number", lv("Staff Security Engineer II"), "principal");
/* a number that isn't a band must not be read as one */
eq("a product name is not a band", lv("Security Engineer, Auth0"), "mid");
eq("a year is not a band", lv("Security Analyst, 2027 Start"), "mid");

/* Stated vs defaulted. Most postings never state a band, and treating those as
   genuinely mid-level makes the entry market look 20x smaller than it is. */
console.log("\nstated vs defaulted level:");
const sure = (t, extra) => c(t, extra)?.levelSure;
eq("a band is a statement", sure("Security Engineer II"), true);
eq("a seniority word is a statement", sure("Senior Security Engineer"), true);
eq("an entry word is a statement", sure("Cybersecurity Analyst: New Grad"), true);
eq("intern is a statement", sure("Security Intern"), true);
eq("years in the body are a statement", sure("Security Engineer", { desc: "5+ years of experience required" }), true);
/* "5+ years required" without saying years of WHAT is genuinely ambiguous, and
   guessing there is what misfiled a $199k role as entry level */
eq("a bare years figure states nothing", sure("Security Engineer", { desc: "5+ years required" }), false);
eq("a bare title states nothing", sure("Cyber Security Engineer"), false);
eq("...and still defaults to mid", lv("Cyber Security Engineer"), "mid");

/* Pay-transparency laws put a real range in a large share of postings, but
   always in the LAST paragraph — truncating from the top threw all of them away.
   0 of 497 live postings had a parseable range before this. */
console.log("\npay extraction:");
const pay = (s) => { const p = payFromText(s); return p && p.comp; };
eq("plain range", pay("The salary range for this role is $120,000 - $150,000."), 135000);
eq("K notation", pay("Base salary: $120K–$150K USD"), 135000);
eq("'to' as the separator", pay("Compensation of $95,000 to $115,000 annually"), 105000);
eq("hourly is annualised", pay("Pay range: $45.00 - $55.00 per hour"), 104000);
eq("the widest band wins across geo tiers", pay("Salary: Zone A $100,000 - $110,000; Zone B $90,000 - $140,000"), 115000);
/* things that look like money but are not this job's salary */
eq("equity grant ignored", pay("We raised $50,000,000 - $80,000,000 in Series C"), null);
eq("a single number is not a range", pay("Salary is competitive, around $130,000"), null);
eq("no pay context, no match", pay("Save clients $100,000 - $200,000 per year in licensing"), null);
eq("nothing at all", pay(""), null);

/* When the title says nothing, the body and the pay usually do. Reported as
   inferred, never as stated. */
console.log("\nlevel inference for unlabelled roles:");
const inf = (desc, extra, cat) => {
  const r = classifyPosting({ title: "Cyber Security Engineer", location: "", desc: "", _full: desc, ...extra }, cat);
  return r && r.level + "/" + r.levelBasis;
};
/* a years-of-experience figure is a statement, not an inference, so scope has to
   be tested on text that doesn't also state years */
eq("years in the body count as stated", inf("Requires 0-2 years of experience."), "entry/stated");
eq("scope language reads low", inf("No prior experience needed; training provided for recent graduates."), "entry/scope");
eq("mentoring reads high", inf("You will mentor engineers and set the technical strategy for the org."), "lead/scope");
eq("pay reads the band", inf("The salary range for this role is $95,000 - $105,000."), "mid/pay");
eq("low pay reads entry", inf("Base salary $70,000 - $80,000 per year."), "entry/pay");
eq("high pay reads senior", inf("Salary range $150,000 - $175,000 annually."), "senior/pay");
/* The same $162k midpoint is senior money at a utility and roughly new-grad
   money at a quant shop. Without the category scale, every quant posting would
   read as senior and drown out the roles he could actually get. */
eq("$162k reads senior at default rates", inf("Salary range $150,000 - $175,000 annually."), "senior/pay");
eq("...but only mid once quant pay is normalised", inf("Salary range $150,000 - $175,000 annually.", {}, "quant"), "mid/pay");
eq("...and lead at utility rates", inf("Salary range $150,000 - $175,000 annually.", {}, "utility"), "lead/pay");
eq("nothing to go on stays unknown", inf("We are a great place to work."), "mid/null");
eq("a stated title is never overridden", (() => { const r = c("Senior Security Engineer", { _full: "Base salary $70,000 - $80,000." }); return r.level + "/" + r.levelBasis; })(), "senior/stated");
eq("the full text never reaches the cache", c("Security Engineer", { _full: "x".repeat(50) })._full, undefined);

console.log("\nflags:");
const f = (title, extra) => c(title, extra);
eq("remote from location", f("Security Engineer", { location: "Remote - USA" }).remote, true);
eq("remote from the Ashby flag", f("Security Engineer", { remoteHint: true }).remote, true);
eq("onsite is not remote", f("Security Engineer", { location: "Reston, VA" }).remote, false);
eq("US from a state code", f("Security Engineer", { location: "Austin, TX, US" }).us, true);
eq("US from the word", f("Security Engineer", { location: "United States" }).us, true);
eq("India is not US", f("Security Engineer", { location: "Bengaluru, India" }).us, false);
eq("Ireland is not US", f("Security Engineer", { location: "Dublin, Ireland" }).us, false);
/* being wrong here costs a glance; hiding a real job costs the job */
eq("unknown location is assumed reachable", f("Security Engineer", { location: "" }).us, true);
eq("clearance detected", f("ISSO", { desc: "Requires an active TS/SCI with polygraph" }).clearance, true);
eq("no clearance by default", f("Security Engineer").clearance, false);
eq("IAM flagged", f("Identity Engineer").iam, true);
eq("SOC work is not IAM", f("SOC Analyst").iam, false);

/* "Security" covers a dozen jobs that share almost nothing day to day. Without
   this, 500 rows of mixed SOC, GRC, appsec and identity work is a wall. */
console.log("\nrole families:");
const fam = (t, d) => familyOf(t, d || "");
eq("IAM engineer", fam("Identity and Access Management Engineer"), "iam");
eq("SailPoint work is IAM", fam("SailPoint Developer"), "iam");
eq("a cloud IAM role is IAM, not cloud", fam("Cloud IAM Engineer, AWS"), "iam");
eq("SOC analyst", fam("SOC Analyst"), "soc");
eq("detection engineering", fam("Detection and Response Engineer"), "soc");
eq("threat intel", fam("Threat Intelligence Analyst"), "soc");
eq("GRC", fam("GRC Analyst"), "grc");
eq("ISSO is GRC", fam("Information System Security Officer"), "grc");
eq("compliance", fam("Compliance Analyst, FedRAMP"), "grc");
eq("product security is appsec", fam("Product Security Engineer"), "appsec");
eq("devsecops is appsec", fam("DevSecOps Engineer"), "appsec");
eq("pentest is offensive", fam("Penetration Tester"), "offsec");
eq("red team is offensive", fam("Red Team Operator"), "offsec");
/* a vulnerability ASSESSMENT is offensive work; vulnerability MANAGEMENT is not,
   and the ordering has to keep them apart */
eq("vulnerability assessment is offensive", fam("Associate, Vulnerability Assessment"), "offsec");
eq("cloud security", fam("Cloud Security Engineer"), "cloud");
eq("a bare security engineer is engineering", fam("Security Engineer"), "eng");
eq("the title beats the body", fam("GRC Analyst", "You will use Splunk and hunt threats daily"), "grc");
eq("the body is the fallback", fam("Cyber Specialist", "Own our SailPoint IGA platform and access reviews"), "iam");
eq("nothing matches", fam("Cyber Specialist"), "other");

console.log("\nboard URLs:");
eq("greenhouse", parseBoardUrl("https://boards.greenhouse.io/guidepointsecurity"), { kind: "greenhouse", token: "guidepointsecurity" });
eq("greenhouse job-boards host", parseBoardUrl("https://job-boards.greenhouse.io/okta/jobs/123"), { kind: "greenhouse", token: "okta" });
eq("lever with a job id", parseBoardUrl("https://jobs.lever.co/saviynt/abc-123"), { kind: "lever", token: "saviynt" });
eq("ashby", parseBoardUrl("https://jobs.ashbyhq.com/snowflake"), { kind: "ashby", token: "snowflake" });
eq("workday keeps tenant, pod and site", parseBoardUrl("https://entergy.wd1.myworkdayjobs.com/en-US/Entergy"),
  { kind: "workday", tenant: "entergy", wd: "wd1", site: "Entergy" });
eq("workday on a different pod", parseBoardUrl("https://leidos.wd5.myworkdayjobs.com/External"),
  { kind: "workday", tenant: "leidos", wd: "wd5", site: "External" });
/* anything that isn't a board Atlas can read must be refused, not guessed at */
for (const u of ["https://www.linkedin.com/jobs/view/123", "https://indeed.com/q-security", "javascript:alert(1)",
                 "file:///etc/passwd", "", "not a url", "https://example.com/careers"])
  eq("rejected: " + JSON.stringify(u).slice(0, 40), parseBoardUrl(u), null);

eq("careers link for greenhouse", careersUrl({ kind: "greenhouse", token: "okta" }), "https://job-boards.greenhouse.io/okta");
eq("careers link for workday", careersUrl({ kind: "workday", tenant: "leidos", wd: "wd5", site: "External" }),
  "https://leidos.wd5.myworkdayjobs.com/en-US/External");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
