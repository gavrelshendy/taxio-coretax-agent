/* SPT Tahunan (Badan, OP) lampiran rows straight from Coretax's grid API (loadcit/*, loadpit/*), instead
 * of paging the on-screen tables. Needed for the long lists: Badan L3 (kredit pajak) with 58.914 rows and
 * L9 (penyusutan) with 19.788 rows were seen live 2026-10-20; reading those page by page took many
 * minutes and broke when Angular rebuilt a big table mid-read.
 *
 * Which tables: every table that has more rows than the screen shows ("dari N entri" > rows on page 1),
 * plus the hand-mapped ones (TABLES). A table whose rows are all on screen stays a screen read.
 *
 * Which grid: one of the requests Coretax itself made for this SPT (same record id) whose total equals
 * "dari N entri" and whose first page calibrates against the screen (L9 has one request variant per
 * asset group - body GroupType "Group 1", ...).
 *
 * Which field and format per column: never guessed. For each column the API field + format that
 * reproduces EVERY cell of page 1 (hand-mapped fields first). If several fields do, they must agree on
 * every row, or the column is ambiguous and the table is read page by page instead. A code shown as
 * text ("0710" -> "Peralatan Lainnya", "GL" -> "Garis Lurus") uses the page-1 pairs, then the code list
 * the page itself loaded that agrees with all of them (returnsheet-grid-api codeLists); a code nothing
 * explains throws. collectTabFromRows then checks again: row count and every page-1 cell. */
const gridApi = require('./returnsheet-grid-api');
const idNumber = require('./id-number'); // no Intl in the exe

const API = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
// [heading regex (leaf heading, upper case), candidate API fields]; 'no' = running number. First match wins.
const TABLES = {
    L3: [{
        suffix: '/loadcit/l3-table-b-grid', signature: /NAMA PEMOTONG\/PEMUNGUT.*JENIS PAJAK/,
        columns: [[/^NO\.?$/, 'no'], [/NAMA PEMOTONG/, ['Name']], [/NPWPW? PEMOTONG/, ['TIN']], [/JENIS PAJAK/, ['TaxType']],
            [/DASAR PENGENAAN/, ['TaxBase']], [/PPH YANG DIPOTONG.*USD/, ['IncomeTaxUsd']], [/PPH YANG DIPOTONG/, ['IncomeTax']],
            [/NOMOR/, ['WithholdingSlipsNumber']], [/TANGGAL/, ['WithholdingSlipsDate']]]
    }],
    L4: [{
        suffix: '/loadcit/l4-table-a-grid', signature: /KODE OBJEK PAJAK.*PPH FINAL/,
        columns: [[/^NO\.?$/, 'no'], [/NPWP PEMOTONG/, ['TIN']], [/NAMA PEMOTONG/, ['Name']], [/KODE OBJEK PAJAK/, ['TaxObjectCode']],
            [/^OBJEK PAJAK$/, ['TaxObject', 'TaxObjectCode']], [/DASAR PENGENAAN.*USD/, ['TaxBaseUsd']], [/DASAR PENGENAAN/, ['TaxBase']],
            [/TINGKAT/, ['TaxRate']], [/PPH FINAL.*USD/, ['IncomeTaxUsd']], [/PPH FINAL/, ['IncomeTax']]]
    }],
    // L9: one table per asset group, each from its own request variant of these grids.
    L9: [{
        suffixes: ['/loadcit/l9-table-1-grid', '/loadcit/l9-table-2-grid', '/loadcit/l9-table-3-grid'], signature: /KODE HARTA.*KELOMPOK\/JENIS HARTA/,
        columns: [[/^KODE HARTA$/, ['CodeOfAsset|GroupAssetType']], [/KELOMPOK\/JENIS HARTA/, ['GroupAssetType']], [/BULAN\/TAHUN PEROLEHAN/, ['MonthYearAcquisition']],
            [/BIAYA PEROLEHAN/, ['AcquisitionPrice']], [/NILAI SISA BUKU/, ['RemainingBeginningValue']], [/PENYUSUTAN\/AMORTISASI FISKAL TAHUN INI/, ['FiscalYearValue']],
            [/KOMERSIAL/, ['MethodCommercial']], [/FISKAL/, ['MethodFiscal']], [/KETERANGAN/, ['Notes']]]
    }]
};
const suffixesOf = (t) => t.suffixes || [t.suffix];
const GRIDS = Object.fromEntries(Object.entries(TABLES).map(([label, list]) => [label, list.flatMap(suffixesOf)]));

