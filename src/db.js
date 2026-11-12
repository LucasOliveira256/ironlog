import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Migrações por PRAGMA user_version. Nunca edite uma migração já publicada: adicione outra.
const MIGRATIONS = [
`
CREATE TABLE users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE credentials(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT, device_type TEXT, backed_up INTEGER, label TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE INDEX idx_cred_user ON credentials(user_id);
CREATE TABLE invites(
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, used_by TEXT, revoked_at INTEGER
);
CREATE TABLE sessions(
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  ua TEXT, ip TEXT
);
CREATE INDEX idx_sess_user ON sessions(user_id);
CREATE TABLE challenges(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL,
  user_id TEXT, invite_id TEXT, name TEXT, expires_at INTEGER NOT NULL
);
CREATE TABLE records(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coll TEXT NOT NULL, key TEXT NOT NULL, data TEXT,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL,
  PRIMARY KEY(user_id, coll, key)
);
CREATE INDEX idx_rec_seq ON records(user_id, seq);
CREATE TABLE push_subs(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at INTEGER NOT NULL, ua TEXT
);
CREATE INDEX idx_push_user ON push_subs(user_id);
CREATE TABLE alerts(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  fire_at INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  actor TEXT, action TEXT NOT NULL, target TEXT, ip TEXT, detail TEXT
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
`
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const v = db.pragma('user_version', { simple: true });
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.transaction(() => { db.exec(MIGRATIONS[i]); db.pragma(`user_version = ${i + 1}`); })();
  }
  return db;
}
export const getMeta = (db, k) => db.prepare('SELECT value FROM meta WHERE key=?').pluck().get(k);
export const setMeta = (db, k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
export function audit(db, actor, action, target, ip, detail) {
  db.prepare('INSERT INTO audit(ts,actor,action,target,ip,detail) VALUES(?,?,?,?,?,?)').run(Date.now(), actor || null, action, target || null, ip || null, detail ? JSON.stringify(detail) : null);
}
