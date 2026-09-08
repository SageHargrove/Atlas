/* Car maths. Priorities must add weight without hiding anything, the seller
   must matter, and the replacement read must be a read rather than a verdict. */
import { score, rank, maxPrice, replacement, tierFor, sellerTrust } from "../client/src/carMath.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };
const Y = new Date().getFullYear();

/* 1. a monthly budget becomes a sticker price the same way the loan card would */
{
  const p = maxPrice({ monthly: 350, aprPct: 6.99, months: 60, down: 2000 });
  ck("$350/mo at 6.99% over 60 months plus $2,000 down is about $19.7k", Math.abs(p - 19680) < 60, String(p));
  ck("zero rate is simple multiplication", maxPrice({ monthly: 300, aprPct: 0, months: 48, down: 0 }) === 14400);
  ck("no payment means only the down payment", maxPrice({ monthly: 0, aprPct: 5, months: 60, down: 1500 }) === 1500);
}

/* 2. priorities add weight and never hide */
{
  const prefs = { brands: ["Toyota"], models: ["Corolla"] };
  const budget = { maxPrice: 20000 };
  const corolla = { year: Y - 3, make: "Toyota", model: "Corolla", mileage: 40000, price: 18000, seller: "franchise" };
  const civic = { year: Y - 3, make: "Honda", model: "Civic", mileage: 40000, price: 18000, seller: "franchise" };
  const sc = score(corolla, prefs, budget), sh = score(civic, prefs, budget);
  ck("a preferred brand and model is marked", sc.brandHit && sc.modelHit);
  ck("and scores higher than an otherwise identical car", sc.total > sh.total, sc.total + " vs " + sh.total);
  ck("the non-preferred car is still scored, not dropped", sh.total > 60, String(sh.total));
  ck("the bonus is bounded", sc.total - sh.total <= 14, String(sc.total - sh.total));
  ck("matching is case-insensitive", score({ ...corolla, make: "TOYOTA", model: "corolla" }, prefs, budget).modelHit);
}

/* 3. the seller matters, and marketplace is the riskiest */
{
  const base = { year: Y - 4, make: "Honda", model: "Accord", mileage: 60000, price: 15000 };
  const dealer = score({ ...base, seller: "franchise" }, {}, { maxPrice: 20000 }).total;
  const fb = score({ ...base, seller: "marketplace" }, {}, { maxPrice: 20000 }).total;
  ck("the same car from a marketplace stranger scores lower", fb < dealer, fb + " vs " + dealer);
  ck("certified pre-owned is trusted most", sellerTrust("cpo") > sellerTrust("franchise") && sellerTrust("franchise") > sellerTrust("private"));
  ck("an unknown seller key falls back to the middle, not to the top", sellerTrust("???") === sellerTrust("independent"));
}

/* 4. over budget falls fast, under budget is rewarded */
{
  const prefs = {};
  const mk = (price) => score({ year: Y - 2, make: "Mazda", model: "3", mileage: 20000, price, seller: "franchise" }, prefs, { maxPrice: 20000 });
  ck("well under budget gets full price marks", mk(15000).parts.price === 25);
  ck("exactly at budget is still fine", mk(20000).parts.price >= 14);
  ck("20% over budget is nearly worthless on price", mk(24000).parts.price <= 2, String(mk(24000).parts.price));
}

/* 5. reliability tiers */
{
  ck("Toyota is tier 1", tierFor("Toyota") === 1);
  ck("an unknown make is average, not best or worst", tierFor("Zorblax") === 3);
  const t = score({ year: Y - 3, make: "Toyota", mileage: 40000, price: 18000, seller: "franchise" }, {}, { maxPrice: 20000 });
  const j = score({ year: Y - 3, make: "Jeep", mileage: 40000, price: 18000, seller: "franchise" }, {}, { maxPrice: 20000 });
  ck("a tier 1 brand outscores a tier 4 brand, all else equal", t.total > j.total, t.total + " vs " + j.total);
}

/* 6. ranking */
{
  const cars = [
    { id: "old", year: Y - 12, make: "Ford", model: "Focus", mileage: 140000, price: 6000, seller: "marketplace" },
    { id: "good", year: Y - 3, make: "Toyota", model: "Corolla", mileage: 35000, price: 18500, seller: "cpo" },
    { id: "over", year: Y - 1, make: "Lexus", model: "IS", mileage: 12000, price: 34000, seller: "franchise" },
  ];
  const r = rank(cars, { brands: ["Toyota"] }, { maxPrice: 20000 });
  ck("the sensible car ranks first", r[0].id === "good", r.map((x) => x.id).join(","));
  ck("the over-budget one is still in the list", r.some((x) => x.id === "over"));
}

/* 7. replacement is a read, at the pace you actually drive */
{
  const early = replacement({ year: Y - 3, mileage: 41000, milesPerYear: 12000, make: "Hyundai" });
  ck("a 3-year-old car at 41k is early life", early.pctUsed < 35 && /Early life/.test(early.read), early.pctUsed + "%");
  ck("it projects a year, not just a mileage", early.targetYear > Y + 5, String(early.targetYear));
  const late = replacement({ year: Y - 11, mileage: 165000, milesPerYear: 10000, make: "Toyota" });
  ck("a Toyota at 165k is late life, not end of life", late.pctUsed >= 65 && late.pctUsed < 85 && /Late life/.test(late.read), late.pctUsed + "%");
  const done = replacement({ year: Y - 14, mileage: 150000, milesPerYear: 8000, make: "Jeep" });
  ck("a tier 4 brand at 150k is at the end of typical life", done.pctUsed >= 85, done.pctUsed + "%");
  ck("driving less stretches the years left", replacement({ year: Y - 3, mileage: 41000, milesPerYear: 6000, make: "Hyundai" }).yearsLeft
    > early.yearsLeft);
}

console.log("\n" + pass + " passed, " + fail.length + " failed" + (fail.length ? ": " + fail.join(", ") : ""));
process.exit(fail.length ? 1 : 0);
