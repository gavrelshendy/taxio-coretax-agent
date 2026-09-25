/* Compiles the official PER-11 workbooks into the layout the PDF renderer draws from.
 *
 * The printed lampiran should look like the government's own Excel form, so everything visual is
 * taken from the workbook itself rather than approximated: column widths, row heights, merged
 * ranges, fills, fonts, borders, alignment, and the floating shapes (the gold "LAMPIRAN 10B"
 * badge, the "A.10" pointers). Around that the compiler records where the fillable parts are -
 * the NPWP / TAHUN PAJAK digit boxes, each list table's data rows, the Ya/Tidak boxes - so the
 * renderer can put Coretax's data in the right place.
 *
 * What is deliberately NOT carried over (the template author's own scratch work, not the form):
 * anything right of the kop (FPO code lists, "perubahan kolom" notes), red/purple note text, and
 * cyan helper borders.
 *
 *   node scripts/build-per11-layout.js [badan|op|all]
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { openZip } = require('../lib/xlsx-drawing');

const SOURCES = {
    // INDUK sheets come along too: Coretax prints its own Induk from them, which makes them the
    // calibration target for how the lampiran should look next to it.
    badan: { file: 'spt-tahunan-badan-per11.xlsx', sheets: (n) => /^L\d|^INDUK/.test(n) },
    op: { file: 'spt-tahunan-op-per11.xlsx', sheets: (n) => /^L\d|^[12]$/.test(n) },
};
const EMU_PER_PX = 9525;
const txt = (v) => v == null ? '' : v.richText ? v.richText.map((x) => x.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10)
    : typeof v === 'object' ? ('result' in v ? (v.result == null ? '' : String(v.result)) : v.text != null ? String(v.text) : '') : String(v);

/** Excel column width (characters of the default font's max digit) to pixels, per the OOXML
 *  spec's formula with a 7px maximum digit width (Calibri 11, the workbook default). */
const colPx = (w) => Math.floor(((256 * w + Math.floor(128 / 7)) / 256) * 7);
const rowPx = (pt) => Math.round(pt * 96 / 72 * 100) / 100;

function themeColors(read) {
    const xml = read('xl/theme/theme1.xml') || '';
    const pick = (tag) => { const m = xml.match(new RegExp('<a:' + tag + '>[\\s\\S]*?(?:srgbClr val="([0-9A-F]{6})"|lastClr="([0-9A-F]{6})")', 'i')); return m ? '#' + (m[1] || m[2]).toUpperCase() : null; };
    // Excel's theme index order: lt1, dk1, lt2, dk2, accent1..6.
    return [pick('lt1') || '#FFFFFF', pick('dk1') || '#000000', pick('lt2'), pick('dk2'), pick('accent1'), pick('accent2'), pick('accent3'), pick('accent4'), pick('accent5'), pick('accent6')];
}
function tint(hex, t) {
    if (!t) return hex;
    const n = parseInt(hex.slice(1), 16); let rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgb = rgb.map((x) => Math.round(t < 0 ? x * (1 + t) : x + (255 - x) * t));
    return '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function colorOf(c, theme, fallback) {
    if (!c) return fallback;
    if (c.argb) return '#' + String(c.argb).slice(-6).toUpperCase();
    if (c.theme != null) return tint(theme[c.theme] || fallback, c.tint || 0);
    if (c.indexed === 64 || c.indexed === 8) return '#000000';
    if (c.indexed === 9) return '#FFFFFF';
    return fallback;
}

