'use strict';
/* Uji lapisan ICE/kualitas panggilan.
   [S] server/ice.js — murni, tanpa server: urutan sumber, fallback STUN,
       cache & kegagalan REST Metered yang TIDAK boleh menjatuhkan panggilan.
   [K] fungsi murni klien (public/js/app.js) dimuat di DOM sungguhan (jsdom):
       klasifikasi kualitas, ringkasan getStats, batas bitrate, pemulihan ICE.
   Bisa dijalankan sendiri (node test/iceconfig.js). */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ice = require('../server/ice');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
};

const ICE_ENV = ['CALL_TURN', 'TURN_URL', 'TURN_USER', 'TURN_PASS', 'TURN_ICE_JSON',
  'METERED_API_KEY', 'METERED_APP', 'METERED_CRED_URL'];

function clearIceEnv() {
  for (const k of ICE_ENV) delete process.env[k];
  ice.resetCache();
}

/* ---------- [S] server/ice.js ---------- */
async function serverTests() {
  console.log('\n[S1] Tanpa pengaturan -> STUN saja (perilaku lama)');
  clearIceEnv();
  let cfg = await ice.buildIceConfig();
  ok(cfg.turn === false && cfg.source === 'stun', `sumber '${cfg.source}' tanpa env TURN`);
  ok(cfg.iceServers.length >= 4, `daftar STUN tetap ada (${cfg.iceServers.length} entri)`);
  ok(cfg.iceServers.every((s) => s && s.urls), 'setiap entri punya urls');

  console.log('\n[S2] CALL_TURN=off mematikan TURN walau kunci terisi');
  process.env.CALL_TURN = 'off';
  process.env.METERED_API_KEY = 'abc123';
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === false && cfg.source === 'stun-off', `sumber '${cfg.source}' saat CALL_TURN=off`);
  delete process.env.CALL_TURN;
  delete process.env.METERED_API_KEY;
  ice.resetCache();

  console.log('\n[S3] TURN_URL statis (boleh lebih dari satu URL)');
  process.env.TURN_URL = 'turn:global.relay.metered.ca:80, turns:global.relay.metered.ca:443?transport=tcp';
  process.env.TURN_USER = 'user-tes';
  process.env.TURN_PASS = 'pass-tes';
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === true && cfg.source === 'static', `sumber '${cfg.source}' untuk TURN_URL`);
  const staticTurn = cfg.iceServers.filter((s) => String(s.urls).includes('relay.metered.ca'));
  ok(staticTurn.length === 2, `dua URL TURN dipakai (${staticTurn.length})`);
  ok(staticTurn.every((s) => s.username === 'user-tes' && s.credential === 'pass-tes'), 'username/password ikut terbawa');
  ok(cfg.iceServers.some((s) => String(s.urls).includes('stun')), 'STUN tetap disertakan bersama TURN');

  console.log('\n[S4] TURN_ICE_JSON (array penuh dari dashboard)');
  clearIceEnv();
  process.env.TURN_ICE_JSON = JSON.stringify([
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'u', credential: 'p' },
  ]);
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === true && cfg.source === 'static-json', `sumber '${cfg.source}' untuk TURN_ICE_JSON`);
  ok(cfg.iceServers.some((s) => String(s.urls).includes('turn:global.relay.metered.ca:80')), 'kredensial dari dashboard terpakai');
  ok(cfg.iceServers.some((s) => String(s.urls).includes('stun.l.google.com')), 'STUN bawaan tidak hilang');

  console.log('\n[S5] Data rusak diabaikan, panggilan tetap jalan');
  clearIceEnv();
  process.env.TURN_ICE_JSON = '{bukan json';
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === false && cfg.source === 'stun', `JSON rusak -> jatuh ke STUN ('${cfg.source}')`);
  clearIceEnv();
  ice.resetCache();

  console.log('\n[S6] REST Metered berhasil -> TURN aktif + di-cache');
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:global.relay.metered.ca:80', username: 'u1', credential: 'p1' },
        { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'u1', credential: 'p1' },
      ],
    };
  };
  process.env.METERED_API_KEY = 'kunci-tes';
  process.env.METERED_APP = 'mazval-grenk';
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === true && cfg.source === 'metered', `sumber '${cfg.source}' setelah REST sukses`);
  ok(cfg.iceServers.some((s) => String(s.urls).includes('turn:')), 'entri TURN dari respons ada');
  await ice.buildIceConfig();
  await ice.buildIceConfig();
  ok(calls === 1, `kredensial di-cache (REST dipanggil ${calls} kali, bukan 3)`);

  console.log('\n[S7] REST gagal -> jatuh ke STUN, TANPA exception');
  clearIceEnv();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  process.env.METERED_API_KEY = 'kunci-tes';
  process.env.METERED_APP = 'mazval-grenk';
  ice.resetCache();
  let threw = false;
  try { cfg = await ice.buildIceConfig(); } catch { threw = true; }
  ok(!threw, 'kegagalan REST tidak melempar exception');
  ok(cfg && cfg.turn === false && cfg.source === 'stun-fallback', `jatuh ke STUN ('${cfg && cfg.source}')`);
  ok(cfg.iceServers.length >= 4, 'daftar STUN tetap lengkap');

  console.log('\n[S8] Respons REST bukan daftar iceServers ditolak');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ oops: true }) });
  ice.resetCache();
  cfg = await ice.buildIceConfig();
  ok(cfg.turn === false && cfg.source === 'stun-fallback', `respons aneh ditolak ('${cfg.source}')`);

  console.log('\n[S9] URL REST terbentuk benar dari METERED_APP');
  clearIceEnv();
  process.env.METERED_API_KEY = 'kunci-tes';
  process.env.METERED_APP = 'mazval-grenk';
  const u = ice.meteredUrl();
  ok(u === 'https://mazval-grenk.metered.live/api/v1/turn/credentials?apiKey=kunci-tes', `URL: ${u}`);

  console.log('\n[S10] parseIceJson menyaring entri cacat');
  const parsed = ice.parseIceJson(JSON.stringify([
    { urls: 'turn:x:80', username: 'a', credential: 'b' },
    { urls: '' },
    null,
    { notUrls: true },
    { urls: ['turn:y:80'] },
  ]));
  ok(Array.isArray(parsed) && parsed.length === 2, `hanya entri valid yang lolos (${parsed ? parsed.length : 0})`);
  ok(ice.parseIceJson('bukan-json') === null, 'string bukan JSON -> null');
  ok(ice.parseIceJson('{"a":1}') === null, 'bukan array -> null');

  global.fetch = realFetch;
  clearIceEnv();
}

