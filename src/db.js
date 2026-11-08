import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ROLES = ['admin', 'editor', 'viewer'];
export const PLAN_STATUSES = {
  idea: 'Идея',
  draft: 'В работе',
  ready: 'Готово к публикации',
  published: 'Опубликовано',
  cancelled: 'Отменено',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  nick TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,            -- id темы на форуме
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  created_at TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,            -- id комментария на форуме
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  author TEXT NOT NULL COLLATE NOCASE,
  posted_at TEXT NOT NULL            -- ISO 8601, UTC
);
CREATE INDEX IF NOT EXISTS posts_section_time ON posts(section_id, posted_at);
CREATE INDEX IF NOT EXISTS posts_time ON posts(posted_at);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  planned_date TEXT,                 -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'idea',
  assignee TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_unique ON folders(IFNULL(parent_id, 0), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(config) {
  fs.mkdirSync(config.storageDir, { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  db.tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const now = new Date().toISOString();
  if (!db.prepare('SELECT 1 FROM folders WHERE parent_id IS NULL').get()) {
    db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (NULL, ?, ?)').run('Хранилище', now);
  }
  db.getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  db.setSetting = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  if (!db.getSetting('session_secret')) db.setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  if (!db.getSetting('ingest_token')) db.setSetting('ingest_token', crypto.randomBytes(24).toString('hex'));
  if (config.adminNick) {
    db.prepare("INSERT OR IGNORE INTO members (nick, role, created_at) VALUES (?, 'admin', ?)").run(config.adminNick, now);
  }
  return db;
}
