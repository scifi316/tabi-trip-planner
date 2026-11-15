# Hosting Tabi: cloud primary, home server backup

This guide puts Tabi on your own domain behind a private link. A small cloud machine in Tokyo serves it, and your home server takes over automatically if that machine goes down.

```
 phones ──https──▶ Cloudflare (your domain, TLS, private-link check by the app)
                      │
                      │  Cloudflare Tunnel: outbound only, no open ports anywhere
          ┌───────────┴────────────┐
          ▼ (only the leader       ▼  connects its tunnel)
   Fly.io machine, Tokyo     Home server (Docker)
   HA_PRIORITY=primary       HA_PRIORITY=backup
          │                        │
          └──── Cloudflare R2 ─────┘
                lease.json            who is serving right now
                db/latest.sqlite.gz   database snapshot, taken when data changes (≈15 s)
                db/history/…          hourly snapshots
                blobs/…               receipt photos
```

## How failover works

1. Both machines run the same Docker image. Each one tries to take a **lease**, a small file in R2 written with an atomic compare-and-swap.
2. The machine holding the lease opens the database, starts its Cloudflare Tunnel connector and serves the site. It renews the lease every 10 seconds and uploads a database snapshot whenever data changes.
3. The other machine waits on standby. Its health check passes, but it serves nothing and runs no tunnel.
4. **If the primary dies**, its lease expires. The backup waits about a minute after the last renewal, restores the newest snapshot, connects its tunnel and starts serving.
5. **When the primary is back** and has been up for 2 minutes, it asks for its role back. The backup uploads a final snapshot, hands over the lease and restarts into standby. The site is down for about 10 to 20 seconds during the swap.
6. **If a leader can't reach R2** for about 20 seconds, it stops serving on its own. This guarantees two copies never run at once. It resumes when R2 is reachable again.

What your friends notice: phones keep the plan cached, so the app stays usable during a switch. Votes, edits and new expenses are queued and sent when the connection returns. Sign-ins carry over, because sessions are stored in the database.

At most about 15 seconds of edits can be lost, and only if the primary crashes hard. Graceful restarts and deploys upload a final snapshot first.

## What it costs

| Piece | Cost |
|---|---|
| Domain on Cloudflare Registrar | At cost, about $10–12 a year for a `.com` |
| Fly.io `shared-cpu-1x` with 512 MB in Tokyo, plus a 1 GB volume | About $4 a month (256 MB also works and is about $2.40) |
| Cloudflare Tunnel | Free |
| Cloudflare R2 | Free tier (10 GB) covers this easily |
| Home server | Whatever you already run Docker on (a PC, NAS, Raspberry Pi 4 or 5) |

## Setup

You need a Cloudflare account, a Fly.io account (a card is required) and Docker on the home server. Allow about 45 minutes.

### 1. Domain

In the Cloudflare dashboard, go to **Domain Registration → Register Domains** and buy a domain. Cloudflare sells at cost. If you already own a domain elsewhere, add it to Cloudflare and switch its nameservers instead.

You'll serve the app on a subdomain, for example `trip.example.com`.

### 2. R2 bucket and keys

1. Go to **R2 Object Storage**, create a bucket named `tabi`, and choose the Asia-Pacific location hint.
2. Go to **R2 → Manage API tokens → Create API token**. Choose *Object Read & Write* and limit it to the `tabi` bucket.
3. Copy the **Access Key ID**, the **Secret Access Key**, and the **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
4. Optional: add a lifecycle rule that deletes `tabi/db/history/` objects after 30 days.

### 3. Tunnel

1. Go to **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared** and name it `tabi`.
2. On the install screen, copy the **token**: the long string after `--token` in any of the install commands. You don't need to install anything; the Tabi image runs cloudflared itself.
3. Under **Public hostname**, set:
   - Subdomain: `trip`
   - Domain: `example.com`
   - Service type: `HTTP`
   - URL: `localhost:8080`

### 4. Secret key for the private link

```bash
openssl rand -base64 24        # e.g. 3q2+7w8hVYc0m5nE8xTqWk1Lw0yZ
```

Without this key the site answers *Not found* to everyone. The link you send friends is `https://trip.example.com/?key=<that key>`.

After someone opens that link once, their browser remembers it for 400 days. The app's own invite link and home-screen icon carry a derived token, so friends never need the raw key again.

### 5. Primary on Fly.io (Tokyo)

