/* Stop / Jeda (dan Lewati di unduhan multi-masa) benar-benar berlaku di setiap fitur - fungsi ASLI dijalankan di dalam
 * proses runcontrol terhadap halaman / sesi Coretax tiruan dengan beban lambat beberapa unit:
 *   - Stop di tengah: proses selesai cepat, TIDAK ADA permintaan tulis sesudah yang sedang berjalan, baris ringkasan
 *     "Dihentikan: ..." dan hasil sebagian (Excel / hasil.json) benar;
 *   - Jeda: tidak ada permintaan selama dijeda, Lanjut meneruskan tepat dari tempatnya, tidak ada yang terkirim dua kali;
 *   - kontrol yang tidak didukung fitur ditolak; status memuat controls / stopRequested / pauseRequested;
 *   - route POST baru tanpa deklarasi fitur + kontrolnya membuat tes ini gagal.
 * Data rekaan (nama dan nomor palsu). Tanpa jaringan, tanpa Chrome. Jalankan: node scripts/test-run-controls.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-ctl-'));
process.env.TAXIO_PILOT_DATA_DIR = process.env.TAXIO_PILOT_DATA_DIR || TMP;
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
// Fitur yang menulis ke ~/Downloads (Hasil Impor Pajak Masukan) menulis ke folder sementara.
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.USERPROFILE = HOME; process.env.HOME = HOME;

const ExcelJS = require('exceljs');
const runcontrol = require('../lib/runcontrol');
const runControls = require('../lib/run-controls');
const { onLogLine } = require('../lib/log');
const logs = [];
onLogLine((e) => logs.push(e.line));
runcontrol.timing.PAUSE_POLL_MS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) { const end = Date.now() + (ms || 5000); while (!(await cond())) { if (Date.now() > end) throw new Error('tidak terjadi: ' + what); await sleep(5); } }
const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

/** Menjalankan `fn` sebagai proses fitur `feature` (tanpa jendela). { key, run, done -> { value } | { error } }. */
let seq = 0;
function inRun(feature, fn) {
    let run;
    const done = runcontrol.isolate(async () => {
        const q = runcontrol.enqueue('UJI ' + feature, { feature, windowed: false, sig: feature + '|' + (++seq) });
        run = q.run;
        await q.ready;
        try { return { value: await fn() }; } catch (e) { return { error: e }; } finally { runcontrol.finish(run); }
    });
    return { get key() { return 'run:' + run.id; }, get run() { return run; }, done };
}
const statusOf = (h) => runcontrol.status(h.key);
/** Jeda lalu tunggu sampai proses benar-benar tertahan di titik aman; mengembalikan status saat jeda baru diminta. */
async function pauseAndHold(h) {
    runcontrol.pause(h.key);
    const asked = statusOf(h);
    await until(() => statusOf(h).paused && !statusOf(h).pauseRequested, 3000, 'proses tertahan');
    return asked;
}
/** Selama `ms` tidak boleh ada permintaan baru di `list`. */
async function quietFor(list, ms) { const n = list.length; await sleep(ms); assert.strictEqual(list.length, n, 'ada permintaan ke Coretax selama dijeda'); }

