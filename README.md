# Tabi: group trip planner for Japan

A private, self-hosted web app for a group of friends travelling together. It works like a stripped-down Google Maps that the whole group shares:

- **Map** with everyone's saved places, live friend bubbles, search across Japan, and a "line strip" for the selected day. The strip shows each stop like a station on a train line, with the number of stops left.
- **Itinerary** for each day of the trip, filtered by Confirmed, Maybe, Suggested, Visited, Missed and Vetoed. Each day's plan can be reordered.
- **Voting** on every place: want to go, not keen, or veto. You choose the veto rule and can turn on auto-confirm.
- **Live sync** over WebSockets. Everyone signs in with their own name, and edits made offline sync when you reconnect.
- **Location sharing** that each person opts into. It works inside the app, or always-on through the free OwnTracks app.
- **Import** from Google My Maps (by link or KML/KMZ), pasted Google, Apple or OSM links, Google Takeout, GeoJSON, GPX and CSV.
- **Offline maps** using free OpenFreeMap vector tiles, cached on the phone.
- **Directions** open in Google Maps, which has the best Japanese transit data and costs nothing.
- Light and dark mode, plus map labels in English, Japanese or both.

It's a PWA, so there's no App Store or Play Store. Open the URL and add it to your home screen.

---

## 1. Run it

You need **Node.js 22.13 or newer**. There are no native modules and no database server; data is stored in a SQLite file using Node's built-in `node:sqlite`.

```bash
npm install
npm start            # http://localhost:8080
```

Or with Docker:

```bash
docker compose up -d --build     # data is kept in ./data
```

Open the app and the first screen sets up the trip: name, dates, and your admin account. Then go to **Settings → Invite friends → Share link**.

## 2. Give it HTTPS (needed for GPS)

Browsers only allow location access, service workers (offline mode) and "Add to Home Screen" on **https://** addresses. `localhost` is the only exception. Pick one of these options:

| Option | Good for | How |
|---|---|---|
| **Cloudflare Tunnel** (free) | A home PC or Raspberry Pi, no port forwarding | Create a tunnel in the Cloudflare Zero Trust dashboard and point it at `http://tabi:8080`. Paste the token into `docker-compose.yml`, then run `docker compose --profile tunnel up -d`. You need a domain on Cloudflare. |
| **Tailscale Funnel** (free) | Quickest setup | `tailscale funnel 8080` gives you `https://<machine>.<tailnet>.ts.net`. Friends don't need Tailscale for Funnel. |
| **Caddy** on a VPS | A cheap VPS (Hetzner, Fly.io, etc.) | Use the Caddyfile `tabi.example.com { reverse_proxy localhost:8080 }`. Caddy gets the certificate automatically. |

When it runs behind any of these proxies, set `TRUST_PROXY=true` so login rate limiting sees real client IPs. WebSockets work through all three.

> The server has to stay up during the trip. A home machine on residential internet is fine. Phones keep a cached copy of the plan and work offline if it goes down.

## 3. Put it on everyone's phone

- **iPhone:** open the link in Safari, tap Share, then **Add to Home Screen**.
- **Android:** open it in Chrome, open the ⋮ menu, then **Add to Home screen** (or Install app).

## 4. Location sharing

Sharing is **opt-in per person**: Settings → Location sharing → *Share my location with the group*. When you turn it off, your last position is deleted from the server.

**What a web app can and can't do:** browsers (especially iOS Safari) stop GPS when a web app is in the background or the screen is locked. Inside Tabi, your position updates while the app is open. Turning on *Keep screen on* helps while you're walking around.

**For always-on sharing like Find My or Life360, use OwnTracks.** It's a free, open-source app for iOS and Android that sends location in the background with good battery behaviour. Tabi has an OwnTracks endpoint built in:

1. Install OwnTracks and set **Mode: HTTP**.
2. In Tabi, go to Settings → *Set up OwnTracks*. Copy the URL (`https://your-host/api/owntracks`), your user ID (your Tabi name) and your token into OwnTracks.
3. Choose *Significant changes* monitoring to save battery, or *Move* for more detail.

Friends who share also appear inside OwnTracks. Each person's token is separate from their password and can be regenerated.

## 5. Getting places in

**Google My Maps (recommended for planning):**
- *By link:* in My Maps, click Share and set it to "Anyone with the link can view". Then use Add places → **My Maps** and paste the link (it contains `mid=`). The server downloads the KML.
- *By file (private maps):* in the My Maps menu, choose ⋮ → **Export to KML/KMZ**, then use Add places → **File**.
- Each **layer** in the map can go to a trip day. Layers named like `Day 2`, `3/14`, `2026-03-14` or `2日目` are matched to days automatically.

