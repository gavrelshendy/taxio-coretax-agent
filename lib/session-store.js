/* Persists Supabase Auth sessions across restarts, using a Node-compatible custom storage
   adapter (there's no browser localStorage here) - a single JSON file in the per-user data
   folder (lib/paths.js: %LOCALAPPDATA%\TaxioPilot\data since Tahap 1, copied over from
   ~/.coretax-agent once), not next to the exe, so replacing/moving the exe on an update never
   loses the saved connection(s). Supabase HTTP goes through lib/net.js (global.fetch option).

   supabase-js namespaces each project's session under its own derived key (based on the
   project ref in the URL), so Taxio (Grup) and Taxio.me sessions safely coexist in the SAME
   file - which is exactly what lets a user stay connected to BOTH at once, no "pick one"
   restriction.

   At rest (Tahap 2): the whole file is encrypted through lib/secrets.js (Electron safeStorage = Windows
   DPAPI, bound to this Windows account on this PC). A plaintext file from an older version is still read
   and is rewritten encrypted on the next write (sealIfPlain() at startup forces that once). A file that
   cannot be decrypted (copied from another PC/user) is moved aside to session.json.tidak-terbaca and the
   app starts logged out - one log line asks the user to log in again. Headless mode (tests) = plaintext. */
const path = require('path');
const fs = require('fs');
const { createClient, isAuthRetryableFetchError } = require('@supabase/supabase-js');
const PROJECTS = require('./supabase-projects');
const { log } = require('./log');
const { dataDir } = require('./data-dir');
const secrets = require('./secrets');
const net = require('./net');

/* Satu pintu untuk SEMUA permintaan Supabase (Taxio Hub) dari klien yang dibuat di sini (audit 2026-11-12):
 *  - BATAS WAKTU: tiap permintaan dibatalkan sesudah HUB_TIMEOUT_MS (bawaan 30 detik) lewat AbortSignal -
 *    berlaku untuk fetch Node maupun net.fetch Electron. Dulu satu permintaan yang menggantung menahan aksi
 *    selamanya tanpa pesan. Galatnya berbahasa Indonesia ("Taxio Hub tidak menjawab dalam 30 detik ...") dan
 *    ber-code ABORT_ERR, supaya postgrest-js tidak mengulangnya tiga kali lagi.
 *  - TOKEN SEGAR: permintaan data (bukan /auth/v1) dari klien bersesi dicek dulu lewat ensureFresh() - token
 *    yang tinggal < 10 menit diperbarui (sekali, tidak tumpang tindih), dan header Authorization ikut diganti.
 *  - TIDAK PERNAH ANONIM DIAM-DIAM: bila sesi sudah hilang (refresh token ditolak Taxio Hub) supabase-js
 *    jatuh ke anon key, dan Taxio Hub menjawab "permission denied" / daftar kosong yang membingungkan. Di
 *    sini permintaan seperti itu ditolak dengan "sesi login sudah kedaluwarsa - putuskan lalu hubungkan ulang
 *    akun ini." (atau "tidak bisa dihubungi" bila sesinya masih ada tapi jaringan putus).
 * net.fetch dibaca per permintaan, jadi setFetch (Electron net.fetch, proxy/PAC Windows) juga berlaku untuk
 * klien yang dibuat sebelum dipanggil. Klien "Supabase palsu" entitas lokal (lib/local-auth-client.js) tidak
 * lewat sini sama sekali (tidak ada HTTP). */
