/* Auto-update: checks GitHub Releases for a newer coretax-agent.exe, downloads it, and swaps
 * it into place - explicit user request 2026-08-07 ("instead download file baru, bisa cek
 * update dri coretax agentnya dan update disana?") in preference over manually re-downloading
 * from Taxio Hub every release.
 *
 * Windows won't let a running .exe overwrite its own file on disk (it's locked while executing),
 * so the actual swap can't happen from inside this process. The FIRST design here (2026-08-07)
 * tried the classic approach: spawn a small detached PowerShell helper script that waits for
 * this process to exit, copies the new exe over the old path, and relaunches it. Extensive real
 * testing (2026-08-10, including on the user's own machine via a plain double-click, not just my
 * own tooling) showed that helper reliably dying within about a second of being spawned,
 * regardless of detached/stdio/windowsHide combination, head-start delay, or exit mechanism
 * (process.exit() vs a natural drain) - never once completing, in dozens of trials.
 *
 * REDESIGNED 2026-08-10 to avoid needing ANY short-lived helper process to survive at all: the
 * already-downloaded NEW exe launches ITSELF (main.js's --finish-update mode below), as a normal,
 * independent, long-running process - exactly like every other launch of this app. That process
 * waits for the old PID to exit using plain JS polling (no subprocess-survival concerns - it's
 * just a setTimeout loop in an already-fully-running process), copies itself over the old exe's
 * path once unlocked, relaunches the old path fresh, and exits. If the download is
 * incomplete/corrupt (size mismatch against what GitHub reports) or the copy fails after
 * retrying, it falls back to relaunching the OLD exe untouched - a failed update should never
 * leave the user with nothing running. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./log');

const REPO = 'gavrelshendy/taxio-coretax-agent';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function currentVersion() {
    try { return require('../package.json').version; } catch (e) { return null; }
}

/** "1.10.4" vs "1.10.10" - plain string/localeCompare would get this wrong, so compare
 *  numerically per dot-separated segment. Returns true if `a` is strictly newer than `b`. */
function isNewer(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** Returns { available, version, notes, assetUrl, assetSize } if a newer release exists (with an
 *  attached .exe), or { available: false } otherwise/on any failure - a broken update check
 *  (network down, GitHub rate limit, etc.) should never block the app from starting normally. */
async function checkForUpdate() {
    const current = currentVersion();
    if (!current) return { available: false };
    try {
        const res = await fetch(LATEST_RELEASE_API, { headers: { 'User-Agent': 'coretax-agent', Accept: 'application/vnd.github+json' } });
        if (!res.ok) { log('Cek update gagal: HTTP ' + res.status); return { available: false }; }
        const release = await res.json();
        const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
        if (!latestVersion || !isNewer(latestVersion, current)) return { available: false, latestVersion, current };
        const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name));
        if (!asset) { log('Update ' + latestVersion + ' ditemukan tapi tidak ada file .exe terlampir.'); return { available: false }; }
        return { available: true, version: latestVersion, notes: release.body || '', assetUrl: asset.browser_download_url, assetSize: asset.size, current };
    } catch (e) {
        log('Cek update gagal: ' + e.message);
        return { available: false };
    }
}

/** Downloads the new exe to a temp path, verifies its size matches what GitHub reported (cheap
 *  sanity check against a truncated/interrupted download), and launches it as an independent
 *  process in --finish-update mode (see finishUpdateHandoff below and main.js's handling of that
 *  flag) - that process takes over waiting for this one to exit and completing the swap. The
 *  CALLER is responsible for actually quitting afterward (this module never exits the process
 *  itself, so callers can run their own graceful shutdown - closing automation windows etc. -
 *  first, same as /api/quit already does). */
async function downloadAndPrepareSwap(update) {
    const tmpDir = path.join(os.tmpdir(), 'coretax-agent-update');
    fs.mkdirSync(tmpDir, { recursive: true });
    const newExePath = path.join(tmpDir, 'coretax-agent-new.exe');
    const sizeLabel = update.assetSize ? ' (' + (update.assetSize / 1024 / 1024).toFixed(1) + ' MB)' : '';
    log('Mengunduh update v' + update.version + sizeLabel + '...');
    const res = await fetch(update.assetUrl);
    if (!res.ok) throw new Error('Unduhan gagal: HTTP ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (update.assetSize && buffer.length !== update.assetSize) {
        throw new Error('Ukuran file unduhan tidak sesuai (' + buffer.length + ' vs ' + update.assetSize + ' byte) - kemungkinan unduhan terputus.');
    }
    // CONFIRMED LIVE 2026-08-07: fs.writeFileSync on this ~100MB buffer blocked the whole Node
    // event loop for the entire write - the HTTP server (and everything else) went completely
    // unresponsive, including /api/quit itself, leaving the app stuck with no way to recover
    // short of force-killing the process. Async write instead - same result, doesn't freeze
    // anything else this process is doing while it happens.
    await fs.promises.writeFile(newExePath, buffer);
    log('Update terunduh (' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB). Menyiapkan pemasangan...');

    // Self-update only ever makes sense for the packaged exe (dev mode via `node main.js` has no
    // single exe to swap) - process.execPath is that exe's own real path when running under pkg.
    // Deliberately NOT built via path.join with a literal 'dist'/'coretax-agent.exe' segment -
    // pkg's static analyzer read that as a real asset reference and tried to bundle
    // dist/coretax-agent.exe INTO ITSELF ("Trying to take executable into executable"), since
    // that path is this very build's own output.
    const oldExePath = process.execPath;

    // Launch the just-downloaded new exe as a completely normal, independent process - the SAME
    // spawn recipe gui/window.js's openWindow() uses for Chrome (both are GUI-subsystem exes,
    // unlike the console-subsystem powershell.exe the old design relied on), confirmed live to
    // survive this app calling process.exit(). --finish-update tells main.js to run
    // finishUpdateHandoff() before normal startup instead of opening its own dashboard right away.
    const child = spawn(newExePath, ['--finish-update', String(process.pid), oldExePath], {
        detached: true, stdio: 'ignore'
    });
    child.unref();
    log('Update siap dipasang - aplikasi akan tertutup dan terbuka ulang otomatis...');
}

