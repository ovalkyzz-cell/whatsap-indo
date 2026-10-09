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
const settings = require('./settings');
const bots = require('./bots');
const referral = require('./referral');
const webpush = require('web-push');
const { router: uploadRouter, UPLOAD_DIR, storeRemoteFile } = require('./upload');

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

// ---------- anti spam / anti flood (perlindungan akun) ----------
// Bucket sederhana per kunci: mencegah banjir pesan (flood) yang bisa membuat
// akun dianggap spam, sekaligus membatasi aksi sensitif (buat grup, status).
const floodBuckets = new Map();
const floodSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of floodBuckets) if (now - bucket.start > bucket.windowMs * 2) floodBuckets.delete(key);
}, 60_000);
floodSweep.unref();

function floodGuard(key, max, windowMs) {
  const now = Date.now();
  let bucket = floodBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0, windowMs };
    floodBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

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

function publicCaller(row, viewerId) {
  return helpers.serializeUser(row, viewerId, { premium: false });
}

function requireAdmin(req, res, next) {
  if (!auth.isAdmin(req.user)) return res.status(403).json({ error: 'Hanya admin yang diizinkan' });
  next();
}

// tampilan ringkas untuk panel admin
function adminUser(row, online) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatar: row.avatar,
    role: auth.isAdmin(row) ? 'admin' : (row.role || 'user'),
    verified: auth.verifiedOf(row),
    plan: row.premium_plan || null,
    premiumUntil: Number(row.premium_until) || 0,
    premiumActive: auth.isPremium(row),
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    online: !!online,
    status: row.banned ? 'banned' : (row.account_status || 'active'),
    rejectReason: row.reject_reason || null,
    bannedReason: row.banned_reason || null,
    bannedAt: Number(row.banned_at) || 0,
    lastLoginAt: Number(row.last_login_at) || 0,
    sessionAt: Number(row.session_at) || 0,
    lastDevice: row.last_device || null,
    lastIp: row.last_ip || null,
    hasSession: !!row.session_id,
  };
}

// ---------- meta pengguna (device + IP) untuk pemantauan admin ----------
function reqMeta(req) {
  return {
    device: String(req.headers['user-agent'] || '').slice(0, 180),
    ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 60),
  };
}

async function recordLogin({ userId, email, ip, device, result, detail }) {
  try {
    await db.run(
      `INSERT INTO login_logs (id, user_id, email, ip, device, result, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      userId || null,
      String(email || '').slice(0, 200),
      ip || null,
      device || null,
      result,
      detail ? String(detail).slice(0, 200) : null,
      Date.now()
    );
  } catch (err) {
    console.error('login log:', err.message);
  }
}

// daftar admin (role + daftar email admin) untuk broadcast monitor real-time
async function adminIds() {
  const rows = await db.all(`SELECT id, email FROM users WHERE role = 'admin'`);
  const extra = auth.ADMIN_EMAILS;
  const ids = new Set(rows.filter((r) => auth.isAdmin(r)).map((r) => r.id));
  if (extra.length) {
    const found = await db.all(
      `SELECT id, email FROM users WHERE LOWER(email) IN (${extra.map(() => '?').join(', ')})`,
      ...extra
    );
    for (const r of found) ids.add(r.id);
  }
  return [...ids];
}

// semua peristiwa penting didorong ke panel admin secara real-time
async function adminEvent(type, payload = {}) {
  try {
    const ids = await adminIds();
    if (!ids.length) return;
    await emitToUsers(ids, 'admin:event', { type, at: Date.now(), ...payload });
  } catch (err) {
    console.error('admin event:', err.message);
  }
}

// memutus semua socket milik satu akun lalu memberi tahu pemiliknya
// (kecuali sesi baru yang sedang dipakai login terakhir)
function kickUserSessions(userId, reason, keepSid = '') {
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  if (!room) return;
  for (const id of room) {
    const s = io.sockets.sockets.get(id);
    if (!s) continue;
    if (keepSid && s.data.sid === keepSid) continue;
    kickReplaced(s, reason);
  }
}

// sesi lama dimatikan; socket klien diberi tahu lalu diputus
async function revokeSessions(userId, reason) {
  await auth.clearSession(userId);
  kickUserSessions(userId, reason === 'logout' ? 'sesi-dicabut' : reason);
}

// ---------- auth routes ----------
app.post('/api/auth/register', authLimiter, ah(async (req, res) => {
  const meta = reqMeta(req);
  const out = await auth.register(req.body || {}, meta);
  res.status(201).json(out);
  if (out.pending) {
    await recordLogin({ userId: out.user.id, email: out.user.email, ...meta, result: 'pending', detail: 'menunggu persetujuan admin' });
    await adminEvent('registered', { user: adminUser(await db.get('SELECT * FROM users WHERE id = ?', out.user.id)) });
  }
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const meta = reqMeta(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    const out = await auth.login(req.body || {}, meta);
    res.json(out);
    await recordLogin({ userId: out.user.id, email: out.user.email, ...meta, result: 'success' });
    // perangkat lain memakai akun yang sama -> sesi lamanya diputus
    const sid = (auth.verifyToken(out.token) || {}).sid || '';
    kickUserSessions(out.user.id, 'login-baru', sid);
    await adminEvent('login', {
      userId: out.user.id,
      name: out.user.name,
      email: out.user.email,
      device: meta.device,
      ip: meta.ip,
    });
  } catch (err) {
    if (err.status === 403 && err.code) {
      await recordLogin({ email, ...meta, result: err.code, detail: err.message });
    } else if (err.status === 401 && err.code === 'invalid_credentials') {
      await recordLogin({ email, ...meta, result: 'failed', detail: 'password salah' });
    }
    throw err;
  }
}));

app.post('/api/auth/logout', auth.requireAuth, ah(async (req, res) => {
  await revokeSessions(req.user.id, 'logout');
  await recordLogin({ userId: req.user.id, email: req.user.email, ...reqMeta(req), result: 'logout' });
  await adminEvent('logout', { userId: req.user.id, name: req.user.name, email: req.user.email });
  res.json({ ok: true });
}));

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ---------- users ----------
// akses bot: khusus admin & pengguna premium (premium aktif selama premium_until)
function canUseBots(user) {
  return auth.isAdmin(user) || auth.isPremium(user);
}

// hari versi WIB (UTC+7) supaya kuota harian sama bagi seluruh pengguna Indonesia
function dayKey() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

// bot yang tidak dicakup paket pengguna (admin selalu dapat semua bot)
async function excludedBots(user) {
  if (auth.isAdmin(user)) return new Set();
  const plan = await settings.planOf(user);
  return new Set((plan && plan.excluded) || []);
}

// tolak bot di luar cakupan paket (mis. bot eksklusif di paket Harian)
async function assertBotAllowed(user, botId) {
  const excluded = await excludedBots(user);
  if (!excluded.has(botId)) return;
  const plan = await settings.planOf(user);
  const label = plan ? plan.label : 'Anda';
  throw auth.httpError(
    403,
    `Bot ini tidak termasuk paket ${label}. Buka menu Paket & Harga untuk upgrade.`,
    'bot_locked'
  );
}

// kuota pesan bot harian sesuai paket; habis -> pakai token undangan, lalu ditolak
async function consumeBotQuota(user) {
  if (auth.isAdmin(user)) return;
  const plan = await settings.planOf(user);
  const limit = plan ? Number(plan.dailyLimit) || 0 : 0;
  if (!limit) return; // tanpa limit (Bulanan, Permanen, atau paket custom tanpa limit)
  const day = dayKey();
  const row = await db.get('SELECT bot_usage_day, bot_usage_count, bot_tokens FROM users WHERE id = ?', user.id);
  const used = row && row.bot_usage_day === day ? Number(row.bot_usage_count) || 0 : 0;
  if (used < limit) {
    await db.run(
      `UPDATE users SET bot_usage_count = CASE WHEN bot_usage_day = ? THEN bot_usage_count + 1 ELSE 1 END,
         bot_usage_day = ? WHERE id = ?`,
      day,
      day,
      user.id
    );
    return;
  }
  const tokens = row ? Number(row.bot_tokens) || 0 : 0;
  if (tokens > 0) {
    await db.run('UPDATE users SET bot_tokens = bot_tokens - 1 WHERE id = ? AND bot_tokens > 0', user.id);
    return;
  }
  const label = plan ? plan.label : 'Anda';
  throw new Error(
    `Kuota bot paket ${label} hari ini sudah habis (${limit} pesan). Ajak teman pakai kode undangan agar dapat token tambahan, atau upgrade paket di menu Paket & Harga.`
  );
}

// info kuota untuk ditampilkan di menu Paket & daftar bot
async function botAccess(user) {
  const plan = await settings.planOf(user);
  const row = await db.get(
    'SELECT bot_usage_day, bot_usage_count, bot_tokens, premium_until FROM users WHERE id = ?',
    user.id
  );
  const day = dayKey();
  const used = row && row.bot_usage_day === day ? Number(row.bot_usage_count) || 0 : 0;
  return {
    planId: plan ? plan.id : (user.premium_plan || null),
    planLabel: plan ? plan.label : null,
    limit: plan ? Number(plan.dailyLimit) || 0 : 0,
    used,
    tokens: Number(row && row.bot_tokens) || 0,
    until: Number(row && row.premium_until) || 0,
    active: auth.isPremium(user),
    admin: auth.isAdmin(user),
  };
}

app.get('/api/plans', auth.requireAuth, ah(async (req, res) => {
  const [plans, access, invite] = await Promise.all([
    settings.getPlans(),
    botAccess(req.user),
    referral.stats(req.user),
  ]);
  const groups = bots.catalog();
  res.json({
    plans,
    botTotal: groups.reduce((sum, g) => sum + g.bots.length, 0),
    exclusiveBotIds: settings.EXCLUSIVE_BOTS,
    invite: {
      code: invite.code,
      invited: invite.invited,
      tokens: invite.tokens,
      welcomeTokens: invite.welcomeTokens,
      inviteTokens: invite.inviteTokens,
      referred: invite.referred,
    },
    me: access,
  });
}));

// kode undangan + statistik: makin banyak teman join, makin banyak token
app.get('/api/referral', auth.requireAuth, ah(async (req, res) => {
  const stats = await referral.stats(req.user);
  const origin = req.get('origin') || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  res.json({ ...stats, link: `${origin}/?ref=${stats.code}` });
}));

app.get('/api/bots', auth.requireAuth, ah(async (req, res) => {
  const groups = bots.catalog();
  const totalAll = groups.reduce((sum, group) => sum + group.bots.length, 0);
  if (!canUseBots(req.user)) {
    return res.status(403).json({
      error: 'Daftar bot khusus pengguna premium.',
      locked: true,
      total: totalAll,
      plans: await settings.getPlans(),
    });
  }

  // paket terbatas (mis. Harian) menyembunyikan bot eksklusif milik paket di atasnya
  const excluded = await excludedBots(req.user);
  const visibleGroups = groups
    .map((group) => ({ ...group, bots: group.bots.filter((bot) => !excluded.has(bot.id)) }))
    .filter((group) => group.bots.length);
  const ids = visibleGroups.flatMap((group) => group.bots.map((bot) => bot.id));
  const rows = ids.length
    ? await db.all(`SELECT id, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  const avatars = new Map(rows.map((row) => [row.id, row.avatar]));
  for (const group of visibleGroups) {
    for (const bot of group.bots) bot.avatar = avatars.get(bot.id) || null;
  }
  const total = visibleGroups.reduce((sum, group) => sum + group.bots.length, 0);
  res.json({ groups: visibleGroups, total, premiumOnly: true, access: await botAccess(req.user) });
}));

