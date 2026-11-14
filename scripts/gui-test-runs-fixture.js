/* Data tiruan untuk halaman Runs (GET /api/runs), dipakai scripts/test-gui-ui.js dan skrip tangkapan layar:
   menahan, berjalan, dijeda, berhenti dulu, antre, selesai, gagal, dihentikan, satu batch yang masih jalan dan satu
   batch yang sudah selesai. Nama perusahaan dan NPWP fiktif. Bentuk data mengikuti README "Halaman Runs". */
const ENT = {
    CSA: { id: 'CSA', name: 'PT Contoh Sejahtera Abadi', npwp: '0123456780910000', tag: 'CSA' },
    MKA: { id: 'MKA', name: 'MITRA KARYA ABADI, PT', npwp: '0000000000000317', tag: 'MKA' },
    SNM: { id: 'SNM', name: 'CV Sample Niaga Mandiri', npwp: '0000000000000000', tag: 'SNM' },
    BUDI: { id: 'BUDI', name: 'Budi Contoh Santoso', npwp: '0456789012340000', tag: 'BUDI' },
    MLU: { id: 'MLU', name: 'MITRA LESTARI UTAMA, PT', npwp: '0000000000000001', tag: 'MLU' },
    DLT: { id: 'DLT', name: 'PT Delta Contoh Persada', npwp: '0000000000000002', tag: 'DLT' }
};
const MONTHS = ['0126', '0226', '0326', '0426', '0526', '0626', '0726', '0826', '0926', '1026'];

