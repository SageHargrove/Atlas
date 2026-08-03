import React, { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { detectIncome, dailyBurn, forecast } from "./forecast.js";
import Why from "./Why.jsx";

/* ------------------------------------------------------------------
   The next 60 days, one balance point per day.

   "Is it safe to spend $400 right now?" is a timing question, and a
   monthly budget structurally cannot answer it — the month can be fine
   while the 14th is a disaster. This walks liquid cash forward through
   the bills on their real days, paydays projected from your own
   deposit history, and a daily burn for everything else.

   It projects, it does not promise: every input is listed in the ?
   box, income that stopped arriving is not projected forward, and the
   headline is the MINIMUM the balance touches, not where it ends.
------------------------------------------------------------------ */

const money = (n) => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString());

export default function Forecast({ d }) {
  const [open, setOpen] = useState(false);

  const m = useMemo(() => {
    const liquid = (d.accounts || [])
      .filter((a) => a.type === "Checking" || a.type === "Savings / HYSA")
      .reduce((s, a) => s + (Number(a.balance) || 0), 0);
    const income = detectIncome(d.txns);
    const burn = dailyBurn(d.txns, d.recurring);
    const r = forecast({ startBalance: liquid, recurring: d.recurring || [], income, burn, days: 60 });
    return { liquid, income, burn, ...r };
  }, [d.accounts, d.txns, d.recurring]);

  const danger = m.underDate != null;
  const tight = !danger && m.min.bal < 200;
  const color = danger ? "var(--down)" : tight ? "var(--gold)" : "var(--up)";
  const chart = m.points.map((p) => ({ date: p.date.slice(5), bal: p.bal }));

  return (
    <div className="card">
      <button className="foldhead" onClick={() => setOpen((v) => !v)}>
        <span className="row" style={{ gap: 10, alignItems: "baseline", minWidth: 0, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Next 60 days</h3>
          <span className="note" style={{ margin: 0, fontSize: 12 }}>
            {danger ? <>goes <b style={{ color }}>under on {m.underDate.slice(5)}</b> as things stand</>
              : <>lowest point <b className="mono" style={{ color }}>{money(m.min.bal)}</b> on {m.min.date.slice(5)}</>}
          </span>
          <Why label="Next 60 days"
            rows={[{ k: "Liquid now (checking + savings)", v: money(m.liquid) },
              ...m.income.map((i) => ({ k: "Income: " + i.name.slice(0, 26), v: money(i.amount) + " every ~" + Math.round(i.cadence) + "d" })),
              { k: "Scheduled bills", v: (d.recurring || []).length + " from your Recurring list" },
              { k: "Variable burn", v: money(m.burn) + "/day" }]}
            rule="Cash walked forward a day at a time: bills subtract on their due day, paydays are projected from the rhythm of your own past deposits, and the burn covers everything not on the bills list — median month minus those bills, spread over its days."
            excludes="Income that has stopped arriving (a payroll two cycles overdue is a job that ended, not a projection), the month in progress when computing the burn, and anything you have never told Atlas about."
            result={danger ? "under $0 on " + m.underDate : "minimum " + money(m.min.bal) + " on " + m.min.date}
            caveat="A projection of habits, not a promise — one unusual purchase moves every date after it." />
        </span>
        <span className="note" style={{ margin: 0 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 170 }}>
            <ResponsiveContainer>
              <AreaChart data={chart} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="fcast" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--faint)" }} interval={13} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "var(--faint)" }} width={52} axisLine={false} tickLine={false}
                  tickFormatter={(v) => "$" + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v))} />
                <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, fontSize: 12 }}
                  formatter={(v) => [money(v), "projected"]} />
                <ReferenceLine y={0} stroke="var(--down)" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="bal" stroke={color} strokeWidth={2} fill="url(#fcast)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* the three days that matter, in words */}
          <div className="note" style={{ marginTop: 6 }}>
            {m.points.filter((p) => p.events.length).slice(0, 6).map((p) =>
              p.date.slice(5) + ": " + p.events.map((e) => (e.amt > 0 ? "+" : "") + money(e.amt).replace("-$", "-$") + " " + String(e.name).slice(0, 18)).join(", ")
            ).join(" · ") || "No scheduled bills or detected paydays in the window — the line is burn only."}
          </div>
          {danger && (
            <div className="note bad" style={{ marginTop: 6 }}>
              As things stand you'd go under on <b>{m.underDate}</b>. That's a timing problem, not necessarily a money
              problem — moving a bill's due date past the nearest payday is often the whole fix.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
