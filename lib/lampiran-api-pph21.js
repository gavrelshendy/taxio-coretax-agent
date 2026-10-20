/* PPh 21/26 lampiran rows straight from Coretax's grid API (loadarticle2126/*), instead of paging the
 * on-screen tables 10 rows a click. Rows are written out exactly as Coretax's own tables show them;
 * lib/lampiran-capture.js collectTabFromRows only accepts them after checking them against the page
 * (row count against "dari N entri", every cell of the visible first page), so a misread column or
 * an unknown code never reaches a PDF - that table is read page by page instead.
 *
 * Display formats proven live 2026-10-19 (BIRU BIANTI, September 2026: 131 of 131 rows identical to
 * the paginator): rupiah "2.646.648", tarif "1,00", dates "30-09-2026", masa perolehan
 * "2026 January - 2026 September" (English month names, as Coretax shows them). Fasilitas, status
 * and negara are codes in the API; their text comes from Coretax's own reference lists
 * (EBUPOT_TAX_CERTIFICATE, EBUPOT_STATUS, COUNTRY_CODE), fetched live in the page's language. */
const gridApi = require('./returnsheet-grid-api');

const GRIDS = {
    'L-IA': ['/loadarticle2126/l1a-grid'],
    'L-IB': ['/loadarticle2126/l1b-bpa1-grid', '/loadarticle2126/l1b-bpa2-grid'],
    'L-II': ['/loadarticle2126/l2-bpa1-grid', '/loadarticle2126/l2-bpa2-grid'],
    'L-III': ['/loadarticle2126/l3-bp21-grid', '/loadarticle2126/l3-bp26-grid']
};
const REFERENCE = { certificate: 'EBUPOT_TAX_CERTIFICATE', status: 'EBUPOT_STATUS', country: 'COUNTRY_CODE' };
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const present = (v) => v !== null && v !== undefined && v !== '';
// Halves round away from zero, as Angular's number pipe does (lib/id-number.js: no Intl in the exe).
const idNumber = require('./id-number');
const money = (v) => present(v) ? idNumber.money(v) : '';
const rate = (v) => present(v) ? idNumber.fixed(v, 2) : '';
const date = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const text = (v) => present(v) ? String(v).replace(/\s+/g, ' ').trim() : '';
const field = (row, ...names) => { for (const n of names) if (n in row) return row[n]; throw new Error('kolom API ' + names.join('/') + ' tidak ada'); };
// Period codes are MMMMYYYY (01012026).
const masa = (code) => { const m = /^(\d{2})\d{2}(\d{4})$/.exec(String(code || '')); if (!m || !MONTHS_EN[+m[1] - 1]) throw new Error('kode masa "' + code + '" tidak dikenali'); return m[2] + ' ' + MONTHS_EN[+m[1] - 1]; };

// Heading on screen -> its text from an API row. Every heading of a table must have a rule.
const RULES = [
    [/^NO\.?$/i, (row, n) => String(n + 1)],
    [/^NIK\/NPWP$/i, (row) => text(field(row, 'TIN'))],
    [/^NAMA$/i, (row) => text(field(row, 'Name'))],
    [/^JENIS PAJAK$/i, (row) => text(field(row, 'TaxArticle'))],
    [/^NOMOR BUKTI POTONG$/i, (row) => text(row.WithholdingSlipsNumber || field(row, 'WithholdingNumber'))],
    [/^TANGGAL BUKTI PEMOTONGAN/i, (row) => date(row.WithholdingSlipsDate || field(row, 'WithholdingDate'))],
    [/^KODE OBJEK PAJAK$/i, (row) => text(field(row, 'TaxObjectCode'))],
    [/^OBJEK PAJAK$/i, (row) => text(field(row, 'TaxObject'))],
    [/^PENGHASILAN BRUTO/i, (row) => money(field(row, 'GrossIncome'))],
    [/^TARIF/i, (row) => rate(field(row, 'TaxRate'))],
    [/^PAJAK PENGHASILAN/i, (row) => money(field(row, 'IncomeTax'))],
    [/^FASILITAS/i, (row, n, ref) => ref('certificate', field(row, 'TaxCertificate'))],
    [/^MASA PE+ROLEHAN/i, (row) => masa(field(row, 'IncomePeriodStart')) + ' - ' + masa(field(row, 'IncomePeriodEnd'))],
    [/^NEGARA$/i, (row, n, ref) => ref('country', field(row, 'CountryCode'))],
    [/^ID TEMPAT KEGIATAN USAHA$/i, (row) => text(field(row, 'PlaceOfBusinessID'))],
    [/^KAP/i, (row) => text(field(row, 'RevenueCode'))],
    [/^STATUS$/i, (row, n, ref) => ref('status', field(row, 'Status'))]
];

/** Rows as Coretax displays them, for a table whose headings are `headers`. `lists` maps
 *  certificate/status/country to {code: text}. Throws on a heading without a rule or a code that is
 *  not in Coretax's reference list. */
function toDisplayRows(headers, apiRows, lists) {
    if (!apiRows.length) return [];
    const columns = headers.map((h) => { const rule = RULES.find(([re]) => re.test(String(h).trim())); if (!rule) throw new Error('kolom "' + h + '" belum terpetakan'); return rule[1]; });
    const ref = (kind, code) => {
        if (!present(code)) throw new Error('kode ' + kind + ' kosong');
        const value = (lists[kind] || {})[String(code)];
        if (value === undefined) throw new Error('kode ' + kind + ' "' + code + '" tidak ada di referensi Coretax');
        return value;
    };
    return apiRows.map((row, n) => columns.map((fn) => fn(row, n, ref)));
}

const referenceLists = (page) => require('./coretax-reference').referenceLists(page, REFERENCE);

/** Every row of table `index` of `label` for the SPT open in `page`, via the request Coretax itself
 *  made for this SPT (same LanguageId, so texts like OBJEK PAJAK match the screen). */
async function fetchRows(page, label, index) {
    const suffix = (GRIDS[label] || [])[index];
    if (!suffix) throw new Error('tabel ' + (index + 1) + ' lampiran ' + label + ' tidak dikenal');
    if (!gridApi.hasAuthorization(page.context())) throw new Error('header autentikasi Coretax belum tertangkap');
    const ids = /\/article-21-26-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//i.exec(page.url());
    if (!ids) throw new Error('alamat halaman SPT PPh 21 tidak dikenali');
    const seen = gridApi.findRequestForRecord(page.context(), suffix, ids[2]);
    if (!seen) throw new Error('permintaan ' + suffix + ' untuk SPT ini belum terlihat');
    return (await gridApi.fetchAllRowsFromRequest(page, { pathname: suffix, url: seen.url, body: seen.body })).rows;
}

/** For lib/lampiran-capture.js collectTabFromRows: the display rows of table `index` of `label`. */
async function displayRows(page, label, headers, index) {
    const rows = await fetchRows(page, label, index);
    return toDisplayRows(headers, rows, rows.length ? await referenceLists(page) : {});
}

module.exports = { GRIDS, RULES, toDisplayRows, displayRows, referenceLists };
