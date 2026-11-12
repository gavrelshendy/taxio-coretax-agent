/* Taxio Pilot - perawatan profil Chrome per PIC (audit 2026-11-12).
 *
 * Tiap PIC punya satu folder profil Chrome di <akar>\profiles\{terpasang,bawaan} (plus akar lama di home,
 * lihat lib/paths.js allProfileRoots) yang tidak pernah dibersihkan - puluhan PIC bisa menjadi bergiga-giga.
 * Modul ini:
 *   - scan(): daftar profil (folder anak langsung akar-akar itu) dengan terakhir dipakai (mtime terbaru data
 *     profil "Default": folder Default, Preferences - ditulis tiap peluncuran, Cookies, History, Local State)
 *     dan ukurannya (dihitung dengan batas waktu - sisanya ditandai `partial`);
 *   - selectStale(): pilihan MURNI (dites dengan fs/jam tiruan) profil yang tidak dipakai >= N hari (bawaan 60),
 *     tanpa profil yang jendelanya sedang terbuka / dipegang proses Chrome;
 *   - removeProfiles(): menghapus yang dikonfirmasi pengguna, SETELAH semua syarat diperiksa ulang: hanya folder
 *     milik aplikasi ini (chrome-profile isOwnProfileDir), masih lama tidak dipakai, tidak terbuka, tidak dipegang
 *     chrome.exe. Menghapus profil hanya berarti PIC itu login otomatis lagi pada pemakaian berikutnya.
 * Dipakai lib/doctor.js (pemeriksaan "Profil Chrome") dan gui/server.js (/api/profiles/*). */
const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_BYTES = 5 * 1024 * 1024 * 1024;
const SIZE_BUDGET_MS = 6000;

/** Adapter fs (async). Tes menyuntik versi tiruan dengan bentuk yang sama. */
const realFs = {
    readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
    lstat: (p) => fs.promises.lstat(p),
    rm: (p) => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 2 })
};

function defaultRoots() { return require('./paths').allProfileRoots(); }
function kindOf(root) { return /bawaan|taxio-pilot-profile/i.test(root) ? 'bawaan' : 'terpasang'; }

const LAST_USED_PROBES = ['Default', path.join('Default', 'Preferences'), path.join('Default', 'Cookies'), path.join('Default', 'Network', 'Cookies'), path.join('Default', 'History'), 'Local State'];
/** Terakhir dipakai (ms): mtime terbaru di antara data profil Default; folder profil itu sendiri bila tidak ada. */
async function lastUsedOf(dir, fsa) {
    let best = 0;
    for (const rel of LAST_USED_PROBES) {
        try { const st = await fsa.lstat(path.join(dir, rel)); if (st.mtimeMs > best) best = st.mtimeMs; } catch (e) { /* tidak ada */ }
    }
    if (!best) { try { best = (await fsa.lstat(dir)).mtimeMs; } catch (e) { best = 0; } }
    return best;
}

/** Ukuran folder (byte), berhenti di `deadline` (ms epoch) -> { bytes, partial }. Tautan simbolik tidak diikuti. */
async function sizeOf(dir, fsa, deadline, now) {
    let bytes = 0, partial = false;
    const stack = [dir];
    while (stack.length) {
        if (now() > deadline) { partial = true; break; }
        const d = stack.pop();
        let ents;
        try { ents = await fsa.readdir(d); } catch (e) { continue; }
        for (const ent of ents) {
            const p = path.join(d, ent.name);
            if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) { stack.push(p); continue; }
            try { bytes += (await fsa.lstat(p)).size || 0; } catch (e) { /* hilang di tengah jalan */ }
        }
    }
    return { bytes, partial };
}

/** Semua profil di akar-akar milik aplikasi. opts: { fs (adapter), roots, sizes (bawaan true), budgetMs, now }.
 *  -> { profiles: [{ dir, name, root, kind, lastUsed, bytes, partial }], count, totalBytes, partial } */
