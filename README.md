# Atlas — self-hosted money and career, multi-user

> MIT-licensed. Run it on your own server; your financial data never touches
> anyone else's cloud. See `SETUP.md` for the full setup walkthrough.

Two halves that belong together. **Money**: bank sync, budgets, goals, debt
payoff, investments, tax estimation. **Career**: a job finder that polls
employers' own boards, resume and cover-letter tooling, and an application
timeline. They're one app because income is the biggest variable in a budget —
Atlas can tell you what an offer actually does to your runway and goal dates,
which neither half could answer alone.

React + Express. Real bank sync (SimpleFIN, read-only) with automatic
transfer detection (credit-card payments and account-to-account moves never
double-count as spending/income) and auto-categorization (learned from your
history + built-in merchant rules), an Invest tab with live delayed quotes +
watchlist + Fidelity positions-CSV import, AI categorization, budgeting, and
an **Ask Atlas** dashboard assistant that answers questions across all your
data, drafts budgets you can apply in one click, and turns "I'm driving from
Atlanta to Ruston, my car does 24 mpg" into a costed, planned purchase (your
Anthropic key, server-side), a **month-in-review** card (biggest movers,
largest expenses, budget-vs-actual bars, and a recap that writes itself once a
month has closed), a **Merchants** tab that ranks everywhere your money goes
and files a whole merchant's history under a category in one click, full
dashboard with donut breakdowns and click-through income/spending history,
budgets, goals, debt payoff with promo-APR tracking, purchase planner,
subscription radar (auto-detects recurring charges), cross-month transaction
search, and one-click CSV/JSON export. **Installable** — add it to your phone's home screen and it
runs like a native app.

There's also a **Career** tab, because the biggest lever on your finances is
usually your income: track applications with cost-of-living-adjusted comp tiers,
keep up to **five resumes** as real PDFs (previewed in-app, text extracted so you
and the AI can edit it, then rebuilt back into a PDF) so a utilities version and a
consulting version can live side by side, generate a tailored variant aimed at one
specific opening, draft a cover letter per application, and ask what an offer would
actually do to your budget, runway, and goal dates.

Registration is invite-code gated so you can share with friends/family —
every user's data lives in its own file, invisible to other users.

![Atlas dashboard — net-worth trend, cash-flow tiles, category donut](docs/screenshots/Dashboard.png)

**Security:** passkeys (WebAuthn — fingerprint/face/PIN, phishing-resistant)
with one-time recovery codes, and an optional **passkey-only mode** that turns
password sign-in off entirely; scrypt-hashed passwords otherwise, with in-app
password change that revokes every other session; bank access tokens encrypted
at rest (AES-256-GCM); per-user session revocation ("sign out everywhere") and
a login audit trail; CSP + security headers + a same-origin check on all
state-changing requests (CSRF defense-in-depth over SameSite cookies);
rate-limited auth/AI/quotes endpoints with per-account brute-force backoff;
revision-checked saves so two devices can never silently overwrite each other.
Manage all of it from the **Security** panel in-app. See `DEPLOY-ORACLE.md`
for VM hardening + encrypted backups.

**Already deployed?** `SETUP.md` is the step-by-step checklist for getting a
live instance fully configured — passkeys, bank sync, AI key, investments,
backups.

## Screenshots

**Career** — postings pulled straight from ~95 employers' own job boards, never an
aggregator. Each is scored for likelihood, fit and growth against your resume and
your current pay, so a role that pays $46k over your floor but wants three years
you don't have is labelled as exactly that. Star the ones you mean to prioritise
and they pin to the top of every view, above any filter.

![Career — scored postings from employer job boards, with favourites pinned and freshness tracking](docs/screenshots/Career.png)

**Employers worth adding** — Atlas only shows postings from boards it can read, so
an employer it can't reach looks identical to one with no openings. This names the
gaps. *Find board* reads the company's own careers page and adds it automatically;
when that fails, *Search* finds the board URL and you paste it back.

![Employers worth adding — board discovery for employers Atlas cannot yet read](docs/screenshots/Employers.png)

