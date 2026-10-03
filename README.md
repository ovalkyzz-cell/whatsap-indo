# Whatsap Indo

Clone WhatsApp berbasis web dengan autentikasi **email**, chat **real-time**, kirim **foto / video / audio / file hingga 2GB**, serta **panggilan suara & video** (WebRTC).

## Fitur

| Kategori | Detail |
|---|---|
| Autentikasi | Daftar & masuk dengan email + password (bcrypt + JWT) |
| Sesi | **Satu akun satu device** — login baru mematikan sesi & socket perangkat lama |
| Persetujuan | Akun baru berstatus **menunggu** — harus disetujui admin sebelum bisa masuk |
| Chat real-time | Socket.IO — pesan, indikator mengetik, status online/terakhir dilihat |
| Tanda centang | ✓ terkirim → ✓✓ diterima → ✓✓ biru dibaca (read receipt) |
| Blok kode | Pesan berisi ``` (kode) dirender **ala VS Code**: gutter nomor baris, warna sintaks, **tombol Copy** sekali klik |
| Kartu angka | Kode/token khusus (` ```angka `) tampil dengan **font angka profesional** (tabular, tracking lebar) + Copy |
| Kirim media | Foto, video, audio, dokumen — **maksimal 2GB per file** |
| Preview unduh | Bot Downloader **wajib menampilkan hasil videonya**: rangkaian resolver otomatis (api-mazval → tikwm → fxtwitter → instance cobalt → Piped) mengambil file medianya, divalidasi via probe Range, lalu **diunduh ke server** dan tampil sebagai **pesan video langsung** disertai kapsi *Hasil unduhan: X MB* (fallback terakhir: thumbnail + tautan unduh) |
| Lampiran | Preview sebelum kirim, progress bar unggah, unduh inline |
| Panggilan | WebRTC 1-to-1: suara & video, ring, tolak/akhiri, mute mic/kamera |
| Centang biru | Badge resmi (segel biru) ala WhatsApp di nama, header chat, profil & info kontak |
| Bot premium | **45 bot khusus admin & pengguna premium** (premium aktif via `POST /api/admin/premium`) — API dari api-mazval: *Verif AM Prem*, *Generate NFToken*, *AI*, *Downloader*, *Email Generator*, *Tools* + 36 bot generik (Cuaca, Gempa, Jadwal Sholat, Al-Quran, Tafsir Mimpi, Kurs & Kripto, Cek Nomor, Stalk GitHub, Stalk Sosmed, Quotes & Pantun, Tebak-Tebakan, Meme Random, Waifu, Cari Anime & Game, Pencarian Web, Cari Media, Stiker, Screenshot Web, QR Code, Kode Pos & Wilayah, Jadwal Bola, Generator Gambar, Security Domain, Cari NPM, OCR Gambar, Suara MyInstants, Font Keren, Cari Repo, Pencarian Lahelu, Terjemah, Cek IP, Stalk Twitter/X, Stalk Channel, Cari Gambar, Cari Pinterest, Cari Game) |
| Panel admin | **Monitor real-time**: daring/luring, device & IP terakhir, riwayat upaya masuk |
| Kontrol akun | Admin bisa **setujui / tolak** pendaftaran dan **blokir / buka blokir** akun |
| Edit bot | Admin bisa ganti **foto profil, nama & bio** bot langsung dari panel Info Kontak |
| Menu pojok kanan atas | Panel menu geser dari kanan: Profil & Info, Latar Belakang, Tentang, Keluar |
| Latar belakang chat | Ganti background percakapan dengan **foto atau video** (per akun, reset kapan saja) |
| Background beranda | Latar halaman masuk bisa diganti **foto / video** — oleh admin (berlaku semua pengguna) maupun per akun (Menu → Latar Halaman Utama) |
| Profil & Bio | Nama, bio, foto profil, info akun (email, status verifikasi, bergabung, ID) |
| Info kontak | Panel info lawan chat: bio, email, status online/terakhir dilihat, aksi panggilan |
| Notifikasi | Nada pesan + notifikasi browser saat tab tidak aktif |
| Profil | Nama, status, foto profil |
| Responsif | Layout mobile (sidebar/chat bergantian) dan desktop ala WhatsApp Web |

