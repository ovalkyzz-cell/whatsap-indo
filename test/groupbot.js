'use strict';
/* Uji bot di grup: pasang/keluarkan, balas real-time saat disebut / dibalas,
   diam untuk anggota non-premium & pesan biasa, indikator mengetik + centang. */
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
let admId = null;

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
  admId = r.data.user && r.data.user.id;
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
  if (ap.status !== 200) return { status: 500, data: { error: `approve gagal: ${JSON.stringify(ap.data)}` } };
  const lg = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (lg.status !== 200) return { status: 500, data: { error: `login gagal: ${JSON.stringify(lg.data)}` } };
  return { status: 201, data: { ...lg.data, pending: false } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEvent = (sock, event, timeout = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
  sock.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

function collect(sock, event, timeout = 5000) {
  const seen = [];
  const h = (p) => seen.push(p);
  sock.on(event, h);
  return {
    seen,
    stop: () => sock.off(event, h),
    wait: (pred, ms) => new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const found = seen.find(pred);
        if (found) return resolve({ found, at: Date.now() });
        if (Date.now() - start >= ms) return resolve(null);
        setTimeout(tick, 60);
      };
      tick();
    }),
  };
}

function emitAck(sock, event, payload) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

const isBotMsg = (botId) => (m) => m && m.senderId === botId;

