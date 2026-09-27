/* Tes logika murni dashboard (gui/public/js/logic.js): parser masa, aturan daftar entitas,
   status login, progres, dan log. Jalankan:
     node scripts/test-gui-logic.js */
const assert = require('assert');
const L = require('../gui/public/js/logic.js');
const masaLib = require('../lib/masa');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
console.log('gui logic');

test('masaToCode: bulan berurutan jadi rentang, sisanya dipisah titik koma', () => {
    assert.strictEqual(L.masaToCode(['0126', '0226', '0326', '0526']), '0126-0326;0526');
    assert.strictEqual(L.masaToCode(['0826']), '0826');
    assert.strictEqual(L.masaToCode([]), '');
});
test('masaToCode: rentang melintasi pergantian tahun, urutan dan duplikat dirapikan', () => {
    assert.strictEqual(L.masaToCode(['0126', '1225', '1125', '1125']), '1125-0126');
});
test('masaToCode: nilai tidak valid dibuang', () => {
    assert.strictEqual(L.masaToCode(['1326', 'abcd', '0126']), '0126');
});
test('parseMasa: satu bulan, rentang, dan setahun penuh', () => {
    assert.deepStrictEqual(Array.from(L.parseMasa('0126;0326').set), ['0126', '0326']);
    assert.deepStrictEqual(Array.from(L.parseMasa('0126-0326').set), ['0126', '0226', '0326']);
    assert.strictEqual(L.parseMasa('2025').set.size, 12);
    assert.ok(L.parseMasa('2025').set.has('1225'));
    assert.strictEqual(L.parseMasa('').set.size, 0);
    assert.strictEqual(L.parseMasa('').error, null);
});
test('parseMasa: rentang terbalik dibetulkan; galat memakai kalimat server', () => {
    assert.deepStrictEqual(Array.from(L.parseMasa('0326-0126').set), ['0126', '0226', '0326']);
    assert.strictEqual(L.parseMasa('1326').error, 'Masa tidak valid: "1326"');
    assert.strictEqual(L.parseMasa('0126;xx').error, 'Masa tidak valid: "xx"');
    assert.strictEqual(L.parseMasa('1999').error, 'Masa tidak valid: "1999"');
});
test('parseMasa dan masaToCode konsisten dengan lib/masa.js di server (bolak-balik)', () => {
    for (const text of ['0126', '0126;0226', '0125-1225', '2025', '1125-0126;0526']) {
        const client = L.masaToCode(L.parseMasa(text).set);
        const server = masaLib.parseMasaListInput(client);
        const expected = masaLib.parseMasaListInput(text);
        assert.deepStrictEqual(server, expected, text + ' -> ' + client);
    }
});
test('yearsToCode dan parseYears cocok dengan lib/masa.js (tahunan)', () => {
    assert.strictEqual(L.yearsToCode([2025, 2024]), '2024-2025');
    assert.strictEqual(L.yearsToCode([2021, 2024]), '2021;2024');
    assert.deepStrictEqual(Array.from(L.parseYears('2024-2025').set), [2024, 2025]);
    assert.strictEqual(L.parseYears('20x5').error, 'Tahun tidak valid: "20x5"');
    for (const ys of [[2025], [2024, 2025], [2021, 2024, 2025]]) {
        assert.deepStrictEqual(masaLib.parseAnnualYearListInput(L.yearsToCode(ys)), ys.map(String));
    }
});
test('masaLabel', () => { assert.strictEqual(L.masaLabel('0826'), 'Agustus 2026'); });

test('initials: tanpa bentuk badan hukum, satu kata memakai dua huruf', () => {
    assert.strictEqual(L.initials('PT Contoh Sejahtera Abadi'), 'CS');
    assert.strictEqual(L.initials('BERKAT KANA ABADI, PT'), 'BK');
    assert.strictEqual(L.initials('Yayasan Contoh Peduli'), 'CP');
    assert.strictEqual(L.initials('Budi'), 'BU');
    assert.strictEqual(L.initials('PT'), 'E');
});

