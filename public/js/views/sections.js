import { html, useState } from '../../vendor/preact-htm.js';
import { api, useApi, state, canEdit, fail, toast, num, delta, sum, fmtDay, shiftWeek } from '../lib.js';
import { Icon, Stat, Card, Tabs, Skeleton, ErrorBox, Empty, BarChart, HBars, Stars, STAR_COLORS, Person } from '../ui.js';
import { usePlanModal, PubCard } from './shared.js';

/** Раздел сайта по виду работ: сюда автоматически попадают опубликованные публикации этого вида. */
export function SectionPage({ params }) {
  const kind = params[0];
  const { data, error, loading, reload } = useApi(`/sections/${kind}`);
  const [tab, setTab] = useState('done');
  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('');
  const [modal, open] = usePlanModal(reload);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${4} />`;
  const { meta, stats, items, inProgress, weekLabels } = data;
  const list = (tab === 'done' ? items : inProgress).filter((p) => (!author || p.assignee.toLowerCase() === author.toLowerCase()) && (!q || `${p.title} ${p.description}`.toLowerCase().includes(q.toLowerCase())));
  const dist = [5, 4, 3, 2, 1].map((s) => ({ label: html`<span class="stars" style="font-size:13px">${'★'.repeat(s)}</span>`, node: html`<span class="stars" style="font-size:13px">${'★'.repeat(s)}<i>${'★'.repeat(5 - s)}</i></span>`, value: stats.ratingDist[s - 1], color: STAR_COLORS[s - 1] }));
  return html`<div class="page-h"><div><h1 style="display:flex;align-items:center;gap:12px"><span class="stat-ic" style=${`--c:${meta.color};width:40px;height:40px;background:color-mix(in srgb,${meta.color} 18%,transparent);color:${meta.color}`}><${Icon} name=${meta.icon} size=${22} /></span>${meta.label}</h1>
      <p>Опубликованное в плане попадает сюда автоматически: вид «${meta.single}», статус «Опубликовано».</p></div>
    <div class="actions">${canEdit() ? html`<button class="btn primary" onClick=${() => open(null, { kind, status: 'draft' })}><${Icon} name="plus" size=${16} /> Добавить</button>` : ''}<a class="btn" href="#/plan?kind=${kind}">В плане</a></div></div>
    <div class="grid g-4"><${Stat} label="Опубликовано" value=${num(stats.published)} icon=${meta.icon} color=${meta.color} hint="за всё время" />
      <${Stat} label="За 30 дней" value=${num(stats.last30)} icon="calendar" color=${meta.color} delta=${delta(stats.last30, stats.prev30)} hint="к предыдущим 30" />
      <${Stat} label="Средняя оценка" value=${stats.avgRating ?? '—'} icon="trend" color="#fbbf24" hint=${`оценено ${stats.rated} из ${stats.published}`}><div style="margin-top:4px"><${Stars} value=${Math.round(stats.avgRating || 0)} size=${16} /></div><//>
      <${Stat} label="Авторов" value=${num(stats.authors.length)} icon="users" color=${meta.color} hint="участвовали в публикациях" /></div>
    <${Card} class="mt" title="Публикации по неделям"><${BarChart} values=${stats.weekly} labels=${weekLabels} color=${meta.color} unit=" шт." /><//>
    <div class="grid g-2 mt"><${Card} title="Распределение оценок"><${HBars} items=${dist} ranks=${false} empty="Оценок пока нет" /><//>
      <${Card} title="Лидеры раздела"><${HBars} items=${stats.authors.slice(0, 6).map((a) => ({ node: html`<${Person} nick=${a.nick} sub=${a.avg ? `средняя оценка ${a.avg}` : 'без оценок'} />`, value: a.count, valueText: `${a.count} шт.`, color: meta.color }))} empty="Пока нет публикаций с ответственным" /><//></div>
    <div class="mt" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:14px"><${Tabs} value=${tab} onChange=${setTab} items=${[['done', 'Опубликовано', items.length], ['wip', 'В работе', inProgress.length]]} />
      <input style="width:220px;margin-left:auto" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Поиск по названию…" aria-label="Поиск" />
      <select style="width:auto" value=${author} onChange=${(e) => setAuthor(e.target.value)} aria-label="Автор"><option value="">Все авторы</option>${stats.authors.map((a) => html`<option>${a.nick}</option>`)}</select></div>
    ${list.length ? html`<div class="pub-grid">${list.map((p) => html`<${PubCard} p=${p} onOpen=${(x) => open(x)} />`)}</div>`
      : html`<${Card}><${Empty} icon=${meta.icon} title=${tab === 'done' ? 'Здесь пока пусто' : 'Нет работ в процессе'} hint=${tab === 'done' ? 'Опубликованные публикации этого вида появятся автоматически' : 'Добавьте публикацию в план'} /><//>`}
    ${modal}`;
}

/** Объявления: число правок вводится вручную по неделям. */
export function AdsPage({ query }) {
  const week = query.get('week') || '';
  const { data, error, reload } = useApi(`/ads${week ? `?week=${week}` : ''}`);
  const [emp, setEmp] = useState('');
  const [cnt, setCnt] = useState('');
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${4} />`;
  const go = (w) => { location.hash = `#/ads?week=${w}`; };
  const idx = data.weekly.labels.indexOf(data.week);
  const total = sum(data.entries.map((e) => e.count));
  const prevTotal = idx > 0 ? data.weekly.values[idx - 1] : 0;
  const save = async (employee, count) => {
    try { await api('/ads', { method: 'PUT', body: { week: data.week, employee, count } }); toast('Сохранено'); reload(); return true; } catch (e) { fail(e); return false; }
  };
  const add = async (e) => { e.preventDefault(); if (await save(emp, cnt)) { setEmp(''); setCnt(''); } };
  const del = async (employee) => {
    if (!confirm(`Убрать запись «${employee}» за эту неделю?`)) return;
    try { await api(`/ads?week=${data.week}&employee=${encodeURIComponent(employee)}`, { method: 'DELETE' }); reload(); } catch (e) { fail(e); }
  };
  const total12 = sum(data.weekly.values);
  return html`<div class="page-h"><div><h1 style="display:flex;align-items:center;gap:12px"><span class="stat-ic" style="width:40px;height:40px;--c:#38bdf8"><${Icon} name="megaphone" size=${22} /></span>Объявления</h1><p>Правки объявлений за неделю вносятся вручную — от них зависят выплаты.</p></div></div>
    <div class="grid g-4"><${Stat} label=${`Неделя ${fmtDay(data.week)}`} value=${num(total)} icon="megaphone" color="#38bdf8" delta=${delta(total, prevTotal)} hint="правок" />
      <${Stat} label="За 12 недель" value=${num(total12)} icon="trend" color="#38bdf8" hint=${`в среднем ${num(Math.round(total12 / 12))} в неделю`} />
      <${Stat} label="Сотрудников" value=${num(data.leaders.length)} icon="users" color="#38bdf8" hint="вносили правки" />
      <${Stat} label="Лучший за 12 недель" value=${data.leaders[0]?.employee ?? '—'} icon="trend" color="#fbbf24" hint=${data.leaders[0] ? `${num(data.leaders[0].total)} правок` : ''} /></div>
    <div class="grid g-main mt"><${Card} title="Правки по неделям"><${BarChart} values=${data.weekly.values} labels=${data.weekly.labels} color="#38bdf8" unit=" правок" /><//>
      <${Card} title="Лидеры (12 недель)"><${HBars} items=${data.leaders.slice(0, 6).map((l) => ({ node: html`<${Person} nick=${l.employee} sub=${`${l.weeks} нед.`} />`, value: l.total, valueText: num(l.total), color: '#38bdf8' }))} /><//></div>
    <${Card} class="mt" title="Записи за неделю" action=${html`<div class="actions"><button class="icon-btn" onClick=${() => go(shiftWeek(data.week, -1))} aria-label="Предыдущая неделя"><${Icon} name="chevL" /></button><b>${fmtDay(data.week)} — ${fmtDay(shiftWeek(data.week, 6))}</b><button class="icon-btn" onClick=${() => go(shiftWeek(data.week, 1))} aria-label="Следующая неделя"><${Icon} name="chevR" /></button>${data.week !== data.currentWeek ? html`<button class="btn sm" onClick=${() => go(data.currentWeek)}>Текущая</button>` : ''}</div>`} pad=${false}>
      ${data.entries.length ? html`<div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th class="r">Правок</th><th></th></tr></thead><tbody>${data.entries.map((e) => html`<${AdRow} e=${e} save=${save} del=${del} />`)}</tbody></table></div>` : html`<${Empty} icon="megaphone" title="За эту неделю записей нет" hint="Добавьте первую ниже" />`}
      ${canEdit() ? html`<form class="form-grid" style="padding:16px 18px;border-top:1px solid var(--line);align-items:end" onSubmit=${add}><label class="field"><span>Сотрудник</span><input list="emps" value=${emp} onInput=${(e) => setEmp(e.target.value)} required maxlength="64" placeholder="Ник" /><datalist id="emps">${data.employees.map((x) => html`<option value=${x}></option>`)}</datalist></label>
        <label class="field"><span>Отредактировано объявлений</span><input type="number" min="0" max="100000" value=${cnt} onInput=${(e) => setCnt(e.target.value)} required /></label><button class="btn primary" style="justify-content:center"><${Icon} name="plus" size=${16} /> Добавить / обновить</button></form>` : ''}<//>`;
}

function AdRow({ e, save, del }) {
  const [v, setV] = useState(String(e.count));
  const dirty = v !== String(e.count);
  return html`<tr><td><${Person} nick=${e.employee} /></td><td class="r">${canEdit() ? html`<input type="number" min="0" value=${v} onInput=${(x) => setV(x.target.value)} style="width:110px;text-align:right" aria-label="Правок" />` : e.count}</td>
    <td class="r">${canEdit() ? html`<button class="btn sm" disabled=${!dirty} onClick=${() => save(e.employee, v)}>Сохранить</button> <button class="icon-btn" onClick=${() => del(e.employee)} aria-label="Удалить"><${Icon} name="trash" size=${15} /></button>` : ''}</td></tr>`;
}
