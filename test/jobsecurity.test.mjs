/* A board a user types is spliced into request hostnames by the poller, so it
   must be validated before it can shape a URL. These are the inputs that made
   it an SSRF: a metadata IP hidden in a tenant, a path in a token. */
import { sanitizeBoard } from "../server/jobs.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };

ck("a clean workday board passes", !!sanitizeBoard({ company: "Boeing", kind: "workday", tenant: "boeing", wd: "wd1", site: "External" }));
ck("a clean token board passes", !!sanitizeBoard({ company: "Acme", kind: "greenhouse", token: "acme" }));
ck("a metadata IP in tenant is refused", sanitizeBoard({ company: "x", kind: "workday", tenant: "169.254.169.254/latest/meta-data/?a=", wd: "wd1", site: "External" }) === null);
ck("a path in a token is refused", sanitizeBoard({ company: "x", kind: "recruitee", token: "internal.corp/admin?x=" }) === null);
ck("a slash in a token is refused", sanitizeBoard({ company: "x", kind: "lever", token: "a/b" }) === null);
ck("an @ in a tenant is refused", sanitizeBoard({ company: "x", kind: "workday", tenant: "evil@host", wd: "wd1", site: "s" }) === null);
ck("a bad wd is refused", sanitizeBoard({ company: "x", kind: "workday", tenant: "acme", wd: "wdX", site: "s" }) === null);
ck("a bad site is refused", sanitizeBoard({ company: "x", kind: "workday", tenant: "acme", wd: "wd1", site: "a b/c" }) === null);
ck("an unknown kind is refused", sanitizeBoard({ company: "x", kind: "sneaky", token: "acme" }) === null);
ck("a missing company is refused", sanitizeBoard({ kind: "greenhouse", token: "acme" }) === null);
ck("a non-object is refused", sanitizeBoard(null) === null && sanitizeBoard("nope") === null);
ck("only whitelisted fields survive", (() => { const b = sanitizeBoard({ company: "Acme", kind: "greenhouse", token: "acme", evil: "x" }); return b && b.evil === undefined; })());
ck("a bad category falls back, not through", sanitizeBoard({ company: "Acme", kind: "greenhouse", token: "acme", cat: "../etc" }).cat === "other");

console.log(pass + " passed, " + fail.length + " failed");
if (fail.length) process.exit(1);
