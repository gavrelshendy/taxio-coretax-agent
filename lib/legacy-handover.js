/* Serah-terima dari build pkg lama (coretax-agent.exe, semua versi 3.0.x) ke aplikasi terpasang
 * (Tahap 2, installer NSIS per-user di %LOCALAPPDATA%\Programs).
 *
 * Jalurnya: updater LAMA mengunduh aset .exe pertama di rilis GitHub terbaru - kini installer NSIS - dan
 * menjalankannya sebagai `<installer> --finish-update <pid> <exe lama>` lalu menutup dirinya sendiri.
 * Installer mengabaikan argumen yang tidak dikenalnya, memasang aplikasi, membuat pintasan Desktop/Start
 * Menu "Taxio Pilot" baru, lalu menjalankan aplikasi baru. Pada start pertama itu (sebelum
 * app.setAsDefaultProtocolClient menimpa registry), electron/main.js memanggil run() di sini:
 *   - perintah protokol taxio-coretax di HKCU\Software\Classes masih menunjuk ke exe lama
 *     (nama mengandung "coretax-agent", .exe, DI LUAR folder instalasi) => itulah exe lama pengguna;
 *   - pintasan .lnk di Desktop dan Start Menu pengguna yang target-nya exe lama itu diarahkan ke exe baru
 *     (target, folder kerja, ikon) - nama pintasan dan argumennya tetap;
 *   - exe lama TIDAK dihapus / diganti nama (rollback tetap mungkin; datanya sudah disalin lib/paths.js).
 * Sesudah itu protokol didaftarkan ke exe baru, jadi start berikutnya tidak menemukan apa pun (idempoten,
 * tanpa berkas penanda).
 *
 * TIDAK PERNAH dijalankan bila TAXIO_PILOT_DATA_DIR atau TAXIO_PILOT_SMOKE diisi (uji terisolasi tidak
 * boleh menyentuh registry / pintasan PC ini), dan hanya oleh aplikasi terpasang (app.isPackaged).
 * Semua pembaca/penulis (registry, daftar .lnk, read/writeShortcutLink Electron) disuntikkan: logika di
 * sini murni dan diuji dengan tiruan (scripts/test-legacy-handover.js). */
const path = require('path');

/** Keluaran `reg query <key> /ve` -> nilai (Default), atau null. Label "(Default)" dilokalkan Windows,
 *  jadi yang dicari tipe REG_SZ / REG_EXPAND_SZ-nya. */
function parseRegDefault(out) {
    const m = /REG_(?:EXPAND_)?SZ[ \t]+(.+?)\s*$/m.exec(String(out || ''));
    return m ? m[1] : null;
}

/** Perintah "open" protokol -> path exe. `"C:\a b\x.exe" "%1"` atau `C:\a\x.exe "%1"`. */
function exeFromCommand(cmd) {
    const s = String(cmd || '').trim();
    if (!s) return null;
    if (s[0] === '"') { const end = s.indexOf('"', 1); return end > 1 ? s.slice(1, end) : null; }
    const m = /^(.+?\.exe)\b/i.exec(s);
    return m ? m[1] : null;
}

function norm(p) { return path.win32.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function isInside(child, dir) { const c = norm(child), d = norm(dir); return !!d && (c === d || c.startsWith(d + '\\')); }
function isLegacyExeName(p) { const b = path.win32.basename(String(p || '')).toLowerCase(); return b.endsWith('.exe') && b.includes('coretax-agent'); }

/** Murni: apa yang harus dilakukan. `shortcuts`: [{ file, target }] (target sudah dibaca dari .lnk).
 *  Resolves { skip: alasan|null, legacyExe, retarget: [{ file, from, to }] }. */
function gateReason(env, isPackaged) {
    const e = env || {};
    if (e.TAXIO_PILOT_DATA_DIR || e.TAXIO_PILOT_SMOKE) return 'mode terisolasi (TAXIO_PILOT_DATA_DIR / TAXIO_PILOT_SMOKE)';
    if (!isPackaged) return 'bukan aplikasi terpasang';
    return null;
}
function plan({ env, isPackaged, protocolCommand, installDir, newExe, shortcuts }) {
    const none = (skip, legacyExe) => ({ skip, legacyExe: legacyExe || null, retarget: [] });
    const gate = gateReason(env, isPackaged);
    if (gate) return none(gate);
    const exe = exeFromCommand(protocolCommand);
    if (!exe) return none('protokol taxio-coretax belum terdaftar');
    if (norm(exe) === norm(newExe) || isInside(exe, installDir)) return none('protokol sudah menunjuk ke aplikasi ini', exe);
    if (!isLegacyExeName(exe)) return none('protokol menunjuk ke program lain (' + path.win32.basename(exe) + ')', exe);
    const retarget = (shortcuts || [])
        .filter((s) => s && s.target && norm(s.target) === norm(exe))
        .map((s) => ({ file: s.file, from: s.target, to: newExe }));
    return { skip: null, legacyExe: exe, retarget };
}

/** Menjalankan serah-terima. deps: { env, isPackaged, installDir, newExe, readProtocolCommand(): string|null,
 *  listShortcutFiles(): string[], readShortcut(file): { target }, writeShortcut(file, { target, cwd, icon }):
 *  bool, log(line) }. Tidak pernah melempar. Resolves hasil plan() + { done: [file], failed: [file] }. */
async function run(deps) {
    const d = deps || {};
    const log = d.log || (() => {});
    const result = { skip: null, legacyExe: null, retarget: [], done: [], failed: [] };
    try {
        // Gerbang dulu: dalam mode terisolasi registry pun tidak dibaca.
        const gate = gateReason(d.env, d.isPackaged);
        if (gate) return Object.assign(result, { skip: gate });
        let cmd = null;
        try { cmd = d.readProtocolCommand(); } catch (e) { cmd = null; }
        const shortcuts = [];
        const p0 = plan({ env: d.env, isPackaged: d.isPackaged, protocolCommand: cmd, installDir: d.installDir, newExe: d.newExe, shortcuts: [] });
        if (p0.skip) return Object.assign(result, p0);
        let files = [];
        try { files = d.listShortcutFiles() || []; } catch (e) { files = []; }
        for (const file of files) {
            try { const s = d.readShortcut(file); if (s && s.target) shortcuts.push({ file, target: s.target }); } catch (e) { /* .lnk rusak / bukan ke file */ }
        }
        const p = plan({ env: d.env, isPackaged: d.isPackaged, protocolCommand: cmd, installDir: d.installDir, newExe: d.newExe, shortcuts });
        Object.assign(result, p);
        for (const r of p.retarget) {
            let ok = false;
            try { ok = d.writeShortcut(r.file, { target: r.to, cwd: path.win32.dirname(r.to), icon: r.to, iconIndex: 0 }) !== false; } catch (e) { ok = false; }
            (ok ? result.done : result.failed).push(r.file);
        }
        log('Serah-terima dari Taxio Pilot lama (' + p.legacyExe + '): ' + result.done.length + ' pintasan diarahkan ke aplikasi baru'
            + (result.failed.length ? ', ' + result.failed.length + ' gagal (' + result.failed.join(', ') + ')' : '')
            + '. Berkas exe lama dibiarkan di tempatnya (boleh dihapus sendiri bila tidak diperlukan).');
    } catch (e) {
        log('Serah-terima dari Taxio Pilot lama gagal (diabaikan): ' + e.message);
    }
    return result;
}

module.exports = { parseRegDefault, exeFromCommand, isLegacyExeName, gateReason, plan, run };
