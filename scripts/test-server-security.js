/* Tes keamanan server dashboard (gui/server.js + gui/guards.js + gui/http-util.js), tanpa
   Supabase / Chrome / Coretax sungguhan dan dengan folder data sementara:
    - DNS rebinding: Host selain 127.0.0.1:<port> / localhost:<port> ditolak 403 untuk SEMUA
      permintaan (API GET/POST, /events, berkas statis);
    - CSRF: Origin asing ditolak 403 untuk GET dan POST; same-origin dan tanpa Origin diterima;
    - body > 1MB ditolak 400 (dulu promise tidak pernah selesai dan permintaan menggantung);
    - aksi Coretax tanpa jaga versi usang / Restricted kini ditolak (import-pajak-masukan,
      import-dividen, check-dividen, create-dividen-case, coretax-record).
   Jalankan: node scripts/test-server-security.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-sec-'));
const state = require('../lib/state');
const updater = require('../lib/updater');
const chrome = require('../lib/chrome');
chrome.getManualPage = () => null;
chrome.getManualStatus = async () => ({ open: false, loggedIn: false, identity: '' });
const { createGuiServer } = require('../gui/server');

/** Permintaan mentah lewat node:http supaya header Host dan Origin bisa diatur bebas (fetch tidak mengizinkan Host).
 *  `auth`: token Bearer (bawaan: token server; null = tanpa Authorization). `cookie`: header Cookie mentah. */
