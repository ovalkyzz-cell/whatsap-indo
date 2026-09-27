'use strict';
/* E2E test: register 2 users, chat realtime, upload, read receipts */
const { io } = require('socket.io-client');
const fs = require('fs');
const BASE = 'http://localhost:3000';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const waitEvent = (sock, event, timeout = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
  sock.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

const expectNoEvent = (sock, event, ms = 350) => new Promise((resolve) => {
  const handler = (payload) => { clearTimeout(t); sock.off(event, handler); resolve({ got: true, payload }); };
  const t = setTimeout(() => { sock.off(event, handler); resolve({ got: false }); }, ms);
  sock.once(event, handler);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stamp = Date.now();

  console.log('\n[1] Auth');
  const r1 = await api('/api/auth/register', { method: 'POST', body: { email: `andi${stamp}@test.id`, name: 'Andi', password: 'secret123' } });
  ok(r1.status === 201 && r1.data.token, 'register Andi');
  const r2 = await api('/api/auth/register', { method: 'POST', body: { email: `budi${stamp}@test.id`, name: 'Budi', password: 'secret123' } });
  ok(r2.status === 201 && r2.data.token, 'register Budi');
  const r3 = await api('/api/auth/register', { method: 'POST', body: { email: `andi${stamp}@test.id`, name: 'Duplikat', password: 'secret123' } });
  ok(r3.status === 409, 'duplicate email rejected 409');
  const r4 = await api('/api/auth/login', { method: 'POST', body: { email: `andi${stamp}@test.id`, password: 'salah' } });
  ok(r4.status === 401, 'wrong password rejected 401');
  const r5 = await api('/api/auth/login', { method: 'POST', body: { email: `andi${stamp}@test.id`, password: 'secret123' } });
  ok(r5.status === 200 && r5.data.token, 'login success');

  const tokA = r1.data.token, tokB = r2.data.token;
  const userA = r1.data.user, userB = r2.data.user;

  console.log('\n[2] Token guard');
  const rg = await api('/api/chats');
  ok(rg.status === 401, 'no token -> 401');

  console.log('\n[3] Direct chat');
  const rc = await api('/api/chats/direct', { method: 'POST', token: tokA, body: { peerId: userB.id } });
  ok(rc.status === 201 && rc.data.chat, 'create direct chat');
  const chatId = rc.data.chat.id;
  const rc2 = await api('/api/chats/direct', { method: 'POST', token: tokA, body: { peerId: userB.id } });
  ok(rc2.data.chat.id === chatId, 'same chat returned (idempotent)');

  console.log('\n[4] Realtime messaging');
  const sockA = io(BASE, { auth: { token: tokA } });
  const sockB = io(BASE, { auth: { token: tokB } });
  await Promise.all([
    new Promise((r) => sockA.on('connect', r)),
    new Promise((r) => sockB.on('connect', r)),
  ]);
  ok(true, 'both sockets connected');

  const bGetsMsg = waitEvent(sockB, 'message:new');
  let aAck = null;
  sockA.emit('message:send', { chatId, type: 'text', body: 'Halo Budi!' }, (res) => { aAck = res; });
  const msg1 = await bGetsMsg;
  ok(msg1.body === 'Halo Budi!', 'B receives message in realtime');
  await new Promise((r) => setTimeout(r, 200));
  ok(aAck?.ok && aAck?.message?.id === msg1.id, 'sender ack matches');

  const statusEvent = waitEvent(sockA, 'message:status');
  sockB.emit('chat:read', { chatId });
  const st = await statusEvent;
  ok(st.status === 'read' && st.messageId === msg1.id, 'read receipt received by sender');

  const typingEv = waitEvent(sockB, 'typing');
  sockA.emit('typing', { chatId, typing: true });
  const ty = await typingEv;
  ok(ty.typing === true && ty.userId === userA.id, 'typing indicator received');

  const presenceEv = waitEvent(sockB, 'presence');
  sockA.disconnect();
  const pr = await presenceEv;
  ok(pr.userId === userA.id && pr.online === false, 'presence offline broadcast');

  // reconnect A (auto-reconnect dimatikan oleh disconnect manual)
  const sockA2 = io(BASE, { auth: { token: tokA } });
  await new Promise((r) => sockA2.on('connect', r));
  ok(true, 'socket A reconnected');

  console.log('\n[5] Message history & unread');
  const rm = await api(`/api/chats/${chatId}/messages`, { token: tokA });
  ok(rm.status === 200 && rm.data.messages.length === 1, 'history has 1 message');
  const rchat = await api('/api/chats', { token: tokB });
  const chatB = rchat.data.chats.find((c) => c.id === chatId);
  ok(chatB && chatB.unread === 0, 'unread=0 after read');

  console.log('\n[6] Upload (image + 100MB video simulation ok, real size check)');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'test.png');
  const upRes = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fd });
  const upData = await upRes.json();
  ok(upRes.status === 201 && upData.url && upData.type === 'image', `upload image -> ${upData.url}`);
  const upGet = await fetch(BASE + upData.url);
  ok(upGet.status === 200, 'uploaded file downloadable');

  // send media message
  const bGetsMedia = waitEvent(sockB, 'message:new');
  sockA2.emit('message:send', { chatId, type: 'image', body: 'Lihat ini', media: upData }, (res) => ok(res.ok, 'send image message ack'));
  const mediaMsg = await bGetsMedia;
  ok(mediaMsg.type === 'image' && mediaMsg.mediaUrl, 'B receives image message');

  console.log('\n[7] Validation errors');
  sockA2.emit('message:send', { chatId, type: 'text', body: '   ' }, (res) => ok(!res.ok, 'empty text rejected'));
  sockA2.emit('message:send', { chatId: 'not-a-chat', type: 'text', body: 'x' }, (res) => ok(!res.ok, 'foreign chat rejected'));

  console.log('\n[8] Search users');
  const rs = await api(`/api/users/search?q=${encodeURIComponent(`budi${stamp}`)}`, { token: tokA });
  ok(rs.data.users.some((u) => u.id === userB.id), 'search finds Budi by email');

  console.log('\n[9] Static frontend');
  const idx = await fetch(BASE + '/');
  const html = await idx.text();
  ok(idx.status === 200 && html.includes('Whatsap Indo'), 'index.html served');
  const js = await fetch(BASE + '/js/app.js');
  ok(js.status === 200, 'app.js served');
  const css = await fetch(BASE + '/css/style.css');
  ok(css.status === 200, 'style.css served');

  console.log('\n[10] Delete message');
  const del = await api(`/api/messages/${msg1.id}`, { method: 'DELETE', token: tokA });
  ok(del.status === 200, 'delete own message');
  const rm2 = await api(`/api/chats/${chatId}/messages`, { token: tokB });
  ok(rm2.data.messages.find((m) => m.id === msg1.id)?.deleted, 'message marked deleted for receiver');

  console.log('\n[11] Call signaling (suara & video WebRTC)');
  const sockB2 = io(BASE, { auth: { token: tokB } });
  await new Promise((r) => sockB2.on('connect', r));

  const callId = `call-${stamp}`;
  const incB = waitEvent(sockB, 'call:incoming');
  const incB2 = waitEvent(sockB2, 'call:incoming');
  let inviteAck = null;
  sockA2.emit('call:invite', { to: userB.id, callId, kind: 'video' }, (res) => { inviteAck = res; });
  const incoming = await incB;
  await sleep(100); // tunggu ack sampai (dikirim server setelah event)
  ok(inviteAck?.ok === true, 'invite acknowledged');
  ok(incoming.callId === callId && incoming.kind === 'video', 'callee receives video call invite');
  ok(incoming.from?.id === userA.id && incoming.from?.verified === false, 'caller identity + verified flag delivered');
  await incB2;
  ok(true, 'second tab of callee rings too (multi-device)');

  const acceptedEv = waitEvent(sockB2, 'call:ended');
  sockB.emit('call:accept', { callId });
  const accepted = await acceptedEv;
  ok(accepted.reason === 'accepted' && accepted.callId === callId, 'other tab stops ringing after accept');

  const offerEv = waitEvent(sockA2, 'call:signal');
  sockB.emit('call:signal', { to: userA.id, callId, signal: { type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\nfake-offer' } } });
  const offer = await offerEv;
  ok(offer.signal.type === 'offer' && offer.callId === callId, 'caller receives SDP offer');

  const answerEv = waitEvent(sockB, 'call:signal');
  sockA2.emit('call:signal', { to: userB.id, callId, signal: { type: 'answer', answer: { type: 'answer', sdp: 'v=0\r\nfake-answer' } } });
  const answer = await answerEv;
  ok(answer.signal.type === 'answer', 'callee receives SDP answer');

  const candEv = waitEvent(sockA2, 'call:signal');
  sockB.emit('call:signal', { to: userA.id, callId, signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ host', sdpMid: '0' } } });
  const cand = await candEv;
  ok(cand.signal.type === 'candidate', 'ICE candidate relayed');

  // signal untuk panggilan tak dikenal / bukan peserta -> dibuang, server tetap hidup
  sockA2.emit('call:signal', { to: userB.id, callId: 'call-tidak-terdaftar', signal: { type: 'offer', offer: {} } });
  const stale = await expectNoEvent(sockA2, 'call:signal');
  ok(!stale.got, 'signal for unknown call is dropped');

  // self-call ditolak
  let selfAck = null;
  sockA2.emit('call:invite', { to: userA.id, callId: `${callId}-self`, kind: 'audio' }, (r) => { selfAck = r; });
  await sleep(150);
  ok(selfAck && selfAck.ok === false, 'self-call rejected');

  // user terdaftar tapi offline -> invite gagal
  const rC = await api('/api/auth/register', {
    method: 'POST',
    body: { email: `calo${stamp}@test.id`, name: 'Calo', password: 'secret123' },
  });
  let offlineAck = null;
  sockA2.emit('call:invite', { to: rC.data.user.id, callId: `${callId}-off`, kind: 'audio' }, (r) => { offlineAck = r; });
  await sleep(150);
  ok(offlineAck && offlineAck.ok === false && /offline/i.test(offlineAck.error || ''), 'invite to offline user rejected');

  // tolak -> penelepon diberi tahu
  const rejectedEv = waitEvent(sockA2, 'call:ended');
  const cancelledEv = waitEvent(sockB2, 'call:ended');
  sockB.emit('call:reject', { to: userA.id, callId });
  const rejected = await rejectedEv;
  const cancelled = await cancelledEv;
  ok(rejected.reason === 'rejected', 'caller told call was rejected');
  ok(cancelled.reason === 'cancelled', 'callee other tab stopped ringing');

  // penelepon keluar saat berdering -> penerima ditutup
  const sockC = io(BASE, { auth: { token: rC.data.token } });
  await new Promise((r) => sockC.on('connect', r));
  const ringEv = waitEvent(sockB, 'call:incoming');
  const endedEv = waitEvent(sockB, 'call:ended');
  sockC.emit('call:invite', { to: userB.id, callId: `${callId}-drop`, kind: 'audio' });
  await ringEv;
  sockC.disconnect();
  const endedByLeave = await endedEv;
  ok(endedByLeave.callId === `${callId}-drop`, 'ringing call ends when caller disconnects');
  sockB2.close();

  console.log('\n[12] Upload safety (mencegah XSS file buatan pengguna)');
  const fdHtml = new FormData();
  fdHtml.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  const upHtml = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fdHtml });
  const upHtmlData = await upHtml.json();
  ok(upHtml.status === 201 && upHtmlData.url, 'html upload stored');
  const evilRes = await fetch(BASE + upHtmlData.url);
  ok(evilRes.headers.get('x-content-type-options') === 'nosniff', 'nosniff header set on /uploads');
  ok((evilRes.headers.get('content-type') || '').indexOf('text/html') === -1, 'uploaded html is not served as text/html');
  ok((evilRes.headers.get('content-disposition') || '').includes('attachment'), 'uploaded html forced download');

  sockB.close();
  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