// ---------------------------------------------------------------------------------------------------------------
// Halaman Coretax tiruan untuk automation/pajakmasukan.js + efaktur.js (fetch di dalam halaman lewat string evaluate).
function invoices(n, period) {
    return Array.from({ length: n }, (_, i) => ({
        RecordId: 'R' + period + '-' + i, TaxInvoiceNumber: '01000000' + period.slice(-2) + String(1000000 + i).slice(1), SellerTIN: '0000000000000001', SellerTaxpayerName: 'PT CONTOH PEMASOK',
        BuyerTaxpayerAggregateIdentifier: 'AGG-1', BuyerTIN: '0000000000000002', BuyerTaxpayerNameClear: 'PT CONTOH PEMBELI',
        TaxInvoiceDate: '2026-' + period.slice(-2) + '-0' + ((i % 9) + 1) + 'T00:00:00', TaxInvoicePeriod: period, TaxInvoiceYear: 2026,
        SellingPrice: 10000 * (i + 1), OtherTaxBase: 0, VAT: 1100 * (i + 1), TaxInvoiceStatus: 'APPROVED', InputInvoiceStatus: 'APPROVED', ReportedByBuyer: false, Valid: true
    }));
}
function invoicePage({ byPeriod, writeMs = 30, onRequest } = {}) {
    const all = () => Object.values(byPeriod).flat();
    const requests = [], writes = [];
    const parse = (script) => {
        const p = /fetch\("([^"]+)"/.exec(script)[1].replace('/einvoiceportal/api', '');
        const a = script.indexOf('body:JSON.stringify(') + 'body:JSON.stringify('.length, b = script.lastIndexOf(')});');
        return { path: p, body: JSON.parse(script.slice(a, b)) };
    };
    const ok = (payload) => ({ __http: 200, __json: { IsSuccessful: true, Payload: payload } });
    const page = {
        goto: async () => {}, waitForTimeout: async (ms) => sleep(Math.min(ms, 5)),
        evaluate: async (script) => {
            if (/vatStatus"\) !== null/.test(script)) return true;
            if (/taxpayer_id/.test(script) && !/fetch\(/.test(script)) return { agg: 'AGG-1', representative: null, npwp: '0000000000000002', expiresInSec: 1800 };
            if (!/fetch\(/.test(script)) return { vatStatus: 'PKP', npwp: '0000000000000002', expiresInSec: 1800, url: 'x' };
            const { path: p, body } = parse(script);
            requests.push({ path: p, body });
            if (onRequest) await onRequest(p, body, requests, writes);
            if (/\/list$/.test(p)) {
                const f = body.Filters || [];
                const num = f.find((x) => x.PropertyName === 'TaxInvoiceNumber');
                if (num) return ok({ Data: all().filter((x) => x.TaxInvoiceNumber === num.Value).map((x) => ({ ...x })) });
                const per = f.find((x) => /Period$/.test(x.PropertyName));
                const code = per ? (Array.isArray(per.Value) ? per.Value[0] : per.Value) : null;
                const rows = code ? (byPeriod[code] || []) : all();
                return ok({ Data: rows.slice(body.First, body.First + body.Rows).map((x) => ({ ...x })) });
            }
            if (/credit-uncredit/.test(p)) {
                writes.push(body.RecordId || body.RecordIds[0]);
                await sleep(writeMs);
                const inv = all().find((x) => x.RecordId === (body.RecordId || body.RecordIds[0]));
                inv.TaxInvoiceStatus = body.BuyerStatus; inv.PeriodCredit = body.Period; inv.YearCredit = body.Year;
                return ok(null);
            }
            if (/bulk-process-monitoring$/.test(p)) return ok({ Data: [] });
            if (/EInvoiceExport\/export$/.test(p)) { writes.push('export:' + body.EInvoiceMenuType + ':' + body.PeriodCode); return ok(null); }
            return { __http: 404, __json: null };
        }
    };
    return { page, requests, writes };
}
async function importWorkbook(invs) {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Import');
    ws.addRow(['No Faktur', 'NPWP', 'Nama Lawan Transaksi', 'Tanggal Faktur', 'DPP', 'PPN', 'Pengkreditan PPN', 'Masa Pengkreditan', 'Hasil', 'Status Coretax', 'Masa Kredit Aktual', 'Keterangan']);
    for (const x of invs) {
        const d = new Date(x.TaxInvoiceDate);
        ws.addRow([x.TaxInvoiceNumber, x.SellerTIN, x.SellerTaxpayerName, new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), x.SellingPrice, x.VAT, 'MASA SAMA', new Date(Date.UTC(2026, 0, 1)), '', '', '', '']);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}
const PM_OUT = path.join(HOME, 'Downloads', 'CoretaxAgent', 'PajakMasukan');
const latestPmResult = () => { const f = fs.readdirSync(PM_OUT).filter((n) => /^Hasil Impor/.test(n)).sort().pop(); return path.join(PM_OUT, f); };

// Sesi e-Bupot / SPT tiruan untuk lib/coretax-issue.js, coretax-import.js, konsep-download.js (auth ditangkap dari request).
function apiPage({ route, onPost }) {
    const listeners = [], posts = [], gotos = [];
    const claims = Buffer.from(JSON.stringify({ taxpayer_id: 'TP-1', sub: '0000000000000009' })).toString('base64url');
    const context = { on: (ev, fn) => listeners.push(fn), off: (ev, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
    const page = {
        context: () => context,
        goto: async (url) => {
            gotos.push(url);
            for (const part of ['/withholdingslipsportal/api/', '/returnsheetportal/api/']) for (const fn of listeners.slice()) fn({ url: () => 'https://coretaxdjp.pajak.go.id' + part + 'x', headers: () => ({ authorization: 'Bearer h.' + claims + '.s' }) });
            if (page.onGoto) page.onGoto(url);
        },
        waitForTimeout: async (ms) => sleep(Math.min(ms, 5)), waitForLoadState: async () => {},
        evaluate: async (fn, args) => {
            const [u, body] = args;
            const name = u.split('/').slice(-2).join('/');
            posts.push({ name, body });
            if (onPost) await onPost(name, body, posts);
            return route(name, body, args.length === 5);
        }
    };
    return { page, posts, gotos };
}

(async () => {
    // ------------------------------------------------------------------ deklarasi
    await test('setiap route POST mendeklarasikan fitur prosesnya, dan setiap fitur kontrolnya (lib/run-controls.js)', async () => {
        const { ROUTES, ROUTE_FEATURES } = require('../gui/server')._routes;
        const posts = Object.keys(ROUTES).filter((k) => k.startsWith('POST '));
        const missing = posts.filter((k) => !Object.prototype.hasOwnProperty.call(ROUTE_FEATURES, k));
        assert.deepStrictEqual(missing, [], 'route POST tanpa deklarasi di gui/server.js ROUTE_FEATURES (fitur + kontrolnya): ' + missing.join(', '));
        assert.deepStrictEqual(Object.keys(ROUTE_FEATURES).filter((k) => !ROUTES[k]), [], 'ROUTE_FEATURES memuat route yang sudah tidak ada');
        const declared = new Set(Object.values(ROUTE_FEATURES).flat());
        for (const f of declared) assert.ok(runControls.isDeclared(f), 'fitur "' + f + '" belum ada di lib/run-controls.js FEATURES');
        // Fitur yang benar-benar dipakai kode server / deep link harus tercantum (supaya deklarasi tidak tertinggal).
        const src = fs.readFileSync(path.join(__dirname, '..', 'gui', 'server.js'), 'utf8');
        const used = new Set();
        for (const m of src.matchAll(/withRules\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?,\s*'([a-z0-9-]+)'\s*,/g)) used.add(m[1]);
        for (const m of src.matchAll(/feature:\s*'([a-z0-9:-]+)'/g)) used.add(m[1]);
        for (const m of src.matchAll(/ebupotEdit\('([a-z-]+)'\)/g)) used.add('ebupot-' + m[1]);
        const dl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deeplink.js'), 'utf8');
        used.add('deeplink:login');
        for (const m of dl.matchAll(/params\.action === '([a-z0-9-]+)'/g)) if (m[1] !== 'open') used.add('deeplink:' + m[1]);
        assert.ok(used.size >= 30, 'pemindai sumber menemukan terlalu sedikit fitur (' + used.size + ')');
        const undeclared = [...used].filter((f) => !declared.has(f) || !runControls.isDeclared(f));
        assert.deepStrictEqual(undeclared, [], 'fitur dipakai tanpa deklarasi route / kontrol: ' + undeclared.join(', '));
        // Hanya unduhan berbasis kombinasi yang mengklaim Ulang / Mundur / ukuran halaman.
        for (const [f, c] of Object.entries(runControls.FEATURES)) {
            assert.ok(c.stop, f + ': Stop harus selalu ada');
            if (c.retry || c.back || c.pageSize) assert.ok(['download-spt', 'download-ebupot', 'download-mybupot', 'deeplink:download-spt', 'deeplink:mode-a1'].includes(f), f + ' mengklaim kontrol kombinasi');
        }
    });

    // ------------------------------------------------------------------ runcontrol
    await test('runcontrol: kontrol per fitur ada di status (juga antre), yang tidak didukung ditolak, Stop/Jeda tampil "menunggu titik aman"', async () => {
        let gate = false;
        const h = inRun('issue-preview', async () => { for (;;) { await runcontrol.checkpoint(); if (gate) return 'ok'; await sleep(5); } });
        await until(() => statusOf(h).active, 2000, 'mulai');
        let st = statusOf(h);
        assert.deepStrictEqual(st.controls, { stop: true, pause: false, skip: false, retry: false, back: false, pageSize: false });
        assert.ok(st.runs.find((r) => r.id === h.run.id).controls, 'ringkasan per proses (tab sesi / MCP) memuat controls');
        const n = logs.length;
        runcontrol.pause(h.key); runcontrol.skip(h.key); runcontrol.retry(h.key); runcontrol.back(h.key); runcontrol.setPageSizeOverride(50, h.key);
        st = statusOf(h);
        assert.strictEqual(st.paused, false, 'Jeda ditolak untuk fitur tanpa Jeda');
        assert.strictEqual(logs.slice(n).filter((l) => /tidak tersedia untuk proses ini/.test(l)).length, 5, logs.slice(n).join('\n'));
        runcontrol.stop(h.key);
        assert.strictEqual(statusOf(h).stopRequested, true, 'stopRequested segera terlihat');
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.strictEqual(statusOf(h).stopRequested, false, 'selesai: tidak lagi "stopping"');

        // Kombinasi: Lewati / Ulang / Mundur / ukuran halaman diterima seperti sebelumnya.
        const seen = [];
        const c = inRun('download-spt', async () => {
            for (let i = 0; i < 400; i++) {
                try { await runcontrol.checkpoint(); } catch (e) { if (e.isStop) throw e; seen.push(e.isSkip ? 'skip' : e.isRetry ? 'retry' : 'back'); }
                const ps = runcontrol.takePageSizeOverride(); if (ps) seen.push('size' + ps);
                await sleep(2);
            }
        });
        await until(() => statusOf(c).active, 2000, 'mulai');
        for (const [fn, want] of [[() => runcontrol.skip(c.key), 'skip'], [() => runcontrol.retry(c.key), 'retry'], [() => runcontrol.back(c.key), 'back'], [() => runcontrol.setPageSizeOverride(25, c.key), 'size25']]) {
            fn(); await until(() => seen.includes(want), 2000, want);
        }
        const asked = await pauseAndHold(c);
        assert.strictEqual(asked.pauseRequested, true, '"Pausing…" sebelum titik aman');
        assert.strictEqual(statusOf(c).pauseRequested, false, 'tertahan: paused, bukan lagi pausing');
        runcontrol.stop(c.key);
        assert.ok((await c.done).error.isStop);

        // Antre: controls sudah ada; fitur tak dikenal = Stop + Jeda.
        assert.deepStrictEqual(runControls.controlsFor('fitur-baru-belum-terdaftar'), { stop: true, pause: true, skip: false, retry: false, back: false, pageSize: false });
        const hold = runcontrol.isolate(() => runcontrol.enqueue('pegang', { key: 'pic-Q', feature: 'download-ebupot' }));
        const q = runcontrol.isolate(() => runcontrol.enqueue('antre', { key: 'pic-Q', window: 'pic-Q', feature: 'download-mybupot' }));
        await hold.ready;
        const qs = runcontrol.status('run:' + q.run.id);
        assert.ok(qs.queued && qs.controls.skip && qs.controls.pageSize);
        runcontrol.stop('run:' + q.run.id); await q.ready.catch(() => {});
        runcontrol.finish(hold.run);
    });

    // ------------------------------------------------------------------ Pajak Masukan (pengkreditan, mengubah data)
    const pm = require('../automation/pajakmasukan');
    await test('Faktur Masukan crediting: Stop di tengah = baris yang sedang dikirim selesai, tidak ada tulis sesudahnya, ringkasan + Excel sebagian', async () => {
        const byPeriod = { 'TD.00701': invoices(8, 'TD.00701') };
        let h;
        const fake = invoicePage({ byPeriod, onRequest: async (p, body, req, writes) => { if (/credit-uncredit/.test(p) && writes.length === 2) runcontrol.stop(h.key); } });
        const file = await importWorkbook(byPeriod['TD.00701']);
        h = inRun('import-pajak-masukan', () => pm.runImportFromExcel({ page: fake.page, fileBuffer: file, targetMasaInput: '0126', emit: (m) => logs.push('[pm] ' + m) }));
        const t0 = Date.now(), r = await h.done;
        assert.ok(r.error && r.error.isStop, 'berakhir sebagai Stop');
        assert.ok(Date.now() - t0 < 4000, 'berhenti cepat');
        assert.strictEqual(fake.writes.length, 3, 'tulis ke-3 (sedang berjalan saat Stop) selesai, tidak ada tulis ke-4');
        assert.ok(logs.some((l) => /Dihentikan: 3 dari 8 baris sudah diproses \(SUKSES: 3, 3 berubah di Coretax\); 5 belum diproses\. Hasil sebagian tersimpan di: /.test(l)), 'ringkasan Stop');
        const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(latestPmResult());
        const hasil = []; wb.worksheets[0].eachRow((row, n) => { if (n > 1) hasil.push(row.getCell(9).value); });
        assert.deepStrictEqual(hasil, ['SUKSES', 'SUKSES', 'SUKSES', 'BELUM DIPROSES', 'BELUM DIPROSES', 'BELUM DIPROSES', 'BELUM DIPROSES', 'BELUM DIPROSES']);
        assert.strictEqual(byPeriod['TD.00701'].filter((x) => x.TaxInvoiceStatus === 'CREDITED').length, 3, 'Coretax: tepat 3 dikreditkan');
    });
    await test('Faktur Masukan crediting: Jeda = tidak ada permintaan selama dijeda, Lanjut meneruskan tanpa duplikat', async () => {
        const byPeriod = { 'TD.00701': invoices(6, 'TD.00701') };
        let h, asked = null;
        const fake = invoicePage({ byPeriod, onRequest: async (p, body, req, writes) => { if (/credit-uncredit/.test(p) && writes.length === 1 && !asked) { asked = true; runcontrol.pause(h.key); } } });
        const file = await importWorkbook(byPeriod['TD.00701']);
        h = inRun('import-pajak-masukan', () => pm.runImportFromExcel({ page: fake.page, fileBuffer: file, targetMasaInput: '0126', emit: () => {} }));
        await until(() => asked && statusOf(h).paused && !statusOf(h).pauseRequested, 4000, 'tertahan');
        assert.strictEqual(fake.writes.length, 2, 'baris yang sedang berjalan selesai dulu');
        await quietFor(fake.requests, 300);
        runcontrol.resume(h.key);
        const r = await h.done;
        assert.ok(!r.error, r.error && r.error.message);
        assert.strictEqual(fake.writes.length, 6); assert.strictEqual(new Set(fake.writes).size, 6, 'tidak ada faktur dikirim dua kali');
    });

    // ------------------------------------------------------------------ Pajak Masukan download (Lewati per masa)
    await test('Download Pajak Masukan: Lewati = masa yang sedang diambil tidak masuk Excel; Stop = ringkasan, tanpa file', async () => {
        const byPeriod = { 'TD.00701': invoices(3, 'TD.00701'), 'TD.00702': invoices(4, 'TD.00702'), 'TD.00703': invoices(5, 'TD.00703') };
        let h, act = 'skip';
        const fake = invoicePage({ byPeriod, onRequest: async (p, body) => { const f = (body.Filters || []).find((x) => x.PropertyName === 'TaxInvoicePeriod'); if (f && f.Value[0] === 'TD.00702') runcontrol[act](h.key); } });
        const saveRoot = path.join(TMP, 'pm-dl');
        h = inRun('download-pajak-masukan', () => pm.runDownloadExcel({ page: fake.page, masaList: ['0126', '0226', '0326'], saveRoot, entityFolder: 'UJI', emit: (m) => logs.push('[pmdl] ' + m) }));
        const r = await h.done;
        assert.ok(!r.error, r.error && r.error.message);
        assert.strictEqual(r.value.totalRows, 8, 'masa 0226 (4 faktur) dilewati, 0126 + 0326 ada');
        assert.ok(logs.some((l) => /Februari 2026: dilewati atas permintaan pengguna/.test(l)));
        assert.ok(logs.some((l) => /Masa yang dilewati pengguna \(tidak ada di Excel\): 0226\./.test(l)));
        act = 'stop';
        const before = fs.readdirSync(path.join(saveRoot, 'UJI', 'PajakMasukan')).length;
        h = inRun('download-pajak-masukan', () => pm.runDownloadExcel({ page: fake.page, masaList: ['0126', '0226', '0326'], saveRoot, entityFolder: 'UJI', emit: (m) => logs.push('[pmdl] ' + m) }));
        const r2 = await h.done;
        assert.ok(r2.error && r2.error.isStop);
        assert.ok(logs.some((l) => /Dihentikan: 1 dari 3 masa sudah diambil \(0126\); 2 belum diproses\. File Excel tidak dibuat\./.test(l)), 'ringkasan Stop');
        assert.strictEqual(fs.readdirSync(path.join(saveRoot, 'UJI', 'PajakMasukan')).length, before, 'tidak ada Excel setengah jadi');
    });

    // ------------------------------------------------------------------ e-Faktur
    const efaktur = require('../automation/efaktur');
    await test('e-Faktur: Lewati satu jenis x masa di fase Excel; Stop saat menunggu CSV resmi = berhenti menunggu, ringkasan', async () => {
        const byPeriod = { 'TD.00701': invoices(2, 'TD.00701'), 'TD.00702': invoices(3, 'TD.00702') };
        let h;
        const fake = invoicePage({ byPeriod, onRequest: async (p, body) => { const f = (body.Filters || []).find((x) => x.PropertyName === 'TaxInvoicePeriod'); if (p === '/outputinvoice/list' && f && f.Value === 'TD.00701') runcontrol.skip(h.key); } });
        h = inRun('download-efaktur', () => efaktur.runDownloadEfaktur({ page: fake.page, types: ['input', 'output'], masaList: ['0126', '0226'], excel: true, csv: false, saveRoot: path.join(TMP, 'ef'), entityFolder: 'UJI', entityName: 'PT CONTOH', emit: (m) => logs.push('[ef] ' + m) }));
        const r = await h.done;
        assert.ok(!r.error, r.error && r.error.message);
        assert.deepStrictEqual(r.value.skipped, [{ key: 'output', label: 'Pajak Keluaran', masa: '0126' }]);
        assert.deepStrictEqual(r.value.perType.map((t) => [t.key, t.count, t.incomplete]), [['input', 5, false], ['output', 3, true]]);
        // CSV resmi: file tidak pernah jadi; Stop di tengah penantian.
        let polls = 0;
        const fake2 = invoicePage({ byPeriod, onRequest: async (p) => { if (/bulk-process-monitoring$/.test(p) && ++polls === 4) runcontrol.stop(h.key); } });
        const jobs = ['TD.00701', 'TD.00702'].map((code) => ({ type: efaktur.TYPE_BY_KEY.input, code, year: '2026', mmYY: code.slice(-2) + '26', dest: path.join(TMP, code + '.zip') }));
        h = inRun('download-efaktur', () => efaktur.exportCsvBatch(fake2.page, { agg: 'AGG-1' }, jobs, (m) => logs.push('[ef] ' + m), { pollMs: 5, maxWaitMs: 60000 }));
        const t0 = Date.now(), r2 = await h.done;
        assert.ok(r2.error && r2.error.isStop); assert.ok(Date.now() - t0 < 3000, 'tidak menunggu 60 detik');
        assert.strictEqual(fake2.writes.filter((w) => /^export:/.test(w)).length, 2);
        assert.ok(logs.some((l) => /Dihentikan \(menunggu file dari Coretax\): 2 dari 2 permintaan CSV resmi sudah dikirim ke Coretax, 0 file sudah diunduh; 0 belum diminta/.test(l)));
    });

    // ------------------------------------------------------------------ BPMP NIK amend + cancel (mengubah data)
    const amend = require('../automation/bpmp-amend');
    function bpmpSession({ onAmend, onCancel } = {}) {
        const slips = [];
        for (const [old, n] of [['3170000000000001', 3], ['3170000000000002', 3]]) for (let i = 0; i < n; i++) slips.push({ RecordId: 'S' + old.slice(-1) + i, WithholdingSlipsNumber: 'BP-' + old.slice(-1) + i, TaxPeriodCode: '0' + (i + 1) + '0' + (i + 1) + '2026', TaxIdentificationNumber: old, Name: 'NAMA LAMA ' + old.slice(-1), GrossIncome: 5000000 + i, IncomeTaxWithheld: 0, WithholdingSlipsStatus: 'NORMAL' });
        const calls = [], amends = [], cancels = [];
        const s = {
            auth: { claims: { taxpayer_id: 'TP-1' } },
            list: async (endpoint, code) => { calls.push('list ' + code); return slips.filter((x) => x.TaxPeriodCode === code && !cancels.includes(x.RecordId)).map((x) => ({ ...x })); },
            find: async (endpoint, code, number) => { calls.push('find ' + number); const x = slips.find((y) => y.WithholdingSlipsNumber === number); return x ? { ...x } : null; },
            lookup: async (nik) => { calls.push('lookup ' + nik); return { payload: { Name: nik === '3170000000000011' ? 'ANDI CONTOH' : 'BUDI CONTOH', TaxpayerType: 'INDIVIDUAL' } }; },
            post: async (url, body) => {
                calls.push(url.split('/').pop());
                if (/viewebupotmp$/.test(url)) return { status: 200, json: { Payload: { Result: { ...slips.find((x) => x.RecordId === body.RecordId) } } } };
                if (/amendebupotmp$/.test(url)) {
                    amends.push(body.RecordId);
                    if (onAmend) await onAmend(amends);
                    await sleep(20);
                    const x = slips.find((y) => y.RecordId === body.RecordId); x.TaxIdentificationNumber = body.TaxIdentificationNumber; x.Name = body.Name; x.WithholdingSlipsStatus = 'AMENDMENT';
                    return { status: 200, json: { IsSuccessful: true } };
                }
                if (/cancelebupotmp$/.test(url)) { cancels.push(body.EBUPOTIdentifiers[0].RecordIdentifier); if (onCancel) await onCancel(cancels); await sleep(20); return { status: 200, json: { IsSuccessful: true } }; }
                return { status: 404, json: null };
            },
            close: async () => {}
        };
        return { s, slips, calls, amends, cancels };
    }
    const TARGETS = [{ old: '3170000000000001', newNik: '3170000000000011', newName: 'ANDI CONTOH' }, { old: '3170000000000002', newNik: '3170000000000021', newName: 'BUDI CONTOH' }];
    await test('Pembetulan NIK BPMP: Stop di tengah = bukti potong yang sedang dikirim selesai + diperiksa, ringkasan, hasil.json sebagian', async () => {
        let h;
        const f = bpmpSession({ onAmend: async (a) => { if (a.length === 4) runcontrol.stop(h.key); } });
        const outDir = path.join(TMP, 'bpmp-stop'), emitted = [];
        h = inRun('bpmp-amend', () => amend.run({ context: null, session: f.s, npwp: null, targets: TARGETS, year: '2026', submit: true, outDir, emit: (m) => emitted.push(m) }));
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.strictEqual(f.amends.length, 4, 'tidak ada /amend sesudah yang sedang berjalan');
        assert.strictEqual(r.error.results.length, 4); assert.ok(r.error.results.every((x) => x.status === 'DIBETULKAN'), 'yang terkirim juga terverifikasi');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'hasil.json'), 'utf8')).length, 4);
        assert.ok(emitted.some((m) => /^Dihentikan: 4 bukti potong sudah diproses \(4 dibetulkan, 0 tidak dikirim\); 1 dari 2 NIK Baru belum \(selesai\) diproses/.test(m)), emitted.join('\n'));
    });
    await test('Pembetulan NIK BPMP: Jeda menahan sebelum bukti potong berikutnya, Lanjut tanpa duplikat', async () => {
        let h, paused = false;
        const f = bpmpSession({ onAmend: async (a) => { if (a.length === 2 && !paused) { paused = true; runcontrol.pause(h.key); } } });
        h = inRun('bpmp-amend', () => amend.run({ context: null, session: f.s, npwp: null, targets: TARGETS, year: '2026', submit: true, outDir: path.join(TMP, 'bpmp-pause'), emit: () => {} }));
        await until(() => paused && statusOf(h).paused && !statusOf(h).pauseRequested, 4000, 'tertahan');
        await quietFor(f.calls, 300);
        runcontrol.resume(h.key);
        const r = await h.done;
        assert.ok(!r.error, r.error && r.error.message);
        assert.strictEqual(f.amends.length, 6); assert.strictEqual(new Set(f.amends).size, 6);
    });
    await test('Pembatalan BPMP (Tindakan = Batalkan): Stop di antara pembatalan, yang dikirim dicatat (e.done)', async () => {
        let h;
        const f = bpmpSession({ onCancel: async (c) => { if (c.length === 2) runcontrol.stop(h.key); } });
        const cancels = f.slips.slice(0, 4).map((x) => ({ number: x.WithholdingSlipsNumber, masa: x.TaxPeriodCode.slice(0, 2), nik: x.TaxIdentificationNumber, name: x.Name }));
        const emitted = [];
        h = inRun('bpmp-amend', () => amend.cancelSlips({ session: f.s, npwp: null, year: '2026', cancels, confirmed: cancels.map((c) => c.number), emit: (m) => emitted.push(m) }));
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.strictEqual(f.cancels.length, 2); assert.strictEqual(r.error.done.length, 2); assert.ok(r.error.done.every((x) => x.ok));
        assert.ok(emitted.some((m) => /^Dihentikan: 2 dari 4 bukti potong yang dikonfirmasi sudah dibatalkan; 2 belum diproses\./.test(m)), emitted.join('\n'));
    });

    // ------------------------------------------------------------------ Terbitkan (issue) per kelompok
    const iss = require('../lib/coretax-issue');
    function issueFake(onIssue) {
        const rows = Array.from({ length: 100 }, (_, i) => ({ RecordId: 'NI' + i, WithholdingSlipsStatus: 'SUBMITTED', TaxIdentificationNumber: '31700000000' + String(10000 + i), Name: 'PEGAWAI ' + i, GrossIncome: 1000 + i, IncomeTaxWithheld: 10 }));
        const issued = [];
        const f = apiPage({
            onPost: async (name, body, posts) => { if (/issueebupotmp$/.test(name) && onIssue) await onIssue(posts.filter((p) => /issueebupotmp$/.test(p.name)).length); },
            route: async (name, body) => {
                if (/getebupotmpnotissued$/.test(name)) return { status: 200, json: { Payload: { Data: rows.filter((r) => !issued.includes(r.RecordId)).slice(body.First, body.First + body.Rows) } } };
                if (/getebupotmpissued$/.test(name)) return { status: 200, json: { Payload: { Data: rows.filter((r) => issued.includes(r.RecordId)).slice(body.First, body.First + body.Rows) } } };
                if (/issueebupotmp$/.test(name)) { await sleep(20); issued.push(...body.EBUPOTIdentifiers.map((x) => x.RecordIdentifier)); return { status: 200, json: { IsSuccessful: true } }; }
                return { status: 404, json: null };
            }
        });
        return { ...f, rows, issued, token: iss.tokenOf(rows) };
    }
    await test('Terbitkan e-Bupot: Stop di antara kelompok - kelompok yang terkirim utuh, ringkasan "x dari y", sisanya tetap Belum Terbit', async () => {
        let h;
        const f = issueFake((n) => { if (n === 3) runcontrol.stop(h.key); });
        const emitted = [];
        h = inRun('issue-ebupot', () => iss.issue(f.page, { type: 'mp', period: '0126', token: f.token, batch: 20, emit: (m) => emitted.push(m) }));
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.strictEqual(f.posts.filter((p) => /issueebupotmp$/.test(p.name)).length, 3, 'tidak ada kelompok ke-4');
        assert.strictEqual(f.issued.length, 60); assert.deepStrictEqual(r.error.partial.sent, 60);
        assert.ok(emitted.some((m) => /^Dihentikan: 60 dari 100 bukti potong BPMP masa 01012026 sudah dikirim untuk diterbitkan; 40 belum dikirim - tetap di Belum Terbit/.test(m)), emitted.join('\n'));
    });
    await test('Terbitkan e-Bupot: Jeda di antara kelompok, Lanjut tanpa duplikat', async () => {
        let h, paused = false;
        const f = issueFake((n) => { if (n === 2 && !paused) { paused = true; runcontrol.pause(h.key); } });
        h = inRun('issue-ebupot', () => iss.issue(f.page, { type: 'mp', period: '0126', token: f.token, batch: 20 }));
        await until(() => paused && statusOf(h).paused && !statusOf(h).pauseRequested, 4000, 'tertahan');
        await quietFor(f.posts, 300);
        runcontrol.resume(h.key);
        const r = await h.done;
        assert.ok(!r.error, r.error && r.error.message);
        assert.strictEqual(r.value.issued, 100); assert.strictEqual(new Set(f.issued).size, 100); assert.strictEqual(f.issued.length, 100);
    });

    // ------------------------------------------------------------------ Upload ke Belum Terbit, Buat Konsep, Unduh Konsep
    const imp = require('../lib/coretax-import');
    await test('Upload ke Belum Terbit: Stop sebelum unggah = 0 terkirim; Stop saat menunggu monitoring = file terkirim satu kali, tidak ditunggu', async () => {
        const prepared = { type: 'mp', count: 3, tin: '0000000000000009', xml: '<MmPayrollBulk/>' };
        const route = async (name, body, isFile) => (isFile ? { status: 200, json: { IsSuccessful: true } } : { status: 200, json: { Payload: [{ FileName: 'Uji.xml', CreationDate: new Date().toISOString(), Status: 'PROCESSING' }] } });
        let h;
        const f1 = apiPage({ route });
        f1.page.onGoto = () => runcontrol.stop(h.key);
        const emitted = [];
        h = inRun('import-coretax', () => imp.upload(f1.page, prepared, { fileName: 'Uji.xml', emit: (m) => emitted.push(m) }));
        assert.ok((await h.done).error.isStop);
        assert.strictEqual(f1.posts.length, 0, 'tidak ada unggahan');
        assert.ok(emitted.some((m) => /^Dihentikan sebelum file diunggah - tidak ada bukti potong yang dibuat \(0 dari 3\)\./.test(m)));
        let polls = 0;
        const f2 = apiPage({ route, onPost: async (name) => { if (/xml-monitoring$/.test(name) && ++polls === 3) runcontrol.stop(h.key); } });
        h = inRun('import-coretax', () => imp.upload(f2.page, prepared, { fileName: 'Uji.xml', emit: (m) => emitted.push(m), timeoutMs: 600000 }));
        const t0 = Date.now(), r = await h.done;
        assert.ok(r.error.isStop); assert.ok(Date.now() - t0 < 3000);
        assert.strictEqual(f2.posts.filter((p) => /validate-upload-xml$/.test(p.name)).length, 1);
        assert.ok(emitted.some((m) => /^Dihentikan: file Uji\.xml \(3 bukti potong\) SUDAH terkirim dan diproses Coretax \(status terakhir PROCESSING\)/.test(m)));
    });
    await test('Buat Konsep SPT: Stop sebelum satu-satunya permintaan tulis = tidak dibuat', async () => {
        let h;
        const f = apiPage({
            onPost: async (name) => { if (/createreturnsheetreturnsheetmodels$/.test(name)) runcontrol.stop(h.key); },
            route: async (name) => ({ status: 200, json: { IsSuccessful: true, Payload: /types$/.test(name) ? [{ Code: 'RST' }] : /taxperiods$/.test(name) ? [{ Code: '01012026' }] : [{ Code: 'NORMAL' }] } })
        });
        const emitted = [];
        h = inRun('create-konsep', () => imp.createKonsep(f.page, { taxType: 'ICT_WIT', period: '0126', emit: (m) => emitted.push(m) }));
        assert.ok((await h.done).error.isStop);
        assert.strictEqual(f.posts.filter((p) => /\/createreturnsheet$/.test(p.name)).length, 0);
        assert.ok(emitted.includes('Dihentikan sebelum Konsep SPT dibuat - tidak ada yang berubah di Coretax.'));
    });
    await test('Posting & unduh Konsep: Stop saat menunggu status posting = posting tercatat terkirim, lampiran tidak dibuka', async () => {
        let h, status = 0;
        const f = apiPage({
            onPost: async (name, body) => { if (/article-2126$/.test(name) && body.onManualClick === false && ++status === 3) runcontrol.stop(h.key); },
            route: async (name, body) => {
                if (/returnsheetsnotsubmitted$/.test(name)) return { status: 200, json: { Payload: { Data: [{ TaxTypeCode: 'ICT_WIT', TaxPeriodCode: '01012026', RecordId: 'K1', AggregateIdentifier: 'A1' }] } } };
                if (/article-2126$/.test(name)) return { status: 200, json: { IsSuccessful: true, Payload: body.onManualClick ? {} : { PrefillStatus: 'IN_PROGRESS' } } };
                return { status: 404, json: null };
            }
        });
        const emitted = [];
        h = inRun('konsep-download', () => require('../lib/konsep-download').downloadKonsep(f.page, { taxType: 'ICT_WIT', period: '0126', post: true, outDir: path.join(TMP, 'konsep'), emit: (m) => emitted.push(m) }));
        assert.ok((await h.done).error.isStop);
        assert.strictEqual(f.posts.filter((p) => p.body && p.body.onManualClick === true).length, 1, 'Posting sekali');
        assert.ok(!f.gotos.some((u) => /article-21-26-tax-return/.test(u)), 'form konsep / lampiran tidak dibuka');
        assert.ok(emitted.some((m) => /^Dihentikan saat menunggu status posting: Posting SUDAH dikirim ke Coretax \(status IN_PROGRESS\); konsep belum diunduh\./.test(m)), emitted.join('\n'));
    });

    // ------------------------------------------------------------------ Ubah / batal e-Bupot (lib/ebupot-edit.js)
    const ed = require('../lib/ebupot-edit');
    function editFake(onCancel) {
        const base = { TaxCertificateCode: '9', TaxArticle: 'Pasal 21', TaxObjectReferenceCode: 1, RevenueCode: '411121-100', BranchId: 'B', IsReportedToTaxReturn: false, TaxPeriodCode: '01012026', WithholdingSlipsStatus: 'NORMAL', TaxObjectCode: '21-100-01', GrossIncome: 5000000, TaxRate: 0, IncomeTaxWithheld: 0, TaxExemptionStatus: 'TK0' };
        const slips = [1, 2, 3, 4].map((i) => ({ ...base, RecordId: 'r' + i, WithholdingslipsAggregateIdentifier: 'a' + i, WithholdingSlipsNumber: 'N-' + i, TaxIdentificationNumber: '311111111111000' + i, Name: 'NAMA ' + i }));
        const cancelled = [], calls = [];
        const s = {
            auth: { claims: { taxpayer_id: 'TP-1' } },
            list: async () => { calls.push('list'); return slips.filter((x) => !cancelled.includes(x.RecordId)).map((x) => ({ ...x })); },
            lookup: async () => ({ payload: { TaxpayerType: 'INDIVIDUAL' } }),
            post: async (url, body) => { calls.push(url); if (/cancelebupotmp/.test(url)) { cancelled.push(body.EBUPOTIdentifiers[0].RecordIdentifier); if (onCancel) await onCancel(cancelled); await sleep(15); return { status: 200, json: { IsSuccessful: true } }; } return { status: 404, json: null }; },
            close: async () => {}
        };
        return { page: { __session: s }, cancelled, calls };
    }
    await test('Batal e-Bupot: Jeda di antara bukti potong; Stop = yang terkirim dicatat, StopRunError (bukan SELESAI)', async () => {
        let h, paused = false;
        const f = editFake((c) => { if (c.length === 1 && !paused) { paused = true; runcontrol.pause(h.key); } if (c.length === 3) runcontrol.stop(h.key); });
        const nums = ['N-1', 'N-2', 'N-3', 'N-4'];
        const pv = await ed.previewCancel(f.page, { period: '0126', numbers: nums });
        const emitted = [];
        h = inRun('ebupot-cancel', () => ed.cancel(f.page, { period: '0126', numbers: nums, token: pv.token, emit: (m) => emitted.push(m) }));
        await until(() => paused && statusOf(h).paused && !statusOf(h).pauseRequested, 4000, 'tertahan');
        await quietFor(f.calls, 300);
        runcontrol.resume(h.key);
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.deepStrictEqual(f.cancelled, ['r1', 'r2', 'r3'], 'tanpa duplikat, tidak ada pembatalan ke-4');
        assert.strictEqual(r.error.done.length, 3);
        assert.ok(emitted.some((m) => /^Dihentikan pengguna - 3 dari 4 pembatalan sudah dikirim \(3 dibatalkan\), 1 tidak dikirim \(tetap Telah Terbit\)\./.test(m)), emitted.join('\n'));
    });

    // ------------------------------------------------------------------ Dividen: penantian yang bisa dihentikan / dijeda
    const div = require('../automation/dividen').__test;
    await test('Dividen: menunggu draft / tombol Simpan bisa dihentikan; Jeda memundurkan tenggat (bukan dianggap "tidak siap")', async () => {
        const page = { frames: () => [], evaluate: async () => ({ found: false, seen: [] }) };
        let h = inRun('import-dividen', () => div.trySaveDraft(page));
        await sleep(80); runcontrol.stop(h.key);
        let t0 = Date.now(), r = await h.done;
        assert.ok(r.error && r.error.isStop); assert.ok(Date.now() - t0 < 2500);
        h = inRun('create-dividen-case', () => div.waitForDraftRecord(page, 'AGG', 60000));
        await sleep(80); runcontrol.stop(h.key);
        t0 = Date.now(); r = await h.done;
        assert.ok(r.error && r.error.isStop); assert.ok(Date.now() - t0 < 2500, 'tidak menunggu 60 detik');
        // Draft siap pada detik ke-1,6; tenggat 1 detik, tetapi proses dijeda 1 detik di tengah -> tetap ketemu.
        const readyAt = Date.now() + 1600;
        const page2 = { evaluate: async () => ({ found: Date.now() >= readyAt, seen: [] }) };
        h = inRun('create-dividen-case', () => div.waitForDraftRecord(page2, 'AGG', 1000));
        await sleep(100); await pauseAndHold(h); await sleep(1000); runcontrol.resume(h.key);
        r = await h.done;
        assert.ok(!r.error && r.value.found, 'jeda tidak menghabiskan tenggat');
    });

    // ------------------------------------------------------------------ BPMP bernilai 0 (Mode A1 / cek NIK)
    await test('Pembatalan otomatis BPMP 0 (cek e-Bupot vs SPT): Stop di antara pembatalan dengan ringkasan', async () => {
        const vs = require('../lib/ebupot-vs-spt');
        const rows = [];
        // NIK yang berhenti berpenghasilan sesudah Maret: BPMP April-Juni bernilai 0 -> kandidat batal.
        for (let m = 1; m <= 6; m++) rows.push({ RecordId: 'Z' + m, WithholdingSlipsNumber: 'Z-' + m, TaxPeriodCode: String(m).padStart(2, '0') + String(m).padStart(2, '0') + '2026', TaxIdentificationNumber: '3170000000000777', Name: 'CONTOH', GrossIncome: m <= 3 ? 1000000 : 0, IncomeTaxWithheld: 0, WithholdingSlipsStatus: 'NORMAL' });
        const planned = vs.zeroToCancel(rows.map((r, i) => ({ ...r, _masa: i + 1 }))).cancel.length;
        assert.ok(planned >= 2, 'fixture: ada >= 2 BPMP 0 untuk dibatalkan (' + planned + ')');
        let h; const posts = [];
        const s = {
            list: async (endpoint, code) => rows.filter((r) => r.TaxPeriodCode === code && !posts.includes(r.RecordId)).map((r) => ({ ...r })),
            post: async (url, body) => { posts.push(body.EBUPOTIdentifiers[0].RecordIdentifier); if (posts.length === 1) runcontrol.stop(h.key); await sleep(10); return { status: 200, json: { IsSuccessful: true } }; }
        };
        const emitted = [];
        h = inRun('bpmp-sweep', () => vs.autoCancelZero(s, '2026', (m) => emitted.push(m)));
        const r = await h.done;
        assert.ok(r.error && r.error.isStop);
        assert.strictEqual(posts.length, 1, 'pembatalan yang sedang berjalan selesai, tidak ada yang berikutnya');
        assert.ok(emitted.some((m) => new RegExp('^Dihentikan: 1 dari ' + planned + ' BPMP bernilai 0 sudah dibatalkan; ' + (planned - 1) + ' belum diproses\\.').test(m)), emitted.join('\n'));
    });

    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' tes lulus.');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* abaikan */ }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
