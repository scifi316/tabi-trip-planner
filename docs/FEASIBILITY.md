# Feasibility: group chat, Connect 4 and pool

Written for 1.7.0 (November 2026). Short version: **all three fit on the current setup** (one 1 GB DigitalOcean droplet, the home server as backup, Cloudflare R2 for files) with no new monthly costs. Storage and computing power aren't the constraint; the work is in the interface, and in each case it's about one iteration.

## What we have to work with

| Resource | Allowance | Used today |
|---|---|---|
| Droplet | 1 vCPU, 1 GB RAM, 1 TB outbound transfer a month | A few % CPU, ~100 MB RAM, a few GB of transfer |
| Cloudflare R2 (photos, receipts, backups) | 10 GB stored, 1 M writes and 10 M reads a month, free; downloads always free | Megabytes |
| SQLite database | Snapshotted to R2 every ~15 s; tens of MB is fine | About 1 MB |
| Live connection | Every open app already has a WebSocket to the server | Used for sync, locations, reactions |
| Notifications | In-app list, plus lock-screen Web Push (new in 1.7) | |

## 1. Group chat

### Text
Trivial. A `messages` table, the existing WebSocket for delivery, and the existing offline queue for sending without signal. Ten people sending 200 messages a day for 15 days is about 30,000 rows, a few MB. Unread counts and paging work the same way as notifications.

### Pictures
These would reuse the Picture a day pipeline:

- **In the browser:** shrink to about 1600 px WebP (200 to 400 KB) plus a thumbnail, and strip location data.
- **Storage:** R2.

A busy group (10 people, 10 photos each a day, 15 days) is about 500 MB. With Picture a day's ~45 MB, that's well inside R2's free 10 GB. Each picture is downloaded by up to 10 people, about 5 GB a trip, against the droplet's 1 TB a month. A per-trip cap, like the one Picture a day now has, keeps it bounded.

### GIFs
Two options, and I'd do both:

1. **GIF search.**
   - **Tenor is gone:** Google shut down the Tenor API on 30 June 2026.
   - **GIPHY:** its free "beta" key allows 100 searches an hour and needs a "Powered by GIPHY" label. Higher limits need approval and, now, payment.
   - **KLIPY:** the most practical choice. It was built as a Tenor replacement, has a free test key (100 calls a minute) and offers free production keys for small apps.
   - **How it would work:** the server makes the searches (the key stays secret, results are cached, and the GIF service never sees who is searching). Messages store only the GIF's address, not the file, so GIFs cost no storage.
   - **Risk:** if a provider disappears like Tenor did, old GIFs stop loading. Uploads are the fallback.
2. **Upload a GIF from your phone.** Kept as an animated file (browsers can't re-encode animation cheaply), capped at around 5 MB, and stored in R2 like photos.

### Notifications
Chat would use the Web Push that 1.7 adds. Per-message pushes to everyone get noisy, so the default would be:
- direct mentions (@Sam) and replies
- a quiet "12 new messages" after a lull

Everyone could switch to every message, or mute.

### Scope I'd suggest
- One chat for the whole trip, and one for each subgroup (subgroups already exist).
- Text, photos, GIFs, the existing emoji and custom emoji as reactions on messages.
- Delete your own messages, and admins can delete any.

Not at first: direct messages, read receipts, typing indicators, voice notes.

**Verdict:** feasible, about one iteration including GIF search. Over a VPN or slow hotel Wi-Fi the existing offline queue already handles sending later.

## 2. Connect 4 and pool, with spectating

### Database and computing power: not an issue
- **Connect 4:** a game is 42 cells and at most 42 moves. Checking a move takes microseconds. Each game is a row of moves in SQLite.
- **Pool:** a shot is an angle, power and spin, about 50 bytes. Even a fully server-side simulation of 16 balls for 10 seconds at 120 steps a second is roughly 1,200 simple steps, a few milliseconds of CPU on the droplet. A game is a list of shots.
- **Spectating:** the server already pushes live updates to every open app, so watchers join a game's stream like a subgroup. Each shot or move goes to maybe 10 people.
- **Failover:** games live in the database, so a failover mid-game loses at most the last ~15 s, the same as everything else.

### The one technical decision: making pool look the same for everyone
Each browser animates the shot itself, so they must all compute exactly the same result. Ordinary floating-point physics can differ slightly between browsers and devices (trigonometry especially), and over a long break shot small differences grow.

The fix is to write the physics with whole numbers only (fixed-point maths, no `Math.sin`) in one small module that every browser and the server run. Then:
- the shooter's app sends the shot;
- the server checks it and stores it;
- everyone, spectators included, replays the identical simulation.

Nothing heavy is streamed, and it works on slow connections.

### Effort
- **Connect 4:** lobby, invite a friend, turns, win check, rematch, spectating, and "your turn" push notifications. About half an iteration.
- **Pool (8-ball):** the deterministic physics module, a canvas table, a touch-friendly aiming and power control, and the rules (fouls, ball groups, the 8 ball). About one to one and a half iterations, most of it in making aiming feel good on a phone.

**Verdict:** both are feasible on the current servers with no added cost. I'd build Connect 4 first (quick, proves the lobby and spectating), then pool on the same lobby.

## 3. Storage for Picture a day (and why one provider is enough)

Using multiple storage providers was suggested. At this size it adds complexity (two sets of keys, keeping them in sync, two places that can fail) without a real benefit:

- **Volume:** photos are shrunk in the browser before upload. Five a day for 15 days is about 45 MB, under 1% of R2's free 10 GB. R2 never charges for downloads.
- **Durability:** R2 stores data redundantly. Each server also keeps its own copy of every photo it has served, and the database (with the photo list) is snapshotted to R2 continuously.
- **Cost control:** a cap (`PHOTO_LIMIT_MB`, default 2048) stops uploads with a clear message long before anything is billed. Admins see the space used in Settings, and the developer console shows it too.
- **If you still want a second copy:** a nightly `rclone sync` of the R2 bucket to Backblaze B2 (also 10 GB free) is a one-line cron job on the home server and needs no app changes.
