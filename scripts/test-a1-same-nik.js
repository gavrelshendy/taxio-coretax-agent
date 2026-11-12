// NIK sementara "#NIK lama" yang NIK lamanya persis sama dengan NIK valid di masa lain (data rekaan):
// usulan tunggal = NIK itu (kategori Otomatis), bukan "isi manual".
const assert = require('assert');
const { nikIssues } = require('../lib/a1-workbook');
const g = (id, name, old, temp) => ({ key: temp ? old + '#' : id, id, name, old, temp });
const list = [
    g('9990000000999000', 'PENERIMA PENGHASILAN#3201011201900013', '3201011201900013', true),
    g('3201011201900013', 'BUDI CONTOH', '', false),
    g('3201011201900021', 'ORANG LAIN', '', false),
    g('9990000000999000', 'PENERIMA PENGHASILAN#3301010101900001', '3301010101900001', true)
];
const issues = nikIssues(list);
const a = issues.get('3201011201900013#');
assert.deepEqual(a.suggest, ['3201011201900013'], 'NIK yang sama diusulkan, NIK mirip lain tidak');
assert.ok(a.same && /sudah dipakai di bukti potong lain atas nama BUDI CONTOH/.test(a.note));
assert.equal(issues.get('3201011201900013').kind, 'match');
const b = issues.get('3301010101900001#');
assert.deepEqual(b.suggest, []); assert.ok(!b.same && /isi NIK benar secara manual/.test(b.note));
console.log('a1 same-nik ok');
