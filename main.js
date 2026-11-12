/* Coretax Agent - entry point.
 * A separate, standalone app from Taxio's existing coretax-helper/TaxioCoretaxHelper.exe
 * (that one is left completely untouched) - this one is opened directly by the user (double
 * click, or a desktop shortcut), connects straight to a Taxio/Taxio.me account with
 * email+password, and drives Coretax through a local GUI dashboard instead of a console
 * window. See gui/server.js for the dashboard's API, automation/ebupot.js for the first
 * automation feature (e-Bupot PDF downloads).
 */

// Every Chrome launch in this app uses channel:'chrome' (the machine's own installed Chrome -
// see lib/chrome.js) - Playwright's own bundled/downloaded browsers are NEVER used. Without
// this, require('playwright') still runs its own browsers-cache validation on a machine that
// never ran `npx playwright install`, and prints a "Looks like Playwright was just installed or
// updated... npx playwright install" banner (confirmed live on a machine other than the dev
// one, 2026-08-18) - harmless since it's never actually needed, but noisy. Setting this to '0'
// tells Playwright to skip that whole browser-management/validation path entirely. MUST be set
// before the first require('playwright'|'playwright-core') anywhere in the process.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

// Playwright spawns this executable as a node wrapper to run its own driver subprocess. This
// guard MUST run before anything else (GUI server, session restore, etc.) - a driver
// re-invocation must do nothing but delegate to playwright-core's CLI, never try to bind the
// GUI port a second time. Ported verbatim from the same, already-solved problem in
// coretax-helper/run.js.
if (process.argv.some((arg) => typeof arg === 'string' && (arg.includes('playwright-core') || arg.endsWith('cli.js')))) {
    try {
        const cliArg = process.argv.find((arg) => typeof arg === 'string' && (arg.includes('playwright-core') || arg.endsWith('cli.js')));
        require(cliArg);
    } catch (e) {
        try { require('playwright-core/cli'); }
        catch (e2) { console.error('Failed to run Playwright CLI:', e); process.exit(1); }
    }
    return;
}
// Forces pkg's static analyzer to bundle playwright-core/cli and its dependencies.
if (false) {
    require('playwright-core/cli');
}

// Run export regression tests inside the shipped executable without starting the GUI,
// restoring sessions, or touching an active Coretax browser.
if (process.argv.includes('--test-lampiran-export')) {
    require('./scripts/test-lampiran-export');
    return;
}

// Belt & suspenders: this is a long-running GUI process, not a one-shot script - an unhandled
// promise rejection anywhere (Node 15+ terminates the whole process on these by default) or a
// stray uncaught exception must never silently kill the GUI server out from under an open
// dashboard window. Log it and keep running instead.
process.on('unhandledRejection', (reason) => {
    try { require('./lib/log').log('Unhandled promise rejection (diabaikan, proses tetap jalan): ' + (reason && reason.stack || reason)); } catch (e) { console.error(reason); }
});
process.on('uncaughtException', (err) => {
    try { require('./lib/log').log('Uncaught exception (diabaikan, proses tetap jalan): ' + (err && err.stack || err)); } catch (e) { console.error(err); }
});

const { log, showNativePopup } = require('./lib/log');
// Before the dashboard exists there is no window to show a notice in: these use a message box.
const showErrorPopup = (msg) => showNativePopup(msg, 'Taxio Pilot Error', 'Error');
const state = require('./lib/state');
const sessionStore = require('./lib/session-store');
const connection = require('./lib/connection');
const deeplink = require('./lib/deeplink');
const { createGuiServer, setLaunchInfo } = require('./gui/server');
const { openWindow } = require('./gui/window');
const tray = require('./lib/tray');
const updater = require('./lib/updater');
const runcontrol = require('./lib/runcontrol');
const paths = require('./lib/paths');
const runtime = require('./lib/runtime');
const doctor = require('./lib/doctor');

