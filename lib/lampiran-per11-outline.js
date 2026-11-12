/* PER-11 fill (lib/lampiran-per11-fill.js): outline lists (L9) - groups filled in order, their
 * numbering and summary lines. */
// Runs in Node: numbers go through lib/id-number.js, because the exe's Node has no Indonesian locale
// data and toLocaleString('id-ID') would print computed totals as "1,234,567".
const idNumber = require('./id-number');
const { norm, textOf, MONEY_PREFIX, index, rowsOf, restyle, mark, shiftRows } = require('./lampiran-per11-sheet');
const { findTables, isTotalRow, columnMap, setText, looksNumeric, omittedText, noteStyle } = require('./lampiran-per11-tables');

/* ---------------------------------------------------------------- outline lists (L9) */
const numbersCellsOf = (sheet, ix, table) => table.cols.map((col) => ix.at.get(table.numbersRow + ':' + col.col));

/** L9 is one table with an outline - I. HARTA BERWUJUD > A. Kelompok 1 > "1. ......" - where each
 *  "1. ......" line stands for that group's assets. Coretax gives one table per group, in the
 *  outline's order, so group k fills placeholder k; a group with no assets keeps its heading only. */
function fillOutline(sheet, modelTables, unplaced, limit) {
    const ix = index(sheet);
    const table = findTables(sheet, ix)[0];
    if (!table) return false;
    const placeholders = [];
    for (let r = table.first; r <= sheet.rows.length; r++) if (ix.rowCells(r).some((c) => /^1\.\s*[….]{3,}/.test(textOf(c).trim()))) placeholders.push(r);
    if (placeholders.length < 3) return false;
    const groups = modelTables.filter((m) => m.headers && m.headers.length >= table.cols.length - 1);
    if (groups.length !== placeholders.length) unplaced.push('L9: ' + groups.length + ' kelompok Coretax untuk ' + placeholders.length + ' baris kelompok di formulir');
    // A clean record row: the numbers-row cell of each column, unshaded, boxed.
    const numbersCells = table.cols.map((col) => ix.at.get(table.numbersRow + ':' + col.col));
    const rowStyle = (k) => restyle(sheet, numbersCells[k][4], { bg: null, bold: false, h: 'left', v: 'middle' });
    // The outline's own heading lines ("B. Kelompok 2", "II. KELOMPOK BANGUNAN") print as tight
    // as a record row, not at the template's looser spacing.
    // Each group heading reads as a divider: a shaded, bold line with a rule above it - darker for
    // the main groups (I., II., III.), lighter for their Kelompok lines (A.-E.).
    for (let r = table.first; r <= sheet.rows.length; r++) {
        if (placeholders.includes(r)) continue;
        const cells = ix.rowCells(r).filter((c) => c[1] >= table.left && c[1] <= table.right);
        const mark = cells.find((c) => /^([A-E]|I{1,3}|IV|V)\.$/.test(textOf(c).trim()));
        if (!mark) continue;
        const main = /^(I{1,3}|IV|V)\.$/.test(textOf(mark).trim());
        sheet.rows[r - 1] = Math.min(sheet.rows[r - 1], 15);
        if (cells.some((c) => c[2] > 1)) continue;
        const line = (ix.style(numbersCellsOf(sheet, ix, table)[0]).border.find(Boolean) || ['thin', '#000000'])[1];
        const label = cells.filter((c) => c[1] > mark[1]).map(textOf).join(' ').trim();
        const base = restyle(sheet, mark[4], { bg: main ? '#DCDCDC' : '#EFEFEF', bold: true, border: [['thin', line], ['thin', line], ['thin', line], ['thin', line]], h: 'left', v: 'middle', indent: main ? 0 : 2, wrap: false });
        sheet.cells = sheet.cells.filter((c) => !(c[0] === r && c[1] >= table.left && c[1] <= table.right));
        sheet.cells.push([r, table.left, 1, table.right - table.left + 1, base, textOf(mark).trim() + '  ' + label]);
    }
    for (let g = placeholders.length - 1; g >= 0; g--) {
        const p = placeholders[g];
        let rows = (groups[g] && groups[g].rows || []).filter((row) => !isTotalRow(row));
        // fullCount: the group was cut down before rendering (over 1.000 rows, lib/lampiran-big-table.js).
        const all = Math.max(rows.length, (groups[g] && groups[g].fullCount) || 0);
        const big = groups[g] && groups[g].fullCount ? groups[g].fullSheet || true : false;
        if (limit && rows.length > limit) rows = rows.slice(0, limit);
        const map = groups[g] ? columnMap(table, groups[g].headers) : [];
        sheet.cells = sheet.cells.filter((c) => !(c[0] === p && c[1] >= table.left && c[1] <= table.right));
        if (!rows.length) { shiftRows(sheet, p, -1); continue; }
        if (rows.length > 1) shiftRows(sheet, p + 1, rows.length - 1);
        rows.forEach((row, i) => {
            table.cols.forEach((col, k) => {
                const cell = [p + i, col.col, 1, col.right - col.col + 1, rowStyle(k), ''];
                sheet.cells.push(cell);
                const v = map[k] == null ? '' : row[map[k]];
                const head = norm(col.head);
                const align = /KODE|BULAN|TAHUN PEROLEHAN|METODE/.test(head) && !/BIAYA|NILAI|PENYUSUTAN AMORTISASI FISKAL/.test(head) ? 'center' : looksNumeric(v) ? 'right' : 'left';
                setText(sheet, cell, String(v == null ? '' : v).replace(MONEY_PREFIX, ''), { align });
            });
            sheet.rows[p + i - 1] = 16;
        });
        let after = p + rows.length;
        if (all > rows.length) {
            shiftRows(sheet, after, 1);
            sheet.cells.push([after, table.left, 1, table.right - table.left + 1, noteStyle(sheet, numbersCells[0][4]), omittedText(all, rows.length, big)]);
            sheet.rows[after - 1] = 14;
            after++;
        }
        // Each group closes with its own JUMLAH (user 2026-10-21: a total per section), over every row of
        // the group - Coretax's figure for a group cut down for size.
        const totals = (groups[g] && groups[g].totals) || {};
        const values = table.cols.map((col, k) => (map[k] == null ? '' : String(totals[map[k]] ?? '').replace(MONEY_PREFIX, '').trim()));
        const firstValue = values.findIndex(Boolean);
        if (firstValue > 0) {
            shiftRows(sheet, after, 1);
            const totalStyle = (k, align) => restyle(sheet, numbersCells[k][4], { bg: '#EFEFEF', bold: true, h: align, v: 'middle', wrap: false });
            const label = [after, table.left, 1, table.cols[firstValue - 1].right - table.left + 1, totalStyle(0, 'left'), ''];
            sheet.cells.push(label);
            setText(sheet, label, 'JUMLAH (' + idNumber.money(all) + ' BARIS)', { align: 'left', bold: 'keep', wrap: false });
            table.cols.forEach((col, k) => {
                if (k < firstValue) return;
                const cell = [after, col.col, 1, col.right - col.col + 1, totalStyle(k, 'right'), ''];
                sheet.cells.push(cell);
                setText(sheet, cell, values[k], { align: 'right', bold: 'keep', wrap: false });
            });
            sheet.rows[after - 1] = 16;
        }
    }
    return true;
}

