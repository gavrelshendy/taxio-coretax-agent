/* Chrome automation primitives: downloads - the automated-download transit folder (DOWNLOAD_DIR),
 * per-window switching between Chrome's own downloads and Playwright interception, the shared
 * downloadFlag, and the Kode Billing blob-PDF bridge. Owns all download state. Split out of
 * lib/chrome.js (still the public entry point). */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log } = require('./log');

// Transit unduhan OTOMATIS saja (Kode Billing; wajib ada untuk Playwright) - unduhan yang dilakukan pengguna
// sendiri masuk Downloads biasa (useNativeDownloads). Sejak v3.0.0 di luar folder Downloads pengguna;
// folder lama Downloads\.coretax-temp dihapus clearDownloadTemp(). Semua lokasi dari lib/paths.js.
const paths = require('./paths');
const DOWNLOAD_DIR = paths.downloadTempDir();
// Hanya bila home asli boleh dipakai (bukan tes / smoke run dengan TAXIO_PILOT_DATA_DIR).
const LEGACY_DOWNLOAD_DIR = paths.legacyHome() ? path.join(paths.legacyHome(), 'Downloads', '.coretax-temp') : null;
try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (e) {}

/** Empties DOWNLOAD_DIR (transit unduhan otomatis, Playwright's own downloadsPath - files land here
 *  with an internal GUID name and are read straight back by the automation, e.g. Kode Billing).
 *  Manual downloads no longer pass through here (Chrome saves them to Downloads itself). Also removes
 *  the pre-v3 Downloads\.coretax-temp folder. Best-effort per-entry: a file still locked by an
 *  in-progress download is skipped and swept up next time. Called on startup and on quit
 *  (see main.js / gui/server.js's handleQuit). */
function clearDownloadTemp() {
    let cleared = 0;
    for (const dir of [DOWNLOAD_DIR, LEGACY_DOWNLOAD_DIR].filter(Boolean)) {
        let entries;
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of entries) {
            try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); cleared++; }
            catch (e) { /* still in use - leave it, next cleanup will catch it */ }
        }
    }
    if (LEGACY_DOWNLOAD_DIR) { try { fs.rmdirSync(LEGACY_DOWNLOAD_DIR); } catch (e) { /* tidak ada / masih terisi */ } }
    if (cleared) log('Membersihkan ' + cleared + ' file sisa unduhan sementara.');
}

// Shared with automation/ebupot.js (and any future automation module): set true for the
// duration of an automated row-download click so the context-level manual-download listener
// below can skip it - without this, BOTH the automated code's own download.saveAs(renamed
// path) AND this listener's download.saveAs(original Coretax filename) fire for the exact
// same download event, leaving two copies of every file on disk (one bug report already
// traced back to this missing guard - the original coretax-helper had it as _isAutomatedDownloading).
const downloadFlag = { automated: false };
// Per jendela, bukan global: beberapa sesi bisa berjalan bersamaan (lib/runcontrol.js), dan
// unduhan otomatis di satu jendela tidak boleh membuat unduhan manual di jendela lain diabaikan.
const _automatedDownloads = new WeakMap();
/** Permintaan user 2026-10-19: unduhan yang dilakukan SENDIRI di jendela Coretax harus seperti Chrome biasa
 *  (masuk Downloads dengan nama asli, bisa langsung dibuka dari Chrome) - bukan disadap Playwright ke
 *  .coretax-temp dengan nama acak. Jendela memakai unduhan normal Chrome; penyadapan Playwright hanya
 *  dinyalakan selama unduhan otomatis (markAutomatedDownload), lalu dikembalikan. Sandbox tidak berubah. */
const _nativeDownloads = new WeakSet();
// Pengaturan unduhan lewat CDP hanya berlaku selama sesi CDP yang memasangnya masih terbuka (terbukti
// 2026-10-19: sesi ditutup = penyadapan hilang), jadi sesinya disimpan per jendela, bukan ditutup.
const _downloadSessions = new WeakMap(); // context -> { page, cdp }
async function setDownloadBehavior(context, automated) {
    try {
        let s = _downloadSessions.get(context);
        if (!s || s.page.isClosed()) {
            const page = context.pages().find((p) => !p.isClosed());
            if (!page) return false;
            s = { page, cdp: await context.newCDPSession(page) };
            _downloadSessions.set(context, s);
        }
        await s.cdp.send('Browser.setDownloadBehavior', automated
            ? { behavior: 'allowAndName', downloadPath: DOWNLOAD_DIR, eventsEnabled: true }
            : { behavior: 'default' });
        return true;
    } catch (e) {
        _downloadSessions.delete(context);
        log('Pengaturan unduhan Chrome tidak bisa diubah (' + e.message + ') - unduhan tetap disadap seperti sebelumnya.');
        return false;
    }
}
/** Jendela ini memakai unduhan normal Chrome (dipanggil setelah jendela dibuka / dipakai ulang). */
async function useNativeDownloads(context) {
    if (_automatedDownloads.has(context)) return;
    if (await setDownloadBehavior(context, false)) _nativeDownloads.add(context);
}
async function markAutomatedDownload(page, on) {
    const context = page && page.context ? page.context() : null;
    if (!context) return;
    const before = _automatedDownloads.get(context) || 0;
    const n = before + (on ? 1 : -1);
    if (n > 0) _automatedDownloads.set(context, n); else _automatedDownloads.delete(context);
    // Penyadapan Playwright dinyalakan hanya selama ada unduhan otomatis di jendela ini.
    if (_nativeDownloads.has(context) && (before === 0) !== (n <= 0)) await setDownloadBehavior(context, n > 0);
}
function isAutomatedDownload(context) { return downloadFlag.automated || _automatedDownloads.has(context); }

