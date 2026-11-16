# Hosting Tabi: DigitalOcean primary, home server backup

This guide puts Tabi at **`https://trip.sanechristmas.party`** behind a private link. A small DigitalOcean droplet in **Singapore** serves it, and your home server takes over automatically if the droplet goes down.

```
 phones in Japan ──https──▶ Cloudflare edge (Tokyo): your domain and TLS
                               │
                               │  Cloudflare Tunnel: outbound only, no open ports anywhere
                ┌──────────────┴──────────────┐
                ▼ (only the leader connects    ▼  its tunnel)
   DigitalOcean droplet, SGP1            Home server (Docker)
   HA_PRIORITY=primary                   HA_PRIORITY=backup
                │                              │
                └──────── Cloudflare R2 ───────┘
                          lease.json            who is serving right now
                          db/latest.sqlite.gz   database snapshot, taken when data changes (≈15 s)
                          db/history/…          hourly snapshots
                          blobs/…               receipt photos
```

Why Singapore: DigitalOcean has no region in Japan or Korea, and Singapore is the closest of the regions it offers. Phones connect to Cloudflare's Tokyo edge, so TLS setup is local. The app also opens instantly from its cached copy, so the extra distance to Singapore is hard to notice.

## How failover works

1. Both machines run the same Docker image. Each one tries to take a **lease**, a small file in R2 written with an atomic compare-and-swap.
2. The machine holding the lease opens the database, starts its Cloudflare Tunnel connector and serves the site. It renews the lease every 10 seconds and uploads a database snapshot whenever data changes.
3. The other machine waits on standby. Its health check passes, but it serves nothing and runs no tunnel.
4. **If the droplet dies**, its lease expires. The home server waits about a minute after the last renewal, restores the newest snapshot, connects its tunnel and starts serving.
5. **When the droplet is back** and has been up for 2 minutes, it asks for its role back. The home server uploads a final snapshot, hands over the lease and restarts into standby. The site is down for about 10 to 20 seconds during the swap.
6. **If a leader can't reach R2** for about 20 seconds, it stops serving on its own. This guarantees two copies never run at once. It resumes when R2 is reachable again.

What your friends notice: phones keep the plan cached, so the app stays usable during a switch. Votes, edits and new expenses are queued and sent when the connection returns. Sign-ins carry over, because sessions are stored in the database.

At most about 15 seconds of edits can be lost, and only if the droplet crashes hard. Updates and graceful restarts upload a final snapshot first.

## What it costs

| Piece | Cost |
|---|---|
| `sanechristmas.party` | Already yours (just keep it renewed) |
| DigitalOcean Basic droplet, 1 vCPU / 1 GB, SGP1 | $6 a month (Regular SSD) or $8 (Premium Intel NVMe); both are plenty for 8 people |
| Cloudflare DNS and Tunnel | Free |
| Cloudflare R2 | Free tier (10 GB) covers this easily |
| Home server | Whatever you already run Docker on |

Skip DigitalOcean's paid backups: the R2 snapshots already cover them.

## Setup

You need a Cloudflare account, a DigitalOcean account, and the GitHub repo. Allow about 45 minutes.

Before you start, merge the pull request on GitHub, because the setup script deploys `main`. Alternatively, pass `--branch feature/money-subgroups-ha` to the script.

### 1. Move `sanechristmas.party` to Cloudflare DNS

1. In Cloudflare, click **Add a domain**, enter `sanechristmas.party`, and choose the **Free** plan.
2. Cloudflare shows two nameservers (for example `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`). At the registrar where you bought the domain, replace its nameservers with those two.
3. Wait for Cloudflare to email that the domain is active. This usually takes minutes, but can take a few hours.

Anything else on the domain keeps working if you recreate its DNS records in Cloudflare, which offers to import them during setup.

### 2. R2 bucket and keys

1. Go to **R2 Object Storage**, create a bucket named `tabi`, and set the location hint to **Asia-Pacific**.
2. Go to **R2 → Manage API tokens → Create API token**. Choose *Object Read & Write* and limit it to the `tabi` bucket.
3. Keep these three values: the **Access Key ID**, the **Secret Access Key**, and the **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
4. Optional: add a lifecycle rule that deletes `tabi/db/history/` objects after 30 days.

### 3. Cloudflare Tunnel

1. Go to **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared** and name it `tabi`.
2. On the install screen, copy the **token**: the long string after `--token` in any of the install commands. You don't need to install anything; the Tabi image runs cloudflared itself.
3. Under **Public hostname**, set:
   - Subdomain: `trip`
   - Domain: `sanechristmas.party`
   - Service type: `HTTP`
   - URL: `localhost:8080`

### 4. Create the droplet

In DigitalOcean, go to **Create → Droplets** and choose:

| Setting | Choose |
|---|---|
| Region | **Singapore (SGP1)** |
| Image | Ubuntu 24.04 (LTS) x64 |
| Plan | Basic: Regular ($6) or Premium Intel ($8), 1 GB / 1 vCPU |
| Volumes, Backups, Managed Database | Leave off |
| Authentication | **SSH key** (add your public key; not a password) |
| Networking | Public IPv4 on; IPv6 optional |
| Monitoring | On (free) |
| Name | `tabi-sgp1` |

