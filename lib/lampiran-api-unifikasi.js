/* PPh Unifikasi lampiran rows straight from Coretax's grid API (loadwtr/*), instead of paging the
 * on-screen tables. Each grid's columns follow Coretax's own column definitions for that grid
 * (field, number of decimals, reference list) as read from its web app; codes are shown through
 * Coretax's reference lists (lib/coretax-reference.js). lib/lampiran-capture.js collectTabFromRows
 * only accepts the rows when they agree with the page (count and every cell of page 1), otherwise
 * the table is read page by page.
 *
 * Proven live 2026-10-19 on BIRU BIANTI September 2026 DAFTAR-I BPPU (21 rows): "1." numbering,
 * rupiah without decimals, tarif "10,00", Fasilitas from EBUPOT_TAX_CERTIFICATE, Status as text.
 * BPNR, DAFTAR-II and LAMPIRAN-I had no rows there; they rely on the same definitions and the check. */
const gridApi = require('./returnsheet-grid-api');

const GRIDS = {
    'DAFTAR-I': ['/loadwtr/list-i-bpu-grid', '/loadwtr/list-i-bpnr-grid'],
    'DAFTAR-II': ['/loadwtr/list-ii-sp-grid', '/loadwtr/list-ii-cy-grid'],
    'LAMPIRAN-I': ['/loadwtr/attachment-i-grid']
};
const REFERENCE = { certificate: 'EBUPOT_TAX_CERTIFICATE', payment: 'EBUPOT_PAYMENT_METHOD', spObject: 'EBUPOTSP_TAX_OBJECT', cyObject: 'EBUPOTCY_TAX_OBJECT' };

const present = (v) => v !== null && v !== undefined && v !== '';
const idNumber = require('./id-number'); // no Intl in the exe
const money = (v) => present(v) ? idNumber.money(v) : '';
const rate = (v) => present(v) ? idNumber.fixed(v, 2) : '';
const date = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const text = (v) => present(v) ? String(v).replace(/\s+/g, ' ').trim() : '';

// [heading on screen, API field, format]; format 'ref:<kind>' shows the code through Coretax's list,
// 'ref?:<kind>' does the same but leaves an empty value empty (PaymentMethod is null for non-APBN payers).
const LIST_I = [['NO.', null, 'no'], ['NIK/NPWP', 'TaxIdentificationNumber', 'text'], ['NAMA', 'TaxpayerName', 'text'], ['NOMOR BUKTI POTONG', 'WithholdingSlipsNumber', 'text'],
    ['TANGGAL BUKTI POTONG', 'WithholdingSlipsDate', 'date'], ['JENIS PAJAK', 'TaxArticle', 'text'], ['KODE OBJEK PAJAK', 'TaxObjectCode', 'text'], ['OBJEK PAJAK', 'TaxObject', 'text'],
    ['DASAR PENGENAAN PAJAK (Rp)', 'TaxBase', 'money'], ['TINGKAT (%)', 'TaxRate', 'rate'], [/^PAJAK PENGHASILAN( \(RP\))?$/i, 'IncomeTax', 'money'], ['FASILITAS PERPAJAKAN', 'TaxCertificate', 'ref:certificate'],
    [/^UANG PERSEDIAAN \/ PEMBAYARAN LANGSUNG/i, 'PaymentMethod', 'ref?:payment'], ['NITKU / NOMOR IDENTITAS SUBUNIT ORGANISASI', 'BranchId', 'text'], ['STATUS', 'Status', 'text'], ['KAP-KJS', 'RevenueCode', 'text']];
const LIST_II = (object, certificateHeading) => [['NO.', null, 'no'], ['JENIS PAJAK', 'TaxArticle', 'text'], ['KODE OBJEK PAJAK', 'TaxObjectCode', 'text'], ['OBJEK PAJAK', 'TaxObject', 'ref:' + object],
    ['DASAR PENGENAAN PAJAK (Rp)', 'TaxBase', 'money'], ['TINGKAT (%)', 'TaxRate', 'rate'], ['PAJAK PENGHASILAN (Rp)', 'IncomeTax', 'money'], [certificateHeading, 'TaxCertificate', 'ref:certificate'],
    ['NITKU / NOMOR IDENTITAS SUBUNIT ORGANISASI', 'BranchId', 'text'], ['STATUS', 'Status', 'text'], ['KAP-KJS', 'RevenueCode', 'text']];
