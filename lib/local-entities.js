/* Taxio Pilot - entitas yang ditambahkan sendiri di komputer ini (tab "Saya"), untuk klien yang
   belum ada di Taxio Hub. Disimpan lokal per akun Taxio (kunci = id pengguna).

   BEDA dari versi sebelumnya (yang cuma menyimpan nama+NPWP dan selalu login manual): entitas
   di sini sekarang menyimpan kredensial Coretax ASLI (NIK/NPWP + kata sandi + passphrase),
   persis seperti yang disimpan Taxio Hub untuk PIC-nya - jadi bisa login OTOMATIS lewat mesin
   automasi yang sama (lib/local-auth-client.js menyamar sebagai klien Supabase di depan
   lib/entities.js getCredential/getPassphrase, supaya seluruh automation/* tidak perlu tahu
   sumber kredensialnya Hub atau lokal).

   Aturan Coretax yang dibawa ke sini: akun Badan hanya bisa dibuka lewat akun Orang Pribadi
   penanggung jawabnya (PIC), login-nya beda dari akun badan itu sendiri. Jadi:
   - Orang Pribadi: login dengan NPWP/NIK miliknya sendiri (npwp milik entitas = username login).
   - Badan: entitas hanya punya NPWP (target impersonate), PIC-nya (>=1, boleh lebih dari satu)
     masing-masing punya kredensial login sendiri (nama, NPWP, kata sandi, passphrase).

   NPWP: sejak integrasi NIK 2024, format resminya 16 digit tanpa titik/strip (dikonfirmasi dari
   Taxio Hub sendiri, lihat entities.js-nya: "16 digit, no dots") - bukan format lama 15 digit
   yang pakai titik dan strip. Divalidasi persis 16 digit di sini.

   Kredensial disimpan apa adanya (tidak dienkripsi) di file JSON milik pengguna ini saja, sama
   seperti session-store.js sudah menyimpan token Supabase - lihat komentar file itu untuk alasan
   kenapa itu diterima di aplikasi ini: satu-satunya yang bisa membacanya adalah pengguna Windows
   yang sama di komputer yang sama. Kredensial TIDAK PERNAH dikirim ke API GET mana pun - hanya
   dibaca lewat resolveLogin() di sisi server saat automasi benar-benar akan login. */
const path = require('path');
const crypto = require('crypto');
const { dataDir, readJson, writeJsonAtomic } = require('./data-dir');

const NAME_MAX = 100;
const PIC_MAX = 5;
const NPWP_RE = /^\d{16}$/;

