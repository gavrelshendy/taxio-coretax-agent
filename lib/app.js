/* Taxio Pilot - urutan start INTI, dipakai dua pintu masuk:
 *   electron/main.js  aplikasi desktop (jendela, tray, protokol taxio-coretax://, update) - `npm start`
 *   main.js           mode tanpa jendela di `node` biasa: smoke run / pengembangan / tes
 *
 * Urutan (jangan dibalik):
 *   1. migrasi folder data lama ke %LOCALAPPDATA%\TaxioPilot (lib/paths.js) - SEBELUM apa pun membaca data;
 *   2. bersihkan transit unduhan, lalu enkripsi berkas rahasia yang masih plaintext (lib/secrets.js; hanya
 *      bila shell punya enkripsi - jadi shell Electron harus sudah terdaftar sebelum start()). Sinkron dan
 *      SEBELUM pemulihan sesi dimulai, jadi tidak pernah bertabrakan dengan refresh token yang menulis
 *      session.json (pemulihan membaca berkas terenkripsi maupun plaintext sama baiknya);
 *   3. server dashboard (port 51733 atau port bebas, token per peluncuran - lib/runtime.js), runtime.json;
 *   4. DI LATAR (start() tidak menunggunya - audit 2026-11-12: PC lambat / offline dulu terlihat "tidak mau
 *      terbuka"): pulihkan sesi Taxio tersimpan (lib/session-restore.js: /api/session melaporkan
 *      "memulihkan", jaringan putus = sesi dipertahankan dan dicoba lagi), penyegar token Taxio Hub
 *      (lib/hub-refresher.js), dan pemeriksaan sistem (hanya baris bermasalah yang dicatat).
 * Jendela, tray, protokol, Chrome bawaan dan update diurus pemanggil SESUDAH start() selesai.
 *
 * Variabel lingkungan: TAXIO_PILOT_PORT (port pilihan, 0 = bebas), TAXIO_PILOT_STARTUP_HEALTH=0 (lewati
 * pemeriksaan sistem saat start), TAXIO_PILOT_SMOKE / TAXIO_PILOT_DATA_DIR (lihat main.js, electron/main.js). */
const { log } = require('./log');
const paths = require('./paths');
const runtime = require('./runtime');

function preferredPort() {
    const v = process.env.TAXIO_PILOT_PORT;
    return v !== undefined && /^\d+$/.test(v) ? parseInt(v, 10) : runtime.PREFERRED_PORT;
}

/** Berkas rahasia plaintext dari versi lama -> terenkripsi (no-op tanpa enkripsi / sudah terenkripsi). */
function sealSecretsAtRest() {
    for (const [label, mod] of [['session.json', './session-store'], ['local-entities.json', './local-entities']]) {
        try { if (require(mod).sealIfPlain()) log(label + ' kini tersimpan terenkripsi (DPAPI Windows).'); }
        catch (e) { log('Gagal mengenkripsi ' + label + ' (diabaikan, dicoba lagi saat start berikutnya): ' + e.message); }
    }
}

let _exitHookInstalled = false;

/** Langkah 1-4 di atas. opts: { smoke, banner, findPrimary, listenTries }. Resolves
 *  { port, token, dashboardUrl, fellBack, preferredPort } atau { primary } (instance lain milik pengguna ini
 *  sudah memegang port - hanya bila findPrimary menemukannya). Galat bind selain "port terpakai" dilempar. */
async function start(opts) {
    const o = opts || {};
    const { createGuiServer, setLaunchInfo } = require('../gui/server');
    const updater = require('./updater');
    const port = preferredPort();
    const token = runtime.newToken();
    log('Taxio Pilot memulai...' + (o.banner ? ' ' + o.banner : ''));
    try { const line = paths.migrationSummaryLine(paths.migrate()); if (line) log(line); }
    catch (e) { log('Migrasi folder data gagal (diabaikan, folder lama tetap dipakai): ' + e.message); }
    try { require('./chrome').clearDownloadTemp(); } catch (e) { /* abaikan */ }
    sealSecretsAtRest();

    const started = await runtime.listenPreferred((p) => createGuiServer(p, { token }), port,
        { findPrimary: o.findPrimary || (() => runtime.findPrimary({ legacyPort: port || null })), tries: o.listenTries });
    if (started.primary) return { primary: started.primary };

    const guiPort = started.port;
    setLaunchInfo({ preferredPort: port, fellBack: started.fellBack });
    try { runtime.write({ port: guiPort, pid: process.pid, token, version: updater.currentVersion() }); }
    catch (e) { log('Gagal menulis runtime.json (' + e.message + ') - peluncuran berikutnya / server MCP tidak bisa menemukan instance ini.'); }
    if (!_exitHookInstalled) {
        _exitHookInstalled = true;
        // Keluar tanpa lewat jalur "Keluar" (crash, Task Manager): runtime.json tetap dibuang, tapi hanya bila
        // masih milik proses ini (instance yang lebih baru mungkin sudah menimpanya).
        process.on('exit', () => runtime.remove(process.pid));
    }
    log('Dashboard lokal aktif di http://127.0.0.1:' + guiPort + '/' + (started.fellBack ? ' (port ' + port + ' dipakai aplikasi lain)' : '') + ' - port dan token di ' + paths.runtimeFile());

    // Sesi Taxio tersimpan dipulihkan di latar (lihat header); dashboard sudah bisa melayani sejak baris di atas.
    require('./session-restore').start().catch(() => {});
    require('./hub-refresher').start();

    // Pemeriksaan sistem di latar: hanya masalah yang dicatat (daftar lengkap: Pengaturan -> Pemeriksaan
    // sistem / GET /api/health). TAXIO_PILOT_STARTUP_HEALTH=0 melewatinya (tes offline).
    if (process.env.TAXIO_PILOT_STARTUP_HEALTH !== '0') setTimeout(() => {
        require('./doctor').runChecks({ server: { port: guiPort, preferredPort: port, fellBack: started.fellBack, tokenRequired: true } })
            .then((report) => { for (const line of require('./doctor').problemLines(report)) log(line); })
            .catch((e) => log('Pemeriksaan sistem gagal: ' + e.message));
    }, o.smoke ? 500 : 10000).unref();

    return { port: guiPort, token, fellBack: started.fellBack, preferredPort: port, dashboardUrl: 'http://127.0.0.1:' + guiPort + '/?t=' + token };
}

/** Uji diri (verifikasi build): Playwright meluncurkan Chrome otomasi (bawaan bila siap, selain itu yang
 *  terpasang) dengan profil sementara, membuka about:blank, lalu menutupnya. Tidak menyentuh profil PIC. */
async function selfTestBrowser() {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(paths.root(), 'uji-diri-profil-' + process.pid);
    try {
        const { bundled, ...launch } = await require('./browser').launchOptions();
        const { chromium } = require('playwright');
        const ctx = await chromium.launchPersistentContext(dir, Object.assign({ headless: true }, launch));
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto('about:blank');
        const ua = await page.evaluate('navigator.userAgent');
        await ctx.close();
        const line = 'UJI-DIRI browser: OK - ' + (bundled ? 'Chrome bawaan ' + launch.executablePath : 'Chrome terpasang (channel ' + launch.channel + ')') + ' - ' + /Chrome\/[\d.]+/.exec(ua);
        log(line);
        return { ok: true, line };
    } catch (e) {
        log('UJI-DIRI browser: GAGAL - ' + e.message);
        return { ok: false, error: e.message };
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* abaikan */ }
    }
}

module.exports = { start, preferredPort, selfTestBrowser };
