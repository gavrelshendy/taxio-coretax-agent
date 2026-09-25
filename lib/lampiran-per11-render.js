/* Draws a compiled PER-11 sheet (lib/lampiran-per11-layout-*.json, built by
 * scripts/build-per11-layout.js) as HTML that Chromium prints to PDF.
 *
 * The sheet is laid out the way Excel lays it out: one fixed-layout table whose columns carry the
 * workbook's own pixel widths, each cell with its own fill, font, borders and alignment, and the
 * floating shapes positioned on top in sheet pixels. Rows keep Excel's height as a minimum but may
 * grow, so wrapped data never gets clipped the way it would in Excel.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let fontFaceCss = null;
/** Fonts the forms use that Windows does not ship, embedded so the render needs no network. */
function fontFaces() {
    if (fontFaceCss != null) return fontFaceCss;
    const dir = path.join(__dirname, 'fonts');
    const face = (family, file, weight) => {
        const p = path.join(dir, file);
        return fs.existsSync(p) ? `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')}) format('woff2')}` : '';
    };
    fontFaceCss = [face('Roboto Condensed', 'roboto-condensed-400.woff2', 400), face('Roboto Condensed', 'roboto-condensed-700.woff2', 700),
        face('Montserrat', 'montserrat-700.woff2', 700), face('Montserrat', 'montserrat-400.woff2', 400),
        face('Quattrocento Sans', 'quattrocento-sans-400.woff2', 400), face('Quattrocento Sans', 'quattrocento-sans-700.woff2', 700)].join('');
    return fontFaceCss;
}

/* Coretax prints its own Induk from the same government workbook, but in its own house style:
 * Arial / Arial Narrow in black, a brighter green, a yellow marker, a lighter grey (measured off
 * Coretax's Induk PDF). The lampiran take the same style, so an Induk from Coretax and lampiran
 * from here read as one document. Keys are the workbook's colours. */
const THEMES = {
    badan: {
        bg: { '#2D471D': '#005300', '#385623': '#005300', '#FFC000': '#FFD600', '#E7E6E6': '#D2D3D2', '#E6E9E8': '#D2D3D2', '#F2F2F2': '#E6E6E6' },
        text: { '#2D471D': '#000000', '#385623': '#000000', '#BF9000': '#000000' },
        border: { '#2D471D': '#000000', '#385623': '#000000' },
        font: { 'Roboto Condensed': "'Arial Narrow','Roboto Condensed'", Montserrat: 'Arial', Arial: 'Arial' },
    },
    // OP: Coretax's Induk OP is navy #000040 / yellow / light grey, Arial Narrow in black.
    op: {
        bg: { '#212E5E': '#000040', '#1E4E79': '#000040', '#2F5496': '#000040', '#1F3864': '#000040', '#D8D8D8': '#D2D3D2', '#E6E9E8': '#D2D3D2', '#BFBFBF': '#D2D3D2', '#BDD6EE': '#D2D3D2', '#9CC2E5': '#D2D3D2', '#FFC000': '#FFD600', '#FFFF00': '#FFD600' },
        text: { '#212E5E': '#000000', '#1F3864': '#000000', '#495057': '#000000' },
        border: {},
        font: { Arial: "'Arial Narrow','Roboto Condensed'", 'Quattrocento Sans': 'Arial', Calibri: "'Arial Narrow','Roboto Condensed'" },
    },
};
let THEME = null;
const tc = (map, c) => (THEME && c && THEME[map][c.toUpperCase()]) || c;
const tf = (f) => (THEME && f && THEME.font[f]) || (f ? `'${f}'` : null);

