/* Auto-update: checks GitHub Releases for a newer coretax-agent.exe, downloads it, and swaps
 * it into place - explicit user request 2026-08-07 ("instead download file baru, bisa cek
 * update dri coretax agentnya dan update disana?") in preference over manually re-downloading
 * from Taxio Hub every release.
 *
 * Windows won't let a running .exe overwrite its own file on disk (it's locked while executing),
 * so the actual swap can't happen from inside this process - the pattern here is: download the
 * new exe to a temp path, write a small PowerShell script that waits for THIS process to exit,
 * copies the new exe over the old path, and relaunches it, spawn that script detached, then quit
 * gracefully. If the download is incomplete/corrupt (size mismatch against what GitHub reports)
 * or the swap script's own copy fails for any reason, it falls back to relaunching the OLD exe
 * untouched - a failed update should never leave the user with nothing running. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const { log } = require('./log');

const REPO = 'gavrelshendy/taxio-coretax-agent';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function currentVersion() {
    try { return require('../package.json').version; } catch (e) { return null; }
}

/** "1.10.4" vs "1.10.10" - plain string/localeCompare would get this wrong, so compare
 *  numerically per dot-separated segment. Returns true if `a` is strictly newer than `b`. */
function isNewer(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** Returns { available, version, notes, assetUrl, assetSize } if a newer release exists (with an
 *  attached .exe), or { available: false } otherwise/on any failure - a broken update check
 *  (network down, GitHub rate limit, etc.) should never block the app from starting normally. */
async function checkForUpdate() {
    const current = currentVersion();
    if (!current) return { available: false };
    try {
        const res = await fetch(LATEST_RELEASE_API, { headers: { 'User-Agent': 'coretax-agent', Accept: 'application/vnd.github+json' } });
        if (!res.ok) { log('Cek update gagal: HTTP ' + res.status); return { available: false }; }
        const release = await res.json();
        const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
        if (!latestVersion || !isNewer(latestVersion, current)) return { available: false, latestVersion, current };
        const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name));
        if (!asset) { log('Update ' + latestVersion + ' ditemukan tapi tidak ada file .exe terlampir.'); return { available: false }; }
        return { available: true, version: latestVersion, notes: release.body || '', assetUrl: asset.browser_download_url, assetSize: asset.size, current };
    } catch (e) {
        log('Cek update gagal: ' + e.message);
        return { available: false };
    }
}

/** Downloads the new exe to a temp path, verifies its size matches what GitHub reported (cheap
 *  sanity check against a truncated/interrupted download), writes the swap script, spawns it
 *  detached, and resolves once the swap is queued - the CALLER is responsible for actually
 *  quitting afterward (this module never exits the process itself, so callers can run their own
 *  graceful shutdown - closing automation windows etc. - first, same as /api/quit already does). */
async function downloadAndPrepareSwap(update) {
    const tmpDir = path.join(os.tmpdir(), 'coretax-agent-update');
    fs.mkdirSync(tmpDir, { recursive: true });
    const newExePath = path.join(tmpDir, 'coretax-agent-new.exe');
    log('Mengunduh update v' + update.version + '...');
    const res = await fetch(update.assetUrl);
    if (!res.ok) throw new Error('Unduhan gagal: HTTP ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (update.assetSize && buffer.length !== update.assetSize) {
        throw new Error('Ukuran file unduhan tidak sesuai (' + buffer.length + ' vs ' + update.assetSize + ' byte) - kemungkinan unduhan terputus.');
    }
    fs.writeFileSync(newExePath, buffer);
    log('Update terunduh (' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB). Menyiapkan pemasangan...');

    // Self-update only ever makes sense for the packaged exe (dev mode via `node main.js` has no
    // single exe to swap) - process.execPath is that exe's own real path when running under pkg.
    // Deliberately NOT built via path.join with a literal 'dist'/'coretax-agent.exe' segment -
    // pkg's static analyzer read that as a real asset reference and tried to bundle
    // dist/coretax-agent.exe INTO ITSELF ("Trying to take executable into executable"), since
    // that path is this very build's own output.
    const oldExePath = process.execPath;
    const swapScriptPath = path.join(tmpDir, 'swap.ps1');
    const swapScript = `
param([int]$OldPid, [string]$OldPath, [string]$NewPath)
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
    if (-not $p) { break }
    Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 700
try {
    Copy-Item -Path $NewPath -Destination $OldPath -Force
    Remove-Item -Path $NewPath -Force -ErrorAction SilentlyContinue
} catch {
    # Swap failed (still locked, permission issue, etc.) - leave the old exe untouched and just
    # relaunch it, so a failed update never leaves the user with nothing running.
}
Start-Process -FilePath $OldPath
`;
    fs.writeFileSync(swapScriptPath, swapScript, 'utf8');

    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', swapScriptPath, '-OldPid', String(process.pid), '-OldPath', oldExePath, '-NewPath', newExePath], {
        detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
    log('Update siap dipasang - aplikasi akan tertutup dan terbuka ulang otomatis...');
}

/** Full check-and-apply cycle, safe to call on every startup and from a manual "check now"
 *  button alike. Never applies while an automation run is active (checked by the caller passing
 *  `isRunActive`) - a self-restart mid-run would silently kill whatever the user was doing.
 *  `onBeforeRestart` is the caller's OWN full graceful-quit-and-exit sequence (POSTing to this
 *  same app's own /api/quit reuses the exact same closing-automation-windows/dashboard/exit
 *  logic already proven for a normal manual quit, rather than this module duplicating any of
 *  it) - called only once an update is actually ready to apply, and expected to terminate the
 *  process itself; this function never calls process.exit() on its own. */
async function checkAndApply({ isRunActive, onBeforeRestart }) {
    const update = await checkForUpdate();
    if (!update.available) return update;
    if (isRunActive && isRunActive()) {
        log('Update v' + update.version + ' ditemukan tapi ada proses otomasi berjalan - ditunda sampai restart berikutnya.');
        return update;
    }
    try {
        await downloadAndPrepareSwap(update);
        if (onBeforeRestart) await onBeforeRestart();
    } catch (e) {
        log('Gagal menerapkan update: ' + e.message);
    }
    return update;
}

module.exports = { checkForUpdate, checkAndApply, isNewer, currentVersion };
