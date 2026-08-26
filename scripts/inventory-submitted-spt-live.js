const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /submitted-returnsheets/i.test(candidate.url()));
    if (!page) page = await context.newPage();
    await page.goto('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets',
        { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const data = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        return {
            url: location.href,
            headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
            rows: Array.from(document.querySelectorAll('table tbody tr')).filter(visible).map((row, index) => ({
                index,
                cells: Array.from(row.cells).map((cell) => clean(cell.textContent)),
                actions: Array.from(row.querySelectorAll('button,a')).filter(visible).map((element, actionIndex) => ({
                    actionIndex,
                    tag: element.localName,
                    text: clean(element.textContent),
                    aria: element.getAttribute('aria-label') || '',
                    title: element.getAttribute('title') || '',
                    href: element.href || '',
                    iconClasses: Array.from(element.querySelectorAll('i,span')).map((child) => child.className).filter(Boolean)
                }))
            })),
            buttons: Array.from(document.querySelectorAll('button')).filter(visible).map((button) => ({
                text: clean(button.textContent), aria: button.getAttribute('aria-label') || '', title: button.getAttribute('title') || ''
            }))
        };
    });
    const output = path.join(os.tmpdir(), 'coretax-submitted-spt-live.json');
    fs.writeFileSync(output, JSON.stringify(data, null, 2));
    console.log(output);
    console.log(JSON.stringify({ url: data.url, headings: data.headings, rowCount: data.rows.length, rows: data.rows.slice(0, 25) }, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
