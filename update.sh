#!/usr/bin/env bash
# Atlas one-line updater for the VM:
#
#   curl -fsSL https://raw.githubusercontent.com/SageHargrove/Atlas/main/update.sh | sudo bash
#
# Fetches main from GitHub as a tarball (the repo is public, so no key is
# needed on the server), unpacks it over the app directory exactly the way
# SETUP.md's scp flow does — .env, node_modules and the data directory are
# not in the archive and are untouched — then rebuilds and restarts the
# service. Safe to re-run any time; this is how "update Atlas from a phone"
# is meant to work, in Termius or pasted into the Oracle console's
# Run Command box (which is already root; plain `| bash` is fine there).
set -euo pipefail

APP="${ATLAS_APP_DIR:-/home/ubuntu/cache-app}"
SVC="${ATLAS_SERVICE:-cache}"
TARBALL_URL="https://github.com/SageHargrove/Atlas/archive/refs/heads/main.tar.gz"

[ -d "$APP" ] || { echo "No app directory at $APP — set ATLAS_APP_DIR if it lives elsewhere." >&2; exit 1; }

fetch_and_build() {
  cd "$1"
  curl -fsSL "$2" -o /tmp/atlas-update.tgz
  tar xzf /tmp/atlas-update.tgz -C "$1" --strip-components=1
  npm install
  npm run build
}

OWNER_USER="$(stat -c %U "$APP")"
if [ "$(id -u)" = 0 ] && [ "$OWNER_USER" != root ]; then
  # root (sudo bash, or Oracle Run Command): build as the app's owner so the
  # working tree does not end up root-owned, then restart directly
  sudo -u "$OWNER_USER" bash -c "$(declare -f fetch_and_build); fetch_and_build '$APP' '$TARBALL_URL'"
  systemctl restart "$SVC"
else
  fetch_and_build "$APP" "$TARBALL_URL"
  sudo systemctl restart "$SVC"
fi

echo "Atlas updated and restarted ($(date -u +%FT%TZ))."
