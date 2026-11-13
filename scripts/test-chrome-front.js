/* Offline tests: bringing the automation Chrome to the front by its browser pid (lib/chrome-window.js +
 * lib/shell.js, no PowerShell actually run), the per-page status cache used by the dashboard polls
 * (lib/chrome-sessions.js cachedStatusForPage; getActiveIdentity itself unchanged), and server-side change
 * events (lib/ui-events.js -> /events). Run: node scripts/test-chrome-front.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-front-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const shell = require('../lib/shell');
const win = require('../lib/chrome-window');
const sessions = require('../lib/chrome-sessions');
const runcontrol = require('../lib/runcontrol');
const uiEvents = require('../lib/ui-events');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmds = [];
shell._deps.exec = (cmd) => { cmds.push(cmd); };
shell._deps.platform = () => 'win32';

function fakePage({ pid, cdpFails, url } = {}) {
    let sessionsOpened = 0;
    const browser = {
        newBrowserCDPSession: async () => {
            sessionsOpened++;
            if (cdpFails) throw new Error('CDP ditolak');
            return { send: async (m) => { assert.strictEqual(m, 'SystemInfo.getProcessInfo'); return { processInfo: [{ type: 'gpu', id: 1 }, { type: 'browser', id: pid }, { type: 'renderer', id: 3 }] }; }, detach: async () => {} };
        }
    };
    const context = { browser: () => browser };
    let evaluations = 0;
    const page = {
        context: () => context, url: () => url || 'https://coretaxdjp.pajak.go.id/portal', isClosed: () => false,
        evaluate: async () => { evaluations++; return '0123456789012345 · PT UJI'; }
    };
    return { page, stats: () => ({ sessionsOpened, evaluations }) };
}

(async () => {
    await test('AppActivate command: pid when known, old title match otherwise', async () => {
        assert.strictEqual(shell.appActivateCommand(4242), 'powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(4242)"');
        assert.strictEqual(shell.appActivateCommand(undefined), 'powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Chrome\')"');
        assert.strictEqual(shell.appActivateCommand(-1), shell.appActivateCommand(null));
    });

    await test('bringChromeToFrontOnWindows(page): browser pid from a browser-level CDP session, cached per context', async () => {
        const f = fakePage({ pid: 31337 });
        cmds.length = 0;
        await win.bringChromeToFrontOnWindows(f.page);
        await win.bringChromeToFrontOnWindows(f.page);
        assert.deepStrictEqual(cmds, [shell.appActivateCommand(31337), shell.appActivateCommand(31337)]);
        assert.strictEqual(f.stats().sessionsOpened, 1, 'pid looked up once');
    });

    await test('pid unknown (CDP refused / no page / page without context): falls back to the title match', async () => {
        cmds.length = 0;
        await win.bringChromeToFrontOnWindows(fakePage({ cdpFails: true }).page);
        await win.bringChromeToFrontOnWindows();
        await win.bringChromeToFrontOnWindows({ isClosed: () => false, url: () => '' });
        assert.deepStrictEqual(cmds, [shell.appActivateCommand(), shell.appActivateCommand(), shell.appActivateCommand()]);
    });

    await test('non-Windows: nothing is executed', async () => {
        shell._deps.platform = () => 'linux';
        cmds.length = 0;
        await win.bringChromeToFrontOnWindows(fakePage({ pid: 5 }).page);
        assert.deepStrictEqual(cmds, []);
        shell._deps.platform = () => 'win32';
    });

    await test('status cache: repeated polls within a few seconds read the page once; concurrent polls share one read', async () => {
        const f = fakePage({ pid: 1 });
        const a = await Promise.all([sessions.cachedStatusForPage(f.page, 'pic-x'), sessions.cachedStatusForPage(f.page, 'pic-x')]);
        await sessions.cachedStatusForPage(f.page, 'pic-x');
        assert.deepStrictEqual(a[0], { open: true, loggedIn: true, identity: '0123456789012345 · PT UJI' });
        assert.strictEqual(f.stats().evaluations, 1);
    });

    await test('status cache: while a run is active on that session the cached status is reused (no page read)', async () => {
        const f = fakePage({ pid: 1 });
        await sessions.cachedStatusForPage(f.page, 'pic-run');
        await runcontrol.isolate(async () => {
            runcontrol.start('SPT · UJI', { key: 'pic-run' });
            await sleep(4200); // older than the normal cache window
            await sessions.cachedStatusForPage(f.page, 'pic-run');
            assert.strictEqual(f.stats().evaluations, 1, 'busy -> reused');
            runcontrol.finish();
        });
        await sessions.cachedStatusForPage(f.page, 'pic-run');
        assert.strictEqual(f.stats().evaluations, 2, 'idle and stale -> read again');
    });

    await test('ui-events: run start/finish and login are announced (debounced) for /events', async () => {
        const got = [];
        const off = uiEvents.on((e) => got.push(e.event));
        runcontrol.isolate(() => { runcontrol.start('x', { key: 'ev' }); runcontrol.finish(); });
        require('../lib/login-status').set('p', { entity_id: 'E' });
        await sleep(uiEvents.DEBOUNCE_MS + 400); // 'runs' (halaman Runs) ditahan sampai 250 ms
        off();
        assert.deepStrictEqual(got.sort(), ['login', 'run', 'runs']);
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
