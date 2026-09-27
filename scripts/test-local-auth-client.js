/* Tes lib/local-auth-client.js: memastikan lib/entities.js (getCredential/getPassphrase/
   getOtherLinkedPicIds) - kode yang SAMA dipakai untuk PIC Taxio Hub - bekerja tanpa perubahan
   sedikit pun lewat "klien Supabase palsu" ini untuk entitas lokal. Jalankan:
     node scripts/test-local-auth-client.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-test-'));
const store = require('../lib/local-entities');
const localAuth = require('../lib/local-auth-client');
const entitiesLib = require('../lib/entities');

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
console.log('local-auth-client');

const U1 = 'user-1';
const ani = store.create(U1, { name: 'Ani Sample Wijaya', type: 'op', npwp: '1234567890123456', password: 'rahasiaAni', passphrase: 'frasaAni' });
const cv = store.create(U1, {
    name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '0678901234560000',
    pics: [
        { name: 'PIC Utama', npwp: '1111222233334444', password: 'sandiUtama', passphrase: 'frasaUtama' },
        { name: 'PIC Kedua', npwp: '5555666677778888', password: 'sandiKedua' }
    ]
});
const client = localAuth.client(U1);
const opPicId = localAuth.buildPicId(ani.id, 'op');
const picUtamaId = localAuth.buildPicId(cv.id, cv.pics[0].id);
const picKeduaId = localAuth.buildPicId(cv.id, cv.pics[1].id);

(async () => {
    await test('getCredential (lib/entities.js asli): OP -> username = NPWP sendiri', async () => {
        const cred = await entitiesLib.getCredential(client, localAuth.ORG_ID, opPicId);
        assert.deepStrictEqual(cred, { username: '1234567890123456', password: 'rahasiaAni', pic_name: 'Ani Sample Wijaya' });
    });
    await test('getPassphrase (lib/entities.js asli): OP', async () => {
        assert.strictEqual(await entitiesLib.getPassphrase(client, localAuth.ORG_ID, opPicId), 'frasaAni');
    });
    await test('getCredential: Badan PIC pertama dan kedua berbeda', async () => {
        const c1 = await entitiesLib.getCredential(client, localAuth.ORG_ID, picUtamaId);
        assert.strictEqual(c1.username, '1111222233334444'); assert.strictEqual(c1.password, 'sandiUtama');
        const c2 = await entitiesLib.getCredential(client, localAuth.ORG_ID, picKeduaId);
        assert.strictEqual(c2.username, '5555666677778888');
    });
    await test('getPassphrase: PIC tanpa passphrase -> null, bukan galat', async () => {
        assert.strictEqual(await entitiesLib.getPassphrase(client, localAuth.ORG_ID, picKeduaId), null);
    });
    await test('getCredential: picId tak dikenal -> melempar galat kredensial belum lengkap (perilaku asli lib/entities.js)', async () => {
        const badPicId = localAuth.buildPicId(cv.id, 'lp_tidakada');
        await assert.rejects(() => entitiesLib.getCredential(client, localAuth.ORG_ID, badPicId), /[Kk]redensial/);
    });
    await test('getOtherLinkedPicIds (lib/entities.js asli): PIC lain di entitas Badan yang sama, tidak termasuk yang dikecualikan', async () => {
        const others = await entitiesLib.getOtherLinkedPicIds(client, localAuth.ORG_ID, 'local:' + cv.id, picUtamaId);
        assert.deepStrictEqual(others, [picKeduaId]);
    });
    await test('getOtherLinkedPicIds: Orang Pribadi tidak punya PIC lain', async () => {
        const others = await entitiesLib.getOtherLinkedPicIds(client, localAuth.ORG_ID, 'local:' + ani.id, opPicId);
        assert.deepStrictEqual(others, []);
    });
    await test('resolveEntity: bentuk entity untuk dipakai automation/*.js', async () => {
        const e = localAuth.resolveEntity(U1, cv.id, cv.pics[0].id);
        assert.deepStrictEqual(e, { entity_id: 'local:' + cv.id, entity_name: 'CV Klien Baru Sejahtera', npwp: '0678901234560000', individual: false });
    });
    await test('parsePicId menolak format asing (picId Hub berupa UUID polos)', async () => {
        assert.strictEqual(localAuth.parsePicId('c2b1a3f0-1234-4abc-9def-000000000000'), null);
    });

    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
    fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
})();
