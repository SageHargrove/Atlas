import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { startPolling, initCache, pollAll, requestFullPoll, pollStatus, getCache, parseBoardUrl, discoverBoard, RECOMMENDED, SEED_SOURCES, velocityFor } from "./jobs.js";
import { pushReady, publicKey, defaultSettings, evaluate, send as sendPush, bundle as bundleAlerts, ensureVapid } from "./alerts.js";
import { autoSyncConfig, dueForAutoSync } from "./autosync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DATA_DIR = process.env.DATA_DIR || __dirname;
/* data files hold financial records + bank tokens — keep the directory private (owner-only) */
try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DATA_DIR, 0o700); } catch {}
/* push works out of the box: generate + persist VAPID keys if none were configured */
ensureVapid(DATA_DIR);
const USERS_PATH = path.join(DATA_DIR, "users.json");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind one reverse proxy (Caddy) — needed for correct client IP + secure cookies
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      /* Teller withdrew its API in July 2026 and bank sync moved to SimpleFIN,
         which is server-to-server — no vendor JavaScript runs in this page at
         all now. cdn.teller.io / *.teller.io are gone from every directive:
         trusting a discontinued vendor's domain to execute script in a finance
         app is exactly the grant you want to drop the moment it stops earning
         its keep. Nothing here loads third-party code any more. */
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'"],
      "frame-src": ["'none'"],
      "frame-ancestors": ["'none'"], // this app must never be embedded in an iframe (clickjacking)
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
    },
  },
  /* COEP stays off because the stylesheet and fonts come from Google's CDN and
     are served without Cross-Origin-Resource-Policy; require-corp would block
     them and the app would render in the fallback system font. */
  crossOriginEmbedderPolicy: false,
}));
/* Body limits are per-route so that an UNAUTHENTICATED request to /api/login can't
   make us JSON.parse megabytes on the event loop. Only the two endpoints that
   legitimately carry bulk get the big limits; everything else stays small. */
app.use("/api/resume", express.json({ limit: "4mb" }));   // a PDF, base64'd
/* 6 MB, not 2 MB, so this agrees with MAX_TXNS below. At 2 MB the declared
   25,000-transaction cap was unreachable — saves started failing around 8,000
   and the user would have hit a limit the app never mentioned. Measured: real
   synced rows run ~250-330 bytes each, so 15,000 rows plus five full resumes
   and a cover letter per application lands near 5 MB. */
app.use("/api/data", express.json({ limit: "6mb" }));     // the whole finance blob
app.use(express.json({ limit: "128kb" }));
app.use(cookieParser());

/* passkey relying-party config — also reused by the Origin check below */
const RP_ID = process.env.RP_ID || "localhost";
const RP_NAME = "Atlas";
const RP_ORIGINS = (process.env.RP_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);

/* financial data must never sit in a browser/proxy cache */
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});

/* CSRF defense-in-depth on top of SameSite=Lax cookies: state-changing requests
   must come from our own origin. Same-host is accepted so a correctly-proxied
   deploy works even if RP_ORIGIN was never set; requests without an Origin
   header (curl, non-browser clients) can't ride a victim's cookie anyway. */
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host || RP_ORIGINS.includes(origin)) return next();
  } catch {}
  return res.status(403).json({ error: "Cross-origin request blocked" });
});

/* brute-force / abuse throttles (keyed by client IP via trust proxy) */
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts — wait a few minutes and try again." } });
const aiLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "AI rate limit reached — try again shortly." } });
/* each sync fans out to many bank API calls — keep it from hammering Teller */
const syncLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many syncs — wait a few minutes." } });
const quoteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Quote rate limit reached — try again shortly." } });
/* autosave fires every ~500ms while typing, so this has to be generous — it exists
   to bound disk churn from a runaway client, not to police normal use */
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: "Too many writes — pausing briefly." } });

/* ---------------- helpers ---------------- */
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
/* mode 0600: financial data + bank access tokens are readable only by the owner */
const writeJSON = (p, v) => { fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(p + ".tmp", p); };
const dataPath = (uid) => path.join(DATA_DIR, "data-" + uid + ".json");
const safeEqual = (a, b) => { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb); };

/* ---------------- write serialization ----------------
   Every read-modify-write on a file runs through a per-key queue. Without this a
   bank sync (seconds long, many API calls) and a 500ms browser autosave can
   interleave and silently clobber each other's writes — losing transactions or edits. */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn()); // run even if the previous holder failed
  const tail = run.catch(() => {});              // keep the chain alive on error
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); }); // don't leak keys
  return run;                                    // caller still sees the real result/error
}

/* Fail CLOSED: a missing file is a legitimately new user ({}), but a file that exists
   and won't parse is corruption — throw rather than silently returning {} and letting
   the caller overwrite it (which would wipe bank enrollments). */
function readData(uid) {
  const p = dataPath(uid);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const writeData = (uid, d) => writeJSON(dataPath(uid), d);

/* ---------------- users & sessions ---------------- */
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;
let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: SESSION_SECRET must be set to a long random string in production. Refusing to start with a weak/absent secret.");
    process.exit(1);
  }
  console.warn("WARNING: SESSION_SECRET is unset or short — using a random dev secret (sessions won't survive a restart). Set one in .env.");
  SECRET = crypto.randomBytes(32).toString("hex");
}
const sign = (v) => v + "." + crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function parseSession(t) {
  if (!t) return null;
  const i = t.lastIndexOf(".");
  if (i < 0) return null;
  const v = t.slice(0, i), sig = t.slice(i + 1);
  const good = crypto.createHmac("sha256", SECRET).update(v).digest("hex");
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null; } catch { return null; }
  const [uid, issued, epoch] = v.split("|");
  if (!uid) return null;
  const iat = Number(issued);
  if (!iat || Date.now() - iat > SESSION_MAX_AGE) return null; // reject expired tokens server-side
  return { uid, iat, epoch: Number(epoch) || 0 };
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/* Recovery codes are stored HMAC'd with the server secret (a "pepper"), which lives in
   .env — not in the data file. A leaked users.json alone therefore can't be brute-forced. */
const hmacCode = (s) => crypto.createHmac("sha256", SECRET).update("recovery:" + String(s)).digest("hex");

/* Per-account login backoff. The IP limiter stops one host hammering; this stops a
   distributed attack spreading guesses for a single account across many IPs.
   Swept periodically — otherwise garbage usernames from a spray attack accumulate forever. */
const acctFails = new Map(); // username -> { n, until }
setInterval(() => { const now = Date.now(); for (const [k, e] of acctFails) if (e.until < now) acctFails.delete(k); }, 30 * 60 * 1000).unref();
function acctBlocked(u) { const e = acctFails.get(u); return !!(e && e.until > Date.now()); }
function acctFail(u) {
  const e = acctFails.get(u) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= 10) { e.until = Date.now() + 15 * 60 * 1000; e.n = 0; } // 15-min cooldown
  acctFails.set(u, e);
}
const acctOk = (u) => acctFails.delete(u);

/* AES-256-GCM at-rest encryption for bank access tokens; key derived from SESSION_SECRET via HKDF */
const ENC_KEY = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(SECRET), Buffer.alloc(0), Buffer.from("cache-teller-enc"), 32));
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decSecret(s) {
  if (typeof s !== "string" || !s.startsWith("v1:")) return s; // legacy plaintext token — decrypt is a no-op
  try {
    const buf = Buffer.from(s.slice(3), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}

const users = () => readJSON(USERS_PATH, []);
const saveUsers = (all) => writeJSON(USERS_PATH, all);

/* All users.json mutations go through here so concurrent logins / passkey registrations
   can't lose each other's writes. NOTE: never call this while already inside it. */
function updateUsers(mutator) {
  return withLock("users", async () => {
    const all = users();
    const result = await mutator(all);
    saveUsers(all);
    return result;
  });
}

/* issue a signed session cookie carrying the user's current epoch (bumped by "log out everywhere"),
   and record the sign-in (time / IP / method / device) so an intruder is visible */
async function issue(res, user, req, method) {
  const epoch = await updateUsers((all) => {
    const u = all.find((x) => x.id === user.id);
    if (!u) return 0;
    u.logins = [{ at: new Date().toISOString(), ip: req.ip, method, ua: String(req.headers["user-agent"] || "").slice(0, 140) }, ...(u.logins || [])].slice(0, 25);
    return u.sessionEpoch || 0;
  });
  res.cookie("cache_session", sign(user.id + "|" + Date.now() + "|" + epoch), cookieOpts());
}
function currentUser(req) {
  const s = parseSession(req.cookies.cache_session);
  if (!s) return null;
  const u = users().find((x) => x.id === s.uid);
  if (!u) return null;
  if (s.epoch < (u.sessionEpoch || 0)) return null; // session revoked
  return u;
}
const cookieOpts = () => ({
  httpOnly: true, sameSite: "lax",
  secure: !!process.env.FORCE_SECURE_COOKIE,
  maxAge: SESSION_MAX_AGE,
});
/* Sliding renewal: sessions used to be issued once and die exactly 30 days
   later, so a person using the app daily still got logged out on day 30 for
   no visible reason. Now any authenticated request on a session older than a
   day re-issues the cookie, so only a real month of absence logs you out.
   The epoch rides along unchanged — "log out everywhere" still works,
   because currentUser above already refused a stale epoch. */
const SESSION_RENEW_AFTER = 24 * 3600 * 1000;
const auth = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not logged in" });
  req.userId = u.id;
  req.user = u;
  const s = parseSession(req.cookies.cache_session);
  if (s && Date.now() - s.iat > SESSION_RENEW_AFTER) {
    res.cookie("cache_session", sign(u.id + "|" + Date.now() + "|" + (u.sessionEpoch || 0)), cookieOpts());
  }
  next();
};

app.post("/api/register", authLimiter, async (req, res) => {
  const { username, password, invite } = req.body || {};
  const u = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,24}$/.test(u)) return res.status(400).json({ error: "Username: 3-24 chars, letters/numbers/._-" });
  if (String(password || "").length < 8 || String(password).length > 200) return res.status(400).json({ error: "Password must be 8-200 characters" });
  /* the taken-check and the insert must be atomic, or two racing signups can duplicate a username */
  const outcome = await updateUsers((all) => {
    const inviteWanted = process.env.INVITE_CODE || "";
    const bootstrap = all.length === 0; // first user needs no invite
    if (!bootstrap && (!inviteWanted || !safeEqual(invite, inviteWanted))) return { err: [403, "Valid invite code required"] };
    if (all.some((x) => x.username === u)) return { err: [409, "Username taken"] };
    const salt = crypto.randomBytes(16).toString("hex");
    const user = { id: crypto.randomUUID(), username: u, salt, hash: hashPw(password, salt), created: new Date().toISOString(), sessionEpoch: 0, credentials: [], recovery: [], logins: [] };
    all.push(user);
    return { user, bootstrap };
  });
  if (outcome.err) return res.status(outcome.err[0]).json({ error: outcome.err[1] });
  /* adopt legacy single-user data.json for the very first account */
  const legacy = path.join(__dirname, "data.json");
  if (outcome.bootstrap && fs.existsSync(legacy) && !fs.existsSync(dataPath(outcome.user.id))) fs.copyFileSync(legacy, dataPath(outcome.user.id));
  await issue(res, outcome.user, req, "password");
  res.json({ ok: true, username: u });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const u = String(req.body.username || "").trim().toLowerCase();
  if (acctBlocked(u)) return res.status(429).json({ error: "Too many failed attempts for this account — try again in 15 minutes." });
  const user = users().find((x) => x.username === u);
  const bad = () => { acctFail(u); return res.status(401).json({ error: "Wrong username or password" }); };
  if (!user) { hashPw("x", "deadbeef"); return bad(); } // constant-ish time
  const h = hashPw(String(req.body.password || ""), user.salt);
  try { if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.hash))) return bad(); } catch { return bad(); }
  /* passkey-only mode: even a CORRECT password is refused (checked after verification
     so this path leaks nothing an attacker couldn't learn from a normal wrong-password try) */
  if (user.passwordDisabled) { acctOk(u); return res.status(403).json({ error: "Password sign-in is turned off for this account — use your passkey, or a recovery code." }); }
  acctOk(u);
  await issue(res, user, req, "password");
  res.json({ ok: true, username: u });
});

