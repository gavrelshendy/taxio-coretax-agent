/* TEMPORARY dev tool - generates the import template .xlsx for the new Dividen/Investasi
   e-Reporting feature. Reads the exact reference lists (income types, currencies, forms of
   investment) that were scraped live from Coretax into .dev-inspect/out-48.json, so the
   template's dropdowns match the site precisely with zero manual transcription. Safe to delete
   after the template is produced. Run: node dev-make-template.js */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// --- pull the live-scraped reference lists ---------------------------------------------------
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '.dev-inspect', 'out-48.json'), 'utf8'));
const scraped = JSON.parse(raw.find((e) => e.result && e.result.includes('income')).result);
const INCOME = scraped.income;      // [{code,name,desc}]  desc = "1. Dividen Domestik"
const CURRENCY = scraped.currency;  // [{code,name,desc}]
const FORM = scraped.form;          // [{code,name}]
const CITY = JSON.parse(fs.readFileSync(path.join(__dirname, '.dev-inspect', 'cities.json'), 'utf8')); // [{code,name}] all 514 Kota/Kabupaten

// Income types the user actually uses are 1-3 (Domestik, LN Go Public, LN Swasta), but list all 5.
const incomeLabels = INCOME.map((x) => x.desc);                 // "1. Dividen Domestik", ...
const currencyLabels = CURRENCY.map((x) => x.name);             // "Rupiah Indonesia", ...
const formLabels = FORM.map((x) => x.name);
const cityLabels = CITY.map((x) => x.name).sort();              // "KOTA SURABAYA", ... (514, sorted A-Z)
// Full-calendar-year periods ("Januari - Desember YYYY" -> code 0112YYYY). Cover a useful range.
const years = [];
for (let y = 2019; y <= 2027; y++) years.push('Januari - Desember ' + y);

// --- helpers ---------------------------------------------------------------------------------
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD54F' } }; // amber, matches Coretax grid
const REQ_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
const OPT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } };

