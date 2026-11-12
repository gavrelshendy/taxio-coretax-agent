/* PER-11 fill (lib/lampiran-per11-fill.js): print tidy-up after filling - flush/frame/merge
 * tables, compact form rows, even column pairs, framed answer windows - and sheetRegions. */
const { norm, textOf, index, rowsOf, restyle } = require('./lampiran-per11-sheet');
const { findTables } = require('./lampiran-per11-tables');

/** The workbook leaves room for handwriting - value boxes three rows tall, a blank row between
 *  every line. Printed, that reads as a sparse draft next to Coretax's own compact Induk, so:
 *  - a form line's value box (and the marker beside it) shrinks to one comfortable line;
 *  - blank spacer rows shrink to a thin gap;
 *  - every single-row line has its pieces - "(", "Tarif", "x", the gold "3", ")" - centred on
 *    one line instead of sitting at the template's mix of top/bottom alignments. */
/** Tables start one column in from the section bar above them (column A holds the bar's "A."),
 *  which prints as a ragged left edge - bar, table, bar, table. Each table row is pulled out to
 *  the bar's edge by widening its first cell over the empty margin column(s). */
function flushTables(sheet) {
    const ix = index(sheet);
    const regions = sheetRegions(sheet);
    for (const h of regions.heads) {
        const first = findTables(sheet, ix).find((t) => t.numbersRow === h.to);
        if (!first || first.left <= 1) continue;
        // Only when the bar above really starts further left.
        // The bar is its "A." cell plus the wide title cell; its edge is wherever its dark fill starts.
        const dark = (c) => { const bg = ix.style(c).bg; return bg && parseInt(bg.slice(1, 3), 16) + parseInt(bg.slice(3, 5), 16) + parseInt(bg.slice(5, 7), 16) < 300; };
        // A bar is either one wide merged cell or a run of single dark cells its title spills over.
        const barRows = [];
        for (let y = h.from - 4; y < h.from; y++) {
            const d = sheet.cells.filter((c) => c[0] === y && dark(c));
            if (d.some((c) => c[3] > 4) || d.length >= 4) barRows.push(y);
        }
        const barLeft = Math.min(...sheet.cells.filter((c) => barRows.includes(c[0]) && dark(c)).map((c) => c[1]), first.left);
        if (barLeft >= first.left) continue;
        const bottom = Math.max(h.last, first.totalRow || 0) + 3;
        // Rows bucketed once per section (in sheet order, as find/filter saw them) instead of scanning
        // every cell for every row of a long table. A row only ever loses its own margin cells, all one
        // row tall, so the multi-row cells checked below are the same set throughout; they are dropped
        // from sheet.cells in one pass at the end (same result as dropping them row by row).
        const byRow = new Map();
        for (const c of sheet.cells) { const list = byRow.get(c[0]); if (list) list.push(c); else byRow.set(c[0], [c]); }
        const spanning = sheet.cells.filter((c) => c[2] > 1);
        const removed = new Set();
        for (let r = h.from; r <= bottom && r <= sheet.rows.length; r++) {
            const inRow = byRow.get(r) || [];
            const lead = inRow.find((c) => c[1] === first.left);
            if (!lead) continue;
            const margin = inRow.filter((c) => c[1] >= barLeft && c[1] < first.left);
            // (its lines are only the table's own left edge, which the widened cell carries anyway)
            if (margin.some((c) => textOf(c).trim() || c[2] > 1 || ix.style(c).bg)) continue;
            if (spanning.some((c) => c[0] < r && c[0] + c[2] - 1 >= r && c[1] < first.left && c[1] + c[3] - 1 >= barLeft)) continue;
            // The table's left line was stored as the margin cell's right border: it moves with the
            // cell that now starts at the bar's edge.
            const edgeLine = margin.map((c) => ix.style(c).border[1]).find(Boolean) || ix.style(lead).border[3];
            for (const c of margin) removed.add(c);
            byRow.set(r, inRow.filter((c) => !removed.has(c)));
            lead[3] += first.left - barLeft;
            lead[1] = barLeft;
            if (edgeLine) { const st = sheet.styles[lead[4]]; lead[4] = restyle(sheet, lead[4], { border: [st.border[0], st.border[1], st.border[2], edgeLine] }); }
        }
        if (removed.size) sheet.cells = sheet.cells.filter((c) => !removed.has(c));
    }
}

