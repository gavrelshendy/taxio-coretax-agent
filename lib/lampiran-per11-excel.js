/* The Excel copy of a PER-11 lampiran: the same filled form the PDF prints (lib/lampiran-per11-fill.js),
 * written cell for cell - merges, Coretax's house colours, lines, fonts - on the column widths and
 * row heights the PDF layout settled on, one worksheet per form sheet. Amounts are real numbers
 * (so the client can add them up); NPWP, codes, years and dates stay text as printed.
 * The workbook's shapes (Badan's LAMPIRAN badge, the "A.10" pointers) cannot be written by
 * exceljs as shapes: their text goes into the cells they cover, in the shape's colour.
 */
const { THEMES } = require('./lampiran-per11-render');

const textOf = (v) => Array.isArray(v) ? v.map((r) => r.t).join('') : String(v == null ? '' : v);
const argb = (hex) => 'FF' + String(hex || '#000000').replace('#', '').toUpperCase().padStart(6, '0').slice(0, 6);
const H_ALIGN = { left: 'left', center: 'center', right: 'right', centerContinuous: 'centerContinuous', justify: 'justify', distributed: 'distributed', fill: 'fill' };
const V_ALIGN = { top: 'top', center: 'middle', middle: 'middle', bottom: 'bottom', justify: 'justify', distributed: 'distributed' };

/** "1.234.567" / "(1.234)" / "-5.000,25" -> { value, numFmt }; null when the text is not an amount. */
function amount(text, st) {
    const s = String(text || '').trim();
    const paren = /^\(.*\)$/.test(s);
    const core = s.replace(/^\((.*)\)$/, '$1').replace(/^-/, '');
    if (!/^\d[\d.]*(,\d+)?$/.test(core)) return null;
    // Codes and identifiers keep their leading zeros; a bare number that is not right-aligned
    // is a year or a code, not an amount.
    if (/^0\d/.test(core) || core.replace(/\D/g, '').length > 15) return null;
    if (!/[.,]/.test(core) && st.h !== 'right') return null;
    if (core.includes('.') && !/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(core)) return null;
    const decimals = (core.split(',')[1] || '').length;
    const value = Number(core.replace(/\./g, '').replace(',', '.')) * (paren || s.startsWith('-') ? -1 : 1);
    const base = '#,##0' + (decimals ? '.' + '0'.repeat(decimals) : '');
    return { value, numFmt: paren ? base + ';(' + base + ')' : base };
}

/** Adds one worksheet per entry ({ name, sheet, grid, landscape }) of a tab rendered by
 *  lib/lampiran-per11-pdf.js renderTab. `used` holds the workbook's sheet names (lower case). */
