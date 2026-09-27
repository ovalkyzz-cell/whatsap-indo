'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DIALECT = process.env.DATABASE_URL ? 'pg' : 'sqlite';
const INSTANCE_ID = crypto.randomUUID();
const DATA_DIR = path.join(__dirname, '..', 'data');
const txStore = new AsyncLocalStorage();

let bootPromise = null;
let pool = null;
let sqlite = null;
let writeLock = Promise.resolve();

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  about         TEXT NOT NULL DEFAULT 'Hai! Saya sedang menggunakan Whatsap Indo.',
  verified      SMALLINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL DEFAULT 0,
  wallpaper_type TEXT NOT NULL DEFAULT 'default',
  wallpaper_url  TEXT,
  wallpaper_mode TEXT NOT NULL DEFAULT 'cover',
  wallpaper_scale INTEGER NOT NULL DEFAULT 100,
  wallpaper_dim   INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'direct',
  name       TEXT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_direct_name ON chats (name) WHERE type = 'direct';

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id  TEXT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL DEFAULT 'text',
  body       TEXT NOT NULL DEFAULT '',
  media_url  TEXT,
  media_name TEXT,
  media_size BIGINT,
  mime       TEXT,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

CREATE TABLE IF NOT EXISTS message_status (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  at         BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_status_user ON message_status (user_id, message_id);

CREATE TABLE IF NOT EXISTS presence (
  user_id     TEXT NOT NULL,
  socket_id   TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  at          BIGINT NOT NULL,
  PRIMARY KEY (user_id, socket_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_user ON presence (user_id, at);

CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  caller_id  TEXT NOT NULL,
  callee_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'audio',
  state      TEXT NOT NULL DEFAULT 'ringing',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id);

CREATE TABLE IF NOT EXISTS bus (
  seq           BIGSERIAL PRIMARY KEY,
  msg_id        TEXT NOT NULL,
  from_instance TEXT NOT NULL,
  payload       TEXT NOT NULL,
  at            BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bus_at ON bus (at);
`;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  about         TEXT NOT NULL DEFAULT 'Hai! Saya sedang menggunakan Whatsap Indo.',
  verified      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL DEFAULT 0,
  wallpaper_type TEXT NOT NULL DEFAULT 'default',
  wallpaper_url  TEXT,
  wallpaper_mode TEXT NOT NULL DEFAULT 'cover',
  wallpaper_scale INTEGER NOT NULL DEFAULT 100,
  wallpaper_dim   INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'direct',
  name       TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_direct_name ON chats (name) WHERE type = 'direct';

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id  TEXT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL DEFAULT 'text',
  body       TEXT NOT NULL DEFAULT '',
  media_url  TEXT,
  media_name TEXT,
  media_size INTEGER,
  mime       TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS message_status (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_status_user ON message_status (user_id, message_id);

CREATE TABLE IF NOT EXISTS presence (
  user_id     TEXT NOT NULL,
  socket_id   TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, socket_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_user ON presence (user_id, at);

CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  caller_id  TEXT NOT NULL,
  callee_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'audio',
  state      TEXT NOT NULL DEFAULT 'ringing',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id);

CREATE TABLE IF NOT EXISTS bus (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id        TEXT NOT NULL,
  from_instance TEXT NOT NULL,
  payload       TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bus_at ON bus (at);
`;

const USER_MIGRATION = [
  ['verified', 'SMALLINT NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
  ['wallpaper_type', "TEXT NOT NULL DEFAULT 'default'", "TEXT NOT NULL DEFAULT 'default'"],
  ['wallpaper_url', 'TEXT', 'TEXT'],
  ['wallpaper_mode', "TEXT NOT NULL DEFAULT 'cover'", "TEXT NOT NULL DEFAULT 'cover'"],
  ['wallpaper_scale', 'INTEGER NOT NULL DEFAULT 100', 'INTEGER NOT NULL DEFAULT 100'],
  ['wallpaper_dim', 'INTEGER NOT NULL DEFAULT 20', 'INTEGER NOT NULL DEFAULT 20'],
];

function boot() {
  if (!bootPromise) {
    bootPromise = (DIALECT === 'pg' ? bootPg() : bootSqlite()).catch((err) => {
      // gagal boot (mis. koneksi DB sesaat) tidak boleh dikunci selamanya:
      // bersihkan state parsial supaya percobaan berikutnya bisa mengulang
      bootPromise = null;
      if (DIALECT === 'pg' && pool) {
        try { pool.end(); } catch { /* sudah ditutup */ }
        pool = null;
      }
      if (sqlite) {
        try { sqlite.close(); } catch { /* sudah tertutup */ }
        sqlite = null;
      }
      throw err;
    });
  }
  return bootPromise;
}

async function bootPg() {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v));
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 10,
  });
  pool.on('error', (err) => console.error('pg pool:', err.message));
  for (const stmt of statements(PG_SCHEMA)) {
    try {
      await pool.query(stmt);
    } catch (err) {
      if (!ignorableSchemaError(err)) throw err;
    }
  }
  await migratePg();
  await pool.query(`UPDATE users SET verified = 1 WHERE email = 'ovalkyzz@gmail.com'`);
}

