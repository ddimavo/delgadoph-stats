import { html, useState } from '../../vendor/preact-htm.js';
import { api, useApi, state, canEdit, fail, fmtDay, todayStr, setQuery } from '../lib.js';
import { Icon, Tabs, Card, Badge, Stars, Person, Skeleton, ErrorBox, Empty } from '../ui.js';
import { usePlanModal } from './shared.js';

const BOARD = ['idea', 'draft', 'ready', 'published'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function KCard({ p, onOpen }) {
  const k = state.meta.kinds[p.kind] || state.meta.kinds.other;
  const [drag, setDrag] = useState(false);
  const overdue = p.status !== 'published' && p.status !== 'cancelled' && p.planned_date && p.planned_date < todayStr();
  return html`<article class=${`kcard ${drag ? 'drag' : ''}`} style=${`--c:${k.color}`} draggable=${canEdit()} tabindex="0" onClick=${() => onOpen(p)} onKeyDown=${(e) => { if (e.key === 'Enter') onOpen(p); }}
    onDragStart=${(e) => { e.dataTransfer.setData('text/plain', String(p.id)); e.dataTransfer.effectAllowed = 'move'; setDrag(true); }} onDragEnd=${() => setDrag(false)}>
    <b>${p.title}</b><div class="kmeta"><${Badge} color=${k.color}>${k.single}<//>${p.rating ? html`<${Stars} value=${p.rating} size=${12} />` : ''}
      ${p.planned_date ? html`<span style=${overdue ? 'color:var(--err)' : ''}>${overdue ? '⚠ ' : ''}${fmtDay(p.planned_date)}</span>` : ''}${p.assignee ? html`<span>${p.assignee}</span>` : ''}${p.files.length ? html`<span><${Icon} name="clip" size=${12} /> ${p.files.length}</span>` : ''}</div></article>`;
}

function Column({ status, plans, onOpen, onDrop, onAdd }) {
  const [over, setOver] = useState(false);
  return html`<section class=${`col ${over ? 'over' : ''}`} onDragOver=${(e) => { if (canEdit()) { e.preventDefault(); setOver(true); } }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); onDrop(Number(e.dataTransfer.getData('text/plain')), status); }}>
    <div class="col-h"><span>${state.meta.statuses[status]} <span class="count">${plans.length}</span></span>${canEdit() ? html`<button class="icon-btn" style="width:28px;height:28px" onClick=${() => onAdd(status)} aria-label="Добавить"><${Icon} name="plus" size=${15} /></button>` : ''}</div>
    ${plans.map((p) => html`<${KCard} p=${p} onOpen=${onOpen} />`)}${plans.length ? '' : html`<p class="muted" style="text-align:center;padding:14px 0;font-size:13px">Пусто</p>`}</section>`;
}

function Calendar({ plans, month, onOpen, onAdd }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), lead = (first.getUTCDay() + 6) % 7, dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((lead + dim) / 7) * 7, today = todayStr();
  const by = {};
  for (const p of plans) if (p.planned_date) (by[p.planned_date] ||= []).push(p);
  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setQuery({ m: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` }); };
  return html`<${Card}><div class="actions" style="justify-content:space-between;margin-bottom:12px"><button class="icon-btn" onClick=${() => shift(-1)} aria-label="Назад"><${Icon} name="chevL" /></button><h3>${MONTHS[m - 1]} ${y}</h3><button class="icon-btn" onClick=${() => shift(1)} aria-label="Вперёд"><${Icon} name="chevR" /></button></div>
    <div class="cal">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => html`<div class="cal-h">${d}</div>`)}
    ${Array.from({ length: cells }, (_, i) => {
      const dn = i - lead + 1, inMonth = dn >= 1 && dn <= dim;
      const d = new Date(Date.UTC(y, m - 1, dn)), ds = d.toISOString().slice(0, 10);
      return html`<div class=${`day ${inMonth ? '' : 'dim'} ${ds === today ? 'today' : ''}`} role="button" tabindex="0" onClick=${() => canEdit() && onAdd(ds)}><span>${d.getUTCDate()}</span>
        ${(by[ds] || []).map((p) => html`<button class="ev" style=${`--c:${(state.meta.kinds[p.kind] || state.meta.kinds.other).color}`} onClick=${(e) => { e.stopPropagation(); onOpen(p); }} title=${p.title}>${p.title}</button>`)}</div>`;
    })}</div><//>`;
}