After it's created, go to **Networking → Firewalls → Create Firewall**:
- **Inbound:** only SSH (TCP 22). Use your own IP as the source if it doesn't change, otherwise all IPv4 and IPv6.
- **Outbound:** leave the defaults (all).
- **Apply to:** `tabi-sgp1`.

Tabi needs no inbound ports, because the tunnel connects outward.

### 5. Run the setup script on the droplet

From the folder where you cloned the repo on your computer:

```bash
scp deploy/setup.sh root@<droplet-ip>:
ssh -t root@<droplet-ip> bash setup.sh
```

The script:
1. Adds 1 GB of swap.
2. Installs Docker and automatic security updates.
3. Locks the firewall to SSH only.
4. Prints a **deploy key**. Add it on GitHub under the repo's **Settings → Deploy keys** (read-only), then press Enter.
5. Clones the repo to `/opt/tabi`.
6. Asks for the values from steps 1–3. Press Enter at the private-link prompt to generate a key, then **save the key somewhere safe**.
7. Builds and starts Tabi, then checks it's healthy.

At the end it prints your private link: `https://trip.sanechristmas.party/?key=…`. Open it and create the trip.

To check that this machine is serving:

```bash
cd /opt/tabi/deploy/droplet && docker compose logs --tail 20
# look for "[ha] do-sgp1 is now the leader" and cloudflared "Registered tunnel connection"
```

### 6. Backup on the home server

The backup needs the **same values** as the droplet. To see them, run `cat /opt/tabi/deploy/droplet/.env` on the droplet.

**Linux home server (Ubuntu or Debian):**
```bash
sudo bash setup.sh --role backup --node home
```
Use the same `setup.sh`, and paste the same values when asked. It adds its own deploy key.

**Windows or macOS with Docker Desktop:**
1. Install Docker Desktop and turn on *Start Docker Desktop when you sign in*.
2. In the repo, go to `deploy/home`. Copy `.env.example` from the repo root to `deploy/home/.env`, and fill in the same values as the droplet. Add the line `HA_NODE=home`.
3. In that folder, run:
   ```bash
   docker compose up -d --build
   docker compose logs -f      # "[ha] home (backup) waiting for the lease"
   ```
4. Set the PC to never sleep while you're travelling. A sleeping backup can't take over.

The home server only needs outbound internet. Don't open any ports on your router.

### 7. Test failover once before you fly

On the droplet:

```bash
cd /opt/tabi/deploy/droplet && docker compose stop
# about 1 minute later the home server logs "home is now the leader"; the site keeps working
docker compose start
# about 2 minutes later the droplet asks for its role back and the home server hands over
```

You can also use **Power Off** in the DigitalOcean control panel for a harsher test.

To check which machine is serving at any time:

```bash
curl -s https://trip.sanechristmas.party/healthz
# {"ok":true,"role":"leader","node":"do-sgp1",...}
```

### 8. Invite everyone

Send your friends `https://trip.sanechristmas.party/?key=<your key>`, or the invite link from **Settings → Invite friends**. The invite link already carries access, so friends don't need the raw key.

After the first visit, each phone remembers access for 400 days. "Add to Home Screen" keeps working too, because the home-screen icon carries its own access token.

## Updating

On the droplet first, then the home server:

```bash
bash /opt/tabi/deploy/update.sh
```

It does three things:
1. Pulls `main`.
2. Saves a copy of the live database to `deploy/<droplet|home>/data/backups/`, keeping the last 10.
3. Rebuilds and restarts.

The serving machine uploads a final snapshot and keeps its lease while it restarts, so updates don't trigger a failover.

**Your data and sign-ins survive updates.** The database lives in `data/` on the server, outside the container. New versions only add tables or columns. Sessions are stored in the database, so nobody has to sign up or sign in again. Profile photos are stored like receipts: on the server's disk and in R2 under `blobs/`, so the home backup has them too.

Rolling back one version also works: an older version ignores the tables and columns it doesn't know about (in 1.3: notifications, profile photos, notification settings).

To roll back to a backup:

```bash
docker compose stop
cp data/backups/tabi-<time>.db data/tabi.db
rm -f data/tabi.db-wal data/tabi.db-shm
docker compose start
```

## Developer console

`https://trip.sanechristmas.party/dev?devkey=<DEV_KEY>` opens the developer console. Open it once per device; the browser then remembers it for 30 days, and you can go straight to `/dev`. It updates live.

It shows:
- server and failover health
- every place, including removed ones
- a map of everyone's latest positions and recent trails
- every location update and every **OwnTracks** request, with its result: *stored*, *wrong token*, *unknown user*, or *ignored because sharing is off*
- sign-ins (including failed ones) and other activity
- the server's calls to other services
- the server log

