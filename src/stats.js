// Расчёт статистики тем форума. Периоды скользящие: 24 часа / 7 дней / 30 дней.
const HOUR = 3600_000;
export const DAY = 24 * HOUR;

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

/** Местные день (YYYY-MM-DD), час и день недели (0 = понедельник). */
export function localParts(date, tz) {
  const p = {};
  for (const x of formatter(tz).formatToParts(date)) p[x.type] = x.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, hour: Number(p.hour), dow: (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7 };
}

export function lastDays(n, now, tz) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(localParts(new Date(now.getTime() - i * DAY), tz).day);
  return out;
}

export function rawActivity({ week, month, authors }, w) {
  return w.week * week + w.month * month + w.authors * authors;
}

/** Показатель активности: взвешенная сумма, нормированная к 0–100 по лучшей теме. */
export function normalizeScores(raws) {
  const max = Math.max(0, ...raws);
  return raws.map((r) => (max > 0 ? Math.round((r / max) * 1000) / 10 : 0));
}

function bucket(rows, now) {
  const t = now.getTime();
  const r = { total: rows.length, day: 0, week: 0, weekPrev: 0, month: 0, monthPrev: 0 };
  const a30 = new Set();
  for (const p of rows) {
    const age = t - Date.parse(p.posted_at);
    if (age < 0) continue;
    if (age <= DAY) r.day++;
    if (age <= 7 * DAY) r.week++; else if (age <= 14 * DAY) r.weekPrev++;
    if (age <= 30 * DAY) { r.month++; a30.add(p.author.toLowerCase()); } else if (age <= 60 * DAY) r.monthPrev++;
  }
  r.authors30 = a30.size;
  return r;
}

export function topicStats(db, config, now = new Date()) {
  const topics = db.prepare('SELECT * FROM topics ORDER BY title').all();
  const posts = db.prepare('SELECT topic_id, author, posted_at FROM posts ORDER BY posted_at').all();
  const byTopic = new Map(topics.map((s) => [s.id, []]));
  for (const p of posts) byTopic.get(p.topic_id)?.push(p);

  const days = lastDays(30, now, config.timezone);
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const since = now.getTime() - 31 * DAY;
  const result = topics.map((t) => {
    const rows = byTopic.get(t.id);
    const b = bucket(rows, now);
    const perDay = new Array(30).fill(0);
    const perHour = new Array(24).fill(0);
    const authors = new Map();
    for (const p of rows) {
      const lp = localParts(new Date(p.posted_at), config.timezone);
      if (Date.parse(p.posted_at) >= since && dayIdx.has(lp.day)) perDay[dayIdx.get(lp.day)]++;
      perHour[lp.hour]++;
      const k = p.author.toLowerCase();
      const cur = authors.get(k) || { nick: p.author, count: 0, last: p.posted_at };
      cur.count++;
      if (p.posted_at > cur.last) cur.last = p.posted_at;
      authors.set(k, cur);
    }
    return {
      topic: t, ...b,
      last: rows.length ? rows[rows.length - 1].posted_at : null,
      raw: rawActivity({ week: b.week, month: b.month, authors: b.authors30 }, config.weights),
      perDay, days, perHour,
      topAuthors: [...authors.values()].sort((x, y) => y.count - x.count || x.nick.localeCompare(y.nick)),
    };
  });
  const scores = normalizeScores(result.map((r) => r.raw));
  result.forEach((r, i) => (r.score = scores[i]));
  return result;
}

export function overview(stats) {
  const sum = (k) => stats.reduce((a, s) => a + s[k], 0);
  return { topics: stats.length, total: sum('total'), day: sum('day'), week: sum('week'), weekPrev: sum('weekPrev'), month: sum('month'), monthPrev: sum('monthPrev') };
}

/** Рейтинг пользователей за период (days = null — за всё время). */
export function userLeaderboard(db, days, now = new Date()) {
  const since = days ? new Date(now.getTime() - days * DAY).toISOString() : '';
  return db.prepare(`
    SELECT author AS nick, COUNT(*) AS posts, COUNT(DISTINCT topic_id) AS topics, MAX(posted_at) AS last
    FROM posts WHERE posted_at >= ? AND posted_at <= ?
    GROUP BY author ORDER BY posts DESC, nick LIMIT 100`).all(since, now.toISOString());
}
