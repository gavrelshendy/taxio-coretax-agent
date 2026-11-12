/* Offline tests for lib/paths.js (Tahap 1: one data root + migration from the old scattered folders).
 * Everything runs under a temp dir: TAXIO_PILOT_DATA_DIR = fake root, TAXIO_PILOT_LEGACY_HOME = fake
 * "old home" with .coretax-agent / .coretax-agent-profile / .taxio-pilot-profile. The real home and
 * %LOCALAPPDATA%\TaxioPilot are never touched. Covers: layout, copy (data) vs move (profiles), a
 * locked profile staying usable from its legacy path (resolver), idempotence, never overwriting
 * newer data, chrome.isOwnProfileDir accepting new AND legacy roots, and the log default. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-paths-'));
const ROOT = path.join(TMP, 'root');
const HOME = path.join(TMP, 'rumah lama'); // with a space, like C:\Users\First Last
process.env.TAXIO_PILOT_DATA_DIR = ROOT;
process.env.TAXIO_PILOT_LEGACY_HOME = HOME;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
delete process.env.TAXIO_PILOT_CHROME_DIR;
const paths = require('../lib/paths');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
    await test('layout: everything under the root override', () => {
        assert.strictEqual(paths.root(), ROOT);
        assert.strictEqual(paths.dataDir(), path.join(ROOT, 'data'));
        assert.strictEqual(paths.profileRoot('terpasang'), path.join(ROOT, 'profiles', 'terpasang'));
        assert.strictEqual(paths.profileRoot('bawaan'), path.join(ROOT, 'profiles', 'bawaan'));
        assert.strictEqual(paths.chromeDir(), path.join(ROOT, 'chrome'));
        assert.strictEqual(paths.downloadTempDir(), path.join(ROOT, 'unduhan-sementara'));
        assert.strictEqual(paths.runtimeFile(), path.join(ROOT, 'runtime.json'));
        assert.strictEqual(paths.logFile(), path.join(TMP, 'test.log'), 'TAXIO_PILOT_LOG_FILE wins');
        const saved = process.env.TAXIO_PILOT_LOG_FILE; delete process.env.TAXIO_PILOT_LOG_FILE;
        try { assert.strictEqual(paths.logFile(), path.join(ROOT, 'logs', 'coretax-agent.log')); }
        finally { process.env.TAXIO_PILOT_LOG_FILE = saved; }
        process.env.TAXIO_PILOT_CHROME_DIR = path.join(TMP, 'chrome-cache');
        try { assert.strictEqual(paths.chromeDir(), path.join(TMP, 'chrome-cache')); } finally { delete process.env.TAXIO_PILOT_CHROME_DIR; }
        assert.throws(() => paths.profileRoot('lain'), /tidak dikenal/);
        assert.strictEqual(require('../lib/data-dir').dataDir(), path.join(ROOT, 'data'));
    });

    await test('default root is %LOCALAPPDATA%\\TaxioPilot and the real home is never "legacy" while the root is overridden', () => {
        assert.strictEqual(paths.defaultRoot(), path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TaxioPilot'));
        delete process.env.TAXIO_PILOT_LEGACY_HOME;
        try {
            assert.strictEqual(paths.legacyHome(), null);
            assert.strictEqual(paths.legacyDataDir(), null);
            assert.strictEqual(paths.legacyProfileRoot('terpasang'), null);
            assert.deepStrictEqual(paths.migrate(), { copied: [], moved: [], keptLegacy: [], errors: [], skipped: true });
            assert.strictEqual(paths.migrationSummaryLine({ skipped: true }), '');
            assert.strictEqual(paths.allProfileRoots().length, 2);
        } finally { process.env.TAXIO_PILOT_LEGACY_HOME = HOME; }
        assert.strictEqual(paths.legacyHome(), HOME);
        assert.strictEqual(paths.allProfileRoots().length, 4);
    });

    // ---- a fake old installation ----
    const OLD_DATA = path.join(HOME, '.coretax-agent');
    const OLD_T = path.join(HOME, '.coretax-agent-profile');
    const OLD_B = path.join(HOME, '.taxio-pilot-profile');
    write(path.join(OLD_DATA, 'session.json'), '{"sb-x":"lama"}');
    write(path.join(OLD_DATA, 'local-entities.json'), '{"entities":"lama"}');
    write(path.join(OLD_DATA, 'pending-signup.json'), '{}');
    write(path.join(OLD_DATA, 'sub', 'nested.json'), '1');
    write(path.join(OLD_DATA, 'session.json.tmp-123-1'), 'setengah');
    write(path.join(OLD_T, 'pic-a', 'Default', 'Preferences'), 'A');
    write(path.join(OLD_T, 'pic-b', 'Default', 'Preferences'), 'B-lama');
    write(path.join(OLD_B, 'pic-c', 'Default', 'Preferences'), 'C');
    // Already present in the new root: must never be overwritten / duplicated.
    write(path.join(ROOT, 'data', 'local-entities.json'), '{"entities":"baru"}');
    write(path.join(ROOT, 'profiles', 'terpasang', 'pic-b', 'Default', 'Preferences'), 'B-baru');

    // pic-c is "locked" (Chrome still running on it): rename fails EBUSY.
    const lockedFs = Object.assign(Object.create(fs), {
        renameSync(a, b) { if (path.basename(a) === 'pic-c') { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return fs.renameSync(a, b); }
    });
    let first;
    await test('migrate: data COPIED (old kept, newer kept), profiles MOVED, locked profile kept at legacy path', () => {
        first = paths.migrate({ _fs: lockedFs });
        assert.deepStrictEqual(first.copied.sort(), ['pending-signup.json', 'sub']);
        assert.ok(!fs.existsSync(path.join(ROOT, 'data', 'session.json')), 'session.json sengaja tidak disalin (token refresh berotasi)');
        assert.strictEqual(read(path.join(ROOT, 'data', 'sub', 'nested.json')), '1');
        assert.strictEqual(read(path.join(ROOT, 'data', 'local-entities.json')), '{"entities":"baru"}', 'newer data never overwritten');
        assert.ok(!fs.existsSync(path.join(ROOT, 'data', 'session.json.tmp-123-1')), 'temp leftovers not copied');
        assert.ok(fs.existsSync(path.join(OLD_DATA, 'session.json')), 'old data left for rollback');
        // profiles
        assert.deepStrictEqual(first.moved, ['terpasang/pic-a']);
        assert.strictEqual(read(path.join(ROOT, 'profiles', 'terpasang', 'pic-a', 'Default', 'Preferences')), 'A');
        assert.ok(!fs.existsSync(path.join(OLD_T, 'pic-a')), 'moved, not copied');
        assert.strictEqual(read(path.join(OLD_T, 'pic-b', 'Default', 'Preferences')), 'B-lama', 'legacy pic-b untouched when the new one exists');
        assert.strictEqual(read(path.join(ROOT, 'profiles', 'terpasang', 'pic-b', 'Default', 'Preferences')), 'B-baru');
        assert.ok(fs.existsSync(path.join(OLD_B, 'pic-c')), 'locked profile stays');
        assert.ok(first.keptLegacy.some((x) => x.startsWith('bawaan/pic-c') && /EBUSY/.test(x)));
        assert.deepStrictEqual(first.errors, []);
        const line = paths.migrationSummaryLine(first);
        assert.ok(/2 berkas data disalin/.test(line) && /1 profil Chrome dipindah/.test(line) && /bawaan\/pic-c/.test(line), line);
    });

    await test('resolver: new if present, else legacy if present, else new', () => {
        assert.strictEqual(paths.resolveProfileDir('terpasang', 'pic-a'), path.join(ROOT, 'profiles', 'terpasang', 'pic-a'));
        assert.strictEqual(paths.resolveProfileDir('terpasang', 'pic-b'), path.join(ROOT, 'profiles', 'terpasang', 'pic-b'));
        assert.strictEqual(paths.resolveProfileDir('bawaan', 'pic-c'), path.join(OLD_B, 'pic-c'), 'locked one keeps working from legacy');
        assert.strictEqual(paths.resolveProfileDir('terpasang', 'pic-baru'), path.join(ROOT, 'profiles', 'terpasang', 'pic-baru'));
        assert.strictEqual(paths.resolveProfileDir('bawaan', 'pic-a'), path.join(ROOT, 'profiles', 'bawaan', 'pic-a'), 'kinds are separate');
    });

    await test('idempotent: second run (still locked) changes nothing and duplicates nothing', () => {
        const before = JSON.stringify(fs.readdirSync(path.join(ROOT, 'data')).sort());
        const again = paths.migrate({ _fs: lockedFs });
        assert.deepStrictEqual(again.copied, []);
        assert.deepStrictEqual(again.moved, []);
        assert.strictEqual(JSON.stringify(fs.readdirSync(path.join(ROOT, 'data')).sort()), before);
        assert.ok(!fs.existsSync(path.join(ROOT, 'profiles', 'bawaan', 'pic-c')));
        assert.strictEqual(paths.migrationSummaryLine(again).includes('disalin'), false);
    });

    await test('lock released: next run moves it; empty legacy root removed; resolver follows', () => {
        const third = paths.migrate();
        assert.deepStrictEqual(third.moved, ['bawaan/pic-c']);
        assert.ok(!fs.existsSync(OLD_B), 'empty legacy root removed');
        assert.ok(fs.existsSync(OLD_T), 'legacy root still holding pic-b is kept');
        assert.strictEqual(paths.resolveProfileDir('bawaan', 'pic-c'), path.join(ROOT, 'profiles', 'bawaan', 'pic-c'));
        const fourth = paths.migrate();
        assert.deepStrictEqual([fourth.copied, fourth.moved, fourth.errors], [[], [], []]);
    });

    await test('migrate never throws: unreadable legacy roots / failing copies become summary errors', () => {
        const badFs = Object.assign(Object.create(fs), {
            copyFileSync() { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; },
            cpSync() { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; }
        });
        write(path.join(OLD_DATA, 'baru-lagi.json'), '{}');
        const s = paths.migrate({ _fs: badFs });
        assert.ok(s.errors.some((x) => x.startsWith('baru-lagi.json')));
        assert.ok(/galat/.test(paths.migrationSummaryLine(s)));
    });

    await test('lib/chrome.js: profile roots under the data root; isOwnProfileDir accepts new AND legacy roots only', () => {
        process.env.CORETAX_BUNDLED_CHROME = '0';
        const chrome = require('../lib/chrome');
        assert.strictEqual(chrome.PROFILE_ROOT, path.join(ROOT, 'profiles', 'terpasang'));
        assert.strictEqual(chrome.PROFILE_ROOT_BUNDLED, path.join(ROOT, 'profiles', 'bawaan'));
        assert.strictEqual(chrome.DOWNLOAD_DIR, path.join(ROOT, 'unduhan-sementara'));
        for (const r of [path.join(ROOT, 'profiles', 'terpasang'), path.join(ROOT, 'profiles', 'bawaan'), OLD_T, OLD_B]) {
            assert.strictEqual(chrome.isOwnProfileDir(path.join(r, 'pic-x')), true, r);
            assert.strictEqual(chrome.isOwnProfileDir(r), false, 'root itself ' + r);
        }
        assert.strictEqual(chrome.isOwnProfileDir(path.join(ROOT, 'profiles', 'pic-x')), false);
        assert.strictEqual(chrome.isOwnProfileDir(path.join(HOME, '.coretax-agent', 'pic-x')), false, 'data folder is not a profile root');
        assert.strictEqual(chrome.isOwnProfileDir(path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')), false);
    });

    await test('lib/log.js default: <root>\\logs\\coretax-agent.log (not next to the exe / repo)', () => {
        const env = Object.assign({}, process.env, { TAXIO_PILOT_DATA_DIR: path.join(TMP, 'root-log') });
        delete env.TAXIO_PILOT_LOG_FILE;
        const r = spawnSync(process.execPath, ['-e', "const l=require('./lib/log');l.log('uji');process.stdout.write('\\n@@'+l.LOG_FILE)"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
        const file = String(r.stdout).split('@@').pop().trim();
        assert.strictEqual(file, path.join(TMP, 'root-log', 'logs', 'coretax-agent.log'), r.stderr);
        assert.ok(/uji/.test(read(file)));
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
