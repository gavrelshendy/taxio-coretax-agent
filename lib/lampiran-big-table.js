/* Lampiran tables too large for a PDF form (Badan L3 with 58.914 rows, live 2026-10-20: the headless
 * renderer ran out of memory laying out ~470.000 cells, in PDF and PER-11 Excel alike).
 *
 * Rule (user 2026-10-20/21): Ringkas prints 50 rows per table, Lengkap every row - at most BIG_ROWS
 * (1.000, about 26 pages). A larger table prints its first rows (Lengkap 1.000, Ringkas 50), a note
 * "Ditampilkan baris 1–1.000 dari N baris" and a JUMLAH line that still covers every row. Every row goes into the lampiran's own Excel workbook as an extra sheet ("L3 lengkap"), not
 * a separate file (user 2026-10-21: one Excel, complete) - that workbook is made even when only the
 * PDF was asked for.
 *
 * Only tables whose rows are known as data (API path, or page-by-page with their cell texts) are split. */
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

/** Cuts every table over BIG_ROWS down to its first SHOWN_ROWS rows (fullCount / fullTotals / fullSheet
 *  tell the renderer the real size, totals and where the rest is) and drops the row data from all
 *  tables. Returns the full lists: [{ label, index, sheetName, headers, rows, totals }]. */
function splitBigTables(tabs, shownRows = SHOWN_ROWS) {
    const lists = [];
    for (const tab of tabs) {
        const big = (tab.tables || []).filter((t) => Array.isArray(t.rows) && t.rows.length > BIG_ROWS);
        for (const t of tab.tables || []) {
            const rows = t.rows, headers = t.headers;
            delete t.rows; delete t.headers;
            if (!big.includes(t)) continue;
            // Excel sheet names: at most 31 characters, one per big table ("L9 tabel 2 lengkap").
            const sheetName = (tab.label + (big.length > 1 ? ' tabel ' + (t.index + 1) : '') + ' lengkap').replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
            t.fullCount = rows.length;
            t.fullTotals = columnTotals(rows);
            t.fullSheet = sheetName;
            t.bodies = [rows.slice(0, shownRows).map((r) => '<tr>' + r.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('')];
            t.collectedRows = shownRows;
            lists.push({ label: tab.label, index: t.index, sheetName, headers: headers || [], rows, totals: t.fullTotals, shown: shownRows });
        }
    }
    return lists;
}

/** One table's every row as a sheet of workbook `wb` (ExcelJS): a short kop, the headings with a NO.
 *  column, the rows (numbers as numbers, dates as dates, identifiers as text) and a JUMLAH line. */
function addFullListSheet(wb, list, meta) {
    const { typed } = require('./lampiran-export');
    const ws = wb.addWorksheet(list.sheetName, { views: [{ state: 'frozen', ySplit: 5 }] });
    // Leaf headings carry the column filter's placeholder ("KELOMPOK/JENIS HARTA - Pilih KELOMPOK/JENIS HARTA").
    const raw = (list.headers.length ? list.headers : (list.rows[0] || []).map((_, i) => 'Kolom ' + (i + 1)))
        .map((h) => clean(String(h).split(' - ').filter((part, i) => i === 0 || !/^(Silakan )?Pilih\b/i.test(part.trim())).join(' - ')));
    const numbered = /^NO\.?$/i.test(raw[0] || '');
    const headers = numbered ? raw : ['NO.'].concat(raw);
    const shift = numbered ? 0 : 1;
    const money = headers.map((h, c) => c >= shift && list.totals[c - shift] !== undefined && !/^NO\.?$|NPWP|NIK|NOMOR|KODE|TANGGAL/i.test(h));
    headers.forEach((h, c) => {
        const col = ws.getColumn(c + 1);
        col.width = c === 0 ? 9 : Math.min(60, Math.max(12, h.length + 2, money[c] ? 18 : 0));
        if (money[c]) col.numFmt = '#,##0.##'; else if (/TANGGAL/i.test(h)) col.numFmt = 'dd-mm-yyyy';
    });
    ws.addRow([meta.title + ' - Lampiran ' + list.label + ' (seluruh baris)']).font = { bold: true, size: 12 };
    ws.addRow([meta.entity + (meta.entityNpwp ? ' · NPWP ' + meta.entityNpwp : '') + (meta.period ? ' · ' + meta.period : '')]);
    ws.addRow([idNumber.money(list.rows.length) + ' baris (lebih dari ' + idNumber.money(BIG_ROWS) + '): PDF dan sheet formulir memuat baris 1–' + idNumber.money(list.shown || SHOWN_ROWS) + '; sheet ini memuat seluruhnya.']);
    ws.addRow([]);
    const head = ws.addRow(headers);
    head.font = { bold: true }; head.alignment = { wrapText: true, vertical: 'middle' };
    head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; cell.border = { bottom: { style: 'thin' } }; });
    // Money cells are read exactly as the totals are (amount(): also "(10)" = -10), so rows add up to JUMLAH.
    const value = (text, c) => { if (money[c]) { const v = amount(text); if (v !== null) return Number(v) / 100; } return typed(text ?? '', headers[c], money[c]); };
    list.rows.forEach((r, n) => ws.addRow(headers.map((h, c) => (c < shift ? n + 1 : value(r[c - shift], c)))));
    const total = ws.addRow(headers.map((h, c) => (c === 0 ? 'JUMLAH (' + idNumber.money(list.rows.length) + ' BARIS)' : money[c] ? value(list.totals[c - shift], c) : '')));
    total.font = { bold: true };
    return ws;
}

module.exports = { BIG_ROWS, SHOWN_ROWS, amount, format, columnTotals, splitBigTables, addFullListSheet };
