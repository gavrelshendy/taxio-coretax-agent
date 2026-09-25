/* Generator (run by hand, not at runtime): reads the official PER-11/PJ/2025 SPT Tahunan OP Excel
 * template and writes lib/lampiran-op-per11.json - the column/section layout the "formal" PDF
 * renderer (lib/lampiran-layout-op-formal.js) fills Coretax data into.
 *
 *   node scripts/build-op-per11-spec.js ["path/to/Excel SPT Tahunan OP....xlsx"]
 *
 * Each table is anchored on its "(1) (2) (3)..." numbering row: that row's merged cells define the
 * exact column boundaries, the rows above give each column's label (only cells whose merge sits
 * INSIDE the column span count, so the section bar spanning the whole table is ignored).
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const SHEETS = ['L1-1', 'L1-2', 'L1-3', 'L2', 'L3A-1', 'L3A-2', 'L3A-3', 'L3A-4', 'L3B', 'L3C', 'L3D', 'L4', 'L5'];
const DEFAULT_XLSX = path.join(__dirname, '..', 'templates', 'spt-tahunan-op-per11.xlsx');

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

function extractSheet(ws) {
    const spanAt = mergeIndex(ws);
    const cellText = (row, col) => { const s = spanAt(row, col); return txt(ws.getRow(s.top).getCell(s.left).value); };
    const lastRow = ws.actualRowCount ? ws.dimensions.bottom : 200;

    // Header block: "LAMPIRAN n"/"HALAMAN n" badge, PERHATIAN paragraph, lettered section index.
    let lampiran = '', halaman = '', perhatian = '';
    const index = [];
    for (let r = 1; r <= 12; r++) {
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
            const t = txt(c.value);
            if (/^LAMPIRAN\s+\S+$/i.test(t)) lampiran = lampiran || t;
            else if (/^HALAMAN\s+\d+$/i.test(t)) halaman = halaman || t;
            else if (/^LAMPIRAN INI /i.test(t)) perhatian = perhatian || t;
            else if (/^[A-E]\.$/.test(t)) {
                const title = cellText(r, c.col + 1) || cellText(r, c.col + 2);
                if (title && !index.some((x) => x.letter === t)) index.push({ letter: t, title });
            }
        });
    }

    // Tables, anchored on their "(n)" numbering rows.
    const tables = [];
    for (let r = 1; r <= lastRow; r++) {
        const nums = [];
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
            if (!/^\(\d+\)\.?$/.test(txt(c.value))) return;
            const s = spanAt(r, c.col);
            if (!nums.some((n) => n.left === s.left)) nums.push({ num: txt(c.value).replace('.', ''), left: s.left, right: s.right });
        });
        if (nums.length < 3) continue;
        nums.sort((a, b) => a.left - b.left);

        // Balance-sheet-style sections (bookkeeping-method L3A-1/2/3's own "Laporan Posisi
        // Keuangan") repeat the SAME "(1) (2) (3)" numbering side by side for two independent
        // blocks (ASET, then LIABILITAS DAN EKUITAS/KEWAJIBAN) - a number reappearing after
        // already being seen marks the start of the second block (same pattern confirmed on
        // Badan's L1D via scripts/build-badan-per11-spec.js).
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
                    if (/^(\d+|[A-E])\.(\d+)?$/.test(t)) { const s = spanAt(hr, c.col); title = (t + ' ' + txt(ws.getRow(s.top).getCell(s.right + 1).value)).trim(); }
                });
            }
            // A number reappearing on its own isn't proof of a real side-by-side balance sheet -
            // L5's "C. PENGURANG PPh TERUTANG" section reset numbers for an unrelated reason and
            // got mis-treated as one before this guard existed. Only trust the ASET/LIABILITAS
            // shape when the section's own title actually says so.
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

        // Walk upward from the numbering row collecting header-label rows, and stop at the section
        // bar ("1." + "KAS DAN SETARA KAS" sit in separate, unmerged cells - so it has to be
        // recognised by its bare "n."/"X." marker rather than by its merge width).
        const left = nums[0].left, right = nums[nums.length - 1].right;
        // A genuine "JUMLAH ..." total-row label can never appear here - this loop only ever scans
        // rows ABOVE the numbering row, and totals always sit below the data. Some PER-11 columns
        // legitimately use "JUMLAH ..." as their own column header text (e.g. table E's "JUMLAH PPh
        // YANG DIPOTONG/DIPUNGUT"), so it must not be filtered out as noise here.
        const noise = (t) => !t || /^PINDAHKAN/i.test(t) || /^\(\d+\)/.test(t);
        const labelRows = [];
        let title = '', sealed = false;
        for (let hr = r - 1; hr >= Math.max(1, r - 6); hr--) {
            const cells = [];
            for (let c = left; c <= right;) {
                const s = spanAt(hr, c);
                cells.push({ t: txt(ws.getRow(s.top).getCell(s.left).value), left: s.left, right: s.right });
                c = s.right + 1;
            }
            const texts = cells.map((x) => x.t).filter((t) => t && !noise(t));
            // Most sheets mark a section with a bare "1."/"A." - L3A-1/2/3 (and maybe others) use a
            // compound "A.1"/"A.2" subsection marker instead, which the bare pattern doesn't match.
            const marker = texts.find((t) => /^(\d+|[A-E])\.(\d+)?$/.test(t));
            const inline = texts.find((t) => /^(\d+\.|[A-E]\.(\d+\.)?)\s+\S/.test(t));
            if (marker) { title = (marker + ' ' + texts.filter((t) => t !== marker).join(' ')).trim(); break; }
            if (inline) { title = inline; break; }
            // A blank row separates the kop from the table's own header block; past it the wording
            // belongs to the kop, not to any column. The scan still climbs on, because the section
            // title it is looking for sits above that gap.
            if (!texts.length) { if (labelRows.length) sealed = true; continue; }
            if (!sealed) labelRows.push(cells);
        }

        const columns = nums.map((n) => {
            const labels = [];
            for (const cells of labelRows) {
                for (const cell of cells) {
                    if (cell.left < n.left || cell.right > n.right) continue;
                    if (noise(cell.t) || labels.includes(cell.t)) continue;
                    labels.push(cell.t);
                }
            }
            labels.reverse();
            return { num: n.num, label: labels[0] || '', sub: labels.slice(1).join(' '), left: n.left, right: n.right, width: n.right - n.left + 1 };
        });

        // Row anchors for the Excel filler: the blank data band sits between the numbering row and
        // the table's "JUMLAH ..." row, which is also where extra rows get inserted.
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
    // Form extent for the print area: the widest table column is the form's right edge, so the
    // per-code lookup tables parked further right (AW/BK...) stay out of the printout.
    const formRight = tables.reduce((m, t) => Math.max(m, ...t.columns.map((c) => c.right)), 0);
    const formBottom = tables.reduce((m, t) => Math.max(m, t.totalRow || t.dataEnd || 0), 0);
    return { lampiran, halaman, perhatian, index, formRight, formBottom, tables };
}

(async () => {
    const file = process.argv[2] || DEFAULT_XLSX;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const spec = {};
    for (const name of SHEETS) {
        const ws = wb.getWorksheet(name);
        if (!ws) { console.warn('Sheet tidak ditemukan: ' + name); continue; }
        spec[name] = extractSheet(ws);
        // The government template itself has a typo on L3A-3's badge cell - it literally reads
        // "LAMPIRAN 3A-1" (a copy-paste leftover from L3A-1, confirmed by inspecting the raw cell,
        // not an extraction bug). Correcting it here rather than trusting the source verbatim.
        if (name === 'L3A-3' && /^LAMPIRAN 3A-1$/.test(spec[name].lampiran)) spec[name].lampiran = 'LAMPIRAN 3A-3';
        console.log(name + ': ' + spec[name].tables.length + ' tabel, ' + spec[name].index.length + ' bagian, lampiran="' + spec[name].lampiran + '"');
    }
    const out = path.join(__dirname, '..', 'lib', 'lampiran-op-per11.json');
    fs.writeFileSync(out, JSON.stringify(spec, null, 1));
    console.log('Ditulis: ' + out);
})().catch((e) => { console.error(e); process.exit(1); });
