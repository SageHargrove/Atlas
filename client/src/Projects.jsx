import React, { useState } from "react";

/* ------------------------------------------------------------------
   Projects — what you built, in your words.

   Seedable from GitHub, but deliberately not *bound* to it: a repo
   description is written for people who already found the repo, not for
   a hiring manager, and the line that gets you the interview ("this is
   the one to show a finance firm") lives nowhere in git. So GitHub fills
   the boring fields and you own the sentence that matters.
------------------------------------------------------------------ */

const MAX_PROJECTS = 12;
const blank = () => ({ id: Math.random().toString(36).slice(2, 9), name: "", what: "", stack: "", url: "", pitch: "", tags: "" });

export default function Projects({ S, setCareer, toast, aiEnabled }) {
  const list = S.projects || [];
  const [gh, setGh] = useState(S.githubUser || "");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [paste, setPaste] = useState(null);   // README text awaiting extraction

  const write = (fn) => setCareer((c) => ({ ...c, settings: { ...c.settings, projects: fn(c.settings.projects || []) } }));
  const patch = (id, ch) => write((l) => l.map((p) => (p.id === id ? { ...p, ...ch } : p)));

  /* Goes through Atlas's own server rather than calling api.github.com from the
     page. Two reasons: the CSP is connect-src 'self' and stays that way, and a
     browser call would leak this user's IP to GitHub on a feature that only
     reads public data. No token needed either way. */
  const importGithub = async () => {
    const user = gh.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/.*$/, "");
    if (!user) return toast("Enter your GitHub username first.", "err");
    setBusy("gh");
    try {
      const r = await fetch("/api/github/repos?user=" + encodeURIComponent(user));
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "GitHub returned " + r.status);
      const repos = body.repos || [];
      if (!repos.length) throw new Error("no public non-fork repos on that account");
      write((l) => {
        const have = new Set(l.map((p) => (p.url || p.name).toLowerCase()));
        const add = repos
          .filter((x) => !have.has(String(x.url).toLowerCase()) && !have.has(String(x.name).toLowerCase()))
          .slice(0, Math.max(0, MAX_PROJECTS - l.length))
          .map((x) => ({ ...blank(), name: x.name, url: x.url, what: x.what || "", stack: x.stack || "" }));
        if (!add.length) toast("Nothing new to add — those repos are already here.");
        else toast("Added " + add.length + " from GitHub. Write the pitch line on each — that's the part a repo can't give you.");
        return [...l, ...add];
      });
      setCareer((c) => ({ ...c, settings: { ...c.settings, githubUser: user } }));
      setOpen(true);
    } catch (e) { toast("GitHub import failed — " + e.message, "err"); }
    setBusy("");
  };

  /* The GitHub import can't see a private repo, and the best work often is one.
     A README has everything the fields need except the pitch line, so pasting
     one and pulling the fields out beats retyping it — and the pitch still gets
     written by you, because "why this matters" isn't in any README. */
  const fromReadme = async () => {
    const text = String(paste || "").trim();
    if (text.length < 40) return toast("Paste the README text first.", "err");
    setBusy("readme");
    try {
      const r = await fetch("/api/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt:
          "Here is a project README:\n\n" + text.slice(0, 12000) +
          '\n\nExtract it as ONLY JSON, no fences: {"name": string, "what": string under 30 words describing what it does, ' +
          '"stack": comma-separated technologies actually named in the README, ' +
          '"tags": comma-separated industries or role types this project is good evidence for (from: finance, IAM, identity, security, consulting, utilities, cleared, enterprise, product, data, web), ' +
          '"pitch": one sentence under 35 words in first person saying why this project matters, drawn from the README\'s own reasoning}. ' +
          "Invent nothing that isn't in the README." }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      const clean = JSON.parse(String(j.text || "").replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0] || "null");
      if (!clean || !clean.name) throw new Error("couldn't read a project out of that");
      const str = (v, n) => String(v || "").slice(0, n);
      write((l) => [...l, { ...blank(), name: str(clean.name, 60), what: str(clean.what, 200),
        stack: str(clean.stack, 120), tags: str(clean.tags, 80), pitch: str(clean.pitch, 300) }]);
      setPaste(null); setOpen(true);
      toast("Added " + clean.name + " — check the pitch line reads like you, not like a README.");
    } catch (e) { toast("Couldn't read that README — " + e.message, "err"); }
    setBusy("");
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Projects</h3>
        <span className="row" style={{ gap: 6 }}>
          {list.length > 0 && <button className="btn small" onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Edit " + list.length}</button>}
          {list.length < MAX_PROJECTS && <button className="btn small" onClick={() => { write((l) => [...l, blank()]); setOpen(true); }}>+ Add</button>}
        </span>
      </div>
      <div className="note" style={{ marginTop: 0 }}>
        What you've actually built. Resume tailoring, cover letters and fit scoring all read this, so a project
        here can get pulled into a specific application — Atlas for a finance firm, an AD build-out for an
        identity team — without living on every version of your resume.
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <input className="in" style={{ width: 190 }} placeholder="GitHub username" value={gh}
          onChange={(e) => setGh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && importGithub()} />
        <button className="btn small" disabled={!!busy} onClick={importGithub}>{busy === "gh" ? "Importing…" : "Import from GitHub"}</button>
        {aiEnabled && list.length < MAX_PROJECTS && (
          <button className="btn small" disabled={!!busy} onClick={() => setPaste(paste == null ? "" : null)}>
            {paste == null ? "Paste a README" : "Cancel"}
          </button>
        )}
        <span className="note" style={{ margin: 0, fontSize: 11.5 }}>Public repos only · private ones, paste the README</span>
      </div>

      {paste != null && (
        <div style={{ marginTop: 8 }}>
          <textarea className="in mono" style={{ minHeight: 130, fontSize: 12 }} placeholder="Paste the README here — works for private repos, or anything that never had one"
            value={paste} onChange={(e) => setPaste(e.target.value.slice(0, 20000))} />
          <div className="row">
            <button className="btn small primary" disabled={busy === "readme" || paste.trim().length < 40} onClick={fromReadme}>
              {busy === "readme" ? "Reading…" : "Pull the fields out"}
            </button>
            <span className="note" style={{ margin: 0, fontSize: 11.5 }}>
              Fills name, what it does, stack and tags. Read the pitch line it writes — that one should sound like you.
            </span>
          </div>
        </div>
      )}

      {!list.length ? (
        <div className="note">Nothing here yet. Import from GitHub for the ones that are public, and add anything that isn't by hand.</div>
      ) : !open ? (
        <div className="row" style={{ marginTop: 10, gap: 5, flexWrap: "wrap" }}>
          {list.map((p) => (
            <span key={p.id} className="tag" style={{ fontSize: 11.5, padding: "3px 9px" }}
              title={p.pitch || p.what || ""}>{p.name || "untitled"}{p.pitch ? " ✓" : ""}</span>
          ))}
          <span className="note" style={{ margin: 0, fontSize: 11.5 }}>
            {list.filter((p) => p.pitch?.trim()).length} of {list.length} have a pitch line
          </span>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {list.map((p) => (
            <div key={p.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row">
                <input className="in" style={{ width: 170 }} placeholder="Project name" value={p.name}
                  onChange={(e) => patch(p.id, { name: e.target.value.slice(0, 60) })} />
                <input className="in" style={{ flex: 1, minWidth: 160 }} placeholder="Link (optional)" value={p.url}
                  onChange={(e) => patch(p.id, { url: e.target.value.slice(0, 200) })} />
                <button className="x" title="Remove" onClick={() => write((l) => l.filter((x) => x.id !== p.id))}>✕</button>
              </div>
              <input className="in" style={{ marginTop: 6 }} placeholder="What it does, one line" value={p.what}
                onChange={(e) => patch(p.id, { what: e.target.value.slice(0, 200) })} />
              <div className="row" style={{ marginTop: 6 }}>
                <input className="in" style={{ flex: 1, minWidth: 150 }} placeholder="Stack — Python, React, Okta…" value={p.stack}
                  onChange={(e) => patch(p.id, { stack: e.target.value.slice(0, 120) })} />
                <input className="in" style={{ width: 190 }} placeholder="Best for — finance, IAM, utilities…" value={p.tags}
                  onChange={(e) => patch(p.id, { tags: e.target.value.slice(0, 80) })} />
              </div>
              <input className="in" style={{ marginTop: 6 }} placeholder="The sentence you'd say about it in an interview"
                value={p.pitch} onChange={(e) => patch(p.id, { pitch: e.target.value.slice(0, 300) })} />
            </div>
          ))}
          <div className="note">
            <b>Best for</b> is what makes tailoring smart — tag Atlas "finance, full-stack" and it gets pulled forward
            for a fintech application and left out of a cleared-defense one.
          </div>
        </div>
      )}
    </div>
  );
}

/* Fed into every tailoring prompt, so the AI works from what you built rather
   than only from what the resume happened to have room for. */
export function projectsBrief(S, aim) {
  const list = (S.projects || []).filter((p) => (p.name || "").trim());
  if (!list.length) return "";
  const want = String(aim || "").toLowerCase();
  const rank = (p) => (want && (p.tags || "").toLowerCase().split(/[,\s]+/).some((t) => t && want.includes(t)) ? 0 : 1);
  return "\n\nProjects this person has built (use the relevant ones, ignore the rest, and never claim one they didn't build):\n" +
    [...list].sort((a, b) => rank(a) - rank(b)).slice(0, 8)
      .map((p) => "- " + p.name + (p.stack ? " [" + p.stack + "]" : "") + ": " + (p.pitch || p.what || "") + (p.url ? " (" + p.url + ")" : ""))
      .join("\n");
}
