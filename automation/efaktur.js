/* Coretax Agent - unduh dokumen e-Faktur (delapan jenis) dari portal e-Invoice.

   Endpoint dan bentuk body di bawah diverifikasi live 2026-10-01 pada entitas PNG:
   - daftar:   POST /einvoiceportal/api/<controller>/list  (kedelapan jenis dibaca; ID wajib pajak = klaim
               "taxpayer_id" pada token, tidak perlu diturunkan dari data faktur)
   - ekspor CSV resmi (zip): POST /EInvoiceExport/export (BulkProcessType BP002) -> pantau
               <controller>/bulk-process-monitoring -> POST /EInvoiceExport/download {RecordId} (biner)
   Pola eksekusi sama dengan automation/pajakmasukan.js: fetch same-origin DI DALAM halaman, token dibaca
   segar dari sessionStorage tiap panggilan. page.evaluate() selalu memakai STRING (alasan sama: pkg). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { log } = require('../lib/log');
const pm = require('./pajakmasukan');

const API = '/einvoiceportal/api';
const TOKEN_KEY = 'cats-portal-angular-clientuser:https://coretaxdjp.pajak.go.id/identityproviderportal:cats-portal-angular-client';
const BULK_CSV = 'BP002';

const money = (v) => (v == null || v === '' ? null : Number(v));
const yn = (v) => (v ? 'YA' : 'TIDAK');
const date = (v) => (v ? String(v).slice(0, 10) : '');
const periodName = (code) => pm.MONTH_ID[pm.PERIOD_MONTH[code]] || code || '';
const party = (x, side) => (side === 'penjual'
    ? [x.SellerTIN || '', x.SellerTaxpayerName || x.SellerTaxpayerNameClear || '']
    : [x.BuyerTIN || '', x.BuyerTaxpayerNameClear || x.BuyerTaxpayerName || '']);

/** Kolom per kelompok. Tiap kolom: [header, ambil(x), lebar, angka?]. */
function invoiceColumns(side, input) {
    const cols = [
        [side === 'penjual' ? 'NPWP Penjual' : 'NPWP Pembeli / Identitas lainnya', (x) => party(x, side)[0], 20],
        [side === 'penjual' ? 'Nama Penjual' : 'Nama Pembeli', (x) => party(x, side)[1], 30]
    ];
    if (!input) cols.push(['Kode Transaksi', (x) => x.TaxInvoiceCode || '', 12]);
    cols.push(
        ['Nomor Faktur Pajak', (x) => x.TaxInvoiceNumber || '', 22],
        ['Tanggal Faktur Pajak', (x) => date(x.TaxInvoiceDate), 14],
        ['Masa Pajak', (x) => periodName(x.TaxInvoicePeriod), 14],
        ['Tahun', (x) => x.TaxInvoiceYear || '', 9]
    );
    if (input) cols.push(['Masa Pajak Pengkreditan', (x) => (x.PeriodCredit ? periodName(x.PeriodCredit) : ''), 18], ['Tahun Pajak Pengkreditan', (x) => x.YearCredit || '', 10]);
    cols.push(
        ['Status Faktur', (x) => x.TaxInvoiceStatus || '', 16],
        ['Status e-Sign', (x) => x.ESignStatus || '', 14],
        ['Harga Jual/Penggantian/DPP', (x) => money(x.SellingPrice), 18, true],
        ['DPP Nilai Lain/DPP', (x) => money(x.OtherTaxBase), 18, true],
        ['PPN', (x) => money(x.VAT), 15, true],
        ['PPnBM', (x) => money(x.STLG), 12, true],
        ['Penandatangan', (x) => x.Signer || '', 24],
        ['Referensi', (x) => x.Reference || '', 20],
        ['Metode Input', (x) => x.InputMethod || '', 14],
        ['Valid', (x) => (x.Valid == null ? '' : yn(x.Valid)), 8],
        [input ? 'Dilaporkan' : 'Dilaporkan oleh Penjual', (x) => yn(input ? x.ReportedByBuyer : x.ReportedBySeller), 12]
    );
    if (!input) cols.push(['Dilaporkan oleh Pemungut PPN', (x) => yn(x.ReportedByVATCollector), 12]);
    cols.push(['Dibuat', (x) => date(x.CreationDate), 12], ['Diperbarui', (x) => date(x.LastUpdatedDate), 12]);
    return cols;
}
function returnColumns(side) {
    return [
        [side === 'penjual' ? 'NPWP Penjual' : 'NPWP Pembeli', (x) => party(x, side)[0], 20],
        [side === 'penjual' ? 'Nama Penjual' : 'Nama Pembeli', (x) => party(x, side)[1], 30],
        ['Nomor Faktur', (x) => x.TaxInvoiceNumber || '', 22], ['Tanggal Faktur', (x) => date(x.TaxInvoiceDate), 14],
        ['Nomor Retur', (x) => x.ReturnNumber || '', 20], ['Tanggal Retur', (x) => date(x.ReturnDate), 14],
        ['Masa Pajak', (x) => periodName(x.TaxInvoicePeriod), 14], ['Tahun', (x) => x.TaxInvoiceYear || '', 9],
        ['Status', (x) => x.TaxInvoiceStatus || '', 16], ['Status e-Sign', (x) => x.ESignStatus || '', 14],
        ['Dikreditkan', (x) => (x.Creditable == null ? '' : yn(x.Creditable)), 12],
        ['Harga Jual/Penggantian/DPP', (x) => money(x.SellingPrice), 18, true], ['DPP Nilai Lain/DPP', (x) => money(x.OtherTaxBase), 18, true],
        ['PPN', (x) => money(x.VAT), 15, true], ['PPnBM', (x) => money(x.STLG), 12, true],
        ['Perekam', (x) => x.Recorder || '', 24], ['Dilaporkan', (x) => yn(x.ReportedByBuyer || x.ReportedBySeller), 12],
        ['Dibuat', (x) => date(x.CreationDate), 12], ['Diperbarui', (x) => date(x.LastUpdatedDate), 12]
    ];
}
function docColumns(side, input) {
    const cols = [
        [side === 'penjual' ? 'NPWP Penjual' : 'NPWP Pembeli', (x) => party(x, side)[0], 20],
        [side === 'penjual' ? 'Nama Penjual' : 'Nama Pembeli', (x) => party(x, side)[1], 30],
        ['Nomor Dokumen', (x) => x.DocumentNumber || '', 22], ['Tanggal Dokumen', (x) => date(x.DocumentDate), 14],
        ['Jenis Transaksi', (x) => x.TransactionType || x.TransactionCode || '', 18],
        ['Masa Pajak', (x) => periodName(x.Period), 14], ['Tahun', (x) => x.Year || '', 9]
    ];
    if (input) cols.push(['Masa Pajak Pengkreditan', (x) => (x.PeriodCredit ? periodName(x.PeriodCredit) : ''), 18], ['Tahun Pajak Pengkreditan', (x) => x.YearCredit || '', 10]);
    cols.push(
        ['Status', (x) => x.TaxInvoiceStatus || '', 16], ['Status e-Sign', (x) => x.ESignStatus || '', 14],
        ['DPP', (x) => money(x.TaxBase), 18, true], ['DPP Nilai Lain', (x) => money(x.OtherTaxBase), 18, true],
        ['PPN', (x) => money(x.VAT), 15, true], ['PPnBM', (x) => money(x.STLG), 12, true],
        ['Keterangan', (x) => x.Description || '', 30], ['Perekam', (x) => x.Recorder || '', 24],
        ['Valid', (x) => (x.Valid == null ? '' : yn(x.Valid)), 8], ['Dilaporkan', (x) => yn(x.ReportedByBuyer || x.ReportedBySeller), 12],
        ['Dibuat Oleh', (x) => x.CreatedBy || '', 24], ['Dibuat', (x) => date(x.CreationDate), 12], ['Diperbarui', (x) => date(x.LastUpdatedDate), 12]
    );
    return cols;
}
function docReturnColumns(side) {
    return [
        [side === 'penjual' ? 'NPWP Penjual' : 'NPWP Pembeli', (x) => party(x, side)[0], 20],
        [side === 'penjual' ? 'Nama Penjual' : 'Nama Pembeli', (x) => party(x, side)[1], 30],
        ['Nomor Dokumen', (x) => x.DocumentNumber || '', 22], ['Nomor Retur', (x) => x.ReturnNumber || '', 20],
        ['Tanggal Dokumen', (x) => date(x.DocumentDate), 14], ['Tanggal Retur', (x) => date(x.ReturnDate), 14],
        ['Masa Pajak', (x) => periodName(x.Period), 14], ['Tahun', (x) => x.Year || '', 9],
        ['Status', (x) => x.TaxInvoiceStatus || '', 16], ['Dikreditkan', (x) => (x.Creditable == null ? '' : yn(x.Creditable)), 12],
        ['DPP', (x) => money(x.TaxBase), 18, true], ['PPN', (x) => money(x.VAT), 15, true], ['PPnBM', (x) => money(x.STLG), 12, true],
        ['Keterangan', (x) => x.Description || '', 30], ['Perekam', (x) => x.Recorder || '', 24],
        ['Dilaporkan', (x) => yn(x.ReportedByBuyer || x.ReportedBySeller), 12],
        ['Dibuat', (x) => date(x.CreationDate), 12], ['Diperbarui', (x) => date(x.LastUpdatedDate), 12]
    ];
}

