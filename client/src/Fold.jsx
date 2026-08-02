import React, { useState } from "react";

/* A collapsible card. Lifted out of Career.jsx so the money tabs can use the
   same one — two implementations of "a section that folds" drift apart, and the
   chevron ending up on opposite sides of the page is exactly the kind of thing
   that makes an app feel assembled rather than designed. */
export default function Fold({ title, sub, right, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="card">
      <button className="foldhead" onClick={() => setOpen((v) => !v)}>
        <span className="row" style={{ gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {sub && <span className="note" style={{ margin: 0, fontSize: 12 }}>{sub}</span>}
        </span>
        <span className="row" style={{ gap: 10, alignItems: "center", flexWrap: "nowrap" }}>
          {/* the headline number stays visible while collapsed — a fold you have
              to open to learn anything from is just a hidden section */}
          {right && <span className="foldright">{right}</span>}
          <span className="note" style={{ margin: 0 }}>{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

/* Several sections are components that already render their own <div class=card>
   with their own <h3>. Wrapping those in a Fold would nest a card inside a card
   and show the title twice. Rather than thread a prop through every one of them,
   FoldWrap marks the subtree so CSS can strip the inner chrome — the child keeps
   working standalone anywhere else it's used. */
export function FoldWrap({ title, sub, right, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="card foldwrap">
      <button className="foldhead" onClick={() => setOpen((v) => !v)}>
        <span className="row" style={{ gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {sub && <span className="note" style={{ margin: 0, fontSize: 12 }}>{sub}</span>}
        </span>
        <span className="row" style={{ gap: 10, alignItems: "center", flexWrap: "nowrap" }}>
          {right && <span className="foldright">{right}</span>}
          <span className="note" style={{ margin: 0 }}>{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && <div className="foldbody">{children}</div>}
    </div>
  );
}
