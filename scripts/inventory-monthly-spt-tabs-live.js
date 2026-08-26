const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const detailsPath = path.join(os.tmpdir(), 'coretax-monthly-spt-details-live.json');
    const targets = JSON.parse(fs.readFileSync(detailsPath, 'utf8'));
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /returnsheets-portal/i.test(candidate.url()));
    if (!page) page = await context.newPage();
    const report = [];
    for (const target of targets) {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2800);
        const labels = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('.p-tabview-title'))
            .filter((e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })
            .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))]);
        const tabs = [];
        for (const label of labels) {
            const candidates = page.locator('.p-tabview-title').filter({ hasText: label });
            let clicked = false;
            for (let index = 0; index < await candidates.count(); index++) {
                const candidate = candidates.nth(index);
                if ((await candidate.textContent()).trim() === label && await candidate.isVisible()) {
                    await candidate.click(); clicked = true; break;
                }
            }
            if (!clicked) continue;
            await page.waitForTimeout(900);
            const state = await page.evaluate(() => {
                const visible = (element) => {
                    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                };
                const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,.p-panel-title,.p-accordion-header-text'))
                    .filter(visible).map((e) => clean(e.textContent)).filter((text) => text && !/Hubungi Kami|Layanan Digital|Temukan Kami/.test(text));
                const tables = Array.from(document.querySelectorAll('table')).filter(visible).map((table, index) => ({
                    index,
                    headers: Array.from(table.querySelectorAll('thead th')).map((th) => clean(th.textContent)).filter(Boolean),
                    rowCount: Array.from(table.querySelectorAll('tbody tr')).filter(visible).length,
                    sample: Array.from(table.querySelectorAll('tbody tr')).filter(visible).slice(0, 2)
                        .map((row) => Array.from(row.cells).map((cell) => {
                            const clone = cell.cloneNode(true);
                            clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach((e) => e.remove());
                            return clean(clone.textContent);
                        }))
                }));
                return {
                    headings: [...new Set(headings)],
                    tables,
                    paginatorValues: Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(visible).map((e) => clean(e.textContent)),
                    rootTags: Array.from(document.body.children).flatMap((e) => Array.from(e.querySelectorAll(':scope *')))
                        .map((e) => e.localName).filter((name, index, all) => /^rshshr-/.test(name) && all.indexOf(name) === index)
                };
            });
            tabs.push({ label, ...state });
        }
        report.push({ key: target.key, url: target.url, labels, tabs });
        console.log(target.key, JSON.stringify(report[report.length - 1], null, 2));
    }
    const output = path.join(os.tmpdir(), 'coretax-monthly-spt-tabs-live.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(output);
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
