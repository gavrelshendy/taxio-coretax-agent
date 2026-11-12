/* Chrome automation primitives: the per-PIC Chrome profile and process - profile roots, launch
 * options and flags, Preferences tweaks, and closing a leftover Chrome from a previous run that
 * still holds a PIC's profile. Split out of lib/chrome.js (still the public entry point). */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log } = require('./log');
const paths = require('./paths');

// Profil per PIC sejak Tahap 1 di %LOCALAPPDATA%\TaxioPilot\profiles\terpasang (dulu ~/.coretax-agent-profile).
const PROFILE_ROOT = paths.profileRoot('terpasang');
// Profil untuk Chrome bawaan (lib/browser.js) terpisah dari profil Chrome terpasang: profil yang pernah
// dibuka Chrome versi lebih baru tidak boleh dibuka Chrome versi lebih lama (bawaan dikunci ke versi
// Playwright), jadi tiap PIC cukup login otomatis sekali lagi di profil baru ini.
// Sejak Tahap 1 di profiles\bawaan (dulu ~/.taxio-pilot-profile).
const PROFILE_ROOT_BUNDLED = paths.profileRoot('bawaan');
/** Opsi peluncuran (Chrome bawaan bila siap, selain itu Chrome terpasang) + folder profil yang cocok. */
async function browserLaunch(name) {
    const { bundled, ...options } = await require('./browser').launchOptions();
    if (bundled) log('Memakai Chrome bawaan Taxio Pilot (versi ' + require('./browser').VERSION + ').');
    // Kunci sesi entitas lokal berbentuk "local:<entitas>:<PIC>"; titik dua (dan <>"/\|?*) tidak sah
    // di nama folder Windows - mkdir gagal ENOENT (dilaporkan 2026-10-20, entitas lokal BORWITA).
    const folder = String(name).replace(/[<>:"/\\|?*]/g, '_');
    // Lokasi baru bila ada, selain itu lokasi lama bila profil itu belum bisa dipindah (lihat lib/paths.js).
    return { options, userDataDir: paths.resolveProfileDir(bundled ? 'bawaan' : 'terpasang', folder) };
}

// Jendela otomasi sering tertutup jendela lain (termasuk jendela app ini) atau terlipat. Chrome di
// Windows lalu MENGHENTIKAN render/requestAnimationFrame-nya, padahal Playwright memakai itu untuk
// memutuskan elemen "terlihat"/"stabil" - hasilnya timeout walau elemennya sudah ada
// ("locator resolved to visible ... Timeout exceeded"), dan hanya di komputer tertentu.
const ANTI_NAG_FLAGS = [
    '--disable-features=Translate,TranslateUI,PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-sync',
    '--password-store=basic',
    '--no-default-browser-check',
    '--no-first-run',

    '--start-maximized'
];

// Chrome profil baru selalu mencari proxy otomatis (WPAD) dulu. Di jaringan/PC yang DNS suffix-nya
// membuat "wpad" ter-resolve ke server yang tidak menjawab (mis. wpad.pb-co.com), navigasi PERTAMA
// tertahan ±30 detik di about:blank sebelum Chrome menyerah dan langsung konek. Kalau Windows memang
// tidak memakai proxy/PAC, lewati pencarian itu; PC yang benar-benar memakai proxy tetap seperti biasa.
// Registry dibaca di lib/win-proxy.js (dipakai juga oleh pemeriksaan sistem lib/doctor.js).
let _proxyFlags = null;
function noWpadFlags() {
    if (_proxyFlags) return _proxyFlags;
    _proxyFlags = [];
    const p = require('./win-proxy').read();
    if (p.known && !p.enabled && !p.pac) _proxyFlags = ['--no-proxy-server'];
    return _proxyFlags;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


function disableAnnoyingPrompts(userDataDir) {
    try {
        const prefsDir = path.join(userDataDir, 'Default');
        fs.mkdirSync(prefsDir, { recursive: true });
        const prefsPath = path.join(prefsDir, 'Preferences');
        let prefs = {};
        if (fs.existsSync(prefsPath)) {
            try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch (e) { prefs = {}; }
        }
        prefs.credentials_enable_service = false;
        prefs.profile = prefs.profile || {};
        prefs.profile.password_manager_enabled = false;
        prefs.profile.password_manager_leak_detection = false;
        prefs.signin = prefs.signin || {}; prefs.signin.allowed = false; prefs.signin.allowed_on_next_startup = false;
        prefs.translate = prefs.translate || {}; prefs.translate.enabled = false;
        prefs.translate_blocked_languages = ['id', 'en'];
        prefs.download = prefs.download || {};
        // Unduhan yang dilakukan pengguna sendiri: folder Downloads biasa, seperti Chrome harian (unduhan
        // otomatis tetap ke DOWNLOAD_DIR lewat setDownloadBehavior - lihat markAutomatedDownload).
        prefs.download.default_directory = path.join(os.homedir(), 'Downloads');
        prefs.download.prompt_for_download = false;
        prefs.download.directory_upgrade = true;
        prefs.plugins = prefs.plugins || {};
        prefs.plugins.always_open_pdf_externally = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch (e) {
        log('Tidak bisa menonaktifkan prompt simpan-sandi/terjemahan (bukan fatal): ' + e.message);
    }
}

/* Leftover Chrome from a PREVIOUS app run (2026-11-12 audit). Automation windows used to be
 * launched with --remote-debugging-port=<9700 + hash(picId)%400> so that, when
 * launchPersistentContext failed because an orphaned window from an earlier run still held the
 * PIC's profile, the app could reattach over CDP. That port was an unauthenticated, predictable
 * DevTools endpoint on a logged-in Coretax session (any local process could drive it), so it is
 * gone. Instead the orphan is closed: find chrome.exe processes whose command line carries
 * EXACTLY this PIC's --user-data-dir (each PIC has its own folder under PROFILE_ROOT /
 * PROFILE_ROOT_BUNDLED or their legacy home roots, so the match can't hit the user's own daily
 * Chrome or another PIC),
 * terminate only those, then launch again once. Nothing outside this app's own profile roots is
 * ever touched (isOwnProfileDir guards the target path itself too). Developer-only live scripts
 * (scripts/*-live.js on port 9741) now need a manually started Chrome with
 * --remote-debugging-port. */

/** The --user-data-dir value in one Windows command line, or null. Handles the three shapes
 *  Playwright/Chrome produce: --user-data-dir=C:\x, "--user-data-dir=C:\a b" and
 *  --user-data-dir="C:\a b". */
function userDataDirFromCommandLine(cmd) {
    const s = String(cmd || '');
    const key = '--user-data-dir=';
    const i = s.indexOf(key);
    if (i === -1) return null;
    let v = s.slice(i + key.length);
    if (i > 0 && s[i - 1] === '"') { const end = v.indexOf('"'); return end === -1 ? v : v.slice(0, end); }
    if (v[0] === '"') { v = v.slice(1); const end = v.indexOf('"'); return end === -1 ? v : v.slice(0, end); }
    const m = /^[^\s"]*/.exec(v);
    return m ? m[0] : null;
}
function _normDir(p) { return path.win32.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase(); }
/** True only for a direct child folder of this app's own profile roots - the Tahap 1 roots under
 *  %LOCALAPPDATA%\TaxioPilot\profiles AND the legacy home roots (a profile whose move failed keeps
 *  running from there; see lib/paths.js resolveProfileDir). */
function isOwnProfileDir(dir, roots) {
    const d = _normDir(dir);
    return (roots || paths.allProfileRoots()).some((r) => {
        const root = _normDir(r);
        return d.startsWith(root + '\\') && d.slice(root.length + 1).length > 0 && d.slice(root.length + 1).indexOf('\\') === -1;
    });
}
/** PIDs (browser process first, then its helpers) among `procs` [{ pid, ppid, name, commandLine }]
 *  that are chrome.exe running on exactly `userDataDir`. Empty when `userDataDir` is not one of
 *  this app's own profile folders. */
function findProfileProcessPids(procs, userDataDir, roots) {
    if (!userDataDir || !isOwnProfileDir(userDataDir, roots)) return [];
    const target = _normDir(userDataDir);
    const hits = (procs || []).filter((p) => p && /^chrome\.exe$/i.test(String(p.name || ''))
        && Number.isInteger(p.pid) && p.pid > 0 && p.pid !== process.pid
        && (() => { const d = userDataDirFromCommandLine(p.commandLine); return d !== null && _normDir(d) === target; })());
    const pids = new Set(hits.map((p) => p.pid));
    // Browser (root) processes first: killing it takes its renderer/GPU children down with it.
    return hits.slice().sort((a, b) => (pids.has(a.ppid) ? 1 : 0) - (pids.has(b.ppid) ? 1 : 0)).map((p) => p.pid);
}
/** All running chrome.exe processes with their command lines (Windows; [] elsewhere/on error).
 *  Hidden PowerShell + CIM - wmic is deprecated/absent on recent Windows. */
function listChromeProcesses() {
    if (process.platform !== 'win32') return Promise.resolve([]);
    const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    return new Promise((resolve) => {
        require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
                if (err) { log('Tidak bisa membaca daftar proses Chrome: ' + err.message); return resolve([]); }
                try {
                    const text = String(stdout || '').trim();
                    if (!text) return resolve([]);
                    const arr = [].concat(JSON.parse(text));
                    resolve(arr.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, commandLine: p.CommandLine || '' })));
                } catch (e) { log('Daftar proses Chrome tidak terbaca: ' + e.message); resolve([]); }
            });
    });
}
const _profileProcDeps = { list: listChromeProcesses, kill: (pid) => process.kill(pid), sleep: (ms) => _sleep(ms) };
/** Closes the Chrome processes holding `userDataDir` (see the block comment above). Resolves to
 *  the number of processes it terminated. `deps` only for tests. */
async function terminateProfileProcesses(userDataDir, deps) {
    const d = Object.assign({}, _profileProcDeps, deps || {});
    const pids = findProfileProcessPids(await d.list(), userDataDir);
    if (!pids.length) return 0;
    log('Menutup ' + pids.length + ' proses Chrome sisa sesi sebelumnya yang masih memakai profil ini...');
    let killed = 0;
    for (const pid of pids) { try { d.kill(pid); killed++; } catch (e) { /* already gone with its parent */ } }
    // Wait (max ~5s) until none of them is left, so the profile lock is released before relaunch.
    for (let i = 0; i < 10; i++) {
        await d.sleep(500);
        const left = findProfileProcessPids(await d.list(), userDataDir);
        if (!left.length) break;
    }
    return killed;
}

module.exports = {
    PROFILE_ROOT, PROFILE_ROOT_BUNDLED, browserLaunch, ANTI_NAG_FLAGS, noWpadFlags, _sleep, disableAnnoyingPrompts,
    userDataDirFromCommandLine, _normDir, isOwnProfileDir, findProfileProcessPids, listChromeProcesses, _profileProcDeps,
    terminateProfileProcesses
};
