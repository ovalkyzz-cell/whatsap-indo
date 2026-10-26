const { freeAiAsk } = require('./server/bots');

async function test() {
  console.log('Testing API Mazval Tanpa Key (AI ChatGPT)...');
  
  const start = Date.now();
  try {
    const answer = await freeAiAsk('Halo, apa kabar?', 15000);
    const elapsed = Date.now() - start;
    
    console.log(`Waktu: ${elapsed}ms`);
    
    if (answer) {
      console.log('✅ Jawaban diterima:');
      console.log(answer.substring(0, 200) + '...');
    } else {
      console.log('❌ Tidak ada jawaban (timeout/rate limit)');
    }
  } catch (e) {
    console.log(`❌ Error: ${e.message}`);
  }
}

test();
