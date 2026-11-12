/* PER-11 fill (lib/lampiran-per11-fill.js): fillSheet - the order the fill steps run in. */
const { textOf, similarity, index, cloneSheet } = require('./lampiran-per11-sheet');
const { fillKop, flushBadge, dropLookupLists, trimMargins, plainKop } = require('./lampiran-per11-kop');
const { findTables, tableTitle, cleanHeaders, fillListTable, fillCodeTable } = require('./lampiran-per11-tables');
const { fillFields, fillAnswers, fillLetterFormulas, fillNumberedSums, fillDer } = require('./lampiran-per11-forms');
const { fillOutline, numberOutline, fillSummaryLines } = require('./lampiran-per11-outline');
const { flushTables, mergeHeadings, frameTables, compactForm, evenPairs, frameWindows } = require('./lampiran-per11-tidy');

/* ---------------------------------------------------------------- entry */
/** `data`: { npwp, year, tables: [{title, headers, rows, totals}], fields: [[label, value]], answers } */

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
        numberOutline(sheet);
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

module.exports = { fillSheet };
