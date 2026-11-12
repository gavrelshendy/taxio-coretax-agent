/* Tes konkurensi "semua perintah bisa paralel" (2026-11-13) lewat route HTTP SUNGGUHAN gui/server.js, tanpa jaringan
 * dan tanpa Chrome: Supabase/Taxio Hub diganti data palsu (seperti scripts/gui-test-fakes.js), Playwright
 * launchPersistentContext diganti jendela tiruan (lib/chrome-sessions.js launchOrReuseContext tetap ASLI - pemilihan
 * jendela, profil, cache jendela), dan automation/*.js diganti kerja lambat bercheckpoint yang maju hanya saat tes
 * membukakan langkahnya. Memastikan:
 *   (a) PIC berbeda, (b) PIC sama entitas berbeda, (c) entitas sama fitur berbeda -> masing-masing jendela sendiri
 *       ("<pic>", "<pic>~2", "<pic>~3"), berjalan bersamaan;
 *   log / rencana / status per proses; Jeda / Lewati / Hentikan satu proses tidak memengaruhi yang lain;
 *   batas per PIC dan total -> antre (202 queued + position), mulai sendiri berurutan, Stop membatalkan antrean;
 *   perintah identik ditolak 409, fitur sama entitas sama antre di belakang (kunci keluaran);
 *   jalur PIC cadangan SPT meminjam jendela bebas PIC lain (atau menunggu lalu melewatinya), tidak merebut;
 *   login saja lalu aksi memakai jendela yang sama; Dividen memakai jendela yang kasusnya terbuka;
 *   route hasil (runForResult) menunggu antrean lalu 409 dengan pesan lama; deep link memakai antrean yang sama;
 *   folder profil sah dan berbeda (perawatan profil mengenalinya); kunci berkas Excel; tidak ada yang bocor.
 * Jalankan: node scripts/test-parallel-runs.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-par-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('tidak terjadi: ' + (what || fn.toString())); await sleep(10); }
}

// ---------- Tanpa jendela / PowerShell sungguhan ----------
const shell = require('../lib/shell');
shell._deps.exec = () => {};
require('../lib/browser').launchOptions = async () => ({ channel: 'chrome', bundled: false });
const pw = require('playwright');
const launches = []; // folder profil setiap peluncuran
const contexts = new Map(); // folder -> konteks tiruan
function fakeContext(dir) {
    const handlers = {};
    let closed = false;
    const ctx = { dir, pageUrl: 'https://coretaxdjp.pajak.go.id/portal' };
    const page = { isClosed: () => closed, url: () => ctx.pageUrl, evaluate: async () => '', bringToFront: async () => {}, context: () => ctx, goto: async () => {} };
    Object.assign(ctx, {
        page, addInitScript: async () => {}, exposeFunction: async () => {}, route: async () => {}, browser: () => null,
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        pages: () => (closed ? [] : [page]), newPage: async () => page, newCDPSession: async () => ({ send: async () => ({}) }),
        close: async () => { if (closed) return; closed = true; (handlers.close || []).forEach((f) => f()); }
    });
    return ctx;
}
pw.chromium.launchPersistentContext = async (dir) => { launches.push(dir); const c = fakeContext(dir); contexts.set(dir, c); return c; };

// ---------- Taxio Hub palsu ----------
const sessionStore = require('../lib/session-store');
const entitiesLib = require('../lib/entities');
const ok = (data) => Promise.resolve({ data, error: null });
const fake = {
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    rpc: (name) => ok(name === 'get_my_active_membership' ? [{ org_id: 'o1' }] : null),
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ok([]) }) }) })
};
const PROJECT = { id: 'taxio_hub', label: 'Taxio Hub' };
sessionStore.clientFor = () => ({ client: fake, project: PROJECT });
sessionStore.connectWithPassword = async (id, email) => ({ client: fake, project: PROJECT, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, user: { id: 'u-1', email } });
sessionStore.refreshIfNeeded = async () => {};
sessionStore.connectWithToken = async () => ({ client: fake, user: { id: 'u-1' } });
entitiesLib.getMyOrgId = async () => ({ org_id: 'o1', role: 'editor' });
// MKA punya dua PIC (Rina utama, Andi cadangan) - untuk jalur PIC cadangan SPT.
const LINKS = { MKA: ['p-rina', 'p-andi'] };
entitiesLib.getOtherLinkedPicIds = async (c, o, entityId, pic) => (LINKS[entityId] || []).filter((p) => p !== pic);
entitiesLib.resolveAuthorizedPic = async (c, o, pic, others) => ({ picId: pic, passphrase: null, fallbackPicIds: others || [] });
entitiesLib.getCredential = async (c, o, pic) => ({ username: 'nik-' + pic, pic_name: pic });
entitiesLib.getPassphrase = async () => null;

// ---------- Kerja otomasi tiruan: lambat, bercheckpoint, maju per langkah atas perintah tes ----------
const chrome = require('../lib/chrome');
const runcontrol = require('../lib/runcontrol');
const loginStatus = require('../lib/login-status');
const { log, onLogLine } = require('../lib/log');
const gates = new Map(); // id proses -> { allowed, all, started, window, ended }
const STEPS = 3;
async function slowSteps(n) {
    const run = runcontrol.current();
    const g = gates.get(run.id) || { allowed: 0, all: false };
    g.started = true; gates.set(run.id, g);
    runcontrol.setPlan(Array.from({ length: n }, (_, i) => ({ label: 'langkah ' + i, short: String(i) })));
    let i = 0;
    while (i < n) {
        try {
            for (;;) { await runcontrol.checkpoint(); if (g.all || g.allowed > i) break; await sleep(5); }
            runcontrol.markCombo(i, 'run');
            log('langkah ' + i);
            runcontrol.markCombo(i, 'ok');
            i++;
        } catch (e) {
            if (e.isSkip) { runcontrol.markCombo(i, 'skip'); log('langkah ' + i + ' dilewati'); i++; continue; }
            throw e;
        }
    }
    g.ended = true;
}
async function openWindow(picId, entity) {
    const { page } = await chrome.launchOrReuseContext(picId, null, false, null);
    loginStatus.set(picId, entity);
    const g = gates.get(runcontrol.current().id) || { allowed: 0, all: false };
    g.window = runcontrol.windowKeyFor(picId); gates.set(runcontrol.current().id, g);
    return page;
}
const fakeAuto = async (opts) => { await openWindow(opts.picId, opts.entity); await slowSteps(STEPS); };
require('../automation/ebupot').runEbupotDownload = fakeAuto;
require('../automation/mybupot').runMyBuktiPotongDownload = fakeAuto;
require('../automation/billing').runBillingPph25 = fakeAuto;
require('../automation/login').runLoginOnly = (opts) => openWindow(opts.picId, opts.entity);
const fallbackTries = [];
require('../automation/spt').runSptDownload = async (opts) => {
    await openWindow(opts.picId, opts.entity);
    await slowSteps(STEPS);
    // Seperti automation/spt.js: masa yang gagal dicoba lagi sebagai PIC lain yang tertaut (jendela PIC itu).
    for (const fb of opts.fallbackPicIds || []) {
        try {
            await chrome.launchOrReuseContext(fb, null, false, null);
            loginStatus.set(fb, opts.entity);
            fallbackTries.push({ run: runcontrol.current().id, pic: fb, window: runcontrol.windowKeyFor(fb) });
            const g = gates.get(runcontrol.current().id); g.borrowed = runcontrol.windowKeyFor(fb);
            for (;;) { await runcontrol.checkpoint(); if (g.releaseBorrow) break; await sleep(5); }
        } catch (e) { fallbackTries.push({ run: runcontrol.current().id, pic: fb, error: e.message }); log('Gagal masuk sebagai PIC lain (' + fb + '): ' + e.message + ' - dilewati.'); }
    }
};
require('../automation/dividen').runDividenCheck = async () => { await slowSteps(1); };
require('../automation/pajakmasukan').runDownloadExcel = async () => { await slowSteps(STEPS); };
require('../automation/efaktur').runDownloadEfaktur = async () => { await slowSteps(STEPS); };
require('../lib/coretax-issue').preview = async () => ({ label: 'BPPU', period: '0126', count: 0, totalGross: 0, totalTax: 0, needsSign: false, token: 'T', skipped: [], rows: [] });
let deeplinkGate = null;
chrome.loginAndImpersonate = async () => { if (deeplinkGate) await deeplinkGate.promise; return true; };

const lines = [];
onLogLine((e) => lines.push(e));
const W = require('../gui/run-wrappers');
const { createGuiServer } = require('../gui/server');

let BASE = '', TOKEN = '';
async function call(method, url, body) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (e) { /* bukan JSON */ }
    return { status: res.status, json };
}
const GET = (u) => call('GET', u);
const POST = (u, b) => call('POST', u, b === undefined ? {} : b);
const ent = (id, pic, extra) => Object.assign({ project: 'taxio_hub', entity_id: id, entity_name: 'PT ' + id, npwp: '0' + id.length + '00000000000000', individual: false, pic_id: pic }, extra || {});
const efTypes = () => [require('../automation/efaktur').DOC_TYPES[0].key];

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const started = (id) => until(() => gates.get(id) && gates.get(id).started, 4000, 'proses ' + id + ' mulai');
const statusOf = async (key, entity) => (await GET('/api/run/status?session=' + encodeURIComponent(key) + (entity ? '&entity=' + encodeURIComponent(entity) : ''))).json;
const done = async (id) => until(async () => !(await statusOf('run:' + id)).active, 5000, 'proses ' + id + ' selesai');
const finishRun = async (id) => { const g = gates.get(id); if (g) { g.all = true; g.releaseBorrow = true; } await done(id); };

