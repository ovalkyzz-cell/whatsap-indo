'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const auth = require('./auth');
const helpers = require('./helpers');
const { router: uploadRouter, UPLOAD_DIR } = require('./upload');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: { origin: true },
});

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, acceptRanges: true }));
app.use('/api', uploadRouter);

// ---------- realtime state ----------
const online = new Map(); // userId -> Set<socketId>
const socketsByUser = new Map(); // socketId -> userId

function isOnline(userId) {
  return online.has(userId);
}

function emitToUser(userId, event, payload) {
  const set = online.get(userId);
  if (!set) return false;
  for (const sid of set) io.to(sid).emit(event, payload);
  return true;
}

function userSockets(userId) {
  return [...(online.get(userId) || [])];
}

// ---------- auth routes ----------
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const result = await auth.register(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    res.json(await auth.login(req.body || {}));
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ---------- users ----------
app.get('/api/users/search', auth.requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT * FROM users WHERE id != ? AND (email LIKE ? OR name LIKE ?)
       ORDER BY name COLLATE NOCASE LIMIT 30`
    )
    .all(req.user.id, like, like);
  res.json({
    users: rows.map((r) => ({ ...auth.publicUser(r), online: isOnline(r.id) })),
  });
});

app.get('/api/users/:id', auth.requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ user: { ...auth.publicUser(row), online: isOnline(row.id) } });
});

app.patch('/api/me', auth.requireAuth, (req, res) => {
  const { name, about, avatar } = req.body || {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter' });
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trimmed, req.user.id);
  }
  if (about !== undefined) {
    db.prepare('UPDATE users SET about = ? WHERE id = ?').run(String(about).slice(0, 200), req.user.id);
  }
  if (avatar !== undefined) {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar || null, req.user.id);
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: auth.publicUser(row) });
});

// ---------- chats ----------
function listChats(userId) {
  const rows = db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
       ORDER BY c.created_at DESC`
    )
    .all(userId);

  const chats = rows.map((r) => helpers.serializeChat(r, userId, Object.fromEntries(
    [...online.keys()].map((k) => [k, true])
  )));

  chats.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.createdAt : a.createdAt;
    const tb = b.lastMessage ? b.lastMessage.createdAt : b.createdAt;
    return tb - ta;
  });
  return chats;
}

app.get('/api/chats', auth.requireAuth, (req, res) => {
  res.json({ chats: listChats(req.user.id) });
});

app.post('/api/chats/direct', auth.requireAuth, (req, res) => {
  const peerId = String(req.body?.peerId || '');
  const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(peerId);
  if (!peer) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  const chat = helpers.getOrCreateDirectChat(req.user.id, peerId);
  const rows = db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
       WHERE c.id = ?`
    )
    .get(req.user.id, chat.id);
  res.status(201).json({
    chat: helpers.serializeChat(rows, req.user.id, Object.fromEntries(
      [...online.keys()].map((k) => [k, true])
    )),
  });
});

app.get('/api/chats/:id/messages', auth.requireAuth, (req, res) => {
  if (!helpers.isMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const before = req.query.before ? Number(req.query.before) : Date.now();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(req.params.id, before, limit);
  res.json({
    messages: rows.reverse().map(helpers.serializeMessage),
    hasMore: rows.length === limit,
  });
});

app.post('/api/chats/:id/read', auth.requireAuth, (req, res) => {
  if (!helpers.isMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  markChatRead(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/chats/:id/typing', auth.requireAuth, (req, res) => {
  if (!helpers.isMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const typing = !!req.body?.typing;
  for (const uid of helpers.getChatMemberIds(req.params.id)) {
    if (uid === req.user.id) continue;
    emitToUser(uid, 'typing', { chatId: req.params.id, userId: req.user.id, typing });
  }
  res.json({ ok: true });
});

function markChatRead(chatId, userId) {
  helpers.touchRead(chatId, userId);
  const rows = db
    .prepare(
      `SELECT m.id, m.sender_id FROM messages m
       WHERE m.chat_id = ? AND m.sender_id != ?
         AND EXISTS (SELECT 1 FROM message_status s
                     WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read')`
    )
    .all(chatId, userId, userId);
  for (const r of rows) {
    emitToUser(r.sender_id, 'message:status', { messageId: r.id, chatId, status: 'read' });
  }
}

app.delete('/api/messages/:id', auth.requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Bukan pesan Anda' });
  db.prepare(`UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?`).run(Date.now(), row.id);
  const payload = { ...helpers.serializeMessage({ ...row, deleted_at: Date.now(), body: '' }) };
  for (const uid of helpers.getChatMemberIds(row.chat_id)) {
    emitToUser(uid, 'message:deleted', payload);
  }
  res.json({ ok: true });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Terjadi kesalahan' });
});