/** Runs in the NEWLY downloaded exe, started by downloadAndPrepareSwap above with
 *  `--finish-update <oldPid> <oldExePath>`. Waits for the old process to exit (plain JS polling -
 *  this process is already fully independent and long-running, so there's no subprocess-survival
 *  concern at all, unlike the old detached-helper-script design), then copies itself over the old
 *  exe's path (retrying - a freshly-exited process's file can stay locked for a moment, e.g.
 *  antivirus scanning it) and relaunches the old path fresh so process.execPath/the registered
 *  protocol handler etc. are all correct for the session going forward. Falls back to just
 *  relaunching the untouched old exe if the copy never succeeds - never leaves the user with
 *  nothing running. Resolves once it's safe for main.js to continue into normal startup (when the
 *  copy succeeded, main.js does NOT continue in this process - it hands off to the relaunched old
 *  exe and exits instead; see main.js's --finish-update handling). */
async function finishUpdateHandoff(oldPid, oldExePath) {
    log('Menunggu Coretax Agent versi lama (PID ' + oldPid + ') benar-benar tertutup...');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try { process.kill(oldPid, 0); } catch (e) { break; } // throws once the pid no longer exists
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // brief settle for the just-released file lock
    let copied = false;
    for (let i = 1; i <= 15; i++) {
        try {
            await fs.promises.copyFile(process.execPath, oldExePath);
            copied = true;
            log('Update berhasil dipasang ke ' + oldExePath);
            break;
        } catch (e) {
            if (i === 15) log('Gagal memasang update setelah ' + i + ' percobaan (' + e.message + ') - membuka ulang versi lama.');
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    try {
        const relaunch = spawn(oldExePath, [], { detached: true, stdio: 'ignore' });
        relaunch.unref();
    } catch (e) {
        log('Gagal membuka ulang Coretax Agent: ' + e.message);
    }
    return copied;
}

/** Full check-and-apply cycle, safe to call on every startup and from a manual "check now"
 *  button alike. Never applies while an automation run is active (checked by the caller passing
 *  `isRunActive`) - a self-restart mid-run would silently kill whatever the user was doing.
 *  `onBeforeRestart` is the caller's OWN full graceful-quit-and-exit sequence (POSTing to this
 *  same app's own /api/quit reuses the exact same closing-automation-windows/dashboard/exit
 *  logic already proven for a normal manual quit, rather than this module duplicating any of
 *  it) - called only once an update is actually ready to apply, and expected to terminate the
 *  process itself; this function never calls process.exit() on its own.
 *
 *  CONFIRMED LIVE 2026-08-07: the startup auto-check and a near-simultaneous manual "Cek Update"
 *  click both called this and both started downloading independently - two concurrent
 *  fs writes to the SAME temp path, one of which never finished cleanly. `_inFlight` makes a
 *  second call while one's already running just await the SAME in-progress attempt instead of
 *  starting its own. */
let _inFlight = null;
function checkAndApply(opts) {
    if (_inFlight) return _inFlight;
    _inFlight = _checkAndApply(opts).finally(() => { _inFlight = null; });
    return _inFlight;
}
async function _checkAndApply({ isRunActive, onBeforeRestart }) {
    const update = await checkForUpdate();
    if (!update.available) return update;
    if (isRunActive && isRunActive()) {
        log('Update v' + update.version + ' ditemukan tapi ada proses otomasi berjalan - ditunda sampai restart berikutnya.');
        return update;
    }
    try {
        await downloadAndPrepareSwap(update);
        if (onBeforeRestart) await onBeforeRestart();
    } catch (e) {
        log('Gagal menerapkan update: ' + e.message);
    }
    return update;
}

module.exports = { checkForUpdate, checkAndApply, isNewer, currentVersion, finishUpdateHandoff };
