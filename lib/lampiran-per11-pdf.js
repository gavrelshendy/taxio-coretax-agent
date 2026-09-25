/* PER-11 lampiran PDF, drawn from the government workbook itself.
 *
 * One Coretax tab becomes one or more PER-11 sheets (OP's tab "L-1" is sheets L1-1, L1-2, L1-3),
 * each filled with the tab's data (lib/lampiran-per11-fill.js), drawn in Coretax's house style
 * (lib/lampiran-per11-render.js) and paginated on Folio paper:
 *   - portrait for a form that fits one portrait page at 85% or more, landscape otherwise;
 *   - a long list (more than 20 records) always landscape, legibility first;
 *   - never larger than 100%, the size Coretax prints its own Induk at.
 */
const { PDFDocument } = require('pdf-lib');
const { sheetHtml, fontFaces, BASE_CSS, paginate, THEMES } = require('./lampiran-per11-render');
const { fillSheet, sheetRegions } = require('./lampiran-per11-fill');

const LAYOUTS = { ICT_RCIT: 'badan', ICT_PIT: 'op' };
const cache = {};
// Read as a file, not require(): the packaged exe carries these as pkg assets, which a computed
// require() path does not resolve.
const layoutFor = (kind) => cache[kind] || (cache[kind] = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'lampiran-per11-layout-' + kind + '.json'), 'utf8')));
const MM = 96 / 25.4;
const MARGIN = 8;
// Per-sheet choices the user made after comparing both orientations side by side.
const PREFER = { L11B: 'landscape' };

// The annual SPT (Badan and OP) always prints its lampiran on the PER-11 forms (2026-09-26: the
// user replaced the older "Tampilan Coretax" layout with this one, PDF and Excel alike).
function supports(taxTypeCode) { return taxTypeCode === 'ICT_RCIT' || taxTypeCode === 'ICT_PIT'; }

