/* Offline tests for lib/updater.js: version compare, release-digest parsing, streamed download
 * verification (SHA-256 ok / mismatch / absent -> size check, truncated, stalled), the full
 * check-and-apply cycle against a FAKE release served from a local http server (the spawn of the
 * downloaded exe is replaced, nothing is ever launched), and the retry/backoff schedule with fake
 * timers. Never contacts GitHub, never touches the real log or data dir. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-updater-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'data');
const updater = require('../lib/updater');

const BODY = crypto.randomBytes(200 * 1024);
const BODY_SHA = crypto.createHash('sha256').update(BODY).digest('hex');
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let release = null; // what /release.json answers (null -> 504)
const server = http.createServer((req, res) => {
    const url = req.url;
    if (url === '/release.json') {
        if (!release) { res.writeHead(504); return res.end('gateway timeout'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(release));
    }
    if (url === '/asset.exe') { res.writeHead(200, { 'Content-Length': BODY.length }); return res.end(BODY); }
    if (url === '/504.exe') { res.writeHead(504); return res.end('x'); }
    if (url === '/truncated.exe') {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 1000));
        return setTimeout(() => res.socket.destroy(), 50);
    }
    if (url === '/stall.exe') { res.writeHead(200, { 'Content-Length': BODY.length }); res.write(BODY.subarray(0, 1000)); return; /* never ends */ }
    if (url === '/noheaders.exe') return; /* never answers */
    res.writeHead(404); res.end();
});

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const spawned = [];
    const updDir = path.join(TMP, 'update');
    updater._setTestDeps({
        releaseApiUrl: base + '/release.json',
        tmpDir: () => updDir,
        execPath: () => path.join(TMP, 'old', 'coretax-agent.exe'),
        spawn: (file, args) => { spawned.push({ file, args }); return { unref() {} }; },
        connectTimeoutMs: 1500,
        idleTimeoutMs: 400
    });
    const newExe = path.join(updDir, 'coretax-agent-new.exe');
    const asset = (over) => Object.assign({ name: 'coretax-agent.exe', browser_download_url: base + '/asset.exe', size: BODY.length, digest: 'sha256:' + BODY_SHA }, over);

    await test('isNewer compares numerically per segment', () => {
        assert.strictEqual(updater.isNewer('1.10.10', '1.10.4'), true);
        assert.strictEqual(updater.isNewer('v3.0.45', '3.0.44'), true);
        assert.strictEqual(updater.isNewer('3.0.44', '3.0.44'), false);
        assert.strictEqual(updater.isNewer('3.0', '3.0.1'), false);
        assert.strictEqual(updater.isNewer('3.1', '3.0.99'), true);
    });

    await test('parseSha256Digest accepts only sha256:<64 hex>', () => {
        assert.strictEqual(updater.parseSha256Digest('sha256:' + BODY_SHA.toUpperCase()), BODY_SHA);
        assert.strictEqual(updater.parseSha256Digest(undefined), null);
        assert.strictEqual(updater.parseSha256Digest('sha1:abcd'), null);
        assert.strictEqual(updater.parseSha256Digest('sha256:1234'), null);
    });

    await test('download with matching SHA-256 succeeds and leaves only the final file', async () => {
        const file = path.join(TMP, 'dl-ok.exe');
        const r = await updater.downloadVerified(base + '/asset.exe', file, { expectedSize: BODY.length, expectedSha256: BODY_SHA });
        assert.strictEqual(r.verifiedBy, 'sha256');
        assert.strictEqual(sha256Of(fs.readFileSync(file)), BODY_SHA);
        assert.ok(!fs.existsSync(file + '.part'));
    });

    await test('download with mismatching SHA-256 fails and deletes everything', async () => {
        const file = path.join(TMP, 'dl-bad.exe');
        fs.writeFileSync(file, 'stale previous download');
        await assert.rejects(updater.downloadVerified(base + '/asset.exe', file, { expectedSize: BODY.length, expectedSha256: 'a'.repeat(64) }), /SHA-256/);
        assert.ok(!fs.existsSync(file) && !fs.existsSync(file + '.part'));
    });

    await test('no digest -> size check is the fallback (ok and mismatch)', async () => {
        const file = path.join(TMP, 'dl-size.exe');
        const r = await updater.downloadVerified(base + '/asset.exe', file, { expectedSize: BODY.length });
        assert.strictEqual(r.verifiedBy, 'size');
        await assert.rejects(updater.downloadVerified(base + '/asset.exe', file, { expectedSize: BODY.length + 1 }), /Ukuran file/);
        assert.ok(!fs.existsSync(file) && !fs.existsSync(file + '.part'));
    });

    await test('truncated download fails and leaves no file', async () => {
        const file = path.join(TMP, 'dl-trunc.exe');
        await assert.rejects(updater.downloadVerified(base + '/truncated.exe', file, { expectedSize: BODY.length }));
        assert.ok(!fs.existsSync(file) && !fs.existsSync(file + '.part'));
    });

    await test('stalled download fails on the idle timeout instead of hanging', async () => {
        const file = path.join(TMP, 'dl-stall.exe');
        const t0 = Date.now();
        await assert.rejects(updater.downloadVerified(base + '/stall.exe', file, { expectedSize: BODY.length }), /terhenti/);
        assert.ok(Date.now() - t0 < 5000);
        assert.ok(!fs.existsSync(file) && !fs.existsSync(file + '.part'));
    });

    await test('server that never answers fails on the connect timeout', async () => {
        const file = path.join(TMP, 'dl-nohead.exe');
        await assert.rejects(updater.downloadVerified(base + '/noheaders.exe', file, {}), /terhenti/);
        assert.ok(!fs.existsSync(file + '.part'));
    });

    await test('checkAndApply: verified download -> hand-off spawned, onBeforeRestart called', async () => {
        release = { tag_name: 'v99.0.0', body: '', assets: [asset()] };
        let restarted = 0;
        const r = await updater.checkAndApply({ isRunActive: () => false, onBeforeRestart: async () => { restarted++; } });
        assert.strictEqual(r.outcome, 'restarting');
        assert.strictEqual(r.assetSha256, BODY_SHA);
        assert.strictEqual(restarted, 1);
        assert.strictEqual(spawned.length, 1);
        assert.strictEqual(spawned[0].file, newExe);
        assert.deepStrictEqual(spawned[0].args, ['--finish-update', String(process.pid), path.join(TMP, 'old', 'coretax-agent.exe')]);
        assert.strictEqual(sha256Of(fs.readFileSync(newExe)), BODY_SHA);
        assert.strictEqual(updater.getOutdatedInfo().outdated, true);
    });

    await test('checkAndApply: digest mismatch -> failed, nothing launched, file deleted', async () => {
        spawned.length = 0;
        release = { tag_name: 'v99.0.0', assets: [asset({ digest: 'sha256:' + 'b'.repeat(64) })] };
        let restarted = 0;
        const r = await updater.checkAndApply({ isRunActive: () => false, onBeforeRestart: async () => { restarted++; } });
        assert.strictEqual(r.outcome, 'failed');
        assert.strictEqual(spawned.length, 0);
        assert.strictEqual(restarted, 0);
        assert.ok(!fs.existsSync(newExe));
    });

    await test('checkAndApply: run active -> deferred, no download', async () => {
        release = { tag_name: 'v99.0.0', assets: [asset()] };
        const r = await updater.checkAndApply({ isRunActive: () => true });
        assert.strictEqual(r.outcome, 'deferred');
        assert.strictEqual(spawned.length, 0);
    });

    await test('checkAndApply: concurrent calls share one attempt', async () => {
        release = { tag_name: 'v99.0.0', assets: [asset({ browser_download_url: base + '/504.exe' })] };
        const a = updater.checkAndApply({});
        const b = updater.checkAndApply({});
        assert.strictEqual(a, b);
        assert.strictEqual((await a).outcome, 'failed');
    });

    await test('checkAndApply: release API down -> not outdated (fail-safe)', async () => {
        release = null;
        const r = await updater.checkAndApply({});
        assert.strictEqual(r.outcome, 'none');
        assert.strictEqual(updater.getOutdatedInfo().outdated, false);
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

        release = { tag_name: 'v99.0.0', assets: [asset({ browser_download_url: base + '/504.exe' })] };
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
        release = { tag_name: 'v0.0.1', assets: [] };
        await fire();
        assert.strictEqual(live()[0].ms, 900000);
        assert.strictEqual(updater._autoUpdateState().failures, 0);

        updater.stopAutoUpdate();
        assert.strictEqual(live().length, 0);
        assert.strictEqual(updater._autoUpdateState(), null);
    });

    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
