/* Tes alur pendaftaran (lib/registration.js + lib/connection.js) memakai klien Supabase palsu.
   Tidak menyentuh jaringan, akun Taxio Hub, ataupun folder data asli. Jalankan:
     node scripts/test-registration.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TAXIO_PILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-test-'));
const registration = require('../lib/registration');
const connection = require('../lib/connection');

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

/** Klien palsu: `cfg` menentukan jawaban tiap panggilan. */
function fakeClient(cfg = {}) {
    const calls = [];
    const ok = (data) => Promise.resolve({ data, error: null });
    const err = (message) => Promise.resolve({ data: null, error: { message } });
    return {
        calls,
        auth: {
            signUp: async (args) => { calls.push(['signUp', args]); return cfg.signUp ? cfg.signUp(args) : { data: { user: { identities: [{}] }, session: null }, error: null }; }
        },
        rpc: (name, args) => {
            calls.push(['rpc', name, args]);
            const h = cfg[name];
            if (typeof h === 'function') return Promise.resolve(h(args));
            if (h !== undefined) return h.error ? err(h.error) : ok(h.data);
            return ok(null);
        },
        from: (table) => ({
            select: () => ({ eq: () => ({ limit: () => { calls.push(['from', table]); return cfg.memberships ? Promise.resolve(cfg.memberships) : ok([]); } }) })
        })
    };
}
const USER = { id: 'u-1', email: 'baru@contoh.com' };

