'use strict';

const crypto = require('crypto');
const db = require('./db');
const presence = require('./presence');

function directKey(a, b) {
  return [a, b].sort().join(':');
}

function ph(n) {
  return Array(n).fill('?').join(', ');
}

function isUniqueViolation(err) {
  const code = String((err && err.code) || '');
  if (code === '23505') return true;
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((err && err.message) || ''));
}

async function findDirectChat(userA, userB, key) {
  return db.get(
    `SELECT c.* FROM chats c
     JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
     JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
     WHERE c.type = 'direct' AND c.name = ?`,
    userA,
    userB,
    key
  );
}

async function getOrCreateDirectChat(userA, userB) {
  const key = directKey(userA, userB);
  const existing = await findDirectChat(userA, userB, key);
  if (existing) return existing;

  try {
    return await db.transaction(async () => {
      const again = await findDirectChat(userA, userB, key);
      if (again) return again;
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.run(`INSERT INTO chats (id, type, name, created_at) VALUES (?, 'direct', ?, ?)`, id, key, now);
      await db.run(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        id,
        userA,
        now
      );
      await db.run(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        id,
        userB,
        now
      );
      return db.get('SELECT * FROM chats WHERE id = ?', id);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await findDirectChat(userA, userB, key);
      if (raced) return raced;
    }
    throw err;
  }
}

async function getChatMemberIds(chatId) {
  const rows = await db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', chatId);
  return rows.map((r) => r.user_id);
}

async function isMember(chatId, userId) {
  const row = await db.get(
    'SELECT 1 AS member FROM chat_members WHERE chat_id = ? AND user_id = ?',
    chatId,
    userId
  );
  return !!row;
}

function serializeMessage(row, status) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    type: row.type,
    body: row.deleted_at ? '' : row.body,
    mediaUrl: row.deleted_at ? null : row.media_url,
    mediaName: row.deleted_at ? null : row.media_name,
    mediaSize: row.deleted_at ? null : row.media_size,
    mime: row.deleted_at ? null : row.mime,
    createdAt: row.created_at,
    deleted: !!row.deleted_at,
    status: status || 'sent',
  };
}

async function statusesFor(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await db.all(
    `SELECT message_id, status FROM message_status WHERE message_id IN (${ph(ids.length)})`,
    ...ids
  );
  for (const row of rows) if (row.status === 'delivered') out.set(row.message_id, 'delivered');
  for (const row of rows) if (row.status === 'read') out.set(row.message_id, 'read');
  return out;
}

async function messageStatus(messageId) {
  const map = await statusesFor([messageId]);
  return map.get(messageId) || 'sent';
}

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatar: row.avatar,
    about: row.about,
    verified: !!row.verified,
    lastSeen: row.last_seen,
  };
}

async function loadChatBundle(rows, viewerId) {
  const bundle = { peers: new Map(), last: new Map(), unread: new Map(), statuses: new Map() };
  const chatIds = rows.map((r) => r.id);
  if (!chatIds.length) return bundle;
  const ids = ph(chatIds.length);

  const peerRows = await db.all(
    `SELECT m.chat_id, u.* FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id IN (${ids}) AND m.user_id <> ?`,
    ...chatIds,
    viewerId
  );
  for (const row of peerRows) {
    if (!bundle.peers.has(row.chat_id)) bundle.peers.set(row.chat_id, row);
  }

  const lastRows = await db.all(
    `SELECT m.* FROM messages m
     JOIN (SELECT chat_id, MAX(created_at) AS mx FROM messages WHERE chat_id IN (${ids}) GROUP BY chat_id) t
       ON t.chat_id = m.chat_id AND m.created_at = t.mx`,
    ...chatIds
  );
  for (const row of lastRows) {
    const prev = bundle.last.get(row.chat_id);
    if (!prev || String(row.id) > String(prev.id)) bundle.last.set(row.chat_id, row);
  }

  const unreadRows = await db.all(
    `SELECT m.chat_id, COUNT(*) AS n FROM messages m
     WHERE m.chat_id IN (${ids}) AND m.sender_id <> ? AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM message_status s
                       WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read')
     GROUP BY m.chat_id`,
    ...chatIds,
    viewerId,
    viewerId
  );
  for (const row of unreadRows) bundle.unread.set(row.chat_id, Number(row.n));

  const statusIds = [...bundle.last.values()].map((m) => m.id);
  if (statusIds.length) bundle.statuses = await statusesFor(statusIds);
  return bundle;
}

function buildChat(row, bundle, online) {
  const peer = bundle.peers.get(row.id) || null;
  const last = bundle.last.get(row.id) || null;
  return {
    id: row.id,
    type: row.type,
    name: row.type === 'group' ? row.name : null,
    peer: peer
      ? {
          ...serializeUser(peer),
          online: !!(online && online.has(peer.id)),
        }
      : null,
    lastMessage: last ? serializeMessage(last, bundle.statuses.get(last.id) || 'sent') : null,
    unread: bundle.unread.get(row.id) || 0,
    createdAt: row.created_at,
  };
}

async function serializeChats(rows, viewerId) {
  const bundle = await loadChatBundle(rows, viewerId);
  const peerIds = [...bundle.peers.values()].map((p) => p.id);
  const online = await presence.onlineSet(peerIds);
  return rows.map((row) => buildChat(row, bundle, online));
}

async function touchRead(chatId, userId) {
  await db.run(
    `UPDATE message_status SET status = 'read', at = ?
     WHERE user_id = ? AND status != 'read'
       AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`,
    Date.now(),
    userId,
    chatId
  );
}

module.exports = {
  directKey,
  getOrCreateDirectChat,
  getChatMemberIds,
  isMember,
  serializeMessage,
  serializeUser,
  serializeChats,
  loadChatBundle,
  buildChat,
  touchRead,
  statusesFor,
  messageStatus,
};