app.get('/api/users/search', auth.requireAuth, ah(async (req, res) => {
  if (!floodGuard(`search:${req.user.id}`, 150, 60_000)) {
    return res.status(429).json({ error: 'Terlalu banyak pencarian. Coba lagi sebentar lagi.' });
  }
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = await db.all(
    `SELECT * FROM users WHERE id <> ? AND (LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?))
     ORDER BY LOWER(name) LIMIT 200`,
    req.user.id,
    like,
    like
  );
  // bot internal hanya terlihat oleh admin & pengguna premium yang paketnya mencakup bot tsb
  const canSeeBots = canUseBots(req.user);
  const excluded = canSeeBots ? await excludedBots(req.user) : new Set();
  // email yang dipribatkan tidak bisa ditemukan lewat email
  const visible = rows.filter((r) => {
    if (bots.isBot(r) && (!canSeeBots || excluded.has(r.id))) return false;
    if (!r.priv_email) return true;
    const matchEmail = String(r.email || '').toLowerCase().includes(q.toLowerCase());
    const matchName = String(r.name || '').toLowerCase().includes(q.toLowerCase());
    return matchName;
  });
  const online = await presence.onlineSet(visible.map((r) => r.id));
  res.json({
    users: visible.map((r) =>
      helpers.serializeUser(r, req.user.id, { online: online.has(r.id), premium: false })
    ),
  });
}));

// kontak CS/admin: selalu bisa dihubungi — lolos privasi email & pencarian diri sendiri,
// supaya tombol "Hubungi Admin / CS" selalu membuka chat otomatis
app.get('/api/cs', auth.requireAuth, ah(async (req, res) => {
  let row = null;
  if (auth.ADMIN_EMAILS.length) {
    row = await db.get(
      `SELECT * FROM users WHERE LOWER(email) IN (${auth.ADMIN_EMAILS.map(() => '?').join(',')})
       ORDER BY (role = 'admin') DESC, created_at ASC LIMIT 1`,
      ...auth.ADMIN_EMAILS
    );
  }
  if (!row) {
    row = await db.get(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
  }
  if (!row) return res.status(404).json({ error: 'Kontak CS belum tersedia' });
  res.json({
    user: helpers.serializeUser(row, req.user.id, {
      online: await presence.isOnline(row.id),
      premium: false,
    }),
    self: row.id === req.user.id,
  });
}));

app.get('/api/users/:id', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  if (bots.isBot(row) && !canUseBots(req.user)) {
    return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  }
  if (bots.isBot(row)) {
    const excluded = await excludedBots(req.user);
    if (excluded.has(row.id)) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }
  }
  res.json({
    user: helpers.serializeUser(row, req.user.id, {
      online: await presence.isOnline(row.id),
      premium: true,
    }),
  });
}));

const PRIVACY_COLUMNS = {
  lastSeen: 'priv_last_seen',
  receipts: 'priv_receipts',
  email: 'priv_email',
  bio: 'priv_bio',
  status: 'priv_status',
  avatar: 'priv_avatar',
};

