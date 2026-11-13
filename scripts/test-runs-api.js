/* Tes API halaman Runs (GET /api/runs, /api/runs/<key>, open-folder, clear-done, kabar SSE 'runs') lewat route HTTP
 * sungguhan gui/server.js dengan kerja tiruan yang lambat; tanpa jaringan / Chrome. Jalankan: node scripts/test-runs-api.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-runs-'));
process.env.TAXIO_PILOT_DATA_DIR = TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + (ms || 4000); for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('tidak terjadi: ' + what); await sleep(10); } }

const shell = require('../lib/shell');
const opened = [];
shell.register({ openPath: async (p) => { opened.push(p); return ''; } });
const sessionStore = require('../lib/session-store');
const entitiesLib = require('../lib/entities');
const ok = (data) => Promise.resolve({ data, error: null });
const fake = { auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) }, rpc: (n) => ok(n === 'get_my_active_membership' ? [{ org_id: 'o1' }] : null), from: () => ({ select: () => ({ eq: () => ({ limit: () => ok([]) }) }) }) };
const PROJECT = { id: 'taxio_hub', label: 'Taxio Hub' };
sessionStore.clientFor = () => ({ client: fake, project: PROJECT });
sessionStore.connectWithPassword = async (id, email) => ({ client: fake, project: PROJECT, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, user: { id: 'u-1', email } });
sessionStore.refreshIfNeeded = async () => {};
entitiesLib.getMyOrgId = async () => ({ org_id: 'o1', role: 'editor' });
entitiesLib.getOtherLinkedPicIds = async () => [];
entitiesLib.resolveAuthorizedPic = async (c, o, pic) => ({ picId: pic, passphrase: null, fallbackPicIds: [] });
entitiesLib.getCredential = async (c, o, pic) => ({ username: 'nik-' + pic, pic_name: pic });
entitiesLib.getPassphrase = async () => null;

const runcontrol = require('../lib/runcontrol');
const { log } = require('../lib/log');
const gates = new Map(); // id -> { all, allowed, hold, started }
// Kerja tiruan: rencana 3 langkah, folder hasil per entitas, baris SELESAI di akhir; Stop -> StopRunError.
async function fakeWork(opts, label) {
    const run = runcontrol.current();
    const g = gates.get(run.id) || { allowed: 0, all: false }; gates.set(run.id, g); g.started = true;
    const dir = path.join(TMP, 'out', String((opts.entity && opts.entity.entity_id) || 'x'));
    fs.mkdirSync(dir, { recursive: true });
    runcontrol.setOutput(dir);
    runcontrol.setPlan([{ label: 'Masa 0126', short: '0126' }, { label: 'Masa 0226', short: '0226' }, { label: 'Masa 0326', short: '0326' }]);
    for (let i = 0; i < 3; i++) {
        for (;;) {
            await runcontrol.checkpoint();
            if (g.all || g.allowed > i) break;
            if (g.hold && i === 1) { runcontrol.markCombo(i, 'run'); g.hold = false; runcontrol.pauseForDecision('Coretax tidak menjawab.'); }
            await sleep(5);
        }
        runcontrol.markCombo(i, 'run'); runcontrol.markCombo(i, 'ok');
    }
    log('SELESAI: ' + label + ' beres.');
}
require('../automation/ebupot').runEbupotDownload = (o) => fakeWork(o, 'e-Bupot');
require('../automation/mybupot').runMyBuktiPotongDownload = (o) => fakeWork(o, 'Bukti Potong Saya');
require('../automation/billing').runBillingPph25 = (o) => fakeWork(o, 'Kode Billing');
const { createGuiServer } = require('../gui/server');

let BASE = '', TOKEN = '';
async function call(method, url, body) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (e) { /* bukan JSON */ }
    return { status: res.status, json };
}
const GET = (u) => call('GET', u), POST = (u, b) => call('POST', u, b === undefined ? {} : b);
const ent = (id, pic) => ({ project: 'taxio_hub', entity_id: id, entity_name: 'PT ' + id + ' Contoh', npwp: '0123456789012345', individual: false, pic_id: pic });
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } }
const runs = async () => (await GET('/api/runs')).json;
const finish = async (id) => {
    await until(() => gates.get(id), 5000, 'mulai ' + id);
    gates.get(id).all = true;
    await until(async () => { const r = await runs(); return ![...r.needsYou, ...r.inProgress].some((x) => x.id === id); }, 5000, 'selesai ' + id);
};

