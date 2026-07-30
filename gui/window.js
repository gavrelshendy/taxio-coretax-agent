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
        exec('start "" "' + url + '"', { windowsHide: true });
        return;
    }
    windowProcess = spawn(browser, ['--app=' + url, '--window-size=1280,860'], { detached: true, stdio: 'ignore' });
    windowProcess.unref();
    windowProcess.on('exit', () => { windowProcess = null; });
}

/** Whether the dashboard window is genuinely open right now - checked by window TITLE via
 *  PowerShell (same technique as bringToFront/closeWindow below), NOT by tracking the spawned
 *  launcher process's lifetime via `windowProcess`.
 *
 *  CONFIRMED LIVE BUG (2026-07-30, real user report - windows piling up on every Taxio deep-link
 *  click): Chrome enforces single-instance-per-profile. When openWindow() spawns a NEW
 *  `chrome.exe --app=...` while Chrome is already running under that same profile, the new
 *  process just hands the window off to the ALREADY-RUNNING Chrome via IPC and then the spawned
 *  process EXITS IMMEDIATELY - it never becomes the window's actual owning process. The old
 *  `windowProcess`-tracked `exit` handler fired moments after every single openWindow() call, so
 *  isWindowOpen() (`!!windowProcess`) went back to false almost instantly even though the --app
 *  window was still genuinely on screen. Every deep-link after the first therefore hit the
 *  "no window open" branch and spawned yet another one - unbounded window pile-up, never reused
 *  or focused. (closeWindow() below already had a comment identifying this exact re-exec quirk
 *  for its own purposes; isWindowOpen() just never got the same treatment.) */
function isWindowOpen() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') { resolve(!!windowProcess); return; }
        const script = `if (Get-Process | Where-Object { $_.MainWindowTitle -eq 'Coretax Agent' }) { 'yes' } else { 'no' }`;
        exec(`powershell -Command "${script}"`, { windowsHide: true }, (err, stdout) => {
            resolve(!err && String(stdout || '').trim() === 'yes');
        });
    });
}

/** Focuses the dashboard window if one's already open, instead of doing nothing - matched by
 *  its exact page title ("Coretax Agent", from index.html's <title>), NOT the broader
 *  `AppActivate('Chrome')` pattern lib/chrome.js uses for the automation windows (that would
 *  ambiguously match ANY open Chrome window, including a live Coretax automation session).
 *  No `windowProcess` guard (removed) - same single-instance re-exec quirk documented on
 *  isWindowOpen() above meant this silently no-op'd on every call after the first; AppActivate
 *  targeting a title that doesn't exist is already a harmless no-op on its own, so the guard was
 *  only ever making things worse, never safer. */
function bringToFront() {
    if (process.platform !== 'win32') return;
    const script = `(New-Object -ComObject WScript.Shell).AppActivate('Coretax Agent')`;
    exec(`powershell -Command "${script}"`, { windowsHide: true }, () => {});
}

/** Closes the dashboard window on app quit. windowProcess is spawned detached+unref'd (so it
 *  survives independently of this backend process) and Chrome's --app mode may hand the actual
 *  window off to a different process tree entirely (single-instance re-exec) - so killing the
 *  tracked PID isn't reliable. Match by visible window title instead, same approach as
 *  bringToFront(), and send a graceful WM_CLOSE via CloseMainWindow(). */
function closeWindow(callback) {
    if (process.platform !== 'win32') { if (callback) callback(); return; }
    const script = `Get-Process | Where-Object { $_.MainWindowTitle -eq 'Coretax Agent' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }`;
    exec(`powershell -Command "${script}"`, { windowsHide: true }, () => { if (callback) callback(); });
}

module.exports = { openWindow, isWindowOpen, bringToFront, closeWindow };
