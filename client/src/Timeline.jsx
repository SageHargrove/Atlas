import React, { useMemo } from "react";
import { parseWindow, compoundGap, MON_FULL, absMonth, monthLabel } from "./careerData.js";
export { compoundGap };

/* ------------------------------------------------------------------
   Timeline — when to apply, not just where.

   Previously drawn as a horizontal axis with milestone dots alternating
   above and below it. That shape looked like a plan and read like a
   decoration: the labels collided, the interesting part of the year
   occupied a fifth of the width, and "what should I do this week" was
   nowhere on it.

   This is the same data as a dated list, nearest first. A timeline you
   read top to bottom can carry a status and an action per row, which is
   the entire point — the horizontal version had room for neither.

   Campus recruiting is why any of it matters: full-time new-grad
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

export default function Timeline({ S, apps, setCareer, onShowOpen, live }) {
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
    return g;
  }, [apps, now]);

  const seasonStart = gradAbs - 9;            // the August before a May graduation
  const seasonEnd = gradAbs - 6;              // through that November
  const inSeason = now >= seasonStart && now <= seasonEnd;
  /* windowOpen = targets whose PARSED window says open (a guess); verified =
     live roles actually on their boards right now (a fact, when the feed has
     loaded). The fact always outranks the guess wherever both exist. */
  const windowOpen = groups.open.length + groups.closing.length;
  const verified = live ? live.liveRoles : null;
  const applied = apps.filter((a) => a.status !== "Target" && a.status !== "Rejected" && a.status !== "Withdrawn").length;

  if (!apps.length) return null;

  const doneMap = S.milestones || {};
  /* Store the NEW state explicitly rather than flipping whatever is in the map:
     for a row Atlas pre-ticked there is no entry yet, so a plain flip would set
     it to true — i.e. the first click on an already-ticked row would do nothing
     visible, which is exactly what "some of these aren't uncheckable" felt like. */
  const toggle = (k, wasDone) => setCareer((c) => ({ ...c, settings: { ...c.settings,
    milestones: { ...(c.settings.milestones || {}), [k]: !wasDone } } }));

  /* Each row derives "done" from the data where it can, so it cannot claim you
     finished something you haven't. The rest are yours to tick. `at` is the
     month it belongs to; rows are ordered by it and the current one is called
     out rather than being one dot among six. */
  /* Every row is yours to tick or untick. Atlas can often SEE that something is
     done and pre-ticks it, but it never locks the box — a resume is never
     "finished", and an app that argues with you about what you've done is worse
     than one that just asks. "Resume finished" is gone entirely for that reason,
     and so is "10 applications out": a fixed target is the wrong shape for a
     search where the honest answer is "as many good ones as I can". */
  const rows = [
    { k: "projects", at: seasonStart - 1, label: "Projects written up",
      auto: (S.projects || []).some((p) => (p.pitch || "").trim()),
      todo: "Write a one-line pitch for each project. This is what you'll say out loud in an interview." },
    { k: "open", at: seasonStart, label: "New-grad window opens", auto: now >= seasonStart,
      detail: verified != null
        ? (verified ? verified + " verified live role" + (verified === 1 ? "" : "s") + " across " + live.liveCos + " of your targets" : "no verified openings at your targets today")
        : windowOpen ? windowOpen + " targets in window (unverified)" : "" },
    { k: "applying", at: seasonStart + 1, label: "Applications going out",
      auto: applied > 0,
      detail: applied ? applied + " out so far" + (groups.done.length ? " · " + groups.done.length + " in flight" : "") : "",
      todo: "Being in the pile before it closes beats a perfect resume submitted late." },
    { k: "close", at: seasonEnd, label: "Most pipelines close", auto: now > seasonEnd,
      todo: "Anything not applied to by here is a rolling-req or referral play." },
    { k: "offer", at: gradAbs - 3, label: "Decision time", auto: apps.some((a) => a.status === "Offer"),
      todo: "Compare offers against your SPP floor before answering anyone." },
    { k: "grad", at: gradAbs, label: "Graduate", auto: now >= gradAbs },
  ].sort((a, b) => a.at - b.at);

  /* The row you are living in right now — everything above it is history,
     everything below is upcoming. */
  const currentIdx = rows.reduce((best, r, i) => (r.at <= now ? i : best), 0);

  const monthsLeft = seasonEnd - now;

  return (
    <>
      <div className="tlhead">
        <div className={"tlurgent " + (inSeason ? "on" : "")}>
          {inSeason ? (
            <>
              <b>You're inside the new-grad window.</b> Pipelines for a {MON_FULL[gradAbs % 12]} {Math.floor(gradAbs / 12)} graduate
              close by Thanksgiving — <b>{monthsLeft <= 0 ? "this is the last month" : monthsLeft + " month" + (monthsLeft === 1 ? "" : "s") + " left"}</b>.
            </>
          ) : seasonStart - now > 0 ? (
            <>Window opens in <b>{seasonStart - now} month{seasonStart - now === 1 ? "" : "s"}</b> ({label(seasonStart)}).
            Spend it on the resume and projects — once it opens, speed beats polish.</>
          ) : (
            <>The main campus window for {label(gradAbs)} has passed. Rolling reqs, referrals and smaller employers are the route now.</>
          )}
        </div>
        <label className="row" style={{ gap: 7, margin: 0, flexWrap: "nowrap" }}>
          <span className="note" style={{ margin: 0, whiteSpace: "nowrap" }}>Graduating</span>
          <input className="in mono" type="month" style={{ width: 138 }} value={grad}
            onChange={(e) => setCareer((c) => ({ ...c, settings: { ...c.settings, gradMonth: e.target.value } }))} />
        </label>
      </div>

      {/* four counts, above the list, because they're the summary of it.
          "Open right now" means VERIFIED — live postings on target boards,
          through your own filters — because a count of parsed window strings
          told you 73 were open when Jump Trading's board had zero. Unreadable
          boards are unknown, not open; they're named, not counted. */}
      <div className="tlstats">
        <button className="tlstat" onClick={() => onShowOpen && onShowOpen()}
          title={verified != null ? "Live matching roles on your targets' own boards — click to see exactly these" : "Job feed still loading"}>
          <span className="tlsn" style={{ color: verified ? "var(--up)" : "var(--faint)" }}>{verified ?? "—"}</span>
          <span className="tlsl">Open right now{verified != null && live?.liveCos ? " · " + live.liveCos + " employer" + (live.liveCos === 1 ? "" : "s") : ""}</span>
        </button>
        <div className="tlstat"><span className="tlsn">{groups.soon.length}</span><span className="tlsl">Opens soon</span></div>
        <div className="tlstat"><span className="tlsn" style={{ color: applied ? "var(--acc)" : "var(--faint)" }}>{applied}</span><span className="tlsl">Applied</span></div>
        <div className="tlstat"><span className="tlsn" style={{ color: groups.missed.length ? "var(--down)" : "var(--faint)" }}>{groups.missed.length}</span><span className="tlsl">Missed window</span></div>
      </div>
      {live && (live.unverifiable > 0 || live.watchedNone > 0) && (
        <div className="note" style={{ marginTop: 6 }}>
          {live.watchedNone > 0 && <>{live.watchedNone} target{live.watchedNone === 1 ? "" : "s"} watched with nothing matching today. </>}
          {live.unverifiable > 0 && <>{live.unverifiable} ha{live.unverifiable === 1 ? "s" : "ve"} no readable board — unknown, not counted; their Open buttons are the way to check by hand.</>}
        </div>
      )}

      <ol className="tline">
        {rows.map((r, i) => {
          /* An explicit untick beats what Atlas inferred. Without this, a row it
             can see is done could never be cleared, which is the complaint. */
          const hit = r.k in doneMap ? doneMap[r.k] : r.auto;
          const isNow = i === currentIdx;
          const past = r.at < now;
          const state = hit ? "done" : past ? "late" : "todo";
          return (
            <li className={"tli " + state + (isNow ? " now" : "")} key={r.k}>
              <div className="tlwhen">{isNow ? "NOW" : MON_FULL[((r.at % 12) + 12) % 12].slice(0, 3).toUpperCase()}
                <span className="tlyr">{r.at === now ? "" : String(Math.floor(r.at / 12)).slice(2)}</span></div>
              <button className="tlmark"
                title={hit ? "Done — click to undo" : "Click when you've done this"}
                onClick={() => toggle(r.k, hit)}>{hit ? "✓" : ""}</button>
              <div className="tlbody">
                <div className="tlname">{r.label}</div>
                {r.progress && (
                  <div className="tlprog" title={r.progress[0] + " of " + r.progress[1]}>
                    <div className="tlprogf" style={{ width: Math.min(100, (r.progress[0] / r.progress[1]) * 100) + "%" }} />
                    <span className="tlprogn">{r.progress[0]}/{r.progress[1]}</span>
                  </div>
                )}
                {r.detail && <div className="tlsub">{r.detail}</div>}
                {!hit && r.todo && <div className="tlsub todo">{r.todo}</div>}
              </div>
            </li>
          );
        })}
      </ol>

      {(verified ?? windowOpen) > 0 && applied === 0 && (
        <div className="note bad" style={{ marginTop: 10 }}>
          <div>
            {verified != null
              ? <>{verified} verified live role{verified === 1 ? " is" : "s are"} on your targets' own boards today and you haven't applied to anything.</>
              : <>{windowOpen} target window{windowOpen === 1 ? " is" : "s are"} open by their stated dates.</>} That's the whole game —
            the tailored resume matters far less than being in the pile before it closes.
          </div>
          {onShowOpen && (
            <div className="mrow" style={{ justifyContent: "flex-start", marginTop: 8 }}>
              {/* passes the actual company list, so the finder filters to the
                  ones whose window is open rather than just to "my targets" */}
              <button className="btn small primary" onClick={() => onShowOpen()}>
                Show {verified != null ? "the " + verified + " verified roles" : "what's open"}
              </button>
            </div>
          )}
        </div>
      )}
      {!!groups.missed.length && (
        <div className="note" style={{ marginTop: 6 }}>
          {groups.missed.length} target{groups.missed.length === 1 ? "'s window has" : "s' windows have"} closed. Not lost — a rolling
          req or a referral still works — but the campus pipeline for those has moved on.
        </div>
      )}
    </>
  );
}