**Links:** paste one or more links into Add places → Paste links, or straight into the search bar. These all work: `maps.app.goo.gl` short links, full Google Maps place URLs, Apple Maps, OpenStreetMap, `geo:` URIs and plain `lat, lng`. Short links are followed on the server. If a link only has a name, the place is found by searching for it and marked "found by name" so you can double-check the pin.

**Google Takeout "Saved" lists:** `Saved Places.json` (GeoJSON) imports directly. List CSVs often have only URLs, and Tabi looks those up one by one.

**Other files:** GeoJSON, GPX waypoints, and CSV with `name, lat, lng` columns. Optional columns are `notes`, `url`, `day` (YYYY-MM-DD), `time` (HH:MM), `layer` and `address`.

**On the map:** press and hold anywhere (or right-click on a computer) to drop a pin, or search. Search uses Photon (OpenStreetMap data), limited to Japan.

## 6. How planning works

| Status | Meaning |
|---|---|
| Suggested | Someone added it. This is the default. |
| Maybe | Interested, not committed. |
| Confirmed | On the plan. When it has a day, it appears as a numbered stop on that day's line. |
| Visited | Done. It fills in on the line. |
| Missed | Shown automatically when a confirmed stop's day has passed in Japan time and nobody marked it visited. |
| Skipped | Deliberately dropped on the day. It's filtered together with Missed. |
| Vetoed | Removed by veto. Hidden from the map by default. Anyone can tap *Bring back*. |

- **Votes:** each person has one vote per place: want to go, not keen, or veto. Admins choose the veto rule: *one veto removes it*, *majority*, or *veto counts as a no*. Admins can also set *auto-confirm*, so a place is confirmed once N people want to go.
- **Order:** use the itinerary's *Reorder* button. Setting a time slots the stop among the day's other timed stops.
- **Activity:** Settings → Recent activity shows who added, confirmed or vetoed what.

## 7. Offline

- The app itself, and the last synced plan, open offline after one visit.
- Map areas you've browsed are cached automatically. Before you fly, use **Settings → Offline maps → Save maps around all places** (on Wi-Fi). It saves an overview of Japan plus street-level detail about 1 km around every place. Each press fetches up to 3,000 tiles, following OpenFreeMap's guidance for offline downloads, so press it again if it says more remain.
- Changes made offline (votes, edits, new places) are queued and sent when you reconnect. The avatar dot at the top left is green when connected and amber when offline.

## 8. Configuration

Configure with environment variables, or a `.env` file next to `package.json` (see `.env.example`).

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` | Holds the SQLite database. Back up this folder. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy. |
| `MAP_STYLE_LIGHT` / `MAP_STYLE_DARK` | OpenFreeMap Liberty / Dark | Any MapLibre style URL. Use this if you self-host tiles. |
| `OFFLINE_TILE_LIMIT` | `3000` | Tiles fetched per "Save maps" press. |

**Fully self-hosted tiles (optional):** for zero reliance on public services, extract Japan from the Protomaps daily build (`pmtiles extract … --bbox=122.9,24.0,146.0,45.6`, roughly 1–2 GB) or self-host OpenFreeMap. Then point `MAP_STYLE_*` at your style.

**Backups:** in-app, use Settings → Export (KML opens in Google My Maps and Google Earth; JSON is a full dump). On the server, copy `data/tabi.db` (stop the server first, or copy the `-wal` file too).

## 9. Architecture

```
server/index.js   HTTP + REST (auth, search proxy, link resolver, My Maps, OwnTracks, export) + WebSocket hub
server/db.js      SQLite schema (users, sessions, places, votes, locations, activity, geocache)
server/links.js   Map-link parsing and short-link resolution
public/           No-build PWA (plain ES modules)
  js/store.js     State, WebSocket sync, offline outbox
  js/map.js       MapLibre map, markers, friend bubbles, day line strip, search
  js/itinerary.js Day picker, filters, voting, reorder
  js/settings.js  Account, sharing, theme, offline maps, trip admin
  js/add.js       Add/import flows;  js/parsers.js  KML/KMZ/GeoJSON/GPX/CSV
  js/offline.js   Tile pack downloader;  sw.js  Service worker
```

Dependencies: `ws` (server), `maplibre-gl` and `fflate` (served to the browser from `node_modules`). Passwords are hashed with scrypt. Sessions are random tokens, and only their SHA-256 is stored.

## 10. Free services used (no API keys)

- **OpenFreeMap:** vector map tiles (© OpenMapTiles, © OpenStreetMap contributors).
- **Photon by Komoot:** search and reverse geocoding. Queries go through your server, which caches them for 14 days.
- **Google Maps:** only as outbound links for directions and place pages, plus server-side fetches to resolve share links and download public My Maps KML. No paid APIs are used.
