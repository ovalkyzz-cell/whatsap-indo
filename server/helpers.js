'use strict';

const crypto = require('crypto');
const db = require('./db');
const presence = require('./presence');
const vault = require('./vault');
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

async function getChatRole(chatId, userId) {
  const row = await db.get('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, userId);
  return row ? row.role : null;
}

async function isGroupAdmin(chatId, userId) {
  const role = await getChatRole(chatId, userId);
  return role === 'admin';
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
      // chat dengan diri sendiri hanya punya satu baris anggota (PRIMARY KEY chat_id+user_id)
      const members = userA === userB ? [userA] : [userA, userB];
      for (const member of members) {
        await db.run(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
          id,
          member,
          now
        );
      }
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
  if ((await chatRole(chatId, userId)) === 'admin') return true;
  // admin situs selalu dianggap admin grup: kelola anggota/bot/grup tanpa kendala
  const user = await db.get('SELECT role, email FROM users WHERE id = ?', userId);
  return isAdmin(user);
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
  let replyPreview = null;
  if (row.reply_preview) {
    // reply_preview disimpan terenkripsi (vault) -> dekripsi sebelum di-parse
    try { replyPreview = JSON.parse(vault.decrypt(row.reply_preview)); } catch { replyPreview = null; }
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderName: sender ? sender.name : null,
    senderAvatar: sender ? sender.avatar : null,
    type: row.type,
    body: row.deleted_at ? '' : vault.decrypt(row.body),
    mediaUrl: mediaOut,
    mediaName: row.deleted_at ? null : row.media_name,
    mediaSize: row.deleted_at ? null : row.media_size,
    mime: row.deleted_at ? null : row.mime,
    duration: Number(row.duration) || 0,
    viewOnce,
    opened: consumed,
    replyTo: row.reply_to || null,
    replyPreview,
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
    counts: new Map(), roles: new Map(), archived: new Map(), bots: new Map(),
    mutes: new Map(), cleared: new Map(), blockedByMe: new Set(), blockedMe: new Set(),
    viewerId,
  };
  const chatIds = rows.map((r) => r.id);
  if (!chatIds.length) return bundle;
  const ids = ph(chatIds.length);

  const peerRows = await db.all(
    `SELECT m.chat_id, u.* FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id IN (${ids})
     ORDER BY CASE WHEN m.user_id = ? THEN 1 ELSE 0 END`,
    ...chatIds,
    viewerId
  );
  for (const row of peerRows) {
    if (!bundle.peers.has(row.chat_id)) bundle.peers.set(row.chat_id, row);
    // anggota bot di grup -> disimpan terpisah supaya frontend bisa menampilkan
    // "grup punya bot" & mengaktifkan UI @mention
    if (Number(row.is_bot) === 1) bundle.bots.set(row.chat_id, row);
  }

  // status blokir dua arah terhadap peer tiap chat (hanya relevan di chat pribadi)
  const peerIds = [...bundle.peers.values()].map((p) => p.id).filter(Boolean);
  if (peerIds.length) {
    const blockRows = await db.all(
      `SELECT blocker_id, blocked_id FROM user_blocks
       WHERE (blocker_id = ? AND blocked_id IN (${ph(peerIds.length)}))
          OR (blocked_id = ? AND blocker_id IN (${ph(peerIds.length)}))`,
      viewerId,
      ...peerIds,
      viewerId,
      ...peerIds
    );
    for (const r of blockRows) {
      if (String(r.blocker_id) === String(viewerId)) bundle.blockedByMe.add(r.blocked_id);
      else if (String(r.blocked_id) === String(viewerId)) bundle.blockedMe.add(r.blocker_id);
    }
  }

  const countRows = await db.all(
    `SELECT chat_id, COUNT(*) AS n FROM chat_members WHERE chat_id IN (${ids}) GROUP BY chat_id`,
    ...chatIds
  );
  for (const row of countRows) bundle.counts.set(row.chat_id, Number(row.n));

  const roleRows = await db.all(
    `SELECT chat_id, role, archived, cleared_at FROM chat_members WHERE chat_id IN (${ids}) AND user_id = ?`,
    ...chatIds,
    viewerId
  );
  for (const row of roleRows) {
    bundle.roles.set(row.chat_id, row.role);
    bundle.archived.set(row.chat_id, !!row.archived);
    bundle.cleared.set(row.chat_id, Number(row.cleared_at) || 0);
  }

  // pesan terakhir per chat — hanya yang sesudah "hapus percakapan" milik viewer
  // (chat yang dihapus menampilkan last=null sampai ada pesan baru masuk)
  const lastRows = await db.all(
    `SELECT m.* FROM messages m
     JOIN (SELECT chat_id, MAX(created_at) AS mx FROM messages WHERE chat_id IN (${ids}) GROUP BY chat_id) t
       ON t.chat_id = m.chat_id AND m.created_at = t.mx
     WHERE m.created_at > COALESCE(
       (SELECT cm.cleared_at FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id = ?), 0)`,
    ...chatIds,
    viewerId
  );
  for (const row of lastRows) {
    const prev = bundle.last.get(row.chat_id);
    if (!prev || String(row.id) > String(prev.id)) bundle.last.set(row.chat_id, row);
  }

  const unreadRows = await db.all(
    `SELECT m.chat_id, COUNT(*) AS n FROM messages m
     JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
     WHERE m.chat_id IN (${ids}) AND m.sender_id <> ? AND m.deleted_at IS NULL
       AND m.created_at > COALESCE(cm.cleared_at, 0)
       AND NOT EXISTS (SELECT 1 FROM message_status s
                       WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read')
     GROUP BY m.chat_id`,
    viewerId,
    ...chatIds,
    viewerId,
    viewerId
  );
  for (const row of unreadRows) bundle.unread.set(row.chat_id, Number(row.n));

  // notifikasi chat per penerima (bisukan percakapan ini)
  const muteRows = await db.all(
    `SELECT chat_id FROM chat_notifs WHERE chat_id IN (${ids}) AND user_id = ? AND muted = 1`,
    ...chatIds,
    viewerId
  );
  for (const row of muteRows) bundle.mutes.set(row.chat_id, true);

  const statusIds = [...bundle.last.values()].map((m) => m.id);
  if (statusIds.length) bundle.statuses = await statusesFor(statusIds);
  return bundle;
}

function buildChat(row, bundle, online) {
  const peer = bundle.peers.get(row.id) || null;
  const last = bundle.last.get(row.id) || null;
  const isGroup = row.type === 'group';
  const botRow = isGroup ? bundle.bots.get(row.id) || null : null;
  const clearedAt = Number(bundle.cleared.get(row.id)) || 0;
  return {
    id: row.id,
    type: row.type,
    name: isGroup ? row.name : null,
    avatar: isGroup ? row.avatar || null : null,
    memberCount: bundle.counts.get(row.id) || 0,
    role: bundle.roles.get(row.id) || null,
    createdBy: row.created_by || null,
    // bot yang terpasang di grup (null kalau tidak ada) — frontend memakai ini
    // untuk menampilkan badge bot & pintu @mention di composer
    bot: botRow
      ? { id: botRow.id, name: botRow.name, avatar: botRow.avatar || null, verified: true }
      : null,
    peer: peer
      ? {
          ...serializeUser(peer, bundle.viewerId, { online: !!(online && online.has(peer.id)), premium: false }),
          // blokir kontak: pengirim & penerima tidak boleh saling mengirim
          // di chat pribadi sampai blokir dibuka
          blockedByMe: bundle.blockedByMe.has(peer.id),
          blockedMe: bundle.blockedMe.has(peer.id),
        }
      : null,
    lastMessage: last ? serializeMessage(last, bundle.statuses.get(last.id) || 'sent') : null,
    unread: bundle.unread.get(row.id) || 0,
    archived: !!bundle.archived.get(row.id),
    muted: !!bundle.mutes.get(row.id),
    // hapus percakapan per-pengguna: hidden=true -> disembunyikan dari daftar
    // sampai ada pesan baru sesudah waktu hapus
    clearedAt,
    hidden: clearedAt > 0 && !last,
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
  const now = Date.now();
  await db.run(
    `UPDATE message_status SET status = 'read', at = ?
     WHERE user_id = ? AND status != 'read'
       AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`,
    now,
    userId,
    chatId
  );
  // Penerima yang sedang luring tidak pernah mendapat baris saat pesan dikirim,
  // padahal angka belum-dibaca & centang biru dihitung lewat keberadaan baris
  // 'read' -> buat barisnya sekarang supaya benar-benar terhapus/dilaporkan.
  await db.run(
    `INSERT INTO message_status (message_id, user_id, status, at)
     SELECT id, ?, 'read', ? FROM messages
      WHERE chat_id = ? AND sender_id <> ? AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM message_status s
                        WHERE s.message_id = messages.id AND s.user_id = ?)
     ON CONFLICT (message_id, user_id) DO NOTHING`,
    userId,
    now,
    chatId,
    userId,
    userId
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