/** A table prints as a closed grid: every cell of its data rows and JUMLAH line gets all four
 *  lines, and its heading keeps an outer frame on both sides - the template leaves some of them
 *  out (L2-B's "NO." heading, the NO. column of L11-A's empty NPL list), which read as a torn
 *  table. Lines take the colour of the table's own "(1) (2) ..." row. */
/** A column heading written in the upper half of its box ("KETERANGAN" over an empty shaded cell,
 *  the workbook's two-row heading drawn as two cells) becomes one box, centred. */
function mergeHeadings(sheet) {
    const { heads } = sheetRegions(sheet);
    for (const h of heads) {
        for (let changed = true; changed;) {
            changed = false;
            const ix = index(sheet);
            for (const c of sheet.cells) {
                if (c[0] < h.from || c[0] + c[2] - 1 >= h.to || !textOf(c).trim()) continue;
                const below = ix.at.get((c[0] + c[2]) + ':' + c[1]);
                if (!below || below[3] !== c[3] || textOf(below).trim() || below[0] + below[2] - 1 >= h.to) continue;
                const a = sheet.styles[c[4]], b = sheet.styles[below[4]];
                if ((a.bg || '') !== (b.bg || '') || !a.bg) continue;
                const border = a.border.slice(); border[2] = b.border[2];
                c[2] += below[2];
                c[4] = restyle(sheet, c[4], { border, v: 'middle', wrap: true });
                sheet.cells = sheet.cells.filter((x) => x !== below);
                changed = true;
                break;
            }
        }
    }
}

function frameTables(sheet) {
    const ix = index(sheet), rows = rowsOf(sheet); // moves no cell (borders only)
    const regions = sheetRegions(sheet);
    const tables = findTables(sheet, ix);
    for (const t of tables) {
        const head = regions.heads.find((h) => h.to === t.numbersRow);
        if (!head) continue;
        const ref = ix.at.get(t.numbersRow + ':' + t.cols[0].col);
        const line = ref && ix.style(ref).border.find(Boolean);
        if (!line) continue;
        const inTable = (c) => c[1] >= t.left && c[1] + c[3] - 1 <= t.right;
        // A note line inside the frame ("PINDAHKAN JUMLAH TABEL C ... KE INDUK") runs across the
        // columns: it keeps its own lines and gets only the table's outer edges.
        const noteRows = new Set();
        for (let y = t.numbersRow + 1; y <= head.last; y++) {
            const texted = rows.raw(y).filter((c) => inTable(c) && textOf(c).trim());
            if (texted.length && texted.every((c) => !sheet.styles[c[4]].data && !sheet.styles[c[4]].bg) && texted.some((c) => /^(PINDAHKAN|JUMLAHKAN)\b/i.test(textOf(c).trim()))) noteRows.add(y);
        }
        for (const c of sheet.cells) {
            if (!inTable(c)) continue;
            const st = sheet.styles[c[4]];
            let border = null;
            if (st.inner) continue;
            if (noteRows.has(c[0])) {
                border = st.border.slice();
                if (c[1] === t.left && !border[3]) border[3] = line;
                if (c[1] + c[3] - 1 === t.right && !border[1]) border[1] = line;
            } else if (c[0] > t.numbersRow && c[0] <= head.last && !(st.bg && parseInt(st.bg.slice(1, 3), 16) < 80)) {
                // A shaded summary band keeps one run: only its outer edges get vertical lines.
                // Elsewhere a vertical line only goes where a numbered column starts or ends, so the
                // indent cells of a name column (L1) stay one open field.
                const edge = (i) => (i === 3 && c[1] === t.left) || (i === 1 && c[1] + c[3] - 1 === t.right);
                const seam = (i) => i === 3 ? t.cols.some((k) => k.col === c[1]) : t.cols.some((k) => k.right === c[1] + c[3] - 1);
                border = st.border.map((b, i) => b || (i % 2 === 0 || edge(i) || (!st.bg && seam(i)) ? line : null));
            } else if (c[0] >= head.from && c[0] <= t.numbersRow) {
                border = st.border.slice();
                if (c[1] === t.left && !border[3]) border[3] = line;
                if (c[1] + c[3] - 1 === t.right && !border[1]) border[1] = line;
            }
            if (border && border.some((b, i) => b !== st.border[i])) c[4] = restyle(sheet, c[4], { border });
        }
    }
}

