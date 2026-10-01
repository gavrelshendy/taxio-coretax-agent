/* Tes offline modul e-Faktur (automation/efaktur.js): registri jenis dokumen, pemetaan kolom Excel,
   dan bentuk body permintaan Coretax. Alur live diuji terpisah di Coretax asli (lihat scripts/inventory-efaktur-live.js).
     node scripts/test-efaktur.js */
const assert = require('assert');
const { DOC_TYPES, TYPE_BY_KEY, __test } = require('../automation/efaktur');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

test('delapan jenis dokumen dengan kunci, menu, dan endpoint daftar unik', () => {
    assert.strictEqual(DOC_TYPES.length, 8);
    for (const field of ['key', 'menu', 'listPath']) assert.strictEqual(new Set(DOC_TYPES.map((t) => t[field])).size, 8, field + ' harus unik');
    assert.deepStrictEqual(DOC_TYPES.map((t) => t.menu).sort(), ['InputReturn', 'InputReturnSD', 'InputSD', 'Input', 'Outgoing', 'OutgoingReturn', 'OutgoingReturnSD', 'OutgoingSD'].sort());
    for (const t of DOC_TYPES) assert.ok(/^\/[a-z]+\/list$/.test(t.listPath), t.key + ': ' + t.listPath);
});

test('jenis Dokumen Lain memakai field Period/Year, lainnya TaxInvoicePeriod/TaxInvoiceYear', () => {
    for (const t of DOC_TYPES) {
        const sd = /^sd/.test(t.key);
        assert.strictEqual(t.periodField, sd ? 'Period' : 'TaxInvoicePeriod', t.key);
        assert.strictEqual(t.yearField, sd ? 'Year' : 'TaxInvoiceYear', t.key);
    }
});

test('kolom: setiap jenis punya header unik, lebar, dan getter yang tidak error pada baris kosong', () => {
    for (const t of DOC_TYPES) {
        const headers = t.columns.map((c) => c[0]);
        assert.strictEqual(new Set(headers).size, headers.length, t.key + ' header ganda');
        for (const c of t.columns) { assert.strictEqual(typeof c[1], 'function'); assert.ok(c[2] > 0); c[1]({}); }
    }
});

test('Pajak Masukan: pihak = penjual, masa dan tanggal terformat, angka numerik', () => {
    const t = TYPE_BY_KEY.input;
    const x = { SellerTIN: '0012345678901234', SellerTaxpayerName: 'PT PENJUAL', TaxInvoiceNumber: '04002600001', TaxInvoiceDate: '2026-07-29T00:00:00', TaxInvoicePeriod: 'TD.00707', TaxInvoiceYear: 2026, PeriodCredit: 'TD.00708', YearCredit: 2026, SellingPrice: 954480, VAT: 104993, ReportedByBuyer: true };
    const row = Object.fromEntries(t.columns.map((c) => [c[0], c[1](x)]));
    assert.strictEqual(row['NPWP Penjual'], '0012345678901234');
    assert.strictEqual(row['Tanggal Faktur Pajak'], '2026-07-29');
    assert.strictEqual(row['Masa Pajak'], 'Juli'); assert.strictEqual(row['Masa Pajak Pengkreditan'], 'Agustus');
    assert.strictEqual(row['Harga Jual/Penggantian/DPP'], 954480); assert.strictEqual(typeof row['PPN'], 'number');
    assert.strictEqual(row['Dilaporkan'], 'YA');
});

test('Pajak Keluaran: pihak = pembeli (nama dibersihkan didahulukan); nilai kosong tetap kosong, bukan 0', () => {
    const t = TYPE_BY_KEY.output;
    const x = { BuyerTIN: '0987', BuyerTaxpayerNameClear: 'PT PEMBELI', BuyerTaxpayerName: 'xxx', SellingPrice: null, TaxInvoicePeriod: 'TD.00712', TaxInvoiceYear: 2025 };
    const row = Object.fromEntries(t.columns.map((c) => [c[0], c[1](x)]));
    assert.strictEqual(row['Nama Pembeli'], 'PT PEMBELI');
    assert.strictEqual(row['Harga Jual/Penggantian/DPP'], null);
    assert.strictEqual(row['Masa Pajak'], 'Desember');
});

test('Dokumen Lain Masukan: DPP dari TaxBase dan masa dari Period', () => {
    const t = TYPE_BY_KEY.sdInput;
    const x = { SellerTIN: '0111', SellerTaxpayerName: 'PT X', DocumentNumber: 'D-1', DocumentDate: '2026-07-28T10:00:00', Period: 'TD.00707', Year: 2026, TaxBase: 1604167, VAT: 192500, Description: '08 - VAT Exempted' };
    const row = Object.fromEntries(t.columns.map((c) => [c[0], c[1](x)]));
    assert.strictEqual(row['DPP'], 1604167); assert.strictEqual(row['Masa Pajak'], 'Juli'); assert.strictEqual(row['Keterangan'], '08 - VAT Exempted');
});

test('body daftar: filter masa equals (angka) + tahun equals sebagai TEKS (angka = 99 detik di Coretax)', () => {
    const body = __test.listBody({ agg: 'AGG' }, TYPE_BY_KEY.input, 'TD.00709', '2026', 400, 200);
    assert.strictEqual(body.TaxpayerAggregateIdentifier, 'AGG'); assert.strictEqual(body.First, 400); assert.strictEqual(body.Rows, 200);
    const [period, year] = body.Filters;
    assert.deepStrictEqual([period.PropertyName, period.Value, period.AsString], ['TaxInvoicePeriod', 'TD.00709', false]);
    assert.deepStrictEqual([year.PropertyName, year.Value, year.AsString], ['TaxInvoiceYear', '2026', true]);
});

test('body ekspor CSV resmi: BP002, menu, perwakilan; hanya Pajak Masukan memuat Corporate:null', () => {
    const ctx = { agg: 'AGG', representative: 'REP' };
    const b = __test.exportBody(ctx, TYPE_BY_KEY.input, 'TD.00709', 2026);
    assert.deepStrictEqual([b.BulkProcessType, b.EInvoiceMenuType, b.PeriodCode, b.PeriodYear, b.TaxpayerAggregateIdentifierRepresentative], ['BP002', 'Input', 'TD.00709', '2026', 'REP']);
    assert.ok('TaxpayerAggregateIdentifierCorporate' in b && b.TaxpayerAggregateIdentifierCorporate === null);
    assert.ok(!('TaxpayerAggregateIdentifierCorporate' in __test.exportBody(ctx, TYPE_BY_KEY.output, 'TD.00709', 2026)));
    const m = __test.monitorBody(ctx, TYPE_BY_KEY.sdOutputReturn);
    assert.deepStrictEqual([m.BulkProcessType, m.EinvoiceMenuType], ['BP002', 'OutgoingReturnSD']);
    assert.strictEqual(TYPE_BY_KEY.sdOutputReturn.monitor, '/SpecialDocumentOutputReturn');
});

test('masaPairs: MMYY -> kode masa Coretax + tahun 4 digit; masa tidak valid dibuang', () => {
    assert.deepStrictEqual(__test.masaPairs(['0926', '1325', '0125']).map((p) => [p.mmYY, p.code, p.year]), [['0926', 'TD.00709', '2026'], ['0125', 'TD.00701', '2025']]);
});

console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
