/* Tes pembacaan "siapa yang aktif" setelah impersonate (lib/chrome.js verifyImpersonationByCode)
   terhadap halaman tiruan tombol akun Coretax: sebelum pindah (NIK PIC, tanpa chip IMPERSONATE),
   sesudah pindah (chip + NPWP berformat titik/strip/spasi), entitas lain, dan tombol tidak ada.
   Regresi untuk dua bug: (1) Coretax memindahkan sesi ke cookie httpOnly sehingga token tak terbaca
   dan setiap impersonate menunggu 30 detik; (2) regex \D di dalam template string kehilangan
   backslash-nya sehingga NPWP berformat tak pernah cocok. Jalankan:
     node scripts/test-impersonate-verify.js */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = require('playwright');
const chromeLib = require('../lib/chrome.js');

const html = (inner) => '<!doctype html><body>' + inner + '</body>';
const NIK_BTN = '<button class="tw-profilebtn-wide">Fredi Setyawan 3171012345670001</button>';
const IMP_BTN = (npwp) => '<button class="tw-profilebtn-wide"><span class="tw-profile-imp-chip">IMPERSONATE</span> BAROQUE BENANG HARAPAN ' + npwp + '</button>';
const WANT = '0503314734012000';
const CASES = [
    ['sebelum pindah (tombol akun = NIK PIC, tanpa chip)', NIK_BTN, false],
    ['sesudah pindah (chip + NPWP titik-strip)', IMP_BTN('05.033.147.3-401.2000'), true],
    ['sesudah pindah (chip + NPWP spasi 16 digit)', IMP_BTN('0503 3147 3401 2000'), true],
    ['chip tapi entitas lain', IMP_BTN('0314 5972 4654 1000'), false],
    ['tombol akun tidak ada di halaman', '<div>Memuat...</div>', null],
    // Markup Coretax asli (live 2026-10-05); di jendela sempit teks NPWP/nama disembunyikan CSS.
    ['markup asli, teks NPWP tersembunyi (jendela sempit)', '<button class="tw-iconbtn tw-profilebtn-wide"><span class="tw-profile-text" style="display:none"><span class="tw-profile-npwp">0503314734012000</span> BAROQUE</span><span class="tw-profile-imp-chip">IMPERSONATE</span></button>', true],
    ['chip ada tapi tak ada angka NPWP','<button class="tw-profilebtn-wide"><span class="tw-profile-imp-chip">IMPERSONATE</span> Nama saja</button>', null]
];

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    let passed = 0;
    for (const [name, inner, expected] of CASES) {
        await page.setContent(html(inner));
        const got = await chromeLib.verifyImpersonationByCode(page, WANT);
        if (got === expected) { passed++; console.log('  ok   ' + name); }
        else { console.error('  FAIL ' + name + ' -> ' + JSON.stringify(got) + ' (diharapkan ' + JSON.stringify(expected) + ')'); process.exitCode = 1; }
    }

    // hasPortalSession: sesi di cookie httpOnly (tanpa token di storage) dikenali dari tombol akun di topbar,
    // sehingga aksi berikutnya tidak lagi membuka /Account/Login -> "Pilih Akun" -> "Lanjutkan" (~14 detik).
    await page.route('https://coretaxdjp.pajak.go.id/**', (route) => {
        const u = route.request().url();
        const body = u.includes('/withTopbar') ? html(NIK_BTN) : html('<div>Memuat...</div>');
        return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    await page.route('https://contoh-lain.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html(NIK_BTN) }));
    const PORTAL = [
        ['portal dengan tombol akun (sesi cookie, tanpa token) = sudah login', 'https://coretaxdjp.pajak.go.id/withTopbar', true],
        ['portal tanpa tombol akun = belum login', 'https://coretaxdjp.pajak.go.id/home', false],
        ['halaman identity provider = bukan portal', 'https://coretaxdjp.pajak.go.id/identityproviderportal/Account/Login', false],
        ['domain lain = bukan portal', 'https://contoh-lain.example/withTopbar', false]
    ];
    for (const [name, url, expected] of PORTAL) {
        await page.goto(url);
        const got = await chromeLib.hasPortalSession(page);
        if (got === expected) { passed++; console.log('  ok   ' + name); }
        else { console.error('  FAIL ' + name + ' -> ' + JSON.stringify(got) + ' (diharapkan ' + JSON.stringify(expected) + ')'); process.exitCode = 1; }
    }
    await browser.close();
    console.log(process.exitCode ? 'ADA YANG GAGAL' : passed + ' tes lulus.');
})().catch((e) => { console.error(e); process.exit(1); });
