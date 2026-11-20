// SQLite storage using Node's built-in node:sqlite (Node 22.13+). No native deps.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DB_FILE = 'tabi.db';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      share_location INTEGER NOT NULL DEFAULT 0,
      owntracks_token TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      address TEXT,
      notes TEXT,
      url TEXT,
      layer TEXT,
      status TEXT NOT NULL DEFAULT 'suggested',
      day TEXT,
      time TEXT,
      sort REAL NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      PRIMARY KEY (place_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS locations (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      acc REAL,
      heading REAL,
      speed REAL,
      batt INTEGER,
      ts INTEGER NOT NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id INTEGER,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS geocache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    -- Sub-groups: the main group splitting up for a day or a few days
    CREATE TABLE IF NOT EXISTS subgroups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      start_day TEXT,
      end_day TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subgroup_members (
      subgroup_id TEXT NOT NULL REFERENCES subgroups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (subgroup_id, user_id)
    );

    -- Money: expenses and settle-up payments share one table.
    -- Amounts are integers in the currency's minor unit (yen have none, dollars have cents).
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'expense',       -- expense | payment
      title TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      rate REAL NOT NULL DEFAULT 1,               -- trip currency per 1 unit of currency
      category TEXT,
      paid_by INTEGER NOT NULL,
      date TEXT,
      place_id TEXT,
      group_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'group',   -- group | private
      split_mode TEXT NOT NULL DEFAULT 'equal',   -- equal | exact | shares | items
      notes TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS expense_shares (
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      weight REAL,
      PRIMARY KEY (expense_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS expense_items (
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      user_ids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (expense_id, idx)
    );
    -- Receipt photos and screenshots. Bytes live in the blob store; this is the index.
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      expense_id TEXT,
      blob_key TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      ocr_text TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_expense ON attachments(expense_id);

    -- Notifications: one row per person per event. Repeats of the same thing by the same
    -- person within a few minutes update the existing row instead of piling up.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      actor_id INTEGER,
      ref_type TEXT,
      ref_id TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);

    -- Emoji reactions between people ("Sam sent you 👋").
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reactions_to ON reactions(to_id, id);
    CREATE INDEX IF NOT EXISTS reactions_from ON reactions(from_id, id);

    -- Web Push: one row per device that turned on "notify me when Tabi is closed".
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ua TEXT,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER,
      last_error TEXT,
      fails INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);

    -- Custom emojis anyone can add (128×128 at most), used like :ramen: in reactions.
    CREATE TABLE IF NOT EXISTS custom_emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS custom_emojis_name ON custom_emojis(name) WHERE deleted_at IS NULL;

    -- Picture a day: up to 5 photos per trip day, from anyone. Files live in blob storage (R2).
    CREATE TABLE IF NOT EXISTS daily_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      user_id INTEGER,
      file TEXT NOT NULL,
      thumb TEXT NOT NULL,
      width INTEGER, height INTEGER,
      bytes INTEGER NOT NULL DEFAULT 0,
      caption TEXT,
      taken_at INTEGER,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS daily_photos_day ON daily_photos(day);
    -- Stays: where the group sleeps (hotel, Airbnb, ryokan), shown on the map as "home".
    CREATE TABLE IF NOT EXISTS stays (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      start_day TEXT,
      end_day TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      deleted_at INTEGER
    );
    -- Group chat: "trip" for everyone, "g:<subgroup id>" for a subgroup's members.
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      user_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      reply_to INTEGER,
      mentions TEXT,
      file TEXT, thumb TEXT, width INTEGER, height INTEGER, bytes INTEGER NOT NULL DEFAULT 0, mime TEXT,
      gif_url TEXT, gif_mp4 TEXT,
      client_id TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat, id);
    CREATE INDEX IF NOT EXISTS chat_messages_client ON chat_messages(user_id, client_id);
    CREATE TABLE IF NOT EXISTS chat_reactions (
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    -- Where each stored file (photo, chat picture, receipt, emoji...) has a copy: hot = R2, cold =
    -- the second store (B2). Lets old full-size pictures leave R2 once B2 has a checked copy.
    CREATE TABLE IF NOT EXISTS blob_index (
      key TEXT PRIMARY KEY,
      kind TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_read_at INTEGER,
      reads INTEGER NOT NULL DEFAULT 0,
      hot INTEGER NOT NULL DEFAULT 0,
      cold INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER,
      problem TEXT
    );
    CREATE INDEX IF NOT EXISTS blob_index_hot ON blob_index(hot, cold);
    CREATE TABLE IF NOT EXISTS chat_reads (
      user_id INTEGER NOT NULL,
      chat TEXT NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, chat)
    );
    CREATE TABLE IF NOT EXISTS photo_likes (
      photo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (photo_id, user_id)
    );

    -- One-time links an admin makes so someone who forgot their password can set a new one.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);

  // Column migrations for databases created by earlier versions
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const add = (t, c, def) => { if (!cols(t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('places', 'removed_at', 'INTEGER');
  add('places', 'removed_by', 'INTEGER');
  add('places', 'group_id', 'TEXT');
  add('sessions', 'user_agent', 'TEXT');
  add('users', 'avatar', 'TEXT');          // blob key of the profile photo
  add('users', 'notify_prefs', 'TEXT');    // JSON: { kind: true|false }, missing kinds use defaults
  add('users', 'ot_status', 'TEXT');       // last OwnTracks result: stored | bad-token | ignored-sharing-off | ignored-<type>
  add('users', 'ot_status_at', 'INTEGER'); // when that message arrived
  add('users', 'ot_ok_at', 'INTEGER');     // when OwnTracks last delivered a location that was saved
  add('users', 'ot_info', 'TEXT');         // JSON: battery, accuracy, trigger, device, app version of the last message
  add('expenses', 'reset_batch', 'TEXT');  // set when "Clear all expenses" removed it, so that clear can be undone
  add('users', 'removed_at', 'INTEGER');   // removed from (or left) the trip: kept so their expenses and balances stay right
  add('users', 'removed_by', 'INTEGER');
  add('users', 'recovery_hash', 'TEXT');   // hashed recovery code for "Forgot password?"
  add('users', 'recovery_set_at', 'INTEGER');
  add('users', 'recovery_snooze', 'INTEGER'); // "Remind me later" on the set-up prompt, until this time
  // The newest recovery code stays viewable in Settings until its owner confirms they saved it; then only the hash is kept.
  add('users', 'recovery_pending', 'TEXT');
  add('users', 'recovery_ack_at', 'INTEGER');
  restoreFormerMembers(db);
  return db;
}

// Before 1.5, removing someone deleted their account row, but their expenses, shares and places stayed.
// Balances then didn't add up. Bring those people back as former members (they can't sign in), named
// from the activity log where possible, so every expense points at someone again. Safe to run every start.
function restoreFormerMembers(db) {
  const ids = db.prepare(`
    SELECT paid_by id FROM expenses UNION SELECT user_id FROM expense_shares UNION SELECT created_by FROM places WHERE created_by IS NOT NULL
  `).all().map((r) => r.id).filter((id) => Number.isInteger(id) && id > 0);
  const missing = ids.filter((id) => !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  for (const id of missing) {
    const joined = db.prepare("SELECT text FROM activity WHERE user_id = ? AND text LIKE '% joined the trip' ORDER BY id LIMIT 1").get(id);
    let base = joined ? joined.text.replace(/ joined the trip$/, '').trim() : '';
    if (!base) base = `Former member ${id}`;
    let name = base, k = 1;
    while (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) name = `${base} (left${k++ > 1 ? ` ${k - 1}` : ''})`;
    db.prepare('INSERT INTO users(id, name, color, pass_hash, created_at, removed_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, name.slice(0, 40), '#8A8F98', '!', Date.now(), Date.now());
    console.log(`[db] restored former member #${id} as "${name}" so their expenses still count`);
  }
}