/* passkey-only mode: turning the password OFF requires a passkey + unused recovery
   codes on file, or one lost device would mean permanent lockout */
app.post("/api/security/password-login", auth, async (req, res) => {
  const enable = !!req.body.enabled;
  if (!enable) {
    if (!(req.user.credentials || []).length) return res.status(400).json({ error: "Add a passkey first." });
    if (!(req.user.recovery || []).some((r) => !r.used)) return res.status(400).json({ error: "Generate recovery codes first — they're your backup if the passkey is lost." });
  }
  await updateUsers((all) => {
    const u = all.find((x) => x.id === req.user.id);
    if (u) u.passwordDisabled = !enable;
  });
  res.json({ ok: true, passwordDisabled: !enable });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("cache_session", { httpOnly: true, sameSite: "lax", secure: !!process.env.FORCE_SECURE_COOKIE, path: "/" });
  res.json({ ok: true });
});

/* change password: requires the current password, then invalidates every other
   session (a stolen cookie dies with the old password) while keeping this device in */
app.post("/api/password", auth, authLimiter, async (req, res) => {
  const current = String(req.body.current || ""), next = String(req.body.next || "");
  if (next.length < 8 || next.length > 200) return res.status(400).json({ error: "New password must be 8-200 characters" });
  const h = hashPw(current, req.user.salt);
  try { if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(req.user.hash))) return res.status(401).json({ error: "Current password is wrong" }); }
  catch { return res.status(401).json({ error: "Current password is wrong" }); }
  const user = await updateUsers((all) => {
    const u = all.find((x) => x.id === req.user.id);
    if (!u) return null;
    u.salt = crypto.randomBytes(16).toString("hex");
    u.hash = hashPw(next, u.salt);
    u.sessionEpoch = (u.sessionEpoch || 0) + 1;
    return u;
  });
  if (!user) return res.status(500).json({ error: "Could not update password" });
  await issue(res, user, req, "password-change");
  res.json({ ok: true });
});

/* Delete the account and everything attached to it. Requires the current
   password AND the username typed back, because this is the one action in the
   app with no undo — the encrypted nightly backup is the only copy afterwards,
   and it rotates out in a week.

   The user record goes first on purpose: with no record, no session can ever
   name those files again, so the data is unreachable the instant that write
   lands even if the unlinks below fail. Password sign-in being switched off
   does not remove the hash, so this works for passkey-only accounts too. */
app.post("/api/account/delete", auth, authLimiter, async (req, res) => {
  const confirm = String(req.body?.username || "").trim().toLowerCase();
  if (confirm !== String(req.user.username || "").toLowerCase())
    return res.status(400).json({ error: "Type your username exactly to confirm." });
  const h = hashPw(String(req.body?.password || ""), req.user.salt);
  try { if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(req.user.hash))) return res.status(401).json({ error: "Password is wrong" }); }
  catch { return res.status(401).json({ error: "Password is wrong" }); }

  const uid = req.user.id;
  try {
    await updateUsers((all) => {
      const i = all.findIndex((x) => x.id === uid);
      if (i !== -1) all.splice(i, 1);
    });
  } catch (e) {
    console.error("account delete failed:", e.message);
    return res.status(500).json({ error: "Could not delete the account — nothing was removed." });
  }

  /* Best effort from here: the account is already gone. Anything left behind is
     unreachable, but it is still your name and your balances sitting on a disk,
     so a failure gets logged loudly rather than swallowed. */
  const leftovers = [];
  const tryRm = (p) => { try { fs.rmSync(p, { force: true }); } catch (e) { leftovers.push(path.basename(p) + " (" + e.code + ")"); } };
  tryRm(dataPath(uid));
  tryRm(dataPath(uid) + ".tmp");
  for (let s = 1; s <= MAX_RESUME_SLOTS; s++) { tryRm(resumePath(uid, s)); tryRm(resumePath(uid, s) + ".tmp"); }
  if (leftovers.length) console.error("account " + uid + " deleted but files remain:", leftovers.join(", "));

  res.clearCookie("cache_session", { httpOnly: true, sameSite: "lax", secure: !!process.env.FORCE_SECURE_COOKIE, path: "/" });
  res.json({ ok: true, filesRemaining: leftovers.length });
});

/* ---------------- passkeys (WebAuthn) ---------------- */
const challenges = new Map(); // short-lived ceremony challenges: key -> { challenge, exp }
const putChallenge = (k, ch) => challenges.set(k, { challenge: ch, exp: Date.now() + 5 * 60 * 1000 });
const takeChallenge = (k) => { const e = challenges.get(k); challenges.delete(k); return e && e.exp > Date.now() ? e.challenge : null; };
/* sweep abandoned ceremonies so the map can't grow without bound */
setInterval(() => { const now = Date.now(); for (const [k, e] of challenges) if (e.exp <= now) challenges.delete(k); }, 5 * 60 * 1000).unref();

/* register a passkey to the logged-in account */
app.post("/api/webauthn/register/options", auth, async (req, res) => {
  const u = req.user;
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userID: new TextEncoder().encode(u.id), userName: u.username, userDisplayName: u.username,
    attestationType: "none",
    excludeCredentials: (u.credentials || []).map((c) => ({ id: c.id, transports: c.transports })),
    /* "required": the device must verify it's really you (biometric/PIN) — matches the
       server-side enforcement below, so a no-PIN key fails early instead of confusingly late */
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  putChallenge("reg:" + u.id, opts.challenge);
  res.json(opts);
});
app.post("/api/webauthn/register/verify", auth, async (req, res) => {
  const expectedChallenge = takeChallenge("reg:" + req.user.id);
  if (!expectedChallenge) return res.status(400).json({ error: "Challenge expired — try again" });
  let v;
  try { v = await verifyRegistrationResponse({ response: req.body.cred, expectedChallenge, expectedOrigin: RP_ORIGINS, expectedRPID: RP_ID, requireUserVerification: true }); }
  catch { return res.status(400).json({ error: "Passkey verification failed" }); }
  if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: "Passkey not verified" });
  const cred = v.registrationInfo.credential;
  await updateUsers((all) => {
    const user = all.find((x) => x.id === req.user.id);
    if (!user) return;
    user.credentials = user.credentials || [];
    if (!user.credentials.some((c) => c.id === cred.id))
      user.credentials.push({ id: cred.id, publicKey: Buffer.from(cred.publicKey).toString("base64url"), counter: cred.counter || 0, transports: cred.transports || [], name: String(req.body.label || "Passkey").slice(0, 40), added: new Date().toISOString() });
  });
  res.json({ ok: true });
});
/* log in with a passkey */
app.post("/api/webauthn/auth/options", authLimiter, async (req, res) => {
  const uname = String(req.body.username || "").trim().toLowerCase();
  /* same shape registration enforces — this string becomes a Map key below, so
     an unbounded one is free memory for an attacker */
  if (!/^[a-z0-9_.-]{3,24}$/.test(uname)) return res.status(400).json({ error: "Enter your username first" });
  const user = users().find((x) => x.username === uname);
  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: (user?.credentials || []).map((c) => ({ id: c.id, transports: c.transports })), // empty for unknown user — avoids enumeration
    userVerification: "required",
  });
  putChallenge("auth:" + uname, opts.challenge);
  res.json(opts);
});
app.post("/api/webauthn/auth/verify", authLimiter, async (req, res) => {
  const uname = String(req.body.username || "").trim().toLowerCase();
  if (acctBlocked(uname)) return res.status(429).json({ error: "Too many failed attempts for this account — try again in 15 minutes." });
  const expectedChallenge = takeChallenge("auth:" + uname);
  if (!expectedChallenge) return res.status(400).json({ error: "Challenge expired — try again" });
  const user = users().find((x) => x.username === uname);
  const cred = user?.credentials?.find((c) => c.id === (req.body.cred?.id));
  if (!user || !cred) { acctFail(uname); return res.status(401).json({ error: "Passkey not recognized" }); }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: req.body.cred, expectedChallenge, expectedOrigin: RP_ORIGINS, expectedRPID: RP_ID,
      requireUserVerification: true, // biometric/PIN mandatory — a stolen unlocked key isn't enough
      credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, "base64url"), counter: cred.counter, transports: cred.transports },
    });
  } catch { acctFail(uname); return res.status(401).json({ error: "Passkey verification failed" }); }
  if (!v.verified) { acctFail(uname); return res.status(401).json({ error: "Passkey not verified" }); }
  acctOk(uname);
  /* persist the signature counter (clone-detection) under the lock */
  await updateUsers((all) => {
    const c = all.find((x) => x.id === user.id)?.credentials?.find((c2) => c2.id === cred.id);
    if (c) c.counter = v.authenticationInfo.newCounter;
  });
  await issue(res, user, req, "passkey");
  res.json({ ok: true, username: user.username });
});
app.delete("/api/webauthn/:id", auth, async (req, res) => {
  await updateUsers((all) => {
    const user = all.find((x) => x.id === req.user.id);
    if (user) user.credentials = (user.credentials || []).filter((c) => c.id !== req.params.id);
  });
  res.json({ ok: true });
});

/* ---------------- recovery codes ---------------- */
/* 96-bit codes (was 40-bit): even if users.json leaked, these are not brute-forceable.
   Displayed grouped for easy transcription; grouping is stripped on entry. */
const newRecoveryCode = () => crypto.randomBytes(12).toString("hex").match(/.{1,4}/g).join("-");
app.post("/api/recovery/generate", auth, async (req, res) => {
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  await updateUsers((all) => {
    const user = all.find((x) => x.id === req.user.id);
    if (user) user.recovery = codes.map((c) => ({ v: 2, h: hmacCode(c.replace(/-/g, "")), used: false })); // only peppered hashes stored
  });
  res.json({ codes });
});
app.post("/api/login/recovery", authLimiter, async (req, res) => {
  const uname = String(req.body.username || "").trim().toLowerCase();
  const code = String(req.body.code || "").toLowerCase().replace(/[^a-f0-9]/g, "");
  if (acctBlocked(uname)) return res.status(429).json({ error: "Too many failed attempts for this account — try again in 15 minutes." });
  /* find + mark-used atomically, so the same code can't be redeemed twice concurrently */
  const outcome = await updateUsers((all) => {
    const user = all.find((x) => x.username === uname);
    if (!user || !user.recovery?.length) { hmacCode("x"); return null; }
    const h2 = hmacCode(code), h1 = sha256(code); // h1: legacy pre-upgrade codes
    const rec = user.recovery.find((r) => !r.used && (r.v === 2 ? safeEqual(r.h, h2) : safeEqual(r.hash || "", h1)));
    if (!rec) return null;
    rec.used = true;
    return { user, remaining: user.recovery.filter((r) => !r.used).length };
  });
  if (!outcome) { acctFail(uname); return res.status(401).json({ error: "Invalid username or recovery code" }); }
  acctOk(uname);
  await issue(res, outcome.user, req, "recovery");
  res.json({ ok: true, username: outcome.user.username, remaining: outcome.remaining });
});

/* ---------------- session + device management ---------------- */
app.get("/api/security", auth, (req, res) => {
  const u = req.user;
  res.json({
    logins: (u.logins || []).slice(0, 15),
    passkeys: (u.credentials || []).map((c) => ({ id: c.id, name: c.name, added: c.added })),
    recoveryRemaining: (u.recovery || []).filter((r) => !r.used).length,
    passwordDisabled: !!u.passwordDisabled,
  });
});
app.post("/api/logout-all", auth, async (req, res) => {
  const user = await updateUsers((all) => {
    const u = all.find((x) => x.id === req.user.id);
    if (u) u.sessionEpoch = (u.sessionEpoch || 0) + 1; // every existing cookie is now invalid
    return u;
  });
  await issue(res, user, req, "session-revoke"); // keep the device that clicked signed in
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  res.json({
    authed: !!u, username: u?.username || null,
    canRegister: users().length === 0 || !!process.env.INVITE_CODE,
    passkeys: (u?.credentials || []).length,
    recoveryRemaining: (u?.recovery || []).filter((r) => !r.used).length,
  });
});

