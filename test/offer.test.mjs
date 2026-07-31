/* What an offer is actually worth. Two errors are equally easy and both
   expensive: ignoring benefits, so a $75k consultancy looks like it beats a
   $67k utility job; and counting a pension you'll never vest in, which is the
   easiest way to talk yourself into staying somewhere too long. Run: npm test */
import { offerValue, baseToMatch, MARKET_PREMIUM } from "../client/src/careerData.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("  ok   " + label + " -> " + JSON.stringify(got)); }
  else { fail++; console.log("  FAIL " + label + ": got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want)); }
};
const near = (label, got, want, tol) => {
  if (Math.abs(got - want) <= tol) { pass++; console.log("  ok   " + label + " -> " + Math.round(got)); }
  else { fail++; console.log("  FAIL " + label + ": got " + Math.round(got) + ", wanted ~" + want); }
};

/* the real one: SPP IAM Analyst 1, Little Rock */
const SPP = { base: 67000, bonusPct: 10, matchPct: 4.75, pensionPct: 7, vestYears: 5,
  premiumPaid: 1200, ptoDays: 15, col: 86 };

console.log("the offer he actually has:");
const leave3 = offerValue({ ...SPP, stayYears: 3 });
const stay5 = offerValue({ ...SPP, stayYears: 5 });
near("base alone would say", 67000, 67000, 0);
near("worth this much all in, leaving at 3 years", leave3.total, 83571, 400);
near("and this much adjusted for Little Rock", leave3.adjusted, 97176, 500);
eq("the pension is excluded when you'd leave before vesting", leave3.vests, false);
near("...and it names what you'd forfeit", leave3.pensionForfeited, 4690, 50);
eq("staying long enough vests it", stay5.vests, true);
near("which is worth this much more", stay5.total - leave3.total, 4690, 50);

console.log("\nthe comparison that matters:");
/* the number to walk around with: what a competing base has to be */
const remote = baseToMatch(leave3.adjusted, { bonusPct: 5, matchPct: 4, col: 90, insurance: 2000 });
near("a remote offer must beat this base", remote, 78400, 800);
console.log("       (so $85k remote is a genuine upgrade, and $75k is a pay cut)");
eq("a higher cost of living demands a higher base",
  baseToMatch(leave3.adjusted, { bonusPct: 5, matchPct: 4, col: 140, insurance: 2000 }) > remote, true);
eq("better benefits demand a lower base",
  baseToMatch(leave3.adjusted, { bonusPct: 20, matchPct: 8, col: 90, insurance: 2000 }) < remote, true);

console.log("\nthe two errors this exists to prevent:");
/* a nominally higher base that is actually worse */
const consultancy = offerValue({ base: 75000, bonusPct: 5, matchPct: 4, premiumPaid: 3600, ptoDays: 15, col: 90 });
eq("a $75k consultancy does NOT beat the $67k utility job",
  consultancy.adjusted < leave3.adjusted, true);
console.log("       ($75k -> " + consultancy.adjusted + " adjusted vs SPP " + leave3.adjusted + ")");
const eightyFive = offerValue({ base: 85000, bonusPct: 5, matchPct: 4, premiumPaid: 3600, ptoDays: 15, col: 90 });
eq("but $85k does", eightyFive.adjusted > leave3.adjusted, true);

/* the first version took `comp` plus one lump `extrasPct`; a saved floor from
   then must not silently vanish, because it takes every "+$18k vs floor" with it */
console.log("\nthe older saved shape still works:");
const legacy = offerValue({ comp: 70000, extrasPct: 20, col: 86 });
eq("a legacy floor still values", legacy !== null, true);
near("...at base plus the lump", legacy.total, 84000, 400);
eq("...and it doesn't also credit insurance on top", legacy.insurance, 0);
eq("the new shape wins when both are present", offerValue({ base: 90000, comp: 1, col: 100 }).base, 90000);

console.log("\nedges:");
eq("no base, no number", offerValue({}), null);
eq("insurance better than market is worth the gap",
  Math.round(offerValue({ base: 100000, premiumPaid: 0, col: 100 }).insurance), MARKET_PREMIUM);
eq("insurance worse than market is never negative",
  offerValue({ base: 100000, premiumPaid: 99000, col: 100 }).insurance, 0);
eq("PTO below the norm costs you", offerValue({ base: 100000, ptoDays: 5, col: 100 }).ptoDelta < 0, true);
eq("a pension of zero can't be forfeited", offerValue({ base: 100000, pensionPct: 0, stayYears: 1, vestYears: 5, col: 100 }).pensionForfeited, 0);
eq("cost of living is applied, not ignored",
  offerValue({ base: 100000, col: 200, ptoDays: 10 }).adjusted, Math.round(offerValue({ base: 100000, col: 100, ptoDays: 10 }).total / 2));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
