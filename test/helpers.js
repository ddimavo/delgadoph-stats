import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

process.env.NODE_ENV = 'test';
export const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
export const dayStr = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

export async function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-'));
  const config = loadConfig({ DATA_DIR: dir, ADMIN_NICK: 'Boss', TZ_NAME: 'UTC', ...env });
  const app = await buildApp(config);
  app.db.prepare("INSERT INTO members (nick, role, created_at) VALUES ('Ed','editor','x'),('View','viewer','x')").run();
  const as = async (nick) => {
    const r = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-requested-with': 'spa', 'content-type': 'application/json' }, payload: JSON.stringify({ nick }) });
    const cookie = r.cookies[0] ? `sid=${r.cookies[0].value}` : '';
    const call = async (method, url, body) => {
      const res = await app.inject({ method, url, headers: { cookie, 'x-requested-with': 'spa', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = JSON.parse(res.body); } catch { /* не JSON */ }
      return { status: res.statusCode, json, res };
    };
    return Object.assign(call, { cookie, loginStatus: r.statusCode });
  };
  return { app, config, as };
}
