// e-Bupot (Telah Terbit) vs SPT (lampiran rekap) - lib/ebupot-vs-spt.js: BP21 dibetulkan (bruto + kode objek pajak),
// bukti potong dihapus, bukti potong baru, BPMP NIK dibetulkan; hasil di sheet Pembetulan + catatan lampiran + Ringkasan;
// setelah SPT dibetulkan -> "Sudah sama". Field yang belum dikenali tidak menghasilkan selisih palsu.
const assert = require('assert'), fs = require('fs'), path = require('path'), ExcelJS = require('exceljs');
const { AnnualWorkbook, sumAmounts } = require('../lib/a1-workbook');
const cmp = require('../lib/ebupot-vs-spt'), report = require('../lib/bpmp-report');
module.exports = async function () {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ebupot-vs-spt-'));
    const table = (label, headers, rows, money) => ({ label, tables: [{ title: label, headers, rows, moneyCols: money, totals: Object.fromEntries(money.map((c) => [c, sumAmounts(rows.map((r) => r[c]))])), sourceTotals: [], records: true }], fields: [], otherText: '' });
    const H1 = ['No.', 'NIK/NPWP', 'Nama', 'Nomor Bukti Potong', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'Pajak Penghasilan (Rp)'];
    const H3 = ['No.', 'NIK/NPWP', 'Nama', 'Jenis Pajak', 'Nomor Bukti Potong', 'Kode Objek Pajak', 'Penghasilan Bruto (Rp)', 'Pajak Penghasilan (Rp)'];
    const sheets = [
        table('L-IA', H1, [['1', '1111111111110001', 'ANI', 'MP-1', '21-100-01', '5.000.000', '50.000'], ['2', '9990000000999000', 'PENERIMA PENGHASILAN#2222222222220001', 'MP-2', '21-100-01', '4.000.000', '0']], [5, 6]),
        table('L-II', H1, [['1', '3333333333330001', 'BUDI', 'A1-1', '21-100-01', '30.000.000', '300.000']], [5, 6]),
        table('L-III', H3, [['1', '4444444444440001', 'CICI', 'Pasal 21', '21-1', '21-100-20', '2.000.000', '50.000'], ['2', '5555555555550001', 'DEDI', 'Pasal 21', '21-2', '21-100-35', '1.000.000', '0']], [6, 7])
    ];
    const book = new AnnualWorkbook(2026), normal = { RecordId: 'n', ReturnSheetModel: 'Normal' };
    for (let m = 1; m <= 12; m++) { const masa = String(m).padStart(2, '0') + '26'; if (m === 3) { book.register(masa, [normal]); book.record(masa, normal, sheets, true); } else book.register(masa, []); }
    const file = (await book.save(dir, 'ENTITAS UJI', 'UJI')).file;
    // Coretax sekarang: MP-2 NIK dibetulkan; BPA1 sama; BP21 21-1 bruto + KOP berubah, 21-2 dihapus, 21-3 baru.
    const issued = {
        getebupotmpissued: [{ WithholdingSlipsNumber: 'MP-1', TaxIdentificationNumber: '1111111111110001', Name: 'ANI', TaxObjectCode: '21-100-01', GrossIncome: 5000000, IncomeTaxWithheld: 50000 },
            { WithholdingSlipsNumber: 'MP-2', TaxIdentificationNumber: '2222222222220001', Name: 'EKO', TaxObjectCode: '21-100-01', GrossIncome: 4000000, IncomeTaxWithheld: 0, IsReportedToTaxReturn: false }],
        getebupotbpa1issued: [{ WithholdingSlipsNumber: 'A1-1', TaxIdentificationNumber: '3333333333330001', Name: 'BUDI', TaxObjectCode: '21-100-01', GrossIncome: 30000000, IncomeTax: 300000 }],
        getebupotbp21issued: [{ WithholdingSlipsNumber: '21-1', TaxIdentificationNumber: '4444444444440001', Name: 'CICI', TaxObjectCode: '21-100-21', TaxBase: 2500000, IncomeTax: 62500 },
            { WithholdingSlipsNumber: '21-3', TaxIdentificationNumber: '6666666666660001', Name: 'FAJAR', TaxObjectCode: '21-100-35', TaxBase: 700000, IncomeTax: 0, IsReportedToTaxReturn: false }]
    };
    const calls = [];
    const list = async (endpoint, code, property) => { calls.push([endpoint, code, property]); return code === '03032026' ? issued[endpoint] : []; };
    let wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const spt = cmp.readSpt(wb);
    assert.deepEqual([spt.bpmp.size, spt.bpa1.size, spt.bp21.size], [2, 1, 2]);
    const result = cmp.compare(spt, await cmp.fetchIssued(list, '2026', spt, [3]));
    assert.deepEqual(calls.map((c) => c[2]), ['TaxPeriodCode', 'IncomePeriodCodeEnd', 'TaxPeriodCode'], 'BPA1 difilter IncomePeriodCodeEnd');
    const by = (no) => result.diffs.find((d) => d.number === no);
    assert.equal(by('MP-2').kind, 'Berubah'); assert.match(by('MP-2').detail, /NIK 9990000000999000 → 2222222222220001/);
    assert.equal(by('21-1').kind, 'Berubah'); assert.match(by('21-1').detail, /kode objek pajak 21-100-20 → 21-100-21, bruto 2.000.000 → 2.500.000, PPh 50.000 → 62.500/);
    assert.equal(by('21-2').kind, 'Dihapus'); assert.equal(by('21-3').kind, 'Baru'); assert.equal(by('21-3').gross, 700000);
    assert(!by('MP-1') && !by('A1-1')); assert(result.same.has('MP-1') && result.same.has('A1-1'));
    assert.deepEqual(result.counts.BP21, { compared: 1, changed: 1, removed: 1, added: 1, replaced: 0, cancel: 0, cancelled: 0 });

    // Diterbitkan ulang (bukti lama dibatalkan, nomor baru untuk NIK & masa yang sama): bukan "dihapus" + "baru".
    // Nilai sama = cocok; nilai beda = satu baris di nomor baru. Bruto & PPh 0: masih terbit = Batalkan, sudah hilang = beres.
    const sp = (number, nik, gross, tax) => [number, { masa: 9, number, nik, name: 'P' + nik.slice(-1), kop: '21-100-01', gross, tax }];
    const eb = (no, nik, gross, tax) => ({ WithholdingSlipsNumber: no, TaxIdentificationNumber: nik, TaxObjectCode: '21-100-01', GrossIncome: gross, IncomeTaxWithheld: tax, _masa: 9 });
    const re = cmp.compare({ bpmp: new Map([sp('OLD-1', '1111111111110001', 6834300, 85429), sp('OLD-2', '1111111111110002', 0, 0), sp('OLD-3', '1111111111110003', 13040500, 521620), sp('OLD-4', '1111111111110004', 0, 0), sp('KEEP-5', '1111111111110005', 0, 0)]), bpa1: new Map(), bp21: new Map() },
        { bpmp: new Map([['NEW-1', eb('NEW-1', '1111111111110001', 6834300, 85429)], ['NEW-2', eb('NEW-2', '1111111111110002', 6360138, 63601)], ['NEW-3', eb('NEW-3', '1111111111110003', 4033373, 0)], ['KEEP-5', eb('KEEP-5', '1111111111110005', 0, 0)], ['NEW-6', eb('NEW-6', '1111111111110006', 0, 0)]]), bpa1: new Map(), bp21: new Map() });
    const rb = (no) => re.diffs.find((d) => d.number === no);
    assert(re.same.has('OLD-1') && re.same.has('NEW-1') && !rb('NEW-1') && !rb('OLD-1'), 'nomor baru, nilai sama = cocok');
    assert.equal(rb('NEW-2').kind, 'Diganti'); assert.match(rb('NEW-2').detail, /OLD-2 → NEW-2\): bruto 0 → 6.360.138, PPh 0 → 63.601/);
    assert.equal(rb('NEW-3').kind, 'Diganti'); assert(!rb('OLD-2') && !rb('OLD-3'), 'nomor lama tidak jadi "dihapus"');
    assert(!rb('OLD-4'), 'bernilai 0 dan sudah tidak terbit = sudah dibatalkan');
    assert.equal(rb('KEEP-5').kind, 'Batalkan'); assert.equal(rb('NEW-6').kind, 'Batalkan');
    assert.deepEqual(re.counts.BPMP, { compared: 1, changed: 2, removed: 0, added: 0, replaced: 3, cancel: 2, cancelled: 1 });
    assert.equal(re.replaced.get('OLD-2'), 'NEW-2');

    // Ke rekap: sheet Pembetulan (Jenis, Selisih, Dilaporkan = Belum), catatan di L-III, Ringkasan.
    await report.writeReport({ file, year: '2026', results: [], compare: result });
    wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const pb = wb.getWorksheet('Pembetulan'), h = report.headerMap(pb), row = (no) => { let f = null; pb.eachRow((r, n) => { if (n > 1 && r.getCell(h.get('Nomor Bukti Potong')).value === no) f = r; }); return f; };
    const v = (no, k) => { const c = row(no).getCell(h.get(k)).value; return c && typeof c === 'object' && 'result' in c ? c.result : c; };
    assert.equal(v('21-1', 'Jenis'), 'e-Bupot ≠ SPT'); assert.equal(v('21-1', 'Dilaporkan di SPT'), 'Belum'); assert.match(v('21-1', 'Selisih e-Bupot vs SPT'), /^Berubah sesudah SPT dilaporkan: kode objek pajak/);
    // Penghasilan Bruto / PPh = nilai di SPT; Bruto / PPh e-Bupot = nilai e-Bupot sekarang (21-3 belum ada di SPT).
    assert.equal(v('21-3', 'Penghasilan Bruto (Rp)') ?? '', ''); assert.equal(v('21-3', 'Bruto e-Bupot (Rp)'), 700000); assert.equal(v('21-3', 'PPh e-Bupot (Rp)'), 0); assert.equal(v('21-3', 'Masa'), 'Maret');
    assert.deepEqual(['Penghasilan Bruto (Rp)', 'PPh (Rp)', 'Bruto e-Bupot (Rp)', 'PPh e-Bupot (Rp)'].map((k) => v('21-1', k)), [2000000, 50000, 2500000, 62500]);
    assert.equal(row('21-1').getCell(h.get('Bruto e-Bupot (Rp)')).numFmt, '#,##0');
    assert.equal(v('MP-2', 'Jenis'), 'NIK bermasalah', 'jenis asal (NIK sementara) tetap'); assert.match(v('MP-2', 'Selisih e-Bupot vs SPT'), /NIK 9990000000999000 → 2222222222220001/);
    const l3 = wb.getWorksheet('L-III'); let head = 0; l3.eachRow((r, n) => { if (!head && r.getCell(1).value === 'Masa') head = n; });
    const lh = report.headerMap(l3, head), note = (no) => { let x = null; l3.eachRow((r, n) => { if (n > head && r.getCell(lh.get('Nomor Bukti Potong')).value === no) x = r.getCell(lh.get('Catatan Pembetulan')).value; }); return x; };
    assert.match(note('21-1').result, /^Berubah sesudah SPT dilaporkan/); assert.match(note('21-2').result, /^Tidak ada lagi di e-Bupot BP21/);
    const rk = wb.getWorksheet('Ringkasan'); assert.equal(rk.getCell(11, 5).value.result, 4, 'Maret (baris 11, di bawah kop): MP-2, 21-1, 21-2, 21-3');

    // SPT Maret dibetulkan -> rekap baru sama dengan e-Bupot -> "Sudah sama", Dilaporkan = Ya, tetap tercatat.
    const fixed = cmp.compare({ bpmp: new Map([['MP-1', spt.bpmp.get('MP-1')], ['MP-2', { ...spt.bpmp.get('MP-2'), nik: '2222222222220001' }]]), bpa1: spt.bpa1,
        bp21: new Map([['21-1', { ...spt.bp21.get('21-1'), kop: '21-100-21', gross: 2500000, tax: 62500 }], ['21-3', { masa: 3, number: '21-3', nik: '6666666666660001', name: 'FAJAR', kop: '21-100-35', gross: 700000, tax: 0 }]]) },
        await cmp.fetchIssued(list, '2026', spt, [3]));
    assert.deepEqual(fixed.diffs, []);
    await report.writeReport({ file, year: '2026', results: [], compare: fixed });
    wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const pb2 = wb.getWorksheet('Pembetulan'), h2 = report.headerMap(pb2);
    let s211 = null; pb2.eachRow((r, n) => { if (n > 1 && r.getCell(h2.get('Nomor Bukti Potong')).value === '21-1') s211 = r; });
    assert.match(s211.getCell(h2.get('Selisih e-Bupot vs SPT')).value, /^Sudah sama dengan SPT/); assert.equal(s211.getCell(h2.get('Dilaporkan di SPT')).value, 'Ya');

    // Field bruto / PPh yang belum dikenali: tidak dibandingkan, dicatat - bukan selisih palsu.
    const odd = cmp.compare({ bpmp: new Map(), bpa1: new Map(), bp21: new Map([['21-1', spt.bp21.get('21-1')]]) },
        { bpmp: new Map(), bpa1: new Map(), bp21: new Map([['21-1', { WithholdingSlipsNumber: '21-1', TaxIdentificationNumber: '4444444444440001', TaxObjectCode: '21-100-20', Amount: 9 }]]) });
    assert.deepEqual(odd.diffs, []); assert.match(odd.notes.join(' '), /BP21: bruto tidak dibandingkan/);
    console.log('PASS: e-Bupot vs SPT - BP21 berubah (bruto, PPh, kode objek pajak), dihapus, baru; BPMP NIK; BPA1 filter IncomePeriodCodeEnd; sheet Pembetulan + catatan L-III + Ringkasan; sudah sama setelah SPT dibetulkan; field belum dikenal tidak memberi selisih palsu.');
};
if (require.main === module) module.exports().catch((e) => { console.error(e); process.exitCode = 1; });
