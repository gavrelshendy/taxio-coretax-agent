/* Opens the dashboard as a stripped-down Chrome window (--app= mode: no address bar/tabs,
 * looks like a real desktop app) instead of a normal browser tab. Falls back to opening the
 * user's default browser if Chrome/Edge can't be found - the dashboard works fine as a plain
 * tab too, it just won't look as native. */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const { log } = require('../lib/log');

const CHROME_CANDIDATES = [
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findBrowser() {
    return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

let windowProcess = null;

function openWindow(url) {
    const browser = findBrowser();
    if (!browser) {
        log('Chrome/Edge tidak ditemukan - membuka dashboard di browser default.');
        exec('start "" "' + url + '"');
        return;
    }
    windowProcess = spawn(browser, ['--app=' + url, '--window-size=1280,860'], { detached: true, stdio: 'ignore' });
    windowProcess.unref();
    windowProcess.on('exit', () => { windowProcess = null; });
}

function isWindowOpen() { return !!windowProcess; }

module.exports = { openWindow, isWindowOpen };
