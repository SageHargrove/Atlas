/* Years of experience read off a resume's own date ranges. This decides whether
   a "3+ years" posting is a real option or a waste of an afternoon, so getting
   it wrong is expensive in both directions. Run: npm test */
import { yearsFromResume } from "../client/src/careerData.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("  ok   " + label + " -> " + got); }
  else { fail++; console.log("  FAIL " + label + ": got " + got + ", wanted " + want); }
};

console.log("counting professional experience:");
eq("nothing at all", yearsFromResume(""), 0);
eq("one four-month internship", yearsFromResume("IAM Analyst Intern | SPP   May 2026 – Aug. 2026"), 0.3);
/* three summers is not three years */
eq("three summers is not three years", yearsFromResume(
  "Intern A  May 2024 – Aug. 2024\nIntern B  May 2025 – Aug. 2025\nIntern C  May 2026 – Aug. 2026"), 0.8);
eq("a full year reads as one", yearsFromResume("Analyst  Jan. 2024 – Jan. 2025"), 1);
eq("two full years", yearsFromResume("Engineer  Jun. 2022 – Jun. 2024"), 2);

/* the real resume: two summer internships plus a term-time campus role */
console.log("\nthe actual resume:");
const REAL = `IAM Analyst Intern | Southwest Power Pool (SPP)   May 2026 – Aug. 2026
ServiceNow Software Developer Intern | GDIT   June 2025 – Aug. 2025
SOC Analyst | Louisiana Tech University   Jan. 2025 – May 2025
Louisiana Tech University — B.S. Cyber Engineering   Sept. 2023 – May 2027`;
const real = yearsFromResume(REAL);
eq("reads under a year of professional time", real > 0 && real < 1.2, true);
console.log("       (" + real + " years — three stints totalling about eleven months)");
/* the degree is four years and must never be counted as work */
eq("the degree span is excluded", real < 3, true);

console.log("\nedges:");
eq("overlapping stints are not additive", yearsFromResume(
  "Role A  Jan. 2024 – Dec. 2024\nRole B  Mar. 2024 – Sep. 2024"), 0.9);
eq("adjacent stints do add up", yearsFromResume(
  "Role A  Jan. 2023 – Jan. 2024\nRole B  Feb. 2024 – Feb. 2025"), 2);
eq("'present' counts to today", yearsFromResume("Engineer  Jan. 2026 – Present") > 0, true);
eq("a bare year with no range is ignored", yearsFromResume("Certified in 2024"), 0);
eq("a backwards range is ignored", yearsFromResume("Role  Jan. 2025 – Jan. 2024"), 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
