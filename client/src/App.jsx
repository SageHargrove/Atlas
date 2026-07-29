import React, { useState, useEffect, useMemo, useRef } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

/* ------------------------------------------------------ */
/*  Finance HQ — net worth · budget · goals · projections  */
/* ------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
/* local-date string — toISOString() is UTC and flips the date near midnight for anyone not on UTC */
const dstr = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const today = () => dstr(new Date());
const thisMonth = () => today().slice(0, 7);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m) => { const [y, mm] = m.split("-").map(Number); return MONTH_NAMES[mm - 1] + " " + y; };

const ASSET_TYPES = ["Checking", "Savings / HYSA", "401k", "IRA / Roth", "Brokerage", "Crypto", "Real estate / Home", "Other asset"];
const DEBT_TYPES = ["Credit card", "Auto loan", "Student loan", "Mortgage", "Other debt"];
const LIQUID = ["Checking", "Savings / HYSA"];
const INVESTED = ["401k", "IRA / Roth", "Brokerage", "Crypto"];

const DEFAULTS = {
  accounts: [
    { id: uid(), name: "Checking", type: "Checking", balance: 0 },
    { id: uid(), name: "Savings", type: "Savings / HYSA", balance: 0 },
  ],
  history: [],
  cats: [
    { id: uid(), name: "Rent", limit: 0 },
    { id: uid(), name: "Groceries", limit: 0 },
    { id: uid(), name: "Eating out", limit: 0 },
    { id: uid(), name: "Transport", limit: 0 },
    { id: uid(), name: "Subscriptions", limit: 0 },
    { id: uid(), name: "Fun", limit: 0 },
  ],
  txns: [],
  goals: [],
  recurring: [],
  purchases: [],
  invest: { holdings: [], watch: [] },
  settings: { theme: "dark", incomeMonthly: 0, efMonths: 6, expReturn: 7 },
};

function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.some((c) => c !== "")) rows.push(row);
        row = [];
      } else cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.some((c) => c !== "")) rows.push(row); }
  return rows;
}

function normDate(s) {
  s = (s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    return y + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
  }
  const d = new Date(s);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

/* Detect columns in a bank CSV (works with Chase, Capital One, Fidelity exports) and return spend candidates */
function bankRows(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find("transaction date", "posting date", "posted date", "date");
  const iDesc = find("description", "payee", "merchant", "name", "memo");
  const iDebit = find("debit");
  const iCredit = find("credit");
  const iAmt = head.findIndex((h) => h === "amount" || (h.includes("amount") && !h.includes("debit") && !h.includes("credit")));
  if (iDate === -1 || iDesc === -1 || (iDebit === -1 && iAmt === -1)) return [];
  return rows.slice(1).map((r) => {
    let spend = 0, credit = false;
    if (iDebit !== -1) {
      spend = Number(String(r[iDebit] || "").replace(/[$,]/g, "")) || 0;
      credit = !spend && iCredit !== -1 && !!Number(String(r[iCredit] || "").replace(/[$,]/g, ""));
    } else {
      const v = Number(String(r[iAmt] || "").replace(/[$,]/g, ""));
      if (isNaN(v)) return null;
      if (v < 0) spend = -v; else { credit = true; spend = v; }
    }
    return { date: normDate(r[iDate]), desc: (r[iDesc] || "").trim(), amount: Math.round(spend * 100) / 100, credit };
  }).filter((x) => x && x.date && x.amount > 0);
}

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("["), o = clean.indexOf("{");
  let start = -1, end = -1;
  if (a !== -1 && (o === -1 || a < o)) { start = a; end = clean.lastIndexOf("]"); }
  else if (o !== -1) { start = o; end = clean.lastIndexOf("}"); }
  if (start === -1 || end === -1) throw new Error("No JSON found");
  return JSON.parse(clean.slice(start, end + 1));
}

const fmt = (n) =>
  n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString();
const fmt2 = (n) =>
  n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => (Math.abs(n) >= 1000 ? "$" + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : "$" + Math.round(n));
const pct = (n) => (isNaN(n) || !isFinite(n) ? "—" : Math.round(n) + "%");

const isDebt = (a) => DEBT_TYPES.includes(a.type);
const sumAssets = (accs) => accs.filter((a) => !isDebt(a)).reduce((s, a) => s + (Number(a.balance) || 0), 0);
const sumDebts = (accs) => accs.filter(isDebt).reduce((s, a) => s + (Number(a.balance) || 0), 0);
const liquid = (accs) => accs.filter((a) => LIQUID.includes(a.type)).reduce((s, a) => s + (Number(a.balance) || 0), 0);
const netWorth = (accs = []) => {
  const assets = sumAssets(accs), debts = sumDebts(accs);
  return { assets, debts, nw: assets - debts };
};

/* average monthly spend over up to the last 3 months that have transactions */
function avgMonthlySpend(txns) {
  const byMonth = {};
  txns.filter((t) => t.kind !== "in").forEach((t) => {
    const m = (t.date || "").slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + (Number(t.amount) || 0);
  });
  const months = Object.keys(byMonth).sort().slice(-3);
  if (!months.length) return 0;
  return months.reduce((s, m) => s + byMonth[m], 0) / months.length;
}

/* future value of monthly contributions */
function fv(monthly, years, annualPct) {
  const r = annualPct / 100 / 12, n = years * 12;
  if (r === 0) return monthly * n;
  return monthly * ((Math.pow(1 + r, n) - 1) / r);
}
function fvSeries(monthly, years, annualPct, startBalance = 0) {
  const out = []; const r = annualPct / 100 / 12;
  let bal = startBalance;
  for (let y = 0; y <= years; y++) {
    out.push({ year: "Y" + y, value: Math.round(bal) });
    for (let m = 0; m < 12; m++) bal = bal * (1 + r) + monthly;
  }
  return out;
}

async function callClaude(prompt, useSearch) {
  const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, search: !!useSearch }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.text || "";
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Spline+Sans:wght@400;500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap');
.fh * { box-sizing:border-box; margin:0; }
.fh { min-height:100vh; font-family:'Spline Sans',system-ui,sans-serif; color:var(--text); padding-bottom:90px; font-size:15px; line-height:1.5;
  background:
    radial-gradient(1100px 480px at 18% -8%, var(--glow1), transparent 60%),
    radial-gradient(900px 460px at 92% -4%, var(--glow2), transparent 55%),
    var(--bg); }
.fh[data-theme="dark"]{ color-scheme:dark;
  --bg:#070b14; --panel:#0e1524; --panel2:#141d31; --line:#1b2740; --line2:#2b3c5c;
  --text:#e8eef7; --muted:#8b9bb4; --faint:#5d6d87;
  --acc:#3987e5; --acc-soft:rgba(57,135,229,.14); --acc-ink:#ffffff;
  --up:#3ddba0; --up-soft:rgba(61,219,160,.11);
  --red:#ef7d7d; --red-soft:rgba(239,125,125,.11);
  --gold:#e0b154; --gold-soft:rgba(224,177,84,.12);
  --blue:#3987e5; --blue-soft:rgba(57,135,229,.14);
  --glow1:rgba(42,120,214,.09); --glow2:rgba(52,211,153,.05);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767;
  --shadow:0 12px 34px rgba(2,6,16,.5); }
.fh[data-theme="light"]{ color-scheme:light;
  --bg:#f2f5f9; --panel:#ffffff; --panel2:#f6f8fc; --line:#e2e8f1; --line2:#c6d2e2;
  --text:#101827; --muted:#526176; --faint:#8794a8;
  --acc:#2a78d6; --acc-soft:rgba(42,120,214,.1); --acc-ink:#ffffff;
  --up:#0f8a5f; --up-soft:rgba(15,138,95,.09);
  --red:#c94747; --red-soft:rgba(201,71,71,.08);
  --gold:#8a6a12; --gold-soft:rgba(138,106,18,.1);
  --blue:#2a78d6; --blue-soft:rgba(42,120,214,.1);
  --glow1:rgba(42,120,214,.06); --glow2:rgba(15,138,95,.04);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --shadow:0 10px 28px rgba(22,34,47,.13); }
