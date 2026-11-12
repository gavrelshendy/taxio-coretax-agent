/* Ekspor diagnostik (tombol "Ekspor diagnostik" di Pengaturan, POST /api/diagnostics/export): satu zip di
 * ~/Downloads/TaxioPilot-diagnostik-<waktu>.zip yang bisa dikirim pengguna ke dukungan.
 *
 * ISI: hasil pemeriksaan sistem (lib/doctor.js), versi aplikasi/OS/Node, lokasi folder yang dipakai,
 * info runtime TANPA token, dan ±2000 baris log terakhir.
 * TIDAK PERNAH: session.json, local-entities.json, pending-signup.json atau berkas lain di folder data,
 * kredensial, passphrase, token runtime. Potongan log disensor: apa pun yang mirip JWT / token Bearer /
 * access_token / refresh_token / passphrase / password, plus string rahasia yang diberikan pemanggil
 * (token runtime). Path home pengguna diganti %USERPROFILE%.
 * Log tetap bisa memuat nama entitas / NPWP - dashboard mengingatkan pengguna soal itu sebelum mengirim.
 * Folder tujuan: lib/paths.js downloadsDir() (TAXIO_PILOT_DOWNLOADS_DIR untuk tes). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const paths = require('./paths');

const LOG_LINES = 2000;
const MAX_LOG_READ = 4 * 1024 * 1024;

/** Menyensor rahasia dari teks bebas (log). `secrets`: string literal tambahan yang harus hilang. */
function scrub(text, secrets) {
    let s = String(text || '');
    for (const secret of secrets || []) {
        if (secret && String(secret).length >= 8) s = s.split(String(secret)).join('[RAHASIA-DISENSOR]');
    }
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[JWT-DISENSOR]');
    s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [DISENSOR]');
    s = s.replace(/("?(?:access_token|refresh_token|provider_token|token|passphrase|password|kata_?sandi|apikey|api_key|secret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[DISENSOR]');
    s = s.replace(/([?&](?:t|token|access_token|refresh_token|code)=)[^&\s"']+/gi, '$1[DISENSOR]');
    s = s.replace(/\b[0-9a-f]{64}\b/gi, '[HEX64-DISENSOR]'); // bentuk token runtime
    return s;
}

function homeToVar(text) {
    const home = os.homedir();
    if (!home) return text;
    return String(text).split(home).join('%USERPROFILE%');
}

/** ±`n` baris terakhir log (berkas aktif, ditambah .1 bila berkas aktif masih pendek). */
function tailLog(file, n) {
    const lines = [];
    for (const f of [file, file + '.1']) {
        if (lines.length >= n) break;
        try {
            const size = fs.statSync(f).size;
            const len = Math.min(size, MAX_LOG_READ);
            const buf = Buffer.alloc(len);
            const fd = fs.openSync(f, 'r');
            try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
            let rows = buf.toString('utf8').split(/\r?\n/);
            if (len < size) rows = rows.slice(1); // baris pertama terpotong
            rows = rows.filter((l) => l.length);
            lines.unshift(...rows.slice(-(n - lines.length)));
        } catch (e) { /* tidak ada */ }
    }
    return lines.slice(-n);
}

function systemInfo() {
    let appVersion = null;
    try { appVersion = require('../package.json').version; } catch (e) { /* abaikan */ }
    return {
        app: { name: 'Taxio Pilot', version: appVersion, packaged: require('./shell').isPackaged(), shell: require('./shell').kind, electron: process.versions.electron || null, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
        os: { platform: process.platform, release: os.release(), version: typeof os.version === 'function' ? os.version() : '', arch: process.arch, cpus: (os.cpus() || []).length, totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576) },
        node: { version: process.version, versions: { v8: process.versions.v8, uv: process.versions.uv, openssl: process.versions.openssl } },
        locale: (() => { try { return Intl.DateTimeFormat().resolvedOptions(); } catch (e) { return null; } })(),
        exportedAt: new Date().toISOString()
    };
}

function stamp(d) {
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** Menulis zip diagnostik. opts: { health, runtimeInfo (tanpa token), secrets: [string], logFile, outDir, now }.
 *  Resolves { file, bytes, entries }. */
async function exportZip(opts) {
    const o = opts || {};
    const secrets = (o.secrets || []).filter(Boolean);
    const logFile = o.logFile || require('./log').LOG_FILE;
    const outDir = o.outDir || paths.downloadsDir();
    const zip = new JSZip();
    const json = (obj) => homeToVar(scrub(JSON.stringify(obj, null, 2), secrets));
    const runtimeInfo = o.runtimeInfo ? Object.assign({}, o.runtimeInfo) : null;
    if (runtimeInfo) delete runtimeInfo.token;
    const entries = {
        'BACA-SAYA.txt': [
            'Diagnostik Taxio Pilot - dibuat ' + new Date().toISOString(),
            '',
            'Isi: hasil pemeriksaan sistem (pemeriksaan-sistem.json), versi aplikasi/OS/Node (sistem.json),',
            'lokasi folder (lokasi.json), info runtime tanpa token (runtime.json) dan ' + LOG_LINES + ' baris log terakhir (log-terakhir.txt).',
            'Tidak berisi sesi login, kredensial, passphrase, daftar entitas lokal, atau token dashboard.',
            'Log bisa memuat nama entitas / NPWP / nama PIC: kirim hanya ke pihak yang Anda percaya.'
        ].join('\r\n'),
        'pemeriksaan-sistem.json': json(o.health || null),
        'sistem.json': json(systemInfo()),
        'lokasi.json': json(paths.describe()),
        'runtime.json': json(runtimeInfo),
        'log-terakhir.txt': homeToVar(scrub(tailLog(logFile, LOG_LINES).join('\r\n'), secrets))
    };
    for (const [name, content] of Object.entries(entries)) zip.file(name, content);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'TaxioPilot-diagnostik-' + stamp(o.now || new Date()) + '.zip');
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length, entries: Object.keys(entries) };
}

module.exports = { exportZip, scrub, tailLog, LOG_LINES };
