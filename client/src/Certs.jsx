import React, { useState } from "react";
import { CERT_CATALOG, CERT_STATUSES, catalogByCode, certAgenda, certCosts, expiryOf, sortCerts } from "./certs.js";

/* ------------------------------------------------------------------
   The cert shelf.

   Which certs you hold, which one is next, what the plan costs, and
   the renewal dates nobody remembers until the portal email bounces.
   The passed ones quietly feed the job odds (JobFinder scores against
   a resume that always mentions them), which is the reason this lives
   in Atlas instead of a spreadsheet: here, a cert is career signal,
   not a row.
------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const dollars = (n) => "$" + Math.abs(Math.round(n)).toLocaleString();

const STATUS_LABEL = { planned: "Planned", studying: "Studying", scheduled: "Exam booked", passed: "Passed", expired: "Expired" };

export default function Certs({ S, setCareer }) {
  const certs = S.certs || [];
  const [code, setCode] = useState("");
  const [custom, setCustom] = useState("");

  const save = (fn) => setCareer((c) => ({ ...c, settings: { ...c.settings, certs: fn(c.settings.certs || []) } }));

  const add = () => {
    const known = catalogByCode(code);
    const name = known ? known.name : custom.trim();
    if (!known && !name) return;
    save((list) => [...list, {
      id: uid(),
      code: known ? known.code : custom.trim().slice(0, 40),
      name,
      status: "planned",
      cost: known ? known.cost : "",
      examDate: "", passedDate: "", expiresDate: "", notes: "",
    }]);
    setCode(""); setCustom("");
  };
  const patch = (id, p) => save((list) => list.map((cert) => (cert.id === id ? { ...cert, ...p } : cert)));
  const del = (id) => save((list) => list.filter((cert) => cert.id !== id));

  const agenda = certAgenda(certs, today());
  const { spent, planned } = certCosts(certs);
  const held = certs.filter((c) => c.status === "passed").length;
  const taken = new Set(certs.map((c) => String(c.code).toLowerCase()));

  return (
    <>
      {agenda.length > 0 && (
        <div style={{ marginTop: 0 }}>
          {agenda.map((item, i) => (
            <div className="note" key={i} style={{ marginTop: i ? 4 : 0,
              borderColor: item.kind === "lapsed" || item.kind === "exam-passed?" ? "var(--down)" : item.days <= 14 ? "var(--gold)" : undefined }}>
              {item.text}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: agenda.length ? 10 : 0, alignItems: "flex-end" }}>
        <div style={{ flex: "0 0 260px" }}>
          <label className="f">Certification</label>
          <select className="in" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Pick one…</option>
            {CERT_CATALOG.filter((c) => !taken.has(c.code.toLowerCase())).map((c) => (
              <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
            ))}
            <option value="__other__">Something else…</option>
          </select>
        </div>
        {code === "__other__" && (
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="f">Name</label>
            <input className="in" value={custom} placeholder="e.g. Okta Certified Professional"
              onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          </div>
        )}
        <button className="btn small primary" disabled={!code || (code === "__other__" && !custom.trim())} onClick={add}>Track</button>
      </div>

      {!certs.length ? (
        <div className="note" style={{ marginTop: 10 }}>
          Nothing tracked yet. Add the one you're studying for — the exam date and cost live here, the passed ones
          feed your job odds automatically, and renewals surface before they lapse instead of after.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {sortCerts(certs).map((cert) => <CertRow key={cert.id} cert={cert} patch={patch} del={del} />)}
          <div className="note" style={{ marginTop: 8 }}>
            {held ? `${held} held — they're counted in your job odds. ` : ""}
            {spent ? `Spent ${dollars(spent)} on exams so far` : ""}{spent && planned ? "; " : ""}
            {planned ? `the rest of the plan runs about ${dollars(planned)}` : ""}{spent || planned ? "." : ""}
          </div>
        </div>
      )}
    </>
  );
}

function CertRow({ cert, patch, del }) {
  const [open, setOpen] = useState(false);
  const expiry = expiryOf(cert);
  const sub = cert.status === "scheduled" && cert.examDate ? "exam " + cert.examDate
    : cert.status === "passed" ? (expiry ? "renews " + expiry : "passed " + (cert.passedDate || "")) : STATUS_LABEL[cert.status];

  return (
    <div className="bragrow" style={{ display: "block", padding: "8px 10px" }}>
      <div className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <b style={{ minWidth: 76 }}>{cert.code}</b>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cert.name}</span>
        <span className="tlabel" style={{ margin: 0 }}>{sub}</span>
        <button className="x" title="Stop tracking" onClick={(e) => { e.stopPropagation(); del(cert.id); }}>✕</button>
      </div>
      {open && (
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 130px" }}>
            <label className="f">Status</label>
            <select className="in" value={cert.status} onChange={(e) => {
              const status = e.target.value;
              patch(cert.id, { status, ...(status === "passed" && !cert.passedDate ? { passedDate: today() } : {}) });
            }}>
              {CERT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="f">Exam date</label>
            <input className="in" type="date" value={cert.examDate || ""} onChange={(e) => patch(cert.id, { examDate: e.target.value })} />
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="f">Passed</label>
            <input className="in" type="date" value={cert.passedDate || ""} onChange={(e) => patch(cert.id, { passedDate: e.target.value })} />
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="f">Expires</label>
            <input className="in" type="date" value={cert.expiresDate || ""} onChange={(e) => patch(cert.id, { expiresDate: e.target.value })} />
          </div>
          <div style={{ flex: "0 0 110px" }}>
            <label className="f">Exam cost</label>
            <input className="in" type="number" value={cert.cost ?? ""} placeholder="$"
              onChange={(e) => patch(cert.id, { cost: e.target.value })} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="f">Notes</label>
            <input className="in" value={cert.notes || ""} placeholder="voucher code, CE portal, study plan…"
              onChange={(e) => patch(cert.id, { notes: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  );
}
