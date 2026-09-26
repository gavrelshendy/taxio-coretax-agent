/* Taxio Pilot - entitas yang ditambahkan sendiri di komputer ini (tab "Saya"), untuk klien yang
   belum ada di Taxio Hub. Disimpan lokal per akun Taxio (kunci = id pengguna), tidak menulis
   apa pun ke Taxio Hub dan TIDAK menyimpan kredensial Coretax: login selalu manual.

   Aturan Coretax yang dibawa ke sini: akun Badan hanya bisa dibuka lewat akun Orang Pribadi
   milik PIC-nya (impersonate), jadi entitas Badan wajib menautkan >= 1 PIC. PIC adalah entitas
   Orang Pribadi - dari Taxio Hub (source 'hub') atau yang juga ditambahkan di sini (source
   'local'). Orang Pribadi login dengan akunnya sendiri, tidak butuh PIC. */
const path = require('path');
const crypto = require('crypto');
const { dataDir, readJson, writeJsonAtomic } = require('./data-dir');

const NAME_MAX = 100;
const PIC_MAX = 5;

function file() { return path.join(dataDir(), 'local-entities.json'); }
function loadAll() {
    const d = readJson(file(), null);
    return d && d.byUser ? d : { version: 1, byUser: {} };
}
function saveAll(d) { writeJsonAtomic(file(), d); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function normalizeNpwp(v) { return String(v || '').replace(/[^\d]/g, ''); }
function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function listFor(userId) {
    return clone(loadAll().byUser[String(userId)] || []);
}

/** Entitas mana saja (id lokal) yang memakai `id` sebagai PIC. */
function dependentsOf(list, id) {
    return list.filter((e) => (e.pics || []).some((p) => p.source === 'local' && p.id === id));
}

/** Memeriksa dan merapikan input. `ctx.hubPicIds` (Set) bila diberikan membatasi PIC dari Hub
 *  ke entitas Orang Pribadi yang memang bisa dilihat akun ini. Melempar Error berbahasa Indonesia. */
function buildRecord(list, input, ctx, selfId) {
    const name = cleanName(input && input.name);
    if (!name) throw new Error('Nama entitas wajib diisi.');
    if (name.length > NAME_MAX) throw new Error('Nama entitas maksimal ' + NAME_MAX + ' karakter.');
    if (list.some((e) => e.id !== selfId && e.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Entitas dengan nama "' + name + '" sudah ada.');
    }
    const type = input && input.type;
    if (type !== 'badan' && type !== 'op') throw new Error('Jenis wajib pajak harus Badan atau Orang Pribadi.');

    const npwp = normalizeNpwp(input.npwp);
    if (npwp && npwp.length !== 15 && npwp.length !== 16) throw new Error('NPWP harus 15 atau 16 digit.');

    let pics = [];
    if (type === 'badan') {
        const seen = new Set();
        for (const raw of (input.pics || [])) {
            const source = raw && raw.source;
            const id = String((raw && raw.id) || '');
            if ((source !== 'local' && source !== 'hub') || !id) throw new Error('Data PIC tidak valid.');
            const key = source + ':' + id;
            if (seen.has(key)) continue;
            seen.add(key);
            if (source === 'local') {
                const target = list.find((e) => e.id === id);
                if (!target || target.type !== 'op' || id === selfId) throw new Error('PIC yang dipilih tidak ditemukan sebagai entitas Orang Pribadi.');
                pics.push({ source, id, name: target.name });
            } else {
                if (ctx && ctx.hubPicIds && !ctx.hubPicIds.has(id)) throw new Error('PIC dari Taxio Hub yang dipilih tidak ditemukan atau bukan Orang Pribadi.');
                const picName = cleanName(raw.name);
                if (!picName) throw new Error('Nama PIC wajib ada.');
                pics.push({ source, id, name: picName });
            }
        }
        if (!pics.length) throw new Error('Entitas Badan wajib menautkan minimal satu PIC (akun Orang Pribadi) untuk impersonate.');
        if (pics.length > PIC_MAX) throw new Error('Maksimal ' + PIC_MAX + ' PIC per entitas.');
    }
    return { name, npwp, type, pics };
}

function create(userId, input, ctx) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    const rec = buildRecord(list, input, ctx, null);
    const now = new Date().toISOString();
    const full = Object.assign({ id: 'le_' + crypto.randomBytes(6).toString('hex') }, rec, { createdAt: now, updatedAt: now });
    all.byUser[key] = list.concat(full);
    saveAll(all);
    return clone(full);
}

function update(userId, id, input, ctx) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    const current = list.find((e) => e.id === id);
    if (!current) throw new Error('Entitas tidak ditemukan.');
    const rec = buildRecord(list, input, ctx, id);
    if (current.type === 'op' && rec.type === 'badan') {
        const deps = dependentsOf(list, id);
        if (deps.length) throw new Error('Tidak bisa diubah menjadi Badan: dipakai sebagai PIC oleh ' + deps.map((d) => d.name).join(', ') + '.');
    }
    const next = Object.assign({}, current, rec, { updatedAt: new Date().toISOString() });
    // Nama PIC yang berubah harus ikut ke entitas Badan yang menautkannya.
    all.byUser[key] = list.map((e) => {
        if (e.id === id) return next;
        if (!(e.pics || []).some((p) => p.source === 'local' && p.id === id)) return e;
        return Object.assign({}, e, { pics: e.pics.map((p) => (p.source === 'local' && p.id === id ? Object.assign({}, p, { name: next.name }) : p)) });
    });
    saveAll(all);
    return clone(next);
}

