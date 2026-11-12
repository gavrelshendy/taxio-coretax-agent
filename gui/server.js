/* Coretax Agent - local GUI server.
   Plain node:http (no Express - zero new runtime deps, avoids reintroducing any pkg-bundling
   risk). Bound to 127.0.0.1 only. Serves the static dashboard from gui/public/ and a small
   hand-written JSON API. Route table (ROUTES, bottom of this file) is a literal object (no
   directory-scanning route loader) so pkg's static analyzer can see every require() at build time.

   Supports being connected to BOTH Taxio (Grup) and Taxio.me at once (see lib/state.js) -
   every route that touches "the connection" takes an explicit `project` id rather than
   assuming a single global one.

   Akses (Tahap 1): port dinamis (51733 bila bebas) dan token per peluncuran - setiap /api/* dan
   /events butuh `Authorization: Bearer <token>` atau cookie dari /?t=<token>; lihat gui/guards.js
   dan lib/runtime.js. Handler menerima ctx { url, sess, token, port }.

   Menambah aksi Coretax baru: bungkus handler dengan action({...}) (versi usang, body, entitas,
   Restricted - lihat di bawah) lalu jalankan kerjanya lewat runInBackground() (409/202, log
   berhenti/gagal, runcontrol.finish). Kebijakan akses ada di gui/guards.js. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log, onLogLine, LOG_FILE, pendingNotices, ackNotice } = require('../lib/log');
const state = require('../lib/state');
const sessionStore = require('../lib/session-store');
const entitiesLib = require('../lib/entities');
const PROJECTS = require('../lib/supabase-projects');
const runcontrol = require('../lib/runcontrol');
const chrome = require('../lib/chrome');
const loginStatus = require('../lib/login-status');
const { runEbupotDownload } = require('../automation/ebupot');
const { runMyBuktiPotongDownload } = require('../automation/mybupot');
const { runLoginOnly } = require('../automation/login');
const { runSptDownload } = require('../automation/spt');
const { runDividenImport, runDividenCheck, openNewCase } = require('../automation/dividen');
const pajakMasukan = require('../automation/pajakmasukan');
const efaktur = require('../automation/efaktur');
const { runBillingPph25 } = require('../automation/billing');
const registration = require('../lib/registration');
const connection = require('../lib/connection');
const localEntities = require('../lib/local-entities');
const localAuth = require('../lib/local-auth-client');
const masaLib = require('../lib/masa');
const deeplink = require('../lib/deeplink');
const compliance = require('../lib/compliance');
const tray = require('../lib/tray');
const updater = require('../lib/updater');
const fileDialog = require('../lib/file-dialog');
const { closeWindow, ensureWindowOpenOrFocused } = require('./window');
const runtime = require('../lib/runtime');
const doctor = require('../lib/doctor');
const diagnostics = require('../lib/diagnostics');
const { sendJson, readJsonBody, readLargeJsonBody, serveStatic } = require('./http-util');
const {
    requestOriginProblem, authProblem, needsAuth, setAuthCookieHeader, UNAUTHORIZED_MESSAGE, isProjectRestricted, anyRestricted, rejectIfRestricted,
    isEbupotTypeAllowed, isMyBupotAllowed, isIndividualEntityBlocked, ABSOLUTELY_BLOCKED_MYBUPOT_TYPES,
    rejectIfOutdated
} = require('./guards');
// Single source of truth for the version badge in gui/public/index.html - that used to be a
// hardcoded <span>v1.8.1</span> that nobody remembered to bump across three straight releases
// (1.9.0/1.9.1/1.9.2 all shipped correctly but kept showing v1.8.1 in the dashboard itself).
// Reading it live here means every future version bump only ever has to happen in one place
// (package.json) again.
const pkg = require('../package.json');

const PROJECTS_WITH_OWNER_COLUMN = {};
// Smoke run (main.js TAXIO_PILOT_SMOKE=1): never open / focus / close dashboard windows.
const SMOKE = process.env.TAXIO_PILOT_SMOKE === '1';

const LOG_BACKLOG_MAX = 200;
const logBacklog = [];
onLogLine((entry) => {
    logBacklog.push(entry);
    if (logBacklog.length > LOG_BACKLOG_MAX) logBacklog.shift();
});

// ---- Kerangka aksi ----

/** Membungkus handler aksi dengan pemeriksaan yang SAMA untuk setiap route, berurutan:
 *   1. versi usang -> 426 (kecuali `outdated: false`, hanya untuk route yang tidak menyentuh Coretax);
 *   2. body JSON -> 400 bila tidak valid (`body: 'large'` = batas 20MB untuk file base64;
 *      `body: 'lenient'` = body rusak dianggap kosong);
 *   3. `entity` (bawaan: wajib) -> 400 'Entitas belum dipilih.' (`entity: false` bila opsional);
 *   4. `restricted: '<pesan>'` -> 403 untuk pengguna Restricted Editor.
 *  Lalu memanggil fn(req, res, body, ctx) dengan body yang selalu berupa objek. */
function action(opts, fn) {
    return async (req, res, ctx) => {
        if (opts.outdated !== false && rejectIfOutdated(res)) return;
        let body;
        if (opts.body === 'lenient') {
            try { body = await readJsonBody(req); } catch (e) { body = null; }
        } else {
            const large = opts.body === 'large';
            try { body = await (large ? readLargeJsonBody(req) : readJsonBody(req)); }
            catch (e) { return sendJson(res, 400, { error: (large && e.message) || 'Body tidak valid.' }); }
        }
        body = body || {};
        if (opts.entity !== false && !(body.entity && body.entity.project)) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
        if (opts.restricted && rejectIfRestricted(res, opts.restricted)) return;
        return fn(req, res, body, ctx);
    };
}

function runSessionKey() { const r = runcontrol.current(); return r ? r.key : null; }

/** Satu proses otomasi di latar: daftar di runcontrol (409 bila sesi itu sibuk), balas 202
 *  { started, session, ...extra } segera (proses bisa berjalan bermenit-menit dan melaporkan
 *  kemajuannya lewat /events), jalankan `work`, lalu SELALU runcontrol.finish().
 *  Galat: `quiet(e)` true = sudah dilaporkan sendiri; Stop pengguna -> log `stopMsg`; selainnya
 *  log `failPrefix + e.message`. `cleanup` berjalan sesudah finish().
 *  Dipanggil dari dalam handler (alur async permintaan yang sama), karena runcontrol.start()
 *  mengikat proses ke konteks AsyncLocalStorage permintaan itu (runcontrol.isolate). */
