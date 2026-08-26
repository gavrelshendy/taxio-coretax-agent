const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { downloadLampiran } = require('../automation/lampiran');

(async () => {
    const mode = process.argv[2] === 'full' ? 'full' : 'print';
    const only = String(process.argv[3] || '').toUpperCase();
    const targets = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'coretax-monthly-spt-details-live.json'), 'utf8'))
        .filter((target) => !only || target.key === only);
    const code = { PPN: 'VAT_VAT', PPH21: 'ICT_WIT', UNIFIKASI: 'ICT_WT' };
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => /returnsheets-portal/i.test(candidate.url())) || await context.newPage();
    const saveRoot = path.join(os.tmpdir(), 'coretax-agent-monthly-layout-qa');
    for (const target of targets) {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2800);
        const result = await downloadLampiran(page, { saveRoot, entityCode: 'DFA' }, 'DFA', target.key, code[target.key], mode);
        console.log(target.key + ': ' + JSON.stringify(result));
    }
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
