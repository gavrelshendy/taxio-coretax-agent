/* Pemeriksaan sistem ("Pemeriksaan sistem" di Pengaturan dashboard, GET /api/health, dan sekali di latar
 * setelah start - main.js mencatat hanya baris warn/fail). Tujuannya: di PC orang lain, masalah yang
 * biasanya baru ketahuan di tengah otomasi (folder tidak bisa ditulis, disk penuh sebelum Chrome bawaan
 * terunduh, proxy kantor, jam PC meleset sehingga token login ditolak, PowerShell diblokir kebijakan)
 * tampil sejak awal, dengan saran perbaikannya.
 *
 * Tiap pemeriksaan independen dan berbentuk { id, label, status: 'ok'|'warn'|'fail', detail, fix }
 * (bahasa Indonesia), punya batas waktunya sendiri, dan TIDAK PERNAH melempar - galat / waktu habis
 * menjadi status warn/fail pemeriksaan itu saja. Semua ketergantungan (fetch, fs, proxy, PowerShell,
 * info server, info versi) bisa disuntik lewat runChecks({ deps }) - tes tidak pernah menyentuh jaringan.
 * HTTP keluar lewat lib/net.js: di aplikasi desktop itu net.fetch Electron (mengikuti proxy/PAC Windows);
 * di mode headless (tes, `node main.js`) fetch Node, yang tidak - pemeriksaan proxy membedakan keduanya. */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const CORETAX_URL = 'https://coretaxdjp.pajak.go.id/';
const CLOCK_WARN_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const NETWORK_TIMEOUT_MS = 10000;
// Chrome bawaan: zip ±185 MB + hasil ekstrak ±450 MB, sementara bersamaan.
const CHROME_NEED_BYTES = 700 * 1024 * 1024;
const LOW_DISK_BYTES = 1024 * 1024 * 1024;

const GB = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';

function defaultDeps() {
    return {
        fetch: (url, init) => require('./net').fetch(url, init),
        root: () => paths.root(),
        statfs: (p) => fs.statfsSync(p),
        writeProbe: (dir) => {
            fs.mkdirSync(dir, { recursive: true });
            const f = path.join(dir, '.cek-tulis-' + process.pid);
            fs.writeFileSync(f, 'ok');
            fs.rmSync(f, { force: true });
        },
        browser: () => {
            const b = require('./browser');
            return { disabled: process.env.CORETAX_BUNDLED_CHROME === '0', ready: b.isReady(), version: b.VERSION, dir: b.ROOT };
        },
        installedChrome: () => {
            const cands = [
                process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
                process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
            ].filter(Boolean);
            return cands.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
        },
        proxy: () => require('./win-proxy').read(),
        // Aplikasi desktop (electron/main.js) memasang net.fetch Electron = proxy/PAC sistem diikuti.
        proxyHonoured: () => !require('./net').usingDefault(),
        hubUrl: () => { const p = require('./supabase-projects').taxio_hub; return { url: p.url, anonKey: p.anonKey }; },
        powershell: () => new Promise((resolve) => {
            if (process.platform !== 'win32') return resolve({ ok: false, error: 'not Windows' });
            require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
                { windowsHide: true, timeout: 7000 }, (err, stdout, stderr) => {
                    if (err) return resolve({ ok: false, error: String((stderr && String(stderr).trim()) || err.message).slice(0, 200) });
                    resolve({ ok: true, version: String(stdout || '').trim() });
                });
        }),
        versionInfo: () => {
            const u = require('./updater');
            return Object.assign({ current: u.currentVersion() }, u.getOutdatedInfo());
        },
        // Profil Chrome per PIC (lib/profile-housekeeping.js): jumlah + ukuran, dihitung dengan batas waktu.
        profiles: () => require('./profile-housekeeping').scan({ budgetMs: 6000 }),
        now: () => Date.now()
    };
}

function result(status, detail, fix) { return { status, detail: detail || '', fix: fix || '' }; }

