/* The double-counting bug: a credit-card payment was logged as spending on the
   checking side AND as income on the card side, inflating both totals. These
   extract the real helpers from server/index.js — not a copy — and run real
   transaction descriptions through them, so the fix can't silently regress.
   Run with: npm test */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
const start = src.indexOf("const DEBT =");
const end = src.indexOf('app.post("/api/teller/sync"');
if (start === -1 || end === -1) { console.error("extraction markers not found"); process.exit(1); }
const chunk = src.slice(start, end);
const mod = new Function(chunk + "\nreturn { XFER_RE, classifyKind, markTransferPairs, normMerchant, buildMerchantMemory, autoCategorize };")();
const { classifyKind, markTransferPairs, buildMerchantMemory, autoCategorize } = mod;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---- classifyKind: the user's real July transactions ---- */
// checking outflows — real spending stays spending
eq("Five Guys", classifyKind(-18, "Checking", "Five Guys Ar 1115 Ecomm"), "out");
eq("Sq grill", classifyKind(-12, "Checking", "Sq *grill Pollo Restauran"), "out");
eq("McDonalds", classifyKind(-21, "Checking", "Mcdonalds 39092"), "out");
eq("Kroger", classifyKind(-38, "Checking", "Kroger #623"), "out");
eq("Cloudflare", classifyKind(-10, "Checking", "Cloudflare Cloudflare St-W8v6t5r8d5v3 Web I"), "out");
// Venmo stays real money per the user's call — NOT a transfer
eq("Venmo out", classifyKind(-750, "Checking", "Venmo Payment 1051804263561 Web Id: 3264681992"), "out");
eq("Venmo cashout in", classifyKind(13, "Checking", "Venmo Cashout Ppd Id: 5264681992"), "in");
// the double-counters
eq("CapOne transfer", classifyKind(-750, "Savings / HYSA", "Capital One Transfer Rt07981c4821e32 Web Id: 1510394779"), "xfer");
eq("To savings", classifyKind(-750, "Checking", "Online Transfer To Sav ...9532 Transaction#: Xx123"), "xfer");
eq("From checking", classifyKind(750, "Savings / HYSA", "Online Transfer From Chk ...4582 Transaction#: 456"), "xfer");
eq("CC payment credit", classifyKind(750, "Credit card", "Payment Thank You - Web"), "xfer");
eq("CC refund (inflow on card)", classifyKind(23.5, "Credit card", "AMAZON MKTPL REFUND"), "xfer");
eq("CC purchase", classifyKind(-59, "Credit card", "Whataburger 87"), "out");
eq("Autopay from chk", classifyKind(-120, "Checking", "CHASE CREDIT CRD AUTOPAY PPD"), "xfer");
eq("CapOne mobile pmt", classifyKind(-650, "Checking", "CAPITAL ONE MOBILE PMT AuthDate 20-Jul"), "xfer");
eq("Discover e-payment", classifyKind(-200, "Checking", "DISCOVER E-PAYMENT 1234"), "xfer");
// near-misses that must NOT be flagged
eq("Late payment fee", classifyKind(-35, "Credit card", "LATE PAYMENT FEE"), "out");
eq("Paycheck", classifyKind(1850, "Checking", "ACME CORP DIRECT DEP PAYROLL"), "in");
eq("Geico", classifyKind(-128, "Checking", "Geico Insurance (recurring)"), "out");

/* ---- the user's real missed CC-payment phrasings ---- */
eq("Payment to Chase card", classifyKind(-750, "Checking", "Payment to Chase card ending in 3356"), "xfer");
eq("CapOne billpay to Chase", classifyKind(-750, "Savings / HYSA", "JPMORGAN CHASE BANK, NA"), "xfer");
eq("Automatic payment thank you", classifyKind(-120, "Checking", "AUTOMATIC PAYMENT - THANK YOU"), "xfer");
eq("Payment to car loan", classifyKind(-300, "Checking", "Payment to Auto loan ending 8812"), "xfer");
// real bills that must STAY spending
eq("Optimum cable PMNT", classifyKind(-80, "Checking", "OPTIMUM 7703 CABLE PMNT PPD ID: 9077"), "out");
eq("Genesis gym", classifyKind(-47, "Checking", "GENESIS HC 102 MEMBERSHIP PPD ID: 88"), "out");
eq("Anthropic sub", classifyKind(-134, "Checking", "ANTHROPIC* CLAUDE SU ANTHROPIC.COM C"), "out");