// ---------- socket.io ----------
io.use((socket, next) => {
  const payload = auth.verifyToken(socket.handshake.auth?.token || '');
  if (!payload) return next(new Error('Tidak terautentikasi'));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return next(new Error('Akun tidak ditemukan'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  const first = !online.has(user.id);
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(socket.id);
  socketsByUser.set(socket.id, user.id);
  if (first) broadcastPresence(user.id, true);

  socket.join(`user:${user.id}`);

  socket.on('message:send', (payload, ack) => {
    try {
      const result = handleSend(user, payload);
      ack?.({ ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: err.message || 'Gagal mengirim pesan' });
    }
  });

  socket.on('typing', ({ chatId, typing } = {}) => {
    if (!helpers.isMember(chatId, user.id)) return;
    for (const uid of helpers.getChatMemberIds(chatId)) {
      if (uid === user.id) continue;
      emitToUser(uid, 'typing', { chatId, userId: user.id, typing: !!typing });
    }
  });

  socket.on('chat:read', ({ chatId } = {}) => {
    if (helpers.isMember(chatId, user.id)) markChatRead(chatId, user.id);
  });

  // ---------- WebRTC signaling ----------
  socket.on('call:invite', ({ to, callId, kind } = {}, ack) => {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
    if (!target) return ack?.({ ok: false, error: 'Pengguna tidak ditemukan' });
    const delivered = emitToUser(to, 'call:incoming', {
      callId,
      kind: kind === 'video' ? 'video' : 'audio',
      from: { id: user.id, name: user.name, avatar: user.avatar },
    });
    if (!delivered) return ack?.({ ok: false, error: 'Pengguna sedang offline' });
    ack?.({ ok: true, delivered: true });
  });

  socket.on('call:signal', ({ to, callId, signal }) => {
    emitToUser(to, 'call:signal', {
      callId,
      from: { id: user.id, name: user.name, avatar: user.avatar },
      signal,
    });
  });

  socket.on('call:reject', ({ to, callId }) => {
    emitToUser(to, 'call:ended', { callId, reason: 'rejected' });
  });

  socket.on('call:hangup', ({ to, callId }) => {
    emitToUser(to, 'call:ended', { callId, reason: 'ended' });
  });

  socket.on('disconnect', () => {
    const set = online.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(user.id);
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);
        broadcastPresence(user.id, false);
      }
    }
    socketsByUser.delete(socket.id);
  });
});

function broadcastPresence(userId, connected) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const payload = { userId, online: connected, lastSeen: row?.last_seen || Date.now() };
  const contacts = db
    .prepare(
      `SELECT DISTINCT m2.user_id FROM chat_members m1
       JOIN chat_members m2 ON m2.chat_id = m1.chat_id
       WHERE m1.user_id = ? AND m2.user_id != ?`
    )
    .all(userId, userId);
  for (const c of contacts) emitToUser(c.user_id, 'presence', payload);
  emitToUser(userId, 'presence', payload);
}

function handleSend(user, payload) {
  const { chatId, type = 'text', body = '', media } = payload || {};
  if (!chatId || !helpers.isMember(chatId, user.id)) {
    throw new Error('Bukan anggota chat ini');
  }

  const cleanType = ['text', 'image', 'video', 'audio', 'file'].includes(type) ? type : 'text';
  if (cleanType === 'text' && !String(body).trim()) throw new Error('Pesan kosong');

  const id = require('crypto').randomUUID();
  const now = Date.now();
  const mediaUrl = cleanType === 'text' ? null : media?.url || null;
  if (cleanType !== 'text' && !mediaUrl) throw new Error('Media tidak ditemukan');

  db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_size, mime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    chatId,
    user.id,
    cleanType,
    String(body || '').slice(0, 8000),
    mediaUrl,
    media?.name ? String(media.name).slice(0, 255) : null,
    media?.size ? Number(media.size) : null,
    media?.mime || null,
    now
  );

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const message = helpers.serializeMessage(row);
  const members = helpers.getChatMemberIds(chatId);

  for (const uid of members) {
    if (uid === user.id) continue;
    const delivered = emitToUser(uid, 'message:new', message);
    if (delivered) {
      db.prepare(
        `INSERT INTO message_status (message_id, user_id, status, at) VALUES (?, ?, 'delivered', ?)
         ON CONFLICT(message_id, user_id) DO NOTHING`
      ).run(id, uid, now);
    }
  }

  const fresh = helpers.serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));

  if (fresh.status === 'delivered') {
    emitToUser(user.id, 'message:status', { messageId: id, chatId, status: 'delivered' });
  }

  for (const uid of members) {
    emitToUser(uid, 'chat:updated', { chatId });
  }

  return { message: fresh };
}

server.listen(PORT, () => {
  console.log(`Whatsap Indo berjalan di http://localhost:${PORT}`);
});