function file() { return path.join(dataDir(), 'local-entities.json'); }
function loadAll() {
    const d = readJson(file(), null);
    return d && d.byUser ? d : { version: 2, byUser: {} };
}
function saveAll(d) { writeJsonAtomic(file(), d); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

function normalizeNpwp(v) { return String(v || '').replace(/[^\d]/g, ''); }
function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function cleanPass(v) { return String(v == null ? '' : v); } // kata sandi/passphrase: jangan trim spasi tepi tanpa alasan, tapi tetap string

function listFor(userId) { return clone(loadAll().byUser[String(userId)] || []); }
function rawListFor(userId) { return loadAll().byUser[String(userId)] || []; } // termasuk kredensial - hanya untuk pemakaian internal server

function requireNpwp(npwp, label) {
    const n = normalizeNpwp(npwp);
    if (!NPWP_RE.test(n)) throw new Error((label || 'NPWP') + ' harus 16 digit angka, tanpa titik atau strip.');
    return n;
}
function requireName(name, label) {
    const n = cleanName(name);
    if (!n) throw new Error((label || 'Nama') + ' wajib diisi.');
    if (n.length > NAME_MAX) throw new Error((label || 'Nama') + ' maksimal ' + NAME_MAX + ' karakter.');
    return n;
}

/** Validasi satu PIC dari input mentah. `existing`: PIC lama (saat update) supaya kata sandi/
 *  passphrase yang dikosongkan di form berarti "tidak diganti", bukan "dihapus" - form edit
 *  tidak pernah menampilkan kata sandi lama, jadi field kosong = pertahankan yang tersimpan. */
function buildPic(raw, existing) {
    const name = requireName(raw && raw.name, 'Nama PIC');
    const npwp = requireNpwp(raw && raw.npwp, 'NPWP PIC "' + name + '"');
    const rawPass = raw && raw.password;
    const password = rawPass ? cleanPass(rawPass) : (existing ? existing.password : '');
    if (!password) throw new Error('Kata sandi PIC "' + name + '" wajib diisi.');
    const rawPp = raw && raw.passphrase;
    const passphrase = rawPp !== undefined && rawPp !== '' ? cleanPass(rawPp) : (existing ? existing.passphrase || '' : '');
    return { id: (existing && existing.id) || newId('lp'), name, npwp, password, passphrase };
}

/** Membangun/merapikan satu record entitas dari input form. `existingList`: entitas lain milik
 *  user ini (untuk cek nama unik); `existingRec`: record lama saat update (untuk PIC id stabil
 *  dan kata sandi yang dikosongkan). Melempar Error berbahasa Indonesia. */
function buildRecord(existingList, input, existingRec) {
    const name = requireName(input && input.name, 'Nama entitas');
    if (existingList.some((e) => (!existingRec || e.id !== existingRec.id) && e.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Entitas dengan nama "' + name + '" sudah ada.');
    }
    const npwp = requireNpwp(input && input.npwp, 'NPWP entitas');
    const type = input && input.type;
    if (type !== 'op' && type !== 'badan') throw new Error('Jenis wajib pajak harus Badan atau Orang Pribadi.');

    if (type === 'op') {
        const existingCred = existingRec && existingRec.type === 'op' ? existingRec.credential : null;
        const rawPass = input && input.password;
        const password = rawPass ? cleanPass(rawPass) : (existingCred ? existingCred.password : '');
        if (!password) throw new Error('Kata sandi wajib diisi.');
        const rawPp = input && input.passphrase;
        const passphrase = rawPp !== undefined && rawPp !== '' ? cleanPass(rawPp) : (existingCred ? existingCred.passphrase || '' : '');
        return { name, npwp, type, credential: { password, passphrase } };
    }

    const rawPics = (input && input.pics) || [];
    if (!rawPics.length) throw new Error('Entitas Badan wajib menautkan minimal satu PIC (akun Orang Pribadi) untuk impersonate.');
    if (rawPics.length > PIC_MAX) throw new Error('Maksimal ' + PIC_MAX + ' PIC per entitas.');
    const existingPics = existingRec && existingRec.type === 'badan' ? existingRec.pics : [];
    const seenNpwp = new Set();
    const pics = rawPics.map((raw) => {
        const existing = raw && raw.id ? existingPics.find((p) => p.id === raw.id) : null;
        const pic = buildPic(raw, existing);
        if (seenNpwp.has(pic.npwp)) throw new Error('NPWP PIC "' + pic.name + '" dipakai dua kali di entitas yang sama.');
        seenNpwp.add(pic.npwp);
        return pic;
    });
    return { name, npwp, type, pics };
}

function create(userId, input) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    const rec = buildRecord(list, input, null);
    const now = new Date().toISOString();
    const full = Object.assign({ id: newId('le') }, rec, { createdAt: now, updatedAt: now });
    all.byUser[key] = list.concat(full);
    saveAll(all);
    return clone(full);
}

function update(userId, id, input) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    const current = list.find((e) => e.id === id);
    if (!current) throw new Error('Entitas tidak ditemukan.');
    const rec = buildRecord(list, input, current);
    const next = Object.assign({ id }, rec, { createdAt: current.createdAt, updatedAt: new Date().toISOString() });
    all.byUser[key] = list.map((e) => (e.id === id ? next : e));
    saveAll(all);
    return clone(next);
}

function remove(userId, id) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    if (!list.some((e) => e.id === id)) throw new Error('Entitas tidak ditemukan.');
    all.byUser[key] = list.filter((e) => e.id !== id);
    saveAll(all);
    return true;
}