.fh .wrap{ max-width:1240px; margin:0 auto; padding:0 24px; }
.fh header{ position:sticky; top:0; z-index:40; background:color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-bottom:1px solid var(--line); }
.fh .hrow{ display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; padding:12px 0; }
.fh .brand{ display:flex; align-items:center; gap:10px; }
.fh h1{ font-family:'Sora',sans-serif; font-weight:700; font-size:20px; letter-spacing:-.02em; }
.fh .sub{ color:var(--muted); font-size:13px; margin-top:2px; }
.fh .tabs{ display:flex; gap:2px; background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:3px; overflow-x:auto; max-width:100%; }
.fh .tab{ font:inherit; font-weight:500; background:none; border:none; border-radius:9px; color:var(--muted); padding:7px 15px; cursor:pointer; font-size:13.5px; white-space:nowrap; transition:color .15s, background .15s; }
.fh .tab:hover{ color:var(--text); }
.fh .tab.on{ background:var(--panel); color:var(--text); font-weight:600; box-shadow:0 1px 8px rgba(2,6,16,.35); }
.fh .btn{ font:inherit; font-weight:500; cursor:pointer; border-radius:10px; border:1px solid var(--line2); background:var(--panel2); color:var(--text); padding:8px 14px; transition:border-color .15s, transform .12s, filter .15s; }
.fh .btn:hover{ border-color:var(--muted); }
.fh .btn:active{ transform:translateY(1px); }
.fh .btn.primary{ background:linear-gradient(135deg, var(--acc), color-mix(in srgb, var(--acc) 72%, #34d399)); border-color:transparent; color:var(--acc-ink); font-weight:600; }
.fh .btn.primary:hover{ filter:brightness(1.08); }
.fh .btn.danger{ color:var(--red); border-color:var(--red); background:transparent; }
.fh .btn.small{ padding:4px 11px; font-size:12.5px; border-radius:8px; }
.fh .btn:disabled{ opacity:.5; cursor:default; }
.fh button:focus-visible, .fh .in:focus-visible, .fh a:focus-visible{ outline:2px solid var(--acc); outline-offset:2px; }
.fh .in, .fh select.in{ font:inherit; width:100%; padding:8px 11px; border-radius:9px; border:1px solid var(--line2); background:var(--bg); color:var(--text); outline:none; transition:border-color .15s; }
.fh .in:focus{ border-color:var(--acc); }
.fh label.f{ display:block; font-size:11.5px; font-weight:600; color:var(--muted); margin:12px 0 4px; text-transform:uppercase; letter-spacing:.06em; }
.fh .card{ background:linear-gradient(180deg, var(--panel2) 0%, var(--panel) 78%); border:1px solid var(--line); border-radius:16px; padding:18px 20px; margin-top:16px; box-shadow:inset 0 1px 0 rgba(255,255,255,.025), 0 6px 20px rgba(2,6,16,.25); animation:rise .38s cubic-bezier(.2,.7,.3,1) both; transition:border-color .2s; }
.fh .card:hover{ border-color:var(--line2); }
.fh .card h3{ font-family:'Sora',sans-serif; font-weight:600; font-size:15px; margin-bottom:4px; letter-spacing:-.01em; }
@keyframes rise{ from{ opacity:0; transform:translateY(10px); } to{ opacity:1; transform:none; } }
.fh .mono{ font-family:'Spline Sans Mono',monospace; font-variant-numeric:tabular-nums; }
.fh .big{ font-family:'Spline Sans Mono',monospace; font-size:34px; font-weight:600; letter-spacing:-.015em; font-variant-numeric:tabular-nums; }
.fh .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.fh .grid3{ display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
.fh .grid4{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
.fh .grid2 > .card, .fh .grid3 > .card, .fh .grid4 > .card{ margin-top:0; }
.fh .tag{ display:inline-block; font-size:10px; padding:1.5px 7px; border-radius:6px; background:var(--panel2); color:var(--faint); border:1px solid var(--line); vertical-align:1px; }
.fh .catbar{ display:flex; align-items:center; gap:10px; padding:4px 0; font-size:13px; }
.fh .catbar .nm{ width:110px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fh .catbar .tr{ flex:1; height:9px; border-radius:5px; background:var(--panel2); overflow:hidden; }
.fh .catbar .tr i{ display:block; height:100%; background:var(--acc); border-radius:5px; }
.fh .catbar .amt{ width:70px; text-align:right; font-family:'Spline Sans Mono',monospace; font-size:12.5px; }
.fh .kv{ display:flex; justify-content:space-between; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
.fh .kv:last-child{ border-bottom:none; }
.fh .kv .k{ color:var(--muted); }
.fh .bar{ height:10px; border-radius:6px; background:var(--panel2); overflow:hidden; margin-top:6px; }
.fh .bar i{ display:block; height:100%; background:linear-gradient(90deg, var(--acc), color-mix(in srgb, var(--acc) 65%, #34d399)); border-radius:6px; transition:width .5s cubic-bezier(.2,.7,.3,1); }
.fh .bar i.over{ background:var(--red); }
.fh .note{ font-size:12.5px; color:var(--muted); margin-top:8px; }
.fh .err{ color:var(--red); font-size:13px; margin-top:8px; }
.fh .good{ color:var(--up); font-weight:600; }
.fh .bad{ color:var(--red); font-weight:600; }
.fh .warn{ color:var(--gold); font-weight:600; }
.fh .row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.fh .trow{ display:grid; grid-template-columns:92px 1fr .7fr .6fr .9fr 1.1fr 30px; gap:7px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
.fh .trow:last-child{ border-bottom:none; }
.fh .irow{ display:grid; grid-template-columns:1.5fr .7fr .9fr .9fr 1fr 1fr 30px; gap:8px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
.fh .irow:last-child{ border-bottom:none; }
.fh .x{ background:none; border:none; color:var(--faint); cursor:pointer; font-size:15px; padding:2px; border-radius:6px; }
.fh .x:hover{ color:var(--red); }
.fh .ov{ position:fixed; inset:0; background:rgba(4,7,14,.65); display:flex; align-items:flex-start; justify-content:center; padding:44px 16px; z-index:50; overflow-y:auto; backdrop-filter:blur(5px); animation:fadeIn .2s ease both; }
@keyframes fadeIn{ from{ opacity:0; } to{ opacity:1; } }
.fh .modal{ background:var(--panel); border:1px solid var(--line2); border-radius:20px; width:100%; max-width:540px; padding:24px 26px; box-shadow:var(--shadow); animation:rise .3s cubic-bezier(.2,.7,.3,1) both; }
.fh .modal h2{ font-family:'Sora',sans-serif; font-weight:600; font-size:18px; letter-spacing:-.01em; }
.fh .modal h3{ font-family:'Sora',sans-serif; font-weight:600; font-size:14.5px; margin-top:18px; }
.fh .mh{ display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.fh .mrow{ display:flex; gap:8px; justify-content:flex-end; margin-top:18px; flex-wrap:wrap; }
.fh .aiout{ background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-top:12px; white-space:pre-wrap; font-size:13.5px; line-height:1.6; }
.fh .chip{ display:inline-flex; align-items:center; gap:7px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:5px 10px; font-size:12.5px; }
.fh .dot{ width:9px; height:9px; border-radius:3px; flex-shrink:0; }
.fh .glow .recharts-line-curve{ filter:drop-shadow(0 0 6px color-mix(in srgb, var(--up) 55%, transparent)); }
/* logo: pages sweep open from the spine on mount, and again on hover */
.fh .atlas-logo .pg{ transform-origin:24px 24px; animation:pageOpen .62s cubic-bezier(.22,.9,.28,1) both; }
.fh .atlas-logo .pgr{ animation-delay:.07s; }
.fh .brand:hover .atlas-logo .pg{ animation:pageOpen .5s cubic-bezier(.22,.9,.28,1) both; }
@keyframes pageOpen{ from{ transform:scaleX(.06); opacity:.35; } to{ transform:none; opacity:1; } }
.fh .banner{ border:1px solid var(--acc); background:var(--acc-soft); border-radius:12px; padding:10px 14px; margin-top:12px; font-size:13px; animation:rise .3s ease both; }
@media (max-width:760px){
  .fh .grid2,.fh .grid3{ grid-template-columns:1fr; }
  .fh .grid4{ grid-template-columns:1fr 1fr; }
  .fh .trow{ grid-template-columns:80px 1fr .7fr .6fr 30px; }
  .fh .trow .tnote,.fh .trow .tacct{ display:none; }
  .fh .irow{ grid-template-columns:1.4fr .8fr 1fr 30px; }
  .fh .irow .iday,.fh .irow .igain{ display:none; }
  .fh .big{ font-size:28px; }
}
@media (prefers-reduced-motion: reduce){ .fh *, .fh *::before, .fh *::after{ animation:none !important; transition:none !important; } }
`;

/* ---------------- shared bits ---------------- */

/* Atlas mark: an open book — an atlas is literally a book of maps. The pages
   sweep open from the spine on mount and again on hover. */
const Logo = ({ size = 30 }) => {
  /* useId() contains ':' which is invalid inside url(#…) — strip it */
  const gid = "atlas" + React.useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className="atlas-logo" role="img" aria-label="Atlas">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="48" x2="48" y2="0">
          <stop offset="0" stopColor="#2a78d6" /><stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="14" fill={`url(#${gid})`} />
      <path className="pg pgl" d="M24 17C20.5 14 14.5 12.8 9.5 13.4V31.6C14.5 31 20.5 32.2 24 35.2Z" fill="#fff" />
      <path className="pg pgr" d="M24 17C27.5 14 33.5 12.8 38.5 13.4V31.6C33.5 31 27.5 32.2 24 35.2Z" fill="#fff" fillOpacity=".82" />
    </svg>
  );
};

/* categorical series colors — validated palette, assigned by entity (stable index), never by rank */
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];
const seriesColor = (i) => (i < 0 ? "var(--faint)" : SERIES[i % SERIES.length]);

/* donut + legend rows; data: [{name, value, color}] already sorted for display */
function Donut({ data, size = 185, centerTop, centerBottom }) {
  const total = data.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ width: size, height: size, position: "relative", flexShrink: 0 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="100%"
              paddingAngle={2} stroke="var(--panel)" strokeWidth={2} startAngle={90} endAngle={-270}>
              {data.map((e, i) => <Cell key={i} fill={e.color} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [fmt(v) + " · " + Math.round((v / total) * 100) + "%", n]}
              contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, color: "var(--text)", fontSize: 13 }} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          {centerTop && <div className="mono" style={{ fontSize: 17, fontWeight: 600 }}>{centerTop}</div>}
          {centerBottom && <div style={{ fontSize: 11, color: "var(--faint)" }}>{centerBottom}</div>}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 170 }}>
        {data.map((e) => (
          <div key={e.name} className="row" style={{ justifyContent: "space-between", padding: "4px 0", fontSize: 13, flexWrap: "nowrap" }}>
            <span className="row" style={{ gap: 8, flexWrap: "nowrap", overflow: "hidden" }}>
              <span className="dot" style={{ background: e.color }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
            </span>
            <span className="mono" style={{ fontSize: 12.5, flexShrink: 0 }}>{fmt(e.value)} <span style={{ color: "var(--faint)" }}>{Math.round((e.value / total) * 100)}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <h2>{title}</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const ChartBox = ({ data, dataKey, xKey, height = 180, color = "var(--up)", glow = true }) => (
  <div style={{ width: "100%", height }} className={glow ? "glow" : ""}>
    <ResponsiveContainer>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: "var(--faint)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--line)" }} />
        <YAxis tick={{ fill: "var(--faint)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtK} width={52} />
        <Tooltip
          formatter={(v) => fmt(v)}
          contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, color: "var(--text)", fontSize: 13 }}
        />
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: color }} />
      </LineChart>
    </ResponsiveContainer>
  </div>
);

/* ---------------- bank sync (SimpleFIN) ---------------- */

function BankSync({ d, config, syncBusy, syncMsg, onConnect, onSync, onRemoveBank, onReload }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [sfBusy, setSfBusy] = useState(false);
  const [sfMsg, setSfMsg] = useState("");
  const conns = d.simplefin || [];
  const legacy = d.teller || [];

  const claim = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/simplefin/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupToken: token.trim() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      setToken(""); setMsg("Connected. Syncing…");
      await onReload();
      await syncNow();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };
  const syncNow = async () => {
    setSfBusy(true); setSfMsg("");
    try {
      const r = await fetch("/api/simplefin/sync", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Sync failed");
      await onReload();
      setSfMsg("Synced — " + j.newTx + " new transactions, " + j.updAcc + " balances updated."
        + (j.warnings?.length ? " (" + j.warnings.join("; ") + ")" : ""));
    } catch (e) { setSfMsg("Sync failed — " + e.message); }
    setSfBusy(false);
    setTimeout(() => setSfMsg(""), 9000);
  };
  const remove = async (id) => {
    if (!confirm("Disconnect this SimpleFIN connection? Your existing transactions stay.")) return;
    await fetch("/api/simplefin/" + id, { method: "DELETE" });
    await onReload();
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Bank sync</h3>
        <span className="note" style={{ margin: 0 }}>{d.lastSync ? "last sync " + d.lastSync.slice(0, 16).replace("T", " ") : "not connected"}</span>
      </div>
      <div className="note">
        Read-only sync via <b>SimpleFIN Bridge</b> ($15/yr, up to 25 institutions). You log in at your bank
        through SimpleFIN — your credentials never touch this app, and this app only ever holds a read-only
        key you can revoke from your SimpleFIN dashboard.
      </div>

      {conns.map((c) => (
        <div className="kv" key={c.id}>
          <span className="k">{c.institution} <span style={{ color: "var(--faint)", fontSize: 11.5 }}>· connected {c.added}</span></span>
          <button className="x" title="Disconnect" onClick={() => remove(c.id)}>✕</button>
        </div>
      ))}

      {conns.length > 0 && (
        <div className="mrow" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={sfBusy} onClick={syncNow}>{sfBusy ? "Syncing…" : "Sync now"}</button>
        </div>
      )}
      {sfMsg && <div className={"note " + (sfMsg.startsWith("Sync failed") ? "bad" : "good")}>{sfMsg}</div>}

      <label className="f">{conns.length ? "Add another connection" : "Connect your banks"}</label>
      <div className="row">
        <input className="in mono" style={{ flex: 1, minWidth: 200, fontSize: 12.5 }} placeholder="Paste your SimpleFIN setup token…"
          value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && token.trim() && claim()} />
        <button className="btn primary" disabled={busy || !token.trim()} onClick={claim}>{busy ? "Connecting…" : "Connect"}</button>
      </div>
      {msg && <div className={"note " + (msg.startsWith("Connected") ? "good" : "bad")}>{msg}</div>}
      <div className="note">
        Get a token: sign up at <a href="https://beta-bridge.simplefin.org/" target="_blank" rel="noreferrer noopener" style={{ color: "var(--acc)" }}>beta-bridge.simplefin.org</a> →
        add your banks under <b>Financial Institutions</b> → then <b>Apps → New Connection</b> → <b>Create Setup Token</b>. Tokens are one-time use.
      </div>
      <div className="note">Synced transactions land in Budget as "uncategorized" for you (or the AI) to sort. Brokerages like Fidelity aren't covered — use the Invest tab's positions-CSV import instead.</div>

      {legacy.length > 0 && (
        <>
          <label className="f">Teller (discontinued)</label>
          <div className="note" style={{ marginTop: 0 }}>Teller withdrew its API in July 2026. Existing connections may still sync until their servers go dark; new ones aren't possible.</div>
          {legacy.map((t) => (
            <div className="kv" key={t.id}>
              <span className="k">{t.institution} <span style={{ color: "var(--faint)", fontSize: 11.5 }}>· connected {t.added}</span></span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn small" disabled={syncBusy} onClick={onSync}>{syncBusy ? "Syncing…" : "Sync"}</button>
                <button className="x" title="Disconnect" onClick={() => onRemoveBank(t.id)}>✕</button>
              </span>
            </div>
          ))}
          {syncMsg && <div className="note good">{syncMsg}</div>}
        </>
      )}
    </div>
  );
}

/* ---------------- Overview tab ---------------- */

function Overview({ d, setD, config, syncBusy, syncMsg, onConnect, onSync, onRemoveBank, onReload }) {
  const assets = sumAssets(d.accounts), debts = sumDebts(d.accounts), nw = assets - debts;
  const [adding, setAdding] = useState(false);
  const [na, setNa] = useState({ name: "", type: "Checking", balance: "" });

  const setBal = (id, v) =>
    setD((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === id ? { ...a, balance: v === "" ? 0 : Number(v) } : a)) }));

  const snapshot = () => {
    const entry = { date: today(), assets, debts, nw };
    setD((p) => ({ ...p, history: [...p.history.filter((h) => h.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date)) }));
  };

  /* auto-snapshot: whenever balances change, upsert today's point */
  useEffect(() => {
    const t = setTimeout(() => {
      const last = d.history[d.history.length - 1];
      if (!last || last.date !== today() || last.nw !== nw) snapshot();
    }, 1200);
    return () => clearTimeout(t);
  }, [nw]);

  const chartData = d.history.map((h) => ({ date: h.date.slice(5), nw: h.nw }));

  return (
    <>
      <BankSync d={d} config={config} syncBusy={syncBusy} syncMsg={syncMsg}
        onConnect={onConnect} onSync={onSync} onRemoveBank={onRemoveBank} onReload={onReload} />
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="sub">Net worth</div>
            <div className="big" style={{ color: nw >= 0 ? "var(--acc)" : "var(--red)" }}>{fmt(nw)}</div>
            <div className="note mono">{fmt(assets)} assets − {fmt(debts)} debt</div>
          </div>
          <button className="btn" onClick={snapshot} title="Snapshots happen automatically when balances change — this just forces one now">Snapshot now</button>
        </div>
        {chartData.length >= 2
          ? <ChartBox data={chartData} dataKey="nw" xKey="date" />
          : chartData.length === 1
            ? <div className="note">
                <span className="good">✓ First point logged</span> — {d.history[0].date}: <b className="mono">{fmt(d.history[0].nw)}</b>.
                One net-worth point is recorded per day (edits during the day update it). The trend line appears on day two — it logs automatically whenever you open this tab or change a balance.
              </div>
            : <div className="note">The trend line builds itself — every time you update a balance, today's net worth is recorded automatically. One point per day; the line appears on day two. Up and to the right is the whole game.</div>}
      </div>

      <div className="card">
        <h3>Accounts</h3>
        {d.accounts.map((a) => (
          <div className="kv" key={a.id}>
            <span className="k">{a.name} <span style={{ color: "var(--faint)", fontSize: 11.5 }}>· {a.type}</span></span>
            <span className="row" style={{ gap: 6 }}>
              {isDebt(a) && <span className="bad" style={{ fontSize: 12 }}>debt</span>}
              <input className="in mono" style={{ width: 66, textAlign: "right", padding: "4px 6px" }} type="number" step="0.1"
                title={isDebt(a) ? "APR %" : INVESTED.includes(a.type) ? "Expected return %/yr" : "APY %"}
                placeholder={isDebt(a) ? "APR%" : LIQUID.includes(a.type) ? "APY%" : "%/yr"}
                value={a.rate ?? ""} onChange={(e) => setD((p) => ({ ...p, accounts: p.accounts.map((x) => x.id === a.id ? { ...x, rate: e.target.value === "" ? "" : Number(e.target.value) } : x) }))} />
              <input className="in mono" style={{ width: 120, textAlign: "right", padding: "4px 8px" }} type="number"
                value={a.balance} onChange={(e) => setBal(a.id, e.target.value)} />
              <button className="x" onClick={() => setD((p) => ({ ...p, accounts: p.accounts.filter((x) => x.id !== a.id) }))}>✕</button>
            </span>
          </div>
        ))}
        {!adding
          ? <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 10 }}><button className="btn small" onClick={() => setAdding(true)}>+ Add account</button></div>
          : <div className="row" style={{ marginTop: 10 }}>
              <input className="in" style={{ flex: 2, minWidth: 120 }} placeholder="Name (e.g. Fidelity 401k)" value={na.name} onChange={(e) => setNa({ ...na, name: e.target.value })} />
              <select className="in" style={{ flex: 1, minWidth: 110 }} value={na.type} onChange={(e) => setNa({ ...na, type: e.target.value })}>
                <optgroup label="Assets">{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</optgroup>
                <optgroup label="Debts">{DEBT_TYPES.map((t) => <option key={t}>{t}</option>)}</optgroup>
              </select>
              <input className="in" type="number" style={{ width: 110 }} placeholder="Balance" value={na.balance} onChange={(e) => setNa({ ...na, balance: e.target.value })} />
              <button className="btn small primary" onClick={() => {
                if (!na.name.trim()) return;
                setD((p) => ({ ...p, accounts: [...p.accounts, { id: uid(), name: na.name.trim(), type: na.type, balance: Number(na.balance) || 0 }] }));
                setNa({ name: "", type: "Checking", balance: "" }); setAdding(false);
              }}>Add</button>
              <button className="btn small" onClick={() => setAdding(false)}>Cancel</button>
            </div>}
        <div className="note">Debt balances are entered as positive numbers — they subtract from net worth automatically.</div>
      </div>

      {(() => { /* asset allocation — color follows the asset TYPE's fixed index */
        const byType = {};
        d.accounts.filter((a) => !isDebt(a) && Number(a.balance) > 0).forEach((a) => { byType[a.type] = (byType[a.type] || 0) + Number(a.balance); });
        const rows = Object.entries(byType)
          .map(([type, value]) => ({ name: type, value: Math.round(value), color: seriesColor(ASSET_TYPES.indexOf(type)) }))
          .sort((a, b) => b.value - a.value);
        return rows.length >= 2 ? (
          <div className="card">
            <h3>Asset allocation</h3>
            <div style={{ marginTop: 10 }}><Donut data={rows} centerTop={fmt(assets)} centerBottom="assets" /></div>
          </div>
        ) : null;
      })()}
    </>
  );
}

/* ---------------- Budget tab ---------------- */

function Budget({ d, setD, config }) {
  const [catBusy, setCatBusy] = useState(false);
  const [recoBusy, setRecoBusy] = useState(false);
  const [reco, setReco] = useState(null);

  const recommend = async () => {
    setRecoBusy(true); setReco(null);
    try {
      const threeMo = new Date(Date.now() - 92 * 864e5).toISOString().slice(0, 10);
      const recent = d.txns.filter((t) => t.kind !== "in" && (t.date || "") >= threeMo);
      const byCat = {};
      recent.forEach((t) => { const n = d.cats.find((c) => c.id === t.catId)?.name || "Uncategorized"; byCat[n] = (byCat[n] || 0) + Number(t.amount || 0); });
      const avg = Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, Math.round(v / 3)]));
      const debts = d.accounts.filter((a) => ["Credit card", "Auto loan", "Student loan", "Mortgage", "Other debt"].includes(a.type) && Number(a.balance) > 0)
        .map((a) => ({ name: a.name, balance: Number(a.balance), apr: Number(a.rate) || null, min: Number(a.minPay) || null }));
      const goalsMo = d.goals.reduce((s, g) => s + (Number(g.monthly) || 0), 0);
      const inc = Number(d.settings.incomeMonthly) || 0;
      const prompt =
        "You are a pragmatic budget planner. Monthly take-home income: $" + inc +
        ". 3-month average spending by category: " + JSON.stringify(avg) +
        ". Debts: " + JSON.stringify(debts) + " (their minimum payments must be payable)." +
        " Goal contributions already planned: $" + goalsMo + "/mo." +
        " Categories to budget: " + JSON.stringify(d.cats.map((c) => c.name)) +
        '. Recommend a realistic monthly limit for EVERY listed category (trim where habits are loose, keep essentials honest), totaling comfortably under income minus debt minimums minus goal contributions. Respond ONLY JSON (no fences): {"limits": [{"cat": string, "limit": integer}], "note": string under 50 words explaining the biggest changes}.';
      const out = await callClaude(prompt);
      const j = extractJSON(out);
      if (Array.isArray(j.limits)) setReco(j);
      else throw new Error("Unexpected response");
    } catch (e) { alert("Recommendation failed — " + e.message); }
    setRecoBusy(false);
  };
  const [month, setMonth] = useState(thisMonth());
  const [nt, setNt] = useState({ date: today(), catId: d.cats[0]?.id || "", amount: "", note: "", kind: "out", accountId: "" });
  const [newCat, setNewCat] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [impMsg, setImpMsg] = useState("");
  const [q, setQ] = useState("");
  const [fCat, setFCat] = useState("");

  const monthTxns = d.txns.filter((t) => (t.date || "").startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
  /* search spans ALL months (find that one charge from last spring); month view otherwise */
  const searching = q.trim() !== "" || fCat !== "";
  const ql = q.trim().toLowerCase();
  const shownTxns = searching
    ? d.txns.filter((t) =>
        (!fCat || t.catId === fCat) &&
        (!ql || (t.note || "").toLowerCase().includes(ql) || String(t.amount).includes(ql) ||
          (d.cats.find((c) => c.id === t.catId)?.name || "").toLowerCase().includes(ql)))
        .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 200)
    : monthTxns;
  const outTxns = monthTxns.filter((t) => t.kind !== "in");
  const spentBy = {};
  outTxns.forEach((t) => { spentBy[t.catId] = (spentBy[t.catId] || 0) + (Number(t.amount) || 0); });
  const totalSpent = outTxns.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const monthIn = monthTxns.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const income = monthIn > 0 ? monthIn : Number(d.settings.incomeMonthly) || 0;
  const saved = income - totalSpent;
  const rate = income > 0 ? (saved / income) * 100 : NaN;

  const shiftMonth = (n) => {
    const [y, m] = month.split("-").map(Number);
    const dt = new Date(y, m - 1 + n, 1);
    setMonth(dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0"));
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>{monthLabel(month)}</h3>
          <div className="row">
            <button className="btn small" onClick={() => shiftMonth(-1)}>←</button>
            <button className="btn small" onClick={() => shiftMonth(1)}>→</button>
          </div>
        </div>
        <div className="grid3" style={{ marginTop: 10 }}>
          <div><div className="sub">Income</div><div className="mono" style={{ fontSize: 21, fontWeight: 600 }}>{fmt(income)}</div></div>
          <div><div className="sub">Spent</div><div className="mono" style={{ fontSize: 21, fontWeight: 600 }}>{fmt(totalSpent)}</div></div>
          <div><div className="sub">Kept</div><div className="mono" style={{ fontSize: 21, fontWeight: 600 }} >
            <span className={saved >= 0 ? "good" : "bad"}>{fmt(saved)}</span>
            <span style={{ fontSize: 13, color: "var(--faint)" }}> {income > 0 ? "(" + pct(rate) + ")" : ""}</span>
          </div></div>
        </div>
        {income === 0 && <div className="note">Set your monthly take-home income in Settings (or log income transactions) to see savings rate.</div>}
        {monthIn > 0 && <div className="note">Income is the sum of this month's logged income transactions.</div>}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h3>Categories</h3>
          <span className="row" style={{ gap: 6 }}>
            {config?.aiEnabled && <button className="btn small" disabled={recoBusy} onClick={recommend}>{recoBusy ? "Thinking…" : "AI recommend"}</button>}
            <span className="note" style={{ margin: 0 }}>spent so far / monthly budget</span>
          </span>
        </div>
        {reco && (
          <div className="note" style={{ border: "1px solid var(--line2)", borderRadius: 9, padding: "9px 12px", marginTop: 8 }}>
            <b>Recommended budgets:</b> {reco.limits.map((l) => l.cat + " " + fmt(l.limit)).join(" · ")}
            <div style={{ marginTop: 4 }}>{reco.note}</div>
            <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
              <button className="btn small primary" onClick={() => {
                setD((p) => ({ ...p, cats: p.cats.map((c) => {
                  const hit = reco.limits.find((l) => (l.cat || "").toLowerCase() === c.name.toLowerCase());
                  return hit ? { ...c, limit: Number(hit.limit) || c.limit } : c;
                }) }));
                setReco(null);
              }}>Apply all</button>
              <button className="btn small" onClick={() => setReco(null)}>Dismiss</button>
            </div>
          </div>
        )}
        {d.cats.map((c) => {
          const spent = spentBy[c.id] || 0;
          const lim = Number(c.limit) || 0;
          const p = lim > 0 ? Math.min(100, (spent / lim) * 100) : 0;
          return (
            <div key={c.id} style={{ padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{c.name}</span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="mono" style={{ fontSize: 13 }}>
                    <span className={lim > 0 && spent > lim ? "bad" : ""}>{fmt(spent)}</span>
                    <span style={{ color: "var(--faint)" }}> / </span>
                  </span>
                  <input className="in mono" type="number" style={{ width: 90, textAlign: "right", padding: "3px 8px" }}
                    value={c.limit} title="Monthly budget"
                    onChange={(e) => setD((p2) => ({ ...p2, cats: p2.cats.map((x) => (x.id === c.id ? { ...x, limit: e.target.value === "" ? 0 : Number(e.target.value) } : x)) }))} />
                  <button className="x" onClick={() => setD((p2) => ({ ...p2, cats: p2.cats.filter((x) => x.id !== c.id) }))}>✕</button>
                </span>
              </div>
              {lim > 0 && <div className="bar"><i className={spent > lim ? "over" : ""} style={{ width: p + "%" }} /></div>}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 10 }}>
          <input className="in" style={{ flex: 1 }} placeholder="New category…" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button className="btn small" onClick={() => { if (newCat.trim()) { setD((p) => ({ ...p, cats: [...p.cats, { id: uid(), name: newCat.trim(), limit: 0 }] })); setNewCat(""); } }}>Add</button>
        </div>
        {(() => { const tot = d.cats.reduce((s, c) => s + (Number(c.limit) || 0), 0);
          return tot > 0 ? <div className="note">Total budgeted: <b className="mono">{fmt(tot)}</b>{income > 0 ? (tot > income ? <span className="bad"> — over your {fmt(income)} income</span> : " of " + fmt(income) + " income") : ""}</div> : null; })()}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>{searching ? "Search — all months" : "Transactions — " + monthLabel(month)}</h3>
          <span className="row" style={{ gap: 6 }}>
            {config?.aiEnabled && monthTxns.some((t) => !t.catId && t.kind !== "in") && (
              <button className="btn small" disabled={catBusy} onClick={async () => {
                setCatBusy(true);
                try {
                  const un = monthTxns.filter((t) => !t.catId && t.kind !== "in").slice(0, 60).map((t) => ({ i: t.id, d: t.note || "" }));
                  const prompt = "Categorize these bank transaction descriptions into EXACTLY one of: " + JSON.stringify(d.cats.map((c) => c.name)) +
                    ". Transactions: " + JSON.stringify(un) + '. Respond ONLY JSON array: [{"i": string, "cat": string}].';
                  const out = await callClaude(prompt);
                  const j = extractJSON(out);
                  const byName = Object.fromEntries(d.cats.map((c) => [c.name.toLowerCase(), c.id]));
                  setD((p) => ({ ...p, txns: p.txns.map((t) => {
                    const hit = j.find((x) => x.i === t.id);
                    return hit && byName[(hit.cat || "").toLowerCase()] ? { ...t, catId: byName[hit.cat.toLowerCase()] } : t;
                  }) }));
                } catch (e) { alert("Categorize failed — " + e.message); }
                setCatBusy(false);
              }}>{catBusy ? "Sorting…" : "AI categorize (" + monthTxns.filter((t) => !t.catId && t.kind !== "in").length + ")"}</button>
            )}
            <button className="btn small" onClick={() => setShowImport(true)}>Import bank CSV</button>
          </span>
        </div>
        {impMsg && <div className="note good">{impMsg}</div>}
        <div className="row" style={{ margin: "8px 0 4px" }}>
          <input className="in" style={{ flex: 2, minWidth: 140, padding: "5px 9px" }} placeholder="Search notes, amounts, categories…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="in" style={{ flex: 1, minWidth: 110, padding: "5px 9px" }} value={fCat} onChange={(e) => setFCat(e.target.value)}>
            <option value="">All categories</option>
            {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {searching && <button className="btn small" onClick={() => { setQ(""); setFCat(""); }}>Clear ({shownTxns.length})</button>}
        </div>
        <div className="trow" style={{ borderBottom: "1px solid var(--line2)", fontWeight: 600, color: "var(--faint)", fontSize: 12 }}>
          <span>Date</span><span>Category</span><span>Amount</span><span>Type</span><span className="tacct">Account</span><span className="tnote">Note</span><span />
        </div>
        <div className="trow">
          <input className="in" type="date" style={{ padding: "4px 6px" }} value={nt.date} onChange={(e) => setNt({ ...nt, date: e.target.value })} />
          <select className="in" style={{ padding: "4px 6px" }} value={nt.catId} onChange={(e) => setNt({ ...nt, catId: e.target.value })}>
            {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="in mono" type="number" placeholder="0" style={{ padding: "4px 6px" }} value={nt.amount} onChange={(e) => setNt({ ...nt, amount: e.target.value })} />
          <select className="in" style={{ padding: "4px 6px" }} value={nt.kind} onChange={(e) => setNt({ ...nt, kind: e.target.value })}>
            <option value="out">Spend</option><option value="in">Income</option>
          </select>
          <select className="in tacct" style={{ padding: "4px 6px" }} value={nt.accountId} onChange={(e) => setNt({ ...nt, accountId: e.target.value })}>
            <option value="">— account —</option>
            {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input className="in tnote" placeholder="Note" style={{ padding: "4px 6px" }} value={nt.note} onChange={(e) => setNt({ ...nt, note: e.target.value })} />
          <button className="btn small primary" style={{ padding: "4px 8px" }} onClick={() => {
            if (!nt.amount || !nt.catId) return;
            setD((p) => ({ ...p, txns: [...p.txns, { id: uid(), ...nt, amount: Number(nt.amount) }] }));
            setNt({ date: nt.date, catId: nt.catId, amount: "", note: "", kind: nt.kind, accountId: nt.accountId });
          }}>+</button>
        </div>
        {shownTxns.map((t) => (
          <div className="trow" key={t.id}>
            <span className="mono" style={{ fontSize: 12.5 }}>{searching ? t.date : t.date.slice(5)}</span>
            {t.catId
              ? <span>{d.cats.find((c) => c.id === t.catId)?.name || "?"}</span>
              : <select className="in" style={{ padding: "3px 6px", fontSize: 12, borderColor: "var(--gold)" }} value=""
                  onChange={(e) => setD((p) => ({ ...p, txns: p.txns.map((x) => x.id === t.id ? { ...x, catId: e.target.value } : x) }))}>
                  <option value="" disabled>— pick —</option>
                  {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>}
            <span className="mono" style={t.kind === "in" ? { color: "var(--acc)" } : null}>{t.kind === "in" ? "+" : ""}{fmt(Number(t.amount))}</span>
            <span>{t.kind === "in" ? <span className="tag" style={{ color: "var(--acc)" }}>income</span> : null}</span>
            <span className="tacct">{t.accountId ? <span className="tag">{(d.accounts.find((a) => a.id === t.accountId)?.name || "").slice(0, 18)}</span> : null}</span>
            <span className="tnote" style={{ color: "var(--muted)", fontSize: 13 }}>{t.note}</span>
            <button className="x" onClick={() => setD((p) => ({ ...p, txns: p.txns.filter((x) => x.id !== t.id) }))}>✕</button>
          </div>
        ))}
        {!shownTxns.length && <div className="note">{searching ? "Nothing matches this search." : "No transactions this month yet — log spending above as it happens, or import your bank's CSV."}</div>}
      </div>

      <Recurring d={d} setD={setD} />
      <SubscriptionRadar d={d} setD={setD} />

      {showImport && (
        <BankImport d={d} setD={setD} onClose={(n) => {
          setShowImport(false);
          if (n > 0) { setImpMsg("Imported " + n + " transactions."); setTimeout(() => setImpMsg(""), 4500); }
        }} />
      )}
    </>
  );
}

/* ---------------- Goals tab ---------------- */

function GoalForm({ initial, accounts = [], onSave, onClose }) {
  const [g, setG] = useState({ name: "", target: "", current: "", monthly: "", deadline: "", accountId: "", ...initial });
  const set = (k, v) => setG((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial?.id ? "Edit goal" : "New goal"} onClose={onClose}>
      <label className="f">Goal</label>
      <input className="in" value={g.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Emergency fund, House down payment, Wedding" />
      <div className="grid2">
        <div><label className="f">Target ($)</label><input className="in" type="number" value={g.target} onChange={(e) => set("target", e.target.value)} /></div>
        <div><label className="f">Saved so far ($)</label><input className="in" type="number" value={g.current} disabled={!!g.accountId} placeholder={g.accountId ? "tracks account" : ""} onChange={(e) => set("current", e.target.value)} /></div>
        <div><label className="f">Monthly contribution ($)</label><input className="in" type="number" value={g.monthly} onChange={(e) => set("monthly", e.target.value)} /></div>
        <div><label className="f">Deadline (optional)</label><input className="in" type="date" value={g.deadline} onChange={(e) => set("deadline", e.target.value)} /></div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label className="f">Track an account balance (optional — savings tracker)</label>
          <select className="in" value={g.accountId || ""} onChange={(e) => set("accountId", e.target.value)}>
            <option value="">Manual "saved so far"</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="mrow">
        {initial?.id && <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => onSave(null)}>Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => {
          if (!g.name.trim() || !g.target) return;
          onSave({ ...g, id: g.id || uid(), target: Number(g.target), current: Number(g.current) || 0, monthly: Number(g.monthly) || 0 });
        }}>Save goal</button>
      </div>
    </Modal>
  );
}

function Goals({ d, setD }) {
  const [editing, setEditing] = useState(null);
  const monthsLeft = (deadline) => {
    if (!deadline) return null;
    const ms = new Date(deadline).getTime() - Date.now();
    return Math.max(0, ms / (30.44 * 86400000));
  };
  return (
    <>
      {d.goals.map((g) => {
        const cur = g.accountId ? Number(d.accounts.find((a) => a.id === g.accountId)?.balance || 0) : g.current;
        const p = Math.min(100, (cur / g.target) * 100);
        const remain = Math.max(0, g.target - cur);
        const ml = monthsLeft(g.deadline);
        const needed = ml != null && ml > 0 ? remain / ml : null;
        const etaMonths = g.monthly > 0 ? remain / g.monthly : null;
        const onTrack = needed != null ? g.monthly >= needed : null;
        return (
          <div className="card" key={g.id} style={{ cursor: "pointer" }} onClick={() => setEditing(g)}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{g.name}</h3>
              <span className="mono" style={{ fontSize: 15 }}>{fmt(cur)}{g.accountId ? <span className="tag" style={{ marginLeft: 5 }}>auto</span> : null} <span style={{ color: "var(--faint)" }}>/ {fmt(g.target)}</span></span>
            </div>
            <div className="bar"><i style={{ width: p + "%" }} /></div>
            <div className="note">
              {pct(p)} there · {fmt(g.monthly)}/mo
              {etaMonths != null && remain > 0 && " · done in ~" + Math.ceil(etaMonths) + " mo"}
              {ml != null && needed != null && remain > 0 && (
                onTrack
                  ? <span className="good"> · on track for {g.deadline}</span>
                  : <span className="warn"> · needs {fmt(needed)}/mo to hit {g.deadline}</span>
              )}
              {remain === 0 && <span className="good"> · ✓ funded</span>}
            </div>
          </div>
        );
      })}
      {!d.goals.length && (
        <div className="card"><div className="note">No goals yet. First one on almost everyone's list: an emergency fund — the Plan tab computes your target from your actual spending.</div></div>
      )}
      <div className="mrow" style={{ justifyContent: "flex-start" }}>
        <button className="btn primary" onClick={() => setEditing({})}>+ Add goal</button>
      </div>
      {editing !== null && (
        <GoalForm initial={editing} accounts={d.accounts} onClose={() => setEditing(null)}
          onSave={(g) => {
            setD((p) => g === null
              ? { ...p, goals: p.goals.filter((x) => x.id !== editing.id) }
              : { ...p, goals: p.goals.some((x) => x.id === g.id) ? p.goals.map((x) => (x.id === g.id ? g : x)) : [...p.goals, g] });
            setEditing(null);
          }} />
      )}
    </>
  );
}

/* ---------------- Plan tab (calculators) ---------------- */

function Plan({ d, setD }) {
  const s = d.settings;
  const avgSpend = avgMonthlySpend(d.txns);
  const [efSpend, setEfSpend] = useState("");     // manual override
  const [salary, setSalary] = useState(s.incomeMonthly ? Math.round(s.incomeMonthly * 12 / 0.75) : 85000); // rough gross guess, editable
  const [contribPct, setContribPct] = useState(6);
  const [matchRate, setMatchRate] = useState(100);
  const [matchCap, setMatchCap] = useState(4);
  const [projMonthly, setProjMonthly] = useState(500);
  const [projYears, setProjYears] = useState(30);
  const [aiOut, setAiOut] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");

  const spendBase = efSpend !== "" ? Number(efSpend) : avgSpend;
  const efTarget = spendBase * s.efMonths;
  const liq = liquid(d.accounts);
  const efPct = efTarget > 0 ? Math.min(100, (liq / efTarget) * 100) : 0;

  const yourAnnual = salary * contribPct / 100;
  const employerAnnual = salary * Math.min(contribPct, matchCap) / 100 * matchRate / 100;
  const maxEmployer = salary * matchCap / 100 * matchRate / 100;
  const missing = maxEmployer - employerAnnual;
  const k401Series = fvSeries((yourAnnual + employerAnnual) / 12, Math.min(projYears, 40), s.expReturn);

  const investedNow = d.accounts.filter((a) => INVESTED.includes(a.type)).reduce((x, a) => x + (Number(a.balance) || 0), 0);
  const weightedRate = (() => {
    const inv = d.accounts.filter((a) => INVESTED.includes(a.type) && Number(a.balance) > 0 && Number(a.rate) > 0);
    const tot = inv.reduce((x, a) => x + Number(a.balance), 0);
    return tot > 0 ? inv.reduce((x, a) => x + Number(a.balance) * Number(a.rate), 0) / tot : null;
  })();
  const [projStart, setProjStart] = useState(null); // null = follow investedNow
  const startVal = projStart === null ? investedNow : Number(projStart) || 0;
  const projSeries = fvSeries(Number(projMonthly) || 0, Number(projYears) || 0, s.expReturn, startVal);
  const projFV = projSeries[projSeries.length - 1]?.value || 0;
  const contributed = startVal + (Number(projMonthly) || 0) * 12 * (Number(projYears) || 0);

  const aiReview = async () => {
    setAiBusy(true); setAiErr(""); setAiOut("");
    try {
      const summary = {
        netWorth: sumAssets(d.accounts) - sumDebts(d.accounts),
        liquidSavings: liq, debts: sumDebts(d.accounts),
        monthlyIncome: s.incomeMonthly, avgMonthlySpend: Math.round(avgSpend),
        emergencyFundTargetMonths: s.efMonths,
        goals: d.goals.map((g) => ({ name: g.name, target: g.target, current: g.current, monthly: g.monthly })),
        k401: { salary, contribPct, matchRate, matchCap },
      };
      const prompt =
        "Here is a snapshot of someone's finances as JSON:\n" + JSON.stringify(summary) +
        "\n\nGive a short, plain-language review (max ~250 words): what looks solid, what gaps or risks stand out (e.g. unclaimed employer match, thin emergency fund relative to spending, high-interest debt vs investing order-of-operations), and 2-3 concrete next things to look into. " +
        "Frame everything as general financial education, not personalized investment advice — do not recommend specific securities, funds, or products. Be direct and specific to the numbers given.";
      const out = await callClaude(prompt);
      setAiOut(out.trim());
    } catch (e) { setAiErr("Review failed — " + e.message); }
    setAiBusy(false);
  };

  return (
    <>
      <OrderOfOps d={d} k401ok={matchCap > 0 && contribPct >= matchCap} />

      <div className="card">
        <h3>Emergency fund</h3>
        <div className="grid3" style={{ marginTop: 8 }}>
          <div>
            <label className="f">Months of expenses</label>
            <select className="in" value={s.efMonths} onChange={(e) => setD((p) => ({ ...p, settings: { ...p.settings, efMonths: Number(e.target.value) } }))}>
              {[3, 4, 5, 6, 9, 12].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="f">Monthly expenses</label>
            <input className="in mono" type="number" placeholder={avgSpend ? Math.round(avgSpend) : "e.g. 2500"}
              value={efSpend} onChange={(e) => setEfSpend(e.target.value)} />
            <div className="note">{avgSpend > 0 ? "Auto from your last months: " + fmt(avgSpend) : "Log transactions and this fills itself."}</div>
          </div>
          <div>
            <label className="f">Target</label>
            <div className="mono" style={{ fontSize: 21, fontWeight: 600, paddingTop: 6 }}>{fmt(efTarget)}</div>
          </div>
        </div>
        <div className="bar" style={{ marginTop: 12 }}><i style={{ width: efPct + "%" }} /></div>
        <div className="note">
          Liquid (checking + savings): <b className="mono">{fmt(liq)}</b>
          {efTarget > 0 && (liq >= efTarget
            ? <span className="good"> · ✓ fully funded</span>
            : <span> · <b className="warn">{fmt(efTarget - liq)}</b> to go</span>)}
        </div>
      </div>

      <div className="card">
        <h3>401k match</h3>
        <div className="grid2" style={{ marginTop: 8 }}>
          <div><label className="f">Gross salary ($/yr)</label><input className="in mono" type="number" value={salary} onChange={(e) => setSalary(Number(e.target.value) || 0)} /></div>
          <div><label className="f">Your contribution (%)</label><input className="in mono" type="number" value={contribPct} onChange={(e) => setContribPct(Number(e.target.value) || 0)} /></div>
          <div><label className="f">Employer matches (%)</label><input className="in mono" type="number" value={matchRate} onChange={(e) => setMatchRate(Number(e.target.value) || 0)} />
            <div className="note">e.g. 100 = dollar-for-dollar, 50 = fifty cents per dollar</div></div>
          <div><label className="f">…up to (% of salary)</label><input className="in mono" type="number" value={matchCap} onChange={(e) => setMatchCap(Number(e.target.value) || 0)} /></div>
        </div>
        <div className="kv" style={{ marginTop: 10 }}><span className="k">You put in</span><span className="mono">{fmt(yourAnnual)}/yr</span></div>
        <div className="kv"><span className="k">Employer adds</span><span className="mono good">{fmt(employerAnnual)}/yr</span></div>
        {missing > 1 && (
          <div className="kv"><span className="k">Match left unclaimed</span>
            <span className="mono bad">{fmt(missing)}/yr — contribute ≥{matchCap}% to capture it all</span></div>
        )}
        {missing <= 1 && employerAnnual > 0 && <div className="note good">✓ Capturing the full match.</div>}
        {k401Series.length > 1 && (yourAnnual + employerAnnual) > 0 && (
          <>
            <div className="note">Projected balance at {s.expReturn}%/yr (assumption — edit in Settings), contributions only:</div>
            <ChartBox data={k401Series.filter((_, i) => i % Math.ceil(k401Series.length / 12) === 0 || i === k401Series.length - 1)} dataKey="value" xKey="year" height={160} />
          </>
        )}
      </div>

      <DebtPayoff d={d} setD={setD} />
      <PurchasePlanner d={d} setD={setD} />

      <div className="card">
        <h3>Compound growth projector</h3>
        <div className="grid2" style={{ marginTop: 8 }}>
          <div><label className="f">Starting from ($)</label>
            <input className="in mono" type="number" value={projStart === null ? investedNow : projStart}
              onChange={(e) => setProjStart(e.target.value)} />
            <div className="note">Defaults to your invested balances (401k + IRA + brokerage + crypto).</div></div>
          <div><label className="f">Monthly invested ($)</label><input className="in mono" type="number" value={projMonthly} onChange={(e) => setProjMonthly(e.target.value)} /></div>
          <div><label className="f">Years</label><input className="in mono" type="number" value={projYears} onChange={(e) => setProjYears(e.target.value)} /></div>
          <div><label className="f">Assumed return (%/yr)</label><input className="in mono" type="number" value={s.expReturn}
            onChange={(e) => setD((p) => ({ ...p, settings: { ...p.settings, expReturn: Number(e.target.value) || 0 } }))} />
            {weightedRate != null && <div className="note">Your accounts' weighted rate: {weightedRate.toFixed(1)}%</div>}</div>
        </div>
        <div className="kv" style={{ marginTop: 10 }}><span className="k">You'd put in (incl. start)</span><span className="mono">{fmt(contributed)}</span></div>
        <div className="kv"><span className="k">Projected value</span><span className="mono good">{fmt(projFV)}</span></div>
        <div className="kv"><span className="k">Growth doing the work</span><span className="mono">{fmt(projFV - contributed)}</span></div>
        {projSeries.length > 1 && (
          <ChartBox data={projSeries.filter((_, i) => i % Math.ceil(projSeries.length / 12) === 0 || i === projSeries.length - 1)} dataKey="value" xKey="year" height={160} />
        )}
        <div className="note">A projection at an assumed rate, not a promise — real returns vary year to year.</div>
      </div>

      <div className="card">
        <h3>AI review</h3>
        <div className="note">Sends your numbers (from this app only) to Claude for a plain-language look at gaps and priorities. General education, not personalized investment advice.</div>
        <div className="mrow" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={aiBusy} onClick={aiReview}>{aiBusy ? "Reviewing…" : aiOut ? "Review again" : "Review my setup"}</button>
        </div>
        {aiErr && <div className="err">{aiErr}</div>}
        {aiOut && <div className="aiout">{aiOut}</div>}
      </div>
    </>
  );
}

/* ---------------- main ---------------- */

function SecurityModal({ onClose }) {
  const [sec, setSec] = useState(null);
  const [msg, setMsg] = useState("");
  const [codes, setCodes] = useState(null); // freshly generated recovery codes (shown once)
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwMsg, setPwMsg] = useState("");
  const changePw = async () => {
    setPwMsg("");
    if (pw.next.length < 8) return setPwMsg("New password must be at least 8 characters.");
    const r = await fetch("/api/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pw) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setPw({ current: "", next: "" }); setPwMsg("Password changed — every other device was signed out."); }
    else setPwMsg(j.error || "Could not change password");
  };
  const load = async () => { try { setSec(await (await fetch("/api/security")).json()); } catch {} };
  useEffect(() => { load(); }, []);

  const addPasskey = async () => {
    setMsg(""); setBusy(true);
    try {
      const opts = await (await fetch("/api/webauthn/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      const label = (navigator.platform || "This device").slice(0, 30);
      const att = await startRegistration({ optionsJSON: opts });
      const r = await fetch("/api/webauthn/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cred: att, label }) });
      if (r.ok) { setMsg("Passkey added."); load(); } else setMsg((await r.json()).error || "Failed to add passkey");
    } catch (e) { setMsg(e.name === "NotAllowedError" ? "Passkey prompt dismissed" : (e.message || "Failed")); }
    setBusy(false);
  };
  const removePasskey = async (id) => {
    if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
    await fetch("/api/webauthn/" + id, { method: "DELETE" }); load();
  };
  const genRecovery = async () => {
    if (sec?.recoveryRemaining > 0 && !confirm("Generate a new set? Your old recovery codes stop working immediately.")) return;
    const j = await (await fetch("/api/recovery/generate", { method: "POST" })).json();
    setCodes(j.codes); load();
  };
  const logoutAll = async () => {
    if (!confirm("Sign out every other device? This device stays signed in.")) return;
    await fetch("/api/logout-all", { method: "POST" }); setMsg("All other sessions signed out."); load();
  };
  const logout = async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); };

  return (
    <Modal title="Security" onClose={onClose}>
      {codes && (
        <div className="card" style={{ borderColor: "var(--gold)", marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>Save these recovery codes now</h3>
          <div className="note" style={{ marginTop: 0 }}>Each works once, to sign in if you lose your passkey and password. They won't be shown again.</div>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 13, margin: "8px 0" }}>
            {codes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button className="btn small" onClick={() => { navigator.clipboard?.writeText(codes.join("\n")); setMsg("Copied."); }}>Copy all</button>
          <button className="btn small" onClick={() => setCodes(null)}>I've saved them</button>
        </div>
      )}

      <h3 style={{ marginTop: 0 }}>Passkeys</h3>
      <div className="note" style={{ marginTop: 0 }}>Sign in with your fingerprint, face, or device PIN instead of a password. Phishing-resistant — the key never leaves this device.</div>
      {sec?.passkeys?.length ? sec.passkeys.map((p) => (
        <div className="row" key={p.id} style={{ justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
          <span>{p.name} <span className="note" style={{ display: "inline", margin: 0 }}>· added {(p.added || "").slice(0, 10)}</span></span>
          <button className="btn small danger" onClick={() => removePasskey(p.id)}>Remove</button>
        </div>
      )) : <div className="note">No passkeys yet.</div>}
      {browserSupportsWebAuthn() ? (
        <div className="mrow" style={{ justifyContent: "flex-start" }}><button className="btn primary" disabled={busy} onClick={addPasskey}>+ Add a passkey</button></div>
      ) : <div className="note">This browser doesn't support passkeys.</div>}

      <h3>Recovery codes</h3>
      <div className="note" style={{ marginTop: 0 }}>{sec ? sec.recoveryRemaining : "…"} unused code{sec?.recoveryRemaining === 1 ? "" : "s"} remaining.</div>
      <div className="mrow" style={{ justifyContent: "flex-start" }}><button className="btn" onClick={genRecovery}>{sec?.recoveryRemaining > 0 ? "Regenerate codes" : "Generate codes"}</button></div>

      <h3>Password</h3>
      <div className="note" style={{ marginTop: 0 }}>Changing it signs out every other device.</div>
      <div className="grid2">
        <div><label className="f">Current password</label>
          <input className="in" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div><label className="f">New password (8+ chars)</label>
          <input className="in" type="password" autoComplete="new-password" value={pw.next}
            onKeyDown={(e) => e.key === "Enter" && changePw()}
            onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
      </div>
      <div className="mrow" style={{ justifyContent: "flex-start" }}>
        <button className="btn" disabled={!pw.current || !pw.next} onClick={changePw}>Change password</button>
      </div>
      {pwMsg && <div className="note" style={{ color: pwMsg.startsWith("Password changed") ? "var(--acc)" : "var(--red)" }}>{pwMsg}</div>}

      <h3>Passkey-only sign-in</h3>
      <div className="note" style={{ marginTop: 0 }}>
        {sec?.passwordDisabled
          ? <span className="good">Password sign-in is OFF</span>
          : "Turn off password sign-in entirely — then only your passkeys (and recovery codes, as break-glass) can get in. Passwords are the phishable, guessable path; removing them is the single biggest upgrade."}
        {!sec?.passwordDisabled && <span> Requires at least one passkey and unused recovery codes.</span>}
      </div>
      <div className="mrow" style={{ justifyContent: "flex-start" }}>
        <button className="btn" onClick={async () => {
          const enabling = !!sec?.passwordDisabled; // toggling back ON
          if (!enabling && !confirm("Turn OFF password sign-in? You'll only be able to sign in with a passkey or recovery code.")) return;
          const r = await fetch("/api/security/password-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: enabling }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok) { setMsg(enabling ? "Password sign-in re-enabled." : "Password sign-in disabled — passkeys only now."); load(); }
          else setMsg(j.error || "Couldn't change the setting");
        }}>{sec?.passwordDisabled ? "Re-enable password sign-in" : "Go passkey-only"}</button>
      </div>

      <h3>Recent sign-ins</h3>
      {sec?.logins?.length ? (
        <div style={{ maxHeight: 160, overflowY: "auto" }}>
          {sec.logins.map((l, i) => (
            <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: "var(--faint)" }}>
              <span>{new Date(l.at).toLocaleString()}</span>
              <span className="mono">{l.method}</span>
              <span className="mono">{l.ip}</span>
            </div>
          ))}
        </div>
      ) : <div className="note">No sign-ins recorded yet.</div>}

      {msg && <div className="note" style={{ color: "var(--acc)" }}>{msg}</div>}
      <div className="mrow" style={{ justifyContent: "space-between", marginTop: 16 }}>
        <button className="btn danger" onClick={logoutAll}>Sign out all other devices</button>
        <div className="row">
          <button className="btn" onClick={logout}>Log out</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

function FinanceHQ({ config }) {
  const [d, setD] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [saveNonce, setSaveNonce] = useState(0); // bump to force a retry of the autosave
  const [tab, setTab] = useState("dash");
  const [showSettings, setShowSettings] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const revRef = useRef(0); // server revision of the loaded data — guards multi-device clobbering
  const loadData = async () => {
      try {
        const r = await fetch("/api/data");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        revRef.current = j.rev || 0;
        if (j.data) {
          const saved = j.data;
          setD({
            ...DEFAULTS, ...saved,
            recurring: (saved.recurring || []).map((r) => ({ freq: "m", month: 1, ...r })),
            purchases: saved.purchases || [],
            invest: { holdings: saved.invest?.holdings || [], watch: saved.invest?.watch || [] },
            txns: (saved.txns || []).map((t) => ({ kind: "out", accountId: "", ...t })),
            settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
          });
        }
        setLoaded(true);
      } catch (e) {
        /* never flip `loaded` on a failed read — autosave would write DEFAULTS over saved data */
        setLoadErr(e.message);
      }
  };
  useEffect(() => { loadData(); }, []);

  const syncNow = async () => {
    setSyncBusy(true); setSyncMsg("");
    try {
      const r = await fetch("/api/teller/sync", { method: "POST" });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      await loadData();
      setSyncMsg("Synced — " + j.newTx + " new transactions, " + j.updAcc + " balances updated.");
    } catch (e) { setSyncMsg("Sync failed — " + e.message); }
    setSyncBusy(false);
    setTimeout(() => setSyncMsg(""), 6000);
  };

  const connectBank = () => {
    const boot = () => {
      const tc = window.TellerConnect.setup({
        applicationId: config.tellerAppId,
        environment: config.tellerEnv,
        onSuccess: async (enrollment) => {
          await fetch("/api/teller/enroll", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: enrollment.accessToken, institution: enrollment.enrollment?.institution?.name || "Bank" }),
          });
          await syncNow();
        },
      });
      tc.open();
    };
    if (window.TellerConnect) return boot();
    const s = document.createElement("script");
    s.src = "https://cdn.teller.io/connect/connect.js";
    s.onload = boot;
    document.body.appendChild(s);
  };

  const removeBank = async (id) => {
    await fetch("/api/teller/" + id, { method: "DELETE" });
    await loadData();
  };

  /* data belongs to the user — one-click export, no lock-in (bank tokens never reach the client, so they can't leak here) */
  const dl = (name, content, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const csvEsc = (s) => { s = String(s ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const exportCSV = () => {
    const rows = [["date", "type", "category", "amount", "account", "note"]];
    [...d.txns].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach((t) =>
      rows.push([t.date, t.kind === "in" ? "income" : "expense", d.cats.find((c) => c.id === t.catId)?.name || "", t.amount, d.accounts.find((x) => x.id === t.accountId)?.name || "", t.note || ""]));
    dl("cache-transactions-" + today() + ".csv", rows.map((r) => r.map(csvEsc).join(",")).join("\n"), "text/csv");
  };
  const exportJSON = () => dl("cache-backup-" + today() + ".json", JSON.stringify(d, null, 2), "application/json");

  /* Autosave. A failure here used to be swallowed silently, so a save that never landed
     looked exactly like a successful one — surface it instead, and keep retrying.
     A 409 means another device saved since we loaded — pull the latest instead of clobbering it. */
  const [syncNotice, setSyncNotice] = useState("");
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/data", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: d, rev: revRef.current }) });
        if (cancelled) return;
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j.rev != null) revRef.current = j.rev;
          setSaveErr("");
        } else if (r.status === 409) {
          setSyncNotice("Another device saved changes — loaded the latest version.");
          setTimeout(() => setSyncNotice(""), 7000);
          await loadData();
        } else setSaveErr((await r.json().catch(() => ({}))).error || "Couldn't save (HTTP " + r.status + ")");
      } catch (e) { if (!cancelled) setSaveErr("Couldn't reach the server — changes aren't saved yet."); }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [d, loaded, saveNonce]);

  /* auto-log recurring transactions when their day arrives */
  useEffect(() => {
    if (!loaded || !d.recurring.length) return;
    const m = thisMonth();
    const now = new Date();
    const dayNow = now.getDate();
    const yNow = now.getFullYear();
    const missing = d.recurring.filter((r) => {
      if (r.watch) return false; // watched subscriptions arrive via bank sync/CSV — logging them here would double-count
      const day = Math.min(r.day || 1, 28);
      if ((r.freq || "m") === "m")
        return day <= dayNow && !d.txns.some((t) => t.recId === r.id && (t.date || "").startsWith(m));
      const mm = Number(r.month || 1);
      return now.getMonth() + 1 === mm && day <= dayNow &&
        !d.txns.some((t) => t.recId === r.id && (t.date || "").startsWith(yNow + "-" + String(mm).padStart(2, "0")));
    });
    if (missing.length) {
      setD((p) => ({
        ...p,
        txns: [...p.txns, ...missing.map((r) => {
          const cn = p.cats.find((c) => c.id === r.catId)?.name || "";
          return {
            id: uid(), date: m + "-" + String(Math.min(r.day || 1, 28)).padStart(2, "0"),
            catId: r.catId, amount: r.amount, kind: "out",
            note: (r.name && r.name !== cn ? r.name : cn) + " (recurring)", recId: r.id,
          };
        })],
      }));
    }
  }, [loaded, d.recurring, d.txns]);

  if (!loaded) return (
    <div className="fh" data-theme="dark"><style>{CSS}</style>
      <div className="wrap" style={{ padding: 60, color: "#93a898" }}>
        {loadErr ? <>Couldn’t load your data — {loadErr}. <button className="btn small" onClick={() => { setLoadErr(""); loadData(); }}>Retry</button></> : "Loading…"}
      </div>
    </div>
  );

  const TABS = [["dash", "Dashboard"], ["overview", "Accounts"], ["budget", "Budget"], ["invest", "Invest"], ["goals", "Goals"], ["plan", "Plan"]];

  return (
    <div className="fh" data-theme={d.settings.theme}>
      <style>{CSS}</style>
      <header>
        <div className="wrap hrow">
          <div className="brand"><Logo size={30} /><h1>Atlas</h1></div>
          <div className="tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className={"tab" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button className="btn small" title="Toggle theme" onClick={() => setD((p) => ({ ...p, settings: { ...p.settings, theme: p.settings.theme === "dark" ? "light" : "dark" } }))}>
              {d.settings.theme === "dark" ? "☀" : "☾"}
            </button>
            <button className="btn small" onClick={() => setShowSecurity(true)}>Security</button>
            <button className="btn small" onClick={() => setShowSettings(true)}>Settings</button>
          </div>
        </div>
      </header>
      <div className="wrap">
        {saveErr && (
          <div className="card" style={{ borderColor: "var(--red)", background: "var(--red-soft)", marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span><b style={{ color: "var(--red)" }}>Not saved.</b> {saveErr} Keep this tab open until it saves.</span>
              <button className="btn small" onClick={() => setSaveNonce((n) => n + 1)}>Retry now</button>
            </div>
          </div>
        )}
        {syncNotice && <div className="banner">{syncNotice}</div>}
        {tab === "dash" && <Dashboard d={d} setTab={setTab} />}
        {tab === "overview" && <Overview d={d} setD={setD} config={config} syncBusy={syncBusy} syncMsg={syncMsg} onConnect={connectBank} onSync={syncNow} onRemoveBank={removeBank} onReload={loadData} />}
        {tab === "budget" && <Budget d={d} setD={setD} config={config} />}
        {tab === "invest" && <Invest d={d} setD={setD} config={config} />}
        {tab === "goals" && <Goals d={d} setD={setD} />}
        {tab === "plan" && <Plan d={d} setD={setD} />}
      </div>
      {showSettings && (
        <Modal title="Settings" onClose={() => setShowSettings(false)}>
          <label className="f">Monthly take-home income ($)</label>
          <input className="in mono" type="number" value={d.settings.incomeMonthly}
            onChange={(e) => setD((p) => ({ ...p, settings: { ...p.settings, incomeMonthly: Number(e.target.value) || 0 } }))} />
          <div className="note">After-tax, what actually hits your account each month. Used for savings rate and defaults.</div>
          <label className="f">Assumed annual return (%) for projections</label>
          <input className="in mono" type="number" value={d.settings.expReturn}
            onChange={(e) => setD((p) => ({ ...p, settings: { ...p.settings, expReturn: Number(e.target.value) || 0 } }))} />
          <div className="note">Just an assumption for the calculators — historical broad-market averages are often cited around 7% after inflation, but you choose the number.</div>
          <label className="f">Your data</label>
          <div className="row">
            <button className="btn small" onClick={exportCSV}>Export transactions (CSV)</button>
            <button className="btn small" onClick={exportJSON}>Download backup (JSON)</button>
          </div>
          <div className="note">The JSON is everything — accounts, budgets, goals, history. Bank access tokens are never included.</div>
          <div className="mrow"><button className="btn primary" onClick={() => setShowSettings(false)}>Done</button></div>
        </Modal>
      )}
      {showSecurity && <SecurityModal onClose={() => setShowSecurity(false)} />}
    </div>
  );
}

/* ---------------- bank CSV import ---------------- */

function BankImport({ d, setD, onClose }) {
  const [rows, setRows] = useState(null); // [{date, desc, amount, credit, include, catId}]
  const [acctId, setAcctId] = useState("");
  const [credAsIncome, setCredAsIncome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fname, setFname] = useState("");

  const load = (file) => {
    setErr("");
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = bankRows(String(reader.result));
      if (!parsed.length) { setErr("Couldn't find date/description/amount columns — is this a transaction export CSV from your bank?"); return; }
      const existing = new Set(d.txns.map((t) => t.date + "|" + t.amount + "|" + (t.note || "").toLowerCase()));
      setRows(parsed.slice(0, 250).map((r) => ({
        ...r,
        include: !r.credit && !existing.has(r.date + "|" + r.amount + "|" + r.desc.toLowerCase()),
        dup: existing.has(r.date + "|" + r.amount + "|" + r.desc.toLowerCase()),
        catId: d.cats[0]?.id || "",
      })));
      setFname(file.name);
    };
    reader.readAsText(file);
  };

  const autoCat = async () => {
    setBusy(true); setErr("");
    try {
      const inc = rows.map((r, i) => ({ i, d: r.desc })).filter((x) => rows[x.i].include).slice(0, 60);
      const cats = d.cats.map((c) => c.name);
      const prompt =
        "Categorize these bank transaction descriptions into EXACTLY one of these categories: " + JSON.stringify(cats) +
        '. Transactions: ' + JSON.stringify(inc) +
        '. Respond with ONLY a JSON array (no fences): [{"i": number, "cat": string — must be one of the given categories, pick the closest}].';
      const out = await callClaude(prompt);
      const j = extractJSON(out);
      const byName = Object.fromEntries(d.cats.map((c) => [c.name.toLowerCase(), c.id]));
      setRows((p) => p.map((r, i) => {
        const hit = j.find((x) => x.i === i);
        return hit && byName[(hit.cat || "").toLowerCase()] ? { ...r, catId: byName[hit.cat.toLowerCase()] } : r;
      }));
    } catch (e) { setErr("Auto-categorize failed — " + e.message + ". Set categories manually or retry."); }
    setBusy(false);
  };

  const doImport = () => {
    const inc = rows.filter((r) => r.include);
    setD((p) => ({ ...p, txns: [...p.txns, ...inc.map((r) => ({ id: uid(), date: r.date, catId: r.credit ? "" : r.catId, amount: r.amount, note: r.desc.slice(0, 60), kind: r.credit ? "in" : "out", accountId: acctId }))] }));
    onClose(inc.length);
  };

  const nInc = rows ? rows.filter((r) => r.include).length : 0;

  return (
    <Modal title="Import bank CSV" onClose={() => onClose(0)}>
      <div className="note">
        Works with transaction exports from Chase, Capital One, Fidelity, and most banks (download from your bank's website — usually under Activity → Download/Export → CSV). Payments and credits are excluded by default; nothing here ever asks for a login.
      </div>
      {!rows && (
        <div className="mrow" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" onClick={() => document.getElementById("fh-csv").click()}>Choose CSV file</button>
          <input id="fh-csv" type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ""; }} />
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {rows && (
        <>
          <div className="row" style={{ marginTop: 8 }}>
            <select className="in" style={{ flex: 1, minWidth: 140 }} value={acctId} onChange={(e) => setAcctId(e.target.value)}>
              <option value="">Link to account: none</option>
              {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label className="note" style={{ margin: 0, display: "flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" checked={credAsIncome} onChange={(e) => {
                setCredAsIncome(e.target.checked);
                setRows((p) => p.map((r) => r.credit ? { ...r, include: e.target.checked && !r.dup } : r));
              }} /> credits as income
            </label>
          </div>
          <div className="note" style={{ marginTop: 6 }}><b>{fname}</b> — {rows.length} rows, {nInc} selected{rows.some((r) => r.dup) ? " (duplicates unchecked)" : ""}.</div>
          <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 6 }}>
            <button className="btn" disabled={busy || !nInc} onClick={autoCat}>{busy ? "Categorizing…" : "Auto-categorize ✨"}</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto", marginTop: 8, border: "1px solid var(--line)", borderRadius: 10, padding: "4px 10px" }}>
            {rows.map((r, i) => (
              <div key={i} className="row" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", opacity: r.include ? 1 : 0.45 }}>
                <input type="checkbox" checked={r.include} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                <span className="mono" style={{ fontSize: 12, width: 44 }}>{r.date.slice(5)}</span>
                <span style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.desc}>{r.desc}{r.dup ? " ·dup" : ""}{r.credit ? " ·credit" : ""}</span>
                <span className="mono" style={{ fontSize: 12.5 }}>{fmt(r.amount)}</span>
                <select className="in" style={{ width: 110, padding: "2px 6px", fontSize: 12 }} value={r.catId}
                  onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, catId: e.target.value } : x))}>
                  {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="mrow">
            <button className="btn" onClick={() => onClose(0)}>Cancel</button>
            <button className="btn primary" disabled={!nInc} onClick={doImport}>Import {nInc} transactions</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------------- recurring transactions ---------------- */

function Recurring({ d, setD }) {
  const [nr, setNr] = useState({ name: "", catId: d.cats[0]?.id || "", amount: "", freq: "m", day: 1, month: 1 });
  const catName = (id) => d.cats.find((c) => c.id === id)?.name || "?";
  const ord = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
  return (
    <div className="card">
      <h3>Recurring</h3>
      <div className="note">Rent, subscriptions, insurance — each one logs its transaction automatically when its day comes. Nothing to re-enter.</div>
      {d.recurring.map((r) => {
        const cn = catName(r.catId);
        const label = r.name && r.name !== cn ? r.name : cn;
        const sched = (r.freq || "m") === "m"
          ? "every month on the " + ord(r.day || 1)
          : "every year · " + MONTH_NAMES[(r.month || 1) - 1] + " " + (r.day || 1);
        return (
          <div className="kv" key={r.id}>
            <span className="k"><b style={{ color: "var(--text)" }}>{label}</b>
              <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · {label !== cn ? cn + " · " : ""}{sched}</span>
              {r.watch && <span className="tag" style={{ marginLeft: 5 }} title="Shown in Upcoming bills; the actual charges come from bank sync / CSV import">watched</span>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="mono">{fmt(r.amount)}{(r.freq || "m") === "m" ? "/mo" : "/yr"}</span>
              <button className="x" onClick={() => setD((p) => ({ ...p, recurring: p.recurring.filter((x) => x.id !== r.id) }))}>✕</button>
            </span>
          </div>
        );
      })}
      {!d.recurring.length && <div className="note">Nothing recurring yet.</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <select className="in" style={{ flex: 1, minWidth: 110 }} value={nr.catId} onChange={(e) => setNr({ ...nr, catId: e.target.value })}>
          {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="in" style={{ flex: 1.4, minWidth: 130 }} placeholder="Name (optional)" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} />
        <input className="in mono" type="number" style={{ width: 90 }} placeholder="$" value={nr.amount} onChange={(e) => setNr({ ...nr, amount: e.target.value })} />
        <select className="in" style={{ width: 100 }} value={nr.freq} onChange={(e) => setNr({ ...nr, freq: e.target.value })}>
          <option value="m">Monthly</option>
          <option value="y">Yearly</option>
        </select>
        {nr.freq === "y" && (
          <select className="in" style={{ width: 110 }} value={nr.month} onChange={(e) => setNr({ ...nr, month: Number(e.target.value) })}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        )}
        <select className="in" style={{ width: 92 }} value={nr.day} title="Day of month" onChange={(e) => setNr({ ...nr, day: Number(e.target.value) })}>
          {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{ord(i + 1)}</option>)}
        </select>
        <button className="btn small primary" onClick={() => {
          if (!nr.amount) return;
          setD((p) => ({ ...p, recurring: [...p.recurring, { id: uid(), ...nr, amount: Number(nr.amount) }] }));
          setNr({ name: "", catId: nr.catId, amount: "", freq: "m", day: 1, month: 1 });
        }}>Add</button>
      </div>
    </div>
  );
}

/* ---------------- subscription radar ---------------- */

/* normalize a bank description to a merchant key: "NETFLIX.COM 0231 CA" and
   "Netflix.com 0198" should land in the same bucket */
const normMerchant = (note) =>
  (note || "").toLowerCase().replace(/\(recurring\)/g, "").replace(/[#*\d]+/g, " ").replace(/[^a-z& ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 28);

/* find charges that repeat ~monthly with a stable amount (à la Rocket Money) */
function detectSubscriptions(d) {
  const ignored = d.settings.subIgnore || [];
  const tracked = new Set(d.recurring.map((r) => normMerchant(r.name || d.cats.find((c) => c.id === r.catId)?.name || "")));
  const groups = {};
  d.txns.filter((t) => t.kind !== "in" && !t.recId && t.note).forEach((t) => {
    const k = normMerchant(t.note);
    if (k.length >= 3) (groups[k] = groups[k] || []).push(t);
  });
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return Object.entries(groups).map(([key, txs]) => {
    if (txs.length < 3 || ignored.includes(key) || tracked.has(key)) return null;
    const dates = txs.map((t) => new Date(t.date).getTime()).sort((a, b) => a - b);
    const gap = med(dates.slice(1).map((v, i) => (v - dates[i]) / 864e5));
    if (gap < 25 || gap > 35) return null;                                   // monthly cadence only
    const amts = txs.map((t) => Number(t.amount) || 0);
    const amount = med(amts);
    if (Math.max(...amts) - Math.min(...amts) > Math.max(2, amount * 0.25)) return null; // stable amount only
    const byCat = {};
    txs.forEach((t) => { if (t.catId) byCat[t.catId] = (byCat[t.catId] || 0) + 1; });
    return {
      key, name: (txs[txs.length - 1].note || key).replace(/\(recurring\)/g, "").trim().slice(0, 30),
      amount: Math.round(amount * 100) / 100,
      day: Math.min(med(txs.map((t) => Number((t.date || "").slice(8, 10)) || 1)), 28),
      catId: Object.entries(byCat).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
      count: txs.length,
    };
  }).filter(Boolean).sort((a, b) => b.amount - a.amount);
}

function SubscriptionRadar({ d, setD }) {
  const found = useMemo(() => detectSubscriptions(d), [d.txns, d.recurring, d.settings.subIgnore]);
  if (!found.length) return null;
  const total = found.reduce((s, f) => s + f.amount, 0);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Subscription radar</h3>
        <span className="note" style={{ margin: 0 }}>~<b className="mono">{fmt(total)}</b>/mo detected</span>
      </div>
      <div className="note">Charges that repeat monthly at a stable amount. "Watch" adds one to Upcoming bills without double-logging it (the charges keep arriving via sync/CSV as they do now). This is also the list to prune — every line is money leaving on autopilot.</div>
      {found.map((f) => (
        <div className="kv" key={f.key}>
          <span className="k"><b style={{ color: "var(--text)" }}>{f.name}</b>
            <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · seen {f.count}× · ~day {f.day}</span></span>
          <span className="row" style={{ gap: 6 }}>
            <span className="mono">{fmt(f.amount)}/mo</span>
            <button className="btn small" onClick={() => setD((p) => ({ ...p, recurring: [...p.recurring, { id: uid(), name: f.name, catId: f.catId || p.cats[0]?.id || "", amount: f.amount, freq: "m", day: f.day, watch: true }] }))}>Watch</button>
            <button className="x" title="Not a subscription — hide" onClick={() => setD((p) => ({ ...p, settings: { ...p.settings, subIgnore: [...(p.settings.subIgnore || []), f.key] } }))}>✕</button>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Invest tab ---------------- */

/* Fidelity (and similar) positions-export CSV: needs a Symbol column and a Quantity column */
function parseHoldingsCSV(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => /symbol/i.test(c)) && r.some((c) => /quantity|shares/i.test(c)));
  if (hi === -1) return [];
  const head = rows[hi].map((h) => h.trim().toLowerCase());
  const iSym = head.findIndex((h) => h.includes("symbol"));
  const iQty = head.findIndex((h) => h.includes("quantity") || h.includes("shares"));
  const iCost = head.findIndex((h) => h.includes("cost basis total") || h.includes("cost basis"));
  const num = (s) => Number(String(s || "").replace(/[$,%"]/g, "")) || 0;
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const sym = String(r[iSym] || "").trim().toUpperCase().replace(/\*+$/, "");
    const shares = num(r[iQty]);
    if (!/^[A-Z0-9.^-]{1,10}$/.test(sym) || shares <= 0) continue; // skips cash rows, footers, disclaimers
    out.push({ symbol: sym, shares, cost: iCost !== -1 ? num(r[iCost]) : 0 });
  }
  return out;
}

const MARKET = [["SPY", "S&P 500"], ["QQQ", "Nasdaq 100"], ["DIA", "Dow Jones"]];

function Invest({ d, setD, config }) {
  const holdings = d.invest.holdings, watch = d.invest.watch;
  const [quotes, setQuotes] = useState({});
  const [busy, setBusy] = useState(false);
  const [qErr, setQErr] = useState("");
  const [nh, setNh] = useState({ symbol: "", shares: "", cost: "" });
  const [nw, setNw] = useState("");
  const [syncAcct, setSyncAcct] = useState("");
  const [brief, setBrief] = useState("");
  const [briefBusy, setBriefBusy] = useState(false);
  const [impMsg, setImpMsg] = useState("");

  const allSyms = [...new Set([...MARKET.map(([s]) => s), ...holdings.map((h) => h.symbol), ...watch])];
  const symsKey = allSyms.join(",");
  const refresh = async () => {
    if (!allSyms.length) return;
    setBusy(true); setQErr("");
    try {
      const r = await fetch("/api/quotes?symbols=" + encodeURIComponent(symsKey));
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setQuotes((p) => ({ ...p, ...j.quotes }));
    } catch (e) { setQErr("Quotes unavailable — " + e.message); }
    setBusy(false);
  };
  useEffect(() => { refresh(); }, [symsKey]);

  const px = (s) => quotes[s]?.price ?? null;
  const dayPct = (s) => { const q = quotes[s]; return q?.price && q?.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null; };

  const rows = holdings.map((h) => {
    const p = px(h.symbol), prev = quotes[h.symbol]?.prevClose;
    const value = p != null ? p * h.shares : null;
    return { ...h, price: p, name: quotes[h.symbol]?.name || "", value, day: p != null && prev ? (p - prev) * h.shares : null, gain: value != null && h.cost > 0 ? value - h.cost : null };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));
  const totValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  const totDay = rows.reduce((s, r) => s + (r.day || 0), 0);
  const totCost = rows.filter((r) => r.cost > 0 && r.value != null).reduce((s, r) => s + r.cost, 0);
  const totCostVal = rows.filter((r) => r.cost > 0 && r.value != null).reduce((s, r) => s + r.value, 0);
  const totGain = totCost > 0 ? totCostVal - totCost : null;
  const alloc = rows.filter((r) => r.value > 0).map((r, ) => ({ name: r.symbol, value: Math.round(r.value), color: seriesColor(holdings.findIndex((h) => h.symbol === r.symbol)) }));
  const allocData = alloc.length > 7 ? [...alloc.slice(0, 6), { name: "Other", value: alloc.slice(6).reduce((s, x) => s + x.value, 0), color: "var(--faint)" }] : alloc;

  const addHolding = () => {
    const sym = nh.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.^-]{1,10}$/.test(sym) || !Number(nh.shares)) return;
    setD((p) => {
      const hs = [...p.invest.holdings];
      const i = hs.findIndex((h) => h.symbol === sym);
      const entry = { id: i === -1 ? uid() : hs[i].id, symbol: sym, shares: Number(nh.shares), cost: Number(nh.cost) || 0 };
      if (i === -1) hs.push(entry); else hs[i] = entry;
      return { ...p, invest: { ...p.invest, holdings: hs } };
    });
    setNh({ symbol: "", shares: "", cost: "" });
  };

  const importFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseHoldingsCSV(String(reader.result));
      if (!parsed.length) { setImpMsg("Couldn't find Symbol/Quantity columns — is this a positions export?"); return; }
      setD((p) => {
        const hs = [...p.invest.holdings];
        for (const n of parsed) {
          const i = hs.findIndex((h) => h.symbol === n.symbol);
          if (i === -1) hs.push({ id: uid(), ...n });
          else hs[i] = { ...hs[i], shares: n.shares, cost: n.cost || hs[i].cost };
        }
        return { ...p, invest: { ...p.invest, holdings: hs } };
      });
      setImpMsg("Imported " + parsed.length + " positions."); setTimeout(() => setImpMsg(""), 5000);
    };
    reader.readAsText(file);
  };

  const invAccounts = d.accounts.filter((a) => INVESTED.includes(a.type));
  const marketBrief = async () => {
    setBriefBusy(true);
    try {
      const syms = [...new Set([...holdings.map((h) => h.symbol), ...watch])].slice(0, 12);
      const prompt = "Use web search. Write a brief market note for today: one short paragraph on overall US market conditions (major indexes, notable macro drivers)" +
        (syms.length ? ", then one line each on recent news/moves for: " + syms.join(", ") : "") +
        ". Under 220 words, plain text. Neutral and educational — describe what is happening; do not tell the reader to buy or sell anything.";
      setBrief(await callClaude(prompt, true));
    } catch (e) { setBrief("Brief failed — " + e.message); }
    setBriefBusy(false);
  };

  const Delta = ({ v, suffix = "%" }) => v == null ? <span style={{ color: "var(--faint)" }}>—</span> :
    <span className={v >= 0 ? "good" : "bad"}>{v >= 0 ? "▲" : "▼"} {Math.abs(v).toFixed(2)}{suffix}</span>;

  return (
    <>
      <div className="grid3">
        {MARKET.map(([sym, label]) => (
          <div className="card" key={sym}>
            <div className="note" style={{ margin: 0 }}>{label} <span className="tag">{sym}</span></div>
            <div className="big mono" style={{ fontSize: 24 }}>{fmt2(px(sym))}</div>
            <div style={{ fontSize: 12.5, marginTop: 2 }}><Delta v={dayPct(sym)} /> <span style={{ color: "var(--faint)" }}>today</span></div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Portfolio</h3>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={busy} onClick={refresh}>{busy ? "Refreshing…" : "↻ Refresh quotes"}</button>
            <button className="btn small" onClick={() => document.getElementById("inv-csv").click()}>Import positions CSV</button>
            <input id="inv-csv" type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; }} />
          </span>
        </div>
        <div className="note" style={{ marginTop: 2 }}>Fidelity isn't covered by bank sync — export Positions as CSV from fidelity.com and import it here, or add holdings manually. Prices are delayed quotes, refreshed on demand.</div>
        {impMsg && <div className="note good">{impMsg}</div>}
        {qErr && <div className="err">{qErr}</div>}

        {rows.length > 0 && (
          <div className="grid4" style={{ margin: "12px 0 4px" }}>
            <div><div className="note" style={{ margin: 0 }}>Value</div><div className="big mono" style={{ fontSize: 22 }}>{fmt(totValue)}</div></div>
            <div><div className="note" style={{ margin: 0 }}>Today</div><div className="big mono" style={{ fontSize: 22, color: totDay >= 0 ? "var(--up)" : "var(--red)" }}>{(totDay >= 0 ? "+" : "") + fmt(totDay)}</div></div>
            <div><div className="note" style={{ margin: 0 }}>Gain vs basis</div><div className="big mono" style={{ fontSize: 22, color: totGain == null ? "var(--faint)" : totGain >= 0 ? "var(--up)" : "var(--red)" }}>{totGain == null ? "—" : (totGain >= 0 ? "+" : "") + fmt(totGain)}</div></div>
            <div><div className="note" style={{ margin: 0 }}>Positions</div><div className="big mono" style={{ fontSize: 22 }}>{rows.length}</div></div>
          </div>
        )}

        <div className="irow" style={{ borderBottom: "1px solid var(--line2)", fontWeight: 600, color: "var(--faint)", fontSize: 12 }}>
          <span>Symbol</span><span>Shares</span><span>Price</span><span className="iday">Today</span><span>Value</span><span className="igain">Gain</span><span />
        </div>
        {rows.map((r) => (
          <div className="irow" key={r.id}>
            <span><b className="mono">{r.symbol}</b> <span style={{ color: "var(--faint)", fontSize: 11.5 }}>{r.name.slice(0, 22)}</span></span>
            <span className="mono">{r.shares}</span>
            <span className="mono">{fmt2(r.price)}</span>
            <span className="iday" style={{ fontSize: 12.5 }}><Delta v={dayPct(r.symbol)} /></span>
            <span className="mono">{fmt(r.value)}</span>
            <span className="igain mono" style={{ fontSize: 12.5, color: r.gain == null ? "var(--faint)" : r.gain >= 0 ? "var(--up)" : "var(--red)" }}>{r.gain == null ? "—" : (r.gain >= 0 ? "+" : "") + fmt(r.gain)}</span>
            <button className="x" onClick={() => setD((p) => ({ ...p, invest: { ...p.invest, holdings: p.invest.holdings.filter((h) => h.id !== r.id) } }))}>✕</button>
          </div>
        ))}
        {!rows.length && <div className="note">No holdings yet — add a ticker below or import a positions CSV.</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <input className="in mono" style={{ width: 110 }} placeholder="Ticker" value={nh.symbol}
            onChange={(e) => setNh({ ...nh, symbol: e.target.value.toUpperCase() })} onKeyDown={(e) => e.key === "Enter" && addHolding()} />
          <input className="in mono" type="number" style={{ width: 110 }} placeholder="Shares" value={nh.shares} onChange={(e) => setNh({ ...nh, shares: e.target.value })} />
          <input className="in mono" type="number" style={{ width: 150 }} placeholder="Cost basis $ (opt.)" title="Total amount paid for the whole position" value={nh.cost} onChange={(e) => setNh({ ...nh, cost: e.target.value })} />
          <button className="btn small primary" onClick={addHolding}>Add / update</button>
        </div>
        {rows.length > 0 && invAccounts.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="note" style={{ margin: 0 }}>Push value to account:</span>
            <select className="in" style={{ width: 200 }} value={syncAcct} onChange={(e) => setSyncAcct(e.target.value)}>
              <option value="">— choose account —</option>
              {invAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button className="btn small" disabled={!syncAcct || !totValue} onClick={() => {
              setD((p) => ({ ...p, accounts: p.accounts.map((a) => a.id === syncAcct ? { ...a, balance: Math.round(totValue * 100) / 100 } : a) }));
            }}>Set balance = {fmt(totValue)}</button>
          </div>
        )}
      </div>

      {allocData.length >= 2 && (
        <div className="card">
          <h3>Allocation</h3>
          <div style={{ marginTop: 10 }}><Donut data={allocData} centerTop={fmt(totValue)} centerBottom="portfolio" /></div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Watchlist</h3>
          <span className="row">
            <input className="in mono" style={{ width: 100, padding: "4px 9px" }} placeholder="Ticker" value={nw}
              onChange={(e) => setNw(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter" && /^[A-Z0-9.^-]{1,10}$/.test(nw.trim()) && !watch.includes(nw.trim())) { setD((p) => ({ ...p, invest: { ...p.invest, watch: [...p.invest.watch, nw.trim()] } })); setNw(""); } }} />
            <span className="note" style={{ margin: 0 }}>enter ↵</span>
          </span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {watch.map((s) => (
            <span className="chip" key={s}>
              <b className="mono">{s}</b>
              <span className="mono" style={{ color: "var(--muted)" }}>{fmt2(px(s))}</span>
              <Delta v={dayPct(s)} />
              <button className="x" style={{ fontSize: 12, padding: 0 }} onClick={() => setD((p) => ({ ...p, invest: { ...p.invest, watch: p.invest.watch.filter((x) => x !== s) } }))}>✕</button>
            </span>
          ))}
          {!watch.length && <span className="note" style={{ margin: 0 }}>Add tickers you're keeping an eye on — quotes load with the rest.</span>}
        </div>
      </div>

      {config?.aiEnabled && (
        <div className="card">
          <h3>Market brief</h3>
          <div className="note">A web-searched snapshot of what's moving markets today, plus one-liners on your tickers. Informational only — not advice, and worth double-checking like anything else on the internet.</div>
          <div className="mrow" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" disabled={briefBusy} onClick={marketBrief}>{briefBusy ? "Researching…" : brief ? "Refresh brief" : "Get today's brief"}</button>
          </div>
          {brief && <div className="aiout">{brief}</div>}
        </div>
      )}
    </>
  );
}

/* ---------------- order of operations + debt payoff ---------------- */

function simulate(debts, extra, order) {
  let ds = debts.map((x) => ({ ...x }));
  const totalMin = ds.reduce((s, x) => s + x.minPay, 0);
  const aprOf = (x, m) => (x.promoMonths && m <= x.promoMonths ? x.promoApr : x.apr);
  let months = 0, interest = 0;
  while (ds.some((x) => x.bal > 0.01) && months < 600) {
    months++;
    ds.forEach((x) => { if (x.bal > 0) { const i = x.bal * aprOf(x, months) / 1200; interest += i; x.bal += i; } });
    let budget = totalMin + extra;
    const m = months;
    const sorted = [...ds].filter((x) => x.bal > 0).sort((a, b) => order({ ...a, apr: aprOf(a, m) }, { ...b, apr: aprOf(b, m) }));
    // minimums first
    sorted.forEach((x) => { const pay = Math.min(x.minPay, x.bal, budget); x.bal -= pay; budget -= pay; });
    // leftovers to target
    for (const x of sorted) { if (budget <= 0) break; const pay = Math.min(budget, x.bal); x.bal -= pay; budget -= pay; }
  }
  return { months, interest: Math.round(interest), done: months < 600 };
}

function DebtPayoff({ d, setD }) {
  const [extra, setExtra] = useState(100);
  const debts = d.accounts.filter((a) => isDebt(a) && Number(a.balance) > 0);
  const setAcc = (id, k, v) => setD((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === id ? { ...a, [k]: v } : a)) }));
  if (!debts.length)
    return <div className="card"><h3>Debt payoff</h3><div className="note good">No debt balances on the books — nothing to pay off. ✓</div></div>;
  const ready = debts.every((a) => Number(a.rate) > 0 && Number(a.minPay) > 0);
  const mapDebt = (a) => ({
    bal: Number(a.balance), apr: Number(a.rate), minPay: Number(a.minPay),
    promoApr: a.promoEnds && a.promoApr !== "" && a.promoApr != null ? Number(a.promoApr) : null,
    promoMonths: a.promoEnds ? Math.max(0, Math.ceil((new Date(a.promoEnds) - new Date()) / (30.44 * 864e5))) : 0,
  });
  const sim = ready ? {
    av: simulate(debts.map(mapDebt), Number(extra) || 0, (x, y) => y.apr - x.apr),
    sn: simulate(debts.map(mapDebt), Number(extra) || 0, (x, y) => x.bal - y.bal),
  } : null;
  return (
    <div className="card">
      <h3>Debt payoff</h3>
      {debts.map((a) => {
        const promoDays = a.promoEnds ? Math.ceil((new Date(a.promoEnds) - new Date()) / 864e5) : null;
        const promoLive = promoDays != null && promoDays > 0 && a.promoApr !== "" && a.promoApr != null;
        return (
        <div key={a.id} style={{ borderBottom: "1px solid var(--line)", padding: "6px 0" }}>
          <div className="kv" style={{ border: "none", padding: 0 }}>
            <span className="k">{a.name} <span className="mono" style={{ fontSize: 12 }}>{fmt(a.balance)}</span>
              {promoLive && (
                <span className="tag" style={promoDays <= 60 ? { color: "var(--red)", borderColor: "var(--red)" } : { color: "var(--gold)", borderColor: "var(--gold)" }}>
                  promo {a.promoApr}% {promoDays <= 60 ? "ends in " + promoDays + "d!" : "until " + a.promoEnds}
                </span>
              )}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <input className="in mono" type="number" step="0.1" style={{ width: 74, padding: "3px 7px" }} placeholder="APR %" title="Regular APR (after any promo)" value={a.rate ?? ""} onChange={(e) => setAcc(a.id, "rate", e.target.value)} />
              <input className="in mono" type="number" style={{ width: 84, padding: "3px 7px" }} placeholder="Min/mo" value={a.minPay ?? ""} onChange={(e) => setAcc(a.id, "minPay", e.target.value)} />
            </span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <span className="note" style={{ margin: 0 }}>Promo:</span>
            <input className="in mono" type="number" step="0.1" style={{ width: 74, padding: "3px 7px" }} placeholder="promo %" title="Promotional APR (e.g. 0)" value={a.promoApr ?? ""} onChange={(e) => setAcc(a.id, "promoApr", e.target.value)} />
            <input className="in mono" type="date" style={{ width: 140, padding: "3px 7px" }} title="Promo end date" value={a.promoEnds ?? ""} onChange={(e) => setAcc(a.id, "promoEnds", e.target.value)} />
            <span className="note" style={{ margin: 0, fontSize: 11 }}>leave blank if none</span>
          </div>
        </div>
        );
      })}
      <div className="row" style={{ marginTop: 10 }}>
        <label className="f" style={{ margin: 0 }}>Extra toward debt ($/mo)</label>
        <input className="in mono" type="number" style={{ width: 100 }} value={extra} onChange={(e) => setExtra(e.target.value)} />
      </div>
      {!ready && <div className="note">Fill in APR and minimum payment for each debt to compare strategies.</div>}
      {sim && (
        <>
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">Avalanche <span style={{ fontSize: 11.5 }}>(highest APR first)</span></span>
            <span className="mono">{sim.av.done ? sim.av.months + " mo · " + fmt(sim.av.interest) + " interest" : "600+ mo — payments don't cover interest"}</span>
          </div>
          <div className="kv">
            <span className="k">Snowball <span style={{ fontSize: 11.5 }}>(smallest balance first)</span></span>
            <span className="mono">{sim.sn.done ? sim.sn.months + " mo · " + fmt(sim.sn.interest) + " interest" : "600+ mo — payments don't cover interest"}</span>
          </div>
          {sim.av.done && sim.sn.done && (
            <div className="note">
              Avalanche saves <b className="mono good">{fmt(Math.max(0, sim.sn.interest - sim.av.interest))}</b> in interest; snowball clears individual debts sooner, which keeps some people going. Math favors avalanche — momentum favors snowball.{debts.some((a) => a.promoEnds && a.promoApr != null && a.promoApr !== "") ? " Promo rates are simulated until their end dates, then switch to the regular APR." : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PurchasePlanner({ d, setD }) {
  const [np, setNp] = useState({ name: "", cost: "", by: "", monthly: "" });
  const income = Number(d.settings.incomeMonthly) || 0;
  const kept = Math.max(0, income - avgMonthlySpend(d.txns));
  return (
    <div className="card">
      <h3>Purchase planner</h3>
      <div className="note">Big purchases, planned instead of impulsed. Give a target date to see the required monthly, or a monthly amount to see the date.</div>
      {(d.purchases || []).map((p) => {
        const months = p.by ? Math.max(1, Math.ceil((new Date(p.by) - new Date()) / (30.44 * 864e5))) : p.monthly > 0 ? Math.ceil(p.cost / p.monthly) : null;
        const perMo = p.by ? p.cost / months : Number(p.monthly) || 0;
        const eta = !p.by && months ? new Date(Date.now() + months * 30.44 * 864e5).toISOString().slice(0, 7) : null;
        const share = kept > 0 ? Math.round((perMo / kept) * 100) : null;
        return (
          <div className="kv" key={p.id}>
            <span className="k"><b style={{ color: "var(--text)" }}>{p.name}</b>
              <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · {fmt(p.cost)}{p.by ? " by " + p.by : eta ? " → ready ~" + monthLabel(eta) : ""}</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="mono" style={{ color: share != null && share > 100 ? "var(--red)" : "var(--text)" }}>{fmt(Math.round(perMo))}/mo{share != null ? " · " + share + "% of kept" : ""}</span>
              <button className="x" onClick={() => setD((q) => ({ ...q, purchases: q.purchases.filter((x) => x.id !== p.id) }))}>✕</button>
            </span>
          </div>
        );
      })}
      {!(d.purchases || []).length && <div className="note">Nothing planned yet.</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <input className="in" style={{ flex: 1.3, minWidth: 120 }} placeholder="What (e.g. used car, PC)" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
        <input className="in mono" type="number" style={{ width: 90 }} placeholder="Cost $" value={np.cost} onChange={(e) => setNp({ ...np, cost: e.target.value })} />
        <input className="in mono" type="date" style={{ width: 140 }} title="Target date (optional)" value={np.by} onChange={(e) => setNp({ ...np, by: e.target.value })} />
        <input className="in mono" type="number" style={{ width: 90 }} placeholder="$/mo" title="Monthly saving (optional)" value={np.monthly} onChange={(e) => setNp({ ...np, monthly: e.target.value })} />
        <button className="btn small primary" onClick={() => {
          if (!np.name.trim() || !np.cost) return;
          setD((q) => ({ ...q, purchases: [...(q.purchases || []), { id: uid(), name: np.name.trim(), cost: Number(np.cost), by: np.by, monthly: Number(np.monthly) || 0 }] }));
          setNp({ name: "", cost: "", by: "", monthly: "" });
        }}>Add</button>
      </div>
      {kept > 0 && <div className="note">"% of kept" compares against what you keep monthly (income − avg spending ≈ {fmt(Math.round(kept))}). Over 100% means it can't fit without cuts.</div>}
    </div>
  );
}

function OrderOfOps({ d, k401ok }) {
  const s = d.settings;
  const liq = liquid(d.accounts);
  const avg = avgMonthlySpend(d.txns);
  const efTarget = avg * s.efMonths;
  const highDebt = d.accounts.filter((a) => a.type === "Credit card" && Number(a.balance) > 0);
  const taxAdv = d.accounts.filter((a) => ["401k", "IRA / Roth"].includes(a.type)).reduce((x, a) => x + Number(a.balance || 0), 0);
  const brokerage = d.accounts.filter((a) => a.type === "Brokerage").reduce((x, a) => x + Number(a.balance || 0), 0);
  const steps = [
    { name: "Capture the full 401k match", done: k401ok, note: "It's an instant 50–100% return — nothing else competes. Set it in the calculator above." },
    { name: "Kill high-interest debt", done: highDebt.length === 0, note: highDebt.length ? "Credit card balances usually cost ~20%+ APR — more than markets are expected to return. Payoff plan below." : "No credit card balances carried. ✓" },
    { name: "Emergency fund", done: efTarget > 0 && liq >= efTarget, note: efTarget > 0 ? fmt(liq) + " of " + fmt(efTarget) + " (" + s.efMonths + " months of your actual spending)" : "Log spending so the target computes." },
    { name: "Fill tax-advantaged accounts", done: taxAdv > 0, note: "401k beyond the match, IRA/Roth — commonly evaluated on contribution limits and tax treatment. Balance so far: " + fmt(taxAdv) },
    { name: "Taxable investing", done: brokerage > 0, note: "Brokerage, after the above. When comparing funds, people typically weigh expense ratios, diversification, and what index is tracked." },
  ];
  const cur = steps.findIndex((x) => !x.done);
  return (
    <div className="card">
      <h3>Money order of operations</h3>
      <div className="note">A widely used prioritization framework with your actual numbers plugged in. Where the arrow points is where the next dollar generally does the most work.</div>
      {steps.map((st, i) => (
        <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)", opacity: cur !== -1 && i > cur ? 0.55 : 1 }}>
          <div className="row">
            <span style={{ width: 22, fontWeight: 700, color: st.done ? "var(--acc)" : i === cur ? "var(--gold)" : "var(--faint)" }}>
              {st.done ? "✓" : i === cur ? "→" : "○"}
            </span>
            <b>{st.name}</b>
            {i === cur && <span className="warn" style={{ fontSize: 12 }}>you are here</span>}
          </div>
          <div className="note" style={{ marginTop: 2, marginLeft: 22 }}>{st.note}</div>
        </div>
      ))}
      {cur === -1 && <div className="note good" style={{ marginTop: 8 }}>All five boxes checked. At that point it's allocation and patience.</div>}
    </div>
  );
}



/* ---------------- dashboard ---------------- */

const RANGES = [["m", "This month"], ["3m", "3 mo"], ["6m", "6 mo"], ["ytd", "YTD"], ["all", "All"]];

function rangeStart(r) {
  const now = new Date();
  if (r === "m") return thisMonth() + "-01";
  if (r === "3m") return dstr(new Date(now - 90 * 864e5));
  if (r === "6m") return dstr(new Date(now - 182 * 864e5));
  if (r === "ytd") return now.getFullYear() + "-01-01";
  return "0000-01-01";
}

function nextOccurrence(rec) {
  const now = new Date();
  const day = Math.min(rec.day || 1, 28);
  if ((rec.freq || "m") === "m") {
    let d2 = new Date(now.getFullYear(), now.getMonth(), day);
    if (d2 < now.setHours(0, 0, 0, 0)) d2 = new Date(now.getFullYear(), now.getMonth() + 1, day);
    return d2;
  }
  let d2 = new Date(now.getFullYear(), (rec.month || 1) - 1, day);
  if (d2 < new Date().setHours(0, 0, 0, 0)) d2 = new Date(now.getFullYear() + 1, (rec.month || 1) - 1, day);
  return d2;
}

function Dashboard({ d, setTab }) {
  const [range, setRange] = useState("3m");
  const start = rangeStart(range);
  const tx = d.txns.filter((t) => (t.date || "") >= start);
  const spend = tx.filter((t) => t.kind !== "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const inSum = tx.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const monthsN = range === "m" ? 1 : range === "3m" ? 3 : range === "6m" ? 6 : range === "ytd" ? new Date().getMonth() + 1 : Math.max(1, new Set(d.txns.map((t) => (t.date || "").slice(0, 7))).size);
  const income = inSum > 0 ? inSum : (Number(d.settings.incomeMonthly) || 0) * monthsN;
  const net = income - spend;
  const rate = income > 0 ? Math.round((net / income) * 100) : null;

  const { assets, debts, nw } = netWorth(d.accounts);
  const hist = d.history.filter((h) => h.date >= start).map((h) => ({ date: h.date.slice(5), nw: h.nw }));

  /* income vs spending by month */
  const months = [];
  for (let i = Math.min(monthsN, 12) - 1; i >= 0; i--) {
    const dt = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
    const key = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0"); // local, not UTC — toISOString shifts the month east of Greenwich
    const mt = d.txns.filter((t) => (t.date || "").startsWith(key));
    const mIn = mt.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
    months.push({
      m: MONTH_NAMES[dt.getMonth()].slice(0, 3),
      Income: Math.round(mIn > 0 ? mIn : Number(d.settings.incomeMonthly) || 0),
      Spending: Math.round(mt.filter((t) => t.kind !== "in").reduce((s, t) => s + (Number(t.amount) || 0), 0)),
    });
  }

  /* category breakdown — color follows the CATEGORY (stable index in d.cats), never its rank */
  const byCat = {};
  tx.filter((t) => t.kind !== "in").forEach((t) => { byCat[t.catId] = (byCat[t.catId] || 0) + (Number(t.amount) || 0); });
  const catRows = Object.entries(byCat)
    .map(([id, v]) => ({
      name: d.cats.find((c) => c.id === id)?.name || (id ? "?" : "Uncategorized"),
      value: Math.round(v),
      color: seriesColor(d.cats.findIndex((c) => c.id === id)),
    }))
    .sort((a, b) => b.value - a.value);
  const donutData = catRows.length > 7
    ? [...catRows.slice(0, 6), { name: "Other", value: catRows.slice(6).reduce((s, x) => s + x.value, 0), color: "var(--faint)" }]
    : catRows;

  /* upcoming bills (30d) */
  const upcoming = d.recurring
    .map((r) => ({ r, when: nextOccurrence(r) }))
    .filter((x) => (x.when - new Date()) / 864e5 <= 30)
    .sort((a, b) => a.when - b.when)
    .slice(0, 6);

  /* budget progress (current month) */
  const mKey = thisMonth();
  const prog = d.cats.filter((c) => Number(c.limit) > 0).map((c) => {
    const sp = d.txns.filter((t) => t.kind !== "in" && t.catId === c.id && (t.date || "").startsWith(mKey)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    return { name: c.name, sp, lim: Number(c.limit), pct: Math.min(100, Math.round((sp / Number(c.limit)) * 100)) };
  }).sort((a, b) => b.pct - a.pct).slice(0, 5);

  /* month-over-month movers + largest expenses (Copilot-style insights) */
  const prevKey = (() => { const [y, m] = mKey.split("-").map(Number); const p = new Date(y, m - 2, 1); return p.getFullYear() + "-" + String(p.getMonth() + 1).padStart(2, "0"); })();
  const catSpend = (key) => {
    const out = {};
    d.txns.filter((t) => t.kind !== "in" && (t.date || "").startsWith(key)).forEach((t) => { out[t.catId || ""] = (out[t.catId || ""] || 0) + (Number(t.amount) || 0); });
    return out;
  };
  const curCat = catSpend(mKey), prevCat = catSpend(prevKey);
  const movers = [...new Set([...Object.keys(curCat), ...Object.keys(prevCat)])]
    .map((id) => ({ name: d.cats.find((c) => c.id === id)?.name || (id ? "?" : "Uncategorized"), now: curCat[id] || 0, delta: (curCat[id] || 0) - (prevCat[id] || 0) }))
    .filter((x) => Math.abs(x.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
  const biggest = tx.filter((t) => t.kind !== "in")
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5);

  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {RANGES.map(([v, l]) => (
          <button key={v} className={"btn small" + (range === v ? " primary" : "")} onClick={() => setRange(v)}>{l}</button>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <div className="note" style={{ margin: 0 }}>Net worth</div>
            <div className="big mono" style={{ color: nw >= 0 ? "var(--acc)" : "var(--red)" }}>{fmt(nw)}</div>
          </div>
          <div className="note" style={{ margin: 0, textAlign: "right" }}>
            assets <b className="mono">{fmt(assets)}</b> · debts <b className="mono" style={{ color: "var(--red)" }}>{fmt(debts)}</b>
          </div>
        </div>
        {hist.length >= 2
          ? <ChartBox data={hist} dataKey="nw" xKey="date" />
          : <div className="note">Net worth logs one point per day — the trend appears as days accumulate.</div>}
      </div>

      <div className="grid4" style={{ marginTop: 14 }}>
        <div className="card"><div className="note" style={{ margin: 0 }}>Income</div><div className="big mono" style={{ fontSize: 22 }}>{fmt(income)}</div><div className="note" style={{ margin: 0 }}>{inSum > 0 ? "logged" : "from Settings"}</div></div>
        <div className="card"><div className="note" style={{ margin: 0 }}>Spending</div><div className="big mono" style={{ fontSize: 22 }}>{fmt(spend)}</div><div className="note" style={{ margin: 0 }}>{RANGES.find((x) => x[0] === range)[1].toLowerCase()}</div></div>
        <div className="card"><div className="note" style={{ margin: 0 }}>Net cash flow</div><div className="big mono" style={{ fontSize: 22, color: net >= 0 ? "var(--acc)" : "var(--red)" }}>{fmt(net)}</div><div className="note" style={{ margin: 0 }}>income − spending</div></div>
        <div className="card"><div className="note" style={{ margin: 0 }}>Savings rate</div><div className="big mono" style={{ fontSize: 22 }}>{rate == null ? "—" : rate + "%"}</div><div className="note" style={{ margin: 0 }}>{rate == null ? "set income" : rate >= 20 ? "strong" : rate >= 0 ? "keep pushing" : "spending exceeds income"}</div></div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Income vs spending</h3>
            <span className="row" style={{ gap: 12, fontSize: 12, color: "var(--muted)" }}>
              <span className="row" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--s3)" }} />Income</span>
              <span className="row" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--s8)" }} />Spending</span>
            </span>
          </div>
          <div style={{ width: "100%", height: 210 }}>
            <ResponsiveContainer>
              <BarChart data={months} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="m" tick={{ fill: "var(--faint)", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "var(--faint)", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "var(--acc-soft)" }} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, fontSize: 12 }} />
                <Bar dataKey="Income" fill="var(--s3)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Spending" fill="var(--s8)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <h3>Spending by category</h3>
          {donutData.length
            ? <div style={{ marginTop: 10 }}><Donut data={donutData} centerTop={fmt(spend)} centerBottom="spent" /></div>
            : <div className="note">No spending logged in this range yet.</div>}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Upcoming bills — next 30 days</h3>
          {upcoming.length ? upcoming.map(({ r, when }) => (
            <div className="kv" key={r.id}>
              <span className="k">{(r.name && r.name !== (d.cats.find((c) => c.id === r.catId)?.name) ? r.name : d.cats.find((c) => c.id === r.catId)?.name || "?")}
                <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · {MONTH_NAMES[when.getMonth()].slice(0, 3)} {when.getDate()}</span></span>
              <span className="mono">{fmt(r.amount)}</span>
            </div>
          )) : <div className="note">Nothing due — add recurring bills in Budget and they show here.</div>}
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Budget — {monthLabel(mKey)}</h3>
            <button className="btn small" onClick={() => setTab("budget")}>Open</button>
          </div>
          {prog.length ? prog.map((p) => (
            <div key={p.name} style={{ marginTop: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
                <span>{p.name}</span><span className="mono" style={{ color: p.pct >= 100 ? "var(--red)" : "var(--muted)" }}>{fmt(p.sp)} / {fmt(p.lim)}</span>
              </div>
              <div className="bar"><i style={{ width: p.pct + "%", background: p.pct >= 100 ? "var(--red)" : p.pct >= 80 ? "var(--gold)" : "var(--acc)" }} /></div>
            </div>
          )) : <div className="note">Set category budgets to track progress here.</div>}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>vs last month</h3>
          {movers.length ? movers.map((m) => (
            <div className="kv" key={m.name}>
              <span className="k">{m.name}</span>
              <span className="mono" style={{ fontSize: 13 }}>{fmt(m.now)}
                <span style={{ color: m.delta > 0 ? "var(--red)" : "var(--acc)", marginLeft: 6 }}>
                  {m.delta > 0 ? "▲" : "▼"} {fmt(Math.abs(m.delta))}
                </span>
              </span>
            </div>
          )) : <div className="note">Once two months have transactions, the biggest category shifts show here.</div>}
        </div>
        <div className="card">
          <h3>Largest expenses</h3>
          {biggest.length ? biggest.map((t) => (
            <div className="kv" key={t.id}>
              <span className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>
                {t.note || d.cats.find((c) => c.id === t.catId)?.name || "—"}
                <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · {t.date}</span>
              </span>
              <span className="mono">{fmt(Number(t.amount))}</span>
            </div>
          )) : <div className="note">No spending in this range yet.</div>}
        </div>
      </div>
    </>
  );
}

/* ---------------- auth + config shell ---------------- */

export default function App() {
  const [me, setMe] = useState(null); // {authed, username, canRegister, passkeys}
  const [mode, setMode] = useState("login"); // login | register | recovery
  const [f, setF] = useState({ username: "", password: "", invite: "", code: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);

  const refresh = async () => {
    const j = await (await fetch("/api/me")).json();
    setMe(j);
    if (j.authed) setConfig(await (await fetch("/api/config")).json());
  };
  useEffect(() => { refresh(); }, []);

  const submit = async () => {
    setErr("");
    const r = await fetch(mode === "login" ? "/api/login" : "/api/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f),
    });
    const j = await r.json();
    if (r.ok) refresh();
    else setErr(j.error || "Failed");
  };

  const passkeyLogin = async () => {
    setErr("");
    const u = f.username.trim().toLowerCase();
    if (!u) return setErr("Enter your username first");
    setBusy(true);
    try {
      const opts = await (await fetch("/api/webauthn/auth/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u }) })).json();
      const asr = await startAuthentication({ optionsJSON: opts });
      const r = await fetch("/api/webauthn/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cred: asr, username: u }) });
      const j = await r.json();
      if (r.ok) refresh(); else setErr(j.error || "Passkey sign-in failed");
    } catch (e) { setErr(e.name === "NotAllowedError" ? "Passkey prompt dismissed or no passkey on this device" : (e.message || "Passkey sign-in failed")); }
    setBusy(false);
  };

  const recoverySubmit = async () => {
    setErr("");
    const r = await fetch("/api/login/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: f.username, code: f.code }) });
    const j = await r.json();
    if (r.ok) refresh(); else setErr(j.error || "Failed");
  };

  if (me === null) return <div className="fh" data-theme="dark"><style>{CSS}</style><div className="wrap" style={{ padding: 60, color: "#8b9bb4" }}>Loading…</div></div>;
  if (!me.authed) return (
    <div className="fh" data-theme="dark"><style>{CSS}</style>
      <div className="wrap" style={{ maxWidth: 430, paddingTop: 72 }}>
        <div className="brand" style={{ justifyContent: "center", marginBottom: 6 }}><Logo size={44} /></div>
        <h1 style={{ textAlign: "center", fontSize: 28 }}>Atlas</h1>
        <div className="sub" style={{ marginBottom: 18, textAlign: "center" }}>your money, all in one place</div>
        <div className="card" style={{ marginTop: 0 }}>
        <div className="row" style={{ gap: 6, marginBottom: 12 }}>
          <button className={"btn small" + (mode === "login" ? " primary" : "")} onClick={() => { setMode("login"); setErr(""); }}>Log in</button>
          <button className={"btn small" + (mode === "register" ? " primary" : "")} onClick={() => { setMode("register"); setErr(""); }}>Create account</button>
        </div>
        <label className="f">Username</label>
        <input className="in" value={f.username} autoFocus autoCapitalize="none"
          onChange={(e) => setF({ ...f, username: e.target.value })} />

        {mode === "recovery" ? (
          <>
            <label className="f">Recovery code</label>
            <input className="in mono" value={f.code} placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" autoComplete="off"
              onKeyDown={(e) => e.key === "Enter" && recoverySubmit()}
              onChange={(e) => setF({ ...f, code: e.target.value })} />
            <div className="note">Each code works once. Use one if you've lost your passkey and password.</div>
            {err && <div className="err">{err}</div>}
            <div className="mrow" style={{ justifyContent: "flex-start" }}>
              <button className="btn primary" onClick={recoverySubmit}>Use recovery code</button>
              <button className="btn" onClick={() => { setMode("login"); setErr(""); }}>Back</button>
            </div>
          </>
        ) : (
          <>
            <label className="f">Password</label>
            <input className="in" type="password" value={f.password}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              onChange={(e) => setF({ ...f, password: e.target.value })} />
            {mode === "register" && (
              <>
                <label className="f">Invite code</label>
                <input className="in" value={f.invite} placeholder="ask whoever runs this server"
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  onChange={(e) => setF({ ...f, invite: e.target.value })} />
                <div className="note">First account on a fresh server needs no invite. Your data is fully separate from other users. After signing in, add a passkey under Security for phishing-resistant login.</div>
              </>
            )}
            {err && <div className="err">{err}</div>}
            <div className="mrow" style={{ justifyContent: "flex-start" }}>
              <button className="btn primary" onClick={submit}>{mode === "login" ? "Unlock" : "Create account"}</button>
            </div>
            {mode === "login" && browserSupportsWebAuthn() && (
              <>
                <div className="row" style={{ alignItems: "center", gap: 10, margin: "14px 0 10px", color: "var(--faint)", fontSize: 12 }}>
                  <span style={{ flex: 1, height: 1, background: "var(--line)" }} /> or <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
                </div>
                <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={passkeyLogin}>🔑 Sign in with a passkey</button>
                <div className="note" style={{ textAlign: "center", marginTop: 10 }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); setMode("recovery"); setErr(""); }} style={{ color: "var(--faint)" }}>Lost your device? Use a recovery code</a>
                </div>
              </>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
  if (!config) return null;
  return <FinanceHQ config={config} />;
}
