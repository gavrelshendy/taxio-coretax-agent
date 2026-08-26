const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { preparePageForPrint } = require('../automation/lampiran');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const page = browser.contexts().flatMap((context) => context.pages())
        .find((candidate) => /corporate-income-tax-return/i.test(candidate.url()));
    if (!page) throw new Error('Halaman SPT Badan tidak ditemukan.');
    const tabs = page.locator('.p-tabview-title').filter({ hasText: 'L1-B' });
    for (let i = 0; i < await tabs.count(); i++) {
        const tab = tabs.nth(i);
        if ((await tab.textContent()).trim() === 'L1-B' && await tab.isVisible()) {
            await tab.click();
            break;
        }
    }
    await page.waitForTimeout(1200);
    await preparePageForPrint(page, 'L1-B', { entity: 'DION FARMA ABADI', year: '2025' });
    const session = await page.context().newCDPSession(page);
    const result = await session.send('Page.printToPDF', {
        printBackground: true, preferCSSPageSize: true, scale: 0.9
    });
    const output = path.join(os.tmpdir(), 'coretax-l1b-header-final.pdf');
    fs.writeFileSync(output, Buffer.from(result.data, 'base64'));
    process.stdout.write(output + '\n');
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
