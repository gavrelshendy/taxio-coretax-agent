/* PER-11 fill (lib/lampiran-per11-fill.js): shared helpers over a compiled sheet - label
 * normalising/similarity, cell index, row buckets, clone, restyle, tick mark, row shifting. */

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[ \s]+/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = (cell) => cell ? (Array.isArray(cell[5]) ? cell[5].map((r) => r.t).join('') : String(cell[5] || '')) : '';
const MONEY_PREFIX = /^Rp\.?\s*/i;

/** Word-overlap similarity of two labels, 0..1. */
function similarity(a, b) {
    const wa = norm(a).split(' ').filter((w) => w.length > 1), wb = new Set(norm(b).split(' ').filter((w) => w.length > 1));
    if (!wa.length || !wb.size) return 0;
    const hit = wa.filter((w) => wb.has(w)).length;
    return (2 * hit) / (wa.length + wb.size);
}

function index(sheet) {
    const at = new Map(), cover = new Map();
    for (const cell of sheet.cells) {
        const [r, c, rs, cs] = cell;
        at.set(r + ':' + c, cell);
        for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) cover.set(y + ':' + x, cell);
    }
    const style = (cell) => sheet.styles[cell[4]];
    const boxed = (cell) => { const b = style(cell).border; return !!(b[0] && b[2] && (b[1] || b[3])) && !style(cell).bg; };
    const rowCells = (r) => sheet.cells.filter((cell) => cell[0] === r).sort((a, b) => a[1] - b[1]);
    return { at, cover, style, boxed, rowCells };
}

/** The sheet's cells per row, bucketed once: `cells(r)` = ix.rowCells(r) (sorted by column), `raw(r)`
 *  = the row's cells in sheet order (what sheet.cells.find/filter on that row see). Only for a pass
 *  that moves no cell (text and style changes are fine - the buckets hold the same cell objects);
 *  filtering every cell per row made long tables (a 58.914-row L3) take minutes. */
function rowsOf(sheet) {
    const byRow = new Map();
    for (const cell of sheet.cells) { const list = byRow.get(cell[0]); if (list) list.push(cell); else byRow.set(cell[0], [cell]); }
    const sorted = new Map();
    return {
        raw: (r) => byRow.get(r) || [],
        cells: (r) => { if (!sorted.has(r)) sorted.set(r, (byRow.get(r) || []).slice().sort((a, b) => a[1] - b[1])); return sorted.get(r).slice(); }
    };
}

/** A copy of the sheet the fill can edit without touching the shared compiled layout. */
function cloneSheet(sheet) {
    return { ...sheet, cols: sheet.cols.slice(), rows: sheet.rows.slice(), styles: sheet.styles.map((s) => ({ ...s, border: s.border.slice() })),
        cells: sheet.cells.map((c) => c.slice()), shapes: (sheet.shapes || []).map((s) => ({ ...s })) };
}

/** Returns a style index equal to `base` with `changes` applied, reusing an existing one if any. */
function restyle(sheet, base, changes) {
    const want = { ...sheet.styles[base], ...changes };
    const key = JSON.stringify(want);
    let i = sheet.styles.findIndex((s) => JSON.stringify(s) === key);
    if (i < 0) { i = sheet.styles.length; sheet.styles.push(want); }
    return i;
}

function mark(sheet, cell) { cell[5] = 'X'; cell[4] = restyle(sheet, cell[4], { h: 'center', v: 'center', bold: true, color: '#000000', font: 'Arial', size: 9 }); }

function shiftRows(sheet, at, delta) {
    // Rows from `at` on move by `delta` (negative deletes rows at..at-delta-1 first).
    if (delta < 0) sheet.cells = sheet.cells.filter((c) => !(c[0] >= at && c[0] < at - delta));
    for (const c of sheet.cells) {
        if (c[0] >= at) c[0] += delta;
        else if (c[0] + c[2] - 1 >= at) c[2] = Math.max(1, c[2] + delta);
    }
    const top = sheet.rows.slice(0, at - 1).reduce((a, b) => a + b, 0);
    if (delta > 0) sheet.rows.splice(at - 1, 0, ...new Array(delta).fill(sheet.rows[at - 2] || 16));
    else sheet.rows.splice(at - 1, -delta);
    for (const s of sheet.shapes) if (s.from && s.from.row + 1 >= at) { s.from = { ...s.from, row: s.from.row + delta }; s.y += delta * 16; }
    void top;
}

module.exports = { norm, textOf, MONEY_PREFIX, similarity, index, rowsOf, cloneSheet, restyle, mark, shiftRows };
