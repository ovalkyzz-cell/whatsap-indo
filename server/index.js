'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const auth = require('./auth');
const helpers = require('./helpers');
const presence = require('./presence');
const calls = require('./calls');
const bus = require('./bus');
const { router: uploadRouter, UPLOAD_DIR } = require('./upload');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: { origin: true },
});

presence.bind((socketId, event, payload) => io.to(socketId).emit(event, payload));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// ---------- pengiriman event (lokal + relay ke instance lain) ----------
async function dispatch(pairs) {
  if (!pairs.length) return { local: false, remote: new Set() };
  const groups = new Map();
  let local = false;
  for (const pair of pairs) {
    const except = pair.except || null;
    if (presence.emitLocal(pair.userId, pair.event, pair.payload, except)) local = true;
    const key = JSON.stringify([pair.event, except, pair.payload]);
    let group = groups.get(key);
    if (!group) {
      group = { event: pair.event, payload: pair.payload, except, userIds: [] };
      groups.set(key, group);
    }
    if (!group.userIds.includes(pair.userId)) group.userIds.push(pair.userId);
  }

  const userIds = [...new Set(pairs.map((p) => p.userId))];
  const remote = new Set(await presence.remoteIds(userIds));
  for (const group of groups.values()) {
    const targets = group.userIds.filter((uid) => remote.has(uid));
    if (!targets.length) continue;
    group.userIds = targets;
    try {
      await bus.publish(group);
    } catch (err) {
      console.error('bus publish:', err.message);
    }
  }
  return { local, remote };
}

async function emitToUser(userId, event, payload) {
  const result = await dispatch([{ userId, event, payload }]);
  return result.local || result.remote.has(userId);
}

async function emitToUserExcept(userId, exceptSocketId, event, payload) {
  const result = await dispatch([{ userId, event, payload, except: exceptSocketId }]);
  return result.local || result.remote.has(userId);
}

async function emitToUsers(userIds, event, payload) {
  await dispatch(userIds.map((userId) => ({ userId, event, payload })));
}

function publicCaller(row) {
  return { id: row.id, name: row.name, avatar: row.avatar, verified: !!row.verified };
}

// ---------- auth routes ----------
app.post('/api/auth/register', authLimiter, ah(async (req, res) => {
  res.status(201).json(await auth.register(req.body || {}));
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  res.json(await auth.login(req.body || {}));
}));

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ---------- users ----------
app.get('/api/users/search', auth.requireAuth, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = await db.all(
    `SELECT * FROM users WHERE id <> ? AND (LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?))
     ORDER BY LOWER(name) LIMIT 30`,
    req.user.id,
    like,
    like
  );
  const online = await presence.onlineSet(rows.map((r) => r.id));
  res.json({
    users: rows.map((r) => ({ ...auth.publicUser(r), online: online.has(r.id) })),
  });
}));

app.get('/api/users/:id', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ user: { ...auth.publicUser(row), online: await presence.isOnline(row.id) } });
}));

app.patch('/api/me', auth.requireAuth, ah(async (req, res) => {
  const { name, about, avatar, wallpaper } = req.body || {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter' });
    await db.run('UPDATE users SET name = ? WHERE id = ?', trimmed, req.user.id);
  }
  if (about !== undefined) {
    await db.run('UPDATE users SET about = ? WHERE id = ?', String(about).slice(0, 200), req.user.id);
  }
  if (avatar !== undefined) {
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', avatar || null, req.user.id);
  }
  if (wallpaper !== undefined && wallpaper !== null) {
    const type = ['default', 'image', 'video'].includes(wallpaper?.type) ? wallpaper.type : 'default';
    const url = type === 'default' ? null : String(wallpaper?.url || '');
    const validUrl = /^\/uploads\/[\w.\-]+$/.test(url)
      || /^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\/[\w.%\-/~]+$/.test(url);
    if (type !== 'default' && !validUrl) {
      return res.status(400).json({ error: 'Latar belakang tidak valid' });
    }
    const mode = ['cover', 'contain', 'tile'].includes(wallpaper?.mode) ? wallpaper.mode : 'cover';
    const scale = Math.min(300, Math.max(50, Math.round(Number(wallpaper?.scale) || 100)));
    const dim = Math.min(70, Math.max(0, Math.round(Number(wallpaper?.dim))));
    await db.run(
      `UPDATE users SET wallpaper_type = ?, wallpaper_url = ?, wallpaper_mode = ?,
        wallpaper_scale = ?, wallpaper_dim = ? WHERE id = ?`,
      type,
      url,
      mode,
      scale,
      Number.isFinite(dim) ? dim : 20,
      req.user.id
    );
  }
  const row = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ user: auth.publicUser(row) });
}));

