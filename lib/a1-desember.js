/* Draft BPA1 Desember di rekap Mode A1 + XML impor BPA1 Coretax (permintaan 2026-11-05).
 *
 * Konsepnya: BPA1 (L-II) memuat penghasilan setahun; L-IB = L-II dikurangi yang sudah dilaporkan lewat BPMP (L-IA).
 * Untuk Desember belum ada yang dilaporkan, jadi dihitung di sheet "Draft SPT Desember": satu baris per pegawai yang masih
 * ada di masa L-IA terakhir (pegawai baru Desember ditambahkan sendiri), kolom hijau diisi dari KK (blok 1721-A1),
 * sisanya rumus Excel:
 *   Bruto = Gaji + Tunjangan PPh + Tunjangan Lainnya + Honorarium + Asuransi + Natura + Tantiem/Bonus/THR
 *   Biaya Jabatan = MIN(5% x Bruto, Rp500.000 x jumlah bulan bekerja)   (aturan Coretax, bukan 6 juta setahun)
 *   Neto = Bruto - Biaya Jabatan - Iuran Pensiun/JHT - Zakat; PKP = Neto - PTKP dibulatkan ke bawah ribuan
 *   PPh setahun = tarif Pasal 17; PPh Desember (L-IB) = PPh setahun - PPh BPMP Jan-Nov dari L-IA.
 * Kontrol: kolom KK (diisi dari kertas kerja) dibandingkan dengan hitungan ini; kolom konsep SPT disediakan untuk hasil
 * BPA1 Coretax setelah diimpor. XML: skema A1Bulk dari template impor DJP (BPA1 *.xlsx, xmlMaps); "PPh Pasal 21 yang
 * telah dipotong" diisi 0 sesuai petunjuk template - Coretax menghitungnya sendiri dari BPMP. */
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
// Dulu "Draft Desember" (rekap sebelum 2026-11-05) - tetap terbaca.
const SHEET = 'Draft SPT Desember', OLD_SHEET = 'Draft Desember';
const TEMP_NIK = '9990000000999000';
const PLACEHOLDER = /^PENERIMA PENGHASILAN\s*#/i;

/** [judul, lebar, jenis]: 'in' = isian (hijau; Posisi, Fasilitas, Masa Awal/Akhir terisi otomatis dari L-IA tetapi boleh diubah),
 *  'f' = rumus, 'id' = identitas dari Coretax. */
const COLS = [
    ['NIK', 19, 'id'], ['Nama', 30, 'id'], ['Status PTKP', 9, 'in'], ['Posisi', 10, 'in'], ['Kode Objek Pajak', 11, 'id'], ['Fasilitas', 8, 'in'],
    ['ID TKU Pemotong', 24, 'id'], ['Masa Awal', 7, 'in'], ['Masa Akhir', 7, 'in'], ['Jumlah Bulan', 7, 'f'],
    ['Gaji', 15, 'in'], ['Tunjangan PPh', 13, 'in'], ['Tunjangan Lainnya / Lembur', 15, 'in'], ['Honorarium', 12, 'in'], ['Asuransi', 13, 'in'], ['Natura', 12, 'in'],
    ['Tantiem, Bonus, Gratifikasi, THR', 15, 'in'], ['Iuran Pensiun / JHT', 13, 'in'], ['Zakat', 11, 'in'], ['Nomor Bukti Potong Sebelumnya', 16, 'in'],
    ['Bruto Setahun', 16, 'f'], ['Biaya Jabatan', 14, 'f'], ['Neto Setahun', 16, 'f'], ['PTKP', 13, 'f'], ['PKP', 15, 'f'], ['PPh 21 Setahun', 14, 'f'],
    ['Bruto Jan-Nov (L-IA)', 16, 'f'], ['PPh Jan-Nov (L-IA)', 14, 'f'], ['Bruto Desember (L-IB)', 16, 'f'], ['PPh Desember (L-IB)', 14, 'f'],
    ['Bruto KK', 16, 'in'], ['PPh Setahun KK', 14, 'in'], ['PPh Desember KK', 14, 'in'], ['Selisih Bruto', 12, 'f'], ['Selisih PPh Setahun', 12, 'f'], ['Selisih PPh Desember', 12, 'f'], ['Cek KK', 10, 'f'],
    ['Bruto Desember Konsep SPT', 16, 'in'], ['PPh Desember Konsep SPT', 14, 'in'], ['Selisih Bruto Konsep SPT', 12, 'f'], ['Selisih PPh Konsep SPT', 12, 'f'], ['Cek Konsep SPT', 10, 'f'],
    ['Catatan', 40, 'in']
];
const C = Object.fromEntries(COLS.map(([h], i) => [h, i + 1]));
const INPUTS = COLS.filter((c) => c[2] === 'in' || c[2] === 'id').map((c) => c[0]).filter((h) => h !== 'NIK');
// Kolom yang bukan angka rupiah: tidak dijumlah di baris total.
const NOT_SUMMED = new Set(['Status PTKP', 'Posisi', 'Fasilitas', 'Masa Awal', 'Masa Akhir', 'Jumlah Bulan', 'Cek KK', 'Cek Konsep SPT', 'Catatan', 'Nomor Bukti Potong Sebelumnya']);
/** Baris kosong siap pakai (rumus sudah ada, sel isian terbuka) untuk pegawai baru Desember. */
const SPARE = 25;
const MONEY_IN = ['Gaji', 'Tunjangan PPh', 'Tunjangan Lainnya / Lembur', 'Honorarium', 'Asuransi', 'Natura', 'Tantiem, Bonus, Gratifikasi, THR'];
const HEAD = 6; // kop 1-3, total 4, keterangan 5, judul kolom 6