/** Delapan jenis dokumen e-Faktur. `menu` = EInvoiceMenuType Coretax; `monitor` = controller pemantau ekspor
 *  (Coretax sendiri memakai /OutputInvoice untuk jenis yang tidak punya controller khusus). */
const DOC_TYPES = [
    { key: 'input', label: 'Pajak Masukan', group: 'Faktur Pajak', menu: 'Input', listPath: '/inputinvoice/list', periodField: 'TaxInvoicePeriod', yearField: 'TaxInvoiceYear', monitor: '/InputInvoice', columns: invoiceColumns('penjual', true) },
    { key: 'output', label: 'Pajak Keluaran', group: 'Faktur Pajak', menu: 'Outgoing', listPath: '/outputinvoice/list', periodField: 'TaxInvoicePeriod', yearField: 'TaxInvoiceYear', monitor: '/OutputInvoice', columns: invoiceColumns('pembeli', false) },
    { key: 'inputReturn', label: 'Retur Pajak Masukan', group: 'Retur', menu: 'InputReturn', listPath: '/inputreturn/list', periodField: 'TaxInvoicePeriod', yearField: 'TaxInvoiceYear', monitor: '/InputReturn', columns: returnColumns('penjual') },
    { key: 'outputReturn', label: 'Retur Pajak Keluaran', group: 'Retur', menu: 'OutgoingReturn', listPath: '/outputreturn/list', periodField: 'TaxInvoicePeriod', yearField: 'TaxInvoiceYear', monitor: '/OutputReturn', columns: returnColumns('pembeli') },
    { key: 'sdInput', label: 'Dokumen Lain Masukan', group: 'Dokumen Lain', menu: 'InputSD', listPath: '/specialdocumentinputinvoice/list', periodField: 'Period', yearField: 'Year', monitor: '/OutputInvoice', columns: docColumns('penjual', true) },
    { key: 'sdOutput', label: 'Dokumen Lain Keluaran', group: 'Dokumen Lain', menu: 'OutgoingSD', listPath: '/specialdocumentoutputinvoice/list', periodField: 'Period', yearField: 'Year', monitor: '/OutputInvoice', columns: docColumns('pembeli', false) },
    { key: 'sdInputReturn', label: 'Retur Dokumen Lain Masukan', group: 'Retur Dokumen Lain', menu: 'InputReturnSD', listPath: '/specialdocumentinputreturn/list', periodField: 'Period', yearField: 'Year', monitor: '/OutputInvoice', columns: docReturnColumns('penjual') },
    { key: 'sdOutputReturn', label: 'Retur Dokumen Lain Keluaran', group: 'Retur Dokumen Lain', menu: 'OutgoingReturnSD', listPath: '/specialdocumentoutputreturn/list', periodField: 'Period', yearField: 'Year', monitor: '/SpecialDocumentOutputReturn', columns: docReturnColumns('pembeli') }
];
const TYPE_BY_KEY = Object.fromEntries(DOC_TYPES.map((t) => [t.key, t]));

