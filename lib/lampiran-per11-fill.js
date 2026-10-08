/* Puts Coretax's data into a compiled PER-11 sheet (see scripts/build-per11-layout.js), producing
 * a new sheet the renderer draws exactly like the blank one - same cells, same styles - with:
 *   - the kop's NPWP and TAHUN PAJAK digit boxes filled;
 *   - every list table's blank data rows replaced by one copy of the template's own data row per
 *     record (a record may be several Excel rows tall), and its JUMLAH row filled;
 *   - reconciliation tables (L1, OP L3A) filled in place, account code by account code;
 *   - calculation forms (L6, L8, L11-B I, ...) filled into each numbered line's value box;
 *   - Ya/Tidak answers and tick boxes marked.
 * Anything that could not be placed is returned in `unplaced`, so nothing is dropped silently.
 */
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

/* ---------------------------------------------------------------- kop */
function fillKop(sheet, ix, { npwp, year }) {
    const digits = String(npwp || '').replace(/\D/g, '');
    const put = (cell, ch) => { cell[5] = ch; cell[4] = restyle(sheet, cell[4], { color: '#000000', h: 'center', v: 'center', bold: false, size: 8, font: 'Roboto Condensed' }); };
    const groupsRightOf = (r, c) => {
        const groups = [];
        for (const cell of ix.rowCells(r)) {
            if (cell[1] <= c || !ix.boxed(cell) || textOf(cell).trim()) continue;
            const g = groups[groups.length - 1];
            if (g && cell[1] === g[g.length - 1][1] + g[g.length - 1][3]) g.push(cell); else groups.push([cell]);
        }
        return groups.filter((g) => g.length >= 2);
    };
    let npwpDone = false, yearDone = false;
    for (let r = 1; r <= Math.min(14, sheet.rows.length); r++) {
        for (const cell of ix.rowCells(r)) {
            const t = norm(textOf(cell));
            if (!npwpDone && /^(NIK )?NPWP$/.test(t)) {
                const groups = groupsRightOf(r, cell[1]);
                if (groups[0]) { groups[0].forEach((box, i) => digits[i] && put(box, digits[i])); npwpDone = true; }
                // Badan keeps the TAHUN PAJAK boxes on the NPWP row, after a gap.
                if (groups.length > 1 && year) { groups[groups.length - 1].slice(-4).forEach((box, i) => put(box, String(year)[i] || '')); yearDone = true; }
            }
        }
    }
    if (!yearDone && year) {
        // OP puts them next to (or under) its own "TAHUN PAJAK" label.
        for (let r = 1; r <= Math.min(14, sheet.rows.length) && !yearDone; r++) for (const cell of ix.rowCells(r)) {
            if (!/TAHUN PAJAK/.test(norm(textOf(cell)))) continue;
            for (let y = r; y <= r + 3 && !yearDone; y++) {
                const g = groupsRightOf(y, y === r ? cell[1] + cell[3] - 1 : cell[1] - 1).find((x) => x.length >= 4);
                if (g) { g.slice(-4).forEach((box, i) => put(box, String(year)[i] || '')); yearDone = true; }
            }
        }
    }
}

/** OP's LAMPIRAN badge stops one column short of the kop's right edge, leaving a dark strip
 *  beside it: it runs to the edge instead, as the Badan kop and Coretax's Induk print it. */
function flushBadge(sheet) {
    const ix = index(sheet);
    const yellow = (c) => /^#FF(C000|D600)$/i.test(ix.style(c).bg || '');
    const badge = sheet.cells.find((c) => c[0] <= 12 && /^LAMPIRAN\b/.test(textOf(c).trim()) && yellow(c));
    if (!badge) return;
    const right = badge[1] + badge[3] - 1;
    // The badge and the HALAMAN line under it (same yellow, same right edge) move together.
    const parts = sheet.cells.filter((c) => c[0] <= 12 && yellow(c) && c[1] === badge[1] && c[1] + c[3] - 1 === right);
    const top = Math.min(...parts.map((c) => c[0])), bottom = Math.max(...parts.map((c) => c[0] + c[2] - 1));
    const beside = sheet.cells.filter((c) => c[0] >= top && c[0] + c[2] - 1 <= bottom && c[1] > right && c[3] === 1 && !textOf(c).trim() && ix.style(c).bg && !yellow(c));
    const cols = [...new Set(beside.map((c) => c[1]))].sort((a, b) => a - b);
    if (!cols.length || cols[0] !== right + 1 || cols.length > 2) return;
    const edge = cols[cols.length - 1];
    for (const p of parts) for (let y = p[0]; y < p[0] + p[2]; y++) for (let x = right + 1; x <= edge; x++) if (!beside.some((c) => c[0] === y && c[1] === x)) return;
    sheet.cells = sheet.cells.filter((c) => !beside.includes(c) || !parts.some((p) => c[0] >= p[0] && c[0] < p[0] + p[2]));
    for (const p of parts) p[3] = edge - p[1] + 1;
}

/** The workbook keeps its dropdown sources on the sheet - "104 Penghasilan dari pekerjaan
 *  bebas", "501 Zakat", ... in plain unframed cells beside or below the form (L2, L5). They are
 *  not part of the form: runs of three or more code + description lines go, with the "- -" line
 *  heading them, and so do the empty rows they leave at the foot of the sheet. */
function dropLookupLists(sheet) {
    const ix = index(sheet);
    const plain = (c) => c && !ix.style(c).border.some(Boolean) && !ix.style(c).bg;
    const drop = new Set();
    const cols = new Set(sheet.cells.filter((c) => plain(c) && /^\d{3}$/.test(textOf(c).trim())).map((c) => c[1]));
    for (const col of cols) {
        let run = [];
        const flush = () => {
            if (run.length >= 3) {
                for (const r of run) { drop.add(ix.at.get(r + ':' + col)); drop.add(ix.at.get(r + ':' + (col + 1))); }
                const head = run[0] - 1, a = ix.at.get(head + ':' + col), b = ix.at.get(head + ':' + (col + 1));
                if (plain(a) && /^[-–]?$/.test(textOf(a).trim()) && (!b || (plain(b) && /^[-–]?$/.test(textOf(b).trim())))) { drop.add(a); drop.add(b); }
            }
            run = [];
        };
        for (let r = 1; r <= sheet.rows.length + 1; r++) {
            const a = ix.at.get(r + ':' + col), b = ix.at.get(r + ':' + (col + 1));
            if (plain(a) && /^\d{3}$/.test(textOf(a).trim()) && plain(b) && textOf(b).trim()) run.push(r); else flush();
        }
    }
    drop.delete(undefined);
    if (!drop.size) return;
    sheet.cells = sheet.cells.filter((c) => !drop.has(c));
    let last = 0;
    for (const c of sheet.cells) last = Math.max(last, c[0] + c[2] - 1);
    for (const sh of sheet.shapes || []) if (sh.from) last = Math.max(last, sh.from.row + 1);
    if (last && last < sheet.rows.length) sheet.rows.length = last;
}

/** OP's workbook keeps two empty margin columns left of the form and draws a frame round the
 *  whole sheet. Printed, the margin made the kop and the tables start at different places (each
 *  was widened on its own) and the frame left short strokes on every spacer row. The margin
 *  columns go, and so does a frame line on an empty cell at the form's outer edge. */