app.get("/api/config", auth, (req, res) => res.json({
  aiEnabled: !!process.env.ANTHROPIC_API_KEY,
}));

/* ---------------- per-user data ---------------- */
app.get("/api/data", auth, (req, res) => {
  let d;
  try { d = readData(req.userId); } // corrupted file → error, never a silent empty state
  catch (e) { console.error("data read failed for", req.userId, e.message); return res.status(500).json({ error: "Could not read your data file" }); }
  const rev = d._rev || 0;
  if (!Object.keys(d).length) return res.json({ data: null, rev: 0 }); // brand-new user
  /* bank access tokens never leave the server — strip them from the browser payload.
     For SimpleFIN the access URL embeds basic-auth credentials, so it is the secret. */
  if (Array.isArray(d.teller)) d.teller = d.teller.map(({ accessToken, ...rest }) => rest);
  if (Array.isArray(d.simplefin)) d.simplefin = d.simplefin.map(({ accessToken, ...rest }) => rest);
  delete d._rev; // rev travels beside the data, not inside it
  res.json({ data: d, rev });
});
/* Chosen so it actually fits under the 6 MB body limit alongside five resumes
   and a cover letter per application — a cap the request can never reach is not
   a cap, it just turns into an unexplained failure years later. At a typical
   couple hundred synced rows a year this is many decades of history. */
const MAX_TXNS = 15000;

app.put("/api/data", auth, writeLimiter, async (req, res) => {
  const d = req.body?.data;
  if (d === null || d === undefined || typeof d !== "object" || Array.isArray(d)) return res.status(400).json({ error: "Invalid data payload" });
  /* the client renders these as arrays — refuse a payload that would corrupt them */
  for (const k of ["accounts", "txns", "cats", "goals", "recurring", "purchases", "history"])
    if (k in d && !Array.isArray(d[k])) return res.status(400).json({ error: "Invalid data payload (" + k + ")" });
  /* the sync merge is quadratic in txns, so an absurd array would pin the event
     loop for every user on this server, not just the one who sent it */
  if (Array.isArray(d.txns) && d.txns.length > MAX_TXNS)
    return res.status(413).json({ error: "Too many transactions (" + MAX_TXNS.toLocaleString("en-US") + " max)" });
  if (d.settings != null && (typeof d.settings !== "object" || Array.isArray(d.settings))) return res.status(400).json({ error: "Invalid data payload (settings)" });
  if (d.invest != null && (typeof d.invest !== "object" || Array.isArray(d.invest))) return res.status(400).json({ error: "Invalid data payload (invest)" });
  if (d.career != null && (typeof d.career !== "object" || Array.isArray(d.career))) return res.status(400).json({ error: "Invalid data payload (career)" });
  if (d.tax != null && (typeof d.tax !== "object" || Array.isArray(d.tax))) return res.status(400).json({ error: "Invalid data payload (tax)" });
  try {
    let conflictRev = null, newRev = 0;
    await withLock("data:" + req.userId, () => {
      /* bank enrollments are server-authoritative — the browser can't add, alter, or erase
         them via autosave. If the existing file is corrupt, readData throws and we abort
         rather than overwriting it with a token-less copy. */
      const existing = readData(req.userId);
      /* optimistic concurrency: a save based on a stale revision (another device wrote
         since this client last loaded) is refused instead of silently clobbering it */
      const cur = existing._rev || 0;
      if ((Number(req.body.rev) || 0) !== cur) { conflictRev = cur; return; }
      d.teller = existing.teller || [];
      d.simplefin = existing.simplefin || []; // server-authoritative; autosave can't touch credentials
      d._rev = newRev = cur + 1;
      writeData(req.userId, d);
    });
    if (conflictRev !== null) return res.status(409).json({ error: "Saved from another device since you loaded — refreshing.", rev: conflictRev });
    res.json({ ok: true, rev: newRev });
  } catch (e) { console.error("data write failed for", req.userId, e.message); res.status(500).json({ error: "Could not save — your existing data was left untouched" }); }
});

/* ---------------- resume file (Career tab) ----------------
   The PDF is stored as bytes next to the data file (0600, same private dir)
   rather than base64 inside it — a 400KB resume would otherwise be re-sent on
   every 500ms autosave. The extracted TEXT lives in the data blob, because
   that is what the AI reads and what the user edits. */
/* Several resumes per user, addressed by SLOT NUMBER rather than by a name the
   client chooses — an integer 1..5 can't traverse a path no matter what is sent.
   Slot 1 deliberately keeps the original filename so existing uploads migrate
   with no copying. */
const MAX_RESUME_SLOTS = 5;
/* Match the digits before converting. Number() alone accepts " 1", "1e0" and
   "\n1" as 1 — harmless here since the path is built from the integer, but a
   validator whose accepted set isn't obvious to a reader is a bad validator. */
const resumeSlot = (v) => {
  if (!/^[0-9]{1,2}$/.test(String(v))) return null;
  const n = Number(v);
  return n >= 1 && n <= MAX_RESUME_SLOTS ? n : null;
};
const resumePath = (uid, slot = 1) => path.join(DATA_DIR, "resume-" + uid + (slot > 1 ? "-" + slot : "") + ".pdf");
const MAX_RESUME_BYTES = 2.5 * 1024 * 1024;

app.put("/api/resume/:slot?", auth, writeLimiter, (req, res) => {
  const slot = req.params.slot === undefined ? 1 : resumeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: "Bad resume slot" });
  const b64 = String(req.body?.pdf || "");
  if (!b64) return res.status(400).json({ error: "No file received" });
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch { return res.status(400).json({ error: "Could not read that file" }); }
  if (!buf.length) return res.status(400).json({ error: "That file is empty" });
  if (buf.length > MAX_RESUME_BYTES) return res.status(413).json({ error: "Resume must be under 2.5 MB" });
  /* trust the bytes, not the filename — this is written to disk and served back */
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return res.status(400).json({ error: "That doesn't look like a PDF" });
  try {
    fs.writeFileSync(resumePath(req.userId, slot) + ".tmp", buf, { mode: 0o600 });
    fs.renameSync(resumePath(req.userId, slot) + ".tmp", resumePath(req.userId, slot));
    res.json({ ok: true, bytes: buf.length, slot });
  } catch (e) { console.error("resume write failed:", e.message); res.status(500).json({ error: "Could not save the resume" }); }
});

/* stream.pipe() attaches an error handler to the DESTINATION only — an error on
   the read stream would be unhandled and take the whole process down with it.
   (Reproduced: delete the file between the exists-check and the open, or point
   the path at anything unreadable, and the server exits.) So: no exists-check
   race, headers only once the file is actually open, and the fd released if the
   client walks away mid-download. */
app.get("/api/resume/:slot?", auth, (req, res) => {
  const slot = req.params.slot === undefined ? 1 : resumeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: "Bad resume slot" });
  const stream = fs.createReadStream(resumePath(req.userId, slot));
  stream.once("open", () => {
    res.type("application/pdf");
    res.set("Content-Disposition", 'inline; filename="resume.pdf"');
    stream.pipe(res);
  });
  stream.on("error", (e) => {
    if (e.code !== "ENOENT") console.error("resume read failed:", e.code || e.message);
    if (res.headersSent) return res.destroy();
    res.status(e.code === "ENOENT" ? 404 : 500)
      .json({ error: e.code === "ENOENT" ? "No resume uploaded" : "Could not read the resume" });
  });
  res.on("close", () => stream.destroy());
});

app.delete("/api/resume/:slot?", auth, (req, res) => {
  const slot = req.params.slot === undefined ? 1 : resumeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: "Bad resume slot" });
  try { fs.rmSync(resumePath(req.userId, slot), { force: true }); res.json({ ok: true }); }
  catch (e) { console.error("resume delete failed:", e.message); res.status(500).json({ error: "Could not remove the resume" }); }
});

/* ---------------- job discovery ----------------
   Postings are public and identical for every user, so the cache is shared and
   the poll runs once for the whole server rather than once per person. Extra
   employers a user adds are stored in that user's own file but contribute their
   board to the shared poll — one person adding Entergy finds it for everyone. */
const extraSources = () => {
  const out = [], seen = new Set(SEED_SOURCES.map((s) => s.company.toLowerCase()));
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.startsWith("data-") || !f.endsWith(".json")) continue;
      const d = readJSON(path.join(DATA_DIR, f), null);
      for (const s of d?.career?.settings?.boards || []) {
        const k = String(s.company || "").toLowerCase();
        if (!k || seen.has(k) || !s.kind) continue;
        seen.add(k); out.push(s);
      }
    }
  } catch (e) { console.error("extra job sources unreadable:", e.message); }
  return out.slice(0, 60); // a bounded poll, whatever anyone adds
};

/* Federal contract exposure. For a defence or health-IT employer, contract
   expiry IS the layoff calendar — a recompete they lose takes the team with it,
   and that is knowable months ahead from a free government API. Cached per
   company for a day; USAspending is public data and generous, but there is no
   reason to ask it the same question repeatedly. */
const AWARD_CACHE = new Map();
app.get("/api/company/contracts", auth, quoteLimiter, async (req, res) => {
  const name = String(req.query.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "No company given" });
  const hit = AWARD_CACHE.get(name.toLowerCase());
  if (hit && Date.now() - hit.at < 864e5) return res.json(hit.data);
  try {
    const r = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        filters: { award_type_codes: ["A", "B", "C", "D"], recipient_search_text: [name],
          time_period: [{ start_date: new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10),
            end_date: new Date(Date.now() + 5 * 365 * 864e5).toISOString().slice(0, 10) }] },
        fields: ["Award Amount", "Recipient Name", "End Date", "Awarding Agency", "Description"],
        limit: 40, page: 1, sort: "Award Amount", order: "desc" }),
    });
    if (!r.ok) throw new Error("USAspending " + r.status);
    const j = await r.json();
    const rows = (j.results || []).map((x) => ({
      amount: Number(x["Award Amount"]) || 0, recipient: x["Recipient Name"] || "",
      end: x["End Date"] || "", agency: x["Awarding Agency"] || "" }))
      .filter((x) => x.amount > 0);
    const total = rows.reduce((s2, x) => s2 + x.amount, 0);
    const soon = rows.filter((x) => x.end && Date.parse(x.end) > Date.now()
      && Date.parse(x.end) < Date.now() + 365 * 864e5).sort((a, b) => a.end.localeCompare(b.end));
    const data = { name, count: rows.length, total, top: rows.slice(0, 5),
      expiringWithinAYear: soon.slice(0, 5),
      atRisk: soon.reduce((s2, x) => s2 + x.amount, 0) };
    AWARD_CACHE.set(name.toLowerCase(), { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error("usaspending failed:", e.message);
    res.status(502).json({ error: "Could not reach USAspending right now" });
  }
});

app.get("/api/jobs", auth, (req, res) => {
  const c = getCache();
  /* 30-day hiring direction per employer, computed from the velocity samples the
     poller now keeps. A freeze shows on a company's own board weeks before any
     announcement — the data was already being fetched; this makes it visible. */
  const velocity = {};
  for (const company of new Set((c.jobs || []).map((j) => j.company))) {
    const v = velocityFor(company);
    if (v && Math.abs(v.delta) >= 3) velocity[company] = v;
  }
  res.json({ jobs: c.jobs || [], lastRun: c.lastRun || null, added: c.added || 0, closed: c.closed || 0,
    sources: c.sources || {}, seeded: SEED_SOURCES.map((s) => s.company), velocity });
});

/* Manual refresh is heavily rate limited: it fans out to ~20 third-party APIs,
   and hammering someone else's board is how you get blocked for everyone. */
const refreshLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 4, standardHeaders: true, legacyHeaders: false,
  message: { error: "Refresh is limited to 4 per hour — the boards update a few times a day at most." } });
