/* Kebijakan akses dashboard (gui/server.js) di SATU tempat: asal permintaan (Host/Origin), peran
   Restricted Editor, dan penolakan versi usang. Handler memanggil fungsi di sini - bukan menyalin
   ulang pemeriksaannya - supaya tidak ada lagi route yang lupa salah satunya. */
const state = require('../lib/state');
const updater = require('../lib/updater');
const { sendJson } = require('./http-util');

// ---- Asal permintaan ----
// Server hanya bind ke 127.0.0.1, tapi "lokal" BUKAN berarti aman dari browser:
//  1. CSRF: halaman apa pun di tab mana pun bisa fetch()/XHR ke http://127.0.0.1:<port>/api/...
//     ("simple request" text/plain tanpa preflight tetap sampai ke handler, efek sampingnya terjadi
//     walau halaman itu tidak bisa membaca balasannya). Ditolak lewat header Origin: setiap
//     permintaan lintas-origin dari browser selalu membawa Origin, dan Origin yang ada harus
//     persis origin dashboard ini - untuk SEMUA metode, bukan hanya POST.
//  2. DNS rebinding: halaman http://evil.example:<port> yang namanya di-resolve ulang ke 127.0.0.1
//     menjadi "same-origin" dengan dirinya sendiri - Origin dan Host-nya sama-sama evil.example,
//     jadi perbandingan Origin vs Host (cara lama) lolos, dan halaman itu bisa membaca SEMUA API
//     (termasuk menerbitkan / membatalkan bukti potong yang ditandatangani passphrase tersimpan).
//     Ditolak lewat header Host: harus persis 127.0.0.1:<port> atau localhost:<port>, dengan port
//     yang benar-benar di-bind server ini.
// Permintaan TANPA Origin (server MCP, penerusan deep link main.js, tray, curl) lolos cek INI -
// pemalsuan header oleh program lokal butuh eksekusi kode di mesin ini, ancaman yang berbeda, yang
// sejak Tahap 1 ditahan oleh token per peluncuran (authProblem di bawah).
function allowedHosts(port) { return ['127.0.0.1:' + port, 'localhost:' + port]; }
function allowedOrigins(port) { return allowedHosts(port).map((h) => 'http://' + h); }

/** null bila permintaan boleh dilayani; selain itu alasan penolakan (untuk log). */
function requestOriginProblem(req, port) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts(port).includes(host)) return 'Host tidak dikenal: ' + (host ? host.slice(0, 100) : '(kosong)');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins(port).includes(String(origin).toLowerCase())) return 'Origin asing: ' + String(origin).slice(0, 100);
    return null;
}

// ---- Token per peluncuran (Tahap 1) ----
// Cek Host/Origin di atas hanya menahan BROWSER. Program lokal apa pun (atau pengguna Windows lain di
// PC yang sama) tetap bisa memanggil API tanpa Origin - termasuk menerbitkan bukti potong dengan
// passphrase tersimpan. Karena itu SEMUA /api/* dan /events butuh token acak per peluncuran
// (lib/runtime.js; disimpan di runtime.json di bawah %LOCALAPPDATA% pengguna ini):
//   - `Authorization: Bearer <token>` (main.js, tray, updater, server MCP), atau
//   - cookie HttpOnly SameSite=Strict yang dipasang saat jendela dashboard dibuka di /?t=<token>
//     (server memvalidasi t, memasang cookie, lalu redirect ke / supaya token tidak tertinggal di
//     alamat). fetch relatif + EventSource dashboard membawa cookie itu otomatis.
// Berkas statis tetap tanpa token (halaman masuk harus bisa dimuat). Nama cookie memuat port: cookie
// tidak dipisah per port oleh browser, dan dua instance (mis. dua pengguna Windows) tidak boleh saling
// menimpa.
const { tokenEquals } = require('../lib/runtime');
function authCookieName(port) { return 'taxio_pilot_' + port; }
function needsAuth(pathname) { return pathname === '/events' || pathname === '/api' || pathname.startsWith('/api/'); }
function _cookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}
/** null bila token permintaan benar; selain itu alasan penolakan (untuk log - tanpa isi token). */
function authProblem(req, port, token) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
    if (m) return tokenEquals(m[1], token) ? null : 'token Bearer salah';
    const c = _cookie(req, authCookieName(port));
    if (c) return tokenEquals(c, token) ? null : 'cookie token salah (Taxio Pilot sudah dibuka ulang?)';
    return 'tanpa token';
}
const UNAUTHORIZED_MESSAGE = 'Tidak diizinkan: token Taxio Pilot tidak ada atau salah. Buka dashboard lewat ikon / pintasan Taxio Pilot (alat lokal: baca port dan token dari runtime.json).';
function setAuthCookieHeader(port, token) {
    return authCookieName(port) + '=' + token + '; Path=/; HttpOnly; SameSite=Strict';
}

