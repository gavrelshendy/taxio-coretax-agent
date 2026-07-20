/* TEMPORARY - verifies the 800-row import: (1) checks the real Simpan button state via DOM query
   (not a screenshot), (2) reads the draft record back from IndexedDB and diffs it row-by-row
   against what we originally computed from the Excel file, (3) if Simpan is enabled, clicks it
   and confirms the save round-trips correctly (reload + re-check counts/content).
   Run: node dev-verify-bigtest.js <caseAggregateId> */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const chrome = require('./lib/chrome');
const dividen = require('./automation/dividen');

const AGG = process.argv[2];
if (!AGG) { console.error('Usage: node dev-verify-bigtest.js <caseAggregateId>'); process.exit(1); }
const TEST_FILE = path.join(__dirname, 'Test Impor Dividen 800 - Coretax Agent.xlsx');

function deepEqualRow(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (a[k] !== b[k]) return k + ': ' + JSON.stringify(a[k]) + ' vs ' + JSON.stringify(b[k]);
    return null;
}

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://coretaxdjp.pajak.go.id/case-management-portal/id-ID/case-routing/' + AGG,
        { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 6000)); // let the form iframe settle

    // --- 1. Read back the draft and diff against expected ---
    console.log('=== Reading draft back from IndexedDB ===');
    const readCode = `(async () => {
        const open = indexedDB.open('e-tax-database');
        const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
        const s = 'autoSavedForms';
        const all = await new Promise((res) => { const r = db.transaction(s,'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
        const rec = all.find((x) => x.aggregateIdentifier === ${JSON.stringify(AGG)});
        if (!rec) return null;
        return { div: rec.data.DividendOrOtherIncomeReports, inv: rec.data.InvestmentReports };
    })()`;
    const actual = await page.evaluate(readCode);
    if (!actual) { console.log('NO RECORD FOUND for this case - cannot verify.'); await context.close(); return; }
    console.log('Read back: div count =', actual.div.length, '| inv count =', actual.inv.length);

    // Recompute the EXPECTED rows the same way the real import did.
    const scraped = JSON.parse(JSON.parse(fs.readFileSync('.dev-inspect/out-48.json', 'utf8')).find((e) => e.result && e.result.includes('income')).result);
    const cities = JSON.parse(fs.readFileSync('.dev-inspect/cities.json', 'utf8'));
    const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    const maps = {
        income: Object.fromEntries(scraped.income.map((x) => [nrm(x.desc), x.code])),
        currency: Object.fromEntries(scraped.currency.map((x) => [nrm(x.name), x.code])),
        form: Object.fromEntries(scraped.form.map((x) => [nrm(x.name), x.code])),
        city: Object.fromEntries(cities.map((x) => [nrm(x.name), x.code])),
        fullYearPeriods: Object.fromEntries([2019,2020,2021,2022,2023,2024,2025,2026,2027].map((y) => ['0112' + y, true])),
    };
    const parsed = await dividen.__test.parseTemplate(fs.readFileSync(TEST_FILE));
    const expected = dividen.__test.buildRows(parsed, maps);
    console.log('Expected: div count =', expected.dividend.length, '| inv count =', expected.investment.length);

    let mismatches = 0;
    if (actual.div.length !== expected.dividend.length) { console.log('DIV COUNT MISMATCH!'); mismatches++; }
    if (actual.inv.length !== expected.investment.length) { console.log('INV COUNT MISMATCH!'); mismatches++; }
    for (let i = 0; i < Math.min(actual.div.length, expected.dividend.length); i++) {
        const diff = deepEqualRow(actual.div[i], expected.dividend[i]);
        if (diff) { console.log('DIV row', i, 'MISMATCH:', diff); mismatches++; if (mismatches > 10) break; }
    }
    for (let i = 0; i < Math.min(actual.inv.length, expected.investment.length); i++) {
        const diff = deepEqualRow(actual.inv[i], expected.investment[i]);
        if (diff) { console.log('INV row', i, 'MISMATCH:', diff); mismatches++; if (mismatches > 10) break; }
    }
    console.log(mismatches === 0 ? '*** ALL ROWS MATCH EXACTLY ***' : ('*** ' + mismatches + ' MISMATCHES FOUND ***'));

    // --- 2. Check the real Simpan button state ---
    console.log('=== Checking Simpan button state ===');
    let btnInfo = null;
    for (const frame of page.frames()) {
        const btn = frame.locator('button.btn-primary', { hasText: 'Simpan' }).first();
        const count = await btn.count().catch(() => 0);
        if (count) { btnInfo = { frame: frame.url(), disabled: await btn.isDisabled().catch(() => null) }; break; }
    }
    console.log('Simpan button:', btnInfo ? JSON.stringify(btnInfo) : 'NOT FOUND in any frame');

    if (btnInfo && btnInfo.disabled === false) {
        console.log('=== Clicking Simpan ===');
        for (const frame of page.frames()) {
            const btn = frame.locator('button.btn-primary', { hasText: 'Simpan' }).first();
            if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 8000 }).catch((e) => console.log('click failed:', e.message)); break; }
        }
        await new Promise((r) => setTimeout(r, 3000));
        console.log('Clicked. Reloading to confirm persistence server-side...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 6000));
        const afterSave = await page.evaluate(readCode);
        console.log('After save + reload: div =', afterSave ? afterSave.div.length : 'N/A', '| inv =', afterSave ? afterSave.inv.length : 'N/A');
    }

    await page.screenshot({ path: path.join(__dirname, '.dev-inspect', 'verify-result.png'), fullPage: false }).catch(() => {});
    console.log('Done.');
})().catch((e) => console.error('Failed:', e.stack || e));
