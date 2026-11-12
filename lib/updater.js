/* Auto-update (explicit user request 2026-08-07: update from inside the app instead of re-downloading from
 * Taxio Hub every release). Since Tahap 2 this is a thin adapter: the actual check / download / install is
 * electron-updater, injected by electron/main.js through configure({ engine }). This module keeps the
 * PRODUCT behaviour and the surface gui/server.js / gui/guards.js / lib/doctor.js use, and runs under plain
 * node with a fake engine (scripts/test-updater.js). Without an engine (headless `node main.js`, tests,
 * `electron .` in dev, an isolated TAXIO_PILOT_DATA_DIR run without TAXIO_PILOT_UPDATE_FEED) every check
 * answers { available: false } and nothing is ever downloaded.
 *
 * UPDATE CHANNEL (v4.0.0): electron-updater's GENERIC provider on FEED_URL below = the assets of ONE fixed
 * GitHub release tagged `pilot-v4` (pre-release, never "latest"): latest.yml + taxio-pilot-setup-<ver>.exe
 * (+ .blockmap), replaced on every v4 release. NOT /releases/latest, because that endpoint belongs to the
 * old pkg exes (coretax-agent.exe 3.0.x), whose own updater force-installs the first .exe asset of whatever
 * release is "latest". Consequences (README "Rilis dan update otomatis"):
 *   - 3.0.x users never see v4 unless the owner deliberately publishes the v4 installer in a release
 *     marked latest ("migrate everyone"); re-marking v3.0.50 as latest stops migrating;
 *   - a 3.0.x maintenance release marked latest no longer breaks v4's update check (it has no latest.yml).
 * Generic provider facts (electron-updater 6.8.11 source): latest.yml = new URL('latest.yml', FEED_URL)
 * with `?noCache=<time>` appended (no Authorization header => isAddNoCacheQuery); the installer URL =
 * new URL(<path from latest.yml>, FEED_URL) (no cache-buster - the file name carries the version);
 * redirects (github.com -> release-assets.githubusercontent.com, 302 Cache-Control: no-cache) are followed
 * manually, up to 10; sha512 from latest.yml is verified after download.
 *
 * engine = { check(): Promise<{ version, notes, size } | null>, download(): Promise<void>, install(): void }
 *   check    - newest published version (null = updater inactive); throws on network / feed failure
 *   download - downloads + verifies (sha512) the installer for the version check() just reported
 *   install  - quits the app and runs the installer (electron-updater quitAndInstall, silent, relaunch)
 *
 * Product rules:
 *   - first check shortly after start (4 s), then every 15 minutes;
 *   - never installs while an automation run is active (isRunActive -> runcontrol.anyActive()): outcome
 *     'deferred', retried on the normal cadence;
 *   - a FAILED download/apply is retried after 1, 2, then 5 minutes before falling back to 15 minutes;
 *   - getOutdatedInfo() reports { outdated: true } from the moment a newer release is positively confirmed
 *     (gui/guards.js rejectIfOutdated -> HTTP 426 for new actions). A failed CHECK (offline, 404) never
 *     reports outdated - a network hiccup can't lock users out (explicit request 2026-08-13). Two more
 *     exceptions (v4.0.0) keep users from being locked out by an update that cannot be applied:
 *       reason 'download-failed' - the retry ladder (1, 2, 5 min) is exhausted without a successful
 *         download: the gate is lifted (one notice) until a later attempt downloads successfully;
 *       reason 'install-failed'  - the installer already failed MAX_AUTO_ATTEMPTS (2) times for that
 *         version (lib/update-guard.js: a record is written before quitting to install, and checked at the
 *         next start); that version is no longer auto-installed and does not gate actions. A manual
 *         "Check for updates" still tries (one attempt per click);
 *   - when idle the app quits through its normal graceful quit path (closes the automation Chrome windows)
 *     and only then installs: onBeforeRestart is that path, it ends by calling engine.install();
 *   - verifyOnly (TAXIO_PILOT_UPDATE_VERIFY_ONLY=1, and always in an isolated run): check + download +
 *     verify, log the result, never quit / install (outcome 'verified').
 *
 * Upgrade from the pkg builds: see README "Rilis" and lib/legacy-handover.js. */
const path = require('path');
const { log, showPopup } = require('./log');