/* Port & token (Tahap 1, see lib/runtime.js): the dashboard server tries 51733 first and falls back
 * to a free port when 51733 belongs to something that is not this user's Taxio Pilot. Every
 * /api/* and /events call needs this launch's random token; runtime.json under the data root
 * ({ port, pid, token, version, startedAt }) is how a second launch, the MCP server and other local
 * helpers find both. TAXIO_PILOT_PORT overrides the preferred port (smoke runs / dev).
 *
 * TAXIO_PILOT_SMOKE=1 (developer smoke run, always together with TAXIO_PILOT_DATA_DIR=<temp dir>):
 * starts the server, migration and the background health check, but opens no dashboard window,
 * no tray icon, registers no taxio-coretax:// handler, starts no auto-update and does not download
 * the bundled Chrome; /api/quit, /api/tray/open and deep links never touch windows either (gui/
 * window.js finds the dashboard by title and would hit a real instance's window). Stop it with
 * POST /api/quit (Bearer token from runtime.json). Example (PowerShell):
 *   $env:TAXIO_PILOT_DATA_DIR="$env:TEMP\tp-smoke"; $env:TAXIO_PILOT_SMOKE='1'; $env:TAXIO_PILOT_PORT='0'; node main.js */
const PREFERRED_PORT = process.env.TAXIO_PILOT_PORT !== undefined && /^\d+$/.test(process.env.TAXIO_PILOT_PORT)
    ? parseInt(process.env.TAXIO_PILOT_PORT, 10) : runtime.PREFERRED_PORT;
const SMOKE = process.env.TAXIO_PILOT_SMOKE === '1';
const TOKEN = runtime.newToken();
let guiPort = null; // set once listen() succeeded

// Best-effort safety net: if the process exits WITHOUT going through /api/quit's handleQuit
// (crash, Task Manager kill, etc), still take the tray helper process down with it rather than
// leaving an orphaned icon whose menu silently does nothing forever. runtime.json is removed only
// if it still names this process (a newer instance may already own it).
process.on('exit', () => {
    tray.stop();
    if (guiPort !== null) runtime.remove(process.pid);
});

async function tryRestoreSessions() {
    const restoredByProject = await sessionStore.restoreAllSessions();
    for (const [projectId, restored] of Object.entries(restoredByProject)) {
        try {
            // Lewat pintu yang sama dengan login di dashboard: akun yang belum jadi anggota aktif
            // grup (masih menunggu admin) tidak dianggap terhubung, tapi statusnya tetap tampil.
            const reg = await connection.attach(projectId, {
                client: restored.client, project: restored.project, session: restored.session, user: restored.session.user
            });
            if (reg.status === 'active') log('Sesi tersimpan dipulihkan: ' + restored.session.user.email + ' (' + restored.project.label + ').');
            else log('Sesi tersimpan dipulihkan: ' + restored.session.user.email + ', tapi akun belum aktif di grup (' + reg.status + ').');
        } catch (e) {
            log('Tidak bisa memulihkan sesi ' + restored.project.label + ' (' + e.message + ') - silakan hubungkan ulang.');
        }
    }
}

/* Forwarding to an already-running PRIMARY instance (lib/runtime.js findPrimary: runtime.json +
 * live pid + an authenticated /api/session answer, or - during an update hand-off from an older
 * version - an untokened answer on 51733).
 *
 * "Open": asks the primary to open/focus its own dashboard window, via the same `/api/tray/open`
 * endpoint the tray icon's "Buka Dashboard" uses. This process (a fresh double-click launch) has no
 * idea whether a window is already open - only the PRIMARY's own gui/window.js module state knows
 * that. Calling openWindow() directly from HERE (the old behavior) always spawned a brand new
 * Chrome window on every double-click, even with one already open - forwarding the request instead
 * lets the primary's own isWindowOpen() check decide, so double-clicking the icon repeatedly reuses
 * the same single window instead of piling up duplicates.
 *
 * "Deep link": POSTs a taxio-coretax:// URL to the primary - mirrors coretax-helper/run.js's own
 * forwardToPrimary(), just over this app's existing HTTP dashboard server instead of a named pipe.
 * Both resolve true if the primary answered (this process's job is done). */
// The untokened fallback probe targets the PREFERRED port (51733 unless TAXIO_PILOT_PORT says
// otherwise), so a smoke run on another port can never mistake - and forward to - a real instance.
// A smoke run never forwards anything at all.
function findOwnPrimary() { return runtime.findPrimary({ legacyPort: PREFERRED_PORT || null }); }
function forwardOpenToRunningInstance(primary) { return SMOKE ? Promise.resolve(false) : runtime.forward(primary, '/api/tray/open'); }
function forwardDeepLinkToRunningInstance(primary, url) { return SMOKE ? Promise.resolve(false) : runtime.forward(primary, '/api/deeplink', { url }); }

