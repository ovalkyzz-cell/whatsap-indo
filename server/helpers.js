'use strict';

const crypto = require('crypto');
const db = require('./db');

function directKey(a, b) {
  return [a, b].sort().join(':');
}

function getOrCreateDirectChat(userA, userB) {
  const key = directKey(userA, userB);
  const existing = db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
       WHERE c.type = 'direct' AND c.name = ?`
    )
    .get(userA, userB, key);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO chats (id, type, name, created_at) VALUES (?, 'direct', ?, ?)`
    ).run(id, key, now);
    const ins = db.prepare(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
    );
    ins.run(id, userA, now);
    ins.run(id, userB, now);
  });
  tx();
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
}

function getChatMemberIds(chatId) {
  return db
    .prepare('SELECT user_id FROM chat_members WHERE chat_id = ?')
    .all(chatId)
    .map((r) => r.user_id);
}

function isMember(chatId, userId) {
  return !!db
    .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId);
}

function serializeMessage(row) {
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
    status: messageStatus(row.id),
  };
}

function messageStatus(messageId) {
  const rows = db
    .prepare('SELECT status FROM message_status WHERE message_id = ?')
    .all(messageId);
  if (rows.some((r) => r.status === 'read')) return 'read';
  if (rows.some((r) => r.status === 'delivered')) return 'delivered';
  return 'sent';
}

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatar: row.avatar,
    about: row.about,
    lastSeen: row.last_seen,
  };
}

function serializeChat(row, viewerId, onlineMap) {
  const members = db
    .prepare(
      `SELECT u.* FROM chat_members m JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = ? AND m.user_id != ?`
    )
    .all(row.id, viewerId);

  const peer = members[0] || null;
  const last = db
    .prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    .get(row.id);

  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       WHERE m.chat_id = ? AND m.sender_id != ? AND m.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM message_status s
           WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read'
         )`
    )
    .get(row.id, viewerId, viewerId).n;

  return {
    id: row.id,
    type: row.type,
    name: row.type === 'group' ? row.name : null,
    peer: peer
      ? {
          ...serializeUser(peer),
          online: !!onlineMap[peer.id],
        }
      : null,
    lastMessage: serializeMessage(last),
    unread,
    createdAt: row.created_at,
  };
}

function touchRead(chatId, userId) {
  db.prepare(
    `UPDATE message_status SET status = 'read', at = ?
     WHERE user_id = ? AND status != 'read'
       AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`
  ).run(Date.now(), userId, chatId);
}

module.exports = {
  directKey,
  getOrCreateDirectChat,
  getChatMemberIds,
  isMember,
  serializeMessage,
  serializeUser,
  serializeChat,
  touchRead,
  messageStatus,
};
