// a1-paths: folder Tax Server, fallback lokal, forced folder dari Hub; a1-source membaca beberapa folder.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const A = path.join(__dirname, '..') + '/';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a1p-'));
const pf = path.join(tmp, 'Project Files'); fs.mkdirSync(path.join(pf, 'Grup X', 'Contoh Jaya, PT'), { recursive: true });
process.env.TAXIO_PROJECT_FILES = pf;
const { a1Paths, entityTaxServerDir } = require(A + 'lib/a1-paths');
const local = path.join(tmp, 'local');
const ent = { entity_id: 'CTH', taxserver_folder: 'Grup X\\Contoh Jaya, PT' };
let p = a1Paths({ entity: ent, year: '2026', root: local });
assert.equal(p.outDir, path.join(pf, 'Grup X', 'Contoh Jaya, PT', '2026', 'A1 preparation'));
assert.equal(p.cacheDir, path.join(local, 'CTH', 'SPT', 'A1', '2026', '.a1-cache'));
assert.deepEqual(p.readDirs, [p.outDir, p.localDir]); assert(p.taxServer);
assert.equal(entityTaxServerDir({ taxserver_folder: '%PROJECT_FILES%\\Grup X\\Contoh Jaya, PT' }), path.join(pf, 'Grup X', 'Contoh Jaya, PT'));
assert.equal(entityTaxServerDir({ taxserver_folder: '%OTHER%\\x' }), null);
assert.equal(entityTaxServerDir({ taxserver_folder: 'Grup X\\Tidak Ada' }), null, 'folder entitas harus sudah ada');
p = a1Paths({ entity: { entity_id: 'CTH' }, year: '2026', root: local });
assert.equal(p.outDir, p.localDir); assert(!p.taxServer);
p = a1Paths({ entity: ent, year: '2026', root: local, outDir: 'Z:\\Hub\\2026\\A1 preparation' });
assert.equal(p.outDir, 'Z:\\Hub\\2026\\A1 preparation');
// a1-source: rekap lama di folder lokal ditemukan walau outDir (Tax Server) belum ada
fs.mkdirSync(p.localDir, { recursive: true }); fs.writeFileSync(path.join(p.localDir, 'CTH 2026 - Rekap SPT PPh 21 Setahun (A1).xlsx'), 'x');
const r = require(A + 'lib/a1-source').resolve({ a1Dir: a1Paths({ entity: ent, year: '2026', root: local }).readDirs, year: '2026' });
assert(r.excel && r.excel.startsWith(p.localDir), 'rekap lokal terbaca');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('a1-paths ok');

// Deep link mode-a1 dari Taxio Hub: a1_year dan a1_folder harus ikut terbaca (dulu terbuang -> "tahun tidak valid ()").
const { parseIncomingUrl } = require(A + 'lib/deeplink');
const dl = parseIncomingUrl('taxio-coretax://login?entity=CTH&action=mode-a1&a1_year=2026&a1_folder=' + encodeURIComponent('C:\X\Contoh Jaya, PT\2026\A1 preparation'));
assert.equal(dl.action, 'mode-a1'); assert.equal(dl.a1_year, '2026'); assert.equal(dl.a1_folder, 'C:\X\Contoh Jaya, PT\2026\A1 preparation');
console.log('deep link mode-a1 ok');
