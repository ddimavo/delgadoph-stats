import { html, useEffect, useRef } from '../vendor/preact-htm.js';
import { num, delta, shortDay, sum } from './lib.js';

const ICONS = {
  dashboard: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  forum: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M16 2v4 M8 2v4 M3 10h18',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z M15.5 8.5a5 5 0 0 1 0 7 M19 5a9 9 0 0 1 0 14',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  plan: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 3h6v4H9z M9 12h6 M9 16h4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  money: 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  plus: 'M12 5v14 M5 12h14',
  x: 'M18 6 6 18 M6 6l12 12',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  menu: 'M3 12h18 M3 6h18 M3 18h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  edit: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  chevL: 'M15 18l-6-6 6-6', chevR: 'M9 18l6-6-6-6',
  clip: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  news: 'M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z M2 8v11a3 3 0 0 0 3 3 M10 6h8 M10 10h8 M10 14h4',
  trend: 'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
};

export const Icon = ({ name, size = 18, class: cls = '' }) => html`<svg class="icon ${cls}" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(ICONS[name] || '').split(' M').map((d, i) => html`<path d=${i ? `M${d}` : d} />`)}</svg>`;

// --- мелкие элементы ---
export const Spinner = () => html`<div class="spinner" role="status" aria-label="Загрузка"></div>`;
export const Skeleton = ({ rows = 3 }) => html`<div class="grid g-4">${Array.from({ length: rows }, () => html`<div class="card skel"></div>`)}</div>`;
export const ErrorBox = ({ error, retry }) => html`<div class="card err-box"><${Icon} name="alert" /> <span>${error?.message || 'Ошибка загрузки'}</span>${retry ? html`<button class="btn sm" onClick=${retry}>Повторить</button>` : ''}</div>`;
export const Empty = ({ icon = 'file', title, hint, children }) => html`<div class="empty"><${Icon} name=${icon} size=${34} /><b>${title}</b>${hint ? html`<span>${hint}</span>` : ''}${children}</div>`;
export const Badge = ({ color, children, class: cls = '' }) => html`<span class="badge ${cls}" style=${color ? `--c:${color}` : ''}>${children}</span>`;

const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
export const Avatar = ({ nick, size = 28 }) => html`<span class="avatar" style=${`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:hsl(${hue(nick)} 55% 42%)`} title=${nick}>${(String(nick || '?').match(/[A-Za-zА-Яа-я0-9]/)?.[0] || '?').toUpperCase()}</span>`;
export const Person = ({ nick, sub }) => html`<span class="person"><${Avatar} nick=${nick} /><span><b>${nick}</b>${sub ? html`<small>${sub}</small>` : ''}</span></span>`;

export const Stars = ({ value, size = 14 }) => (value ? html`<span class="stars" style=${`font-size:${size}px`} title=${`${value} из 5`}>${'★'.repeat(value)}<i>${'★'.repeat(5 - value)}</i></span>` : html`<span class="muted">—</span>`);
export function StarInput({ value, onChange }) {
  return html`<span class="star-input" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" class=${n <= (value || 0) ? 'on' : ''} onClick=${() => onChange(value === n ? null : n)} aria-label=${`${n} из 5`}>★</button>`)}${value ? html`<small class="muted">${value} / 5</small>` : html`<small class="muted">не оценено</small>`}</span>`;
}

export function Stat({ label, value, icon, delta: d, hint, color, children }) {
  return html`<div class="card stat" style=${color ? `--c:${color}` : ''}>
    <div class="stat-top"><span class="stat-ic"><${Icon} name=${icon || 'trend'} /></span><span class="stat-label">${label}</span></div>
    <div class="stat-val">${value}</div>
    <div class="stat-foot">${d === undefined ? '' : d === null ? html`<span class="delta up">новое</span>` : html`<span class=${`delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d)}%</span>`}${hint ? html`<span class="muted">${hint}</span>` : ''}</div>${children}</div>`;
}

export const Card = ({ title, action, children, class: cls = '', pad = true }) => html`<section class=${`card ${cls}`}>${title ? html`<header class="card-h"><h3>${title}</h3>${action || ''}</header>` : ''}<div class=${pad ? 'card-b' : ''}>${children}</div></section>`;

export const Tabs = ({ value, onChange, items }) => html`<div class="tabs" role="tablist">${items.map(([k, label, count]) => html`<button role="tab" class=${k === value ? 'on' : ''} aria-selected=${k === value} onClick=${() => onChange(k)}>${label}${count !== undefined ? html`<span class="count">${count}</span>` : ''}</button>`)}</div>`;

