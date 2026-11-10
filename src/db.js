import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ROLES = ['admin', 'editor', 'viewer'];
// Разделы сайта по видам работ. Опубликованная публикация попадает в раздел своего вида автоматически.
export const KIND_META = {
  situation: { label: 'Скриншот-ситуации', single: 'Скриншот-ситуация', color: '#f59e0b', icon: 'camera' },
  radio: { label: 'Радиоэфиры', single: 'Радиоэфир', color: '#a855f7', icon: 'mic' },
  event: { label: 'Мероприятия', single: 'Мероприятие', color: '#22c55e', icon: 'calendar' },
  press: { label: 'Пресс-релизы', single: 'Пресс-релиз', color: '#ec4899', icon: 'news' },
  other: { label: 'Прочее', single: 'Прочее', color: '#64748b', icon: 'file' },
};
export const PLAN_KINDS = Object.fromEntries(Object.entries(KIND_META).map(([k, v]) => [k, v.single]));
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
CREATE TABLE IF NOT EXISTS topics (   -- темы форума, по которым ведётся статистика постов
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',      -- ссылка на тему форума (необязательно)
  author TEXT,
  created_at TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT                     -- когда последний раз вносили посты
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author TEXT NOT NULL COLLATE NOCASE,
  posted_at TEXT NOT NULL            -- ISO 8601, UTC
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_unique ON posts(topic_id, author, posted_at);
CREATE INDEX IF NOT EXISTS posts_topic_time ON posts(topic_id, posted_at);
CREATE INDEX IF NOT EXISTS posts_time ON posts(posted_at);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  planned_date TEXT,                 -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'idea',
  assignee TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_edits (   -- правки объявлений за неделю (вводятся вручную)
  week_start TEXT NOT NULL,             -- понедельник, YYYY-MM-DD
  employee TEXT NOT NULL COLLATE NOCASE,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (week_start, employee)
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

/** Старые базы: «sections» (темы форума) -> «topics», section_id -> topic_id. */
function migrateLegacy(db) {
  const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('sections') || has('topics')) return;
  db.exec('ALTER TABLE sections RENAME TO topics');
  for (const t of ['posts', 'plans']) {
    if (has(t) && db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'section_id')) db.exec(`ALTER TABLE ${t} RENAME COLUMN section_id TO topic_id`);
  }
}

export function openDb(config) {
  fs.mkdirSync(config.storageDir, { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrateLegacy(db);
  db.exec(SCHEMA);
  // Миграция плана публикаций: тип, оценка качества, ручная сумма (для мероприятий).
  const cols = new Set(db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name));
  if (!cols.has('kind')) db.exec("ALTER TABLE plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
  if (!cols.has('rating')) db.exec('ALTER TABLE plans ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5)');
  if (!cols.has('url')) db.exec("ALTER TABLE plans ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  if (!cols.has('payout_override')) db.exec('ALTER TABLE plans ADD COLUMN payout_override INTEGER');

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
  if (config.adminNick) {
    db.prepare("INSERT OR IGNORE INTO members (nick, role, created_at) VALUES (?, 'admin', ?)").run(config.adminNick, now);
  }
  return db;
}
