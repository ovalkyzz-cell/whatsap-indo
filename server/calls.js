'use strict';

const db = require('./db');

async function create({ id, callerId, calleeId, kind }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO calls (id, caller_id, callee_id, kind, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ringing', ?, ?)`,
    id,
    callerId,
    calleeId,
    kind === 'video' ? 'video' : 'audio',
    now,
    now
  );
}

async function get(id) {
  return db.get('SELECT * FROM calls WHERE id = ?', id);
}

async function setState(id, state) {
  await db.run('UPDATE calls SET state = ?, updated_at = ? WHERE id = ?', state, Date.now(), id);
}

async function remove(id) {
  const res = await db.run('DELETE FROM calls WHERE id = ?', id);
  return res.changes > 0;
}

async function listForUser(userId) {
  return db.all('SELECT * FROM calls WHERE caller_id = ? OR callee_id = ?', userId, userId);
}

module.exports = { create, get, setState, remove, listForUser };
