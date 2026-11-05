/* Pembetulan NIK BPMP di dalam Excel rekap Mode A1 itu sendiri. Susunan rekap (2026-11-05, dari 11 jadi 7 sheet):
 *   Ringkasan   - kalimat status di atas + satu baris per masa (versi, data, PDF, NIK bermasalah, status SPT Masa).
 *   NIK         - satu baris per NIK; kolom hijau NIK Baru / Nama Baru = satu-satunya tempat isian.
 *   Pembetulan  - satu baris per bukti potong yang perlu / pernah dibetulkan, dengan status TERAKHIR-nya. Dibaca lagi
 *                 oleh automation/bpmp-amend.js readTargets sehingga proses berikutnya tahu mana yang sudah.
 *   L-IA, L-IB, L-II, L-III - data dari Coretax.
 * Modul ini menulis hasil pembetulan + penyisiran ke sheet Pembetulan dan Ringkasan, dan membawa isian serta status
 * ke file baru saat rekap disusun ulang (lib/a1-workbook.js save, lib/a1-import.js). Excel lama yang masih memakai
 * sheet BPMP per NIK / Hasil Pembetulan / Sisa NIK Bermasalah / Status SPT Masa tetap terbaca.
 * Tanpa sel gabungan (Ctrl+Space harus bisa memilih kolom). */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
/** Kolom sheet Pembetulan: [judul, lebar]. lib/a1-workbook.js menulis sheet ini dengan kolom yang sama. */
const PB_COLS = [['Masa', 11], ['Nomor Bukti Potong', 18], ['Tanggal Bukti Potong', 13], ['Kode Objek Pajak', 12], ['NIK di Bukti Potong', 19], ['Nama di Bukti Potong', 34],
    ['NIK Lama (dari #)', 19], ['NIK Baru', 19], ['Nama Baru', 28], ['Penghasilan Bruto (Rp)', 16], ['PPh (Rp)', 14], ['Status', 34], ['Nama Resmi Coretax', 28],
    ['Pemeriksaan Ulang', 22], ['Waktu', 17], ['Cek Coretax', 30], ['Dilaporkan di SPT', 12], ['Jenis', 20], ['Selisih e-Bupot vs SPT', 50], ['Catatan', 60]];
/** Ringkasan per masa: versi, kelengkapan, banyaknya bukti potong bermasalah dan yang sudah dibetulkan, status SPT. */
const RK_COLS = [['Masa', 12], ['Pembetulan Terakhir (0 = normal)', 14], ['Data Excel', 28], ['PDF', 22], ['Bukti Potong Bermasalah', 14],
    ['Bukti Potong Dibetulkan', 14], ['Status SPT Masa', 34], ['Diperiksa', 17], ['Catatan', 50]];
const TEXT_COLS = ['Nomor Bukti Potong', 'NIK di Bukti Potong', 'NIK Lama (dari #)', 'NIK Baru'];
const SPT_PENDING = 'SPT Masa yang perlu dibetulkan: ';
/** Baris kalimat status di Ringkasan (di bawah kop 3 baris dan baris kelengkapan data). */
const RK_LINE = { nik: 5, spt: 6 };

const text = (v) => v && typeof v === 'object' ? ('result' in v ? v.result : v.richText ? v.richText.map((r) => r.text).join('') : v.text) : v;
const str = (v) => String(text(v) ?? '').trim();
const pad = (n) => String(n).padStart(2, '0');
// Tanpa Intl: Node di exe tidak membawa data lokal Indonesia (lib/id-number.js).
const stamp = (d) => pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const masaLabel = (code) => MONTHS[+String(code).slice(0, 2) - 1] || String(code);
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/** Baris judul kolom: baris pertama (s.d. 12) yang kolom A-nya "Masa" atau "NIK" - sheet rekap punya kop 3 baris di
 *  atasnya (permintaan 2026-11-05), Excel lama tidak (judul di baris 1). */
