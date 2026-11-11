// Tes lib/ebupot-edit.js dengan sesi Coretax tiruan (tanpa jaringan, data rekaan): BPMP (tanpa tanda tangan),
// BP21 (validate + tanda tangan), BPPU (PPh dihitung), batal, dan perekam.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ed = require('../lib/ebupot-edit');

const base = { TaxCertificateCode: '9', TaxArticle: 'Pasal 21', TaxObjectReferenceCode: 1, RevenueCode: '411121-100', BranchId: 'B', IsReportedToTaxReturn: false };
function fakeCoretax({ rejectValidate = new Set() } = {}) {
    const slips = {
        mp: [
            { ...base, RecordId: 'r1', WithholdingslipsAggregateIdentifier: 'a1', WithholdingSlipsNumber: 'N-1', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110001', Name: 'ANDI', Position: 'Staff', TaxObjectCode: '21-100-01', GrossIncome: 7572265, TaxRate: 1.5, IncomeTaxWithheld: 113584, TaxExemptionStatus: 'TK0' },
            { ...base, RecordId: 'r2', WithholdingslipsAggregateIdentifier: 'a2', WithholdingSlipsNumber: 'N-2', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110002', Name: 'BUDI', Position: 'Staff', TaxObjectCode: '21-100-01', GrossIncome: 5487245, TaxRate: 0.25, IncomeTaxWithheld: 13718, TaxExemptionStatus: 'TK0', IsReportedToTaxReturn: true },
            { ...base, RecordId: 'r3', WithholdingslipsAggregateIdentifier: 'a3', WithholdingSlipsNumber: 'N-3', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '1111111111110003', Name: 'CITRA', Position: 'Staff', TaxObjectCode: '21-100-01', GrossIncome: 9000000, TaxRate: 2, IncomeTaxWithheld: 180000, TaxExemptionStatus: 'K1' }
        ],
        bp21: [
            { ...base, RecordId: 'b1', WithholdingslipsAggregateIdentifier: 'ab1', WithholdingSlipsNumber: 'X-1', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '2222222222220001', Name: 'DEWI', TaxObjectCode: '21-100-07', TaxBase: 10000000, TaxRate: 2.5, IncomeTax: 125000, DeemedNetIncome: 50, DocumentType: 'Invoice', DocumentNumber: 'INV-1', DocumentDate: '2026-10-05T00:00:00+07:00', IDPlaceOfBusinessActivity: 'B000', TaxExemptionStatus: 'TK0' },
            { ...base, RecordId: 'b2', WithholdingslipsAggregateIdentifier: 'ab2', WithholdingSlipsNumber: 'X-2', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '2222222222220002', Name: 'EKO', TaxObjectCode: '21-100-07', TaxBase: 4000000, TaxRate: 2.5, IncomeTax: 50000, DeemedNetIncome: 50, DocumentType: 'Invoice', DocumentNumber: 'INV-2', DocumentDate: '2026-10-06T00:00:00+07:00', TaxExemptionStatus: 'TK0' }
        ],
        bpu: [
            { ...base, RecordId: 'u1', WithholdingslipsAggregateIdentifier: 'au1', WithholdingSlipsNumber: 'U-1', TaxPeriodCode: '10102026', WithholdingSlipsStatus: 'NORMAL', TaxIdentificationNumber: '0123456789012345', Name: 'PT CONTOH', TaxObjectCode: '24-104-14', TaxBase: 10000000, TaxRate: 2, IncomeTax: 200000, DocumentNumber: 'K-1', LastUpdatedDate: '2026-10-07T10:00:00+07:00' }
        ]
    };
    const sent = [], validated = [], cancelled = [], signs = [];
    const typeOf = (url) => (/(?:view|amend|cancel)ebupot([a-z0-9]+)/.exec(url) || [])[1];
    const s = {
        auth: { claims: { taxpayer_id: 'TP-1' } },
        list: async (endpoint, code, property) => {
            const type = (/getebupot([a-z0-9]+?)(not)?issued/.exec(endpoint) || [])[1];
            if (/notissued/.test(endpoint)) return [];
            assert.equal(property, type === 'bpa1' ? 'IncomePeriodCodeEnd' : 'TaxPeriodCode');
            return (slips[type] || []).filter((x) => x.TaxPeriodCode === code && !cancelled.includes(x.RecordId)).map((x) => ({ ...x }));
        },
        lookup: async () => ({ payload: { TaxpayerType: 'INDIVIDUAL' } }),
        post: async (url, body) => {
            if (/digitalCertificateList/.test(url)) return { status: 200, json: { Payload: [{ Code: '00' }] } };
            if (/validate-sign/.test(url)) { signs.push(body); return { status: 200, json: { IsSuccessful: true, Payload: { KodeResponse: body.Passphrase === 'benar' ? 1 : 0, ErrMessage: 'salah' } } }; }
            const type = typeOf(url), list = slips[type] || [];
            if (/\/viewebupot/.test(url)) { const x = list.find((y) => y.RecordId === body.RecordId); return { status: 200, json: { Payload: { Result: x ? { ...x } : null } } }; }
            if (/\/amendebupot[a-z0-9]+\/validate$/.test(url)) { validated.push({ type, body }); return rejectValidate.has(body.RecordId) ? { status: 200, json: { IsSuccessful: false, Message: 'Tarif tidak sesuai' } } : { status: 200, json: { IsSuccessful: true, Payload: { DocumentTypeId: 'D', Xmldata: '<x/>' } } }; }
            if (/\/amendebupot[a-z0-9]+$/.test(url)) {
                sent.push({ type, body });
                const x = list.find((y) => y.RecordId === body.RecordId);
                for (const k of Object.keys(body)) if (k in x && !['RecordId', 'WithholdingslipsAggregateIdentifier'].includes(k)) x[k] = body[k];
                x.WithholdingSlipsStatus = 'AMENDMENT';
                return { status: 200, json: { IsSuccessful: true } };
            }
            if (/\/cancelebupot/.test(url)) { cancelled.push(body.EBUPOTIdentifiers[0].RecordIdentifier); signs.push({ cancelSign: !!body.SignParameter }); return { status: 200, json: { IsSuccessful: true } }; }
            return { status: 404, json: null };
        },
        close: async () => {}
    };
    return { page: { __session: s }, slips, sent, validated, cancelled, signs };
}

(async () => {
    assert.deepEqual(ed.periodOf('1026'), { code: '10102026', month: 10, year: '2026', label: '10/2026' });
    assert.equal(ed.taxOf(7572265, 1.5), 113584, 'PPh dibulatkan seperti Coretax');
    assert.deepEqual(Object.keys(ed.SPEC), ['mp', 'bp21', 'bp26', 'bpnr', 'bpu', 'bpa1', 'bpa2', 'sp', 'cy']);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ebupot-edit-'));

    // ---- BPMP ----
    let c = fakeCoretax();
    const f = await ed.find(c.page, { period: '1026', nik: '1111111111110001' });
    assert.equal(f.total, 1); assert.equal(f.slips[0].ptkp, 'TK0'); assert.equal(f.slips[0].tax, 113584);
    let p = await ed.previewAmend(c.page, { changes: [{ number: 'N-1', period: '1026', ptkp: 'TK1' }, { number: 'N-2', period: '1026', ptkp: 'K1' }, { number: 'N-3', period: '1026', ptkp: 'K1' }, { number: 'N-9', period: '1026', ptkp: 'K0' }, { number: 'N-1', period: '1026', fields: { TaxIdentificationNumber: '9' } }] });
    assert.equal(p.items.length, 1); assert.deepEqual(p.items[0].changed, ['TaxExemptionStatus']); assert.equal(p.items[0].taxAfter, 113584, 'PTKP satu kategori: PPh tetap');
    assert.ok(p.notes.some((n) => /N-2.*kategori TER A -> B/.test(n)));
    assert.ok(p.notes.some((n) => /N-3 sudah sesuai/.test(n)));
    assert.ok(p.notes.some((n) => /N-9 tidak ada/.test(n)));
    assert.ok(p.notes.some((n) => /tidak bisa diubah di sini/.test(n)), 'NIK tidak bisa diubah lewat alat ini');
    assert.equal(c.validated.length, 0, 'BPMP tanpa /validate');
    p = await ed.previewAmend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }] });
    assert.equal(p.items[0].taxAfter, 27436); assert.deepEqual(p.periodsReported, ['10/2026']);
    await assert.rejects(ed.amend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }], token: 'salah', outDir: out }), /berubah sejak pratinjau/);
    assert.equal(c.sent.length, 0);
    let r = await ed.amend(c.page, { changes: [{ number: 'N-2', period: '1026', ptkp: 'K1', rate: 0.5 }], token: p.token, outDir: out });
    assert.equal(r.results[0].status, 'DIBETULKAN');
    let b = c.sent[0].body;
    assert.deepEqual(Object.keys(b), [...ed.SPEC.mp.keys, 'RecordId', 'WithholdingslipsAggregateIdentifier'], 'urutan isian = submit() Coretax');
    assert.equal(b.TaxExemptionStatus, 'K1'); assert.equal(b.TaxRate, 0.5); assert.equal(b.IncomeTaxWithheld, 27436); assert.equal(b.GrossIncome, 5487245);
    assert.equal(b.TaxpayerType, 'INDIVIDUAL'); assert.equal(b.IsForeignEmployee, false); assert.equal(b.TaxObjectReferenceCode, '1'); assert.equal(b.Name, 'BUDI');
    assert.ok(!b.SignParameter, 'BPMP tanpa tanda tangan');
    assert.ok(fs.existsSync(path.join(out, 'cadangan-mp-N-2.json')));
    // File revisi XML.
    c = fakeCoretax();
    const xml = path.join(out, 'revisi.xml');
    fs.writeFileSync(xml, '<?xml version="1.0" encoding="utf-8"?>\n<MmPayrollBulk><TIN>0123456789012345</TIN><ListOfMmPayroll>'
        + '<MmPayroll><TaxPeriodMonth>10</TaxPeriodMonth><TaxPeriodYear>2026</TaxPeriodYear><CounterpartOpt>Resident</CounterpartOpt><CounterpartPassport /><CounterpartTin>1111111111110001</CounterpartTin><StatusTaxExemption>K1</StatusTaxExemption><Position>Staff</Position><TaxCertificate>N/A</TaxCertificate><TaxObjectCode>21-100-01</TaxObjectCode><Gross>7572265</Gross><Rate>1.25</Rate><IDPlaceOfBusinessActivity>B</IDPlaceOfBusinessActivity><WithholdingDate>2026-10-31</WithholdingDate></MmPayroll>'
        + '<MmPayroll><TaxPeriodMonth>10</TaxPeriodMonth><TaxPeriodYear>2026</TaxPeriodYear><CounterpartOpt>Resident</CounterpartOpt><CounterpartPassport /><CounterpartTin>9999999999990009</CounterpartTin><StatusTaxExemption>TK0</StatusTaxExemption><Position>Staff</Position><TaxCertificate>N/A</TaxCertificate><TaxObjectCode>21-100-01</TaxObjectCode><Gross>1000</Gross><Rate>0</Rate><IDPlaceOfBusinessActivity>B</IDPlaceOfBusinessActivity><WithholdingDate>2026-10-31</WithholdingDate></MmPayroll>'
        + '</ListOfMmPayroll></MmPayrollBulk>');
    p = await ed.previewAmend(c.page, { npwp: '0123456789012345', filePath: xml });
    assert.equal(p.items.length, 1); assert.equal(p.items[0].number, 'N-1'); assert.deepEqual(p.items[0].changed.sort(), ['IncomeTaxWithheld', 'TaxExemptionStatus', 'TaxRate']);
    assert.equal(p.items[0].taxAfter, Math.round(7572265 * 0.0125));
    assert.ok(p.notes.some((n) => /9999999999990009.*tidak ada/.test(n)));

    // ---- BP21: tanda tangan, /validate, PPh wajib disebut bila dasar/tarif berubah ----
    c = fakeCoretax({ rejectValidate: new Set(['b2']) });
    p = await ed.previewAmend(c.page, { type: 'bp21', changes: [{ number: 'X-1', period: '1026', fields: { TaxBase: 12000000 } }, { number: 'X-1', period: '1026', document: 'INV-1A' }, { number: 'X-2', period: '1026', document: 'INV-2A' }] });
    assert.ok(p.needsSign);
    assert.ok(p.notes.some((n) => /X-1 BP21 - dasar \/ tarif berubah, sebutkan juga PPh-nya \(IncomeTax\)/.test(n)), 'BP21 tanpa PPh dilewati');
    assert.ok(p.notes.some((n) => /X-2 ditolak pemeriksaan Coretax \(Tarif tidak sesuai\)/.test(n)), 'ditolak /validate = dilewati');
    assert.equal(p.items.length, 1); assert.equal(p.items[0].coretaxCheck, 'lolos'); assert.deepEqual(p.items[0].after, { DocumentNumber: 'INV-1A' });
    const vb = c.validated.find((x) => x.body.RecordId === 'b1').body;
    assert.deepEqual(Object.keys(vb), [...ed.SPEC.bp21.keys, 'RecordId', 'WithholdingslipsAggregateIdentifier']);
    assert.equal(vb.IDPlaceOfBusinessActivity, 'B000'); assert.equal(vb.IpAddress, ''); assert.equal(vb.Number, ''); assert.equal(vb.DocumentDate, '2026-10-05T00:00:00+07:00');
    const ch = [{ number: 'X-1', period: '1026', document: 'INV-1A' }, { number: 'X-2', period: '1026', document: 'INV-2A' }];
    p = await ed.previewAmend(c.page, { type: 'bp21', changes: ch });
    await assert.rejects(ed.amend(c.page, { type: 'bp21', changes: ch, token: p.token, outDir: out, signer: { nik: '3171', passphrase: 'keliru' } }), /Passphrase ditolak/);
    assert.equal(c.sent.length, 0, 'passphrase salah: tidak ada yang dikirim');
    await assert.rejects(ed.amend(c.page, { type: 'bp21', changes: ch, token: p.token, outDir: out }), /perlu tanda tangan/);
    r = await ed.amend(c.page, { type: 'bp21', changes: ch, token: p.token, outDir: out, signer: { nik: '3171', passphrase: 'benar' } });
    assert.equal(r.results.length, 1); assert.equal(r.results[0].status, 'DIBETULKAN');
    b = c.sent[0].body;
    assert.deepEqual(b.SignParameter, { Type: '02', Provider: '00', SignerID: '3171', SignerPassword: 'benar' }); assert.equal(b.SignedTaxpayerAggregateIdentifier, 'TP-1');
    assert.equal(b.DocumentNumber, 'INV-1A'); assert.equal(b.TaxBase, 10000000); assert.equal(b.IncomeTax, 125000);
    // Dengan PPh disebut: lolos.
    p = await ed.previewAmend(c.page, { type: 'bp21', changes: [{ number: 'X-1', period: '1026', gross: 12000000, tax: 150000 }] });
    assert.deepEqual(p.items[0].after, { TaxBase: 12000000, IncomeTax: 150000 });

    // ---- BPPU: PPh dihitung dari DPP x tarif ----
    c = fakeCoretax();
    p = await ed.previewAmend(c.page, { type: 'bpu', changes: [{ number: 'U-1', period: '1026', gross: 12500000 }] });
    assert.deepEqual(p.items[0].after, { TaxBase: 12500000, IncomeTax: 250000 });
    assert.equal(c.validated[0].body.LastUpdatedDate, '2026-10-07T10:00:00+07:00');

    // ---- Batal: pratinjau + kode; jenis bertanda tangan membawa SignParameter ----
    c = fakeCoretax();
    let cp = await ed.previewCancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'] });
    assert.equal(cp.slips.length, 1); assert.ok(cp.notes.some((n) => /N-7/.test(n))); assert.equal(cp.needsSign, false);
    await assert.rejects(ed.cancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'], token: 'x' }), /berubah sejak pratinjau/);
    let cr = await ed.cancel(c.page, { period: '1026', numbers: ['N-1', 'N-7'], token: cp.token });
    assert.deepEqual(cr.done.map((x) => [x.number, x.ok]), [['N-1', true]]); assert.deepEqual(c.cancelled, ['r1']); assert.equal(c.signs.at(-1).cancelSign, false);
    cp = await ed.previewCancel(c.page, { type: 'bpu', period: '1026', numbers: ['U-1'] });
    assert.equal(cp.needsSign, true);
    cr = await ed.cancel(c.page, { type: 'bpu', period: '1026', numbers: ['U-1'], token: cp.token, signer: { nik: '3171', passphrase: 'benar' } });
    assert.equal(cr.done[0].ok, true); assert.equal(c.signs.at(-1).cancelSign, true);

    // Perekam: header tidak disimpan, passphrase disamarkan.
    const red = require('../lib/coretax-recorder').redact({ Passphrase: 'rahasia', Data: { Nik: '1', SignaturePayload: 'x', Amount: 5 } });
    assert.deepEqual(red, { Passphrase: '[disamarkan]', Data: { Nik: '1', SignaturePayload: '[disamarkan]', Amount: 5 } });
    console.log('ebupot-edit ok');
})().catch((e) => { console.error(e); process.exit(1); });
