// Запуск: npm run backup  (в Docker: docker exec <контейнер> npm run backup)
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backupDb } from '../src/backup.js';

const config = loadConfig();
const db = openDb(config);
const file = await backupDb(db, path.join(config.dataDir, 'backups'), { keep: Number(process.env.BACKUP_KEEP) || 14 });
db.close();
console.log(`Копия базы: ${file}`);
console.log(`Файлы (скриншоты) лежат в ${config.storageDir} — копируйте эту папку вместе с backups/.`);
