// Pemeriksaan independen hasil pembetulan NIK BPMP (hanya membaca; logika di automation/bpmp-amend.js check()).
//
//   node scripts/bpmp-amend-check.js --port 9741 --npwp 0753828391541000 --dir "<Pembetulan NIK BPMP>" [--dir ...]
const { chromium } = require('playwright');
const amend = require('../automation/bpmp-amend');
const args = (name) => process.argv.flatMap((a, i) => a === '--' + name ? [process.argv[i + 1]] : []);

(async () => {
    const [port] = args('port'), [npwp] = args('npwp'), dirs = args('dir');
    if (!port || !npwp || !dirs.length) throw new Error('Pakai: --port <port> --npwp <NPWP> --dir <folder> [--dir ...]');
    const context = (await chromium.connectOverCDP('http://127.0.0.1:' + port)).contexts()[0];
    const { ok, bad } = await amend.check({ context, npwp, dirs, emit: console.log });
    console.log('Hasil: ' + ok + ' benar, ' + bad + ' bermasalah.');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
