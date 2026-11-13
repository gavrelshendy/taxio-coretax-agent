/* Taxio Pilot - aplikasi desktop (Electron main process, Tahap 2). Menggantikan shell buatan sendiri
 * versi pkg (dashboard di Chrome --app dicari lewat judul jendela, tray/dialog/pesan galat lewat
 * PowerShell tersembunyi, updater yang menyalin exe-nya sendiri, protokol lewat `reg add`).
 *
 * Inti otomasi TIDAK berubah dan tidak tahu Electron: urutan start ada di lib/app.js (sama dengan mode
 * tanpa jendela `node main.js`), dashboard tetap dilayani server HTTP lokal (gui/server.js - server MCP
 * memakai API yang sama) dan di sini hanya ditampilkan di BrowserWindow. Semua yang butuh platform
 * (jendela, dialog, pesan galat, enkripsi rahasia, keluar) lewat lib/shell.js, yang implementasi
 * Electron-nya didaftarkan di bawah.
 *
 * Mode (variabel lingkungan):
 *   (tanpa)                   aplikasi terpasang biasa: satu instance, protokol taxio-coretax://, serah-terima
 *                             dari exe pkg lama (lib/legacy-handover.js), update otomatis (electron-updater,
 *                             provider generic pada kanal rilis tetap `pilot-v4` - lib/updater.js FEED_URL).
 *   TAXIO_PILOT_DATA_DIR=<d>  TERISOLASI: semua data di <d> (termasuk userData Electron = kunci satu-instance,
 *                             jadi tidak berebut dengan aplikasi yang terpasang); jendela + tray tetap muncul,
 *                             tetapi TIDAK mendaftarkan protokol, TIDAK menyentuh pintasan / registry, TIDAK
 *                             memeriksa update. Untuk uji build: pasangkan dengan TAXIO_PILOT_PORT=<port bukan 51733>.
 *   TAXIO_PILOT_UPDATE_FEED=<url dasar>  (hanya bersama TAXIO_PILOT_DATA_DIR) updater AKTIF dengan feed ini
 *                             menggantikan FEED_URL; dalam mode terisolasi selalu verifikasi-saja dan cache
 *                             unduhannya di <d>\update-cache.
 *   TAXIO_PILOT_UPDATE_VERIFY_ONLY=1  cek + unduh + verifikasi sha512, catat hasilnya, TIDAK keluar/memasang.
 *   TAXIO_PILOT_SMOKE=1       seperti terisolasi (wajib bersama TAXIO_PILOT_DATA_DIR), tanpa jendela dan tray.
 *   TAXIO_PILOT_DEBUG_WINDOW=1   mencatat did-finish-load + judul halaman dan menyimpan tangkapan jendela ke
 *                             <akar>\jendela-dashboard.png (verifikasi build).
 *   TAXIO_PILOT_SELFTEST_BROWSER=1  sesudah start, Playwright meluncurkan Chrome otomasi dengan profil
 *                             sementara di about:blank lalu menutupnya; hasilnya satu baris "UJI-DIRI browser" di log.
 *
 * Jendela dashboard: contextIsolation + sandbox, tanpa nodeIntegration / preload; partisi sesi sendiri yang
 * hanya mengizinkan permintaan ke origin dashboard ini (plus stylesheet/font Google Fonts yang dipakai
 * index.html); navigasi ke luar origin ditolak dan tautan http(s) dibuka di browser default; jendela baru
 * ditolak; semua izin (kamera, notifikasi, ...) ditolak. Menutup jendela hanya menyembunyikannya (proses dan
 * otomasi tetap jalan, ikon tray tetap ada); "Keluar" (tray / dashboard) = gui/server.js gracefulQuit. */
'use strict';
// MUST precede the first require('playwright') anywhere - see main.js.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, Tray, Menu, dialog, shell: eshell, safeStorage, net, session } = require('electron');
const paths = require('../lib/paths');

