/* Offline tests for "Reset all data" (lib/reset.js, POST /api/settings/reset-all, lib/paths.js skip marker) and
 * the static shape of the NSIS customisation (installer/installer.nsh). Everything runs against a temp
 * TAXIO_PILOT_DATA_DIR or an in-memory fake filesystem - the real %LOCALAPPDATA%\TaxioPilot is never read or written.
 *   - pure part with a fake fs: what is deleted vs kept, locked entries reported (never thrown) and the marker still
 *     dropped, symlink/junction only unlinked, stale/corrupt marker ignored, previous instance still alive -> deferred,
 *     unsafe root refused, no marker -> no-op;
 *   - real temp dir: request() -> runPending() end to end; paths.migrate()/resolveProfileDir honour the skip marker;
 *   - route: refused (409) while a run is active/queued, 400 without confirm, success writes the marker + signs out
 *     of Taxio Hub locally + relaunches through the shell seam without deleting anything yet; the next start
 *     (runPending) then deletes the data and keeps chrome\ and the result files;
 *   - installer/installer.nsh: static checks (the real compile check needs makensis and is done at build time).
 * Run: node scripts/test-reset.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-reset-'));
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'akar');
process.env.TAXIO_PILOT_DOWNLOADS_DIR = path.join(TMP, 'Downloads');
process.env.TAXIO_PILOT_LEGACY_HOME = path.join(TMP, 'home');
process.env.TAXIO_PILOT_STARTUP_HEALTH = '0';
const reset = require('../lib/reset');
const paths = require('../lib/paths');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}

/** In-memory tree (sync fs subset used by lib/reset.js). `locked`: names whose rmSync throws EBUSY. `links`: symlinked names. */
function fakeFs(root, names, opts) {
    const o = opts || {};
    const entries = new Map(names.map((n) => [n, { dir: !/\.(json|png)$/.test(n) }]));
    const calls = { rm: [], unlink: [], write: {} };
    const lc = (p) => path.resolve(p).toLowerCase();
    const R = lc(root);
    const nameOf = (p) => { const l = lc(p); return l.startsWith(R + '\\') ? Array.from(entries.keys()).find((n) => lc(path.join(root, n)) === l) || null : null; };
    const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; return e; };
    return {
        calls, entries,
        lstatSync: (p) => {
            if (lc(p) === R) return { isSymbolicLink: () => false };
            const n = nameOf(p); if (!n) { if (calls.write[lc(p)] !== undefined) return { isSymbolicLink: () => false }; throw enoent(); }
            return { isSymbolicLink: () => !!(o.links || []).includes(n) };
        },
        readdirSync: () => Array.from(entries.keys()),
        readFileSync: (p) => { const v = calls.write[lc(p)]; if (v === undefined) throw enoent(); return v; },
        writeFileSync: (p, data) => { calls.write[lc(p)] = String(data); },
        mkdirSync: () => {},
        unlinkSync: (p) => { const n = nameOf(p); calls.unlink.push(n || path.basename(p)); if (n) entries.delete(n); else delete calls.write[lc(p)]; },
        rmSync: (p) => {
            const n = nameOf(p); calls.rm.push(n);
            if (n && (o.locked || []).includes(n)) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
            if (n) entries.delete(n);
        }
    };
}
const ROOT = 'C:\\Uji\\TaxioPilot';
const ALL = ['data', 'logs', 'profiles', 'unduhan-sementara', 'electron', 'runtime.json', 'update-cache', 'jendela-dashboard.png', 'uji-diri-profil-123', 'chrome', 'legacy-v3.json', 'update-install.json', 'folder-asing'];
const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);

