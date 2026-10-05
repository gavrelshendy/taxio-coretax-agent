/* Tes skrip yang ditanam ke halaman Coretax. Skrip-skrip ini ditulis di dalam template string, sehingga
   backslash tunggal di regex hilang diam-diam - bug nyata dua kali: regex \D (impersonate) dan
   /\/payment-portal\// yang menjadi komentar "//" sehingga bridge billing SyntaxError dan tak pernah
   aktif ("Lihat" di Daftar Kode Billing Belum Dibayar membuat Chrome crash, live 2026-10-05).
   (1) Setiap skrip harus lolos parse. (2) Bridge billing harus menangkap pola klik Coretax yang asli:
   dispatchEvent(click) pada anchor blob BILLING_CODE_*.pdf yang tidak menempel di dokumen - PDF
   dikirim ke penyimpan Node, dan Chrome sendiri tidak mengunduh apa pun. Jalankan:
     node scripts/test-injected-scripts.js */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const assert = require('assert');
const { chromium } = require('playwright');
const chromeLib = require('../lib/chrome.js');
const watchdog = require('../lib/coretax-watchdog.js');
const { buildLampiranWidgetScript } = require('../lib/lampiran-widget.js');

const BILLING_URL = 'https://coretaxdjp.pajak.go.id/payment-portal/id-ID/active-dashboard-billing-code';
const OTHER_URL = 'https://coretaxdjp.pajak.go.id/home-portal/id-ID/';

(async () => {
    let passed = 0;
    const ok = (name) => { passed++; console.log('  ok   ' + name); };

    const scripts = {
        'bridge billing': chromeLib.BILLING_BLOB_BRIDGE_INIT,
        'watchdog restricted': watchdog.buildWatchdogInitScript(null, false, true),
        'watchdog restricted + kunci impersonate': watchdog.buildWatchdogInitScript(['bppu'], true, true),
        'watchdog bebas': watchdog.buildWatchdogInitScript(null, false, false),
        'widget passphrase': watchdog.buildPassphraseWidgetScript('rahasia\\"`$'),
        'widget lampiran': buildLampiranWidgetScript(false)
    };
    for (const [name, code] of Object.entries(scripts)) {
        if (!code) continue;
        assert.doesNotThrow(() => new Function(code), name + ' tidak lolos parse');
        ok('parse: ' + name);
    }

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const saved = [];
    await context.exposeFunction('__ca_saveBillingBlobV116', ({ filename, base64 }) => { saved.push({ filename, size: Buffer.from(base64, 'base64').length }); return true; });
    await context.addInitScript({ content: chromeLib.BILLING_BLOB_BRIDGE_INIT });
    await context.route('https://coretaxdjp.pajak.go.id/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>tiruan</body>' }));
    const page = await context.newPage();
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));

    // Pola Coretax asli: anchor blob tidak menempel di dokumen, dipicu lewat dispatchEvent.
    const coretaxClick = (filename) => page.evaluate(`(() => {
        const blob = new Blob([new Uint8Array(81249)], { type: 'application/pdf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = ${JSON.stringify(filename)};
        a.dispatchEvent(new MouseEvent('click'));
    })()`);

    await page.goto(BILLING_URL);
    assert.strictEqual(await page.evaluate('!!window.__coretaxAgentBillingBlobBridgeInstalled'), true, 'bridge tidak aktif di halaman billing');
    ok('bridge aktif di halaman Daftar Kode Billing Belum Dibayar');

    await coretaxClick('BILLING_CODE_1791189311.pdf');
    await page.waitForTimeout(800);
    assert.deepStrictEqual(saved, [{ filename: 'BILLING_CODE_1791189311.pdf', size: 81249 }]);
    assert.deepStrictEqual(downloads, [], 'Chrome tetap mengunduh sendiri');
    ok('dispatchEvent(click) anchor lepas: PDF ke penyimpan Node, Chrome tidak mengunduh');

    saved.length = 0;
    await page.evaluate(`(() => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['x'], { type: 'application/pdf' })); a.download = 'BILLING_CODE_2.pdf';
        document.body.appendChild(a); a.click();
    })()`);
    await page.waitForTimeout(800);
    assert.strictEqual(saved.length, 1, 'a.click() tidak tertangkap');
    ok('a.click() anchor menempel juga tertangkap');

    saved.length = 0; downloads.length = 0;
    await coretaxClick('Laporan.pdf');
    await page.waitForTimeout(1500);
    assert.strictEqual(saved.length, 0, 'unduhan bukan billing ikut ditangkap');
    ok('nama file selain BILLING_CODE_*.pdf dibiarkan ke Chrome');

    await page.goto(OTHER_URL);
    saved.length = 0;
    await coretaxClick('BILLING_CODE_3.pdf');
    await page.waitForTimeout(1500);
    assert.strictEqual(saved.length, 0, 'bridge menangkap di luar halaman billing');
    ok('di luar halaman billing tidak ditangkap');

    await browser.close();
    console.log(passed + ' tes lulus.');
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
