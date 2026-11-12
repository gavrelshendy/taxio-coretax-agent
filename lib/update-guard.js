/* Penjaga "pemasangan update yang gagal" (v4.0.0).
 *
 * Masalahnya: update ditemukan -> diunduh -> aplikasi KELUAR -> installer NSIS diam-diam -> aplikasi dibuka
 * lagi. Installer tidak ditandatangani; antivirus / SmartScreen bisa memblokirnya SESUDAH aplikasi keluar.
 * Pengguna membuka versi lama lagi, gerbang "versi usang" (HTTP 426) menolak semua aksi, update diunduh lagi,
 * aplikasi keluar lagi - lingkaran tanpa akhir.
 *
 * Jadi: tepat sebelum keluar untuk memasang, catatan percobaan ditulis ke <akar data>\update-install.json
 *   { target, attempts, firstAt, lastAt }   (attempts naik bila target sama, mulai dari 1 bila target baru)
 * Saat start (startup()):
 *   - tidak ada catatan                      -> 'none'
 *   - versi berjalan >= target               -> pemasangan berhasil; catatan dihapus -> 'succeeded'
 *   - versi berjalan <  target               -> pemasangan GAGAL -> 'failed' (+ blocked bila attempts >= MAX)
 * Versi yang `blocked` tidak lagi dipasang otomatis dan TIDAK menggerbang aksi (lib/updater.js); "Cek
 * Update" manual tetap boleh mencoba (tiap klik satu percobaan).
 *
 * Murni: penyimpanan dan jam disuntikkan (scripts/test-update-guard.js). */
'use strict';

const MAX_AUTO_ATTEMPTS = 2;

function _isNewer(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** storage: { read(): obj|null, write(obj), clear() }; now(): ms; current(): versi berjalan. */
function createInstallGuard({ storage, now = () => Date.now(), current, maxAttempts = MAX_AUTO_ATTEMPTS } = {}) {
    if (!storage) throw new Error('storage wajib');
    const cur = typeof current === 'function' ? current : () => current;

    function _read() {
        let r = null;
        try { r = storage.read(); } catch (e) { r = null; }
        if (!r || typeof r !== 'object' || typeof r.target !== 'string' || !Number.isInteger(r.attempts) || r.attempts < 1) return null;
        return r;
    }
    function _clear() { try { storage.clear(); } catch (e) { /* abaikan */ } }

    /** Dipanggil tepat sebelum keluar untuk memasang `target`. Mengembalikan catatan yang ditulis. */
    function beforeInstall(target) {
        const t = String(target).replace(/^v/i, '');
        const prev = _read();
        const at = new Date(now()).toISOString();
        const rec = prev && prev.target === t
            ? { target: t, attempts: prev.attempts + 1, firstAt: prev.firstAt || at, lastAt: at }
            : { target: t, attempts: 1, firstAt: at, lastAt: at };
        storage.write(rec);
        return rec;
    }

    /** Evaluasi saat start: { status: 'none'|'succeeded'|'failed', target, attempts, blocked, lastAt }. */
    function startup() {
        const r = _read();
        if (!r) return { status: 'none', blocked: false };
        if (!_isNewer(r.target, cur())) { _clear(); return { status: 'succeeded', target: r.target, attempts: r.attempts, blocked: false }; }
        return { status: 'failed', target: r.target, attempts: r.attempts, lastAt: r.lastAt || null, blocked: r.attempts >= maxAttempts };
    }

    /** true bila `version` sudah gagal dipasang >= maxAttempts kali dan masih lebih baru dari versi berjalan. */
    function isBlocked(version) {
        const r = _read();
        if (!r || !version) return false;
        const v = String(version).replace(/^v/i, '');
        return r.target === v && r.attempts >= maxAttempts && _isNewer(v, cur());
    }

    function record() { return _read(); }

    return { beforeInstall, startup, isBlocked, record, maxAttempts };
}

/** Penyimpanan berkas JSON (dipakai lib/updater.js). */
function fileStorage(file) {
    const fs = require('fs');
    const { readJson, writeJsonAtomic } = require('./data-dir');
    return {
        read: () => readJson(file, null),
        write: (obj) => writeJsonAtomic(file, obj),
        clear: () => { try { fs.rmSync(file, { force: true }); } catch (e) { /* abaikan */ } }
    };
}

module.exports = { createInstallGuard, fileStorage, MAX_AUTO_ATTEMPTS };