// ---- Restricted Editor ----
function isProjectRestricted(projectId) {
    const s = state.get(projectId);
    if (!s) return false;
    const r1 = String(s.role || '').trim().toLowerCase().replace(/-/g, '_');
    const r2 = String((s.membership && s.membership.role) || '').trim().toLowerCase().replace(/-/g, '_');
    return r1.includes('restricted') || r2.includes('restricted');
}
/** Restricted bila SALAH SATU koneksi aktif Restricted - memilih project manual / lain / palsu di
 *  body permintaan tidak bisa melewatinya. Peran selalu dari sesi tepercaya, tidak pernah dari body. */
function anyRestricted() { return state.connectedProjectIds().some(isProjectRestricted); }
/** Membalas 403 `message` bila pengguna Restricted. true = sudah dibalas, handler berhenti. */
function rejectIfRestricted(res, message) {
    if (!anyRestricted()) return false;
    sendJson(res, 403, { error: message });
    return true;
}

// Server-side enforcement of allowed_ebupot_sections - previously this value was only ever
// read to build the admin's "Manage Members" config UI and passed through into the automation
// opts for the in-page watchdog to (imperfectly) enforce; nothing ever rejected a restricted
// editor's download REQUEST itself here, so a direct POST to these routes bypassed it entirely
// regardless of what was configured. Fixed 2026-07-27.
// Maps a bupotType/buktiTypeKey (used in download requests) to the matching config key (used
// in the admin panel's per-restricted_editor checkboxes, see supabase.js ebupotOpts) - the two
// naming schemes don't line up 1:1 (e.g. download-type 'bppu' vs config-key 'ebupotbpu'), so
// this has to be explicit rather than a generic string transform.
const EBUPOT_TYPE_TO_SECTION = { bp21: 'ebupotbp21', bppu: 'ebupotbpu', bpmp: 'ebupotbpmp', bp26: 'ebupotbp26', bpnr: 'ebupotbpnr' };
// BPMP/BPA1, in both e-Bupot (entity-issued) and "Bukti Potong Saya" (PIC's own personal
// received slips) - explicit user request 2026-08-10, absolute for restricted_editor and NOT
// admin-configurable (unlike the other types below, which stay gated by allowed_ebupot_sections).
const ABSOLUTELY_BLOCKED_EBUPOT_TYPES = ['bpmp', 'bpa1'];
const ABSOLUTELY_BLOCKED_MYBUPOT_TYPES = ['bpmp', 'bpa1'];
function isEbupotTypeAllowed(allowedSections, bupotType) {
    if (ABSOLUTELY_BLOCKED_EBUPOT_TYPES.includes(bupotType)) return false;
    if (!allowedSections) return true; // not configured yet - matches the admin panel's own "unset = all checked" default
    const section = EBUPOT_TYPE_TO_SECTION[bupotType];
    if (!section) return true; // no configurable section for this type (e.g. bpa2/bpatc) - nothing to gate against
    return allowedSections.includes(section);
}
function isMyBupotAllowed(allowedSections) {
    if (!allowedSections) return true;
    return allowedSections.includes('my-withholding-slips');
}
// Explicit user request 2026-08-10 (real test: a restricted editor could still search for and
// log into/download from a PIC's own personal Individual account). `entity.individual` is
// already threaded through every handler from Taxio Hub's own entity payload - this is the
// actual execution point (Coretax Agent's own automation), so blocking here holds regardless
// of what triggered the request (Taxio Hub's UI, a raw deep link, or this app's own picker) -
// unlike a client-side-only check, which a deep link can simply bypass entirely.
function isIndividualEntityBlocked(restricted, entity) {
    return !!(restricted && entity && entity.individual);
}

// ---- Versi usang ----
// Explicit user request 2026-08-13: refuses to START any new automation action while a newer
// release is confirmed available - the auto-update-on-startup check is the only thing that
// otherwise keeps this build current, and if it ever gets deferred, fails, or someone's just
// running an old copy they downloaded before a security fix shipped, nothing else would stop
// them from continuing to use it indefinitely. Deliberately does NOT touch runcontrol at all -
// an already-active run is never interrupted (updater.getOutdatedInfo() only ever reports
// "outdated" from a positively-confirmed GitHub check, so a network hiccup can't trigger this).
function rejectIfOutdated(res) {
    const info = updater.getOutdatedInfo();
    if (!info.outdated) return false;
    sendJson(res, 426, { error: 'Taxio Pilot versi ' + (info.current || '') + ' sudah usang (v' + info.latestVersion + ' tersedia) - update otomatis akan berjalan begitu tidak ada proses aktif. Coba lagi sebentar lagi, atau klik "Cek Update" di Pengaturan.', outdated: true, latestVersion: info.latestVersion });
    return true;
}

module.exports = {
    requestOriginProblem, authProblem, needsAuth, authCookieName, setAuthCookieHeader, UNAUTHORIZED_MESSAGE, isProjectRestricted, anyRestricted, rejectIfRestricted,
    isEbupotTypeAllowed, isMyBupotAllowed, isIndividualEntityBlocked, ABSOLUTELY_BLOCKED_MYBUPOT_TYPES,
    rejectIfOutdated
};
