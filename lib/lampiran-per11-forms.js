/* PER-11 fill (lib/lampiran-per11-fill.js): calculation forms and answers - numbered lines'
 * value boxes, Ya/Tidak and tick boxes, letter formulas, numbered sums, DER. */
// Runs in Node: numbers go through lib/id-number.js, because the exe's Node has no Indonesian locale
// data and toLocaleString('id-ID') would print computed totals as "1,234,567".
const idNumber = require('./id-number');
const { norm, textOf, MONEY_PREFIX, similarity, index, rowsOf, restyle, mark } = require('./lampiran-per11-sheet');
const { isTotalRow, setText, looksNumeric } = require('./lampiran-per11-tables');

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
            v = idNumber.money(Number(ptkp[2]));
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
    const ix = { ...index(sheet), rowCells: null }, rows = rowsOf(sheet); // moves no cell (setText only)
    ix.rowCells = rows.cells;
    const num = (t) => { const s = String(t || '').replace(MONEY_PREFIX, '').trim(); if (!/^-?[\d.]+(,\d+)?$/.test(s)) return null; return Number(s.replace(/\./g, '').replace(',', '.')); };
    const fmt = (v) => (v < 0 ? '-' : '') + idNumber.money(Math.abs(Math.round(v)));
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
    const valueCellAt = (row, col) => rows.raw(row).find((c) => c[1] <= col && c[1] + c[3] - 1 >= col);
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
    const ix = { ...index(sheet), rowCells: rowsOf(sheet).cells }; // moves no cell (setText only)
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
        setText(sheet, cell, (v < 0 ? '-' : '') + idNumber.money(Math.abs(Math.round(v))), { right: true, bold: 'keep', wrap: false });
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
        const ratio = num(equity) ? idNumber.fixed(num(debt) / num(equity), 2) : '-';
        if (blanks[0]) setText(sheet, blanks[0], ratio, { wrap: false });
        if (blanks[1]) setText(sheet, blanks[1], num(equity) ? '1' : '-', { wrap: false });
    }
}

module.exports = { fillFields, fillAnswers, fillLetterFormulas, fillNumberedSums, fillDer };
