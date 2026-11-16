# Tabi: group trip planner for Japan

A private, self-hosted web app for a group of friends travelling together: a shared map and itinerary, voting on places, live locations, subgroups, and shared expenses with receipt scanning. It's a PWA, so there's no App Store. Open the link and add it to your home screen.

- **Run it locally:** `npm install && npm start`, then open http://localhost:8080
- **Host it properly** (your domain, private link, a DigitalOcean droplet in Singapore with your home server as backup): see [docs/HOSTING.md](docs/HOSTING.md). One script sets up each server: `deploy/setup.sh`.

---

## Features

### Map
- [x] Full-screen MapLibre map with free OpenFreeMap vector tiles. Labels can be in English, Japanese or both.
- [x] Your avatar at the top left shows that you're signed in, and whether you're connected or offline. A red **!** on it means unread notifications.
- [x] Search across Japan (Photon/OpenStreetMap). The search bar also accepts pasted map links.
- [x] Press and hold the map (or right-click on a computer) to drop a pin.
- [x] Place markers coloured by status. Each confirmed stop on the selected day is a numbered "station".
- [x] **Day line strip**: the day's stops drawn like a train line, with a count of stops left, visited stops filled in, and the next stop pulsing.
- [x] Friend bubbles with last-seen times, plus a row of chips to jump to each friend.
- [x] **Friends button**: everyone in the trip with live/last-seen status and distance. Each friend's card offers:
  - **Pinpoint**: flies to them, draws how accurate their location is, and follows them as they move.
  - **Walk there**: walking directions in Google Maps.
  - **Their plan for today**, and their full itinerary (shared stops plus their subgroup's).
  - **Money**: what you owe each other, your expenses together, and settle up.
- [x] Layer filter to choose which statuses show on the map.
- [x] Collapsible navigation: a bottom bar on phones, a side rail on wide screens.

### Itinerary
- [x] Day picker that works as a calendar, with "All days" and "Unscheduled" options.
- [x] Status filters: Confirmed, Maybe, Suggested, Visited, Missed (computed automatically, plus Skipped) and Vetoed.
- [x] Reorder each day's plan. Setting a time slots a stop in among the other timed stops.
- [x] Votes: want to go, not keen, or veto.
  - Veto rules: one veto removes a place, a majority is needed, or a veto counts as a "no".
  - Optional auto-confirm once a set number of people want to go.
- [x] **Everyone can add and remove places.** Removing asks for confirmation. Removed places move to **Previously interested**, which only admins see; admins can bring them back or delete them for good.
- [x] Directions open in Google Maps (transit or walking), so no paid APIs are needed.

### Subgroups
- [x] Make a subgroup when the group splits up, for the whole trip or a range of days.
- [x] Anyone can add or remove anyone. Adding someone moves them out of any overlapping subgroup.
- [x] Assign stops to a subgroup with "Who's going". Each subgroup gets its own line on the map strip.
- [x] Subgroup chips on the map jump to where that subgroup's members are now. Friend bubbles are ringed in their subgroup's colour.

### Money
- [x] Shared expenses, or **private** ones that only the payer and the people in the split can see.
- [x] Split equally, by exact amounts, by shares, or **item by item**. Tax, service and discounts are spread in proportion.
- [x] **Receipt and screenshot uploads**, compressed on the phone and stored with the expense.
- [x] **Read receipt**: on-device OCR (Tesseract, Japanese and English) fills in the shop, date, total and line items. Then you tick who had what.
- [x] Multiple currencies. Exchange rates are looked up automatically (ECB data via Frankfurter) and can be edited. With no connection, the expense form uses the rates saved on the phone.
- [x] **Currency converter** (Money → Convert): the trip currency against your home currency (guessed from your phone), swap, quick amounts, a quick-reference table, sums like `1200+850`, and your own card or counter rate. Rates are saved on the phone, so it works offline.
- [x] Balances: what each person owes you or is owed, the group totals, and the **fewest payments to settle up**. Record payments in one tap.
- [x] Export expenses as CSV.

### People, location and sync
- [x] Each person has their own login. Invite friends with a link.
- [x] Live sync over WebSockets. Edits made offline are queued and sent when the connection returns.
- [x] Opt-in location sharing while the app is open, with an optional "keep screen on".
- [x] Always-on sharing through the free **OwnTracks** app (built-in endpoint). Friends also show up inside OwnTracks.
- [x] Activity feed, and admin tools to manage members.
- [x] **Profile photos**: pick a photo, move, zoom and rotate it in a circle, and save it at 240, 320 (default) or 640 pixels. It's cropped and compressed on the phone (WebP, usually under 10 KB), and the server only accepts square images up to 640×640 and 512 KB. Replacing or removing a photo deletes the old file. Shown on map bubbles, friend chips and everywhere else your initials were.
- [x] **Notifications**, each with its own switch in Settings:
  - added to or taken out of a subgroup, or a subgroup you're in changes or ends
  - an expense you're part of is added, changed or deleted, with what you now owe or are owed
  - someone records a payment to or from you
  - a place you added is confirmed, vetoed or removed
  - a confirmed stop in your plan (from today on) is added, moved or dropped
  - someone joins the trip, or you're made an admin
  - anyone adds or imports places (off to start with)
  - admins only: someone removes a place, so it can be brought back from Previously interested

  Unread ones show as a red **!** on your picture, and as a badge on the home-screen icon where the phone supports it. Tap your picture to read them; tapping one takes you to the place, expense, subgroup or person. Repeats of the same thing within 15 minutes update one notification instead of piling up.

### Getting places in
- [x] Google **My Maps**, by share link or KML/KMZ export. Layers are mapped to days automatically ("Day 2", "3/14", "2日目").
- [x] Links from Google Maps (including `maps.app.goo.gl`), Apple Maps and OpenStreetMap, plus `geo:` URIs and raw coordinates.
- [x] Google Takeout saved places (GeoJSON or CSV), GPX and CSV files.
- [x] Places already in the trip are detected and skipped.

### App
- [x] Light and dark mode, either following the phone or set by hand.
- [x] Offline: the app opens with no connection. Map areas you've viewed are cached, and you can **save maps around all your places** ahead of time. Receipt images are cached too.
- [x] **First-run tips** for each screen, which can be skipped and replayed from Settings. People who already finished them get a short "what's new" tour once.
- [x] Export the trip as KML or JSON.

### Developer console
- [x] `/dev`, behind its own `DEV_KEY`. It's read-only and updates live.
  - **Overview:** server health and failover state, data counts, settings, and who has the app open.
  - **Locations:** a map with trails, plus every location update with its source, accuracy, battery and delay.
  - **OwnTracks:** every request with its result. Wrong token, unknown user, sharing off, or stored.
  - **Places:** the full table, including removed places and who removed them.
  - **Activity:** sign-ins (including failed ones), changes and connections.
  - **Network:** the server's calls to search, R2, Google and exchange rates.
  - **Server log.**

### Hosting and security
- [x] Self-hosted Node.js app with SQLite (built into Node). The only server dependencies are `ws` and `aws4fetch`.
- [x] **Private link gate**: without the secret key, the site returns "Not found".
- [x] Cookie sessions (HttpOnly, Secure, SameSite), stored hashed, cached in memory, with sliding expiry. You can see your signed-in devices and sign the others out.
- [x] **High availability**: a cloud primary (DigitalOcean Singapore, or Fly.io Tokyo) and your home server as backup.
  - A lease in Cloudflare R2 decides which one serves.
  - The database is snapshotted continuously, and receipts are stored in R2.
  - Failover and hand-back are automatic, and only the serving machine runs the Cloudflare Tunnel.
- [x] Docker image (amd64 and arm64) with cloudflared included.
- [x] One-command server setup (`deploy/setup.sh`): swap, Docker, firewall, deploy key, secrets and start-up. Updating is one command too (`deploy/update.sh`).

## Updating without losing data

Updates never touch your data: the database stays on the server's disk outside the container, and new versions only ever add to it. `deploy/update.sh` also saves a copy of the database to `data/backups/` before rebuilding. Everyone stays signed in. Before each release, a database made with the previous version is upgraded and checked: the same people, places, subgroups, expenses and sessions must all come through.

## Future improvements

Ideas, roughly in priority order:

- [ ] **Push notifications when Tabi is closed** (Web Push with VAPID keys; works on Android and on iOS 16.4+ home-screen apps). The notifications above already exist in the app; this would deliver them to the lock screen too, plus "the group is leaving in 10 minutes".
- [ ] **Notification digests**: a quieter mode that bundles plan changes into one notification a day.
- [ ] **Show balances in each person's home currency** (USD, EUR and so on) alongside yen, using the converter's saved home currency.
- [ ] **Better receipt reading**: try a cloud OCR option for faded thermal receipts, and recognise the tax-rate markers on Japanese receipts (※ and 軽 for the 8% rate) to split tax exactly.
- [ ] **Travel times between stops** on the day line, from a self-hosted router (Valhalla or OSRM) or a cached estimate from distance.
- [ ] **Opening hours and closed days** for each place, pulled from OpenStreetMap, with a warning when a stop is planned on a closed day.
- [ ] **Drag-and-drop reordering** in the itinerary and on the line strip.
- [ ] **Polls** for "where should we eat tonight?" with a deadline.
- [ ] **Shared notes and packing lists** per day.
- [ ] **Read-only share link** for family back home (no location, no money).
- [ ] **Fully self-hosted map tiles**: a Japan PMTiles extract served by the app, so nothing depends on OpenFreeMap.
- [ ] **Push-based sync** between the two hosts (streaming the database's write-ahead log) to reduce failover data loss from about 15 seconds to near zero.
- [ ] **Multiple trips** per server.
- [ ] **End-to-end tests in CI** with GitHub Actions.

---

## Project layout

```
server/index.js    Boot: single host or HA (lease, restore, tunnel)
server/app.js      HTTP API, private-link gate, WebSocket hub, all operations
server/auth.js     Cookie sessions with an in-memory cache, gate token
server/ha.js       Leader lease, snapshots, failover and hand-back
server/s3.js       Minimal S3/R2 client;  server/blobs.js  receipt and profile photo storage
server/notify.js   Notifications: who's told what, merging repeats, per-person switches
server/images.js   Reads image sizes from file headers (profile photo checks)
server/money.js    Expense validation;  server/links.js  map-link parsing;  server/db.js  schema
public/            No-build PWA (plain ES modules)
  js/store.js      State, WebSocket sync, offline outbox
  js/map.js        Map, markers, friends, day line strip, search
  js/itinerary.js  Days, filters, voting, reorder, Previously interested
  js/groups.js     Subgroups
  js/money.js      Expenses, splits, balances, settle-up, currency converter
  js/fx.js         Exchange rates saved on the phone, sums, home-currency guess
  js/notifications.js  Notification list, red ! badge, app icon badge, settings switches
  js/photo.js      Profile photo cropper (move, zoom, rotate, 240/320/640 px)
  js/friends.js    Friends list and friend card;  js/dev.js  developer console
  js/receipt.js    Receipt text parser;  js/ocr.js  on-device OCR
  js/tour.js       First-run tips
  js/settings.js   Account, devices, sharing, theme, offline maps, trip admin
  sw.js            Service worker
deploy/setup.sh    One-command server setup (primary or backup);  deploy/update.sh  pull and rebuild
deploy/droplet/    DigitalOcean primary (compose);  deploy/home/  home-server backup (compose)
fly.toml           Alternative primary on Fly.io (Tokyo)
docs/HOSTING.md    Domain, private link, DigitalOcean, home backup, failover runbook
```

## Configuration

All settings are environment variables. They are listed in [`.env.example`](.env.example), and the hosting ones are explained in [docs/HOSTING.md](docs/HOSTING.md).

## Location sharing in a web app

Browsers, iOS Safari in particular, pause GPS when a web app is in the background. Inside Tabi, your position updates while the app is open. For Find My-style sharing, use OwnTracks: go to Settings → *Set up OwnTracks* for the URL, username and token. It's free and open source, and sends location in the background with good battery behaviour.

## Free services used (no API keys)

- **OpenFreeMap**: map tiles (© OpenMapTiles, © OpenStreetMap contributors).
- **Photon by Komoot**: search. Requests go through your server and are cached there.
- **frankfurter.app**: exchange rates (European Central Bank data).
- **Google Maps**: only as outbound links for directions, plus server-side fetches to resolve share links and download public My Maps.
- **Tesseract.js**: OCR, served from your own server and run on the phone.
