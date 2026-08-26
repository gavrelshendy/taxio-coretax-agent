const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => /coretaxdjp\.pajak\.go\.id/i.test(candidate.url()));
    if (!page) throw new Error('Sesi Coretax DFA tidak ditemukan.');
    const snapshot = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        return {
            title: document.title,
            url: location.href,
            headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible)
                .map((element) => clean(element.textContent)).filter(Boolean),
            links: Array.from(document.querySelectorAll('a')).filter(visible).map((element) => ({
                text: clean(element.textContent), href: element.href || '',
                aria: element.getAttribute('aria-label') || ''
            })).filter((item) => item.text || item.aria),
            buttons: Array.from(document.querySelectorAll('button')).filter(visible)
                .map((element) => clean(element.textContent) || element.getAttribute('aria-label') || '')
                .filter(Boolean),
            menuText: Array.from(document.querySelectorAll('nav,header,[role="menu"],[class*="menu" i]'))
                .filter(visible).map((element) => clean(element.textContent)).filter(Boolean).slice(0, 40)
        };
    });
    process.stdout.write(JSON.stringify(snapshot, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