/** The PER-11 sheets a Coretax tab prints as. */
function sheetsForTab(kind, label) {
    const key = String(label || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return Object.keys(layoutFor(kind).sheets).filter((n) => {
        const k = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return k === key || (kind === 'op' && /^L\d$/.test(key) && /^L\d\d$/.test(k) && k.startsWith(key));
    });
}

async function layoutSheet(page, sheet, name, kind, info, landscape, fullKop, scale = 1) {
    const [w, h] = landscape ? [330, 216] : [216, 330];
    const regions = sheetRegions(sheet);
    const theme = THEMES[kind];
    const slim = { title: kind === 'op' ? 'SPT TAHUNAN PPh WAJIB PAJAK ORANG PRIBADI' : 'SPT TAHUNAN PPh WAJIB PAJAK BADAN', npwp: info.npwp, year: info.year,
        lampiran: 'LAMPIRAN ' + name.replace(/^L/, ''), color: (theme && theme.bg[regions.kopColor]) || regions.kopColor, accent: (theme && theme.bg['#FFC000']) || '#FFC000', font: 'Arial,sans-serif' };
    await page.setContent(`<meta charset="utf-8"><style>${fontFaces()}${BASE_CSS}</style>${sheetHtml(sheet, { theme: kind, regions, label: 'LAMPIRAN ' + name.replace(/^L/, ''), slim: fullKop ? null : slim })}`);
    await page.evaluate(() => document.fonts.ready);
    // A hair under the printable height, so rounding never spills a page onto a blank next one.
    const [r] = await page.evaluate(({ fn, pw, ph, sc }) => eval('(' + fn + ')')({ pageWidth: pw, pageHeight: ph, cssZoom: true, maxZoom: sc, fillWidth: pw / sc }),
        { fn: paginate.toString(), pw: (w - 2 * MARGIN) * MM, ph: (h - 2 * MARGIN) * MM - 2, sc: scale });
    // The finished pages, kept as HTML: every sheet of the SPT is printed in one PDF at the end,
    // so the fonts are embedded once instead of once per sheet (hundreds of font objects made
    // the file slow to open).
    const html = await page.evaluate((cls) => { document.querySelectorAll('.pg').forEach((pg) => pg.classList.add(cls)); return [...document.querySelectorAll('.sheet-pages')].map((x) => x.outerHTML).join(''); }, landscape ? 'la' : 'po');
    return { ...r, w, h, landscape, html };
}

/** Renders one tab. Returns { buffers: [pdf per sheet], unplaced: [...] }. */
async function renderTab(browser, { taxTypeCode, label, model, answers, npwp, year, mode }) {
    const kind = LAYOUTS[taxTypeCode];
    const names = sheetsForTab(kind, label);
    if (!names.length) return null;
    const page = await browser.newPage();
    await page.route('**/*', (r) => r.abort());
    // `excel`: each filled sheet with the grid it printed on, for lib/lampiran-per11-excel.js.
    const out = { fragments: [], unplaced: [], sheets: names, excel: [], kind };
    try {
        let remaining = (model.tables || []).slice();
        for (const name of names) {
            const { sheet, unplaced, used = [] } = fillSheet(layoutFor(kind).sheets[name], { limit: mode === 'print' ? 50 : 0, npwp, year,
                tables: remaining, fields: model.fields || [], answers, partOfTab: names.length > 1 });
            remaining = remaining.filter((m) => !used.includes(m));
            out.unplaced.push(...unplaced.map((u) => name + ': ' + u));
            const info = { npwp, year };
            // A lampiran spread over several sheets (OP's L1: "HALAMAN 1", "HALAMAN 2", ...) repeats
            // its full kop on every page, so each printed page carries its own HALAMAN number.
            const fullKop = names.length > 1;
            const lay = (landscape, scale) => layoutSheet(page, sheet, name, kind, info, landscape, fullKop, scale);
            let layout = await lay(PREFER[name] === 'landscape');
            if (!PREFER[name]) {
                const hasTables = sheetRegions(sheet).heads.length > 0;
                if (layout.pages > 1 || layout.zoom < (hasTables ? 0.95 : 0.85)) {
                    const portrait = layout;
                    layout = await lay(true);
                    const dataRows = new Set(sheet.cells.filter((c) => sheet.styles[c[4]].data).map((c) => c[0])).size;
                    if (dataRows <= 20 && portrait.zoom >= 0.85 && layout.pages >= 2 * portrait.pages) layout = await lay(false);
                }
            }
            // A form (no list table) that spills a sliver onto a second page - OP L4's SUAMI/ISTRI
            // signature strip - prints a little smaller on one page instead.
            if (layout.pages === 2 && !sheetRegions(sheet).heads.length) {
                const one = await lay(layout.landscape, 0.9);
                if (one.pages === 1) layout = one;
            }
            out.fragments.push(layout.html);
            out.excel.push({ name, sheet, grid: layout.grid, landscape: layout.landscape });
        }
        if (names.length > 1) out.fragments = await numberAcross(page, out.fragments, 'LAMPIRAN ' + String(label).toUpperCase().replace(/^L-?/, ''));
        if (names.length > 1) remaining.filter((m) => m.rows && m.rows.length).forEach((m) => out.unplaced.push('tabel "' + (m.title || '') + '" (' + m.rows.length + ' baris) tidak punya tempat di formulir'));
    } finally {
        await page.close();
    }
    return out;
}

/** The pages of a lampiran printed from several sheets are numbered as one run: the kop's
 *  "HALAMAN n" and the footer count every page of the lampiran, not the pages of each sheet
 *  (L1-1 overflowing onto a second page made the next sheet's "HALAMAN 2" the third page). */
async function numberAcross(page, fragments, label) {
    await page.setContent(fragments.map((f, i) => `<div data-frag="${i}">${f}</div>`).join(''));
    return page.evaluate((label) => {
        const pages = [...document.querySelectorAll('.pg')];
        pages.forEach((pg, i) => {
            for (const td of pg.querySelectorAll('td')) if (/^\s*HALAMAN\s+\d+\s*$/i.test(td.textContent)) td.textContent = 'HALAMAN ' + (i + 1);
            const foot = pg.querySelector('.pg-foot');
            if (foot) foot.textContent = label + ' · Halaman ' + (i + 1) + ' dari ' + pages.length;
        });
        return [...document.querySelectorAll('[data-frag]')].map((d) => d.innerHTML);
    }, label);
}

/** Prints finished pages (from renderTab) as one PDF: portrait and landscape Folio pages side by
 *  side through CSS named pages, one embedded font set for the whole document. */
async function printFragments(browser, fragments) {
    const page = await browser.newPage();
    await page.route('**/*', (r) => r.abort());
    try {
        await page.setContent(`<meta charset="utf-8"><style>${fontFaces()}${BASE_CSS}
@page po{size:216mm 330mm;margin:${MARGIN}mm}@page la{size:330mm 216mm;margin:${MARGIN}mm}
.pg.po{page:po}.pg.la{page:la}.pg{break-after:page}.sheet-pages:last-child .pg:last-child{break-after:auto}</style>${fragments.join('')}`);
        await page.evaluate(() => document.fonts.ready);
        return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
    } finally {
        await page.close();
    }
}

/** Several PDF buffers -> one. */
async function mergePdfs(buffers) {
    const doc = await PDFDocument.create();
    for (const b of buffers) { const p = await PDFDocument.load(b); for (const pg of await doc.copyPages(p, p.getPageIndices())) doc.addPage(pg); }
    return Buffer.from(await doc.save());
}

module.exports = { supports, renderTab, printFragments, sheetsForTab, mergePdfs };
