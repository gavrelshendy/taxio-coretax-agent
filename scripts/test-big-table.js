/* Tabel lampiran di atas 1.000 baris (lib/lampiran-big-table.js): PDF memuat 50 baris pertama dengan
 * jumlah seluruh baris, dan seluruh baris ditulis ke Excel "daftar lengkap" (stream ExcelJS - juga
 * dijalankan di dalam exe lewat --test-lampiran-export).
 *   node scripts/test-big-table.js */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const ExcelJS = require('exceljs');
const big = require('../lib/lampiran-big-table');

async function run() {
    assert.equal(big.BIG_ROWS, 1000); assert.equal(big.SHOWN_ROWS, 50);
    const headers = ['NO.', 'NAMA PEMOTONG/PEMUNGUT', 'DASAR PENGENAAN PAJAK (Rupiah)', 'PPH YANG DIPOTONG/DIPUNGUT (Rupiah)', 'BUKTI POTONG/SSP/SSPCP - TANGGAL'];
    const rows = (n) => Array.from({ length: n }, (_, i) => [String(i + 1), 'PT ' + (i % 7), '1.000', i % 2 ? '20,50' : '(10)', '21-02-2025']);
    const tab = { label: 'L3', tables: [
        { index: 0, bodies: ['<tr><td>kecil</td></tr>'], rows: rows(big.BIG_ROWS), headers },
        { index: 1, bodies: ['x'], rows: rows(5001), headers }
    ] };
    const lists = big.splitBigTables([tab]);
    assert.equal(lists.length, 1, 'hanya tabel di atas 1.000 baris yang dipisah');
    const [small, large] = tab.tables;
    assert.equal(small.bodies[0], '<tr><td>kecil</td></tr>'); assert(!('rows' in small) && !('fullCount' in small));
    assert.equal(large.fullCount, 5001);
    assert.equal(large.bodies[0].split('<tr>').length - 1, big.SHOWN_ROWS);
    // 5.001 x 1.000 = 5.001.000; 2.500 x 20,50 - 2.501 x 10 = 26.240
    assert.equal(large.fullTotals[2], '5.001.000'); assert.equal(large.fullTotals[3], '26.240');
    assert(!(4 in large.fullTotals), 'tanggal bukan angka');

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'big-table-')), 'L3 (daftar lengkap).xlsx');
    await big.writeFullList(file, lists[0], { title: 'SPT Tahunan PPh Badan', entity: 'UJI', entityNpwp: '0000000000000000', period: 'Tahun 2025' });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    assert.equal(ws.rowCount, 5 + 5001 + 1, 'kop 5 baris + semua baris + JUMLAH');
    const first = ws.getRow(6).values.slice(1), last = ws.getRow(ws.rowCount).values.slice(1);
    assert.equal(first[2], 1000); assert.equal(first[3], -10); assert(first[4] instanceof Date);
    assert.equal(last[0], 'JUMLAH (5.001 BARIS)'); assert.equal(last[2], 5001000); assert.equal(last[3], 26240);
    console.log('PASS: tabel > 1.000 baris: PDF 50 baris + jumlah seluruh baris; Excel daftar lengkap (5001 baris, angka/tanggal bertipe, JUMLAH).');
}

module.exports = run;
if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; });
