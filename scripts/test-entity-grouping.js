/* Tes pengelompokan daftar entitas (lib/entities.js groupEntityRows): satu baris per entitas,
   PIC dipilih di dalam baris, entitas tanpa PIC ditandai. Jalankan:
     node scripts/test-entity-grouping.js */
const assert = require('assert');
const { groupEntityRows } = require('../lib/entities');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
// Persis bentuk keluaran listAutomatableEntities (satu baris per entitas x PIC).
const row = (o) => Object.assign({ project: 'taxio_hub', project_label: 'Taxio Hub', npwp: '', individual: false, pic_is_mine: true, is_primary: false }, o);

console.log('groupEntityRows');

test('Entitas dengan 2 PIC menjadi satu baris (kasus BERKAT KANA ABADI: 2 PIC muncul 2x)', () => {
    const out = groupEntityRows([
        row({ entity_id: 'BKA', entity_name: 'BERKAT KANA ABADI, PT', pic_id: 'p-fredi', pic_name: 'FREDI SETYAWAN', is_primary: true }),
        row({ entity_id: 'BKA', entity_name: 'BERKAT KANA ABADI, PT', pic_id: 'p-ronald', pic_name: 'RONALD TONY' })
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].linked, true);
    assert.deepStrictEqual(out[0].pics.map((p) => p.pic_name), ['FREDI SETYAWAN', 'RONALD TONY']);
});

test('PIC utama selalu pertama walau datang belakangan', () => {
    const out = groupEntityRows([
        row({ entity_id: 'X', entity_name: 'X', pic_id: 'a', pic_name: 'AAA' }),
        row({ entity_id: 'X', entity_name: 'X', pic_id: 'z', pic_name: 'ZZZ', is_primary: true })
    ]);
    assert.deepStrictEqual(out[0].pics.map((p) => p.pic_id), ['z', 'a']);
});

test('Baris placeholder unlinked menjadi entitas linked=false tanpa PIC', () => {
    const out = groupEntityRows([row({ entity_id: 'BNK', entity_name: 'BERKAT NEGRI KESUKAAN, PT', pic_id: 'unlinked', pic_name: 'Belum Taut PIC Coretax', is_primary: true })]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].linked, false);
    assert.deepStrictEqual(out[0].pics, []);
    assert.strictEqual(out[0].pic_id, undefined, 'tidak boleh membawa pic_id placeholder');
});

test('PIC yang sama tidak dobel', () => {
    const r = row({ entity_id: 'D', entity_name: 'D', pic_id: 'p1', pic_name: 'P' });
    assert.strictEqual(groupEntityRows([r, r])[0].pics.length, 1);
});

test('Entitas berbeda dan project berbeda tidak tergabung; urut nama', () => {
    const out = groupEntityRows([
        row({ entity_id: 'B', entity_name: 'Bravo', pic_id: 'p1', pic_name: 'P' }),
        row({ entity_id: 'A', entity_name: 'Alpha', pic_id: 'p1', pic_name: 'P' }),
        row({ entity_id: 'A', entity_name: 'Alpha lain project', project: 'lain', pic_id: 'p2', pic_name: 'Q' })
    ]);
    assert.deepStrictEqual(out.map((e) => e.entity_name), ['Alpha', 'Alpha lain project', 'Bravo']);
});

test('individual: satu baris saja yang menilai Orang Pribadi sudah cukup', () => {
    const out = groupEntityRows([
        row({ entity_id: 'I', entity_name: 'I', pic_id: 'p1', pic_name: 'P1', individual: false }),
        row({ entity_id: 'I', entity_name: 'I', pic_id: 'p2', pic_name: 'P2', individual: true })
    ]);
    assert.strictEqual(out[0].individual, true);
});

test('Campuran linked dan unlinked pada entitas yang sama: linked, tanpa pic placeholder', () => {
    const out = groupEntityRows([
        row({ entity_id: 'M', entity_name: 'M', pic_id: 'unlinked', pic_name: 'Belum Taut PIC Coretax' }),
        row({ entity_id: 'M', entity_name: 'M', pic_id: 'p1', pic_name: 'P1' })
    ]);
    assert.strictEqual(out[0].linked, true);
    assert.deepStrictEqual(out[0].pics.map((p) => p.pic_id), ['p1']);
});

test('Masukan kosong atau undefined', () => {
    assert.deepStrictEqual(groupEntityRows([]), []);
    assert.deepStrictEqual(groupEntityRows(undefined), []);
});

test('pic_is_mine dipertahankan per PIC (false hanya bila memang false)', () => {
    const out = groupEntityRows([
        row({ entity_id: 'O', entity_name: 'O', pic_id: 'p1', pic_name: 'P1', pic_is_mine: false }),
        row({ entity_id: 'O', entity_name: 'O', pic_id: 'p2', pic_name: 'P2' })
    ]);
    assert.strictEqual(out[0].pics.find((p) => p.pic_id === 'p1').pic_is_mine, false);
    assert.strictEqual(out[0].pics.find((p) => p.pic_id === 'p2').pic_is_mine, true);
});

console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
