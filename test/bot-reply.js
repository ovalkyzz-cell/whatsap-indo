'use strict';
/* Unit test balasan keenam bot dengan API mock (tanpa jaringan).
   Jalankan: npm run test:bots  */
process.env.MAZVAL_API_KEY = 'test-key';
const path = require('path').join(__dirname, '..', 'server', 'bots.js');
const fakeResponses = {
  '/api/tools/nftoken-generate': { success: true, data: { data: [
    { token: 'NFT-AAAA-1111', expiry: '2027-01-01', plan: 'Premium', country: 'ID' },
    { token: 'NFT-BBBB-2222', expiry: '2027-01-01' },
  ], failed: 0 } },
  '/api/tools/am-verif-send': { success: true, data: { email: 'a@b.com', link: 'https://verify.example/oobCode123', status: 'sent' } },
  '/api/tools/am-verif-check': { success: true, data: { status: 'verified', uid: '998877' } },
  '/api/download/youtube': { status: true, result: {
    title: 'Video Contoh', author: 'Kreator', thumbnail: 'https://cdn.example/thumb.jpg',
    download: { mp4: 'https://cdn.example/v.mp4', mp3: 'https://cdn.example/a.mp3', note: 'Gunakan cobalt' },
    url: 'https://youtu.be/x' } },
  // bentuk asli TikTok di api-mazval: tanpa judul/thumbnail, hanya catatan cobalt
  '/api/download/tiktok': { status: true, result: {
    url: 'https://www.tiktok.com/@akun/video/1',
    download: { cobalt_url: 'https://cobalt.tools', note: 'Paste URL TikTok di cobalt.tools' } } },
  '/api/download/facebook': { status: true, result: {
    title: 'FB Contoh', author: 'Pages',
    download: { note: 'Gunakan cobalt.tools' },
    url: 'https://www.facebook.com/x' } },
  '/api/download/twitter': { status: true, result: {
    title: 'TW-CONTOH', author: '@akunx',
    download: { mp4: 'https://cdn.example/tw.mp4' },
    url: 'https://x.com/a/status/1' } },
  '/api/download/instagram': { status: false, message: 'URL Instagram tidak valid' },
  '/api/ai/chatgpt': { result: 'Halo juga! Ada yang bisa dibantu?' },
  '/api/ai/gemini': { result: 'Jawaban Gemini.' },
  '/api/ai/deepseekr1': { result: '```js\nconst a = 1;' }, // fence tak ditutup -> wajib diseimbangkan
  '/api/ai/claude-ai': { result: 'Jawaban Claude.' },
  '/api/tempmail/generate': { status: 'success', data: { email: 'uji123@bhap.me', inbox_url: 'https://generator.email/uji123@bhap.me' } },
  '/api/tempmail/domains': { status: 'success', data: { domains: ['bhap.me', 'xelio.sbs'] } },
  '/api/tempmail/inbox': { status: 'success', data: { email: 'uji123@bhap.me', total_messages: 1,
    messages: [{ from: 'no-reply@x.com', subject: 'Kode OTP kamu', date: 'just now', link: 'l1' }], otp: '493821', verification_link: null, body: null } },
  // bot generik (30 bot) — dipetakan langsung ke endpoint api-mazval
  '/api/info/cuaca': { success: true, endpoint: '/api/info/cuaca',
    data: { kota: 'Jakarta', suhu_c: '27', kelembaban: 73, deskripsi: 'Cerah' } },
  '/api/tools/currency': { status: true, result: { from: 'USD', to: 'IDR', amount: 100, rate: 16000, result: 1600000, date: '2026-10-01' } },
  '/api/info/jarakkota': { status: true, result: {
    dari: { kota: 'Jakarta', latitude: -6.17 }, ke: { kota: 'Bandung', latitude: -6.92 },
    jarak_km: 119.63, metode: 'Haversine' } },
  '/api/info/provinsi': { success: true, data: { total: 2, provinsi: [{ kode: '1', nama: 'Bali' }, { kode: '2', nama: 'Jawa Barat' }] } },
  '/api/image/brat': { status: true, result: { url: 'https://api.brattxt.xyz/?text=halo%20guys', text: 'halo guys' } },
  '/api/tools/ssweb': { status: true, result: { url: 'https://image.thum.io/get/width/1200/crop/800/https://example.com', target: 'https://example.com' } },
  '/api/tools/cek-nomor': { status: false, message: 'Nomor tidak valid' },
};
global.__calls = [];
global.fetch = async (url) => {
  const u = new URL(url);
  global.__calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
  const key = Object.keys(fakeResponses).find((k) => u.pathname.endsWith(k));
  const body = key ? fakeResponses[key] : { success: false, error: 'endpoint tak dikenal: ' + u.pathname };
  return { ok: true, status: 200, json: async () => body };
};
const bots = require(path);

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, l) => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗ FAIL:', l)); };
  const lastCall = () => global.__calls[global.__calls.length - 1];

  const nf = await bots.reply({ id: 'bot-nftoken' }, 'generate 2');
  ok(nf.startsWith('✅ 2 NFToken'), 'NFToken: header sukses');
  ok(nf.includes('```json') && nf.includes('"NFT-AAAA-1111"') && nf.includes('"count": 2'), 'NFToken: JSON rapi + Copy');
  ok(/token/i.test(nf), 'NFToken: tetap cocok uji lama /token/i');

  const vs = await bots.reply({ id: 'bot-verif-am' }, 'send a@b.com');
  ok(vs.includes('```angka') && vs.includes('https://verify.example/oobCode123'), 'Verif send: kartu angka berisi tautan');

  const vc = await bots.reply({ id: 'bot-verif-am' }, 'cek a@b.com tok123');
  ok(vc.includes('```angka') && vc.includes('tok123') && vc.includes('998877'), 'Verif cek: token di kartu angka');

  const dn = await bots.reply({ id: 'bot-down' }, 'https://youtu.be/x');
  ok(dn && typeof dn === 'object' && dn.media && dn.media.type === 'video'
    && dn.media.url === 'https://cdn.example/v.mp4' && dn.media.mime === 'video/mp4',
    'Downloader: file .mp4 dikirim sebagai pesan video langsung');
  ok(dn.text.includes('Video Contoh') && dn.text.includes('https://cdn.example/v.mp4') && dn.text.includes('YouTube'),
    'Downloader: teks tetap memuat judul + tautan unduh');

  // URL tanpa https:// (tempelan polos) tetap dikenali
  const bare = await bots.reply({ id: 'bot-down' }, 'tolong unduh youtu.be/x dong');
  ok(bare && typeof bare === 'object' && bare.media && bare.media.type === 'video'
    && lastCall().path === '/api/download/youtube',
    'Downloader: URL polos tanpa https:// tetap terdeteksi');

  // tanda baca di ujung URL dibuang sebelum dikirim ke API
  await bots.reply({ id: 'bot-down' }, 'https://youtu.be/x).');
  ok(lastCall().params.url === 'https://youtu.be/x',
    'Downloader: tanda baca ujung URL dibersihkan');

  // pencocokan lewat hostname persis: max.com bukan Twitter (x.com)
  const twx = await bots.reply({ id: 'bot-down' }, 'https://x.com/a/status/1');
  const twxText = typeof twx === 'string' ? twx : (twx && twx.text) || '';
  ok(twxText.includes('Twitter / X') && lastCall().path === '/api/download/twitter',
    'Downloader: x.com cocok Twitter / X');
  const notTw = await bots.reply({ id: 'bot-down' }, 'https://max.com/video/1');
  ok(lastCall().path === '/api/download/aio' && !/Twitter/i.test(String(notTw)),
    'Downloader: max.com tidak salah terbaca sebagai Twitter');

  // respon status:false -> blok error, bukan "Media ditemukan"
  const igFail = await bots.reply({ id: 'bot-down' }, 'https://www.instagram.com/p/abc');
  ok(typeof igFail === 'string' && /Video tidak dapat diunduh/.test(igFail)
    && igFail.includes('URL Instagram tidak valid') && !/Media ditemukan/.test(igFail),
    'Downloader: status:false dipercikkan sebagai error rapi');

  // TikTok bentuk asli (tanpa tautan unduh) -> panduan cobalt + sumber, bukan janji kosong
  const dt = await bots.reply({ id: 'bot-down' }, 'https://www.tiktok.com/@akun/video/1');
  ok(typeof dt === 'string' && dt.includes('Tautan dikenali — TikTok')
    && dt.includes('Cara unduh') && dt.includes('https://cobalt.tools')
    && dt.includes('Tautan sumber: https://www.tiktok.com/@akun/video/1')
    && dt.includes('Paste URL TikTok di cobalt.tools'),
    'Downloader: respons tanpa tautan tetap memberi panduan lengkap');

  const df = await bots.reply({ id: 'bot-down' }, 'https://www.facebook.com/x');
  ok(typeof df === 'string' && df.includes('FB Contoh') && df.includes('Tautan sumber'),
    'Downloader: tanpa thumbnail tetap membalas teks rapi');

  const unknown = await bots.reply({ id: 'bot-down' }, 'hai');
  ok(/Tautan tidak ditemukan/.test(unknown), 'Downloader: input tanpa URL ditolak');

  const em = await bots.reply({ id: 'bot-email' }, 'buat uji123');
  ok(em.includes('```angka') && em.includes('uji123@bhap.me'), 'Email: alamat di kartu angka');

  const ed = await bots.reply({ id: 'bot-email' }, 'domains');
  ok(ed.includes('```text') && ed.includes('bhap.me'), 'Email: daftar domain dalam blok kode');

  const ei = await bots.reply({ id: 'bot-email' }, 'cek uji123@bhap.me');
  ok(ei.includes('Kode OTP: 493821') && ei.includes('1. Kode OTP kamu'), 'Email: inbox menampilkan OTP & daftar pesan');

  const tl = await bots.reply({ id: 'bot-tools' }, 'menu');
  ok(tl.includes('Terjemah') && tl.includes('cuaca'), 'Tools: menu lengkap');

  const ai = await bots.reply({ id: 'bot-ai' }, 'menu');
  ok(ai.includes('blok kode ala VS Code') && ai.includes('tombol Copy'), 'AI: menu menyebut blok kode + Copy');

  // perintah model tanpa pertanyaan -> ditolak, jangan dikirim ke API
  const gptEmpty = await bots.reply({ id: 'bot-ai' }, 'gpt');
  ok(/Pertanyaan masih kosong/.test(gptEmpty) && !/Halo juga/.test(gptEmpty),
    'AI: "gpt" tanpa pertanyaan ditolak (tidak kirim sampah ke API)');
  const gemEmpty = await bots.reply({ id: 'bot-ai' }, 'gemini');
  ok(/Pertanyaan masih kosong/.test(gemEmpty), 'AI: "gemini" tanpa pertanyaan ditolak');

  // awalan model dibuang dari isi pertanyaan
  const gptAsk = await bots.reply({ id: 'bot-ai' }, 'gpt halo halo');
  ok(gptAsk.includes('Halo juga!') && gptAsk.includes('🤖 ChatGPT')
    && lastCall().path === '/api/ai/chatgpt'
    && lastCall().params.prompt.startsWith('halo halo'),
    'AI: awalan "gpt" dibuang, pertanyaan utuh dikirim ke ChatGPT');

  // tanpa awalan -> default ChatGPT dengan seluruh teks sebagai pertanyaan
  const plain = await bots.reply({ id: 'bot-ai' }, 'apa kabar');
  ok(plain.includes('Halo juga!') && lastCall().path === '/api/ai/chatgpt'
    && lastCall().params.prompt.startsWith('apa kabar'),
    'AI: tanpa awalan model, ChatGPT menjawab seluruh teks');

  // jawaban dengan fence tak ditutup wajib diseimbangkan supaya footer tidak jadi kode
  const ds = await bots.reply({ id: 'bot-ai' }, 'deepseek buat variabel');
  ok(ds.includes('```js\nconst a = 1;\n```') && ds.includes('Balas "menu" untuk memilih model lain.'),
    'AI: blok kode tak seimbang ditutup sebelum footer');

  // ---- bot generik: total 30 bot ----
  ok(bots.BOTS.length === 30, `total bot terdaftar ${bots.BOTS.length} (harus 30)`);

  const gm = await bots.reply({ id: 'bot-cuaca' }, 'menu');
  ok(gm.includes('CUACA') && gm.includes('cuaca <kota>') && gm.includes('Contoh:'),
    'Bot generik: menu rapi (nama, perintah & contoh)');

  const gUnknown = await bots.reply({ id: 'bot-cuaca' }, 'halo');
  ok(/Perintah tidak dikenal/.test(gUnknown) && gUnknown.includes('cuaca <kota>'),
    'Bot generik: perintah tak dikenal ditolak lengkap dengan daftar perintah');

  const gc = await bots.reply({ id: 'bot-cuaca' }, 'cuaca Jakarta');
  ok(gc && typeof gc === 'object' && lastCall().path === '/api/info/cuaca' && lastCall().params.kota === 'Jakarta',
    'Bot generik: argumen dipetakan ke parameter API (kota)');
  ok(gc.text.includes('✅ Cuaca') && gc.text.includes('Kota: Jakarta') && gc.text.includes('```json'),
    'Bot generik: format baris ringkas + blok JSON rapi');

  const kurs = await bots.reply({ id: 'bot-kurs' }, 'kurs USD ke IDR 100');
  ok(lastCall().path === '/api/tools/currency' && lastCall().params.from === 'USD'
    && lastCall().params.to === 'IDR' && lastCall().params.amount === '100',
    'Bot generik: "kurs USD ke IDR 100" dipecah benar (kata "ke" dibuang)');

  const panggilanSebelum = global.__calls.length;
  const jarakKurang = await bots.reply({ id: 'bot-pos' }, 'jarak Jakarta');
  ok(/jarak <dari> <ke>/.test(jarakKurang) && /Contoh: jarak Jakarta Bandung/.test(jarakKurang)
    && global.__calls.length === panggilanSebelum,
    'Bot generik: argumen kurang dibalas blok error tanpa memanggil API');

  const jarak = await bots.reply({ id: 'bot-pos' }, 'jarak Jakarta Bandung');
  ok(jarak.text.includes('Jarak') && jarak.text.includes('Dari kota: Jakarta') && jarak.text.includes('119.63'),
    'Bot generik: objek bersarang (dari/ke) jadi baris "Kunci.sub: nilai"');

  const prov = await bots.reply({ id: 'bot-pos' }, 'provinsi');
  ok(prov.text.includes('Data (2)') && prov.text.includes('• Kode 1 · Nama Bali') && prov.text.includes('```json'),
    'Bot generik: daftar data jadi bullet maks 5 + blok JSON');

  const brat = await bots.reply({ id: 'bot-brat' }, 'brat halo guys');
  ok(brat && typeof brat === 'object' && brat.media && brat.media.type === 'image'
    && brat.media.url.includes('api.brattxt.xyz'),
    'Bot generik: gambar Brat (host tanpa ekstensi) dikirim sebagai pesan gambar');

  const ss = await bots.reply({ id: 'bot-ss' }, 'ss example.com');
  ok(ss && typeof ss === 'object' && lastCall().params.url === 'https://example.com'
    && ss.media && ss.media.url.includes('image.thum.io'),
    'Bot generik: URL tanpa https:// dilengkapi + screenshot jadi media');

  const nomorFail = await bots.reply({ id: 'bot-nomor' }, 'nomor 0812');
  ok(typeof nomorFail === 'string' && /Nomor tidak valid/.test(nomorFail) && !/✅/.test(nomorFail),
    'Bot generik: status:false API dipercikkan sebagai blok error rapi');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
