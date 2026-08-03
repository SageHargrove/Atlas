import React, { useState, useEffect, useMemo, useRef } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import Career from "./Career.jsx";
import TaxCard from "./TaxCard.jsx";
import Trends from "./Trends.jsx";
import Fold, { FoldWrap } from "./Fold.jsx";
import Retire from "./Retire.jsx";
import Loan from "./Loan.jsx";
import SplitRules from "./SplitRules.jsx";
import OfferImpact from "./OfferImpact.jsx";

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
    /* Utilities is its own line, not a subscription: "cut your subscriptions"
       is useless advice when a third of that number is the power bill. */
    { id: uid(), name: "Utilities", limit: 0 },
    { id: uid(), name: "Car / loan payment", limit: 0 },
    { id: uid(), name: "Subscriptions", limit: 0 },
    { id: uid(), name: "Fun", limit: 0 },
  ],
  txns: [],
  goals: [],
  recurring: [],
  purchases: [],
  invest: { holdings: [], watch: [] },
  career: { apps: [], settings: {} },
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
/* "KROGER #442" -> "Kroger #442" — display only, raw note is preserved */
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s#/&-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const fmt2 = (n) =>
  n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* whole-dollar amounts stay clean ($1,500), anything with cents keeps them ($15.99) */
const fmtAmt = (n) => (Number.isInteger(Number(n)) ? fmt(n) : fmt2(n));
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
  txns.filter((t) => t.kind === "out").forEach((t) => {
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
.fh { min-height:100vh; font-family:'Spline Sans',system-ui,sans-serif; color:var(--text); padding-bottom:90px; font-size:15px; line-height:1.5; overflow-x:clip;
  background:
    radial-gradient(1100px 480px at 18% -8%, var(--glow1), transparent 60%),
    radial-gradient(900px 460px at 92% -4%, var(--glow2), transparent 55%),
    var(--bg); }
.fh[data-theme="dark"]{ color-scheme:dark;
  --bg:#070b14; --panel:#0e1524; --panel2:#141d31; --line:#1b2740; --line2:#2b3c5c;
  --text:#e8eef7; --muted:#8b9bb4; --faint:#69819e;
  --acc:#3987e5; --acc-soft:rgba(57,135,229,.14); --acc-ink:#ffffff;
  --up:#3ddba0; --up-soft:rgba(61,219,160,.11);
  --red:#ef7d7d; --red-soft:rgba(239,125,125,.11);
  /* --down is an alias, not a new colour. It was being used across the career
     UI without ever being defined, so every "bad news" element silently
     rendered with no colour at all — a 7/100 likelihood bar drew as nothing,
     which reads as missing data rather than as a long shot. */
  --down:#ef7d7d;
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
  --red:#c94747; --red-soft:rgba(201,71,71,.08); --down:#c94747;
  --gold:#8a6a12; --gold-soft:rgba(138,106,18,.1);
  --blue:#2a78d6; --blue-soft:rgba(42,120,214,.1);
  --glow1:rgba(42,120,214,.06); --glow2:rgba(15,138,95,.04);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --shadow:0 10px 28px rgba(22,34,47,.13); }
.fh .wrap{ max-width:1360px; margin:0 auto; padding:0 26px; }
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
/* grid/flex children default to min-width:auto, which lets a wide chart stretch its
   card instead of scrolling inside it — the overflow then gets clipped and is
   unreachable. min-width:0 is what makes .hscroll actually scroll. */
.fh .grid2 > *, .fh .grid3 > *, .fh .grid4 > *, .fh .card{ min-width:0; }
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
.fh .bar i.near{ background:var(--gold); }
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
/* The profile workspace takes the whole window. It is the one screen where you
   sit and work on a document, so it gets the room a document needs — and each
   pane scrolls itself, so the controls never slide off while you read page 2. */
/* overflow:hidden matters — the overlay's own scrollbar is what let the whole
   page scroll and pushed the controls off the bottom of the screen */
.fh .ovfull{ padding:0; align-items:stretch; overflow:hidden; }
.fh .modal.wide{ max-width:none; width:100vw; height:100vh; max-height:100vh; border-radius:0; border:none;
  display:flex; flex-direction:column; padding:14px 26px 16px; animation:none; }
.fh .modal.wide > .mh{ flex-shrink:0; margin-bottom:4px; }
/* the card has to be a flex column too, or flex:1 on .rwork inside it does
   nothing and the height chain from 100vh silently stops here */
.fh .modal.wide .card{ border:none; padding:0; margin:0; background:none; flex:1; min-height:0; display:flex; flex-direction:column; }
.fh .modal.wide .wbody{ flex:1; min-height:0; display:flex; flex-direction:column; }
/* document centre stage, controls in a rail beside it */
.fh .rwork{ display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:22px; align-items:stretch; flex:1; min-height:0; }
.fh .rdoc{ min-width:0; display:flex; flex-direction:column; min-height:0; }
.fh .rpane{ flex:1; min-height:0; overflow-y:auto; padding-right:6px; }
.fh .rside{ border-left:1px solid var(--line); padding-left:18px; overflow-y:auto; min-height:0; }
.fh .rside .f{ margin-top:14px; }
.fh .rtext{ width:100%; height:100%; min-height:0; font-size:13.5px; line-height:1.6; resize:none; }
.fh .rempty{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center;
  height:100%; border:1px dashed var(--line2); border-radius:12px; padding:24px; }
@media (max-width:900px){
  .fh .modal.wide{ padding:12px 14px; }
  .fh .rwork{ grid-template-columns:1fr; overflow-y:auto; }
  .fh .rdoc{ min-height:60vh; }
  .fh .rside{ border-left:none; border-top:1px solid var(--line); padding-left:0; padding-top:14px; overflow:visible; }
}
.fh .modal h2{ font-family:'Sora',sans-serif; font-weight:600; font-size:18px; letter-spacing:-.01em; }
.fh .modal h3{ font-family:'Sora',sans-serif; font-weight:600; font-size:14.5px; margin-top:18px; }
.fh .mh{ display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.fh .mrow{ display:flex; gap:8px; justify-content:flex-end; margin-top:18px; flex-wrap:wrap; }
.fh .aiout{ background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-top:12px; white-space:pre-wrap; font-size:13.5px; line-height:1.6; }
.fh .chip{ display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:3px 10px; font-size:12px; font-weight:600; }
.fh .chip.up{ background:var(--up-soft); color:var(--up); }
.fh .chip.dn{ background:var(--red-soft); color:var(--red); }
.fh .chip.ghost{ background:var(--panel2); color:var(--muted); border:1px solid var(--line); font-weight:500; }
.fh .wchip{ display:inline-flex; align-items:center; gap:7px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:5px 10px; font-size:12.5px; }
.fh .dot{ width:9px; height:9px; border-radius:3px; flex-shrink:0; display:inline-block; }
.fh .pills{ display:flex; gap:2px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:2px; }
.fh .pill{ font:inherit; border:none; background:none; cursor:pointer; padding:4px 11px; border-radius:8px; font-size:12px; color:var(--muted); }
.fh .pill:hover{ color:var(--text); }
.fh .pill.on{ background:var(--acc); color:#fff; font-weight:600; }
.fh .av{ width:30px; height:30px; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:#fff; flex-shrink:0; }
.fh .cat{ display:inline-flex; align-items:center; gap:5px; font-size:11px; border:1px solid var(--line); background:var(--panel2); border-radius:6px; padding:1.5px 7px; color:var(--muted); }
.fh .sleg{ display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; font-size:12.5px; color:var(--muted); }
.fh .sleg .dot{ margin-right:6px; }
.fh .toasts{ position:fixed; right:22px; bottom:22px; z-index:80; display:flex; flex-direction:column; gap:8px; }
.fh .toastmsg{ background:var(--panel); border:1px solid var(--up); border-radius:12px; padding:11px 15px; font-size:13px; box-shadow:0 10px 30px rgba(2,6,16,.55); animation:rise .25s ease both; max-width:360px; }
.fh .toastmsg.err{ border-color:var(--red); color:var(--red); }
.fh .tape{ overflow:hidden; }
.fh .tapein{ display:inline-flex; white-space:nowrap; width:max-content; animation:tape 30s linear infinite; will-change:transform; }
.fh .tape:hover .tapein{ animation-play-state:paused; }
.fh .tapecopy{ display:inline-flex; gap:36px; padding-right:36px; }
.fh .tapeitem{ display:inline-flex; align-items:center; gap:6px; font-size:13.5px; }
@keyframes tape{ to{ transform:translateX(-50%); } }
@media (prefers-reduced-motion: reduce){ .fh .tapein{ animation:none; flex-wrap:wrap; width:auto; padding:0 16px; } .fh .tapecopy:last-child{ display:none; } }
.fh .glow .recharts-line-curve{ filter:drop-shadow(0 0 6px color-mix(in srgb, var(--up) 55%, transparent)); }
/* logo: pages sweep open, the route draws itself, the pin pops; replays on hover.
   Defaults are the FINISHED state so prefers-reduced-motion (animation:none) shows the full mark. */
.fh .atlas-logo .pg{ transform-origin:24px 24px; animation:pageOpen .55s cubic-bezier(.22,.9,.28,1) both; }
.fh .atlas-logo .pgr{ animation-delay:.06s; }
.fh .atlas-logo .rt{ stroke-dasharray:100 0; animation:routeDraw .7s cubic-bezier(.3,.6,.3,1) .5s backwards; }
.fh .atlas-logo .rtdot{ transform-origin:33.8px 16.6px; animation:pinPop .35s cubic-bezier(.2,1.6,.4,1) 1.05s backwards; }
.fh .brand:hover .atlas-logo .pg{ animation:pageOpen .45s cubic-bezier(.22,.9,.28,1) both; }
.fh .brand:hover .atlas-logo .rt{ animation:routeDraw .6s cubic-bezier(.3,.6,.3,1) .35s backwards; }
.fh .brand:hover .atlas-logo .rtdot{ animation:pinPop .35s cubic-bezier(.2,1.6,.4,1) .85s backwards; }
@keyframes pageOpen{ from{ transform:scaleX(.06); opacity:.35; } to{ transform:none; opacity:1; } }
@keyframes routeDraw{ from{ stroke-dasharray:0 100; } to{ stroke-dasharray:100 0; } }
@keyframes pinPop{ from{ transform:scale(0); } to{ transform:scale(1); } }
.fh .banner{ border:1px solid var(--acc); background:var(--acc-soft); border-radius:12px; padding:10px 14px; margin-top:12px; font-size:13px; animation:rise .3s ease both; }
@media (max-width:760px){
  .fh .wrap{ padding:0 12px; }
  .fh .grid2,.fh .grid3{ grid-template-columns:1fr; }
  .fh .grid4{ grid-template-columns:1fr 1fr; }
  .fh .card{ padding:14px 14px; }
  .fh .trow{ grid-template-columns:80px 1fr .7fr .6fr 30px; }
  .fh .trow .tnote,.fh .trow .tacct{ display:none; }
  .fh .irow{ grid-template-columns:1.4fr .8fr 1fr 30px; }
  .fh .irow .iday,.fh .irow .igain{ display:none; }
  .fh .big{ font-size:28px; }
  .fh .hrow{ padding:8px 0; gap:8px; }
}
/* wide charts scroll inside their own card on phones — never the whole page */
.fh .hscroll{ overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }
/* Job results as cards, not rows. A row forces every posting to the full width
   of the page, which is why ten of them still read as a wall — the eye has to
   traverse the whole line to find the next title. Two or three columns of
   self-contained boxes scan in a fraction of the time. */
.fh .jgrid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); gap:12px; margin-top:12px; }
.fh .jcard{ border:1px solid var(--line2); border-radius:13px; padding:13px 15px; background:var(--panel2); display:flex; flex-direction:column; gap:7px; }
.fh .jcard:hover{ border-color:var(--acc); }
.fh .jcard .jtop{ display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
.fh .jcard .jfoot{ display:flex; gap:6px; align-items:center; margin-top:auto; padding-top:4px; }
/* the overflow menu — everything that isn't the one obvious action */
.fh .menuwrap{ position:relative; margin-left:auto; }
.fh .menu{ position:absolute; right:0; top:calc(100% + 4px); z-index:20; min-width:186px; background:var(--panel);
  border:1px solid var(--line2); border-radius:11px; box-shadow:var(--shadow); padding:5px; }
.fh .menu button{ display:block; width:100%; text-align:left; background:none; border:none; color:var(--text);
  font:inherit; font-size:12.5px; padding:7px 10px; border-radius:7px; cursor:pointer; }
.fh .menu button:hover{ background:var(--panel2); }
.fh .menu button.danger{ color:var(--down); }
.fh .menu hr{ border:none; border-top:1px solid var(--line); margin:4px 2px; }
/* the filter drawer: shut by default, because thirty controls on screen is not
   a filter bar, it's a cockpit */
.fh .fbar{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.fh .fdrawer{ border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-top:8px; background:var(--panel2); }
.fh .fdrawer .f{ margin-top:12px; }
.fh .fdrawer .f:first-child{ margin-top:0; }
.fh .achip{ display:inline-flex; align-items:center; gap:5px; font-size:11.5px; padding:2px 5px 2px 9px;
  border-radius:999px; border:1px solid var(--acc); color:var(--acc); }
.fh .achip button{ background:none; border:none; color:inherit; cursor:pointer; font-size:13px; line-height:1; padding:0 3px; }
.fh .foldhead{ display:flex; justify-content:space-between; align-items:center; width:100%; background:none;
  border:none; padding:0; cursor:pointer; color:var(--text); font:inherit; text-align:left; }
.fh .foldhead:hover h3{ color:var(--acc); }
.fh .foldright{ font-family:'JetBrains Mono',monospace; font-size:12.5px; color:var(--muted); white-space:nowrap; }
/* a wrapped section's own card chrome and heading are redundant inside a fold */
.fh .foldwrap > .foldbody{ margin-top:4px; }
.fh .foldwrap > .foldbody > .card{ background:none; border:none; box-shadow:none; padding:0; margin:0; }
.fh .foldwrap > .foldbody > .card > h3:first-child{ display:none; }
.fh .foldwrap > .foldbody > .card + .card{ margin-top:14px; }
/* the at-a-glance strip above a page of folds, so it doesn't open onto nothing */
/* drilling into a budget category */
.fh .catopen{ background:none; border:none; padding:0; cursor:pointer; color:var(--text); font:inherit; text-align:left; }
.fh .catopen:hover b{ color:var(--acc); }
/* A fold header must be clickable across its whole width — hitting only the
   words means aiming at text and usually selecting it instead. */
.fh .foldhead{ width:100%; padding:2px 0; }
.fh .foldhead:hover{ background:var(--panel2); border-radius:8px; }
.fh .catopen{ flex:1; padding:3px 4px; border-radius:7px; }
.fh .catopen:hover{ background:var(--panel2); }
.fh .cdclick{ cursor:pointer; border-radius:6px; padding-left:5px; margin-left:-5px; }
.fh .cdclick:hover{ background:var(--panel); }
.fh .cdclick:hover .cdname{ color:var(--acc); }
.fh .taxdue{ margin-top:10px; padding:10px 12px; background:var(--panel2); border:1px solid var(--line2); border-radius:11px; }
.fh .duegrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(84px,1fr)); gap:8px; margin-top:8px; }
.fh .duecell{ border:1px solid var(--line); border-radius:9px; padding:7px 9px; background:var(--panel); }
.fh .duecell.past{ opacity:.45; }
.fh .duecell.next{ border-color:var(--gold); box-shadow:0 0 0 3px var(--gold-soft); }
.fh .dueq{ font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); }
.fh .duev{ font-size:14.5px; font-weight:600; margin-top:1px; }
.fh .dued{ font-size:11px; color:var(--muted); }
.fh .splitrule{ border:1px solid var(--line2); border-radius:11px; padding:11px 13px; margin-top:10px; background:var(--panel2); }
.fh .bragrow{ display:flex; justify-content:space-between; gap:10px; align-items:baseline; padding:5px 0; border-bottom:1px solid var(--line); font-size:13px; }
.fh .bragrow:last-child{ border-bottom:none; }
.fh .catdrill{ margin:8px 0 2px 22px; border-left:2px solid var(--line); padding-left:12px; }
.fh .cdrow{ display:grid; grid-template-columns:1fr 34px 78px 40px; gap:8px; align-items:baseline; padding:3px 0; }
.fh .cdname{ font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fh .cdrow span:not(.cdname){ text-align:right; }
.fh .rng{ width:100%; accent-color:var(--acc); height:22px; cursor:pointer; }
.fh .budgtot{ margin-top:12px; padding:11px 13px; background:var(--panel2); border:1px solid var(--line2); border-radius:11px; }
.fh .glance{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:12px; }
.fh .gtile{ background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:9px 12px; }
.fh .gtl{ font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); }
.fh .gtv{ font-family:'JetBrains Mono',monospace; font-size:17px; font-weight:600; margin-top:2px; }
.fh .gts{ font-size:11px; color:var(--muted); margin-top:1px; }

/* ---- Trends: spending over time ----
   One series, so one hue and no legend — the heading names it. The month in
   progress gets a hatch as well as a lighter fill, so "this one isn't finished"
   survives greyscale, colour-blindness and forced-colours mode. */
.fh .trow{ display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:14px; }
.fh .tstat{ background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:11px 13px; }
.fh .tstatl{ font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); }
.fh .tstatv{ font-family:'JetBrains Mono',monospace; font-size:21px; font-weight:600; margin-top:3px; letter-spacing:-.02em; }
.fh .tstats{ font-size:11.5px; color:var(--muted); margin-top:1px; }
.fh .tlabel{ font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); margin:12px 0 7px; }
/* Three months must not stretch to fill 1400px — a bar's width is not data, and
   letting it grow implies one. Cap it and left-align instead. */
.fh .bars{ display:flex; align-items:flex-end; gap:8px; height:186px; overflow-x:auto; padding-bottom:2px; justify-content:flex-start; }
.fh .bcol{ flex:0 1 78px; max-width:110px; min-width:38px; display:flex; flex-direction:column; align-items:center; height:100%; }
.fh .bval{ font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--muted); height:13px; white-space:nowrap; }
.fh .btrack{ flex:1; width:100%; display:flex; align-items:flex-end; min-height:0; }
.fh .bfill{ width:100%; background:var(--acc); border-radius:4px 4px 0 0; transition:height .18s ease; }
.fh .bfill.partial{ background:var(--acc-soft); border:1px solid var(--acc); border-bottom:none;
  background-image:repeating-linear-gradient(45deg, transparent 0 4px, var(--acc-soft) 4px 8px); }
