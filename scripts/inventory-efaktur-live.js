/* Inventaris e-Faktur (READ-ONLY): menelusuri semua menu portal e-Invoice Coretax di jendela Chrome yang
   SUDAH login, lalu mencatat endpoint API yang dipanggil tiap halaman dan NAMA kolom/field responsnya.
   Tujuannya: menemukan dokumen e-Faktur selain Pajak Masukan (Pajak Keluaran, Retur, Dokumen Lain, dst.)
   beserta endpoint daftarnya, sebelum fitur unduh dibuat. Tidak mengklik tombol apa pun, hanya membuka halaman.

   Yang DICATAT: metode + path API, nama kunci body/filter, nama field respons, judul kolom tabel, teks tombol.
   Yang TIDAK dicatat: token/header, isi nilai data faktur, NPWP/NIK/nomor faktur (ID dan angka panjang diganti <id>).

   Jalankan (jendela Chrome Coretax Agent harus terbuka dan sudah login ke entitas yang dimaksud):
     node scripts/inventory-efaktur-live.js            (port debug dicari otomatis di 9700-10099)
     node scripts/inventory-efaktur-live.js 9741       (atau sebut port-nya)
   Hasil: coretax-efaktur-inventory.json di folder temp (path dicetak). Kirim file itu. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const START = 'https://coretaxdjp.pajak.go.id/e-invoice-portal/id-ID/input-tax';
const PORTAL = '/e-invoice-portal/';
const API_MARK = '/einvoiceportal/api';

function getJson(url, timeout = 700) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}
async function findPort() {
    const arg = Number(process.argv[2]);
    if (arg) return arg;
    for (let port = 9700; port < 10100; port++) {
        if (await getJson('http://127.0.0.1:' + port + '/json/version')) return port;
    }
    throw new Error('Tidak ada jendela Chrome Coretax Agent dengan port debug terbuka (9700-10099). Buka Coretax lewat aplikasi dulu.');
}

const scrubString = (s) => String(s == null ? '' : s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{10,}/g, '<angka>');
const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
function shapeOfBody(text) {
    let body; try { body = JSON.parse(text); } catch (e) { return { raw: scrubString(text).slice(0, 120) }; }
    const filters = Array.isArray(body.Filters) ? body.Filters.map((f) => ({ prop: f.PropertyName, mode: f.MatchMode, asString: f.AsString })) : undefined;
    const scalars = {};
    for (const k of keysOf(body)) if (['First', 'Rows', 'SortField', 'SortOrder', 'LanguageId'].includes(k)) scalars[k] = body[k];
    return { keys: keysOf(body), scalars, filters };
}
async function shapeOfResponse(res) {
    let json; try { json = await res.json(); } catch (e) { return { status: res.status(), json: false }; }
    const payload = json && json.Payload;
    const data = payload && Array.isArray(payload.Data) ? payload.Data : null;
    return {
        status: res.status(), json: true, topKeys: keysOf(json), payloadKeys: keysOf(payload),
        rows: data ? data.length : undefined, totalRecords: payload && payload.TotalRecords,
        fields: data && data[0] ? keysOf(data[0]) : (Array.isArray(payload) && payload[0] ? keysOf(payload[0]) : undefined)
    };
}

(async () => {
    const port = await findPort();
    console.log('Terhubung ke Chrome di port ' + port);
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const context = browser.contexts()[0];
    // Pakai TAB Coretax yang sudah login (tab baru memulai ulang alur OIDC dan bisa terlempar ke login/logout).
    const existing = context.pages().find((p) => /coretaxdjp\.pajak\.go\.id\/(?!identityproviderportal)/.test(p.url()));
    if (!existing) {
        const urls = context.pages().map((p) => p.url().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').slice(0, 100));
        throw new Error('Tidak ada tab Coretax yang sedang login (tab: ' + JSON.stringify(urls) + '). Login dulu lewat aplikasi (pilih entitas, klik Masuk Coretax), lalu jalankan lagi.');
    }
    const page = existing;

    const calls = new Map();
    let currentPage = 'awal';
    context.on('response', async (res) => {
        const url = res.url();
        const at = url.indexOf(API_MARK);
        if (at === -1) return;
        const apiPath = scrubString(url.slice(at + API_MARK.length).split('?')[0]);
        const req = res.request();
        const key = req.method() + ' ' + apiPath;
        const entry = calls.get(key) || { method: req.method(), path: apiPath, halaman: new Set(), body: undefined, response: undefined };
        entry.halaman.add(currentPage);
        if (!entry.body && req.postData()) entry.body = shapeOfBody(req.postData());
        if (!entry.response || entry.response.status !== 200) entry.response = await shapeOfResponse(res);
        calls.set(key, entry);
    });

    const visitedLabels = [];
    const open = async (url, label) => {
        currentPage = label;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(9000);
        if (/identityproviderportal/.test(page.url())) throw new Error('Terlempar ke halaman login/logout - sesi Coretax berakhir.');
        const info = await page.evaluate(() => {
            const visible = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
            const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
            return {
                url: location.pathname,
                title: clean(document.title),
                headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean).slice(0, 12),
                tableHeaders: Array.from(document.querySelectorAll('table thead th')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean).slice(0, 60),
                buttons: Array.from(document.querySelectorAll('button,a.btn')).filter(visible).map((b) => clean(b.textContent) || b.getAttribute('aria-label') || '').filter(Boolean).slice(0, 40),
                tabs: Array.from(document.querySelectorAll('.p-tabview-title,[role="tab"]')).filter(visible).map((e) => clean(e.textContent)).filter(Boolean),
                links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({ text: clean(a.textContent).slice(0, 60), href: a.getAttribute('href') })).filter((x) => x.text && x.href)
            };
        });
        return info;
    };

    const pages = [];
    const first = await open(START, 'input-tax');
    pages.push(first);

    // Menu: kumpulkan tautan ke halaman portal e-Invoice dari halaman awal (tanpa mengklik apa pun).
    const menu = [];
    const seen = new Set([first.url]);
    for (const l of first.links) {
        const m = l.href.startsWith('http') ? new URL(l.href).pathname : l.href;
        if (!m.includes(PORTAL) || seen.has(m) || /\.(js|css|png|ico)$/i.test(m)) continue;
        seen.add(m); menu.push({ text: l.text, path: m });
    }
    console.log('Tautan portal e-Invoice ditemukan: ' + menu.length);
    for (const item of menu.slice(0, 40)) {
        try {
            const info = await open('https://coretaxdjp.pajak.go.id' + item.path, item.text || item.path);
            visitedLabels.push(item.text);
            delete info.links;
            pages.push({ label: item.text, ...info });
            console.log('  dibuka: ' + (item.text || item.path));
        } catch (e) { pages.push({ label: item.text, path: item.path, error: e.message }); }
    }
    delete first.links;

    const report = {
        dibuat: new Date().toISOString(), port,
        halaman: pages,
        endpoint: Array.from(calls.values()).map((c) => ({ ...c, halaman: Array.from(c.halaman) })).sort((a, b) => a.path.localeCompare(b.path))
    };
    const output = path.join(os.tmpdir(), 'coretax-efaktur-inventory.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log('\nHasil: ' + output);
    console.log('Endpoint yang terlihat:');
    for (const e of report.endpoint) console.log('  ' + e.method + ' ' + e.path + '  <- ' + e.halaman.join(', ') + (e.response && e.response.rows != null ? '  [' + e.response.rows + ' baris]' : ''));
    process.exit(0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
