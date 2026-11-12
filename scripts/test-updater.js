/* Offline tests for lib/updater.js (Tahap 2: thin adapter over an injected electron-updater "engine").
 * Uses a FAKE engine - never contacts GitHub, never installs anything: version compare, no engine =>
 * never outdated, check/download/install flow with the graceful-quit hook, run active => deferred, failed
 * download, check failure => fail-safe (not outdated), concurrent calls share one attempt, and the
 * retry/backoff schedule (1, 2, 5 min, then 15) with fake timers. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-updater-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'data');
const updater = require('../lib/updater');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

/** Fake electron-updater engine: `latest` = version check() reports (null -> updater inactive, Error -> throws). */
function fakeEngine() {
    const e = {
        latest: null, downloadFails: false, calls: { check: 0, download: 0, install: 0 },
        async check() { e.calls.check++; if (e.latest instanceof Error) throw e.latest; return e.latest ? { version: e.latest, notes: 'catatan' } : null; },
        async download() { e.calls.download++; await new Promise((r) => setImmediate(r)); if (e.downloadFails) throw new Error('HTTP 504'); },
        install() { e.calls.install++; }
    };
    return e;
}

(async () => {
    await test('isNewer compares numerically per segment', () => {
        assert.strictEqual(updater.isNewer('1.10.10', '1.10.4'), true);
        assert.strictEqual(updater.isNewer('v3.0.45', '3.0.44'), true);
        assert.strictEqual(updater.isNewer('3.0.44', '3.0.44'), false);
        assert.strictEqual(updater.isNewer('3.0', '3.0.1'), false);
        assert.strictEqual(updater.isNewer('3.1', '3.0.99'), true);
    });

    await test('no engine (headless / tests / isolated run): never available, never outdated', async () => {
        assert.strictEqual(updater.hasEngine(), false);
        const r = await updater.checkAndApply({});
        assert.strictEqual(r.available, false);
        assert.strictEqual(r.outcome, 'none');
        assert.strictEqual(updater.getOutdatedInfo().outdated, false);
    });

    await test('v4 channel: version 4.0.0, generic feed = package.json build.publish, never /releases/latest', () => {
        const pkg = require('../package.json');
        assert.strictEqual(pkg.version, '4.0.0');
        assert.strictEqual(require('../package-lock.json').version, '4.0.0');
        assert.strictEqual(require('../package-lock.json').packages[''].version, '4.0.0');
        assert.deepStrictEqual(pkg.build.publish, [{ provider: 'generic', url: updater.FEED_URL }]);
        assert.strictEqual(updater.FEED_URL, 'https://github.com/gavrelshendy/taxio-coretax-agent/releases/download/pilot-v4/');
        assert.ok(!/latest/.test(updater.FEED_URL));
        assert.strictEqual(updater.installerUrl('4.0.1'), updater.FEED_URL + 'taxio-pilot-setup-4.0.1.exe');
        assert.strictEqual(updater.installerUrl('v4.0.1', 'http://127.0.0.1:9/feed'), 'http://127.0.0.1:9/feed/taxio-pilot-setup-4.0.1.exe');
        assert.strictEqual(pkg.build.nsis.artifactName, 'taxio-pilot-setup-${version}.${ext}');
    });

    await test('progressLogger: one line per 20%, never repeats, sizes in MB', () => {
        const lines = [];
        const p = updater.progressLogger('4.0.1', (l) => lines.push(l));
        const total = 135 * 1048576;
        for (let pct = 0; pct <= 100; pct += 3) p({ percent: pct, transferred: total * pct / 100, total });
        p({ percent: 100, transferred: total, total });
        p({ percent: 100, transferred: total, total });
        assert.deepStrictEqual(lines.map((l) => /: (\d+)%/.exec(l)[1]), ['20', '40', '60', '80', '100']);
        assert.ok(/^Mengunduh update v4\.0\.1: 20% \(\d+ \/ 135 MB\)$/.test(lines[0]), lines[0]);
    });

    const engine = fakeEngine();
    let quits = 0;
    const notices = [];
    const { createInstallGuard } = require('../lib/update-guard');
    const guardStore = { data: null, read() { return this.data; }, write(o) { this.data = JSON.parse(JSON.stringify(o)); }, clear() { this.data = null; } };
    updater.configure({
        engine, isRunActive: () => false, onBeforeRestart: async () => { quits++; engine.install(); },
        guard: createInstallGuard({ storage: guardStore, current: updater.currentVersion }),
        notify: (msg, title, level) => notices.push({ msg, title, level })
    });

    await test('newer release: downloaded, graceful quit hook runs and ends in install', async () => {
        engine.latest = '99.0.0';
        const r = await updater.checkAndApply();
        assert.strictEqual(r.outcome, 'restarting');
        assert.strictEqual(r.version, '99.0.0');
        assert.deepStrictEqual([engine.calls.download, quits, engine.calls.install], [1, 1, 1]);
        assert.deepStrictEqual(updater.getOutdatedInfo(), { outdated: true, latestVersion: '99.0.0', current: updater.currentVersion() });
    });

    await test('same / older version: none, not outdated, nothing downloaded', async () => {
        engine.latest = updater.currentVersion();
        const before = engine.calls.download;
        assert.strictEqual((await updater.checkAndApply()).outcome, 'none');
        assert.strictEqual(updater.getOutdatedInfo().outdated, false);
        engine.latest = '0.0.1';
        assert.strictEqual((await updater.checkAndApply()).outcome, 'none');
        assert.strictEqual(engine.calls.download, before);
    });

    await test('run active: deferred (no download) but the outdated gate is on', async () => {
        engine.latest = '99.0.0';
        const before = engine.calls.download;
        const r = await updater.checkAndApply({ isRunActive: () => true });
        assert.strictEqual(r.outcome, 'deferred');
        assert.strictEqual(engine.calls.download, before);
        assert.strictEqual(updater.getOutdatedInfo().outdated, true);
    });

    await test('download fails: failed, no quit/install, still outdated', async () => {
        engine.latest = '99.0.0'; engine.downloadFails = true;
        const q = quits, inst = engine.calls.install;
        const r = await updater.checkAndApply();
        assert.strictEqual(r.outcome, 'failed');
        assert.ok(/504/.test(r.error));
        assert.deepStrictEqual([quits, engine.calls.install], [q, inst]);
        assert.strictEqual(updater.getOutdatedInfo().outdated, true);
        engine.downloadFails = false;
    });

    await test('check fails (offline / rate limit): fail-safe, not outdated; updater inactive (null) too', async () => {
        engine.latest = new Error('net::ERR_INTERNET_DISCONNECTED');
        assert.strictEqual((await updater.checkAndApply()).outcome, 'none');
        assert.strictEqual(updater.getOutdatedInfo().outdated, false);
        engine.latest = null;
        assert.strictEqual((await updater.checkForUpdate()).available, false);
    });

    await test('concurrent calls share one attempt', async () => {
        engine.latest = '99.0.0'; engine.downloadFails = true;
        const a = updater.checkAndApply();
        const b = updater.checkAndApply();
        assert.strictEqual(a, b);
        assert.strictEqual((await a).outcome, 'failed');
        engine.downloadFails = false;
    });

    await test('startAutoUpdate: retries after 1, 2, 5 min on failure, then 15 min; resets after success/deferral', async () => {
        const timers = [];
        updater._setTestDeps({
            setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
            clearTimeout: (t) => { if (t) t.cleared = true; }
        });
        const live = () => timers.filter((t) => !t.cleared && !t.fired);
        const fire = async () => {
            const pending = live();
            assert.strictEqual(pending.length, 1, 'exactly one pending schedule timer');
            pending[0].fired = true;
            pending[0].fn();
            await updater.checkAndApply({}); // joins the in-flight attempt the tick started
        };
        let runActive = false;
        updater.startAutoUpdate({ isRunActive: () => runActive }, { initialDelayMs: 4000 });
        assert.strictEqual(live()[0].ms, 4000);

        engine.latest = '99.0.0'; engine.downloadFails = true;
        const seen = [];
        for (let i = 0; i < 5; i++) { await fire(); seen.push(live()[0].ms); }
        assert.deepStrictEqual(seen, [60000, 120000, 300000, 900000, 900000]);
        // Ladder (1, 2, 5 min) exhausted without a successful download: the gate is lifted, one notice.
        const lifted = updater.getOutdatedInfo();
        assert.deepStrictEqual([lifted.outdated, lifted.reason, lifted.latestVersion], [false, 'download-failed', '99.0.0']);
        assert.strictEqual(notices.filter((n) => n.title === 'Update tertunda').length, 1);
        assert.ok(notices.find((n) => n.title === 'Update tertunda').msg.includes(updater.installerUrl('99.0.0')));

        // A deferral is not a failure: regular cadence, ladder reset.
        runActive = true;
        await fire();
        assert.strictEqual(live()[0].ms, 900000);
        assert.strictEqual(updater._autoUpdateState().failures, 0);
        runActive = false;

        // Fails again -> ladder starts from 1 minute.
        await fire();
        assert.strictEqual(live()[0].ms, 60000);

        // A manual attempt (gui/server.js "Cek Update") that fails also feeds the ladder, and
        // never leaves two schedule timers.
        await updater.checkAndApply({});
        assert.strictEqual(live().length, 1);
        assert.strictEqual(live()[0].ms, 120000);

        // No newer release -> regular cadence.
        engine.latest = '0.0.1'; engine.downloadFails = false;
        await fire();
        assert.strictEqual(live()[0].ms, 900000);
        assert.strictEqual(updater._autoUpdateState().failures, 0);

        updater.stopAutoUpdate();
        assert.strictEqual(live().length, 0);
        assert.strictEqual(updater._autoUpdateState(), null);

        // Gate: still ON during the ladder, lifted once exhausted, back ON when a later download succeeds.
        guardStore.data = null;
        updater.startAutoUpdate({}, { initialDelayMs: 4000 });
        engine.latest = '99.0.0'; engine.downloadFails = true;
        const gate = [];
        for (let i = 0; i < 4; i++) { await fire(); gate.push(updater.getOutdatedInfo().outdated); }
        assert.deepStrictEqual(gate, [true, true, true, false]);
        assert.strictEqual(notices.filter((n) => n.title === 'Update tertunda').length, 1, 'notice once per version');
        engine.downloadFails = false;
        const q = quits;
        await fire();
        assert.strictEqual(quits, q + 1, 'later attempt downloaded and went on to install');
        assert.deepStrictEqual(updater.getOutdatedInfo(), { outdated: true, latestVersion: '99.0.0', current: updater.currentVersion() });
        updater.stopAutoUpdate();
        guardStore.data = null;
    });

    await test('previous install: success clears the record; failure logs + notice with the direct link', async () => {
        guardStore.data = { target: updater.currentVersion(), attempts: 1 };
        assert.strictEqual(updater.checkPreviousInstall().status, 'succeeded');
        assert.strictEqual(guardStore.data, null);

        notices.length = 0;
        guardStore.data = { target: '99.0.0', attempts: 1, firstAt: 'x', lastAt: 'x' };
        const r = updater.checkPreviousInstall();
        assert.deepStrictEqual([r.status, r.blocked], ['failed', false]);
        assert.strictEqual(notices.length, 1);
        assert.ok(notices[0].msg.includes(updater.installerUrl('99.0.0')));
        assert.ok(/sekali lagi/.test(notices[0].msg));
        assert.strictEqual(notices[0].level, 'Warning');
        // first failure: still auto-installed once more, and the gate stays on meanwhile
        engine.latest = '99.0.0';
        assert.strictEqual((await updater.checkAndApply({ isRunActive: () => true })).outcome, 'deferred');
        assert.strictEqual(updater.getOutdatedInfo().outdated, true);
        const log = fs.readFileSync(process.env.TAXIO_PILOT_LOG_FILE, 'utf8');
        assert.ok(/Pemasangan update v99\.0\.0 GAGAL \(percobaan ke-1\)/.test(log));
    });

    await test('install failed twice: no auto install, no gate; manual check still tries; newer release is tried', async () => {
        notices.length = 0;
        guardStore.data = { target: '99.0.0', attempts: 2, firstAt: 'x', lastAt: 'x' };
        const r = updater.checkPreviousInstall();
        assert.deepStrictEqual([r.status, r.blocked], ['failed', true]);
        assert.ok(/tidak akan dipasang otomatis lagi/.test(notices[0].msg));
        engine.latest = '99.0.0';
        const d0 = engine.calls.download, q0 = quits;
        const a = await updater.checkAndApply();
        assert.strictEqual(a.outcome, 'blocked');
        assert.deepStrictEqual([engine.calls.download, quits], [d0, q0]);
        const info = updater.getOutdatedInfo();
        assert.deepStrictEqual([info.outdated, info.reason, info.latestVersion], [false, 'install-failed', '99.0.0']);
        const { rejectIfOutdated } = require('../gui/guards');
        assert.strictEqual(rejectIfOutdated({ writeHead() {}, end() {} }), false, 'no 426 for a version that cannot be installed');
        // manual "Check for updates": one attempt
        const m = await updater.checkAndApply({ manual: true });
        assert.strictEqual(m.outcome, 'restarting');
        assert.deepStrictEqual([engine.calls.download, quits], [d0 + 1, q0 + 1]);
        assert.strictEqual(guardStore.data.attempts, 3);
        // a newer release than the blocked one is installed normally
        engine.latest = '99.0.1';
        assert.strictEqual((await updater.checkAndApply()).outcome, 'restarting');
        assert.deepStrictEqual([guardStore.data.target, guardStore.data.attempts], ['99.0.1', 1]);
        guardStore.data = null;
    });

    await test('verifyOnly: downloads + verifies, never quits/installs, writes no install record', async () => {
        updater.configure({ verifyOnly: true });
        try {
            engine.latest = '99.0.0';
            const d0 = engine.calls.download, q0 = quits, i0 = engine.calls.install;
            const r = await updater.checkAndApply();
            assert.strictEqual(r.outcome, 'verified');
            assert.deepStrictEqual([engine.calls.download, quits, engine.calls.install], [d0 + 1, q0, i0]);
            assert.strictEqual(guardStore.data, null);
            assert.ok(/UJI-UPDATE: v99\.0\.0 ditemukan, terunduh/.test(fs.readFileSync(process.env.TAXIO_PILOT_LOG_FILE, 'utf8')));
        } finally { updater.configure({ verifyOnly: false }); }
    });

    await test('outdated gate: server refuses new actions with 426 while outdated', async () => {
        engine.latest = '99.0.0';
        await updater.checkAndApply({ isRunActive: () => true });
        const { rejectIfOutdated } = require('../gui/guards');
        let status = null, body = null;
        const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
        assert.strictEqual(rejectIfOutdated(res), true);
        assert.strictEqual(status, 426);
        assert.strictEqual(body.latestVersion, '99.0.0');
        engine.latest = '0.0.1';
        await updater.checkAndApply({});
        assert.strictEqual(rejectIfOutdated(res), false);
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
