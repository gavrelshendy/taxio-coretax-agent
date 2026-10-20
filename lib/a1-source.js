/* Hasil Mode A1 sebelumnya yang bisa dipakai ulang: folder (cache .a1-cache dan/atau Excel "Mode A1 - <tahun>")
 * atau langsung file Excel Mode A1 lama. Dipakai untuk menampilkan status per masa di halaman Mode A1
 * (inspect) dan untuk menyuplai data ke proses (load): masa yang versinya sama dengan Coretax dipakai ulang,
 * sisanya diunduh. Excel lama hanya menyuplai data versi TERAKHIR tiap masa (seperti yang ditulisnya). */
const fs = require('fs');
const path = require('path');
const { readA1Workbook } = require('./a1-import');

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

/** Folder & file yang dipakai: `source` (folder atau .xlsx) bila dipilih, selain itu folder A1 standar. */
function resolve({ a1Dir, source, year }) {
    const folders = [];
    let excel = null;
    if (source && isFile(source) && /\.xlsx$/i.test(source)) { excel = source; folders.push(path.dirname(source)); }
    else if (source && isDir(source)) folders.push(source, path.join(source, 'SPT', 'A1', String(year)));
    folders.push(a1Dir);
    const uniq = [...new Set(folders.map((f) => path.resolve(f)))].filter(isDir);
    if (!excel) {
        const found = uniq.flatMap((dir) => fs.readdirSync(dir).filter((n) => new RegExp('^Mode A1 - ' + year + '.*\\.xlsx$', 'i').test(n) && !n.startsWith('~$')).map((n) => path.join(dir, n)));
        excel = found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    }
    const cacheDirs = uniq.map((dir) => path.join(dir, '.a1-cache')).filter(isDir);
    return { excel, cacheDirs, folders: uniq };
}

function cacheEntries(cacheDirs) {
    const out = new Map(); // masa -> [{recordId, revision}]
    for (const dir of cacheDirs) for (const name of fs.readdirSync(dir)) {
        if (!/\.json$/.test(name)) continue;
        try { const d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); if (!out.has(d.masa)) out.set(d.masa, []); out.get(d.masa).push({ recordId: d.recordId, revision: d.revision }); } catch (e) {}
    }
    return out;
}

/** Excel Mode A1 lama -> {mmYY: {revision, sheets}} untuk masa yang datanya Lengkap. */
async function excelSeed(excel, year) {
    if (!excel) return { seed: {}, control: new Map() };
    const { perMasa, control } = await readA1Workbook(excel);
    const seed = {};
    MONTHS.forEach((name, i) => {
        const c = control.get(name);
        if (c && /^Lengkap/.test(c.data)) seed[String(i + 1).padStart(2, '0') + String(year).slice(2)] = { revision: Number(c.revision) || 0, sheets: perMasa.get(name) };
    });
    return { seed, control };
}

/** Status per masa untuk ditampilkan sebelum proses: sumber data yang ada + apakah PDF-nya ada. */
async function inspect({ a1Dir, source, year, sptDir }) {
    const r = resolve({ a1Dir, source, year });
    const cache = cacheEntries(r.cacheDirs);
    let excelInfo = { control: new Map() }, excelError = null;
    try { excelInfo = await excelSeed(r.excel, year); } catch (e) { excelError = e.message; }
    const rows = MONTHS.map((name, i) => {
        const mmYY = String(i + 1).padStart(2, '0') + String(year).slice(2);
        const c = excelInfo.control.get(name), entries = cache.get(mmYY) || [];
        const dir = path.join(sptDir, mmYY);
        const files = isDir(dir) ? fs.readdirSync(dir) : [];
        return {
            masa: name, mmYY,
            excel: c ? { revision: c.revision === '' ? null : Number(c.revision), data: c.data } : null,
            cache: entries.length ? { versions: entries.length, revision: Math.max(...entries.map((e) => e.revision)) } : null,
            pdf: files.some((n) => /\(Lengkap\)/.test(n)) && files.some((n) => /\(Rahasia\)/.test(n))
        };
    });
    return { excel: r.excel, excelError, cacheDirs: r.cacheDirs, folders: r.folders, rows };
}

/** Data untuk proses: folder cache tambahan (hanya dibaca) + data Excel lama per masa. */
async function load({ a1Dir, source, year }) {
    const r = resolve({ a1Dir, source, year });
    const { seed } = await excelSeed(r.excel, year);
    return { excel: r.excel, cacheDirs: r.cacheDirs, seed };
}

module.exports = { inspect, load, resolve };
