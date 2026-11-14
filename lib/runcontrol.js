/* Coretax Agent - live run control (pause / resume / skip current filter combo / stop) + jendela, antrean dan
   kunci keluaran untuk proses yang berjalan BERSAMAAN.

   Model (sejak "semua perintah bisa paralel", 2026-11-13):
   - POOL = PIC (kunci sesi lama: picId, atau "local:<entitas>:<pic>"), atau 'manual' (sesi manual polos, satu
     jendela) / 'default' (proses tanpa sesi, satu sekaligus - perilaku lama).
   - JENDELA (slot) sebuah PIC: "<pic>" (jendela pertama - kunci dan folder profil lama, jadi login yang sudah
     ada tetap terpakai), lalu "<pic>~2", "<pic>~3", ... sampai batas per PIC (lib/parallel-settings.js).
     Satu jendela tetap hanya mengerjakan satu proses; proses lain untuk PIC yang sama mendapat jendela lain.
   - Pemilihan jendela (saat proses mulai): jendela bebas yang sudah terbuka DAN sedang mengimpersonate entitas
     yang diminta (tanpa login / ganti entitas ulang) -> jendela bebas lain yang sudah terbuka -> jendela baru
     (nomor terkecil yang belum dipakai) selama batas per PIC dan batas total jendela yang berjalan belum
     tercapai. Selain itu proses MASUK ANTREAN (FIFO) dan mulai sendiri begitu ada jendela bebas; Stop
     membatalkannya sebelum mulai.
   - Kunci sesi sebuah proses (`run.key`) = kunci jendelanya ("<pic>~2"); selama antre / tanpa jendela:
     "run:<id>". Tombol kontrol dan /api/run/status menerima kunci jendela, kunci pool (PIC) atau "run:<id>".
   - Keluaran (gui/server.js): `sig` = tanda perintah identik (fitur + entitas + parameter) -> perintah yang
     SAMA PERSIS selagi yang pertama masih antre/berjalan DITOLAK; `lock` = (entitas, fitur) -> fitur yang
     sama untuk entitas yang sama (parameter lain) ANTRE di belakang yang pertama; fitur berbeda tetap paralel.

   Proses yang sedang dikerjakan ditemukan lewat lib/run-context.js (mengikuti alur async), jadi
   automation/*.js tetap memanggil checkpoint()/setPlan()/markCombo() - dan chrome.launchOrReuseContext(picId)
   dengan picId ASLI (untuk kredensial) - tanpa parameter jendela apa pun: lib/chrome-sessions.js menanyakan
   jendelanya ke windowKeyFor()/acquireWindow() di sini. Tombol kontrol (Jeda, Hentikan, ...) datang dari
   permintaan HTTP lain, jadi selalu memilih prosesnya lewat kunci.

   The automation loop calls checkpoint() between rows and pages; that's where a pause actually
   holds, and where a stop/skip request takes effect - so control is responsive (within one
   row's work) without ever interrupting a row's download mid-flight.

   Kontrol per proses (2026-11-13): `run.controls` = apa yang BENAR-BENAR dikerjakan fitur proses itu (lib/run-controls.js,
   dari `session.feature`). Jeda / Lewati / Ulang / Mundur / ukuran halaman yang tidak didukung ditolak dengan satu baris
   log (bukan dicatat lalu tidak terjadi apa-apa); Stop selalu diterima. Status memuat `controls`, `stopRequested`
   (menunggu titik aman berikutnya) dan `pauseRequested` (jeda diminta, proses belum sampai di titik aman). */
const { log, onLogLine } = require('./log');
const ctx = require('./run-context');
const uiEvents = require('./ui-events');
const runControls = require('./run-controls');
const path = require('path');

class StopRunError extends Error { constructor() { super('Proses dihentikan oleh pengguna.'); this.isStop = true; } }
class SkipComboError extends Error { constructor() { super('Kombinasi filter saat ini dilewati oleh pengguna.'); this.isSkip = true; } }
class RetryComboError extends Error { constructor() { super('Kombinasi filter saat ini diulang dari awal oleh pengguna.'); this.isRetry = true; } }
class BackComboError extends Error { constructor() { super('Kembali ke kombinasi filter sebelumnya atas permintaan pengguna.'); this.isBack = true; } }

const DEFAULT_KEY = 'default';
const MANUAL_KEY = 'manual';
/** Riwayat proses sesi aplikasi ini (halaman Runs: GET /api/runs): paling banyak ini proses yang SUDAH selesai disimpan
 *  di memori (yang tertua dibuang dulu; hilang saat aplikasi ditutup). Proses antre / berjalan tidak pernah dibuang. */
let KEEP_DONE = 300;
/** Menunggu jendela PIC lain (SPT jatuh ke PIC penanda tangan lain) paling lama ini, lalu PIC itu dilewati. */
const timing = { BORROW_WAIT_MS: 2 * 60 * 1000, PAUSE_POLL_MS: 300 }; // tes boleh memperpendek

/** id -> proses (antre, berjalan, atau sudah selesai - yang selesai dipangkas ke KEEP_DONE terakhir). */
const runs = new Map();
/** Kunci jendela -> proses yang sedang memakainya (jendela utama dan jendela pinjaman). */
const holders = new Map();
/** Kunci keluaran (entitas|fitur) -> proses yang sedang berjalan dengannya. */
const locks = new Map();
/** Antrean FIFO: { run, resolve, reject, timer }. */
const queue = [];
let seq = 0;

/* Jendela yang sedang terbuka (lib/chrome-sessions.js mendaftarkan diri lewat setWindowProvider - modul ini tidak
 * boleh me-require chrome-sessions karena chrome-sessions me-require modul ini). */
let provider = { openKeys: () => [] };
function setWindowProvider(p) { provider = Object.assign({ openKeys: () => [] }, p || {}); }