app.patch('/api/me', auth.requireAuth, ah(async (req, res) => {
  const { name, about, avatar, wallpaper, homeBg, privacy } = req.body || {};
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
  if (privacy !== undefined && privacy !== null) {
    if (typeof privacy !== 'object') return res.status(400).json({ error: 'Pengaturan privasi tidak valid' });
    for (const [key, column] of Object.entries(PRIVACY_COLUMNS)) {
      if (privacy[key] === undefined) continue;
      if (typeof privacy[key] !== 'boolean') {
        return res.status(400).json({ error: `Pengaturan privasi ${key} tidak valid` });
      }
      await db.run(`UPDATE users SET ${column} = ? WHERE id = ?`, privacy[key] ? 1 : 0, req.user.id);
    }
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
  if (homeBg !== undefined && homeBg !== null) {
    if (typeof homeBg !== 'object') return res.status(400).json({ error: 'Latar halaman utama tidak valid' });
    const bgType = ['default', 'image', 'video'].includes(homeBg.type) ? homeBg.type : null;
    if (!bgType) return res.status(400).json({ error: 'Latar halaman utama tidak valid' });
    const bgUrl = bgType === 'default' ? null : String(homeBg.url || '');
    if (bgType !== 'default' && !settings.validBgUrl(bgUrl)) {
      return res.status(400).json({ error: 'URL latar halaman utama tidak valid' });
    }
    await db.run('UPDATE users SET home_bg_type = ?, home_bg_url = ? WHERE id = ?', bgType, bgUrl, req.user.id);
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
  let chats = await listChats(req.user.id);
  // chat bot disembunyikan bagi yang kehilangan akses (bukan admin/premium)
  if (!canUseBots(req.user)) chats = chats.filter((c) => !(c.peer && c.peer.isBot));
  else {
    const excluded = await excludedBots(req.user);
    if (excluded.size) chats = chats.filter((c) => !(c.peer && c.peer.isBot && excluded.has(c.peer.id)));
  }
  res.json({ chats });
}));

app.post('/api/chats/direct', auth.requireAuth, ah(async (req, res) => {
  if (!floodGuard(`direct:${req.user.id}`, 150, 60_000)) {
    return res.status(429).json({ error: 'Terlalu sering membuat chat. Coba lagi nanti.' });
  }
  const peerId = String(req.body?.peerId || '');
  const peer = await db.get('SELECT * FROM users WHERE id = ?', peerId);
  if (!peer) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  if (bots.isBot(peer) && !canUseBots(req.user)) {
    return res.status(403).json({ error: 'Bot hanya dapat digunakan oleh admin dan pengguna premium.' });
  }
  if (bots.isBot(peer)) await assertBotAllowed(req.user, peer.id);
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

// Riwayat panggilan. `?since=<ms>` hanya mengembalikan panggilan tak terjawab
// sesudah waktu itu — dipakai klien saat boot untuk menyinkronkan Pusat Notifikasi.
app.get('/api/calls', auth.requireAuth, ah(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const rows = since > 0
    ? await calls.missedFor(req.user.id, since)
    : await calls.listRecent(req.user.id, req.query.limit);
  const out = [];
  for (const row of rows) {
    const peerId = row.caller_id === req.user.id ? row.callee_id : row.caller_id;
    const peer = await db.get('SELECT * FROM users WHERE id = ?', peerId);
    if (!peer) continue;
    out.push({
      id: row.id,
      peer: helpers.serializeUser(peer, req.user.id, { premium: false }),
      direction: row.caller_id === req.user.id ? 'outgoing' : 'incoming',
      kind: row.kind,
      state: row.state,
      at: row.created_at,
      duration: row.answered_at ? Math.max(0, Number(row.updated_at || 0) - Number(row.answered_at)) : 0,
    });
  }
  res.json({ calls: out });
}));

// ---------- grup ----------
const MAX_GROUP_MEMBERS = 500;
function validChatUrl(url) {
  return /^\/uploads\/[\w.\-]+$/.test(String(url || ''))
    || /^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\/[\w.%\-/~]+$/.test(String(url || ''));
}

app.post('/api/chats/group', auth.requireAuth, ah(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const rawMembers = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
  if (rawMembers.length > MAX_GROUP_MEMBERS) {
    return res.status(400).json({ error: `Grup maksimal ${MAX_GROUP_MEMBERS} anggota` });
  }
  const memberIds = [...new Set(rawMembers.map(String))]
    .filter((id) => id && id !== req.user.id)
    .slice(0, MAX_GROUP_MEMBERS);
  if (name.length < 3) return res.status(400).json({ error: 'Nama grup minimal 3 karakter' });
  if (!memberIds.length) return res.status(400).json({ error: 'Pilih minimal satu anggota lain' });
  if (!floodGuard(`group:${req.user.id}`, 5, 3_600_000)) {
    return res.status(429).json({ error: 'Terlalu sering membuat grup. Coba lagi nanti.' });
  }

  const found = await db.all(
    `SELECT * FROM users WHERE id IN (${memberIds.map(() => '?').join(', ')})`,
    ...memberIds
  );
  if (found.length !== memberIds.length) {
    return res.status(400).json({ error: 'Ada anggota yang tidak ditemukan' });
  }
  // bot hanya boleh di chat pribadi — kalau ikut terdaftar di grup, seluruh
  // pesan grup jadi terkunci oleh kuota bot
  if (found.some((u) => bots.isBot(u))) {
    return res.status(403).json({ error: 'Bot tidak dapat ditambahkan ke grup. Gunakan chat pribadi dengan bot.' });
  }

  const id = await db.transaction(async () => {
    const chatId = crypto.randomUUID();
    const now = Date.now();
    await db.run(
      `INSERT INTO chats (id, type, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)`,
      chatId,
      name,
      req.user.id,
      now
    );
    await db.run(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`,
      chatId,
      req.user.id,
      now
    );
    for (const uid of memberIds) {
      await db.run(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        chatId,
        uid,
        now
      );
    }
    return chatId;
  });

  const row = await db.get(
    `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ? WHERE c.id = ?`,
    req.user.id,
    id
  );
  const chat = (await helpers.serializeChats([row], req.user.id))[0];
  await emitToUsers([req.user.id, ...memberIds], 'chat:updated', { chatId: id });
  res.status(201).json({ chat });
}));

app.get('/api/chats/:id/members', auth.requireAuth, ah(async (req, res) => {
  if (!(await helpers.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const rows = await db.all(
    `SELECT u.*, m.role AS chat_role, m.joined_at
     FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, LOWER(u.name)`,
    req.params.id
  );
  const online = await presence.onlineSet(rows.map((r) => r.id));
  res.json({
    members: rows.map((r) => ({
      ...helpers.serializeUser(r, req.user.id, { online: online.has(r.id), premium: false }),
      role: r.chat_role,
      joinedAt: r.joined_at,
    })),
  });
}));

app.patch('/api/chats/:id', auth.requireAuth, ah(async (req, res) => {
  const chat = await db.get('SELECT * FROM chats WHERE id = ?', req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat tidak ditemukan' });
  if (chat.type !== 'group') return res.status(400).json({ error: 'Hanya grup yang bisa diubah' });
  if (!(await helpers.isGroupAdmin(chat.id, req.user.id))) {
    return res.status(403).json({ error: 'Hanya admin grup yang bisa mengubah' });
  }
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) : undefined;
  const avatar = req.body?.avatar !== undefined ? (req.body.avatar ? String(req.body.avatar) : null) : undefined;
  if (name !== undefined && name.length < 3) return res.status(400).json({ error: 'Nama grup minimal 3 karakter' });
  if (avatar !== undefined && avatar && !validChatUrl(avatar)) {
    return res.status(400).json({ error: 'Foto grup tidak valid' });
  }
  if (name !== undefined) await db.run('UPDATE chats SET name = ? WHERE id = ?', name, chat.id);
  if (avatar !== undefined) await db.run('UPDATE chats SET avatar = ? WHERE id = ?', avatar, chat.id);
  const members = await helpers.getChatMemberIds(chat.id);
  await emitToUsers(members, 'chat:updated', { chatId: chat.id });
  const row = await db.get('SELECT * FROM chats WHERE id = ?', chat.id);
  res.json({ chat: (await helpers.serializeChats([row], req.user.id))[0] });
}));

app.post('/api/chats/:id/members', auth.requireAuth, ah(async (req, res) => {
  const chat = await db.get('SELECT * FROM chats WHERE id = ?', req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grup tidak ditemukan' });
  if (!(await helpers.isGroupAdmin(chat.id, req.user.id))) {
    return res.status(403).json({ error: 'Hanya admin grup yang bisa menambah anggota' });
  }
  const userId = String(req.body?.userId || '');
  const target = await db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  if (bots.isBot(target)) {
    return res.status(403).json({ error: 'Bot tidak dapat ditambahkan ke grup. Gunakan chat pribadi dengan bot.' });
  }
  const existing = await db.get('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?', chat.id, userId);
  if (existing) return res.json({ ok: true, already: true });
  const count = await db.get('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', chat.id);
  if (Number(count.n) >= MAX_GROUP_MEMBERS) return res.status(400).json({ error: 'Grup sudah penuh' });
  await db.run(
    `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
    chat.id,
    userId,
    Date.now()
  );
  await emitToUsers([userId, ...(await helpers.getChatMemberIds(chat.id))], 'chat:updated', { chatId: chat.id });
  res.status(201).json({ ok: true });
}));

app.post('/api/chats/:id/leave', auth.requireAuth, ah(async (req, res) => {
  const chat = await db.get('SELECT * FROM chats WHERE id = ?', req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grup tidak ditemukan' });
  if (!(await helpers.isMember(chat.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota grup ini' });
  }
  await db.run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', chat.id, req.user.id);
  const remaining = await helpers.getChatMemberIds(chat.id);
  if (!remaining.length) {
    await db.run('DELETE FROM chats WHERE id = ?', chat.id);
  } else {
    // admin terakhir pergi -> anggota tertua dijadikan admin supaya grup tetap terkelola
    const admins = await db.get(
      `SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ? AND role = 'admin'`,
      chat.id
    );
    if (Number(admins.n) === 0) {
      await db.run(
        `UPDATE chat_members SET role = 'admin'
         WHERE chat_id = ? AND user_id = (SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC LIMIT 1)`,
        chat.id,
        chat.id
      );
    }
    await emitToUsers([req.user.id, ...remaining], 'chat:updated', { chatId: chat.id });
  }
  res.json({ ok: true });
}));

app.get('/api/chats/:id/messages', auth.requireAuth, ah(async (req, res) => {
  if (!(await helpers.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  const before = req.query.before ? Number(req.query.before) : Date.now();
  const beforeId = String(req.query.beforeId || '');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  // kursor keyset (created_at, id): pesan yang berbagi milidetik yang sama
  // dengan batas halaman tidak lagi terlewat saat menggulir ke atas
  const rows = beforeId
    ? await db.all(
      `SELECT * FROM messages WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      req.params.id,
      before,
      before,
      beforeId,
      limit
    )
    : await db.all(
      `SELECT * FROM messages WHERE chat_id = ? AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      req.params.id,
      before,
      limit
    );
  res.json({
    messages: await helpers.serializeMessages(rows.reverse(), req.user.id),
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
  // pengguna dengan privasi laporan dibaca: penanda terisi (unread bersih),
  // tetapi pengirim tidak pernah menerima tanda "dibaca"
  const reader = await db.get('SELECT priv_receipts FROM users WHERE id = ?', userId);
  if (reader && reader.priv_receipts) return;
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
  const fresh = await db.get('SELECT * FROM messages WHERE id = ?', row.id);
  const payload = (await helpers.serializeMessages([fresh], null))[0];
  const members = await helpers.getChatMemberIds(row.chat_id);
  await emitToUsers(members, 'message:deleted', payload);
  res.json({ ok: true });
}));

// ---------- foto sekali lihat ----------
// Server menjaga konsumsi: penerima hanya boleh mengambil medianya satu kali.
app.get('/api/messages/media/:id', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (!(await helpers.isMember(row.chat_id, req.user.id))) {
    return res.status(403).json({ error: 'Bukan anggota chat ini' });
  }
  if (!row.media_url) return res.status(404).json({ error: 'Media tidak ditemukan' });

  if (row.view_once) {
    if (row.sender_id !== req.user.id) {
      if (row.opened_at) return res.status(410).json({ error: 'Foto sekali lihat sudah dibuka' });
      const upd = await db.run(
        'UPDATE messages SET opened_at = ?, opened_by = ? WHERE id = ? AND opened_at IS NULL',
        Date.now(),
        req.user.id,
        row.id
      );
      // hanya satu permintaan yang boleh menang (dijaga atomik oleh WHERE)
      if (upd.changes !== 1) return res.status(410).json({ error: 'Foto sekali lihat sudah dibuka' });
      await emitToUser(row.sender_id, 'message:viewed', { messageId: row.id, chatId: row.chat_id });
    }
  }
  res.redirect(row.media_url);
}));

// ---------- status (status wa) ----------
const STATUS_TTL = 24 * 60 * 60 * 1000;

function serializeStatus(row, viewerId, viewCount) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    body: row.body,
    bg: row.bg,
    mediaUrl: row.media_url,
    mediaName: row.media_name,
    mime: row.mime,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewCount: Number(viewCount) || 0,
    isMine: row.user_id === viewerId,
    viewed: !!row.viewerHasViewed,
    name: row.name || null,
    avatar: row.priv_avatar ? null : row.avatar || null,
    verified: auth.verifiedOf({ role: row.u_role, premium_until: row.u_until, email: row.u_email }),
  };
}

async function contactIds(userId) {
  const rows = await db.all(
    `SELECT DISTINCT m2.user_id FROM chat_members m1
     JOIN chat_members m2 ON m2.chat_id = m1.chat_id
     WHERE m1.user_id = ? AND m2.user_id <> ?`,
    userId,
    userId
  );
  return rows.map((r) => r.user_id);
}

app.post('/api/status', auth.requireAuth, ah(async (req, res) => {
  const type = ['text', 'image', 'video'].includes(req.body?.type) ? req.body.type : 'text';
  const body = String(req.body?.body || '').trim().slice(0, 500);
  const bg = req.body?.bg ? String(req.body.bg) : null;
  if (bg && !/^#[0-9a-fA-F]{6}$/.test(bg)) return res.status(400).json({ error: 'Warna status tidak valid' });
  if (type === 'text' && !body) return res.status(400).json({ error: 'Tulis status Anda dulu' });

  let mediaUrl = null;
  let mediaName = null;
  let mime = null;
  if (type !== 'text') {
    mediaUrl = String(req.body?.media?.url || '');
    if (!validChatUrl(mediaUrl)) return res.status(400).json({ error: 'Media status tidak valid' });
    mediaName = String(req.body?.media?.name || '').slice(0, 255) || null;
    mime = String(req.body?.media?.mime || '').slice(0, 127) || null;
  }
  if (!floodGuard(`status:${req.user.id}`, 30, 3_600_000)) {
    return res.status(429).json({ error: 'Terlalu banyak status dalam satu jam (anti-spam)' });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO statuses (id, user_id, type, body, bg, media_url, media_name, mime, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    req.user.id,
    type,
    body,
    bg && /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : null,
    type === 'text' ? null : mediaUrl,
    type === 'text' ? null : mediaName,
    type === 'text' ? null : mime,
    now,
    now + STATUS_TTL
  );
  const row = await db.get('SELECT * FROM statuses WHERE id = ?', id);
  // status bersifat privat: tidak diumumkan ke kontak mana pun
  if (!req.user.priv_status) {
    await emitToUsers(await contactIds(req.user.id), 'status:new', { userId: req.user.id });
  }
  res.status(201).json({
    status: serializeStatus(
      { ...row, u_role: req.user.role, u_until: req.user.premium_until, u_email: req.user.email },
      req.user.id,
      0
    ),
  });
}));

app.get('/api/status', auth.requireAuth, ah(async (req, res) => {
  await db.run('DELETE FROM statuses WHERE expires_at < ?', Date.now());

  const mine = await db.all(
    'SELECT * FROM statuses WHERE user_id = ? AND expires_at > ? ORDER BY created_at ASC',
    req.user.id,
    Date.now()
  );
  const mineIds = mine.map((r) => r.id);
  const myCounts = mineIds.length
    ? await db.all(
        `SELECT status_id, COUNT(*) AS n FROM status_views WHERE status_id IN (${mineIds.map(() => '?').join(', ')}) GROUP BY status_id`,
        ...mineIds
      )
    : [];
  const countMap = new Map(myCounts.map((r) => [r.status_id, r.n]));

  const groups = [];
  if (mine.length) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    groups.push({
      user: helpers.serializeUser(user, req.user.id, { online: true, premium: false }),
      isSelf: true,
      statuses: mine.map((r) =>
        serializeStatus(
          { ...r, u_role: user.role, u_until: user.premium_until, u_email: user.email },
          req.user.id,
          countMap.get(r.id)
        )
      ),
    });
  }

  const others = (await contactIds(req.user.id)).slice(0, 300);
  if (others.length) {
    const rows = await db.all(
      `SELECT s.*, u.name, u.avatar, u.email AS u_email, u.role AS u_role,
              u.premium_until AS u_until, u.priv_avatar
       FROM statuses s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? AND u.priv_status = 0
         AND s.user_id IN (${others.map(() => '?').join(', ')})
       ORDER BY s.created_at DESC`,
      Date.now(),
      ...others
    );
    const ids = rows.map((r) => r.id);
    const [counts, views] = await Promise.all([
      ids.length
        ? db.all(
            `SELECT status_id, COUNT(*) AS n FROM status_views WHERE status_id IN (${ids.map(() => '?').join(', ')}) GROUP BY status_id`,
            ...ids
          )
        : Promise.resolve([]),
      ids.length
        ? db.all(
            `SELECT status_id FROM status_views WHERE viewer_id = ? AND status_id IN (${ids.map(() => '?').join(', ')})`,
            req.user.id,
            ...ids
          )
        : Promise.resolve([]),
    ]);
    const countBy = new Map(counts.map((r) => [r.status_id, r.n]));
    const viewedSet = new Set(views.map((r) => r.status_id));
    const byUser = new Map();
    for (const row of rows) {
      if (!byUser.has(row.user_id)) {
        byUser.set(row.user_id, {
          user: {
            id: row.user_id,
            name: row.name,
            avatar: row.priv_avatar ? null : row.avatar,
            verified: auth.verifiedOf({ role: row.u_role, premium_until: row.u_until, email: row.u_email }),
            online: false,
          },
          isSelf: false,
          statuses: [],
        });
        groups.push(byUser.get(row.user_id));
      }
      row.viewerHasViewed = viewedSet.has(row.id);
      byUser.get(row.user_id).statuses.push(serializeStatus(row, req.user.id, countBy.get(row.id)));
    }
  }

  res.json({ groups });
}));

app.post('/api/status/:id/view', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM statuses WHERE id = ?', req.params.id);
  if (!row || row.expires_at < Date.now()) return res.status(404).json({ error: 'Status tidak ditemukan' });
  if (row.user_id === req.user.id) return res.json({ ok: true, mine: true });
  // status privat tidak bisa dibuka langsung lewat id
  const owner = await db.get('SELECT priv_status FROM users WHERE id = ?', row.user_id);
  if (owner && owner.priv_status) return res.status(404).json({ error: 'Status tidak ditemukan' });
  await db.run(
    `INSERT INTO status_views (status_id, viewer_id, at) VALUES (?, ?, ?)
     ON CONFLICT (status_id, viewer_id) DO NOTHING`,
    row.id,
    req.user.id,
    Date.now()
  );
  res.json({ ok: true });
}));

app.get('/api/status/:id/viewers', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM statuses WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Status tidak ditemukan' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Hanya pemilik status' });
  const rows = await db.all(
    `SELECT v.viewer_id, v.at, u.name, u.avatar, u.priv_avatar FROM status_views v
     JOIN users u ON u.id = v.viewer_id WHERE v.status_id = ? ORDER BY v.at DESC`,
    row.id
  );
  res.json({
    viewers: rows.map((r) => ({ id: r.viewer_id, name: r.name, avatar: r.priv_avatar ? null : r.avatar, at: r.at })),
  });
}));

app.delete('/api/status/:id', auth.requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM statuses WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Status tidak ditemukan' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan status Anda' });
  await db.run('DELETE FROM statuses WHERE id = ?', row.id);
  res.json({ ok: true });
}));

