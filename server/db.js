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
  return db;
}