/** Kabar perubahan: 'run' (dashboard lama, dikumpulkan lib/ui-events.js) dan 'runs' (halaman Runs) - 'runs' paling banyak
 *  4 kali per detik (kemajuan per langkah bisa sangat rapat), kabar terakhir selalu keluar (trailing). */
const RUNS_EVENT_MIN_MS = 250;
let runsTimer = null, runsLastAt = 0;
function notify() {
    uiEvents.emit('run');
    if (runsTimer) return;
    const wait = Math.max(0, RUNS_EVENT_MIN_MS - (Date.now() - runsLastAt));
    runsTimer = setTimeout(() => { runsTimer = null; runsLastAt = Date.now(); uiEvents.emit('runs'); }, wait);
    if (runsTimer.unref) runsTimer.unref();
}

function limits() { return require('./parallel-settings').get(); }
function slotKey(pool, n) { return n <= 1 ? pool : pool + '~' + n; }
/** "<pic>~3" -> { pool: "<pic>", n: 3 }; selain itu { pool: key, n: 1 }. */
function parseSlot(key) {
    const m = /^(.+)~(\d+)$/.exec(String(key || ''));
    return m && Number(m[2]) > 1 ? { pool: m[1], n: Number(m[2]) } : { pool: String(key || ''), n: 1 };
}
const isPicPool = (pool) => !!pool && pool !== DEFAULT_KEY && pool !== MANUAL_KEY;
function entityOfWindow(key) { try { const s = require('./login-status').get(key); return s ? s.entityId : null; } catch (e) { return null; } }

function newRun(label, opt) {
    const now = Date.now();
    return {
        id: ++seq, key: 'run:' + seq, pool: opt.pool, entity: opt.entity || '', tag: opt.tag || '', label: label || '',
        feature: opt.feature || '', sig: opt.sig || '', lock: opt.lock || '', windowed: opt.windowed, wantWindow: opt.window || '',
        state: 'queued', active: true, queued: true, createdAt: now, startedAt: now, waitReason: '', waitBy: null,
        window: null, borrowed: new Map(),
        paused: false, stopRequested: false, skipRequested: false, retryRequested: false, backRequested: false,
        pageSizeOverride: null, currentPageSize: null, coretaxAs: '', jenisRequested: [], jenisTally: {},
        // Rencana kombinasi (masa x jenis/kode) dan alasan proses ditahan, hanya untuk dashboard.
        plan: null, holdReason: '',
        // Untuk halaman Runs: entitas (nama / NPWP), efek ke Coretax, folder hasil, ringkasan akhir dan keadaan akhir.
        entityName: opt.entityName || '', npwp: opt.npwp || '', changesCoretax: runControls.changesCoretax(opt.feature, opt.changesCoretax),
        outputDir: '', outcomeKind: '', outcomeText: '', failed: false, stopAsked: false, finalState: '',
        // Kelompok "unduh untuk banyak klien" ({ id, label, index, total }) atau null; hanya unduhan hanya-baca (gui/run-wrappers.js).
        batch: opt.batch || null,
        // Kontrol yang didukung fitur ini (lib/run-controls.js); `holding` = sedang tertahan di checkpoint (jeda berlaku).
        controls: runControls.controlsFor(opt.feature, opt.controls), holding: false
    };
}
function resetFlags(run) { run.holdReason = ''; run.paused = false; run.holding = false; run.stopRequested = false; run.skipRequested = false; run.retryRequested = false; run.backRequested = false; run.pageSizeOverride = null; }
/** Nama kontrol untuk baris log penolakan. */
const CONTROL_NAME = { pause: 'Jeda', skip: 'Lewati', retry: 'Ulang', back: 'Mundur', pageSize: 'Ganti baris per halaman' };
/** Kontrol `what` tidak didukung fitur proses `run`: satu baris log, permintaan diabaikan. */
function unsupported(run, what) {
    if (run.controls && run.controls[what]) return false;
    rlog(run, CONTROL_NAME[what] + ' tidak tersedia untuk proses ini ("' + run.label + '") - permintaan diabaikan. Stop tetap bisa dipakai.');
    return true;
}
/** Log dengan label sesi `run` walaupun dipanggil dari permintaan lain (tombol kontrol). */
function rlog(run, msg) { ctx.within(run, () => log(msg)); }

/** `session`: kunci sesi (string) atau { key, tag, entity, feature, sig, lock, window, windowed }. `key` = pool
 *  (PIC / 'manual'); tanpa kunci: 'default' (satu proses sekaligus, perilaku lama). */
function normalize(session) {
    const opt = typeof session === 'string' ? { key: session } : Object.assign({}, session || {});
    opt.pool = opt.key || DEFAULT_KEY;
    // Kunci jendela tambahan ("<pic>~2", mis. dari tab sesi) = pool PIC itu, jendela itu.
    const slot = parseSlot(opt.pool);
    if (slot.n > 1 && !opt.window) { opt.window = opt.pool; opt.pool = slot.pool; }
    opt.windowed = opt.windowed !== false;
    return opt;
}

function activeRuns() { return Array.from(runs.values()).filter((r) => r.active); }
function anyActive() { return activeRuns().length > 0; }
function runningRuns() { return Array.from(runs.values()).filter((r) => r.state === 'running'); }
function oldest(list) { return list.reduce((a, b) => (!a || b.startedAt < a.startedAt ? b : a), null); }

/** Proses untuk kunci: "run:<id>"; kunci jendela (proses yang memakainya, selain itu yang terakhir di sana); kunci
 *  pool/PIC (proses pool itu: berjalan > antre > terakhir selesai). `entity` (opsional) menyaring ke proses entitas
 *  itu (kecuali sesi manual). Tanpa kunci: satu-satunya / yang terakhir dimulai di antara yang aktif. */