function compactForm(sheet) {
    const ix = index(sheet);
    const regions = sheetRegions(sheet);
    const tableRows = new Set();
    for (const h of regions.heads) for (let y = h.from; y <= h.last; y++) tableRows.add(y);
    for (let r = regions.kopEnd + 1; r <= sheet.rows.length; r++) {
        if (tableRows.has(r)) continue;
        const cells = ix.rowCells(r);
        const blank = !cells.some((c) => textOf(c).trim() || c[2] > 1) && !sheet.cells.some((c) => c[0] < r && c[0] + c[2] - 1 >= r);
        // (side lines alone - OP's frame round the form - do not make a blank row part of a box)
        if (blank && !cells.some((c) => ix.style(c).border[0] || ix.style(c).border[2])) sheet.rows[r - 1] = Math.min(sheet.rows[r - 1], 7);
    }
    for (const box of sheet.cells) {
        if (box[2] < 2 || tableRows.has(box[0]) || box[0] <= regions.kopEnd || !ix.boxed(box)) continue;
        const per = Math.max(7, Math.round(24 / box[2]));
        for (let y = box[0]; y < box[0] + box[2]; y++) sheet.rows[y - 1] = Math.min(sheet.rows[y - 1], per);
    }
    const spanning = new Set();
    for (const c of sheet.cells) if (c[2] > 1) for (let y = c[0]; y < c[0] + c[2]; y++) spanning.add(y);
    for (let r = regions.kopEnd + 1; r <= sheet.rows.length; r++) {
        if (tableRows.has(r) || spanning.has(r)) continue;
        for (const c of ix.rowCells(r)) if (ix.style(c).v !== 'middle') c[4] = restyle(sheet, c[4], { v: 'middle' });
    }
}

/** OP's Ikhtisar Harta gives NILAI SAAT INI twice the width of HARGA PEROLEHAN; the two totals
 *  print side by side, so they get equal halves (the user asked for it symmetric). Splits the
 *  pair on every row it spans (heading, "(2) (3)", the JUMLAH line) and records the pair in
 *  `sheet.even` so the PDF can split it again once its columns have their final widths. */
function evenPairs(sheet) {
    sheet.even = [];
    const at = (r, c) => sheet.cells.find((x) => x[0] === r && x[1] === c);
    for (const a of sheet.cells) {
        if (!/^HARGA PEROLEHAN$/.test(textOf(a).trim()) || a[2] !== 1) continue;
        const b = at(a[0], a[1] + a[3]);
        if (!b || b[2] !== 1 || !/^NILAI SAAT INI$/.test(textOf(b).trim()) || Math.max(a[3], b[3]) < 1.5 * Math.min(a[3], b[3])) continue;
        const [left, right, end] = [a[1], b[1], b[1] + b[3] - 1];
        const rows = [];
        for (let r = a[0]; ; r++) {
            const x = at(r, left), y = at(r, right);
            if (!x || !y || x[3] !== a[3] || y[3] !== b[3] || x[2] !== 1 || y[2] !== 1) break;
            rows.push([x, y]);
        }
        const w = (c0, c1) => sheet.cols.slice(c0 - 1, c1).reduce((s, v) => s + v, 0);
        let split = left;
        for (let k = left; k < end; k++) if (Math.abs(w(left, k) - w(k + 1, end)) < Math.abs(w(left, split) - w(split + 1, end))) split = k;
        for (const [x, y] of rows) { x[3] = split - left + 1; y[1] = split + 1; y[3] = end - split; }
        // (the cells themselves, not their row numbers: compactForm may still move rows)
        sheet.even.push({ cells: rows.map(([x]) => x), left, end });
    }
}

/** A form's answer boxes are white windows in its grey field (OP L4): the workbook draws them
 *  without a line, which printed as loose white strips. They get a thin frame (the user asked
 *  for borders there). A window = an unframed white cell at least three columns wide with grey
 *  on its left and above or below it. */
