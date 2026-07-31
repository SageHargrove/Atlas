/* "LA" used to match Dallas and "York" used to match New York, which silently
   mislabelled jobs as fitting a city you'd never move to.

   These import the real module rather than extracting source with string
   offsets — the extraction version broke the moment the code moved file, which
   is a test failing for a reason that has nothing to do with the behaviour.
   Run with: npm test */
import { cityMatch, DEFAULT_CITIES as C, partnerLabel } from "../client/src/careerData.js";

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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
