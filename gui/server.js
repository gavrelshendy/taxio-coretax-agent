/* Coretax Agent - local GUI server.
   Plain node:http (no Express - zero new runtime deps, avoids reintroducing any pkg-bundling
   risk). Bound to 127.0.0.1 only. Serves the static dashboard from gui/public/ and a small
   hand-written JSON API. Route table is a literal object (no directory-scanning route
   loader) so pkg's static analyzer can see every require() at build time.

   Supports being connected to BOTH Taxio (Grup) and Taxio.me at once (see lib/state.js) -
   every route that touches "the connection" takes an explicit `project` id rather than
   assuming a single global one. */
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const tray = require('../lib/tray');
const updater = require('../lib/updater');
const { closeWindow, ensureWindowOpenOrFocused } = require('./window');
// Single source of truth for the version badge in gui/public/index.html - that used to be a
// hardcoded <span>v1.8.1</span> that nobody remembered to bump across three straight releases
// (1.9.0/1.9.1/1.9.2 all shipped correctly but kept showing v1.8.1 in the dashboard itself).
// Reading it live here means every future version bump only ever has to happen in one place
// (package.json) again.
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const PROJECTS_WITH_OWNER_COLUMN = {};

const LOG_BACKLOG_MAX = 200;
const logBacklog = [];
onLogLine((entry) => {
    logBacklog.push(entry);
    if (logBacklog.length > LOG_BACKLOG_MAX) logBacklog.shift();
});

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

// Local-only server (bound to 127.0.0.1, see createGuiServer below), but "local-only" is NOT
// the same as "safe from the browser" - ANY webpage the user has open in ANY tab on this same
// machine can have its JS fire a cross-origin fetch()/XHR at http://127.0.0.1:<port>/api/... too
// (loopback isn't a trust boundary browsers enforce). Confirmed live during this audit: every
// POST route here (including /api/quit) executed with a plain unauthenticated request - zero
// Origin/Referer/token check existed anywhere. A "simple request" (Content-Type left as
// text/plain, which skips the CORS preflight) reaches the handler and has its full side effect
// even though the calling page can never read the JSON response back (blocked by the browser's
// own CORS policy, since this server sends no Access-Control-Allow-Origin) - classic blind CSRF.
// Fix: reject any state-changing request whose Origin header (when present - real cross-origin
// browser requests always attach one; same-origin requests from THIS app's own dashboard window
// also send it, matching exactly) isn't this same server's own origin. A non-browser caller could
// still forge this header, but that requires code execution on the machine already - a
// fundamentally different threat model than "visited the wrong webpage while this was running".
function isForeignOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false; // no Origin header = not a cross-origin browser request (curl, same-tab navigation, Playwright's own automation, etc - none of these are the CSRF threat this guards against)
    return origin !== 'http://127.0.0.1:' + req.headers.host.split(':').pop() && origin !== 'http://' + req.headers.host;
}

function isProjectRestricted(projectId) {
    const s = state.get(projectId);
    if (!s) return false;
    const r1 = String(s.role || '').trim().toLowerCase().replace(/-/g, '_');
    const r2 = String((s.membership && s.membership.role) || '').trim().toLowerCase().replace(/-/g, '_');
    return r1.includes('restricted') || r2.includes('restricted');
}

