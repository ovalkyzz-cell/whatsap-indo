'use strict';

const db = require('./db');

const RETENTION = 5 * 60_000;
const POLL_MS = 300;
const PROBE_TIMEOUT = 8000;
const SEEN_LIMIT = 1000;

let handler = null;
let listener = null;
let pollTimer = null;
let drainPromise = null;
let cleanupTimer = null;
let started = false;
let probeOk = false;
let lastSeq = 0;
let seqCounter = 0;
const seen = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markSeen(id) {
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    seen.delete(oldest);
  }
}

function listenUrl() {
  if (process.env.LISTEN_DATABASE_URL) return process.env.LISTEN_DATABASE_URL;
  return String(process.env.DATABASE_URL || '').replace('-pooler.', '.');
}

async function publish(msg) {
  if (db.dialect !== 'pg') return;
  const msgId = `${db.INSTANCE_ID}:${++seqCounter}`;
  markSeen(msgId);
  await db.all(
    `WITH ins AS (
       INSERT INTO bus (msg_id, from_instance, payload, at) VALUES (?, ?, ?, ?) RETURNING seq
     )
     SELECT pg_notify('bus', seq::text) AS notified FROM ins`,
    msgId,
    db.INSTANCE_ID,
    JSON.stringify(msg),
    Date.now()
  );
}

function deliver(row) {
  let data;
  try {
    data = JSON.parse(row.payload);
  } catch {
    return;
  }
  if (data.event === 'bus:probe') {
    if (row.from_instance === db.INSTANCE_ID) probeOk = true;
    return;
  }
  const msgId = String(row.msg_id);
  if (seen.has(msgId)) return;
  if (row.from_instance === db.INSTANCE_ID) {
    markSeen(msgId);
    return;
  }
  markSeen(msgId);
  if (!handler) return;
  try {
    handler(data);
  } catch (err) {
    console.error('bus handler:', err.message);
  }
}

async function drainBatch() {
  for (;;) {
    const rows = await db.all(
      `SELECT seq, msg_id, from_instance, payload FROM bus WHERE seq > ? ORDER BY seq LIMIT 500`,
      lastSeq
    );
    for (const row of rows) {
      lastSeq = Number(row.seq);
      deliver(row);
    }
    if (rows.length < 500) return;
  }
}

function drain() {
  if (drainPromise) return drainPromise;
  drainPromise = drainBatch()
    .catch((err) => console.error('bus drain:', err.message))
    .finally(() => {
      drainPromise = null;
    });
  return drainPromise;
}

function startPolling() {
  if (pollTimer) return;
  const tick = setInterval(() => drain(), POLL_MS);
  if (tick.unref) tick.unref();
  pollTimer = tick;
}

async function probe() {
  probeOk = false;
  try {
    await publish({ userIds: [], event: 'bus:probe', payload: {} });
  } catch (err) {
    console.error('bus probe publish:', err.message);
    return false;
  }
  const deadline = Date.now() + PROBE_TIMEOUT;
  while (Date.now() < deadline) {
    if (probeOk) return true;
    await sleep(100);
  }
  return false;
}

async function startListener() {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    return false;
  }
  const client = new Client({ connectionString: listenUrl(), connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query('LISTEN bus');
  } catch (err) {
    console.error('bus LISTEN tidak tersedia, memakai polling:', err.message);
    try {
      await client.end();
    } catch { /* koneksi sudah gagal */ }
    return false;
  }
  client.on('notification', () => drain());
  client.on('error', (err) => {
    console.error('bus listener putus:', err.message);
    if (listener === client) listener = null;
    try {
      client.end();
    } catch { /* sudah tertutup */ }
    startPolling();
  });
  listener = client;
  const ok = await probe();
  if (ok) return true;
  listener = null;
  try {
    await client.end();
  } catch { /* sudah tertutup */ }
  console.error('bus: notifikasi tidak sampai, memakai polling');
  return false;
}

function startCleanup() {
  if (cleanupTimer) return;
  const timer = setInterval(async () => {
    try {
      await db.run('DELETE FROM bus WHERE at < ?', Date.now() - RETENTION);
    } catch (err) {
      console.error('bus cleanup:', err.message);
    }
  }, 60_000);
  if (timer.unref) timer.unref();
  cleanupTimer = timer;
}

async function start(onMessage) {
  if (started) return;
  started = true;
  handler = onMessage;
  if (db.dialect !== 'pg') return;
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM bus');
  lastSeq = Number(row && row.seq) || 0;
  startCleanup();
  const live = await startListener();
  if (!live) console.error('bus: listener tidak hidup, polling menjadi satu-satunya jalur');
  // polling tetap jalan walau LISTEN hidup: menutup jeda sebelum LISTEN terpasang
  // dan mendeteksi koneksi notifikasi yang putus tanpa error
  startPolling();
}

module.exports = { start, publish };
