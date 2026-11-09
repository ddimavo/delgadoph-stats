import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { api, useApi, state, fail, toast, money, num, fmtDay } from '../lib.js';
import { Icon, Stat, Card, Skeleton, ErrorBox, Empty, Person, Stars, Badge, Field } from '../ui.js';

export function PayoutsPage({ query }) {
  const week = query.get('week') || '';
  const { data, error, reload } = useApi(`/payouts${week ? `?week=${week}` : ''}`);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${3} />`;
  const go = (w) => { location.hash = `#/payouts?week=${w}`; };
  const kinds = state.meta.kinds;
  const dash = (n) => (n ? money(n) : html`<span class="muted">—</span>`);
  return html`<div class="page-h"><div><h1>Выплаты за неделю</h1><p>Считается по опубликованным работам с оценкой и по правкам объявлений. Неделя — с понедельника по воскресенье.</p></div>
    <div class="actions"><a class="btn" href="#/payouts/rates"><${Icon} name="edit" size=${16} /> Расценки</a><a class="btn" href=${`/api/export.xlsx?week=${data.start}`}><${Icon} name="download" size=${16} /> xlsx</a></div></div>
    <div class="actions" style="margin-bottom:16px"><button class="icon-btn" onClick=${() => go(data.prev)} aria-label="Предыдущая неделя"><${Icon} name="chevL" /></button><b>${fmtDay(data.start)} — ${fmtDay(data.end)}</b><button class="icon-btn" onClick=${() => go(data.next)} aria-label="Следующая неделя"><${Icon} name="chevR" /></button>${data.start !== data.currentWeek ? html`<button class="btn sm" onClick=${() => go(data.currentWeek)}>Текущая неделя</button>` : ''}</div>
    <div class="grid g-4"><${Stat} label="К выплате" value=${money(data.total)} icon="money" color="#34d399" /><${Stat} label="Сотрудников" value=${num(data.rows.length)} icon="users" color="#38bdf8" />
      <${Stat} label="Не учтено" value=${num(data.skipped.length)} icon="alert" color=${data.skipped.length ? '#fbbf24' : '#34d399'} hint="публикации без ответственного или не опубликованные" /></div>
    <${Card} class="mt" title="Начисления" pad=${false}>${data.rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th class="r">Ситуации</th><th class="r">Мероприятия</th><th class="r">Эфиры</th><th class="r">Правок</th><th class="r">Объявления</th><th class="r">Бонус</th><th class="r">Итого</th></tr></thead><tbody>
      ${data.rows.map((e) => html`<tr><td style="min-width:220px"><${Person} nick=${e.nick} />${e.notes.map((n) => html`<div style="color:var(--warn);font-size:12px;margin-top:3px">⚠ ${n}</div>`)}
        ${e.items.length ? html`<details style="margin-top:4px"><summary>Публикации (${e.items.length})</summary>${e.items.map((i) => html`<div style="font-size:12.5px;padding:3px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="muted">${fmtDay(i.plan.planned_date)}</span><${Badge} color=${kinds[i.plan.kind]?.color}>${kinds[i.plan.kind]?.single}<//><span>${i.plan.title}</span><${Stars} value=${i.plan.rating} size=${12} /><b>${money(i.amount)}</b>${i.note ? html`<span class="muted">(${i.note})</span>` : ''}</div>`)}</details>` : ''}</td>
        <td class="r">${dash(e.situation)}</td><td class="r">${dash(e.event)}</td><td class="r">${dash(e.radio)}</td><td class="r">${e.adCount || '—'}</td><td class="r">${dash(e.adPaid)}</td><td class="r">${dash(e.adBonus)}</td><td class="r"><b>${money(e.total)}</b></td></tr>`)}</tbody></table></div>`
      : html`<${Empty} icon="money" title="За эту неделю начислений нет" hint="Опубликуйте работы в плане и внесите правки объявлений" />`}<//>
    ${data.skipped.length ? html`<${Card} class="mt" title="Не учтено" pad=${false}><div class="table-wrap"><table><tbody>${data.skipped.map((x) => html`<tr><td class="muted">${fmtDay(x.plan.planned_date)}</td><td>${kinds[x.plan.kind]?.single}: <b>${x.plan.title}</b></td><td class="muted">${x.why}</td></tr>`)}</tbody></table></div><//>` : ''}
    <p class="muted mt">Правки объявлений вносятся на странице <a href=${`#/ads?week=${data.start}`}>«Объявления»</a>.</p>`;
}

const flatten = (r) => {
  const o = {};
  [1, 2, 3, 4, 5].forEach((n) => { o[`sit_${n}`] = r.situation.stars[n]; o[`ev_${n}`] = r.event.stars[n]; });
  return Object.assign(o, { sit_cap: r.situation.weekCap, ad_rate: r.ads.rate, ad_bonus: r.ads.bonus, ad_bonus_after: r.ads.bonusAfter, ad_limit: r.ads.paidLimit,
    ev_min: r.event.min, ev_max: r.event.max, ev_cap: r.event.weekCap, radio_rate: r.radio.rate, radio_min_stars: r.radio.minStars, radio_cap: r.radio.weekCap });
};

export function RatesPage() {
  const { data, error, reload } = useApi('/payouts/rates');
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setF(flatten(data.rates)); }, [data]);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!f) return html`<${Skeleton} rows=${3} />`;
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const N = (k, label, hint) => html`<${Field} label=${label} hint=${hint}><input value=${f[k]} onInput=${set(k)} inputmode="numeric" required /><//>`;
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api('/payouts/rates', { method: 'PUT', body: f }); toast('Расценки сохранены'); reload(); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!confirm('Вернуть расценки по умолчанию?')) return;
    try { await api('/payouts/rates/reset', { method: 'POST', body: {} }); toast('Сброшено'); reload(); } catch (err) { fail(err); }
  };
  const stars = (p) => [1, 2, 3, 4, 5].map((n) => N(`${p}_${n}`, `${n} ★`));
  return html`<p><a href="#/payouts">← Выплаты</a></p><div class="page-h"><div><h1>Расценки и лимиты</h1><p>Расчёт всегда идёт по текущим расценкам, в том числе для прошлых недель.</p></div></div>
    <form onSubmit=${save} class="stack">
      <${Card} title="Скриншот-ситуации (за одну, по оценке)"><div class="form-grid">${stars('sit')}${N('sit_cap', 'Лимит в неделю на сотрудника, $')}</div><//>
      <${Card} title="Редактирование объявлений"><div class="form-grid">${N('ad_rate', 'За объявление, $')}${N('ad_bonus', 'Бонус, $', 'выплачивается раз в неделю')}${N('ad_bonus_after', 'Бонус, если правок больше')}${N('ad_limit', 'Оплачивается не более, объявл./нед.')}</div><//>
      <${Card} title="Мероприятия (за одно, по оценке)"><div class="form-grid">${stars('ev')}${N('ev_min', 'Минимум, $')}${N('ev_max', 'Максимум, $')}${N('ev_cap', 'Лимит в неделю, $')}</div><//>
      <${Card} title="Радиоэфиры"><div class="form-grid">${N('radio_rate', 'За качественный эфир, $')}${N('radio_min_stars', 'Качественный — от скольки звёзд')}${N('radio_cap', 'Лимит в неделю, $')}</div><//>
      <div class="actions"><button class="btn primary" disabled=${busy}>Сохранить расценки</button><button type="button" class="btn danger" onClick=${reset}>Сбросить к умолчанию</button></div></form>`;
}
