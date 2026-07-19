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
const { log, onLogLine } = require('../lib/log');
const state = require('../lib/state');
const sessionStore = require('../lib/session-store');
const entitiesLib = require('../lib/entities');
const PROJECTS = require('../lib/supabase-projects');
const runcontrol = require('../lib/runcontrol');
const chrome = require('../lib/chrome');
const loginStatus = require('../lib/login-status');
const { runEbupotDownload } = require('../automation/ebupot');
const { runLoginOnly } = require('../automation/login');
const { runSptDownload } = require('../automation/spt');
const { runDividenImport, runDividenCheck, openNewCase } = require('../automation/dividen');
const deeplink = require('../lib/deeplink');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

// Only Taxio.me's coretax_pics has the personal-ownership owner_user_id column
// (schema_phase10.sql) - Taxio (Grup)'s coretax_pics is still org-shared.
const PROJECTS_WITH_OWNER_COLUMN = { personal: true };

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

function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(buf);
    });
}

function sessionSummary() {
    const out = {};
    for (const projectId of Object.keys(PROJECTS)) {
        const conn = state.get(projectId);
        out[projectId] = conn && state.isConnected(projectId)
            ? { connected: true, label: PROJECTS[projectId].label, email: conn.user.email, role: conn.role }
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
        state.set(project, { client, project: proj, session, user, orgId: membership.org_id, role: membership.role });
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

async function handleEntities(req, res) {
    const connectedIds = state.connectedProjectIds();
    if (!connectedIds.length) return sendJson(res, 401, { error: 'Belum terhubung ke akun manapun.' });
    const all = [];
    const errors = [];
    for (const projectId of connectedIds) {
        const s = state.get(projectId);
        try {
            const hasOwnerColumn = !!PROJECTS_WITH_OWNER_COLUMN[projectId];
            const list = await entitiesLib.listAutomatableEntities(s.client, s.orgId, s.user.id, hasOwnerColumn);
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
        runOpts = {
            client: s.client, orgId: s.orgId, currentUserId: s.user.id,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, bupotType, masaInput, kodeInput, saveRoot, pageSize, outputMode
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
        runOpts = {
            client: s.client, orgId: s.orgId,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id, jenisPajakKeys, masaInput, saveRoot
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
    if (entity.project === 'manual') return sendJson(res, 400, { error: 'Sesi manual sudah login sendiri - tombol ini untuk entitas Taxio/Taxio.me.' });
    if (!entity.entity_id || !entity.pic_id) return sendJson(res, 400, { error: 'Entitas/PIC belum dipilih.' });
    const s = state.get(entity.project);
    if (!s || !state.isConnected(entity.project)) return sendJson(res, 401, { error: 'Belum terhubung ke ' + (PROJECTS[entity.project] || {}).label + '.' });
    await sessionStore.refreshIfNeeded(s.client);

    try { runcontrol.start('Login Coretax · ' + entity.entity_name); }
    catch (e) { return sendJson(res, 409, { error: e.message }); }
    sendJson(res, 202, { started: true });
    try {
        await runLoginOnly({
            client: s.client, orgId: s.orgId,
            entity: { entity_id: entity.entity_id, entity_name: entity.entity_name, npwp: entity.npwp, individual: entity.individual },
            picId: entity.pic_id
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
    deeplink.dispatch(body.url).catch((e) => log('Deep link gagal: ' + e.message));
}

async function handleOpenCoretaxManual(req, res) {
    // No account needed - just opens a plain Coretax window for the user to log in by hand.
    sendJson(res, 202, { started: true });
    chrome.openCoretaxManual().catch((e) => log('Gagal membuka Coretax manual: ' + e.message));
}

async function handleQuit(req, res) {
    sendJson(res, 200, { ok: true });
    log('Menutup Coretax Agent...');
    setTimeout(() => process.exit(0), 300);
}

function handleEvents(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    for (const entry of logBacklog) res.write('data: ' + JSON.stringify(entry) + '\n\n');
    const unsubscribe = onLogLine((entry) => { try { res.write('data: ' + JSON.stringify(entry) + '\n\n'); } catch (e) {} });
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
}

function createGuiServer(port) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const { pathname } = url;
        try {
            if (pathname === '/events' && req.method === 'GET') return handleEvents(req, res);
            if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, sessionSummary());
            if (pathname === '/api/connect' && req.method === 'POST') return handleConnect(req, res);
            if (pathname === '/api/disconnect' && req.method === 'POST') return handleDisconnect(req, res);
            if (pathname === '/api/entities' && req.method === 'GET') return handleEntities(req, res);
            if (pathname === '/api/actions/download-ebupot' && req.method === 'POST') return handleDownloadEbupot(req, res);
            if (pathname === '/api/actions/download-spt' && req.method === 'POST') return handleDownloadSpt(req, res);
            if (pathname === '/api/actions/import-dividen' && req.method === 'POST') return handleImportDividen(req, res);
            if (pathname === '/api/actions/check-dividen' && req.method === 'POST') return handleCheckDividen(req, res);
            if (pathname === '/api/actions/create-dividen-case' && req.method === 'POST') return handleCreateDividenCase(req, res);
            if (pathname === '/api/actions/login-entity' && req.method === 'POST') return handleLoginEntity(req, res);
            if (pathname === '/api/login/status' && req.method === 'GET') return sendJson(res, 200, loginStatus.get() || { at: 0 });
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
