/* Offline tests for lib/legacy-handover.js (first start of the installed app after the v3.0.44 pkg exe's own
 * updater ran the NSIS installer). Pure planner + run() with INJECTED registry / shortcut fakes only - this
 * test never reads the real registry and never touches a real .lnk:
 *   - `reg query ... /ve` output parsing (localized "(Default)" label), protocol command -> exe;
 *   - skipped whenever TAXIO_PILOT_DATA_DIR or TAXIO_PILOT_SMOKE is set (registry not even read) or not packaged;
 *   - protocol already ours / inside the install dir / another program (coretax-helper) -> nothing;
 *   - legacy coretax-agent.exe outside the install dir -> only the .lnk pointing at it are retargeted
 *     (case-insensitive path match), with target/cwd/icon = new exe; failures reported, never thrown;
 *   - the legacy exe itself is never written / deleted (no fs access in the planner at all). */
'use strict';
const assert = require('assert');
const h = require('../lib/legacy-handover');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

const LEGACY = 'C:\\Vibecoding\\01 Personal\\Coretax Agent\\dist\\coretax-agent.exe';
const INSTALL = 'C:\\Users\\uji\\AppData\\Local\\Programs\\taxio-pilot';
const NEW = INSTALL + '\\taxio-pilot.exe';
const ENV = {}; // not isolated

function fakeDeps(over) {
    const writes = [];
    const lnk = {
        'C:\\Users\\uji\\Desktop\\Taxio Pilot lama.lnk': LEGACY,
        'C:\\Users\\uji\\Desktop\\Coretax.lnk': LEGACY.toUpperCase(),
        'C:\\Users\\uji\\Desktop\\Lain.lnk': 'C:\\Windows\\notepad.exe',
        'C:\\Users\\uji\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Taxio\\Pilot.lnk': LEGACY,
        'C:\\Users\\uji\\Desktop\\Rusak.lnk': null
    };
    const deps = Object.assign({
        env: ENV, isPackaged: true, installDir: INSTALL, newExe: NEW, lines: [],
        readProtocolCommand: () => '"' + LEGACY + '" "%1"',
        listShortcutFiles: () => Object.keys(lnk),
        readShortcut: (f) => { if (lnk[f] === null) throw new Error('bukan shortcut'); return { target: lnk[f] }; },
        writeShortcut: (f, opts) => { writes.push([f, opts]); return true; }
    }, over || {});
    deps.log = (l) => deps.lines.push(l);
    deps.writes = writes;
    return deps;
}

(async () => {
    await test('parseRegDefault / exeFromCommand', () => {
        const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\taxio-coretax\\shell\\open\\command\r\n    (Default)    REG_SZ    "' + LEGACY + '" "%1"\r\n\r\n';
        assert.strictEqual(h.parseRegDefault(out), '"' + LEGACY + '" "%1"');
        assert.strictEqual(h.parseRegDefault(out.replace('(Default)', '(Bawaan)')), '"' + LEGACY + '" "%1"', 'localized label');
        assert.strictEqual(h.parseRegDefault('ERROR: The system was unable to find the specified registry key or value.'), null);
        assert.strictEqual(h.exeFromCommand('"' + LEGACY + '" "%1"'), LEGACY);
        assert.strictEqual(h.exeFromCommand('C:\\Tools\\coretax-agent.exe "%1"'), 'C:\\Tools\\coretax-agent.exe');
        assert.strictEqual(h.exeFromCommand(''), null);
        assert.strictEqual(h.exeFromCommand('"tanpa-akhir'), null);
        assert.ok(h.isLegacyExeName('D:\\x\\coretax-agent (1).exe'));
        assert.ok(!h.isLegacyExeName('C:\\x\\TaxioCoretaxHelper.exe'));
    });

    await test('isolated / smoke / dev: skipped before the registry is even read', async () => {
        for (const over of [{ env: { TAXIO_PILOT_DATA_DIR: 'C:\\tmp\\x' } }, { env: { TAXIO_PILOT_SMOKE: '1' } }, { isPackaged: false }]) {
            let read = 0;
            const d = fakeDeps(Object.assign({ readProtocolCommand: () => { read++; return '"' + LEGACY + '" "%1"'; }, listShortcutFiles: () => { throw new Error('tidak boleh dipanggil'); } }, over));
            const r = await h.run(d);
            assert.ok(r.skip, JSON.stringify(over));
            assert.strictEqual(read, 0);
            assert.strictEqual(d.writes.length, 0);
        }
        assert.ok(/terisolasi/.test(h.plan({ env: { TAXIO_PILOT_DATA_DIR: 'x' }, isPackaged: true, protocolCommand: '"' + LEGACY + '"', installDir: INSTALL, newExe: NEW }).skip));
    });

    await test('protocol missing / already ours / inside install dir / another program: nothing to do', async () => {
        const cases = [
            [null, /belum terdaftar/],
            ['"' + NEW + '" "%1"', /sudah menunjuk/],
            ['"' + INSTALL.toUpperCase() + '\\resources\\x.exe" "%1"', /sudah menunjuk/],
            ['"C:\\Program Files\\Taxio\\TaxioCoretaxHelper.exe" "%1"', /program lain/]
        ];
        for (const [cmd, re] of cases) {
            const d = fakeDeps({ readProtocolCommand: () => cmd });
            const r = await h.run(d);
            assert.ok(re.test(r.skip), cmd + ' -> ' + r.skip);
            assert.strictEqual(d.writes.length, 0);
        }
        const d = fakeDeps({ readProtocolCommand: () => { throw new Error('reg gagal'); } });
        assert.ok(/belum terdaftar/.test((await h.run(d)).skip));
    });

    await test('legacy exe: only its shortcuts are retargeted (case-insensitive), exe left alone, summary logged', async () => {
        const d = fakeDeps();
        const r = await h.run(d);
        assert.strictEqual(r.skip, null);
        assert.strictEqual(r.legacyExe, LEGACY);
        assert.deepStrictEqual(r.done.sort(), [
            'C:\\Users\\uji\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Taxio\\Pilot.lnk',
            'C:\\Users\\uji\\Desktop\\Coretax.lnk',
            'C:\\Users\\uji\\Desktop\\Taxio Pilot lama.lnk'
        ]);
        for (const [, opts] of d.writes) assert.deepStrictEqual(opts, { target: NEW, cwd: INSTALL, icon: NEW, iconIndex: 0 });
        assert.ok(!d.writes.some(([f]) => /Lain|Rusak/.test(f)));
        assert.ok(!d.writes.some(([f]) => f.toLowerCase().endsWith('.exe')), 'never writes the exe');
        assert.strictEqual(d.lines.length, 1);
        assert.ok(/3 pintasan diarahkan/.test(d.lines[0]) && /exe lama dibiarkan/.test(d.lines[0]));
    });

    await test('write failures are reported, never thrown', async () => {
        let n = 0;
        const d = fakeDeps({ writeShortcut: () => { if (++n === 1) throw new Error('akses ditolak'); return n !== 2 ? true : false; } });
        const r = await h.run(d);
        assert.strictEqual(r.done.length, 1);
        assert.strictEqual(r.failed.length, 2);
        assert.ok(/2 gagal/.test(d.lines[0]));
    });

    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
