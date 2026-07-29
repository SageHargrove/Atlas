# Atlas — setup checklist

Your instance: **https://cache.YOUR-SERVER-IP.nip.io** · VM `YOUR-SERVER-IP` · app in
`/home/ubuntu/cache-app` · data in `/home/ubuntu/cache-data` · service `cache`.

Work top to bottom. Steps 1–3 are required; 4–6 are the features you want;
7–8 are the "don't lose it / don't get owned" chores.

---

## 1. Push the new code to the server

Run this from **Git Bash** in the repo folder on your PC (`git archive` ships
only committed files — no `node_modules`, no `.env`, no data, 90KB):

```bash
git archive --format=tar.gz -o atlas.tar.gz HEAD
scp atlas.tar.gz ubuntu@YOUR-SERVER-IP:/tmp/
```

Then on the server:

```bash
ssh ubuntu@YOUR-SERVER-IP
cd /home/ubuntu/cache-app
tar xzf /tmp/atlas.tar.gz          # your .env and data are untouched
npm install
npm run build
sudo systemctl restart cache
```

If `npm run build` gets killed (low-RAM shape), build on your PC with
`npm run build`, then `scp -r client/dist ubuntu@YOUR-SERVER-IP:/home/ubuntu/cache-app/client/`
and skip the build on the server — it serves `client/dist` when it exists.

Check it worked: open the site, you should see **Atlas** and an **Invest** tab.

---

## 2. Fix `.env` — this is what makes passkeys work

```bash
nano /home/ubuntu/cache-app/.env
```

**`RP_ID` and `RP_ORIGIN` are almost certainly missing** (they were added to
`.env.example` after your first deploy). Without them the server thinks it's
`localhost` and **every passkey silently fails**. Make sure all of this is present:

```
SESSION_SECRET=<long random — you already have one; NEVER change it>
INVITE_CODE=<change this now — see below>
RP_ID=cache.YOUR-SERVER-IP.nip.io
RP_ORIGIN=https://cache.YOUR-SERVER-IP.nip.io
NODE_ENV=production
FORCE_SECURE_COOKIE=1
DATA_DIR=/home/ubuntu/cache-data
PORT=3001
```

Generate a fresh invite code and paste it in as `INVITE_CODE`:

```bash
node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))"
```

Then `sudo systemctl restart cache`. **The server reads `.env` only at startup** —
no restart, no change.

> ⚠️ **Never change `SESSION_SECRET`.** It derives the encryption key for your
> bank tokens. Changing it = every bank must be reconnected and every session
> and recovery code dies.

### Optional, but decide it NOW: a stable hostname
`cache.YOUR-SERVER-IP.nip.io` contains your IP. If Oracle ever gives you a new
IP, the hostname changes — and **passkeys are bound to the hostname, so they'd
all break.** A free [DuckDNS](https://www.duckdns.org) subdomain (e.g.
`liam-atlas.duckdns.org`) stays the same forever; you just repoint it. If you
want that, do it *before* step 3: add the subdomain at duckdns.org → point it at
`YOUR-SERVER-IP` → put that hostname in the Caddyfile
(`sudo nano /etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`) → update
`RP_ID`/`RP_ORIGIN` to match → restart. Otherwise ignore this and move on.

---

## 3. Lock down your login (the important one)

In the app → **Security**:

1. **+ Add a passkey** on your laptop (Windows Hello / fingerprint / PIN).
2. Open the site **on your phone** and add a passkey there too. Two devices
   means losing one isn't a crisis.
3. **Generate codes** → save the 10 recovery codes somewhere offline — password
   manager, or written down in a drawer. Not in the app, not on the VM.
4. **Go passkey-only.** Password sign-in is now refused entirely, even with the
   correct password. Only your passkeys and those recovery codes work.

If the "Add a passkey" button errors or the browser prompt never appears, step 2
isn't done right — recheck `RP_ID`/`RP_ORIGIN`.

---

## 4. AI features (categorization, budget suggestions, market brief)

1. Sign up at **https://console.anthropic.com**
2. **Settings → API keys → Create Key**, copy it (starts `sk-ant-`)
3. Add to `.env`: `ANTHROPIC_API_KEY=sk-ant-...` → `sudo systemctl restart cache`

