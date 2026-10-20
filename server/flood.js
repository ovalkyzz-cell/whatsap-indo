'use strict';

/* Bucket sederhana per kunci: mencegah banjir pesan (flood) yang bisa membuat
   akun dianggap spam, sekaligus membatasi aksi sensitif (buat grup, status,
   unggahan storage). Dipakai bersama oleh server/index.js dan server/upload.js
   supaya perlindungannya konsisten di semua rute. */
const floodBuckets = new Map();
const floodSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of floodBuckets) if (now - bucket.start > bucket.windowMs * 2) floodBuckets.delete(key);
}, 60_000);
floodSweep.unref();

function floodGuard(key, max, windowMs) {
  const now = Date.now();
  let bucket = floodBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0, windowMs };
    floodBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

module.exports = { floodGuard };
