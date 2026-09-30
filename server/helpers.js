'use strict';

const crypto = require('crypto');
const db = require('./db');
const presence = require('./presence');
const { verifiedOf, isPremium, isAdmin } = require('./auth');

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

async function chatRole(chatId, userId) {
  const row = await db.get(
    'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?',
    chatId,
    userId
  );
  return row ? row.role : null;
}

async function isGroupAdmin(chatId, userId) {
  const chat = await db.get('SELECT type FROM chats WHERE id = ?', chatId);
  if (!chat) return false;
  if (chat.type !== 'group') return false;
  return (await chatRole(chatId, userId)) === 'admin';
}

async function userMap(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;
  const rows = await db.all(`SELECT * FROM users WHERE id IN (${ph(uniq.length)})`, ...uniq);
  for (const row of rows) out.set(row.id, row);
  return out;
}

function serializeMessage(row, status, opts = {}) {
  if (!row) return null;
  const viewerId = opts.viewerId || null;
  const sender = opts.sender || null;
  const viewOnce = !!row.view_once;
  const consumed = viewOnce && !!row.opened_at && row.sender_id !== viewerId;
  const mediaOut = row.deleted_at
    ? null
    : viewOnce
      ? (consumed ? null : `/api/messages/media/${row.id}`)
      : row.media_url;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderName: sender ? sender.name : null,
    senderAvatar: sender ? sender.avatar : null,
    type: row.type,
    body: row.deleted_at ? '' : row.body,
    mediaUrl: mediaOut,
    mediaName: row.deleted_at ? null : row.media_name,
    mediaSize: row.deleted_at ? null : row.media_size,
    mime: row.deleted_at ? null : row.mime,
    duration: Number(row.duration) || 0,
    viewOnce,
    opened: consumed,
    createdAt: row.created_at,
    deleted: !!row.deleted_at,
    status: status || 'sent',
  };
}

// serialisasi daftar pesan: status centang + nama pengirim (untuk grup) sekali query
async function serializeMessages(rows, viewerId) {
  const statuses = await statusesFor(rows.map((r) => r.id));
  const senders = await userMap(rows.map((r) => r.sender_id));
  return rows.map((r) =>
    serializeMessage(r, statuses.get(r.id) || 'sent', {
      viewerId,
      sender: senders.get(r.sender_id) || null,
    })
  );
}

// status pesan; "read" dari pembaca yang menyalakan privasi laporan dibaca diabaikan
async function statusesFor(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await db.all(
    `SELECT s.message_id, s.status FROM message_status s
     WHERE s.message_id IN (${ph(ids.length)})
       AND NOT (s.status = 'read' AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = s.user_id AND u.priv_receipts = 1))`,
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

function serializeUser(row, viewerId, opts = {}) {
  if (!row) return null;
  const self = !viewerId || String(row.id) === String(viewerId);
  const canEmail = self || !row.priv_email;
  const canBio = self || !row.priv_bio;
  const canAvatar = self || !row.priv_avatar;
  const canSeen = self || !row.priv_last_seen;
  const out = {
    id: row.id,
    name: row.name,
    email: canEmail ? row.email : null,
    avatar: canAvatar ? row.avatar : null,
    about: canBio ? (row.about || '') : '',
    verified: verifiedOf(row),
    isBot: Number(row.is_bot) === 1,
    role: isAdmin(row) ? 'admin' : (row.role || 'user'),
    lastSeen: canSeen ? row.last_seen : 0,
  };
  if (opts.online !== undefined) out.online = canSeen ? !!opts.online : false;
  if (opts.premium !== undefined) {
    out.premium = isPremium(row) ? { plan: row.premium_plan || null, until: Number(row.premium_until) || 0 } : null;
  }
  return out;
}

async function loadChatBundle(rows, viewerId) {
  const bundle = {
    peers: new Map(), last: new Map(), unread: new Map(), statuses: new Map(),
    counts: new Map(), roles: new Map(), viewerId,
  };
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

  const countRows = await db.all(
    `SELECT chat_id, COUNT(*) AS n FROM chat_members WHERE chat_id IN (${ids}) GROUP BY chat_id`,
    ...chatIds
  );
  for (const row of countRows) bundle.counts.set(row.chat_id, Number(row.n));

  const roleRows = await db.all(
    `SELECT chat_id, role FROM chat_members WHERE chat_id IN (${ids}) AND user_id = ?`,
    ...chatIds,
    viewerId
  );
  for (const row of roleRows) bundle.roles.set(row.chat_id, row.role);

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
  const isGroup = row.type === 'group';
  return {
    id: row.id,
    type: row.type,
    name: isGroup ? row.name : null,
    avatar: isGroup ? row.avatar || null : null,
    memberCount: bundle.counts.get(row.id) || 0,
    role: bundle.roles.get(row.id) || null,
    createdBy: row.created_by || null,
    peer: peer
      ? {
          ...serializeUser(peer, bundle.viewerId, { online: !!(online && online.has(peer.id)), premium: false }),
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
  chatRole,
  isGroupAdmin,
  userMap,
  serializeMessage,
  serializeMessages,
  serializeUser,
  serializeChats,
  loadChatBundle,
  buildChat,
  touchRead,
  statusesFor,
  messageStatus,
};
