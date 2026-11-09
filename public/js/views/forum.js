import { html, useState } from '../../vendor/preact-htm.js';
import { api, useApi, canEdit, fail, toast, num, delta, ago, fmtDateTime, fmtDay, setQuery } from '../lib.js';
import { Icon, Stat, Card, Tabs, Modal, Field, Skeleton, ErrorBox, Empty, BarChart, HeatBlock, HBars, Sparkline, ScoreRing, Person } from '../ui.js';

function TopicModal({ topic, onClose, onSaved }) {
  const [f, setF] = useState({ title: topic?.title ?? '', url: topic?.url ?? '', author: topic?.author ?? '', created_at: (topic?.created_at ?? '').slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = topic ? await api(`/forum/topics/${topic.id}`, { method: 'PUT', body: f }) : await api('/forum/topics', { method: 'POST', body: f });
      toast(topic ? 'Сохранено' : 'Тема добавлена'); onSaved(r);
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${topic ? 'Настройки темы' : 'Новая тема форума'} onClose=${onClose} footer=${html`<button class="btn" type="button" onClick=${onClose}>Отмена</button><button class="btn primary" form="topic-form" disabled=${busy}>Сохранить</button>`}>
    <form id="topic-form" onSubmit=${save}><div class="form-grid"><${Field} label="Название темы" class="wide"><input value=${f.title} onInput=${set('title')} required maxlength="300" autofocus /><//>
      <${Field} label="Ссылка на тему форума" class="wide"><input value=${f.url} onInput=${set('url')} placeholder="https://…" inputmode="url" /><//>
      <${Field} label="Автор темы"><input value=${f.author} onInput=${set('author')} maxlength="64" /><//><${Field} label="Создана"><input type="date" value=${f.created_at} onInput=${set('created_at')} /><//></div></form><//>`;
}

export function ForumPage({ query }) {
  const tab = query.get('tab') || 'topics';
  const { data, error, reload } = useApi('/forum');
  const [modal, setModal] = useState(false);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${4} />`;
  const { summary: s, topics } = data;
  const sorted = [...topics].sort((a, b) => b.score - a.score || b.total - a.total);
  return html`<div class="page-h"><div><h1>Статистика форума</h1><p>Посты по темам, активность и самые активные пользователи. Данные вносятся вручную.</p></div>
    <div class="actions"><a class="btn" href="/api/export.xlsx"><${Icon} name="download" size=${16} /> xlsx</a>${canEdit() ? html`<button class="btn primary" onClick=${() => setModal(true)}><${Icon} name="plus" size=${16} /> Тема</button>` : ''}</div></div>
    <div class="grid g-4"><${Stat} label="Постов всего" value=${num(s.total)} icon="forum" hint=${`в ${s.topics} темах`} />
      <${Stat} label="За 7 дней" value=${num(s.week)} icon="trend" delta=${delta(s.week, s.weekPrev)} hint="к предыдущей неделе" />
      <${Stat} label="За 30 дней" value=${num(s.month)} icon="calendar" color="#38bdf8" delta=${delta(s.month, s.monthPrev)} hint="к предыдущим 30" />
      <${Stat} label="За 24 часа" value=${num(s.day)} icon="forum" color="#34d399" /></div>
    <div class="grid g-main mt"><${Card} title="Посты по неделям"><${BarChart} values=${data.weekly.values} labels=${data.weekly.labels} unit=" постов" /><//>
      <${Card} title="Когда пишут (90 дней)"><${HeatBlock} data=${data.heatmap} /><//></div>
    <div class="mt" style="margin-bottom:14px"><${Tabs} value=${tab} onChange=${(t) => setQuery({ tab: t === 'topics' ? '' : t })} items=${[['topics', 'Темы', topics.length], ['users', 'Пользователи']]} /></div>
    ${tab === 'users' ? html`<${ForumUsers} />` : sorted.length ? html`<${Card} pad=${false}><div class="table-wrap"><table><thead><tr><th>Тема</th><th class="r">Всего</th><th class="r">24ч</th><th class="r">7д</th><th class="r">30д</th><th class="r">Авторов</th><th>30 дней</th><th>Последний пост</th><th>Активность</th></tr></thead>
      <tbody>${sorted.map((t) => html`<tr><td><a href=${`#/forum/topic/${t.id}`}><b>${t.title}</b></a></td><td class="r">${num(t.total)}</td><td class="r">${t.day}</td><td class="r">${t.week}</td><td class="r">${t.month}</td><td class="r">${t.authors30}</td>
        <td><${Sparkline} values=${t.perDay} /></td><td class="muted" title=${fmtDateTime(t.last)}>${t.last ? ago(t.last) : '—'}</td><td><${ScoreRing} value=${t.score} /></td></tr>`)}</tbody></table></div><//>
      <p class="muted" style="margin-top:10px">Активность = 0,5 × посты за 7 дней + 0,3 × посты за 30 дней + 2 × уникальные авторы за 30 дней, нормировано к 0–100 по самой активной теме.</p>`
      : html`<${Card}><${Empty} icon="forum" title="Тем пока нет" hint="Добавьте тему форума и внесите её посты">${canEdit() ? html`<button class="btn primary" onClick=${() => setModal(true)}>Добавить тему</button>` : ''}<//><//>`}
    ${modal ? html`<${TopicModal} onClose=${() => setModal(false)} onSaved=${(r) => { setModal(false); location.hash = `#/forum/topic/${r.id}`; }} />` : ''}`;
}

function ForumUsers() {
  const [period, setPeriod] = useState('30');
  const { data, error, reload } = useApi(`/forum/users?period=${period}`);
  return html`<${Card} title="Самые активные пользователи" action=${html`<${Tabs} value=${period} onChange=${setPeriod} items=${[['7', '7 дней'], ['30', '30 дней'], ['all', 'Всё время']]} />`}>
    ${error ? html`<${ErrorBox} error=${error} retry=${reload} />` : !data ? html`<div class="skel" style="height:200px"></div>` : html`<${HBars} items=${data.users.slice(0, 25).map((u) => ({ node: html`<${Person} nick=${u.nick} sub=${`${u.topics} тем · последний ${ago(u.last)}`} />`, value: u.posts, valueText: `${u.posts} пост.` }))} empty="Постов за период нет" />`}<//>`;
}

export function TopicPage({ params }) {
  const id = params[0];
  const { data: t, error, reload } = useApi(`/forum/topics/${id}`);
  const [text, setText] = useState('');
  const [errs, setErrs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!t) return html`<${Skeleton} rows=${4} />`;
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErrs(null);
    try { const r = await api(`/forum/topics/${id}/posts`, { method: 'POST', body: { text } }); toast(`Добавлено: ${r.added}${r.skipped ? `, уже были: ${r.skipped}` : ''}`); setText(''); reload(); }
    catch (err) { setErrs(err.details || [err.message]); fail(err); } finally { setBusy(false); }
  };
  const delPost = async (pid) => { try { await api(`/forum/topics/${id}/posts/${pid}`, { method: 'DELETE' }); reload(); } catch (e) { fail(e); } };
  const delTopic = async () => {
    if (!confirm('Удалить тему вместе со всеми постами?')) return;
    try { await api(`/forum/topics/${id}`, { method: 'DELETE' }); toast('Тема удалена'); location.hash = '#/forum'; } catch (e) { fail(e); }
  };
  return html`<p><a href="#/forum">← Статистика форума</a></p><div class="page-h"><div><h1>${t.title}</h1><p>Автор темы: ${t.author || '—'} · создана ${fmtDay((t.created_at || '').slice(0, 10))} · данные внесены ${t.synced_at ? ago(t.synced_at) : '—'}${t.url ? html` · <a href=${t.url} target="_blank" rel="noopener">открыть на форуме</a>` : ''}</p></div>
    ${canEdit() ? html`<div class="actions"><button class="btn" onClick=${() => setEdit(true)}><${Icon} name="edit" size=${16} /> Настройки</button><button class="btn danger" onClick=${delTopic}><${Icon} name="trash" size=${16} /></button></div>` : ''}</div>
    <div class="grid g-4"><${Stat} label="Активность" value=${t.score} icon="trend" hint="из 100" /><${Stat} label="Всего постов" value=${num(t.total)} icon="forum" color="#38bdf8" />
      <${Stat} label="7 дней" value=${num(t.week)} icon="calendar" delta=${delta(t.week, t.weekPrev)} /><${Stat} label="30 дней" value=${num(t.month)} icon="calendar" color="#34d399" hint=${`${t.authors30} авторов`} /></div>
    <div class="grid g-2 mt"><${Card} title="Посты по дням (30 дней)"><${BarChart} values=${t.perDay} labels=${t.days} /><//><${Card} title="Посты по часам суток"><${BarChart} values=${t.perHour} labels=${t.perHour.map((_, h) => `${h}`)} color="#38bdf8" /><//></div>
    ${canEdit() ? html`<${Card} class="mt" title="Внести посты"><form onSubmit=${submit}><label class="field"><span>Одна строка — один пост: <code>ДД.ММ.ГГГГ ЧЧ:ММ Ник</code>. Повторно внесённые посты пропускаются.</span>
      <textarea rows="6" value=${text} onInput=${(e) => setText(e.target.value)} required placeholder=${'08.11.2026 22:58 Brianna_Delgado\n07.11.2026 17:16 Richard_Northwood'}></textarea></label>
      ${errs ? html`<ul class="errlist">${errs.map((x) => html`<li>${x}</li>`)}</ul>` : ''}<div style="margin-top:12px"><button class="btn primary" disabled=${busy}>${busy ? 'Вносим…' : 'Внести'}</button></div></form><//>` : ''}
    <div class="grid g-2 mt"><${Card} title="Авторы"><${HBars} items=${t.topAuthors.slice(0, 12).map((a) => ({ node: html`<${Person} nick=${a.nick} sub=${`последний ${ago(a.last)}`} />`, value: a.count, valueText: `${a.count}` }))} empty="Ответов пока нет" /><//>
      <${Card} title="Последние посты" pad=${false}>${t.recent.length ? html`<div class="table-wrap" style="max-height:420px;overflow-y:auto"><table><tbody>${t.recent.map((p) => html`<tr><td class="muted">${fmtDateTime(p.posted_at)}</td><td><b>${p.author}</b></td><td class="r">${canEdit() ? html`<button class="icon-btn" onClick=${() => delPost(p.id)} aria-label="Удалить пост"><${Icon} name="trash" size=${15} /></button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<${Empty} icon="forum" title="Ответов нет" />`}<//></div>
    ${edit ? html`<${TopicModal} topic=${t} onClose=${() => setEdit(false)} onSaved=${() => { setEdit(false); reload(); }} />` : ''}`;
}
