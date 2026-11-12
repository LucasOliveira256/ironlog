import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { purgeExpired } from './auth.js';

const cfg = loadConfig();
const app = await buildApp(cfg, { logger: true });

const timer = setInterval(() => {
  app.push.tick().catch(e => app.log.error(e, 'agendador'));
  try { purgeExpired(app.db); } catch (e) { app.log.error(e, 'limpeza'); }
}, cfg.schedulerMs);

async function stop(sig) {
  app.log.info({ sig }, 'encerrando'); clearInterval(timer);
  try { await app.close(); } finally { process.exit(0); }
}
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));

await app.listen({ port: cfg.port, host: cfg.host });
