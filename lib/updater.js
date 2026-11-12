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
 * incomplete/corrupt (SHA-256/size mismatch against what GitHub reports) it is deleted and never
 * launched (the old exe just keeps running); if the copy fails after
 * retrying, it falls back to relaunching the OLD exe untouched - a failed update should never
 * leave the user with nothing running.
 *
 * Integrity (2026-11-12 audit): the download is STREAMED to a temp `.part` file (no ~100 MB
 * in-memory buffer), with a connect timeout and an idle timeout so a stalled GitHub/CDN
 * connection fails instead of hanging the update forever (it used to - plain fetch() has no
 * timeout). It is verified against the release asset's `digest` field ("sha256:<hex>", which the
 * GitHub releases API reports for assets uploaded since mid-2025) when present, and against the
 * reported byte size in every case the size is known (the only check available for older assets
 * without a digest). A file that fails verification is deleted and NEVER launched.
 *
 * Retry (same audit): gui/server.js refuses new actions (HTTP 426) while getOutdatedInfo()
 * reports outdated, and GitHub often answers 504 for the first minutes after a release - with
 * only the 15-minute recheck that meant a failed download locked users out for up to 15 minutes.
 * startAutoUpdate() below retries a FAILED download/apply after 1, 2, then 5 minutes before
 * falling back to the 15-minute cadence (a "deferred because a run is active" result is not a
 * failure and keeps the normal cadence). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { log } = require('./log');
const net = require('./net'); // all outbound HTTP goes through lib/net.js (Tahap 2: Electron net.fetch)

const REPO = 'gavrelshendy/taxio-coretax-agent';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// Swappable from tests only (scripts/test-updater.js): the release API URL, the spawn used to
// launch the downloaded exe, the temp folder and the timers - so a test can serve a fake release
// from a local http server and never download or launch the real exe.
const _deps = {
    releaseApiUrl: LATEST_RELEASE_API,
    spawn: (...args) => spawn(...args),
    tmpDir: () => path.join(os.tmpdir(), 'coretax-agent-update'),
    execPath: () => process.execPath,
    setTimeout: (fn, ms) => setTimeout(fn, ms),     // scheduler (startAutoUpdate) only
    clearTimeout: (t) => clearTimeout(t),
    connectTimeoutMs: 30000,
    idleTimeoutMs: 60000
};
function _setTestDeps(overrides) { Object.assign(_deps, overrides); }

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

/** GitHub release asset `digest` ("sha256:<64 hex>") -> lowercase hex, or null when absent or
 *  in any other algorithm/shape (then only the size check applies). */
function parseSha256Digest(digest) {
    const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || '').trim());
    return m ? m[1].toLowerCase() : null;
}

/** Returns { available, version, notes, assetUrl, assetSize, assetSha256 } if a newer release exists (with an
 *  attached .exe), or { available: false } otherwise/on any failure - a broken update check
 *  (network down, GitHub rate limit, etc.) should never block the app from starting normally. */
async function checkForUpdate() {
    const current = currentVersion();
    if (!current) return { available: false };
    try {
        const res = await net.fetch(_deps.releaseApiUrl, { headers: { 'User-Agent': 'coretax-agent', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(_deps.connectTimeoutMs) });
        if (!res.ok) { log('Cek update gagal: HTTP ' + res.status); return { available: false }; }
        const release = await res.json();
        const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
        if (!latestVersion || !isNewer(latestVersion, current)) return { available: false, latestVersion, current };
        const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name));
        if (!asset) { log('Update ' + latestVersion + ' ditemukan tapi tidak ada file .exe terlampir.'); return { available: false }; }
        return { available: true, version: latestVersion, notes: release.body || '', assetUrl: asset.browser_download_url, assetSize: asset.size, assetSha256: parseSha256Digest(asset.digest), current };
    } catch (e) {
        log('Cek update gagal: ' + e.message);
        return { available: false };
    }
}