function pick(key, entity) {
    if (key) {
        const m = /^run:(\d+)$/.exec(String(key));
        if (m) return runs.get(Number(m[1])) || null;
        const want = (r) => !entity || r.pool === MANUAL_KEY || !r.entity || r.entity === entity;
        const all = Array.from(runs.values()).filter(want);
        const exact = all.filter((r) => r.key === key || r.window === key);
        const inPool = all.filter((r) => r.pool === key);
        for (const state of ['running', 'queued', 'done']) {
            for (const list of [exact, inPool]) {
                const hit = list.filter((r) => r.state === state);
                if (!hit.length) continue;
                if (state === 'queued') return hit.reduce((a, b) => (b.id < a.id ? b : a));
                return hit.reduce((a, b) => (state === 'running' ? (b.startedAt >= a.startedAt ? b : a) : (b.id > a.id ? b : a)));
            }
        }
        return null;
    }
    const act = activeRuns();
    if (act.length) return act.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
    let latest = null;
    for (const r of runs.values()) if (!latest || r.id > latest.id) latest = r;
    return latest;
}
function current() { return ctx.current(); }

// ---------- Jendela, antrean, kunci keluaran ----------

/** Jendela bebas untuk pool PIC: yang mengimpersonate `entity` > yang sudah terbuka > jendela baru. null = penuh. */
function pickSlot(pool, entity, perPic) {
    const open = new Set(provider.openKeys());
    const cands = [];
    for (let n = 1; n <= perPic; n++) cands.push(slotKey(pool, n));
    const free = cands.filter((k) => !holders.has(k));
    const freeOpen = free.filter((k) => open.has(k));
    if (entity) { const same = freeOpen.find((k) => entityOfWindow(k) === entity); if (same) return same; }
    if (freeOpen.length) return freeOpen[0];
    return free.find((k) => !open.has(k)) || null;
}
function picRunningCount() { return runningRuns().filter((r) => r.windowed && isPicPool(r.pool)).length; }

/** Bisa mulai sekarang? -> { key } atau { reason: 'lock' | 'busy' | 'total', by: proses yang menghalangi }. */
function tryAdmit(run) {
    if (run.lock && locks.has(run.lock) && locks.get(run.lock) !== run) return { reason: 'lock', by: locks.get(run.lock) };
    if (!run.windowed) return { key: 'run:' + run.id };
    if (!isPicPool(run.pool)) { const h = holders.get(run.pool); return h ? { reason: 'busy', by: h } : { key: run.pool }; }
    const lim = limits();
    if (run.wantWindow) {
        const h = holders.get(run.wantWindow);
        if (h) return { reason: 'busy', by: h };
        if (picRunningCount() >= lim.total) return { reason: 'total', by: oldest(runningRuns().filter((r) => r.windowed && isPicPool(r.pool))) };
        return { key: run.wantWindow };
    }
    if (picRunningCount() >= lim.total) return { reason: 'total', by: oldest(runningRuns().filter((r) => r.windowed && isPicPool(r.pool))) };
    const key = pickSlot(run.pool, run.entity, lim.perPic);
    if (key) return { key };
    return { reason: 'busy', by: oldest(runningRuns().filter((r) => r.pool === run.pool)) };
}
function admit(run, key) {
    run.state = 'running'; run.queued = false; run.key = key; run.startedAt = Date.now(); run.waitReason = ''; run.waitBy = null;
    if (run.windowed) { run.window = key; holders.set(key, run); }
    if (run.lock) locks.set(run.lock, run);
}
function release(run) {
    for (const [k, r] of Array.from(holders)) if (r === run) holders.delete(k);
    for (const [k, r] of Array.from(locks)) if (r === run) locks.delete(k);
    run.borrowed = new Map();
}
/** Posisi proses antre (1 = berikutnya) di antara antrean pool-nya. */
function positionOf(run) {
    let n = 0;
    for (const e of queue) { if (e.run.pool === run.pool) n++; if (e.run === run) return n; }
    return 0;
}
function busyMessage(by, pool) {
    if (pool === DEFAULT_KEY) return 'Masih ada proses lain yang berjalan - tunggu selesai atau hentikan dulu.';
    return 'Sesi ini masih menjalankan "' + ((by && by.label) || 'proses lain') + '" - tunggu selesai atau hentikan dulu. Sesi lain tetap bisa dipakai.';
}
/** Alasan antre dalam bahasa biasa (tanpa nomor antrean): res = { reason: 'lock' | 'busy' | 'total', by }. */
function waitWhy(run, res) {
    return res.reason === 'lock' ? 'perintah yang sama untuk entitas ini masih berjalan ("' + (res.by && res.by.label) + '")'
        : res.reason === 'total' ? 'semua jendela otomasi sedang dipakai (batas ' + limits().total + ' jendela berjalan)'
            : run.pool === MANUAL_KEY ? 'jendela manual masih menjalankan "' + (res.by && res.by.label) + '"'
                : run.wantWindow ? 'jendela entitas ini masih menjalankan "' + (res.by && res.by.label) + '"'
                    : 'semua jendela PIC ini sedang dipakai (batas ' + limits().perPic + ' jendela per PIC)';
}
function waitText(run, res) {
    const pos = positionOf(run);
    const why = waitWhy(run, res);
    return 'Menunggu giliran - antrean ke-' + pos + ': ' + why + '. Proses mulai sendiri begitu giliran tiba; Stop membatalkannya.';
}
/** Mencoba menjalankan proses antre (urut FIFO) setiap kali jendela / kunci / batas berubah. */
function pump() {
    let changed = false;
    for (let i = 0; i < queue.length;) {
        const e = queue[i];
        const res = tryAdmit(e.run);
        if (res.key) {
            queue.splice(i, 1);
            if (e.timer) clearTimeout(e.timer);
            admit(e.run, res.key);
            rlog(e.run, 'Giliran tiba - proses dimulai' + (e.run.windowed && isPicPool(e.run.pool) ? ' di jendela ' + windowLabel(res.key) : '') + '.');
            e.resolve(e.run);
            changed = true;
            continue;
        }
        e.run.waitReason = res.reason; e.run.waitBy = res.by || null;
        i++;
    }
    if (changed) notify();
}
function windowLabel(key) { const s = parseSlot(key); return 'ke-' + s.n; }