const ATTACHMENT = [['NO.', null, 'no'], ['NIK/NPWP PENERIMA PENGHASILAN', 'RecipientIdentificationNumber', 'text'], ['NAMA PENERIMA PENGHASILAN', 'RecipientName', 'text'], ['IDENTITAS AKUN PENERIMA PENGHASILAN', 'RecipientAccountId', 'text'],
    ['NIK/NPWP PEMBERI PENGHASILAN', 'GiverIdentificationNumber', 'text'], ['NAMA PEMBERI PENGHASILAN', 'GiverName', 'text'], ['IDENTITAS AKUN PEMBERI PENGHASILAN', 'GiverAccountId', 'text'], ['KODE OBJEK PAJAK', 'TaxObjectCode', 'text'],
    ['NOMOR DOKUMEN', 'BillingDocumentNumber', 'text'], ['TANGGAL DOKUMEN', 'BillingDocumentDate', 'date'], ['DASAR PENGENAAN PAJAK (Rp)', 'TaxBase', 'money'], ['TINGKAT (%)', 'TaxRate', 'rate'],
    ['PAJAK PENGHASILAN (Rp)', 'IncomeTax', 'money'], ['FASILITAS PERPAJAKAN', 'TaxCertificate', 'ref:certificate'], ['NITKU / NOMOR IDENTITAS SUBUNIT ORGANISASI', 'BranchId', 'text'], ['STATUS', 'Status', 'text'], ['KAP-KJS', 'RevenueCode', 'text']];
const COLUMNS = {
    '/loadwtr/list-i-bpu-grid': LIST_I, '/loadwtr/list-i-bpnr-grid': LIST_I,
    '/loadwtr/list-ii-sp-grid': LIST_II('spObject', 'FASILITAS PERPAJAKAN'), '/loadwtr/list-ii-cy-grid': LIST_II('cyObject', 'FASILITAS PPH'),
    '/loadwtr/attachment-i-grid': ATTACHMENT
};

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
/** Rows as Coretax displays them for grid `endpoint`, whose table shows `headers`. Throws when the
 *  headings differ from Coretax's definition or a code is not in its reference list. */
function toDisplayRows(endpoint, headers, apiRows, lists) {
    if (!apiRows.length) return [];
    const columns = COLUMNS[endpoint];
    if (!columns) throw new Error('grid ' + endpoint + ' belum terpetakan');
    if (headers.length !== columns.length || !columns.every(([h], i) => h instanceof RegExp ? h.test(norm(headers[i])) : norm(headers[i]) === norm(h))) {
        throw new Error('judul kolom ' + endpoint + ' berbeda dari definisi Coretax: ' + JSON.stringify(headers));
    }
    const value = (row, field) => { if (!(field in row)) throw new Error('kolom API ' + field + ' tidak ada'); return row[field]; };
    const ref = (kind, code, optional) => {
        if (!present(code)) { if (optional) return ''; throw new Error('kode ' + kind + ' kosong'); }
        const shown = (lists[kind] || {})[String(code)];
        if (shown === undefined) throw new Error('kode ' + kind + ' "' + code + '" tidak ada di referensi Coretax');
        return shown;
    };
    return apiRows.map((row, n) => columns.map(([, field, fmt]) => {
        if (fmt === 'no') return (n + 1) + '.';
        const v = value(row, field);
        if (fmt.startsWith('ref')) return ref(fmt.split(':')[1], v, fmt.startsWith('ref?'));
        return { text, money, rate, date }[fmt](v);
    }));
}

/** Every row of table `index` of `label`, via the request Coretax itself made for this SPT. */
async function fetchRows(page, label, index) {
    const suffix = (GRIDS[label] || [])[index];
    if (!suffix) throw new Error('tabel ' + (index + 1) + ' lampiran ' + label + ' tidak dikenal');
    if (!gridApi.hasAuthorization(page.context())) throw new Error('header autentikasi Coretax belum tertangkap');
    const ids = /\/withholding-tax-return\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//i.exec(page.url());
    if (!ids) throw new Error('alamat halaman SPT Unifikasi tidak dikenali');
    const seen = gridApi.findRequestForRecord(page.context(), suffix, ids[2]);
    if (!seen) throw new Error('permintaan ' + suffix + ' untuk SPT ini belum terlihat');
    return { suffix, rows: (await gridApi.fetchAllRowsFromRequest(page, { pathname: suffix, url: seen.url, body: seen.body })).rows };
}

/** For lib/lampiran-capture.js collectTabFromRows: the display rows of table `index` of `label`. */
async function displayRows(page, label, headers, index) {
    const { suffix, rows } = await fetchRows(page, label, index);
    return toDisplayRows(suffix, headers, rows, rows.length ? await require('./coretax-reference').referenceLists(page, REFERENCE) : {});
}

module.exports = { GRIDS, COLUMNS, REFERENCE, toDisplayRows, displayRows };
