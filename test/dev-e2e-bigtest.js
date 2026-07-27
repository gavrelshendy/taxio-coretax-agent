/* TEMPORARY - tests the Dividen import pipeline at scale (800 rows): login, create a fresh case,
   run the import ONCE, then check whether Coretax's own re-validation/Simpan/save handled the
   volume gracefully (not just our own validation, which is already proven instant offline).
   Run: node dev-e2e-bigtest.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const chrome = require('../lib/chrome');
const dividen = require('../automation/dividen');

const TEST_FILE = path.join(__dirname, 'Test Impor Dividen 800 - Coretax Agent.xlsx');

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    const page = context.pages()[0] || await context.newPage();

    console.log('=== Waiting for you to log in manually (or already logged in) ===');
    await page.goto(chrome.CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
        if (!chrome.isLoggedOut(page)) { loggedIn = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('Login detected:', loggedIn);
    if (!loggedIn) { console.log('LOGIN TIMEOUT - aborting.'); await context.close(); return; }

    console.log('=== Creating new case ===');
    await dividen.openNewCase(page, (m) => console.log('  [nav] ' + m));
    console.log('Case URL:', page.url());

    const fileBuffer = fs.readFileSync(TEST_FILE);
    console.log('=== Import run (800 dividen + 5 investasi rows) ===');
    const t0 = Date.now();
    try {
        await dividen.runDividenImport({ manualPage: page, fileBuffer });
    } catch (e) {
        console.log('IMPORT THREW:', e.message);
    }
    console.log('Import wall-clock time:', (Date.now() - t0) + 'ms');

    // Verify by reading the grid's ACTUAL row count in the correct frame (fixing the earlier
    // test-script bugs: search all frames, and check total rows via the paginator's own text
    // rather than counting rendered <tr> which is paginated to a handful per page).
    await new Promise((r) => setTimeout(r, 2000));
    for (const frame of page.frames()) {
        const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
        const m = /Menampilkan\s+\d+\s+sampai\s+\d+\s+dari\s+(\d+)\s+entri/gi;
        let match; const totals = [];
        while ((match = m.exec(text))) totals.push(match[1]);
        if (totals.length) console.log('Frame', frame.url().slice(-60), '-> paginator totals found:', totals);
    }

    await page.screenshot({ path: path.join(__dirname, '.dev-inspect', 'bigtest-result.png'), fullPage: true }).catch(() => {});
    console.log('Screenshot saved to .dev-inspect/bigtest-result.png');
    console.log('Done. Leaving browser open for inspection.');
})().catch((e) => console.error('Test failed:', e.stack || e));