const REPO = 'gavrelshendy/taxio-coretax-agent';
const CHANNEL_TAG = 'pilot-v4';
const FEED_URL = 'https://github.com/' + REPO + '/releases/download/' + CHANNEL_TAG + '/';
const RELEASE_PAGE_URL = 'https://github.com/' + REPO + '/releases/tag/' + CHANNEL_TAG;
/** Versi 3 terakhir (exe pkg) - tautan "Kembali ke versi 3". */
const V3_VERSION = '3.0.50';
const V3_RELEASE_URL = 'https://github.com/' + REPO + '/releases/tag/v' + V3_VERSION;

let _engine = null;
let _defaults = {};          // { isRunActive, onBeforeRestart } from configure()
let _verifyOnly = false;
let _feedUrl = FEED_URL;
let _guard = null;
let _notify = (msg, title, level) => showPopup(msg, title, level);

// Swappable from tests only (scripts/test-updater.js): the scheduler's timers.
const _deps = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
};
function _setTestDeps(overrides) { Object.assign(_deps, overrides); }

/** engine (see header) + default opts for checkAndApply. Pass { engine: null } to detach.
 *  guard: lib/update-guard.js instance (default: file <data root>\update-install.json); notify(msg,
 *  title, level): in-app notice (default lib/log.js showPopup); feedUrl: base URL (direct-download links). */
function configure({ engine, isRunActive, onBeforeRestart, verifyOnly, guard, notify, feedUrl } = {}) {
    if (engine !== undefined) _engine = engine;
    if (isRunActive !== undefined) _defaults.isRunActive = isRunActive;
    if (onBeforeRestart !== undefined) _defaults.onBeforeRestart = onBeforeRestart;
    if (verifyOnly !== undefined) _verifyOnly = !!verifyOnly;
    if (guard !== undefined) _guard = guard;
    if (notify !== undefined) _notify = notify;
    if (feedUrl !== undefined) _feedUrl = feedUrl || FEED_URL;
}
function hasEngine() { return !!_engine; }

function installGuard() {
    if (!_guard) {
        const { createInstallGuard, fileStorage } = require('./update-guard');
        const paths = require('./paths');
        _guard = createInstallGuard({ storage: fileStorage(path.join(paths.root(), 'update-install.json')), current: currentVersion });
    }
    return _guard;
}

function currentVersion() {
    try { return require('../package.json').version; } catch (e) { return null; }
}

