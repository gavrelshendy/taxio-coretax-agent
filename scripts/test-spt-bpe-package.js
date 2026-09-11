const assert = require('assert');
const spt = require('../automation/spt');
const lampiran = require('../automation/lampiran');
const { buildLampiranWidgetScript } = require('../lib/lampiran-widget');

const badan = spt.JENIS_PAJAK.badan;
const op = spt.JENIS_PAJAK.spt_op;
const badanName = spt.__test.buildSptFilename('BAROQUE BENANG HARAPAN', badan.packageToken, '2025', null);
const opName = spt.__test.buildSptFilename('JONATAN DION SETYAWAN', op.packageToken, '2025', null);
assert(!/1771/.test(badanName));
assert(!/1770/.test(opName));
assert.strictEqual(badanName,'SPT Tahunan PPh Badan 2025 - Lengkap.pdf');
assert.strictEqual(opName,'SPT Tahunan PPh Orang Pribadi 2025 - Lengkap.pdf');
assert.strictEqual(lampiran.TAXTYPE_CONFIG.ICT_RCIT.formCode, 'SPT Tahunan PPh Badan');
assert.strictEqual(lampiran.TAXTYPE_CONFIG.ICT_PIT.formCode, 'SPT Tahunan PPh Orang Pribadi');
assert.strictEqual(lampiran.__test.widgetPackageFilename('PIA JUWARA SATOE', 'ICT_RCIT', 'full', '2025'),
    'SPT Tahunan PPh Badan 2025 - Lengkap.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('PIA JUWARA SATOE', 'ICT_RCIT', 'print', '2025'),
    'SPT Tahunan PPh Badan 2025 - Ringkas.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('PIA JUWARA SATOE', 'ICT_WIT', 'full', '0726'),
    'SPT Masa PPh 21 0726 - Lengkap.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('PIA JUWARA SATOE', 'ICT_WT', 'full', '0726'),
    'SPT Masa PPh Unifikasi 0726 - Lengkap.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('PIA JUWARA SATOE', 'VAT_VAT', 'full', '0726'),
    'SPT Masa PPN 0726 - Lengkap.pdf');

const widgetScript = buildLampiranWidgetScript();
assert(widgetScript.includes('__ca_downloadSptPackageV1150'));
assert(widgetScript.includes('aggregateId:m[5]'));
assert(widgetScript.includes('Unduh SPT + Lampiran'));

const annualRows = spt.__test.buildLampiranViewCandidates({
    TaxTypeCode: 'ICT_RCIT', RecordId: 'record', AggregateIdentifier: 'aggregate', TaxPeriodCode: '01012025'
}, { taxpayerId: 'taxpayer' });
assert(annualRows[0].includes('/corporate-income-tax-return/taxpayer/record/ICT_RCIT/aggregate?view=true'));

const unifikasiRows = spt.__test.buildLampiranViewCandidates({
    TaxTypeCode: 'ICT_WT', RecordId: 'record', AggregateIdentifier: 'aggregate', TaxPeriodCode: '07072026'
}, { taxpayerId: 'taxpayer' });
assert(unifikasiRows[0].includes('/withholding-tax-return/taxpayer/record/07072026/aggregate?view=true'));

const ppnRows = spt.__test.buildLampiranViewCandidates({
    TaxTypeCode: 'VAT_VAT', RecordId: 'record', AggregateIdentifier: 'aggregate', TaxPeriodCode: '07072026'
}, { taxpayerId: 'taxpayer' });
assert(ppnRows[0].includes('/value-added-tax-return/taxpayer/record/07072026/aggregate?view=true'));

console.log(JSON.stringify({ badanName, opName, annualUrl: annualRows[0], unifikasiUrl: unifikasiRows[0], ppnUrl: ppnRows[0] }, null, 2));

assert.strictEqual(spt.__test.buildSptFilename('BBH','SPT MASA PPH 21 (Rahasia)','0126','2'),'SPT Masa PPh 21 0126 PB 2 - Confidential.pdf');
assert.strictEqual(spt.__test.buildSptFilename('BBH','1721 BPE','0126',null),'SPT Masa PPh 21 0126 - BPE.pdf');
