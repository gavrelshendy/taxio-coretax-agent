/* Taxio Pilot - pemulihan sesi Taxio Hub tersimpan DI LATAR (audit 2026-11-12).
 *
 * Dulu lib/app.js start() menunggu pemulihan (getSession, registration.resolveStatus, entities.getMyOrgId -
 * beberapa permintaan ke Taxio Hub) SEBELUM server dashboard dibuka: di PC yang lambat / offline aplikasi
 * terlihat tidak mau terbuka. Sekarang server dan jendela dibuka dulu, lalu modul ini memulihkan sesi:
 *   - selama berjalan, /api/session melaporkan `restore: { phase: 'restoring' }` per project -> dashboard
 *     menampilkan "Memulihkan sesi…", bukan form masuk yang lalu melompat ke aplikasi;
 *   - jaringan bermasalah (bukan "tidak ada sesi" / "sesi tidak sah"): sesi tersimpan DIPERTAHANKAN,
 *     `phase: 'retrying'` + nextRetryAt, dicoba lagi otomatis dengan jeda bertambah (5 dtk ... 5 menit) dan
 *     lewat tombol "Coba lagi" (POST /api/session/retry -> retryNow);
 *   - sesi tidak sah / galat lain: dicatat, status dibuang, pengguna masuk lagi seperti dulu.
 * Aksi / deep link yang datang selama pemulihan menunggu lewat waitIfRestoring() (terbatas), bukan langsung
 * gagal "belum terhubung". Masuk / keluar manual membatalkan pemulihan project itu (cancel()). */
const { log } = require('./log');

const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const WAIT_MAX_MS = 20000;

const _deps = {
    sessionStore: () => require('./session-store'),
    connection: () => require('./connection'),
    state: () => require('./state'),
    projects: () => require('./supabase-projects'),
    emit: (ev) => require('./ui-events').emit(ev),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout: (t) => clearTimeout(t),
    now: () => Date.now()
};

/** projectId -> { phase: 'restoring'|'retrying', email, attempt, nextRetryAt, error, timer, promise, gen } */
const status = {};
let _gen = 0;

function changed() { try { _deps.emit('session'); } catch (e) { /* abaikan */ } }
function label(projectId) { return ((_deps.projects()[projectId]) || {}).label || projectId; }

function done(projectId, st) {
    if (status[projectId] !== st) return;
    if (st.timer) _deps.clearTimeout(st.timer);
    delete status[projectId];
    changed();
}

function schedule(projectId, st, err) {
    const delay = BACKOFF_MS[Math.min(st.attempt - 1, BACKOFF_MS.length - 1)];
    st.phase = 'retrying';
    st.error = String((err && err.message) || err || 'jaringan');
    st.nextRetryAt = _deps.now() + delay;
    if (st.attempt === 1 || st.attempt % 5 === 0) {
        log('Taxio Hub belum bisa dihubungi saat memulihkan sesi ' + (st.email || label(projectId)) + ' (' + st.error + '). Sesi tersimpan tetap dipakai; dicoba lagi otomatis dalam ' + Math.round(delay / 1000) + ' detik (atau klik "Coba lagi").');
    }
    st.timer = _deps.setTimeout(() => { st.timer = null; if (status[projectId] === st) attempt(projectId, st); }, delay);
    changed();
}

function attempt(projectId, st) {
    if (st.promise) return st.promise;
    st.attempt++;
    st.phase = 'restoring';
    st.nextRetryAt = null;
    changed();
    const gen = st.gen;
    const stale = () => status[projectId] !== st || st.gen !== gen;
    st.promise = (async () => {
        const store = _deps.sessionStore();
        let restored = null;
        try {
            restored = await store.restoreSession(projectId);
            if (stale()) return 'cancelled';
            if (!restored) {
                log('Sesi tersimpan ' + (st.email || label(projectId)) + ' tidak berlaku lagi - silakan masuk lagi.');
                done(projectId, st);
                return 'invalid';
            }
            // Lewat pintu yang sama dengan login di dashboard: akun yang belum jadi anggota aktif
            // grup (masih menunggu admin) tidak dianggap terhubung, tapi statusnya tetap tampil.
            const reg = await _deps.connection().attach(projectId, {
                client: restored.client, project: restored.project, session: restored.session, user: restored.session.user
            });
            if (stale()) {
                // Pengguna keluar / masuk dengan akun lain selagi ini berjalan: jangan timpa pilihannya.
                const s = _deps.state();
                const cur = s.get(projectId) || s.getPending(projectId);
                if (cur && cur.client === restored.client) { s.clear(projectId); s.clearPending(projectId); }
                return 'cancelled';
            }
            if (reg.status === 'active') log('Sesi tersimpan dipulihkan: ' + restored.session.user.email + ' (' + restored.project.label + ').');
            else log('Sesi tersimpan dipulihkan: ' + restored.session.user.email + ', tapi akun belum aktif di grup (' + reg.status + ').');
            done(projectId, st);
            return 'ok';
        } catch (e) {
            if (stale()) return 'cancelled';
            if (store.isNetworkError(e)) { schedule(projectId, st, e); return 'network'; }
            log('Tidak bisa memulihkan sesi ' + label(projectId) + ' (' + e.message + ') - silakan hubungkan ulang.');
            done(projectId, st);
            return 'failed';
        }
    })().finally(() => { st.promise = null; });
    return st.promise;
}