function frameWindows(sheet) {
    const grey = (st) => /^#D[0-9A-F]D[0-9A-F]D[0-9A-F]$/i.test(st.bg || '');
    const cover = new Map();
    for (const c of sheet.cells) for (let y = c[0]; y < c[0] + c[2]; y++) for (let x = c[1]; x < c[1] + c[3]; x++) cover.set(y + ':' + x, c);
    const greyAt = (r, c) => { const x = cover.get(r + ':' + c); return !!x && grey(sheet.styles[x[4]]); };
    // (or the gold marker in front of it: B.3's "3a" / "3b")
    const markerAt = (r, c) => { const x = cover.get(r + ':' + c); return !!x && /^#FF(C000|D600)$/i.test(sheet.styles[x[4]].bg || ''); };
    const out = [];
    for (const c of sheet.cells) {
        const st = sheet.styles[c[4]];
        if (c[2] !== 1 || c[3] < 3 || (st.bg && !/^#FFFFFF$/i.test(st.bg)) || st.border.some(Boolean)) continue;
        if (!(greyAt(c[0], c[1] - 1) || markerAt(c[0], c[1] - 1)) || !(greyAt(c[0] - 1, c[1]) || greyAt(c[0] + 1, c[1]))) continue;
        c[4] = restyle(sheet, c[4], { border: [0, 1, 2, 3].map(() => ['thin', '#000000']) });
        out.push(c);
    }
    // Framed, the template's 13px rows with 4px of grey between them read as a ladder of thin
    // strips: the boxes get a full line's height and the grey between them some air.
    const rows = new Set(out.map((c) => c[0]));
    // (Induk Coretax: 15pt boxes 5pt apart; the room L4 has left on its one page allows this)
    for (const r of rows) {
        sheet.rows[r - 1] = Math.max(sheet.rows[r - 1], 15);
        for (const g of [r - 1, r + 1]) if (!rows.has(g) && sheet.rows[g - 1] < 6 && !sheet.cells.some((x) => x[0] === g && textOf(x).trim())) sheet.rows[g - 1] = 6;
    }
    return out;
}

/** Where the kop ends and where each table's headings/data sit - what the paginator repeats. */
function sheetRegions(sheet) {
    const ix = index(sheet);
    let kopEnd = 0;
    for (let r = 1; r <= Math.min(14, sheet.rows.length); r++) for (const cell of ix.rowCells(r)) if (/^(NIK )?NPWP$/.test(norm(textOf(cell)))) kopEnd = Math.max(kopEnd, cell[0] + cell[2] - 1);
    if (kopEnd && kopEnd < sheet.rows.length) kopEnd++; // the spacer under the kop belongs to it
    const tables = findTables(sheet, ix);
    const heads = tables.map((t, i) => {
        // The table runs on as long as its columns keep their frame - an outline table (L9) keeps
        // going through its summary lines and the next group - up to the next table's headings.
        const stop = tables[i + 1] ? (tables[i + 1].headRows[0] || tables[i + 1].numbersRow) - 1 : sheet.rows.length;
        let last = t.totalRow || t.end;
        for (let y = last + 1; y <= stop; y++) {
            // OP draws one frame round the whole form, so its edge lines alone do not continue a
            // table: a spacer row or the next numbered section line ends it.
            if (sheet.rows[y - 1] <= 5 && !ix.rowCells(y).some((c) => textOf(c).trim())) break;
            if (ix.rowCells(y).some((c) => ix.style(c).bg && /^(\d+|[A-Z])\.$/.test(textOf(c).trim()))) break;
            // (a line on the table's outer side only - OP's frame round the form - does not count)
            const inner = (c) => { const b = ix.style(c).border; return !!(b[2] || (b[1] && c[1] + c[3] - 1 < t.right) || (b[3] && c[1] > t.left)); };
            const framed = sheet.cells.some((c) => c[0] === y && c[1] >= t.left && c[1] <= t.right && inner(c) && !(ix.style(c).bg && c[3] > 6 && parseInt((ix.style(c).bg || '#fff').slice(1, 3), 16) < 80));
            if (!framed) break;
            last = y;
        }
        return { from: t.headRows[0] || t.numbersRow, to: t.numbersRow, first: t.first, last };
    });
    // The kop's own dark colour, for the slim header of continuation pages.
    const tally = new Map();
    for (const c of sheet.cells) { const bg = c[0] <= kopEnd && ix.style(c).bg; if (bg && parseInt(bg.slice(1, 3), 16) + parseInt(bg.slice(3, 5), 16) + parseInt(bg.slice(5, 7), 16) < 300) tally.set(bg, (tally.get(bg) || 0) + c[3]); }
    const kopColor = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] || '#2D471D';
    return { kopEnd, heads, kopColor };
}

module.exports = { flushTables, mergeHeadings, frameTables, compactForm, evenPairs, frameWindows, sheetRegions };