/* ------------------------------------------------------------------ *
 *  Jembatan ke API (biner)
 * ------------------------------------------------------------------ */

function buildBinaryFetchScript(apiPath, bodyObj, timeoutMs) {
    return '(async function(){' +
        'var raw=sessionStorage.getItem(' + JSON.stringify(TOKEN_KEY) + ');' +
        'if(!raw) return {__err:"SESSION_HILANG"};var o=JSON.parse(raw);' +
        'if(!o.access_token) return {__err:"TOKEN_KOSONG"};' +
        'if(o.expires_at && (o.expires_at - Date.now()/1000) < 5) return {__err:"TOKEN_KEDALUWARSA"};' +
        'var ctl=new AbortController();var timer=setTimeout(function(){ctl.abort();},' + (timeoutMs || 120000) + ');' +
        'try{var r=await fetch(' + JSON.stringify(API + apiPath) + ',{method:"POST",signal:ctl.signal,' +
        'headers:{"content-type":"application/json",authorization:"Bearer "+o.access_token},body:JSON.stringify(' + JSON.stringify(bodyObj) + ')});' +
        'var buf=await r.arrayBuffer();clearTimeout(timer);var bytes=new Uint8Array(buf),bin="",i,CH=32768;' +
        'for(i=0;i<bytes.length;i+=CH)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH));' +
        'return {__http:r.status,__type:r.headers.get("content-type")||"",__size:bytes.length,__b64:btoa(bin)};' +
        '}catch(e){clearTimeout(timer);return {__err:e.name+": "+e.message};}})()';
}