function prune() {
    const done = Array.from(runs.values()).filter((r) => r.state === 'done').sort((a, b) => a.id - b.id);
    for (const r of done.slice(0, Math.max(0, done.length - KEEP_DONE))) runs.delete(r.id);
}
function bind(run) {
    const h = ctx.holder();
    if (h) h.run = run; else ctx.als.enterWith({ run });
}
function duplicateOf(sig) { return sig ? activeRuns().find((r) => r.sig === sig) || null : null; }
function duplicateError(dup) {
    const e = new Error('Perintah yang sama untuk entitas ini sudah ' + (dup.state === 'queued' ? 'antre' : 'berjalan') + ' ("' + dup.label + '") - tunggu selesai atau hentikan dulu. Perintah lain tetap bisa dijalankan bersamaan.');
    e.duplicate = true; e.run = dup;
    return e;
}

/** Mendaftarkan proses baru yang HARUS mulai sekarang (perilaku lama): melempar bila tidak ada jendela bebas /
 *  kunci keluarannya dipegang / perintah identik masih berjalan. Lihat normalize() untuk `session`. */
function start(label, session) {
    const opt = normalize(session);
    const dup = duplicateOf(opt.sig);
    if (dup) throw duplicateError(dup);
    const run = newRun(label, opt);
    const res = tryAdmit(run);
    if (!res.key) throw new Error(busyMessage(res.by, opt.pool));
    runs.set(run.id, run);
    admit(run, res.key);
    bind(run);
    prune();
    notify();
    return run;
}

/** Mendaftarkan proses yang boleh MENUNGGU: { run, ready } - `ready` selesai saat proses mendapat jendela (langsung
 *  bila ada yang bebas), ditolak StopRunError bila dibatalkan selagi antre, atau Error berpesan "Sesi ini masih
 *  menjalankan ..." bila `session.maxWaitMs` lewat. Perintah identik yang masih antre/berjalan ditolak langsung
 *  (melempar, `e.duplicate`). Proses langsung terikat ke alur async pemanggil (log berlabel selama antre). */
function enqueue(label, session) {
    const opt = normalize(session);
    const dup = duplicateOf(opt.sig);
    if (dup) throw duplicateError(dup);
    const run = newRun(label, opt);
    runs.set(run.id, run);
    bind(run);
    const res = tryAdmit(run);
    if (res.key) {
        admit(run, res.key);
        prune();
        notify();
        return { run, ready: Promise.resolve(run) };
    }
    let entry;
    const ready = new Promise((resolve, reject) => { entry = { run, resolve, reject, timer: null }; });
    ready.catch(() => { /* pemanggil yang menangani */ });
    run.waitReason = res.reason; run.waitBy = res.by || null;
    queue.push(entry);
    if (opt.maxWaitMs) {
        entry.timer = setTimeout(() => {
            const i = queue.indexOf(entry);
            if (i === -1) return;
            queue.splice(i, 1);
            const e = new Error(busyMessage(run.waitBy || res.by, opt.pool));
            e.queueTimeout = true;
            entry.reject(e);
            notify();
        }, opt.maxWaitMs);
    }
    rlog(run, waitText(run, res));
    prune();
    notify();
    return { run, ready };
}

/** Membatalkan proses yang masih antre (Stop sebelum mulai). */
function cancelQueued(run) {
    const i = queue.findIndex((e) => e.run === run);
    if (i === -1) return false;
    const [e] = queue.splice(i, 1);
    if (e.timer) clearTimeout(e.timer);
    rlog(run, '⏹ Antrean dibatalkan - proses ini tidak jadi dimulai.');
    e.reject(new StopRunError());
    notify();
    return true;
}

/** Sesi/jendela `key` sedang dipakai proses yang berjalan? (mis. lib/chrome-sessions.js memakai status jendela
 *  tersimpan selama otomasi sedang menyetir jendela itu, bukan membaca ulang halamannya.) */
function isBusy(key) { return !!key && holders.has(key); }

/** Kunci jendela yang dipakai proses alur ini untuk PIC `picId` (sinkron, tanpa meminjam): jendela prosesnya sendiri
 *  bila PIC-nya sama, jendela pinjaman bila ada, selain itu `picId` (jendela pertama - di luar proses / perilaku lama). */
function windowKeyFor(picId) {
    const run = current();
    if (!run || !run.windowed || !picId) return picId;
    if (run.pool === picId && run.window) return run.window;
    if (run.borrowed.has(picId)) return run.borrowed.get(picId);
    return picId;
}

/** Kunci jendela untuk PIC `picId` sebelum proses ini menyentuh jendelanya (lib/chrome-sessions.js
 *  launchOrReuseContext). PIC lain (SPT yang beralih ke PIC penanda tangan lain): MEMINJAM jendela bebas PIC itu
 *  (tidak pernah jendela yang sedang dipakai proses lain), menunggu paling lama BORROW_WAIT_MS (Stop tetap
 *  berlaku), lalu melempar pesan lama "Jendela Coretax PIC ini sedang dipakai proses lain". Jendela pinjaman ikut
 *  dilepas saat prosesnya selesai. Tidak dihitung batas total (supaya tidak saling menunggu). */
async function acquireWindow(picId) {
    const run = current();
    if (!run || !run.windowed || !picId || run.state !== 'running') return picId;
    if (run.pool === picId && run.window) return run.window;
    if (run.borrowed.has(picId)) return run.borrowed.get(picId);
    if (!isPicPool(picId)) return picId;
    const deadline = Date.now() + timing.BORROW_WAIT_MS;
    let logged = false;
    for (;;) {
        const key = pickSlot(picId, run.entity, limits().perPic);
        if (key) {
            run.borrowed.set(picId, key);
            holders.set(key, run);
            notify();
            return key;
        }
        const other = oldest(runningRuns().filter((r) => r !== run && (r.pool === picId || Array.from(r.borrowed.keys()).includes(picId))));
        if (Date.now() >= deadline) throw new Error('Jendela Coretax PIC ini sedang dipakai proses lain ("' + ((other && other.label) || 'proses lain') + '"). Tunggu proses itu selesai lalu coba lagi.');
        if (!logged) { logged = true; log('Semua jendela Coretax PIC lain itu sedang dipakai ("' + ((other && other.label) || 'proses lain') + '") - menunggu jendela bebas (maks ' + Math.max(1, Math.round(timing.BORROW_WAIT_MS / 60000)) + ' menit).'); }
        await checkpoint();
        await new Promise((r) => setTimeout(r, 300));
    }
}

