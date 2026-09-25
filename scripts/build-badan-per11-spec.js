/* Generator (run by hand, not at runtime): reads the official PER-11/PJ/2025 SPT Tahunan PPh Badan
 * Excel template and writes lib/lampiran-badan-per11.json - the column/section layout the "formal"
 * PDF renderer (lib/lampiran-layout-op-formal.js, shared with SPT OP) fills Coretax data into.
 *
 *   node scripts/build-badan-per11-spec.js ["path/to/5 Formulir SPT Tahunan PPh Badan....xlsx"]
 *
 * Same table-extraction approach as scripts/build-op-per11-spec.js (anchored on each table's
 * "(1) (2) (3)..." numbering row), but the header chrome differs from OP's:
 *  - no lettered A/B/C/D/E section-index box (each sheet is its own self-contained lampiran -
 *    Coretax's tabs map 1:1 to sheets here, unlike OP where one tab bundles several sheets);
 *  - no "LAMPIRAN n / HALAMAN n" badge text (`lampiran`/`halaman` are left blank; the renderer
 *    already falls back to "LAMPIRAN <tab label>" when `spec.lampiran` is empty);
 *  - the PERHATIAN paragraph sits in ONE cell as "PERHATIAN <full sentence>" rather than OP's
 *    "PERHATIAN:" label cell + separate sentence cell, so the label/content split is detected
 *    generically instead of assumed.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { shapesBySheet } = require('../lib/xlsx-drawing');

const SHEETS = [
    'L1A', 'L1B', 'L1C', 'L1D', 'L1E', 'L1F', 'L1G', 'L1H', 'L1I', 'L1J', 'L1K', 'L1L',
    'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9',
    'L10A', 'L10B', 'L10C', 'L10D',
    'L11A', 'L11B', 'L11C',
    'L12A', 'L12B',
    'L13A', 'L13B', 'L13C',
    'L14',
];
const DEFAULT_XLSX = path.join(__dirname, '..', 'templates', 'spt-tahunan-badan-per11.xlsx');

const txt = (v) => {
    if (v && typeof v === 'object') v = v.richText ? v.richText.map((t) => t.text).join('') : (v.result !== undefined ? v.result : '');
    return String(v ?? '').replace(/\s+/g, ' ').trim();
};
const addr = (a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return { col: n, row: +m[2] }; };

function mergeIndex(ws) {
    const merges = (ws.model.merges || []).map((rng) => {
        const [a, b] = rng.split(':');
        const A = addr(a), B = addr(b);
        return { top: A.row, left: A.col, bottom: B.row, right: B.col };
    });
    return (row, col) => merges.find((m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) || { top: row, left: col, bottom: row, right: col };
}

/* The kop's own wording, taken from the sheet rather than assumed:
 *  - the gold badge ("LAMPIRAN 13C") is a floating text box, so it comes from the drawing XML -
 *    printing "LAMPIRAN " + the Coretax tab label instead gave "LAMPIRAN L13-C";
 *  - the line under "DALAM MATA UANG RUPIAH" names the lampiran ("DAFTAR PPh YANG DIPOTONG/
 *    DIPUNGUT OLEH PIHAK LAIN"), sometimes bulleted with a Wingdings square exceljs reads as "n".
 *    The kop used to print a fixed "REKONSILIASI LAPORAN KEUANGAN", which is only ever right for
 *    the L1 family. */
function kopFrom(ws, shapes, txtOf, spanAt, name) {
    // L13A carries two badges stacked at the same spot - a leftover "LAMPIRAN 13C" underneath the
    // real "LAMPIRAN 13A". Excel shows the last one in the drawing, and the sheet's own name settles
    // it either way, so the badge matching the sheet wins and the last drawn one is the fallback.
    const badges = (shapes || []).map((s) => String(s.text || '').replace(/\s+/g, ' ').trim())
        .filter((t) => /^LAMPIRAN\s+\S+$/i.test(t));
    const want = String(name || '').replace(/^L/i, '').toUpperCase();
    const badge = badges.find((t) => t.replace(/^LAMPIRAN\s+/i, '').toUpperCase() === want) || badges[badges.length - 1] || '';
    let anchor = null, subtitle = '';
    for (let r = 1; r <= 10 && !anchor; r++) {
        for (let c = 1; c <= 40; c++) {
            if (/^DALAM MATA UANG/i.test(txtOf(ws.getRow(r).getCell(c).value))) { anchor = { r, c }; break; }
        }
    }
    if (anchor) {
        for (let r = anchor.r + 1; r <= anchor.r + 3 && !subtitle; r++) {
            for (let c = Math.max(1, anchor.c - 1); c <= 44; c++) {
                const span = spanAt(r, c);
                const t = txtOf(ws.getRow(span.top).getCell(span.left).value).replace(/\s+/g, ' ').trim();
                if (t.length > 8 && !/^PERHATIAN\b/i.test(t) && !/^TAHUN PAJAK/i.test(t) && !/^NPWP/i.test(t)) {
                    subtitle = t.replace(/^n\s+/, '').trim();
                    break;
                }
            }
        }
    }
    return { badge, subtitle };
}