const DEFAULT_HUB_TIMEOUT_MS = 30000;
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
function hubTimeoutMs() {
    const v = Number(process.env.TAXIO_PILOT_HUB_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_HUB_TIMEOUT_MS;
}
/** name/code dipilih supaya pesan postgrest-js ("<name>: <message>") tetap terbaca dan tidak diulang. */
function hubTimeoutError(ms) {
    return Object.assign(new Error('Taxio Hub tidak menjawab dalam ' + Math.round(ms / 1000) + ' detik (timeout) - periksa koneksi internet, lalu coba lagi.'),
        { name: 'Koneksi', code: 'ABORT_ERR', isNetwork: true, hubTimeout: true });
}
const EXPIRED_MESSAGE = 'sesi login sudah kedaluwarsa - putuskan lalu hubungkan ulang akun ini.';
function sessionProblemError(kind) {
    return kind === 'network'
        ? Object.assign(new Error('Taxio Hub tidak bisa dihubungi untuk memperbarui sesi login (network) - periksa koneksi internet, lalu coba lagi.'), { name: 'Koneksi', code: 'ABORT_ERR', isNetwork: true })
        : Object.assign(new Error(EXPIRED_MESSAGE), { name: 'Taxio Hub', code: 'ABORT_ERR', sessionExpired: true });
}
/** Galat jaringan (bukan "sesi tidak sah"): tidak terjangkau, waktu habis, DNS, 5xx gateway. Juga untuk
 *  objek galat postgrest ({ message }) yang membawa pesan galat fetch aslinya. */
function isNetworkError(e) {
    if (!e) return false;
    if (e.isNetwork || isAuthRetryableFetchError(e)) return true;
    return /fetch failed|failed to fetch|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|network|timeout|tidak menjawab dalam|tidak bisa dihubungi|tidak bisa menghubungi/i.test(String(e.message || e));
}

/** fetch dengan batas waktu (AbortSignal). Batas waktu juga mencakup pembacaan body (pembatalan tertunda
 *  sampai waktunya; setelah body selesai dibaca, pembatalan tidak berpengaruh). Sinyal pemanggil tetap dihormati. */
function timedFetch(input, init, ms) {
    const timeoutMs = ms || hubTimeoutMs();
    const ac = new AbortController();
    const outer = init && init.signal;
    let timedOut = false;
    const onOuter = () => ac.abort(outer.reason);
    if (outer) { if (outer.aborted) ac.abort(outer.reason); else outer.addEventListener('abort', onOuter, { once: true }); }
    // Also rejects by itself, so a fetch implementation that ignored the signal still cannot hang the caller.
    let rejectTimeout;
    const timeoutP = new Promise((_, rej) => { rejectTimeout = rej; });
    const timer = setTimeout(() => {
        timedOut = true;
        ac.abort(hubTimeoutError(timeoutMs));
        if (outer) outer.removeEventListener('abort', onOuter);
        rejectTimeout(hubTimeoutError(timeoutMs));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    timeoutP.catch(() => {});
    const req = Promise.resolve()
        .then(() => net.fetch(input, Object.assign({}, init, { signal: ac.signal })))
        .catch((e) => { if (timedOut) throw hubTimeoutError(timeoutMs); throw e; });
    return Promise.race([req, timeoutP]);
}
const netFetch = (input, init) => timedFetch(input, init);

function _urlOf(input) { return typeof input === 'string' ? input : (input && input.url) || String(input); }
function _isAuthUrl(input) { return /\/auth\/v1\//.test(_urlOf(input)); }

/** fetch untuk klien bersesi (lihat blok di atas). `holder.client` diisi sesudah createClient. */
function sessionFetch(holder, project) {
    return async (input, init) => {
        const client = holder.client;
        if (client && client.__pilotAuthed && !_isAuthUrl(input)) {
            const headers = new Headers((init && init.headers) || undefined);
            const auth = headers.get('Authorization') || '';
            const anon = !auth || auth === 'Bearer ' + project.anonKey;
            const fresh = await ensureFresh(client).catch(() => null);
            const token = fresh && fresh.session && fresh.session.access_token;
            if (token) {
                if (auth !== 'Bearer ' + token) { headers.set('Authorization', 'Bearer ' + token); init = Object.assign({}, init, { headers }); }
            } else if (anon) {
                throw sessionProblemError(fresh && fresh.status === 'network' ? 'network' : 'invalid');
            }
        }
        return timedFetch(input, init);
    };
}

// Resolved on every access (not once at require time) through lib/data-dir.js, so
// TAXIO_PILOT_DATA_DIR (tests) is honoured even when it is set after this module was loaded -
// a test can never end up reading/writing the real Supabase tokens of this PC.
function storeFile() { return path.join(dataDir(), 'session.json'); }

const UNREADABLE = { what: 'Sesi login Taxio tersimpan', advice: 'Silakan masuk lagi ke akun Taxio Anda di dashboard.' };
function _loadAll() {
    const all = secrets.readSealedJson(storeFile(), {}, UNREADABLE);
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}
function _saveAll(obj) {
    try {
        // This file holds Supabase access + refresh tokens (long-lived account access), so keep
        // it owner-only. mode 0o700/0o600 is honored on POSIX; on Windows it's a no-op (the
        // per-user profile dir already restricts it), so this hardens the Linux/Mac case without
        // regressing Windows. Written via temp file + rename (writeJsonAtomic) so a crash or a
        // second instance writing at the same moment never leaves a half-written token file.
        const file = storeFile();
        secrets.writeSealedJson(file, obj);
        try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows / already-restricted */ }
    } catch (e) {
        log('Gagal menyimpan sesi lokal: ' + e.message);
    }
}
/** Rewrites a plaintext session.json encrypted (no-op when already encrypted / no encryption / no file). */
function sealIfPlain() {
    if (!secrets.needsSealing(storeFile())) return false;
    _saveAll(_loadAll());
    return true;
}

/** supabase-js `auth.storage` adapter backed by the shared JSON file above. */
class FileSessionStorage {
    async getItem(key) { return _loadAll()[key] ?? null; }
    async setItem(key, value) { const all = _loadAll(); all[key] = value; _saveAll(all); }
    async removeItem(key) { const all = _loadAll(); delete all[key]; _saveAll(all); }
}

function _clientFor(projectId) {
    const project = PROJECTS[projectId];
    if (!project) throw new Error('Project Supabase tidak dikenal: ' + projectId);
    // autoRefreshToken deliberately OFF: supabase-js's background auto-refresh machinery
    // (timers/locks meant for a long-lived browser tab) is unproven in a pkg-compiled Node
    // process and was the likely cause of an early hard crash during testing. persistSession
    // still keeps the session on disk across restarts; refreshSession() is called explicitly
    // (see refreshIfNeeded below) instead of relying on a background timer.
    // A background refresher (lib/hub-refresher.js) and ensureFresh() in the fetch wrapper replace it.
    const holder = {};
    const client = createClient(project.url, project.anonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            storage: new FileSessionStorage()
        },
        global: { fetch: sessionFetch(holder, project) }
    });
    holder.client = client;
    return { client, project };
}

/** Klien ini sekarang memegang sesi login: permintaan data tanpa sesi berarti sesinya hilang (lihat sessionFetch). */
function markAuthed(client, on) { if (client && typeof client === 'object') { try { client.__pilotAuthed = on !== false; } catch (e) { /* objek beku (tiruan tes) */ } } }

/** Sesi yang tersimpan di disk untuk klien ini (objek), atau null. */
function storedSession(client) {
    const key = client && client.auth && client.auth.storageKey;
    if (!key) return null;
    const raw = _loadAll()[key];
    if (!raw) return null;
    try { const s = typeof raw === 'string' ? JSON.parse(raw) : raw; return s && (s.refresh_token || s.access_token) ? s : null; } catch (e) { return null; }
}
/** Membuang sesi tersimpan project ini dari disk saja (tanpa permintaan ke Taxio Hub - dipakai saat keluar
 *  ketika sesinya belum pulih karena jaringan). */
function forgetStored(projectId) {
    try {
        const key = _clientFor(projectId).client.auth.storageKey;
        const all = _loadAll();
        if (key && key in all) { delete all[key]; _saveAll(all); }
    } catch (e) { log('Gagal membuang sesi tersimpan: ' + e.message); }
}
/** Ada sesi tersimpan untuk project ini? (tanpa jaringan) */
function hasStoredSession(projectId) {
    try { return !!storedSession(_clientFor(projectId).client); } catch (e) { return false; }
}

/** Fresh login with email+password for ONE project - does not affect any other project's
 *  connection (see lib/state.js, which tracks each project's connection independently). */
async function connectWithPassword(projectId, email, password) {
    const { client, project } = _clientFor(projectId);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    markAuthed(client);
    return { client, project, session: data.session, user: data.user };
}

/** Connects using an access token the caller ALREADY has (from an already-logged-in Taxio/
 *  Taxio.me web session) instead of an interactive email+password prompt - the taxio-coretax://
 *  deep-link integration's whole point: clicking a button in Taxio should feel like the legacy
 *  coretax-helper tool, not require a separate manual "connect" step in this app.
 *
 *  Mirrors coretax-helper/run.js's own proven pattern EXACTLY: create a plain client with the
 *  project's anon key, then attach `Authorization: Bearer <token>` as a global header rather
 *  than calling `auth.setSession()` - the deep link only ever carries an access_token (no
 *  refresh_token), and setSession() needs both to behave correctly. A raw bearer header is
 *  simpler and is all RLS/RPC calls need to authenticate as that user for this one run;
 *  `persistSession: false` because a fresh token arrives with every single deep-link click, so
 *  there is nothing worth persisting across restarts (unlike the password-login path above). */
async function connectWithToken(sbUrl, sbAnonKey, token) {
    const matched = Object.values(PROJECTS).find((p) => p.url === sbUrl);
    const project = matched || { id: 'deeplink', label: 'Taxio (via link)', url: sbUrl, anonKey: sbAnonKey };
    const client = createClient(project.url, sbAnonKey || project.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: 'Bearer ' + token }, fetch: netFetch }
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data || !data.user) throw new Error('Token sesi tidak valid atau kedaluwarsa: ' + (error ? error.message : 'unknown'));
    return { client, project, user: data.user };
}

