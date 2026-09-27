# Whatsap Indo

Clone WhatsApp berbasis web dengan autentikasi **email**, chat **real-time**, kirim **foto / video / audio / file hingga 2GB**, serta **panggilan suara & video** (WebRTC).

## Fitur

| Kategori | Detail |
|---|---|
| Autentikasi | Daftar & masuk dengan email + password (bcrypt + JWT) |
| Chat real-time | Socket.IO — pesan, indikator mengetik, status online/terakhir dilihat |
| Tanda centang | ✓ terkirim → ✓✓ diterima → ✓✓ biru dibaca (read receipt) |
| Kirim media | Foto, video, audio, dokumen — **maksimal 2GB per file** |
| Lampiran | Preview sebelum kirim, progress bar unggah, unduh inline |
| Panggilan | WebRTC 1-to-1: suara & video, ring, tolak/akhiri, mute mic/kamera |
| Centang biru | Badge resmi (segel biru) ala WhatsApp di nama, header chat, profil & info kontak |
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

## Arsitektur

```
server/
  index.js     # Express + Socket.IO, routing API, signaling WebRTC
  auth.js      # register/login, bcrypt, JWT middleware
  db.js        # SQLite (better-sqlite3) — users, chats, messages, status
  helpers.js   # serialisasi chat/pesan, chat direct idempoten
  upload.js    # multer disk storage, limit 2GB, klasifikasi tipe file
public/
  index.html   # shell SPA (auth, chat, drawer, modal panggilan)
  css/style.css
  js/app.js    # state, API client, renderer, socket, WebRTC
test/
  e2e.js       # 47 assert: auth, realtime, receipts, upload, delete, signaling panggilan, keamanan upload
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
