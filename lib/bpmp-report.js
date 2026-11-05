/* Laporan Pembetulan NIK BPMP di dalam Excel rekap Mode A1 itu sendiri (permintaan 2026-11-05):
 *   "Hasil Pembetulan"     - riwayat per bukti potong, ditambah setiap kali kirim; dibaca lagi oleh
 *                            automation/bpmp-amend.js readTargets supaya proses berikutnya tahu mana yang sudah.
 *   "Sisa NIK Bermasalah"  - hasil penyisiran setahun terakhir (diganti setiap kali).
 *   "Status SPT Masa"      - per masa: bukti potong pembetulan yang belum dilaporkan di SPT (diganti setiap kali).
 * Tanpa sel gabungan (Ctrl+Space harus bisa memilih kolom); judul kolom di baris 1, dengan filter. */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HISTORY = 'Hasil Pembetulan', REMAINING = 'Sisa NIK Bermasalah', SPT = 'Status SPT Masa';
const HISTORY_COLS = [['Waktu', 17], ['Masa', 11], ['Nomor Bukti Potong', 18], ['NIK Lama', 19], ['NIK Baru', 19], ['Nama di Excel', 30], ['Nama Resmi Coretax', 30], ['Status', 46], ['Pemeriksaan Ulang', 46]];
const text = (v) => v && typeof v === 'object' ? ('result' in v ? v.result : v.richText ? v.richText.map((r) => r.text).join('') : v.text) : v;
const pad = (n) => String(n).padStart(2, '0');
// Tanpa Intl: Node di exe tidak membawa data lokal Indonesia (lib/id-number.js).
const stamp = (d) => pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const masaLabel = (code) => MONTHS[+String(code).slice(0, 2) - 1] || String(code);

/** Riwayat dari sheet "Hasil Pembetulan": NIK lama -> [{at, status, newNik, name, number, masa}]. */
function readPrevious(wb) {
    const out = new Map(), ws = wb.getWorksheet(HISTORY);
    if (!ws || String(text(ws.getCell(1, 1).value)) !== 'Waktu') return out;
    ws.eachRow((row, n) => {
        if (n < 2) return;
        const v = (c) => String(text(row.getCell(c).value) ?? '').trim();
        const old = v(4); if (!old) return;
        if (!out.has(old)) out.set(old, []);
        out.get(old).push({ at: v(1), masa: v(2), number: v(3), newNik: v(5), name: v(7) || v(6), status: v(8), check: v(9) });
    });
    return out;
}

function styleHeader(ws, widths) {
    const head = ws.getRow(1);
    head.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
}
function freshSheet(wb, name, cols) {
    const old = wb.getWorksheet(name); if (old) wb.removeWorksheet(old.id);
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map((c) => c[0]));
    styleHeader(ws, cols.map((c) => c[1]));
    return ws;
}
const textCols = (row, cols) => cols.forEach((c) => { row.getCell(c).numFmt = '@'; });

/** Menambah hasil satu proses ke `wb`. results: dari bpmp-amend run(); checks: Map nomor -> BENAR/MASALAH;
 *  sweep: hasil bpmp-amend sweep() (boleh null bila penyisiran gagal). */
