/* Konteks proses yang sedang berjalan, mengikuti alur async (AsyncLocalStorage). Modul ini
   sengaja tanpa dependensi supaya bisa dipakai lib/log.js maupun lib/runcontrol.js tanpa
   saling require.

   Setiap permintaan HTTP ke dashboard dijalankan di dalam isolate() dengan wadah { run: null }
   miliknya sendiri; runcontrol.start() mengisi wadah itu, sehingga semua kode yang dipanggil
   proses tersebut - checkpoint(), setPlan(), log(), dst. - tahu proses (dan sesi) mana yang
   sedang dikerjakan, tanpa parameter tambahan di automation/*.js. */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Menjalankan fn dalam wadah konteks baru (satu per permintaan / per proses). */
function isolate(fn) { return als.run({ run: null }, fn); }
/** Wadah konteks yang sedang aktif, atau null bila kode ini tidak berjalan di dalam isolate(). */
function holder() { return als.getStore() || null; }
/** Proses yang sedang dikerjakan alur ini, atau null. */
function current() { const h = als.getStore(); return (h && h.run) || null; }
/** Menjalankan fn seolah-olah di dalam proses `run` (mis. supaya log dari tombol Jeda ikut berlabel). */
function within(run, fn) { return als.run({ run }, fn); }

module.exports = { als, isolate, holder, current, within };
