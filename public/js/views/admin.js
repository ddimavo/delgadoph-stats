import { html, useState } from '../../vendor/preact-htm.js';
import { api, useApi, state, fail, toast } from '../lib.js';
import { Icon, Card, Person, Skeleton, ErrorBox, Field, Badge } from '../ui.js';

const ROLE = { admin: ['Администратор', '#f87171'], editor: ['Редактор', '#38bdf8'], viewer: ['Просмотр', '#8b94a7'] };

export function AdminPage() {
  const { data, error, reload } = useApi('/admin/members');
  const [nick, setNick] = useState('');
  const [role, setRole] = useState('editor');
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Skeleton} rows=${2} />`;
  const save = async (n, r) => {
    try { await api('/admin/members', { method: 'PUT', body: { nick: n, role: r } }); toast('Сохранено'); reload(); return true; } catch (e) { fail(e); return false; }
  };
  const add = async (e) => { e.preventDefault(); if (await save(nick, role)) setNick(''); };
  const del = async (n) => {
    if (!confirm(`Убрать доступ у «${n}»?`)) return;
    try { await api(`/admin/members?nick=${encodeURIComponent(n)}`, { method: 'DELETE' }); reload(); } catch (e) { fail(e); }
  };
  return html`<div class="page-h"><div><h1>Доступ</h1><p>Вход по нику без пароля, но только для ников из этого списка. Не публикуйте адрес сайта открыто.</p></div></div>
    <${Card} pad=${false}><div class="table-wrap"><table><thead><tr><th>Ник</th><th>Роль</th><th></th></tr></thead><tbody>${data.members.map((m) => html`<tr><td><${Person} nick=${m.nick} /></td>
      <td><select style="width:auto" value=${m.role} onChange=${(e) => save(m.nick, e.target.value)} aria-label=${`Роль ${m.nick}`}>${state.meta.roles.map((r) => html`<option value=${r}>${ROLE[r][0]}</option>`)}</select></td>
      <td class="r">${m.nick.toLowerCase() === state.user.nick.toLowerCase() ? html`<${Badge}>это вы<//>` : html`<button class="icon-btn" onClick=${() => del(m.nick)} aria-label="Убрать"><${Icon} name="trash" size=${15} /></button>`}</td></tr>`)}</tbody></table></div><//>
    <${Card} class="mt" title="Добавить ник"><form class="form-grid" style="align-items:end" onSubmit=${add}><${Field} label="Ник"><input value=${nick} onInput=${(e) => setNick(e.target.value)} required maxlength="64" placeholder="Brianna_Delgado" /><//>
      <${Field} label="Роль"><select value=${role} onChange=${(e) => setRole(e.target.value)}>${state.meta.roles.map((r) => html`<option value=${r}>${ROLE[r][0]}</option>`)}</select><//><button class="btn primary" style="justify-content:center"><${Icon} name="plus" size=${16} /> Добавить</button></form>
      <p class="muted" style="margin:12px 0 0"><b>Редактор</b> — план, файлы, ввод данных. <b>Просмотр</b> — только чтение. <b>Администратор</b> — ещё выплаты, расценки и доступ.</p><//>`;
}
