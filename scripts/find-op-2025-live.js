const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:10015');
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(candidate => /personal-income-tax-return/i.test(candidate.url())) || pages[0];
  await page.goto('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; };
    return Array.from(document.querySelectorAll('tr')).filter(visible).map((row, index) => ({
      index,
      text: (row.textContent || '').replace(/\s+/g, ' ').trim(),
      links: Array.from(row.querySelectorAll('a')).map(a => ({ text: (a.textContent || '').trim(), href: a.href })),
      buttons: Array.from(row.querySelectorAll('button')).map(b => ({
        text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
        title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), className: b.className,
        html: b.innerHTML.slice(0, 300)
      }))
    })).filter(row => /2025/.test(row.text));
  });
  const row2025 = page.locator('tr').filter({ hasText: 'SPT Tahunan PPh Wajib Pajak Orang Pribadi' })
    .filter({ hasText: 'Januari - Desember 2025' }).first();
  const eye = row2025.locator('button').filter({ has: page.locator('.pi-eye') }).first();
  if (!await eye.isVisible().catch(() => false)) throw new Error('Tombol view SPT OP 2025 tidak ditemukan');
  await eye.click();
  await page.waitForTimeout(3000);
  const openPages = browser.contexts().flatMap(context => context.pages());
  const opened = openPages.find(candidate => /personal-income-tax-return/i.test(candidate.url()));
  console.log(JSON.stringify({ listUrl: page.url(), openedUrl: opened && opened.url(), rows }, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
