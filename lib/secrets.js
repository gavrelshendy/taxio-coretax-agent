/* Rahasia tersimpan di disk (Tahap 2): token sesi Supabase (data\session.json) dan kata sandi / passphrase
 * Coretax entitas lokal (data\local-entities.json) dienkripsi lewat lib/shell.js encryptString/decryptString -
 * di aplikasi Electron itu safeStorage = DPAPI Windows, terikat ke akun Windows ini di PC ini. Sebelumnya
 * keduanya plaintext.
 *
 * Bentuk di disk:
 *   - berkas utuh (session.json): { "format": "taxio-pilot-terenkripsi", "v": 1, "data": "<base64>" }
 *   - per kolom (local-entities.json): nilai string "enc:v1:<base64>"
 * Migrasi transparan: plaintext lama tetap terbaca dan ditulis ulang terenkripsi pada penulisan berikutnya
 * (main/app memanggil sealIfPlain sekali saat start). Mode headless (tes, `node main.js`) tidak punya
 * enkripsi: menulis plaintext seperti dulu.
 *
 * Tidak bisa dibuka (berkas disalin dari PC / akun Windows lain, profil Windows dipulihkan, atau berkas
 * terenkripsi dibaca mode headless): aplikasi TIDAK crash dan TIDAK menghapus apa pun - berkasnya
 * dipindah ke "<nama>.tidak-terbaca" (sudah ada -> "<nama>.tidak-terbaca-<waktu>"), aplikasi mulai kosong,
 * dan satu baris log berbahasa Indonesia meminta pengguna masuk lagi / mengisi ulang kredensial.
 * Salinan plaintext lama di ~/.coretax-agent (sumber migrasi Tahap 1) sengaja dibiarkan untuk rollback. */
const fs = require('fs');
const shell = require('./shell');
const { readJson, writeJsonAtomic } = require('./data-dir');

const FIELD_PREFIX = 'enc:v1:';
const FILE_FORMAT = 'taxio-pilot-terenkripsi';

class UnreadableSecretError extends Error {
    constructor(msg) { super(msg); this.name = 'UnreadableSecretError'; this.unreadable = true; }
}

function isSealed(v) { return typeof v === 'string' && v.startsWith(FIELD_PREFIX); }
/** Apakah tulisan berikutnya akan terenkripsi (shell punya enkripsi). */
function canSeal() { return shell.canEncrypt(); }

/** Teks -> "enc:v1:..." bila enkripsi tersedia; selain itu teks apa adanya. Kosong/null tidak diubah. */
function seal(plain) {
    if (plain === null || plain === undefined || plain === '' || isSealed(plain)) return plain;
    if (!shell.canEncrypt()) return plain;
    return FIELD_PREFIX + shell.encryptString(String(plain));
}

/** Kebalikan seal(); nilai plaintext lama dikembalikan apa adanya. Melempar UnreadableSecretError. */
function open(value) {
    if (!isSealed(value)) return value;
    if (!shell.canEncrypt()) throw new UnreadableSecretError('enkripsi tidak tersedia di mode ini');
    try { return shell.decryptString(value.slice(FIELD_PREFIX.length)); }
    catch (e) { throw new UnreadableSecretError(e && e.message || String(e)); }
}

function isSealedFile(obj) { return !!(obj && typeof obj === 'object' && obj.format === FILE_FORMAT); }

/** Memindah berkas yang tidak bisa dibuka ke samping. Resolves path barunya (atau null bila gagal - berkas
 *  aslinya lalu dibiarkan; pemanggil tetap mulai kosong dan berkas itu baru tertimpa pada penulisan berikutnya). */
function setAside(file) {
    let dest = file + '.tidak-terbaca';
    if (fs.existsSync(dest)) dest = file + '.tidak-terbaca-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(file, dest); return dest; }
    catch (e) {
        try { fs.copyFileSync(file, dest); return dest; } catch (e2) { return null; }
    }
}

/** Satu baris log + berkas disisihkan. `what` mis. 'Sesi login Taxio tersimpan', `advice` saran tindakan. */
function reportUnreadable(file, what, advice, err) {
    const dest = setAside(file);
    let log = null;
    try { log = require('./log').log; } catch (e) { /* abaikan */ }
    const line = what + ' tidak bisa dibuka di akun Windows / PC ini (' + (err && err.message || 'tidak terbaca') + ')'
        + (dest ? ' - berkasnya disimpan sebagai ' + dest : ' - berkas lama dibiarkan') + '. ' + advice;
    if (log) log(line); else console.error(line);
    return dest;
}

/** Membaca JSON yang mungkin terenkripsi utuh. Plaintext lama dibaca apa adanya. Tidak bisa dibuka ->
 *  disisihkan + dilaporkan, kembalikan `fallback`. */
function readSealedJson(file, fallback, { what, advice } = {}) {
    const raw = readJson(file, null);
    if (raw === null) return fallback;
    if (!isSealedFile(raw)) return raw;
    try {
        if (raw.v !== 1 || typeof raw.data !== 'string') throw new UnreadableSecretError('format tidak dikenal');
        return JSON.parse(open(FIELD_PREFIX + raw.data));
    } catch (e) {
        reportUnreadable(file, what || 'Berkas rahasia ' + file, advice || '', e);
        return fallback;
    }
}

/** Menulis JSON terenkripsi utuh bila enkripsi tersedia, selain itu plaintext (headless). */
function writeSealedJson(file, obj) {
    if (!shell.canEncrypt()) return writeJsonAtomic(file, obj);
    return writeJsonAtomic(file, { format: FILE_FORMAT, v: 1, data: shell.encryptString(JSON.stringify(obj)) });
}

/** true bila berkas JSON ada, plaintext (belum terenkripsi), dan enkripsi tersedia - perlu ditulis ulang. */
function needsSealing(file) {
    if (!shell.canEncrypt()) return false;
    const raw = readJson(file, null);
    return raw !== null && !isSealedFile(raw);
}

module.exports = {
    FIELD_PREFIX, FILE_FORMAT, UnreadableSecretError, isSealed, canSeal, seal, open, isSealedFile, setAside, reportUnreadable,
    readSealedJson, writeSealedJson, needsSealing
};
