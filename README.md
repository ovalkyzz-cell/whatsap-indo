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
- `JWT_SECRET` — rahasia token JWT (default: random per boot)

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
  e2e.js       # 29 assert: auth, realtime, receipts, upload, delete
data/          # whatsap.db (SQLite, gitignored)
uploads/       # file terunggah (gitignored)
```

### Alur pesan real-time

1. Klien kirim `message:send` lewat Socket.IO.
2. Server simpan ke SQLite, update status `delivered` bila penerima online.
3. Penerima dapat `message:new` secara instan; saat chat dibuka server menandai `read`.
4. Pengirim menerima event `message:status` (✓✓ → biru).

### Batas upload

`multer` membatasi file **2 GB** (`2 * 1024³`). File lebih besar ditolak dengan HTTP `413`.

### Panggilan (WebRTC)

- `call:invite` → dering di penerima
- Penerima `accept` → membuat SDP offer → saling bertukar ICE candidate via Socket.IO
- STUN publik Google/Twilio (tanpa TURN — untuk jaringan NAT ketat, tambahkan TURN server sendiri)

## Lisensi

MIT
