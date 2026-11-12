/* Taxio Pilot - penyegar token Taxio Hub di latar (audit 2026-11-12).
 *
 * autoRefreshToken supabase-js sengaja mati (lihat lib/session-store.js), dan token akses Taxio Hub hanya
 * berlaku ±1 jam. Proses panjang (SPT banyak masa, Mode A1) memanggil Taxio Hub di tengah jalan (tanda
 * compliance, kredensial / passphrase PIC cadangan, PIC tertaut lain) - dulu bisa gagal karena token habis.
 * Modul ini memeriksa setiap akun yang terhubung (dan yang masih menunggu grup) tiap beberapa menit dan
 * memperbaruinya bila tinggal < 10 menit (session-store.ensureFresh: satu pembaruan per klien, tidak tumpang
 * tindih). Tidak pernah melempar; offline hanya dicatat SEKALI (dan sekali lagi saat pulih), bukan tiap putaran.
 * Dimulai oleh lib/app.js start(), dihentikan saat keluar (gui/server.js gracefulQuit). */
const { log } = require('./log');

const INTERVAL_MS = 3 * 60 * 1000;
const FIRST_DELAY_MS = 20000;

const _deps = {
    state: () => require('./state'),
    sessionStore: () => require('./session-store'),
    label: (projectId) => ((require('./supabase-projects')[projectId] || {}).label || projectId)
};

let timer = null;
let firstTimer = null;
let running = null;
const lastStatus = {};

/** [projectId, client] untuk akun terhubung + akun yang menunggu grup (sesinya juga perlu tetap hidup). */
function targets() {
    const state = _deps.state();
    const out = [];
    for (const id of Object.keys(state.getAll())) {
        const conn = state.isConnected(id) ? state.get(id) : null;
        const pend = state.getPending(id);
        const client = (conn && conn.client) || (pend && pend.client) || null;
        if (client) out.push([id, client]);
    }
    return out;
}

/** Satu putaran. Putaran yang masih berjalan tidak pernah ditumpuk (dipanggil lagi = menunggu yang sama). */
function tick() {
    if (running) return running;
    running = (async () => {
        const store = _deps.sessionStore();
        for (const [id, client] of targets()) {
            let r;
            try { r = await store.ensureFresh(client); } catch (e) { r = { status: 'network', error: e }; }
            const prev = lastStatus[id];
            const label = _deps.label(id);
            if (r.status === 'network' && prev !== 'network') log('Taxio Hub (' + label + ') tidak bisa dihubungi untuk memperbarui sesi login - dicoba lagi otomatis tiap ' + Math.round(INTERVAL_MS / 60000) + ' menit. Aksi yang butuh Taxio Hub bisa gagal sampai koneksi pulih.');
            else if (r.status === 'invalid' && prev !== 'invalid') log('Taxio Hub (' + label + '): ' + store.EXPIRED_MESSAGE);
            else if (r.status === 'ok' && (prev === 'network' || prev === 'invalid')) log('Sesi login Taxio Hub (' + label + ') kembali aktif.');
            lastStatus[id] = r.status;
        }
    })().catch((e) => { log('Penyegar sesi Taxio Hub gagal (diabaikan): ' + e.message); })
        .finally(() => { running = null; });
    return running;
}

function start(opts) {
    if (timer) return;
    const o = opts || {};
    timer = setInterval(tick, o.intervalMs || INTERVAL_MS);
    if (timer.unref) timer.unref();
    firstTimer = setTimeout(tick, o.firstDelayMs != null ? o.firstDelayMs : FIRST_DELAY_MS);
    if (firstTimer.unref) firstTimer.unref();
}
function stop() {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = null; firstTimer = null;
}
function isRunning() { return !!timer; }

module.exports = { start, stop, tick, isRunning, INTERVAL_MS, _deps, _lastStatus: lastStatus };
