/* Offline tests for lib/profile-housekeeping.js with a fake filesystem and clock: last-used from the profile's
 * Default data, sizes (time-boxed), stale selection (N days, never an open profile), and deletion that
 * re-checks everything (own profile roots only, still stale, not open). Run: node scripts/test-profile-housekeeping.js */
'use strict';
const path = require('path');
const assert = require('assert');
const hk = require('../lib/profile-housekeeping');
const { isOwnProfileDir } = require('../lib/chrome-profile');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(true); console.log('PASS ' + name); }
    catch (e) { results.push(false); console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
const DAY = hk.DAY_MS;
const NOW = Date.UTC(2026, 10, 12);
const ROOT_A = 'C:\\Uji\\TaxioPilot\\profiles\\terpasang';
const ROOT_B = 'C:\\Uji\\TaxioPilot\\profiles\\bawaan';

/** In-memory tree: { 'C:\\x\\file': { size, mtime } , dirs implied }. */
function fakeFs(files, dirMtimes) {
    const norm = (p) => path.win32.normalize(p).replace(/\\+$/, '').toLowerCase();
    const removed = [];
    const all = () => Object.keys(files);
    const isDir = (p) => all().some((f) => norm(f).startsWith(norm(p) + '\\'));
    return {
        removed,
        readdir: async (dir) => {
            if (!isDir(dir)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            const names = new Map();
            for (const f of all()) {
                if (!norm(f).startsWith(norm(dir) + '\\')) continue;
                const rest = f.slice(dir.replace(/\\+$/, '').length + 1).split('\\');
                names.set(rest[0], rest.length > 1);
            }
            return Array.from(names, ([name, dirish]) => ({ name, isDirectory: () => dirish, isFile: () => !dirish, isSymbolicLink: () => false }));
        },
        lstat: async (p) => {
            const hit = Object.keys(files).find((f) => norm(f) === norm(p));
            if (hit) return { size: files[hit].size, mtimeMs: files[hit].mtime, isDirectory: () => false };
            if (isDir(p)) return { size: 0, mtimeMs: (dirMtimes && dirMtimes[norm(p)]) || 0, isDirectory: () => true };
            const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
        },
        rm: async (p) => { removed.push(p); for (const f of all()) if (norm(f).startsWith(norm(p) + '\\')) delete files[f]; }
    };
}
function tree() {
    const f = {};
    const add = (root, name, ageDays, mb) => {
        const t = NOW - ageDays * DAY;
        f[root + '\\' + name + '\\Default\\Preferences'] = { size: 1024, mtime: t };
        f[root + '\\' + name + '\\Default\\Cache\\data_1'] = { size: mb * 1024 * 1024, mtime: t - DAY };
    };
    add(ROOT_A, 'pic-lama', 90, 300);
    add(ROOT_A, 'pic-baru', 3, 200);
    add(ROOT_A, 'pic-terbuka', 120, 100);
    add(ROOT_B, 'pic-lama2', 61, 50);
    f[ROOT_B + '\\pic-tanpa-default\\Local State'] = { size: 10, mtime: NOW - 200 * DAY };
    return f;
}
const ROOTS = [ROOT_A, ROOT_B];

(async () => {
    await test('scan: one entry per profile, last used from Default data, sizes summed', async () => {
        const r = await hk.scan({ fs: fakeFs(tree()), roots: ROOTS, now: () => NOW });
        assert.strictEqual(r.count, 5);
        const by = Object.fromEntries(r.profiles.map((p) => [p.name, p]));
        assert.strictEqual(by['pic-lama'].lastUsed, NOW - 90 * DAY);
        assert.strictEqual(by['pic-lama'].bytes, 300 * 1024 * 1024 + 1024);
        assert.strictEqual(by['pic-lama2'].kind, 'bawaan');
        assert.strictEqual(by['pic-tanpa-default'].lastUsed, NOW - 200 * DAY, 'Local State counts');
        assert.ok(!r.partial);
    });

    await test('scan: size budget exhausted -> partial, never hangs', async () => {
        let t = NOW;
        const r = await hk.scan({ fs: fakeFs(tree()), roots: ROOTS, now: () => (t += 1000), budgetMs: 1500 });
        assert.ok(r.partial);
    });

    await test('selectStale: >= N days, oldest first, open profiles flagged inUse', async () => {
        const r = await hk.scan({ fs: fakeFs(tree()), roots: ROOTS, now: () => NOW });
        const busy = (d) => /pic-terbuka$/.test(d);
        const s = hk.selectStale(r.profiles, { now: NOW, days: 60, busy });
        assert.deepStrictEqual(s.map((p) => p.name), ['pic-tanpa-default', 'pic-terbuka', 'pic-lama', 'pic-lama2']);
        assert.deepStrictEqual(s.filter((p) => p.inUse).map((p) => p.name), ['pic-terbuka']);
        assert.strictEqual(s.find((p) => p.name === 'pic-lama').ageDays, 90);
        assert.deepStrictEqual(hk.selectStale(r.profiles, { now: NOW, days: 100 }).map((p) => p.name), ['pic-tanpa-default', 'pic-terbuka']);
        assert.strictEqual(hk.selectStale(r.profiles, { now: NOW }).length, 4, 'default 60 days');
    });

    await test('removeProfiles: deletes confirmed stale ones; skips open, recent, foreign and non-direct paths', async () => {
        const fsa = fakeFs(tree());
        const out = await hk.removeProfiles([
            ROOT_A + '\\pic-lama', ROOT_A + '\\pic-terbuka', ROOT_A + '\\pic-baru',
            'C:\\Users\\orang\\AppData\\Local\\Google\\Chrome\\User Data', ROOT_A, ROOT_A + '\\pic-lama\\Default'
        ], { fs: fsa, roots: ROOTS, now: () => NOW, days: 60, busy: (d) => /pic-terbuka$/.test(d), isOwn: isOwnProfileDir });
        assert.deepStrictEqual(fsa.removed, [ROOT_A + '\\pic-lama']);
        assert.strictEqual(out.deleted.length, 1);
        assert.strictEqual(out.freedBytes, 300 * 1024 * 1024 + 1024);
        const reasons = Object.fromEntries(out.skipped.map((s) => [s.dir, s.reason]));
        assert.ok(/sedang terbuka/.test(reasons[ROOT_A + '\\pic-terbuka']));
        assert.ok(/tidak lagi termasuk profil lama/.test(reasons[ROOT_A + '\\pic-baru']));
        assert.ok(/bukan folder profil/.test(reasons['C:\\Users\\orang\\AppData\\Local\\Google\\Chrome\\User Data']));
        assert.ok(/bukan folder profil/.test(reasons[ROOT_A]));
        assert.ok(/bukan folder profil/.test(reasons[ROOT_A + '\\pic-lama\\Default']));
    });

    const failed = results.filter((x) => !x).length;
    console.log((results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
