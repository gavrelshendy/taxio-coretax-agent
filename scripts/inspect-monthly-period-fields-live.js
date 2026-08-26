const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
    const targets = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'coretax-monthly-spt-details-live.json'), 'utf8'));
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /returnsheets-portal/i.test(candidate.url())) || await context.newPage();
    const output = [];
    for (const target of targets) {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2400);
        output.push({ key: target.key, fields: await page.evaluate(() => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            return Array.from(document.querySelectorAll('input,select,textarea,.p-dropdown-label')).map((element) => ({
                tag: element.localName, type: element.type || '', formcontrol: element.getAttribute('formcontrolname') || '',
                name: element.getAttribute('name') || '', id: element.id || '', placeholder: element.getAttribute('placeholder') || '',
                value: clean(element.value != null ? element.value : element.textContent),
                parentText: clean(element.closest('.form-group,.field,.row,[class*="col-"]')?.textContent || '').slice(0, 250)
            })).filter((field) => /masa|period|month|year|tahun|pajak/i.test(Object.values(field).join(' ')));
        }) });
    }
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