/** Bentuk yang aman dikirim ke dashboard (tanpa kata sandi/passphrase): sama seperti baris
 *  entitas Taxio Hub yang sudah dikelompokkan (lib/entities.js groupEntityRows), supaya
 *  komponen daftar/pilih-PIC di sisi klien bisa dipakai ulang tanpa tahu sumbernya. `pic_id`
 *  di tiap PIC adalah id PIC itu sendiri; untuk Orang Pribadi, id "login" dikodekan sebagai
 *  "op" (resolveLogin() di bawah mengenalinya). */
function toEntity(rec) {
    if (rec.type === 'op') {
        return { entity_id: 'local:' + rec.id, entity_name: rec.name, npwp: rec.npwp, individual: true,
            pic_id: 'op', pic_name: rec.name, pic_is_mine: true, is_primary: true, pics: [],
            linked: true, project: 'local', project_label: 'Lokal', local_id: rec.id };
    }
    const pics = rec.pics.map((p, i) => ({ pic_id: p.id, pic_name: p.name, pic_npwp: p.npwp, pic_is_mine: true, is_primary: i === 0 }));
    return { entity_id: 'local:' + rec.id, entity_name: rec.name, npwp: rec.npwp, individual: false,
        pic_id: pics[0].pic_id, pic_name: pics[0].pic_name, pic_is_mine: true, is_primary: true, pics,
        linked: true, project: 'local', project_label: 'Lokal', local_id: rec.id };
}
function listEntitiesFor(userId) { return listFor(userId).map(toEntity); }

/** Mengambil satu entitas (bentuk aman) milik pengguna ini, atau null. */
function getEntity(userId, localId) {
    const rec = listFor(userId).find((e) => e.id === localId);
    return rec ? toEntity(rec) : null;
}

/** SISI SERVER SAJA - dipakai lib/local-auth-client.js untuk menjawab permintaan kredensial
 *  automasi. `picRef`: 'op' (entitas Orang Pribadi login dengan akunnya sendiri) atau id PIC
 *  Badan (mis. 'lp_xxxx'). Mengembalikan { cred: {username, password, pic_name}, passphrase,
 *  entity: {entity_id, entity_name, npwp, individual} }, atau null kalau tidak ditemukan/tidak
 *  lengkap - pemanggil (lib/local-auth-client.js) menerjemahkannya jadi galat yang sama seperti
 *  kredensial Hub yang belum lengkap. */
function resolveLogin(userId, localId, picRef) {
    const rec = rawListFor(userId).find((e) => e.id === localId);
    if (!rec) return null;
    const entity = { entity_id: 'local:' + rec.id, entity_name: rec.name, npwp: rec.npwp, individual: rec.type === 'op' };
    if (rec.type === 'op') {
        if (picRef !== 'op' || !rec.credential || !rec.credential.password) return null;
        return { cred: { username: rec.npwp, password: rec.credential.password, pic_name: rec.name }, passphrase: rec.credential.passphrase || null, entity };
    }
    const pic = (rec.pics || []).find((p) => p.id === picRef);
    if (!pic || !pic.password) return null;
    return { cred: { username: pic.npwp, password: pic.password, pic_name: pic.name }, passphrase: pic.passphrase || null, entity };
}

/** SISI SERVER SAJA - PIC lain di entitas Badan yang sama (untuk percobaan ulang SPT di bawah
 *  PIC lain saat gagal, sama seperti fallbackPicIds Taxio Hub). */
function otherPicRefs(userId, localId, excludePicRef) {
    const rec = rawListFor(userId).find((e) => e.id === localId);
    if (!rec || rec.type !== 'badan') return [];
    return (rec.pics || []).map((p) => p.id).filter((id) => id !== excludePicRef);
}

module.exports = {
    NAME_MAX, PIC_MAX, normalizeNpwp,
    listFor, listEntitiesFor, toEntity, getEntity, create, update, remove,
    resolveLogin, otherPicRefs
};
