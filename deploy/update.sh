#!/usr/bin/env bash
# Pull the latest code and rebuild. Run on each server (primary first, then the backup).
#   bash /opt/tabi/deploy/update.sh
# The running node uploads a final snapshot when it stops and keeps its lease, so a quick
# rebuild doesn't trigger a failover.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
git pull -q --ff-only
echo "Now at $(git log -1 --format='%h %s')"
for d in deploy/droplet deploy/home; do
  if [[ -f "$d/.env" ]]; then
    (cd "$d" && docker compose up -d --build --quiet-pull)
    echo "Restarted $(basename "$d")"
  fi
done
docker image prune -f >/dev/null
