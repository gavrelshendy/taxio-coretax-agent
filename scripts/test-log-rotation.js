/* Offline tests for lib/log.js: TAXIO_PILOT_LOG_FILE override, size-based rotation
 * (log -> log.1 -> log.2, oldest dropped) without losing a line, and no throw / no lost line when
 * the rename fails because the file is locked. Writes only into a temp folder. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-log-'));
const LOG = path.join(TMP, 'coretax-agent.log');
process.env.TAXIO_PILOT_LOG_FILE = LOG;
const logLib = require('../lib/log');

const results = [];
function test(name, fn) {
    try { fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const linesIn = (files) => files.map(read).join('').split('\n').filter(Boolean);

test('LOG_FILE honours TAXIO_PILOT_LOG_FILE and log() writes there', () => {
    assert.strictEqual(logLib.LOG_FILE, LOG);
    logLib.log('halo dari tes');
    assert.match(read(LOG), /halo dari tes/);
});

test('rotation keeps every line across log, .1 and .2 and drops only the oldest generation', () => {
    const f = path.join(TMP, 'rot.log');
    const limits = { maxBytes: 1000, retryBytes: 200 };
    const line = (i) => 'baris-' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(40) + '\n'; // 51 bytes
    for (let i = 0; i < 50; i++) logLib._append(f, line(i), limits);
    // 50 * 51 = 2550 bytes, max 1000 -> rotated twice; nothing lost yet.
    assert.ok(fs.existsSync(f + '.1'), '.1 exists');
    assert.ok(fs.existsSync(f + '.2'), '.2 exists');
    const all = linesIn([f + '.2', f + '.1', f]);
    assert.strictEqual(all.length, 50);
    all.forEach((l, i) => assert.ok(l.startsWith('baris-' + String(i).padStart(4, '0')), 'order at ' + i));
    assert.ok(fs.statSync(f).size <= 1000 + 51);
    for (let i = 50; i < 100; i++) logLib._append(f, line(i), limits);
    assert.ok(!fs.existsSync(f + '.3'), 'never more than two old files');
    const kept = linesIn([f + '.2', f + '.1', f]);
    assert.ok(kept[kept.length - 1].startsWith('baris-0099'));
    // Contiguous tail: the dropped lines are only the oldest ones.
    const first = parseInt(kept[0].slice(6, 10), 10);
    kept.forEach((l, i) => assert.ok(l.startsWith('baris-' + String(first + i).padStart(4, '0'))));
});

test('rename failure (locked file) does not throw or lose lines; rotation retried later', () => {
    const f = path.join(TMP, 'locked.log');
    const limits = { maxBytes: 500, retryBytes: 300 };
    const realRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function (from) { if (from === f) { attempts++; const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return realRename.apply(fs, arguments); };
    try {
        for (let i = 0; i < 40; i++) logLib._append(f, 'terkunci-' + i + ' ' + 'y'.repeat(40) + '\n', limits);
    } finally { fs.renameSync = realRename; }
    assert.strictEqual(linesIn([f]).length, 40, 'every line is in the (unrotated) file');
    assert.ok(attempts >= 1 && attempts <= 6, 'rotation retried only every retryBytes, not per line (attempts=' + attempts + ')');
    // Once the lock is gone, the next write over the threshold rotates.
    for (let i = 40; i < 50; i++) logLib._append(f, 'terkunci-' + i + ' ' + 'y'.repeat(40) + '\n', limits);
    assert.ok(fs.existsSync(f + '.1'));
    assert.strictEqual(linesIn([f + '.1', f]).length, 50);
});

test('a missing log folder never throws', () => {
    logLib._append(path.join(TMP, 'tidak-ada', 'sub', 'x.log'), 'baris\n', { maxBytes: 10 });
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
const failed = results.filter((x) => !x).length;
console.log((results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