async function runInBackground(res, { label, session, extra, onStart }, work, { stopMsg, failPrefix, quiet, cleanup } = {}) {
    try { runcontrol.start(label, session); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    if (onStart) onStart();
    sendJson(res, 202, Object.assign({ started: true, session: runSessionKey() }, extra));
    try {
        await work();
    } catch (e) {
        if (quiet && quiet(e)) { /* sudah dilaporkan */ }
        else if (e && e.isStop) log(stopMsg || 'Proses dihentikan oleh pengguna.');
        else log((failPrefix || 'Gagal: ') + (e && e.message));
    } finally {
        runcontrol.finish();
        if (cleanup) await cleanup();
    }
}

/** Seperti runInBackground, tetapi menunggu hasilnya (pratinjau / pencarian yang hanya membaca):
 *  200 dengan nilai `work()`, atau 400 + log `failPrefix + pesan`. */
async function runForResult(res, { label, session }, work, { failPrefix }) {
    try { runcontrol.start(label, session); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    try { return sendJson(res, 200, await work()); }
    catch (e) { log(failPrefix + e.message); return sendJson(res, 400, { error: e.message }); }
    finally { runcontrol.finish(); }
}

/** Opsi run untuk automation/* dari resolveEntitySource: sesi manual polos vs login otomatis. */
function runOptsFor(src, common, autoExtra) {
    return src.kind === 'manual'
        ? Object.assign({ manualPage: src.manualPage, entity: src.runEntity }, common)
        : Object.assign({ client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId }, common,
            { restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase }, autoExtra);
}

function sessionSummary() {
    const out = {};
    for (const projectId of Object.keys(PROJECTS)) {
        const conn = state.get(projectId);
        const restricted = isProjectRestricted(projectId);
        // `pending`: akun sudah masuk/mendaftar tapi belum jadi anggota aktif grup (lihat
        // lib/connection.js) - dashboard menampilkan layar status pendaftaran, bukan aplikasi.
        const pending = state.getPending(projectId);
        out[projectId] = conn && state.isConnected(projectId)
            ? { connected: true, label: PROJECTS[projectId].label, email: conn.user.email, role: restricted ? 'restricted_editor' : conn.role }
            : { connected: false, label: PROJECTS[projectId].label, pending: pending ? { status: pending.status, email: pending.email, initial: pending.initial || '' } : undefined };
    }
    return out;
}

async function handleConnect(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { project, email, password } = body || {};
    if (!PROJECTS[project]) return sendJson(res, 400, { error: 'Project tidak dikenal.' });
    if (!email || !password) return sendJson(res, 400, { error: 'Email & kata sandi wajib diisi.' });
    try {
        const auth = await sessionStore.connectWithPassword(project, email, password);
        const reg = await connection.attach(project, auth);
        if (reg.status === 'active') log('Terhubung sebagai ' + auth.user.email + ' (' + auth.project.label + ').');
        return sendJson(res, 200, sessionSummary());
    } catch (e) {
        // Akun sudah dibuat tapi tautan konfirmasi email belum diklik: bukan galat, tampilkan
        // layar status pendaftaran.
        if (registration.isEmailNotConfirmed(e)) {
            state.clear(project);
            state.setPending(project, { client: null, project: PROJECTS[project], session: null, user: null, email: String(email).trim(), status: 'confirm-email', initial: registration.recallInitial(email) });
            return sendJson(res, 200, sessionSummary());
        }
        log('Gagal terhubung (' + PROJECTS[project].label + '): ' + e.message);
        return sendJson(res, 400, { error: registration.friendlyAuthError(e) });
    }
}

/** Daftar akun Taxio Hub baru dari dalam aplikasi - alur yang sama dengan halaman daftar web
 *  (lihat lib/registration.js). Tidak membuat sesi terhubung: akun baru selalu menunggu admin
 *  menempatkannya ke grup. */
async function handleSignup(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { initial, email, password } = body || {};
    const project = (body && body.project) || 'taxio_hub';
    if (!PROJECTS[project]) return sendJson(res, 400, { error: 'Project tidak dikenal.' });
    if (state.isConnected(project)) return sendJson(res, 409, { error: 'Anda sudah masuk. Putuskan akun ini dulu untuk mendaftarkan akun lain.' });
    const problem = registration.validateSignup({ initial, email, password });
    if (problem) return sendJson(res, 400, { error: problem });
    try {
        const { client, project: proj } = sessionStore.clientFor(project);
        const r = await registration.signUp(client, { initial, email, password });
        if (r.status === 'confirm-email') {
            state.setPending(project, { client: null, project: proj, session: null, user: null, email: String(email).trim(), status: 'confirm-email', initial: registration.normalizeInitial(initial) });
            log('Pendaftaran ' + String(email).trim() + ': akun dibuat, menunggu konfirmasi email.');
        } else {
            await connection.attach(project, { client, project: proj, session: r.session, user: r.user });
        }
        return sendJson(res, 200, sessionSummary());
    } catch (e) {
        log('Gagal mendaftar: ' + e.message);
        return sendJson(res, 400, { error: e.message });
    }
}

/** "Periksa status": menanyakan ulang posisi akun ke Taxio Hub. Memakai sesi yang sudah ada,
 *  jadi tidak perlu kata sandi lagi. Sebelum email dikonfirmasi belum ada sesi - pengguna harus
 *  masuk dengan email dan kata sandinya. */
async function handleRegistrationCheck(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { body = {}; }
    const project = (body && body.project) || 'taxio_hub';
    const p = PROJECTS[project] && state.getPending(project);
    if (!p) return sendJson(res, 400, { error: 'Tidak ada pendaftaran yang sedang menunggu.' });
    if (!p.client || !p.user) return sendJson(res, 409, { error: 'Konfirmasi email dulu, lalu masuk dengan email dan kata sandi Anda.', needsLogin: true });
    try {
        await sessionStore.refreshIfNeeded(p.client);
        const reg = await connection.attach(project, { client: p.client, project: p.project, session: p.session, user: p.user });
        if (reg.status === 'active') log('Akun ' + p.email + ' sudah aktif di grup. Selamat datang.');
        return sendJson(res, 200, sessionSummary());
    } catch (e) {
        return sendJson(res, 400, { error: e.message });
    }
}

/** Layar "Satu langkah lagi": mengajukan ulang inisial (mis. konfirmasi email dibuka di
 *  perangkat lain sehingga inisial yang tersimpan tidak ada). */
async function handleRegistrationInitial(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const project = (body && body.project) || 'taxio_hub';
    const p = PROJECTS[project] && state.getPending(project);
    if (!p || !p.client) return sendJson(res, 400, { error: 'Masuk dulu dengan email dan kata sandi Anda.' });
    try {
        const r = await registration.submitInitial(p.client, p.email, body && body.initial);
        state.setPending(project, Object.assign({}, p, { status: r.status, initial: r.initial }));
        log('Inisial ' + r.initial + ' diajukan untuk ' + p.email + '. Menunggu admin.');
        return sendJson(res, 200, sessionSummary());
    } catch (e) {
        return sendJson(res, 400, { error: e.message });
    }
}

async function handleDisconnect(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { body = {}; }
    const projectId = body && body.project;
    if (!PROJECTS[projectId]) return sendJson(res, 400, { error: 'Project tidak dikenal.' });
    // Juga untuk akun yang masih menunggu grup: keluar berarti sesinya ikut dihapus.
    const conn = state.get(projectId) || state.getPending(projectId);
    if (conn && conn.client) await sessionStore.disconnect(conn.client);
    state.clear(projectId);
    state.clearPending(projectId);
    log('Terputus dari ' + PROJECTS[projectId].label + '.');
    return sendJson(res, 200, sessionSummary());
}

async function handleEntities(req, res, mode) {
    const connectedIds = state.connectedProjectIds();
    if (!connectedIds.length) return sendJson(res, 401, { error: 'Belum terhubung ke akun manapun.' });
    const all = [];
    const errors = [];
    for (const projectId of connectedIds) {
        const s = state.get(projectId);
        try {
            await sessionStore.refreshIfNeeded(s.client);
            const hasOwnerColumn = !!PROJECTS_WITH_OWNER_COLUMN[projectId];
            const list = await entitiesLib.listAutomatableEntities(s.client, s.orgId, s.user.id, hasOwnerColumn, mode);
            list.forEach((e) => { e.project = projectId; e.project_label = PROJECTS[projectId].label; });
            all.push(...list);
        } catch (e) {
            // Sejak penguncian kredensial Taxio Hub (2026-10-21) coretax_pics hanya bisa dibaca saat login;
            // permintaan tanpa sesi yang sah (token gagal diperbarui) ditolak dengan 42501.
            const expired = e.code === '42501' || /permission denied/i.test(e.message || '');
            errors.push(PROJECTS[projectId].label + ': ' + (expired ? 'sesi login sudah kedaluwarsa - putuskan lalu hubungkan ulang akun ini.' : e.message));
        }
    }
    // Satu baris per entitas: entitas dengan 2 PIC memilih PIC di dalam barisnya (sebelumnya
    // tampil dua kali), dan yang belum punya PIC tertaut ditandai linked=false supaya dashboard
    // bisa menyembunyikannya dari daftar awal tapi tetap menampilkannya saat dicari.
    const grouped = entitiesLib.groupEntityRows(all);
    // Entitas yang ditambahkan sendiri hanya ada di "Saya", dan tidak untuk Restricted Editor
    // karena mereka dilarang memakai login manual maupun entitas lokal.
    const locals = mode === 'personal' && !anyRestricted() ? localEntities.listEntitiesFor(currentUserId()) : [];
    return sendJson(res, 200, { entities: grouped.concat(locals), errors });
}

// ---- Entitas lokal (tab "Saya") - kredensial Coretax asli disimpan di komputer ini saja
// (lib/local-entities.js), login OTOMATIS lewat jalur yang sama persis dengan PIC Taxio Hub
// (lib/local-auth-client.js menyamar sebagai klien Supabase di depan lib/entities.js). ----
function guardLocalEntities(res) {
    if (!state.connectedProjectIds().length) { sendJson(res, 401, { error: 'Belum terhubung ke akun manapun.' }); return false; }
    if (rejectIfRestricted(res, 'Restricted Editor tidak diizinkan memakai entitas lokal.')) return false;
    return true;
}

async function handleLocalEntities(req, res) {
    if (!guardLocalEntities(res)) return;
    return sendJson(res, 200, { entities: localEntities.listEntitiesFor(currentUserId()) });
}

async function handleLocalEntitySave(req, res) {
    if (!guardLocalEntities(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const uid = currentUserId();
    try {
        const rec = body && body.id ? localEntities.update(uid, body.id, body) : localEntities.create(uid, body);
        log((body && body.id ? 'Entitas lokal diperbarui: ' : 'Entitas lokal ditambahkan: ') + rec.name);
        return sendJson(res, 200, { entity: localEntities.toEntity(rec) });
    } catch (e) {
        return sendJson(res, 400, { error: e.message });
    }
}

async function handleLocalEntityDelete(req, res) {
    if (!guardLocalEntities(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    try {
        localEntities.remove(currentUserId(), body && body.id);
        return sendJson(res, 200, { ok: true });
    } catch (e) {
        return sendJson(res, 400, { error: e.message });
    }
}

/** Kode Billing PPh 25 dari dashboard. Sebelumnya hanya bisa dipicu lewat deep link dari Taxio
 *  Hub; sekarang juga langsung dari aplikasi, dengan login otomatis (PIC tertaut, atau entitas
 *  lokal berkredensial) maupun sesi manual polos. Pemeriksaan "sudah dibayar" dan "kode aktif
 *  ganda" ada di runBillingPph25. */
const handleBillingPph25 = action({}, async (req, res, body) => {
    const { entity, masaInput, nominal, saveRoot } = body;
    const mmYY = String(masaInput || '').trim();
    if (!/^(0[1-9]|1[0-2])\d{2}$/.test(mmYY)) return sendJson(res, 400, { error: 'Masa harus berformat MMYY, misalnya 0726.' });
    const amount = Number(String(nominal || '').replace(/[^\d]/g, ''));
    if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Nominal PPh 25 wajib diisi.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    const runOpts = runOptsFor(src, { masaInput: mmYY, nominal: amount, saveRoot });
    return runInBackground(res, { label: 'PPh 25 Kode Billing · ' + mmYY + ' · ' + src.label, session: sessionOf(src) },
        () => runBillingPph25(runOpts), { failPrefix: 'Gagal membuat Kode Billing PPh 25: ' });
});

async function handleManualStatus(req, res) {
    try { return sendJson(res, 200, await chrome.getManualStatus()); }
    catch (e) { return sendJson(res, 200, { open: false, loggedIn: false, identity: '' }); }
}

/** Tombol "segarkan status" di topbar - baca ulang langsung dari jendela Chrome yang sedang
 *  terbuka untuk PIC ini (kalau ada), bukan menebak dari histori login-status.js yang bisa basi
 *  begitu pengguna berpindah entitas. Tidak membuka jendela apa pun sendiri. */
async function handleSessionStatus(req, res) {
    let body; try { body = await readJsonBody(req); } catch (e) { body = {}; }
    const picId = body && body.picId;
    if (!picId || picId === 'unlinked') return sendJson(res, 200, { open: false, loggedIn: false, identity: '' });
    try { return sendJson(res, 200, await chrome.getEntityStatus(picId)); }
    catch (e) { return sendJson(res, 200, { open: false, loggedIn: false, identity: '' }); }
}

/** Daftar semua jendela Chrome yang proses ini punya sekarang (bisa lebih dari satu PIC
 *  sekaligus, plus sesi manual) - untuk panel "Sesi aktif" di Pengaturan. */
async function handleSessionsList(req, res) {
    try { return sendJson(res, 200, { sessions: await chrome.listLiveSessions() }); }
    catch (e) { return sendJson(res, 200, { sessions: [] }); }
}
async function handleSessionFront(req, res) {
    let body; try { body = await readJsonBody(req); } catch (e) { body = {}; }
    if (!body || !body.picId) return sendJson(res, 400, { error: 'picId wajib diisi.' });
    try { return sendJson(res, 200, { ok: await chrome.bringSessionToFront(body.picId) }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
}
async function handleSessionClose(req, res) {
    let body; try { body = await readJsonBody(req); } catch (e) { body = {}; }
    if (!body || !body.picId) return sendJson(res, 400, { error: 'picId wajib diisi.' });
    try { return sendJson(res, 200, { ok: await chrome.closeLiveSession(body.picId) }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
}

function sanitizeFolder(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'Manual'; }

function currentUserId() {
    const id = state.connectedProjectIds()[0];
    return id ? state.get(id).user.id : null;
}

/** Menyiapkan proses di sesi Coretax manual POLOS - pengguna membuka Chrome sendiri lewat
 *  "Buka Coretax" dan login dengan tangannya sendiri, tanpa kredensial tersimpan apa pun. Ini
 *  jalur yang sudah ada sejak awal aplikasi; TETAP ADA berdampingan dengan entitas lokal
 *  berkredensial (yang sekarang login otomatis, lihat resolveEntitySource). Mengembalikan
 *  { manualPage, runEntity }, atau null setelah membalas galat. */
async function prepareManual(res) {
    if (rejectIfRestricted(res, 'Restricted Editor tidak diizinkan memakai login manual.')) return null;
    const manualPage = chrome.getManualPage();
    if (!manualPage) {
        sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Buka Coretax", login dulu, lalu coba lagi.' });
        return null;
    }
    return { manualPage, ...await manualIdentity() };
}

/** The taxpayer active in the manual window (as the dashboard shows it, "NPWP · NAMA"), so a manual
 *  run's log tag, result folder and file names carry that entity instead of "Manual" (user request
 *  2026-10-20). Read at the start of the run; "Manual" when nothing can be read yet. */
async function manualIdentity() {
    const identity = String((await chrome.getManualStatus().catch(() => null) || {}).identity || '');
    const npwp = (identity.match(/\d{15,16}/) || [''])[0];
    const name = identity.replace(/\d{15,16}/g, '').replace(/^[\s·|-]+|[\s·|-]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!name) return { runEntity: { entity_id: 'Manual', entity_name: 'Sesi Manual', npwp, individual: false }, label: 'Sesi Manual', tag: 'Manual' };
    // Tag: the name without its legal form ("PT", ", PT", "CV", "Tbk"), short enough for a log prefix.
    const tag = name.replace(/^(PT|CV|UD|PD|YAYASAN)\.?\s+/i, '').replace(/[,\s]+(PT|CV|TBK|PERSERO|\(PERSERO\))\.?$/i, '').trim().slice(0, 16) || name.slice(0, 16);
    return { runEntity: { entity_id: sanitizeFolder(name), entity_name: name, npwp, individual: false }, label: name, tag };
}

/** SATU tempat yang menentukan bagaimana sebuah entitas terpilih dijalankan, dipakai semua
 *  handler unduhan/impor di bawah - menghindari cabang manual/otomatis diduplikasi empat kali.
 *  Tiga sumber:
 *   - 'manual' (project==='manual'): sesi Coretax polos, pengguna login sendiri di jendela yang
 *     dibuka lewat "Buka Coretax". TIDAK mengenal PIC atau kredensial.
 *   - 'local' (project==='local'): entitas dari tab Saya, kredensial Coretax asli tersimpan di
 *     komputer ini (lib/local-entities.js) - login OTOMATIS lewat lib/local-auth-client.js, yang
 *     membuatnya terlihat identik dengan Taxio Hub bagi lib/entities.js dan seluruh automation/*.
 *   - lainnya (project===id Taxio Hub): PIC tertaut, login otomatis seperti sebelumnya.
 *  Mengembalikan null setelah membalas galat; kalau tidak, salah satu dari:
 *   { kind:'manual', manualPage, runEntity, label }
 *   { kind:'auto', client, orgId, picId, entity, restricted, allowedEbupotSections, passphrase,
 *     fallbackPicIds, label } */
async function resolveEntitySource(res, entity) {
    if (entity.project === 'manual') {
        const m = await prepareManual(res);
        if (!m) return null;
        return { kind: 'manual', manualPage: m.manualPage, runEntity: m.runEntity, label: m.label, tag: m.tag };
    }
    if (entity.project === 'local') {
        if (rejectIfRestricted(res, 'Restricted Editor tidak diizinkan memakai entitas lokal.')) return null;
        const uid = currentUserId();
        if (!entity.local_id || !entity.pic_id) { sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' }); return null; }
        const resolved = uid ? localEntities.resolveLogin(uid, entity.local_id, entity.pic_id) : null;
        if (!resolved) { sendJson(res, 404, { error: 'Entitas lokal tidak ditemukan atau kredensialnya belum lengkap. Buka lagi dialog entitas ini di tab Saya.' }); return null; }
        const picId = localAuth.buildPicId(entity.local_id, entity.pic_id);
        const fallbackPicIds = resolved.entity.individual ? [] : localEntities.otherPicRefs(uid, entity.local_id, entity.pic_id).map((r) => localAuth.buildPicId(entity.local_id, r));
        return {
            kind: 'auto', client: localAuth.client(uid), orgId: localAuth.ORG_ID, picId,
            entity: resolved.entity, restricted: false, allowedEbupotSections: null,
            passphrase: resolved.passphrase, fallbackPicIds, label: resolved.entity.entity_name
        };
    }
    if (!entity.entity_id || !entity.pic_id) { sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' }); return null; }
    const s = state.get(entity.project);
    if (!s || !state.isConnected(entity.project)) { sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' }); return null; }
    await sessionStore.refreshIfNeeded(s.client);
    const restricted = isProjectRestricted(entity.project);
    if (isIndividualEntityBlocked(restricted, entity)) { sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengakses akun Individual.' }); return null; }
    const allowedEbupotSections = (s.membership && s.membership.allowed_ebupot_sections) || null;
    const linkedOthers = await entitiesLib.getOtherLinkedPicIds(s.client, s.orgId, entity.entity_id, entity.pic_id).catch(() => []);
    const authorized = await entitiesLib.resolveAuthorizedPic(s.client, s.orgId, entity.pic_id, linkedOthers);
    // A session that failed to refresh makes every PIC read anonymous, which Taxio Hub refuses the
    // same way it refuses a PIC you may not use (Louis Fernando, editor, 2026-11-04) - say which.
    if (authorized.denied && !(await s.client.auth.getUser().then(({ data, error }) => !error && data && data.user).catch(() => false))) {
        sendJson(res, 401, { error: (PROJECTS[entity.project] || {}).label + ': sesi login sudah kedaluwarsa - putuskan lalu hubungkan ulang akun ini.' }); return null;
    }
    if (authorized.denied) { sendJson(res, 403, { error: 'Anda tidak berwenang memakai PIC yang dipilih untuk entitas ini di Taxio Hub. Pilih PIC lain di palet entitas, atau minta admin memberi akses.' }); return null; }
    const passphrase = authorized.passphrase;
    const fallbackPicIds = authorized.fallbackPicIds;
    return {
        kind: 'auto', client: s.client, orgId: s.orgId, picId: authorized.picId,
        entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual, taxserver_folder: entity.taxserver_folder || '' },
        restricted, allowedEbupotSections, passphrase, fallbackPicIds, label: entity.entity_name
    };
}

/** Kunci sesi + label log sebuah proses (lib/runcontrol.js): satu proses per jendela Chrome PIC
 *  (atau sesi manual), sesi berbeda boleh berjalan bersamaan. Kuncinya sama dengan picId di
 *  /api/sessions/list, jadi tab sesi di dashboard bisa mencocokkan prosesnya. */
const MANUAL_SESSION = { key: 'manual', tag: 'Manual' };
function sessionOf(src) {
    if (!src || src.kind === 'manual') return src && src.tag ? { ...MANUAL_SESSION, tag: src.tag } : MANUAL_SESSION;
    const id = String((src.entity && src.entity.entity_id) || '');
    // Entitas lokal ber-id internal ("local:<uuid>"): labelnya pakai kata pertama namanya.
    const tag = id.startsWith('local:') ? String((src.entity && src.entity.entity_name) || 'Lokal').split(/[\s,]+/)[0] : id;
    return { key: src.picId, tag: tag.slice(0, 16) };
}

/** Untuk fitur yang bekerja pada satu `page` (Pajak Masukan): membuka halaman Coretax untuk
 *  entitas ini lewat resolveEntitySource, lalu login otomatis (jika bukan sesi manual).
 *  Mengembalikan { label, folder, open() }, atau null setelah membalas galat. `open()` dipanggil
 *  SETELAH proses terdaftar di runcontrol, karena login otomatis bisa berlangsung lama. */
async function prepareEntityPage(res, entity) {
    const src = await resolveEntitySource(res, entity);
    if (!src) return null;
    if (src.kind === 'manual') {
        return {
            label: src.label, folder: src.runEntity.entity_id, session: sessionOf(src),
            open: async () => {
                if (chrome.isLoggedOut(src.manualPage)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
                return src.manualPage;
            }
        };
    }
    return {
        label: src.label, folder: require('../lib/entity-folder').folderCode(src.entity), session: sessionOf(src), picId: src.picId, entityId: src.entity.entity_id, npwp: src.entity.npwp,
        // Penandatangan e-Bupot (lib/coretax-issue.js): NIK login PIC + passphrase yang tersimpan, sumber yang sama dengan login.
        signer: async () => { const cred = await entitiesLib.getCredential(src.client, src.orgId, src.picId); return { nik: cred && cred.username, passphrase: src.passphrase || null }; },
        open: () => runLoginOnly({
            client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId,
            restricted: src.restricted, passphrase: src.passphrase, allowedEbupotSections: src.allowedEbupotSections
        })
    };
}

const handleDownloadEbupot = action({}, async (req, res, body) => {
    const { entity, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode } = body;
    const documentStatus = body.documentStatus ? body.documentStatus : 'issued';
    if (!bupotType || !masaInput) return sendJson(res, 400, { error: 'Jenis bupot & masa wajib diisi.' });
    if (!['issued', 'not_issued'].includes(documentStatus)) return sendJson(res, 400, { error: 'Status dokumen e-Bupot tidak valid.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    if (src.kind === 'auto' && src.restricted && !isEbupotTypeAllowed(src.allowedEbupotSections, bupotType)) {
        return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengunduh jenis e-Bupot ini.' });
    }
    const runOpts = runOptsFor(src, { bupotType, documentStatus, masaInput, kodeInput, saveRoot, pageSize, outputMode });
    // One automation run per session (Chrome window): two runs in the same window would fight
    // over it, but different sessions run side by side (lib/runcontrol.js).
    return runInBackground(res, { label: 'e-Bupot ' + bupotType.toUpperCase() + ' · ' + (documentStatus === 'not_issued' ? 'Belum Terbit' : 'Telah Terbit') + ' · ' + src.label, session: sessionOf(src) },
        () => runEbupotDownload(runOpts), { failPrefix: 'Gagal download e-Bupot: ' });
});

const handleDownloadMyBupot = action({}, async (req, res, body) => {
    let { buktiTypeKeys } = body;
    const { entity, masaInput, saveRoot, pageSize, outputMode } = body;
    if (!Array.isArray(buktiTypeKeys) || !buktiTypeKeys.length || !masaInput) return sendJson(res, 400, { error: 'Jenis bukti potong & masa wajib diisi.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    if (src.kind === 'auto' && src.restricted) {
        if (!isMyBupotAllowed(src.allowedEbupotSections)) {
            return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengakses Bukti Potong Saya.' });
        }
        // Filters the blocked types OUT and proceeds with whatever's left, rather than
        // rejecting the whole (multi-select) request - CONFIRMED LIVE 2026-08-13: a restricted
        // editor selecting BP21 together with BPMP/BPA1 in one batch had the entire request
        // (including the legitimately-allowed BP21) rejected outright, since the original
        // all-or-nothing check only asked "does this selection contain a blocked type at all".
        const filtered = buktiTypeKeys.filter((k) => !ABSOLUTELY_BLOCKED_MYBUPOT_TYPES.includes(k));
        if (filtered.length !== buktiTypeKeys.length) {
            log('Restricted Editor: BPMP/BPA1 di Bukti Potong Saya dilewati (tidak diizinkan).');
        }
        buktiTypeKeys = filtered;
        if (!buktiTypeKeys.length) {
            return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengunduh jenis Bukti Potong Saya yang dipilih.' });
        }
    }
    const runOpts = runOptsFor(src, { buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode });
    return runInBackground(res, { label: 'My Bukti Potong · ' + src.label, session: sessionOf(src) },
        () => runMyBuktiPotongDownload(runOpts), { failPrefix: 'Gagal download Bukti Potong Saya: ' });
});

// Entitas dicek SESUDAH blokir PPh 21 / Mode A1 untuk Restricted (urutan lama dipertahankan).
const handleDownloadSpt = action({ entity: false }, async (req, res, body) => {
    if ((body.a1Year !== undefined || (Array.isArray(body.jenisPajakKeys) && body.jenisPajakKeys.includes('pph21')))
        && rejectIfRestricted(res, 'Seluruh unduhan SPT PPh 21 diblokir untuk pengguna Restricted.')) return;
    if (body.a1Year !== undefined) {
        // Use trusted session roles, never a role supplied in the request body.
        // Check every active connection so selecting a manual/other project cannot bypass this.
        if (rejectIfRestricted(res, 'Mode A1 tidak tersedia untuk pengguna Restricted.')) return;
        if (!/^20\d{2}$/.test(String(body.a1Year)) || Number(body.a1Year) < 2025) return sendJson(res, 400, { error: 'Tahun Mode A1 harus mulai 2025.' });
        const yy = String(body.a1Year).slice(2);
        body = { ...body, jenisPajakKeys: ['pph21'], masaInput: '01' + yy + '-12' + yy, includeLampiran: true, includeBpe: true, includeInduk: true, lampiranMode: 'full', lampiranFormat: 'pdf', outputLayout: 'combined', checkPph25: false };
    }
    const { entity, jenisPajakKeys, masaInput, saveRoot, checkPph25, includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout, layoutStyle } = body;
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!Array.isArray(jenisPajakKeys) || !jenisPajakKeys.length || !masaInput) return sendJson(res, 400, { error: 'Jenis pajak & masa wajib diisi.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    // SPT entitas Taxio Hub yang terunduh dari dashboard ikut menandai compliance di Hub, sama
    // seperti klik Download di Hub (lib/deeplink.js). Mode A1 = rekap, bukan pelaporan: tidak.
    const hub = entity.project === 'taxio_hub' && src.kind !== 'manual' && body.a1Year === undefined ? state.get(entity.project) : null;
    const markHub = (jenisKey, mmYY, ok) => {
        if (!ok || !hub) return;
        compliance.markSptComplianceExisting(src.client, {
            org: src.orgId, entity: src.entity.entity_id, masa: mmYY,
            uid: hub.user && hub.user.id, uemail: hub.user && hub.user.email
        }, jenisKey);
    };
    // Entitas dengan >1 PIC (Taxio Hub tertaut, atau Badan lokal dengan beberapa PIC): SPT cuma
    // bisa digenerate sesuai penandatangan aslinya, jadi runSptDownload dikasih tahu PIC lain
    // yang bisa dicoba otomatis bila baris di bawah PIC terpilih gagal.
    const common = { jenisPajakKeys, masaInput, saveRoot, checkPph25, includeLampiran: !!includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout, layoutStyle };
    const runOpts = src.kind === 'manual'
        ? runOptsFor(src, Object.assign(common, { onRowDone: (jenisKey, mmYY, ok) => runcontrol.recordRowDone(jenisKey, ok) }))
        : runOptsFor(src, common, { fallbackPicIds: src.fallbackPicIds, onRowDone: (jenisKey, mmYY, ok) => { runcontrol.recordRowDone(jenisKey, ok); markHub(jenisKey, mmYY, ok); } });
    runOpts.a1Year = body.a1Year; runOpts.a1Fresh = !!body.a1Fresh; runOpts.a1Source = body.a1Source || undefined;
    return runInBackground(res, { label: 'SPT ' + jenisPajakKeys.join('+') + ' · ' + src.label, session: sessionOf(src), onStart: () => runcontrol.setJenisRequested(jenisPajakKeys) },
        () => runSptDownload(runOpts), { failPrefix: 'Gagal download SPT: ' });
});

/** Pajak Masukan - unduh Excel. Berjalan pada halaman Coretax milik entitas (login otomatis lewat
 *  PIC tertaut, sama seperti SPT) atau pada sesi login manual. Bukan tiruan tombol "Ekspor ke
 *  Excel" Coretax sendiri (terbukti murni client-side) - generate sendiri dari /inputinvoice/list. */
const handleDownloadPajakMasukan = action({}, async (req, res, body) => {
    const { entity, masaInput, saveRoot } = body;
    if (!masaInput) return sendJson(res, 400, { error: 'Masa wajib diisi.' });
    let masaList;
    try { masaList = masaLib.parseMasaListInput(masaInput); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'Download Pajak Masukan · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        await pajakMasukan.runDownloadExcel({ page, masaList, saveRoot, entityFolder: target.folder, emit: (m) => log(m) });
    }, { stopMsg: 'Download Pajak Masukan dihentikan oleh pengguna.', failPrefix: 'Gagal download Pajak Masukan: ' });
});

/** e-Faktur - unduh delapan jenis dokumen (Pajak Masukan/Keluaran, Retur, Dokumen Lain, Retur Dokumen Lain).
 *  Excel diambil langsung dari daftar Coretax; CSV resmi dibuat oleh Coretax sendiri (ekspor massal). */
const handleDownloadEfaktur = action({}, async (req, res, body) => {
    const { entity, masaInput, types, excel, csv, saveRoot } = body;
    if (!masaInput) return sendJson(res, 400, { error: 'Masa wajib diisi.' });
    const known = new Set(efaktur.DOC_TYPES.map((t) => t.key));
    const typeKeys = Array.isArray(types) ? [...new Set(types.map(String))] : [];
    if (!typeKeys.length || typeKeys.some((k) => !known.has(k))) return sendJson(res, 400, { error: 'Pilih minimal satu jenis dokumen yang valid.' });
    if (excel === false && !csv) return sendJson(res, 400, { error: 'Pilih minimal satu format (Excel atau CSV resmi).' });
    let masaList;
    try { masaList = masaLib.parseMasaListInput(masaInput); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'e-Faktur download · ' + typeKeys.length + ' type(s) · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        await efaktur.runDownloadEfaktur({ page, types: typeKeys, masaList, excel: excel !== false, csv: !!csv, saveRoot, entityFolder: target.folder, entityName: target.label, emit: (m) => log(m) });
    }, { stopMsg: 'Download e-Faktur dihentikan oleh pengguna.', failPrefix: 'Gagal download e-Faktur: ' });
});

/** Pajak Masukan - pengkreditan per baris Excel. Entitas+PIC (login otomatis) atau sesi manual. */
const handleImportPajakMasukan = action({ body: 'large' }, async (req, res, body) => {
    const { entity, fileBase64, targetMasaInput } = body;
    if (!fileBase64) return sendJson(res, 400, { error: 'File template belum dipilih.' });
    if (targetMasaInput && !/^(0[1-9]|1[0-2])\d{2}$/.test(String(targetMasaInput).trim())) {
        return sendJson(res, 400, { error: 'Masa Pengkreditan harus berformat MMYY, misalnya 0726.' });
    }
    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'Faktur Masukan crediting' + (targetMasaInput ? ' · period ' + String(targetMasaInput).trim() : '') + ' · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        await pajakMasukan.runImportFromExcel({ page, fileBuffer, targetMasaInput: targetMasaInput ? String(targetMasaInput).trim() : '', dryRun: false, emit: (m) => log(m) });
    }, { stopMsg: 'Impor Pajak Masukan dihentikan oleh pengguna.', failPrefix: 'Gagal impor Pajak Masukan: ' });
});

/** Halaman Coretax untuk Dividen. Tanpa entitas (atau sesi manual): jendela login manual seperti dulu.
 *  Entitas dengan kredensial tersimpan (Taxio Hub / lokal): jendela PIC-nya, login otomatis.
 *  `needCase`: impor/cek butuh kasus e-Reporting yang SUDAH terbuka di jendela itu, jadi halaman itu
 *  dipakai apa adanya (login ulang akan memindahkannya dari kasus). */
async function prepareDividenPage(res, entity, needCase) {
    if (!entity || !entity.project || entity.project === 'manual') {
        // Sesi manual: aturan yang sama dengan prepareManual (Restricted Editor tidak boleh login manual).
        if (rejectIfRestricted(res, 'Restricted Editor tidak diizinkan memakai login manual.')) return null;
        const manualPage = chrome.getManualPage();
        if (!manualPage) { sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Coretax" dan login dulu' + (needCase ? ', lalu buka kasus e-Reporting.' : '.') }); return null; }
        const who = await manualIdentity();
        return { label: who.label, session: { ...MANUAL_SESSION, tag: who.tag }, open: async () => manualPage };
    }
    const target = await prepareEntityPage(res, entity);
    if (!target) return null;
    if (!needCase) return target;
    return {
        ...target,
        open: async () => {
            const live = chrome.getLiveEntityPage(target.picId), who = loginStatus.get();
            const onCase = live && /(?:case-routing|case-overview|form-render)\/[0-9a-f-]{36}/i.test(live.url());
            if (!onCase || !who || who.picId !== target.picId || who.entityId !== target.entityId) {
                throw new Error('Belum ada kasus e-Reporting yang terbuka untuk ' + target.label + ' - klik "Buat Kasus Baru" dulu, atau buka kasusnya (Alur Kasus) di jendela Coretax entitas ini.');
            }
            return live;
        }
    };
}

/** Mode A1 "Hasil sebelumnya": status per masa dari folder / Excel Mode A1 lama (lib/a1-source.js), sebelum
 *  proses dimulai - mana yang datanya sudah ada (Excel lama / cache) dan apakah PDF-nya ada. Hanya membaca disk. */
const handleA1Inspect = action({ outdated: false, entity: false }, async (req, res, body) => {
    const { entity, year, source, saveRoot } = body;
    if (!entity || !entity.entity_id) return sendJson(res, 400, { error: 'Pilih entitas dulu.' });
    if (!/^20\d{2}$/.test(String(year))) return sendJson(res, 400, { error: 'Tahun tidak valid.' });
    try {
        const p = require('../lib/a1-paths').a1Paths({ entity, saveRoot, year: String(year) });
        const out = await require('../lib/a1-source').inspect({ a1Dir: p.readDirs, source: source || undefined, year: String(year), sptDir: p.sptDir, pdfDir: p.taxServer ? [p.pdfDir, p.outDir] : undefined });
        if (out && out.excel) require('../lib/a1-autorefresh').watch(out.excel);
        return sendJson(res, 200, { ...out, a1Dir: p.outDir, taxServer: p.taxServer });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
});

/** XML impor BPA1 dari sheet Draft SPT Desember rekap (lib/a1-desember.js). Hanya membuat file, di folder pilihan (outDir)
 *  atau di sebelah rekap: "<kode> <tahun> - BPA1 Desember (impor).xml"; tidak membuka Coretax. */
const handleBpa1Xml = action({ outdated: false, entity: false }, async (req, res, body) => {
    const { filePath, year, outDir } = body;
    if (!filePath || !/\.xlsx$/i.test(filePath)) return sendJson(res, 400, { error: 'Pilih Excel rekap (.xlsx) dulu.' });
    if (outDir && !fs.existsSync(outDir)) return sendJson(res, 400, { error: 'Folder tujuan tidak ditemukan: ' + outDir });
    if (!/^20\d{2}$/.test(String(year || ''))) return sendJson(res, 400, { error: 'Tahun pajak tidak valid.' });
    try {
        const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(filePath);
        const out = require('../lib/a1-desember').buildXml(wb, { year: String(year) });
        const base = path.basename(filePath).replace(/ - Rekap SPT PPh 21 Setahun \(A1\).*\.xlsx$/i, '').replace(/\.xlsx$/i, '');
        const target = path.join(outDir || path.dirname(filePath), base + ' - BPA1 Desember (impor).xml');
        fs.writeFileSync(target, out.xml, 'utf8');
        const money = require('../lib/id-number').money;
        log('XML BPA1 Desember: ' + out.count + ' bukti potong -> ' + target);
        return sendJson(res, 200, { file: target, count: out.count, skipped: out.skipped, totalTax: money(out.totalTax), totalDes: (out.totalDes < 0 ? '-' : '') + money(Math.abs(out.totalDes)) });
    } catch (e) {
        return sendJson(res, 400, { error: e.code === 'ENOENT' ? 'Excel rekap tidak ditemukan: ' + filePath : e.code === 'EBUSY' ? 'Excel rekap sedang dibuka - tutup dulu.' : e.message });
    }
});

/** Pembetulan NIK BPMP (bagian halaman Mode A1): isian NIK Baru / Nama Baru Excel Mode A1 -> Coretax lewat API
 *  (automation/bpmp-amend.js). submit=false hanya menguji; submit=true mengirim lalu memeriksa ulang. */
const handleBpmpAmend = action({ body: 'large', restricted: 'Pembetulan NIK BPMP tidak tersedia untuk pengguna Restricted.' }, async (req, res, body) => {
    const { entity, fileBase64, filePath, year, submit, saveRoot, sweepOnly, allowSimilar, confirmCancel } = body;
    const amend = require('../automation/bpmp-amend');
    if (sweepOnly) return handleBpmpSweep(res, amend, entity, String(year || ''), saveRoot);
    if (!fileBase64 && !filePath) return sendJson(res, 400, { error: 'Excel rekap belum dipilih.' });
    let parsed;
    // filePath: "Pakai rekap terakhir" (Excel hasil tab Unduh setahun di folder A1 entitas ini).
    try { parsed = await amend.readTargets(fileBase64 ? Buffer.from(fileBase64, 'base64') : (/\.xlsx$/i.test(String(filePath)) ? fs.readFileSync(filePath) : (() => { throw new Error('File harus .xlsx'); })())); }
    catch (e) { return sendJson(res, 400, { error: e.code === 'ENOENT' ? 'Excel rekap tidak ditemukan: ' + filePath : e.message }); }
    const taxYear = String(year || parsed.year || '');
    if (!/^20\d{2}$/.test(taxYear)) return sendJson(res, 400, { error: 'Tahun pajak tidak terbaca dari Excel - pilih tahunnya.' });
    if (filePath) require('../lib/a1-autorefresh').watch(filePath);
    if (!parsed.targets.length && !parsed.cancels.length) return sendJson(res, 400, { error: 'Belum ada NIK Baru yang terisi di sheet NIK atau per bukti potong di sheet Pembetulan, dan tidak ada Tindakan = Batalkan.' + (parsed.skipped.length ? ' ' + parsed.skipped[0] : '') });
    // Pembatalan hanya untuk nomor yang dikonfirmasi pengguna (dialog daftar bukti potong di GUI, dari /api/bpmp-amend/preview).
    const confirmed = Array.isArray(confirmCancel) ? confirmCancel.map(String) : [];

    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    // Galat ditangani di dalam (penyisiran dan laporan tetap berjalan sesudah berhenti di tengah).
    return runInBackground(res, { label: 'BPMP NIK correction' + (submit ? '' : ' (test)') + ' · ' + target.label, session: target.session }, async () => {
        let page = null, outDir = null, npwp = null, results = [], checks = null, sweepRes = null, cancelled = [];
        try {
            parsed.skipped.forEach((s) => log('LEWATI ' + s));
            const done = [...parsed.previous.keys()].filter((old) => parsed.previous.get(old).some((p) => /^DIBETULKAN/.test(p.status)));
            if (done.length) log('Riwayat di sheet Pembetulan: ' + done.length + ' NIK pernah dibetulkan - yang masih tersisa di Coretax saja yang diproses.');
            log('Pembetulan NIK BPMP ' + taxYear + ': ' + parsed.targets.length + ' NIK Baru di Excel · mode ' + (submit ? 'KIRIM ke Coretax' : 'UJI (tanpa simpan)') + '.');
            page = await target.open();
            outDir = path.join(saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), target.folder, 'Pembetulan NIK BPMP', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
            npwp = entity.project === 'manual' ? null : entity.npwp;
            if (parsed.targets.length) results = await amend.run({ context: page.context(), npwp, targets: parsed.targets, year: taxYear, submit: !!submit, outDir, allowSimilar: !!allowSimilar, previous: parsed.previous, exclude: parsed.exclude, emit: (m) => log(m) });
            if (parsed.cancels.length) {
                if (!submit) for (const c of parsed.cancels) log('AKAN DIBATALKAN ' + c.number + ' masa ' + c.masa + ' · ' + c.nik + ' ' + c.name + ' (Tindakan = Batalkan; dibatalkan saat Kirim, sesudah dikonfirmasi).');
                else {
                    cancelled = await amend.cancelSlips({ context: page.context(), npwp, year: taxYear, cancels: parsed.cancels, confirmed, emit: (m) => log(m) });
                    log('Pembatalan: ' + cancelled.filter((x) => x.ok).length + ' dibatalkan' + (cancelled.some((x) => !x.ok) ? ', ' + cancelled.filter((x) => !x.ok).length + ' gagal (batalkan manual)' : '') + '.');
                }
            }
            const count = (re) => results.filter((r) => re.test(r.status)).length;
            log('Selesai: ' + results.length + ' bukti potong · ' + (submit ? count(/^DIBETULKAN/) + ' dibetulkan' : count(/^SIAP/) + ' siap dikirim') + ', ' + count(/^NAMA MIRIP/) + ' nama mirip, ' + count(/^BEDA/) + ' beda nama (tidak dikirim). Cadangan + hasil di ' + outDir);
            if (submit && count(/^DIBETULKAN/)) {
                const { ok, bad, details } = await amend.check({ context: page.context(), npwp, dirs: [outDir], emit: (m) => log(m) });
                checks = details;
                log('Pemeriksaan ulang: ' + ok + ' benar, ' + bad + ' bermasalah.');
                const periods = [...new Set(results.filter((r) => /^DIBETULKAN/.test(r.status)).map((r) => r.period.slice(0, 2)))].sort();
                log('Langkah berikutnya: buat pembetulan SPT Masa PPh 21 masa ' + periods.join(', ') + '/' + taxYear + '.');
            }
        } catch (e) {
            if (e && e.results) results = e.results;
            if (e && e.isStop) { log('Pembetulan NIK BPMP dihentikan oleh pengguna.'); page = null; }
            else log('Pembetulan NIK BPMP berhenti: ' + e.message);
        }
        // Juga setelah berhenti di tengah: penyisiran menunjukkan apa yang masih tersisa.
        try { if (submit && page) sweepRes = await amend.sweep({ context: page.context(), npwp, year: taxYear, outDir, emit: (m) => log(m) }); }
        catch (e) { log('Penyisiran NIK gagal: ' + e.message); }
        // Laporan + riwayat ke Excel rekap yang sama (fileBase64 tanpa path: ke file baru di folder hasil).
        try {
            if (submit && (results.length || sweepRes || cancelled.length)) {
                const out = await require('../lib/bpmp-report').writeReport({ file: filePath && /\.xlsx$/i.test(filePath) ? filePath : null,
                    newFile: path.join(outDir || os.tmpdir(), 'Hasil Pembetulan NIK BPMP ' + taxYear + '.xlsx'), year: taxYear, results, checks, sweep: sweepRes, cancelled });
                require('../lib/a1-autorefresh').own(out.file);
                log('Laporan ditulis ke ' + out.file + ' (sheet Pembetulan dan Ringkasan).' + (out.locked ? ' Excel rekap sedang terbuka, jadi disimpan sebagai file terpisah - tutup Excel lalu salin sheet-nya, atau pilih file ini di proses berikutnya.' : ''));
            }
        } catch (e) { log('Laporan ke Excel gagal: ' + e.message); }
    });
});

/** Pratinjau isian Pembetulan tanpa membuka Coretax: banyaknya NIK Baru (sheet NIK / per bukti potong) dan daftar bukti potong
 *  bertindakan Batalkan - GUI menampilkannya untuk dikonfirmasi sebelum Kirim. */
const handleBpmpAmendPreview = action({ outdated: false, body: 'large', entity: false }, async (req, res, body) => {
    const { fileBase64, filePath } = body;
    try {
        const p = await require('../automation/bpmp-amend').readTargets(fileBase64 ? Buffer.from(fileBase64, 'base64') : fs.readFileSync(filePath));
        return sendJson(res, 200, { byNik: p.targets.filter((t) => !t.number).length, perSlip: p.targets.filter((t) => t.number).length, cancels: p.cancels, skipped: p.skipped, year: p.year });
    } catch (e) { return sendJson(res, 400, { error: e.code === 'ENOENT' ? 'Excel rekap tidak ditemukan: ' + filePath : e.message }); }
});
/** Perbarui rekap: susun ulang Excel rekap di tempat (lib/a1-import.js convertA1Workbook) tanpa membuka Coretax - sheet NIK dan
 *  Draft SPT Desember mengikuti isian terbaru (mis. NIK salah per bukti potong mendapat barisnya sendiri), isian ikut. */
const handleA1Refresh = action({ body: 'large', entity: false }, async (req, res, body) => {
    const file = String(body.filePath || '');
    if (!/\.xlsx$/i.test(file) || !fs.existsSync(file)) return sendJson(res, 400, { error: 'Pilih Excel rekap (.xlsx) yang ada di disk - "Use latest rekap" atau pilih file dari folder.' });
    try { fs.closeSync(fs.openSync(file, 'r+')); } catch (e) { return sendJson(res, 409, { error: 'Excel rekap sedang terbuka - tutup dulu di Excel, lalu klik Perbarui rekap lagi.' }); }
    // Di sesi entitas yang dipilih (kunci PIC + tag entitas, sama dengan sessionOf): log ber-tag [kode] dan tampil di
    // "This session"; Pembetulan ke Coretax di sesi yang sama menunggu sampai rekap selesai disusun.
    const ent = body.entity;
    const session = !ent ? undefined : ent.project === 'manual' ? { ...MANUAL_SESSION, tag: String(ent.entity_id || 'Manual').slice(0, 16) }
        : ent.pic_id ? { key: ent.pic_id, tag: String(String(ent.entity_id || '').startsWith('local:') ? String(ent.entity_name || 'Lokal').split(/[\s,]+/)[0] : ent.entity_id || '').slice(0, 16) } : undefined;
    return runInBackground(res, { label: 'Refresh rekap · ' + path.basename(file), session }, async () => {
        log('Perbarui rekap (tanpa Coretax): ' + file);
        const result = await require('../lib/a1-autorefresh').refreshInPlace(file, (m) => log(m));
        log('Selesai · bukti potong perlu pembetulan: ' + result.draftRows + '.');
    }, { stopMsg: 'Perbarui rekap dihentikan oleh pengguna.', failPrefix: 'Perbarui rekap gagal: ' });
});
/** Upload Format Impor Coretax (lib/coretax-import.js): baca file (Excel template impor DJP atau XML) dari base64 / path. */
async function readImportFile(body) {
    const { fileBase64, filePath, fileName } = body || {};
    if (!fileBase64 && !filePath) throw new Error('File impor belum dipilih.');
    const name = fileName || (filePath ? path.basename(filePath) : 'impor.xlsx');
    if (!/\.(xlsx|xml)$/i.test(name)) throw new Error('File harus .xlsx (template impor DJP) atau .xml.');
    const buf = fileBase64 ? Buffer.from(fileBase64, 'base64') : fs.readFileSync(filePath);
    return { buf, name };
}
/** Pratinjau: jenis, jumlah bukti potong, masa - tanpa membuka Coretax. */
const handleImportInspect = action({ outdated: false, body: 'large', entity: false }, async (req, res, body) => {
    try {
        const { buf, name } = await readImportFile(body);
        const npwp = body.entity && body.entity.project !== 'manual' ? body.entity.npwp : '';
        const p = await require('../lib/coretax-import').prepare(buf, name, npwp);
        const months = p.rows ? [...new Set(p.rows.map((r) => (r.TaxPeriodMonth || r.TaxPeriodMonthEnd || '') + '/' + (r.TaxPeriodYear || '')))] : [];
        return sendJson(res, 200, { type: p.type, label: p.label, count: p.count, tin: p.tin, source: p.source, sheet: p.sheet || null, periods: months, problems: p.problems });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
});
/** Unggah ke Belum Terbit e-Bupot entitas (tidak menerbitkan); hasil dari XML monitoring Coretax. */
const handleImportUpload = action({ body: 'large', restricted: 'Upload impor e-Bupot tidak tersedia untuk pengguna Restricted.' }, async (req, res, body) => {
    const { entity } = body;
    const imp = require('../lib/coretax-import');
    let prepared, name;
    try { const f = await readImportFile(body); name = f.name; prepared = await imp.prepare(f.buf, f.name, entity.project === 'manual' ? '' : entity.npwp); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (prepared.problems.length) return sendJson(res, 400, { error: 'Periksa file dulu: ' + prepared.problems.slice(0, 5).join('; ') + (prepared.problems.length > 5 ? ' (dan ' + (prepared.problems.length - 5) + ' lagi)' : '') });
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'Upload ' + prepared.label + ' to Belum Terbit · ' + target.label, session: target.session, extra: { type: prepared.type, count: prepared.count } }, async () => {
        const page = await target.open();
        const base = String(name).replace(/\.(xlsx|xml)$/i, '').replace(/[^\w .()-]/g, '').slice(0, 60) || prepared.label;
        const r = await imp.upload(page, prepared, { fileName: base + ' - Pilot ' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '.xml', emit: (m) => log(m) });
        if (r.ok) {
            log('SELESAI: ' + r.created + ' ' + prepared.label + ' dibuat di Belum Terbit (' + r.fileName + ').');
            // Hasil untuk diperiksa: isi Belum Terbit per masa di file + kode konfirmasi untuk Terbitkan (lib/coretax-issue.js).
            const periods = [...new Set((prepared.rows || []).map((x) => { const m = x.TaxPeriodMonth || x.TaxPeriodMonthEnd, y = x.TaxPeriodYear; return m && y ? String(m).padStart(2, '0') + String(y).slice(-2) : null; }).filter(Boolean))];
            for (const p of periods) {
                try {
                    const pv = await require('../lib/coretax-issue').preview(page, { type: prepared.type, period: p });
                    if (body.filePath) ebupotReportDirs.set(target.folder, path.dirname(body.filePath));
                    try { log('Laporan: ' + await writeEbupotPeriodReport(page, target, prepared.type, p, 'sesudah upload ' + pv.label + ' · kode konfirmasi issue ' + (pv.token || '-'))); }
                    catch (e) { log('Laporan Excel gagal ditulis: ' + e.message); }
                    log('Belum Terbit ' + pv.label + ' masa ' + pv.period + ': ' + pv.count + ' bukti potong, bruto ' + pv.totalGross.toLocaleString('id-ID') + ', PPh ' + pv.totalTax.toLocaleString('id-ID')
                        + ' · siap diterbitkan' + (pv.needsSign ? ' (tanda tangan passphrase PIC)' : '') + ', kode konfirmasi ' + pv.token + '.');
                } catch (e) { log('Ringkasan Belum Terbit masa ' + p + ' gagal: ' + e.message); }
            }
            log('Terbitkan: tab Terbitkan di menu ini, atau minta Claude "terbitkan ' + prepared.label + ' <masa>" - selalu dengan pratinjau dan konfirmasi.');
        }
        else {
            log('GAGAL: upload ' + prepared.label + ' - ' + r.status + (r.message && !r.errors.length ? ': ' + r.message : '') + '. Tidak ada bukti potong yang dibuat dari file ini.');
            for (const e of r.errors.slice(0, 30)) log('  baris ' + (e.Line ?? '?') + (e.FieldName ? ' · ' + e.FieldName : '') + ': ' + e.Message);
            if (r.errors.length > 30) log('  ... dan ' + (r.errors.length - 30) + ' kesalahan lain (lihat Monitoring > XML di Coretax).');
        }
    }, { stopMsg: 'Upload dihentikan oleh pengguna.', failPrefix: 'Upload ' + prepared.label + ' gagal: ' });
});
/** Buat Konsep SPT Masa (PPh 21/26 atau Unifikasi) - tanpa lapor / tanda tangan. */
const handleCreateKonsep = action({}, async (req, res, body) => {
    const { entity, taxType, period } = body;
    if (!['ICT_WIT', 'ICT_WT'].includes(taxType)) return sendJson(res, 400, { error: 'Jenis SPT: ICT_WIT (PPh 21/26) atau ICT_WT (Unifikasi).' });
    if (taxType === 'ICT_WIT' && rejectIfRestricted(res, 'Konsep SPT PPh 21 tidak tersedia untuk pengguna Restricted.')) return;
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'Create Konsep SPT ' + (taxType === 'ICT_WIT' ? 'PPh 21' : 'Unifikasi') + ' ' + period + ' · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        const r = await require('../lib/coretax-import').createKonsep(page, { taxType, period, emit: (m) => log(m) });
        log(r.ok ? 'SELESAI: Konsep SPT ' + r.returnSheetType + ' masa ' + r.period + ' (' + r.model + ') dibuat - buka Konsep SPT di Coretax untuk Posting, periksa, lalu lapor manual.'
            : 'GAGAL: Konsep SPT masa ' + r.period + ' tidak dibuat - ' + r.message);
    }, { stopMsg: 'Konsep SPT dihentikan oleh pengguna.', failPrefix: 'Konsep SPT gagal: ' });
});

/** Folder laporan e-Bupot per entitas: folder file impor terakhir, selain itu Downloads\CoretaxAgent\<kode>\e-Bupot. */
const ebupotReportDirs = new Map();
const ebupotReportDir = (target) => ebupotReportDirs.get(target.folder) || path.join(os.homedir(), 'Downloads', 'CoretaxAgent', target.folder || 'Manual', 'e-Bupot');
/** Laporan gabungan per entitas & masa (lib/coretax-report.js writePeriodReport): PPh 21 = BPMP + BP21 + BPA1 (satu SPT),
 *  Unifikasi = BPPU. Dibaca ulang dari Coretax, jadi selalu keadaan terbaru sesudah upload / issue & sign. */
async function writeEbupotPeriodReport(page, target, type, mmyy, note) {
    const unif = type === 'bpu', types = unif ? ['bpu'] : ['mp', 'bp21', 'bpa1'];
    const period = require('../lib/coretax-issue').periodCode(mmyy), code = period.slice(2, 4) + period.slice(6, 8);
    const snap = await require('../lib/coretax-issue').snapshot(page, types, period);
    const file = path.join(ebupotReportDir(target), (target.folder ? target.folder + ' ' : '') + code + ' - Bukti Potong ' + (unif ? 'Unifikasi' : 'PPh 21') + '.xlsx');
    return require('../lib/coretax-report').writePeriodReport(file, { entity: target.label, title: unif ? 'Bukti Potong Unifikasi (BPPU)' : 'Bukti Potong PPh 21 (BPMP, BP21, BPA1)', snap, note });
}
/** e-Bupot type code -> label (mp -> BPMP). */
const typeLabel = (t) => ((require('../lib/coretax-import').TYPES[t] || {}).label || String(t || '').toUpperCase());

const ISSUE_RESTRICTED = 'Terbitkan e-Bupot tidak tersedia untuk pengguna Restricted.';
/** Pratinjau terbitkan (lib/coretax-issue.js): daftar Belum Terbit + total + kode konfirmasi. Tidak mengubah apa pun. */
const handleIssuePreview = action({ restricted: ISSUE_RESTRICTED }, async (req, res, body) => {
    const { entity, type, period } = body;
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runForResult(res, { label: 'Issue preview ' + typeLabel(type) + ' ' + period + ' · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        const p = await require('../lib/coretax-issue').preview(page, { type, period });
        log('Pratinjau terbitkan ' + p.label + ' masa ' + p.period + ': ' + p.count + ' bukti potong Belum Terbit, bruto ' + p.totalGross.toLocaleString('id-ID') + ', PPh ' + p.totalTax.toLocaleString('id-ID')
            + (p.needsSign ? ' · perlu tanda tangan (passphrase PIC)' : ' · tanpa tanda tangan') + (p.token ? ' · kode konfirmasi ' + p.token : '') + (p.skipped.length ? ' · ' + p.skipped.length + ' dilewati' : '') + '.');
        const { rows, ...out } = p;
        return out;
    }, { failPrefix: 'Pratinjau terbitkan gagal: ' });
});
/** Terbitkan Belum Terbit satu jenis & masa - hanya dengan kode konfirmasi dari pratinjau (daftar harus belum berubah). */
const handleIssueEbupot = action({ restricted: ISSUE_RESTRICTED }, async (req, res, body) => {
    const { entity, type, period, token } = body;
    if (!token) return sendJson(res, 400, { error: 'Kode konfirmasi pratinjau wajib - jalankan pratinjau terbitkan dulu.' });
    const iss = require('../lib/coretax-issue');
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    if (iss.NEEDS_SIGN.has(type) && !target.signer) return sendJson(res, 400, { error: 'Jenis ini perlu tanda tangan; sesi manual tidak menyimpan passphrase PIC - pakai entitas dengan login otomatis.' });
    return runInBackground(res, { label: (iss.NEEDS_SIGN.has(type) ? 'Issue & sign ' : 'Issue ') + typeLabel(type) + ' ' + period + ' · ' + target.label, session: target.session }, async () => {
        const signer = iss.NEEDS_SIGN.has(type) ? await target.signer() : null;
        const page = await target.open();
        const r = await iss.issue(page, { type, period, token, signer, emit: (m) => log(m) });
        try { log('Laporan: ' + await writeEbupotPeriodReport(page, target, type, period, 'sesudah ' + (r.signed ? 'issue & sign ' : 'issue ') + r.label + ' (' + r.issued + ' bukti potong)')); }
        catch (e) { log('Laporan Excel gagal ditulis: ' + e.message); }
        log('SELESAI: ' + r.issued + ' ' + r.label + ' masa ' + r.period + ' diterbitkan' + (r.signed ? ' (ditandatangani)' : '') + (r.pending ? ', ' + r.pending + ' masih diproses Coretax - cek Telah Terbit sebentar lagi' : '') + '. Lapor SPT tetap manual.');
    }, { stopMsg: 'Terbitkan dihentikan oleh pengguna.', failPrefix: 'GAGAL terbitkan: ' });
});

/** Posting (opsional) dan unduh Konsep SPT (lib/konsep-download.js): lampiran lewat alat unduh SPT, Induk dibuat ulang. */
const handleKonsepDownload = action({}, async (req, res, body) => {
    const { entity, taxType, period, post } = body;
    if (!['ICT_WIT', 'ICT_WT'].includes(taxType)) return sendJson(res, 400, { error: 'Jenis SPT: ICT_WIT (PPh 21/26) atau ICT_WT (Unifikasi).' });
    if (taxType === 'ICT_WIT' && rejectIfRestricted(res, 'Konsep SPT PPh 21 tidak tersedia untuk pengguna Restricted.')) return;
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: (post ? 'Posting & download Konsep SPT ' : 'Download Konsep SPT ') + (taxType === 'ICT_WIT' ? 'PPh 21' : 'Unifikasi') + ' ' + period + ' · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        const outDir = path.join(body.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), target.folder || 'Manual', 'Konsep SPT');
        const r = await require('../lib/konsep-download').downloadKonsep(page, { taxType, period, post: !!post, outDir, entityName: target.label, entityCode: target.folder, entityNpwp: target.npwp || entity.npwp, emit: (m) => log(m) });
        if (r.totals) log('Konsep ' + r.period + ': PPh 21 dipotong ' + Number(r.totals.pph21 || 0).toLocaleString('id-ID') + ' (L-IA bruto ' + Number(r.totals.l1aGross || 0).toLocaleString('id-ID') + ', L-III bruto ' + Number(r.totals.l3Gross || 0).toLocaleString('id-ID') + ').');
        log('SELESAI: Konsep SPT ' + r.period + ' (' + r.model + ', posting ' + r.posting + ') diunduh: ' + r.pdf + (r.excel ? ' dan ' + r.excel : '') + '. Periksa, lalu tanda tangan & lapor manual di Coretax.');
    }, { stopMsg: 'Konsep SPT dihentikan oleh pengguna.', failPrefix: 'GAGAL: Konsep SPT - ', cleanup: () => require('../lib/html-to-pdf').closeRenderer().catch(() => {}) });
});

/** BPMP Telah Terbit: cari, ubah isian (PTKP / bruto / tarif / posisi), batalkan - lib/ebupot-edit.js. Cari dan pratinjau
 *  menjawab langsung (hanya membaca); kirim dan batal berjalan di latar dan hanya dengan kode konfirmasi pratinjau. */
function ebupotEdit(kind) {
    return action({ restricted: 'Ubah / batal BPMP tidak tersedia untuk pengguna Restricted.' }, async (req, res, body) => {
        const { entity } = body;
        if ((kind === 'amend' || kind === 'cancel') && !body.token) return sendJson(res, 400, { error: 'Kode konfirmasi pratinjau wajib - jalankan pratinjau dulu.' });
        if (body.filePath && !fs.existsSync(String(body.filePath))) return sendJson(res, 400, { error: 'File revisi tidak ditemukan: ' + body.filePath });
        const ed = require('../lib/ebupot-edit');
        const type = String(body.type || 'mp');
        if (!ed.SPEC[type]) return sendJson(res, 400, { error: 'Jenis tidak dikenal: ' + type + ' (' + Object.keys(ed.SPEC).join(', ') + ').' });
        const target = await prepareEntityPage(res, entity);
        if (!target) return;
        const needsSigner = (kind === 'amend' || kind === 'cancel') && ed.SPEC[type].sign;
        if (needsSigner && !target.signer) return sendJson(res, 400, { error: ed.SPEC[type].label + ' perlu tanda tangan; sesi manual tidak menyimpan passphrase PIC - pakai entitas dengan login otomatis.' });
        const npwp = entity.project === 'manual' ? null : entity.npwp;
        const input = { npwp, type, issued: body.issued !== false, period: body.period, nik: body.nik, name: body.name, numbers: body.numbers, detail: !!body.detail, changes: body.changes, filePath: body.filePath, token: body.token };
        const L = ed.SPEC[type].label;
        const title = { find: 'Find ' + L, 'amend-preview': L + ' amend preview', amend: L + ' amend', 'cancel-preview': L + ' cancel preview', cancel: L + ' cancel' }[kind];
        const run = { label: title + ' · ' + target.label, session: target.session };
        if (kind === 'find' || kind === 'amend-preview' || kind === 'cancel-preview') {
            return runForResult(res, run, async () => {
                const page = await target.open();
                if (kind === 'find') { const r = await ed.find(page, input); log('Cari ' + L + ' ' + r.state + ' ' + r.period + ': ' + r.total + ' bukti potong.'); return r; }
                if (kind === 'cancel-preview') { const r = await ed.previewCancel(page, input); log('Pratinjau batal ' + L + ' ' + r.period + ': ' + r.slips.length + ' bukti potong, PPh ' + r.totals.tax.toLocaleString('id-ID') + (r.token ? ' · kode konfirmasi ' + r.token : '') + '.'); return r; }
                const r = await ed.previewAmend(page, input);
                log('Pratinjau pembetulan ' + L + ': ' + r.items.length + ' bukti potong, PPh ' + r.totals.taxBefore.toLocaleString('id-ID') + ' -> ' + r.totals.taxAfter.toLocaleString('id-ID') + (r.notes.length ? ', ' + r.notes.length + ' dilewati' : '') + (r.token ? ' · kode konfirmasi ' + r.token : '') + '.');
                return r;
            }, { failPrefix: title + ' gagal: ' });
        }
        return runInBackground(res, run, async () => {
            const signer = needsSigner ? await target.signer() : null;
            const page = await target.open();
            if (kind === 'cancel') {
                const r = await ed.cancel(page, { ...input, signer, emit: (m) => log(m) });
                const ok = r.done.filter((x) => x.ok).length;
                log('SELESAI: ' + ok + ' ' + L + ' dibatalkan' + (r.done.length > ok ? ', 1 gagal (proses berhenti) - batalkan manual di e-Bupot' : '') + '.' + (r.reported ? ' Ada yang sudah dilaporkan di SPT - SPT Masa perlu dibetulkan.' : ''));
            } else {
                const outDir = path.join(body.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), target.folder || 'Manual', 'Pembetulan ' + L, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
                log('Pembetulan ' + L + (ed.SPEC[type].sign ? ' (ditandatangani passphrase PIC)' : '') + ' - cadangan di ' + outDir);
                const r = await ed.amend(page, { ...input, signer, outDir, emit: (m) => log(m) });
                const spt = ['bpu', 'bpnr'].includes(type) ? 'SPT Masa PPh Unifikasi' : 'SPT Masa PPh 21/26';
                log('SELESAI: ' + r.results.filter((x) => x.status === 'DIBETULKAN').length + ' ' + L + ' dibetulkan.' + (r.periodsReported.length ? ' Sudah dilaporkan di SPT masa ' + r.periodsReported.join(', ') + ' - buat pembetulan ' + spt + '.' : ' Posting ulang Konsep SPT sebelum lapor.'));
            }
        }, { stopMsg: title + ' dihentikan oleh pengguna.', failPrefix: 'GAGAL: ' + title + ' - ' });
    });
}

/** Rekam API Coretax (lib/coretax-recorder.js) selama `minutes` menit (atau sampai Stop) di jendela PIC entitas: pengguna
 *  mengerjakan aksinya sendiri di Coretax; hasilnya (tanpa token / passphrase) menjadi dasar otomasi jenis baru.
 *  Tidak untuk Restricted Editor: rekaman berisi lalu lintas API Coretax entitas apa adanya. */
const handleCoretaxRecord = action({ restricted: 'Rekam API Coretax tidak tersedia untuk pengguna Restricted.' }, async (req, res, body) => {
    const { entity } = body;
    const minutes = Math.min(30, Math.max(1, Number(body.minutes) || 10));
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    const file = path.join(os.homedir(), 'Downloads', 'CoretaxAgent', target.folder || 'Manual', 'Rekaman API', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (body.note ? ' ' + String(body.note).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40) : '') + '.json');
    // Galat ditangani di dalam: rekaman yang sudah berjalan selalu dihentikan dan disimpan dulu.
    return runInBackground(res, { label: 'Record Coretax API · ' + target.label, session: target.session, extra: { file } }, async () => {
        let rec = null;
        try {
            const page = await target.open();
            rec = require('../lib/coretax-recorder').start(page.context(), file, (m) => log(m));
            log('MEREKAM ' + minutes + ' menit: kerjakan aksinya di jendela Coretax ini (mis. Ubah / Batal satu bukti potong), lalu klik Stop. Passphrase dan token tidak disimpan.');
            const until = Date.now() + minutes * 60000;
            while (Date.now() < until) { const run = runcontrol.current(); if (run && run.stopRequested) break; await new Promise((r) => setTimeout(r, 1000)); }
        } catch (e) { log('Rekam gagal: ' + e.message); }
        finally {
            if (rec) { const r = await rec.stop(); log('SELESAI: ' + r.count + ' permintaan terekam -> ' + r.file); }
        }
    }, { failPrefix: 'Rekam gagal: ' });
});

/** Penyisiran saja (tanpa Excel, tanpa mengubah apa pun): masih ada NIK bermasalah di BPMP Telah Terbit tahun ini? */
async function handleBpmpSweep(res, amend, entity, taxYear, saveRoot) {
    if (!/^20\d{2}$/.test(taxYear)) return sendJson(res, 400, { error: 'Pilih tahun pajak dulu.' });
    const target = await prepareEntityPage(res, entity);
    if (!target) return;
    return runInBackground(res, { label: 'BPMP NIK check ' + taxYear + ' · ' + target.label, session: target.session }, async () => {
        const page = await target.open();
        const outDir = path.join(saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), target.folder, 'Pembetulan NIK BPMP');
        const sweepRes = await amend.sweep({ context: page.context(), npwp: entity.project === 'manual' ? null : entity.npwp, year: taxYear, outDir, emit: (m) => log(m) });
        // Kolom Cek Coretax (sheet Pembetulan) + status SPT Masa (Ringkasan) di rekap terakhir entitas ini, bila ada.
        const rekap = entity.entity_id ? require('../lib/a1-source').resolve({ a1Dir: require('../lib/a1-paths').a1Paths({ entity, saveRoot, year: taxYear }).readDirs, year: taxYear }).excel : null;
        if (rekap) {
            const out = await require('../lib/bpmp-report').writeReport({ file: rekap, year: taxYear, results: [], sweep: sweepRes });
            require('../lib/a1-autorefresh').own(out.file);
            log('Status ditulis ke ' + out.file + (out.locked ? ' (Excel rekap sedang terbuka - disimpan sebagai file terpisah).' : '.'));
            if (!out.locked) {
                try { await require('../lib/ebupot-vs-spt').run({ context: page.context(), npwp: entity.project === 'manual' ? null : entity.npwp, file: rekap, year: taxYear, emit: (m) => log(m) }); }
                catch (e) { log('Cek e-Bupot vs SPT gagal: ' + e.message); }
            }
        }
    }, { stopMsg: 'Penyisiran NIK dihentikan oleh pengguna.', failPrefix: 'Penyisiran NIK gagal: ' });
}

const handleImportDividen = action({ body: 'large', entity: false }, async (req, res, body) => {
    const { fileBase64, entity } = body;
    if (!fileBase64) return sendJson(res, 400, { error: 'File template belum dipilih.' });
    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    const target = await prepareDividenPage(res, entity, true);
    if (!target) return;
    return runInBackground(res, { label: 'Dividend import · ' + target.label, session: target.session },
        async () => runDividenImport({ manualPage: await target.open(), fileBuffer }),
        { quiet: (e) => e && e.validation /* masalah per baris sudah dicatat */, stopMsg: 'Impor dihentikan oleh pengguna.', failPrefix: 'Gagal impor Dividen: ' });
});

const handleCheckDividen = action({ body: 'large', entity: false }, async (req, res, body) => {
    const { fileBase64, entity } = body;
    if (!fileBase64) return sendJson(res, 400, { error: 'File pembanding belum dipilih.' });
    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    const target = await prepareDividenPage(res, entity, true);
    if (!target) return;
    return runInBackground(res, { label: 'Dividend check · ' + target.label, session: target.session },
        async () => runDividenCheck({ manualPage: await target.open(), fileBuffer }),
        { stopMsg: 'Cek Hasil dihentikan oleh pengguna.', failPrefix: 'Gagal Cek Hasil: ' });
});

const handleCreateDividenCase = action({ body: 'lenient', entity: false }, async (req, res, body) => {
    const target = await prepareDividenPage(res, body.entity, false);
    if (!target) return;
    return runInBackground(res, { label: 'Create dividend case · ' + target.label, session: target.session },
        async () => openNewCase(await target.open()),
        { stopMsg: 'Pembuatan kasus baru dihentikan oleh pengguna.', failPrefix: 'Gagal membuat kasus baru: ' });
});

const handleLoginEntity = action({}, async (req, res, body) => {
    const { entity } = body;
    if (entity.project === 'manual') return sendJson(res, 400, { error: 'Sesi manual sudah login sendiri - tombol ini khusus entitas dengan login otomatis.' });
    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    return runInBackground(res, { label: 'Coretax login · ' + src.label, session: sessionOf(src) }, () => runLoginOnly({
        client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId,
        restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase
    }), { stopMsg: 'Login dibatalkan oleh pengguna.', failPrefix: 'Gagal login: ' });
});

/** Receives a taxio-coretax:// URL forwarded from a SECOND process launch (see main.js's
 *  forwardDeepLinkToRunningInstance) - this instance already owns the dashboard window, so it
 *  just dispatches the link itself instead of the caller trying to become its own primary. Acks
 *  immediately (fire-and-forget, same as the download/login routes) since dispatch can run for
 *  minutes. */
async function handleDeepLink(req, res, ctx) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    if (!body || !body.url) return sendJson(res, 400, { error: 'URL kosong.' });
    sendJson(res, 202, { received: true });
    // A click from Taxio/Taxio.me arrives here whenever Coretax Agent is ALREADY running in the
    // background (this is the forwarded-to-primary-instance path - see main.js's
    // forwardDeepLinkToRunningInstance). Previously that ran the automation with no window ever
    // shown, so the user had no way to see what it was doing. Bring the dashboard up so the log
    // is visible, same as a cold start via the same link already does (main.js calls openWindow
    // unconditionally there). `req.headers.host` is this same server's own host:port (validated
    // by the Host check in createGuiServer) - no need to hardcode GUI_PORT here. Goes through the
    // serializing queue (not a raw isWindowOpen/openWindow check) - see ensureWindowOpenOrFocused()'s
    // header comment for why: rapid back-to-back clicks from Taxio each hitting this handler
    // concurrently used to race past the check and each spawn their own window.
    if (!SMOKE) await ensureWindowOpenOrFocused(dashboardUrl(req, ctx));
    deeplink.dispatch(body.url).catch((e) => log('Deep link gagal: ' + e.message));
}

async function handleOpenCoretaxManual(req, res) {
    if (rejectIfOutdated(res)) return;
    if (!state.connectedProjectIds().length) return sendJson(res, 401, { error: 'Harus terhubung ke setidaknya satu akun Taxio/Taxio.me sebelum membuka Coretax manual.' });
    if (anyRestricted()) {
        log('Akses Coretax Manual ditolak untuk akun Restricted Editor.');
        return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan menggunakan Login Coretax Manual. Silakan pilih entitas dan klik tombol Login pada entitas tersebut.' });
    }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    chrome.openCoretaxManual(false, null).catch((e) => log('Gagal membuka Coretax manual: ' + e.message));
}

async function handleQuit(req, res) {
    sendJson(res, 200, { ok: true });
    log('Menutup Taxio Pilot...');
    tray.stop(); // otherwise the NotifyIcon is orphaned - still visible, both menu items dead
    // closeWindow() finds the dashboard by its window TITLE - in a smoke run (no window of its own)
    // that would close a real Taxio Pilot window running on the same PC, so it is skipped there.
    if (!SMOKE) closeWindow(); // window is spawned detached+unref'd - survives process.exit() below on its own otherwise
    // Chrome automation windows (per-PIC + manual login) are launchPersistentContext()'d - a
    // genuinely separate OS process from this one, so process.exit() below never touches them on
    // its own; any window opened this session (including a restricted editor's hidden off-screen
    // one) would otherwise survive as an orphan. Race against a timeout so one stuck/unresponsive
    // context can't block quitting forever.
    await Promise.race([
        chrome.closeAllAutomationWindows().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    try { chrome.clearDownloadTemp(); } catch (e) {} // after automation windows close, so nothing's still mid-download
    setTimeout(() => process.exit(0), 300);
}

// Manual "Cek Update" button in Settings - same checkAndApply() the startup check uses, so
// behavior stays consistent (full-auto: finds it, downloads it, restarts into it - explicit
// user request 2026-08-07, not a "review then confirm" flow). Responds immediately with
// whatever checkForUpdate() alone reports (available/current/latest) so the UI has something to
// show right away, then lets the full check-and-apply cycle run in the background - if an
// update was found the app will restart itself within a few seconds regardless of what this
// response said.
async function handleCheckUpdate(req, res, ctx) {
    const info = await updater.checkForUpdate();
    sendJson(res, 200, info);
    if (info.available) {
        updater.checkAndApply({
            isRunActive: () => runcontrol.anyActive(),
            onBeforeRestart: async () => {
                try { await fetch('http://127.0.0.1:' + ctx.port + '/api/quit', { method: 'POST', headers: { Authorization: 'Bearer ' + ctx.token } }); } catch (e) {}
            }
        }).catch((e) => log('Gagal menerapkan update: ' + e.message));
    }
}

/** URL pembuka jendela dashboard: membawa token sekali (/?t=), server menukarnya dengan cookie lalu
 *  redirect ke / (lihat route() di createGuiServer). Host = host permintaan ini sendiri (sudah lolos
 *  cek Host), jadi 127.0.0.1 maupun localhost tetap konsisten dengan cookie-nya. */
function dashboardUrl(req, ctx) {
    return 'http://' + req.headers.host + '/?t=' + encodeURIComponent(ctx.token);
}

async function handleTrayOpen(req, res, ctx) {
    sendJson(res, 200, { ok: true });
    if (SMOKE) return; // smoke run: no windows (gui/window.js matches windows by title - see handleQuit)
    // Serializing queue, same reason as handleDeepLink above.
    await ensureWindowOpenOrFocused(dashboardUrl(req, ctx));
}

// ---- Pemeriksaan sistem & ekspor diagnostik (lib/doctor.js, lib/diagnostics.js) ----
// Hasil pemeriksaan disimpan sebentar: tombol "Periksa ulang" mengirim ?fresh=1.
const HEALTH_CACHE_MS = 30000;
let _health = null; // { at, promise }
let launchInfo = { preferredPort: runtime.PREFERRED_PORT, fellBack: false };
/** main.js memberi tahu apakah port pilihan terpakai (pemeriksaan "Port & token"). */
function setLaunchInfo(info) { launchInfo = Object.assign({}, launchInfo, info || {}); _health = null; }
function healthContext(ctx) {
    return { port: ctx.port, preferredPort: launchInfo.preferredPort, fellBack: !!launchInfo.fellBack, tokenRequired: !!ctx.token };
}
function runHealth(ctx, fresh) {
    if (!fresh && _health && Date.now() - _health.at < HEALTH_CACHE_MS) return _health.promise;
    const promise = doctor.runChecks({ server: healthContext(ctx) });
    _health = { at: Date.now(), promise };
    promise.catch(() => { _health = null; });
    return promise;
}
async function handleHealth(req, res, ctx) {
    const report = await runHealth(ctx, ctx.url.searchParams.get('fresh') === '1');
    return sendJson(res, 200, report);
}
async function handleDiagnosticsExport(req, res, ctx) {
    const report = await runHealth(ctx, false);
    const out = await diagnostics.exportZip({ health: report, runtimeInfo: runtime.publicInfo(Object.assign({ pid: process.pid, version: pkg.version, token: ctx.token }, healthContext(ctx))), secrets: [ctx.token] });
    log('Diagnostik diekspor ke ' + out.file + ' (' + Math.round(out.bytes / 1024) + ' KB).');
    return sendJson(res, 200, { file: out.file, bytes: out.bytes, entries: out.entries });
}

function handleClearLog(req, res) {
    logBacklog.length = 0;
    log('Log dibersihkan dari layar (arsip tetap tersimpan di ' + LOG_FILE + ').');
    sendJson(res, 200, { ok: true });
}

function handleEvents(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    // Log backlog without its notices; the notices the window has not closed yet come after it.
    for (const entry of logBacklog) if (!entry.notice) res.write('data: ' + JSON.stringify(entry) + '\n\n');
    for (const notice of pendingNotices()) res.write('data: ' + JSON.stringify({ notice, ts: notice.ts }) + '\n\n');
    const unsubscribe = onLogLine((entry) => { try { res.write('data: ' + JSON.stringify(entry) + '\n\n'); } catch (e) { } });
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { } }, 20000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
}

async function handlePickFile(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { }
    // dir: folder awal dialog (mis. folder file impor terakhir; "downloads" = folder Downloads pengguna).
    const dir = body.dir === 'downloads' ? path.join(os.homedir(), 'Downloads') : (typeof body.dir === 'string' ? body.dir : '');
    const filePath = await fileDialog.pick({ kind: 'file', title: body.title || 'Pilih File', filter: body.filter || 'Semua File (*.*)|*.*', dir });
    if (filePath && filePath.busy) return sendJson(res, 200, { canceled: true, busy: true });
    if (!filePath) return sendJson(res, 200, { canceled: true });
    let fileBase64 = null;
    let fileName = path.basename(filePath);
    try {
        const buf = fs.readFileSync(filePath);
        fileBase64 = buf.toString('base64');
    } catch (e) {
        return sendJson(res, 400, { error: 'Gagal membaca file dari ' + filePath + ': ' + e.message });
    }
    return sendJson(res, 200, { filePath, fileName, fileBase64 });
}

async function handlePickFolder(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { }
    const folderPath = await fileDialog.pick({ kind: 'folder', title: body.title || 'Pilih Folder' });
    if (folderPath && folderPath.busy) return sendJson(res, 200, { canceled: true, busy: true });
    if (!folderPath) return sendJson(res, 200, { canceled: true });
    return sendJson(res, 200, { folderPath });
}

/** Tombol kontrol proses (Jeda, Lanjut, ...) untuk sesi `?session=`; membalas status sesi itu. */
const runControl = (fn) => (req, res, { sess }) => { fn(sess); return sendJson(res, 200, runcontrol.status(sess)); };

async function handleRunPageSize(req, res, { sess }) {
    let b;
    try { b = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const n = Number(b && b.size);
    if ([10, 25, 50, 100].includes(n)) runcontrol.setPageSizeOverride(n, sess);
    return sendJson(res, 200, runcontrol.status(sess));
}

// Tabel route: 'METODE /path' -> handler(req, res, { url, sess }). Selain yang tercantum: berkas
// statis dashboard (gui/public).
const ROUTES = {
    'GET /events': handleEvents,
    'GET /api/session': (req, res) => sendJson(res, 200, sessionSummary()),
    'GET /api/version': (req, res) => sendJson(res, 200, Object.assign({ version: pkg.version }, updater.getOutdatedInfo())),
    // MCP (mcp/taxio-pilot-mcp.js) membaca log Pilot yang SEDANG berjalan - exe bisa dijalankan dari folder lain.
    'GET /api/log-file': (req, res) => sendJson(res, 200, { path: LOG_FILE }),
    'POST /api/connect': handleConnect,
    'POST /api/disconnect': handleDisconnect,
    'GET /api/entities': (req, res, { url }) => handleEntities(req, res, url.searchParams.get('mode')),
    'POST /api/signup': handleSignup,
    'POST /api/registration/check': handleRegistrationCheck,
    'POST /api/registration/initial': handleRegistrationInitial,
    'GET /api/local-entities': handleLocalEntities,
    'POST /api/local-entities/save': handleLocalEntitySave,
    'POST /api/local-entities/delete': handleLocalEntityDelete,
    'POST /api/actions/billing-pph25': handleBillingPph25,
    'POST /api/actions/download-ebupot': handleDownloadEbupot,
    'POST /api/actions/download-mybupot': handleDownloadMyBupot,
    'POST /api/actions/download-spt': handleDownloadSpt,
    'POST /api/actions/import-pajak-masukan': handleImportPajakMasukan,
    'POST /api/actions/download-pajak-masukan': handleDownloadPajakMasukan,
    'POST /api/actions/download-efaktur': handleDownloadEfaktur,
    'POST /api/actions/import-dividen': handleImportDividen,
    'POST /api/actions/bpmp-amend': handleBpmpAmend,
    'POST /api/import/inspect': handleImportInspect,
    'POST /api/actions/import-coretax': handleImportUpload,
    'POST /api/actions/create-konsep': handleCreateKonsep,
    'POST /api/actions/konsep-download': handleKonsepDownload,
    'POST /api/ebupot/issue-preview': handleIssuePreview,
    'POST /api/ebupot/find': ebupotEdit('find'),
    'POST /api/ebupot/amend-preview': ebupotEdit('amend-preview'),
    'POST /api/ebupot/cancel-preview': ebupotEdit('cancel-preview'),
    'POST /api/actions/ebupot-amend': ebupotEdit('amend'),
    'POST /api/actions/ebupot-cancel': ebupotEdit('cancel'),
    'POST /api/actions/coretax-record': handleCoretaxRecord,
    'POST /api/actions/issue-ebupot': handleIssueEbupot,
    'POST /api/a1/inspect': handleA1Inspect,
    'POST /api/bpmp-amend/preview': handleBpmpAmendPreview,
    'POST /api/actions/a1-refresh': handleA1Refresh,
    'POST /api/a1/bpa1-xml': handleBpa1Xml,
    'POST /api/actions/check-dividen': handleCheckDividen,
    'POST /api/actions/create-dividen-case': handleCreateDividenCase,
    'POST /api/actions/login-entity': handleLoginEntity,
    'GET /api/login/status': (req, res) => sendJson(res, 200, loginStatus.get() || { at: 0 }),
    'POST /api/actions/pick-file': handlePickFile,
    'POST /api/actions/pick-folder': handlePickFolder,
    'POST /api/actions/open-coretax': handleOpenCoretaxManual,
    'POST /api/deeplink': handleDeepLink,
    'GET /api/manual/status': handleManualStatus,
    'POST /api/session/status': handleSessionStatus,
    'GET /api/sessions/list': handleSessionsList,
    'POST /api/sessions/front': handleSessionFront,
    'POST /api/sessions/close': handleSessionClose,
    'GET /api/run/status': (req, res, { sess }) => sendJson(res, 200, runcontrol.status(sess)),
    'POST /api/run/pause': runControl((s) => runcontrol.pause(s)),
    'POST /api/run/resume': runControl((s) => runcontrol.resume(s)),
    'POST /api/run/skip': runControl((s) => runcontrol.skip(s)),
    'POST /api/run/retry': runControl((s) => runcontrol.retry(s)),
    'POST /api/run/back': runControl((s) => runcontrol.back(s)),
    'POST /api/run/stop': runControl((s) => runcontrol.stop(s)),
    'POST /api/run/pagesize': handleRunPageSize,
    'POST /api/quit': handleQuit,
    'POST /api/check-update': handleCheckUpdate,
    'POST /api/tray/open': handleTrayOpen,
    'POST /api/log/clear': handleClearLog,
    'GET /api/health': handleHealth,
    'POST /api/diagnostics/export': handleDiagnosticsExport,
    'POST /api/notices/ack': (req, res, { url }) => { ackNotice(url.searchParams.get('id') || 'all'); return sendJson(res, 200, { ok: true }); }
};

// Penolakan asal permintaan dicatat paling sering sekali per 5 detik: halaman jahat yang terus
// mengulang tidak boleh membanjiri log.
let lastSecurityLog = 0;
function logRejected(req, pathname, problem) {
    const now = Date.now();
    if (now - lastSecurityLog < 5000) return;
    lastSecurityLog = now;
    log('[SECURITY] Permintaan ' + req.method + ' ' + String(pathname).slice(0, 200) + ' ditolak - ' + problem);
}

function serverError(res, e) {
    log('GUI server error: ' + (e && e.message));
    if (!res.headersSent) { try { sendJson(res, 500, { error: e && e.message }); } catch (e2) { /* koneksi sudah putus */ } }
    else { try { res.end(); } catch (e2) { /* abaikan */ } }
}

/** Membuka server dashboard di 127.0.0.1:`port` (0 = port bebas pilihan OS). `opts.token`: token
 *  peluncuran (lib/runtime.js; dibuat baru bila tidak diberikan). Resolves server http dengan
 *  `server.token`. EADDRINUSE dilempar apa adanya - pemilihan port cadangan ada di
 *  lib/runtime.js listenPreferred(). */
function createGuiServer(port, opts) {
    const token = (opts && opts.token) || runtime.newToken();
    fileDialog.warm();
    const server = http.createServer((req, res) => runcontrol.isolate(() => route(req, res)));
    server.token = token;
    let boundPort = null; // diisi begitu listen() berhasil (port 0 = dipilih OS)
    function route(req, res) {
        try {
            // Penanda "ini Taxio Pilot" untuk instance lain yang memeriksa port (lib/runtime.js) - bukan rahasia.
            res.setHeader(runtime.PILOT_HEADER, pkg.version);
            const url = new URL(req.url, 'http://127.0.0.1');
            const { pathname } = url;
            // SETIAP permintaan (API, /events, berkas statis): Host harus dashboard ini sendiri
            // (anti DNS rebinding) dan Origin, bila ada, harus origin dashboard ini (anti CSRF).
            // Lihat gui/guards.js. Port = port yang benar-benar di-bind (tes memakai port lain / 0).
            const problem = requestOriginProblem(req, boundPort);
            if (problem) {
                logRejected(req, pathname, problem);
                return sendJson(res, 403, { error: 'Ditolak: permintaan lintas-origin tidak diizinkan.' });
            }
            // Pembuka jendela dashboard: /?t=<token> -> cookie HttpOnly, lalu redirect ke / (token tidak
            // tertinggal di alamat / riwayat halaman). t yang salah ditolak 401.
            if (pathname === '/' && url.searchParams.has('t')) {
                if (!runtime.tokenEquals(url.searchParams.get('t'), token)) {
                    logRejected(req, pathname, 'token ?t= salah');
                    return sendJson(res, 401, { error: 'Tautan dashboard tidak berlaku (Taxio Pilot sudah dibuka ulang?). Buka Taxio Pilot lagi dari ikon / pintasannya.', auth: true });
                }
                res.writeHead(302, { 'Set-Cookie': setAuthCookieHeader(boundPort, token), Location: '/', 'Cache-Control': 'no-store' });
                return res.end();
            }
            // /api/* dan /events wajib token (Bearer atau cookie); berkas statis tidak.
            if (needsAuth(pathname)) {
                const why = authProblem(req, boundPort, token);
                if (why) {
                    logRejected(req, pathname, why);
                    return sendJson(res, 401, { error: UNAUTHORIZED_MESSAGE, auth: true });
                }
            }
            const key = req.method + ' ' + pathname;
            if (!Object.prototype.hasOwnProperty.call(ROUTES, key)) return serveStatic(req, res, pathname);
            const out = ROUTES[key](req, res, { url, sess: url.searchParams.get('session') || null, token, port: boundPort });
            if (out && typeof out.catch === 'function') out.catch((e) => serverError(res, e));
        } catch (e) {
            serverError(res, e);
        }
    }
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { boundPort = server.address().port; resolve(server); });
    });
}

module.exports = { createGuiServer, setLaunchInfo };