async function main(deepLinkUrl) {
    if (SMOKE && !process.env.TAXIO_PILOT_DATA_DIR) {
        // A smoke run must never migrate / read the real data of this PC.
        console.error('TAXIO_PILOT_SMOKE=1 butuh TAXIO_PILOT_DATA_DIR=<folder sementara>.');
        process.exit(2);
    }
    log('Taxio Pilot memulai...' + (deepLinkUrl ? ' (dipanggil dari taxio-coretax://)' : '') + (SMOKE ? ' [SMOKE: tanpa jendela/tray/update]' : ''));
    // Before anything reads data (sessions, local entities, Chrome profiles): one-time move of the
    // old scattered folders into %LOCALAPPDATA%\TaxioPilot (lib/paths.js). Never fatal.
    try { const line = paths.migrationSummaryLine(paths.migrate()); if (line) log(line); }
    catch (e) { log('Migrasi folder data gagal (diabaikan, folder lama tetap dipakai): ' + e.message); }
    try { require('./lib/chrome').clearDownloadTemp(); } catch (e) {}
    await tryRestoreSessions();
    let started;
    try {
        started = await runtime.listenPreferred((port) => createGuiServer(port, { token: TOKEN }), PREFERRED_PORT, { findPrimary: findOwnPrimary });
    } catch (e) {
        log('Gagal membuka server GUI: ' + e.message);
        showErrorPopup('Taxio Pilot gagal membuka dashboard lokal: ' + e.message);
        process.exit(1);
    }
    if (started.primary) {
        // Two near-simultaneous launches (double double-click, or two taxio-coretax:// clicks)
        // can both pass the "is a primary running?" check before either binds the port; the
        // loser lands here. Hand the request to the winner like any other second launch.
        const forwarded = deepLinkUrl ? await forwardDeepLinkToRunningInstance(started.primary, deepLinkUrl) : await forwardOpenToRunningInstance(started.primary);
        log('Taxio Pilot ternyata sudah dijalankan bersamaan - ' + (forwarded ? 'permintaan diteruskan ke instance yang sudah berjalan.' : 'instance itu tidak menjawab penerusan.'));
        process.exit(0);
    }
    guiPort = started.port;
    setLaunchInfo({ preferredPort: PREFERRED_PORT, fellBack: started.fellBack });
    try { runtime.write({ port: guiPort, pid: process.pid, token: TOKEN, version: updater.currentVersion() }); }
    catch (e) { log('Gagal menulis runtime.json (' + e.message + ') - peluncuran berikutnya / server MCP tidak bisa menemukan instance ini.'); }
    log('Dashboard lokal aktif di http://127.0.0.1:' + guiPort + '/' + (started.fellBack ? ' (port ' + PREFERRED_PORT + ' dipakai aplikasi lain)' : '') + ' - port dan token di ' + paths.runtimeFile());
    const dashboardUrl = 'http://127.0.0.1:' + guiPort + '/?t=' + TOKEN;
    // Startup health check in the background: only problems are logged (full list: Settings ->
    // Pemeriksaan sistem / GET /api/health). TAXIO_PILOT_STARTUP_HEALTH=0 skips it (offline tests).
    if (process.env.TAXIO_PILOT_STARTUP_HEALTH !== '0') setTimeout(() => {
        doctor.runChecks({ server: { port: guiPort, preferredPort: PREFERRED_PORT, fellBack: started.fellBack, tokenRequired: true } })
            .then((report) => { for (const line of doctor.problemLines(report)) log(line); })
            .catch((e) => log('Pemeriksaan sistem gagal: ' + e.message));
    }, SMOKE ? 500 : 10000);
    if (SMOKE) return;
    tray.start(guiPort, TOKEN);
    // Idempotent - safe (and cheap) to re-assert this on every normal startup; a genuine no-op
    // in dev (`node main.js`, no process.pkg) since there's no self-contained exe path to point
    // the registry at yet - see the function's own header comment.
    deeplink.registerProtocolHandler();
    openWindow(dashboardUrl);
    if (deepLinkUrl) deeplink.dispatch(deepLinkUrl).catch((e) => log('Deep link gagal: ' + e.message));
    // Chrome bawaan disiapkan di latar sejak awal (sekali saja), supaya biasanya sudah siap sebelum
    // otomasi pertama; otomasi yang lebih dulu jalan menunggu unduhan yang sama, bukan mengunduh ulang.
    require('./lib/browser').ensure();

    // Auto-update: explicit user request 2026-08-07, checked once per startup - runs in the
    // background (never awaited here) so a slow/failed GitHub check never delays the dashboard
    // opening. A short delay first lets normal startup (session restore, window opening) settle
    // before competing for network/CPU. onBeforeRestart reuses this same app's own /api/quit
    // (safe now - see lib/updater.js's header comment for why the update-installer process no
    // longer needs this process to avoid process.exit()).
    // Explicit user request 2026-08-13: if the startup check got deferred because an automation
    // run was active (or GitHub was briefly unreachable), the "outdated" gate (gui/server.js's
    // checks against updater.getOutdatedInfo()) would otherwise stay stuck reporting the version
    // as behind forever, blocking new actions indefinitely even long after the run that caused
    // the deferral finished - so the check repeats every 15 minutes. Since 2026-11-12 the
    // schedule lives in lib/updater.js's startAutoUpdate(): first check after 4s, and a FAILED
    // download (GitHub often answers 504 right after a release) is retried after 1, 2, 5 minutes
    // before falling back to the 15-minute cadence, so the 426 gate doesn't lock users out for
    // a whole interval.
    updater.startAutoUpdate({
        isRunActive: () => runcontrol.anyActive(),
        onBeforeRestart: async () => {
            try { await fetch('http://127.0.0.1:' + guiPort + '/api/quit', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN } }); } catch (e) {}
        }
    }, { initialDelayMs: 4000 });
}

