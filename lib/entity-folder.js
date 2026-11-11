/* Nama folder (dan kode di nama file) satu entitas di disk.
   Kode Taxio Hub ("PNG", "BKA") dipakai apa adanya. Entitas lokal (tab "Saya") ber-id internal
   "local:le_xxxx" - titik dua tidak sah di nama folder Windows (mkdir gagal ENOENT), jadi foldernya
   memakai nama entitas (unik per pengguna). Karakter yang dilarang Windows diganti. */
const BAD = /[\\/:*?"<>|\x00-\x1f]/g;

function clean(s) {
    return String(s || '').replace(BAD, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60).trim();
}

function folderCode(entity) {
    const id = String((entity && entity.entity_id) || '');
    if (id.startsWith('local:')) return clean(entity && entity.entity_name) || clean(id.slice(6)) || 'Lokal';
    return clean(id) || id;
}

module.exports = { folderCode };