/* ---------- [K] fungsi murni klien ---------- */
async function clientTests() {
  /* app.js dijalankan sebagai <script> sungguhan (bukan eval): mode ketat di
     dalam eval menjaga deklarasi tetap lokal, sehingga fungsi murni tidak
     akan pernah muncul di window. Galat tak tertangkap selama eksekusi
     ditangkap virtualConsole supaya K1 bisa benar-benar memantaunya. */
  const loadErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => loadErrors.push(e.message || String(e)));

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || (() => {});
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
  }
  window.io = () => ({ on() {}, off() {}, emit() {}, disconnect() {}, connected: false });

  const script = window.document.createElement('script');
  script.textContent = appSrc;
  window.document.body.appendChild(script);

  console.log('\n[K1] app.js dimuat di DOM nyata tanpa exception');
  const loadError = loadErrors.length ? loadErrors : null;
  ok(!loadError, loadError ? 'app.js MELEMPAR: ' + loadError.join(' | ') : 'app.js dimuat penuh');

  const w = window;
  ok(typeof w.classifyQuality === 'function', 'classifyQuality tersedia');
  ok(typeof w.summarizeCallStats === 'function', 'summarizeCallStats tersedia');
  ok(typeof w.statsList === 'function', 'statsList tersedia');
  ok(typeof w.applyVideoBitrate === 'function', 'applyVideoBitrate tersedia');
  ok(typeof w.tryIceRestart === 'function', 'tryIceRestart tersedia');
  ok(typeof w.getIceConfig === 'function', 'getIceConfig tersedia');
  if (loadError) return;

  console.log('\n[K2] Klasifikasi kualitas');
  ok(w.classifyQuality({ rttMs: 40, lossPct: 0.2 }) === 'good', 'RTT 40ms / loss 0.2% -> good');
  ok(w.classifyQuality({ rttMs: 200, lossPct: 3 }) === 'mid', 'RTT 200ms / loss 3% -> mid');
  ok(w.classifyQuality({ rttMs: 600, lossPct: 1 }) === 'weak', 'RTT 600ms -> weak');
  ok(w.classifyQuality({ rttMs: 50, lossPct: 12 }) === 'weak', 'loss 12% -> weak');
  ok(w.classifyQuality({}) === 'unknown', 'tanpa data -> unknown');
  ok(w.classifyQuality(null) === 'unknown', 'null -> unknown');

  console.log('\n[K3] statsList menerima Map maupun array');
  const mapLike = new Map([['a', { type: 'x' }], ['b', { type: 'y' }]]);
  ok(w.statsList(mapLike).length === 2, 'Map (gaya RTCStatsReport) -> 2 entri');
  ok(w.statsList([{ type: 'x' }]).length === 1, 'array -> 1 entri');
  ok(w.statsList(null).length === 0, 'null -> kosong');
  ok(w.statsList({ notIterable: true }).length === 0, 'obyek acak -> kosong');

  console.log('\n[K4] Ringkasan getStats (RTT, loss, bitrate)');
  const report = [
    { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.12 },
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 980, packetsLost: 20 },
    { type: 'outbound-rtp', kind: 'video', packetsSent: 1000, bytesSent: 1000, targetBitrate: 1500000 },
    { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 10 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 9999, packetsLost: 0 },
  ];
  const sum = w.summarizeCallStats(report);
  ok(sum.rttMs === 120, `RTT dibulatkan ke ms (${sum.rttMs})`);
  ok(sum.lossPct === 2, `loss gabungan = 2% (${sum.lossPct})`);
  ok(sum.outKbps === 1500, `targetBitrate -> kbps (${sum.outKbps})`);
  const empty = w.summarizeCallStats([]);
  ok(empty.rttMs === null && empty.lossPct === null, 'laporan kosong -> null (bukan 0 palsu)');
  ok(w.classifyQuality(empty) === 'unknown', 'laporan kosong -> kualitas unknown');

  console.log('\n[K5] Batas bitrate diterapkan ke pengirim video');
  let applied = null;
  const fakeSender = {
    track: { kind: 'video' },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (p) => { applied = p; },
  };
  const audioSender = {
    track: { kind: 'audio' },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async () => { throw new Error('audio tak boleh disentuh'); },
  };
  await w.applyVideoBitrate({ getSenders: () => [audioSender, fakeSender] }, 500);
  ok(applied && applied.encodings[0].maxBitrate === 500000, `maxBitrate 500 kbps -> ${applied && applied.encodings[0].maxBitrate}`);
  // browser tanpa setParameters tidak boleh melempar
  const legacy = { track: { kind: 'video' } };
  let legacyThrew = false;
  try { await w.applyVideoBitrate({ getSenders: () => [legacy] }, 1000); } catch { legacyThrew = true; }
  ok(!legacyThrew, 'pengirim tanpa setParameters dibiarkan tanpa error');
  let noPcThrew = false;
  try { await w.applyVideoBitrate(null, 1000); } catch { noPcThrew = true; }
  ok(!noPcThrew, 'pc null -> diam-diam kembali');

  console.log('\n[K6] Pemulihan ICE: maks 3 percobaan, penerima tak memulai');
  const rec = { restarts: 0, offers: 0, cfg: null };
  const pc = {
    restartIce() { rec.restarts += 1; },
    createOffer: async () => { rec.offers += 1; return { type: 'offer', sdp: 'v=0' }; },
    setLocalDescription: async (o) => { pc.localDescription = o; },
    setConfiguration: (c) => { rec.cfg = c; },
  };
  const mkCall = (incoming) => ({
    incoming, iceAttempts: 0, iceRestarted: false, iceLastRecover: null,
    peer: { id: 'peer-1' }, callId: 'call-1',
  });
  // pasang lingkungan global yang dibutuhkan tryIceRestart
  const setup = `window.__call = null; window.__pc = null;
    S.call = null; S.socket = { emit(){} };`;
  try {
    w.eval(setup);
    w.__call = mkCall(false);
    w.__pc = pc;
    const r1 = w.eval('tryIceRestart(__call, __pc)');
    ok(r1 === true && w.__call.iceAttempts === 1, 'percobaan pertama diterima (attempts=1)');
    // penanda waktu mencegah percobaan ganda dalam 3 detik
    const rDup = w.eval('tryIceRestart(__call, __pc)');
    ok(rDup === true && w.__call.iceAttempts === 1, 'kegagalan berulang <3 dtk tak membakar percobaan');
    w.__call.iceLastRecover = 0;
    w.eval('tryIceRestart(__call, __pc)');
    w.__call.iceLastRecover = 0;
    const r3 = w.eval('tryIceRestart(__call, __pc)');
    ok(r3 === true && w.__call.iceAttempts === 3, 'percobaan ketiga masih diterima (attempts=3)');
    w.__call.iceLastRecover = 0;
    const r4 = w.eval('tryIceRestart(__call, __pc)');
    ok(r4 === false && w.__call.iceAttempts === 3, 'percobaan keempat ditolak (batas 3)');

    const inc = mkCall(true);
    w.__call = inc;
    w.__call.iceLastRecover = 0;
    ok(w.eval('tryIceRestart(__call, __pc)') === false, 'penerima panggilan tak memulai offer (anti-glare)');
    ok(inc.iceAttempts === 0, 'percobaan penerima tidak dihitung');
  } catch (e) {
    ok(false, 'pengujian tryIceRestart gagal dijalankan: ' + e.message);
  }

  console.log('\n[K7] Percobaan ketiga memaksa jalur relay bila TURN tersedia');
  try {
    w.eval('iceCache.turn = true');
    const c = mkCall(false);
    c.iceAttempts = 2;
    c.iceLastRecover = 0;
    w.__call = c;
    w.__pc = pc;
    w.eval('tryIceRestart(__call, __pc)');
    ok(c.iceAttempts === 3, 'percobaan ketiga tercatat');
    ok(rec.cfg && rec.cfg.iceTransportPolicy === 'relay', `setConfiguration dipanggil dengan relay (${rec.cfg && JSON.stringify(rec.cfg)})`);
    w.eval('iceCache.turn = false');
    const c2 = mkCall(false);
    c2.iceAttempts = 2;
    c2.iceLastRecover = 0;
    w.__call = c2;
    const before = rec.cfg;
    w.eval('tryIceRestart(__call, __pc)');
    ok(rec.cfg === before, 'tanpa TURN, kebijakan relay tidak dipaksakan');
  } catch (e) {
    ok(false, 'pengujian jalur relay gagal: ' + e.message);
  }

  console.log('\n[K8] getIceConfig jatuh ke STUN lokal bila server tak terjangkau');
  try {
    w.eval('iceCache.cfg = null; iceCache.at = 0; iceCache.ok = false; iceCache.inflight = null;');
    // tanpa fetch di jsdom -> pasti gagal -> wajib kembali ke ICE_LOCAL, bukan lempar
    const cfg = await w.getIceConfig(true);
    ok(cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0, 'mengembalikan daftar ICE meski fetch gagal');
    ok(cfg.iceServers.some((s) => String(s.urls).includes('stun')), 'isi tetap STUN (cadangan lokal)');
  } catch (e) {
    ok(false, 'getIceConfig melempar saat gagal: ' + e.message);
  }

  console.log('\n[K9] Indikator kualitas ada di markup & CSS');
  ok(html.includes('id="callQuality"'), '#callQuality ada di index.html');
  ok(html.includes('id="callTimer"'), '#callTimer tidak hilang dari header');
  const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
  ok(css.includes('.call-quality.q-good') && css.includes('.call-quality.q-weak'), 'kelas q-good/q-weak ada di CSS');
  ok(css.includes('.call-head-right'), 'kelas wadah .call-head-right ada di CSS');
}

async function main() {
  await serverTests();
  await clientTests();
  console.log(`\n==== HASIL UJI ICE/KUALITAS: ${pass} lulus, ${fail} gagal ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ICE TEST CRASH:', e); process.exit(2); });
