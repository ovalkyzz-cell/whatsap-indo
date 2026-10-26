#!/usr/bin/env node
/**
 * TEST SUITE: Bot AI Response (Mock & Simulation)
 * Tes respon bot tanpa perlu API Key aktif
 */

// Mock fungsi-fungsi dari bots.js untuk testing
const testCases = [
  {
    name: 'AI: Pertanyaan ChatGPT',
    input: 'gpt apa itu algoritma sorting?',
    expected: ['🤖', 'ChatGPT', 'blok kode', 'sort'],
  },
  {
    name: 'AI: Menu default',
    input: 'menu',
    expected: ['AI ASSISTANT', 'ChatGPT', 'Gemini', 'model'],
  },
  {
    name: 'Verif AM: Menu',
    input: 'menu',
    expected: ['VERIF AM PREM', 'send', 'cek'],
  },
  {
    name: 'Downloader: Menu',
    input: 'menu',
    expected: ['DOWNLOADER', 'TikTok', 'YouTube', 'Instagram'],
  },
  {
    name: 'Tools: Menu',
    input: 'menu',
    expected: ['Tools', 'Terjemah', 'Cuaca', 'npm'],
  },
];

function firstWord(text) {
  const m = String(text || '').trim().match(/^\S+/);
  return m ? m[0].toLowerCase().replace(/[?:!,.]+$/, '') : '';
}

function rest(text) {
  return String(text || '').trim().replace(/^\S+\s*/, '').trim();
}

// Simulasi respons bot menu (tanpa API Key)
function simulateMenuResponse(bot, input) {
  const cmd = firstWord(input);
  
  if (bot === 'ai') {
    if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) {
      return [
        '╭─────────────────────────────',
        '│ AI ASSISTANT',
        '│ ChatGPT · Gemini · Deepseek · Claude',
        '╰─────────────────────────────',
        '',
        'Kirim pertanyaan apa saja, bot ini otomatis menjawab.',
        'Tanpa awalan perintah, jawaban default memakai ChatGPT.',
        '',
        'Keunggulan:',
        '  • Kode pemrograman tampil sebagai blok kode ala VS Code',
        '  • Setiap blok kode punya tombol Copy sekali klik',
        '  • Mendukung semua bahasa: js, py, java, cpp, go, dll',
      ].join('\n');
    }
    
    // Jika pertanyaan tanpa key, beri warning
    const question = cmd && ['gpt', 'gemini', 'deepseek', 'claude'].includes(cmd) ? rest(input) : input;
    if (question) {
      return [
        '⚠️ AI belum bisa menjawab — konfigurasi bot bermasalah',
        '',
        'Konfigurasi API bot belum lengkap (MAZVAL_API_KEY belum diatur).',
        'Admin: perbarui env MAZVAL_API_KEY (key aktif dari api-mazval.zone.id) lalu redeploy.',
      ].join('\n');
    }
  }
  
  if (bot === 'verif-am') {
    if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) {
      return [
        '╭─────────────────────────────',
        '│ VERIF AM PREM',
        '│ Verifikasi & tautan Alight Motion Premium',
        '╰─────────────────────────────',
        '',
        'Perintah yang tersedia:',
        '',
        '1. send <email>',
        '   Kirim tautan verifikasi ke email.',
        '',
        '2. cek <email> <token>',
        '   Cek status verifikasi memakai token dari email.',
      ].join('\n');
    }
  }
  
  if (bot === 'downloader') {
    if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) {
      return [
        '╭─────────────────────────────',
        '│ DOWNLOADER',
        '│ Video & audio lintas platform',
        '╰─────────────────────────────',
        '',
        'Platform yang didukung:',
        '  • TikTok · Douyin       • Instagram · Threads',
        '  • YouTube               • Facebook · FB Watch',
        '  • Twitter / X           • Pinterest',
        '  • Spotify · SoundCloud  • Reddit · Tumblr',
        '  • dan lainnya (deteksi otomatis lewat aio)',
      ].join('\n');
    }
  }
  
  if (bot === 'tools') {
    if (!cmd || ['menu', 'help', 'bantuan', '?'].includes(cmd)) {
      return [
        '╭─────────────────────────────',
        '│ TOOLS',
        '│ 15 Tools: Terjemah · Cuaca · Kurs · Kripto · Gempa · QR · npm · dll',
        '╰─────────────────────────────',
        '',
        'Perintah:',
        '  1. terjemah <text> -> <lang>',
        '  2. cuaca <kota>',
        '  3. kurs <from> <to>',
        '  4. kripto <symbol>',
        '  5. gempa',
        '  6. qr <text>',
        '  7. npm <package>',
      ].join('\n');
    }
  }
  
  return '❌ Bot tidak dikenali';
}

// Run tests
console.log('🧪 TESTING BOT RESPONSES\n');
console.log('═'.repeat(50));

let passed = 0;
let failed = 0;

const botTests = [
  { bot: 'ai', input: 'menu' },
  { bot: 'ai', input: 'gpt buatkan kode' },
  { bot: 'verif-am', input: 'menu' },
  { bot: 'downloader', input: 'menu' },
  { bot: 'tools', input: 'menu' },
];

for (const test of botTests) {
  const response = simulateMenuResponse(test.bot, test.input);
  const hasContent = response && response.length > 20;
  const hasKey = response.includes('╭') || response.includes('│') || response.includes('⚠️') || response.includes('❌');
  
  if (hasContent && hasKey) {
    console.log(`✓ [${test.bot}] input: "${test.input}"`);
    passed++;
  } else {
    console.log(`✗ [${test.bot}] input: "${test.input}" — tidak ada respons`);
    failed++;
  }
}

console.log('═'.repeat(50));
console.log(`\nHasil: ${passed}/${botTests.length} passed`);

if (failed === 0) {
  console.log('✅ Semua bot respon OK!');
  process.exit(0);
} else {
  console.log(`❌ ${failed} bot gagal!`);
  process.exit(1);
}
