import { html, useState, useRef } from '../../vendor/preact-htm.js';
import { api, useApi, state, canEdit, fail, toast, fmtSize, fmtDateTime, isImage, fileUrl, num } from '../lib.js';
import { Icon, Stat, Card, Modal, Skeleton, ErrorBox, Empty } from '../ui.js';

export function FilesPage({ query }) {
  const folder = query.get('folder');
  const { data, error, reload } = useApi(`/files${folder ? `?folder=${folder}` : ''}`);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const input = useRef();
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${3} />`;
  const go = (id) => { location.hash = `#/files${id && id !== data.trail[0].id ? `?folder=${id}` : ''}`; };
  const upload = async (list) => {
    list = [...list];
    if (!list.length) return;
    const big = list.find((f) => f.size > state.meta.maxUploadBytes);
    if (big) return toast(`Файл «${big.name}» больше лимита ${fmtSize(state.meta.maxUploadBytes)}`, 'err');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('folder_id', data.folder.id);
      list.forEach((f) => form.append('file', f));
      const r = await api('/files', { method: 'POST', form });
      toast(`Загружено файлов: ${r.files.length}`); reload();
    } catch (e) { fail(e); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const mkdir = async (e) => {
    e.preventDefault();
    try { await api('/files/folders', { method: 'POST', body: { parent_id: data.folder.id, name } }); setName(''); reload(); } catch (err) { fail(err); }
  };
  const delFolder = async (e, f) => {
    e.stopPropagation();
    if (!confirm(`Удалить папку «${f.name}» со всем содержимым?`)) return;
    try { await api(`/files/folders/${f.id}`, { method: 'DELETE' }); reload(); } catch (err) { fail(err); }
  };
  const delFile = async (e, f) => {
    e.stopPropagation();
    if (!confirm(`Удалить файл «${f.name}»?`)) return;
    try { await api(`/files/${f.id}`, { method: 'DELETE' }); reload(); } catch (err) { fail(err); }
  };
  const edit = canEdit();
  return html`<div class="page-h"><div><h1>Хранилище</h1><p>Скриншоты и файлы в структуре папок. Вложения публикаций лежат в «Публикации».</p></div></div>
    <div class="grid g-4" style="margin-bottom:16px"><${Stat} label="Файлов" value=${num(data.usage.count)} icon="folder" /><${Stat} label="Занято" value=${fmtSize(data.usage.size)} icon="upload" color="#38bdf8" /></div>
    <div class="crumbs" style="margin-bottom:14px">${data.trail.map((f, i) => html`${i ? html`<span>/</span>` : ''}<a href="#" onClick=${(e) => { e.preventDefault(); go(f.id); }}>${f.name}</a>`)}</div>
    ${edit ? html`<div class="grid g-2" style="margin-bottom:16px"><div class=${`drop ${over ? 'over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
        <${Icon} name="upload" size=${26} /><div>${busy ? 'Загрузка…' : 'Перетащите файлы сюда или'}</div><input type="file" multiple ref=${input} hidden onChange=${(e) => upload(e.target.files)} /><button class="btn sm" style="margin-top:8px" disabled=${busy} onClick=${() => input.current.click()}>Выбрать файлы</button></div>
      <form class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px;justify-content:center" onSubmit=${mkdir}><label class="field"><span>Новая папка</span><input value=${name} onInput=${(e) => setName(e.target.value)} required maxlength="100" placeholder="Например, Скрины ноября" /></label><button class="btn">Создать папку</button></form></div>` : ''}
    ${data.folders.length || data.files.length ? html`<div class="files">
      ${data.folders.map((f) => html`<div class="tile" role="button" tabindex="0" onClick=${() => go(f.id)} onKeyDown=${(e) => e.key === 'Enter' && go(f.id)}><div class="th"><${Icon} name="folder" size=${44} /></div><div class="tb"><b>${f.name}</b><small class="muted">${f.items} эл.</small></div>${edit ? html`<button class="icon-btn x" onClick=${(e) => delFolder(e, f)} aria-label="Удалить папку"><${Icon} name="trash" size=${14} /></button>` : ''}</div>`)}
      ${data.files.map((f) => html`<div class="tile" role="button" tabindex="0" onClick=${() => (isImage(f.mime) ? setPreview(f) : (location.href = fileUrl(f.id)))} onKeyDown=${(e) => e.key === 'Enter' && (isImage(f.mime) ? setPreview(f) : (location.href = fileUrl(f.id)))}>
        <div class="th">${isImage(f.mime) ? html`<img src=${fileUrl(f.id)} loading="lazy" alt="" />` : html`<${Icon} name="file" size=${40} />`}</div><div class="tb"><b title=${f.name}>${f.name}</b><small class="muted">${fmtSize(f.size)} · ${f.uploaded_by}</small></div>${edit ? html`<button class="icon-btn x" onClick=${(e) => delFile(e, f)} aria-label="Удалить файл"><${Icon} name="trash" size=${14} /></button>` : ''}</div>`)}</div>`
      : html`<${Card}><${Empty} icon="folder" title="Папка пуста" hint=${edit ? 'Загрузите файлы или создайте вложенную папку' : ''} /><//>`}
    ${preview ? html`<${Modal} title=${preview.name} wide onClose=${() => setPreview(null)} footer=${html`<small class="muted" style="margin-right:auto">${fmtSize(preview.size)} · ${preview.uploaded_by} · ${fmtDateTime(preview.created_at)}</small><a class="btn" href=${fileUrl(preview.id)} download=${preview.name}><${Icon} name="download" size=${15} /> Скачать</a>`}><img class="lightbox" src=${fileUrl(preview.id)} alt=${preview.name} /><//>` : ''}`;
}