/* ---- taxes: the $4,700 that was hiding in "Uncategorized" ---- */
const catsTax = [{ id: "tx", name: "Taxes" }, { id: "g", name: "Groceries" }];
eq("IRS -> Taxes", autoCategorize("IRS", catsTax, {}, 4700), "tx");
eq("IRS USATAXPYMT -> Taxes", autoCategorize("IRS USATAXPYMT 270394 PPD ID", catsTax, {}, 4700), "tx");
eq("Treasury -> Taxes", autoCategorize("US TREASURY TAX PMT", catsTax, {}, 500), "tx");
eq("TurboTax -> Taxes", autoCategorize("TURBOTAX FEE", catsTax, {}, 60), "tx");
eq("Irish pub not taxed", autoCategorize("IRISH PUB DOWNTOWN", catsTax, {}, 30), "");
eq("Kroger unaffected", autoCategorize("Kroger #623", catsTax, {}, 38), "g");

/* ---- pair matching: equal-and-opposite across accounts within 4 days ---- */
const txns = [
  { id: "a", tellerId: "sf:1", accountId: "chk", kind: "out", date: "2026-07-20", amount: 500, catId: "", note: "Withdrawal Xyz" },
  { id: "b", tellerId: "sf:2", accountId: "sav", kind: "in", date: "2026-07-21", amount: 500, catId: "", note: "Deposit Xyz" },
  { id: "c", tellerId: "sf:3", accountId: "chk", kind: "out", date: "2026-07-22", amount: 12, catId: "cat1", note: "Sq *coffee" }, // categorized — untouchable
  { id: "d", tellerId: "sf:4", accountId: "chk", kind: "in", date: "2026-06-01", amount: 500, catId: "", note: "Old deposit" },   // same acct as a? no — chk vs chk for a? a is chk out; d is chk in — same account, must not pair
  { id: "e", accountId: "chk", kind: "out", date: "2026-07-20", amount: 77, catId: "", note: "Manual entry" },                     // no tellerId — untouchable
];
const n = markTransferPairs(txns);
eq("pair count", n, 2);
eq("pair a", txns[0].kind, "xfer");
eq("pair b", txns[1].kind, "xfer");
eq("categorized untouched", txns[2].kind, "out");
eq("no same-acct/old pair", txns[3].kind, "in");
eq("manual untouched", txns[4].kind, "out");

/* ---- auto-categorization: rules + merchant memory ---- */
const cats = [
  { id: "g", name: "Groceries" }, { id: "e", name: "Eating out" }, { id: "t", name: "Transport" },
  { id: "s", name: "Subscriptions" }, { id: "sh", name: "Shopping" }, { id: "h", name: "Health" },
  { id: "r", name: "Rent" },
];
const mem = buildMerchantMemory([
  { kind: "out", catId: "h", note: "Sq *martha's Bon Appetit" }, // pretend user filed this under Health once
], cats);
eq("memory wins over rules", autoCategorize("Sq *martha's Bon Appetit", cats, mem), "h");
eq("Five Guys -> Eating out", autoCategorize("Five Guys Ar 1115 Ecomm", cats, {}), "e");
eq("Trader Joes -> Groceries", autoCategorize("Trader Joes #521", cats, {}), "g");
eq("Exxon -> Transport", autoCategorize("Exxon 220", cats, {}), "t");
eq("Crunchyroll -> Subs", autoCategorize("Crunchyroll Membership", cats, {}), "s");
eq("Target -> Shopping", autoCategorize("Target 2231", cats, {}), "sh");
eq("Whataburger -> Eating out", autoCategorize("Whataburger 87", cats, {}), "e");
eq("Small venmo stays blank", autoCategorize("Venmo Payment 105 Web Id", cats, {}, 24), "");
eq("Big venmo -> Rent", autoCategorize("VENMO PAYMENT 1051133499747 WEB ID:", cats, {}, 725), "r");
eq("Missing category skipped", autoCategorize("Kroger #623", cats.filter((c) => c.id !== "g"), {}), "");
// p2p never enters merchant memory — one venmo's category must not spread to the rest
const memP2p = buildMerchantMemory([{ kind: "out", catId: "e", note: "Venmo Payment 999 Web Id" }], cats);
eq("p2p excluded from memory", Object.keys(memP2p).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