function runsFixture() {
    const t = (mins) => new Date(Date.now() - mins * 60000).toISOString();
    const run = (id, state, o) => Object.assign({
        key: 'run:' + id, id, state, section: state === 'hold' ? 'needsYou' : ['done', 'failed', 'stopped'].includes(state) ? 'done' : 'inProgress',
        feature: 'spt', label: 'SPT · PPh 21/26 · Masa Pajak 01/2026 - 10/2026', entity: ENT.CSA, pic: 'p-andi', window: null, windowNo: null, queue: null,
        queuedAt: t(30), startedAt: t(29), endedAt: null, progress: null, hold: null,
        controls: { stop: true, pause: true, skip: false, retry: false, back: false, pageSize: false },
        stopRequested: state === 'stopping', pauseRequested: false, changesCoretax: false, outcome: null, outputDir: null, batch: null
    }, o);
    const prog = (done, hold, total) => ({
        total: total || 10, done, hold: hold ? 1 : 0, current: { index: done, label: 'PPh 21/26 / ' + MONTHS[done], short: MONTHS[done] },
        items: MONTHS.map((m, i) => ({ label: 'PPh 21/26 / ' + m, short: m, state: i < done ? 'ok' : i === done ? (hold ? 'hold' : 'run') : 'wait' }))
    });
    const batch = (i) => ({ id: 'b-masa-1026', label: 'SPT Masa Pajak 10/2026 for 6 clients', index: i, total: 6 });
    const bEnt = [ENT.CSA, ENT.MKA, ENT.SNM, ENT.BUDI, ENT.MLU, ENT.DLT];
    const one = (state) => ({ total: 1, done: 0, hold: 0, current: { index: 0, label: 'Masa Pajak 10/2026', short: '1026' }, items: [{ label: 'Masa Pajak 10/2026', short: '1026', state }] });
    const bRun = (id, i, state, o) => run(id, state, Object.assign({
        label: 'SPT · PPh Badan · Masa Pajak 10/2026', entity: bEnt[i], pic: i % 2 ? 'p-rina' : 'p-andi', batch: batch(i),
        outputDir: state === 'done' ? 'C:\\Dummy\\Out\\' + bEnt[i].id : null,
        outcome: state === 'done' ? { kind: 'done', text: 'SELESAI: 1 of 1 downloaded', custom: true } : null, endedAt: state === 'done' ? t(3) : null
    }, o || {}));
    const waiting = (pos) => ({ startedAt: null, queue: { position: pos, poolPosition: 1, reason: 'busy', reasonText: 'Waiting for a free Coretax window.', waitingFor: null } });
    const needsYou = [run(101, 'hold', {
        windowNo: 1, controls: { stop: true, pause: true, skip: true, retry: true }, progress: prog(3, true),
        hold: {
            reason: 'The Lampiran table for 04/2026 could not be read before the time limit', item: 'PPh 21/26 / 0426', choices: [
                { id: 'retry', label: 'Try again', action: 'retry' },
                { id: 'skip', label: 'Skip PPh 21/26 / 0426', action: 'skip', item: 'PPh 21/26 / 0426' },
                { id: 'stop', label: 'Stop', action: 'stop' }]
        }
    })];
    const inProgress = [
        run(102, 'running', { feature: 'ebupot', label: 'e-Bupot · BPPU · Masa Pajak 01/2026 - 12/2026', entity: ENT.MKA, windowNo: 2, progress: prog(4, false, 12) }),
        run(103, 'paused', { feature: 'bpsaya', label: 'Bukti Potong Saya · Masa Pajak 09/2026', entity: ENT.SNM, pic: 'p-rina', progress: prog(6) }),
        run(106, 'stopping', { feature: 'faktur', label: 'e-Faktur · Faktur Pajak Keluaran · 10/2026', entity: ENT.MLU, windowNo: 3, progress: prog(1) }),
        bRun(122, 2, 'running', { progress: one('run') }),
        run(104, 'queued', {
            feature: 'faktur', label: 'e-Faktur · Faktur Pajak Masukan · 10/2026', entity: ENT.BUDI, pic: 'p-budi', startedAt: null,
            queue: { position: 2, poolPosition: 1, reason: 'busy', reasonText: 'All Coretax windows of this PIC are in use. It starts as soon as one is free.', waitingFor: null }
        }),
        bRun(123, 3, 'queued', waiting(3)), bRun(124, 4, 'queued', waiting(4)), bRun(125, 5, 'queued', waiting(5))
    ];
    const old = (i, id, ent, text, dir, ended) => run(id, 'done', {
        feature: 'bpsaya', label: 'Bukti Potong Saya · Masa Pajak 09/2026', entity: ent, batch: { id: 'b-old', label: 'Bukti Potong Saya 09/2026 for 2 clients', index: i, total: 2 },
        endedAt: t(ended), outcome: { kind: 'done', text, custom: true }, outputDir: dir
    });
    const done = [
        run(110, 'done', { endedAt: t(12), outcome: { kind: 'done', text: 'SELESAI: 10 of 10 Masa Pajak downloaded', custom: true }, outputDir: 'C:\\Dummy\\Out\\CSA' }),
        run(111, 'failed', { feature: 'faktur', label: 'e-Faktur · Faktur Pajak Masukan · 09/2026', entity: ENT.MKA, endedAt: t(40), outcome: { kind: 'failed', text: 'GAGAL: Coretax rejected the login for this PIC', custom: true } }),
        run(112, 'stopped', { feature: 'ebupot', label: 'e-Bupot · BP21 · Masa Pajak 08/2026', entity: ENT.SNM, pic: 'p-rina', endedAt: t(75), outcome: { kind: 'stopped', text: 'Dihentikan: stopped after 4 of 12', custom: true }, outputDir: 'C:\\Dummy\\Out\\SNM' }),
        bRun(120, 0, 'done'), bRun(121, 1, 'done'),
        old(0, 130, ENT.CSA, 'SELESAI: 3 downloaded', 'C:\\Dummy\\Out\\CSA2', 130),
        old(1, 131, ENT.MKA, 'SELESAI: 5 downloaded', 'C:\\Dummy\\Out\\MKA2', 128)
    ];
    const batches = [
        { id: 'b-masa-1026', label: 'SPT Masa Pajak 10/2026 for 6 clients', feature: 'spt', total: 6, counts: { queued: 3, running: 1, hold: 0, done: 2, failed: 0, stopped: 0 }, startedAt: t(20), endedAt: null },
        { id: 'b-old', label: 'Bukti Potong Saya 09/2026 for 2 clients', feature: 'bpsaya', total: 2, counts: { queued: 0, running: 0, hold: 0, done: 2, failed: 0, stopped: 0 }, startedAt: t(140), endedAt: t(128) }
    ];
    return { needsYou, inProgress, done, batches, limits: { perPic: 3, total: 6, running: 4 } };
}

/** GET /api/runs/<key>: satu proses + baris log terakhir (null bila tidak ada). */
function runDetail(fixture, key) {
    const r = fixture.needsYou.concat(fixture.inProgress, fixture.done).find((x) => x.key === key);
    if (!r) return null;
    const ts = (m) => '[' + new Date(Date.now() - m * 60000).toISOString() + '] ';
    return Object.assign({}, r, {
        lines: [ts(5) + 'Starting ' + r.label, ts(4) + 'Opening the Coretax window for ' + r.entity.name, ts(3) + 'Masa Pajak 0126 downloaded', ts(2) + 'Masa Pajak 0226 downloaded',
            ts(1) + (r.state === 'failed' ? 'GAGAL: Coretax rejected the login for this PIC' : 'Working on the next Masa Pajak...')]
    });
}

module.exports = { runsFixture, runDetail };
