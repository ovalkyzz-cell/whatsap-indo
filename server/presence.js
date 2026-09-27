'use strict';

const db = require('./db');

const TTL = 90_000;
const local = new Map();
let emitter = null;
let timers = null;

function ph(n) {
  return Array(n).fill('?').join(', ');
}

function bind(fn) {
  emitter = fn;
}

function isLocal(userId) {
  return local.has(userId);
}

function emitLocal(userId, event, payload, except) {
  const set = local.get(userId);
  if (!set || set.size === 0) return false;
  let sent = false;
  for (const sid of set) {
    if (except && sid === except) continue;
    if (emitter) {
      emitter(sid, event, payload);
      sent = true;
    }
  }
  return sent;
}

function addLocal(userId, socketId) {
  let set = local.get(userId);
  const first = !set;
  if (!set) {
    set = new Set();
    local.set(userId, set);
  }
  set.add(socketId);
  return first;
}

async function persist(userId, socketId) {
  try {
    await db.run(
      `INSERT INTO presence (user_id, socket_id, instance_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, socket_id) DO UPDATE SET instance_id = excluded.instance_id, at = excluded.at`,
      userId,
      socketId,
      db.INSTANCE_ID,
      Date.now()
    );
  } catch (err) {
    console.error('presence persist:', err.message);
  }
}

async function remove(userId, socketId) {
  const set = local.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) local.delete(userId);
  }
  try {
    await db.run('DELETE FROM presence WHERE user_id = ? AND socket_id = ?', userId, socketId);
  } catch (err) {
    console.error('presence remove:', err.message);
  }
}

function cutoff() {
  return Date.now() - TTL;
}

async function isOnline(userId) {
  if (isLocal(userId)) return true;
  const row = await db.get('SELECT 1 AS online FROM presence WHERE user_id = ? AND at > ?', userId, cutoff());
  return !!row;
}

async function onlineSet(userIds) {
  const out = new Set();
  if (!userIds || !userIds.length) return out;
  for (const id of userIds) if (isLocal(id)) out.add(id);
  const rows = await db.all(
    `SELECT user_id FROM presence WHERE at > ? AND user_id IN (${ph(userIds.length)})`,
    cutoff(),
    ...userIds
  );
  for (const row of rows) out.add(row.user_id);
  return out;
}

async function remoteIds(userIds) {
  if (!userIds || !userIds.length) return [];
  const rows = await db.all(
    `SELECT DISTINCT user_id FROM presence WHERE at > ? AND instance_id <> ? AND user_id IN (${ph(userIds.length)})`,
    cutoff(),
    db.INSTANCE_ID,
    ...userIds
  );
  return rows.map((r) => r.user_id);
}

async function hasRemote(userId) {
  const row = await db.get(
    'SELECT 1 AS online FROM presence WHERE user_id = ? AND at > ? AND instance_id <> ?',
    userId,
    cutoff(),
    db.INSTANCE_ID
  );
  return !!row;
}

function start() {
  if (timers) return;
  const heartbeat = setInterval(async () => {
    if (!local.size) return;
    try {
      await db.run('UPDATE presence SET at = ? WHERE instance_id = ?', Date.now(), db.INSTANCE_ID);
    } catch (err) {
      console.error('presence heartbeat:', err.message);
    }
  }, 30_000);
  const sweeper = setInterval(async () => {
    try {
      await db.run('DELETE FROM presence WHERE at < ?', cutoff());
    } catch (err) {
      console.error('presence sweep:', err.message);
    }
  }, 60_000);
  heartbeat.unref();
  sweeper.unref();
  timers = { heartbeat, sweeper };
}

module.exports = {
  bind,
  addLocal,
  persist,
  remove,
  emitLocal,
  isLocal,
  isOnline,
  onlineSet,
  remoteIds,
  hasRemote,
  start,
};