## Menjalankan

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # auto-reload (node --watch)
npm test           # test end-to-end (server harus berjalan)
npm run test:bots  # unit test balasan 45 bot (API dimock, tanpa jaringan)
```

Variabel lingkungan opsional:

- `PORT` — port server (default `3000`)
- `JWT_SECRET` — rahasia token JWT (default: dibuat sekali lalu disimpan di `data/.jwt-secret`
  supaya sesi pengguna tidak hilang saat server restart)
- `ADMIN_EMAILS` — daftar email admin dipisah koma (selain `ovalkyzz@gmail.com`); akun dengan
  email ini otomatis **aktif** tanpa persetujuan dan berhak memakai panel admin
- `MAZVAL_API_KEY` — **wajib** untuk bot: API key api-mazval yang dipakai seluruh bot
  (tanpa ini bot membalas dengan pesan konfigurasi belum lengkap)
- `MAZVAL_API_BASE` — base URL api-mazval (default `https://api-mazval.zone.id`)
- `MAZVAL_API_TIMEOUT` — batas tunggu respons API bot dalam ms (default `45000`)
- `DOWNLOAD_BUDGET_MS` — total waktu maksimal rangkaian resolver Downloader dalam ms
  (default `90000`); berlaku untuk seluruh jalur: api-mazval, tikwm, fxtwitter, cobalt & Piped
- `COBALT_API_KEY` — API key opsional bila memakai instance cobalt yang dilindungi key

## Arsitektur

```
server/
  index.js     # Express + Socket.IO, routing API, signaling WebRTC
  auth.js      # register/login, bcrypt, JWT middleware
  db.js        # SQLite (better-sqlite3) — users, chats, messages, status
  helpers.js   # serialisasi chat/pesan, chat direct idempoten
  bots.js      # 45 bot admin (9 inti + 36 generik) + perintah + API api-mazval
               # + rangkaian resolver Downloader (tikwm, fxtwitter, cobalt, Piped)
  upload.js    # multer disk storage, limit 2GB, klasifikasi tipe file,
               # storeBuffer/storeRemoteFile — simpan hasil unduhan bot
               # (streaming langsung ke disk / Vercel Blob, validasi magic bytes)
public/
  index.html   # shell SPA (auth, chat, drawer, modal panggilan)
  css/style.css
  js/app.js    # state, API client, renderer, socket, WebRTC
test/
  e2e.js       # 254 assert: auth, realtime, receipts, upload, delete, signaling panggilan,
               # keamanan upload, grup, status, privasi, push, sesi tunggal, persetujuan,
               # blokir akun, monitor admin real-time, 45 bot (admin & premium), edit nama bot
               # & 15 bot baru (kodesnap, npm zip, katalog model, downloader tersimpan)
  bot-reply.js # 53 assert unit test balasan 45 bot + rantai resolver Downloader
               # (API dimock, tanpa jaringan)
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

Urutan sinyal:

1. `call:invite` (ada **ack**) → server menandai panggilan lalu mengirim `call:incoming` ke semua
   tab/perangkat penerima. Offline → ack `ok:false`.
2. Penerima menekan *Jawab* → `call:accept` (menutup layar dering di tab lain milik penerima)
   → membuat SDP **offer**.
3. Penjawab menerima `offer` → membuat **answer**; keduanya bertukar ICE candidate
   lewat `call:signal` (hanya untuk panggilan yang terdaftar di server).
4. Selesai: `call:hangup` / `call:reject` → `call:ended` dengan `reason`
   (`ended` | `rejected` | `timeout` | `accepted` | `cancelled`).

Perilaku pelindung:

- dering maksimal **60 detik** (lalu `timeout`), koneksi WebRTC maksimal **20 detik**;
- `disconnected` diberi toleransi **8 detik** sebelum panggilan ditutup (blip jaringan tidak
  langsung memutus), `failed` langsung menutup;
- penelepon/penerima menutup tab saat masih berdering → pihak lain menerima `call:ended`;
- menolak otomatis bila sudah berada di panggilan lain;
- STUN publik Google/Twilio (tanpa TURN — untuk jaringan NAT ketat, tambahkan TURN server sendiri).

> **Catatan HTTPS:** browser hanya mengizinkan `getUserMedia` (mikrofon/kamera) di **localhost**
> atau lewat **HTTPS**. Buka `http://<ip-server>:3000` dari perangkat lain = panggilan akan
> menolak dengan pesan jelas, karena itu untuk pemakaian luar localhost gunakan reverse proxy TLS
> (mis. Caddy/Nginx) atau tunnel seperti ngrok.

