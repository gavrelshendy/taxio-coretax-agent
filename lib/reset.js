/* Taxio Pilot - "Reset all data" (Settings) dan penerusnya saat start.
 *
 * Aplikasi yang sedang berjalan memegang berkas di bawah akar datanya (userData Electron, log, profil Chrome yang
 * baru ditutup), jadi menghapus langsung dari proses itu tidak andal. Rancangannya dua langkah:
 *   1. request(): route /api/settings/reset-all menulis penanda <akar>\reset-pending.json lalu menutup aplikasi
 *      lewat jalur "Keluar" biasa dan membuka ulang (shell.relaunch). Tidak ada yang dihapus di sini.
 *   2. runPending(): dipanggil di awal start berikutnya - electron/main.js (sesudah app.setPath('userData', ...),
 *      sebelum kunci satu-instance / Chromium membuka folder itu) dan lib/app.js start() (mode tanpa jendela) -
 *      SEBELUM apa pun membaca data. Menghapus daftar-izin di bawah akar, mencoba ulang berkas yang masih
 *      dikunci, lalu membuang penanda. Tidak pernah melempar dan tidak pernah menahan start: yang gagal dihapus
 *      dicatat dan dibiarkan (penanda tetap dibuang, supaya data baru yang dibuat sesudahnya tidak ikut terhapus
 *      pada start berikutnya). Penanda lebih tua dari 15 menit dianggap basi: dibuang tanpa menghapus apa pun.
 *
 * DIHAPUS (semua di bawah akar, lib/paths.js): data\ (sesi Taxio Hub, entitas lokal + kredensial Coretax tersimpan,
 * pengaturan), logs\, profiles\ (login Coretax per PIC), unduhan-sementara\, electron\ (cookie/penyimpanan dashboard),
 * runtime.json, update-cache\, jendela-dashboard.png, uji-diri-profil-*.
 * DIPERTAHANKAN: chrome\ (Chrome bawaan ±185 MB - bukan data pengguna, unduh ulang hanya membuang waktu),
 * legacy-v3.json (catatan "Kembali ke versi 3"), update-install.json (penjaga percobaan pasang update), dan - di luar
 * akar - folder hasil Downloads\CoretaxAgent, folder lama ~/.coretax-agent* dan exe pkg lama.
 * Sesudah menghapus, ditulis skip-legacy-migration.json supaya migrasi lib/paths.js tidak menyalin ulang data lama
 * dari ~/.coretax-agent (entitas lokal v3 hidup lagi) atau memakai profil lama di home. */
'use strict';
const nodeFs = require('fs');
const path = require('path');

const PENDING_NAME = 'reset-pending.json';
const SKIP_LEGACY_NAME = 'skip-legacy-migration.json';
const STALE_MS = 15 * 60 * 1000;
const KEEP = ['chrome', 'legacy-v3.json', 'update-install.json'];
const TARGET_NAMES = ['data', 'logs', 'profiles', 'unduhan-sementara', 'electron', 'runtime.json', 'update-cache', 'jendela-dashboard.png'];
const TARGET_PATTERNS = [/^uji-diri-profil-/i];

function pendingFile(root) { return path.join(root, PENDING_NAME); }
function skipLegacyFile(root) { return path.join(root, SKIP_LEGACY_NAME); }

/** Akar yang masuk akal untuk dihapus isinya: mutlak, bukan akar drive, minimal 3 segmen (C:\a\b). Pertahanan
 *  berlapis: root() selalu %LOCALAPPDATA%\TaxioPilot atau folder TAXIO_PILOT_DATA_DIR. */
function isSafeRoot(root) {
    const r = path.win32.resolve(String(root || ''));
    if (!path.win32.isAbsolute(String(root || ''))) return false;
    const parsed = path.win32.parse(r);
    const rest = r.slice(parsed.root.length).split('\\').filter(Boolean);
    return rest.length >= 2;
}

/** MURNI-ish: entri di `root` yang akan dihapus (nama saja, tanpa menyentuh yang di KEEP). */
function selectTargets(names) {
    const keep = new Set(KEEP.map((k) => k.toLowerCase()));
    return (names || []).filter((n) => {
        const l = String(n).toLowerCase();
        if (keep.has(l) || l === PENDING_NAME || l === SKIP_LEGACY_NAME.toLowerCase()) return false;
        return TARGET_NAMES.some((t) => t.toLowerCase() === l) || TARGET_PATTERNS.some((re) => re.test(n));
    });
}

/** Menulis penanda. Dilempar bila gagal (route -> 500 sebelum aplikasi ditutup). deps: { fs, root, now, pid, version }. */
function request(deps) {
    const d = deps || {};
    const f = d.fs || nodeFs;
    const root = d.root || require('./paths').root();
    if (!isSafeRoot(root)) throw new Error('Folder data tidak valid: ' + root);
    f.mkdirSync(root, { recursive: true });
    const marker = { v: 1, at: (d.now ? d.now() : Date.now()), pid: d.pid || process.pid, version: d.version || null };
    f.writeFileSync(pendingFile(root), JSON.stringify(marker));
    return { file: pendingFile(root), marker };
}

