// Расчёт статистики разделов. Все периоды скользящие: 24 часа / 7 дней / 30 дней.
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function lastDays(n, now, tz) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(localParts(new Date(now.getTime() - i * DAY), tz).day);
  return out;
}

export function rawActivity({ week, month, authors }, w) {
  return w.week * week + w.month * month + w.authors * authors;
}

/** Показатель активности: взвешенная сумма, нормированная к 0–100 по лучшему разделу. */
export function normalizeScores(raws) {
  const max = Math.max(0, ...raws);
  return raws.map((r) => (max > 0 ? Math.round((r / max) * 1000) / 10 : 0));
}

function bucket(rows, now) {
  const t = now.getTime();
  const r = { total: rows.length, day: 0, week: 0, month: 0 };
  const a30 = new Set();
  for (const p of rows) {
    const age = t - Date.parse(p.posted_at);
    if (age < 0) continue;
    if (age <= DAY) r.day++;
    if (age <= 7 * DAY) r.week++;
    if (age <= 30 * DAY) { r.month++; a30.add(p.author.toLowerCase()); }
  }
  r.authors30 = a30.size;
  return r;
}

export function sectionStats(db, config, now = new Date()) {
  const sections = db.prepare('SELECT * FROM sections ORDER BY title').all();
  const posts = db.prepare('SELECT section_id, author, posted_at FROM posts ORDER BY posted_at').all();
  const bySection = new Map(sections.map((s) => [s.id, []]));
  for (const p of posts) bySection.get(p.section_id)?.push(p);

  const days = lastDays(30, now, config.timezone);
  const result = sections.map((s) => {
    const rows = bySection.get(s.id);
    const b = bucket(rows, now);
    const perDay = Object.fromEntries(days.map((d) => [d, 0]));
    const perHour = new Array(24).fill(0);
    const authors = new Map();
    for (const p of rows) {
      const lp = localParts(new Date(p.posted_at), config.timezone);
      if (lp.day in perDay) perDay[lp.day]++;
      perHour[lp.hour]++;
      const k = p.author.toLowerCase();
      const cur = authors.get(k) || { nick: p.author, count: 0, last: p.posted_at };
      cur.count++;
      if (p.posted_at > cur.last) cur.last = p.posted_at;
      authors.set(k, cur);
    }
    return {
      section: s,
      ...b,
      last: rows.length ? rows[rows.length - 1].posted_at : null,
      raw: rawActivity({ week: b.week, month: b.month, authors: b.authors30 }, config.weights),
      perDay: days.map((d) => perDay[d]),
      days,
      perHour,
      topAuthors: [...authors.values()].sort((x, y) => y.count - x.count || x.nick.localeCompare(y.nick)),
    };
  });
  const scores = normalizeScores(result.map((r) => r.raw));
  result.forEach((r, i) => (r.score = scores[i]));
  return result;
}

export function overview(stats) {
  const sum = (k) => stats.reduce((a, s) => a + s[k], 0);
  return { sections: stats.length, total: sum('total'), day: sum('day'), week: sum('week'), month: sum('month') };
}

/** Рейтинг пользователей за период (days = null — за всё время). */
export function userLeaderboard(db, days, now = new Date()) {
  const since = days ? new Date(now.getTime() - days * DAY).toISOString() : '';
  return db.prepare(`
    SELECT author AS nick, COUNT(*) AS posts, COUNT(DISTINCT section_id) AS sections, MAX(posted_at) AS last
    FROM posts WHERE posted_at >= ? AND posted_at <= ?
    GROUP BY author ORDER BY posts DESC, nick LIMIT 100`).all(since, now.toISOString());
}
