/* TEMPORARY - full end-to-end test harness: opens the manual-profile browser, logs in with the
   given credential, creates a fresh AS.39-01 case via automation/dividen.js's openNewCase(),
   runs the Dividen import TWICE in a row (reproducing the user's double-click), and inspects the
   IndexedDB draft record after each run - to find out why the table showed empty despite two
   "SELESAI" log lines. Run: node dev-e2e-test.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const chrome = require('../lib/chrome');
const dividen = require('../automation/dividen');

const TEST_FILE = path.join(__dirname, process.argv[2] || 'Test Impor Dividen - Coretax Agent.xlsx');

async function checkDraft(page, label) {
    const code = `(async () => {
        const open = indexedDB.open('e-tax-database');
        const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
        const s = 'autoSavedForms';
        if (!Array.from(db.objectStoreNames).includes(s)) return { found:false };
        const all = await new Promise((res) => { const r = db.transaction(s,'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
        if (!all.length) return { found:false, count:0 };
        const rec = all[0];
        return { found:true, count: all.length, div: (rec.data.DividendOrOtherIncomeReports||[]).length, inv: (rec.data.InvestmentReports||[]).length, keys: Object.keys(rec.data).length };
    })()`;
    const result = await page.evaluate(code);
    console.log('[' + label + '] IndexedDB draft:', JSON.stringify(result));
    return result;
}
async function checkGrid(page, label) {
    const rows = await page.evaluate(() => {
        const bodies = document.querySelectorAll('.p-datatable-tbody');
        return Array.from(bodies).map((b) => b.querySelectorAll('tr').length);
    }).catch(() => null);
    console.log('[' + label + '] Grid row counts (dividen, investasi):', JSON.stringify(rows));
}

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    const page = context.pages()[0] || await context.newPage();

console.log('=== Waiting for you to log in manually in the opened window ===');
    await page.goto(chrome.CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
        if (!chrome.isLoggedOut(page)) { loggedIn = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('Login detected:', loggedIn, '| current url:', page.url());
    if (!loggedIn) { console.log('LOGIN TIMEOUT - aborting.'); await context.close(); return; }

    console.log('=== Creating new case ===');
    try {
        await dividen.openNewCase(page, (m) => console.log('  [nav] ' + m));
    } catch (e) {
        await page.screenshot({ path: path.join(__dirname, '.dev-inspect', 'e2e-failure.png') }).catch(() => {});
        console.log('openNewCase FAILED, screenshot saved to .dev-inspect/e2e-failure.png');
        throw e;
    }
    console.log('Case URL:', page.url());
    await checkDraft(page, 'after-case-create');
    await checkGrid(page, 'after-case-create');

    const fileBuffer = fs.readFileSync(TEST_FILE);

    console.log('=== Import run #1 ===');
    await dividen.runDividenImport({ manualPage: page, fileBuffer });
    await new Promise((r) => setTimeout(r, 2000)); // let Angular settle post-reload
    await checkDraft(page, 'after-run-1 (+2s)');
    await checkGrid(page, 'after-run-1 (+2s)');

    console.log('=== Waiting 5s (simulating user pause before re-click) ===');
    await new Promise((r) => setTimeout(r, 5000));
    await checkDraft(page, 'after-run-1 (+7s)');
    await checkGrid(page, 'after-run-1 (+7s)');

    console.log('=== Import run #2 (simulating double-click) ===');
    await dividen.runDividenImport({ manualPage: page, fileBuffer });
    await new Promise((r) => setTimeout(r, 2000));
    await checkDraft(page, 'after-run-2 (+2s)');
    await checkGrid(page, 'after-run-2 (+2s)');

    console.log('=== Waiting 8s more, then final check (simulates user checking later) ===');
    await new Promise((r) => setTimeout(r, 8000));
    await checkDraft(page, 'FINAL (+8s)');
    await checkGrid(page, 'FINAL (+8s)');

    console.log('Done. Leaving browser open for inspection - close it manually when done.');
})().catch((e) => { console.error('Test failed:', e.stack || e); });
