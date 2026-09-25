/* Runs a renderTabs dump (CORETAX_DUMP_TABS) through the real export path - exactly what the app
 * does after capturing a SPT - and writes the PDF (and Excel when asked).
 *
 *   node scripts/render-dump-per11.js <dump.json> <outDir> <stem> [full|print] [formal|coretax] [pdf|both]
 */
const fs = require('fs');
const { renderTabs } = require('../lib/lampiran-export');

(async () => {
    const [dumpPath, dir, stem, mode = 'full', layoutStyle = 'formal', format = 'pdf'] = process.argv.slice(2);
    const { tabs, meta } = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const result = await renderTabs(tabs, meta, { mode, format, dir, stem, outputLayout: 'combined', layoutStyle });
    console.log(JSON.stringify({ paths: result.paths, seconds: Math.round((Date.now() - t0) / 1000) }));
})().catch((e) => { console.error(e); process.exit(1); });