// Set only when this process IS the just-downloaded new exe, launched by updater.js's
// downloadAndPrepareSwap() to complete its own installation - see lib/updater.js's
// finishUpdateHandoff() header comment for why this replaced the old detached-PowerShell-helper
// design. Takes priority over everything else below: this process's only job is to wait for the
// old exe to exit, copy itself over it, relaunch that path fresh, and get out of the way - it
// never opens its own dashboard or goes through the normal single-instance checks.
const finishUpdateIdx = process.argv.indexOf('--finish-update');
if (finishUpdateIdx !== -1) {
    const oldPid = parseInt(process.argv[finishUpdateIdx + 1], 10);
    const oldExePath = process.argv[finishUpdateIdx + 2];
    updater.finishUpdateHandoff(oldPid, oldExePath)
        .catch((e) => log('Gagal menyelesaikan pemasangan update: ' + (e.stack || e.message)))
        .finally(() => process.exit(0));
} else {
    const rawArg = process.argv.find((a) => typeof a === 'string' && a.indexOf('taxio-coretax://') === 0);

    if (rawArg) {
        // Another Coretax Agent window may already be open (the common case: the user already
        // has the dashboard running and just clicked another button in Taxio) - forward to it
        // instead of starting a second primary.
        findOwnPrimary().then((primary) => primary ? forwardDeepLinkToRunningInstance(primary, rawArg) : false).then((forwarded) => {
            if (forwarded) { log('Diteruskan ke instance Taxio Pilot yang sudah berjalan.'); process.exit(0); }
            main(rawArg).catch((e) => {
                log('Fatal error saat memulai (deep link): ' + (e.stack || e.message));
                showErrorPopup('Taxio Pilot gagal memulai: ' + e.message);
                process.exit(1);
            });
        });
    } else {
        // Plain double-click (desktop shortcut, Start Menu, etc.) with the app already running
        // in the background (window minimized/closed but the process itself still alive) used to
        // hit createGuiServer's "port already in use" error - confusing for a normal user just
        // trying to bring the dashboard back. Just open another window onto the SAME
        // already-running server instead (the dashboard is stateless/reconnectable - a fresh tab
        // is all that's needed) rather than trying to become a second primary instance.
        findOwnPrimary().then(async (primary) => {
            if (primary) {
                log('Taxio Pilot sudah berjalan - membawa jendela dashboard yang ada ke depan (atau membukanya jika belum ada).');
                await forwardOpenToRunningInstance(primary);
                process.exit(0);
            }
            main().catch((e) => {
                log('Fatal error saat memulai: ' + (e.stack || e.message));
                showErrorPopup('Taxio Pilot gagal memulai: ' + e.message);
                process.exit(1);
            });
        });
    }
}
