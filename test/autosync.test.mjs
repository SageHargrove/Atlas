/* The background sync must be boring: due exactly when the cadence says, off
   when told, and its zero-config VAPID keys stable across restarts (a new
   pair would orphan every existing push subscription). */
import fs from "fs";
import os from "os";
import path from "path";
import { autoSyncConfig, dueForAutoSync } from "../server/autosync.js";
import { ensureVapid, pushReady } from "../server/alerts.js";
const fail = [];
let pass = 0;
const ck = (n, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + n + (d ? "  [" + d + "]" : "")); if (c) pass++; else fail.push(n); };

const NOW = Date.parse("2026-08-31T12:00:00Z");
const HOURS = 6;
const conn = { simplefin: [{ id: "c1" }] };

ck("defaults: on, every 6h", (() => { const a = autoSyncConfig({}); return a.on && a.hours === 6; })());
ck("AUTO_SYNC=0 turns it off", !autoSyncConfig({ AUTO_SYNC: "0" }).on);
ck("hours are tunable", autoSyncConfig({ AUTO_SYNC_HOURS: "3" }).hours === 3);
ck("hours are clamped to something sane",
  autoSyncConfig({ AUTO_SYNC_HOURS: "0" }).hours === 6 &&
  autoSyncConfig({ AUTO_SYNC_HOURS: "999" }).hours === 24);

ck("no connection is never due", !dueForAutoSync({ ...conn, simplefin: [] }, NOW, HOURS) && !dueForAutoSync({}, NOW, HOURS));
ck("a user who opted out is never due",
  !dueForAutoSync({ ...conn, settings: { autoSync: false }, lastSync: "2020-01-01T00:00:00Z" }, NOW, HOURS));
ck("never synced and connected is due", dueForAutoSync({ ...conn }, NOW, HOURS));
ck("a fresh sync is not due", !dueForAutoSync({ ...conn, lastSync: new Date(NOW - 3600e3).toISOString() }, NOW, HOURS));
ck("past the cadence is due", dueForAutoSync({ ...conn, lastSync: new Date(NOW - 7 * 3600e3).toISOString() }, NOW, HOURS));
ck("exactly on the cadence is due", dueForAutoSync({ ...conn, lastSync: new Date(NOW - HOURS * 3600e3).toISOString() }, NOW, HOURS));
ck("garbage lastSync counts as never synced", dueForAutoSync({ ...conn, lastSync: "someday" }, NOW, HOURS));
ck("manual and auto share the clock — a manual sync resets it",
  !dueForAutoSync({ ...conn, lastSync: new Date(NOW - 60e3).toISOString() }, NOW, HOURS));

/* ensureVapid, against the real web-push when installed (its key validation
   is part of what is being tested); on a fresh clone before npm install it
   must simply say no — never throw, never write. */
{
  let wp = null;
  try { wp = (await import("web-push")).default; } catch { /* not installed */ }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-vapid-"));
  const file = path.join(dir, "vapid.json");

  if (wp && !process.env.VAPID_PUBLIC && !process.env.VAPID_PRIVATE) {
    const gen = () => wp.generateVAPIDKeys();
    /* start from the nastiest case: a persisted file that web-push rejects.
       Recovering from it exercises generation, validation, and persistence
       in one pass — and it must not be fatal, or one corrupt file would
       keep push off forever. */
    fs.writeFileSync(file, '{"publicKey":"junk","privateKey":"junk"}');
    ck("a corrupt persisted pair is replaced, not fatal", ensureVapid(dir, gen) === true && pushReady === true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    ck("the fresh pair is persisted for the next boot", onDisk.publicKey !== "junk" && !!onDisk.privateKey);
    let calls = 0;
    ensureVapid(dir, () => { calls++; return gen(); });
    ck("once configured, nothing new is minted", calls === 0);
  } else {
    const ready = ensureVapid(dir, () => ({ publicKey: "x", privateKey: "y" }));
    /* either web-push is absent, or env VAPID keys are set (which win) */
    ck("without web-push (or with env keys) it declines quietly", ready === false || pushReady === true);
    ck("declining writes nothing", !fs.existsSync(file) || pushReady === true);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(pass + " passed, " + fail.length + " failed");
if (fail.length) process.exit(1);
