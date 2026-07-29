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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DATA_DIR = process.env.DATA_DIR || __dirname;
/* data files hold financial records + bank tokens — keep the directory private (owner-only) */
try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DATA_DIR, 0o700); } catch {}
const USERS_PATH = path.join(DATA_DIR, "users.json");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind one reverse proxy (Caddy) — needed for correct client IP + secure cookies
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.teller.io"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'", "https://*.teller.io"],
      "frame-src": ["https://teller.io", "https://*.teller.io"],
      "frame-ancestors": ["'none'"], // this app must never be embedded in an iframe (clickjacking)
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Teller Connect opens a cross-origin popup/iframe
}));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

/* passkey relying-party config — also reused by the Origin check below */
const RP_ID = process.env.RP_ID || "localhost";
const RP_NAME = "Cache";
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
const auth = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not logged in" });
  req.userId = u.id;
  req.user = u;
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
  tellerAppId: process.env.TELLER_APP_ID || "",
  tellerEnv: process.env.TELLER_ENV || "sandbox",
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
app.put("/api/data", auth, async (req, res) => {
  const d = req.body?.data;
  if (d === null || d === undefined || typeof d !== "object" || Array.isArray(d)) return res.status(400).json({ error: "Invalid data payload" });
  /* the client renders these as arrays — refuse a payload that would corrupt them */
  for (const k of ["accounts", "txns", "cats", "goals", "recurring", "purchases", "history"])
    if (k in d && !Array.isArray(d[k])) return res.status(400).json({ error: "Invalid data payload (" + k + ")" });
  if (d.settings != null && (typeof d.settings !== "object" || Array.isArray(d.settings))) return res.status(400).json({ error: "Invalid data payload (settings)" });
  if (d.invest != null && (typeof d.invest !== "object" || Array.isArray(d.invest))) return res.status(400).json({ error: "Invalid data payload (invest)" });
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
      let u = readJSON(AI_USAGE_PATH, null);
      if (!u || u.date !== today) u = { date: today, total: 0, byUser: {} }; // new day → reset
      if (u.total >= AI_DAILY_LIMIT) return { ok: false, error: "This server's daily AI limit is reached — resets tomorrow." };
      if ((u.byUser[uid] || 0) >= AI_USER_DAILY_LIMIT) return { ok: false, error: "You've reached today's AI limit — resets tomorrow." };
      u.total++; u.byUser[uid] = (u.byUser[uid] || 0) + 1;
      writeJSON(AI_USAGE_PATH, u); // reserve before the call so concurrent requests can't slip past the cap
      return { ok: true };
    } catch { return { ok: false, error: "AI temporarily unavailable" }; }
  });
}

app.post("/api/ai", auth, aiLimiter, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: "AI disabled — no ANTHROPIC_API_KEY in .env" });
  const prompt = String(req.body.prompt || "");
  if (prompt.length > 12000) return res.status(400).json({ error: "Prompt too long" }); // cap runs on the owner's API bill
  const gate = await reserveAi(req.userId);
  if (!gate.ok) return res.status(429).json({ error: gate.error });
  try {
    /* Sonnet 5 thinks adaptively by default and max_tokens caps thinking + answer
       together, so give headroom; effort:low keeps categorization calls cheap. */
    const body = { model: "claude-sonnet-5", max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] };
    if (req.body.search) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) return res.status(502).json({ error: j.error.message });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (!text && j.stop_reason === "refusal") return res.status(502).json({ error: "The AI declined this request — try rephrasing." });
    res.json({ text });
  } catch (e) { console.error("AI proxy error:", e.message); res.status(500).json({ error: "AI request failed" }); }
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