/** L9 has no NO. column; its records get one (user 2026-10-21: "nomor urutnya mana?") so a printed
 *  row can be found again in the Excel's full list. The first column (KODE HARTA) is wide enough to
 *  give up its first grid column: NO. there, KODE HARTA in the rest - the other columns and the form's
 *  (1)..(9) numbering stay as they are. Numbers restart at 1 in every group, as the notes count them. */
function numberOutline(sheet) {
    const ix = index(sheet);
    const table = findTables(sheet, ix)[0];
    if (!table || table.cols[0].right - table.cols[0].col < 1) return;
    const first = table.cols[0];
    const rows = rowsOf(sheet);
    // Splits a cell covering the first column into a one-column cell (returned) and the rest.
    const split = (cell, text) => {
        const lead = [cell[0], first.col, cell[2], 1, cell[4], text];
        cell[1] = first.col + 1; cell[3] = first.right - first.col;
        sheet.cells.push(lead);
        return lead;
    };
    // Headings: the KODE HARTA heading cell(s) above the column numbers, and the "(1)" cell.
    for (const c of sheet.cells.slice()) {
        if (c[0] > table.numbersRow || c[0] + c[2] - 1 < (table.headRows[0] || table.numbersRow) || c[1] !== first.col || c[1] + c[3] - 1 !== first.right) continue;
        const lead = split(c, '');
        if (c[0] < table.numbersRow && /KODE/i.test(textOf(c))) setText(sheet, lead, 'NO.', { align: 'center', bold: 'keep', wrap: false });
    }
    // Records: a row with a cell at the start of every column, as fillOutline lays them out.
    let n = 0;
    for (let r = table.numbersRow + 1; r <= sheet.rows.length; r++) {
        const cells = rows.raw(r);
        if (cells.some((c) => c[1] <= first.col && c[1] + c[3] - 1 >= table.right)) { n = 0; continue; } // a group heading or a note
        const lead = cells.find((c) => c[1] === first.col && c[1] + c[3] - 1 === first.right && c[2] === 1);
        if (!lead || !table.cols.every((col) => cells.some((c) => c[1] === col.col))) continue;
        setText(sheet, split(lead, ''), String(++n), { align: 'center', wrap: false });
    }
}

/** Summary lines inside a table ("a. JUMLAH PENYUSUTAN FISKAL") take their value in the table's
 *  amount column rather than in a separate box. */
function fillSummaryLines(sheet, fields, unplaced) {
    const ix = index(sheet);
    const table = findTables(sheet, ix)[0];
    if (!table) return;
    const amountCol = [...table.cols].reverse().find((c) => /\(RP\)|NILAI|JUMLAH|PENYUSUTAN/.test(norm(c.head)) && !/KETERANGAN/.test(norm(c.head)));
    if (!amountCol) return;
    for (const [label, value] of fields) {
        const want = norm(label);
        const labelCell = sheet.cells.find((c) => norm(textOf(c)).startsWith(want) && c[1] < amountCol.col);
        if (!labelCell) continue;
        const r = labelCell[0];
        let cell = sheet.cells.find((c) => c[0] === r && c[1] <= amountCol.col && c[1] + c[3] - 1 >= amountCol.col);
        if (!cell) { cell = [r, amountCol.col, 1, amountCol.right - amountCol.col + 1, restyle(sheet, labelCell[4], { bg: null, border: [['thin', '#000000'], ['thin', '#000000'], ['thin', '#000000'], ['thin', '#000000']] }), '']; sheet.cells.push(cell); }
        setText(sheet, cell, String(value).replace(MONEY_PREFIX, ''), { align: 'right', bold: 'keep', wrap: false });
        fields.handled = (fields.handled || new Set()).add(label);
    }
}

module.exports = { fillOutline, numberOutline, fillSummaryLines };
