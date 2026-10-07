'use strict';
/* Unit test balasan bot inti, 3 bot kustom baru & 69 bot total dengan API mock (tanpa jaringan).
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
  // bot generik (69 bot total) — dipetakan langsung ke endpoint api-mazval
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
  // bot baru (15): katalog model, terjemah, IP lookup, OCR
  '/api/mimo/models': { success: true, data: { total: 3, free: 2, premium: 1, providers: 2, models: [
    { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', provider: 'xiaomi', premium: false },
    { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', provider: 'xiaomi', premium: true },
    { id: 'gemma-3', name: 'Gemma 3', provider: 'google', premium: false },
  ] } },
  '/api/tools/translate': { status: true, result: { translation: 'selamat pagi', source: 'en', target: 'id', match: 1 } },
  '/api/tools/ip-lookup': { success: true, data: { ip: '1.1.1.1', country: 'Australia', isp: 'Cloudflare' } },
  '/api/tools/ocr': { success: true, data: { url: 'https://placehold.co/600x200.png?text=Halo+Dunia', text: 'Halo Dunia', confidence: 0.98 } },
  '/api/s/8font': { status: true, result: { fonts: [{ style: 'bold', text: '𝐥𝐨𝐯𝐞' }] } },
  // 2 bot data baru: wilayah Indonesia & simbol provinsi
  '/api/info/wilayah': { success: true, endpoint: '/api/info/wilayah', type: 'provinces',
    data: [{ id: '31', name: 'DKI JAKARTA' }, { id: '32', name: 'JAWA BARAT' },
      { id: '3101', province_id: '31', name: 'KABUPATEN KEPULAUAN SERIBU' },
      { id: '3171011', regency_id: '3171', name: 'MENTENG' }] },
  '/api/info/symbols': { success: true, endpoint: '/api/info/symbols',
    data: [{ title: 'Aceh', url: '/provinces/1/24' }, { title: 'Sumatera Utara', url: '/provinces/2/24' },
      { title: 'Jawa Barat', url: '/provinces/3/24' }] },
  // 4 bot baru: parse NIK (POST), tracking paket, NGL & NGL spam
  '/api/tools/nik': { success: true, creator: 'mazval', endpoint: '/api/tools/nik', data: {
    nik: '3175061509900001', is_valid: true, gender: 'MALE', birth_date: '1990-09-15', age: 36,
    province: { id: '31', name: 'DKI JAKARTA' },
    regency: { id: '3175', name: 'KOTA JAKARTA SELATAN' },
    district: { id: '3175060', name: 'TEBET' } } },
  '/api/tools/tracking': { success: true, creator: 'mazval', endpoint: '/api/tools/tracking', data: {
    tracking_number: 'JNE00123456789', courier: 'jne', status: 'On Process',
    tracking: { expedisi: 'JNE Express',
      perjalanan: [{ tanggal: '2026-10-01', keterangan: 'Dalam pengiriman' }] } } },
  '/api/tools/ngl': { success: true, creator: 'mazval', endpoint: '/api/tools/ngl', data: {
    link: 'https://ngl.link/username', question: 'halo sayang', questionId: '1234567890', terkirim: 1 } },
  '/api/tools/ngl-spam': { success: true, creator: 'mazval', endpoint: '/api/tools/ngl-spam', data: {
    link: 'https://ngl.link/username', pesan: 'halo', terkirim: 5, gagal: 0 } },
};

// 18 bot AI baru (69 bot total): seluruh endpoint diverifikasi terhadap API produksi.
// /api/ai/dolphin-ai sengaja TIDAK dimock -> menguji jalur model cadangan.
const newAiMocks = {
  '/api/ai/bard-google': 'Jawaban Bard.',
  '/api/ai/copilot': 'Jawaban Copilot.',
  '/api/ai/claude-opus': 'Jawaban Claude Opus.',
  '/api/ai/gptoss120b': 'Jawaban GPT-OSS.',
  '/api/ai/gpt': 'Jawaban GPT klasik.',
  '/api/ai/glm47flash': 'Jawaban GLM.',
  '/api/ai/phi2': 'Jawaban Phi-2.',
  '/api/ai/deep-ai': 'Jawaban Deep AI.',
  '/api/ai/publicai': 'Jawaban Public AI.',
  '/api/ai/epsilon-ai': 'Jawaban Epsilon.',
  '/api/ai/powerbrain-ai': 'Jawaban PowerBrain.',
  '/api/ai/jeeves-ai': 'Jawaban Jeeves.',
  '/api/ai/ai-realtime': 'Jawaban realtime.',
  '/api/ai/ai-prompt': 'Prompt: kucing astronot di bulan, gaya ilustrasi.',
  '/api/ai/grammar': 'I go to school.',
  '/api/ai/quillbot': 'Tugas sekolah cepat selesai.',
  '/api/ai/qwq32b': 'Langkah 1: 2400 x 15% = 360.',
  '/api/ai/apertus': 'Jawaban Apertus.',
  '/api/ai/blackbox': 'Jawaban Blackbox.',
  '/api/ai/felo': 'Jawaban Felo.',
  '/api/ai/feloai': 'Jawaban FeloAI.',
  '/api/ai/islam-ai': 'Jawaban Islam AI.',
  '/api/ai/bibleai': 'Jawaban Bible AI.',
  '/api/ai/gita': 'Jawaban Gita AI.',
  // endpoint gambar: jawaban model memuat tautan gambar -> dikirim sebagai pesan gambar
  '/api/ai/image': 'Siap. https://cdn.example/gambar-baru.jpg',
  '/api/ai/fluxai': 'Siap. https://cdn.example/hasil-flux.jpg',
  '/api/ai/nano-banana': 'Siap. https://cdn.example/hasil-banana.jpg',
  '/api/ai/ai-text2img-pro': 'Siap. https://cdn.example/hasil-text2img.jpg',
  '/api/ai/anime-art': 'Siap. https://cdn.example/hasil-anime.jpg',
  '/api/ai/anime-to-real': 'Siap. https://cdn.example/hasil-real.jpg',
  '/api/ai/chibi-sticker': 'Siap. https://cdn.example/hasil-chibi.jpg',
  '/api/ai/bard-img': 'Siap. https://cdn.example/hasil-bardimg.jpg',
};
for (const [p, r] of Object.entries(newAiMocks)) fakeResponses[p] = { result: r };

// endpoint biner (kode PNG codesnap & arsip zip npm2zip) menyiabkan buffer sungguhan
const PNG_MAGIC = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const ZIP_MAGIC = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake-zip-body')]);
const binaryResponses = {
  '/api/image/codesnap': { contentType: 'image/png', filename: 'snippet.png', bytes: PNG_MAGIC },
  '/api/tools/npm2zip': { contentType: 'application/zip', filename: 'left-pad.zip', bytes: ZIP_MAGIC },
};
global.__calls = [];

/* host khusus: provider rantai resolver Downloader (semua dimock, tanpa jaringan) */
const hostHandlers = [
  { // tikwm (TikTok/Douyin)
    match: (u) => u.hostname === 'www.tikwm.com',
    reply: (u) => {
      const target = u.searchParams.get('url') || '';
      if (target.includes('ZS8fallback')) {
        return { ok: true, status: 200, body: { code: 0, data: {
          title: 'TT Contoh', hdplay: 'https://cdn.example/tt-fallback.mp4',
          cover: 'https://cdn.example/tt-cover.jpg', author: { nickname: 'kreatorTT' },
        } } };
      }
      return { ok: true, status: 200, body: { code: -1, msg: 'rate limit tikwm' } };
    },
  },
  { // fxtwitter (X/Twitter)
    match: (u) => u.hostname === 'api.fxtwitter.com',
    reply: (u) => (u.pathname.includes('9876543210123456789')
      ? { ok: true, status: 200, body: { code: 200, tweet: {
          text: 'Video X contoh', author: { screen_name: 'someone' },
          media: { type: 'video', videos: [{ url: 'https://cdn.example/x-video.mp4' }] },
        } } }
      : { ok: true, status: 404, body: { code: 404 } }),
  },
  { // probe tunnel cobalt (tanpa ekstensi -> wajib dikenali dari content-type)
    match: (u) => u.hostname === 'co.otomir23.me' && u.pathname === '/tunnel',
    reply: () => ({
      ok: true, status: 206,
      contentType: 'video/mp4',
      contentDisposition: 'attachment; filename="ig-reel.mp4"',
    }),
  },
  { // api cobalt (POST)
    match: (u) => u.hostname === 'co.otomir23.me' && u.pathname === '/',
    reply: (_u, opts) => {
      let target = '';
      try { target = JSON.parse((opts && opts.body) || '{}').url || ''; } catch { /* body kosong */ }
      if (target.includes('CObaltTunnel9')) {
        return { ok: true, status: 200, body: { status: 'tunnel', url: 'https://co.otomir23.me/tunnel?id=abc123', filename: 'ig-reel.mp4' } };
      }
      return { ok: true, status: 400, body: { status: 'error', error: { code: 'error.api.fetch.empty' } } };
    },
  },
  { // instance Piped (YouTube)
    match: (u) => u.hostname.endsWith('.coffee') || u.hostname.includes('piped'),
    reply: (u) => {
      if (!u.pathname.startsWith('/streams/')) return null;
      const id = decodeURIComponent(u.pathname.split('/').pop());
      if (id === 'pipedtest') {
        return { ok: true, status: 200, body: { title: 'YT Piped', videoStreams: [
          { url: 'https://cdn.example/yt-fallback.mp4', mimeType: 'video/mp4', height: 720, videoOnly: false, quality: '720p' },
        ] } };
      }
      return { ok: true, status: 404, body: { error: 'stream tidak ditemukan' } };
    },
  },
];

