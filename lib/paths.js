/* Taxio Pilot - SATU-SATUNYA tempat yang menentukan lokasi folder/berkas lokal aplikasi (Tahap 1
 * "portabel"; tetap dipakai apa adanya oleh shell Electron di Tahap 2). Modul lain memanggil fungsi
 * di sini - jangan menyusun path di bawah home / folder exe sendiri.
 *
 * Akar = %LOCALAPPDATA%\TaxioPilot\ :
 *   data\                 session.json, local-entities.json, pending-signup.json, ... (lib/data-dir.js)
 *   logs\coretax-agent.log (+ .1/.2 rotasi lib/log.js)
 *   profiles\terpasang\   profil Chrome per PIC untuk Chrome yang terpasang di PC (dulu ~/.coretax-agent-profile)
 *   profiles\bawaan\      profil Chrome per PIC untuk Chrome bawaan (dulu ~/.taxio-pilot-profile)
 *   chrome\<versi>\       Chrome bawaan (lib/browser.js) - sudah di sini sejak v3.0
 *   unduhan-sementara\    transit unduhan otomatis (lib/chrome.js) - sudah di sini sejak v3.0
 *   runtime.json          { port, pid, token, version, startedAt } instance yang sedang berjalan (lib/runtime.js)
 * Folder HASIL untuk pengguna (~/Downloads/CoretaxAgent/...) TIDAK ikut ke sini.
 *
 * Kenapa dipindah: log dulu ditulis di samping exe (gagal diam-diam bila exe ada di folder read-only,
 * mis. Program Files), data di ~/.coretax-agent, profil di dua folder lain di home.
 *
 * Variabel lingkungan:
 *   TAXIO_PILOT_DATA_DIR    mengganti AKAR (tes / smoke run): data, log, profil, runtime.json, chrome dan
 *                           unduhan-sementara semuanya di bawahnya. Selama ini diisi, "home lama" untuk
 *                           migrasi/fallback profil TIDAK pernah home asli - hanya TAXIO_PILOT_LEGACY_HOME.
 *                           (Sebelum Tahap 1 variabel ini adalah folder data itu sendiri; kini data ada di
 *                           <akar>\data.)
 *   TAXIO_PILOT_LOG_FILE    mengganti berkas log saja (tes).
 *   TAXIO_PILOT_CHROME_DIR  mengganti folder Chrome bawaan saja (scripts/run-tests.js mengarahkannya ke
 *                           cache Chrome bawaan asli supaya tes berbasis browser tidak mengunduh ±185 MB
 *                           ke tiap folder sementara).
 *   TAXIO_PILOT_LEGACY_HOME home "lama" palsu untuk tes migrasi.
 *   TAXIO_PILOT_DOWNLOADS_DIR folder tujuan ekspor diagnostik (tes); bawaan ~/Downloads.
 *
 * Migrasi (migrate(), dipanggil main.js sebelum apa pun membaca data, hanya oleh instance yang menjadi
 * primary): idempoten dan tidak pernah fatal.
 *   - Berkas data kecil di ~/.coretax-agent DISALIN ke data\ bila belum ada di sana (yang lama dibiarkan,
 *     supaya kembali ke exe lama tetap jalan).
 *   - Profil Chrome DIPINDAH (rename per folder PIC - bisa ratusan MB). Gagal (folder dikunci Chrome yang
 *     masih terbuka, beda drive, izin) = profil itu tetap dipakai dari path lamanya lewat
 *     resolveProfileDir(): "path baru bila ada, selain itu path lama bila ada, selain itu path baru" -
 *     tidak ada profil yang hilang atau terduplikasi. Migrasi berikutnya mencoba lagi.
 *   - Log lama (di samping exe) tidak dipindah.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_NAME = 'coretax-agent.log';
const PROFILE_KINDS = { terpasang: '.coretax-agent-profile', bawaan: '.taxio-pilot-profile' };
const LEGACY_DATA_NAME = '.coretax-agent';

function localAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
/** Akar default (tanpa override) - dipakai juga oleh scripts/run-tests.js untuk cache Chrome bawaan. */
function defaultRoot() { return path.join(localAppData(), 'TaxioPilot'); }
function root() { return process.env.TAXIO_PILOT_DATA_DIR ? path.resolve(process.env.TAXIO_PILOT_DATA_DIR) : defaultRoot(); }
function dataDir() { return path.join(root(), 'data'); }
function logsDir() { return path.join(root(), 'logs'); }
function logFile() { return process.env.TAXIO_PILOT_LOG_FILE || path.join(logsDir(), LOG_NAME); }
function profilesDir() { return path.join(root(), 'profiles'); }
function profileRoot(kind) {
    if (!PROFILE_KINDS[kind]) throw new Error('Jenis profil tidak dikenal: ' + kind);
    return path.join(profilesDir(), kind);
}
function chromeDir() { return process.env.TAXIO_PILOT_CHROME_DIR ? path.resolve(process.env.TAXIO_PILOT_CHROME_DIR) : path.join(root(), 'chrome'); }
function downloadTempDir() { return path.join(root(), 'unduhan-sementara'); }
function runtimeFile() { return path.join(root(), 'runtime.json'); }
function downloadsDir() { return process.env.TAXIO_PILOT_DOWNLOADS_DIR ? path.resolve(process.env.TAXIO_PILOT_DOWNLOADS_DIR) : path.join(os.homedir(), 'Downloads'); }

