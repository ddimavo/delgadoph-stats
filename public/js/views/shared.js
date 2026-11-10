import { html, useState } from '../../vendor/preact-htm.js';
import { api, useApi, state, canEdit, isAdmin, fail, toast, fmtDay, money, isImage, fileUrl, fmtSize } from '../lib.js';
import { Icon, Modal, Field, StarInput, Stars, Person, Badge } from '../ui.js';

/** Окно создания/редактирования публикации с вложениями. Для viewer — только просмотр. */
export function PlanModal({ plan, defaults = {}, onClose, onSaved }) {
  const { kinds, statuses, maxUploadBytes } = state.meta;
  const readOnly = !canEdit();
  const [f, setF] = useState({
    title: plan?.title ?? '', kind: plan?.kind ?? defaults.kind ?? 'situation', status: plan?.status ?? defaults.status ?? 'idea',
    planned_date: plan?.planned_date ?? defaults.planned_date ?? '', assignee: plan?.assignee ?? defaults.assignee ?? (canEdit() ? '' : ''),
    rating: plan?.rating ?? null, topic_id: plan?.topic_id ?? '', url: plan?.url ?? '', description: plan?.description ?? '', payout_override: plan?.payout_override ?? '',
  });
  const [files, setFiles] = useState(plan?.files ?? []);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const topics = useApi('/topics');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const upload = async (planId, list) => {
    if (!list.length) return;
    const form = new FormData();
    form.append('plan_id', planId);
    list.forEach((file) => form.append('file', file));
    await api('/files', { method: 'POST', form });
  };
  const save = async (e) => {
    e.preventDefault();
    const big = pending.find((x) => x.size > maxUploadBytes);
    if (big) return toast(`Файл «${big.name}» больше лимита ${fmtSize(maxUploadBytes)}`, 'err');
    setBusy(true);
    try {
      const body = { ...f, topic_id: f.topic_id || null, rating: f.rating || null };
      const res = plan ? await api(`/plans/${plan.id}`, { method: 'PUT', body }) : await api('/plans', { method: 'POST', body });
      await upload(plan ? plan.id : res.id, pending);
      toast(plan ? 'Сохранено' : 'Публикация добавлена');
      onSaved();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm('Удалить публикацию? Прикреплённые файлы останутся в хранилище.')) return;
    try { await api(`/plans/${plan.id}`, { method: 'DELETE' }); toast('Публикация удалена'); onSaved(); } catch (err) { fail(err); }
  };
  const dropFile = async (id) => {
    if (!confirm('Удалить файл?')) return;
    try { await api(`/files/${id}`, { method: 'DELETE' }); setFiles((a) => a.filter((x) => x.id !== id)); } catch (err) { fail(err); }
  };
  const autoNote = f.status === 'published'
    ? html`<div class="badge" style=${`--c:${kinds[f.kind].color};margin-bottom:12px`}><${Icon} name="trend" size=${14} /> Появится в разделе «${kinds[f.kind].label}» автоматически</div>` : '';

  return html`<${Modal} title=${plan ? (readOnly ? 'Публикация' : 'Редактирование публикации') : 'Новая публикация'} onClose=${onClose} wide
    footer=${readOnly ? html`<button class="btn" onClick=${onClose}>Закрыть</button>` : html`${plan ? html`<button class="btn danger" type="button" onClick=${remove} style="margin-right:auto"><${Icon} name="trash" size=${15} /> Удалить</button>` : ''}<button class="btn" type="button" onClick=${onClose}>Отмена</button><button class="btn primary" form="plan-form" disabled=${busy}>${busy ? 'Сохраняем…' : 'Сохранить'}</button>`}>
    ${autoNote}
    <form id="plan-form" onSubmit=${save}><fieldset disabled=${readOnly}><div class="form-grid">
      <${Field} label="Название" class="wide"><input value=${f.title} onInput=${set('title')} required maxlength="300" autofocus /><//>
      <${Field} label="Вид"><select value=${f.kind} onChange=${set('kind')}>${Object.entries(kinds).map(([k, v]) => html`<option value=${k}>${v.single}</option>`)}</select><//>
      <${Field} label="Статус"><select value=${f.status} onChange=${set('status')}>${Object.entries(statuses).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select><//>
      <${Field} label="Дата публикации"><input type="date" value=${f.planned_date} onInput=${set('planned_date')} /><//>
      <${Field} label="Ответственный (ник)"><input value=${f.assignee} onInput=${set('assignee')} maxlength="64" placeholder="Ник сотрудника" /><//>
      <${Field} label="Оценка качества" class="wide"><${StarInput} value=${f.rating} onChange=${(v) => !readOnly && setF((s) => ({ ...s, rating: v }))} /><//>
      <${Field} label="Краткое описание" class="wide" hint=${`${f.description.length} / 500`}><textarea value=${f.description} onInput=${set('description')} maxlength="500" rows="3" placeholder="О чём публикация, 1–2 предложения"></textarea><//>
      <${Field} label="Ссылка на публикацию"><input value=${f.url} onInput=${set('url')} placeholder="https://…" maxlength="500" inputmode="url" /><//>
      <${Field} label="Тема форума"><select value=${f.topic_id} onChange=${set('topic_id')}><option value="">—</option>${(topics.data?.topics || []).map((t) => html`<option value=${t.id}>${t.title}</option>`)}</select><//>
      ${isAdmin() && f.kind === 'event' ? html`<${Field} label="Сумма вручную, $" hint="100 000 – 500 000; пусто — по оценке"><input value=${f.payout_override} onInput=${set('payout_override')} inputmode="numeric" /><//>` : ''}
    </div></fieldset>
    <div class="field" style="margin-top:14px"><span>Файлы и скриншоты</span>
      ${files.length ? html`<div class="chips">${files.map((x) => html`<span class="chip" style="display:inline-flex;gap:8px;align-items:center">${isImage(x.mime) ? html`<img src=${fileUrl(x.id)} alt="" style="width:22px;height:22px;object-fit:cover;border-radius:5px" />` : html`<${Icon} name="clip" size=${14} />`}<a href=${fileUrl(x.id)} target="_blank" rel="noopener">${x.name}</a>${readOnly ? '' : html`<button type="button" class="icon-btn" style="width:22px;height:22px;border:0" onClick=${() => dropFile(x.id)} aria-label="Удалить файл"><${Icon} name="x" size=${13} /></button>`}</span>`)}</div>` : ''}
      ${readOnly ? '' : html`<input type="file" multiple onChange=${(e) => setPending([...e.target.files])} /><small class="muted">${pending.length ? `Будет загружено: ${pending.length}` : `До ${fmtSize(maxUploadBytes)} на файл`}</small>`}
    </div></form><//>`;
}

