/* TEMPORARY - quick read-only check: has aggregateId's autoSavedForms record appeared yet, purely
   from time passing (no new interaction)? Opens a new tab in the same manual profile (read-only
   query, doesn't matter which window/tab is "active"). Run: node dev-check-record.js <aggregateId> */
const path = require('path');
const { chromium } = require('playwright');
const chrome = require('../lib/chrome');

const AGG = process.argv[2];
if (!AGG) { console.error('Usage: node dev-check-record.js <aggregateId>'); process.exit(1); }

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        args: ['--no-first-run', '--no-default-browser-check'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    const page = await context.newPage();
    await page.goto('https://coretaxdjp.pajak.go.id/home-portal/id-ID/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const code = `(async () => {
        const open = indexedDB.open('e-tax-database');
        const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
        const s = 'autoSavedForms';
        if (!Array.from(db.objectStoreNames).includes(s)) return { seen: [] };
        const all = await new Promise((res) => { const r = db.transaction(s,'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
        return { seen: all.map((x) => x.aggregateIdentifier), div: all.map((x) => (x.data.DividendOrOtherIncomeReports||[]).length) };
    })()`;
    const result = await page.evaluate(code);
    console.log('Looking for:', AGG);
    console.log('Currently in IndexedDB:', JSON.stringify(result));
    console.log('MATCH:', result.seen.includes(AGG));
    await page.close();
})().catch((e) => console.error('Failed:', e.message));