Costs pennies per use, and the server caps it at 200 calls/day total
(`AI_DAILY_LIMIT`) so nothing can run away with your bill. You'll need to put a
small amount of credit on the account — $5 lasts a very long time at this volume.

---

## 5. Bank sync (SimpleFIN Bridge)

> **Teller is gone.** Teller withdrew its API product in July 2026 ("not able to
> attract enough large customers"), and there is no longer any way to sign up —
> the site is sign-in only. Atlas now uses **SimpleFIN Bridge**, which is built
> for exactly this use case: read-only, personal-scale, self-hosted budgeting
> tools. Nothing goes in `.env` — you paste a token in the app.

**Cost:** $1.50/month or **$15/year**, up to 25 institutions.

1. Go to **https://beta-bridge.simplefin.org/** → **Get Started** → enter your
   email → click the login link they email you → accept the terms.
2. **Financial Institutions → New Connection** → log in at your bank. (A
   subscription is required before the first bank can be added.)
3. **Apps → New Connection** → name it `Atlas` → **Create Setup Token**.
4. Copy the token, then in Atlas → **Accounts** → paste it into
   *Connect your banks* → **Connect**. It syncs immediately.

Setup tokens are **one-time use** — if you need to reconnect, generate a new one.
Your bank credentials go to SimpleFIN, never to your server; Atlas only ever
holds a read-only access key, encrypted at rest, revocable from the SimpleFIN
dashboard.

**Brokerages** (Fidelity, etc.) aren't covered by bank sync — use the Invest
tab's positions-CSV import instead (step 6).

---

## 6. Investments (Fidelity and any other brokerage)

No brokerage offers a free consumer API, so Atlas uses CSV import — one click,
no credentials stored anywhere.

1. Log in at **https://www.fidelity.com**
2. **Accounts & Trade → Portfolio → Positions**
3. Click the **download/export icon** above the positions table → saves a CSV
4. Atlas → **Invest** → *Import positions CSV* → pick the file

It reads Symbol / Quantity / Cost Basis, skips the cash and footer rows, and
pulls live prices. Re-import anytime to update share counts — it updates
existing tickers instead of duplicating them. Use **"Push value to account"** to
write the total into your Fidelity account balance so net worth stays right.

You can also just type tickers in manually, and add anything to the **Watchlist**
(stocks, ETFs, or crypto like `BTC-USD`).

---

## 7. Backups — do this before you have data you'd miss

Your entire database is `users.json` + `data-*.json` in `/home/ubuntu/cache-data`.
Encrypted daily backup, 7-day rotation:

```bash
printf 'PICK-A-LONG-PASSPHRASE' | sudo tee /root/.cache-backup-pass >/dev/null
sudo chmod 600 /root/.cache-backup-pass
sudo crontab -e
```

Add this one line:

```
0 3 * * * tar czf - -C /home/ubuntu cache-data | openssl enc -aes-256-cbc -pbkdf2 -pass file:/root/.cache-backup-pass -out /home/ubuntu/cache-backup-$(date +\%u).tar.gz.enc
```

**Store that passphrase somewhere other than the VM** — with your recovery codes.
Periodically copy a `.enc` file to your PC so a dead VM isn't a total loss.

You can also grab a backup from inside the app anytime: **Settings → Download
backup (JSON)**.

---

## 8. Harden the VM

```bash
# key-only SSH (confirm a SECOND ssh session works before closing this one)
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# ban IPs that hammer SSH
sudo apt-get install -y fail2ban && sudo systemctl enable --now fail2ban

# security updates
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades
```

---

## Updating Atlas later

Same as step 1, every time:

```bash
git archive --format=tar.gz -o atlas.tar.gz HEAD
scp atlas.tar.gz ubuntu@YOUR-SERVER-IP:/tmp/
ssh ubuntu@YOUR-SERVER-IP 'cd /home/ubuntu/cache-app && tar xzf /tmp/atlas.tar.gz && npm install && npm run build && sudo systemctl restart cache'
```

Data lives in `DATA_DIR`, outside the repo — updates never touch it.

## When something breaks

```bash
sudo systemctl status cache          # is it running?
sudo journalctl -u cache -n 50       # what did it say?
sudo systemctl restart cache
```

Most common cause: a `.env` change without a restart, or a typo in `RP_ID`.