/** Хук: const [modal, open] = usePlanModal(reload); open(plan?, defaults?) */
export function usePlanModal(reload) {
  const [st, setSt] = useState(null);
  const modal = st ? html`<${PlanModal} plan=${st.plan} defaults=${st.defaults} onClose=${() => setSt(null)} onSaved=${() => { setSt(null); reload(); }} />` : null;
  return [modal, (plan, defaults) => setSt({ plan: plan || null, defaults: defaults || {} })];
}

export function PubCard({ p, onOpen }) {
  const k = state.meta.kinds[p.kind] || state.meta.kinds.other;
  const img = p.files.find((x) => isImage(x.mime));
  return html`<article class="pub" style=${`--c:${k.color}`} tabindex="0" role="button" onClick=${() => onOpen(p)} onKeyDown=${(e) => { if (e.key === 'Enter') onOpen(p); }}>
    <div class="pub-cover">${img ? html`<img src=${fileUrl(img.id)} loading="lazy" alt="" />` : html`<${Icon} name=${k.icon} size=${44} />`}</div>
    <div class="pub-b"><div class="pub-meta"><${Badge} color=${k.color}>${k.single}<//><${Stars} value=${p.rating} /></div>
      <h4>${p.title}</h4>${p.description ? html`<p>${p.description}</p>` : ''}
      <div class="pub-f">${p.assignee ? html`<${Person} nick=${p.assignee} />` : html`<span>Без ответственного</span>`}
        <span style="display:inline-flex;gap:10px;align-items:center;white-space:nowrap">${p.payout !== undefined ? html`<b style="color:var(--ok)">${money(p.payout)}</b>` : ''}${p.files.length ? html`<span><${Icon} name="clip" size=${13} /> ${p.files.length}</span>` : ''}${p.url ? html`<a href=${p.url} target="_blank" rel="noopener" onClick=${(e) => e.stopPropagation()} aria-label="Открыть публикацию"><${Icon} name="link" size=${14} /></a>` : ''}<span>${fmtDay(p.planned_date)}</span></span></div>
    </div></article>`;
}
