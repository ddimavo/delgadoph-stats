import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { normalizeScores, rawActivity, sectionStats } from '../src/stats.js';
import { parseIngest, ValidationError } from '../src/ingest.js';

process.env.NODE_ENV = 'test';
const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const form = { 'content-type': 'application/x-www-form-urlencoded' };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
  const config = loadConfig({ DATA_DIR: dir, ADMIN_NICK: 'Brianna_Delgado', TZ_NAME: 'UTC' });
  const app = await buildApp(config);
  const token = app.db.getSetting('ingest_token');
  const ingest = (body, t = token) => app.inject({ method: 'POST', url: '/api/ingest', headers: { authorization: `Bearer ${t}` }, payload: body });
  const login = async (nick) => {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `nick=${encodeURIComponent(nick)}`, headers: form });
    return { r, cookie: r.cookies[0] ? `sid=${r.cookies[0].value}` : '' };
  };
  return { app, config, ingest, login, token };
}

const section = { id: 5, title: 'Press releases', url: 'https://forum.example/topic/5-x/' };

test('активность нормируется к 0–100', () => {
  const w = { week: 0.5, month: 0.3, authors: 2 };
  assert.equal(rawActivity({ week: 4, month: 10, authors: 2 }, w), 9);
  assert.deepEqual(normalizeScores([9, 4.5, 0]), [100, 50, 0]);
  assert.deepEqual(normalizeScores([0, 0]), [0, 0]);
});

test('валидация ingest отклоняет мусор и убирает дубли', () => {
  assert.throws(() => parseIngest({ section: {}, posts: [] }), ValidationError);
  assert.throws(() => parseIngest({ section, posts: [{ id: 1, author: 'a', at: 'вчера' }] }), ValidationError);
  const r = parseIngest({ section, posts: [{ id: 1, author: 'a', at: ago(1) }, { id: 1, author: 'a', at: ago(1) }] });
  assert.equal(r.posts.length, 1);
});

test('ingest требует токен, считает периоды и удаляет пропавшие посты', async () => {
  const { app, ingest, login } = await setup();
  assert.equal((await ingest({ section, posts: [] }, 'bad')).statusCode, 401);
  const posts = [
    { id: 1, author: 'Ann', at: ago(2) }, { id: 2, author: 'ann', at: ago(30) },
    { id: 3, author: 'Bob', at: ago(24 * 10) }, { id: 4, author: 'Cid', at: ago(24 * 40) },
  ];
  assert.equal((await ingest({ section, posts })).statusCode, 200);
  const { cookie } = await login('brianna_delgado'); // регистр ника не важен
  const page = await app.inject({ url: '/', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Press releases/);
  const ov = sectionStats(app.db, { timezone: 'UTC', weights: { week: 0.5, month: 0.3, authors: 2 } })[0];
  assert.deepEqual([ov.total, ov.day, ov.week, ov.month, ov.authors30], [4, 1, 2, 3, 2]);
  assert.equal(ov.topAuthors[0].nick.toLowerCase(), 'ann');
  assert.equal(ov.topAuthors[0].count, 2);
  await ingest({ section, posts: posts.slice(0, 1) }); // посты 2–4 удалены на форуме
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 1);
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

test('XSS в нике автора экранируется', async () => {
  const { app, ingest, login } = await setup();
  await ingest({ section, posts: [{ id: 1, author: '<img src=x onerror=alert(1)>', at: ago(1) }] });
  const { cookie } = await login('Brianna_Delgado');
  const r = await app.inject({ url: '/sections/5', headers: { cookie } });
  assert.ok(!r.body.includes('<img src=x'));
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
