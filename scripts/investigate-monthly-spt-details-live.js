const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const LIST_URL = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';
const targets = [
    { key: 'PPN', needles: ['Jenis Pajak PPN', 'Masa Pajak Juni 2026', 'Model SPT Normal'] },
    { key: 'PPH21', needles: ['Jenis Pajak PPh Pasal 21/26', 'Masa Pajak Juli 2026'] },
    { key: 'UNIFIKASI', needles: ['Jenis Pajak PPh Unifikasi', 'Masa Pajak Juli 2026'] }
];

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /submitted-returnsheets/i.test(candidate.url()));
    if (!page) page = await context.newPage();
    const results = [];
    for (const target of targets) {
        await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2800);
        let rows = page.locator('table tbody tr');
        for (const needle of target.needles) rows = rows.filter({ hasText: needle });
        const row = rows.first();
        if (!await row.isVisible()) throw new Error('Baris ' + target.key + ' tidak ditemukan.');
        const eye = row.locator('button').filter({ has: page.locator('.pi-eye') }).first();
        if (!await eye.isVisible()) throw new Error('Tombol lihat ' + target.key + ' tidak ditemukan.');
        await eye.click();
        await page.waitForTimeout(3200);
        const detail = await page.evaluate(() => {
            const visible = (element) => {
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            return {
                url: location.href,
                title: document.title,
                headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
                tabs: Array.from(document.querySelectorAll('.p-tabview-title,[role="tab"]')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
                tableCount: Array.from(document.querySelectorAll('table')).filter(visible).length,
                tableHeaders: Array.from(document.querySelectorAll('table')).filter(visible).map((table) =>
                    Array.from(table.querySelectorAll('thead th')).map((th) => clean(th.textContent)).filter(Boolean)),
                buttons: Array.from(document.querySelectorAll('button')).filter(visible).map((button) => ({
                    text: clean(button.textContent), title: button.getAttribute('title') || '',
                    aria: button.getAttribute('aria-label') || '', className: button.className
                })).filter((item) => item.text || item.title || item.aria || /pdf|print|eye/i.test(item.className)),
                components: Array.from(document.querySelectorAll('*')).map((e) => e.localName)
                    .filter((name, index, all) => /return|spt|withhold|vat|periodic/i.test(name) && all.indexOf(name) === index)
            };
        });
        detail.key = target.key;
        results.push(detail);
        await page.screenshot({ path: path.join(os.tmpdir(), 'coretax-' + target.key.toLowerCase() + '-detail-live.png'), fullPage: false });
        console.log(target.key, JSON.stringify(detail, null, 2));
    }
    const output = path.join(os.tmpdir(), 'coretax-monthly-spt-details-live.json');
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log(output);
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