/** Attempts to silently restore a previously-persisted session for ONE project. Returns null
 *  if that project was never connected, or its stored refresh token is no longer valid. THROWS
 *  (err.isNetwork) when the stored session needs a refresh and Taxio Hub cannot be reached - the
 *  session then stays on disk so lib/session-restore.js can retry later instead of logging out. */
async function restoreSession(projectId) {
    const { client, project } = _clientFor(projectId);
    if (!storedSession(client)) return null;
    const { data, error } = await client.auth.getSession();
    if (data && data.session) {
        markAuthed(client);
        return { client, project, session: data.session, user: data.session.user };
    }
    if (error && isNetworkError(error) && storedSession(client)) {
        throw Object.assign(new Error('Taxio Hub tidak bisa dihubungi (' + (error.message || 'network') + ')'), { isNetwork: true });
    }
    return null;
}

/** Restores every project that has a usable stored session - called once on startup so a
 *  user who was connected to both Grup and Taxio.me gets both back automatically. */
async function restoreAllSessions() {
    const out = {};
    for (const projectId of Object.keys(PROJECTS)) {
        try {
            const restored = await restoreSession(projectId);
            if (restored) out[projectId] = restored;
        } catch (e) { log('Gagal memulihkan sesi ' + PROJECTS[projectId].label + ': ' + e.message); }
    }
    return out;
}

