import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, ago, dayStr } from './helpers.js';
import { normalizeScores, rawActivity } from '../src/stats.js';
import { parsePostLines, zonedToUtc } from '../src/manual.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const fmt = (iso) => { const d = new Date(iso); const z = (n) => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}.${z(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`; };
const W = { week: 0.5, month: 0.3, authors: 2 };

test('активность нормируется к 0–100', () => {
  assert.equal(rawActivity({ week: 4, month: 10, authors: 2 }, W), 9);
  assert.deepEqual(normalizeScores([9, 4.5, 0]), [100, 50, 0]);
  assert.deepEqual(normalizeScores([0, 0]), [0, 0]);
});

test('разбор строк: оба формата даты, часовой пояс, ошибки', () => {
  const ok = parsePostLines('08.11.2026 22:58 Brianna_Delgado\n2026-11-07 17:16 Richard Northwood\n\n', 'Europe/Moscow', new Date('2026-11-09T00:00:00Z'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.posts[0].at, '2026-11-08T19:58:00.000Z');
  assert.equal(ok.posts[1].author, 'Richard Northwood');
  assert.equal(parsePostLines('вчера Ann\n31.02.2026 10:00 Ann\n01.01.2099 10:00 Ann', 'UTC', new Date('2026-11-09T00:00:00Z')).errors.length, 3);
  assert.equal(zonedToUtc(2026, 7, 1, 12, 0, 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z');
});

test('доступ: без входа 401, чужой ник 403, без CSRF-заголовка 403, подделанная кука 401', async () => {
  const { app, as } = await setup();
  assert.equal((await app.inject({ url: '/api/overview' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { nick: 'Boss' } })).statusCode, 403); // нет X-Requested-With
  assert.equal((await as('Stranger')).loginStatus, 403);
  assert.equal((await app.inject({ url: '/api/plans', headers: { cookie: 'sid=forged.sig' } })).statusCode, 401);
  const me = JSON.parse((await app.inject({ url: '/api/me' })).body);
  assert.equal(me.user, null);
  const boss = await as('boss'); // регистр ника не важен
  assert.equal((await boss('GET', '/api/me')).json.user.role, 'admin');
  const noHeader = await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie: boss.cookie, 'content-type': 'application/json' }, payload: '{"title":"x"}' });
  assert.equal(noHeader.statusCode, 403);
  await app.close();
});

test('форум: темы, ввод постов, дубли, ошибки, периоды, удаление', async () => {
  const { app, as } = await setup();
  const ed = await as('Ed');
  const { json: { id } } = await ed('POST', '/api/forum/topics', { title: 'Press releases' });
  const text = [ago(2), ago(30), ago(24 * 10), ago(24 * 40)].map((t, i) => `${fmt(t)} ${['Ann', 'ann', 'Bob', 'Cid'][i]}`).join('\n');
  assert.deepEqual((await ed('POST', `/api/forum/topics/${id}/posts`, { text })).json, { added: 4, skipped: 0 });
  assert.deepEqual((await ed('POST', `/api/forum/topics/${id}/posts`, { text })).json, { added: 0, skipped: 4 });
  const err = await ed('POST', `/api/forum/topics/${id}/posts`, { text: `${fmt(ago(1))} Dan\nмусор` });
  assert.equal(err.status, 400);
  assert.equal(err.json.details.length, 1);
  const t = (await ed('GET', `/api/forum/topics/${id}`)).json;
  assert.deepEqual([t.total, t.day, t.week, t.month, t.authors30], [4, 1, 2, 3, 2]);
  assert.equal(t.topAuthors[0].count, 2);
  assert.equal(t.perDay.length, 30);
  assert.equal((await ed('GET', '/api/forum')).json.topics[0].score, 100);
  assert.equal((await ed('GET', '/api/forum/users?period=7')).json.users.length, 1);
  await ed('DELETE', `/api/forum/topics/${id}/posts/${t.recent[0].id}`);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 3);
  await ed('DELETE', `/api/forum/topics/${id}`);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 0);
  await app.close();
});