function addFormSheets(wb, entries, used, kind) {
    const theme = THEMES[kind] || { bg: {}, text: {}, border: {}, font: {} };
    const tc = (map, c) => (c && theme[map][String(c).toUpperCase()]) || c;
    const fontName = (f) => { const t = (f && theme.font[f]) || f || 'Arial'; return String(t).split(',')[0].replace(/'/g, '').trim(); };
    for (const { name, sheet, grid, landscape } of entries) {
        let base = ('Lampiran ' + name.replace(/^L/, '')).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31), title = base, i = 2;
        while (used.has(title.toLowerCase())) title = base.slice(0, 26) + ' (' + (i++) + ')';
        used.add(title.toLowerCase());
        const ws = wb.addWorksheet(title, {
            views: [{ showGridLines: false }],
            pageSetup: { paperSize: 14, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
                margins: { left: 0.3, right: 0.3, top: 0.35, bottom: 0.35, header: 0.2, footer: 0.2 } },
        });
        const colsPx = (grid && grid.cols && grid.cols.length ? grid.cols : sheet.cols);
        colsPx.forEach((px, c) => { ws.getColumn(c + 1).width = Math.max(0.3, px / 7); });
        const rowPx = (r) => (grid && grid.rows && grid.rows[r]) || sheet.rows[r - 1] || 15;
        for (let r = 1; r <= sheet.rows.length; r++) ws.getRow(r).height = Math.max(1, rowPx(r) * 0.75);

        const merged = new Set();
        const lineOf = (b) => b ? { style: b[0] === 'hair' ? 'hair' : b[0], color: { argb: argb(tc('border', b[1])) } } : undefined;
        for (const c of sheet.cells) {
            const [r, col, rs, cs, si, v] = c;
            const st = sheet.styles[si];
            // Merge first: exceljs copies the first cell's style over the block when merging, so
            // the edge lines set below must come after.
            if (rs > 1 || cs > 1) {
                ws.mergeCells(r, col, r + rs - 1, col + cs - 1);
                for (let y = r; y < r + rs; y++) for (let x = col; x < col + cs; x++) merged.add(y + ':' + x);
            }
            const cell = ws.getCell(r, col);
            const font = { name: fontName(st.font), size: st.size || 10, bold: !!st.bold, italic: !!st.italic, underline: !!st.underline, color: { argb: argb(tc('text', st.color)) } };
            if (Array.isArray(v)) {
                cell.value = { richText: v.map((run) => ({ text: run.t, font: { name: fontName(run.font || st.font), size: run.size || st.size || 10, bold: run.b != null ? !!run.b : !!st.bold, italic: !!run.i, color: { argb: argb(tc('text', run.color || st.color)) } } })) };
            } else {
                const text = textOf(v);
                const n = st.data ? amount(text, st) : null;
                // (a blank-only cell stays empty: any value stops the text beside it running on)
                if (n) { cell.value = n.value; cell.numFmt = n.numFmt; } else if (text.trim() !== '') { cell.value = text; cell.numFmt = '@'; }
            }
            cell.font = font;
            const bg = st.bg && tc('bg', st.bg);
            if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(bg) } };
            // A long text in a merged box (the kop's PERHATIAN, "KETERANGAN (Harta PPS/...)")
            // wraps inside it, as the PDF prints it; the workbook leaves those unwrapped and Excel
            // would cut them at the box edge.
            // (only a box tall enough for two lines: a one-line label would be cut instead)
            let boxH = 0; for (let y = r; y < r + rs; y++) boxH += rowPx(y);
            const wrap = !!st.wrap || ((rs > 1 || cs > 1) && textOf(v).trim().length > 20 && boxH >= 2 * (st.size || 10) * 1.33 * 1.15);
            cell.alignment = { horizontal: H_ALIGN[st.h] || undefined, vertical: V_ALIGN[st.v] || 'bottom', wrapText: wrap, indent: st.indent || undefined };
            // A merged block takes its lines on its own edges: exceljs draws a merge's border from
            // the cells along each side, not from the first one.
            const [bt, br, bb, bl] = st.border;
            for (let y = r; y < r + rs; y++) for (let x = col; x < col + cs; x++) {
                const part = y === r && x === col ? cell : ws.getCell(y, x);
                const border = {};
                if (y === r && bt) border.top = lineOf(bt);
                if (y === r + rs - 1 && bb) border.bottom = lineOf(bb);
                if (x === col && bl) border.left = lineOf(bl);
                if (x === col + cs - 1 && br) border.right = lineOf(br);
                if (Object.keys(border).length) part.border = border;
                if (part !== cell && bg) part.fill = cell.fill;
            }
        }

        // Shapes: text into the cells under them.
        const texted = new Set(sheet.cells.filter((c) => textOf(c[5]).trim()).map((c) => c[0] + ':' + c[1]));
        for (const s of sheet.shapes || []) {
            const text = (s.paragraphs || []).map((p) => (p.runs || []).map((x) => x.t).join('')).join(' ').replace(/\s+/g, ' ').trim();
            if (!text || !s.from) continue;
            const r0 = s.from.row + 1, c0 = s.from.col + 1;
            let c1 = c0, wsum = (colsPx[c0 - 1] || 0) - (s.from.colOff || 0);
            while (wsum < (s.w || s.width || 0) - 2 && c1 < colsPx.length) { c1++; wsum += colsPx[c1 - 1] || 0; }
            // The LAMPIRAN badge closes the kop on the right, as in the PDF.
            const formWidth = sheet.cols.reduce((a, b) => a + b, 0);
            if (/LAMPIRAN|INDUK/.test(text) && (s.x || 0) + (s.w || 0) >= formWidth - 6) c1 = colsPx.length;
            let r1 = r0, hsum = rowPx(r0);
            while (hsum < (s.h || s.height || 0) - 2 && r1 < sheet.rows.length) { r1++; hsum += rowPx(r1); }
            // The block stops above the first taken row (the TAHUN PAJAK line under L3's badge).
            const rowFree = (y) => { for (let x = c0; x <= c1; x++) if (merged.has(y + ':' + x) || texted.has(y + ':' + x)) return false; return true; };
            let free = rowFree(r0);
            if (free) for (let y = r0 + 1; y <= r1; y++) if (!rowFree(y)) { r1 = y - 1; break; }
            const run = (s.paragraphs[0] && s.paragraphs[0].runs && s.paragraphs[0].runs[0]) || {};
            const cell = ws.getCell(r0, c0);
            if (!free && (merged.has(r0 + ':' + c0) || texted.has(r0 + ':' + c0))) continue;
            if (free && (r1 > r0 || c1 > c0)) {
                // (cells may carry an empty style of their own; the block becomes one)
                for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) ws.getCell(y, x).border = {};
                ws.mergeCells(r0, c0, r1, c1);
            }
            cell.value = text;
            cell.font = { name: fontName(run.font) || 'Arial', size: run.size || 10, bold: run.bold != null ? !!run.bold : true, color: { argb: argb(tc('text', run.color || '#000000')) } };
            if (s.fill) {
                const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(tc('bg', s.fill)) } };
                for (let y = r0; y <= (free ? r1 : r0); y++) for (let x = c0; x <= (free ? c1 : c0); x++) ws.getCell(y, x).fill = fill;
            }
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        }
    }
}

module.exports = { addFormSheets, amount };