function styleHeaderRow(sheet, requiredCount) {
    const row = sheet.getRow(1);
    row.height = 34;
    row.eachCell((cell, col) => {
        cell.fill = HEADER_FILL;
        cell.font = { bold: true, size: 11 };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
}

function addListValidation(sheet, colLetter, formulaRange, firstRow, lastRow) {
    for (let r = firstRow; r <= lastRow; r++) {
        sheet.getCell(colLetter + r).dataValidation = {
            type: 'list', allowBlank: true, formulae: [formulaRange], showErrorMessage: true,
            errorStyle: 'stop', errorTitle: 'Nilai tidak valid',
            error: 'Pilih salah satu nilai dari daftar (lihat sheet Referensi).'
        };
    }
}

/** `kind` = 'whole' (integers only, e.g. Pelaporan 1-3) or 'decimal' (fractions allowed, e.g.
 *  Nominal 3916296672.5 - confirmed live: Coretax's amount fields set fraction=null/minFractionDigits=0,
 *  i.e. no max-decimal cap, and real data carries .5). */
function addNumberValidation(sheet, colLetter, firstRow, lastRow, min, max, kind) {
    for (let r = firstRow; r <= lastRow; r++) {
        const dv = {
            type: kind === 'decimal' ? 'decimal' : 'whole', allowBlank: true,
            operator: max != null ? 'between' : 'greaterThanOrEqual',
            formulae: max != null ? [String(min), String(max)] : [String(min)],
            showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Angka tidak valid',
            error: (kind === 'whole' ? 'Isi bilangan bulat' : 'Isi angka')
                + (max != null ? (' antara ' + min + ' dan ' + max + '.') : (' minimal ' + min + '.'))
                + ' Jangan pakai pemisah ribuan (titik/koma); desimal boleh pakai koma/titik sesuai Excel Anda.'
        };
        sheet.getCell(colLetter + r).dataValidation = dv;
    }
}

const DATA_ROWS = 200; // pre-format this many blank rows for data entry + validation

// =============================================================================================
const wb = new ExcelJS.Workbook();
wb.creator = 'Coretax Agent';
wb.created = new Date();

// --- Sheet: Petunjuk -------------------------------------------------------------------------
const guide = wb.addWorksheet('Petunjuk', { properties: { tabColor: { argb: 'FF1B3A6B' } } });
guide.columns = [{ width: 3 }, { width: 110 }];
const guideLines = [
    ['', 'TEMPLATE IMPOR e-REPORTING REALISASI INVESTASI (DIVIDEN) - COage'],
    ['', ''],
    ['', 'Cara pakai:'],
    ['', '1. Buat dulu draft kasus di Coretax: Portal Saya > Buat Permohonan Layanan Administrasi >'],
    ['', '   e-Pelaporan > Laporan Realisasi Investasi, sampai halaman "Alur Kasus" terbuka.'],
    ['', '2. Isi sheet "Dividen" dan/atau "Investasi" di file ini (satu baris = satu data).'],
    ['', '3. Jalankan fitur "Impor Dividen" di Coretax Agent, pilih file ini. Data akan otomatis'],
    ['', '   masuk ke tabel pada draft, lalu Anda tinggal PERIKSA dan klik Kirim sendiri.'],
    ['', ''],
    ['', 'Aturan pengisian (divalidasi otomatis - sama seperti aturan form Coretax):'],
    ['', '  • Pelaporan Ke-      : wajib, hanya 1, 2, atau 3.'],
    ['', '  • Dividen atas Tahun : wajib, pilih dari daftar (mis. "Januari - Desember 2025").'],
    ['', '  • Jenis Penghasilan  : wajib, pilih dari daftar (1 s/d 3 untuk dividen dalam/luar negeri).'],
    ['', '  • Tanggal            : wajib, format YYYY-MM-DD (mis. 2025-12-31). TIDAK perlu klik kalender.'],
    ['', '  • Kurs (Mata Uang)   : wajib, pilih dari daftar (mis. "Rupiah Indonesia").'],
    ['', '  • Nominal            : wajib, angka minimal 1 (tanpa titik/koma pemisah ribuan).'],
    ['', '  • Bentuk Investasi   : wajib (sheet Investasi), pilih dari daftar.'],
    ['', ''],
    ['', 'Kolom untuk Dividen LUAR NEGERI (Jenis 2/3): isi juga "Laba Setelah Pajak (Kurs/Nominal)"'],
    ['', 'dan "Proporsi Kepemilikan Saham (%)". Untuk Dividen Domestik (Jenis 1), kolom itu boleh kosong.'],
    ['', ''],
    ['', ''],
    ['', 'Sheet "Info Umum": isi Kota/Kabupaten (WAJIB - tombol Simpan Coretax non-aktif kalau kosong).'],
    ['', 'Semua daftar nilai yang valid (jenis, mata uang, tahun, bentuk investasi, kota) ada di sheet "Referensi".'],
];
guideLines.forEach((vals, i) => {
    const row = guide.addRow(vals);
    if (i === 0) row.getCell(2).font = { bold: true, size: 14, color: { argb: 'FF1B3A6B' } };
    if (['Cara pakai:', 'Aturan pengisian (divalidasi otomatis - sama seperti aturan form Coretax):'].includes(vals[1])) row.getCell(2).font = { bold: true, size: 12 };
});

// --- Sheet: Referensi (valid values) ---------------------------------------------------------
const ref = wb.addWorksheet('Referensi', { properties: { tabColor: { argb: 'FF2E7D32' } } });
ref.columns = [
    { header: 'Jenis Penghasilan', key: 'income', width: 55 },
    { header: 'Mata Uang (Kurs)', key: 'currency', width: 40 },
    { header: 'Dividen atas Tahun', key: 'period', width: 28 },
    { header: 'Bentuk Investasi', key: 'form', width: 100 },
    { header: 'Kota/Kabupaten', key: 'city', width: 45 },
];
styleHeaderRow(ref);
const maxLen = Math.max(incomeLabels.length, currencyLabels.length, years.length, formLabels.length, cityLabels.length);
for (let i = 0; i < maxLen; i++) {
    ref.addRow({
        income: incomeLabels[i] || null,
        currency: currencyLabels[i] || null,
        period: years[i] || null,
        form: formLabels[i] || null,
        city: cityLabels[i] || null,
    });
}
// Named ranges for the dropdowns (absolute references to each column's populated cells).
wb.definedNames.add("Referensi!$A$2:$A$" + (incomeLabels.length + 1), 'ListJenis');
wb.definedNames.add("Referensi!$B$2:$B$" + (currencyLabels.length + 1), 'ListKurs');
wb.definedNames.add("Referensi!$C$2:$C$" + (years.length + 1), 'ListTahun');
wb.definedNames.add("Referensi!$D$2:$D$" + (formLabels.length + 1), 'ListBentuk');
wb.definedNames.add("Referensi!$E$2:$E$" + (cityLabels.length + 1), 'ListKota');

// --- Sheet: Info Umum (one-per-report fields: Kota/Kabupaten is required for Simpan) ----------
const info = wb.addWorksheet('Info Umum', { properties: { tabColor: { argb: 'FF1B3A6B' } } });
info.columns = [{ width: 28 }, { width: 50 }];
info.addRow(['Field', 'Nilai (isi di kolom ini)']);
styleHeaderRow(info);
info.addRow(['Kota/Kabupaten *', 'KOTA SURABAYA']);
info.getCell('A3').note = 'WAJIB. Kota/Kabupaten tempat laporan dibuat - tombol "Simpan" di Coretax tetap non-aktif kalau ini kosong.';
info.getCell('B3').dataValidation = {
    type: 'list', allowBlank: false, formulae: ['ListKota'], showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Kota tidak valid', error: 'Pilih Kota/Kabupaten dari daftar (lihat sheet Referensi).'
};
info.getCell('B3').font = { bold: true };
info.addRow([]);
info.addRow(['Catatan:', 'Nilai di atas berlaku untuk SATU laporan (bukan per-baris). Baris dividen & investasi diisi di sheet masing-masing.']);

// --- Sheet: Dividen --------------------------------------------------------------------------
const div = wb.addWorksheet('Dividen', { properties: { tabColor: { argb: 'FFF9A825' } } });
div.columns = [
    { header: 'Pelaporan Ke-\n(1/2/3)', key: 'pelaporan', width: 14 },
    { header: 'Dividen atas Tahun', key: 'tahun', width: 24 },
    { header: 'Jenis Penghasilan', key: 'jenis', width: 40 },
    { header: 'Pemberi Penghasilan', key: 'pemberi', width: 30 },
    { header: 'Tanggal Diterima\n(YYYY-MM-DD)', key: 'tanggal', width: 18 },
    { header: 'Kurs Dividen Dibagikan', key: 'kursBagi', width: 22 },
    { header: 'Nominal Dividen Dibagikan', key: 'nomBagi', width: 24 },
    { header: 'Kurs Dividen Diinvestasikan', key: 'kursInv', width: 24 },
    { header: 'Nominal Dividen Diinvestasikan', key: 'nomInv', width: 26 },
    { header: 'Laba Setelah Pajak (Kurs)\n[LN saja]', key: 'kursLaba', width: 22 },
    { header: 'Laba Setelah Pajak (Nominal)\n[LN saja]', key: 'nomLaba', width: 24 },
    { header: 'Proporsi Kepemilikan Saham (%)\n[LN saja]', key: 'proporsi', width: 26 },
];
styleHeaderRow(div);
// Example row (row 2) to show the expected shape.
div.addRow({ pelaporan: 2, tahun: 'Januari - Desember 2024', jenis: '1. Dividen Domestik', pemberi: 'PT Contoh Sejahtera Abadi', tanggal: '2024-12-23', kursBagi: 'Rupiah Indonesia', nomBagi: 100000000, kursInv: 'Rupiah Indonesia', nomInv: 100000000 });
div.getRow(2).font = { italic: true, color: { argb: 'FF888888' } };
div.getCell('A2').note = 'Baris contoh - boleh dihapus.';
// Validations across the data range (rows 2..DATA_ROWS+1).
addNumberValidation(div, 'A', 2, DATA_ROWS + 1, 1, 3, 'whole');        // Pelaporan Ke- : 1-3
addListValidation(div, 'B', 'ListTahun', 2, DATA_ROWS + 1);
addListValidation(div, 'C', 'ListJenis', 2, DATA_ROWS + 1);
addListValidation(div, 'F', 'ListKurs', 2, DATA_ROWS + 1);
addListValidation(div, 'H', 'ListKurs', 2, DATA_ROWS + 1);
addListValidation(div, 'J', 'ListKurs', 2, DATA_ROWS + 1);
addNumberValidation(div, 'G', 2, DATA_ROWS + 1, 1, null, 'decimal');   // Nominal Dividen Dibagikan
addNumberValidation(div, 'I', 2, DATA_ROWS + 1, 1, null, 'decimal');   // Nominal Dividen Diinvestasikan
addNumberValidation(div, 'K', 2, DATA_ROWS + 1, 1, null, 'decimal');   // Laba Setelah Pajak (Nominal) [LN]
addNumberValidation(div, 'L', 2, DATA_ROWS + 1, 0, 100, 'decimal');    // Proporsi Kepemilikan Saham (%) 0-100
div.views = [{ state: 'frozen', ySplit: 1 }];

// --- Sheet: Investasi ------------------------------------------------------------------------
const inv = wb.addWorksheet('Investasi', { properties: { tabColor: { argb: 'FFF9A825' } } });
inv.columns = [
    { header: 'Pelaporan Ke-\n(1/2/3)', key: 'pelaporan', width: 14 },
    { header: 'Dividen atas Tahun', key: 'tahun', width: 24 },
    { header: 'Tanggal Investasi\n(YYYY-MM-DD)', key: 'tanggal', width: 18 },
    { header: 'Bentuk Investasi', key: 'bentuk', width: 100 },
    { header: 'Kurs Nilai Investasi', key: 'kurs', width: 22 },
    { header: 'Nominal Nilai Investasi', key: 'nominal', width: 24 },
];
styleHeaderRow(inv);
inv.addRow({ pelaporan: 2, tahun: 'Januari - Desember 2024', tanggal: '2024-12-31', bentuk: 'bentuk investasi lainnya yang sah sesuai dengan peraturan perundang-undangan - tabungan', kurs: 'Rupiah Indonesia', nominal: 100000000 });
inv.getRow(2).font = { italic: true, color: { argb: 'FF888888' } };
inv.getCell('A2').note = 'Baris contoh - boleh dihapus.';
addNumberValidation(inv, 'A', 2, DATA_ROWS + 1, 1, 3, 'whole');        // Pelaporan Ke- : 1-3
addListValidation(inv, 'B', 'ListTahun', 2, DATA_ROWS + 1);
addListValidation(inv, 'D', 'ListBentuk', 2, DATA_ROWS + 1);
addListValidation(inv, 'E', 'ListKurs', 2, DATA_ROWS + 1);
addNumberValidation(inv, 'F', 2, DATA_ROWS + 1, 1, null, 'decimal');   // Nominal Nilai Investasi
inv.views = [{ state: 'frozen', ySplit: 1 }];

// --- save ------------------------------------------------------------------------------------
const outPath = path.join(__dirname, 'Template Impor Dividen - Coretax Agent.xlsx');
wb.xlsx.writeFile(outPath).then(() => {
    console.log('Template written:', outPath);
    console.log('Income types:', incomeLabels.length, '| Currencies:', currencyLabels.length, '| Investment forms:', formLabels.length, '| Year options:', years.length);
});
