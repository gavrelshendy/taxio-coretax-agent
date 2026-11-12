/* Taxio Pilot - batas sesi paralel (Pengaturan > "Parallel sessions").
 *
 *   perPic  jendela Chrome otomasi per PIC (bawaan 3). Satu PIC boleh punya beberapa jendela, masing-masing
 *           dengan folder profilnya sendiri ("<pic>", "<pic>~2", "<pic>~3"): Coretax mengizinkan akun yang sama
 *           login dari beberapa browser sekaligus (dikonfirmasi pemilik).
 *   total   jendela otomasi yang BERJALAN bersamaan untuk semua PIC (bawaan 6). Jendela yang menganggur tidak
 *           dihitung (tetap terbuka seperti biasa sampai ditutup), jadi batas ini tidak pernah membuat antrean
 *           macet karena jendela PIC lain yang sedang diam. Sesi manual (satu jendela) tidak termasuk.
 *
 * Permintaan yang tidak mendapat jendela masuk antrean (lib/runcontrol.js), bukan ditolak. Disimpan di
 * <data>\parallel-sessions.json; dibaca ulang hanya saat diubah lewat set(). */
const path = require('path');
const { dataDir, readJson, writeJsonAtomic } = require('./data-dir');

const DEFAULTS = Object.freeze({ perPic: 3, total: 6 });
const RANGE = Object.freeze({ perPic: [1, 5], total: [1, 12] });

let _cache = null;
function file() { return path.join(dataDir(), 'parallel-sessions.json'); }

function clamp(name, v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return DEFAULTS[name];
    return Math.min(RANGE[name][1], Math.max(RANGE[name][0], n));
}
function normalize(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return { perPic: clamp('perPic', o.perPic != null ? o.perPic : DEFAULTS.perPic), total: clamp('total', o.total != null ? o.total : DEFAULTS.total) };
}

/** { perPic, total } yang berlaku sekarang. */
function get() {
    if (!_cache) _cache = normalize(readJson(file(), null));
    return Object.assign({}, _cache);
}

/** Menyimpan batas baru (nilai di luar rentang dibatasi ke rentangnya; yang tidak disebut tetap). Melempar
 *  bila bukan angka. Mengembalikan batas yang berlaku. */
function set(patch) {
    const cur = get();
    for (const k of Object.keys(DEFAULTS)) {
        if (patch && patch[k] != null && !Number.isFinite(Number(patch[k]))) throw new Error('Batas sesi paralel harus berupa angka.');
    }
    const next = normalize(Object.assign({}, cur, patch || {}));
    writeJsonAtomic(file(), next);
    _cache = next;
    return Object.assign({}, next);
}

/** Hanya untuk tes: lupakan cache (mis. sesudah TAXIO_PILOT_DATA_DIR diganti) atau pasang nilai tanpa menulis. */
function _reset(value) { _cache = value ? normalize(value) : null; }

module.exports = { get, set, DEFAULTS, RANGE, _reset };
