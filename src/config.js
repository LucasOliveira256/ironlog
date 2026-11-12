// Configuração por variáveis de ambiente (arquivo /etc/ironlog/ironlog.env no systemd)
import { URL } from 'node:url';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const origin = (env.ORIGIN || 'https://ironlog.edge.seg.br').replace(/\/$/, '');
  const dataDir = env.DATA_DIR || '/var/lib/ironlog';
  const appDir = env.APP_DIR || '/opt/ironlog';
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',            // atrás do NPM: escute só no IP interno da LXC
    origin,
    rpID: env.RP_ID || new URL(origin).hostname,
    rpName: env.RP_NAME || 'IRONLOG',
    secureCookies: origin.startsWith('https://'),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'ironlog.db'),
    staticDir: env.STATIC_DIR || path.join(appDir, 'public'),
    adminFile: env.ADMIN_FILE || path.join(appDir, 'admin', 'admin.html'),
    sessionDays: Number(env.SESSION_DAYS) || 60,
    inviteHours: Number(env.INVITE_HOURS) || 72,
    maxPasskeys: Number(env.MAX_PASSKEYS) || 2,
    trustProxy: env.TRUST_PROXY !== '0',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@seg.br',
    alertSnoozeMin: Number(env.ALERT_SNOOZE_MIN) || 30,
    alertMaxRepeats: Number(env.ALERT_MAX_REPEATS) || 4,
    schedulerMs: Number(env.SCHEDULER_MS) || 20000,
    logLevel: env.LOG_LEVEL || 'info'
  };
}
