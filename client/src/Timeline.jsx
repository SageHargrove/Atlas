import React, { useMemo, useState } from "react";
import { money, parseWindow, compoundGap, MON_FULL, absMonth, monthLabel } from "./careerData.js";
export { compoundGap };

/* ------------------------------------------------------------------
   Timeline — when to apply, not just where.

   The seed list already knew that Optiv opens Aug–Oct and the tier-3
   enterprises open Jan–Apr; that knowledge sat in a free-text string on
   each row where nothing could act on it. This parses it, anchors it to
   your graduation date, and sorts the whole list into "this is late",
   "this is open", "this opens in five weeks".

   Campus recruiting is the reason this matters: full-time new-grad
   pipelines for a May graduate open the PREVIOUS August through October
   and close before Thanksgiving. Miss that quarter and the good ones
   aren't hiring you off-cycle in April, however good your resume is.
------------------------------------------------------------------ */

const absNow = absMonth;
const label = monthLabel;

/* Where a target sits relative to today. "Closing" is its own bucket because
   three weeks left and five months out demand very different behaviour. */
function bucketOf(app, now) {
  const done = app.status === "Applied" || app.status === "Interviewing" || app.status === "Offer";
  if (app.status === "Rejected" || app.status === "Withdrawn") return null;
  const w = parseWindow(app.window);
  if (done) return { key: "done", order: 5, w };
  if (!w) return { key: "undated", order: 4, w };
  if (w.from == null) return { key: "open", order: 1, w };
  if (now > w.to) return w.rolling ? { key: "open", order: 1, w } : { key: "missed", order: 0, w };
  if (now >= w.from) return { key: now === w.to ? "closing" : "open", order: now === w.to ? 0 : 1, w };
  return { key: "soon", order: w.from - now <= 2 ? 2 : 3, w };
}

const BUCKETS = {
  missed: { title: "Window has closed", color: "var(--down)", note: "Not lost — a rolling req or a referral still works, but the campus pipeline for these has moved on." },
  closing: { title: "Closing this month", color: "var(--down)", note: "Apply this week. These stop taking new-grad applications at the end of the month." },
  open: { title: "Open now", color: "var(--up)", note: "Taking applications today. This is where your effort should go." },
  soon: { title: "Opens within 2 months", color: "var(--gold)", note: "Get the tailored resume and cover letter ready now so you're applying in week one, not week six." },
  later: { title: "Later in the cycle", color: "var(--faint)", note: "Nothing to do yet. They'll move up as their month arrives." },
  undated: { title: "No window set", color: "var(--faint)", note: "Add a hiring window on these and they'll sort themselves into the plan." },
  done: { title: "Already in flight", color: "var(--acc)", note: "" },
};

