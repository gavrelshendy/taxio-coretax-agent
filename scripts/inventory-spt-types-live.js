const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    const page = await context.newPage();
    const url = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/not-submitted-returnsheets';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const data = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const rowData = Array.from(document.querySelectorAll('table tbody tr')).filter(visible).map((row) => ({
            text: clean(row.textContent),
            links: Array.from(row.querySelectorAll('a')).map((a) => ({ text: clean(a.textContent), href: a.href })),
            buttons: Array.from(row.querySelectorAll('button')).map((b) => clean(b.textContent) || b.getAttribute('aria-label') || '')
        }));
        return {
            url: location.href,
            title: document.title,
            headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
            tabs: Array.from(document.querySelectorAll('.p-tabview-title,[role="tab"]')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
            rows: rowData,
            links: Array.from(document.querySelectorAll('a')).filter(visible).map((a) => ({ text: clean(a.textContent), href: a.href })).filter((x) => x.text),
            buttons: Array.from(document.querySelectorAll('button')).filter(visible).map((b) => clean(b.textContent) || b.getAttribute('aria-label') || '').filter(Boolean),
            components: Array.from(document.querySelectorAll('*')).map((e) => e.localName).filter((name, index, all) => /return|spt|withhold|vat/i.test(name) && all.indexOf(name) === index)
        };
    });
    const output = path.join(os.tmpdir(), 'coretax-spt-types-live.json');
    fs.writeFileSync(output, JSON.stringify(data, null, 2));
    console.log(output);
    console.log(JSON.stringify({ url: data.url, headings: data.headings, tabs: data.tabs, rowCount: data.rows.length, rows: data.rows.slice(0, 30), buttons: data.buttons, components: data.components }, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
