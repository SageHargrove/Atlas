import React, { useEffect, useMemo, useState } from "react";

/* Employers worth adding that Atlas cannot currently see.
   The feed only shows postings from boards Atlas can read, and the honest
   failure mode of that design is silence: an employer Atlas can't reach looks
   exactly like an employer with no openings. This is the antidote. It names
   the gaps, tries to close each one automatically, and when it genuinely
   can't, hands over a search rather than pretending.

   Three outcomes per row, and the UI never blurs them:
     found      - resolved and added, postings arrive on the next check
     not found  - Atlas tried and failed; here is a search to grab the URL
     untried    - not attempted yet */

const CAT_LABEL = {
  consulting: "Consultancy", enterprise: "Vendor", cleared: "Cleared / defense",
  utility: "Utility", financial: "Financial", bigtech: "Big tech", quant: "Quant",
};

export default function Suggest({ S, setCareer, toast }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  const [state, setState] = useState({});      // company -> {status, board, msg}
  const [busy, setBusy] = useState("");
  const [cat, setCat] = useState("all");
  const [pasteFor, setPasteFor] = useState("");
  const [pasteUrl, setPasteUrl] = useState("");

  useEffect(() => {
    let dead = false;
    fetch("/api/jobs/recommended")
      .then((r) => r.json())
      .then((j) => { if (!dead) j.error ? setErr(j.error) : setItems(j.items || []); })
      .catch(() => { if (!dead) setErr("Couldn't load recommendations"); });
    return () => { dead = true; };
  }, [S.boards]);

  const cats = useMemo(() => {
    const m = {};
    for (const it of items || []) m[it.cat] = (m[it.cat] || 0) + 1;
    return m;
  }, [items]);

  const shown = useMemo(() => (items || []).filter((it) => cat === "all" || it.cat === cat), [items, cat]);

  /* Adding a board is the same shape the manual "+ Employer" flow produces, so
     a row added from here is indistinguishable from one you pasted yourself. */
  const addBoard = (company, board, catHint) => {
    setCareer((c) => ({ ...c, settings: { ...c.settings,
      boards: [...(c.settings.boards || []).filter((b) => b.company.toLowerCase() !== company.toLowerCase()),
        { ...board, company: company.slice(0, 40), cat: catHint || "enterprise" }].slice(0, 60) } }));
  };

  const resolve = async (it) => {
    setBusy(it.company);
    try {
      const r = await fetch("/api/jobs/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: it.company, site: it.site }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "lookup failed");
      if (j.found) {
        const { company, postings, how, ...board } = j.board;
        addBoard(it.company, board, it.cat);
        setState((s) => ({ ...s, [it.company]: { status: "found", board, postings, how } }));
        toast(it.company + " added — " + postings + " postings on their board. They'll appear on the next check.");
      } else {
        setState((s) => ({ ...s, [it.company]: { status: "missing" } }));
      }
    } catch (e) {
      setState((s) => ({ ...s, [it.company]: { status: "missing", msg: e.message } }));
    }
    setBusy("");
  };

  /* The search that actually finds a board, rather than a generic careers page:
     name the ATS vendors so the result is the board URL itself. */
  const searchUrl = (it) => "https://www.google.com/search?q=" + encodeURIComponent(
    '"' + it.company + '" careers (greenhouse.io OR lever.co OR ashbyhq.com OR myworkdayjobs.com OR smartrecruiters.com OR applytojob.com)');

  const paste = async (it) => {
    if (!pasteUrl.trim()) return;
    setBusy(it.company);
    try {
      const r = await fetch("/api/jobs/parse-board", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: pasteUrl }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "that link isn't a readable board");
      addBoard(it.company, j.board, it.cat);
      setState((s) => ({ ...s, [it.company]: { status: "found", board: j.board, how: "you pasted it" } }));
      toast(it.company + " added — it'll be included from the next check.");
      setPasteFor(""); setPasteUrl("");
    } catch (e) { toast(e.message, "err"); }
    setBusy("");
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!items) return <div className="note">Loading…</div>;
  if (!items.length) return <div className="note">Every employer Atlas recommends is already in your feed.</div>;

  return (
    <div>
      <div className="note" style={{ marginTop: 0 }}>
        Atlas only shows postings from boards it can read, so an employer it can't reach looks the same as one
        with no openings. These are the gaps worth closing. <b>Find board</b> reads their careers page and adds
        it automatically; when that fails, <b>Search</b> opens a lookup for the board URL and you paste it back.
      </div>

      <div className="row" style={{ gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        <button className={"btn small" + (cat === "all" ? " primary" : "")} onClick={() => setCat("all")}>
          All {items.length}
        </button>
        {Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
          <button key={k} className={"btn small" + (cat === k ? " primary" : "")} onClick={() => setCat(k)}>
            {CAT_LABEL[k] || k} {n}
          </button>
        ))}
      </div>

      <div className="sglist">
        {shown.map((it) => {
          const st = state[it.company] || {};
          return (
            <div key={it.company} className={"sgrow" + (st.status === "found" ? " ok" : "")}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13.5 }}>{it.company}</b>
                  <span className="pill">{CAT_LABEL[it.cat] || it.cat}</span>
                  {/* saying so up front beats letting you press a button that was never going to work */}
                  {it.hard && st.status !== "found" && (
                    <span className="note" style={{ margin: 0, fontSize: 11 }}>likely no public board</span>
                  )}
                </div>
                <div className="note" style={{ margin: "2px 0 0", fontSize: 12 }}>{it.why}</div>
                {st.status === "found" && (
                  <div className="note" style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--up)" }}>
                    Added — {st.board?.kind}{st.board?.token ? " / " + st.board.token : ""}
                    {st.postings ? " · " + st.postings + " postings" : ""}{st.how ? " · found by " + st.how : ""}
                  </div>
                )}
                {st.status === "missing" && (
                  <div className="note" style={{ margin: "3px 0 0", fontSize: 11.5 }}>
                    No readable board found. They're likely on iCIMS, Taleo or SuccessFactors, which publish nothing
                    Atlas can parse. Search for it and paste the URL if you find one.
                  </div>
                )}
                {pasteFor === it.company && (
                  <div className="row" style={{ gap: 5, marginTop: 6 }}>
                    <input className="in" style={{ flex: 1, minWidth: 180 }} autoFocus
                      placeholder="Paste their board URL (greenhouse / lever / ashby / workday…)"
                      value={pasteUrl} onChange={(e) => setPasteUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && paste(it)} />
                    <button className="btn small primary" disabled={!pasteUrl.trim() || busy === it.company}
                      onClick={() => paste(it)}>Add</button>
                    <button className="btn small" onClick={() => { setPasteFor(""); setPasteUrl(""); }}>Cancel</button>
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 5, flexShrink: 0 }}>
                {st.status !== "found" && (
                  <button className="btn small" disabled={!!busy} onClick={() => resolve(it)}
                    title="Read their careers page and add the board automatically">
                    {busy === it.company ? "Looking…" : "Find board"}
                  </button>
                )}
                <a className="btn small" href={searchUrl(it)} target="_blank" rel="noreferrer"
                  title="Search for their job board URL">Search</a>
                {st.status !== "found" && pasteFor !== it.company && (
                  <button className="btn small" onClick={() => { setPasteFor(it.company); setPasteUrl(""); }}>Paste URL</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
