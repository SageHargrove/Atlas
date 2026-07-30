# Deploying Cache on Oracle Cloud

Assumes an Ubuntu VM (works fine on the Always Free ARM shape, and can share
a VM with other services â€” it only needs ~150MB RAM).

## 1. Open the firewall â€” BOTH layers
Oracle has two firewalls and forgetting the second is the classic trap.

**a) VCN Security List** (Oracle console): your instance's subnet â†’ Security
List â†’ add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.

**b) On the VM itself** â€” Oracle's Ubuntu images ship restrictive iptables:
```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 2. Node + app
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# upload the repo (scp/rsync/git), then:
cd cache-app
npm install
npm run build
```

## 3. Configure
```
cp .env.example .env && nano .env
```
Set: `SESSION_SECRET` (long random â€” also encrypts bank tokens at rest, so keep
it stable), `INVITE_CODE`, `TELLER_APP_ID`, `TELLER_ENV=development`, cert paths,
`ANTHROPIC_API_KEY`, and add:
```
FORCE_SECURE_COOKIE=1
NODE_ENV=production
DATA_DIR=/home/ubuntu/cache-data
RP_ID=atlas.YOUR-IP.nip.io
RP_ORIGIN=https://atlas.YOUR-IP.nip.io
```
`NODE_ENV=production` makes the server refuse to start without a strong
`SESSION_SECRET`. `RP_ID`/`RP_ORIGIN` must match the exact hostname you serve
from (below) or passkeys silently fail â€” `RP_ID` is the bare domain, `RP_ORIGIN`
the full `https://` origin.
`mkdir -p /home/ubuntu/cache-data` â€” keeping data outside the repo means
you can update code by re-uploading without touching anyone's data.
Upload your Teller cert + key to the paths you set (`scp` them; never git).

## 4. Run it as a service
```
sudo tee /etc/systemd/system/cache.service << 'UNIT'
[Unit]
Description=Cache finance app
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/cache-app
ExecStart=/usr/bin/npm start
Restart=always
User=ubuntu
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now cache
```

## 5. HTTPS with Caddy (required â€” secure cookies + Teller want it)
You need a domain name; a free DuckDNS subdomain pointed at your VM's public
IP works great.
```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

echo 'yourname.duckdns.org {
    reverse_proxy localhost:3001
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
The apt package reads `/etc/caddy/Caddyfile` â€” not `/etc/Caddyfile`. Writing
the wrong path leaves Caddy serving its default welcome page and you'll chase
it for an hour.
Caddy fetches and renews the TLS certificate automatically. Open
`https://yourname.duckdns.org` on your phone â€” create the first account
(no invite needed), and hand the invite code to family.

## Sharing the VM with another app

Nothing here needs its own instance â€” Cache is ~150MB of RAM and one port, so
put it on a VM you already have. That uses no additional Always Free resources
(no new compute, block volume, or public IP), so it can't change your bill.

Give each app its own hostname (DuckDNS allows several subdomains, all
pointing at the same IP) and let one Caddy front both:
```
tower.duckdns.org {
    reverse_proxy localhost:8080
}
cache.duckdns.org {
    reverse_proxy localhost:3001
}
```
Caddy issues a separate certificate per hostname automatically. Two rules:
- Only Caddy binds 80/443. The other app keeps its own local port and is
  reached only through the proxy.
