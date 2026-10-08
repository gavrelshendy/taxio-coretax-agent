/* PPN rows built from Coretax's grid API (lib/lampiran-api-ppn.js) must read exactly as Coretax's
 * own table shows them. Checked against the captured fixtures (fixtures/coretax-spt/*-ppn-*.api.json:
 * the grid API rows plus the first page of each list as rendered by Coretax); skipped when the
 * fixtures are not on this machine (they hold client data and are not in the repository).
 *
 *   node scripts/test-ppn-api-rows.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { toDisplayRows, GRIDS } = require('../lib/lampiran-api-ppn');

(async () => {
    // A heading the mapping was not proven on, or a list without a mapping, is refused rather than guessed.
    assert.throws(() => toDisplayRows('A-2', ['No.', 'Nama'], [{ Name: 'X' }]), /judul kolom/);
    assert.throws(() => toDisplayRows('C', [], [{ Name: 'X' }]), /belum terpetakan/);
    assert.deepStrictEqual(toDisplayRows('C', [], []), []);
    const headers = ['No.', 'Nama Penjual', 'Nomor Identitas WP', 'Faktur Pajak - Nomor', 'Faktur Pajak - Tanggal', 'Harga Jual/DPP (Rupiah)', 'DPP Nilai Lain/ DPP (Rupiah)', 'PPN (Rupiah)', 'PPnBM (Rupiah)', 'Kode dan Nomor Seri Faktur Pajak yang Diganti/Diretur'];
    const [one] = toDisplayRows('B-2', headers, [{ Name: 'A  B', TIN: '0012', DocumentNumber: '04002', DocumentDate: '2026-07-31T00:00:00+07:00', TaxBase: 14819820731.666668, OtherTaxBase: -1.5, VAT: 0, STLG: null, TaxInvoiceCode: null }]);
    assert.deepStrictEqual(one, ['1', 'A B', '0012', '04002', '31-07-2026', '14.819.820.732', '-2', '0', '', '']);

    const dir = path.join(__dirname, '..', 'fixtures', 'coretax-spt');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /-ppn-.*\.api\.json$/i.test(f)) : [];
    if (!files.length) { console.log('PASS: PPN API mapping rules (fixtures not present - live comparison skipped).'); return; }
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let compared = 0;
    try {
        const page = await browser.newPage();
        for (const file of files) {
            const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            for (const tab of fixture.tabs) {
                const suffix = GRIDS[tab.label];
                const grid = suffix && fixture.grids.find((g) => g.endpoint.endsWith(suffix));
                const table = tab.template && tab.template.tables && tab.template.tables[0];
                if (!grid || !table || !grid.rows.length) continue;
                assert.strictEqual(grid.rows.length, grid.total, file + ' ' + tab.label + ': fixture incomplete');
                await page.setContent(table.html);
                const shown = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => { c.querySelectorAll('.p-column-title').forEach((n) => n.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); })).filter((r) => r.length > 2));
                const built = toDisplayRows(tab.label, table.headers, grid.rows);
                assert.strictEqual(built.length, grid.total);
                assert(shown.length > 0, file + ' ' + tab.label + ': no rows on the captured page');
                shown.forEach((cells, i) => cells.forEach((cell, c) => { if (c > 0) assert.strictEqual(built[i][c], cell, file + ' ' + tab.label + ' row ' + (i + 1) + ' "' + table.headers[c] + '"'); }));
                compared += shown.length;
            }
        }
    } finally { await browser.close(); }
    assert(compared > 0, 'no PPN fixture rows compared');
    console.log('PASS: PPN rows from the grid API match Coretax\'s own table (' + compared + ' captured rows across ' + files.length + ' SPT).');
})().catch((e) => { console.error(e); process.exitCode = 1; });
