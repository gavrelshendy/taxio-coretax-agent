/* Taxio Pilot - folder data lokal per-pengguna Windows (di luar folder exe, supaya mengganti exe
   saat update tidak menghapus data) + pembaca/penulis JSON. LOKASINYA ditentukan lib/paths.js
   (%LOCALAPPDATA%\TaxioPilot\data sejak Tahap 1; dulu ~/.coretax-agent - disalin oleh
   paths.migrate()). TAXIO_PILOT_DATA_DIR (tes) mengganti akarnya; dibaca ulang tiap panggilan. */
const path = require('path');
const fs = require('fs');
const paths = require('./paths');

function dataDir() {
    return paths.dataDir();
}

/** Membaca file JSON; kembalikan `fallback` kalau tidak ada atau rusak. */
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; }
    catch (e) { return fallback; }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
function _sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } }
let _tmpSeq = 0;

/** Menulis JSON lewat file sementara lalu rename, supaya proses yang mati di tengah menulis
 *  tidak meninggalkan file setengah jadi.
 *
 *  Windows: rename ke file yang sedang dipegang proses lain (antivirus/indeks yang memindai file
 *  baru) bisa gagal EPERM/EBUSY/EACCES sesaat - dicoba ulang beberapa kali dengan jeda singkat.
 *  Rename yang gagal tidak menyentuh file tujuan (isi lama tetap utuh). Kalau tetap gagal, isi
 *  baru disalin langsung ke file tujuan (tidak atomik, tapi file tujuan tidak pernah hilang);
 *  kalau itu pun gagal, galat dilempar dan file tujuan tetap berisi versi lama. File sementara
 *  selalu dibersihkan. `_fs` hanya untuk tes (menyuntik rename yang gagal). */
function writeJsonAtomic(file, obj, _fs) {
    const f = _fs || fs;
    f.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp-' + process.pid + '-' + (++_tmpSeq);
    f.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    try {
        let lastErr = null;
        for (let i = 0; i < 6; i++) {
            try { f.renameSync(tmp, file); return; }
            catch (e) {
                lastErr = e;
                if (!RETRYABLE.has(e.code)) break;
                _sleepSync(25 * (i + 1));
            }
        }
        try { f.copyFileSync(tmp, file); }
        catch (e) { throw lastErr || e; }
    } finally {
        try { if (f.existsSync(tmp)) f.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
}

module.exports = { dataDir, readJson, writeJsonAtomic };