app.post("/api/jobs/refresh", auth, refreshLimiter, (req, res) => {
  try { res.json(requestFullPoll(extraSources())); }
  catch (e) { console.error("manual poll failed:", e.message); res.status(502).json({ error: "Could not reach the job boards right now" }); }
});

/* Cheap, unlimited: the client polls this while a sweep runs so the button can
   say "checking Boeing - 34 of 72" instead of freezing for four minutes. */
app.get("/api/jobs/status", auth, (req, res) => res.json(pollStatus()));

/* ---------------- push alerts ----------------
   Read-modify-write under the same "data:<uid>" lock every other writer uses,
   so an alert run and a browser autosave can never interleave and lose one of
   the two. Returning false from the mutator skips the write entirely, which is
   the common case: most alert runs find nothing new. */
function mutateUser(uid, fn) {
  return withLock("data:" + uid, () => {
    const d = readData(uid);
    const out = fn(d);
    if (out === false) return out;
    d._rev = (d._rev || 0) + 1;
    writeData(uid, d);
    return out;
  });
}

const pushTestLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: "That's a lot of test notifications — wait a few minutes." } });

app.get("/api/push/key", auth, (req, res) => {
  const d = readData(req.userId);
  res.json({
    ready: pushReady,
    key: pushReady ? publicKey() : "",
    devices: (d.push || []).length,
    settings: { ...defaultSettings(), ...(d.alerts?.settings || {}) },
  });
});

/* Subscribing runs the rules ONCE in silent mode. Without that, turning
   notifications on would immediately fire every paycheck and every large charge
   already in your history, which is the fastest possible way to get the whole
   feature muted. */
app.post("/api/push/subscribe", auth, async (req, res) => {
  if (!pushReady) return res.status(503).json({ error: "Push isn't configured on this server (VAPID keys missing)" });
  const sub = req.body?.sub;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "That subscription is missing its keys" });
  }
  try {
    await mutateUser(req.userId, (d) => {
      d.push = [...(d.push || []).filter((x) => x.endpoint !== sub.endpoint),
        { endpoint: sub.endpoint, keys: sub.keys, ua: String(req.get("user-agent") || "").slice(0, 120), added: new Date().toISOString() }]
        .slice(-8);
      d.alerts = { ...(d.alerts || {}), settings: { ...defaultSettings(), ...(d.alerts?.settings || {}), on: true } };
      const { state } = evaluate(d, { silent: true });   // baseline, sends nothing
      d.alerts = state;
    });
    res.json({ ok: true });
  } catch (e) { console.error("subscribe failed:", e.message); res.status(500).json({ error: "Could not save that device" }); }
});

app.post("/api/push/unsubscribe", auth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  try {
    await mutateUser(req.userId, (d) => {
      d.push = (d.push || []).filter((x) => x.endpoint !== endpoint);
      if (!d.push.length) d.alerts = { ...(d.alerts || {}), settings: { ...(d.alerts?.settings || {}), on: false } };
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not remove that device" }); }
});

app.put("/api/push/settings", auth, async (req, res) => {
  const body = req.body?.settings || {};
  try {
    let out;
    await mutateUser(req.userId, (d) => {
      const next = { ...defaultSettings(), ...(d.alerts?.settings || {}) };
      for (const k of ["paid", "low", "big", "sub", "budget", "bill"]) if (k in body) next[k] = !!body[k];
      for (const [k, lo, hi] of [["paidAt", 0, 1000000], ["bigAt", 1, 1000000], ["billDays", 1, 14], ["billBig", 0, 1000000]]) {
        if (k in body) next[k] = Math.max(lo, Math.min(hi, Number(body[k]) || 0));
      }
      if ("lowTiers" in body) {
        const t = (Array.isArray(body.lowTiers) ? body.lowTiers : String(body.lowTiers || "").split(","))
          .map((x) => Math.round(Number(x) || 0)).filter((x) => x > 0 && x < 1000000);
        next.lowTiers = [...new Set(t)].sort((a, b) => b - a).slice(0, 5);
      }
      d.alerts = { ...(d.alerts || {}), settings: next };
      /* Re-baseline: loosening a threshold must not retro-fire on old rows. */
      const { state } = evaluate(d, { silent: true });
      d.alerts = state;
      out = next;
    });
    res.json({ ok: true, settings: out });
  } catch (e) { res.status(500).json({ error: "Could not save those settings" }); }
});

app.post("/api/push/test", auth, pushTestLimiter, async (req, res) => {
  const d = readData(req.userId);
  if (!(d.push || []).length) return res.status(400).json({ error: "No device is subscribed yet" });
  const { sent, dead } = await sendPush(d.push, { title: "Atlas is set up", body: "Alerts will arrive here.", tag: "test" });
  if (dead.length) await mutateUser(req.userId, (u) => { u.push = (u.push || []).filter((x) => !dead.includes(x.endpoint)); });
  res.json({ ok: true, sent });
});

/* Run the rules for one user and deliver whatever is new. Called after a sync
   (new transactions are the main source of alerts) and by the daily sweep. */
async function runAlerts(uid) {
  let payloadAlerts = null;
  let subs = [];
  await mutateUser(uid, (d) => {
    if (!d.alerts?.settings?.on || !(d.push || []).length) return false;
    const { alerts, state } = evaluate(d);
    d.alerts = state;
    if (alerts.length) { payloadAlerts = alerts; subs = d.push; }
  });
  if (!payloadAlerts) return 0;
  const { sent, dead } = await sendPush(subs, bundleAlerts(payloadAlerts));
  if (dead.length) {
    await mutateUser(uid, (d) => { d.push = (d.push || []).filter((x) => !dead.includes(x.endpoint)); });
  }
  return sent;
}

/* Employers worth adding that Atlas does not already poll. Anything already
   seeded or already added by this user is filtered out, so the list only ever
   shows real gaps rather than things that are quietly already covered. */
app.get("/api/jobs/recommended", auth, async (req, res) => {
  try {
    const d = readData(req.userId);
    const mine = new Set([...(d?.career?.settings?.boards || []).map((b) => String(b.company || "").toLowerCase()),
      ...SEED_SOURCES.map((s) => String(s.company).toLowerCase())]);
    /* a company you already track as a target still counts as a gap if we have
       no board for it - that is exactly the case worth surfacing */
    res.json({ items: RECOMMENDED.filter((r) => !mine.has(r.company.toLowerCase())) });
  } catch (e) { res.status(500).json({ error: "Could not build recommendations" }); }
});

/* Resolve ONE employer on demand, so the recommendations list can try the
   careers-page pass per row instead of making you wait on all of them.
   Deliberately NOT on refreshLimiter: that budget is four per hour because a
   sweep hits ninety-five boards, whereas this touches one company's own site.
   Sharing it made the fourth click on a list of forty rows fail with a rate
   limit, which reads as the feature being broken. */
const resolveLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: "That's a lot of lookups in one hour — give it a few minutes." } });
app.post("/api/jobs/resolve", auth, resolveLimiter, async (req, res) => {
  const company = String(req.body?.company || "").slice(0, 60).trim();
  const site = String(req.body?.site || "").slice(0, 80).trim() || undefined;
  if (!company) return res.status(400).json({ error: "No company given" });
  try {
    const board = await discoverBoard(company, site);
    res.json(board ? { found: true, board } : { found: false });
  } catch (e) { res.status(502).json({ error: "Could not reach that employer's site" }); }
});

/* Turn a pasted careers link into a board adapter. Guessing a Workday tenant
   fails ~80% of the time; the URL states it exactly. */
app.post("/api/jobs/parse-board", auth, (req, res) => {
  const parsed = parseBoardUrl(String(req.body?.url || ""));
  if (!parsed) return res.status(400).json({
    error: "That link isn't a board Atlas can read. It needs to be a Greenhouse, Lever, Ashby or Workday careers URL — open the company's job listings and copy the address bar.",
  });
  res.json({ ok: true, board: parsed });
});

/* Coverage is the real ceiling on this whole feature: 40 boards against 100+
   tracked companies. Guessing tokens by hand found 3 of 15 Workday tenants.
   This tries the cheap deterministic guesses first and only spends an AI call
   on what's left — and every candidate is PROVEN by fetching it before being
   offered, so a hallucinated tenant can't enter the registry. */