const BORDER = { thin: '1px solid', hair: '0.5px solid', medium: '2px solid', thick: '3px solid', dotted: '1px dotted', dashed: '1px dashed', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed' };
// The yellow badge and markers ("LAMPIRAN 1", "C.6") paint above their dark neighbours, whose
// seam hairline otherwise bites notches into their edge. Only a yellow cell with text: an empty
// one lifted over a section title would hide the title's run-on text ("1. KAS DAN SETARA KAS").
const lifted = (st, text) => /^#FF(C000|D600)$/i.test(st.bg || '') && !!String(text || '').trim();

function cellCss(st) {
    const css = [];
    if (st.font) css.push(`font-family:${tf(st.font)},Arial,sans-serif`);
    if (st.size) css.push(`font-size:${st.size}pt`);
    if (st.bold) css.push('font-weight:700');
    if (st.italic) css.push('font-style:italic');
    if (st.underline) css.push('text-decoration:underline');
    const color = tc('text', st.color);
    if (color && color !== '#000000') css.push('color:' + color);
    // A half-pixel shadow in the fill's own colour closes the seam PDF viewers show between two
    // neighbouring cells of the same colour (anti-aliasing of abutting rectangles).
    const bg = tc('bg', st.bg);
    // Unframed fills (section bars, the kop) get a hairline of their own colour around them: it
    // closes the seam PDF viewers draw between two neighbouring cells of the same colour.
    // A fill framed only at its sides (the kop's edge column) still gets the hairline above and
    // below, where its rows meet.
    if (bg) css.push('background:' + bg, !st.border.some(Boolean) ? `box-shadow:0 0 0 .6px ${bg}` : !st.border[0] && !st.border[2] ? `box-shadow:0 .6px 0 ${bg},0 -.6px 0 ${bg}` : '');
    ['top', 'right', 'bottom', 'left'].forEach((side, i) => { const b = st.border[i]; if (b) css.push(`border-${side}:${BORDER[b[0]] || '1px solid'} ${tc('border', b[1])}`); });
    const h = st.h === 'centerContinuous' ? 'center' : st.h === 'distributed' || st.h === 'justify' ? 'justify' : st.h;
    if (h && h !== 'general' && h !== 'left') css.push('text-align:' + h);
    // exceljs spells Excel's vertical centre "middle"; reading only "center" dropped every
    // centred heading to the bottom of its cell.
    css.push('vertical-align:' + (st.v === 'center' || st.v === 'middle' ? 'middle' : st.v === 'top' ? 'top' : 'bottom'));
    css.push(st.wrap ? 'white-space:pre-wrap' : 'white-space:pre');
    if (st.indent) css.push(`padding-left:${2 + st.indent * 9}px`);
    return css.join(';');
}

// Headings like "TERUTANG/DIBAYAR/DIPOTONG" have no spaces; a zero-width break after each slash
// lets them wrap inside their box instead of running over the next heading.
// "KE-1" stays in one piece: a browser may break after the hyphen, which printed L11-B's months
// as "BULAN KE-" / "1" (and read as "BULAN KE1" when copied).
const breakable = (s) => esc(s).replace(/\/(?=\S)/g, '/​').replace(/(\S+-\d+)/g, '<span style="white-space:nowrap">$1</span>');
function runsHtml(value, data) {
    if (!Array.isArray(value)) return data ? esc(value) : breakable(value);
    return value.map((r) => {
        const css = [r.font && `font-family:${tf(r.font)},Arial,sans-serif`, 'font-weight:' + (r.b ? 700 : 400), r.i && 'font-style:italic', r.color && 'color:' + tc('text', r.color), r.size && `font-size:${r.size}pt`].filter(Boolean).join(';');
        return css ? `<span style="${css}">${breakable(r.t)}</span>` : breakable(r.t);
    }).join('');
}

function shapeHtml(s) {
    const clip = s.geom === 'homePlate' ? `clip-path:polygon(0 0,calc(100% - ${s.h / 2}px) 0,100% 50%,calc(100% - ${s.h / 2}px) 100%,0 100%);` : '';
    const justify = s.anchor === 'ctr' ? 'center' : s.anchor === 'b' ? 'flex-end' : 'flex-start';
    const paras = s.paragraphs.filter((p) => p.runs.length).map((p) => `<div style="text-align:${p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : 'left'}">`
        + p.runs.map((r) => `<span style="font-size:${r.size || 11}pt;${r.bold ? 'font-weight:700;' : ''}color:${tc('text', r.color)};font-family:${tf(r.font || 'Roboto Condensed')},Arial,sans-serif">${esc(r.t)}</span>`).join('') + '</div>').join('');
    // Anchored to its cell (row/col + offset), not to absolute sheet pixels: rows in the PDF can
    // grow with their content, and the badge/pointer must stay on the row it belongs to.
    const row = s.from ? s.from.row + 1 : 1, col = s.from ? s.from.col + 1 : 1;
    return `<div class="shape" data-row="${row}" data-col="${col}" data-dx="${s.from ? s.from.colOff : 0}" data-dy="${s.from ? s.from.rowOff : 0}" style="left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;${s.fill ? 'background:' + tc('bg', s.fill) + ';' : ''}${s.line ? 'outline:1px solid ' + tc('border', s.line) + ';' : ''}${clip}justify-content:${justify}">${paras}</div>`;
}

/** Sheet -> HTML. `opts.values` maps "row:col" to replacement text (data injection). */
function sheetHtml(sheet, opts = {}) {
    THEME = opts.theme ? THEMES[opts.theme] || null : null;
    const values = opts.values || new Map();
    const width = sheet.cols.reduce((a, b) => a + b, 0);
    const start = new Map(), covered = new Set();
    for (const cell of sheet.cells) {
        const [r, c, rs, cs] = cell;
        start.set(r + ':' + c, cell);
        for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (y !== r || x !== c) covered.add(y + ':' + x);
    }
    const rows = [];
    for (let r = 1; r <= sheet.rows.length; r++) {
        const h = sheet.rows[r - 1];
        let tds = '';
        let blank = 0;
        const flush = () => { if (blank) { tds += `<td colspan="${blank}"></td>`; blank = 0; } };
        for (let c = 1; c <= sheet.cols.length; c++) {
            const key = r + ':' + c;
            if (covered.has(key)) { flush(); continue; }
            const cell = start.get(key);
            if (!cell) { blank++; continue; }
            flush();
            const [, , rs, , si, value] = cell;
            let cs = cell[3];
            const shown = values.has(key) ? values.get(key) : value;
            // A run of empty cells in one style (the kop's green, the form's grey) is drawn as one
            // box: one rectangle instead of dozens keeps the PDF light enough for browser viewers
            // and leaves no seams between the pieces.
            const st = sheet.styles[si];
            if (rs === 1 && !String(shown || '').trim() && !st.border[1] && !st.border[3]) {
                for (let next = start.get(r + ':' + (c + cs)); next && next[2] === 1 && next[4] === si && !String(next[5] || '').trim() && !values.has(r + ':' + next[1]); next = start.get(r + ':' + (c + cs))) cs += next[3];
                for (let x = c + cell[3]; x < c + cs; x++) covered.add(r + ':' + x);
            }
            tds += `<td data-c="${c}"${st.data ? ' class="d"' : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}${cs > 1 ? ` colspan="${cs}"` : ''} style="${cellCss(st)}${lifted(st, shown) ? ';position:relative;z-index:1' : ''}">${runsHtml(shown, st.data)}</td>`;
        }
        flush();
        rows.push(`<tr data-r="${r}" style="height:${h}px">${tds}</tr>`);
    }
    const regions = opts.regions || {};
    return `<div class="sheet" data-label="${esc(opts.label || '')}" data-kop-end="${regions.kopEnd || 0}"${opts.slim ? ` data-slim="${esc(JSON.stringify(opts.slim))}"` : ''} data-heads='${esc(JSON.stringify(regions.heads || []))}' style="width:${width}px"><table><colgroup>${sheet.cols.map((w) => `<col style="width:${w}px">`).join('')}</colgroup><tbody>${rows.join('')}</tbody></table>`
        + (sheet.shapes || []).map(shapeHtml).join('') + '</div>';
}

const BASE_CSS = `*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:Calibri,Arial,sans-serif;font-size:11pt}
.sheet{position:relative}
.sheet table,.pg table{border-collapse:collapse;table-layout:fixed;width:100%}
.sheet td,.pg td{padding:0 2px;overflow:visible;line-height:1.15}
.sheet td.d,.pg td.d{padding:1px 4px}
.pg-foot{position:absolute;right:4px;bottom:2px;font:7pt Arial,sans-serif;color:#6b6b6b}
.shape{position:absolute;display:flex;flex-direction:column;padding:2px 6px;overflow:hidden}`;

/* Runs in the page after sheetHtml() is laid out: splits each .sheet into printed pages the way
 * Excel prints a form with title rows - every page repeats the kop, a table that runs over a page
 * repeats its column headings, and rows that belong together (a merged record, a statement with
 * its Ya/Tidak line) are never split. Shapes are then placed on the row they are anchored to;
 * kop shapes (the LAMPIRAN badge) appear on every page.
 *   opts: { pageWidth, pageHeight (CSS px of the printable area), label }
 *   sheet element dataset: kopEnd, heads (JSON [{from,to,first,last}]) */
function paginate(opts) {
    /* The form's columns were sized for handwriting, not for a 16-digit NPWP or a long name: a
     * value that does not fit widens its column just enough (spread over the columns it spans)
     * instead of spilling over its neighbour. Amounts and identifiers must fit on one line; wrapping
     * text only needs its longest word to fit. */
    const fitColumns = (sheetEl, table, target) => {
        const cols = [...table.querySelector('colgroup').children];
        const widths = cols.map((c) => parseFloat(c.style.width));
        const ctx = document.createElement('canvas').getContext('2d');
        const grow = new Array(widths.length).fill(0);
        for (const td of table.querySelectorAll('td.d')) {
            const text = td.textContent.trim();
            if (!text) continue;
            const cs = getComputedStyle(td);
            ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const nowrap = cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap';
            const pieces = nowrap ? [text] : text.split(/\s+/);
            const need = Math.max(...pieces.map((w) => ctx.measureText(w).width)) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 3;
            const c0 = +td.dataset.c - 1, span = td.colSpan || 1;
            const have = widths.slice(c0, c0 + span).reduce((a, b) => a + b, 0);
            if (need <= have) continue;
            for (let i = c0; i < c0 + span; i++) grow[i] = Math.max(grow[i], (need - have) * widths[i] / have);
        }
        // A one-cell title marked "wrap" in the workbook (OP L4's section bars) is clipped to one
        // line by Excel's fixed row height; a browser would grow the row word by word instead. When
        // the cells to its right are empty it runs on across them, as the printed form shows it.
        for (const td of sheetEl.querySelectorAll('td:not(.d)')) {
            if ((td.colSpan || 1) > 1 || (td.rowSpan || 1) > 1 || td.classList.contains('d')) continue;
            const next = td.nextElementSibling;
            if (next && !next.textContent.trim() && td.textContent.trim().length > 12) { td.style.whiteSpace = 'pre'; td.dataset.runon = '1'; }
        }
        // Table heading rows (between a section bar and its "(1) (2) ..." row).
        const headRowSet = new Set();
        for (const h of JSON.parse(sheetEl.dataset.heads || '[]')) for (let y = h.from; y <= h.to; y++) headRowSet.add(y);
        // A one-line label that would run into the text of the cell after it ("IV.B" in its small
        // gold marker, right before "RINCIAN ...") is set smaller until it fits instead.
        for (const td of sheetEl.querySelectorAll('td:not(.d)')) {
            if (td.dataset.runon || !td.textContent.trim()) continue;
            const next = td.nextElementSibling;
            if (!next || !next.textContent.trim()) continue;
            const cs = getComputedStyle(td);
            if (cs.whiteSpace !== 'pre' || td.scrollWidth <= td.clientWidth + 1) continue;
            let size = parseFloat(cs.fontSize);
            const floor = size * 0.6;
            while (td.scrollWidth > td.clientWidth + 1 && size > floor) { size -= 0.5; td.style.fontSize = size + 'px'; }
        }
        // Form headings that do not fit their cell (Chromium's metrics run a little wider than
        // Excel's) wrap at their spaces instead of running into the next heading. Only boxed
        // headings: a form's statement text is meant to run on across the empty cells beside it,
        // exactly as Excel prints it.
        const wrapHeadings = (headsOnly) => { for (const td of sheetEl.querySelectorAll('td:not(.d)')) {
            if (!td.textContent.trim() || (headsOnly && !headRowSet.has(+(td.parentElement.dataset.r || 0)))) continue;
            const cs = getComputedStyle(td);
            const boxed = parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.borderRightWidth) > 0;
            // Also a shaded heading (the last column's heading often has no right border of its
            // own) and a cell merged over several rows - both are boxes meant to hold wrapped text.
            const inHead = headRowSet.has(+(td.parentElement.dataset.r || 0));
            const shaded = inHead && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && (parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0);
            const tall = (td.rowSpan || 1) > 1 && td.textContent.trim().length > 30;
            if (td.dataset.runon) continue;
            if ((boxed || shaded || tall) && td.scrollWidth > td.clientWidth + 1 && /\s/.test(td.textContent.trim())) td.style.whiteSpace = 'normal';
        } };
        wrapHeadings();
        /* Rebalance: a column holding only one-line values (amounts, NPWP, dates) often has room
         * to spare, while a text column next to it wraps its record six lines deep. Part of the
         * spare room moves to the wrapping columns. The kop is its own table, so it keeps the
         * form's own proportions whatever happens here. */
        const spans = new Map();
        for (const td of table.querySelectorAll('td.d')) {
            const text = td.textContent.trim();
            if (!text) continue;
            const cs = getComputedStyle(td);
            ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const c0 = +td.dataset.c - 1, span = td.colSpan || 1, key = c0 + ':' + span;
            const have = widths.slice(c0, c0 + span).reduce((a, b) => a + b, 0) + grow.slice(c0, c0 + span).reduce((a, b) => a + b, 0);
            const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 4;
            const full = ctx.measureText(text).width + pad;
            const nowrap = cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap';
            const s = spans.get(key) || { c0, span, slack: Infinity, want: 0, text: false };
            if (nowrap) s.slack = Math.min(s.slack, Math.max(0, have - full));
            else { s.text = true; s.slack = 0; s.want = Math.max(s.want, Math.min(full, have * 2.6) - have); }
            spans.set(key, s);
        }
        // Columns another table on the sheet relies on (a heading or value above/below that
        // starts there) are left alone, so the neighbouring table keeps its shape.
        // Columns the data leaves completely empty (no value in any record) can give up most of
        // their width too - down to what their own heading needs.
        const dataStarts = new Set([...table.querySelectorAll('td.d')].map((td) => td.dataset.c + ':' + (td.colSpan || 1)));
        for (const key of dataStarts) {
            if (spans.has(key)) continue;
            const [c1, span] = key.split(':').map(Number);
            const c0 = c1 - 1;
            const have = widths.slice(c0, c0 + span).reduce((a, b) => a + b, 0);
            spans.set(key, { c0, span, slack: Math.max(0, have * 0.5), want: 0, text: false, empty: true });
        }
        // Budgets are per column, set by the tightest cell crossing it: a column shared by two
        // cell shapes (or by a text cell) is never cut more than all of them allow.
        const limit = new Array(widths.length).fill(Infinity);
        const blocked = new Array(widths.length).fill(false);
        for (const s of spans.values()) {
            const w = widths.slice(s.c0, s.c0 + s.span).reduce((a, b) => a + b, 0) || 1;
            for (let i = s.c0; i < s.c0 + s.span; i++) {
                if (s.text) blocked[i] = true;
                else limit[i] = Math.min(limit[i], (s.slack === Infinity ? 0 : s.slack) * (s.empty ? 1 : 0.6) * widths[i] / w);
            }
        }
        // A column never gets narrower than its own heading's longest word ("KETERANGAN" cannot
        // wrap and would run into the next heading).
        for (const td of table.querySelectorAll('td:not(.d)')) {
            const text = td.textContent.trim();
            if (!text || !td.dataset.c) continue;
            const cs = getComputedStyle(td);
            ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const need = Math.max(...text.split(/[\s​]+/).map((w) => ctx.measureText(w).width)) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 6;
            const c0 = +td.dataset.c - 1, span = td.colSpan || 1;
            const have = widths.slice(c0, c0 + span).reduce((a, b) => a + b, 0) || 1;
            for (let i = c0; i < c0 + span; i++) limit[i] = Math.min(limit[i], Math.max(0, have - need) * widths[i] / have);
        }
        const budget = limit.map((l, i) => (blocked[i] || l === Infinity || l < 2) ? 0 : l);
        const takers = [...spans.values()].filter((s) => s.text && s.want > 8);
        const pool = budget.reduce((a, b) => a + b, 0);
        const wanted = takers.reduce((a, s) => a + s.want, 0);
        if (pool > 10 && wanted > 0) {
            const give = Math.min(pool, wanted);
            budget.forEach((b, i) => { grow[i] -= b * give / pool; });
            for (const s of takers) { const add = s.want * give / wanted; const w = widths.slice(s.c0, s.c0 + s.span).reduce((a, b) => a + b, 0); for (let i = s.c0; i < s.c0 + s.span; i++) grow[i] += add * widths[i] / w; }
        }
        /* Fill the page: a form narrower than the paper gets wider columns rather than bigger
         * type (text stays the size Coretax prints its Induk at). The wrapping text columns take
         * the extra room first - which also shortens their records - and the rest is shared in
         * proportion. */
        const total = widths.reduce((a, b) => a + b, 0) + grow.reduce((a, b) => a + b, 0);
        if (target && total < target - 8) {
            let extra = target - total;
            const wants = takers.map((s) => ({ s, left: Math.max(0, s.want - widths.slice(s.c0, s.c0 + s.span).reduce((a, b, k) => a + grow[s.c0 + k], 0)) }));
            const wantSum = wants.reduce((a, x) => a + x.left, 0);
            if (wantSum > 0) {
                const give = Math.min(extra, wantSum);
                for (const { s, left } of wants) { const add = left * give / wantSum; const w = widths.slice(s.c0, s.c0 + s.span).reduce((a, b) => a + b, 0); for (let i = s.c0; i < s.c0 + s.span; i++) grow[i] += add * widths[i] / w; }
                extra -= give;
            }
            if (extra > 0) { const add = stretch(widths, extra, boxColumns(table)); add.forEach((a, i) => { grow[i] += a; }); }
        }
        if (!grow.some((g) => g !== 0)) return;
        cols.forEach((c, i) => { c.style.width = Math.max(1, widths[i] + grow[i]) + 'px'; });
        // The rebalance may narrow a heading's column down to its longest word: wrap it now.
        wrapHeadings(true);
    };
    // Columns holding small square boxes (Ya/Tidak ticks, NPWP and year digits) keep their width
    // when a form is stretched to the page: a stretched box reads as a text field.
    const boxColumns = (t) => {
        const fixed = new Set();
        for (const td of t.querySelectorAll('td')) {
            if ((td.colSpan || 1) !== 1 || !td.dataset.c) continue;
            const cs = getComputedStyle(td);
            const boxed = ['Top', 'Right', 'Bottom', 'Left'].every((side) => parseFloat(cs['border' + side + 'Width']) > 0);
            if (boxed && td.offsetWidth < 40 && /^[X0-9]?$/.test(td.textContent.trim())) fixed.add(+td.dataset.c - 1);
        }
        return fixed;
    };
    const stretch = (widths, extra, fixed) => {
        const free = widths.reduce((a, w, i) => a + (fixed.has(i) ? 0 : w), 0) || 1;
        return widths.map((w, i) => fixed.has(i) ? 0 : extra * w / free);
    };
    const sumCols = (t) => [...t.querySelector('colgroup').children].reduce((a, c) => a + parseFloat(c.style.width), 0);
    const out = [];
    for (const sheetEl of [...document.querySelectorAll('.sheet')]) {
        const table = sheetEl.querySelector('table');
        const kopEnd = +sheetEl.dataset.kopEnd || 0;
        const rowOf = (tr) => +tr.dataset.r;
        // The kop becomes a table of its own, on the form's own column widths.
        const kopTable = document.createElement('table');
        kopTable.appendChild(table.querySelector('colgroup').cloneNode(true));
        const kopBody = document.createElement('tbody');
        kopTable.appendChild(kopBody);
        for (const tr of [...table.tBodies[0].rows]) if (rowOf(tr) <= kopEnd) kopBody.appendChild(tr);
        sheetEl.insertBefore(kopTable, table);
        const kopWidth = sumCols(kopTable);
        if (opts.fit !== false) fitColumns(sheetEl, table, opts.fillWidth ? opts.fillWidth - 6 : 0);
        const bodyWidth = sumCols(table);
        // A tick box whose column grew (it shares the column with a wide table column above or
        // below) is drawn as a fixed small square inside its cell, next to its label.
        for (const td of table.querySelectorAll('td')) {
            if ((td.colSpan || 1) > 3 || td.classList.contains('d') || !/^[X]?$/.test(td.textContent.trim())) continue;
            const cs = getComputedStyle(td);
            if (!['Top', 'Right', 'Bottom', 'Left'].every((side) => parseFloat(cs['border' + side + 'Width']) > 0)) continue;
            if (td.offsetWidth < 34 || td.offsetWidth > 140 || td.offsetHeight > 40) continue;
            // only a lone box beside its label, not a cell of a table grid
            const label = td.nextElementSibling;
            if (!label || !/^(Ya|Tidak|YA|TIDAK|ATAS NAMA .+)$/.test(label.textContent.trim())) continue;
            const line = cs.borderTopColor;
            td.style.border = 'none';
            td.style.textAlign = 'right';
            td.innerHTML = `<span style="display:inline-block;width:16px;height:14px;border:1px solid ${line};text-align:center;line-height:14px;font-weight:700">${td.textContent.trim()}</span>`;
        }
        // A body widened for its data stretches the kop in proportion, so both stay flush.
        const kopScale = Math.max(1, bodyWidth / kopWidth);
        const sheetWidth = Math.max(bodyWidth, kopWidth);
        {
            const kc = [...kopTable.querySelector('colgroup').children];
            const kw = kc.map((c) => parseFloat(c.style.width));
            kc.forEach((c, i) => { c.dataset.w = kw[i]; });
            // Only the dark title block takes the extra width: the grey PERHATIAN block and the
            // LAMPIRAN badge keep their size, so the title stays centred between them (stretching
            // every column made L14's PERHATIAN block half the kop).
            const edges = kw.reduce((a, w) => { a.push(a[a.length - 1] + w); return a; }, [0]);
            const dark = new Set(), light = new Set();
            for (const td of kopTable.querySelectorAll('td')) {
                const bg = getComputedStyle(td).backgroundColor.match(/[\d.]+/g);
                if (!bg || (bg.length > 3 && +bg[3] === 0)) continue;
                const into = +bg[0] + +bg[1] + +bg[2] < 300 ? dark : light;
                const x0 = td.offsetLeft, x1 = td.offsetLeft + td.offsetWidth;
                kw.forEach((w, i) => { const mid = (edges[i] + edges[i + 1]) / 2; if (mid > x0 && mid < x1) into.add(i); });
            }
            const keep = boxColumns(kopTable);
            for (const s of sheetEl.querySelectorAll('.shape')) if (+s.dataset.row <= kopEnd && /LAMPIRAN|INDUK/.test(s.textContent)) for (let i = +s.dataset.col - 1; i < kw.length; i++) keep.add(i);
            const title = kw.map((_, i) => i).filter((i) => dark.has(i) && !light.has(i) && !keep.has(i));
            let add = stretch(kw, kopWidth * (kopScale - 1), title.length ? new Set(kw.map((_, i) => i).filter((i) => !title.includes(i))) : keep);
            // The title block sits dead centre: the blocks either side of it (PERHATIAN on the
            // left, LAMPIRAN badge and TAHUN PAJAK on the right) are made equally wide, as wide
            // as the wider of the two; the title takes what is left. Digit boxes never stretch.
            if (title.length) {
                const t0 = Math.min(...title), t1 = Math.max(...title);
                const idx = kw.map((_, i) => i);
                const L = idx.filter((i) => i < t0), R = idx.filter((i) => i > t1), T = idx.filter((i) => i >= t0 && i <= t1);
                const sum = (list) => list.reduce((a, i) => a + kw[i], 0);
                // (when the title needs more room than that leaves, both sides meet in between:
                // PERHATIAN wraps one line more, the badge block grows)
                const total = kopWidth * kopScale, side = Math.min(Math.max(sum(L), sum(R)), (total - sum(T)) / 2);
                const boxes = boxColumns(kopTable);
                const grow = (list, to) => stretch(kw, to - sum(list), new Set(idx.filter((i) => !list.includes(i) || boxes.has(i))));                if (L.length && R.length && side >= 0.8 * Math.min(sum(L), sum(R))) {
                    const a = grow(L, side), b = grow(R, side), c = grow(T, total - 2 * side);
                    add = idx.map((i) => a[i] + b[i] + c[i]);
                }
            }
            kc.forEach((c, i) => { c.style.width = kw[i] + add[i] + 'px'; });
        }
        sheetEl.style.width = sheetWidth + 'px';
        // A few pixels past the sheet so the outermost border line is not clipped by the page.
        const width = sheetWidth + 4;
        const zoom = Math.min(opts.maxZoom || 1, opts.pageWidth / width);
        const pageHeight = opts.pageHeight / zoom;
        const heads = JSON.parse(sheetEl.dataset.heads || '[]');
        const rows = [...table.tBodies[0].rows];
        // Blocks: runs of rows no rowspan crosses.
        const blocks = [];
        let cur = [], reach = 0;
        for (const tr of rows) {
            const r = rowOf(tr);
            cur.push(tr);
            for (const td of tr.cells) reach = Math.max(reach, r + (td.rowSpan || 1) - 1);
            if (r >= reach) { blocks.push(cur); cur = []; }
        }
        if (cur.length) blocks.push(cur);
        const heightOf = (block) => block.reduce((a, tr) => a + tr.getBoundingClientRect().height, 0);
        const kopHeight = kopTable.getBoundingClientRect().height;
        const headOf = (r) => heads.find((h) => r >= h.first && r <= h.last);
        const headRows = (h) => rows.filter((tr) => rowOf(tr) >= h.from && rowOf(tr) <= h.to);
        const pages = [];
        let page = { rows: [], height: kopHeight, kop: true };
        const footerRoom = 18;
        // Continuation pages carry a one-line strip (form, lampiran, NPWP, tahun) in the kop's
        // colours instead of the full kop: on a landscape page the full kop took a quarter of the
        // height of every page and doubled the page count of long lists.
        const slim = sheetEl.dataset.slim ? JSON.parse(sheetEl.dataset.slim) : null;
        const SLIM_H = 30;
        // A short unboxed line at the very end (a "Pindahkan ... ke Induk" note) never starts a
        // page on its own: it takes the block before it along.
        const isNote = (block) => block.every((tr) => [...tr.cells].every((td) => { const cs = getComputedStyle(td); return !(parseFloat(cs.borderTopWidth) || parseFloat(cs.borderBottomWidth)); }));
        const bodyBlocks = rows.length ? blocks : [];
        // A new page: the slim strip (or full kop), then the running table's headings when the
        // page opens inside a table.
        const startPage = (lead) => {
            pages.push(page);
            page = slim ? { rows: [], height: SLIM_H, slim: true } : { rows: [], height: kopHeight, kop: true };
            const head = headOf(rowOf(lead));
            if (head && rowOf(lead) > head.to) {
                page.rows.push(...headRows(head).map((tr) => tr.cloneNode(true)));
                page.height += headRows(head).reduce((a, tr) => a + tr.getBoundingClientRect().height, 0);
            }
        };
        for (const [bi, block] of bodyBlocks.entries()) {
            const h = heightOf(block);
            // A section bar never ends a page: if what follows it does not fit, it moves along.
            const isBar = (b) => b.length === 1 && [...b[0].cells].some((td) => (td.colSpan || 1) > 4 || b[0].cells.length > 4) && ([...b[0].cells].every((td) => { const bg = getComputedStyle(td).backgroundColor.match(/\d+/g); return !td.textContent.trim() || (bg && bg.length >= 3 && !(bg.length > 3 && +bg[3] === 0) && +bg[0] + +bg[1] + +bg[2] < 300); })
                // ...or a light numbered section line ("3. INVESTASI/SEKURITAS" in OP's yellow).
                || (/^(\d+|[A-Z])\.$/.test(([...b[0].cells].find((td) => td.textContent.trim()) || { textContent: '' }).textContent.trim()) &&[...b[0].cells].every((td) => !td.textContent.trim() || getComputedStyle(td).backgroundColor !== 'rgba(0, 0, 0, 0)')));
            // ...and neither does a group heading (one bold shaded line across the table)...
            const isHeading = (b) => b.length === 1 && b[0].cells.length <= 2 && [...b[0].cells].some((td) => (td.colSpan || 1) > 6 && getComputedStyle(td).fontWeight >= 600 && getComputedStyle(td).backgroundColor !== 'rgba(0, 0, 0, 0)');
            // ...nor a table's column headings or its "(1) (2) ..." line (OP's Ikhtisar printed
            // its headings at the foot of one page and its numbers on the next).
            const isHead = (b) => b.every((tr) => heads.some((hd) => rowOf(tr) >= hd.from && rowOf(tr) <= hd.to));
            const sticky = (b) => isBar(b) || isHeading(b) || isHead(b);
            // what follows = the next blocks up to and including the first that holds text and is
            // not itself one of those (the table's first record, or the text under a bar)
            let follow = 0;
            for (let k = bi + 1; k < bodyBlocks.length; k++) { follow += heightOf(bodyBlocks[k]); if (bodyBlocks[k].some((tr) => tr.textContent.trim()) && !sticky(bodyBlocks[k])) break; }
            if (sticky(block) && follow && page.height + h + follow > pageHeight - footerRoom && page.rows.length) {                startPage(block[0]);
            } else
            if (page.height + h > pageHeight - footerRoom && page.rows.length) {
                const tail = bodyBlocks.slice(bi).reduce((a, b) => a + heightOf(b), 0);
                // ...and a JUMLAH/TOTAL line never opens a page without at least the record above it.
                const opensWithTotal = /^(JUMLAH|TOTAL)\b/i.test((block[0].cells[0] && block[0].textContent.trim()) || '');
                const wantsCarry = bi > 0 && (tail < 60 || opensWithTotal ||(block.length === 1 && /^(PINDAHKAN|JUMLAHKAN)\b/i.test(block[0].textContent.trim())) || (bi === bodyBlocks.length - 1 && isNote(block)));
                // What goes along: the blocks back to the first one with text (past empty spacer
                // rows), and when that is itself a JUMLAH line, the record above it too - never
                // more than a third of a page.
                let carry = [];                if (wantsCarry) {
                    for (let k = bi - 1; k >= 0; k--) {
                        const rows = bodyBlocks[k].filter((tr) => page.rows.includes(tr));
                        if (!rows.length || heightOf(carry) + heightOf(rows) > pageHeight / 3) break;
                        carry = rows.concat(carry);
                        const text = rows.map((tr) => tr.textContent.trim()).join(' ').trim();
                        if (text && !/^(JUMLAH|TOTAL)\b/i.test(text)) break;
                    }
                    // ...and if that leaves a table's headings (or a section bar, or a spacer) at
                    // the foot of the page, they come along too.
                    let k = carry.length ? bodyBlocks.findIndex((b) => b.includes(carry[0])) - 1 : -1;
                    for (; k >= 0; k--) {
                        const rows = bodyBlocks[k].filter((tr) => page.rows.includes(tr));
                        if (!rows.length || heightOf(carry) + heightOf(rows) > pageHeight / 2) break;
                        if (!sticky(bodyBlocks[k]) && rows.some((tr) => tr.textContent.trim())) break;
                        carry = rows.concat(carry);
                    }
                }
                if (carry.length) { page.rows = page.rows.filter((tr) => !carry.includes(tr)); page.height -= heightOf(carry); }
                startPage(carry.length ? carry[0] : block[0]);
                if (carry.length) { page.rows.push(...carry); page.height += heightOf(carry); }
            }
            page.rows.push(...block);
            page.height += h;
        }
        pages.push(page);
        const shapes = [...sheetEl.querySelectorAll('.shape')];
        const leftIn = (t, c) => [...t.querySelector('colgroup').children].slice(0, c - 1).reduce((a, col) => a + parseFloat(col.style.width), 0);
        const wrap = document.createElement('div');
        pages.forEach((p, i) => {
            const pageEl = document.createElement('div');
            pageEl.className = 'pg';
            pageEl.style.cssText = (opts.cssZoom === false ? '' : `zoom:${zoom};`) + `width:${width}px;height:${pageHeight}px;position:relative;overflow:hidden;break-after:page`;
            if (p.kop) { const k = i === 0 ? kopTable : kopTable.cloneNode(true); k.style.width = sheetWidth + 'px'; k.className = 'kop'; pageEl.appendChild(k); }
            if (p.slim) {
                const bar = document.createElement('div');
                bar.className = 'pg-slim';
                bar.style.cssText = `height:${SLIM_H - 6}px;margin-bottom:6px;background:${slim.color};color:#fff;display:flex;align-items:stretch;font-family:${slim.font}`;
                const e = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
                bar.innerHTML = `<div style="flex:1;display:flex;align-items:center;padding:0 10px;font-size:9pt;font-weight:700;letter-spacing:.2px">${e(slim.title)}</div>`
                    + `<div style="display:flex;align-items:center;padding:0 12px;font-size:8pt">NPWP&nbsp;&nbsp;<b>${e(slim.npwp)}</b>&nbsp;&nbsp;&nbsp;&nbsp;TAHUN PAJAK&nbsp;&nbsp;<b>${e(slim.year)}</b></div>`
                    + `<div style="background:${slim.accent};color:${slim.color};display:flex;align-items:center;padding:0 14px;font-size:10pt;font-weight:700">${e(slim.lampiran)}&nbsp;<span style="font-weight:400;font-size:8pt">(lanjutan)</span></div>`;
                pageEl.appendChild(bar);
            }
            if (p.rows.length) {
                const t = document.createElement('table');
                t.appendChild(table.querySelector('colgroup').cloneNode(true));
                t.style.width = bodyWidth + 'px';
                const tb = document.createElement('tbody');
                p.rows.forEach((tr) => tb.appendChild(tr));
                t.appendChild(tb);
                pageEl.appendChild(t);
            }
            const foot = document.createElement('div');
            foot.className = 'pg-foot';
            const label = sheetEl.dataset.label || opts.label || '';
            foot.textContent = (label ? label + ' · ' : '') + 'Halaman ' + (i + 1) + ' dari ' + pages.length;
            pageEl.appendChild(foot);
            wrap.appendChild(pageEl);
        });
        sheetEl.replaceWith(wrap);
        wrap.className = 'sheet-pages';
        // Shapes, now that every page has its final rows: kop shapes follow the (possibly
        // stretched) kop, body shapes the body's columns.
        const pageEls = [...wrap.children];
        for (const s of shapes) {
            const r = +s.dataset.row, c = +s.dataset.col;
            for (const p of pageEls) {
                const tr = [...p.querySelectorAll('tr')].find((x) => +x.dataset.r === r);
                if (!tr) continue;
                const t = tr.closest('table');
                const inKop = t.classList.contains('kop');
                const el = s.cloneNode(true);
                // (the kop's columns stretch unevenly now: a shape follows its own column's stretch)
                const anchor = t.querySelector('colgroup').children[c - 1];
                const scale = inKop && anchor && anchor.dataset.w ? parseFloat(anchor.style.width) / +anchor.dataset.w : 1;
                el.style.left = (leftIn(t, c) + +s.dataset.dx * scale) + 'px';
                if (inKop) {
                    el.style.width = parseFloat(s.style.width) * scale + 'px';
                    // The LAMPIRAN badge closes the kop on the right: keep it flush with the edge.
                    const origRight = +s.dataset.dx + parseFloat(s.style.width) + [...t.querySelector('colgroup').children].slice(0, c - 1).reduce((a, col) => a + parseFloat(col.dataset.w || col.style.width), 0);
                    // It also starts on its column's edge, so its block is exactly as wide as the
                    // PERHATIAN block on the left (the kop is balanced on those columns).
                    if (/LAMPIRAN|INDUK/.test(s.textContent) && origRight >= kopWidth - 6) { el.style.left = leftIn(t, c) + 'px'; el.style.width = (t.offsetWidth - leftIn(t, c)) + 'px'; }
                }
                el.style.top = (t.offsetTop + tr.offsetTop + +s.dataset.dy) + 'px';
                // A pointer in the table body ("A.10") sits inside its own cell - inset from the
                // lines, as tall as the row - whatever the columns became after refitting.
                if (!inKop) {
                    const td = [...tr.cells].find((x) => +x.dataset.c <= c && +x.dataset.c + (x.colSpan || 1) > c);
                    if (td && td.offsetWidth > 20) {
                        el.style.left = (t.offsetLeft + td.offsetLeft + 3) + 'px';
                        el.style.width = Math.min(parseFloat(s.style.width), td.offsetWidth - 6) + 'px';
                        el.style.top = (t.offsetTop + tr.offsetTop + 2) + 'px';
                        el.style.height = Math.max(8, tr.offsetHeight - 4) + 'px';
                    }
                }
                p.appendChild(el);
            }
            s.remove();
        }
        // The finished column widths and row heights, for the Excel copy of the same form
        // (lib/lampiran-per11-excel.js): the widths the data needed, the heights its text wrapped to.
        const grid = { cols: [...table.querySelector('colgroup').children].map((c) => parseFloat(c.style.width)), rows: {} };
        for (const pageEl of pageEls) {
            const pk = pageEl.getBoundingClientRect().width / (pageEl.offsetWidth || 1) || 1;
            for (const tr of pageEl.querySelectorAll('tr[data-r]')) { const h = tr.getBoundingClientRect().height / pk; grid.rows[tr.dataset.r] = Math.max(grid.rows[tr.dataset.r] || 0, h); }
        }
        /* One line per ruling. The workbook draws a table's lines cell by cell - and a heading's
         * top line in thirty pieces, one per Excel column under it - so a printed page carried
         * nearly two thousand tiny rectangles and PDF viewers crawled (a real Badan file: 147,000 on
         * 72 pages). Every solid border on the page is read, pieces on the same line are joined,
         * and each colour/width is drawn as one SVG path; the cells keep their (now transparent)
         * borders, so nothing moves. */
        for (const pageEl of pageEls) {
            const pr = pageEl.getBoundingClientRect();
            const k = pr.width / (pageEl.offsetWidth || pr.width) || 1;
            // Read every solid border first, then hide them all (Chrome still paints a collapsed
            // border that is merely transparent; a hidden one it skips), then measure the cells
            // in the layout that leaves and draw the lines on their edges.
            const lines = [];
            for (const td of pageEl.querySelectorAll('td')) {
                const cs = getComputedStyle(td);
                for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
                    // (the width as written on the cell: a collapsed border reports half of it)
                    const w = parseFloat(td.style['border' + side + 'Width']) || parseFloat(cs['border' + side + 'Width']);
                    const color = cs['border' + side + 'Color'];
                    if (!parseFloat(cs['border' + side + 'Width']) || cs['border' + side + 'Style'] !== 'solid' || /^rgba\(.*,\s*0\)$/.test(color)) continue;
                    lines.push({ td, side, w, color });
                }
            }
            if (!lines.length) continue;
            for (const l of lines) l.td.style['border' + l.side + 'Style'] = 'hidden';
            const groups = new Map();
            const rects = new Map();
            for (const l of lines) {
                if (!rects.has(l.td)) rects.set(l.td, l.td.getBoundingClientRect());
                const r = rects.get(l.td);
                const x0 = (r.left - pr.left) / k, x1 = (r.right - pr.left) / k, y0 = (r.top - pr.top) / k, y1 = (r.bottom - pr.top) / k;
                const dir = l.side === 'Top' || l.side === 'Bottom' ? 'h' : 'v';
                const pos = { Top: y0, Bottom: y1, Left: x0, Right: x1 }[l.side];
                const key = dir + '|' + l.color + '|' + l.w + '|' + Math.round(pos * 4) / 4;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(dir === 'h' ? [x0 - l.w / 2, x1 + l.w / 2] : [y0 - l.w / 2, y1 + l.w / 2]);
            }
            const paths = new Map();
            for (const [key, spans] of groups) {
                const [dir, color, w, pos] = key.split('|');
                spans.sort((a, b) => a[0] - b[0]);
                let cur = null;
                const d = [];
                // each line a thin filled rectangle (a stroke prints as a hairline)
                const hw = +w / 2, p0 = (+pos - hw).toFixed(2), p1 = (+pos + hw).toFixed(2);
                const emit = () => { if (cur) d.push(dir === 'h' ? `M${cur[0].toFixed(2)} ${p0}H${cur[1].toFixed(2)}V${p1}H${cur[0].toFixed(2)}Z` : `M${p0} ${cur[0].toFixed(2)}V${cur[1].toFixed(2)}H${p1}V${cur[0].toFixed(2)}Z`); };
                for (const s of spans) { if (cur && s[0] <= cur[1] + 0.6) cur[1] = Math.max(cur[1], s[1]); else { emit(); cur = s.slice(); } }
                emit();
                const pk = color + '|' + w;
                paths.set(pk, (paths.get(pk) || '') + d.join(''));
            }
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', pageEl.offsetWidth);
            svg.setAttribute('height', pageEl.offsetHeight);
            svg.setAttribute('style', 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:2');
            for (const [pk, d] of paths) {
                const [color, w] = pk.split('|');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', d);
                path.setAttribute('fill', color);
                path.setAttribute('data-w', w);
                svg.appendChild(path);
            }
            pageEl.appendChild(svg);
        }
        out.push({ pages: pages.length, zoom, grid });
    }
    return out;
}

module.exports = { sheetHtml, fontFaces, BASE_CSS, paginate, THEMES };
