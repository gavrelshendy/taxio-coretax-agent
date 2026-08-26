const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const checks = [
    { key: 'PPN', label: 'A-2' },
    { key: 'PPH21', label: 'L-III' },
    { key: 'UNIFIKASI', label: 'DAFTAR-I' }
];

(async () => {
    const targets = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'coretax-monthly-spt-details-live.json'), 'utf8'));
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /returnsheets-portal/i.test(candidate.url())) || await context.newPage();
    const results = [];
    for (const check of checks) {
        const target = targets.find((item) => item.key === check.key);
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        const tabs = page.locator('.p-tabview-title').filter({ hasText: check.label });
        for (let i = 0; i < await tabs.count(); i++) {
            const tab = tabs.nth(i);
            if ((await tab.textContent()).trim() === check.label && await tab.isVisible()) { await tab.click(); break; }
        }
        await page.waitForTimeout(900);
        const dropdowns = page.locator('.p-paginator-rpp-options:visible');
        const optionSets = [];
        for (let index = 0; index < await dropdowns.count(); index++) {
            const dropdown = dropdowns.nth(index);
            const paginatorText = await dropdown.evaluate((element) => element.closest('.p-paginator')?.textContent || '');
            await dropdown.click();
            await page.waitForTimeout(300);
            const options = await page.locator('.p-dropdown-panel .p-dropdown-item:visible').allTextContents();
            optionSets.push({ paginatorText: String(paginatorText || '').replace(/\s+/g, ' ').trim(), options: options.map((v) => v.trim()) });
            await page.keyboard.press('Escape');
        }
        results.push({ ...check, optionSets });
    }
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
