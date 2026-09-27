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

// File yang aman ditampilkan inline; sisanya dipaksa unduh (mencegah XSS
// lewat file HTML/SVG buatan pengguna pada origin yang sama).
const INLINE_SAFE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mp3|ogg|wav|m4a|opus|aac|flac|pdf|txt|csv)$/i;
const SVG_EXT = /\.svg$/i;
app.use('/uploads', express.static(UPLOAD_DIR, {
  fallthrough: false,
  acceptRanges: true,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (SVG_EXT.test(filePath)) {
      // SVG tetap bisa dipakai sebagai <img>, tapi wajib diunduh saat dibuka langsung
      res.setHeader('Content-Disposition', 'attachment');
      return;
    }
    if (!INLINE_SAFE.test(filePath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));
app.use('/api', uploadRouter);

// ---------- rate limit (brute force auth) ----------
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k);
  }, windowMs);
  sweeper.unref();
  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.first > windowMs) {
      entry = { first: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa saat lagi.' });
    }
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 60_000, max: 60 });

// ---------- realtime state ----------
const online = new Map(); // userId -> Set<socketId>
const socketsByUser = new Map(); // socketId -> userId
const calls = new Map(); // callId -> { a: callerId, b: calleeId, state }

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

function emitToUserExcept(userId, exceptSocketId, event, payload) {
  const set = online.get(userId);
  if (!set) return false;
  let sent = false;
  for (const sid of set) {
    if (sid === exceptSocketId) continue;
    io.to(sid).emit(event, payload);
    sent = true;
  }
  return sent;
}

function publicCaller(row) {
  return { id: row.id, name: row.name, avatar: row.avatar, verified: !!row.verified };
}

// ---------- auth routes ----------
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const result = await auth.register(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
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
  const { name, about, avatar, wallpaper } = req.body || {};
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
  if (wallpaper !== undefined && wallpaper !== null) {
    const type = ['default', 'image', 'video'].includes(wallpaper?.type) ? wallpaper.type : 'default';
    const url = type === 'default' ? null : String(wallpaper?.url || '');
    if (type !== 'default' && !/^\/uploads\/[\w.\-]+$/.test(url)) {
      return res.status(400).json({ error: 'Latar belakang tidak valid' });
    }
    const mode = ['cover', 'contain', 'tile'].includes(wallpaper?.mode) ? wallpaper.mode : 'cover';
    const scale = Math.min(300, Math.max(50, Math.round(Number(wallpaper?.scale) || 100)));
    const dim = Math.min(70, Math.max(0, Math.round(Number(wallpaper?.dim))));
    db.prepare(
      `UPDATE users SET wallpaper_type = ?, wallpaper_url = ?, wallpaper_mode = ?,
        wallpaper_scale = ?, wallpaper_dim = ? WHERE id = ?`
    ).run(type, url, mode, scale, Number.isFinite(dim) ? dim : 20, req.user.id);
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
    const reply = (payload) => { try { ack?.(payload); } catch { /* ack sudah ditutup */ } };
    const targetId = String(to || '');
    const id = String(callId || '');
    if (!id) return reply({ ok: false, error: 'Permintaan panggilan tidak valid' });
    if (!targetId || targetId === user.id) return reply({ ok: false, error: 'Tidak dapat menelepon pengguna ini' });
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) return reply({ ok: false, error: 'Pengguna tidak ditemukan' });

    calls.set(id, { a: user.id, b: targetId, state: 'ringing' });
    const delivered = emitToUser(targetId, 'call:incoming', {
      callId: id,
      kind: kind === 'video' ? 'video' : 'audio',
      from: publicCaller(user),
    });
    if (!delivered) {
      calls.delete(id);
      return reply({ ok: false, error: 'Pengguna sedang offline' });
    }
    reply({ ok: true, delivered: true });
  });

  socket.on('call:accept', ({ callId } = {}) => {
    const id = String(callId || '');
    const call = calls.get(id);
    if (!call || (call.a !== user.id && call.b !== user.id)) return;
    call.state = 'accepted';
    // tab/perangkat lain milik penerima masih berdering -> tutup
    emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'accepted' });
  });

  socket.on('call:signal', ({ to, callId, signal } = {}) => {
    const targetId = String(to || '');
    const id = String(callId || '');
    if (!id || !targetId || targetId === user.id) return;
    const call = calls.get(id);
    if (!call || (call.a !== user.id && call.b !== user.id)) return;
    if (!signal || typeof signal !== 'object') return;
    if (!['offer', 'answer', 'candidate'].includes(signal.type)) return;
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) return;
    if (signal.type === 'answer') call.state = 'active';
    emitToUser(targetId, 'call:signal', {
      callId: id,
      from: publicCaller(user),
      signal,
    });
  });

  socket.on('call:reject', ({ to, callId } = {}) => {
    const id = String(callId || '');
    const targetId = String(to || '');
    calls.delete(id);
    if (targetId && targetId !== user.id) emitToUser(targetId, 'call:ended', { callId: id, reason: 'rejected' });
    emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'cancelled' });
  });

  socket.on('call:hangup', ({ to, callId, reason } = {}) => {
    const id = String(callId || '');
    const targetId = String(to || '');
    calls.delete(id);
    const mapped = reason === 'timeout' ? 'timeout' : 'ended';
    if (targetId && targetId !== user.id) emitToUser(targetId, 'call:ended', { callId: id, reason: mapped });
    emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'ended' });
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

    // panggilan yang masih berdering berhenti saat penelepon/penerima keluar;
    // panggilan aktif dibiarkan (WebRTC P2P) dan dibersihkan bila kedua pihak pergi
    for (const [id, call] of [...calls]) {
      if (call.a !== user.id && call.b !== user.id) continue;
      if (call.state === 'ringing') {
        calls.delete(id);
        const other = call.a === user.id ? call.b : call.a;
        emitToUser(other, 'call:ended', { callId: id, reason: 'ended' });
      } else if (!online.has(call.a) && !online.has(call.b)) {
        calls.delete(id);
      }
    }
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
