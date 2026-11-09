import { bad, notFound, isDate, str } from '../http.js';
import { PLAN_STATUSES, KIND_META } from '../db.js';
import { loadRates, itemAmount, weekStart } from '../payouts.js';
import { contentStats, recentWeeks } from '../analytics.js';
import { localParts } from '../stats.js';

export function plansWithFiles(db, rows, { rates } = {}) {
  const files = db.prepare('SELECT id, plan_id, original_name AS name, mime, size FROM files WHERE plan_id IS NOT NULL ORDER BY id').all();
  const by = new Map();
  for (const f of files) { if (!by.has(f.plan_id)) by.set(f.plan_id, []); by.get(f.plan_id).push({ id: f.id, name: f.name, mime: f.mime, size: f.size }); }
  return rows.map((p) => ({
    id: p.id, title: p.title, description: p.description, topic_id: p.topic_id, topic_title: p.topic_title ?? null, planned_date: p.planned_date, status: p.status,
    assignee: p.assignee, kind: p.kind, rating: p.rating, url: p.url, payout_override: p.payout_override, created_by: p.created_by, updated_at: p.updated_at,
    files: by.get(p.id) || [],
    ...(rates && p.status === 'published' ? { payout: itemAmount(p, rates).amount } : {}),
  }));
}

