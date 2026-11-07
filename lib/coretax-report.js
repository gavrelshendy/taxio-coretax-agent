/* Laporan Excel sesudah upload (isi Belum Terbit) dan sesudah issue & sign (Telah Terbit dengan nomor bukti potong).
 * Satu sheet per laporan: ringkasan di atas (entitas, jenis, masa, jumlah, total), lalu tabel per bukti potong. */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const grossOf = (r) => num(r.GrossIncome ?? r.TaxBase ?? r.SalaryPensionJhtTht);
const taxOf = (r) => num(r.IncomeTaxWithheld ?? r.IncomeTax ?? r.Article21IncomeTax);

/** rows: baris daftar e-Bupot Coretax. Hasil: path file. */
async function writeSlipReport(file, { entity, label, period, stage, rows, note }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(stage === 'issued' ? 'Telah Terbit' : 'Belum Terbit', { views: [{ state: 'frozen', ySplit: 8 }] });
    const totalGross = rows.reduce((a, r) => a + grossOf(r), 0), totalTax = rows.reduce((a, r) => a + taxOf(r), 0);
    ws.addRow([entity]).font = { bold: true, size: 13 };
    ws.addRow([label + ' · masa ' + period + ' · ' + (stage === 'issued' ? 'Telah Terbit (sesudah issue & sign)' : 'Belum Terbit (sesudah upload)')]).font = { bold: true };
    ws.addRow(['Dibuat Taxio Pilot ' + new Date().toLocaleString('id-ID')]);
    ws.addRow(['Jumlah bukti potong', rows.length]);
    ws.addRow(['Total bruto', totalGross]).getCell(2).numFmt = '#,##0';
    ws.addRow(['Total PPh', totalTax]).getCell(2).numFmt = '#,##0';
    ws.addRow([note || '']);
    const head = ws.addRow(['No', 'Nomor Bukti Potong', 'NIK / NPWP', 'Nama', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'PPh (Rp)', 'Status', 'Tanggal']);
    head.font = { bold: true }; head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; });
    rows.forEach((r, i) => {
        const row = ws.addRow([i + 1, r.WithholdingSlipsNumber || '', String(r.TaxIdentificationNumber || ''), String(r.Name || '').trim(), r.TaxObjectCode || '', grossOf(r), taxOf(r), r.WithholdingSlipsStatus || '', String(r.WithholdingSlipsDate || r.CreationDate || '').slice(0, 10)]);
        row.getCell(3).numFmt = '@'; row.getCell(6).numFmt = '#,##0'; row.getCell(7).numFmt = '#,##0';
    });
    [5, 20, 19, 34, 14, 18, 14, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.autoFilter = { from: { row: 8, column: 1 }, to: { row: 8 + rows.length, column: 9 } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let out = file;
    try { await wb.xlsx.writeFile(out); }
    catch (e) { if (e.code !== 'EBUSY') throw e; out = file.replace(/\.xlsx$/i, ' (' + Date.now() + ').xlsx'); await wb.xlsx.writeFile(out); }
    return out;
}

module.exports = { writeSlipReport, grossOf, taxOf };