/** Klaim token: ID wajib pajak, perwakilan (saat impersonate), NPWP. Dibaca segar, tidak di-cache. */
const CLAIMS_SCRIPT = '(function(){var raw=sessionStorage.getItem(' + JSON.stringify(TOKEN_KEY) + ');if(!raw)return {err:"SESSION_HILANG"};' +
    'var o=JSON.parse(raw),c=null;try{c=JSON.parse(atob(o.access_token.split(".")[1]));}catch(e){}' +
    'if(!c||!c.taxpayer_id)return {err:"TAXPAYER_ID_HILANG"};' +
    'return {agg:c.taxpayer_id,representative:(String(c.Impersonating).toLowerCase()==="true"&&c.RepresentativeId)?c.RepresentativeId:null,npwp:c.sub||null,' +
    'expiresInSec:o.expires_at?Math.round(o.expires_at-Date.now()/1000):null};})()';

async function getContext(page) {
    await pm.ensureOnInputTaxPage(page);
    const c = await page.evaluate(CLAIMS_SCRIPT);
    if (!c || c.err) throw new Error('Sesi Coretax tidak terbaca (' + ((c && c.err) || 'kosong') + ') - pastikan sudah login.');
    return c;
}

/* ------------------------------------------------------------------ *
 *  Daftar dokumen (Excel)
 * ------------------------------------------------------------------ */

function listBody(ctx, type, code, year, first, rows) {
    // Filter masa DIKIRIM ke server (diverifikasi live: membatasi hasil dan cepat). Tahun harus AsString:true -
    // sebagai angka (AsString:false) satu panggilan bisa 99 detik. Hasil tetap disaring ulang di sisi kita.
    return { TaxpayerAggregateIdentifier: ctx.agg, First: first, Rows: rows, SortField: '', SortOrder: 1, LanguageId: 'id-ID', Filters: [
        { PropertyName: type.periodField, Value: code, MatchMode: 'equals', CaseSensitive: true, AsString: false },
        { PropertyName: type.yearField, Value: String(year), MatchMode: 'equals', CaseSensitive: true, AsString: true }
    ] };
}