function detectHead(ws) { for (let n = 1; n <= 12; n++) { const a = str(ws.getCell(n, 1).value); if (a === 'Masa' || (a === 'NIK' && str(ws.getCell(n, 2).value) === 'Nama')) return n; } return 1; }
const heads = new WeakMap();
const H = (ws) => { if (!heads.has(ws)) heads.set(ws, detectHead(ws)); return heads.get(ws); };
/** Judul kolom -> nomor kolom untuk baris judul `row` (tanpa `row`: baris judul yang terdeteksi). */
function headerMap(ws, row) { const m = new Map(); ws.getRow(row || H(ws)).eachCell((c, i) => m.set(str(c.value), i)); return m; }
/** "MAJU JAYA ABADI, PT" -> "Maju Jaya Abadi, PT" (bentuk badan usaha tetap seperti biasa ditulis). */
function properName(s) {
    const keep = { PT: 'PT', CV: 'CV', TBK: 'Tbk', UD: 'UD', PD: 'PD', FA: 'Fa', KSP: 'KSP', PERSERO: 'Persero', YAYASAN: 'Yayasan' };
    return String(s || '').toLowerCase().replace(/[a-z0-9]+/g, (w) => keep[w.toUpperCase()] || w.charAt(0).toUpperCase() + w.slice(1));
}
/** Kop tiga baris di atas setiap sheet rekap: nama entitas, judul sheet, tahun. */
function writeKop(ws, { entity, title, year }) {
    const lines = [properName(entity), title, year ? 'Tahun ' + year : ''];
    lines.forEach((t, i) => { const c = ws.getCell(i + 1, 1); c.value = t; restyle(c, { font: { bold: true, size: i === 0 ? 13 : i === 1 ? 12 : 10 }, alignment: { horizontal: 'left', vertical: 'middle', wrapText: false } }); });
    return 3;
}
/** Ubah gaya satu sel saja. ExcelJS memakai satu objek gaya untuk semua sel bergaya sama yang dimuat dari file;
 *  cell.font = ... mengubah objek bersama itu (pernah membuat 2.798 sel L-IA merah). */
