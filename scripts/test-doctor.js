/* Offline tests for lib/doctor.js (Pemeriksaan sistem) with INJECTED fakes only - no real network,
 * registry, PowerShell or disk-space call. Checks: result shape for every check, ok/warn/fail
 * mapping (writable root, disk space vs bundled Chrome, Chrome choice, proxy/PAC, reachability,
 * clock skew > 2 minutes, PowerShell, port fallback / token, outdated version), per-check timeout,
 * a throwing check never breaks the others, problemLines, lib/net.js setFetch routing, and
 * GET /api/health over HTTP (token required, cached, ?fresh=1 re-runs). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-doctor-'));
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'root');
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
const doctor = require('../lib/doctor');
const net = require('../lib/net');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

const NOW = Date.parse('2026-11-12T03:00:00Z');
function fakeResponse(status, dateMs) {
    return { status, headers: { get: (h) => (h.toLowerCase() === 'date' && dateMs ? new Date(dateMs).toUTCString() : null) }, body: null };
}
/** Fakes for a healthy PC; override per test. */
function deps(over) {
    return Object.assign({
        fetch: async () => fakeResponse(200, NOW),
        root: () => path.join(TMP, 'root'),
        statfs: () => ({ bavail: 50 * 1024 * 1024, bsize: 4096 }), // 200 GB
        writeProbe: () => {},
        browser: () => ({ disabled: false, ready: true, version: '149.0.7827.55' }),
        installedChrome: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        proxy: () => ({ known: true, enabled: false, server: '', pac: false, pacUrl: '' }),
        hubUrl: () => ({ url: 'https://contoh.supabase.co', anonKey: 'anon' }),
        powershell: async () => ({ ok: true, version: '5.1' }),
        versionInfo: () => ({ current: '3.0.44', outdated: false, latestVersion: null }),
        now: () => NOW
    }, over || {});
}
const SERVER = { port: 51733, preferredPort: 51733, fellBack: false, tokenRequired: true };
const run = (over, server) => doctor.runChecks({ deps: deps(over), server: server === undefined ? SERVER : server });
const byId = (rep) => Object.fromEntries(rep.checks.map((c) => [c.id, c]));

