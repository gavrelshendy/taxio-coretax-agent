/* PER-11 fill (lib/lampiran-per11-fill.js): finding the form's tables and filling them - list
 * tables record by record, code tables (L1) account by account; the compact PDF's omitted-rows note. */
// Runs in Node: numbers go through lib/id-number.js, because the exe's Node has no Indonesian locale
// data and toLocaleString('id-ID') would print computed totals as "1,234,567".
const idNumber = require('./id-number');
const { norm, textOf, MONEY_PREFIX, similarity, index, rowsOf, restyle, mark, shiftRows } = require('./lampiran-per11-sheet');

/* ---------------------------------------------------------------- tables */
const NUMBERS = /^\(\d+\)/;
/** Every table in the sheet, found from its column-number row "(1). (2). ...". */
function findTables(sheet, ix) {
    const tables = [];
    // Nothing below changes the sheet: rows bucketed once (rowsOf), same cells and order as ix.rowCells.
    const rowCells = rowsOf(sheet).cells;
    const spanning = sheet.cells.filter((cell) => cell[2] > 1);
    for (let r = 1; r <= sheet.rows.length; r++) {
        const numbered = rowCells(r).filter((cell) => NUMBERS.test(textOf(cell).trim()));
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
            cols.forEach((c) => { c.head = headRows.map((y) => rowCells(y).filter((cell) => cell[1] <= c.col && cell[1] + cell[3] - 1 >= c.col).map(textOf).join(' ')).join(' ').replace(/\s+/g, ' ').trim(); });
            let end = first - 1, totalRow = 0, codes = 0;
            for (let y = first; y <= sheet.rows.length; y++) {
                const cells = rowCells(y).filter((cell) => cell[1] >= left && cell[1] <= right);
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
                if (sheet.rows[y - 1] <= 5 && !texts.some(Boolean) && !spanning.some((cell) => cell[0] < y && cell[0] + cell[2] > y && cell[1] >= left && cell[1] <= right)) break;
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
    // fullCount: the table was cut down before rendering (over 1.000 rows, lib/lampiran-big-table.js).
    const all = Math.max(rows.length, model.fullCount || 0);
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
                if (parts.length) shown = idNumber.fixed(parts.reduce((a, b) => a + b, 0), decimals);
            }
            if (shown == null || shown === '' || !looksNumeric(shown)) return;
            // A cell the form blocks out (dark fill) stays empty, even when Coretax totals it.
            const cell = sheet.cells.find((c) => c[0] === tr && c[1] <= col.col && c[1] + c[3] - 1 >= col.col && (!textOf(c).trim() || percent) && !blocked(c));
            if (cell) setText(sheet, cell, String(shown).replace(MONEY_PREFIX, ''), { right: true, bold: 'keep' });
        });
    }
    // The template's "-" placeholders in cells no value went into print empty.
    for (const rec of records) for (const c of rec) if (!sheet.styles[c[4]].data && /^[-–]$/.test(textOf(c).trim())) c[5] = '';
    if ((limit || model.fullCount) && all > rows.length) addOmittedNote(sheet, table, delta, all, rows.length, model.fullSheet || !!model.fullCount);
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

/* ---------------------------------------------------------------- compact PDF */
// The compact PDF ("ringkas") prints the first rows of each list and says how many it left out;
// the JUMLAH line still totals every row, and the Excel keeps them all.
// `big`: the table is over 1.000 rows (lib/lampiran-big-table.js) - every row is on a sheet of the
// lampiran's Excel, which is always written for such a table; `big` may name that sheet ("L3 lengkap").
const omittedText = (all, shown, big = false) => 'Ditampilkan baris 1–' + idNumber.money(shown) + ' dari ' + idNumber.money(all) + ' baris. '
    + idNumber.money(all - shown) + (big
        ? ' baris lainnya tidak dimuat dalam PDF (tabel lebih dari 1.000 baris); seluruh baris ada di ' + (typeof big === 'string' && big ? 'sheet "' + big + '" pada ' : '') + 'file Excel lampiran. Jumlah tetap mencakup seluruh baris.'
        : ' baris lainnya tidak ditampilkan dalam PDF ringkas; rincian lengkap tersedia pada unduhan Excel. Jumlah tetap mencakup seluruh baris.');
// Boxed like a table row, so the column lines and the table's frame run on unbroken.
const noteStyle = (sheet, base) => { const line = (sheet.styles[base].border.find(Boolean) || ['thin', '#000000'])[1]; return restyle(sheet, base, { bg: '#F4F4EE', border: [['thin', line], ['thin', line], ['thin', line], ['thin', line]], bold: false, italic: false, size: 7.5, h: 'left', v: 'middle', wrap: false, color: '#000000', data: false }); };
function addOmittedNote(sheet, table, delta, all, shown, big = false) {
    // Right after the last printed record, above the JUMLAH line that still totals every row.
    const at = table.first + shown * table.unit;
    shiftRows(sheet, at, 1);
    const base = sheet.cells.find((c) => c[0] === table.numbersRow)[4];
    sheet.cells.push([at, table.left, 1, table.right - table.left + 1, noteStyle(sheet, base), omittedText(all, shown, big)]);
    sheet.rows[at - 1] = 14;
}

module.exports = { findTables, tableTitle, isTotalRow, cleanHeaders, columnMap, setText, looksNumeric, fillListTable, fillCodeTable, omittedText, noteStyle };
