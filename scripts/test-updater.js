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

    const engine = fakeEngine();
    let quits = 0;
    updater.configure({ engine, isRunActive: () => false, onBeforeRestart: async () => { quits++; engine.install(); } });

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
        assert.strictEqual(updater.getOutdatedInfo().outdated, true);

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
