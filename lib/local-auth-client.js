/* Taxio Pilot - klien "Supabase palsu" untuk entitas lokal (tab Saya), supaya lib/entities.js
   (getCredential/getPassphrase/getOtherLinkedPicIds) dan seluruh automation/*.js yang sudah
   dipakai untuk entitas Taxio Hub bisa dipakai TANPA PERUBAHAN untuk entitas lokal juga - satu-
   satunya beda adalah dari mana kredensialnya diambil. `orgId` untuk entitas lokal selalu
   'local' (nilai boneka, tidak dipakai untuk apa pun selain diteruskan balik ke RPC di bawah).

   picId yang dipakai kode pemanggil (server.js, automation/*.js) untuk entitas lokal berbentuk
   "local:<idEntitas>:<refPic>" - satu string, unik lintas entitas maupun akun (lihat
   lib/chrome.js: dipakai sebagai nama folder profil Chrome & kunci cache context, jadi harus
   unik selamanya, bukan cuma untuk satu proses). refPic adalah 'op' (Orang Pribadi login dengan
   akunnya sendiri) atau id PIC Badan (mis. 'lp_xxxx') - lihat lib/local-entities.js. */
const localEntities = require('./local-entities');

const PIC_ID_RE = /^local:([^:]+):(.+)$/;

/** "local:le_abc123:op" -> { localId: 'le_abc123', picRef: 'op' }, atau null kalau bukan
 *  picId entitas lokal (dipakai untuk membedakan dari picId Hub, yang selalu UUID polos). */
function parsePicId(picId) {
    const m = PIC_ID_RE.exec(String(picId || ''));
    return m ? { localId: m[1], picRef: m[2] } : null;
}
function buildPicId(localId, picRef) { return 'local:' + localId + ':' + picRef; }

/** Sesuai bentuk baris `get_coretax_pic_credential_for_automation` yang diharapkan
 *  lib/entities.js getCredential: array berisi satu baris { username, password, pic_name }. */
function client(userId) {
    return {
        rpc(name, args) {
            const parsed = parsePicId(args && args.p_pic_id);
            if (!parsed) return Promise.resolve({ data: null, error: { message: 'picId lokal tidak valid.' } });
            const resolved = localEntities.resolveLogin(userId, parsed.localId, parsed.picRef);
            if (name === 'get_coretax_pic_credential_for_automation') {
                return Promise.resolve({ data: resolved ? [resolved.cred] : [], error: null });
            }
            if (name === 'get_coretax_pic_passphrase') {
                return Promise.resolve({ data: resolved && resolved.passphrase ? resolved.passphrase : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
        },
        // Dipakai lib/entities.js getOtherLinkedPicIds(client, orgId, entityId, excludePicId):
        // .from('entity_coretax_pic_links').select('pic_id, is_primary').eq('org_id', orgId).eq('entity_id', entityId)
        from(table) {
            if (table !== 'entity_coretax_pic_links') return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) };
            return {
                select: () => ({
                    eq: () => ({
                        eq: (col, entityId) => {
                            const localId = String(entityId || '').replace(/^local:/, '');
                            const refs = localEntities.otherPicRefs(userId, localId, null);
                            return Promise.resolve({ data: refs.map((r) => ({ pic_id: buildPicId(localId, r), is_primary: false })), error: null });
                        }
                    })
                })
            };
        }
    };
}

/** Entitas Coretax yang menjadi target login. `entity.entity_id` mentah dari client sudah
 *  "local:<id>" (lihat toEntity()); dipakai apa adanya oleh automation/*.js sebagai nama folder
 *  hasil unduhan, jadi TIDAK diubah di sini. */
function resolveEntity(userId, localId, picRef) {
    const resolved = localEntities.resolveLogin(userId, localId, picRef);
    return resolved ? resolved.entity : null;
}

module.exports = { client, parsePicId, buildPicId, resolveEntity, ORG_ID: 'local' };
