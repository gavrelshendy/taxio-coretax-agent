/* Offline tests for gui/run-wrappers.js with fake slow work: guarded() timeout / Stop still replies at once with
 * v3.0.45's shapes and messages, but the session stays busy (409 "Sesi ini masih menjalankan ...") until the
 * abandoned work has really settled; a hard upper bound releases it with a log line; runcontrol.finish(run)
 * works outside the request's AsyncLocalStorage context. Run: node scripts/test-run-wrappers.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-wrap-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
const runcontrol = require('../lib/runcontrol');
const W = require('../gui/run-wrappers');
const { onLogLine } = require('../lib/log');
const logs = [];
onLogLine((e) => logs.push(e.line));

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Minimal res: records status/body like sendJson does. */
function fakeRes() {
    const r = { status: 0, body: null, headersSent: false, done: null };
    r.done = new Promise((resolve) => { r._resolve = resolve; });
    r.writeHead = (s) => { r.status = s; r.headersSent = true; };
    r.end = (b) => { r.body = JSON.parse(b); r._resolve(); };
    return r;
}
/** Work that only finishes when told to. */
function slowWork() { let finish; const p = new Promise((r) => { finish = r; }); return { p, finish }; }
const SESSION = { key: 'pic-1', tag: 'UJI' };
const call = (fn) => runcontrol.isolate(fn); // every HTTP request runs in its own context

(async () => {
    W.limits.STOP_POLL_MS = 20;

    await test('timeout: 400 with the v3.0.45 message at once; session stays busy (409) until the work settles', async () => {
        const w = slowWork();
        const res = fakeRes();
        const flow = call(() => W.runForResult(res, { label: 'Find BPMP · UJI', session: SESSION }, async () => W.guarded(w.p, 60), { failPrefix: 'Find BPMP gagal: ', errorPrefix: 'Find BPMP ' }));
        await res.done;
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, 'Find BPMP tidak selesai dalam 0 menit - dihentikan. Coba lagi; bila berulang, muat ulang jendela Coretax PIC.');
        await flow;
        assert.ok(runcontrol.isBusy('pic-1'), 'still busy while the abandoned work runs');
        assert.strictEqual(runcontrol.status('pic-1').runs.find((r) => r.key === 'pic-1').active, true);
        const res2 = fakeRes();
        await call(() => W.runForResult(res2, { label: 'Check NIK · UJI', session: SESSION }, async () => 1, { failPrefix: 'x: ' }));
        assert.strictEqual(res2.status, 409);
        assert.ok(/Sesi ini masih menjalankan "Find BPMP · UJI"/.test(res2.body.error), res2.body.error);
        assert.ok(logs.some((l) => /masih berjalan di latar - sesi ini tetap ditandai sibuk/.test(l)));
        w.finish('ok');
        await sleep(10);
        assert.ok(!runcontrol.isBusy('pic-1'), 'released once the work settled');
        const res3 = fakeRes();
        await call(() => W.runForResult(res3, { label: 'Check NIK · UJI', session: SESSION }, async () => ({ ok: 1 }), { failPrefix: 'x: ' }));
        assert.strictEqual(res3.status, 200);
    });

    await test('timeout asks cooperative work to stop (stopRequested) so it ends at its next checkpoint', async () => {
        let sawStop = false;
        const res = fakeRes();
        let work;
        const loop = async () => { for (;;) { await sleep(10); const r = runcontrol.current(); if (r && r.stopRequested) { sawStop = true; return; } } };
        await call(() => W.runForResult(res, { label: 'L', session: { key: 'pic-2' } }, async () => { work = loop(); return W.guarded(work, 30); }, { failPrefix: 'f: ' }));
        assert.strictEqual(res.status, 400);
        await work; await sleep(5);
        assert.ok(sawStop);
        assert.ok(!runcontrol.isBusy('pic-2'));
    });

    await test('user Stop: "dihentikan oleh pengguna." reply, session busy until the work settles', async () => {
        const w = slowWork();
        const res = fakeRes();
        const flow = call(() => W.runForResult(res, { label: 'Preview', session: { key: 'pic-3' } }, async () => W.guarded(w.p, 60000), { failPrefix: 'Preview gagal: ', errorPrefix: 'Preview ' }));
        await sleep(30);
        runcontrol.stop('pic-3'); // from another request (control button)
        await res.done;
        assert.strictEqual(res.body.error, 'Preview dihentikan oleh pengguna.');
        await flow;
        assert.ok(runcontrol.isBusy('pic-3'));
        w.finish();
        await sleep(10);
        assert.ok(!runcontrol.isBusy('pic-3'));
    });

    await test('hard upper bound: work that never settles is released with a log line', async () => {
        W.limits.LINGER_MAX_MS = 80;
        logs.length = 0;
        const res = fakeRes();
        await call(() => W.runForResult(res, { label: 'Hang', session: { key: 'pic-4' } }, async () => W.guarded(new Promise(() => {}), 20), { failPrefix: 'f: ' }));
        assert.ok(runcontrol.isBusy('pic-4'));
        await sleep(150);
        assert.ok(!runcontrol.isBusy('pic-4'), 'force-released');
        assert.ok(logs.some((l) => /tidak selesai dalam .* sesi dilepas paksa/.test(l)), logs.join('\n'));
        W.limits.LINGER_MAX_MS = 10 * 60 * 1000;
    });

    await test('normal results and errors are unchanged: 200 value / 400 errorPrefix+message, released immediately', async () => {
        const ok = fakeRes();
        await call(() => W.runForResult(ok, { label: 'A', session: { key: 'pic-5' } }, async () => W.guarded(Promise.resolve({ n: 1 }), 1000), { failPrefix: 'A gagal: ' }));
        assert.deepStrictEqual([ok.status, ok.body], [200, { n: 1 }]);
        assert.ok(!runcontrol.isBusy('pic-5'));
        const bad = fakeRes();
        await call(() => W.runForResult(bad, { label: 'B', session: { key: 'pic-5' } }, async () => W.guarded(Promise.reject(new Error('rusak')), 1000), { failPrefix: 'B gagal: ', errorPrefix: 'B ' }));
        assert.deepStrictEqual([bad.status, bad.body], [400, { error: 'B rusak' }]);
        assert.ok(!runcontrol.isBusy('pic-5'));
    });

    await test('runInBackground: 202 at once, finish after work; 409 while busy', async () => {
        const w = slowWork();
        const res = fakeRes();
        const flow = call(() => W.runInBackground(res, { label: 'SPT · UJI', session: { key: 'pic-6', tag: 'UJI' } }, () => w.p, { failPrefix: 'Gagal: ' }));
        await res.done;
        assert.deepStrictEqual([res.status, res.body.started, res.body.session], [202, true, 'pic-6']);
        const res2 = fakeRes();
        await call(() => W.runInBackground(res2, { label: 'x', session: { key: 'pic-6' } }, async () => {}, {}));
        assert.strictEqual(res2.status, 409);
        w.finish(); await flow;
        assert.ok(!runcontrol.isBusy('pic-6'));
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