// ---------- pengaturan publik (halaman beranda login) ----------
app.get('/api/settings/public', ah(async (req, res) => {
  res.json({ homeBg: await settings.getHomeBg() });
}));

// ---------- panel admin ----------
async function adminStats() {
  const now = Date.now();
  const [u, c, m, s, p, pend, banned] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM users'),
    db.get('SELECT COUNT(*) AS n FROM chats'),
    db.get('SELECT COUNT(*) AS n FROM messages'),
    db.get('SELECT COUNT(*) AS n FROM statuses'),
    db.get('SELECT COUNT(*) AS n FROM users WHERE premium_until > ?', now),
    db.get(`SELECT COUNT(*) AS n FROM users WHERE account_status = 'pending' AND banned = 0`),
    db.get('SELECT COUNT(*) AS n FROM users WHERE banned = 1'),
  ]);
  return {
    users: Number(u.n) || 0,
    chats: Number(c.n) || 0,
    messages: Number(m.n) || 0,
    statuses: Number(s.n) || 0,
    premium: Number(p.n) || 0,
    pending: Number(pend.n) || 0,
    banned: Number(banned.n) || 0,
  };
}

app.get('/api/admin/overview', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const recent = await db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 8');
  res.json({
    stats: await adminStats(),
    plans: await settings.getPlans(),
    homeBg: await settings.getHomeBg(),
    recent: recent.map((r) => adminUser(r)),
  });
}));

