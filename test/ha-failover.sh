#!/usr/bin/env bash
# Failover drill against a local mock of R2: primary dies, backup takes over, primary takes back.
# Usage: bash test/ha-failover.sh
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d)
PIDS=()
cleanup() { kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
node test/mock-s3.mjs > "$T/s3.log" 2>&1 &
PIDS+=($!)
sleep 0.5
run() { # name port priority
  HA_MODE=on HA_NODE=$1 HA_PRIORITY=$3 PORT=$2 DATA_DIR="$T/data-$1" \
  S3_ENDPOINT=http://localhost:9500 S3_BUCKET=tabi S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=y \
  HA_LEASE_TTL_MS=3000 HA_RENEW_MS=1000 HA_GRACE_MS=1500 HA_BACKUP_EXTRA_MS=1500 HA_FAILBACK_MS=5000 HA_SNAPSHOT_MS=1000 \
  node --disable-warning=ExperimentalWarning server/index.js >> "$T/$1.log" 2>&1 &
  LAST=$!; PIDS+=("$LAST")
}
role() { curl -s "localhost:$1/healthz" | grep -o '"role":"[a-z]*"' | cut -d'"' -f4; }
wait_for() { for i in $(seq 1 30); do [ "$(role "$1")" = leader ] && { echo "  $2 after ${i}s"; return 0; }; sleep 1; done; echo "  FAILED: $2"; exit 1; }
run primary 8101 primary; P=$LAST; sleep 1.5; run home 8102 backup; sleep 2
curl -s -c "$T/c" -H 'Content-Type: application/json' -d '{"tripName":"HA","name":"Test","password":"secret1"}' localhost:8101/api/setup >/dev/null
sleep 2
echo "kill -9 primary"; kill -9 "$P"; wait "$P" 2>/dev/null; wait_for 8102 "backup took over"
if curl -s -b "$T/c" localhost:8102/api/status | grep -q '"signedIn":true'; then echo "  session survived failover"; else echo "  FAILED: session lost"; exit 1; fi
echo "restart primary"; run primary 8101 primary; wait_for 8101 "primary took back over"
echo "OK"