/** Ambil semua dokumen satu jenis pada SATU masa lewat paging. TotalRecords bukan jumlah (mengikuti Rows+1):
 *  paging berhenti saat halaman kurang dari yang diminta. */
async function listForMasa(page, ctx, type, code, year, emit) {
    const PAGE = 200, out = [], seen = new Set();
    for (let first = 0; first < 200000; first += PAGE) {
        const res = await pm.apiPost(page, type.listPath, listBody(ctx, type, code, year, first, PAGE), 90000);
        const j = res && res.__json;
        if (!j || !j.IsSuccessful) throw new Error('Gagal mengambil daftar ' + type.label + ': ' + ((j && j.Message) || (res && res.__http)));
        const data = (j.Payload && j.Payload.Data) || [];
        for (const x of data) { const id = x.RecordId || JSON.stringify(x).slice(0, 80); if (!seen.has(id)) { seen.add(id); out.push(x); } }
        if (emit && out.length && out.length % 600 === 0) emit(type.label + ' ' + pm.periodLabel(code, year) + ': terambil ' + out.length + '...');
        if (data.length < PAGE) break;
    }
    return out.filter((x) => x[type.periodField] === code && String(x[type.yearField]) === String(year));
}

function masaPairs(masaList) {
    const out = [];
    for (const mmYY of masaList) {
        const code = pm.PERIOD_CODE[parseInt(mmYY.slice(0, 2), 10)];
        if (code) out.push({ mmYY, code, year: '20' + mmYY.slice(2) });
    }
    return out;
}

function styleSheet(ws, type) {
    ws.columns = type.columns.map((c) => ({ header: c[0], width: c[2] }));
    const head = ws.getRow(1);
    head.font = { bold: true }; head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; head.height = 32;
    head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDD44' } }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: type.columns.length } };
    type.columns.forEach((c, i) => { if (c[3]) ws.getColumn(i + 1).numFmt = '#,##0'; });
}

async function writeExcel(file, entityName, masaLabel, selected) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Taxio Pilot';
    const sum = wb.addWorksheet('Ringkasan');
    sum.addRow(['e-Faktur — ' + (entityName || '')]);
    sum.addRow(['Masa: ' + masaLabel]);
    sum.addRow([]);
    sum.addRow(['Jenis dokumen', 'Jumlah']);
    sum.getRow(1).font = { bold: true, size: 14 };
    sum.getRow(4).font = { bold: true };
    sum.columns = [{ width: 34 }, { width: 12 }];
    for (const { type, rows } of selected) {
        const ws = wb.addWorksheet(type.label.slice(0, 31));
        styleSheet(ws, type);
        rows.forEach((x) => ws.addRow(type.columns.map((c) => c[1](x))));
        sum.addRow([type.label, rows.length]);
    }
    sum.addRow(['Total', selected.reduce((a, s) => a + s.rows.length, 0)]).font = { bold: true };
    await wb.xlsx.writeFile(file);
}

/* ------------------------------------------------------------------ *
 *  Ekspor CSV resmi Coretax (zip)
 * ------------------------------------------------------------------ */

function exportBody(ctx, type, code, year) {
    const body = { TaxpayerAggregateIdentifier: ctx.agg, TaxpayerAggregateIdentifierRepresentative: ctx.representative, PeriodCode: code, PeriodYear: String(year), BulkProcessType: BULK_CSV, EInvoiceMenuType: type.menu };
    if (type.key === 'input') body.TaxpayerAggregateIdentifierCorporate = null;
    return body;
}
function monitorBody(ctx, type) {
    return { TaxpayerAggregateIdentifier: ctx.agg, BulkProcessType: BULK_CSV, EinvoiceMenuType: type.menu, First: 0, Rows: 25, SortField: '', SortOrder: 1, LanguageId: 'id-ID', Filters: [] };
}
async function monitorRows(page, ctx, type) {
    const res = await pm.apiPost(page, type.monitor + '/bulk-process-monitoring', monitorBody(ctx, type), 30000);
    const j = res && res.__json;
    if (!j || !j.IsSuccessful) throw new Error('Gagal membaca pemantauan ekspor ' + type.label + ': ' + ((j && j.Message) || (res && res.__http)));
    return (j.Payload && j.Payload.Data) || [];
}

