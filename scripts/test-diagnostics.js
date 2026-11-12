/* Offline tests for lib/diagnostics.js (Ekspor diagnostik) and POST /api/diagnostics/export.
 * The zip is written to a temp folder (TAXIO_PILOT_DOWNLOADS_DIR / outDir) - never the real Downloads.
 * Asserts: expected entries, log tail limited to the last 2000 lines, and that NO secret can leak:
 * session.json / local-entities.json contents, JWTs, Bearer tokens, access/refresh tokens,
 * passphrases/passwords, the runtime token (also not in runtime.json of the zip), ?t= links. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-diag-'));
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'root');
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'logs', 'coretax-agent.log');
process.env.TAXIO_PILOT_DOWNLOADS_DIR = path.join(TMP, 'Downloads');
const JSZip = require('jszip');
const diagnostics = require('../lib/diagnostics');
const runtime = require('../lib/runtime');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

// Secrets that must never appear in the zip (all fake).
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEyMyIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.c2lnbmF0dXJlLXBhbHN1LXNla2FsaQ';
const RUNTIME_TOKEN = runtime.newToken();
const SECRETS = [JWT, RUNTIME_TOKEN, 'rahasia-refresh-123456', 'PassphraseRahasia!9', 'KataSandiRahasia77', 'SESSION-MARKER-ZZZ', 'ENTITY-SECRET-MARKER-QQQ', 'opaque-bearer-abcdefgh123'];

const DATA = path.join(process.env.TAXIO_PILOT_DATA_DIR, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'session.json'), JSON.stringify({ 'sb-x-auth-token': JSON.stringify({ access_token: JWT, refresh_token: 'rahasia-refresh-123456', marker: 'SESSION-MARKER-ZZZ' }) }));
fs.writeFileSync(path.join(DATA, 'local-entities.json'), JSON.stringify({ entities: [{ name: 'ENTITY-SECRET-MARKER-QQQ', passphrase: 'PassphraseRahasia!9' }] }));
fs.mkdirSync(path.dirname(process.env.TAXIO_PILOT_LOG_FILE), { recursive: true });
const lines = [];
for (let i = 1; i <= 2600; i++) lines.push('[2026-11-12T00:00:00.000Z] baris ' + i);
lines.push('[x] Authorization: Bearer opaque-bearer-abcdefgh123 dikirim');
lines.push('[x] token sesi ' + JWT + ' kedaluwarsa');
lines.push('[x] {"access_token":"' + JWT + '","refresh_token":"rahasia-refresh-123456"}');
lines.push('[x] passphrase=PassphraseRahasia!9 password: KataSandiRahasia77');
lines.push('[x] buka http://127.0.0.1:51733/?t=' + RUNTIME_TOKEN + ' sekarang');
lines.push('[x] runtime ' + RUNTIME_TOKEN);
lines.push('[x] file di ' + path.join(os.homedir(), 'Downloads', 'CoretaxAgent', 'x.pdf'));
lines.push('[x] PT CONTOH ABADI NPWP 0123456780910000 baris terakhir');
fs.writeFileSync(process.env.TAXIO_PILOT_LOG_FILE, lines.join('\n') + '\n');

async function unzip(file) {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const out = {};
    for (const name of Object.keys(zip.files)) out[name] = await zip.files[name].async('string');
    return out;
}
function assertNoSecrets(entries) {
    const all = Object.values(entries).join('\n');
    for (const s of SECRETS) assert.ok(!all.includes(s), 'secret leaked: ' + s.slice(0, 12));
    assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(all), 'JWT-shaped string leaked');
    assert.ok(!Object.keys(entries).some((n) => /session|local-entities|pending-signup/i.test(n)), 'data files never included');
}

(async () => {
    await test('scrub: JWT, Bearer, token/passphrase/password fields, ?t= and 64-hex values are censored', () => {
        const s = diagnostics.scrub(lines.slice(-8).join('\n'), [RUNTIME_TOKEN]);
        for (const x of SECRETS.filter((x) => !/MARKER/.test(x))) assert.ok(!s.includes(x), x.slice(0, 12));
        assert.ok(/\[JWT-DISENSOR\]/.test(s) && /Bearer \[DISENSOR\]/.test(s) && /\?t=\[(DISENSOR|RAHASIA-DISENSOR)\]/.test(s));
        assert.ok(s.includes('NPWP 0123456780910000'), 'business data kept (user is warned in the UI)');
        assert.strictEqual(diagnostics.scrub('Login gagal: token sesi tidak valid'), 'Login gagal: token sesi tidak valid', 'plain prose untouched');
    });

    await test('tailLog: last 2000 lines (falls back to .1 when the current file is short)', () => {
        const t = diagnostics.tailLog(process.env.TAXIO_PILOT_LOG_FILE, 2000);
        assert.strictEqual(t.length, 2000);
        assert.ok(t[t.length - 1].includes('baris terakhir'));
        const f = path.join(TMP, 'rot.log');
        fs.writeFileSync(f + '.1', 'lama-1\nlama-2\n'); fs.writeFileSync(f, 'baru-1\n');
        assert.deepStrictEqual(diagnostics.tailLog(f, 2), ['lama-2', 'baru-1']);
        assert.deepStrictEqual(diagnostics.tailLog(path.join(TMP, 'tidak-ada.log'), 5), []);
    });

    let zipEntries;
    await test('exportZip: expected entries, health/runtime/log content, no secrets, home -> %USERPROFILE%', async () => {
        const health = { at: 'x', summary: { ok: 1, warn: 0, fail: 0 }, checks: [{ id: 'data-root', label: 'Folder data dapat ditulis', status: 'ok', detail: 'ok', fix: '' }] };
        const out = await diagnostics.exportZip({ health, runtimeInfo: { port: 51733, pid: 1, version: '3.0.44', token: RUNTIME_TOKEN }, secrets: [RUNTIME_TOKEN], now: new Date(2026, 10, 12, 9, 5, 7) });
        assert.strictEqual(out.file, path.join(TMP, 'Downloads', 'TaxioPilot-diagnostik-20261112-090507.zip'));
        assert.ok(out.bytes > 0 && fs.statSync(out.file).size === out.bytes);
        zipEntries = await unzip(out.file);
        assert.deepStrictEqual(Object.keys(zipEntries).sort(), ['BACA-SAYA.txt', 'log-terakhir.txt', 'lokasi.json', 'pemeriksaan-sistem.json', 'runtime.json', 'sistem.json']);
        assert.strictEqual(JSON.parse(zipEntries['pemeriksaan-sistem.json']).checks[0].id, 'data-root');
        const rt = JSON.parse(zipEntries['runtime.json']);
        assert.strictEqual(rt.port, 51733); assert.strictEqual(rt.token, undefined);
        const sys = JSON.parse(zipEntries['sistem.json']);
        assert.ok(sys.app.version && sys.node.version && sys.os.platform);
        const loc = JSON.parse(zipEntries['lokasi.json']);
        assert.ok(loc.root && loc.logFile && loc.profilesInstalled);
        const logLines = zipEntries['log-terakhir.txt'].split(/\r?\n/);
        assert.strictEqual(logLines.length, 2000);
        assert.ok(logLines[logLines.length - 1].includes('baris terakhir'));
        assert.ok(zipEntries['log-terakhir.txt'].includes('%USERPROFILE%'));
        assert.ok(!zipEntries['log-terakhir.txt'].includes(os.homedir()));
        assert.ok(/NPWP/.test(zipEntries['BACA-SAYA.txt']));
        assertNoSecrets(zipEntries);
    });

    await test('POST /api/diagnostics/export: token required, zip in the (test) Downloads folder, no secrets', async () => {
        const doctor = require('../lib/doctor');
        const realRun = doctor.runChecks;
        doctor.runChecks = async () => ({ at: 'x', summary: { ok: 1, warn: 0, fail: 0 }, checks: [] });
        const { createGuiServer } = require('../gui/server');
        const server = await createGuiServer(0, { token: RUNTIME_TOKEN });
        const base = 'http://127.0.0.1:' + server.address().port;
        try {
            assert.strictEqual((await fetch(base + '/api/diagnostics/export', { method: 'POST' })).status, 401);
            const r = await fetch(base + '/api/diagnostics/export', { method: 'POST', headers: { Authorization: 'Bearer ' + RUNTIME_TOKEN } });
            assert.strictEqual(r.status, 200);
            const j = await r.json();
            assert.ok(j.file.startsWith(path.join(TMP, 'Downloads')) && fs.existsSync(j.file));
            const entries = await unzip(j.file);
            const rt = JSON.parse(entries['runtime.json']);
            assert.strictEqual(rt.port, server.address().port); assert.strictEqual(rt.tokenRequired, true); assert.strictEqual(rt.token, undefined);
            assertNoSecrets(entries);
        } finally {
            doctor.runChecks = realRun;
            await new Promise((res) => server.close(res));
        }
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
