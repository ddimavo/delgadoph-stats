import { html, render, useState, useEffect } from '../vendor/preact-htm.js';
import { api, state, parseHash, isAdmin, fail, toast } from './lib.js';
import { Icon, Spinner, Field } from './ui.js';
import { Dashboard } from './views/dashboard.js';
import { SectionPage, AdsPage } from './views/sections.js';
import { ForumPage, TopicPage } from './views/forum.js';
import { PlanPage } from './views/plan.js';
import { FilesPage } from './views/files.js';
import { PayoutsPage, RatesPage } from './views/payouts.js';
import { AdminPage } from './views/admin.js';

const ROUTES = [
  [/^\/$/, Dashboard],
  [/^\/section\/(\w+)$/, SectionPage],
  [/^\/ads$/, AdsPage],
  [/^\/forum$/, ForumPage],
  [/^\/forum\/topic\/(\d+)$/, TopicPage],
  [/^\/plan$/, PlanPage],
  [/^\/files$/, FilesPage],
  [/^\/payouts$/, PayoutsPage],
  [/^\/payouts\/rates$/, RatesPage],
  [/^\/admin$/, AdminPage],
];

function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => { setR(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (e) => {
      const t = { id: Math.random(), ...e.detail };
      setItems((a) => [...a, t]);
      setTimeout(() => setItems((a) => a.filter((x) => x.id !== t.id)), 4200);
    };
    window.addEventListener('toast', on);
    return () => window.removeEventListener('toast', on);
  }, []);
  return html`<div class="toasts" aria-live="polite">${items.map((t) => html`<div class=${`toast ${t.type === 'err' ? 'err' : ''}`}>${t.msg}</div>`)}</div>`;
}

function Login({ onLogin }) {
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { onLogin(await api('/login', { method: 'POST', body: { nick } })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return html`<div class="login"><div class="card login-card"><img src="/icon.svg" alt="" /><h1>Delgado PH Stats</h1><p class="muted">Статистика, публикации и выплаты редакции</p>
    <form onSubmit=${submit}><${Field} label="Ник игрока"><input value=${nick} onInput=${(e) => setNick(e.target.value)} placeholder="Brianna_Delgado" autofocus required maxlength="64" autocomplete="username" /><//>
    ${error ? html`<div class="err-box" style="padding:0">${error}</div>` : ''}<button class="btn primary" disabled=${busy} style="justify-content:center">${busy ? 'Входим…' : 'Войти'}</button></form></div></div>`;
}

function NavLink({ href, icon, children, route }) {
  const on = href === '/' ? route.path === '/' : route.path === href || route.path.startsWith(`${href}/`);
  return html`<a href=${`#${href}`} class=${on ? 'on' : ''} aria-current=${on ? 'page' : undefined}><${Icon} name=${icon} /> ${children}</a>`;
}

function Shell({ route, onLogout }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => setOpen(false), [route.path]);
  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch { /* приватный режим */ }
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#0b0d12' : '#f4f5f8');
    setTheme(t);
  };
  let View = null, params = [];
  for (const [re, comp] of ROUTES) { const m = re.exec(route.path); if (m) { View = comp; params = m.slice(1); break; } }
  const { kinds } = state.meta;
  const nav = html`<nav class="nav" aria-label="Разделы сайта">
    <${NavLink} href="/" icon="dashboard" route=${route}>Обзор<//>
    <div class="nav-group">Контент</div>
    ${['situation', 'radio', 'event', 'press'].map((k) => html`<${NavLink} href=${`/section/${k}`} icon=${kinds[k].icon} route=${route}>${kinds[k].label}<//>`)}
    <${NavLink} href="/ads" icon="megaphone" route=${route}>Объявления<//>
    <${NavLink} href=${'/section/other'} icon="file" route=${route}>${kinds.other.label}<//>
    <div class="nav-group">Форум</div>
    <${NavLink} href="/forum" icon="forum" route=${route}>Статистика форума<//>
    <div class="nav-group">Работа</div>
    <${NavLink} href="/plan" icon="plan" route=${route}>План публикаций<//>
    <${NavLink} href="/files" icon="folder" route=${route}>Хранилище<//>
    ${isAdmin() ? html`<div class="nav-group">Администратор</div><${NavLink} href="/payouts" icon="money" route=${route}>Выплаты<//><${NavLink} href="/admin" icon="users" route=${route}>Доступ<//>` : ''}
  </nav>`;
  return html`<div class="shell">
    <aside class=${`sidebar ${open ? 'open' : ''}`}>
      <div class="brand"><img src="/icon.svg" alt="" /><div>Delgado PH<small>Stats</small></div></div>${nav}
      <div class="side-foot"><div class="me"><${Icon} name="users" /><div><b>${state.user.nick}</b><small>${{ admin: 'Администратор', editor: 'Редактор', viewer: 'Просмотр' }[state.user.role]}</small></div></div>
        <div class="side-actions"><button class="btn sm" onClick=${toggleTheme} aria-label="Сменить тему"><${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} size=${15} /> Тема</button><button class="btn sm" onClick=${onLogout}><${Icon} name="logout" size=${15} /> Выйти</button></div></div>
    </aside>
    <div class=${`scrim ${open ? 'open' : ''}`} onClick=${() => setOpen(false)}></div>
    <div class="main">
      <header class="topbar"><button class="icon-btn" onClick=${() => setOpen(true)} aria-label="Меню"><${Icon} name="menu" /></button><b>Delgado PH Stats</b><button class="icon-btn" onClick=${toggleTheme} aria-label="Сменить тему"><${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} /></button></header>
      <main class="page" key=${route.path}>${View ? html`<${View} params=${params} query=${route.query} />` : html`<h1>Страница не найдена</h1><p><a href="#/">На главную</a></p>`}</main>
    </div></div>`;
}

function App() {
  const [boot, setBoot] = useState('loading');
  const route = useRoute();
  useEffect(() => {
    api('/me').then((d) => { if (d.user) { state.user = d.user; state.meta = d.meta; setBoot('app'); } else setBoot('login'); }).catch(() => setBoot('login'));
    const onUnauth = () => { state.user = null; setBoot('login'); };
    window.addEventListener('unauthorized', onUnauth);
    return () => window.removeEventListener('unauthorized', onUnauth);
  }, []);
  const onLogin = (d) => { state.user = d.user; state.meta = d.meta; location.hash = '#/'; setBoot('app'); };
  const onLogout = async () => { try { await api('/logout', { method: 'POST', body: {} }); } catch (e) { fail(e); } state.user = null; setBoot('login'); };
  return html`${boot === 'loading' ? html`<div class="boot"><${Spinner} /></div>` : boot === 'login' ? html`<${Login} onLogin=${onLogin} />` : html`<${Shell} route=${route} onLogout=${onLogout} />`}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