async function scan(opts) {
    const o = opts || {};
    const fsa = o.fs || realFs;
    const now = o.now || Date.now;
    const roots = o.roots || defaultRoots();
    const deadline = now() + (o.budgetMs || SIZE_BUDGET_MS);
    const profiles = [];
    const seen = new Set();
    for (const root of roots) {
        let ents;
        try { ents = await fsa.readdir(root); } catch (e) { continue; }
        for (const ent of ents) {
            if (!ent.isDirectory()) continue;
            const dir = path.join(root, ent.name);
            const key = dir.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            profiles.push({ dir, name: ent.name, root, kind: kindOf(root), lastUsed: await lastUsedOf(dir, fsa), bytes: 0, partial: false });
        }
    }
    let partial = false;
    if (o.sizes !== false) {
        for (const p of profiles) {
            const s = await sizeOf(p.dir, fsa, deadline, now);
            p.bytes = s.bytes; p.partial = s.partial;
            if (s.partial) partial = true;
        }
    }
    return { profiles, count: profiles.length, totalBytes: profiles.reduce((a, p) => a + p.bytes, 0), partial };
}

/** MURNI. Profil yang tidak dipakai >= `days` hari, tertua dulu. `busy(dir)` true = jendelanya terbuka /
 *  dipegang proses Chrome -> tetap dilaporkan (inUse: true) tapi tidak pernah ikut dipilih untuk dihapus.
 *  opts: { now (ms), days, busy }. */
function selectStale(profiles, opts) {
    const o = opts || {};
    const now = o.now != null ? o.now : Date.now();
    const days = Number(o.days) > 0 ? Number(o.days) : DEFAULT_DAYS;
    const cutoff = now - days * DAY_MS;
    return (profiles || [])
        .filter((p) => p && p.lastUsed && p.lastUsed <= cutoff)
        .map((p) => Object.assign({}, p, { ageDays: Math.floor((now - p.lastUsed) / DAY_MS), inUse: !!(o.busy && o.busy(p.dir)) }))
        .sort((a, b) => a.lastUsed - b.lastUsed);
}

function _norm(p) { return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase(); }

/** Menghapus `dirs` yang dikonfirmasi pengguna. Setiap folder diperiksa ulang SEBELUM dihapus (lihat header).
 *  deps: { fs, roots, now, isOwn(dir, roots), busy(dir) -> bool, log }. -> { deleted: [{dir, bytes}], skipped: [{dir, reason}], freedBytes } */
async function removeProfiles(dirs, opts) {
    const o = opts || {};
    const fsa = o.fs || realFs;
    const roots = o.roots || defaultRoots();
    const isOwn = o.isOwn || ((d, r) => require('./chrome-profile').isOwnProfileDir(d, r));
    const current = await scan({ fs: fsa, roots, now: o.now, budgetMs: o.budgetMs });
    const stale = selectStale(current.profiles, { now: (o.now || Date.now)(), days: o.days, busy: o.busy });
    const byDir = new Map(stale.map((p) => [_norm(p.dir), p]));
    const out = { deleted: [], skipped: [], freedBytes: 0 };
    for (const raw of Array.from(new Set((dirs || []).map(String)))) {
        const dir = raw;
        if (!isOwn(dir, roots)) { out.skipped.push({ dir, reason: 'bukan folder profil Taxio Pilot' }); continue; }
        const p = byDir.get(_norm(dir));
        if (!p) { out.skipped.push({ dir, reason: 'tidak lagi termasuk profil lama (dipakai baru-baru ini / sudah tidak ada)' }); continue; }
        if (p.inUse) { out.skipped.push({ dir, reason: 'jendela Chrome profil ini sedang terbuka' }); continue; }
        try {
            await fsa.rm(p.dir);
            out.deleted.push({ dir: p.dir, bytes: p.bytes });
            out.freedBytes += p.bytes;
        } catch (e) { out.skipped.push({ dir, reason: 'gagal dihapus: ' + (e.code || e.message) }); }
    }
    return out;
}

const GB = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
const MB = (b) => (b >= 1024 * 1024 * 1024 ? GB(b) : Math.max(0, Math.round(b / 1024 / 1024)) + ' MB');

module.exports = { scan, selectStale, removeProfiles, lastUsedOf, sizeOf, DEFAULT_DAYS, WARN_BYTES, DAY_MS, MB, realFs };
