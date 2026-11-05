// node scripts/bpa1-xml.js "<kode> <tahun> - Rekap SPT PPh 21 Setahun (A1).xlsx" [--tin <NPWP pemotong 16 digit>] [--date YYYY-MM-DD]
// XML impor BPA1 Coretax dari sheet Draft Desember rekap Mode A1 (lib/a1-desember.js). Disimpan di sebelah rekap.
const path = require('path'), fs = require('fs'), ExcelJS = require('exceljs');
const desember = require('../lib/a1-desember');
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
(async () => {
    const file = process.argv[2];
    if (!file || !/\.xlsx$/i.test(file)) throw new Error('Pakai: node scripts/bpa1-xml.js <rekap.xlsx> [--tin <NPWP pemotong>] [--date YYYY-MM-DD]');
    const year = (/(20\d{2}) - Rekap/.exec(path.basename(file)) || [])[1];
    if (!year) throw new Error('Tahun tidak terbaca dari nama file rekap.');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const out = desember.buildXml(wb, { year, tin: arg('tin'), date: arg('date') });
    const target = file.replace(/ - Rekap SPT PPh 21 Setahun \(A1\).*\.xlsx$/i, '') + ' - BPA1 Desember (impor).xml';
    fs.writeFileSync(target, out.xml, 'utf8');
    console.log('XML BPA1: ' + target + '\n' + out.count + ' bukti potong' + (out.skipped ? ' (' + out.skipped + ' baris tanpa penghasilan dilewati)' : '')
        + ' · PPh 21 setahun ' + out.totalTax.toLocaleString('id-ID') + ' · PPh Desember (draft) ' + out.totalDes.toLocaleString('id-ID'));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
