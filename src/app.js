import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { openDb, ROLES, PLAN_STATUSES, PLAN_KINDS } from './db.js';
import { loadRates, parseRatesForm, calcWeek, weekStart, weekEnd, shiftWeek, DEFAULT_RATES } from './payouts.js';
import { buildWorkbook } from './export.js';
import { makeSession, readSession, makeLimiter } from './auth.js';
import { sectionStats, overview, userLeaderboard } from './stats.js';
import { parsePostLines, addPosts } from './manual.js';
import { html, raw, layout, fmtDate, fmtSize, barChart, sparkline, stars, money } from './views.js';

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const cleanName = (n) => String(n || 'file').replace(/[\\/]/g, '_').replace(/[\x00-\x1f"]/g, '').trim().slice(0, 200) || 'file';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export async function buildApp(config) {
  const db = openDb(config);
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 32 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes, files: 20, fields: 20 } });
  const secret = db.getSetting('session_secret');
  const loginLimit = makeLimiter(10, 60_000);
  const tz = config.timezone;

  const redirect = (reply, to, msg, isError = false) => reply.redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}${isError ? '&e=1' : ''}` : to);
  const page = (reply, req, nav, title, body) => reply.type('text/html; charset=utf-8').send(layout({ title, user: req.user, body, nav }).toString());
  const flash = (req) => (req.query?.msg ? html`<div class="${req.query.e ? 'err' : 'ok'}">${req.query.msg}</div>` : '');
  const canEdit = (req) => req.user.role !== 'viewer';
  const forbid = (reply) => reply.code(403).type('text/plain; charset=utf-8').send('Недостаточно прав');

  // --- авторизация -------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p === '/login' || p === '/health') return;
    const nick = readSession(secret, req.cookies.sid);
    const member = nick && db.prepare('SELECT nick, role FROM members WHERE nick = ?').get(nick);
    if (!member) return reply.redirect('/login');
    req.user = member;
  });

  app.get('/health', async () => ({ ok: true }));

  const loginPage = (reply, error) => reply.type('text/html; charset=utf-8').send(layout({
    title: 'Вход',
    body: html`<div style="max-width:360px;margin:12vh auto"><h1>Delgado PH Stats</h1>
      ${error ? html`<div class="err">${error}</div>` : ''}
      <form method="post" action="/login"><div class="row"><label style="flex:1">Ник игрока
      <input name="nick" placeholder="Brianna_Delgado" autofocus required maxlength="64"></label><button>Войти</button></div></form></div>`,
  }).toString());

  app.get('/login', async (req, reply) => loginPage(reply));
  app.post('/login', async (req, reply) => {
    if (!loginLimit(req.ip)) return reply.code(429).type('text/plain; charset=utf-8').send('Слишком много попыток, подождите минуту');
    const nick = String(req.body?.nick || '').trim();
    const m = db.prepare('SELECT nick FROM members WHERE nick = ?').get(nick);
    if (!m) return loginPage(reply.code(403), 'Этого ника нет в списке доступа. Обратитесь к администратору сайта.');
    reply.setCookie('sid', makeSession(secret, m.nick), {
      httpOnly: true, sameSite: 'lax', path: '/', secure: config.secureCookie, maxAge: 30 * 24 * 3600,
    });
    return reply.redirect('/');
  });
  app.post('/logout', async (req, reply) => { reply.clearCookie('sid', { path: '/' }); return reply.redirect('/login'); });

  // --- обзор -------------------------------------------------------------
  app.get('/', async (req, reply) => {
    const stats = sectionStats(db, config);
    const ov = overview(stats);
    const top = userLeaderboard(db, 30).slice(0, 10);
    const ranked = [...stats].sort((a, b) => b.score - a.score);
    const w = config.weights;
    return page(reply, req, '/', 'Обзор', html`<h1>Обзор активности</h1>${flash(req)}
      <div class="cards">${[['Разделов', ov.sections], ['Постов всего', ov.total], ['За 24 часа', ov.day], ['За 7 дней', ov.week], ['За 30 дней', ov.month]]
        .map(([l, n]) => html`<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`)}</div>
      <h2>Разделы <a href="/export.xlsx" style="font-size:13px;text-transform:none;letter-spacing:0;margin-left:12px">⬇ выгрузить всё в xlsx</a></h2>
      ${ranked.length ? html`<table><tr><th>Раздел</th><th class="r">Всего</th><th class="r">24ч</th><th class="r">7д</th><th class="r">30д</th><th class="r">Авторов 30д</th><th>30 дней</th><th>Последний пост</th><th>Активность</th></tr>
      ${ranked.map((s) => html`<tr><td><a href="/sections/${s.section.id}">${s.section.title}</a></td><td class="r">${s.total}</td><td class="r">${s.day}</td><td class="r">${s.week}</td><td class="r">${s.month}</td><td class="r">${s.authors30}</td>
        <td>${sparkline(s.perDay)}</td><td class="mute">${fmtDate(s.last, tz)}</td><td><span class="score">${s.score}</span></td></tr>`)}</table>
      <p class="mute">Активность = (${w.week}×посты за 7д + ${w.month}×посты за 30д + ${w.authors}×уникальные авторы за 30д), нормировано к 0–100 по самому активному разделу.</p>`
        : html`<div class="card">Разделов пока нет. Добавьте первый ниже и внесите в него посты.</div>`}
      ${canEdit(req) ? html`<h2>Добавить раздел</h2>${sectionForm('/sections', {}, 'Добавить')}` : ''}
      <h2>Самые активные за 30 дней</h2>${leaderTable(top)}`);
  });

  const leaderTable = (rows) => rows.length ? html`<table><tr><th>#</th><th>Игрок</th><th class="r">Постов</th><th class="r">Разделов</th><th>Последний пост</th></tr>
    ${rows.map((u, i) => html`<tr><td>${i + 1}</td><td>${u.nick}</td><td class="r">${u.posts}</td><td class="r">${u.sections}</td><td class="mute">${fmtDate(u.last, tz)}</td></tr>`)}</table>` : html`<p class="mute">Нет данных.</p>`;

  app.get('/sections/:id', async (req, reply) => {
    const st = sectionStats(db, config).find((s) => s.section.id === Number(req.params.id));
    if (!st) return reply.code(404).type('text/plain; charset=utf-8').send('Раздел не найден');
    const recent = db.prepare('SELECT id, author, posted_at FROM posts WHERE section_id = ? ORDER BY posted_at DESC LIMIT 100').all(st.section.id);
    const hours = [...Array(24).keys()];
    const maxA = st.topAuthors[0]?.count || 1;
    return page(reply, req, '/', st.section.title, html`<p><a href="/">← Все разделы</a></p><h1>${st.section.title}</h1>
      <p class="mute">Автор темы: ${st.section.author || '—'} · создана ${fmtDate(st.section.created_at, tz)} · данные внесены ${fmtDate(st.section.synced_at, tz)}${st.section.url ? html` · <a href="${st.section.url}" rel="noreferrer">открыть на форуме</a>` : ''}</p>
      <div class="cards">${[['Активность', st.score], ['Всего постов', st.total], ['24 часа', st.day], ['7 дней', st.week], ['30 дней', st.month], ['Авторов за 30д', st.authors30]]
        .map(([l, n]) => html`<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`)}</div>
      <h2>Посты по дням (30 дней)</h2>${barChart(st.perDay, st.days)}
      <h2>Посты по часам суток (${tz})</h2>${barChart(st.perHour, hours.map((h) => `${h}:00`))}
      ${flash(req)}${canEdit(req) ? html`<h2>Внести посты</h2>
        <form method="post" action="/sections/${st.section.id}/posts"><label class="mute">Одна строка — один пост: <code>ДД.ММ.ГГГГ ЧЧ:ММ Ник</code> (время по поясу ${tz}). Повторно внесённые посты игнорируются.
        <textarea name="text" rows="6" style="width:100%" placeholder="08.11.2026 22:58 Brianna_Delgado&#10;07.11.2026 17:16 Richard_Northwood" required></textarea></label>
        <div class="row"><button>Внести</button></div></form>
        <details><summary class="mute">Настройки раздела</summary>${sectionForm(`/sections/${st.section.id}/edit`, st.section, 'Сохранить')}
        <form method="post" action="/sections/${st.section.id}/delete" onsubmit="return confirm('Удалить раздел вместе со всеми постами?')"><button class="danger">Удалить раздел</button></form></details>` : ''}
      <div class="grid2"><div><h2>Авторы</h2>${st.topAuthors.length ? html`<table><tr><th>Игрок</th><th class="r">Постов</th><th></th></tr>
        ${st.topAuthors.map((a) => html`<tr><td>${a.nick}</td><td class="r">${a.count}</td><td><div class="bar"><i style="width:${Math.round((a.count / maxA) * 100)}%"></i></div></td></tr>`)}</table>` : html`<p class="mute">Ответов нет.</p>`}</div>
      <div><h2>Последние посты</h2>${recent.length ? html`<table><tr><th>Время</th><th>Автор</th><th></th></tr>
        ${recent.map((p) => html`<tr><td>${fmtDate(p.posted_at, tz)}</td><td>${p.author}</td><td>${canEdit(req) ? html`<form method="post" action="/sections/${st.section.id}/posts/${p.id}/delete"><button class="danger">×</button></form>` : ''}</td></tr>`)}</table>` : html`<p class="mute">Ответов нет.</p>`}</div></div>`);
  });

  function sectionForm(action, s, label) {
    return html`<form method="post" action="${action}"><div class="row">
      <label style="flex:2;min-width:240px">Название<input name="title" value="${s.title || ''}" required maxlength="300" style="width:100%"></label>
      <label style="flex:2;min-width:240px">Ссылка на тему форума (необязательно)<input name="url" value="${s.url || ''}" maxlength="500" style="width:100%"></label>
      <label>Автор темы<input name="author" value="${s.author || ''}" maxlength="64"></label>
      <label>Создана<input type="date" name="created_at" value="${(s.created_at || '').slice(0, 10)}"></label>
      <button>${label}</button></div></form>`;
  }
  function readSectionForm(b) {
    const title = String(b?.title || '').trim().slice(0, 300);
    if (!title) return { error: 'Укажите название раздела' };
    const url = String(b?.url || '').trim();
    if (url && !/^https?:\/\//.test(url)) return { error: 'Ссылка должна начинаться с http:// или https://' };
    const created = b?.created_at ? String(b.created_at) : null;
    if (created && !isDate(created)) return { error: 'Некорректная дата создания' };
    return { v: { title, url, author: String(b?.author || '').trim().slice(0, 64) || null, created } };
  }
  const sectionExists = (id) => db.prepare('SELECT 1 FROM sections WHERE id = ?').get(id);

  app.post('/sections', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const r = readSectionForm(req.body);
    if (r.error) return redirect(reply, '/', r.error);
    const id = Number(db.prepare('INSERT INTO sections (title, url, author, created_at) VALUES (?,?,?,?)').run(r.v.title, r.v.url, r.v.author, r.v.created).lastInsertRowid);
    return redirect(reply, `/sections/${id}`, 'Раздел добавлен — теперь внесите посты');
  });
  app.post('/sections/:id/edit', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const id = Number(req.params.id), r = readSectionForm(req.body);
    if (!sectionExists(id)) return redirect(reply, '/', 'Раздел не найден');
    if (r.error) return redirect(reply, `/sections/${id}`, r.error);
    db.prepare('UPDATE sections SET title=?, url=?, author=?, created_at=? WHERE id=?').run(r.v.title, r.v.url, r.v.author, r.v.created, id);
    return redirect(reply, `/sections/${id}`, 'Сохранено');
  });
  app.post('/sections/:id/delete', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    db.prepare('DELETE FROM sections WHERE id = ?').run(Number(req.params.id));
    return redirect(reply, '/', 'Раздел удалён');
  });
  app.post('/sections/:id/posts', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const id = Number(req.params.id);
    if (!sectionExists(id)) return redirect(reply, '/', 'Раздел не найден');
    const { posts, errors } = parsePostLines(req.body?.text, tz);
    if (errors.length) return redirect(reply, `/sections/${id}`, `Ничего не сохранено. ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` …и ещё ${errors.length - 5}` : ''}`, true);
    if (!posts.length) return redirect(reply, `/sections/${id}`, 'Нет строк для внесения');
    const { added, skipped } = addPosts(db, id, posts);
    db.prepare('UPDATE sections SET synced_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return redirect(reply, `/sections/${id}`, `Добавлено постов: ${added}${skipped ? `, уже были: ${skipped}` : ''}`);
  });
  app.post('/sections/:id/posts/:pid/delete', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    db.prepare('DELETE FROM posts WHERE id = ? AND section_id = ?').run(Number(req.params.pid), Number(req.params.id));
    return redirect(reply, `/sections/${req.params.id}`, 'Пост удалён');
  });

  app.get('/users', async (req, reply) => {
    const periods = { 7: 7, 30: 30, all: null };
    const per = Object.hasOwn(periods, req.query.period) ? req.query.period : '30';
    const rows = userLeaderboard(db, periods[per]);
    return page(reply, req, '/users', 'Пользователи', html`<h1>Самые активные пользователи</h1>
      <p>${[['7', '7 дней'], ['30', '30 дней'], ['all', 'Всё время']].map(([k, t]) => html`<a href="/users?period=${k}" style="margin-right:14px;${k === per ? 'font-weight:700' : ''}">${t}</a>`)}</p>${leaderTable(rows)}`);
  });

  // --- план публикаций ---------------------------------------------------
  const statusSelect = (name, cur) => html`<select name="${name}">${Object.entries(PLAN_STATUSES).map(([k, t]) => html`<option value="${k}"${k === cur ? raw(' selected') : raw('')}>${t}</option>`)}</select>`;
  const sectionSelect = (cur) => html`<select name="section_id"><option value="">— раздел не выбран —</option>${db.prepare('SELECT id, title FROM sections ORDER BY title').all().map((s) => html`<option value="${s.id}"${s.id === cur ? raw(' selected') : raw('')}>${s.title}</option>`)}</select>`;

  const kindSelect = (cur) => html`<select name="kind">${Object.entries(PLAN_KINDS).map(([k, t]) => html`<option value="${k}"${k === cur ? raw(' selected') : raw('')}>${t}</option>`)}</select>`;
  const ratingSelect = (cur) => html`<select name="rating"><option value="">— не оценено —</option>${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}"${n === cur ? raw(' selected') : raw('')}>${stars(n)}</option>`)}</select>`;

  function readPlanForm(b) {
    const title = String(b.title || '').trim().slice(0, 300);
    if (!title) return { error: 'Укажите название публикации' };
    const status = Object.hasOwn(PLAN_STATUSES, b.status) ? b.status : 'idea';
    const date = b.planned_date ? String(b.planned_date) : null;
    if (date && !isDate(date)) return { error: 'Некорректная дата' };
    const sid = b.section_id ? Number(b.section_id) : null;
    if (sid && !db.prepare('SELECT 1 FROM sections WHERE id = ?').get(sid)) return { error: 'Раздел не найден' };
    const kind = Object.hasOwn(PLAN_KINDS, b.kind) ? b.kind : 'other';
    const rating = b.rating ? Number(b.rating) : null;
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { error: 'Оценка — от 1 до 5 звёзд' };
    const ovRaw = String(b.payout_override || '').replace(/[\s_.]/g, '');
    const override = ovRaw ? Number(ovRaw) : null;
    if (override !== null) {
      const { min, max } = loadRates(db).event;
      if (!/^\d+$/.test(ovRaw) || override < min || override > max) return { error: `Ручная сумма за мероприятие — от ${money(min)} до ${money(max)}` };
    }
    return { v: { title, status, date, sid, kind, rating, override, description: String(b.description || '').trim().slice(0, 500), assignee: String(b.assignee || '').trim().slice(0, 64) } };
  }

  app.get('/plan', async (req, reply) => {
    const filter = Object.hasOwn(PLAN_STATUSES, req.query.status) ? req.query.status : '';
    const plans = db.prepare(`SELECT p.*, s.title AS section_title FROM plans p LEFT JOIN sections s ON s.id = p.section_id
      ${filter ? 'WHERE p.status = ?' : ''} ORDER BY (p.planned_date IS NULL), p.planned_date, p.id`).all(...(filter ? [filter] : []));
    const files = db.prepare('SELECT id, plan_id, original_name, mime FROM files WHERE plan_id IS NOT NULL').all();
    const edit = canEdit(req);
    return page(reply, req, '/plan', 'План публикаций', html`<h1>План публикаций</h1>${flash(req)}
      <p><a href="/plan">Все</a>${Object.entries(PLAN_STATUSES).map(([k, t]) => html` · <a href="/plan?status=${k}"${k === filter ? raw(' style="font-weight:700"') : raw('')}>${t}</a>`)}</p>
      ${edit ? html`<form method="post" action="/plan"><div class="row">
        <label style="flex:2;min-width:220px">Название<input name="title" required maxlength="300"></label>
        <label>Дата<input type="date" name="planned_date"></label><label>Статус${statusSelect('status', 'idea')}</label>
        <label>Раздел${sectionSelect(null)}</label><label>Ответственный<input name="assignee" placeholder="Ник" maxlength="64"></label>
        <label>Тип${kindSelect('other')}</label><label>Оценка${ratingSelect(null)}</label></div>
        <div class="row"><label style="flex:1;min-width:300px">Краткое описание (до 500 символов)<textarea name="description" rows="2" maxlength="500"></textarea></label><button>Добавить</button></div></form>` : ''}
      <table><tr><th>Дата</th><th>Публикация</th><th>Тип</th><th>Оценка</th><th>Раздел</th><th>Ответственный</th><th>Статус</th><th>Файлы</th></tr>
      ${plans.map((p) => html`<tr><td>${p.planned_date || '—'}</td><td><b>${p.title}</b>${p.description ? html`<div class="mute">${p.description}</div>` : ''}
        ${edit ? html`<details><summary class="mute">изменить</summary>
          <form method="post" action="/plan/${p.id}"><div class="row"><label>Название<input name="title" value="${p.title}" required></label><label>Дата<input type="date" name="planned_date" value="${p.planned_date || ''}"></label>
          <label>Статус${statusSelect('status', p.status)}</label><label>Раздел${sectionSelect(p.section_id)}</label><label>Ответственный<input name="assignee" value="${p.assignee}"></label>
          <label>Тип${kindSelect(p.kind)}</label><label>Оценка${ratingSelect(p.rating)}</label>
          <label>Сумма вручную, $ (мероприятия)<input name="payout_override" value="${p.payout_override ?? ''}" inputmode="numeric" placeholder="по оценке"></label></div>
          <div class="row"><label style="flex:1">Краткое описание (до 500 символов)<textarea name="description" rows="2" maxlength="500">${p.description}</textarea></label><button>Сохранить</button></div></form>
          <form method="post" action="/plan/${p.id}/delete" onsubmit="return confirm('Удалить публикацию?')"><button class="danger">Удалить</button></form>
          <form method="post" action="/files/upload" enctype="multipart/form-data"><input type="hidden" name="plan_id" value="${p.id}"><div class="row"><input type="file" name="file" multiple required><button>Прикрепить файлы</button></div></form></details>` : ''}</td>
        <td>${PLAN_KINDS[p.kind]}</td><td style="white-space:nowrap;color:var(--acc)">${p.rating ? stars(p.rating) : html`<span class="mute">—</span>`}</td>
        <td>${p.section_id ? html`<a href="/sections/${p.section_id}">${p.section_title}</a>` : '—'}</td><td>${p.assignee || '—'}</td>
        <td><span class="tag ${p.status}">${PLAN_STATUSES[p.status]}</span></td>
        <td>${files.filter((f) => f.plan_id === p.id).map((f) => html`<div><a href="/files/${f.id}/download">${f.original_name}</a></div>`)}</td></tr>`)}</table>
      ${plans.length ? '' : html`<p class="mute">Публикаций пока нет.</p>`}`);
  });

  app.post('/plan', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const r = readPlanForm(req.body || {});
    if (r.error) return redirect(reply, '/plan', r.error);
    const t = new Date().toISOString(), v = r.v;
    db.prepare('INSERT INTO plans (title, description, section_id, planned_date, status, assignee, kind, rating, payout_override, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(v.title, v.description, v.sid, v.date, v.status, v.assignee, v.kind, v.rating, v.override, req.user.nick, t, t);
    return redirect(reply, '/plan', 'Публикация добавлена');
  });
  app.post('/plan/:id', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const r = readPlanForm(req.body || {});
    if (r.error) return redirect(reply, '/plan', r.error);
    const v = r.v;
    db.prepare('UPDATE plans SET title=?, description=?, section_id=?, planned_date=?, status=?, assignee=?, kind=?, rating=?, payout_override=?, updated_at=? WHERE id=?')
      .run(v.title, v.description, v.sid, v.date, v.status, v.assignee, v.kind, v.rating, v.override, new Date().toISOString(), Number(req.params.id));
    return redirect(reply, '/plan', 'Сохранено');
  });
  app.post('/plan/:id/delete', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    db.prepare('DELETE FROM plans WHERE id = ?').run(Number(req.params.id)); // файлы остаются в хранилище
    return redirect(reply, '/plan', 'Публикация удалена');
  });

  // --- хранилище ---------------------------------------------------------
  const folderPath = (id) => {
    const out = [];
    for (let cur = db.prepare('SELECT * FROM folders WHERE id = ?').get(id); cur; cur = cur.parent_id && db.prepare('SELECT * FROM folders WHERE id = ?').get(cur.parent_id)) out.unshift(cur);
    return out;
  };
  const rootId = () => db.prepare('SELECT id FROM folders WHERE parent_id IS NULL').get().id;
  function ensureFolder(parentId, name) {
    name = cleanName(name).slice(0, 100);
    const ex = db.prepare('SELECT id FROM folders WHERE IFNULL(parent_id,0) = ? AND name = ? COLLATE NOCASE').get(parentId, name);
    if (ex) return ex.id;
    return Number(db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?,?,?)').run(parentId, name, new Date().toISOString()).lastInsertRowid);
  }

  app.get('/files', async (req, reply) => {
    const fid = Number(req.query.folder) || rootId();
    const trail = folderPath(fid);
    if (!trail.length) return redirect(reply, '/files');
    const subs = db.prepare('SELECT f.*, (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id) AS n FROM folders f WHERE parent_id = ? ORDER BY name COLLATE NOCASE').all(fid);
    const files = db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(fid);
    const edit = canEdit(req);
    return page(reply, req, '/files', 'Хранилище', html`<h1>Хранилище</h1>${flash(req)}
      <p>${trail.map((f, i) => html`${i ? ' / ' : ''}<a href="/files?folder=${f.id}">${f.name}</a>`)}</p>
      ${edit ? html`<div class="row"><form method="post" action="/files/folder" class="row"><input type="hidden" name="parent_id" value="${fid}"><label>Новая папка<input name="name" required maxlength="100"></label><button>Создать</button></form>
        <form method="post" action="/files/upload" enctype="multipart/form-data" class="row"><input type="hidden" name="folder_id" value="${fid}"><label>Загрузить файлы (до ${fmtSize(config.maxUploadBytes)})<input type="file" name="file" multiple required></label><button>Загрузить</button></form></div>` : ''}
      <table><tr><th>Имя</th><th class="r">Размер</th><th>Загрузил</th><th>Когда</th><th></th></tr>
      ${subs.map((f) => html`<tr><td>📁 <a href="/files?folder=${f.id}">${f.name}</a></td><td class="r mute">${f.n} файл.</td><td></td><td class="mute">${fmtDate(f.created_at, tz)}</td>
        <td>${edit ? html`<form method="post" action="/files/folder/${f.id}/delete" onsubmit="return confirm('Удалить папку со всем содержимым?')"><button class="danger">×</button></form>` : ''}</td></tr>`)}
      ${files.map((f) => html`<tr><td>${INLINE_IMAGES.has(f.mime) ? html`<img class="thumb" src="/files/${f.id}/download" alt=""> ` : '📄 '}<a href="/files/${f.id}/download">${f.original_name}</a></td>
        <td class="r">${fmtSize(f.size)}</td><td>${f.uploaded_by}</td><td class="mute">${fmtDate(f.created_at, tz)}</td>
        <td>${edit ? html`<form method="post" action="/files/${f.id}/delete" onsubmit="return confirm('Удалить файл?')"><button class="danger">×</button></form>` : ''}</td></tr>`)}</table>
      ${subs.length + files.length ? '' : html`<p class="mute">Папка пуста.</p>`}`);
  });

  app.post('/files/folder', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const parent = Number(req.body?.parent_id);
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ?').get(parent)) return redirect(reply, '/files', 'Папка не найдена');
    if (!String(req.body?.name || '').trim()) return redirect(reply, `/files?folder=${parent}`, 'Укажите имя папки');
    ensureFolder(parent, req.body.name);
    return redirect(reply, `/files?folder=${parent}`, 'Папка создана');
  });

  function unlinkFiles(rows) {
    for (const r of rows) fs.rmSync(path.join(config.storageDir, r.stored_name), { force: true });
  }
  app.post('/files/folder/:id/delete', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const id = Number(req.params.id);
    const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!f || !f.parent_id) return redirect(reply, '/files', 'Эту папку удалить нельзя');
    const rows = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
      SELECT stored_name FROM files WHERE folder_id IN (SELECT id FROM t)`).all(id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    unlinkFiles(rows);
    return redirect(reply, `/files?folder=${f.parent_id}`, 'Папка удалена');
  });
  app.post('/files/:id/delete', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    if (!f) return redirect(reply, '/files', 'Файл не найден');
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    unlinkFiles([f]);
    return redirect(reply, `/files?folder=${f.folder_id}`, 'Файл удалён');
  });

  app.get('/files/:id/download', async (req, reply) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    if (!f) return reply.code(404).type('text/plain; charset=utf-8').send('Файл не найден');
    const inline = INLINE_IMAGES.has(f.mime);
    return reply.header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`)
      .type(inline ? f.mime : 'application/octet-stream').send(fs.createReadStream(path.join(config.storageDir, f.stored_name)));
  });

  app.post('/files/upload', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const fields = {};
    const saved = [];
    let folderId = null, planId = null, error = null;
    const resolveTarget = () => {
      if (folderId) return;
      if (fields.plan_id) {
        const p = db.prepare('SELECT id, title FROM plans WHERE id = ?').get(Number(fields.plan_id));
        if (!p) { error = 'Публикация не найдена'; return; }
        planId = p.id;
        folderId = ensureFolder(ensureFolder(rootId(), 'Публикации'), `#${p.id} ${p.title}`.slice(0, 80));
      } else if (db.prepare('SELECT 1 FROM folders WHERE id = ?').get(Number(fields.folder_id))) folderId = Number(fields.folder_id);
      else error = 'Папка не найдена';
    };
    for await (const part of req.parts()) {
      if (part.type === 'field') { fields[part.fieldname] = part.value; continue; }
      resolveTarget();
      if (error) { part.file.resume(); continue; }
      const stored = `${new Date().getUTCFullYear()}-${crypto.randomUUID()}`;
      const dest = path.join(config.storageDir, stored);
      await pipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) { fs.rmSync(dest, { force: true }); error = `Файл «${cleanName(part.filename)}» больше лимита`; continue; }
      if (!part.filename) { fs.rmSync(dest, { force: true }); continue; }
      const size = fs.statSync(dest).size;
      db.prepare('INSERT INTO files (folder_id, plan_id, original_name, stored_name, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(folderId, planId, cleanName(part.filename), stored, String(part.mimetype || 'application/octet-stream').toLowerCase(), size, req.user.nick, new Date().toISOString());
      saved.push(part.filename);
    }
    const back = planId ? '/plan' : `/files?folder=${folderId || rootId()}`;
    return redirect(reply, back, error || (saved.length ? `Загружено файлов: ${saved.length}` : 'Файлы не выбраны'));
  });

  // --- выгрузка в xlsx ---------------------------------------------------
  const weekParam = (q) => weekStart(isDate(String(q || '')) ? q : new Date().toISOString().slice(0, 10));
  app.get('/export.xlsx', async (req, reply) => {
    const wk = weekParam(req.query.week);
    const buf = await buildWorkbook(db, config, { rates: loadRates(db), weekStart: wk, includePayouts: req.user.role === 'admin' });
    return reply.header('Content-Disposition', `attachment; filename="delgadoph-stats-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
  });

  // --- выплаты (только администратор) ------------------------------------
  const adminOnlyPage = async (req, reply) => { if (req.user.role !== 'admin') return forbid(reply); };
  app.get('/payouts', { preHandler: adminOnlyPage }, async (req, reply) => {
    const wk = weekParam(req.query.week), rates = loadRates(db), w = calcWeek(db, rates, wk);
    const ads = db.prepare('SELECT employee, count FROM ad_edits WHERE week_start = ? ORDER BY employee').all(wk);
    const rub = (n) => (n ? money(n) : html`<span class="mute">—</span>`);
    return page(reply, req, '/payouts', 'Выплаты', html`<h1>Выплаты за неделю</h1>${flash(req)}
      <p><a href="/payouts?week=${shiftWeek(wk, -1)}">← предыдущая</a> &nbsp; <b>${wk} — ${weekEnd(wk)}</b> &nbsp; <a href="/payouts?week=${shiftWeek(wk, 1)}">следующая →</a>
        &nbsp;·&nbsp; <a href="/payouts/rates">Расценки и лимиты</a> &nbsp;·&nbsp; <a href="/export.xlsx?week=${wk}">⬇ xlsx</a></p>
      <div class="cards"><div class="card"><div class="n">${money(w.total)}</div><div class="l">К выплате за неделю</div></div><div class="card"><div class="n">${w.rows.length}</div><div class="l">Сотрудников</div></div></div>
      <h2>Начисления</h2>
      ${w.rows.length ? html`<table><tr><th>Сотрудник</th><th class="r">Ситуации</th><th class="r">Мероприятия</th><th class="r">Эфиры</th><th class="r">Правок объявл.</th><th class="r">Объявления</th><th class="r">Бонус</th><th class="r">Итого</th></tr>
        ${w.rows.map((e) => html`<tr><td><b>${e.nick}</b>${e.notes.map((n) => html`<div class="mute">⚠ ${n}</div>`)}
          ${e.items.length ? html`<details><summary class="mute">публикации (${e.items.length})</summary>${e.items.map((i) => html`<div>${i.plan.planned_date} · ${PLAN_KINDS[i.plan.kind]} · ${i.plan.title} · ${i.plan.rating ? stars(i.plan.rating) : '—'} → ${money(i.amount)}${i.note ? html` <span class="mute">(${i.note})</span>` : ''}</div>`)}</details>` : ''}</td>
          <td class="r">${rub(e.situation)}</td><td class="r">${rub(e.event)}</td><td class="r">${rub(e.radio)}</td><td class="r">${e.adCount || '—'}</td><td class="r">${rub(e.adPaid)}</td><td class="r">${rub(e.adBonus)}</td><td class="r"><b>${money(e.total)}</b></td></tr>`)}</table>`
        : html`<p class="mute">За эту неделю начислений нет. Выплаты считаются по публикациям в статусе «Опубликовано» с типом, ответственным и оценкой (дата публикации — в плане) и по правкам объявлений ниже.</p>`}
      ${w.skipped.length ? html`<h2>Не учтено</h2><table>${w.skipped.map((x) => html`<tr><td>${x.plan.planned_date}</td><td>${PLAN_KINDS[x.plan.kind]}: ${x.plan.title}</td><td class="mute">${x.why}</td></tr>`)}</table>` : ''}
      <h2>Правки объявлений за неделю</h2>
      <form method="post" action="/payouts/ads"><input type="hidden" name="week" value="${wk}"><div class="row"><label>Сотрудник<input name="employee" required maxlength="64"></label>
        <label>Отредактировано объявлений<input name="count" type="number" min="0" max="100000" required></label><button>Сохранить</button></div></form>
      ${ads.length ? html`<table><tr><th>Сотрудник</th><th class="r">Правок</th><th></th></tr>${ads.map((a) => html`<tr><td>${a.employee}</td><td class="r">${a.count}</td>
        <td><form method="post" action="/payouts/ads/delete"><input type="hidden" name="week" value="${wk}"><input type="hidden" name="employee" value="${a.employee}"><button class="danger">×</button></form></td></tr>`)}</table>` : ''}`);
  });

  app.post('/payouts/ads', { preHandler: adminOnlyPage }, async (req, reply) => {
    const wk = weekParam(req.body?.week), emp = String(req.body?.employee || '').trim().slice(0, 64), c = String(req.body?.count ?? '');
    if (!emp || !/^\d{1,6}$/.test(c)) return redirect(reply, `/payouts?week=${wk}`, 'Укажите сотрудника и число правок', true);
    db.prepare('INSERT INTO ad_edits (week_start, employee, count) VALUES (?,?,?) ON CONFLICT(week_start, employee) DO UPDATE SET count = excluded.count').run(wk, emp, Number(c));
    return redirect(reply, `/payouts?week=${wk}`, 'Сохранено');
  });
  app.post('/payouts/ads/delete', { preHandler: adminOnlyPage }, async (req, reply) => {
    const wk = weekParam(req.body?.week);
    db.prepare('DELETE FROM ad_edits WHERE week_start = ? AND employee = ?').run(wk, String(req.body?.employee || ''));
    return redirect(reply, `/payouts?week=${wk}`, 'Удалено');
  });

  app.get('/payouts/rates', { preHandler: adminOnlyPage }, async (req, reply) => {
    const r = loadRates(db);
    const num = (name, v, label, hint = '') => html`<label>${label}<input name="${name}" value="${v}" inputmode="numeric" required style="width:130px">${hint ? html`<span class="mute">${hint}</span>` : ''}</label>`;
    const starRow = (prefix, obj) => [1, 2, 3, 4, 5].map((n) => num(`${prefix}_${n}`, obj[n], stars(n)));
    return page(reply, req, '/payouts', 'Расценки', html`<p><a href="/payouts">← К выплатам</a></p><h1>Расценки и лимиты</h1>${flash(req)}
      <form method="post" action="/payouts/rates">
      <h2>Скриншот-ситуации (за одну, по оценке)</h2><div class="row">${starRow('sit', r.situation.stars)}${num('sit_cap', r.situation.weekCap, 'Лимит в неделю на сотрудника, $')}</div>
      <h2>Редактирование объявлений</h2><div class="row">${num('ad_rate', r.ads.rate, 'За объявление, $')}${num('ad_bonus', r.ads.bonus, 'Бонус, $', 'раз в неделю')}
        ${num('ad_bonus_after', r.ads.bonusAfter, 'Бонус, если правок больше')}${num('ad_limit', r.ads.paidLimit, 'Оплачивается не более, объявл./нед.')}</div>
      <h2>Мероприятия (за одно, по оценке)</h2><div class="row">${starRow('ev', r.event.stars)}${num('ev_min', r.event.min, 'Минимум, $')}${num('ev_max', r.event.max, 'Максимум, $')}${num('ev_cap', r.event.weekCap, 'Лимит в неделю, $')}</div>
      <h2>Радиоэфиры</h2><div class="row">${num('radio_rate', r.radio.rate, 'За качественный эфир, $')}${num('radio_min_stars', r.radio.minStars, 'Качественный — от скольки звёзд')}${num('radio_cap', r.radio.weekCap, 'Лимит в неделю, $')}</div>
      <div class="row"><button>Сохранить расценки</button></div></form>
      <form method="post" action="/payouts/rates/reset" onsubmit="return confirm('Вернуть расценки по умолчанию?')"><button class="danger">Сбросить к значениям по умолчанию</button></form>
      <p class="mute">Изменение расценок пересчитывает и прошлые недели: расчёт всегда идёт по текущим расценкам.</p>`);
  });
  app.post('/payouts/rates', { preHandler: adminOnlyPage }, async (req, reply) => {
    const r = parseRatesForm(req.body);
    if (r.error) return redirect(reply, '/payouts/rates', r.error, true);
    db.setSetting('rates', JSON.stringify(r.rates));
    return redirect(reply, '/payouts/rates', 'Расценки сохранены');
  });
  app.post('/payouts/rates/reset', { preHandler: adminOnlyPage }, async (req, reply) => {
    db.setSetting('rates', JSON.stringify(DEFAULT_RATES));
    return redirect(reply, '/payouts/rates', 'Расценки сброшены');
  });

  // --- управление --------------------------------------------------------
  const adminOnly = async (req, reply) => { if (req.user.role !== 'admin') return forbid(reply); };
  app.get('/admin', { preHandler: adminOnly }, async (req, reply) => {
    const members = db.prepare('SELECT * FROM members ORDER BY role, nick').all();
    return page(reply, req, '/admin', 'Управление', html`<h1>Управление</h1>${flash(req)}
      <h2>Доступ по нику</h2><p class="mute">Войти может только ник из этого списка. Пароля нет — это ограничение выбранной схемы входа, поэтому не публикуйте ссылку на сайт открыто.</p>
      <table><tr><th>Ник</th><th>Роль</th><th></th></tr>${members.map((m) => html`<tr><td>${m.nick}</td><td>${m.role}</td>
        <td>${m.nick.toLowerCase() === req.user.nick.toLowerCase() ? '' : html`<form method="post" action="/admin/members/delete"><input type="hidden" name="nick" value="${m.nick}"><button class="danger">Убрать</button></form>`}</td></tr>`)}</table>
      <form method="post" action="/admin/members"><div class="row"><label>Ник<input name="nick" required maxlength="64"></label>
        <label>Роль<select name="role"><option value="editor">editor — план и файлы</option><option value="viewer">viewer — только просмотр</option><option value="admin">admin</option></select></label><button>Добавить / изменить</button></div></form>`);
  });
  app.post('/admin/members', { preHandler: adminOnly }, async (req, reply) => {
    const nick = String(req.body?.nick || '').trim();
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'viewer';
    if (!nick || nick.length > 64) return redirect(reply, '/admin', 'Некорректный ник');
    if (nick.toLowerCase() === req.user.nick.toLowerCase() && role !== 'admin') return redirect(reply, '/admin', 'Нельзя понизить самого себя');
    db.prepare('INSERT INTO members (nick, role, created_at) VALUES (?,?,?) ON CONFLICT(nick) DO UPDATE SET role = excluded.role').run(nick, role, new Date().toISOString());
    return redirect(reply, '/admin', 'Сохранено');
  });
  app.post('/admin/members/delete', { preHandler: adminOnly }, async (req, reply) => {
    const nick = String(req.body?.nick || '');
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) return redirect(reply, '/admin', 'Нельзя удалить самого себя');
    db.prepare('DELETE FROM members WHERE nick = ?').run(nick);
    return redirect(reply, '/admin', 'Удалено');
  });


  app.addHook('onClose', async () => db.close());
  app.db = db;
  return app;
}