// Chrome 152 can terminate with 0xC0000005 when Playwright 1.61 drives Coretax's blob: PDF
// download (confirmed live on BILLING_CODE_*.pdf). Bypass only that narrow browser-download
// path: retain the Blob in the page, send its bytes to Node, and save the identical PDF to the
// user's Downloads folder. No tab/window close behavior is changed.
const BILLING_BLOB_BRIDGE_INIT = `(() => {
    if (window.__coretaxAgentBillingBlobBridgeInstalled) return;
    const blobs = new Map();
    const delivering = new WeakSet();
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const nativeAnchorClick = HTMLAnchorElement.prototype.click;

    URL.createObjectURL = function (object) {
        const objectUrl = nativeCreateObjectURL(object);
        if (object instanceof Blob) blobs.set(objectUrl, object);
        return objectUrl;
    };
    URL.revokeObjectURL = function (objectUrl) {
        setTimeout(() => blobs.delete(String(objectUrl)), 30000);
        return nativeRevokeObjectURL(objectUrl);
    };

    const captureBillingPdf = (anchor) => {
        if (!anchor || delivering.has(anchor)) return false;
        // Backslash digandakan: ini isi template string. Dengan satu backslash regex menjadi
        // "//payment-portal..." - komentar JavaScript - dan seluruh skrip ini SyntaxError, sehingga
        // bridge tak pernah aktif dan "Lihat" di Daftar Kode Billing Belum Dibayar tetap membuat
        // Chrome crash (live 2026-10-05, KENCANA ALAM PUTRA).
        if (!/\\/payment-portal\\/[^/]+\\/active-dashboard-billing-code/i.test(location.pathname)) return false;
        const filename = String(anchor.download || '');
        const objectUrl = String(anchor.href || '');
        const blob = blobs.get(objectUrl);
        if (!/^BILLING_CODE_[A-Za-z0-9._-]*\\.pdf$/i.test(filename) || !blob) return false;
        delivering.add(anchor);
        void (async () => {
            try {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                let binary = '';
                for (let i = 0; i < bytes.length; i += 32768) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
                }
                await window.__ca_saveBillingBlobV116({ filename, base64: btoa(binary) });
            } catch (error) {
                try { console.error('[Coretax Agent] Gagal menyimpan Blob billing:', error); } catch (_) {}
            }
        })();
        return true;
    };

    HTMLAnchorElement.prototype.click = function () {
        if (captureBillingPdf(this)) return;
        return nativeAnchorClick.apply(this, arguments);
    };
    // Jalur yang benar-benar dipakai "Lihat" (live 2026-10-05): dispatchEvent(click) pada anchor
    // yang tidak menempel di dokumen, jadi tak lewat a.click() maupun pendengar klik di document.
    const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
        if (this instanceof HTMLAnchorElement && event && event.type === 'click' && captureBillingPdf(this)) return false;
        return nativeDispatchEvent.apply(this, arguments);
    };
    document.addEventListener('click', (event) => {
        const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
        if (captureBillingPdf(anchor)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    window.__coretaxAgentBillingBlobBridgeInstalled = true;
})();`;

const _billingBlobBridgeContexts = new WeakSet();

async function installBillingBlobDownloadBridge(context, page) {
    if (!_billingBlobBridgeContexts.has(context)) {
        _billingBlobBridgeContexts.add(context);
        await context.exposeFunction('__ca_saveBillingBlobV116', async ({ filename, base64 }) => {
            const safeName = path.basename(String(filename || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
            if (!/^BILLING_CODE_[A-Za-z0-9._-]*\.pdf$/i.test(safeName)) throw new Error('Nama file billing tidak valid.');
            const data = Buffer.from(String(base64 || ''), 'base64');
            if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('Ukuran PDF billing tidak valid.');
            const destination = path.join(os.homedir(), 'Downloads', safeName);
            await fs.promises.writeFile(destination, data);
            log('[Billing] PDF disimpan tanpa jalur Blob Chrome: ' + destination);
            return true;
        }).catch((e) => log('[Billing] Gagal memasang penyimpan Blob: ' + e.message));
        await context.addInitScript({ content: BILLING_BLOB_BRIDGE_INIT }).catch(() => {});
        context.on('page', (newPage) => newPage.evaluate(BILLING_BLOB_BRIDGE_INIT).catch(() => {}));
    }
    if (page && !page.isClosed()) await page.evaluate(BILLING_BLOB_BRIDGE_INIT).catch(() => {});
}

module.exports = {
    DOWNLOAD_DIR, LEGACY_DOWNLOAD_DIR, clearDownloadTemp, downloadFlag, _automatedDownloads, _nativeDownloads, _downloadSessions,
    setDownloadBehavior, useNativeDownloads, markAutomatedDownload, isAutomatedDownload,
    BILLING_BLOB_BRIDGE_INIT, _billingBlobBridgeContexts, installBillingBlobDownloadBridge
};
