/* The classifier decides what reaches the finder at all, so a mistake here is
   invisible — a job you never see looks identical to a job that doesn't exist.
   Every case below came from a real posting in an actual poll. Run: npm test */
import { classifyPosting, parseBoardUrl, careersUrl } from "../server/jobs.js";

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
                 "Recruiter, Security Engineering", "Security Marketing Manager"])
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
