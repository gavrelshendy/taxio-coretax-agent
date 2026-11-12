/* Taxio Pilot - kabar perubahan dari server ke dashboard lewat aliran /events yang sudah ada (SSE).
 *
 * Dashboard dulu hanya polling (status proses 1,5 detik, status manual 2 detik, login 3 detik, daftar sesi
 * 4 detik). Di tempat server sudah TAHU ada perubahan - proses mulai/selesai (lib/runcontrol.js), login
 * Coretax terkonfirmasi (lib/login-status.js), jendela Chrome dibuka/ditutup (lib/chrome-sessions.js),
 * status pemulihan sesi Taxio Hub (lib/session-restore.js) - modul itu memanggil emit(), dan gui/server.js
 * meneruskannya sebagai baris `data: {"event":"<jenis>"}` supaya dashboard langsung memuat ulang bagian itu.
 * Jenis: 'run' | 'login' | 'sessions' | 'session'. Tanpa dependensi (aman di-require dari modul mana pun). */
const subs = new Set();

/** Berlangganan; mengembalikan fungsi berhenti berlangganan. fn({ event, data }). */
function on(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Kabar dikumpulkan sebentar (per jenis) supaya rentetan perubahan menjadi satu kabar. */
const DEBOUNCE_MS = 150;
const pending = new Map();
function emit(event, data) {
    if (pending.has(event)) { pending.get(event).data = data; return; }
    const entry = { data, timer: null };
    entry.timer = setTimeout(() => {
        pending.delete(event);
        for (const fn of Array.from(subs)) { try { fn({ event, data: entry.data }); } catch (e) { /* pelanggan rusak diabaikan */ } }
    }, DEBOUNCE_MS);
    if (entry.timer.unref) entry.timer.unref();
    pending.set(event, entry);
}

module.exports = { on, emit, DEBOUNCE_MS };
