/* Pengganti Supabase, Chrome, dan daftar entitas untuk tes yang menjalankan server dashboard
   sungguhan (scripts/test-gui-api.js, scripts/test-gui-ui.js). Tidak membuka Chrome untuk
   Coretax dan tidak menghubungi Taxio Hub. Panggil install() SEBELUM require('../gui/server'). */
const fs = require('fs');
const os = require('os');
const path = require('path');

function install() {
    process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-ui-'));
    const sessionStore = require('../lib/session-store');
    const entitiesLib = require('../lib/entities');
    const chrome = require('../lib/chrome');
    const runcontrol = require('../lib/runcontrol');

    // Keadaan yang bisa diubah tes.
    const ctl = {
        reg: { active: false, queued: [], memberships: [], requests: [] },
        role: 'editor',
        manual: { open: false, loggedIn: false, identity: '' },
        run: null,          // bila diisi, /api/run/status mengembalikan ini
        runCalls: [],
        sessions: []        // isi tes untuk mengetes bagian "Sesi Aktif" di palet entitas
    };
    const ok = (data) => Promise.resolve({ data, error: null });
    const fake = {
        auth: { signUp: async () => ({ data: { user: { identities: [{}] }, session: null }, error: null }) },
        rpc: (name, args) => {
            if (name === 'get_my_active_membership') return ok(ctl.reg.active ? [{ org_id: 'o1' }] : []);
            if (name === 'get_my_membership_request') return ok(ctl.reg.queued);
            if (name === 'request_membership') { ctl.reg.queued = [{ initial: args.p_initial }]; ctl.reg.requests.push(args.p_initial); return ok('ok'); }
            return ok(null);
        },
        from: () => ({ select: () => ({ eq: () => ({ limit: () => ok(ctl.reg.memberships) }) }) })
    };
    const PROJECT = { id: 'taxio_hub', label: 'Taxio Hub' };
    sessionStore.clientFor = () => ({ client: fake, project: PROJECT });
    sessionStore.connectWithPassword = async (id, email, password) => {
        if (password === 'salah') throw { message: 'Invalid login credentials' };
        if (password === 'belum') throw { code: 'email_not_confirmed', message: 'Email not confirmed' };
        return { client: fake, project: PROJECT, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, user: { id: 'u-1', email } };
    };
    sessionStore.refreshIfNeeded = async () => {};
    sessionStore.disconnect = async () => {};
    entitiesLib.getMyOrgId = async () => ({ org_id: 'o1', role: ctl.role });

    const r = (o) => Object.assign({ npwp: '', individual: false, pic_is_mine: true, is_primary: false }, o);
    const GROUP_ROWS = [
        r({ entity_id: 'MKA', entity_name: 'MITRA KARYA ABADI, PT', npwp: '0317927093541000', pic_id: 'p-andi', pic_name: 'ANDI PRATAMA', is_primary: true }),
        r({ entity_id: 'MKA', entity_name: 'MITRA KARYA ABADI, PT', npwp: '0317927093541000', pic_id: 'p-rina', pic_name: 'RINA WIJAYA' }),
        r({ entity_id: 'CSA', entity_name: 'PT Contoh Sejahtera Abadi', npwp: '0123456780910000', pic_id: 'p-andi', pic_name: 'ANDI PRATAMA', is_primary: true }),
        r({ entity_id: 'SNM', entity_name: 'CV Sample Niaga Mandiri', pic_id: 'p-rina', pic_name: 'RINA WIJAYA', is_primary: true }),
        r({ entity_id: 'MLU', entity_name: 'MITRA LESTARI UTAMA, PT', pic_id: 'unlinked', pic_name: 'Belum Taut PIC Coretax', is_primary: true }),
        r({ entity_id: 'BUDI', entity_name: 'Budi Contoh Santoso', npwp: '0456789012340000', pic_id: 'p-budi', pic_name: 'Budi Contoh Santoso', individual: true, is_primary: true })
    ];
    entitiesLib.listAutomatableEntities = async (client, org, uid, owner, mode) => (mode === 'personal' ? [GROUP_ROWS[5]] : GROUP_ROWS).map((x) => Object.assign({}, x));

    chrome.getManualPage = () => null;
    chrome.getManualStatus = async () => Object.assign({}, ctl.manual);
    chrome.listLiveSessions = async () => ctl.sessions.map((s) => Object.assign({}, s));
    chrome.bringSessionToFront = async () => true;
    chrome.getEntityStatus = async (picId) => { const s = ctl.sessions.find((x) => x.picId === picId); return s ? { open: true, loggedIn: !!s.loggedIn, identity: s.identity || '' } : { open: false, loggedIn: false, identity: '' }; };
    chrome.closeLiveSession = async (picId) => { ctl.sessions = ctl.sessions.filter((s) => s.picId !== picId); return true; };
    chrome.openCoretaxManual = async () => { ctl.manual.open = true; return true; };
    // Entitas lokal (tab Saya) sekarang benar-benar mencoba login OTOMATIS lewat jalur yang sama
    // dengan Taxio Hub (lib/local-auth-client.js) - tanpa penyamar ini, memilihnya di UI akan
    // mencoba membuka Chrome sungguhan. Setiap panggilan gagal cepat di langkah berikutnya
    // (halaman tiruan bukan Coretax sungguhan), cukup untuk mengetes bahwa proses dimulai.
    chrome.isLoggedOut = () => false;
    const fakePage = { isClosed: () => false, url: () => '', goto: async () => { throw new Error('halaman tiruan: tidak ada Coretax sungguhan di tes ini'); } };
    chrome.launchOrReuseContext = async () => ({ context: {}, page: fakePage, reused: false, userDataDir: '/tmp/fake' });
    chrome.loginAndImpersonate = async () => true;

    const realStatus = runcontrol.status;
    // ctl.run boleh fungsi (key) => status, untuk mengetes beberapa sesi dengan status berbeda.
    runcontrol.status = (key) => (typeof ctl.run === 'function' ? ctl.run(key) : ctl.run ? ctl.run : realStatus(key));
    for (const name of ['pause', 'resume', 'skip', 'retry', 'back', 'stop']) {
        const real = runcontrol[name];
        runcontrol[name] = (key) => { ctl.runCalls.push(name); if (!ctl.run) real(key); };
    }
    return { ctl, GROUP_ROWS };
}

module.exports = { install };