/* Several lampiran are not lists at all: L6, L8, L10-B, L10-D and L12-A are calculation forms -
 * numbered lines with a caption and one value box each, under a "NILAI (Rp)" heading - and L11-B
 * ends with a block of them. The table extractor only recognises grids anchored on a "(1) (2) (3)"
 * numbering row, so those sheets produced no spec at all and the renderer fell back to printing
 * whatever plain tables Coretax happened to expose. This reads the lines instead: marker, caption,
 * the parenthetical formula under it, and the footnotes at the bottom. */
function fieldForm(ws, spanAt, lastRow, txtOf) {
    const at = (r, c) => { const s = spanAt(r, c); return { text: txtOf(ws.getRow(s.top).getCell(s.left).value), span: s }; };
    let head = null;
    for (let r = 1; r <= 30 && !head; r++) {
        for (let c = 1; c <= 60; c++) {
            const cell = at(r, c);
            if (/^NILAI\b/i.test(cell.text)) { head = { row: r, label: cell.text, left: cell.span.left, right: cell.span.right }; break; }
        }
    }
    if (!head) return null;

    const items = [], notes = [];
    let footnotes = false;
    for (let r = head.row + 1; r <= lastRow; r++) {
        let marker = '', after = 0, label = '';
        for (let c = 1; c <= 10; c++) {
            const cell = at(r, c);
            if (!cell.text || cell.span.top !== r) continue;
            // "Keterangan:" and any "*)" line start the footnote block under the form.
            if (/^KETERANGAN\s*:?$/i.test(cell.text) || /^\*+\)$/.test(cell.text)) { footnotes = true; break; }
            if (/^(\d{1,2}|[a-z]\.)$/i.test(cell.text)) { marker = cell.text; after = cell.span.right; }
            else { label = cell.text; after = cell.span.right; }
            break;
        }
        if (footnotes) {
            for (let c = 1; c <= 20; c++) {
                const cell = at(r, c);
                if (cell.text && cell.span.top === r && !/^KETERANGAN\s*:?$/i.test(cell.text) && !/^\*+\)$/.test(cell.text)) { notes.push(cell.text); break; }
            }
            continue;
        }
        if (marker && !label) {
            for (let c = after + 1; c <= 28; c++) {
                const cell = at(r, c);
                if (cell.text && cell.span.top === r) { label = cell.text; break; }
            }
        }
        if (!label) continue;
        // A line without its own marker is the formula or explanation belonging to the line above.
        if (!marker && items.length) { items[items.length - 1].note = [items[items.length - 1].note, label].filter(Boolean).join(' '); continue; }
        if (!marker) continue;
        /* The operand hint the sheet prints between the caption and the value box - "( 1 - 2 )",
         * "( Tarif x 3 )", "( 1/…. *) x 6 )" - sits a row or two below the caption, in the columns
         * between it and the value column. Without it the form loses the arithmetic that tells the
         * reader where each figure comes from. */
        let labelRight = 0;
        for (let c = 1; c <= 28 && !labelRight; c++) {
            const cell = at(r, c);
            if (cell.text === label) labelRight = cell.span.right;
        }
        // A merged formula repeats its text on every row and column it covers, so each distinct
        // piece is taken once.
        const parts = [], already = new Set();
        for (let rr = r; rr <= Math.min(r + 3, lastRow); rr++) {
            for (let c = labelRight + 1; c < head.left; c++) {
                const cell = at(rr, c);
                if (!cell.text || cell.text === label || already.has(cell.text)) continue;
                already.add(cell.text);
                parts.push(cell.text);
            }
        }
        items.push({ marker: marker.replace(/\.$/, ''), label, note: '', formula: parts.join(' '), row: r });
    }
    return items.length ? { valueLabel: head.label, items, notes } : null;
}

