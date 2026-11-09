import { bad, isDate } from '../http.js';
import { DEFAULT_RATES, loadRates, parseRatesForm, calcWeek, weekStart, weekEnd, shiftWeek } from '../payouts.js';
import { buildWorkbook } from '../export.js';
import { localParts } from '../stats.js';

export default function moneyRoutes(app, { db, config, need }) {
  const currentWeek = () => weekStart(localParts(new Date(), config.timezone).day);
  const weekOf = (q) => (isDate(q) ? weekStart(q) : currentWeek());

  app.get('/api/payouts', async (req) => {
    need(req, 'admin');
    const start = weekOf(req.query.week), rates = loadRates(db), w = calcWeek(db, rates, start);
    const slimPlan = (p) => ({ id: p.id, title: p.title, kind: p.kind, rating: p.rating, planned_date: p.planned_date, status: p.status, assignee: p.assignee });
    return {
      start, end: weekEnd(start), prev: shiftWeek(start, -1), next: shiftWeek(start, 1), currentWeek: currentWeek(), total: w.total,
      rows: w.rows.map((e) => ({ ...e, items: e.items.map((i) => ({ plan: slimPlan(i.plan), amount: i.amount, note: i.note })) })),
      skipped: w.skipped.map((x) => ({ plan: slimPlan(x.plan), why: x.why })),
    };
  });
  app.get('/api/payouts/rates', async (req) => { need(req, 'admin'); return { rates: loadRates(db), defaults: DEFAULT_RATES }; });
  app.put('/api/payouts/rates', async (req) => {
    need(req, 'admin');
    const r = parseRatesForm(req.body);
    if (r.error) throw bad(r.error);
    db.setSetting('rates', JSON.stringify(r.rates));
    return { rates: r.rates };
  });
  app.post('/api/payouts/rates/reset', async (req) => {
    need(req, 'admin');
    db.setSetting('rates', JSON.stringify(DEFAULT_RATES));
    return { rates: DEFAULT_RATES };
  });

  app.get('/api/export.xlsx', async (req, reply) => {
    const buf = await buildWorkbook(db, config, { rates: loadRates(db), weekStart: weekOf(req.query.week), includePayouts: req.user.role === 'admin' });
    return reply.header('Content-Disposition', `attachment; filename="delgadoph-stats-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
  });
}