const slugs = (name) => {
  const base = String(name).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, "and")
    .replace(/\b(inc|llc|corp|corporation|company|co|group|technologies|technology|systems|solutions|security|identity)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const words = base.split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...new Set([words.join(""), words.join("-"), words[0], words.slice(0, 2).join("")])].filter((s) => s.length >= 3);
};
const proveBoard = async (b) => {
  try {
    const { kind, token, tenant, wd, site } = b;
    let url, opts = { headers: { accept: "application/json", "user-agent": "atlas-job-finder/1.0" }, signal: AbortSignal.timeout(9000) };
    if (kind === "greenhouse") url = "https://boards-api.greenhouse.io/v1/boards/" + token + "/jobs";
    else if (kind === "lever") url = "https://api.lever.co/v0/postings/" + token + "?mode=json";
    else if (kind === "ashby") url = "https://api.ashbyhq.com/posting-api/job-board/" + token;
    else if (kind === "workday") {
      url = "https://" + tenant + "." + (wd || "wd1") + ".myworkdayjobs.com/wday/cxs/" + tenant + "/" + site + "/jobs";
      opts = { ...opts, method: "POST", headers: { ...opts.headers, "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: "security" }) };
    } else return 0;
    const r = await fetch(url, opts);
    if (!r.ok) return 0;
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.jobs || j.jobPostings || [];
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
};

app.post("/api/jobs/discover", auth, refreshLimiter, async (req, res) => {
  const names = (Array.isArray(req.body?.companies) ? req.body.companies : [])
    .map((s) => String(s || "").slice(0, 60).trim()).filter(Boolean).slice(0, 12);
  if (!names.length) return res.status(400).json({ error: "No companies given" });

  /* discoverBoard does the guessing pass AND, when that fails, reads the
     employer's own careers page and takes the board it links to. That second
     pass is the whole point: guessing alone found 24 of 95 employers, reading
     the page found 13 more that guessing could never have reached, Simeio and
     Optiv among them. It covers seven ATS vendors, not three. */
  const found = [], unresolved = [];
  for (const name of names) {
    let hit = null;
    try { hit = await discoverBoard(name); } catch { /* a miss is not an error */ }
    (hit ? found : unresolved).push(hit || name);
  }

  /* Only the leftovers cost a model call, and its answer is still verified. */
  let asked = 0;
  if (unresolved.length && process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await callAnthropic(
        "For each company, find the URL of its PUBLIC job board if it uses Greenhouse, Lever, Ashby or Workday. " +
        "Companies: " + unresolved.join("; ") +
        '\n\nRespond with ONLY JSON, no fences: [{"company": string, "url": string}]. ' +
        "The url must be the careers/job-listings page (e.g. https://job-boards.greenhouse.io/token, https://jobs.lever.co/token, " +
        "https://jobs.ashbyhq.com/token, or https://TENANT.wdN.myworkdayjobs.com/en-US/SITE). " +
        "Omit any company you cannot find one for. Do not guess.", true, req.userId);
      asked = unresolved.length;
      const arr = JSON.parse(String(text).replace(/```json|```/g, "").trim().match(/\[[\s\S]*\]/)?.[0] || "[]");
      for (const row of Array.isArray(arr) ? arr.slice(0, 12) : []) {
        const b = parseBoardUrl(String(row?.url || ""));
        if (!b) continue;
        const n = await proveBoard(b);
        if (n > 0) found.push({ company: String(row.company || "").slice(0, 60) || "Unknown", ...b, postings: n });
      }
    } catch (e) { console.error("board discovery AI step failed:", e.message); }
  }

  const gotNames = new Set(found.map((f) => f.company.toLowerCase()));
  res.json({ found, stillMissing: names.filter((n) => !gotNames.has(n.toLowerCase())), aiTried: asked });
});

/* Public GitHub repos, proxied. Doing this from the page would mean widening
   connect-src past 'self' and handing the user's IP to GitHub for a read of
   public data. No token: unauthenticated is enough for public repos. */
app.get("/api/github/repos", auth, quoteLimiter, async (req, res) => {
  const user = String(req.query.user || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) return res.status(400).json({ error: "That isn't a valid GitHub username" });
  try {
    const r = await fetch("https://api.github.com/users/" + user + "/repos?sort=pushed&per_page=100", {
      headers: { accept: "application/vnd.github+json", "user-agent": "atlas-personal-finance/1.0" },
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 404) return res.status(404).json({ error: "No GitHub user called " + user });
    if (r.status === 403 || r.status === 429) return res.status(429).json({ error: "GitHub is rate-limiting us — try again in a few minutes" });
    if (!r.ok) return res.status(502).json({ error: "GitHub returned " + r.status });
    const raw = await r.json();
    const repos = (Array.isArray(raw) ? raw : [])
      .filter((x) => !x.fork && !x.archived && !x.private)
      .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || String(b.pushed_at).localeCompare(String(a.pushed_at)))
      .slice(0, 40)
      .map((x) => ({
        name: String(x.name || "").slice(0, 60),
        url: String(x.html_url || "").slice(0, 200),
        what: String(x.description || "").slice(0, 180),
        stack: [x.language, ...(Array.isArray(x.topics) ? x.topics.slice(0, 5) : [])].filter(Boolean).join(", ").slice(0, 120),
        stars: x.stargazers_count || 0,
        pushed: String(x.pushed_at || "").slice(0, 10),
      }));
    res.json({ repos });
  } catch (e) {
    console.error("github import failed:", e.message);
    res.status(502).json({ error: "Could not reach GitHub" });
  }
});

/* ---------------- market quotes (Invest tab) ----------------
   Server-side proxy (CSP blocks third-party calls from the browser) with a short
   cache so a page of tickers doesn't hammer the upstream. Prices are delayed/
   informational — this is a tracker, not a trading terminal. */
const quoteCache = new Map(); // SYMBOL -> { q, ts }
const QUOTE_TTL = 5 * 60 * 1000;
async function fetchQuote(sym) {
  const hit = quoteCache.get(sym);
  if (hit && Date.now() - hit.ts < QUOTE_TTL) return hit.q;
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=1d&interval=1d",
    { headers: { "user-agent": "Mozilla/5.0 (compatible; Atlas-selfhosted)" }, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) throw new Error("no data for " + sym);
  const q = { symbol: sym, name: (m.shortName || sym).slice(0, 40), price: m.regularMarketPrice, prevClose: Number.isFinite(m.chartPreviousClose) ? m.chartPreviousClose : null };
  quoteCache.set(sym, { q, ts: Date.now() });
  return q;
}
/* Six months of daily closes, for sparklines. Same Yahoo endpoint the quotes
   already use, longer range, cached half a day — history doesn't move intraday
   in any way a sparkline can show. Symbols are proof-by-fetch: an invalid one
   returns null and the client simply doesn't draw it, which is also how ticker
   extraction from free text stays safe. */
const histCache = new Map(); // SYMBOL -> { h, ts }
async function fetchHistory(sym) {
  const hit = histCache.get(sym);
  if (hit && Date.now() - hit.ts < 12 * 3600e3) return hit.h;
  const y = sym.replace(/\./g, "-");   // BRK.B is BRK-B to Yahoo
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(y) + "?range=6mo&interval=1d",
    { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error("history " + r.status);
  const j = await r.json();
  const res0 = j?.chart?.result?.[0];
  const closes = (res0?.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  if (closes.length < 20) throw new Error("thin history");
  const step = Math.max(1, Math.floor(closes.length / 60));   // ~60 points is plenty for 240px
  const h = {
    closes: closes.filter((_, i) => i % step === 0 || i === closes.length - 1).map((x) => Math.round(x * 100) / 100),
    last: Math.round(closes[closes.length - 1] * 100) / 100,
    pct6m: Math.round(((closes[closes.length - 1] / closes[0]) - 1) * 1000) / 10,
    currency: res0?.meta?.currency || "USD",
  };
  histCache.set(sym, { h, ts: Date.now() });
  return h;
}
app.get("/api/history", auth, quoteLimiter, async (req, res) => {
  const syms = [...new Set(String(req.query.symbols || "").toUpperCase().split(",").map((s) => s.trim())
    .filter((s) => /^[A-Z0-9.^-]{1,10}$/.test(s)))].slice(0, 12);
  if (!syms.length) return res.status(400).json({ error: "No valid symbols" });
  const out = {};
  await Promise.all(syms.map(async (s) => { try { out[s] = await fetchHistory(s); } catch { out[s] = null; } }));
  res.json({ history: out });
});

app.get("/api/quotes", auth, quoteLimiter, async (req, res) => {
  const syms = [...new Set(String(req.query.symbols || "").toUpperCase().split(",").map((s) => s.trim())
    .filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s)))].slice(0, 30);
  if (!syms.length) return res.status(400).json({ error: "No valid symbols" });
  const out = {};
  await Promise.all(syms.map(async (s) => { try { out[s] = await fetchQuote(s); } catch { out[s] = null; } }));
  res.json({ quotes: out });
});

/* ---------------- AI proxy ---------------- */
/* Hard daily spend cap: the burst limiter (aiLimiter) stops a fast flood; this stops a
   slow-but-relentless one (a stuck retry loop, an accidental script) from draining the
   owner's API bill over a day. Persisted to disk so a crash-restart can't reset the count.
   Fail-closed: any error denies the call rather than risk the bill. */
const AI_USAGE_PATH = path.join(DATA_DIR, "ai-usage.json");
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 200);        // total AI calls/day across everyone
const AI_USER_DAILY_LIMIT = Number(process.env.AI_USER_DAILY_LIMIT || 100); // per user/day
function reserveAi(uid) {
  /* locked: two concurrent calls must not both read the same count and each spend a slot */
  return withLock("ai-usage", () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      /* distinguish "no file yet" from "file is corrupt" — treating a corrupt
         file as a new day silently resets the spend cap, which is the opposite
         of failing closed */
      let u = fs.existsSync(AI_USAGE_PATH) ? JSON.parse(fs.readFileSync(AI_USAGE_PATH, "utf8")) : null;
      if (!u || u.date !== today) u = { date: today, total: 0, byUser: {} }; // new day → reset
      if (u.total >= AI_DAILY_LIMIT) return { ok: false, error: "This server's daily AI limit is reached — resets tomorrow." };
      if ((u.byUser[uid] || 0) >= AI_USER_DAILY_LIMIT) return { ok: false, error: "You've reached today's AI limit — resets tomorrow." };
      u.total++; u.byUser[uid] = (u.byUser[uid] || 0) + 1;
      writeJSON(AI_USAGE_PATH, u); // reserve before the call so concurrent requests can't slip past the cap
      return { ok: true };
    } catch { return { ok: false, error: "AI temporarily unavailable" }; }
  });
}

/* One place that talks to Anthropic, so every caller goes through the same daily
   cap. A second code path with its own fetch would be a second way to spend the
   owner's API budget without the counter noticing. */
async function callAnthropic(prompt, search, uid) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("AI disabled — no ANTHROPIC_API_KEY in .env"), { status: 400 });
  if (String(prompt).length > 24000) throw Object.assign(new Error("Prompt too long"), { status: 400 });
  const gate = await reserveAi(uid);
  if (!gate.ok) throw Object.assign(new Error(gate.error), { status: 429 });
  /* Sonnet 5 thinks adaptively by default and max_tokens caps thinking + answer
     together, so give headroom; effort:low keeps categorization calls cheap. */
  const body = { model: "claude-sonnet-5", max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: String(prompt) }] };
  if (search) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { status: 502 });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text && j.stop_reason === "refusal") throw Object.assign(new Error("The AI declined this request — try rephrasing."), { status: 502 });
  return text;
}

app.post("/api/ai", auth, aiLimiter, async (req, res) => {
  try {
    res.json({ text: await callAnthropic(req.body.prompt || "", req.body.search, req.userId) });
  } catch (e) {
    if (!e.status) console.error("AI proxy error:", e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : "AI request failed" });
  }
});

/* ---------------- Teller ---------------- */
/* mTLS agent built once and reused — outside sandbox Teller requires your client cert.
   (Previously rebuilt per request, re-reading both key files every call.) */
let _tellerAgent = null;
function tellerAgent() {
  if (_tellerAgent) return _tellerAgent;
  const certPath = process.env.TELLER_CERT_PATH, keyPath = process.env.TELLER_KEY_PATH;
  if (!certPath || !keyPath) throw new Error("Teller certificate/key path not configured");
  _tellerAgent = new https.Agent({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), keepAlive: true });
  return _tellerAgent;
}
const TELLER_TIMEOUT_MS = 15000;
const TELLER_HOST = process.env.TELLER_HOST || "api.teller.io"; // override is for local testing only
function tellerGet(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: TELLER_HOST, port: process.env.TELLER_PORT || 443, path: p, method: "GET",
      rejectUnauthorized: process.env.TELLER_INSECURE !== "1",
      agent: process.env.TELLER_ENV === "sandbox" ? undefined : tellerAgent(),
      auth: token + ":", headers: { accept: "application/json" },
      timeout: TELLER_TIMEOUT_MS,
    }, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        try {
          const j = JSON.parse(buf);
          r.statusCode >= 400 ? reject(new Error(j.error?.message || "Teller " + r.statusCode)) : resolve(j);
        } catch (e) { reject(e); }
      });
    });
    /* without this a hung bank connection stalls the whole sync indefinitely */
    req.on("timeout", () => req.destroy(new Error("Bank request timed out")));
    req.on("error", reject);
    req.end();
  });
}

const TYPE_MAP = { checking: "Checking", savings: "Savings / HYSA", credit_card: "Credit card", credit: "Credit card" };
const DEBT = ["Credit card", "Auto loan", "Student loan", "Mortgage", "Other debt"];

/* ---------------- transfer detection ----------------
   A credit-card payment appears TWICE in a sync: an outflow from checking AND an
   inflow on the card. Counting the outflow as spending double-counts the purchases
   (which were already imported as spending), and counting the card credit as income
   fabricates income. Same story for checking→savings moves. These are classified
   as kind "xfer" — kept in the ledger, excluded from income/spending math. */
const XFER_RE = /\btransfer\b|\bxfer\b|autopay|auto ?pay|card ?(?:pay(?:ment)?|pmt)\b|payment to .{0,28}(?:card|loan|mortgage)|crd (?:pmt|pay)|\bpymt\b|\bpmt\b|payment thank ?you|automatic payment.{0,6}thank|thank you.*payment|internet payment|jpmorgan chase bank|\be-?payment\b|\bepay\b|directpay|fid(?:elity)? bkg|\bmoneyline\b|\bwebull\w*|\brobinhood\w*|\bschwab\w*|\bvanguard\b|e\*trade|\bacorns\b|\bbetterment\b|\bwealthfront\w*|\bcoinbase\w*|m1 ?finance|\btd ameritrade|interactive brokers/i;

/* Classify a synced transaction. Inflows on debt accounts (card/loan payments
   arriving — or the odd refund) are never income. */
/* Split one incoming transaction according to the user's standing rules.
   Returns null when nothing matches, so the caller can keep the original row.

   The tellerId stays on exactly ONE part. Copying it to both would make the
   next sync think it had already imported the other half; dropping it entirely
   would make the next sync re-import the whole payment as a duplicate. */
