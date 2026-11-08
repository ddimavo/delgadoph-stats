// Приём данных от сборщика (userscript в браузере пользователя).
const MAX_POSTS = 50_000;

export class ValidationError extends Error {}

export function parseIngest(body) {
  const fail = (m) => { throw new ValidationError(m); };
  if (!body || typeof body !== 'object') fail('Пустое тело запроса');
  const s = body.section;
  if (!s || !Number.isInteger(s.id) || s.id <= 0) fail('section.id должен быть положительным целым');
  if (typeof s.title !== 'string' || !s.title.trim()) fail('section.title обязателен');
  if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) fail('section.url должен быть http(s)-ссылкой');
  if (!Array.isArray(body.posts)) fail('posts должен быть массивом');
  if (body.posts.length > MAX_POSTS) fail('Слишком много постов в одном запросе');
  const seen = new Set();
  const posts = [];
  for (const p of body.posts) {
    if (!p || !Number.isInteger(p.id) || p.id <= 0) fail('post.id должен быть положительным целым');
    if (typeof p.author !== 'string' || !p.author.trim() || p.author.length > 64) fail(`Некорректный автор у поста ${p.id}`);
    const t = typeof p.at === 'string' ? Date.parse(p.at) : NaN;
    if (!Number.isFinite(t)) fail(`Некорректная дата у поста ${p.id}`);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    posts.push({ id: p.id, author: p.author.trim(), at: new Date(t).toISOString() });
  }
  const created = s.createdAt ? Date.parse(s.createdAt) : NaN;
  return {
    section: {
      id: s.id,
      title: s.title.trim().slice(0, 300),
      url: s.url,
      author: typeof s.author === 'string' ? s.author.trim().slice(0, 64) : null,
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
      locked: s.locked ? 1 : 0,
    },
    posts,
  };
}

/** Полная синхронизация темы: посты, которых нет в запросе (удалённые на форуме), удаляются. */
export function applyIngest(db, { section, posts }) {
  return db.tx(() => {
    db.prepare(`INSERT INTO sections (id, title, url, author, created_at, locked, synced_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, author=excluded.author,
        created_at=COALESCE(excluded.created_at, sections.created_at), locked=excluded.locked, synced_at=excluded.synced_at`)
      .run(section.id, section.title, section.url, section.author, section.createdAt, section.locked, new Date().toISOString());
    const before = db.prepare('SELECT COUNT(*) c FROM posts WHERE section_id = ?').get(section.id).c;
    db.prepare('DELETE FROM posts WHERE section_id = ?').run(section.id);
    const ins = db.prepare('INSERT OR REPLACE INTO posts (id, section_id, author, posted_at) VALUES (?,?,?,?)');
    for (const p of posts) ins.run(p.id, section.id, p.author, p.at);
    return { before, after: posts.length };
  });
}