export default function contentRoutes(app, { db, config, tz, need }) {
  const baseSelect = 'SELECT p.*, t.title AS topic_title FROM plans p LEFT JOIN topics t ON t.id = p.topic_id';
  const rows = (where = '', ...args) => db.prepare(`${baseSelect} ${where} ORDER BY (p.planned_date IS NULL), p.planned_date DESC, p.id DESC`).all(...args);

  function readPlan(b) {
    const title = str(b?.title, 300);
    if (!title) throw bad('Укажите название публикации');
    const status = Object.hasOwn(PLAN_STATUSES, b.status) ? b.status : 'idea';
    const date = b.planned_date ? String(b.planned_date) : null;
    if (date && !isDate(date)) throw bad('Некорректная дата');
    const tid = b.topic_id ? Number(b.topic_id) : null;
    if (tid && !db.prepare('SELECT 1 FROM topics WHERE id = ?').get(tid)) throw bad('Тема форума не найдена');
    const kind = Object.hasOwn(KIND_META, b.kind) ? b.kind : 'other';
    const rating = b.rating ? Number(b.rating) : null;
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw bad('Оценка — от 1 до 5 звёзд');
    const url = str(b.url, 500);
    if (url && !/^https?:\/\//.test(url)) throw bad('Ссылка должна начинаться с http:// или https://');
    const ovRaw = String(b.payout_override ?? '').replace(/[\s_.]/g, '');
    const override = ovRaw ? Number(ovRaw) : null;
    if (override !== null) {
      const { min, max } = loadRates(db).event;
      if (!/^\d+$/.test(ovRaw) || override < min || override > max) throw bad(`Ручная сумма за мероприятие — от ${min} до ${max} $`);
    }
    return { title, status, date, tid, kind, rating, url, override, description: str(b.description, 500), assignee: str(b.assignee, 64) };
  }

  const ratesFor = (req) => (req.user.role === 'admin' ? loadRates(db) : undefined);

  app.get('/api/plans', async (req) => ({ plans: plansWithFiles(db, rows(), { rates: ratesFor(req) }) }));

  app.post('/api/plans', async (req) => {
    need(req, 'edit');
    const v = readPlan(req.body || {}), t = new Date().toISOString();
    const id = Number(db.prepare(`INSERT INTO plans (title, description, topic_id, planned_date, status, assignee, kind, rating, url, payout_override, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.title, v.description, v.tid, v.date, v.status, v.assignee, v.kind, v.rating, v.url, v.override, req.user.nick, t, t).lastInsertRowid);
    return { id };
  });
  app.put('/api/plans/:id', async (req) => {
    need(req, 'edit');
    const v = readPlan(req.body || {});
    const r = db.prepare(`UPDATE plans SET title=?, description=?, topic_id=?, planned_date=?, status=?, assignee=?, kind=?, rating=?, url=?, payout_override=?, updated_at=? WHERE id=?`)
      .run(v.title, v.description, v.tid, v.date, v.status, v.assignee, v.kind, v.rating, v.url, v.override, new Date().toISOString(), Number(req.params.id));
    if (!r.changes) throw notFound('Публикация не найдена');
    return { ok: true };
  });
  app.patch('/api/plans/:id/status', async (req) => {
    need(req, 'edit');
    if (!Object.hasOwn(PLAN_STATUSES, req.body?.status)) throw bad('Неизвестный статус');
    const r = db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, new Date().toISOString(), Number(req.params.id));
    if (!r.changes) throw notFound('Публикация не найдена');
    return { ok: true };
  });
  app.delete('/api/plans/:id', async (req) => {
    need(req, 'edit');
    db.prepare('DELETE FROM plans WHERE id = ?').run(Number(req.params.id)); // файлы остаются в хранилище
    return { ok: true };
  });

  // Раздел сайта по виду работ: опубликованные публикации попадают сюда автоматически.
  app.get('/api/sections/:kind', async (req) => {
    const kind = req.params.kind;
    if (!Object.hasOwn(KIND_META, kind)) throw notFound('Раздел не найден');
    const now = new Date();
    const all = rows('WHERE p.kind = ? AND p.status != ?', kind, 'cancelled');
    const stats = contentStats(all, now, tz).kinds[kind];
    const rates = ratesFor(req);
    const published = all.filter((p) => p.status === 'published');
    const upcoming = all.filter((p) => p.status !== 'published').sort((a, b) => (a.planned_date ?? '9999').localeCompare(b.planned_date ?? '9999') || a.id - b.id);
    return {
      kind, meta: KIND_META[kind], weekLabels: recentWeeks(12, now, tz), stats,
      items: plansWithFiles(db, published.slice(0, 500), { rates }),
      inProgress: plansWithFiles(db, upcoming, { rates }),
    };
  });

  // Объявления: статистика правок вводится вручную по неделям.
  app.get('/api/ads', async (req) => {
    const now = new Date();
    const cur = weekStart(localParts(now, tz).day);
    const week = isDate(req.query.week) ? weekStart(req.query.week) : cur;
    const labels = recentWeeks(12, now, tz);
    const entries = db.prepare('SELECT employee, count FROM ad_edits WHERE week_start = ? ORDER BY count DESC, employee').all(week);
    const hist = db.prepare('SELECT week_start, employee, count FROM ad_edits WHERE week_start >= ? ORDER BY week_start').all(labels[0]);
    const weekly = labels.map((w) => hist.filter((h) => h.week_start === w).reduce((a, h) => a + h.count, 0));
    const by = new Map();
    for (const h of hist) { const k = h.employee.toLowerCase(); const e = by.get(k) || { employee: h.employee, total: 0, weeks: 0 }; e.total += h.count; e.weeks++; by.set(k, e); }
    const known = db.prepare('SELECT DISTINCT employee FROM ad_edits ORDER BY employee').all().map((r) => r.employee);
    return { week, currentWeek: cur, entries, weekly: { labels, values: weekly }, leaders: [...by.values()].sort((a, b) => b.total - a.total), employees: known };
  });
  const adArgs = (b) => {
    const week = weekStart(isDate(b?.week) ? b.week : new Date().toISOString().slice(0, 10));
    const employee = str(b?.employee, 64), c = String(b?.count ?? '');
    if (!employee || !/^\d{1,6}$/.test(c)) throw bad('Укажите сотрудника и число правок');
    return { week, employee, count: Number(c) };
  };
  app.put('/api/ads', async (req) => {
    need(req, 'edit');
    const a = adArgs(req.body);
    db.prepare('INSERT INTO ad_edits (week_start, employee, count) VALUES (?,?,?) ON CONFLICT(week_start, employee) DO UPDATE SET count = excluded.count').run(a.week, a.employee, a.count);
    return { ok: true };
  });
  app.delete('/api/ads', async (req) => {
    need(req, 'edit');
    if (!isDate(req.query.week)) throw bad('Некорректная неделя');
    db.prepare('DELETE FROM ad_edits WHERE week_start = ? AND employee = ?').run(weekStart(req.query.week), String(req.query.employee || ''));
    return { ok: true };
  });
}