/** Home "lama" (tempat ~/.coretax-agent dan profil lama), atau null bila tidak boleh dipakai (akar
 *  di-override tanpa TAXIO_PILOT_LEGACY_HOME - tes/smoke run tidak pernah menyentuh home asli). */
function legacyHome() {
    if (process.env.TAXIO_PILOT_LEGACY_HOME) return path.resolve(process.env.TAXIO_PILOT_LEGACY_HOME);
    if (process.env.TAXIO_PILOT_DATA_DIR) return null;
    return os.homedir();
}
function legacyDataDir() { const h = legacyHome(); return h ? path.join(h, LEGACY_DATA_NAME) : null; }
function legacyProfileRoot(kind) {
    if (!PROFILE_KINDS[kind]) throw new Error('Jenis profil tidak dikenal: ' + kind);
    const h = legacyHome();
    return h ? path.join(h, PROFILE_KINDS[kind]) : null;
}
/** Semua akar profil yang sah milik aplikasi ini (baru + lama) - untuk lib/chrome.js isOwnProfileDir. */
function allProfileRoots() {
    const out = [];
    for (const kind of Object.keys(PROFILE_KINDS)) {
        out.push(profileRoot(kind));
        const legacy = legacyProfileRoot(kind);
        if (legacy) out.push(legacy);
    }
    return out;
}

function _exists(p, _fs) { try { (_fs || fs).statSync(p); return true; } catch (e) { return false; } }

/** Folder profil Chrome untuk satu PIC: baru bila ada, selain itu lama bila ada (pindahnya gagal),
 *  selain itu baru. `folder` sudah aman sebagai nama folder (lib/chrome.js browserLaunch). */
function resolveProfileDir(kind, folder) {
    const fresh = path.join(profileRoot(kind), folder);
    if (_exists(fresh)) return fresh;
    const legacyRoot = legacyProfileRoot(kind);
    if (legacyRoot) {
        const old = path.join(legacyRoot, folder);
        if (_exists(old)) return old;
    }
    return fresh;
}

/** Migrasi satu kali per start (idempoten, tidak pernah melempar). `opts._fs` hanya untuk tes
 *  (menyuntik rename yang gagal). Mengembalikan ringkasan { copied, moved, keptLegacy, errors, skipped }. */
