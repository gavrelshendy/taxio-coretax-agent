/* Offline tests for lib/update-guard.js (v4.0.0: failed-install loop guard). Pure: in-memory storage,
 * injected clock and running version - never touches the real data root:
 *   - record before quitting to install: attempts count up for the same target, restart at 1 for a new one;
 *   - startup: running version reached the target -> 'succeeded' + record cleared; still below -> 'failed';
 *     after MAX (2) failed attempts the version is `blocked` (not auto-installed, no gate);
 *   - a newer target than the blocked one is not blocked; corrupt / missing records are ignored;
 *   - fileStorage round-trip in a temp folder. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createInstallGuard, fileStorage, MAX_AUTO_ATTEMPTS } = require('../lib/update-guard');

const results = [];
function test(name, fn) {
    try { fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
function memStorage(initial) {
    const s = { data: initial === undefined ? null : initial, writes: 0 };
    return Object.assign(s, { read: () => s.data, write: (o) => { s.writes++; s.data = JSON.parse(JSON.stringify(o)); }, clear: () => { s.data = null; } });
}

let clock = Date.parse('2026-11-12T10:00:00Z');
const now = () => clock;

test('MAX_AUTO_ATTEMPTS is 2', () => assert.strictEqual(MAX_AUTO_ATTEMPTS, 2));

test('no record: startup none, nothing blocked', () => {
    const g = createInstallGuard({ storage: memStorage(), now, current: '4.0.0' });
    assert.deepStrictEqual(g.startup(), { status: 'none', blocked: false });
    assert.strictEqual(g.isBlocked('4.0.1'), false);
});

test('beforeInstall: attempts count per target, timestamps from the injected clock', () => {
    const st = memStorage();
    const g = createInstallGuard({ storage: st, now, current: '4.0.0' });
    assert.deepStrictEqual(g.beforeInstall('v4.0.1'), { target: '4.0.1', attempts: 1, firstAt: '2026-11-12T10:00:00.000Z', lastAt: '2026-11-12T10:00:00.000Z' });
    clock += 60000;
    const r2 = g.beforeInstall('4.0.1');
    assert.strictEqual(r2.attempts, 2);
    assert.strictEqual(r2.firstAt, '2026-11-12T10:00:00.000Z');
    assert.strictEqual(r2.lastAt, '2026-11-12T10:01:00.000Z');
    assert.strictEqual(g.beforeInstall('4.0.2').attempts, 1, 'new target restarts the count');
});

test('startup after a successful install clears the record', () => {
    const st = memStorage({ target: '4.0.1', attempts: 1, firstAt: 'x', lastAt: 'x' });
    const g = createInstallGuard({ storage: st, now, current: '4.0.1' });
    const r = g.startup();
    assert.strictEqual(r.status, 'succeeded');
    assert.strictEqual(r.target, '4.0.1');
    assert.strictEqual(st.data, null);
    // newer than the target (e.g. installed manually past it) also counts as success
    const st2 = memStorage({ target: '4.0.1', attempts: 2 });
    assert.strictEqual(createInstallGuard({ storage: st2, current: '4.1.0' }).startup().status, 'succeeded');
    assert.strictEqual(st2.data, null);
});

test('failed install: first failure not blocked, second blocked (only that version)', () => {
    let current = '4.0.0';
    const st = memStorage();
    const g = createInstallGuard({ storage: st, now, current: () => current });
    g.beforeInstall('4.0.1');
    let r = g.startup();
    assert.deepStrictEqual([r.status, r.attempts, r.blocked], ['failed', 1, false]);
    assert.strictEqual(g.isBlocked('4.0.1'), false);
    assert.ok(st.data, 'record kept after a failure');
    g.beforeInstall('4.0.1');
    r = g.startup();
    assert.deepStrictEqual([r.status, r.attempts, r.blocked], ['failed', 2, true]);
    assert.strictEqual(g.isBlocked('4.0.1'), true);
    assert.strictEqual(g.isBlocked('v4.0.1'), true);
    assert.strictEqual(g.isBlocked('4.0.2'), false, 'a newer release is tried again');
    // the user installed it by hand: running version reached the target -> not blocked, cleared at startup
    current = '4.0.1';
    assert.strictEqual(g.isBlocked('4.0.1'), false);
    assert.strictEqual(g.startup().status, 'succeeded');
    assert.strictEqual(st.data, null);
});

test('corrupt record / storage errors are ignored', () => {
    for (const bad of [{}, { target: 4, attempts: 1 }, { target: '4.0.1', attempts: 0 }, { target: '4.0.1', attempts: 'x' }, 'str']) {
        const g = createInstallGuard({ storage: memStorage(bad), current: '4.0.0' });
        assert.deepStrictEqual(g.startup(), { status: 'none', blocked: false });
    }
    const throwing = { read: () => { throw new Error('EACCES'); }, write: () => {}, clear: () => {} };
    const g = createInstallGuard({ storage: throwing, current: '4.0.0' });
    assert.deepStrictEqual(g.startup(), { status: 'none', blocked: false });
    assert.strictEqual(g.isBlocked('4.0.1'), false);
});

test('fileStorage round-trip (temp folder)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-guard-'));
    try {
        const file = path.join(dir, 'update-install.json');
        const g = createInstallGuard({ storage: fileStorage(file), now, current: '4.0.0' });
        g.beforeInstall('4.0.1'); g.beforeInstall('4.0.1');
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts, 2);
        assert.strictEqual(createInstallGuard({ storage: fileStorage(file), current: '4.0.0' }).isBlocked('4.0.1'), true);
        assert.strictEqual(createInstallGuard({ storage: fileStorage(file), current: '4.0.1' }).startup().status, 'succeeded');
        assert.strictEqual(fs.existsSync(file), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const failed = results.filter((x) => !x).length;
console.log((results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
