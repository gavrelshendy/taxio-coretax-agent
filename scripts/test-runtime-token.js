/* Offline tests for lib/runtime.js + main.js (Tahap 1: dynamic port, per-launch token, runtime.json).
 *  - runtime.json write/read/remove (only by its owner pid), publicInfo never carries the token;
 *  - tokenEquals is exact (prefix / case / empty rejected);
 *  - findPrimary: runtime.json + live pid + authenticated answer; stale pid ignored; untokened
 *    fallback probe recognises an OLD-version primary only;
 *  - listenPreferred port fallback with an INJECTED preferred port (never the real 51733): foreign
 *    occupant -> free port at once; another user's Pilot (x-taxio-pilot, no runtime.json of ours)
 *    -> free port after retries; our own primary -> { primary };
 *  - main.js end-to-end in smoke mode (temp data root, port 0, no windows/tray/update/health):
 *    runtime.json written with this launch's port/pid/token, API needs the token, /api/quit removes it.
 * Never binds or contacts port 51733 and never touches the real data root. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-runtime-'));
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'root');
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
delete process.env.TAXIO_PILOT_LEGACY_HOME;
const runtime = require('../lib/runtime');
const paths = require('../lib/paths');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((r) => s.close(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await test('runtime.json: written atomically under the data root, read back, removed only by its owner', () => {
        const tok = runtime.newToken();
        assert.match(tok, /^[0-9a-f]{64}$/);
        assert.notStrictEqual(runtime.newToken(), tok);
        const f = runtime.write({ port: 50001, pid: process.pid, token: tok, version: '9.9.9' });
        assert.strictEqual(f, path.join(process.env.TAXIO_PILOT_DATA_DIR, 'runtime.json'));
        const r = runtime.read();
        assert.deepStrictEqual([r.port, r.pid, r.token, r.version], [50001, process.pid, tok, '9.9.9']);
        assert.ok(!isNaN(Date.parse(r.startedAt)));
        assert.strictEqual(runtime.remove(process.pid + 1), false, 'other pid may not remove it');
        assert.ok(fs.existsSync(f));
        assert.strictEqual(runtime.remove(process.pid), true);
        assert.ok(!fs.existsSync(f));
        assert.strictEqual(runtime.read(), null);
        fs.writeFileSync(f, '{"port":"x"}');
        assert.strictEqual(runtime.read(), null, 'malformed file ignored');
        fs.rmSync(f);
    });

    await test('publicInfo strips the token', () => {
        const p = runtime.publicInfo({ port: 1, pid: 2, token: 'rahasia', version: 'v' });
        assert.strictEqual(p.token, undefined);
        assert.strictEqual(p.tokenRequired, true);
        assert.ok(!JSON.stringify(p).includes('rahasia'));
    });

    await test('tokenEquals is exact', () => {
        const t = runtime.newToken();
        assert.strictEqual(runtime.tokenEquals(t, t), true);
        for (const bad of ['', t.slice(0, 63), t + '0', t.toUpperCase(), null, undefined, 123]) assert.strictEqual(runtime.tokenEquals(bad, t), false, String(bad).slice(0, 10));
        assert.strictEqual(runtime.tokenEquals('', ''), false);
    });

    await test('isPidAlive', () => {
        assert.strictEqual(runtime.isPidAlive(process.pid), true);
        assert.strictEqual(runtime.isPidAlive(0), false);
        assert.strictEqual(runtime.isPidAlive(-5), false);
        assert.strictEqual(runtime.isPidAlive(2147483646), false);
    });

    // A fake "Taxio Pilot" with a token: /api/session answers 200 only with the right Bearer.
    const goodToken = runtime.newToken();
    const pilot = await listen((req, res) => {
        res.setHeader('x-taxio-pilot', 'tes');
        if (req.headers.authorization === 'Bearer ' + goodToken) { res.writeHead(200); return res.end('{}'); }
        res.writeHead(401); res.end('{"auth":true}');
    });
    // An OLD-version Pilot: no token, answers 200.
    const oldPilot = await listen((req, res) => { res.writeHead(200); res.end('{}'); });
    // Some other app on the port.
    const foreign = await listen((req, res) => { res.writeHead(404); res.end('nope'); });
    const P = (s) => s.address().port;

    await test('findPrimary: runtime.json + live pid + authenticated 200 => primary (Bearer used)', async () => {
        const file = path.join(TMP, 'rt-a.json');
        runtime.write({ port: P(pilot), pid: process.pid, token: goodToken }, file);
        const p = await runtime.findPrimary({ file, selfPid: -1, legacyPort: null });
        assert.deepStrictEqual([p.port, p.token, p.legacy], [P(pilot), goodToken, false]);
        // Wrong token in the file (e.g. stale from an earlier launch on the same port) => not ours.
        runtime.write({ port: P(pilot), pid: process.pid, token: runtime.newToken() }, file);
        assert.strictEqual(await runtime.findPrimary({ file, selfPid: -1, legacyPort: null }), null);
    });

    await test('findPrimary: dead pid in runtime.json ignored without probing; own pid ignored', async () => {
        const file = path.join(TMP, 'rt-b.json');
        runtime.write({ port: P(pilot), pid: 2147483646, token: goodToken }, file);
        let probes = 0;
        const probe = (...a) => { probes++; return runtime.probe(...a); };
        assert.strictEqual(await runtime.findPrimary({ file, legacyPort: null, probe }), null);
        assert.strictEqual(probes, 0);
        runtime.write({ port: P(pilot), pid: process.pid, token: goodToken }, file);
        assert.strictEqual(await runtime.findPrimary({ file, legacyPort: null }), null, 'this process is not its own primary');
    });

    await test('findPrimary fallback probe (no token): only an OLD-version Pilot counts', async () => {
        const file = path.join(TMP, 'tidak-ada.json');
        const old = await runtime.findPrimary({ file, legacyPort: P(oldPilot) });
        assert.deepStrictEqual([old.port, old.token, old.legacy], [P(oldPilot), null, true]);
        assert.strictEqual(await runtime.findPrimary({ file, legacyPort: P(pilot) }), null, 'new Pilot of someone else answers 401');
        assert.strictEqual(await runtime.findPrimary({ file, legacyPort: P(foreign) }), null);
    });

    await test('forward: POST with Bearer to the primary; 401 counts as not forwarded', async () => {
        const seen = [];
        const s = await listen((req, res) => {
            let b = ''; req.on('data', (d) => { b += d; });
            req.on('end', () => { seen.push({ path: req.url, auth: req.headers.authorization, body: b }); res.writeHead(req.headers.authorization ? 202 : 401); res.end('{}'); });
        });
        try {
            assert.strictEqual(await runtime.forward({ port: P(s), token: 'abc' }, '/api/deeplink', { url: 'taxio-coretax://x' }), true);
            assert.deepStrictEqual(seen[0], { path: '/api/deeplink', auth: 'Bearer abc', body: '{"url":"taxio-coretax://x"}' });
            assert.strictEqual(await runtime.forward({ port: P(s), token: null }, '/api/tray/open'), false);
        } finally { await close(s); }
        const dead = await listen(() => {}); const deadPort = P(dead); await close(dead);
        assert.strictEqual(await runtime.forward({ port: deadPort, token: 'x' }, '/api/tray/open'), false);
    });

    // ---- port fallback (preferred port = a port WE occupy in the test; never 51733) ----
    const createOn = (port) => new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => res.end());
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
    });

    await test('listenPreferred: preferred port free => used, no fallback', async () => {
        const tmp = await listen(() => {}); const port = P(tmp); await close(tmp);
        const r = await runtime.listenPreferred(createOn, port, { findPrimary: async () => null });
        try { assert.strictEqual(r.port, port); assert.strictEqual(r.fellBack, false); } finally { await close(r.server); }
    });

    await test('listenPreferred: foreign app on the preferred port => free port at once (no waiting)', async () => {
        let sleeps = 0;
        const t0 = Date.now();
        const r = await runtime.listenPreferred(createOn, P(foreign), { findPrimary: async () => null, sleep: async () => { sleeps++; } });
        try {
            assert.strictEqual(r.fellBack, true);
            assert.notStrictEqual(r.port, P(foreign));
            assert.ok(r.port > 0);
            assert.strictEqual(sleeps, 0);
            assert.ok(Date.now() - t0 < 3000);
        } finally { await close(r.server); }
    });

    await test("listenPreferred: another user's Taxio Pilot (x-taxio-pilot, not ours) => retries, then free port", async () => {
        let finds = 0, sleeps = 0;
        const r = await runtime.listenPreferred(createOn, P(pilot), { findPrimary: async () => { finds++; return null; }, sleep: async () => { sleeps++; }, tries: 3 });
        try { assert.strictEqual(r.fellBack, true); assert.strictEqual(finds, 3); assert.strictEqual(sleeps, 2); } finally { await close(r.server); }
    });

    await test('listenPreferred: our own primary appears (lost the bind race) => { primary }, nothing bound', async () => {
        let n = 0, created = 0;
        const r = await runtime.listenPreferred((port) => { created++; return createOn(port); }, P(pilot), {
            findPrimary: async () => (++n === 2 ? { port: P(pilot), token: goodToken, legacy: false } : null), sleep: async () => {}
        });
        assert.deepStrictEqual(r.primary, { port: P(pilot), token: goodToken, legacy: false });
        assert.strictEqual(created, 1, 'only the failed attempt on the preferred port');
    });

    await test('listenPreferred: errors other than EADDRINUSE are thrown', async () => {
        await assert.rejects(runtime.listenPreferred(async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }, 1234), /EACCES/);
    });

    await test('gui/server.js: createGuiServer(port) on a busy port rejects EADDRINUSE (fallback is listenPreferred\'s job)', async () => {
        const { createGuiServer } = require('../gui/server');
        await assert.rejects(createGuiServer(P(foreign)), (e) => e.code === 'EADDRINUSE');
        const r = await runtime.listenPreferred((port) => createGuiServer(port, { token: goodToken }), P(foreign), { findPrimary: async () => null });
        try {
            assert.strictEqual(r.fellBack, true);
            assert.strictEqual(r.server.token, goodToken);
            const p = await runtime.probe(r.port, goodToken);
            assert.deepStrictEqual([p.status, p.pilot], [200, true]);
            assert.strictEqual((await runtime.probe(r.port, null)).status, 401);
        } finally { await close(r.server); }
    });

    await close(pilot); await close(oldPilot); await close(foreign);

    await test('main.js smoke run: runtime.json written (port/pid/token/version), token enforced, /api/quit removes it', async () => {
        const root = path.join(TMP, 'smoke-root');
        const env = Object.assign({}, process.env, { TAXIO_PILOT_DATA_DIR: root, TAXIO_PILOT_SMOKE: '1', TAXIO_PILOT_PORT: '0', TAXIO_PILOT_STARTUP_HEALTH: '0', CORETAX_BUNDLED_CHROME: '0' });
        delete env.TAXIO_PILOT_LOG_FILE; delete env.TAXIO_PILOT_LEGACY_HOME;
        const child = spawn(process.execPath, ['main.js'], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
        const exited = new Promise((r) => child.on('exit', r));
        const file = path.join(root, 'runtime.json');
        try {
            let rt = null;
            for (let i = 0; i < 150 && !rt; i++) { await sleep(100); try { rt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* not yet */ } }
            assert.ok(rt, 'runtime.json not written. Output:\n' + out);
            assert.strictEqual(rt.pid, child.pid);
            assert.match(rt.token, /^[0-9a-f]{64}$/);
            assert.ok(rt.port > 0 && rt.port !== 51733);
            assert.strictEqual(rt.version, require('../package.json').version);
            const base = 'http://127.0.0.1:' + rt.port;
            assert.strictEqual((await fetch(base + '/api/session')).status, 401);
            assert.strictEqual((await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + rt.token } })).status, 200);
            assert.ok(fs.existsSync(path.join(root, 'logs', 'coretax-agent.log')), 'log under <root>\\logs');
            assert.ok(!/[0-9a-f]{64}/.test(fs.readFileSync(path.join(root, 'logs', 'coretax-agent.log'), 'utf8')), 'token never logged');
            assert.strictEqual((await fetch(base + '/api/quit', { method: 'POST', headers: { Authorization: 'Bearer ' + rt.token } })).status, 200);
            const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
            assert.strictEqual(code, 0, 'exit code ' + code + '\n' + out);
            assert.ok(!fs.existsSync(file), 'runtime.json removed on clean exit');
        } finally { if (child.exitCode === null) child.kill(); }
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
