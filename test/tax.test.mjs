/* Tax math. Wrong here costs real money in both directions, so the anchor case
   is the one that prompted it: ~$20k of untaxed Handshake contractor work
   against ~$10k actually paid to the IRS. Run: npm test */
import { estimateTax, suggestSources, bracketTax, FILING } from "../client/src/taxMath.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("  ok   " + label + " -> " + JSON.stringify(got)); }
  else { fail++; console.log("  FAIL " + label + ": got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want)); }
};
const near = (label, got, want, tol) => {
  if (Math.abs(got - want) <= tol) { pass++; console.log("  ok   " + label + " -> " + Math.round(got)); }
  else { fail++; console.log("  FAIL " + label + ": got " + Math.round(got) + ", wanted ~" + want + " (±" + tol + ")"); }
};

console.log("the case this was built for — $20k contractor, nothing withheld:");
const r = estimateTax({ se: 20000, filing: "single" });
/* 15.3% of 92.35% of 20,000 = 2,826.51 — a fixed statutory rate, so this is the
   one number here that is exact rather than projected */
near("self-employment tax", r.seTax, 2827, 2);
near("half of it comes off income first", r.seDeduction, 1413, 2);
/* 20,000 - 1,413 - 16,100 standard deduction = 2,487 taxable, all in the 10% band */
near("taxable income after deductions", r.taxable, 2487, 5);
near("federal income tax", r.incomeTax, 249, 5);
near("total federal liability", r.totalTax, 3076, 10);
eq("no withholding on 1099 income", r.withheld, 0);
near("so this is what would actually be owed", r.balance, 3076, 10);
eq("and it crosses the $1,000 quarterly threshold", r.needsQuarterly, true);
/* the finding: ~$10k paid against ~$3.1k owed */
near("paying $10,000 overshoots by about this much", 10000 - r.totalTax, 6924, 20);

console.log("\nset-aside guidance:");
/* next dollar: 10% marginal + 15.3%*0.9235 SE = ~24.1%, plus a 10% buffer */
near("hold back this share of the next untaxed dollar", r.setAside * 100, 26.6, 1.5);
eq("never recommends an absurd share", estimateTax({ se: 900000 }).setAside <= 0.6, true);

console.log("\nmixed W-2 and contractor income:");
const m = estimateTax({ w2: 45000, w2Withheld: 4200, se: 20000, filing: "single" });
eq("W-2 withholding is credited", m.withheld, 4200);
near("SE tax still applies to the contractor half", m.seTax, 2827, 2);
eq("the W-2 job pushes the contractor income into a higher band", m.marginal > r.marginal, true);
eq("owing less than $1,000 means no quarterlies", estimateTax({ w2: 45000, w2Withheld: 9000, se: 2000 }).needsQuarterly, false);

console.log("\nedges:");
eq("no income, no tax", estimateTax({}).totalTax, 0);
eq("income under the standard deduction is untaxed", estimateTax({ w2: 9000, filing: "single" }).incomeTax, 0);
eq("over-withholding shows as a refund", estimateTax({ w2: 40000, w2Withheld: 9000 }).balance < 0, true);
eq("expenses reduce self-employment income", estimateTax({ se: 20000, seExpenses: 5000 }).netSE, 15000);
eq("negative expenses cannot inflate income", estimateTax({ se: 20000, seExpenses: 30000 }).netSE, 0);
/* Social Security stops at the wage base; Medicare does not */
eq("SE Social Security is capped at the wage base",
  Math.round(estimateTax({ se: 300000 }).seSS) === Math.round(184500 * 0.124), true);
eq("W-2 wages consume the wage base first", estimateTax({ w2: 184500, se: 20000 }).seSS, 0);
eq("additional Medicare kicks in over the threshold", estimateTax({ w2: 250000 }).addlMedicare > 0, true);
eq("married brackets are wider", estimateTax({ w2: 120000, filing: "mfj" }).incomeTax < estimateTax({ w2: 120000, filing: "single" }).incomeTax, true);
eq("a custom deduction is respected", estimateTax({ w2: 50000, deduction: 0 }).taxable, 50000);

console.log("\nbracket arithmetic:");
const B = FILING.single.brackets;
eq("zero", Math.round(bracketTax(0, B)), 0);
eq("first band only", Math.round(bracketTax(10000, B)), 1000);
eq("spans two bands", Math.round(bracketTax(20000, B)), Math.round(12400 * 0.1 + 7600 * 0.12));

console.log("\nsuggesting sources from transactions:");
const txns = [
  { kind: "in", date: "2026-01-15", amount: 1800, note: "SPP PAYROLL DES:PPD ID:12345" },
  { kind: "in", date: "2026-02-15", amount: 1800, note: "SPP PAYROLL DES:PPD ID:12345" },
  { kind: "in", date: "2026-03-10", amount: 5000, note: "HANDSHAKE AI CONTRACTOR PAYMENT" },
  { kind: "in", date: "2026-04-10", amount: 5000, note: "HANDSHAKE AI CONTRACTOR PAYMENT" },
  { kind: "in", date: "2026-05-01", amount: 40, note: "Venmo from mom" },
  { kind: "in", date: "2026-05-02", amount: 900, note: "IRS TAX REFUND" },
  { kind: "in", date: "2025-06-01", amount: 9000, note: "SPP PAYROLL DES:PPD ID:12345" },
  { kind: "out", date: "2026-03-01", amount: 750, note: "Rent" },
];
const s = suggestSources(txns, 2026);
eq("only this year's income becomes a source", s.length, 2);
eq("payroll is recognised as already taxed", s.find((x) => /spp/i.test(x.label))?.type, "w2");
eq("a contractor platform is recognised as untaxed", s.find((x) => /handshake/i.test(x.label))?.type, "se");
eq("repeat deposits are summed, not listed separately", s.find((x) => /handshake/i.test(x.label))?.amount, 10000);
eq("trailing bank junk doesn't split one employer", s.find((x) => /spp/i.test(x.label))?.amount, 3600);
eq("a refund is not income", s.some((x) => /refund/i.test(x.label)), false);
eq("a $40 one-off is not an income source", s.some((x) => /venmo/i.test(x.label)), false);
eq("spending is never income", s.some((x) => /rent/i.test(x.label)), false);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