**Life** — a timeline of things that actually happened, derived from your own data:
loans opened, big one-off purchases, extra principal payments, interviews, wins.
Derived events update themselves; only hand-added ones are stored.

![Life — personal timeline derived from your own financial and career data](docs/screenshots/Life.png)

![Accounts — read-only bank sync via SimpleFIN, net-worth history, synced balances](docs/screenshots/Accounts.png)

![Budget — per-category budgets with AI recommend, transaction log with search](docs/screenshots/Budget.png)

![Invest — synced holdings with live values, allocation, watchlist](docs/screenshots/Invest.png)

![Plan — savings goals with pace-to-target, money order of operations, emergency fund and 401k match calculators](docs/screenshots/Plan.png)

![Security — passkeys, one-time recovery codes, passkey-only sign-in, sign-in audit trail and sign out everywhere](docs/screenshots/Security.png)

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
Leave bank sync and AI unconfigured if you just want to click around.

`npm test` runs the logic suite — 62 assertions, no server or browser needed.
It pulls the real functions out of `server/index.js` and `client/src/Career.jsx`
rather than testing a copy, so it fails if the source drifts. It covers the two
bugs that were hardest to see: credit-card payments being counted as both
spending and income (which inflated every total), and short city names
false-matching (`"LA"` matching Dallas, `"York"` matching New York).

1. Open the app → **Create account** — the FIRST account on a fresh server
   needs no invite code. Everyone after that needs `INVITE_CODE`.
2. Add accounts/budgets manually, or connect real banks: sign up at
   https://beta-bridge.simplefin.org ($15/yr), add your institutions, create a
   setup token under **Apps → New Connection**, and paste it into the Accounts
   tab. Nothing goes in `.env`.
3. Add `ANTHROPIC_API_KEY` to test AI categorize / budget recommendations /
   the Plan review.

> **On Teller:** earlier versions of this app synced through Teller. Teller
> withdrew its API product in July 2026 and no longer accepts signups, so
> SimpleFIN Bridge is the supported path. The Teller endpoints remain in the
> server so any existing enrollment keeps working until those servers go dark.

## What syncs, exactly
- Balances for every connected account, on demand (Sync now)
- Spending transactions arrive **pre-categorized where possible** — merchants
  you've categorized before are remembered, common merchants match built-in
  rules, and the **AI categorize** button handles the rest
- Deposits into checking/savings → imported as **income** transactions
- Credit-card payments and transfers between your own accounts are detected
  automatically (payment/transfer keywords, inflows on card accounts, and
  equal-and-opposite pairs across accounts) and marked as **transfers** — kept
  in the ledger but excluded from income and spending, so a $750 card payment
  never counts as $750 spending *and* $750 income on top of the purchases
  themselves. Anything mis-flagged flips back via the type dropdown in Budget.
- Every sync logs a net-worth snapshot for the Dashboard trend
- **Brokerage holdings**: accounts that return a `holdings` array (Fidelity
  does) populate the Invest tab automatically — symbol, shares, cost basis.
  Anything unsupported still works via the Invest tab's positions-CSV import

## Invest tab
- Market strip (S&P 500 / Nasdaq 100 / Dow) with delayed quotes, refreshed
  through the server (nothing third-party runs in the browser)
- Holdings with live value, day change, and gain vs cost basis; allocation
  donut; push the total into any investment account's balance
- **Fidelity / any brokerage**: export Positions as CSV from the brokerage
  site and import — no credentials involved
- Watchlist (stocks, ETFs, `BTC-USD` etc.) and an optional AI market brief
  (web-searched, informational only)

## Beyond the basics
- **Subscription radar** (Budget tab): charges that repeat monthly at a stable
  amount are surfaced automatically — "Watch" one to see it in Upcoming bills
  (without double-logging; the real charges keep arriving via sync/CSV), or
  dismiss it.
- **Search** (Budget tab): type in the search box to look across *all* months
  by note, amount, or category.
- **Insights** (Dashboard): biggest category changes vs last month + largest
  individual expenses in the selected range.
- **Export** (Settings): transactions as CSV, or your complete data as JSON.
  Bank tokens are never included — they never leave the server at all.