.fh .bgap{ width:100%; height:100%; border-bottom:2px dotted var(--line2); }
.fh .blab{ font-size:10.5px; color:var(--faint); margin-top:5px; white-space:nowrap; }
.fh .ttable{ border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.fh .tth,.fh .ttr{ display:grid; grid-template-columns:1.6fr 1fr 1fr 1fr; gap:8px; padding:8px 12px; align-items:center; }
.fh .tth{ background:var(--panel2); font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); }
.fh .tth span+span,.fh .ttr span+span{ text-align:right; }
.fh .ttr{ border-top:1px solid var(--line); cursor:pointer; font-size:13px; }
.fh .ttr:hover{ background:var(--panel2); }
.fh .tname{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fh .ttx{ border-top:1px solid var(--line); background:var(--panel2); padding:10px 12px; }
.fh .spark{ display:flex; align-items:flex-end; gap:3px; height:38px; max-width:420px; }
.fh .scol{ flex:0 1 26px; min-width:10px; display:flex; flex-direction:column; height:100%; }
.fh .strack{ flex:1; display:flex; align-items:flex-end; min-height:0; }
.fh .sfill{ width:100%; background:var(--acc); border-radius:3px 3px 0 0; }
.fh .sfill.partial{ background:var(--acc-soft); border:1px solid var(--acc); border-bottom:none; }
.fh .slab{ font-size:9.5px; color:var(--faint); text-align:center; margin-top:3px; }
@media (max-width:640px){
  .fh .tth,.fh .ttr{ grid-template-columns:1.4fr 1fr 1fr; }
  .fh .tth span:nth-child(3),.fh .ttr span:nth-child(3){ display:none; }
}

/* The timeline reads top to bottom. The horizontal version spent four fifths
   of its width on months where nothing happens, and had nowhere to put the one
   thing that matters per row — what to do about it. */
.fh .tlhead{ display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; }
.fh .tlurgent{ flex:1; min-width:260px; font-size:12.5px; line-height:1.5; color:var(--muted); }
.fh .tlurgent.on{ color:var(--gold); }
.fh .tlstats{ display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin:12px 0 4px; }
.fh .tlstat{ background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:8px 11px;
  display:flex; flex-direction:column; gap:1px; text-align:left; font:inherit; }
button.tlstat{ cursor:pointer; }
button.tlstat:hover{ border-color:var(--acc); }
.fh .tlsn{ font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:600; line-height:1.1; }
.fh .tlsl{ font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); }
.fh .tline{ list-style:none; margin:14px 0 0; padding:0; position:relative; }
/* the spine: one line down the gutter, behind the markers */
.fh .tline::before{ content:""; position:absolute; left:53px; top:10px; bottom:14px; width:2px; background:var(--line); }
.fh .tli{ display:grid; grid-template-columns:44px 20px 1fr; gap:0 12px; align-items:start; padding:7px 0; position:relative; }
.fh .tlwhen{ font-family:'JetBrains Mono',monospace; font-size:10.5px; letter-spacing:.04em; color:var(--faint);
  text-align:right; padding-top:2px; white-space:nowrap; }
.fh .tlyr{ display:block; font-size:9.5px; opacity:.75; }
.fh .tli.now .tlwhen{ color:var(--gold); font-weight:700; }
.fh .tlmark{ width:16px; height:16px; border-radius:50%; border:2px solid var(--line2); background:var(--panel);
  margin-top:1px; padding:0; cursor:pointer; font-size:10px; line-height:1; color:var(--panel); z-index:1; }
.fh .tlmark:disabled{ cursor:default; }
.fh .tli.done .tlmark{ background:var(--up); border-color:var(--up); color:var(--bg); }
.fh .tli.late .tlmark{ border-color:var(--down); }
.fh .tli.now .tlmark{ border-color:var(--gold); box-shadow:0 0 0 4px var(--gold-soft); }
.fh .tlname{ font-size:13.5px; font-weight:600; line-height:1.3; }
.fh .tli.done .tlname{ color:var(--muted); font-weight:500; }
.fh .tlsub{ font-size:11.5px; color:var(--faint); line-height:1.45; margin-top:2px; }
.fh .tlsub.todo{ color:var(--muted); }
.fh .tlprog{ position:relative; height:14px; border-radius:7px; background:var(--panel2); border:1px solid var(--line);
  margin-top:5px; max-width:230px; overflow:hidden; }
.fh .tlprogf{ height:100%; background:var(--acc); border-radius:7px 0 0 7px; }
.fh .tlprogn{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-family:'JetBrains Mono',monospace; font-size:9.5px; color:var(--text); }
.fh .tbl{ width:100%; border-collapse:collapse; font-size:13px; }
.fh .tbl th{ text-align:left; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); font-weight:600; padding:6px 10px 6px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
.fh .tbl td{ padding:8px 10px 8px 0; border-bottom:1px solid var(--line); vertical-align:top; }
.fh .tbl tbody tr:last-child td{ border-bottom:none; }
.fh .tbl tbody tr:hover{ background:var(--panel2); }
.fh .swipehint{ text-align:right; margin-top:2px; font-size:11.5px; color:var(--faint); animation:nudge 1.6s ease-in-out 3; }
@keyframes nudge{ 0%,100%{ transform:none; } 50%{ transform:translateX(5px); } }
/* installed to the home screen: clear the notch / status bar and the home indicator */
@media (display-mode:standalone){
  .fh header{ padding-top:env(safe-area-inset-top); }
  .fh .wrap{ padding-left:max(12px, env(safe-area-inset-left)); padding-right:max(12px, env(safe-area-inset-right)); }
}
/* phone navigation: thumb-reachable bar pinned to the bottom, like a native app */
.fh .bottomnav{ display:none; }
@media (max-width:760px){
  .fh header .tabs{ display:none; }
  .fh{ padding-bottom:calc(78px + env(safe-area-inset-bottom)); }
  .fh .bottomnav{ display:flex; position:fixed; left:0; right:0; bottom:0; z-index:45;
    background:color-mix(in srgb, var(--panel) 94%, transparent); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
    border-top:1px solid var(--line); padding:6px 4px calc(6px + env(safe-area-inset-bottom)); }
  .fh .bottomnav button{ flex:1; min-width:0; background:none; border:none; color:var(--muted); font:inherit; font-size:10.5px;
    display:flex; flex-direction:column; align-items:center; gap:3px; padding:5px 2px; cursor:pointer; border-radius:10px; }
  .fh .bottomnav button.on{ color:var(--acc); }
  .fh .bottomnav button:active{ background:var(--panel2); }
}
@media (prefers-reduced-motion: reduce){ .fh *, .fh *::before, .fh *::after{ animation:none !important; transition:none !important; } }
`;

/* ---------------- shared bits ---------------- */

/* Atlas mark: an open book of maps with a route charting up and to the right —
   book + map + trend line in one. Pages sweep open, then the route draws itself
   and the destination pin pops. Replays on hover. */
const Logo = ({ size = 30 }) => {
  /* useId() contains ':' which is invalid inside url(#…) — strip it */
  const gid = "atlas" + React.useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className="atlas-logo" role="img" aria-label="Atlas">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="48" x2="48" y2="0">
          <stop offset="0" stopColor="#1e63c8" /><stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="14" fill={`url(#${gid})`} />
      {/* subtle inner glow so the tile reads dimensional, not flat */}
      <rect x="1" y="1" width="46" height="46" rx="14" fill="#fff" fillOpacity=".07" style={{ mixBlendMode: "overlay" }} />
      <path className="pg pgl" d="M24 16.5C20.3 13.6 14.3 12.5 9 13.1V32.2C14.3 31.6 20.3 32.8 24 35.8Z" fill="#fff" />
      <path className="pg pgr" d="M24 16.5C27.7 13.6 33.7 12.5 39 13.1V32.2C33.7 31.6 27.7 32.8 24 35.8Z" fill="#fff" fillOpacity=".85" />
      {/* spine shadow */}
      <path d="M24 16.5V35.8" stroke="#0d2b52" strokeOpacity=".22" strokeWidth="1.6" strokeLinecap="round" />
      {/* the route: dashed trail across both pages, rising */}
      <path className="rt" d="M12.5 28.5 C16 27.5 17.5 23.5 20.5 24.5 C23.5 25.5 24.5 20.5 28 19.5 C30.5 18.8 32 17.6 33.8 16.6"
        stroke={`url(#${gid})`} strokeWidth="2.1" strokeLinecap="round" fill="none" pathLength="100" />
      {/* destination pin */}
      <circle className="rtdot" cx="33.8" cy="16.6" r="2.5" fill="#0f8a5f" />
      <circle className="rtdot" cx="33.8" cy="16.6" r="1" fill="#fff" />
    </svg>
  );
};

/* categorical series colors — validated palette, assigned by entity (stable index), never by rank */
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];
const seriesColor = (i) => (i < 0 ? "var(--faint)" : SERIES[i % SERIES.length]);

/* ---- hand-drawn 24x24 stroke icon set (no emoji, no external assets) ---- */
const ICONS = {
  home: ["M3 11.5 L12 4 L21 11.5", "M5.5 10 V20 H18.5 V10"],
  cart: ["M3 4 H5.5 L8 15 H18 L20.8 7 H6.6", "M9.5 19.5 a0.4 0.4 0 1 0 0.001 0", "M16.8 19.5 a0.4 0.4 0 1 0 0.001 0"],
  food: ["M6 3 V10", "M9 3 V10", "M7.5 3 V21", "M7.5 10 C6 10 6 8 6 8", "M16.5 3 C14.5 5.5 14.5 9 16.5 11 V21"],
  car: ["M4.5 15.5 L5.6 10 C5.9 8.7 6.7 8 8 8 H16 C17.3 8 18.1 8.7 18.4 10 L19.5 15.5", "M3.8 15.5 H20.2 V18.5 H3.8 Z", "M6.8 18.5 V20", "M17.2 18.5 V20"],
  play: ["M3.5 6.5 a2 2 0 0 1 2 -2 H18.5 a2 2 0 0 1 2 2 V17.5 a2 2 0 0 1 -2 2 H5.5 a2 2 0 0 1 -2 -2 Z", "M10 9 L15 12 L10 15 Z"],
  game: ["M7 5.5 H17 C20 5.5 21.2 8.5 21 12 C20.8 15 19.5 16 18 15 L16 13 H8 L6 15 C4.5 16 3.2 15 3 12 C2.8 8.5 4 5.5 7 5.5 Z", "M7.5 9 V12", "M6 10.5 H9", "M15.5 9.5 h0.01", "M17.5 11.5 h0.01"],
  bag: ["M5.5 8.5 H18.5 L17.5 20 H6.5 Z", "M9 8.5 V6.5 a3 3 0 0 1 6 0 V8.5"],
  heart: ["M12 19.5 C5.5 14.5 4.5 9.5 7.7 7.6 C9.9 6.3 12 8.3 12 8.3 C12 8.3 14.1 6.3 16.3 7.6 C19.5 9.5 18.5 14.5 12 19.5 Z"],
  plane: ["M3 12.5 L21 4 L15.5 20.5 L12 14 Z", "M12 14 L21 4"],
  dollar: ["M12 3.5 V20.5", "M15.8 6.8 C15.8 5 14 4.3 12 4.3 C10 4.3 8.3 5.3 8.3 7.1 C8.3 11 15.8 9.6 15.8 13.6 C15.8 15.8 14 16.8 12 16.8 C10 16.8 8.2 15.9 8.2 14"],
  zap: ["M13 2.5 L5 13 H11 L9.5 21.5 L19 9.5 H13 Z"],
  gift: ["M4.5 10.5 H19.5 V20 H4.5 Z", "M3.8 7 H20.2 V10.5 H3.8 Z", "M12 7 V20", "M12 7 C9.2 7 7.8 5.4 8.7 4 C9.7 2.6 12 4.2 12 7", "M12 7 C14.8 7 16.2 5.4 15.3 4 C14.3 2.6 12 4.2 12 7"],
  coffee: ["M4.5 9 H16.5 V15.5 a4 4 0 0 1 -4 4 H8.5 a4 4 0 0 1 -4 -4 Z", "M16.5 10 H18.5 a2.4 2.4 0 0 1 0 4.8 H16.5"],
  book: ["M4.5 5 a2 2 0 0 1 2 -2 H19.5 V19 H6.5 a2 2 0 0 0 -2 2 Z", "M19.5 17 H6.5 a2 2 0 0 0 -2 2"],
  tag: ["M3.5 10.5 V4 H10 L20.5 14.5 L14 21 Z", "M7.2 7.7 h0.01"],
  /* navigation */
  grid: ["M4 4 H10.5 V10.5 H4 Z", "M13.5 4 H20 V10.5 H13.5 Z", "M4 13.5 H10.5 V20 H4 Z", "M13.5 13.5 H20 V20 H13.5 Z"],
  bank: ["M3 9.5 L12 4 L21 9.5", "M5.8 9.5 V17", "M10 9.5 V17", "M14 9.5 V17", "M18.2 9.5 V17", "M3.5 20 H20.5"],
  bars: ["M4.5 20 V11", "M12 20 V4.5", "M19.5 20 V14", "M3 20.5 H21"],
  chat: ["M20.5 13.5 a2 2 0 0 1 -2 2 H9.5 L5 19.5 V6.5 a2 2 0 0 1 2 -2 H18.5 a2 2 0 0 1 2 2 Z"],
  dots: ["M6 12 h0.01", "M12 12 h0.01", "M18 12 h0.01"],
};
function catIconKey(name) {
  const n = String(name || "").toLowerCase();
  if (/rent|home|mortgage|hous/.test(n)) return "home";
  if (/grocer/.test(n)) return "cart";
  if (/eat|food|dining|restaur/.test(n)) return "food";
  if (/coffee|cafe/.test(n)) return "coffee";
  if (/transport|gas|car|auto|fuel|uber|commut/.test(n)) return "car";
  if (/subscript|stream/.test(n)) return "play";
  if (/fun|game|entertain|hobby/.test(n)) return "game";
  if (/shop|cloth|amazon/.test(n)) return "bag";
  if (/health|gym|fitness|medic|pharm|doctor/.test(n)) return "heart";
  if (/travel|flight|vacation|trip/.test(n)) return "plane";
  if (/income|salary|pay/.test(n)) return "dollar";
  if (/utilit|electric|power|internet|phone|bill/.test(n)) return "zap";
  if (/gift|donat/.test(n)) return "gift";
  if (/educat|book|school|tuition/.test(n)) return "book";
  return "tag";
}
const Icon = ({ k, size = 14, color = "currentColor", style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
    {(ICONS[k] || ICONS.tag).map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const CatChip = ({ name, color }) => (
  <span className="cat"><Icon k={catIconKey(name)} size={12} color={color} /> {name}</span>
);
const Avatar = ({ label, color }) => (
  <span className="av" style={{ background: color }}>{(String(label || "?").trim()[0] || "?").toUpperCase()}</span>
);

const ThemeIcon = ({ dark }) => dark
  ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" /></svg>
  : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.5 13.5 A8.4 8.4 0 1 1 10.5 3.5 A6.8 6.8 0 0 0 20.5 13.5 Z" /></svg>;
const KeyIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true"><circle cx="7.5" cy="15.5" r="3.8" /><path d="M10.5 12.5 L20 3 M15 8 L17.6 10.6 M17.8 5.2 L20.3 7.7" /></svg>;

/* tiny sparkline for stat tiles */
const Spark = ({ data, color = "var(--up)", w = 108, h = 30 }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const sx = (w - 4) / (data.length - 1), sy = (h - 6) / ((max - min) || 1);
  const pts = data.map((v, i) => (2 + i * sx).toFixed(1) + "," + (h - 3 - (v - min) * sy).toFixed(1)).join(" ");
  return <svg width={w} height={h} aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" /></svg>;
};

/* delta chip: ▲/▼ + label */
const Delta2 = ({ v, label, goodDown = false }) => {
  if (v == null || isNaN(v) || Math.abs(v) < 1) return null;
  const up = v > 0;
  const good = goodDown ? !up : up;
  return <span className={"chip " + (good ? "up" : "dn")}>{up ? "▲" : "▼"} {fmt(Math.abs(v))}{label ? " " + label : ""}</span>;
};

/* horizontal stacked bar + legend — the flattened allocation donut */
function StackBar({ segs, height = 18 }) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <>
      <div style={{ display: "flex", height, borderRadius: 9, overflow: "hidden", marginTop: 12, gap: 2 }}>
        {segs.map((s) => (
          <div key={s.name} title={s.name + " " + fmt(s.value)} style={{ width: Math.max(0.8, (s.value / total) * 100) + "%", background: s.color }} />
        ))}
      </div>
      <div className="sleg">
        {segs.map((s) => (
          <span key={s.name}><span className="dot" style={{ background: s.color }} />{s.name} <b className="mono">{Math.round((s.value / total) * 100)}%</b> <span style={{ color: "var(--faint)" }}>{fmtK(s.value)}</span></span>
        ))}
      </div>
    </>
  );
}

/* ---- toasts: replace alert() so errors match the app instead of the browser ---- */
let __pushToast = null;
const toast = (msg, kind = "ok") => { if (__pushToast) __pushToast(msg, kind); else if (kind === "err") alert(msg); };
function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    __pushToast = (msg, kind) => {
      const id = uid();
      setList((p) => [...p.slice(-3), { id, msg, kind }]);
      setTimeout(() => setList((p) => p.filter((t) => t.id !== id)), 5500);
    };
    return () => { __pushToast = null; };
  }, []);
  if (!list.length) return null;
  return (
    <div className="toasts">
      {list.map((t) => <div key={t.id} className={"toastmsg " + t.kind}>{t.msg}</div>)}
    </div>
  );
}

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