function splitByRules(row, rules) {
  if (!Array.isArray(rules) || !rules.length || row.kind !== "out") return null;
  const note = String(row.note || "").toLowerCase();
  const amt = Math.round((Number(row.amount) || 0) * 100) / 100;
  for (const r of rules) {
    const m = String(r.match || "").trim().toLowerCase();
    if (!m || !note.includes(m)) continue;
    if (r.minAmount && amt < Number(r.minAmount)) continue;
    const parts = (r.parts || []).filter((p) => p.catId && Number(p.amount) > 0);
    if (!parts.length) continue;
    const fixed = parts.reduce((s, p) => s + Number(p.amount), 0);
    /* The remainder is whatever the fixed parts don't claim, so rent absorbs a
       rise in the total rather than the split silently failing to add up. */
    const rest = Math.round((amt - fixed) * 100) / 100;
    if (rest < 0) continue;                       // rule bigger than the payment — leave it alone
    const out = parts.map((p, i) => ({
      id: crypto.randomUUID(), accountId: row.accountId, date: row.date, kind: "out",
      amount: Math.round(Number(p.amount) * 100) / 100, catId: p.catId,
      note: row.note + (p.label ? " (" + p.label + ")" : ""), splitOf: row.tellerId || row.id, kindSet: true,
      ...(i === 0 ? { tellerId: row.tellerId } : {}),
    }));
    if (rest > 0 && r.remainderCatId) {
      out.push({ id: crypto.randomUUID(), accountId: row.accountId, date: row.date, kind: "out",
        amount: rest, catId: r.remainderCatId, note: row.note, splitOf: row.tellerId || row.id, kindSet: true });
    } else if (rest > 0) {
      out[0].amount = Math.round((out[0].amount + rest) * 100) / 100;   // no remainder category — fold it in
    }
    return out;
  }
  return null;
}

function classifyKind(amt, accType, note) {
  if (XFER_RE.test(String(note || ""))) return "xfer";
  if (amt > 0 && DEBT.includes(accType)) return "xfer";
  return amt > 0 ? "in" : "out";
}

/* Same amount, opposite direction, different accounts, within 4 days → the two
   sides of one transfer that keyword matching missed. Only synced, uncategorized
   rows without a manual kind override (kindSet) are touched. */
function markTransferPairs(txns) {
  const cand = txns.filter((t) => t.tellerId && !t.catId && !t.kindSet && (t.kind === "in" || t.kind === "out"));
  const ins = cand.filter((t) => t.kind === "in");
  const used = new Set();
  let n = 0;
  for (const o of cand) {
    if (o.kind !== "out") continue;
    const m = ins.find((i) => !used.has(i.id) && i.accountId !== o.accountId &&
      Math.abs(Number(i.amount) - Number(o.amount)) < 0.005 &&
      Math.abs(new Date(i.date) - new Date(o.date)) <= 4 * 864e5);
    if (m) { o.kind = "xfer"; m.kind = "xfer"; used.add(m.id); n += 2; }
  }
  return n;
}

/* ---------------- auto-categorization ----------------
   Deterministic first pass so synced transactions don't all land uncategorized:
   1) merchant memory — how the user categorized this merchant before always wins;
   2) keyword rules for common US merchants, mapped onto the user's category NAMES
      (case-insensitive; a rule whose category the user deleted is skipped).
   The AI categorize button remains for whatever these two miss.
   normMerchant + CAT_RULES are mirrored in client/src/App.jsx — keep in sync. */
