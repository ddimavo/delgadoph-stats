// Расценки и расчёт недельных выплат сотрудникам.
const STARS = [1, 2, 3, 4, 5];

export const DEFAULT_RATES = {
  situation: { stars: { 1: 0, 2: 25000, 3: 50000, 4: 75000, 5: 100000 }, weekCap: 300000 },
  ads: { rate: 500, bonus: 50000, bonusAfter: 100, paidLimit: 300 },
  event: { stars: { 1: 100000, 2: 200000, 3: 300000, 4: 400000, 5: 500000 }, min: 100000, max: 500000, weekCap: 1000000 },
  radio: { rate: 30000, minStars: 3, weekCap: 500000 },
};

export function loadRates(db) {
  try {
    const saved = JSON.parse(db.getSetting('rates') || '{}');
    const out = structuredClone(DEFAULT_RATES);
    for (const k of Object.keys(out)) {
      for (const f of Object.keys(out[k])) {
        if (f === 'stars') for (const s of STARS) { if (Number.isFinite(saved[k]?.stars?.[s])) out[k].stars[s] = saved[k].stars[s]; }
        else if (Number.isFinite(saved[k]?.[f])) out[k][f] = saved[k][f];
      }
    }
    return out;
  } catch { return structuredClone(DEFAULT_RATES); }
}

/** Разбор формы расценок. Возвращает { rates } или { error }. */
export function parseRatesForm(b) {
  const int = (name) => {
    const v = String(b?.[name] ?? '').replace(/[\s_.]/g, '');
    if (!/^\d{1,9}$/.test(v)) throw new Error(`Поле «${name}» должно быть целым неотрицательным числом`);
    return Number(v);
  };
  try {
    const r = {
      situation: { stars: Object.fromEntries(STARS.map((s) => [s, int(`sit_${s}`)])), weekCap: int('sit_cap') },
      ads: { rate: int('ad_rate'), bonus: int('ad_bonus'), bonusAfter: int('ad_bonus_after'), paidLimit: int('ad_limit') },
      event: { stars: Object.fromEntries(STARS.map((s) => [s, int(`ev_${s}`)])), min: int('ev_min'), max: int('ev_max'), weekCap: int('ev_cap') },
      radio: { rate: int('radio_rate'), minStars: int('radio_min_stars'), weekCap: int('radio_cap') },
    };
    if (r.event.min > r.event.max) return { error: 'Минимум за мероприятие больше максимума' };
    if (r.radio.minStars < 1 || r.radio.minStars > 5) return { error: 'Порог для радиоэфира — от 1 до 5 звёзд' };
    return { rates: r };
  } catch (e) { return { error: e.message }; }
}

const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Понедельник недели, в которую попадает дата YYYY-MM-DD. */
export function weekStart(dateStr) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return iso(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY);
}
export const weekEnd = (start) => iso(Date.parse(`${start}T00:00:00Z`) + 6 * DAY);
export const shiftWeek = (start, n) => iso(Date.parse(`${start}T00:00:00Z`) + n * 7 * DAY);

/** Сумма за одну публикацию. Возвращает { amount, note }. */
export function itemAmount(plan, rates) {
  const r = plan.rating;
  if (!r) return { amount: 0, note: 'нет оценки' };
  if (plan.kind === 'situation') return { amount: rates.situation.stars[r], note: '' };
  if (plan.kind === 'event') {
    const base = plan.payout_override ?? rates.event.stars[r];
    const amount = Math.min(rates.event.max, Math.max(rates.event.min, base));
    return { amount, note: plan.payout_override != null ? 'сумма вручную' : '' };
  }
  if (plan.kind === 'radio') return r >= rates.radio.minStars ? { amount: rates.radio.rate, note: '' } : { amount: 0, note: `оценка ниже ${rates.radio.minStars}★` };
  return { amount: 0, note: '' };
}

/** Расчёт выплат за неделю (понедельник–воскресенье). */
export function calcWeek(db, rates, start) {
  const end = weekEnd(start);
  const plans = db.prepare(`SELECT * FROM plans WHERE planned_date BETWEEN ? AND ? AND kind IN ('situation','event','radio') AND status != 'cancelled' ORDER BY planned_date, id`).all(start, end);
  const ads = db.prepare('SELECT employee, count FROM ad_edits WHERE week_start = ?').all(start);
  const people = new Map();
  const person = (nick) => {
    const k = nick.toLowerCase();
    if (!people.has(k)) people.set(k, { nick, items: [], situation: 0, event: 0, radio: 0, adCount: 0, adPaid: 0, adBonus: 0, notes: [] });
    return people.get(k);
  };
  const skipped = [];
  for (const p of plans) {
    if (!p.assignee) { skipped.push({ plan: p, why: 'нет ответственного' }); continue; }
    if (p.status !== 'published') { skipped.push({ plan: p, why: 'ещё не опубликовано' }); continue; }
    const e = person(p.assignee);
    const { amount, note } = itemAmount(p, rates);
    e.items.push({ plan: p, amount, note });
    e[p.kind] += amount;
  }
  for (const a of ads) {
    const e = person(a.employee);
    e.adCount = a.count;
    e.adPaid = Math.min(a.count, rates.ads.paidLimit) * rates.ads.rate;
    e.adBonus = a.count > rates.ads.bonusAfter ? rates.ads.bonus : 0;
    if (a.count > rates.ads.paidLimit) e.notes.push(`объявления: оплачено ${rates.ads.paidLimit} из ${a.count}`);
  }
  const rows = [...people.values()].sort((a, b) => a.nick.localeCompare(b.nick));
  for (const e of rows) {
    for (const k of ['situation', 'event', 'radio']) {
      const cap = rates[k].weekCap;
      e[`${k}Raw`] = e[k];
      if (e[k] > cap) { e.notes.push(`${PLAN_LABEL[k]}: лимит ${cap.toLocaleString('ru-RU')} $ (набрано ${e[k].toLocaleString('ru-RU')} $)`); e[k] = cap; }
    }
    e.total = e.situation + e.event + e.radio + e.adPaid + e.adBonus;
  }
  return { start, end, rows, skipped, total: rows.reduce((s, e) => s + e.total, 0) };
}
const PLAN_LABEL = { situation: 'ситуации', event: 'мероприятия', radio: 'эфиры' };