const SMOKE = process.env.TAXIO_PILOT_SMOKE === '1';
const ISOLATED = !!process.env.TAXIO_PILOT_DATA_DIR || SMOKE;
const DEBUG_WINDOW = process.env.TAXIO_PILOT_DEBUG_WINDOW === '1';
const SELFTEST_BROWSER = process.env.TAXIO_PILOT_SELFTEST_BROWSER === '1';
// Uji updater tanpa memasang: feed pengganti HANYA dihormati dalam mode terisolasi (TAXIO_PILOT_DATA_DIR),
// dan mode terisolasi selalu verifikasi-saja (tidak pernah keluar untuk memasang ke PC ini).
const UPDATE_FEED = process.env.TAXIO_PILOT_DATA_DIR && process.env.TAXIO_PILOT_UPDATE_FEED ? process.env.TAXIO_PILOT_UPDATE_FEED : null;
const VERIFY_ONLY = process.env.TAXIO_PILOT_UPDATE_VERIFY_ONLY === '1' || ISOLATED;
const APP_ID = 'com.taxio.pilot';
const PROTOCOL = 'taxio-coretax';
const ICON = path.join(__dirname, '..', 'gui', 'public', 'assets', 'taxio-pilot.ico');
const PARTITION = 'persist:dashboard';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

