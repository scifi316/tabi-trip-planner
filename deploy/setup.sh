#!/usr/bin/env bash
# Set up a Tabi server on a fresh Ubuntu 24.04 (or Debian 12) machine.
#
#   Primary (DigitalOcean droplet, Singapore):
#     scp deploy/setup.sh root@<droplet-ip>:   &&   ssh -t root@<droplet-ip> bash setup.sh
#   Backup (a Linux home server):
#     sudo bash setup.sh --role backup --node home
#
# What it does, safely re-runnable:
#   1. adds a 1 GB swap file (Docker builds need it on 1 GB machines)
#   2. installs Docker, git and automatic security updates; turns on time sync
#   3. firewall: blocks every incoming port except SSH (the site arrives through the Cloudflare Tunnel)
#   4. clones the private repo with a read-only GitHub deploy key
#   5. asks for your keys once and writes them to a private .env
#   6. builds and starts Tabi, then checks its health
#
# Values can also be passed as environment variables to skip the questions:
#   ACCESS_KEY, TUNNEL_TOKEN, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, PUBLIC_HOST
set -euo pipefail

ROLE=primary
NODE=""
REPO="git@github.com:scifi316/tabi-trip-planner.git"
BRANCH=main
DIR=/opt/tabi

usage() { sed -n '2,20p' "$0"; echo; echo "Options: --role primary|backup  --node NAME  --repo GIT_URL  --branch NAME  --dir PATH"; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1"; usage 1 ;;
  esac
done
[[ "$ROLE" == primary || "$ROLE" == backup ]] || { echo "--role must be primary or backup"; exit 1; }
[[ -n "$NODE" ]] || NODE=$([[ "$ROLE" == primary ]] && echo "do-sgp1" || echo "home")
COMPOSE_DIR="$DIR/deploy/$([[ "$ROLE" == primary ]] && echo droplet || echo home)"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this as root (or with sudo)."
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu || "${ID:-}" == debian ]] || echo "Warning: tested on Ubuntu 24.04 and Debian 12; you're on ${PRETTY_NAME:-unknown}."

bold "1/6  Swap"
if swapon --show --noheadings | grep -q .; then
  ok "swap already on"
else
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-tabi-swap.conf && sysctl -q -p /etc/sysctl.d/99-tabi-swap.conf
  ok "1 GB swap added"
fi

bold "2/6  Packages, Docker, updates, clock"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw unattended-upgrades openssl >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1
docker compose version >/dev/null || die "Docker Compose plugin is missing."
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
timedatectl set-ntp true 2>/dev/null || true   # the failover lease relies on reasonably accurate clocks
ok "$(docker --version)"

bold "3/6  Firewall (SSH only)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ok "incoming: SSH only. Tabi needs no open ports."

bold "4/6  Code"
KEY=/root/.ssh/tabi_deploy
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
  ok "updated $DIR ($(git -C "$DIR" log -1 --format=%h))"
