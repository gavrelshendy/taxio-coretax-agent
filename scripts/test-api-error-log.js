/* Tes pencatatan permintaan API Coretax yang ditolak (lib/chrome.js attachApiErrorLog): respons 400 dan
   5xx ke coretaxdjp.pajak.go.id harus masuk log aktivitas lengkap dengan isi permintaan dan balasan,
   sedangkan respons sukses, 403/404, dan domain lain tidak boleh tercatat; maksimal 8 catatan per halaman.
   Tanpa jaringan sungguhan: semua permintaan dijawab oleh page.route(). Jalankan:
     node scripts/test-api-error-log.js */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const assert = require('assert');
const { chromium } = require('playwright');
const chromeLib = require('../lib/chrome.js');
const { onLogLine } = require('../lib/log.js');

(async () => {
    const lines = [];
    const off = onLogLine((e) => lines.push(e.msg));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.route('https://coretaxdjp.pajak.go.id/**', (route) => {
        const u = route.request().url();
        if (u.endsWith('/home')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body>ok</body>' });
        if (u.includes('/api/ok')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        if (u.includes('/api/bad400')) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Masa pajak tidak valid"}' });
        if (u.includes('/api/forbidden')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
        if (u.includes('/api/missing')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (u.includes('/api/boom')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"galat server"}' });
        return route.fulfill({ status: 200, body: '' });
    });
    await page.route('https://contoh-lain.example/**', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"x":1}' }));
    chromeLib.attachApiErrorLog(page);
    chromeLib.attachApiErrorLog(page); // dipanggil ulang: tidak boleh mencatat ganda
    await page.goto('https://coretaxdjp.pajak.go.id/home');
    const call = (url, body) => page.evaluate(([u, b]) => fetch(u, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b } : undefined).then((r) => r.status), [url, body || null]);
    await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/ok');
    await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/forbidden');
    await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/missing');
    await call('https://contoh-lain.example/api/bad400');
    await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/bad400', JSON.stringify({ TaxPeriod: 10, TaxYear: 2026, EbupotType: 'BPPU' }));
    await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/boom');
    await page.waitForTimeout(500);
    const tagged = lines.filter((l) => /^\[Coretax \d{3}\]/.test(l));
    assert.strictEqual(tagged.length, 2, 'hanya 400 dan 500 yang tercatat (dan tidak ganda): ' + JSON.stringify(tagged));
    assert.ok(/^\[Coretax 400\] POST \/withholding-slips-portal\/api\/bad400 - permintaan: .*"TaxPeriod":10.* - balasan: .*Masa pajak tidak valid/.test(tagged[0]), 'isi permintaan dan balasan 400 ikut tercatat: ' + tagged[0]);
    assert.ok(/^\[Coretax 500\] GET \/withholding-slips-portal\/api\/boom - balasan: .*galat server/.test(tagged[1]), 'catatan 500: ' + tagged[1]);
    console.log('  ok   respons 400/5xx tercatat lengkap; sukses, 403, 404, domain lain, dan pemasangan ganda tidak');
    // batas 8 catatan per halaman
    for (let i = 0; i < 12; i++) await call('https://coretaxdjp.pajak.go.id/withholding-slips-portal/api/bad400?n=' + i);
    await page.waitForTimeout(500);
    const total = lines.filter((l) => /^\[Coretax \d{3}\]/.test(l)).length;
    assert.strictEqual(total, 8, 'maksimal 8 catatan per halaman, ada ' + total);
    console.log('  ok   maksimal 8 catatan per halaman');
    off();
    await browser.close();
    console.log('2 tes lulus.');
})().catch((e) => { console.error('FAIL', e.stack || e); process.exit(1); });
