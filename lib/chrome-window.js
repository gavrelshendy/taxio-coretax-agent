/* Chrome automation primitives: the automation window itself - bring it to the front (OS level via
 * the lib/shell.js seam), park it off-screen for Restricted Editor accounts, and reveal it again.
 * Split out of lib/chrome.js (still the public entry point). */
const { log } = require('./log');

// OS-level "bring the automation Chrome to the front" lives in the platform seam (lib/shell.js -
// see its header for why it is still WScript.Shell AppActivate through a hidden PowerShell).
const shell = require('./shell');

/* Which window to raise (audit 2026-11-12): AppActivate('Chrome') matches ANY window whose title contains
 * "Chrome" - it could raise the user's own daily Chrome instead of the Coretax window. The automation
 * Chrome's browser-process id is read once per context over a BROWSER-level CDP session
 * (context.browser().newBrowserCDPSession() -> SystemInfo.getProcessInfo, entry type 'browser'; checked
 * with Playwright 1.61 + launchPersistentContext: context.browser() exists there but has no process(), and
 * SystemInfo is refused on a page-level session) and AppActivate gets that pid - the browser process owns
 * the top-level windows. Z-order only, the window is never moved (Restricted Editor windows stay
 * off-screen). Pid unknown (no page given, CDP refused, fake page in tests) -> the old title match. */
const PID_LOOKUP_TIMEOUT_MS = 3000;
const _pidByContext = new WeakMap(); // BrowserContext -> Promise<pid|null>
function automationPid(page) {
    let context = null;
    try { context = page && typeof page.context === 'function' ? page.context() : null; } catch (e) { context = null; }
    if (!context || typeof context !== 'object') return Promise.resolve(null);
    let p = _pidByContext.get(context);
    if (!p) {
        let timer;
        p = Promise.race([
            (async () => {
                const browser = typeof context.browser === 'function' ? context.browser() : null;
                if (!browser || typeof browser.newBrowserCDPSession !== 'function') return null;
                const s = await browser.newBrowserCDPSession();
                try {
                    const r = await s.send('SystemInfo.getProcessInfo');
                    const b = ((r && r.processInfo) || []).find((x) => x && x.type === 'browser');
                    return b && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
                } finally { if (s && typeof s.detach === 'function') s.detach().catch(() => {}); }
            })(),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), PID_LOOKUP_TIMEOUT_MS); })
        ]).catch(() => null).finally(() => clearTimeout(timer));
        _pidByContext.set(context, p);
        p.then((pid) => { if (!pid && _pidByContext.get(context) === p) _pidByContext.delete(context); }); // gagal: coba lagi lain kali
    }
    return p;
}
/** Raise the automation Chrome window of `page` (by its browser pid; see above). Fire-and-forget for
 *  callers; resolves when the PowerShell command has been started. */
function bringChromeToFrontOnWindows(page) {
    if (!page) { shell.bringChromeToFront(); return Promise.resolve(); }
    return automationPid(page).then((pid) => shell.bringChromeToFront(pid || undefined), () => shell.bringChromeToFront());
}

async function hideWindowOffscreen(page) {
    try {
        // String literal, not a function reference - see revealWindow()'s comment for why.
        await page.evaluate('(function(){ window.moveTo(-32000, -32000); })()').catch(() => {});
        const session = await page.context().newCDPSession(page).catch(() => null);
        if (session) {
            await session.send('Browser.setWindowBounds', {
                windowId: (await session.send('Browser.getWindowForTarget')).windowId,
                bounds: { windowState: 'normal', left: -32000, top: -32000 }
            }).catch(() => {});
        }
    } catch (e) {}
}

async function revealWindow(page) {
    try {
        // A string, not a function reference: the old pkg bytecode build mangled
        // Function.toString(), which page.evaluate(fn) relies on to serialize it ("Passed function
        // is not well-serializable!", confirmed live 2026-07-27). The Electron build ships plain
        // sources, so functions would work again; the existing string literals are simply kept.
        await page.evaluate('(function(){ window.moveTo(0, 0); window.resizeTo(screen.availWidth, screen.availHeight); })()').catch((e) => log('[revealWindow] moveTo/resizeTo gagal: ' + e.message));
        const session = await page.context().newCDPSession(page).catch((e) => { log('[revealWindow] newCDPSession gagal: ' + e.message); return null; });
        if (session) {
            const windowId = (await session.send('Browser.getWindowForTarget')).windowId;
            // CDP refuses to jump straight from the off-screen/minimized state hideWindowOffscreen
            // leaves it in to 'maximized' in one call ("restore it to normal state first" -
            // confirmed live 2026-07-27) - restore to 'normal' first as its own separate call.
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
                .catch((e) => log('[revealWindow] restore-normal gagal: ' + e.message));
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } })
                .catch((e) => log('[revealWindow] setWindowBounds gagal: ' + e.message));
        } else {
            log('[revealWindow] tidak ada sesi CDP - window mungkin tetap di luar layar.');
        }
        await page.bringToFront().catch((e) => log('[revealWindow] bringToFront gagal: ' + e.message));
        bringChromeToFrontOnWindows(page);
    } catch (e) {
        log('[revealWindow] gagal total: ' + e.message);
    }
}

module.exports = { bringChromeToFrontOnWindows, automationPid, hideWindowOffscreen, revealWindow };
