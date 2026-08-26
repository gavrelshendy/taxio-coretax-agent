const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { PDFDocument, PDFArray } = require('pdf-lib');

async function streamSizes(buffer) {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPages().map(page => {
    const contents = page.node.Contents();
    if (!contents) return 0;
    const refs = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
    return refs.reduce((sum, ref) => {
      const stream = pdf.context.lookup(ref);
      return sum + (stream && stream.contents ? stream.contents.length : 0);
    }, 0);
  });
}

async function run(port, label, name) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(context => context.pages())
    .find(candidate => /\/(corporate|personal)-income-tax-return\//i.test(candidate.url()));
  const tab = page.locator('.p-tabview-title').filter({ hasText: label }).first();
  await tab.click(); await page.waitForTimeout(1000);
  const session = await page.context().newCDPSession(page);
  for (const zoom of [0.9, 0.85, 0.8]) {
    await page.evaluate((value) => {
      let style = document.getElementById('__ca_form_zoom_test');
      if (!style) { style = document.createElement('style'); style.id = '__ca_form_zoom_test'; document.head.appendChild(style); }
      style.textContent = `@media print { body { zoom:${value} !important; } }`;
    }, zoom);
    const result = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, scale: 0.9 });
    const buffer = Buffer.from(result.data, 'base64');
    const out = path.join(os.tmpdir(), `qa-${name}-zoom-${zoom}.pdf`);
    fs.writeFileSync(out, buffer);
    console.log(JSON.stringify({ name, zoom, out, sizes: await streamSizes(buffer) }));
  }
  await page.evaluate(() => document.getElementById('__ca_form_zoom_test')?.remove());
  await browser.close();
}

(async () => {
  await run(10015, 'Induk', 'op-induk');
  await run(10015, 'L-4', 'op-l4');
  await run(9761, 'L10-B', 'badan-l10b');
  await run(9761, 'L10-D', 'badan-l10d');
  await run(9761, 'L11-A', 'badan-l11a');
  await run(9761, 'L2', 'badan-l2');
})().catch(error => { console.error(error); process.exitCode = 1; });
