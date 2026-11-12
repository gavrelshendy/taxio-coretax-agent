/* Offline tests for background session restore (lib/session-restore.js) and how the dashboard server reports it
 * (/api/session `restore`, POST /api/session/retry, actions waiting instead of "belum terhubung"). Supabase is
 * replaced by fakes through restore._deps; no network. Run: node scripts/test-session-restore.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-restore-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
const restore = require('../lib/session-restore');
const state = require('../lib/state');
const { onLogLine } = require('../lib/log');
const logs = [];
onLogLine((e) => logs.push(e.line));

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
    restore.stop(); state.clear('taxio_hub'); state.clearPending('taxio_hub');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake session store / connection. mode: 'network' | 'ok' | 'invalid' | 'hang' | 'none'
const F = { mode: 'ok', stored: true, calls: 0, release: null };
const CLIENT = { fake: true };
const netErr = () => Object.assign(new Error('Taxio Hub tidak bisa dihubungi (fetch failed)'), { isNetwork: true });
restore._deps.sessionStore = () => ({
    clientFor: () => ({ client: CLIENT }),
    storedSession: () => (F.stored ? { refresh_token: 'r', user: { email: 'uji@contoh.com' } } : null),
    isNetworkError: (e) => !!(e && e.isNetwork),
    restoreSession: async () => {
        F.calls++;
        if (F.mode === 'network') throw netErr();
        if (F.mode === 'invalid') return null;
        if (F.mode === 'hang') await new Promise((r) => { F.release = r; });
        return { client: CLIENT, project: { label: 'Taxio Hub' }, session: { user: { id: 'u-1', email: 'uji@contoh.com' } } };
    }
});
restore._deps.connection = () => ({
    attach: async (projectId, auth) => { state.set(projectId, { client: auth.client, project: auth.project, session: auth.session, user: auth.user, orgId: 'o1', role: 'editor' }); return { status: 'active' }; }
});
let delays = [];
restore._deps.setTimeout = (fn, ms) => { delays.push(ms); const t = setTimeout(fn, ms > 1000 ? 600000 : ms); t.unref(); return t; };

(async () => {
    await test('network down: session kept, phase retrying with backoff, retryNow succeeds -> connected', async () => {
        F.mode = 'network'; F.calls = 0; delays = []; logs.length = 0;
        await restore.start();
        const s = restore.summary('taxio_hub');
        assert.strictEqual(s.phase, 'retrying');
        assert.strictEqual(s.email, 'uji@contoh.com');
        assert.ok(s.nextRetryAt > Date.now() && /dihubungi/.test(s.error));
        assert.deepStrictEqual(delays, [5000]);
        assert.ok(logs.some((l) => /Sesi tersimpan tetap dipakai; dicoba lagi otomatis/.test(l)), logs.join('\n'));
        await restore.retryNow('taxio_hub');
        assert.deepStrictEqual(delays, [5000, 15000], 'backoff grows');
        F.mode = 'ok';
        assert.strictEqual(await restore.retryNow('taxio_hub'), 'ok');
        assert.strictEqual(restore.summary('taxio_hub'), undefined);
        assert.ok(state.isConnected('taxio_hub'));
    });

    await test('no stored session: nothing to restore; invalid stored session: logged, restore ends (sign-in form)', async () => {
        F.stored = false; F.calls = 0;
        await restore.start();
        assert.strictEqual(F.calls, 0); assert.ok(!restore.active());
        F.stored = true; F.mode = 'invalid'; logs.length = 0;
        await restore.start();
        assert.ok(!restore.active());
        assert.ok(logs.some((l) => /tidak berlaku lagi/.test(l)));
        assert.ok(!state.isConnected('taxio_hub'));
    });

    await test('waitIfRestoring: actions wait for an in-flight restore, bounded', async () => {
        F.mode = 'hang';
        restore.start();
        assert.strictEqual(restore.summary('taxio_hub').phase, 'restoring');
        const t0 = Date.now();
        await restore.waitIfRestoring(150);
        assert.ok(Date.now() - t0 >= 140, 'bounded wait');
        setTimeout(() => F.release(), 50);
        await restore.waitIfRestoring(5000);
        assert.ok(state.isConnected('taxio_hub'));
    });

    await test('cancel (user signs in / out meanwhile): a late restore never overrides it', async () => {
        F.mode = 'hang';
        restore.start();
        restore.cancel('taxio_hub');
        F.release();
        await sleep(20);
        assert.ok(!state.isConnected('taxio_hub'));
        assert.ok(!restore.active());
    });

    await test('server: /api/session reports restore; /api/session/retry; actions wait instead of 401 "belum terhubung"', async () => {
        const { createGuiServer } = require('../gui/server');
        const server = await createGuiServer(0);
        const base = 'http://127.0.0.1:' + server.address().port;
        const H = { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' };
        try {
            F.mode = 'network';
            await restore.start();
            const a = await (await fetch(base + '/api/session', { headers: H })).json();
            assert.strictEqual(a.taxio_hub.connected, false);
            assert.strictEqual(a.taxio_hub.restore.phase, 'retrying');
            F.mode = 'ok';
            const b = await (await fetch(base + '/api/session/retry', { method: 'POST', headers: H, body: '{}' })).json();
            assert.strictEqual(b.taxio_hub.connected, true);
            assert.strictEqual(b.taxio_hub.restore, undefined);
            // Restore in flight while the entity list is requested: waits, then answers as connected.
            state.clear('taxio_hub');
            F.mode = 'hang';
            restore.start();
            assert.strictEqual((await (await fetch(base + '/api/session', { headers: H })).json()).taxio_hub.restore.phase, 'restoring');
            setTimeout(() => { F.mode = 'ok'; F.release(); }, 150);
            const ent = await fetch(base + '/api/local-entities', { headers: H });
            assert.strictEqual(ent.status, 200, 'not 401');
        } finally { await new Promise((r) => server.close(r)); }
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
