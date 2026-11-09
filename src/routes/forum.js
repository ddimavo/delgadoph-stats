import { bad, notFound, isDate, str } from '../http.js';
import { topicStats, overview, userLeaderboard } from '../stats.js';
import { forumTrends } from '../analytics.js';
import { parsePostLines, addPosts } from '../manual.js';

const slim = (s) => ({
  id: s.topic.id, title: s.topic.title, url: s.topic.url, author: s.topic.author, created_at: s.topic.created_at, locked: !!s.topic.locked, synced_at: s.topic.synced_at,
  total: s.total, day: s.day, week: s.week, weekPrev: s.weekPrev, month: s.month, authors30: s.authors30, score: s.score, last: s.last, perDay: s.perDay,
});

function readTopic(b) {
  const title = str(b?.title, 300);
  if (!title) throw bad('Укажите название темы');
  const url = str(b?.url, 500);
  if (url && !/^https?:\/\//.test(url)) throw bad('Ссылка должна начинаться с http:// или https://');
  const created = b?.created_at ? String(b.created_at).slice(0, 10) : null;
  if (created && !isDate(created)) throw bad('Некорректная дата создания');
  return { title, url, author: str(b?.author, 64) || null, created };
}

export default function forumRoutes(app, { db, config, need }) {
  app.get('/api/forum', async () => {
    const now = new Date();
    const stats = topicStats(db, config, now);
    return { summary: overview(stats), topics: stats.map(slim), ...forumTrends(db, config, now) };
  });

  app.get('/api/topics', async () => ({ topics: db.prepare('SELECT id, title FROM topics ORDER BY title').all() }));

  app.get('/api/forum/topics/:id', async (req) => {
    const st = topicStats(db, config).find((s) => s.topic.id === Number(req.params.id));
    if (!st) throw notFound('Тема не найдена');
    const recent = db.prepare('SELECT id, author, posted_at FROM posts WHERE topic_id = ? ORDER BY posted_at DESC LIMIT 100').all(st.topic.id);
    return { ...slim(st), days: st.days, perHour: st.perHour, topAuthors: st.topAuthors, recent };
  });

  app.post('/api/forum/topics', async (req) => {
    need(req, 'edit');
    const v = readTopic(req.body);
    const id = Number(db.prepare('INSERT INTO topics (title, url, author, created_at) VALUES (?,?,?,?)').run(v.title, v.url, v.author, v.created).lastInsertRowid);
    return { id };
  });
  app.put('/api/forum/topics/:id', async (req) => {
    need(req, 'edit');
    const v = readTopic(req.body);
    const r = db.prepare('UPDATE topics SET title=?, url=?, author=?, created_at=? WHERE id=?').run(v.title, v.url, v.author, v.created, Number(req.params.id));
    if (!r.changes) throw notFound('Тема не найдена');
    return { ok: true };
  });
  app.delete('/api/forum/topics/:id', async (req) => {
    need(req, 'edit');
    db.prepare('DELETE FROM topics WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.post('/api/forum/topics/:id/posts', async (req) => {
    need(req, 'edit');
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM topics WHERE id = ?').get(id)) throw notFound('Тема не найдена');
    const { posts, errors } = parsePostLines(req.body?.text, config.timezone);
    if (errors.length) throw bad('Ничего не сохранено: есть строки с ошибками', errors);
    if (!posts.length) throw bad('Нет строк для внесения');
    const res = addPosts(db, id, posts);
    db.prepare('UPDATE topics SET synced_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return res;
  });
  app.delete('/api/forum/topics/:id/posts/:pid', async (req) => {
    need(req, 'edit');
    db.prepare('DELETE FROM posts WHERE id = ? AND topic_id = ?').run(Number(req.params.pid), Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/forum/users', async (req) => {
    const periods = { 7: 7, 30: 30, all: null };
    const per = Object.hasOwn(periods, req.query.period) ? req.query.period : '30';
    return { period: per, users: userLeaderboard(db, periods[per]) };
  });
}
