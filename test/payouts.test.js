import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { loadRates, calcWeek, weekStart, weekEnd, parseRatesForm, DEFAULT_RATES } from '../src/payouts.js';

process.env.NODE_ENV = 'test';
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const WEEK = '2026-11-02'; // понедельник

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
  const app = await buildApp(loadConfig({ DATA_DIR: dir, ADMIN_NICK: 'Boss', TZ_NAME: 'UTC' }));
  const login = async (nick) => {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `nick=${nick}`, headers: form });
    return `sid=${r.cookies[0].value}`;
  };
  const addPlan = (o) => app.db.prepare(`INSERT INTO plans (title, planned_date, status, assignee, kind, rating, payout_override, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'x','x','x')`).run(o.title ?? 't', o.date ?? '2026-11-03', o.status ?? 'published', o.assignee ?? 'Ann', o.kind, o.rating ?? null, o.override ?? null);
  return { app, login, addPlan };
}

test('границы недели: понедельник–воскресенье', () => {
  assert.equal(weekStart('2026-11-08'), '2026-11-02'); // воскресенье
  assert.equal(weekStart('2026-11-02'), '2026-11-02');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekEnd('2026-11-02'), '2026-11-08');
});

test('ситуации: шкала по звёздам и лимит 300 000 в неделю', async () => {
  const { app, addPlan } = await setup();
  for (const r of [1, 2, 3, 4, 5]) addPlan({ kind: 'situation', rating: r });
  const w = calcWeek(app.db, loadRates(app.db), WEEK);
  assert.deepEqual(w.rows[0].items.map((i) => i.amount), [0, 25000, 50000, 75000, 100000]);
  assert.equal(w.rows[0].situationRaw, 250000);
  addPlan({ kind: 'situation', rating: 5 }); addPlan({ kind: 'situation', rating: 5 });
  const capped = calcWeek(app.db, loadRates(app.db), WEEK).rows[0];
  assert.equal(capped.situation, 300000);
  assert.match(capped.notes.join(), /лимит/);
  await app.close();
});

test('объявления: 500 $, оплата не более 300, бонус только при >100 и один раз', async () => {
  const { app } = await setup();
  const put = (emp, c) => app.db.prepare('INSERT INTO ad_edits VALUES (?,?,?)').run(WEEK, emp, c);
  put('A', 100); put('B', 101); put('C', 450);
  const by = Object.fromEntries(calcWeek(app.db, loadRates(app.db), WEEK).rows.map((r) => [r.nick, r]));
  assert.deepEqual([by.A.adPaid, by.A.adBonus], [50000, 0]);
  assert.deepEqual([by.B.adPaid, by.B.adBonus], [50500, 50000]);
  assert.deepEqual([by.C.adPaid, by.C.adBonus, by.C.total], [150000, 50000, 200000]);
  await app.close();
});

test('мероприятия и эфиры: суммы, ручная сумма, порог, лимиты', async () => {
  const { app, addPlan } = await setup();
  addPlan({ kind: 'event', rating: 3 });                    // 300 000
  addPlan({ kind: 'event', rating: 1, override: 450000 });  // вручную 450 000
  addPlan({ kind: 'event', rating: 5 });                    // 500 000 -> всего 1 250 000 > лимита 1 000 000
  for (const r of [5, 3, 2]) addPlan({ kind: 'radio', rating: r, assignee: 'Bob' });
  for (let i = 0; i < 20; i++) addPlan({ kind: 'radio', rating: 4, assignee: 'Cat' });
  const by = Object.fromEntries(calcWeek(app.db, loadRates(app.db), WEEK).rows.map((r) => [r.nick, r]));
  assert.equal(by.Ann.event, 1000000);
  assert.equal(by.Bob.radio, 60000); // 2★ ниже порога
  assert.equal(by.Cat.radio, 500000);
  await app.close();
});

test('не учитываются: неопубликованные, без ответственного, без оценки, чужая неделя', async () => {
  const { app, addPlan } = await setup();
  addPlan({ kind: 'situation', rating: 5, status: 'draft' });
  addPlan({ kind: 'situation', rating: 5, assignee: '' });
  addPlan({ kind: 'situation', rating: 5, date: '2026-11-09' });
  addPlan({ kind: 'situation', rating: null });
  const w = calcWeek(app.db, loadRates(app.db), WEEK);
  assert.equal(w.total, 0);
  assert.equal(w.skipped.length, 2);
  assert.equal(w.rows[0].items[0].note, 'нет оценки');
  await app.close();
});

