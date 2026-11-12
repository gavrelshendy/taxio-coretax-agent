/* Auto-update (explicit user request 2026-08-07: update from inside the app instead of re-downloading from
 * Taxio Hub every release). Since Tahap 2 this is a thin adapter: the actual check / download / install is
 * electron-updater against the GitHub Releases of gavrelshendy/taxio-coretax-agent (latest.yml + the NSIS
 * installer, sha512-verified by electron-updater), injected by electron/main.js through configure({ engine }).
 * This module keeps the PRODUCT behaviour and the surface gui/server.js / gui/guards.js / lib/doctor.js use,
 * and runs under plain node with a fake engine (scripts/test-updater.js). Without an engine (headless
 * `node main.js`, tests, an isolated TAXIO_PILOT_DATA_DIR run, `electron .` in dev) every check answers
 * { available: false } and nothing is ever downloaded.
 *
 * engine = { check(): Promise<{ version, notes } | null>, download(): Promise<void>, install(): void }
 *   check    - newest published version (null = updater inactive); throws on network / GitHub failure
 *   download - downloads + verifies the installer for the version check() just reported
 *   install  - quits the app and runs the installer (electron-updater quitAndInstall, silent, relaunch)
 *
 * Product rules (unchanged from the pkg-era updater):
 *   - first check shortly after start (4 s), then every 15 minutes;
 *   - never installs while an automation run is active (isRunActive -> runcontrol.anyActive()): outcome
 *     'deferred', retried on the normal cadence;
 *   - a FAILED download/apply is retried after 1, 2, then 5 minutes before falling back to 15 minutes
 *     (GitHub often answers 504 for the first minutes after a release, and while a newer version is
 *     confirmed the server refuses new actions with HTTP 426 - see below);
 *   - getOutdatedInfo() stays { outdated: true } from the moment a newer release is positively confirmed
 *     until a later check says otherwise (gui/guards.js rejectIfOutdated). A failed CHECK (offline, rate
 *     limit) never reports outdated - a network hiccup can't lock users out (explicit request 2026-08-13);
 *   - when idle the app quits through its normal graceful quit path (closes the automation Chrome windows)
 *     and only then installs: onBeforeRestart is that path, it ends by calling engine.install().
 *
 * Upgrade from the pkg builds (every coretax-agent.exe 3.0.x - v3.0.44 is the last one published on
 * GitHub when this was written): those versions run their OWN updater, which downloads the
 * first `.exe` asset of the latest GitHub release and launches it as `<file> --finish-update <pid> <exe>`.
 * With the NSIS installer as the only .exe asset that launches the installer (the extra arguments are
 * ignored by it) - see README "Rilis" and lib/legacy-handover.js for the hand-over on first start. */
const { log } = require('./log');

let _engine = null;
let _defaults = {};          // { isRunActive, onBeforeRestart } from configure()

// Swappable from tests only (scripts/test-updater.js): the scheduler's timers.
const _deps = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
};
function _setTestDeps(overrides) { Object.assign(_deps, overrides); }

/** engine (see header) + default opts for checkAndApply. Pass { engine: null } to detach. */
function configure({ engine, isRunActive, onBeforeRestart } = {}) {
    if (engine !== undefined) _engine = engine;
    if (isRunActive !== undefined) _defaults.isRunActive = isRunActive;
    if (onBeforeRestart !== undefined) _defaults.onBeforeRestart = onBeforeRestart;
}
function hasEngine() { return !!_engine; }

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

function notesText(notes) {
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    if (Array.isArray(notes)) return notes.map((n) => (n && (n.note || n.version)) || '').join('\n');
    return String(notes);
}

/** { available, version, notes, current, latestVersion } - never throws: a broken check (no engine,
 *  network down, GitHub rate limit) answers { available: false } and never blocks the app. */