/** Perilaku lama (dipertahankan untuk alat lain / tes): melempar bila jendela PERTAMA PIC `picId` sedang dipakai
 *  proses lain yang masih berjalan. Jalur produksi memakai acquireWindow(). */
function assertWindowFree(picId) {
    const me = current();
    if (!me || !picId || picId === me.pool) return;
    const other = holders.get(picId);
    if (other && other.active && other !== me) throw new Error('Jendela Coretax PIC ini sedang dipakai proses lain ("' + other.label + '"). Tunggu proses itu selesai lalu coba lagi.');
}

/** Mendaftarkan seluruh kombinasi yang akan dikerjakan. `items`: string atau { label, short }
 *  (short = teks ringkas untuk pil di dashboard, mis. "0126"). */
function setPlan(items) {
    const run = current(); if (!run) return;
    const list = (items || []).map((it) => (typeof it === 'string' ? { label: it, short: it } : { label: it.label, short: it.short || it.label }));
    run.plan = list.length ? { items: list, states: list.map(() => 'wait'), index: -1 } : null;
    notify();
}
/** state: 'run' (sedang dikerjakan) | 'ok' | 'skip' | 'wait' (mis. setelah Mundur) | 'hold'. */
function markCombo(i, state) {
    const run = current();
    if (!run || !run.plan || i < 0 || i >= run.plan.items.length) return;
    run.plan.states[i] = state;
    if (state === 'run') run.plan.index = i;
    notify();
}
/* ---------- Hasil akhir, folder hasil, riwayat (halaman Runs) ---------- */

/** Baris log penutup sebuah proses ("SELESAI: ..." / "GAGAL: ..." / "Dihentikan: ..." / "DIHENTIKAN: ..."): dicatat apa adanya
 *  dari log proses itu (baris log TIDAK diubah). Yang terakhir menang. */
const OUTCOME_RE = /^(selesai|gagal|dihentikan)\b/i;
const OUTCOME_MAX = 1000;
onLogLine((e) => {
    if (!e || !e.run || e.notice) return;
    const r = runs.get(e.run);
    if (!r || !r.active) return;
    let t = String(e.msg || '');
    if (r.tag && t.startsWith('[' + r.tag + '] ')) t = t.slice(r.tag.length + 3);
    const m = OUTCOME_RE.exec(t);
    if (!m) return;
    const w = m[1].toLowerCase();
    r.outcomeKind = w === 'selesai' ? 'ok' : w === 'gagal' ? 'fail' : 'stop';
    r.outcomeText = t.slice(0, OUTCOME_MAX);
});
/** Pembungkus route (gui/run-wrappers.js): proses `run` berakhir dengan galat (`text` = baris yang dicatat; hanya dipakai bila
 *  belum ada baris GAGAL: yang ditangkap dari log). */
function markFailed(run, text) {
    if (!run) return;
    run.failed = true;
    if (text && run.outcomeKind !== 'fail') { run.outcomeKind = 'fail'; run.outcomeText = String(text).slice(0, OUTCOME_MAX); }
}
/** Pembungkus route: proses `run` dihentikan pengguna (`text` = baris stop; hanya bila belum ada baris Dihentikan: dari fitur). */
function markStopped(run, text) {
    if (!run) return;
    run.stopAsked = true;
    if (text && !run.outcomeText) { run.outcomeKind = 'stop'; run.outcomeText = String(text).slice(0, OUTCOME_MAX); }
}
/** Keadaan akhir: 'done' | 'failed' | 'stopped'. */
function finalStateOf(r) {
    if (r.failed) return 'failed';
    if (r.outcomeKind === 'ok') return 'done';
    if (r.outcomeKind === 'fail') return 'failed';
    if (r.outcomeKind === 'stop' || r.stopAsked) return 'stopped';
    return 'done';
}
const DEFAULT_OUTCOME = { done: 'Selesai.', failed: 'Gagal.', stopped: 'Dihentikan oleh pengguna.' };

/** Fitur memanggil ini di tempat folder hasilnya ditentukan / dibuat (satu pembantu untuk semua fitur): mencatat folder hasil
 *  proses alur ini. Folder berikutnya yang bersaudara (induk yang sama, mis. SPT per masa) atau induk / anak dari yang
 *  tercatat digabung menjadi induknya; folder lain (mis. folder A1 vs folder SPT) tidak menimpa yang pertama. Di luar proses:
 *  tidak berbuat apa-apa. Hanya jalur yang dicatat server yang pernah dibuka lewat POST /api/runs/open-folder. */