/** Direct download link of the installer of `version` on the update channel. */
function installerUrl(version, feedUrl) {
    return (feedUrl || _feedUrl).replace(/\/?$/, '/') + 'taxio-pilot-setup-' + String(version).replace(/^v/i, '') + '.exe';
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

/** { available, version, notes, current, latestVersion, size } - never throws: a broken check (no engine,
 *  network down, feed 404) answers { available: false } and never blocks the app. */
async function checkForUpdate() {
    const current = currentVersion();
    if (!current || !_engine) return { available: false, current };
    try {
        const r = await _engine.check();
        const latestVersion = r && r.version ? String(r.version).replace(/^v/i, '') : null;
        if (!latestVersion || !isNewer(latestVersion, current)) return { available: false, latestVersion, current };
        return { available: true, version: latestVersion, notes: notesText(r.notes), current, latestVersion, size: r.size || null };
    } catch (e) {
        log('Cek update gagal: ' + (e && e.message || e).toString().split('\n')[0]);
        return { available: false, current };
    }
}

/** Download progress -> one log line per 20% (like the bundled-Chrome download in lib/browser.js), so a
 *  ~135 MB download shows up in the dashboard instead of looking frozen. Returns fn(progress) taking
 *  electron-updater's 'download-progress' payload { percent, transferred, total }. */
function progressLogger(version, logFn) {
    const out = logFn || log;
    let shown = 0;
    return (p) => {
        const pct = Math.floor(Number(p && p.percent) || 0);
        if (pct < shown + 20 || shown >= 100) return;
        shown = Math.min(100, pct - pct % 20);
        const mb = (n) => (Number(n) / 1048576).toFixed(0);
        out('Mengunduh update v' + version + ': ' + shown + '%' + (p.total ? ' (' + mb(p.transferred) + ' / ' + mb(p.total) + ' MB)' : ''));
    };
}

/** Full check-and-apply cycle, safe to call on every startup and from a manual "check now" button alike
 *  (opts default to configure()'s; opts.manual = the user clicked "Check for updates"). Never applies while
 *  isRunActive() - a self-restart mid-run would silently kill whatever the user was doing. `onBeforeRestart`
 *  is the caller's OWN graceful quit, which ends by running the installer; this module never exits the
 *  process itself.
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
// The module's running answer to "is a newer release confirmed, right now" (see header).
let _lastKnownOutdated = { outdated: false, latestVersion: null, current: currentVersion() };
let _gaveUp = null;          // version whose download retry ladder is exhausted (gate lifted)
let _gaveUpNotified = null;  // version the 'download-failed' notice was shown for
let _blockedLogged = null;   // version the 'install-failed, not auto-installing' line was logged for

/** { outdated, latestVersion, current, reason? } - see header for when the gate is lifted. */
function getOutdatedInfo() {
    const info = _lastKnownOutdated;
    if (!info.outdated) return info;
    let blocked = false;
    try { blocked = installGuard().isBlocked(info.latestVersion); } catch (e) { blocked = false; }
    if (blocked) return Object.assign({}, info, { outdated: false, reason: 'install-failed' });
    if (_gaveUp && _gaveUp === info.latestVersion) return Object.assign({}, info, { outdated: false, reason: 'download-failed' });
    return info;
}
// Resolves to the checkForUpdate() result plus `outcome`: 'none' (no newer release, or the check itself
// failed - fail-safe), 'blocked' (this version already failed to install MAX times; automatic attempts
// skip it), 'deferred' (a run is active), 'failed' (download/verification failed), 'verified' (verify-only
// mode: downloaded + verified, not installed) or 'restarting' (downloaded; onBeforeRestart called, which
// quits and installs).
async function _checkAndApply({ isRunActive, onBeforeRestart, manual } = {}) {
    const update = await checkForUpdate();
    _lastKnownOutdated = { outdated: !!update.available, latestVersion: update.version || null, current: currentVersion() };
    if (!update.available) { _gaveUp = null; return Object.assign(update, { outcome: 'none' }); }
    const guard = installGuard();
    if (!manual && guard.isBlocked(update.version)) {
        if (_blockedLogged !== update.version) {
            _blockedLogged = update.version;
            log('Update v' + update.version + ' tidak dipasang otomatis lagi: pemasangannya sudah gagal ' + guard.record().attempts + ' kali (kemungkinan diblokir antivirus/SmartScreen). Aksi tetap bisa dipakai. Pasang manual: ' + installerUrl(update.version));
        }
        return Object.assign(update, { outcome: 'blocked' });
    }
    if (isRunActive && isRunActive()) {
        log('Update v' + update.version + ' ditemukan tapi ada proses otomasi berjalan - ditunda sampai proses selesai.');
        return Object.assign(update, { outcome: 'deferred' });
    }
    try {
        log('Mengunduh update v' + update.version + (update.size ? ' (' + (update.size / 1048576).toFixed(0) + ' MB)' : '') + '...');
        await _engine.download();
    } catch (e) {
        log('Gagal mengunduh update v' + update.version + ': ' + String(e && e.message || e).split('\n')[0]);
        return Object.assign(update, { outcome: 'failed', error: e && e.message });
    }
    _gaveUp = null;
    if (_verifyOnly) {
        log('UJI-UPDATE: v' + update.version + ' ditemukan, terunduh, dan sha512-nya cocok dengan latest.yml - mode verifikasi saja (TAXIO_PILOT_UPDATE_VERIFY_ONLY / terisolasi): TIDAK dipasang, aplikasi tidak ditutup.');
        return Object.assign(update, { outcome: 'verified' });
    }
    log('Update v' + update.version + ' terunduh dan terverifikasi - Taxio Pilot akan tertutup, memasang update, lalu terbuka lagi.');
    try { guard.beforeInstall(update.version); }
    catch (e) { log('Catatan percobaan pemasangan update tidak bisa ditulis (diabaikan): ' + e.message); }
    try {
        if (onBeforeRestart) await onBeforeRestart();
        else _engine.install();
    } catch (e) { log('Gagal menutup aplikasi untuk update: ' + e.message); }
    return Object.assign(update, { outcome: 'restarting' });
}

/** At startup (before the first check): did the last "quit to install" actually install? Logs one line,
 *  and when it failed shows an in-app notice with the direct download link. Never throws. Resolves the
 *  lib/update-guard.js startup() result. */
function checkPreviousInstall() {
    let r;
    try { r = installGuard().startup(); } catch (e) { log('Catatan percobaan pemasangan update tidak terbaca (diabaikan): ' + e.message); return { status: 'none', blocked: false }; }
    if (r.status === 'succeeded') log('Update ke v' + r.target + ' berhasil dipasang.');
    if (r.status === 'failed') {
        const link = installerUrl(r.target);
        log('Pemasangan update v' + r.target + ' GAGAL (percobaan ke-' + r.attempts + '): Taxio Pilot masih v' + currentVersion() + '. Kemungkinan installer diblokir antivirus/SmartScreen. '
            + (r.blocked ? 'Versi ini tidak dipasang otomatis lagi dan aksi tidak diblokir.' : 'Akan dicoba sekali lagi secara otomatis.') + ' Pasang manual: ' + link);
        try {
            _notify('Pemasangan update Taxio Pilot v' + r.target + ' gagal - aplikasi masih v' + currentVersion() + '. Kemungkinan installer diblokir antivirus atau SmartScreen.\n'
                + (r.blocked ? 'Update ini tidak akan dipasang otomatis lagi, dan semua aksi tetap bisa dipakai.\n' : 'Taxio Pilot akan mencobanya sekali lagi.\n')
                + 'Pasang manual: unduh ' + link + ' lalu jalankan (bila SmartScreen muncul: "More info" -> "Run anyway").', 'Update gagal dipasang', 'Warning');
        } catch (e) { /* notice opsional */ }
    }
    return r;
}

/* Background schedule. One timer chain, never two attempts at once (checkAndApply's _inFlight guard also
 * covers a manual "Cek Update" click overlapping a scheduled attempt). After every attempt - scheduled OR
 * manual - the next one is scheduled from its outcome: 'failed' -> RETRY_DELAYS_MS in turn (1, 2, 5
 * minutes), then the regular 15 minutes (and the gate is lifted: reason 'download-failed'); anything else
 * resets the retry ladder and waits 15 minutes. 'deferred' deliberately is NOT a failure (the user is
 * mid-run; the regular cadence picks it up). */
const RETRY_DELAYS_MS = [60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
const REGULAR_INTERVAL_MS = 15 * 60 * 1000;
let _auto = null; // { opts, timer, failures, stopped }

function _scheduleNext(delayMs) {
    if (!_auto || _auto.stopped) return;
    if (_auto.timer) _deps.clearTimeout(_auto.timer);
    _auto.nextDelayMs = delayMs;
    _auto.timer = _deps.setTimeout(_autoTick, delayMs);
}
function _giveUp(version) {
    if (!version) return;
    _gaveUp = version;
    if (_gaveUpNotified === version) return;
    _gaveUpNotified = version;
    log('Update v' + version + ' gagal diunduh ' + (RETRY_DELAYS_MS.length + 1) + ' kali berturut-turut - aksi tidak lagi diblokir sampai unduhan berhasil (dicoba lagi tiap 15 menit).');
    try {
        _notify('Update Taxio Pilot v' + version + ' belum bisa diunduh (koneksi ke GitHub gagal beberapa kali). Semua aksi tetap bisa dipakai; unduhan dicoba lagi otomatis tiap 15 menit.\nPasang manual: ' + installerUrl(version), 'Update tertunda', 'Warning');
    } catch (e) { /* notice opsional */ }
}
function _onAttemptDone(result) {
    if (!_auto || _auto.stopped) return;
    if (result && result.outcome === 'failed') {
        const delay = _auto.failures < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[_auto.failures] : REGULAR_INTERVAL_MS;
        _auto.failures++;
        if (_auto.failures > RETRY_DELAYS_MS.length) _giveUp(result.version);
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
    configure, hasEngine, checkForUpdate, checkAndApply, checkPreviousInstall, isNewer, currentVersion, getOutdatedInfo,
    progressLogger, installerUrl, startAutoUpdate, stopAutoUpdate, RETRY_DELAYS_MS, REGULAR_INTERVAL_MS,
    REPO, CHANNEL_TAG, FEED_URL, RELEASE_PAGE_URL, V3_VERSION, V3_RELEASE_URL, _setTestDeps, _autoUpdateState
};
