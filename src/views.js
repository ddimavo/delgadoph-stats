// Мини-шаблонизатор: значения в html`` экранируются, если это не Raw.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const render = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v));
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? render(vals[i]) : ''); });
  return new Raw(out);
}

export function fmtDate(iso, tz) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}
export const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
export const money = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} $`;

export function fmtSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 ** 2).toFixed(1)} МБ`;
}

export function barChart(values, labels, { height = 90, color = '#d4a24c' } = {}) {
  const w = 600, max = Math.max(1, ...values), bw = w / values.length;
  const bars = values.map((v, i) => {
    const h = Math.round((v / max) * (height - 18));
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${height - 14 - h}" width="${(bw - 2).toFixed(1)}" height="${h}" fill="${color}" rx="1"><title>${esc(labels[i])}: ${v}</title></rect>`;
  }).join('');
  return raw(`<svg viewBox="0 0 ${w} ${height}" class="chart" role="img">${bars}<line x1="0" x2="${w}" y1="${height - 13}" y2="${height - 13}" stroke="#333"/></svg>`);
}

export function sparkline(values) {
  const w = 90, h = 22, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  return raw(`<svg width="${w}" height="${h}" class="spark"><polyline points="${pts}" fill="none" stroke="#d4a24c" stroke-width="1.5"/></svg>`);
}

const CSS = `
:root{color-scheme:dark;--bg:#141414;--card:#1d1d1d;--line:#2c2c2c;--text:#e6e6e6;--mute:#8d8d8d;--acc:#d4a24c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:20px;align-items:center;padding:12px 24px;border-bottom:1px solid var(--line);background:#0e0e0e}
header b{font-size:16px}header nav{display:flex;gap:16px;flex:1}header .me{color:var(--mute)}
main{max-width:1200px;margin:0 auto;padding:24px}h1{margin:0 0 16px;font-size:22px}h2{margin:28px 0 10px;font-size:16px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}.card .n{font-size:26px;font-weight:600}.card .l{color:var(--mute);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--mute);font-weight:500;font-size:12px}tr:last-child td{border:0}td.r,th.r{text-align:right}
.score{display:inline-block;min-width:44px;padding:2px 8px;border-radius:10px;background:#2a2412;color:var(--acc);font-weight:600;text-align:center}
.bar{height:6px;background:#2c2c2c;border-radius:3px;min-width:80px}.bar i{display:block;height:100%;background:var(--acc);border-radius:3px}
.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
form.inline{display:inline}input,select,textarea,button{font:inherit;color:var(--text);background:#101010;border:1px solid var(--line);border-radius:6px;padding:7px 10px}
button{background:#2a2412;color:var(--acc);cursor:pointer;border-color:#4a3d18}button.danger{background:#2a1414;color:#e57373;border-color:#4a1f1f}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:10px 0}.row label{display:flex;flex-direction:column;gap:4px;color:var(--mute);font-size:12px}
.mute{color:var(--mute)}.tag{padding:2px 8px;border-radius:10px;background:#262626;font-size:12px}
.tag.published{background:#14291a;color:#7bd88f}.tag.ready{background:#14232e;color:#6cb6e8}.tag.draft{background:#2a2412;color:var(--acc)}.tag.cancelled{background:#2a1414;color:#e57373}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:800px){.grid2{grid-template-columns:1fr}}
.err{background:#2a1414;border:1px solid #4a1f1f;padding:10px;border-radius:6px;margin-bottom:12px}.ok{background:#14291a;border:1px solid #1f4a2a;padding:10px;border-radius:6px;margin-bottom:12px}
code{background:#101010;padding:2px 6px;border-radius:4px;word-break:break-all}.thumb{max-width:60px;max-height:40px;border-radius:4px}
`;

export function layout({ title, user, body, nav = '' }) {
  const links = [['/', 'Обзор'], ['/users', 'Пользователи'], ['/plan', 'План публикаций'], ['/files', 'Хранилище']];
  if (user?.role === 'admin') links.push(['/payouts', 'Выплаты'], ['/admin', 'Управление']);
  return html`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Delgado PH Stats</title><style>${raw(CSS)}</style></head><body>
${user ? html`<header><b>Delgado PH Stats</b><nav>${links.map(([h, t]) => html`<a href="${h}"${h === nav ? raw(' style="font-weight:700"') : raw('')}>${t}</a>`)}</nav>
<span class="me">${user.nick} (${user.role}) · <form class="inline" method="post" action="/logout"><button>Выйти</button></form></span></header>` : ''}
<main>${body}</main></body></html>`;
}
