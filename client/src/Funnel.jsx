import React, { useMemo, useState } from "react";

/* ------------------------------------------------------------------
   Your own funnel, follow-ups, and the applications that have gone quiet.

   Job searching feels like random noise because the feedback loop is
   broken: you send things into a void and hear nothing, so there's no
   way to tell a bad résumé from a bad market from bad luck. A
   conversion rate is the only thing that turns that back into a
   number you can move.

   Two rules here. Rates are only quoted once there's enough to quote
   from — a 0-for-3 start is not a 0% conversion rate, it's three
   applications. And "no reply" is reported as an outcome in its own
   right, because at scale it IS the outcome, and pretending those
   applications are still live is what makes a board of 140 cards
   feel like progress.
------------------------------------------------------------------ */

const DEAD = ["Rejected", "Withdrawn"];
const LIVE = ["Applied", "Interviewing", "Offer"];
const day = 86400000;
const daysSince = (d) => (!d ? null : Math.floor((Date.now() - Date.parse(d)) / day));

/* An application with no movement for this long is, statistically, over. */
const GHOST_DAYS = 45;
/* Following up before this reads as impatient; after it, as an afterthought. */
const NUDGE_DAYS = 10;

export default function Funnel({ apps, setCareer }) {
  const [showAll, setShowAll] = useState(false);

  const m = useMemo(() => {
    const tracked = apps.filter((a) => a.status && a.status !== "Target");
    const applied = tracked.length;
    const interviewed = tracked.filter((a) => a.status === "Interviewing" || a.status === "Offer"
      || a.reachedInterview).length;
    const offers = tracked.filter((a) => a.status === "Offer").length;
    const rejected = tracked.filter((a) => a.status === "Rejected").length;

    /* Quiet = applied, not dead, nothing has moved in a while. */
    const quiet = tracked.filter((a) => a.status === "Applied" && !DEAD.includes(a.status)
      && (daysSince(a.appliedOn || a.updatedOn) ?? 0) >= GHOST_DAYS)
      .sort((x, y) => (daysSince(y.appliedOn) || 0) - (daysSince(x.appliedOn) || 0));

    /* Due a nudge = applied recently enough to still be live, old enough that a
       follow-up is the natural next move, and not already nudged. */
    const nudge = tracked.filter((a) => a.status === "Applied" && !a.followedUpOn
      && (daysSince(a.appliedOn) ?? 0) >= NUDGE_DAYS && (daysSince(a.appliedOn) ?? 0) < GHOST_DAYS)
      .sort((x, y) => (daysSince(y.appliedOn) || 0) - (daysSince(x.appliedOn) || 0));

    const pct = (n, dnm) => (dnm >= 8 ? Math.round((n / dnm) * 100) + "%" : null);
    return { applied, interviewed, offers, rejected, quiet, nudge,
      toInterview: pct(interviewed, applied), toOffer: pct(offers, interviewed),
      noReply: tracked.filter((a) => a.status === "Applied" && (daysSince(a.appliedOn) ?? 0) >= GHOST_DAYS).length };
  }, [apps]);

  const set = (id, patch) => setCareer((c) => ({ ...c, apps: c.apps.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const today = () => new Date().toISOString().slice(0, 10);

  if (!m.applied) return (
    <div className="note">
      Nothing applied to yet. Once applications start going out this shows your own conversion rates — and, more usefully,
      which ones have gone quiet and which are due a follow-up.
    </div>
  );

  return (
    <>
      <div className="glance">
        <div className="gtile">
          <div className="gtl">Applied</div>
          <div className="gtv">{m.applied}</div>
          <div className="gts">{m.noReply ? m.noReply + " never replied" : "all still live"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">Reached an interview</div>
          <div className="gtv" style={{ color: m.interviewed ? "var(--acc)" : undefined }}>{m.interviewed}</div>
          <div className="gts">{m.toInterview ? m.toInterview + " of applications" : "rate needs 8+ applications"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">Offers</div>
          <div className="gtv" style={{ color: m.offers ? "var(--up)" : undefined }}>{m.offers}</div>
          <div className="gts">{m.toOffer ? m.toOffer + " of interviews" : "rate needs 8+ interviews"}</div>
        </div>
        <div className="gtile">
          <div className="gtl">Turned down</div>
          <div className="gtv">{m.rejected}</div>
          <div className="gts">a "no" is data; silence isn't</div>
        </div>
      </div>

      {m.applied < 8 && (
        <div className="note">
          Percentages appear at 8 applications. Below that a single outcome swings the rate by more than ten points,
          which would make the number feel meaningful when it isn't.
        </div>
      )}

      {m.nudge.length > 0 && (
        <>
          <div className="tlabel" style={{ marginTop: 12 }}>Due a follow-up</div>
          <div className="ttable">
            {m.nudge.slice(0, showAll ? 99 : 5).map((a) => (
              <div className="ttr" key={a.id} style={{ cursor: "default", gridTemplateColumns: "1.4fr 1fr auto" }}>
                <span className="tname">{a.company}<span className="note" style={{ margin: "0 0 0 6px" }}>{a.role}</span></span>
                <span className="note mono" style={{ margin: 0 }}>{daysSince(a.appliedOn)} days ago</span>
                <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <button className="btn small" onClick={() => set(a.id, { followedUpOn: today() })}>Mark followed up</button>
                </span>
              </div>
            ))}
          </div>
          <div className="note">
            Ten days is about right — soon enough to still be a live req, late enough not to read as impatient. A short note
            to the recruiter that names one specific thing about the role beats a generic nudge.
          </div>
        </>
      )}

      {m.quiet.length > 0 && (
        <>
          <div className="tlabel" style={{ marginTop: 12 }}>Gone quiet — {GHOST_DAYS}+ days, no movement</div>
          <div className="ttable">
            {m.quiet.slice(0, showAll ? 99 : 5).map((a) => (
              <div className="ttr" key={a.id} style={{ cursor: "default", gridTemplateColumns: "1.4fr 1fr auto" }}>
                <span className="tname">{a.company}<span className="note" style={{ margin: "0 0 0 6px" }}>{a.role}</span></span>
                <span className="note mono" style={{ margin: 0 }}>{daysSince(a.appliedOn)} days</span>
                <button className="btn small" onClick={() => set(a.id, { status: "Rejected", closedReason: "no reply" })}>
                  Archive
                </button>
              </div>
            ))}
          </div>
          <div className="note">
            Archiving these isn't giving up — it's so the numbers above mean something. A board where a third of the cards
            are six weeks dead reads as a busy pipeline when it's actually a thin one, and that's the reading that stops
            people applying to more.
            {m.quiet.length > 1 && (
              <> <button className="lnk" onClick={() => m.quiet.forEach((a) => set(a.id, { status: "Rejected", closedReason: "no reply" }))}>
                Archive all {m.quiet.length}
              </button></>
            )}
          </div>
        </>
      )}

      {(m.nudge.length > 5 || m.quiet.length > 5) && (
        <div className="mrow" style={{ justifyContent: "center", marginTop: 8 }}>
          <button className="btn small" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : "Show all"}</button>
        </div>
      )}
    </>
  );
}
