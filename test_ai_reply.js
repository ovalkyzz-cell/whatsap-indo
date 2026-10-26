const { reply, byId } = require('./server/bots');

async function test() {
  console.log('Testing Bot AI Reply via reply() (Tanpa API Key)...');
  
  // Ambil bot AI
  const botAi = { id: 'bot-ai', name: 'AI', email: 'ai@bot.rtc-core' };
  
  try {
    const response = await reply(botAi, 'gpt apa itu AI?');
    console.log('=' .repeat(50));
    console.log('RESPON BOT AI:');
    console.log('=' .repeat(50));
    console.log(response);
    console.log('=' .repeat(50));
    
    if (response && response.length > 20) {
      console.log('✅ AI BERHASIL MERESPON (Tanpa API Key)!');
    } else {
      console.log('❌ AI Gagal merespon');
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
}

test();
