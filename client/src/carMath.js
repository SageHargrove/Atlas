/* Car maths and the reliability table, kept pure so it can be tested.

   Honest scope: this cannot read Autotrader, Cars.com or Marketplace, which
   block scraping and say so. What it CAN do is take the listings you paste and
   rank them the way a careful buyer would, with your priorities weighing in
   visibly rather than silently. */

/* Coarse brand reliability tiers. This is a built-in table reflecting the
   broad, stable consensus of the big reliability surveys over the last decade,
   not live data, and it is deliberately coarse because per-model, per-year
   reliability is exactly the thing you should look up for the specific car in
   front of you. Tier 1 is best. */
export const RELIABILITY = {
  toyota: 1, lexus: 1, honda: 1, acura: 1, mazda: 1,
  subaru: 2, hyundai: 2, kia: 2, genesis: 2, buick: 2,
  nissan: 3, infiniti: 3, ford: 3, chevrolet: 3, gmc: 3, ram: 3, volkswagen: 3, volvo: 3,
  tesla: 3, lincoln: 3, mitsubishi: 3,
  dodge: 4, jeep: 4, chrysler: 4, audi: 4, bmw: 4, "mercedes-benz": 4, mercedes: 4, mini: 4,
  rivian: 4, cadillac: 4,
  "land rover": 5, jaguar: 5, "alfa romeo": 5,
};
export const TIER_LABEL = { 1: "Excellent", 2: "Good", 3: "Average", 4: "Below average", 5: "Poor" };

/* Where a listing comes from says a lot about what you can trust and what
   recourse you have. A franchise dealer has a reputation, financing, and often
   a limited warranty; a marketplace stranger has none of those, which is why
   the same car is cheaper there. */
export const SELLERS = [
  ["cpo", "Certified pre-owned", 1.1, "manufacturer-backed inspection and warranty"],
  ["franchise", "Franchise dealer", 1.0, "brand dealer: inspected, warranty options, recourse"],
  ["independent", "Independent dealer", 0.85, "used lot: some recourse, check reviews"],
  ["private", "Private party", 0.7, "cheaper, no recourse: get a pre-purchase inspection"],
  ["marketplace", "Facebook / Craigslist", 0.55, "highest risk: meet safely, inspect, verify the title"],
];
export const sellerTrust = (k) => (SELLERS.find((s) => s[0] === k) || SELLERS[2])[2];

export const brandKey = (make) => String(make || "").trim().toLowerCase();
export const tierFor = (make) => RELIABILITY[brandKey(make)] || 3;

/* Max sticker price a monthly budget supports, given rate and term and a down
   payment. Same amortisation as the loan card. */
export function maxPrice({ monthly, aprPct, months, down = 0 }) {
  const r = Number(aprPct) / 100 / 12, n = Number(months), m = Number(monthly);
  if (!(m > 0) || !(n > 0)) return Number(down) || 0;
  const principal = Math.abs(r) < 1e-9 ? m * n : (m * (1 - Math.pow(1 + r, -n))) / r;
  return Math.round(principal + (Number(down) || 0));
}

/* Score 0-100, higher is better. Every component is returned so the card can
   show WHY rather than just a number. Priorities add weight; they never hide
   anything, because the point of a preference is to notice the exception. */
export function score(car, prefs, budget) {
  const price = Number(car.price) || 0;
  const miles = Number(car.mileage) || 0;
  const nowY = new Date().getFullYear();
  const age = Math.max(0, nowY - (Number(car.year) || nowY));
  const tier = tierFor(car.make);
  const parts = {};

  /* price against budget: under is better, at budget is fine, over falls fast */
  const cap = Number(budget?.maxPrice) || 0;
  if (cap > 0 && price > 0) {
    const ratio = price / cap;
    parts.price = ratio <= 0.8 ? 25 : ratio <= 1 ? 25 - (ratio - 0.8) * 50 : Math.max(0, 15 - (ratio - 1) * 100);
  } else parts.price = 12;
  parts.price = Math.round(parts.price);

  /* mileage: full marks under 30k, nothing at 150k+ */
  parts.mileage = Math.round(Math.max(0, Math.min(25, 25 - ((miles - 30000) / 120000) * 25)));
  /* age: gentle, cars age slower than they mile */
  parts.age = Math.round(Math.max(0, 15 - age * 1.5));
  /* reliability: 20 for tier 1 down to 0 for tier 5 */
  parts.reliability = 20 - (tier - 1) * 5;
  /* seller trust */
  parts.seller = Math.round(sellerTrust(car.seller) * 15);

  const mk = brandKey(car.make), md = String(car.model || "").trim().toLowerCase();
  const brandHit = (prefs?.brands || []).map(brandKey).includes(mk);
  const modelHit = !!md && (prefs?.models || []).map((x) => String(x).trim().toLowerCase()).includes(md);
  parts.priority = (brandHit ? 6 : 0) + (modelHit ? 8 : 0);

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.max(0, Math.min(100, Math.round(total))), parts, tier, brandHit, modelHit, age };
}

export function rank(cars, prefs, budget) {
  return [...cars].map((c) => ({ ...c, _s: score(c, prefs, budget) })).sort((a, b) => b._s.total - a._s.total);
}

/* When to think about replacing what you drive now. This is a read, not a
   verdict: it says where in the typical service life you are, in years and
   miles, at the pace you actually drive. */
export function replacement({ year, mileage, milesPerYear = 12000, make }) {
  const tier = tierFor(make);
  /* typical trouble-free service life by tier, in miles; conservative */
  const life = { 1: 200000, 2: 180000, 3: 160000, 4: 140000, 5: 120000 }[tier];
  const now = new Date().getFullYear();
  const age = Math.max(0, now - (Number(year) || now));
  const mi = Math.max(0, Number(mileage) || 0);
  const perYear = Math.max(1000, Number(milesPerYear) || 12000);
  const milesLeft = Math.max(0, life - mi);
  const yearsLeft = Math.round((milesLeft / perYear) * 10) / 10;
  const pctUsed = Math.min(100, Math.round((mi / life) * 100));
  let read;
  if (pctUsed < 35) read = "Early life. Nothing to plan for yet. Keep up with maintenance and this decision is years away.";
  else if (pctUsed < 65) read = "Mid life. Start a replacement fund now, so the decision is yours and not a tow truck's.";
  else if (pctUsed < 85) read = "Late life. Big repairs start to cost more than the car is worth around here. Get quotes before committing to any.";
  else read = "End of typical life. Plan the replacement on your timeline, before a breakdown picks the timing for you.";
  return { tier, life, age, pctUsed, milesLeft, yearsLeft, targetYear: now + Math.floor(yearsLeft), read };
}
