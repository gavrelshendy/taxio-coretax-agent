/* Taxio Pilot - pendaftaran akun Taxio Hub dari dalam aplikasi.
   Meniru persis alur signup web Taxio Hub (Taxio Hub/supabase.js: authSignUp + authHandleSession),
   termasuk model antrean yang berlaku sejak Fase 42 (supabase/history/schema_phase42.sql):
     1. signUp(email, sandi) - kalau proyek Supabase meminta konfirmasi email, belum ada sesi.
     2. Setelah login pertama, inisial diajukan lewat RPC request_membership(p_initial), yang
        menaruh permintaan di antrean global (membership_requests).
     3. Super-admin menempatkan pengguna ke grup (assign_membership_request) - itu SEKALIGUS
        persetujuan dan pengaktifan, jadi hanya ada satu tahap "menunggu admin".
   Inisial disimpan di file lokal (pengganti localStorage 'taxio_pending_initial' di web) sampai
   sesi pertama tersedia. Modul ini tidak memegang state global; lib/connection.js yang
   menyimpan hasilnya. */
const path = require('path');
const { dataDir, readJson, writeJsonAtomic } = require('./data-dir');

// Sama dengan emailRedirectTo di Taxio Hub: tautan konfirmasi email membuka Taxio Hub web.
const EMAIL_REDIRECT_TO = 'https://taxio-hub.pages.dev/';
const INITIAL_MAX = 8;
const PASSWORD_MIN = 6;

function pendingFile() { return path.join(dataDir(), 'pending-signup.json'); }
function emailKey(email) { return String(email || '').trim().toLowerCase(); }

function normalizeInitial(v) { return String(v || '').trim().toUpperCase(); }

/** Pesan galat memakai kalimat yang sama dengan Taxio Hub bila ada padanannya. */
function validateSignup({ initial, email, password }) {
    const ini = normalizeInitial(initial);
    if (!ini) return 'Inisial wajib diisi.';
    if (ini.length > INITIAL_MAX) return 'Inisial maksimal ' + INITIAL_MAX + ' karakter.';
    if (!String(email || '').trim() || !password) return 'Email & kata sandi wajib diisi.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return 'Format email tidak valid.';
    if (String(password).length < PASSWORD_MIN) return 'Kata sandi minimal ' + PASSWORD_MIN + ' karakter.';
    return null;
}

function validateInitial(initial) {
    const ini = normalizeInitial(initial);
    if (!ini) return 'Inisial wajib diisi.';
    if (ini.length > INITIAL_MAX) return 'Inisial maksimal ' + INITIAL_MAX + ' karakter.';
    return null;
}

// ---- inisial yang menunggu sesi pertama ----
function rememberInitial(email, initial) {
    const all = readJson(pendingFile(), {});
    all[emailKey(email)] = { initial: normalizeInitial(initial), at: new Date().toISOString() };
    writeJsonAtomic(pendingFile(), all);
}
function recallInitial(email) {
    const rec = readJson(pendingFile(), {})[emailKey(email)];
    return rec && rec.initial ? rec.initial : '';
}
function forgetInitial(email) {
    const all = readJson(pendingFile(), {});
    if (!(emailKey(email) in all)) return;
    delete all[emailKey(email)];
    writeJsonAtomic(pendingFile(), all);
}

function isNetworkError(err) {
    return !!err && /fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timeout/i.test(String(err.message || err));
}

/** Menerjemahkan galat Supabase Auth yang umum ke kalimat yang bisa ditindaklanjuti. */
function friendlyAuthError(err) {
    const m = String((err && err.message) || err || '');
    if (/already registered|already been registered/i.test(m)) return 'Email ini sudah terdaftar. Silakan masuk.';
    if (/invalid login credentials/i.test(m)) return 'Email atau kata sandi salah.';
    if (/rate limit|too many/i.test(m)) return 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.';
    if (/password should be at least/i.test(m)) return 'Kata sandi minimal ' + PASSWORD_MIN + ' karakter.';
    if (/unable to validate email|invalid.*email/i.test(m)) return 'Format email tidak valid.';
    if (isNetworkError(err)) return 'Tidak bisa menghubungi server Taxio Hub. Periksa koneksi internet Anda.';
    return m || 'Terjadi kesalahan.';
}
function isEmailNotConfirmed(err) {
    return !!err && (err.code === 'email_not_confirmed' || /email not confirmed/i.test(String(err.message || '')));
}

