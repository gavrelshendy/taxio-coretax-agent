/* Coretax Agent - live run control (pause / resume / skip current filter combo / stop).
   SATU proses per sesi (jendela Chrome per PIC, atau sesi manual), dan sesi yang berbeda boleh
   berjalan BERSAMAAN (permintaan pengguna 2026-10-07: "Sesi baru" tidak boleh menunggu sesi lain).
   Satu jendela tetap tidak bisa mengerjakan dua hal sekaligus, jadi start() pada sesi yang masih
   sibuk ditolak.

   Proses yang sedang dikerjakan ditemukan lewat lib/run-context.js (mengikuti alur async), jadi
   automation/*.js tetap memanggil checkpoint()/setPlan()/markCombo() tanpa parameter apa pun.
   Tombol kontrol (Jeda, Hentikan, ...) datang dari permintaan HTTP lain, jadi selalu memilih
   prosesnya lewat kunci sesi.

   The automation loop calls checkpoint() between rows and pages; that's where a pause actually
   holds, and where a stop/skip request takes effect - so control is responsive (within one
   row's work) without ever interrupting a row's download mid-flight. */
const { log } = require('./log');
const ctx = require('./run-context');

class StopRunError extends Error { constructor() { super('Proses dihentikan oleh pengguna.'); this.isStop = true; } }
class SkipComboError extends Error { constructor() { super('Kombinasi filter saat ini dilewati oleh pengguna.'); this.isSkip = true; } }
class RetryComboError extends Error { constructor() { super('Kombinasi filter saat ini diulang dari awal oleh pengguna.'); this.isRetry = true; } }
class BackComboError extends Error { constructor() { super('Kembali ke kombinasi filter sebelumnya atas permintaan pengguna.'); this.isBack = true; } }

const DEFAULT_KEY = 'default';
/** key -> proses terakhir sesi itu (yang sudah selesai tetap disimpan: dashboard masih membaca
 *  rencana/jenisTally hasil akhirnya; start() berikutnya di sesi yang sama menggantinya). */
const runs = new Map();
let seq = 0;

function newRun(key, tag, label) {
    return {
        key, tag: tag || '', label: label || '', id: ++seq, startedAt: Date.now(),
        active: true, paused: false, stopRequested: false, skipRequested: false, retryRequested: false, backRequested: false,
        pageSizeOverride: null, currentPageSize: null, coretaxAs: '', jenisRequested: [], jenisTally: {},
        // Rencana kombinasi (masa x jenis/kode) dan alasan proses ditahan, hanya untuk dashboard.
        plan: null, holdReason: ''
    };
}
function resetFlags(run) { run.holdReason = ''; run.paused = false; run.stopRequested = false; run.skipRequested = false; run.retryRequested = false; run.backRequested = false; run.pageSizeOverride = null; }
/** Log dengan label sesi `run` walaupun dipanggil dari permintaan lain (tombol kontrol). */
function rlog(run, msg) { ctx.within(run, () => log(msg)); }

function activeRuns() { return Array.from(runs.values()).filter((r) => r.active); }
function anyActive() { return activeRuns().length > 0; }
/** Proses untuk kunci sesi; tanpa kunci: satu-satunya / yang terakhir dimulai di antara yang aktif. */
function pick(key) {
    if (key) return runs.get(key) || null;
    const act = activeRuns();
    if (act.length) return act.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
    let latest = null;
    for (const r of runs.values()) if (!latest || r.id > latest.id) latest = r;
    return latest;
}
function current() { return ctx.current(); }

/** Mendaftarkan proses baru. `session`: kunci sesi (string) atau { key, tag } - tag = kode entitas
 *  yang tampil di depan setiap baris log proses ini, mis. "[HBI]". Tanpa kunci: satu sesi bawaan
 *  (perilaku lama, satu proses sekaligus). */
