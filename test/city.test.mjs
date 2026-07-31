/* "LA" used to match Dallas and "York" used to match New York, which silently
   mislabelled jobs as fitting a city you'd never move to.

   These import the real module rather than extracting source with string
   offsets — the extraction version broke the moment the code moved file, which
   is a test failing for a reason that has nothing to do with the behaviour.
   Run with: npm test */
import { cityMatch, DEFAULT_CITIES as C, partnerLabel, parseWindow, compoundGap } from "../client/src/careerData.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log("  ok   " + label + " -> " + got); }
  else { fail++; console.log("  FAIL " + label + " -> " + got + " (wanted " + want + ")"); }
};
const city = (input, expected) => eq(JSON.stringify(input), cityMatch(input, C)?.name ?? null, expected);

console.log("city matching:");
city("LA", null);                 // used to match Dal-LA-s
city("York", null);               // used to match New York
city("a", null);
city("us", null);
city("Los Angeles", "Los Angeles");
city("San Antonio", "San Antonio");
city("Dallas", "Dallas");
city("dallas, tx", "Dallas");
city("Fort Worth", "Fort Worth");
city("New York", "New York");
city("Ruston", "Ruston");
city("Little Rock, AR", "Little Rock");
city("Nowhereville", null);
city("", null);
city(null, null);

/* The Habitat half: a city with no partner market must not silently read the
   same as one with a world-class institution. */
console.log("\npartner data:");
eq("every city has a partner rating", C.every((x) => Number.isInteger(x.partner)), true);
eq("every rated city names its employers", C.filter((x) => x.partner > 0).every((x) => (x.orgs || "").length > 3), true);
eq("Omaha is excellent", partnerLabel(cityMatch("Omaha", C).partner), "Excellent");
eq("Ruston has nothing", partnerLabel(cityMatch("Ruston", C).partner), "None");
eq("Omaha names Henry Doorly", /henry doorly/i.test(cityMatch("Omaha", C).orgs), true);
eq("no duplicate city names", new Set(C.map((x) => x.name.toLowerCase())).size, C.length);
eq("every city has a sane cost-of-living index", C.every((x) => x.col >= 70 && x.col <= 220), true);

/* Hiring windows drive the whole timeline — a window read wrong quietly files a
   target as "later" while its campus pipeline closes. */
console.log("\nhiring windows:");
const W = (s) => { const w = parseWindow(s, new Date("2026-07-31")); return w && (w.from == null ? "rolling" : w.from + ".." + w.to + (w.rolling ? "+r" : "")); };
const AUG26 = 2026 * 12 + 7;
eq("Aug–Oct 2026 + rolling", W("Aug–Oct 2026 + rolling"), AUG26 + ".." + (AUG26 + 2) + "+r");
eq("Jul–Sep 2026 rolling ASAP", W("Jul–Sep 2026 — rolling, apply ASAP"), (AUG26 - 1) + ".." + (AUG26 + 1) + "+r");
eq("Jan–Apr 2027", W("Jan–Apr 2027"), 2027 * 12 + 0 + ".." + (2027 * 12 + 3));
eq("single month", W("Aug 2026 — apply early"), AUG26 + ".." + AUG26);
eq("a wrapped window rolls the year", W("Nov–Feb 2026"), (2026 * 12 + 10) + ".." + (2026 * 12 + 13));
eq("bare rolling has no dates", W("rolling"), "rolling");
eq("no window at all", parseWindow(""), null);
eq("free text with no months", parseWindow("whenever they feel like it"), null);
eq("full month names work", W("August to October 2026"), AUG26 + ".." + (AUG26 + 2));

/* The starting-salary question: a gap compounds under percentage raises, but
   changing employer resets the base and outruns it. If this inverts, the advice
   the UI gives is backwards. */
console.log("\nstarting salary compounding:");
const stay = compoundGap(70000, 84000, 10);
const hop = compoundGap(70000, 84000, 10, 0.035, 3, 0.18);
eq("a lower start stays behind on internal raises alone", stay.a < stay.b, true);
eq("the gap widens in dollars rather than closing", (stay.b - stay.a) > 14000, true);
eq("job changes beat the higher start that never moves", hop.a > stay.b, true);
eq("no growth means no change", compoundGap(70000, 70000, 10, 0).a, 70000);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