const E = (o) => Object.assign({ project: 'taxio_hub', project_label: 'Taxio Hub', npwp: '', pics: [], linked: true }, o);
const LIST = [
    E({ entity_id: 'MKA', entity_name: 'MITRA KARYA ABADI, PT', npwp: '0317927093541000', pics: [{ pic_id: 'a', pic_name: 'ANDI PRATAMA', is_primary: true }, { pic_id: 'r', pic_name: 'RINA WIJAYA' }] }),
    E({ entity_id: 'CSA', entity_name: 'PT Contoh Sejahtera Abadi', pics: [{ pic_id: 'a', pic_name: 'ANDI PRATAMA', is_primary: true }] }),
    E({ entity_id: 'MLU', entity_name: 'MITRA LESTARI UTAMA, PT', linked: false })
];
// Entitas lokal berkredensial (tab Saya) - sejak menyimpan kredensial asli, login otomatis
// PERSIS seperti Taxio Hub: Badan bisa >1 PIC (dipilih sama seperti Hub), Orang Pribadi tidak
// punya PIC sama sekali (pic_id bawaannya sendiri 'op', bukan 'unlinked').
const LOCAL_BADAN = E({ project: 'local', project_label: 'Lokal', entity_id: 'local:le1', entity_name: 'CV Klien Baru Sejahtera', individual: false, pic_id: 'lp1', pic_name: 'Ani Wijaya', pics: [{ pic_id: 'lp1', pic_name: 'Ani Wijaya', is_primary: true }, { pic_id: 'lp2', pic_name: 'Budi Kedua' }], linked: undefined });
const LOCAL_OP = E({ project: 'local', project_label: 'Lokal', entity_id: 'local:le2', entity_name: 'Ani Sample Wijaya', individual: true, pic_id: 'op', pic_name: 'Ani Sample Wijaya', pics: [], linked: undefined });
test('visibleEntities: tanpa pencarian hanya yang PIC-nya tertaut', () => {
    assert.deepStrictEqual(L.visibleEntities(LIST, '').map((e) => e.entity_id), ['MKA', 'CSA']);
    assert.strictEqual(L.hiddenUnlinkedCount(LIST), 1);
});
test('visibleEntities: pencarian memunculkan yang belum tertaut (nama, kode, NPWP, nama PIC)', () => {
    assert.deepStrictEqual(L.visibleEntities(LIST, 'mitra').map((e) => e.entity_id), ['MKA', 'MLU']);
    assert.deepStrictEqual(L.visibleEntities(LIST, 'mlu').map((e) => e.entity_id), ['MLU']);
    assert.deepStrictEqual(L.visibleEntities(LIST, '0317 9270').map((e) => e.entity_id), ['MKA']);
    assert.deepStrictEqual(L.visibleEntities(LIST, 'rina').map((e) => e.entity_id), ['MKA']);
    assert.deepStrictEqual(L.visibleEntities(LIST, 'tidak-ada'), []);
});
test('pickPic: yang diminta, kalau tidak ada PIC utama, kalau tidak ada yang pertama', () => {
    assert.strictEqual(L.pickPic(LIST[0], 'r').pic_id, 'r');
    assert.strictEqual(L.pickPic(LIST[0], 'zzz').pic_id, 'a');
    assert.strictEqual(L.pickPic(LIST[0]).pic_id, 'a');
    assert.strictEqual(L.pickPic({ pics: [{ pic_id: 'x' }, { pic_id: 'y' }] }).pic_id, 'x');
    assert.strictEqual(L.pickPic(LIST[2]), null);
});
test('flattenSelection: bentuk datar untuk API, PIC terpilih ikut, tanpa pics/linked', () => {
    const f = L.flattenSelection(LIST[0], 'r');
    assert.strictEqual(f.pic_id, 'r'); assert.strictEqual(f.pic_name, 'RINA WIJAYA');
    assert.strictEqual(f.entity_id, 'MKA'); assert.strictEqual(f.project, 'taxio_hub');
    assert.ok(!('pics' in f) && !('linked' in f));
});
test('flattenSelection: entitas Hub tanpa PIC tertaut ditandai "unlinked"', () => {
    assert.strictEqual(L.flattenSelection(LIST[2]).pic_id, 'unlinked');
});
test('flattenSelection: Badan lokal memilih PIC persis seperti Hub (kredensial asli, login otomatis)', () => {
    const f1 = L.flattenSelection(LOCAL_BADAN, 'lp2');
    assert.strictEqual(f1.pic_id, 'lp2'); assert.strictEqual(f1.pic_name, 'Budi Kedua'); assert.strictEqual(f1.project, 'local');
    assert.strictEqual(L.flattenSelection(LOCAL_BADAN).pic_id, 'lp1', 'tanpa pilihan eksplisit -> PIC utama');
});
test('flattenSelection: Orang Pribadi lokal tidak berubah jadi "unlinked" (tidak punya PIC sama sekali)', () => {
    const f = L.flattenSelection(LOCAL_OP);
    assert.strictEqual(f.pic_id, 'op'); assert.strictEqual(f.pic_name, 'Ani Sample Wijaya');
});
test('flattenSelection: sesi manual polos dikirim apa adanya', () => {
    const manual = { project: 'manual', entity_id: 'MANUAL' };
    assert.strictEqual(L.flattenSelection(manual), manual);
    assert.strictEqual(L.flattenSelection(null), null);
});
test('isManualLike: hanya sesi Coretax polos - entitas lokal berkredensial BUKAN manual (login otomatis)', () => {
    assert.ok(L.isManualLike({ project: 'manual' }));
    assert.ok(!L.isManualLike({ project: 'local' }), 'entitas lokal sekarang otomatis, bukan manual');
    assert.ok(!L.isManualLike({ project: 'taxio_hub' })); assert.ok(!L.isManualLike(null));
});
test('entityKey', () => {
    assert.strictEqual(L.entityKey({ project: 'local', entity_id: 'local:1' }), 'local|local:1');
});
test('formatNpwp: 16 digit tanpa titik/strip (format resmi sejak integrasi NIK); NPWP 15 digit lama tidak diformat', () => {
    assert.strictEqual(L.formatNpwp('0317927093541000'), '0317 9270 9354 1000');
    assert.strictEqual(L.formatNpwp('031792709354100'), '031792709354100', 'format lama 15 digit tidak lagi diberi titik/strip');
    assert.strictEqual(L.rupiah('Rp 1500000'), '1.500.000');
    assert.strictEqual(L.rupiah('0012'), '12');
    assert.strictEqual(L.rupiah(''), '');
});

