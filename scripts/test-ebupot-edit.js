// Tes lib/ebupot-edit.js dengan sesi Coretax tiruan (tanpa jaringan, data rekaan).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ed = require('../lib/ebupot-edit');

function fakeCoretax() {
    const slips = [
        { RecordId: 'r1', WithholdingslipsAggregateIdentifier: 'a1', WithholdingSlipsNumber: 'N-1', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110001', Name: 'ANDI', Position: 'Staff', TaxCertificateCode: '9', TaxObjectCode: '21-100-01', TaxArticle: 'Pasal 21', TaxObjectReferenceCode: 1, GrossIncome: 7572265, TaxRate: 1.5, IncomeTaxWithheld: 113584, RevenueCode: '411121-100', BranchId: 'B', TaxExemptionStatus: 'TK0', IsReportedToTaxReturn: false },
        { RecordId: 'r2', WithholdingslipsAggregateIdentifier: 'a2', WithholdingSlipsNumber: 'N-2', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110002', Name: 'BUDI', Position: 'Staff', TaxCertificateCode: '9', TaxObjectCode: '21-100-01', TaxArticle: 'Pasal 21', TaxObjectReferenceCode: 1, GrossIncome: 5487245, TaxRate: 0.25, IncomeTaxWithheld: 13718, RevenueCode: '411121-100', BranchId: 'B', TaxExemptionStatus: 'TK0', IsReportedToTaxReturn: true },
        { RecordId: 'r3', WithholdingslipsAggregateIdentifier: 'a3', WithholdingSlipsNumber: 'N-3', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110003', Name: 'CITRA', Position: 'Staff', TaxCertificateCode: '9', TaxObjectCode: '21-100-01', TaxArticle: 'Pasal 21', TaxObjectReferenceCode: 1, GrossIncome: 9000000, TaxRate: 2, IncomeTaxWithheld: 180000, RevenueCode: '411121-100', BranchId: 'B', TaxExemptionStatus: 'K1', IsReportedToTaxReturn: false },
    ];
    const sent = [], cancelled = [];
    const s = {
        list: async (endpoint, code) => endpoint === 'getebupotmpissued' ? slips.filter((x) => x.TaxPeriodCode === code && !cancelled.includes(x.RecordId)).map((x) => ({ ...x })) : [],
        find: async (endpoint, code, number) => slips.find((x) => x.WithholdingSlipsNumber === number) || null,
        lookup: async () => ({ payload: { TaxpayerType: 'INDIVIDUAL' } }),
        post: async (url, body) => {
            if (url.endsWith('/viewebupotmp')) { const x = slips.find((y) => y.RecordId === body.RecordId); return { status: 200, json: { Payload: { Result: { ...x } } } }; }
            if (url.endsWith('/amendebupotmp')) {
                sent.push(body);
                const x = slips.find((y) => y.RecordId === body.RecordId);
                Object.assign(x, { WithholdingSlipsStatus: 'AMENDMENT', TaxExemptionStatus: body.TaxExemptionStatus, GrossIncome: body.GrossIncome, TaxRate: body.TaxRate, IncomeTaxWithheld: body.IncomeTaxWithheld, Position: body.Position });
                return { status: 200, json: { IsSuccessful: true } };
            }
            if (url.endsWith('/cancelebupotmp')) { cancelled.push(body.EBUPOTIdentifiers[0].RecordIdentifier); return { status: 200, json: { IsSuccessful: true } }; }
            return { status: 404, json: null };
        },
        close: async () => {}
    };
    return { page: { __session: s }, slips, sent, cancelled };
}

(async () => {
    assert.deepEqual(ed.periodOf('1026'), { code: '10102026', month: 10, year: '2026', label: '10/2026' });
    assert.equal(ed.taxOf(7572265, 1.5), 113584, 'PPh dibulatkan seperti Coretax');
    assert.equal(ed.normPtkp('k/1'), 'K1');

    // Cari: saring NIK, detail PTKP terbaca.
    let c = fakeCoretax();
    const f = await ed.find(c.page, { period: '1026', nik: '1111111111110001' });
    assert.equal(f.total, 1); assert.equal(f.slips[0].ptkp, 'TK0'); assert.equal(f.slips[0].tax, 113584);

    // Pratinjau per nomor: PTKP satu kategori TER (TK0 -> TK1) tanpa tarif = OK; TK0 -> K1 (A -> B) tanpa tarif = dilewati.
    let p = await ed.previewAmend(c.page, { changes: [{ number: 'N-1', period: '1026', ptkp: 'TK1' }, { number: 'N-2', period: '1026', ptkp: 'K1' }, { number: 'N-3', period: '1026', ptkp: 'K1' }, { number: 'N-9', period: '1026', ptkp: 'K0' }] });
    assert.equal(p.items.length, 1); assert.deepEqual(p.items[0].changed, ['ptkp']);
    assert.ok(p.notes.some((n) => /N-2.*kategori TER A -> B/.test(n)), 'lintas kategori tanpa tarif dilewati');
    assert.ok(p.notes.some((n) => /N-3 sudah sesuai/.test(n)));
    assert.ok(p.notes.some((n) => /N-9 tidak ada/.test(n)));
    assert.ok(p.token);

    // Dengan tarif: PPh dihitung ulang; totalnya ikut; masa yang sudah dilaporkan disebut.
    p = await ed.previewAmend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }] });
    assert.equal(p.items[0].after.tax, Math.round(5487245 * 0.005)); assert.deepEqual(p.periodsReported, ['10/2026']);

    // Kirim: kode salah ditolak, tidak ada yang terkirim.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ebupot-edit-'));
    await assert.rejects(ed.amend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }], token: 'salah', outDir: out }), /berubah sejak pratinjau/);
    assert.equal(c.sent.length, 0);
    // Kode benar: isian lain identik dengan cadangan, hanya PTKP / tarif / PPh berubah; diperiksa sesudahnya.
    const r = await ed.amend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }], token: p.token, outDir: out });
    assert.equal(r.results[0].status, 'DIBETULKAN');
    const b = c.sent[0];
    assert.equal(b.TaxExemptionStatus, 'K1'); assert.equal(b.TaxRate, 0.5); assert.equal(b.IncomeTaxWithheld, 27436); assert.equal(b.GrossIncome, 5487245);
    assert.equal(b.TaxIdentificationNumber, '1111111111110002'); assert.equal(b.Name, 'BUDI'); assert.equal(b.TaxObjectCode, '21-100-01'); assert.equal(b.WithholdingslipsAggregateIdentifier, 'a2');
    assert.ok(fs.existsSync(path.join(out, 'cadangan-N-2.json')));
    // Pratinjau lama tidak bisa dipakai lagi (Coretax sudah berubah).
    await assert.rejects(ed.amend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }], token: p.token, outDir: out }), /Kode konfirmasi|berubah/);

    // File revisi XML: dicocokkan per NIK + kode objek; tarif + PTKP dari file.
    c = fakeCoretax();
    const xml = path.join(out, 'revisi.xml');
    fs.writeFileSync(xml, '<?xml version="1.0" encoding="utf-8"?>\n<MmPayrollBulk><TIN>0123456789012345</TIN><ListOfMmPayroll>'
        + '<MmPayroll><TaxPeriodMonth>10</TaxPeriodMonth><TaxPeriodYear>2026</TaxPeriodYear><CounterpartOpt>Resident</CounterpartOpt><CounterpartPassport /><CounterpartTin>1111111111110001</CounterpartTin><StatusTaxExemption>K1</StatusTaxExemption><Position>Staff</Position><TaxCertificate>N/A</TaxCertificate><TaxObjectCode>21-100-01</TaxObjectCode><Gross>7572265</Gross><Rate>1.25</Rate><IDPlaceOfBusinessActivity>B</IDPlaceOfBusinessActivity><WithholdingDate>2026-10-31</WithholdingDate></MmPayroll>'
        + '<MmPayroll><TaxPeriodMonth>10</TaxPeriodMonth><TaxPeriodYear>2026</TaxPeriodYear><CounterpartOpt>Resident</CounterpartOpt><CounterpartPassport /><CounterpartTin>9999999999990009</CounterpartTin><StatusTaxExemption>TK0</StatusTaxExemption><Position>Staff</Position><TaxCertificate>N/A</TaxCertificate><TaxObjectCode>21-100-01</TaxObjectCode><Gross>1000</Gross><Rate>0</Rate><IDPlaceOfBusinessActivity>B</IDPlaceOfBusinessActivity><WithholdingDate>2026-10-31</WithholdingDate></MmPayroll>'
        + '</ListOfMmPayroll></MmPayrollBulk>');
    p = await ed.previewAmend(c.page, { npwp: '0123456789012345', filePath: xml });
    assert.equal(p.items.length, 1); assert.equal(p.items[0].number, 'N-1'); assert.deepEqual(p.items[0].changed, ['ptkp', 'rate', 'tax']);
    assert.equal(p.items[0].after.tax, Math.round(7572265 * 0.0125));
    assert.ok(p.notes.some((n) => /9999999999990009.*tidak ada/.test(n)), 'baris tanpa BPMP terbit disebut (pakai upload)');
    assert.equal(p.totals.taxBefore, 113584);

    // Batal: pratinjau + kode; nomor yang tidak ada dilewati.
    c = fakeCoretax();
    const cp = await ed.previewCancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'] });
    assert.equal(cp.slips.length, 1); assert.ok(cp.notes.some((n) => /N-7/.test(n)));
    await assert.rejects(ed.cancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'], token: 'x' }), /berubah sejak pratinjau/);
    const cr = await ed.cancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'], token: cp.token });
    assert.deepEqual(cr.done.map((x) => [x.number, x.ok]), [['N-1', true]]); assert.deepEqual(c.cancelled, ['r1']);

    // Perekam: header tidak disimpan, passphrase disamarkan.
    const red = require('../lib/coretax-recorder').redact({ Passphrase: 'rahasia', Data: { Nik: '1', SignaturePayload: 'x', Amount: 5 } });
    assert.deepEqual(red, { Passphrase: '[disamarkan]', Data: { Nik: '1', SignaturePayload: '[disamarkan]', Amount: 5 } });
    console.log('ebupot-edit ok');
})().catch((e) => { console.error(e); process.exit(1); });