### Keamanan masuk, persetujuan & panel admin

**Satu akun satu device.** Setiap `register` / `login` membuat `session_id` baru yang
ditanam di JWT (`sid`). `requireAuth` dan handshake Socket.IO membandingkan `sid` token dengan
`session_id` akun:

- login dari perangkat kedua → token & socket perangkat pertama langsung mati
  (`admin:event` / `session:replaced` → klien keluar dengan pesan jelas);
- `POST /api/auth/logout` mengosongkan sesi sehingga token lama ikut mati;
- akun lama (data sebelum fitur ini) otomatis diminta masuk ulang satu kali.

**Persetujuan pendaftaran.** Akun baru dibuat dengan `account_status = 'pending'` dan tidak
mendapat token. `POST /api/auth/login` menjawab `403` + `code` (`pending` | `rejected` | `banned`).
Email di `ADMIN_EMAILS` (dan `ovalkyzz@gmail.com`) langsung `active`.

**Kontrol admin** (semua butuh peran admin, akun admin tidak bisa disentuh):

| Endpoint | Aksi |
|---|---|
| `GET /api/admin/monitor` | Daftar pengguna (daring, device, IP, status), pendaftaran menunggu, 40 log masuk terakhir |
| `POST /api/admin/users/:id/approve` | Setujui pendaftaran → akun bisa masuk |
| `POST /api/admin/users/:id/reject` | Tolak pendaftaran (`body: { reason }`) → login `403 rejected` |
| `POST /api/admin/users/:id/ban` | Blokir akun (`body: { reason }`) → sesi diputus, login `403 banned` |
| `POST /api/admin/users/:id/unban` | Buka blokir |
| `POST /api/auth/logout` | Cabut sesi aktif |
| `PATCH /api/admin/bots/:id` | Ubah **foto profil** / nama / bio bot (`avatar`, `name`, `about`) |

`:id` boleh berupa UUID atau email. Admin menerima `admin:event` real-time
(`registered`, `approved`, `rejected`, `banned`, `unbanned`, `login`, `logout`, `online`, `offline`)
lewat Socket.IO, sehingga panel *Monitor Real-time* terupdate tanpa muat ulang.

### Bot (9 bot inti + 36 bot generik = 45 bot) — khusus admin & premium

Empat puluh lima bot dibuat otomatis saat boot (`server/bots.js`) sebagai akun dengan `is_bot = 1`,
`verified = 1`, status `active` — tampil di pencarian **hanya untuk admin dan pengguna
premium** (`premium_until` masih aktif; diberikan lewat `POST /api/admin/premium`) dan
selalu membawa **badge centang biru**. Sembilan bot inti ditulis manual; 36 bot generik
digenerate
dari spesifikasi `GENERIC_SPECS` — menu, pemetaan argumen, format baris + blok JSON, dan
preview media otomatis, semuanya menuju endpoint api-mazval yang benar-benar tersedia.