```bash
# Install flyctl: https://fly.io/docs/flyctl/install/
fly auth login
cd tabi-trip-planner
# Edit fly.toml: set `app` to a unique name (for example tabi-<yourname>)
fly launch --no-deploy --copy-config
fly volumes create tabi_data --region nrt --size 1
fly secrets set \
  ACCESS_KEY='<key from step 4>' \
  TUNNEL_TOKEN='<token from step 3>' \
  S3_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com' \
  S3_BUCKET='tabi' \
  S3_ACCESS_KEY_ID='<from step 2>' \
  S3_SECRET_ACCESS_KEY='<from step 2>'
fly deploy
fly logs     # look for: "[ha] fly-tokyo is now the leader" and the tunnel connecting
```

Open `https://trip.example.com/?key=<key>` and create the trip.

### 6. Backup on the home server

```bash
git clone https://github.com/<you>/tabi-trip-planner.git
cd tabi-trip-planner/deploy/home
cp ../../.env.example .env
# Fill in the SAME ACCESS_KEY, TUNNEL_TOKEN and S3_* values as on Fly
docker compose up -d --build
docker compose logs -f     # look for: "[ha] home (backup) waiting for the lease"
```

The home server only needs outbound internet. Don't open any ports on your router.

### 7. Test failover once before you fly

```bash
fly machine list
fly machine stop <machine-id>     # simulate the primary dying
# about 1 minute later the home server logs "home is now the leader"; the site keeps working
fly machine start <machine-id>
# about 2 minutes later the primary asks for its role back and the home server hands over
```

Check which machine is serving at any time:

```bash
curl -s https://trip.example.com/healthz     # {"ok":true,"role":"leader","node":"fly-tokyo",...}
```

## Sessions and security

- **Sign-in** uses an HttpOnly, Secure, SameSite=Lax cookie. Only a SHA-256 hash of each session token is stored, in the database, so sessions survive restarts and failovers.
- **Session lookups** are cached in memory for 5 minutes.
- **Expiry:** sessions slide forward with use and expire after 180 days of inactivity (`SESSION_DAYS`).
- **Sign-outs:** changing your password signs out your other devices. *Settings → Signed-in devices* shows every session and can sign out the others.
- **Cross-site protection:** requests that change data, and the WebSocket, are refused when they come from another site.
- **Rate limits:** sign-in and join attempts are limited per IP. Behind the tunnel, the real IP comes from `CF-Connecting-IP`.
- **Optional extra lock:** you can put **Cloudflare Access** (email one-time codes, free for up to 50 users) in front of the hostname. If you do, add a bypass policy for `/api/owntracks`, because the OwnTracks app can't log in to Access.

## Restoring an older backup

```bash
# List hourly snapshots in R2 (dashboard, or rclone/aws-cli), then:
docker compose stop                     # or: fly machine stop
gunzip -c 2026-11-20T10-00-00-000Z.sqlite.gz > data/tabi.db
rm -f data/tabi.db-wal data/tabi.db-shm data/ha-state.json
# Upload it as the newest snapshot so every node uses it:
gzip -c data/tabi.db > latest.sqlite.gz   # then upload to tabi/db/latest.sqlite.gz with metadata x-amz-meta-epoch=9999
docker compose start
```

## Simpler setups

- **Single machine, no failover:** run `docker compose up -d` from the repo root with `TUNNEL_TOKEN` and `ACCESS_KEY` in `.env`. Add the `S3_*` settings too and Tabi uploads a snapshot to R2 every minute when data changes, which works as an offsite backup.
- **No Fly.io:** run the backup compose file on two home machines (`HA_PRIORITY=primary` on one). You still get failover between them, but not protection from your home internet going down.

## Tuning

These environment variables control timing. The defaults are in brackets.

| Variable | Default | What it does |
|---|---|---|
| `HA_LEASE_TTL_MS` | 30000 | How long a lease lasts without renewal |
| `HA_RENEW_MS` | 10000 | How often the leader renews its lease |
| `HA_GRACE_MS` | 15000 | Allowance for clock differences between machines |
| `HA_BACKUP_EXTRA_MS` | 15000 | Extra time a backup waits before taking over |
| `HA_FAILBACK_MS` | 120000 | How long the primary must be healthy before asking for its role back |
| `HA_SNAPSHOT_MS` | 15000 | How often the leader uploads a snapshot when data changed |

Worst-case takeover time is TTL + grace + backup extra, which is about 60 seconds.
