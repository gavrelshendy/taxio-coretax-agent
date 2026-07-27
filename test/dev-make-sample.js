/* TEMPORARY - makes a FILLED-IN copy of the import template with valid sample data, for testing
   the Dividen import feature. Loads the generated template (keeps its dropdowns/validation) and
   overwrites the data rows + Info Umum city with realistic sample values, then saves as a new
   "Test ..." file. Run: node dev-make-sample.js */
const ExcelJS = require('exceljs');
const path = require('path');

const SRC = path.join(__dirname, 'Template Impor Dividen - Coretax Agent.xlsx');
const OUT = path.join(__dirname, 'Test Impor Dividen - Coretax Agent.xlsx');

// Sample values chosen to all be VALID and to resolve to Coretax codes (labels copied verbatim
// from the Referensi lists). Includes a decimal amount (…672.5) to prove decimals pass.
const CITY = 'KOTA SURABAYA';
const TABUNGAN = 'bentuk investasi lainnya yang sah sesuai dengan peraturan perundang-undangan - tabungan';
const dividenRows = [
    // Pelaporan, Tahun, Jenis, Pemberi, Tanggal, KursBagi, NomBagi, KursInv, NomInv, (LN cols left blank)
    [1, 'Januari - Desember 2023', '1. Dividen Domestik', 'PT Contoh Satu', '2023-12-21', 'Rupiah Indonesia', 100000000, 'Rupiah Indonesia', 100000000],
    [1, 'Januari - Desember 2024', '1. Dividen Domestik', 'PT Contoh Dua', '2024-12-23', 'Rupiah Indonesia', 200000000, 'Rupiah Indonesia', 200000000],
    [2, 'Januari - Desember 2024', '1. Dividen Domestik', 'PT Contoh Tiga', '2024-12-06', 'Rupiah Indonesia', 300000000.5, 'Rupiah Indonesia', 300000000.5],
];
const investasiRows = [
    // Pelaporan, Tahun, Tanggal, Bentuk, Kurs, Nominal
    [1, 'Januari - Desember 2023', '2023-12-31', TABUNGAN, 'Rupiah Indonesia', 100000000],
    [1, 'Januari - Desember 2024', '2024-12-31', TABUNGAN, 'Rupiah Indonesia', 200000000],
    [2, 'Januari - Desember 2024', '2024-12-06', TABUNGAN, 'Rupiah Indonesia', 300000000.5],
];

function writeRows(sheet, rows, startCol1, ncols) {
    // Clear old data rows (2..N) values for the used columns, then write sample rows from row 2.
    for (let r = 2; r <= 2 + Math.max(rows.length, 5); r++) {
        for (let c = 1; c <= ncols; c++) sheet.getCell(r, c).value = null;
    }
    rows.forEach((vals, i) => {
        const row = sheet.getRow(2 + i);
        vals.forEach((v, c) => { row.getCell(c + 1).value = v; });
        row.font = {}; // drop the template example row's grey italic style
    });
}

(async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(SRC);
    const get = (re) => wb.worksheets.find((s) => re.test(s.name));

    // Info Umum: set the Kota/Kabupaten value (row with "Kota" in col A).
    const info = get(/info/i);
    info.eachRow((row) => { const k = String(row.getCell(1).value || '').toLowerCase(); if (k.indexOf('kota') !== -1) row.getCell(2).value = CITY; });

    writeRows(get(/dividen/i), dividenRows, 1, 12);
    writeRows(get(/investasi/i), investasiRows, 1, 6);

    await wb.xlsx.writeFile(OUT);
    console.log('Sample written:', OUT);
    console.log('Dividen rows:', dividenRows.length, '| Investasi rows:', investasiRows.length, '| City:', CITY);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
