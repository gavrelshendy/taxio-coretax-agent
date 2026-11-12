/* Taxio Pilot - mode TANPA JENDELA di `node` biasa (smoke run, pengembangan, tes).
 * Aplikasi desktop yang dipakai pengguna adalah electron/main.js (`npm start`, installer `npm run build`);
 * keduanya menjalankan inti yang sama (lib/app.js: migrasi, sesi, server dashboard, runtime.json,
 * pemeriksaan sistem). Di sini tidak ada jendela, tray, protokol taxio-coretax://, update, maupun enkripsi
 * rahasia (lib/shell.js versi headless) - dashboard bisa dibuka di browser lewat URL /?t=<token> dari
 * runtime.json.
 *
 * TAXIO_PILOT_SMOKE=1 (smoke run pengembang, SELALU bersama TAXIO_PILOT_DATA_DIR=<folder sementara>):
 * seperti di atas, ditambah tidak mengunduh / memanaskan Chrome bawaan. Hentikan dengan POST /api/quit
 * (Bearer token dari runtime.json). Contoh (PowerShell):
 *   $env:TAXIO_PILOT_DATA_DIR="$env:TEMP\tp-smoke"; $env:TAXIO_PILOT_SMOKE='1'; $env:TAXIO_PILOT_PORT='0'; node main.js */

// Every Chrome launch uses either the bundled Chrome for Testing (lib/browser.js, explicit
// executablePath) or channel:'chrome' (the machine's own Chrome) - Playwright's own downloaded
// browsers are NEVER used. Without this, require('playwright') runs its browsers-cache validation and
// prints a "npx playwright install" banner on machines that never ran it (confirmed live 2026-08-18).
// MUST be set before the first require('playwright'|'playwright-core') anywhere in the process.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

// Belt & suspenders: a long-running server process - an unhandled rejection anywhere (Node 15+
// terminates on these by default) or a stray uncaught exception must never silently kill the dashboard
// server. Log it and keep running instead.
process.on('unhandledRejection', (reason) => {
    try { require('./lib/log').log('Unhandled promise rejection (diabaikan, proses tetap jalan): ' + (reason && reason.stack || reason)); } catch (e) { console.error(reason); }
});
process.on('uncaughtException', (err) => {
    try { require('./lib/log').log('Uncaught exception (diabaikan, proses tetap jalan): ' + (err && err.stack || err)); } catch (e) { console.error(err); }
});

const SMOKE = process.env.TAXIO_PILOT_SMOKE === '1';
if (SMOKE && !process.env.TAXIO_PILOT_DATA_DIR) {
    // A smoke run must never migrate / read the real data of this PC.
    console.error('TAXIO_PILOT_SMOKE=1 butuh TAXIO_PILOT_DATA_DIR=<folder sementara>.');
    process.exit(2);
}

const { log } = require('./lib/log');
const app = require('./lib/app');

app.start({ smoke: SMOKE, banner: SMOKE ? '[SMOKE: tanpa jendela/tray/update/Chrome bawaan]' : '[tanpa jendela - aplikasi desktop: npm start]' }).then((started) => {
    if (started.primary) {
        log('Taxio Pilot sudah berjalan di port ' + started.primary.port + ' - proses ini berhenti.');
        process.exit(0);
    }
    if (!SMOKE) require('./lib/browser').ensure();
}).catch((e) => {
    log('Fatal error saat memulai: ' + (e.stack || e.message));
    console.error('Taxio Pilot gagal memulai: ' + e.message);
    process.exit(1);
});
