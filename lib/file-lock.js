/* Taxio Pilot - kunci per berkas di dalam proses ini (sejak beberapa proses bisa berjalan bersamaan).
 *
 * Beberapa penulis Excel membaca-mengubah-menulis berkas yang SAMA dari fitur yang berbeda - mis. Excel rekap Mode A1
 * ditulis lib/a1-workbook.js (Unduh setahun), lib/bpmp-report.js (Pembetulan NIK BPMP, penyisiran, cek e-Bupot vs
 * SPT) dan lib/a1-autorefresh.js (Perbarui rekap); laporan e-Bupot per masa (lib/coretax-report.js) ditulis sesudah
 * upload maupun sesudah terbitkan. Dua proses yang menulisnya berbarengan bisa saling menimpa isian atau merusak
 * berkas. withFileLock(file, fn) menjalankan fn sesudah penulis sebelumnya untuk berkas itu selesai (FIFO); berkas
 * lain tidak saling menunggu. Kunci dilepas juga bila fn gagal. */
const path = require('path');

const tails = new Map(); // path ternormalisasi -> janji penulis terakhir

function keyOf(file) { return path.resolve(String(file || '')).toLowerCase(); }

/** Menjalankan `fn()` (boleh async) setelah semua penulis sebelumnya untuk `file` selesai; hasilnya diteruskan. */
function withFileLock(file, fn) {
    const k = keyOf(file);
    const prev = tails.get(k) || Promise.resolve();
    // Kunci dilepas (finally) sebelum hasilnya sampai ke pemanggil; penulis berikutnya menunggu `tail`.
    const result = prev.catch(() => {}).then(() => fn()).finally(() => { if (tails.get(k) === tail) tails.delete(k); });
    const tail = result.catch(() => {});
    tails.set(k, tail);
    return result;
}

/** Hanya untuk tes: jumlah berkas yang kuncinya masih dipegang / ditunggu. */
function _pending() { return tails.size; }

module.exports = { withFileLock, _pending };