const jsonReply = (body) => ({
  ok: true, status: 200,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  global.__calls.push({
    path: u.pathname, host: u.hostname, method: opts.method || 'GET',
    params: Object.fromEntries(u.searchParams),
    body: opts.body ? JSON.parse(opts.body) : undefined,
  });

  for (const h of hostHandlers) {
    if (!h.match(u)) continue;
    const r = h.reply(u, opts);
    if (!r) break;
    if (r.contentType) {
      return {
        ok: r.ok, status: r.status,
        headers: { get: (name) => (
          name === 'content-type' ? r.contentType
            : name === 'content-disposition' ? r.contentDisposition : null
        ) },
        body: undefined,
        json: async () => { throw new Error('bukan JSON'); },
      };
    }
    return jsonReply(r.body);
  }

  const binKey = Object.keys(binaryResponses).find((k) => u.pathname.endsWith(k));
  if (binKey) {
    const bin = binaryResponses[binKey];
    return {
      ok: true, status: 200,
      headers: { get: (h) => (
        h === 'content-type' ? bin.contentType
          : h === 'content-disposition' ? `attachment; filename="${bin.filename}"` : null
      ) },
      arrayBuffer: async () => bin.bytes.buffer.slice(bin.bytes.byteOffset, bin.bytes.byteOffset + bin.bytes.byteLength),
      json: async () => { throw new Error('bukan JSON'); },
    };
  }
  const key = Object.keys(fakeResponses).find((k) => u.pathname.endsWith(k));
  let body = key ? fakeResponses[key] : { success: false, error: 'endpoint tak dikenal: ' + u.pathname };

  // simulasi api-mazval down pada URL tertentu -> menguji rantai resolver
  const target = u.searchParams.get('url') || '';
  if (key === '/api/download/youtube' && target.includes('youtu.be/pipedtest')) body = { success: false, error: 'simulasi api-mazval down' };
  if (key === '/api/download/twitter' && target.includes('status/9876543210123456789')) body = { success: false, error: 'simulasi api-mazval down' };
  if (key === '/api/download/instagram' && target.includes('CObaltTunnel9')) body = { success: false, error: 'simulasi api-mazval down' };

  return jsonReply(body);
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
  const dlMark = global.__calls.length;
  const notTw = await bots.reply({ id: 'bot-down' }, 'https://max.com/video/1');
  const maxCalls = global.__calls.slice(dlMark).filter((c) => c.path.startsWith('/api/download/'));
  ok(maxCalls[0] && maxCalls[0].path === '/api/download/aio' && !/Twitter/i.test(String(notTw)),
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

  // ---- rantai resolver: wajib tetap menghasilkan video walau api-mazval down ----
  const ttFb = await bots.reply({ id: 'bot-down' }, 'https://vt.tiktok.com/ZS8fallback/');
  ok(ttFb && typeof ttFb === 'object' && ttFb.media && ttFb.media.type === 'video'
    && ttFb.media.url === 'https://cdn.example/tt-fallback.mp4'
    && ttFb.text.includes('TT Contoh') && ttFb.text.includes('TikTok'),
    'Downloader: tikwm menyelamatkan TikTok (video muncul walau api-mazval hanya memberi catatan)');

  const xFb = await bots.reply({ id: 'bot-down' }, 'https://x.com/someone/status/9876543210123456789');
  ok(xFb && typeof xFb === 'object' && xFb.media && xFb.media.type === 'video'
    && xFb.media.url === 'https://cdn.example/x-video.mp4'
    && xFb.text.includes('Video X contoh') && xFb.text.includes('@someone'),
    'Downloader: fxtwitter menyelamatkan X/Twitter saat api-mazval down');

  const igFb = await bots.reply({ id: 'bot-down' }, 'https://www.instagram.com/reel/CObaltTunnel9/');
  ok(igFb && typeof igFb === 'object' && igFb.media && igFb.media.type === 'video'
    && igFb.media.url === 'https://co.otomir23.me/tunnel?id=abc123'
    && igFb.media.mime === 'video/mp4' && igFb.media.name === 'ig-reel.mp4',
    'Downloader: cobalt + probe content-type menghasilkan video untuk Instagram');

  const ytFb = await bots.reply({ id: 'bot-down' }, 'https://youtu.be/pipedtest');
  ok(ytFb && typeof ytFb === 'object' && ytFb.media && ytFb.media.type === 'video'
    && ytFb.media.url === 'https://cdn.example/yt-fallback.mp4',
    'Downloader: instance Piped menyelamatkan YouTube saat api-mazval down');

  // platform baru terdeteksi lewat aio (bukan salah petakan ke platform lain)
  const rdMark = global.__calls.length;
  const rd = await bots.reply({ id: 'bot-down' }, 'https://www.reddit.com/r/videos/comments/abc123/title/');
  const rdCalls = global.__calls.slice(rdMark).filter((c) => c.path.startsWith('/api/download/'));
  ok(rdCalls[0] && rdCalls[0].path === '/api/download/aio' && !/Twitter/i.test(String(rd)),
    'Downloader: Reddit terdeteksi lewat aio, bukan salah platform');

  const thMark = global.__calls.length;
  const th = await bots.reply({ id: 'bot-down' }, 'https://www.threads.net/@akun/post/xyz/');
  const thCalls = global.__calls.slice(thMark).filter((c) => c.path.startsWith('/api/download/'));
  ok(thCalls[0] && thCalls[0].path === '/api/download/aio' && !/Twitter/i.test(String(th)),
    'Downloader: Threads terdeteksi lewat aio, bukan salah platform');

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

  // ---- bot generik: total 69 bot (9 inti + 60 generik) ----
  ok(bots.BOTS.length === 69, `total bot terdaftar ${bots.BOTS.length} (harus 69)`);

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

  // cadangan lokal: API eksternal mati -> gambar dibuat langsung di server
  const nodePath = require('path');
  const fsPromises = require('fs').promises;
  const uploadsDir = nodePath.join(__dirname, '..', 'uploads');
  const realFetch = global.fetch;
  const cleanup = [];
  const collect = (r) => { if (r && r.media && typeof r.media.url === 'string' && r.media.url.startsWith('/uploads/')) cleanup.push(r.media.url.slice('/uploads/'.length)); return r; };

  global.fetch = async () => { throw new Error('simulasi: jaringan API mati'); };
  const bratLocal = collect(await bots.reply({ id: 'bot-brat' }, 'brat halo dari lokal'));
  const smemeLocal = collect(await bots.reply({ id: 'bot-brat' }, 'smeme atas|bawah'));
  const bratFail = await bots.reply({ id: 'bot-brat' }, 'brat');
  global.fetch = realFetch;

  ok(bratLocal && typeof bratLocal === 'object' && bratLocal.media && bratLocal.media.type === 'image'
    && bratLocal.media.url.startsWith('/uploads/') && /brattxt/.test(bratLocal.media.url)
    && bratLocal.media.mime === 'image/png',
    'Generator Gambar: API mati -> tetap mengirim gambar PNG lokal (brattxt)');
  ok(smemeLocal && smemeLocal.media && smemeLocal.media.type === 'image'
    && /brattxt-smeme/.test(smemeLocal.media.url),
    'Generator Gambar: smeme juga punya cadangan gambar lokal');
  ok(typeof bratFail === 'string' && /Contoh:/.test(bratFail),
    'Generator Gambar: tanpa teks tetap meminta contoh (bukan gambar kosong)');
  await Promise.all(cleanup.map((f) => fsPromises.unlink(nodePath.join(uploadsDir, f)).catch(() => {})));

  const ss = await bots.reply({ id: 'bot-ss' }, 'ss example.com');
  ok(ss && typeof ss === 'object' && lastCall().params.url === 'https://example.com'
    && ss.media && ss.media.url.includes('image.thum.io'),
    'Bot generik: URL tanpa https:// dilengkapi + screenshot jadi media');

  const nomorFail = await bots.reply({ id: 'bot-nomor' }, 'nomor 0812');
  ok(typeof nomorFail === 'string' && /Nomor tidak valid/.test(nomorFail) && !/✅/.test(nomorFail),
    'Bot generik: status:false API dipercikkan sebagai blok error rapi');

  // ---- 15 bot baru: 3 kustom + 12 generik ----
  const ks = await bots.reply({ id: 'bot-kodesnap' }, 'kode console.log(1)');
  ok(ks && typeof ks === 'object' && ks.media && ks.media.type === 'image'
    && ks.media.cached === true && /^\/uploads\//.test(ks.media.url) && /\.png/.test(ks.media.url)
    && lastCall().path === '/api/image/codesnap',
    'Bot baru: kodesnap merender kode jadi gambar tersimpan');

  const ksErr = await bots.reply({ id: 'bot-kodesnap' }, 'halo');
  ok(typeof ksErr === 'string' && /Perintah tidak dikenal/.test(ksErr),
    'Bot baru: kodesnap menolak perintah asing');

  const nz = await bots.reply({ id: 'bot-npm-zip' }, 'zip left-pad');
  ok(nz && typeof nz === 'object' && nz.media && nz.media.type === 'file'
    && /left-pad/.test(nz.media.name || '') && /\.zip/i.test(nz.media.name || '')
    && nz.media.cached === true && /^\/uploads\//.test(nz.media.url)
    && lastCall().path === '/api/tools/npm2zip' && lastCall().params.package === 'left-pad',
    'Bot baru: npm zip mengunduh source pack jadi berkas tersimpan');

  const callsSebelum = global.__calls.length;
  const nzBad = await bots.reply({ id: 'bot-npm-zip' }, 'zip BAD!');
  ok(typeof nzBad === 'string' && /tidak valid/.test(nzBad)
    && global.__calls.length === callsSebelum,
    'Bot baru: npm zip menolak nama paket tidak valid tanpa memanggil API');

  const ml = await bots.reply({ id: 'bot-model-ai' }, 'daftar');
  ok(typeof ml === 'string' && /Katalog Model AI/.test(ml) && /MiMo V2 Flash/.test(ml)
    && lastCall().path === '/api/mimo/models',
    'Bot baru: katalog model menampilkan daftar model');
  const mlGratis = await bots.reply({ id: 'bot-model-ai' }, 'gratis');
  ok(/Model gratis/.test(mlGratis) && /Gemma 3/.test(mlGratis) && !/MiMo V2 Pro/.test(mlGratis),
    'Bot baru: filter gratis menyembunyikan model premium');

  const tj = await bots.reply({ id: 'bot-terjemah' }, 'terjemah good morning');
  const tjText = typeof tj === 'string' ? tj : tj && tj.text || '';
  ok(/Terjemahan/.test(tjText) && /selamat pagi/.test(tjText)
    && lastCall().path === '/api/tools/translate' && lastCall().params.text === 'good morning',
    'Bot baru: terjemah memetakan argumen ke endpoint translate');

  const ipb = await bots.reply({ id: 'bot-ip' }, 'ip 1.1.1.1');
  const ipText = typeof ipb === 'string' ? ipb : ipb && ipb.text || '';
  ok(/Info IP/.test(ipText) && lastCall().path === '/api/tools/ip-lookup'
    && lastCall().params.ip === '1.1.1.1',
    'Bot baru: cek IP mengirim argumen ke ip-lookup');

  const ocr = await bots.reply({ id: 'bot-ocr' }, 'baca https://placehold.co/600x200.png?text=Halo');
  ok(ocr && typeof ocr === 'object' && ocr.media && ocr.media.type === 'image'
    && lastCall().path === '/api/tools/ocr' && lastCall().params.url.startsWith('https://placehold.co/'),
    'Bot baru: OCR membaca gambar & membalas media');

  const fontMenu = await bots.reply({ id: 'bot-font' }, 'menu');
  ok(/FONT KEREN/i.test(fontMenu) && /font <gaya>/.test(fontMenu),
    'Bot baru: menu Font Keren rapi');

  // ---- 20 bot baru: 18 bot AI + 2 bot data wilayah ----
  const bardMenu = await bots.reply({ id: 'bot-bard' }, 'menu');
  ok(bardMenu.includes('BARD GOOGLE') && bardMenu.includes('bard <pertanyaan>')
    && bardMenu.includes('Contoh:'), 'Bot AI baru: menu Bard Google rapi');

  const bardAsk = await bots.reply({ id: 'bot-bard' }, 'bard apa itu fotosintesis');
  ok(typeof bardAsk === 'string' && bardAsk.includes('🤖 Bard Google') && bardAsk.includes('Jawaban Bard.')
    && bardAsk.includes('Balas "menu" untuk memilih perintah lain.')
    && lastCall().path === '/api/ai/bard-google'
    && lastCall().params.prompt.startsWith('apa itu fotosintesis'),
    'Bot AI baru: awalan perintah dibuang, pertanyaan utuh dikirim ke Bard');

  // tanpa awalan perintah -> teks utuh tetap dijawab bot AI tersebut
  const bardPlain = await bots.reply({ id: 'bot-bard' }, 'halo apa kabar');
  ok(bardPlain.includes('Jawaban Bard.') && lastCall().path === '/api/ai/bard-google'
    && lastCall().params.prompt.startsWith('halo apa kabar'),
    'Bot AI baru: tanpa awalan perintah, seluruh teks jadi pertanyaan');

  const gptKlasik = await bots.reply({ id: 'bot-gpt-klasik' }, 'gpt buat caption');
  ok(gptKlasik.includes('🤖 GPT Klasik') && lastCall().path === '/api/ai/gpt'
    && lastCall().params.prompt.startsWith('buat caption'),
    'Bot AI baru: GPT Klasik memakai endpoint /api/ai/gpt sendiri');

  const studi = await bots.reply({ id: 'bot-studi' }, 'grammar i is go to school');
  ok(studi.includes('🤖 Grammar Checker') && studi.includes('I go to school.')
    && lastCall().path === '/api/ai/grammar',
    'Bot AI baru: AI Studi memilih model sesuai perintah (grammar)');

  // model utama tidak tersedia -> wajib jatuh ke model cadangan dalam bot yang sama
  const cadangan = await bots.reply({ id: 'bot-eksplorasi' }, 'dolphin berapa 1 + 1');
  ok(typeof cadangan === 'string' && /cadangan: Blackbox AI/.test(cadangan)
    && cadangan.includes('Jawaban Blackbox.'),
    'Bot AI baru: model cadangan dijalankan bila model utama gagal');

  // endpoint gambar -> jawaban model berupa tautan dikirim sebagai pesan gambar
  const aiGambar = await bots.reply({ id: 'bot-aigambar' }, 'gambar kucing astronot');
  ok(aiGambar && typeof aiGambar === 'object' && aiGambar.media && aiGambar.media.type === 'image'
    && aiGambar.media.url === 'https://cdn.example/gambar-baru.jpg'
    && lastCall().path === '/api/ai/image'
    && lastCall().params.prompt.startsWith('kucing astronot'),
    'Bot AI baru: AI Gambar mengirim gambar hasil model');

  const agama = await bots.reply({ id: 'bot-aiagama' }, 'islam hukum sedekah');
  ok(typeof agama === 'string' && agama.includes('🤖 Islam AI') && agama.includes('Jawaban Islam AI.')
    && lastCall().path === '/api/ai/islam-ai' && lastCall().params.prompt.startsWith('hukum sedekah'),
    'Bot AI baru: AI Agama memakai endpoint islam-ai & membuang awalan perintah');

  // ---- bot data baru: Wilayah Indonesia & Simbol Provinsi ----
  const wlMenu = await bots.reply({ id: 'bot-wilayah' }, 'menu');
  ok(wlMenu.includes('WILAYAH INDONESIA') && wlMenu.includes('kabupaten <id provinsi>')
    && wlMenu.includes('desa <id kecamatan>'), 'Bot baru: menu Wilayah Indonesia lengkap');

  const wlProv = await bots.reply({ id: 'bot-wilayah' }, 'provinsi');
  ok(wlProv && typeof wlProv === 'object' && lastCall().path === '/api/info/wilayah'
    && lastCall().params.type === 'provinces' && !lastCall().params.id && !lastCall().params.sub,
    'Bot baru: "provinsi" memanggil wilayah?type=provinces');
  ok(wlProv.text.includes('✅ Provinsi') && wlProv.text.includes('DKI JAKARTA')
    && wlProv.text.includes('Data (4)') && wlProv.text.includes('```json'),
    'Bot baru: daftar provinsi tampil ringkas + blok JSON');

  const wlKab = await bots.reply({ id: 'bot-wilayah' }, 'kabupaten 31');
  ok(lastCall().params.type === 'provinces' && lastCall().params.id === '31'
    && lastCall().params.sub === 'regencies' && wlKab.text.includes('Kabupaten / Kota'),
    'Bot baru: "kabupaten 31" memetakan id provinsi + sub regencies');

  const wlKec = await bots.reply({ id: 'bot-wilayah' }, 'kecamatan 3171');
  ok(lastCall().params.type === 'regencies' && lastCall().params.id === '3171'
    && lastCall().params.sub === 'districts' && wlKec.text.includes('Kecamatan'),
    'Bot baru: "kecamatan 3171" memetakan id kabupaten + sub districts');

  const wlDesa = await bots.reply({ id: 'bot-wilayah' }, 'desa 3171011');
  ok(lastCall().params.type === 'districts' && lastCall().params.id === '3171011'
    && lastCall().params.sub === 'villages' && wlDesa.text.includes('Desa / Kelurahan'),
    'Bot baru: "desa 3171011" memetakan id kecamatan + sub villages');

  const wlKurang = await bots.reply({ id: 'bot-wilayah' }, 'kabupaten');
  ok(typeof wlKurang === 'string' && /kabupaten <id provinsi>/.test(wlKurang)
    && /Contoh: kabupaten 31/.test(wlKurang),
    'Bot baru: wilayah menolak perintah tanpa id tanpa memanggil API');

  const symList = await bots.reply({ id: 'bot-simbol' }, 'simbol');
  ok(symList && typeof symList === 'object' && lastCall().path === '/api/info/symbols'
    && !lastCall().params.id && symList.text.includes('Simbol Provinsi')
    && symList.text.includes('Aceh') && symList.text.includes('```json'),
    'Bot baru: "simbol" menampilkan daftar simbol provinsi');

  const symId = await bots.reply({ id: 'bot-simbol' }, 'simbol 3');
  ok(lastCall().params.id === '3' && symId.text.includes('Simbol Provinsi'),
    'Bot baru: "simbol 3" mengirim id provinsi ke API');

  // ---- 4 bot baru: parse NIK (POST), tracking paket, NGL & NGL spam ----
  const nikMenu = await bots.reply({ id: 'bot-nik' }, 'menu');
  ok(nikMenu.includes('PARSE NIK') && nikMenu.includes('nik <16 digit>')
    && nikMenu.includes('nik 3175061509900001'),
    'Bot baru: menu Parse NIK rapi (perintah + contoh)');

  const nikKurang = await bots.reply({ id: 'bot-nik' }, 'nik');
  ok(typeof nikKurang === 'string' && /nik <16 digit>/.test(nikKurang) && !/✅/.test(nikKurang),
    'Bot baru: NIK tanpa nomor diminta contoh tanpa memanggil API');

  const nik = await bots.reply({ id: 'bot-nik' }, 'nik 3175061509900001');
  ok(lastCall().path === '/api/tools/nik' && lastCall().method === 'POST'
    && lastCall().body && lastCall().body.nik === '3175061509900001' && !lastCall().params.nik,
    'Bot baru: NIK dikirim lewat body POST (bukan query string)');
  ok(nik.text.includes('Parse NIK') && nik.text.includes('Gender: MALE')
    && nik.text.includes('Birth date: 1990-09-15') && nik.text.includes('Province name: DKI JAKARTA')
    && nik.text.includes('```json'),
    'Bot baru: hasil parse NIK ditampilkan ringkas + blok JSON');

  const trk = await bots.reply({ id: 'bot-tracking' }, 'resi JNE00123456789');
  ok(lastCall().path === '/api/tools/tracking' && lastCall().params.tracking === 'JNE00123456789'
    && lastCall().params.courier === 'jne',
    'Bot baru: "resi <nomor>" memakai kurir jne bawaan');
  ok(trk.text.includes('Tracking Paket') && trk.text.includes('Status: On Process')
    && trk.text.includes('Dalam pengiriman') && trk.text.includes('```json'),
    'Bot baru: riwayat perjalanan paket tampil ringkas + JSON');

  const trkJnt = await bots.reply({ id: 'bot-tracking' }, 'jnt JT00123456789');
  ok(lastCall().params.courier === 'jnt' && lastCall().params.tracking === 'JT00123456789',
    'Bot baru: "jnt <nomor>" memetakan kurir sesuai perintah');

  const trkKurang = await bots.reply({ id: 'bot-tracking' }, 'resi');
  ok(typeof trkKurang === 'string' && /resi <nomor resi>/.test(trkKurang),
    'Bot baru: tracking tanpa nomor meminta contoh');

  const ngl = await bots.reply({ id: 'bot-ngl' }, 'ngl https://ngl.link/username halo sayang');
  ok(lastCall().path === '/api/tools/ngl' && lastCall().params.link === 'https://ngl.link/username'
    && lastCall().params.text === 'halo sayang',
    'Bot baru: NGL memisahkan link & pesan (pesan multi kata utuh)');
  ok(ngl.text.includes('NGL Terkirim') && ngl.text.includes('QuestionId: 1234567890'),
    'Bot baru: konfirmasi pesan NGL terkirim');

  const nglBare = await bots.reply({ id: 'bot-ngl' }, 'ngl ngl.link/username halo');
  ok(lastCall().params.link === 'https://ngl.link/username',
    'Bot baru: link NGL tanpa https dilengkapi otomatis');

  const nglTanpaPesan = await bots.reply({ id: 'bot-ngl' }, 'ngl https://ngl.link/username');
  ok(typeof nglTanpaPesan === 'string' && /ngl <link NGL> <pesan>/.test(nglTanpaPesan),
    'Bot baru: NGL tanpa pesan ditolak sebelum memanggil API');

  const spam = await bots.reply({ id: 'bot-ngl-spam' }, 'spam https://ngl.link/username halo 7');
  ok(lastCall().path === '/api/tools/ngl-spam' && lastCall().params.link === 'https://ngl.link/username'
    && lastCall().params.pesan === 'halo' && lastCall().params.jumlah === '7',
    'Bot baru: spam mengambil jumlah di ujung pesan');
  ok(spam.text.includes('NGL Spam') && spam.text.includes('Link: https://ngl.link/username'),
    'Bot baru: ringkasan spam NGL tampil');

  const spamDefault = await bots.reply({ id: 'bot-ngl-spam' }, 'spam https://ngl.link/username halo');
  ok(lastCall().params.pesan === 'halo' && lastCall().params.jumlah === '5',
    'Bot baru: spam tanpa jumlah memakai bawaan 5');

  const spamTanpaPesan = await bots.reply({ id: 'bot-ngl-spam' }, 'spam https://ngl.link/username');
  ok(typeof spamTanpaPesan === 'string' && /spam <link> <pesan> \[jumlah\]/.test(spamTanpaPesan),
    'Bot baru: spam tanpa pesan ditolak sebelum memanggil API');

  // katalog daftar bot (menu "Daftar Bot", khusus admin & premium)
  const groups = bots.catalog();
  const katalogIds = groups.flatMap((g) => g.bots.map((b) => b.id));
  ok(Array.isArray(groups) && groups.length >= 6, `katalog punya ${groups.length} kategori`);
  ok(katalogIds.length === bots.BOTS.length,
    `katalog memuat seluruh bot (${katalogIds.length}/${bots.BOTS.length})`);
  ok(new Set(katalogIds).size === katalogIds.length, 'katalog tanpa bot ganda antar kategori');
  ok(bots.BOTS.every((b) => katalogIds.includes(b.id)), 'setiap bot punya kategori di katalog');
  ok(groups.every((g) => g.id && g.label && g.desc && g.bots.length),
    'tiap kategori berlabel, berdeskripsi & berisi bot');
  ok(groups.every((g) => g.bots.every((b) => b.id && b.name && b.about && b.tagline)),
    'tiap entri bot punya id, nama, tagline & deskripsi');
  ok(katalogIds.includes('bot-glm') && katalogIds.includes('bot-wilayah')
    && katalogIds.includes('bot-verif-am'),
    'bot AI, bot data & bot admin ikut katalog');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
