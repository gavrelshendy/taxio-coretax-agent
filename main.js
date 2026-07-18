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

const GUI_PORT = 51733;

async function tryRestoreSessions() {
    const restoredByProject = await sessionStore.restoreAllSessions();
    for (const [projectId, restored] of Object.entries(restoredByProject)) {
        try {
            const membership = await entitiesLib.getMyOrgId(restored.client, restored.user.id);
            state.set(projectId, {
                client: restored.client, project: restored.project, session: restored.session,
                user: restored.session.user, orgId: membership.org_id, role: membership.role
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
    await tryRestoreSessions();
    try {
        await createGuiServer(GUI_PORT);
        log('Dashboard lokal aktif di http://127.0.0.1:' + GUI_PORT + '/');
    } catch (e) {
        log('Gagal membuka server GUI di port ' + GUI_PORT + ': ' + e.message);
        showErrorPopup('Coretax Agent gagal membuka dashboard lokal (port ' + GUI_PORT + ' mungkin dipakai aplikasi lain): ' + e.message);
        process.exit(1);
    }
    // Idempotent - safe (and cheap) to re-assert this on every normal startup; a genuine no-op
    // in dev (`node main.js`, no process.pkg) since there's no self-contained exe path to point
    // the registry at yet - see the function's own header comment.
    deeplink.registerProtocolHandler();
    openWindow('http://127.0.0.1:' + GUI_PORT + '/');
    if (deepLinkUrl) deeplink.dispatch(deepLinkUrl).catch((e) => log('Deep link gagal: ' + e.message));
}

const rawArg = process.argv.find((a) => typeof a === 'string' && a.indexOf('taxio-coretax://') === 0);

if (rawArg) {
    // Another Coretax Agent window may already be open (the common case: the user already has
    // the dashboard running and just clicked another button in Taxio) - forward to it instead
    // of trying to bind GUI_PORT a second time and failing.
    forwardDeepLinkToRunningInstance(rawArg).then((forwarded) => {
        if (forwarded) { log('Diteruskan ke instance Coretax Agent yang sudah berjalan.'); process.exit(0); }
        main(rawArg).catch((e) => {
            log('Fatal error saat memulai (deep link): ' + (e.stack || e.message));
            showErrorPopup('Coretax Agent gagal memulai: ' + e.message);
            process.exit(1);
        });
    });
} else {
    // Plain double-click (desktop shortcut, Start Menu, etc.) with the app already running in
    // the background (window minimized/closed but the process itself still alive) used to hit
    // createGuiServer's "port already in use" error - confusing for a normal user just trying
    // to bring the dashboard back. Just open another window onto the SAME already-running
    // server instead (the dashboard is stateless/reconnectable - a fresh tab is all that's
    // needed) rather than trying to become a second primary instance.
    isPrimaryRunning().then((already) => {
        if (already) {
            log('Coretax Agent sudah berjalan - membuka jendela dashboard baru.');
            openWindow('http://127.0.0.1:' + GUI_PORT + '/');
            process.exit(0);
        }
        main().catch((e) => {
            log('Fatal error saat memulai: ' + (e.stack || e.message));
            showErrorPopup('Coretax Agent gagal memulai: ' + e.message);
            process.exit(1);
        });
    });
}
