// Upload Format Impor Coretax (lib/coretax-import.js): XML impor dikenali, Excel template DJP (XML map) dibaca lewat
// xpath kolom, XML disusun urut template resmi, NPWP pemotong dicocokkan. Data fiktif.
const assert = require('assert'), JSZip = require('jszip');
const imp = require('../lib/coretax-import');
module.exports = async function () {
    const TIN = '0123456789012345', NIK = '3401010101900001';
    // XML: jenis dari root, jumlah bukti potong, TIN
    const x = imp.buildXml('mp', TIN, [{ TaxPeriodMonth: '10', TaxPeriodYear: '2026', CounterpartOpt: 'Resident', CounterpartTin: NIK, StatusTaxExemption: 'TK/0', Position: 'Staff', TaxCertificate: 'N/A', TaxObjectCode: '21-100-01', Gross: '5000000', Rate: '0', IDPlaceOfBusinessActivity: TIN + '000000', WithholdingDate: '2026-10-31' }]);
    assert.match(x, /<MmPayrollBulk [^>]*>\s*<TIN>0123456789012345<\/TIN>\s*<ListOfMmPayroll>\s*<MmPayroll>\s*<TaxPeriodMonth>10<\/TaxPeriodMonth>/);
    assert.match(x, /<CounterpartPassport \/>/, 'elemen kosong tetap ditulis (urutan skema)');
    const order = [...x.matchAll(/<(\w+)>[^<]*<\/\1>|<(\w+) \/>/g)].map((m) => m[1] || m[2]).filter((n) => imp.TYPES.mp.fields.includes(n));
    assert.deepEqual(order, imp.TYPES.mp.fields, 'urutan elemen = template resmi');
    const rx = imp.readXml(Buffer.from(x));
    assert.deepEqual([rx.type, rx.tin, rx.count], ['mp', TIN, 1]);
    assert.throws(() => imp.readXml(Buffer.from('<?xml version="1.0"?><Foo><TIN>1</TIN></Foo>')), /tidak dikenali/);
    // Excel template DJP: tabel XML map (xpath per kolom, judul kolom bebas), Target rel absolut, sel inlineStr, tanggal serial
    const z = new JSZip();
    z.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="DATA" sheetId="1" r:id="rId1"/><sheet name="BP21" sheetId="2" r:id="rId2"/></sheets></workbook>');
    z.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>');
    z.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Target="/xl/tables/table1.xml"/></Relationships>');
    const xp = (f) => '<tableColumn id="1" name="judul ' + f + '"><xmlColumnPr mapId="1" xpath="/Bp21Bulk/ListOfBp21/Bp21/' + f + '" xmlDataType="string"/></tableColumn>';
    const cols = ['TaxPeriodMonth', 'TaxPeriodYear', 'CounterpartTin', 'Gross', 'WithholdingDate'];
    z.file('xl/tables/table1.xml', '<table id="1" ref="B3:F5" tableType="xml" headerRowCount="1"><tableColumns count="5">' + cols.map(xp).join('') + '</tableColumns></table>');
    const is = (r, s) => '<c r="' + r + '" t="inlineStr"><is><t>' + s + '</t></is></c>';
    z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="3">' + cols.map((c, i) => is(String.fromCharCode(66 + i) + '3', c)).join('') + '</row>'
        + '<row r="4"><c r="B4"><v>10</v></c><c r="C4"><v>2026</v></c>' + is('D4', NIK) + '<c r="E4"><v>6400000</v></c><c r="F4"><v>46326</v></c></row><row r="5"/></sheetData></worksheet>');
    const xlsx = await z.generateAsync({ type: 'nodebuffer' });
    const p = await imp.prepare(xlsx, 'BP21 contoh.xlsx', TIN);
    assert.deepEqual([p.type, p.label, p.count, p.tin, p.problems.length], ['bp21', 'BP21', 1, TIN, 0]);
    assert.match(p.xml, /<Bp21Bulk[\s\S]*<TIN>0123456789012345<\/TIN>[\s\S]*<CounterpartTin>3401010101900001<\/CounterpartTin>[\s\S]*<Gross>6400000<\/Gross>[\s\S]*<WithholdingDate>2026-10-31<\/WithholdingDate>/);
    // NPWP pemotong di file harus = entitas
    await assert.rejects(imp.prepare(Buffer.from(x), 'a.xml', '9999999999999999'), /berbeda dengan NPWP entitas/);
    // NIK penerima bukan 16 digit -> masalah, tidak diunggah
    const bad = imp.buildXml('mp', TIN, [{ CounterpartOpt: 'Resident', CounterpartTin: '123', TaxPeriodMonth: '10' }]);
    assert.equal((await imp.prepare(Buffer.from(bad), 'b.xml', TIN)).problems.length, 0, 'XML tidak diperiksa per baris (Coretax yang memvalidasi)');
    console.log('PASS: Upload Impor Coretax - XML dikenali dari root, Excel template DJP lewat XML map (rel absolut, inlineStr, tanggal serial), urutan elemen template resmi, NPWP pemotong dicocokkan.');
};
if (require.main === module) module.exports().catch((e) => { console.error(e); process.exitCode = 1; });
