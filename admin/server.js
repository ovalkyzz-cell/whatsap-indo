'use strict';
/* ============================================================
   SERVER MINI ADMIN (jalur lokal)
   ------------------------------------------------------------
   Menjalankan panel pemeriksa bug & perbaikan satu klik secara
   terpisah dari aplikasi utama, untuk mesin pengembangan / VPS:

       npm run admin     ->  http://127.0.0.1:3200

   Panel yang sama juga menempel pada aplikasi utama di
   https://<domain>/admin — mesin pemeriksaannya satu kode
   (admin/checks.js), jadi hasilnya selalu sama.

   Lingkungan: ADMIN_PORT (3200), ADMIN_HOST (127.0.0.1),
   BASE_URL (alamat aplikasi yang diperiksa), ADMIN_KEY (kunci).
   ============================================================ */

const path = require('path');
const express = require('express');
const db = require('../server/db');
const { createAdminPanel } = require('./panel');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ADMIN_PORT) || 3200;
const HOST = process.env.ADMIN_HOST || '127.0.0.1';
const APP_PORT = Number(process.env.PORT) || 3000;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
const panel = createAdminPanel({ root: ROOT, base: BASE, db });
app.use('/', panel);       // versi ringkas: http://127.0.0.1:3200/
app.use('/admin', panel);  // jalur sama dengan di aplikasi: /admin

app.listen(PORT, HOST, () => {
  console.log(`Server mini admin berjalan di http://${HOST}:${PORT}`);
  console.log(`Panel: http://${HOST}:${PORT}/  (atau /admin)`);
  console.log(`Target aplikasi: ${BASE}${ADMIN_KEY ? ' (kunci admin aktif)' : ''}`);
});
