/* TEMPORARY - generates an 800-row Dividen test file (+ a handful of Investasi rows) to test
   whether the injection pipeline and Coretax's own re-validation/save scale beyond a handful of
   rows. Reuses the live-scraped reference data so every value is guaranteed valid. Run:
   node dev-make-bigtest.js */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'Test Impor Dividen 800 - Coretax Agent.xlsx');
const CITY = 'KOTA SURABAYA';
const N_DIVIDEN = 800;
const N_INVESTASI = 5;
const TABUNGAN = 'bentuk investasi lainnya yang sah sesuai dengan peraturan perundang-undangan - tabungan';

(async () => {
    const wb = new ExcelJS.Workbook();

    const info = wb.addWorksheet('Info Umum');
    info.addRow(['Field', 'Nilai (isi di kolom ini)']);
    info.addRow(['Kota/Kabupaten *', CITY]);

    const div = wb.addWorksheet('Dividen');
    div.addRow(['Pelaporan Ke-', 'Dividen atas Tahun', 'Jenis Penghasilan', 'Pemberi Penghasilan', 'Tanggal Diterima',
        'Kurs Dividen Dibagikan', 'Nominal Dividen Dibagikan', 'Kurs Dividen Diinvestasikan', 'Nominal Dividen Diinvestasikan']);
    for (let i = 0; i < N_DIVIDEN; i++) {
        const pelaporan = (i % 3) + 1;
        const year = 2019 + (i % 9);
        const day = String(1 + (i % 28)).padStart(2, '0');
        const amount = 1000000 + i * 137; // varied, deterministic amounts
        div.addRow([pelaporan, 'Januari - Desember ' + year, '1. Dividen Domestik', 'PT Test Dividen ' + (i + 1),
            year + '-06-' + day, 'Rupiah Indonesia', amount, 'Rupiah Indonesia', amount]);
    }

    const inv = wb.addWorksheet('Investasi');
    inv.addRow(['Pelaporan Ke-', 'Dividen atas Tahun', 'Tanggal Investasi', 'Bentuk Investasi', 'Kurs Nilai Investasi', 'Nominal Nilai Investasi']);
    for (let i = 0; i < N_INVESTASI; i++) {
        const pelaporan = (i % 3) + 1;
        const year = 2019 + (i % 9);
        inv.addRow([pelaporan, 'Januari - Desember ' + year, year + '-12-31', TABUNGAN, 'Rupiah Indonesia', 5000000 + i * 777]);
    }

    await wb.xlsx.writeFile(OUT);
    console.log('Written:', OUT, '| Dividen rows:', N_DIVIDEN, '| Investasi rows:', N_INVESTASI);
})();
