/* Tes lib/runcontrol.js: proses berjalan bersamaan per JENDELA (permintaan pengguna 2026-10-07: "Sesi baru" tidak
   boleh menunggu sesi lain; 2026-11-13: semua perintah bisa paralel, beberapa jendela per PIC, antrean bukan 409).
   Memastikan: checkpoint/setPlan/markCombo mengikuti proses alurnya sendiri (AsyncLocalStorage) walau dua proses
   saling bersilangan di await; tombol kontrol memilih proses lewat kunci; log diberi label entitas dan kunci sesi;
   satu PIC mendapat jendela "<pic>", "<pic>~2", ... sampai batas, lalu antre FIFO (Stop membatalkan antrean);
   batas total; jendela yang sudah mengimpersonate entitas dipilih dulu; perintah identik ditolak; kunci keluaran
   mengantrekan fitur yang sama untuk entitas yang sama; jendela PIC lain dipinjam (bukan direbut); tidak ada yang
   bocor sesudah semua selesai. Jalankan:
     node scripts/test-runcontrol-sessions.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TAXIO_PILOT_DATA_DIR = process.env.TAXIO_PILOT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-rc-'));
const runcontrol = require('../lib/runcontrol');
const settings = require('../lib/parallel-settings');
const loginStatus = require('../lib/login-status');
const { onLogLine } = require('../lib/log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };

(async () => {
    const lines = [];
    onLogLine((e) => lines.push(e));

    // Dua "permintaan HTTP" yang masing-masing memulai proses di sesinya sendiri.
    const order = [];
    const job = (key, tag, label, steps) => runcontrol.isolate(async () => {
        runcontrol.start(label, { key, tag });
        runcontrol.setPlan(steps.map(String));
        try {
            for (let i = 0; i < steps.length; i++) {
                await runcontrol.checkpoint();
                runcontrol.markCombo(i, 'run');
                require('../lib/log').log('langkah ' + i);
                order.push(key + i);
                await sleep(steps[i]);
                runcontrol.markCombo(i, 'ok');
            }
            return 'selesai';
        } catch (e) { return e.isStop ? 'dihentikan' : 'galat: ' + e.message; }
        finally { runcontrol.finish(); }
    });

    const a = job('pic-A', 'HBI', 'e-Bupot HBI', [40, 40, 40, 40]);
    const b = job('pic-B', 'KAP', 'Login KAP', [10, 10]);
    await sleep(5);
    let st = runcontrol.status();
    assert.strictEqual(st.runs.filter((r) => r.active).length, 2, 'dua proses harus berjalan bersamaan');
    assert.strictEqual(st.anyActive, true);
    ok('dua sesi berjalan bersamaan');

    // Sejak beberapa jendela per PIC: PIC yang sama mendapat jendela kedua, bukan ditolak.
    const second = runcontrol.isolate(() => runcontrol.start('lagi', { key: 'pic-A', tag: 'HBI' }));
    assert.strictEqual(second.key, 'pic-A~2', 'proses kedua PIC yang sama -> jendela "pic-A~2"');
    runcontrol.finish(second);
    ok('PIC yang sama selagi sibuk: jendela kedua ("<pic>~2"), bukan 409');

    assert.strictEqual(await b, 'selesai');
    st = runcontrol.status('pic-B');
    assert.strictEqual(st.active, false);
    assert.deepStrictEqual(st.plan.states, ['ok', 'ok'], 'rencana KAP harus berisi langkah KAP sendiri');
    assert.strictEqual(runcontrol.status('pic-A').active, true, 'HBI tetap berjalan sesudah KAP selesai');
    ok('rencana per proses tidak tercampur; KAP selesai, HBI masih jalan');

    // Jeda hanya sesi A.
    runcontrol.pause('pic-A');
    assert.strictEqual(runcontrol.status('pic-A').paused, true);
    const c = job('pic-B', 'KAP', 'Unduh KAP', [5]);
    assert.strictEqual(await c, 'selesai', 'sesi B harus tetap jalan walau sesi A dijeda');
    ok('Jeda di sesi A tidak menahan sesi B');

    runcontrol.stop('pic-A');
    assert.strictEqual(await a, 'dihentikan');
    assert.strictEqual(runcontrol.status('pic-A').active, false);
    assert.strictEqual(runcontrol.anyActive(), false);
    ok('Hentikan sesi A lewat kuncinya');

    const hbi = lines.filter((e) => /langkah/.test(e.msg) && e.session === 'pic-A');
    const kap = lines.filter((e) => /langkah/.test(e.msg) && e.session === 'pic-B');
    assert.ok(hbi.length >= 1 && hbi.every((e) => e.msg.startsWith('[HBI] ') && e.line.includes('] [HBI] ')), 'baris HBI berlabel');
    assert.ok(kap.length === 3 && kap.every((e) => e.msg.startsWith('[KAP] ')), 'baris KAP berlabel');
    assert.ok(hbi.every((e) => e.pool === 'pic-A' && typeof e.run === 'number'), 'baris membawa pool dan id proses');
    assert.ok(lines.some((e) => e.session === 'pic-A' && /Proses dijeda/.test(e.msg) && e.msg.startsWith('[HBI] ')), 'log tombol Jeda ikut berlabel sesinya');
    ok('log berlabel entitas dan membawa kunci sesi (termasuk log dari tombol kontrol)');

    // Jendela pertama PIC milik sesi lain yang masih berjalan (perilaku lama assertWindowFree, tetap ada).
    let release;
    const holdB = runcontrol.isolate(async () => { runcontrol.start('SPT KAP', { key: 'pic-B', tag: 'KAP' }); await new Promise((r) => { release = r; }); runcontrol.finish(); });
    await sleep(5);
    await runcontrol.isolate(async () => {
        runcontrol.start('SPT HBI', { key: 'pic-A', tag: 'HBI' });
        assert.throws(() => runcontrol.assertWindowFree('pic-B'), /sedang dipakai proses lain \("SPT KAP"\)/);
        assert.doesNotThrow(() => runcontrol.assertWindowFree('pic-A'));
        assert.doesNotThrow(() => runcontrol.assertWindowFree('pic-C'));
        // Jalur produksi: jendela PIC lain DIPINJAM - jendela bebas PIC itu, bukan yang sedang dipakai KAP.
        const borrowed = await runcontrol.acquireWindow('pic-B');
        assert.strictEqual(borrowed, 'pic-B~2', 'pinjam jendela bebas PIC B');
        assert.strictEqual(runcontrol.windowKeyFor('pic-B'), 'pic-B~2');
        assert.strictEqual(runcontrol.windowKeyFor('pic-A'), 'pic-A');
        assert.ok(runcontrol.isBusy('pic-B~2'));
        runcontrol.finish();
        assert.ok(!runcontrol.isBusy('pic-B~2'), 'jendela pinjaman dilepas bersama prosesnya');
    });
    release(); await holdB;
    assert.doesNotThrow(() => runcontrol.isolate(() => runcontrol.assertWindowFree('pic-B')), 'di luar proses tidak diperiksa');
    assert.strictEqual(runcontrol.windowKeyFor('pic-B'), 'pic-B', 'di luar proses: kunci apa adanya');
    ok('jendela PIC lain: yang dipakai sesi lain tidak direbut, jendela bebasnya dipinjam lalu dilepas');

    // Perilaku lama tanpa kunci sesi tetap: satu proses sekaligus.
    await runcontrol.isolate(async () => {
        runcontrol.start('lama');
        assert.throws(() => runcontrol.isolate(() => runcontrol.start('lama 2')), /Masih ada proses lain/);
        runcontrol.finish();
    });
    await runcontrol.checkpoint(); // di luar proses: tidak menahan, tidak melempar
    ok('tanpa kunci sesi: perilaku lama (satu proses), checkpoint di luar proses aman');

    // ---------- Batas per PIC, antrean FIFO, Stop membatalkan antrean ----------
    settings._reset({ perPic: 2, total: 6 });
    const held = [];
    const hold = (label, session) => runcontrol.isolate(() => { const q = runcontrol.enqueue(label, session); held.push(q.run); return q; });
    const q1 = hold('satu', { key: 'pic-Q', tag: 'Q', entity: 'E1' });
    const q2 = hold('dua', { key: 'pic-Q', tag: 'Q', entity: 'E2' });
    assert.strictEqual(q1.run.key, 'pic-Q'); assert.strictEqual(q2.run.key, 'pic-Q~2');
    assert.throws(() => runcontrol.isolate(() => runcontrol.start('tiga', { key: 'pic-Q' })), /Sesi ini masih menjalankan "satu"/, 'start() sinkron tetap menolak bila penuh');
    const q3 = hold('tiga', { key: 'pic-Q', tag: 'Q', entity: 'E3' });
    const q4 = hold('empat', { key: 'pic-Q', tag: 'Q', entity: 'E4' });
    const q5 = hold('lima', { key: 'pic-Q', tag: 'Q', entity: 'E5' });
    assert.strictEqual(q3.run.state, 'queued'); assert.strictEqual(q3.run.key, 'run:' + q3.run.id);
    assert.strictEqual(runcontrol.positionOf(q3.run), 1); assert.strictEqual(runcontrol.positionOf(q5.run), 3);
    const st3 = runcontrol.status('run:' + q3.run.id);
    assert.strictEqual(st3.queued, true); assert.strictEqual(st3.active, true); assert.strictEqual(st3.position, 1);
    assert.ok(lines.some((e) => e.run === q3.run.id && /Menunggu giliran - antrean ke-1: semua jendela PIC ini sedang dipakai \(batas 2 jendela per PIC\)/.test(e.msg)), 'baris log antrean');
    // Stop sebelum mulai: q4 dibatalkan, tidak pernah mendapat jendela.
    runcontrol.stop('run:' + q4.run.id);
    await assert.rejects(q4.ready, (e) => e.isStop);
    runcontrol.finish(q4.run);
    assert.strictEqual(runcontrol.positionOf(q5.run), 2, 'yang di belakangnya maju');
    // Jendela 1 bebas -> q3 (yang pertama antre) mendapatkannya, bukan q5.
    runcontrol.finish(q1.run);
    assert.strictEqual((await q3.ready).key, 'pic-Q', 'FIFO: proses antre pertama mendapat jendela yang bebas');
    assert.strictEqual(q5.run.state, 'queued');
    runcontrol.finish(q2.run);
    assert.strictEqual((await q5.ready).key, 'pic-Q~2');
    runcontrol.finish(q3.run); runcontrol.finish(q5.run);
    ok('batas per PIC: jendela 1..N lalu antre FIFO; Stop membatalkan antrean; antrean mulai sendiri berurutan');

    // ---------- Batas total ----------
    settings._reset({ perPic: 3, total: 2 });
    const t1 = hold('T1', { key: 'pic-T1' }), t2 = hold('T2', { key: 'pic-T2' }), t3 = hold('T3', { key: 'pic-T3' });
    const man = hold('manual', { key: 'manual', tag: 'Manual' });
    assert.strictEqual(t3.run.state, 'queued', 'batas total jendela berjalan');
    assert.strictEqual(man.run.state, 'running', 'sesi manual tidak dihitung batas total');
    assert.ok(lines.some((e) => e.run === t3.run.id && /batas 2 jendela berjalan/.test(e.msg)));
    runcontrol.finish(t1.run);
    assert.strictEqual((await t3.ready).key, 'pic-T3');
    for (const q of [t2, t3, man]) runcontrol.finish(q.run);
    ok('batas total: proses PIC lain antre sampai ada jendela berjalan yang selesai; sesi manual di luar batas');

    // ---------- Jendela yang sudah mengimpersonate entitas dipilih dulu ----------
    settings._reset({ perPic: 3, total: 6 });
    runcontrol.setWindowProvider({ openKeys: () => ['pic-P', 'pic-P~2', 'pic-P~3'] });
    await runcontrol.isolate(async () => { runcontrol.start('login E9', { key: 'pic-P~3' }); loginStatus.set('pic-P', { entity_id: 'E9' }); runcontrol.finish(); });
    assert.strictEqual(loginStatus.get('pic-P~3').entityId, 'E9', 'login-status per jendela');
    assert.strictEqual(loginStatus.windowFor('pic-P', 'E9'), 'pic-P~3');
    const pE9 = hold('unduh E9', { key: 'pic-P', entity: 'E9' });
    assert.strictEqual(pE9.run.key, 'pic-P~3', 'jendela yang sudah login sebagai E9 dipakai lagi (tanpa login ulang)');
    const pX = hold('unduh EX', { key: 'pic-P', entity: 'EX' });
    assert.strictEqual(pX.run.key, 'pic-P', 'entitas lain: jendela terbuka bebas yang pertama');
    runcontrol.finish(pE9.run); runcontrol.finish(pX.run);
    runcontrol.setWindowProvider({ openKeys: () => [] });
    ok('pemilihan jendela: yang mengimpersonate entitas yang diminta > jendela terbuka lain > jendela baru');

    // ---------- Perintah identik ditolak; fitur sama entitas sama antre (kunci); fitur lain paralel ----------
    const d1 = hold('SPT 01', { key: 'pic-D', entity: 'ENT', sig: 'spt|ENT|01', lock: 'ENT|spt' });
    assert.throws(() => runcontrol.isolate(() => runcontrol.enqueue('SPT 01 lagi', { key: 'pic-D2', entity: 'ENT', sig: 'spt|ENT|01', lock: 'ENT|spt' })), (e) => e.duplicate && /Perintah yang sama untuk entitas ini sudah berjalan \("SPT 01"\)/.test(e.message), 'identik (walau lewat PIC lain) ditolak');
    const d2 = hold('SPT 02', { key: 'pic-D2', entity: 'ENT', sig: 'spt|ENT|02', lock: 'ENT|spt' });
    assert.strictEqual(d2.run.state, 'queued', 'fitur sama, entitas sama, parameter lain: antre di belakang');
    assert.strictEqual(runcontrol.status('run:' + d2.run.id).waitReason, 'lock');
    const d3 = hold('e-Faktur', { key: 'pic-D', entity: 'ENT', sig: 'efaktur|ENT|x', lock: 'ENT|efaktur' });
    assert.strictEqual(d3.run.state, 'running', 'fitur lain untuk entitas yang sama: paralel');
    assert.strictEqual(d3.run.key, 'pic-D~2');
    runcontrol.finish(d1.run);
    assert.strictEqual((await d2.ready).key, 'pic-D2', 'kunci dilepas -> yang antre mulai');
    runcontrol.finish(d2.run); runcontrol.finish(d3.run);
    // Sesudah selesai, perintah yang sama boleh dijalankan lagi.
    const d4 = hold('SPT 01 ulang', { key: 'pic-D', entity: 'ENT', sig: 'spt|ENT|01', lock: 'ENT|spt' });
    assert.strictEqual(d4.run.state, 'running'); runcontrol.finish(d4.run);
    ok('keluaran: identik ditolak, fitur sama antre di belakang, fitur lain paralel, boleh diulang sesudah selesai');

    // ---------- Batas waktu antrean (runForResult) ----------
    settings._reset({ perPic: 1, total: 6 });
    const w1 = hold('Find BPMP', { key: 'pic-W' });
    const w2 = runcontrol.isolate(() => runcontrol.enqueue('Check NIK', { key: 'pic-W', maxWaitMs: 40 }));
    await assert.rejects(w2.ready, (e) => e.queueTimeout && /Sesi ini masih menjalankan "Find BPMP"/.test(e.message));
    runcontrol.finish(w2.run); runcontrol.finish(w1.run);
    ok('antrean berbatas waktu: pesan lama "Sesi ini masih menjalankan ..." sesudah batasnya');

    // ---------- Proses tanpa jendela (Perbarui rekap) tidak memakai / menunggu jendela ----------
    const n1 = hold('Rekap', { key: 'pic-N', windowed: false });
    const n2 = hold('Login', { key: 'pic-N' });
    assert.strictEqual(n1.run.key, 'run:' + n1.run.id); assert.strictEqual(n2.run.key, 'pic-N');
    runcontrol.finish(n1.run); runcontrol.finish(n2.run);
    ok('proses tanpa jendela: kunci run:<id>, jendela PIC tetap bebas');

    settings._reset();
    const leak = runcontrol._debugState();
    assert.deepStrictEqual(leak, { queue: 0, holders: [], locks: [], active: [] }, 'tidak ada jendela / kunci / antrean yang bocor: ' + JSON.stringify(leak));
    assert.ok(held.every((r) => !r.active));
    ok('tidak ada yang bocor sesudah semua proses selesai');

    console.log(passed + ' tes lulus.');
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