let TOKEN = null;
function request(port, { method = 'GET', path: p = '/api/session', host, origin, body, rawBody, timeout = 5000, auth, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const data = rawBody !== undefined ? rawBody : body === undefined ? null : Buffer.from(JSON.stringify(body));
        // host '' = tanpa header Host sama sekali.
        const headers = host === '' ? {} : { Host: host === undefined ? '127.0.0.1:' + port : host };
        if (origin !== undefined) headers.Origin = origin;
        const bearer = auth === undefined ? TOKEN : auth;
        if (bearer) headers.Authorization = 'Bearer ' + bearer;
        if (cookie) headers.Cookie = cookie;
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout, setHost: host !== '' }, (res) => {
            const chunks = [];
            // /events tidak pernah selesai: cukup status dan potongan pertama.
            if (p === '/events') {
                res.once('data', (c) => { resolve({ status: res.statusCode, text: String(c) }); req.destroy(); });
                res.once('end', () => resolve({ status: res.statusCode, text: '' }));
                res.once('close', () => resolve({ status: res.statusCode, text: '' }));
                return;
            }
            res.on('close', () => { if (!res.complete) resolve({ status: res.statusCode, json: null, text: '' }); });
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (e) { /* bukan JSON */ }
                resolve({ status: res.statusCode, json, text, headers: res.headers });
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout - server tidak menjawab')); });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
    const server = await createGuiServer(0);
    const port = server.address().port;
    TOKEN = server.token;
    const R = (o) => request(port, o);
    console.log('server security (port ' + port + ')');
    try {
        await test('token per peluncuran: 64 hex, berbeda tiap server; opts.token dipakai apa adanya', async () => {
            assert.match(TOKEN, /^[0-9a-f]{64}$/);
            const other = await createGuiServer(0);
            const fixed = await createGuiServer(0, { token: 'f'.repeat(64) });
            try { assert.notStrictEqual(other.token, TOKEN); assert.strictEqual(fixed.token, 'f'.repeat(64)); }
            finally { await new Promise((r) => other.close(r)); await new Promise((r) => fixed.close(r)); }
        });

        await test('tanpa token: /api/* dan /events ditolak 401 JSON yang jelas (GET dan POST)', async () => {
            // GET /api/session TANPA header apa pun = bentuk probe exe versi 3 (gui/guards.js legacyProbeKind):
            // dijawab 200 tanpa data sesi - lihat scripts/test-legacy-probe.js. Dengan header lain tetap 401.
            const bare = await R({ auth: null });
            assert.deepStrictEqual([bare.status, bare.json.legacyProbe, bare.json.taxio_hub], [200, true, undefined]);
            for (const o of [{ path: '/api/session', origin: 'http://127.0.0.1:' + port }, { path: '/api/version' }, { path: '/api/health' }, { path: '/events' }, { path: '/api/tidak-ada' }, { method: 'POST', path: '/api/run/stop', body: {} }, { method: 'POST', path: '/api/quit', body: {} }]) {
                const r = await R(Object.assign({ auth: null }, o));
                assert.strictEqual(r.status, 401, (o.method || 'GET') + ' ' + o.path + ' -> ' + r.status);
                if (o.path !== '/events') { assert.strictEqual(r.json.auth, true); assert.ok(/token/i.test(r.json.error)); }
            }
        });

        await test('token salah (Bearer / cookie) ditolak 401; Bearer benar diterima', async () => {
            assert.strictEqual((await R({ auth: 'a'.repeat(64) })).status, 401);
            assert.strictEqual((await R({ auth: TOKEN.slice(0, 63) })).status, 401, 'prefiks token');
            assert.strictEqual((await R({ auth: null, cookie: 'taxio_pilot_' + port + '=' + 'b'.repeat(64) })).status, 401);
            // Cookie berisi token benar tetapi untuk port lain tidak berlaku.
            assert.strictEqual((await R({ auth: null, cookie: 'taxio_pilot_' + (port + 1) + '=' + TOKEN })).status, 401);
            assert.strictEqual((await R({})).status, 200);
            assert.strictEqual((await R({ method: 'POST', path: '/api/run/stop', body: {} })).status, 200);
        });

        await test('berkas statis tanpa token tetap dilayani; header x-taxio-pilot ada', async () => {
            const r = await R({ auth: null, path: '/' });
            assert.strictEqual(r.status, 200); assert.ok(/<html/i.test(r.text));
            assert.strictEqual((await R({ auth: null, path: '/styles.css' })).status, 200);
            assert.ok(r.headers['x-taxio-pilot']);
            assert.ok((await R({ auth: null })).headers['x-taxio-pilot'], 'juga pada 401');
        });

        await test('/?t=<token> memasang cookie HttpOnly SameSite=Strict lalu redirect ke /; cookie itu membuka API', async () => {
            const r = await R({ auth: null, path: '/?t=' + TOKEN });
            assert.strictEqual(r.status, 302);
            assert.strictEqual(r.headers.location, '/');
            const set = [].concat(r.headers['set-cookie'] || [])[0] || '';
            assert.ok(set.startsWith('taxio_pilot_' + port + '=' + TOKEN + ';'), set.slice(0, 40));
            assert.ok(/HttpOnly/i.test(set) && /SameSite=Strict/i.test(set) && /Path=\//i.test(set));
            const cookie = set.split(';')[0];
            assert.strictEqual((await R({ auth: null, cookie })).status, 200);
            assert.strictEqual((await R({ auth: null, cookie: 'lain=1; ' + cookie + '; x=y' })).status, 200);
            const ev = await R({ auth: null, cookie, path: '/events', origin: 'http://127.0.0.1:' + port });
            assert.strictEqual(ev.status, 200);
        });

        await test('/?t= salah ditolak 401 tanpa cookie', async () => {
            for (const t of ['', 'salah', TOKEN.toUpperCase() === TOKEN ? 'x' : TOKEN.toUpperCase(), TOKEN + '0']) {
                const r = await R({ auth: null, path: '/?t=' + encodeURIComponent(t) });
                assert.strictEqual(r.status, 401, 't=' + t.slice(0, 8));
                assert.ok(!r.headers['set-cookie']);
                assert.strictEqual(r.json.auth, true);
            }
        });

        await test('lintas-origin tetap 403 (diperiksa sebelum token), juga dengan token benar', async () => {
            assert.strictEqual((await R({ origin: 'http://evil.example' })).status, 403);
            assert.strictEqual((await R({ host: 'evil.example:' + port, path: '/?t=' + TOKEN })).status, 403);
        });

        await test('Host 127.0.0.1:<port> dan localhost:<port> diterima (tanpa Origin: MCP, main.js, curl)', async () => {
            assert.strictEqual((await R({})).status, 200);
            assert.strictEqual((await R({ host: 'localhost:' + port })).status, 200);
            assert.strictEqual((await R({ path: '/' })).status, 200, 'dashboard statis');
        });

        await test('DNS rebinding: Host asing ditolak 403 untuk API GET/POST, /events, dan berkas statis', async () => {
            for (const host of ['evil.example:' + port, 'evil.example', '127.0.0.1', '127.0.0.1:' + (port + 1), 'localhost', '', '127.0.0.1:' + port + '.evil.example']) {
                for (const o of [{ path: '/api/session' }, { path: '/api/run/status' }, { path: '/' }, { path: '/index.html' }, { path: '/events' }, { method: 'POST', path: '/api/run/stop', body: {} }]) {
                    const r = await R(Object.assign({ host }, o));
                    // Tanpa Host: node:http sendiri sudah menolak HTTP/1.1 tanpa Host (400) sebelum sampai ke route.
                    const expected = host === '' ? [400, 403] : [403];
                    assert.ok(expected.includes(r.status), 'Host "' + host + '" ' + (o.method || 'GET') + ' ' + o.path + ' -> ' + r.status);
                }
            }
            // Halaman hasil rebinding: Origin dan Host-nya sama-sama nama asing (cara lama meloloskannya).
            const r = await R({ method: 'POST', path: '/api/actions/issue-ebupot', host: 'evil.example:' + port, origin: 'http://evil.example:' + port, body: {} });
            assert.strictEqual(r.status, 403);
        });

        await test('Origin asing ditolak untuk GET dan POST', async () => {
            for (const origin of ['http://situs-lain.example', 'http://evil.example:' + port, 'null', 'https://127.0.0.1:' + port, 'http://127.0.0.1:' + (port + 1), 'http://localhost']) {
                const g = await R({ path: '/api/session', origin });
                assert.strictEqual(g.status, 403, 'GET Origin ' + origin);
                const e = await R({ path: '/events', origin });
                assert.strictEqual(e.status, 403, 'GET /events Origin ' + origin);
                const p = await R({ method: 'POST', path: '/api/run/stop', origin, body: {} });
                assert.strictEqual(p.status, 403, 'POST Origin ' + origin);
                assert.ok(/lintas-origin/.test(p.json.error));
            }
        });

        await test('same-origin diterima untuk GET dan POST (127.0.0.1 dan localhost)', async () => {
            assert.strictEqual((await R({ origin: 'http://127.0.0.1:' + port })).status, 200);
            assert.strictEqual((await R({ host: 'localhost:' + port, origin: 'http://localhost:' + port })).status, 200);
            assert.strictEqual((await R({ method: 'POST', path: '/api/run/stop', origin: 'http://127.0.0.1:' + port, body: {} })).status, 200);
            const ev = await R({ path: '/events', origin: 'http://127.0.0.1:' + port });
            assert.strictEqual(ev.status, 200); assert.ok(/connected/.test(ev.text));
        });

        await test('fetch() biasa dari Node (tanpa Origin, dengan Bearer) tetap jalan', async () => {
            const r = await fetch('http://127.0.0.1:' + port + '/api/version', { headers: { Authorization: 'Bearer ' + TOKEN } });
            assert.strictEqual(r.status, 200); assert.ok((await r.json()).version);
        });

        await test('body > 1MB: dijawab 400, tidak menggantung', async () => {
            const big = Buffer.from(JSON.stringify({ project: 'x'.repeat(1100000) }));
            const r = await R({ method: 'POST', path: '/api/run/pagesize', rawBody: big });
            assert.strictEqual(r.status, 400);
            // Batas dihitung dalam byte: 400k karakter 3-byte (1.2MB) juga melewati batas.
            const wide = Buffer.from(JSON.stringify({ size: 10, pad: '€'.repeat(400000) }));
            assert.ok(wide.length > 1e6);
            assert.strictEqual((await R({ method: 'POST', path: '/api/run/pagesize', rawBody: wide })).status, 400);
            // Server tetap melayani permintaan berikutnya.
            assert.strictEqual((await R({})).status, 200);
        });

        await test('body UTF-8 multi-byte utuh walau terbelah antar-potongan', async () => {
            const r = await R({ method: 'POST', path: '/api/run/pagesize', body: { size: 25, pad: 'é€'.repeat(30000) } });
            assert.strictEqual(r.status, 200);
        });

        await test('aksi Coretax yang dulu tanpa jaga versi usang kini ditolak 426 saat versi usang', async () => {
            const orig = updater.getOutdatedInfo;
            updater.getOutdatedInfo = () => ({ outdated: true, current: '0.0.1', latestVersion: '9.9.9' });
            try {
                for (const p of ['/api/actions/import-pajak-masukan', '/api/actions/import-dividen', '/api/actions/check-dividen', '/api/actions/create-dividen-case', '/api/actions/coretax-record', '/api/actions/download-spt']) {
                    const r = await R({ method: 'POST', path: p, body: { entity: { project: 'manual' }, fileBase64: 'AAAA' } });
                    assert.strictEqual(r.status, 426, p + ' -> ' + r.status);
                    assert.strictEqual(r.json.outdated, true);
                }
                // Hanya membaca disk: tidak diblokir.
                assert.strictEqual((await R({ method: 'POST', path: '/api/import/inspect', body: {} })).status, 400);
            } finally { updater.getOutdatedInfo = orig; }
        });

        await test('Restricted Editor: rekam API Coretax dan Dividen sesi manual ditolak 403', async () => {
            state.set('taxio_hub', { client: {}, session: {}, role: 'restricted_editor' });
            try {
                const rec = await R({ method: 'POST', path: '/api/actions/coretax-record', body: { entity: { project: 'manual' } } });
                assert.strictEqual(rec.status, 403); assert.ok(/Restricted/.test(rec.json.error));
                for (const p of ['/api/actions/import-dividen', '/api/actions/check-dividen', '/api/actions/create-dividen-case']) {
                    const r = await R({ method: 'POST', path: p, body: { fileBase64: 'AAAA' } });
                    assert.strictEqual(r.status, 403, p); assert.ok(/Restricted/.test(r.json.error), p);
                }
            } finally { state.clear('taxio_hub'); }
            // Tanpa Restricted: sesi manual belum ada -> 401 seperti sebelumnya.
            assert.strictEqual((await R({ method: 'POST', path: '/api/actions/create-dividen-case', body: {} })).status, 401);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
    }
    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
})().catch((e) => { console.error(e); process.exitCode = 1; });
