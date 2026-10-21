// Uji bundleCodeLists: skrip tiruan dari coretaxdjp berisi objek ter-minify; daftar dipilih hanya bila cocok
// dengan pasangan halaman 1.
const path = require('path');
const root = process.argv[2] || require('path').join(__dirname, '..');
const gridApi = require(path.join(root, 'lib/returnsheet-grid-api'));
const { chromium } = require(path.join(root, 'node_modules/playwright'));
(async () => {
    const browser = await chromium.launch({ ...(await require(path.join(root, 'lib/browser')).launchOptions()), headless: true });
    const page = await browser.newPage();
    const js = 'const a=[{value:"0710",label:"Peralatan Lainnya"},{value:"0405",label:"Mesin dan Peralatan Industri"},{value:"0101",label:"Tanah"}];'
        + 'const b=[{code:"0710",text:"Something else"},{code:"0405",text:"Salah"}];const m=[{id:"GL",name:"Garis Lurus"},{id:"SM",name:"Saldo Menurun"}];';
    await page.route('https://coretaxdjp.pajak.go.id/**', (r) => r.request().url().endsWith('.js') ? r.fulfill({ contentType: 'application/javascript', body: js }) : r.fulfill({ contentType: 'text/html', body: '<html><body><script src="/returnsheets-portal/main.abc.js"></script></body></html>' }));
    await page.goto('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/x');
    const lists = await gridApi.bundleCodeLists(page, [['0710', 'Peralatan Lainnya']]);
    console.log(lists.map((l) => l.source + ' ' + JSON.stringify(l.map)).join('\n'));
    const ok = lists.length >= 1 && lists.every((l) => l.map['0405'] === 'Mesin dan Peralatan Industri');
    const methods = await gridApi.bundleCodeLists(page, [['GL', 'Garis Lurus']]);
    const ok2 = methods.some((l) => l.map.SM === 'Saldo Menurun');
    console.log((ok && ok2 ? 'PASS' : 'FAIL') + ': daftar kode dari skrip dipilih hanya bila cocok dengan halaman 1');
    await browser.close();
    process.exit(ok && ok2 ? 0 : 1);
})();
