/* "Formal" PDF layout for SPT Tahunan Orang Pribadi (ICT_PIT) lampiran.
 *
 * The layout is NOT invented here: lib/lampiran-op-per11.json (generated from the official
 * PER-11/PJ/2025 Excel template by scripts/build-op-per11-spec.js) supplies each lampiran's
 * section titles, column list, column numbering "(1) (2) (3)..." and "JUMLAH TABEL n" labels.
 * This module fills that template with the {tables, fields, otherText} model
 * lib/lampiran-finalize.js already extracted from Coretax, mapping Coretax's own grid columns
 * onto the PER-11 columns by name. Columns PER-11 has but Coretax doesn't render empty; columns
 * Coretax has but PER-11 doesn't (e.g. its row-number column on the harta tables) are dropped,
 * except when they clearly belong to a PER-11 column that stacks several values in one cell
 * (e.g. "PENERIMA PINJAMAN" = NIK/NPWP + NAMA), where they are stacked like the Excel does.
 *
 * Runs in the isolated print page, AFTER finalize(). Only used when layoutStyle==='formal'; the
 * default 'coretax' path never calls this module. Tables with no PER-11 counterpart still render,
 * using Coretax's own headers, so nothing is ever silently lost.
 */
module.exports = ({ model, mode, spec, taxTypeCode, badanFontFace }) => {
    // Verified against the real government Excel files (not guessed): OP's kop/section bars are
    // navy blue Arial on black text, Badan's are dark green Roboto Condensed on dark-green text
    // throughout the whole sheet body (not black) - Badan has no numbered sub-marker tables at
    // all, so `.p11-sec.sub`'s gold never actually shows for it, and doesn't need its own color.
    const isBadan = taxTypeCode === 'ICT_RCIT';
    const kop = isBadan ? '#2d471d' : '#1f3864';
    const bodyFont = isBadan ? "'Roboto Condensed',Arial,sans-serif" : 'Arial,Helvetica,sans-serif';
    const bodyColor = isBadan ? '#2d471d' : '#000';
    const style = document.createElement('style');
    style.textContent = `
        ${badanFontFace || ''}
        /* The base sheet forces Segoe UI on everything with !important; OP's PER-11 look is set in
           Arial/black, Badan's in Roboto Condensed/dark green (both confirmed against the real
           government Excel files, not assumed to share OP's palette). */
        body,.p11 *{font-family:${bodyFont}!important;color:${bodyColor};background:#fff}
        .p11-sec{break-after:avoid-page;break-inside:avoid-page;font-size:8.5pt;font-weight:700;margin:0;padding:1.4mm 2.5mm;color:#fff;background:${kop};font-family:${bodyFont}!important}
        .p11-sec.sub{background:#e8a33d;color:#fff}
        .p11-wrap{margin:0 0 5mm}
        .p11-wrap table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:7.5pt}
        /* lib/lampiran-snapshot-layout.js's base sheet sets th/td border, padding and the Coretax
           yellow th background with !important, so the PER-11 look has to override in kind. */
        .p11-wrap th,.p11-wrap td{border:.4pt solid ${isBadan ? bodyColor : '#000'}!important;padding:.9mm 1.3mm!important;vertical-align:top!important;word-wrap:break-word;overflow-wrap:anywhere}
        .p11-wrap th{background:${isBadan ? '#e7e6e6' : '#d9d9d9'}!important;font-weight:700!important;text-align:center!important;font-size:7.5pt;vertical-align:middle!important;color:${bodyColor}!important}
        .p11-wrap th .sub{display:block;font-weight:400;font-size:6.5pt;background:transparent!important;border:none!important;padding:0!important;color:${bodyColor}!important}
        .p11-wrap tr.p11-num td{background:${isBadan ? '#eef0e9' : '#f2f2f2'}!important;font-size:6.5pt;text-align:center!important;padding:.4mm!important}
        .p11-wrap td.num{text-align:right!important;white-space:nowrap}
        .p11-wrap td.ctr{text-align:center!important}
        /* The base sheet's "body *" font-size:9pt rule outranks an inherited cell size, so every
           descendant needs its size pinned or stacked values render larger than plain cells. */
        .p11-wrap td,.p11-wrap td *{font-size:7.5pt!important;line-height:1.3!important}
        /* Stacked sub-fields (e.g. NPWP + NAMA in one cell): caption sits close above its value,
           both sized close to plain cell text so a stack doesn't read louder than a normal cell. */
        .p11-wrap td .stack{display:block;margin-bottom:1.4mm}
        .p11-wrap td .stack:last-child{margin-bottom:0}
        .p11-wrap td .stack b{font-weight:600!important;color:${isBadan ? bodyColor : '#6b7280'}!important;font-size:6.5pt!important;display:block;letter-spacing:.2pt;margin-bottom:.2mm}
        .p11-wrap td .stack .v{display:block;font-size:7.5pt!important;color:${bodyColor}!important;font-weight:400!important}
        .p11-wrap tfoot td{font-weight:700;background:${isBadan ? '#e7e6e6' : '#eceef2'}}
        .p11-wrap tr.p11-omit td{background:#fff7d6;font-weight:400;text-align:left;font-style:italic}
        .p11-fields{margin:0 0 4mm;font-size:8pt}
        .p11-fields .row{display:flex;justify-content:space-between;gap:4mm;padding:1.2mm 1.4mm;border:.5pt solid ${isBadan ? bodyColor : '#000'};border-top:none}
        .p11-fields .row:first-child{border-top:.5pt solid ${isBadan ? bodyColor : '#000'}}
        .p11-fields .row .lab{flex:1}
        .p11-fields .row .val{text-align:right;min-width:26mm}
        .p11-note{font-size:7.5pt;color:#333;margin:0 0 4mm}
        .p11-line{font-size:8pt;font-weight:700;margin:2.5mm 0 1mm;color:${bodyColor};break-after:avoid-page}
        /* Calculation forms (L6, L8, L12-A): a numbered line, its caption, and one value box, under
           a heading that names the value column - the shape the official sheet uses. */
        .p11-form{margin:0 0 5mm;font-size:8pt}
        .p11-form .head{display:flex;justify-content:flex-end;margin-bottom:1.2mm}
        .p11-form .head span{background:${kop};color:#fff;font-weight:700;text-align:center;padding:1.2mm 2mm;width:62mm;font-size:8pt}
        .p11-form .row{display:flex;align-items:stretch;gap:2mm;margin-bottom:1.2mm;break-inside:avoid}
        .p11-form .row.sub{padding-left:8mm}
        .p11-form .mark{flex:0 0 7mm;background:#ffc000;color:${isBadan ? '#2d471d' : '#1f3864'};font-weight:700;
            display:flex;align-items:center;justify-content:center;font-size:8pt}
        .p11-form .lab{flex:1;background:#ececec;padding:1.4mm 2mm;display:flex;flex-direction:column;justify-content:center}
        .p11-form .lab i{font-style:normal;font-size:6.8pt;display:block;margin-top:.6mm}
        .p11-form .val{flex:0 0 62mm;border:.5pt solid ${isBadan ? bodyColor : '#000'};padding:1.4mm 2mm;text-align:right;
            display:flex;align-items:center;justify-content:flex-end;background:#fff}
        .p11-form .formula span,.p11-form .lab i{background:transparent}
        .p11-form .formula{flex:0 0 46mm;background:#ececec;display:flex;align-items:center;justify-content:center;gap:1.2mm;padding:1.4mm 1mm;font-size:7.2pt;text-align:center}
        .p11-form .formula b{background:#ffc000;color:${isBadan ? '#2d471d' : '#1f3864'};font-weight:700;padding:.2mm 1.4mm;min-width:4mm;display:inline-block;text-align:center}
        .p11-check{margin:0 0 5mm;font-size:8pt}
        .p11-check .intro{margin:1.6mm 0;line-height:1.35}
        .p11-check .row{display:flex;align-items:flex-start;gap:2.5mm;padding:1.2mm 0 1.2mm 4mm;border-bottom:.3pt solid #ccc;break-inside:avoid}
        .p11-check .box{flex:0 0 4mm;height:4mm;border:.6pt solid ${isBadan ? bodyColor : '#000'};display:flex;align-items:center;justify-content:center;font-size:7pt;font-weight:700}
        .p11-check .lab{flex:1;line-height:1.3}
        .p11-check .answers{flex:0 0 26mm;display:flex;gap:3mm;justify-content:flex-end;align-items:flex-start}
        .p11-check .answers .option{display:flex;align-items:center;gap:1.2mm;background:transparent}
        .p11-form .notes{font-size:6.8pt;margin-top:2mm}
        .p11-form .notes div{margin-bottom:.6mm}
    `;
    document.head.appendChild(style);

    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    // The template's own labels sometimes lose a space where the cell wrapped
    // ("LOKASI PENERIMAPINJAMAN"), so matching also compares with all spacing removed.
    const squash = (s) => norm(s).replace(/ /g, '');
    // When several Coretax columns stack into one PER-11 cell (e.g. "NIK/NPWP PENERIMA PINJAMAN" +
    // "NAMA PENERIMA PINJAMAN" both feed PER-11's single "PENERIMA PINJAMAN" column), the shared
    // words with the PER-11 column label are redundant as a caption - trim them off either edge so
    // the caption reads "NIK/NPWP" / "NAMA" instead of repeating "PENERIMA PINJAMAN" twice.
    const shortCaption = (header, specLabel) => {
        const h = String(header || '').trim();
        const pn = norm(specLabel);
        if (!h || !pn) return h;
        const hn = norm(h);
        if (hn === pn) return h;
        const phrase = pn.split(' ').join('[\\s/,-]+');
        let out = h;
        if (hn.startsWith(pn)) out = h.replace(new RegExp('^\\s*' + phrase + '\\b', 'i'), '');
        else if (hn.endsWith(pn)) out = h.replace(new RegExp('\\b' + phrase + '\\s*$', 'i'), '');
        out = out.replace(/^[\s/,-]+|[\s/,-]+$/g, '');
        return out || h;
    };
    const marker = (s) => (/^\s*(\d+|[A-E])\s*\./.exec(String(s || '')) || [])[1] || '';
    const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 2);
    // Jaccard (intersection/union), not intersection/min: min-based scoring let a single shared
    // word like "PENGHASILAN" alone clear the leftover pass's threshold and wrongly stack e.g.
    // "JENIS PENGHASILAN" onto the unrelated "PENGHASILAN NETO" column.
    const overlap = (a, b) => {
        const A = tokens(a), B = tokens(b);
        if (!A.length || !B.length) return 0;
        const hit = A.filter((w) => B.includes(w)).length;
        const union = new Set([...A, ...B]).size;
        return hit / union;
    };
    // Containment, not a ratio: true when every word of the SHORTER phrase appears in the longer
    // one. A ratio (Jaccard or intersection/min) can't tell "KREDITUR" fully contained in
    // "KREDITUR NOMOR IDENTITAS" (should match) apart from "PENGHASILAN NETO" sharing just one
    // word with "JENIS PENGHASILAN" (should not) - both give a similar fractional score, but only
    // the first is a genuine subset.
    const subsetOf = (a, b) => {
        const A = tokens(a), B = tokens(b);
        if (!A.length || !B.length) return false;
        const [small, big] = A.length <= B.length ? [A, B] : [B, A];
        return small.every((w) => big.includes(w));
    };

    const specTables = (spec && spec.tables) || [];
    const usedSpec = new Set();
    /* Matching is by title first, but a lot of PER-11 sheets give their table no title at all
     * (Badan L9's depreciation grid, L3's "penghasilan dari luar negeri", L7, L10-A, L11-A/C...).
     * Those could never match on words, so the whole lampiran silently fell back to Coretax's own
     * headers on an equal-width grid - the PER-11 layout was simply not being applied. Column count
     * is the reliable second signal: it says the two describe the same grid without relying on
     * wording. And one spec table may legitimately serve several Coretax tables - L9 repeats the
     * same nine-column grid for KELOMPOK 1..4, LAINNYA, PERMANEN and so on - so a spec table stays
     * reusable once every unused one has been considered. */
    function matchSpec(title, headerCount) {
        const m = marker(title);
        if (m) {
            const byMarker = specTables.filter((s, i) => !usedSpec.has(i) && marker(s.title) === m);
            if (byMarker.length === 1) return byMarker[0];
            if (byMarker.length > 1) return byMarker.sort((a, b) => overlap(b.title, title) - overlap(a.title, title))[0];
        }
        let best = null, bestScore = 0.6;
        specTables.forEach((s, i) => {
            if (usedSpec.has(i)) return;
            const score = overlap(s.title, title);
            if (score > bestScore) { best = s; bestScore = score; }
        });
        if (best) return best;
        if (!headerCount) return null;
        const sameWidth = (s) => s.columns && s.columns.length === headerCount;
        return specTables.find((s, i) => !usedSpec.has(i) && sameWidth(s))
            || specTables.find((s) => sameWidth(s))
            || null;
    }

    /* Greedy name match: exact -> containment -> token overlap. Each Coretax column is consumed at
     * most once; whatever is left over is stacked onto the PER-11 column it relates to most. */
    function mapColumns(specCols, headers) {
        const assign = specCols.map(() => []);
        const taken = new Set();
        // Coretax's own row-number column has no PER-11 counterpart on most tables. It's excluded
        // up front (not just from the leftover pass) because at only 2 characters it satisfies the
        // prefix heuristic below against almost any longer label ("NOMOR SERTIPIKAT".startsWith
        // ("NO") is true) and would otherwise get snatched by the wrong column before that column's
        // real header is even considered.
        headers.forEach((h, hi) => { if (/^NO$/.test(norm(h))) taken.add(hi); });
        const tryPass = (test) => specCols.forEach((sc, si) => {
            if (assign[si].length) return;
            const want = norm(sc.label);
            if (!want) return;
            let pick = -1, pickScore = 0;
            headers.forEach((h, hi) => {
                if (taken.has(hi)) return;
                const score = test(want, norm(h));
                if (score > pickScore) { pick = hi; pickScore = score; }
            });
            if (pick >= 0) { assign[si].push(pick); taken.add(pick); }
        });
        tryPass((want, have) => (want === have ? 1 : 0));
        tryPass((want, have) => (have && squash(want) === squash(have) ? 1 : 0));
        // Guarded to at least 4 characters on the shorter side so short fragments can't prefix-match
        // an unrelated long label (see the "NO" note above - the same risk applies to any 2-3
        // letter header/label).
        tryPass((want, have) => (have && have.length >= 4 && want.length >= 4 && (want.startsWith(have) || have.startsWith(want)) ? Math.min(want.length, have.length) / Math.max(want.length, have.length) : 0));
        // Columns that differ only by a trailing number: PER-11 writes "BULAN KE-1".."BULAN KE-12"
        // where Coretax writes "SALDO UTANG TIAP AKHIR BULAN (Rp) / Bulan - 1". Their only shared
        // word is "BULAN", which is identical across all twelve, so every name pass scores them the
        // same and the leftover pass piled all twelve onto the first month - one cell holding a
        // year of values, wide enough to trip the column-overflow guard and fail the whole export.
        // The number is the only thing that tells them apart, so pair on it, and still require a
        // shared word so unrelated numbered labels can't attract each other.
        const ordinal = (s) => (String(s).match(/(\d+)\s*$/) || [])[1] || '';
        tryPass((want, have) => (ordinal(want) && ordinal(want) === ordinal(have) && overlap(want, have) > 0 ? 1 : 0));
        tryPass((want, have) => (overlap(want, have) >= 0.6 ? overlap(want, have) : 0));
        headers.forEach((h, hi) => {
            if (taken.has(hi)) return;
            let best = -1, bestScore = 0;
            specCols.forEach((sc, si) => {
                const label = sc.label + ' ' + (sc.sub || '');
                if (!subsetOf(label, h)) return;
                const score = overlap(label, h);
                if (score > bestScore) { best = si; bestScore = score; }
            });
            if (best >= 0) { assign[best].push(hi); taken.add(hi); }
        });
        // Last resort: some PER-11 tables reuse the exact same label on adjacent columns (e.g.
        // table L3A-4/B has two columns both literally named "KODE" - the second is really a
        // VLOOKUP-resolved description, but the template's own header text doesn't say so). Name
        // matching can only ever claim ONE header per repeated label, so whatever's left over on
        // both sides after every name-based pass gets paired up left-to-right by position - both
        // sides list their fields in the same reading order, so this is a safe fallback rather than
        // dropping real data (a stray-but-visible value beats a silently missing one).
        // A PER-11 "NO." column is deliberately left unassigned here - the renderer numbers those
        // rows itself (isRowNo) - so it must not be mistaken for a genuine mapping gap and grabbed
        // by this fallback.
        const leftoverCols = specCols.map((_, si) => si).filter((si) => !assign[si].length && !/^NO$/.test(norm(specCols[si].label)));
        const leftoverHeaders = headers.map((_, hi) => hi).filter((hi) => !taken.has(hi));
        leftoverCols.forEach((si, i) => {
            if (i >= leftoverHeaders.length) return;
            const hi = leftoverHeaders[i];
            assign[si].push(hi);
            taken.add(hi);
        });
        // Multiple Coretax columns stacking into one PER-11 cell get pushed in whichever order the
        // matching passes happened to resolve them (score-driven, not document order) - e.g. a
        // "Nama" header can out-score a "Nomor Identitas WP" header in the prefix pass and land
        // first even though it reads second in Coretax's own table. Re-sort each stack back to the
        // original column order so captions always read the way the source table does.
        assign.forEach((picks) => picks.sort((a, b) => a - b));
        return assign;
    }

    const root = document.createElement('div');
    root.className = 'p11';

    /* PER-11 groups the numbered tables under lettered section bars (1..7 sit under "A. HARTA PADA
     * AKHIR TAHUN PAJAK"). Coretax has no table of its own for those bars, so they are emitted
     * from the spec's section index: a numbered table belongs to the last lettered section seen,
     * defaulting to the first one. */
    const sectionIndex = (spec && spec.index) || [];
    const letterOf = new Map();
    let running = sectionIndex.length ? sectionIndex[0].letter : '';
    specTables.forEach((s) => {
        const m = marker(s.title);
        if (/^[A-E]$/.test(m)) running = m + '.';
        letterOf.set(s, running);
    });
    let shownLetter = '';

    // A balance-sheet section (spec.sideBySide) is TWO Coretax tables back to back - Aset, then
    // Liabilitas dan Ekuitas (confirmed by lib/lampiran-layout-badan.js's existing 'L1-B' handling
    // of the same live structure) - not one table matched per spec entry, so this needs the raw
    // index to consume two model.tables entries per spec table and skip ahead.
    function parseNeracaSide(tbl) {
        if (!tbl) return [];
        const valueCol = tbl.headers.length - 1;
        return tbl.rows.map((r) => {
            const label = r.slice(0, valueCol).filter(Boolean).join(' · ');
            const value = r[valueCol] || '';
            return { label, value, bold: /^Jumlah\b/i.test(label) };
        });
    }

    const tables = model.tables || [];
    let seq = 0;
    // Label/value lines, used both for the totals printed under a group and for whatever is left at
    // the end of the lampiran.
    const emittedFields = new Set();
    const fieldsBlock = (rows) => {
        const wrap = document.createElement('div');
        wrap.className = 'p11-fields';
        rows.forEach((row) => {
            const div = document.createElement('div');
            div.className = 'row';
            const lab = document.createElement('span');
            lab.className = 'lab';
            lab.textContent = row[0] || '';
            div.appendChild(lab);
            for (let i = 1; i < row.length; i++) {
                const val = document.createElement('span');
                val.className = 'val';
                val.textContent = row[i] || '';
                div.appendChild(val);
            }
            wrap.appendChild(div);
        });
        return wrap;
    };

    // On a declaration sheet the statements are the lampiran; Coretax also exposes them as a plain
    // table, which would print the same wording twice - once as the form, once as a bare list.
    const declaration = spec && spec.checklist && spec.checklist.length;
    for (let ti = 0; ti < (declaration ? 0 : tables.length); ti++) {
        const t = tables[ti];
        const sp = matchSpec(t.title || '', t.headers.length);
        if (sp) usedSpec.add(specTables.indexOf(sp));
        const title = (sp && sp.title) || t.title || '';

        const letter = sp ? (letterOf.get(sp) || '') : '';
        if (letter && letter !== shownLetter && !/^[A-E]$/.test(marker(title))) {
            const entry = sectionIndex.find((x) => x.letter.replace('.', '') === letter.replace('.', ''));
            if (entry) {
                const head = document.createElement('div');
                head.className = 'p11-sec';
                head.textContent = entry.letter + ' ' + entry.title;
                root.appendChild(head);
            }
        }
        if (letter) shownLetter = letter;

        if (sp && sp.sideBySide) {
            const left = parseNeracaSide(t);
            const right = parseNeracaSide(tables[ti + 1]);
            ti++; // the pair's second Coretax table is consumed here, not as its own loop turn
            seq++;
            if (title) {
                const bar = document.createElement('div');
                bar.className = 'p11-sec' + (/^\d/.test(marker(title)) ? ' sub' : '');
                bar.textContent = title;
                root.appendChild(bar);
            }
            const wrap = document.createElement('div');
            wrap.className = 'p11-wrap';
            const table = document.createElement('table');
            const colgroup = document.createElement('colgroup');
            [34, 16, 34, 16].forEach((w) => { const col = document.createElement('col'); col.style.width = w + '%'; colgroup.appendChild(col); });
            table.appendChild(colgroup);
            const hr = table.createTHead().insertRow();
            sp.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c.label; hr.appendChild(th); });
            const tbody = table.createTBody();
            const rows = Math.max(left.length, right.length);
            for (let ri = 0; ri < rows; ri++) {
                const tr = tbody.insertRow();
                for (const side of [left[ri], right[ri]]) {
                    const lab = tr.insertCell(), val = tr.insertCell();
                    lab.textContent = side ? side.label : '';
                    val.textContent = side ? side.value : '';
                    val.className = 'num';
                    if (side && side.bold) { lab.style.fontWeight = '700'; val.style.fontWeight = '700'; lab.style.background = val.style.background = '#eceef2'; }
                }
            }
            wrap.appendChild(table);
            root.appendChild(wrap);
            continue;
        }

        // A table with no PER-11 counterpart used to give every column width 1 - an equal split that
        // made a four-character "KODE HARTA" as wide as a rupiah amount. Weigh each column by what
        // it actually holds, with its own longest heading word as the floor so a heading never has
        // to break mid-word.
        const weigh = (label, i) => {
            const words = String(label || '').split(/[\s/()-]+/).filter(Boolean).map((w) => w.length);
            const floor = Math.max(4, ...words);
            const widest = Math.max(0, ...t.rows.slice(0, 300).map((r) => String(r[i] ?? '').trim().length));
            return Math.max(floor, Math.min(widest, 34));
        };
        const cols = sp ? sp.columns : t.headers.map((h, i) => ({ num: '(' + (i + 1) + ')', label: h, sub: '', width: weigh(h, i) }));
        const assign = sp ? mapColumns(cols, t.headers) : cols.map((_, i) => [i]);
        seq++;

        /* L9 prints its tables under an outline the sheet spells out - "I. HARTA BERWUJUD" over the
         * five Kelompok, "II. KELOMPOK BANGUNAN" over Permanen/Tidak Permanen, "III. HARTA TAK
         * BERWUJUD" over the rest. Coretax calls all twelve "KELOMPOK n", so depreciation and
         * amortisation ran together as one series with nothing marking where one ended. */
        const outline = spec && spec.outline;
        if (outline) {
            let start = 0;
            for (const group of outline) {
                if (seq - 1 === start) {
                    const bar = document.createElement('div');
                    bar.className = 'p11-sec';
                    bar.textContent = group.marker + ' ' + group.title;
                    root.appendChild(bar);
                    break;
                }
                start += group.members || 0;
            }
        }

        if (title) {
            // Under an outline the per-table name is a line of the outline ("Kelompok 1"), not a
            // section of its own; a coloured bar for each of twelve reads far louder than the sheet.
            const bar = document.createElement('div');
            bar.className = outline ? 'p11-line' : 'p11-sec' + (/^\d/.test(marker(title)) ? ' sub' : '');
            bar.textContent = title;
            root.appendChild(bar);
        }

        const wrap = document.createElement('div');
        wrap.className = 'p11-wrap';
        const table = document.createElement('table');

        const totalWidth = cols.reduce((a, c) => a + (c.width || 1), 0);
        const colgroup = document.createElement('colgroup');
        cols.forEach((c) => { const col = document.createElement('col'); col.style.width = ((c.width || 1) / totalWidth * 100).toFixed(2) + '%'; colgroup.appendChild(col); });
        table.appendChild(colgroup);

        const thead = table.createTHead();
        /* PER-11 groups some columns under a shared heading - L9's "KOMERSIAL" and "FISKAL" sit
         * under "METODE PENYUSUTAN/AMORTISASI", L2's "NILAI (Rp)" and "%" under "MODAL DISETOR".
         * Printed as a flat row those children read as unrelated columns, and the same short name
         * ("NILAI (Rp)") appears several times with nothing to tell the groups apart. */
        const grouped = cols.some((c) => c.parent);
        if (grouped) {
            const top = thead.insertRow();
            for (let i = 0; i < cols.length;) {
                const parent = cols[i].parent || '';
                let end = i;
                while (end < cols.length && (cols[end].parent || '') === parent) end++;
                const th = document.createElement('th');
                if (parent) { th.colSpan = end - i; th.textContent = parent; }
                else {
                    th.rowSpan = 2;
                    th.textContent = cols[i].label || '';
                    if (cols[i].sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = cols[i].sub; th.appendChild(s); }
                    end = i + 1;
                }
                top.appendChild(th);
                i = end;
            }
        }
        const hr = thead.insertRow();
        cols.forEach((c) => {
            if (grouped && !c.parent) return;
            const th = document.createElement('th');
            th.textContent = c.label || '';
            if (c.sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = c.sub; th.appendChild(s); }
            hr.appendChild(th);
        });
        const nr = thead.insertRow();
        nr.className = 'p11-num';
        cols.forEach((c) => { const td = document.createElement('td'); td.textContent = c.num || ''; nr.appendChild(td); });

        // `t.moneyCols` (lib/lampiran-finalize.js) only recognises a fixed vocabulary of header
        // words ("Rp", "SALDO", "NILAI", ...) - PER-11 columns like "PENYESUAIAN FISKAL POSITIF"
        // don't contain any of them despite holding plain numbers, and were rendering left-aligned
        // as a result. Falling back to the assigned column's own values (numeric-looking in every
        // non-blank row) catches those without having to keep growing a header-keyword list.
        const looksNumeric = (v) => { const s = String(v ?? '').trim(); return !s || /^-?\(?[\d.,]+\)?%?$/.test(s); };
        // PER-11 centres its short coded/date fields and leaves prose left-aligned; money is right.
        // Anchored at the start so "NILAI (KOMERSIAL)" and "PENYESUAIAN FISKAL POSITIF" - amounts -
        // are not caught by the KOMERSIAL/FISKAL entries, which are there for L9's method columns.
        const CENTRE = /^(NO|KODE|TAHUN\b|NEGARA\b|JENIS PAJAK|TANGGAL\b|NORMA|MATA UANG ASING|NOMOR\b|NIK|NPWP|NIK NPWP|SUMBER KEPEMILIKAN|KEPEMILIKAN|LOKASI HARTA|KELOMPOK|BULAN|METODE|KOMERSIAL$|FISKAL$)/;
        const coded = cols.map((c) => CENTRE.test(norm(c.label)));
        const moneySpec = cols.map((c, ci) => {
            // A coded field is never money even though its values are all digits: "KODE HARTA"
            // holds 0710, which the value-based test below reads as a number and would then push
            // to the right edge of a column widened for rupiah amounts.
            if (coded[ci]) return false;
            if (assign[ci].some((hi) => t.moneyCols.includes(hi))) return true;
            const idx = assign[ci];
            if (!idx.length) return false;
            const vals = t.rows.map((r) => idx.map((hi) => r[hi] ?? '').join('')).filter((v) => v !== '');
            return vals.length > 0 && vals.every(looksNumeric);
        });
        const isRowNo = cols.map((c) => /^NO$/.test(norm(c.label)));
        const centreSpec = cols.map((c, ci) => coded[ci]);

        const capped = mode === 'print' && t.rows.length > 50;
        const shown = capped ? t.rows.slice(0, 50) : t.rows;
        const tbody = table.createTBody();
        if (shown.length) {
            shown.forEach((r, ri) => {
                const tr = tbody.insertRow();
                cols.forEach((c, ci) => {
                    const td = tr.insertCell();
                    const picks = assign[ci];
                    if (!picks.length && isRowNo[ci]) { td.textContent = String(ri + 1); td.className = 'ctr'; return; }
                    if (picks.length === 1) {
                        td.textContent = r[picks[0]] ?? '';
                    } else if (picks.length > 1) {
                        picks.forEach((hi) => {
                            const value = r[hi];
                            if (!value) return;
                            const line = document.createElement('span');
                            line.className = 'stack';
                            const cap = document.createElement('b');
                            cap.textContent = shortCaption(t.headers[hi], c.label);
                            line.appendChild(cap);
                            const val = document.createElement('span');
                            val.className = 'v';
                            val.textContent = value;
                            line.appendChild(val);
                            td.appendChild(line);
                        });
                    }
                    if (moneySpec[ci]) td.className = 'num';
                    else if (isRowNo[ci] || centreSpec[ci]) td.className = 'ctr';
                });
            });
        } else {
            const tr = tbody.insertRow();
            const td = tr.insertCell();
            td.colSpan = cols.length;
            td.textContent = 'Tidak ada data.';
        }
        if (capped) {
            const tr = tbody.insertRow();
            tr.className = 'p11-omit';
            const td = tr.insertCell();
            td.colSpan = cols.length;
            td.textContent = 'Ditampilkan 50 dari ' + t.rows.length.toLocaleString('id-ID') + ' baris. ' + (t.rows.length - 50).toLocaleString('id-ID') + ' baris lainnya tidak ditampilkan dalam PDF ringkas. Rincian lengkap tersedia melalui unduhan Excel atau PDF lengkap.';
        }

        const totals = t.totals || {};
        if (Object.keys(totals).length) {
            const tr = table.createTFoot().insertRow();
            const totalByCol = cols.map((c, ci) => {
                const hit = assign[ci].find((hi) => totals[hi] !== undefined);
                return hit === undefined ? null : totals[hit];
            });
            const firstValue = totalByCol.findIndex((v) => v !== null);
            const labelSpan = firstValue > 0 ? firstValue : cols.length;
            const label = tr.insertCell();
            label.colSpan = labelSpan;
            label.textContent = (sp && sp.totalLabel) || 'JUMLAH';
            for (let ci = labelSpan; ci < cols.length; ci++) {
                const td = tr.insertCell();
                if (totalByCol[ci] !== null) { td.textContent = totalByCol[ci]; td.className = 'num'; }
            }
        }

        wrap.appendChild(table);
        root.appendChild(wrap);

        /* The sheet closes each half of L9 with its own totals - a./b./c. JUMLAH PENYUSUTAN right
         * after the tangible assets, d./e./f. JUMLAH AMORTISASI after the intangible ones. Coretax
         * hands all six over together, so printed at the end they read as one block belonging to
         * neither half. Each is emitted where its half finishes instead. */
        if (outline && model.fields && model.fields.length) {
            let end = 0;
            for (const [gi, group] of outline.entries()) {
                end += group.members || 0;
                if (seq !== end) continue;
                const wantsAmortisation = /TAK BERWUJUD|TIDAK BERWUJUD/i.test(group.title || '');
                const last = gi === outline.length - 1
                    || !outline.slice(gi + 1).some((g) => /TAK BERWUJUD|TIDAK BERWUJUD/i.test(g.title || '') === wantsAmortisation);
                if (!last) break;
                const picked = model.fields.filter((row) => {
                    if (emittedFields.has(row)) return false;
                    const text = norm(row[0]);
                    if (!/JUMLAH|SELISIH/.test(text)) return false;
                    return wantsAmortisation ? /AMORTISASI/.test(text) : /PENYUSUTAN/.test(text);
                });
                if (picked.length) { root.appendChild(fieldsBlock(picked)); picked.forEach((row) => emittedFields.add(row)); }
                break;
            }
        }
    }

    /* A declaration lampiran (L10-D) is a list of statements with a tick box each. The wording
     * comes from the sheet; whether a box is ticked comes from Coretax, where each statement sits
     * in a `.p-field-checkbox` whose control lib/lampiran-snapshot-layout.js has already turned
     * into a "[X]" or "[ ]" marker. */
    const checklist = spec && spec.checklist;
    if (checklist && checklist.length) {
        const ticked = new Map();
        for (const box of document.querySelectorAll('.p-field-checkbox')) {
            const text = box.textContent.replace(/\s+/g, ' ').trim();
            const mark = text.match(/^\[([X ])\]/i);
            if (!mark) continue;
            ticked.set(squash(text.replace(/^\[[X ]\]\s*/i, '')), mark[1].toUpperCase() === 'X');
        }
        const lookup = (label) => {
            const want = squash(label);
            if (ticked.has(want)) return ticked.get(want);
            for (const [name, on] of ticked) {
                if (name.length > 12 && (name.startsWith(want) || want.startsWith(name))) return on;
            }
            return null;
        };
        /* Coretax answers these with radio buttons, which the base sheet has already turned into
         * "[X]"/"[ ]" markers sitting next to their "Ya"/"Tidak" labels. The statement they belong
         * to is the nearest block of text above them. */
        const answered = [];
        for (const group of document.querySelectorAll('.p-field-radiobutton,.p-field-checkbox,.row,.col-sm-12')) {
            const text = group.textContent.replace(/\s+/g, ' ').trim();
            const picked = text.match(/\[X\]\s*(Ya|Tidak)/i);
            if (picked && text.length < 400) answered.push({ text: squash(text.replace(/\[[X ]\]/g, ' ')), answer: picked[1] });
        }
        const pickedAnswer = (label) => {
            const want = squash(label).slice(0, 40);
            if (!want) return '';
            const hit = answered.find((a) => a.text.includes(want) || want.includes(a.text.slice(0, 40)));
            return hit ? hit.answer : '';
        };

        const wrap = document.createElement('div');
        wrap.className = 'p11-check';
        for (const entry of checklist) {
            if (entry.type === 'section') {
                const bar = document.createElement('div');
                bar.className = 'p11-sec';
                bar.textContent = [entry.marker, entry.title].filter(Boolean).join(' ');
                wrap.appendChild(bar);
            } else if (entry.type === 'text') {
                const p = document.createElement('div');
                p.className = 'intro';
                p.textContent = entry.text;
                wrap.appendChild(p);
            } else {
                const row = document.createElement('div');
                row.className = 'row';
                const answers = entry.answers || [];
                if (!answers.length) {
                    const box = document.createElement('span');
                    box.className = 'box';
                    box.textContent = lookup(entry.label) === true ? '✓' : '';
                    row.appendChild(box);
                }
                const lab = document.createElement('span');
                lab.className = 'lab';
                lab.textContent = [entry.marker && entry.marker + '.', entry.label].filter(Boolean).join(' ');
                row.appendChild(lab);
                // L10-B answers each statement Ya or Tidak rather than ticking one box, so both
                // options are printed and the one Coretax holds is marked.
                if (answers.length) {
                    const chosen = pickedAnswer(entry.label);
                    const group = document.createElement('span');
                    group.className = 'answers';
                    for (const answer of answers) {
                        const option = document.createElement('span');
                        option.className = 'option';
                        const box = document.createElement('span');
                        box.className = 'box';
                        box.textContent = chosen && squash(chosen) === squash(answer) ? '✓' : '';
                        option.appendChild(box);
                        option.appendChild(document.createTextNode(answer));
                        group.appendChild(option);
                    }
                    row.appendChild(group);
                }
                wrap.appendChild(row);
            }
        }
        root.appendChild(wrap);
    }

    /* A calculation-form lampiran is laid out from the spec's own lines, with Coretax's values
     * matched onto them by caption. Without this the sheet had no spec at all and printed as
     * whatever plain tables Coretax exposed - which is what "masih terlalu polos" meant. */
    const form = spec && spec.form;
    if (form && form.items && form.items.length) {
        const valueOf = (label) => {
            const want = squash(label);
            for (const row of model.fields || []) {
                const name = squash(String(row[0] || '').replace(/^\s*\d+[.)]?\s*/, '').replace(/^[a-z][.)]\s*/i, ''));
                if (!name) continue;
                if (name === want || (name.length > 8 && want.startsWith(name)) || (want.length > 8 && name.startsWith(want))) {
                    return (row.slice(1).find((v) => String(v || '').trim()) || '').replace(/^Rp\.?\s*/i, '').trim();
                }
            }
            return '';
        };
        const wrap = document.createElement('div');
        wrap.className = 'p11-form';
        const head = document.createElement('div');
        head.className = 'head';
        const headLabel = document.createElement('span');
        headLabel.textContent = form.valueLabel || 'NILAI (Rp)';
        head.appendChild(headLabel);
        wrap.appendChild(head);
        for (const item of form.items) {
            const row = document.createElement('div');
            row.className = 'row' + (/^[a-z]$/i.test(item.marker) ? ' sub' : '');
            const mark = document.createElement('span');
            mark.className = 'mark';
            mark.textContent = item.marker;
            row.appendChild(mark);
            const lab = document.createElement('span');
            lab.className = 'lab';
            lab.appendChild(document.createTextNode(item.label || ''));
            if (item.note) { const note = document.createElement('i'); note.textContent = item.note; lab.appendChild(note); }
            row.appendChild(lab);
            // The sheet prints the arithmetic between caption and value box, with each operand in
            // its own gold box: "( 1 - 2 )", "( Tarif x 3 )".
            const formula = document.createElement('span');
            formula.className = 'formula';
            for (const token of String(item.formula || '').split(/\s+/).filter(Boolean)) {
                const piece = document.createElement(/^\d+[a-z]?$/i.test(token) ? 'b' : 'span');
                piece.textContent = token;
                formula.appendChild(piece);
            }
            row.appendChild(formula);
            const val = document.createElement('span');
            val.className = 'val';
            val.textContent = valueOf(item.label);
            row.appendChild(val);
            wrap.appendChild(row);
        }
        if (form.notes && form.notes.length) {
            const notes = document.createElement('div');
            notes.className = 'notes';
            form.notes.forEach((n) => { const d = document.createElement('div'); d.textContent = n; notes.appendChild(d); });
            wrap.appendChild(notes);
        }
        root.appendChild(wrap);
    }

    const remaining = (model.fields || []).filter((row) => !emittedFields.has(row));
    if (!form && remaining.length) root.appendChild(fieldsBlock(remaining));

    // `model.otherText` is whatever text was left on the page once tables and headings were taken
    // out - on these forms that is leftover interface wording, run together without punctuation
    // ("...PERHITUNGAN DERJumlah Saldo Rata-Rata UtangJumlah Saldo Rata-Rata Modal=00=N/AApakah
    // Anda mempunyai utang swasta luar negeri?Tidak Ya"), plus section titles already printed
    // above. A PER-11 form has a fixed layout with no place for it, so it is not carried over; the
    // Excel workbook still keeps it under "Keterangan lampiran".

    document.body.replaceChildren(root);

    /* PER-11 column widths come from the official sheet, and a few of its headings do not fit the
     * column they belong to once rendered here - "TAHUN" printed as "TAHU/N", "NO." as "N/O". The
     * page wraps anywhere because data cells need it, so instead the heading is stepped down in
     * size until its longest word fits, which is what the form itself does. */
    const canvas = document.createElement('canvas').getContext('2d');
    for (const th of document.querySelectorAll('.p11-wrap th')) {
        // A slash is a natural place to break "BUNGA/TAHUN", but the page wraps anywhere and would
        // sooner split the word after it, so the opportunity is marked explicitly.
        for (const node of [...th.childNodes]) {
            if (node.nodeType !== 3 || !node.textContent.includes('/')) continue;
            const parts = node.textContent.split('/');
            const fragment = document.createDocumentFragment();
            parts.forEach((part, i) => {
                if (i) { fragment.append('/'); fragment.append(document.createElement('wbr')); }
                fragment.append(part);
            });
            node.replaceWith(fragment);
        }
        const words = (th.textContent || '').trim().split(/[\s/()-]+/).filter(Boolean);
        if (!words.length) continue;
        const style = getComputedStyle(th);
        const room = th.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1;
        if (!(room > 0)) continue;
        let size = parseFloat(style.fontSize);
        const widest = () => {
            canvas.font = style.fontWeight + ' ' + size + 'px ' + style.fontFamily;
            return Math.max(...words.map((w) => canvas.measureText(w).width));
        };
        while (widest() > room && size > 5) size -= 0.25;
        if (size < parseFloat(style.fontSize)) th.style.setProperty('font-size', size.toFixed(2) + 'px', 'important');
    }
};