(async () => {
    console.log('registration');

    await test('validateSignup memakai kalimat yang sama dengan Taxio Hub', () => {
        assert.strictEqual(registration.validateSignup({ initial: '', email: 'a@b.co', password: '123456' }), 'Inisial wajib diisi.');
        assert.strictEqual(registration.validateSignup({ initial: 'SGA', email: '', password: '123456' }), 'Email & kata sandi wajib diisi.');
        assert.strictEqual(registration.validateSignup({ initial: 'SGA', email: 'a@b.co', password: '12345' }), 'Kata sandi minimal 6 karakter.');
        assert.strictEqual(registration.validateSignup({ initial: 'ABCDEFGHI', email: 'a@b.co', password: '123456' }), 'Inisial maksimal 8 karakter.');
        assert.strictEqual(registration.validateSignup({ initial: 'sga', email: 'bukan-email', password: '123456' }), 'Format email tidak valid.');
        assert.strictEqual(registration.validateSignup({ initial: 'sga', email: 'a@b.co', password: '123456' }), null);
    });

    await test('signUp tanpa sesi -> confirm-email, inisial disimpan huruf besar dan redirect ke Taxio Hub', async () => {
        const c = fakeClient();
        const r = await registration.signUp(c, { initial: ' sga ', email: 'Baru@Contoh.com', password: '123456' });
        assert.strictEqual(r.status, 'confirm-email');
        assert.strictEqual(registration.recallInitial('baru@contoh.com'), 'SGA');
        const args = c.calls.find((x) => x[0] === 'signUp')[1];
        assert.strictEqual(args.options.emailRedirectTo, 'https://taxio-hub.pages.dev/');
        assert.strictEqual(args.email, 'Baru@Contoh.com');
    });

    await test('signUp dengan sesi langsung (konfirmasi email nonaktif) -> status session', async () => {
        const c = fakeClient({ signUp: () => ({ data: { user: { id: 'u-2', identities: [{}] }, session: { access_token: 't' } }, error: null }) });
        const r = await registration.signUp(c, { initial: 'AB', email: 'dua@contoh.com', password: '123456' });
        assert.strictEqual(r.status, 'session');
        assert.strictEqual(r.session.access_token, 't');
    });

    await test('signUp email sudah terdaftar (respons samaran Supabase) -> galat dan inisial dilupakan', async () => {
        const c = fakeClient({ signUp: () => ({ data: { user: { identities: [] }, session: null }, error: null }) });
        await assert.rejects(() => registration.signUp(c, { initial: 'XY', email: 'ada@contoh.com', password: '123456' }), /sudah terdaftar/);
        assert.strictEqual(registration.recallInitial('ada@contoh.com'), '');
    });

    await test('signUp menerjemahkan galat Supabase', async () => {
        const c = fakeClient({ signUp: () => ({ data: null, error: { message: 'User already registered' } }) });
        await assert.rejects(() => registration.signUp(c, { initial: 'XY', email: 'lagi@contoh.com', password: '123456' }), /sudah terdaftar. Silakan masuk/);
        const c2 = fakeClient({ signUp: () => ({ data: null, error: { message: 'email rate limit exceeded' } }) });
        await assert.rejects(() => registration.signUp(c2, { initial: 'XY', email: 'lagi@contoh.com', password: '123456' }), /Terlalu banyak percobaan/);
    });

    await test('signUp menolak input tidak valid sebelum menghubungi server', async () => {
        const c = fakeClient();
        await assert.rejects(() => registration.signUp(c, { initial: '', email: 'a@b.co', password: '123456' }), /Inisial wajib diisi/);
        assert.strictEqual(c.calls.length, 0);
    });

    await test('resolveStatus: anggota aktif', async () => {
        const c = fakeClient({ get_my_active_membership: { data: [{ org_id: 'o1' }] } });
        assert.deepStrictEqual(await registration.resolveStatus(c, USER, USER.email), { status: 'active' });
    });

    await test('resolveStatus: baris membership belum aktif -> waiting-approval', async () => {
        const c = fakeClient({ get_my_active_membership: { data: [] }, memberships: { data: [{ user_id: 'u-1' }], error: null } });
        assert.strictEqual((await registration.resolveStatus(c, USER, USER.email)).status, 'waiting-approval');
    });

    await test('resolveStatus: ada di antrean -> waiting-assignment dengan inisialnya', async () => {
        const c = fakeClient({ get_my_active_membership: { data: [] }, get_my_membership_request: { data: [{ initial: 'SGA' }] } });
        const r = await registration.resolveStatus(c, USER, USER.email);
        assert.deepStrictEqual(r, { status: 'waiting-assignment', initial: 'SGA' });
        assert.ok(!c.calls.some((x) => x[1] === 'request_membership'), 'tidak boleh mengajukan ulang');
    });

    await test('resolveStatus: inisial tersimpan diajukan otomatis lalu dilupakan', async () => {
        registration.rememberInitial(USER.email, 'sga');
        const c = fakeClient({ get_my_active_membership: { data: [] }, get_my_membership_request: { data: [] }, request_membership: { data: 'ok' } });
        const r = await registration.resolveStatus(c, USER, USER.email);
        assert.deepStrictEqual(r, { status: 'waiting-assignment', initial: 'SGA', submitted: true });
        assert.deepStrictEqual(c.calls.find((x) => x[1] === 'request_membership')[2], { p_initial: 'SGA' });
        assert.strictEqual(registration.recallInitial(USER.email), '');
    });

    await test('resolveStatus: pengajuan otomatis ditolak -> need-initial, inisial tetap tersimpan', async () => {
        registration.rememberInitial(USER.email, 'sga');
        const c = fakeClient({ get_my_active_membership: { data: [] }, get_my_membership_request: { data: [] }, request_membership: { error: 'Akun ini sudah memiliki membership' } });
        assert.strictEqual((await registration.resolveStatus(c, USER, USER.email)).status, 'need-initial');
        assert.strictEqual(registration.recallInitial(USER.email), 'SGA');
        registration.forgetInitial(USER.email);
    });

    await test('resolveStatus: tanpa inisial tersimpan -> need-initial', async () => {
        const c = fakeClient({ get_my_active_membership: { data: [] }, get_my_membership_request: { data: [] } });
        assert.strictEqual((await registration.resolveStatus(c, USER, USER.email)).status, 'need-initial');
        assert.ok(!c.calls.some((x) => x[1] === 'request_membership'));
    });

    await test('resolveStatus: RPC antrean belum ada di proyek lama dianggap kosong', async () => {
        const c = fakeClient({ get_my_active_membership: { data: [] }, get_my_membership_request: { error: 'Could not find the function' } });
        assert.strictEqual((await registration.resolveStatus(c, USER, USER.email)).status, 'need-initial');
    });

    await test('resolveStatus: galat jaringan dilempar, bukan dianggap need-initial', async () => {
        const c = fakeClient({ get_my_active_membership: { error: 'TypeError: fetch failed' } });
        await assert.rejects(() => registration.resolveStatus(c, USER, USER.email), /Tidak bisa menghubungi server/);
    });

    await test('submitInitial: sukses, tidak valid, dan galat server', async () => {
        const ok = fakeClient({ request_membership: { data: 'ok' } });
        assert.deepStrictEqual(await registration.submitInitial(ok, USER.email, ' abc '), { status: 'waiting-assignment', initial: 'ABC', submitted: true });
        await assert.rejects(() => registration.submitInitial(ok, USER.email, ''), /Inisial wajib diisi/);
        const bad = fakeClient({ request_membership: { error: 'Akun ini sudah memiliki membership' } });
        await assert.rejects(() => registration.submitInitial(bad, USER.email, 'ABC'), /sudah memiliki membership/);
    });

    await test('isEmailNotConfirmed mengenali kode dan pesan Supabase', () => {
        assert.ok(registration.isEmailNotConfirmed({ code: 'email_not_confirmed' }));
        assert.ok(registration.isEmailNotConfirmed({ message: 'Email not confirmed' }));
        assert.ok(!registration.isEmailNotConfirmed({ message: 'Invalid login credentials' }));
    });

    // ---- lib/connection.js ----
    function fakeDeps(status, extra = {}) {
        const stateCalls = [];
        return {
            stateCalls,
            registration: { resolveStatus: async () => Object.assign({ status }, extra), recallInitial: () => 'SGA' },
            entitiesLib: { getMyOrgId: async () => ({ org_id: 'o1', role: 'editor' }) },
            state: {
                set: (...a) => stateCalls.push(['set', ...a]), clear: (...a) => stateCalls.push(['clear', ...a]),
                setPending: (...a) => stateCalls.push(['setPending', ...a]), clearPending: (...a) => stateCalls.push(['clearPending', ...a])
            },
            log: () => {}
        };
    }
    const AUTH = { client: {}, project: { label: 'Taxio Hub' }, session: { s: 1 }, user: USER };

    await test('attach: anggota aktif -> state.set dengan org dan peran, pending dibersihkan', async () => {
        const d = fakeDeps('active');
        assert.deepStrictEqual(await connection.attach('taxio_hub', AUTH, d), { status: 'active' });
        const set = d.stateCalls.find((x) => x[0] === 'set');
        assert.strictEqual(set[2].orgId, 'o1');
        assert.strictEqual(set[2].role, 'editor');
        assert.ok(d.stateCalls.some((x) => x[0] === 'clearPending'));
    });

    await test('attach: belum aktif -> hanya pending, tidak pernah dianggap terhubung', async () => {
        const d = fakeDeps('waiting-assignment', { initial: 'SGA' });
        const r = await connection.attach('taxio_hub', AUTH, d);
        assert.strictEqual(r.status, 'waiting-assignment');
        assert.ok(!d.stateCalls.some((x) => x[0] === 'set'));
        const p = d.stateCalls.find((x) => x[0] === 'setPending')[2];
        assert.strictEqual(p.status, 'waiting-assignment');
        assert.strictEqual(p.email, 'baru@contoh.com');
        assert.strictEqual(p.initial, 'SGA');
    });

    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
    fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
})();
