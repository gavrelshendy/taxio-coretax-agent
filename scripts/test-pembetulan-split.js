// Sheet Pembetulan hanya pembetulan identitas (NIK bermasalah / NIK salah) dan pembatalan; selisih e-Bupot vs SPT dan
// bukti potong yang dibetulkan di luar Pilot di sheet "e-Bupot vs SPT". Rekap lama dipindah otomatis. Data rekaan.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const ExcelJS = require('exceljs');
const report = require('../lib/bpmp-report');
const amend = require('../automation/bpmp-amend');

module.exports = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-split-')), file = path.join(dir, 'rekap.xlsx');
    // Rekap versi lama: 22 kolom, keterangan NIK bergeser ke kolom Bruto e-Bupot, selisih dan pembetulan luar Pilot di Pembetulan.
    const OLD = ['Masa', 'Nomor Bukti Potong', 'Tanggal Bukti Potong', 'Kode Objek Pajak', 'NIK di Bukti Potong', 'Nama di Bukti Potong', 'NIK Lama (dari #)', 'NIK Baru', 'Nama Baru', 'Penghasilan Bruto (Rp)', 'PPh (Rp)', 'Status',
        'Nama Resmi Coretax', 'Pemeriksaan Ulang', 'Waktu', 'Cek Coretax', 'Dilaporkan di SPT', 'Jenis', 'Selisih e-Bupot vs SPT', 'Bruto e-Bupot (Rp)', 'PPh e-Bupot (Rp)', 'Catatan'];
    const wb = new ExcelJS.Workbook(), pb = wb.addWorksheet('Pembetulan');
    pb.getCell('A1').value = 'Contoh, PT'; pb.getCell('A2').value = 'Pembetulan'; pb.getCell('A3').value = 'Tahun 2026';
    pb.getRow(4).values = OLD;
    const row = (o) => pb.addRow(OLD.map((k) => (k in o ? o[k] : null)));
    row({ Masa: 'Januari', 'Nomor Bukti Potong': 'N-1', 'NIK di Bukti Potong': '9990000000999000', 'Nama di Bukti Potong': 'ANI #1111111111110001', Status: 'Draft', Jenis: 'NIK bermasalah', 'Bruto e-Bupot (Rp)': 'NIK 1111111111110001 tidak terbaca sistem' });
    row({ Masa: 'Februari', 'Nomor Bukti Potong': 'D-1', 'NIK di Bukti Potong': '1111111111110002', 'Nama di Bukti Potong': 'BUDI', 'Penghasilan Bruto (Rp)': 1000, 'PPh (Rp)': 10, Status: 'e-Bupot ≠ SPT (BP21, L-III)', Jenis: 'e-Bupot ≠ SPT',
        'Selisih e-Bupot vs SPT': 'Berubah sesudah SPT dilaporkan: bruto 1.000 → 2.000', 'Bruto e-Bupot (Rp)': 2000, 'PPh e-Bupot (Rp)': 20, 'Dilaporkan di SPT': 'Belum' });
    row({ Masa: 'Maret', 'Nomor Bukti Potong': 'O-1', 'NIK di Bukti Potong': '1111111111110003', 'Nama di Bukti Potong': 'CICI', 'Penghasilan Bruto (Rp)': 500, 'PPh (Rp)': 5, Status: 'Pembetulan di Coretax (bukan lewat Pilot)', Jenis: 'Pembetulan di Coretax', 'Dilaporkan di SPT': 'Ya' });
    row({ Masa: 'April', 'Nomor Bukti Potong': 'O-2', 'NIK di Bukti Potong': '1111111111110006', 'Nama di Bukti Potong': 'FIFI', 'Penghasilan Bruto (Rp)': 700, 'PPh (Rp)': 7, Status: 'Pembetulan di Coretax (bukan lewat Pilot)', Jenis: 'Pembetulan di Coretax', 'Dilaporkan di SPT': 'Belum' });
    row({ Masa: 'Oktober', 'Nomor Bukti Potong': 'Z-1', 'NIK di Bukti Potong': '1111111111110004', 'Nama di Bukti Potong': 'DEDI', 'Penghasilan Bruto (Rp)': 0, 'PPh (Rp)': 0, Status: 'Dibatalkan otomatis (bruto & PPh 0)', Jenis: 'BPMP 0 dibatalkan', Waktu: '07/11/2026 10:00',
        'Selisih e-Bupot vs SPT': 'Dibatalkan otomatis oleh Pilot 07/11/2026 10:00 - BPMP bruto 0 / PPh 0', 'Dilaporkan di SPT': 'Belum' });
    await wb.xlsx.writeFile(file);

    // NIK salah: NIK valid 1111111111110005 diganti NIK orang lain lewat Pilot -> baris baru di Pembetulan, Jenis NIK salah.
    const results = [{ old: '1111111111110005', newNik: '2222222222220005', newName: 'EKA PUTRI', number: 'W-1', period: '05052026', coretaxName: 'EKA PUTRI', status: 'DIBETULKAN', kind: 'NIK salah', slipNik: '1111111111110005', slipName: 'EKO PUTRO', gross: 3000, tax: 30 }];
    await report.writeReport({ file, year: '2026', results });

    const out = new ExcelJS.Workbook(); await out.xlsx.readFile(file);
    const p = out.getWorksheet('Pembetulan'), s = out.getWorksheet(report.SL_NAME);
    assert(s, 'sheet e-Bupot vs SPT dibuat');
    assert.deepEqual(out.worksheets.map((w) => w.name), ['Pembetulan', report.SL_NAME]);
    const ph = report.headerMap(p, 4), sh = report.headerMap(s, 4);
    assert.deepEqual([...ph.keys()].sort(), report.PB_COLS.map((c) => c[0]).sort(), 'kolom selisih dihapus dari Pembetulan, Tindakan ditambahkan');
    const rows = (ws, h) => { const m = new Map(); ws.eachRow((r, n) => { if (n > 4) m.set(r.getCell(h.get('Nomor Bukti Potong')).value, (k) => r.getCell(h.get(k)).value); }); return m; };
    const P = rows(p, ph), S = rows(s, sh);
    assert.deepEqual([...P.keys()].sort(), ['N-1', 'W-1', 'Z-1'], 'Pembetulan: identitas + pembatalan saja');
    assert.deepEqual([...S.keys()].sort(), ['D-1', 'O-2'], 'dibetulkan di luar Pilot dan sudah dilaporkan (O-1) tidak dicatat');
    assert.equal(P.get('N-1')('Catatan'), 'NIK 1111111111110001 tidak terbaca sistem', 'keterangan yang bergeser kembali ke Catatan');
    assert.equal(P.get('W-1')('Jenis'), 'NIK salah'); assert.equal(P.get('W-1')('NIK di Bukti Potong'), '1111111111110005'); assert.equal(P.get('W-1')('Penghasilan Bruto (Rp)'), 3000);
    assert.equal(P.get('Z-1')('Jenis'), 'Pembatalan'); assert.equal(P.get('Z-1')('Status'), 'Dibatalkan oleh Pilot · 07/11/2026 10:00'); assert.match(P.get('Z-1')('Catatan'), /^Dibatalkan otomatis oleh Pilot/);
    assert.equal(S.get('D-1')('Jenis'), 'e-Bupot ≠ SPT'); assert.equal(S.get('D-1')('Lampiran'), 'BP21 L-III');
    assert.deepEqual(['Bruto SPT (Rp)', 'PPh SPT (Rp)', 'Bruto e-Bupot (Rp)', 'PPh e-Bupot (Rp)'].map((k) => S.get('D-1')(k)), [1000, 10, 2000, 20]);
    assert.equal(S.get('O-2')('Jenis'), 'Dibetulkan di luar Pilot'); assert.equal(S.get('O-2')('Bruto e-Bupot (Rp)'), 700); assert.equal(S.get('O-2')('Bruto SPT (Rp)') ?? '', ''); assert.equal(S.get('O-2')('Dilaporkan di SPT'), 'Belum');
    assert.equal(s.getCell('A1').value, 'Contoh, PT', 'kop entitas ikut');

    // Nama beda satu huruf (tanpa spasi / tanda baca) dikirim otomatis; dua huruf tetap perlu centang "nama mirip".
    assert.equal(amend.nameMatch('R. BAGAS PRIYANTO', 'R.BAGAS PRYANTO'), 'similar');
    assert.equal(amend.nameGap('R. BAGAS PRIYANTO', 'R.BAGAS PRYANTO'), 1);
    assert.equal(amend.nameGap('BUDI SANTOSO', 'BUDY SANTOSA'), 2);
    // Satu NIK dipakai dua orang: isian per bukti potong di Pembetulan (diketik, bukan rumus) -> target per nomor;
    // isian rumus dari sheet NIK tidak dobel; NIK yang diubah manual jadi "0" di sheet NIK -> peringatan.
    const tw = new ExcelJS.Workbook(), nk = tw.addWorksheet('NIK'), tp = tw.addWorksheet('Pembetulan'), tfile = path.join(dir, 'targets.xlsx');
    nk.getRow(6).values = ['NIK', 'Nama', 'NIK lama (dari #)', 'NIK Baru', 'Nama Baru'];
    nk.addRow(['1111111111110007', 'GITA', '', '2222222222220007', 'GITA S']);
    nk.addRow(['0', 'HANA', '', '2222222222220008', 'HANA']);
    tp.getCell('A3').value = 'Tahun 2026'; tp.getRow(4).values = report.PB_COLS.map((c) => c[0]);
    const pc = (k) => report.PB_COLS.findIndex((c) => c[0] === k) + 1, prow = (o) => { const r = tp.addRow([]); for (const [k, x] of Object.entries(o)) r.getCell(pc(k)).value = x; };
    prow({ Masa: 'April', 'Nomor Bukti Potong': 'S-1', 'NIK di Bukti Potong': '1111111111110009', 'NIK Baru': '2222222222220009', 'Nama Baru': 'IRA', Status: 'Draft' });
    prow({ Masa: 'Mei', 'Nomor Bukti Potong': 'S-2', 'NIK di Bukti Potong': '1111111111110009', 'NIK Baru': '2222222222220009', 'Nama Baru': 'IRA', Status: 'DIBETULKAN' });
    prow({ Masa: 'Mei', 'Nomor Bukti Potong': 'S-3', 'NIK di Bukti Potong': '1111111111110007', 'NIK Baru': { formula: 'NIK!$D$7', result: '2222222222220007' }, 'Nama Baru': 'GITA S', Status: 'Draft' });
    prow({ Masa: 'Juni', 'Nomor Bukti Potong': 'S-4', 'NIK di Bukti Potong': '1111111111110007', Tindakan: 'Biarkan', Status: 'Draft' });
    prow({ Masa: 'Juli', 'Nomor Bukti Potong': 'S-5', 'NIK di Bukti Potong': '1111111111110010', 'Nama di Bukti Potong': 'JOJO', Tindakan: 'Batalkan', 'Penghasilan Bruto (Rp)': 500 });
    prow({ Masa: 'Juli', 'Nomor Bukti Potong': 'S-6', 'NIK di Bukti Potong': '1111111111110011', Tindakan: 'Batalkan', Status: 'Dibatalkan oleh Pilot · 07/11/2026 10:00' });
    await tw.xlsx.writeFile(tfile);
    const tg = await amend.readTargets(tfile);
    assert.deepEqual(tg.targets.map((x) => (x.number || '-') + ':' + x.old + '>' + x.newNik), ['-:1111111111110007>2222222222220007', 'S-1:1111111111110009>2222222222220009']);
    assert.match(tg.skipped.join(' '), /NIK "0".*per bukti potong di sheet Pembetulan/);
    // Tindakan: Biarkan / Batalkan tidak ikut diganti NIK-nya (juga oleh isian sheet NIK); Batalkan = daftar pembatalan (yang
    // sudah dibatalkan tidak diulang).
    assert.deepEqual([...tg.exclude].sort(), ['S-4', 'S-5', 'S-6']);
    assert.deepEqual(tg.cancels.map((c) => c.number + ':' + c.nik + ':' + c.name + ':' + c.masa), ['S-5:1111111111110010:JOJO:Juli']);

    // Kolom "NIK setelah pembetulan" di L-IA: rumus; nilai = NIK Baru untuk NIK salah bertindakan Ganti NIK.
    const ew = new ExcelJS.Workbook(), el = ew.addWorksheet('L-IA'), ep = ew.addWorksheet('Pembetulan');
    el.getRow(7).values = ['Masa', 'NO.', 'NIK/NPWP', 'NAMA', 'NOMOR BUKTI POTONG', 'NIK setelah pembetulan'];
    el.addRow(['April', 1, '1111111111110012', 'EKO', 'E-1', '']); el.addRow(['April', 2, '1111111111110012', 'EKO', 'E-2', '']); el.addRow(['April', 3, '9990000000999000', 'X#1', 'E-3', '']);
    ep.getRow(4).values = report.PB_COLS.map((c) => c[0]);
    const epc = (k) => report.PB_COLS.findIndex((c) => c[0] === k) + 1, erow = (o) => { const r = ep.addRow([]); for (const [k, x] of Object.entries(o)) r.getCell(epc(k)).value = x; };
    erow({ Masa: 'April', 'Nomor Bukti Potong': 'E-1', 'NIK di Bukti Potong': '1111111111110012', 'NIK Baru': '2222222222220012', 'Nama Baru': 'AYU' });
    erow({ Masa: 'April', 'Nomor Bukti Potong': 'E-3', 'NIK di Bukti Potong': '9990000000999000', 'NIK Baru': '2222222222220013', 'Nama Baru': 'ZED' });
    report.preparePembetulan(ew);
    assert.equal(ep.getCell(5, epc('Tindakan')).value, 'Ganti NIK', 'NIK Baru terisi -> Tindakan bawaan Ganti NIK');
    assert.equal(ep.getCell(5, epc('Jenis')).value, 'NIK salah');
    assert.equal(ep.getCell(5, epc('Tindakan')).dataValidation.formulae[0], '"Ganti NIK,Batalkan,Biarkan"');
    assert.equal(ep.getCell(30, 1).protection.locked, false, 'baris cadangan terbuka');
    assert.equal(report.refreshEffNik(ew), 1);
    const eff = (r) => el.getCell(r, 6).value;
    assert.deepEqual([8, 9, 10].map((r) => eff(r).result), ['2222222222220012', '1111111111110012', '9990000000999000'], 'NIK sementara tidak dialihkan lewat kolom ini');
    assert.match(eff(8).formula, /^IF\(ISNA\(MATCH\(\$E8,Pembetulan!\$B:\$B,0\)\),\$C8&"",/);

    // Membaca BPMP setahun: 4 masa sekaligus, hasil tetap urut masa, setiap baris diberi _masa.
    let open = 0, peak = 0;
    const fakeS = { list: async (ep, code) => { open++; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 20)); open--; return [{ WithholdingSlipsNumber: 'X' + code }]; } };
    const yr = await amend.listYear(fakeS, '2026');
    assert.equal(peak, 4, 'paling banyak 4 permintaan bersamaan');
    assert.deepEqual(yr.map((rows) => rows[0].WithholdingSlipsNumber + ':' + rows[0]._masa), Array.from({ length: 12 }, (_, i) => 'X' + String(i + 1).padStart(2, '0').repeat(2) + '2026:' + (i + 1)));

    // Tabel lampiran dibaca lalu ditulis ulang ExcelJS: tanpa fixTables jadi headerRowCount="0" + autoFilter (Excel "Removed
    // Records: AutoFilter from /xl/tables/table1.xml"). fixTables memulihkan baris judulnya.
    const tb = new ExcelJS.Workbook(), ws = tb.addWorksheet('L-IA'), tf = path.join(dir, 'table.xlsx');
    ws.addTable({ name: 'LampiranTable1', ref: 'A1', headerRow: true, totalsRow: false, columns: [{ name: 'Masa', filterButton: true }, { name: 'Nomor', filterButton: true }], rows: [['Januari', 'X-1']] });
    await tb.xlsx.writeFile(tf);
    // Disimpan Excel: headerRowCount (bawaan 1) tidak ditulis; ExcelJS membacanya sebagai 0.
    const JSZip = require('jszip'), z = await JSZip.loadAsync(fs.readFileSync(tf));
    z.file('xl/tables/table1.xml', (await z.file('xl/tables/table1.xml').async('string')).replace(/ headerRowCount="1"/, ''));
    fs.writeFileSync(tf, await z.generateAsync({ type: 'nodebuffer' }));
    const again = new ExcelJS.Workbook(); await again.xlsx.readFile(tf);
    assert.equal(require('../lib/xlsx-tables').fixTables(again), 1, 'file dari Excel: baris judul hilang tanpa fixTables');
    await again.xlsx.writeFile(tf);
    const xml = await (await require('jszip').loadAsync(fs.readFileSync(tf))).file('xl/tables/table1.xml').async('string');
    assert.match(xml, /headerRowCount="1"/);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('PASS: Pembetulan = identitas (NIK bermasalah / NIK salah) + pembatalan; selisih dan pembetulan di luar Pilot pindah ke sheet e-Bupot vs SPT; keterangan yang bergeser dipulihkan; nama beda 1 huruf.');
};
if (require.main === module) module.exports().catch((e) => { console.error(e); process.exitCode = 1; });