/** Mulai memulihkan semua project yang punya sesi tersimpan. Tidak menunggu jaringan: resolves sesudah
 *  percobaan PERTAMA tiap project selesai (berhasil / gagal / dijadwalkan ulang). Tidak pernah reject. */
function start() {
    const store = _deps.sessionStore();
    const runs = [];
    for (const projectId of Object.keys(_deps.projects())) {
        if (status[projectId]) { runs.push(status[projectId].promise); continue; }
        let stored = null;
        try { stored = store.storedSession(store.clientFor(projectId).client); } catch (e) { stored = null; }
        if (!stored) continue;
        const st = { phase: 'restoring', email: (stored.user && stored.user.email) || '', attempt: 0, nextRetryAt: null, error: '', timer: null, promise: null, gen: ++_gen };
        status[projectId] = st;
        runs.push(attempt(projectId, st));
    }
    return Promise.all(runs).catch(() => {});
}

/** "Coba lagi" (atau aksi yang datang selagi menunggu jadwal): percobaan sekarang juga. Resolves hasilnya. */
function retryNow(projectId) {
    const ids = projectId ? [projectId] : Object.keys(status);
    return Promise.all(ids.map((id) => {
        const st = status[id];
        if (!st) return 'none';
        if (st.timer) { _deps.clearTimeout(st.timer); st.timer = null; }
        return attempt(id, st);
    })).then((r) => (projectId ? r[0] : r));
}

/** Membatalkan pemulihan project ini (pengguna masuk / keluar sendiri). */
function cancel(projectId) {
    const st = status[projectId];
    if (!st) return;
    st.gen = ++_gen;
    if (st.timer) _deps.clearTimeout(st.timer);
    delete status[projectId];
    changed();
}

/** Masih ada pemulihan yang sedang berjalan / menunggu jadwal? */
function active(projectId) { return projectId ? !!status[projectId] : Object.keys(status).length > 0; }

/** Aksi dan deep link yang datang selama pemulihan menunggu hasilnya (maks `maxMs`, bawaan 20 detik)
 *  supaya tidak langsung gagal "belum terhubung". Yang sedang menunggu jadwal ulang dicoba sekarang juga. */
async function waitIfRestoring(maxMs) {
    const ids = Object.keys(status);
    if (!ids.length) return false;
    const limit = maxMs == null ? WAIT_MAX_MS : maxMs;
    let timer;
    await Promise.race([
        Promise.all(ids.map((id) => (status[id] ? (status[id].phase === 'retrying' ? retryNow(id) : status[id].promise) : null))).catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, limit); })
    ]);
    clearTimeout(timer);
    return true;
}

/** Untuk /api/session: { phase, email, attempt, nextRetryAt, error } atau undefined. */
function summary(projectId) {
    const st = status[projectId];
    if (!st) return undefined;
    return { phase: st.phase, email: st.email || '', attempt: st.attempt, nextRetryAt: st.nextRetryAt || null, error: st.phase === 'retrying' ? st.error : '' };
}

/** Saat keluar (dan tes): hentikan semua jadwal. */
function stop() {
    for (const id of Object.keys(status)) { const st = status[id]; st.gen = ++_gen; if (st.timer) _deps.clearTimeout(st.timer); delete status[id]; }
}

module.exports = { start, retryNow, cancel, active, waitIfRestoring, summary, stop, BACKOFF_MS, WAIT_MAX_MS, _deps };
