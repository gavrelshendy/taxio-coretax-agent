const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { downloadLampiran } = require('../automation/lampiran');

const targets = [
  { port: 9741, taxType: 'ICT_RCIT', key: 'BADAN' }
];

(async () => {
  const saveRoot = path.join(os.tmpdir(), 'coretax-agent-live-layout-qa');
  for (const target of targets) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${target.port}`);
    const page = browser.contexts().flatMap(context => context.pages())
      .find(candidate => /\/(corporate|personal)-income-tax-return\//i.test(candidate.url()));
    if (!page) throw new Error(`Halaman SPT ${target.key} tidak ditemukan pada port ${target.port}`);
    const result = await downloadLampiran(page, { saveRoot, entityCode: `QA-${target.key}` },
      `QA-${target.key}`, 'live-layout', target.taxType, 'full');
    process.stdout.write(`${target.key}: ${JSON.stringify(result)}\n`);
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exitCode = 1; });
