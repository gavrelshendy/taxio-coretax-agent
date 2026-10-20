// Pembetulan NIK BPMP dari terminal (logikanya di automation/bpmp-amend.js; di aplikasi: menu OTOMASI
// "Pembetulan NIK BPMP"). Memakai jendela Chrome PIC yang sudah login + impersonate (port CDP-nya).
//
//   node scripts/bpmp-amend.js --excel "<Mode A1.xlsx>" --port 9741 --npwp 0753828391541000 [--year 2026] [--submit] [--only <NIK lama>]
//
// Tanpa --submit: hanya validasi NIK + pratinjau. Dengan --submit: kirim, lalu pemeriksaan per kolom otomatis.
const path = require('path');
const { chromium } = require('playwright');
const amend = require('../automation/bpmp-amend');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };

(async () => {
    const excel = arg('excel'), port = arg('port'), npwp = arg('npwp'), only = arg('only'), submit = process.argv.includes('--submit');
    if (!excel || !port || !npwp) throw new Error('Pakai: --excel <file> --port <port CDP PIC> --npwp <NPWP entitas> [--year <tahun>] [--submit] [--only <NIK lama>]');
    const { targets, skipped, year: excelYear } = await amend.readTargets(excel);
    const year = arg('year', excelYear);
    if (!year) throw new Error('Tahun tidak terbaca dari Excel - isi --year.');
    skipped.forEach((s) => console.log('LEWATI ' + s));
    const list = only ? targets.filter((t) => t.old === only) : targets;
    console.log('Isian NIK Baru di Excel: ' + targets.length + (only ? ' (dipilih ' + list.length + ')' : '') + ' · tahun ' + year + ' · mode ' + (submit ? 'KIRIM' : 'UJI (tanpa simpan)'));
    const outDir = path.join(path.dirname(excel), 'Pembetulan NIK BPMP', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    const context = (await chromium.connectOverCDP('http://127.0.0.1:' + port)).contexts()[0];
    const results = await amend.run({ context, npwp, targets: list, year, submit, outDir, emit: console.log });
    console.log('Selesai: ' + results.length + ' bukti potong · cadangan + hasil.json di ' + outDir);
    if (submit && results.some((r) => r.status === 'DIBETULKAN')) {
        const { ok, bad } = await amend.check({ context, npwp, dirs: [outDir], emit: console.log });
        console.log('Pemeriksaan ulang: ' + ok + ' benar, ' + bad + ' bermasalah.');
        const periods = [...new Set(results.filter((r) => r.status === 'DIBETULKAN').map((r) => r.period.slice(0, 2)))];
        console.log('SPT Masa PPh 21 yang perlu pembetulan: masa ' + periods.join(', ') + '/' + year);
    }
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
