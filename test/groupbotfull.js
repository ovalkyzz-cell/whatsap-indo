'use strict';
/* Bot di grup FUNGSI TOTAL — cakupan yang belum diuji test groupbot lama:
   1. balasan bot diterima SEMUA anggota (pengirim, premium lain, non-premium)
   2. anggota PREMIUM BUKAN ADMIN bisa memanggil bot
   3. sebutan huruf kecil (case-insensitive) & @bot generik tetap memicu
   4. pesan non-teks (balasan ke bot) -> peringatan terkirim ke semua anggota
   5. indikator mengetik terlihat semua anggota; kartu bot tersedia utk semua
   Jalankan dengan server aktif: npm run test:groupbotfull */
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra || ''); }
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
  return { status: res.status, data: await res.json().catch(() => ({})) };
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
  return { status: 201, data: { ...lg.data, pending: false } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function collect(sock, event) {
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
        if (found) return resolve(found);
        if (Date.now() - start >= ms) return resolve(null);
        setTimeout(tick, 60);
      };
      tick();
    }),
  };
}
function emitAck(sock, event, payload) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 10000);
    sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

const BOT = 'bot-verif-am';
const BOT_NAME = 'Verif AM Prem';

(async () => {
  const stamp = Date.now();
  console.log('\n[1] Siapkan grup: admin + non-premium + premium non-admin');
  await admLogin();

  const free = await signup({ email: `gbfree-${stamp}@test.local`, name: 'Free User', password: 'password123' });
  const prem = await signup({ email: `gbprem-${stamp}@test.local`, name: 'Premium User', password: 'password123' });
  ok(free.status === 201 && prem.status === 201, 'dua anggota dibuat');
  const tokFree = free.data.token, idFree = free.data.user.id;
  const tokPrem = prem.data.token, idPrem = prem.data.user.id, emPrem = prem.data.user.email;

  const grant = await admApi('/api/admin/premium', {
    method: 'POST', body: { email: emPrem, plan: 'bulanan' },
  });
  ok(grant.status === 200 && grant.data.user.premiumActive === true, 'anggota kedua diberi premium bulanan');

  // pembuat grup = anggota FRESH tiap run — kuota "5 grup/jam" milik admin tidak
  // terkuras regresi berulang; admin situs tetap memasang bot (admin grup otomatis)
  const rg = await api('/api/chats/group', {
    method: 'POST', token: tokFree,
    body: { name: `Grup Fungsi Total ${stamp}`, memberIds: [admId, idPrem] },
  });
  ok(rg.status === 201, 'grup dibuat berisi ketiga peran');
  const gid = rg.data.chat.id;

  const addBot = await admApi(`/api/chats/${gid}/members`, { method: 'POST', body: { userId: BOT } });
  ok(addBot.status === 201, 'bot dipasang');

  const chatsFree = await api('/api/chats', { token: tokFree });
  const chatsPrem = await api('/api/chats', { token: tokPrem });
  const gFree = (chatsFree.data.chats || []).find((c) => c.id === gid);
  const gPrem = (chatsPrem.data.chats || []).find((c) => c.id === gid);
  ok(gFree && gFree.bot && gFree.bot.id === BOT, 'kartu bot tersedia di daftar chat anggota non-premium');
  ok(gPrem && gPrem.bot && gPrem.bot.id === BOT, 'kartu bot tersedia di daftar chat anggota premium');

  const sAdm = io(BASE, { auth: { token: admToken } });
  const sFree = io(BASE, { auth: { token: tokFree } });
  const sPrem = io(BASE, { auth: { token: tokPrem } });
  await Promise.all([sAdm, sFree, sPrem].map((s) => new Promise((r) => s.on('connect', r))));
  ok(true, 'tiga socket terhubung');

  const fAdm = collect(sAdm, 'message:new');
  const fFree = collect(sFree, 'message:new');
  const fPrem = collect(sPrem, 'message:new');
  const tAdm = collect(sAdm, 'typing');
  const tFree = collect(sFree, 'typing');
  const tPrem = collect(sPrem, 'typing');
  const isBot = (m) => m && m.senderId === BOT;

  console.log('\n[2] @bot generik: balasan bot diterima SEMUA anggota');
  const n0 = fAdm.seen.length;
  const a1 = await emitAck(sAdm, 'message:send', { chatId: gid, type: 'text', body: `@bot menu ${stamp}` });
  ok(a1 && a1.ok === true, 'pesan @bot generik diterima server');
  const rAdm = await fAdm.wait(isBot, 15000);
  ok(!!rAdm, 'admin (pengirim) menerima balasan bot');
  const rFree = await fFree.wait((m) => isBot(m) && m.id === (rAdm && rAdm.id), 8000);
  ok(!!rFree, 'ANGGOTA NON-PREMIUM (bukan pengirim) menerima balasan bot');
  const rPrem = await fPrem.wait((m) => isBot(m) && m.id === (rAdm && rAdm.id), 8000);
  ok(!!rPrem, 'ANGGOTA PREMIUM (bukan pengirim) menerima balasan bot');
  ok(rAdm && /VERIF AM PREM/i.test(rAdm.body || ''), 'isi balasan = menu bot');

  const typFree = await new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const found = tFree.seen.find((t) => t && t.userId === BOT && t.typing === true);
      if (found) return resolve(true);
      if (Date.now() - start >= 6000) return resolve(false);
      setTimeout(tick, 60);
    };
    tick();
  });
  ok(typFree, 'indikator mengetik bot terlihat anggota non-premium (bukan hanya pengirim)');

  console.log('\n[3] Premium NON-ADMIN bisa memanggil bot');
  const a2 = await emitAck(sPrem, 'message:send', { chatId: gid, type: 'text', body: `@${BOT_NAME} menu ${stamp}` });
  ok(a2 && a2.ok === true, 'pesan sebutan dari premium non-admin diterima');
  const r2 = await fPrem.wait((m) => isBot(m) && m.id !== (rAdm && rAdm.id), 15000);
  ok(!!r2, `bot membalas premium non-admin${r2 ? '' : ' (timeout)'}`);
  const r2Adm = r2 ? await fAdm.wait((m) => isBot(m) && m.id === r2.id, 8000) : null;
  ok(!!r2Adm, 'balasan utk premium non-admin juga sampai ke pengirim lain (admin)');

  console.log('\n[4] Sebutan huruf kecil (case-insensitive) tetap memicu');
  const a3 = await emitAck(sAdm, 'message:send', { chatId: gid, type: 'text', body: `@verif am prem menu ${stamp}` });
  ok(a3 && a3.ok === true, 'sebutan huruf kecil diterima');
  const r3 = await fAdm.wait((m) => isBot(m) && m.id !== (r2 && r2.id) && m.id !== (rAdm && rAdm.id), 15000);
  ok(!!r3, `bot membalas sebutan huruf kecil${r3 ? '' : ' (timeout)'}`);

  console.log('\n[5] Reply ke pesan bot tanpa sebutan (dari anggota premium)');
  const target = r3 || r2 || rAdm;
  const a4 = await emitAck(sPrem, 'message:send', {
    chatId: gid, type: 'text', body: `balas bot ${stamp}`, replyTo: target ? target.id : '',
  });
  ok(a4 && a4.ok === true, 'reply ke pesan bot diterima');
  const r4 = await fPrem.wait((m) => isBot(m) && ![rAdm && rAdm.id, r2 && r2.id, r3 && r3.id].includes(m.id), 15000);
  ok(!!r4, `bot merespons reply tanpa sebutan${r4 ? '' : ' (timeout)'}`);

  console.log('\n[6] Pemicu SAHAJA diam untuk semua');
  const c0 = fAdm.seen.length;
  await emitAck(sAdm, 'message:send', { chatId: gid, type: 'text', body: `percakapan biasa ${stamp}` });
  const a5 = await emitAck(sFree, 'message:send', { chatId: gid, type: 'text', body: `@${BOT_NAME} menu gratis ${stamp}` });
  ok(a5 && a5.ok === true, 'sebutan non-premium diterima sebagai pesan biasa');
  await sleep(3500);
  ok(fAdm.seen.slice(c0).filter(isBot).length === 0, 'bot diam utk pesan biasa & sebutan non-premium');

  console.log('\n[7] Pesan non-teks membalas bot -> peringatan sampai SEMUA anggota');
  const c1 = fAdm.seen.length;
  const a6 = await emitAck(sAdm, 'message:send', {
    chatId: gid, type: 'image', body: '',
    media: { url: `/uploads/uji-${stamp}.jpg`, name: 'uji.jpg', size: 1024 },
    replyTo: target ? target.id : '',
  });
  ok(a6 && a6.ok === true, 'pesan gambar (reply ke bot) diterima server');
  const wAdm = await fAdm.wait((m) => isBot(m) && /hanya memproses pesan teks/i.test(m.body || ''), 10000);
  const wFree = await fFree.wait((m) => isBot(m) && /hanya memproses pesan teks/i.test(m.body || ''), 8000);
  const wPrem = await fPrem.wait((m) => isBot(m) && /hanya memproses pesan teks/i.test(m.body || ''), 8000);
  ok(!!wAdm, 'pengirim menerima peringatan bot (pesan non-teks)');
  ok(!!wFree, 'anggota non-premium menerima peringatan bot');
  ok(!!wPrem, 'anggota premium menerima peringatan bot');
  ok(fAdm.seen.length >= c1, 'feed admin tercatat');

  console.log('\n[8] Balasan bot TERSIMPAN (anggota luring muat dari API)');
  const hist = await api(`/api/chats/${gid}/messages?limit=50`, { token: tokFree });
  const botMsgs = (hist.data.messages || []).filter(isBot);
  ok(botMsgs.length >= 4, `pesan bot tersimpan di riwayat (${botMsgs.length} pesan)`);
  const warn = botMsgs.find((m) => /hanya memproses pesan teks/i.test(m.body || ''));
  ok(!!warn, 'peringatan non-teks tersimpan di riwayat');

  [fAdm, fFree, fPrem, tAdm, tFree, tPrem].forEach((c) => c.stop());
  sAdm.close(); sFree.close(); sPrem.close();

  console.log(`\n==== HASIL: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(2);
});
