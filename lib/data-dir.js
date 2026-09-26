/* Taxio Pilot - satu tempat untuk folder data lokal per-pengguna Windows (di luar folder exe,
   supaya mengganti exe saat update tidak menghapus data). Sama dengan folder yang sudah dipakai
   lib/session-store.js. TAXIO_PILOT_DATA_DIR hanya untuk tes, supaya skrip tes tidak menyentuh
   data asli di folder home. */
const path = require('path');
const os = require('os');
const fs = require('fs');

function dataDir() {
    return process.env.TAXIO_PILOT_DATA_DIR || path.join(os.homedir(), '.coretax-agent');
}

/** Membaca file JSON; kembalikan `fallback` kalau tidak ada atau rusak. */
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; }
    catch (e) { return fallback; }
}

/** Menulis JSON lewat file sementara lalu rename, supaya proses yang mati di tengah menulis
 *  tidak meninggalkan file setengah jadi. */
function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

module.exports = { dataDir, readJson, writeJsonAtomic };
