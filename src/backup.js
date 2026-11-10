import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

const NAME = /^stats-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** Согласованная копия базы без остановки сайта; хранит `keep` последних копий. */
export async function backupDb(db, dir, { keep = 14, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stats-${now.toISOString().slice(0, 10)}.sqlite`);
  const tmp = `${file}.tmp`;
  await backup(db, tmp);
  fs.renameSync(tmp, file);
  for (const old of fs.readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse().slice(keep)) fs.rmSync(path.join(dir, old));
  return file;
}
