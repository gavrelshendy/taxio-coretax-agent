/* v3 exe (coretax-agent.exe 3.0.x) opened while v4 runs (gui/guards.js legacyProbeKind, gui/server.js
 * handleLegacyProbe). Real dashboard server on an OS-assigned port, temp data root, headless shell:
 *   - the EXACT single-instance code of v3.0.50 main.js (isPrimaryRunning / forwardOpenToRunningInstance /
 *     forwardDeepLinkToRunningInstance, copied below with the port as a parameter) now sees "already
 *     running" and would exit quietly; before v4.0.0 the probe got 401 and v3 went on to bind the port
 *     and show its error popup;
 *   - the legacy answer leaks nothing (no session data), the deep link is NOT dispatched, one in-app notice;
 *   - token protection is unchanged for everything else: the same route with a User-Agent (browsers, fetch,
 *     curl), a foreign Origin, a wrong token, the v4 probe header, or any other route -> 401/403;
 *   - lib/runtime.js findPrimary (v4's own probe) still does NOT take a v4 server for a "legacy primary";
 *   - /api/version carries the "Back to version 3" info (legacy exe recorded by lib/legacy-handover.js). */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-legacyprobe-'));
const deeplink = require('../lib/deeplink');
const dispatched = [];
deeplink.dispatch = async (url) => { dispatched.push(url); };
const shell = require('../lib/shell');
const shown = [];
const origShow = shell.showDashboard;
shell.showDashboard = async (url) => { shown.push(url); };
const { pendingNotices } = require('../lib/log');
const runtime = require('../lib/runtime');
const { createGuiServer } = require('../gui/server');

// ---- v3.0.50 main.js, verbatim except GUI_PORT -> parameter ----
function isPrimaryRunning(GUI_PORT) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/session', method: 'GET', timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}
function forwardOpenToRunningInstance(GUI_PORT) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/tray/open', method: 'POST', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}
function forwardDeepLinkToRunningInstance(GUI_PORT, url) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: GUI_PORT, path: '/api/deeplink', method: 'POST', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end(JSON.stringify({ url }));
    });
}

function raw(port, { method = 'GET', path: p = '/api/session', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout: 5000 }, (res) => {
            let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; });
            res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch (e) { /* */ } resolve({ status: res.statusCode, json, text: s }); });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

(async () => {
    const server = await createGuiServer(0);
    const port = server.address().port;
    const token = server.token;

    await test('v3 double-click: probe sees "already running" (200) and the open request brings v4 forward', async () => {
        assert.strictEqual(await isPrimaryRunning(port), true);
        assert.strictEqual(await forwardOpenToRunningInstance(port), true);
        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(shown.length, 1);
        assert.ok(shown[0].startsWith('http://127.0.0.1:' + port + '/?t='), 'opens the dashboard with the launch token (inside v4 only)');
        const n = pendingNotices().filter((x) => /versi 3/.test(x.msg));
        assert.strictEqual(n.length, 1);
        assert.ok(/Quit app/.test(n[0].msg));
    });

    await test('legacy session answer leaks nothing', async () => {
        const r = await raw(port);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.legacyProbe, true);
        assert.strictEqual(r.json.taxio_hub, undefined);
        assert.ok(!r.text.includes(token));
    });

    await test('v3 deep link: answered (< 500, v3 exits) but NOT dispatched; window shown', async () => {
        const before = shown.length;
        assert.strictEqual(await forwardDeepLinkToRunningInstance(port, 'taxio-coretax://download?x=1'), true);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(dispatched, []);
        assert.strictEqual(shown.length, before + 1);
        const r = await raw(port, { method: 'POST', path: '/api/deeplink', body: JSON.stringify({ url: 'taxio-coretax://x' }) });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(pendingNotices().filter((x) => /versi 3/.test(x.msg)).length, 1, 'notice at most once a minute');
    });

    await test('token protection unchanged for anything that is not the bare v3 probe', async () => {
        const UA = { 'User-Agent': 'Mozilla/5.0' };
        assert.strictEqual((await raw(port, { headers: UA })).status, 401);
        assert.strictEqual((await raw(port, { headers: { 'User-Agent': 'curl/8' } })).status, 401);
        assert.strictEqual((await raw(port, { headers: { [runtime.PROBE_HEADER]: '4' } })).status, 401);
        assert.strictEqual((await raw(port, { headers: { Authorization: 'Bearer salah' } })).status, 401);
        assert.strictEqual((await raw(port, { headers: { Cookie: 'taxio_pilot_' + port + '=salah' } })).status, 401);
        assert.strictEqual((await raw(port, { headers: { Origin: 'http://evil.example' } })).status, 403);
        assert.strictEqual((await raw(port, { headers: { Host: 'evil.example:' + port } })).status, 403);
        assert.strictEqual((await raw(port, { method: 'POST', path: '/api/tray/open', headers: UA })).status, 401);
        assert.strictEqual((await raw(port, { method: 'POST', path: '/api/deeplink', headers: UA, body: '{"url":"taxio-coretax://x"}' })).status, 401);
        for (const [m, p] of [['GET', '/api/version'], ['GET', '/api/entities'], ['POST', '/api/quit'], ['GET', '/api/local-entities'], ['GET', '/events'], ['POST', '/api/actions/open-coretax']]) {
            assert.strictEqual((await raw(port, { method: m, path: p })).status, 401, m + ' ' + p);
        }
        const f = await fetch('http://127.0.0.1:' + port + '/api/session');
        assert.strictEqual(f.status, 401, 'Node fetch (sends a User-Agent) is not a legacy probe');
        assert.deepStrictEqual(dispatched, []);
    });

    await test('v4 probe (lib/runtime.js) still gets 401 -> a v4 server is never taken for a legacy primary', async () => {
        const r = await runtime.probe(port, null);
        assert.deepStrictEqual([r.status, r.pilot], [401, true]);
        const rtFile = path.join(process.env.TAXIO_PILOT_DATA_DIR, 'no-runtime.json');
        assert.strictEqual(await runtime.findPrimary({ file: rtFile, legacyPort: port }), null);
        // and with the right token it is found
        const ok = await runtime.probe(port, token);
        assert.strictEqual(ok.status, 200);
    });

    await test('/api/version: rollback info (recorded legacy exe + v3 release link)', async () => {
        const h = require('../lib/legacy-handover');
        const auth = { Authorization: 'Bearer ' + token };
        let v = (await raw(port, { path: '/api/version', headers: auth })).json;
        assert.strictEqual(v.version, require('../package.json').version);
        assert.deepStrictEqual(v.rollback, { legacyExe: null, legacyExeExists: false, v3Version: '3.0.50', v3ReleaseUrl: 'https://github.com/gavrelshendy/taxio-coretax-agent/releases/tag/v3.0.50' });
        const fakeExe = path.join(process.env.TAXIO_PILOT_DATA_DIR, 'coretax-agent.exe');
        fs.writeFileSync(fakeExe, 'MZ');
        h.remember(fakeExe);
        assert.ok(h.rememberFile().startsWith(process.env.TAXIO_PILOT_DATA_DIR));
        v = (await raw(port, { path: '/api/version', headers: auth })).json;
        assert.deepStrictEqual([v.rollback.legacyExe, v.rollback.legacyExeExists], [fakeExe, true]);
        fs.rmSync(fakeExe);
        v = (await raw(port, { path: '/api/version', headers: auth })).json;
        assert.deepStrictEqual([v.rollback.legacyExe, v.rollback.legacyExeExists], [fakeExe, false]);
    });

    shell.showDashboard = origShow;
    server.close();
    try { fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
