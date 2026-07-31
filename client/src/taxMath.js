/* ------------------------------------------------------------------
   Tax estimation for someone with mixed income.

   The case this exists for: $20k of Handshake contractor work with nothing
   withheld, alongside a W-2 internship that withholds normally. Those two
   behave completely differently and the difference is expensive in both
   directions — under-set-aside means a April surprise, over-paying means an
   interest-free loan to the IRS for a year.

   Deliberately conservative where it's uncertain, and it shows its
   arithmetic rather than producing one number, because a tax figure you
   can't check is a tax figure you can't act on.

   NOT tax advice, and the bracket table below is a projection — the IRS
   publishes the real 2026 figures in late 2025 and they move with inflation.
   Everything here is overridable for that reason.
------------------------------------------------------------------ */

export const TAX_YEAR = 2026;

/* Projected 2026 figures. Wrong by a little is fine — these move the answer by
   tens of dollars, while the self-employment tax below moves it by thousands
   and is a fixed statutory rate. */
export const FILING = {
  single: {
    label: "Single",
    deduction: 16100,
    brackets: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
  },
  mfj: {
    label: "Married filing jointly",
    deduction: 32200,
    brackets: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
  },
  hoh: {
    label: "Head of household",
    deduction: 24150,
    brackets: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
  },
};

/* Social Security stops at the wage base; Medicare never does. */
const SS_WAGE_BASE = 184500;
const SS_RATE = 0.124;
const MEDICARE_RATE = 0.029;
const ADDL_MEDICARE_RATE = 0.009;
const ADDL_MEDICARE_THRESHOLD = { single: 200000, mfj: 250000, hoh: 200000 };
/* Only 92.35% of net self-employment earnings are subject to SE tax — the
   employer-half equivalent is excluded first. */
const SE_BASE = 0.9235;

export function bracketTax(taxable, brackets) {
  let owed = 0, last = 0;
  for (const [ceiling, rate] of brackets) {
    if (taxable <= last) break;
    owed += (Math.min(taxable, ceiling) - last) * rate;
    last = ceiling;
  }
  return owed;
}

/* The marginal rate matters more than the total for the set-aside question:
   the next 1099 dollar is taxed at this rate plus SE tax. */
export function marginalRate(taxable, brackets) {
  for (const [ceiling, rate] of brackets) if (taxable < ceiling) return rate;
  return brackets[brackets.length - 1][1];
}

export function estimateTax({
  w2 = 0, w2Withheld = 0, se = 0, seExpenses = 0, other = 0,
  filing = "single", deduction = null, extraWithheld = 0, buffer = 0.1,
} = {}) {
  const f = FILING[filing] || FILING.single;
  const std = deduction == null ? f.deduction : Number(deduction) || 0;

  const netSE = Math.max(0, Number(se) - Number(seExpenses));
  const seBase = netSE * SE_BASE;
  /* W-2 wages already consumed part of the Social Security wage base */
  const ssRoom = Math.max(0, SS_WAGE_BASE - Number(w2));
  const seSS = Math.min(seBase, ssRoom) * SS_RATE;
  const seMedicare = seBase * MEDICARE_RATE;
  const seTax = seSS + seMedicare;
  /* Half of SE tax comes off income before the brackets are applied */
  const seDeduction = seTax / 2;

  const gross = Number(w2) + netSE + Number(other);
  const agi = Math.max(0, gross - seDeduction);
  const taxable = Math.max(0, agi - std);
  const incomeTax = bracketTax(taxable, f.brackets);

  const addlThreshold = ADDL_MEDICARE_THRESHOLD[filing] ?? 200000;
  const addlMedicare = Math.max(0, (Number(w2) + seBase) - addlThreshold) * ADDL_MEDICARE_RATE;

  const totalTax = incomeTax + seTax + addlMedicare;
  const withheld = Number(w2Withheld) + Number(extraWithheld);
  const balance = totalTax - withheld;   // positive = you owe, negative = refund

  /* What to hold back from the NEXT untaxed dollar: marginal income tax plus
     the full SE rate on it, then a buffer because being short costs a penalty
     and being over just delays your own money. */
  const marginal = marginalRate(taxable, f.brackets);
  const seMarginal = (Number(w2) + seBase < SS_WAGE_BASE ? SS_RATE + MEDICARE_RATE : MEDICARE_RATE) * SE_BASE;
  const setAside = Math.min(0.6, (marginal + seMarginal) * (1 + Number(buffer)));

  return {
    gross, netSE, seTax, seSS, seMedicare, seDeduction, addlMedicare,
    agi, deduction: std, taxable, incomeTax, totalTax, withheld, balance,
    effectiveRate: gross > 0 ? totalTax / gross : 0,
    marginal, setAside,
    /* Quarterly estimated payments are due if you'll owe $1,000+ at filing.
       That threshold is the actual rule, not a rule of thumb. */
    needsQuarterly: balance >= 1000,
  };
}

/* Income transactions grouped into plausible sources, so the estimator opens
   pre-filled instead of blank. Guesses the type from the description — payroll
   language means withholding already happened; contractor platforms don't
   withhold anything — and every guess is meant to be corrected. */
const W2_HINTS = /\b(payroll|salary|direct dep|dir dep|paycheck|wages|adp\b|paychex|gusto|workday|ukg|kronos|trinet|justworks)\b/i;
const SE_HINTS = /\b(handshake|upwork|fiverr|contractor|contract|1099|freelanc|consult|stripe|paypal|venmo|zelle|patreon|substack|etsy|shopify|doordash|uber|lyft|instacart|rover|taskrabbit)\b/i;
const NOT_INCOME = /\b(refund|reimburse|transfer|cashback|cash back|rebate|interest|dividend|return|reversal|zelle from|venmo from)\b/i;

export function suggestSources(txns, year = new Date().getFullYear()) {
  const by = {};
  for (const t of txns || []) {
    if (t.kind !== "in") continue;
    if (String(t.date || "").slice(0, 4) !== String(year)) continue;
    const note = String(t.note || "").trim();
    if (!note || NOT_INCOME.test(note)) continue;
    /* Normalise the trailing junk banks append so one employer isn't five rows */
    const key = note.toLowerCase()
      .replace(/\b\d{4,}\b/g, " ").replace(/\b(ppd|des|id|indn|co)\b/gi, " ")
      .replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
    if (!key) continue;
    (by[key] ||= { key, label: note.slice(0, 40), amount: 0, n: 0 });
    by[key].amount += Number(t.amount) || 0;
    by[key].n++;
  }
  return Object.values(by)
    .filter((s) => s.amount >= 200)     // one-off odd deposits aren't an income source
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((s) => ({
      ...s,
      amount: Math.round(s.amount * 100) / 100,
      /* Payroll language is the strong signal; a contractor platform is the
         other. Anything else is left for you to say, because guessing wrong
         here is the difference between a refund and a penalty. */
      type: W2_HINTS.test(s.label) ? "w2" : SE_HINTS.test(s.label) ? "se" : "unknown",
    }));
}
