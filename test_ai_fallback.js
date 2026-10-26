const { aiReply } = require('./server/bots');

async function test() {
  console.log('Testing AI Reply (Tanpa API Key)...');
  const response = await aiReply('gpt apa itu AI?');
  console.log('Respon:', response);
  if (response.includes('AI Gratis')) {
      console.log('✅ Sukses fallback ke AI Gratis');
  } else {
      console.log('❌ Gagal fallback');
  }
}

test();
