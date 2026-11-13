/* Kerangka proses untuk route aksi gui/server.js: runInBackground (202, kerja di latar), runForResult (menunggu
 * hasil) dan guarded (batas waktu + Stop untuk langkah yang hanya membaca). Dipisah dari gui/server.js supaya
 * bisa dites dengan kerja tiruan yang lambat tanpa memuat seluruh server (scripts/test-run-wrappers.js).
 *
 * Kerja yang DITINGGALKAN (audit 2026-11-12): guarded() menolak balapan saat batas waktu / Stop, tetapi
 * janji (promise) kerja Coretax di bawahnya tidak bisa dibatalkan dan tetap memakai jendela Chrome sesi itu.
 * Dulu runForResult langsung runcontrol.finish() - sesi dianggap bebas, dan aksi berikutnya bisa mulai di
 * halaman yang sama selagi permintaan lama masih berjalan. Sekarang:
 *   - guarded() mencatat janji yang ditinggalkan pada proses itu (run.abandoned) dan, bila karena batas waktu,
 *     meminta proses berhenti (stopRequested) supaya kerja yang kooperatif (checkpoint / shouldStop) cepat usai;
 *   - balasan HTTP tetap langsung keluar (bentuk, pesan dan batas waktu v3.0.45 tidak berubah);
 *   - releaseRun() menahan sesi tetap "sibuk" (run.active, run.lingering) sampai janji itu benar-benar selesai,
 *     paling lama LINGER_MAX_MS; bila tidak pernah selesai, satu baris log lalu sesi dilepas paksa. Permintaan
 *     baru untuk sesi itu selama menunggu mendapat 409 "Sesi ini masih menjalankan ..." yang sudah ada.
 * runcontrol.finish(run) dipanggil dengan proses EKSPLISIT, karena pelepasan yang tertunda bisa berjalan di luar
 * konteks AsyncLocalStorage permintaan aslinya.
 *
 * ANTREAN (2026-11-13, semua perintah bisa paralel - lib/runcontrol.js): proses yang belum mendapat jendela tidak lagi
 * ditolak 409. runInBackground tetap membalas 202 SEGERA (+ queued: true, position) lalu menunggu gilirannya; Stop
 * membatalkannya sebelum mulai. runForResult (cari / pratinjau / cek NIK - menjawab langsung) menunggu antrean paling
 * lama limits.RESULT_QUEUE_MS (30 detik) lalu tetap menjawab 409 dengan pesan lama "Sesi ini masih menjalankan ...",
 * supaya pemanggil MCP (batas panggilan 120 detik) tidak dibiarkan menggantung tanpa kabar. Perintah IDENTIK yang
 * masih antre / berjalan tetap ditolak 409 langsung. Kerja yang ditinggalkan (lihat atas) tetap menahan jendelanya. */
const { log } = require('../lib/log');
const runcontrol = require('../lib/runcontrol');
const runContext = require('../lib/run-context');
const { sendJson } = require('./http-util');

const limits = { LINGER_MAX_MS: 10 * 60 * 1000, STOP_POLL_MS: 500, RESULT_QUEUE_MS: 30 * 1000 };

function runSessionKey() { const r = runcontrol.current(); return r ? r.key : null; }

/** Melepas sesi proses `run`: segera bila tidak ada kerja yang ditinggalkan, selain itu sesudah kerja itu
 *  selesai (maks limits.LINGER_MAX_MS). Mengembalikan janji yang selesai saat sesi benar-benar dilepas. */
function releaseRun(run) {
    if (!run) return Promise.resolve();
    const pending = run.abandoned || [];
    run.abandoned = [];
    if (!pending.length) { runcontrol.finish(run); return Promise.resolve(); }
    run.lingering = true;
    runContext.within(run, () => log('Langkah Coretax yang dihentikan masih berjalan di latar - sesi ini tetap ditandai sibuk sampai langkah itu selesai (maks ' + Math.round(limits.LINGER_MAX_MS / 60000) + ' menit).'));
    let timer;
    return Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), limits.LINGER_MAX_MS); if (timer.unref) timer.unref(); })
    ]).then((settled) => {
        clearTimeout(timer);
        if (!settled) runContext.within(run, () => log('Langkah Coretax yang dihentikan tidak selesai dalam ' + Math.round(limits.LINGER_MAX_MS / 60000) + ' menit - sesi dilepas paksa. Bila proses berikutnya macet, muat ulang jendela Coretax PIC ini.'));
        if (run.active) runcontrol.finish(run);
    });
}

/** Satu proses otomasi di latar: daftar di runcontrol (antre bila belum ada jendela bebas; 409 hanya untuk perintah
 *  identik yang masih antre/berjalan), balas 202 { started, session, run, [queued, position], ...extra } segera (proses
 *  bisa berjalan bermenit-menit dan melaporkan kemajuannya lewat /events), tunggu gilirannya, jalankan `work`, lalu
 *  SELALU lepaskan sesinya (releaseRun). `session` selagi antre = "run:<id>" (berlaku untuk /api/run/status dan Stop).
 *  Galat: `quiet(e)` true = sudah dilaporkan sendiri; Stop pengguna -> log `stopMsg`; selainnya
 *  log `failPrefix + e.message`. `cleanup` berjalan sesudah pelepasan dimulai.
 *  Dipanggil dari dalam handler (alur async permintaan yang sama), karena runcontrol.start()
 *  mengikat proses ke konteks AsyncLocalStorage permintaan itu (runcontrol.isolate). */
