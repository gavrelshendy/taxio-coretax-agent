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
   row's work) without ever interrupting a row's download mid-flight. */
const { log } = require('./log');
const ctx = require('./run-context');
const uiEvents = require('./ui-events');

class StopRunError extends Error { constructor() { super('Proses dihentikan oleh pengguna.'); this.isStop = true; } }
class SkipComboError extends Error { constructor() { super('Kombinasi filter saat ini dilewati oleh pengguna.'); this.isSkip = true; } }
class RetryComboError extends Error { constructor() { super('Kombinasi filter saat ini diulang dari awal oleh pengguna.'); this.isRetry = true; } }
class BackComboError extends Error { constructor() { super('Kembali ke kombinasi filter sebelumnya atas permintaan pengguna.'); this.isBack = true; } }

const DEFAULT_KEY = 'default';
const MANUAL_KEY = 'manual';
/** Proses yang sudah selesai yang tetap disimpan (dashboard / MCP masih membaca hasil akhirnya). */
const KEEP_DONE = 30;
/** Menunggu jendela PIC lain (SPT jatuh ke PIC penanda tangan lain) paling lama ini, lalu PIC itu dilewati. */
const timing = { BORROW_WAIT_MS: 2 * 60 * 1000 }; // tes boleh memperpendek

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
        plan: null, holdReason: ''
    };
}
function resetFlags(run) { run.holdReason = ''; run.paused = false; run.stopRequested = false; run.skipRequested = false; run.retryRequested = false; run.backRequested = false; run.pageSizeOverride = null; }
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
function waitText(run, res) {
    const pos = positionOf(run);
    const why = res.reason === 'lock' ? 'perintah yang sama untuk entitas ini masih berjalan ("' + (res.by && res.by.label) + '")'
        : res.reason === 'total' ? 'semua jendela otomasi sedang dipakai (batas ' + limits().total + ' jendela berjalan)'
            : run.pool === MANUAL_KEY ? 'jendela manual masih menjalankan "' + (res.by && res.by.label) + '"'
                : run.wantWindow ? 'jendela entitas ini masih menjalankan "' + (res.by && res.by.label) + '"'
                    : 'semua jendela PIC ini sedang dipakai (batas ' + limits().perPic + ' jendela per PIC)';
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
    if (changed) uiEvents.emit('run');
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
    uiEvents.emit('run');
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
        uiEvents.emit('run');
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
            uiEvents.emit('run');
        }, opt.maxWaitMs);
    }
    rlog(run, waitText(run, res));
    prune();
    uiEvents.emit('run');
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
    uiEvents.emit('run');
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
            uiEvents.emit('run');
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
}
/** state: 'run' (sedang dikerjakan) | 'ok' | 'skip' | 'wait' (mis. setelah Mundur) | 'hold'. */
function markCombo(i, state) {
    const run = current();
    if (!run || !run.plan || i < 0 || i >= run.plan.items.length) return;
    run.plan.states[i] = state;
    if (state === 'run') run.plan.index = i;
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
    }
    release(run);
    run.state = 'done'; run.queued = false;
    run.active = false; run.lingering = false; run.coretaxAs = ''; run.currentPageSize = null; run.endedAt = Date.now(); resetFlags(run);
    prune();
    uiEvents.emit('run');
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
function pause(key) { const run = pick(key); if (isRunning(run) && !run.paused) { run.paused = true; rlog(run, '⏸ Proses dijeda - klik Lanjut untuk meneruskan.'); } }
/** Like pause(), but used internally when a combo fails: holds the run so the user can decide
 *  (Retry / Back / Skip / or fix the browser manually then Resume) instead of auto-skipping. */