/** Permintaan HTTP dengan batas waktu sendiri. Resolves { status, date } atau melempar. */
async function head(d, url, timeoutMs, headers) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        let res;
        // Redirects are followed (default): Electron's net.fetch rejects redirect:'manual' with "Redirect was
        // cancelled" (checked 2026-11-12), which would report a reachable host as unreachable.
        try { res = await d.fetch(url, { method: 'HEAD', headers: Object.assign({ 'User-Agent': 'taxio-pilot-doctor' }, headers || {}), signal: ac.signal }); }
        catch (e) { throw new Error(ac.signal.aborted ? 'did not respond within ' + Math.round(timeoutMs / 1000) + ' seconds' : ((e.cause && (e.cause.code || e.cause.message)) || e.message)); }
        const date = res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null;
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) { /* abaikan */ }
        return { status: res.status, date };
    } finally { clearTimeout(t); }
}

const NET_FIX = 'Check your internet connection. On an office network, ask the network admin to allow this address (Taxio Pilot uses the Windows proxy settings).';

const CHECKS = [
    { id: 'data-root', label: 'Data folder is writable', run: async (d) => {
        const root = d.root();
        try { d.writeProbe(root); return result('ok', root); }
        catch (e) { return result('fail', root + ': ' + (e.code || e.message), 'Make sure your Windows account can write to this folder (not blocked by antivirus or office policy), then reopen Taxio Pilot.'); }
    } },
    { id: 'disk', label: 'Disk space', run: async (d) => {
        const root = d.root();
        let target = root;
        while (target && !fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
        const st = d.statfs(target);
        const free = Number(st.bavail) * Number(st.bsize);
        const b = safe(() => d.browser(), {});
        const needChrome = !b.ready && !b.disabled;
        if (needChrome && free < CHROME_NEED_BYTES) return result('fail', GB(free) + ' free. The built-in Chrome needs about 0.7 GB to download and install.', 'Free up space on drive ' + path.parse(target).root + ', then reopen Taxio Pilot.');
        if (free < LOW_DISK_BYTES) return result('warn', GB(free) + ' free on ' + path.parse(target).root, 'Disk space is almost full; downloads and result files may fail to save.');
        return result('ok', GB(free) + ' free on ' + path.parse(target).root);
    } },
    { id: 'browser', label: 'Chrome for automation', run: async (d) => {
        const b = d.browser();
        const installed = d.installedChrome();
        if (b.ready) return result('ok', 'The built-in Taxio Pilot Chrome v' + b.version + ' is ready and will be used.');
        if (installed) return result(b.disabled ? 'ok' : 'warn', (b.disabled ? 'The built-in Chrome is turned off (CORETAX_BUNDLED_CHROME=0)' : 'The built-in Chrome is not ready yet') + '. Using the installed Chrome: ' + installed,
            b.disabled ? '' : 'The built-in Chrome downloads automatically in the background (about 185 MB). If it keeps failing, check your connection / proxy; meanwhile the installed Chrome is used.');
        return result('fail', 'The built-in Chrome is not ready and Google Chrome was not found on this PC.', 'Keep Taxio Pilot open and online until the built-in Chrome finishes downloading, or install Google Chrome.');
    } },
    { id: 'proxy', label: 'Windows proxy', run: async (d) => {
        const p = d.proxy();
        if (!p.known) return result('ok', 'Could not read the proxy settings (not Windows, or the registry is unreadable).');
        if (!p.enabled && !p.pac) return result('ok', 'No proxy in use.');
        const what = [p.enabled ? 'proxy ' + (p.server || '(no address)') : '', p.pac ? 'PAC script ' + p.pacUrl : ''].filter(Boolean).join(' + ');
        if (safe(() => d.proxyHonoured(), false)) {
            return result('ok', 'Windows uses ' + what + '. The automation Chrome and Taxio Pilot\'s own connections (Taxio Hub, updates) follow it.');
        }
        return result('warn', 'Windows uses ' + what + '. The automation Chrome follows it, but Taxio Pilot\'s own connections do not in this mode (no window / development).',
            'Run Taxio Pilot from its shortcut (the desktop app follows the Windows proxy). If Taxio Hub / updates still fail to connect, ask the network admin to allow *.supabase.co and github.com.');
    } },
    { id: 'coretax', label: 'Coretax DJP reachable', network: true, run: async (d) => {
        try { const r = await head(d, CORETAX_URL, NETWORK_TIMEOUT_MS - 500); return result('ok', 'coretaxdjp.pajak.go.id responded (HTTP ' + r.status + ').'); }
        catch (e) { return result('fail', 'coretaxdjp.pajak.go.id is unreachable: ' + e.message, NET_FIX); }
    } },
    { id: 'hub', label: 'Taxio Hub reachable', network: true, run: async (d) => {
        const h = d.hubUrl();
        try { const r = await head(d, h.url + '/auth/v1/health', NETWORK_TIMEOUT_MS - 500, { apikey: h.anonKey }); return result('ok', new URL(h.url).host + ' responded (HTTP ' + r.status + ').'); }
        catch (e) { return result('fail', 'Taxio Hub is unreachable: ' + e.message, NET_FIX); }
    } },
    { id: 'clock', label: 'PC clock', network: true, run: async (d) => {
        const h = d.hubUrl();
        let r = null, lastErr = null;
        for (const url of [h.url + '/auth/v1/health', CORETAX_URL]) {
            try { r = await head(d, url, 4500, url.startsWith(h.url) ? { apikey: h.anonKey } : {}); if (r.date) break; }
            catch (e) { lastErr = e; }
        }
        const server = r && r.date ? Date.parse(r.date) : NaN;
        if (!Number.isFinite(server)) return result('warn', 'Could not compare the clock (' + (lastErr ? lastErr.message : 'the server did not send a time') + ').', '');
        const skew = d.now() - server;
        const secs = Math.round(Math.abs(skew) / 1000);
        const human = secs >= 120 ? Math.round(secs / 60) + ' minutes' : secs + ' seconds';
        if (Math.abs(skew) > CLOCK_WARN_MS) return result('warn', 'The PC clock is ' + human + ' ' + (skew > 0 ? 'ahead of' : 'behind') + ' the server clock.',
            'Taxio Hub / Coretax login can be rejected when the clock is off. Open Windows Settings > Time & language > turn on "Set time automatically", then click "Sync now".');
        return result('ok', 'Within ' + human + ' of the server clock.');
    } },
    { id: 'powershell', label: 'PowerShell', run: async (d) => {
        const r = await d.powershell();
        if (r.ok) return result('ok', 'PowerShell ' + (r.version || '') + ' can run.');
        return result('warn', 'PowerShell cannot run: ' + (r.error || ''), 'PowerShell is used to bring the Coretax window to the front and close leftover Chrome windows. Ask your IT admin to allow powershell.exe for this account.');
    } },
    { id: 'port', label: 'Dashboard port and token', run: async (d, ctx) => {
        const s = ctx.server;
        if (!s || !s.port) return result('warn', 'Server info is not available yet.', '');
        const auth = s.tokenRequired ? 'The API is protected by a per-launch token.' : 'The API has NO token.';
        if (s.fellBack) return result('warn', 'Port ' + s.preferredPort + ' is used by another application; the dashboard uses port ' + s.port + '. ' + auth,
            'No action needed. Other tools that use the fixed port 51733 (for example an old MCP server) need updating so they read runtime.json.');
        return result(s.tokenRequired ? 'ok' : 'warn', 'Port ' + s.port + '. ' + auth, s.tokenRequired ? '' : 'Restart Taxio Pilot.');
    } },
    { id: 'profiles', label: 'Chrome profile per PIC', run: async (d) => {
        const s = await d.profiles();
        const hk = require('./profile-housekeeping');
        const size = (s.partial ? '≥ ' : '') + hk.MB(s.totalBytes);
        if (!s.count) return result('ok', 'No PIC Chrome profiles yet.');
        const detail = s.count + ' profiles, total ' + size + (s.partial ? ' (not all counted yet)' : '') + '.';
        if (s.totalBytes >= hk.WARN_BYTES) return result('warn', detail, 'Settings > "Clean up old Chrome profiles" removes PIC profiles that have not been used for a long time (that PIC just logs in automatically again).');
        return result('ok', detail);
    } },
    { id: 'version', label: 'App version', run: async (d) => {
        const v = d.versionInfo();
        if (v.outdated) return result('warn', 'v' + v.current + ' - v' + v.latestVersion + ' is available; new actions are rejected until the update is installed.', 'Click "Check for updates" in Settings, or wait for the automatic update to finish.');
        // Gerbang dibuka karena update tidak bisa diterapkan (lib/updater.js): aksi tetap jalan.
        if (v.reason === 'install-failed') return result('warn', 'v' + v.current + ' - v' + v.latestVersion + ' is available but its installer has failed twice (antivirus/SmartScreen?); actions are not blocked.', 'Install manually: ' + require('./updater').installerUrl(v.latestVersion));
        if (v.reason === 'download-failed') return result('warn', 'v' + v.current + ' - v' + v.latestVersion + ' is available but could not be downloaded yet; actions are not blocked, and the download is retried every 15 minutes.', 'Check your connection to github.com, or click "Check for updates" in Settings.');
        return result('ok', 'v' + (v.current || '?') + (v.latestVersion ? ' (latest)' : ''));
    } }
];

function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

async function runOne(check, d, ctx, timeoutMs) {
    const started = Date.now();
    let timer;
    const limit = timeoutMs || (check.network ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    let r;
    try {
        r = await Promise.race([
            Promise.resolve().then(() => check.run(d, ctx)),
            new Promise((resolve) => { timer = setTimeout(() => resolve(result(check.network ? 'fail' : 'warn', 'The check did not finish within ' + Math.round(limit / 1000) + ' seconds.', check.network ? NET_FIX : '')), limit); })
        ]);
    } catch (e) {
        r = result('warn', 'The check could not run: ' + (e && e.message), '');
    } finally { clearTimeout(timer); }
    if (!r || !['ok', 'warn', 'fail'].includes(r.status)) r = result('warn', 'Invalid check result.', '');
    return { id: check.id, label: check.label, status: r.status, detail: r.detail, fix: r.fix, ms: Date.now() - started };
}

/** Menjalankan semua pemeriksaan bersamaan. opts: { deps (sebagian, menimpa bawaan), server: { port,
 *  preferredPort, fellBack, tokenRequired }, only: [id...], timeoutMs }. Tidak pernah reject. */
async function runChecks(opts) {
    const o = opts || {};
    const d = Object.assign(defaultDeps(), o.deps || {});
    const ctx = { server: o.server || null };
    const list = o.only ? CHECKS.filter((c) => o.only.includes(c.id)) : CHECKS;
    const checks = await Promise.all(list.map((c) => runOne(c, d, ctx, o.timeoutMs)));
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status]++;
    return { at: new Date().toISOString(), summary, checks };
}

/** Baris log untuk pemeriksaan bermasalah saja (dipakai main.js setelah start). */
function problemLines(report) {
    return ((report && report.checks) || []).filter((c) => c.status !== 'ok')
        .map((c) => 'Pemeriksaan sistem [' + (c.status === 'fail' ? 'GAGAL' : 'PERINGATAN') + '] ' + c.label + ': ' + c.detail + (c.fix ? ' Saran: ' + c.fix : ''));
}

module.exports = { runChecks, problemLines, CHECK_IDS: CHECKS.map((c) => c.id), CLOCK_WARN_MS };
