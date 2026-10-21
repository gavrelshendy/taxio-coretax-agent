// Uji offline pembaca API SPT Tahunan generik (lib/lampiran-api-cit.js) di SEMUA tab tangkapan raw:
// HTML tab asli + API Coretax tiruan dari api.json (request grid asli + barisnya).
const path = require('path');
const root = process.argv[2] || require('path').join(__dirname, '..'), who = process.argv[3] || 'BBH';
const gridApi = require(path.join(root, 'lib/returnsheet-grid-api'));
const capture = require(path.join(root, 'lib/lampiran-capture'));
const cit = require(path.join(root, 'lib/lampiran-api-cit'));
const raw = require(path.join(root, 'fixtures/coretax-spt', who + '-1771-2025.raw.json'));
const api = require(path.join(root, 'fixtures/coretax-spt', who + '-1771-2025.api.json'));
const { chromium } = require(path.join(root, 'node_modules/playwright'));

const variants = api.grids.map((g, i) => ({ pathname: g.endpoint, variantKey: 'v' + i, url: 'https://x' + g.endpoint, body: { ...g.request }, rows: g.rows }));
let posts = 0;
gridApi.hasAuthorization = () => true;
gridApi.dataRequestVariants = () => variants.map(({ rows, ...v }) => v);
gridApi.watchContext = () => ({ codeLists: [] });
gridApi.authenticatedPost = async (page, url, body) => {
    posts++;
    const v = variants.find((x) => 'https://x' + x.pathname === url && JSON.stringify({ ...x.body, First: 0, Rows: 0 }) === JSON.stringify({ ...body, First: 0, Rows: 0 }));
    return { status: 200, json: { Payload: { TotalRecords: v.rows.length, Data: v.rows.slice(body.First, body.First + body.Rows) } } };
};
gridApi.fetchAllRowsFromRequest = async (page, req) => ({ rows: variants.find((x) => x.pathname === req.pathname && JSON.stringify(x.body) === JSON.stringify(req.body)).rows });

(async () => {
    const browser = await chromium.launch({ ...(await require(path.join(root, 'lib/browser')).launchOptions()), headless: true });
    let bad = 0;
    for (const tab of raw.tabs) {
        const page = await browser.newPage();
        await page.setContent('<div id="root">' + tab.rootHtml + '</div>');
        const notes = [];
        try {
            const out = await capture.collectTabFromRows(page, '#root', tab.label, async (headers, index, shown) => {
                const rows = await cit.displayRows(page, tab.label, headers, index, shown);
                notes.push('#' + (index + 1) + (rows === null ? ' layar ' + shown.rows.length : ' API ' + rows.length + '/' + (shown.total ?? shown.rows.length)));
                return rows;
            }, null);
            const capRows = tab.tables.map((t) => t.collectedRows);
            let ok = out.tables.every((t, i) => capRows[i] === undefined || t.collectedRows === capRows[i]);
            // Setiap sel API vs setiap sel hasil paginator lama (bodies tangkapan), semua baris.
            const cells = (html) => page.evaluate((h) => { const t = document.createElement('table'); t.innerHTML = '<tbody>' + h + '</tbody>'; const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
                return [...t.rows].filter((r) => !/Tidak ada data|No records/i.test(r.textContent)).map((r) => [...r.cells].map((c) => { const x = c.cloneNode(true); x.querySelectorAll('.p-column-title').forEach((n) => n.remove()); return clean(x.textContent); })); }, html);
            for (const t of out.tables) {
                const old = tab.tables.find((x) => x.index === t.index);
                if (!old || !t.rows) continue;
                const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
                const before = old.pages ? old.pages.flatMap((p) => (p.body || []).map((row) => row.map((c) => clean(c.text)))).filter((r) => !/Tidak ada data|No records/i.test(r.join(' '))) : await cells(old.bodies.join(''));
                if (before.length !== t.rows.length) notes.push('paginator ' + before.length + ' baris');
                let diff = 0, first = '';
                t.rows.forEach((r, i) => r.forEach((v, c) => { if (c > 0 || !/^NO/.test(String(t.headers[c]).toUpperCase())) if ((before[i] || [])[c] !== v) { diff++; if (!first) first = 'baris ' + (i + 1) + ' "' + t.headers[c] + '": paginator "' + (before[i] || [])[c] + '", API "' + v + '"'; } }));
                notes.push('sel#' + (t.index + 1) + ' ' + (diff ? diff + ' beda: ' + first : 'identik'));
                if (diff) ok = false;
            }
            if (!ok) bad++;
            console.log((ok ? 'ok   ' : 'BEDA ') + tab.label.padEnd(6) + notes.join(', ') + (ok ? '' : '  (paginator lama: ' + capRows.join('+') + ')'));
        } catch (e) {
            const msg = e.message;
            const benign = /tidak ada tabel yang diambil lewat API/.test(msg);
            if (!benign) bad++;
            console.log((benign ? 'layar ' : 'TOLAK ') + tab.label.padEnd(6) + (notes.join(', ') + ' ' + (benign ? '(semua tabel utuh di layar)' : msg)).slice(0, 260));
        }
        await page.close();
    }
    await browser.close();
    console.log('permintaan halaman-1 API: ' + posts);
    process.exit(bad ? 1 : 0);
})();
