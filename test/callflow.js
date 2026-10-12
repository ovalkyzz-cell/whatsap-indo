'use strict';
/* Uji alur panggilan suara/video lewat Socket.IO — memakai server sungguhan
   (localhost:3000), bukan simulasi: menelepon, diterima, sinyal WebRTC berbalas,
   state di database dicek lewat /api/calls, sampai alur tak terjawab & timeout.
   Dipakai `npm run test:callflow` dan server mini admin (admin/server.js). */
const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/* ---------- harness: admin, persetujuan & sesi ---------- */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secret123';
let admToken = null;

async function admLogin() {
  let r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD },
  });
  if (r.status !== 201) {
    r = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  }
  if (!r.data || !r.data.token) throw new Error(`gagal menyiapkan admin: ${r.status}`);
  admToken = r.data.token;
  return admToken;
}

async function admApi(path, opts = {}) {
  if (!admToken) await admLogin();
  let r = await api(path, { ...opts, token: admToken });
  if (r.status === 401) {
    await admLogin();
    r = await api(path, { ...opts, token: admToken });
  }
  return r;
}

async function signup({ email, name, password }) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, name, password },
  });
  if (r.status !== 201) return r;
  if (!r.data.pending) return r;
  const ap = await admApi(`/api/admin/users/${encodeURIComponent(r.data.user.id)}/approve`, {
    method: 'POST',
    body: {},
  });
  if (ap.status !== 200) throw new Error(`persetujuan gagal: ${JSON.stringify(ap.data)}`);
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (lg.status !== 200) throw new Error(`login setelah disetujui gagal: ${JSON.stringify(lg.data)}`);
  return { status: 201, data: lg.data };
}

function connect(token) {
  return io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

const waitEvent = (sock, event, timeout = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
  sock.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

const expectNoEvent = (sock, event, ms = 400) => new Promise((resolve) => {
  const handler = (payload) => { clearTimeout(t); sock.off(event, handler); resolve({ got: true, payload }); };
  const t = setTimeout(() => { sock.off(event, handler); resolve({ got: false }); }, ms);
  sock.once(event, handler);
});

/* hanya call:invite yang membalas lewat ack — sisanya event satu arah */
function emitAck(sock, event, payload, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    sock.emit(event, payload, (res) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(res);
    });
  });
}

const fire = (sock, event, payload) => { sock.emit(event, payload); };

async function stateOf(token, callId) {
  const r = await api('/api/calls?limit=50', { token });
  const row = (r.data.calls || []).find((c) => c.id === callId);
  return row ? row.state : null;
}

