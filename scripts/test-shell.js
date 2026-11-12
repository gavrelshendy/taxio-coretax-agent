/* Offline tests for the platform seam lib/shell.js and its call sites:
 *   - headless defaults (what tests, smoke runs and `node main.js` get): no window, dialogs answer
 *     "canceled", no encryption, not packaged, exePath = node;
 *   - register(): partial implementation merged over the defaults, unknown keys rejected, reset();
 *   - WinForms-style dialog filter -> Electron filters;
 *   - only one dialog at a time ({ busy: true }), a throwing dialog = canceled (never a 500);
 *   - gui/server.js uses the seam: pick-file / pick-folder routes, /api/tray/open and /api/deeplink
 *     open the dashboard through it, POST /api/quit closes it and exits through shell.exit (faked).
 *   - nothing in lib/, gui/, automation/ or main.js requires 'electron' (tests run under plain node). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-shell-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'root');
process.env.CORETAX_BUNDLED_CHROME = '0';
const shell = require('../lib/shell');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

(async () => {
    await test('headless defaults are safe no-ops', async () => {
        assert.strictEqual(shell.kind, 'headless');
        assert.strictEqual(await shell.showDashboard('http://127.0.0.1:1/?t=x'), false);
        shell.closeDashboard();
        assert.strictEqual(await shell.pick({ kind: 'file', title: 'x', filter: 'A (*.a)|*.a' }), null);
        assert.strictEqual(await shell.pick({ kind: 'folder' }), null);
        assert.strictEqual(shell.canEncrypt(), false);
        assert.throws(() => shell.encryptString('x'));
        assert.strictEqual(shell.isPackaged(), false);
        assert.strictEqual(shell.exePath(), process.execPath);
    });

    await test('register merges over defaults, rejects unknown keys, reset restores headless', async () => {
        shell.register({ kind: 'uji', isPackaged: () => true });
        assert.strictEqual(shell.kind, 'uji');
        assert.strictEqual(shell.isPackaged(), true);
        assert.strictEqual(shell.canEncrypt(), false, 'not given -> headless default');
        assert.throws(() => shell.register({ showDashbord: () => {} }), /tidak dikenal/);
        shell.reset();
        assert.strictEqual(shell.kind, 'headless');
    });

    await test('parseFilter: WinForms filter -> Electron filters', () => {
        assert.deepStrictEqual(shell.parseFilter('Excel Files (*.xlsx)|*.xlsx|All Files (*.*)|*.*'),
            [{ name: 'Excel Files (*.xlsx)', extensions: ['xlsx'] }, { name: 'All Files (*.*)', extensions: ['*'] }]);
        assert.deepStrictEqual(shell.parseFilter('Impor (*.xlsx;*.XML)|*.xlsx;*.XML'), [{ name: 'Impor (*.xlsx;*.XML)', extensions: ['xlsx', 'xml'] }]);
        assert.deepStrictEqual(shell.parseFilter(''), [{ name: 'Semua File', extensions: ['*'] }]);
        assert.deepStrictEqual(shell.parseFilter('rusak'), [{ name: 'Semua File', extensions: ['*'] }]);
    });

    await test('one dialog at a time; a throwing dialog = canceled', async () => {
        let release, seen = null;
        shell.register({ pickFile: (opts) => { seen = opts; return new Promise((r) => { release = r; }); }, pickFolder: async () => { throw new Error('dialog rusak'); } });
        const first = shell.pick({ kind: 'file', title: 'Pilih', filter: 'Excel (*.xlsx)|*.xlsx', dir: 'C:\\awal' });
        assert.deepStrictEqual(await shell.pick({ kind: 'folder' }), { busy: true });
        release('C:\\data\\a.xlsx');
        assert.strictEqual(await first, 'C:\\data\\a.xlsx');
        assert.deepStrictEqual(seen, { title: 'Pilih', filters: [{ name: 'Excel (*.xlsx)', extensions: ['xlsx'] }], defaultPath: 'C:\\awal' });
        assert.strictEqual(await shell.pick({ kind: 'folder' }), null);
        assert.strictEqual(await shell.pick({ kind: 'folder' }).then(() => 'free'), 'free', 'busy flag released after a throw');
        shell.reset();
    });

    await test('gui/server.js goes through the seam (dialogs, open dashboard, deep link, quit)', async () => {
        const file = path.join(TMP, 'impor.xlsx');
        fs.writeFileSync(file, Buffer.from('PK-uji'));
        const calls = [];
        let exited = null;
        shell.register({
            kind: 'uji',
            pickFile: async (o) => { calls.push(['pickFile', o.title]); return file; },
            pickFolder: async () => { calls.push(['pickFolder']); return TMP; },
            showDashboard: async (url) => { calls.push(['show', url.replace(/t=[0-9a-f]+/, 't=TOKEN')]); return true; },
            closeDashboard: () => calls.push(['close']),
            exit: (code) => { exited = code; }
        });
        const { createGuiServer } = require('../gui/server');
        const server = await createGuiServer(0);
        const port = server.address().port;
        const base = 'http://127.0.0.1:' + port;
        const post = (p, body) => fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        try {
            const f = await (await post('/api/actions/pick-file', { title: 'Pilih file uji' })).json();
            assert.strictEqual(f.fileName, 'impor.xlsx');
            assert.strictEqual(Buffer.from(f.fileBase64, 'base64').toString(), 'PK-uji');
            assert.deepStrictEqual(await (await post('/api/actions/pick-folder', {})).json(), { folderPath: TMP });
            assert.strictEqual((await post('/api/tray/open')).status, 200);
            assert.strictEqual((await post('/api/deeplink', { url: 'taxio-coretax://open?action=open&path=' })).status, 202);
            await new Promise((r) => setTimeout(r, 200));
            assert.deepStrictEqual(calls.filter((c) => c[0] === 'show'), [['show', base + '/?t=TOKEN'], ['show', base + '/?t=TOKEN']]);
            assert.strictEqual((await post('/api/quit')).status, 200);
            for (let i = 0; i < 50 && exited === null; i++) await new Promise((r) => setTimeout(r, 100));
            assert.strictEqual(exited, 0, 'quit ends in shell.exit(0)');
            assert.ok(calls.some((c) => c[0] === 'close'), 'dashboard closed on quit');
            assert.deepStrictEqual(calls.slice(0, 2), [['pickFile', 'Pilih file uji'], ['pickFolder']]);
        } finally {
            await new Promise((r) => server.close(r));
            shell.reset();
        }
    });

    await test('core never requires electron directly (only electron/ does)', () => {
        const root = path.join(__dirname, '..');
        const offenders = [];
        const re = /require\(\s*['"]electron(-updater)?['"]\s*\)/;
        const code = (text) => text.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'); // comments may mention it
        const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(p);
                else if (/\.js$/.test(ent.name) && re.test(code(fs.readFileSync(p, 'utf8')))) offenders.push(path.relative(root, p));
            }
        };
        for (const d of ['lib', 'gui', 'automation']) walk(path.join(root, d));
        if (re.test(code(fs.readFileSync(path.join(root, 'main.js'), 'utf8')))) offenders.push('main.js');
        assert.deepStrictEqual(offenders, []);
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
