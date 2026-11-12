/* Instance Taxio Pilot yang sedang berjalan: port dinamis, token per peluncuran, dan runtime.json.
 *
 * Kenapa (Tahap 1): port dulu tetap 51733 - bentrok dengan aplikasi lain atau pengguna Windows kedua di
 * PC yang sama - dan API lokal tidak punya autentikasi selain cek Host/Origin (gui/guards.js), jadi
 * program lokal APA PUN bisa menerbitkan bukti potong lewat API. Sekarang:
 *   - port: coba 51733 dulu (integrasi lama), kalau terpakai oleh sesuatu yang BUKAN Taxio Pilot milik
 *     pengguna ini, bind port bebas (listen 0);
 *   - token: 32 byte acak (hex) per peluncuran, wajib untuk /api/* dan /events (gui/guards.js authProblem);
 *   - <akar>\runtime.json { port, pid, token, version, startedAt } ditulis atomik setelah listen() dan
 *     dihapus saat keluar normal (hanya bila pid-nya masih milik proses ini). Berkasnya di bawah
 *     %LOCALAPPDATA% pengguna (izin folder per-user Windows) - itulah yang membatasi siapa yang bisa
 *     membaca tokennya. Pembaca: main.js (instance kedua meneruskan permintaan ke primary), server MCP
 *     (mcp/taxio-pilot-mcp.js, membaca berkas ini sendiri karena didistribusikan tanpa dependensi).
 *
 * Deteksi primary (findPrimary): runtime.json ada + pid hidup + GET /api/session dengan token menjawab
 * 200 => primary berjalan. Cadangan: probe 51733 TANPA token yang menjawab 200 = primary VERSI LAMA
 * (sebelum token; mis. saat serah-terima update dari versi lama). Versi baru di 51733 tanpa token
 * menjawab 401 dan bukan milik pengguna ini (runtime.json-nya bukan punya kita) -> dianggap orang lain.
 * Batas yang diketahui: primary versi LAMA milik pengguna Windows lain di 51733 tetap terlihat seperti
 * milik kita (sama seperti sebelum Tahap 1) - versi lama tidak bisa dibedakan dari luar. */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const paths = require('./paths');
const { readJson, writeJsonAtomic } = require('./data-dir');

const PREFERRED_PORT = 51733;
/** Header yang dipasang server pada SETIAP balasan - membedakan "port dipakai Taxio Pilot (versi baru)"
 *  dari "port dipakai aplikasi lain" tanpa token. Bukan rahasia. */
const PILOT_HEADER = 'x-taxio-pilot';

function newToken() { return crypto.randomBytes(32).toString('hex'); }

/** Perbandingan waktu-konstan (panjang berbeda pun tidak membocorkan lewat waktu: dibandingkan hash-nya). */
function tokenEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function write(info, file) {
    const f = file || paths.runtimeFile();
    writeJsonAtomic(f, { port: info.port, pid: info.pid || process.pid, token: info.token, version: info.version || null, startedAt: info.startedAt || new Date().toISOString() });
    return f;
}
function read(file) {
    const r = readJson(file || paths.runtimeFile(), null);
    if (!r || typeof r !== 'object' || !Number.isInteger(r.port) || !Number.isInteger(r.pid) || typeof r.token !== 'string') return null;
    return r;
}
/** Hapus runtime.json hanya bila masih milik `pid` (instance lain yang sudah menimpanya tidak diganggu).
 *  Sinkron - aman dipanggil dari process.on('exit'). */
function remove(pid, file) {
    const f = file || paths.runtimeFile();
    try {
        const r = read(f);
        if (r && r.pid !== (pid || process.pid)) return false;
        fs.rmSync(f, { force: true });
        return true;
    } catch (e) { return false; }
}
/** Info runtime tanpa token (diagnostik / /api/health). */
function publicInfo(info) {
    if (!info) return null;
    const { token, ...rest } = info;
    return Object.assign(rest, { tokenRequired: !!token });
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; } // ada, tapi milik pengguna lain
}

