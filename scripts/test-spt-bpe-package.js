const assert = require('assert');
const spt = require('../automation/spt');
const lampiran = require('../automation/lampiran');
const { buildLampiranWidgetScript } = require('../lib/lampiran-widget');

const badan = spt.JENIS_PAJAK.badan;
const op = spt.JENIS_PAJAK.spt_op;
// Taxio's naming (lib/spt-filenames.js): entity code first, period last.
const badanName = spt.__test.buildSptFilename('BBH', badan.packageToken, '2025', null);
const opName = spt.__test.buildSptFilename('CONTOH WAJIB PAJAK', op.packageToken, '2025', null);
assert(!/1771/.test(badanName));
assert(!/1770/.test(opName));
assert.strictEqual(badanName,'BBH - SPT Tahunan PPh Badan (Lengkap) 2025.pdf');
assert.strictEqual(opName,'CWP - SPT Tahunan PPh OP (Lengkap) 2025.pdf');
assert.strictEqual(lampiran.TAXTYPE_CONFIG.ICT_RCIT.formCode, 'SPT Tahunan PPh Badan');
assert.strictEqual(lampiran.TAXTYPE_CONFIG.ICT_PIT.formCode, 'SPT Tahunan PPh Orang Pribadi');
assert.strictEqual(lampiran.__test.widgetPackageFilename('CONTOH BADAN, PT', 'ICT_RCIT', 'full', '2025'),
    'CB - SPT Tahunan PPh Badan (Lengkap) 2025.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('BAI', 'ICT_RCIT', 'print', '2025'),
    'BAI - SPT Tahunan PPh Badan (Ringkas) 2025.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('BAI', 'ICT_WIT', 'full', '0726'),
    'BAI - SPT Masa PPh 21 (Lengkap) 0726.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('BAI', 'ICT_WT', 'full', '0726'),
    'BAI - SPT Masa PPh Unifikasi (Lengkap) 0726.pdf');
assert.strictEqual(lampiran.__test.widgetPackageFilename('BAI', 'VAT_VAT', 'full', '0726'),
    'BAI - SPT Masa PPN (Lengkap) 0726.pdf');
// A manual Coretax login has no Taxio code: it is made from the taxpayer's name.
assert.strictEqual(lampiran.__test.widgetComponentFilename('Sesi Manual · BERKAT ARTISAN INDONESIA, PT', 'ICT_WT', 'INDUK', '0826'),
    'BAI - UNIFIKASI INDUK 0826.pdf');

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
// PPN is routed by its type code. Under the period code Coretax still opens the form but every
// lampiran grid comes back empty (verified live 2026-10-07, NIGG Juli 2026: A-2 182 / B-2 266 /
// B-3 32 rows under VAT_VAT, 0 under 07072026), so the period code must not come first.
assert(ppnRows[0].includes('/value-added-tax-return/taxpayer/record/VAT_VAT/aggregate?view=true'));

console.log(JSON.stringify({ badanName, opName, annualUrl: annualRows[0], unifikasiUrl: unifikasiRows[0], ppnUrl: ppnRows[0] }, null, 2));

assert.strictEqual(spt.__test.buildSptFilename('BBH','SPT MASA PPH 21 (Rahasia)','0126','2'),'BBH - SPT Masa PPh 21 (Rahasia) 0126 PB 2.pdf');
assert.strictEqual(spt.__test.buildSptFilename('BBH','1721 BPE','0126',null),'BBH - 1721 BPE 0126.pdf');
assert.strictEqual(spt.__test.buildSptFilename('BBH','1721 INDUK','0826',null),'BBH - 1721 INDUK 0826.pdf');
{const f=require('../lib/spt-filenames');const stem=f.filename('ICT_WIT','0826','Lampiran - Lengkap','','','BBH');
 assert.strictEqual(stem,'BBH - SPT Masa PPh 21 Lampiran (Lengkap) 0826');assert.strictEqual(f.excelName(stem),'BBH - SPT Masa PPh 21 0826.xlsx');}