// ---------- chats ----------
async function listChats(userId) {
  const rows = await db.all(
    `SELECT c.* FROM chats c
     JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
     ORDER BY c.created_at DESC`,
    userId
  );
  const chats = await helpers.serializeChats(rows, userId);
  chats.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.createdAt : a.createdAt;
    const tb = b.lastMessage ? b.lastMessage.createdAt : b.createdAt;
    return tb - ta;
  });
  return chats;
}

app.get('/api/chats', auth.requireAuth, ah(async (req, res) => {
  res.json({ chats: await listChats(req.user.id) });
}));

app.post('/api/chats/direct', auth.requireAuth, ah(async (req, res) => {
  const peerId = String(req.body?.peerId || '');
  const peer = await db.get('SELECT id FROM users WHERE id = ?', peerId);
  if (!peer) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  const chat = await helpers.getOrCreateDirectChat(req.user.id, peerId);
  const row = await db.get(
    `SELECT c.* FROM chats c
     JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
     WHERE c.id = ?`,
    req.user.id,
    chat.id
  );
  res.status(201).json({ chat: (await helpers.serializeChats([row], req.user.id))[0] });
}));

app.get('/api/chats/:id/messages', auth.requireAuth, ah(async (req, res) => {
  if (!(await helpers.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const before = req.query.before ? Number(req.query.before) : Date.now();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await db.all(
    `SELECT * FROM messages WHERE chat_id = ? AND created_at < ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    req.params.id,
    before,
    limit
  );
  const statuses = await helpers.statusesFor(rows.map((r) => r.id));
  res.json({
    messages: rows
      .reverse()
      .map((r) => helpers.serializeMessage(r, statuses.get(r.id) || 'sent')),
    hasMore: rows.length === limit,
  });
}));

app.post('/api/chats/:id/read', auth.requireAuth, ah(async (req, res) => {
  if (!(await helpers.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  await markChatRead(req.params.id, req.user.id);
  res.json({ ok: true });
}));

app.post('/api/chats/:id/typing', auth.requireAuth, ah(async (req, res) => {
  if (!(await helpers.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const typing = !!req.body?.typing;
  const members = await helpers.getChatMemberIds(req.params.id);
  await emitToUsers(
    members.filter((uid) => uid !== req.user.id),
    'typing',
    { chatId: req.params.id, userId: req.user.id, typing }
  );
  res.json({ ok: true });
}));

async function markChatRead(chatId, userId) {
  await helpers.touchRead(chatId, userId);
  const rows = await db.all(
    `SELECT m.id, m.sender_id FROM messages m
     WHERE m.chat_id = ? AND m.sender_id <> ?
       AND EXISTS (SELECT 1 FROM message_status s
                   WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read')`,
    chatId,
    userId,
    userId
  );
  await dispatch(
    rows.map((r) => ({
      userId: r.sender_id,
      event: 'message:status',
      payload: { messageId: r.id, chatId, status: 'read' },
    }))
  );
}

app.delete('/api/messages/:id', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Bukan pesan Anda' });
  const deletedAt = Date.now();
  await db.run('UPDATE messages SET deleted_at = ?, body = \'\' WHERE id = ?', deletedAt, row.id);
  const status = await helpers.messageStatus(row.id);
  const payload = helpers.serializeMessage({ ...row, deleted_at: deletedAt, body: '' }, status);
  const members = await helpers.getChatMemberIds(row.chat_id);
  await emitToUsers(members, 'message:deleted', payload);
  res.json({ ok: true });
}));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Terjadi kesalahan' });
});

// ---------- presence lintas instance ----------
async function broadcastPresence(userId) {
  const online = await presence.isOnline(userId);
  const row = await db.get('SELECT last_seen FROM users WHERE id = ?', userId);
  const payload = { userId, online, lastSeen: (row && row.last_seen) || Date.now() };
  const contacts = await db.all(
    `SELECT DISTINCT m2.user_id FROM chat_members m1
     JOIN chat_members m2 ON m2.chat_id = m1.chat_id
     WHERE m1.user_id = ? AND m2.user_id <> ?`,
    userId,
    userId
  );
  await emitToUsers([...contacts.map((c) => c.user_id), userId], 'presence', payload);
}

async function cleanupCalls(userId) {
  const mine = await calls.listForUser(userId);
  for (const call of mine) {
    const other = call.caller_id === userId ? call.callee_id : call.caller_id;
    if (call.state === 'ringing') {
      const removed = await calls.remove(call.id);
      if (removed) await emitToUser(other, 'call:ended', { callId: call.id, reason: 'ended' });
    } else if (!(await presence.isOnline(call.caller_id)) && !(await presence.isOnline(call.callee_id))) {
      await calls.remove(call.id);
    }
  }
}

async function handleDisconnect(user, socketId) {
  try {
    await presence.remove(user.id, socketId);
    if (!presence.isLocal(user.id)) {
      await db.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), user.id);
      await broadcastPresence(user.id);
    }
    await cleanupCalls(user.id);
  } catch (err) {
    console.error('disconnect:', err.message);
  }
}

