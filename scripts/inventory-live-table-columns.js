const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const TAB = '.p-tabview-title';

async function inventory(port, taxpayer) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(c => c.pages())
    .find(p => /\/(corporate|personal)-income-tax-return\//i.test(p.url()));
  if (!page) throw new Error(`Halaman SPT tidak ditemukan pada port ${port}`);

  const labels = await page.evaluate((selector) => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    return [...new Set([...document.querySelectorAll(selector)].filter(visible).map(e => (e.textContent || '').trim()).filter(Boolean))];
  }, TAB);
  const result = { taxpayer, url: page.url(), tabs: [] };

  for (const label of labels) {
    const loc = page.locator(TAB).filter({ hasText: label });
    for (let i = 0; i < await loc.count(); i++) {
      if (((await loc.nth(i).textContent()) || '').trim() === label && await loc.nth(i).isVisible()) {
        await loc.nth(i).click(); break;
      }
    }
    await page.waitForTimeout(900);
    const tables = await page.evaluate(() => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const output = [];
      [...document.querySelectorAll('table')].filter(visible).forEach((table, tableIndex) => {
        const headerRows = [...(table.tHead ? table.tHead.rows : [])];
        if (!headerRows.length) return;
        const grid = [], meta = [];
        headerRows.forEach((row, ri) => {
          grid[ri] ||= []; let pos = 0;
          [...row.cells].forEach(th => {
            while (grid[ri][pos]) pos++;
            const cs = th.colSpan || 1, rs = th.rowSpan || 1, text = clean(th.textContent);
            for (let r = ri; r < ri + rs; r++) {
              grid[r] ||= [];
              for (let c = pos; c < pos + cs; c++) grid[r][c] = true;
            }
            for (let c = pos; c < pos + cs; c++) {
              meta[c] ||= { headerPath: [], values: [] };
              if (text && meta[c].headerPath.at(-1) !== text) meta[c].headerPath.push(text);
            }
            pos += cs;
          });
        });
        const rows = [...table.tBodies].flatMap(b => [...b.rows]);
        rows.forEach(row => [...row.cells].forEach((cell, ci) => {
          if (!meta[ci]) return;
          const value = clean(cell.textContent);
          if (value && !meta[ci].values.includes(value)) meta[ci].values.push(value);
        }));
        output.push({
          tableIndex,
          rowCount: rows.length,
          columns: meta.map((m, index) => ({
            index,
            headerPath: m.headerPath,
            leaf: m.headerPath.at(-1) || '',
            valueCount: m.values.length,
            maxLength: m.values.reduce((n, v) => Math.max(n, v.length), 0),
            values: m.values.slice(0, 12)
          }))
        });
      });
      return output;
    });
    result.tabs.push({ label, tables });
    process.stdout.write(`${taxpayer} ${label}: ${tables.length} tabel\n`);
  }
  await browser.close();
  return result;
}

(async () => {
  const reports = [
    await inventory(9741, 'DION FARMA ABADI — BADAN 2025')
  ];
  const out = path.join(os.tmpdir(), 'coretax-lampiran-column-inventory.json');
  fs.writeFileSync(out, JSON.stringify(reports, null, 2));
  console.log(out);
})().catch(error => { console.error(error); process.exitCode = 1; });
