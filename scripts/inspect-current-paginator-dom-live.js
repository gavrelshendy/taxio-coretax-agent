const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /returnsheets-portal/i.test(candidate.url()));
    const label = process.argv[2];
    if (label) {
        const tabs = page.locator('.p-tabview-title').filter({ hasText: label });
        for (let index = 0; index < await tabs.count(); index++) {
            const tab = tabs.nth(index);
            if ((await tab.textContent()).trim() === label && await tab.isVisible()) { await tab.click(); break; }
        }
        await page.waitForTimeout(900);
    }
    const result = await page.evaluate(() => Array.from(document.querySelectorAll('.p-paginator')).filter((element) => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).map((element, index) => ({
        index,
        text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        className: element.className,
        dropdown: element.querySelector('.p-paginator-rpp-options')?.outerHTML.slice(0, 800) || '',
        buttons: Array.from(element.querySelectorAll('button')).map((button) => ({
            className: button.className, disabled: button.disabled, aria: button.getAttribute('aria-label') || '', text: (button.textContent || '').trim()
        }))
    })));
    console.log(JSON.stringify({ url: page.url(), result }, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