// ---------- socket.io ----------
io.use(async (socket, next) => {
  try {
    const payload = auth.verifyToken(socket.handshake.auth?.token || '');
    if (!payload) return next(new Error('auth:tidak-terautentikasi'));
    const user = await db.get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) return next(new Error('auth:akun-tidak-ditemukan'));
    socket.data.user = user;
    next();
  } catch (err) {
    // kegagalan sesaat (DB dsb.) sengaja TIDAK memakai awalan auth: supaya
    // klien tidak menganggapnya token kedaluwarsa dan ikut keluar
    console.error('socket auth:', err.message);
    next(new Error('server:tidak-tersedia'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  const first = presence.addLocal(user.id, socket.id);
  socket.join(`user:${user.id}`);

  void (async () => {
    try {
      await presence.persist(user.id, socket.id);
      if (first) await broadcastPresence(user.id);
    } catch (err) {
      console.error('connect:', err.message);
    }
  })();

  socket.on('message:send', (payload, ack) => {
    handleSend(user, payload)
      .then((result) => ack?.({ ok: true, ...result }))
      .catch((err) => ack?.({ ok: false, error: (err && err.message) || 'Gagal mengirim pesan' }));
  });

  socket.on('typing', ({ chatId, typing } = {}) => {
    helpers
      .isMember(chatId, user.id)
      .then((member) => {
        if (!member) return null;
        return helpers.getChatMemberIds(chatId);
      })
      .then((members) => {
        if (!members) return null;
        return emitToUsers(
          members.filter((uid) => uid !== user.id),
          'typing',
          { chatId, userId: user.id, typing: !!typing }
        );
      })
      .catch((err) => console.error('typing:', err.message));
  });

  socket.on('chat:read', ({ chatId } = {}) => {
    helpers
      .isMember(chatId, user.id)
      .then((member) => (member ? markChatRead(chatId, user.id) : null))
      .catch((err) => console.error('chat:read:', err.message));
  });

  // ---------- WebRTC signaling ----------
  socket.on('call:invite', ({ to, callId, kind } = {}, ack) => {
    const reply = (payload) => { try { ack?.(payload); } catch { /* ack sudah ditutup */ } };
    void (async () => {
      try {
        const targetId = String(to || '');
        const id = String(callId || '');
        if (!id) return reply({ ok: false, error: 'Permintaan panggilan tidak valid' });
        if (!targetId || targetId === user.id) return reply({ ok: false, error: 'Tidak dapat menelepon pengguna ini' });
        const target = await db.get('SELECT id FROM users WHERE id = ?', targetId);
        if (!target) return reply({ ok: false, error: 'Pengguna tidak ditemukan' });

        await calls.create({ id, callerId: user.id, calleeId: targetId, kind });
        const delivered = await emitToUser(targetId, 'call:incoming', {
          callId: id,
          kind: kind === 'video' ? 'video' : 'audio',
          from: publicCaller(user),
        });
        if (!delivered) {
          await calls.remove(id);
          return reply({ ok: false, error: 'Pengguna sedang offline' });
        }
        reply({ ok: true, delivered: true });
      } catch (err) {
        console.error('call:invite:', err.message);
        reply({ ok: false, error: 'Gagal memulai panggilan' });
      }
    })();
  });

  socket.on('call:accept', ({ callId } = {}) => {
    void (async () => {
      try {
        const id = String(callId || '');
        const call = await calls.get(id);
        if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) return;
        await calls.setState(id, 'accepted');
        await emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'accepted' });
      } catch (err) {
        console.error('call:accept:', err.message);
      }
    })();
  });

  socket.on('call:signal', ({ to, callId, signal } = {}) => {
    void (async () => {
      try {
        const targetId = String(to || '');
        const id = String(callId || '');
        if (!id || !targetId || targetId === user.id) return;
        const call = await calls.get(id);
        if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) return;
        if (!signal || typeof signal !== 'object') return;
        if (!['offer', 'answer', 'candidate'].includes(signal.type)) return;
        if (!(await db.get('SELECT id FROM users WHERE id = ?', targetId))) return;
        if (signal.type === 'answer') await calls.setState(id, 'active');
        await emitToUser(targetId, 'call:signal', {
          callId: id,
          from: publicCaller(user),
          signal,
        });
      } catch (err) {
        console.error('call:signal:', err.message);
      }
    })();
  });

  socket.on('call:reject', ({ to, callId } = {}) => {
    void (async () => {
      try {
        const id = String(callId || '');
        const targetId = String(to || '');
        await calls.remove(id);
        if (targetId && targetId !== user.id) {
          await emitToUser(targetId, 'call:ended', { callId: id, reason: 'rejected' });
        }
        await emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'cancelled' });
      } catch (err) {
        console.error('call:reject:', err.message);
      }
    })();
  });

  socket.on('call:hangup', ({ to, callId, reason } = {}) => {
    void (async () => {
      try {
        const id = String(callId || '');
        const targetId = String(to || '');
        await calls.remove(id);
        const mapped = reason === 'timeout' ? 'timeout' : 'ended';
        if (targetId && targetId !== user.id) {
          await emitToUser(targetId, 'call:ended', { callId: id, reason: mapped });
        }
        await emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'ended' });
      } catch (err) {
        console.error('call:hangup:', err.message);
      }
    })();
  });

  socket.on('disconnect', () => {
    void handleDisconnect(user, socket.id);
  });
});

