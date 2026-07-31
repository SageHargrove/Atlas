/* "LA" used to match Dallas and "York" used to match New York, which silently
   mislabelled jobs as fitting a city you'd never move to. These extract the real
   functions from the real source rather than a copy, so they fail if the source
   drifts. Run with: npm test */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "client", "src", "Career.jsx"), "utf8");
const cities = src.slice(src.indexOf("const DEFAULT_CITIES"), src.indexOf("/* [company, tier"));
const fn = src.slice(src.indexOf("function cityMatch"), src.indexOf("function computeFit"));
const cityMatch = new Function(cities + fn + "; return cityMatch;")();
const C = new Function(cities + "; return DEFAULT_CITIES;")();
let pass = 0, fail = 0;
const eq = (input, expected) => {
  const got = cityMatch(input, C)?.name ?? null;
  if (got === expected) { pass++; console.log("  ok   " + JSON.stringify(input) + " -> " + got); }
  else { fail++; console.log("  FAIL " + JSON.stringify(input) + " -> " + got + " (wanted " + expected + ")"); }
};
console.log("city matching:");
eq("LA", null);                 // used to match Dallas
eq("York", null);               // used to match New York
eq("a", null);
eq("us", null);
eq("Los Angeles", "Los Angeles");
eq("San Antonio", "San Antonio");
eq("Dallas", "Dallas");
eq("dallas, tx", "Dallas");
eq("Fort Worth", "Fort Worth");
eq("New York", "New York");
eq("Ruston", "Ruston");
eq("Little Rock, AR", "Little Rock");
eq("Nowhereville", null);
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