| Bot | ID | Perintah |
|---|---|---|
| **Verif AM Prem** | `bot-verif-am` | `send <email>` → kirim tautan verifikasi Alight Motion Premium; `cek <email> <token>` → cek status verifikasi; `menu` |
| **Generate NFToken** | `bot-nftoken` | `generate <1-10>` (default 1) → **respon JSON rapi** + tombol Copy; `menu` |
| **AI** | `bot-ai` | `gpt` / `gemini` / `deepseek` / `claude` + pertanyaan (default ChatGPT, awalan dibuang dari isi); kode keluar sebagai **blok kode ala VS Code + Copy** (fence dijaga selalu seimbang); perintah tanpa pertanyaan ditolak; `menu` |
| **Downloader** | `bot-down` | kirim tautan video → deteksi platform lewat **domain persis** (TikTok, IG, YouTube, FB, X, Threads, Reddit, dll — `max.com` tidak salah jadi Twitter) → **file media diunduh ke server lalu tampil sebagai pesan video** (kapsi *Hasil unduhan: X MB — siap ditonton & diunduh*) + judul, kreator & tautan unduh; **rangkaian resolver berlapis** bila jalur pertama tak memberi file: endpoint aio api-mazval → **tikwm** (TikTok/Douyin) → **fxtwitter** (X/Twitter) → **instance cobalt** (IG, FB, X, YT, SoundCloud, …) → **instance Piped** (YouTube, mp4 muxed); kandidat tanpa ekstensi **di-probe Range** dulu supaya benar-benar video; URL tanpa `https://` diterima; semua jalur gagal → thumbnail + panduan cobalt; `menu` |
| **Email Generator** | `bot-email` | `buat [nama]` → email sementara (kartu angka); `domains`; `cek <email>` → inbox + **OTP**; `baca <email> <nomor>`; `menu` |
| **Tools** | `bot-tools` | `terjemah <teks>`, `cuaca <kota>`, `ip <ip>`, `qr <teks>`, `npm <paket>`; `menu` |
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
| **Generator Gambar** | `bot-brat` | `brat <teks>`, `brathd <teks>`, `smeme <teks>` → **gambar langsung di chat** |
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
   — kunci tidak pernah disimpan di kode maupun dikirim ke klien.
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
  membalas di grup;
- bot **tidak bisa dipanggil**: `call:invite` ditolak server ("Bot tidak dapat dipanggil"),
  tombol panggilan suara/video disembunyikan di header chat & info kontak, dan `startCall`
  di frontend ikut menjaga dengan toast "Bot tidak bisa dipanggil".

Foto profil bot — **khusus admin**:

- di **Info kontak** bot muncul tombol kamera pada foto; pilih gambar (maks 5MB) → unggah →
  `PATCH /api/admin/bots/:id { avatar }`. Foto baru langsung tampil di daftar chat & header
  chat (event `chat:updated`), tanpa muat ulang;
- endpoint juga menerima `name` dan `about`; URL foto di luar `/uploads/*` atau Blob Vercel
  ditolak `400`; akun non-bot → `404`; user biasa → `403`;
- badge centang biru & penanda `isBot` tetap melekat setelah diedit; tombol panggilan
  suara/video disembunyikan di info kontak **dan** header chat bot, labelnya
  "Bot resmi • Siap membantu", dan server menolak `call:invite` ke bot.

### Keamanan

- File di `/uploads` disajikan dengan `X-Content-Type-Options: nosniff`; HTML/XML/JS dan tipe
  tak dikenal dipaksa `application/octet-stream` + `Content-Disposition: attachment`,
  SVG juga wajib diunduh saat dibuka langsung — mencegah XSS yang bisa mencuri token
  dari file buatan pengguna pada origin yang sama.
- `POST /api/auth/register` dan `/api/auth/login` dibatasi **60 request/menit per IP** (anti
  brute-force) → HTTP `429`.
- Endpoint API butuh `Authorization: Bearer <JWT>`; signaling panggilan hanya diteruskan ke
  pengguna yang terdaftar dan merupakan peserta panggilan tersebut.

## Lisensi

MIT
