'use strict';
/* Unit test mesin panggilan: masa dering, terima/tutup, riwayat & pembersihan.
   Tanpa server — langsung ke lapisan database (SQLite WAL boleh dibuka
   berbarengan dengan server yang sedang jalan). */
const db = require('../server/db');
const calls = require('../server/calls');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (n) => `unit-user-${n}-${Date.now()}`;

async function main() {
  await db.ready();

  console.log('\n[C1] Masa dering & pembuatan panggilan');
  ok(calls.ringMs() >= 3000, 'masa dering minimal 3 detik (dapat diatur lewat CALL_RING_MS)');
  const id1 = `unit-call-${Date.now()}`;
  const a = uid('a'), b = uid('b');
  await calls.create({ id: id1, callerId: a, calleeId: b, kind: 'video' });
  const row = await calls.get(id1);
  ok(!!row && row.state === 'ringing', 'panggilan baru berstatus ringing');
  ok(row.kind === 'video', 'jenis panggilan video tersimpan');

  console.log('\n[C2] Kirim-ulang dering & riwayat');
  const pending = await calls.pendingIncoming(b);
  ok(pending.some((c) => c.id === id1), 'penerima daring kembali menerima dering yang sama');
  const pendingOther = await calls.pendingIncoming(uid('c'));
  ok(!pendingOther.some((c) => c.id === id1), 'pengguna lain tidak menerima dering milik orang lain');
  const recent = await calls.listRecent(a, 10);
  ok(recent.some((c) => c.id === id1), 'panggilan muncul di riwayat pemanggil');
  const recentB = await calls.listRecent(b, 10);
  ok(recentB.some((c) => c.id === id1), 'panggilan muncul di riwayat penerima');

  console.log('\n[C3] Diterima lalu ditutup');
  ok(await calls.accept(id1) === true, 'penerima menekan jawab -> accepted');
  const afterAccept = await calls.get(id1);
  ok(afterAccept.state === 'accepted' && Number(afterAccept.answered_at) > 0, 'waktu dijawab tercatat');
  ok(await calls.accept(id1) === false, 'menjawab dua kali ditolak (tidak ganda)');
  ok(await calls.finish(id1, 'ended') === true, 'menutup panggilan aktif berhasil');
  ok(await calls.finish(id1, 'ended') === false, 'penutupan kedua ditolak -> notifikasi tidak dobel');
  ok((await calls.get(id1)).state === 'ended', 'status akhir ended');

  console.log('\n[C4] Masa dering habis -> tak terjawab');
  const id2 = `unit-call-missed-${Date.now()}`;
  const eId = uid('e');
  await calls.create({ id: id2, callerId: uid('d'), calleeId: eId, kind: 'audio' });
  await db.run('UPDATE calls SET created_at = ? WHERE id = ?', Date.now() - calls.ringMs() - 5000, id2);
  const expired = await calls.expireRinging();
  const hit2 = expired.find((c) => c.id === id2);
  ok(!!hit2 && hit2.state === 'missed', 'dering lewat batas waktu ditandai missed');
  ok(!(await calls.expireRinging()).some((c) => c.id === id2), 'penandaan tak terjawab tidak berulang');
  ok((await calls.get(id2)).state === 'missed', 'baris tetap ada sebagai riwayat (tidak dihapus)');

  console.log('\n[C5] Riwayat panggilan tak terjawab');
  const missed = await calls.missedFor(eId, 0);
  ok(missed.some((c) => c.id === id2), 'penerima menemukan panggilan tak terjawabnya');
  const missedOther = await calls.missedFor(uid('f'), Date.now() - 60_000);
  ok(!missedOther.some((c) => c.id === id2), 'pengguna lain tidak ikut menerima');
  const missedFresh = await calls.missedFor(eId, Date.now() + 1000);
  ok(!missedFresh.some((c) => c.id === id2), 'filter waktu since bekerja');

  console.log('\n[C6] Panggilan aktif yang macet ditutup otomatis');
  const id3 = `unit-call-stale-${Date.now()}`;
  const gId = uid('g');
  await calls.create({ id: id3, callerId: gId, calleeId: uid('h'), kind: 'audio' });
  await calls.accept(id3);
  const active = await calls.listActiveForUser(gId);
  ok(active.some((c) => c.id === id3), 'panggilan aktif terpantau oleh pembersih');
  await db.run('UPDATE calls SET updated_at = ? WHERE id = ?', Date.now() - 7 * 3_600_000, id3);
  const stale = await calls.expireStaleActive();
  ok(stale.some((c) => c.id === id3 && c.state === 'ended'), 'sesi aktif yang ditinggal lama ditutup sebagai ended');
  ok(!(await calls.expireStaleActive()).some((c) => c.id === id3), 'penutupan sesi macet tidak berulang');

  console.log('\n[C7] Penjaga status tutup & retensi');
  const id4 = `unit-call-guard-${Date.now()}`;
  await calls.create({ id: id4, callerId: uid('i'), calleeId: uid('j'), kind: 'audio' });
  ok(await calls.finish(id4, 'declined') === true, 'dering masih bisa ditolak');
  ok(await calls.finish(id4, 'missed') === false, 'status yang sudah bukan live tidak bisa ditimpa');
  ok((await calls.get(id4)).state === 'declined', 'status tetap declined');

  const id5 = `unit-call-old-${Date.now()}`;
  await calls.create({ id: id5, callerId: uid('k'), calleeId: uid('l'), kind: 'audio' });
  await db.run('UPDATE calls SET created_at = ? WHERE id = ?', Date.now() - 40 * 86_400_000, id5);
  await calls.purgeOld();
  ok(!(await calls.get(id5)), 'riwayat lama dibersihkan sesuai retensi');

  // rapikan baris uji yang masih hidup
  for (const id of [id1, id2, id3, id4]) await calls.remove(id);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('CALLS TEST CRASH:', err);
  process.exit(2);
});
