// Absolute bare minimum - does Playwright show a Chrome window at all?
const { chromium } = require('playwright');

(async () => {
    console.log('Launching with BARE MINIMUM options...');
    
    // Test 1: non-persistent context (simplest possible)
    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome'
    });
    const page = await browser.newPage();
    await page.goto('https://example.com');
    console.log('TEST 1 (non-persistent): Page loaded. DO YOU SEE CHROME? Waiting 10s...');
    await page.waitForTimeout(10000);
    await browser.close();
    console.log('Test 1 done.');
    
    process.exit(0);
})();