async function handleSend(user, payload) {
  const { chatId, type = 'text', body = '', media } = payload || {};
  if (!chatId || !(await helpers.isMember(chatId, user.id))) {
    throw new Error('Bukan anggota chat ini');
  }

  const cleanType = ['text', 'image', 'video', 'audio', 'file'].includes(type) ? type : 'text';
  if (cleanType === 'text' && !String(body).trim()) throw new Error('Pesan kosong');

  const id = crypto.randomUUID();
  const now = Date.now();
  const mediaUrl = cleanType === 'text' ? null : media?.url || null;
  if (cleanType !== 'text' && !mediaUrl) throw new Error('Media tidak ditemukan');

  await db.run(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_size, mime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  const row = await db.get('SELECT * FROM messages WHERE id = ?', id);
  const message = helpers.serializeMessage(row, 'sent');
  const members = await helpers.getChatMemberIds(chatId);

  const deliveredTo = [];
  for (const uid of members) {
    if (uid === user.id) continue;
    const delivered = await emitToUser(uid, 'message:new', message);
    if (delivered) deliveredTo.push(uid);
  }

  if (deliveredTo.length) {
    const values = deliveredTo.map(() => `(?, ?, 'delivered', ?)`).join(', ');
    await db.run(
      `INSERT INTO message_status (message_id, user_id, status, at) VALUES ${values}
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      ...deliveredTo.flatMap((uid) => [id, uid, now])
    );
  }

  const freshRow = await db.get('SELECT * FROM messages WHERE id = ?', id);
  const fresh = helpers.serializeMessage(freshRow, await helpers.messageStatus(id));

  if (fresh.status === 'delivered') {
    await emitToUser(user.id, 'message:status', { messageId: id, chatId, status: 'delivered' });
  }

  await emitToUsers(members, 'chat:updated', { chatId });

  return { message: fresh };
}

async function boot() {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let attempt = 0;
  for (;;) {
    try {
      await db.ready();
      break;
    } catch (err) {
      attempt += 1;
      if (attempt >= 8) {
        console.error('boot:', err.message);
        return;
      }
      console.error(`boot percobaan ${attempt} gagal:`, err.message);
      await delay(Math.min(500 * 2 ** attempt, 8000));
    }
  }
  presence.start();
  try {
    await bus.start((msg) => {
      for (const uid of msg.userIds || []) {
        presence.emitLocal(uid, msg.event, msg.payload, msg.except || null);
      }
    });
  } catch (err) {
    console.error('bus:', err.message);
  }
}

void boot();

server.listen(PORT, () => {
  console.log(`Whatsap Indo berjalan di http://localhost:${PORT} (${db.dialect})`);
});
