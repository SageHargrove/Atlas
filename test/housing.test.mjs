/* Housing maths. The number that decides a place is the all-in monthly cost,
   and the commute is what makes "cheaper rent" quietly more expensive. */
import { commute, totalMonthly, affordability, rank, score } from "../client/src/housingMath.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };

const works = [{ id: "w1", name: "Office" }];
const leg = (km, minutes = null, workId = "w1") => ({ workId, km, minutes, driving: minutes != null });

/* 1. no legs means no commute, not a zero commute pretending to be free */
{
  const c = commute({ legs: [] }, works);
  ck("no route yields null, not zero", c.miles === null && c.monthlyCost === null);
}

/* 2. a 10 km one-way, five days a week */
{
  const c = commute({ legs: [leg(10, 15)] }, works, { daysPerWeek: 5 });
  /* 10 km = 6.21 mi, x2 round trip, x 21.65 days */
  ck("miles per month is round trip times working days", Math.abs(c.miles - 269) <= 2, String(c.miles));
  ck("cost uses the all-in mileage rate", Math.abs(c.monthlyCost - Math.round(269 * 0.70)) <= 2, String(c.monthlyCost));
  ck("time is summed the same way", Math.abs(c.minutes - Math.round(15 * 2 * 21.65)) <= 3, String(c.minutes));
  ck("a routed leg is marked as driving", c.driving === true);
}

/* 3. a straight-line leg is honest about it */
{
  const c = commute({ legs: [leg(10, null)] }, works);
  ck("a leg without a router time is flagged, not faked", c.driving === false && c.minutes === null);
}

/* 4. two workplaces share the week rather than doubling it */
{
  const two = [{ id: "w1" }, { id: "w2" }];
  const one = commute({ legs: [leg(10, 15)] }, [two[0]], { daysPerWeek: 5 });
  const both = commute({ legs: [leg(10, 15, "w1"), leg(10, 15, "w2")] }, two, { daysPerWeek: 5 });
  ck("two equal workplaces cost the same as one, not twice", Math.abs(both.miles - one.miles) <= 2, both.miles + " vs " + one.miles);
}

/* 5. the cheaper rent can be the dearer place */
{
  const near = { id: "a", rent: 950, utilities: 120, legs: [leg(3, 6)] };
  const far = { id: "b", rent: 800, utilities: 120, legs: [leg(40, 45)] };
  const tn = totalMonthly(near, works), tf = totalMonthly(far, works);
  ck("all-in total includes rent, utilities and commute", tn.total === 950 + 120 + tn.commute);
  ck("the $150 cheaper rent costs MORE once the commute is in", tf.total > tn.total, tf.total + " vs " + tn.total);
  const r = rank([far, near], works, 4000);
  ck("and ranks second", r[0].id === "a", r.map((x) => x.id).join(","));
}

/* 6. affordability bands */
{
  ck("30% of take-home is comfortable", affordability(1200, 4000).band === "good");
  ck("35% is a stretch", affordability(1400, 4000).band === "stretch");
  ck("45% is high", affordability(1800, 4000).band === "high");
  ck("no take-home means no verdict, not a false one", affordability(1200, 0).band === "unknown" && affordability(1200, 0).pct === null);
}

/* 7. a competitive listing is penalised a little, never hidden */
{
  const a = { id: "a", rent: 1000, legs: [leg(5, 8)], difficulty: "hard" };
  const b = { id: "b", rent: 1000, legs: [leg(5, 8)], difficulty: "normal" };
  ck("competitive sorts below an identical normal listing", score(a, works, 4000) > score(b, works, 4000));
  ck("but only by a little", score(a, works, 4000) - score(b, works, 4000) < 100);
}

console.log("\n" + pass + " passed, " + fail.length + " failed" + (fail.length ? ": " + fail.join(", ") : ""));
process.exit(fail.length ? 1 : 0);