test('расценки: сохранение, валидация, сброс', async () => {
  assert.match(parseRatesForm({ ...Object.fromEntries(Object.keys(flat(DEFAULT_RATES)).map((k) => [k, '1'])) }).error ?? '', /^$|Порог|максимума/);
  assert.ok(parseRatesForm({ ...flat(DEFAULT_RATES), sit_cap: 'abc' }).error);
  assert.ok(parseRatesForm({ ...flat(DEFAULT_RATES), ev_min: '600000' }).error);
  const { app, login } = await setup();
  const cookie = await login('Boss');
  const body = new URLSearchParams({ ...flat(DEFAULT_RATES), ad_rate: '700' }).toString();
  await app.inject({ method: 'POST', url: '/payouts/rates', payload: body, headers: { ...form, cookie } });
  assert.equal(loadRates(app.db).ads.rate, 700);
  await app.inject({ method: 'POST', url: '/payouts/rates/reset', headers: { cookie } });
  assert.equal(loadRates(app.db).ads.rate, 500);
  await app.close();
});
function flat(r) {
  const o = {};
  [1, 2, 3, 4, 5].forEach((n) => { o[`sit_${n}`] = r.situation.stars[n]; o[`ev_${n}`] = r.event.stars[n]; });
  Object.assign(o, { sit_cap: r.situation.weekCap, ad_rate: r.ads.rate, ad_bonus: r.ads.bonus, ad_bonus_after: r.ads.bonusAfter, ad_limit: r.ads.paidLimit,
    ev_min: r.event.min, ev_max: r.event.max, ev_cap: r.event.weekCap, radio_rate: r.radio.rate, radio_min_stars: r.radio.minStars, radio_cap: r.radio.weekCap });
  return o;
}

test('выплаты и расценки доступны только администратору; формы плана сохраняют тип и оценку', async () => {
  const { app, login } = await setup();
  app.db.prepare("INSERT INTO members (nick, role, created_at) VALUES ('Ed','editor','x')").run();
  const ed = await login('Ed'), boss = await login('Boss');
  for (const url of ['/payouts', '/payouts/rates']) assert.equal((await app.inject({ url, headers: { cookie: ed } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/payouts', headers: { cookie: boss } })).statusCode, 200);
  const mk = (extra) => app.inject({ method: 'POST', url: '/plan', payload: `title=P&status=published&planned_date=2026-11-03&assignee=Ann&kind=event&${extra}`, headers: { ...form, cookie: ed } });
  assert.equal((await mk('rating=4&description=' + encodeURIComponent('Краткое описание'))).statusCode, 302);
  const row = app.db.prepare('SELECT * FROM plans').get();
  assert.deepEqual([row.kind, row.rating, row.description], ['event', 4, 'Краткое описание']);
  assert.match(decodeURIComponent((await mk('rating=9')).headers.location), /от 1 до 5/);
  assert.match(decodeURIComponent((await mk('payout_override=50000')).headers.location), /Ручная сумма/);
  const page = await app.inject({ url: `/payouts?week=${WEEK}`, headers: { cookie: boss } });
  assert.match(page.body, /400\s000 \$/);
  await app.close();
});

test('xlsx: листы, суммы; выплаты только в выгрузке администратора', async () => {
  const { app, login, addPlan } = await setup();
  app.db.prepare("INSERT INTO members (nick, role, created_at) VALUES ('Ed','editor','x')").run();
  addPlan({ kind: 'situation', rating: 5, title: 'Ситуация' });
  const get = async (nick) => {
    const r = await app.inject({ url: `/export.xlsx?week=${WEEK}`, headers: { cookie: await login(nick) } });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'], /spreadsheetml/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload); return wb;
  };
  const boss = await get('Boss'), ed = await get('Ed');
  assert.ok(boss.getWorksheet('Разделы') && boss.getWorksheet('План публикаций') && boss.getWorksheet('Посты'));
  assert.equal(boss.getWorksheet(`Выплаты ${WEEK}`).getRow(2).getCell(8).value, 100000);
  assert.equal(boss.getWorksheet('План публикаций').getRow(2).getCell(6).value, 5);
  assert.ok(!ed.worksheets.some((w) => w.name.startsWith('Выплаты')));
  await app.close();
});