// Server-side enforcement of allowed_ebupot_sections - previously this value was only ever
// read to build the admin's "Manage Members" config UI and passed through into the automation
// opts for the in-page watchdog to (imperfectly) enforce; nothing ever rejected a restricted
// editor's download REQUEST itself here, so a direct POST to these routes bypassed it entirely
// regardless of what was configured. Fixed 2026-07-27.
// Maps a bupotType/buktiTypeKey (used in download requests) to the matching config key (used
// in the admin panel's per-restricted_editor checkboxes, see supabase.js ebupotOpts) - the two
// naming schemes don't line up 1:1 (e.g. download-type 'bppu' vs config-key 'ebupotbpu'), so
// this has to be explicit rather than a generic string transform.
const EBUPOT_TYPE_TO_SECTION = { bp21: 'ebupotbp21', bppu: 'ebupotbpu', bpmp: 'ebupotbpmp', bp26: 'ebupotbp26', bpnr: 'ebupotbpnr' };
// BPMP/BPA1, in both e-Bupot (entity-issued) and "Bukti Potong Saya" (PIC's own personal
// received slips) - explicit user request 2026-08-10, absolute for restricted_editor and NOT
// admin-configurable (unlike the other types below, which stay gated by allowed_ebupot_sections).
const ABSOLUTELY_BLOCKED_EBUPOT_TYPES = ['bpmp', 'bpa1'];
const ABSOLUTELY_BLOCKED_MYBUPOT_TYPES = ['bpmp', 'bpa1'];
function isEbupotTypeAllowed(allowedSections, bupotType) {
    if (ABSOLUTELY_BLOCKED_EBUPOT_TYPES.includes(bupotType)) return false;
    if (!allowedSections) return true; // not configured yet - matches the admin panel's own "unset = all checked" default
    const section = EBUPOT_TYPE_TO_SECTION[bupotType];
    if (!section) return true; // no configurable section for this type (e.g. bpa2/bpatc) - nothing to gate against
    return allowedSections.includes(section);
}
function isMyBupotAllowed(allowedSections) {
    if (!allowedSections) return true;
    return allowedSections.includes('my-withholding-slips');
}
// Explicit user request 2026-08-10 (real test: a restricted editor could still search for and
// log into/download from a PIC's own personal Individual account). `entity.individual` is
// already threaded through every handler below from Taxio Hub's own entity payload - this is
// the actual execution point (Coretax Agent's own automation), so blocking here holds regardless
// of what triggered the request (Taxio Hub's UI, a raw deep link, or this app's own picker) -
// unlike a client-side-only check, which a deep link can simply bypass entirely.
function isIndividualEntityBlocked(restricted, entity) {
    return !!(restricted && entity && entity.individual);
}

// Explicit user request 2026-08-13: refuses to START any new automation action while a newer
// release is confirmed available - the auto-update-on-startup check is the only thing that
// otherwise keeps this build current, and if it ever gets deferred, fails, or someone's just
// running an old copy they downloaded before a security fix shipped, nothing else would stop
// them from continuing to use it indefinitely. Deliberately does NOT touch runcontrol at all -
// an already-active run is never interrupted (updater.getOutdatedInfo() only ever reports
// "outdated" from a positively-confirmed GitHub check, so a network hiccup can't trigger this).
function rejectIfOutdated(res) {
    const info = updater.getOutdatedInfo();
    if (!info.outdated) return false;
    sendJson(res, 426, { error: 'Taxio Pilot versi ' + (info.current || '') + ' sudah usang (v' + info.latestVersion + ' tersedia) - update otomatis akan berjalan begitu tidak ada proses aktif. Coba lagi sebentar lagi, atau klik "Cek Update" di Pengaturan.', outdated: true, latestVersion: info.latestVersion });
    return true;
}

