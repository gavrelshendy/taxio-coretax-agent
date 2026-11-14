/* Tes statis: dashboard tidak memakai dialog bawaan browser (confirm/alert/prompt). Gunakan P.confirmDialog / P.toast. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'gui', 'public', 'js');
const bad = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/(^|[^.\w$])(window\s*\.\s*)?(confirm|alert|prompt)\s*\(/.test(code) || /window\s*\.\s*(confirm|alert|prompt)\s*\(/.test(code)) bad.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 100));
    });
}
assert.deepStrictEqual(bad, [], 'dialog bawaan browser ditemukan:\n' + bad.join('\n'));
console.log('ok   tidak ada confirm()/alert()/prompt() di gui/public/js');