/** Memastikan token akses klien ini masih berlaku >= `marginMs` (bawaan 10 menit); bila tidak, diperbarui
 *  sekali (pemanggil bersamaan berbagi satu pembaruan). Tidak pernah melempar. Hasil:
 *   { status: 'ok', session, refreshed? }      token siap dipakai (refresh yang gagal sementara token lama
 *                                              masih berlaku juga 'ok', dengan refreshError)
 *   { status: 'network', session: null }       token habis dan Taxio Hub tidak terjangkau - sesi tetap tersimpan
 *   { status: 'invalid', session: null }       sesi ditolak / hilang - perlu masuk lagi
 *   { status: 'none', session: null }          klien ini memang tidak pernah bersesi */
const _freshInflight = new WeakMap();
function ensureFresh(client, opts) {
    if (!client || !client.auth || typeof client.auth.getSession !== 'function') return Promise.resolve({ status: 'none', session: null });
    const pending = _freshInflight.get(client);
    if (pending) return pending;
    const marginMs = (opts && opts.marginMs) || REFRESH_MARGIN_MS;
    const p = (async () => {
        try {
            const lost = (error) => ({ status: storedSession(client) && (!error || isNetworkError(error)) ? 'network' : (client.__pilotAuthed ? 'invalid' : 'none'), session: null, error });
            const { data, error } = await client.auth.getSession();
            const session = data && data.session;
            if (!session) return lost(error);
            const left = (Number(session.expires_at) || 0) * 1000 - Date.now();
            if (left > marginMs) return { status: 'ok', session };
            const r = await client.auth.refreshSession();
            if (!r.error && r.data && r.data.session) return { status: 'ok', session: r.data.session, refreshed: true };
            if (left > 5000 && storedSession(client)) return { status: 'ok', session, refreshError: r.error };
            return lost(r.error);
        } catch (e) {
            return { status: isNetworkError(e) && storedSession(client) ? 'network' : 'invalid', session: null, error: e };
        }
    })();
    _freshInflight.set(client, p);
    p.finally(() => { if (_freshInflight.get(client) === p) _freshInflight.delete(client); });
    return p;
}

/** Manual, explicitly-triggered token refresh (replaces supabase-js's background auto-refresh
 *  - see the comment in _clientFor). Safe to call opportunistically; never throws, so a refresh
 *  failure never crashes a caller mid-automation-run. Resolves ensureFresh()'s result. */
async function refreshIfNeeded(client) {
    const r = await ensureFresh(client);
    if (r.status === 'network' || r.status === 'invalid' || r.refreshError) {
        log('Refresh sesi Taxio Hub gagal (' + (r.status === 'invalid' ? 'sesi ditolak' : 'jaringan') + '): ' + ((r.error || r.refreshError || {}).message || '-'));
    }
    return r;
}

async function disconnect(client) {
    markAuthed(client, false);
    try { if (client) await client.auth.signOut(); } catch (e) { /* ignore */ }
}

module.exports = {
    connectWithPassword, connectWithToken, restoreSession, restoreAllSessions, refreshIfNeeded, ensureFresh, disconnect, clientFor: _clientFor, FileSessionStorage, sealIfPlain,
    markAuthed, hasStoredSession, storedSession, forgetStored, isNetworkError, timedFetch, sessionFetch, hubTimeoutError, EXPIRED_MESSAGE, REFRESH_MARGIN_MS
};
// Kept for compatibility; now follows dataDir() (TAXIO_PILOT_DATA_DIR) at the time it is read.
Object.defineProperty(module.exports, 'STORE_FILE', { enumerable: true, get: storeFile });
