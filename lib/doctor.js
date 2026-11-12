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
            if (process.platform !== 'win32') return resolve({ ok: false, error: 'bukan Windows' });
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
        catch (e) { throw new Error(ac.signal.aborted ? 'tidak menjawab dalam ' + Math.round(timeoutMs / 1000) + ' detik' : ((e.cause && (e.cause.code || e.cause.message)) || e.message)); }
        const date = res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null;
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) { /* abaikan */ }
        return { status: res.status, date };
    } finally { clearTimeout(t); }
}

const NET_FIX = 'Periksa koneksi internet. Di jaringan kantor, minta admin jaringan mengizinkan alamat ini (Taxio Pilot memakai pengaturan proxy Windows).';

const CHECKS = [
    { id: 'data-root', label: 'Folder data dapat ditulis', run: async (d) => {
        const root = d.root();
        try { d.writeProbe(root); return result('ok', root); }
        catch (e) { return result('fail', root + ': ' + (e.code || e.message), 'Pastikan folder ini bisa ditulis oleh akun Windows Anda (bukan dibatasi antivirus / kebijakan kantor), lalu buka ulang Taxio Pilot.'); }
    } },
    { id: 'disk', label: 'Ruang disk', run: async (d) => {
        const root = d.root();
        let target = root;
        while (target && !fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
        const st = d.statfs(target);
        const free = Number(st.bavail) * Number(st.bsize);
        const b = safe(() => d.browser(), {});
        const needChrome = !b.ready && !b.disabled;
        if (needChrome && free < CHROME_NEED_BYTES) return result('fail', 'Sisa ' + GB(free) + ' - Chrome bawaan butuh ±0.7 GB untuk diunduh dan dipasang.', 'Kosongkan ruang di drive ' + path.parse(target).root + ' lalu buka ulang Taxio Pilot.');
        if (free < LOW_DISK_BYTES) return result('warn', 'Sisa ' + GB(free) + ' di ' + path.parse(target).root, 'Ruang disk hampir habis; unduhan dan file hasil bisa gagal disimpan.');
        return result('ok', 'Sisa ' + GB(free) + ' di ' + path.parse(target).root);
    } },
    { id: 'browser', label: 'Chrome untuk otomasi', run: async (d) => {
        const b = d.browser();
        const installed = d.installedChrome();
        if (b.ready) return result('ok', 'Chrome bawaan Taxio Pilot v' + b.version + ' siap dan akan dipakai.');
        if (installed) return result(b.disabled ? 'ok' : 'warn', (b.disabled ? 'Chrome bawaan dimatikan (CORETAX_BUNDLED_CHROME=0)' : 'Chrome bawaan belum siap') + ' - memakai Chrome yang terpasang: ' + installed,
            b.disabled ? '' : 'Chrome bawaan diunduh otomatis di latar (±185 MB). Bila terus gagal, periksa koneksi / proxy; sementara itu Chrome terpasang dipakai.');
        return result('fail', 'Chrome bawaan belum siap dan Google Chrome tidak ditemukan di PC ini.', 'Biarkan Taxio Pilot terbuka dan terhubung internet sampai Chrome bawaan selesai diunduh, atau pasang Google Chrome.');
    } },
    { id: 'proxy', label: 'Proxy Windows', run: async (d) => {
        const p = d.proxy();
        if (!p.known) return result('ok', 'Pengaturan proxy tidak terbaca (bukan Windows / registry tidak bisa dibaca).');
        if (!p.enabled && !p.pac) return result('ok', 'Tidak memakai proxy.');
        const what = [p.enabled ? 'proxy ' + (p.server || '(tanpa alamat)') : '', p.pac ? 'skrip PAC ' + p.pacUrl : ''].filter(Boolean).join(' + ');
        if (safe(() => d.proxyHonoured(), false)) {
            return result('ok', 'Windows memakai ' + what + '. Chrome otomasi dan koneksi Taxio Pilot sendiri (Taxio Hub, update) mengikutinya.');
        }
        return result('warn', 'Windows memakai ' + what + '. Chrome otomasi mengikutinya, tetapi koneksi Taxio Pilot dalam mode ini (tanpa jendela / pengembangan) tidak.',
            'Jalankan Taxio Pilot dari pintasannya (aplikasi desktop mengikuti proxy Windows). Bila Taxio Hub / update tetap gagal tersambung, minta admin jaringan mengizinkan *.supabase.co dan github.com.');
    } },
    { id: 'coretax', label: 'Coretax DJP terjangkau', network: true, run: async (d) => {
        try { const r = await head(d, CORETAX_URL, NETWORK_TIMEOUT_MS - 500); return result('ok', 'coretaxdjp.pajak.go.id menjawab (HTTP ' + r.status + ').'); }
        catch (e) { return result('fail', 'coretaxdjp.pajak.go.id tidak terjangkau: ' + e.message, NET_FIX); }
    } },
    { id: 'hub', label: 'Taxio Hub terjangkau', network: true, run: async (d) => {
        const h = d.hubUrl();
        try { const r = await head(d, h.url + '/auth/v1/health', NETWORK_TIMEOUT_MS - 500, { apikey: h.anonKey }); return result('ok', new URL(h.url).host + ' menjawab (HTTP ' + r.status + ').'); }
        catch (e) { return result('fail', 'Taxio Hub tidak terjangkau: ' + e.message, NET_FIX); }
    } },
    { id: 'clock', label: 'Jam PC', network: true, run: async (d) => {
        const h = d.hubUrl();
        let r = null, lastErr = null;
        for (const url of [h.url + '/auth/v1/health', CORETAX_URL]) {
            try { r = await head(d, url, 4500, url.startsWith(h.url) ? { apikey: h.anonKey } : {}); if (r.date) break; }
            catch (e) { lastErr = e; }
        }
        const server = r && r.date ? Date.parse(r.date) : NaN;
        if (!Number.isFinite(server)) return result('warn', 'Tidak bisa membandingkan jam (' + (lastErr ? lastErr.message : 'server tidak mengirim jam') + ').', '');
        const skew = d.now() - server;
        const secs = Math.round(Math.abs(skew) / 1000);
        const human = secs >= 120 ? Math.round(secs / 60) + ' menit' : secs + ' detik';
        if (Math.abs(skew) > CLOCK_WARN_MS) return result('warn', 'Jam PC ' + (skew > 0 ? 'lebih cepat' : 'lebih lambat') + ' ' + human + ' dari jam server.',
            'Login Taxio Hub / Coretax bisa ditolak bila jam meleset. Buka Pengaturan Windows > Waktu & bahasa > aktifkan "Atur waktu secara otomatis" lalu "Sinkronkan sekarang".');
        return result('ok', 'Selisih ' + human + ' dari jam server.');
    } },
    { id: 'powershell', label: 'PowerShell', run: async (d) => {
        const r = await d.powershell();
        if (r.ok) return result('ok', 'PowerShell ' + (r.version || '') + ' bisa dijalankan.');
        return result('warn', 'PowerShell tidak bisa dijalankan: ' + (r.error || ''), 'Membawa jendela Coretax ke depan dan menutup jendela Chrome sisa memakai PowerShell. Minta admin IT mengizinkan powershell.exe untuk akun ini.');
    } },
    { id: 'port', label: 'Port & token dashboard', run: async (d, ctx) => {
        const s = ctx.server;
        if (!s || !s.port) return result('warn', 'Info server belum tersedia.', '');
        const auth = s.tokenRequired ? 'API dilindungi token per peluncuran.' : 'API TANPA token.';
        if (s.fellBack) return result('warn', 'Port ' + s.preferredPort + ' dipakai aplikasi lain; dashboard memakai port ' + s.port + '. ' + auth,
            'Tidak perlu tindakan. Alat lain yang memakai port tetap 51733 (mis. server MCP versi lama) perlu diperbarui supaya membaca runtime.json.');
        return result(s.tokenRequired ? 'ok' : 'warn', 'Port ' + s.port + '. ' + auth, s.tokenRequired ? '' : 'Mulai ulang Taxio Pilot.');
    } },
    { id: 'version', label: 'Versi aplikasi', run: async (d) => {
        const v = d.versionInfo();
        if (v.outdated) return result('warn', 'v' + v.current + ' - versi v' + v.latestVersion + ' tersedia; aksi baru ditolak sampai update terpasang.', 'Klik "Check for updates" di Pengaturan, atau tunggu update otomatis selesai.');
        return result('ok', 'v' + (v.current || '?') + (v.latestVersion ? ' (terbaru)' : ''));
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
            new Promise((resolve) => { timer = setTimeout(() => resolve(result(check.network ? 'fail' : 'warn', 'Pemeriksaan tidak selesai dalam ' + Math.round(limit / 1000) + ' detik.', check.network ? NET_FIX : '')), limit); })
        ]);
    } catch (e) {
        r = result('warn', 'Pemeriksaan gagal dijalankan: ' + (e && e.message), '');
    } finally { clearTimeout(timer); }
    if (!r || !['ok', 'warn', 'fail'].includes(r.status)) r = result('warn', 'Hasil pemeriksaan tidak valid.', '');
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
