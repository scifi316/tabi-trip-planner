# The dev stack: production on your own computer

A local copy of how Tabi runs in production, for trying out pull requests before they reach the real trip.

```
browser ─▶ edge  :8080   stand-in for Cloudflare: sends traffic to whichever node is leader
             ├─▶ primary :8101   ┐ the real server code, with failover on,
             └─▶ backup  :8102   ┘ exactly as on the droplet and the home server
                    both share ─▶ s3 :9000   stand-in for R2: the leader lease, database snapshots, photos
                               └▶ cold :9002 stand-in for Backblaze B2: a copy of every file, older photos, old snapshots
```

**What's the same as production:**
- The same server code and the same failover. Two nodes compete for the lease in "R2"; the leader serves and snapshots the database there. If the primary dies, the backup restores the snapshot and takes over. When the primary is back, it takes over again.
- A node that loses the lease exits and is started again as standby, as Docker's `restart: always` does in production.
- The edge passes the visitor's address as `CF-Connecting-IP`, as Cloudflare does, so rate limits and the developer console see real addresses.
- WebSockets work through the edge.
- The stand-in for R2 behaves like R2 where Tabi depends on it: conditional writes for the lease, and Cloudflare's weak ETags.
- The private-link gate, if you set `ACCESS_KEY`.

**What's different:**
- **Failover is faster.** The lease lasts 8 s and the primary takes back over after 20 s (production: 30 s and 2 minutes), so a drill takes about a minute. Use `--prod-timings` for the real values.
- **It's `http://localhost`, not your domain.** Browsers treat localhost as secure, so the service worker, notifications and location all work on the computer. For phones, see [Testing on a phone](#testing-on-a-phone).
- **Its own data.** It never touches production's database or bucket.

## Starting it

You need Node 22 and Git. Docker is optional.

```bash
npm install
node dev/stack.mjs --fresh --seed     # first time: an empty stack plus a demo trip
node dev/stack.mjs                    # after that: carries on with the same data
```

Open <http://localhost:8080>. The demo trip has Kenny (the admin), Sam, Mia and Kai, all with the password `tabitest`. It also has places in Tokyo, votes, a subgroup, expenses, a hotel, chat and two people sharing their location.

All four processes print to that one window, each line labelled with which process sent it. Two pages show what's going on:
- <http://localhost:8080/__edge>: which node is serving, and what each one reports.
- <http://localhost:9000/__list>: what's in the stand-in for R2.
- <http://localhost:9002/__list>: what's in the stand-in for B2 (the cold store). `--no-cold` runs without one.

Optional settings (the private-link key, GIF search, a dev tunnel) go in `dev/.env`: copy `dev/.env.example`.

Data lives in `dev/.data/`. `--fresh` deletes it.

## Trying a pull request

```bash
node dev/pr.mjs 15             # pull request #15
node dev/pr.mjs 15 --fresh --seed
node dev/pr.mjs main           # or any branch
node dev/pr.mjs --restore      # put your dev data back as it was before the last pull request
```

How it works:
- **Your own copy is untouched.** The pull request's code goes into its own folder, `dev/.pr/15`; your checkout and branch stay as they are.
- **It runs on your existing dev data**, so it's also tested as an upgrade: the same thing production goes through when it's merged. The data is copied first, and `--restore` puts it back if the pull request changed it.
- **Packages:** if the pull request changes them, it gets its own install. Otherwise it uses yours.

Stop the stack (`q`, or Ctrl+C) before switching to another pull request.

Things worth checking on a pull request:
1. **Existing data still loads.** Run it without `--fresh` first, on data from the previous version.
2. **Failover still works.** Run `node dev/failover.mjs` while it's running.
3. **Rolling back still works.** Stop it, run `node dev/pr.mjs main` on the same data, and check the previous version still starts.

## Failover drill

While the stack runs, in a second window:

```bash
node dev/failover.mjs
```

It signs in as Sam and kills the primary as if the droplet went down. Then it times how long until the backup serves, starts the primary again, and times how long until it takes back over. It checks Sam stays signed in throughout.

