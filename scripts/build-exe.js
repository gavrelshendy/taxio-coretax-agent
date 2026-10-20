// Build exe Taxio Pilot: ikon + info versi ditanam ke Node dasar SEBELUM pkg membungkus aplikasi, lalu
// subsystem diubah ke GUI (scripts/hide-console.js).
//
//   node scripts/build-exe.js [--out-path dist-3.0.0]
//
// Ikon tidak boleh disunting setelah exe jadi: pkg menempelkan isi aplikasi di ujung file dengan posisi
// tetap, jadi mengubah resource exe jadi menggeser/merusak isinya. Karena itu Node dasar resmi (pkg-fetch)
// disalin, ditanami ikon (gui/public/assets/taxio-pilot.ico) + VersionInfo, dan disimpan sebagai
// "built-<versi node>" di cache khusus build/pkg-cache - pkg-fetch memakai file "built-" tanpa cek hash.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ResEdit = require('resedit');

const ROOT = path.join(__dirname, '..');
const pkgJson = require('../package.json');
const outPath = (() => { const i = process.argv.indexOf('--out-path'); return i > 0 ? process.argv[i + 1] : 'dist'; })();
const CACHE = path.join(ROOT, 'build', 'pkg-cache');
const ICON = path.join(ROOT, 'gui', 'public', 'assets', 'taxio-pilot.ico');

async function patchedBase() {
    // Node dasar resmi (unduh ke cache bawaan bila belum ada), dengan hash yang diverifikasi pkg-fetch.
    const fetched = await require('@yao-pkg/pkg-fetch').need({ nodeRange: pkgJson.pkg.targets[0].split('-')[0], platform: 'win', arch: 'x64' });
    const built = path.join(CACHE, path.basename(path.dirname(fetched)), path.basename(fetched).replace(/^fetched-/, 'built-'));
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(fetched), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    const icon = ResEdit.Data.IconFile.from(fs.readFileSync(ICON));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const group = groups[0] || { id: 1, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map((i) => i.data));
    const [major, minor, patch] = pkgJson.version.split('.').map(Number);
    const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
    const lang = { lang: 1033, codepage: 1200 };
    vi.setFileVersion(major, minor, patch, 0, 1033);
    vi.setProductVersion(major, minor, patch, 0, 1033);
    vi.setStringValues(lang, { ProductName: 'Taxio Pilot', FileDescription: 'Taxio Pilot', CompanyName: 'Taxio', InternalName: 'coretax-agent', OriginalFilename: 'coretax-agent.exe', LegalCopyright: '', FileVersion: pkgJson.version, ProductVersion: pkgJson.version });
    vi.outputToResourceEntries(res.entries);
    res.outputResource(exe);
    fs.mkdirSync(path.dirname(built), { recursive: true });
    fs.writeFileSync(built, Buffer.from(exe.generate()));
    console.log('Node dasar + ikon Taxio Pilot: ' + path.relative(ROOT, built));
}

(async () => {
    await patchedBase();
    const pkgBin = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
    const r = spawnSync(process.execPath, [pkgBin, '.', '--out-path', outPath], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PKG_CACHE_PATH: CACHE } });
    if (r.status !== 0) throw new Error('pkg gagal (kode ' + r.status + ')');
    const h = spawnSync(process.execPath, [path.join(__dirname, 'hide-console.js'), path.join(ROOT, outPath, 'coretax-agent.exe')], { stdio: 'inherit' });
    if (h.status !== 0) throw new Error('hide-console gagal');
})().catch((e) => { console.error(e.message); process.exit(1); });
