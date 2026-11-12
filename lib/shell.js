/* Taxio Pilot - layanan platform ("shell") dalam SATU antarmuka kecil (Tahap 2).
 *
 * Inti aplikasi (lib/, gui/, automation/) TIDAK PERNAH require('electron'): tes dan smoke run berjalan di
 * `node` biasa. Yang butuh jendela / dialog / kunci OS memanggil modul ini; shell Electron
 * (electron/main.js) memasang implementasi aslinya lewat register() sesudah app.whenReady(). Tanpa itu
 * berlaku implementasi "headless" di bawah - aman untuk tes: tidak ada jendela, dialog atau PowerShell
 * yang muncul (kecuali bringChromeToFront, lihat di bawah), rahasia disimpan apa adanya (plaintext).
 *
 * Antarmuka (semua opsional saat register - yang tidak diberikan tetap memakai versi headless):
 *   kind                       'headless' | 'electron'
 *   showDashboard(url)         buka jendela dashboard, atau tampilkan + fokuskan yang sudah ada -> Promise<bool>
 *   closeDashboard()           tutup jendela dashboard (saat keluar)
 *   pickFile({ title, filters, defaultPath })   -> Promise<path|null>  (filters gaya Electron)
 *   pickFolder({ title })                       -> Promise<path|null>
 *   showErrorBox(title, msg)   kotak pesan galat native (hanya sebelum dashboard ada)
 *   bringChromeToFront()       bawa jendela Chrome otomasi ke depan (proses Chrome milik Playwright)
 *   canEncrypt()               apakah encryptString/decryptString tersedia (Electron safeStorage = DPAPI)
 *   encryptString(text)        -> base64;   decryptString(base64) -> text (melempar bila gagal)
 *   isPackaged()               aplikasi terpasang (bukan `electron .` / `node main.js`)
 *   exePath()                  exe yang sedang berjalan
 *   exit(code)                 akhiri proses (Electron: app.quit; headless: process.exit)
 *
 * bringChromeToFront: Chrome otomasi adalah proses terpisah milik Playwright; Electron tidak punya API untuk
 * memfokuskan jendela proses lain, dan Windows hanya mengizinkan SetForegroundWindow dari proses yang sedang
 * di depan. page.bringToFront() (CDP) mengaktifkan tab tapi tidak selalu menaikkan jendelanya, jadi cara
 * lama tetap dipakai di kedua mode: WScript.Shell AppActivate('Chrome') lewat PowerShell tersembunyi.
 *
 * Dialog file/folder: hanya satu boleh terbuka sekaligus (laporan 2026-11-05: klik kedua saat dialog
 * lambat muncul membuka DUA dialog) - pick() menjawab { busy: true } selama dialog lain masih terbuka. */
const { exec } = require('child_process');

const headless = {
    kind: 'headless',
    showDashboard: async () => false,
    closeDashboard: () => {},
    pickFile: async () => null,
    pickFolder: async () => null,
    showErrorBox: (title, msg) => { console.error((title || 'Taxio Pilot') + ': ' + msg); },
    bringChromeToFront: () => {
        if (process.platform !== 'win32') return;
        // windowsHide: exec() selalu lewat cmd.exe; tanpa ini jendela konsol berkedip tiap kali.
        exec('powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Chrome\')"', { windowsHide: true }, () => {});
    },
    canEncrypt: () => false,
    encryptString: () => { throw new Error('Enkripsi tidak tersedia di mode ini.'); },
    decryptString: () => { throw new Error('Enkripsi tidak tersedia di mode ini.'); },
    isPackaged: () => false,
    exePath: () => process.execPath,
    exit: (code) => process.exit(code || 0)
};
const KEYS = Object.keys(headless);

let impl = Object.assign({}, headless);

/** Pasang implementasi platform (sebagian boleh). Kunci yang tidak dikenal ditolak - salah ketik tidak boleh diam-diam diabaikan. */
function register(partial) {
    for (const k of Object.keys(partial || {})) if (!KEYS.includes(k)) throw new Error('shell.register: kunci tidak dikenal: ' + k);
    impl = Object.assign({}, headless, partial || {});
}
/** Kembali ke implementasi headless (tes). */
function reset() { impl = Object.assign({}, headless); busy = false; }

/** Filter dialog gaya WinForms dari dashboard ("Excel Files (*.xlsx)|*.xlsx|All Files (*.*)|*.*") ->
 *  filter Electron [{ name, extensions }]. Pola tanpa ekstensi yang jelas menjadi '*'. */
function parseFilter(filter) {
    const parts = String(filter || '').split('|');
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const name = parts[i].trim();
        const exts = parts[i + 1].split(';').map((p) => p.trim().replace(/^\*\.?/, '').toLowerCase()).filter(Boolean)
            .map((e) => (/^[a-z0-9]+$/.test(e) ? e : '*'));
        if (!name) continue;
        out.push({ name, extensions: exts.length ? Array.from(new Set(exts)) : ['*'] });
    }
    return out.length ? out : [{ name: 'Semua File', extensions: ['*'] }];
}

let busy = false;
/** { kind: 'file'|'folder', title, filter (gaya WinForms), dir } -> path, null bila dibatalkan / tidak
 *  tersedia, atau { busy: true } bila dialog lain masih terbuka. Tidak pernah melempar. */
async function pick(req) {
    if (busy) return { busy: true };
    busy = true;
    try {
        const r = req || {};
        const p = r.kind === 'folder'
            ? await impl.pickFolder({ title: r.title || 'Pilih Folder' })
            : await impl.pickFile({ title: r.title || 'Pilih File', filters: parseFilter(r.filter), defaultPath: r.dir || undefined });
        return typeof p === 'string' && p ? p : null;
    } catch (e) {
        try { require('./log').log('Dialog pilih ' + ((req && req.kind) === 'folder' ? 'folder' : 'file') + ' gagal: ' + e.message); } catch (e2) { /* abaikan */ }
        return null;
    } finally { busy = false; }
}

const api = {
    register, reset, parseFilter, pick,
    get kind() { return impl.kind; },
    showDashboard: (url) => Promise.resolve().then(() => impl.showDashboard(url)).catch(() => false),
    closeDashboard: () => { try { impl.closeDashboard(); } catch (e) { /* abaikan */ } },
    showErrorBox: (title, msg) => { try { impl.showErrorBox(title, msg); } catch (e) { console.error(msg); } },
    bringChromeToFront: () => { try { impl.bringChromeToFront(); } catch (e) { /* abaikan */ } },
    canEncrypt: () => { try { return !!impl.canEncrypt(); } catch (e) { return false; } },
    encryptString: (text) => impl.encryptString(text),
    decryptString: (b64) => impl.decryptString(b64),
    isPackaged: () => { try { return !!impl.isPackaged(); } catch (e) { return false; } },
    exePath: () => impl.exePath(),
    exit: (code) => impl.exit(code)
};
module.exports = api;
