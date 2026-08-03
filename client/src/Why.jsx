import React, { useState } from "react";

/* ------------------------------------------------------------------
   "Where did this number come from?"

   Atlas derives a lot of figures — an emergency fund target, a loan
   balance, fit scores, a tax set-aside. Every one of them has been
   wrong at least once, and each time the failure looked the same: the
   number was plausible enough to survive review, and there was no way
   to interrogate it short of reading the source.

   Six months of expenses came out at $27,000 for someone whose rent is
   $475, because a mean over three months quietly counted a one-off tax
   bill as recurring. Nothing on screen said "mean", "three months", or
   "including taxes". Had it, the error would have been obvious in
   seconds rather than surviving weeks.

   So: any derived number can carry its own working. Inputs, the rule
   applied, and — most importantly — what it deliberately EXCLUDES,
   since that is where every one of these errors actually lived.
------------------------------------------------------------------ */

export default function Why({ label, rows = [], rule, excludes, result, caveat }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="whybtn" title="Where did this number come from?"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>?</button>
      {open && (
        <div className="whybox" onClick={(e) => e.stopPropagation()}>
          <div className="whyhead">
            <b>{label}</b>
            <button className="x" onClick={() => setOpen(false)}>✕</button>
          </div>
          {rows.length > 0 && (
            <div className="whyrows">
              {rows.map((r, i) => (
                <div className="whyrow" key={i}>
                  <span>{r.k}</span>
                  <span className="mono">{r.v}</span>
                </div>
              ))}
            </div>
          )}
          {rule && <div className="whyrule"><b>Rule:</b> {rule}</div>}
          {/* The exclusions are the point. Every derived-number bug in this app
              has been something silently included, not something mis-multiplied. */}
          {excludes && <div className="whyrule"><b>Deliberately excluded:</b> {excludes}</div>}
          {result != null && (
            <div className="whyresult">
              <span>Result</span>
              <span className="mono">{result}</span>
            </div>
          )}
          {caveat && <div className="note" style={{ margin: "6px 0 0" }}>{caveat}</div>}
        </div>
      )}
    </>
  );
}
