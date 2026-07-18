const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
    const userDataDir = path.join(os.homedir(), '.coretax-agent-profile', '_test');
    console.log('Launching Chrome...');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        viewport: null,
        args: ['--start-maximized', '--no-first-run', '--no-default-browser-check']
    });
    const page = context.pages()[0] || await context.newPage();
    await page.bringToFront();
    console.log('page.bringToFront() called');

    // Try CDP approach to maximize + bring to front
    try {
        const session = await context.newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        console.log('windowId:', windowId);

        // First restore (in case minimized), then maximize
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await page.waitForTimeout(200);
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        console.log('CDP setWindowBounds maximized OK');
        await session.detach();
    } catch (e) {
        console.log('CDP approach failed:', e.message);
    }

    await page.goto('https://coretaxdjp.pajak.go.id', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    console.log('Done - window should be visible and maximized. Waiting 5 seconds then closing...');
    await page.waitForTimeout(5000);
    await context.close();
    console.log('Closed.');
    process.exit(0);
})();