test('права: viewer только читает, выплаты и участники — только admin, суммы скрыты от editor', async () => {
  const { app, as } = await setup();
  const [boss, ed, view] = [await as('Boss'), await as('Ed'), await as('View')];
  assert.equal((await view('POST', '/api/plans', { title: 'x' })).status, 403);
  assert.equal((await view('GET', '/api/plans')).status, 200);
  for (const [m, u] of [['GET', '/api/payouts'], ['GET', '/api/payouts/rates'], ['GET', '/api/admin/members']]) assert.equal((await ed(m, u)).status, 403);
  await ed('POST', '/api/plans', { title: 'Фото', kind: 'situation', status: 'published', planned_date: dayStr(-1), assignee: 'Ann', rating: 5 });
  assert.equal((await ed('GET', '/api/plans')).json.plans[0].payout, undefined);
  assert.equal((await boss('GET', '/api/plans')).json.plans[0].payout, 100000);
  assert.equal((await boss('PUT', '/api/admin/members', { nick: 'Boss', role: 'viewer' })).status, 400);
  assert.equal((await boss('DELETE', '/api/admin/members?nick=Boss')).status, 400);
  await app.close();
});

test('публикации: валидация и смена статуса', async () => {
  const { app, as } = await setup();
  const ed = await as('Ed');
  assert.equal((await ed('POST', '/api/plans', { title: '' })).status, 400);
  assert.match((await ed('POST', '/api/plans', { title: 'a', rating: 9 })).json.error, /от 1 до 5/);
  assert.match((await ed('POST', '/api/plans', { title: 'a', kind: 'event', payout_override: 50000 })).json.error, /Ручная сумма/);
  assert.match((await ed('POST', '/api/plans', { title: 'a', url: 'javascript:alert(1)' })).json.error, /http/);
  const { json: { id } } = await ed('POST', '/api/plans', { title: 'Эфир', kind: 'radio', description: 'Кратко' });
  assert.equal((await ed('PATCH', `/api/plans/${id}/status`, { status: 'nope' })).status, 400);
  assert.equal((await ed('PATCH', `/api/plans/${id}/status`, { status: 'ready' })).status, 200);
  assert.equal((await ed('GET', '/api/plans')).json.plans[0].status, 'ready');
  await app.close();
});

test('опубликованное автоматически попадает в раздел своего вида', async () => {
  const { app, as } = await setup();
  const ed = await as('Ed');
  const mk = (o) => ed('POST', '/api/plans', { title: 'x', planned_date: dayStr(-2), assignee: 'Ann', ...o });
  const { json: { id } } = await mk({ title: 'ДТП', kind: 'situation', status: 'draft', rating: 4 });
  await mk({ title: 'Погоня', kind: 'situation', status: 'published', rating: 2, assignee: 'Bob' });
  await mk({ title: 'Эфир', kind: 'radio', status: 'published', rating: 5 });
  await mk({ title: 'Отмена', kind: 'situation', status: 'cancelled' });
  let sit = (await ed('GET', '/api/sections/situation')).json;
  assert.deepEqual(sit.items.map((i) => i.title), ['Погоня']);
  assert.deepEqual(sit.inProgress.map((i) => i.title), ['ДТП']);
  await ed('PATCH', `/api/plans/${id}/status`, { status: 'published' }); // публикация -> появилась в разделе
  sit = (await ed('GET', '/api/sections/situation')).json;
  assert.deepEqual(sit.items.map((i) => i.title).sort(), ['ДТП', 'Погоня']);
  assert.equal(sit.inProgress.length, 0);
  assert.equal(sit.stats.published, 2);
  assert.equal(sit.stats.avgRating, 3);
  assert.deepEqual(sit.stats.ratingDist, [0, 1, 0, 1, 0]);
  assert.equal(sit.stats.weekly.reduce((a, b) => a + b, 0), 2);
  assert.deepEqual(sit.stats.authors.map((a) => a.nick).sort(), ['Ann', 'Bob']);
  assert.equal((await ed('GET', '/api/sections/radio')).json.items.length, 1);
  assert.equal((await ed('GET', '/api/sections/nope')).status, 404);
  const ov = (await ed('GET', '/api/overview')).json;
  assert.equal(ov.content.total.published, 3);
  assert.equal(ov.content.byKind.situation.published, 2);
  assert.equal(ov.payouts, null);
  await app.close();
});

