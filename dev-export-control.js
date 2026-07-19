/* TEMPORARY - builds a human-readable "control" .xlsx from the data we already proved (via
   dev-verify-bigtest.js's row-by-row deep-equal diff) is byte-identical to what's stored in
   Coretax's own draft - codes mapped back to labels so it can be eyeballed against the original
   template. Run: node dev-export-control.js */
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const dividen = require('./automation/dividen');

const TEST_FILE = path.join(__dirname, 'Test Impor Dividen 800 - Coretax Agent.xlsx');

(async () => {
    const scraped = JSON.parse(JSON.parse(fs.readFileSync('.dev-inspect/out-48.json', 'utf8')).find((e) => e.result && e.result.includes('income')).result);
    const cities = JSON.parse(fs.readFileSync('.dev-inspect/cities.json', 'utf8'));
    const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    const maps = {
        income: Object.fromEntries(scraped.income.map((x) => [nrm(x.desc), x.code])),
        currency: Object.fromEntries(scraped.currency.map((x) => [nrm(x.name), x.code])),
        form: Object.fromEntries(scraped.form.map((x) => [nrm(x.name), x.code])),
        city: Object.fromEntries(cities.map((x) => [nrm(x.name), x.code])),
        fullYearPeriods: Object.fromEntries([2019,2020,2021,2022,2023,2024,2025,2026,2027].map((y) => ['0112' + y, true])),
    };
    const parsed = await dividen.__test.parseTemplate(fs.readFileSync(TEST_FILE));
    const built = dividen.__test.buildRows(parsed, maps);
    console.log('This IS the exact data verified byte-identical to Coretax\'s own draft (dev-verify-bigtest.js), and whose count (800/5) was reconfirmed present after Simpan + a fresh reload.');

    const incomeByCode = Object.fromEntries(scraped.income.map((x) => [x.code, x.desc]));
    const currencyByCode = Object.fromEntries(scraped.currency.map((x) => [x.code, x.name]));
    const formByCode = Object.fromEntries(scraped.form.map((x) => [x.code, x.name]));
    const periodLabel = (code) => { const m = /^\d{4}(\d{4})$/.exec(code || ''); return m ? ('Januari - Desember ' + m[1]) : code; };

    const wb = new ExcelJS.Workbook();
    const divSheet = wb.addWorksheet('Dividen (Control)');
    divSheet.addRow(['Pelaporan Ke-', 'Tahun', 'Jenis Penghasilan', 'Pemberi Penghasilan', 'Tanggal Diterima', 'Kurs Dibagikan', 'Nominal Dibagikan', 'Kurs Diinvestasikan', 'Nominal Diinvestasikan']);
    built.dividend.forEach((r) => divSheet.addRow([r.Period1, periodLabel(r.FiscalYear1), incomeByCode[r.IncomeType] || r.IncomeType, r.IncomeProvider, r.DateOfAcquisition, currencyByCode[r.CurrencyDividendDistributed] || r.CurrencyDividendDistributed, r.AmountDividendDistributed, currencyByCode[r.CurrencyDividendInvested] || r.CurrencyDividendInvested, r.AmountDividendInvested]));

    const invSheet = wb.addWorksheet('Investasi (Control)');
    invSheet.addRow(['Pelaporan Ke-', 'Tahun', 'Tanggal Investasi', 'Bentuk Investasi', 'Kurs', 'Nominal']);
    built.investment.forEach((r) => invSheet.addRow([r.Period2, periodLabel(r.FiscalYear2), r.DateInvestment, formByCode[r.FormInvestment] || r.FormInvestment, currencyByCode[r.CurrencyInvestment] || r.CurrencyInvestment, r.AmountInvestment]));

    const infoSheet = wb.addWorksheet('Info');
    infoSheet.addRow(['Field', 'Nilai']);
    infoSheet.addRow(['Case Aggregate ID', '51f7c082-7e2e-47d2-8506-506145059511']);
    infoSheet.addRow(['Total Dividen', built.dividend.length]);
    infoSheet.addRow(['Total Investasi', built.investment.length]);
    infoSheet.addRow(['Verifikasi', 'Data diverifikasi byte-identical dgn draft Coretax (deep-equal per baris); jumlah 800/5 dikonfirmasi ULANG setelah Simpan + reload penuh dari server.']);

    const outPath = path.join(__dirname, 'Control Hasil Impor 800 - Coretax Agent.xlsx');
    await wb.xlsx.writeFile(outPath);
    console.log('Control file written:', outPath);
})().catch((e) => console.error('Failed:', e.stack || e));
