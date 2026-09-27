/* Tes integrasi API dashboard (gui/server.js) dengan Supabase, Chrome, dan daftar entitas
   diganti data palsu: alur pendaftaran, daftar entitas satu baris per entitas, entitas lokal
   BERKREDENSIAL (login OTOMATIS - bukan lagi manual), sesi manual polos yang tetap ada
   terpisah, dan blokir Restricted Editor. Tidak membuka Chrome sungguhan, tidak menghubungi
   Taxio Hub, dan memakai folder data sementara. Jalankan:
     node scripts/test-gui-api.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-api-'));
const sessionStore = require('../lib/session-store');
const entitiesLib = require('../lib/entities');
const chrome = require('../lib/chrome');

// ---- Supabase palsu yang keadaannya bisa diatur tes ----
const S = { active: false, queued: [], memberships: [], requests: [], role: 'editor' };
const ok = (data) => Promise.resolve({ data, error: null });
const fake = {
    auth: { signUp: async () => ({ data: { user: { identities: [{}] }, session: null }, error: null }) },
    rpc: (name, args) => {
        if (name === 'get_my_active_membership') return ok(S.active ? [{ org_id: 'o1' }] : []);
        if (name === 'get_my_membership_request') return ok(S.queued);
        if (name === 'request_membership') { S.queued = [{ initial: args.p_initial }]; S.requests.push(args.p_initial); return ok('ok'); }
        return ok(null);
    },
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ok(S.memberships) }) }) })
};
const PROJECT = { id: 'taxio_hub', label: 'Taxio Hub' };
let disconnects = 0;
sessionStore.clientFor = () => ({ client: fake, project: PROJECT });
sessionStore.connectWithPassword = async (id, email, password) => {
    if (password === 'salah') throw { message: 'Invalid login credentials' };
    if (password === 'belum') throw { code: 'email_not_confirmed', message: 'Email not confirmed' };
    return { client: fake, project: PROJECT, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, user: { id: 'u-1', email } };
};
sessionStore.refreshIfNeeded = async () => {};
sessionStore.disconnect = async () => { disconnects++; };
entitiesLib.getMyOrgId = async () => ({ org_id: 'o1', role: S.role });

// Baris seperti keluaran listAutomatableEntities: satu baris per entitas x PIC.
const r = (o) => Object.assign({ npwp: '', individual: false, pic_is_mine: true, is_primary: false }, o);
const GROUP_ROWS = [
    r({ entity_id: 'MKA', entity_name: 'MITRA KARYA ABADI, PT', pic_id: 'p-andi', pic_name: 'ANDI PRATAMA', is_primary: true }),
    r({ entity_id: 'MKA', entity_name: 'MITRA KARYA ABADI, PT', pic_id: 'p-rina', pic_name: 'RINA WIJAYA' }),
    r({ entity_id: 'CSA', entity_name: 'PT Contoh Sejahtera Abadi', pic_id: 'p-andi', pic_name: 'ANDI PRATAMA', is_primary: true }),
    r({ entity_id: 'MLU', entity_name: 'MITRA LESTARI UTAMA, PT', pic_id: 'unlinked', pic_name: 'Belum Taut PIC Coretax', is_primary: true }),
    r({ entity_id: 'BUDI', entity_name: 'Budi Contoh Santoso', pic_id: 'p-budi', pic_name: 'Budi Contoh Santoso', individual: true, is_primary: true })
];
const PERSONAL_ROWS = [GROUP_ROWS[4]];
entitiesLib.listAutomatableEntities = async (client, org, uid, owner, mode) => (mode === 'personal' ? PERSONAL_ROWS : GROUP_ROWS).map((x) => Object.assign({}, x));

// Chrome/Playwright diganti penyamar cepat: entitas lokal sekarang benar-benar mencoba login
// OTOMATIS (lewat lib/local-auth-client.js -> lib/entities.js -> lib/chrome.js), jadi handler-
// handler memanggil fungsi-fungsi ini sungguhan. Tidak ada satu pun yang membuka browser asli -
// setiap panggilan gagal cepat begitu menyentuh method yang tidak ditiru (mis. page.goto),
// sehingga proses langsung berhenti (runcontrol.finish()) tanpa menunggu timeout jaringan.
chrome.getManualPage = () => null;
chrome.getManualStatus = async () => ({ open: false, loggedIn: false, identity: '' });
chrome.isLoggedOut = () => false;
const fakePage = { isClosed: () => false, url: () => '', goto: async () => { throw new Error('halaman tiruan: tidak ada Coretax sungguhan di tes ini'); } };
chrome.launchOrReuseContext = async () => ({ context: {}, page: fakePage, reused: false, userDataDir: '/tmp/fake' });
chrome.loginAndImpersonate = async () => true;

const { createGuiServer } = require('../gui/server');
const PORT = 52411;
const BASE = 'http://127.0.0.1:' + PORT;

async function call(method, url, body, headers) {
    const res = await fetch(BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (e) { /* bukan JSON */ }
    return { status: res.status, json };
}
const GET = (u) => call('GET', u);
const POST = (u, b, h) => call('POST', u, b === undefined ? {} : b, h);
/** Proses berjalan di latar (fire-and-forget); tunggu sampai selesai supaya test berikutnya
 *  tidak bentrok dengan runcontrol "masih ada proses lain yang berjalan". */