/** GET `path` di 127.0.0.1:port. Resolves { status, pilot } (status 0 = tidak ada yang menjawab /
 *  timeout; pilot = header x-taxio-pilot ada). Tidak pernah reject. */
function probe(port, token, { path = '/api/session', timeoutMs = 2000 } = {}) {
    return new Promise((resolve) => {
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs, headers }, (res) => {
            res.resume();
            resolve({ status: res.statusCode, pilot: !!res.headers[PILOT_HEADER] });
        });
        req.on('error', (e) => resolve({ status: 0, pilot: false, code: e.code }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, pilot: false, code: 'TIMEOUT' }); });
        req.end();
    });
}

/** Primary yang sedang berjalan milik pengguna ini: { port, token, legacy } atau null.
 *  `opts`: { file, legacyPort, probe, isPidAlive, selfPid } - untuk tes. */
async function findPrimary(opts) {
    const o = opts || {};
    const doProbe = o.probe || probe;
    const alive = o.isPidAlive || isPidAlive;
    const self = o.selfPid || process.pid;
    const rt = read(o.file);
    if (rt && rt.pid !== self && alive(rt.pid)) {
        const r = await doProbe(rt.port, rt.token);
        if (r.status === 200) return { port: rt.port, token: rt.token, legacy: false, pid: rt.pid };
    }
    const legacyPort = o.legacyPort === undefined ? PREFERRED_PORT : o.legacyPort;
    if (legacyPort && (!rt || rt.port !== legacyPort || rt.pid === self || !alive(rt.pid))) {
        const r = await doProbe(legacyPort, null);
        if (r.status === 200) return { port: legacyPort, token: null, legacy: true };
    }
    return null;
}

/** POST `path` (JSON body opsional) ke primary { port, token }. Resolves true bila primary menjawab
 *  (2xx-4xx selain 401) - tugas proses ini selesai; false bila tidak ada yang menjawab. */
function forward(primary, path, body) {
    return new Promise((resolve) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (primary.token) headers.Authorization = 'Bearer ' + primary.token;
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        const req = http.request({ host: '127.0.0.1', port: primary.port, path, method: 'POST', timeout: 3000, headers }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500 && res.statusCode !== 401);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end(data || undefined);
    });
}

/** Membuka server dashboard: coba `preferredPort`; bila terpakai (EADDRINUSE):
 *   - yang memakainya Taxio Pilot milik pengguna ini (findPrimary, dicoba beberapa detik - instance
 *     yang baru saja menang balapan bind mungkin belum menulis runtime.json) -> { primary };
 *   - selain itu (aplikasi lain, atau Taxio Pilot pengguna Windows lain) -> bind port bebas.
 *  `create(port)` membuka server (gui/server.js createGuiServer). Resolves { server, port, fellBack }
 *  atau { primary }. Galat selain EADDRINUSE dilempar. `opts` untuk tes: findPrimary, probe, sleep, tries. */
async function listenPreferred(create, preferredPort, opts) {
    const o = opts || {};
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const find = o.findPrimary || findPrimary;
    const doProbe = o.probe || probe;
    try {
        const server = await create(preferredPort);
        return { server, port: server.address().port, fellBack: false };
    } catch (e) {
        if (!e || e.code !== 'EADDRINUSE') throw e;
    }
    const tries = o.tries || 5;
    for (let i = 0; i < tries; i++) {
        const p = await find();
        if (p) return { primary: p };
        // Bukan Taxio Pilot sama sekali (tidak ada header kita / tidak menjawab HTTP) -> tidak perlu menunggu.
        const r = await doProbe(preferredPort, null);
        if (!r.pilot) break;
        if (i < tries - 1) await sleep(1000);
    }
    const server = await create(0);
    return { server, port: server.address().port, fellBack: true };
}

module.exports = {
    PREFERRED_PORT, PILOT_HEADER, newToken, tokenEquals, write, read, remove, publicInfo, isPidAlive,
    probe, findPrimary, forward, listenPreferred
};
