import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { normalizeScores, rawActivity, sectionStats } from '../src/stats.js';
import { parsePostLines, zonedToUtc } from '../src/manual.js';

process.env.NODE_ENV = 'test';
const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const form = { 'content-type': 'application/x-www-form-urlencoded' };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
  const config = loadConfig({ DATA_DIR: dir, ADMIN_NICK: 'Brianna_Delgado', TZ_NAME: 'UTC' });
  const app = await buildApp(config);
  const login = async (nick) => {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `nick=${encodeURIComponent(nick)}`, headers: form });
    return { r, cookie: r.cookies[0] ? `sid=${r.cookies[0].value}` : '' };
  };
  return { app, config, login };
}

const w = { week: 0.5, month: 0.3, authors: 2 };
const fmt = (iso) => { const d = new Date(iso); const z = (n) => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}.${z(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`; };

test('активность нормируется к 0–100', () => {
  assert.equal(rawActivity({ week: 4, month: 10, authors: 2 }, w), 9);
  assert.deepEqual(normalizeScores([9, 4.5, 0]), [100, 50, 0]);
  assert.deepEqual(normalizeScores([0, 0]), [0, 0]);
});

test('разбор строк: оба формата даты, часовой пояс, ошибки', () => {
  const ok = parsePostLines('08.11.2026 22:58 Brianna_Delgado\n2026-11-07 17:16 Richard Northwood\n\n', 'Europe/Moscow', new Date('2026-11-09T00:00:00Z'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.posts[0].at, '2026-11-08T19:58:00.000Z'); // МСК = UTC+3
  assert.equal(ok.posts[1].author, 'Richard Northwood');
  const bad = parsePostLines('вчера Ann\n31.02.2026 10:00 Ann\n01.01.2099 10:00 Ann', 'UTC', new Date('2026-11-09T00:00:00Z'));
  assert.equal(bad.errors.length, 3);
  assert.equal(zonedToUtc(2026, 7, 1, 12, 0, 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z'); // летнее время
});

async function addSection(app, cookie, title = 'Press releases') {
  const r = await app.inject({ method: 'POST', url: '/sections', payload: `title=${encodeURIComponent(title)}`, headers: { ...form, cookie } });
  assert.equal(r.statusCode, 302);
  return Number(/sections\/(\d+)/.exec(r.headers.location)[1]);
}
const addPostsHttp = (app, cookie, id, text) => app.inject({ method: 'POST', url: `/sections/${id}/posts`, payload: `text=${encodeURIComponent(text)}`, headers: { ...form, cookie } });

test('ручной ввод: периоды, дубли игнорируются, ошибка — ничего не сохраняется', async () => {
  const { app, login } = await setup();
  const { cookie } = await login('brianna_delgado'); // регистр ника не важен
  const id = await addSection(app, cookie);
  const text = [ago(2), ago(30), ago(24 * 10), ago(24 * 40)].map((t, i) => `${fmt(t)} ${['Ann', 'ann', 'Bob', 'Cid'][i]}`).join('\n');
  assert.match(decodeURIComponent((await addPostsHttp(app, cookie, id, text)).headers.location), /Добавлено постов: 4/);
  assert.match(decodeURIComponent((await addPostsHttp(app, cookie, id, text)).headers.location), /Добавлено постов: 0, уже были: 4/);
  assert.match(decodeURIComponent((await addPostsHttp(app, cookie, id, `${fmt(ago(1))} Dan\nмусор`)).headers.location), /Ничего не сохранено/);
  const st = sectionStats(app.db, { timezone: 'UTC', weights: w })[0];
  assert.deepEqual([st.total, st.day, st.week, st.month, st.authors30], [4, 1, 2, 3, 2]);
  assert.equal(st.topAuthors[0].count, 2);
  const page = await app.inject({ url: '/', headers: { cookie } });
  assert.match(page.body, /Press releases/);
  const pid = app.db.prepare('SELECT id FROM posts LIMIT 1').get().id;
  await app.inject({ method: 'POST', url: `/sections/${id}/posts/${pid}/delete`, headers: { cookie } });
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 3);
  await app.inject({ method: 'POST', url: `/sections/${id}/delete`, headers: { cookie } });
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 0); // посты удаляются вместе с разделом
  await app.close();
});

test('вход только для ников из списка; без входа — редирект', async () => {
  const { app, login } = await setup();
  assert.equal((await app.inject({ url: '/' })).headers.location, '/login');
  assert.equal((await login('Stranger')).r.statusCode, 403);
  assert.equal((await app.inject({ url: '/plan', headers: { cookie: 'sid=forged.sig' } })).headers.location, '/login');
  await app.close();
});

test('роль viewer не может менять план; editor может', async () => {
  const { app, login } = await setup();
  app.db.prepare("INSERT INTO members (nick, role, created_at) VALUES ('Viewer','viewer','x'),('Ed','editor','x')").run();
  const v = await login('Viewer'), e = await login('Ed');
  const body = `title=${encodeURIComponent('Новость')}&status=idea&planned_date=2026-12-01`;
  assert.equal((await app.inject({ method: 'POST', url: '/plan', payload: body, headers: { ...form, cookie: v.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/plan', payload: body, headers: { ...form, cookie: e.cookie } })).statusCode, 302);
  const list = await app.inject({ url: '/plan', headers: { cookie: e.cookie } });
  assert.match(list.body, /Новость/);
  assert.equal((await app.inject({ url: '/admin', headers: { cookie: e.cookie } })).statusCode, 403);
  await app.close();
});

test('XSS в нике автора и названии раздела экранируется', async () => {
  const { app, login } = await setup();
  const { cookie } = await login('Brianna_Delgado');
  const id = await addSection(app, cookie, '<script>alert(2)</script>');
  await addPostsHttp(app, cookie, id, `${fmt(ago(1))} <img src=x onerror=alert(1)>`);
  const r = await app.inject({ url: `/sections/${id}`, headers: { cookie } });
  assert.ok(!r.body.includes('<img src=x') && !r.body.includes('<script>alert'));
  await app.close();
});

test('загрузка файла в публикацию, скачивание и удаление', async () => {
  const { app, config, login } = await setup();
  const { cookie } = await login('Brianna_Delgado');
  app.db.prepare("INSERT INTO plans (title,status,created_by,created_at,updated_at) VALUES ('Пост','idea','x','x','x')").run();
  const b = 'XXBOUND';
  const payload = `--${b}\r\nContent-Disposition: form-data; name="plan_id"\r\n\r\n1\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="../shot.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${b}--\r\n`;
  const up = await app.inject({ method: 'POST', url: '/files/upload', payload, headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(up.statusCode, 302);
  const f = app.db.prepare('SELECT * FROM files').get();
  assert.equal(f.original_name, 'shot.png');
  assert.equal(f.plan_id, 1);
  assert.ok(fs.existsSync(path.join(config.storageDir, f.stored_name)));
  const dl = await app.inject({ url: `/files/${f.id}/download`, headers: { cookie } });
  assert.equal(dl.body, 'PNGDATA');
  await app.inject({ method: 'POST', url: `/files/${f.id}/delete`, headers: { cookie } });
  assert.ok(!fs.existsSync(path.join(config.storageDir, f.stored_name)));
  await app.close();
});
