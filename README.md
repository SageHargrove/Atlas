# Cache — self-hosted personal finance, multi-user

React + Express. Real bank sync (Teller, read-only), AI categorization and
budgeting (your Anthropic key, server-side), full dashboard, budgets, goals,
debt payoff with promo-APR tracking, purchase planner. Registration is
invite-code gated so you can share with friends/family — every user's data
lives in its own file, invisible to other users.

**Security:** passkeys (WebAuthn — fingerprint/face/PIN, phishing-resistant)
with one-time recovery codes; scrypt-hashed passwords as a fallback; bank
access tokens encrypted at rest (AES-256-GCM); per-user session revocation
("sign out everywhere") and a login audit trail; CSP + security headers;
rate-limited auth and AI endpoints. Manage all of it from the **Security**
panel in-app. See `DEPLOY-ORACLE.md` for VM hardening + encrypted backups.

## Test locally first (do this before deploying)

```
npm install
cp .env.example .env      # macOS/Linux — then edit it
npm run dev               # app at http://localhost:5173
```

On Windows PowerShell, the copy step is:

```
copy .env.example .env
```

`npm run dev` fails with `EADDRINUSE` if an older copy of the server is still
running on port 3001 — close that terminal (or `Stop-Process`) and rerun.
The server reads `.env` once at startup, so restart it after editing.

Minimum .env to test: set `SESSION_SECRET` and `INVITE_CODE` to anything.
Leave Teller in `sandbox` and AI blank if you just want to click around.

1. Open the app → **Create account** — the FIRST account on a fresh server
   needs no invite code. Everyone after that needs `INVITE_CODE`.
2. Add accounts/budgets manually, or test bank sync in sandbox:
   set `TELLER_APP_ID` from https://teller.io (free), keep `TELLER_ENV=sandbox`,
   click Connect a bank on the Accounts tab, log in with Teller's fake
   credentials (username `username`, password `password`), then Sync now.
3. Add `ANTHROPIC_API_KEY` to test AI categorize / budget recommendations /
   the Plan review.

When it all looks right, switch to real banks: download your Teller
**certificate + private key** into `server/certs/`, set the paths in `.env`,
and change `TELLER_ENV=development` (Teller's free personal tier).

## What syncs, exactly
- Balances for every connected account, on demand (Sync now)
- Spending transactions (negative amounts) → arrive **uncategorized**;
  assign inline or hit **AI categorize**
- Deposits into checking/savings → imported as **income** transactions.
  Transfers between your own accounts will show up here too — delete the
  noise; income math only counts what you keep.
- Every sync logs a net-worth snapshot for the Dashboard trend
- **Fidelity / investment accounts aren't covered by Teller** — keep them
  manual and update balances monthly

## Multi-user model
- `INVITE_CODE` in `.env` gates registration; rotate it anytime
- Each user: separate login, separate `data-<id>.json`, separate bank
  connections; nobody can see anyone else's data
- Passwords are scrypt-hashed; sessions are HMAC-signed httpOnly cookies
- Note: everyone shares YOUR Anthropic key (costs cents, but it's your cents)
  and YOUR Teller app (free tier limits total enrollments)

## Deploying
See **DEPLOY-ORACLE.md** for the full Oracle Cloud walkthrough (systemd +
Caddy HTTPS + Oracle's firewall quirks). Short version for any host: build,
run `npm start`, put HTTPS in front, set `FORCE_SECURE_COOKIE=1`, and point
`DATA_DIR` somewhere persistent that gets backed up.

## Security notes
- Bank login happens on the bank's own page via Teller Connect — credentials
  never touch this app; tokens are read-only and revocable in your Teller
  dashboard
- All secrets stay server-side in `.env` (gitignored)
- Never commit `.env`, `server/certs/`, `users.json`, or `data-*.json`
- Back up the data files; they ARE the database
