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
const { log, onLogLine, LOG_FILE } = require('../lib/log');
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
function isEbupotTypeAllowed(allowedSections, bupotType) {
    if (!allowedSections) return true; // not configured yet - matches the admin panel's own "unset = all checked" default
    const section = EBUPOT_TYPE_TO_SECTION[bupotType];
    if (!section) return true; // no configurable section for this type (e.g. bpa1/bpa2/bpatc) - nothing to gate against
    return allowedSections.includes(section);
}
function isMyBupotAllowed(allowedSections) {
    if (!allowedSections) return true;
    return allowedSections.includes('my-withholding-slips');
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
        out[projectId] = conn && state.isConnected(projectId)
            ? { connected: true, label: PROJECTS[projectId].label, email: conn.user.email, role: restricted ? 'restricted_editor' : conn.role }
            : { connected: false, label: PROJECTS[projectId].label };
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
        const { client, project: proj, session, user } = await sessionStore.connectWithPassword(project, email, password);
        const membership = await entitiesLib.getMyOrgId(client, user.id);
        state.set(project, { client, project: proj, session, user, orgId: membership.org_id, role: membership.role, membership });
        log('Terhubung sebagai ' + user.email + ' (' + proj.label + ').');
        return sendJson(res, 200, sessionSummary());
    } catch (e) {
        log('Gagal terhubung (' + PROJECTS[project].label + '): ' + e.message);
        return sendJson(res, 400, { error: e.message });
    }
}

async function handleDisconnect(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { body = {}; }
    const projectId = body && body.project;
    if (!PROJECTS[projectId]) return sendJson(res, 400, { error: 'Project tidak dikenal.' });
    const conn = state.get(projectId);
    if (conn) await sessionStore.disconnect(conn.client);
    state.clear(projectId);
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
    all.sort((a, b) => a.entity_name.localeCompare(b.entity_name));
    return sendJson(res, 200, { entities: all, errors });
}

async function handleManualStatus(req, res) {
    try { return sendJson(res, 200, await chrome.getManualStatus()); }
    catch (e) { return sendJson(res, 200, { open: false, loggedIn: false, identity: '' }); }
}

function sanitizeFolder(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'Manual'; }