function trimMargins(sheet) {
    if ((sheet.shapes || []).length) return;
    const used = sheet.cells.filter((c) => textOf(c).trim() || sheet.styles[c[4]].bg || sheet.styles[c[4]].border.some(Boolean));
    if (!used.length) return;
    const first = Math.min(...used.map((c) => c[1]));
    const last = Math.max(...used.map((c) => c[1] + c[3] - 1));
    if (first > 1 || last < sheet.cols.length) {
        sheet.cells = sheet.cells.filter((c) => c[1] + c[3] - 1 >= first && c[1] <= last);
        for (const c of sheet.cells) {
            const l = Math.max(c[1], first), r = Math.min(c[1] + c[3] - 1, last);
            c[1] = l - first + 1; c[3] = r - l + 1;
        }
        sheet.cols = sheet.cols.slice(first - 1, last);
    }
    const n = sheet.cols.length;
    for (const c of sheet.cells) {
        const st = sheet.styles[c[4]];
        if (textOf(c).trim() || st.bg) continue;
        const b = st.border;
        const onlyLeft = c[1] === 1 && b[3] && !b[0] && !b[1] && !b[2];
        const onlyRight = c[1] + c[3] - 1 === n && b[1] && !b[0] && !b[2] && !b[3];
        if (onlyLeft || onlyRight) c[4] = restyle(sheet, c[4], { border: [null, null, null, null] });
    }
}

/** The kop's coloured blocks print as flat fills, as in Coretax's own Induk: the workbook's
 *  cell lines inside them (a black outline round the grey block, a grid in the navy one) go.
 *  The white digit boxes keep theirs. */
