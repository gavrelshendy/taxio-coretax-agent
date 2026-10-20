/* SPT Tahunan PPh Badan lampiran rows straight from Coretax's grid API (loadcit/*), instead of paging
 * the on-screen tables. Needed for the long lists: L3 (kredit pajak, bukti potong pihak lain) can hold
 * tens of thousands of rows (58.914 seen live 2026-10-20), and reading those page by page took minutes
 * and broke when Angular rebuilt a 500-row table mid-read.
 *
 * Fields per grid come from Coretax's own column definitions (its web app's initColumn). How each
 * column is DISPLAYED is not guessed: it is calibrated on the rows Coretax shows on page 1 (500 rows
 * after setUpTables) - for every column the first format that reproduces every visible cell is used,
 * or, when no format does (e.g. a code shown as text), the code -> text pairs seen on page 1. A value
 * that page 1 cannot explain throws, and the tab is read page by page instead. collectTabFromRows then
 * checks again: row count = "dari N entri" and every page-1 cell identical.
 *
 * Only the API-mapped tables come from the API; the other tables of the tab (small, unpaged) are read
 * from the screen as they are. */
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
    }]
};
const GRIDS = Object.fromEntries(Object.entries(TABLES).map(([label, list]) => [label, list.map((t) => t.suffix)]));

const present = (v) => v !== null && v !== undefined && v !== '';
const ymd = (v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
const FORMATS = {
    text: (v) => present(v) ? String(v).replace(/\s+/g, ' ').trim() : '',
    money: (v) => present(v) && Number.isFinite(Number(v)) ? idNumber.money(v) : (present(v) ? null : ''),
    fixed2: (v) => present(v) && Number.isFinite(Number(v)) ? idNumber.fixed(v, 2) : (present(v) ? null : ''),
    dateDash: (v) => { const m = ymd(v); return m ? m[3] + '-' + m[2] + '-' + m[1] : (present(v) ? null : ''); },
    dateSlash: (v) => { const m = ymd(v); return m ? m[3] + '/' + m[2] + '/' + m[1] : (present(v) ? null : ''); }
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** The grid mapping that table with these leaf `headings` shows, or null (read it from the screen). */
function tableFor(label, headings) {
    const joined = headings.map(norm).join(' ');
    return (TABLES[label] || []).find((t) => t.signature.test(joined)) || null;
}

/** Display rows for every API row, calibrated on `shownRows` (page 1 as Coretax displays it). */
function toDisplayRows(table, headings, apiRows, shownRows) {
    if (!apiRows.length) return [];
    const plan = headings.map((heading, c) => {
        const rule = table.columns.find(([re]) => re.test(norm(heading)));
        if (!rule) throw new Error('kolom "' + heading + '" belum terpetakan di ' + table.suffix);
        if (rule[1] === 'no') return { no: shownRows.length && /\.$/.test(shownRows[0][c] || '') ? '.' : '' };
        const sample = shownRows.map((cells, i) => [apiRows[i], cells[c] ?? '']).filter(([row]) => row);
        for (const field of rule[1]) {
            if (!apiRows.some((row) => field in row)) continue;
            for (const [name, fmt] of Object.entries(FORMATS)) {
                if (sample.every(([row, shown]) => fmt(row[field]) === shown)) return { field, format: name };
            }
        }
        for (const field of rule[1]) {
            const pairs = new Map();
            if (!sample.every(([row, shown]) => { const k = String(row[field] ?? ''); if (pairs.has(k)) return pairs.get(k) === shown; pairs.set(k, shown); return true; })) continue;
            return { field, lookup: pairs };
        }
        throw new Error('format kolom "' + heading + '" tidak cocok dengan tampilan Coretax');
    });
    return apiRows.map((row, n) => plan.map((p) => {
        if ('no' in p) return (n + 1) + p.no;
        if (p.lookup) {
            const k = String(row[p.field] ?? '');
            if (!p.lookup.has(k)) throw new Error('nilai ' + p.field + ' "' + k + '" (baris ' + (n + 1) + ') tidak muncul di halaman 1, teksnya belum terbukti');
            return p.lookup.get(k);
        }
        const out = FORMATS[p.format](row[p.field]);
        if (out === null) throw new Error('nilai ' + p.field + ' "' + row[p.field] + '" (baris ' + (n + 1) + ') bukan ' + p.format);
        return out;
    }));
}

/** Every row of grid `suffix` for the SPT open in `page`, via Coretax's own request for it. */
async function fetchRows(page, suffix) {
    if (!gridApi.hasAuthorization(page.context())) throw new Error('header autentikasi Coretax belum tertangkap');
    const ids = /\/corporate-income-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i.exec(page.url());
    const seen = (ids && gridApi.findRequestForRecord(page.context(), suffix, ids[2]))
        || gridApi.dataRequestVariants(page.context()).reverse().find((v) => v.pathname.endsWith(suffix));
    if (!seen) throw new Error('permintaan ' + suffix + ' untuk SPT ini belum terlihat');
    return (await gridApi.fetchAllRowsFromRequest(page, { pathname: suffix, url: seen.url || API + suffix, body: seen.body })).rows;
}

/** For lib/lampiran-capture.js collectTabFromRows: rows of table `index` of `label`, or null when that
 *  table is not an API grid (read from the screen). */
async function displayRows(page, label, headers, index, shown) {
    const headings = shown && shown.leafHeaders && shown.leafHeaders.length ? shown.leafHeaders : headers;
    const table = tableFor(label, headings);
    if (!table) return null;
    return toDisplayRows(table, headings, await fetchRows(page, table.suffix), shown ? shown.rows : []);
}

module.exports = { GRIDS, TABLES, FORMATS, tableFor, toDisplayRows, displayRows };
