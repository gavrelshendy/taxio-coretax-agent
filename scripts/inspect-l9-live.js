const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9761');
  const page = browser.contexts().flatMap(context => context.pages())
    .find(candidate => /corporate-income-tax-return/i.test(candidate.url()));
  const tab = page.locator('.p-tabview-title').filter({ hasText: 'L9' }).first();
  await tab.click();
  await page.waitForTimeout(1200);
  await page.emulateMedia({ media: 'print' });
  const result = await page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; };
    return Array.from(document.querySelectorAll('table')).filter(visible).map((table, index) => ({
      index,
      className: table.className,
      head: Array.from(table.tHead ? table.tHead.rows : []).map(row => Array.from(row.cells).map(cell => ({
        text: (cell.textContent || '').replace(/\s+/g, ' ').trim(), colSpan: cell.colSpan, rowSpan: cell.rowSpan,
        className: cell.className, display: getComputedStyle(cell).display,
        background: getComputedStyle(cell).backgroundColor,
        childBackgrounds: Array.from(cell.children).map(child => getComputedStyle(child).backgroundColor)
      }))),
      body: Array.from(table.tBodies).flatMap(body => Array.from(body.rows)).slice(0, 3).map(row => Array.from(row.cells).map(cell => ({
        text: (cell.textContent || '').replace(/\s+/g, ' ').trim(), className: cell.className,
        checkbox: !!cell.querySelector('input[type="checkbox"]'), display: getComputedStyle(cell).display
      }))),
      colgroups: Array.from(table.querySelectorAll(':scope > colgroup')).map(group => ({
        ca: group.dataset.caLayout || '', display: getComputedStyle(group).display,
        cols: Array.from(group.children).map(col => ({ width: col.style.getPropertyValue('--ca-width'), display: getComputedStyle(col).display }))
      }))
    }));
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('PRINT_STYLE=' + await page.locator('#__ca_print_style').textContent().catch(() => 'MISSING'));
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
