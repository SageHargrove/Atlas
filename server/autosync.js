/* Auto-sync policy: pure decisions, so the scheduler in index.js stays a dumb
   loop and this part can be tested. The principle is the same one the alert
   rules live by — the background must never surprise anyone: it syncs on a
   cadence, it backs off instead of hammering a failing bank, and one switch
   (per user, or server-wide) turns it off. */

export function autoSyncConfig(env = process.env) {
  return {
    on: env.AUTO_SYNC !== "0",
    /* hours between syncs per user; banks post a few times a day, so more
       often than hourly is pure load and less often than daily defeats the
       point of the alerts riding on it */
    hours: Math.min(24, Math.max(1, Number(env.AUTO_SYNC_HOURS) || 6)),
  };
}

/* A user is due when they have a connection, have not opted out, and their
   last sync — manual or automatic, both set lastSync — is older than the
   cadence. A user with no connection is never due, whatever their settings. */
export function dueForAutoSync(d, now = Date.now(), hours = 6) {
  if (!(d?.simplefin || []).length) return false;
  if (d.settings?.autoSync === false) return false;
  const last = Date.parse(d.lastSync || "") || 0;
  return now - last >= hours * 3600e3;
}
