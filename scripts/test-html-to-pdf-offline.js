// BPE dengan sumber luar yang tidak bisa dijangkau (logo / font diblokir jaringan) tetap tercetak, tidak timeout.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderHtmlToPdf, closeRenderer } = require('../lib/html-to-pdf');
(async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpe-')), 'bpe.pdf');
    // 10.255.255.1: alamat yang tidak menjawab - permintaannya menggantung seperti sumber yang diblokir firewall.
    const html = '<!doctype html><html><head><title>BPE</title><link rel="stylesheet" href="http://10.255.255.1/font.css"></head>'
        + '<body><img src="http://10.255.255.1/logo.png" width="80"><h1>Bukti Penerimaan Elektronik</h1><p>Contoh</p></body></html>';
    const t0 = Date.now();
    await renderHtmlToPdf(html, out);
    const ms = Date.now() - t0;
    await closeRenderer();
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 1000, 'PDF tercetak');
    assert.ok(ms < 25000, 'selesai tanpa menunggu sumber luar terlalu lama (' + ms + ' ms)');
    console.log('html-to-pdf offline ok (' + ms + ' ms)');
})().catch((e) => { console.error(e); process.exit(1); });
