/* Chrome bawaan Taxio Pilot: Chrome for Testing dengan versi yang PERSIS dipasangkan dengan Playwright
 * (playwright-core/browsers.json), supaya otomasi tidak bergantung pada Chrome yang terpasang di tiap PC -
 * tidak ada, versi berbeda, atau ter-update melewati yang didukung Playwright.
 *
 * Diunduh SEKALI saat pertama dibutuhkan (dan dipancing di awal aplikasi) ke
 * %LOCALAPPDATA%\TaxioPilot\chrome\<versi>\, dicocokkan dengan SHA-256 yang dikunci di sini, lalu dipakai
 * terus; exe Pilot sendiri tetap kecil dan update-nya tidak ikut membawa Chrome. Sumber: cermin di rilis
 * GitHub Pilot, cadangannya server resmi Chrome for Testing. Bila semuanya gagal, Pilot kembali memakai
 * Chrome yang terpasang (channel 'chrome', perilaku lama). CORETAX_BUNDLED_CHROME=0 mematikan semuanya. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const { log } = require('./log');

// browsers.json tidak diekspor paketnya (require gagal), jadi dibaca dari folder playwright-core.
const VERSION = (() => {
    try {
        const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
        return ((JSON.parse(fs.readFileSync(file, 'utf8')).browsers || []).find((b) => b.name === 'chromium') || {}).browserVersion;
    } catch (e) { return null; }
})();
// SHA-256 resmi chrome-win64.zip per versi. Versi Playwright baru = tambahkan baris (hitung dari unduhan resmi).
const SHA256 = {
    '149.0.7827.55': 'ebc0c2b75e2ea98151a7f18ff47037bfcbab44a8660e79b9ffa6520f9b7607ab'
};
const SOURCES = (v) => [
    'https://github.com/gavrelshendy/taxio-coretax-agent/releases/download/chrome-' + v + '/chrome-win64.zip',
    'https://storage.googleapis.com/chrome-for-testing-public/' + v + '/win64/chrome-win64.zip'
];
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TaxioPilot', 'chrome');
const versionDir = () => path.join(ROOT, VERSION || 'unknown');
const exePath = () => path.join(versionDir(), 'chrome-win64', 'chrome.exe');
const MARKER = '.terpasang';

const disabled = () => process.env.CORETAX_BUNDLED_CHROME === '0' || process.platform !== 'win32' || !VERSION || !SHA256[VERSION];
const isReady = () => !disabled() && fs.existsSync(exePath()) && fs.existsSync(path.join(versionDir(), MARKER));

async function downloadTo(url, file, expectedSha) {
    const res = await fetch(url, { headers: { 'User-Agent': 'taxio-pilot' } });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0, shown = 0;
    for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk); got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const pct = total ? Math.floor(got * 100 / total) : 0;
        if (pct >= shown + 20) { shown = pct - pct % 20; log('Mengunduh Chrome bawaan: ' + shown + '% (' + (got / 1048576).toFixed(0) + ' MB)'); }
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    const sha = hash.digest('hex');
    if (sha !== expectedSha) throw new Error('isi file tidak cocok (SHA-256 ' + sha.slice(0, 12) + '…)');
}

function extract(zip, dest) {
    // tar.exe bawaan Windows 10+ membuka zip; Expand-Archive sebagai cadangan.
    const tar = spawnSync('tar', ['-xf', zip, '-C', dest], { windowsHide: true });
    if (tar.status === 0) return;
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:TP_ZIP -DestinationPath $env:TP_DEST -Force'],
        { windowsHide: true, env: { ...process.env, TP_ZIP: zip, TP_DEST: dest } });
    if (ps.status !== 0) throw new Error('ekstrak gagal: ' + String(ps.stderr || tar.stderr || '').slice(0, 200));
}

async function install() {
    fs.mkdirSync(ROOT, { recursive: true });
    const zip = path.join(ROOT, 'chrome-' + VERSION + '.zip.part');
    const staging = versionDir() + '.sementara';
    log('Menyiapkan Chrome bawaan Taxio Pilot (versi ' + VERSION + ', sekali saja, ±185 MB)...');
    let lastError = null;
    for (const url of SOURCES(VERSION)) {
        try { await downloadTo(url, zip, SHA256[VERSION]); lastError = null; break; }
        catch (e) { lastError = e; log('Sumber Chrome bawaan tidak bisa dipakai (' + new URL(url).host + '): ' + e.message); }
    }
    if (lastError) throw lastError;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    extract(zip, staging);
    if (!fs.existsSync(path.join(staging, 'chrome-win64', 'chrome.exe'))) throw new Error('chrome.exe tidak ada di paket');
    fs.rmSync(versionDir(), { recursive: true, force: true });
    fs.renameSync(staging, versionDir());
    fs.writeFileSync(path.join(versionDir(), MARKER), new Date().toISOString());
    fs.rmSync(zip, { force: true });
    // Versi lama tidak dipakai lagi.
    for (const name of fs.readdirSync(ROOT)) if (name !== VERSION) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
    log('Chrome bawaan siap: ' + exePath());
    return exePath();
}

let pending = null;
/** Path chrome.exe bawaan (mengunduh bila belum ada), atau null bila tidak tersedia. Tidak pernah melempar. */
function ensure() {
    if (disabled()) return Promise.resolve(null);
    if (isReady()) return Promise.resolve(exePath());
    if (!pending) pending = install().catch((e) => {
        log('Chrome bawaan gagal disiapkan (' + e.message + ') - memakai Chrome yang terpasang di PC ini.');
        pending = null;
        return null;
    });
    return pending;
}

/** Opsi peluncuran Playwright: Chrome bawaan bila siap, selain itu Chrome terpasang. `bundled` memberi
 *  tahu pemanggil profil mana yang dipakai (profil Chrome versi lebih baru tidak boleh dibuka versi lama). */
async function launchOptions() {
    const executablePath = await ensure();
    return executablePath ? { executablePath, bundled: true } : { channel: 'chrome', bundled: false };
}

module.exports = { ensure, launchOptions, isReady, VERSION, ROOT, SHA256 };
