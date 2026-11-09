// Ручной ввод постов: разбор строк «дата время ник» и сохранение.
const RE_DOTS = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[\sT,;]+(\d{1,2}):(\d{2})(?::\d{2})?[\s,;]+(\S.*)$/;
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})[\sT,;]+(\d{1,2}):(\d{2})(?::\d{2})?[\s,;]+(\S.*)$/;

/** Местное время в часовом поясе tz -> UTC Date. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const asLocal = (ms) => {
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let ms = want;
  for (let i = 0; i < 2; i++) ms += want - asLocal(ms);
  return new Date(ms);
}

/** Возвращает { posts, errors }. Если есть ошибки, сохранять ничего не нужно. */
export function parsePostLines(text, tz, now = new Date()) {
  const posts = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = RE_DOTS.exec(line);
    const [y, mo, d, h, mi, nick] = m ? [m[3], m[2], m[1], m[4], m[5], m[6]] : (RE_ISO.exec(line) || []).slice(1);
    const bad = (why) => errors.push(`Строка ${i + 1}: ${why} — «${line.slice(0, 60)}»`);
    if (!nick) return bad('ожидается «ДД.ММ.ГГГГ ЧЧ:ММ Ник»');
    const [Y, M, D, H, MI] = [y, mo, d, h, mi].map(Number);
    if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59) return bad('неверная дата или время');
    const dt = zonedToUtc(Y, M, D, H, MI, tz);
    if (dt.getUTCDate() !== D && zonedToUtc(Y, M, D, 12, 0, tz).getUTCDate() !== D) return bad('такой даты не существует');
    if (dt.getTime() > now.getTime() + 3600_000) return bad('дата в будущем');
    if (nick.trim().length > 64) return bad('слишком длинный ник');
    posts.push({ author: nick.trim(), at: dt.toISOString() });
  });
  return { posts, errors };
}

export function addPosts(db, topicId, posts) {
  const ins = db.prepare('INSERT OR IGNORE INTO posts (topic_id, author, posted_at) VALUES (?,?,?)');
  return db.tx(() => {
    let added = 0;
    for (const p of posts) added += Number(ins.run(topicId, p.author, p.at).changes);
    return { added, skipped: posts.length - added };
  });
}