function pauseForDecision(reason) {
    const run = current();
    if (!run || !run.active) return;
    run.paused = true; run.holdReason = String(reason || '');
    if (run.plan && run.plan.index >= 0) run.plan.states[run.plan.index] = 'hold';
    log('⏸ DIJEDA karena masalah: ' + reason + ' - pilih 🔁 Ulang / ⏭ Lewati / ⏮ Mundur, atau perbaiki sendiri di jendela Coretax lalu klik ▶ Lanjut.');
}
function resume(key) { const run = pick(key); if (isRunning(run) && run.paused) { run.paused = false; run.holdReason = ''; rlog(run, '▶ Proses dilanjutkan.'); } }
function request(key, flag, msg) {
    const run = pick(key);
    if (!isRunning(run)) return;
    run[flag] = true; run.paused = false; run.holdReason = '';
    rlog(run, msg);
}
/** Hentikan: proses yang berjalan berhenti di checkpoint berikutnya; proses yang masih antre dibatalkan. */
function stop(key) {
    const run = pick(key);
    if (run && run.state === 'queued') { cancelQueued(run); return; }
    request(run ? 'run:' + run.id : key, 'stopRequested', '⏹ Permintaan berhenti diterima - berhenti setelah baris saat ini selesai.');
}
function skip(key) { request(key, 'skipRequested', '⏭ Permintaan lewati diterima - kombinasi saat ini dilewati, lanjut ke berikutnya.'); }
function retry(key) { request(key, 'retryRequested', '🔁 Permintaan ulangi diterima - kombinasi saat ini diulang dari awal (file yang sudah ada dilewati otomatis).'); }
function back(key) { request(key, 'backRequested', '⏮ Permintaan mundur diterima - kembali ke kombinasi sebelumnya (file yang sudah ada dilewati otomatis).'); }
/** Menghentikan semua proses yang masih berjalan dan membatalkan antrean (mis. aplikasi ditutup). */
function stopAll() { for (const r of activeRuns()) stop('run:' + r.id); }

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
    const slot = r.window ? parseSlot(r.window) : null;
    return {
        key: r.key, id: r.id, pool: r.pool, entity: r.entity, window: r.window || null, windowNo: slot && isPicPool(r.pool) ? slot.n : null,
        tag: r.tag, label: r.label, feature: r.feature, active: r.active, queued: r.state === 'queued', position: r.state === 'queued' ? positionOf(r) : 0,
        waitReason: r.state === 'queued' ? r.waitReason : '', paused: r.paused, held: !!(r.paused && r.holdReason), startedAt: r.startedAt, endedAt: r.endedAt || null, progress: prog
    };
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
        plan: r.plan ? { items: r.plan.items, states: r.plan.states.slice(), index: r.plan.index } : null
    } : { key: key || null, tag: '', active: false, queued: false, paused: false, label: '', currentPageSize: null, coretaxAs: '', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null };
    base.runs = runSummaries();
    base.anyActive = anyActive();
    base.limits = limits();
    return base;
}

/** Batas diubah (Pengaturan): antrean dicoba lagi. Juga dipanggil saat jendela dibuka / ditutup. */
function limitsChanged() { pump(); }

// Live page-size override: the user watches the site and forces a size mid-run. The download
// loop reads it at the next page boundary via takePageSizeOverride() (which clears it).
function setPageSizeOverride(n, key) { const run = pick(key); if (isRunning(run)) { run.pageSizeOverride = n; rlog(run, '📄 Override manual: baris per halaman diminta jadi ' + n + ' (berlaku di halaman berikutnya).'); } }
function takePageSizeOverride() { const run = current(); if (!run) return null; const v = run.pageSizeOverride; run.pageSizeOverride = null; return v; }
function reportPageSize(n) { const run = current(); if (run) run.currentPageSize = n; } // loop reports its actual current size (for the GUI)

/** Hanya untuk tes: keadaan internal (tidak ada yang bocor sesudah semua proses selesai?). */
function _debugState() { return { queue: queue.length, holders: Array.from(holders.keys()), locks: Array.from(locks.keys()), active: activeRuns().map((r) => r.key) }; }

module.exports = {
    start, enqueue, finish, isBusy, pause, pauseForDecision, resume, stop, skip, retry, back, stopAll, checkpoint, status, anyActive, current, assertWindowFree,
    windowKeyFor, acquireWindow, setWindowProvider, limitsChanged, pump, slotKey, parseSlot, positionOf, pick,
    isolate: ctx.isolate, setCoretaxAs, setPageSizeOverride, takePageSizeOverride, reportPageSize, setJenisRequested, recordRowDone, setPlan, markCombo,
    StopRunError, SkipComboError, RetryComboError, BackComboError, DEFAULT_KEY, MANUAL_KEY, timing, _debugState
};
