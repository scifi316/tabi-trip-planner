#!/usr/bin/env bash
# Pull the latest code and rebuild. Run on each server (primary first, then the backup).
#   bash /opt/tabi/deploy/update.sh
#
# Your data is safe across updates:
#   • the database lives in deploy/<role>/data on the host, outside the container, and is reused as-is;
#   • new versions only ever add tables or columns, never remove them;
#   • before rebuilding, this script saves a consistent copy of the database to data/backups/;
#   • the serving node uploads a final snapshot to R2 when it stops and keeps its lease,
#     so a quick rebuild doesn't trigger a failover.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
git pull -q --ff-only
echo "Now at $(git log -1 --format='%h %s')"

for d in deploy/droplet deploy/home; do
  [[ -f "$d/.env" ]] || continue
  cd "$DIR/$d"

  # 1. Safety copy of the live database (consistent even while running), keep the last 10
  if docker compose ps --status running --services 2>/dev/null | grep -qx tabi && [[ -f data/tabi.db ]]; then
    stamp=$(date -u +%Y%m%d-%H%M%S)
    if docker compose exec -T tabi node -e "
      const fs=require('fs'); fs.mkdirSync('/data/backups',{recursive:true});
      const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/data/tabi.db').exec(\"VACUUM INTO '/data/backups/tabi-$stamp.db'\");" 2>/dev/null; then
      echo "Saved a backup: $d/data/backups/tabi-$stamp.db"
      find data/backups -name 'tabi-*.db' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm -f
    else
      echo "Note: couldn't make a backup copy (is this node on standby?). Continuing; R2 snapshots still cover you."
    fi
  fi

  # 2. Settings added in newer versions
  if ! grep -q '^DEV_KEY=' .env; then
    key=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
    printf '\n# Developer console (added by update.sh). Use the same value on every server.\nDEV_KEY=%s\n' "$key" >> .env
    echo "Added a developer console key to $d/.env. Copy this DEV_KEY line to your other server's .env too."
  fi

  # 3. Rebuild and restart
  docker compose up -d --build --quiet-pull
  echo "Restarted $(basename "$d")"
  cd "$DIR"
done
docker image prune -f >/dev/null
