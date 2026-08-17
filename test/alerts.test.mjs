/* The rules engine. The behaviour that matters most is what it does NOT send. */
import { evaluate, defaultSettings, bundle } from "../server/alerts.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
const t = (o) => ({ id: o.id, date: o.date, amount: o.amount, kind: o.kind || "out", note: o.note || "", catId: o.catId, type: o.type });

const base = () => ({
  accounts: [{ id: "a1", name: "Checking", type: "Checking", balance: 2400 },
    { id: "a2", name: "Savings", type: "Savings / HYSA", balance: 1000 }],
  txns: [], cats: [], recurring: [],
  alerts: { settings: { ...defaultSettings(), on: true } },
});

/* 1. a long history must not avalanche on first enable */
{
  const d = base();
  for (let i = 0; i < 40; i++) d.txns.push(t({ id: "old" + i, date: ago(30 + i * 14), amount: 2000, kind: "in", note: "PAYROLL" }));
  for (let i = 0; i < 10; i++) d.txns.push(t({ id: "obig" + i, date: ago(20 + i * 20), amount: 900, note: "BIG THING" }));
  const { alerts, state } = evaluate(d, { silent: true });
  ck("enabling alerts sends nothing at all", alerts.length === 0, String(alerts.length));
  d.alerts = state;
  const second = evaluate(d);
  ck("and the run straight after is still silent", second.alerts.length === 0, String(second.alerts.length));
}

/* 2. genuinely new income and a large charge do fire, once */
{
  const d = base();
  d.txns.push(t({ id: "old1", date: ago(40), amount: 2000, kind: "in", note: "PAYROLL" }));
  d.alerts = evaluate(d, { silent: true }).state;
  d.txns.push(t({ id: "new1", date: ago(1), amount: 2180, kind: "in", note: "EMPLOYER PAYROLL" }));
  d.txns.push(t({ id: "new2", date: ago(1), amount: 640, note: "NEW LAPTOP" }));
  const r1 = evaluate(d);
  ck("new income fires", r1.alerts.some((a) => a.tag === "paid" && /2,180/.test(a.title)), r1.alerts.map((a) => a.title).join(" | "));
  ck("a large charge fires", r1.alerts.some((a) => a.tag === "big"), r1.alerts.map((a) => a.tag).join(","));
  d.alerts = r1.state;
  ck("the same rows never fire twice", evaluate(d).alerts.length === 0);
}

/* 3. transfers are not income, and never look like a paycheck */
{
  const d = base();
  d.alerts = evaluate(d, { silent: true }).state;
  d.txns.push(t({ id: "x1", date: ago(1), amount: 750, kind: "in", note: "CARD PAYMENT", type: "transfer" }));
  ck("a transfer in is not reported as money landing", evaluate(d).alerts.length === 0);
}

/* 4. low balance is a crossing, not a state */
{
  const d = base();
  d.alerts = evaluate(d, { silent: true }).state;
  d.accounts[0].balance = 100; d.accounts[1].balance = 0;    // 100 total, under the 300 line
  let r = evaluate(d); d.alerts = r.state;
  ck("dropping under the line fires once", r.alerts.filter((a) => a.tag === "low").length === 1);
  r = evaluate(d); d.alerts = r.state;
  ck("staying under it is silent", r.alerts.length === 0);
  r = evaluate(d); d.alerts = r.state;
  ck("still silent on the third run", r.alerts.length === 0);
  d.accounts[0].balance = 5000;                              // recovered
  r = evaluate(d); d.alerts = r.state;
  ck("recovering is not itself an alert", r.alerts.length === 0);
  d.accounts[0].balance = 50;                                // and under again
  r = evaluate(d); d.alerts = r.state;
  ck("a fresh crossing fires again", r.alerts.filter((a) => a.tag === "low").length === 1);
}