function restyle(cell, patch) { cell.style = { ...cell.style, ...patch }; }
function styleHeader(ws, cols, row = 1) {
    const head = ws.getRow(row);
    head.eachCell((cell) => { cell.font = { bold: true }; cell.fill = solid('FFD9D9D9'); cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    cols.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
    head.height = 32;
}

// ---------- sheet Pembetulan ----------
function ensurePembetulan(wb) {
    let ws = wb.getWorksheet('Pembetulan');
    if (ws) return ws;
    ws = wb.addWorksheet('Pembetulan', { views: [{ state: 'frozen', ySplit: 4 }] });
    writeKop(ws, { entity: '', title: 'Pembetulan', year: '' });
    ws.getRow(4).values = PB_COLS.map((c) => c[0]);
    styleHeader(ws, PB_COLS, 4);
    return ws;
}
/** Baris bukti potong `number` (dibuat bila belum ada): `always` ditulis selalu, `onCreate` hanya untuk baris baru
 *  (NIK Baru / Nama Baru baris lama berisi rumus ke sheet NIK - jangan ditimpa). */
function upsertSlip(ws, number, always, onCreate = {}) {
    const h = headerMap(ws), col = h.get('Nomor Bukti Potong');
    let row = null;
    ws.eachRow((r, n) => { if (n > H(ws) && !row && str(r.getCell(col).value) === String(number)) row = r; });
    const created = !row;
    if (created) { row = ws.addRow([]); for (const [name, value] of Object.entries({ ...onCreate, 'Nomor Bukti Potong': number })) if (h.has(name)) row.getCell(h.get(name)).value = value; }
    for (const [name, value] of Object.entries(always)) if (h.has(name) && value !== undefined) row.getCell(h.get(name)).value = value;
    for (const name of TEXT_COLS) if (h.has(name)) restyle(row.getCell(h.get(name)), { numFmt: '@' });
    // Baris baru dari cek e-Bupot vs SPT / penyisiran: angka bertitik ribuan seperti baris lainnya.
    for (const name of ['Penghasilan Bruto (Rp)', 'PPh (Rp)']) if (h.has(name)) restyle(row.getCell(h.get(name)), { numFmt: '#,##0' });
    return row;
}
function refreshFilter(ws, cols) { const h = H(ws); ws.autoFilter = { from: { row: h, column: 1 }, to: { row: Math.max(h + 1, ws.rowCount), column: cols } }; }

// ---------- sheet Ringkasan ----------
function ringkasanTable(ws) {
    let headRow = 0;
    ws.eachRow((r, n) => { if (!headRow && str(r.getCell(1).value) === 'Masa') headRow = n; });
    if (!headRow) return null;
    const h = headerMap(ws, headRow), rows = new Map();
    for (let n = headRow + 1; n <= headRow + 12; n++) { const m = str(ws.getRow(n).getCell(1).value); if (MONTHS.includes(m)) rows.set(m, ws.getRow(n)); }
    return { h, rows, headRow };
}
/** Excel lama tanpa sheet Ringkasan: dibuat seadanya (judul + tabel 12 masa) supaya status SPT punya tempat. */
function ensureRingkasan(wb, year) {
    let ws = wb.getWorksheet('Ringkasan');
    if (ws && ringkasanTable(ws)) return ws;
    if (ws) wb.removeWorksheet(ws.id);
    ws = wb.addWorksheet('Ringkasan');
    writeKop(ws, { entity: '', title: 'Ringkasan', year });
    ws.addRow(['']); ws.addRow(['']); ws.addRow([SPT_PENDING + 'belum diperiksa.']); ws.addRow([]);
    ws.addRow(RK_COLS.map((c) => c[0])); styleHeader(ws, RK_COLS, 8);
    MONTHS.forEach((m) => ws.addRow([m]));
    return ws;
}
const colLetter = (n) => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
/** Angka Ringkasan per masa = SUMIFS / COUNTIFS ke sheet Pembetulan (permintaan 2026-11-05: harus bisa ditelusuri, dan
 *  cukup banyaknya - bermasalah berapa, dibetulkan berapa), nilai tersimpan dihitung di sini. "Bermasalah" = semua baris
 *  Pembetulan masa itu; "dibetulkan" = yang kolom Dilaporkan di SPT-nya terisi (hasil cek Coretax: berstatus Pembetulan).
 *  Status SPT Masa kosong sampai pernah diperiksa ke Coretax. */
function refreshRingkasan(wb) {
    const rk = wb.getWorksheet('Ringkasan'), pb = wb.getWorksheet('Pembetulan');
    const t = rk && ringkasanTable(rk);
    if (!t || !pb) return;
    const ph = headerMap(pb), P = (k) => "Pembetulan!$" + colLetter(ph.get(k)) + ':$' + colLetter(ph.get(k));
    if (!ph.has('Dilaporkan di SPT')) return;
    const count = new Map(MONTHS.map((m) => [m, { rows: 0, amended: 0, open: 0 }]));
    pb.eachRow((row, n) => {
        if (n <= H(pb)) return; const c = count.get(str(row.getCell(ph.get('Masa')).value)); if (!c) return;
        c.rows++;
        const rep = str(row.getCell(ph.get('Dilaporkan di SPT')).value); if (rep) c.amended++; if (rep === 'Belum') c.open++;
    });
    const h = t.h, L = (k) => colLetter(h.get(k));
    for (const [m, row] of t.rows) {
        const n = row.number, c = count.get(m), at = (k) => row.getCell(h.get(k)), A = '$A' + n;
        if (h.has('Bukti Potong Bermasalah')) at('Bukti Potong Bermasalah').value = { formula: 'COUNTIFS(' + P('Masa') + ',' + A + ')', result: c.rows };
        if (h.has('Bukti Potong Dibetulkan')) at('Bukti Potong Dibetulkan').value = { formula: 'COUNTIFS(' + P('Masa') + ',' + A + ',' + P('Dilaporkan di SPT') + ',"<>")', result: c.amended };
        if (!h.has('Status SPT Masa')) continue;
        const checked = str(at('Diperiksa').value);
        const status = !checked ? '' : c.open ? 'PERLU pembetulan SPT Masa PPh 21' : c.amended ? 'Sudah dilaporkan di SPT' : 'Tidak ada bukti potong pembetulan';
        const cnt = (v) => 'COUNTIFS(' + P('Masa') + ',' + A + ',' + P('Dilaporkan di SPT') + ',"' + v + '")';
        at('Status SPT Masa').value = { formula: 'IF(' + L('Diperiksa') + n + '="","",IF(' + cnt('Belum') + '>0,"PERLU pembetulan SPT Masa PPh 21",IF(' + cnt('Ya') + '>0,"Sudah dilaporkan di SPT","Tidak ada bukti potong pembetulan")))', result: status };
        restyle(at('Status SPT Masa'), { font: /^PERLU/.test(status) ? { bold: true, color: { argb: 'FFC00000' } } : {} });
    }
    refreshHeadlines(wb);
}
/** Kolom "Catatan Pembetulan" di sebelah tabel lampiran (L-IA, L-IB, L-II, L-III): status bukti potong itu di sheet
 *  Pembetulan, dicari per Nomor Bukti Potong (rumus; nilai tersimpan dihitung di sini). Data SPT di lampiran tetap
 *  apa adanya - catatan ini yang memberi tahu bila bukti potongnya sudah dibetulkan tetapi belum dilaporkan. */
function refreshSlipNotes(wb) {
    const pb = wb.getWorksheet('Pembetulan'); if (!pb) return;
    const ph = headerMap(pb), byNo = new Map();
    const sel = ph.get('Selisih e-Bupot vs SPT');
    pb.eachRow((row, n) => { if (n > H(pb)) byNo.set(str(row.getCell(ph.get('Nomor Bukti Potong')).value), { status: str(row.getCell(ph.get('Status')).value), rep: ph.has('Dilaporkan di SPT') ? str(row.getCell(ph.get('Dilaporkan di SPT')).value) : '', sel: sel ? str(row.getCell(sel).value) : '' }); });
    const S = colLetter(ph.get('Status')), B = colLetter(ph.get('Nomor Bukti Potong')), D = ph.has('Dilaporkan di SPT') ? colLetter(ph.get('Dilaporkan di SPT')) : null, X = sel ? colLetter(sel) : null;
    for (const ws of wb.worksheets) {
        if (!/^L-/.test(ws.name)) continue;
        let head = 0; ws.eachRow((row, n) => { if (!head && n > 5 && str(row.getCell(1).value) === 'Masa') head = n; });
        if (!head) continue;
        const hm = headerMap(ws, head), noCol = [...hm.keys()].find((k) => /NOMOR BUKTI POTONG/i.test(k));
        if (!noCol) continue;
        let noteCol = hm.get('Catatan Pembetulan');
        if (!noteCol) {
            noteCol = Math.max(...hm.values()) + 1;
            const cell = ws.getCell(head, noteCol); cell.value = 'Catatan Pembetulan';
            restyle(cell, { font: { name: 'Arial Narrow', size: 10, bold: true }, fill: solid('FFD3D3D3'), alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } });
            ws.getColumn(noteCol).width = 40;
        }
        const N = colLetter(hm.get(noCol));
        for (let n = head + 1; n <= ws.rowCount; n++) {
            const masa = str(ws.getCell(n, 1).value); if (!MONTHS.includes(masa)) break;
            const ref = N + n, look = (c) => 'INDEX(Pembetulan!$' + c + ':$' + c + ',MATCH(' + ref + ',Pembetulan!$' + B + ':$' + B + ',0))';
            const hit = byNo.get(str(ws.getCell(ref).value));
            // Selisih e-Bupot vs SPT (bila ada dan belum "sudah sama") lebih jelas daripada statusnya.
            const showSel = hit && hit.sel && !/^Sudah sama/.test(hit.sel);
            const result = !hit ? '' : showSel ? hit.sel : (hit.status === 'Draft' || !hit.status ? 'NIK bermasalah — belum dibetulkan' : hit.status) + (hit.rep === 'Belum' ? ' · belum dilaporkan di SPT' : '');
            const base = 'IF(' + look(S) + '="Draft","NIK bermasalah — belum dibetulkan",' + look(S) + ')' + (D ? '&IF(' + look(D) + '="Belum"," · belum dilaporkan di SPT","")' : '');
            const formula = 'IFERROR(' + (X ? 'IF(AND(' + look(X) + '<>"",LEFT(' + look(X) + ',10)<>"Sudah sama"),' + look(X) + ',' + base + ')' : base) + ',"")';
            const cell = ws.getCell(n, noteCol); cell.value = { formula, result };
            restyle(cell, { font: { name: 'Arial Narrow', size: 10, color: { argb: 'FFC00000' } }, alignment: { vertical: 'top', wrapText: false } });
        }
    }
}
/** Kalimat status di baris 3 (NIK di Coretax) dan 4 (SPT Masa), dihitung ulang dari sheet Pembetulan dan tabel masa. */
function refreshHeadlines(wb) {
    const rk = wb.getWorksheet('Ringkasan'), pb = wb.getWorksheet('Pembetulan');
    if (!rk) return;
    const t = ringkasanTable(rk);
    if (pb) {
        const h = headerMap(pb), cek = h.get('Cek Coretax'), nik = h.get('NIK di Bukti Potong'), old = h.get('NIK Lama (dari #)');
        const still = [], stamps = new Set();
        pb.eachRow((r, n) => {
            if (n <= H(pb)) return;
            const v = str(r.getCell(cek).value); if (!v) return;
            const m = /·\s*(.+)$/.exec(v); if (m) stamps.add(m[1]);
            if (/^Masih/.test(v)) still.push(str(r.getCell(old).value) || str(r.getCell(nik).value));
        });
        if (stamps.size) rk.getCell(RK_LINE.nik, 1).value = 'NIK bermasalah di Coretax (dicek ' + [...stamps].sort().pop() + '): '
            + (still.length ? new Set(still).size + ' NIK · ' + still.length + ' bukti potong — sheet Pembetulan, filter Cek Coretax = Masih bermasalah.' : 'tidak ada lagi.');
    }
    if (t && t.h.has('Status SPT Masa')) {
        const s = t.h.get('Status SPT Masa'), pending = [], checked = [];
        for (const [m, row] of t.rows) { const v = str(row.getCell(s).value); if (v) checked.push(m); if (/^PERLU/.test(v)) pending.push(m); }
        if (checked.length) rk.getCell(RK_LINE.spt, 1).value = SPT_PENDING + (pending.length ? pending.join(', ') + '.' : 'tidak ada, semua bukti potong pembetulan sudah dilaporkan di SPT.');
    }
    restyle(rk.getCell(RK_LINE.nik, 1), { font: { bold: true } }); restyle(rk.getCell(RK_LINE.spt, 1), { font: { bold: true, color: { argb: /tidak ada|belum diperiksa/.test(str(rk.getCell(RK_LINE.spt, 1).value)) ? 'FF000000' : 'FFC00000' } } });
}

// ---------- hasil proses ----------
/** Hasil satu proses pembetulan (bpmp-amend run) + pemeriksaan ulang (Map nomor -> BENAR/MASALAH). */
function applyResults(wb, { results, checks, at }) {
    const ws = ensurePembetulan(wb);
    for (const r of results || []) {
        upsertSlip(ws, r.number, { Status: r.status, 'Nama Resmi Coretax': r.coretaxName || '', 'Pemeriksaan Ulang': (checks && checks.get(r.number)) || '', Waktu: stamp(at) },
            { Masa: masaLabel(r.period), 'NIK Lama (dari #)': r.old, 'NIK Baru': r.newNik, 'Nama Baru': r.newName });
    }
    refreshFilter(ws, PB_COLS.length);
}
/** Hasil penyisiran setahun (bpmp-amend sweep): kolom Cek Coretax per bukti potong + status SPT per masa. */
function applySweep(wb, sweep, year) {
    const ws = ensurePembetulan(wb), t = stamp(sweep.checkedAt || new Date());
    const bad = new Map(sweep.problems.map((p) => [String(p.number), p]));
    const h = headerMap(ws), col = h.get('Nomor Bukti Potong');
    ws.eachRow((r, n) => { if (n > H(ws) && str(r.getCell(col).value) && !bad.has(str(r.getCell(col).value))) r.getCell(h.get('Cek Coretax')).value = 'Sudah benar · ' + t; });
    for (const p of sweep.problems) {
        const old = (/#\s*(\d+)\s*$/.exec(p.name) || [])[1] || '';
        upsertSlip(ws, p.number, { 'Cek Coretax': 'Masih bermasalah · ' + t },
            { Masa: masaLabel(p.masa), 'NIK di Bukti Potong': p.nik, 'Nama di Bukti Potong': p.name, 'NIK Lama (dari #)': old, Catatan: p.why, Jenis: 'NIK bermasalah', 'Penghasilan Bruto (Rp)': p.gross, 'PPh (Rp)': p.tax });
    }
    // Semua bukti potong berstatus Pembetulan di Coretax (juga yang dibetulkan di luar Pilot): dilaporkan di SPT atau belum.
    for (const s of sweep.amendedSlips || []) upsertSlip(ws, s.number, { 'Dilaporkan di SPT': s.reported ? 'Ya' : 'Belum' },
        { Masa: masaLabel(s.masa), 'NIK di Bukti Potong': s.nik, 'Nama di Bukti Potong': s.name, Status: 'Pembetulan di Coretax (bukan lewat Pilot)', Jenis: 'Pembetulan di Coretax', 'Penghasilan Bruto (Rp)': s.gross, 'PPh (Rp)': s.tax });
    refreshFilter(ws, PB_COLS.length);
    if (sweep.sptMasa) { const rk = ensureRingkasan(wb, year), tb = ringkasanTable(rk); for (const row of tb.rows.values()) if (tb.h.has('Diperiksa')) row.getCell(tb.h.get('Diperiksa')).value = t; }
    refreshRingkasan(wb);
    refreshSlipNotes(wb);
}

/** Hasil cek e-Bupot vs SPT (lib/ebupot-vs-spt.js): setiap selisih jadi / memperbarui baris Pembetulan (Jenis, Selisih,
 *  Dilaporkan di SPT = Belum - SPT Masa-nya perlu dibetulkan). Baris yang dulu berselisih dan kini sudah sama dengan SPT
 *  ditandai sudah sama dan Dilaporkan di SPT = Ya. */
function applyCompare(wb, cmp) {
    const ws = ensurePembetulan(wb), t = stamp(cmp.checkedAt || new Date()), h = headerMap(ws), col = h.get('Nomor Bukti Potong');
    const byNo = new Map(cmp.diffs.map((d) => [d.number, d]));
    for (const d of cmp.diffs) {
        const row = upsertSlip(ws, d.number, { 'Selisih e-Bupot vs SPT': d.detail + ' · cek ' + t, 'Dilaporkan di SPT': 'Belum' },
            { Masa: masaLabel(d.masa), 'NIK di Bukti Potong': d.nik, 'Nama di Bukti Potong': d.name, 'Kode Objek Pajak': d.kop, 'Penghasilan Bruto (Rp)': d.gross ?? '', 'PPh (Rp)': d.tax ?? '',
                Status: d.kind === 'Batalkan' ? 'Batalkan di Coretax (bruto & PPh 0)' : 'e-Bupot ≠ SPT (' + d.type + ', ' + d.sheet + ')' });
        if (!str(row.getCell(h.get('Jenis')).value)) row.getCell(h.get('Jenis')).value = d.kind === 'Batalkan' ? 'Batalkan' : 'e-Bupot ≠ SPT';
    }
    // Baris yang dulu berselisih: kini sama dengan SPT, atau nomornya diterbitkan ulang (baris nomor baru memuat selisihnya,
    // bila ada), atau bukti potong bernilai 0 yang sudah dibatalkan.
    const replaced = cmp.replaced || new Map();
    ws.eachRow((row, n) => {
        if (n <= H(ws)) return; const no = str(row.getCell(col).value);
        if (byNo.has(no)) return;
        const sel = h.get('Selisih e-Bupot vs SPT'), had = str(row.getCell(sel).value);
        if (!had || /^(Sudah sama|Sudah dibatalkan)/.test(had)) return;
        if (cmp.same.has(no)) { row.getCell(sel).value = (replaced.has(no) ? 'Sudah sama dengan SPT (nomor baru ' + replaced.get(no) + ')' : 'Sudah sama dengan SPT') + ' · cek ' + t; row.getCell(h.get('Dilaporkan di SPT')).value = 'Ya'; }
        else if (replaced.has(no)) row.getCell(sel).value = 'Diterbitkan ulang dengan nomor ' + replaced.get(no) + ' - lihat baris itu · cek ' + t;
        else if (str(row.getCell(h.get('Jenis')).value) === 'Batalkan') row.getCell(sel).value = 'Sudah dibatalkan (tidak lagi di Telah Terbit) · cek ' + t;
    });
    refreshFilter(ws, PB_COLS.length);
    refreshRingkasan(wb); refreshSlipNotes(wb);
}

/** Riwayat dari sheet Pembetulan (atau Hasil Pembetulan Excel lama): NIK lama -> [{at, status, newNik, name, number, masa}]. */
function readPrevious(wb) {
    const out = new Map(), add = (old, e) => { if (!old || !e.status || e.status === 'Draft') return; if (!out.has(old)) out.set(old, []); out.get(old).push(e); };
    const pb = wb.getWorksheet('Pembetulan');
    if (pb) {
        const h = headerMap(pb), v = (r, k) => (h.has(k) ? str(r.getCell(h.get(k)).value) : '');
        pb.eachRow((r, n) => { if (n > H(pb)) add(v(r, 'NIK Lama (dari #)') || v(r, 'NIK di Bukti Potong'), { at: v(r, 'Waktu'), masa: v(r, 'Masa'), number: v(r, 'Nomor Bukti Potong'), newNik: v(r, 'NIK Baru'), name: v(r, 'Nama Resmi Coretax') || v(r, 'Nama Baru'), status: v(r, 'Status') }); });
        return out;
    }
    const old = wb.getWorksheet('Hasil Pembetulan');
    if (old && str(old.getCell(1, 1).value) === 'Waktu') old.eachRow((r, n) => { if (n > 1) { const v = (c) => str(r.getCell(c).value); add(v(4), { at: v(1), masa: v(2), number: v(3), newNik: v(5), name: v(7) || v(6), status: v(8) }); } });
    return out;
}

/** Tulis ke `file` (Excel rekap) lewat file sementara lalu rename, jadi file asli tidak rusak bila gagal di tengah.
 *  Bila `file` sedang terbuka di Excel (terkunci), hasil disimpan di sebelahnya: "<nama> - Hasil Pembetulan.xlsx". */
async function writeReport({ file, newFile, year, results, checks, sweep, compare }) {
    const wb = new ExcelJS.Workbook();
    const target = file || newFile;
    if (file) await wb.xlsx.readFile(file);
    if (results && results.length) applyResults(wb, { results, checks, at: new Date() });
    if (sweep) applySweep(wb, sweep, year); else { refreshRingkasan(wb); refreshSlipNotes(wb); }
    if (compare) applyCompare(wb, compare);
    wb.calcProperties.fullCalcOnLoad = true;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target.replace(/\.xlsx$/i, '') + '.~tmp.xlsx';
    await wb.xlsx.writeFile(tmp);
    try { fs.renameSync(tmp, target); return { file: target, locked: false }; }
    catch (e) {
        if (!/EBUSY|EPERM|EACCES/.test(e.code || '')) { fs.rmSync(tmp, { force: true }); throw e; }
        const beside = target.replace(/\.xlsx$/i, '') + ' - Hasil Pembetulan.xlsx';
        fs.rmSync(beside, { force: true }); fs.renameSync(tmp, beside);
        return { file: beside, locked: true };
    }
}

/** Rekap disusun ulang (konversi, atau Unduh setahun menimpa file yang sama): isian NIK Baru / Nama Baru, status
 *  per bukti potong dan status SPT per masa dari `fromWb` dibawa ke `toWb`. Isian dicocokkan per NIK + NIK lama,
 *  status per Nomor Bukti Potong, status SPT per masa. Mengembalikan jumlah isian yang dibawa. */
function carryOver(fromWb, toWb) {
    // 1. Isian NIK Baru / Nama Baru (sheet NIK, atau BPMP per NIK Excel lama dengan judul kolom di baris 5).
    const nikHead = (ws) => { let h = 0; ws.eachRow((r, n) => { if (!h && n <= 10 && str(r.getCell(1).value) === 'NIK' && str(r.getCell(2).value) === 'Nama') h = n; }); return h; };
    const inputSheet = (wb) => { const ws = wb.getWorksheet('NIK') || wb.getWorksheet('BPMP per NIK'); const head = ws && nikHead(ws); return head ? { ws, head } : null; };
    const src = inputSheet(fromWb), dst = inputSheet(toWb);
    let copied = 0;
    if (src && dst) {
        const sh = headerMap(src.ws, src.head), dh = headerMap(dst.ws, dst.head), key = (r, h) => str(r.getCell(h.get('NIK')).value) + '|' + str(r.getCell(h.get('NIK lama (dari #)')).value);
        const rows = new Map(); dst.ws.eachRow((r, n) => { if (n > dst.head) rows.set(key(r, dh), r); });
        src.ws.eachRow((r, n) => {
            if (n <= src.head) return;
            const nik = text(r.getCell(sh.get('NIK Baru')).value), name = text(r.getCell(sh.get('Nama Baru')).value), d = rows.get(key(r, sh));
            if (!d || ((nik == null || nik === '') && (name == null || name === ''))) return;
            if (nik != null && nik !== '') d.getCell(dh.get('NIK Baru')).value = typeof nik === 'number' ? nik : String(nik);
            if (name != null && name !== '') d.getCell(dh.get('Nama Baru')).value = String(name);
            copied++;
        });
    }
    // 2. Status per bukti potong.
    const pb = ensurePembetulan(toWb);
    const oldPb = fromWb.getWorksheet('Pembetulan');
    if (oldPb) {
        const h = headerMap(oldPb), v = (r, k) => (h.has(k) ? text(r.getCell(h.get(k)).value) ?? '' : '');
        oldPb.eachRow((r, n) => {
            if (n <= H(oldPb) || !str(v(r, 'Nomor Bukti Potong'))) return;
            const status = str(v(r, 'Status')), cek = str(v(r, 'Cek Coretax')), rep = str(v(r, 'Dilaporkan di SPT'));
            if ((!status || status === 'Draft') && !cek && !rep && !str(v(r, 'Selisih e-Bupot vs SPT'))) return;
            const always = { 'Cek Coretax': cek || undefined, 'Dilaporkan di SPT': rep || undefined, Jenis: str(v(r, 'Jenis')) || undefined, 'Selisih e-Bupot vs SPT': str(v(r, 'Selisih e-Bupot vs SPT')) || undefined };
            if (status && status !== 'Draft') Object.assign(always, { Status: status, 'Nama Resmi Coretax': str(v(r, 'Nama Resmi Coretax')), 'Pemeriksaan Ulang': str(v(r, 'Pemeriksaan Ulang')), Waktu: str(v(r, 'Waktu')) });
            const onCreate = {}; for (const [k] of PB_COLS) if (!(k in always)) onCreate[k] = v(r, k);
            upsertSlip(pb, str(v(r, 'Nomor Bukti Potong')), always, onCreate);
        });
    }
    const hist = fromWb.getWorksheet('Hasil Pembetulan');
    if (hist && str(hist.getCell(1, 1).value) === 'Waktu') hist.eachRow((r, n) => {
        if (n < 2) return; const v = (c) => str(r.getCell(c).value); if (!v(3)) return;
        upsertSlip(pb, v(3), { Status: v(8), 'Nama Resmi Coretax': v(7), 'Pemeriksaan Ulang': v(9), Waktu: v(1) }, { Masa: v(2), 'NIK Lama (dari #)': v(4), 'NIK Baru': v(5), 'Nama Baru': v(6) });
    });
    const rest = fromWb.getWorksheet('Sisa NIK Bermasalah');
    if (rest && str(rest.getCell(1, 1).value) === 'Diperiksa') {
        const still = new Map(); let when = '';
        rest.eachRow((r, n) => { if (n < 2) return; const v = (c) => str(r.getCell(c).value); when = when || v(1); if (v(4)) still.set(v(4), { nik: v(2), name: v(3), number: v(4), masa: v(5), why: v(6) }); });
        if (when) {
            const h = headerMap(pb), col = h.get('Nomor Bukti Potong');
            pb.eachRow((r, n) => { if (n > H(pb) && str(r.getCell(col).value) && !still.has(str(r.getCell(col).value))) r.getCell(h.get('Cek Coretax')).value = 'Sudah benar · ' + when; });
            for (const p of still.values()) upsertSlip(pb, p.number, { 'Cek Coretax': 'Masih bermasalah · ' + when },
                { Masa: p.masa, 'NIK di Bukti Potong': p.nik, 'Nama di Bukti Potong': p.name, 'NIK Lama (dari #)': (/#\s*(\d+)\s*$/.exec(p.name) || [])[1] || '', Catatan: p.why });
        }
    }
    refreshFilter(pb, PB_COLS.length);
    // 3. Status SPT per masa (Ringkasan, atau Status SPT Masa / Kontrol Excel lama): tanggal periksa dan catatan dibawa;
    //    angkanya dihitung ulang dengan COUNTIFS (refreshRingkasan). Excel lama tanpa kolom Dilaporkan di SPT per bukti
    //    potong: bila jumlah per masanya pasti (semua belum / semua sudah dilaporkan), kolom itu diisi dari situ.
    const rk = toWb.getWorksheet('Ringkasan'), dt = rk && ringkasanTable(rk);
    if (dt) {
        const oldRk = fromWb.getWorksheet('Ringkasan'), st = oldRk && ringkasanTable(oldRk), oldSpt = fromWb.getWorksheet('Status SPT Masa'), oldK = fromWb.getWorksheet('Kontrol');
        const ph = headerMap(pb), anyRep = (() => { let a = false; pb.eachRow((r, n) => { if (n > H(pb) && str(r.getCell(ph.get('Dilaporkan di SPT')).value)) a = true; }); return a; })();
        for (const [m, row] of dt.rows) {
            let amended = null, open = null, when = '', note = '', oldRev = null;
            if (st && st.rows.has(m)) { const o = st.rows.get(m), g = (k) => (st.h.has(k) ? text(o.getCell(st.h.get(k)).value) : ''); amended = g('Bukti Potong Dibetulkan'); open = g('Belum Dilaporkan di SPT'); when = str(g('Diperiksa')); note = str(g('Catatan')); oldRev = g('Pembetulan Terakhir (0 = normal)'); }
            else if (oldSpt) oldSpt.eachRow((r, n) => { if (n > 1 && str(r.getCell(2).value) === m) { amended = text(r.getCell(3).value); open = text(r.getCell(4).value); when = str(r.getCell(1).value); } });
            if (oldRev == null && oldK) oldK.eachRow((r, n) => { if (n > 4 && str(r.getCell(1).value) === m) oldRev = text(r.getCell(2).value); });
            if (when && dt.h.has('Diperiksa')) row.getCell(dt.h.get('Diperiksa')).value = when;
            // Versi SPT berubah sejak rekap sebelumnya: dicatat.
            const newRev = text(row.getCell(dt.h.get('Pembetulan Terakhir (0 = normal)')).value);
            const changed = oldRev !== null && oldRev !== '' && newRev !== '' && newRev != null && String(oldRev) !== String(newRev)
                ? 'Versi SPT berubah: ' + (+oldRev ? 'Pembetulan ' + oldRev : 'Normal') + ' → ' + (+newRev ? 'Pembetulan ' + newRev : 'Normal') + ' (rekap ' + stamp(new Date()) + ').' : '';
            if (dt.h.has('Catatan')) row.getCell(dt.h.get('Catatan')).value = [note, changed].filter(Boolean).join(' ');
            if (!anyRep && Number(amended) > 0) {
                const rows = []; pb.eachRow((r, n) => { if (n > H(pb) && str(r.getCell(ph.get('Masa')).value) === m && /^DIBETULKAN|^Pembetulan di Coretax/.test(str(r.getCell(ph.get('Status')).value))) rows.push(r); });
                const val = Number(open) === Number(amended) ? 'Belum' : Number(open) === 0 ? 'Ya' : null;
                if (val && rows.length === Number(amended)) rows.forEach((r) => { r.getCell(ph.get('Dilaporkan di SPT')).value = val; });
            }
        }
    }
    // 4. Isian Draft SPT Desember (lib/a1-desember.js), per NIK.
    require('./a1-desember').carryDraft(fromWb, toWb);
    // 5. NIK Baru / Nama Baru di sheet Pembetulan adalah rumus ke sheet NIK; nilai tersimpannya dihitung sebelum isian
    //    dibawa, jadi diperbarui di sini (Excel juga menghitung ulang saat dibuka - fullCalcOnLoad).
    const nikWs = toWb.getWorksheet('NIK');
    if (nikWs) pb.eachRow((r, n) => {
        if (n <= H(pb)) return;
        r.eachCell((c) => { const v = c.value, m = v && v.formula && /'NIK'!\$([A-Z]+)\$(\d+)/.exec(v.formula); if (m) c.value = { formula: v.formula, result: text(nikWs.getCell(m[1] + m[2]).value) ?? '' }; });
    });
    refreshRingkasan(toWb);
    refreshSlipNotes(toWb);
    refreshHeadlines(toWb);
    toWb.calcProperties.fullCalcOnLoad = true;
    return copied;
}

module.exports = { PB_COLS, RK_COLS, RK_LINE, writeKop, properName, detectHead, readPrevious, writeReport, applyResults, applySweep, applyCompare, carryOver, refreshHeadlines, refreshRingkasan, refreshSlipNotes, stamp, headerMap };
