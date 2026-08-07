/* Opens the dashboard as a stripped-down Chrome window (--app= mode: no address bar/tabs,
 * looks like a real desktop app) instead of a normal browser tab. Falls back to opening the
 * user's default browser if Chrome/Edge can't be found - the dashboard works fine as a plain
 * tab too, it just won't look as native. */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

/* CONFIRMED LIVE BUG (2026-08-04, real user report - windows piling up on every "add action"
 * click from Taxio even after the 2026-07-30 fix below): `Get-Process | Where MainWindowTitle`
 * only ever exposes ONE window handle per PROCESS, not every window the process owns. Chrome
 * commonly hosts SEVERAL --app= windows (this dashboard, WhatsApp Web, etc.) under one shared
 * process once single-instance re-exec hands them all off to the same running Chrome - and
 * `MainWindowTitle` reflects whichever of THAT process's windows most recently had focus, not
 * "does a Coretax Agent window exist anywhere". The instant the user clicked back to their Taxio
 * Hub tab (normal flow: click an action in Taxio, then click back to add another), Chrome's
 * MainWindowTitle for that shared process flipped to whatever they focused instead - so
 * isWindowOpen() went back to false even though the dashboard window was still genuinely open,
 * just not focused, and every subsequent action spawned yet another one. Reproduced directly:
 * opened the dashboard, switched focus to another --app window sharing the same Chrome process,
 * and Get-Process's MainWindowTitle for that PID silently stopped reporting "Coretax Agent" at
 * all despite the window still being on screen.
 *
 * Fixed by using the actual Win32 window enumeration APIs (EnumWindows/GetWindowText) instead of
 * .NET's per-process MainWindowTitle shortcut - this walks EVERY top-level window on the desktop
 * regardless of which process owns it or which one currently has focus, so it finds the dashboard
 * window whether or not it's the active one right now.
 *
 * CONFIRMED LIVE BUG #2 (2026-08-07, real user report - STILL piling up even with the above fix
 * live): diagnostic logging showed isWindowOpen() was returning false on EVERY single call, no
 * exceptions - `exec()` reported no error, but stdout was consistently empty (neither "yes" nor
 * "no"). Root cause: the script was passed as `powershell -Command "<script with every " escaped
 * to \">"`.replace(/"/g, '\\"')` was applied to the WHOLE script, including the double quotes
 * INSIDE the Add-Type C# here-string (`[DllImport("user32.dll")]` etc.) - a `@'...'@` here-string
 * is single-quoted/literal in PowerShell, so those `\"` sequences never got un-escaped back into
 * plain `"` before reaching the C# compiler, silently breaking Add-Type's compilation. A
 * standalone `powershell -File script.ps1` invocation of the exact same logic (no quoting to get
 * wrong at all) worked reliably in isolation, including a 4-concurrent-process stress test - so
 * every action here is written ONCE to a real .ps1 file on disk and invoked via -File instead of
 * -Command, avoiding this whole class of escaping bug entirely. */
const HELPER_SCRIPT_PATH = path.join(os.tmpdir(), 'coretax-agent-winhelper.ps1');
const HELPER_SCRIPT_CONTENT = `
param([string]$Action, [string]$Title = 'Coretax Agent')
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CtxWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public static IntPtr FindByTitle(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == title) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$h = [CtxWin]::FindByTitle($Title)
switch ($Action) {
    'check' { if ($h -ne [IntPtr]::Zero) { 'yes' } else { 'no' } }
    'focus' { if ($h -ne [IntPtr]::Zero) { [CtxWin]::ShowWindow($h, 9) | Out-Null; [CtxWin]::SetForegroundWindow($h) | Out-Null } }
    'close' { if ($h -ne [IntPtr]::Zero) { [CtxWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null } }
}
`;
let _helperWritten = false;
function ensureHelperScript() {
    if (_helperWritten) return;
    fs.writeFileSync(HELPER_SCRIPT_PATH, HELPER_SCRIPT_CONTENT, 'utf8');
    _helperWritten = true;
}
function runHelper(action, callback) {
    ensureHelperScript();
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${HELPER_SCRIPT_PATH}" -Action ${action}`, { windowsHide: true, timeout: 8000 }, callback);
}

/** Whether the dashboard window is genuinely open right now - found by walking every top-level
 *  window on the desktop (see the header comment above), not by tracking the spawned launcher
 *  process's lifetime via `windowProcess` and not via .NET's per-process MainWindowTitle. Retries
 *  a couple of times on a genuine `exec` error before giving up, rather than treating one
 *  transient hiccup as proof nothing's open. */
function isWindowOpen() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') { resolve(!!windowProcess); return; }
        let attempt = 0;
        const tryOnce = () => {
            attempt++;
            runHelper('check', (err, stdout) => {
                if (err && attempt < 3) { tryOnce(); return; }
                resolve(!err && String(stdout || '').trim() === 'yes');
            });
        };
        tryOnce();
    });
}

/** Focuses the dashboard window if one's already open, instead of doing nothing - matched by
 *  its exact page title ("Coretax Agent", from index.html's <title>), NOT the broader
 *  `AppActivate('Chrome')` pattern lib/chrome.js uses for the automation windows (that would
 *  ambiguously match ANY open Chrome window, including a live Coretax automation session). Calls
 *  SetForegroundWindow() directly on the found handle rather than COM AppActivate()'s title
 *  search, which has the same "only sees one window per process" blind spot as MainWindowTitle. */
function bringToFront() {
    if (process.platform !== 'win32') return;
    runHelper('focus', () => {});
}

/** Closes the dashboard window on app quit. windowProcess is spawned detached+unref'd (so it
 *  survives independently of this backend process) and Chrome's --app mode may hand the actual
 *  window off to a different process tree entirely (single-instance re-exec) - so killing the
 *  tracked PID isn't reliable. Match by visible window title instead (see header comment above),
 *  and post a real WM_CLOSE (0x0010) to that specific window handle - same graceful close a user
 *  clicking the X would trigger. */
function closeWindow(callback) {
    if (process.platform !== 'win32') { if (callback) callback(); return; }
    runHelper('close', () => { if (callback) callback(); });
}

/** CONFIRMED LIVE 2026-08-07 (real user report - dashboard still piling up on rapid Taxio
 *  clicks): `if (!(await isWindowOpen())) openWindow(...); else bringToFront();` isn't atomic -
 *  the PowerShell-spawning isWindowOpen() check takes a non-trivial amount of wall-clock time,
 *  and a SECOND deep link arriving while the FIRST one's check is still in flight (or its
 *  just-spawned Chrome window hasn't registered its title with the OS yet) sees "no window" too
 *  and ALSO spawns one. Every caller of the check-then-act sequence (handleDeepLink,
 *  handleTrayOpen in server.js) must go through this shared queue instead of calling
 *  isWindowOpen/openWindow/bringToFront directly - it chains each request onto the previous one
 *  via a single promise, so only one check-then-act runs at a time, and after opening a window it
 *  actively polls isWindowOpen() until the new window is CONFIRMED detectable (rather than
 *  guessing a fixed delay) before releasing the queue to the next caller. */
let _ensureQueue = Promise.resolve();
function ensureWindowOpenOrFocused(url) {
    const run = _ensureQueue.then(async () => {
        if (await isWindowOpen()) { bringToFront(); return; }
        openWindow(url);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
            if (await isWindowOpen()) return;
        }
    }).catch(() => {});
    _ensureQueue = run;
    return run;
}

module.exports = { openWindow, isWindowOpen, bringToFront, closeWindow, ensureWindowOpenOrFocused };
