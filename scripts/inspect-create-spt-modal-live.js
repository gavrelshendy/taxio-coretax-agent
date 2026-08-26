const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9741');
    const page = browser.contexts().flatMap((context) => context.pages())
        .find((candidate) => /not-submitted-returnsheets/i.test(candidate.url()));
    if (!page) throw new Error('Halaman daftar SPT tidak ditemukan.');
    const button = page.getByRole('button', { name: 'Buat Konsep SPT', exact: true });
    console.log('BUTTON', { count: await button.count(), visible: await button.isVisible(), enabled: await button.isEnabled() });
    await button.click();
    await page.waitForTimeout(800);
    const data = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        let scopes = Array.from(document.querySelectorAll('[role="dialog"],.p-dialog,.p-sidebar,.p-overlay,.p-overlaypanel,.p-confirm-dialog')).filter(visible);
        if (!scopes.length) scopes = [document.body];
        return scopes.map((scope) => ({
            text: clean(scope.textContent),
            labels: Array.from(scope.querySelectorAll('label')).map((e) => clean(e.textContent)).filter(Boolean),
            inputs: Array.from(scope.querySelectorAll('input,select')).map((e) => ({
                name: e.getAttribute('name') || '', formcontrol: e.getAttribute('formcontrolname') || '',
                placeholder: e.getAttribute('placeholder') || '', value: e.value || '', type: e.type || e.localName
            })),
            controls: Array.from(scope.querySelectorAll('.p-dropdown,.p-multiselect,[role="combobox"]')).map((e) => ({
                text: clean(e.textContent), aria: e.getAttribute('aria-label') || '', className: e.className
            })),
            buttons: Array.from(scope.querySelectorAll('button')).filter(visible).map((e) => clean(e.textContent) || e.getAttribute('aria-label') || '').filter(Boolean),
            dropdowns: Array.from(scope.querySelectorAll('.p-dropdown')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean)
        }));
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'coretax-create-spt-modal-live.png'), fullPage: false });
    const output = path.join(os.tmpdir(), 'coretax-create-spt-modal-live.json');
    fs.writeFileSync(output, JSON.stringify(data, null, 2));
    console.log(output);
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
