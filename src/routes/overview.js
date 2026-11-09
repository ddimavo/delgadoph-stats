import { topicStats, overview, userLeaderboard, localParts } from '../stats.js';
import { forumTrends, contentStats, recentWeeks } from '../analytics.js';
import { loadRates, calcWeek, weekStart } from '../payouts.js';
import { plansWithFiles } from './content.js';
import { KIND_META } from '../db.js';

export default function overviewRoutes(app, { db, config, tz }) {
  app.get('/api/overview', async (req) => {
    const now = new Date();
    const isAdmin = req.user.role === 'admin';
    const stats = topicStats(db, config, now);
    const plans = db.prepare('SELECT p.*, t.title AS topic_title FROM plans p LEFT JOIN topics t ON t.id = p.topic_id WHERE p.status != ?').all('cancelled');
    const content = contentStats(plans, now, tz);
    const labels = content.labels;

    const byKind = {};
    for (const k of Object.keys(KIND_META)) byKind[k] = { published: content.kinds[k].published, last30: content.kinds[k].last30, prev30: content.kinds[k].prev30, avg: content.kinds[k].avgRating, weekly: content.kinds[k].weekly };

    const published = plans.filter((p) => p.status === 'published' && p.planned_date).sort((a, b) => b.planned_date.localeCompare(a.planned_date) || b.id - a.id);
    const today = localParts(now, tz).day;
    const upcoming = plans.filter((p) => p.status !== 'published' && p.planned_date && p.planned_date >= today).sort((a, b) => a.planned_date.localeCompare(b.planned_date)).slice(0, 6);
    const overdue = plans.filter((p) => p.status !== 'published' && p.planned_date && p.planned_date < today).length;

    const cur = weekStart(today);
    const adRows = db.prepare('SELECT week_start, count FROM ad_edits WHERE week_start >= ?').all(labels[0]);
    const adWeekly = labels.map((w) => adRows.filter((r) => r.week_start === w).reduce((a, r) => a + r.count, 0));

    const out = {
      now: now.toISOString(),
      forum: {
        ...overview(stats), ...forumTrends(db, config, now),
        topUsers: userLeaderboard(db, 30).slice(0, 8),
        topTopics: [...stats].sort((a, b) => b.score - a.score).slice(0, 6).map((s) => ({ id: s.topic.id, title: s.topic.title, score: s.score, week: s.week, month: s.month })),
        authors30: new Set(db.prepare("SELECT DISTINCT author FROM posts WHERE posted_at >= ?").all(new Date(now.getTime() - 30 * 86400_000).toISOString()).map((r) => r.author.toLowerCase())).size,
      },
      content: {
        labels, total: content.total, byKind,
        topEmployees: content.total.authors.slice(0, 8),
        recent: plansWithFiles(db, published.slice(0, 6)),
        upcoming: plansWithFiles(db, upcoming),
        overdue,
      },
      ads: { labels, values: adWeekly, thisWeek: adWeekly[adWeekly.length - 1], prevWeek: adWeekly[adWeekly.length - 2] ?? 0 },
      payouts: null,
    };
    if (isAdmin) { const w = calcWeek(db, loadRates(db), cur); out.payouts = { week: cur, total: w.total, employees: w.rows.length }; }
    return out;
  });
}