async function checkForUpdate() {
    const current = currentVersion();
    if (!current || !_engine) return { available: false, current };
    try {
        const r = await _engine.check();
        const latestVersion = r && r.version ? String(r.version).replace(/^v/i, '') : null;
        if (!latestVersion || !isNewer(latestVersion, current)) return { available: false, latestVersion, current };
        return { available: true, version: latestVersion, notes: notesText(r.notes), current, latestVersion };
    } catch (e) {
        log('Cek update gagal: ' + (e && e.message || e));
        return { available: false, current };
    }
}

/** Full check-and-apply cycle, safe to call on every startup and from a manual "check now" button alike
 *  (opts default to configure()'s). Never applies while isRunActive() - a self-restart mid-run would
 *  silently kill whatever the user was doing. `onBeforeRestart` is the caller's OWN graceful quit, which
 *  ends by running the installer; this module never exits the process itself.
 *
 *  CONFIRMED LIVE 2026-08-07: the startup auto-check and a near-simultaneous manual "Cek Update" click both
 *  started downloading independently. `_inFlight` makes a second call while one's already running await
 *  the SAME in-progress attempt instead of starting its own. */
let _inFlight = null;
function checkAndApply(opts) {
    if (_inFlight) return _inFlight;
    _inFlight = _checkAndApply(Object.assign({}, _defaults, opts || {}))
        .then((r) => { _onAttemptDone(r); return r; }, (e) => { _onAttemptDone({ outcome: 'failed' }); throw e; })
        .finally(() => { _inFlight = null; });
    return _inFlight;
}
// The module's running answer to "are we confirmed behind, right now" (see header).
let _lastKnownOutdated = { outdated: false, latestVersion: null, current: currentVersion() };
function getOutdatedInfo() { return _lastKnownOutdated; }
// Resolves to the checkForUpdate() result plus `outcome`: 'none' (no newer release, or the check itself
// failed - fail-safe), 'deferred' (a run is active), 'failed' (download/verification failed) or
// 'restarting' (downloaded; onBeforeRestart called, which quits and installs).
async function _checkAndApply({ isRunActive, onBeforeRestart } = {}) {
    const update = await checkForUpdate();
    _lastKnownOutdated = { outdated: !!update.available, latestVersion: update.version || null, current: currentVersion() };
    if (!update.available) return Object.assign(update, { outcome: 'none' });
    if (isRunActive && isRunActive()) {
        log('Update v' + update.version + ' ditemukan tapi ada proses otomasi berjalan - ditunda sampai proses selesai.');
        return Object.assign(update, { outcome: 'deferred' });
    }
    try {
        log('Mengunduh update v' + update.version + '...');
        await _engine.download();
        log('Update v' + update.version + ' terunduh dan terverifikasi - Taxio Pilot akan tertutup, memasang update, lalu terbuka lagi.');
    } catch (e) {
        log('Gagal mengunduh update: ' + (e && e.message || e));
        return Object.assign(update, { outcome: 'failed', error: e && e.message });
    }
    try {
        if (onBeforeRestart) await onBeforeRestart();
        else _engine.install();
    } catch (e) { log('Gagal menutup aplikasi untuk update: ' + e.message); }
    return Object.assign(update, { outcome: 'restarting' });
}

/* Background schedule. One timer chain, never two attempts at once (checkAndApply's _inFlight guard also
 * covers a manual "Cek Update" click overlapping a scheduled attempt). After every attempt - scheduled OR
 * manual - the next one is scheduled from its outcome: 'failed' -> RETRY_DELAYS_MS in turn (1, 2, 5
 * minutes), then the regular 15 minutes; anything else resets the retry ladder and waits 15 minutes.
 * 'deferred' deliberately is NOT a failure (the user is mid-run; the regular cadence picks it up). */
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

/** Starts the background schedule: first attempt after `initialDelayMs`, then as described above. `opts`
 *  overrides configure()'s defaults. Returns { stop() }. Calling it again replaces the previous schedule. */
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
    configure, hasEngine, checkForUpdate, checkAndApply, isNewer, currentVersion, getOutdatedInfo,
    startAutoUpdate, stopAutoUpdate, RETRY_DELAYS_MS, REGULAR_INTERVAL_MS, _setTestDeps, _autoUpdateState
};