async function downloadRecord(page, recordId, destFile) {
    const dl = await page.evaluate(buildBinaryFetchScript('/EInvoiceExport/download', { RecordId: recordId }, 180000));
    if (!dl || dl.__err) throw new Error('Unduhan ekspor gagal: ' + (dl && dl.__err));
    if (dl.__http !== 200 || !dl.__size) throw new Error('Unduhan ekspor gagal (HTTP ' + dl.__http + ', ' + dl.__size + ' byte).');
    fs.writeFileSync(destFile, Buffer.from(dl.__b64, 'base64'));
    return { file: destFile, bytes: dl.__size };
}

/** Ekspor CSV resmi untuk BANYAK (jenis x masa) sekaligus: semua permintaan dikirim dulu (Coretax membuat file di
 *  servernya secara paralel dan lambat - satu file bisa 3+ menit), lalu dipantau bersama, lalu diunduh. Waktu total
 *  mengikuti pekerjaan TERLAMA, bukan jumlah semuanya.
 *  jobs: [{ type, code, year, mmYY, dest }]. Mengembalikan [{ job, file?, bytes?, error? }]. */
async function exportCsvBatch(page, ctx, jobs, emit, opts) {
    opts = opts || {};
    const results = jobs.map((job) => ({ job }));
    const before = new Map();
    for (const type of new Set(jobs.map((j) => j.type))) before.set(type, new Set((await monitorRows(page, ctx, type)).map((r) => r.RecordId)));
    for (const r of results) {
        try {
            const res = await pm.apiPost(page, '/EInvoiceExport/export', exportBody(ctx, r.job.type, r.job.code, r.job.year), 60000);
            const j = res && res.__json;
            if (!j || !j.IsSuccessful) throw new Error('Permintaan ekspor ditolak Coretax: ' + ((j && j.Message) || (res && res.__http)));
            r.pending = true;
        } catch (e) { r.error = e.message; }
    }
    const started = results.filter((r) => r.pending).length;
    if (started) emit('CSV resmi: ' + started + ' permintaan dikirim ke Coretax, menunggu file dibuat...');
    const deadline = Date.now() + (opts.maxWaitMs || 10 * 60 * 1000);
    const claimed = new Set();
    let lastNote = Date.now();
    while (results.some((r) => r.pending) && Date.now() < deadline) {
        await page.waitForTimeout(opts.pollMs || 4000);
        for (const type of new Set(results.filter((r) => r.pending).map((r) => r.job.type))) {
            const rows = await monitorRows(page, ctx, type);
            for (const r of results.filter((x) => x.pending && x.job.type === type)) {
                const rec = rows
                    .filter((x) => !before.get(type).has(x.RecordId) && !claimed.has(x.RecordId) && x.PeriodCode === r.job.code && String(x.PeriodYear) === String(r.job.year))
                    .sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)))[0];
                if (!rec) continue;
                if (/^done$/i.test(String(rec.Status))) { claimed.add(rec.RecordId); r.record = rec; r.pending = false; }
                else if (/fail|error|gagal|reject/i.test(String(rec.Status))) { claimed.add(rec.RecordId); r.error = 'Ekspor gagal di Coretax (' + rec.Status + '): ' + (rec.ErrorMessage || '-'); r.pending = false; }
            }
        }
        if (Date.now() - lastNote > 30000) { lastNote = Date.now(); emit('CSV resmi: masih menunggu ' + results.filter((r) => r.pending).length + ' file dari Coretax...'); }
    }
    for (const r of results) {
        if (r.pending) { r.error = 'Belum selesai setelah ' + Math.round((opts.maxWaitMs || 600000) / 1000) + ' detik - cek menu Monitoring di Coretax.'; r.pending = false; continue; }
        if (r.error || !r.record) continue;
        try { Object.assign(r, await downloadRecord(page, r.record.RecordId, r.job.dest)); }
        catch (e) { r.error = e.message; }
    }
    return results;
}

