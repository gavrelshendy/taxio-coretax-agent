/* Tes penyimpanan entitas lokal (lib/local-entities.js): aturan PIC untuk Badan, keterikatan
   antar entitas, dan isolasi per akun. Memakai folder data sementara. Jalankan:
     node scripts/test-local-entities.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-test-'));
const store = require('../lib/local-entities');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

console.log('local-entities');
const U1 = 'user-1'; const U2 = 'user-2';
let ani;

test('Orang Pribadi: tidak butuh PIC, NPWP opsional, nama dirapikan', () => {
    ani = store.create(U1, { name: '  Ani   Sample  Wijaya ', type: 'op', npwp: '' });
    assert.strictEqual(ani.name, 'Ani Sample Wijaya');
    assert.strictEqual(ani.type, 'op');
    assert.deepStrictEqual(ani.pics, []);
    assert.ok(/^le_[0-9a-f]{12}$/.test(ani.id));
});

test('Orang Pribadi mengabaikan PIC yang dikirim', () => {
    const r = store.create(U1, { name: 'Budi OP', type: 'op', pics: [{ source: 'local', id: ani.id }] });
    assert.deepStrictEqual(r.pics, []);
    store.remove(U1, r.id);
});

test('Badan wajib menautkan minimal satu PIC', () => {
    throwsMsg(() => store.create(U1, { name: 'CV Tanpa PIC', type: 'badan', pics: [] }), /wajib menautkan minimal satu PIC/);
});

test('Badan menautkan PIC lokal: nama PIC diambil dari penyimpanan, bukan dari input', () => {
    const cv = store.create(U1, { name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '06.789.012.3-456.000', pics: [{ source: 'local', id: ani.id, name: 'nama-palsu' }] });
    assert.strictEqual(cv.npwp, '067890123456000');
    assert.deepStrictEqual(cv.pics, [{ source: 'local', id: ani.id, name: 'Ani Sample Wijaya' }]);
});

test('PIC lokal harus entitas Orang Pribadi yang ada; Badan tidak bisa jadi PIC', () => {
    const cv = store.listFor(U1).find((e) => e.type === 'badan');
    throwsMsg(() => store.create(U1, { name: 'CV Lain', type: 'badan', pics: [{ source: 'local', id: cv.id }] }), /tidak ditemukan sebagai entitas Orang Pribadi/);
    throwsMsg(() => store.create(U1, { name: 'CV Lain', type: 'badan', pics: [{ source: 'local', id: 'le_tidakada' }] }), /tidak ditemukan sebagai entitas Orang Pribadi/);
});

test('PIC dari Taxio Hub divalidasi terhadap daftar yang boleh dilihat akun ini', () => {
    const ctx = { hubPicIds: new Set(['hub-op-1']) };
    const ok = store.create(U1, { name: 'PT Hub PIC', type: 'badan', pics: [{ source: 'hub', id: 'hub-op-1', name: 'Budi Contoh Santoso' }] }, ctx);
    assert.deepStrictEqual(ok.pics, [{ source: 'hub', id: 'hub-op-1', name: 'Budi Contoh Santoso' }]);
    throwsMsg(() => store.create(U1, { name: 'PT Hub PIC 2', type: 'badan', pics: [{ source: 'hub', id: 'hub-lain', name: 'X' }] }, ctx), /bukan Orang Pribadi/);
    store.remove(U1, ok.id);
});

test('Lebih dari satu PIC diperbolehkan, duplikat dibuang, maksimal 5', () => {
    const b = store.create(U1, { name: 'Budi Kedua', type: 'op' });
    const two = store.create(U1, { name: 'PT Dua PIC', type: 'badan', pics: [{ source: 'local', id: ani.id }, { source: 'local', id: b.id }, { source: 'local', id: ani.id }] });
    assert.strictEqual(two.pics.length, 2);
    const many = [];
    for (let i = 0; i < 6; i++) many.push({ source: 'hub', id: 'h' + i, name: 'PIC ' + i });
    throwsMsg(() => store.create(U1, { name: 'PT Banyak PIC', type: 'badan', pics: many }), /Maksimal 5 PIC/);
    store.remove(U1, two.id); store.remove(U1, b.id);
});

test('Validasi nama, jenis, dan NPWP', () => {
    throwsMsg(() => store.create(U1, { name: '   ', type: 'op' }), /Nama entitas wajib diisi/);
    throwsMsg(() => store.create(U1, { name: 'x'.repeat(101), type: 'op' }), /maksimal 100/);
    throwsMsg(() => store.create(U1, { name: 'Tanpa Jenis' }), /Badan atau Orang Pribadi/);
    throwsMsg(() => store.create(U1, { name: 'NPWP Salah', type: 'op', npwp: '123' }), /15 atau 16 digit/);
    const ok16 = store.create(U1, { name: 'NPWP 16', type: 'op', npwp: '1234567890123456' });
    assert.strictEqual(ok16.npwp, '1234567890123456');
    store.remove(U1, ok16.id);
});

test('Nama unik per akun (tanpa membedakan huruf besar/kecil), tapi boleh sama di akun lain', () => {
    throwsMsg(() => store.create(U1, { name: 'ani sample wijaya', type: 'op' }), /sudah ada/);
    const other = store.create(U2, { name: 'Ani Sample Wijaya', type: 'op' });
    assert.ok(other.id);
    assert.strictEqual(store.listFor(U2).length, 1);
    assert.ok(store.listFor(U1).length >= 2);
});

test('Tidak bisa menghapus PIC yang masih dipakai Badan; setelah Badan dihapus bisa', () => {
    const cv = store.listFor(U1).find((e) => e.name === 'CV Klien Baru Sejahtera');
    throwsMsg(() => store.remove(U1, ani.id), /masih dipakai sebagai PIC oleh CV Klien Baru Sejahtera/);
    store.remove(U1, cv.id);
    assert.strictEqual(store.remove(U1, ani.id), true);
    assert.strictEqual(store.listFor(U1).find((e) => e.id === ani.id), undefined);
});

test('Ubah nama PIC ikut memperbarui entitas Badan yang menautkannya', () => {
    const p = store.create(U1, { name: 'Rina Lama', type: 'op' });
    const cv = store.create(U1, { name: 'CV Rename', type: 'badan', pics: [{ source: 'local', id: p.id }] });
    store.update(U1, p.id, { name: 'Rina Baru', type: 'op' });
    assert.strictEqual(store.listFor(U1).find((e) => e.id === cv.id).pics[0].name, 'Rina Baru');
    store.remove(U1, cv.id); store.remove(U1, p.id);
});

test('Tidak bisa mengubah PIC yang dipakai menjadi Badan; bisa mengubah Badan jadi OP', () => {
    const p = store.create(U1, { name: 'PIC Pakai', type: 'op' });
    const cv = store.create(U1, { name: 'CV Pakai', type: 'badan', pics: [{ source: 'local', id: p.id }] });
    throwsMsg(() => store.update(U1, p.id, { name: 'PIC Pakai', type: 'badan', pics: [{ source: 'hub', id: 'h1', name: 'X' }] }), /dipakai sebagai PIC oleh CV Pakai/);
    const asOp = store.update(U1, cv.id, { name: 'CV Pakai', type: 'op' });
    assert.deepStrictEqual(asOp.pics, []);
    store.remove(U1, cv.id); store.remove(U1, p.id);
});

test('update: entitas tidak ada, dan nama boleh tetap sama untuk dirinya sendiri', () => {
    throwsMsg(() => store.update(U1, 'le_tidakada', { name: 'X', type: 'op' }), /tidak ditemukan/);
    const p = store.create(U1, { name: 'Nama Tetap', type: 'op' });
    const upd = store.update(U1, p.id, { name: 'Nama Tetap', type: 'op', npwp: '123456789012345' });
    assert.strictEqual(upd.npwp, '123456789012345');
    store.remove(U1, p.id);
});

test('toEntity: bentuk untuk dashboard, jalur manual, dan billing (individual mengikuti jenis)', () => {
    const p = store.create(U1, { name: 'Pribadi Satu', type: 'op', npwp: '123456789012345' });
    const cv = store.create(U1, { name: 'CV Bentuk', type: 'badan', pics: [{ source: 'local', id: p.id }] });
    const eOp = store.toEntity(p); const eCv = store.toEntity(cv);
    assert.strictEqual(eOp.individual, true);
    assert.strictEqual(eCv.individual, false);
    assert.strictEqual(eCv.project, 'local');
    assert.strictEqual(eCv.entity_id, 'local:' + cv.id);
    assert.strictEqual(eCv.pic_name, 'Pribadi Satu');
    assert.deepStrictEqual(eCv.pics.map((x) => x.pic_name), ['Pribadi Satu']);
    assert.strictEqual(store.getEntity(U1, cv.id).entity_name, 'CV Bentuk');
    assert.strictEqual(store.getEntity(U2, cv.id), null, 'akun lain tidak boleh melihatnya');
    store.remove(U1, cv.id); store.remove(U1, p.id);
});

test('picCandidates: gabungan Orang Pribadi Hub dan lokal, tanpa entitas sendiri', () => {
    const p = store.create(U1, { name: 'Kandidat Lokal', type: 'op' });
    const self = store.create(U1, { name: 'Kandidat Diri', type: 'op' });
    const list = store.picCandidates(U1, [{ entity_id: 'h9', entity_name: 'Kandidat Hub', npwp: '' }], self.id);
    assert.deepStrictEqual(list.map((x) => x.source + ':' + x.name), ['hub:Kandidat Hub', 'local:Kandidat Lokal']);
    store.remove(U1, p.id); store.remove(U1, self.id);
});

test('Data bertahan di berkas dan berkas rusak tidak membuat aplikasi gagal', () => {
    const p = store.create(U1, { name: 'Bertahan', type: 'op' });
    const f = path.join(process.env.TAXIO_PILOT_DATA_DIR, 'local-entities.json');
    assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).byUser[U1].some((e) => e.id === p.id));
    fs.writeFileSync(f, '{ bukan json');
    assert.deepStrictEqual(store.listFor(U1), []);
    fs.writeFileSync(f, JSON.stringify({ version: 1, byUser: {} }));
});

console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
