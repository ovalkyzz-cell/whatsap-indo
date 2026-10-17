'use strict';
/* Site admin (role=admin, bukan admin grup) di grup milik pengguna lain:
   akses tanpa kendala — pasang/keluarkan bot, kelola grup, chat bot real-time.
   Anggota biasa tetap ditolak (pastikan hak istimewa admin tidak bocor ke semua). */
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

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

const ADMIN_EMAIL = 'ovalkyzz@gmail.com';
const ADMIN_PASSWORD = 'secret123';
let admToken = null;

async function admLogin() {
  let r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Admin Utama', password: ADMIN_PASSWORD },
  });
  if (r.status !== 201) {
    r = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  }
  if (!r.data || !r.data.token) throw new Error(`admin gagal: ${r.status}`);
  admToken = r.data.token;
  return admToken;
}

async function admApi(path, opts = {}) {
  if (!admToken) await admLogin();
  let r = await api(path, { ...opts, token: admToken });
  if (r.status === 401) { await admLogin(); r = await api(path, { ...opts, token: admToken }); }
  return r;
}

async function signup({ email, name, password }) {
  const r = await api('/api/auth/register', { method: 'POST', body: { email, name, password } });
  if (r.status !== 201) return r;
  if (!r.data.pending) return r;
  const ap = await admApi(`/api/admin/users/${encodeURIComponent(r.data.user.id)}/approve`, { method: 'POST', body: {} });
  if (ap.status !== 200) return { status: 500, data: { error: 'approve gagal' } };
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (lg.status !== 200) return { status: 500, data: { error: 'login gagal' } };
  return { status: 201, data: { ...lg.data, pending: false } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emitAck = (sock, event, payload) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 5000);
  sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
});