function start(label, session) {
    const opt = typeof session === 'string' ? { key: session } : (session || {});
    const key = opt.key || DEFAULT_KEY;
    const busy = runs.get(key);
    if (busy && busy.active) {
        throw new Error(key === DEFAULT_KEY
            ? 'Masih ada proses lain yang berjalan - tunggu selesai atau hentikan dulu.'
            : 'Sesi ini masih menjalankan "' + busy.label + '" - tunggu selesai atau hentikan dulu. Sesi lain tetap bisa dipakai.');
    }
    const run = newRun(key, opt.tag, label);
    runs.set(key, run);
    const h = ctx.holder();
    if (h) h.run = run; else ctx.als.enterWith({ run });
    return run;
}

/** Jendela Chrome PIC `picId` dipakai proses sesi lain yang masih berjalan? (mis. SPT yang beralih
 *  ke PIC penanda tangan lain). Dipanggil sebelum proses ini menyentuh jendela itu. */
function assertWindowFree(picId) {
    const me = current();
    if (!me || !picId || picId === me.key) return;
    const other = runs.get(picId);
    if (other && other.active && other !== me) throw new Error('Jendela Coretax PIC ini sedang dipakai proses lain ("' + other.label + '"). Tunggu proses itu selesai lalu coba lagi.');
}

/** Mendaftarkan seluruh kombinasi yang akan dikerjakan. `items`: string atau { label, short }
 *  (short = teks ringkas untuk pil di dashboard, mis. "0126"). */
function setPlan(items) {
    const run = current(); if (!run) return;
    const list = (items || []).map((it) => (typeof it === 'string' ? { label: it, short: it } : { label: it.label, short: it.short || it.label }));
    run.plan = list.length ? { items: list, states: list.map(() => 'wait'), index: -1 } : null;
}
/** state: 'run' (sedang dikerjakan) | 'ok' | 'skip' | 'wait' (mis. setelah Mundur) | 'hold'. */
function markCombo(i, state) {
    const run = current();
    if (!run || !run.plan || i < 0 || i >= run.plan.items.length) return;
    run.plan.states[i] = state;
    if (state === 'run') run.plan.index = i;
}
function finish() {
    const run = current(); if (!run) return;
    run.active = false; run.coretaxAs = ''; run.currentPageSize = null; run.endedAt = Date.now(); resetFlags(run);
}

// Per-jenis-pajak (SPT) completion tracking, dipakai GUI untuk menandai checkbox setelah
// selesai - SENGAJA tidak dibersihkan finish() supaya GUI masih sempat membaca hasil akhirnya.
function setJenisRequested(keys) { const run = current(); if (run) run.jenisRequested = Array.isArray(keys) ? keys.slice() : []; }
function recordRowDone(jenisKey, ok) {
    const run = current();
    if (!run || !jenisKey) return;
    const t = run.jenisTally[jenisKey] || (run.jenisTally[jenisKey] = { ok: 0, fail: 0 });
    if (ok) t.ok++; else t.fail++;
}
function setCoretaxAs(name) { const run = current(); if (run) run.coretaxAs = name || ''; } // who we're logged into Coretax as during this run

function pause(key) { const run = pick(key); if (run && run.active && !run.paused) { run.paused = true; rlog(run, '⏸ Proses dijeda - klik Lanjut untuk meneruskan.'); } }
/** Like pause(), but used internally when a combo fails: holds the run so the user can decide
 *  (Retry / Back / Skip / or fix the browser manually then Resume) instead of auto-skipping. */
function pauseForDecision(reason) {
    const run = current();
    if (!run || !run.active) return;
    run.paused = true; run.holdReason = String(reason || '');
    if (run.plan && run.plan.index >= 0) run.plan.states[run.plan.index] = 'hold';
    log('⏸ DIJEDA karena masalah: ' + reason + ' - pilih 🔁 Ulang / ⏭ Lewati / ⏮ Mundur, atau perbaiki sendiri di jendela Coretax lalu klik ▶ Lanjut.');
}
function resume(key) { const run = pick(key); if (run && run.active && run.paused) { run.paused = false; run.holdReason = ''; rlog(run, '▶ Proses dilanjutkan.'); } }
function request(key, flag, msg) {
    const run = pick(key);
    if (!run || !run.active) return;
    run[flag] = true; run.paused = false; run.holdReason = '';
    rlog(run, msg);
}
function stop(key) { request(key, 'stopRequested', '⏹ Permintaan berhenti diterima - berhenti setelah baris saat ini selesai.'); }
function skip(key) { request(key, 'skipRequested', '⏭ Permintaan lewati diterima - kombinasi saat ini dilewati, lanjut ke berikutnya.'); }
function retry(key) { request(key, 'retryRequested', '🔁 Permintaan ulangi diterima - kombinasi saat ini diulang dari awal (file yang sudah ada dilewati otomatis).'); }
function back(key) { request(key, 'backRequested', '⏮ Permintaan mundur diterima - kembali ke kombinasi sebelumnya (file yang sudah ada dilewati otomatis).'); }
/** Menghentikan semua proses yang masih berjalan (mis. aplikasi ditutup). */
function stopAll() { for (const r of activeRuns()) stop(r.key); }