function migrate(opts) {
    const o = opts || {};
    const f = o._fs || fs;
    const summary = { copied: [], moved: [], keptLegacy: [], errors: [], skipped: false };
    try { f.mkdirSync(dataDir(), { recursive: true }); } catch (e) { summary.errors.push('data: ' + e.message); }
    const home = legacyHome();
    if (!home) { summary.skipped = true; return summary; }

    // 1. Data kecil: SALIN bila belum ada di folder baru.
    const oldData = legacyDataDir();
    let entries = [];
    try { entries = f.readdirSync(oldData, { withFileTypes: true }); } catch (e) { /* tidak ada folder lama */ }
    for (const ent of entries) {
        const name = ent.name;
        if (name.includes('.tmp-')) continue; // sisa writeJsonAtomic yang terputus
        const src = path.join(oldData, name), dest = path.join(dataDir(), name);
        if (_exists(dest, f)) continue;
        try {
            if (ent.isDirectory()) f.cpSync(src, dest, { recursive: true, errorOnExist: false, force: false });
            else if (ent.isFile()) f.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
            else continue;
            summary.copied.push(name);
        } catch (e) { summary.errors.push(name + ': ' + e.message); }
    }

    // 2. Profil Chrome: PINDAH per folder PIC.
    for (const kind of Object.keys(PROFILE_KINDS)) {
        const oldRoot = legacyProfileRoot(kind);
        let pics = [];
        try { pics = f.readdirSync(oldRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { continue; }
        if (pics.length) { try { f.mkdirSync(profileRoot(kind), { recursive: true }); } catch (e) { summary.errors.push('profiles/' + kind + ': ' + e.message); continue; } }
        for (const d of pics) {
            const src = path.join(oldRoot, d.name), dest = path.join(profileRoot(kind), d.name);
            const label = kind + '/' + d.name;
            if (_exists(dest, f)) { summary.keptLegacy.push(label + ' (sudah ada di lokasi baru)'); continue; }
            try { f.renameSync(src, dest); summary.moved.push(label); }
            catch (e) { summary.keptLegacy.push(label + ' (' + (e.code || e.message) + ')'); }
        }
        // Akar lama yang sudah kosong dibuang (gagal = masih ada isinya, biarkan).
        try { f.rmdirSync(oldRoot); } catch (e) { /* masih terisi / dipakai */ }
    }
    return summary;
}

/** Satu baris log ringkasan migrasi, atau '' bila tidak ada yang perlu dilaporkan. */
function migrationSummaryLine(s) {
    if (!s || s.skipped) return '';
    const parts = [];
    if (s.copied.length) parts.push(s.copied.length + ' berkas data disalin (' + s.copied.join(', ') + ')');
    if (s.moved.length) parts.push(s.moved.length + ' profil Chrome dipindah');
    const kept = s.keptLegacy.filter((x) => !/sudah ada di lokasi baru/.test(x));
    if (kept.length) parts.push(kept.length + ' profil tetap dipakai dari lokasi lama (' + kept.join(', ') + ')');
    if (s.errors.length) parts.push(s.errors.length + ' galat (' + s.errors.join('; ').slice(0, 300) + ')');
    return parts.length ? 'Migrasi folder data ke ' + root() + ': ' + parts.join('; ') + '.' : '';
}

/** Ringkasan lokasi yang dipakai (diagnostik / /api/health). */
function describe() {
    return {
        root: root(), data: dataDir(), logFile: logFile(), profilesInstalled: profileRoot('terpasang'), profilesBundled: profileRoot('bawaan'),
        chrome: chromeDir(), downloadTemp: downloadTempDir(), runtimeFile: runtimeFile(),
        legacyData: legacyDataDir(), legacyProfilesInstalled: legacyProfileRoot('terpasang'), legacyProfilesBundled: legacyProfileRoot('bawaan')
    };
}

module.exports = {
    root, defaultRoot, dataDir, logsDir, logFile, profilesDir, profileRoot, chromeDir, downloadTempDir, runtimeFile, downloadsDir,
    legacyHome, legacyDataDir, legacyProfileRoot, allProfileRoots, resolveProfileDir, migrate, migrationSummaryLine, describe,
    PROFILE_KINDS
};