/** Floating shapes of one sheet, positioned in sheet pixels (oneCellAnchor / twoCellAnchor). */
function sheetShapes(read, sheetPath) {
    const sheetXml = read(sheetPath) || '';
    const relId = (sheetXml.match(/<drawing[^>]*r:id="([^"]+)"/) || [])[1];
    if (!relId) return [];
    const rels = read(sheetPath.replace('worksheets/', 'worksheets/_rels/') + '.rels') || '';
    const target = (rels.match(new RegExp('Id="' + relId + '"[^>]*Target="([^"]+)"')) || [])[1];
    const xml = target ? read('xl/' + target.replace(/^\.\.\//, '')) || '' : '';
    const out = [];
    for (const [a] of xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:\1>/g)) {
        if (!/<xdr:sp>/.test(a)) continue; // pictures (DJP logo on INDUK) are not on lampiran sheets
        const pos = (tag) => { const m = a.match(new RegExp('<xdr:' + tag + '><xdr:col>(\\d+)</xdr:col><xdr:colOff>(-?\\d+)</xdr:colOff><xdr:row>(\\d+)</xdr:row><xdr:rowOff>(-?\\d+)</xdr:rowOff>')); return m ? { col: +m[1], colOff: +m[2] / EMU_PER_PX, row: +m[3], rowOff: +m[4] / EMU_PER_PX } : null; };
        const ext = a.match(/<xdr:ext cx="(\d+)" cy="(\d+)"/);
        const spPr = (a.match(/<xdr:spPr>[\s\S]*?<\/xdr:spPr>/) || [''])[0];
        const fill = (spPr.replace(/<a:ln[\s\S]*?<\/a:ln>/, '').match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-F]{6})"/i) || [])[1];
        const line = (spPr.match(/<a:ln[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-F]{6})"/i) || [])[1];
        const noLine = /<a:ln[^>]*>\s*<a:noFill\/>/.test(spPr);
        const runs = [...a.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map(([, r]) => {
            const rPr = (r.match(/<a:rPr[\s\S]*?(?:\/>|<\/a:rPr>)/) || [''])[0];
            return { t: (r.match(/<a:t>([^<]*)<\/a:t>/) || [])[1] || '', size: +(rPr.match(/sz="(\d+)"/) || [])[1] / 100 || 0,
                bold: /\bb="1"/.test(rPr), color: '#' + ((rPr.match(/srgbClr val="([0-9A-F]{6})"/i) || [])[1] || '000000').toUpperCase(),
                font: (rPr.match(/latin typeface="([^"]+)"/) || [])[1] || '' };
        });
        const paragraphs = [...a.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(([, p]) => ({ align: (p.match(/algn="(\w+)"/) || [])[1] || 'l',
            runs: [...p.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map((m) => runs.find((r) => m[1].includes('<a:t>' + r.t + '</a:t>'))).filter(Boolean) }));
        const from = pos('from'), to = pos('to');
        const shape = { geom: (a.match(/prst="(\w+)"/) || [])[1] || 'rect', from,
            width: ext ? +ext[1] / EMU_PER_PX : null, height: ext ? +ext[2] / EMU_PER_PX : null, to,
            fill: fill ? '#' + fill.toUpperCase() : null, line: noLine ? null : line ? '#' + line.toUpperCase() : null,
            anchor: (a.match(/<a:bodyPr[^>]*anchor="(\w+)"/) || [])[1] || 't', paragraphs };
        if (shape.fill || paragraphs.some((p) => p.runs.length)) out.push(shape);
    }
    return out;
}

function compileSheet(ws, theme, shapes) {
    const merges = new Map();
    for (const m of Object.values(ws._merges)) merges.set(m.model.top + ':' + m.model.left, m.model);
    const covered = new Set();
    for (const m of merges.values()) for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) if (r !== m.top || c !== m.left) covered.add(r + ':' + c);
    const span = (r, c) => merges.get(r + ':' + c) || { top: r, left: c, bottom: r, right: c };

    // The form's right edge is the kop's: the "TAHUN PAJAK" block closes it on every sheet.
    let right = 0;
    for (let r = 1; r <= 12; r++) ws.getRow(r).eachCell({ includeEmpty: true }, (cell, c) => {
        if (/TAHUN PAJAK/i.test(txt(cell.value)) && !covered.has(r + ':' + c)) right = Math.max(right, span(r, c).right);
    });
    // INDUK keeps its TAHUN PAJAK block on the left; there the full-width section bars ("A.
    // IDENTITAS WAJIB PAJAK") mark the edge. Only wide bars count - a lone dark cell far right is
    // the template's stray mark, not the form.
    for (const m of merges.values()) {
        if (m.top > 60 || m.right - m.left < 9) continue;
        const f = ws.getRow(m.top).getCell(m.left).fill;
        const bg = f && f.fgColor && colorOf(f.fgColor, theme, null);
        if (bg && /^#(2D471D|1F3864|212E5E|2F5496|1E4E79)$/i.test(bg)) right = Math.max(right, m.right);
    }
    if (right < ws.dimensions.right * 0.6) {
        for (const m of merges.values()) {
            if (m.top > 60 || m.right - m.left < 2) continue;
            const f = ws.getRow(m.top).getCell(m.left).fill;
            if (f && f.fgColor && colorOf(f.fgColor, theme, '#FFFFFF') !== '#FFFFFF') right = Math.max(right, m.right);
        }
    }
    if (!right) right = ws.dimensions.right;
    // A value field that starts inside the form but runs past the kop's edge (OP L4's AM:AT) is
    // still part of the form.
    for (const m of merges.values()) if (m.top > 10 && m.left <= right && m.right > right) right = m.right;
    // Tables may run past the kop by a column; take the widest column-number row.
    ws.eachRow((row, r) => row.eachCell((cell, c) => { if (/^\(\d+\)\.?$/.test(txt(cell.value).trim()) && !covered.has(r + ':' + c)) right = Math.max(right, span(r, c).right); }));

    const styles = [], styleKey = new Map();
    const note = (cell) => { const col = cell.font && cell.font.color && cell.font.color.argb; return col && /FF0000$|800080$|0000FF$/i.test(col); };
    const edge = (b, fallback) => b && b.style && !(b.color && /00B0F0$/i.test(b.color.argb || '')) ? [b.style, colorOf(b.color, theme, '#000000')] : fallback;
    const cells = [];
    let bottom = 0;
    for (let r = 1; r <= ws.dimensions.bottom; r++) {
        for (let c = 1; c <= right; c++) {
            if (covered.has(r + ':' + c)) continue;
            const cell = ws.getRow(r).getCell(c);
            const s = span(r, c);
            const sRight = Math.min(s.right, right);
            const b = cell.border || {};
            const rightCell = ws.getRow(r).getCell(sRight), bottomCell = ws.getRow(s.bottom).getCell(c);
            const fill = cell.fill && cell.fill.type === 'pattern' && cell.fill.pattern === 'solid' ? colorOf(cell.fill.fgColor, theme, null) : null;
            const bg = fill && fill !== '#FFFFFF' ? fill : null;
            // White lines and lines in the cell's own colour are how the template hides the grid;
            // Excel's print does not show them, and drawn in a browser they leave hairlines.
            const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
            // Also a dark-green line on the dark-green kop: drawn, but not seen in Excel's print.
            const visible = (e) => e && e[1] !== '#FFFFFF' && e[1] !== bg && !(bg && Math.abs(lum(e[1]) - lum(bg)) < 0.12) ? e : null;
            // Excel draws a line between two cells when either of them carries it, so each edge also
            // looks at the neighbour across it (a table's right edge is often stored as the next
            // column's left border, a row's top line as the bottom border of the row above).
            const nb = (rr, cc) => (rr >= 1 && cc >= 1 ? (ws.getRow(rr).getCell(cc).border || {}) : {});
            const across = (side, cells) => cells.map((x) => edge(x[side])).find(Boolean) || null;
            // Only needed at the form's right edge: there the neighbour lies outside the printed
            // range and is never drawn. Inside the form the neighbour is drawn itself, and copying
            // its line would leave stray strokes next to shrunk tick boxes.
            const rightN = sRight >= right ? across('left', Array.from({ length: s.bottom - r + 1 }, (_, k) => nb(r + k, sRight + 1))) : null;
            // A merged cell's edge can be stored on any of the cells along it (Excel often keeps the
            // left line of a 3-row "NO." heading on its lower cells), so each side looks along its
            // whole length.
            const own = (rr, cc) => (ws.getRow(rr).getCell(cc).border || {});
            const along = (side, list) => list.map((x) => edge(x[side])).find(Boolean) || null;
            const rowsOf = Array.from({ length: s.bottom - r + 1 }, (_, k) => r + k), colsOf = Array.from({ length: sRight - c + 1 }, (_, k) => c + k);
            const border = [edge(b.top) || along('top', colsOf.map((x) => own(r, x))),
                edge((rightCell.border || {}).right) || edge(b.right) || along('right', rowsOf.map((y) => own(y, sRight))) || rightN,
                edge((bottomCell.border || {}).bottom) || edge(b.bottom) || along('bottom', colsOf.map((x) => own(s.bottom, x))),
                edge(b.left) || along('left', rowsOf.map((y) => own(y, c)))].map(visible);
            let text = note(cell) ? '' : txt(cell.value);
            // A number the form prints with a percent format (L2's JUMLAH "%": 1 -> 100%).
            if (typeof cell.value === 'number' && /%/.test(cell.numFmt || '')) {
                const dec = ((cell.numFmt.match(/\.(0+)%/) || [])[1] || '').length;
                text = (cell.value * 100).toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
            }
            if (typeof cell.value === 'object' && cell.value && cell.value.formula) text = ''; // template formulas compute data, not wording
            // The kop's section bullet was a Wingdings square; after conversion it sits in the sheet as a
            // plain "n" in a symbol font, which is exactly how Excel now prints it. Print the square.
            const symbol = cell.font && /Symbols|Wingdings/i.test(cell.font.name || '');
            if ((symbol || r <= 10) && /^n\s*$/.test(text)) text = '■';
            // Numbered markers typed as "1.     ." (L10-B, L10-D): the trailing dot is padding the
            // author typed; printed, it lands inside the neighbouring word ("Mengen.ai").
            if (/^\s*([0-9]+|[a-z]|[IVX]+)\.\s+\.\s*$/i.test(text)) text = text.trim().replace(/\s+\.$/, '');
            // Rich text keeps each run's own font: the kop titles are a Wingdings "n" (the square
            // bullet) followed by a run in "Roboto Condensed Bold" - bold by font name, not flag.
            const runs = cell.value && cell.value.richText && !note(cell) ? cell.value.richText.map((x) => {
                const fname = (x.font && x.font.name) || '';
                const sym = /Symbols|Wingdings/i.test(fname);
                return { t: sym && /^n\s*$/.test(x.text) ? '■ ' : x.text, b: !!(x.font && x.font.bold) || /\bBold\b/i.test(fname), i: !!(x.font && x.font.italic),
                    color: x.font && x.font.color ? colorOf(x.font.color, theme, null) : null, size: x.font && x.font.size || null,
                    font: sym ? 'Arial' : fname.replace(/\s+(Bold|SemiBold|Medium)$/i, '') || null };
            }) : null;
            // PERHATIAN box: the heading is bold, the sentence under it reads as Excel shows it on
            // screen - regular weight (the file flags it bold, which prints heavy and cramped).
            if (runs && r <= 10 && /^PERHATIAN/i.test(runs[0].t)) runs.slice(1).forEach((x) => { x.b = false; });
            // A formula cell or a wide merged cell is where a value goes, even when it is drawn with
            // no box (OP L4): keep it, or the fill has nowhere to put the number.
            const slot = (cell.value && typeof cell.value === 'object' && cell.value.formula) || s.right - s.left >= 2;
            if (!text.trim() && !bg && !border.some(Boolean) && !slot) continue;
            const f = cell.font || {}, al = cell.alignment || {};
            const style = { font: symbol || text === '■' ? 'Arial' : (f.name || '').replace(/\s+(Bold|SemiBold|Medium)$/i, '') || null, size: f.size || null, bold: !!f.bold || /\bBold\b/i.test(f.name || ''), italic: !!f.italic, underline: !!f.underline, color: colorOf(f.color, theme, '#000000'),
                bg, border, h: al.horizontal || null, v: al.vertical || 'bottom', wrap: !!al.wrapText, indent: al.indent || 0, rotate: al.textRotation || 0 };
            const key = JSON.stringify(style);
            if (!styleKey.has(key)) { styleKey.set(key, styles.length); styles.push(style); }
            cells.push([r, c, s.bottom - r + 1, sRight - c + 1, styleKey.get(key), runs && runs.length > 1 ? runs : text]);
            bottom = Math.max(bottom, s.bottom);
        }
    }
    const cols = [];
    for (let c = 1; c <= right; c++) { const col = ws.getColumn(c); cols.push(col.hidden ? 0 : colPx(col.width || ws.properties.defaultColWidth || 8.43)); }
    const rows = [];
    for (let r = 1; r <= bottom; r++) { const row = ws.getRow(r); rows.push(row.hidden ? 0 : rowPx(row.height || ws.properties.defaultRowHeight || 15)); }
    // Shapes anchored to a cell: convert to sheet pixels so the renderer can place them.
    const x0 = (c) => cols.slice(0, c).reduce((a, b) => a + b, 0), y0 = (r) => rows.slice(0, r).reduce((a, b) => a + b, 0);
    const placed = shapes.filter((s) => s.from && s.from.col < right).map((s) => ({ ...s,
        x: x0(s.from.col) + s.from.colOff, y: y0(s.from.row) + s.from.rowOff,
        w: s.width ?? (s.to ? x0(s.to.col) + s.to.colOff - x0(s.from.col) - s.from.colOff : 0),
        h: s.height ?? (s.to ? y0(s.to.row) + s.to.rowOff - y0(s.from.row) - s.from.rowOff : 0) }));
    // The gold LAMPIRAN badge is a floating box the author placed by eye: on several sheets it
    // runs past the kop's right edge (L1E, L10C) or stops short of the TAHUN PAJAK strip under it.
    // Snap it to the kop - flush right, down to the row where TAHUN PAJAK starts.
    let tahunRow = 0;
    for (let r = 1; r <= 12 && !tahunRow; r++) ws.getRow(r).eachCell((cell) => { if (!tahunRow && /TAHUN PAJAK/i.test(txt(cell.value))) tahunRow = r; });
    const kopRight = x0(right);
    for (const s of placed) {
        const label = s.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join(' ');
        if (!/^\s*(LAMPIRAN|INDUK)/i.test(label) || !s.from || s.from.row > 8) continue;
        s.w = Math.max(20, kopRight - s.x);
        if (tahunRow && y0(tahunRow - 1) > s.y + 20) s.h = y0(tahunRow - 1) - s.y;
        s.width = s.w; s.height = s.h;
    }
    const ps = ws.pageSetup || {};
    const page = { orientation: ps.orientation || 'portrait', paperSize: ps.paperSize || 9, margins: ps.margins || null };
    return { name: ws.name, right, bottom, page, cols, rows, styles, cells, shapes: placed };
}

async function build(kind) {
    const src = SOURCES[kind];
    const file = path.join(__dirname, '..', 'templates', src.file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const read = openZip(file);
    const theme = themeColors(read);
    const workbookXml = read('xl/workbook.xml') || '', wbRels = read('xl/_rels/workbook.xml.rels') || '';
    const sheetPathOf = (name) => {
        const id = (workbookXml.match(new RegExp('<sheet[^>]*name="' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*r:id="([^"]+)"')) || [])[1];
        const target = id && (wbRels.match(new RegExp('Id="' + id + '"[^>]*Target="([^"]+)"')) || [])[1];
        return target ? 'xl/' + target.replace(/^\/?xl\//, '') : null;
    };
    const sheets = {};
    for (const ws of wb.worksheets) {
        if (!src.sheets(ws.name)) continue;
        const p = sheetPathOf(ws.name);
        sheets[ws.name] = compileSheet(ws, theme, p ? sheetShapes(read, p) : []);
    }
    const out = path.join(__dirname, '..', 'lib', 'lampiran-per11-layout-' + kind + '.json');
    fs.writeFileSync(out, JSON.stringify({ source: src.file, sheets }));
    const size = fs.statSync(out).size;
    console.log(kind + ': ' + Object.keys(sheets).length + ' sheets, ' + Object.values(sheets).reduce((a, s) => a + s.cells.length, 0) + ' cells, ' + (size / 1024).toFixed(0) + ' KB -> ' + path.relative(process.cwd(), out));
}

(async () => {
    const which = process.argv[2] || 'all';
    for (const kind of which === 'all' ? Object.keys(SOURCES) : [which]) await build(kind);
})().catch((e) => { console.error(e); process.exit(1); });
