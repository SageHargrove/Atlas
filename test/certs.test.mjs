/* The cert shelf's arithmetic: dates that surface before they bite, money that
   adds up, and the odds integration that must never invent a cert. */
import { CERT_CATALOG, catalogByCode, certAgenda, certCosts, expiryOf, sortCerts, withCerts } from "../client/src/certs.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };

/* catalog integrity — a row with a broken keyword silently breaks the odds tie-in */
ck("every catalog row has code, name, cost and keyword",
  CERT_CATALOG.every((c) => c.code && c.name && Number.isFinite(c.cost) && c.keyword));
ck("codes are unique", new Set(CERT_CATALOG.map((c) => c.code)).size === CERT_CATALOG.length);
ck("lookup is case-insensitive", catalogByCode("sc-300")?.code === "SC-300");
ck("unknown codes come back null, not throw", catalogByCode("XX-999") === null);

/* expiry */
ck("explicit expiry wins over the derived one",
  expiryOf({ code: "SEC+", status: "passed", passedDate: "2025-01-10", expiresDate: "2026-02-01" }) === "2026-02-01");
ck("a pass derives expiry from the catalog validity",
  expiryOf({ code: "SEC+", status: "passed", passedDate: "2025-01-10" }) === "2028-01-10");
ck("a cert that never expires has no expiry", expiryOf({ code: "OSCP", status: "passed", passedDate: "2025-01-10" }) === null);
ck("a planned cert has no expiry", expiryOf({ code: "SEC+", status: "planned" }) === null);

/* agenda */
const T = "2026-08-29";
{
  const items = certAgenda([
    { code: "SC-300", status: "scheduled", examDate: "2026-09-05" },
    { code: "SEC+", status: "passed", passedDate: "2023-09-15" },        // expires 2026-09-15: 17 days out
    { code: "CISSP", status: "passed", passedDate: "2026-01-01" },       // renewal years away
    { code: "AZ-104", status: "scheduled", examDate: "2026-08-20" },     // date slipped past
  ], T);
  ck("an upcoming exam surfaces with a day count", items.some((i) => i.kind === "exam" && i.days === 7), JSON.stringify(items.map(i => [i.kind, i.days])));
  ck("a renewal inside 90 days surfaces", items.some((i) => i.kind === "renewal" && i.days === 17));
  ck("a renewal years out stays quiet", !items.some((i) => i.label === "CISSP"));
  ck("a slipped exam date asks for an update", items.some((i) => i.kind === "exam-passed?"));
  ck("soonest first", items[0].days <= items[items.length - 1].days);
}
ck("no certs is an empty agenda, not a crash", certAgenda([], T).length === 0 && certAgenda(undefined, T).length === 0);

/* costs */
{
  const { spent, planned } = certCosts([
    { code: "SEC+", status: "passed" },                 // catalog default 404
    { code: "SC-300", status: "studying", cost: 82 },   // voucher override
    { code: "CISSP", status: "planned" },               // 749
  ]);
  ck("passed exams count as spent at the catalog price", spent === 404, String(spent));
  ck("overridden cost beats the catalog", planned === 82 + 749, String(planned));
}

/* the odds tie-in */
ck("held certs are appended to the scoring resume",
  withCerts("worked on IAM", [{ code: "SC-300", status: "passed" }]).includes("sc-300"));
ck("studying is not holding", withCerts("r", [{ code: "SC-300", status: "studying" }]) === "r");
ck("no certs leaves the resume byte-identical", withCerts("exact text", []) === "exact text");
ck("a custom cert falls back to its own name",
  withCerts("r", [{ code: "Okta Pro", status: "passed" }]).includes("Okta Pro"));

/* ordering */
{
  const order = sortCerts([
    { code: "A", name: "A", status: "passed", passedDate: "2025-01-01" },
    { code: "B", name: "B", status: "scheduled", examDate: "2026-09-01" },
    { code: "C", name: "C", status: "studying" },
  ]).map((c) => c.code);
  ck("action first, trophies after", order.join("") === "BCA", order.join(""));
}

console.log(pass + " passed, " + fail.length + " failed");
if (fail.length) process.exit(1);