const normMerchant = (note) =>
  String(note || "").toLowerCase().replace(/\(recurring\)/g, "").replace(/[#*\d]+/g, " ").replace(/[^a-z& ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 28);
const CAT_RULES = [
  /* Rules run in order and the first match wins, so the specific ones that were
     getting swallowed by broader rules (or by merchant memory) go first.

     Every entry here comes from a real misfile: a utility whose descriptor is
     truncated below the word "utility", a fuel brand missing from the transport
     list, a salon that reads like a building, and Atlas's own SimpleFIN
     subscription filed as Rent. */
  [/deltastatesutil|delta states util|\bcpenergy\b|cp energy|\bcleco\b|lus fiber|atmos energy|\bsouthwestern electric|entergy|slemco|demco\b/, "Utilities"],
  [/conoco|phillips ?66|\bexxon\b|\bmobil\b|\bshell oil|\bchevron\b|\bcitgo\b|\bvalero\b|\bsunoco\b|\bmarathon\b|\bcircle k|\bracetrac\b|\bquiktrip\b|\bqt \d|\bbuc-?ee|\bmurphy usa|\bpilot travel|\bloves? travel|\bwawa\b|\bsheetz\b|\bkwik|\bcasey'?s gen/, "Transport"],
  [/\bthe loft\b|squire the loft|\bsalon\b|\bbarber|haircut|\bsupercuts\b|great clips|sport ?clips|hair ?(salon|studio|co\b)|\bspa\b|\bnails?\b|massage/, "Health"],
  [/simplefin|link\.com\*|\blink com simplefin/, "Subscriptions"],
  /* big p2p payments are almost always rent/housing — small ones could be anything.
     The third element is a minimum $ amount for the rule to apply. */
  [/\birs\b|internal revenue|us ?treasury|treas ?tax|tax ?(pmt|payment)|dept? of revenue|state tax|franchise tax|turbotax|h&r block|jackson hewitt|taxact/, "Taxes"],
  /* A car payment is not Transport (that's fuel and parking) and not Rent. It's
     a fixed debt obligation, and lumping it into either makes both budgets
     nonsense — the whole point of a budget line is that you can cut it, and you
     cannot cut a loan payment. */
  [/\b(auto|car) (loan|pmt|payment|finance)|carmax auto|capital one auto|ally (auto|financial)|santander consumer|chrysler capital|toyota financial|honda financial|ford credit|gm financial|nissan motor accept|hyundai motor finance|westlake financial|exeter finance|bridgecrest|\bcredit acceptance\b|drivetime|regional acceptance/, "Car / loan payment"],
  [/\b(student ?loan|nelnet|mohela|navient|great lakes|aidvantage|sallie mae|earnest|sofi loan)\b/, "Car / loan payment"],
  [/venmo payment|zelle (payment|to)/, "Rent", 500],
  /* Walmart's own merchant string is "WM SUPERCENTER #124", which no amount of
     matching on "walmart" will ever catch. */
  [/kroger|trader joe|aldi|wal-?mart|\bwm supercenter|\bwm superc|neighborhood market|h-?e-?b\b|publix|safeway|whole ?foods|wholefds|costco|sam'?s club|food lion|winn-?dixie|meijer|sprouts|wegmans|grocery|supermarket/, "Groceries"],
  /* Brand names alone are a losing game — there are more restaurants than any
     list can hold. These generic words carry the meaning: "In-N-Out Donuts",
     "Tst* Bb.q Chicken Usa" and "Genesis Health Clubs" matched nothing at all
     while being completely obvious to a human. "Tst*" is Toast's card-processor
     prefix and appears on a huge number of independent restaurants. */
  [/mcdonald|five guys|chipotle|taco bell|burger|wendy|chick.?fil|kfc|popeyes|starbucks|dunkin|subway\b|domino|pizza|panera|sonic drive|whataburger|panda express|raising cane|grill|restaur|cafe|café|coffee|doordash|uber ?eats|grubhub|postmates|seamless|caviar|bakery|diner|ihop|waffle house|bon appetit|culver|zaxby|wingstop|jimmy john|jersey mike|\btst\*|\btoast\b ?\*|\bsq \*|donut|doughnut|chicken|\bbbq\b|bb\.?q|barbecue|taco|sushi|ramen|noodle|deli\b|bistro|brewing|brewery|taproom|pub\b|tavern|bar & grill|steakhouse|buffet|creamery|ice cream|frozen yogurt|smoothie|juice bar|boba|tea house|sandwich|burrito|wings\b|kitchen\b|eatery|food ?truck|catering|snack|bagel|pretzel|cupcake|\bpho\b|\bwok\b|hibachi|teriyaki|cantina|taqueria|trattoria|pizzeria/, "Eating out"],
  [/exxon|shell oil|chevron|texaco|citgo|valero|racetrac|quiktrip|\bqt\b|speedway|murphy usa|circle k|7-?eleven fuel|uber(?! ?eats)|lyft|parking|toll|jiffy lube|autozone|o'?reilly|discount tire|car wash/, "Transport"],
  /* Utilities before Subscriptions: a cable/internet bill is a utility, and
     lumping it in with Netflix made "cut your subscriptions" advice nonsense —
     you cannot cancel your electricity. Airlines before Transport's fuel list
     so a flight doesn't fall through to uncategorized. */
  [/optimum|spectrum|xfinity|comcast|cox communi|at&?t\b|verizon|t-?mobile|sparklight|centurylink|frontier comm|google fiber|starlink|entergy|swepco|ameren|duke energy|dominion energy|con ?ed|pg&?e|oncor|centerpoint|city of \w+ util|water (works|dept|utility)|sewer|waste management|republic services|trash|electric (co|company|coop)|gas (co|company|utility)|utility|utilities/, "Utilities"],
  /* "southwes" alone would also match Southwest Power Pool — his employer — so
     the airline form requires the ticket number the airline always appends. */
  [/southwest airlines|southwes\w* \d|delta air|american air|united air|jetblue|alaska air|spirit air|frontier air|allegiant|hawaiian air|expedia|kayak|priceline|orbitz|booking\.com|airbnb|vrbo|hertz|enterprise rent|avis|budget rent|national car|amtrak|greyhound|\bairlines?\b|\bairways\b/, "Transport"],
  [/netflix|spotify|hulu|disney ?\+|hbo ?max|paramount|peacock|crunchyroll|youtube ?(premium|tv)|apple\.com\/bill|apple ?one|icloud|google ?(one|storage)|dropbox|adobe|microsoft 365|xbox game|playstation|nintendo|patreon|twitch|discord|cloudflare|github|godaddy|namecheap|\bvpn\b|audible|kindle unltd|anthropic|openai|chatgpt|claude/, "Subscriptions"],
  [/amazon|amzn|target\b|best buy|ebay|etsy|dollar (general|tree)|five below|ross store|tj ?maxx|marshalls|old navy|h&m\b|zara|nike|shein|temu|home depot|lowe'?s|ikea|j\.? ?crew|gap\b|banana republic|american eagle|hollister|abercrombie|urban outfitters|forever 21|uniqlo|lululemon|dick'?s sporting|academy sports|belk\b|dillard|macy'?s|nordstrom|kohl'?s|jcpenney|sephora|ulta|bath ?& ?body/, "Shopping"],
  [/rent\b|apartment|property (mgmt|management)|landlord/, "Rent"],
  [/\bgym\b|planet fitness|la fitness|ymca|crunch fitness|health club|fitness|athletic club|wellness|orangetheory|f45|crossfit|pilates|yoga|peloton|walgreens|cvs\b|rite aid|pharmacy|drug ?store|clinic|dental|dentist|orthodon|doctor|\bmd\b ?office|physician|hospital|urgent care|optical|optometr|vision center|therapy|therapist|chiroprac|dermatolog|lab ?corp|quest diagnostic|medical|health ?care|\brx\b/, "Health"],
  [/cinema|cinemark|\bamc\b|regal|steam(games| purchase)|steampowered|epic games|riot|blizzard|ticketmaster|stubhub|bowling|arcade|spotify concert|eventbrite/, "Fun"],
];
/* p2p sends share one merchant key ("venmo payment web id") but mean something
   different every time — never let one categorization spread to all of them */
const P2P_RE = /venmo (payment|cashout)|cash ?app|zelle/i;
function buildMerchantMemory(txns, cats) {
  const catIds = new Set((cats || []).map((c) => c.id));
  const mem = {};
  for (const t of txns) { // insertion order: later (newer) categorizations overwrite older ones
    if (t.kind === "out" && t.catId && catIds.has(t.catId) && t.note && !P2P_RE.test(t.note)) {
      const k = normMerchant(t.note);
      if (k.length >= 3) mem[k] = t.catId;
    }
  }
  return mem;
}
function autoCategorize(note, cats, memory, amount) {
  const key = normMerchant(note);
  if (key && memory[key]) return memory[key];
  const n = String(note || "").toLowerCase();
  for (const [re, name, min] of CAT_RULES) {
    if (min && !(Number(amount) >= min)) continue;
    if (re.test(n)) {
      const c = (cats || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (c) return c.id;
    }
  }
  return "";
}

/* The enroll endpoint is gone: Teller stopped issuing enrollments in July 2026,
   so it could only ever store a token that will never authenticate. Sync and
   disconnect stay so anyone still holding a connection keeps their data and can
   remove it on their own terms. */

app.post("/api/teller/sync", auth, syncLimiter, async (req, res) => {
  let enrollments;
  try {
    enrollments = (readData(req.userId).teller) || [];
  } catch (e) { console.error("sync read failed:", e.message); return res.status(500).json({ error: "Could not read your data file" }); }
  if (!enrollments.length) return res.status(400).json({ error: "No banks connected yet" });

  /* PHASE 1 — talk to the bank WITHOUT holding the lock, so a slow sync never blocks
     the browser's autosave (and vice versa). Nothing is written here. */
  const fetched = [];
  try {
    for (const enr of enrollments) {
      const token = decSecret(enr.accessToken); // decrypted in memory only, for the call
      if (!token) continue;                     // undecryptable (e.g. SESSION_SECRET changed) — skip
      const accounts = await tellerGet("/accounts", token);
      for (const a of accounts) {
        let bal = null, txs = [];
        try {
          const b = await tellerGet("/accounts/" + a.id + "/balances", token);
          bal = Math.abs(Number(a.type === "credit" ? b.ledger : b.available ?? b.ledger));
          if (!Number.isFinite(bal)) bal = null; // a missing/garbled balance must not overwrite a real one with NaN
        } catch {}
        try { txs = await tellerGet("/accounts/" + a.id + "/transactions?count=150", token); } catch {}
        fetched.push({ institution: enr.institution, a, bal, txs });
      }
    }
  } catch (e) {
    console.error("teller sync error:", e.message);
    return res.status(502).json({ error: "Couldn't reach your bank — try again shortly." }); // no upstream detail leaked
  }

  /* PHASE 2 — merge into the CURRENT on-disk state under the lock (brief). */
  let newTx = 0, updAcc = 0;
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.accounts = d.accounts || []; d.txns = d.txns || [];
      const merchantMem = buildMerchantMemory(d.txns, d.cats);
      for (const { institution, a, bal, txs } of fetched) {
        let acc = d.accounts.find((x) => x.tellerId === a.id);
        if (!acc) {
          acc = {
            id: crypto.randomUUID(), tellerId: a.id,
            name: institution + " " + (a.name || a.subtype || "account"),
            type: TYPE_MAP[a.subtype] || TYPE_MAP[a.type] || "Other asset",
            balance: 0, rate: "",
          };
          d.accounts.push(acc);
        }
        if (bal != null) { acc.balance = bal; updAcc++; }
        for (const t of txs) {
          if (d.txns.some((x) => x.tellerId === t.id)) continue;
          const amt = Number(t.amount);
          if (!(amt < 0) && !(amt > 0 && a.type === "depository")) continue;
          const note = (t.description || "").slice(0, 60);
          const kind = classifyKind(amt, acc.type, note);
          const catId = kind === "out" ? autoCategorize(note, d.cats, merchantMem, Math.abs(amt)) : "";
          d.txns.push({ id: crypto.randomUUID(), tellerId: t.id, accountId: acc.id, kind, date: t.date, amount: Math.round(Math.abs(amt) * 100) / 100, catId, note });
          newTx++;
        }
      }
      const assets = d.accounts.filter((x) => !DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const debts = d.accounts.filter((x) => DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      d.history = (d.history || []).filter((h) => h.date !== today);
      /* Only record a real reading. A snapshot of 0/0 means the sync ran before
         any account existed, and later it is indistinguishable from a day you
         genuinely had nothing — which is how the net-worth chart ended up
         anchored to zero and drawing June below the axis. */
      if (assets !== 0 || debts !== 0) d.history.push({ date: today, assets, debts, nw: assets - debts });
      d.history.sort((x, y) => x.date.localeCompare(y.date));
      d.lastSync = new Date().toISOString();
      d._rev = (d._rev || 0) + 1;
      writeData(req.userId, d);
    });
    res.json({ ok: true, newTx, updAcc });
  } catch (e) { console.error("sync merge failed:", e.message); res.status(500).json({ error: "Synced from your bank but couldn't save — your existing data was left untouched" }); }
});

/* ---------------- SimpleFIN (bank sync) ----------------
   Teller withdrew its API in July 2026. SimpleFIN Bridge is the read-only,
   personal-scale replacement: no app-level credential at all — the user pastes
   a one-time setup token, which we exchange once for a long-lived access URL
   (it embeds basic-auth credentials) and store encrypted, exactly like a token. */
const SIMPLEFIN_TIMEOUT_MS = 30000;
const SIMPLEFIN_DEEP_TIMEOUT_MS = 180000;
const SF_SYNC_DAYS = 120;    // routine sync: comfortably covers any realistic gap
const SF_MAX_DAYS = 2555;    // backfill: 7 years, past what any consumer bank retains
/* The claim URL arrives base64'd from the browser, so it is untrusted input and a
   textbook SSRF vector (cloud metadata, localhost admin ports). Pin it to SimpleFIN. */
const simplefinHostOk = (h) => h === "simplefin.org" || h.endsWith(".simplefin.org");
function simplefinParts(accessUrl) {
  const u = new URL(accessUrl);
  const auth = "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64");
  u.username = ""; u.password = ""; // fetch() rejects inline credentials — send a header instead
  return { base: u.toString().replace(/\/+$/, ""), auth };
}
async function simplefinFetch(accessUrl, sinceDays) {
  const { base, auth } = simplefinParts(accessUrl);
  const start = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  /* A backfill makes SimpleFIN pull years out of the bank; 30s is generous for a
     routine sync and far too short for that, and a timeout here reads to the user
     as "sync is broken" rather than "that was a big ask". */
  /* pending=1 matters more than it looks. Card purchases sit pending for one to
     three business days before they post, so without this a sync run today
     genuinely cannot see what you bought yesterday — which reads as a broken
     sync rather than as how card networks work. Pending rows carry real ids, so
     they dedupe normally and simply firm up when they post. */
  const r = await fetch(base + "/accounts?pending=1&start-date=" + start, {
    headers: { authorization: auth, accept: "application/json" },
    signal: AbortSignal.timeout(sinceDays > 400 ? SIMPLEFIN_DEEP_TIMEOUT_MS : SIMPLEFIN_TIMEOUT_MS),
  });
  if (r.status === 402) throw new Error("SimpleFIN says payment is required — check your subscription.");
  if (r.status === 403) throw new Error("SimpleFIN denied access — reconnect this bank.");
  if (!r.ok) throw new Error("SimpleFIN returned " + r.status);
  return r.json();
}
/* SimpleFIN reports no account type, so infer one from the name; a wrong guess is
   editable in the UI and only affects which side of net worth it lands on. */
function guessType(name) {
  const n = String(name || "").toLowerCase();
  if (/credit|card|visa|mastercard|amex|freedom|sapphire|quicksilver/.test(n)) return "Credit card";
  if (/save|saving|hysa|money ?market/.test(n)) return "Savings / HYSA";
  if (/check|chequing|debit/.test(n)) return "Checking";
  if (/401|403b|ira|roth|brokerage|invest/.test(n)) return "Brokerage";
  if (/mortgage/.test(n)) return "Mortgage";
  if (/auto|car loan/.test(n)) return "Auto loan";
  if (/student/.test(n)) return "Student loan";
  if (/loan/.test(n)) return "Other debt";
  return "Checking";
}

app.post("/api/simplefin/claim", auth, authLimiter, async (req, res) => {
  const token = String(req.body?.setupToken || "").trim();
  if (!token) return res.status(400).json({ error: "Paste your SimpleFIN setup token first." });
  let claimUrl;
  try {
    claimUrl = Buffer.from(token, "base64").toString("utf8").trim();
    const u = new URL(claimUrl);
    if (u.protocol !== "https:" || !simplefinHostOk(u.hostname)) throw new Error("bad host");
  } catch { return res.status(400).json({ error: "That doesn't look like a SimpleFIN setup token." }); }

  let accessUrl;
  try {
    /* no manual content-length — undici throws on redirect if it is set, and the
       legacy bridge.simplefin.org host 302s to beta-bridge */
    const r = await fetch(claimUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    if (r.status === 403) return res.status(400).json({ error: "SimpleFIN says that token was already used — setup tokens are one-time, so create a fresh one." });
    if (!r.ok) return res.status(502).json({ error: "SimpleFIN rejected the token (" + r.status + ")." });
    accessUrl = (await r.text()).trim();
    const a = new URL(accessUrl);
    if (a.protocol !== "https:" || !simplefinHostOk(a.hostname)) throw new Error("bad access url");
  } catch (e) {
    console.error("simplefin claim failed:", e.message);
    return res.status(502).json({ error: "Couldn't claim that token. Make sure it's a fresh, unused setup token copied whole from SimpleFIN → Apps → New Connection." });
  }
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.simplefin = d.simplefin || [];
      d.simplefin.push({
        id: crypto.randomUUID(), accessToken: encSecret(accessUrl), // encrypted at rest
        institution: String(req.body.label || "SimpleFIN").slice(0, 60), added: new Date().toISOString().slice(0, 10),
      });
      d._rev = (d._rev || 0) + 1;
      writeData(req.userId, d);
    });
    res.json({ ok: true });
  } catch (e) { console.error("simplefin save failed:", e.message); res.status(500).json({ error: "Claimed the token but couldn't save the connection." }); }
});

/* The whole sync as a function of a user id, because two callers need it: the
   button, and the background scheduler at the bottom of this file. Failures
   carry a code so the endpoint can keep answering with the same statuses it
   always has. */
async function simplefinSyncUser(uid, daysReq) {
  let conns;
  try { conns = readData(uid).simplefin || []; }
  catch (e) { console.error("simplefin sync read failed:", e.message); throw Object.assign(new Error("Could not read your data file"), { code: "READ" }); }
  if (!conns.length) throw Object.assign(new Error("No SimpleFIN connection yet"), { code: "NOCONN" });

  /* PHASE 1 — network, no lock held (a slow sync must not block the browser's autosave) */
  const sets = [];
  const warnings = [];
  /* A routine sync only needs to cover the gap since the last one, and asking for
     more makes SimpleFIN do real work against the bank every time. A backfill is
     the opposite: it's a one-off, so it asks for everything and accepts being slow.
     120 days was neither — it silently capped how far back Atlas could ever see,
     which meant every average, median and month-over-month figure was computed on
     a window nobody chose. */
  const days = Math.min(SF_MAX_DAYS, Math.max(30, Number(daysReq) || SF_SYNC_DAYS));
  try {
    for (const c of conns) {
      const url = decSecret(c.accessToken);
      if (!url) continue; // undecryptable (SESSION_SECRET changed) — skip rather than crash
      const set = await simplefinFetch(url, days);
      (set.errors || set.errlist || []).forEach((e) => warnings.push(typeof e === "string" ? e : e.msg || "connection error"));
      sets.push(set);
    }
  } catch (e) {
    console.error("simplefin sync error:", e.message);
    throw Object.assign(new Error(e.message), { code: "NET" });
  }

  /* PHASE 2 — merge into current on-disk state under the lock (brief) */
  let newTx = 0, updAcc = 0, updHold = 0, autoCat = 0, xferPairs = 0;
  const retyped = [];
  try {
    await withLock("data:" + uid, () => {
      const d = readData(uid);
      d.accounts = d.accounts || []; d.txns = d.txns || [];
      d.invest = d.invest || { holdings: [], watch: [] };
      d.invest.holdings = d.invest.holdings || []; d.invest.watch = d.invest.watch || [];
      const merchantMem = buildMerchantMemory(d.txns, d.cats);
      for (const set of sets) {
        for (const a of set.accounts || []) {
          const sfId = "sf:" + a.id;
          let acc = d.accounts.find((x) => x.tellerId === sfId);
          if (!acc) {
            acc = {
              id: crypto.randomUUID(), tellerId: sfId,
              name: ((a.org && (a.org.name || a.org.domain)) ? a.org.name || a.org.domain : "") + (a.name ? " " + a.name : "") || a.name || "Account",
              type: guessType(a.name), balance: 0, rate: "",
            };
            acc.name = acc.name.trim().slice(0, 60);
            d.accounts.push(acc);
          }
          /* An account's type is guessed once, at creation, and then never
             revisited — so a card connected before guessType learned the word
             "Freedom" stayed filed as Checking forever, sitting in net worth as
             a negative asset instead of a debt. Re-guess when the stored type
             still looks like the old default and the name now clearly says
             otherwise. A type the user picked themselves is never touched. */
          if (!acc.typeSet && acc.type !== guessType(a.name)) {
            const g = guessType(a.name);
            if (DEBT.includes(g) !== DEBT.includes(acc.type)) retyped.push(acc.name + " → " + g);
            acc.type = g;
          }
          const bal = Number(a.balance);
          if (Number.isFinite(bal)) { acc.balance = DEBT.includes(acc.type) ? Math.abs(bal) : bal; updAcc++; }

          /* Pending rows are transient: SimpleFIN may hand a transaction a NEW id
             when it posts, so keeping the pending copy would double-count the
             purchase. Drop this account's pending rows and take them fresh from
             the response — but remember any category first, keyed by what the
             row looks like rather than by its id, so categorising a pending
             charge isn't undone the moment it clears. */
          const fp = (t) => [t.accountId, Math.round(Math.abs(Number(t.amount)) * 100), String(t.note || "").slice(0, 40)].join("|");
          const keptCats = new Map();
          d.txns = d.txns.filter((x) => {
            if (!x.pending || x.accountId !== acc.id) return true;
            if (x.catId) keptCats.set(fp(x), x.catId);
            return false;
          });

          for (const t of a.transactions || []) {
            const tid = "sf:" + t.id;
            if (d.txns.some((x) => x.tellerId === tid)) continue;
            const amt = Number(t.amount);
            if (!Number.isFinite(amt) || amt === 0) continue;
            /* A pending transaction has posted:0 by definition, and 0 is a valid
               unix timestamp — so trusting it silently dates the row 1970-01-01,
               which then stretches every chart back fifty years. Fall back to
               when it was transacted, then to today. */
            const stamp = Number(t.posted) || Number(t.transacted_at) || Math.floor(Date.now() / 1000);
            const date = new Date(stamp * 1000).toISOString().slice(0, 10);
            const note = String(t.description || t.payee || "").slice(0, 60);
            const kind = classifyKind(amt, acc.type, note);
            const pending = !!t.pending;
            const row = { id: crypto.randomUUID(), tellerId: tid, accountId: acc.id, kind, date,
              amount: Math.round(Math.abs(amt) * 100) / 100, catId: "", note };
            if (pending) row.pending = true;
            const carried = keptCats.get(fp(row));
            row.catId = carried || (kind === "out" ? autoCategorize(note, d.cats, merchantMem, Math.abs(amt)) : "");
            if (row.catId && !carried) autoCat++;
            /* A recurring payment that is really two things — $750 that is $475
               rent and $275 car — has to be split every single month, or both
               budget lines lie. A rule does it on arrival so it never has to be
               done by hand again. */
            const split = splitByRules(row, d.settings?.splitRules);
            if (split) { d.txns.push(...split); newTx += split.length - 1; }
            else d.txns.push(row);
            newTx++;
          }
          /* Brokerage accounts carry a holdings array (undocumented in the spec, but
             real — Fidelity returns symbol/shares/cost_basis/market_value). Feed it
             straight into the Invest tab so positions track themselves. */
          for (const h of a.holdings || []) {
            const sym = String(h.symbol || "").trim().toUpperCase();
            const shares = Number(h.shares);
            if (!/^[A-Z0-9.^-]{1,10}$/.test(sym) || !Number.isFinite(shares) || shares <= 0) continue;
            const costRaw = Number(h.cost_basis);
            const cost = Number.isFinite(costRaw) && costRaw > 0 ? Math.round(costRaw * 100) / 100 : 0;
            const ex = d.invest.holdings.find((x) => x.symbol === sym);
            if (ex) { ex.shares = shares; if (cost) ex.cost = cost; ex.src = "simplefin"; }
            else d.invest.holdings.push({ id: crypto.randomUUID(), symbol: sym, shares, cost, src: "simplefin" });
            updHold++;
          }
        }
      }
      xferPairs = markTransferPairs(d.txns);
      const assets = d.accounts.filter((x) => !DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const debts = d.accounts.filter((x) => DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      d.history = (d.history || []).filter((h) => h.date !== today);
      /* Only record a real reading. A snapshot of 0/0 means the sync ran before
         any account existed, and later it is indistinguishable from a day you
         genuinely had nothing — which is how the net-worth chart ended up
         anchored to zero and drawing June below the axis. */
      if (assets !== 0 || debts !== 0) d.history.push({ date: today, assets, debts, nw: assets - debts });
      d.history.sort((x, y) => x.date.localeCompare(y.date));
      d.lastSync = new Date().toISOString();
      d._rev = (d._rev || 0) + 1;
      writeData(uid, d);
    });
    /* How deep the bank actually went is a property of the bank, not of Atlas, and
       it decides how much of the app can be trusted — so report it rather than
       leaving the user to infer it from a chart that starts abruptly. */
    const got = sets.flatMap((s) => (s.accounts || []).flatMap((a) => (a.transactions || []).map((t) => Number(t.posted) || 0)))
      .filter(Boolean).sort((x, y) => x - y);
    const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10);
    return { ok: true, newTx, updAcc, updHold, autoCat, xferPairs, retyped, warnings: warnings.slice(0, 3),
      askedDays: days, pulled: got.length, oldest: got.length ? iso(got[0]) : null, newest: got.length ? iso(got[got.length - 1]) : null };
  } catch (e) {
    if (e.code) throw e;                                    // NET from the fetch above
    console.error("simplefin merge failed:", e.message);
    throw Object.assign(new Error("Synced but couldn't save — your existing data was left untouched"), { code: "MERGE" });
  }
}

app.post("/api/simplefin/sync", auth, syncLimiter, async (req, res) => {
  try {
    const summary = await simplefinSyncUser(req.userId, req.body?.days);
    res.json(summary);
    /* New transactions are where most alerts come from, so evaluate right after
       a sync - but AFTER responding, because a push round-trip must never make
       the sync button feel slower. */
    runAlerts(req.userId).catch((e) => console.error("alerts after sync failed:", e.message));
  } catch (e) {
    res.status(e.code === "NOCONN" ? 400 : e.code === "NET" ? 502 : 500).json({ error: e.message });
  }
});

/* Whether this server syncs on its own, so the Bank card can say so. */
app.get("/api/simplefin/auto", auth, (req, res) => {
  const a = autoSyncConfig();
  res.json({ on: a.on, hours: a.hours });
});

app.delete("/api/simplefin/:id", auth, async (req, res) => {
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.simplefin = (d.simplefin || []).filter((x) => x.id !== req.params.id);
      d._rev = (d._rev || 0) + 1;
      writeData(req.userId, d);
    });
    res.json({ ok: true });
  } catch (e) { console.error("simplefin removal failed:", e.message); res.status(500).json({ error: "Could not remove the connection" }); }
});

