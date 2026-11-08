import path from 'node:path';

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,
    storageDir: path.join(dataDir, 'storage'),
    dbFile: path.join(dataDir, 'stats.sqlite'),
    // Ник, который станет администратором при первом запуске.
    adminNick: env.ADMIN_NICK || '',
    // Часовой пояс для графиков «по часам» и «по дням».
    timezone: env.TZ_NAME || 'Europe/Moscow',
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
    // Вес в показателе активности раздела.
    weights: {
      week: num(env.W_WEEK, 0.5),
      month: num(env.W_MONTH, 0.3),
      authors: num(env.W_AUTHORS, 2),
    },
    secureCookie: env.SECURE_COOKIE === '1',
  };
}
