// Агрегаты для панелей: тренды по неделям, тепловая карта, статистика видов работ.
import { localParts, DAY } from './stats.js';
import { weekStart, shiftWeek } from './payouts.js';
import { KIND_META } from './db.js';

export const dayShift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** n понедельников, заканчивая текущей неделей. */
export function recentWeeks(n, now, tz) {
  const cur = weekStart(localParts(now, tz).day);
  return Array.from({ length: n }, (_, i) => shiftWeek(cur, i - (n - 1)));
}

export function forumTrends(db, config, now, weeks = 12) {
  const tz = config.timezone;
  const labels = recentWeeks(weeks, now, tz);
  const idx = new Map(labels.map((w, i) => [w, i]));
  const values = new Array(weeks).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const from = new Date(now.getTime() - 91 * DAY).toISOString();
  const rows = db.prepare('SELECT posted_at FROM posts WHERE posted_at >= ? AND posted_at <= ?').all(from, now.toISOString());
  const heatFrom = now.getTime() - 90 * DAY;
  for (const r of rows) {
    const t = Date.parse(r.posted_at);
    const lp = localParts(new Date(t), tz);
    const w = idx.get(weekStart(lp.day));
    if (w !== undefined) values[w]++;
    if (t >= heatFrom) heat[lp.dow][lp.hour]++;
  }
  return { weekly: { labels, values }, heatmap: heat };
}

const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null);

/** Статистика по публикациям (только опубликованные). plans — строки таблицы plans. */
export function contentStats(plans, now, tz, weeks = 12) {
  const today = localParts(now, tz).day;
  const d30 = dayShift(today, -29), p30 = dayShift(today, -59);
  const labels = recentWeeks(weeks, now, tz);
  const widx = new Map(labels.map((w, i) => [w, i]));
  const mk = () => ({
    published: 0, last30: 0, prev30: 0, ratings: [], dist: [0, 0, 0, 0, 0],
    weekly: new Array(weeks).fill(0), authors: new Map(),
  });
  const total = mk(), kinds = Object.fromEntries(Object.keys(KIND_META).map((k) => [k, mk()]));
  for (const p of plans) {
    if (p.status !== 'published' || !p.planned_date) continue;
    for (const b of [total, kinds[p.kind] || kinds.other]) {
      b.published++;
      if (p.planned_date >= d30 && p.planned_date <= today) b.last30++;
      else if (p.planned_date >= p30 && p.planned_date < d30) b.prev30++;
      if (p.rating) { b.ratings.push(p.rating); b.dist[p.rating - 1]++; }
      const w = widx.get(weekStart(p.planned_date));
      if (w !== undefined) b.weekly[w]++;
      if (p.assignee) {
        const k = p.assignee.toLowerCase();
        const a = b.authors.get(k) || { nick: p.assignee, count: 0, ratings: [], last: '' };
        a.count++;
        if (p.rating) a.ratings.push(p.rating);
        if (p.planned_date > a.last) a.last = p.planned_date;
        b.authors.set(k, a);
      }
    }
  }
  const fin = (b) => ({
    published: b.published, last30: b.last30, prev30: b.prev30, avgRating: avg(b.ratings), rated: b.ratings.length, ratingDist: b.dist,
    weekly: b.weekly,
    authors: [...b.authors.values()].map((a) => ({ nick: a.nick, count: a.count, avg: avg(a.ratings), last: a.last }))
      .sort((x, y) => y.count - x.count || (y.avg ?? 0) - (x.avg ?? 0) || x.nick.localeCompare(y.nick)),
  });
  return { labels, total: fin(total), kinds: Object.fromEntries(Object.entries(kinds).map(([k, b]) => [k, fin(b)])) };
}
