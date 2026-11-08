import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { openDb, ROLES, PLAN_STATUSES } from './db.js';
import { makeSession, readSession, safeEqual, makeLimiter } from './auth.js';
import { sectionStats, overview, userLeaderboard } from './stats.js';
import { parseIngest, applyIngest, ValidationError } from './ingest.js';
import { html, raw, layout, fmtDate, fmtSize, barChart, sparkline } from './views.js';

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

  const redirect = (reply, to, msg) => reply.redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : to);
  const page = (reply, req, nav, title, body) => reply.type('text/html; charset=utf-8').send(layout({ title, user: req.user, body, nav }).toString());
  const flash = (req) => (req.query?.msg ? html`<div class="ok">${req.query.msg}</div>` : '');
  const canEdit = (req) => req.user.role !== 'viewer';
  const forbid = (reply) => reply.code(403).type('text/plain; charset=utf-8').send('Недостаточно прав');

  // --- авторизация -------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p === '/login' || p === '/health' || p.startsWith('/api/')) return;
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
      <h2>Разделы</h2>
      ${ranked.length ? html`<table><tr><th>Раздел</th><th class="r">Всего</th><th class="r">24ч</th><th class="r">7д</th><th class="r">30д</th><th class="r">Авторов 30д</th><th>30 дней</th><th>Последний пост</th><th>Активность</th></tr>
      ${ranked.map((s) => html`<tr><td><a href="/sections/${s.section.id}">${s.section.title}</a></td><td class="r">${s.total}</td><td class="r">${s.day}</td><td class="r">${s.week}</td><td class="r">${s.month}</td><td class="r">${s.authors30}</td>
        <td>${sparkline(s.perDay)}</td><td class="mute">${fmtDate(s.last, tz)}</td><td><span class="score">${s.score}</span></td></tr>`)}</table>
      <p class="mute">Активность = (${w.week}×посты за 7д + ${w.month}×посты за 30д + ${w.authors}×уникальные авторы за 30д), нормировано к 0–100 по самому активному разделу.</p>`
        : html`<div class="card">Данных пока нет. Установите сборщик (см. «Управление») и запустите синхронизацию на странице форума.</div>`}
      <h2>Самые активные за 30 дней</h2>${leaderTable(top)}`);
  });

  const leaderTable = (rows) => rows.length ? html`<table><tr><th>#</th><th>Игрок</th><th class="r">Постов</th><th class="r">Разделов</th><th>Последний пост</th></tr>
    ${rows.map((u, i) => html`<tr><td>${i + 1}</td><td>${u.nick}</td><td class="r">${u.posts}</td><td class="r">${u.sections}</td><td class="mute">${fmtDate(u.last, tz)}</td></tr>`)}</table>` : html`<p class="mute">Нет данных.</p>`;

  app.get('/sections/:id', async (req, reply) => {
    const st = sectionStats(db, config).find((s) => s.section.id === Number(req.params.id));
    if (!st) return reply.code(404).type('text/plain; charset=utf-8').send('Раздел не найден');
    const recent = db.prepare('SELECT id, author, posted_at FROM posts WHERE section_id = ? ORDER BY posted_at DESC LIMIT 50').all(st.section.id);
    const hours = [...Array(24).keys()];
    const maxA = st.topAuthors[0]?.count || 1;
    return page(reply, req, '/', st.section.title, html`<p><a href="/">← Все разделы</a></p><h1>${st.section.title}</h1>
      <p class="mute">Автор темы: ${st.section.author || '—'} · создана ${fmtDate(st.section.created_at, tz)} · синхронизация ${fmtDate(st.section.synced_at, tz)} · <a href="${st.section.url}" rel="noreferrer">открыть на форуме</a></p>
      <div class="cards">${[['Активность', st.score], ['Всего постов', st.total], ['24 часа', st.day], ['7 дней', st.week], ['30 дней', st.month], ['Авторов за 30д', st.authors30]]
        .map(([l, n]) => html`<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`)}</div>
      <h2>Посты по дням (30 дней)</h2>${barChart(st.perDay, st.days)}
      <h2>Посты по часам суток (${tz})</h2>${barChart(st.perHour, hours.map((h) => `${h}:00`))}
      <div class="grid2"><div><h2>Авторы</h2>${st.topAuthors.length ? html`<table><tr><th>Игрок</th><th class="r">Постов</th><th></th></tr>
        ${st.topAuthors.map((a) => html`<tr><td>${a.nick}</td><td class="r">${a.count}</td><td><div class="bar"><i style="width:${Math.round((a.count / maxA) * 100)}%"></i></div></td></tr>`)}</table>` : html`<p class="mute">Ответов нет.</p>`}</div>
      <div><h2>Последние посты</h2>${recent.length ? html`<table><tr><th>Время</th><th>Автор</th></tr>
        ${recent.map((p) => html`<tr><td><a href="${st.section.url}?do=findComment&comment=${p.id}" rel="noreferrer">${fmtDate(p.posted_at, tz)}</a></td><td>${p.author}</td></tr>`)}</table>` : html`<p class="mute">Ответов нет.</p>`}</div></div>`);
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

  function readPlanForm(b) {
    const title = String(b.title || '').trim().slice(0, 300);
    if (!title) return { error: 'Укажите название публикации' };
    const status = Object.hasOwn(PLAN_STATUSES, b.status) ? b.status : 'idea';
    const date = b.planned_date ? String(b.planned_date) : null;
    if (date && !isDate(date)) return { error: 'Некорректная дата' };
    const sid = b.section_id ? Number(b.section_id) : null;
    if (sid && !db.prepare('SELECT 1 FROM sections WHERE id = ?').get(sid)) return { error: 'Раздел не найден' };
    return { v: { title, status, date, sid, description: String(b.description || '').slice(0, 5000), assignee: String(b.assignee || '').trim().slice(0, 64) } };
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
        <label>Раздел${sectionSelect(null)}</label><label>Ответственный<input name="assignee" placeholder="Ник" maxlength="64"></label></div>
        <div class="row"><label style="flex:1;min-width:300px">Заметки<textarea name="description" rows="2"></textarea></label><button>Добавить</button></div></form>` : ''}
      <table><tr><th>Дата</th><th>Публикация</th><th>Раздел</th><th>Ответственный</th><th>Статус</th><th>Файлы</th></tr>
      ${plans.map((p) => html`<tr><td>${p.planned_date || '—'}</td><td><b>${p.title}</b>${p.description ? html`<div class="mute">${p.description}</div>` : ''}
        ${edit ? html`<details><summary class="mute">изменить</summary>
          <form method="post" action="/plan/${p.id}"><div class="row"><label>Название<input name="title" value="${p.title}" required></label><label>Дата<input type="date" name="planned_date" value="${p.planned_date || ''}"></label>
          <label>Статус${statusSelect('status', p.status)}</label><label>Раздел${sectionSelect(p.section_id)}</label><label>Ответственный<input name="assignee" value="${p.assignee}"></label></div>
          <div class="row"><label style="flex:1">Заметки<textarea name="description" rows="2">${p.description}</textarea></label><button>Сохранить</button></div></form>
          <form method="post" action="/plan/${p.id}/delete" onsubmit="return confirm('Удалить публикацию?')"><button class="danger">Удалить</button></form>
          <form method="post" action="/files/upload" enctype="multipart/form-data"><input type="hidden" name="plan_id" value="${p.id}"><div class="row"><input type="file" name="file" multiple required><button>Прикрепить файлы</button></div></form></details>` : ''}</td>
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
    db.prepare('INSERT INTO plans (title, description, section_id, planned_date, status, assignee, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(v.title, v.description, v.sid, v.date, v.status, v.assignee, req.user.nick, t, t);
    return redirect(reply, '/plan', 'Публикация добавлена');
  });
  app.post('/plan/:id', async (req, reply) => {
    if (!canEdit(req)) return forbid(reply);
    const r = readPlanForm(req.body || {});
    if (r.error) return redirect(reply, '/plan', r.error);
    const v = r.v;
    db.prepare('UPDATE plans SET title=?, description=?, section_id=?, planned_date=?, status=?, assignee=?, updated_at=? WHERE id=?')
      .run(v.title, v.description, v.sid, v.date, v.status, v.assignee, new Date().toISOString(), Number(req.params.id));
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

  // --- управление --------------------------------------------------------
  const adminOnly = async (req, reply) => { if (req.user.role !== 'admin') return forbid(reply); };
  app.get('/admin', { preHandler: adminOnly }, async (req, reply) => {
    const members = db.prepare('SELECT * FROM members ORDER BY role, nick').all();
    const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    return page(reply, req, '/admin', 'Управление', html`<h1>Управление</h1>${flash(req)}
      <h2>Доступ по нику</h2><p class="mute">Войти может только ник из этого списка. Пароля нет — это ограничение выбранной схемы входа, поэтому не публикуйте ссылку на сайт открыто.</p>
      <table><tr><th>Ник</th><th>Роль</th><th></th></tr>${members.map((m) => html`<tr><td>${m.nick}</td><td>${m.role}</td>
        <td>${m.nick.toLowerCase() === req.user.nick.toLowerCase() ? '' : html`<form method="post" action="/admin/members/delete"><input type="hidden" name="nick" value="${m.nick}"><button class="danger">Убрать</button></form>`}</td></tr>`)}</table>
      <form method="post" action="/admin/members"><div class="row"><label>Ник<input name="nick" required maxlength="64"></label>
        <label>Роль<select name="role"><option value="editor">editor — план и файлы</option><option value="viewer">viewer — только просмотр</option><option value="admin">admin</option></select></label><button>Добавить / изменить</button></div></form>
      <h2>Сборщик данных с форума</h2>
      <p>Форум закрыт защитой от ботов, поэтому данные собирает скрипт в вашем браузере (файл <code>collector/forum-collector.user.js</code> в репозитории).
      Поставьте его через Tampermonkey/Violentmonkey, откройте раздел форума и нажмите «Синхронизировать». В настройках скрипта укажите:</p>
      <p>Адрес сайта: <code>${origin}</code><br>Токен: <code>${db.getSetting('ingest_token')}</code></p>
      <form method="post" action="/admin/token" onsubmit="return confirm('Старый токен перестанет работать. Продолжить?')"><button>Выпустить новый токен</button></form>`);
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
  app.post('/admin/token', { preHandler: adminOnly }, async (req, reply) => {
    db.setSetting('ingest_token', crypto.randomBytes(24).toString('hex'));
    return redirect(reply, '/admin', 'Новый токен выпущен');
  });

  // --- API для сборщика --------------------------------------------------
  const apiAuth = (req, reply) => {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ') || !safeEqual(h.slice(7), db.getSetting('ingest_token'))) {
      reply.code(401).send({ error: 'Неверный токен' });
      return false;
    }
    return true;
  };
  app.get('/api/ping', async (req, reply) => (apiAuth(req, reply) ? { ok: true } : undefined));
  app.post('/api/ingest', async (req, reply) => {
    if (!apiAuth(req, reply)) return;
    try {
      const data = parseIngest(req.body);
      const res = applyIngest(db, data);
      return { ok: true, section: data.section.id, ...res };
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.addHook('onClose', async () => db.close());
  app.db = db;
  return app;
}