/* ------------------------------------------------------------------ *
 *  Alur utama
 * ------------------------------------------------------------------ */

/** @param {object} o { page, types:[key], masaList:["MMYY"], excel:boolean, csv:boolean, saveRoot, entityFolder, entityName, emit } */
async function runDownloadEfaktur(o) {
    const emit = o.emit || ((m) => log(m));
    const page = o.page;
    const types = (o.types || []).map((k) => TYPE_BY_KEY[k]).filter(Boolean);
    if (!types.length) throw new Error('Pilih minimal satu jenis dokumen.');
    if (!o.masaList || !o.masaList.length) throw new Error('Masa wajib diisi.');
    const wantExcel = o.excel !== false, wantCsv = !!o.csv;
    if (!wantExcel && !wantCsv) throw new Error('Pilih minimal satu format (Excel atau CSV resmi).');

    const ctx = await getContext(page);
    emit('e-Faktur: ' + types.length + ' jenis dokumen, ' + o.masaList.length + ' masa. Sesi tersisa ~' + ctx.expiresInSec + ' detik.');

    const saveRoot = o.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');
    const dir = path.join(saveRoot, o.entityFolder || 'eFaktur', 'eFaktur');
    fs.mkdirSync(dir, { recursive: true });
    const masaLabel = o.masaList.length === 1 ? o.masaList[0] : o.masaList[0] + '-' + o.masaList[o.masaList.length - 1];
    const stamp = Date.now();
    const result = { dir, perType: [], files: [], failures: [] };
    const pairs = masaPairs(o.masaList);

    if (wantExcel) {
        const selected = [];
        for (const type of types) {
            const rows = [];
            let failed = false;
            for (const pr of pairs) {
                await require('../lib/runcontrol').checkpoint();
                try {
                    const got = await listForMasa(page, ctx, type, pr.code, pr.year, emit);
                    if (got.length) emit(type.label + ' ' + pm.periodLabel(pr.code, pr.year) + ': ' + got.length + ' dokumen.');
                    rows.push(...got);
                } catch (e) {
                    if (e.isStop) throw e;
                    emit('GAGAL ' + type.label + ' ' + pr.mmYY + ': ' + e.message);
                    result.failures.push({ key: type.key, label: type.label, masa: pr.mmYY, error: e.message });
                    failed = true;
                }
            }
            emit(type.label + ': total ' + rows.length + ' dokumen' + (failed ? ' (ADA MASA GAGAL - lihat log)' : '') + '.');
            selected.push({ type, rows });
            result.perType.push({ key: type.key, label: type.label, count: rows.length, incomplete: failed });
        }
        if (selected.length) {
            const file = path.join(dir, 'e-Faktur - ' + masaLabel + ' - ' + stamp + '.xlsx');
            await writeExcel(file, o.entityName, masaLabel, selected);
            result.files.push(file);
            emit('Excel tersimpan: ' + file);
        }
    }

    if (wantCsv) {
        const jobs = [];
        for (const type of types) for (const pr of pairs) jobs.push({ type, code: pr.code, year: pr.year, mmYY: pr.mmYY, dest: path.join(dir, 'CSV ' + type.label + ' - ' + pr.mmYY + ' - ' + stamp + '.zip') });
        await require('../lib/runcontrol').checkpoint();
        for (const r of await exportCsvBatch(page, ctx, jobs, emit)) {
            if (r.error) {
                emit('GAGAL CSV ' + r.job.type.label + ' ' + r.job.mmYY + ': ' + r.error);
                result.failures.push({ key: r.job.type.key, label: r.job.type.label, masa: r.job.mmYY, error: r.error });
            } else {
                result.files.push(r.file);
                emit('CSV tersimpan: ' + r.file + ' (' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB)');
            }
        }
    }
    emit('Selesai. ' + result.files.length + ' file, ' + result.failures.length + ' kegagalan.');
    return result;
}

module.exports = { runDownloadEfaktur, getContext, listForMasa, exportCsvBatch, DOC_TYPES, TYPE_BY_KEY, __test: { exportBody, monitorBody, masaPairs, listBody } };