async function waitIdle() {
    for (let i = 0; i < 100; i++) {
        const st = (await GET('/api/run/status')).json;
        if (!st || !st.active) return;
        await new Promise((res) => setTimeout(res, 15));
    }
    throw new Error('proses tidak kunjung selesai (kemungkinan bug pada tes, bukan pada aplikasi)');
}

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
const hub = () => GET('/api/session').then((x) => x.json.taxio_hub);

(async () => {
    await createGuiServer(PORT);
    console.log('gui api');

    await test('awal: belum terhubung dan tidak ada pendaftaran menunggu', async () => {
        const h = await hub();
        assert.strictEqual(h.connected, false);
        assert.strictEqual(h.pending, undefined);
    });

    await test('signup: input tidak valid ditolak dengan kalimat yang sama dengan Taxio Hub', async () => {
        const a = await POST('/api/signup', { initial: '', email: 'baru@contoh.com', password: '123456' });
        assert.strictEqual(a.status, 400); assert.strictEqual(a.json.error, 'Inisial wajib diisi.');
        const b = await POST('/api/signup', { initial: 'SGA', email: 'baru@contoh.com', password: '123' });
        assert.strictEqual(b.json.error, 'Kata sandi minimal 6 karakter.');
    });

    await test('signup valid: akun dibuat, status menunggu konfirmasi email (belum terhubung)', async () => {
        const a = await POST('/api/signup', { initial: 'sga', email: 'baru@contoh.com', password: '123456' });
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json.taxio_hub.connected, false);
        assert.deepStrictEqual(a.json.taxio_hub.pending, { status: 'confirm-email', email: 'baru@contoh.com', initial: 'SGA' });
    });

    await test('periksa status sebelum email dikonfirmasi: perlu masuk dulu (belum ada sesi)', async () => {
        const a = await POST('/api/registration/check', {});
        assert.strictEqual(a.status, 409); assert.strictEqual(a.json.needsLogin, true);
    });

    await test('masuk dengan kata sandi salah: pesan Indonesia', async () => {
        const a = await POST('/api/connect', { project: 'taxio_hub', email: 'baru@contoh.com', password: 'salah' });
        assert.strictEqual(a.status, 400); assert.strictEqual(a.json.error, 'Email atau kata sandi salah.');
    });

    await test('masuk sebelum konfirmasi email: bukan galat, tampil status confirm-email', async () => {
        const a = await POST('/api/connect', { project: 'taxio_hub', email: 'baru@contoh.com', password: 'belum' });
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json.taxio_hub.pending.status, 'confirm-email');
    });

    await test('masuk setelah konfirmasi: inisial tersimpan diajukan otomatis, status menunggu penempatan', async () => {
        const a = await POST('/api/connect', { project: 'taxio_hub', email: 'baru@contoh.com', password: 'benar' });
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json.taxio_hub.connected, false, 'belum aktif tidak boleh dianggap terhubung');
        assert.strictEqual(a.json.taxio_hub.pending.status, 'waiting-assignment');
        assert.strictEqual(a.json.taxio_hub.pending.initial, 'SGA');
        assert.deepStrictEqual(S.requests, ['SGA']);
    });

    await test('akun yang menunggu tidak bisa memuat entitas atau memakai entitas lokal', async () => {
        assert.strictEqual((await GET('/api/entities?mode=group')).status, 401);
        assert.strictEqual((await GET('/api/local-entities')).status, 401);
    });

    await test('periksa status: masih menunggu, tidak mengajukan ulang', async () => {
        const a = await POST('/api/registration/check', {});
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json.taxio_hub.pending.status, 'waiting-assignment');
        assert.deepStrictEqual(S.requests, ['SGA']);
    });

    await test('setelah admin menempatkan ke grup: periksa status membuat akun terhubung', async () => {
        S.active = true;
        const a = await POST('/api/registration/check', {});
        assert.strictEqual(a.json.taxio_hub.connected, true);
        assert.strictEqual(a.json.taxio_hub.email, 'baru@contoh.com');
        assert.strictEqual(a.json.taxio_hub.pending, undefined);
    });

    await test('tidak bisa mendaftar lagi saat sudah terhubung', async () => {
        const a = await POST('/api/signup', { initial: 'ABC', email: 'lain@contoh.com', password: '123456' });
        assert.strictEqual(a.status, 409);
    });

    await test('daftar entitas Grup: satu baris per entitas, PIC di dalam baris, tanpa PIC ditandai', async () => {
        const a = await GET('/api/entities?mode=group');
        assert.strictEqual(a.status, 200);
        const byId = Object.fromEntries(a.json.entities.map((e) => [e.entity_id, e]));
        assert.strictEqual(a.json.entities.filter((e) => e.entity_id === 'MKA').length, 1, 'MKA tidak boleh dobel');
        assert.deepStrictEqual(byId.MKA.pics.map((p) => p.pic_name), ['ANDI PRATAMA', 'RINA WIJAYA']);
        assert.strictEqual(byId.MKA.linked, true);
        assert.strictEqual(byId.MLU.linked, false);
        assert.deepStrictEqual(byId.MLU.pics, []);
        assert.strictEqual(byId.CSA.pics.length, 1);
        assert.strictEqual(byId.MKA.project, 'taxio_hub');
    });

    await test('mode Saya: berisi entitas pribadi dari Hub, belum ada entitas lokal', async () => {
        const a = await GET('/api/entities?mode=personal');
        assert.deepStrictEqual(a.json.entities.map((e) => e.entity_id), ['BUDI']);
    });

    // ---- entitas lokal: kredensial Coretax ASLI, login OTOMATIS ----
    let ani; let cv;
    await test('entitas lokal: NPWP wajib 16 digit; Orang Pribadi wajib kata sandi; Badan tanpa PIC ditolak', async () => {
        const bad = await POST('/api/local-entities/save', { name: 'Ani Sample Wijaya', type: 'op', npwp: '123', password: 'x' });
        assert.strictEqual(bad.status, 400); assert.ok(/16 digit/.test(bad.json.error));
        const nopass = await POST('/api/local-entities/save', { name: 'Ani Sample Wijaya', type: 'op', npwp: '1234567890123456' });
        assert.strictEqual(nopass.status, 400); assert.ok(/[Kk]ata sandi wajib diisi/.test(nopass.json.error));
        const badan = await POST('/api/local-entities/save', { name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '0678901234560000', pics: [] });
        assert.strictEqual(badan.status, 400); assert.ok(/wajib menautkan minimal satu PIC/.test(badan.json.error));
    });

    await test('entitas lokal: Orang Pribadi tersimpan; kata sandi tidak pernah bocor ke respons', async () => {
        const a = await POST('/api/local-entities/save', { name: 'Ani Sample Wijaya', type: 'op', npwp: '1234-5678-9012-3456', password: 'rahasiaAni', passphrase: 'frasaAni' });
        assert.strictEqual(a.status, 200);
        ani = a.json.entity;
        assert.strictEqual(ani.project, 'local'); assert.strictEqual(ani.individual, true); assert.strictEqual(ani.pic_id, 'op');
        assert.strictEqual(ani.npwp, '1234567890123456');
        assert.ok(!JSON.stringify(a.json).includes('rahasiaAni'), 'kata sandi bocor ke klien');
        assert.ok(!JSON.stringify(a.json).includes('frasaAni'), 'passphrase bocor ke klien');
    });

    await test('entitas lokal: Badan menautkan >1 PIC dengan kredensial masing-masing', async () => {
        const a = await POST('/api/local-entities/save', {
            name: 'CV Klien Baru Sejahtera', type: 'badan', npwp: '0678901234560000',
            pics: [
                { name: 'PIC Utama', npwp: '1111222233334444', password: 'sandiUtama', passphrase: 'frasaUtama' },
                { name: 'PIC Kedua', npwp: '5555666677778888', password: 'sandiKedua' }
            ]
        });
        assert.strictEqual(a.status, 200);
        cv = a.json.entity;
        assert.deepStrictEqual(cv.pics.map((p) => p.pic_name), ['PIC Utama', 'PIC Kedua']);
        assert.strictEqual(cv.pics[0].is_primary, true);
        assert.strictEqual(cv.individual, false);
        assert.ok(!JSON.stringify(a.json).includes('sandiUtama'));
    });

    await test('entitas lokal: tampil di mode Saya bersama entitas Hub; tidak di mode Grup', async () => {
        const personal = await GET('/api/entities?mode=personal');
        assert.deepStrictEqual(personal.json.entities.map((e) => e.project + ':' + e.entity_name).sort(),
            ['local:Ani Sample Wijaya', 'local:CV Klien Baru Sejahtera', 'taxio_hub:Budi Contoh Santoso']);
        const group = await GET('/api/entities?mode=group');
        assert.ok(!group.json.entities.some((e) => e.project === 'local'));
    });

    await test('entitas lokal: PIC sekarang bagian dari Badan itu sendiri - menghapus entitas lain tidak memblokirnya', async () => {
        assert.strictEqual((await POST('/api/local-entities/delete', { id: ani.local_id })).status, 200);
        assert.ok((await GET('/api/local-entities')).json.entities.some((e) => e.local_id === cv.local_id), 'CV tidak ikut terhapus/terganggu');
    });

    // ---- semua fitur: entitas lokal login OTOMATIS; sesi manual polos TETAP ADA terpisah ----
    const localSelEntity = () => ({ project: 'local', local_id: cv.local_id, entity_id: cv.entity_id, entity_name: cv.entity_name, npwp: cv.npwp, individual: false, pic_id: cv.pics[0].pic_id, pic_name: cv.pics[0].pic_name });
    const manualSelEntity = { project: 'manual', entity_name: 'Sesi Manual' };
    const routes = [
        ['e-Bupot', '/api/actions/download-ebupot', { bupotType: 'bp21', masaInput: '0126' }],
        ['Bukti Potong Saya', '/api/actions/download-mybupot', { buktiTypeKeys: ['bppu'], masaInput: '0126' }],
        ['SPT', '/api/actions/download-spt', { jenisPajakKeys: ['ppn'], masaInput: '0126' }],
        ['Pajak Masukan (unduh)', '/api/actions/download-pajak-masukan', { masaInput: '0126' }],
        ['Pajak Masukan (kredit)', '/api/actions/import-pajak-masukan', { fileBase64: 'AAAA' }],
        ['Kode Billing PPh 25', '/api/actions/billing-pph25', { masaInput: '0726', nominal: 'Rp 1.500.000' }]
    ];
    for (const [label, url, extra] of routes) {
        await test('entitas lokal: ' + label + ' login OTOMATIS (bukan lagi ditolak sebagai manual)', async () => {
            const a = await POST(url, Object.assign({ entity: localSelEntity() }, extra));
            assert.strictEqual(a.status, 202, label + ': ' + JSON.stringify(a.json));
            await waitIdle();
        });
        await test('sesi manual polos: ' + label + ' tetap membutuhkan jendela Coretax yang sudah dibuka (perilaku lama, tidak berubah)', async () => {
            const a = await POST(url, Object.assign({ entity: manualSelEntity }, extra));
            assert.strictEqual(a.status, 401);
            assert.ok(/Sesi manual belum ada/.test(a.json.error), label);
        });
    }

    await test('entitas lokal yang tidak ada (mis. sudah dihapus) -> 404', async () => {
        const a = await POST('/api/actions/billing-pph25', { entity: Object.assign({}, localSelEntity(), { local_id: 'le_tidakada' }), masaInput: '0726', nominal: '1000' });
        assert.strictEqual(a.status, 404);
    });

    await test('field entitas dipalsukan klien (individual, npwp, nama) diabaikan - server selalu membaca ulang dari penyimpanan', async () => {
        const a = await POST('/api/actions/billing-pph25', { entity: Object.assign({}, localSelEntity(), { individual: true, npwp: '0000000000000000', entity_name: 'PALSU' }), masaInput: '0726', nominal: '1000' });
        assert.strictEqual(a.status, 202, 'field palsu tidak berpengaruh; entitas tetap resolve normal dari penyimpanan');
        await waitIdle();
    });

    await test('entitas lokal: PIC yang dipilih menentukan kredensial mana yang dipakai', async () => {
        const withSecondPic = Object.assign({}, localSelEntity(), { pic_id: cv.pics[1].pic_id, pic_name: cv.pics[1].pic_name });
        const a = await POST('/api/actions/login-entity', { entity: withSecondPic });
        assert.strictEqual(a.status, 202);
        await waitIdle();
        const b = await POST('/api/actions/login-entity', { entity: Object.assign({}, localSelEntity(), { pic_id: 'lp_tidakada' }) });
        assert.strictEqual(b.status, 404, 'PIC yang tidak ada di penyimpanan ditolak, bukan diteruskan begitu saja');
    });

    await test('Billing: validasi masa dan nominal', async () => {
        const a = await POST('/api/actions/billing-pph25', { entity: localSelEntity(), masaInput: '1326', nominal: '1000' });
        assert.strictEqual(a.status, 400); assert.ok(/MMYY/.test(a.json.error));
        const b = await POST('/api/actions/billing-pph25', { entity: localSelEntity(), masaInput: '0726', nominal: '' });
        assert.strictEqual(b.status, 400); assert.ok(/Nominal/.test(b.json.error));
        const c = await POST('/api/actions/billing-pph25', { masaInput: '0726', nominal: '1000' });
        assert.strictEqual(c.status, 400);
    });

    await test('login otomatis untuk sesi manual polos ditolak dengan arahan yang jelas (tombol khusus entitas otomatis)', async () => {
        const a = await POST('/api/actions/login-entity', { entity: manualSelEntity });
        assert.strictEqual(a.status, 400); assert.ok(/login sendiri/.test(a.json.error));
    });

    await test('permintaan POST lintas-origin tetap ditolak', async () => {
        const a = await POST('/api/local-entities/save', { name: 'X', type: 'op' }, { Origin: 'http://situs-lain.example' });
        assert.strictEqual(a.status, 403);
    });

    // ---- Restricted Editor ----
    await test('Restricted Editor: entitas lokal dan login manual diblokir, daftar Saya tanpa entitas lokal', async () => {
        await POST('/api/disconnect', { project: 'taxio_hub' });
        S.role = 'restricted_editor';
        const c = await POST('/api/connect', { project: 'taxio_hub', email: 'baru@contoh.com', password: 'benar' });
        assert.strictEqual(c.json.taxio_hub.role, 'restricted_editor');
        assert.strictEqual((await GET('/api/local-entities')).status, 403);
        assert.strictEqual((await POST('/api/local-entities/save', { name: 'X', type: 'op' })).status, 403);
        for (const [label, url, extra] of routes) {
            const a = await POST(url, Object.assign({ entity: localSelEntity() }, extra));
            assert.strictEqual(a.status, 403, label + ': ' + JSON.stringify(a.json));
            assert.ok(/Restricted Editor/.test(a.json.error), label);
            const m = await POST(url, Object.assign({ entity: manualSelEntity }, extra));
            assert.strictEqual(m.status, 403, 'manual · ' + label);
        }
        const personal = await GET('/api/entities?mode=personal');
        assert.ok(!personal.json.entities.some((e) => e.project === 'local'));
    });

    await test('keluar: sesi dan status menunggu ikut dibersihkan', async () => {
        const before = disconnects;
        const a = await POST('/api/disconnect', { project: 'taxio_hub' });
        assert.strictEqual(a.json.taxio_hub.connected, false);
        assert.ok(disconnects > before);
        S.role = 'editor'; S.active = false; S.queued = [];
        const b = await POST('/api/connect', { project: 'taxio_hub', email: 'tanpa-inisial@contoh.com', password: 'benar' });
        assert.strictEqual(b.json.taxio_hub.pending.status, 'need-initial');
        const c = await POST('/api/registration/initial', { initial: 'xyz' });
        assert.strictEqual(c.json.taxio_hub.pending.status, 'waiting-assignment');
        assert.strictEqual(c.json.taxio_hub.pending.initial, 'XYZ');
        const d = await POST('/api/disconnect', { project: 'taxio_hub' });
        assert.strictEqual(d.json.taxio_hub.pending, undefined);
    });

    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
    fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
