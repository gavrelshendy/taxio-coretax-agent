// Probe cepat: downloadLampiran langsung untuk tab tertentu (CORETAX_LAMPIRAN_TRACE=1), SPT Badan MERATUS LINE.
const path = require('path');
const root = process.argv[2] || require('path').join(__dirname, '..'), url = process.argv[3], out = process.argv[4], only = (process.argv[5] || 'L1-D,L9').split(',');
const chrome = require(path.join(root, 'lib/chrome'));
const lampiran = require(path.join(root, 'automation/lampiran.js'));
const { log } = require(path.join(root, 'lib/log'));
const cred = { username: process.env.CT_USER, password: process.env.CT_PASS, pic_name: 'PIC UJI' };
// Lag event loop Node: seberapa lama Node tersumbat (perintah Playwright ikut tertunda).
const lag = { max: 0, over100: 0, total: 0 };
let tick = Date.now();
setInterval(() => { const d = Date.now() - tick - 200; tick = Date.now(); if (d > 0) { lag.total += d; lag.max = Math.max(lag.max, d); if (d > 100) lag.over100++; } }, 200).unref();
(async () => {
    await chrome.openCoretaxManual();
    const page = chrome.getManualPage();
    require(path.join(root, 'lib/returnsheet-grid-api')).watchContext(page.context());
    await page.goto('https://coretaxdjp.pajak.go.id/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    if (!await chrome.ensureLoggedIn(page, cred)) throw new Error('login gagal');
    if (!await chrome.switchToEntity(page, cred, { npwp: '0011082021631000', name: 'MERATUS LINE' })) throw new Error('impersonate gagal');
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('[PROBE] halaman SPT dibuka ' + (Date.now() - t0) + ' ms');
    const ids = /corporate-income-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i.exec(url);
    const res = await lampiran.downloadLampiran(page, { saveRoot: out, outputDir: out, entityCode: 'MERATUS LINE', entityName: 'MERATUS LINE', lampiranFormat: 'pdf', onlyLabels: only }, ids[1], ids[2], 'ICT_RCIT', 'full');
    log('[PROBE] hasil: ' + JSON.stringify({ ok: res.ok, error: res.error, paths: (res.paths || []).map((p) => path.basename(p)) }) + ' total ' + ((Date.now() - t0) / 1000).toFixed(0) + ' dtk');
    const st = require(path.join(root, 'lib/returnsheet-grid-api')).watchContext(page.context());
    log('[PROBE] lag event loop: total ' + lag.total + ' ms, maks ' + lag.max + ' ms, ' + lag.over100 + 'x >100ms; penyadap: ' + st.listenCount + ' respons, ' + st.listenMs + ' ms, ' + st.codeLists.length + ' daftar');
    const t1 = Date.now(); await page.evaluate(() => 1); log('[PROBE] satu page.evaluate kosong: ' + (Date.now() - t1) + ' ms');
    await chrome.closeAllAutomationWindows().catch(() => {});
    process.exit(0);
})().catch(async (e) => { log('[PROBE] GAGAL ' + (e.stack || e.message)); await chrome.closeAllAutomationWindows().catch(() => {}); process.exit(1); });
