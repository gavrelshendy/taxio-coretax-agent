// Draft BPA1 Desember (lib/a1-desember.js): roster dari L-IA, hitungan = kertas kerja klien (satu pegawai; angka asli, identitas fiktif),
// isian ikut saat rekap ditimpa, dan XML impor BPA1 sesuai skema A1Bulk template DJP.
const assert = require('assert'), fs = require('fs'), path = require('path'), ExcelJS = require('exceljs');
const { AnnualWorkbook, sumAmounts } = require('../lib/a1-workbook');
const desember = require('../lib/a1-desember');
module.exports = async function () {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'a1-desember-'));
    const tku = '0123456789012000000001';
    const headers = ['No.', 'NIK/NPWP', 'Nama', 'Nomor Bukti Potong', 'Tanggal Bukti Pemotongan', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'Tarif Pajak (%)', 'Pajak Penghasilan (Rp)', 'Fasilitas Perpajakan', 'ID Tempat Kegiatan Usaha'];
    const L = (rs) => [{ label: 'L-IA', tables: [{ title: 'Tabel', headers, rows: rs, moneyCols: [6, 8], totals: { 6: sumAmounts(rs.map((r) => r[6])), 8: sumAmounts(rs.map((r) => r[8])) }, sourceTotals: [], records: true }], fields: [], otherText: '' }];
    // PEGAWAI SATU: Apr-Nov, PPh TER 834.539 seluruhnya; BUDI keluar Juni (tidak ikut Desember); CICI ber-DTP.
    const satu = [[4, '7.700.312', '115.505'], [5, '7.843.189', '117.648'], [6, '7.861.542', '117.923'], [7, '7.985.272', '119.779'], [8, '8.066.789', '121.002'], [9, '8.168.020', '122.520'], [10, '8.010.784', '120.162'], [11, '2.273.131', '0']];
    const book = new AnnualWorkbook(2025), normal = { RecordId: 'n', ReturnSheetModel: 'Normal' };
    for (let m = 1; m <= 12; m++) {
        const masa = String(m).padStart(2, '0') + '25', rows = [];
        const x = satu.find((r) => r[0] === m);
        if (x) rows.push(['1', '3401010101900001', 'PEGAWAI SATU', 'BP-' + m, '28-' + m + '-2025', '21-100-01', x[1], '1,5', x[2], 'Tanpa Fasilitas', tku]);
        if (m <= 6) rows.push(['2', '1111111111110001', 'BUDI', 'BPB-' + m, '28-' + m + '-2025', '21-100-01', '5.000.000', '0', '0', 'Tanpa Fasilitas', tku]);
        // BPMP bruto 0 / PPh 0 sesudah BUDI keluar: tidak memperpanjang masa kerjanya (tetap "BPMP terakhir Juni").
        if (m === 7) rows.push(['2', '1111111111110001', 'BUDI', 'BPB-7', '28-7-2025', '21-100-01', '0', '0', '0', 'Tanpa Fasilitas', tku]);
        if (m <= 11) rows.push(['3', '2222222222220001', 'CICI', 'BPC-' + m, '28-' + m + '-2025', '21-100-01', '4.000.000', '0', '0', 'PPh Ditanggung Pemerintah (DTP)', tku]);
        if (m <= 11) { book.register(masa, [normal]); book.record(masa, normal, L(rows), true); } else book.register(masa, []);
    }
    const saved = await book.save(dir, 'CONTOH JAYA, PT', 'CTH');
    let wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(saved.file);
    assert.deepEqual(wb.worksheets.map((s) => s.name).slice(0, 4), ['Ringkasan', 'NIK', 'Pembetulan', 'Draft SPT Desember']);
    let d = desember.readDraft(wb);
    assert.deepEqual(d.rows.map((o) => o.NIK), ['2222222222220001', '3401010101900001'], 'pegawai di masa terakhir (November), urut nama; BUDI yang keluar Juni tidak ikut');
    // BUDI: BPMP berhenti Juni tanpa BPA1 -> dicatat di Ringkasan baris 7 (setiap pegawai tetap harus dibuatkan BPA1).
    assert.deepEqual(saved.noA1, [{ nik: '1111111111110001', name: 'BUDI', last: 'Juni' }]);
    assert.match(wb.getWorksheet('Ringkasan').getCell('A7').value, /^Belum dibuatkan BPA1 \(1 pegawai.*BUDI \(1111111111110001, BPMP terakhir Juni\)/);
    assert.equal(wb.getWorksheet('Ringkasan').getCell('A8').value, 'Masa', 'tabel Ringkasan tetap di baris 8');
    const iz = d.rows.find((o) => o.NIK === '3401010101900001'), ci = d.rows.find((o) => o.NIK === '2222222222220001');
    assert.equal(iz['Masa Awal'], 4); assert.equal(iz['Masa Akhir'], 12); assert.equal(iz['ID TKU Pemotong'], tku); assert.equal(ci.Fasilitas, 'DTP'); assert.equal(iz.Fasilitas, 'N/A');
    assert.equal(iz['PPh Jan-Nov (L-IA)'], 834539); assert.equal(iz['Bruto Jan-Nov (L-IA)'], 57909039);
    const ws = wb.getWorksheet('Draft SPT Desember'), col = (h) => desember.COLS.findIndex((c) => c[0] === h) + 1;
    assert.match(ws.getCell(iz._row, col('PPh Jan-Nov (L-IA)')).value.formula, /^SUMIFS\('L-IA'!\$J\$8:\$J\$\d+,'L-IA'!\$M\$8:\$M\$\d+,A\d+&"\*",'L-IA'!\$A\$8:\$A\$\d+,"<>Desember"\)$/);
    assert.equal(ws.getCell(iz._row, col('Biaya Jabatan')).value.formula, 'MIN(5%*U' + iz._row + ',500000*J' + iz._row + ')');
    assert.equal(wb.worksheets.reduce((a, s) => a + Object.keys(s._merges || {}).length, 0), 0);
    // Dikunci tanpa kata sandi (filter tetap jalan); hanya sel hijau terbuka; 25 baris cadangan untuk pegawai baru.
    for (const s of wb.worksheets) { assert(s.sheetProtection && s.sheetProtection.sheet, s.name + ' terkunci'); assert.equal(s.sheetProtection.autoFilter, true, s.name + ': filter boleh (autoFilter="0" di XML)'); assert(!s.sheetProtection.hashValue && !s.sheetProtection.password, s.name + ': tanpa kata sandi'); }
    assert.equal(ws.getCell(iz._row, col('Gaji')).protection.locked, false); assert.equal(ws.getCell(iz._row, col('Status PTKP')).protection.locked, false);
    assert.notEqual((ws.getCell(iz._row, col('PPh 21 Setahun')).protection || {}).locked, false); assert.notEqual((ws.getCell(iz._row, col('NIK')).protection || {}).locked, false);
    const spareRow = iz._row + 1; assert.equal(ws.getCell(spareRow, col('NIK')).value, null); assert.equal(ws.getCell(spareRow, col('NIK')).protection.locked, false);
    // Baris cadangan benar-benar kosong (tanpa Staff / 21-100-01 / N/A / ID TKU / Masa 12 bawaan) sampai NIK diisi.
    for (const h of ['Posisi', 'Kode Objek Pajak', 'Fasilitas', 'ID TKU Pemotong', 'Masa Awal', 'Masa Akhir']) assert.equal(ws.getCell(spareRow + 24, col(h)).value, null, 'cadangan ' + h + ' kosong');
    assert.match(ws.getCell(spareRow, col('Jumlah Bulan')).value.formula, /^IF\(A\d+="",""/); assert.equal(ws.getCell(spareRow, col('Jumlah Bulan')).value.result ?? '', '');
    assert.equal(ws.getCell(spareRow + 25, col('NIK')).value, null);
    // Warna: isian pegawai yang ada hijau muda; baris cadangan tanpa warna tetapi tetap bisa diisi.
    const argb = (c) => (c.fill && c.fill.fgColor && c.fill.fgColor.argb) || null;
    assert.equal(argb(ws.getCell(iz._row, col('Gaji'))), 'FFE2EFDA');
    for (const h of ['NIK', 'Status PTKP', 'Gaji', 'Masa Awal']) { assert.equal(argb(ws.getCell(spareRow + 3, col(h))), null, 'cadangan ' + h + ' tanpa warna'); assert.equal(ws.getCell(spareRow + 3, col(h)).protection.locked, false); }
    assert(ws.getCell(spareRow, col('Biaya Jabatan')).value.formula); assert.equal(ws.getCell(iz._row, col('Status PTKP')).dataValidation.type, 'list');
    { const nk = wb.getWorksheet('NIK'); let unlocked = 0; nk.eachRow((r) => { if (r.getCell(4).protection && r.getCell(4).protection.locked === false) unlocked++; }); assert(unlocked >= 3, 'NIK Baru terbuka'); }

    // Isian dari KK (blok 1721-A1 Data 1721 + PPh setahun / Desember KK).
    const fill = (o, v) => { for (const [k, val] of Object.entries(v)) ws.getCell(o._row, col(k)).value = val; };
    fill(iz, { 'Status PTKP': 'TK/0', Gaji: 49741935, 'Tunjangan Lainnya / Lembur': 13553168, Asuransi: 2491200, 'Iuran Pensiun / JHT': 1440000, 'Bruto KK': 65786303, 'PPh Setahun KK': 352800, 'PPh Desember KK': -481739 });
    fill(ci, { 'Status PTKP': 'K/1', Gaji: 48000000, 'PPh Setahun KK': 1 });
    // Pegawai baru Desember di baris cadangan + konsep SPT (bruto dan PPh).
    fill({ _row: iz._row + 1 }, { NIK: '3333333333330001', Nama: 'DONI BARU', 'Status PTKP': 'TK/0', Gaji: 5000000 });
    fill(iz, { 'Bruto Desember Konsep SPT': 7877264, 'PPh Desember Konsep SPT': -481739 });
    desember.refreshTotals(ws); await wb.xlsx.writeFile(saved.file);
    wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(saved.file); d = desember.readDraft(wb);
    const z = d.rows.find((o) => o.NIK === '3401010101900001');
    assert.deepEqual([z['Bruto Setahun'], z['Biaya Jabatan'], z['PKP'], z['PPh 21 Setahun'], z['PPh Desember (L-IB)'], z['Bruto Desember (L-IB)'], z['Cek KK']], [65786303, 3289315.1500000004, 7056000, 352800, -481739, 7877264, 'OK']);
    assert.equal(d.rows.find((o) => o.NIK === '2222222222220001')['Cek KK'], 'Selisih');
    assert.equal(z['Cek Konsep SPT'], 'OK'); assert.equal(z['Selisih Bruto Konsep SPT'] || 0, 0, 'hasil rumus 0 tidak disimpan ExcelJS - Excel menghitung ulang saat dibuka');
    const doni = d.rows.find((o) => o.NIK === '3333333333330001'); assert.deepEqual([doni['Masa Awal'], doni['Bruto Setahun'], doni['Biaya Jabatan']], [12, 5000000, 250000]);

    // XML impor BPA1: urutan elemen skema A1Bulk, PPh dipotong = 0 (petunjuk template), PartialYear untuk masa 4-12.
    const out = desember.buildXml(wb, { year: '2025' });
    assert.equal(out.count, 3); assert.equal(out.totalTax, 352800 + 0);
    const order = ['WorkForSecondEmployer', 'TaxPeriodMonthStart', 'TaxPeriodMonthEnd', 'TaxPeriodYear', 'CounterpartOpt', 'CounterpartPassport', 'CounterpartTin', 'TaxExemptOpt', 'StatusOfWithholding', 'CounterpartPosition', 'TaxObjectCode', 'NumberOfMonths', 'SalaryPensionJhtTht', 'GrossUpOpt', 'IncomeTaxBenefit', 'OtherBenefit', 'Honorarium', 'InsurancePaidByEmployer', 'Natura', 'TantiemBonusThr', 'PensionContributionJhtThtFee', 'Zakat', 'PrevWhTaxSlip', 'TaxCertificate', 'Article21IncomeTax', 'IDPlaceOfBusinessActivity', 'WithholdingDate'];
    const first = out.xml.split('<A1>')[1].split('</A1>')[0], names = [...first.matchAll(/<(\w+)\s*\/?>/g)].map((m) => m[1]);
    assert.deepEqual(names, order);
    assert.match(out.xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<A1Bulk[^>]*>\n\t<TIN>0123456789012000<\/TIN>\n\t<ListOfA1>/);
    const izXml = out.xml.split('<A1>').find((s) => s.includes('3401010101900001'));
    for (const [k, v] of [['TaxPeriodMonthStart', '4'], ['StatusOfWithholding', 'PartialYear'], ['TaxExemptOpt', 'TK/0'], ['SalaryPensionJhtTht', '49741935'], ['OtherBenefit', '13553168'], ['InsurancePaidByEmployer', '2491200'], ['PensionContributionJhtThtFee', '1440000'], ['Article21IncomeTax', '0'], ['TaxCertificate', 'N/A'], ['WithholdingDate', '2025-12-31']]) assert.match(izXml, new RegExp('<' + k + '>' + v.replace('/', '\\/') + '</' + k + '>'));
    assert.match(out.xml.split('<A1>').find((s) => s.includes('2222222222220001')), /<TaxCertificate>DTP<\/TaxCertificate>/);
    // Status PTKP kosong -> tidak dibuat, dengan pesan per baris.
    wb.getWorksheet('Draft SPT Desember').getCell(iz._row, col('Status PTKP')).value = null;
    assert.throws(() => desember.buildXml(wb, { year: '2025' }), /3401010101900001 PEGAWAI SATU\): Status PTKP kosong/);

    // Unduh setahun lagi (file sama ditimpa; berkas di disk masih berisi Status PTKP TK/0): isian draft tetap ada.
    await book.save(dir, 'CONTOH JAYA, PT', 'CTH');
    wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(saved.file); d = desember.readDraft(wb);
    const again = d.rows.find((o) => o.NIK === '3401010101900001');
    assert.deepEqual([again['Status PTKP'], again.Gaji, again['PPh Desember (L-IB)'], again['Cek KK'], again['Cek Konsep SPT']], ['TK/0', 49741935, -481739, 'OK', 'OK']);
    assert.equal(d.rows.find((o) => o.NIK === '3333333333330001').Gaji, 5000000, 'pegawai baru di baris cadangan ikut');
    assert(wb.getWorksheet('Draft SPT Desember').sheetProtection.sheet, 'tetap terkunci setelah ditimpa');
    // Pegawai masuk lagi (NIK sama, BPA1 April di L-IB) + pegawai baru dengan BPA1 Desember di L-IB + SPT Desember sudah ada.
    const hi = '3401010202900002', ib = ['No.', 'NIK/NPWP', 'Nama', 'Nomor Bukti Potong', 'Tanggal Bukti Pemotongan', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'Pajak Penghasilan (Rp)', 'ID Tempat Kegiatan Usaha'];
    const LB = (rs) => ({ label: 'L-IB', tables: [{ title: 'BPA1', headers: ib, rows: rs, moneyCols: [6, 7], totals: { 6: sumAmounts(rs.map((r) => r[6])), 7: sumAmounts(rs.map((r) => r[7])) }, sourceTotals: [], records: true }], fields: [], otherText: '' });
    const b2 = new AnnualWorkbook(2025);
    for (let m = 1; m <= 12; m++) {
        const masa = String(m).padStart(2, '0') + '25', lia = [], lib = [];
        if (m <= 11 && m !== 4) lia.push(['1', hi, 'PEGAWAI DUA', 'H-' + m, '', '21-100-01', '3.000.000', '0', '10.000', 'Tanpa Fasilitas', tku]);
        if (m === 4) lib.push(['1', hi, 'PEGAWAI DUA (EJAAN LAMA)', 'BPA1-APR', '', '21-100-01', '3.000.000', '5.000', tku]);
        if (m === 12) lib.push(['1', hi, 'PEGAWAI DUA', 'BPA1-DES-H', '', '21-100-01', '4.000.000', '-20.000', tku], ['2', '4444444444440001', 'EKA BARU', 'BPA1-DES-E', '', '21-100-01', '2.500.000', '0', tku]);
        b2.register(masa, [normal]); b2.record(masa, normal, [L(lia)[0], LB(lib)], true);
    }
    const s2 = await b2.save(path.join(dir, 'dua'), 'CONTOH JAYA, PT', 'CTH');
    const w2 = new ExcelJS.Workbook(); await w2.xlsx.readFile(s2.file); const d2 = desember.readDraft(w2);
    assert.deepEqual(d2.rows.map((o) => o.NIK).sort(), [hi, '4444444444440001'].sort(), 'masuk lagi + pegawai baru Desember (dari L-IB)');
    const h2 = d2.rows.find((o) => o.NIK === hi);
    assert.deepEqual([h2['Masa Awal'], h2['Nomor Bukti Potong Sebelumnya'], h2['Bruto Jan-Nov (L-IA)'], h2['PPh Jan-Nov (L-IA)']], [5, 'BPA1-APR', 21000000, 70000], 'hanya Mei-November sesudah BPA1 April');
    assert(String(h2.Catatan).includes('BPA1 April (BPA1-APR)'));
    assert.equal(h2['Bruto Desember Konsep SPT'], 4000000); assert.equal(h2['PPh Desember Konsep SPT'], -20000);
    const w2s = w2.getWorksheet('Draft SPT Desember'); assert(String(w2s.getCell(h2._row, col('PPh Jan-Nov (L-IA)')).value.formula).startsWith('SUM(SUMIFS('));
    assert(String(w2s.getCell(h2._row, col('PPh Jan-Nov (L-IA)')).value.formula).includes('{"Mei","Juni","Juli","Agustus","September","Oktober","November"}'));
    assert(String(w2s.getCell(h2._row, col('PPh Desember Konsep SPT')).value.formula).includes("'L-IB'!"));
    w2s.getCell(h2._row, col('Status PTKP')).value = 'K/2'; w2s.getCell(h2._row, col('Gaji')).value = 25000000;
    assert(desember.buildXml(w2, { year: '2025' }).xml.includes('<PrevWhTaxSlip>BPA1-APR</PrevWhTaxSlip>'));
    console.log('PASS: Draft Desember - roster masa terakhir, hitungan = KK (biaya jabatan 500rb x bulan, Pasal 17), Cek KK, XML impor BPA1 (urutan skema, PPh dipotong 0), isian ikut saat rekap ditimpa; masuk lagi (BPA1 sebelumnya), pegawai baru dari L-IB Desember, konsep SPT dari L-IB.');
};
if (require.main === module) module.exports().catch((e) => { console.error(e); process.exitCode = 1; });
