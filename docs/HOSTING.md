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
                          db/history/…          hourly snapshots (the last 48 hours)
                          blobs/…               photos, receipts, profile photos, emojis
                               │
                    Backblaze B2 (optional, "cold")
                          blobs/…               a copy of every file; old full-size photos only live here
                          db/history/…          one snapshot a day for 30 days, one a week for a year
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
| Backblaze B2 (optional) | First 10 GB free, then $6.95 per TB a month; downloads free up to 3× what's stored |
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

You don't need lifecycle rules: Tabi now deletes old snapshots itself (see [Storage tiers](#storage-tiers-r2-and-backblaze-b2)).

### 2b. Backblaze B2 (optional, recommended)

A second copy of every file, at a different company, and room for photos beyond R2's free 10 GB. Skip it and Tabi works as before, with R2 only. You can add it any time later.

1. Make a Backblaze account at <https://www.backblaze.com/sign-up/cloud-storage>. Any region works: B2 only serves older photos, so distance matters little.
2. **Buckets → Create a Bucket.** Give it a unique name (for example `tabi-cold-<something>`), keep it **Private**, and leave Object Lock off.
3. On the new bucket, open **Lifecycle Settings** and choose **Keep only the last version of the file**. B2 keeps every old version by default, so deleted files would otherwise still take up space.
4. Note the bucket's **Endpoint**, for example `s3.us-west-004.backblazeb2.com`.
5. **Application Keys → Add a New Application Key.** Allow access to that bucket only, with *Read and Write*. Copy the **keyID** and **applicationKey** right away: Backblaze shows the second one only once. (The master application key doesn't work with B2's S3-compatible API.)
6. Add these to `.env` on **both** machines (`/opt/tabi/deploy/droplet/.env` and the home server's), then run `bash /opt/tabi/deploy/update.sh` on each:
   ```
   COLD_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   COLD_S3_BUCKET=tabi-cold-<something>
   COLD_S3_ACCESS_KEY_ID=<keyID>
   COLD_S3_SECRET_ACCESS_KEY=<applicationKey>
   ```
   The region is read from the endpoint. When it's on, the log says `[storage] files: this disk, then R2, then B2`.
7. In the developer console, **Overview → File storage** shows R2 and B2 filling up. Within about 10 minutes every existing file has a copy in B2.

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

On the droplet first, then **the home server too, every time**:

```bash
bash /opt/tabi/deploy/update.sh
```

It does three things:
1. Pulls `main`.
2. Saves a copy of the live database to `deploy/<droplet|home>/data/backups/`, keeping the last 10.
3. Rebuilds and restarts.

The serving machine uploads a final snapshot and keeps its lease while it restarts, so updates don't trigger a failover.

**Why the home server needs updating too:** if the droplet is down for a moment (a deploy that takes longer, a restart), the home server can take over, and whoever opens Tabi then gets the version the home server runs. If that's older, people can end up on the old app. Since 1.7 both servers note their version in R2: the developer console shows each one under *Overview → Failover → Servers* and flags a difference, and the server log says `[ha] version mismatch: …`. The app also retries an update on its own, and *Settings → Reload app* clears a browser's offline copy of Tabi.

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

Its actions are **clearing all expenses** and, only when you turn it on, **password reset links**. Clearing expenses is under Overview → Expenses: you type CLEAR to confirm, and can choose everything or shared ones only. The last clear can be undone there or by an admin in Settings. Trip admins can do the same from Settings.

Things to know:
- **It shows everyone's location**, so only share the key with people you'd trust with that.
- **Reset links are off by default**, because a reset link can take over any account. If the only admin is locked out, add `DEV_RESET_LINKS=on` to `.env`, restart, make the link under Accounts, then remove the line and restart again.
- **Keys and tokens are blanked out** in the console's server log and outbound calls (any setting whose name has KEY, TOKEN, SECRET or PASSWORD in it).
- **The key is separate from the private-link key**, and also gets its holder past the private link, so treat it like an admin password.
- **Without `DEV_KEY` set**, `/dev` doesn't exist.
- **Live history is kept in memory**, so the event lists start fresh when the server restarts.
- **App errors** (since 1.6) lists JavaScript errors from people's browsers, at most 30 per person per server run, with their screen size, app build and browser. Nothing else is sent.
- **Existing servers:** `update.sh` adds a generated `DEV_KEY` to `.env` the first time it runs and prints a reminder. Copy the same line into the other server's `.env` so the key works whichever machine is serving. To see it: `grep DEV_KEY /opt/tabi/deploy/droplet/.env`.

## Forgotten passwords and removed members

Nobody has to make a new account any more.

- **With a recovery code:** after updating to 1.5, everyone is asked once to set one up ("Protect your account"). If they later forget their password, they choose *Forgot password?* on the sign-in screen and enter their name, code and a new password. They get a fresh code, and their other devices are signed out.
  - **Since 1.6** a new code can be viewed again in *Settings → Account recovery* until they confirm they've saved it, so closing the sheet too early no longer loses it. The readable copy is deleted the moment they choose *I've saved it, hide it*.
  - People who made a code on 1.5 are asked once whether they saved it. Nothing changes for their accounts or codes.
- **Without one:**
  1. They tap *Ask a trip admin*, which sends the admins a notification.
  2. An admin opens *Settings → People → their name → Reset link* and sends them the link privately.
  3. The link works once, within 24 hours.

  If you're the only admin and you're the one locked out, make the link in the developer console under *Overview → Accounts*.
- **Removing someone, or someone leaving,** keeps their account as a *former member*. They can't sign in, but every expense they're part of still counts. Former members are listed in Settings, where an admin can *Bring back* or *Merge into…* the account they made after rejoining under a new name.
- **People you removed before 1.5** were deleted outright, but their expenses stayed in the database, which threw balances off. On the first start of 1.5 they come back as former members, named from the activity log. The server log shows a `restored former member` line for each. If they've since rejoined under another name, use *Merge into…* to move the old expenses onto their current account.

## Sessions and security

- **Sign-in** uses an HttpOnly, Secure, SameSite=Lax cookie. Only a SHA-256 hash of each session token is stored, in the database, so sessions survive restarts and failovers.
- **Session lookups** are cached in memory for 5 minutes.
- **Expiry:** sessions slide forward with use and expire after 180 days of inactivity (`SESSION_DAYS`).
- **Sign-outs:** changing your password signs out your other devices. *Settings → Signed-in devices* shows every session and can sign out the others.
- **Forgotten passwords:** see the next section.
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
| `[ha] version mismatch: home runs 1.6.0 …` | One server wasn't updated | Run `bash /opt/tabi/deploy/update.sh` on that server |
| `[push] made the Web Push key pair` | First start of 1.7: normal, once | Nothing |
| `failed to sufficiently increase receive buffer size` | Harmless warning | Optional: `printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' > /etc/sysctl.d/99-tunnel.conf && sysctl --system` |

After editing `.env`, run `docker compose up -d --force-recreate` in the same folder.

**Someone's browser keeps showing an older version.**
1. Have them open *Settings*. The line above the map credits shows the version, the build and which server answered.
2. Tap *Reload app*. This clears Tabi's offline copy of the app (not their data, saved maps or sign-in) and loads the newest version.
3. If it still shows the old version, check the developer console's *Servers* table: the other server is probably behind. Run `update.sh` there.

Since 1.7 the app retries by itself a minute apart, clearing its offline copy on the second try. If it still can't get the new version it reports it under *App errors* in the developer console.

## Restoring an older backup

R2 has the last 48 hours of hourly snapshots under `tabi/db/history/`. With B2 set up, older ones (one a day for 30 days, one a week for a year) are in the B2 bucket under the same path.

```bash
# Download a snapshot (R2 or B2 dashboard → the bucket → tabi/db/history/), then on the droplet:
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
| `PHOTO_LIMIT_MB` | 2048 | Total space for Picture a day photos; uploads stop with a clear message at this size |
| `CHAT_MEDIA_LIMIT_MB` | 3072 | Total space for photos and GIFs sent in chat |
| `STORAGE_HOT_LIMIT_MB` | 8192 | With B2: the least-used files move to B2 when R2 passes 90% of this |
| `COLD_AFTER_DAYS` | 30 | With B2: full-size photos and receipts nobody has opened for this long move to B2 |
| `COLD_CHAT_AFTER_DAYS` | 14 | The same, for chat pictures |
| `LOCAL_CACHE_MB` | 4096 | How much of each server's disk is used to keep copies of files |
| `STORAGE_ALL_HOT` | off | `1` stops moving files to B2 and brings every file back into R2 (see below) |

Worst-case takeover time is TTL + grace + backup extra, which is about 60 seconds.

You can check a local failover drill against a mock R2 with `npm run test:ha`.

## Notifications on the lock screen (Web Push)

Since 1.7 people can get Tabi's notifications on the lock screen while Tabi is closed: *Settings → Notifications → When Tabi is closed*, per device. There's nothing to set up on the servers.

- **Keys:** Tabi makes its signing key pair on first start and keeps it in the database, so both servers use the same one and devices keep working after a failover. To use your own, set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on both machines.
- **Where pushes go:** to each browser's own push service (Google for Chrome and Android, Apple for iPhone and Safari, Mozilla for Firefox, Microsoft for Edge). Messages are end-to-end encrypted for the device, and the server only sends to those services' addresses.
- **iPhone:** iOS 16.4 or later, and only when Tabi is opened from the Home Screen (Share → Add to Home Screen). The switch explains this on iPhones that haven't added it.
- **When:** only when none of that person's Tabi windows is on screen; otherwise the app shows it as usual. The same per-kind choices apply.
- **Dead devices:** devices the push service reports as gone are removed automatically. The developer console shows how many devices have it on and when the last one was delivered.

## Storage tiers: R2 and Backblaze B2

Files (photos, chat pictures, receipts, profile photos, emojis, the Android app) are named by their contents' fingerprint (SHA-256), so a copy anywhere can be checked byte for byte.

- **Every file** goes to R2 when it's saved, and is copied to B2 a moment later. If R2 is down, it goes to B2 straight away and back into R2 once R2 is up. If neither can take it, the upload fails with a message rather than living on one machine only.
- **Reading** tries this server's disk, then R2, then B2. A copy that doesn't match its fingerprint is skipped, flagged and replaced from a good one. A store that keeps failing is skipped for a minute, so one outage doesn't slow everything down.
- **Moving cold:** every 10 minutes the serving machine moves full-size photos, chat pictures and receipts nobody has opened for 30 days (14 for chat) out of R2, oldest first. It also moves the least-used ones when R2 passes 90% of `STORAGE_HOT_LIMIT_MB`. Before removing the R2 copy it checks that B2 has the file at the right size. Thumbnails, profile photos, emojis and the Android app always stay in R2, so lists and chat stay fast. A moved photo opens a little slower the first time, then goes back into R2 while there's room.
- **Checks:** each run downloads three B2 copies and checks their fingerprints; a damaged or missing one is copied again.
- **Each server's disk is a cache**, capped at `LOCAL_CACHE_MB`; the least-read files that have copies elsewhere are cleared first.
- **Database snapshots:** R2 keeps the last 48 hours of hourly snapshots. Older ones are deleted, except one a day for 30 days and one a week for a year, which move to B2 (or stay in R2 without B2). B2 also gets a fresh snapshot at least once a day.

The developer console's *File storage* panel shows how full R2 is, what's waiting to be copied, each store's health, the last run, and any files with problems.

**To stop using B2, or before rolling back to 1.8:** set `STORAGE_ALL_HOT=1` on both machines and run `update.sh`. Within a few runs every file is back in R2 (*File storage* shows "Bringing files back to R2: done"). Then remove the `COLD_S3_*` lines, or roll back. Version 1.8 only reads R2, and without this step it can't load photos that had moved to B2. If you remove the `COLD_S3_*` settings first, the panel lists the files that are stranded in B2. Put the settings back with `STORAGE_ALL_HOT=1` to recover them.

## Picture a day: storage

Photos are shrunk in the browser before upload: at most 2048 px, WebP or JPEG, usually 200 to 600 KB, plus a small thumbnail, with location and camera data removed. They're stored like receipts: in R2 under `blobs/` (and in B2, if set up), with a copy on the serving machine's disk, so the backup has them too.

Five a day for a two-week trip is roughly 50 MB, a small part of R2's free 10 GB. `PHOTO_LIMIT_MB` caps the total. See [FEASIBILITY.md](FEASIBILITY.md) for the estimates, and for chat and games.

## Group chat: GIF search and storage

Chat photos are shrunk on the phone like Picture a day ones and stored the same way (disk plus R2 `blobs/`). Only people in a chat can load its pictures. `CHAT_MEDIA_LIMIT_MB` (default 3 GB) caps their total.

**GIF search** uses KLIPY. Tenor's API closed on 30 June 2026. To turn it on:

1. Get a free API key at <https://partner.klipy.com>.
2. Set `KLIPY_API_KEY` in `.env` on **both** servers, then run `bash /opt/tabi/deploy/update.sh` on each.

Without a key the GIF button is hidden, and people can still send GIFs saved on their phone.

How it works, in line with KLIPY's terms:
- Searches go through Tabi, so the key stays on the server and nobody's identity is sent. Results are cached for 10 minutes, and each person is limited to 30 searches a minute.
- The GIFs themselves load straight from KLIPY and are never copied or cached; the service worker skips them.
- The search box says "Search KLIPY" and the picker says "Powered by KLIPY".

## The Android app

Building, signing and publishing it are in [ANDROID.md](ANDROID.md). Nothing needs setting up on the servers.

Once an admin uploads the APK in Settings, Tabi serves `/.well-known/assetlinks.json` itself. It's public, past the private-link gate, because Google fetches it without cookies, and it only names the app's package and signing fingerprint. If something in front of Tabi blocks `/.well-known/`, allow it for that file.
