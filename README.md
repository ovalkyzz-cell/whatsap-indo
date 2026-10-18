# RTC-Core (Real-Time Chat Core)

Inti chat **real-time** berbasis web dengan autentikasi **email**, kirim **foto / video / audio / file hingga 2GB**, **panggilan suara & video** (WebRTC), serta **enkripsi data privasi saat disimpan** (AES-256-GCM).

## Profil Developer

| | |
|---|---|
| Nama / Dikenal sebagai | **Mazval** |
| Peran | Pembuat & developer utama **RTC-Core** |
| Email resmi | `ovalkyzz@gmail.com` (admin & CS) |
| Rilis pertama | **26 September 2026** |
| Versi terkini | **2.0.0** (rebrand RTC-Core + hardening enkripsi, **16 Oktober 2026**) |
| API pendukung | [api-mazval.zone.id](https://api-mazval.zone.id) (bot, tools, AI, downloader) |
| Repository | [github.com/ovalkyzz-cell/whatsap-indo](https://github.com/ovalkyzz-cell/whatsap-indo) |
| Produksi | [whatsap-indo.vercel.app](https://whatsap-indo.vercel.app) / [whatsapp-mazval.zone.id](https://whatsapp-mazval.zone.id) |

**RTC-Core** dikembangkan penuh oleh **Mazval** — dari arsitektur server (Express + Socket.IO + WebRTC), inti enkripsi data privasi (`server/vault.js`), 69 bot premium, sistem paket & kuota storage nyata, hingga antarmuka PWA yang responsif. Identitas Mazval melekat di seluruh aplikasi: kode undangan `WA-MAZ-VAL-XXXX`, base URL API `api-mazval`, serta akun admin/CS `ovalkyzz@gmail.com`.

## Keamanan & Enkripsi

| Lapisan | Implementasi |
|---|---|
| **Enkripsi saat disimpan (at rest)** | Isi pesan (`body`, `reply_preview`) & teks status dienkripsi **AES-256-GCM** lewat `server/vault.js` sebelum masuk database — kebocoran berkas/backup DB tidak serta-merta membocorkan isi percakapan. Format `RTC1:<iv>:<tag>:<ct>`; data lama (plaintext) tetap terbaca (migrasi malas). |
| **Kunci enkripsi** | Diambil dari `ENCRYPTION_KEY` (base64/hex 32 byte) atau dibuat & disimpan persistent di `data/.enc-key` (mode `0600`). Di Vercel tanpa key eksplisit, kunci di-derive dari `JWT_SECRET` agar stabil antar cold-start. |
| **Password** | Hash **bcrypt** (12 round). |
| **Sesi / token** | JWT **HS256** dengan algoritma dipatuhi saat verifikasi (token `alg:none` / algoritme lain ditolak). |
| **Security header global** | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener/Resource-Policy`, `Permissions-Policy` (kamera & mikrofon hanya origin sendiri), HSTS di HTTPS, `X-Powered-By` disembunyikan. |
| **Anti-spam & brute-force** | Rate-limit auth per IP, 1 akun/IP/24 jam, blokir IP otomatis, limit pesan/status per waktu. |

> Catatan: enkripsi at-rest melindungi data di server (server-side). Ini berbeda dari *end-to-end encryption* — isi pesan tetap diproses di server untuk fitur bot, centang-biru & notifikasi.

## Fitur

| Kategori | Detail |
|---|---|
| Autentikasi | Daftar & masuk dengan email + password (bcrypt 12 + JWT HS256 terpaku) |
| Sesi | **Satu akun satu device** — login baru mematikan sesi & socket perangkat lama |
| Persetujuan | Akun baru berstatus **menunggu** — harus disetujui admin sebelum bisa masuk |
| Anti-spam daftar | **Email satu kali** + **1 akun per IP tiap 24 jam**; pelanggar & gagal beruntun **auto-blokir IP** permanen sampai admin membuka — masuk dengan akun lama tetap diizinkan |
| Chat real-time | Socket.IO — pesan, indikator mengetik, status online/terakhir dilihat |
| Tanda centang | ✓ terkirim → ✓✓ diterima → ✓✓ biru dibaca (read receipt) |
| Blok kode | Pesan berisi ``` (kode) dirender **ala VS Code**: gutter nomor baris, warna sintaks, **tombol Copy** sekali klik |
| Kartu angka | Kode/token khusus (` ```angka `) tampil dengan **font angka profesional** (tabular, tracking lebar) + Copy |
| Kirim media | Foto, video, audio, dokumen — **maksimal 2GB per file** |
| Panggilan | **Suara & video WebRTC** 1-to-1: tombol di header chat & info kontak, layar dering (jawab/tolak/akhiri), mute mic & kamera, timer durasi — sinyal lewat Socket.IO `call:*`. **Tetap berdering walau penerima luring**: baris `calls` dibuat & notifikasi push dikirim, dering **dikirim ulang otomatis** saat penerima kembali daring, lalu tercatat sebagai **panggilan tak terjawab** |
| Preview unduh | Bot Downloader **wajib menampilkan hasil videonya**: rangkaian resolver otomatis (api-mazval → tikwm → fxtwitter → instance cobalt → Piped) mengambil file medianya, divalidasi via probe Range, lalu **diunduh ke server** dan tampil sebagai **pesan video langsung** disertai kapsi *Hasil unduhan: X MB* (fallback terakhir: thumbnail + tautan unduh) |
| Lampiran | Preview sebelum kirim, progress bar unggah, unduh inline |
| Centang biru | Badge resmi (segel biru) ala WhatsApp di nama, header chat, profil & info kontak |
| Bot premium | **69 bot khusus admin & pengguna premium** (premium aktif via `POST /api/admin/premium`) — API dari api-mazval: *Verif AM Prem*, *Generate NFToken*, *AI*, *Downloader*, *Email Generator*, *Tools* + 60 bot generik (Cuaca, Gempa, Jadwal Sholat, Al-Quran, Tafsir Mimpi, Kurs & Kripto, Cek Nomor, Stalk GitHub, Stalk Sosmed, Quotes & Pantun, Tebak-Tebakan, Meme Random, Waifu, Cari Anime & Game, Pencarian Web, Cari Media, Stiker, Screenshot Web, QR Code, Kode Pos & Wilayah, Jadwal Bola, Generator Gambar, Security Domain, Cari NPM, OCR Gambar, Suara MyInstants, Font Keren, Cari Repo, Pencarian Lahelu, Terjemah, Cek IP, Stalk Twitter/X, Stalk Channel, Cari Gambar, Cari Pinterest, Cari Game, Bard Google, Copilot, Claude Opus, GPT-OSS 120B, GPT Klasik, GLM Flash, Phi-2, Deep AI, Public AI, Epsilon AI, PowerBrain, Jeeves AI, AI Realtime, AI Studi, AI Gambar, AI Seni, AI Agama, AI Eksplorasi, Wilayah Indonesia, Simbol Provinsi, Parse NIK, Tracking Paket, NGL, NGL Spam) |
| Panel admin | **Monitor real-time**: daring/luring, device & IP terakhir, riwayat upaya masuk |
| Cek bug admin | **Panel admin pemeriksa bug menempel di aplikasi**: buka `https://<domain>/admin` (terkunci: kunci `ADMIN_KEY` atau sesi akun admin) — 5 pemeriksaan berjalan di server produksi + 4 pemeriksaan berat yang hanya bisa dijalankan di mesin server (ditandai abu-abu); di lokal `npm run admin` (port 3200) menjalankan **semua 9 pemeriksaan nyata** (sintaks, dependensi, database, server, referensi frontend, panel terkunci, unit test, **alur panggilan/VC sungguhan**, berkas rahasia) dengan status **centang hijau = normal** / **merah = perlu diperbaiki**, plus tombol **Perbaiki Sekali Klik** yang memperbaiki lalu memeriksa ulang sampai hijau |
| Daftar Bot | Menu **Daftar Bot** (khusus admin & premium) menampilkan seluruh **69 bot terkelompok per 8 kategori** lewat `GET /api/bots`; user non-premium menerima **panel terkunci + daftar paket premium** (403) |
| 15 Tools Web | Halaman **`/tools.html`** (item menu *15 Tools Web*): 15 tools api-mazval — Terjemah, Cuaca, Cek IP, QR, npm, Kurs, Kripto, Gempa, Kode Pos, Cek Nomor, Info Negara, Jarak Kota, Jadwal Sholat, Stalk GitHub, OCR — tersusun per kategori, formulir otomatis dari `GET /api/tools/web/list`, eksekusi lewat `POST /api/tools/web/run` (auth + rate limit 30/menit + **kuota bot harian yang sama**; isian divalidasi allowlist per tool, kunci API tetap di server); hasil dirender rapi (kunci–nilai, daftar, pratinjau gambar, blok JSON), user non-premium melihat panel terkunci + daftar paket, tema/aksen mengikuti pengaturan pengguna |
| Paket & Harga | Menu **Paket & Harga** (`GET /api/plans`): 6 paket resmi beranimasi — **Harian Rp1.000** (limit 50 pesan/hari, 5 bot eksklusif ditutup, storage 10 GB), **Mingguan Rp10.000** (limit 200/hari, storage 100 GB), **Bulanan Rp25.000** (tanpa limit, storage 2 TB), **Bisnis Rp50.000** (storage 3 TB), **Reseller Bulanan Rp75.000** (storage 5 TB), **Permanen Rp50.000** (100 tahun, storage 5 TB); admin bisa mengubah nama, durasi, harga, limit, **kuota storage (GB)**, bot eksklusif & status permanen |
| Kuota storage nyata | **Foto/video/file yang dikirim benar-benar menempati storage paket** (2 GB gratis – 5 TB): reservasi atomik saat pesan tersimpan, dibebaskan saat dihapus, ditolak (413 + toast) saat melebihi kuota; admin tanpa batas; `GET /api/me/storage`, bar pemakaian di kartu paket, pre-check di endpoint upload, endpoint recompute admin |
| Undangan teman | Kode unik per akun **`WA-MAZ-VAL-XXXX`** + link siap dibagikan; tamu yang mendaftar memakai kode langsung dapat **5 token sambutan**, pengundang dapat **+5 token** & +1 undangan saat tamu disetujui admin (sekali saja); token dipakai otomatis saat kuota harian bot habis |
| Tentang aplikasi | Drawer **Tentang Aplikasi**: identitas RTC-Core Developer, cara pakai (7 langkah), daftar fitur, CS admin `ovalkyzz@gmail.com` dengan tombol chat langsung |
| Hubungi CS | Tombol **Hubungi Admin / CS** (kartu paket, halaman Paket & Harga, Tentang Aplikasi) langsung **membuka chat** lewat `GET /api/cs` — lolos privasi email & pencarian diri sendiri; saat akun CS sendiri yang menekan, chat diri sendiri (ala *message yourself*) tetap terbuka otomatis |
| Proteksi foto | Foto profil terlindungi: klik kanan, seret, salin, unduh & blokir gambar dimatikan; screenshot (PrintScreen / Ctrl+P / Ctrl+S) dan menu cetak menyembunyikannya |
| Kontrol akun | Admin bisa **setujui / tolak** pendaftaran dan **blokir / buka blokir** akun |
| Edit bot | Admin bisa ganti **foto profil, nama & bio** bot langsung dari panel Info Kontak |
| Menu pojok kanan atas | Panel menu geser dari kanan: Profil & Info, Latar Belakang, Paket & Harga, Undang Teman, Tentang Aplikasi, Keluar |
| Latar belakang chat | Ganti background percakapan dengan **foto atau video** (per akun, reset kapan saja) |
| Background beranda | Latar halaman masuk bisa diganti **foto / video** — oleh admin (berlaku semua pengguna) maupun per akun (Menu → Latar Halaman Utama) |
| Profil & Bio | Nama, bio, foto profil, info akun (email, status verifikasi, bergabung, ID) |
| Info kontak | Panel info lawan chat: bio, email, status online/terakhir dilihat, aksi panggilan |
| Notifikasi | Nada pesan + **notifikasi sistem saat tab tidak aktif** (tetap terlihat walau tab sedang terbuka) + **Pusat Notifikasi** (lonceng dengan badge, riwayat notifikasi, tandai sudah dibaca, otomatis terisi lagi saat aplikasi dibuka) + **notifikasi panggilan tak terjawab** + **bilah koneksi** "Menghubungkan kembali…" saat socket terputus |
| Profil | Nama, status, foto profil dengan **pemotong rasio bebas** — geser, cubit/scroll untuk zoom, tarik sudut untuk ubah bentuk, preset *Bebas / 1:1 / 3:4 / 4:3 / 16:9 / 9:16* (berlaku untuk foto profil, foto grup & foto bot) |
| Responsif | Layout mobile (sidebar/chat bergantian) dan desktop ala WhatsApp Web |
| Balasan | **Usap bubble pesan ke kanan** (touch/mouse) untuk membalas — indikator ikon muncul mengikuti jari, bar kutipan di atas input dengan tombol batal, kutipan pengirim + isi tampil di bubble, ketuk kutipan untuk **lompat ke pesan asli** (sorot berkedip). Kolom `reply_to` + `reply_preview` (snapshot) di database, divalidasi server: hanya pesan dalam chat yang sama |
| Gesture back | **Usap dari tepi kiri layar ke kanan** untuk kembali (rasa native/iOS): dari percakapan ke daftar chat, atau menutup foto sekali lihat yang sedang terbuka — bubble mengikuti jari, lepas di ambang 72px = kembali, selain itu snap-back. Tombol **‹ (ikon back)** di action bar atas percakapan berfungsi penuh di mobile |
| Foto sekali lihat | Lampiran khusus gambar (lampiran → *Foto sekali lihat*): penerima hanya boleh mengambil medianya **satu kali** lewat gerbang `/api/messages/media/:id` (permintaan kedua → 410), bubble terkunci *Buka foto sekali lihat*, penanda *sudah dibuka* tersinkron ke pengirim lewat `message:viewed`. Penutup rapi satu jalur: **tombol X**, **Esc**, dan **usap tepi kiri** — semuanya melepas `src` gambar |
| Scroll | Momentum halus (`-webkit-overflow-scrolling: touch`), `overscroll-behavior: contain` di tiap kontainer daftar/pesan/drawer, tanpa pull-to-refresh saat dipakai sebagai APK, dan `:hover` dibatasi ke perangkat tetikus supaya baris tidak menempel miring di layar sentuh |

## Menjalankan

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # auto-reload (node --watch)
npm run admin      # server mini admin terpisah di http://127.0.0.1:3200 (panel yang sama juga ada di /admin)
npm test           # crop + calls + callflow + e2e (server harus berjalan)
npm run test:crop  # geometri pemotong foto saja (tanpa server)
npm run test:calls # unit test mesin panggilan (dering, kirim-ulang, tak terjawab)
npm run test:callflow # uji alur panggilan/VC nyata lewat Socket.IO (server harus berjalan)
npm run test:bots  # unit test balasan 69 bot + katalog 15 tools web (API dimock, tanpa jaringan)
```

Variabel lingkungan opsional:

- `PORT` — port server (default `3000`)
- `JWT_SECRET` — rahasia token JWT (default: dibuat sekali lalu disimpan di `data/.jwt-secret`
  supaya sesi pengguna tidak hilang saat server restart)
- `ADMIN_EMAILS` — daftar email admin dipisah koma (selain `ovalkyzz@gmail.com`); akun dengan
  email ini otomatis **aktif** tanpa persetujuan dan berhak memakai panel admin
- `ADMIN_KEY` — kunci rahasia panel pemeriksa bug (`https://<domain>/admin`); dipakai lewat
  header `x-admin-key` atau `?key=`. Tanpa kunci pun panel tetap terkunci — hanya akun admin
  yang bisa membukanya lewat sesi aplikasi
- `MAZVAL_API_KEY` — **wajib** untuk bot: API key api-mazval yang dipakai seluruh bot
  (tanpa ini bot membalas dengan pesan konfigurasi belum lengkap). **Pengecualian:
  Generator Gambar** (`brat`/`brathd`/`smeme`) tetap menghasilkan gambar sungguhan lewat
  generator lokal (`server/bratimg.js` + `sharp`) saat API tidak tersedia
- `MAZVAL_API_BASE` — base URL api-mazval (default `https://api-mazval.zone.id`)
- `MAZVAL_API_TIMEOUT` — batas tunggu respons API bot dalam ms (default `45000`)
- `DOWNLOAD_BUDGET_MS` — total waktu maksimal rangkaian resolver Downloader dalam ms
  (default `90000`); berlaku untuk seluruh jalur: api-mazval, tikwm, fxtwitter, cobalt & Piped
- `COBALT_API_KEY` — API key opsional bila memakai instance cobalt yang dilindungi key
- `CALL_RING_MS` — lama dering sebelum panggilan ditandai **tak terjawab** (default `60000`)
- `CALL_ACTIVE_MAX_MS` — batas panggilan aktif sebelum dipaksa ditutup sapu bersih
  (default `21600000` = 6 jam)
- `CALL_HISTORY_DAYS` — retensi riwayat panggilan di tabel `calls` (default `30`)

### Instal sebagai aplikasi (desktop & Android)

Aplikasi adalah **PWA** lengkap: `public/manifest.json` (`id`/`start_url`/`scope` = `/`,
`display: standalone` + `display_override`, `launch_handler: navigate-existing` agar jendela
yang sudah terbuka dipakai ulang, bukan dibuka dobel), ikon di `public/icons/`
(192, 512, maskable, apple-touch), dan `public/sw.js` yang meng-cache shell aplikasi
(aset statis saja — `/api`, `/uploads`, dan socket.io tidak pernah di-cache) supaya
bisa dibuka saat offline. Satu basis kode yang sama dipakai untuk web, desktop & APK.

- **Desktop (Windows/macOS/Linux):** buka di Chrome/Edge → menu ⋮ → *Install app* /
  *Install RTC-Core*. Jendela mandiri tanpa address bar, ikon sendiri di taskbar/dock;
  layout desktop (sidebar 432px pada layar ≥1440px) tetap dipakai, scroll daftar chat,
  pesan & drawer berjalan dengan momentum yang sama seperti di ponsel.
- **Android (APK):** situs lolos kriteria instalasi Chrome → buka
  [pwabuilder.com](https://www.pwabuilder.com) dengan URL produksi → *Package for stores*
  → unduh APK/AAB (Android Package) untuk dipasang atau diunggah ke Play Store.
  Alternatif: Chrome Android → menu ⋮ → *Tambahkan ke layar utama*.

### Hasil uji

Dijalankan lokal dengan server berjalan (`npm test`, tanpa `MAZVAL_API_KEY`):

| Tes | Hasil |
|---|---|
| `npm run test:crop` | **22 passed, 0 failed** |
| `npm run test:calls` | **26 passed, 0 failed** |
| `npm run test:callflow` | **29 passed, 0 failed** (alur nyata: dering → jawab → sinyal WebRTC → tutup, tak terjawab, penerima luring, penolakan) |
| `npm run test:groupbot` | **27 passed, 0 failed** (pasang/keluarkan bot grup, diam untuk non-premium, balas real-time saat disebut/dibalas, maks 1 bot) |
| `npm run test:admingroup` | **19 passed, 0 failed** (site admin kelola grup milik orang lain tanpa 403, pasang bot, chat bot real-time; anggota biasa tetap ditolak) |
| `npm test` (e2e) | **350 passed, 15 failed** (sama persis dengan baseline kode bersih: 344 + 6 assert baru tools web) |

15 kegagalan tersebut **semuanya** berasal dari uji bot eksternal yang membutuhkan
`MAZVAL_API_KEY` (AI Gemini/GPT/Claude/DeepSeek, Downloader, Cuaca, Kode Pos,
Wilayah, Simbol Provinsi, Bard, Screenshot/NPM, Katalog Model, Email Generator) —
diverifikasi identik 15/15 pada checkout bersih tanpa perubahan ini.
Seluruh uji autentikasi, sesi, chat, grup, admin, media, **balasan (reply)**,
**kuota storage nyata per paket**, panggilan (luring → kirim-ulang → ditolak → tak terjawab),
notifikasi, PWA, keamanan & **6 assert tools web** (`/tools.html`, daftar/run terproteksi,
validasi allowlist 400, tool tak dikenal 404, eksekusi terkendali) **lolos semua**.

Smoke test storage (`node test/stogetest.js`): **24 passed, 0 failed** — reserve atomik
saat kirim media, release saat hapus, penolakan melebihi kuota, admin tanpa batas, recompute.

Static check pendukung: `eslint` (tanpa error) dan audit `id` DOM
(280 id di `index.html`, tanpa duplikat, tanpa `$()` yang mengacu ke id tak ada).

## Panel admin: cek bug + perbaikan satu klik

Panel pemeriksa bug **menempel pada aplikasi** sehingga bisa dibuka langsung dari
domain produksi:

```
https://whatsapp-mazval.zone.id/admin     # atau https://whatsap-indo.vercel.app/admin
```

**Terproteksi.** Semua endpoint data & perbaikan menolak siapa pun yang bukan admin.
Dua jalur masuk:

1. **Kunci `ADMIN_KEY`** — set sebagai variabel lingkungan, lalu kirim lewat header
   `x-admin-key` (halaman punya kolom "Kunci Admin") atau `?key=...`
2. **Sesi akun admin** — bila sudah login di aplikasi dengan akun admin
   (`ovalkyzz@gmail.com` / `ADMIN_EMAILS` / `role=admin`), panel otomatis memakai
   token dari `localStorage` (`wa_token`) pada origin yang sama.

**Adaptif terhadap lingkungan.** Di server produksi (serverless) pemeriksaan yang
butuh berkas sumber, `git`, atau `pm2` ditandai **abu-abu (dilewati)** — bukan merah —
dan tetap bisa dijalankan penuh dari mesin server:

```bash
npm run admin     # http://127.0.0.1:3200  ->  semua 9 pemeriksaan
```

| # | Pemeriksaan | Yang diuji | Di domain | Perbaikan otomatis |
|---|---|---|---|---|
| 1 | Database & skema | koneksi, tabel, kolom `calls`, dering/panggilan macet, pesan & status yatap | ✓ | migrasi + bersihkan baris macet + `REINDEX`/`wal_checkpoint` |
| 2 | Server aplikasi | `/`, `manifest.json`, `sw.js`, `/api/health` menjawab | ✓ | — |
| 3 | Referensi frontend | id DOM duplikat & `$()` yang menunjuk id tak ada | ✓ (diambil lewat HTTP) | — (lapor `app.js:baris`) |
| 4 | Dependensi | modul runtime terpasang & bisa dimuat | ✓ | `npm install` (lokal) |
| 5 | Panel admin terkunci | `ADMIN_KEY` & daftar email admin tersedia | ✓ | — (petunjuk pengaturan) |
| 6 | Sintaks JavaScript | `node --check` pada seluruh berkas sumber | lokal saja | — (lapor lokasi berkas) |
| 7 | Unit test | `test/crop.js` + `test/calls.js` | lokal saja | — |
| 8 | Alur panggilan/VC | `test/callflow.js`: undangan, dering, jawab, offer/answer/ICE, tutup, tak terjawab, penerima luring, penolakan — lewat **Socket.IO sungguhan** | lokal saja | perbaiki database + restart server |
| 9 | Berkas rahasia git | `.env`/kunci tidak ikut ter-commit | lokal saja | `git rm --cached` + perbarui `.gitignore` |

Tombol **"Perbaiki Sekali Klik"** menjalankan perbaikan nyata pada pemeriksaan
yang merah, lalu **memeriksa ulang seluruhnya** sehingga hasil akhir benar-benar
terbukti (bukan sekadar status yang dilaporkan selesai). Contoh hasil uji nyata:
server sengaja dimatikan + baris panggilan macet dimasukkan → pemeriksaan merah
→ satu klik → kembali hijau. Pemeriksaan di domain selesai dalam hitungan ratusan
milidetik karena dijalankan paralel.

Endpoint JSON (semua butuh autentikasi):
`GET /admin/api/status`, `POST /admin/api/check`, `POST /admin/api/fix`.
Server terpisah `npm run admin` menyediakan jalur yang sama di root
(`/api/status`, `/api/check`, `/api/fix`) plus `/admin`. Aplikasi utama sendiri
menyediakan `GET /api/health` (tanpa autentikasi) untuk uptime monitor.

## Arsitektur

```
server/
  index.js     # Express + Socket.IO, routing API, signaling WebRTC
  auth.js      # register/login, bcrypt, JWT middleware
  calls.js     # catatan panggilan (tabel calls): buat, ubah state, bersihkan
  db.js        # SQLite (better-sqlite3) — users, chats, messages, status
  helpers.js   # serialisasi chat/pesan, chat direct idempoten
  bots.js      # 69 bot admin (9 inti + 60 generik) + perintah + API api-mazval
               # + rangkaian resolver Downloader (tikwm, fxtwitter, cobalt, Piped)
               # + bot Tools dengan 15 perintah (termasuk delegasi TOOLS_EXTRA)
  toolscatalog.js # katalog & eksekutor 15 tools web (/tools.html): definisi field,
               # validasi allowlist, proxy api-mazval tanpa membocorkan kunci API
  upload.js    # multer disk storage, limit 2GB, klasifikasi tipe file,
               # storeBuffer/storeRemoteFile — simpan hasil unduhan bot
               # (streaming langsung ke disk / Vercel Blob, validasi magic bytes)
  bratimg.js   # generator gambar lokal bot Generator Gambar (SVG -> sharp -> PNG brattxt-*.png)
admin/
  checks.js     # mesin pemeriksaan & perbaikan (adaptif: lokal penuh / serverless ringan)
  panel.js      # router panel: guard ADMIN_KEY + sesi admin, rate limit, dashboard hijau/merah
  server.js     # server terpisah (npm run admin) yang memasang panel yang sama di port 3200
public/
  index.html   # shell SPA (auth, chat, drawer, pusat notifikasi, modal panggilan)
  tools.html   # halaman mandiri 15 tools (kartu + formulir + hasil rapi),
               # memakai token login yang sama & tema tersimpan pengguna
  css/style.css
  js/app.js    # state, API client, renderer (inkremental), socket, pusat notifikasi, WebRTC
test/
  crop.js        # 22 assert geometri pemotong foto: rasio bebas/terkunci, clamp zoom
                 # & geser, koordinat ekspor, jangkar sudut, zoom ke titik (tanpa browser)
  calls.js       # 26 assert unit mesin panggilan: dering, kirim-ulang, tak terjawab,
                 # riwayat, pembersih panggilan aktif macet, retensi
  callflow.js    # 29 assert alur panggilan/VC nyata lewat Socket.IO: undangan, dering,
                 # jawab, offer/answer/ICE, tutup, timeout palsu, tak terjawab,
                 # penerima luring -> kirim ulang dering, penolakan bot/sibuk/ditolak
  e2e.js       # e2e: auth, realtime, receipts, upload, delete, signaling panggilan,
               # keamanan upload, grup, status, privasi, push, sesi tunggal, persetujuan,
               # blokir akun, monitor admin real-time, 69 bot (admin & premium), edit nama bot,
               # 20 bot baru (kodesnap, npm zip, katalog model, downloader tersimpan,
               # 18 bot AI, Wilayah Indonesia & Simbol Provinsi) & tools web
               # (/tools.html + /api/tools/web/list|run)
  bot-reply.js # 116 assert unit test balasan 69 bot, rantai resolver Downloader
               # & katalog 15 tools web (API dimock, tanpa jaringan)
data/          # whatsap.db + .jwt-secret (SQLite, gitignored)
uploads/       # file terunggah (gitignored)
```

### Alur pesan real-time

1. Klien kirim `message:send` lewat Socket.IO.
2. Server simpan ke SQLite, update status `delivered` bila penerima online.
3. Penerima dapat `message:new` secara instan; saat chat dibuka server menandai `read`.
4. Pengirim menerima event `message:status` (✓✓ → biru).

### Batas upload

`multer` membatasi file **2 GB** (`2 * 1024³`). File lebih besar ditolak dengan HTTP `413`.

### Latar belakang chat

Kolom `wallpaper_type` (`default` | `image` | `video`), `wallpaper_url`, `wallpaper_mode`
(`cover` | `contain` | `tile`), `wallpaper_scale` (50–300%) dan `wallpaper_dim` (0–70%)
diatur lewat `PATCH /api/me` (mode di luar daftar di-reset ke `cover`, skala di-*clamp*).

Dari **Menu → Latar Belakang Chat** pengguna dapat:

- mengganti latar: foto (maks 50MB) / video (maks 200MB) / bawaan / hapus;
- **mengatur ukuran gambar**: segmen *Penuh (cover)*, *Muat (contain)*, *Ulang (tile)*;
- **zoom** 50%–300% (`transform: scale` untuk foto & video);
- **redupkan latar** 0%–70% (overlay `rgba(0,0,0,var(--wp-dim))`);
- menyimpan otomatis (debounce) atau lewat tombol *Terapkan & Simpan*, plus *Atur Ulang*.

Hasilnya dirender di layer `#chatBg` di belakang percakapan; video diputar tanpa suara
(`muted`, `loop`, `playsinline`).

### Background beranda

Latar halaman utama dirender di tiga layer: `#homeBg` (layar masuk), `#sideHomeBg`
(daftar chat) dan `#emptyHomeBg` (layar kosong) — video diputar `muted`, `loop`, `playsinline`.
Ada dua tingkatan:

- **Admin — Panel Admin → Background Beranda**: pilih foto (maks 50MB) / video (maks 200MB)
  → *Simpan Background* (`PUT /api/admin/settings`), berlaku untuk semua pengguna.
- **Pengguna — Menu → Latar Halaman Utama**: foto/video milik sendiri via `PATCH /api/me { homeBg }`;
  latar pribadi **mengalahkan** latar global, *Hapus Latar* mengembalikan ke bawaan.

Layar tanpa login mengambil latar global dari `GET /api/settings/public` (tanpa autentikasi).
URL divalidasi ketat: hanya path `/uploads/…` atau Blob Vercel (`settings.validBgUrl`).

### Panggilan (WebRTC)

Panggilan suara & video 1-to-1 berjalan langsung antar browser (**WebRTC P2P**, hanya STUN
Google/Twilio — tanpa TURN). Pintu masuknya: **tombol telepon di header chat** (suara/video)
dan **tombol *Suara* / *Video* di panel Info Kontak** — disembunyikan otomatis untuk bot & grup.

Sinyal berjalan lewat Socket.IO (`call:*`) di `server/index.js`, dengan catatan panggilan
tersimpan di **tabel `calls`** (`server/calls.js`):

1. `call:invite` (ada **ack**) → server **selalu** membuat baris `calls` berstatus
   `ringing` lalu mengirim `call:incoming` ke semua tab/perangkat penerima. Penerima
   **luring pun tidak ditolak** — server tetap menjawab `ok:true` (dengan `delivered:false`)
   dan mengirim **notifikasi push** berjudul *"Panggilan masuk"* supaya dering sampai
   walau aplikasinya tertutup. (Satu-satunya penolakan: pemanggil sudah berada di
   panggilan lain, atau lawannya bot.)
2. Penerima kembali daring (membuka tab, jaringan pulih, atau tab lain terbuka) →
   server membaca `calls.pendingIncoming()` lalu mengirim ulang `call:incoming` untuk
   panggilan yang **masih berdering** — sama seperti WhatsApp yang terus berdering
   sampai dijawab / ditolak / waktunya habis.
3. Penerima menekan *Jawab* → `call:accept` (mencatat `answered_at` & menutup layar
   dering di tab lain milik penerima) → membuat SDP **offer**.
4. Penjawab menerima `offer` → membuat **answer**; keduanya bertukar ICE candidate
   lewat `call:signal` (hanya untuk panggilan yang terdaftar di server).
5. Selesai: `call:hangup` / `call:reject` / habis masa dering → baris **tetap disimpan
   sebagai riwayat** + `call:ended` dengan `reason`
   (`ended` | `rejected` | `timeout` | `accepted` | `cancelled`).

Sapu bersih berkala (`sweepCalls`, tiap 5 detik, `server/index.js`):

- dering yang lewat `CALL_RING_MS` → status `missed` + notifikasi
  **panggilan tak terjawab** ke penerima (kirim `call:missed` + push fallback);
- panggilan aktif yang macet (`CALL_ACTIVE_MAX_MS`) → ditutup `ended` di kedua sisi;
- riwayat lebih tua dari `CALL_HISTORY_DAYS` → dihapus.

**Riwayat & Pusat Notifikasi.** `GET /api/calls` mengembalikan riwayat panggilan
(bisa difilter `?since=<ms>` untuk yang tak terjawab saja). Saat aplikasi dibuka,
`syncMissedCalls()` menarik panggilan tak terjawab 7 hari terakhir ke **Pusat Notifikasi**
(lonceng) — sehingga tidak ada panggilan tak terjawab yang hilang hanya karena ponsel
offline saat itu.

Perilaku pelindung:

- dering maksimal **60 detik** (lalu `timeout` + tak terjawab), koneksi WebRTC maksimal **20 detik**;
- `disconnected` diberi toleransi **8 detik** sebelum panggilan ditutup (blip jaringan tidak
  langsung memutus), `failed` langsung menutup;
- **hanya pemanggil** yang menutup tab saat berdering yang membatalkan panggilan;
  penerima boleh putus & sambung ulang tanpa deringnya hilang (`cleanupCalls`);
- panggilan aktif ditutup otomatis saat **kedua** pihak sudah luring;
- menolak otomatis bila sudah berada di panggilan lain; bot tidak dapat dipanggil;
- pantulan/relay lewat **HTTPS** diperlukan untuk `getUserMedia` selain di localhost.

> **Catatan HTTPS:** browser hanya mengizinkan `getUserMedia` (mikrofon/kamera) di **localhost**
> atau lewat **HTTPS**. Buka `http://<ip-server>:3000` dari perangkat lain = panggilan akan
> menolak dengan pesan jelas, karena itu untuk pemakaian luar localhost gunakan reverse proxy TLS
> (mis. Caddy/Nginx) atau tunnel seperti ngrok.

Test `e2e.js` bagian `[11]` memastikan modul, handler, tabel, tombol, modal, gaya CSS, dan
alur sinyal `call:invite → call:incoming → call:hangup → call:ended` semuanya ada & bekerja.

### Keamanan masuk, persetujuan & panel admin

**Satu akun satu device.** Setiap `register` / `login` membuat `session_id` baru yang
ditanam di JWT (`sid`). `requireAuth` dan handshake Socket.IO membandingkan `sid` token dengan
`session_id` akun:

- login dari perangkat kedua → **semua socket perangkat lama diputus langsung dari
  server** (`kickUserSessions()` memutus socket lama, lalu klien menerima
  `auth:session-replaced` dan keluar dengan pesan jelas);
- `POST /api/auth/logout`, **tolak pendaftaran** & **blokir akun** memakai jalur yang sama,
  sehingga sesi/token lama ikut mati **dan** tab yang masih terbuka langsung terputus
  (bukan cuma menunggu muat ulang);
- akun lama (data sebelum fitur ini) otomatis diminta masuk ulang satu kali.

**Persetujuan pendaftaran.** Akun baru dibuat dengan `account_status = 'pending'` dan tidak
mendapat token. `POST /api/auth/login` menjawab `403` + `code` (`pending` | `rejected` | `banned`).
Email di `ADMIN_EMAILS` (dan `ovalkyzz@gmail.com`) langsung `active`.

**Kontrol admin** (semua butuh peran admin, akun admin tidak bisa disentuh):

| Endpoint | Aksi |
|---|---|
| `GET /api/admin/monitor` | Daftar pengguna (daring, device, IP, status), pendaftaran menunggu, 40 log masuk terakhir — `pending` diambil **terpisah** dari jendela `LIMIT 200` (urutan `last_login_at` yang NULL membuat pendaftar baru tersingkir saat user > 200) |
| `POST /api/admin/users/:id/approve` | Setujui pendaftaran → akun bisa masuk |
| `POST /api/admin/users/:id/reject` | Tolak pendaftaran (`body: { reason }`) → login `403 rejected` |
| `POST /api/admin/users/:id/ban` | Blokir akun (`body: { reason }`) → sesi diputus, login `403 banned` |
| `POST /api/admin/users/:id/unban` | Buka blokir |
| `POST /api/auth/logout` | Cabut sesi aktif |
| `PATCH /api/admin/bots/:id` | Ubah **foto profil** / nama / bio bot (`avatar`, `name`, `about`) |

`:id` boleh berupa UUID atau email. Admin menerima `admin:event` real-time
(`registered`, `approved`, `rejected`, `banned`, `unbanned`, `login`, `logout`, `online`, `offline`)
lewat Socket.IO, sehingga panel *Monitor Real-time* terupdate tanpa muat ulang.

### Bot (9 bot inti + 60 bot generik = 69 bot) — khusus admin & premium

Enam puluh sembilan bot dibuat otomatis saat boot (`server/bots.js`) sebagai akun dengan `is_bot = 1`,
`verified = 1`, status `active` — tampil di pencarian **hanya untuk admin dan pengguna
premium** (`premium_until` masih aktif; diberikan lewat `POST /api/admin/premium`) dan
selalu membawa **badge centang biru**. Sembilan bot inti ditulis manual; 60 bot generik
digenerate
dari spesifikasi `GENERIC_SPECS` — menu, pemetaan argumen, format baris + blok JSON, dan
preview media otomatis, semuanya menuju endpoint api-mazval yang benar-benar tersedia.
Spesifikasi ber-`kind: 'ai'` (18 bot AI baru) memakai jalur balasan AI yang sama dengan
bot *AI*: jawaban model dirapikan, blok kode dijaga seimbang, percobaan ulang + model
cadangan dalam satu anggaran waktu — jadi pertanyaan tetap terjawab walau satu model
sedang sibuk.

**Daftar Bot (menu premium).** `GET /api/bots` menyusun katalog dari `catalog()`
(`server/bots.js`): delapan kategori — AI & Asisten, Gambar & Karya Visual, Agama &
Spiritual, Info & Data, Pencarian & Stalking, Media & Hiburan, Produktivitas & Developer,
Khusus Kebutuhan Admin — berisi `id`, `name`, `tagline`, `about`, `sample` & `avatar`
terbaru tiap bot. Endpoint ini hanya untuk **admin & premium**; user lain menerima
`403 { locked: true, total, plans }` sehingga antarmuka bisa menampilkan panel
“Daftar Bot Khusus Premium” lengkap dengan daftar paket. Seluruh bot wajib muncul tepat
satu kali di katalog (diverifikasi pada `npm run test:bots`).

| Bot | ID | Perintah |
|---|---|---|
| **Verif AM Prem** | `bot-verif-am` | `send <email>` → kirim tautan verifikasi Alight Motion Premium; `cek <email> <token>` → cek status verifikasi; `menu` |
| **Generate NFToken** | `bot-nftoken` | `generate <1-10>` (default 1) → **respon JSON rapi** + tombol Copy; `menu` |
| **AI** | `bot-ai` | `gpt` / `gemini` / `deepseek` / `claude` + pertanyaan (default ChatGPT, awalan dibuang dari isi); kode keluar sebagai **blok kode ala VS Code + Copy** (fence dijaga selalu seimbang); perintah tanpa pertanyaan ditolak; `menu` |
| **Downloader** | `bot-down` | kirim tautan video → deteksi platform lewat **domain persis** (TikTok, IG, YouTube, FB, X, Threads, Reddit, dll — `max.com` tidak salah jadi Twitter) → **file media diunduh ke server lalu tampil sebagai pesan video** (kapsi *Hasil unduhan: X MB — siap ditonton & diunduh*) + judul, kreator & tautan unduh; **rangkaian resolver berlapis** bila jalur pertama tak memberi file: endpoint aio api-mazval → **tikwm** (TikTok/Douyin) → **fxtwitter** (X/Twitter) → **instance cobalt** (IG, FB, X, YT, SoundCloud, …) → **instance Piped** (YouTube, mp4 muxed); kandidat tanpa ekstensi **di-probe Range** dulu supaya benar-benar video; URL tanpa `https://` diterima; semua jalur gagal → thumbnail + panduan cobalt; `menu` |
| **Email Generator** | `bot-email` | `buat [nama]` → email sementara (kartu angka); `domains`; `cek <email>` → inbox + **OTP**; `baca <email> <nomor>`; `menu` |
| **Tools** | `bot-tools` | **15 perintah**: `terjemah <teks>`, `cuaca <kota>`, `ip <ip>`, `qr <teks>`, `npm <paket>`, `kurs <dari> <ke> [jumlah]`, `kripto <koin>`, `gempa`, `kodepos <area>`, `nomor <08xx>`, `negara <nama>`, `jarak <dari> <ke>`, `sholat <kota>`, `github <user>`, `ocr <url gambar>`; `menu` — versi web di **`/tools.html`** (sama 15 tools lewat `GET /api/tools/web/list` + `POST /api/tools/web/run`) |
| **Screenshot Kode** | `bot-kodesnap` | `kode <teks>` → render kode jadi **gambar PNG tersimpan** (`/api/image/codesnap`); `menu` |
| **Unduh Kode npm** | `bot-npm-zip` | `zip <paket> [versi]` → source code npm jadi **berkas .zip tersimpan** (`/api/tools/npm2zip`); `menu` |
| **Katalog Model AI** | `bot-model-ai` | `daftar`, `cari <kata>`, `gratis` → katalog model mimo (`/api/mimo/models`); `menu` |
| **Cuaca** | `bot-cuaca` | `cuaca <kota>` → suhu, kelembaban, angin, matahari (`/api/info/cuaca`) |
| **Info Gempa** | `bot-gempa` | `gempa` → gempa terkini BMKG (`/api/info/gempa`) |
| **Jadwal Sholat** | `bot-sholat` | `sholat <kota>`, `doa <kata>` (`/api/info/jadwal-sholat`, `/api/info/doa`) |
| **Al-Quran** | `bot-quran` | `surat <1-114>` → Arab, latin & terjemah (`/api/info/alquran`) |
| **Tafsir Mimpi** | `bot-mimpi` | `mimpi <teks>`, `nama <nama>` (`/api/info/tafsir-mimpi`, `/api/info/arti-nama`) |
| **Kurs & Kripto** | `bot-kurs` | `kurs <dari> <ke> [jumlah]`, `kripto <koin>` (`/api/tools/currency`, `/api/info/crypto`) |
| **Cek Nomor** | `bot-nomor` | `nomor <08xx>`, `negara <nama>` (`/api/tools/cek-nomor`, `/api/tools/countryInfo`) |
| **Stalk GitHub** | `bot-github` | `github <user>` (`/api/stalk/github`) |
| **Stalk Sosmed** | `bot-stalk` | `twitter <user>`, `channel <user>`, `pinterest <user>`, `threads <user>` (`/api/stalk/*`) |
| **Quotes & Pantun** | `bot-quotes` | `pantun`, `bucin`, `anime` (`/api/random/*`, `/api/r/quotesanime`) |
| **Tebak-Tebakan** | `bot-tebak` | `tebak`, `tekateki`, `asahotak` (`/api/random/*`) |
| **Meme Random** | `bot-meme` | `meme`, `papayang`, `acak` → sering menyertakan **gambar langsung** |
| **Waifu Random** | `bot-waifu` | `waifu` → gambar acak (`/api/random/waifu`) |
| **Cari Anime & Game** | `bot-anime` | `anime <judul>`, `manga <judul>`, `game <judul>` (Otakotaku, Mangatoon, MCPEDL) |
| **Pencarian Web** | `bot-web` | `ddg <kata>`, `brave <kata>`, `gambar <kata>` (DuckDuckGo, Brave, Bing Images) |
| **Cari Media** | `bot-media` | `yt <kata>`, `musik <kata>`, `pin <kata>` (YouTube, Apple Music, Pinterest) |
| **Stiker** | `bot-stiker` | `stiker <kata>`, `paket <kata>` (Stickerly, Combot) |
| **Screenshot Web** | `bot-ss` | `ss <url>` → tangkapan layar jadi **pesan gambar** (`/api/tools/ssweb`) |
| **QR Code** | `bot-qr` | `buat <teks>` → QR jadi gambar; `baca <url gambar>` (`/api/tools/qr-*`) |
| **Kode Pos & Wilayah** | `bot-pos` | `kodepos <area>`, `provinsi`, `jarak <dari> <ke>` |
| **Jadwal Bola** | `bot-bola` | `bola [tanggal]` → pertandingan hari itu (TheSportsDB) |
| **Generator Gambar** | `bot-brat` | `brat <teks>`, `brathd <teks>`, `smeme <teks>` → **gambar langsung di chat** (PNG lokal `brattxt-*.png` bila API tak tersedia) |
| **Security Domain** | `bot-domain` | `recon <domain>`, `subdomain <domain>` (`/api/tools/domain-recon`, `/api/tools/subdomains`) |
| **Cari NPM** | `bot-npm` | `npm <paket>` → versi, lisensi, deskripsi (`/api/tools/npmjs`) |
| **OCR Gambar** | `bot-ocr` | `baca <url gambar>` → teks hasil OCR (`/api/tools/ocr`) |
| **Suara MyInstants** | `bot-suara` | `suara <kata>`, `trending` → suara/botol meme (`/api/s/myinstants`) |
| **Font Keren** | `bot-font` | `font <gaya>` → gaya font unik (`/api/s/8font`) |
| **Cari Repo** | `bot-repo` | `repo <kata>` → repositori GitHub (`/api/s/gitagram`) |
| **Pencarian Lahelu** | `bot-cari-lahelu` | `lahelu <kata>` (`/api/s/lahelu`) |
| **Terjemah** | `bot-terjemah` | `terjemah <teks>` → en → id (`/api/tools/translate`) |
| **Cek IP** | `bot-ip` | `ip <alamat>` → info geolokasi ISP (`/api/tools/ip-lookup`) |
| **Stalk Twitter / X** | `bot-stalker-x` | `twitter <user>` → profil X (`/api/stalk/twitter`) |
| **Stalk Channel** | `bot-channel` | `channel <user>` → channel YouTube (`/api/stalk/youtube`) |
| **Cari Gambar** | `bot-gambar` | `gambar <kata>` → hasil gambar (`/api/s/bimg`) |
| **Cari Pinterest** | `bot-pin` | `pin <kata>` (`/api/s/pinterest`) |
| **Cari Game** | `bot-game` | `game <kata>` → game Android/PC (`/api/s/mcpedl`) |
| **Bard Google** | `bot-bard` | `bard <pertanyaan>` → jawaban Bard Google (`/api/ai/bard-google`) |
| **Copilot** | `bot-copilot` | `copilot <pertanyaan>` (`/api/ai/copilot`) |
| **Claude Opus** | `bot-opus` | `opus <pertanyaan>` (`/api/ai/claude-opus`) |
| **GPT-OSS 120B** | `bot-gptoss` | `oss <pertanyaan>` (`/api/ai/gptoss120b`) |
| **GPT Klasik** | `bot-gpt-klasik` | `gpt <pertanyaan>` (`/api/ai/gpt`) |
| **GLM Flash** | `bot-glm` | `glm <pertanyaan>` (`/api/ai/glm47flash`) |
| **Phi-2** | `bot-phi` | `phi <pertanyaan>` (`/api/ai/phi2`) |
| **Deep AI** | `bot-deepai` | `deep <pertanyaan>` (`/api/ai/deep-ai`) |
| **Public AI** | `bot-publicai` | `public <pertanyaan>` (`/api/ai/publicai`) |
| **Epsilon AI** | `bot-epsilon` | `epsilon <pertanyaan>` (`/api/ai/epsilon-ai`) |
| **PowerBrain** | `bot-powerbrain` | `powerbrain <pertanyaan>` (`/api/ai/powerbrain-ai`) |
| **Jeeves AI** | `bot-jeeves` | `jeeves <permintaan>` (`/api/ai/jeeves-ai`) |
| **AI Realtime** | `bot-realtime` | `realtime <pertanyaan>`, `prompt <topik>` (`/api/ai/ai-realtime`, `/api/ai/ai-prompt`) |
| **AI Studi** | `bot-studi` | `grammar <kalimat>`, `quillbot <kalimat>`, `qwq <soal>`, `apertus <pertanyaan>` |
| **AI Gambar** | `bot-aigambar` | `gambar/flux/banana/text2img <deskripsi>` → **langsung jadi pesan gambar** |
| **AI Seni** | `bot-aiseni` | `anime/real/chibi/bardimg <deskripsi>` → gambar gaya seni AI |
| **AI Agama** | `bot-aiagama` | `islam <pertanyaan>`, `bible <pertanyaan>`, `gita <pertanyaan>` |
| **AI Eksplorasi** | `bot-eksplorasi` | `dolphin`, `blackbox`, `felo`, `feloai` + pertanyaan (model cadangan otomatis) |
| **Wilayah Indonesia** | `bot-wilayah` | `provinsi`, `kabupaten <id prov>`, `kecamatan <id kab>`, `desa <id kec>` (`/api/info/wilayah`) |
| **Simbol Provinsi** | `bot-simbol` | `simbol [id provinsi]` (`/api/info/symbols`) |

Setiap bot generik menjawab `menu` dengan kotak nama + daftar perintah + contoh; input
tanpa perintah atau argumen kurang dibalas **blok error rapi** (`❌` + alasan + contoh);
respons API ditampilkan sebagai baris ringkas + daftar data (maks 5 bullet) + **blok JSON
dengan tombol Copy**; URL gambar/video di respons otomatis dikirim sebagai **pesan media**
(host tanpa ekstensi seperti `api.qrserver.com`, `api.brattxt.xyz`, `image.thum.io` ikut
dikenali).

**Format pesan kaya (frontend `public/js/app.js`):**

- Blok ```` ```lang ```` → panel kode gelap ala VS Code: dot jendela, label bahasa,
  gutter nomor baris, warna sintaks (string/keyword/komentar/angka), dan tombol **Copy**
  (klipbord + fallback `execCommand`); JSON di-format ulang otomatis sebelum ditampilkan.
- Blok ```` ```angka ```` → **kartu khusus angka/token** dengan font monospace tebal,
  `tabular-nums`, tracking lebar & sentuhan emas — dipakai untuk token verifikasi,
  alamat email, suhu, IP, dll.
- Tautan `https://…` pada pesan otomatis menjadi tautan bisa diklik.
- Nama/bio hasil edit admin **tidak tertimpa** saat server restart (seed hanya
  menyegarkan baris yang masih memakai nama bawaan).

Cara kerja:

1. Pesan masuk ke chat direct dengan bot → server menandai pesan **dibaca** (pengirim langsung
   mendapat centang biru) dan menampilkan indikator *mengetik*.
2. `server/bots.js` memanggil API **api-mazval** — bot inti memakai endpoint akses akun
   (`/api/tools/am-verif-*`, `/api/tools/nftoken-generate`, `/api/ai/*`, `/api/download/*`,
   `/api/tempmail/*`) dan bot generik endpoint publiknya (`/api/info/*`, `/api/tools/*`,
   `/api/stalk/*`, `/api/random/*`, `/api/s/*`, `/api/image/*` dst.) memakai `MAZVAL_API_KEY`
   — kunci tidak pernah disimpan di kode maupun dikirim ke klien. Bila panggilan API gambar
   gagal (tanpa kunci / layanan turun / respons tanpa media), **Generator Gambar** langsung
   me-render PNG di server (`server/bratimg.js`: SVG → `sharp`) lalu menyimpannya ke
   `/uploads/brattxt-*.png`, sehingga pengguna tetap menerima gambar sungguhan.
3. Balasan disimpan sebagai pesan biasa dari akun bot: notifikasi push bila admin luring,
   badge terverifikasi, dan teks berformat profesional (header, langkah, kode token).
4. **Hasil unduhan video/audio/berkas** (Downloader, npm zip) disimpan dulu ke penyimpanan
   kita — `server/upload.js` `storeRemoteFile`/`storeBuffer` menaruh file ke `uploads/`
   (lokal) atau **Vercel Blob** (produksi, `BLOB_READ_WRITE_TOKEN`) dengan validasi tipe
   lewat magic bytes; file besar dialirkan **streaming langsung ke disk** (batas video
   512MB, tanpa menumpuk di RAM) dan nama file diambil dari `Content-Disposition`;
   pesan lalu memuat media `/uploads/…` + kapsi *Hasil unduhan: X MB*
   sehingga file tetap bisa ditonton/diunduh meski tautan pihak ketiga kedaluwarsa.

Pembatasan akses (gerbang `canUseBots` = **admin ATAU premium aktif**; menolak user biasa):

- `GET /api/users/search` — bot tidak ikut ditampilkan untuk non-admin/non-premium;
- `GET /api/users/:id` — `404` untuk non-admin/non-premium;
- `GET /api/chats` — chat bot disembunyikan bila akses premium habis;
- `POST /api/chats/direct` — `403` "Bot hanya dapat digunakan oleh admin dan pengguna premium.";
- `message:send` di chat bot — ditolak bila pengirim bukan admin/premium (pesan sama);
- premium **dicabut** (`POST /api/admin/premium/revoke`) → bot langsung hilang dari pencarian
  & daftar chat, membuka chat bot kembali `403`;
- bot **tidak bisa ditambahkan ke grup** (`POST /api/chats/:id/members` → `403`) dan tidak
  membalas di grup.

### Paket, kuota bot & undangan teman

Paket disimpan di `settings.plans` lewat `PUT /api/admin/settings` dan dinormalisasi
`normalizePlans` (`server/settings.js`): tiap paket `{ id, label, days, price, dailyLimit,
excluded, permanent }` (maks 12 paket). Data lama **tanpa `price`** dianggap usang dan
diganti `DEFAULT_PLANS` — 4 paket resmi (Harian Rp1.000/50 pesan/5 bot eksklusif tertutup,
Mingguan Rp10.000/200, Bulanan Rp25.000/tanpa limit, Permanen Rp50.000/tanpa limit +
`permanent: true`); paket custom admin tetap dipakai dan **paket resmi yang hilang
ditambahkan otomatis di belakang**.

- `GET /api/plans` (login) → `{ plans, botTotal, exclusiveBotIds, invite, me }` untuk halaman
  *Paket & Harga*: `me` berisi `planId`, `limit`, `used`, `tokens`, `until`, `active`, `admin`.
- **Bot eksklusif** (`EXCLUSIVE_BOTS`: `bot-verif-am`, `bot-nik`, `bot-pos`, `bot-wilayah`,
  `bot-nftoken`) hanya untuk paket di atas Harian: disaring dari `GET /api/bots`, pencarian,
  profil (`404`) & chat (`403` "Bot ini tidak termasuk paket …") — admin selalu lolos.
- **Kuota harian** (`consumeBotQuota` di `server/index.js`, dijalankan tepat sebelum pesan bot
  disimpan): kolom `bot_usage_day`/`bot_usage_count` di-reset otomatis per hari (WIB);
  kuota habis → memakai **1 token** (`bot_tokens`); token habis → `message:send` gagal dengan
  pesan *Kuota bot paket … sudah habis* yang tampil di chat.
- Admin (`premium_until` + role) melewati seluruh filter & kuota.

**Undangan teman** (`server/referral.js`): kode `WA-MAZ-VAL-XXXX` (4 karakter tanpa 0/O/1/I/L,
dibuat saat pertama dibuka lewat `GET /api/referral`), link `${origin}/?ref=KODE`.

- `POST /api/auth/register` menerima `ref` → kode divalidasi **sebelum** baris user dibuat
  (kode salah/asing → `400`), pendaftar dicatat `referred_by` + langsung `bot_tokens + 5`;
- saat akun tamu **disetujui admin** (`POST /api/admin/users/:id/approve`) pengundang mendapat
  `bot_tokens + 5` & `invite_count + 1` — idempoten lewat kolom `ref_rewarded`;
- `GET /api/referral` → `{ code, link, tokens, invited, referred, welcomeTokens, inviteTokens }`;
- kolom baru ikut migrasi `TABLE_MIGRATIONS` (`server/db.js`): `ref_code`, `referred_by`,
  `ref_rewarded`, `invite_count`, `bot_tokens`, `bot_usage_day`, `bot_usage_count`.

**Kontak CS** (`GET /api/cs`, butuh login) → `{ user, self }`: admin/CS paling senior (email
`ADMIN_EMAILS`/`VERIFIED_EMAILS`, fallback `role = 'admin'`) diserialisasi lengkap dengan status
online. Tombol **Hubungi Admin / CS** (kartu paket, halaman Paket & Harga, Tentang Aplikasi)
memakai endpoint ini alih-alih `/api/users/search`, sehingga tidak gigit ekor oleh privasi
`priv_email` maupun pengecualian diri sendiri (`WHERE id <> ?`). `self: true` = penanya adalah
CS itu sendiri → klien tetap `POST /api/chats/direct` dengan `peerId` sendiri: **chat diri
sendiri** (ala *message yourself*) dibuat satu baris anggota dan tampil di daftar chat dengan
nama sendiri, jadi tombol selalu membuka chat otomatis tanpa pesan galat.

Foto profil bot — **khusus admin**:

- di **Info kontak** bot muncul tombol kamera pada foto; pilih gambar (maks 5MB) → unggah →
  `PATCH /api/admin/bots/:id { avatar }`. Foto baru langsung tampil di daftar chat & header
  chat (event `chat:updated`), tanpa muat ulang;
- endpoint juga menerima `name` dan `about`; URL foto di luar `/uploads/*` atau Blob Vercel
  ditolak `400`; akun non-bot → `404`; user biasa → `403`;
- badge centang biru & penanda `isBot` tetap melekat setelah diedit, labelnya
  "Bot resmi • Siap membantu".

### Anti-spam pendaftaran & blokir IP (`server/antispam.js`)

Pendaftaran dikendalikan tiga lapis: modul `server/antispam.js`, tabel `reg_logs`
(ledger percobaan per IP) dan `ip_bans` (blokir permanen).

- **Email satu kali** — `users.email` UNIQUE; memakai email yang sudah terdaftar →
  `409 Email sudah terdaftar`, dan percobaannya ikut tercatat di ledger.
- **Limit per IP** — maksimal **1 pendaftaran sukses per IP dalam 24 jam** (ambang
  `perIp` bisa diubah lewat `settings.antispam`). Percobaan ke-2 dari IP yang sama
  dianggap spam → IP **diblokir otomatis**, pendaftaran berikutnya menerima `403`
  berkode `ip_diblokir` dengan pesan *…Hubungi admin untuk membuka blokir* — pesan
  langsung tampil di form daftar.
- **Gagal beruntun** — ≥ 10 percobaan pendaftaran gagal dalam 10 menit dari satu IP
  juga memblokir IP otomatis.
- **Login tidak dibatasi** — blokir hanya menahan **pendaftaran**; akun lama tetap
  bisa masuk dari IP yang diblokir.
- **IP lokal dikecualikan** — loopback (`127.0.0.1`, `::1`) tidak dihitung maupun
  diblokir, sehingga server lokal & suite test tidak mengunci dirinya sendiri. IP
  klien diambil dari `X-Forwarded-For` lewat *trust proxy* Express (otomatis aktif
  di Vercel; di belakang nginx set `TRUST_PROXY=1`), sehingga akurat dan sulit
  dipalsukan klien.
- **Panel admin** — bagian **IP Diblokir** menampilkan IP, alasan, jumlah pelanggaran
  (`×N`) dan waktunya. Tombol **Buka blokir** memakai `POST /api/admin/ip-bans/unban`
  yang membuka blokir **dan mereset kuota pendaftaran IP** (supaya tidak langsung kena
  lagi), IP bisa diblokir manual via `POST /api/admin/ip-bans/ban`, dan daftar penuh
  diambil lewat `GET /api/admin/ip-bans` — semuanya hanya untuk sesi admin (`401`/`403`).
- **Notifikasi** — blokir otomatis mengirim `admin:event ip_banned`: kartu notifikasi
  *IP Diblokir (Anti-Spam)* bersuara khusus pada admin, plus baris `blocked` di
  riwayat monitor (*upaya masuk*) lengkap dengan alasannya.
- **Bersih-bersih** — ledger percobaan yang lebih tua dari 30 hari dihapus berkala.
  Blokir bersifat **permanen** sampai admin membukanya.

Uji otomatis: `npm run test:antispam` (30 pemeriksaan) menjalankan server sungguhan
dengan `TRUST_PROXY=1` lalu memalsukan `X-Forwarded-For` per kasus — termasuk alur
blokir otomatis, notifikasi admin, buka blokir, blokir manual, login dari IP terblokir
dan penolakan non-admin.

### Keamanan

- File di `/uploads` disajikan dengan `X-Content-Type-Options: nosniff`; HTML/XML/JS dan tipe
  tak dikenal dipaksa `application/octet-stream` + `Content-Disposition: attachment`,
  SVG juga wajib diunduh saat dibuka langsung — mencegah XSS yang bisa mencuri token
  dari file buatan pengguna pada origin yang sama.
- `POST /api/auth/register` dan `/api/auth/login` dibatasi **60 request/menit per IP** (anti
  brute-force) → HTTP `429`.
- Endpoint API butuh `Authorization: Bearer <JWT>`; event socket hanya diteruskan ke
  pengguna terautentikasi yang merupakan peserta chat terkait.
- Foto profil & gambar terlindungi di sisi klien (`public/js/app.js`): `contextmenu`,
  `dragstart` & `copy` diblokir, `PrintScreen` / `Ctrl+P` / `Ctrl+S` membuat
  tampilan kosong, dan `@media print` menyembunyikan gambar — tanpa memakai
  `preventDefault()` di `touchstart` supaya gesture scroll daftar chat & pesan tetap lancar
  saat jari dimulai dari foto. Unggahan foto profil melewati **pemotong rasio bebas**
  (JPEG kualitas 0.92, sisi terpanjang 512–1024px) sehingga pengatur sendiri
  area yang dipakai, bukan center-crop otomatis.

## Lisensi

MIT
