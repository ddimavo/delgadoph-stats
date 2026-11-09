import ExcelJS from 'exceljs';
import { PLAN_KINDS, PLAN_STATUSES } from './db.js';
import { topicStats, userLeaderboard } from './stats.js';
import { calcWeek } from './payouts.js';

const MONEY = '#,##0" $"';

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width, fmt]) => ({ header, key, width, style: fmt ? { numFmt: fmt } : {} }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}
const localDate = (iso, tz) => (iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');

/** includePayouts — только для администратора (денежные данные). */
export async function buildWorkbook(db, config, { rates, weekStart, includePayouts }) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const tz = config.timezone;
  const stats = topicStats(db, config);

  sheet(wb, 'Темы форума', [['Тема', 'title', 46], ['Всего постов', 'total', 13], ['За 24 ч', 'day', 10], ['За 7 дней', 'week', 11], ['За 30 дней', 'month', 12],
    ['Авторов за 30 дн.', 'authors30', 17], ['Активность (0–100)', 'score', 18], ['Последний пост', 'last', 20], ['Ссылка', 'url', 40]],
  stats.map((s) => ({ title: s.topic.title, total: s.total, day: s.day, week: s.week, month: s.month, authors30: s.authors30, score: s.score, last: localDate(s.last, tz), url: s.topic.url })));

  const users = (days, label) => sheet(wb, label, [['Игрок', 'nick', 28], ['Постов', 'posts', 10], ['Тем', 'topics', 8], ['Последний пост', 'last', 20]],
    userLeaderboard(db, days).map((u) => ({ ...u, last: localDate(u.last, tz) })));
  users(7, 'Пользователи 7 дн.'); users(30, 'Пользователи 30 дн.'); users(null, 'Пользователи всего');

  const posts = db.prepare('SELECT p.posted_at, p.author, s.title FROM posts p JOIN topics s ON s.id = p.topic_id ORDER BY p.posted_at DESC').all();
  sheet(wb, 'Посты', [['Время', 'at', 20], ['Тема', 'title', 46], ['Автор', 'author', 28]], posts.map((p) => ({ at: localDate(p.posted_at, tz), title: p.title, author: p.author })));

  const plans = db.prepare('SELECT p.*, s.title AS topic_title FROM plans p LEFT JOIN topics s ON s.id = p.topic_id ORDER BY (p.planned_date IS NULL), p.planned_date, p.id').all();
  sheet(wb, 'План публикаций', [['Дата', 'date', 12], ['Название', 'title', 44], ['Краткое описание', 'desc', 50], ['Тип', 'kind', 20], ['Статус', 'status', 20], ['Оценка (1–5)', 'rating', 13], ['Тема форума', 'topic', 36], ['Ссылка', 'url', 40], ['Ответственный', 'assignee', 20]],
    plans.map((p) => ({ date: p.planned_date || '', title: p.title, desc: p.description, kind: PLAN_KINDS[p.kind] || p.kind, status: PLAN_STATUSES[p.status] || p.status, rating: p.rating ?? '', topic: p.topic_title || '', url: p.url, assignee: p.assignee })));

  if (includePayouts) {
    const w = calcWeek(db, rates, weekStart);
    sheet(wb, `Выплаты ${w.start}`, [['Сотрудник', 'nick', 24], ['Ситуации', 'situation', 14, MONEY], ['Мероприятия', 'event', 15, MONEY], ['Эфиры', 'radio', 14, MONEY],
      ['Правок объявлений', 'adCount', 17], ['Объявления', 'adPaid', 14, MONEY], ['Бонус', 'adBonus', 12, MONEY], ['Итого', 'total', 16, MONEY], ['Примечания', 'notes', 60]],
    [...w.rows.map((e) => ({ ...e, notes: e.notes.join('; ') })), { nick: 'ВСЕГО', total: w.total }]);
    const items = w.rows.flatMap((e) => e.items.map((i) => ({ nick: e.nick, date: i.plan.planned_date, kind: PLAN_KINDS[i.plan.kind], title: i.plan.title, rating: i.plan.rating ?? '', amount: i.amount, note: i.note })));
    sheet(wb, 'Выплаты - детали', [['Сотрудник', 'nick', 24], ['Дата', 'date', 12], ['Тип', 'kind', 20], ['Публикация', 'title', 44], ['Оценка', 'rating', 9], ['Сумма', 'amount', 14, MONEY], ['Примечание', 'note', 24]], items);
  }
  return wb.xlsx.writeBuffer();
}