You can also do it by hand in the stack's own window. Type a letter and press Enter:

| Key | What it does |
|---|---|
| `k` | Kill the primary |
| `s` | Start the primary again |
| `d` / `u` | Take the stand-in for R2 down, and bring it back up |
| `cd` / `cu` | The same for the cold store (B2) |
| `q` | Quit |

**About losing data in a crash:** the leader uploads a snapshot whenever data has changed, at most every 5 s here and every 15 s in production. A node that dies without warning loses whatever changed since its last snapshot. A clean stop (an update, or the primary handing back) uploads a final snapshot first, so nothing is lost. The drill waits for a snapshot before pulling the plug.

## Storage tiers

The stack runs a second storage stand-in playing Backblaze B2, and runs the storage upkeep every minute (production: every 10). *Developer console → Overview → File storage* shows both stores.

- **See files move cold:** put `COLD_AFTER_DAYS=0` and `COLD_CHAT_AFTER_DAYS=0` in `dev/.env`, restart, add a Picture a day photo, and within a minute the full-size photo leaves <http://localhost:9000/__list> (the thumbnail stays). It still opens.
- **R2 outage:** `d`, upload a photo (it goes straight to the cold store), `u`, and the next run copies it back to R2.
- **A damaged copy:** `curl -X PUT localhost:9000/__corrupt/tabi-dev/tabi/blobs/<file>`, then remove the file from `dev/.data/primary/blobs/` and open it: the cold copy is served and R2 gets a good one back.
- **Before rolling back:** `STORAGE_ALL_HOT=1` in `dev/.env` brings everything back into R2.

`npm test` covers the same cases without the stack (`test/storage.test.mjs`).

## Testing on a phone

Phones need https for the service worker, location and notifications, and `localhost` means the phone itself. Two ways:

- **Quick:** `node dev/stack.mjs --phone` prints a temporary `https://<random>.trycloudflare.com` address that reaches your stack. It needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed; on Windows, `winget install Cloudflare.cloudflared`. The address changes each time. No Cloudflare account is needed.
- **Same as production:** in Cloudflare Zero Trust, create a second tunnel for a dev hostname, for example `dev.sanechristmas.party`. Give it the public-hostname service `http://localhost:8080`, like production's, and put its token in `dev/.env` as `TUNNEL_TOKEN`. The leader then runs cloudflared itself, exactly as in production, and the hostname follows failovers.

The Android app is built for the production address, so it can't be pointed at the dev stack.

## In Docker, with the production image

The same layout, built from the production `Dockerfile`:

```bash
docker compose -f dev/docker-compose.yml up --build
docker compose -f dev/docker-compose.yml --profile phone up   # plus a trycloudflare address
docker compose -f dev/docker-compose.yml down -v              # stop and delete the dev data
node dev/pr.mjs 15 --docker                                   # a pull request, built from its own checkout
node dev/failover.mjs --docker
```

In Docker the data lives in Docker volumes, so `--restore` doesn't apply; use `down -v` to start over.

Use Docker mode when a pull request changes the `Dockerfile`, the packages, or anything about how the container starts. Otherwise the native stack is quicker.

## On every pull request

The **Tests** check on GitHub (`.github/workflows/test.yml`) runs on every pull request:
1. The unit tests (`npm test`).
2. This dev stack, started with the demo trip.
3. The failover drill through it.

A pull request that breaks startup, the demo trip or failover shows a red cross before anyone tries it by hand.

## Files

| File | What it is |
|---|---|
| `dev/stack.mjs` | Starts everything; restarts nodes like Docker does; the drill keys |
| `dev/edge.mjs` | The stand-in for Cloudflare |
| `dev/s3.mjs` | The stand-ins for R2 and B2, kept on disk |
| `dev/seed.mjs` | The demo trip |
| `dev/pr.mjs` | Runs a pull request or branch |
| `dev/failover.mjs` | The failover drill |
| `dev/docker-compose.yml` | The Docker version |
| `dev/.env.example` | Optional settings |
