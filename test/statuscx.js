'use strict';
/* Fitur status: tag (mention pengguna), komentar status, balas komentar,
   akses non-kontak lewat tag, hak hapus, dan notifikasi realtime. */
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label, extra || ''); }
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

(async () => {
  const stamp = Date.now();
  await admLogin();
  const admMe = await admApi('/api/auth/me');
  const admId = admMe.data.user.id;

  const A = await signup({ email: `sx-author-${stamp}@test.local`, name: 'Penulis Status', password: 'password123' });
  ok(A.status === 201, 'akun penulis (A) dibuat');
  const B = await signup({ email: `sx-viewer-${stamp}@test.local`, name: 'Penonton', password: 'password123' });
  ok(B.status === 201, 'akun penonton (B) dibuat');
  const C = await signup({ email: `sx-tagged-${stamp}@test.local`, name: 'Orang Ditandai', password: 'password123' });
  ok(C.status === 201, 'akun orang ditandai (C) dibuat');
  const tokA = A.data.token, tokB = B.data.token, tokC = C.data.token;
  const idA = A.data.user.id, idB = B.data.user.id, idC = C.data.user.id;

  // A & B punya chat bersama (feed), C TIDAK — sengaja tanpa kontak A
  const rg = await api('/api/chats/group', {
    method: 'POST',
    token: tokA,
    body: { name: `Grup Status ${stamp}`, memberIds: [idB, admId] },
  });
  ok(rg.status < 300, 'grup A+B+admin dibuat (B jadi kontak A)', JSON.stringify(rg.data).slice(0, 120));

  const sA = io(BASE, { auth: { token: tokA } });
  const sB = io(BASE, { auth: { token: tokB } });
  const sC = io(BASE, { auth: { token: tokC } });
  await Promise.all([sA, sB, sC].map((s) => new Promise((r) => s.on('connect', r))));
  ok(true, 'socket A, B, C terhubung');
  const fATag = collect(sA, 'status:comment');
  const fBTag = collect(sB, 'status:tagged');
  const fBReply = collect(sB, 'status:comment');
  const fCTag = collect(sC, 'status:tagged');

  console.log('\n[1] Tag status (mention)');
  const st = await api('/api/status', {
    method: 'POST',
    token: tokA,
    body: { type: 'text', body: 'Status uji tag & komentar', tags: [idB, idC, 'no-such-user', idA] },
  });
  ok(st.status === 201, 'status dengan tag terbit (201)');
  const stId = st.data.status && st.data.status.id;
  ok(!!stId, 'id status dikembalikan');
  const tagsOut = [...(st.data.status?.tags || [])].sort();
  ok(tagsOut.length === 2 && tagsOut.includes(idB) && tagsOut.includes(idC),
    'hanya user valid & bukan diri sendiri yang ditandai', JSON.stringify(tagsOut));
  const evB = await fBTag.wait((p) => p && p.statusId === stId, 4000);
  const evC = await fCTag.wait((p) => p && p.statusId === stId, 4000);
  ok(!!evB, 'B menerima event status:tagged secara realtime');
  ok(!!evC, 'C (non-kontak) menerima event status:tagged secara realtime');
  ok(evB && evB.byName === 'Penulis Status', 'event menyertakan nama penanda', evB && evB.byName);

  console.log('\n[2] Feed: tag terlihat & status non-kontak masuk lewat tag');
  const feedB = await api('/api/status', { token: tokB });
  const rowB = (feedB.data.groups || []).flatMap((g) => g.statuses || []).find((s) => s.id === stId);
  ok(!!rowB, 'B melihat status A di feed');
  ok(rowB && rowB.taggedMe === true, 'row B bertanda taggedMe=true');
  ok(rowB && (rowB.tags || []).includes(idB), 'tags B tampil di feed B');
  ok(rowB && rowB.commentCount === 0, 'commentCount awal 0');
  const feedC = await api('/api/status', { token: tokC });
  const rowC = (feedC.data.groups || []).flatMap((g) => g.statuses || []).find((s) => s.id === stId);
  ok(!!rowC, 'C NON-KONTAK tetap melihat status yang menandainya');
  ok(rowC && rowC.taggedMe === true, 'row C bertanda taggedMe=true');

  console.log('\n[3] Komentar status');
  const cm1 = await api(`/api/status/${stId}/comments`, { method: 'POST', token: tokB, body: { body: 'Mantap statusnya!' } });
  ok(cm1.status === 201, 'B mengirim komentar (201)');
  const cm1Id = cm1.data.comment && cm1.data.comment.id;
  ok(!!cm1Id && cm1.data.comment.mine === true, 'komentar tersimpan & mine=true');
  const evA = await fATag.wait((p) => p && p.comment && p.comment.id === cm1Id, 4000);
  ok(!!evA, 'A (pemilik status) menerima event status:comment realtime');
  ok(evA && evA.comment.body === 'Mantap statusnya!', 'body komentar terkirim utuh', evA && evA.comment.body);

  const ownerBad = await api(`/api/status/${stId}/comments`, { method: 'POST', token: tokA, body: { body: 'owner berkomentar' } });
  ok(ownerBad.status === 400, 'pemilik status ditolak berkomentar tanpa balasan (400)');

  const listA = await api(`/api/status/${stId}/comments`, { token: tokA });
  ok(listA.status === 200 && (listA.data.comments || []).length === 1, 'A memuat daftar komentar (1)');
  const listC = await api(`/api/status/${stId}/comments`, { token: tokC });
  ok(listC.status === 200 && (listC.data.comments || []).length === 1, 'C (non-kontak, ditandai) tetap bisa memuat komentar');

  console.log('\n[4] Balas komentar');
  const cm2 = await api(`/api/status/${stId}/comments`, {
    method: 'POST',
    token: tokA,
    body: { body: 'Terima kasih!', replyTo: cm1Id },
  });
  ok(cm2.status === 201, 'A membalas komentar B (201)');
  ok(cm2.data.comment && cm2.data.comment.replyTo === cm1Id, 'replyTo tersimpan');
  ok(cm2.data.comment && cm2.data.comment.replyToBody === 'Mantap statusnya!', 'preview kutipan balasan ikut terkirim',
    cm2.data.comment && cm2.data.comment.replyToBody);
  const evBRep = await fBReply.wait((p) => p && p.comment && p.comment.id === cm2.data.comment.id, 4000);
  ok(!!evBRep, 'B menerima balasan A secara realtime');
  ok(evBRep && evBRep.isReply === true, 'event balasan ditandai isReply=true');

  const cm3 = await api(`/api/status/${stId}/comments`, { method: 'POST', token: tokC, body: { body: 'Dari yang ditandai' } });
  ok(cm3.status === 201, 'C (non-kontak yang ditandai) ikut berkomentar (201)');

  const badReply = await api(`/api/status/${stId}/comments`, { method: 'POST', token: tokB, body: { body: 'x', replyTo: 'no-such-cmt' } });
  ok(badReply.status === 400, 'replyTo fiktif ditolak 400');

  console.log('\n[5] Jumlah & feed komentar');
  const feedA2 = await api('/api/status', { token: tokA });
  const mineRow = (feedA2.data.groups || []).flatMap((g) => g.statuses || []).find((s) => s.id === stId);
  ok(mineRow && mineRow.commentCount === 3, 'commentCount status saya = 3', mineRow && mineRow.commentCount);
  const listB2 = await api(`/api/status/${stId}/comments`, { token: tokB });
  ok((listB2.data.comments || []).length === 3, 'daftar komentar utuh 3');

  console.log('\n[6] Hak hapus komentar');
  const delForbidden = await api(`/api/status/${stId}/comments/${cm1Id}`, { method: 'DELETE', token: tokC });
  ok(delForbidden.status === 403, 'C tidak bisa menghapus komentar orang lain (403)');
  const delOwner = await api(`/api/status/${stId}/comments/${cm3.data.comment.id}`, { method: 'DELETE', token: tokA });
  ok(delOwner.status === 200, 'pemilik status menghapus komentar C (200)');
  const listB3 = await api(`/api/status/${stId}/comments`, { token: tokB });
  ok((listB3.data.comments || []).length === 2, 'sisa komentar setelah dihapus = 2');
  const delMine = await api(`/api/status/${stId}/comments/${cm1Id}`, { method: 'DELETE', token: tokB });
  ok(delMine.status === 200, 'B menghapus komentarnya sendiri (200)');
  const listB4 = await api(`/api/status/${stId}/comments`, { token: tokB });
  ok((listB4.data.comments || []).length === 1,
    'balasan A TETAP bertahan walau induknya dihapus (reply_to SET NULL)',
    JSON.stringify((listB4.data.comments || []).map((c) => ({ id: c.id, replyTo: c.replyTo }))));

  fATag.stop(); fBTag.stop(); fBReply.stop(); fCTag.stop();
  sA.close(); sB.close(); sC.close();

  console.log(`\n==== HASIL STATUS-FEAT: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('  ERROR:', e && e.stack || e);
  process.exit(2);
});
