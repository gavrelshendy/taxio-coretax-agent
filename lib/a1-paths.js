/* Folder Mode A1.
 * Excel rekap disimpan langsung ke folder Tax Server entitas (SharePoint yang disinkron OneDrive):
 *   <Project Files>\<Folder Tax Server entitas di Taxio Hub>\<tahun>\A1 preparation
 * PDF SPT per masa dan cache .a1-cache tetap di folder lokal (Downloads\CoretaxAgent\<kode>\SPT\...), supaya
 * SharePoint tidak dibanjiri ratusan file. Bila folder Tax Server tidak bisa ditentukan (entitas belum punya
 * Folder Tax Server di Hub, folder Project Files tidak ada di PC ini, entitas lokal/manual), rekap tetap di
 * folder lokal seperti sebelumnya. Rekap lama di folder lokal ikut dibaca (yang terbaru dipakai), jadi
 * perpindahan ke folder Tax Server melanjutkan hasil yang sudah ada. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const A1_FOLDER = 'A1 preparation';
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

/** Folder "Project Files" Tax Server yang disinkron di PC ini (alias %PROJECT_FILES% di Taxio Hub). */
function projectFilesRoot(home = os.homedir()) {
    if (process.env.TAXIO_PROJECT_FILES && isDir(process.env.TAXIO_PROJECT_FILES)) return process.env.TAXIO_PROJECT_FILES;
    // Pustaka SharePoint "Tax Server" yang disinkron OneDrive: <home>\<organisasi>\Tax Server - Documents\Project Files
    try {
        for (const org of fs.readdirSync(home)) {
            const p = path.join(home, org, 'Tax Server - Documents', 'Project Files');
            if (isDir(p)) return p;
        }
    } catch (e) {}
    return null;
}

/** Folder Tax Server entitas: Folder Tax Server dari Taxio Hub (relatif ke Project Files, %PROJECT_FILES%\..., atau path lengkap). */
function entityTaxServerDir(entity, root = projectFilesRoot()) {
    let f = String((entity && entity.taxserver_folder) || '').trim().replace(/[\\/]+$/, '');
    if (!f) return null;
    if (/^%PROJECT_FILES%/i.test(f)) f = f.replace(/^%PROJECT_FILES%[\\/]?/i, '');
    else if (/%[A-Z0-9_]+%/i.test(f)) return null; // alias lain hanya dikenal browser Taxio Hub
    else if (/^[a-z]:[\\/]|^\\\\/i.test(f)) return isDir(f) ? f : null;
    if (!root) return null;
    const dir = path.join(root, f);
    return isDir(dir) ? dir : null; // folder entitas harus sudah ada: jangan membuat folder entitas baru di SharePoint
}

/** Semua folder Mode A1 satu entitas & tahun.
 *  root: folder lokal (Simpan ke) - PDF di <root>\<kode>\SPT\<mmYY>, cache di localDir\.a1-cache
 *  outDir: tempat Excel rekap disimpan (folder Tax Server bila ada, selain itu localDir)
 *  readDirs: folder tempat mencari rekap/cache sebelumnya (outDir + localDir). */
function a1Paths({ entity, saveRoot, year, root: given, outDir: forced }) {
    const code = entity && entity.entity_id;
    const root = given || require('../automation/spt').__test.a1SaveRoot(saveRoot, code);
    const localDir = path.join(root, code, 'SPT', 'A1', String(year));
    // forced: folder lengkap yang sudah di-resolve Taxio Hub (deep link mode-a1, alias path dari browser).
    const ts = forced ? null : entityTaxServerDir(entity);
    const outDir = forced || (ts ? path.join(ts, String(year), A1_FOLDER) : localDir);
    // pdfDir: PDF SPT per masa (Mode A1 dengan folder Tax Server) = subfolder SPT di folder A1 preparation.
    return { root, localDir, outDir, pdfDir: path.join(outDir, 'SPT'), taxServer: !!(forced || ts), sptDir: path.join(root, code, 'SPT'), cacheDir: path.join(localDir, '.a1-cache'), readDirs: [...new Set([outDir, localDir])] };
}

module.exports = { a1Paths, projectFilesRoot, entityTaxServerDir, A1_FOLDER };