test('объявления: ввод по неделям, история, удаление', async () => {
  const { app, as } = await setup();
  const ed = await as('Ed');
  assert.equal((await ed('PUT', '/api/ads', { week: dayStr(-1), employee: 'Ann', count: 120 })).status, 200);
  await ed('PUT', '/api/ads', { week: dayStr(-1), employee: 'Ann', count: 130 }); // обновление
  await ed('PUT', '/api/ads', { week: dayStr(-1), employee: 'Bob', count: 20 });
  assert.equal((await ed('PUT', '/api/ads', { week: dayStr(0), employee: 'Ann', count: -1 })).status, 400);
  const a = (await ed('GET', '/api/ads')).json;
  assert.equal(a.weekly.values.reduce((x, y) => x + y, 0), 150);
  assert.equal(a.leaders[0].employee, 'Ann');
  const wk = a.entries.length ? a.week : null;
  assert.ok(wk === null || a.entries.length >= 1);
  await ed('DELETE', `/api/ads?week=${dayStr(-1)}&employee=Bob`);
  assert.equal((await ed('GET', '/api/ads')).json.weekly.values.reduce((x, y) => x + y, 0), 130);
  await app.close();
});

test('файлы: загрузка во вложения публикации, скачивание, удаление, каскад папок', async () => {
  const { app, config, as } = await setup();
  const ed = await as('Ed');
  const { json: { id: pid } } = await ed('POST', '/api/plans', { title: 'Пост' });
  const b = 'XXBOUND';
  const body = (fields, fname = '../shot.png') => `--${b}\r\n${fields.map(([k, v]) => `Content-Disposition: form-data; name="${k}"\r\n\r\n${v}`).join(`\r\n--${b}\r\n`)}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${b}--\r\n`;
  const upload = (fields) => app.inject({ method: 'POST', url: '/api/files', payload: body(fields), headers: { cookie: ed.cookie, 'x-requested-with': 'spa', 'content-type': `multipart/form-data; boundary=${b}` } });
  const up = await upload([['plan_id', pid]]);
  assert.equal(up.statusCode, 200);
  const f = app.db.prepare('SELECT * FROM files').get();
  assert.equal(f.original_name, 'shot.png');
  assert.equal(f.plan_id, pid);
  assert.ok(fs.existsSync(path.join(config.storageDir, f.stored_name)));
  assert.equal((await ed('GET', '/api/plans')).json.plans[0].files[0].name, 'shot.png');
  const dl = await ed('GET', `/api/files/${f.id}/download`);
  assert.equal(dl.res.body, 'PNGDATA');
  assert.equal(dl.res.headers['x-content-type-options'], 'nosniff');
  assert.equal((await upload([['folder_id', 99999]])).statusCode, 400);
  await ed('DELETE', `/api/files/${f.id}`);
  assert.ok(!fs.existsSync(path.join(config.storageDir, f.stored_name)));
  const root = (await ed('GET', '/api/files')).json;
  const { json: { id: folder } } = await ed('POST', '/api/files/folders', { parent_id: root.folder.id, name: 'Скрины' });
  await upload([['folder_id', folder]]);
  const stored = app.db.prepare('SELECT stored_name FROM files').get().stored_name;
  assert.equal((await ed('GET', `/api/files?folder=${folder}`)).json.files.length, 1);
  assert.equal((await ed('DELETE', `/api/files/folders/${root.folder.id}`)).status, 400); // корень нельзя
  await ed('DELETE', `/api/files/folders/${folder}`);
  assert.ok(!fs.existsSync(path.join(config.storageDir, stored)));
  await app.close();
});

