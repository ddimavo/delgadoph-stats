import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setup } from './helpers.js';
import { loadRates, calcWeek, weekStart, weekEnd, parseRatesForm, DEFAULT_RATES } from '../src/payouts.js';

const WEEK = '2026-11-02'; // понедельник

async function withPlans() {
  const ctx = await setup();
  ctx.addPlan = (o) => ctx.app.db.prepare(`INSERT INTO plans (title, planned_date, status, assignee, kind, rating, payout_override, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'x','x','x')`).run(o.title ?? 't', o.date ?? '2026-11-03', o.status ?? 'published', o.assignee ?? 'Ann', o.kind, o.rating ?? null, o.override ?? null);
  return ctx;
}
const week = (app) => calcWeek(app.db, loadRates(app.db), WEEK);

test('границы недели: понедельник–воскресенье', () => {
  assert.equal(weekStart('2026-11-08'), '2026-11-02');
  assert.equal(weekStart('2026-11-02'), '2026-11-02');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekEnd('2026-11-02'), '2026-11-08');
});

test('ситуации: шкала по звёздам и лимит 300 000 в неделю', async () => {
  const { app, addPlan } = await withPlans();
  for (const r of [1, 2, 3, 4, 5]) addPlan({ kind: 'situation', rating: r });
  const w = week(app);
  assert.deepEqual(w.rows[0].items.map((i) => i.amount), [0, 25000, 50000, 75000, 100000]);
  addPlan({ kind: 'situation', rating: 5 }); addPlan({ kind: 'situation', rating: 5 });
  const capped = week(app).rows[0];
  assert.equal(capped.situation, 300000);
  assert.match(capped.notes.join(), /лимит/);
  await app.close();
});

test('объявления: 500 $, оплата не более 300, бонус только при >100 и один раз', async () => {
  const { app } = await withPlans();
  const put = (emp, c) => app.db.prepare('INSERT INTO ad_edits VALUES (?,?,?)').run(WEEK, emp, c);
  put('A', 100); put('B', 101); put('C', 450);
  const by = Object.fromEntries(week(app).rows.map((r) => [r.nick, r]));
  assert.deepEqual([by.A.adPaid, by.A.adBonus], [50000, 0]);
  assert.deepEqual([by.B.adPaid, by.B.adBonus], [50500, 50000]);
  assert.deepEqual([by.C.adPaid, by.C.adBonus, by.C.total], [150000, 50000, 200000]);
  await app.close();
});

test('мероприятия и эфиры: суммы, ручная сумма, порог, лимиты', async () => {
  const { app, addPlan } = await withPlans();
  addPlan({ kind: 'event', rating: 3 }); addPlan({ kind: 'event', rating: 1, override: 450000 }); addPlan({ kind: 'event', rating: 5 });
  for (const r of [5, 3, 2]) addPlan({ kind: 'radio', rating: r, assignee: 'Bob' });
  for (let i = 0; i < 20; i++) addPlan({ kind: 'radio', rating: 4, assignee: 'Cat' });
  const by = Object.fromEntries(week(app).rows.map((r) => [r.nick, r]));
  assert.equal(by.Ann.event, 1000000);
  assert.equal(by.Bob.radio, 60000);
  assert.equal(by.Cat.radio, 500000);
  await app.close();
});

test('не учитываются: неопубликованные, без ответственного, без оценки, чужая неделя', async () => {
  const { app, addPlan } = await withPlans();
  addPlan({ kind: 'situation', rating: 5, status: 'draft' });
  addPlan({ kind: 'situation', rating: 5, assignee: '' });
  addPlan({ kind: 'situation', rating: 5, date: '2026-11-09' });
  addPlan({ kind: 'situation', rating: null });
  const w = week(app);
  assert.equal(w.total, 0);
  assert.equal(w.skipped.length, 2);
  assert.equal(w.rows[0].items[0].note, 'нет оценки');
  await app.close();
});

function flat(r) {
  const o = {};
  [1, 2, 3, 4, 5].forEach((n) => { o[`sit_${n}`] = r.situation.stars[n]; o[`ev_${n}`] = r.event.stars[n]; });
  return Object.assign(o, { sit_cap: r.situation.weekCap, ad_rate: r.ads.rate, ad_bonus: r.ads.bonus, ad_bonus_after: r.ads.bonusAfter, ad_limit: r.ads.paidLimit,
    ev_min: r.event.min, ev_max: r.event.max, ev_cap: r.event.weekCap, radio_rate: r.radio.rate, radio_min_stars: r.radio.minStars, radio_cap: r.radio.weekCap });
}

test('расценки через API: сохранение, валидация, сброс; расчёт в /api/payouts', async () => {
  assert.ok(parseRatesForm({ ...flat(DEFAULT_RATES), sit_cap: 'abc' }).error);
  assert.ok(parseRatesForm({ ...flat(DEFAULT_RATES), ev_min: '600000' }).error);
  const { app, as, addPlan } = await withPlans();
  const boss = await as('Boss');
  assert.equal((await boss('PUT', '/api/payouts/rates', { ...flat(DEFAULT_RATES), ad_rate: '700' })).status, 200);
  assert.equal(loadRates(app.db).ads.rate, 700);
  assert.equal((await boss('PUT', '/api/payouts/rates', { ...flat(DEFAULT_RATES), ev_min: '999999999' })).status, 400);
  await boss('POST', '/api/payouts/rates/reset', {});
  assert.equal(loadRates(app.db).ads.rate, 500);
  addPlan({ kind: 'event', rating: 4, override: 450000 });
  const p = (await boss('GET', `/api/payouts?week=${WEEK}`)).json;
  assert.equal(p.total, 450000);
  assert.equal(p.start, WEEK);
  assert.equal(p.rows[0].items[0].note, 'сумма вручную');
  await app.close();
});

test('xlsx: листы, суммы; выплаты только в выгрузке администратора', async () => {
  const { app, as, addPlan } = await withPlans();
  addPlan({ kind: 'situation', rating: 5, title: 'Ситуация' });
  const get = async (nick) => {
    const c = await as(nick);
    const r = await c('GET', `/api/export.xlsx?week=${WEEK}`);
    assert.equal(r.status, 200);
    assert.match(r.res.headers['content-type'], /spreadsheetml/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.res.rawPayload); return wb;
  };
  const boss = await get('Boss'), ed = await get('Ed');
  assert.ok(boss.getWorksheet('Темы форума') && boss.getWorksheet('План публикаций') && boss.getWorksheet('Посты'));
  assert.equal(boss.getWorksheet(`Выплаты ${WEEK}`).getRow(2).getCell(8).value, 100000);
  assert.equal(boss.getWorksheet('План публикаций').getRow(2).getCell(6).value, 5);
  assert.ok(!ed.worksheets.some((w) => w.name.startsWith('Выплаты')));
  await app.close();
});