function _readMarker(f, file) {
    try { const m = JSON.parse(f.readFileSync(file, 'utf8')); return m && typeof m === 'object' ? m : {}; } catch (e) { return null; }
}
function _exists(f, p) { try { f.lstatSync(p); return true; } catch (e) { return false; } }

/** Menghapus satu entri. Tautan simbolik / junction hanya dilepas (isinya tidak diikuti). Resolves true bila hilang. */
function _remove(f, abs, errors) {
    let st;
    try { st = f.lstatSync(abs); } catch (e) { return true; } // sudah tidak ada
    try {
        if (st.isSymbolicLink && st.isSymbolicLink()) f.unlinkSync(abs);
        else f.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch (e) { errors.push({ path: abs, error: e.code || e.message }); }
    return !_exists(f, abs);
}

/** Memproses penanda bila ada. deps (semua opsional, tes menyuntik tiruan): { fs, root, now, sleep(ms) (sinkron),
 *  isPidAlive(pid), readRuntime() -> {pid}|null, selfPid, waitMs }.
 *  -> { ran, reason, deleted: [nama], failed: [{ path, error }], kept: [...] }. Tidak pernah melempar. */
function runPending(deps) {
    const d = deps || {};
    const out = { ran: false, reason: '', deleted: [], failed: [], kept: KEEP.slice() };
    try {
        const f = d.fs || nodeFs;
        const root = d.root || require('./paths').root();
        const file = pendingFile(root);
        if (!_exists(f, file)) { out.reason = 'tidak ada'; return out; }
        if (!isSafeRoot(root)) { out.reason = 'folder data tidak valid'; return out; }
        const now = d.now ? d.now() : Date.now();
        const marker = _readMarker(f, file);
        const at = marker && Number(marker.at);
        if (!at || now - at > STALE_MS || at - now > STALE_MS) {
            try { f.unlinkSync(file); } catch (e) { /* abaikan */ }
            out.reason = 'penanda kedaluwarsa / rusak - dibuang tanpa menghapus apa pun';
            return out;
        }
        // Instance sebelumnya (yang meminta reset) harus sudah selesai keluar - baru aman menghapus dari bawahnya.
        const sleep = d.sleep || ((ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* abaikan */ } });
        const alive = d.isPidAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
        const selfPid = d.selfPid || process.pid;
        const rt = d.readRuntime ? d.readRuntime() : (() => { try { return JSON.parse(f.readFileSync(path.join(root, 'runtime.json'), 'utf8')); } catch (e) { return null; } })();
        if (rt && Number.isInteger(rt.pid) && rt.pid !== selfPid) {
            const deadline = now + (d.waitMs != null ? d.waitMs : 10000);
            let t = now;
            while (alive(rt.pid) && t < deadline) { sleep(250); t += 250; }
            if (alive(rt.pid)) { out.reason = 'instance lain (pid ' + rt.pid + ') masih berjalan - reset ditunda'; return out; }
        }
        let names = [];
        try { names = f.readdirSync(root); } catch (e) { names = []; }
        const errors = [];
        for (const n of selectTargets(names.map((x) => (typeof x === 'string' ? x : x.name)))) {
            const abs = path.join(root, n);
            // Pagar terakhir: target harus anak langsung akar.
            if (path.dirname(abs).toLowerCase() !== path.resolve(root).toLowerCase()) continue;
            if (_remove(f, abs, errors)) out.deleted.push(n);
        }
        out.failed = errors;
        // Migrasi lib/paths.js tidak boleh menghidupkan lagi data / profil dari ~/.coretax-agent*.
        try { f.writeFileSync(skipLegacyFile(root), JSON.stringify({ at: now })); } catch (e) { /* abaikan */ }
        try { f.unlinkSync(file); } catch (e) { out.failed.push({ path: file, error: e.code || e.message }); }
        out.ran = true;
        out.reason = 'selesai';
    } catch (e) { out.reason = 'galat: ' + e.message; }
    return out;
}

/** Satu baris log Indonesia untuk hasil runPending, atau '' bila tidak ada yang dikerjakan. */
function summaryLine(r) {
    if (!r || (!r.ran && /tidak ada/.test(r.reason || ''))) return '';
    if (!r.ran) return 'Reset semua data tidak dijalankan: ' + r.reason + '.';
    return 'Reset semua data: ' + r.deleted.length + ' item dihapus (' + r.deleted.join(', ') + '); Chrome bawaan dan folder hasil unduhan dipertahankan.'
        + (r.failed.length ? ' ' + r.failed.length + ' item gagal dihapus dan dibiarkan (' + r.failed.map((x) => path.basename(x.path) + ': ' + x.error).join('; ').slice(0, 300) + ') - hapus manual bila perlu.' : '');
}

module.exports = { request, runPending, summaryLine, selectTargets, isSafeRoot, pendingFile, skipLegacyFile, PENDING_NAME, SKIP_LEGACY_NAME, STALE_MS, KEEP, TARGET_NAMES };
