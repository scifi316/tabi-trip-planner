// SQLite storage using Node's built-in node:sqlite (Node 22.13+). No native deps.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'tabi.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
  `);
  return db;
}