function main() {
    if (SMOKE && !process.env.TAXIO_PILOT_DATA_DIR) {
        console.error('TAXIO_PILOT_SMOKE=1 butuh TAXIO_PILOT_DATA_DIR=<folder sementara>.');
        app.exit(2);
        return;
    }
    // userData (cookie dashboard, cache Chromium, kunci satu-instance) di bawah akar data, supaya
    // TAXIO_PILOT_DATA_DIR mengisolasi SEMUANYA. Harus sebelum requestSingleInstanceLock / ready.
    app.setPath('userData', path.join(paths.root(), 'electron'));
    app.setAppUserModelId(APP_ID);
    if (!app.requestSingleInstanceLock()) { app.quit(); return; } // instance pertama menerima 'second-instance'

    process.on('unhandledRejection', (reason) => {
        try { require('../lib/log').log('Unhandled promise rejection (diabaikan, proses tetap jalan): ' + (reason && reason.stack || reason)); } catch (e) { console.error(reason); }
    });
    process.on('uncaughtException', (err) => {
        try { require('../lib/log').log('Uncaught exception (diabaikan, proses tetap jalan): ' + (err && err.stack || err)); } catch (e) { console.error(err); }
    });

    const { log } = require('../lib/log');
    const shell = require('../lib/shell');
    const deeplink = require('../lib/deeplink');

    let core = null;          // lib/app.js start() result
    let win = null;
    let tray = null;
    let quitting = false;
    const pendingLinks = [];

    const dispatchLink = (url) => deeplink.dispatch(url).catch((e) => log('Deep link gagal: ' + e.message));
    const appOrigin = () => (core ? new URL(core.dashboardUrl).origin : null);

    app.on('second-instance', (event, argv) => {
        // Klik ganda pintasan / klik taxio-coretax:// saat aplikasi sudah berjalan (mungkin tersembunyi di tray).
        const url = deeplink.findDeepLinkArg(argv);
        if (!core) { if (url) pendingLinks.push(url); return; }
        if (!SMOKE) showDashboard();
        if (url) dispatchLink(url);
    });
    // Jendela ditutup = disembunyikan; aplikasi tetap hidup di tray sampai "Keluar".
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => { quitting = true; });
    app.on('will-quit', () => {
        try { if (tray) tray.destroy(); } catch (e) { /* abaikan */ }
        try { require('../lib/runtime').remove(process.pid); } catch (e) { /* abaikan */ }
    });

    function openExternal(url) {
        try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') eshell.openExternal(u.toString()); }
        catch (e) { /* bukan URL */ }
    }

    function lockDownSession() {
        const ses = session.fromPartition(PARTITION);
        ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));
        ses.setPermissionCheckHandler(() => false);
        ses.webRequest.onBeforeRequest((details, cb) => {
            let u;
            try { u = new URL(details.url); } catch (e) { return cb({ cancel: true }); }
            if (u.origin === appOrigin() || ['devtools:', 'data:', 'blob:'].includes(u.protocol)) return cb({});
            if (u.protocol === 'https:' && FONT_HOSTS.has(u.hostname) && ['stylesheet', 'font'].includes(details.resourceType)) return cb({});
            cb({ cancel: true });
        });
    }

    function createWindow(url) {
        win = new BrowserWindow({
            width: 1280, height: 860, minWidth: 900, minHeight: 600, show: false, title: 'Taxio Pilot', icon: ICON,
            autoHideMenuBar: true, backgroundColor: '#ffffff',
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, partition: PARTITION, spellcheck: false, devTools: !app.isPackaged || DEBUG_WINDOW }
        });
        win.removeMenu();
        const wc = win.webContents;
        wc.setWindowOpenHandler(({ url: target }) => { openExternal(target); return { action: 'deny' }; });
        const guard = (event, target) => {
            let origin = null;
            try { origin = new URL(target).origin; } catch (e) { /* tidak valid */ }
            if (origin !== appOrigin()) { event.preventDefault(); openExternal(target); }
        };
        wc.on('will-navigate', guard);
        wc.on('will-redirect', guard);
        wc.on('render-process-gone', (e, details) => {
            log('Tampilan dashboard berhenti (' + details.reason + ') - dimuat ulang.');
            if (win && !win.isDestroyed()) win.loadURL(core.dashboardUrl).catch(() => {});
        });
        if (DEBUG_WINDOW) {
            wc.on('did-finish-load', async () => {
                try {
                    log('[DEBUG] Jendela dashboard did-finish-load: judul "' + wc.getTitle() + '", ' + new URL(wc.getURL()).pathname);
                    await new Promise((r) => setTimeout(r, 1500));
                    const img = await wc.capturePage();
                    const file = path.join(paths.root(), 'jendela-dashboard.png');
                    fs.writeFileSync(file, img.toPNG());
                    log('[DEBUG] Tangkapan jendela: ' + file + ' (' + img.getSize().width + 'x' + img.getSize().height + ')');
                } catch (e) { log('[DEBUG] Tangkapan jendela gagal: ' + e.message); }
            });
        }
        win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
        win.on('closed', () => { win = null; });
        win.once('ready-to-show', () => { if (win) { win.show(); win.focus(); } });
        win.loadURL(url).catch((e) => log('Gagal memuat dashboard: ' + e.message));
    }

    /** Buka jendela dashboard, atau tampilkan + fokuskan yang sudah ada (satu jendela saja). */
    function showDashboard() {
        if (!core) return false;
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            return true;
        }
        createWindow(core.dashboardUrl);
        return true;
    }

    function parentWindow() { return win && !win.isDestroyed() && win.isVisible() ? win : undefined; }

    shell.register({
        kind: 'electron',
        showDashboard: async () => showDashboard(),
        closeDashboard: () => { if (win && !win.isDestroyed()) win.destroy(); win = null; },
        pickFile: async ({ title, filters, defaultPath }) => {
            const opts = { title, filters, properties: ['openFile'] };
            if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
            const parent = parentWindow();
            const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
            return r.canceled ? null : (r.filePaths[0] || null);
        },
        pickFolder: async ({ title }) => {
            const opts = { title, properties: ['openDirectory', 'createDirectory'] };
            const parent = parentWindow();
            const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
            return r.canceled ? null : (r.filePaths[0] || null);
        },
        showErrorBox: (title, msg) => dialog.showErrorBox(title || 'Taxio Pilot', String(msg)),
        canEncrypt: () => safeStorage.isEncryptionAvailable(),
        encryptString: (text) => safeStorage.encryptString(String(text)).toString('base64'),
        decryptString: (b64) => safeStorage.decryptString(Buffer.from(String(b64), 'base64')),
        isPackaged: () => app.isPackaged,
        exePath: () => app.getPath('exe'),
        exit: (code) => {
            quitting = true;
            if (code) { app.exit(code); return; }
            app.quit();
            setTimeout(() => app.exit(0), 5000).unref(); // jendela yang macet tidak boleh menahan keluar
        }
    });

    function createTray() {
        tray = new Tray(ICON);
        tray.setToolTip('Taxio Pilot');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Buka Dashboard', click: () => showDashboard() },
            { type: 'separator' },
            { label: 'Keluar', click: () => require('../gui/server').gracefulQuit().catch(() => {}) }
        ]));
        tray.on('click', () => showDashboard());
    }

    /** Serah-terima dari exe pkg lama, SEBELUM protokol didaftarkan ulang (ia membaca pendaftaran lama). */
    async function legacyHandover() {
        const exe = app.getPath('exe');
        const listLnk = (dir, depth) => {
            const out = [];
            let ents = [];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
            for (const ent of ents) {
                const p = path.join(dir, ent.name);
                if (ent.isFile() && /\.lnk$/i.test(ent.name)) out.push(p);
                else if (ent.isDirectory() && depth > 0) out.push(...listLnk(p, depth - 1));
            }
            return out;
        };
        const handover = require('../lib/legacy-handover');
        await handover.run({
            env: process.env, isPackaged: app.isPackaged, installDir: path.dirname(exe), newExe: exe, log,
            readProtocolCommand: () => handover.parseRegDefault(execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\' + PROTOCOL + '\\shell\\open\\command', '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })),
            listShortcutFiles: () => [].concat(listLnk(app.getPath('desktop'), 0), listLnk(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 2)),
            readShortcut: (file) => eshell.readShortcutLink(file),
            writeShortcut: (file, opts) => eshell.writeShortcutLink(file, 'update', opts),
            remember: (legacyExe) => handover.remember(legacyExe)
        });
    }

    function registerProtocol() {
        try {
            const ok = app.setAsDefaultProtocolClient(PROTOCOL);
            log(ok ? 'Protokol ' + PROTOCOL + ':// terdaftar ke ' + app.getPath('exe') + '.' : 'Gagal mendaftarkan protokol ' + PROTOCOL + '://.');
        } catch (e) { log('Gagal mendaftarkan protokol ' + PROTOCOL + '://: ' + e.message); }
    }

    /** electron-updater, provider GENERIC pada kanal rilis tetap `pilot-v4` (lib/updater.js FEED_URL, sama
     *  dengan build.publish di package.json) - BUKAN /releases/latest milik exe pkg 3.0.x. */
    function startUpdater() {
        const updater = require('../lib/updater');
        const { autoUpdater } = require('electron-updater');
        const feedUrl = UPDATE_FEED || updater.FEED_URL;
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false; // hanya lewat lib/updater.js (catatan percobaan + jalur keluar biasa)
        autoUpdater.allowPrerelease = false;
        autoUpdater.allowDowngrade = false;
        autoUpdater.disableWebInstaller = true;
        // Aset kanal pilot-v4 DIGANTI tiap rilis: blockmap versi lama sudah tidak ada di server, jadi unduhan
        // diferensial hanya akan gagal lalu jatuh ke unduhan penuh (dengan stack galat di log). Selalu penuh.
        autoUpdater.disableDifferentialDownload = true;
        if (ISOLATED) {
            // Cache unduhan electron-updater (bawaan %LOCALAPPDATA%\coretax-agent-updater = updaterCacheDirName
            // di app-update.yml, dipakai juga oleh aplikasi terpasang) dipindah ke bawah akar data uji.
            const cacheBase = path.join(paths.root(), 'update-cache');
            try { Object.defineProperty(autoUpdater.app, 'baseCachePath', { get: () => cacheBase, configurable: true }); }
            catch (e) { log('[update] cache uji tidak bisa dipindah: ' + e.message); }
        }
        // Kanal yang belum punya rilis (latest.yml 404) = "belum ada update", bukan galat: dicatat SEKALI, bukan baris
        // merah tiap 15 menit di log pengguna (temuan uji pasang 2026-11-13).
        const noRelease = (m) => /Cannot find channel|HttpError: 404/i.test(String((m && m.message) || m));
        let noReleaseLogged = false;
        const quiet = (m) => { if (!noRelease(m)) log('[update] ' + String(m).split('\n')[0]); };
        autoUpdater.logger = { info: () => {}, debug: () => {}, warn: quiet, error: quiet };
        autoUpdater.on('error', () => { /* dilaporkan lewat promise check/download - lib/updater.js */ });
        let onProgress = null;
        autoUpdater.on('download-progress', (p) => { if (onProgress) onProgress(p); });
        let checked = null;
        const engine = {
            check: async () => {
                let r;
                try { r = await autoUpdater.checkForUpdates(); }
                catch (e) {
                    if (!noRelease(e)) throw e;
                    if (!noReleaseLogged) { noReleaseLogged = true; log('Kanal update belum punya rilis - tidak ada update untuk dipasang.'); }
                    return null;
                }
                if (!r || !r.updateInfo) return null;
                checked = r.updateInfo;
                const f = (r.updateInfo.files || [])[0];
                return { version: r.updateInfo.version, notes: r.updateInfo.releaseNotes, size: f && f.size };
            },
            download: async () => {
                onProgress = updater.progressLogger(checked ? checked.version : '?');
                try { await autoUpdater.downloadUpdate(); } finally { onProgress = null; }
            },
            install: () => { quitting = true; autoUpdater.quitAndInstall(true, true); }
        };
        updater.configure({
            engine,
            feedUrl,
            verifyOnly: VERIFY_ONLY,
            isRunActive: () => require('../lib/runcontrol').anyActive(),
            // Jalur keluar yang sama dengan "Keluar" (menutup jendela Chrome otomasi), lalu pasang + buka ulang.
            onBeforeRestart: () => require('../gui/server').gracefulQuit({ finalize: () => engine.install() })
        });
        log('Update otomatis aktif: kanal ' + feedUrl + (VERIFY_ONLY ? ' (VERIFIKASI SAJA - tidak pernah memasang)' : '') + '.');
        updater.checkPreviousInstall();
        updater.startAutoUpdate(null, { initialDelayMs: 4000 });
    }

    /** Port 51733 dipegang exe pkg versi 3 yang masih berjalan (versi 4 terpaksa memakai port lain): dua
     *  versi berjalan bersamaan dan berebut deep link. Hanya GET tanpa token (probe versi 3 menjawab 200;
     *  versi 4 lain menjawab 401 karena PROBE_HEADER) - tidak pernah POST. */
    async function warnIfLegacyRunning() {
        if (!core || !core.fellBack || core.preferredPort !== 51733) return;
        const r = await require('../lib/runtime').probe(51733, null);
        if (r.status !== 200 || r.pilot) return; // bukan versi 3 (versi 4 memasang header x-taxio-pilot)
        log('Taxio Pilot versi 3 (coretax-agent.exe) masih berjalan di port 51733 - dua versi berjalan bersamaan.');
        require('../lib/log').showPopup('Taxio Pilot versi 3 (coretax-agent.exe) masih berjalan di PC ini. Jangan jalankan dua versi bersamaan: tutup versi 3 lewat menu "Keluar" di ikon tray-nya, lalu lanjutkan di jendela ini.', 'Versi lama masih berjalan', 'Warning');
    }

    async function onReady() {
        // Semua HTTP keluar (Taxio Hub/Supabase, Chrome bawaan, pemeriksaan sistem) lewat tumpukan jaringan
        // Chromium = mengikuti proxy/PAC Windows (lib/net.js).
        require('../lib/net').setFetch((input, init) => net.fetch(input, init));
        lockDownSession();
        try {
            // Electron memegang kunci satu-instance, jadi tidak ada "primary" lain milik kita yang perlu dicari
            // lewat HTTP. Port 51733 yang dipegang exe pkg lama yang sedang menutup (serah-terima update) atau
            // aplikasi lain -> port bebas.
            core = await require('../lib/app').start({
                smoke: SMOKE, findPrimary: async () => null, listenTries: 1,
                banner: '[Electron ' + process.versions.electron + (app.isPackaged ? '' : ', pengembangan') + (ISOLATED ? ', terisolasi: tanpa protokol/serah-terima, ' + (UPDATE_FEED ? 'update verifikasi-saja dari feed uji' : 'tanpa update') : '') + (SMOKE ? ', SMOKE: tanpa jendela/tray' : '') + ']'
            });
        } catch (e) {
            log('Fatal error saat memulai: ' + (e.stack || e.message));
            dialog.showErrorBox('Taxio Pilot', 'Taxio Pilot gagal membuka dashboard lokal: ' + e.message);
            app.exit(1);
            return;
        }
        if (SMOKE) return;
        createTray();
        if (app.isPackaged && !ISOLATED) {
            await legacyHandover();
            registerProtocol();
        }
        showDashboard();
        for (const url of [deeplink.findDeepLinkArg(process.argv)].concat(pendingLinks.splice(0)).filter(Boolean)) dispatchLink(url);
        // Chrome bawaan disiapkan di latar sejak awal (sekali saja), supaya biasanya sudah siap sebelum
        // otomasi pertama; otomasi yang lebih dulu jalan menunggu unduhan yang sama.
        require('../lib/browser').ensure();
        if (SELFTEST_BROWSER) require('../lib/app').selfTestBrowser();
        if (app.isPackaged && (!ISOLATED || UPDATE_FEED)) startUpdater();
        else log('Update otomatis tidak aktif (' + (!app.isPackaged ? 'mode pengembangan' : 'mode terisolasi tanpa TAXIO_PILOT_UPDATE_FEED') + ').');
        if (!ISOLATED) warnIfLegacyRunning().catch(() => {});
    }

    app.whenReady().then(onReady).catch((e) => {
        try { log('Fatal error saat memulai: ' + (e.stack || e.message)); } catch (e2) { /* abaikan */ }
        app.exit(1);
    });
}

main();
