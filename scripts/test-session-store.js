/* Offline tests for lib/session-store.js's on-disk storage and lib/data-dir.js's
 * writeJsonAtomic: the Supabase session file follows TAXIO_PILOT_DATA_DIR (never the real
 * ~/.coretax-agent in tests), is written atomically, and a Windows rename failure (EPERM/EBUSY
 * from antivirus) is retried and never leaves the target missing. No network: only the
 * FileSessionStorage adapter is exercised, no Supabase client call is made. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-session-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'a');
const sessionStore = require('../lib/session-store');
const { writeJsonAtomic, readJson } = require('../lib/data-dir');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));

(async () => {
    const realHome = path.join(os.homedir(), '.coretax-agent');

    await test('STORE_FILE lives under TAXIO_PILOT_DATA_DIR and follows it', () => {
        assert.strictEqual(sessionStore.STORE_FILE, path.join(TMP, 'a', 'data', 'session.json'));
        process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'b');
        assert.strictEqual(sessionStore.STORE_FILE, path.join(TMP, 'b', 'data', 'session.json'));
        assert.ok(!sessionStore.STORE_FILE.startsWith(realHome));
        assert.ok(!sessionStore.STORE_FILE.startsWith(require('../lib/paths').defaultRoot()));
    });

    await test('FileSessionStorage set/get/remove round-trips through an atomic write', async () => {
        const st = new sessionStore.FileSessionStorage();
        assert.strictEqual(await st.getItem('sb-x-auth-token'), null);
        await st.setItem('sb-x-auth-token', '{"access_token":"palsu"}');
        await st.setItem('sb-y-auth-token', 'dua');
        assert.strictEqual(await st.getItem('sb-x-auth-token'), '{"access_token":"palsu"}');
        const file = sessionStore.STORE_FILE;
        assert.deepStrictEqual(Object.keys(readJson(file, {})).sort(), ['sb-x-auth-token', 'sb-y-auth-token']);
        await st.removeItem('sb-x-auth-token');
        assert.strictEqual(await st.getItem('sb-x-auth-token'), null);
        assert.strictEqual(await st.getItem('sb-y-auth-token'), 'dua');
        assert.deepStrictEqual(leftovers(path.dirname(file)), []);
    });

    await test('a corrupt session file reads as empty instead of crashing', async () => {
        fs.writeFileSync(sessionStore.STORE_FILE, '{ rusak');
        const st = new sessionStore.FileSessionStorage();
        assert.strictEqual(await st.getItem('apa-saja'), null);
        await st.setItem('k', 'v');
        assert.strictEqual(await st.getItem('k'), 'v');
    });

    const target = path.join(TMP, 'atomic', 'x.json');
    const fakeFs = (renameFailures, code, copyFails) => {
        let n = 0;
        const f = Object.assign(Object.create(fs), {
            renameSync(a, b) { if (n++ < renameFailures) { const e = new Error(code + ': operation not permitted'); e.code = code; throw e; } return fs.renameSync(a, b); },
            copyFileSync(a, b) { if (copyFails) { const e = new Error('EBUSY: copy'); e.code = 'EBUSY'; throw e; } return fs.copyFileSync(a, b); }
        });
        Object.defineProperty(f, 'renames', { get: () => n });
        return f;
    };

    await test('writeJsonAtomic retries a transient EPERM rename', () => {
        writeJsonAtomic(target, { v: 1 });
        const f = fakeFs(2, 'EPERM');
        writeJsonAtomic(target, { v: 2 }, f);
        assert.strictEqual(f.renames, 3);
        assert.deepStrictEqual(readJson(target, null), { v: 2 });
        assert.deepStrictEqual(leftovers(path.dirname(target)), []);
    });

    await test('writeJsonAtomic: rename keeps failing (EBUSY) -> copied in place, target never missing', () => {
        writeJsonAtomic(target, { v: 3 }, fakeFs(100, 'EBUSY'));
        assert.deepStrictEqual(readJson(target, null), { v: 3 });
        assert.deepStrictEqual(leftovers(path.dirname(target)), []);
    });

    await test('writeJsonAtomic: rename and copy both fail -> throws, old content intact, no temp left', () => {
        assert.throws(() => writeJsonAtomic(target, { v: 4 }, fakeFs(100, 'EPERM', true)), /EPERM/);
        assert.deepStrictEqual(readJson(target, null), { v: 3 });
        assert.deepStrictEqual(leftovers(path.dirname(target)), []);
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