/* 5. a new subscription: three monthly charges at a stable amount */
{
  const d = base();
  d.alerts = evaluate(d, { silent: true }).state;
  d.txns.push(t({ id: "s1", date: ago(62), amount: 15.99, note: "STREAMBOX 8821" }));
  d.txns.push(t({ id: "s2", date: ago(31), amount: 15.99, note: "STREAMBOX 8821" }));
  let r = evaluate(d);
  ck("two charges is not yet a subscription", !r.alerts.some((a) => a.tag === "sub"));
  d.alerts = r.state;
  d.txns.push(t({ id: "s3", date: ago(1), amount: 15.99, note: "STREAMBOX 8821" }));
  r = evaluate(d);
  ck("the third monthly charge flags it", r.alerts.some((a) => a.tag === "sub" && /16\/mo/.test(a.title)),
    r.alerts.map((a) => a.title).join(" | "));
  d.alerts = r.state;
  ck("and it is not flagged again next month", evaluate(d).alerts.filter((a) => a.tag === "sub").length === 0);
}
{
  const d = base();
  d.alerts = evaluate(d, { silent: true }).state;
  /* groceries: monthly-ish but wildly different amounts, so not a subscription */
  d.txns.push(t({ id: "g1", date: ago(62), amount: 240, note: "KROGER" }));
  d.txns.push(t({ id: "g2", date: ago(31), amount: 95, note: "KROGER" }));
  d.txns.push(t({ id: "g3", date: ago(1), amount: 310, note: "KROGER" }));
  ck("variable spending at one merchant is not called a subscription",
    !evaluate(d).alerts.some((a) => a.tag === "sub"));
}

/* 6. budget overrun, once per category per month */
{
  const d = base();
  d.cats = [{ id: "cEat", name: "Eating out", limit: 100 }];
  d.alerts = evaluate(d, { silent: true }).state;
  d.txns.push(t({ id: "e1", date: new Date().toISOString().slice(0, 10), amount: 140, note: "DINNER", catId: "cEat" }));
  let r = evaluate(d);
  ck("going over a limit fires", r.alerts.some((a) => a.tag === "budget" && /Eating out/.test(a.title)));
  d.alerts = r.state;
  d.txns.push(t({ id: "e2", date: new Date().toISOString().slice(0, 10), amount: 40, note: "MORE", catId: "cEat" }));
  ck("going further over does not fire again", evaluate(d).alerts.filter((a) => a.tag === "budget").length === 0);
}

/* 7. respecting the off switch */
{
  const d = base();
  d.alerts = { settings: { ...defaultSettings(), on: true, paid: false, big: false } };
  d.alerts = evaluate(d, { silent: true }).state;
  d.txns.push(t({ id: "n9", date: ago(1), amount: 3000, kind: "in", note: "PAYROLL" }));
  d.txns.push(t({ id: "n8", date: ago(1), amount: 900, note: "BIG" }));
  ck("switched-off rules stay silent", evaluate(d).alerts.length === 0);
}

/* 8. many at once become one notification */
{
  const many = [{ title: "A", body: "", tag: "paid" }, { title: "B", body: "", tag: "big" },
    { title: "C", body: "", tag: "sub" }, { title: "D", body: "", tag: "low" }, { title: "E", body: "", tag: "bill" }];
  const one = bundle(many);
  ck("five alerts bundle into a single notification", /5 updates/.test(one.title), one.title);
  ck("and it names the first few", /A · B/.test(one.body), one.body);
  ck("a lone alert is shown as itself", bundle([many[0]]).title === "A");
}

/* 9. the sent list stays bounded */
{
  const d = base();
  for (let i = 0; i < 900; i++) d.txns.push(t({ id: "m" + i, date: ago(1), amount: 2000, kind: "in", note: "P" }));
  const { state } = evaluate(d, { silent: true });
  ck("the dedupe list is capped so the data file cannot grow forever", state.sent.length <= 400, String(state.sent.length));
}

console.log("\n" + pass + " passed, " + fail.length + " failed" + (fail.length ? ": " + fail.join(", ") : ""));
process.exit(fail.length ? 1 : 0);
