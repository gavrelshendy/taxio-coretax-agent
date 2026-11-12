/* Offline test for mcp/taxio-pilot-mcp.js finding Pilot through runtime.json (Tahap 1). The MCP server is
 * spawned as a plain `node` child with TAXIO_PILOT_DATA_DIR = temp root (it locates runtime.json itself):
 *   - no runtime.json -> tool error "Taxio Pilot tidak berjalan";
 *   - runtime.json with a dead pid -> same error (stale);
 *   - runtime.json -> calls go to that port with `Authorization: Bearer <token>`; the token is never echoed;
 *   - log discovery falls back to <root>\logs\coretax-agent.log.
 * Uses a fake local Pilot on a random port; never contacts 51733. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-mcp-'));
const ROOT = path.join(TMP, 'root');
fs.mkdirSync(ROOT, { recursive: true });
const TOKEN = 'c'.repeat(64);

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

/** Runs the MCP server for a list of JSON-RPC requests; resolves the responses by id. */
function mcp(requests) {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { TAXIO_PILOT_DATA_DIR: ROOT });
        delete env.TAXIO_PILOT_URL; delete env.TAXIO_PILOT_TOKEN; delete env.TAXIO_PILOT_LOG;
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'taxio-pilot-mcp.js')], { env, windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('exit', () => {
            const byId = {};
            for (const line of out.split('\n').filter(Boolean)) { try { const m = JSON.parse(line); byId[m.id] = m; } catch (e) { /* not JSON */ } }
            resolve({ byId, raw: out });
        });
        child.stdin.end(requests.map((r) => JSON.stringify(Object.assign({ jsonrpc: '2.0' }, r))).join('\n') + '\n');
    });
}
const call = (id, name, args) => ({ id, method: 'tools/call', params: { name, arguments: args || {} } });
const text = (m) => m.result.content[0].text;

(async () => {
    const seen = [];
    const fake = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization });
        if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{"error":"x","auth":true}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/api/version') return res.end('{"version":"9.9.9"}');
        if (req.url === '/api/session') return res.end('{"taxio_hub":{"connected":true}}');
        if (req.url === '/api/log-file') return res.end(JSON.stringify({ path: path.join(TMP, 'tidak-ada.log') }));
        res.end('{}');
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const rtFile = path.join(ROOT, 'runtime.json');
    try {
        await test('no runtime.json -> "Taxio Pilot tidak berjalan"', async () => {
            const { byId } = await mcp([call(1, 'pilot_status')]);
            assert.strictEqual(byId[1].result.isError, true);
            assert.ok(/Taxio Pilot tidak berjalan/.test(text(byId[1])), text(byId[1]));
            assert.strictEqual(seen.length, 0);
        });

        await test('stale runtime.json (dead pid) -> "Taxio Pilot tidak berjalan", nothing contacted', async () => {
            fs.writeFileSync(rtFile, JSON.stringify({ port, pid: 2147483646, token: TOKEN, version: 'x', startedAt: 'x' }));
            const { byId } = await mcp([call(1, 'pilot_status')]);
            assert.ok(/tidak berjalan/.test(text(byId[1])) && /usang/.test(text(byId[1])), text(byId[1]));
            assert.strictEqual(seen.length, 0);
        });

        await test('runtime.json -> Bearer token sent to its port; token never echoed', async () => {
            fs.writeFileSync(rtFile, JSON.stringify({ port, pid: process.pid, token: TOKEN, version: 'x', startedAt: 'x' }));
            const { byId, raw } = await mcp([{ id: 0, method: 'initialize', params: {} }, call(1, 'pilot_status')]);
            assert.ok(!byId[1].result.isError, text(byId[1]));
            assert.strictEqual(JSON.parse(text(byId[1])).version.version, '9.9.9');
            assert.ok(seen.length >= 2 && seen.every((s) => s.auth === 'Bearer ' + TOKEN));
            assert.ok(!raw.includes(TOKEN));
        });

        await test('wrong token in runtime.json -> clear 401 message (after one retry)', async () => {
            fs.writeFileSync(rtFile, JSON.stringify({ port, pid: process.pid, token: 'd'.repeat(64), version: 'x', startedAt: 'x' }));
            const before = seen.length;
            const { byId } = await mcp([call(1, 'run_status')]);
            assert.ok(/menolak token/.test(text(byId[1])), text(byId[1]));
            assert.strictEqual(seen.length - before, 2, 'one retry');
        });

        await test('read_log falls back to <root>\\logs\\coretax-agent.log', async () => {
            fs.writeFileSync(rtFile, JSON.stringify({ port, pid: process.pid, token: TOKEN, version: 'x', startedAt: 'x' }));
            fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
            fs.writeFileSync(path.join(ROOT, 'logs', 'coretax-agent.log'), '[t] [ABC] baris log uji\n');
            const { byId } = await mcp([call(1, 'read_log', { entity: 'ABC' })]);
            assert.ok(/baris log uji/.test(text(byId[1])), text(byId[1]));
        });
    } finally {
        await new Promise((r) => fake.close(r));
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