(async () => {
    const server = await createGuiServer(0);
    TOKEN = server.token; BASE = 'http://127.0.0.1:' + server.address().port;
    console.log('parallel runs');
    assert.strictEqual((await POST('/api/connect', { project: 'taxio_hub', email: 'uji@contoh.com', password: 'x' })).status, 200);

    const R = {}; // nama -> balasan 202

    await test('Pengaturan "Parallel sessions": baca, simpan (dibatasi rentangnya) dan tersimpan di folder data', async () => {
        const a = (await GET('/api/settings/parallel')).json;
        assert.deepStrictEqual([a.perPic, a.total], [3, 6], 'bawaan 3 per PIC, 6 total');
        const b = await POST('/api/settings/parallel', { perPic: 3, total: 5 });
        assert.strictEqual(b.status, 200); assert.deepStrictEqual([b.json.perPic, b.json.total], [3, 5]);
        assert.strictEqual((await POST('/api/settings/parallel', { perPic: 'banyak' })).status, 400);
        assert.strictEqual((await POST('/api/settings/parallel', { perPic: 99 })).json.perPic, 5, 'dibatasi ke rentang');
        await POST('/api/settings/parallel', { perPic: 3, total: 5 });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'parallel-sessions.json'), 'utf8')), { perPic: 3, total: 5 });
    });

    await test('(a) PIC berbeda, (b) PIC sama entitas berbeda, (c) entitas sama fitur berbeda: jendela sendiri-sendiri, bersamaan', async () => {
        R.A = (await POST('/api/actions/download-ebupot', { entity: ent('CSA', 'p-andi'), bupotType: 'bpu', masaInput: '0126' })).json;   // (a)
        R.B = (await POST('/api/actions/download-efaktur', { entity: ent('SNM', 'p-rina'), masaInput: '0126', types: efTypes() })).json;   // (a)
        R.C = (await POST('/api/actions/billing-pph25', { entity: ent('BUDI', 'p-budi'), masaInput: '0726', nominal: '1000' })).json;     // (a)
        R.D = (await POST('/api/actions/download-pajak-masukan', { entity: ent('MKA', 'p-andi'), masaInput: '0126' })).json;              // (b)
        R.E = (await POST('/api/actions/download-efaktur', { entity: ent('CSA', 'p-andi'), masaInput: '0126', types: efTypes() })).json;  // (c)
        for (const k of 'ABCDE') assert.ok(R[k] && R[k].started && R[k].run && !R[k].queued, k + ': ' + JSON.stringify(R[k]));
        assert.deepStrictEqual('ABCDE'.split('').map((k) => R[k].session), ['p-andi', 'p-rina', 'p-budi', 'p-andi~2', 'p-andi~3']);
        for (const k of 'ABCDE') await started(R[k].run);
        assert.deepStrictEqual('ABCDE'.split('').map((k) => gates.get(R[k].run).window), ['p-andi', 'p-rina', 'p-budi', 'p-andi~2', 'p-andi~3'], 'automation memakai jendela prosesnya sendiri');
        const st = (await GET('/api/run/status')).json;
        assert.strictEqual(st.runs.filter((r) => r.active && !r.queued).length, 5);
        const sl = (await GET('/api/sessions/list')).json.sessions;
        assert.deepStrictEqual(sl.filter((s) => s.pool === 'p-andi').map((s) => s.windowNo).sort(), [1, 2, 3]);
        assert.ok(sl.find((s) => s.picId === 'p-andi~2').entityId === 'MKA', 'jendela tahu entitasnya');
    });

    await test('status / rencana per proses: entitas terpilih melihat prosesnya sendiri, bukan proses entitas lain di PIC yang sama', async () => {
        const csa = await statusOf('p-andi', 'CSA'), mka = await statusOf('p-andi', 'MKA');
        assert.strictEqual(mka.id, R.D.run); assert.ok(/Pajak Masukan/.test(mka.label));
        assert.ok([R.A.run, R.E.run].includes(csa.id));
        assert.strictEqual((await statusOf('p-andi~3')).id, R.E.run, 'kunci jendela -> proses di jendela itu');
        gates.get(R.D.run).allowed = 2;
        await until(async () => (await statusOf('run:' + R.D.run)).plan.states.filter((s) => s === 'ok').length === 2);
        assert.deepStrictEqual((await statusOf('run:' + R.A.run)).plan.states, ['wait', 'wait', 'wait'], 'rencana A tidak ikut maju');
    });

    await test('batas: PIC penuh / total penuh -> 202 queued + position; identik ditolak 409; fitur sama entitas sama antre (kunci); Stop membatalkan antrean', async () => {
        R.F = (await POST('/api/actions/download-spt', { entity: ent('DEF', 'p-andi'), jenisPajakKeys: ['pph21'], masaInput: '0126' })).json;
        R.G = (await POST('/api/actions/download-mybupot', { entity: ent('GHI', 'p-rina'), buktiTypeKeys: ['bp21'], masaInput: '0126' })).json;
        const H = await POST('/api/actions/download-efaktur', { entity: ent('CSA', 'p-andi'), masaInput: '0126', types: efTypes() });
        R.I = (await POST('/api/actions/download-efaktur', { entity: ent('CSA', 'p-andi'), masaInput: '0226', types: efTypes() })).json;
        R.J = (await POST('/api/actions/billing-pph25', { entity: ent('GHI', 'p-andi'), masaInput: '0726', nominal: '5' })).json;
        assert.strictEqual(R.F.queued, true); assert.strictEqual(R.F.position, 1); assert.strictEqual(R.F.session, 'run:' + R.F.run);
        assert.strictEqual(R.G.queued, true, 'batas total 5');
        assert.strictEqual(H.status, 409); assert.ok(/Perintah yang sama untuk entitas ini sudah berjalan \("e-Faktur download/.test(H.json.error), H.json.error);
        assert.strictEqual(R.I.queued, true);
        assert.strictEqual(R.J.queued, true); assert.strictEqual(R.J.position, 3);
        const f = await statusOf('run:' + R.F.run);
        assert.strictEqual(f.queued, true); assert.strictEqual(f.active, true); assert.strictEqual(f.position, 1);
        assert.strictEqual((await statusOf('run:' + R.I.run)).waitReason, 'lock', 'e-Faktur CSA kedua menunggu yang pertama (kunci keluaran)');
        assert.ok(lines.some((e) => e.run === R.F.run && /Menunggu giliran - antrean ke-1/.test(e.msg) && e.msg.startsWith('[DEF] ')), 'baris antrean berlabel entitas');
        const stopJ = await POST('/api/run/stop?session=' + encodeURIComponent('run:' + R.J.run));
        assert.strictEqual(stopJ.status, 200);
        await done(R.J.run);
        assert.ok(!gates.has(R.J.run), 'proses yang dibatalkan tidak pernah mulai');
        assert.ok(lines.some((e) => e.run === R.J.run && /Antrean dibatalkan/.test(e.msg)));
        const st = (await GET('/api/run/status')).json;
        assert.deepStrictEqual(st.runs.filter((r) => r.queued).map((r) => r.id).sort((a, b) => a - b), [R.F.run, R.G.run, R.I.run].sort((a, b) => a - b));
    });

    await test('Jeda / Lewati / Hentikan satu proses tidak memengaruhi yang lain; log per proses', async () => {
        await POST('/api/run/pause?session=' + encodeURIComponent('run:' + R.A.run));
        gates.get(R.A.run).allowed = 3;
        gates.get(R.B.run).allowed = 1;
        await until(async () => (await statusOf('run:' + R.B.run)).plan.states[0] === 'ok');
        await sleep(60);
        assert.deepStrictEqual((await statusOf('run:' + R.A.run)).plan.states, ['wait', 'wait', 'wait'], 'A dijeda: tidak maju');
        assert.strictEqual((await statusOf('run:' + R.A.run)).paused, true);
        assert.strictEqual((await statusOf('run:' + R.B.run)).paused, false);
        // Lewati langkah B yang sedang ditunggu: hanya B.
        await POST('/api/run/skip?session=' + encodeURIComponent('run:' + R.B.run));
        await until(async () => (await statusOf('run:' + R.B.run)).plan.states[1] === 'skip');
        assert.deepStrictEqual((await statusOf('run:' + R.D.run)).plan.states.slice(0, 2), ['ok', 'ok']);
        // Hentikan C (billing BUDI): hanya C; jendela totalnya bebas -> G (antre karena batas total) mulai di p-rina~2.
        await POST('/api/run/stop?session=p-budi');
        await done(R.C.run);
        assert.ok(lines.some((e) => e.run === R.C.run && /Proses dihentikan oleh pengguna/.test(e.msg) && e.msg.startsWith('[BUDI] ')));
        await started(R.G.run);
        assert.strictEqual(gates.get(R.G.run).window, 'p-rina~2');
        assert.strictEqual((await statusOf('run:' + R.F.run)).queued, true, 'F tetap antre: jendela PIC Andi masih penuh');
        await POST('/api/run/resume?session=' + encodeURIComponent('run:' + R.A.run));
        await done(R.A.run);
        // Log: setiap baris langkah membawa proses dan pool/entitasnya; /api/run/log hanya proses itu.
        const aLines = lines.filter((e) => e.run === R.A.run && /^\[CSA\] langkah/.test(e.msg));
        assert.strictEqual(aLines.length, 3); assert.ok(aLines.every((e) => e.pool === 'p-andi' && e.entity === 'CSA' && e.session === 'p-andi'));
        const rl = (await GET('/api/run/log?session=' + encodeURIComponent('run:' + R.D.run) + '&lines=50')).json;
        assert.ok(rl.lines.length >= 2 && rl.lines.every((l) => l.includes('[MKA] ')), JSON.stringify(rl.lines));
    });

    await test('antrean mulai sendiri berurutan: jendela yang bebas ke proses antre pertama PIC itu; kunci dilepas -> fitur yang sama mulai di jendela entitasnya', async () => {
        await started(R.F.run);
        assert.strictEqual(gates.get(R.F.run).window, 'p-andi', 'F (SPT DEF) mendapat jendela yang dilepas A');
        assert.strictEqual((await statusOf('run:' + R.I.run)).queued, true);
        await finishRun(R.E.run);
        await started(R.I.run);
        assert.strictEqual(gates.get(R.I.run).window, 'p-andi~3', 'e-Faktur CSA kedua: jendela yang sudah login sebagai CSA');
    });

    await test('jalur PIC cadangan (SPT): jendela PIC lain yang semuanya dipakai tidak direbut - menunggu lalu dilewati', async () => {
        runcontrol.timing.BORROW_WAIT_MS = 250;
        await POST('/api/settings/parallel', { perPic: 3, total: 6 }); // B, D, F, G, I berjalan: satu jendela lagi
        R.K =(await POST('/api/actions/download-spt', { entity: ent('MKA', 'p-rina'), jenisPajakKeys: ['pph21'], masaInput: '0126' })).json;
        assert.strictEqual(R.K.session, 'p-rina~3');
        await started(R.K.run);
        gates.get(R.K.run).all = true;
        await done(R.K.run);
        const t = fallbackTries.find((x) => x.run === R.K.run);
        assert.ok(t && /Jendela Coretax PIC ini sedang dipakai proses lain/.test(t.error), JSON.stringify(t));
        assert.ok(lines.some((e) => e.run === R.K.run && /Gagal masuk sebagai PIC lain \(p-andi\)/.test(e.msg)));
        for (const w of ['p-andi', 'p-andi~2', 'p-andi~3']) assert.ok(runcontrol.isBusy(w), w + ' tetap milik prosesnya');
    });

    await test('jalur PIC cadangan: meminjam jendela bebas PIC lain; jendela pinjaman tidak bisa diambil proses lain sampai dilepas', async () => {
        await finishRun(R.D.run); // p-andi~2 bebas
        R.L = (await POST('/api/actions/download-spt', { entity: ent('MKA', 'p-rina'), jenisPajakKeys: ['pph21'], masaInput: '0226' })).json;
        await started(R.L.run);
        gates.get(R.L.run).all = true;
        await until(() => gates.get(R.L.run).borrowed, 3000, 'pinjam jendela');
        assert.strictEqual(gates.get(R.L.run).borrowed, 'p-andi~2');
        R.M = (await POST('/api/actions/login-entity', { entity: ent('XYZ', 'p-andi') })).json;
        assert.strictEqual(R.M.queued, true, 'semua jendela PIC Andi dipakai / dipinjam');
        gates.get(R.L.run).releaseBorrow = true;
        await done(R.L.run);
        await done(R.M.run);
        assert.strictEqual((await statusOf('run:' + R.M.run)).window, 'p-andi~2', 'jendela pinjaman dilepas -> login antre mendapatkannya');
    });

    await test('login saja lalu aksi: memakai jendela yang sudah login sebagai entitas itu (tanpa jendela baru)', async () => {
        const before = launches.length;
        R.N = (await POST('/api/actions/download-ebupot', { entity: ent('XYZ', 'p-andi'), bupotType: 'bp21', masaInput: '0126' })).json;
        assert.strictEqual(R.N.session, 'p-andi~2', 'jendela tempat XYZ login');
        await started(R.N.run);
        assert.strictEqual(launches.length, before, 'tidak ada Chrome baru');
        await finishRun(R.N.run);
    });

    await test('Dividen (kasus harus terbuka di jendela entitas itu): berjalan di jendela kasusnya walau jendela lain bebas', async () => {
        // p-andi~3: I (CSA) masih berjalan; p-andi~2 bebas; kasus CSA terbuka di p-andi~3.
        contexts.get(launches.find((d) => path.basename(d) === 'p-andi~3')).pageUrl = 'https://coretaxdjp.pajak.go.id/e-reporting/case-overview/12345678-1234-1234-1234-123456789012';
        const r = (await POST('/api/actions/check-dividen', { entity: ent('CSA', 'p-andi'), fileBase64: Buffer.from('uji').toString('base64') })).json;
        assert.strictEqual(r.queued, true, 'menunggu jendela kasusnya (dipakai e-Faktur CSA), tidak pindah ke jendela lain');
        await finishRun(R.I.run);
        await started(r.run);
        assert.strictEqual((await statusOf('run:' + r.run)).window, 'p-andi~3');
        await finishRun(r.run);
    });

    await test('route hasil (runForResult): menunggu antrean, lalu 409 dengan pesan lama bila tidak bisa mulai; 200 bila giliran tiba', async () => {
        W.limits.RESULT_QUEUE_MS = 300;
        await POST('/api/settings/parallel', { perPic: 1, total: 5 });
        // Jendela p-andi masih dipakai F (SPT DEF).
        const t0 = Date.now();
        const a = await POST('/api/ebupot/issue-preview', { entity: ent('GHI', 'p-andi'), type: 'bpu', period: '0126' });
        assert.strictEqual(a.status, 409); assert.ok(/Sesi ini masih menjalankan "SPT pph21/.test(a.json.error), a.json.error);
        assert.ok(Date.now() - t0 >= 250, 'menunggu dulu, tidak langsung 409');
        W.limits.RESULT_QUEUE_MS = 3000;
        const pending = POST('/api/ebupot/issue-preview', { entity: ent('GHI', 'p-andi'), type: 'bpu', period: '0126' });
        await sleep(100);
        await finishRun(R.F.run);
        const b = await pending;
        assert.strictEqual(b.status, 200, JSON.stringify(b.json)); assert.strictEqual(b.json.token, 'T');
        await POST('/api/settings/parallel', { perPic: 3, total: 5 });
    });

    await test('deep link: antrean yang sama - dua entitas satu PIC berjalan bersamaan, tautan identik (klik ganda) diabaikan', async () => {
        const deeplink = require('../lib/deeplink');
        const sbUrl = Object.values(require('../lib/supabase-projects'))[0].url;
        const url = (entity) => 'taxio-coretax://open?org=o1&pic=p-zed&token=t&sbUrl=' + encodeURIComponent(sbUrl) + '&entity=' + entity + '&name=PT%20' + entity;
        let release; deeplinkGate = { promise: new Promise((r) => { release = r; }) };
        const d1 = deeplink.dispatch(url('Z1')), d2 = deeplink.dispatch(url('Z2'));
        await until(() => runcontrol.isBusy('p-zed') && runcontrol.isBusy('p-zed~2'), 3000, 'dua jendela p-zed');
        await deeplink.dispatch(url('Z1'));
        assert.ok(lines.some((e) => /Deep link taxio-coretax:\/\/ ditolak: Perintah yang sama untuk entitas ini sudah berjalan/.test(e.msg)));
        release(); deeplinkGate = null;
        await Promise.all([d1, d2]);
        assert.strictEqual(lines.filter((e) => /Deep link selesai/.test(e.msg)).length, 2);
    });

    await test('folder profil: satu per jendela, nama sah di Windows, jendela pertama = folder lama PIC; perawatan profil mengenalinya', async () => {
        const names = launches.map((d) => path.basename(d));
        assert.strictEqual(new Set(launches.map((d) => d.toLowerCase())).size, launches.length, 'tidak ada dua jendela berbagi profil');
        assert.ok(names.every((n) => /^[^<>:"/\\|?*]+$/.test(n)), names.join(', '));
        for (const n of ['p-andi', 'p-andi~2', 'p-andi~3', 'p-rina', 'p-rina~2', 'p-rina~3', 'p-budi', 'p-zed', 'p-zed~2']) assert.ok(names.includes(n), n);
        assert.strictEqual(path.basename((await require('../lib/chrome-profile').browserLaunch('local:le_1:pic_2~2')).userDataDir), 'local_le_1_pic_2~2');
        const hk = require('../lib/profile-housekeeping');
        const scan = await hk.scan({ sizes: false });
        const w = scan.profiles.find((p) => p.name === 'p-andi~3');
        assert.ok(w && w.pic === 'p-andi' && w.window === 3, JSON.stringify(w));
        assert.strictEqual(scan.profiles.find((p) => p.name === 'p-andi').window, 1);
        const own = require('../lib/chrome-profile');
        assert.ok(own.isOwnProfileDir(launches.find((d) => path.basename(d) === 'p-andi~2')));
        assert.deepStrictEqual(own.findProfileProcessPids([{ pid: 11, ppid: 1, name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir=' + launches.find((d) => path.basename(d) === 'p-andi') }], launches.find((d) => path.basename(d) === 'p-andi~2')), [], 'jendela ke-2 tidak pernah menutup Chrome jendela pertama');
    });

    await test('kunci berkas: dua penulis rekap yang sama bergiliran, berkas lain tidak menunggu', async () => {
        const { withFileLock, _pending } = require('../lib/file-lock');
        const order = [];
        const f = path.join(TMP, 'Rekap.xlsx');
        const w1 = withFileLock(f, async () => { order.push('1+'); await sleep(40); order.push('1-'); });
        const w2 = withFileLock(f.toUpperCase(), async () => { order.push('2+'); order.push('2-'); });
        const w3 = withFileLock(path.join(TMP, 'lain.xlsx'), async () => { order.push('x'); });
        await Promise.all([w1, w2, w3]);
        assert.deepStrictEqual(order.filter((o) => o !== 'x'), ['1+', '1-', '2+', '2-']);
        assert.ok(order.indexOf('x') < order.indexOf('1-'), 'berkas lain tidak menunggu');
        await assert.rejects(withFileLock(f, async () => { throw new Error('gagal'); }));
        await withFileLock(f, async () => {});
        assert.strictEqual(_pending(), 0);
    });

    await test('sesudah semuanya selesai: tidak ada jendela / kunci / antrean / proses yang tertinggal', async () => {
        for (const [id, g] of gates) { g.all = true; g.releaseBorrow = true; }
        await until(async () => !(await GET('/api/run/status')).json.anyActive, 5000, 'semua proses selesai');
        assert.deepStrictEqual(runcontrol._debugState(), { queue: 0, holders: [], locks: [], active: [] });
        assert.strictEqual(require('../lib/file-lock')._pending(), 0);
        const st = (await GET('/api/run/status')).json;
        assert.ok(st.runs.every((r) => !r.active && !r.queued));
    });

    server.close();
    for (const c of contexts.values()) await c.close();
    console.log(passed + ' tes lulus' + (failed ? ', ' + failed + ' GAGAL' : '.'));
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