function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(buf);
    });
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
            const hasOwnerColumn = !!PROJECTS_WITH_OWNER_COLUMN[projectId];
            const list = await entitiesLib.listAutomatableEntities(s.client, s.orgId, s.user.id, hasOwnerColumn, mode);
            list.forEach((e) => { e.project = projectId; e.project_label = PROJECTS[projectId].label; });
            all.push(...list);
        } catch (e) {
            errors.push(PROJECTS[projectId].label + ': ' + e.message);
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
    if (anyRestricted()) { sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan memakai entitas lokal.' }); return false; }
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
async function handleBillingPph25(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, masaInput, nominal, saveRoot } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    const mmYY = String(masaInput || '').trim();
    if (!/^(0[1-9]|1[0-2])\d{2}$/.test(mmYY)) return sendJson(res, 400, { error: 'Masa harus berformat MMYY, misalnya 0726.' });
    const amount = Number(String(nominal || '').replace(/[^\d]/g, ''));
    if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Nominal PPh 25 wajib diisi.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    const runOpts = src.kind === 'manual'
        ? { manualPage: src.manualPage, entity: src.runEntity, masaInput: mmYY, nominal: amount, saveRoot }
        : { client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId, masaInput: mmYY, nominal: amount, saveRoot,
            restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase };

    try { runcontrol.start('Kode Billing PPh 25 · ' + mmYY + ' · ' + src.label, sessionOf(src)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runBillingPph25(runOpts);
    } catch (e) {
        if (e && e.isStop) log('Proses dihentikan oleh pengguna.');
        else log('Gagal membuat Kode Billing PPh 25: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

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

function anyRestricted() { return state.connectedProjectIds().some(isProjectRestricted); }
function currentUserId() {
    const id = state.connectedProjectIds()[0];
    return id ? state.get(id).user.id : null;
}

/** Menyiapkan proses di sesi Coretax manual POLOS - pengguna membuka Chrome sendiri lewat
 *  "Buka Coretax" dan login dengan tangannya sendiri, tanpa kredensial tersimpan apa pun. Ini
 *  jalur yang sudah ada sejak awal aplikasi; TETAP ADA berdampingan dengan entitas lokal
 *  berkredensial (yang sekarang login otomatis, lihat resolveEntitySource). Mengembalikan
 *  { manualPage, runEntity }, atau null setelah membalas galat. */
function prepareManual(res) {
    if (anyRestricted()) {
        sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan memakai login manual.' });
        return null;
    }
    const manualPage = chrome.getManualPage();
    if (!manualPage) {
        sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Buka Coretax", login dulu, lalu coba lagi.' });
        return null;
    }
    return { manualPage, runEntity: { entity_id: 'Manual', entity_name: 'Sesi Manual', npwp: '', individual: false } };
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
        const m = prepareManual(res);
        if (!m) return null;
        return { kind: 'manual', manualPage: m.manualPage, runEntity: m.runEntity, label: 'Sesi Manual' };
    }
    if (entity.project === 'local') {
        if (anyRestricted()) { sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan memakai entitas lokal.' }); return null; }
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
    if (authorized.denied) { sendJson(res, 403, { error: 'Anda tidak berwenang memakai PIC yang dipilih untuk entitas ini di Taxio Hub. Pilih PIC lain di palet entitas, atau minta admin memberi akses.' }); return null; }
    const passphrase = authorized.passphrase;
    const fallbackPicIds = authorized.fallbackPicIds;
    return {
        kind: 'auto', client: s.client, orgId: s.orgId, picId: authorized.picId,
        entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
        restricted, allowedEbupotSections, passphrase, fallbackPicIds, label: entity.entity_name
    };
}

/** Kunci sesi + label log sebuah proses (lib/runcontrol.js): satu proses per jendela Chrome PIC
 *  (atau sesi manual), sesi berbeda boleh berjalan bersamaan. Kuncinya sama dengan picId di
 *  /api/sessions/list, jadi tab sesi di dashboard bisa mencocokkan prosesnya. */
const MANUAL_SESSION = { key: 'manual', tag: 'Manual' };
function sessionOf(src) {
    if (!src || src.kind === 'manual') return MANUAL_SESSION;
    const id = String((src.entity && src.entity.entity_id) || '');
    // Entitas lokal ber-id internal ("local:<uuid>"): labelnya pakai kata pertama namanya.
    const tag = id.startsWith('local:') ? String((src.entity && src.entity.entity_name) || 'Lokal').split(/[\s,]+/)[0] : id;
    return { key: src.picId, tag: tag.slice(0, 16) };
}
function runSessionKey() { const r = runcontrol.current(); return r ? r.key : null; }

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
        label: src.label, folder: src.entity.entity_id, session: sessionOf(src),
        open: () => runLoginOnly({
            client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId,
            restricted: src.restricted, passphrase: src.passphrase, allowedEbupotSections: src.allowedEbupotSections
        })
    };
}

async function handleDownloadEbupot(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode } = body || {};
    const documentStatus = body && body.documentStatus ? body.documentStatus : 'issued';
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!bupotType || !masaInput) return sendJson(res, 400, { error: 'Jenis bupot & masa wajib diisi.' });
    if (!['issued', 'not_issued'].includes(documentStatus)) return sendJson(res, 400, { error: 'Status dokumen e-Bupot tidak valid.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    if (src.kind === 'auto' && src.restricted && !isEbupotTypeAllowed(src.allowedEbupotSections, bupotType)) {
        return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengunduh jenis e-Bupot ini.' });
    }
    const runOpts = src.kind === 'manual'
        ? { manualPage: src.manualPage, entity: src.runEntity, bupotType, documentStatus, masaInput, kodeInput, saveRoot, pageSize, outputMode }
        : { client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId, bupotType, documentStatus, masaInput, kodeInput, saveRoot, pageSize, outputMode,
            restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase };

    // One automation run per session (Chrome window): two runs in the same window would fight
    // over it, but different sessions run side by side (lib/runcontrol.js).
    try { runcontrol.start('e-Bupot ' + bupotType.toUpperCase() + ' · ' + (documentStatus === 'not_issued' ? 'Belum Terbit' : 'Telah Terbit') + ' · ' + src.label, sessionOf(src)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    // Fire-and-forget: the run streams its own progress over /events. Respond immediately so
    // the GUI isn't blocked on a request that can legitimately take many minutes.
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runEbupotDownload(runOpts);
    } catch (e) {
        if (e && e.isStop) log('Proses dihentikan oleh pengguna.');
        else log('Gagal download e-Bupot: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleDownloadMyBupot(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    let { buktiTypeKeys } = body || {};
    const { entity, masaInput, saveRoot, pageSize, outputMode } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
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
    const runOpts = src.kind === 'manual'
        ? { manualPage: src.manualPage, entity: src.runEntity, buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode }
        : { client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId, buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode,
            restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase };

    try { runcontrol.start('Bukti Potong Saya · ' + src.label, sessionOf(src)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runMyBuktiPotongDownload(runOpts);
    } catch (e) {
        if (e && e.isStop) log('Proses dihentikan oleh pengguna.');
        else log('Gagal download Bukti Potong Saya: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleDownloadSpt(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    if((body?.a1Year !== undefined || body?.jenisPajakKeys?.includes('pph21')) && require('../lib/spt-access').isRestricted())return sendJson(res,403,{error:'Seluruh unduhan SPT PPh 21 diblokir untuk pengguna Restricted.'});
    if(body?.a1Year !== undefined){
        // Use trusted session roles, never a role supplied in the request body.
        // Check every active connection so selecting a manual/other project cannot bypass this.
        if(state.connectedProjectIds().some(isProjectRestricted))return sendJson(res,403,{error:'Mode A1 tidak tersedia untuk pengguna Restricted.'});
        if(!/^20\d{2}$/.test(String(body.a1Year))||Number(body.a1Year)<2025)return sendJson(res,400,{error:'Tahun Mode A1 harus mulai 2025.'});
        const yy=String(body.a1Year).slice(2);
        body={...body,jenisPajakKeys:['pph21'],masaInput:'01'+yy+'-12'+yy,includeLampiran:true,includeBpe:true,includeInduk:true,lampiranMode:'full',lampiranFormat:'pdf',outputLayout:'combined',checkPph25:false};
    }
    const { entity, jenisPajakKeys, masaInput, saveRoot, checkPph25, includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout, layoutStyle } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!Array.isArray(jenisPajakKeys) || !jenisPajakKeys.length || !masaInput) return sendJson(res, 400, { error: 'Jenis pajak & masa wajib diisi.' });

    const src = await resolveEntitySource(res, entity);
    if (!src) return;
    // Entitas dengan >1 PIC (Taxio Hub tertaut, atau Badan lokal dengan beberapa PIC): SPT cuma
    // bisa digenerate sesuai penandatangan aslinya, jadi runSptDownload dikasih tahu PIC lain
    // yang bisa dicoba otomatis bila baris di bawah PIC terpilih gagal.
    const runOpts = src.kind === 'manual'
        ? { manualPage: src.manualPage, entity: src.runEntity, jenisPajakKeys, masaInput, saveRoot, checkPph25,
            includeLampiran: !!includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout, layoutStyle,
            onRowDone: (jenisKey, mmYY, ok) => runcontrol.recordRowDone(jenisKey, ok) }
        : { client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId, jenisPajakKeys, masaInput, saveRoot, checkPph25,
            includeLampiran: !!includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout, layoutStyle,
            restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase, fallbackPicIds: src.fallbackPicIds,
            onRowDone: (jenisKey, mmYY, ok) => runcontrol.recordRowDone(jenisKey, ok) };

    runOpts.a1Year=body.a1Year;
    try { runcontrol.start('SPT ' + jenisPajakKeys.join('+') + ' · ' + src.label, sessionOf(src)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    runcontrol.setJenisRequested(jenisPajakKeys);
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runSptDownload(runOpts);
    } catch (e) {
        if (e && e.isStop) log('Proses dihentikan oleh pengguna.');
        else log('Gagal download SPT: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

/** Reads a JSON body with a larger cap than readJsonBody's 1MB - the Dividen import posts the
 *  whole .xlsx as base64, which (with 514-city + 122-form reference sheets) can run a few hundred
 *  KB; 20MB is a comfortable ceiling that still guards against runaway uploads. */
function readLargeJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let data = ''; const cap = maxBytes || 20 * 1024 * 1024;
        req.on('data', (c) => { data += c; if (data.length > cap) { req.destroy(); reject(new Error('File terlalu besar.')); } });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

/** Pajak Masukan - unduh Excel. Berjalan pada halaman Coretax milik entitas (login otomatis lewat
 *  PIC tertaut, sama seperti SPT) atau pada sesi login manual. Bukan tiruan tombol "Ekspor ke
 *  Excel" Coretax sendiri (terbukti murni client-side) - generate sendiri dari /inputinvoice/list. */
async function handleDownloadPajakMasukan(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, masaInput, saveRoot } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!masaInput) return sendJson(res, 400, { error: 'Masa wajib diisi.' });

    let masaList;
    try { masaList = masaLib.parseMasaListInput(masaInput); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;

    try { runcontrol.start('Download Pajak Masukan · ' + target.label, target.session); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        const page = await target.open();
        await pajakMasukan.runDownloadExcel({ page, masaList, saveRoot, entityFolder: target.folder, emit: (m) => log(m) });
    } catch (e) {
        log('Gagal download Pajak Masukan: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

/** e-Faktur - unduh delapan jenis dokumen (Pajak Masukan/Keluaran, Retur, Dokumen Lain, Retur Dokumen Lain).
 *  Excel diambil langsung dari daftar Coretax; CSV resmi dibuat oleh Coretax sendiri (ekspor massal). */
async function handleDownloadEfaktur(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, masaInput, types, excel, csv, saveRoot } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!masaInput) return sendJson(res, 400, { error: 'Masa wajib diisi.' });
    const known = new Set(efaktur.DOC_TYPES.map((t) => t.key));
    const typeKeys = Array.isArray(types) ? [...new Set(types.map(String))] : [];
    if (!typeKeys.length || typeKeys.some((k) => !known.has(k))) return sendJson(res, 400, { error: 'Pilih minimal satu jenis dokumen yang valid.' });
    if (excel === false && !csv) return sendJson(res, 400, { error: 'Pilih minimal satu format (Excel atau CSV resmi).' });
    let masaList;
    try { masaList = masaLib.parseMasaListInput(masaInput); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;

    try { runcontrol.start('Download e-Faktur · ' + typeKeys.length + ' jenis · ' + target.label, target.session); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        const page = await target.open();
        await efaktur.runDownloadEfaktur({ page, types: typeKeys, masaList, excel: excel !== false, csv: !!csv, saveRoot, entityFolder: target.folder, entityName: target.label, emit: (m) => log(m) });
    } catch (e) {
        log('Gagal download e-Faktur: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

/** Pajak Masukan - pengkreditan per baris Excel. Entitas+PIC (login otomatis) atau sesi manual. */
async function handleImportPajakMasukan(req, res) {
    let body;
    try { body = await readLargeJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message || 'Body tidak valid.' }); }
    const { entity, fileBase64, targetMasaInput } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!fileBase64) return sendJson(res, 400, { error: 'File template belum dipilih.' });
    if (targetMasaInput && !/^(0[1-9]|1[0-2])\d{2}$/.test(String(targetMasaInput).trim())) {
        return sendJson(res, 400, { error: 'Masa Pengkreditan harus berformat MMYY, misalnya 0726.' });
    }

    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    const target = await prepareEntityPage(res, entity);
    if (!target) return;

    try { runcontrol.start('Impor Pajak Masukan' + (targetMasaInput ? ' · Masa ' + String(targetMasaInput).trim() : '') + ' · ' + target.label, target.session); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        const page = await target.open();
        await pajakMasukan.runImportFromExcel({ page, fileBuffer, targetMasaInput: targetMasaInput ? String(targetMasaInput).trim() : '', dryRun: false, emit: (m) => log(m) });
    } catch (e) {
        log('Gagal impor Pajak Masukan: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleImportDividen(req, res) {
    let body;
    try { body = await readLargeJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message || 'Body tidak valid.' }); }
    const { fileBase64 } = body || {};
    if (!fileBase64) return sendJson(res, 400, { error: 'File template belum dipilih.' });

    const manualPage = chrome.getManualPage();
    if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Coretax" dan login dulu, lalu buka kasus e-Reporting.' });

    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    try { runcontrol.start('Impor Dividen · Sesi Manual', MANUAL_SESSION); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runDividenImport({ manualPage, fileBuffer });
    } catch (e) {
        if (e && e.validation) { /* already logged the per-row problems */ }
        else if (e && e.isStop) log('Impor dihentikan oleh pengguna.');
        else log('Gagal impor Dividen: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleCheckDividen(req, res) {
    let body;
    try { body = await readLargeJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message || 'Body tidak valid.' }); }
    const { fileBase64 } = body || {};
    if (!fileBase64) return sendJson(res, 400, { error: 'File pembanding belum dipilih.' });

    const manualPage = chrome.getManualPage();
    if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Coretax" dan login dulu, lalu buka kasus e-Reporting.' });

    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    try { runcontrol.start('Cek Hasil Dividen · Sesi Manual', MANUAL_SESSION); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runDividenCheck({ manualPage, fileBuffer });
    } catch (e) {
        if (e && e.isStop) log('Cek Hasil dihentikan oleh pengguna.');
        else log('Gagal Cek Hasil: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleCreateDividenCase(req, res) {
    const manualPage = chrome.getManualPage();
    if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Coretax" dan login dulu.' });

    try { runcontrol.start('Buat Kasus Dividen · Sesi Manual', MANUAL_SESSION); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await openNewCase(manualPage);
    } catch (e) {
        log('Gagal membuat kasus baru: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleLoginEntity(req, res) {
    if (rejectIfOutdated(res)) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (entity.project === 'manual') return sendJson(res, 400, { error: 'Sesi manual sudah login sendiri - tombol ini khusus entitas dengan login otomatis.' });
    const src = await resolveEntitySource(res, entity);
    if (!src) return;

    try { runcontrol.start('Login Coretax · ' + src.label, sessionOf(src)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true, session: runSessionKey() });
    try {
        await runLoginOnly({
            client: src.client, orgId: src.orgId, entity: src.entity, picId: src.picId,
            restricted: src.restricted, allowedEbupotSections: src.allowedEbupotSections, passphrase: src.passphrase
        });
    } catch (e) {
        if (e && e.isStop) log('Login dibatalkan oleh pengguna.');
        else log('Gagal login: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

/** Receives a taxio-coretax:// URL forwarded from a SECOND process launch (see main.js's
 *  forwardDeepLinkToRunningInstance) - this instance already owns the dashboard window, so it
 *  just dispatches the link itself instead of the caller trying to become its own primary. Acks
 *  immediately (fire-and-forget, same as the download/login routes) since dispatch can run for
 *  minutes. */
async function handleDeepLink(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    if (!body || !body.url) return sendJson(res, 400, { error: 'URL kosong.' });
    sendJson(res, 202, { received: true });
    // A click from Taxio/Taxio.me arrives here whenever Coretax Agent is ALREADY running in the
    // background (this is the forwarded-to-primary-instance path - see main.js's
    // forwardDeepLinkToRunningInstance). Previously that ran the automation with no window ever
    // shown, so the user had no way to see what it was doing. Bring the dashboard up so the log
    // is visible, same as a cold start via the same link already does (main.js calls openWindow
    // unconditionally there). `req.headers.host` is this same server's own host:port - no need
    // to hardcode GUI_PORT here. Goes through the serializing queue (not a raw isWindowOpen/
    // openWindow check) - see ensureWindowOpenOrFocused()'s header comment for why: rapid
    // back-to-back clicks from Taxio each hitting this handler concurrently used to race past
    // the check and each spawn their own window.
    await ensureWindowOpenOrFocused('http://' + req.headers.host + '/');
    deeplink.dispatch(body.url).catch((e) => log('Deep link gagal: ' + e.message));
}

async function handleOpenCoretaxManual(req, res) {
    if (rejectIfOutdated(res)) return;
    const connectedIds = state.connectedProjectIds();
    if (!connectedIds.length) return sendJson(res, 401, { error: 'Harus terhubung ke setidaknya satu akun Taxio/Taxio.me sebelum membuka Coretax manual.' });
    
    let restricted = false;
    for (const id of connectedIds) {
        if (isProjectRestricted(id)) {
            restricted = true;
            break;
        }
    }

    if (restricted) {
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
    closeWindow(); // window is spawned detached+unref'd - survives process.exit() below on its own otherwise
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
async function handleCheckUpdate(req, res) {
    const info = await updater.checkForUpdate();
    sendJson(res, 200, info);
    if (info.available) {
        updater.checkAndApply({
            isRunActive: () => runcontrol.anyActive(),
            onBeforeRestart: async () => {
                try { await fetch('http://' + req.headers.host + '/api/quit', { method: 'POST' }); } catch (e) {}
            }
        }).catch((e) => log('Gagal menerapkan update: ' + e.message));
    }
}

async function handleTrayOpen(req, res) {
    sendJson(res, 200, { ok: true });
    // Serializing queue, same reason as handleDeepLink above.
    await ensureWindowOpenOrFocused('http://' + req.headers.host + '/');
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

const { exec: execChild } = require('child_process');

// Escape a value for safe embedding inside a PowerShell single-quoted string literal: the only
// metacharacter that matters there is the single quote itself, escaped by doubling it. Without
// this, a `'` in title/filter would break out of the quotes and inject arbitrary PowerShell.
function psSingleQuote(s) { return String(s == null ? '' : s).replace(/'/g, "''"); }

function nativePickFile(title, filter) {
    return new Promise((resolve) => {
        const psScript = `[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = '${psSingleQuote(title || 'Pilih File')}'; $f.Filter = '${psSingleQuote(filter || 'Semua File (*.*)|*.*')}'; $f.ShowHelp = $false; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }; $top.Dispose()`;
        execChild(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { windowsHide: true }, (err, stdout) => {
            if (err || !stdout) resolve(null);
            else resolve(stdout.trim());
        });
    });
}

function nativePickFolder(title) {
    return new Promise((resolve) => {
        const psScript = `[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${psSingleQuote(title || 'Pilih Folder')}'; $f.ShowNewFolderButton = $true; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }; $top.Dispose()`;
        execChild(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { windowsHide: true }, (err, stdout) => {
            if (err || !stdout) resolve(null);
            else resolve(stdout.trim());
        });
    });
}

async function handlePickFile(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { }
    const filePath = await nativePickFile(body.title, body.filter);
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
    const folderPath = await nativePickFolder(body.title);
    if (!folderPath) return sendJson(res, 200, { canceled: true });
    return sendJson(res, 200, { folderPath });
}

function createGuiServer(port) {
    const server = http.createServer((req, res) => runcontrol.isolate(() => route(req, res)));
    function route(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const { pathname } = url;
        const sess = url.searchParams.get('session') || null;
        try {
            if (req.method === 'POST' && isForeignOrigin(req)) {
                log('[SECURITY] Permintaan POST ' + pathname + ' ditolak - Origin asing: ' + req.headers.origin);
                return sendJson(res, 403, { error: 'Ditolak: permintaan lintas-origin tidak diizinkan.' });
            }
            if (pathname === '/events' && req.method === 'GET') return handleEvents(req, res);
            if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, sessionSummary());
            if (pathname === '/api/version' && req.method === 'GET') return sendJson(res, 200, Object.assign({ version: pkg.version }, updater.getOutdatedInfo()));
            if (pathname === '/api/connect' && req.method === 'POST') return handleConnect(req, res);
            if (pathname === '/api/disconnect' && req.method === 'POST') return handleDisconnect(req, res);
            if (pathname === '/api/entities' && req.method === 'GET') return handleEntities(req, res, url.searchParams.get('mode'));
            if (pathname === '/api/signup' && req.method === 'POST') return handleSignup(req, res);
            if (pathname === '/api/registration/check' && req.method === 'POST') return handleRegistrationCheck(req, res);
            if (pathname === '/api/registration/initial' && req.method === 'POST') return handleRegistrationInitial(req, res);
            if (pathname === '/api/local-entities' && req.method === 'GET') return handleLocalEntities(req, res);
            if (pathname === '/api/local-entities/save' && req.method === 'POST') return handleLocalEntitySave(req, res);
            if (pathname === '/api/local-entities/delete' && req.method === 'POST') return handleLocalEntityDelete(req, res);
            if (pathname === '/api/actions/billing-pph25' && req.method === 'POST') return handleBillingPph25(req, res);
            if (pathname === '/api/actions/download-ebupot' && req.method === 'POST') return handleDownloadEbupot(req, res);
            if (pathname === '/api/actions/download-mybupot' && req.method === 'POST') return handleDownloadMyBupot(req, res);
            if (pathname === '/api/actions/download-spt' && req.method === 'POST') return handleDownloadSpt(req, res);
            if (pathname === '/api/actions/import-pajak-masukan' && req.method === 'POST') return handleImportPajakMasukan(req, res);
            if (pathname === '/api/actions/download-pajak-masukan' && req.method === 'POST') return handleDownloadPajakMasukan(req, res);
            if (pathname === '/api/actions/download-efaktur' && req.method === 'POST') return handleDownloadEfaktur(req, res);
            if (pathname === '/api/actions/import-dividen' && req.method === 'POST') return handleImportDividen(req, res);
            if (pathname === '/api/actions/check-dividen' && req.method === 'POST') return handleCheckDividen(req, res);
            if (pathname === '/api/actions/create-dividen-case' && req.method === 'POST') return handleCreateDividenCase(req, res);
            if (pathname === '/api/actions/login-entity' && req.method === 'POST') return handleLoginEntity(req, res);
            if (pathname === '/api/login/status' && req.method === 'GET') return sendJson(res, 200, loginStatus.get() || { at: 0 });
            if (pathname === '/api/actions/pick-file' && req.method === 'POST') return handlePickFile(req, res);
            if (pathname === '/api/actions/pick-folder' && req.method === 'POST') return handlePickFolder(req, res);
            if (pathname === '/api/actions/open-coretax' && req.method === 'POST') return handleOpenCoretaxManual(req, res);
            if (pathname === '/api/deeplink' && req.method === 'POST') return handleDeepLink(req, res);
            if (pathname === '/api/manual/status' && req.method === 'GET') return handleManualStatus(req, res);
            if (pathname === '/api/session/status' && req.method === 'POST') return handleSessionStatus(req, res);
            if (pathname === '/api/sessions/list' && req.method === 'GET') return handleSessionsList(req, res);
            if (pathname === '/api/sessions/front' && req.method === 'POST') return handleSessionFront(req, res);
            if (pathname === '/api/sessions/close' && req.method === 'POST') return handleSessionClose(req, res);
            if (pathname === '/api/run/status' && req.method === 'GET') return sendJson(res, 200, runcontrol.status(sess));
            if (pathname === '/api/run/pause' && req.method === 'POST') { runcontrol.pause(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/resume' && req.method === 'POST') { runcontrol.resume(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/skip' && req.method === 'POST') { runcontrol.skip(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/retry' && req.method === 'POST') { runcontrol.retry(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/back' && req.method === 'POST') { runcontrol.back(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/stop' && req.method === 'POST') { runcontrol.stop(sess); return sendJson(res, 200, runcontrol.status(sess)); }
            if (pathname === '/api/run/pagesize' && req.method === 'POST') {
                return readJsonBody(req).then((b) => { const n = Number(b && b.size); if ([10, 25, 50, 100].includes(n)) runcontrol.setPageSizeOverride(n, sess); return sendJson(res, 200, runcontrol.status(sess)); }).catch(() => sendJson(res, 400, { error: 'Body tidak valid.' }));
            }
            if (pathname === '/api/quit' && req.method === 'POST') return handleQuit(req, res);
            if (pathname === '/api/check-update' && req.method === 'POST') return handleCheckUpdate(req, res);
            if (pathname === '/api/tray/open' && req.method === 'POST') return handleTrayOpen(req, res);
            if (pathname === '/api/log/clear' && req.method === 'POST') return handleClearLog(req, res);
            if (pathname === '/api/notices/ack' && req.method === 'POST') { ackNotice(url.searchParams.get('id') || 'all'); return sendJson(res, 200, { ok: true }); }
            return serveStatic(req, res, pathname);
        } catch (e) {
            log('GUI server error: ' + e.message);
            sendJson(res, 500, { error: e.message });
        }
    }
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { createGuiServer };
