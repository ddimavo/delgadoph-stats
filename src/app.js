import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ROLES, PLAN_STATUSES, KIND_META } from './db.js';
import { makeSession, readSession, makeLimiter } from './auth.js';
import { HttpError } from './http.js';
import forumRoutes from './routes/forum.js';
import contentRoutes from './routes/content.js';
import filesRoutes from './routes/files.js';
import moneyRoutes from './routes/money.js';
import overviewRoutes from './routes/overview.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp(config) {
  const db = openDb(config);
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 4 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes, files: 20, fields: 20 } });
  // maxAge 0: браузер каждый раз перепроверяет файлы (ETag), поэтому обновления подхватываются сразу.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, maxAge: 0 });
  const secret = db.getSetting('session_secret');
  const loginLimit = makeLimiter(10, 60_000);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'Не найдено' }));

  const ctx = {
    db, config, tz: config.timezone,
    need(req, level) {
      const r = req.user?.role;
      if (level === 'edit' && r === 'viewer') throw new HttpError(403, 'Недостаточно прав');
      if (level === 'admin' && r !== 'admin') throw new HttpError(403, 'Только для администратора');
    },
  };

  const PUBLIC_API = new Set(['/api/login', '/api/health', '/api/me']);
  app.addHook('onRequest', async (req) => {
    const p = req.url.split('?')[0];
    if (!p.startsWith('/api/')) return;
    // Защита от CSRF: изменяющие запросы должны нести собственный заголовок (кросс-доменно его не отправить без CORS).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'spa') throw new HttpError(403, 'Запрос отклонён');
    const nick = readSession(secret, req.cookies.sid);
    const member = nick && db.prepare('SELECT nick, role FROM members WHERE nick = ?').get(nick);
    if (member) req.user = member;
    else if (!PUBLIC_API.has(p)) throw new HttpError(401, 'Требуется вход');
  });

  const meta = () => ({
    kinds: KIND_META, statuses: PLAN_STATUSES, roles: ROLES, timezone: config.timezone, weights: config.weights, maxUploadBytes: config.maxUploadBytes,
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/me', async (req) => ({ user: req.user || null, meta: req.user ? meta() : null }));
  app.post('/api/login', async (req, reply) => {
    if (!loginLimit(req.ip)) throw new HttpError(429, 'Слишком много попыток, подождите минуту');
    const nick = String(req.body?.nick || '').trim();
    const m = db.prepare('SELECT nick, role FROM members WHERE nick = ?').get(nick);
    if (!m) throw new HttpError(403, 'Этого ника нет в списке доступа. Обратитесь к администратору сайта.');
    reply.setCookie('sid', makeSession(secret, m.nick), {
      httpOnly: true, sameSite: 'lax', path: '/', secure: config.secureCookie, maxAge: 30 * 24 * 3600,
    });
    return { user: m, meta: meta() };
  });
  app.post('/api/logout', async (req, reply) => { reply.clearCookie('sid', { path: '/' }); return { ok: true }; });

  app.get('/api/admin/members', async (req) => { ctx.need(req, 'admin'); return { members: db.prepare('SELECT nick, role, created_at FROM members ORDER BY role, nick').all() }; });
  app.put('/api/admin/members', async (req) => {
    ctx.need(req, 'admin');
    const nick = String(req.body?.nick || '').trim();
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'viewer';
    if (!nick || nick.length > 64) throw new HttpError(400, 'Некорректный ник');
    if (nick.toLowerCase() === req.user.nick.toLowerCase() && role !== 'admin') throw new HttpError(400, 'Нельзя понизить самого себя');
    db.prepare('INSERT INTO members (nick, role, created_at) VALUES (?,?,?) ON CONFLICT(nick) DO UPDATE SET role = excluded.role').run(nick, role, new Date().toISOString());
    return { ok: true };
  });
  app.delete('/api/admin/members', async (req) => {
    ctx.need(req, 'admin');
    const nick = String(req.query.nick || '');
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) throw new HttpError(400, 'Нельзя удалить самого себя');
    db.prepare('DELETE FROM members WHERE nick = ?').run(nick);
    return { ok: true };
  });

  forumRoutes(app, ctx);
  contentRoutes(app, ctx);
  filesRoutes(app, ctx);
  moneyRoutes(app, ctx);
  overviewRoutes(app, ctx);

  app.addHook('onClose', async () => db.close());
  app.db = db;
  return app;
}