const present = (v) => v !== null && v !== undefined && v !== '';
const ymd = (v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
const FORMATS = {
    text: (v) => present(v) ? String(v).replace(/\s+/g, ' ').trim() : '',
    money: (v) => present(v) && Number.isFinite(Number(v)) ? idNumber.money(v) : (present(v) ? null : ''),
    fixed2: (v) => present(v) && Number.isFinite(Number(v)) ? idNumber.fixed(v, 2) : (present(v) ? null : ''),
    dateDash: (v) => { const m = ymd(v); return m ? m[3] + '-' + m[2] + '-' + m[1] : (present(v) ? null : ''); },
    dateSlash: (v) => { const m = ymd(v); return m ? m[3] + '/' + m[2] + '/' + m[1] : (present(v) ? null : ''); },
    monthYearDash: (v) => { const m = ymd(v); return m ? m[2] + '-' + m[1] : (present(v) ? null : ''); },
    monthYearSlash: (v) => { const m = ymd(v); return m ? m[2] + '/' + m[1] : (present(v) ? null : ''); }
};
/** A row's value for a field; "A|B" = A, or B when A is empty (L9 KODE HARTA: CodeOfAsset else GroupAssetType). */
const fieldValue = (row, field) => { for (const f of field.split('|')) if (present(row[f])) return row[f]; return row[field.split('|').pop()]; };
const hasField = (rows, field) => field.split('|').some((f) => rows.some((row) => f in row));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** The hand mapping (TABLES) for a table with these leaf `headings`, or null. */
function tableFor(label, headings) {
    const joined = headings.map(norm).join(' ');
    return (TABLES[label] || []).find((t) => t.signature.test(joined)) || null;
}

/** How column `c` (heading `heading`) shows an API row, proven on page 1: `apiRows` (page 1 = the first
 *  shownRows.length of them) and `shownRows` (page 1 as Coretax displays it). `hint`: the hand-mapped
 *  fields, tried alone when present; otherwise every API field. Returns (row, n) => text. */
function planColumn(heading, c, apiRows, shownRows, codeLists, hint) {
    if (/^NO\.?$/.test(norm(heading))) { const dot = shownRows.length && /\.$/.test(shownRows[0][c] || '') ? '.' : ''; return (row, n) => (n + 1) + dot; }
    const sample = shownRows.map((cells, i) => [apiRows[i], cells[c] ?? '']).filter(([row]) => row);
    const fields = hint || [...new Set(apiRows.slice(0, 50).flatMap((row) => Object.keys(row)))].filter((f) => !/^(RecordId|Index|Action|IsManually|TableSource)$/.test(f));
    const usable = fields.filter((f) => hasField(apiRows, f));
    const candidates = [];
    for (const field of usable) for (const fmt of Object.values(FORMATS)) {
        if (sample.every(([row, shown]) => fmt(fieldValue(row, field)) === shown)) { candidates.push((row) => fmt(fieldValue(row, field))); break; }
    }
    if (!candidates.length && sample.length) {
        for (const field of usable) {
            const pairs = new Map();
            if (!sample.every(([row, shown]) => { const k = String(fieldValue(row, field) ?? ''); if (pairs.has(k)) return pairs.get(k) === shown; pairs.set(k, shown); return true; })) continue;
            const lists = (codeLists || []).filter((l) => [...pairs].every(([k, v]) => !k || l.map[k] === v));
            candidates.push((row) => {
                const k = String(fieldValue(row, field) ?? '');
                if (pairs.has(k)) return pairs.get(k);
                const found = lists.map((l) => l.map[k]).filter((v) => v !== undefined);
                return found.length && found.every((v) => v === found[0]) ? found[0] : null;
            });
        }
    }
    if (!candidates.length) throw new Error('kolom "' + heading + '" tidak cocok dengan field API mana pun');
    const out = apiRows.map((row, n) => {
        const v = candidates[0](row, n);
        if (v === null) throw new Error('kolom "' + heading + '" baris ' + (n + 1) + ': kode API tidak dapat ditampilkan seperti Coretax');
        if (!hint) for (const other of candidates.slice(1)) if (other(row, n) !== v) throw new Error('kolom "' + heading + '" tidak tunggal: beberapa field API cocok di halaman 1 tetapi berbeda di baris ' + (n + 1));
        return v;
    });
    return (row, n) => out[n];
}

/** Display rows for every API row of a table showing `headings`. `table`: hand mapping or null. */
function toDisplayRows(table, headings, apiRows, shownRows, codeLists = []) {
    if (!apiRows.length) return [];
    const plan = headings.map((heading, c) => {
        let hint = null;
        if (table) {
            const rule = table.columns.find(([re]) => re.test(norm(heading)));
            if (!rule) throw new Error('kolom "' + heading + '" belum terpetakan di ' + suffixesOf(table).join(', '));
            hint = rule[1] === 'no' ? null : rule[1];
        }
        return planColumn(heading, c, apiRows, shownRows, codeLists, hint);
    });
    return apiRows.map((row, n) => plan.map((col) => col(row, n)));
}

/** First page (and total) of a grid request, cached briefly per page. */
const firstPages = new WeakMap();
function firstPage(page, variant, rows) {
    if (!firstPages.has(page)) firstPages.set(page, new Map());
    const cache = firstPages.get(page), key = variant.pathname + '|' + variant.variantKey;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000 && hit.rows >= rows) return hit.value;
    const value = gridApi.authenticatedPost(page, variant.url, { ...variant.body, First: 0, Rows: rows }).then((res) => {
        if (!res || res.status !== 200 || !res.json || res.json.IsSuccessful === false) throw new Error('API grid gagal ' + variant.pathname + ' (HTTP ' + (res && res.status || 0) + ')');
        const payload = res.json.Payload || {};
        return { total: Number(payload.TotalRecords), rows: Array.isArray(payload.Data) ? payload.Data : [] };
    });
    value.catch(() => cache.delete(key));
    cache.set(key, { at: Date.now(), rows, value });
    return value;
}