test('миграция старой базы: sections -> topics, section_id -> topic_id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const old = new DatabaseSync(path.join(dir, 'stats.sqlite'));
  old.exec(`CREATE TABLE sections (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', author TEXT, created_at TEXT, locked INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE, author TEXT NOT NULL COLLATE NOCASE, posted_at TEXT NOT NULL);
    CREATE UNIQUE INDEX posts_unique ON posts(section_id, author, posted_at);
    CREATE TABLE plans (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL, planned_date TEXT, status TEXT NOT NULL DEFAULT 'idea', assignee TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO sections (title) VALUES ('Старая тема'); INSERT INTO posts (section_id, author, posted_at) VALUES (1, 'Ann', '2026-01-01T00:00:00.000Z');
    INSERT INTO plans (title, section_id, created_by, created_at, updated_at) VALUES ('P', 1, 'x', 'x', 'x');`);
  old.close();
  const cfg = loadConfig({ DATA_DIR: dir });
  const db = openDb(cfg);
  assert.equal(db.prepare('SELECT title FROM topics').get().title, 'Старая тема');
  assert.equal(db.prepare('SELECT topic_id FROM posts').get().topic_id, 1);
  assert.equal(db.prepare('SELECT topic_id, kind, url FROM plans').get().kind, 'other');
  db.prepare('DELETE FROM topics').run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 0); // каскад работает после переименования
  db.close();
});

test('клиентское приложение раздаётся статикой, все модули на месте', async () => {
  const { app } = await setup();
  const index = await app.inject({ url: '/' });
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /id="app"/);
  for (const url of ['/js/app.js', '/js/lib.js', '/js/ui.js', '/js/views/dashboard.js', '/js/views/shared.js', '/vendor/preact-htm.js', '/styles.css', '/manifest.webmanifest', '/sw.js', '/icon.svg']) {
    assert.equal((await app.inject({ url })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ url: '/api/nope' })).statusCode, 401); // API закрыт даже для несуществующих адресов
  await app.close();
});

test('пресс-релизы: отдельный раздел, наполняется автоматически, в выплатах не участвует', async () => {
  const { app, as } = await setup();
  const ed = await as('Ed'), boss = await as('Boss');
  assert.equal((await ed('GET', '/api/me')).json.meta.kinds.press.label, 'Пресс-релизы');
  await ed('POST', '/api/plans', { title: 'Итоги месяца', kind: 'press', status: 'published', planned_date: dayStr(-1), assignee: 'Ann', rating: 5 });
  await ed('POST', '/api/plans', { title: 'Черновик релиза', kind: 'press', status: 'draft' });
  const s = (await ed('GET', '/api/sections/press')).json;
  assert.deepEqual(s.items.map((i) => i.title), ['Итоги месяца']);
  assert.deepEqual(s.inProgress.map((i) => i.title), ['Черновик релиза']);
  assert.equal(s.stats.avgRating, 5);
  assert.equal((await ed('GET', '/api/overview')).json.content.byKind.press.published, 1);
  assert.equal((await boss('GET', '/api/plans')).json.plans.find((p) => p.kind === 'press' && p.status === 'published').payout, 0);
  await app.close();
});

test('бэкап: согласованная копия базы, хранятся только последние N', async () => {
  const { app, config } = await setup();
  app.db.prepare("INSERT INTO topics (title) VALUES ('Тема для копии')").run();
  const { backupDb } = await import('../src/backup.js');
  const dir = path.join(config.dataDir, 'backups');
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) await backupDb(app.db, dir, { keep: 2, now: new Date(`${d}T10:00:00Z`) });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['stats-2026-01-02.sqlite', 'stats-2026-01-03.sqlite']);
  const copy = new DatabaseSync(path.join(dir, 'stats-2026-01-03.sqlite'));
  assert.equal(copy.prepare('SELECT title FROM topics').get().title, 'Тема для копии');
  copy.close();
  await app.close();
});
