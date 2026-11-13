/* Kontrol yang BENAR-BENAR berlaku per fitur (dipakai lib/runcontrol.js, gui/server.js, lib/deeplink.js; dashboard dan
 * MCP membacanya dari /api/run/status `controls`). Satu tempat, supaya tombol di dashboard tidak lagi menjanjikan
 * sesuatu yang tidak dikerjakan fiturnya (temuan pemilik 2026-11-13: Pause / Skip / ... tampil untuk semua proses).
 *
 *   stop     - berhenti di titik aman berikutnya (antar baris / dokumen / masa / panggilan API), tidak pernah di tengah satu
 *              permintaan tulis Coretax; proses yang masih antre selalu bisa dibatalkan (tidak bergantung pada ini).
 *   pause    - ditahan di titik aman berikutnya (tidak ada permintaan ke Coretax selama dijeda), Lanjut meneruskan dari situ.
 *   skip     - lewati unit saat ini (kombinasi filter / masa) lalu lanjut ke berikutnya.
 *   retry    - ulangi kombinasi saat ini dari awal.          (hanya unduhan berbasis kombinasi filter)
 *   back     - kembali ke kombinasi sebelumnya.              (hanya unduhan berbasis kombinasi filter)
 *   pageSize - ganti baris per halaman di tengah jalan (/api/run/pagesize).
 *
 * Permintaan kontrol yang tidak didukung fitur sebuah proses DITOLAK lib/runcontrol.js (satu baris log), bukan diam-diam
 * dicatat lalu tidak terjadi apa-apa. Fitur baru WAJIB terdaftar di FEATURES (scripts/test-run-controls.js gagal bila
 * route aksi baru tidak mendeklarasikan fiturnya / fiturnya tidak ada di sini). */
'use strict';

const KEYS = ['stop', 'pause', 'skip', 'retry', 'back', 'pageSize'];
const make = (on) => Object.freeze(Object.fromEntries(KEYS.map((k) => [k, on.includes(k)])));

/** Unduhan per kombinasi filter (masa x jenis/kode): mesin lengkap - automation/spt.js, ebupot.js, mybupot.js. */
const COMBO = make(['stop', 'pause', 'skip', 'retry', 'back', 'pageSize']);
/** Unduhan multi-masa lewat API: Skip = lewati masa (e-Faktur: jenis x masa) yang sedang diambil. */
const PERIOD = make(['stop', 'pause', 'skip']);
/** Stop + Jeda di titik aman (baris / dokumen / kelompok / panggilan API). */
const BASIC = make(['stop', 'pause']);
/** Hanya Stop: permintaan yang menunggu jawaban (cari / pratinjau / cek NIK - Jeda akan menggantung pemanggilnya) dan
 *  rekam API (pasif: tidak ada yang bisa dijeda). */
const STOP_ONLY = make(['stop']);

const FEATURES = {
    // Unduhan berbasis kombinasi filter.
    'download-spt': COMBO,          // termasuk Mode A1 (a1Year) - bagian sesudah loop SPT: Stop / Jeda saja
    'download-ebupot': COMBO,
    'download-mybupot': COMBO,
    // Unduhan multi-masa lewat API.
    'download-pajak-masukan': PERIOD,
    'download-efaktur': PERIOD,
    // Mengubah data Coretax: Stop / Jeda di antara unit tulis.
    'billing-pph25': BASIC,
    'import-pajak-masukan': BASIC,
    'bpmp-amend': BASIC,
    'bpmp-sweep': BASIC,
    'import-coretax': BASIC,
    'create-konsep': BASIC,
    'issue-ebupot': BASIC,
    'konsep-download': BASIC,
    'ebupot-amend': BASIC,
    'ebupot-cancel': BASIC,
    'import-dividen': BASIC,
    'check-dividen': BASIC,
    'create-dividen-case': BASIC,
    // Tanpa Coretax / hanya login.
    'a1-refresh': BASIC,
    'login': BASIC,
    // Menjawab langsung (runForResult + guarded): Stop = berhenti menunggu.
    'issue-preview': STOP_ONLY,
    'import-check-nik': STOP_ONLY,
    'check-nik': STOP_ONLY,
    'ebupot-find': STOP_ONLY,
    'ebupot-amend-preview': STOP_ONLY,
    'ebupot-cancel-preview': STOP_ONLY,
    'coretax-record': STOP_ONLY,
    // Tautan taxio-coretax:// dari Taxio Hub (lib/deeplink.js) - 'deeplink:<action>'.
    'deeplink:login': BASIC,
    'deeplink:download-spt': COMBO,
    'deeplink:mode-a1': COMBO,
    'deeplink:billing-pph25': BASIC
};

/** Proses tanpa fitur (perbarui rekap otomatis, alat / tes lama) dan fitur yang belum terdaftar: Stop + Jeda. */
const DEFAULT = BASIC;

/** Salinan kontrol untuk `feature` (objek baru - aman diubah pemanggil). `override`: objek parsial dari pemanggil. */
function controlsFor(feature, override) {
    const base = (feature && FEATURES[feature]) || DEFAULT;
    const out = Object.assign({}, base);
    if (override && typeof override === 'object') for (const k of KEYS) if (k in override) out[k] = !!override[k];
    return out;
}
const isDeclared = (feature) => Object.prototype.hasOwnProperty.call(FEATURES, feature);

module.exports = { KEYS, FEATURES, COMBO, PERIOD, BASIC, STOP_ONLY, DEFAULT, controlsFor, isDeclared };
