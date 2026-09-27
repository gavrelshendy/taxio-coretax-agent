/* Tes penyimpanan entitas lokal (lib/local-entities.js) versi kredensial: NPWP 16 digit wajib,
   OP login dengan akunnya sendiri, Badan wajib >=1 PIC dengan kredensial sendiri, kata sandi
   yang dikosongkan saat edit tidak menghapus yang tersimpan, dan kredensial tidak pernah bocor
   lewat toEntity(). Memakai folder data sementara. Jalankan:
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
const noSecrets = (obj) => { const s = JSON.stringify(obj); assert.ok(!/rahasia123|sandiPIC|frasa-op|frasa-pic/.test(s), 'bocor: ' + s); };

console.log('local-entities');
const U1 = 'user-1'; const U2 = 'user-2';

test('Orang Pribadi: NPWP 16 digit dan kata sandi wajib, passphrase opsional', () => {
    throwsMsg(() => store.create(U1, { name: 'Budi', type: 'op', npwp: '123', password: 'x' }), /16 digit/);
    throwsMsg(() => store.create(U1, { name: 'Budi', type: 'op', npwp: '1234567890123456' }), /Kata sandi wajib diisi/);
    const rec = store.create(U1, { name: '  Ani   Sample  Wijaya ', type: 'op', npwp: '1234-5678-9012-3456', password: 'rahasia123' });
    assert.strictEqual(rec.name, 'Ani Sample Wijaya');
    assert.strictEqual(rec.npwp, '1234567890123456'); // strip dibuang, tetap 16 digit
    assert.strictEqual(rec.npwp.length, 16);
    assert.strictEqual(rec.credential.password, 'rahasia123');
    assert.strictEqual(rec.credential.passphrase, '');
});

test('NPWP 15 digit (format lama) ditolak', () => {
    throwsMsg(() => store.create(U1, { name: 'Lima Belas', type: 'op', npwp: '123456789012345', password: 'x' }), /16 digit/);
});

test('toEntity: tidak pernah membawa kata sandi/passphrase', () => {
    const list = store.listEntitiesFor(U1);
    const ani = list.find((e) => e.entity_name === 'Ani Sample Wijaya');
    assert.strictEqual(ani.project, 'local');
    assert.strictEqual(ani.individual, true);
    assert.strictEqual(ani.pic_id, 'op');
    assert.deepStrictEqual(ani.pics, []);
    noSecrets(ani);
    noSecrets(store.getEntity(U1, ani.local_id));
});

test('Badan wajib menautkan minimal satu PIC dengan kredensial lengkap', () => {
    throwsMsg(() => store.create(U1, { name: 'CV Tanpa PIC', type: 'badan', npwp: '1234567890123456', pics: [] }), /wajib menautkan minimal satu PIC/);
    throwsMsg(() => store.create(U1, { name: 'CV PIC Salah', type: 'badan', npwp: '1234567890123456', pics: [{ name: 'X', npwp: '123' }] }), /16 digit/);
    throwsMsg(() => store.create(U1, { name: 'CV Tanpa Sandi', type: 'badan', npwp: '1234567890123456', pics: [{ name: 'X', npwp: '9999888877776666' }] }), /Kata sandi PIC "X" wajib diisi/);
});

let cv;
test('Badan dengan 2 PIC tersimpan lengkap; NPWP badan beda dari NPWP PIC', () => {
    cv = store.create(U1, {
        name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '0678901234560000',
        pics: [
            { name: 'Ani Sample Wijaya', npwp: '1111222233334444', password: 'sandiPIC1', passphrase: 'frasa-pic-1' },
            { name: 'Budi Kedua', npwp: '5555666677778888', password: 'sandiPIC2' }
        ]
    });
    assert.strictEqual(cv.pics.length, 2);
    assert.strictEqual(cv.pics[0].password, 'sandiPIC1');
    assert.strictEqual(cv.pics[1].passphrase, '');
    assert.ok(cv.pics[0].id && cv.pics[1].id && cv.pics[0].id !== cv.pics[1].id);
});

test('PIC dengan NPWP sama dua kali di entitas yang sama ditolak', () => {
    throwsMsg(() => store.create(U1, { name: 'CV Dobel', type: 'badan', npwp: '1234567890120000', pics: [{ name: 'A', npwp: '1111222233334444', password: 'x' }, { name: 'B', npwp: '1111222233334444', password: 'y' }] }), /dipakai dua kali/);
});

test('Maksimal 5 PIC', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: 'PIC ' + i, npwp: String(1000000000000000 + i), password: 'x' }));
    throwsMsg(() => store.create(U1, { name: 'CV Banyak PIC', type: 'badan', npwp: '1234567890129999', pics: many }), /Maksimal 5 PIC/);
});

test('toEntity Badan: pic_id = id PIC asli, PIC pertama jadi utama, tanpa kredensial', () => {
    const eCv = store.getEntity(U1, cv.id);
    assert.strictEqual(eCv.individual, false);
    assert.strictEqual(eCv.pic_id, cv.pics[0].id);
    assert.deepStrictEqual(eCv.pics.map((p) => p.pic_name), ['Ani Sample Wijaya', 'Budi Kedua']);
    assert.strictEqual(eCv.pics[0].is_primary, true);
    noSecrets(eCv);
});

test('resolveLogin (internal): OP memakai NPWP sendiri sebagai username', () => {
    const ani = store.listEntitiesFor(U1).find((e) => e.entity_name === 'Ani Sample Wijaya');
    const r = store.resolveLogin(U1, ani.local_id, 'op');
    assert.deepStrictEqual(r.cred, { username: '1234567890123456', password: 'rahasia123', pic_name: 'Ani Sample Wijaya' });
    assert.strictEqual(r.entity.individual, true);
    assert.strictEqual(r.entity.entity_id, 'local:' + ani.local_id);
});

test('resolveLogin: Badan memakai kredensial PIC yang dipilih, entity tetap NPWP badan', () => {
    const r1 = store.resolveLogin(U1, cv.id, cv.pics[0].id);
    assert.strictEqual(r1.cred.username, '1111222233334444');
    assert.strictEqual(r1.cred.password, 'sandiPIC1');
    assert.strictEqual(r1.passphrase, 'frasa-pic-1');
    assert.strictEqual(r1.entity.npwp, '0678901234560000');
    assert.strictEqual(r1.entity.individual, false);
    const r2 = store.resolveLogin(U1, cv.id, cv.pics[1].id);
    assert.strictEqual(r2.cred.username, '5555666677778888');
    assert.strictEqual(r2.passphrase, null);
});

test('resolveLogin: referensi salah/tidak ada -> null, bukan galat', () => {
    assert.strictEqual(store.resolveLogin(U1, 'le_tidakada', 'op'), null);
    assert.strictEqual(store.resolveLogin(U1, cv.id, 'lp_tidakada'), null);
    const ani = store.listEntitiesFor(U1).find((e) => e.entity_name === 'Ani Sample Wijaya');
    assert.strictEqual(store.resolveLogin(U1, ani.local_id, 'lp_bukan_op'), null, 'OP hanya boleh diakses dengan picRef op');
});

test('otherPicRefs: PIC lain di entitas yang sama, kosong untuk OP', () => {
    assert.deepStrictEqual(store.otherPicRefs(U1, cv.id, cv.pics[0].id).sort(), [cv.pics[1].id]);
    const ani = store.listEntitiesFor(U1).find((e) => e.entity_name === 'Ani Sample Wijaya');
    assert.deepStrictEqual(store.otherPicRefs(U1, ani.local_id, 'op'), []);
});

test('update: kata sandi/passphrase dikosongkan di form = tetap yang lama; NPWP boleh diganti', () => {
    const updated = store.update(U1, cv.id, {
        name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '0678901234560001',
        pics: [
            { id: cv.pics[0].id, name: 'Ani Sample Wijaya', npwp: '1111222233334444' }, // password kosong = tetap
            { id: cv.pics[1].id, name: 'Budi Kedua Updated', npwp: '5555666677778888', password: 'sandiBaru' }
        ]
    });
    assert.strictEqual(updated.npwp, '0678901234560001');
    assert.strictEqual(updated.pics[0].password, 'sandiPIC1', 'password lama dipertahankan');
    assert.strictEqual(updated.pics[0].passphrase, 'frasa-pic-1');
    assert.strictEqual(updated.pics[1].password, 'sandiBaru');
    assert.strictEqual(updated.pics[1].name, 'Budi Kedua Updated');
    cv = updated;
});

test('update: PIC baru ditambahkan (tanpa id) tetap wajib kata sandi', () => {
    throwsMsg(() => store.update(U1, cv.id, { name: cv.name, type: 'badan', npwp: cv.npwp, pics: cv.pics.concat({ name: 'PIC Baru', npwp: '7777888899990000' }) }), /Kata sandi PIC "PIC Baru" wajib diisi/);
});

test('update: entitas tidak ada -> galat', () => {
    throwsMsg(() => store.update(U1, 'le_tidakada', { name: 'X', type: 'op', npwp: '1234567890123456', password: 'x' }), /tidak ditemukan/);
});

test('update: ubah Badan jadi Orang Pribadi menghapus daftar PIC', () => {
    const asOp = store.update(U1, cv.id, { name: cv.name, type: 'op', npwp: cv.npwp, password: 'sandiBadanJadiOp' });
    assert.strictEqual(asOp.type, 'op');
    assert.strictEqual(store.getEntity(U1, cv.id).pics.length, 0);
    // kembalikan ke Badan untuk tes berikutnya
    cv = store.update(U1, cv.id, { name: cv.name, type: 'badan', npwp: cv.npwp, pics: [{ name: 'Ani Sample Wijaya', npwp: '1111222233334444', password: 'sandiPIC1' }] });
});

test('remove: entitas terhapus, kredensialnya ikut hilang', () => {
    const id = cv.id;
    assert.strictEqual(store.remove(U1, id), true);
    assert.strictEqual(store.getEntity(U1, id), null);
    throwsMsg(() => store.remove(U1, id), /tidak ditemukan/);
});

test('Nama unik per akun, boleh sama di akun lain; data terisolasi per akun', () => {
    throwsMsg(() => store.create(U1, { name: 'ani sample wijaya', type: 'op', npwp: '9999999999999999', password: 'x' }), /sudah ada/);
    const other = store.create(U2, { name: 'Ani Sample Wijaya', type: 'op', npwp: '1234567890123456', password: 'lain' });
    assert.strictEqual(store.listFor(U2).length, 1);
    assert.ok(store.listFor(U1).length >= 1);
    assert.strictEqual(store.resolveLogin(U2, other.id, 'op').cred.password, 'lain');
});

test('Data bertahan di berkas (tanpa kredensial di toEntity), berkas rusak tidak menjatuhkan aplikasi', () => {
    const f = require('path').join(process.env.TAXIO_PILOT_DATA_DIR, 'local-entities.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(JSON.stringify(raw).includes('rahasia123'), 'kredensial memang tersimpan mentah di berkas (seperti session-store.js)');
    fs.writeFileSync(f, '{ bukan json');
    assert.deepStrictEqual(store.listFor(U1), []);
    fs.writeFileSync(f, JSON.stringify(raw));
});

console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