(async () => {
    await test('healthy PC: every check ok, with the documented shape and Indonesian labels', async () => {
        const rep = await run();
        assert.deepStrictEqual(rep.checks.map((c) => c.id), doctor.CHECK_IDS);
        assert.deepStrictEqual(doctor.CHECK_IDS, ['data-root', 'disk', 'browser', 'proxy', 'coretax', 'hub', 'clock', 'powershell', 'port', 'version']);
        for (const c of rep.checks) {
            assert.deepStrictEqual(Object.keys(c).sort(), ['detail', 'fix', 'id', 'label', 'ms', 'status']);
            assert.strictEqual(c.status, 'ok', c.id + ': ' + c.detail);
            assert.ok(c.label && typeof c.detail === 'string' && typeof c.fix === 'string');
        }
        assert.deepStrictEqual(rep.summary, { ok: 10, warn: 0, fail: 0 });
        assert.deepStrictEqual(doctor.problemLines(rep), []);
    });

    await test('data root not writable => fail with a fix', async () => {
        const c = byId(await run({ writeProbe: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } }))['data-root'];
        assert.strictEqual(c.status, 'fail'); assert.ok(/EPERM/.test(c.detail)); assert.ok(c.fix);
    });

    await test('disk: < 0.7 GB while the bundled Chrome is not ready => fail; < 1 GB otherwise => warn', async () => {
        const small = { statfs: () => ({ bavail: 100 * 256, bsize: 4096 }) }; // 100 MB
        assert.strictEqual(byId(await run(Object.assign({ browser: () => ({ ready: false, disabled: false, version: 'x' }) }, small))).disk.status, 'fail');
        assert.strictEqual(byId(await run(small)).disk.status, 'warn');
        assert.strictEqual(byId(await run({ statfs: () => { throw new Error('ENOSYS'); } })).disk.status, 'warn', 'a throwing dependency is a warn, not a crash');
    });

    await test('browser: bundled ready / installed fallback (warn) / neither (fail) / disabled', async () => {
        assert.ok(/bawaan/.test(byId(await run()).browser.detail));
        const notReady = () => ({ ready: false, disabled: false, version: '1' });
        const fallback = byId(await run({ browser: notReady })).browser;
        assert.strictEqual(fallback.status, 'warn'); assert.ok(/terpasang/.test(fallback.detail));
        assert.strictEqual(byId(await run({ browser: notReady, installedChrome: () => null })).browser.status, 'fail');
        assert.strictEqual(byId(await run({ browser: () => ({ ready: false, disabled: true }) })).browser.status, 'ok');
    });

    await test('proxy/PAC configured => warn mentioning Taxio Hub / update', async () => {
        const c = byId(await run({ proxy: () => ({ known: true, enabled: true, server: 'proxy.kantor:8080', pac: true, pacUrl: 'http://wpad/proxy.pac' }) })).proxy;
        assert.strictEqual(c.status, 'warn'); assert.ok(/proxy\.kantor:8080/.test(c.detail) && /PAC/.test(c.detail) && /Taxio Hub/.test(c.detail));
        assert.strictEqual(byId(await run({ proxy: () => ({ known: false }) })).proxy.status, 'ok');
        assert.deepStrictEqual(require('../lib/win-proxy').parse('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    10.0.0.1:3128\r\n'),
            { known: true, enabled: true, server: '10.0.0.1:3128', pac: false, pacUrl: '' });
        assert.strictEqual(require('../lib/win-proxy').parse('    ProxyEnable    REG_DWORD    0x0\r\n').enabled, false);
    });

    await test('network unreachable => coretax/hub fail; only targeted hosts, HEAD, never the real network', async () => {
        const urls = [];
        const rep = byId(await run({ fetch: async (u, init) => { urls.push(init.method + ' ' + u); const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } }));
        assert.strictEqual(rep.coretax.status, 'fail'); assert.ok(/ENOTFOUND/.test(rep.coretax.detail));
        assert.strictEqual(rep.hub.status, 'fail');
        assert.strictEqual(rep.clock.status, 'warn');
        assert.ok(urls.every((u) => /^HEAD https:\/\/(coretaxdjp\.pajak\.go\.id\/|contoh\.supabase\.co\/auth\/v1\/health)$/.test(u)), urls.join(', '));
    });

    await test('any HTTP status counts as reachable (e.g. 401/403 from the server)', async () => {
        const rep = byId(await run({ fetch: async () => fakeResponse(403, NOW) }));
        assert.strictEqual(rep.coretax.status, 'ok'); assert.strictEqual(rep.hub.status, 'ok');
    });

    await test('clock: skew > 2 minutes warns (both directions), small skew ok, missing Date header warns', async () => {
        const fast = byId(await run({ fetch: async () => fakeResponse(200, NOW - 5 * 60000) })).clock;
        assert.strictEqual(fast.status, 'warn'); assert.ok(/lebih cepat 5 menit/.test(fast.detail), fast.detail); assert.ok(/otomatis/.test(fast.fix));
        assert.ok(/lebih lambat/.test(byId(await run({ fetch: async () => fakeResponse(200, NOW + 3 * 60000) })).clock.detail));
        assert.strictEqual(byId(await run({ fetch: async () => fakeResponse(200, NOW - 90000) })).clock.status, 'ok');
        assert.strictEqual(byId(await run({ fetch: async () => fakeResponse(200, null) })).clock.status, 'warn');
    });

    await test('PowerShell blocked => warn with a fix', async () => {
        const c = byId(await run({ powershell: async () => ({ ok: false, error: 'dinonaktifkan oleh kebijakan' }) })).powershell;
        assert.strictEqual(c.status, 'warn'); assert.ok(/kebijakan/.test(c.detail) && c.fix);
    });

    await test('port: fallback port => warn; no server info => warn; outdated version => warn', async () => {
        const p = byId(await run({}, { port: 60123, preferredPort: 51733, fellBack: true, tokenRequired: true })).port;
        assert.strictEqual(p.status, 'warn'); assert.ok(/60123/.test(p.detail) && /51733/.test(p.detail));
        assert.strictEqual(byId(await run({}, null)).port.status, 'warn');
        const v = byId(await run({ versionInfo: () => ({ current: '3.0.44', outdated: true, latestVersion: '3.0.50' }) })).version;
        assert.strictEqual(v.status, 'warn'); assert.ok(/3\.0\.50/.test(v.detail));
    });

    await test('each check has its own timeout; a hanging / throwing check never breaks the others', async () => {
        const t0 = Date.now();
        const rep = await doctor.runChecks({ deps: deps({ powershell: () => new Promise(() => {}), fetch: () => new Promise(() => {}), proxy: () => { throw new Error('rusak'); } }), server: SERVER, timeoutMs: 300 });
        const c = byId(rep);
        assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + 'ms');
        assert.strictEqual(c.powershell.status, 'warn'); assert.ok(/tidak selesai/.test(c.powershell.detail));
        assert.strictEqual(c.coretax.status, 'fail');
        assert.strictEqual(c.proxy.status, 'warn'); assert.ok(/rusak/.test(c.proxy.detail));
        assert.strictEqual(c['data-root'].status, 'ok');
        const lines = doctor.problemLines(rep);
        assert.ok(lines.length >= 3 && lines.every((l) => /^Pemeriksaan sistem \[(GAGAL|PERINGATAN)\]/.test(l)));
    });

    await test('lib/net.js: setFetch swaps the implementation used by doctor (default deps)', async () => {
        const seen = [];
        net.setFetch(async (u, init) => { seen.push(u); return fakeResponse(204, Date.now()); });
        try {
            assert.strictEqual(net.usingDefault(), false);
            const rep = byId(await doctor.runChecks({ only: ['coretax', 'hub'], server: SERVER }));
            assert.strictEqual(rep.coretax.status, 'ok'); assert.strictEqual(rep.hub.status, 'ok');
            assert.ok(seen.length === 2 && seen.some((u) => /supabase\.co\/auth\/v1\/health$/.test(u)));
            assert.throws(() => net.setFetch('bukan fungsi'), TypeError);
        } finally { net.setFetch(null); }
        assert.strictEqual(net.usingDefault(), true);
    });

    await test('GET /api/health: token required, cached, ?fresh=1 re-runs; port info from setLaunchInfo', async () => {
        let runs = 0;
        const realRun = doctor.runChecks;
        doctor.runChecks = (opts) => { runs++; return realRun({ deps: deps(), server: opts.server }); };
        const { createGuiServer, setLaunchInfo } = require('../gui/server');
        const server = await createGuiServer(0);
        const base = 'http://127.0.0.1:' + server.address().port;
        const auth = { headers: { Authorization: 'Bearer ' + server.token } };
        try {
            setLaunchInfo({ preferredPort: 51733, fellBack: true });
            assert.strictEqual((await fetch(base + '/api/health')).status, 401);
            const a = await (await fetch(base + '/api/health', auth)).json();
            assert.strictEqual(a.checks.length, 10);
            const port = a.checks.find((c) => c.id === 'port');
            assert.strictEqual(port.status, 'warn'); assert.ok(port.detail.includes(String(server.address().port)));
            await fetch(base + '/api/health', auth);
            assert.strictEqual(runs, 1, 'cached');
            await fetch(base + '/api/health?fresh=1', auth);
            assert.strictEqual(runs, 2, 'fresh re-runs');
        } finally {
            doctor.runChecks = realRun;
            await new Promise((r) => server.close(r));
            require('../lib/file-dialog').stop();
        }
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