app.get('/api/admin/users', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
  const rows = q
    ? await db.all(
        `SELECT * FROM users WHERE LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?)
         ORDER BY LOWER(name) LIMIT ?`,
        like,
        like,
        limit
      )
    : await db.all('SELECT * FROM users ORDER BY LOWER(name) LIMIT ?', limit);
  const online = await presence.onlineSet(rows.map((r) => r.id));
  const stats = await adminStats();
  res.json({ users: rows.map((r) => adminUser(r, online.has(r.id))), stats, total: stats.users, limit });
}));

app.get('/api/admin/settings', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ plans: await settings.getPlans(), homeBg: await settings.getHomeBg() });
}));

app.put('/api/admin/settings', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const { plans, homeBg } = req.body || {};
  if (plans !== undefined) {
    const saved = await settings.setPlans(plans);
    if (!saved) return res.status(400).json({ error: 'Data paket tidak valid (minimal 3 paket, durasi 1-3650 hari, harga & limit wajar)' });
  }
  if (homeBg !== undefined) {
    const saved = await settings.setHomeBg(homeBg);
    if (!saved) return res.status(400).json({ error: 'Background beranda tidak valid' });
  }
  res.json({ plans: await settings.getPlans(), homeBg: await settings.getHomeBg() });
}));

// ---------- profil bot (khusus admin): foto profil, nama & bio ----------
app.patch('/api/admin/bots/:id', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const bot = await bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot tidak ditemukan' });

  const { avatar, name, about } = req.body || {};
  if (avatar !== undefined) {
    const url = avatar ? String(avatar).slice(0, 500) : null;
    if (url && !validChatUrl(url)) return res.status(400).json({ error: 'Foto profil tidak valid' });
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', url, bot.id);
  }
  if (name !== undefined) {
    const trimmed = String(name).trim().slice(0, 60);
    if (trimmed.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter' });
    await db.run('UPDATE users SET name = ? WHERE id = ?', trimmed, bot.id);
  }
  if (about !== undefined) {
    await db.run('UPDATE users SET about = ? WHERE id = ?', String(about).slice(0, 200), bot.id);
  }

  const fresh = await db.get('SELECT * FROM users WHERE id = ?', bot.id);
  const chatRows = await db.all('SELECT chat_id FROM chat_members WHERE user_id = ?', bot.id);
  for (const row of chatRows) {
    await emitToUsers(await helpers.getChatMemberIds(row.chat_id), 'chat:updated', { chatId: row.chat_id });
  }
  res.json({ user: helpers.serializeUser(fresh, req.user.id, { premium: false }) });
}));

// beri / perpanjang paket premium berdasarkan email
app.post('/api/admin/premium', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const planId = String(req.body?.plan || '').trim();
  if (!email) return res.status(400).json({ error: 'Masukkan email pengguna' });
  const plans = await settings.getPlans();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Paket tidak dikenal' });

  const user = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', email);
  if (!user) return res.status(404).json({ error: 'Email tidak terdaftar di sistem' });

  const base = Math.max(Date.now(), Number(user.premium_until) || 0);
  // paket Permanen tidak kedaluwarsa (disimpan sebagai 100 tahun ke depan)
  const until = plan.permanent
    ? Date.now() + 100 * 365 * 24 * 3600 * 1000
    : base + plan.days * 24 * 3600 * 1000;
  await db.run(
    'UPDATE users SET premium_plan = ?, premium_until = ?, verified = 1 WHERE id = ?',
    plan.id,
    until,
    user.id
  );
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', user.id);
  await emitToUser(user.id, 'profile:updated', { id: user.id });
  res.json({ user: adminUser(fresh), plan, stats: await adminStats() });
}));

app.post('/api/admin/premium/revoke', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Masukkan email pengguna' });
  const user = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', email);
  if (!user) return res.status(404).json({ error: 'Email tidak terdaftar di sistem' });
  if (auth.isAdmin(user)) return res.status(400).json({ error: 'Akun admin tidak bisa dicabut' });
  await db.run(
    `UPDATE users SET premium_plan = NULL, premium_until = 0, verified = 0 WHERE id = ?`,
    user.id
  );
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', user.id);
  await emitToUser(user.id, 'profile:updated', { id: user.id });
  res.json({ user: adminUser(fresh), stats: await adminStats() });
}));

// ---------- persetujuan akun, blokir & pemantauan real-time ----------
async function findUser(idOrEmail) {
  const key = String(idOrEmail || '').trim().toLowerCase();
  if (!key) return null;
  return db.get('SELECT * FROM users WHERE id = ? OR LOWER(email) = ?', key, key);
}

function guardAdminTarget(res, target) {
  if (!target) { res.status(404).json({ error: 'Pengguna tidak ditemukan' }); return false; }
  if (auth.isAdmin(target)) {
    res.status(400).json({ error: 'Akun admin tidak bisa ditolak/diblokir' });
    return false;
  }
  return true;
}

app.post('/api/admin/users/:id/approve', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!guardAdminTarget(res, target)) return;
  if (target.banned) return res.status(400).json({ error: 'Akun sedang diblokir. Buka blokir dulu.' });
  if (target.account_status === 'active') return res.json({ user: adminUser(target), already: true });
  await db.run(`UPDATE users SET account_status = 'active', reject_reason = NULL WHERE id = ?`, target.id);
  // teman yang diundang resmi bergabung -> pengundang mendapat token undangan
  const inviter = await referral.rewardInviter(target.id);
  if (inviter) await emitToUser(inviter.id, 'profile:updated', { id: inviter.id });
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', target.id);
  await emitToUser(target.id, 'profile:updated', { id: target.id });
  await adminEvent('approved', { user: adminUser(fresh) });
  res.json({ user: adminUser(fresh) });
}));

app.post('/api/admin/users/:id/reject', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!guardAdminTarget(res, target)) return;
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  await db.run(
    `UPDATE users SET account_status = 'rejected', reject_reason = ? WHERE id = ?`,
    reason,
    target.id
  );
  await revokeSessions(target.id, 'rejected');
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', target.id);
  await recordLogin({ userId: target.id, email: target.email, ...reqMeta(req), result: 'rejected', detail: reason });
  await adminEvent('rejected', { user: adminUser(fresh) });
  res.json({ user: adminUser(fresh) });
}));

app.post('/api/admin/users/:id/ban', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!guardAdminTarget(res, target)) return;
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  await db.run(
    `UPDATE users SET banned = 1, banned_reason = ?, banned_at = ? WHERE id = ?`,
    reason,
    Date.now(),
    target.id
  );
  await revokeSessions(target.id, 'banned');
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', target.id);
  await recordLogin({ userId: target.id, email: target.email, ...reqMeta(req), result: 'banned', detail: reason });
  await adminEvent('banned', { user: adminUser(fresh) });
  res.json({ user: adminUser(fresh), stats: await adminStats() });
}));

app.post('/api/admin/users/:id/unban', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!guardAdminTarget(res, target)) return;
  await db.run(
    `UPDATE users SET banned = 0, banned_reason = NULL, banned_at = 0 WHERE id = ?`,
    target.id
  );
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', target.id);
  await adminEvent('unbanned', { user: adminUser(fresh) });
  res.json({ user: adminUser(fresh), stats: await adminStats() });
}));