- **Change password** (Security panel): requires the current password and
  signs out every other device.
- **Delete account** (Security panel): requires your password *and* your username
  typed back. Removes the user record first — so the data is unreachable the
  instant that write lands — then the data file and every resume PDF. There is no
  undo; export from Settings first if you might want it.

## Application timeline (Career tab)
Knowing *where* to apply is half of it; the other half is **when**. The seed list
always knew the IAM consultancies open Aug–Oct and the tier-3 enterprises open
Jan–Apr, but that lived in a free-text string nothing could act on. It's parsed
now and anchored to your graduation month, sorting every tracked target into
**window closed / closing this month / open now / opens within 2 months / later**.

Campus recruiting is why this matters: full-time pipelines for a May graduate
open the *previous* August and mostly close by Thanksgiving. Miss that quarter
and the good programmes aren't hiring off-cycle in April, however good the
resume is. The timeline says which quarter you're in and how much of it is left.

There's a nudge when targets are open and you haven't applied to anything — and
it goes quiet as soon as something is in flight, because a counter that always
shouts gets ignored.

## Job finder (Career tab)
The server polls ~40 employers' **own public job board APIs** — the same
endpoints their careers pages call — a few times a day, and caches the result.
Greenhouse, Lever, Ashby and Workday adapters; every seeded employer was verified
to return postings before being added. A live run pulls ~500 security and identity
postings in about 30 seconds. LinkedIn and Indeed are deliberately absent: they
block programmatic access and say so. Every link goes to the employer.

Employers on an unguessable Workday tenant are added by pasting their careers URL
(**+ Employer**), which states the tenant exactly where guessing fails ~80% of
the time. Anyone's added employer is polled for everyone.

Two scores, **not** blended into one:
- **Fit** — pay adjusted for cost of living, place (remote scores highest, since
  it makes the city question disappear), category growth rate, IAM focus.
- **Odds** — how far the role is from your rung, how much of your actual resume
  overlaps it, and clearance/experience barriers.

Blending them would hide the case that matters most: a great job you can't get
*yet*, which you want to see rather than have averaged away.

The ladder — intern → entry → mid → senior → lead → principal → director+ — is a
filter, not a cutoff. Nothing is discarded, so the tool still works in ten years.
It defaults to your rung and the one above; your rung is read off your resume by
keywords, or by the AI on request (**Re-check my level**), stored with a date so
a shift is visible rather than guessed at.

**Filters, because 500 postings is a wall, not a feed.** Every posting carries a
role family — IAM/identity, SOC/detection, GRC, AppSec, offensive, cloud, security
engineering — as counted chips, alongside the level ladder, min adjusted pay,
remote, US-only, clearance, stale (60+ days open), and *new since last visit*.
Dismiss anything you don't want to see again.

**Pay for (nearly) everything.** Postings that publish a range are parsed from the
full description. The poll then takes the *median* real pay per category and rung
and fills in the postings that don't publish — an estimate learned from this
corpus, this year, sharpening every poll as more states force disclosure. Where a
band is too thin it falls back across categories, rescaled toward the target's own
market and flagged as rougher: the only three entry postings that publish pay are
at Stripe, Jane Street and Coalfire, so an unscaled median would claim a utility
analyst job pays Bay Area money. 259 of 261 US postings carry a number, from 0.

**Find boards** looks up public job boards for the companies you track: cheap slug
guesses against Greenhouse/Lever/Ashby first, a model call only for the leftovers,
and every candidate fetched and *proven* to return postings before it's offered —
nothing enters the registry on a model's say-so.

**Interview prep** on any applied or interviewing row: reported questions for that
employer where they exist, likely technical questions for the role, the parts of
*your* resume an interviewer will probe, your weakest spot with an honest answer,
and what to ask back.

**Most postings never state a level.** Of 261 US postings in a live run, 174
state a band and 87 don't. Filing those 87 under "mid" made an entry filter show
4 results and imply the entry market was empty. They're tagged **"Level not
stated"** and included by default whenever the ladder filter excludes mid, behind
a visible `+87 unlabelled` toggle — which takes an entry search from 4 postings
to 92. Odds scoring caps the rung gap at 1 for these, since penalising a posting
for the employer's vagueness says nothing true about the candidate.

