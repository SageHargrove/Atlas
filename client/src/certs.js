/* ------------------------------------------------------------------
   Certifications — tracked as career data, not study material.

   Atlas already treats certs as job-market vocabulary: odds.js matches
   them in postings against the resume. What was missing is the other
   half — which ones you hold, which one you're sitting next month, what
   the exam cost, and when a renewal quietly comes due. That's tracking,
   and it belongs here next to the job engine that consumes it.

   Deliberately NOT a study app. Spaced repetition is Anki's job;
   building a worse Anki inside a finance tracker helps nobody. This
   models the parts Atlas is uniquely placed to know: money, dates, and
   what a cert does to your odds.
------------------------------------------------------------------ */

/* The certs an IAM/security career actually files past, with the numbers a
   tracker needs: rough exam cost (USD, list price), how long a pass stays
   valid, and the token odds.js matches in postings. Cost is a default the
   user can override — vouchers and bundles exist. */
export const CERT_CATALOG = [
  { code: "SEC+",   name: "CompTIA Security+",            cost: 404, validYears: 3, keyword: "security+" },
  { code: "CYSA+",  name: "CompTIA CySA+",                cost: 424, validYears: 3, keyword: "cysa+" },
  { code: "PENTEST+", name: "CompTIA PenTest+",           cost: 424, validYears: 3, keyword: "pentest+" },
  { code: "SC-900", name: "Microsoft Security Fundamentals", cost: 99,  validYears: 0, keyword: "sc-900" },
  { code: "SC-300", name: "Microsoft Identity and Access Administrator", cost: 165, validYears: 1, keyword: "sc-300" },
  { code: "SC-200", name: "Microsoft Security Operations Analyst", cost: 165, validYears: 1, keyword: "sc-200" },
  { code: "SC-100", name: "Microsoft Cybersecurity Architect", cost: 165, validYears: 1, keyword: "sc-100" },
  { code: "AZ-104", name: "Microsoft Azure Administrator", cost: 165, validYears: 1, keyword: "az-104" },
  { code: "AZ-500", name: "Microsoft Azure Security Engineer", cost: 165, validYears: 1, keyword: "az-500" },
  { code: "CISSP",  name: "ISC2 CISSP",                   cost: 749, validYears: 3, keyword: "cissp" },
  { code: "CISM",   name: "ISACA CISM",                   cost: 575, validYears: 3, keyword: "cism" },
  { code: "CISA",   name: "ISACA CISA",                   cost: 575, validYears: 3, keyword: "cisa" },
  { code: "GSEC",   name: "GIAC Security Essentials",     cost: 999, validYears: 4, keyword: "gsec" },
  { code: "GCIH",   name: "GIAC Incident Handler",        cost: 999, validYears: 4, keyword: "gcih" },
  { code: "OSCP",   name: "OffSec Certified Professional", cost: 1749, validYears: 0, keyword: "oscp" },
];

export const CERT_STATUSES = ["planned", "studying", "scheduled", "passed", "expired"];

const DAY = 86400e3;
const daysUntil = (iso, today) => Math.ceil((Date.parse(iso) - Date.parse(today)) / DAY);

export const catalogByCode = (code) =>
  CERT_CATALOG.find((c) => c.code.toLowerCase() === String(code || "").toLowerCase()) || null;

/* When a pass stops counting. Prefer an explicit expiry the user typed (their
   portal knows best); otherwise derive from the pass date and the catalog's
   validity. Microsoft's 1-year renewals are free online, which is exactly why
   they're the ones people forget. */
export function expiryOf(cert) {
  if (cert.expiresDate) return cert.expiresDate;
  const known = catalogByCode(cert.code);
  if (cert.status === "passed" && cert.passedDate && known?.validYears) {
    const d = new Date(cert.passedDate + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() + known.validYears);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/* The strip at the top of the section: everything with a date attached to it,
   soonest first, worded so the row is an instruction rather than a fact.
   Windows are generous on purpose — a renewal surfacing 90 days out costs one
   glance; one surfacing after it lapsed costs a retake fee. */
export function certAgenda(certs, today) {
  const items = [];
  for (const cert of certs || []) {
    const label = cert.code || cert.name;
    if (cert.status === "scheduled" && cert.examDate) {
      const days = daysUntil(cert.examDate, today);
      if (days < 0) items.push({ kind: "exam-passed?", days, label, text: `${label} exam date has passed — mark it passed, or reschedule` });
      else items.push({ kind: "exam", days, label, text: days === 0 ? `${label} exam is today` : `${label} exam in ${days} day${days === 1 ? "" : "s"}` });
    }
    const expiry = expiryOf(cert);
    if (cert.status === "passed" && expiry) {
      const days = daysUntil(expiry, today);
      if (days < 0) items.push({ kind: "lapsed", days, label, text: `${label} lapsed ${-days} day${days === -1 ? "" : "s"} ago` });
      else if (days <= 90) items.push({ kind: "renewal", days, label, text: `${label} renewal due in ${days} day${days === 1 ? "" : "s"}` });
    }
  }
  return items.sort((a, b) => a.days - b.days);
}

/* Money: what the plan costs and what's already spent — the halves the budget
   tab cares about. A cert without a cost uses the catalog default. */
export function certCosts(certs) {
  let spent = 0, planned = 0;
  for (const cert of certs || []) {
    const cost = cert.cost != null && cert.cost !== "" ? Number(cert.cost) : (catalogByCode(cert.code)?.cost ?? 0);
    if (!Number.isFinite(cost)) continue;
    if (cert.status === "passed" || cert.status === "expired") spent += cost;
    else planned += cost;
  }
  return { spent, planned };
}

/* The odds integration. Scoring reads the resume's vocabulary; a passed cert
   the resume forgot to mention is signal Atlas *knows* and shouldn't drop.
   Appended as plain text so tokensOf finds the keywords — nothing about
   scoring changes shape, the resume just stops under-reporting. */
export function withCerts(resume, certs) {
  const held = (certs || [])
    .filter((cert) => cert.status === "passed")
    .map((cert) => catalogByCode(cert.code)?.keyword || cert.code || cert.name)
    .filter(Boolean);
  if (!held.length) return String(resume || "");
  return String(resume || "") + "\nCertifications held: " + held.join(", ") + ".";
}

/* Stable presentation order: what needs action first, then the trophy shelf. */
const STATUS_ORDER = { scheduled: 0, studying: 1, planned: 2, passed: 3, expired: 4 };
export function sortCerts(certs) {
  return [...(certs || [])].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || String(a.examDate || a.passedDate || "9999").localeCompare(String(b.examDate || b.passedDate || "9999"))
    || String(a.code || a.name).localeCompare(String(b.code || b.name)));
}