else
  if [[ "$REPO" == git@* ]]; then
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    [[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "tabi-$NODE" -f "$KEY"
    ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
    echo
    echo "  The repo is private. Give this machine read-only access:"
    echo "  GitHub → scifi316/tabi-trip-planner → Settings → Deploy keys → Add deploy key"
    echo "  Title: tabi-$NODE    Allow write access: leave unticked    Key:"
    echo
    sed 's/^/    /' "$KEY.pub"
    echo
    read -rp "  Press Enter once the key is added… " _ || true
  fi
  GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes" git clone -q -b "$BRANCH" "$REPO" "$DIR" \
    || die "Clone failed. Check the deploy key, or that branch '$BRANCH' exists (merge the pull request first, or pass --branch)."
  git -C "$DIR" config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes"
  ok "cloned into $DIR"
fi

bold "5/6  Settings"
ENV_FILE="$COMPOSE_DIR/.env"
ask() { # name prompt [default] [secret]
  local name=$1 prompt=$2 def=${3:-} secret=${4:-} val=${!1:-}
  if [[ -z "$val" ]]; then
    if [[ -n "$secret" ]]; then read -rsp "  $prompt: " val || true; echo; else read -rp "  $prompt${def:+ [$def]}: " val || true; fi
    val=${val:-$def}
  fi
  printf -v "$name" '%s' "$val"
}
if [[ -f "$ENV_FILE" ]]; then
  ok "keeping existing $ENV_FILE (delete it to start over)"
  PUBLIC_HOST=${PUBLIC_HOST:-$(sed -n 's/^PUBLIC_HOST=//p' "$ENV_FILE" | head -1)}
  ACCESS_KEY=${ACCESS_KEY:-$(sed -n 's/^ACCESS_KEY=//p' "$ENV_FILE" | head -1)}
  PUBLIC_HOST=${PUBLIC_HOST:-your-domain}
else
  echo "  Use the SAME values on the primary and the backup. Docs: docs/HOSTING.md"
  ask PUBLIC_HOST "Public address" "trip.sanechristmas.party"
  ask ACCESS_KEY "Private-link key (Enter to generate one)" ""
  [[ -n "$ACCESS_KEY" ]] || ACCESS_KEY=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
  ask DEV_KEY "Developer console key (Enter to generate one)" ""
  [[ -n "$DEV_KEY" ]] || DEV_KEY=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
  ask TUNNEL_TOKEN "Cloudflare Tunnel token" "" secret
  ask S3_ENDPOINT "R2 endpoint (https://<account-id>.r2.cloudflarestorage.com)" ""
  ask S3_BUCKET "R2 bucket" "tabi"
  ask S3_ACCESS_KEY_ID "R2 access key ID" ""
  ask S3_SECRET_ACCESS_KEY "R2 secret access key" "" secret
  [[ -n "$TUNNEL_TOKEN" && -n "$S3_ENDPOINT" && -n "$S3_ACCESS_KEY_ID" && -n "$S3_SECRET_ACCESS_KEY" ]] \
    || die "The tunnel token and all R2 values are required for failover."
  umask 077
  cat > "$ENV_FILE" <<ENV
# Written by deploy/setup.sh on $(date -u +%F). Keep private.
PUBLIC_HOST=$PUBLIC_HOST
HA_NODE=$NODE
ACCESS_KEY=$ACCESS_KEY
DEV_KEY=$DEV_KEY
TUNNEL_TOKEN=$TUNNEL_TOKEN
S3_ENDPOINT=$S3_ENDPOINT
S3_BUCKET=$S3_BUCKET
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
S3_REGION=auto
S3_PREFIX=tabi/
SESSION_DAYS=180
ENV
  ok "saved $ENV_FILE (readable by root only)"
fi

bold "6/6  Build and start (first build takes a few minutes)"
cd "$COMPOSE_DIR"
docker compose up -d --build --quiet-pull
docker image prune -f >/dev/null
health=""
for _ in $(seq 1 30); do
  health=$(docker compose exec -T tabi wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null || true)
  [[ -n "$health" ]] && break
  sleep 2
done
[[ -n "$health" ]] || die "Tabi didn't answer its health check. See: cd $COMPOSE_DIR && docker compose logs"
role=$(sed -n 's/.*"role":"\([a-z]*\)".*/\1/p' <<<"$health")
ok "Tabi is up on $NODE as $ROLE (currently: ${role:-unknown})"

cat <<DONE

  Next:
    • Logs:     cd $COMPOSE_DIR && docker compose logs -f
    • Update:   bash $DIR/deploy/update.sh
    • Status:   curl -s https://$PUBLIC_HOST/healthz
DONE
if [[ "$ROLE" == primary ]]; then
  cat <<DONE
    • Open https://$PUBLIC_HOST/?key=$ACCESS_KEY to create the trip (keep this link private).
    • Developer console: https://$PUBLIC_HOST/dev?devkey=\$DEV_KEY (key in $ENV_FILE)
    • Then set up the backup with the same values: docs/HOSTING.md, step 6.

DONE
fi