app.post("/api/teller/enroll", auth, async (req, res) => {
  const token = String(req.body?.accessToken || "").trim();
  if (!token) return res.status(400).json({ error: "Missing bank access token" });
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.teller = d.teller || [];
      d.teller.push({
        id: crypto.randomUUID(), accessToken: encSecret(token), // encrypted at rest
        institution: String(req.body.institution || "Bank").slice(0, 60), added: new Date().toISOString().slice(0, 10),
      });
      d._rev = (d._rev || 0) + 1; // server-side writes advance the revision too
      writeData(req.userId, d);
    });
    res.json({ ok: true });
  } catch (e) { console.error("enroll failed:", e.message); res.status(500).json({ error: "Could not save the bank connection" }); }
});

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
          if (amt < 0) {
            d.txns.push({ id: crypto.randomUUID(), tellerId: t.id, accountId: acc.id, kind: "out", date: t.date, amount: Math.round(-amt * 100) / 100, catId: "", note: (t.description || "").slice(0, 60) });
            newTx++;
          } else if (amt > 0 && a.type === "depository") {
            /* deposits imported as income (uncategorized) — delete transfer noise as you see it */
            d.txns.push({ id: crypto.randomUUID(), tellerId: t.id, accountId: acc.id, kind: "in", date: t.date, amount: Math.round(amt * 100) / 100, catId: "", note: (t.description || "").slice(0, 60) });
            newTx++;
          }
        }
      }
      const assets = d.accounts.filter((x) => !DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const debts = d.accounts.filter((x) => DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      d.history = (d.history || []).filter((h) => h.date !== today);
      d.history.push({ date: today, assets, debts, nw: assets - debts });
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
  const r = await fetch(base + "/accounts?start-date=" + start, {
    headers: { authorization: auth, accept: "application/json" },
    signal: AbortSignal.timeout(SIMPLEFIN_TIMEOUT_MS),
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
  if (/credit|card|visa|mastercard|amex/.test(n)) return "Credit card";
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

app.post("/api/simplefin/sync", auth, syncLimiter, async (req, res) => {
  let conns;
  try { conns = readData(req.userId).simplefin || []; }
  catch (e) { console.error("simplefin sync read failed:", e.message); return res.status(500).json({ error: "Could not read your data file" }); }
  if (!conns.length) return res.status(400).json({ error: "No SimpleFIN connection yet" });

  /* PHASE 1 — network, no lock held (a slow sync must not block the browser's autosave) */
  const sets = [];
  const warnings = [];
  try {
    for (const c of conns) {
      const url = decSecret(c.accessToken);
      if (!url) continue; // undecryptable (SESSION_SECRET changed) — skip rather than crash
      const set = await simplefinFetch(url, 120);
      (set.errors || set.errlist || []).forEach((e) => warnings.push(typeof e === "string" ? e : e.msg || "connection error"));
      sets.push(set);
    }
  } catch (e) {
    console.error("simplefin sync error:", e.message);
    return res.status(502).json({ error: e.message });
  }

  /* PHASE 2 — merge into current on-disk state under the lock (brief) */
  let newTx = 0, updAcc = 0, updHold = 0;
  try {
    await withLock("data:" + req.userId, () => {
      const d = readData(req.userId);
      d.accounts = d.accounts || []; d.txns = d.txns || [];
      d.invest = d.invest || { holdings: [], watch: [] };
      d.invest.holdings = d.invest.holdings || []; d.invest.watch = d.invest.watch || [];
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
          const bal = Number(a.balance);
          if (Number.isFinite(bal)) { acc.balance = DEBT.includes(acc.type) ? Math.abs(bal) : bal; updAcc++; }
          for (const t of a.transactions || []) {
            const tid = "sf:" + t.id;
            if (d.txns.some((x) => x.tellerId === tid)) continue;
            const amt = Number(t.amount);
            if (!Number.isFinite(amt) || amt === 0) continue;
            const date = new Date((Number(t.posted) || 0) * 1000).toISOString().slice(0, 10);
            const note = String(t.description || t.payee || "").slice(0, 60);
            if (amt < 0) d.txns.push({ id: crypto.randomUUID(), tellerId: tid, accountId: acc.id, kind: "out", date, amount: Math.round(-amt * 100) / 100, catId: "", note });
            else d.txns.push({ id: crypto.randomUUID(), tellerId: tid, accountId: acc.id, kind: "in", date, amount: Math.round(amt * 100) / 100, catId: "", note });
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
      const assets = d.accounts.filter((x) => !DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const debts = d.accounts.filter((x) => DEBT.includes(x.type)).reduce((s, x) => s + (+x.balance || 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      d.history = (d.history || []).filter((h) => h.date !== today);
      d.history.push({ date: today, assets, debts, nw: assets - debts });
      d.history.sort((x, y) => x.date.localeCompare(y.date));
      d.lastSync = new Date().toISOString();
      d._rev = (d._rev || 0) + 1;
      writeData(req.userId, d);
    });
    res.json({ ok: true, newTx, updAcc, updHold, warnings: warnings.slice(0, 3) });
  } catch (e) { console.error("simplefin merge failed:", e.message); res.status(500).json({ error: "Synced but couldn't save — your existing data was left untouched" }); }
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

/* bind to loopback only — Caddy (same host) is the sole ingress; never listen on a public interface */
const HOST = process.env.HOST || "127.0.0.1";
app.listen(process.env.PORT || 3001, HOST, () =>
  console.log("Cache server on http://" + HOST + ":" + (process.env.PORT || 3001))
);
