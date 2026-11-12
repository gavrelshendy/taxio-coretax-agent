/* PER-11 fill (lib/lampiran-per11-fill.js): the kop (NPWP/TAHUN PAJAK boxes, badge, flat
 * fills) and the workbook clean-up done before filling (lookup lists, margins). */
const { norm, textOf, index, restyle } = require('./lampiran-per11-sheet');
const { sheetRegions } = require('./lampiran-per11-tidy');

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

module.exports = { fillKop, flushBadge, dropLookupLists, trimMargins, plainKop };