- Make sure `PORT` in `.env` doesn't collide with the neighbour
  (`sudo ss -tlnp` lists what's already listening).

**On a 1GB shape (VM.Standard.E2.1.Micro), `npm run build` can get OOM-killed**
â€” Vite is the memory-hungry step, not the running server. Either add swap:
```
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
or run `npm run build` on your laptop and upload `client/dist/` â€” the server
serves that directory when it exists, so the VM never has to build.

## 6. Encrypted backups
The entire database is `users.json` + `data-*.json` in `DATA_DIR`. Bank tokens
inside are already encrypted, but back up to an **encrypted** archive so a
stray backup file never leaks financial data. Pick a long passphrase and store
it somewhere other than the VM:
```
printf 'YOUR-LONG-BACKUP-PASSPHRASE' | sudo tee /root/.cache-backup-pass >/dev/null
sudo chmod 600 /root/.cache-backup-pass
sudo crontab -e
# daily 3am, 7-day rotation, AES-256 encrypted:
0 3 * * * tar czf - -C /home/ubuntu cache-data | openssl enc -aes-256-cbc -pbkdf2 -pass file:/root/.cache-backup-pass -out /home/ubuntu/cache-backup-$(date +\%u).tar.gz.enc
```
Restore with: `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/.cache-backup-pass -in cache-backup-N.tar.gz.enc | tar xzf - -C /restore/dir`.
For off-box safety, `scp` the `.enc` files somewhere else periodically.

## 6b. Connecting real banks (Teller go-live)

Sandbox uses fake data and needs no certificates. Real banks need a Teller
application plus a client certificate (mutual TLS).

**1. Create the Teller app** â€” sign up at <https://teller.io>, then in the
dashboard create an application. Note the **Application ID** (`app_...`).

**2. Download the certificate + private key.** In the Teller dashboard under
your application's **Certificates** section, generate and download:
`certificate.pem` and `private_key.pem`. These are the credentials that prove
your server is you â€” treat them like passwords.

**3. Put them OUTSIDE the repo.** The repo directory gets replaced on every code
update, which would delete anything stored inside it:
```
mkdir -p /home/ubuntu/cache-secrets && chmod 700 /home/ubuntu/cache-secrets
# from your laptop:
scp -i <your-key> certificate.pem private_key.pem ubuntu@<server-ip>:/home/ubuntu/cache-secrets/
# back on the server:
chmod 600 /home/ubuntu/cache-secrets/*.pem
```

**4. Point `.env` at them (absolute paths) and switch environment:**
```
TELLER_APP_ID=app_xxxxxxxxxxxx
TELLER_ENV=development
TELLER_CERT_PATH=/home/ubuntu/cache-secrets/certificate.pem
TELLER_KEY_PATH=/home/ubuntu/cache-secrets/private_key.pem
```
`development` = real banks, free tier (limited enrollments). `production`
requires Teller's paid plan. Then `sudo systemctl restart cache`.

**5. Connect a bank** â€” open the app â†’ Accounts â†’ *Connect a bank* â†’ pick your
institution â†’ log in with your real bank credentials. Those credentials go
directly to Teller and never touch this server; Cache only ever receives an
access token, which it encrypts before storing.

**Not every institution is supported** (Teller covers most major banks; many
brokerages like Fidelity are not). For anything unsupported, use the CSV import
under Budget â€” download the CSV from the institution's site and import it. That
path involves no stored credentials at all.

**Rotation:** if a cert is ever exposed, revoke it in the Teller dashboard,
download a new pair, replace the files, and restart. If you change
`SESSION_SECRET`, every stored bank token becomes undecryptable and each user
must reconnect their banks.

## 7. Harden the VM (SSH + fail2ban)
Cache's app-level rate limiting stops password/passkey brute-force *in the app*;
these protect the box itself.

**Key-only SSH** â€” you already log in with your key, so turn off password auth
so the internet can't guess its way in:
```
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```
(Confirm you can still open a **second** SSH session before closing this one.)

**fail2ban** â€” bans IPs that hammer SSH:
```
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

**Finish the stalled security updates.** That wedged `apt` was a hung update â€”
once the lock is cleared (`sudo kill -9 <pid>` from the earlier step):
```
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

## Updating the app later
Re-upload the repo (or git pull), then:
```
cd cache-app && npm install && npm run build && sudo systemctl restart cache
```
Data is untouched because it lives in DATA_DIR.
