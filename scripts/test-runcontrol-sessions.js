/* Tes lib/runcontrol.js: satu proses per sesi, sesi berbeda berjalan bersamaan (permintaan
   pengguna 2026-10-07 - "Sesi baru" tidak boleh menunggu sesi lain yang sedang mengunduh).
   Memastikan: start ditolak hanya di sesi yang sama; checkpoint/setPlan/markCombo mengikuti proses
   alurnya sendiri (AsyncLocalStorage) walau dua proses saling bersilangan di await; tombol kontrol
   memilih proses lewat kunci sesi; log diberi label entitas dan kunci sesi; jendela PIC yang sedang
   dipakai sesi lain ditolak. Jalankan:
     node scripts/test-runcontrol-sessions.js */
const assert = require('assert');
const runcontrol = require('../lib/runcontrol');
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

    assert.throws(() => runcontrol.isolate(() => runcontrol.start('lagi', { key: 'pic-A', tag: 'HBI' })), /Sesi ini masih menjalankan "e-Bupot HBI"/);
    ok('sesi yang sama ditolak selagi sibuk, dengan nama prosesnya');

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
    assert.ok(lines.some((e) => e.session === 'pic-A' && /Proses dijeda/.test(e.msg) && e.msg.startsWith('[HBI] ')), 'log tombol Jeda ikut berlabel sesinya');
    ok('log berlabel entitas dan membawa kunci sesi (termasuk log dari tombol kontrol)');

    // Jendela PIC milik sesi lain yang masih berjalan.
    let release;
    const holdB = runcontrol.isolate(async () => { runcontrol.start('SPT KAP', { key: 'pic-B', tag: 'KAP' }); await new Promise((r) => { release = r; }); runcontrol.finish(); });
    await sleep(5);
    await runcontrol.isolate(async () => {
        runcontrol.start('SPT HBI', { key: 'pic-A', tag: 'HBI' });
        assert.throws(() => runcontrol.assertWindowFree('pic-B'), /sedang dipakai proses lain \("SPT KAP"\)/);
        assert.doesNotThrow(() => runcontrol.assertWindowFree('pic-A'));
        assert.doesNotThrow(() => runcontrol.assertWindowFree('pic-C'));
        runcontrol.finish();
    });
    release(); await holdB;
    assert.doesNotThrow(() => runcontrol.isolate(() => runcontrol.assertWindowFree('pic-B')), 'di luar proses tidak diperiksa');
    ok('jendela PIC yang dipakai sesi lain ditolak, jendela sendiri/kosong boleh');

    // Perilaku lama tanpa kunci sesi tetap: satu proses sekaligus.
    await runcontrol.isolate(async () => {
        runcontrol.start('lama');
        assert.throws(() => runcontrol.isolate(() => runcontrol.start('lama 2')), /Masih ada proses lain/);
        runcontrol.finish();
    });
    await runcontrol.checkpoint(); // di luar proses: tidak menahan, tidak melempar
    ok('tanpa kunci sesi: perilaku lama (satu proses), checkpoint di luar proses aman');

    console.log(passed + ' tes lulus.');
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