async function handleDownloadEbupot(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!bupotType || !masaInput) return sendJson(res, 400, { error: 'Jenis bupot & masa wajib diisi.' });

    const isManual = entity.project === 'manual';
    let runOpts;
    if (isManual) {
        const manualPage = chrome.getManualPage();
        if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Manual" dan login dulu.' });
        const folder = sanitizeFolder(entity.entity_name || 'Manual');
        runOpts = { manualPage, entity: { entity_id: folder, entity_name: entity.entity_name || 'Sesi Manual', npwp: '', individual: false }, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode };
    } else {
        if (!entity.entity_id || !entity.pic_id) return sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' });
        const s = state.get(entity.project);
        if (!s || !state.isConnected(entity.project)) return sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' });
        await sessionStore.refreshIfNeeded(s.client);
        const restricted = isProjectRestricted(entity.project);
        const allowedEbupotSections = (s.membership && s.membership.allowed_ebupot_sections) || null;
        if (restricted && !isEbupotTypeAllowed(allowedEbupotSections, bupotType)) {
            return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengunduh jenis e-Bupot ini.' });
        }
        const passphrase = await entitiesLib.getPassphrase(s.client, s.orgId, entity.pic_id).catch(() => null);
        runOpts = {
            client: s.client, orgId: s.orgId, currentUserId: s.user.id,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode,
            restricted, allowedEbupotSections, passphrase
        };
    }

    // Only one automation run at a time - the run-control (pause/skip/stop) model is built
    // around a single active run, and two runs would fight over the same Chrome window anyway.
    try { runcontrol.start('e-Bupot ' + bupotType.toUpperCase() + ' · ' + (isManual ? 'Sesi Manual' : entity.entity_name)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    // Fire-and-forget: the run streams its own progress over /events. Respond immediately so
    // the GUI isn't blocked on a request that can legitimately take many minutes.
    sendJson(res, 202, { started: true });
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
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!Array.isArray(buktiTypeKeys) || !buktiTypeKeys.length || !masaInput) return sendJson(res, 400, { error: 'Jenis bukti potong & masa wajib diisi.' });

    const isManual = entity.project === 'manual';
    let runOpts;
    if (isManual) {
        const manualPage = chrome.getManualPage();
        if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Manual" dan login dulu.' });
        const folder = sanitizeFolder(entity.entity_name || 'Manual');
        runOpts = { manualPage, entity: { entity_id: folder, entity_name: entity.entity_name || 'Sesi Manual', npwp: '', individual: false }, buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode };
    } else {
        if (!entity.entity_id || !entity.pic_id) return sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' });
        const s = state.get(entity.project);
        if (!s || !state.isConnected(entity.project)) return sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' });
        await sessionStore.refreshIfNeeded(s.client);
        const restricted = isProjectRestricted(entity.project);
        const allowedEbupotSections = (s.membership && s.membership.allowed_ebupot_sections) || null;
        if (restricted && !isMyBupotAllowed(allowedEbupotSections)) {
            return sendJson(res, 403, { error: 'Restricted Editor tidak diizinkan mengakses Bukti Potong Saya.' });
        }
        const passphrase = await entitiesLib.getPassphrase(s.client, s.orgId, entity.pic_id).catch(() => null);
        runOpts = {
            client: s.client, orgId: s.orgId, currentUserId: s.user.id,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, buktiTypeKeys, masaInput, saveRoot, pageSize, outputMode,
            restricted, allowedEbupotSections, passphrase
        };
    }

    try { runcontrol.start('Bukti Potong Saya · ' + (isManual ? 'Sesi Manual' : entity.entity_name)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
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
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity, jenisPajakKeys, masaInput, saveRoot } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (!Array.isArray(jenisPajakKeys) || !jenisPajakKeys.length || !masaInput) return sendJson(res, 400, { error: 'Jenis pajak & masa wajib diisi.' });

    const isManual = entity.project === 'manual';
    let runOpts;
    if (isManual) {
        const manualPage = chrome.getManualPage();
        if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Manual" dan login dulu.' });
        const folder = sanitizeFolder(entity.entity_name || 'Manual');
        runOpts = { manualPage, entity: { entity_id: folder, entity_name: entity.entity_name || 'Sesi Manual', npwp: '', individual: false }, jenisPajakKeys, masaInput, saveRoot };
    } else {
        if (!entity.entity_id || !entity.pic_id) return sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' });
        const s = state.get(entity.project);
        if (!s || !state.isConnected(entity.project)) return sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' });
        await sessionStore.refreshIfNeeded(s.client);
        const restricted = isProjectRestricted(entity.project);
        const allowedEbupotSections = (s.membership && s.membership.allowed_ebupot_sections) || null;
        const passphrase = await entitiesLib.getPassphrase(s.client, s.orgId, entity.pic_id).catch(() => null);
        // Entitas dengan >1 PIC tertaut (mis. Dion Farma Abadi - Fredi Setyawan & Ronald Tony):
        // SPT cuma bisa digenerate sesuai penandatangan aslinya, jadi kasih tau runSptDownload
        // PIC lain yang tertaut ke entitas ini supaya baris yang gagal di PIC terpilih otomatis
        // dicoba ulang di bawah PIC lain itu sebelum benar-benar menyerah.
        const fallbackPicIds = await entitiesLib.getOtherLinkedPicIds(s.client, s.orgId, entity.entity_id, entity.pic_id);
        runOpts = {
            client: s.client, orgId: s.orgId,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, jenisPajakKeys, masaInput, saveRoot,
            restricted, allowedEbupotSections, passphrase, fallbackPicIds
        };
    }

    try { runcontrol.start('SPT ' + jenisPajakKeys.join('+') + ' · ' + (isManual ? 'Sesi Manual' : entity.entity_name)); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
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

async function handleImportDividen(req, res) {
    let body;
    try { body = await readLargeJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message || 'Body tidak valid.' }); }
    const { fileBase64 } = body || {};
    if (!fileBase64) return sendJson(res, 400, { error: 'File template belum dipilih.' });

    const manualPage = chrome.getManualPage();
    if (!manualPage) return sendJson(res, 401, { error: 'Sesi manual belum ada - klik "Login Coretax" dan login dulu, lalu buka kasus e-Reporting.' });

    let fileBuffer;
    try { fileBuffer = Buffer.from(fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'File tidak bisa dibaca.' }); }

    try { runcontrol.start('Impor Dividen · Sesi Manual'); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
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

    try { runcontrol.start('Cek Hasil Dividen · Sesi Manual'); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
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

    try { runcontrol.start('Buat Kasus Dividen · Sesi Manual'); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
    try {
        await openNewCase(manualPage);
    } catch (e) {
        log('Gagal membuat kasus baru: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

async function handleLoginEntity(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Body tidak valid.' }); }
    const { entity } = body || {};
    if (!entity || !entity.project) return sendJson(res, 400, { error: 'Entitas belum dipilih.' });
    if (entity.project === 'manual') return sendJson(res, 400, { error: 'Sesi manual sudah login sendiri - tombol ini khusus untuk entitas Taxio Hub.' });
    if (!entity.entity_id || !entity.pic_id) return sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' });
    const s = state.get(entity.project);
    if (!s || !state.isConnected(entity.project)) return sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' });
    await sessionStore.refreshIfNeeded(s.client);
    const restricted = isProjectRestricted(entity.project);
    const allowedEbupotSections = (s.membership && s.membership.allowed_ebupot_sections) || null;
    const passphrase = await entitiesLib.getPassphrase(s.client, s.orgId, entity.pic_id).catch(() => null);

    try { runcontrol.start('Login Coretax · ' + entity.entity_name); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
    try {
        await runLoginOnly({
            client: s.client, orgId: s.orgId,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, restricted, allowedEbupotSections, passphrase
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

    sendJson(res, 202, { started: true });
    chrome.openCoretaxManual(false, null).catch((e) => log('Gagal membuka Coretax manual: ' + e.message));
}

async function handleQuit(req, res) {
    sendJson(res, 200, { ok: true });
    log('Menutup Coretax Agent...');
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
            isRunActive: () => runcontrol.status().active,
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
    for (const entry of logBacklog) res.write('data: ' + JSON.stringify(entry) + '\n\n');
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
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const { pathname } = url;
        try {
            if (req.method === 'POST' && isForeignOrigin(req)) {
                log('[SECURITY] Permintaan POST ' + pathname + ' ditolak - Origin asing: ' + req.headers.origin);
                return sendJson(res, 403, { error: 'Ditolak: permintaan lintas-origin tidak diizinkan.' });
            }
            if (pathname === '/events' && req.method === 'GET') return handleEvents(req, res);
            if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, sessionSummary());
            if (pathname === '/api/version' && req.method === 'GET') return sendJson(res, 200, { version: pkg.version });
            if (pathname === '/api/connect' && req.method === 'POST') return handleConnect(req, res);
            if (pathname === '/api/disconnect' && req.method === 'POST') return handleDisconnect(req, res);
            if (pathname === '/api/entities' && req.method === 'GET') return handleEntities(req, res, url.searchParams.get('mode'));
            if (pathname === '/api/actions/download-ebupot' && req.method === 'POST') return handleDownloadEbupot(req, res);
            if (pathname === '/api/actions/download-mybupot' && req.method === 'POST') return handleDownloadMyBupot(req, res);
            if (pathname === '/api/actions/download-spt' && req.method === 'POST') return handleDownloadSpt(req, res);
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
            if (pathname === '/api/run/status' && req.method === 'GET') return sendJson(res, 200, runcontrol.status());
            if (pathname === '/api/run/pause' && req.method === 'POST') { runcontrol.pause(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/resume' && req.method === 'POST') { runcontrol.resume(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/skip' && req.method === 'POST') { runcontrol.skip(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/retry' && req.method === 'POST') { runcontrol.retry(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/back' && req.method === 'POST') { runcontrol.back(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/stop' && req.method === 'POST') { runcontrol.stop(); return sendJson(res, 200, runcontrol.status()); }
            if (pathname === '/api/run/pagesize' && req.method === 'POST') {
                return readJsonBody(req).then((b) => { const n = Number(b && b.size); if ([10, 25, 50, 100].includes(n)) runcontrol.setPageSizeOverride(n); return sendJson(res, 200, runcontrol.status()); }).catch(() => sendJson(res, 400, { error: 'Body tidak valid.' }));
            }
            if (pathname === '/api/quit' && req.method === 'POST') return handleQuit(req, res);
            if (pathname === '/api/check-update' && req.method === 'POST') return handleCheckUpdate(req, res);
            if (pathname === '/api/tray/open' && req.method === 'POST') return handleTrayOpen(req, res);
            if (pathname === '/api/log/clear' && req.method === 'POST') return handleClearLog(req, res);
            return serveStatic(req, res, pathname);
        } catch (e) {
            log('GUI server error: ' + e.message);
            sendJson(res, 500, { error: e.message });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { createGuiServer };
