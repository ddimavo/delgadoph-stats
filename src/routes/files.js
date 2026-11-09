import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { bad, notFound, str } from '../http.js';

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const cleanName = (n) => String(n || 'file').replace(/[\\/]/g, '_').replace(/[\x00-\x1f"]/g, '').trim().slice(0, 200) || 'file';

export default function filesRoutes(app, { db, config, need }) {
  const rootId = () => db.prepare('SELECT id FROM folders WHERE parent_id IS NULL').get().id;
  const getFolder = (id) => db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  const trail = (id) => {
    const out = [];
    for (let cur = getFolder(id); cur; cur = cur.parent_id ? getFolder(cur.parent_id) : null) out.unshift({ id: cur.id, name: cur.name });
    return out;
  };
  function ensureFolder(parentId, name) {
    name = cleanName(name).slice(0, 100);
    const ex = db.prepare('SELECT id FROM folders WHERE IFNULL(parent_id,0) = ? AND name = ? COLLATE NOCASE').get(parentId, name);
    if (ex) return ex.id;
    return Number(db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?,?,?)').run(parentId, name, new Date().toISOString()).lastInsertRowid);
  }
  const unlinkFiles = (rows) => { for (const r of rows) fs.rmSync(path.join(config.storageDir, r.stored_name), { force: true }); };

  app.get('/api/files', async (req) => {
    const fid = Number(req.query.folder) || rootId();
    const t = trail(fid);
    if (!t.length) throw notFound('Папка не найдена');
    const folders = db.prepare('SELECT f.id, f.name, f.created_at, (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id) + (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS items FROM folders f WHERE parent_id = ? ORDER BY name COLLATE NOCASE').all(fid);
    const files = db.prepare('SELECT id, plan_id, original_name AS name, mime, size, uploaded_by, created_at FROM files WHERE folder_id = ? ORDER BY created_at DESC, id DESC').all(fid);
    const usage = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM files').get();
    return { folder: t[t.length - 1], trail: t, folders, files, usage };
  });

  app.post('/api/files/folders', async (req) => {
    need(req, 'edit');
    const parent = Number(req.body?.parent_id);
    if (!getFolder(parent)) throw notFound('Папка не найдена');
    if (!str(req.body?.name, 100)) throw bad('Укажите имя папки');
    return { id: ensureFolder(parent, req.body.name) };
  });
  app.delete('/api/files/folders/:id', async (req) => {
    need(req, 'edit');
    const id = Number(req.params.id), f = getFolder(id);
    if (!f || !f.parent_id) throw bad('Эту папку удалить нельзя');
    const rows = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
      SELECT stored_name FROM files WHERE folder_id IN (SELECT id FROM t)`).all(id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    unlinkFiles(rows);
    return { ok: true, parent_id: f.parent_id };
  });
  app.delete('/api/files/:id', async (req) => {
    need(req, 'edit');
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    if (!f) throw notFound('Файл не найден');
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    unlinkFiles([f]);
    return { ok: true };
  });

  app.get('/api/files/:id/download', async (req, reply) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    if (!f) throw notFound('Файл не найден');
    const inline = INLINE_IMAGES.has(f.mime);
    return reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=3600')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`)
      .type(inline ? f.mime : 'application/octet-stream').send(fs.createReadStream(path.join(config.storageDir, f.stored_name)));
  });

  // multipart: поля folder_id / plan_id должны идти ДО файлов.
  app.post('/api/files', async (req) => {
    need(req, 'edit');
    const fields = {}, saved = [];
    let folderId = null, planId = null, error = null;
    const resolveTarget = () => {
      if (folderId || error) return;
      if (fields.plan_id) {
        const p = db.prepare('SELECT id, title FROM plans WHERE id = ?').get(Number(fields.plan_id));
        if (!p) { error = 'Публикация не найдена'; return; }
        planId = p.id;
        folderId = ensureFolder(ensureFolder(rootId(), 'Публикации'), `#${p.id} ${p.title}`.slice(0, 80));
      } else if (getFolder(Number(fields.folder_id))) folderId = Number(fields.folder_id);
      else error = 'Папка не найдена';
    };
    for await (const part of req.parts()) {
      if (part.type === 'field') { fields[part.fieldname] = part.value; continue; }
      resolveTarget();
      if (error) { part.file.resume(); continue; }
      const stored = `${new Date().getUTCFullYear()}-${crypto.randomUUID()}`;
      const dest = path.join(config.storageDir, stored);
      await pipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) { fs.rmSync(dest, { force: true }); error = `Файл «${cleanName(part.filename)}» больше лимита`; continue; }
      if (!part.filename) { fs.rmSync(dest, { force: true }); continue; }
      const size = fs.statSync(dest).size;
      const id = Number(db.prepare('INSERT INTO files (folder_id, plan_id, original_name, stored_name, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(folderId, planId, cleanName(part.filename), stored, String(part.mimetype || 'application/octet-stream').toLowerCase(), size, req.user.nick, new Date().toISOString()).lastInsertRowid);
      saved.push({ id, name: cleanName(part.filename), size });
    }
    if (error && !saved.length) throw bad(error);
    return { files: saved, warning: error };
  });
}