export function Modal({ title, onClose, children, wide, footer }) {
  const ref = useRef();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('noscroll');
    ref.current?.querySelector('input,select,textarea')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('noscroll'); };
  }, []);
  return html`<div class="modal-back" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <header><h3>${title}</h3><button class="icon-btn" onClick=${onClose} aria-label="Закрыть"><${Icon} name="x" /></button></header>
      <div class="modal-b">${children}</div>${footer ? html`<footer>${footer}</footer>` : ''}</div></div>`;
}

export const Field = ({ label, children, class: cls = '', hint }) => html`<label class=${`field ${cls}`}><span>${label}</span>${children}${hint ? html`<small class="muted">${hint}</small>` : ''}</label>`;

export const DeltaText = ({ cur, prev }) => { const d = delta(cur, prev); return d === null ? html`<span class="delta up">новое</span>` : html`<span class=${`delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d)}%</span>`; };

// --- графики (SVG, адаптивные) ---
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const axisLabel = (l) => (/^\d{4}-\d{2}-\d{2}$/.test(l) ? shortDay(l) : l);

export function BarChart({ values, labels, color = 'var(--accent)', height = 190, unit = '' }) {
  const W = 640, L = 30, B = 22, T = 8, H = height, n = values.length;
  const max = niceMax(Math.max(1, ...values)), bw = (W - L) / n, ch = H - B - T;
  const ticks = max >= 2 ? [0, max / 2, max] : [0, max];
  const step = Math.ceil(n / 8);
  return html`<svg class="chart" viewBox=${`0 0 ${W} ${H}`} role="img" preserveAspectRatio="xMidYMid meet">
    ${ticks.map((t) => html`<g><line class="grid-l" x1=${L} x2=${W} y1=${T + ch - (t / max) * ch} y2=${T + ch - (t / max) * ch} /><text class="ax" x=${L - 6} y=${T + ch - (t / max) * ch + 4} text-anchor="end">${num(t)}</text></g>`)}
    ${values.map((v, i) => { const h = (v / max) * ch; return html`<g class="bar-g"><rect class="bar-r" x=${L + i * bw + bw * 0.14} y=${T + ch - h} width=${bw * 0.72} height=${Math.max(h, v ? 2 : 0)} rx="4" fill=${color}><title>${axisLabel(labels[i])}: ${num(v)}${unit}</title></rect>${i % step === 0 ? html`<text class="ax" x=${L + i * bw + bw / 2} y=${H - 6} text-anchor="middle">${axisLabel(labels[i])}</text>` : ''}</g>`; })}
  </svg>`;
}

export function StackedBars({ labels, series, height = 190 }) {
  const W = 640, L = 30, B = 22, T = 8, H = height, n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
  const max = niceMax(Math.max(1, ...totals)), bw = (W - L) / n, ch = H - B - T;
  const ticks = max >= 2 ? [0, max / 2, max] : [0, max];
  const step = Math.ceil(n / 8);
  return html`<div><svg class="chart" viewBox=${`0 0 ${W} ${H}`} role="img">
    ${ticks.map((t) => html`<g><line class="grid-l" x1=${L} x2=${W} y1=${T + ch - (t / max) * ch} y2=${T + ch - (t / max) * ch} /><text class="ax" x=${L - 6} y=${T + ch - (t / max) * ch + 4} text-anchor="end">${num(t)}</text></g>`)}
    ${labels.map((l, i) => { let y = T + ch; return html`<g>${series.map((s) => { const h = (s.values[i] / max) * ch; y -= h; return h > 0 ? html`<rect x=${L + i * bw + bw * 0.14} y=${y} width=${bw * 0.72} height=${h} rx="3" fill=${s.color}><title>${axisLabel(l)} · ${s.label}: ${s.values[i]}</title></rect>` : ''; })}${i % step === 0 ? html`<text class="ax" x=${L + i * bw + bw / 2} y=${H - 6} text-anchor="middle">${axisLabel(l)}</text>` : ''}</g>`; })}
  </svg><div class="legend">${series.map((s) => html`<span><i style=${`background:${s.color}`}></i>${s.label}</span>`)}</div></div>`;
}

export function Sparkline({ values, color = 'var(--accent)', w = 96, h = 28 }) {
  const max = Math.max(1, ...values), n = values.length;
  const pts = values.map((v, i) => [(i / (n - 1 || 1)) * w, h - 3 - (v / max) * (h - 6)]);
  const line = pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ');
  return html`<svg class="spark" width=${w} height=${h} viewBox=${`0 0 ${w} ${h}`} aria-hidden="true"><polygon points=${`0,${h} ${line} ${w},${h}`} fill=${color} opacity=".14" /><polyline points=${line} fill="none" stroke=${color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

export const STAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
export function Donut({ values, center, sub, size = 168 }) {
  const total = values.reduce((a, b) => a + b, 0), r = 56, c = 2 * Math.PI * r;
  let off = 0;
  return html`<svg viewBox="0 0 160 160" width=${size} height=${size} class="donut" role="img">
    <circle cx="80" cy="80" r=${r} fill="none" stroke="var(--line)" stroke-width="18" />
    ${total ? values.map((v, i) => { const len = (v / total) * c; const el = v ? html`<circle cx="80" cy="80" r=${r} fill="none" stroke=${STAR_COLORS[i]} stroke-width="18" stroke-dasharray=${`${Math.max(len - 2, 0)} ${c - Math.max(len - 2, 0)}`} stroke-dashoffset=${-off} transform="rotate(-90 80 80)"><title>${i + 1}★: ${v}</title></circle>` : ''; off += len; return el; }) : ''}
    <text x="80" y="82" text-anchor="middle" class="donut-n">${center}</text><text x="80" y="102" text-anchor="middle" class="ax">${sub}</text></svg>`;
}

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DOW_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export function Heatmap({ data }) {
  const max = Math.max(1, ...data.flat()), cw = 22, L = 34, T = 18;
  return html`<svg class="chart heat" viewBox=${`0 0 ${L + 24 * cw} ${T + 7 * cw + 2}`} role="img">
    ${[0, 3, 6, 9, 12, 15, 18, 21].map((h) => html`<text class="ax-h" x=${L + h * cw + cw / 2} y="12" text-anchor="middle">${h}</text>`)}
    ${data.map((row, d) => html`<g><text class="ax-h" x="0" y=${T + d * cw + 16}>${DOW[d]}</text>${row.map((v, h) => html`<rect x=${L + h * cw + 1} y=${T + d * cw + 1} width=${cw - 2} height=${cw - 2} rx="4" fill="var(--accent)" fill-opacity=${v ? 0.12 + 0.88 * (v / max) : 0.05}><title>${DOW[d]} ${h}:00 — ${v}</title></rect>`)}</g>`)}</svg>`;
}

/** Тепловая карта «когда пишут» с подсказками: самый активный день и час. */
export function HeatBlock({ data }) {
  const byDay = data.map(sum), byHour = Array.from({ length: 24 }, (_, h) => sum(data.map((r) => r[h])));
  const total = sum(byDay), day = byDay.indexOf(Math.max(...byDay)), hour = byHour.indexOf(Math.max(...byHour));
  return html`<div><${Heatmap} data=${data} />${total ? html`<div class="kv"><div><span>Самый активный день</span><b>${DOW_FULL[day]}</b></div><div><span>Пик по часам</span><b>${hour}:00–${hour + 1}:00</b></div><div><span>Постов за 90 дней</span><b>${num(total)}</b></div></div>` : html`<p class="muted pad">Постов за 90 дней нет</p>`}</div>`;
}

/** Горизонтальные полосы: [{ label, value, sub, color, href }]. */
export function HBars({ items, max, empty = 'Пока нет данных', ranks = true }) {
  if (!items.length) return html`<p class="muted pad">${empty}</p>`;
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return html`<ul class="hbars">${items.map((i, idx) => html`<li>${ranks ? html`<span class="rank">${idx + 1}</span>` : ''}<div class="hb-main"><div class="hb-top">${i.node || html`<b>${i.label}</b>`}<span class="hb-v">${i.valueText ?? num(i.value)}</span></div><div class="bar"><i style=${`width:${Math.max(3, (i.value / m) * 100)}%;${i.color ? `background:${i.color}` : ''}`}></i></div>${i.sub ? html`<small class="muted">${i.sub}</small>` : ''}</div></li>`)}</ul>`;
}

export function ScoreRing({ value, size = 40 }) {
  const r = 15, c = 2 * Math.PI * r;
  return html`<span class="ring" title=${`Активность ${value} из 100`}><svg width=${size} height=${size} viewBox="0 0 40 40"><circle cx="20" cy="20" r=${r} fill="none" stroke="var(--line)" stroke-width="4" /><circle cx="20" cy="20" r=${r} fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-dasharray=${`${(value / 100) * c} ${c}`} transform="rotate(-90 20 20)" /></svg><b>${Math.round(value)}</b></span>`;
}
