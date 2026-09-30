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
| Lampiran | Preview sebelum kirim, progress bar unggah, unduh inline |
| Panggilan | WebRTC 1-to-1: suara & video, ring, tolak/akhiri, mute mic/kamera |
| Centang biru | Badge resmi (segel biru) ala WhatsApp di nama, header chat, profil & info kontak |
| Bot admin | **6 bot khusus admin**: *Verif AM Prem*, *Generate NFToken*, *AI*, *Downloader*, *Email Generator*, *Tools* — API dari api-mazval |
| Panel admin | **Monitor real-time**: daring/luring, device & IP terakhir, riwayat upaya masuk |
| Kontrol akun | Admin bisa **setujui / tolak** pendaftaran dan **blokir / buka blokir** akun |
| Edit bot | Admin bisa ganti **foto profil, nama & bio** bot langsung dari panel Info Kontak |
| Menu pojok kanan atas | Panel menu geser dari kanan: Profil & Info, Latar Belakang, Tentang, Keluar |
| Latar belakang chat | Ganti background percakapan dengan **foto atau video** (per akun, reset kapan saja) |
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
```

Variabel lingkungan opsional:

- `PORT` — port server (default `3000`)
- `JWT_SECRET` — rahasia token JWT (default: dibuat sekali lalu disimpan di `data/.jwt-secret`
  supaya sesi pengguna tidak hilang saat server restart)
- `ADMIN_EMAILS` — daftar email admin dipisah koma (selain `ovalkyzz@gmail.com`); akun dengan
  email ini otomatis **aktif** tanpa persetujuan dan berhak memakai panel admin
- `MAZVAL_API_KEY` — **wajib** untuk bot: API key api-mazval yang dipakai keenam bot
  (tanpa ini bot membalas dengan pesan konfigurasi belum lengkap)
- `MAZVAL_API_BASE` — base URL api-mazval (default `https://api-mazval.zone.id`)
- `MAZVAL_API_TIMEOUT` — batas tunggu respons API bot dalam ms (default `45000`)

## Arsitektur

```
server/
  index.js     # Express + Socket.IO, routing API, signaling WebRTC
  auth.js      # register/login, bcrypt, JWT middleware
  db.js        # SQLite (better-sqlite3) — users, chats, messages, status
  helpers.js   # serialisasi chat/pesan, chat direct idempoten
  bots.js      # 3 bot admin + perintah + pemanggilan API api-mazval
  upload.js    # multer disk storage, limit 2GB, klasifikasi tipe file
public/
  index.html   # shell SPA (auth, chat, drawer, modal panggilan)
  css/style.css
  js/app.js    # state, API client, renderer, socket, WebRTC
test/
  e2e.js       # 209 assert: auth, realtime, receipts, upload, delete, signaling panggilan,
               # keamanan upload, grup, status, privasi, push, sesi tunggal, persetujuan,
               # blokir akun, monitor admin real-time, 6 bot admin & edit nama bot
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

### Bot admin (Verif AM Prem, Generate NFToken, AI, Downloader, Email, Tools)

Enam bot dibuat otomatis saat boot (`server/bots.js`) sebagai akun dengan `is_bot = 1`,
`verified = 1`, status `active` — tampil di pencarian **hanya untuk admin** dan selalu
membawa **badge centang biru**.

| Bot | ID | Perintah |
|---|---|---|
| **Verif AM Prem** | `bot-verif-am` | `send <email>` → kirim tautan verifikasi Alight Motion Premium; `cek <email> <token>` → cek status verifikasi; `menu` |
| **Generate NFToken** | `bot-nftoken` | `generate <1-10>` (default 1) → **respon JSON rapi** + tombol Copy; `menu` |
| **AI** | `bot-ai` | `gpt` / `gemini` / `deepseek` / `claude` + pertanyaan (default ChatGPT); kode keluar sebagai **blok kode ala VS Code + Copy**; `menu` |
| **Downloader** | `bot-down` | kirim tautan video → deteksi platform (TikTok, IG, YouTube, FB, X, dll) → judul, kreator & tautan unduh; `menu` |
| **Email Generator** | `bot-email` | `buat [nama]` → email sementara (kartu angka); `domains`; `cek <email>` → inbox + **OTP**; `baca <email> <nomor>`; `menu` |
| **Tools** | `bot-tools` | `terjemah <teks>`, `cuaca <kota>`, `ip <ip>`, `qr <teks>`, `npm <paket>`; `menu` |

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
2. `server/bots.js` memanggil API **api-mazval** (`/api/tools/am-verif-send`,
   `/api/tools/am-verif-check`, `/api/tools/nftoken-generate`, `/api/ai/*`) memakai
   `MAZVAL_API_KEY` — kunci tidak pernah disimpan di kode maupun dikirim ke klien.
3. Balasan disimpan sebagai pesan biasa dari akun bot: notifikasi push bila admin luring,
   badge terverifikasi, dan teks berformat profesional (header, langkah, kode token).

Pembatasan akses (semua menolak user biasa):

- `GET /api/users/search` — bot tidak ikut ditampilkan untuk non-admin;
- `GET /api/users/:id` — `404` untuk non-admin;
- `POST /api/chats/direct` — `403` "Bot ini hanya dapat digunakan oleh admin.";
- `message:send` di chat bot — ditolak bila pengirim bukan admin;
- bot **tidak bisa ditambahkan ke grup** (`POST /api/chats/:id/members` → `403`) dan tidak
  membalas di grup.

Foto profil bot — **khusus admin**:

- di **Info kontak** bot muncul tombol kamera pada foto; pilih gambar (maks 5MB) → unggah →
  `PATCH /api/admin/bots/:id { avatar }`. Foto baru langsung tampil di daftar chat & header
  chat (event `chat:updated`), tanpa muat ulang;
- endpoint juga menerima `name` dan `about`; URL foto di luar `/uploads/*` atau Blob Vercel
  ditolak `400`; akun non-bot → `404`; user biasa → `403`;
- badge centang biru & penanda `isBot` tetap melekat setelah diedit; tombol panggilan
  suara/video disembunyikan di info kontak bot dan labelnya "Bot resmi • Siap membantu".

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
