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
  - **Say hi**: send them 👋 ❤️ 😂 🎉 🙏 👍 😮 or 🍻, with the last few you've swapped.
- [x] **Emoji reactions**: what someone sends pops up at the top of your screen with quick replies, floats up the screen, and pops up from their spot on the map. *Wave to everyone* in the Friends list greets the whole trip. Up to 40 a minute per person; they can be switched off under Notifications in Settings.
- [x] **Custom emojis**: anyone can add one with a name like `:ramen:`.
  - Pick a picture, move and zoom it in a square (see-through backgrounds are kept), and it's saved at 128×128, 64 KB at most.
  - Send them from the *+* in a friend's card; the ones you use often get their own buttons.
  - Up to 100 per trip. Whoever added one, or an admin, can remove it.
- [x] **Clusters**: as you zoom out, nearby places group into one marker with a count and a ring split by status colour. Tapping one zooms to fit everything in it. If they're all at the same spot, it lists them instead. The place you have open always stays visible, and the day's numbered stops stay separate until you zoom out past city level.
- [x] Markers stay pinned to their spot while you zoom and pan.
- [x] **Follow mode**: tap the locate button twice, or tap your blue dot, and the map keeps you centred as you move. Tap a friend on the map, or *Follow* on their card, to keep them centred. Dragging the map or *Stop* ends it.
- [x] **Show everyone** map button fits everyone who's sharing their location, alongside *fit all places*. Fitting, flying to a place and pinpointing a friend all leave room for whatever card or panel is open: at the bottom on phones, at the side on computers.
- [x] Tooltips on icon buttons, shown with a mouse or keyboard only (never for touch). They also work on laptops with a touchscreen, which hid them before 1.6.
- [x] **Phones held sideways**: navigation becomes a slim rail on the left, search, friends and the map buttons share one row along the top, and cards dock beside the map instead of covering it.
- [x] **Stays (where we're sleeping)**: add the hotel, Airbnb or ryokan by address, a pasted map link, or by setting it on the map.
  - Each stay has the nights it covers, so a multi-city trip can have several.
  - Stays show as houses on the map, never clustered. The one for tonight is marked **Home**.
  - The **Home** chip flies to tonight's stay. Its card has *Directions home*, the address and notes.
  - Japanese addresses with building numbers that aren't on the map fall back to the neighbourhood, and the app says the result is approximate.
- [x] **Picture a day**: anyone can add the day's photo, up to 5 for each trip day.
  - Add from the camera button on the day strip, or from the itinerary.
  - Photos are shrunk in the browser (2048 px, a few hundred KB) and location and camera data are removed.
  - Likes: the most liked photo becomes the day's cover.
  - Captions, a full-screen viewer, and an album of every day that downloads as one zip.
  - If a day has no photo by the evening (19:00 by default; admins can change or turn this off), everyone gets a nudge.
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
- [x] **Group chat** (1.8): one chat for **Everyone** on the trip, and one for each subgroup that only its members can see. Members join and leave a subgroup's chat as they're added or taken out.
  - Photos (shrunk on the phone, location data removed), animated GIFs from the phone kept as they are, and GIF search through **KLIPY** when the server has a key.
  - Replies with a quote, emoji reactions (including custom emojis), @mentions with suggestions (and @everyone), links, big single emojis. Delete your own messages; admins can delete any.
  - Unread counts on the Chat tab and each chat, and a "New messages" line. Messages typed offline wait and send when you reconnect, once each.
  - Notifications (lock screen too) for @mentions and replies by default; "every message" is a switch, merged per chat. Nothing is sent about a chat you have open.
  - Phones show the list, then the conversation full screen; computers show both side by side. 30 messages a minute per person; photos share a space cap (`CHAT_MEDIA_LIMIT_MB`).
- [x] Always-on sharing through the free **OwnTracks** app (built-in endpoint). Friends also show up inside OwnTracks.
  - Settings shows what Tabi last heard from OwnTracks for you:
    - **Working**, with the time, battery and accuracy
    - **Not heard lately**: nothing for 6 hours
    - **Failing**: wrong token
    - **Not saved**: sharing is off
    - **Not set up**
  - The setup sheet updates live, so you can test it by tapping upload in OwnTracks.
  - The username isn't case-sensitive.
- [x] **Tabi for Android** (1.8): an app for the Android phones in the group. It's Tabi full screen (Chrome underneath, so sign-in and notifications carry over) plus background location sharing, without OwnTracks. Admins upload each build in Settings; people download it there and connect it in one tap. See [docs/ANDROID.md](docs/ANDROID.md).
- [x] Activity feed in Settings: the latest 10, "Show more" back through the last 500 entries, and search (offline it searches what the phone has).
- [x] **Clear all expenses** (admins, in Settings): everything or shared ones only, with typed confirmation and an Undo. The last clear can also be undone later from Settings. Everyone involved is notified.
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
  - someone sends you an emoji reaction
  - chat: someone @mentions you or replies to you; optionally every message
  - picture a day: someone adds a photo, and the evening reminder

  Unread ones show as a red **!** on your picture, and as a badge on the home-screen icon where the phone supports it. Tap your picture to read them; tapping one takes you to the place, expense, subgroup or person. Repeats of the same thing within 15 minutes update one notification instead of piling up.
  - **Dismiss** one with ×, or **Clear all** (it asks first). Either way they're gone from all your devices.
  - **On the lock screen when Tabi is closed (Web Push)**, switched on per device in Settings. The same per-kind choices apply, and pushes only go out when Tabi isn't on screen. Works in Chrome, Edge and Firefox on computers and Android, and on iPhone (iOS 16.4+) from the Home Screen app. No accounts or services to set up.
  - **On a computer**, the rail has a **Notifications** page with an unread count: grouped by day, All or Unread, *Mark all read*, *Clear all*, and *Show older* back through everything kept. Clicking your picture opens a short list right next to it, with *See all notifications*.

### Getting places in
- [x] Google **My Maps**, by share link or KML/KMZ export. Layers are mapped to days automatically ("Day 2", "3/14", "2日目").
- [x] Links from Google Maps (including `maps.app.goo.gl`), Apple Maps and OpenStreetMap, plus `geo:` URIs and raw coordinates.
- [x] Google Takeout saved places (GeoJSON or CSV), GPX and CSV files.
- [x] Places already in the trip are detected and skipped.

### App
- [x] Light and dark mode, either following the phone or set by hand.
- [x] Offline: the app opens with no connection. Map areas you've viewed are cached, and you can **save maps around all your places** ahead of time. Receipt images are cached too.
- [x] **First-run tips** for each screen, which can be skipped and replayed from Settings. People who already finished them get a short "what's new" tour once.
- [x] **Staying up to date**: open apps reload themselves when a new version is deployed.
  - If a browser keeps loading an old copy, the next try clears Tabi's offline copy first.
  - If even that fails, the app stops and reports it to the developer console.
  - Settings shows the version, the build and which server answered, with a *Reload app* button.
- [x] Phones held sideways can rotate the installed app too (it was locked to portrait before 1.7).
- [x] Export the trip as KML or JSON.

### Developer console
- [x] `/dev`, behind its own `DEV_KEY`. It updates live. Its only actions are clearing expenses and making password reset links.
  - **Overview:** server health and failover state, data counts, settings, and who has the app open. It can also clear all expenses (type CLEAR) and undo the last clear.
  - **Accounts:** everyone, current and former. It shows whether each person's recovery code is saved, made but not saved yet, or missing, their devices and when they were last seen, and can make a one-time password reset link. Useful if the only admin is the one locked out.
  - **Locations:** a map with trails, plus every location update with its source, accuracy, battery and delay.
  - **OwnTracks:** every request with its result. Wrong token, unknown user, sharing off, or stored.
  - **Places:** the full table, including removed places and who removed them.
  - **Activity:** sign-ins (including failed ones), changes and connections.
  - **Network:** the server's calls to search, R2, Google and exchange rates.
  - **Servers:** the version each server runs, flagged when they differ (a backup on older code serves the old app whenever it takes over). The *Connected right now* list shows each person's app build, flagging out-of-date ones.
  - **App errors:** errors from people's browsers (up to 30 per person per server run), with the screen, app build and browser, so "this button doesn't work" can be traced.
  - **Server log.**

### Hosting and security
- [x] Self-hosted Node.js app with SQLite (built into Node). The only server dependencies are `ws` and `aws4fetch`.
- [x] **Private link gate**: without the secret key, the site returns "Not found".
- [x] Cookie sessions (HttpOnly, Secure, SameSite), stored hashed, cached in memory, with sliding expiry. You can see your signed-in devices and sign the others out.
- [x] **Forgot password, without losing the account:**
  - **Recovery code:** a one-time code, 80 bits, stored hashed, that you set up in the app. Everyone is asked after signing in (with "Remind me later", which waits 3 days). With it, you set a new password from the sign-in screen and get a fresh code. Your other devices are signed out. It allows 5 wrong tries per name per hour.
    - A new code works straight away, and can be viewed again in *Settings → Account recovery* until you tick that you've saved it and choose *I've saved it, hide it*. Only then is the readable copy deleted. Until then Settings shows a reminder at the top, and the app reminds you after signing in.
    - Codes made before 1.6 can't be shown again (only the hash was kept), so the app asks once whether you saved it: *Yes, I saved it* or *Make a new code*.
  - **No code? "Ask a trip admin"** notifies the admins without revealing whether the name exists. An admin makes a **reset link** in Settings → People. It's single-use, lasts 24 hours, and each new link cancels the last. You and the admin are both notified when it's used.
- [x] **Removing someone, or leaving, keeps their account as a former member.** They can't sign in, but their expenses still count, so balances stay right; they show as "left the trip".
  - Admins can bring them back, or **merge** the old account into a new one if they rejoined under a different name.
  - People removed before 1.5 (when removal deleted the account) are restored automatically from their expenses, named from the activity log.
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

- [ ] **Games**: Connect 4 and pool against each other, with spectators. Feasible too (pool needs deterministic physics); see [docs/FEASIBILITY.md](docs/FEASIBILITY.md).
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
server/push.js     Web Push: encryption (RFC 8291) and signing (RFC 8292) with Node’s own crypto, no extra dependencies
server/images.js   Reads image sizes from file headers (profile photo checks)
server/chat.js     Group chat: who's in which chat, messages, mentions, reactions, unread counts
server/apk.js      The uploaded Android app: version and signing key read from the APK
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
  js/owntracks.js  OwnTracks status in plain words (working, failing, not heard lately, not set up)
  js/receipt.js    Receipt text parser;  js/ocr.js  on-device OCR
  js/tour.js       First-run tips
  js/settings.js   Account, devices, sharing, theme, offline maps, trip admin
  js/push.js       Lock-screen notifications (Web Push), per device
  js/photos.js     Picture a day: adding, viewer, album
  js/stays.js      Where we're staying: houses on the map, Home
  js/emoji.js      Custom emojis: editor and picker
  js/chat.js       Group chat: list, conversation, photos, KLIPY GIFs, mentions
  js/android.js    The Android app: download, connect, admin upload
android/           Tabi for Android (Kotlin): full-screen Tabi plus background location; see docs/ANDROID.md
.github/workflows/android.yml  Builds the APK on GitHub
  sw.js            Service worker
deploy/setup.sh    One-command server setup (primary or backup);  deploy/update.sh  pull and rebuild
deploy/droplet/    DigitalOcean primary (compose);  deploy/home/  home-server backup (compose)
fly.toml           Alternative primary on Fly.io (Tokyo)
docs/HOSTING.md    Domain, private link, DigitalOcean, home backup, failover runbook
docs/ANDROID.md    The Android app: installing, signing, publishing updates
docs/FEASIBILITY.md  Group chat, Connect 4 and pool: what they'd take
```

## Configuration

All settings are environment variables. They are listed in [`.env.example`](.env.example), and the hosting ones are explained in [docs/HOSTING.md](docs/HOSTING.md).

## Location sharing in a web app

Browsers, iOS Safari in particular, pause GPS when a web app is in the background. Inside Tabi, your position updates while the app is open. For Find My-style sharing on Android, install **Tabi for Android** from Settings (see [docs/ANDROID.md](docs/ANDROID.md)). On iPhone, or if you prefer it, use OwnTracks: go to Settings → *Set up OwnTracks* for the URL, username and token. It's free and open source, and sends location in the background with good battery behaviour.

## Free services used (no API keys)

- **OpenFreeMap**: map tiles (© OpenMapTiles, © OpenStreetMap contributors).
- **Photon by Komoot**: search. Requests go through your server and are cached there.
- **frankfurter.app**: exchange rates (European Central Bank data).
- **Google Maps**: only as outbound links for directions, plus server-side fetches to resolve share links and download public My Maps.
- **Tesseract.js**: OCR, served from your own server and run on the phone.