(async () => {
  const stamp = Date.now();
  await admLogin();
  const admMe = await admApi('/api/auth/me');
  const admId = admMe.data.user.id;
  console.log('site admin id =', admId, 'role =', admMe.data.user.role);

  const owner = await signup({ email: `owner-${stamp}@test.local`, name: 'Pemilik Grup', password: 'password123' });
  ok(owner.status === 201, 'akun pemilik grup dibuat');
  const tokOwner = owner.data.token;
  const idOwner = owner.data.user.id;

  const plain = await signup({ email: `plain-${stamp}@test.local`, name: 'Anggota Biasa', password: 'password123' });
  ok(plain.status === 201, 'akun anggota biasa dibuat');
  const tokPlain = plain.data.token;
  const idPlain = plain.data.user.id;

  console.log('\n[1] Grup dibuat pengguna BIASA (bukan admin site) berisi site admin');
  const rg = await api('/api/chats/group', {
    method: 'POST',
    token: tokOwner,
    body: { name: `Grup Milik Member ${stamp}`, memberIds: [admId, idPlain] },
  });
  ok(rg.status === 201, `member membuat grup berisi site admin (${rg.status})`);
  const gid = rg.data.chat && rg.data.chat.id;
  ok(rg.data.chat && rg.data.chat.role === 'admin', 'pemilik = admin grup');

  const myChats = await admApi('/api/chats');
  const myChat = (myChats.data.chats || []).find((c) => c.id === gid);
  ok(!!myChat, 'site admin melihat grup tersebut di daftar chat');
  ok(myChat && myChat.role === 'member', `role site admin di grup = "${myChat && myChat.role}" (bukan admin grup)`);

  console.log('\n[2] Site admin memasang bot ke grup milik member lain');
  const addBot = await admApi(`/api/chats/${gid}/members`, { method: 'POST', body: { userId: 'bot-verif-am' } });
  ok(addBot.status === 201, `site admin PASANG bot (${addBot.status})${addBot.data.error ? ' — ' + addBot.data.error : ''}`);

  console.log('\n[3] Site admin chat bot di grup -> balasan REAL-TIME');
  const sock = io(BASE, { auth: { token: admToken } });
  await new Promise((r) => sock.on('connect', r));
  const seen = [];
  sock.on('message:new', (m) => seen.push({ m, at: Date.now() }));
  const typing = [];
  sock.on('typing', (t) => typing.push(t));

  const t0 = Date.now();
  const ack = await emitAck(sock, 'message:send', { chatId: gid, type: 'text', body: '@Verif AM Prem menu' });
  ok(ack && ack.ok === true, `pesan mention site admin diterima server (${ack && ack.ok ? 'ok' : JSON.stringify(ack)})`);
  const botMsg = await new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const found = seen.find((x) => x.m && x.m.senderId === 'bot-verif-am');
      if (found) return resolve({ ...found, at: found.at - t0 });
      if (Date.now() - start > 15000) return resolve(null);
      setTimeout(tick, 60);
    };
    tick();
  });
  ok(!!botMsg, `bot MEMBALAS site admin di grup (latensi ${botMsg ? botMsg.at : '-'} ms)`);
  if (botMsg) ok(/VERIF AM PREM/.test(botMsg.m.body || ''), 'isi balasan = menu bot');
  ok(typing.some((t) => t.userId === 'bot-verif-am' && t.typing === true), 'indikator mengetik bot terkirim real-time');
  ok(seen.some((x) => x.m && x.m.senderId === 'bot-verif-am'), 'event message:new bot diterima real-time');

  console.log('\n[4] Site admin KELUARKAN bot dari grup member lain');
  const kick = await admApi(`/api/chats/${gid}/members/bot-verif-am`, { method: 'DELETE' });
  ok(kick.status === 200, `site admin KELUARKAN bot (${kick.status})${kick.data.error ? ' — ' + kick.data.error : ''}`);

  console.log('\n[5] Site admin kelola grup (rename) milik member lain');
  const ren = await admApi(`/api/chats/${gid}`, { method: 'PATCH', body: { name: `Grup Direname Admin ${stamp}` } });
  ok(ren.status === 200, `site admin rename grup (${ren.status})${ren.data.error ? ' — ' + ren.data.error : ''}`);

  console.log('\n[6] Site admin buat link undangan grup member lain');
  const inv = await admApi(`/api/chats/${gid}/invite`, { method: 'POST', body: {} });
  ok(inv.status === 200 || inv.status === 201, `site admin buat link undangan (${inv.status})${inv.data.error ? ' — ' + inv.data.error : ''}`);

  console.log('\n[7] Anggota biasa TETAP ditolak (hak admin tidak bocor)');
  const plainAdd = await api(`/api/chats/${gid}/members`, {
    method: 'POST', token: tokPlain, body: { userId: 'bot-ai' },
  });
  ok(plainAdd.status === 403, `anggota biasa pasang bot ditolak 403 (${plainAdd.status})`);
  const plainRen = await api(`/api/chats/${gid}`, { method: 'PATCH', token: tokPlain, body: { name: 'Hacked' } });
  ok(plainRen.status === 403, `anggota biasa rename grup ditolak 403 (${plainRen.status})`);
  const plainKick = await api(`/api/chats/${gid}/members/${idOwner}`, { method: 'DELETE', token: tokPlain });
  ok(plainKick.status === 403, `anggota biasa keluarkan orang ditolak 403 (${plainKick.status})`);

  console.log('\n[8] Pesan site admin di grup sampai ke anggota lain (real-time)');
  const sockPlain = io(BASE, { auth: { token: tokPlain } });
  await new Promise((r) => sockPlain.on('connect', r));
  const got = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 6000);
    sockPlain.once('message:new', (m) => { clearTimeout(t); resolve(m); });
    emitAck(sock, 'message:send', { chatId: gid, type: 'text', body: 'halo anggota' });
  });
  ok(!!got && got.body === 'halo anggota', 'pesan site admin diterima anggota lain real-time');
  sockPlain.close();

  sock.close();
  console.log(`\n==== HASIL: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(2);
});