/** Called by the automation between rows/pages. Throws a control error when the user asked
 *  for skip/retry/back/stop; blocks (politely, 300ms poll) while paused. Thanks to the
 *  per-folder download manifest, retry/back never re-download files that already exist -
 *  they only re-walk the pages and fill gaps, so redoing a combo is cheap and safe.
 *  Di luar proses mana pun (tidak ada konteks): langsung kembali. */
async function checkpoint() {
    const run = current();
    if (!run) return;
    for (;;) {
        if (run.stopRequested) throw new StopRunError();
        if (run.retryRequested) { run.retryRequested = false; throw new RetryComboError(); }
        if (run.backRequested) { run.backRequested = false; throw new BackComboError(); }
        if (run.skipRequested) { run.skipRequested = false; throw new SkipComboError(); }
        if (!run.paused) return;
        await new Promise((r) => setTimeout(r, 300));
    }
}

function summary(r) {
    const prog = r.plan ? { total: r.plan.items.length, done: r.plan.states.filter((s) => s === 'ok' || s === 'skip').length, hold: r.plan.states.filter((s) => s === 'hold').length } : null;
    return { key: r.key, tag: r.tag, label: r.label, active: r.active, paused: r.paused, held: !!(r.paused && r.holdReason), startedAt: r.startedAt, endedAt: r.endedAt || null, progress: prog };
}
/** Status proses sesi `key` (tanpa kunci: proses yang paling relevan, lihat pick()), ditambah
 *  `runs` (ringkasan semua sesi, untuk tab sesi di topbar) dan `anyActive`. */
function status(key) {
    const r = pick(key);
    const base = r ? {
        key: r.key, tag: r.tag, active: r.active, paused: r.paused, label: r.active ? r.label : '', lastLabel: r.label, currentPageSize: r.currentPageSize, coretaxAs: r.coretaxAs,
        jenisRequested: r.jenisRequested, jenisTally: r.jenisTally, holdReason: r.holdReason,
        plan: r.plan ? { items: r.plan.items, states: r.plan.states.slice(), index: r.plan.index } : null
    } : { key: key || null, tag: '', active: false, paused: false, label: '', currentPageSize: null, coretaxAs: '', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null };
    base.runs = Array.from(runs.values()).map(summary);
    base.anyActive = anyActive();
    return base;
}

// Live page-size override: the user watches the site and forces a size mid-run. The download
// loop reads it at the next page boundary via takePageSizeOverride() (which clears it).
function setPageSizeOverride(n, key) { const run = pick(key); if (run && run.active) { run.pageSizeOverride = n; rlog(run, '📄 Override manual: baris per halaman diminta jadi ' + n + ' (berlaku di halaman berikutnya).'); } }
function takePageSizeOverride() { const run = current(); if (!run) return null; const v = run.pageSizeOverride; run.pageSizeOverride = null; return v; }
function reportPageSize(n) { const run = current(); if (run) run.currentPageSize = n; } // loop reports its actual current size (for the GUI)

module.exports = {
    start, finish, pause, pauseForDecision, resume, stop, skip, retry, back, stopAll, checkpoint, status, anyActive, current, assertWindowFree,
    isolate: ctx.isolate, setCoretaxAs, setPageSizeOverride, takePageSizeOverride, reportPageSize, setJenisRequested, recordRowDone, setPlan, markCombo,
    StopRunError, SkipComboError, RetryComboError, BackComboError
};