function BankSync({ d, syncBusy, syncMsg, onSync, onRemoveBank, onReload }) {
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
  const syncNow = async (days) => {
    setSfBusy(true); setSfMsg(days ? "Asking your banks for everything they still have — this can take a couple of minutes…" : "");
    try {
      const r = await fetch("/api/simplefin/sync", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(days ? { days } : {}) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Sync failed");
      await onReload();
      setSfMsg("Synced — " + j.newTx + " new transactions"
        + (j.autoCat ? " (" + j.autoCat + " auto-categorized)" : "")
        + ", " + j.updAcc + " balances updated"
        + (j.updHold ? ", " + j.updHold + " holdings" : "")
        + (j.xferPairs ? ", " + j.xferPairs + " marked as transfers" : "") + "."
        /* On a backfill the depth reached IS the result — "0 new transactions"
           alone would read as a failure when it actually means the bank has
           nothing older, which is the answer the user was asking for. */
        + (j.oldest ? " Your banks went back to " + j.oldest + "." : "")
        + (j.retyped?.length ? " Reclassified " + j.retyped.join(", ") + "." : "")
        + (j.warnings?.length ? " (" + j.warnings.join("; ") + ")" : ""));
    } catch (e) { setSfMsg("Sync failed — " + e.message); }
    setSfBusy(false);
    setTimeout(() => setSfMsg(""), 14000);
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
        <>
          <div className="mrow" style={{ justifyContent: "flex-start" }}>
            {/* not {syncNow} — React would pass the click event as the day count */}
            <button className="btn primary" disabled={sfBusy} onClick={() => syncNow()}>{sfBusy ? "Syncing…" : "Sync now"}</button>
            <button className="btn" disabled={sfBusy} title="Ask your banks for their full history, not just recent months"
              onClick={() => { if (confirm("Pull every transaction your banks still hold?\n\nThis asks for up to 7 years instead of the usual 4 months. It can take a couple of minutes, and nothing already in Atlas is changed or removed — only older transactions are added.")) syncNow(2555); }}>
              Backfill history
            </button>
          </div>
          <div className="note">Routine syncs look back 4 months. <b>Backfill history</b> asks for everything — how far it reaches is up to each bank, and it will tell you the date it got to.</div>
        </>
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
      <div className="note">Synced transactions land in Budget as "uncategorized" for you (or the AI) to sort. Brokerage connections (Fidelity included) also bring their holdings into the Invest tab automatically.</div>

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

function Overview({ d, setD, config, syncBusy, syncMsg, onSync, onRemoveBank, onReload }) {
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
      <BankSync d={d} syncBusy={syncBusy} syncMsg={syncMsg}
        onSync={onSync} onRemoveBank={onRemoveBank} onReload={onReload} />
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
            <span className="k">{a.name}
              {a.tellerId && <span className="tag" style={{ marginLeft: 5 }} title="Balance updates from bank sync — hand edits would be overwritten anyway">synced</span>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              {isDebt(a) && <span className="bad" style={{ fontSize: 12 }}>debt</span>}
              <select className="in" style={{ width: 132, padding: "4px 6px", fontSize: 12 }} value={a.type}
                title="Asset vs debt follows the type. Sync guesses it from the account name and can miss credit cards — fix it here and the math (and transfer detection) follows."
                onChange={(e) => {
                  const type = e.target.value;
                  setD((p) => ({ ...p, accounts: p.accounts.map((x) => x.id === a.id ? { ...x, type, balance: DEBT_TYPES.includes(type) ? Math.abs(Number(x.balance) || 0) : Number(x.balance) || 0 } : x) }));
                }}>
                <optgroup label="Assets">{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</optgroup>
                <optgroup label="Debts">{DEBT_TYPES.map((t) => <option key={t}>{t}</option>)}</optgroup>
              </select>
              <input className="in mono" style={{ width: 66, textAlign: "right", padding: "4px 6px" }} type="number" step="0.1"
                title={isDebt(a) ? "APR %" : INVESTED.includes(a.type) ? "Expected return %/yr" : "APY %"}
                placeholder={isDebt(a) ? "APR%" : LIQUID.includes(a.type) ? "APY%" : "%/yr"}
                value={a.rate ?? ""} onChange={(e) => setD((p) => ({ ...p, accounts: p.accounts.map((x) => x.id === a.id ? { ...x, rate: e.target.value === "" ? "" : Number(e.target.value) } : x) }))} />
              {a.tellerId
                ? <span className="mono" style={{ width: 120, textAlign: "right", padding: "4px 8px" }}>{fmt2(Number(a.balance))}</span>
                : <input className="in mono" style={{ width: 120, textAlign: "right", padding: "4px 8px" }} type="number"
                    value={a.balance} onChange={(e) => setBal(a.id, e.target.value)} />}
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
        <div className="note">
          Debt balances are entered as positive numbers — they subtract from net worth automatically.
          {" "}<b>APY/APR is optional and only feeds forecasts.</b> Bank sync sends balances, never interest rates, so
          nothing can fill it in for you — and nothing needs it to track your money. Fill it in on a savings account or
          a credit card and the Plan tab can project growth and payoff instead of quietly assuming zero.
        </div>
      </div>

      {(() => { /* asset allocation — color follows the asset TYPE's fixed index */
        const byType = {};
        d.accounts.filter((a) => !isDebt(a) && Number(a.balance) > 0).forEach((a) => { byType[a.type] = (byType[a.type] || 0) + Number(a.balance); });
        const rows = Object.entries(byType)
          .map(([type, value]) => ({ name: type, value: Math.round(value), color: seriesColor(ASSET_TYPES.indexOf(type)) }))
          .sort((a, b) => b.value - a.value);
        return rows.length >= 2 ? (
          <FoldWrap title="Asset allocation" sub="how your assets are split">
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <h3>Asset allocation</h3>
              <span className="note" style={{ margin: 0 }}><b className="mono">{fmt(assets)}</b> in assets</span>
            </div>
            <StackBar segs={rows} />
          </div>
          </FoldWrap>
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

  /* Monthly totals per category, complete months only — the current month is
     always partial and averaging it in is what produced a $19 rent budget. */
  const monthlyByCat = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const per = {};   // cat -> { month -> total }
    for (const t of d.txns) {
      if (t.kind !== "out") continue;
      const m = String(t.date || "").slice(0, 7);
      if (!m || m >= thisMonth) continue;
      const n = d.cats.find((c) => c.id === t.catId)?.name || "Uncategorized";
      ((per[n] ||= {})[m] ||= 0);
      per[n][m] += Number(t.amount) || 0;
    }
    return per;
  };
  /* Median of the months a category actually appears in. Mean would let one
     $549 clothing month set a permanent budget; median wouldn't. */
  const medianOf = (obj) => {
    const v = Object.values(obj).sort((a, b) => a - b);
    if (!v.length) return 0;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const monthsOfData = () => {
    const ms = new Set(d.txns.filter((t) => t.kind === "out").map((t) => String(t.date || "").slice(0, 7)).filter(Boolean));
    ms.delete(new Date().toISOString().slice(0, 7));
    return ms.size;
  };
  /* Income from the ledger when the setting is blank. It defaulted to $0, and
     the AI then correctly concluded that someone earning nothing must cut
     everything to nothing — garbage in, confident garbage out. */
  const incomeGuess = () => {
    const set = Number(d.settings.incomeMonthly) || 0;
    if (set > 0) return { value: set, from: "your settings" };
    const thisMonth = new Date().toISOString().slice(0, 7);
    const per = {};
    for (const t of d.txns) {
      if (t.kind !== "in") continue;
      const m = String(t.date || "").slice(0, 7);
      if (!m || m >= thisMonth) continue;
      per[m] = (per[m] || 0) + (Number(t.amount) || 0);
    }
    const v = medianOf(per);
    return { value: Math.round(v), from: v ? "your deposits" : null };
  };

  /* No model call, no guesswork: what you actually spend, month by month. */
  const estimateFromHistory = () => {
    const n = monthsOfData();
    if (!n) return toast("No complete month of spending yet — an estimate now would just be noise.", "err");
    const per = monthlyByCat();
    const inc = incomeGuess();
    const limits = d.cats.map((c) => {
      const months = per[c.name] || {};
      const med = medianOf(months);
      /* round to something a person would actually type */
      const step = med >= 400 ? 25 : med >= 100 ? 10 : 5;
      return { cat: c.name, limit: Math.max(0, Math.round(med / step) * step), months: Object.keys(months).length };
    });
    const total = limits.reduce((s, l) => s + l.limit, 0);
    const thin = limits.filter((l) => l.months === 1 && l.limit > 0).map((l) => l.cat);
    const uncat = medianOf(per["Uncategorized"] || {});
    setReco({
      limits,
      note: "Median of what you actually spent across " + n + " complete month" + (n === 1 ? "" : "s") +
        " — median, not average, so one heavy month doesn't set a permanent budget. Totals " + fmt(total) + "/mo" +
        (inc.value ? " against " + fmt(inc.value) + " income (" + inc.from + "), leaving " + fmt(inc.value - total) : "") + "." +
        (uncat > 0 ? " " + fmt(uncat) + "/mo is still uncategorized and isn't in any line below — sort that in Merchants first for a real number." : "") +
        (thin.length ? " Only one month of data for: " + thin.join(", ") + "." : ""),
    });
  };

  const recommend = async () => {
    setRecoBusy(true); setReco(null);
    try {
      const per = monthlyByCat();
      const avg = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Math.round(medianOf(v))]));
      const debts = d.accounts.filter((a) => ["Credit card", "Auto loan", "Student loan", "Mortgage", "Other debt"].includes(a.type) && Number(a.balance) > 0)
        .map((a) => ({ name: a.name, balance: Number(a.balance), apr: Number(a.rate) || null, min: Number(a.minPay) || null }));
      const goalsMo = d.goals.reduce((s, g) => s + (Number(g.monthly) || 0), 0);
      const guess = incomeGuess();
      const inc = guess.value;
      if (!inc) { toast("No income on record — set monthly income in Settings, or sync a month of deposits. Without it any budget is fiction.", "err"); setRecoBusy(false); return; }
      const prompt =
        "You are a pragmatic budget planner. Monthly take-home income: $" + inc +
        " (from " + guess.from + "). Typical monthly spending by category, median of complete months: " + JSON.stringify(avg) +
        ". Debts: " + JSON.stringify(debts) + " (their minimum payments must be payable)." +
        " Goal contributions already planned: $" + goalsMo + "/mo." +
        " Categories to budget: " + JSON.stringify(d.cats.map((c) => c.name)) +
        '. Recommend a realistic monthly limit for EVERY listed category (trim where habits are loose, keep essentials honest), totaling comfortably under income minus debt minimums minus goal contributions. Respond ONLY JSON (no fences): {"limits": [{"cat": string, "limit": integer}], "note": string under 50 words explaining the biggest changes}.';
      const out = await callClaude(prompt);
      const j = extractJSON(out);
      if (Array.isArray(j.limits)) setReco(j);
      else throw new Error("Unexpected response");
    } catch (e) { toast("Recommendation failed — " + e.message, "err"); }
    setRecoBusy(false);
  };
  const [month, setMonth] = useState(thisMonth());
  const [nt, setNt] = useState({ date: today(), catId: d.cats[0]?.id || "", amount: "", note: "", kind: "out", accountId: "" });
  const [newCat, setNewCat] = useState("");
  const [openCat, setOpenCat] = useState("");   // which category is drilled into
  const [adding, setAdding] = useState(false);  // manual entry form, off by default
  const [txShown, setTxShown] = useState(25);   // grows in steps, never dumps 400 rows
  const [showImport, setShowImport] = useState(false);
  const [impMsg, setImpMsg] = useState("");
  const [q, setQ] = useState("");
  const [fCat, setFCat] = useState("");
  const [showAllTx, setShowAllTx] = useState(false);
  /* the longest thing on the tab by far — open on demand */
  const [txOpen, setTxOpen] = useState(false);

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
  const outTxns = monthTxns.filter((t) => t.kind === "out");
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
      <TransferCleanup d={d} setD={setD} />
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
            <button className="btn small" onClick={estimateFromHistory} title="Median of what you actually spent, no model involved">From my history</button>
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
        {/* Two bare numbers with a slash made you do the arithmetic yourself.
            What you actually want to know is "how much is left" — so that's the
            number, the bar is the glance, and the limit input hides until you
            reach for it. */}
        {d.cats.map((c, ci) => {
          const spent = spentBy[c.id] || 0;
          const lim = Number(c.limit) || 0;
          const p = lim > 0 ? Math.min(100, (spent / lim) * 100) : 0;
          const left = lim - spent;
          const state = lim <= 0 ? "none" : spent > lim ? "over" : spent >= lim * 0.8 ? "near" : "ok";
          const color = state === "over" ? "var(--down)" : state === "near" ? "var(--gold)" : seriesColor(ci);
          return (
            <div key={c.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                {/* "$183 over" is a verdict without evidence. Opening the row
                    names the merchants that produced it, biggest first, which is
                    the actual question — not that you're over, but on what. */}
                <button className="row catopen" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}
                  onClick={() => setOpenCat((v) => (v === c.id ? "" : c.id))}
                  title="See what's in this category this month">
                  <span className="note" style={{ margin: 0, width: 10 }}>{openCat === c.id ? "▾" : "▸"}</span>
                  <Icon k={catIconKey(c.name)} size={14} color={seriesColor(ci)} />
                  <b style={{ fontSize: 13.5 }}>{c.name}</b>
                </button>
                <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                  {lim > 0 ? (
                    <span className="mono" style={{ fontSize: 13.5, color, fontWeight: 600 }}>
                      {left >= 0 ? fmt(left) + " left" : fmt(-left) + " over"}
                    </span>
                  ) : (
                    <span className="note mono" style={{ margin: 0, fontSize: 12.5 }}>{fmt(spent)} spent · no budget set</span>
                  )}
                  <input className="in mono" type="number" style={{ width: 78, textAlign: "right", padding: "3px 7px", fontSize: 12 }}
                    value={c.limit} title="Monthly budget" placeholder="—"
                    onChange={(e) => setD((p2) => ({ ...p2, cats: p2.cats.map((x) => (x.id === c.id ? { ...x, limit: e.target.value === "" ? 0 : Number(e.target.value) } : x)) }))} />
                  <button className="x" onClick={() => setD((p2) => ({ ...p2, cats: p2.cats.filter((x) => x.id !== c.id) }))}>✕</button>
                </span>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 5 }}>
                <div className="bar" style={{ flex: 1, height: 7 }}>
                  <i style={{ width: (lim > 0 ? p : 0) + "%", background: color }} />
                </div>
                <span className="note mono" style={{ margin: 0, fontSize: 11, width: 96, textAlign: "right", flexShrink: 0 }}>
                  {lim > 0 ? fmt(spent) + " of " + fmt(lim) : ""}
                </span>
              </div>
              {openCat === c.id && (() => {
                const mine = monthTxns.filter((t) => t.kind === "out" && t.catId === c.id);
                if (!mine.length) return <div className="note" style={{ marginTop: 6 }}>Nothing in this category this month.</div>;
                /* group by merchant so five $12 lunches read as one $60 habit */
                const by = new Map();
                for (const t of mine) {
                  const k = normMerchant(t.note) || "(no description)";
                  const g = by.get(k) || { name: k, total: 0, n: 0 };
                  g.total += Number(t.amount) || 0; g.n++; by.set(k, g);
                }
                const list = [...by.values()].sort((a, b) => b.total - a.total);
                return (
                  <div className="catdrill">
                    {list.slice(0, 12).map((g) => (
                      /* clicking a merchant here opens the transaction list
                         filtered to it, which is where you can actually change
                         the category — naming the culprit without a way to fix
                         it is the complaint that produced this row */
                      <div className="cdrow cdclick" key={g.name} title={"Show " + g.name + " in the transaction list"}
                        onClick={() => { setQ(g.name); setFCat(""); setTxOpen(true); setTxShown(25);
                          setTimeout(() => document.querySelector(".trow")?.scrollIntoView({ behavior: "smooth", block: "center" }), 60); }}>
                        <span className="cdname">{g.name}</span>
                        <span className="note mono" style={{ margin: 0, fontSize: 11 }}>{g.n > 1 ? g.n + "×" : ""}</span>
                        <span className="mono" style={{ fontSize: 12.5 }}>{fmt(g.total)}</span>
                        <span className="note mono" style={{ margin: 0, fontSize: 11 }}>{spent > 0 ? Math.round((g.total / spent) * 100) + "%" : ""}</span>
                      </div>
                    ))}
                    {list.length > 12 && <div className="note" style={{ marginTop: 4 }}>+{list.length - 12} more merchants</div>}
                  </div>
                );
              })()}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 10 }}>
          <input className="in" style={{ flex: 1 }} placeholder="New category…" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button className="btn small" onClick={() => { if (newCat.trim()) { setD((p) => ({ ...p, cats: [...p.cats, { id: uid(), name: newCat.trim(), limit: 0 }] })); setNewCat(""); } }}>Add</button>
        </div>
        {/* Per-category over/under is a set of verdicts with no bottom line.
            Nothing on Shopping offsetting extra on Fun is the normal way a month
            actually works, and until now the page couldn't say so. */}
        {(() => {
          const budgeted = d.cats.filter((c) => Number(c.limit) > 0);
          if (!budgeted.length) return null;
          const lim = budgeted.reduce((s, c) => s + Number(c.limit), 0);
          const spentAll = budgeted.reduce((s, c) => s + (spentBy[c.id] || 0), 0);
          const diff = lim - spentAll;
          const over = budgeted.filter((c) => (spentBy[c.id] || 0) > Number(c.limit));
          const under = budgeted.filter((c) => (spentBy[c.id] || 0) < Number(c.limit));
          return (
            <div className="budgtot">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <b style={{ fontSize: 13.5 }}>All budgeted categories</b>
                <span className="mono" style={{ fontSize: 17, fontWeight: 600, color: diff >= 0 ? "var(--up)" : "var(--down)" }}>
                  {diff >= 0 ? fmt(diff) + " left" : fmt(-diff) + " over"}
                </span>
              </div>
              <div className="bar" style={{ height: 8, marginTop: 6 }}>
                <i style={{ width: Math.min(100, lim > 0 ? (spentAll / lim) * 100 : 0) + "%", background: diff >= 0 ? "var(--up)" : "var(--down)" }} />
              </div>
              <div className="note" style={{ marginTop: 5 }}>
                <b className="mono">{fmt(spentAll)}</b> of <b className="mono">{fmt(lim)}</b> across {budgeted.length} categories.
                {over.length > 0 && under.length > 0 && (
                  <> Over on {over.length}, under on {under.length} — {diff >= 0
                    ? "the underspend more than covers it, so the month is fine overall."
                    : "not quite enough to cover it."}</>
                )}
              </div>
            </div>
          );
        })()}
        {(() => { const tot = d.cats.reduce((s, c) => s + (Number(c.limit) || 0), 0);
          return tot > 0 ? <div className="note">Total budgeted: <b className="mono">{fmt(tot)}</b>{income > 0 ? (tot > income ? <span className="bad"> — over your {fmt(income)} income</span> : " of " + fmt(income) + " income") : ""}</div> : null; })()}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="foldhead" style={{ flex: 1, minWidth: 0 }} onClick={() => setTxOpen((v) => !v)}>
            <h3 style={{ margin: 0 }}>{searching ? "Search — all months" : "Transactions — " + monthLabel(month)}
              <span className="note" style={{ margin: "0 0 0 8px" }}>{txOpen ? "▴" : "▾"}</span></h3>
          </button>
          <span className="row" style={{ gap: 6 }}>
            {config?.aiEnabled && monthTxns.some((t) => !t.catId && t.kind === "out") && (
              <button className="btn small" disabled={catBusy} onClick={async () => {
                setCatBusy(true);
                try {
                  const un = monthTxns.filter((t) => !t.catId && t.kind === "out").slice(0, 60).map((t) => ({ i: t.id, d: t.note || "" }));
                  const prompt = "Categorize these bank transaction descriptions into EXACTLY one of: " + JSON.stringify(d.cats.map((c) => c.name)) +
                    ". Transactions: " + JSON.stringify(un) + '. Respond ONLY JSON array: [{"i": string, "cat": string}].';
                  const out = await callClaude(prompt);
                  const j = extractJSON(out);
                  const byName = Object.fromEntries(d.cats.map((c) => [c.name.toLowerCase(), c.id]));
                  setD((p) => ({ ...p, txns: p.txns.map((t) => {
                    const hit = j.find((x) => x.i === t.id);
                    return hit && byName[(hit.cat || "").toLowerCase()] ? { ...t, catId: byName[hit.cat.toLowerCase()] } : t;
                  }) }));
                } catch (e) { toast("Categorize failed — " + e.message, "err"); }
                setCatBusy(false);
              }}>{catBusy ? "Sorting…" : "AI categorize (" + monthTxns.filter((t) => !t.catId && t.kind === "out").length + ")"}</button>
            )}
            <button className="btn small" onClick={() => setShowImport(true)}>Import bank CSV</button>
          </span>
        </div>
        {txOpen && (<>
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
        {/* Everything arrives from the bank now, so a permanently-open manual
            entry form sat above the data looking like a broken filter — the
            date said 08/02 and changing its category appeared to do nothing,
            because it was never a filter at all. Still here for cash. */}
        {!adding && (
          <div className="mrow" style={{ justifyContent: "flex-start", margin: "8px 0 2px" }}>
            <button className="btn small" onClick={() => setAdding(true)}>+ Add one by hand</button>
          </div>
        )}
        {adding && <div className="trow">
          <input className="in" type="date" style={{ padding: "4px 6px" }} value={nt.date} onChange={(e) => setNt({ ...nt, date: e.target.value })} />
          <select className="in" style={{ padding: "4px 6px" }} value={nt.catId} onChange={(e) => setNt({ ...nt, catId: e.target.value })}>
            {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="in mono" type="number" placeholder="0" style={{ padding: "4px 6px" }} value={nt.amount} onChange={(e) => setNt({ ...nt, amount: e.target.value })} />
          <select className="in" style={{ padding: "4px 6px" }} value={nt.kind} onChange={(e) => setNt({ ...nt, kind: e.target.value })}>
            <option value="out">Spend</option><option value="in">Income</option><option value="xfer">Transfer</option>
          </select>
          <select className="in tacct" style={{ padding: "4px 6px" }} value={nt.accountId} onChange={(e) => setNt({ ...nt, accountId: e.target.value })}>
            <option value="">— account —</option>
            {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input className="in tnote" placeholder="Note" style={{ padding: "4px 6px" }} value={nt.note} onChange={(e) => setNt({ ...nt, note: e.target.value })} />
          <button className="btn small primary" style={{ padding: "4px 8px" }} onClick={() => {
            if (!nt.amount || (nt.kind === "out" && !nt.catId)) return;
            setD((p) => ({ ...p, txns: [...p.txns, { id: uid(), ...nt, catId: nt.kind === "out" ? nt.catId : "", amount: Number(nt.amount), kindSet: true }] }));
            setNt({ date: nt.date, catId: nt.catId, amount: "", note: "", kind: nt.kind, accountId: nt.accountId });
          }}>+</button>
          <button className="x" title="Done adding" onClick={() => setAdding(false)}>✕</button>
        </div>}
        {shownTxns.slice(0, txShown).map((t) => (
          <div className="trow" key={t.id} style={t.kind === "xfer" ? { opacity: 0.62 } : null}>
            {/* A pending charge is real money committed but not settled — the
                amount can still change, so say so rather than showing it as
                final. The dot carries a title, so it isn't colour alone. */}
            <span className="mono" style={{ fontSize: 12.5 }}>
              {t.pending && <span title="Pending — not settled yet; the amount can still change"
                style={{ color: "var(--gold)", marginRight: 4 }}>●</span>}
              {searching ? t.date : t.date.slice(5)}</span>
            {t.kind === "in"
              ? <span className="note" style={{ margin: 0 }}>Income</span>
              : t.kind === "xfer"
              ? <span className="note" style={{ margin: 0 }} title="Between your own accounts — not counted as income or spending">Transfer</span>
              /* Always a control. A categorised row used to render as static
                 text, so the moment Atlas guessed wrong — SimpleFIN filed under
                 Rent, a haircut filed as Rent — there was no way to fix it from
                 the list at all. The icon sits beside it rather than replacing
                 the affordance. */
              : (() => {
                  const ci = d.cats.findIndex((c) => c.id === t.catId);
                  return (
                    <span className="row catcell" style={{ gap: 5, flexWrap: "nowrap", minWidth: 0 }}>
                      <Icon k={catIconKey(d.cats[ci]?.name || "")} size={13}
                        color={t.catId ? seriesColor(ci) : "var(--gold)"} style={{ flexShrink: 0 }} />
                      <select className="in" value={t.catId || ""}
                        style={{ padding: "3px 5px", fontSize: 12, minWidth: 0, flex: 1, borderColor: t.catId ? undefined : "var(--gold)" }}
                        onChange={(e) => setD((p) => ({ ...p, txns: p.txns.map((x) => x.id === t.id ? { ...x, catId: e.target.value } : x) }))}>
                        <option value="">— none —</option>
                        {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </span>
                  );
                })()}
            <span className="mono" style={t.kind === "in" ? { color: "var(--acc)" } : t.kind === "xfer" ? { color: "var(--faint)" } : null}>{t.kind === "in" ? "+" : t.kind === "xfer" ? "⇄ " : ""}{fmt2(Number(t.amount))}</span>
            <select className="in" style={{ padding: "3px 4px", fontSize: 11.5, color: "var(--muted)" }} value={t.kind || "out"}
              title="Spend counts toward budgets, Income toward earnings, Transfer toward neither"
              onChange={(e) => setD((p) => ({ ...p, txns: p.txns.map((x) => x.id === t.id ? { ...x, kind: e.target.value, kindSet: true, catId: e.target.value === "out" ? x.catId : "" } : x) }))}>
              <option value="out">Spend</option><option value="in">Income</option><option value="xfer">Transfer</option>
            </select>
            <span className="tacct">{t.accountId ? <span className="tag">{(d.accounts.find((a) => a.id === t.accountId)?.name || "").slice(0, 18)}</span> : null}</span>
            <span className="tnote" style={{ color: "var(--muted)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleCase(t.note)}</span>
            <button className="x" onClick={() => setD((p) => ({ ...p, txns: p.txns.filter((x) => x.id !== t.id) }))}>✕</button>
          </div>
        ))}
        {/* 25 at a time. "Show all 400" is the thing that made this page a
            scrolling chore — the point of a show-more is that it stays short. */}
        {/* Collapse lives OUTSIDE the "more remain" test: once you've shown
            everything there is nothing more to show, and nesting it here meant
            the whole row vanished at exactly the point you'd want to fold it. */}
        {(shownTxns.length > txShown || txShown > 25) && (
          <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
            {shownTxns.length > txShown && (
              <button className="btn small" onClick={() => setTxShown((n) => n + 25)}>
                Show 25 more — {shownTxns.length - txShown} left
              </button>
            )}
            {txShown > 25 && <button className="btn small" onClick={() => setTxShown(25)}>Collapse</button>}
          </div>
        )}
        {!shownTxns.length && <div className="note">{searching ? "Nothing matches this search." : "No transactions this month yet — log spending above as it happens, or import your bank's CSV."}</div>}
        </>)}
      </div>

      <Fold title="Split rules" sub="for one payment that covers two things">

        <SplitRules d={d} setD={setD} />

      </Fold>

      <FoldWrap title="Recurring" sub="bills and subscriptions you've told Atlas about">
        <Recurring d={d} setD={setD} />
      </FoldWrap>
      <FoldWrap title="Subscription radar" sub="charges that repeat on their own">
        <SubscriptionRadar d={d} setD={setD} />
      </FoldWrap>

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
      {/* Plan and Goals genuinely do look alike; the split is what you're
          asking. Goals answers "am I on track for this thing I named."
          Plan answers "what should I do with the next dollar." */}
      <div className="note" style={{ marginBottom: 12 }}>
        <b>Plan is the strategy; Goals is the scoreboard.</b> Here you work out what the next dollar should do —
        emergency fund size, which debt to hit, whether a big purchase is affordable, what to owe in tax.
        In <b>Goals</b> you name a specific target ("move-out fund, $6,000 by June") and watch it fill.
        Set the strategy here, then create the goal there for anything you're actually saving toward.
      </div>

      {/* You asked not to open onto a wall of closed dropdowns — this is the
          answer each fold would have given, so you only open the one you want. */}
      <div className="glance">
        <div className="gtile">
          <div className="gtl">Emergency fund</div>
          <div className="gtv" style={{ color: efTarget > 0 && liq >= efTarget ? "var(--up)" : undefined }}>{Math.round(efPct)}%</div>
          <div className="gts">{efTarget > 0 ? fmt(liq) + " of " + fmt(efTarget) : "set your monthly expenses"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">401k match</div>
          <div className="gtv" style={{ color: missing > 0 ? "var(--down)" : "var(--up)" }}>{missing > 0 ? fmt(missing) : "✓"}</div>
          <div className="gts">{missing > 0 ? "left on the table each year" : "capturing the full match"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">Debts</div>
          <div className="gtv">{fmt(d.accounts.filter((a) => DEBT_TYPES.includes(a.type)).reduce((x, a) => x + (Number(a.balance) || 0), 0))}</div>
          <div className="gts">{d.accounts.filter((a) => DEBT_TYPES.includes(a.type) && Number(a.balance) > 0).length} account(s) carrying a balance</div>
        </div>
        <div className="gtile">
          <div className="gtl">Projected in {projYears}y</div>
          <div className="gtv">{fmt(projFV)}</div>
          <div className="gts">at {fmt(Number(projMonthly) || 0)}/mo</div>
        </div>
      </div>

      <FoldWrap title="Money order of operations" sub="what the next dollar should do">
        <OrderOfOps d={d} k401ok={matchCap > 0 && contribPct >= matchCap} />
      </FoldWrap>

      <FoldWrap title="Tax estimate" sub="what to set aside on untaxed income">
        <TaxCard d={d} setD={setD} />
      </FoldWrap>

      <Fold title="Emergency fund" right={efTarget > 0 ? Math.round(efPct) + "% funded" : null}>
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
      </Fold>

      <Fold title="401k match" right={missing > 0 ? fmt(missing) + " left on the table" : "full match captured"}>
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
      </Fold>

      <Fold title="Loan tracker" sub="what your payments have actually done to the balance">
        <Loan d={d} setD={setD} />
      </Fold>

      <FoldWrap title="Debt payoff" sub="avalanche vs snowball">
        <DebtPayoff d={d} setD={setD} />
      </FoldWrap>
      <FoldWrap title="Purchase planner" sub="can I afford this, and when">
        <PurchasePlanner d={d} setD={setD} />
      </FoldWrap>

      <Fold title="What would an offer change?" sub="run a real offer through your actual budget and goals">
        <OfferImpact d={d} setD={setD} />
      </Fold>

      <Fold title="Retire by…" sub="worked backwards from an age you pick" right={"target " + (d.settings.retTarget || 45)}>
        <Retire d={d} invested={investedNow} monthlySpendNow={avgSpend} />
      </Fold>

      <Fold title="Compound growth projector" right={fmt(projFV) + " in " + projYears + "y"}>
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
      </Fold>

      <Fold title="AI review" sub="a plain-English read on your numbers">
        <div className="note">Sends your numbers (from this app only) to Claude for a plain-language look at gaps and priorities. General education, not personalized investment advice.</div>
        <div className="mrow" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={aiBusy} onClick={aiReview}>{aiBusy ? "Reviewing…" : aiOut ? "Review again" : "Review my setup"}</button>
        </div>
        {aiErr && <div className="err">{aiErr}</div>}
        {aiOut && <div className="aiout">{aiOut}</div>}
      </Fold>
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
  const [delOpen, setDelOpen] = useState(false);
  const [del, setDel] = useState({ username: "", password: "" });
  const [delMsg, setDelMsg] = useState("");
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

  /* Two independent confirmations — the typed username and the password — because
     unlike everything else in this app, there is nothing to undo this with. */
  const deleteAccount = async () => {
    setDelMsg(""); setBusy(true);
    try {
      const r = await fetch("/api/account/delete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(del),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDelMsg(j.error || "Could not delete the account."); setBusy(false); return; }
      location.reload(); // the session cookie is already cleared; this lands on the sign-in screen
    } catch (e) { setDelMsg("Could not reach the server — nothing was deleted."); setBusy(false); }
  };

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

      <label className="f" style={{ marginTop: 18, color: "var(--down)" }}>Delete this account</label>
      {!delOpen ? (
        <div className="row">
          <div className="note" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            Removes your account, every transaction, and every stored resume PDF. There is no undo —
            the nightly encrypted backup is the only copy afterwards, and it rotates out within a week.
          </div>
          <button className="btn small danger" onClick={() => setDelOpen(true)}>Delete account…</button>
        </div>
      ) : (
        <div className="card" style={{ borderColor: "var(--down)", marginTop: 6 }}>
          <div className="note" style={{ marginTop: 0 }}>
            <b>Export your data first if you might want it.</b> Settings → Export gives you transactions as
            CSV and everything as JSON. Resume PDFs are not in that export — download them from Career first.
          </div>
          <label className="f">Type your username to confirm</label>
          <input className="in" autoComplete="off" value={del.username}
            onChange={(e) => setDel((p) => ({ ...p, username: e.target.value }))} />
          <label className="f">Your password</label>
          <input className="in" type="password" autoComplete="current-password" value={del.password}
            onChange={(e) => setDel((p) => ({ ...p, password: e.target.value }))} />
          {delMsg && <div className="note bad">{delMsg}</div>}
          <div className="mrow">
            <button className="btn" onClick={() => { setDelOpen(false); setDel({ username: "", password: "" }); setDelMsg(""); }}>Cancel</button>
            <button className="btn danger" disabled={busy || !del.username.trim() || !del.password}
              onClick={deleteAccount}>{busy ? "Deleting…" : "Permanently delete"}</button>
          </div>
        </div>
      )}

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
  const [showMore, setShowMore] = useState(false);
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
            career: { apps: saved.career?.apps || [], settings: saved.career?.settings || {} },
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

  /* The Teller Connect launcher used to live here. It injected a <script> from
     cdn.teller.io into this page, and no button has called it since bank sync
     moved to SimpleFIN. Dead code that grants a discontinued vendor script
     execution in a finance app is worth deleting, not commenting out — the CSP
     no longer allows it either. */

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
      rows.push([t.date, t.kind === "in" ? "income" : t.kind === "xfer" ? "transfer" : "expense", d.cats.find((c) => c.id === t.catId)?.name || "", t.amount, d.accounts.find((x) => x.id === t.accountId)?.name || "", t.note || ""]));
    dl("atlas-transactions-" + today() + ".csv", rows.map((r) => r.map(csvEsc).join(",")).join("\n"), "text/csv");
  };
  const exportJSON = () => dl("atlas-backup-" + today() + ".json", JSON.stringify(d, null, 2), "application/json");

  /* Autosave. A failure here used to be swallowed silently, so a save that never landed
     looked exactly like a successful one — surface it instead, and keep retrying.
     A 409 means another device saved since we loaded — pull the latest instead of clobbering it. */
  const [syncNotice, setSyncNotice] = useState("");
  /* Saves run one at a time through this chain. Two overlapping PUTs would both
     carry the same revision, so the second loses a 409 against our OWN first
     write — and the 409 handler reloads from the server, throwing away whatever
     was typed in between. (That was reproducible just by typing on a connection
     with any real latency.) Serializing, and recording the new revision even when
     the effect that started the save has been superseded, is what fixes it. */
  const saveChain = useRef(Promise.resolve());
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const t = setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        try {
          const r = await fetch("/api/data", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: d, rev: revRef.current }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.rev != null) revRef.current = j.rev; // must happen even if cancelled
          if (cancelled) return;
          if (r.ok) setSaveErr("");
          else if (r.status === 409) {
            setSyncNotice("Another device saved changes — loaded the latest version.");
            setTimeout(() => setSyncNotice(""), 7000);
            await loadData();
          } else setSaveErr(j.error || "Couldn't save (HTTP " + r.status + ")");
        } catch (e) { if (!cancelled) setSaveErr("Couldn't reach the server — changes aren't saved yet."); }
      });
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [d, loaded, saveNonce]);

  /* One retro pass per load: sync only categorizes NEW imports, so anything that
     predates the rules (or came from CSV) gets the merchant-memory + keyword
     treatment here. Only ever fills empty categories — never overwrites. */
  useEffect(() => {
    if (!loaded) return;
    setD((p) => {
      const memory = buildMerchantMemory(p.txns, p.cats);
      /* A rule can want a category you don't have yet — a $4,700 IRS payment
         sitting in "Uncategorized" is exactly the case. Create those, so the
         money lands somewhere that explains itself. */
      const cats = [...p.cats];
      const wantNames = new Set();
      p.txns.forEach((t) => {
        if (t.kind !== "out" || t.catId || !t.note) return;
        if (memory[normMerchant(t.note)]) return;
        const name = ruleCategoryName(t.note, Number(t.amount));
        if (name && !cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) wantNames.add(name);
      });
      wantNames.forEach((name) => cats.push({ id: uid(), name, limit: 0 }));

      let n = 0;
      const txns = p.txns.map((t) => {
        if (t.kind !== "out" || t.catId || !t.note) return t;
        const c = autoCategorize(t.note, cats, memory, Number(t.amount));
        if (!c) return t;
        n++;
        return { ...t, catId: c };
      });
      if (!n) return p;
      const made = [...wantNames];
      setTimeout(() => toast("Auto-categorized " + n + (n === 1 ? " transaction" : " transactions")
        + (made.length ? " — added " + made.join(" and ") + (made.length === 1 ? " as a category" : " as categories") : "") + "."), 0);
      return { ...p, cats, txns };
    });
  }, [loaded]);

  /* Once a month has closed, write its recap on its own — one call, stored with
     your data, never repeated. Skipped if the month had no activity. */
  const recapTried = useRef(false);
  const dRef = useRef(d);
  dRef.current = d;
  useEffect(() => {
    if (!loaded || !config?.aiEnabled || recapTried.current) return;
    const last = prevMonth(thisMonth());
    if ((d.settings.recaps || {})[last]) return;
    if (!d.txns.some((t) => (t.date || "").startsWith(last))) return;
    recapTried.current = true;
    let cancelled = false;
    /* Wait a beat so the retro categorization pass above has committed — otherwise
       the one recap we ever write describes a month that was still "Uncategorized",
       and the guard above stops it from ever being rewritten. */
    new Promise((r) => setTimeout(r, 1200)).then(() => generateRecap(dRef.current, last))
      .then((text) => {
        if (cancelled) return;
        setD((p) => ({ ...p, settings: { ...p.settings, recaps: { ...(p.settings.recaps || {}), [last]: text } } }));
        toast("Wrote your " + monthLabel(last) + " recap — it's on the Dashboard.");
      })
      .catch(() => {}); // a failed auto-recap is not worth interrupting anyone over
    return () => { cancelled = true; };
  }, [loaded, config]);

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

  const TABS = [["dash", "Dashboard"], ["overview", "Accounts"], ["budget", "Budget"], ["merchants", "Merchants"],
    ["assistant", "Assistant"], ["career", "Career"], ["invest", "Invest"], ["goals", "Goals"], ["plan", "Plan"]];
  /* phones get a 4-up bottom bar; the rest live behind More */
  const PRIMARY = [["dash", "Dashboard", "grid"], ["overview", "Accounts", "bank"], ["budget", "Budget", "bars"], ["assistant", "Atlas", "chat"]];
  const SECONDARY = TABS.filter(([id]) => !PRIMARY.some((p) => p[0] === id));

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
            <button className="btn small" title="Toggle theme" style={{ display: "inline-flex", alignItems: "center" }} onClick={() => setD((p) => ({ ...p, settings: { ...p.settings, theme: p.settings.theme === "dark" ? "light" : "dark" } }))}>
              <ThemeIcon dark={d.settings.theme === "dark"} />
            </button>
            <button className="btn small" onClick={() => setShowSecurity(true)}>Security</button>
            <button className="btn small" onClick={() => setShowSettings(true)}>Settings</button>
          </div>
        </div>
      </header>
      <main className="wrap">
        {saveErr && (
          <div className="card" style={{ borderColor: "var(--red)", background: "var(--red-soft)", marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span><b style={{ color: "var(--red)" }}>Not saved.</b> {saveErr} Keep this tab open until it saves.</span>
              <button className="btn small" onClick={() => setSaveNonce((n) => n + 1)}>Retry now</button>
            </div>
          </div>
        )}
        {syncNotice && <div className="banner">{syncNotice}</div>}
        {tab === "dash" && <Dashboard d={d} setD={setD} config={config} setTab={setTab} />}
        {tab === "overview" && <Overview d={d} setD={setD} config={config} syncBusy={syncBusy} syncMsg={syncMsg} onSync={syncNow} onRemoveBank={removeBank} onReload={loadData} />}
        {tab === "budget" && <><Budget d={d} setD={setD} config={config} /><FoldWrap title="Trends" sub="month by month, and year over year"><Trends d={d} /></FoldWrap></>}
        {tab === "merchants" && <Merchants d={d} setD={setD} />}
        {tab === "assistant" && <AskAtlas d={d} setD={setD} config={config} />}
        {tab === "career" && <Career d={d} setD={setD} config={config} toast={toast} />}
        {tab === "invest" && <Invest d={d} setD={setD} config={config} />}
        {tab === "goals" && <Goals d={d} setD={setD} />}
        {tab === "plan" && <Plan d={d} setD={setD} />}
      </main>
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

      <nav className="bottomnav" aria-label="Sections">
        {PRIMARY.map(([id, label, icon]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)} aria-current={tab === id}>
            <Icon k={icon} size={20} />{label}
          </button>
        ))}
        <button className={SECONDARY.some(([id]) => id === tab) ? "on" : ""} onClick={() => setShowMore(true)}>
          <Icon k="dots" size={20} />More
        </button>
      </nav>
      {showMore && (
        <Modal title="More" onClose={() => setShowMore(false)}>
          {SECONDARY.map(([id, label]) => (
            <div className="kv" key={id}>
              <button className="btn" style={{ width: "100%", textAlign: "left", background: tab === id ? "var(--acc-soft)" : undefined }}
                onClick={() => { setTab(id); setShowMore(false); }}>{label}</button>
            </div>
          ))}
        </Modal>
      )}
      <Toasts />
    </div>
  );
}

/* ---------------- transfers + auto-categorization ----------------
   Mirrors of the server-side logic in server/index.js — keep the two in sync.
   The server classifies NEW transactions at sync time; this covers everything
   already on the books plus CSV imports. */

/* Moving money into a brokerage is not spending — it's your net worth changing
   shape. Counting a $3,000 Fidelity contribution as an expense made March read
   as a $12k month and poisoned every average built on it. */
const IMPORT_CAP = 2000;   // a full year of a busy account, not a third of one
const XFER_RE = /\btransfer\b|\bxfer\b|autopay|auto ?pay|card ?(?:pay(?:ment)?|pmt)\b|payment to .{0,28}(?:card|loan|mortgage)|crd (?:pmt|pay)|\bpymt\b|\bpmt\b|payment thank ?you|automatic payment.{0,6}thank|thank you.*payment|internet payment|jpmorgan chase bank|\be-?payment\b|\bepay\b|directpay|fid(?:elity)? bkg|\bmoneyline\b|\bwebull\w*|\brobinhood\w*|\bschwab\w*|\bvanguard\b|e\*trade|\bacorns\b|\bbetterment\b|\bwealthfront\w*|\bcoinbase\w*|m1 ?finance|\btd ameritrade|interactive brokers/i;
const CAT_RULES = [
  /* Rules run in order and the first match wins, so the specific ones that were
     getting swallowed by broader rules (or by merchant memory) go first.

     Every entry here comes from a real misfile: a utility whose descriptor is
     truncated below the word "utility", a fuel brand missing from the transport
     list, a salon that reads like a building, and Atlas's own SimpleFIN
     subscription filed as Rent. */
  [/deltastatesutil|delta states util|\bcpenergy\b|cp energy|\bcleco\b|lus fiber|atmos energy|\bsouthwestern electric|entergy|slemco|demco\b/, "Utilities"],
  [/conoco|phillips ?66|\bexxon\b|\bmobil\b|\bshell oil|\bchevron\b|\bcitgo\b|\bvalero\b|\bsunoco\b|\bmarathon\b|\bcircle k|\bracetrac\b|\bquiktrip\b|\bqt \d|\bbuc-?ee|\bmurphy usa|\bpilot travel|\bloves? travel|\bwawa\b|\bsheetz\b|\bkwik|\bcasey'?s gen/, "Transport"],
  [/\bthe loft\b|squire the loft|\bsalon\b|\bbarber|haircut|\bsupercuts\b|great clips|sport ?clips|hair ?(salon|studio|co\b)|\bspa\b|\bnails?\b|massage/, "Health"],
  [/simplefin|link\.com\*|\blink com simplefin/, "Subscriptions"],
  /* big p2p payments are almost always rent/housing — small ones could be anything.
     The third element is a minimum $ amount for the rule to apply. */
  [/\birs\b|internal revenue|us ?treasury|treas ?tax|tax ?(pmt|payment)|dept? of revenue|state tax|franchise tax|turbotax|h&r block|jackson hewitt|taxact/, "Taxes"],
  /* A car payment is not Transport (that's fuel and parking) and not Rent. It's
     a fixed debt obligation, and lumping it into either makes both budgets
     nonsense — the whole point of a budget line is that you can cut it, and you
     cannot cut a loan payment. */
  [/\b(auto|car) (loan|pmt|payment|finance)|carmax auto|capital one auto|ally (auto|financial)|santander consumer|chrysler capital|toyota financial|honda financial|ford credit|gm financial|nissan motor accept|hyundai motor finance|westlake financial|exeter finance|bridgecrest|\bcredit acceptance\b|drivetime|regional acceptance/, "Car / loan payment"],
  [/\b(student ?loan|nelnet|mohela|navient|great lakes|aidvantage|sallie mae|earnest|sofi loan)\b/, "Car / loan payment"],
  [/venmo payment|zelle (payment|to)/, "Rent", 500],
  /* Walmart's own merchant string is "WM SUPERCENTER #124", which no amount of
     matching on "walmart" will ever catch. */
  [/kroger|trader joe|aldi|wal-?mart|\bwm supercenter|\bwm superc|neighborhood market|h-?e-?b\b|publix|safeway|whole ?foods|wholefds|costco|sam'?s club|food lion|winn-?dixie|meijer|sprouts|wegmans|grocery|supermarket/, "Groceries"],
  /* Brand names alone are a losing game — there are more restaurants than any
     list can hold. These generic words carry the meaning: "In-N-Out Donuts",
     "Tst* Bb.q Chicken Usa" and "Genesis Health Clubs" matched nothing at all
     while being completely obvious to a human. "Tst*" is Toast's card-processor
     prefix and appears on a huge number of independent restaurants. */
  [/mcdonald|five guys|chipotle|taco bell|burger|wendy|chick.?fil|kfc|popeyes|starbucks|dunkin|subway\b|domino|pizza|panera|sonic drive|whataburger|panda express|raising cane|grill|restaur|cafe|café|coffee|doordash|uber ?eats|grubhub|postmates|seamless|caviar|bakery|diner|ihop|waffle house|bon appetit|culver|zaxby|wingstop|jimmy john|jersey mike|\btst\*|\btoast\b ?\*|\bsq \*|donut|doughnut|chicken|\bbbq\b|bb\.?q|barbecue|taco|sushi|ramen|noodle|deli\b|bistro|brewing|brewery|taproom|pub\b|tavern|bar & grill|steakhouse|buffet|creamery|ice cream|frozen yogurt|smoothie|juice bar|boba|tea house|sandwich|burrito|wings\b|kitchen\b|eatery|food ?truck|catering|snack|bagel|pretzel|cupcake|\bpho\b|\bwok\b|hibachi|teriyaki|cantina|taqueria|trattoria|pizzeria/, "Eating out"],
  [/exxon|shell oil|chevron|texaco|citgo|valero|racetrac|quiktrip|\bqt\b|speedway|murphy usa|circle k|7-?eleven fuel|uber(?! ?eats)|lyft|parking|toll|jiffy lube|autozone|o'?reilly|discount tire|car wash/, "Transport"],
  /* Utilities before Subscriptions: a cable/internet bill is a utility, and
     lumping it in with Netflix made "cut your subscriptions" advice nonsense —
     you cannot cancel your electricity. Airlines before Transport's fuel list
     so a flight doesn't fall through to uncategorized. */
  [/optimum|spectrum|xfinity|comcast|cox communi|at&?t\b|verizon|t-?mobile|sparklight|centurylink|frontier comm|google fiber|starlink|entergy|swepco|ameren|duke energy|dominion energy|con ?ed|pg&?e|oncor|centerpoint|city of \w+ util|water (works|dept|utility)|sewer|waste management|republic services|trash|electric (co|company|coop)|gas (co|company|utility)|utility|utilities/, "Utilities"],
  /* "southwes" alone would also match Southwest Power Pool — his employer — so
     the airline form requires the ticket number the airline always appends. */
  [/southwest airlines|southwes\w* \d|delta air|american air|united air|jetblue|alaska air|spirit air|frontier air|allegiant|hawaiian air|expedia|kayak|priceline|orbitz|booking\.com|airbnb|vrbo|hertz|enterprise rent|avis|budget rent|national car|amtrak|greyhound|\bairlines?\b|\bairways\b/, "Transport"],
  [/netflix|spotify|hulu|disney ?\+|hbo ?max|paramount|peacock|crunchyroll|youtube ?(premium|tv)|apple\.com\/bill|apple ?one|icloud|google ?(one|storage)|dropbox|adobe|microsoft 365|xbox game|playstation|nintendo|patreon|twitch|discord|cloudflare|github|godaddy|namecheap|\bvpn\b|audible|kindle unltd|anthropic|openai|chatgpt|claude/, "Subscriptions"],
  [/amazon|amzn|target\b|best buy|ebay|etsy|dollar (general|tree)|five below|ross store|tj ?maxx|marshalls|old navy|h&m\b|zara|nike|shein|temu|home depot|lowe'?s|ikea|j\.? ?crew|gap\b|banana republic|american eagle|hollister|abercrombie|urban outfitters|forever 21|uniqlo|lululemon|dick'?s sporting|academy sports|belk\b|dillard|macy'?s|nordstrom|kohl'?s|jcpenney|sephora|ulta|bath ?& ?body/, "Shopping"],
  [/rent\b|apartment|property (mgmt|management)|landlord/, "Rent"],
  [/\bgym\b|planet fitness|la fitness|ymca|crunch fitness|health club|fitness|athletic club|wellness|orangetheory|f45|crossfit|pilates|yoga|peloton|walgreens|cvs\b|rite aid|pharmacy|drug ?store|clinic|dental|dentist|orthodon|doctor|\bmd\b ?office|physician|hospital|urgent care|optical|optometr|vision center|therapy|therapist|chiroprac|dermatolog|lab ?corp|quest diagnostic|medical|health ?care|\brx\b/, "Health"],
  [/cinema|cinemark|\bamc\b|regal|steam(games| purchase)|steampowered|epic games|riot|blizzard|ticketmaster|stubhub|bowling|arcade|spotify concert|eventbrite/, "Fun"],
];
/* p2p sends share one merchant key ("venmo payment web id") but mean something
   different every time — never let one categorization spread to all of them */
const P2P_RE = /venmo (payment|cashout)|cash ?app|zelle/i;
function buildMerchantMemory(txns, cats) {
  const catIds = new Set((cats || []).map((c) => c.id));
  const mem = {};
  for (const t of txns) { // later (newer) categorizations overwrite older ones
    if (t.kind === "out" && t.catId && catIds.has(t.catId) && t.note && !P2P_RE.test(t.note)) {
      const k = normMerchant(t.note);
      if (k.length >= 3) mem[k] = t.catId;
    }
  }
  return mem;
}
/* the category NAME a rule wants, whether or not that category exists yet */
function ruleCategoryName(note, amount) {
  const n = String(note || "").toLowerCase();
  for (const [re, name, min] of CAT_RULES) {
    if (min && !(Number(amount) >= min)) continue;
    if (re.test(n)) return name;
  }
  return "";
}
function autoCategorize(note, cats, memory, amount) {
  const key = normMerchant(note);
  if (key && memory[key]) return memory[key];
  const name = ruleCategoryName(note, amount);
  if (name) {
    const c = (cats || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (c) return c.id;
  }
  return "";
}

/* Find existing transactions that are almost certainly transfers:
   keyword matches, inflows on debt accounts (card payments arriving), and
   equal-and-opposite pairs across two accounts within 4 days. Manually
   typed rows (kindSet) are never second-guessed. */
function detectTransferCandidates(txns, accounts) {
  const isDebtAcc = (id) => { const a = accounts.find((x) => x.id === id); return !!a && DEBT_TYPES.includes(a.type); };
  const ids = new Set();
  for (const t of txns) {
    if (t.kind === "xfer" || t.kindSet) continue;
    if (XFER_RE.test(t.note || "")) { ids.add(t.id); continue; }
    if (t.kind === "in" && isDebtAcc(t.accountId)) ids.add(t.id);
  }
  const pool = txns.filter((t) => t.tellerId && !t.catId && !t.kindSet && !ids.has(t.id));
  const ins = pool.filter((t) => t.kind === "in");
  const used = new Set();
  for (const o of pool) {
    if (o.kind !== "out") continue;
    const m = ins.find((i) => !used.has(i.id) && i.accountId !== o.accountId &&
      Math.abs(Number(i.amount) - Number(o.amount)) < 0.005 &&
      Math.abs(new Date(i.date) - new Date(o.date)) <= 4 * 864e5);
    if (m) { ids.add(o.id); ids.add(m.id); used.add(m.id); }
  }
  return ids;
}

function TransferCleanup({ d, setD }) {
  const ids = useMemo(() => detectTransferCandidates(d.txns, d.accounts), [d.txns, d.accounts]);
  if (!ids.size) return null;
  const total = d.txns.filter((t) => ids.has(t.id)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  return (
    <div className="banner">
      <b>{ids.size} likely transfer{ids.size === 1 ? "" : "s"} detected</b> — credit-card payments and moves between
      your own accounts (~<b className="mono">{fmt(total)}</b>) are being counted as income and spending, inflating both.
      Marking them as transfers keeps them in the ledger but out of the math. Anything mis-flagged can be flipped
      back with the type dropdown in Budget.
      <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
        <button className="btn small primary" onClick={() => {
          setD((p) => ({ ...p, txns: p.txns.map((t) => (ids.has(t.id) ? { ...t, kind: "xfer", kindSet: true } : t)) }));
          toast("Marked " + ids.size + " transactions as transfers — income and spending are clean now.");
        }}>Mark {ids.size} as transfers</button>
      </div>
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
      /* Duplicate detection used to require an EXACT note match, which is the one
         thing that never survives crossing sources: the same Venmo payment reads
         "VENMO            PAYMENT    105180" in a Chase CSV and "VENMO PAYMENT
         105180 WEB ID: 3264" over SimpleFIN. It caught nothing, and importing a
         CSV over synced months silently doubled every transaction in them.
         Amount plus a few days' drift is the part that actually holds. */
      const cents = (n) => Math.round(Math.abs(Number(n) || 0) * 100);
      const byAmount = new Map();
      d.txns.forEach((t) => {
        const k = cents(t.amount);
        if (!byAmount.has(k)) byAmount.set(k, []);
        byAmount.get(k).push(t.date);
      });
      const isDup = (r) => (byAmount.get(cents(r.amount)) || [])
        .some((dt) => Math.abs((Date.parse(dt) - Date.parse(r.date)) / 86400000) <= 3);
      const memory = buildMerchantMemory(d.txns, d.cats);
      setRows(parsed.slice(0, IMPORT_CAP).map((r) => {
        const dup = isDup(r);
        const xfer = !r.credit && XFER_RE.test(r.desc); // card payments / account moves — not spending
        return {
          ...r, dup, xfer,
          include: !r.credit && !dup && !xfer,
          catId: autoCategorize(r.desc, d.cats, memory, r.amount) || d.cats[0]?.id || "",
        };
      }));
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
    setD((p) => ({ ...p, txns: [...p.txns, ...inc.map((r) => ({ id: uid(), date: r.date, catId: r.credit || r.xfer ? "" : r.catId, amount: r.amount, note: r.desc.slice(0, 60), kind: r.credit ? "in" : r.xfer ? "xfer" : "out", accountId: acctId, kindSet: true }))] }));
    onClose(inc.length);
  };

  const nInc = rows ? rows.filter((r) => r.include).length : 0;

  return (
    <Modal title="Import bank CSV" onClose={() => onClose(0)}>
      <div className="note">
        Works with transaction exports from Chase, Capital One, Fidelity, and most banks (download from your bank's website — usually under Activity → Download/Export → CSV). Credits, card payments, and transfers are excluded by default; nothing here ever asks for a login.
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
            <button className="btn" disabled={busy || !nInc} onClick={autoCat}>{busy ? "Categorizing…" : "Auto-categorize"}</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto", marginTop: 8, border: "1px solid var(--line)", borderRadius: 10, padding: "4px 10px" }}>
            {rows.map((r, i) => (
              <div key={i} className="row" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", opacity: r.include ? 1 : 0.45 }}>
                <input type="checkbox" checked={r.include} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                <span className="mono" style={{ fontSize: 12, width: 44 }}>{r.date.slice(5)}</span>
                <span style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.desc}>{r.desc}{r.dup ? " ·dup" : ""}{r.credit ? " ·credit" : ""}{r.xfer ? " ·transfer" : ""}</span>
                <span className="mono" style={{ fontSize: 12.5 }}>{fmt2(r.amount)}</span>
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
      <div className="note">Rent, subscriptions, insurance. <b>Auto-log</b> = Atlas creates the transaction itself when the day
        comes — use it only for bills that never hit a synced account. <b>Watching</b> = the real charge already arrives via
        bank sync/CSV, so this entry only powers Upcoming bills. A bill that's Auto-log <i>and</i> synced gets counted twice —
        that inflates spending; flip those to Watching.</div>
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
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="mono">{fmtAmt(r.amount)}{(r.freq || "m") === "m" ? "/mo" : "/yr"}</span>
              <button className="btn small" style={r.watch ? {} : { borderColor: "var(--gold)", color: "var(--gold)" }}
                title={r.watch
                  ? "Watching: the real charge arrives via bank sync/CSV — this entry only powers Upcoming bills"
                  : "Auto-log: Atlas creates this transaction itself each cycle. If the same charge ALSO arrives via bank sync, it's double-counted — click to switch to Watching."}
                onClick={() => setD((p) => ({ ...p, recurring: p.recurring.map((x) => (x.id === r.id ? { ...x, watch: !x.watch } : x)) }))}>
                {r.watch ? "Watching" : "Auto-log"}
              </button>
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
  d.txns.filter((t) => t.kind === "out" && !t.recId && t.note).forEach((t) => {
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
      <div className="note">Charges that repeat monthly at a stable amount. <b>Watch</b> moves one into your Recurring list (and Upcoming bills on the dashboard) without double-logging — the charges keep arriving via sync/CSV as they do now. This is also the list to prune: every line is money leaving on autopilot.</div>
      {found.map((f) => (
        <div className="kv" key={f.key}>
          <span className="k"><b style={{ color: "var(--text)" }}>{f.name}</b>
            <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · seen {f.count}× · ~day {f.day}</span></span>
          <span className="row" style={{ gap: 6 }}>
            <span className="mono">{fmtAmt(f.amount)}/mo</span>
            <button className="btn small" onClick={() => {
              setD((p) => ({ ...p, recurring: [...p.recurring, { id: uid(), name: f.name, catId: f.catId || p.cats[0]?.id || "", amount: f.amount, freq: "m", day: f.day, watch: true }] }));
              toast("Watching " + f.name + " — it's now under Recurring, and in Upcoming bills on the dashboard.");
            }}>Watch</button>
            <button className="x" title="Not a subscription — hide" onClick={() => {
              setD((p) => ({ ...p, settings: { ...p.settings, subIgnore: [...(p.settings.subIgnore || []), f.key] } }));
              toast("Hidden — " + f.name + " won't be suggested again.");
            }}>✕</button>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Merchants tab ----------------
   Who actually takes your money, ranked. Categorizing here applies to every
   transaction from that merchant at once — the fastest way to clear a backlog
   and the easiest way to see what a budget needs to cover. */

/* One transfer that was really two things. Without this, a $750 payment that is
   $475 rent and $275 car has to be filed as one or the other, and every budget
   line downstream inherits that lie. */
function SplitSheet({ txn, cats, onClose, onSave }) {
  const total = Number(txn.amount) || 0;
  const [parts, setParts] = useState([
    { id: 1, amount: "", catId: cats[0]?.id || "" },
    { id: 2, amount: "", catId: cats[1]?.id || "" },
  ]);
  const sum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const left = Math.round((total - sum) * 100) / 100;
  const ok = parts.every((p) => Number(p.amount) > 0 && p.catId) && Math.abs(left) < 0.01;

  return (
    <Modal title={"Split " + fmt2(total)} onClose={onClose}>
      <div className="note" style={{ marginTop: 0 }}>
        {txn.date} · {txn.note}
      </div>
      {parts.map((p, i) => (
        <div className="row" key={p.id} style={{ marginTop: 6 }}>
          <input className="in mono" type="number" step="0.01" style={{ width: 120 }} placeholder="0.00" value={p.amount}
            onChange={(e) => setParts((v) => v.map((x) => (x.id === p.id ? { ...x, amount: e.target.value } : x)))} />
          <select className="in" style={{ flex: 1, minWidth: 130 }} value={p.catId}
            onChange={(e) => setParts((v) => v.map((x) => (x.id === p.id ? { ...x, catId: e.target.value } : x)))}>
            <option value="">— category —</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {parts.length > 2 && <button className="x" onClick={() => setParts((v) => v.filter((x) => x.id !== p.id))}>✕</button>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => setParts((v) => [...v, { id: Date.now(), amount: "", catId: "" }])}>+ Part</button>
        {/* the last part is usually "whatever's left", so offer it */}
        {Math.abs(left) >= 0.01 && (
          <button className="btn small" onClick={() => setParts((v) => {
            const i = v.findIndex((x) => !Number(x.amount));
            const at = i === -1 ? v.length - 1 : i;
            return v.map((x, k) => (k === at ? { ...x, amount: String(Math.round((Number(x.amount) || 0) + left) ) } : x));
          })}>Put the remaining {fmt2(Math.abs(left))} on {left > 0 ? "an empty" : "the last"} part</button>
        )}
        <span className="note" style={{ margin: 0, color: Math.abs(left) < 0.01 ? "var(--up)" : "var(--down)" }}>
          {Math.abs(left) < 0.01 ? "Balances exactly" : fmt2(Math.abs(left)) + (left > 0 ? " left to assign" : " over the total")}
        </span>
      </div>
      <div className="mrow">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} onClick={() => onSave(parts)}>Split into {parts.length}</button>
      </div>
    </Modal>
  );
}

function Merchants({ d, setD }) {
  const [range, setRange] = useState("3m");
  const [sort, setSort] = useState("total");
  const [onlyUncat, setOnlyUncat] = useState(false);
  const [mShown, setMShown] = useState(10);   // 130 rows is not a list anyone reads
  const [q, setQ] = useState("");
  const [openKey, setOpenKey] = useState(null);
  const [split, setSplit] = useState(null);

  const rows = useMemo(() => {
    const start = rangeStart(range);
    const groups = {};
    /* Transfers are counted but not totalled. Excluding them outright made a
       mis-detected transfer unreachable: a $750 Venmo that is really rent gets
       auto-marked a transfer, vanishes from this page, and then there is
       nowhere in the app to change it back. They belong in the list; they just
       don't belong in the spending total. */
    d.txns.forEach((t) => {
      if ((t.kind !== "out" && t.kind !== "xfer") || !(t.date >= start)) return;
      const key = normMerchant(t.note) || "(no description)";
      const g = (groups[key] = groups[key] || { key, total: 0, count: 0, xfers: 0, last: "", label: "", cats: {}, ids: [] });
      if (t.kind === "xfer") g.xfers++;
      else { g.total += Number(t.amount) || 0; g.count++; if (t.catId) g.cats[t.catId] = (g.cats[t.catId] || 0) + 1; }
      g.ids.push(t.id);
      if (t.date > g.last) { g.last = t.date; g.label = t.note || key; }
    });
    let list = Object.values(groups).map((g) => ({
      ...g,
      avg: g.count ? g.total / g.count : 0,
      catId: Object.entries(g.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
      uncatted: g.count - Object.values(g.cats).reduce((s, v) => s + v, 0),
      mixed: P2P_RE.test(g.label),
    }));
    const ql = q.trim().toLowerCase();
    if (ql) list = list.filter((g) => g.label.toLowerCase().includes(ql) || g.key.includes(ql));
    const cmp = { total: (a, b) => b.total - a.total, count: (a, b) => b.count - a.count, recent: (a, b) => b.last.localeCompare(a.last) };
    return list.sort(cmp[sort]);
  }, [d.txns, range, sort, q]);

  const grand = rows.reduce((s, r) => s + r.total, 0);
  /* The card promises "all of that merchant's transactions", so match on the
     merchant key across the whole ledger — not just the rows the range filter
     happens to be showing. */
  const allFor = (r, txns) => txns.filter((t) => (t.kind === "out" || t.kind === "xfer") && (normMerchant(t.note) || "(no description)") === r.key);
  const setCat = (r, catId) => {
    if (!catId) return; // the blank option would otherwise silently un-file everything
    let n = 0;
    setD((p) => {
      const ids = new Set(allFor(r, p.txns).map((t) => t.id));
      n = ids.size;
      return { ...p, txns: p.txns.map((t) => (ids.has(t.id) ? { ...t, catId } : t)) };
    });
    toast("Filed " + n + (n === 1 ? " transaction" : " transactions") + " from " + titleCase(r.label).slice(0, 24) + " under " + (d.cats.find((c) => c.id === catId)?.name || "?") + ".");
  };
  const makeTransfers = (r) => {
    let n = 0;
    setD((p) => {
      const ids = new Set(allFor(r, p.txns).map((t) => t.id));
      n = ids.size;
      return { ...p, txns: p.txns.map((t) => (ids.has(t.id) ? { ...t, kind: "xfer", kindSet: true, catId: "" } : t)) };
    });
    toast("Moved " + n + " out of spending — they're transfers now.");
  };

  /* The per-merchant dropdown is fine for one row and tedious for thirty. This
     runs the same rules the sync uses over everything still unfiled — J.Crew is
     Shopping, a Delta ticket is Transport — and touches nothing already filed,
     so a category you set by hand is never overwritten. */
  const uncatted = rows.filter((r) => r.uncatted > 0);
  /* the unfiled subset, when the toggle above is on */
  const shownRows = onlyUncat ? uncatted : rows;
  const fileTheObvious = () => {
    let n = 0, hits = {}, added = [];
    setD((p) => {
      /* A rule whose category doesn't exist silently does nothing. Accounts
         created before Utilities existed would never file a power bill and
         would never be told why — so create what the matching rules need. */
      let cats = p.cats;
      const want = new Set();
      for (const t of p.txns) {
        if (t.kind !== "out" || t.catId) continue;
        const n2 = String(t.note || "").toLowerCase();
        for (const [re, name, min] of CAT_RULES) {
          if (min && !(Number(t.amount) >= min)) continue;
          if (re.test(n2)) { want.add(name); break; }
        }
      }
      for (const name of want) {
        if (!cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          cats = [...cats, { id: uid(), name, limit: 0 }];
          added.push(name);
        }
      }
      p = { ...p, cats };

      const mem = buildMerchantMemory(p.txns, p.cats);
      const txns = p.txns.map((t) => {
        if (t.kind !== "out" || t.catId) return t;
        const catId = autoCategorize(t.note, p.cats, mem, Number(t.amount) || 0);
        if (!catId) return t;
        n++;
        const nm = p.cats.find((c) => c.id === catId)?.name || "?";
        hits[nm] = (hits[nm] || 0) + 1;
        return { ...t, catId };
      });
      return { ...p, txns };
    });
    setTimeout(() => {
      if (!n) toast("Nothing matched a rule — the rest need a category from you, or the AI categorize button in Budget.", "err");
      else toast("Filed " + n + " transactions: " + Object.entries(hits).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join(", ") + "."
        + (added.length ? " Added the " + added.join(" and ") + " categor" + (added.length > 1 ? "ies" : "y") + " to hold them." : ""));
    }, 0);
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Merchants</h3>
          <div className="pills">
            {RANGES.map(([v, l]) => <button key={v} className={"pill" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{l}</button>)}
          </div>
        </div>
        <div className="note">
          Every place your money went, biggest first. Setting a category here files <b>all</b> of that merchant's
          transactions at once, and Atlas remembers it for future syncs.
        </div>
        {uncatted.length > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="note bad" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              {uncatted.length} merchant{uncatted.length === 1 ? " has" : "s have"} unfiled transactions —
              they're missing from every budget line and from the month-in-review.
            </span>
            <button className="btn small primary" onClick={fileTheObvious}>File the obvious ones</button>
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <input className="in" style={{ flex: 1, minWidth: 160 }} placeholder="Filter merchants…" value={q} onChange={(e) => setQ(e.target.value)} />
          {/* The whole point of the warning above is that these need attention;
              hunting for them down a 130-row list is the opposite of that. */}
          <button className={"btn small" + (onlyUncat ? " primary" : "")} disabled={!uncatted.length}
            title={uncatted.length ? "Show only merchants with unfiled transactions" : "Nothing unfiled"}
            onClick={() => setOnlyUncat((v) => !v)}>
            {onlyUncat ? "Showing unfiled" : "Unfiled only" + (uncatted.length ? " (" + uncatted.length + ")" : "")}
          </button>
          <select className="in" style={{ width: 170 }} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="total">Sort: most spent</option>
            <option value="count">Sort: most visits</option>
            <option value="recent">Sort: most recent</option>
          </select>
        </div>
        <div className="note">
          {shownRows.length} merchant{shownRows.length === 1 ? "" : "s"}
          {onlyUncat ? " with unfiled transactions" : ""} · <b className="mono">{fmt(onlyUncat ? shownRows.reduce((s, r) => s + r.total, 0) : grand)}</b> total
        </div>
      </div>

      <div className="card">
        {shownRows.length ? shownRows.slice(0, mShown).map((r) => {
          const ci = d.cats.findIndex((c) => c.id === r.catId);
          return (
            <div key={r.key} style={{ padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                <span className="row" style={{ gap: 8, flexWrap: "nowrap", overflow: "hidden", flex: 1 }}>
                  <Avatar label={r.label} color={r.catId ? seriesColor(ci) : "var(--faint)"} />
                  <span style={{ overflow: "hidden" }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                      {titleCase(r.label)}
                      {r.mixed && <span className="tag" style={{ marginLeft: 6 }} title="Person-to-person payments land under one name but can mean different things — categorize these individually in Budget">mixed</span>}
                    </span>
                    <span className="note" style={{ margin: 0, fontSize: 11.5 }}>
                      {r.count}× · avg {fmt2(r.avg)} · last {r.last}
                      {r.uncatted > 0 && <span className="warn"> · {r.uncatted} uncategorized</span>}
                      {r.xfers > 0 && <span className="warn" title="Detected as account-to-account moves and left out of spending. Open this merchant to change any that were really a purchase."> · {r.xfers} marked transfer</span>}
                    </span>
                  </span>
                </span>
                <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 15 }}>{fmt(r.total)}</span>
                  <select className="in" style={{ width: 132, padding: "4px 6px", fontSize: 12 }} value={r.catId}
                    title="Files every transaction from this merchant"
                    onChange={(e) => e.target.value === "__xfer" ? makeTransfers(r) : setCat(r, e.target.value)}>
                    <option value="">— set category —</option>
                    {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    <option value="__xfer">Not spending (transfer)</option>
                  </select>
                </span>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 5 }}>
                <div className="bar" style={{ flex: 1, height: 5 }}>
                  <i style={{ width: (grand > 0 ? (r.total / grand) * 100 : 0) + "%", background: r.catId ? seriesColor(ci) : "var(--faint)" }} />
                </div>
                {/* Setting a category merchant-wide is wrong for anything mixed:
                    one Venmo name can be rent, a car payment and splitting a
                    dinner. Open it and each payment stands on its own. */}
                <button className="btn small" style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => setOpenKey(openKey === r.key ? null : r.key)}>
                  {openKey === r.key ? "Hide" : r.count === 1 ? "Show it" : "Show all " + r.count}
                </button>
              </div>

              {openKey === r.key && (
                <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: "2px solid var(--line2)" }}>
                  {r.mixed && (
                    <div className="note" style={{ marginTop: 0, fontSize: 11.5 }}>
                      These share one merchant name but not one meaning — file them individually here, and
                      <b> Split</b> anything that was two things at once (rent plus a car payment in a single transfer).
                    </div>
                  )}
                  {allFor(r, d.txns).sort((a, b) => String(b.date).localeCompare(String(a.date))).map((t) => (
                    <div className="row" key={t.id} style={{ gap: 6, padding: "3px 0" }}>
                      <span className="note mono" style={{ margin: 0, width: 86, flexShrink: 0, fontSize: 11.5 }}>{t.date}</span>
                      <span className="mono" style={{ width: 76, textAlign: "right", flexShrink: 0 }}>{fmt2(t.amount)}</span>
                      <select className="in" style={{ width: 130, padding: "3px 6px", fontSize: 11.5 }} value={t.catId || ""}
                        onChange={(e) => setD((p) => ({ ...p, txns: p.txns.map((x) => x.id === t.id
                          ? { ...x, catId: e.target.value, kind: "out", kindSet: true } : x) }))}>
                        <option value="">— uncategorized —</option>
                        {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {t.kind === "xfer" && <span className="tag" title="Excluded from spending entirely">transfer</span>}
                      <button className="btn small" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setSplit(t)}>Split</button>
                      <span className="note" style={{ margin: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }) : <div className="note">No spending in this range yet — sync or log some transactions.</div>}
        {/* 130 merchants is not a list anyone reads top to bottom */}
        {shownRows.length > mShown && (
          <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn small" onClick={() => setMShown((n) => n + 10)}>
              Show 10 more — {shownRows.length - mShown} left
            </button>
            {mShown > 10 && <button className="btn small" onClick={() => setMShown(10)}>Collapse</button>}
          </div>
        )}
        {mShown > 10 && shownRows.length <= mShown && (
          <div className="mrow" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn small" onClick={() => setMShown(10)}>Collapse</button>
          </div>
        )}
      </div>

      {split && (
        <SplitSheet txn={split} cats={d.cats} onClose={() => setSplit(null)} onSave={(parts) => {
          setD((p) => ({
            ...p,
            /* the original is replaced, not kept alongside — leaving it would
               double-count the whole amount in every total */
            txns: p.txns.flatMap((t) => t.id !== split.id ? [t] : parts.map((part, i) => ({
              ...t,
              id: t.id + "-s" + (i + 1),
              /* a split part is real spending even if the parent was a transfer */
              kind: "out", kindSet: true,
              amount: Math.round(Number(part.amount) * 100) / 100,
              catId: part.catId,
              note: t.note + " (split " + (i + 1) + "/" + parts.length + ")",
              /* The sync key stays on exactly one part. Dropping it entirely
                 would make the next sync think this transaction was never
                 imported and add the original back on top of the split parts —
                 double-counting the whole amount. Keeping it on all of them is
                 also wrong the moment anything looks the key up expecting one row. */
              tellerId: i === 0 ? t.tellerId : undefined,
              splitOf: t.tellerId || t.id,
            }))),
          }));
          setSplit(null);
          toast("Split into " + parts.length + " — each part is its own transaction now.");
        }} />
      )}
    </>
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
  const alloc = rows.filter((r) => r.value > 0).map((r) => ({ name: r.symbol, value: Math.round(r.value), color: seriesColor(holdings.findIndex((h) => h.symbol === r.symbol)) }));
  const allocSegs = alloc.length > 7 ? [...alloc.slice(0, 6), { name: "Other", value: alloc.slice(6).reduce((s, x) => s + x.value, 0), color: "var(--faint)" }] : alloc;

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

  /* scrolling ticker tape: indexes + your holdings + your watchlist (deduped) */
  const tapeLabels = { SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow" };
  const tapeSyms = [...new Set([...MARKET.map(([s]) => s), ...holdings.map((h) => h.symbol), ...watch])];
  const tapeItems = tapeSyms.map((s) => (
    <span className="tapeitem" key={s}>
      <b className="mono">{s}</b>
      {tapeLabels[s] && <span style={{ color: "var(--faint)", fontSize: 11.5 }}> {tapeLabels[s]}</span>}
      <span className="mono" style={{ color: "var(--muted)" }}> {fmt2(px(s))}</span>
      <span style={{ fontSize: 12 }}> <Delta v={dayPct(s)} /></span>
    </span>
  ));
  const synced = (d.simplefin || []).length > 0;

  return (
    <>
      <div className="tape card" style={{ padding: "12px 0" }} aria-label="Market ticker">
        <div className="tapein" style={{ animationDuration: Math.max(24, tapeSyms.length * 5) + "s" }}>
          <span className="tapecopy">{tapeItems}</span>
          <span className="tapecopy" aria-hidden="true">{tapeItems.map((el) => React.cloneElement(el, { key: el.key + "-b" }))}</span>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Portfolio {synced && <span className="tag" title="Positions come from your brokerage via SimpleFIN">auto-synced</span>}</h3>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={busy} onClick={refresh}>{busy ? "Refreshing…" : "↻ Refresh quotes"}</button>
            {!synced && <button className="btn small" onClick={() => document.getElementById("inv-csv").click()}>Import positions CSV</button>}
            <input id="inv-csv" type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; }} />
          </span>
        </div>
        <div className="note" style={{ marginTop: 2 }}>
          {synced
            ? "Positions sync from your brokerage connection — manual entry is off so the two can't fight (each sync would overwrite hand edits). Disconnect the bank under Accounts to manage holdings by hand."
            : <>Connect a brokerage under <b>Accounts → Bank sync</b> and positions fill in automatically (SimpleFIN covers Fidelity). Otherwise import a positions CSV or add tickers by hand. Prices are delayed quotes, refreshed on demand.</>}
        </div>
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
            <span className="mono">{fmt(r.value)}{r.value != null && totValue > 0 && <span style={{ color: "var(--faint)", fontSize: 11 }}> {Math.round((r.value / totValue) * 100)}%</span>}</span>
            <span className="igain mono" style={{ fontSize: 12.5, color: r.gain == null ? "var(--faint)" : r.gain >= 0 ? "var(--up)" : "var(--red)" }}>{r.gain == null ? "—" : (r.gain >= 0 ? "+" : "") + fmt(r.gain)}</span>
            {synced && r.src === "simplefin"
              ? <span />
              : <button className="x" onClick={() => setD((p) => ({ ...p, invest: { ...p.invest, holdings: p.invest.holdings.filter((h) => h.id !== r.id) } }))}>✕</button>}
          </div>
        ))}
        {!rows.length && <div className="note">No holdings yet — {synced ? "hit Sync now under Accounts and your brokerage positions land here." : "add a ticker below or import a positions CSV."}</div>}
        {!synced && (
          <div className="row" style={{ marginTop: 10 }}>
            <input className="in mono" style={{ width: 150 }} placeholder="Symbol (e.g. AAPL)" title="The stock's ticker symbol — AAPL for Apple, VOO for Vanguard S&P 500" value={nh.symbol}
              onChange={(e) => setNh({ ...nh, symbol: e.target.value.toUpperCase() })} onKeyDown={(e) => e.key === "Enter" && addHolding()} />
            <input className="in mono" type="number" style={{ width: 110 }} placeholder="Shares" value={nh.shares} onChange={(e) => setNh({ ...nh, shares: e.target.value })} />
            <input className="in mono" type="number" style={{ width: 150 }} placeholder="Cost basis $ (opt.)" title="Total amount paid for the whole position" value={nh.cost} onChange={(e) => setNh({ ...nh, cost: e.target.value })} />
            <button className="btn small primary" onClick={addHolding}>Add / update</button>
          </div>
        )}
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

      {allocSegs.length >= 2 && (
        <FoldWrap title="Allocation" sub="what your money is actually in">
        <div className="card">
          <h3>Allocation</h3>
          <StackBar segs={allocSegs} />
        </div>
        </FoldWrap>
      )}

      <FoldWrap title="Watchlist" sub="tickers you're following">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Watchlist</h3>
          <span className="row">
            <input className="in mono" style={{ width: 140, padding: "4px 9px" }} placeholder="Symbol (e.g. TSLA)" value={nw}
              onChange={(e) => setNw(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter" && /^[A-Z0-9.^-]{1,10}$/.test(nw.trim()) && !watch.includes(nw.trim())) { setD((p) => ({ ...p, invest: { ...p.invest, watch: [...p.invest.watch, nw.trim()] } })); setNw(""); } }} />
            <span className="note" style={{ margin: 0 }}>enter ↵</span>
          </span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {watch.map((s) => (
            <span className="wchip" key={s}>
              <b className="mono">{s}</b>
              <span className="mono" style={{ color: "var(--muted)" }}>{fmt2(px(s))}</span>
              <Delta v={dayPct(s)} />
              <button className="x" style={{ fontSize: 12, padding: 0 }} onClick={() => setD((p) => ({ ...p, invest: { ...p.invest, watch: p.invest.watch.filter((x) => x !== s) } }))}>✕</button>
            </span>
          ))}
          {!watch.length && <span className="note" style={{ margin: 0 }}>Add tickers you're keeping an eye on — quotes load with the rest.</span>}
        </div>
      </div>
      </FoldWrap>

      {config?.aiEnabled && (
        <FoldWrap title="Market brief" sub="what moved today, and your tickers">
        <div className="card">
          <h3>Market brief</h3>
          <div className="note">A web-searched snapshot of what's moving markets today, plus one-liners on your tickers. Informational only — not advice, and worth double-checking like anything else on the internet.</div>
          <div className="mrow" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" disabled={briefBusy} onClick={marketBrief}>{briefBusy ? "Researching…" : brief ? "Refresh brief" : "Get today's brief"}</button>
          </div>
          {brief && <div className="aiout">{brief}</div>}
        </div>
        </FoldWrap>
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

/* Wide content (charts with many bars) scrolls inside its own box rather than
   pushing the page sideways. The hint only appears when it actually overflows,
   and disappears once you've scrolled — no permanent clutter on desktop. */
function HScroll({ minWidth, children }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [touched, setTouched] = useState(false);
  /* deps matter: re-subscribing on every render churns the observer, and the
     resize storm makes charts inside re-measure mid-animation */
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOver(el.scrollWidth > el.clientWidth + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  return (
    <>
      <div className="hscroll" ref={ref} onScroll={() => setTouched(true)}>
        {/* width:100% keeps the child from measuring narrow before layout settles */}
        <div style={{ minWidth, width: "100%" }}>{children}</div>
      </div>
      {over && !touched && <div className="note swipehint">swipe for more →</div>}
    </>
  );
}

/* ---------------- month in review ----------------
   Everything here is computed from the ledger — no AI required. The optional
   recap button hands the same numbers to Claude for a plain-language read. */
function monthStats(d, m) {
  const tx = d.txns.filter((t) => (t.date || "").startsWith(m));
  const income = tx.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const byCat = {};
  tx.filter((t) => t.kind === "out").forEach((t) => {
    const n = d.cats.find((c) => c.id === t.catId)?.name || "Uncategorized";
    byCat[n] = (byCat[n] || 0) + (Number(t.amount) || 0);
  });
  const spending = Object.values(byCat).reduce((s, v) => s + v, 0);
  return { m, income, spending, kept: income - spending, byCat, tx };
}
const prevMonth = (m) => { const [y, mm] = m.split("-").map(Number); const dt = new Date(y, mm - 2, 1); return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0"); };

/* one place builds the recap so the button and the automatic monthly run agree */
async function generateRecap(d, m) {
  const cur = monthStats(d, m), prev = monthStats(d, prevMonth(m));
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  const payload = {
    month: m, income: Math.round(cur.income), spending: Math.round(cur.spending), kept: Math.round(cur.kept),
    savingsRatePct: cur.income > 0 ? Math.round((cur.kept / cur.income) * 100) : null,
    byCategory: round(cur.byCat),
    lastMonth: { income: Math.round(prev.income), spending: Math.round(prev.spending), byCategory: round(prev.byCat) },
    budgets: d.cats.filter((c) => Number(c.limit) > 0).map((c) => ({ name: c.name, limit: Number(c.limit), spent: Math.round(cur.byCat[c.name] || 0) })),
    biggestExpenses: cur.tx.filter((t) => t.kind === "out").sort((a, b) => b.amount - a.amount).slice(0, 5).map((t) => ({ note: t.note, amount: t.amount })),
  };
  return (await callClaude(
    "Here is one month of someone's finances as JSON:\n" + JSON.stringify(payload) +
    "\n\nWrite a short month-in-review for them (plain text, no markdown, under 140 words): what actually happened, " +
    "the one or two changes that mattered most vs last month, and one concrete thing to watch next month. " +
    "Talk to them directly, cite the real numbers, skip generic advice. General financial education only."
  )).trim();
}

function MonthReview({ d, setD, config }) {
  const [m, setM] = useState(thisMonth());
  const [busy, setBusy] = useState(false);
  const cur = useMemo(() => monthStats(d, m), [d.txns, d.cats, m]);
  const prev = useMemo(() => monthStats(d, prevMonth(m)), [d.txns, d.cats, m]);
  const recap = (d.settings.recaps || {})[m]; // written once, kept with your data

  const shift = (n) => { const [y, mm] = m.split("-").map(Number); const dt = new Date(y, mm - 1 + n, 1); setM(dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0")); };

  /* biggest category swings vs last month, in dollars */
  const movers = useMemo(() => {
    const names = [...new Set([...Object.keys(cur.byCat), ...Object.keys(prev.byCat)])];
    return names.map((n) => ({ name: n, now: cur.byCat[n] || 0, was: prev.byCat[n] || 0, delta: (cur.byCat[n] || 0) - (prev.byCat[n] || 0) }))
      .filter((x) => Math.abs(x.delta) >= 5).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4);
  }, [cur, prev]);
  const biggest = useMemo(() => cur.tx.filter((t) => t.kind === "out").sort((a, b) => b.amount - a.amount).slice(0, 4), [cur]);
  const budgeted = d.cats.filter((c) => Number(c.limit) > 0)
    .map((c) => ({ name: c.name, spent: cur.byCat[c.name] || 0, limit: Number(c.limit) }))
    .sort((a, b) => b.spent / b.limit - a.spent / a.limit);
  const over = budgeted.filter((b) => b.spent > b.limit);
  const rate = cur.income > 0 ? (cur.kept / cur.income) * 100 : null;

  const writeRecap = async () => {
    setBusy(true);
    try {
      const text = await generateRecap(d, m);
      setD((p) => ({ ...p, settings: { ...p.settings, recaps: { ...(p.settings.recaps || {}), [m]: text } } }));
    } catch (e) { toast("Recap failed — " + e.message, "err"); }
    setBusy(false);
  };

  const Stat = ({ label, now, was, goodDown }) => {
    const delta = now - was;
    const good = goodDown ? delta < 0 : delta > 0;
    return (
      <div>
        <div className="sub">{label}</div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{fmt(now)}</div>
        {was > 0 && Math.abs(delta) >= 1 && (
          <span className={"chip " + (good ? "up" : "dn")} style={{ marginTop: 4 }}>
            {delta > 0 ? "▲" : "▼"} {fmt(Math.abs(delta))} vs {MONTH_NAMES[Number(prevMonth(m).slice(5)) - 1].slice(0, 3)}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>{monthLabel(m)} in review</h3>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => shift(-1)}>←</button>
          <button className="btn small" disabled={m >= thisMonth()} onClick={() => shift(1)}>→</button>
        </span>
      </div>
      {!cur.tx.length ? (
        <div className="note">Nothing logged in {monthLabel(m)} yet.</div>
      ) : (
        <>
          <div className="grid3" style={{ marginTop: 10 }}>
            <Stat label="Income" now={cur.income} was={prev.income} />
            <Stat label="Spending" now={cur.spending} was={prev.spending} goodDown />
            <div>
              <div className="sub">Kept</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
                <span className={cur.kept >= 0 ? "good" : "bad"}>{fmt(cur.kept)}</span>
                {rate != null && <span style={{ fontSize: 13, color: "var(--faint)" }}> ({pct(rate)})</span>}
              </div>
            </div>
          </div>

          <div className="grid2" style={{ marginTop: 14 }}>
            <div>
              <div className="sub" style={{ marginBottom: 4 }}>Biggest changes vs {monthLabel(prevMonth(m))}</div>
              {movers.length ? movers.map((x) => (
                <div className="kv" key={x.name}>
                  <span className="k row" style={{ gap: 7 }}>
                    <Icon k={catIconKey(x.name)} size={13} color={seriesColor(d.cats.findIndex((c) => c.name === x.name))} />{x.name}
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--faint)" }}>{fmt(x.was)} → {fmt(x.now)}</span>
                    <span className={"chip " + (x.delta > 0 ? "dn" : "up")}>{x.delta > 0 ? "▲" : "▼"} {fmt(Math.abs(x.delta))}</span>
                  </span>
                </div>
              )) : <div className="note" style={{ marginTop: 0 }}>No category moved by more than $5.</div>}
            </div>
            <div>
              <div className="sub" style={{ marginBottom: 4 }}>Largest expenses</div>
              {biggest.map((t) => (
                <div className="kv" key={t.id}>
                  <span className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleCase(t.note) || d.cats.find((c) => c.id === t.catId)?.name || "—"}</span>
                  <span className="mono" style={{ flexShrink: 0 }}>{fmt2(Number(t.amount))}</span>
                </div>
              ))}
            </div>
          </div>

          {budgeted.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="sub" style={{ marginBottom: 4 }}>Budget check</div>
              {budgeted.map((b) => (
                <div key={b.name} style={{ padding: "5px 0" }}>
                  <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                    <span className="row" style={{ gap: 7 }}>
                      <Icon k={catIconKey(b.name)} size={13} color={seriesColor(d.cats.findIndex((c) => c.name === b.name))} />{b.name}
                    </span>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      <span className={b.spent > b.limit ? "bad" : b.spent >= b.limit * 0.8 ? "warn" : ""}>{fmt(b.spent)}</span>
                      <span style={{ color: "var(--faint)" }}> / {fmt(b.limit)}</span>
                    </span>
                  </div>
                  <div className="bar" style={{ height: 6, marginTop: 3 }}>
                    <i className={b.spent > b.limit ? "over" : b.spent >= b.limit * 0.8 ? "near" : ""}
                      style={{ width: Math.min(100, (b.spent / b.limit) * 100) + "%" }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {config?.aiEnabled && (
            <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 10 }}>
              <button className="btn small" disabled={busy} onClick={writeRecap}>{busy ? "Writing…" : recap ? "Rewrite recap" : "Write my recap"}</button>
              {!recap && m !== thisMonth() && <span className="note" style={{ margin: 0 }}>closed months get written automatically</span>}
            </div>
          )}
          {recap && <div className="aiout">{recap}</div>}
        </>
      )}
    </div>
  );
}

function Dashboard({ d, setD, config, setTab }) {
  const [range, setRange] = useState("3m");
  const [drill, setDrill] = useState(null); // "in" | "out" — tile drill-down
  const start = rangeStart(range);
  const tx = d.txns.filter((t) => (t.date || "") >= start);
  const spend = tx.filter((t) => t.kind === "out").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const inSum = tx.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const monthsN = range === "m" ? 1 : range === "3m" ? 3 : range === "6m" ? 6 : range === "ytd" ? new Date().getMonth() + 1 : Math.max(1, new Set(d.txns.map((t) => (t.date || "").slice(0, 7))).size);
  const income = inSum > 0 ? inSum : (Number(d.settings.incomeMonthly) || 0) * monthsN;
  const net = income - spend;
  const rate = income > 0 ? Math.round((net / income) * 100) : null;

  const { assets, debts, nw } = netWorth(d.accounts);

  /* Recorded snapshots only exist from the day Atlas started running, but synced
     transactions go back months — reconstruct earlier net worth by walking the
     transaction flows backward from the first real snapshot. Transfers are net
     zero across your own accounts, so only in/out move the line. */
  const histFull = useMemo(() => {
    /* A snapshot with no assets AND no debts is Atlas recording a day before it
       knew about any account — it is not a day you were worth $0. Anchoring the
       reconstruction to one drags the entire estimated history down by your whole
       net worth, which is what put the line below zero through June. It also made
       the YTD chip claim the year's gain was the entire balance. */
    const recorded = (d.history || []).filter((h) => Number(h.assets) !== 0 || Number(h.debts) !== 0);
    const firstSnap = recorded[0]?.date;
    const pre = {};
    d.txns.forEach((t) => {
      if (!t.date || (firstSnap && t.date >= firstSnap)) return;
      const v = t.kind === "in" ? Number(t.amount) || 0 : t.kind === "out" ? -(Number(t.amount) || 0) : 0;
      if (v) pre[t.date] = (pre[t.date] || 0) + v;
    });
    const days = Object.keys(pre).sort();
    if (!days.length) return recorded;
    const anchor = recorded.length ? recorded[0].nw : nw;
    let run = anchor - days.reduce((s, k) => s + pre[k], 0);
    const est = days.map((k) => { run += pre[k]; return { date: k, nw: Math.round(run), est: true }; });
    return [...est, ...recorded];
  }, [d.history, d.txns, nw]);
  const hist = histFull.filter((h) => h.date >= start).map((h) => ({ date: h.date.slice(5), nw: h.nw }));
  const histHasEst = histFull.some((h) => h.est && h.date >= start);

  /* hero chips: change vs last month-end and vs Jan 1. Same filter as the chart —
     these read from real snapshots only, or "up $7,422 YTD" is just today's
     balance measured against a day Atlas hadn't been told about any accounts. */
  const realHist = useMemo(() => (d.history || []).filter((h) => Number(h.assets) !== 0 || Number(h.debts) !== 0), [d.history]);
  const baseMonth = [...realHist].reverse().find((h) => h.date < thisMonth() + "-01")?.nw;
  const monthDelta = baseMonth != null ? nw - baseMonth : null;
  const monthPct = baseMonth ? (monthDelta / Math.abs(baseMonth)) * 100 : null;
  const jan1 = new Date().getFullYear() + "-01-01";
  const baseYear = [...realHist].reverse().find((h) => h.date < jan1)?.nw
    ?? (realHist.length > 1 && realHist[0].date >= jan1 ? realHist[0].nw : null);
  const ytdDelta = baseYear != null ? nw - baseYear : null;
  const avgSpend = avgMonthlySpend(d.txns);
  const runway = avgSpend > 0 ? liquid(d.accounts) / avgSpend : null;
  const endDot = (p) => (p.index === hist.length - 1
    ? <circle key="end" cx={p.cx} cy={p.cy} r={4} fill="var(--up)" />
    : <g key={p.index} />);

  const recent = [...d.txns].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);

  /* income vs spending by month */
  const months = [];
  for (let i = Math.min(monthsN, 12) - 1; i >= 0; i--) {
    const dt = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
    const key = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0"); // local, not UTC — toISOString shifts the month east of Greenwich
    const mt = d.txns.filter((t) => (t.date || "").startsWith(key));
    const mIn = mt.filter((t) => t.kind === "in").reduce((s, t) => s + (Number(t.amount) || 0), 0);
    /* a month with nothing logged is a gap in the data, not a month you earned the
       Settings figure — only fall back for months that actually have activity */
    months.push({
      m: MONTH_NAMES[dt.getMonth()].slice(0, 3),
      Income: Math.round(mIn > 0 ? mIn : mt.length ? Number(d.settings.incomeMonthly) || 0 : 0),
      Spending: Math.round(mt.filter((t) => t.kind === "out").reduce((s, t) => s + (Number(t.amount) || 0), 0)),
    });
  }

  /* category breakdown — color follows the CATEGORY (stable index in d.cats), never its rank */
  const byCat = {};
  tx.filter((t) => t.kind === "out").forEach((t) => { byCat[t.catId] = (byCat[t.catId] || 0) + (Number(t.amount) || 0); });
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

  return (
    <>
      <TransferCleanup d={d} setD={setD} />
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="note" style={{ margin: 0, textTransform: "uppercase", letterSpacing: ".07em", fontSize: 11 }}>Net worth</div>
            <div className="row" style={{ gap: 10 }}>
              <span className="big mono">{fmt(nw)}</span>
              {monthDelta != null && Math.abs(monthDelta) >= 1 && (
                <span className={"chip " + (monthDelta >= 0 ? "up" : "dn")}>
                  {monthDelta >= 0 ? "▲" : "▼"} {fmt(Math.abs(monthDelta))}{monthPct != null ? " · " + Math.abs(monthPct).toFixed(1) + "%" : ""} this month
                </span>
              )}
              {ytdDelta != null && Math.abs(ytdDelta) >= 1 && (
                <span className="chip ghost">{ytdDelta >= 0 ? "▲" : "▼"} {fmt(Math.abs(ytdDelta))} YTD</span>
              )}
            </div>
            <div className="note" style={{ marginTop: 2 }}>assets <b className="mono">{fmt(assets)}</b> · debts <b className="mono" style={{ color: "var(--red)" }}>{fmt(debts)}</b></div>
          </div>
          <div className="pills">
            {RANGES.map(([v, l]) => (
              <button key={v} className={"pill" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{l}</button>
            ))}
          </div>
        </div>
        {hist.length >= 2 ? (
          <div style={{ width: "100%", height: 210, marginTop: 6 }} className="glow">
            <ResponsiveContainer>
              <AreaChart data={hist} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="nw-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--up)" stopOpacity={0.26} />
                    <stop offset="100%" stopColor="var(--up)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "var(--faint)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
                <YAxis tick={{ fill: "var(--faint)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtK} width={52} domain={["auto", "auto"]} />
                <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, color: "var(--text)", fontSize: 13 }} />
                <Area type="monotone" dataKey="nw" stroke="var(--up)" strokeWidth={2} fill="url(#nw-grad)" dot={endDot} activeDot={{ r: 4, fill: "var(--up)" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : <div className="note">Net worth logs one point per day — the trend appears as days accumulate.</div>}
        {histHasEst && <div className="note">Points before {d.history[0]?.date || "today"} are estimated from your synced transactions; from then on they're recorded daily.</div>}
      </div>

      <div className="grid4" style={{ marginTop: 16 }}>
        <div className="card" style={{ cursor: "pointer" }} role="button" tabIndex={0} title="Click for the full income history in this range"
          onClick={() => setDrill("in")} onKeyDown={(e) => e.key === "Enter" && setDrill("in")}>
          <div className="note" style={{ margin: 0 }}>Income</div>
          <div className="big mono" style={{ fontSize: 22 }}>{fmt(income)}</div>
          <div style={{ margin: "4px 0 6px" }}><Spark data={months.map((m) => m.Income)} color="var(--s3)" /></div>
          {months.length >= 2
            ? <Delta2 v={months[months.length - 1].Income - months[months.length - 2].Income} label={"vs " + months[months.length - 2].m} />
            : <span className="chip ghost">{inSum > 0 ? "logged" : "from Settings"}</span>}
        </div>
        <div className="card" style={{ cursor: "pointer" }} role="button" tabIndex={0} title="Click for the full spending history in this range"
          onClick={() => setDrill("out")} onKeyDown={(e) => e.key === "Enter" && setDrill("out")}>
          <div className="note" style={{ margin: 0 }}>Spending</div>
          <div className="big mono" style={{ fontSize: 22 }}>{fmt(spend)}</div>
          <div style={{ margin: "4px 0 6px" }}><Spark data={months.map((m) => m.Spending)} color="var(--s8)" /></div>
          {months.length >= 2
            ? <Delta2 v={months[months.length - 1].Spending - months[months.length - 2].Spending} label={"vs " + months[months.length - 2].m} goodDown />
            : <span className="chip ghost">{RANGES.find((x) => x[0] === range)[1].toLowerCase()}</span>}
        </div>
        <div className="card">
          <div className="note" style={{ margin: 0 }}>Net cash flow</div>
          <div className="big mono" style={{ fontSize: 22, color: net >= 0 ? "var(--up)" : "var(--red)" }}>{(net >= 0 ? "+" : "") + fmt(net)}</div>
          <div style={{ margin: "4px 0 6px" }}><Spark data={months.map((m) => m.Income - m.Spending)} /></div>
          <span className={"chip " + (rate == null ? "ghost" : rate >= 20 ? "up" : rate >= 0 ? "ghost" : "dn")}>{rate == null ? "set income" : rate + "% kept"}</span>
        </div>
        <div className="card">
          <div className="note" style={{ margin: 0 }}>Runway</div>
          <div className="big mono" style={{ fontSize: 22 }}>{runway == null ? "—" : runway >= 99 ? "99+" : runway.toFixed(1) + " mo"}</div>
          <div className="note" style={{ marginTop: 6 }}>how long checking + savings last if income stopped</div>
        </div>
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
          <HScroll minWidth={Math.max(240, months.length * 54)}>
            <div style={{ width: "100%", height: 210 }}>
              <ResponsiveContainer>
                <BarChart data={months} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="m" tick={{ fill: "var(--faint)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "var(--faint)", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtK} width={46} />
                  <Tooltip cursor={{ fill: "var(--acc-soft)" }} formatter={(v) => fmt(v)}
                    contentStyle={{ background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, fontSize: 12 }} />
                  <Bar dataKey="Income" fill="var(--s3)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Spending" fill="var(--s8)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </HScroll>
        </div>
        <div className="card">
          <h3>Spending by category</h3>
          {donutData.length
            ? <div style={{ marginTop: 10 }}><Donut data={donutData} centerTop={fmt(spend)} centerBottom="spent" /></div>
            : <div className="note">No spending logged in this range yet.</div>}
        </div>
      </div>

      <MonthReview d={d} setD={setD} config={config} />

      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Recent activity</h3>
          {recent.length ? recent.map((t) => {
            const ci = d.cats.findIndex((c) => c.id === t.catId);
            const cn = d.cats[ci]?.name;
            const color = t.kind === "in" ? "var(--s3)" : t.kind === "xfer" ? "var(--faint)" : seriesColor(ci);
            return (
              <div className="kv" key={t.id}>
                <span className="row" style={{ gap: 10, flexWrap: "nowrap", overflow: "hidden" }}>
                  <Avatar label={t.note || cn || "?"} color={color} />
                  <span style={{ overflow: "hidden" }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleCase(t.note) || cn || "—"}</span>
                    {t.kind === "in"
                      ? <span className="cat"><Icon k="dollar" size={12} color="var(--up)" /> Income</span>
                      : t.kind === "xfer"
                      ? <span className="cat" title="Between your own accounts — not counted as income or spending">⇄ Transfer</span>
                      : cn ? <CatChip name={cn} color={seriesColor(ci)} /> : <span className="cat">Uncategorized</span>}
                  </span>
                </span>
                <span style={{ textAlign: "right", flexShrink: 0 }}>
                  <span className="mono" style={t.kind === "in" ? { color: "var(--up)" } : t.kind === "xfer" ? { color: "var(--faint)" } : {}}>{t.kind === "in" ? "+" : t.kind === "xfer" ? "" : "−"}{fmt2(Number(t.amount))}</span>
                  <span className="note" style={{ display: "block", margin: 0, fontSize: 11 }}>{t.date}</span>
                </span>
              </div>
            );
          }) : <div className="note">No transactions yet — connect a bank or log one in Budget.</div>}
        </div>
        <div className="card">
          <h3>Upcoming bills — next 30 days</h3>
          {upcoming.length ? upcoming.map(({ r, when }) => (
            <div className="kv" key={r.id}>
              <span className="k">{(r.name && r.name !== (d.cats.find((c) => c.id === r.catId)?.name) ? r.name : d.cats.find((c) => c.id === r.catId)?.name || "?")}
                <span style={{ color: "var(--faint)", fontSize: 11.5 }}> · {MONTH_NAMES[when.getMonth()].slice(0, 3)} {when.getDate()}</span></span>
              <span className="mono">{fmtAmt(r.amount)}</span>
            </div>
          )) : <div className="note">Nothing due — add recurring bills in Budget and they show here.</div>}
        </div>
      </div>

      {drill && (() => {
        const rows = tx.filter((t) => t.kind === drill).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const total = rows.reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const label = RANGES.find((x) => x[0] === range)[1];
        return (
          <Modal title={(drill === "in" ? "Income" : "Spending") + " — " + label.toLowerCase()} onClose={() => setDrill(null)}>
            <div className="note" style={{ marginTop: 0 }}>
              {rows.length} transaction{rows.length === 1 ? "" : "s"} · <b className="mono">{fmt2(total)}</b> total
              {drill === "in" && inSum === 0 ? " — none logged; the tile shows your income from Settings." : ""}
            </div>
            <div style={{ maxHeight: 420, overflowY: "auto", marginTop: 8 }}>
              {rows.map((t) => {
                const cn = d.cats.find((c) => c.id === t.catId)?.name;
                return (
                  <div className="kv" key={t.id}>
                    <span className="row" style={{ gap: 8, flexWrap: "nowrap", overflow: "hidden" }}>
                      <span className="mono" style={{ fontSize: 12, color: "var(--faint)", flexShrink: 0 }}>{t.date}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleCase(t.note) || cn || "—"}</span>
                      {cn && drill === "out" && <span className="tag" style={{ flexShrink: 0 }}>{cn}</span>}
                      {t.accountId && <span className="tag" style={{ flexShrink: 0 }}>{(d.accounts.find((a) => a.id === t.accountId)?.name || "").slice(0, 16)}</span>}
                    </span>
                    <span className="mono" style={{ flexShrink: 0, color: drill === "in" ? "var(--up)" : "var(--text)" }}>{drill === "in" ? "+" : ""}{fmt2(Number(t.amount))}</span>
                  </div>
                );
              })}
              {!rows.length && <div className="note">Nothing logged in this range.</div>}
            </div>
          </Modal>
        );
      })()}
    </>
  );
}

/* ---------------- Ask Atlas (dashboard assistant) ---------------- */

/* Compact JSON snapshot of everything the app knows — monthly rollups keep the
   prompt small even with years of history; recent transactions carry the detail. */
function buildAskPrompt(d, hist, question) {
  const catName = (id) => d.cats.find((c) => c.id === id)?.name || "";
  const acctName = (id) => d.accounts.find((a) => a.id === id)?.name || "";
  const months = {};
  d.txns.forEach((t) => {
    const m = (t.date || "").slice(0, 7);
    if (!m) return;
    const e = (months[m] = months[m] || { income: 0, spending: 0, byCat: {} });
    if (t.kind === "in") e.income += Number(t.amount) || 0;
    else if (t.kind === "out") {
      e.spending += Number(t.amount) || 0;
      const n = catName(t.catId) || "Uncategorized";
      e.byCat[n] = Math.round((e.byCat[n] || 0) + (Number(t.amount) || 0));
    }
  });
  const rollup = Object.fromEntries(Object.entries(months).sort((a, b) => a[0].localeCompare(b[0])).slice(-12)
    .map(([m, v]) => [m, { income: Math.round(v.income), spending: Math.round(v.spending), byCat: v.byCat }]));
  /* Career questions need the resume, which is long — so trade transaction
     detail for it rather than blowing the server's prompt cap. */
  const careerMode = /\bjob|resume|career|interview|offer|salary|comp\b|apply|applying|hiring|recruit|intern/i.test(question);
  const start = dstr(new Date(Date.now() - 180 * 864e5));
  const recent = d.txns.filter((t) => (t.date || "") >= start)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, careerMode ? 60 : 220)
    .map((t) => [t.date, t.kind, Number(t.amount), catName(t.catId), (t.note || "").slice(0, 26), acctName(t.accountId).slice(0, 16)]);
  const data = {
    today: today(),
    netWorth: netWorth(d.accounts),
    accounts: d.accounts.map((a) => ({ name: a.name, type: a.type, balance: Math.round((Number(a.balance) || 0) * 100) / 100 })),
    budgets: d.cats.map((c) => ({ name: c.name, monthlyLimit: Number(c.limit) || 0 })),
    goals: d.goals.map((g) => ({ name: g.name, target: g.target, saved: g.accountId ? Number(d.accounts.find((a) => a.id === g.accountId)?.balance || 0) : g.current, monthlyContribution: g.monthly, deadline: g.deadline || null })),
    recurringBills: d.recurring.map((r) => ({ name: r.name || catName(r.catId), amount: r.amount, freq: (r.freq || "m") === "m" ? "monthly" : "yearly" })),
    holdings: d.invest.holdings.map((h) => ({ symbol: h.symbol, shares: h.shares })),
    jobSearch: (() => {
      const apps = d.career?.apps || [];
      if (!apps.length && !(d.career?.settings?.resume || "").trim()) return null;
      const by = (s) => apps.filter((a) => a.status === s).length;
      return {
        tracked: apps.length, applied: by("Applied"), interviewing: by("Interviewing"), offers: by("Offer"),
        hasResume: !!(d.career?.settings?.resume || "").trim(),
        topTargets: apps.filter((a) => a.status !== "Rejected" && a.status !== "Withdrawn")
          .sort((a, b) => (Number(b.comp) || 0) - (Number(a.comp) || 0)).slice(0, 12)
          .map((a) => ({ company: a.company, status: a.status, comp: a.comp, city: a.locationType === "Remote" ? "Remote" : a.city, window: a.window })),
      };
    })(),
    settings: { statedMonthlyTakeHome: d.settings.incomeMonthly, emergencyFundMonths: d.settings.efMonths, assumedReturnPct: d.settings.expReturn },
    monthlyTotals: rollup,
    recentTransactions: { columns: ["date", "kind(in|out|xfer)", "amount", "category", "note", "account"], rows: recent },
  };
  if (careerMode) {
    const resume = (d.career?.settings?.resume || "").trim();
    if (resume) data.resume = resume.slice(0, 4000);
    if (d.career?.apps?.length) {
      data.jobApplications = d.career.apps
        .filter((a) => a.status !== "Rejected" && a.status !== "Withdrawn")
        .slice(0, 40)
        .map((a) => ({ company: a.company, role: a.role, status: a.status, comp: a.comp,
          city: a.locationType === "Remote" ? "Remote" : a.city, clearance: a.clearance, window: a.window, next: a.nextDate || null }));
    }
  }
  /* proposals have no prose answer — without serializing them the model has no
     memory of the estimate it just gave, so "make it two days shorter" restarts
     from nothing */
  const convo = hist.map((h) => "Q: " + h.q + "\nA: " + (h.plan ? JSON.stringify(h.plan) : h.buy ? JSON.stringify({ purchase: h.buy }) : h.a)).join("\n");
  return "You are Atlas, the built-in assistant of a self-hosted personal finance app. Below is this user's financial data as JSON — " +
    "and, when the question is about work, their resume and job search too, so you can answer career questions with their real money in view. " +
    "Amounts are USD. kind \"xfer\" is a transfer between the user's own accounts — already excluded from all income/spending totals.\n\n" +
    JSON.stringify(data) +
    (convo ? "\n\nEarlier in this conversation:\n" + convo : "") +
    "\n\nQuestion: " + question +
    "\n\nIf — and only if — the user is asking you to create, revise, or adjust a budget or spending plan, respond with ONLY this JSON " +
    "(no fences, no prose): {\"limits\":[{\"cat\":\"<category name>\",\"limit\":<integer monthly $>}],\"note\":\"<under 60 words on the key choices>\"}. " +
    "Ground every limit in their actual monthly spending from monthlyTotals, prefer their existing category names (you may add up to 2 new ones), " +
    "and keep the total comfortably under realistic monthly income. " +
    "GOALS COME FIRST: for any goal with a deadline — or any savings target the user names in their question — back-solve the monthly " +
    "contribution needed ((target − saved) ÷ months remaining), reserve that money before allocating anything else, and say in note exactly " +
    "which categories had to give and by how much to fund it. If the goal is not reachable without cutting essentials, say so plainly in note " +
    "and show the closest plan that is. " +
    "When revising an earlier plan from this conversation, return the FULL updated plan, not a diff." +
    "\n\nIf — and only if — the user is describing a purchase, trip, or one-off expense they are considering, respond with ONLY this JSON " +
    "(no fences, no prose): {\"purchase\":{\"name\":\"<short label>\",\"cost\":<integer total $>,\"by\":\"YYYY-MM-DD\"|null,\"note\":\"<how you got the number, every assumption stated>\"}}. " +
    "Do the arithmetic yourself and show it in note: for a drive, estimate the road distance between the named places, divide by the stated MPG, " +
    "multiply by a realistic current US gas price, and assume a round trip unless they say one-way; include tolls, lodging, or food only if they mention them. " +
    "If they name a timeframe, convert it to a date; otherwise use null." +
    "\n\nOtherwise answer in plain text (no markdown), under 180 words, citing specific numbers from the data. Be direct and concrete. " +
    "General financial education only — never recommend specific securities or products.";
}

function AskAtlas({ d, setD, config }) {
  const [q, setQ] = useState("");
  const [hist, setHist] = useState([]); // [{q, a, plan?, applied?}] — last few exchanges ride along in the prompt
  const [busy, setBusy] = useState(false);
  const [web, setWeb] = useState(false); // let it search — costs a beat, worth it for jobs/prices
  if (!config?.aiEnabled) return null;
  const ask = async (preset) => {
    const question = (preset || q).trim();
    if (!question || busy) return;
    setBusy(true); setQ("");
    try {
      const a = (await callClaude(buildAskPrompt(d, hist, question), web)).trim();
      let plan = null, buy = null;
      try {
        const j = extractJSON(a);
        if (j && Array.isArray(j.limits) && j.limits.length) plan = j;
        else if (j && j.purchase && j.purchase.name && Number(j.purchase.cost) > 0) buy = j.purchase;
      } catch {}
      setHist((p) => [...p.slice(-3), plan ? { q: question, a: "", plan } : buy ? { q: question, a: "", buy } : { q: question, a }]);
    } catch (e) { toast("Ask failed — " + e.message, "err"); }
    setBusy(false);
  };
  /* the model is told to return the FULL plan, so anything it left out is a
     category it means to zero — otherwise the applied total silently exceeds the
     one shown on the card */
  const untouched = (plan) => d.cats.filter((c) => Number(c.limit) > 0 &&
    !plan.limits.some((l) => String(l.cat || "").toLowerCase() === c.name.toLowerCase()));
  const applyPlan = (idx) => {
    const plan = hist[idx]?.plan;
    if (!plan) return;
    setD((p) => {
      let cats = [...p.cats];
      for (const l of plan.limits) {
        const name = String(l.cat || "").trim();
        const limit = Math.max(0, Math.round(Number(l.limit) || 0));
        if (!name) continue;
        const i = cats.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (i !== -1) cats[i] = { ...cats[i], limit };
        else cats.push({ id: uid(), name, limit });
      }
      return { ...p, cats };
    });
    setHist((p) => p.map((h, i) => (i === idx ? { ...h, applied: true } : h)));
    toast("Budget applied — the limits are live in the Budget tab.");
  };
  const addPurchase = (idx) => {
    const b = hist[idx]?.buy;
    if (!b) return;
    setD((p) => ({ ...p, purchases: [...(p.purchases || []), { id: uid(), name: String(b.name).slice(0, 60), cost: Math.round(Number(b.cost) || 0), by: /^\d{4}-\d{2}-\d{2}$/.test(b.by || "") ? b.by : "", monthly: 0 }] }));
    setHist((p) => p.map((h, i) => (i === idx ? { ...h, applied: true } : h)));
    toast("Added to your Purchase planner — see the Plan tab.");
  };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3>Ask Atlas</h3>
        <span className="note" style={{ margin: 0 }}>sends a compact summary of your data to Claude — nothing else</span>
      </div>
      {!hist.length && (
        <div className="row" style={{ marginTop: 8 }}>
          {["Make me a budget plan", "Budget that funds my goals on time", "Plan a trip: Atlanta to Ruston, 24 mpg", "Where did my money go last month?"].map((s) => (
            <button key={s} className="btn small" disabled={busy} onClick={() => ask(s)}>{s}</button>
          ))}
        </div>
      )}
      {hist.map((h, i) => (
        <div key={i} style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{h.q}</div>
          {h.plan ? (
            <div className="aiout" style={{ marginTop: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>Proposed budget</b>
                <b className="mono">{fmt(h.plan.limits.reduce((s, l) => s + (Number(l.limit) || 0), 0))}/mo</b>
              </div>
              {h.plan.limits.map((l) => {
                const ci = d.cats.findIndex((c) => c.name.toLowerCase() === String(l.cat || "").toLowerCase());
                return (
                  <div className="kv" key={l.cat}>
                    <span className="k row" style={{ gap: 7 }}>
                      <Icon k={catIconKey(l.cat)} size={13} color={seriesColor(ci)} />{l.cat}
                      {ci === -1 && <span className="tag">new</span>}
                    </span>
                    <span className="mono">{fmt(Number(l.limit) || 0)}<span style={{ color: "var(--faint)" }}>/mo</span></span>
                  </div>
                );
              })}
              {h.plan.note && <div className="note">{h.plan.note}</div>}
              {!h.applied && untouched(h.plan).length > 0 && (
                <div className="note">
                  Not in this plan and left as-is: {untouched(h.plan).map((c) => c.name + " " + fmt(c.limit)).join(" · ")}.
                  Ask for a plan that covers them if that's wrong.
                </div>
              )}
              <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                {h.applied
                  ? <span className="good">✓ Applied — live in the Budget tab</span>
                  : <>
                      <button className="btn small primary" onClick={() => applyPlan(i)}>Apply to Budget</button>
                      <span className="note" style={{ margin: 0 }}>or keep chatting to adjust it first</span>
                    </>}
              </div>
            </div>
          ) : h.buy ? (() => {
            const cost = Math.round(Number(h.buy.cost) || 0);
            const monthlyKept = Math.max(0, (Number(d.settings.incomeMonthly) || 0) - avgMonthlySpend(d.txns));
            /* the model sometimes answers "March 2027" instead of a date — that
               used to render as "$NaN/mo for NaN mo" */
            const by = /^\d{4}-\d{2}-\d{2}$/.test(h.buy.by || "") ? h.buy.by : null;
            const rawMonths = by ? Math.ceil((new Date(by) - new Date()) / (30.44 * 864e5)) : NaN;
            const months = Number.isFinite(rawMonths) ? Math.max(1, rawMonths) : null;
            const perMo = months ? cost / months : null;
            const liq = liquid(d.accounts);
            return (
              <div className="aiout" style={{ marginTop: 6 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{h.buy.name}</b>
                  <b className="mono">{fmt(cost)}</b>
                </div>
                {h.buy.note && <div className="note" style={{ marginTop: 4 }}>{h.buy.note}</div>}
                <div className="kv" style={{ marginTop: 8 }}>
                  <span className="k">Liquid savings after</span>
                  <span className="mono">{fmt(liq)} → <b className={liq - cost < 0 ? "bad" : ""}>{fmt(liq - cost)}</b></span>
                </div>
                {perMo != null && (
                  <div className="kv"><span className="k">To have it by {by}</span>
                    <span className="mono">{fmt(Math.round(perMo))}/mo for {months} mo{monthlyKept > 0 ? " · " + Math.round((perMo / monthlyKept) * 100) + "% of a typical month's surplus" : ""}</span></div>
                )}
                {monthlyKept > 0 && perMo == null && (
                  <div className="kv"><span className="k">At your usual surplus</span>
                    <span className="mono">~{Math.ceil(cost / monthlyKept)} mo to save up</span></div>
                )}
                <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                  {h.applied
                    ? <span className="good">✓ Added — it's in the Plan tab</span>
                    : <>
                        <button className="btn small primary" onClick={() => addPurchase(i)}>Add to planner</button>
                        <span className="note" style={{ margin: 0 }}>or tell me what to change (dates, extra costs…)</span>
                      </>}
                </div>
              </div>
            );
          })() : (
            <div className="aiout" style={{ marginTop: 6 }}>{h.a}</div>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <input className="in" style={{ flex: 1, minWidth: 200 }} placeholder="Ask anything — or describe a purchase to plan…"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => ask()}>{busy ? "Thinking…" : "Ask"}</button>
        {hist.length > 0 && <button className="btn" disabled={busy} onClick={() => setHist([])}>Clear</button>}
      </div>
      <div className="row" style={{ marginTop: 6, justifyContent: "space-between" }}>
        <label className="note" style={{ margin: 0, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
          Search the web — for salaries, companies and open roles
        </label>
        <span className="note" style={{ margin: 0 }}>knows your money, and your job search</span>
      </div>
      <div className="note">Answers come from the numbers in this app — educational, not financial advice.</div>
    </div>
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
      <main className="wrap" style={{ maxWidth: 430, paddingTop: 72 }}>
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
                <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={passkeyLogin}><KeyIcon />Sign in with a passkey</button>
                <div className="note" style={{ textAlign: "center", marginTop: 10 }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); setMode("recovery"); setErr(""); }} style={{ color: "var(--faint)" }}>Lost your device? Use a recovery code</a>
                </div>
              </>
            )}
          </>
        )}
        </div>
      </main>
    </div>
  );
  if (!config) return null;
  return <FinanceHQ config={config} />;
}
