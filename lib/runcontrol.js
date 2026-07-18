/* Coretax Agent - live run control (pause / resume / skip current filter combo / stop).
   One automation run at a time. The automation loop calls checkpoint() between rows and
   pages; that's where a pause actually holds, and where a stop/skip request takes effect -
   so control is responsive (within one row's work) without ever interrupting a row's
   download mid-flight, which is exactly what used to cause the duplicate/missed-file mess
   in the old extension-based approach. */
const { log } = require('./log');

class StopRunError extends Error { constructor() { super('Proses dihentikan oleh pengguna.'); this.isStop = true; } }
class SkipComboError extends Error { constructor() { super('Kombinasi filter saat ini dilewati oleh pengguna.'); this.isSkip = true; } }
class RetryComboError extends Error { constructor() { super('Kombinasi filter saat ini diulang dari awal oleh pengguna.'); this.isRetry = true; } }
class BackComboError extends Error { constructor() { super('Kembali ke kombinasi filter sebelumnya atas permintaan pengguna.'); this.isBack = true; } }

const run = { active: false, paused: false, stopRequested: false, skipRequested: false, retryRequested: false, backRequested: false, label: '', pageSizeOverride: null, currentPageSize: null, coretaxAs: '' };

function _resetFlags() { run.paused = false; run.stopRequested = false; run.skipRequested = false; run.retryRequested = false; run.backRequested = false; run.pageSizeOverride = null; }
function start(label) {
    if (run.active) throw new Error('Masih ada proses lain yang berjalan - tunggu selesai atau hentikan dulu.');
    _resetFlags();
    run.active = true; run.label = label || '';
}
function finish() { run.active = false; run.label = ''; run.coretaxAs = ''; run.currentPageSize = null; _resetFlags(); }
function setCoretaxAs(name) { run.coretaxAs = name || ''; } // who we're logged into Coretax as during this run
function pause() { if (run.active && !run.paused) { run.paused = true; log('⏸ Proses dijeda - klik Lanjut untuk meneruskan.'); } }
/** Like pause(), but used internally when a combo fails: holds the run so the user can decide
 *  (Retry / Back / Skip / or fix the browser manually then Resume) instead of auto-skipping. */
function pauseForDecision(reason) { if (run.active) { run.paused = true; log('⏸ DIJEDA karena masalah: ' + reason + ' - pilih 🔁 Ulang / ⏭ Lewati / ⏮ Mundur, atau perbaiki sendiri di jendela Coretax lalu klik ▶ Lanjut.'); } }
function resume() { if (run.active && run.paused) { run.paused = false; log('▶ Proses dilanjutkan.'); } }
function stop() { if (run.active) { run.stopRequested = true; run.paused = false; log('⏹ Permintaan berhenti diterima - berhenti setelah baris saat ini selesai.'); } }
function skip() { if (run.active) { run.skipRequested = true; run.paused = false; log('⏭ Permintaan lewati diterima - kombinasi saat ini dilewati, lanjut ke berikutnya.'); } }
function retry() { if (run.active) { run.retryRequested = true; run.paused = false; log('🔁 Permintaan ulangi diterima - kombinasi saat ini diulang dari awal (file yang sudah ada dilewati otomatis).'); } }
function back() { if (run.active) { run.backRequested = true; run.paused = false; log('⏮ Permintaan mundur diterima - kembali ke kombinasi sebelumnya (file yang sudah ada dilewati otomatis).'); } }

/** Called by the automation between rows/pages. Throws a control error when the user asked
 *  for skip/retry/back/stop; blocks (politely, 300ms poll) while paused. Thanks to the
 *  per-folder download manifest, retry/back never re-download files that already exist -
 *  they only re-walk the pages and fill gaps, so redoing a combo is cheap and safe. */
async function checkpoint() {
    for (;;) {
        if (run.stopRequested) throw new StopRunError();
        if (run.retryRequested) { run.retryRequested = false; throw new RetryComboError(); }
        if (run.backRequested) { run.backRequested = false; throw new BackComboError(); }
        if (run.skipRequested) { run.skipRequested = false; throw new SkipComboError(); }
        if (!run.paused) return;
        await new Promise((r) => setTimeout(r, 300));
    }
}

function status() { return { active: run.active, paused: run.paused, label: run.label, currentPageSize: run.currentPageSize, coretaxAs: run.coretaxAs }; }

// Live page-size override: the user watches the site and forces a size mid-run. The download
// loop reads it at the next page boundary via takePageSizeOverride() (which clears it).
function setPageSizeOverride(n) { if (run.active) { run.pageSizeOverride = n; log('📄 Override manual: baris per halaman diminta jadi ' + n + ' (berlaku di halaman berikutnya).'); } }
function takePageSizeOverride() { const v = run.pageSizeOverride; run.pageSizeOverride = null; return v; }
function reportPageSize(n) { run.currentPageSize = n; } // loop reports its actual current size (for the GUI)

module.exports = { start, finish, pause, pauseForDecision, resume, stop, skip, retry, back, checkpoint, status, setCoretaxAs, setPageSizeOverride, takePageSizeOverride, reportPageSize, StopRunError, SkipComboError, RetryComboError, BackComboError };