Its one action is **clearing all expenses**, under Overview → Expenses. You type CLEAR to confirm, and can choose everything or shared ones only. The last clear can be undone there or by an admin in Settings. Trip admins can do the same from Settings.

Things to know:
- **It shows everyone's location**, so only share the key with people you'd trust with that.
- **The key is separate from the private-link key**, and also gets its holder past the private link.
- **Without `DEV_KEY` set**, `/dev` doesn't exist.
- **Live history is kept in memory**, so the event lists start fresh when the server restarts.
- **Existing servers:** `update.sh` adds a generated `DEV_KEY` to `.env` the first time it runs and prints a reminder. Copy the same line into the other server's `.env` so the key works whichever machine is serving. To see it: `grep DEV_KEY /opt/tabi/deploy/droplet/.env`.

## Sessions and security

- **Sign-in** uses an HttpOnly, Secure, SameSite=Lax cookie. Only a SHA-256 hash of each session token is stored, in the database, so sessions survive restarts and failovers.
- **Session lookups** are cached in memory for 5 minutes.
- **Expiry:** sessions slide forward with use and expire after 180 days of inactivity (`SESSION_DAYS`).
- **Sign-outs:** changing your password signs out your other devices. *Settings → Signed-in devices* shows every session and can sign out the others.
- **Cross-site protection:** requests that change data, and the WebSocket, are refused when they come from another site.
- **Rate limits:** sign-in and join attempts are limited per IP. Behind the tunnel, the real IP comes from `CF-Connecting-IP`.
- **Server hardening:**
  - The droplet accepts SSH only, at two levels: the DigitalOcean Cloud Firewall and `ufw`.
  - Security updates install automatically.
  - Secrets live in `.env`, which only root can read.
- **Optional extra lock:** you can put **Cloudflare Access** (email one-time codes, free for up to 50 users) in front of `trip.sanechristmas.party`. If you do, add a bypass policy for `/api/owntracks`, because the OwnTracks app can't log in to Access.

## Troubleshooting

| Log line | Cause | Fix |
|---|---|---|
| `lease check failed: Invalid URL` or `Storage settings problem` | `S3_ENDPOINT` is malformed | It must be `https://<account-id>.r2.cloudflarestorage.com`, with nothing after `.com` |
| `lease check failed: … 403` | Wrong R2 keys, or the token isn't allowed on the bucket | Fix `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` |
| `lease check failed: … 404` | The bucket name is wrong | Fix `S3_BUCKET` |
| `stepping down: lease changed while renewing` (immediately after starting) | Version 1.1.0 handled R2's version tags wrongly | Update with `bash /opt/tabi/deploy/update.sh` |
| `Provided Tunnel token is not valid` | Wrong `TUNNEL_TOKEN` | Paste the `eyJ…` token from the tunnel's install command |
| `failed to sufficiently increase receive buffer size` | Harmless warning | Optional: `printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' > /etc/sysctl.d/99-tunnel.conf && sysctl --system` |

After editing `.env`, run `docker compose up -d --force-recreate` in the same folder.

## Restoring an older backup

```bash
# Download an hourly snapshot from R2 (dashboard → tabi bucket → tabi/db/history/), then on the droplet:
cd /opt/tabi/deploy/droplet && docker compose stop
gunzip -c 2026-11-20T10-00-00-000Z.sqlite.gz > data/tabi.db
rm -f data/tabi.db-wal data/tabi.db-shm data/ha-state.json
# Upload it as the newest snapshot so the backup doesn't overwrite it:
gzip -c data/tabi.db > latest.sqlite.gz   # upload to tabi/db/latest.sqlite.gz with metadata x-amz-meta-epoch=9999
docker compose start
```

## Other setups

- **Single machine, no failover:** on any server, run `docker compose up -d` from the repo root with `TUNNEL_TOKEN` and `ACCESS_KEY` in `.env`. Add the `S3_*` settings too and Tabi uploads a snapshot to R2 every minute when data changes, which works as an offsite backup.
- **Fly.io instead of DigitalOcean:** `fly.toml` in the repo root is ready for a Tokyo (`nrt`) machine. Set the same secrets with `fly secrets set` and run `fly deploy`.

## Tuning

These environment variables go in `.env` and control timing.

| Variable | Default | What it does |
|---|---|---|
| `HA_LEASE_TTL_MS` | 30000 | How long a lease lasts without renewal |
| `HA_RENEW_MS` | 10000 | How often the leader renews its lease |
| `HA_GRACE_MS` | 15000 | Allowance for clock differences between machines (both have time sync on) |
| `HA_BACKUP_EXTRA_MS` | 15000 | Extra time a backup waits before taking over |
| `HA_FAILBACK_MS` | 120000 | How long the primary must be healthy before asking for its role back |
| `HA_SNAPSHOT_MS` | 15000 | How often the leader uploads a snapshot when data changed |

Worst-case takeover time is TTL + grace + backup extra, which is about 60 seconds.

You can check a local failover drill against a mock R2 with `npm run test:ha`.
