/* PPN lampiran rows straight from Coretax's grid API, instead of paging the on-screen table 25
 * rows a click. The rows are written out exactly as Coretax's own table shows them, and the
 * caller (lib/lampiran-capture.js collectTabFromRows) only accepts them after checking them
 * against what the page itself displays - row count against "dari N entri" and every cell of the
 * visible first page - so a column read wrongly, or a request for the wrong SPT, can never slip
 * into a PDF; it falls back to the paginator instead. */
const gridApi = require('./returnsheet-grid-api');

const API = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const GRIDS = { 'A-1': '/loadndvat/la1-grid', 'A-2': '/loadndvat/la2-grid', 'B-1': '/loadndvat/lb1-grid', 'B-2': '/loadndvat/lb2-grid', 'B-3': '/loadndvat/lb3-grid', 'C': '/loadndvat/lc-grid' };
// Coretax's own requests carry IsNormalVAT for these four grids only.
const NORMAL_VAT = new Set(['A-1', 'A-2', 'B-3', 'C']);

// The rupiah columns are whole rupiah on screen: Coretax rounds (PIA B-2 has DPP 14.819.820.731,67
// in the API and 14.819.820.731 on screen). Dates are the date part of the ISO value, cut as text so
// no time zone can move it a day. Halves round away from zero, as Angular's number pipe does (a
// retur's -1,5 is -2, not Math.round's -1).
const money = (v) => { if (v === null || v === undefined || v === '') return ''; const n = Number(v); return (Math.sign(n) * Math.round(Math.abs(n))).toLocaleString('id-ID'); };
const date = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const text = (v) => (v === null || v === undefined) ? '' : String(v).replace(/\s+/g, ' ').trim();

// Column order of the faktur lists, each heading with the API field behind it. Derived 2026-10-07 by
// matching every row of NIGG and PIA Juli 2026 (A-2 182 + 29, B-2 266 + 519, B-3 32) cell by cell
// against Coretax's own table. A-1, B-1 and C had no rows to prove a mapping on, so they have none:
// when they hold data they are still read from the page.
const FAKTUR = [
    [/^No\.?$/i, null],
    [/^Nama /i, 'Name', text],
    [/NPWP|Nomor Identitas/i, 'TIN', text],
    [/- Nomor$/i, 'DocumentNumber', text],
    [/- Tanggal$/i, 'DocumentDate', date],
    [/DPP \(Rupiah\)$/i, 'TaxBase', money],
    [/^DPP Nilai Lain/i, 'OtherTaxBase', money],
    [/^PPN \(Rupiah\)$/i, 'VAT', money],
    [/^PPnBM/i, 'STLG', money],
    [/^Kode dan Nomor Seri/i, 'TaxInvoiceCode', text]
];
const COLUMNS = { 'A-2': FAKTUR, 'B-2': FAKTUR, 'B-3': FAKTUR };

/** Rows as Coretax displays them, for a table whose headings are `headers`. Throws when the
 *  headings are not the ones the mapping was proven on, or when a list without a proven mapping
 *  has rows. */
function toDisplayRows(label, headers, apiRows) {
    if (!apiRows.length) return [];
    const columns = COLUMNS[label];
    if (!columns) throw new Error('kolom ' + label + ' belum terpetakan');
    if (headers.length !== columns.length || !columns.every(([re], i) => re.test(headers[i] || ''))) {
        throw new Error('judul kolom ' + label + ' berbeda dari pemetaan: ' + JSON.stringify(headers));
    }
    return apiRows.map((row, n) => columns.map(([, field, fmt]) => field ? fmt(row[field]) : String(n + 1)));
}

/** Every row of one PPN list for the SPT open in `page`. */
async function fetchRows(page, label) {
    const suffix = GRIDS[label];
    if (!suffix) throw new Error('lampiran ' + label + ' tidak dikenal');
    if (!gridApi.hasAuthorization(page.context())) throw new Error('header autentikasi Coretax belum tertangkap');
    const ids = /\/value-added-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//i.exec(page.url());
    if (!ids) throw new Error('alamat halaman SPT PPN tidak dikenali');
    const [, taxpayer, record] = ids;
    // Coretax's own request for this SPT when it was seen; otherwise the same body built from the
    // page address (the shape every captured PPN grid request has).
    const seen = gridApi.findRequestForRecord(page.context(), suffix, record);
    const body = seen ? seen.body : { ReturnSheetRecordId: record, ...(NORMAL_VAT.has(label) ? { IsNormalVAT: true } : {}),
        First: 0, Rows: 500, SortField: '', SortOrder: 1, Filters: [], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: taxpayer };
    const result = await gridApi.fetchAllRowsFromRequest(page, { pathname: suffix, url: seen ? seen.url : API + suffix, body });
    return result.rows;
}

/** For lib/lampiran-capture.js collectTabFromRows: the display rows of `label`. */
async function displayRows(page, label, headers) {
    return toDisplayRows(label, headers, await fetchRows(page, label));
}

module.exports = { displayRows, toDisplayRows, GRIDS };