Known limits, so you don't over-trust it: Workday's list endpoint returns a very
short description, so **clearance detection is unreliable for Workday employers**
(Leidos, CACI) — check the posting. Pay is an estimate unless the posting states
it, and is labelled `est` when it is. Genuinely entry-labelled roles are scarce
outside the August–October new-grad window; that's the market, not a bug.

## Projects (Career tab)
What you built, in your words. Seedable from your public GitHub repos (proxied
through the server, so the page keeps `connect-src 'self'` and GitHub never sees
your IP). Tag each with **best for** — "finance, full-stack" pulls Atlas forward
for a fintech application and leaves it out of a cleared-defense one — and the
pitch line you'd say in an interview, which is the part a repo description can
never give you. Projects feed resume tailoring, cover letters and fit scoring.

## Where you could both work (Career tab)
This tracker started as **Habitat**: it ranked cities by whether a partner could
work in zoos, aquariums, or conservation — not just by what the security job paid.
Every city carries that back now: a partner-market rating and the institutions by
name (Omaha → Henry Doorly; Toledo → Toledo Zoo & Aquarium; Columbia SC →
Riverbanks). Cities are ranked by what your best tracked target there pays *after*
cost of living, filtered to places where the other half of the search is real.
A $125k Bay Area job ranks below a $72k Toledo one, because $125k at COL 180 is
$69k adjusted and $72k at COL 84 is $86k — and Toledo has a top-ranked zoo.
Each application also shows the partner market for its city, since an onsite
offer somewhere only one of you can work is worse than its salary suggests.

## Resumes and cover letters (Career tab)
- Up to **five resumes**, each its own tab with its own stored PDF, its own
  extracted text, and a name you pick ("General", "Utilities", "Consulting").
  The first one is what fit scoring and the assistant read.
- **New tailored resume** picks one of your tracked applications, rewrites the
  current resume against it, builds a PDF, and drops it into a *new* tab — the
  resume you started from is never touched.
- **Cover letter** drafts one per application from your resume and saves it on
  that application. It opens in an editable box, not a send button.
- On the AI-writing question: employers essentially never run AI detectors on
  cover letters — an applicant tracking system parses yours for keywords and a
  human skims it. What loses you the interview is a letter that sounds like every
  other letter. Use the draft for structure and facts, then rewrite it in your
  own voice. The prompt is deliberately tuned against "I am excited to" filler
  for that reason.
- Nothing invented: every prompt forbids adding a job, date, tool, or number that
  isn't already in your resume. Read the output anyway — it's your name on it.
- Resume PDFs are stored `0600` in the same private directory as your finances
  and are covered by the encrypted backups. `.gitignore` keeps them out of git.

## Multi-user model
- `INVITE_CODE` in `.env` gates registration; rotate it anytime
- Each user: separate login, separate `data-<id>.json`, separate bank
  connections; nobody can see anyone else's data
- Passwords are scrypt-hashed; sessions are HMAC-signed httpOnly cookies
- Note: everyone shares YOUR Anthropic key (costs cents, but it's your cents).
  Bank sync is per-user — each person brings their own SimpleFIN token

## Deploying
See **DEPLOY-ORACLE.md** for the full Oracle Cloud walkthrough (systemd +
Caddy HTTPS + Oracle's firewall quirks). Short version for any host: build,
run `npm start`, put HTTPS in front, set `FORCE_SECURE_COOKIE=1`, and point
`DATA_DIR` somewhere persistent that gets backed up.

## Security notes
- Bank login happens at SimpleFIN, not here — your bank credentials never touch
  this app. It only ever holds a read-only access key, encrypted at rest with
  AES-256-GCM and revocable from your SimpleFIN dashboard
- All secrets stay server-side in `.env` (gitignored)
- Never commit `.env`, `server/certs/`, `users.json`, or `data-*.json`
- Back up the data files; they ARE the database