(async () => {
    const server = await createGuiServer(0);
    TOKEN = server.token; BASE = 'http://127.0.0.1:' + server.address().port;
    console.log('runs api');
    await POST('/api/connect', { project: 'taxio_hub', email: 'uji@contoh.com', password: 'x' });
    await POST('/api/settings/parallel', { perPic: 1, total: 2 });
    const ev = []; // kabar SSE
    const sse = http.get(BASE + '/events', { headers: { Authorization: 'Bearer ' + TOKEN } }, (res) => { res.on('data', (d) => { for (const m of String(d).matchAll(/"event":"(\w+)"/g)) ev.push(m[1]); }); });
    const R = {};

    await test('bagian: berjalan + antre digabung, posisi antre, batas', async () => {
        R.A = (await POST('/api/actions/download-ebupot', { entity: ent('AAA', 'p-1'), bupotType: 'bpu', masaInput: '0126' })).json;
        R.B = (await POST('/api/actions/billing-pph25', { entity: ent('BBB', 'p-2'), masaInput: '0726', nominal: '1000' })).json;
        R.C = (await POST('/api/actions/download-mybupot', { entity: ent('CCC', 'p-1'), buktiTypeKeys: ['bp21'], masaInput: '0126' })).json;
        R.D = (await POST('/api/actions/download-mybupot', { entity: ent('DDD', 'p-3'), buktiTypeKeys: ['bp21'], masaInput: '0126' })).json;
        assert.ok(!R.A.queued && !R.B.queued && R.C.queued && R.D.queued, JSON.stringify([R.A, R.B, R.C, R.D]));
        const r = await runs();
        assert.deepStrictEqual(r.needsYou, []); assert.deepStrictEqual(r.done, []);
        assert.deepStrictEqual(r.inProgress.map((x) => x.id), [R.A.run, R.B.run, R.C.run, R.D.run]);
        assert.deepStrictEqual(r.inProgress.map((x) => x.state), ['running', 'running', 'queued', 'queued']);
        assert.deepStrictEqual(r.inProgress.slice(2).map((x) => x.queue.position), [1, 2]);
        assert.ok(r.inProgress[2].queue.reasonText.length > 5);
        assert.deepStrictEqual(r.limits, { perPic: 1, total: 2, running: 2 });
    });

    await test('key publik run:<id>; entitas, fitur, changesCoretax, kontrol, outputDir', async () => {
        await until(() => gates.get(R.A.run) && gates.get(R.B.run), 3000, 'mulai');
        const r = await runs();
        const a = r.inProgress.find((x) => x.id === R.A.run), b = r.inProgress.find((x) => x.id === R.B.run);
        assert.strictEqual(a.key, 'run:' + R.A.run);
        assert.deepStrictEqual([a.entity.id, a.entity.name, a.entity.npwp], ['AAA', 'PT AAA Contoh', '0123456789012345']);
        assert.strictEqual(a.feature, 'download-ebupot'); assert.strictEqual(a.changesCoretax, false);
        assert.strictEqual(b.feature, 'billing-pph25'); assert.strictEqual(b.changesCoretax, true);
        assert.strictEqual(typeof a.controls.pause, 'boolean');
        assert.strictEqual(a.pic, 'p-1');
        assert.strictEqual(a.progress.total, 3);
        assert.ok(a.outputDir && a.outputDir.endsWith('AAA'));
    });

    await test('kemajuan dan GET /api/runs/<key> dengan log', async () => {
        gates.get(R.A.run).allowed = 1;
        await until(async () => (await runs()).inProgress.find((x) => x.id === R.A.run).progress.done === 1, 3000, 'progres');
        const d = (await GET('/api/runs/run:' + R.A.run)).json;
        assert.strictEqual(d.progress.items[0].state, 'ok'); assert.ok(Array.isArray(d.lines));
        assert.strictEqual((await GET('/api/runs/detail?key=run:' + R.A.run)).json.id, R.A.run);
        assert.strictEqual((await GET('/api/runs/run:9999')).status, 404);
        assert.strictEqual((await GET('/api/run/log?session=run:' + R.A.run)).status, 200);
    });

    await test('ditahan masuk needsYou dengan pilihan; lanjut kembali ke inProgress', async () => {
        gates.get(R.B.run).hold = true; gates.get(R.B.run).allowed = 1;
        const b = await until(async () => (await runs()).needsYou.find((x) => x.id === R.B.run), 3000, 'hold');
        assert.strictEqual(b.state, 'hold'); assert.strictEqual(b.hold.reason, 'Coretax tidak menjawab.');
        const ids = b.hold.choices.map((c) => c.id);
        assert.ok(ids.includes('retry') && ids.includes('stop'), ids.join());
        assert.strictEqual(ids.includes('skip'), !!b.controls.skip);
        await POST('/api/run/resume?session=run:' + R.B.run);
        await until(async () => (await runs()).inProgress.some((x) => x.id === R.B.run), 3000, 'kembali');
    });

    await test('Stop -> stopped dengan ringkasan dan outputDir; antrean maju', async () => {
        await POST('/api/run/stop?session=run:' + R.B.run);
        const d = await until(async () => (await runs()).done.find((x) => x.id === R.B.run), 4000, 'stopped');
        assert.strictEqual(d.state, 'stopped'); assert.ok(/dihentikan/i.test(d.outcome.text), d.outcome.text);
        assert.ok(d.outputDir && d.endedAt);
        await until(async () => (await runs()).inProgress.some((x) => x.id === R.D.run && x.state === 'running'), 3000, 'antre maju');
    });

    await test('selesai -> done dengan baris SELESAI; riwayat menyimpan banyak per PIC', async () => {
        for (const k of ['A', 'C', 'D']) await finish(R[k].run);
        const r = await runs();
        const a = r.done.find((x) => x.id === R.A.run);
        assert.strictEqual(a.state, 'done'); assert.ok(/^SELESAI: e-Bupot beres/.test(a.outcome.text), a.outcome.text);
        assert.strictEqual(r.done.length, 4);
        assert.ok(r.done[0].endedAt >= r.done[3].endedAt, 'terbaru dulu');
        assert.strictEqual(r.done.filter((x) => x.pic === 'p-1').length, 2, 'dua proses selesai di PIC yang sama tetap ada');
    });

    await test('open-folder: kunci tak dikenal ditolak, path dari body diabaikan, folder tercatat dibuka', async () => {
        assert.strictEqual((await POST('/api/runs/open-folder', { key: 'run:9999' })).status, 404);
        assert.strictEqual((await POST('/api/runs/open-folder', { path: 'C:\\Windows' })).status, 404);
        assert.deepStrictEqual(opened, []);
        const r = await POST('/api/runs/open-folder', { key: 'run:' + R.A.run, path: 'C:\\Windows', dir: 'C:\\Windows' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.deepStrictEqual(opened, [path.join(TMP, 'out', 'AAA')]);
    });

    await test('riwayat dibatasi dan clear-done', async () => {
        const prev = runcontrol._setKeepDone(2);
        const x = (await POST('/api/actions/download-ebupot', { entity: ent('EEE', 'p-9'), bupotType: 'bpu', masaInput: '0126' })).json;
        await finish(x.run);
        assert.strictEqual((await runs()).done.length, 2, 'dipangkas ke batas');
        runcontrol._setKeepDone(prev);
        const c = await POST('/api/runs/clear-done');
        assert.strictEqual(c.status, 200); assert.strictEqual(c.json.cleared, 2);
        assert.deepStrictEqual((await runs()).done, []);
    });

    await test('SSE: kabar "runs" terkirim saat proses berubah, terbatas lajunya', async () => {
        ev.length = 0;
        const x = (await POST('/api/actions/download-ebupot', { entity: ent('FFF', 'p-8'), bupotType: 'bpu', masaInput: '0126' })).json;
        await until(() => ev.includes('runs'), 2000, 'event runs');
        await until(() => gates.get(x.run), 3000, 'mulai F');
        ev.length = 0;
        const t0 = Date.now();
        for (let i = 0; i < 3; i++) { gates.get(x.run).allowed = i + 1; await sleep(100); }
        await finish(x.run); await sleep(400);
        assert.ok(ev.includes('runs'));
        assert.ok(ev.filter((e) => e === 'runs').length <= Math.ceil((Date.now() - t0) / 250) + 2);
    });

    sse.destroy(); server.close();
    console.log(passed + ' tes lulus' + (failed ? ', ' + failed + ' GAGAL' : '.'));
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