async function runInBackground(res, { label, session, extra, onStart }, work, { stopMsg, failPrefix, quiet, cleanup } = {}) {
    let run, ready;
    try { ({ run, ready } = runcontrol.enqueue(label, session)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    if (onStart) onStart();
    const queued = run.state === 'queued' ? { queued: true, position: runcontrol.positionOf(run) } : {};
    sendJson(res, 202, Object.assign({ started: true, session: run.key, run: run.id }, queued, extra));
    try {
        await ready;
        await work();
    } catch (e) {
        if (quiet && quiet(e)) runcontrol.markFailed(run, e && e.message); // sudah dilaporkan
        else if (e && e.isStop) { const m = stopMsg || 'Proses dihentikan oleh pengguna.'; log(m); runcontrol.markStopped(run, m); }
        else { const m = (failPrefix || 'Gagal: ') + (e && e.message); log(m); runcontrol.markFailed(run, m); }
    } finally {
        releaseRun(run);
        if (cleanup) await cleanup();
    }
}

/** Seperti runInBackground, tetapi menunggu hasilnya (pratinjau / pencarian yang hanya membaca):
 *  200 dengan nilai `work()`, atau 400 { error: (errorPrefix || '') + pesan } + log `failPrefix + pesan`.
 *  Balasan keluar segera; sesi baru dilepas sesudah kerja yang ditinggalkan guarded() selesai. */
async function runForResult(res, { label, session }, work, { failPrefix, errorPrefix }) {
    let run, ready;
    try { ({ run, ready } = runcontrol.enqueue(label, Object.assign({}, session, { maxWaitMs: limits.RESULT_QUEUE_MS }))); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    // Pemanggil memutus koneksi selagi antre: antreannya dibatalkan (tidak ada lagi yang menunggu hasilnya).
    const onClose = () => { if (run.state === 'queued') runcontrol.stop('run:' + run.id); };
    const watch = typeof res.on === 'function';
    if (watch) res.on('close', onClose);
    try { await ready; }
    catch (e) {
        if (watch) res.removeListener('close', onClose);
        if (e && e.isStop) runcontrol.markStopped(run, 'Dibatalkan sebelum mulai (antrean).'); else runcontrol.markFailed(run, e && e.message);
        runcontrol.finish(run);
        if (e && e.isStop) { log(failPrefix + 'dihentikan oleh pengguna.'); if (!res.headersSent) sendJson(res, 400, { error: (errorPrefix || '') + 'dihentikan oleh pengguna.' }); return; }
        if (!res.headersSent) sendJson(res, 409, { error: e.message });
        return;
    }
    if (watch) res.removeListener('close', onClose);
    try { return sendJson(res, 200, await work()); }
    catch (e) {
        log(failPrefix + e.message);
        if (e && e.isStop) runcontrol.markStopped(run, failPrefix + e.message); else runcontrol.markFailed(run, failPrefix + e.message);
        if (!res.headersSent) sendJson(res, 400, { error: (errorPrefix || '') + e.message }); }
    finally { releaseRun(run); }
}

/** Batas waktu + tombol Stop untuk langkah yang hanya membaca (cari / pratinjau): dulu satu permintaan Coretax yang menggantung
 *  menahan sesi entitas beberapa menit dan Stop tidak berpengaruh. Dipanggil di dalam runForResult (sesudah runcontrol.start).
 *  Janji yang ditinggalkan dicatat pada prosesnya (lihat header) supaya sesinya tidak dilepas terlalu cepat. */
function guarded(promise, ms) {
    let timer, poll, gaveUp = false;
    const run = runcontrol.current();
    const stop = new Promise((_, rej) => {
        const giveUp = (err) => {
            if (gaveUp) return;
            gaveUp = true;
            if (run) {
                (run.abandoned || (run.abandoned = [])).push(Promise.resolve(promise).catch(() => {}));
                if (!err.isStop) run.stopRequested = true; // kerja kooperatif berhenti di checkpoint berikutnya
            }
            rej(err);
        };
        timer = setTimeout(() => giveUp(new Error('tidak selesai dalam ' + Math.round(ms / 60000) + ' menit - dihentikan. Coba lagi; bila berulang, muat ulang jendela Coretax PIC.')), ms);
        poll = setInterval(() => { if (run && run.stopRequested) giveUp(Object.assign(new Error('dihentikan oleh pengguna.'), { isStop: true })); }, limits.STOP_POLL_MS);
    });
    // Janji yang kalah balapan tidak boleh menjadi unhandled rejection.
    Promise.resolve(promise).catch(() => {});
    return Promise.race([promise, stop]).finally(() => { clearTimeout(timer); clearInterval(poll); });
}

module.exports = { runSessionKey, runInBackground, runForResult, guarded, releaseRun, limits };