function plainKop(sheet) {
    const { kopEnd } = sheetRegions(sheet);
    if (!kopEnd) return;
    for (const c of sheet.cells) {
        const st = sheet.styles[c[4]];
        if (c[0] > kopEnd || !st.bg || /^#FFFFFF$/i.test(st.bg) || !st.border.some(Boolean)) continue;
        c[4] = restyle(sheet, c[4], { border: [null, null, null, null] });
    }
}

/* ---------------------------------------------------------------- tables */
const NUMBERS = /^\(\d+\)/;
/** Every table in the sheet, found from its column-number row "(1). (2). ...". */
function findTables(sheet, ix) {
    const tables = [];
    for (let r = 1; r <= sheet.rows.length; r++) {
        const numbered = ix.rowCells(r).filter((cell) => NUMBERS.test(textOf(cell).trim()));
        if (numbered.length < 2) continue;
        // Side-by-side tables (L1's neraca) repeat "(1)" in one row: split there.
        const parts = [];
        for (const cell of numbered) { const n = +textOf(cell).match(/\d+/)[0]; if (!parts.length || n <= parts[parts.length - 1].last) parts.push({ cols: [], last: 0 }); parts[parts.length - 1].cols.push(cell); parts[parts.length - 1].last = n; }
        for (const part of parts) {
            const cols = part.cols.map((cell) => ({ col: cell[1], right: cell[1] + cell[3] - 1, num: +textOf(cell).match(/\d+/)[0] }));
            const left = cols[0].col, right = cols[cols.length - 1].right;
            const first = r + 1;
            const firstCells = cols.map((c) => ix.cover.get(first + ':' + c.col)).filter(Boolean);
            const unit = Math.max(1, ...firstCells.map((cell) => cell[0] + cell[2] - first));
            // Header text of each column: everything written above its number, up to the section bar.
            // Heading rows sit between the section bar and the numbers row. A row can look empty
            // while it is covered by headings merged down from above, so coverage decides, not
            // whether a cell starts there.
            const headRows = [];
            for (let y = r - 1; y >= 1; y--) {
                const cells = []; for (let x = left; x <= right; x++) { const cell = ix.cover.get(y + ':' + x); if (cell && !cells.includes(cell)) cells.push(cell); }
                const bar = cells.filter((cell) => cell[0] === y && ix.style(cell).bg && /2D471D|1F3864|212E5E|2F5496|1E4E79/.test(ix.style(cell).bg));
                if (!cells.length || bar.some((cell) => cell[3] > 6) || bar.length >= 4) break;
                // ...or at the table above's JUMLAH line, or a numbered section line ("4. HARTA
                // BERGERAK" in OP's yellow): headings never carry either.
                const words = cells.filter((cell) => cell[0] === y && textOf(cell).trim()).sort((a, b) => a[1] - b[1]).map((cell) => textOf(cell).trim());
                if (/^(JUMLAH|TOTAL|PINDAHKAN|JUMLAHKAN)\b/i.test(words[0] || '') || (words.length && /^(\d+|[A-Z])\.(\s|$)/.test(words[0]) && cells.some((cell) => cell[0] === y && ix.style(cell).bg))) break;
                headRows.unshift(y);
                if (headRows.length > 6) break;
            }
            cols.forEach((c) => { c.head = headRows.map((y) => ix.rowCells(y).filter((cell) => cell[1] <= c.col && cell[1] + cell[3] - 1 >= c.col).map(textOf).join(' ')).join(' ').replace(/\s+/g, ' ').trim(); });
            let end = first - 1, totalRow = 0, codes = 0;
            for (let y = first; y <= sheet.rows.length; y++) {
                const cells = ix.rowCells(y).filter((cell) => cell[1] >= left && cell[1] <= right);
                const texts = cells.map(textOf).map((t) => t.trim());
                // A closing JUMLAH row starts at the table's first column and carries no account
                // code - "5030 Jumlah Pembelian Bahan Baku" is an account, not the table's total.
                const closing = cells.find((cell) => /^(JUMLAH|TOTAL)\b/i.test(textOf(cell).trim()) && cell[1] <= left + 2);
                if (closing && !texts.some((t) => /^\d{4}$/.test(t))) { totalRow = y; break; }
                // The compact PDF's "Ditampilkan 50 dari N baris" line belongs to the table.
                if (texts.some((t) => /^Ditampilkan \d/.test(t))) { end = y; continue; }
                // The next numbered section line ("D." on OP's dark bar, drawn one cell per
                // column) ends the table even where it carries the form's outer frame line.
                if (cells.some((cell) => ix.style(cell).bg && /^(\d+|[A-Z])\.$/.test(textOf(cell).trim()))) break;
                // ...and so does a thin empty spacer row.
                if (sheet.rows[y - 1] <= 5 && !texts.some(Boolean) && !sheet.cells.some((cell) => cell[0] < y && cell[0] + cell[2] > y && cell[1] >= left && cell[1] <= right)) break;
                const lead = ix.cover.get(y + ':' + left);
                if (!lead || (ix.style(lead).bg && ix.style(lead).bg !== '#FFFFFF' && !/^\d{4}$/.test(texts[0] || '') && lead[3] > 6)) break;
                const b = ix.style(lead).border;
                if (!(b[0] || b[2] || b[3])) break;
                if (texts.some((t) => /^\d{4}$/.test(t))) codes++;
                end = y;
            }
            tables.push({ numbersRow: r, headRows, first, end, unit, units: Math.max(0, Math.floor((end - first + 1) / unit)), cols, left, right, totalRow, fixed: codes >= 3 });
        }
    }
    return tables;
}

/** The wording of the shaded section line right above a table's headings, "" if none. */
function tableTitle(sheet, ix, table) {
    // The nearest shaded line above the column numbers that opens with a numbering ("4.", "B.");
    // the headings in between are shaded too but never numbered.
    for (let y = table.numbersRow - 1, n = 0; y >= 1 && n < 12; y--, n++) {
        const cells = ix.rowCells(y).filter((c) => c[1] <= table.right + 1 && c[1] + c[3] - 1 >= table.left - 1 && textOf(c).trim());
        if (!cells.length || !cells.every((c) => ix.style(c).bg && ix.style(c).bg !== '#FFFFFF')) continue;
        const text = cells.map((c) => textOf(c).trim()).join(' ').replace(/\s+/g, ' ');
        if (/^([A-Z]|\d+|[IVX]+)\.(\s|$)/.test(text)) return text;
    }
    return '';
}

const isTotalRow = (row) => /^(TOTAL|JUMLAH)\b/i.test(String(row[0] || '').trim()) || (!String(row[0] || '').trim() && /^(TOTAL|JUMLAH)\b/i.test(String(row[1] || '').trim()));
const cleanHeaders = (headers) => headers.map((h, i) => ({ h, i })).filter((x) => !/^Pilih /i.test(x.h));

/** Column k of the template table <- which model column. Positional when the counts agree
 *  (the common case: Coretax mirrors the form), otherwise by header wording. */
function columnMap(table, headers, byWording = false, skip = new Set()) {
    const model = cleanHeaders(headers);
    if (!byWording && model.length === table.cols.length) return table.cols.map((_, k) => model[k].i);
    if (!byWording && model.length === table.cols.length - 1 && /^NO\b/.test(norm(table.cols[0].head))) return [null, ...model.map((m) => m.i)];
    const used = new Set();
    return table.cols.map((c, k) => {
        if (skip.has(k)) return null;
        if (/^NO\b/.test(norm(c.head)) && !model.some((m) => /^NO\b/.test(norm(m.h)))) return null;
        let best = null, score = 0.34;
        for (const m of model) { if (used.has(m.i)) continue; const s = Math.max(similarity(c.head, m.h), similarity(c.head.replace(/\s*\(.*\)\s*/g, ' '), m.h)); if (s > score) { score = s; best = m.i; } }
        if (best != null) used.add(best);
        return best;
    });
}

/** One rule for every value the fill writes, whatever the template cell happened to carry:
 *  the form's own body font at 8pt, amounts right, identifiers/codes/dates centred, text left. */
function setText(sheet, cell, text, { right = false, align = null, wrap = true, bold = false } = {}) {
    // Rupiah amounts print whole, as Coretax's own Induk prints them: "3.143.125,00" -> "3.143.125".
    cell[5] = String(text == null ? '' : text).replace(/^(-?\(?-?(?:\d{1,3}(?:\.\d{3})+|\d+)),00(\)?)$/, '$1$2');
    const st = sheet.styles[cell[4]];
    const h = align || (right ? 'right' : looksNumeric(cell[5]) ? 'right' : 'left');
    const base = { font: sheet.bodyFont || st.font, size: 8, bold: bold === 'keep' ? st.bold : !!bold, italic: false, color: sheet.bodyColor || st.color };
    // Identifiers and amounts never wrap (a split NPWP or amount misleads); `data` lets the
    // renderer widen a column the value does not fit in instead of letting it spill over.
    const unbreakable = /^[\d.,()\-/%\s]+$/.test(cell[5]) && !/\s\S+\s/.test(cell[5]);
    const changes = { ...base, wrap: unbreakable ? false : wrap || st.wrap, v: 'middle', h, data: true };
    cell[4] = restyle(sheet, cell[4], changes);
}
const looksNumeric = (v) => /^-?\(?(Rp\.?\s*)?-?[\d.]+(,\d+)?\)?%?$/.test(String(v).trim()) && /\d/.test(String(v));

/** Replaces a table's blank data rows with `records` copies of its template data row. */
function spliceRecords(sheet, table, count) {
    const bandRows = table.end - table.first + 1;
    const unitCells = sheet.cells.filter((c) => c[0] >= table.first && c[0] < table.first + table.unit && c[1] >= table.left && c[1] <= table.right);
    const unitHeights = sheet.rows.slice(table.first - 1, table.first - 1 + table.unit);
    const labelled = (j) => unitCells.some((c) => c[0] === table.first + j && c[2] === 1 && /^[A-Z][A-Z/ ]{2,}:?$/.test(textOf(c).trim()));
    const hasLabels = unitHeights.some((_, j) => labelled(j));
    const n = Math.max(1, count);
    const newRows = n * table.unit, delta = newRows - bandRows;
    // Drop the band (only the table's own columns: side-by-side neighbours keep their rows).
    sheet.cells = sheet.cells.filter((c) => !(c[0] >= table.first && c[0] <= table.end && c[1] >= table.left && c[1] <= table.right));
    if (delta) {
        for (const c of sheet.cells) if (c[0] > table.end) c[0] += delta;
        const removedPx = sheet.rows.slice(table.first - 1, table.end).reduce((a, b) => a + b, 0);
        // A form record drawn two or three Excel rows tall (room for handwriting) is printed as
        // tall as its content needs: the rows shrink and the merged cells grow them back.
        // A row holding a slot label ("NIK/NPWP", "NAMA", "TANAH:") keeps a full line.
        const tight = table.unit > 1 ? unitHeights.map((h, j) => labelled(j) ? Math.max(12, h) : Math.max(6, Math.round(h * 0.4))) : unitHeights;
        const heights = []; for (let i = 0; i < n; i++) heights.push(...tight);
        sheet.rows.splice(table.first - 1, bandRows, ...heights);
        const addedPx = heights.reduce((a, b) => a + b, 0) - removedPx;
        const bandTop = sheet.rows.slice(0, table.first - 1).reduce((a, b) => a + b, 0);
        for (const s of sheet.shapes) if (s.y >= bandTop + 1) { s.y += addedPx; if (s.from) s.from = { ...s.from, row: s.from.row + delta }; }
    }
    const records = [];
    for (let i = 0; i < n; i++) {
        let copy = unitCells.map((c) => { const x = c.slice(); x[0] = c[0] + i * table.unit; x[5] = /^\d+\.?$/.test(textOf(c).trim()) ? '' : x[5]; return x; });
        // A column the template splits into one cell per Excel row of the record (L11A's NO.)
        // becomes one cell, so its value sits in the middle of the record like its neighbours'.
        // (Not in a record of labelled lines - "NIK/NPWP" over "NAMA" - whose rows are its content.)
        if (table.unit > 1 && !hasLabels) {
            const byCol = new Map();
            for (const c of copy) { if (!byCol.has(c[1])) byCol.set(c[1], []); byCol.get(c[1]).push(c); }
            for (const cells of byCol.values()) {
                if (cells.length !== table.unit || cells.some((c) => c[2] !== 1 || c[3] !== cells[0][3])) continue;
                cells.sort((a, b) => a[0] - b[0]);
                cells[0][2] = table.unit;
                copy = copy.filter((c) => !cells.slice(1).includes(c));
            }
        }
        sheet.cells.push(...copy);
        records.push(copy);
    }
    return { delta, records };
}

/** OP's records carry labelled slots inside one numbered column - "NIK/NPWP ____" over
 *  "NAMA ____" under PENERIMA PINJAMAN, "TANAH:" / "BANGUNAN:" under UKURAN PROPERTI, tick boxes
 *  "ATAS NAMA SENDIRI" / "ATAS NAMA PIHAK LAIN" - where Coretax gives each slot a column of its
 *  own. Returns Map(column index -> [{label, dy, slot | box, model}]) plus `consumed`, the model
 *  columns those slots take. */
function subSlots(sheet, table, headers) {
    const out = new Map();
    out.consumed = new Set();
    out.valued = new Set();
    if (table.unit < 2) return out;
    const ix = index(sheet);
    const model = cleanHeaders(headers);
    const unit = sheet.cells.filter((c) => c[0] >= table.first && c[0] < table.first + table.unit && c[1] >= table.left && c[1] <= table.right);
    table.cols.forEach((col, k) => {
        const inCol = unit.filter((c) => c[1] >= col.col && c[1] <= col.right);
        const labels = inCol.filter((c) => /^[A-Z][A-Z/ ]{2,}:?$/.test(textOf(c).trim()));
        if (!labels.length) return;
        const list = [];
        for (const l of labels) {
            const label = textOf(l).trim().replace(/:$/, '');
            const left = inCol.find((c) => c[0] === l[0] && c[1] + c[3] === l[1]);
            const b = left && ix.style(left).border;
            if (left && left[3] === 1 && b.every(Boolean) && !textOf(left).trim()) { list.push({ label, dy: l[0] - table.first, box: left[1] }); continue; }
            const slot = inCol.filter((c) => c[0] === l[0] && c[1] > l[1] && !textOf(c).trim()).sort((a, b) => b[3] - a[3])[0];
            if (slot) list.push({ label, dy: l[0] - table.first, slot: slot[1], labelCol: l[1] });
        }
        if (!list.length) return;
        // A slot takes the Coretax column that names it and, among those, the one closest to
        // the form column's own heading ("NAMA" under PENERIMA PINJAMAN -> "NAMA PENERIMA PINJAMAN").
        for (const s of list.filter((x) => x.slot != null)) {
            let best = null, score = 0;
            for (const m of model) {
                if (out.consumed.has(m.i)) continue;
                const own = similarity(s.label, m.h) || (/NIK|NPWP/.test(norm(s.label)) && /IDENTITAS|\bTIN\b/.test(norm(m.h)) ? 0.5 : 0);
                if (!own) continue;
                const sc = own + 0.5 * similarity(col.head, m.h);
                if (sc > score) { score = sc; best = m.i; }
            }
            if (best != null) { s.model = best; out.consumed.add(best); }
        }
        const boxes = list.filter((x) => x.box != null);
        if (boxes.length) {
            let best = null, score = 0;
            for (const m of model) { if (out.consumed.has(m.i)) continue; const sc = similarity(col.head, m.h); if (sc > score) { score = sc; best = m.i; } }
            if (best != null) { boxes.forEach((x) => { x.model = best; }); out.consumed.add(best); }
        }
        // Kept even when no Coretax column matched: the record's slot lines are still tidied.
        out.set(k, list);
        if (list.some((x) => x.model != null)) out.valued.add(k);
    });
    return out;
}

function fillListTable(sheet, table, model, unplaced, limit) {
    let rows = model.rows.slice();
    let total = null;
    if (rows.length && isTotalRow(rows[rows.length - 1])) total = rows.pop();
    const all = rows.length;
    if (limit && rows.length > limit) rows = rows.slice(0, limit);
    const subs = subSlots(sheet, table, model.headers);
    const map = subs.valued.size
        ? columnMap(table, model.headers.map((h, i) => subs.consumed.has(i) ? 'Pilih -' : h), true, subs.valued)
        : columnMap(table, model.headers);
    // A table with no record rows of its own (OP's Ikhtisar Harta: headings, then JUMLAH) only
    // takes its total.
    if (table.end < table.first) rows = [];
    const { delta, records } = table.end < table.first ? { delta: 0, records: [] } : spliceRecords(sheet, table, rows.length);
    if (process.env.CORETAX_PER11_DEBUG) console.error("[per11] map", JSON.stringify(table.cols.map((c, k) => c.head + " <- " + (map[k] == null ? (subs.has(k) ? "SUB:" + subs.get(k).map((s) => s.label + "=" + model.headers[s.model]).join(",") : "-") : model.headers[map[k]]))));
    // Every record is tidied, the empty one an empty table prints as too: left as the template
    // drew it, its slot lines cut through "TANAH:" / "BANGUNAN:" and the ATAS NAMA boxes.
    records.forEach((_, i) => {
        const row = rows[i];
        const top = table.first + i * table.unit;
        // Labelled slots inside a column ("NIK/NPWP" / "NAMA", "TANAH:" / "BANGUNAN:") take their
        // own Coretax columns; a tick-box group ("ATAS NAMA SENDIRI") gets an X at the option
        // Coretax chose.
        for (const list of subs.values()) for (const s of list) {
            const at = (dy, c) => records[i].find((x) => x[0] === top + dy && x[1] === c);
            if (s.box != null) {
                const v = row && row[s.model];
                const pick = list.filter((o) => o.box != null).map((o) => ({ o, sc: similarity(o.label, v) })).sort((a, b) => b.sc - a.sc)[0];
                if (v && pick && pick.o === s && pick.sc > 0) { const box = at(s.dy, s.box); if (box) mark(sheet, box); }
                continue;
            }
            // The label takes the empty cells between it and its slot, and its column grows to
            // fit it ("BANGUNAN:" was cut by the template's line right after a narrow column).
            const lab = at(s.dy, s.labelCol);
            if (lab) {
                const gap = records[i].filter((x) => x[0] === top + s.dy && x[1] > lab[1] && x[1] < s.slot && x[2] === 1 && !textOf(x).trim());
                if (gap.length) {
                    lab[3] = s.slot - lab[1];
                    sheet.cells = sheet.cells.filter((x) => !gap.includes(x));
                    records[i] = records[i].filter((x) => !gap.includes(x));
                }
                const b = sheet.styles[lab[4]].border.slice(); b[1] = null;
                lab[4] = restyle(sheet, lab[4], { data: true, wrap: false, border: b });
            }
            let slot = at(s.dy, s.slot);
            // Every value of the column starts on the same line: the leftmost slot's
            // ("MEREK/MODEL"'s value used to start further right than "TIPE"'s).
            const target = Math.min(...list.filter((o) => o.slot != null).map((o) => o.slot));
            if (slot && lab && slot[1] > target && lab[1] < target && lab[1] + lab[3] <= slot[1]) {
                const between = records[i].filter((x) => x !== lab && x !== slot && x[0] === slot[0] && x[1] >= target && x[1] < slot[1] && !textOf(x).trim());
                if (between.length === records[i].filter((x) => x !== lab && x !== slot && x[0] === slot[0] && x[1] >= target && x[1] < slot[1]).length) {
                    sheet.cells = sheet.cells.filter((x) => !between.includes(x));
                    records[i] = records[i].filter((x) => !between.includes(x));
                    lab[3] = target - lab[1];
                    slot[3] += slot[1] - target;
                    slot[1] = target;
                }
            }
            if (row && slot && s.model != null) setText(sheet, slot, String(row[s.model] == null ? '' : row[s.model]).replace(MONEY_PREFIX, ''), { align: 'left' });
        }
        // Inside a labelled column only its own frame and the record's top and bottom keep a
        // line: the template's underlines under every label and value (drawn for handwriting)
        // printed as a ladder of short strokes.
        const numbersCell = sheet.cells.find((c) => c[0] === table.numbersRow && c[1] === table.cols[0].col);
        const line = (numbersCell && sheet.styles[numbersCell[4]].border.find(Boolean)) || ['thin', '#000000'];
        for (const [k, list] of subs) {
            const col = table.cols[k];
            const boxes = new Set(list.filter((o) => o.box != null).map((o) => (top + o.dy) + ':' + o.box));
            for (const c of records[i]) {
                if (c[1] < col.col || c[1] > col.right || boxes.has(c[0] + ':' + c[1])) continue;
                const b = sheet.styles[c[4]].border.slice();
                const keep = [c[0] === top, c[1] + c[3] - 1 === col.right, c[0] + c[2] - 1 === top + table.unit - 1, c[1] === col.col];
                // (frameTables leaves these cells alone: `inner`)
                c[4] = restyle(sheet, c[4], { border: b.map((x, j) => keep[j] ? x || line : null), inner: true });
            }
        }
        table.cols.forEach((col, k) => {
            // The column's value cell: the widest cell starting at its left edge, which in a
            // record several rows tall need not sit on the record's first row.
            const cell = records[i].filter((c) => c[1] === col.col && !textOf(c).trim().match(/^[A-Z]/)).sort((a, b) => (b[3] - a[3]) || (b[2] - a[2]) || (a[0] - b[0]))[0];
            if (!cell || subs.valued.has(k)) return;
            if (cell[0] > top) {
                const above = records[i].filter((x) => x[0] >= top && x[0] < cell[0] && x[1] >= cell[1] && x[1] <= cell[1] + cell[3] - 1);
                if (above.every((x) => !textOf(x).trim() && x[0] + x[2] <= cell[0])) {
                    sheet.cells = sheet.cells.filter((x) => !above.includes(x));
                    records[i] = records[i].filter((x) => !above.includes(x));
                    cell[2] += cell[0] - top;
                    cell[0] = top;
                }
            }
            if (!row) return;
            const v = map[k] == null ? (/^NO\b/.test(norm(col.head)) ? String(i + 1) : '') : row[map[k]];
            const head = norm(col.head);
            const align = /^NO\b/.test(head) || /NPWP|NIK|NOMOR|KODE|TIN\b|IDENTITAS|TANGGAL|BULAN TAHUN|TAHUN|NEGARA|MATA UANG|TARIF|JENIS PAJAK/.test(head) && !/\(RP\)|NILAI|JUMLAH|HARGA|BIAYA/.test(head) ? 'center' : looksNumeric(v) ? 'right' : 'left';
            setText(sheet, cell, String(v == null ? '' : v).replace(MONEY_PREFIX, ''), { align });
        });
    });
    const totals = total ? Object.fromEntries(table.cols.map((c, k) => [k, map[k] == null ? '' : total[map[k]]])) : model.totals && Object.keys(model.totals).length
        ? Object.fromEntries(table.cols.map((c, k) => [k, map[k] == null ? '' : model.totals[map[k]]])) : null;
    if (table.totalRow && (rows.length || (total && table.end < table.first))) {
        const tr = table.totalRow + delta;
        const blocked = (c) => sheet.styles[c[4]].bg && /^#7[0-9A-F]7[0-9A-F]7[0-9A-F]$/i.test(sheet.styles[c[4]].bg);
        table.cols.forEach((col, k) => {
            // A percentage column's total is the sum of the percentages printed above it; the
            // form's own "100%" placeholder and Coretax's fraction total both give way to it.
            const percent = /%\s*$/.test(col.head.trim()) || /PERSEN/.test(norm(col.head));
            let shown = totals ? totals[k] : null;
            if (percent && map[k] != null) {
                const parts = rows.map((row) => Number(String(row[map[k]] || '').replace(/\./g, '').replace(',', '.'))).filter((x) => Number.isFinite(x));
                const decimals = Math.max(0, ...rows.map((row) => (String(row[map[k]] || '').split(',')[1] || '').length));
                if (parts.length) shown = parts.reduce((a, b) => a + b, 0).toLocaleString('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            }
            if (shown == null || shown === '' || !looksNumeric(shown)) return;
            // A cell the form blocks out (dark fill) stays empty, even when Coretax totals it.
            const cell = sheet.cells.find((c) => c[0] === tr && c[1] <= col.col && c[1] + c[3] - 1 >= col.col && (!textOf(c).trim() || percent) && !blocked(c));
            if (cell) setText(sheet, cell, String(shown).replace(MONEY_PREFIX, ''), { right: true, bold: 'keep' });
        });
    }
    // The template's "-" placeholders in cells no value went into print empty.
    for (const rec of records) for (const c of rec) if (!sheet.styles[c[4]].data && /^[-–]$/.test(textOf(c).trim())) c[5] = '';
    if (limit && all > rows.length) addOmittedNote(sheet, table, delta, all, rows.length);
    return delta;
}

/** L1-style reconciliation: every account already has its row; values go in by account code. */
function fillCodeTable(sheet, ix, table, model, unplaced) {
    const codeRow = new Map();
    for (let y = table.first; y <= table.end; y++) for (const cell of ix.rowCells(y)) {
        if (cell[1] < table.left || cell[1] > table.right) continue;
        const t = textOf(cell).trim();
        if (/^\d{4}$/.test(t)) codeRow.set(t, { row: y, codeCol: cell[1] });
    }
    const valueCell = (row, col) => { const c = ix.cover.get(row + ':' + col); return c && !ix.style(c).bg ? c : null; };
    const sideBySide = model.headers.length === 4 && /ASET/i.test(model.headers[0]);
    for (const row of model.rows) {
        const pairs = sideBySide ? [[row[0], row[1]], [row[2], row[3]]] : [[row[0], row]];
        for (const [label, values] of pairs) {
            const code = (String(label || '').match(/^(\d{4})\b/) || [])[1];
            if (!code) continue;
            const at = codeRow.get(code);
            if (!at) {
                // In the side-by-side neraca each half is its own form table, so an account of the
                // other half is simply not here; it is placed when that half is filled.
                if (!sideBySide && values && [].concat(values).some((v) => /[1-9]/.test(v))) unplaced.push('Akun ' + code + ' tidak ada di formulir');
                continue;
            }
            if (sideBySide) {
                // The value column of whichever half the code sits in: the next numbered column right of it.
                const col = table.cols.find((c) => c.col > at.codeCol + 1 && /NILAI/.test(norm(c.head))) || table.cols.filter((c) => c.col > at.codeCol).pop();
                const cell = col && valueCell(at.row, col.col);
                const v = String(values || '').replace(MONEY_PREFIX, '').trim();
                // Brackets only for a deduction line ("Dikurangi: Akumulasi Penyusutan ..."). The
                // template also brackets 1611 Aktiva Pajak Tangguhan, which printed a plain asset as
                // if it were negative.
                const deduction = /Dikurangi|Akumulasi|Cadangan/i.test(String(label || ''));
                if (cell) setText(sheet, cell, deduction && /^\(.*\)$/.test(textOf(cell).trim()) && v && !v.startsWith('-') ? '(' + v + ')' : v, { right: true, wrap: false, bold: 'keep' });
            } else {
                const map = columnMap(table, model.headers);
                table.cols.forEach((col, k) => {
                    if (k < 2 || map[k] == null) return; // code and name are printed by the form itself
                    const cell = valueCell(at.row, col.col);
                    const v = values[map[k]];
                    if (cell && v != null && String(v).trim() !== '') setText(sheet, cell, String(v).replace(MONEY_PREFIX, ''), { align: /KODE/.test(norm(col.head)) ? 'center' : looksNumeric(v) ? 'right' : 'left', wrap: false, bold: 'keep' });
                });
            }
        }
    }
    // Tidy the account rows: the template mixes 15pt and 16.5pt rows and bottom/top alignment,
    // which prints as uneven lines where the code, the name and the amounts do not line up.
    const heights = sheet.rows.slice(table.first - 1, table.end);
    const mode = [...heights.reduce((m, h) => m.set(h, (m.get(h) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
    for (let y = table.first; y <= table.end; y++) sheet.rows[y - 1] = mode;
    for (const c of sheet.cells) if (c[0] >= table.first && c[0] <= table.end && c[1] >= table.left && c[1] <= table.right && sheet.styles[c[4]].v !== 'middle') c[4] = restyle(sheet, c[4], { v: 'middle' });
}

/* ---------------------------------------------------------------- forms & answers */
/** "1. PENGHASILAN ..." -> value box of the form line numbered 1 whose wording matches. */
function fillFields(sheet, ix, fields, unplaced) {
    const lines = [];
    for (let r = 1; r <= sheet.rows.length; r++) {
        const cells = ix.rowCells(r);
        const labelCell = cells.find((c) => /[A-Za-z]{3}/.test(textOf(c)) && !/^\(\d+\)/.test(textOf(c).trim()));
        if (!labelCell) continue;
        const marker = cells.find((c) => c[1] < labelCell[1] && /^\d+[a-z]?\.?$/i.test(textOf(c).trim()));
        const box = cells.filter((c) => c[1] > labelCell[1] && ix.boxed(c) && !textOf(c).trim() && c[3] >= 3).pop();
        // OP's L4 has no drawn boxes: its value cells are wide unshaded cells that held formulas.
        // Several of them on one line are the columns of a two-column form (WAJIB PAJAK, SUAMI/ISTRI).
        const open = cells.filter((c) => c[1] > labelCell[1] + labelCell[3] - 1 && !textOf(c).trim() && c[3] >= 3 && !ix.style(c).bg);
        const slots = box ? [box] : open;
        // A date is written one digit per box (L10-D: dd mm yyyy).
        const digits = cells.filter((c) => c[1] > labelCell[1] && ix.boxed(c) && !textOf(c).trim() && c[3] === 1);
        if (slots.length || digits.length >= 8 || marker) lines.push({ r, marker: marker ? textOf(marker).trim().replace(/\.$/, '') : '', label: textOf(labelCell), box: slots[slots.length - 1], slots, digits });
    }
    for (const [label, value, ...more] of fields) {
        // 01-01-1970 is how Coretax shows an empty date field.
        if (value == null || String(value).trim() === '' || /^(Ya|Tidak|TidakYa|YaTidak)$/i.test(String(value).trim()) || /^01-01-1970$/.test(String(value).trim())) continue;
        const num = (String(label).match(/^\s*(\d+[a-z]?)\.\s/i) || [])[1] || '';
        const bare = String(label).replace(/^\s*\d+[a-z]?\.\s*/i, '');
        let best = null, score = 0.45;
        for (const line of lines) {
            if (line.used) continue;
            const s = similarity(bare, line.label) + (num && line.marker === num ? 0.3 : 0);
            if (s > score) { score = s; best = line; }
        }
        let v = String(value).replace(MONEY_PREFIX, '').trim();
        // PTKP comes as "K/I/0 = 112500000": the status goes in the form's status box (replacing
        // the template's sample "K/I/0" / "-"), the amount in the value column.
        const ptkp = v.match(/^((?:TK|K|K\/I|HB)\/\d)\s*=\s*(\d+)$/);
        if (ptkp && best) {
            const statusBox = sheet.cells.find((c) => c[0] === best.r && /^(-|(?:TK|K|K\/I|HB)\/\d)$/.test(textOf(c).trim()));
            if (statusBox) setText(sheet, statusBox, ptkp[1], { align: 'center', wrap: false });
            v = Number(ptkp[2]).toLocaleString('id-ID');
        } else if (best && v === '-/-') {
            const statusBox = sheet.cells.find((c) => c[0] === best.r && /^(-|(?:TK|K|K\/I|HB)\/\d)$/.test(textOf(c).trim()));
            if (statusBox) setText(sheet, statusBox, '-', { align: 'center', wrap: false });
        }
        const date = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (best && date && best.digits && best.digits.length >= 8) {
            // Printed the way Coretax prints a date - one field, "30-04-2026" - rather than eight
            // loose digit boxes with gaps between the day, month and year groups.
            best.used = true;
            const first = best.digits[0], last = best.digits[best.digits.length - 1];
            const span = last[1] + last[3] - first[1];
            sheet.cells = sheet.cells.filter((c) => !(c[0] === first[0] && c !== first && c[1] > first[1] && c[1] < first[1] + span));
            first[3] = span;
            setText(sheet, first, date[1] + '-' + date[2] + '-' + date[3], { align: 'center', wrap: false });
            // The "tanggal / bulan / tahun" captions over the boxes no longer have boxes to label.
            for (const c of sheet.cells) if (c[0] < first[0] && c[0] >= first[0] - 2 && /^(tanggal|bulan|tahun)$/i.test(textOf(c).trim())) c[5] = '';
        } else if (best && /^\d{15,16}$/.test(v) && best.digits && best.digits.length >= 15) {
            // An NIK/NPWP next to its row of digit boxes goes one digit per box, not into the
            // signature box further along the same line.
            best.used = true;
            v.split('').forEach((d, i) => { const cell = best.digits[i]; if (cell) { cell[5] = d; cell[4] = restyle(sheet, cell[4], { h: 'center', v: 'middle', color: '#000000' }); } });
        } else if (best && more.length && best.slots.length > 1) {
            best.used = true;
            [value, ...more].forEach((x, i) => { const cell = best.slots[i]; const t = String(x == null ? '' : x).replace(MONEY_PREFIX, '').trim(); if (cell && t) setText(sheet, cell, t, { right: looksNumeric(t), wrap: false, bold: 'keep' }); });
        } else if (best && best.box) { best.used = true; if (v) setText(sheet, best.box, v, { right: looksNumeric(v) || /^-\/-$|^-$/.test(v), wrap: false, bold: 'keep' }); }
        else if (best && v) {
            // A numbered line the template left without a value cell (OP L4 "7. PPh TERUTANG
            // GABUNGAN"): it takes the value column of the nearest numbered line that has one.
            const near = lines.filter((l) => l.box).sort((a, b) => Math.abs(a.r - best.r) - Math.abs(b.r - best.r))[0];
            if (near) {
                best.used = true;
                sheet.cells = sheet.cells.filter((c) => !(c[0] === best.r && c[1] >= near.box[1] && c[1] < near.box[1] + near.box[3]));
                const cell = [best.r, near.box[1], 1, near.box[3], near.box[4], ''];
                sheet.cells.push(cell);
                setText(sheet, cell, v, { right: looksNumeric(v), wrap: false, bold: 'keep' });
            } else unplaced.push(label + ': ' + v);
        }
        else if (/[1-9]/.test(v)) unplaced.push(label + ': ' + v);
    }
}

function mark(sheet, cell) { cell[5] = 'X'; cell[4] = restyle(sheet, cell[4], { h: 'center', v: 'center', bold: true, color: '#000000', font: 'Arial', size: 9 }); }

function fillAnswers(sheet, ix, answers, unplaced) {
    if (!answers) return;
    const statements = sheet.cells.filter((c) => textOf(c).trim().length > 8);
    const find = (question, used) => {
        let best = null, score = 0.5;
        for (const c of statements) { if (used.has(c)) continue; const s = similarity(question, textOf(c)); if (s > score) { score = s; best = c; } }
        return best;
    };
    const used = new Set();
    for (const g of answers.radios || []) {
        if (!g.chosen || !g.question) continue;
        const st = find(g.question.replace(/^[a-z]\.\s*/i, ''), used);
        if (!st) { unplaced.push('Jawaban "' + g.chosen + '": ' + g.question.slice(0, 60)); continue; }
        used.add(st);
        let done = false;
        for (let y = st[0]; y <= st[0] + 3 && !done; y++) {
            const cells = ix.rowCells(y);
            const label = cells.find((c) => norm(textOf(c)) === norm(g.chosen) && c[1] > st[1] - 3);
            if (!label) continue;
            const box = cells.filter((c) => c[1] < label[1] && ix.boxed(c) && !textOf(c).trim()).pop();
            if (box) { mark(sheet, box); done = true; }
        }
        if (!done) unplaced.push('Kotak "' + g.chosen + '" tidak ditemukan: ' + g.question.slice(0, 60));
    }
    for (const chk of answers.checks || []) {
        if (!chk.checked) continue;
        const st = find(chk.label, used);
        if (!st) { unplaced.push('Centang: ' + chk.label.slice(0, 60)); continue; }
        used.add(st);
        const box = ix.rowCells(st[0]).filter((c) => c[1] < st[1] && ix.boxed(c) && !textOf(c).trim()).pop();
        if (box) mark(sheet, box); else unplaced.push('Kotak centang tidak ditemukan: ' + chk.label.slice(0, 60));
    }
}

/** Lines the form labels with a letter pointer (the yellow "a", "b", "c" arrows) and ties together
 *  with its own arithmetic: L3 "JUMLAH KREDIT PAJAK ( a + b )", "KREDIT PAJAK LUAR NEGERI (Diisi dari
 *  Bagian A.c ...)". Coretax does not send those derived figures, so they are worked out here from
 *  the figures the form already shows - the form's formula, not a change to the data. */
function fillLetterFormulas(sheet) {
    const ix = index(sheet);
    const num = (t) => { const s = String(t || '').replace(MONEY_PREFIX, '').trim(); if (!/^-?[\d.]+(,\d+)?$/.test(s)) return null; return Number(s.replace(/\./g, '').replace(',', '.')); };
    const fmt = (v) => (v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('id-ID');
    // Section of a row: the letter of the nearest dark bar above it ("A.", "B.").
    const sectionOf = (r) => {
        for (let y = r; y >= 1; y--) {
            const bar = ix.rowCells(y).find((c) => /^[A-Z]\.$/.test(textOf(c).trim()) && ix.style(c).bg);
            if (bar) return textOf(bar).trim()[0];
        }
        return '';
    };
    const markers = [];
    for (const s of sheet.shapes || []) {
        const t = s.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('').trim();
        if (!/^[a-z]$/.test(t) || !s.from) continue;
        markers.push({ letter: t, row: s.from.row + 1, col: s.from.col + 1, section: sectionOf(s.from.row + 1) });
    }
    const bySection = new Map();
    for (const m of markers) { if (!bySection.has(m.section)) bySection.set(m.section, []); bySection.get(m.section).push(m); }
    const valueCellAt = (row, col) => sheet.cells.find((c) => c[0] === row && c[1] <= col && c[1] + c[3] - 1 >= col);
    const results = new Map(); // "A.c" -> number
    // Sections top to bottom, so a reference like "Bagian A.c" is known before it is used.
    const order = [...bySection.keys()].sort((a, b) => Math.min(...bySection.get(a).map((m) => m.row)) - Math.min(...bySection.get(b).map((m) => m.row)));
    for (const section of order) {
        const list = bySection.get(section);
        // The section's value column: where the white value boxes of its marked lines are.
        // Taken from the last marked line (the result line): the first one can sit on a JUMLAH row
        // whose nearest white cell is another column (L3-B's "a" arrow stands before the DPP total).
        let valueCol = 0;
        for (const m of list.slice().sort((a, b) => b.row - a.row)) {
            const box = ix.rowCells(m.row).find((c) => c[1] > m.col && !ix.style(c).bg && ix.style(c).border.some(Boolean));
            if (box) { valueCol = box[1]; break; }
        }
        if (!valueCol) continue;
        const cellOf = (m) => valueCellAt(m.row, valueCol);
        for (const m of list.sort((a, b) => a.row - b.row)) {
            const cell = cellOf(m);
            if (!cell) continue;
            let v = num(textOf(cell));
            const rowText = ix.rowCells(m.row).map(textOf).join(' ');
            if (v == null) {
                const ref = rowText.match(/Bagian\s+([A-Z])\.([a-z])/i);
                const formula = ix.rowCells(m.row).filter((c) => c[1] < valueCol && /^[()+\-x]$|^[a-z]$/i.test(textOf(c).trim())).map((c) => textOf(c).trim()).join(' ');
                if (ref && results.has(ref[1].toUpperCase() + '.' + ref[2])) v = results.get(ref[1].toUpperCase() + '.' + ref[2]);
                else if (/\(\s*[a-z]\s*[+\-]\s*[a-z]/.test(formula)) {
                    const terms = formula.replace(/[()]/g, ' ').trim().split(/\s+/);
                    let acc = 0, sign = 1, ok = true;
                    for (const t of terms) {
                        if (t === '+') sign = 1; else if (t === '-') sign = -1;
                        else if (/^[a-z]$/.test(t)) { const x = results.get(section + '.' + t); if (x == null) { ok = false; break; } acc += sign * x; }
                    }
                    if (ok) v = acc;
                }
                if (v != null) setText(sheet, cell, fmt(v), { right: true, bold: 'keep', wrap: false });
            }
            if (v != null) results.set(section + '.' + m.letter, v);
        }
    }
}

/** OP's numbered total lines add up earlier numbered lines: "JUMLAH TABEL E (16) + (17)" is the
 *  sum of the lines whose yellow marker reads 16 and 17. A line with no value (17 comes from
 *  Lampiran 2, another tab) counts as nothing; the result is written only when some term is known. */
function fillNumberedSums(sheet) {
    const ix = index(sheet);
    const num = (t) => { const v = String(t || '').trim(); return /^-?[\d.]+(,\d+)?$/.test(v) ? Number(v.replace(/\./g, '').replace(',', '.')) : null; };
    const marked = (r) => ix.rowCells(r).find((c) => /^#FF(C000|D600)$/i.test(ix.style(c).bg || '') && /^[\dA-Z]{1,3}$/.test(textOf(c).trim()));
    const valueOf = (r) => { const m = marked(r); return m && ix.rowCells(r).find((c) => c[1] > m[1] && !ix.style(c).bg && ix.style(c).border.some(Boolean)); };
    const rowOfMarker = new Map();
    for (let r = 1; r <= sheet.rows.length; r++) { const m = marked(r); if (m) rowOfMarker.set(textOf(m).trim(), r); }
    for (let r = 1; r <= sheet.rows.length; r++) {
        const f = ix.rowCells(r).map(textOf).join(' ').match(/\((\d+)\)\s*\+\s*\((\d+)\)/);
        const cell = f && valueOf(r);
        if (!cell || textOf(cell).trim()) continue;
        const terms = [f[1], f[2]].map((k) => { const y = rowOfMarker.get(k); const c = y && valueOf(y); return c ? num(textOf(c)) : null; });
        if (terms.every((t) => t == null)) continue;
        const v = terms.reduce((a, t) => a + (t || 0), 0);
        setText(sheet, cell, (v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('id-ID'), { right: true, bold: 'keep', wrap: false });
    }
}

/** L11-B part II.C writes the debt-to-equity ratio as a fraction with dotted blanks:
 *  Jumlah Saldo Rata-Rata Utang / Jumlah Saldo Rata-Rata Modal = x : 1. The two averages are the
 *  RATA-RATA of the utang and modal tables' totals, exactly as Coretax shows them. */
function fillDer(sheet, ix, tables) {
    const average = (re) => { const t = tables.find((m) => re.test(m.title || '')); const total = t && t.rows.find(isTotalRow); return total ? String(total[total.length - 1]).replace(MONEY_PREFIX, '').trim() : ''; };
    const debt = average(/UTANG/i), equity = average(/MODAL/i);
    if (!debt || !equity) return;
    const num = (s) => Number(s.replace(/\./g, '').replace(',', '.'));
    const blankRight = (label) => { const cell = sheet.cells.find((c) => /Jumlah Saldo Rata-Rata/i.test(textOf(c)) && label.test(textOf(c))); if (!cell) return null; return ix.rowCells(cell[0]).find((c) => c[1] > cell[1] && /^[.…\s]{3,}$/.test(textOf(c))); };
    const top = blankRight(/Utang/i), bottom = blankRight(/Modal/i);
    if (top) setText(sheet, top, debt, { wrap: false, align: 'center' });
    if (bottom) setText(sheet, bottom, equity, { wrap: false, align: 'center' });
    if (top) {
        const blanks = ix.rowCells(top[0]).filter((c) => c[1] > top[1] && /^[.…\s]{3,}$/.test(textOf(c)));
        // With no equity the ratio is undefined: "-" on both sides, not "0 / 0 = :" left hanging.
        const ratio = num(equity) ? (num(debt) / num(equity)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
        if (blanks[0]) setText(sheet, blanks[0], ratio, { wrap: false });
        if (blanks[1]) setText(sheet, blanks[1], num(equity) ? '1' : '-', { wrap: false });
    }
}

/* ---------------------------------------------------------------- compact PDF */
// The compact PDF ("ringkas") prints the first rows of each list and says how many it left out;
// the JUMLAH line still totals every row, and the Excel keeps them all.
const omittedText = (all, shown) => 'Ditampilkan ' + shown.toLocaleString('id-ID') + ' dari ' + all.toLocaleString('id-ID') + ' baris. '
    + (all - shown).toLocaleString('id-ID') + ' baris lainnya tidak ditampilkan dalam PDF ringkas; rincian lengkap tersedia pada unduhan Excel. Jumlah tetap mencakup seluruh baris.';
// Boxed like a table row, so the column lines and the table's frame run on unbroken.
const noteStyle = (sheet, base) => { const line = (sheet.styles[base].border.find(Boolean) || ['thin', '#000000'])[1]; return restyle(sheet, base, { bg: '#F4F4EE', border: [['thin', line], ['thin', line], ['thin', line], ['thin', line]], bold: false, italic: false, size: 7.5, h: 'left', v: 'middle', wrap: false, color: '#000000', data: false }); };
function addOmittedNote(sheet, table, delta, all, shown) {
    // Right after the last printed record, above the JUMLAH line that still totals every row.
    const at = table.first + shown * table.unit;
    shiftRows(sheet, at, 1);
    const base = sheet.cells.find((c) => c[0] === table.numbersRow)[4];
    sheet.cells.push([at, table.left, 1, table.right - table.left + 1, noteStyle(sheet, base), omittedText(all, shown)]);
    sheet.rows[at - 1] = 14;
}

/* ---------------------------------------------------------------- outline lists (L9) */
const numbersCellsOf = (sheet, ix, table) => table.cols.map((col) => ix.at.get(table.numbersRow + ':' + col.col));
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
        const all = rows.length;
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
        if (all > rows.length) {
            shiftRows(sheet, p + rows.length, 1);
            sheet.cells.push([p + rows.length, table.left, 1, table.right - table.left + 1, noteStyle(sheet, numbersCells[0][4]), omittedText(all, rows.length)]);
            sheet.rows[p + rows.length - 1] = 14;
        }
    }
    return true;
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
        for (let r = h.from; r <= bottom && r <= sheet.rows.length; r++) {
            const lead = sheet.cells.find((c) => c[0] === r && c[1] === first.left);
            if (!lead) continue;
            const margin = sheet.cells.filter((c) => c[0] === r && c[1] >= barLeft && c[1] < first.left);
            // (its lines are only the table's own left edge, which the widened cell carries anyway)
            if (margin.some((c) => textOf(c).trim() || c[2] > 1 || ix.style(c).bg)) continue;
            if (sheet.cells.some((c) => c[0] < r && c[0] + c[2] - 1 >= r && c[1] < first.left && c[1] + c[3] - 1 >= barLeft)) continue;
            // The table's left line was stored as the margin cell's right border: it moves with the
            // cell that now starts at the bar's edge.
            const edgeLine = margin.map((c) => ix.style(c).border[1]).find(Boolean) || ix.style(lead).border[3];
            sheet.cells = sheet.cells.filter((c) => !margin.includes(c));
            lead[3] += first.left - barLeft;
            lead[1] = barLeft;
            if (edgeLine) { const st = sheet.styles[lead[4]]; lead[4] = restyle(sheet, lead[4], { border: [st.border[0], st.border[1], st.border[2], edgeLine] }); }
        }
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
    const ix = index(sheet);
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
            const texted = sheet.cells.filter((c) => c[0] === y && inTable(c) && textOf(c).trim());
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

/* ---------------------------------------------------------------- entry */
/** `data`: { npwp, year, tables: [{title, headers, rows, totals}], fields: [[label, value]], answers } */
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

function fillSheet(compiled, data) {
    const sheet = cloneSheet(compiled);
    // The workbook's navigation buttons ("HOME", bright yellow, two rows tall, their caption a
    // hyperlink the compile drops) are not part of the form.
    sheet.cells = sheet.cells.filter((c) => !(sheet.styles[c[4]].bg === '#FFFF00' && c[2] >= 2 && !textOf(c).trim()));
    dropLookupLists(sheet);
    trimMargins(sheet);
    // The form's body font and ink: whatever most of its wording below the kop is set in.
    const tally = (pick) => { const n = new Map(); for (const c of sheet.cells) { if (c[0] <= 10 || !textOf(c).trim()) continue; const v = pick(sheet.styles[c[4]]); if (v) n.set(v, (n.get(v) || 0) + 1); } return [...n].sort((a, b) => b[1] - a[1])[0]?.[0]; };
    sheet.bodyFont = tally((st) => st.font);
    sheet.bodyColor = tally((st) => st.color);
    const unplaced = [];
    fillKop(sheet, index(sheet), data);
    flushBadge(sheet);
    plainKop(sheet);
    fillAnswers(sheet, index(sheet), data.answers, unplaced);
    // An outline list (L9) is filled group by group, its summary lines in the table's own column.
    if (fillOutline(sheet, data.tables || [], unplaced, data.limit)) {
        fillSummaryLines(sheet, data.fields || [], unplaced);
        for (const c of sheet.cells) if (/^[.…\s]{3,}$/.test(textOf(c))) c[5] = '';
        flushTables(sheet);
        frameTables(sheet);
        compactForm(sheet);
        return { sheet, unplaced };
    }
    fillFields(sheet, index(sheet), data.fields || [], unplaced);
    // Tables bottom-up, so growing one never moves another that is still to be filled.
    const tables = findTables(sheet, index(sheet));
    const modelTables = (data.tables || []).slice();
    const pairs = [];
    const usedModels = new Set();
    for (const table of tables) {
        let best = -1, score = -1;
        // The section line above the table ("4. HARTA BERGERAK", "E. DAFTAR BUKTI ...") names it
        // the way Coretax titles its tables: OP's L-1 holds tables whose columns look alike
        // (Harta Bergerak vs Harta Lainnya), and columns alone swapped them.
        const title = tableTitle(sheet, index(sheet), table);
        modelTables.forEach((m, i) => {
            if (usedModels.has(i)) return;
            const heads = cleanHeaders(m.headers).map((x) => x.h).join(' ');
            const named = title && m.title ? similarity(title.replace(/^\S+\s*/, ''), String(m.title).replace(/^\S+\s*/, '')) + (title.split(' ')[0] === String(m.title).trim().split(/\s+/)[0] ? 0.5 : 0) : 0;
            const s = named + similarity(heads, table.cols.map((c) => c.head).join(' ')) + (cleanHeaders(m.headers).length === table.cols.length ? 0.25 : 0) + (table.fixed && /KODE AKUN|ASET/i.test(heads) ? 0.3 : 0);
            if (s > score) { score = s; best = i; }
        });
        if (process.env.CORETAX_PER11_DEBUG) console.error('[per11] form table "' + title + '" <- "' + (best >= 0 ? modelTables[best].title : '') + '" (' + score.toFixed(2) + ')');
        if (best >= 0 && score > 0.2) { usedModels.add(best); pairs.push({ table, model: modelTables[best] }); }
    }
    // The neraca is one Coretax table printed as two side-by-side form tables.
    const neraca = modelTables.find((m) => m.headers.length === 4 && /ASET/i.test(m.headers[0]));
    for (const table of tables) if (table.fixed && neraca && !pairs.some((p) => p.table === table)) pairs.push({ table, model: neraca });
    for (const { table, model } of pairs.sort((a, b) => b.table.first - a.table.first)) {
        if (table.fixed) fillCodeTable(sheet, index(sheet), table, model, unplaced);
        else fillListTable(sheet, table, model, unplaced, data.limit);
    }
    // A tab can span several sheets (OP "L-1" = L1-1, L1-2, L1-3): the caller passes the tables
    // no earlier sheet took, and gets back which ones this sheet used.
    const used = pairs.map((p) => p.model);
    if (!data.partOfTab) modelTables.forEach((m, i) => { if (!usedModels.has(i) && m !== neraca && m.rows.length) unplaced.push('Tabel "' + (m.title || '') + '" (' + m.rows.length + ' baris) tidak punya tempat di formulir'); });
    fillDer(sheet, index(sheet), data.tables || []);
    fillLetterFormulas(sheet);
    fillNumberedSums(sheet);
    evenPairs(sheet);
    frameWindows(sheet);
    mergeHeadings(sheet);
    flushTables(sheet);
    frameTables(sheet);
    compactForm(sheet);
    // Leftover "……" placeholders are the form's blanks, not text: print them empty.
    for (const c of sheet.cells) if (/^[.…\s]{3,}$/.test(textOf(c))) c[5] = '';
    return { sheet, unplaced, used };
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

module.exports = { fillSheet, findTables, similarity, sheetRegions };