/** Mendaftar. Mengembalikan:
 *   { status: 'confirm-email' }                        - menunggu klik tautan di email
 *   { status: 'session', session, user }               - proyek tidak meminta konfirmasi, sesi langsung ada */
async function signUp(client, { initial, email, password }) {
    const problem = validateSignup({ initial, email, password });
    if (problem) throw new Error(problem);
    const cleanEmail = String(email).trim();
    // Sama seperti web: inisial disimpan SEBELUM signUp supaya tetap ada sampai login pertama.
    rememberInitial(cleanEmail, initial);
    const { data, error } = await client.auth.signUp({ email: cleanEmail, password, options: { emailRedirectTo: EMAIL_REDIRECT_TO } });
    if (error) throw new Error(friendlyAuthError(error));
    // Supabase menyamarkan "email sudah terdaftar" sebagai sukses palsu tanpa identitas.
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        forgetInitial(cleanEmail);
        throw new Error('Email ini sudah terdaftar. Silakan masuk.');
    }
    if (!data || !data.session) return { status: 'confirm-email' };
    return { status: 'session', session: data.session, user: data.user };
}

/** Menentukan posisi akun dalam antrean, urutan dan kalimatnya mengikuti authHandleSession.
 *   'active'             - sudah anggota aktif sebuah grup
 *   'waiting-approval'   - punya baris membership tapi belum aktif (sisa alur lama)
 *   'waiting-assignment' - permintaan ada di antrean, menunggu super-admin menempatkan ke grup
 *   'need-initial'       - belum pernah mengajukan dan tidak ada inisial tersimpan */
async function resolveStatus(client, user, email) {
    const active = await client.rpc('get_my_active_membership');
    if (active.error && isNetworkError(active.error)) throw new Error(friendlyAuthError(active.error));
    if (!active.error && active.data && active.data[0]) return { status: 'active' };

    const rows = await client.from('memberships').select('user_id').eq('user_id', user.id).limit(1);
    if (rows.error && isNetworkError(rows.error)) throw new Error(friendlyAuthError(rows.error));
    if (!rows.error && rows.data && rows.data.length) return { status: 'waiting-approval' };

    // Antrean global. RPC ini bisa belum ada di proyek lama - dianggap "tidak ada permintaan".
    const queued = await client.rpc('get_my_membership_request');
    if (queued.error && isNetworkError(queued.error)) throw new Error(friendlyAuthError(queued.error));
    if (!queued.error && queued.data && queued.data.length) {
        return { status: 'waiting-assignment', initial: queued.data[0].initial || '' };
    }

    const remembered = recallInitial(email);
    if (remembered) {
        const sent = await client.rpc('request_membership', { p_initial: remembered });
        if (!sent.error) {
            forgetInitial(email);
            return { status: 'waiting-assignment', initial: remembered, submitted: true };
        }
        if (isNetworkError(sent.error)) throw new Error(friendlyAuthError(sent.error));
        // Pengajuan otomatis gagal (mis. inisial ditolak): biarkan pengguna mengetik ulang.
    }
    return { status: 'need-initial' };
}

/** Pengajuan manual inisial (layar "Satu langkah lagi"). */
async function submitInitial(client, email, initial) {
    const problem = validateInitial(initial);
    if (problem) throw new Error(problem);
    const ini = normalizeInitial(initial);
    const { error } = await client.rpc('request_membership', { p_initial: ini });
    if (error) throw new Error(friendlyAuthError(error));
    forgetInitial(email);
    return { status: 'waiting-assignment', initial: ini, submitted: true };
}

module.exports = {
    EMAIL_REDIRECT_TO, INITIAL_MAX, PASSWORD_MIN,
    validateSignup, validateInitial, normalizeInitial,
    rememberInitial, recallInitial, forgetInitial,
    friendlyAuthError, isEmailNotConfirmed, isNetworkError,
    signUp, resolveStatus, submitInitial
};
