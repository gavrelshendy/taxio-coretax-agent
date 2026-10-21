/* Tabel lampiran di atas 1.000 baris (lib/lampiran-big-table.js): PDF memuat baris pertama (Lengkap 1.000,
 * Ringkas 50) dengan jumlah seluruh baris, dan seluruh baris menjadi sheet "... lengkap" di Excel lampiran
 * (ExcelJS - juga dijalankan di dalam exe lewat --test-lampiran-export).
 *   node scripts/test-big-table.js */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const ExcelJS = require('exceljs');
const big = require('../lib/lampiran-big-table');

async function run() {
    assert.equal(big.BIG_ROWS, 1000); assert.equal(big.SHOWN_ROWS, 50);
    const headers = ['NAMA PEMOTONG/PEMUNGUT', 'DASAR PENGENAAN PAJAK (Rupiah)', 'PPH YANG DIPOTONG/DIPUNGUT (Rupiah)', 'BUKTI POTONG/SSP/SSPCP - TANGGAL'];
    const rows = (n) => Array.from({ length: n }, (_, i) => ['PT ' + (i % 7), '1.000', i % 2 ? '20,50' : '(10)', '21-02-2025']);
    const tab = { label: 'L9', tables: [
        { index: 0, bodies: ['<tr><td>kecil</td></tr>'], rows: rows(big.BIG_ROWS), headers },
        { index: 1, bodies: ['x'], rows: rows(5001), headers },
        { index: 2, bodies: ['y'], rows: rows(1200), headers }
    ] };
    const lists = big.splitBigTables([tab], big.BIG_ROWS);
    assert.equal(lists.length, 2, 'hanya tabel di atas 1.000 baris yang dipisah');
    const [small, large] = tab.tables;
    assert.equal(small.bodies[0], '<tr><td>kecil</td></tr>'); assert(!('rows' in small) && !('fullCount' in small));
    assert.equal(large.fullCount, 5001);
    assert.equal(large.bodies[0].split('<tr>').length - 1, big.BIG_ROWS, 'Lengkap: baris 1-1.000');
    assert.deepEqual(lists.map((l) => l.sheetName), ['L9 tabel 2 lengkap', 'L9 tabel 3 lengkap']);
    assert.equal(large.fullSheet, 'L9 tabel 2 lengkap');
    // 5.001 x 1.000 = 5.001.000; 2.500 x 20,50 - 2.501 x 10 = 26.240
    assert.equal(large.fullTotals[1], '5.001.000'); assert.equal(large.fullTotals[2], '26.240');
    assert(!(3 in large.fullTotals), 'tanggal bukan angka');
    const ringkas = { label: 'L3', tables: [{ index: 0, bodies: [''], rows: rows(1500), headers }] };
    big.splitBigTables([ringkas], big.SHOWN_ROWS);
    assert.equal(ringkas.tables[0].bodies[0].split('<tr>').length - 1, 50, 'Ringkas: baris 1-50');

    const wb = new ExcelJS.Workbook();
    for (const list of lists) big.addFullListSheet(wb, list, { title: 'SPT Tahunan PPh Badan', entity: 'UJI', entityNpwp: '0000000000000000', period: 'Tahun 2025' });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'big-table-')), 'Lampiran.xlsx');
    await wb.xlsx.writeFile(file);
    const back = new ExcelJS.Workbook(); await back.xlsx.readFile(file);
    const ws = back.getWorksheet('L9 tabel 2 lengkap');
    assert.equal(ws.rowCount, 5 + 5001 + 1, 'kop 5 baris + semua baris + JUMLAH');
    const head = ws.getRow(5).values.slice(1), first = ws.getRow(6).values.slice(1), last = ws.getRow(ws.rowCount).values.slice(1);
    assert.equal(head[0], 'NO.', 'kolom nomor urut ditambahkan');
    assert.equal(first[0], 1); assert.equal(first[2], 1000); assert.equal(first[3], -10); assert(first[4] instanceof Date);
    assert.equal(ws.getRow(ws.rowCount - 1).values[1], 5001, 'nomor urut sampai baris terakhir');
    assert.equal(last[0], 'JUMLAH (5.001 BARIS)'); assert.equal(last[2], 5001000); assert.equal(last[3], 26240);
    console.log('PASS: tabel > 1.000 baris: PDF baris 1-1.000 (Ringkas 1-50) + jumlah seluruh baris; seluruh baris di sheet "... lengkap" Excel lampiran (NO. urut, angka/tanggal bertipe, JUMLAH).');
}

module.exports = run;
if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; });