function addToWorkbook(wb, { year, at, results, checks, sweep }) {
    let ws = wb.getWorksheet(HISTORY);
    if (!ws) { ws = wb.addWorksheet(HISTORY); ws.addRow(HISTORY_COLS.map((c) => c[0])); styleHeader(ws, HISTORY_COLS.map((c) => c[1])); }
    for (const r of results || []) {
        const row = ws.addRow([stamp(at), masaLabel(r.period), r.number, r.old, r.newNik, r.newName, r.coretaxName || '', r.status, (checks && checks.get(r.number)) || '']);
        textCols(row, [3, 4, 5]);
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, ws.rowCount), column: HISTORY_COLS.length } };
    if (!sweep) return;
    const checked = stamp(sweep.checkedAt || at);
    const rem = freshSheet(wb, REMAINING, [['Diperiksa', 17], ['NIK', 19], ['Nama', 40], ['Nomor Bukti Potong', 18], ['Masa', 11], ['Alasan', 40]]);
    if (!sweep.problems.length) rem.addRow([checked, '', 'Tidak ada NIK bermasalah lagi (' + sweep.total + ' BPMP Telah Terbit ' + year + ' diperiksa).']);
    for (const p of sweep.problems) textCols(rem.addRow([checked, p.nik, p.name, p.number, masaLabel(p.masa), p.why]), [2, 4]);
    rem.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, rem.rowCount), column: 6 } };
    if (!sweep.sptMasa) return;
    const spt = freshSheet(wb, SPT, [['Diperiksa', 17], ['Masa', 11], ['Bukti Potong Dibetulkan', 14], ['Belum Dilaporkan di SPT', 14], ['Status', 46]]);
    const byMasa = new Map((sweep.sptMasa || []).map((m) => [m.masa, m]));
    MONTHS.forEach((name, i) => {
        const m = byMasa.get(pad(i + 1));
        spt.addRow([checked, name, m ? m.amended : 0, m ? m.notReported : 0,
            !m ? 'Tidak ada bukti potong pembetulan' : m.notReported ? 'PERLU pembetulan SPT Masa PPh 21' : 'Sudah dilaporkan di SPT']);
        if (m && m.notReported) spt.lastRow.getCell(5).font = { bold: true, color: { argb: 'FFC00000' } };
    });
    spt.autoFilter = { from: { row: 1, column: 1 }, to: { row: 13, column: 5 } };
}

/** Tulis ke `file` (Excel rekap). Lewat file sementara lalu rename, jadi file asli tidak rusak bila gagal di tengah.
 *  Bila `file` sedang terbuka di Excel (terkunci), hasil disimpan di sebelahnya: "<nama> - Hasil Pembetulan.xlsx". */
async function writeReport({ file, newFile, year, results, checks, sweep }) {
    const wb = new ExcelJS.Workbook();
    const target = file || newFile;
    if (file) await wb.xlsx.readFile(file);
    addToWorkbook(wb, { year, at: new Date(), results, checks, sweep });
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

/** Untuk konversi ke format terbaru (lib/a1-import.js): bawa isian NIK Baru / Nama Baru dan ketiga sheet laporan
 *  dari Excel lama ke Excel baru. Isian dicocokkan per baris NIK + NIK lama, bukan per nomor baris. */
function carryOver(fromWb, toWb) {
    const inputs = (wb) => {
        const ws = wb.getWorksheet('BPMP per NIK'), map = new Map();
        if (!ws) return { ws, map };
        ws.eachRow((row, n) => { if (n >= 6) map.set(String(text(row.getCell(1).value) || '').trim() + '|' + String(text(row.getCell(3).value) || '').trim(), row); });
        return { ws, map };
    };
    const from = inputs(fromWb), to = inputs(toWb);
    let copied = 0;
    for (const [key, row] of from.map) {
        const nik = text(row.getCell(4).value), name = text(row.getCell(5).value), dest = to.map.get(key);
        if (!dest || (nik == null || nik === '') && (name == null || name === '')) continue;
        if (nik != null && nik !== '') { dest.getCell(4).value = typeof nik === 'number' ? nik : String(nik); }
        if (name != null && name !== '') dest.getCell(5).value = String(name);
        copied++;
    }
    for (const name of [HISTORY, REMAINING, SPT]) {
        const src = fromWb.getWorksheet(name); if (!src) continue;
        const old = toWb.getWorksheet(name); if (old) toWb.removeWorksheet(old.id);
        const ws = toWb.addWorksheet(name);
        src.eachRow({ includeEmpty: false }, (row) => { const r = ws.addRow(row.values.slice(1).map(text)); row.eachCell((c, i) => { r.getCell(i).numFmt = c.numFmt; r.getCell(i).font = c.font; }); });
        styleHeader(ws, src.columns.map((c) => c.width || 15));
        if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: ws.rowCount, column: ws.columnCount } };
    }
    toWb.calcProperties.fullCalcOnLoad = true;
    return copied;
}

module.exports = { readPrevious, writeReport, addToWorkbook, carryOver, stamp };
