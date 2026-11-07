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

/** Laporan gabungan satu entitas & masa untuk satu SPT: PPh 21 = BPMP + BP21 + BPA1, Unifikasi = BPPU. Dibaca ulang
 *  dari Coretax setiap sesudah upload / issue & sign, jadi selalu keadaan terbaru. snap = coretax-issue.snapshot(). */
async function writePeriodReport(file, { entity, title, snap, note }) {
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet('Ringkasan');
    sum.addRow([entity]).font = { bold: true, size: 13 };
    sum.addRow([title + ' · masa ' + snap.period]).font = { bold: true };
    sum.addRow(['Dibaca dari Coretax oleh Taxio Pilot ' + new Date().toLocaleString('id-ID') + (note ? ' · ' + note : '')]);
    sum.addRow([]);
    const head = sum.addRow(['Jenis', 'Belum Terbit', 'Bruto Belum Terbit (Rp)', 'PPh Belum Terbit (Rp)', 'Telah Terbit', 'Bruto Telah Terbit (Rp)', 'PPh Telah Terbit (Rp)']);
    head.font = { bold: true }; head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; });
    const tot = [0, 0, 0, 0, 0, 0];
    for (const g of snap.groups) {
        const v = [g.notIssued.length, g.notIssued.reduce((a, r) => a + grossOf(r), 0), g.notIssued.reduce((a, r) => a + taxOf(r), 0), g.issued.length, g.issued.reduce((a, r) => a + grossOf(r), 0), g.issued.reduce((a, r) => a + taxOf(r), 0)];
        v.forEach((x, i) => { tot[i] += x; });
        const row = sum.addRow([g.label, ...v]); [3, 4, 6, 7].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    }
    if (snap.groups.length > 1) { const row = sum.addRow(['TOTAL', ...tot]); row.font = { bold: true }; [3, 4, 6, 7].forEach((c) => { row.getCell(c).numFmt = '#,##0'; }); }
    sum.addRow([]);
    sum.addRow(['Belum Terbit = sudah diunggah, belum resmi. Telah Terbit = sudah diterbitkan (dan ditandatangani untuk BP21 / BPA1 / BPPU) dan bernomor; inilah yang masuk SPT saat Posting.']);
    [16, 13, 22, 20, 13, 22, 20].forEach((w, i) => { sum.getColumn(i + 1).width = w; });
    for (const g of snap.groups) {
        const ws = wb.addWorksheet(g.label, { views: [{ state: 'frozen', ySplit: 1 }] });
        const h = ws.addRow(['Status', 'Nomor Bukti Potong', 'NIK / NPWP', 'Nama', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'PPh (Rp)', 'Tanggal']);
        h.font = { bold: true }; h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; });
        for (const [status, rows] of [['Telah Terbit', g.issued], ['Belum Terbit', g.notIssued]]) for (const r of rows) {
            const row = ws.addRow([status, r.WithholdingSlipsNumber || '', String(r.TaxIdentificationNumber || ''), String(r.Name || '').trim(), r.TaxObjectCode || '', grossOf(r), taxOf(r), String(r.WithholdingSlipsDate || r.CreationDate || '').slice(0, 10)]);
            row.getCell(3).numFmt = '@'; row.getCell(6).numFmt = '#,##0'; row.getCell(7).numFmt = '#,##0';
            if (status === 'Belum Terbit') row.getCell(1).font = { color: { argb: 'FFC00000' } };
        }
        [14, 20, 19, 34, 14, 18, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, ws.rowCount), column: 8 } };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let out = file;
    try { await wb.xlsx.writeFile(out); }
    catch (e) { if (e.code !== 'EBUSY') throw e; out = file.replace(/\.xlsx$/i, ' (' + Date.now() + ').xlsx'); await wb.xlsx.writeFile(out); }
    return out;
}

module.exports = { writeSlipReport, writePeriodReport, grossOf, taxOf };