const text = (v) => v && typeof v === 'object' ? ('result' in v ? v.result : v.richText ? v.richText.map((r) => r.text).join('') : v.text) : v;
const str = (v) => String(text(v) ?? '').trim();
const num = (v) => { const t = text(v); if (t === '' || t == null) return 0; const n = typeof t === 'number' ? t : Number(String(t).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const L = (h) => { let n = C[h], s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** PTKP 2016-sekarang: TK/0 54 jt, kawin +4,5 jt, HB (penghasilan istri digabung) +54 jt, tiap tanggungan +4,5 jt. */
function ptkp(status) {
    const m = /^(TK|K|HB)\/([0-3])$/.exec(String(status || '').trim().toUpperCase());
    if (!m) return null;
    return 54e6 + (m[1] === 'K' ? 4.5e6 : m[1] === 'HB' ? 58.5e6 : 0) + 4.5e6 * Number(m[2]);
}
/** Tarif Pasal 17 (UU HPP). */
function pasal17(pkp) {
    const layers = [[60e6, 0.05], [250e6, 0.15], [500e6, 0.25], [5e9, 0.30], [Infinity, 0.35]];
    let tax = 0, prev = 0;
    for (const [top, rate] of layers) { if (pkp > prev) tax += (Math.min(pkp, top) - prev) * rate; prev = top; }
    return Math.round(tax);
}
/** Hitungan satu baris, sama dengan rumus di sheet (untuk nilai tersimpan, laporan, dan uji). */
function calc(r) {
    const months = Math.max(0, (Number(r['Masa Akhir']) || 12) - (Number(r['Masa Awal']) || 1) + 1);
    const bruto = MONEY_IN.reduce((a, k) => a + num(r[k]), 0);
    const bj = Math.min(bruto * 0.05, 500000 * months);
    const neto = bruto - bj - num(r['Iuran Pensiun / JHT']) - num(r['Zakat']);
    const p = ptkp(r['Status PTKP']);
    const pkp = p == null ? 0 : Math.max(0, Math.floor((neto - p) / 1000) * 1000);
    const tax = p == null ? 0 : pasal17(pkp);
    return { months, bruto, bj, neto, ptkp: p, pkp, tax, brutoDes: bruto - num(r.brutoJanNov), taxDes: tax - num(r.taxJanNov) };
}

/** Sheet Draft SPT Desember dari L-IA rekap (`table` = tabel gabungan L-IA dengan kolom Masa di depan, `ws0` = sheet L-IA). */
function addDraftDesember(wb, { entity, table, ws0, year, lib, wsLib }) {
    const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', xSplit: 2, ySplit: HEAD }] });
    const h = (re) => table ? table.headers.findIndex((x) => re.test(x)) : -1;
    const col = { nik: h(/NIK|NPWP/i), nama: h(/^NAMA/i), kop: h(/KODE OBJEK/i), bruto: h(/BRUTO/i), pph: h(/^PAJAK PENGHASILAN/i), tku: h(/ID TEMPAT|TKU/i), fas: h(/FASILITAS/i) };
    // Baris data L-IA: di bawah judul kolom "Masa".
    let headRow = 0; if (ws0) ws0.eachRow((row, n) => { if (!headRow && n > 5 && row.getCell(1).value === 'Masa') headRow = n; });
    const first = headRow + 1, last = headRow + (table ? table.rows.length : 0);
    const rng = (i) => "'" + (ws0 ? ws0.name : 'L-IA') + "'!$" + (ws0 ? ws0.getColumn(i + 1).letter : 'A') + '$' + first + ':$' + (ws0 ? ws0.getColumn(i + 1).letter : 'A') + '$' + last;
    // Pegawai: NIK valid yang ada di masa L-IA terakhir (yang sudah keluar tidak ikut; pegawai baru Desember ditambah sendiri).
    const people = new Map(); let latest = -1;
    // Pegawai yang keluar lalu masuk lagi (NIK sama, sudah ada BPA1 sebelum Desember di L-IB): periode kedua saja -
    // Masa Awal sesudah BPA1 itu, Jan-Nov hanya masa sesudahnya, Nomor Bukti Potong Sebelumnya terisi (penggabungan).
    const hb0 = (re) => lib ? lib.headers.findIndex((x) => re.test(x)) : -1, ln = hb0(/NIK|NPWP/i), lno = hb0(/NOMOR BUKTI/i), prev = new Map();
    if (lib && ln >= 0) for (const row of lib.rows) {
        const m = MONTHS.indexOf(String(row[0] || '').trim()), nik = String(row[ln] || '').trim();
        if (m < 0 || m >= 11 || !/^\d{16}$/.test(nik)) continue;
        if (!prev.has(nik) || prev.get(nik).m < m) prev.set(nik, { m, number: lno >= 0 ? String(row[lno] || '').trim() : '' });
    }
    if (table && col.nik >= 0) for (const row of table.rows) {
        const nik = String(row[col.nik] || '').trim(), m = MONTHS.indexOf(String(row[0] || '').trim());
        if (!/^\d{16}$/.test(nik) || nik === TEMP_NIK || m < 0) continue;
        if (prev.has(nik) && m <= prev.get(nik).m) continue;
        if (col.kop >= 0 && !/^21-100-(01|02|32)$/.test(String(row[col.kop] || '').trim())) continue;
        if (m < 11) latest = Math.max(latest, m);
        if (!people.has(nik)) people.set(nik, { nik, name: '', first: m, last: -1, row: null, bruto: 0, tax: 0 });
        const p = people.get(nik), name = col.nama >= 0 ? String(row[col.nama] || '').trim() : '';
        if (name && (!p.name || (PLACEHOLDER.test(p.name) && !PLACEHOLDER.test(name)))) p.name = name;
        p.first = Math.min(p.first, m);
        if (m >= p.last && m < 11) { p.last = m; p.row = row; }
        if (m < 11) { p.bruto += num(row[col.bruto]); p.tax += num(row[col.pph]); }
    }
    // BPA1 Desember yang sudah ada di L-IB (SPT Desember sudah dibuat/dilaporkan): ikut roster, dan jadi pembanding konsep SPT.
    const hb = (re) => lib ? lib.headers.findIndex((x) => re.test(x)) : -1, lc = { nik: hb(/NIK|NPWP/i), nama: hb(/^NAMA/i), kop: hb(/KODE OBJEK/i), tku: hb(/ID TEMPAT|TKU/i) };
    const decLib = lib && lc.nik >= 0 ? lib.rows.filter((row) => String(row[0] || '').trim() === 'Desember' && /^\d{16}$/.test(String(row[lc.nik] || '').trim())) : [];
    for (const row of decLib) {
        const nik = String(row[lc.nik]).trim();
        if (people.has(nik) && people.get(nik).last === latest) continue;
        people.set(nik, { nik, name: lc.nama >= 0 ? String(row[lc.nama] || '').trim() : '', first: 11, last: latest, row: null, bruto: 0, tax: 0, fromLib: row, ...(people.get(nik) ? { first: people.get(nik).first, bruto: people.get(nik).bruto, tax: people.get(nik).tax } : {}) });
    }
    const roster = [...people.values()].filter((p) => p.last === latest).sort((a, b) => a.name.localeCompare(b.name));
    // Setiap pegawai tetap akhirnya harus dibuatkan BPA1 (permintaan 2026-11-05): BPMP terakhirnya sebelum masa data terakhir
    // (gaji berhenti, mis. April) tanpa BPA1 di L-IB sesudahnya = kemungkinan resign yang belum dibuatkan BPA1.
    const noA1 = [...people.values()].filter((p) => p.last >= 0 && p.last < latest && !(prev.has(p.nik) && prev.get(p.nik).m >= p.last))
        .sort((a, b) => a.last - b.last || a.name.localeCompare(b.name)).map((p) => ({ nik: p.nik, name: p.name, last: MONTHS[p.last] }));
    let libHead = 0; if (wsLib) wsLib.eachRow((row, n) => { if (!libHead && n > 5 && row.getCell(1).value === 'Masa') libHead = n; });
    const libRange = decLib.length && libHead && wsLib ? (re) => { const i = hb(re); if (i < 0) return null; const l = wsLib.getColumn(i + 1).letter; return "'" + wsLib.name + "'!$" + l + '$' + (libHead + 1) + ':$' + l + '$' + (libHead + lib.rows.length); } : null;

    require('./bpmp-report').writeKop(ws, { entity, title: SHEET, year });
    const total = ws.addRow(['TOTAL (sesuai filter)']);
    ws.addRow(['Isi kolom hijau dari KK (hijau tua wajib). Pegawai baru Desember: baris kosong di bawah. Data s.d. ' + (latest >= 0 ? MONTHS[latest] : '-') + '.']);
    ws.addRow(COLS.map((c) => c[0]));
    const head = ws.getRow(HEAD);
    // Hijau tua = wajib diisi (tanpanya XML BPA1 tidak dibuat), hijau muda = isian lain.
    const REQUIRED = new Set(['Status PTKP', 'Gaji']);
    head.eachCell((cell) => { const kind = COLS[cell.col - 1][2], req = REQUIRED.has(COLS[cell.col - 1][0]); cell.fill = solid(req ? 'FF548235' : kind === 'in' ? 'FFA9D08E' : kind === 'f' ? 'FFEDEDED' : 'FFD9D9D9'); cell.font = { bold: true, color: { argb: req ? 'FFFFFFFF' : 'FF000000' } }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
    head.height = 44;
    COLS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
    const fas = (v) => /DTP|Ditanggung Pemerintah/i.test(String(v || '')) ? 'DTP' : 'N/A';
    roster.forEach((p, i) => {
        const r = HEAD + 1 + i, row = ws.getRow(r);
        const src = p.row || p.fromLib, sc = p.row ? col : lc;
        const pv = prev.get(p.nik);
        const v = { NIK: p.nik, Nama: p.name, Posisi: 'Staff', 'Nomor Bukti Potong Sebelumnya': pv ? pv.number : '',
            Catatan: pv ? 'Sudah ada BPA1 ' + MONTHS[pv.m] + ' (' + pv.number + ') - pegawai masuk lagi: draft ini periode sesudahnya; Jan-Nov dihitung mulai ' + MONTHS[pv.m + 1] + '.' : '', 'Kode Objek Pajak': sc.kop >= 0 ? String(src[sc.kop] || '').trim() : '21-100-01', Fasilitas: p.row && col.fas >= 0 ? fas(p.row[col.fas]) : 'N/A',
            'ID TKU Pemotong': sc.tku >= 0 ? String(src[sc.tku] || '').trim() : '', 'Masa Awal': p.first + 1, 'Masa Akhir': 12, brutoJanNov: p.bruto, taxJanNov: p.tax };
        for (const [k, val] of Object.entries(v)) if (C[k]) row.getCell(C[k]).value = val;
        writeFormulas(ws, r, rng, col, calc(v), false, pv ? MONTHS.slice(pv.m + 1, 11) : null);
        if (libRange) {
            const nikCell = 'A' + r, cond = libRange(/NIK|NPWP/i) + ',' + nikCell + '&"*",' + libRange(/^Masa$/) + ',"Desember"';
            const got = decLib.filter((x) => String(x[lc.nik]).trim() === p.nik), sum = (re) => got.reduce((a, x) => a + num(x[hb(re)]), 0);
            const put = (h, re) => { const rg = libRange(re); if (rg) row.getCell(C[h]).value = { formula: 'IF(COUNTIFS(' + cond + ')=0,"",SUMIFS(' + rg + ',' + cond + '))', result: got.length ? sum(re) : '' }; };
            put('Bruto Desember Konsep SPT', /BRUTO/i); put('PPh Desember Konsep SPT', /^PAJAK PENGHASILAN/i);
        }
    });
    // Baris cadangan untuk pegawai baru Desember: kosong (rumus siap, NIK/Nama/isian terbuka). Posisi, Kode Objek Pajak,
    // Fasilitas dan ID TKU yang dibiarkan kosong diisi bawaan saat XML dibuat (buildXml); Masa kosong = 12-12.
    for (let i = 0; i < SPARE; i++) writeFormulas(ws, HEAD + 1 + roster.length + i, rng, col, calc({ 'Masa Awal': 12, 'Masa Akhir': 12 }), true);
    const lastRow = HEAD + roster.length + SPARE;
    // Pilihan isian yang sah (sama dengan skema XML BPA1).
    for (let r = HEAD + 1; r <= lastRow; r++) {
        ws.getCell(L('Status PTKP') + r).dataValidation = { type: 'list', allowBlank: true, formulae: ['"TK/0,TK/1,TK/2,TK/3,K/0,K/1,K/2,K/3,HB/0,HB/1,HB/2,HB/3"'] };
        ws.getCell(L('Fasilitas') + r).dataValidation = { type: 'list', allowBlank: true, formulae: ['"N/A,DTP"'] };
        for (const m of ['Masa Awal', 'Masa Akhir']) ws.getCell(L(m) + r).dataValidation = { type: 'whole', operator: 'between', allowBlank: false, formulae: [1, 12] };
    }
    for (const [hd, , kind] of COLS) if (kind !== 'id' && !NOT_SUMMED.has(hd)) {
        const l = L(hd); total.getCell(C[hd]).value = { formula: 'SUBTOTAL(109,' + l + (HEAD + 1) + ':' + l + lastRow + ')', result: 0 }; total.getCell(C[hd]).numFmt = '#,##0';
    }
    for (let c = 1; c <= COLS.length; c++) total.getCell(c).fill = solid('FFF2F2F2');
    total.font = { bold: true }; total.getCell(1).alignment = { wrapText: false }; ws.getRow(HEAD - 1).getCell(1).alignment = { wrapText: false }; ws.getRow(HEAD - 1).font = { italic: true };
    ws.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: lastRow, column: COLS.length } };
    refreshTotals(ws);
    return { rows: roster.length, latest, noA1 };
}
/** Rumus satu baris (`res`: nilai tersimpan dari calc()). */
function writeFormulas(ws, r, rng, col, res, spare = false, onlyMonths = null) {
    const c = (h) => L(h) + r, f = (h, formula, result) => { ws.getCell(c(h)).value = { formula, result }; };
    f('Jumlah Bulan', c('Masa Akhir') + '-' + c('Masa Awal') + '+1', res.months);
    f('Bruto Setahun', MONEY_IN.map(c).join('+'), res.bruto);
    f('Biaya Jabatan', 'MIN(5%*' + c('Bruto Setahun') + ',500000*' + c('Jumlah Bulan') + ')', res.bj);
    f('Neto Setahun', c('Bruto Setahun') + '-' + c('Biaya Jabatan') + '-' + c('Iuran Pensiun / JHT') + '-' + c('Zakat'), res.neto);
    const s = c('Status PTKP');
    f('PTKP', 'IF(' + s + '="","",54000000+IF(LEFT(' + s + ',2)="K/",4500000,0)+IF(LEFT(' + s + ',2)="HB",58500000,0)+4500000*VALUE(RIGHT(' + s + ',1)))', res.ptkp ?? '');
    f('PKP', 'IF(' + c('PTKP') + '="",0,MAX(0,ROUNDDOWN((' + c('Neto Setahun') + '-' + c('PTKP') + ')/1000,0)*1000))', res.pkp);
    const p = c('PKP');
    f('PPh 21 Setahun', 'ROUND(MIN(' + p + ',60000000)*5%+MAX(0,MIN(' + p + ',250000000)-60000000)*15%+MAX(0,MIN(' + p + ',500000000)-250000000)*25%+MAX(0,MIN(' + p + ',5000000000)-500000000)*30%+MAX(0,' + p + '-5000000000)*35%,0)', res.tax);
    // Pegawai masuk lagi: hanya masa sesudah BPA1 sebelumnya (konstanta larik nama bulan di SUMIFS).
    const cond = rng(col.nik) + ',' + c('NIK') + '&"*",' + rng(0) + ',' + (onlyMonths ? '{' + onlyMonths.map((m) => '"' + m + '"').join(',') + '}' : '"<>Desember"');
    const sumifs = (i) => (onlyMonths ? 'SUM(SUMIFS(' : 'SUMIFS(') + rng(i) + ',' + cond + (onlyMonths ? '))' : ')');
    f('Bruto Jan-Nov (L-IA)', col.bruto >= 0 ? sumifs(col.bruto) : '0', res.bruto - res.brutoDes);
    f('PPh Jan-Nov (L-IA)', col.pph >= 0 ? sumifs(col.pph) : '0', res.tax - res.taxDes);
    f('Bruto Desember (L-IB)', c('Bruto Setahun') + '-' + c('Bruto Jan-Nov (L-IA)'), res.brutoDes);
    f('PPh Desember (L-IB)', c('PPh 21 Setahun') + '-' + c('PPh Jan-Nov (L-IA)'), res.taxDes);
    f('Selisih Bruto', 'IF(' + c('Bruto KK') + '="","",' + c('Bruto Setahun') + '-' + c('Bruto KK') + ')', '');
    f('Selisih PPh Setahun', 'IF(' + c('PPh Setahun KK') + '="","",' + c('PPh 21 Setahun') + '-' + c('PPh Setahun KK') + ')', '');
    f('Selisih PPh Desember', 'IF(' + c('PPh Desember KK') + '="","",' + c('PPh Desember (L-IB)') + '-' + c('PPh Desember KK') + ')', '');
    f('Cek KK', 'IF(AND(' + c('Bruto KK') + '="",' + c('PPh Setahun KK') + '="",' + c('PPh Desember KK') + '=""),"KK kosong",IF(MAX(ABS(N(' + c('Selisih Bruto') + ')),ABS(N(' + c('Selisih PPh Setahun') + ')),ABS(N(' + c('Selisih PPh Desember') + ')))<1,"OK","Selisih"))', 'KK kosong');
    f('Selisih Bruto Konsep SPT', 'IF(' + c('Bruto Desember Konsep SPT') + '="","",' + c('Bruto Desember (L-IB)') + '-' + c('Bruto Desember Konsep SPT') + ')', '');
    f('Selisih PPh Konsep SPT', 'IF(' + c('PPh Desember Konsep SPT') + '="","",' + c('PPh Desember (L-IB)') + '-' + c('PPh Desember Konsep SPT') + ')', '');
    f('Cek Konsep SPT', 'IF(AND(' + c('Bruto Desember Konsep SPT') + '="",' + c('PPh Desember Konsep SPT') + '=""),"Belum ada",IF(MAX(ABS(N(' + c('Selisih Bruto Konsep SPT') + ')),ABS(N(' + c('Selisih PPh Konsep SPT') + ')))<1,"OK","Selisih"))', 'Belum ada');
    if (spare) {
        // Baris cadangan kosong sampai NIK diisi. Masa Awal / Akhir kosong = pegawai baru Desember (12-12).
        f('Jumlah Bulan', 'IF(' + c('NIK') + '="","",IF(' + c('Masa Akhir') + '="",12,' + c('Masa Akhir') + ')-IF(' + c('Masa Awal') + '="",12,' + c('Masa Awal') + ')+1)', '');
        f('Biaya Jabatan', 'MIN(5%*' + c('Bruto Setahun') + ',500000*N(' + c('Jumlah Bulan') + '))', 0);
        f('Cek KK', 'IF(' + c('NIK') + '="","",' + ws.getCell(c('Cek KK')).value.formula + ')', '');
        f('Cek Konsep SPT', 'IF(' + c('NIK') + '="","",' + ws.getCell(c('Cek Konsep SPT')).value.formula + ')', '');
    }
    const row = ws.getRow(r);
    COLS.forEach(([hd, , kind], i) => {
        const cell = row.getCell(i + 1);
        // Kunci lembar (lib/a1-workbook.js): hanya isian hijau yang bisa diubah; baris cadangan juga NIK/Nama/KOP/TKU.
        cell.protection = { locked: !(kind === 'in' || (spare && kind === 'id')) };
        // Hijau muda = isian pegawai yang ada. Baris cadangan tanpa warna (tetap bisa diisi) supaya tidak tampak seperti data.
        if (kind === 'in' && !spare) cell.fill = solid('FFE2EFDA');
        if (!['NIK', 'Nama', 'Status PTKP', 'Posisi', 'Kode Objek Pajak', 'Fasilitas', 'ID TKU Pemotong', 'Masa Awal', 'Masa Akhir', 'Jumlah Bulan', 'Cek KK', 'Cek Konsep SPT', 'Catatan', 'Nomor Bukti Potong Sebelumnya'].includes(hd)) cell.numFmt = '#,##0;-#,##0;"-"';
    });
    for (const hd of ['NIK', 'ID TKU Pemotong', 'Nomor Bukti Potong Sebelumnya']) row.getCell(C[hd]).numFmt = '@';
}

/** Baris draft sebagai objek {judul kolom: nilai}, dengan hasil hitung JS. */
function readDraft(wb) {
    const ws = wb.getWorksheet(SHEET) || wb.getWorksheet(OLD_SHEET);
    if (!ws) return null;
    let head = 0; ws.eachRow((r, n) => { if (!head && n <= 10 && str(r.getCell(1).value) === 'NIK' && str(r.getCell(2).value) === 'Nama') head = n; });
    if (!head) return null;
    const idx = new Map(); ws.getRow(head).eachCell((c, i) => idx.set(str(c.value), i));
    const rows = [];
    ws.eachRow((r, n) => {
        if (n <= head) return;
        const o = { _row: n }; for (const [k, i] of idx) o[k] = text(r.getCell(i).value);
        if (!/^\d{16}$/.test(str(o.NIK))) return;
        o.brutoJanNov = num(o['Bruto Jan-Nov (L-IA)']); o.taxJanNov = num(o['PPh Jan-Nov (L-IA)']);
        // Baris cadangan (rumus Jumlah Bulan berawalan IF(NIK...)): Masa kosong = 12-12, seperti rumusnya.
        const jb = r.getCell(idx.get('Jumlah Bulan')).value;
        if (jb && jb.formula && /^IF\(/.test(jb.formula)) { if (o['Masa Akhir'] === '' || o['Masa Akhir'] == null) o['Masa Akhir'] = 12; if (o['Masa Awal'] === '' || o['Masa Awal'] == null) o['Masa Awal'] = 12; }
        o.calc = calc(o); rows.push(o);
    });
    return { ws, head, rows };
}
/** Nilai tersimpan rumus diperbarui dari calc() setelah isian berubah (Excel juga menghitung ulang saat dibuka). */
function refreshTotals(ws) {
    const wbLike = { getWorksheet: () => ws };
    const d = readDraft(wbLike); if (!d) return;
    const sums = {};
    for (const o of d.rows) {
        const r = ws.getRow(o._row), x = o.calc, set = (h, v) => { const cell = r.getCell(C[h]); if (cell.value && cell.value.formula) cell.value = { formula: cell.value.formula, result: v }; };
        set('Jumlah Bulan', x.months); set('Bruto Setahun', x.bruto); set('Biaya Jabatan', x.bj); set('Neto Setahun', x.neto); set('PTKP', x.ptkp ?? ''); set('PKP', x.pkp); set('PPh 21 Setahun', x.tax);
        set('Bruto Desember (L-IB)', x.brutoDes); set('PPh Desember (L-IB)', x.taxDes);
        const kk = (h) => (o[h] === '' || o[h] == null ? '' : num(o[h]));
        const sb = kk('Bruto KK') === '' ? '' : x.bruto - kk('Bruto KK'), st = kk('PPh Setahun KK') === '' ? '' : x.tax - kk('PPh Setahun KK'), sd = kk('PPh Desember KK') === '' ? '' : x.taxDes - kk('PPh Desember KK');
        set('Selisih Bruto', sb); set('Selisih PPh Setahun', st); set('Selisih PPh Desember', sd);
        set('Cek KK', sb === '' && st === '' && sd === '' ? 'KK kosong' : Math.max(Math.abs(+sb || 0), Math.abs(+st || 0), Math.abs(+sd || 0)) < 1 ? 'OK' : 'Selisih');
        const kb = kk('Bruto Desember Konsep SPT') === '' ? '' : x.brutoDes - kk('Bruto Desember Konsep SPT'), kp = kk('PPh Desember Konsep SPT') === '' ? '' : x.taxDes - kk('PPh Desember Konsep SPT');
        set('Selisih Bruto Konsep SPT', kb); set('Selisih PPh Konsep SPT', kp);
        set('Cek Konsep SPT', kb === '' && kp === '' ? 'Belum ada' : Math.max(Math.abs(+kb || 0), Math.abs(+kp || 0)) < 1 ? 'OK' : 'Selisih');
        for (const [hd, , kind] of COLS) if (kind !== 'id' && !NOT_SUMMED.has(hd)) { const v = text(r.getCell(C[hd]).value); if (typeof v === 'number') sums[hd] = (sums[hd] || 0) + v; }
    }
    const total = ws.getRow(HEAD - 2);
    for (const [hd, v] of Object.entries(sums)) { const cell = total.getCell(C[hd]); if (cell.value && cell.value.formula) cell.value = { formula: cell.value.formula, result: v }; }
}
/** Isian draft (kolom hijau dan identitas yang diubah) dibawa ke rekap baru, dicocokkan per NIK. */
function carryDraft(fromWb, toWb) {
    const a = readDraft(fromWb), b = readDraft(toWb);
    if (!a || !b) return 0;
    const dest = new Map(b.rows.map((o) => [str(o.NIK), o._row]));
    // Baris cadangan yang masih kosong (NIK belum diisi), untuk pegawai yang ditambah sendiri di rekap sebelumnya.
    const spare = []; b.ws.eachRow((row, n) => { if (n > b.head && !str(row.getCell(C.NIK).value) && row.getCell(C['Bruto Setahun']).value) spare.push(n); });
    let n = 0;
    for (const o of a.rows) {
        let r = dest.get(str(o.NIK));
        if (!r) { r = spare.shift(); if (!r) continue; for (const h of ['NIK', 'Nama', 'Kode Objek Pajak', 'ID TKU Pemotong']) if (o[h]) b.ws.getCell(r, C[h]).value = String(o[h]); }
        const row = b.ws.getRow(r);
        for (const h of INPUTS) { const v = o[h]; if (v !== undefined && v !== null && v !== '') row.getCell(C[h]).value = v; }
        n++;
    }
    refreshTotals(b.ws);
    return n;
}

/** XML impor BPA1 (skema A1Bulk). `tin`: NPWP pemotong 16 digit; tanpa itu diambil dari 16 digit awal ID TKU. */
function buildXml(wb, { year, tin, date } = {}) {
    const d = readDraft(wb);
    if (!d) throw new Error('Sheet ' + SHEET + ' tidak ada.');
    const errors = [], rows = d.rows.filter((o) => MONEY_IN.some((k) => num(o[k])));
    if (!rows.length) throw new Error('Belum ada baris ' + SHEET + ' yang kolom Gaji / penghasilannya terisi.');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const n0 = (v) => String(Math.round(num(v)));
    const pemotong = tin || str((rows.find((o) => /^\d{22}$/.test(str(o['ID TKU Pemotong']))) || rows[0])['ID TKU Pemotong']).slice(0, 16);
    if (!/^\d{15,16}$/.test(pemotong)) errors.push('NPWP pemotong tidak terbaca (isi kolom ID TKU Pemotong, 22 digit).');
    const when = date || (year + '-12-31');
    // ID TKU kosong (baris cadangan) = ID TKU pemotong di baris lain.
    const tkuDefault = (rows.find((o) => /^\d{22}$/.test(str(o['ID TKU Pemotong']))) || {})['ID TKU Pemotong'];
    const items = rows.map((o) => {
        const where = 'baris ' + o._row + ' (' + str(o.NIK) + ' ' + str(o.Nama) + ')';
        if (!str(o['ID TKU Pemotong']) && tkuDefault) o['ID TKU Pemotong'] = str(tkuDefault);
        // Masa kosong: dari Jumlah Bulan (baris cadangan = 12-12), selain itu setahun penuh.
        const end = Number(o['Masa Akhir']) || 12, months = Number(o['Jumlah Bulan']), start = Number(o['Masa Awal']) || (months >= 1 && months <= end ? end - months + 1 : 1);
        if (ptkp(o['Status PTKP']) == null) errors.push(where + ': Status PTKP kosong / tidak valid.');
        if (!/^\d{22}$/.test(str(o['ID TKU Pemotong']))) errors.push(where + ': ID TKU Pemotong harus 22 digit.');
        if (start < 1 || end > 12 || start > end) errors.push(where + ': Masa Awal / Akhir tidak valid.');
        const fields = [['WorkForSecondEmployer', 'No'], ['TaxPeriodMonthStart', start], ['TaxPeriodMonthEnd', end], ['TaxPeriodYear', year], ['CounterpartOpt', 'Resident'], ['CounterpartPassport', null],
            ['CounterpartTin', str(o.NIK)], ['TaxExemptOpt', str(o['Status PTKP']).toUpperCase()], ['StatusOfWithholding', start === 1 && end === 12 ? 'FullYear' : 'PartialYear'], ['CounterpartPosition', str(o.Posisi) || 'Staff'],
            ['TaxObjectCode', str(o['Kode Objek Pajak']) || '21-100-01'], ['NumberOfMonths', 0], ['SalaryPensionJhtTht', n0(o.Gaji)], ['GrossUpOpt', 'No'], ['IncomeTaxBenefit', n0(o['Tunjangan PPh'])],
            ['OtherBenefit', n0(o['Tunjangan Lainnya / Lembur'])], ['Honorarium', n0(o.Honorarium)], ['InsurancePaidByEmployer', n0(o.Asuransi)], ['Natura', n0(o.Natura)],
            ['TantiemBonusThr', n0(o['Tantiem, Bonus, Gratifikasi, THR'])], ['PensionContributionJhtThtFee', n0(o['Iuran Pensiun / JHT'])], ['Zakat', n0(o.Zakat)],
            ['PrevWhTaxSlip', str(o['Nomor Bukti Potong Sebelumnya']) || null],
            ['TaxCertificate', str(o.Fasilitas) === 'DTP' ? 'DTP' : 'N/A'], ['Article21IncomeTax', '0'], ['IDPlaceOfBusinessActivity', str(o['ID TKU Pemotong'])], ['WithholdingDate', when]];
        return '\t\t<A1>\n' + fields.map(([k, v]) => v === null ? '\t\t\t<' + k + '/>' : '\t\t\t<' + k + '>' + esc(v) + '</' + k + '>').join('\n') + '\n\t\t</A1>';
    });
    if (errors.length) throw Object.assign(new Error('XML BPA1 belum bisa dibuat:\n- ' + errors.slice(0, 15).join('\n- ') + (errors.length > 15 ? '\n- ... dan ' + (errors.length - 15) + ' lagi' : '')), { errors });
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n<A1Bulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n\t<TIN>' + pemotong + '</TIN>\n\t<ListOfA1>\n' + items.join('\n') + '\n\t</ListOfA1>\n</A1Bulk>\n';
    return { xml, count: rows.length, skipped: d.rows.length - rows.length, totalTax: rows.reduce((a, o) => a + o.calc.tax, 0), totalDes: rows.reduce((a, o) => a + o.calc.taxDes, 0) };
}

module.exports = { SHEET, OLD_SHEET, COLS, addDraftDesember, readDraft, refreshTotals, carryDraft, buildXml, calc, ptkp, pasal17 };