function setOutput(dir) {
    const run = current();
    if (!run || !dir || typeof dir !== 'string') return;
    const d = path.resolve(dir);
    const cur = run.outputDir;
    if (!cur) run.outputDir = d;
    else if (d !== cur) {
        const within = (a, b) => { const rel = path.relative(a, b); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
        if (within(cur, d)) { /* sudah tercakup */ }
        else if (within(d, cur)) run.outputDir = d;
        else if (path.dirname(d) === path.dirname(cur)) run.outputDir = path.dirname(d);
        else return;
    } else return;
    notify();
}
/** Folder hasil yang DICATAT server untuk proses `key` ("run:<id>"), atau null. */
function outputDirOf(key) {
    const m = /^run:(\d+)$/.exec(String(key || ''));
    const r = m ? runs.get(Number(m[1])) : null;
    return r && r.outputDir ? r.outputDir : null;
}

/** Menandai proses selesai (jendela, jendela pinjaman dan kunci keluarannya dilepas; antrean dicoba lagi). Tanpa
 *  argumen: proses alur ini (konteks AsyncLocalStorage). `run` eksplisit dipakai bila pelepasan sesi ditunda sampai
 *  kerja yang ditinggalkan benar-benar selesai (gui/run-wrappers.js) - saat itu konteksnya bisa sudah bukan alur
 *  permintaan aslinya. Proses yang masih antre ikut dibatalkan. */
function finish(run) {
    run = run || current(); if (!run) return;
    if (run.state === 'queued') {
        const i = queue.findIndex((e) => e.run === run);
        if (i !== -1) { const [e] = queue.splice(i, 1); if (e.timer) clearTimeout(e.timer); e.reject(new StopRunError()); }
        if (!run.failed) run.stopAsked = true;
    }
    release(run);
    run.state = 'done'; run.queued = false;
    run.active = false; run.lingering = false; run.coretaxAs = ''; run.currentPageSize = null; run.endedAt = Date.now(); run.finalState = finalStateOf(run); resetFlags(run);
    prune();
    notify();
    pump();
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

const isRunning = (run) => !!(run && run.state === 'running');
function pause(key) {
    const run = pick(key);
    if (!isRunning(run) || run.paused || unsupported(run, 'pause')) return;
    run.paused = true; rlog(run, '⏸ Proses dijeda - klik Lanjut untuk meneruskan.');
    notify();
}
/** Like pause(), but used internally when a combo fails: holds the run so the user can decide
 *  (Retry / Back / Skip / or fix the browser manually then Resume) instead of auto-skipping. */
function pauseForDecision(reason) {
    const run = current();
    if (!run || !run.active) return;
    run.paused = true; run.holdReason = String(reason || '');
    if (run.plan && run.plan.index >= 0) run.plan.states[run.plan.index] = 'hold';
    log('⏸ DIJEDA karena masalah: ' + reason + ' - pilih 🔁 Ulang / ⏭ Lewati / ⏮ Mundur, atau perbaiki sendiri di jendela Coretax lalu klik ▶ Lanjut.');
    notify();
}
function resume(key) { const run = pick(key); if (isRunning(run) && run.paused) { run.paused = false; run.holdReason = ''; rlog(run, '▶ Proses dilanjutkan.'); notify(); } }
/** `what`: nama kontrol (lib/run-controls.js) yang harus didukung fitur proses itu; tanpa = selalu (Stop). */
function request(key, flag, msg, what) {
    const run = pick(key);
    if (!isRunning(run)) return;
    if (what && unsupported(run, what)) return;
    run[flag] = true; run.paused = false; run.holdReason = '';
    rlog(run, msg);
    notify();
}
/** Hentikan: proses yang berjalan berhenti di checkpoint berikutnya; proses yang masih antre dibatalkan. Selalu diterima. */
function stop(key) {
    const run = pick(key);
    if (run && run.state === 'queued') { run.stopAsked = true; cancelQueued(run); return; }
    if (isRunning(run)) run.stopAsked = true;
    request(run ? 'run:' + run.id : key, 'stopRequested', '⏹ Permintaan berhenti diterima - berhenti setelah baris saat ini selesai.');
}
function skip(key) { request(key, 'skipRequested', '⏭ Permintaan lewati diterima - kombinasi saat ini dilewati, lanjut ke berikutnya.', 'skip'); }
function retry(key) { request(key, 'retryRequested', '🔁 Permintaan ulangi diterima - kombinasi saat ini diulang dari awal (file yang sudah ada dilewati otomatis).', 'retry'); }
function back(key) { request(key, 'backRequested', '⏮ Permintaan mundur diterima - kembali ke kombinasi sebelumnya (file yang sudah ada dilewati otomatis).', 'back'); }
/** Menghentikan semua proses yang masih berjalan dan membatalkan antrean (mis. aplikasi ditutup). */
function stopAll() { for (const r of activeRuns()) stop('run:' + r.id); }

/** Called by the automation between rows/pages. Throws a control error when the user asked
 *  for skip/retry/back/stop; blocks (politely, 300ms poll) while paused. Thanks to the
 *  per-folder download manifest, retry/back never re-download files that already exist -
 *  they only re-walk the pages and fill gaps, so redoing a combo is cheap and safe.
 *  Di luar proses mana pun (tidak ada konteks): langsung kembali.
 *  Mengembalikan lama (ms) proses tertahan di sini - loop yang punya batas waktu (menunggu hasil Coretax) memundurkan
 *  tenggatnya sebanyak itu, supaya jeda tidak dihitung sebagai "Coretax tidak menjawab". Selama tertahan
 *  `run.holding` = true (status `pauseRequested` = jeda diminta tetapi belum sampai di sini). */
async function checkpoint() {
    const run = current();
    if (!run) return 0;
    let since = 0;
    const leave = () => { if (since) { run.holding = false; notify(); } return since ? Date.now() - since : 0; };
    for (;;) {
        if (run.stopRequested) { leave(); throw new StopRunError(); }
        if (run.retryRequested) { run.retryRequested = false; leave(); throw new RetryComboError(); }
        if (run.backRequested) { run.backRequested = false; leave(); throw new BackComboError(); }
        if (run.skipRequested) { run.skipRequested = false; leave(); throw new SkipComboError(); }
        if (!run.paused) return leave();
        if (!since) { since = Date.now(); run.holding = true; notify(); }
        await new Promise((r) => setTimeout(r, timing.PAUSE_POLL_MS));
    }
}
/** Stop sudah diminta untuk proses alur ini? (tanpa melempar / menahan - untuk menunggu hasil permintaan tulis yang
 *  SUDAH terkirim: penantiannya boleh dipersingkat, hasilnya dicatat sebagai "masih diproses"). */
function stopRequested() { const run = current(); return !!(run && run.stopRequested); }

function summary(r) {
    const prog = r.plan ? { total: r.plan.items.length, done: r.plan.states.filter((s) => s === 'ok' || s === 'skip').length, hold: r.plan.states.filter((s) => s === 'hold').length } : null;
    const slot = r.window ? parseSlot(r.window) : null;
    return {
        key: r.key, id: r.id, pool: r.pool, entity: r.entity, window: r.window || null, windowNo: slot && isPicPool(r.pool) ? slot.n : null,
        tag: r.tag, label: r.label, feature: r.feature, active: r.active, queued: r.state === 'queued', position: r.state === 'queued' ? positionOf(r) : 0,
        waitReason: r.state === 'queued' ? r.waitReason : '', paused: r.paused, held: !!(r.paused && r.holdReason), startedAt: r.startedAt, endedAt: r.endedAt || null, progress: prog,
        ...controlState(r)
    };
}
/** Kontrol yang didukung + permintaan yang belum sampai di titik aman (tombol "Stopping…" / "Pausing…" di dashboard). */
function controlState(r) {
    const running = r.state === 'running';
    return { controls: Object.assign({}, r.controls), stopRequested: running && !!r.stopRequested, pauseRequested: running && !!r.paused && !r.holding && !r.stopRequested };
}
/** Ringkasan untuk tab sesi / MCP: semua proses yang antre / berjalan + proses terakhir yang selesai per kunci. */
function runSummaries() {
    const out = [];
    const seenDone = new Set();
    const all = Array.from(runs.values()).sort((a, b) => b.id - a.id);
    for (const r of all) {
        if (r.state !== 'done') { out.push(r); continue; }
        const k = r.window || r.key;
        if (seenDone.has(k)) continue;
        seenDone.add(k); out.push(r);
    }
    return out.sort((a, b) => a.id - b.id).map(summary);
}
/** Status proses untuk kunci `key` (lihat pick(); `entity` menyaring ke proses entitas itu), ditambah `runs`
 *  (ringkasan semua sesi, untuk tab sesi di topbar), `anyActive` dan `limits`. */
function status(key, entity) {
    const r = pick(key, entity);
    const base = r ? {
        key: r.key, id: r.id, pool: r.pool, entity: r.entity, window: r.window || null, tag: r.tag, active: r.active, queued: r.state === 'queued',
        position: r.state === 'queued' ? positionOf(r) : 0, waitReason: r.state === 'queued' ? r.waitReason : '',
        paused: r.paused, label: r.active ? r.label : '', lastLabel: r.label, currentPageSize: r.currentPageSize, coretaxAs: r.coretaxAs,
        jenisRequested: r.jenisRequested, jenisTally: r.jenisTally, holdReason: r.holdReason,
        plan: r.plan ? { items: r.plan.items, states: r.plan.states.slice(), index: r.plan.index } : null,
        feature: r.feature, ...controlState(r)
    } : { key: key || null, tag: '', active: false, queued: false, paused: false, label: '', currentPageSize: null, coretaxAs: '', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null };
    base.runs = runSummaries();
    base.anyActive = anyActive();
    base.limits = limits();
    return base;
}

/* ---------- Halaman Runs: GET /api/runs (lihat README "Halaman Runs") ---------- */

/** Keadaan publik: 'queued' | 'running' | 'paused' | 'hold' | 'stopping' | 'done' | 'failed' | 'stopped'. */
function publicState(r) {
    if (r.state === 'queued') return 'queued';
    if (r.state === 'done') return r.finalState || 'done';
    if (r.stopRequested) return 'stopping';
    if (r.paused && r.holdReason) return 'hold';
    if (r.paused && r.holding) return 'paused';
    return 'running';
}
const SECTION = { queued: 'inProgress', running: 'inProgress', paused: 'inProgress', stopping: 'inProgress', hold: 'needsYou', done: 'done', failed: 'done', stopped: 'done' };
function overallPosition(run) { const i = queue.findIndex((e) => e.run === run); return i === -1 ? 0 : i + 1; }

/** Satu baris halaman Runs - cukup untuk digambar tanpa membaca teks log. */
function runRecord(r) {
    const state = publicState(r);
    const plan = r.plan;
    const idx = plan && plan.index >= 0 ? plan.index : -1;
    const cur = plan && idx >= 0 ? plan.items[idx] : null;
    const doneN = plan ? plan.states.filter((x) => x === 'ok' || x === 'skip').length : 0;
    const slot = r.window ? parseSlot(r.window) : null;
    const queued = state === 'queued';
    const finished = r.state === 'done';
    const controls = Object.assign({}, r.controls);
    let hold = null;
    if (state === 'hold') {
        const choices = [{ id: 'retry', label: 'Try again', action: controls.retry ? 'retry' : 'resume' }];
        if (controls.skip) choices.push({ id: 'skip', label: cur ? 'Skip ' + cur.label : 'Skip', action: 'skip', item: cur ? cur.label : '' });
        choices.push({ id: 'stop', label: 'Stop', action: 'stop' });
        hold = { reason: r.holdReason, item: cur ? cur.label : '', choices };
    }
    let outcome = null;
    if (finished) outcome = { kind: state, text: r.outcomeText || DEFAULT_OUTCOME[state] || '', custom: !!r.outcomeText };
    return {
        key: 'run:' + r.id, id: r.id, state, section: SECTION[state],
        feature: r.feature, label: r.label,
        entity: { id: r.entity, name: r.entityName || '', npwp: r.npwp || '', tag: r.tag },
        pic: r.pool, window: r.window || null, windowNo: slot && isPicPool(r.pool) ? slot.n : null,
        queue: queued ? { position: overallPosition(r), poolPosition: positionOf(r), reason: r.waitReason || '', reasonText: r.waitBy || r.waitReason ? waitWhy(r, { reason: r.waitReason, by: r.waitBy }) : '', waitingFor: r.waitBy ? { key: 'run:' + r.waitBy.id, label: r.waitBy.label } : null } : null,
        queuedAt: r.createdAt, startedAt: queued ? null : r.startedAt, endedAt: r.endedAt || null,
        progress: plan ? {
            total: plan.items.length, done: doneN, hold: plan.states.filter((x) => x === 'hold').length,
            current: cur ? { index: idx, label: cur.label, short: cur.short } : null,
            items: plan.items.map((it, i) => ({ label: it.label, short: it.short, state: plan.states[i] }))
        } : null,
        hold, controls, stopRequested: state === 'stopping', pauseRequested: !finished && !queued && !!r.paused && !r.holding && !r.holdReason && !r.stopRequested,
        changesCoretax: !!r.changesCoretax, outcome, outputDir: r.outputDir || null, batch: r.batch ? Object.assign({}, r.batch) : null
    };
}
/** Kelompok (batch) dari catatan proses: { id, label, feature, total, counts, startedAt, endedAt|null } (null = masih ada yang aktif / antre). */
function batchesOf(records) {
    const map = new Map();
    for (const x of records) {
        if (!x.batch) continue;
        let b = map.get(x.batch.id);
        if (!b) { b = { id: x.batch.id, label: x.batch.label, feature: x.feature, total: x.batch.total, counts: { queued: 0, running: 0, hold: 0, done: 0, failed: 0, stopped: 0 }, startedAt: x.queuedAt, endedAt: 0, open: false }; map.set(b.id, b); }
        b.counts[x.state === 'paused' || x.state === 'stopping' ? 'running' : x.state]++;
        b.total = Math.max(b.total || 0, x.batch.total || 0);
        b.startedAt = Math.min(b.startedAt, x.queuedAt);
        if (x.section === 'done') b.endedAt = Math.max(b.endedAt, x.endedAt || 0); else b.open = true;
    }
    return Array.from(map.values()).map((b) => { const o = b.open; delete b.open; if (o) b.endedAt = null; return b; }).sort((a, b) => a.startedAt - b.startedAt);
}
/** Minta Stop untuk setiap proses kelompok `id` yang masih aktif / antre. Mengembalikan jumlahnya, atau null bila kelompok tidak dikenal. */
function stopBatch(id) {
    const list = Array.from(runs.values()).filter((r) => r.batch && r.batch.id === id);
    if (!list.length) return null;
    let n = 0;
    for (const r of list) if (r.active) { stop('run:' + r.id); n++; }
    return n;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Semua bagian halaman Runs. `done` = yang selesai HARI INI (riwayat memori sesi ini). */
function runsOverview() {
    const all = Array.from(runs.values()).map(runRecord);
    const by = (s) => all.filter((x) => x.section === s);
    const live = (a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id - b.id;
    const needsYou = by('needsYou').sort(live);
    const inProgress = by('inProgress').sort((a, b) => {
        const qa = a.state === 'queued', qb = b.state === 'queued';
        if (qa !== qb) return qa ? 1 : -1;
        return qa ? a.queue.position - b.queue.position || a.id - b.id : live(a, b);
    });
    const t0 = startOfToday();
    const done = by('done').filter((x) => (x.endedAt || 0) >= t0).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0) || b.id - a.id);
    const lim = limits();
    const batches = batchesOf(all.filter((x) => x.section !== 'done' || (x.endedAt || 0) >= t0));
    return { needsYou, inProgress, done, batches, limits: { perPic: lim.perPic, total: lim.total, running: picRunningCount() } };
}
/** Satu proses (kunci "run:<id>"; selain itu seperti pick()) - null bila tidak ada. */
function runDetail(key) { const r = key ? pick(key) : null; return r ? runRecord(r) : null; }
/** Membuang proses yang sudah selesai dari riwayat; mengembalikan id yang dibuang. */
function clearDone() {
    const ids = [];
    for (const r of Array.from(runs.values())) if (r.state === 'done') { runs.delete(r.id); ids.push(r.id); }
    if (ids.length) notify();
    return ids;
}

/** Batas diubah (Pengaturan): antrean dicoba lagi. Juga dipanggil saat jendela dibuka / ditutup. */
function limitsChanged() { pump(); }

// Live page-size override: the user watches the site and forces a size mid-run. The download
// loop reads it at the next page boundary via takePageSizeOverride() (which clears it).
function setPageSizeOverride(n, key) { const run = pick(key); if (isRunning(run) && !unsupported(run, 'pageSize')) { run.pageSizeOverride = n; rlog(run, '📄 Override manual: baris per halaman diminta jadi ' + n + ' (berlaku di halaman berikutnya).'); } }
function takePageSizeOverride() { const run = current(); if (!run) return null; const v = run.pageSizeOverride; run.pageSizeOverride = null; return v; }
function reportPageSize(n) { const run = current(); if (run) run.currentPageSize = n; } // loop reports its actual current size (for the GUI)

/** Hanya untuk tes: keadaan internal (tidak ada yang bocor sesudah semua proses selesai?). */
function _debugState() { return { queue: queue.length, holders: Array.from(holders.keys()), locks: Array.from(locks.keys()), active: activeRuns().map((r) => r.key) }; }

module.exports = {
    start, enqueue, finish, isBusy, pause, pauseForDecision, resume, stop, skip, retry, back, stopAll, checkpoint, stopRequested, status, anyActive, current, assertWindowFree,
    _setKeepDone: (n) => { const p = KEEP_DONE; KEEP_DONE = n; prune(); return p; }, windowKeyFor, acquireWindow, setOutput, outputDirOf, markFailed, markStopped, runsOverview, runDetail, stopBatch, clearDone, setWindowProvider, limitsChanged, pump, slotKey, parseSlot, positionOf, pick,
    isolate: ctx.isolate, setCoretaxAs, setPageSizeOverride, takePageSizeOverride, reportPageSize, setJenisRequested, recordRowDone, setPlan, markCombo,
    StopRunError, SkipComboError, RetryComboError, BackComboError, DEFAULT_KEY, MANUAL_KEY, timing, _debugState
};
