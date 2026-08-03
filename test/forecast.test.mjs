import { detectIncome, dailyBurn, forecast } from "../client/src/forecast.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  console.log("  " + (cond ? "ok  " : "FAIL") + " " + name + (detail != null ? " -> " + JSON.stringify(detail) : ""));
  cond ? pass++ : fail++;
};

const TODAY = new Date("2026-08-03T12:00:00Z");

console.log("detecting recurring income:");
{
  const txns = [];
  for (const d of ["2026-05-15", "2026-06-15", "2026-07-15"]) txns.push({ kind: "in", date: d, amount: 1705, note: "SOUTHWEST POWER PAYROLL" });
  for (const d of ["2026-06-06", "2026-06-20", "2026-07-04", "2026-07-18"]) txns.push({ kind: "in", date: d, amount: 820, note: "GDH CONTRACT" });
  txns.push({ kind: "in", date: "2026-07-20", amount: 13, note: "VENMO CASHOUT" });   // one-off
  txns.push({ kind: "in", date: "2026-01-10", amount: 900, note: "OLD JOB LLC" });
  txns.push({ kind: "in", date: "2026-02-10", amount: 900, note: "OLD JOB LLC" });    // stopped months ago
  const inc = detectIncome(txns, TODAY);
  ok("finds the monthly payroll", inc.some((i) => /southwest/i.test(i.name) && i.amount === 1705));
  ok("finds the biweekly contract at 14-day cadence", inc.some((i) => /gdh/i.test(i.name) && i.cadence === 14));
  ok("a one-off deposit is not income", !inc.some((i) => /venmo/i.test(i.name)));
  ok("a payroll that STOPPED is not projected forward", !inc.some((i) => /old job/i.test(i.name)));
}

console.log("daily burn:");
{
  const txns = [];
  for (const m of ["2026-05", "2026-06", "2026-07"]) {
    txns.push({ kind: "out", date: m + "-03", amount: 750, note: "rent+car" });
    txns.push({ kind: "out", date: m + "-10", amount: 500, note: "everything else" });
  }
  txns.push({ kind: "out", date: "2026-08-01", amount: 9999, note: "partial month must not count" });
  const burn = dailyBurn(txns, [{ amount: 750, freq: "m" }], TODAY);
  ok("burn is (median month - scheduled bills) / 30.44", Math.abs(burn - 500 / 30.44) < 0.01, Math.round(burn * 100) / 100);
  ok("bills on the recurring list are not double-counted", burn < 20);
}

console.log("the walk:");
{
  const r = forecast({
    startBalance: 1000,
    recurring: [{ name: "rent", amount: 750, freq: "m", day: 15 }],
    income: [{ name: "payroll", amount: 1705, cadence: 30.44, last: Date.parse("2026-07-20") }],
    burn: 18, days: 60, today: TODAY,   // enough to dip under before the Aug 19 payday
  });
  ok("one point per day plus today", r.points.length === 61, r.points.length);
  const rentDay = r.points.find((p) => p.date === "2026-08-15");
  ok("rent lands on its day", rentDay && rentDay.events.some((e) => e.name === "rent" && e.amt === -750));
  const rescued = r.points[r.points.length-1].bal > r.min.bal; const payday = r.points.find((p) => p.events.some((e) => e.name === "payroll"));
  ok("the next payday is projected (~Aug 19-20)", payday && payday.date >= "2026-08-18" && payday.date <= "2026-08-21", payday?.date);
  ok("the minimum is identified", r.min.bal <= Math.min(...r.points.map((p) => p.bal)) + 0.01, r.min);
  ok("this scenario dips under zero and says WHEN", r.underDate !== null, r.underDate);
}
{
  const r = forecast({ startBalance: 5000, recurring: [], income: [], burn: 10, days: 60, today: TODAY });
  ok("a healthy balance never goes under", r.underDate === null);
  ok("burn-only decline is monotonic", r.points.every((p, i) => i === 0 || p.bal <= r.points[i - 1].bal + 0.01));
}
{
  /* a bill on the 31st must still fire in a 30-day month, on its last day */
  const r = forecast({ startBalance: 500, recurring: [{ name: "x", amount: 100, freq: "m", day: 31 }], income: [], burn: 0, days: 70, today: TODAY });
  const sep = r.points.find((p) => p.date === "2026-09-30");
  ok("a day-31 bill fires on Sep 30 in September", sep && sep.events.length === 1, sep?.date);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