// daftar lengkap untuk layar pemantauan (status akun, online, device, riwayat masuk)
app.get('/api/admin/monitor', auth.requireAuth, requireAdmin, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = q
    ? await db.all(
        `SELECT * FROM users WHERE LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?)
         ORDER BY last_login_at DESC, LOWER(name) LIMIT 200`,
        like,
        like
      )
    : await db.all('SELECT * FROM users ORDER BY last_login_at DESC, LOWER(name) LIMIT 200');
  // pendaftar menunggu diambil terpisah: last_login_at mereka NULL sehingga selalu
  // tersingkir dari LIMIT 200 saat jumlah user melebihi 200
  const pendingRows = q
    ? await db.all(
        `SELECT * FROM users WHERE banned = 0 AND account_status = 'pending'
         AND (LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?))
         ORDER BY created_at DESC LIMIT 200`,
        like,
        like
      )
    : await db.all(
        `SELECT * FROM users WHERE banned = 0 AND account_status = 'pending'
         ORDER BY created_at DESC LIMIT 200`
      );
  const online = await presence.onlineSet([...rows, ...pendingRows].map((r) => r.id));
  const logs = await db.all('SELECT * FROM login_logs ORDER BY at DESC LIMIT 40');
  res.json({
    users: rows.map((r) => adminUser(r, online.has(r.id))),
    pending: pendingRows.map((r) => adminUser(r, online.has(r.id))),
    logs,
    stats: await adminStats(),
  });
}));

// ---------- notifikasi push (Web Push, tetap muncul saat aplikasi ditutup) ----------
let vapidReady = false;

async function ensureVapid() {
  if (vapidReady) return;
  const v = await settings.getVapid();
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  vapidReady = true;
}

app.get('/api/push/vapid-public-key', auth.requireAuth, ah(async (req, res) => {
  await ensureVapid();
  const v = await settings.getVapid();
  res.json({ publicKey: v.publicKey });
}));

app.post('/api/push/subscribe', auth.requireAuth, ah(async (req, res) => {
  const sub = req.body?.subscription || req.body || {};
  const endpoint = String(sub.endpoint || '').slice(0, 2000);
  const p256dh = String(sub.keys?.p256dh || '');
  const authKey = String(sub.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !authKey) {
    return res.status(400).json({ error: 'Langganan notifikasi tidak valid' });
  }
  const existing = await db.get('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?', endpoint);
  if (existing) {
    if (String(existing.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Endpoint milik pengguna lain' });
    }
    await db.run('UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE id = ?', p256dh, authKey, existing.id);
    return res.json({ ok: true, updated: true });
  }
  const count = await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', req.user.id);
  if (Number(count.n) >= 8) {
    await db.run(
      `DELETE FROM push_subscriptions
       WHERE id = (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1)`,
      req.user.id
    );
  }
  await db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    req.user.id,
    endpoint,
    p256dh,
    authKey,
    Date.now()
  );
  res.status(201).json({ ok: true });
}));

app.post('/api/push/unsubscribe', auth.requireAuth, ah(async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, req.user.id);
  }
  res.json({ ok: true });
}));