/** The grid requests Coretax made for the SPT open in `page` (its record id in the address). */
function variantsForPage(page, suffixes) {
    const ids = /-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i.exec(page.url());
    const record = ids ? ids[2].toLowerCase() : '';
    return gridApi.dataRequestVariants(page.context()).filter((v) => /\/load[a-z0-9]+\//.test(v.pathname)
        && (!suffixes || suffixes.some((s) => v.pathname.endsWith(s)))
        && (!record || String(v.body.ReturnSheetRecordId || '').toLowerCase() === record));
}

/** For lib/lampiran-capture.js collectTabFromRows: rows of table `index` of `label`, or null when the
 *  table is read from the screen (its rows are all there and it is not hand-mapped). */
async function displayRows(page, label, headers, index, shown) {
    const headings = shown && shown.leafHeaders && shown.leafHeaders.length ? shown.leafHeaders : headers;
    const hand = tableFor(label, headings);
    const shownRows = shown ? shown.rows : [];
    const expected = shown && shown.total !== null && shown.total !== undefined ? shown.total : shownRows.length;
    if (!hand && expected <= shownRows.length) return null;
    if (!expected) return [];
    if (!gridApi.hasAuthorization(page.context())) throw new Error('header autentikasi Coretax belum tertangkap');
    const variants = variantsForPage(page, hand ? suffixesOf(hand) : null);
    if (!variants.length) throw new Error('permintaan grid untuk tabel ' + (index + 1) + ' belum terlihat');
    const codeLists = gridApi.watchContext(page.context()).codeLists;
    const matches = [];
    for (const v of variants) {
        let first;
        try { first = await firstPage(page, v, Math.max(shownRows.length, 1)); } catch (e) { continue; }
        if (first.total !== expected) continue;
        try { toDisplayRows(hand, headings, first.rows.slice(0, shownRows.length), shownRows, codeLists); matches.push({ v, first }); } catch (e) { /* not this grid */ }
    }
    if (!matches.length) throw new Error('tabel ' + (index + 1) + ': tidak ada grid API dengan ' + expected + ' baris yang cocok dengan halaman 1');
    // Two grids that both fit page 1 must hold the same rows there, or it is not known which one this is.
    const sig = (m) => JSON.stringify(m.first.rows.slice(0, shownRows.length).map((r) => Object.entries(r).filter(([k, x]) => !/^(RecordId|Index)$/.test(k) && typeof x !== 'object')));
    if (matches.length > 1 && new Set(matches.map(sig)).size > 1) throw new Error('tabel ' + (index + 1) + ': lebih dari satu grid API cocok (' + matches.map((m) => m.v.pathname.split('/').pop()).join(', ') + ')');
    const chosen = matches[0].v;
    const all = (await gridApi.fetchAllRowsFromRequest(page, { pathname: chosen.pathname, url: chosen.url || API + chosen.pathname, body: chosen.body })).rows;
    return toDisplayRows(hand, headings, all, shownRows, codeLists);
}

module.exports = { GRIDS, TABLES, FORMATS, tableFor, toDisplayRows, displayRows, planColumn };
