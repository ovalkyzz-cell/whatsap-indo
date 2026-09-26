'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'whatsap.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  about         TEXT NOT NULL DEFAULT 'Hai! Saya sedang menggunakan Whatsap Indo.',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'direct',
  name      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

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
`);

module.exports = db;