/** Streams `url` into `file` (via `file + '.part'`, renamed into place only after verification),
 *  hashing as it goes. Fails - and leaves NO file behind at either path - on HTTP error, no
 *  response headers within connectTimeoutMs, no data for idleTimeoutMs, a size different from
 *  `expectedSize` (when given), or a SHA-256 different from `expectedSha256` (when given).
 *  Same streaming+hash pattern as lib/browser.js's downloadTo for the bundled Chrome.
 *
 *  CONFIRMED LIVE 2026-08-07 (old buffered design): fs.writeFileSync of the ~100MB buffer blocked
 *  the whole Node event loop - the dashboard server, including /api/quit, went unresponsive.
 *  Streaming with async writes keeps the event loop free for the whole download. */
async function downloadVerified(url, file, { expectedSize, expectedSha256 } = {}) {
    const part = file + '.part';
    const ac = new AbortController();
    let idleTimer = null, why = '';
    const arm = (ms, reason) => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { why = reason; ac.abort(); }, ms);
    };
    const removeQuietly = (p) => { try { fs.rmSync(p, { force: true }); } catch (e) { /* ignore */ } };
    let out = null;
    try {
        arm(_deps.connectTimeoutMs, 'server tidak merespons dalam ' + Math.round(_deps.connectTimeoutMs / 1000) + ' detik');
        const res = await net.fetch(url, { headers: { 'User-Agent': 'coretax-agent' }, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error('Unduhan gagal: HTTP ' + res.status);
        const hash = crypto.createHash('sha256');
        out = fs.createWriteStream(part);
        const outError = new Promise((_, reject) => out.once('error', reject));
        outError.catch(() => {}); // observed via Promise.race below; never an unhandled rejection
        let got = 0;
        arm(_deps.idleTimeoutMs, 'tidak ada data masuk selama ' + Math.round(_deps.idleTimeoutMs / 1000) + ' detik');
        for await (const chunk of Readable.fromWeb(res.body)) {
            arm(_deps.idleTimeoutMs, 'tidak ada data masuk selama ' + Math.round(_deps.idleTimeoutMs / 1000) + ' detik');
            hash.update(chunk); got += chunk.length;
            if (!out.write(chunk)) await Promise.race([new Promise((r) => out.once('drain', r)), outError]);
        }
        clearTimeout(idleTimer); idleTimer = null;
        await Promise.race([new Promise((resolve) => out.end(resolve)), outError]);
        out = null;
        if (expectedSize && got !== expectedSize) {
            throw new Error('Ukuran file unduhan tidak sesuai (' + got + ' vs ' + expectedSize + ' byte) - kemungkinan unduhan terputus.');
        }
        const sha = hash.digest('hex');
        if (expectedSha256 && sha !== expectedSha256) {
            throw new Error('Isi file unduhan tidak cocok dengan rilis (SHA-256 ' + sha.slice(0, 12) + '... vs ' + expectedSha256.slice(0, 12) + '...) - file dibuang.');
        }
        removeQuietly(file);
        await fs.promises.rename(part, file);
        return { size: got, sha256: sha, verifiedBy: expectedSha256 ? 'sha256' : (expectedSize ? 'size' : 'none') };
    } catch (e) {
        if (out && !out.closed) {
            // Wait for the handle to really close, otherwise Windows refuses to delete the .part.
            const o = out;
            await new Promise((r) => { const t = setTimeout(r, 2000); o.once('close', () => { clearTimeout(t); r(); }); o.destroy(); });
        }
        removeQuietly(part);
        removeQuietly(file);
        if (why) throw new Error('Unduhan update terhenti: ' + why + '.');
        throw e;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

/** Downloads the new exe to a temp path (downloadVerified: SHA-256 from the release's `digest`
 *  when GitHub reports one, byte size otherwise/as well), and launches it as an independent
 *  process in --finish-update mode (see finishUpdateHandoff below and main.js's handling of that
 *  flag) - that process takes over waiting for this one to exit and completing the swap. The
 *  CALLER is responsible for actually quitting afterward (this module never exits the process
 *  itself, so callers can run their own graceful shutdown - closing automation windows etc. -
 *  first, same as /api/quit already does). */
async function downloadAndPrepareSwap(update) {
    const tmpDir = _deps.tmpDir();
    fs.mkdirSync(tmpDir, { recursive: true });
    const newExePath = path.join(tmpDir, 'coretax-agent-new.exe');
    const sizeLabel = update.assetSize ? ' (' + (update.assetSize / 1024 / 1024).toFixed(1) + ' MB)' : '';
    log('Mengunduh update v' + update.version + sizeLabel + '...');
    const got = await downloadVerified(update.assetUrl, newExePath, { expectedSize: update.assetSize, expectedSha256: update.assetSha256 });
    log('Update terunduh (' + (got.size / 1024 / 1024).toFixed(1) + ' MB, '
        + (got.verifiedBy === 'sha256' ? 'SHA-256 cocok' : got.verifiedBy === 'size' ? 'ukuran cocok; rilis ini tanpa SHA-256' : 'TANPA verifikasi - rilis tidak mencantumkan ukuran/SHA-256')
        + '). Menyiapkan pemasangan...');

    // Self-update only ever makes sense for the packaged exe (dev mode via `node main.js` has no
    // single exe to swap) - process.execPath is that exe's own real path when running under pkg.
    // Deliberately NOT built via path.join with a literal 'dist'/'coretax-agent.exe' segment -
    // pkg's static analyzer read that as a real asset reference and tried to bundle
    // dist/coretax-agent.exe INTO ITSELF ("Trying to take executable into executable"), since
    // that path is this very build's own output.
    const oldExePath = _deps.execPath();

    // Launch the just-downloaded new exe as a completely normal, independent process - the SAME
    // spawn recipe gui/window.js's openWindow() uses for Chrome (both are GUI-subsystem exes,
    // unlike the console-subsystem powershell.exe the old design relied on), confirmed live to
    // survive this app calling process.exit(). --finish-update tells main.js to run
    // finishUpdateHandoff() before normal startup instead of opening its own dashboard right away.
    const child = _deps.spawn(newExePath, ['--finish-update', String(process.pid), oldExePath], {
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
    log('Menunggu Taxio Pilot versi lama (PID ' + oldPid + ') benar-benar tertutup...');
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
        log('Gagal membuka ulang Taxio Pilot: ' + e.message);
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
    _inFlight = _checkAndApply(opts)
        .then((r) => { _onAttemptDone(r); return r; }, (e) => { _onAttemptDone({ outcome: 'failed' }); throw e; })
        .finally(() => { _inFlight = null; });
    return _inFlight;
}
// Explicit user request 2026-08-13: the auto-update-on-startup check is the only thing that
// ever confirms whether this process is running a stale (potentially security-patched-since)
// version - if that single check fails to reach GitHub, gets deferred because a run was active,
// or the apply itself fails partway, nothing else in the app would ever notice or care, and a
// user could keep running an outdated build indefinitely. `_lastKnownOutdated` is this module's
// running answer to "are we confirmed behind, right now" - checkForUpdate() itself already
// fails safe (returns {available:false} on ANY network/GitHub failure, never throws), so this
// only ever reports outdated when a newer release was actually, positively confirmed to exist -
// a network hiccup can't cause a false block.
let _lastKnownOutdated = { outdated: false, latestVersion: null, current: currentVersion() };
function getOutdatedInfo() { return _lastKnownOutdated; }
// Resolves to the checkForUpdate() result plus `outcome`: 'none' (no newer release, or the check
// itself failed - fail-safe, see above), 'deferred' (a run is active), 'failed' (download,
// verification or hand-off failed) or 'restarting' (hand-off launched, onBeforeRestart called).
async function _checkAndApply({ isRunActive, onBeforeRestart } = {}) {
    const update = await checkForUpdate();
    _lastKnownOutdated = { outdated: !!update.available, latestVersion: update.version || null, current: currentVersion() };
    if (!update.available) return Object.assign(update, { outcome: 'none' });
    if (isRunActive && isRunActive()) {
        log('Update v' + update.version + ' ditemukan tapi ada proses otomasi berjalan - ditunda sampai proses selesai.');
        return Object.assign(update, { outcome: 'deferred' });
    }
    try {
        await downloadAndPrepareSwap(update);
    } catch (e) {
        log('Gagal menerapkan update: ' + e.message);
        return Object.assign(update, { outcome: 'failed', error: e.message });
    }
    try { if (onBeforeRestart) await onBeforeRestart(); }
    catch (e) { log('Gagal menutup aplikasi untuk update: ' + e.message); }
    return Object.assign(update, { outcome: 'restarting' });
}

/* Background schedule (replaces main.js's old fixed setTimeout(4s) + setInterval(15 min)).
 * One timer chain, never two attempts at once (checkAndApply's _inFlight guard also covers a
 * manual "Cek Update" click from gui/server.js overlapping a scheduled attempt). After every
 * attempt - scheduled OR manual, since a manual click goes through the same checkAndApply - the
 * next attempt is rescheduled from its outcome: 'failed' -> RETRY_DELAYS_MS in turn (1, 2, 5
 * minutes), then the regular 15-minute cadence; anything else resets the retry ladder and waits
 * the regular 15 minutes. 'deferred' deliberately is NOT treated as a failure (the user is
 * mid-run; the regular cadence picks it up once idle, same as before). */
const RETRY_DELAYS_MS = [60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
const REGULAR_INTERVAL_MS = 15 * 60 * 1000;
let _auto = null; // { opts, timer, failures, stopped }

function _scheduleNext(delayMs) {
    if (!_auto || _auto.stopped) return;
    if (_auto.timer) _deps.clearTimeout(_auto.timer);
    _auto.nextDelayMs = delayMs;
    _auto.timer = _deps.setTimeout(_autoTick, delayMs);
}
function _onAttemptDone(result) {
    if (!_auto || _auto.stopped) return;
    if (result && result.outcome === 'failed') {
        const delay = _auto.failures < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[_auto.failures] : REGULAR_INTERVAL_MS;
        _auto.failures++;
        log('Update akan dicoba lagi dalam ' + Math.round(delay / 60000) + ' menit.');
        _scheduleNext(delay);
    } else {
        _auto.failures = 0;
        _scheduleNext(REGULAR_INTERVAL_MS);
    }
}
function _autoTick() {
    if (!_auto || _auto.stopped) return;
    _auto.timer = null;
    checkAndApply(_auto.opts).catch((e) => log('Cek update gagal: ' + e.message));
}

/** Starts the background check-and-apply schedule: first attempt after `initialDelayMs` (lets
 *  normal startup settle first), then as described above. `opts` = { isRunActive,
 *  onBeforeRestart }, same as checkAndApply. Returns { stop() }. Calling it again replaces the
 *  previous schedule. */
function startAutoUpdate(opts, { initialDelayMs = 4000 } = {}) {
    stopAutoUpdate();
    _auto = { opts: opts || {}, timer: null, failures: 0, stopped: false, nextDelayMs: null };
    _scheduleNext(initialDelayMs);
    return { stop: stopAutoUpdate };
}
function stopAutoUpdate() {
    if (!_auto) return;
    _auto.stopped = true;
    if (_auto.timer) _deps.clearTimeout(_auto.timer);
    _auto = null;
}
/** Test/diagnostic view of the schedule: { failures, nextDelayMs } or null when not started. */
function _autoUpdateState() { return _auto ? { failures: _auto.failures, nextDelayMs: _auto.nextDelayMs, pending: !!_auto.timer } : null; }

module.exports = {
    checkForUpdate, checkAndApply, isNewer, currentVersion, finishUpdateHandoff, getOutdatedInfo,
    startAutoUpdate, stopAutoUpdate, parseSha256Digest, downloadVerified,
    RETRY_DELAYS_MS, REGULAR_INTERVAL_MS, _setTestDeps, _autoUpdateState
};
