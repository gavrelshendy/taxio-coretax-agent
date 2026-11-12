/* Offline tests for lib/chrome.js's leftover-window cleanup (replaces the old per-PIC
 * --remote-debugging-port + connectOverCDP fallback): command-line parsing, the exact-profile
 * matcher, and terminateProfileProcesses with an INJECTED process list and kill function.
 * Never lists or kills a real process. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-chromeprocs-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'data');
process.env.CORETAX_BUNDLED_CHROME = '0';
const chrome = require('../lib/chrome');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

(async () => {
    // Fake roots (with a space, like a real "C:\Users\First Last") - tests never use the real ones.
    const ROOT = 'C:\\Users\\Budi Contoh\\.coretax-agent-profile';
    const ROOT_B = 'C:\\Users\\Budi Contoh\\.taxio-pilot-profile';
    const roots = [ROOT, ROOT_B];
    const pic = ROOT + '\\pic-123';
    const exe = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
    const procs = [
        { pid: 100, ppid: 1, name: 'chrome.exe', commandLine: exe + ' "--user-data-dir=' + pic + '" --no-first-run about:blank' },
        { pid: 101, ppid: 100, name: 'chrome.exe', commandLine: exe + ' --type=renderer "--user-data-dir=' + pic + '" --lang=id' },
        { pid: 102, ppid: 100, name: 'chrome.exe', commandLine: exe + ' --type=gpu-process --user-data-dir="' + pic + '"' },
        // Same prefix, different PIC folder.
        { pid: 200, ppid: 1, name: 'chrome.exe', commandLine: exe + ' "--user-data-dir=' + pic + '-lain"' },
        { pid: 201, ppid: 1, name: 'chrome.exe', commandLine: exe + ' "--user-data-dir=' + ROOT + '\\pic-12"' },
        // The user's own daily Chrome (no / default user-data-dir).
        { pid: 300, ppid: 1, name: 'chrome.exe', commandLine: exe + ' --profile-directory=Default' },
        { pid: 301, ppid: 1, name: 'chrome.exe', commandLine: exe + ' --user-data-dir=C:\\Users\\Budi\\AppData\\Local\\Google\\Chrome\\User Data' },
        // Not chrome.exe even though the path matches.
        { pid: 400, ppid: 1, name: 'msedge.exe', commandLine: 'msedge.exe "--user-data-dir=' + pic + '"' },
        // Bundled-Chrome profile for the same PIC is a different folder.
        { pid: 500, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir="' + ROOT_B + '\\pic-123"' },
        // Unquoted path with a space (Windows never produces this) is cut at the space -> no match.
        { pid: 600, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir=' + pic + ' --x' }
    ];

    await test('userDataDirFromCommandLine handles all quoting shapes', () => {
        assert.strictEqual(chrome.userDataDirFromCommandLine('chrome.exe --user-data-dir=C:\\a\\b --x'), 'C:\\a\\b');
        assert.strictEqual(chrome.userDataDirFromCommandLine('chrome.exe "--user-data-dir=C:\\a b\\c" --x'), 'C:\\a b\\c');
        assert.strictEqual(chrome.userDataDirFromCommandLine('chrome.exe --user-data-dir="C:\\a b\\c" --x'), 'C:\\a b\\c');
        assert.strictEqual(chrome.userDataDirFromCommandLine('chrome.exe --profile-directory=Default'), null);
        assert.strictEqual(chrome.userDataDirFromCommandLine(null), null);
    });

    await test('isOwnProfileDir: only direct children of the app profile roots', () => {
        assert.strictEqual(chrome.isOwnProfileDir(pic, roots), true);
        assert.strictEqual(chrome.isOwnProfileDir(pic.toUpperCase() + '\\', roots), true);
        assert.strictEqual(chrome.isOwnProfileDir(ROOT, roots), false);
        assert.strictEqual(chrome.isOwnProfileDir(ROOT + '\\pic\\Default', roots), false);
        assert.strictEqual(chrome.isOwnProfileDir('C:\\Users\\Budi\\AppData\\Local\\Google\\Chrome\\User Data', roots), false);
        assert.strictEqual(chrome.isOwnProfileDir(ROOT + '-evil\\pic', roots), false);
        assert.strictEqual(chrome.isOwnProfileDir(ROOT + '\\..\\Desktop', roots), false);
    });

    await test('findProfileProcessPids matches exactly this profile, browser process first', () => {
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs, pic, roots), [100, 101, 102]);
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs, ROOT_B + '\\pic-123', roots), [500]);
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs.slice().reverse(), pic, roots)[0], 100);
    });

    await test('findProfileProcessPids refuses targets outside the app profile roots', () => {
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs, 'C:\\Users\\Budi\\AppData\\Local\\Google\\Chrome\\User Data', roots), []);
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs, '', roots), []);
        assert.deepStrictEqual(chrome.findProfileProcessPids(procs, null, roots), []);
    });

    await test('default roots are the real app profile folders (no fake roots passed)', () => {
        assert.strictEqual(chrome.isOwnProfileDir(path.join(chrome.PROFILE_ROOT, 'x')), true);
        assert.strictEqual(chrome.isOwnProfileDir(path.join(chrome.PROFILE_ROOT_BUNDLED, 'x')), true);
        assert.strictEqual(chrome.isOwnProfileDir(path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')), false);
    });

    await test('terminateProfileProcesses kills only the matching processes and waits for them to go', async () => {
        const realPic = path.join(chrome.PROFILE_ROOT, 'pic-tes-palsu');
        let alive = [
            { pid: 9001, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe "--user-data-dir=' + realPic + '"' },
            { pid: 9002, ppid: 9001, name: 'chrome.exe', commandLine: 'chrome.exe --type=renderer "--user-data-dir=' + realPic + '"' },
            { pid: 9003, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe --profile-directory=Default' }
        ];
        const killed = [];
        let sleeps = 0;
        const n = await chrome.terminateProfileProcesses(realPic, {
            list: async () => alive.slice(),
            kill: (pid) => { killed.push(pid); if (pid === 9001) alive = alive.filter((p) => p.pid !== 9001 && p.ppid !== 9001); },
            sleep: async () => { sleeps++; }
        });
        assert.strictEqual(n, 2);
        assert.deepStrictEqual(killed, [9001, 9002]);
        assert.ok(!killed.includes(9003));
        assert.strictEqual(sleeps, 1);
    });

    await test('terminateProfileProcesses with no leftover kills nothing', async () => {
        const killed = [];
        const n = await chrome.terminateProfileProcesses(path.join(chrome.PROFILE_ROOT, 'pic-tes-palsu'), {
            list: async () => [{ pid: 9003, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe --profile-directory=Default' }],
            kill: (pid) => killed.push(pid), sleep: async () => {}
        });
        assert.strictEqual(n, 0);
        assert.deepStrictEqual(killed, []);
    });

    await test('no --remote-debugging-port left in lib/chrome.js launch flags', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'chrome.js'), 'utf8');
        assert.ok(!/'--remote-debugging-port=/.test(src));
        assert.ok(!/connectOverCDP\(/.test(src));
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
