// Kode yang mengirim fungsi ke browser (page.evaluate(fn)) harus tetap berupa sumber di exe: pkg mengompilasi file lain
// ke bytecode, sehingga Function.toString() rusak ("Passed function is not well-serializable", upload KAP 2026-11-07).
// Setiap file lib/ dan automation/ yang memakai pola itu wajib masuk pkg.assets di package.json.
const assert = require('assert'), fs = require('fs'), path = require('path');
module.exports = async function () {
    const root = path.join(__dirname, '..'), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const globs = pkg.pkg.assets.map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/\*/g, '.*').replace(/\*/g, '[^/]*') + '$'));
    const missing = [];
    for (const dir of ['lib', 'automation']) for (const name of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.js'))) {
        const rel = dir + '/' + name, src = fs.readFileSync(path.join(root, rel), 'utf8');
        if (/\.evaluate\(\s*(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(src) && !globs.some((re) => re.test(rel))) missing.push(rel);
    }
    assert.deepEqual(missing, [], 'page.evaluate(fn) di file bytecode - tambahkan ke pkg.assets: ' + missing.join(', '));
    console.log('PASS: semua file dengan page.evaluate(fn) ada di pkg.assets.');
};
if (require.main === module) module.exports().catch((e) => { console.error(e.message); process.exitCode = 1; });
