/* Chrome automation primitives: the automation window itself - bring it to the front (OS level via
 * the lib/shell.js seam), park it off-screen for Restricted Editor accounts, and reveal it again.
 * Split out of lib/chrome.js (still the public entry point). */
const { log } = require('./log');

// OS-level "bring the automation Chrome to the front" lives in the platform seam (lib/shell.js -
// see its header for why it is still WScript.Shell AppActivate through a hidden PowerShell).
const shell = require('./shell');
function bringChromeToFrontOnWindows() { shell.bringChromeToFront(); }

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
        bringChromeToFrontOnWindows();
    } catch (e) {
        log('[revealWindow] gagal total: ' + e.message);
    }
}

module.exports = { bringChromeToFrontOnWindows, hideWindowOffscreen, revealWindow };