(async () => {
  const stamp = Date.now();
  console.log('\n[1] Siapkan admin, anggota non-premium & bot grup');
  await admLogin();

  const free = await signup({ email: `free-${stamp}@test.local`, name: 'Free User', password: 'password123' });
  ok(free.status === 201 && !!free.data.token, 'akun non-premium dibuat & disetujui');
  const tokFree = free.data.token;
  const idFree = free.data.user.id;

  // bot lokal tanpa API: bot-verif-am menjawab menu secara lokal
  const BOT = 'bot-verif-am';

  // pembuat grup = anggota FRESH tiap run: kuota "maks 5 grup/jam" milik admin
  // tidak terkuras oleh regresi berulang (admin situs tetap kelola bot sbg admin grup)
  const rg = await api('/api/chats/group', {
    method: 'POST',
    token: tokFree,
    body: { name: `Grup Uji Bot ${stamp}`, memberIds: [admId] },
  });
  ok(rg.status === 201 && rg.data.chat?.type === 'group', 'anggota membuat grup berisi admin site');
  const gid = rg.data.chat.id;

  const addBot = await admApi(`/api/chats/${gid}/members`, { method: 'POST', body: { userId: BOT } });
  ok(addBot.status === 201, 'admin memasang bot ke grup (real-time terpasang)');
  const addBot2 = await admApi(`/api/chats/${gid}/members`, { method: 'POST', body: { userId: 'bot-ai' } });
  ok(addBot2.status === 400 && /sudah memiliki bot/i.test(addBot2.data.error || ''),
    'grup menolak bot kedua (maks 1 bot)');

  const chats = await admApi('/api/chats');
  const gChat = (chats.data.chats || []).find((c) => c.id === gid);
  ok(gChat && gChat.bot && gChat.bot.id === BOT, 'daftar chat memuat kartu bot grup');

  const sockAdm = io(BASE, { auth: { token: admToken } });
  await new Promise((r) => sockAdm.on('connect', r));
  const sockFree = io(BASE, { auth: { token: tokFree } });
  await new Promise((r) => sockFree.on('connect', r));
  ok(true, 'dua socket terhubung real-time (admin + non-premium)');

  const admFeed = collect(sockAdm, 'message:new');
  const admTyping = collect(sockAdm, 'typing');
  const admStatus = collect(sockAdm, 'message:status');

  console.log('\n[2] Bot DIAM untuk pesan biasa & sebutan non-premium');
  const ack1 = await emitAck(sockFree, 'message:send', { chatId: gid, type: 'text', body: 'halo semua' });
  ok(ack1 && ack1.ok === true, 'anggota non-premium mengirim pesan biasa diterima');
  await sleep(3500);
  ok(!admFeed.seen.some(isBotMsg(BOT)), 'bot diam saat pesan biasa (tanpa sebutan)');

  const ack2 = await emitAck(sockFree, 'message:send', { chatId: gid, type: 'text', body: `@Verif AM Prem menu` });
  ok(ack2 && ack2.ok === true, 'sebutan bot dari non-premium diterima sebagai pesan');
  await sleep(3500);
  ok(!admFeed.seen.some(isBotMsg(BOT)), 'bot TIDAK merespons sebutan anggota non-premium');

  console.log('\n[3] Bot balas REAL-TIME saat admin menyebut');
  admFeed.stop(); admTyping.stop(); admStatus.stop();
  const fFeed = collect(sockAdm, 'message:new');
  const fTyping = collect(sockAdm, 'typing');
  const fStatus = collect(sockAdm, 'message:status');

  const t0 = Date.now();
  const ack3 = await emitAck(sockAdm, 'message:send', { chatId: gid, type: 'text', body: '@Verif AM Prem menu' });
  ok(ack3 && ack3.ok === true, 'pesan sebutan admin diterima server');
  const reply1 = await fFeed.wait(isBotMsg(BOT), 15000);
  ok(!!reply1, `bot membalas sebutan admin (latensi ${reply1 ? reply1.at - t0 : '-'} ms)`);
  if (reply1) {
    ok(/VERIF AM PREM/.test(reply1.found.body || ''), 'isi balasan = menu bot profesional');
    ok(reply1.at - t0 < 8000, `balasan real-time (< 8 detik, aktual ${reply1.at - t0} ms)`);
  }
  const typingSeen = fTyping.seen.some((t) => t && t.userId === BOT && t.typing === true);
  ok(typingSeen, 'indikator mengetik bot terkirim real-time');
  const readSeen = fStatus.seen.some((s) => s && s.status === 'read');
  ok(readSeen, 'centang biru (read) dari bot diterima pengirim');

  console.log('\n[4] Bot merespons pesan yang MEMBALAS pesan bot (tanpa sebutan)');
  const botMsg = reply1 && reply1.found;
  if (botMsg) {
    const ack4 = await emitAck(sockAdm, 'message:send', {
      chatId: gid, type: 'text', body: 'menu', replyTo: botMsg.id,
    });
    ok(ack4 && ack4.ok === true, 'balasan ke pesan bot diterima');
    const reply2 = await fFeed.wait((m) => isBotMsg(BOT)(m) && m.id !== botMsg.id, 15000);
    ok(!!reply2, `bot merespons reply tanpa sebutan${reply2 ? '' : ' (timeout)'}`);
  } else {
    ok(false, 'lanjut [4] gagal: pesan bot pertama tidak ada');
  }

  console.log('\n[5] Bot tetap diam saat admin kirim pesan biasa tanpa sebut');
  const before = fFeed.seen.length;
  const ack5 = await emitAck(sockAdm, 'message:send', { chatId: gid, type: 'text', body: 'ini pesan biasa admin' });
  ok(ack5 && ack5.ok === true, 'pesan biasa admin diterima');
  await sleep(3500);
  const newBotMsgs = fFeed.seen.slice(before).filter(isBotMsg(BOT));
  ok(newBotMsgs.length === 0, 'bot tidak membalas pesan tanpa sebutan / reply');

  console.log('\n[6] Non-premium yang MEMBALAS pesan bot juga tetap diam');
  const ack6 = await emitAck(sockFree, 'message:send', {
    chatId: gid, type: 'text', body: 'coba balas bot', replyTo: botMsg ? botMsg.id : '',
  });
  ok(ack6 && ack6.ok === true, 'reply non-premium ke pesan bot diterima sebagai pesan');
  await sleep(3500);
  ok(!fFeed.seen.slice(before).filter(isBotMsg(BOT)).some((m) => m.senderId === BOT),
    'bot diam untuk reply anggota non-premium');

  console.log('\n[7] Keluarkan bot -> grup bersih, sebutan tak lagi berpengaruh');
  const kick = await admApi(`/api/chats/${gid}/members/${BOT}`, { method: 'DELETE' });
  ok(kick.status === 200, 'admin mengeluarkan bot dari grup');
  const mem = await admApi(`/api/chats/${gid}/members`);
  ok(!mem.data.members.some((m) => m.isBot), 'bot hilang dari anggota grup');
  const before2 = fFeed.seen.length;
  await emitAck(sockAdm, 'message:send', { chatId: gid, type: 'text', body: '@Verif AM Prem menu' });
  await sleep(3500);
  ok(fFeed.seen.slice(before2).filter(isBotMsg(BOT)).length === 0,
    'setelah dikeluarkan, sebutan tidak memicu balasan');

  console.log('\n[8] Pasang ulang bot -> merespons lagi (restart pemasangan)');
  const readd = await admApi(`/api/chats/${gid}/members`, { method: 'POST', body: { userId: BOT } });
  ok(readd.status === 201, 'bot dipasang ulang ke grup');
  const reFeed = collect(sockAdm, 'message:new');
  await emitAck(sockAdm, 'message:send', { chatId: gid, type: 'text', body: `@Verif AM Prem menu uji ${stamp}` });
  const reReply = await reFeed.wait((m) => isBotMsg(BOT)(m), 15000);
  ok(!!reReply, `bot aktif kembali setelah dipasang ulang${reReply ? '' : ' (timeout)'}`);
  reFeed.stop();

  admFeed.stop(); fFeed.stop(); fTyping.stop(); fStatus.stop();
  sockAdm.close(); sockFree.close();

  console.log(`\n==== HASIL: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(2);
});