export default function Timeline({ S, apps, setCareer, setEditing }) {
  const [open, setOpen] = useState(true);
  const now = absNow(new Date());
  const grad = S.gradMonth || "2027-05";
  const gradAbs = Number(grad.slice(0, 4)) * 12 + (Number(grad.slice(5, 7)) - 1);

  const groups = useMemo(() => {
    const g = { missed: [], closing: [], open: [], soon: [], later: [], undated: [], done: [] };
    for (const a of apps) {
      const b = bucketOf(a, now);
      if (!b) continue;
      const key = b.key === "soon" && b.order === 3 ? "later" : b.key;
      g[key].push({ ...a, w: b.w });
    }
    for (const k of Object.keys(g)) g[k].sort((x, y) => (x.w?.from ?? 9e9) - (y.w?.from ?? 9e9) || String(x.company).localeCompare(String(y.company)));
    return g;
  }, [apps, now]);

  /* The one number that actually drives urgency: months of campus-recruiting
     season left before you graduate. */
  const seasonStart = (gradAbs - 9);            // the August before a May graduation
  const seasonEnd = (gradAbs - 6);              // through that November
  const inSeason = now >= seasonStart && now <= seasonEnd;
  const toSeason = seasonStart - now;

  const live = groups.open.length + groups.closing.length;
  const applied = apps.filter((a) => a.status !== "Target" && a.status !== "Rejected" && a.status !== "Withdrawn").length;

  if (!apps.length) return null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Application timeline</h3>
        <span className="row" style={{ gap: 6 }}>
          <label className="note" style={{ margin: 0 }}>Graduating</label>
          <input className="in mono" type="month" style={{ width: 140 }} value={grad}
            onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, gradMonth: e.target.value } }))} />
          <button className="btn small" onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Expand"}</button>
        </span>
      </div>

      <div className="note" style={{ marginTop: 0, color: inSeason ? "var(--gold)" : undefined }}>
        {inSeason ? (
          <>
            <b>You're inside the new-grad window right now.</b> Full-time pipelines for a {MON_FULL[gradAbs % 12]} {Math.floor(gradAbs / 12)} graduate
            open the previous August and mostly close by Thanksgiving — that's {seasonEnd - now === 0 ? "this month" : (seasonEnd - now) + " more months"}.
            Off-cycle hiring in spring exists, but the good programmes will already be full.
          </>
        ) : toSeason > 0 ? (
          <>
            The new-grad window for a {MON_FULL[gradAbs % 12]} {Math.floor(gradAbs / 12)} graduate opens in <b>{toSeason} month{toSeason === 1 ? "" : "s"}</b> ({label(seasonStart)}).
            Use the time to get resumes and projects finished — once it opens, speed matters more than polish.
          </>
        ) : (
          <>The main campus window for {label(gradAbs)} has passed. Rolling reqs, referrals and smaller employers are the route now.</>
        )}
      </div>

      <div className="grid4" style={{ marginTop: 10 }}>
        <div><div className="sub">Open right now</div><div className="mono" style={{ fontSize: 20, fontWeight: 600, color: live ? "var(--up)" : undefined }}>{live}</div></div>
        <div><div className="sub">Opens soon</div><div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{groups.soon.length}</div></div>
        <div><div className="sub">Applied</div><div className="mono" style={{ fontSize: 20, fontWeight: 600, color: "var(--acc)" }}>{applied}</div></div>
        <div><div className="sub">Missed window</div><div className="mono" style={{ fontSize: 20, fontWeight: 600, color: groups.missed.length ? "var(--down)" : undefined }}>{groups.missed.length}</div></div>
      </div>

      {live > 0 && applied === 0 && (
        <div className="note bad" style={{ marginTop: 8 }}>
          {live} target{live === 1 ? " is" : "s are"} open today and you haven't applied to anything yet. That's the whole game — the
          tailored resume matters far less than being in the pile before it closes.
        </div>
      )}

      {open && ["closing", "open", "soon", "missed", "later", "undated", "done"].map((k) => {
        const rows = groups[k];
        if (!rows.length) return null;
        const b = BUCKETS[k];
        return (
          <div key={k} style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 8 }}>
              <b style={{ color: b.color, fontSize: 13.5 }}>{b.title}</b>
              <span className="tag">{rows.length}</span>
            </div>
            {b.note && <div className="note" style={{ margin: "2px 0 6px" }}>{b.note}</div>}
            {rows.slice(0, k === "done" || k === "later" ? 6 : 30).map((a) => (
              <div key={a.id} className="kv" style={{ padding: "5px 0" }}>
                <span className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.company}
                  <span className="note" style={{ margin: 0, fontSize: 11.5 }}> · {a.role}</span>
                </span>
                <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <span className="note mono" style={{ margin: 0, fontSize: 11.5 }}>
                    {a.w?.from != null ? label(a.w.from) + (a.w.to !== a.w.from ? " – " + label(a.w.to).split(" ")[0] : "") : a.window || "—"}
                    {a.w?.rolling ? " · rolling" : ""}
                  </span>
                  {a.comp != null && a.comp !== "" && <span className="mono" style={{ fontSize: 12.5 }}>{money(a.comp)}</span>}
                  <button className="btn small" onClick={() => setEditing(a)}>Open</button>
                </span>
              </div>
            ))}
            {rows.length > (k === "done" || k === "later" ? 6 : 30) && (
              <div className="note" style={{ margin: 0 }}>+{rows.length - (k === "done" || k === "later" ? 6 : 30)} more</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

