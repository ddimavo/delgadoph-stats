import { html } from '../../vendor/preact-htm.js';
import { useApi, state, num, money, delta, fmtDay } from '../lib.js';
import { Icon, Stat, Card, Skeleton, ErrorBox, BarChart, StackedBars, Donut, HeatBlock, HBars, Stars, STAR_COLORS, Person, Sparkline, Badge, Empty } from '../ui.js';

export function Dashboard() {
  const { data, error, reload } = useApi('/overview');
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${6} />`;
  const { forum, content, ads, payouts } = data;
  const kinds = state.meta.kinds, t = content.total;
  const unrated = t.published - t.rated;
  const series = Object.entries(kinds).map(([k, v]) => ({ key: k, label: v.label, color: v.color, values: content.byKind[k].weekly }));
  const dist = [5, 4, 3, 2, 1].map((s) => ({ node: html`<span class="stars" style="font-size:13px">${'★'.repeat(s)}<i>${'★'.repeat(5 - s)}</i></span>`, value: t.ratingDist[s - 1], color: STAR_COLORS[s - 1] }));
  const hello = new Date().getHours() < 6 ? 'Доброй ночи' : new Date().getHours() < 12 ? 'Доброе утро' : new Date().getHours() < 18 ? 'Добрый день' : 'Добрый вечер';
  return html`<div class="page-h"><div><h1>${hello}, ${state.user.nick.split('_')[0]}</h1><p>Сводка по форуму, публикациям и работе редакции.</p></div>
    <div class="actions"><a class="btn" href="/api/export.xlsx"><${Icon} name="download" size=${16} /> Выгрузить xlsx</a></div></div>
    <div class="grid g-kpi"><${Stat} label="Посты на форуме · 7 дней" value=${num(forum.week)} icon="forum" delta=${delta(forum.week, forum.weekPrev)} hint=${`${num(forum.total)} всего`} />
      <${Stat} label="Публикации · 30 дней" value=${num(t.last30)} icon="file" color="#a855f7" delta=${delta(t.last30, t.prev30)} hint=${`${num(t.published)} всего`} />
      <${Stat} label="Средняя оценка" value=${t.avgRating ?? '—'} icon="trend" color="#fbbf24" hint=${`оценено ${t.rated} из ${t.published}`}><div style="margin-top:4px"><${Stars} value=${Math.round(t.avgRating || 0)} size=${16} /></div><//>
      <${Stat} label="Правки объявлений · неделя" value=${num(ads.thisWeek)} icon="megaphone" color="#38bdf8" delta=${delta(ads.thisWeek, ads.prevWeek)} />
      <${Stat} label="Авторы форума · 30 дней" value=${num(forum.authors30)} icon="users" color="#34d399" hint=${`${forum.topics} тем`} />
      ${payouts ? html`<a href="#/payouts" style="color:inherit;text-decoration:none"><${Stat} label="К выплате · неделя" value=${money(payouts.total)} icon="money" color="#34d399" hint=${`${payouts.employees} сотрудн.`} /></a>` : html`<${Stat} label="Посты форума · 24 часа" value=${num(forum.day)} icon="forum" color="#34d399" />`}</div>
    ${unrated || content.overdue ? html`<div class="chips mt">${unrated ? html`<a class="chip" href="#/plan?view=list"><${Icon} name="alert" size=${13} /> Без оценки: ${unrated}</a>` : ''}${content.overdue ? html`<a class="chip" href="#/plan?view=list" style="color:var(--err)"><${Icon} name="alert" size=${13} /> Просрочено в плане: ${content.overdue}</a>` : ''}</div>` : ''}
    <div class="grid g-2 mt"><${Card} title="Публикации по неделям"><${StackedBars} labels=${content.labels} series=${series} /><//>
      <${Card} title="Активность форума по неделям"><${BarChart} values=${forum.weekly.values} labels=${forum.weekly.labels} unit=" постов" /><//></div>
    <div class="grid g-5 mt">${Object.keys(kinds).map((k) => { const b = content.byKind[k], v = kinds[k]; return html`<a href=${`#/section/${k}`} class="card stat" style=${`--c:${v.color};color:inherit;text-decoration:none`}>
      <div class="stat-top"><span class="stat-ic"><${Icon} name=${v.icon} /></span><span class="stat-label">${v.label}</span></div><div class="stat-val">${b.published}</div>
      <div class="stat-foot"><span class="muted">${b.last30} за 30 дн.</span>${b.avg ? html`<${Stars} value=${Math.round(b.avg)} size=${12} />` : ''}</div><div style="margin-top:8px"><${Sparkline} values=${b.weekly} color=${v.color} w=${180} h=${30} /></div></a>`; })}</div>
    <div class="grid g-3 mt"><${Card} title="Оценки качества"><div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;justify-content:center"><${Donut} values=${t.ratingDist} center=${t.avgRating ?? '—'} sub=${`${t.rated} оценок`} size=${150} /><div style="flex:1;min-width:150px"><${HBars} items=${dist} ranks=${false} empty="Оценок пока нет" /></div></div><//>
      <${Card} title="Когда пишут на форуме"><${HeatBlock} data=${forum.heatmap} /><//>
      <${Card} title="Лучшие сотрудники"><${HBars} items=${content.topEmployees.slice(0, 6).map((a) => ({ node: html`<${Person} nick=${a.nick} sub=${a.avg ? `оценка ${a.avg}` : 'без оценок'} />`, value: a.count, valueText: `${a.count} шт.` }))} empty="Назначьте ответственных в плане" /><//></div>
    <div class="grid g-3 mt"><${Card} title="Топ форума · 30 дней"><${HBars} items=${forum.topUsers.slice(0, 6).map((u) => ({ node: html`<${Person} nick=${u.nick} sub=${`${u.topics} тем`} />`, value: u.posts, valueText: `${u.posts}` }))} empty="Постов за период нет" /><//>
      <${Card} title="Самые активные темы"><${HBars} items=${forum.topTopics.map((s) => ({ node: html`<a href=${`#/forum/topic/${s.id}`}><b>${s.title}</b></a>`, value: s.score, valueText: s.score, sub: `${s.week} за 7 дн. · ${s.month} за 30 дн.` }))} max=${100} empty="Добавьте темы форума" /><//>
      <${Card} title="Недавно опубликовано">${content.recent.length ? html`<ul class="hbars">${content.recent.map((p) => { const k = kinds[p.kind] || kinds.other; return html`<li><${Badge} color=${k.color}>${k.single}<//><div class="hb-main"><b>${p.title}</b><div class="kmeta">${p.assignee ? html`<span>${p.assignee}</span>` : ''}<${Stars} value=${p.rating} size=${12} /><span>${fmtDay(p.planned_date)}</span></div></div></li>`; })}</ul>` : html`<${Empty} icon="file" title="Публикаций пока нет" />`}<//></div>
    ${content.upcoming.length ? html`<${Card} class="mt" title="Ближайшее в плане" action=${html`<a href="#/plan">Весь план →</a>`}><div class="grid g-3">${content.upcoming.map((p) => { const k = kinds[p.kind] || kinds.other; return html`<div class="kcard" style=${`--c:${k.color};cursor:default;margin:0`}><b>${p.title}</b><div class="kmeta"><${Badge} color=${k.color}>${k.single}<//><span>${fmtDay(p.planned_date)}</span>${p.assignee ? html`<span>${p.assignee}</span>` : ''}<span>${state.meta.statuses[p.status]}</span></div></div>`; })}</div><//>` : ''}`;
}
