/* Tes batch "unduh untuk banyak klien" (batch di body aksi, GET /api/runs batches, POST /api/runs/stop-batch) lewat route HTTP
 * sungguhan dengan kerja tiruan; tanpa jaringan / Chrome. Jalankan: node scripts/test-runs-batch.js */
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
    console.log('runs batch');
    await POST('/api/connect', { project: 'taxio_hub', email: 'uji@contoh.com', password: 'x' });
    await POST('/api/settings/parallel', { perPic: 1, total: 2 });
    const bt = (id, index, total) => ({ id, label: 'Unduh Bukti Potong 0126', index, total });
    const dl = (e, pic, batch) => POST('/api/actions/download-mybupot', { entity: ent(e, pic), buktiTypeKeys: ['bp21'], masaInput: '0126', batch });
    const batchOf = async (id) => (await runs()).batches.find((b) => b.id === id);
    const B = {};

    await test('batch 5 unduhan di 2 PIC: batches menghitung antre / berjalan', async () => {
        const spec = [['A1', 'p-1'], ['A2', 'p-2'], ['A3', 'p-1'], ['A4', 'p-2'], ['A5', 'p-1']];
        B.runs = [];
        for (let i = 0; i < 5; i++) { const r = await dl(spec[i][0], spec[i][1], bt('bt-1', i, 5)); assert.strictEqual(r.status, 202, JSON.stringify(r.json)); B.runs.push(r.json.run); }
        const r = await runs();
        const all = [...r.needsYou, ...r.inProgress];
        assert.ok(all.every((x) => x.batch && x.batch.id === 'bt-1'));
        assert.deepStrictEqual(all.map((x) => x.batch.index).sort(), [0, 1, 2, 3, 4]);
        assert.strictEqual(r.batches.length, 1);
        const b = r.batches[0];
        assert.deepStrictEqual([b.id, b.label, b.feature, b.total], ['bt-1', 'Unduh Bukti Potong 0126', 'download-mybupot', 5]);
        assert.deepStrictEqual(b.counts, { queued: 3, running: 2, hold: 0, done: 0, failed: 0, stopped: 0 });
        assert.strictEqual(b.endedAt, null); assert.strictEqual(typeof b.startedAt, 'number');
        const d = (await GET('/api/runs/run:' + B.runs[0])).json;
        assert.deepStrictEqual(d.batch, { id: 'bt-1', label: 'Unduh Bukti Potong 0126', index: 0, total: 5 });
    });

    await test('hitungan batch mengikuti kemajuan (selesai, ditahan)', async () => {
        await until(() => gates.get(B.runs[0]) && gates.get(B.runs[1]), 3000, 'mulai');
        await finish(B.runs[0]);
        await until(async () => (await batchOf('bt-1')).counts.done === 1, 3000, 'done 1');
        const g = gates.get(B.runs[1]); g.hold = true; g.allowed = 1;
        await until(async () => (await batchOf('bt-1')).counts.hold === 1, 3000, 'hold');
        const b = await batchOf('bt-1');
        assert.strictEqual(b.counts.done + b.counts.hold + b.counts.running + b.counts.queued, 5, JSON.stringify(b.counts));
        await POST('/api/run/resume?session=run:' + B.runs[1]);
        await until(async () => (await batchOf('bt-1')).counts.hold === 0, 3000, 'lanjut');
    });

    await test('perintah identik per klien tetap ditolak di dalam batch; klien lain tidak', async () => {
        const dup = await dl('A5', 'p-1', bt('bt-1', 4, 5));
        assert.strictEqual(dup.status, 409, JSON.stringify(dup.json));
        const other = await dl('A6', 'p-2', bt('bt-1', 5, 6));
        assert.strictEqual(other.status, 202, JSON.stringify(other.json));
        B.runs.push(other.json.run);
        assert.strictEqual((await batchOf('bt-1')).total, 6);
    });

    await test('stop-batch: antre dibatalkan, yang berjalan dihentikan; yang selesai tidak dihitung', async () => {
        const r = await POST('/api/runs/stop-batch', { id: 'bt-1' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true);
        assert.strictEqual(r.json.stopped, 5, 'lima masih aktif / antre dari enam (satu sudah selesai)');
        const b = await until(async () => { const x = await batchOf('bt-1'); return x && x.endedAt && x; }, 5000, 'batch berhenti');
        assert.strictEqual(b.counts.done, 1); assert.strictEqual(b.counts.stopped, 5, JSON.stringify(b.counts));
        assert.strictEqual(b.counts.queued + b.counts.running + b.counts.hold, 0);
        assert.strictEqual((await POST('/api/runs/stop-batch', { id: 'bt-1' })).json.stopped, 0);
    });

    await test('stop-batch: id tak dikenal 404, id tidak valid 400', async () => {
        assert.strictEqual((await POST('/api/runs/stop-batch', { id: 'tidak-ada' })).status, 404);
        assert.strictEqual((await POST('/api/runs/stop-batch', { id: '../x' })).status, 400);
        assert.strictEqual((await POST('/api/runs/stop-batch', {})).status, 400);
    });

    await test('batch ditolak pada fitur yang mengubah data Coretax (tidak ada proses dibuat)', async () => {
        const before = (await runs()).done.length;
        const r = await POST('/api/actions/billing-pph25', { entity: ent('BBB', 'p-3'), masaInput: '0726', nominal: '1000', batch: bt('bt-2', 0, 2) });
        assert.strictEqual(r.status, 400, JSON.stringify(r.json)); assert.ok(/batch/i.test(r.json.error), r.json.error);
        const x = await runs();
        assert.strictEqual(x.done.length, before); assert.strictEqual(x.inProgress.length, 0);
        assert.ok(!x.batches.some((b) => b.id === 'bt-2'));
        const ok = await POST('/api/actions/billing-pph25', { entity: ent('BBB', 'p-3'), masaInput: '0726', nominal: '1000' });
        assert.strictEqual(ok.status, 202); await finish(ok.json.run);
    });

    await test('batch tidak valid ditolak 400', async () => {
        const bad = [
            { id: '', label: 'x', index: 0, total: 1 }, { id: 'a b', label: 'x', index: 0, total: 1 }, { id: 'a'.repeat(65), label: 'x', index: 0, total: 1 },
            { id: 'a/../b', label: 'x', index: 0, total: 1 }, { id: 5, label: 'x', index: 0, total: 1 }, { label: 'x', index: 0, total: 1 },
            { id: 'ok', label: 'x'.repeat(200), index: 0, total: 1 }, { id: 'ok', label: {}, index: 0, total: 1 },
            { id: 'ok', label: 'x', index: -1, total: 1 }, { id: 'ok', label: 'x', index: 1, total: 1 }, { id: 'ok', label: 'x', index: 0, total: 0 },
            { id: 'ok', label: 'x', index: 0.5, total: 2 }, { id: 'ok', label: 'x', index: '0', total: 2 }, { id: 'ok', label: 'x', index: 0, total: 1e9 },
            'bt', ['x'], 7
        ];
        for (const b of bad) { const r = await dl('ZZZ', 'p-5', b); assert.strictEqual(r.status, 400, JSON.stringify(b) + ' -> ' + r.status); assert.ok(r.json.error); }
        const x = await runs(); assert.ok(!x.batches.some((b) => b.id === 'ok'));
        assert.strictEqual(x.inProgress.length, 0);
    });

    await test('proses tanpa batch tidak terpengaruh: batch null, tidak masuk batches', async () => {
        const r = await dl('N1', 'p-6', undefined); assert.strictEqual(r.status, 202);
        const n = await POST('/api/actions/download-mybupot', { entity: ent('N2', 'p-7'), buktiTypeKeys: ['bp21'], masaInput: '0126', batch: null });
        assert.strictEqual(n.status, 202);
        const d = (await GET('/api/runs/run:' + r.json.run)).json; assert.strictEqual(d.batch, null);
        const x = await runs(); assert.ok(x.inProgress.every((i) => i.batch === null));
        assert.deepStrictEqual(x.batches.map((b) => b.id), ['bt-1']);
        await finish(r.json.run); await finish(n.json.run);
    });

    server.close();
    console.log(passed + ' tes lulus' + (failed ? ', ' + failed + ' GAGAL' : '.'));
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
