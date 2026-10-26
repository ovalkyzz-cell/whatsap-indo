const crypto = require('crypto');
// Simulasi pengecekan koneksi ke api-mazval tanpa menampilkan API Key
const BASE = process.env.MAZVAL_API_BASE || 'https://api-mazval.zone.id';
const API_KEY = process.env.MAZVAL_API_KEY || 'MISSING';

async function testConnection() {
  console.log(`Testing connection to: ${BASE}`);
  if (API_KEY === 'MISSING') {
    console.error('Error: MAZVAL_API_KEY not set in environment.');
    process.exit(1);
  }
  
  try {
    // Probe endpoint yang aman/publik untuk tes koneksi
    const url = `${BASE}/api/tools/models?apikey=${API_KEY}`;
    const res = await fetch(url, { timeout: 10000 });
    
    if (res.status === 200) {
      console.log('✓ Koneksi API berhasil!');
    } else if (res.status === 401 || res.status === 403) {
      console.error('✗ Gagal: API Key tidak valid (401/403).');
    } else {
      console.error(`✗ Gagal dengan status: ${res.status}`);
    }
  } catch (e) {
    console.error(`✗ Koneksi gagal: ${e.message}`);
  }
}

testConnection();
