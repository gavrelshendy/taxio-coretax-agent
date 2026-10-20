/* Lampiran tables too large for a PDF form (Badan L3 with 58.914 rows, live 2026-10-20: the headless
 * renderer ran out of memory laying out ~470.000 cells, in PDF and PER-11 Excel alike).
 *
 * Rule (chosen by the user 2026-10-20): Ringkas prints 50 rows per table, Lengkap every row - up to
 * BIG_ROWS (1.000, about 26 pages). A larger table is printed like Ringkas in both modes: its first
 * SHOWN_ROWS (50) rows, a note "Ditampilkan 50 dari N baris" and a JUMLAH line that still covers every
 * row; every row goes to a separate "daftar lengkap" Excel file, written here straight from the rows
 * (no browser).
 *
 * Only tables whose rows are known as data (the grid-API path, lib/lampiran-capture.js
 * collectTabFromRows) can be split; a table read page by page stays as it is. */
const ExcelJS = require('exceljs');
const idNumber = require('./id-number');

const BIG_ROWS = 1000;
const SHOWN_ROWS = 50;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Cents (BigInt) of a number as Coretax prints it ("1.234.567", "-12,50", "(1.000)"), else null -
 *  the same reading as lib/lampiran-finalize.js amount(). */
function amount(text) {
    let s = clean(text).replace(/^Rp\.?\s*/i, '').replace(/\s/g, '');
    if (!s || s === '-' || s === '–') return null;
    const negative = /^\(.*\)$/.test(s); if (negative) s = s.slice(1, -1);
    if (!/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(s)) return null;
    s = s.replace(/\./g, '');
    const sign = s.startsWith('-') || negative ? -1n : 1n;
    const [a, b = ''] = s.replace(/^-/, '').split(',');
    return sign * (BigInt(a) * 100n + BigInt(b.padEnd(2, '0')));
}
/** Cents as lib/lampiran-finalize.js format() prints them: "1.234.567", "-12,50". */
function format(cents) {
    const neg = cents < 0n, v = neg ? -cents : cents;
    return (neg ? '-' : '') + idNumber.money(String(v / 100n)) + (v % 100n ? ',' + String(v % 100n).padStart(2, '0') : '');
}
/** Column index -> formatted sum, for every column whose filled cells are all numbers. */
function columnTotals(rows) {
    const width = Math.max(0, ...rows.map((r) => r.length)), totals = {};
    for (let c = 0; c < width; c++) {
        let sum = 0n, any = false, ok = true;
        for (const r of rows) {
            const text = clean(r[c]);
            if (!text) continue;
            const v = amount(text);
            if (v === null) { ok = false; break; }
            sum += v; any = true;
        }
        if (ok && any) totals[c] = format(sum);
    }
    return totals;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cuts every table over BIG_ROWS down to its first SHOWN_ROWS rows (fullCount / fullTotals tell the
 *  renderer the real size and totals) and drops the row data from all tables, which the renderer does
 *  not need. Returns the full lists: [{ label, index, headers, rows }]. */
function splitBigTables(tabs) {
    const lists = [];
    for (const tab of tabs) {
        for (const t of tab.tables || []) {
            const rows = t.rows, headers = t.headers;
            delete t.rows; delete t.headers;
            if (!Array.isArray(rows) || rows.length <= BIG_ROWS) continue;
            t.fullCount = rows.length;
            t.fullTotals = columnTotals(rows);
            t.bodies = [rows.slice(0, SHOWN_ROWS).map((r) => '<tr>' + r.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('')];
            t.collectedRows = SHOWN_ROWS;
            lists.push({ label: tab.label, index: t.index, headers: headers || [], rows, totals: t.fullTotals });
        }
    }
    return lists;
}

/** One table's every row as an .xlsx: a short kop, the headings, the rows (numbers as numbers, dates
 *  as dates, identifiers as text) and a JUMLAH line. Streamed, so 60.000 rows take seconds. */
async function writeFullList(file, list, meta) {
    const { typed } = require('./lampiran-export');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true });
    const ws = wb.addWorksheet(String(list.label).slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });
    // Leaf headings carry the column filter's placeholder ("KELOMPOK/JENIS HARTA - Pilih KELOMPOK/JENIS HARTA").
    const headers = (list.headers.length ? list.headers : (list.rows[0] || []).map((_, i) => 'Kolom ' + (i + 1)))
        .map((h) => String(h).split(' - ').filter((part, i) => i === 0 || !/^(Silakan )?Pilih\b/i.test(part.trim())).join(' - '));
    const money = headers.map((h, c) => list.totals[c] !== undefined && !/^NO\.?$|NPWP|NIK|NOMOR|KODE|TANGGAL/i.test(h));
    ws.columns = headers.map((h, c) => ({ width: Math.min(60, Math.max(12, clean(h).length + 2, money[c] ? 18 : 0)) }));
    ws.addRow([meta.title + ' - Lampiran ' + list.label + ' (daftar lengkap)']).font = { bold: true, size: 12 };
    ws.addRow([meta.entity + (meta.entityNpwp ? ' · NPWP ' + meta.entityNpwp : '') + (meta.period ? ' · ' + meta.period : '')]);
    ws.addRow([idNumber.money(list.rows.length) + ' baris (lebih dari ' + idNumber.money(BIG_ROWS) + '). PDF lampiran memuat ' + idNumber.money(SHOWN_ROWS) + ' baris pertama; file ini memuat seluruhnya.']);
    ws.addRow([]);
    const head = ws.addRow(headers.map(clean));
    head.font = { bold: true }; head.alignment = { wrapText: true, vertical: 'middle' };
    head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; cell.border = { bottom: { style: 'thin' } }; });
    head.commit();
    // Money cells are read exactly as the totals are (amount(): also "(10)" = -10), so rows add up to JUMLAH.
    const value = (text, c) => { if (money[c]) { const v = amount(text); if (v !== null) return Number(v) / 100; } return typed(text ?? '', clean(headers[c]), money[c]); };
    for (const r of list.rows) {
        const row = ws.addRow(headers.map((h, c) => value(r[c], c)));
        headers.forEach((h, c) => { if (money[c]) row.getCell(c + 1).numFmt = '#,##0.##'; else if (/TANGGAL/i.test(h)) row.getCell(c + 1).numFmt = 'dd-mm-yyyy'; });
        row.commit();
    }
    const total = ws.addRow(headers.map((h, c) => c === 0 ? 'JUMLAH (' + idNumber.money(list.rows.length) + ' BARIS)' : money[c] ? value(list.totals[c], c) : ''));
    total.font = { bold: true };
    headers.forEach((h, c) => { if (money[c]) total.getCell(c + 1).numFmt = '#,##0.##'; });
    total.commit();
    await wb.commit();
    return file;
}

module.exports = { BIG_ROWS, SHOWN_ROWS, amount, format, columnTotals, splitBigTables, writeFullList };