test('loginPill: proses berjalan mengalahkan semuanya', () => {
    assert.strictEqual(L.loginPill({ runActive: true, entity: LIST[0], manual: {}, last: null }).kind, 'run');
});
test('loginPill: entitas Hub aktif hanya bila login terakhir memang entitas itu', () => {
    const last = { at: 1, name: 'mitra karya abadi, pt' };
    assert.strictEqual(L.loginPill({ entity: LIST[0], manual: {}, last }).kind, 'ok');
    assert.strictEqual(L.loginPill({ entity: LIST[1], manual: {}, last }).kind, 'off');
    assert.strictEqual(L.loginPill({ entity: LIST[0], manual: {}, last: null }).text, 'Belum masuk Coretax');
});
test('loginPill: sesi manual polos mengikuti jendela Coretax manual', () => {
    const manual = { project: 'manual', entity_name: 'Sesi Manual' };
    assert.deepStrictEqual(L.loginPill({ entity: manual, manual: { open: false, loggedIn: false } }), { kind: 'off', text: 'Belum membuka Coretax' });
    assert.deepStrictEqual(L.loginPill({ entity: manual, manual: { open: true, loggedIn: false } }), { kind: 'wait', text: 'Menunggu login manual' });
    assert.deepStrictEqual(L.loginPill({ entity: manual, manual: { open: true, loggedIn: true } }), { kind: 'manual', text: 'Login manual aktif' });
});
test('loginPill: entitas lokal (kredensial asli) memakai jalur otomatis, bukan lagi status manual', () => {
    assert.strictEqual(L.loginPill({ entity: LOCAL_BADAN, manual: { open: true, loggedIn: true } }).kind, 'off', 'sesi manual terbuka tidak dianggap sebagai login entitas lokal ini');
});
test('loginPill: tanpa entitas', () => {
    assert.strictEqual(L.loginPill({ entity: null, manual: {} }).text, 'Pilih entitas');
    assert.strictEqual(L.loginPill({ entity: null, manual: { loggedIn: true } }).kind, 'manual');
});

test('planProgress: hitungan dan persen', () => {
    const p = L.planProgress({ items: [1, 2, 3, 4], states: ['ok', 'skip', 'hold', 'wait'], index: 2 });
    assert.deepStrictEqual([p.total, p.ok, p.skip, p.hold, p.wait, p.finished, p.pct, p.holdPct], [4, 1, 1, 1, 1, 2, 50, 25]);
    assert.strictEqual(L.planProgress(null), null);
    assert.strictEqual(L.planProgress({ states: [] }), null);
});

test('parseLogLine dan logLevel', () => {
    const l = L.parseLogLine('[2026-09-25T20:34:58.033Z] Gagal terhubung (Taxio Hub): x');
    assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(l.time)); assert.strictEqual(l.msg, 'Gagal terhubung (Taxio Hub): x');
    assert.deepStrictEqual(L.parseLogLine('tanpa waktu'), { time: '', msg: 'tanpa waktu' });
    assert.strictEqual(L.logLevel('Gagal terhubung'), 'error');
    assert.strictEqual(L.logLevel('⏸ Proses dijeda'), 'warn');
    assert.strictEqual(L.logLevel('Sesi tersimpan dipulihkan'), 'ok');
    assert.strictEqual(L.logLevel('Membuka halaman'), 'info');
});

console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
