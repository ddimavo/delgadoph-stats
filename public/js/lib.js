import { useState, useEffect } from '../vendor/preact-htm.js';

export const state = { user: null, meta: null };

export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { 'x-requested-with': 'spa' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError('Нет связи с сервером', 0); }
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status, data?.details);
  }
  return data;
}

/** Загрузка данных с перезагрузкой: const { data, error, loading, reload } = useApi('/plans'). */
export function useApi(path) {
  const [s, setS] = useState({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    let dead = false;
    setS((p) => ({ data: p.data, loading: true }));
    api(path).then((data) => { if (!dead) setS({ data, loading: false }); }).catch((error) => { if (!dead) setS({ error, loading: false }); });
    return () => { dead = true; };
  }, [path, tick]);
  return { ...s, reload: () => setTick((t) => t + 1) };
}

export const toast = (msg, type = 'ok') => window.dispatchEvent(new CustomEvent('toast', { detail: { msg, type } }));
export const fail = (e) => toast(e.message || 'Ошибка', 'err');

// --- форматирование ---
const nf = new Intl.NumberFormat('ru-RU');
export const num = (n) => nf.format(n ?? 0);
export const money = (n) => `${nf.format(n ?? 0)} $`;
export const fmtDateTime = (iso) => (iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: state.meta?.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—');
export const fmtDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—');
export const shortDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const fmtSize = (n) => (n < 1024 ? `${n} Б` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 ** 2).toFixed(1)} МБ`);
export function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  for (const [u, sec] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= sec) return rtf.format(-Math.round(s / sec), u);
  return 'только что';
}
export const delta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? null : 0);
export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const isImage = (mime) => /^image\/(png|jpe?g|gif|webp)$/.test(mime || '');
export const fileUrl = (id) => `/api/files/${id}/download`;
export const canEdit = () => state.user && state.user.role !== 'viewer';
export const isAdmin = () => state.user?.role === 'admin';

/** Разбор хеш-адреса: #/plan?x=1 -> { path: '/plan', query: URLSearchParams }. */
export function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}
export function setQuery(params) {
  const { path, query } = parseHash();
  for (const [k, v] of Object.entries(params)) { if (v === null || v === '') query.delete(k); else query.set(k, v); }
  const qs = query.toString();
  location.hash = qs ? `${path}?${qs}` : path;
}

export const shiftWeek = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 7 * 86400_000).toISOString().slice(0, 10);