// kirim push ke perangkat pengguna yang sedang tidak terhubung (offline / aplikasi tertutup)
async function pushNotify(userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const subs = await db.all(
    `SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids
  );
  if (!subs.length) return 0;
  try {
    await ensureVapid();
  } catch (err) {
    console.error('vapid:', err.message);
    return 0;
  }
  let sent = 0;
  await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload),
          { TTL: 12 * 3600, urgency: 'high' }
        );
        sent += 1;
      } catch (err) {
        const status = Number(err && err.statusCode);
        if ([400, 404, 410].includes(status)) {
          try {
            await db.run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
          } catch { /* langganan basi, biarkan */ }
        } else {
          console.error('push:', err.message);
        }
      }
    })
  );
  return sent;
}

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || 'Terjadi kesalahan',
    ...(err.code ? { code: err.code } : {}),
  });
});

// ---------- presence lintas instance ----------
async function broadcastPresence(userId) {
  const online = await presence.isOnline(userId);
  const row = await db.get('SELECT last_seen, priv_last_seen FROM users WHERE id = ?', userId);
  // privasi "terakhir dilihat & online": orang lain selalu melihat offline
  const hidden = !!(row && row.priv_last_seen);
  const payload = {
    userId,
    online: hidden ? false : online,
    lastSeen: hidden ? 0 : (row && row.last_seen) || Date.now(),
  };
  const contacts = await db.all(
    `SELECT DISTINCT m2.user_id FROM chat_members m1
     JOIN chat_members m2 ON m2.chat_id = m1.chat_id
     WHERE m1.user_id = ? AND m2.user_id <> ?`,
    userId,
    userId
  );
  const contactIds = contacts.map((c) => c.user_id);
  if (contactIds.length) await emitToUsers(contactIds, 'presence', payload);
  // status asli (tanpa masking) untuk diri sendiri
  await emitToUser(userId, 'presence', { userId, online, lastSeen: (row && row.last_seen) || Date.now() });
}

// panggilan saat pengguna pergi: penerima boleh putus & sambung kembali tanpa
// kehilangan dering (seperti WhatsApp); hanya pemanggil yang pergi yang membatalkan
async function cleanupCalls(userId) {
  const mine = await calls.listActiveForUser(userId);
  for (const call of mine) {
    if (call.state === 'ringing') {
      if (call.caller_id !== userId) continue; // penerima offline: dering dibiarkan sampai batas waktu
      const removed = await calls.remove(call.id);
      if (removed) await emitToUser(call.callee_id, 'call:ended', { callId: call.id, reason: 'cancelled' });
      continue;
    }
    if (!(await presence.isOnline(call.caller_id)) && !(await presence.isOnline(call.callee_id))) {
      // sesi aktif ditinggal kedua perangkat -> tutup sebagai riwayat, jangan hapus
      await calls.finish(call.id, 'ended');
    }
  }
}

// notifikasi panggilan tak terjawab ala WhatsApp (daring lewat socket, luring lewat push)
async function notifyMissedCall(call) {
  const caller = await db.get('SELECT * FROM users WHERE id = ?', call.caller_id);
  if (!caller) return;
  const kindLabel = call.kind === 'video' ? 'Panggilan video tak terjawab' : 'Panggilan suara tak terjawab';
  const chat = await helpers.getOrCreateDirectChat(call.caller_id, call.callee_id).catch(() => null);
  const payload = {
    type: 'call',
    action: 'missed',
    title: kindLabel,
    body: caller.name,
    callId: call.id,
    kind: call.kind,
    from: publicCaller(caller, call.callee_id),
    chatId: chat ? chat.id : null,
    icon: caller.priv_avatar ? null : caller.avatar || null,
    tag: `call-${call.id}`,
    url: chat ? `/?chat=${chat.id}` : '/',
    at: Date.now(),
  };
  const delivered = await emitToUser(call.callee_id, 'call:missed', payload);
  if (!delivered) {
    await Promise.race([
      pushNotify([call.callee_id], payload),
      new Promise((resolve) => setTimeout(() => resolve(0), 2500)),
    ]);
  }
}

// pemanggil ikut diberi tahu lewat pusat notifikasi (riwayat ala WhatsApp)
async function notifyCallOutcome(call, reason) {
  const callee = await db.get('SELECT * FROM users WHERE id = ?', call.callee_id);
  if (!callee) return;
  const chat = await helpers.getOrCreateDirectChat(call.caller_id, call.callee_id).catch(() => null);
  const text = {
    timeout: 'Panggilan tidak dijawab',
    rejected: 'Panggilan ditolak',
    declined: 'Panggilan ditolak',
    ended: 'Panggilan berakhir',
  }[reason] || 'Panggilan berakhir';
  await emitToUser(call.caller_id, 'call:log', {
    type: 'call',
    kind: 'missed',
    reason,
    title: text,
    body: callee.name,
    callId: call.id,
    peerId: callee.id,
    chatId: chat ? chat.id : null,
    icon: callee.priv_avatar ? null : callee.avatar || null,
    tag: `calllog-${call.id}`,
    at: Date.now(),
  });
}

// sapu bersih: dering lewat batas waktu -> tak terjawab (+ notifikasi ala WhatsApp)
async function sweepCalls() {
  try {
    const expired = await calls.expireRinging();
    for (const call of expired) {
      await emitToUser(call.caller_id, 'call:ended', { callId: call.id, reason: 'timeout' });
      await notifyMissedCall(call);
      await notifyCallOutcome(call, 'timeout');
    }
    const stale = await calls.expireStaleActive();
    for (const call of stale) {
      await emitToUser(call.caller_id, 'call:ended', { callId: call.id, reason: 'ended' });
      await emitToUser(call.callee_id, 'call:ended', { callId: call.id, reason: 'ended' });
    }
    await calls.purgeOld();
  } catch (err) {
    console.error('sweep calls:', err.message);
  }
}

let callSweepTimer = null;
function startCallSweeper() {
  if (callSweepTimer) return;
  const tick = setInterval(() => void sweepCalls(), 5_000);
  if (tick.unref) tick.unref();
  callSweepTimer = tick;
  void sweepCalls();
}

async function handleDisconnect(user, socketId) {
  try {
    await presence.remove(user.id, socketId);
    if (!presence.isLocal(user.id)) {
      await db.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), user.id);
      await broadcastPresence(user.id);
      if (!(await presence.hasRemote(user.id))) {
        await adminEvent('offline', { userId: user.id, name: user.name, email: user.email, lastSeen: Date.now() });
      }
    }
    await cleanupCalls(user.id);
  } catch (err) {
    console.error('disconnect:', err.message);
  }
}

// ---------- socket.io ----------
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || '';
    const payload = auth.verifyToken(token);
    if (!payload) return next(new Error('auth:tidak-terautentikasi'));
    const user = await db.get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) return next(new Error('auth:akun-tidak-ditemukan'));
    // satu akun satu device + akun diblokir/menunggu persetujuan ditolak di sini
    const check = auth.sessionCheck(payload, user);
    if (!check.ok) return next(new Error(check.code));
    socket.data.user = user;
    socket.data.sid = payload.sid || '';
    next();
  } catch (err) {
    // kegagalan sesaat (DB dsb.) sengaja TIDAK memakai awalan auth: supaya
    // klien tidak menganggapnya token kedaluwarsa dan ikut keluar
    console.error('socket auth:', err.message);
    next(new Error('server:tidak-tersedia'));
  }
});

// memutus socket yang sesinya sudah diganti/dicabut oleh perangkat lain atau admin
function kickReplaced(socket, reason) {
  try {
    socket.emit('auth:session-replaced', { reason });
  } catch { /* koneksi sudah tertutup */ }
  setTimeout(() => {
    try { socket.disconnect(true); } catch { /* sudah putus */ }
  }, 600);
}

io.on('connection', (socket) => {
  const user = socket.data.user;
  const first = presence.addLocal(user.id, socket.id);
  socket.join(`user:${user.id}`);

  void (async () => {
    try {
      await presence.persist(user.id, socket.id);
      if (first) {
        await broadcastPresence(user.id);
        await adminEvent('online', { userId: user.id, name: user.name, email: user.email });
      }
      // panggilan masuk yang masih berdering dikirim ulang ke perangkat ini —
      // penerima boleh tiba/luring dulu, dering tetap sampai padam sendiri
      const pending = await calls.pendingIncoming(user.id);
      for (const call of pending) {
        const caller = await db.get('SELECT * FROM users WHERE id = ?', call.caller_id);
        if (!caller) continue;
        socket.emit('call:incoming', {
          callId: call.id,
          kind: call.kind === 'video' ? 'video' : 'audio',
          from: publicCaller(caller, user.id),
        });
      }
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
    if (!floodGuard(`typing:${user.id}`, 120, 60_000)) return;
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
    if (!floodGuard(`read:${user.id}`, 60, 60_000)) return;
    helpers
      .isMember(chatId, user.id)
      .then((member) => (member ? markChatRead(chatId, user.id) : null))
      .catch((err) => console.error('chat:read:', err.message));
  });

  // ---------- WebRTC signaling ----------
  // hanya pemanggil & penerima yang boleh mengendalikan sebuah panggilan
  const callPeerId = (call, who) => (call.caller_id === who ? call.callee_id : call.caller_id);

  socket.on('call:invite', ({ to, callId, kind } = {}, ack) => {
    const reply = (payload) => { try { ack?.(payload); } catch { /* ack sudah ditutup */ } };
    void (async () => {
      try {
        const targetId = String(to || '');
        const id = String(callId || '');
        if (!id) return reply({ ok: false, error: 'Permintaan panggilan tidak valid' });
        if (!targetId || targetId === user.id) return reply({ ok: false, error: 'Tidak dapat menelepon pengguna ini' });
        const target = await db.get('SELECT id, is_bot FROM users WHERE id = ?', targetId);
        if (!target) return reply({ ok: false, error: 'Pengguna tidak ditemukan' });
        if (bots.isBot(target)) return reply({ ok: false, error: 'Bot tidak dapat dipanggil' });

        // satu pemanggil satu panggilan (baris macet dibersihkan sapu bersih berkala)
        const busy = await db.get(
          `SELECT id FROM calls WHERE caller_id = ? AND state IN ('ringing', 'accepted', 'active')`,
          user.id
        );
        if (busy) return reply({ ok: false, error: 'Anda sedang dalam panggilan lain' });

        const cleanKind = kind === 'video' ? 'video' : 'audio';
        await calls.create({ id, callerId: user.id, calleeId: targetId, kind: cleanKind });

        const delivered = await emitToUser(targetId, 'call:incoming', {
          callId: id,
          kind: cleanKind,
          from: publicCaller(user, targetId),
        });

        // Penerima tidak daring: panggilan TETAP dibuat & tetap berdering di server
        // sampai batas waktu — perangkat penerima dikabari lewat push, dan bila ia
        // kembali daring dalam masa dering, dering dikirim ulang (ala WhatsApp).
        if (!delivered) {
          const chat = await helpers.getOrCreateDirectChat(user.id, targetId).catch(() => null);
          await Promise.race([
            pushNotify([targetId], {
              type: 'call',
              action: 'ring',
              title: cleanKind === 'video' ? 'Panggilan video masuk' : 'Panggilan suara masuk',
              body: user.name,
              callId: id,
              kind: cleanKind,
              from: publicCaller(user, targetId),
              chatId: chat ? chat.id : null,
              icon: user.priv_avatar ? null : user.avatar || null,
              tag: `call-${id}`,
              url: chat ? `/?chat=${chat.id}` : '/',
            }),
            new Promise((resolve) => setTimeout(() => resolve(0), 2500)),
          ]);
        }
        reply({ ok: true, delivered });
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
        if (!call || call.callee_id !== user.id) return; // hanya penerima yang boleh menjawab
        const accepted = await calls.accept(id);
        if (!accepted) return; // sudah ditutup atau sudah dijawab perangkat lain
        await emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'accepted' });
      } catch (err) {
        console.error('call:accept:', err.message);
      }
    })();
  });

  socket.on('call:signal', ({ to, callId, signal } = {}) => {
    void (async () => {
      try {
        const id = String(callId || '');
        if (!id) return;
        const call = await calls.get(id);
        if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) return;
        const targetId = callPeerId(call, user.id);
        if (String(to || '') && String(to) !== targetId) return; // tujuan harus pesertanya sendiri
        if (!signal || typeof signal !== 'object') return;
        if (!['offer', 'answer', 'candidate'].includes(signal.type)) return;
        if (signal.type === 'answer') await calls.setState(id, 'active');
        await emitToUser(targetId, 'call:signal', {
          callId: id,
          from: publicCaller(user, targetId),
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
        const call = await calls.get(id);
        if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) return;
        const peerId = callPeerId(call, user.id);
        const changed = await calls.finish(id, 'declined');
        if (changed) {
          await emitToUser(peerId, 'call:ended', { callId: id, reason: 'rejected' });
          if (call.callee_id === user.id) await notifyCallOutcome(call, 'rejected');
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
        const call = await calls.get(id);
        if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) return;
        const timedOut = reason === 'timeout';
        const peerId = callPeerId(call, user.id);
        const changed = await calls.finish(id, timedOut ? 'missed' : 'ended');
        await emitToUser(peerId, 'call:ended', { callId: id, reason: timedOut ? 'timeout' : 'ended' });
        await emitToUserExcept(user.id, socket.id, 'call:ended', { callId: id, reason: 'ended' });
        if (changed && timedOut) {
          await notifyMissedCall(call);
          await notifyCallOutcome(call, 'timeout');
        }
      } catch (err) {
        console.error('call:hangup:', err.message);
      }
    })();
  });

  socket.on('disconnect', () => {
    void handleDisconnect(user, socket.id);
  });
});

// bot selalu membaca pesan masuk -> pengirim langsung mendapat centang biru
async function markBotReceipt(messageId, botId, chatId, senderId) {
  const now = Date.now();
  await db.run(
    `INSERT INTO message_status (message_id, user_id, status, at) VALUES (?, ?, 'delivered', ?), (?, ?, 'read', ?)
     ON CONFLICT (message_id, user_id) DO NOTHING`,
    messageId,
    botId,
    now,
    messageId,
    botId,
    now
  );
  await emitToUser(senderId, 'message:status', { messageId, chatId, status: 'read' });
}

// simpan balasan bot, kabari penerima daring, notifikasi yang luring
async function deliverBotMessage(bot, chatId, text, targets, media) {
  const id = crypto.randomUUID();
  const now = Date.now();
  let mediaUrl = media && media.url ? String(media.url) : '';
  let mediaSize = media && media.size ? Number(media.size) || null : null;
  let mediaName = media && media.name ? String(media.name).slice(0, 200) : '';
  const allowed = ['image', 'video', 'audio', 'file'];
  let type = media && allowed.includes(media.type) ? media.type : (mediaUrl ? 'image' : null);
  let caption = String(text || '');
  const isRemote = /^https?:\/\//i.test(mediaUrl);
  const isStored = /^\/uploads\//.test(mediaUrl);
  const hasMedia = !!mediaUrl && (isRemote || isStored);

  // hasil unduhan video/audio/berkas disimpan dulu ke penyimpanan kita:
  // tautan pihak ketiga cepat kedaluwarsa, file tersimpan tetap bisa
  // ditonton/diunduh kapan saja. `media.cached` = sudah tersimpan oleh bot.
  if (hasMedia && isRemote && !media.cached && ['video', 'audio', 'file'].includes(type)) {
    const saved = await storeRemoteFile(mediaUrl, type, { name: mediaName });
    if (saved) {
      mediaUrl = saved.url;
      mediaSize = saved.size;
      if (!mediaName) mediaName = saved.name.slice(0, 200);
      const mb = (saved.size / (1024 * 1024)).toFixed(1);
      const tail = type === 'video'
        ? 'siap ditonton & diunduh'
        : type === 'audio'
          ? 'siap didengarkan'
          : 'siap diunduh';
      caption = `${caption ? caption + '\n\n' : ''}📥 Hasil unduhan: ${mb} MB — ${tail}.`.slice(0, 8000);
    }
  }

  if (!hasMedia) type = null;
  const msgType = type || 'text';
  await db.run(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_size, mime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    chatId,
    bot.id,
    msgType,
    caption.slice(0, 8000),
    hasMedia ? mediaUrl.slice(0, 2000) : null,
    hasMedia ? mediaName || null : null,
    hasMedia ? mediaSize : null,
    hasMedia ? String(media.mime || '').slice(0, 100) || null : null,
    now
  );

  const row = await db.get('SELECT * FROM messages WHERE id = ?', id);
  const message = (await helpers.serializeMessages([row], targets[0] || null))[0];

  const deliveredTo = [];
  for (const uid of targets) {
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

  const offline = targets.filter((uid) => !deliveredTo.includes(uid));
  if (offline.length) {
    await Promise.race([
      pushNotify(offline, {
        title: bot.name,
        body: (String(caption || '').trim() || (hasMedia ? String(mediaName || 'Mengirim media') : 'Pesan')).slice(0, 140),
        chatId,
        messageId: id,
        icon: bot.avatar || null,
        tag: `msg-${chatId}`,
        url: `/?chat=${chatId}`,
      }),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }

  await emitToUsers(targets, 'chat:updated', { chatId });
}

// jalur balasan bot: indikator mengetik -> proses perintah (API api-mazval) -> kirim balasan
async function respondToBot({ bot, chatId, members, sender, userMessageId, text, type }) {
  const targets = members.filter((uid) => uid !== bot.id);
  if (!targets.length) return;

  let typing = true;
  const stopTyping = async () => {
    if (!typing) return;
    typing = false;
    try {
      await emitToUsers(targets, 'typing', { chatId, userId: bot.id, typing: false });
    } catch { /* indikator sudah dilepas */ }
  };

  try {
    await markBotReceipt(userMessageId, bot.id, chatId, sender.id);

    const chat = await db.get('SELECT type FROM chats WHERE id = ?', chatId);
    if (chat && chat.type !== 'direct') return; // bot tidak membalas di grup

    await emitToUsers(targets, 'typing', { chatId, userId: bot.id, typing: true });
    // pertahankan indikator "mengetik" selama bot memproses (mis. menunggu jawaban AI)
    let finished = false;
    const keepalive = setInterval(() => {
      if (finished) return;
      emitToUsers(targets, 'typing', { chatId, userId: bot.id, typing: true }).catch(() => { /* koneksi sudah ditutup */ });
    }, 2500);

    let out;
    try {
      out = type !== 'text'
        ? '❌ Bot hanya memproses pesan teks. Kirim teks, atau balas "menu" untuk melihat perintah.'
        : await bots.reply(bot, text);
      if (out) {
        // balasan bot boleh berupa teks saja atau { text, media } (preview gambar/video);
        // indikator mengetik tetap hidup sampai media selesai diunduh & terkirim
        const payload = out && typeof out === 'object' ? out : { text: out };
        if (payload.text || payload.media) {
          await deliverBotMessage(bot, chatId, payload.text || '', targets, payload.media);
        }
      }
    } finally {
      finished = true;
      clearInterval(keepalive);
      await stopTyping();
    }
  } catch (err) {
    console.error('bot:', err.message);
    await stopTyping();
    try {
      await deliverBotMessage(bot, chatId, `⚠️ ${(err && err.message) || 'Gagal memproses permintaan.'}`, targets);
    } catch (e) {
      console.error('bot deliver:', e.message);
    }
  }
}

async function handleSend(user, payload) {
  const { chatId, type = 'text', body = '', media, viewOnce, duration } = payload || {};
  if (!chatId || !(await helpers.isMember(chatId, user.id))) {
    throw new Error('Bukan anggota chat ini');
  }

  // bot internal: akses dibatasi untuk admin & pengguna premium sesuai paketnya
  const botPeer = await bots.peerInChat(chatId);
  if (botPeer && !canUseBots(user)) {
    throw new Error('Bot hanya dapat digunakan oleh admin dan pengguna premium.');
  }
  if (botPeer) {
    const excluded = await excludedBots(user);
    if (excluded.has(botPeer.id)) {
      const plan = await settings.planOf(user);
      throw new Error(
        `Bot ini tidak termasuk paket ${plan ? plan.label : 'Anda'}. Buka menu Paket & Harga untuk upgrade.`
      );
    }
  }

  const cleanType = ['text', 'image', 'video', 'audio', 'file'].includes(type) ? type : 'text';
  if (cleanType === 'text' && !String(body).trim()) throw new Error('Pesan kosong');

  // proteksi akun: batasi laju pengiriman supaya tidak terdeteksi sebagai spam
  if (!floodGuard(`msg:${user.id}`, 30, 10_000)) {
    throw new Error('Terlalu banyak pesan dalam waktu singkat (anti-spam). Mohon tunggu sebentar.');
  }

  const text = String(body || '').slice(0, 8000);
  if (cleanType === 'text' && text.trim()) {
    const norm = text.trim().toLowerCase();
    const recent = await db.get(
      `SELECT body FROM messages
       WHERE chat_id = ? AND sender_id = ? AND deleted_at IS NULL AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
      chatId,
      user.id,
      Date.now() - 5000
    );
    if (recent && String(recent.body || '').trim().toLowerCase() === norm) {
      throw new Error('Pesan sama dikirim berulang (anti-spam). Tunggu beberapa detik.');
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const mediaUrl = cleanType === 'text' ? null : media?.url || null;
  if (cleanType !== 'text' && !mediaUrl) throw new Error('Media tidak ditemukan');

  const cleanViewOnce = cleanType === 'image' && !!viewOnce ? 1 : 0;
  const cleanDuration = Math.max(0, Math.min(3_600_000, Math.round(Number(duration) || 0)));

  // potong kuota tepat sebelum pesan disimpan (habis -> token undangan -> ditolak)
  if (botPeer) await consumeBotQuota(user);

  await db.run(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_size, mime, view_once, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    chatId,
    user.id,
    cleanType,
    text,
    mediaUrl,
    media?.name ? String(media.name).slice(0, 255) : null,
    media?.size ? Number(media.size) : null,
    media?.mime || null,
    cleanViewOnce,
    cleanDuration,
    now
  );

  const row = await db.get('SELECT * FROM messages WHERE id = ?', id);
  const message = (await helpers.serializeMessages([row], user.id))[0];
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

  // penerima yang tidak punya koneksi aktif -> notifikasi push (aplikasi tertutup/offline)
  const offline = members.filter((uid) => uid !== user.id && !deliveredTo.includes(uid));
  if (offline.length) {
    const chatRow = await db.get('SELECT type, name FROM chats WHERE id = ?', chatId);
    const kindLabel = { image: 'Foto', video: 'Video', audio: 'Pesan suara', file: 'File' };
    let preview = cleanType === 'text' ? String(text).slice(0, 140) : (kindLabel[cleanType] || 'Pesan');
    if (cleanViewOnce) preview = 'Foto sekali lihat';
    const payload = {
      title: chatRow && chatRow.type === 'group' ? `${user.name} @ ${chatRow.name}` : user.name,
      body: preview,
      chatId,
      messageId: id,
      icon: user.priv_avatar ? null : user.avatar || null,
      tag: `msg-${chatId}`,
      url: `/?chat=${chatId}`,
    };
    await Promise.race([
      pushNotify(offline, payload),
      new Promise((resolve) => setTimeout(() => resolve(0), 2500)),
    ]);
  }

  const freshRow = await db.get('SELECT * FROM messages WHERE id = ?', id);
  const fresh = (await helpers.serializeMessages([freshRow], user.id))[0];

  if (fresh.status === 'delivered') {
    await emitToUser(user.id, 'message:status', { messageId: id, chatId, status: 'delivered' });
  }

  await emitToUsers(members, 'chat:updated', { chatId });

  if (botPeer) {
    void respondToBot({
      bot: botPeer,
      chatId,
      members,
      sender: user,
      userMessageId: id,
      text: cleanType === 'text' ? text : '',
      type: cleanType,
    });
  }

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
  try {
    await bots.seed();
  } catch (err) {
    console.error('bot:', err.message);
  }
  presence.start();
  startCallSweeper();
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
