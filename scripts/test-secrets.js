/* Offline tests for secrets at rest (lib/secrets.js, lib/session-store.js, lib/local-entities.js) with a FAKE
 * reversible cipher registered through lib/shell.js (the real one is Electron safeStorage / DPAPI):
 *   - headless (no cipher): plaintext passthrough, exactly as before;
 *   - with a cipher: session.json encrypted as a whole, local-entities.json credential fields "enc:v1:",
 *     names/NPWP still readable, values round-trip;
 *   - transparent migration: legacy plaintext is read, sealIfPlain() rewrites it encrypted;
 *   - undecryptable file (other PC/user = other key): no crash, nothing deleted - the file is kept aside as
 *     *.tidak-terbaca, the app starts empty, ONE clear Indonesian log line; a second aside never overwrites
 *     the first.
 * Never touches the real data root (TAXIO_PILOT_DATA_DIR = temp). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-secrets-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'root');
const shell = require('../lib/shell');
const secrets = require('../lib/secrets');
const sessionStore = require('../lib/session-store');
const local = require('../lib/local-entities');
const DATA = path.join(TMP, 'root', 'data');
const SESSION = path.join(DATA, 'session.json');
const LOCAL = path.join(DATA, 'local-entities.json');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

/** Reversible fake cipher bound to `key` - decrypting with another key throws like DPAPI does. */
function fakeCipher(key) {
    return {
        canEncrypt: () => true,
        encryptString: (text) => Buffer.from(key + '|' + Buffer.from(String(text), 'utf8').toString('hex')).toString('base64'),
        decryptString: (b64) => {
            const s = Buffer.from(String(b64), 'base64').toString();
            if (!s.startsWith(key + '|')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
            return Buffer.from(s.slice(key.length + 1), 'hex').toString('utf8');
        }
    };
}
const logText = () => { try { return fs.readFileSync(process.env.TAXIO_PILOT_LOG_FILE, 'utf8'); } catch (e) { return ''; } };
const U = 'user-1';
const OP = { name: 'Ani Uji', type: 'op', npwp: '1234567890123456', password: 'sandi-op-ÄÖ', passphrase: 'frasa op' };
const BADAN = { name: 'PT Uji', type: 'badan', npwp: '6543210987654321', pics: [{ name: 'Pic Satu', npwp: '1111222233334444', password: 'sandi-pic', passphrase: 'frasa-pic' }] };

(async () => {
    await test('headless (no cipher): plaintext passthrough, sealIfPlain is a no-op', async () => {
        shell.reset();
        assert.strictEqual(shell.canEncrypt(), false);
        await new sessionStore.FileSessionStorage().setItem('sb-x-auth-token', '{"access_token":"tok-plain"}');
        assert.ok(fs.readFileSync(SESSION, 'utf8').includes('tok-plain'));
        const e = local.create(U, OP);
        assert.ok(fs.readFileSync(LOCAL, 'utf8').includes('sandi-op-ÄÖ'));
        assert.strictEqual(sessionStore.sealIfPlain(), false);
        assert.strictEqual(local.sealIfPlain(), false);
        assert.strictEqual(local.resolveLogin(U, e.id, 'op').cred.password, 'sandi-op-ÄÖ');
    });

    await test('migration: legacy plaintext read once, rewritten encrypted by sealIfPlain', async () => {
        shell.register(fakeCipher('PC-A'));
        assert.strictEqual(await new sessionStore.FileSessionStorage().getItem('sb-x-auth-token'), '{"access_token":"tok-plain"}', 'plaintext still readable');
        assert.strictEqual(sessionStore.sealIfPlain(), true);
        assert.strictEqual(local.sealIfPlain(), true);
        const rawS = fs.readFileSync(SESSION, 'utf8'), rawL = fs.readFileSync(LOCAL, 'utf8');
        assert.ok(!rawS.includes('tok-plain') && JSON.parse(rawS).format === secrets.FILE_FORMAT);
        assert.ok(!rawL.includes('sandi-op') && !rawL.includes('frasa op'));
        assert.ok(rawL.includes('Ani Uji') && rawL.includes('1234567890123456'), 'names / NPWP stay readable');
        assert.ok(/"password": "enc:v1:/.test(rawL));
        assert.strictEqual(sessionStore.sealIfPlain(), false, 'already sealed');
        assert.strictEqual(local.sealIfPlain(), false, 'already sealed');
        assert.strictEqual(await new sessionStore.FileSessionStorage().getItem('sb-x-auth-token'), '{"access_token":"tok-plain"}');
    });

    await test('with a cipher: round trip of session + local entity credentials (op and badan PIC), edit keeps old secret', async () => {
        const st = new sessionStore.FileSessionStorage();
        await st.setItem('sb-y-auth-token', 'kedua');
        assert.strictEqual(await st.getItem('sb-y-auth-token'), 'kedua');
        assert.ok(!fs.readFileSync(SESSION, 'utf8').includes('kedua'));
        const b = local.create(U, BADAN);
        const picId = b.pics[0].id;
        const login = local.resolveLogin(U, b.id, picId);
        assert.deepStrictEqual([login.cred.password, login.passphrase], ['sandi-pic', 'frasa-pic']);
        // edit with empty password = keep the stored one (form never shows it)
        local.update(U, b.id, Object.assign({}, BADAN, { pics: [{ id: picId, name: 'Pic Satu', npwp: '1111222233334444', password: '' }] }));
        assert.strictEqual(local.resolveLogin(U, b.id, picId).cred.password, 'sandi-pic');
        const raw = fs.readFileSync(LOCAL, 'utf8');
        assert.ok(!raw.includes('sandi-pic') && !raw.includes('frasa-pic'));
        assert.ok(!JSON.stringify(local.listEntitiesFor(U)).includes('sandi'), 'safe shape never carries secrets');
    });

    await test('undecryptable (other PC/user): kept aside as *.tidak-terbaca, starts empty, one clear log line, no crash', async () => {
        const sessionBefore = fs.readFileSync(SESSION, 'utf8'), localBefore = fs.readFileSync(LOCAL, 'utf8');
        shell.register(fakeCipher('PC-B'));
        const st = new sessionStore.FileSessionStorage();
        assert.strictEqual(await st.getItem('sb-x-auth-token'), null);
        assert.ok(!fs.existsSync(SESSION), 'unreadable file moved away');
        assert.strictEqual(fs.readFileSync(SESSION + '.tidak-terbaca', 'utf8'), sessionBefore, 'kept byte for byte');
        assert.deepStrictEqual(local.listFor(U), []);
        assert.strictEqual(fs.readFileSync(LOCAL + '.tidak-terbaca', 'utf8'), localBefore);
        const log = logText();
        assert.strictEqual((log.match(/Sesi login Taxio tersimpan tidak bisa dibuka/g) || []).length, 1);
        assert.ok(/Silakan masuk lagi/.test(log));
        assert.strictEqual((log.match(/Kredensial entitas lokal \(tab Saya\) tidak bisa dibuka/g) || []).length, 1);
        assert.ok(/Tambahkan lagi entitas lokal/.test(log));
        // the app keeps working: new data on this PC is written and read with this PC's key
        await st.setItem('sb-x-auth-token', 'baru');
        assert.strictEqual(await st.getItem('sb-x-auth-token'), 'baru');
        const again = local.create(U, OP);
        assert.strictEqual(local.resolveLogin(U, again.id, 'op').cred.password, 'sandi-op-ÄÖ');
    });

    await test('a second unreadable file never overwrites the first one kept aside', async () => {
        shell.register(fakeCipher('PC-C'));
        assert.strictEqual(await new sessionStore.FileSessionStorage().getItem('sb-x-auth-token'), null);
        const aside = fs.readdirSync(DATA).filter((n) => n.startsWith('session.json.tidak-terbaca'));
        assert.strictEqual(aside.length, 2, aside.join(', '));
    });

    await test('encrypted file read in headless mode (no cipher) is not destroyed either', async () => {
        shell.register(fakeCipher('PC-D'));
        await new sessionStore.FileSessionStorage().setItem('k', 'v');
        const before = fs.readFileSync(SESSION, 'utf8');
        shell.reset();
        assert.strictEqual(await new sessionStore.FileSessionStorage().getItem('k'), null);
        const kept = fs.readdirSync(DATA).filter((n) => n.startsWith('session.json.tidak-terbaca')).map((n) => fs.readFileSync(path.join(DATA, n), 'utf8'));
        assert.ok(kept.includes(before));
    });

    await test('field helpers: seal/open/isSealed; empty values untouched', () => {
        shell.register(fakeCipher('PC-E'));
        const s = secrets.seal('abc');
        assert.ok(secrets.isSealed(s));
        assert.strictEqual(secrets.open(s), 'abc');
        assert.strictEqual(secrets.seal(''), '');
        assert.strictEqual(secrets.seal(null), null);
        assert.strictEqual(secrets.open('lama-plaintext'), 'lama-plaintext');
        shell.register(fakeCipher('PC-F'));
        assert.throws(() => secrets.open(s), (e) => e.unreadable === true);
        shell.reset();
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