function remove(userId, id) {
    const all = loadAll();
    const key = String(userId);
    const list = all.byUser[key] || [];
    if (!list.some((e) => e.id === id)) throw new Error('Entitas tidak ditemukan.');
    const deps = dependentsOf(list, id);
    if (deps.length) throw new Error('Tidak bisa dihapus: masih dipakai sebagai PIC oleh ' + deps.map((d) => d.name).join(', ') + '.');
    all.byUser[key] = list.filter((e) => e.id !== id);
    saveAll(all);
    return true;
}

/** Bentuk yang dipakai dashboard dan handler otomasi (sama dengan baris entitas Taxio Hub,
 *  ditambah `project: 'local'` yang membuat handler memakai sesi login manual). */
function toEntity(rec) {
    const pics = (rec.pics || []).map((p, i) => ({ pic_id: p.source + ':' + p.id, pic_name: p.name, pic_is_mine: true, is_primary: i === 0, source: p.source }));
    return {
        entity_id: 'local:' + rec.id, entity_name: rec.name, npwp: rec.npwp || '', individual: rec.type === 'op', type: rec.type,
        pic_id: 'manual', pic_name: pics.length ? pics[0].pic_name : '', pic_is_mine: true, is_primary: true,
        pics, linked: true, project: 'local', project_label: 'Manual', local_id: rec.id
    };
}

/** Mengambil satu entitas lokal milik pengguna ini sebagai bentuk `toEntity`, atau null. */
function getEntity(userId, localId) {
    const rec = listFor(userId).find((e) => e.id === localId);
    return rec ? toEntity(rec) : null;
}

/** Kandidat PIC: entitas Orang Pribadi lokal + entitas Orang Pribadi dari Taxio Hub (diberikan
 *  pemanggil). Entitas yang sedang diedit tidak boleh menjadi PIC dirinya sendiri. */
function picCandidates(userId, hubPersons, excludeLocalId) {
    const locals = listFor(userId).filter((e) => e.type === 'op' && e.id !== excludeLocalId)
        .map((e) => ({ source: 'local', id: e.id, name: e.name, npwp: e.npwp }));
    const hubs = (hubPersons || []).map((h) => ({ source: 'hub', id: h.entity_id, name: h.entity_name, npwp: h.npwp || '' }));
    return hubs.concat(locals);
}

module.exports = { listFor, create, update, remove, toEntity, getEntity, picCandidates, normalizeNpwp, NAME_MAX, PIC_MAX };
