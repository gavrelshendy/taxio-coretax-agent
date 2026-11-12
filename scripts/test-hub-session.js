/* Offline tests for Taxio Hub token freshness + timeouts (lib/session-store.js sessionFetch / timedFetch /
 * ensureFresh) and the background refresher (lib/hub-refresher.js). A REAL supabase-js client is used, with
 * lib/net.js pointed at a fake fetch (no network): token near expiry is refreshed before a data call (and the
 * header replaced), a refresh token Taxio Hub rejects surfaces as "sesi login sudah kedaluwarsa" instead of an
 * anonymous request, a network failure keeps the stored session, and a stalled request times out with an
 * Indonesian message and is not retried. Run: node scripts/test-hub-session.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-hub-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_HUB_TIMEOUT_MS = '400';
const net = require('../lib/net');
const store = require('../lib/session-store');
const { onLogLine } = require('../lib/log');
const logs = [];
onLogLine((e) => logs.push(e.line));

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

const nowS = () => Math.floor(Date.now() / 1000);
const USER = { id: 'u-1', email: 'uji@contoh.com', aud: 'authenticated', role: 'authenticated' };
const session = (tok, expiresInS) => ({ access_token: tok, refresh_token: 'r-' + tok, token_type: 'bearer', expires_in: expiresInS, expires_at: nowS() + expiresInS, user: USER });
function writeStored(client, s) {
    const file = path.join(TMP, 'data', 'session.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (s) all[client.auth.storageKey] = JSON.stringify(s); else delete all[client.auth.storageKey];
    fs.writeFileSync(file, JSON.stringify(all));
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake Taxio Hub. mode.refresh: 'ok' | 'invalid' | 'network'; mode.rest: 'ok' | 'hang'. */
function fakeHub(mode) {
    const seen = [];
    net.setFetch(async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const headers = new Headers((init && init.headers) || undefined);
        seen.push({ url, auth: headers.get('Authorization') || '' });
        if (/\/auth\/v1\/token/.test(url)) {
            if (mode.refresh === 'network') throw new TypeError('fetch failed');
            if (mode.refresh === 'invalid') return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found' });
            return json(200, session('baru', 3600));
        }
        if (/\/rest\/v1\//.test(url)) {
            if (mode.rest === 'hang') return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted'))); });
            return json(200, [{ ok: 1 }]);
        }
        return json(404, {});
    });
    return seen;
}
const restCalls = (seen) => seen.filter((x) => /\/rest\/v1\//.test(x.url));

const keepAlive = setInterval(() => {}, 1000); // timers in lib/session-store.js are unref'd
(async () => {
    await test('token near expiry (<10 min) is refreshed BEFORE the data call and the new token is sent', async () => {
        const seen = fakeHub({ refresh: 'ok' });
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('lama', 300));
        store.markAuthed(client);
        const r = await client.from('memberships').select('org_id');
        assert.strictEqual(r.error, null, JSON.stringify(r.error));
        assert.ok(seen.findIndex((x) => /token/.test(x.url)) < seen.findIndex((x) => /rest/.test(x.url)), 'refresh first');
        assert.deepStrictEqual(restCalls(seen).map((x) => x.auth), ['Bearer baru']);
    });

    await test('concurrent calls share ONE refresh', async () => {
        const seen = fakeHub({ refresh: 'ok' });
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('lama2', 200));
        store.markAuthed(client);
        await Promise.all([1, 2, 3].map(() => client.from('x').select('*')));
        assert.strictEqual(seen.filter((x) => /token/.test(x.url)).length, 1);
        assert.ok(restCalls(seen).every((x) => x.auth === 'Bearer baru'));
    });

    await test('refresh token rejected: "sesi login sudah kedaluwarsa", NO anonymous request sent', async () => {
        const seen = fakeHub({ refresh: 'invalid' });
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('mati', -60));
        store.markAuthed(client);
        const r = await client.rpc('get_coretax_pic_credential_for_automation', { p_org: 'o', p_pic_id: 'p' });
        assert.ok(r.error && /sesi login sudah kedaluwarsa - putuskan lalu hubungkan ulang/.test(r.error.message), JSON.stringify(r.error));
        assert.strictEqual(restCalls(seen).length, 0, 'no anon request');
        assert.strictEqual((await store.ensureFresh(client)).status, 'invalid');
    });

    await test('network down while refreshing: clear message, stored session kept, status network', async () => {
        const seen = fakeHub({ refresh: 'network' });
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('habis', -60));
        store.markAuthed(client);
        const r = await client.from('memberships').select('org_id');
        assert.ok(r.error && /tidak bisa dihubungi/.test(r.error.message), JSON.stringify(r.error));
        assert.strictEqual(restCalls(seen).length, 0);
        assert.ok(store.storedSession(client), 'session kept on disk');
        assert.strictEqual((await store.ensureFresh(client)).status, 'network');
        assert.ok(store.isNetworkError(r.error));
    });

    await test('stalled request: aborted after TAXIO_PILOT_HUB_TIMEOUT_MS with an Indonesian message, not retried', async () => {
        const seen = fakeHub({ refresh: 'ok', rest: 'hang' });
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('segar', 3600));
        store.markAuthed(client);
        const t0 = Date.now();
        const r = await client.from('memberships').select('org_id');
        const ms = Date.now() - t0;
        assert.ok(r.error && /Taxio Hub tidak menjawab dalam 0 detik \(timeout\)|Taxio Hub tidak menjawab dalam \d+ detik/.test(r.error.message), JSON.stringify(r.error));
        assert.ok(ms >= 350 && ms < 3000, 'took ' + ms + 'ms');
        assert.strictEqual(restCalls(seen).length, 1, 'GET not retried after our timeout');
        assert.ok(store.isNetworkError(r.error));
    });

    await test('timedFetch: caller signal still honoured; deeplink-style client (no session) unaffected', async () => {
        net.setFetch((u, init) => new Promise((resolve, reject) => { if (init.signal.aborted) return reject(init.signal.reason); init.signal.addEventListener('abort', () => reject(init.signal.reason)); }));
        const ac = new AbortController();
        const p = store.timedFetch('https://x.invalid/', { signal: ac.signal }, 5000);
        ac.abort(new Error('dibatalkan pemanggil'));
        await assert.rejects(p, /dibatalkan pemanggil/);
        const seen = fakeHub({ refresh: 'ok' });
        const { client } = store.clientFor('taxio_hub'); // never marked authed -> plain anon request allowed (signup flow)
        const r = await client.rpc('get_my_membership_request');
        assert.strictEqual(r.error, null);
        assert.ok(/^Bearer /.test(restCalls(seen)[0].auth));
    });

    await test('local entities fake client is untouched (no HTTP): ensureFresh says none', async () => {
        const local = require('../lib/local-auth-client').client('u-1');
        assert.strictEqual((await store.ensureFresh(local)).status, 'none');
    });

    await test('hub-refresher: refreshes connected accounts, never overlaps, logs offline once and recovery once', async () => {
        const refresher = require('../lib/hub-refresher');
        const state = require('../lib/state');
        const { client } = store.clientFor('taxio_hub');
        writeStored(client, session('r1', 120));
        store.markAuthed(client);
        state.set('taxio_hub', { client, project: { label: 'Taxio Hub' }, session: {}, user: USER });
        let seen = fakeHub({ refresh: 'ok' });
        await Promise.all([refresher.tick(), refresher.tick()]);
        assert.strictEqual(seen.filter((x) => /token/.test(x.url)).length, 1, 'one refresh');
        writeStored(client, session('r2', -10));
        seen = fakeHub({ refresh: 'network' });
        logs.length = 0;
        await refresher.tick(); await refresher.tick();
        assert.strictEqual(logs.filter((l) => /tidak bisa dihubungi untuk memperbarui sesi login/.test(l)).length, 1, logs.join('\n'));
        fakeHub({ refresh: 'ok' });
        writeStored(client, session('r3', 120)); // new refresh token (auth-js caches a failure per token for a short cooldown)
        await refresher.tick();
        assert.ok(logs.some((l) => /kembali aktif/.test(l)), logs.join('\n'));
        refresher.start({ intervalMs: 50, firstDelayMs: 0 });
        assert.ok(refresher.isRunning());
        refresher.stop();
        assert.ok(!refresher.isRunning());
        state.clear('taxio_hub');
    });

    net.setFetch(null);
    clearInterval(keepAlive);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