export function PlanPage({ query }) {
  const view = query.get('view') || 'board', kind = query.get('kind') || '', who = query.get('who') || '';
  const month = query.get('m') || todayStr().slice(0, 7);
  const [q, setQ] = useState('');
  const { data, error, reload } = useApi('/plans');
  const [modal, open] = usePlanModal(reload);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${4} />`;
  const kinds = state.meta.kinds, statuses = state.meta.statuses;
  const people = [...new Set(data.plans.map((p) => p.assignee).filter(Boolean))].sort();
  const plans = data.plans.filter((p) => (!kind || p.kind === kind) && (!who || p.assignee === who) && (!q || `${p.title} ${p.description}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (a.planned_date ?? '9999').localeCompare(b.planned_date ?? '9999') || a.id - b.id);
  const move = async (id, status) => {
    const p = data.plans.find((x) => x.id === id);
    if (!p || p.status === status) return;
    try { await api(`/plans/${id}/status`, { method: 'PATCH', body: { status } }); reload(); } catch (e) { fail(e); }
  };
  const showCancelled = query.get('c') === '1';
  const cols = showCancelled ? [...BOARD, 'cancelled'] : BOARD;
  const counts = { board: plans.length };
  return html`<div class="page-h"><div><h1>План публикаций</h1><p>Перетащите карточку в «Опубликовано» — она сама появится в нужном разделе сайта.</p></div>
    <div class="actions">${canEdit() ? html`<button class="btn primary" onClick=${() => open(null, {})}><${Icon} name="plus" size=${16} /> Публикация</button>` : ''}</div></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px">
      <${Tabs} value=${view} onChange=${(v) => setQuery({ view: v === 'board' ? '' : v })} items=${[['board', 'Доска'], ['list', 'Список'], ['calendar', 'Календарь']]} />
      <div class="chips"><button class=${`chip ${kind ? '' : 'on'}`} onClick=${() => setQuery({ kind: '' })}>Все виды</button>${Object.entries(kinds).map(([k, v]) => html`<button class=${`chip ${kind === k ? 'on' : ''}`} onClick=${() => setQuery({ kind: k })}>${v.single}</button>`)}</div>
      <select style="width:auto" value=${who} onChange=${(e) => setQuery({ who: e.target.value })} aria-label="Ответственный"><option value="">Все сотрудники</option>${people.map((x) => html`<option>${x}</option>`)}</select>
      <input style="width:200px" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Поиск…" aria-label="Поиск" /></div>
    ${view === 'board' ? html`<div class="board">${cols.map((s) => html`<${Column} status=${s} plans=${plans.filter((p) => p.status === s)} onOpen=${open} onDrop=${move} onAdd=${(st) => open(null, { status: st, kind: kind || undefined })} />`)}</div>
        <p style="margin-top:8px"><button class="chip" onClick=${() => setQuery({ c: showCancelled ? '' : '1' })}>${showCancelled ? 'Скрыть отменённые' : 'Показать отменённые'}</button></p>`
    : view === 'calendar' ? html`<${Calendar} plans=${plans} month=${month} onOpen=${open} onAdd=${(d) => open(null, { planned_date: d, kind: kind || undefined })} />${plans.some((p) => !p.planned_date) ? html`<${Card} class="mt" title="Без даты"><div class="chips">${plans.filter((p) => !p.planned_date).map((p) => html`<button class="chip" onClick=${() => open(p)}>${p.title}</button>`)}</div><//>` : ''}`
    : plans.length ? html`<${Card} pad=${false}><div class="table-wrap"><table><thead><tr><th>Дата</th><th>Публикация</th><th>Вид</th><th>Оценка</th><th>Ответственный</th><th>Статус</th></tr></thead><tbody>
      ${plans.map((p) => html`<tr style="cursor:pointer" onClick=${() => open(p)}><td>${fmtDay(p.planned_date)}</td><td><b>${p.title}</b>${p.description ? html`<div class="muted" style="max-width:420px;font-size:12.5px">${p.description}</div>` : ''}</td>
        <td><${Badge} color=${(kinds[p.kind] || kinds.other).color}>${(kinds[p.kind] || kinds.other).single}<//></td><td><${Stars} value=${p.rating} /></td><td>${p.assignee ? html`<${Person} nick=${p.assignee} />` : '—'}</td><td><${Badge} color=${{ published: '#34d399', ready: '#38bdf8', draft: '#fbbf24', cancelled: '#f87171' }[p.status]}>${statuses[p.status]}<//></td></tr>`)}</tbody></table></div><//>`
      : html`<${Card}><${Empty} icon="plan" title="Публикаций нет" hint="Измените фильтры или добавьте первую" /><//>`}
    ${modal}`;
}
