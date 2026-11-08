import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
