/* Daftar Group untuk org Natasha harus sama dengan Taxio Hub (isNatashaGroupEntity): hanya entitas bergrup
 * ENA / TOS / SASA / Natasha. Entitas TANPA grup (mis. klien pribadi staf yang belum ditandai) tidak boleh tampil
 * di Group semua orang. Org lain tidak disaring per grup. Data di sini rekaan. */
const assert = require('assert');
const entitiesLib = require('../lib/entities');

const NATASHA = '66850a55-837c-4d12-b772-25a21a0ffa60';

function fakeClient(tables) {
    return {
        from(table) {
            const result = { data: tables[table] === undefined ? null : tables[table], error: null };
            const chain = {
                select: () => chain, eq: () => chain, limit: () => chain,
                maybeSingle: () => Promise.resolve(result),
                then: (ok, fail) => Promise.resolve(result).then(ok, fail)
            };
            return chain;
        }
    };
}

const ENTITIES = [
    { entity_id: 'AAA', entity_name: 'PT Contoh Ena', group: 'ENA' },
    { entity_id: 'BBB', entity_name: 'PT Contoh Tos', group: 'Tos Group' },
    { entity_id: 'CCC', entity_name: 'Klien Pribadi Tanpa Grup', group: '' },
    { entity_id: 'DDD', entity_name: 'Klien Tanpa Kolom Grup' },
    { entity_id: 'EEE', entity_name: 'PT Grup Lain', group: 'IIP' },
    { entity_id: 'FFF', entity_name: 'Klien Personal Bertanda', group: 'ENA', personal_source: true },
    { entity_id: 'GGG', entity_name: 'PT Eksternal', group: 'External' }
];
const tables = (orgEntities) => ({
    coretax_pics: [{ pic_id: 'p1', pic_name: 'PIC CONTOH', username_last4: '0000' }],
    entity_coretax_pic_links: orgEntities.map((e) => ({ entity_id: e.entity_id, pic_id: 'p1', is_primary: true })),
    app_data: { data: { current: '2026', years: { 2026: { entities: orgEntities } } } },
    memberships: { role: 'admin', initial: 'ZZ', display_name: 'Pengguna Contoh' },
    personal_data: null
});

(async () => {
    const natasha = await entitiesLib.listAutomatableEntities(fakeClient(tables(ENTITIES)), NATASHA, 'u1', false, 'group');
    assert.deepStrictEqual(natasha.map((e) => e.entity_id).sort(), ['AAA', 'BBB'],
        'org Natasha, mode Group: hanya entitas bergrup resmi; grup kosong, grup lain, personal dan eksternal tidak tampil');

    const other = await entitiesLib.listAutomatableEntities(fakeClient(tables(ENTITIES)), 'org-lain-0000', 'u1', false, 'group');
    assert.deepStrictEqual(other.map((e) => e.entity_id).sort(), ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'],
        'org lain: tidak disaring per grup (hanya personal dan eksternal yang disembunyikan)');

    console.log('PASS: daftar Group org Natasha menyembunyikan entitas tanpa grup; org lain tidak berubah.');
})().catch((e) => { console.error(e); process.exit(1); });