app.delete("/api/teller/:id", auth, async (req, res) => {
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.teller = (d.teller || []).filter((x) => x.id !== req.params.id);
      d._rev = (d._rev || 0) + 1;
      writeData(req.userId, d);
    });
    res.json({ ok: true });
  } catch (e) { console.error("bank removal failed:", e.message); res.status(500).json({ error: "Could not remove the bank connection" }); }
});

/* ---------------- static client ---------------- */
/* unknown API paths must 404 as JSON, never fall through to index.html */
app.all("/api/*", (req, res) => res.status(404).json({ error: "Not found" }));
const dist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

/* Body-parser failures reach Express's default handler, which answers with an
   HTML stack page. The client only ever reads JSON, so an oversized save showed
   up as a blank "couldn't save" with nothing to act on. Answer in the shape the
   client speaks, and say which limit was hit. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: req.path.startsWith("/api/resume")
      ? "That PDF is too large — 2.5 MB is the limit."
      : "Your data is too large to save in one request. Trimming old transactions or an extra resume will bring it back under." });
  }
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed request body" });
  console.error("unhandled:", err?.message);
  res.status(500).json({ error: "Something went wrong on the server" });
});

/* The cache is always readable; only the scheduled poll is optional. Set
   JOB_POLL=0 for local dev — it has no business hitting forty third-party APIs
   on every restart — and the last poll's results are still served. */
initCache(DATA_DIR);
/* companies anyone is tracking - these boards get the hourly fast lane */
const targetCompanies = () => {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.startsWith("data-") || !f.endsWith(".json")) continue;
      const d = readJSON(path.join(DATA_DIR, f), null);
      for (const a of d?.career?.apps || [])
        if (a.company && a.status !== "Rejected" && a.status !== "Withdrawn") out.add(String(a.company).toLowerCase());
    }
  } catch (e) { console.error("target scan failed:", e.message); }
  return out;
};
if (process.env.JOB_POLL !== "0") startPolling(DATA_DIR, extraSources, targetCompanies);

/* Time-based alerts (a bill coming due, a balance sitting low) have no sync to
   ride along with, so they need their own heartbeat. Hourly, because "due in 3
   days" should land during waking hours rather than whenever a sync happened to
   run; the once-ever key on each alert is what stops this being hourly spam. */
if (pushReady && process.env.ALERT_SWEEP !== "0") {
  const sweep = async () => {
    let files = [];
    try { files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("data-") && f.endsWith(".json")); }
    catch (e) { return console.error("alert sweep scan failed:", e.message); }
    for (const f of files) {
      const uid = f.slice(5, -5);
      try { await runAlerts(uid); }
      catch (e) { console.error("alert sweep failed for a user:", e.message); }
    }
  };
  const t = setInterval(sweep, 60 * 60 * 1000);
  t.unref();
  setTimeout(sweep, 90 * 1000).unref();   // once shortly after boot, not during it
}

/* ---------------- background bank sync ----------------
   The alerts above are only as fresh as the data under them, and bank data
   that updates when a human remembers a button is stale exactly when it
   matters: "you got paid" should not wait for the app to be opened. So every
   user with a SimpleFIN connection is synced on a cadence, and the alert run
   afterwards is the same one a manual sync triggers — same rules, same
   once-ever keys, so automation cannot make the channel noisier, only
   earlier. AUTO_SYNC=0 turns it off server-wide; AUTO_SYNC_HOURS tunes it;
   a user can opt out in the Bank card (settings.autoSync = false).

   The tick is deliberately more frequent than the cadence: dueForAutoSync
   gates on lastSync, so a 15-minute tick just means a due user is picked up
   promptly, not that anyone syncs every 15 minutes. A failing connection is
   retried at most hourly (lastSync never advanced, but lastTry did) — an
   outage at the bank must not turn into a hammering. */
const AUTO_SYNC = autoSyncConfig();
if (AUTO_SYNC.on) {
  const lastTry = new Map();                     // uid -> ms of last attempt (in-memory; reset on restart is fine)
  const autoTick = async () => {
    let files = [];
    try { files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("data-") && f.endsWith(".json")); }
    catch (e) { return console.error("auto-sync scan failed:", e.message); }
    for (const f of files) {
      const uid = f.slice(5, -5);
      if (Date.now() - (lastTry.get(uid) || 0) < 55 * 60 * 1000) continue;
      let d;
      try { d = readData(uid); } catch { continue; }        // corrupt file: the user's own requests will surface it
      if (!dueForAutoSync(d, Date.now(), AUTO_SYNC.hours)) continue;
      lastTry.set(uid, Date.now());
      try {
        const s = await simplefinSyncUser(uid);
        if (s.newTx || s.updAcc) console.log("auto-sync: " + s.newTx + " new txns, " + s.updAcc + " balances updated");
        await runAlerts(uid);
      } catch (e) { console.error("auto-sync failed for a user:", e.message); }
    }
  };
  setInterval(autoTick, 15 * 60 * 1000).unref();
  setTimeout(autoTick, 2 * 60 * 1000).unref();   // shortly after boot, not during it
}

/* bind to loopback only — Caddy (same host) is the sole ingress; never listen on a public interface */
const HOST = process.env.HOST || "127.0.0.1";
app.listen(process.env.PORT || 3001, HOST, () =>
  console.log("Atlas server on http://" + HOST + ":" + (process.env.PORT || 3001))
);
