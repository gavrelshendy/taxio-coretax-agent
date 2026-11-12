/* Satu pintu untuk SEMUA HTTP keluar dari proses Node Taxio Pilot (update GitHub, unduhan Chrome bawaan,
 * klien Supabase / Taxio Hub, pemeriksaan sistem lib/doctor.js).
 *
 * Aplikasi desktop (electron/main.js) memanggil setFetch(net.fetch Electron) sekali sesudah app.whenReady():
 * semua pemanggil lalu memakai tumpukan jaringan Chromium = proxy/PAC Windows diikuti. Tanpa itu (mode
 * headless `node main.js`, tes) berlaku fetch bawaan Node (undici), yang TIDAK mengikuti proxy/PAC.
 * Jangan memanggil global fetch langsung di modul lain; pakai `net.fetch(...)`
 * (dibaca saat dipanggil, jadi setFetch berlaku juga untuk klien yang dibuat lebih dulu).
 * Panggilan ke API LOKAL Pilot sendiri (127.0.0.1) tidak lewat sini - tidak butuh proxy.
 * Chrome otomasi tidak terpengaruh: ia punya tumpukan jaringan sendiri. */
let _impl = null;

function _current() {
    if (_impl) return _impl;
    if (typeof globalThis.fetch !== 'function') throw new Error('fetch tidak tersedia di runtime ini.');
    return globalThis.fetch;
}

/** fetch(url, init) lewat implementasi yang sedang dipasang. */
function fetch(input, init) { return _current()(input, init); }

/** Pasang implementasi lain (Electron net.fetch, atau tiruan di tes). `null` = kembali ke fetch Node. */
function setFetch(fn) {
    if (fn !== null && typeof fn !== 'function') throw new TypeError('setFetch butuh fungsi atau null.');
    _impl = fn;
}

function usingDefault() { return _impl === null; }

module.exports = { fetch, setFetch, usingDefault };