function statements(schema) {
  return schema.split(';').map((s) => s.trim()).filter(Boolean);
}

function ignorableSchemaError(err) {
  return /already exists|duplicat|unique constraint|conflict/i.test(String(err && err.message));
}

async function migratePg() {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
  );
  const have = new Set(res.rows.map((r) => r.column_name));
  for (const [name, pgType] of USER_MIGRATION) {
    if (!have.has(name)) await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${pgType}`);
  }
}

async function bootSqlite() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'whatsap.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  for (const stmt of statements(SQLITE_SCHEMA)) {
    try {
      sqlite.exec(stmt);
    } catch (err) {
      if (!ignorableSchemaError(err)) throw err;
    }
  }
  const cols = sqlite.prepare('PRAGMA table_info(users)').all();
  const have = new Set(cols.map((c) => c.name));
  for (const [name, , liteType] of USER_MIGRATION) {
    if (!have.has(name)) sqlite.exec(`ALTER TABLE users ADD COLUMN ${name} ${liteType}`);
  }
  sqlite.prepare('UPDATE users SET verified = 1 WHERE email = ?').run('ovalkyzz@gmail.com');
}

function toPg(sql) {
  if (sql.indexOf('?') === -1) return sql;
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") out += sql[++i];
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '?') {
      out += '$' + ++n;
      continue;
    }
    out += ch;
  }
  return out;
}

function normalize(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

function locked(fn) {
  if (txStore.getStore()) return fn();
  const run = writeLock.then(fn, fn);
  writeLock = run.then(() => undefined, () => undefined);
  return run;
}

async function runQuery(sql, args) {
  await boot();
  const params = normalize(args);
  const tx = txStore.getStore();
  if (DIALECT === 'pg') {
    const executor = tx || pool;
    return executor.query(toPg(sql), params);
  }
  return locked(() => sqlite.prepare(sql).all(...params));
}

async function get(sql, ...args) {
  const rows = await all(sql, ...args);
  return rows[0];
}

async function all(sql, ...args) {
  const result = await runQuery(sql, args);
  if (DIALECT === 'pg') return result.rows;
  return result;
}

async function run(sql, ...args) {
  await boot();
  const params = normalize(args);
  const tx = txStore.getStore();
  if (DIALECT === 'pg') {
    const executor = tx || pool;
    const res = await executor.query(toPg(sql), params);
    return { changes: res.rowCount || 0 };
  }
  return locked(() => {
    const info = sqlite.prepare(sql).run(...params);
    return { changes: info.changes, lastID: Number(info.lastInsertRowid) };
  });
}

async function exec(sql) {
  await boot();
  const tx = txStore.getStore();
  if (DIALECT === 'pg') {
    const executor = tx || pool;
    return executor.query(sql);
  }
  return locked(() => sqlite.exec(sql));
}

async function transaction(fn) {
  await boot();
  if (DIALECT === 'pg') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch { /* transaksi sudah gagal */ }
      throw err;
    } finally {
      client.release();
    }
  }
  return locked(() => txStore.run(sqlite, () => fn(sqlite)));
}

async function acquireClient() {
  await boot();
  if (DIALECT !== 'pg') return null;
  const client = await pool.connect();
  return {
    query: (sql, ...args) => client.query(sql, ...args),
    release: () => client.release(),
  };
}

function close() {
  if (pool) pool.end().catch(() => undefined);
  if (sqlite) {
    try {
      sqlite.close();
    } catch { /* sudah tertutup */ }
  }
}

module.exports = {
  dialect: DIALECT,
  INSTANCE_ID,
  ready: boot,
  get,
  all,
  run,
  exec,
  transaction,
  acquireClient,
  close,
};
