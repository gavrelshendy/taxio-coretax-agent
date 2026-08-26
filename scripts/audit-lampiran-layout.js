const { chromium } = require('playwright');

const PORTS = [10015, 9761];
const TAB_SEL = '.p-tabview-title';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function auditPort(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(candidate => /\/(corporate|personal)-income-tax-return\//i.test(candidate.url()));
  if (!page) return { port, error: 'SPT page not found', urls: pages.map(p => p.url()) };
  const labels = await page.locator(TAB_SEL).allTextContents();
  const tabs = [];
  for (const raw of [...new Set(labels.map(v => v.trim()).filter(Boolean))]) {
    const tab = page.locator(TAB_SEL).filter({ hasText: raw }).first();
    if (!await tab.isVisible().catch(() => false)) continue;
    await tab.click();
    await sleep(900);
    tabs.push(await page.evaluate((label) => {
      const visible = el => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const tables = Array.from(document.querySelectorAll('table')).filter(visible).map((table, index) => {
        const rows = Array.from(table.tHead ? table.tHead.rows : []);
        const headerRow = rows.slice().sort((a, b) => b.cells.length - a.cells.length)[0];
        const headers = headerRow ? Array.from(headerRow.cells).map((th) => ({
          text: (th.textContent || '').replace(/\s+/g, ' ').trim(),
          controls: Array.from(th.querySelectorAll('input,.p-dropdown,.p-calendar,select')).map(el =>
            el.matches('input') ? `input:${el.getAttribute('type') || 'text'}` : el.className || el.tagName)
        })) : [];
        return {
          index,
          width: Math.round(table.getBoundingClientRect().width),
          columns: headers.length,
          headers,
          rows: Array.from(table.tBodies).reduce((n, body) => n + body.rows.length, 0)
        };
      });
      return { label, tables };
    }, raw));
  }
  await browser.close();
  return { port, url: page.url(), tabs };
}

(async () => {
  const result = [];
  for (const port of PORTS) result.push(await auditPort(port).catch(error => ({ port, error: error.message })));
  process.stdout.write(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
