/* Taxio Pilot - dijalankan sinkron di <head> SEBELUM paint pertama: memasang tema (System / Light / Dark, bawaan
   Dark untuk pengguna baru) dan status sidebar yang diingat, supaya tidak ada kedipan. Pilihan disimpan oleh
   core.js (P.theme) di localStorage 'pilot.theme' (sesi Electron memakai partisi persisten, jadi tetap ada). */
(function () {
    'use strict';
    var root = document.documentElement;
    var pref = 'dark';
    try { var v = JSON.parse(localStorage.getItem('pilot.theme')); if (v === 'system' || v === 'light' || v === 'dark') pref = v; } catch (e) { /* bawaan */ }
    var dark = pref === 'dark' || (pref === 'system' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-pref', pref);
    try { if (JSON.parse(localStorage.getItem('pilot.sb')) === 'collapsed') root.classList.add('sb-pref-collapsed'); } catch (e) { /* bawaan: terbuka */ }
    root.classList.add('preload');
    // Transisi baru diaktifkan sesudah paint pertama.
    window.addEventListener('load', function () { requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('preload'); }); }); });
})();