(async () => {
    await test('selectTargets: allowlist only; chrome, legacy-v3.json, update-install.json and unknown entries are kept', () => {
        assert.deepStrictEqual(reset.selectTargets(ALL).sort(), ['data', 'electron', 'jendela-dashboard.png', 'logs', 'profiles', 'runtime.json', 'uji-diri-profil-123', 'unduhan-sementara', 'update-cache'].sort());
        assert.ok(!reset.selectTargets(['reset-pending.json', 'skip-legacy-migration.json', 'Chrome', 'LEGACY-V3.JSON']).length);
        assert.ok(reset.isSafeRoot('C:\\Users\\x\\AppData\\Local\\TaxioPilot') && !reset.isSafeRoot('C:\\') && !reset.isSafeRoot('C:\\Users') && !reset.isSafeRoot('') && !reset.isSafeRoot('relatif\\folder'));
    });

    await test('runPending (fake fs): deletes the allowlist, keeps the rest, writes the skip-legacy marker, drops the pending marker', () => {
        const f = fakeFs(ROOT, ALL);
        reset.request({ fs: f, root: ROOT, now: () => NOW, pid: 4242 });
        assert.ok(f.calls.write[reset.pendingFile(ROOT).toLowerCase()], 'marker written');
        assert.strictEqual(f.calls.rm.length, 0, 'request() deletes nothing');
        const r = reset.runPending({ fs: f, root: ROOT, now: () => NOW + 5000, readRuntime: () => null });
        assert.ok(r.ran, r.reason);
        assert.deepStrictEqual(r.deleted.sort(), reset.selectTargets(ALL).sort());
        assert.deepStrictEqual(Array.from(f.entries.keys()).sort(), ['chrome', 'folder-asing', 'legacy-v3.json', 'update-install.json']);
        assert.ok(f.calls.write[reset.skipLegacyFile(ROOT).toLowerCase()], 'skip-legacy marker written');
        assert.ok(f.calls.unlink.includes('reset-pending.json') || f.calls.write[reset.pendingFile(ROOT).toLowerCase()] === undefined, 'pending marker removed');
        assert.ok(/7 item|9 item/.test(reset.summaryLine(r)) && /Chrome bawaan dan folder hasil/.test(reset.summaryLine(r)));
        // A second start finds nothing to do.
        assert.strictEqual(reset.runPending({ fs: f, root: ROOT, now: () => NOW + 6000 }).ran, false);
        assert.strictEqual(reset.summaryLine(reset.runPending({ fs: f, root: ROOT })), '');
    });

    await test('runPending: a locked entry is reported and left, the others are still deleted, the marker is dropped anyway (no repeat on the next start)', () => {
        const f = fakeFs(ROOT, ALL, { locked: ['electron'] });
        reset.request({ fs: f, root: ROOT, now: () => NOW });
        const r = reset.runPending({ fs: f, root: ROOT, now: () => NOW + 1000, readRuntime: () => null });
        assert.ok(r.ran);
        assert.deepStrictEqual(r.failed.map((x) => [path.basename(x.path), x.error]), [['electron', 'EBUSY']]);
        assert.ok(f.entries.has('electron') && !f.entries.has('data'));
        assert.strictEqual(f.calls.write[reset.pendingFile(ROOT).toLowerCase()], undefined, 'marker gone');
        assert.ok(/1 item gagal dihapus dan dibiarkan \(electron: EBUSY\)/.test(reset.summaryLine(r)));
        assert.strictEqual(reset.runPending({ fs: f, root: ROOT, now: () => NOW + 2000 }).ran, false, 'not retried (new data must never be wiped)');
    });

    await test('runPending: symlink/junction entries are only unlinked (never followed), never throws on a broken fs', () => {
        const f = fakeFs(ROOT, ALL, { links: ['profiles'] });
        reset.request({ fs: f, root: ROOT, now: () => NOW });
        const r = reset.runPending({ fs: f, root: ROOT, now: () => NOW, readRuntime: () => null });
        assert.ok(f.calls.unlink.includes('profiles') && !f.calls.rm.includes('profiles'));
        assert.ok(r.deleted.includes('profiles'));
        const broken = Object.assign(fakeFs(ROOT, ALL), { lstatSync: () => { throw new Error('rusak'); } });
        assert.doesNotThrow(() => reset.runPending({ fs: broken, root: ROOT }));
    });

    await test('runPending: stale / corrupt marker is dropped without deleting anything', () => {
        for (const content of [JSON.stringify({ v: 1, at: NOW - 20 * 60 * 1000 }), 'bukan json', JSON.stringify({ v: 1 })]) {
            const f = fakeFs(ROOT, ALL);
            f.calls.write[reset.pendingFile(ROOT).toLowerCase()] = content;
            const r = reset.runPending({ fs: f, root: ROOT, now: () => NOW, readRuntime: () => null });
            assert.strictEqual(r.ran, false);
            assert.strictEqual(f.calls.rm.length, 0, content);
            assert.strictEqual(f.entries.size, ALL.length);
            assert.ok(/kedaluwarsa|rusak/.test(r.reason));
        }
    });

    await test('runPending: the previous instance still running -> waits, then defers (marker kept) instead of deleting under it', () => {
        const f = fakeFs(ROOT, ALL);
        reset.request({ fs: f, root: ROOT, now: () => NOW });
        let slept = 0;
        const deps = { fs: f, root: ROOT, now: () => NOW + 1000, readRuntime: () => ({ pid: 777 }), selfPid: 1, isPidAlive: () => true, sleep: () => { slept++; }, waitMs: 1000 };
        const r = reset.runPending(deps);
        assert.strictEqual(r.ran, false);
        assert.ok(/masih berjalan/.test(r.reason) && slept > 0);
        assert.strictEqual(f.calls.rm.length, 0);
        assert.ok(f.calls.write[reset.pendingFile(ROOT).toLowerCase()], 'marker kept for the next start');
        // It exits during the wait -> proceeds.
        let alive = true;
        const r2 = reset.runPending(Object.assign({}, deps, { isPidAlive: () => alive, sleep: () => { alive = false; } }));
        assert.ok(r2.ran);
        // runtime.json of ourselves (same pid) never blocks.
        const f3 = fakeFs(ROOT, ALL); reset.request({ fs: f3, root: ROOT, now: () => NOW });
        assert.ok(reset.runPending({ fs: f3, root: ROOT, now: () => NOW, readRuntime: () => ({ pid: 5 }), selfPid: 5, isPidAlive: () => true }).ran);
    });

    await test('request / runPending refuse an unsafe root', () => {
        const f = fakeFs('C:\\', ALL);
        assert.throws(() => reset.request({ fs: f, root: 'C:\\' }), /tidak valid/);
        f.calls.write['c:\\reset-pending.json'] = JSON.stringify({ v: 1, at: NOW });
        assert.strictEqual(reset.runPending({ fs: f, root: 'C:\\', now: () => NOW }).ran, false);
        assert.strictEqual(f.calls.rm.length, 0);
    });

    // ---------- real temp dir ----------
    const seed = () => {
        const R = paths.root();
        fs.rmSync(R, { recursive: true, force: true });
        const files = {
            'data/session.json': '{"x":1}', 'data/local-entities.json': '{"rows":[1]}', 'logs/coretax-agent.log': 'baris',
            'profiles/terpasang/pic-a/Default/Preferences': '{}', 'profiles/bawaan/pic-b/Local State': '{}', 'unduhan-sementara/a.crdownload': 'x',
            'electron/Cookies': 'c', 'electron/Local Storage/leveldb/1.log': 'l', 'runtime.json': '{"pid":1}', 'update-cache/x.exe': 'x', 'jendela-dashboard.png': 'p',
            'chrome/150.0/chrome.exe': 'EXE', 'legacy-v3.json': '{"exe":"C:\\\\x\\\\coretax-agent.exe"}', 'update-install.json': '{}'
        };
        for (const [rel, text] of Object.entries(files)) { const p = path.join(R, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
        const dl = path.join(process.env.TAXIO_PILOT_DOWNLOADS_DIR, 'CoretaxAgent', 'hasil.pdf');
        fs.mkdirSync(path.dirname(dl), { recursive: true }); fs.writeFileSync(dl, 'PDF');
        return { R, dl };
    };
    const exists = (p) => fs.existsSync(p);

    await test('real temp root: request() + runPending() delete data/logs/profiles/electron, keep chrome, legacy-v3.json, update-install.json and the Downloads result files', () => {
        const { R, dl } = seed();
        reset.request({ version: 'uji' });
        assert.ok(exists(path.join(R, 'data', 'session.json')), 'nothing deleted by request()');
        const r = reset.runPending({ readRuntime: () => null });
        assert.ok(r.ran && !r.failed.length, JSON.stringify(r));
        for (const gone of ['data', 'logs', 'profiles', 'unduhan-sementara', 'electron', 'runtime.json', 'update-cache', 'jendela-dashboard.png', 'reset-pending.json']) assert.ok(!exists(path.join(R, gone)), gone + ' should be gone');
        for (const kept of ['chrome/150.0/chrome.exe', 'legacy-v3.json', 'update-install.json', 'skip-legacy-migration.json']) assert.ok(exists(path.join(R, kept)), kept + ' should be kept');
        assert.strictEqual(fs.readFileSync(dl, 'utf8'), 'PDF', 'result files untouched');
    });

    await test('after a reset the legacy home is not migrated back (data copy and profile move/fallback skipped); without the marker it still is', () => {
        const { R } = seed();
        const home = process.env.TAXIO_PILOT_LEGACY_HOME;
        fs.rmSync(home, { recursive: true, force: true });
        fs.mkdirSync(path.join(home, '.coretax-agent'), { recursive: true });
        fs.writeFileSync(path.join(home, '.coretax-agent', 'local-entities.json'), '{"lama":1}');
        fs.mkdirSync(path.join(home, '.coretax-agent-profile', 'pic-lama'), { recursive: true });
        reset.request({ version: 'uji' });
        reset.runPending({ readRuntime: () => null });
        assert.ok(paths.legacySkipped());
        const s = paths.migrate();
        assert.ok(s.skipped && !s.copied.length && !s.moved.length);
        assert.ok(!exists(path.join(paths.dataDir(), 'local-entities.json')), 'v3 entities must not come back');
        assert.strictEqual(paths.resolveProfileDir('terpasang', 'pic-lama'), path.join(paths.profileRoot('terpasang'), 'pic-lama'), 'old profile in home not reused');
        assert.ok(exists(path.join(home, '.coretax-agent', 'local-entities.json')) && exists(path.join(home, '.coretax-agent-profile', 'pic-lama')), 'legacy folders never touched');
        fs.rmSync(path.join(R, 'skip-legacy-migration.json'));
        const s2 = paths.migrate();
        assert.ok(!s2.skipped && s2.copied.includes('local-entities.json') && s2.moved.length === 1);
    });

    // ---------- route ----------
    await test('POST /api/settings/reset-all: guards, then marker + local sign-out + relaunch through the shell seam; deletion happens at the next start', async () => {
        const { R, dl } = seed();
        fs.rmSync(path.join(R, 'chrome', 'x'), { force: true });
        const state = require('../lib/state');
        const runcontrol = require('../lib/runcontrol');
        const shell = require('../lib/shell');
        const calls = [];
        shell.register({ kind: 'uji', closeDashboard: () => calls.push('close'), relaunch: () => calls.push('relaunch'), exit: () => calls.push('exit') });
        const { createGuiServer, _routes } = require('../gui/server');
        assert.ok(_routes.ROUTES['POST /api/settings/reset-all'] && Array.isArray(_routes.ROUTE_FEATURES['POST /api/settings/reset-all']));
        const server = await createGuiServer(0);
        const base = 'http://127.0.0.1:' + server.address().port;
        const post = (body) => fetch(base + '/api/settings/reset-all', { method: 'POST', headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        try {
            state.set('taxio_hub', { client: {}, session: { access_token: 'a' }, user: { id: 'u1' }, orgId: 'o', role: 'member' });
            assert.strictEqual((await fetch(base + '/api/settings/reset-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status, 401, 'token required');
            assert.strictEqual((await post({})).status, 400, 'confirm required');
            const q = runcontrol.enqueue('UJI proses', { feature: 'download-spt', windowed: false, sig: 'reset-uji|1' });
            const busy = await post({ confirm: true });
            assert.strictEqual(busy.status, 409);
            assert.ok(/processes are still running or queued/.test((await busy.json()).error));
            assert.ok(!exists(reset.pendingFile(R)), 'no marker while a run is active');
            assert.ok(state.isConnected('taxio_hub'), 'still signed in when refused');
            runcontrol.finish(q.run);
            assert.strictEqual(runcontrol.anyActive(), false);

            const ok = await post({ confirm: true });
            assert.strictEqual(ok.status, 200);
            assert.deepStrictEqual(await ok.json(), { ok: true, restarting: true });
            assert.ok(!state.isConnected('taxio_hub'), 'signed out of Taxio Hub locally');
            assert.ok(exists(reset.pendingFile(R)), 'marker written');
            for (let i = 0; i < 80 && !calls.includes('relaunch'); i++) await new Promise((r) => setTimeout(r, 100));
            assert.ok(calls.includes('close') && calls.includes('relaunch') && !calls.includes('exit'), JSON.stringify(calls));
            assert.ok(exists(path.join(R, 'logs')) && exists(path.join(R, 'chrome')), 'the running instance deletes nothing itself');
            assert.strictEqual((await post({ confirm: true })).status, 409, 'a second request while quitting is refused');
        } finally {
            await new Promise((r) => server.close(r));
            shell.reset();
        }
        // "Next start":
        const r = reset.runPending({ readRuntime: () => null });
        assert.ok(r.ran && !r.failed.length, JSON.stringify(r));
        assert.ok(!exists(path.join(R, 'data')) && !exists(path.join(R, 'profiles')) && exists(path.join(R, 'chrome', '150.0', 'chrome.exe')));
        assert.strictEqual(fs.readFileSync(dl, 'utf8'), 'PDF');
    });

    // ---------- installer ----------
    await test('installer/installer.nsh: folder rename + upgrade clean-up + uninstall question (static checks)', () => {
        const nsh = fs.readFileSync(path.join(__dirname, '..', 'installer', 'installer.nsh'), 'utf8');
        const pkg = require('../package.json');
        assert.strictEqual(pkg.build.nsis.include, 'installer/installer.nsh');
        assert.strictEqual(pkg.name, 'coretax-agent', 'name stays: updater cache dir + app.getName() unchanged');
        assert.strictEqual(pkg.build.productName, 'Taxio Pilot');
        for (const m of ['customInit', 'customInstall', 'customUnInstall']) assert.ok(new RegExp('!macro ' + m + '\\b').test(nsh), m);
        assert.ok(nsh.includes('StrCpy $INSTDIR "$R0\\${PRODUCT_NAME}"') && !nsh.includes('StrCpy $INSTDIR "$R0\\${PRODUCT_FILENAME}"'), 'new folder = product name "Taxio Pilot", never the exe name');
        assert.ok(nsh.includes('"\\${APP_FILENAME}"') && nsh.includes('"\\${PRODUCT_FILENAME}"'), 'both old folder names (package name, exe name) are moved');
        assert.ok(/GetDParameter/.test(nsh), '/D= override respected');
        assert.ok(/\$\{IfNot\} \$\{isUpdated\}/.test(nsh), 'never asks during an update/reinstall');
        assert.ok(/TestParameter\} \$R9 "S"/.test(nsh), 'never asks for an unattended /S uninstall');
        assert.ok(!/\/SD/.test(nsh), 'a /SD would auto-answer in the oneClick (silent) uninstaller and never show the question');
        assert.ok(/MessageBox MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/.test(nsh), 'default answer is No (keep data)');
        assert.ok(/RMDir \/r "\$LOCALAPPDATA\\TaxioPilot"/.test(nsh) && /\$\{APP_PACKAGE_NAME\}-updater/.test(nsh));
        assert.ok(/DeleteRegKey HKCU "Software\\Classes\\taxio-coretax"/.test(nsh) && /APP_EXECUTABLE_FILENAME/.test(nsh), 'protocol key only if it points at this exe');
        assert.ok(!/CoretaxAgent|\.coretax-agent|Downloads/.test(nsh.replace(/^#.*$/gm, '')), 'never touches result files / legacy folders');
        assert.ok(!/RMDir \/r "\$LOCALAPPDATA"|RMDir \/r "\$PROFILE/.test(nsh));
    });

    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* abaikan */ }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
