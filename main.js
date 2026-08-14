/* Coretax Agent - entry point.
 * A separate, standalone app from Taxio's existing coretax-helper/TaxioCoretaxHelper.exe
 * (that one is left completely untouched) - this one is opened directly by the user (double
 * click, or a desktop shortcut), connects straight to a Taxio/Taxio.me account with
 * email+password, and drives Coretax through a local GUI dashboard instead of a console
 * window. See gui/server.js for the dashboard's API, automation/ebupot.js for the first
 * automation feature (e-Bupot PDF downloads).
 */

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

const http = require('http');
const { log, showErrorPopup } = require('./lib/log');
const state = require('./lib/state');
const sessionStore = require('./lib/session-store');
const entitiesLib = require('./lib/entities');
const deeplink = require('./lib/deeplink');
const { createGuiServer } = require('./gui/server');
const { openWindow } = require('./gui/window');
const tray = require('./lib/tray');
const updater = require('./lib/updater');
const runcontrol = require('./lib/runcontrol');

const GUI_PORT = 51733;

// Best-effort safety net: if the process exits WITHOUT going through /api/quit's handleQuit
// (crash, Task Manager kill, etc), still take the tray helper process down with it rather than
// leaving an orphaned icon whose menu silently does nothing forever.
process.on('exit', () => tray.stop());

async function tryRestoreSessions() {
    const restoredByProject = await sessionStore.restoreAllSessions();
    for (const [projectId, restored] of Object.entries(restoredByProject)) {
        try {
            const membership = await entitiesLib.getMyOrgId(restored.client, restored.user.id);
            state.set(projectId, {
                client: restored.client, project: restored.project, session: restored.session,
                user: restored.session.user, orgId: membership.org_id, role: membership.role, membership
            });
            log('Sesi tersimpan dipulihkan: ' + restored.session.user.email + ' (' + restored.project.label + ').');
        } catch (e) {
            log('Tidak bisa memulihkan sesi ' + restored.project.label + ' (' + e.message + ') - silakan hubungkan ulang.');
        }
    }
}

/** True if some process is already listening on GUI_PORT and answering as this app's own
 *  dashboard (not just "something" bound to the port). */
function isPrimaryRunning() {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/session', method: 'GET', timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

/** Asks an already-running PRIMARY instance to open/focus its own dashboard window, via the
 *  same `/api/tray/open` endpoint the tray icon's "Buka Dashboard" uses. This process (a fresh
 *  double-click launch that found the port already bound) has no idea whether a window is
 *  already open - only the PRIMARY's own gui/window.js module state knows that. Calling
 *  openWindow() directly from HERE (the old behavior) always spawned a brand new Chrome window
 *  on every double-click, even with one already open - forwarding the request instead lets the
 *  primary's own isWindowOpen() check decide, so double-clicking the icon repeatedly reuses the
 *  same single window instead of piling up duplicates. */
function forwardOpenToRunningInstance() {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/tray/open', method: 'POST', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

/** POSTs a taxio-coretax:// URL to an already-running instance's dashboard server. Resolves
 *  true if an instance answered (this process's job is done, whoever is listening will handle
 *  it), false if nothing is listening on GUI_PORT (this process should become the primary
 *  instance itself instead) - mirrors coretax-helper/run.js's own forwardToPrimary(), just over
 *  this app's existing HTTP dashboard server instead of a separate named pipe. */
function forwardDeepLinkToRunningInstance(url) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/deeplink', method: 'POST', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end(JSON.stringify({ url }));
    });
}

async function main(deepLinkUrl) {
    log('Coretax Agent memulai...' + (deepLinkUrl ? ' (dipanggil dari taxio-coretax://)' : ''));
    try { require('./lib/chrome').clearDownloadTemp(); } catch (e) {}
    await tryRestoreSessions();
    try {
        await createGuiServer(GUI_PORT);
        log('Dashboard lokal aktif di http://127.0.0.1:' + GUI_PORT + '/');
    } catch (e) {
        log('Gagal membuka server GUI di port ' + GUI_PORT + ': ' + e.message);
        showErrorPopup('Coretax Agent gagal membuka dashboard lokal (port ' + GUI_PORT + ' mungkin dipakai aplikasi lain): ' + e.message);
        process.exit(1);
    }
    tray.start(GUI_PORT);
    // Idempotent - safe (and cheap) to re-assert this on every normal startup; a genuine no-op
    // in dev (`node main.js`, no process.pkg) since there's no self-contained exe path to point
    // the registry at yet - see the function's own header comment.
    deeplink.registerProtocolHandler();
    openWindow('http://127.0.0.1:' + GUI_PORT + '/');
    if (deepLinkUrl) deeplink.dispatch(deepLinkUrl).catch((e) => log('Deep link gagal: ' + e.message));

    // Auto-update: explicit user request 2026-08-07, checked once per startup - runs in the
    // background (never awaited here) so a slow/failed GitHub check never delays the dashboard
    // opening. A short delay first lets normal startup (session restore, window opening) settle
    // before competing for network/CPU. onBeforeRestart reuses this same app's own /api/quit
    // (safe now - see lib/updater.js's header comment for why the update-installer process no
    // longer needs this process to avoid process.exit()).
    const runUpdateCheck = () => updater.checkAndApply({
        isRunActive: () => runcontrol.status().active,
        onBeforeRestart: async () => {
            try { await fetch('http://127.0.0.1:' + GUI_PORT + '/api/quit', { method: 'POST' }); } catch (e) {}
        }
    }).catch((e) => log('Cek update gagal: ' + e.message));
    setTimeout(runUpdateCheck, 4000);
    // Explicit user request 2026-08-13: if the startup check above got deferred because an
    // automation run was active (or GitHub was briefly unreachable), the "outdated" gate
    // (gui/server.js's checks against updater.getOutdatedInfo()) would otherwise stay stuck
    // reporting the version as behind forever, blocking new actions indefinitely even long
    // after the run that caused the deferral finished. Re-checking periodically (not just once)
    // means a deferred update actually gets retried once idle, same as it would on a fresh
    // restart - this only ever repeats the already-safe checkAndApply cycle, never anything new.
    setInterval(runUpdateCheck, 15 * 60 * 1000);
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
        // instead of trying to bind GUI_PORT a second time and failing.
        forwardDeepLinkToRunningInstance(rawArg).then((forwarded) => {
            if (forwarded) { log('Diteruskan ke instance Coretax Agent yang sudah berjalan.'); process.exit(0); }
            main(rawArg).catch((e) => {
                log('Fatal error saat memulai (deep link): ' + (e.stack || e.message));
                showErrorPopup('Coretax Agent gagal memulai: ' + e.message);
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
        isPrimaryRunning().then(async (already) => {
            if (already) {
                log('Coretax Agent sudah berjalan - membawa jendela dashboard yang ada ke depan (atau membukanya jika belum ada).');
                await forwardOpenToRunningInstance();
                process.exit(0);
            }
            main().catch((e) => {
                log('Fatal error saat memulai: ' + (e.stack || e.message));
                showErrorPopup('Coretax Agent gagal memulai: ' + e.message);
                process.exit(1);
            });
        });
    }
}