/* Some lists are printed under an outline the sheet spells out inside the data block itself: L9
 * runs "I. HARTA BERWUJUD" over Kelompok 1-4 and Lain, then "II. KELOMPOK BANGUNAN" over Permanen
 * and Tidak Permanen, then its JUMLAH PENYUSUTAN lines, and only then "III. HARTA TAK BERWUJUD"
 * with its own JUMLAH AMORTISASI lines. Coretax hands the same data over as a dozen tables all
 * called "KELOMPOK n", so without this the two halves - depreciation and amortisation - ran
 * together as one undifferentiated series. */
function outlineOf(ws, spanAt, from, to, txtOf) {
    const groups = [];
    for (let r = from; r <= to; r++) {
        let marker = '', title = '';
        for (let c = 1; c <= 14; c++) {
            const s = spanAt(r, c);
            if (s.top !== r) continue;
            const t = txtOf(ws.getRow(s.top).getCell(s.left).value);
            if (!t) continue;
            if (!marker && /^(I{1,3}|IV|V)\.$/.test(t)) { marker = t; continue; }
            if (marker && !title) { title = t; break; }
            if (!marker) break;
        }
        if (marker && title) groups.push({ marker, title, row: r, members: 0 });
        else if (groups.length && /^[A-E]\.$/.test(String(marker || ''))) groups[groups.length - 1].members++;
    }
    // Count the lettered lines under each group so the renderer knows how many Coretax tables
    // belong to it.
    for (const [i, g] of groups.entries()) {
        const end = i + 1 < groups.length ? groups[i + 1].row : to;
        let members = 0;
        for (let r = g.row + 1; r < end; r++) {
            for (let c = 1; c <= 14; c++) {
                const s = spanAt(r, c);
                if (s.top !== r) continue;
                const t = txtOf(ws.getRow(s.left === c ? s.top : r).getCell(s.left).value);
                if (/^[A-E]\.$/.test(t)) members++;
                if (t) break;
            }
        }
        g.members = members;
        delete g.row;
    }
    return groups.length > 1 ? groups : null;
}

/* A third shape again: L10-D is a declaration sheet - Roman-numbered sections, a sentence of
 * preamble, then statements each with a tick box. Neither the table extractor nor the calculation
 * form recognises it, so it printed as a bare run of sentences. */
function checklistOf(ws, spanAt, from, to, txtOf) {
    const at = (r, c) => { const s = spanAt(r, c); return { text: txtOf(ws.getRow(s.top).getCell(s.left).value), span: s, cell: ws.getRow(s.top).getCell(s.left) }; };
    const entries = [];
    for (let r = from; r <= to; r++) {
        let box = 0, first = null;
        for (let c = 1; c <= 12; c++) {
            const cell = ws.getRow(r).getCell(c);
            const t = txtOf(cell.value);
            const bordered = cell.border && Object.keys(cell.border).length;
            if (!t && bordered && !box) box = c;
            if (t && !first) first = at(r, c);
        }
        if (!first) continue;
        const fill = first.cell.fill && first.cell.fill.fgColor && first.cell.fill.fgColor.argb;
        const dark = fill && /2D471D$/i.test(String(fill));
        if (dark && first.span.top === r) {
            let title = '';
            for (let c = first.span.right + 1; c <= 44 && !title; c++) {
                const next = at(r, c);
                if (next.text && next.span.top === r) title = next.text;
            }
            // L10-D numbers its sections in a cell of their own ("I." then the title); L10-B puts
            // the whole heading in one cell. Either way the printed bar should read once.
            const clean = first.text.replace(/\.+$/, '');
            entries.push(title ? { type: 'section', marker: clean + '.', title } : { type: 'section', title: clean });
            continue;
        }
        if (first.span.top !== r) continue;
        /* Two shapes share this layout. L10-D ticks a box to the left of each statement. L10-B
         * numbers its statements "a." "b." and answers each with Ya/Tidak boxes on the right, and
         * lets a long statement run onto the next line - read naively that gave two fragments and
         * no statements. A lettered marker starts an item; an unmarked line under one continues it. */
        const answers = [];
        for (let c = first.span.right + 1; c <= 48; c++) {
            const t = txtOf(ws.getRow(r).getCell(c).value);
            if (/^(YA|TIDAK)$/i.test(t) && !answers.includes(t)) answers.push(t);
        }
        if (/^[a-z]\.$/i.test(first.text)) {
            let label = '';
            for (let c = first.span.right + 1; c <= 34 && !label; c++) {
                const next = at(r, c);
                if (next.text && next.span.top === r) label = next.text;
            }
            if (label) { entries.push({ type: 'item', marker: first.text.replace(/\.$/, ''), label, answers }); continue; }
        }
        const previous = entries[entries.length - 1];
        // A statement that spills onto the next line carries no answer of its own, so a line with
        // no Ya/Tidak under an item that has them is that item continuing, not a new one.
        const continues = previous && previous.type === 'item' && !answers.length && (previous.answers || []).length;
        if (!continues && box && box < first.span.left) { entries.push({ type: 'item', label: first.text, answers }); continue; }
        if (previous && previous.type === 'item' && first.span.left > 3 && first.text.length > 8 && !/^[A-Z][A-Z ]{6,}$/.test(first.text)) {
            previous.label += ' ' + first.text;
            continue;
        }
        if (first.text.length > 30) entries.push({ type: 'text', text: first.text });
    }
    return entries.some((e) => e.type === 'item') ? entries : null;
}