(async () => {
  const stamp = Date.now();
  console.log('\n[1] Menyiapkan akun uji panggilan');
  await admLogin();
  const userA = (await signup({ email: `panggil-a-${stamp}@uji.test`, name: 'Pemanggil A', password: 'rahasia123' })).data;
  const userB = (await signup({ email: `panggil-b-${stamp}@uji.test`, name: 'Penerima B', password: 'rahasia123' })).data;
  ok(!!userA.token && !!userB.token, 'akun pemanggil & penerima siap (disetujui admin)');

  const sockA = connect(userA.token);
  let sockB = connect(userB.token);
  await Promise.all([
    new Promise((r) => sockA.once('connect', r)),
    new Promise((r) => sockB.once('connect', r)),
  ]);
  ok(sockA.connected && sockB.connected, 'kedua perangkat terhubung ke server');

  /* ---------- [2] alur normal: dering -> jawab -> tersambung -> ditutup ---------- */
  console.log('\n[2] Panggilan suara dijawab lalu ditutup');
  const call1 = `call-flow-${stamp}-1`;
  const inc1 = waitEvent(sockB, 'call:incoming', 6000);
  const ack1 = await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: call1, kind: 'audio' });
  ok(ack1 && ack1.ok === true, `invite diterima server (delivered=${ack1 && ack1.delivered})`);
  const incoming1 = await inc1;
  ok(incoming1 && incoming1.callId === call1 && incoming1.from.id === userA.user.id,
    'penerima langsung menerima dering (call:incoming)');

  const gotOffer1 = waitEvent(sockA, 'call:signal', 6000);
  const gotAnswer1 = waitEvent(sockB, 'call:signal', 6000);
  fire(sockB, 'call:accept', { callId: call1 });
  await sleep(150);
  ok((await stateOf(userA.token, call1)) !== 'missed', 'menjawab tidak menandai missed');

  // tawaran WebRTC dari penerima -> dijawab pemanggil (balasan sinyal berpasangan)
  fire(sockB, 'call:signal', {
    to: userA.user.id, callId: call1,
    signal: { type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' } },
  });
  const offer = await gotOffer1;
  ok(offer && offer.signal && offer.signal.type === 'offer', 'pemanggil menerima offer dari penerima');

  fire(sockA, 'call:signal', {
    to: userB.user.id, callId: call1,
    signal: { type: 'answer', answer: { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' } },
  });
  const answer = await gotAnswer1;
  ok(answer && answer.signal && answer.signal.type === 'answer', 'penerima menerima answer dari pemanggil');
  await sleep(250);
  ok((await stateOf(userA.token, call1)) === 'active', 'state di database menjadi active setelah answer');

  const cand1 = waitEvent(sockA, 'call:signal', 6000);
  fire(sockB, 'call:signal', {
    to: userA.user.id, callId: call1,
    signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 54321 typ host', sdpMid: '0' } },
  });
  ok(!!(await cand1), 'kandidat ICE diteruskan antar peserta');

  const ended1 = waitEvent(sockB, 'call:ended', 6000);
  fire(sockA, 'call:hangup', { to: userB.user.id, callId: call1 });
  const end1 = await ended1;
  ok(end1 && end1.reason === 'ended', `penerima diberi tahu panggilan berakhir (reason=${end1 && end1.reason})`);
  await sleep(300);
  ok((await stateOf(userA.token, call1)) === 'ended', 'state berakhir menjadi ended');

  /* ---------- [3] regresi: timeout saat aktif TIDAK boleh jadi missed ---------- */
  console.log('\n[3] Timeout palsu pada panggilan yang sedang aktif');
  const call2 = `call-flow-${stamp}-2`;
  const inc2 = waitEvent(sockB, 'call:incoming', 6000);
  const ack2 = await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: call2, kind: 'video' });
  ok(ack2 && ack2.ok === true, `invite video diterima (dapat: ${ack2 && (ack2.error || 'ok')})`);
  await inc2;

  const gotOffer2 = waitEvent(sockA, 'call:signal', 6000);
  const gotAnswer2 = waitEvent(sockB, 'call:signal', 6000);
  fire(sockB, 'call:accept', { callId: call2 });
  fire(sockB, 'call:signal', {
    to: userA.user.id, callId: call2,
    signal: { type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\n' } },
  });
  await gotOffer2;
  fire(sockA, 'call:signal', {
    to: userB.user.id, callId: call2,
    signal: { type: 'answer', answer: { type: 'answer', sdp: 'v=0\r\n' } },
  });
  await gotAnswer2;
  await sleep(300);
  ok((await stateOf(userA.token, call2)) === 'active', 'panggilan video aktif');

  const missedProbe = expectNoEvent(sockB, 'call:missed', 500);
  const ended2 = waitEvent(sockB, 'call:ended', 6000);
  fire(sockA, 'call:hangup', { to: userB.user.id, callId: call2, reason: 'timeout' });
  const end2 = await ended2;
  const missedEvt = await missedProbe;
  await sleep(300);
  const st2 = await stateOf(userA.token, call2);
  ok(st2 === 'ended', `panggilan aktif + alasan timeout ditutup sebagai ended (dapat: ${st2})`);
  ok(!missedEvt.got, 'penerima TIDAK mendapat notifikasi panggilan tak terjawab');
  ok(end2 && end2.reason === 'ended', `alasan yang diterima penerima = ${end2 && end2.reason}`);

  /* ---------- [4] alur tak terjawab: dering lewat -> missed + notifikasi ---------- */
  console.log('\n[4] Panggilan tak terjawab');
  const call3 = `call-flow-${stamp}-3`;
  const inc3 = waitEvent(sockB, 'call:incoming', 6000);
  const ack3 = await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: call3, kind: 'audio' });
  ok(ack3 && ack3.ok === true, 'undangan dering ke-3 diterima');
  await inc3;
  const missed3 = waitEvent(sockB, 'call:missed', 6000);
  const log3 = waitEvent(sockA, 'call:log', 6000);
  fire(sockA, 'call:hangup', { to: userB.user.id, callId: call3, reason: 'timeout' });
  const m3 = await missed3;
  const l3 = await log3;
  await sleep(300);
  ok(m3 && m3.callId === call3, 'penerima mendapat notifikasi panggilan tak terjawab');
  ok(l3 && l3.callId === call3, 'pemanggil mendapat riwayat "Panggilan tidak dijawab"');
  ok((await stateOf(userA.token, call3)) === 'missed', 'state tercatat missed');

  /* ---------- [5] penerima luring: dering dikirim ulang saat kembali ---------- */
  console.log('\n[5] Penerima luring lalu kembali daring');
  sockB.disconnect(); // perangkat penerima benar-benar offline
  await sleep(400);
  const call4 = `call-flow-${stamp}-4`;
  const ack4 = await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: call4, kind: 'audio' });
  ok(ack4 && ack4.ok === true, `penerima luring tetap membuat panggilan (dapat: ${ack4 && (ack4.error || 'ok')})`);
  ok(ack4 && ack4.delivered === false, 'server melaporkan penerima tidak daring (push dipakai)');
  const sockB3 = connect(userB.token);
  const rerung = waitEvent(sockB3, 'call:incoming', 6000);
  await new Promise((r) => sockB3.once('connect', r));
  const again = await rerung;
  ok(again && again.callId === call4, 'dering dikirim ulang saat perangkat penerima kembali daring');
  fire(sockA, 'call:hangup', { to: userB.user.id, callId: call4, reason: 'timeout' });
  await sleep(300);
  sockB3.disconnect();
  sockB = connect(userB.token); // pulihkan sesi B untuk sisa uji
  await new Promise((r) => sockB.once('connect', r));

  /* ---------- [6] penolakan: bot, pemanggil sibuk, ditolak penerima ---------- */
  console.log('\n[6] Penolakan panggilan');
  const botAck = await emitAck(sockA, 'call:invite', { to: 'bot-ai', callId: `call-bot-${stamp}`, kind: 'audio' });
  ok(botAck && botAck.ok === false && /Bot tidak dapat dipanggil/.test(botAck.error || ''),
    `panggilan ke bot ditolak (dapat: ${botAck && botAck.error})`);

  const call5 = `call-flow-${stamp}-5`;
  const inc5 = waitEvent(sockB, 'call:incoming', 6000);
  await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: call5, kind: 'audio' });
  await inc5;
  const busyAck = await emitAck(sockA, 'call:invite', { to: userB.user.id, callId: `${call5}-b`, kind: 'audio' });
  ok(busyAck && busyAck.ok === false && /panggilan lain/.test(busyAck.error || ''),
    `pemanggil sibuk ditolak (dapat: ${busyAck && busyAck.error})`);

  const rejected = waitEvent(sockA, 'call:ended', 6000);
  const logReject = waitEvent(sockA, 'call:log', 6000);
  fire(sockB, 'call:reject', { to: userA.user.id, callId: call5 });
  const rj = await rejected;
  const lr = await logReject;
  ok(rj && rj.reason === 'rejected', `pemanggil diberi tahu ditolak (reason=${rj && rj.reason})`);
  ok(lr && lr.callId === call5, 'penolakan tercatat di riwayat panggilan');
  await sleep(300);
  ok((await stateOf(userA.token, call5)) === 'declined', 'state tercatat declined');

  /* ---------- [7] penutupan sesi: panggilan keluar batal saat pemanggil pergi ---------- */
  console.log('\n[7] Pemanggil menutup perangkat saat masih berdering');
  const call6 = `call-flow-${stamp}-6`;
  const sockA2 = connect(userA.token);
  await new Promise((r) => sockA2.once('connect', r));
  const inc6 = waitEvent(sockB, 'call:incoming', 6000);
  await emitAck(sockA2, 'call:invite', { to: userB.user.id, callId: call6, kind: 'audio' });
  await inc6;
  sockA2.disconnect(); // sesi pemanggil lain (sockA) masih terbuka -> dering tetap jalan
  await sleep(700);
  const st6 = await stateOf(userA.token, call6);
  ok(st6 === 'ringing', `menutup satu tab TIDAK membatalkan panggilan tab lain (state=${st6})`);
  fire(sockA, 'call:hangup', { to: userB.user.id, callId: call6, reason: 'timeout' });
  await sleep(300);

  sockA.disconnect();
  sockB.disconnect();
  try { await api('/api/auth/logout', { method: 'POST', token: userA.token }); } catch { /* sesi ditutup */ }
  try { await api('/api/auth/logout', { method: 'POST', token: userB.token }); } catch { /* sesi ditutup */ }

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