function extractSheet(ws, name, shapes) {
    // Only the L1A-L1L family (12 sector variants of the same reconciliation sheet) carries the
    // short sector label above PERHATIAN ("UMUM", "MANUFAKTUR", "JASA", ...) - verified by direct
    // inspection. Other sheets have unrelated short all-caps text elsewhere in that same header
    // region (e.g. L3's own title bleeding into the scan), so detection must not run for them.
    const hasSector = /^L1[A-L]$/.test(name);
    const spanAt = mergeIndex(ws);
    const lastRow = ws.actualRowCount ? ws.dimensions.bottom : 200;

    // Header block. OP splits "PERHATIAN:" (label) and its sentence into two cells; Badan puts
    // "PERHATIAN <full sentence>" in one cell - handle both by falling back to the longest
    // unclassified header-block text when a bare "PERHATIAN" label has no content of its own.
    // Badan sheets have no lettered A/B/C/D/E index box at all (confirmed by direct inspection -
    // unlike OP, each sheet is fully self-contained), so `index` always stays empty here. The
    // header-block scan can't safely reuse OP's "/^[A-E]\\.$/ -> index entry" detection: on a
    // sheet like L1D that range (rows 1-12) overlaps row 12, which is the FIRST in-body section
    // marker ("A. LAPORAN LABA RUGI") that the table-title walk below already picks up on its
    // own - detecting it here too would wrongly show it a second time as a fake index box.
    let lampiran = '', halaman = '', perhatian = '', sector = '', subtitle = '';
    let perhatianLabelOnly = false;
    const index = [];
    const longTexts = [];
    for (let r = 1; r <= 10; r++) {
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
            const t = txt(c.value);
            if (/^LAMPIRAN\s+\S+$/i.test(t)) { lampiran = lampiran || t; return; }
            // Each sheet names itself once more under "DALAM MATA UANG RUPIAH", bulleted with a
            // Wingdings square that exceljs reads as a bare "n" ("n ANGSURAN PPh TAHUN PAJAK
            // BERJALAN" on L6, "n DAFTAR PENYUSUTAN DAN AMORTISASI FISKAL" on L9). The kop printed
            // that line as a fixed "REKONSILIASI LAPORAN KEUANGAN", which is only ever right for
            // the L1 family.
            if (!subtitle && c.col >= 12 && /^n\s+\S/.test(t) && t.length > 10) { subtitle = t.replace(/^n\s+/, '').trim(); return; }
            if (/^HALAMAN\s+\d+$/i.test(t)) { halaman = halaman || t; return; }
            if (/^PERHATIAN\b/i.test(t)) {
                const rest = t.replace(/^PERHATIAN\s*:?\s*/i, '').trim();
                if (rest.length > 10) perhatian = perhatian || rest;
                else perhatianLabelOnly = true;
                return;
            }
            // The L1A-L1L family (only) carries a short business-sector label ("UMUM",
            // "MANUFAKTUR", "JASA", ...) directly above PERHATIAN - a short all-caps line seen
            // before PERHATIAN, in the same left-hand column block. Other sheets (L2, L3, L4...)
            // have no such row, so `sector` just stays empty for them.
            if (hasSector && !sector && !perhatian && !perhatianLabelOnly && r <= 3 && c.col <= 12 && /^[A-Z][A-Z .\/-]{1,24}$/.test(t)) { sector = t; return; }
            if (t.length > 20 && !/^\d/.test(t) && !/DALAM MATA UANG RUPIAH/i.test(t)) longTexts.push(t);
        });
    }
    if (!perhatian && perhatianLabelOnly && longTexts.length) {
        perhatian = longTexts.reduce((a, b) => (b.length > a.length ? b : a));
    }

    // Tables, anchored on their "(n)" numbering rows - identical approach to the OP extractor.
    const tables = [];
    for (let r = 1; r <= lastRow; r++) {
        const nums = [];
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
            // Some Badan columns carry a derivation formula in the numbering cell itself, e.g.
            // "(6) = (3)-(4)-(5)" rather than a bare "(6)." - only the leading "(n)" is kept.
            const m = /^\((\d+)\)\.?(?:\s*=.*)?$/.exec(txt(c.value));
            if (!m) return;
            const s = spanAt(r, c.col);
            if (!nums.some((n) => n.left === s.left)) nums.push({ num: '(' + m[1] + ')', left: s.left, right: s.right });
        });
        if (nums.length < 3) continue;
        nums.sort((a, b) => a.left - b.left);

        // Balance-sheet-style sections (e.g. L1D's "B. LAPORAN POSISI KEUANGAN") repeat the SAME
        // "(1) (2) (3)" numbering side by side for two independent blocks (ASET, then LIABILITAS
        // DAN EKUITAS) separated by blank columns - a number reappearing after already being seen
        // marks the start of the second block. These get a fixed, simplified spec (see below)
        // instead of the usual per-column label walk, since the real structure is two merged
        // "kode + nama akun" / "nilai" pairs, not six independently-labelled columns.
        const groups = [[]];
        const seenNums = new Set();
        for (const n of nums) {
            if (seenNums.has(n.num)) { groups.push([]); seenNums.clear(); }
            seenNums.add(n.num);
            groups[groups.length - 1].push(n);
        }
        if (groups.length > 1) {
            let title = '';
            for (let hr = r - 1; hr >= Math.max(1, r - 6) && !title; hr--) {
                ws.getRow(hr).eachCell({ includeEmpty: false }, (c) => {
                    const t = txt(c.value);
                    if (/^(\d+|[A-E])\.$/.test(t)) { const s = spanAt(hr, c.col); title = (t + ' ' + txt(ws.getRow(s.top).getCell(s.right + 1).value)).trim(); }
                });
            }
            // A number reappearing on its own isn't proof of a real side-by-side balance sheet -
            // only trust the ASET/LIABILITAS shape when the section's own title actually says so
            // (guards against an unrelated coincidental reset elsewhere being mis-treated as one).
            if (/POSISI KEUANGAN|NERACA/i.test(title)) {
                tables.push({
                    title, sideBySide: true, headerRow: r,
                    columns: [
                        { num: '(1)', label: 'ASET', width: 3 },
                        { num: '(2)', label: 'NILAI', width: 1 },
                        { num: '(3)', label: 'LIABILITAS DAN EKUITAS', width: 3 },
                        { num: '(4)', label: 'NILAI', width: 1 },
                    ],
                });
                continue;
            }
        }

        const left = nums[0].left, right = nums[nums.length - 1].right;
        // Title-marker search widens a few columns left of the table body: Badan puts the bare
        // "A." marker in column A while the table itself starts at column B, outside [left,right].
        const titleLeft = Math.max(1, left - 4);
        const noise = (t) => !t || /^PINDAHKAN/i.test(t) || /^\(\d+\)/.test(t);
        const labelRows = [];
        let title = '', sealed = false;
        for (let hr = r - 1; hr >= Math.max(1, r - 6); hr--) {
            const cells = [];
            for (let c = titleLeft; c <= right;) {
                const s = spanAt(hr, c);
                cells.push({ t: txt(ws.getRow(s.top).getCell(s.left).value), left: s.left, right: s.right });
                c = s.right + 1;
            }
            const texts = cells.map((x) => x.t).filter((t) => t && !noise(t));
            const marker = texts.find((t) => /^(\d+|[A-E])\.$/.test(t));
            const inline = texts.find((t) => /^(\d+\.|[A-E]\.)\s+\S/.test(t));
            if (marker) { title = (marker + ' ' + texts.filter((t) => t !== marker).join(' ')).trim(); break; }
            if (inline) { title = inline; break; }
            // A blank row separates the kop from the table's own header block; past it the wording
            // belongs to the kop, not to any column - L9 was labelling its "BULAN/TAHUN PEROLEHAN"
            // column "NPWP", the word sitting in the kop directly above it. The scan still climbs
            // on, because the section title it is looking for sits above that gap.
            if (!texts.length) { if (labelRows.length) sealed = true; continue; }
            if (!sealed) labelRows.push(cells.filter((c) => c.left >= left));
        }

        const columns = nums.map((n) => {
            const labels = [];
            // A heading that spans wider than this column is the group it belongs to, not its own
            // name: L9 puts "KOMERSIAL" and "FISKAL" under one "METODE PENYUSUTAN/AMORTISASI".
            // Skipping those, as before, printed the two children as if they were unrelated columns.
            let parent = '';
            for (const cells of labelRows) {
                for (const cell of cells) {
                    if (noise(cell.t)) continue;
                    if (cell.left >= n.left && cell.right <= n.right) {
                        if (!labels.includes(cell.t)) labels.push(cell.t);
                    } else if (!parent && cell.left <= n.left && cell.right >= n.right) parent = cell.t;
                }
            }
            labels.reverse();
            return { num: n.num, label: labels[0] || '', sub: labels.slice(1).join(' '), parent, left: n.left, right: n.right, width: n.right - n.left + 1 };
        });

        let totalLabel = '', totalRow = 0;
        for (let fr = r + 1; fr <= Math.min(lastRow, r + 200) && !totalRow; fr++) {
            ws.getRow(fr).eachCell({ includeEmpty: false }, (c) => {
                const t = txt(c.value);
                if (!totalRow && /^JUMLAH\b/i.test(t)) { totalLabel = t; totalRow = fr; }
            });
        }
        const dataStart = r + 1;
        const dataEnd = totalRow ? totalRow - 1 : r + 1;
        tables.push({ title, totalLabel, headerRow: r, dataStart, dataEnd, blankRows: Math.max(0, dataEnd - dataStart + 1), totalRow, columns });
    }
    const formRight = tables.reduce((m, t) => Math.max(m, ...t.columns.map((c) => c.right)), 0);
    const formBottom = tables.reduce((m, t) => Math.max(m, t.totalRow || t.dataEnd || 0), 0);
    const kop = kopFrom(ws, shapes, txt, spanAt, name);
    // Only sheets that are forms rather than lists: a sheet with tables is laid out by those.
    const form = tables.length ? null : fieldForm(ws, spanAt, lastRow, txt);
    const checklist = (tables.length || form) ? null : checklistOf(ws, spanAt, 11, Math.min(lastRow, 90), txt);
    const outline = tables.length === 1 && tables[0].dataStart
        ? outlineOf(ws, spanAt, tables[0].dataStart, Math.min(lastRow, tables[0].dataStart + 60), txt) : null;
    return { lampiran: lampiran || kop.badge, halaman, perhatian, sector,
        subtitle: kop.subtitle || subtitle, index, form, checklist, outline, formRight, formBottom, tables };
}

(async () => {
    const file = process.argv[2] || DEFAULT_XLSX;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const shapes = shapesBySheet(file);
    const spec = {};
    for (const name of SHEETS) {
        const ws = wb.getWorksheet(name);
        if (!ws) { console.warn('Sheet tidak ditemukan: ' + name); continue; }
        spec[name] = extractSheet(ws, name, shapes[name] || []);
        console.log(name + ': ' + spec[name].tables.length + ' tabel, perhatian=' + JSON.stringify(spec[name].perhatian.slice(0, 40)) + (spec[name].perhatian.length > 40 ? '...' : ''));
    }
    const out = path.join(__dirname, '..', 'lib', 'lampiran-badan-per11.json');
    fs.writeFileSync(out, JSON.stringify(spec, null, 1));
    console.log('Ditulis: ' + out);
})().catch((e) => { console.error(e); process.exit(1); });
