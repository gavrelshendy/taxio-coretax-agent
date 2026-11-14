/* Tes UI dashboard di Chrome headless (Playwright) terhadap server dashboard sungguhan dengan
   Supabase, Chrome-Coretax, dan daftar entitas palsu (scripts/gui-test-fakes.js). Memeriksa alur
   daftar/masuk, palet entitas satu-baris-per-entitas, form tiap fitur, login manual, tampilan
   proses, dan mode Restricted. Tangkapan layar disimpan bila PILOT_SHOTS diisi. Jalankan:
     node scripts/test-gui-ui.js */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install } = require('./gui-test-fakes');
const fakes = install();
const { chromium } = require('playwright');
const { createGuiServer } = require('../gui/server');

// Port pilihan OS (0): dua checkout yang menjalankan tes bersamaan tidak bentrok (EADDRINUSE).
let PORT = 0;
let BASE = '';
const SHOTS = process.env.PILOT_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
const now = new Date();
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const PREV_MMYY = String(prev.getMonth() + 1).padStart(2, '0') + String(prev.getFullYear() % 100).padStart(2, '0');

(async () => {
    // Token peluncuran: jendela dibuka di /?t=<token> seperti main.js; server menukarnya dengan cookie.
    const server = await createGuiServer(0);
    PORT = server.address().port;
    BASE = 'http://127.0.0.1:' + PORT;
    // Chromium bawaan Playwright bila terpasang; kalau tidak (mis. "Executable doesn't exist"), pakai Google Chrome.
    let browser;
    try { browser = await chromium.launch({ headless: true }); }
    catch (e) { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_INTERNET|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

    // Aksi otomasi dicegat di browser: dicatat lalu dijawab 202, tidak sampai ke server.
    const calls = [];
    const actionRefuse = {}; // entity_id -> { status, error }: aksi untuk entitas itu ditolak server (mis. 409)
    await page.route('**/api/actions/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url()).pathname;
        if (url.endsWith('/open-coretax')) return route.continue();
        if (url.endsWith('/pick-file')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canceled: false, fileName: 'faktur-uji.xlsx', fileBase64: 'AAAA' }) });
        if (url.endsWith('/pick-folder')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canceled: true }) });
        calls.push({ url, body: req.postDataJSON() });
        const refuse = actionRefuse[((req.postDataJSON() || {}).entity || {}).entity_id];
        if (refuse) return route.fulfill({ status: refuse.status, contentType: 'application/json', body: JSON.stringify({ error: refuse.error }) });
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ started: true }) });
    });
    // Pratinjau isian Pembetulan (tanpa Coretax): 2 NIK dari sheet NIK, tidak ada pembatalan.
    await page.route('**/api/bpmp-amend/preview', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ byNik: 2, perSlip: 0, cancels: [], skipped: [] }) }));
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
    const text = (sel) => page.locator(sel).first().innerText();
    const visible = (sel) => page.locator(sel).first().isVisible();
    const lastCall = () => calls[calls.length - 1];
    const pause = (ms) => page.waitForTimeout(ms);
    // Kosongkan sesi palsu; pilihan entitas otomatis lepas (jendela hilang), lalu pilih lagi Sejahtera/ANDI.
    // Popover "Coretax windows" (meter di topbar satu baris) memuat tab sesi; buka bila belum terbuka.
    const openWin = async () => { if (!(await page.locator('#sess-win').count())) await page.click('#sess-meter'); await page.waitForSelector('#sess-win'); };
    const sessionsGoneThenReselect = async () => {
        fakes.ctl.sessions = [];
        await page.waitForFunction(() => document.querySelector('#entity-chip').textContent.includes('Select entity'), null, { timeout: 7000 });
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'));
    };

    console.log('gui ui');
    await test('tanpa token: halaman statis termuat tetapi API ditolak 401; /?t= memasang cookie lalu redirect ke /', async () => {
        const plain = await (await browser.newContext()).newPage();
        try {
            await plain.goto(BASE + '/');
            const st = await plain.evaluate("fetch('/api/session').then(function (r) { return r.status; })");
            assert.strictEqual(st, 401);
        } finally { await plain.context().close(); }
        const resp = await page.goto(BASE + '/?t=' + server.token);
        assert.strictEqual(new URL(page.url()).pathname + new URL(page.url()).search, '/');
        assert.ok(resp.ok());
        const cookies = await ctx.cookies(BASE);
        const c = cookies.find((x) => x.name === 'taxio_pilot_' + PORT);
        assert.ok(c && c.httpOnly && c.sameSite === 'Strict', 'cookie HttpOnly SameSite=Strict');
    });
    await page.waitForSelector('.auth-form');

    // ------------------------------------------------ masuk / daftar
    await test('layar masuk: pesan otomasi, tanpa jalan masuk manual tanpa akun', async () => {
        assert.strictEqual(await text('.hero-body h1'), 'Coretax runs itself.');
        assert.ok(await visible('#au-email') && await visible('#au-pass'));
        const html = await page.content();
        assert.ok(!/Masuk Coretax manual|Sign in to Coretax manually/i.test(html), 'tidak boleh ada masuk manual tanpa akun Taxio');
        await shot('01-masuk');
    });
    await test('daftar: inisial, email, kata sandi; galat memakai kalimat Taxio Hub', async () => {
        await page.click('[data-au="to-daftar"]');
        await page.waitForSelector('#au-initial');
        await page.click('[data-au="signup"]');
        assert.strictEqual(await text('#au-error'), 'Initials are required.');
        await page.fill('#au-initial', 'sga');
        assert.strictEqual(await page.inputValue('#au-initial'), 'SGA', 'inisial otomatis huruf besar');
        await page.fill('#au-email', 'baru@contoh.com'); await page.fill('#au-pass', '123');
        await page.click('[data-au="signup"]');
        assert.strictEqual(await text('#au-error'), 'Password must be at least 6 characters.');
        await shot('02-daftar');
    });
    await test('daftar sukses: layar cek email dengan langkah 2 berjalan', async () => {
        await page.fill('#au-pass', '123456');
        await page.click('[data-au="signup"]');
        await page.waitForSelector('.progress-steps');
        assert.ok((await text('.auth-form h2')).includes('Check your email'));
        assert.strictEqual(await page.locator('.pstep.done').count(), 1);
        assert.ok((await page.locator('.pstep.now .tx b').innerText()).includes('Confirm email'));
        await shot('03-cek-email');
    });
    await test('setelah konfirmasi: kembali ke masuk dengan email terisi, lalu status menunggu admin', async () => {
        await page.click('[data-au="to-masuk"]');
        await page.waitForSelector('[data-au="login"]');
        assert.strictEqual(await page.inputValue('#au-email'), 'baru@contoh.com');
        await page.fill('#au-pass', 'benar');
        await page.click('[data-au="login"]');
        await page.waitForSelector('.progress-steps');
        assert.ok((await text('.auth-form h2')).includes('Waiting for admin'));
        assert.ok((await text('.auth-form .lead')).includes('assign you to a group'));
        assert.ok((await text('.auth-form .lead')).includes('SGA'), 'inisial yang diajukan tampil');
        assert.strictEqual(await page.locator('.pstep.done').count(), 2);
        await shot('04-menunggu-admin');
    });
    await test('periksa status saat masih menunggu: tetap di layar status', async () => {
        await page.click('[data-au="check"]');
        await page.waitForSelector('#notice-stack .notice');
        assert.ok((await text('#notice-stack .notice')).includes('No change yet'));
        assert.ok(await visible('.progress-steps'));
    });
    await test('setelah admin menempatkan ke grup: periksa status membuka aplikasi', async () => {
        fakes.ctl.reg.active = true;
        await page.click('[data-au="check"]');
        await page.waitForSelector('#app .sidebar');
        assert.ok(await visible('.topbar'));
    });

    // ------------------------------------------------ kerangka aplikasi
    await test('sidebar: grup Download / Change in Coretax / Year-End (menurut akibatnya), semua halaman tetap ada; tanpa Fix Bukti Potong', async () => {
        const titles = await page.locator('.nav-title').allInnerTexts();
        assert.deepStrictEqual(titles.map((t) => t.trim()), ['Download', 'Change in Coretax', 'Year-End']);
        const items = await page.locator('.nav-item[data-nav]').allInnerTexts();
        assert.deepStrictEqual(items.map((t) => t.trim()), ['Runs', 'SPT', 'e-Bupot', 'Bukti Potong Saya', 'e-Faktur', 'e-Bupot Upload & Issue', 'Credit Faktur Masukan', 'PPh 25 Kode Billing', 'e-Reporting', 'Annual PPh 21 Recap'], 'urutan & nama menu sidebar');
        assert.ok((await text('#open-settings')).includes('Settings'));
        assert.ok(!(await text('.sidebar')).includes('Fix Bukti Potong'), 'tanpa halaman Fix Bukti Potong (keputusan pemilik)');
        assert.ok(!(await page.locator('.nav-item[data-nav="billing"]').innerText()).includes('NEW'), 'tanpa badge NEW');
        const change = page.locator('.nav-group').nth(2);
        assert.ok((await change.innerText()).includes('PPh 25 Kode Billing') && (await change.innerText()).includes('Credit Faktur Masukan'));
        assert.ok(!(await page.locator('.nav-group').nth(1).innerText()).includes('Billing'));
        assert.ok((await page.locator('.nav-group').nth(3).innerText()).includes('Annual PPh 21 Recap'), 'Annual PPh 21 Recap di Year-End, tersedia untuk anggota biasa');
        // Label tidak terpotong di sidebar terbuka.
        const cut = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item .grow')).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
        assert.deepStrictEqual(cut, [], 'label sidebar tidak terpotong');
    });
    await test('tanpa entitas: formulir tetap tampil dengan banner pilih entitas, tombol mulai nonaktif', async () => {
        const main = await text('.col-main');
        assert.ok(main.includes('No entity selected'));
        assert.ok(/Jenis Pajak/i.test(main) && /Masa Pajak/i.test(main), 'formulir SPT tetap tampil');
        assert.ok(await page.locator('.col-main [data-act="open-palette"]').isVisible());
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled());
        assert.ok((await text('#abar')).includes('Select an entity first'));
        await shot('05-tanpa-entitas');
    });
    await test('Laporan Realisasi Investasi (Dividen): kini butuh entitas terpilih seperti halaman lain (banner sesi manual lama sudah dihapus)', async () => {
        await page.click('.nav-item[data-nav="dividen"]');
        await page.waitForSelector('.dropzone');
        assert.strictEqual(await text('.topbar h1'), 'Laporan Realisasi Investasi (Dividen)');
        const main = await text('.col-main');
        assert.ok(main.includes('No entity selected'), 'banner pilih entitas, sama seperti halaman lain');
        assert.ok(!/session you log in to yourself/i.test(main), 'banner sesi manual lama sudah dihapus');
        assert.strictEqual(await page.locator('.col-main [data-act="open-coretax"], .col-main [data-act="check-session"]').count(), 0, 'tanpa tombol Open Coretax / Check session di halaman');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'tombol mulai terkunci tanpa entitas');
        assert.ok((await text('#abar')).includes('Select an entity first'));
        await page.click('.nav-item[data-nav="spt"]');
        await page.waitForSelector('.tile[data-val="pph21"]');
    });

    // ------------------------------------------------ palet entitas
    await test('palet Grup: satu baris per entitas, yang tanpa PIC disembunyikan, ada keterangan', async () => {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#palette .ent');
        const names = await page.locator('#pal-body .ent .ent-tx b').allInnerTexts();
        assert.deepStrictEqual(names, ['Budi Contoh Santoso', 'CV Sample Niaga Mandiri', 'MITRA KARYA ABADI, PT', 'PT Contoh Sejahtera Abadi']);
        assert.strictEqual(names.filter((n) => n.startsWith('MITRA KARYA')).length, 1, 'MKA hanya sekali walau 2 PIC');
        assert.ok((await text('#pal-body')).includes('2 Coretax PICs'));
        assert.ok((await text('#pal-body .pal-note')).includes('are hidden'));
        assert.ok(!(await text('#pal-body')).includes('MITRA LESTARI'), 'entitas tanpa PIC tidak di daftar awal');
        await shot('06-palet-grup');
    });
    await test('palet: pencarian menampilkan entitas tanpa PIC dengan keterangan, tidak bisa dipilih', async () => {
        await page.fill('#pal-q', 'mitra');
        const names = await page.locator('#pal-body .ent .ent-tx b').allInnerTexts();
        assert.deepStrictEqual(names, ['MITRA KARYA ABADI, PT', 'MITRA LESTARI UTAMA, PT']);
        const unlinked = page.locator('#pal-body .ent.unlinked');
        assert.ok((await unlinked.innerText()).includes('NO PIC YET'));
        assert.ok((await unlinked.innerText()).includes('Manage Coretax PIC'));
        assert.ok((await unlinked.innerText()).includes('Use manual login'));
        assert.strictEqual(await unlinked.locator('.ent-main').getAttribute('aria-disabled'), 'true');
        await unlinked.locator('.ent-main').click({ force: true });
        assert.ok(await visible('#palette'), 'klik pada baris tanpa PIC tidak memilih');
        assert.ok(!(await text('#entity-chip')).includes('LESTARI'), 'entitas tanpa PIC tidak terpilih');
        await shot('07-palet-cari');
    });
    await test('palet: entitas 2 PIC membuka pilihan PIC; memilih PIC menutup palet dan mengisi topbar', async () => {
        await page.locator('#pal-body .ent', { hasText: 'MITRA KARYA ABADI' }).locator('.ent-main').click();
        const radios = page.locator('#pal-body .radio-row');
        assert.strictEqual(await radios.count(), 2);
        assert.ok((await radios.first().innerText()).includes('PRIMARY'));
        assert.strictEqual(await radios.first().getAttribute('aria-checked'), 'true', 'PIC utama terpilih bawaan');
        await shot('08-palet-pic');
        await radios.nth(1).click();
        await page.waitForSelector('#palette', { state: 'detached' });
        const chip = await text('#entity-chip');
        assert.ok(chip.includes('MITRA KARYA ABADI'));
        assert.ok(chip.includes('PIC RINA WIJAYA'));
        assert.ok(chip.includes('AUTO'));
        assert.ok((await text('.status-pill')).includes('Not signed in to Coretax'));
    });
    await test('pilihan PIC terakhir diingat untuk entitas itu', async () => {
        await page.click('#entity-chip');
        await page.locator('#pal-body .ent', { hasText: 'MITRA KARYA ABADI' }).locator('.ent-main').click();
        assert.strictEqual(await page.locator('#pal-body .radio-row').nth(1).getAttribute('aria-checked'), 'true');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    await test('palet: Enter pada entitas 2 PIC membuka pilihan PIC juga, TIDAK langsung login dengan PIC utama', async () => {
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'mitra karya');
        await page.keyboard.press('Enter');
        assert.ok(await visible('#palette'), 'Enter pada entitas 2 PIC tidak boleh menutup palet');
        const radios = page.locator('#pal-body .radio-row');
        assert.strictEqual(await radios.count(), 2, 'Enter harus membuka pilihan PIC, sama seperti klik');
        await radios.nth(1).click();
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('PIC RINA WIJAYA'));
    });
    await test('palet: pilihan PIC bisa diselesaikan MURNI lewat keyboard (Enter buka, ↑↓ pindah, Enter konfirmasi) - tanpa klik mouse', async () => {
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'mitra karya');
        await page.keyboard.press('Enter');
        assert.ok(await visible('#palette'), 'Enter pertama membuka pilihan PIC');
        // Highlight awal = pilihan PIC TERAKHIR yang diingat (RINA WIJAYA, dari test sebelumnya),
        // bukan selalu PIC utama - konsisten dengan "pilihan PIC terakhir diingat" di atas.
        assert.strictEqual(await page.locator('#pal-body .radio-row[aria-checked="true"]').innerText(), 'RINA WIJAYA', 'PIC terakhir dipakai ter-highlight duluan');
        await page.keyboard.press('ArrowUp');
        const hi = await page.locator('#pal-body .radio-row[aria-checked="true"]').innerText();
        assert.ok(hi.includes('ANDI PRATAMA') && hi.includes('PRIMARY'), '↑ memindah highlight ke PIC lain, belum login');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('PIC ANDI PRATAMA'), 'Enter kedua mengonfirmasi PIC yang di-highlight (bukan yang lama) dan login');
    });
    await test('palet: Tab murni ke baris entitas lalu Enter tetap jalan (native), bukan cuma jalan pintas kotak cari', async () => {
        // Jalan pintas ↑↓/Enter di atas HANYA boleh aktif selagi fokus asli ada di kotak cari -
        // begitu pengguna berpindah pakai Tab (cara screen reader/keyboard biasa, bukan mengetik),
        // Enter pada tombol yang fokus harus tetap memicu tombol ITU secara native, tidak boleh
        // diam-diam ditangkap dan diarahkan ke logika kotak cari.
        await page.click('#entity-chip');
        await page.locator('#pal-q').focus();
        await page.keyboard.press('Tab'); // -> "Tambah entitas baru" (aksi global, selalu di atas)
        await page.keyboard.press('Tab'); // -> baris entitas pertama (Budi Contoh Santoso)
        await page.keyboard.press('Enter'); // harus memicu klik native baris yang fokus ini
        assert.ok((await text('#entity-chip')).includes('Budi Contoh Santoso'), 'Enter pada baris hasil Tab harus memicu baris itu sendiri, bukan diabaikan/diarahkan ke jalan pintas kotak cari');
        await page.click('#entity-chip'); // buka lagi untuk test berikutnya
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter'); // kembalikan pilihan
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    // Test berikut ini sengaja ditaruh TERAKHIR di blok palet: hasil akhirnya (entitas terpilih =
    // PT Contoh Sejahtera Abadi / PIC ANDI PRATAMA, PIC tunggal) dipakai sebagai titik awal
    // blok-blok pengujian halaman fitur (SPT dst.) di bawah - jangan tambah test palet baru
    // SESUDAH ini tanpa memindahkan test ini kembali ke urutan terakhir.
    await test('palet: navigasi keyboard, Enter pada PIC tunggal langsung login', async () => {
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'));
        assert.ok((await text('#entity-chip')).includes('PIC ANDI PRATAMA'));
    });
    await test('topbar: tombol 👤 beralih entitas terpilih ke sesi manual, membawa nama & NPWP-nya', async () => {
        assert.ok(await visible('#btn-manual-for-entity'));
        await page.click('#btn-manual-for-entity');
        const chip = await text('#entity-chip');
        assert.ok(chip.includes('PT Contoh Sejahtera Abadi') && chip.includes('MANUAL'), 'nama entitas tetap dibawa, tag berubah jadi MANUAL');
        assert.ok(await visible('#btn-open-coretax') && await visible('#btn-check-session'), 'topbar berubah ke Buka Coretax + Periksa sesi');
        // kembalikan ke OTOMATIS untuk blok-blok pengujian berikutnya
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('AUTO'));
    });

    // ------------------------------------------------ halaman SPT
    await test('SPT: bawaan PPh 21/26 dan bulan lalu, ringkasan menghitung kombinasi', async () => {
        assert.strictEqual(await page.locator('.tile[data-val="pph21"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await page.locator('.chip[data-val="' + PREV_MMYY + '"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await text('#abar .abar-n'), '1');
        assert.ok((await text('#abar')).includes('Automatic · PIC ANDI PRATAMA'));
        await shot('09-spt');
    });
    await test('SPT: pilih beberapa jenis dan masa memperbarui hitungan; kode diketik memilih chip', async () => {
        await page.click('.tile[data-val="ppn"]');
        await page.click('.pp [data-pp="quick"][data-val="year"]');
        assert.strictEqual(await text('#abar .abar-n'), '24', '2 jenis x 12 masa (Full year)');
        await page.click('.pp [data-pp="text"]');
        await page.fill('.pp [data-pp-input]', '0126-0326;0526');
        assert.ok((await text('.pp .summary-line')).includes('4 Masa Pajak'));
        assert.ok((await text('.pp .code-chip')).includes('0126-0326;0526'));
        await page.fill('.pp [data-pp-input]', '1326');
        assert.ok((await text('.pp [data-pp-error]')).includes('Invalid Masa Pajak'));
        await page.fill('.pp [data-pp-input]', '0126-0326');
    });
    await test('SPT: tahunan eksklusif, memakai chip tahun; OP terkunci untuk Badan', async () => {
        assert.ok(await page.locator('.tile[data-val="spt_op"]').isDisabled());
        await page.click('.tile[data-val="badan"]');
        assert.strictEqual(await page.locator('.tile[data-val="pph21"]').getAttribute('aria-pressed'), 'false');
        assert.strictEqual(await page.locator('.tile[data-val="badan"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await page.locator('.pp .chip').count(), 6);
        assert.ok((await text('.col-main')).toLowerCase().includes('tahun pajak'));
        assert.ok(!(await text('.col-main')).includes('PPh 25'), 'opsi cek PPh 25 sudah dihapus dari SPT');
        await shot('10-spt-tahunan');
        await page.click('.tile[data-val="badan"]');
    });
    await test('SPT: lampiran membuka opsi; Rahasia hanya bila PPh 21/26 saja', async () => {
        await page.click('.tile[data-val="pph21"]');
        await page.click('.tile[data-val="ppn"]');
        await page.click('[data-act="lampiran"]');
        assert.ok(await visible('.subpanel'));
        const rahasia = page.locator('.subpanel [data-act="isi"][data-val="confidential"]');
        assert.ok(await rahasia.isDisabled(), 'PPN dipilih, Rahasia terkunci');
        await page.click('.tile[data-val="ppn"]'); // tinggal PPh 21/26 saja
        assert.ok(!(await rahasia.isDisabled()), 'hanya PPh 21/26: Rahasia terbuka');
        await page.click('[data-act="fmt"][data-val="excel"]');
        assert.ok(!(await visible('.subpanel [data-act="isi"]')), 'Excel menyembunyikan opsi PDF');
        await page.click('[data-act="fmt"][data-val="both"]');
        assert.ok(await visible('.subpanel [data-act="isi"]'), 'PDF + Excel menampilkan opsi PDF');
        await page.click('[data-act="fmt"][data-val="pdf"]');
        await page.click('[data-act="isi"][data-val="confidential"]');
        await shot('11-spt-lampiran');
    });
    await test('SPT: mulai mengirim permintaan dengan PIC terpilih dan bentuk yang sama seperti dulu', async () => {
        await page.click('[data-act="start"]');
        await pause(300);
        const c = lastCall();
        assert.strictEqual(c.url, '/api/actions/download-spt');
        assert.strictEqual(c.body.entity.pic_id, 'p-andi');
        assert.strictEqual(c.body.entity.entity_id, 'CSA');
        assert.strictEqual(c.body.entity.project, 'taxio_hub');
        assert.ok(!('pics' in c.body.entity));
        assert.deepStrictEqual(c.body.jenisPajakKeys, ['pph21']);
        assert.strictEqual(c.body.masaInput, '0126-0326');
        assert.strictEqual(c.body.includeLampiran, true);
        assert.strictEqual(c.body.lampiranMode, 'confidential');
        assert.strictEqual(c.body.lampiranFormat, 'pdf');
        assert.strictEqual(c.body.outputLayout, 'combined');
        assert.strictEqual(c.body.checkPph25, false);
        assert.strictEqual(c.body.layoutStyle, 'coretax');
    });

    // ------------------------------------------------ halaman lain (entitas Hub)
    await test('e-Bupot: BPMP mengunci PDF; kode objek hanya untuk BP21/BPPU; antrean per jenis', async () => {
        await page.click('.nav-item[data-nav="ebupot"]');
        await page.waitForSelector('.tile[data-val="bp21"]');
        assert.strictEqual(await page.locator('.tile[aria-pressed="true"]').count(), 0, 'awalnya tidak ada jenis yang terpilih (BP21 tidak lagi tercentang sendiri)');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'tanpa jenis: tombol mulai terkunci');
        assert.ok(!(await visible('#eb-kode')), 'tanpa jenis kode objek tidak relevan');
        await page.click('.tile[data-val="bpmp"]');
        assert.ok(!(await visible('#eb-kode')), 'tanpa BP21/BPPU kode objek tidak relevan');
        assert.ok(await page.locator('.doc-row [data-act="pdf"]').isDisabled(), 'BPMP saja: PDF terkunci');
        await page.click('.tile[data-val="bp21"]');
        assert.ok(await visible('#eb-kode'), 'dengan BP21 kode objek tampil');
        await page.fill('#eb-kode', '21-100-35');
        await page.click('.pp [data-pp="quick"][data-val="year"]');
        await page.click('[data-act="start"]');
        await pause(2800); // jenis kedua baru dikirim setelah jenis pertama selesai (polling 1,2 dtk)
        const eb = calls.filter((x) => x.url === '/api/actions/download-ebupot');
        assert.deepStrictEqual(eb.map((x) => x.body.bupotType).sort(), ['bp21', 'bpmp'], 'satu permintaan per jenis, berurutan');
        assert.ok(eb.some((x) => x.body.bupotType === 'bp21' && x.body.kodeInput === '21-100-35' && x.body.outputMode === 'pdf_excel'));
        assert.ok(eb.some((x) => x.body.bupotType === 'bpmp' && x.body.kodeInput === '' && x.body.outputMode === 'excel_only'));
        await shot('12-ebupot');
    });
    await test('e-Bupot: klik BPPU saja mengunduh BPPU saja (bukan BP21)', async () => {
        // Tes sebelumnya meninggalkan BP21 + BPMP terpilih: lepas dulu, lalu pilih BPPU saja.
        await page.click('.nav-item[data-nav="ebupot"]');
        await page.waitForSelector('.tile[data-val="bppu"]');
        for (const k of ['bp21', 'bpmp']) { if ((await page.locator('.tile[data-val="' + k + '"]').getAttribute('aria-pressed')) === 'true') await page.click('.tile[data-val="' + k + '"]'); }
        await page.click('.tile[data-val="bppu"]');
        assert.strictEqual(await page.locator('.tile[aria-pressed="true"]').count(), 1, 'hanya BPPU yang terpilih');
        const before = calls.length;
        await page.click('#abar [data-act="start"]'); await pause(800);
        const eb = calls.slice(before).filter((x) => x.url === '/api/actions/download-ebupot');
        assert.deepStrictEqual(eb.map((x) => x.body.bupotType), ['bppu'], 'hanya satu permintaan: BPPU');
    });
    await test('Bukti Potong Saya: jenis milik PIC pribadi terkunci untuk entitas Badan', async () => {
        await page.click('.nav-item[data-nav="bpsaya"]');
        await page.waitForSelector('.tile[data-val="bppu"]');
        for (const k of ['bpmp', 'bp21', 'bpa1', 'bpa2']) assert.ok(await page.locator('.tile[data-val="' + k + '"]').isDisabled(), k + ' terkunci');
        for (const k of ['bppu', 'bpnr', 'bp26', 'bpatc']) assert.ok(!(await page.locator('.tile[data-val="' + k + '"]').isDisabled()), k + ' terbuka');
        assert.ok((await text('.tile[data-val="bpa1"]')).includes('BPA1'));
    });
    await test('Unduh e-Faktur: 8 jenis dokumen, bawaan Pajak Masukan + Excel; kirim jenis, format, entitas dan masa', async () => {
        await page.click('.nav-item[data-nav="faktur"]');
        await page.waitForSelector('.pp');
        assert.strictEqual(await page.locator('#efaktur-types .chip').count(), 8, 'delapan jenis dokumen e-Faktur');
        assert.strictEqual(await page.locator('#efaktur-types .chip[aria-pressed="true"]').count(), 1, 'bawaan hanya Pajak Masukan');
        await page.click('#efaktur-types .chip[data-val="output"]');
        await page.click('#efaktur-types .chip[data-val="sdInput"]');
        await page.click('[data-act="efmt"][data-val="csv"]');
        await page.click('[data-act="start"]'); await pause(300);
        assert.strictEqual(lastCall().url, '/api/actions/download-efaktur');
        assert.deepStrictEqual(lastCall().body.types.slice().sort(), ['input', 'output', 'sdInput']);
        assert.strictEqual(lastCall().body.excel, true); assert.strictEqual(lastCall().body.csv, true);
        assert.strictEqual(lastCall().body.masaInput, PREV_MMYY);
        assert.strictEqual(lastCall().body.entity.pic_id, 'p-andi');
    });
    await test('Unduh e-Faktur: tombol mulai terkunci bila tak ada jenis dokumen atau format', async () => {
        await page.click('[data-act="enone"]');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'tanpa jenis dokumen');
        await page.click('[data-act="eall"]');
        assert.strictEqual(await page.locator('#efaktur-types .chip[aria-pressed="true"]').count(), 8);
        await page.click('[data-act="efmt"][data-val="excel"]'); await page.click('[data-act="efmt"][data-val="csv"]');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'tanpa format');
        await page.click('[data-act="efmt"][data-val="excel"]');
        assert.ok(!(await page.locator('#abar [data-act="start"]').isDisabled()));
        await shot('21-efaktur');
    });
    await test('Billing: nominal berformat ribuan, masa satu bulan, tombol aktif hanya bila lengkap', async () => {
        await page.click('.nav-item[data-nav="billing"]');
        await page.waitForSelector('#bl-nominal');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'nominal kosong');
        await page.fill('#bl-nominal', '1500000');
        assert.strictEqual(await page.inputValue('#bl-nominal'), '1.500.000');
        assert.ok(!(await page.locator('#abar [data-act="start"]').isDisabled()));
        assert.ok((await text('#abar')).includes('1.500.000'));
        await shot('13-billing');
        await page.click('[data-act="start"]'); await pause(300);
        const c = lastCall();
        assert.strictEqual(c.url, '/api/actions/billing-pph25');
        assert.strictEqual(c.body.nominal, '1500000');
        assert.ok(/^(0[1-9]|1[0-2])\d{2}$/.test(c.body.masaInput));
        assert.strictEqual(c.body.entity.pic_id, 'p-andi');
    });
    await test('Billing di Otomasi: satu bulan saja yang bisa dipilih', async () => {
        assert.strictEqual(await page.locator('.pp .chip[aria-pressed="true"]').count(), 1);
    });
    await test('bilah aksi lengket di setiap halaman fitur (tanpa rail ringkasan kanan); Options hanya folder tujuan', async () => {
        for (const id of ['spt', 'ebupot', 'bpsaya', 'faktur', 'a1', 'dividen', 'kredit', 'billing', 'impor']) {
            await page.click('.nav-item[data-nav="' + id + '"]');
            await page.waitForSelector('#abar .btn-primary'); await pause(300); // animasi masuk halaman (geser 6 px) selesai dulu
            assert.strictEqual(await page.locator('#rail, .rail').count(), 0, id + ': tanpa rail kanan');
            assert.strictEqual(await page.locator('#abar .btn-primary').count(), 1, id + ': tepat satu tombol utama');
            const box = await page.evaluate(() => { const a = document.querySelector('#abar').getBoundingClientRect(), c = document.querySelector('#content').getBoundingClientRect(); return { a: a.bottom, c: c.bottom, w: document.documentElement.scrollWidth, vw: window.innerWidth }; });
            assert.ok(box.a <= box.c + 1, id + ': bilah aksi terlihat di dalam area konten');
            assert.ok(box.w <= box.vw + 1, id + ': tanpa scroll horizontal');
            assert.ok(!/Read-only: nothing is submitted/.test(await text('#content')), id + ': tanpa kalimat Read-only');
        }
        await page.click('.nav-item[data-nav="spt"]');
        await page.waitForSelector('#abar [data-act="start"]');
        assert.ok(await visible('[data-opts]'), 'SPT: Options (folder tujuan) ada');
        await page.click('[data-opts]');
        await page.waitForSelector('#save-root-input', { state: 'visible' });
        assert.strictEqual(await page.locator('[data-act="sus"]').count(), 0, 'pilihan tata letak PDF sudah dihapus');
        assert.deepStrictEqual(await page.locator('.pp [data-pp="quick"]').allInnerTexts(), ['Full year'], 'pintasan Masa Pajak hanya Full year');
        await page.click('[data-opts]');
    });
    await test('e-Bupot Upload, Issue & Sign: tiga tab (Upload e-Bupot / Issue & Sign / Konsep SPT), masing-masing dengan ringkasannya', async () => {
        await page.click('.nav-item[data-nav="impor"]');
        await page.waitForSelector('[data-act="iview"]');
        assert.strictEqual(await text('.topbar h1'), 'e-Bupot Upload, Issue & Sign');
        assert.deepStrictEqual((await page.locator('[data-act="iview"]').allInnerTexts()).map((t) => t.trim()), ['Upload e-Bupot', 'Issue & sign', 'Konsep SPT']);
        assert.strictEqual(await page.locator('[data-act="iview"][data-val="upload"]').getAttribute('aria-pressed'), 'true', 'tab bawaan: Upload e-Bupot');
        assert.ok(await visible('.dropzone'));
        assert.ok((await text('#abar [data-act="start"]')).includes('Upload to Belum Terbit'));
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'belum ada file impor');
        await page.click('[data-act="iview"][data-val="issue"]');
        await page.waitForSelector('[data-act="ipreview"]');
        assert.ok((await text('[data-act="ipreview"]')).includes('Preview Belum Terbit'));
        assert.strictEqual(await page.locator('[data-act="itype"]').count(), 4, 'BPMP, BP21, BPA1, BPPU');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'Issue & Sign terkunci sebelum preview');
        await page.click('[data-act="iview"][data-val="konsep"]');
        await page.waitForSelector('[data-act="kaction"]');
        assert.strictEqual(await page.locator('[data-act="ktype"]').count(), 2, 'PPh 21/26 dan PPh Unifikasi');
        assert.ok((await text('#abar [data-act="start"]')).includes('Create Konsep SPT'));
        await shot('13b-impor');
        await page.click('[data-act="iview"][data-val="upload"]');
        await page.waitForSelector('[data-act="iview"][data-val="upload"][aria-pressed="true"]');
    });

    // ------------------------------------------------ entitas lokal berkredensial - login OTOMATIS
    await test('Alt+K membuka palet yang sama seperti Ctrl+K', async () => {
        await page.keyboard.press('Alt+k');
        await page.waitForSelector('#palette');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    await test('palet: bagian "Sesi Aktif" digabung ke sini (bukan dropdown/dialog terpisah), kosong bila tidak ada jendela terbuka', async () => {
        await page.click('#entity-chip');
        await page.waitForSelector('#palette');
        // Tidak ada sesi terbuka di lingkungan tes ini - bagian "SESI AKTIF" wajar tidak muncul
        // sama sekali (bukan ditampilkan kosong), daftar entitas tetap tampil normal.
        assert.ok(!(await text('#pal-body')).toUpperCase().includes('ACTIVE SESSION'));
        assert.ok(await visible('#pal-body .ent'), 'daftar entitas tetap tampil seperti biasa');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
        // Dialog Pengaturan juga tidak lagi menyebut ini - itu murni soal akun/versi app.
        await page.click('#open-settings');
        await page.waitForSelector('#settings');
        assert.ok(!(await text('#settings')).toLowerCase().includes('active coretax session'));
        assert.ok(!(await page.locator('#btn-sessions').count()), 'tombol topbar terpisah untuk ini sudah dihapus');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settings', { state: 'detached' });
    });
    await test('Pengaturan: Pemeriksaan sistem tampil dengan status & saran, Periksa ulang meminta ?fresh=1, Ekspor diagnostik + peringatan NPWP', async () => {
        // Hasil pemeriksaan & ekspor ditiru di browser: tes ini tidak boleh menyentuh jaringan / Downloads asli.
        const healthUrls = [];
        const rep = (detail) => ({ at: new Date().toISOString(), summary: { ok: 1, warn: 1, fail: 1 }, checks: [
            { id: 'data-root', label: 'Folder data dapat ditulis', status: 'ok', detail, fix: '' },
            { id: 'clock', label: 'Jam PC', status: 'warn', detail: 'Jam PC lebih cepat 5 menit dari jam server.', fix: 'Aktifkan "Atur waktu secara otomatis".' },
            { id: 'hub', label: 'Taxio Hub terjangkau', status: 'fail', detail: 'Taxio Hub tidak terjangkau: <b>x</b>', fix: 'Periksa koneksi internet.' }] });
        await page.route('**/api/health**', (route) => { healthUrls.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rep(healthUrls.length === 1 ? 'C:\\data' : 'C:\\data (ulang)')) }); });
        await page.route('**/api/diagnostics/export', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file: 'C:\\Users\\Budi\\Downloads\\TaxioPilot-diagnostik-1.zip', bytes: 1000, entries: [] }) }));
        try {
            await page.click('#open-settings');
            await page.waitForSelector('#settings .health-row');
            const rows = page.locator('#settings .health-row');
            assert.strictEqual(await rows.count(), 3);
            assert.ok((await rows.nth(1).getAttribute('class')).includes('warn'));
            assert.ok((await rows.nth(2).getAttribute('class')).includes('fail'));
            assert.ok((await rows.nth(1).innerText()).includes('Atur waktu secara otomatis'), 'saran tampil untuk warn');
            assert.ok(!(await rows.nth(0).innerText()).includes('Saran'), 'ok tanpa saran');
            assert.ok((await rows.nth(2).innerText()).includes('<b>x</b>'), 'detail di-escape, bukan HTML');
            assert.ok(/NPWP/.test(await text('#diag-text')));
            await page.click('#settings [data-x="health"]');
            await page.waitForFunction(() => document.querySelector('#health-list').textContent.includes('(ulang)'));
            assert.ok(/fresh=1/.test(healthUrls[healthUrls.length - 1]));
            await page.click('#settings [data-x="diag"]');
            await page.waitForFunction(() => document.querySelector('#diag-text').textContent.includes('TaxioPilot-diagnostik-1.zip'));
            assert.ok(/NPWP/.test(await text('#diag-text')));
            await page.keyboard.press('Escape');
            await page.waitForSelector('#settings', { state: 'detached' });
        } finally { await page.unroute('**/api/health**'); await page.unroute('**/api/diagnostics/export'); }
    });
    await test('tema: bawaan Dark; Settings System / Light / Dark mengganti tema, diingat dan dipasang sebelum paint (tanpa kedipan)', async () => {
        const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        assert.strictEqual(await page.evaluate(() => localStorage.getItem('pilot.theme')), null, 'pengguna baru: belum ada pilihan');
        assert.strictEqual(await theme(), 'dark', 'bawaan pengguna baru = Dark');
        assert.strictEqual(await page.locator('.sidebar [data-x="theme"], .sidebar #theme-quick').count(), 0, 'tanpa tombol tema cepat di sidebar');
        await page.click('#open-settings');
        await page.waitForSelector('#settings [data-x="theme"]');
        assert.deepStrictEqual(await page.locator('#settings [data-x="theme"]').allInnerTexts(), ['System', 'Light', 'Dark']);
        assert.strictEqual(await page.locator('#settings [data-x="theme"][data-val="dark"]').getAttribute('aria-pressed'), 'true');
        await page.click('#settings [data-x="theme"][data-val="light"]');
        await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.strictEqual(bg, 'rgb(247, 248, 250)', 'token terang dipakai');
        assert.strictEqual(await page.evaluate(() => localStorage.getItem('pilot.theme')), '"light"', 'pilihan diingat');
        await page.keyboard.press('Escape');
        // Dipasang sebelum paint pertama: atribut sudah benar saat DOMContentLoaded, sebelum skrip aplikasi apa pun berjalan.
        await page.reload({ waitUntil: 'commit' });
        await page.waitForFunction(() => document.body !== null);
        assert.strictEqual(await theme(), 'light', 'tema terang diterapkan oleh theme-boot.js sebelum paint');
        await page.waitForSelector('#app .sidebar');
        // System mengikuti Windows (prefers-color-scheme), juga langsung saat berubah.
        await page.evaluate(() => localStorage.setItem('pilot.theme', '"system"'));
        await page.emulateMedia({ colorScheme: 'light' }); await page.reload(); await page.waitForSelector('#app .sidebar');
        assert.strictEqual(await theme(), 'light');
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
        await page.click('#open-settings');
        await page.click('#settings [data-x="theme"][data-val="dark"]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settings', { state: 'detached' });
        assert.strictEqual(await page.evaluate(() => localStorage.getItem('pilot.theme')), '"dark"');
        await page.emulateMedia({ colorScheme: null });
        await sessionsGoneThenReselect(); // muat ulang melepas pilihan entitas (tidak ada jendela Coretax): pilih lagi
    });
    await test('sidebar: diciutkan ke rel ikon (tombol, Ctrl+B) dengan tooltip dan badge proses aktif, diingat; otomatis rel di bawah 1100 px; topbar satu baris', async () => {
        const st = () => page.evaluate(() => ({ collapsed: document.querySelector('#app').classList.contains('sb-collapsed'), overlay: document.querySelector('#app').classList.contains('sb-overlay'),
            sbW: document.querySelector('.sidebar').getBoundingClientRect().width, mainL: document.querySelector('.main').getBoundingClientRect().left, store: localStorage.getItem('pilot.sb'),
            topH: document.querySelector('.topbar').getBoundingClientRect().height, scrollW: document.documentElement.scrollWidth, w: window.innerWidth }));
        const s0 = await st();
        assert.ok(!s0.collapsed && s0.sbW >= 220, 'bawaan: sidebar terbuka');
        assert.ok(s0.topH <= 57, 'topbar satu baris (' + s0.topH + ' px)');
        await page.click('.sb-collapse'); await pause(400);
        const s1 = await st();
        assert.ok(s1.collapsed && s1.sbW <= 60 && s1.mainL <= 60, 'diciutkan: rel ikon, konten mengisi lebar');
        assert.strictEqual(s1.store, '"collapsed"', 'diingat');
        assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.nav-item .grow')).opacity), '0', 'label disembunyikan');
        await page.hover('.nav-item[data-nav="ebupot"]'); await pause(250);
        assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.nav-item[data-nav="ebupot"]'), '::after').opacity), '1', 'tooltip label saat diciutkan');
        assert.strictEqual(await page.getAttribute('.nav-item[data-nav="ebupot"]', 'data-tip'), 'e-Bupot');
        // Badge proses aktif tetap terlihat di rel.
        fakes.ctl.run = { active: false, paused: false, label: '', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null, runs: [{ key: 'p-rina', active: true, label: 'e-Bupot BPPU · CV Sample Niaga Mandiri' }], anyActive: true };
        await page.waitForSelector('#sb-runs .nb', { timeout: 5000 });
        assert.strictEqual(await text('#sb-runs .nb'), '1');
        assert.ok((await page.getAttribute('#sb-runs', 'data-tip')).includes('e-Bupot BPPU'));
        fakes.ctl.run = null;
        await page.waitForSelector('#sb-runs', { state: 'detached', timeout: 5000 });
        // Diingat setelah muat ulang (dipasang sebelum paint).
        await page.reload(); await page.waitForSelector('#app .sidebar');
        assert.ok((await st()).collapsed, 'tetap diciutkan setelah muat ulang');
        await page.keyboard.press('Control+b'); await pause(400);
        const s2 = await st();
        assert.ok(!s2.collapsed && s2.store === '"expanded"', 'Ctrl+B membuka lagi dan diingat');
        // Lebar sempit: otomatis rel; dibuka = di atas konten (scrim), konten tidak bergeser.
        await page.setViewportSize({ width: 1000, height: 700 }); await pause(300);
        const s3 = await st();
        assert.ok(s3.collapsed && s3.mainL <= 60, 'di bawah 1100 px otomatis rel');
        await page.click('.brand-logo'); await pause(400);
        const s4 = await st();
        assert.ok(s4.overlay && s4.sbW >= 220 && Math.abs(s4.mainL - s3.mainL) < 2, 'dibuka di atas konten tanpa menggeser');
        assert.ok(s4.topH <= 57 && s4.scrollW <= s4.w + 1, 'topbar satu baris, tanpa scroll horizontal di 1000 px');
        await page.keyboard.press('Escape'); await pause(300);
        assert.ok(!(await st()).overlay, 'Esc menutup sidebar yang melayang');
        assert.strictEqual((await st()).store, '"expanded"', 'lebar sempit tidak mengubah pilihan yang diingat');
        await page.setViewportSize({ width: 1440, height: 900 }); await pause(200);
        await sessionsGoneThenReselect(); // muat ulang melepas pilihan entitas (tidak ada jendela Coretax): pilih lagi
    });
    await test('topbar: tab sesi menampilkan jendela yang benar-benar terbuka, tab entitas terpilih menyala, X menutupnya; tidak terpotong di jendela sempit', async () => {
        fakes.ctl.sessions = [
            { picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: '0123456780910000 · PT CONTOH SEJAHTERA ABADI' },
            { picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }
        ];
        await openWin(); // tab sesi kini di popover "Coretax windows" (meter di topbar)
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 2, null, { timeout: 6000 });
        const tabs = page.locator('.sess-tab');
        assert.ok((await tabs.nth(0).getAttribute('class')).includes('active'), 'tab sesi entitas terpilih (p-andi) menyala');
        assert.ok(!(await tabs.nth(1).getAttribute('class')).includes('active'), 'tab sesi lain tidak menyala');
        assert.ok((await text('.sess-strip')).includes('New session'), 'tombol New session ada');
        // Jendela sempit: semua bagian topbar harus tetap di dalam layar (membungkus, bukan terpotong).
        await page.setViewportSize({ width: 720, height: 800 });
        await pause(200);
        const fit = await page.evaluate(() => {
            const w = window.innerWidth;
            const els = Array.from(document.querySelectorAll('.topbar .title, .topbar .status-pill, #entity-chip, #sess-meter, #sess-win, .sess-tab, .sess-new'));
            return { over: els.filter((e) => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > w + 1; }).map((e) => e.className || e.id), scrollW: document.documentElement.scrollWidth, w };
        });
        assert.deepStrictEqual(fit.over, [], 'tidak ada bagian topbar yang melewati tepi layar');
        assert.ok(fit.scrollW <= fit.w + 1, 'tidak ada scroll horizontal halaman');
        const topH = await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height);
        assert.ok(topH <= 57, 'topbar tetap satu baris (' + topH + ' px)');
        await shot('sesi-tab-sempit');
        await page.setViewportSize({ width: 1440, height: 900 });
        await tabs.nth(1).locator('[data-sess-close]').click();
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 1, null, { timeout: 3000 });
        await sessionsGoneThenReselect();
    });
    await test('tab sesi: klik tab mengaktifkan sesi itu; panah membuka daftar entitas sesi; klik nama berpindah entitas lewat PIC sesi yang sama (tanpa jendela baru)', async () => {
        fakes.ctl.sessions = [
            { picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: '0123456780910000 · PT CONTOH SEJAHTERA ABADI' },
            { picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }
        ];
        await openWin(); // tab sesi kini di popover "Coretax windows" (meter di topbar)
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 2, null, { timeout: 6000 });
        await page.locator('.sess-tab').nth(1).locator('.sess-main').click();
        await page.waitForFunction(() => /MITRA KARYA ABADI/.test((document.querySelector('#entity-chip') || {}).textContent || ''), null, { timeout: 3000 });
        assert.ok((await page.locator('.sess-tab').nth(1).getAttribute('class')).includes('active'), 'sesi yang diklik menyala');
        assert.ok(!(await page.locator('.sess-tab').nth(0).getAttribute('class')).includes('active'), 'hanya satu tab menyala');
        await page.locator('.sess-tab').nth(1).locator('.sess-drop').click();
        await page.waitForSelector('.sess-pop');
        const pop = await text('.sess-pop');
        assert.ok(pop.includes('MITRA KARYA ABADI') && pop.includes('Sample Niaga Mandiri'), 'entitas milik PIC sesi 2 tampil');
        assert.ok(!pop.includes('Contoh Sejahtera Abadi'), 'entitas milik PIC lain tidak tampil');
        const before = calls.length;
        await page.locator('.sp-pick', { hasText: 'Sample Niaga Mandiri' }).click();
        await pause(400);
        assert.strictEqual(await page.locator('.sess-pop').count(), 0, 'daftar tertutup setelah memilih');
        assert.ok((await text('#entity-chip')).includes('Sample Niaga Mandiri'), 'pil topbar = entitas yang dikerjakan');
        const lg = calls.slice(before).find((x) => x.url === '/api/actions/login-entity');
        assert.ok(lg && lg.body.entity.pic_id === 'p-rina', 'berpindah lewat PIC sesi yang sama (jendela yang sama)');
        await pause(4500); // satu putaran polling sesi melihat jendelanya, supaya pelepasan otomatis aktif
        await sessionsGoneThenReselect();
    });
    // ------------------------------------------------ banyak klien (halaman Download)
    const chipNames = () => page.locator('.cchip .cc-tx b').allInnerTexts();
    const addClients = async (names) => {
        await page.click('[data-act="multi-add"]');
        await page.waitForSelector('#palette.scrim .pal-multi');
        for (const n of names) await page.locator('#pal-body .ent-main', { hasText: n }).click();
    };
    const spt3 = async () => { await page.click('.nav-item[data-nav="spt"]'); await page.waitForSelector('.pp'); };
    await test('banyak klien: satu klien = perilaku lama (tanpa batch, tanpa X di chip); "Add clients" ada di halaman Download', async () => {
        await spt3();
        assert.ok(await visible('.for-bar'), 'baris For');
        assert.deepStrictEqual(await chipNames(), ['PT Contoh Sejahtera Abadi']);
        assert.strictEqual(await page.locator('.cc-x').count(), 0, 'satu klien: tanpa X');
        assert.ok((await text('[data-act="multi-add"]')).includes('Add clients'));
        assert.ok(!(await text('#abar')).includes('clients'), 'kalimat satu klien tidak menyebut jumlah klien');
        const before = calls.length;
        await page.click('#abar [data-act="start"]');
        await pause(300);
        assert.ok(!(await visible('#review')), 'satu klien: tanpa dialog tinjau');
        const c = calls.slice(before).filter((x) => x.url === '/api/actions/download-spt');
        assert.strictEqual(c.length, 1);
        assert.ok(!('batch' in c[0].body), 'satu klien: tanpa batch');
        await shot('p5-01-spt-satu-klien');
    });
    await test('banyak klien: palet banyak pilih (kotak centang, cari tetap jalan), 3 klien -> chip, kalimat + tombol memakai jumlah', async () => {
        await addClients(['Sample Niaga']);
        await page.fill('#pal-q', 'budi');
        await page.locator('#pal-body .ent-main', { hasText: 'Budi Contoh' }).click();
        assert.ok(await page.locator('#pal-body .ent-main[aria-checked="true"]').count() >= 1);
        assert.ok((await text('#pal-foot')).includes('Add 2 clients'), await text('#pal-foot'));
        await page.fill('#pal-q', '');
        const own = page.locator('#pal-body .ent-main', { hasText: 'Sejahtera' });
        assert.strictEqual(await own.getAttribute('aria-disabled'), 'true', 'entitas di topbar sudah termasuk');
        assert.strictEqual(await page.locator('#pal-body .pal-add').count(), 0, 'tanpa "Add new entity" di mode ini');
        await shot('p5-02-palet-banyak-pilih');
        await page.click('[data-act="multi-ok"]');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.deepStrictEqual(await chipNames(), ['PT Contoh Sejahtera Abadi', 'CV Sample Niaga Mandiri', 'Budi Contoh Santoso']);
        const bar = await text('#abar');
        assert.ok(bar.includes('3 clients') && /\d+ downloads/.test(bar), bar);
        assert.ok(/^Start \d+ downloads$/.test((await text('#abar [data-act="start"]')).trim()));
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'), 'topbar tetap klien pertama');
        await shot('p5-03-spt-tiga-klien');
    });
    await test('banyak klien: Start membuka dialog tinjau; konfirmasi mengirim satu permintaan per klien dengan batch yang sama lalu membuka Runs', async () => {
        const before = calls.length;
        await page.click('#abar [data-act="start"]');
        await page.waitForSelector('#review .rv-row');
        assert.strictEqual(await page.locator('#review .rv-row').count(), 3);
        const t = await text('#review');
        assert.ok(t.includes('Coretax windows become available'), t);
        assert.ok(t.includes('Sample Niaga') && t.includes('Budi Contoh'), t);
        assert.strictEqual(calls.slice(before).length, 0, 'belum ada yang dikirim sebelum konfirmasi');
        await shot('p5-04-dialog-tinjau');
        await page.click('#review [data-rv="go"]');
        await page.waitForFunction(() => window.Pilot.state.page === 'runs', null, { timeout: 5000 });
        assert.ok(!(await visible('#review')), 'dialog tertutup');
        const c = calls.slice(before).filter((x) => x.url === '/api/actions/download-spt');
        assert.strictEqual(c.length, 3);
        const id = c[0].body.batch.id;
        assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(id));
        assert.deepStrictEqual(c.map((x) => x.body.batch.id), [id, id, id]);
        assert.deepStrictEqual(c.map((x) => [x.body.batch.index, x.body.batch.total]), [[0, 3], [1, 3], [2, 3]]);
        assert.deepStrictEqual(c.map((x) => x.body.entity.entity_id), ['CSA', 'SNM', 'BUDI']);
        assert.ok(/^SPT · Masa Pajak .* for 3 clients$/.test(c[0].body.batch.label), c[0].body.batch.label);
        assert.ok(c.every((x) => !('pics' in x.body.entity) && x.body.jenisPajakKeys.length >= 1), 'badan permintaan sama seperti satu klien');
    });
    await test('banyak klien: klien ber-2-PIC meminta PIC (tidak memakai PIC terakhir), Start terkunci sampai dipilih, PIC terpilih terkirim', async () => {
        await spt3();
        await addClients(['MITRA KARYA']);
        await page.click('[data-act="multi-ok"]');
        await page.waitForSelector('.cchip.pending');
        assert.deepStrictEqual(await page.locator('.cchip.pending .cc-tx b').allInnerTexts(), ['MITRA KARYA ABADI, PT']);
        assert.strictEqual(await page.locator('.cchip.pending select').inputValue(), '', 'belum ada PIC terpilih');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'Start terkunci');
        assert.ok((await text('#abar')).includes('Choose a PIC for MITRA KARYA ABADI, PT'));
        await shot('p5-05-pic-belum-dipilih');
        await page.selectOption('.cchip select[data-multi-pic]', 'p-rina');
        await page.waitForFunction(() => !document.querySelector('.cchip.pending'));
        assert.ok(!(await page.locator('#abar [data-act="start"]').isDisabled()), 'PIC dipilih: Start aktif');
        assert.ok((await text('#abar [data-act="start"]')).includes('Start'));
        const before = calls.length;
        await page.click('#abar [data-act="start"]');
        await page.waitForSelector('#review .rv-row');
        assert.strictEqual(await page.locator('#review .rv-row').count(), 4);
        assert.ok((await text('#review')).includes('PIC RINA WIJAYA'));
        await page.click('#review [data-rv="go"]');
        await page.waitForFunction(() => window.Pilot.state.page === 'runs', null, { timeout: 5000 });
        const c = calls.slice(before).filter((x) => x.url === '/api/actions/download-spt');
        assert.strictEqual(c.length, 4);
        const mka = c.find((x) => x.body.entity.entity_id === 'MKA');
        assert.strictEqual(mka.body.entity.pic_id, 'p-rina');
        assert.deepStrictEqual(c.map((x) => x.body.batch.index), [0, 1, 2, 3]);
        assert.ok(c.every((x) => x.body.batch.total === 4));
    });
    await test('banyak klien: satu klien ditolak (409) tampil di daftar hasil, yang lain tetap jalan; Open Runs membuka Runs', async () => {
        await spt3();
        actionRefuse.SNM = { status: 409, error: 'The same command is already running for this client.' };
        const before = calls.length;
        try {
            await page.click('#abar [data-act="start"]');
            await page.waitForSelector('#review .rv-row');
            await page.click('#review [data-rv="go"]');
            await page.waitForSelector('#review [data-rv="runs"]');
        } finally { delete actionRefuse.SNM; }
        assert.strictEqual(calls.slice(before).filter((x) => x.url === '/api/actions/download-spt').length, 4, 'semua klien dicoba, tidak berhenti di yang gagal');
        assert.strictEqual(await page.locator('#review .rv-st.ok').count(), 3);
        assert.strictEqual(await page.locator('#review .rv-st.bad').count(), 1);
        const bad = await page.locator('#review .rv-row', { has: page.locator('.rv-st.bad') }).innerText();
        assert.ok(bad.includes('Sample Niaga') && bad.includes('already running'), bad);
        assert.ok((await text('#review #rv-hint')).includes('1 client was not started'));
        assert.strictEqual(await page.evaluate(() => window.Pilot.state.page), 'spt', 'belum pindah selama ada yang ditolak');
        await shot('p5-06-dialog-hasil-ditolak');
        await page.click('#review [data-rv="runs"]');
        await page.waitForFunction(() => window.Pilot.state.page === 'runs');
    });
    await test('banyak klien: chip bisa dihapus; menghapus klien pertama menggantikannya di topbar dengan klien berikutnya; e-Bupot/Bukti Potong Saya/e-Faktur juga punya baris For', async () => {
        await spt3();
        await page.locator('.cchip', { hasText: 'Budi Contoh' }).locator('.cc-x').click();
        await page.waitForFunction(() => document.querySelectorAll('.cchip').length === 3);
        for (const id of ['ebupot', 'bpsaya', 'faktur']) {
            await page.click('.nav-item[data-nav="' + id + '"]');
            await page.waitForSelector('.pp');
            assert.strictEqual(await page.locator('.cchip').count(), 3, id + ': klien yang sama');
            assert.ok(await visible('[data-act="multi-add"]'), id);
        }
        await spt3();
        await page.locator('.cchip', { hasText: 'Sejahtera' }).locator('.cc-x').click();
        await page.waitForFunction(() => /Sample Niaga/.test(document.querySelector('#entity-chip').textContent));
        assert.deepStrictEqual(await chipNames(), ['CV Sample Niaga Mandiri', 'MITRA KARYA ABADI, PT']);
        // kembali ke satu klien: Sejahtera dipilih di topbar, tambahan dibuang
        await page.evaluate(() => window.Pilot.multi.clear());
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.strictEqual(await page.locator('.cchip').count(), 1);
    });
    await test('banyak klien: halaman yang mengubah data di Coretax tetap satu klien (tanpa baris For / Add clients)', async () => {
        for (const id of ['billing', 'impor', 'kredit', 'dividen']) {
            await page.click('.nav-item[data-nav="' + id + '"]');
            await pause(150);
            assert.strictEqual(await page.locator('[data-act="multi-add"]').count(), 0, id + ': tanpa Add clients');
            assert.strictEqual(await page.locator('.for-bar').count(), 0, id + ': tanpa baris For');
        }
        await page.click('.nav-item[data-nav="a1"]');
        await pause(150);
        assert.strictEqual(await page.locator('[data-act="multi-add"]').count(), 0, 'Annual PPh 21 Recap tetap satu klien');
        await page.click('.nav-item[data-nav="spt"]');
        await pause(150);
    });
    await test('palet satu entitas (topbar) tetap seperti biasa: tanpa kotak centang', async () => {
        await page.click('#entity-chip');
        await page.waitForSelector('#palette');
        assert.strictEqual(await page.locator('#pal-body .ent-cb').count(), 0);
        assert.ok(await visible('#pal-body .pal-add'));
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    await test('topbar: jendela sesi entitas terpilih hilang -> pilihan otomatis dilepas ("Pilih entitas")', async () => {
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'));
        fakes.ctl.sessions = [{ picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: 'x' }];
        await page.waitForFunction(() => window.Pilot.state.sessions.length === 1, null, { timeout: 6000 });
        await sessionsGoneThenReselect();
    });
    await test('sesi kedaluwarsa ("Belum login"): tombol Login ulang login lagi di jendela PIC yang sama', async () => {
        fakes.ctl.sessions = [{ picId: 'p-andi', kind: 'entity', open: true, loggedIn: false, identity: '' }, { picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0123 · CV Sample Niaga Mandiri' }];
        await openWin(); // tab sesi kini di popover "Coretax windows" (meter di topbar)
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 2, null, { timeout: 6000 });
        const tabs = page.locator('.sess-tab');
        assert.ok((await tabs.nth(0).textContent()).includes('Not logged in'), 'tab sesi kedaluwarsa bertuliskan Not logged in');
        assert.strictEqual(await tabs.nth(0).locator('.sess-relogin').count(), 1, 'tombol Login ulang ada di sesi yang tidak login');
        assert.strictEqual(await tabs.nth(1).locator('.sess-relogin').count(), 0, 'sesi yang masih login tanpa tombol Login ulang');
        await shot('sesi-login-ulang');
        calls.length = 0;
        await tabs.nth(0).locator('.sess-relogin').click();
        await pause(300);
        const lg = calls.find((c) => c.url === '/api/actions/login-entity');
        assert.ok(lg && lg.body.entity.pic_id === 'p-andi' && /Sejahtera/.test(lg.body.entity.entity_name), 'login otomatis entitas terpilih lewat PIC sesi itu');
        // Sesi PIC lain berentitas banyak dan tak terbaca entitasnya: pilih entitas dulu.
        fakes.ctl.sessions = [fakes.ctl.sessions[0], { picId: 'p-rina', kind: 'entity', open: true, loggedIn: false, identity: '' }];
        await page.waitForFunction(() => document.querySelectorAll('.sess-relogin').length === 2, null, { timeout: 6000 });
        calls.length = 0;
        await page.locator('.sess-tab').nth(1).locator('.sess-relogin').click();
        await page.waitForSelector('.sess-pop');
        assert.ok(!calls.some((c) => c.url === '/api/actions/login-entity'), 'tanpa entitas yang jelas, belum ada login sebelum entitas dipilih');
        await page.keyboard.press('Escape');
        await sessionsGoneThenReselect();
    });
    await test('memilih PIC pada entitas Hub ber-PIC banyak langsung memicu login otomatis (tanpa klik Masuk Coretax terpisah)', async () => {
        calls.length = 0;
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#palette');
        await page.locator('#pal-body .ent', { hasText: 'MITRA KARYA ABADI' }).locator('.ent-main').click();
        await page.locator('#pal-body .radio-row').nth(0).click();
        await page.waitForSelector('#palette', { state: 'detached' });
        await pause(200);
        assert.ok(calls.some((c) => c.url === '/api/actions/login-entity' && c.body.entity.pic_id === 'p-andi'), 'login-entity terpicu otomatis setelah memilih PIC');
        // kembalikan pilihan ke PT Contoh Sejahtera Abadi untuk tes-tes berikutnya
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    await test('Sesi baru saat sesi LAIN sedang berjalan: login sesi baru tetap jalan; sesi yang sibuk diberi tahu, tidak diam', async () => {
        // Laporan 2026-10-07: "+ Sesi baru" tidak login sendiri selama ada proses di sesi lain.
        const busy = { key: 'p-rina', tag: 'SNM', label: 'e-Bupot BPPU · CV Sample Niaga Mandiri', active: true, paused: false };
        fakes.ctl.run = (key) => ({ key, active: key === 'p-rina', paused: false, label: key === 'p-rina' ? busy.label : '', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null, runs: [busy], anyActive: true });
        fakes.ctl.sessions = [{ picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0123 · CV Sample Niaga Mandiri' }];
        try {
            await page.waitForFunction(() => (window.Pilot.state.runs || []).length === 1 && window.Pilot.state.sessions.length === 1, null, { timeout: 6000 });
            await openWin(); // tab sesi kini di popover "Coretax windows" (meter di topbar)
            await page.waitForSelector('.sess-tab.busy', { timeout: 4000 });
            assert.ok((await text('.sess-tab.busy')).includes('Running'), 'tab sesi yang sibuk diberi penanda');
            calls.length = 0;
            await page.click('#sess-new');
            await page.waitForSelector('#palette');
            await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
            await page.waitForSelector('#palette', { state: 'detached' });
            await pause(300);
            assert.ok(calls.some((c) => c.url === '/api/actions/login-entity' && c.body.entity.pic_id === 'p-andi'), 'login sesi baru (PIC Andi) tetap dimulai walau sesi Rina sibuk');
            calls.length = 0;
            await page.click('#entity-chip');
            await page.fill('#pal-q', 'sample niaga'); await page.keyboard.press('Enter');
            await page.waitForSelector('#palette', { state: 'detached' });
            await pause(300);
            assert.ok(!calls.some((c) => c.url === '/api/actions/login-entity'), 'sesi yang sedang sibuk tidak dikirimi login kedua');
            assert.ok(/This PIC session is running "e-Bupot BPPU/.test(await page.textContent('body')), 'pengguna diberi tahu kenapa login belum jalan');
        } finally {
            fakes.ctl.run = null; fakes.ctl.sessions = [];
        }
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        await page.waitForFunction(() => !(window.Pilot.state.runs || []).some((r) => r.active), null, { timeout: 6000 });
    });
    await test('tambah entitas Badan: PIC berkredensial sendiri (nama, NPWP, kata sandi); bisa tambah PIC lagi', async () => {
        await page.click('#entity-chip');
        assert.ok(await visible('.pal-add'), 'tombol tambah entitas selalu terlihat, tidak perlu pindah tab');
        assert.ok((await text('#pal-body')).includes('Budi Contoh Santoso'), 'entitas pribadi dari Hub tetap tampil dalam satu daftar gabungan');
        await page.click('.pal-add');
        await page.waitForSelector('#entity-dialog');
        assert.strictEqual(await page.locator('#entity-dialog [data-act="led-type"][data-val="badan"]').getAttribute('aria-pressed'), 'true');
        assert.ok((await text('#entity-dialog')).toUpperCase().includes('REQUIRED, MORE THAN ONE ALLOWED'));
        assert.strictEqual(await page.locator('.pic-form-row').count(), 1, 'satu baris PIC kosong tersedia sejak dialog dibuka');
        await page.fill('#led-name', 'CV Klien Baru Sejahtera');
        await page.fill('#led-npwp', '0678901234560000');
        await page.click('#entity-dialog [data-act="save"]');
        await pause(200);
        assert.ok((await text('#led-error')).length > 0, 'PIC kosong ditolak server');
        await page.fill('[data-pic-field="name"][data-idx="0"]', 'Ani Sample Wijaya');
        await page.fill('[data-pic-field="npwp"][data-idx="0"]', '1111222233334444');
        await page.fill('[data-pic-field="password"][data-idx="0"]', 'sandiAni');
        await page.click('#entity-dialog [data-act="pic-add"]');
        assert.strictEqual(await page.locator('.pic-form-row').count(), 2);
        await page.fill('[data-pic-field="name"][data-idx="1"]', 'Budi Kedua');
        await page.fill('[data-pic-field="npwp"][data-idx="1"]', '5555666677778888');
        await page.fill('[data-pic-field="password"][data-idx="1"]', 'sandiBudi');
        await shot('14-tambah-entitas');
    });
    await test('simpan entitas: terpilih dengan tag OTOMATIS (kredensial tersimpan, bukan lagi MANUAL)', async () => {
        await page.click('#entity-dialog [data-act="save"]');
        await page.waitForSelector('#entity-dialog', { state: 'detached' });
        await pause(200);
        const chip = await text('#entity-chip');
        assert.ok(chip.includes('CV Klien Baru Sejahtera') && chip.includes('AUTO') && chip.includes('PIC Ani Sample Wijaya'));
        await page.click('.nav-item[data-nav="spt"]');
        assert.ok(!(await visible('.banner')), 'tidak ada banner login manual untuk entitas lokal berkredensial');
        assert.ok(!(await page.locator('#abar [data-act="start"]').isDisabled()));
        assert.ok((await text('.status-pill')).includes('Not signed in to Coretax'), 'status login umum, bukan status jendela manual');
        await shot('15-entitas-lokal-otomatis');
    });
    await test('palet: entitas lokal ber-PIC banyak menampilkan pemilih PIC (tanpa label OTOMATIS - dianggap redundan, semua baris di sini otomatis)', async () => {
        await page.click('#entity-chip');
        const row = page.locator('#pal-body .ent', { hasText: 'CV Klien Baru Sejahtera' });
        assert.ok(await row.locator('.pic-chip').isVisible(), 'pemilih PIC tetap tampil');
        assert.strictEqual(await row.locator('.tag.auto').count(), 0, 'label OTOMATIS sudah dihapus dari baris palet');
        assert.strictEqual(await page.locator('#pal-body .ent-main button').count(), 0, 'tidak ada <button> di dalam <button> (merusak tata letak baris)');
        await row.hover();
        const main = await row.locator('.ent-main').boundingBox(), acts = await row.locator('.ent-actions').boundingBox();
        assert.ok(main && acts && acts.x >= main.x + main.width - 1, 'tombol ubah/hapus berada di KANAN baris, bukan menumpuk di bawah teks');
        await shot('20-baris-lokal');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
    });
    await test('memilih entitas lokal ber-PIC banyak (Enter) membuka pilihan PIC juga; memilih PIC memicu login otomatis', async () => {
        calls.length = 0;
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'klien baru');
        await page.keyboard.press('Enter');
        assert.ok(await visible('#palette'), 'Enter pada entitas lokal 2 PIC tidak boleh menutup palet - sama seperti entitas Hub');
        const radios = page.locator('#pal-body .radio-row');
        assert.strictEqual(await radios.count(), 2, 'Enter harus membuka pilihan PIC, bukan langsung memakai PIC utama');
        await radios.first().click();
        await page.waitForSelector('#palette', { state: 'detached' });
        await pause(200);
        const loginCall = calls.find((c) => c.url === '/api/actions/login-entity');
        assert.ok(loginCall, 'memilih PIC memicu login otomatis');
        assert.strictEqual(loginCall.body.entity.project, 'local');
        assert.ok(/^lp_[0-9a-f]+$/.test(loginCall.body.entity.pic_id), 'PIC asli (id PIC lokal) terkirim ke login-entity');
    });
    await test('semua fitur berjalan lewat entitas lokal (login otomatis): SPT, Kreditkan Faktur, Billing', async () => {
        await page.click('.nav-item[data-nav="spt"]');
        await page.click('[data-act="start"]'); await pause(300);
        let c = lastCall();
        assert.strictEqual(c.url, '/api/actions/download-spt');
        assert.strictEqual(c.body.entity.project, 'local');
        assert.ok(c.body.entity.local_id);
        assert.strictEqual(c.body.entity.individual, false);

        await page.click('.nav-item[data-nav="kredit"]');
        await page.waitForSelector('.dropzone');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'belum ada file');
        await page.click('[data-act="pick-file"]');
        await page.waitForSelector('.dropzone.filled');
        assert.ok((await text('.dropzone')).includes('faktur-uji.xlsx'));
        await page.click('[data-act="kmode"][data-val="fixed"]');
        await page.click('[data-act="start"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/import-pajak-masukan');
        assert.strictEqual(c.body.entity.project, 'local');
        assert.strictEqual(c.body.fileBase64, 'AAAA');
        assert.strictEqual(c.body.targetMasaInput, PREV_MMYY);
        await shot('17-kredit');

        await page.click('.nav-item[data-nav="billing"]');
        await page.fill('#bl-nominal', '250000');
        await page.click('[data-act="start"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/billing-pph25');
        assert.strictEqual(c.body.entity.project, 'local');
        assert.strictEqual(c.body.nominal, '250000');

        // Dividen juga login otomatis lewat kredensial tersimpan - tanpa menunggu login manual.
        await page.click('.nav-item[data-nav="dividen"]');
        await page.waitForSelector('.dropzone');
        assert.ok(!(await page.locator('.col-main .banner').count()), 'entitas berkredensial: tanpa banner login manual / pilih entitas');
        assert.ok((await text('#abar')).includes('Automatic · PIC'), 'ringkasan menyebut login otomatis');
        assert.ok(!(await page.locator('[data-act="create-case"]').isDisabled()), 'buat kasus tidak menunggu login manual');
        await page.click('[data-act="create-case"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/create-dividen-case');
        assert.strictEqual(c.body.entity.project, 'local');
        if (!(await page.locator('.dropzone.filled').count())) { await page.click('[data-act="pick-file"]'); await page.waitForSelector('.dropzone.filled'); }
        assert.ok(!(await page.locator('[data-act="import"]').isDisabled()), 'impor aktif tanpa login manual');
        await page.click('[data-act="import"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/import-dividen');
        assert.strictEqual(c.body.entity.project, 'local');
        assert.strictEqual(c.body.fileBase64, 'AAAA');

        // Mode A1 = Unduh setahun + Pembetulan NIK BPMP dalam satu halaman.
        await page.click('.nav-item[data-nav="a1"]');
        await page.waitForSelector('[data-act="a1view"][data-val="nik"]');
        await page.click('[data-act="a1view"][data-val="nik"]');
        await page.waitForSelector('.dropzone');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled(), 'pembetulan: belum ada Excel');
        await page.click('[data-act="pick-file"]'); await page.waitForSelector('.dropzone.filled');
        assert.ok(!(await page.locator('[data-act="bmode"]').count()), 'satu tombol saja: Betulkan (cek sudah otomatis per bukti potong)');
        assert.ok((await text('#abar [data-act="start"]')).includes('Correct in Coretax'));
        const n = calls.length;
        page.once('dialog', (dlg) => dlg.dismiss());
        await page.click('#abar [data-act="start"]'); await pause(300);
        assert.strictEqual(calls.length, n, 'dibatalkan di dialog konfirmasi -> tidak ada permintaan');
        page.once('dialog', (dlg) => dlg.accept());
        await page.click('#abar [data-act="start"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/bpmp-amend');
        assert.strictEqual(c.body.submit, true);
        assert.strictEqual(c.body.fileBase64, 'AAAA');
        assert.ok(/^20\d{2}$/.test(c.body.year));

        // "Pakai rekap terakhir": Excel hasil tab Unduh setahun dikirim lewat path-nya (tanpa template terpisah).
        await page.route('**/api/a1/inspect', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ excel: 'C:\\A1\\Mode A1 - 2026.xlsx', rows: [{ masa: 'Januari', excel: { revision: 0, data: 'Lengkap' }, cache: null, pdf: true }, { masa: 'Februari', excel: null, cache: null, pdf: false }] }) }));
        await page.click('[data-act="nik-latest"]'); await page.waitForFunction(() => /Mode A1 - 2026\.xlsx/.test(document.querySelector('.dropzone')?.innerText || ''));
        page.once('dialog', (dlg) => dlg.accept());
        await page.click('#abar [data-act="start"]'); await pause(300);
        assert.strictEqual(lastCall().url, '/api/actions/bpmp-amend');
        assert.strictEqual(lastCall().body.filePath, 'C:\\A1\\Mode A1 - 2026.xlsx');
        assert.ok(!lastCall().body.fileBase64);

        // Unduh setahun: hasil sebelumnya diperiksa per masa sebelum mulai.
        await page.click('[data-act="a1view"][data-val="unduh"]');
        await page.waitForSelector('[data-act="a1src-check"]');
        await page.click('[data-act="a1src-check"]');
        await page.waitForSelector('.mini-table');
        const tbl = await text('.mini-table');
        assert.ok(/Januari[\s\S]*Old Excel[\s\S]*Reuse/.test(tbl) && /Februari[\s\S]*Download/.test(tbl), 'tabel status per masa');
        await page.click('#abar [data-act="start"]'); await pause(300);
        c = lastCall();
        assert.strictEqual(c.url, '/api/actions/download-spt');
        assert.ok(c.body.a1Year && c.body.a1Fresh === false && c.body.a1Source === undefined);
        await page.unroute('**/api/a1/inspect');
    });
    await test('login manual POLOS (Buka Coretax) tetap ada, terpisah dari entitas lokal berkredensial', async () => {
        fakes.ctl.manual.loggedIn = false; fakes.ctl.manual.identity = '';
        await page.evaluate(() => window.Pilot.manual.poll());
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'lestari');
        await page.click('[data-act="use-manual"]');
        await page.waitForSelector('#palette', { state: 'detached' });
        const chip = await text('#entity-chip');
        assert.ok(chip.includes('MITRA LESTARI UTAMA') && chip.includes('MANUAL'), 'sesi manual polos tetap memakai tag MANUAL, bukan OTOMATIS');
        assert.ok(await visible('#btn-open-coretax') && await visible('#btn-check-session'), 'tombol Buka Coretax/Periksa sesi (login manual lama) tetap ada');
        await page.click('.nav-item[data-nav="spt"]');
        await page.waitForFunction(() => /Coretax not opened yet/.test(document.querySelector('.status-pill')?.innerText || ''), null, { timeout: 3000 });
        const banner = await text('.banner');
        assert.ok(banner.includes('Coretax opens in a separate window'), 'banner login manual polos tetap ada untuk jalur ini');
        assert.ok(await page.locator('#abar [data-act="start"]').isDisabled());
    });
    await test('Dividen lewat entitas MANUAL (login manual polos): banner sesi terdeteksi, impor mengirim file + entitas manual', async () => {
        // Dividen kini memakai entitas terpilih seperti halaman lain; entitas MANUAL (MITRA LESTARI,
        // dari tes sebelumnya) memakai jendela Coretax yang di-login sendiri - simulasikan sudah login.
        fakes.ctl.manual.loggedIn = true; fakes.ctl.manual.identity = '0678901234560000 · SESI MANUAL UJI';
        await page.evaluate(() => window.Pilot.manual.poll());
        await page.waitForFunction(() => /Manual login active/.test(document.querySelector('.status-pill')?.innerText || ''), null, { timeout: 3000 });
        await page.click('.nav-item[data-nav="dividen"]');
        await page.waitForSelector('.dropzone');
        assert.ok(!(await text('.col-main')).includes('No entity selected'));
        assert.ok((await text('.col-main .banner')).includes('Coretax session detected'), 'sesi manual terdeteksi');
        assert.ok((await text('#abar')).includes('Manual · open session'), 'sesi manual: tanpa login otomatis');
        // File yang dipilih di tes entitas lokal tetap diingat halaman Dividen.
        if (!(await page.locator('.dropzone.filled').count())) {
            assert.ok(await page.locator('[data-act="import"]').isDisabled(), 'belum ada file');
            await page.click('[data-act="pick-file"]');
            await page.waitForSelector('.dropzone.filled');
        }
        assert.ok(!(await page.locator('[data-act="import"]').isDisabled()));
        await page.click('[data-act="import"]'); await pause(300);
        assert.strictEqual(lastCall().url, '/api/actions/import-dividen');
        assert.strictEqual(lastCall().body.fileName, 'faktur-uji.xlsx');
        assert.strictEqual(lastCall().body.entity.project, 'manual', 'entitas manual terpilih ikut dikirim');
        assert.strictEqual(lastCall().body.entity.entity_name, 'MITRA LESTARI UTAMA, PT');
    });
    await test('entitas lokal dapat diubah lewat dialog yang sama; NPWP tiap PIC ikut ditampilkan (bukan rahasia)', async () => {
        await page.click('#entity-chip');
        const row = page.locator('#pal-body .ent', { hasText: 'CV Klien Baru Sejahtera' });
        await row.hover();
        await row.locator('[data-act="edit"]').click();
        await page.waitForSelector('#entity-dialog');
        assert.strictEqual(await page.inputValue('#led-name'), 'CV Klien Baru Sejahtera');
        assert.strictEqual(await page.locator('.pic-form-row').count(), 2);
        assert.strictEqual(await page.inputValue('[data-pic-field="name"][data-idx="0"]'), 'Ani Sample Wijaya');
        assert.strictEqual(await page.inputValue('[data-pic-field="npwp"][data-idx="0"]'), '1111222233334444');
        assert.strictEqual(await page.inputValue('[data-pic-field="password"][data-idx="0"]'), '', 'kata sandi lama tidak pernah ditampilkan ulang');
        await page.click('#entity-dialog [data-act="close"]');
    });

    // ------------------------------------------------ tampilan proses
    await test('proses berjalan: antrean per masa, progres, kontrol; keputusan saat ditahan', async () => {
        fakes.ctl.run = {
            active: true, paused: true, label: 'SPT pph21 · CV Klien Baru Sejahtera', currentPageSize: 50, coretaxAs: '067890123456000 · ANI SAMPLE WIJAYA',
            jenisRequested: ['pph21', 'unifikasi'], jenisTally: { pph21: { ok: 5, fail: 0 }, unifikasi: { ok: 1, fail: 1 } },
            holdReason: 'Tabel lampiran tidak terbaca sebelum batas waktu',
            plan: { items: ['0126', '0226', '0326', '0426', '0526'].map((m) => ({ label: 'PPh 21/26 / ' + m, short: m })), states: ['ok', 'ok', 'hold', 'wait', 'wait'], index: 2 }
        };
        await page.waitForSelector('.qpill', { timeout: 5000 });
        assert.strictEqual(await page.locator('.qpill').count(), 5);
        assert.strictEqual(await page.locator('.qpill.ok').count(), 2);
        assert.strictEqual(await page.locator('.qpill.hold').count(), 1);
        assert.ok((await text('.banner.warn')).includes('Process on hold'));
        assert.ok((await text('.banner.warn')).includes('Tabel lampiran tidak terbaca'));
        assert.strictEqual(await text('.big-num b'), '2');
        assert.ok((await text('.big-num')).includes('/ 5'));
        assert.ok((await text('.tally')).includes('PPh Unifikasi · 1 ok, 1 failed'));
        // Keputusan pemilik 2026-11-13: ukuran halaman dan Mundur tidak ditawarkan; Coba lagi / Lewati hanya saat ditahan.
        assert.strictEqual(await page.locator('[data-run-size]').count(), 0, 'tanpa pilihan baris per halaman');
        assert.strictEqual(await page.locator('[data-run="back"]').count(), 0, 'tanpa Back');
        assert.strictEqual(await page.locator('.ctl-grid [data-run="skip"], .ctl-grid [data-run="retry"]').count(), 0, 'Skip / Retry bukan tombol tetap');
        assert.ok((await text('.banner.warn')).includes('Try again'));
        assert.ok((await text('.banner.warn')).includes('Skip PPh 21/26 / 0326'), 'Lewati menyebut kombinasi yang dilewati');
        assert.ok((await text('.status-pill')).includes('Running'));
        await shot('18-berjalan');
    });
    await test('kontrol proses: Coba lagi, Lewati (saat ditahan), Jeda/Lanjut dan Hentikan menghubungi server', async () => {
        fakes.ctl.runCalls.length = 0;
        await page.click('.banner.warn [data-run="retry"]'); await pause(150);
        await page.click('.banner.warn [data-run="skip"]'); await pause(150);
        await page.click('.ctl-grid [data-run="pause"]'); await pause(150); // paused=true -> Lanjut -> resume
        page.once('dialog', (d) => d.accept());
        await page.click('#abar [data-run="stop"]'); await pause(200);
        assert.deepStrictEqual(fakes.ctl.runCalls, ['retry', 'skip', 'resume', 'stop']);
    });
    await test('kontrol menurut fitur: hanya Stop + Jeda; "Stopping…" / "Pausing…" sampai titik aman berikutnya', async () => {
        const base = { active: true, label: 'Faktur Masukan crediting · CV Klien Baru Sejahtera', jenisRequested: [], jenisTally: {}, holdReason: '', plan: null, controls: { stop: true, pause: true, skip: false, retry: false, back: false, pageSize: false } };
        fakes.ctl.run = Object.assign({}, base, { paused: true, pauseRequested: true, stopRequested: false });
        // Tetap aktif sesudahnya: tes berikutnya menguji peralihan aktif -> selesai.
        {
            await page.waitForFunction(() => /Pausing…/.test(document.body.innerText), null, { timeout: 5000 });
            assert.strictEqual(await page.locator('[data-run="skip"], [data-run="retry"], [data-run="back"], [data-run-size]').count(), 0);
            assert.ok((await text('.ctl-grid')).includes('Pausing…'));
            fakes.ctl.run = Object.assign({}, base, { paused: false, pauseRequested: false, stopRequested: true });
            await page.waitForFunction(() => /Stopping…/.test(document.body.innerText), null, { timeout: 5000 });
            assert.ok(await page.locator('#abar [data-run="stop"]').isDisabled(), 'Stop tidak bisa diklik dua kali');
            fakes.ctl.run = Object.assign({}, base, { paused: false, controls: Object.assign({}, base.controls, { pause: false }) });
            await page.waitForFunction(() => !/Stopping…/.test(document.body.innerText), null, { timeout: 5000 });
            assert.strictEqual(await page.locator('[data-run="pause"]').count(), 0, 'fitur tanpa Jeda: tombol Jeda tidak ditampilkan');
            assert.strictEqual(await page.locator('#abar [data-run="stop"]').count(), 1);
        }
    });
    await test('proses selesai: kembali ke halaman dengan ringkasan hasil yang bisa ditutup', async () => {
        fakes.ctl.run = { active: false, paused: false, label: '', jenisRequested: ['pph21'], jenisTally: { pph21: { ok: 5, fail: 0 } }, plan: { items: [{ label: 'a', short: '0126' }, { label: 'b', short: '0226' }], states: ['ok', 'skip'], index: 1 } };
        await page.waitForSelector('.qpill', { state: 'detached', timeout: 5000 });
        await page.waitForSelector('.banner [data-dismiss-run]', { timeout: 5000 });
        assert.ok((await text('.content .banner')).includes('1 done, 1 skipped'));
        await page.click('[data-dismiss-run]');
        assert.ok(!(await visible('[data-dismiss-run]')));
        fakes.ctl.run = null;
    });
    await test('beberapa jendela per PIC: tab bernomor, proses antre tampil (pil + tampilan), Start another command, Batalkan antrean', async () => {
        fakes.ctl.sessions = [
            { picId: 'p-andi', pool: 'p-andi', windowNo: 1, kind: 'entity', open: true, loggedIn: true, identity: '0123456780910000 · PT Contoh Sejahtera Abadi', entityId: 'CSA' },
            { picId: 'p-andi~2', pool: 'p-andi', windowNo: 2, kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI', entityId: 'MKA' }
        ];
        const queued = { key: 'run:9', id: 9, pool: 'p-andi', entity: 'CSA', tag: 'CSA', label: 'SPT pph21 · PT Contoh Sejahtera Abadi', active: true, queued: true, position: 1, waitReason: 'busy' };
        fakes.ctl.run = () => Object.assign({ jenisRequested: [], jenisTally: {}, holdReason: '', plan: null, paused: false, runs: [queued], anyActive: true }, queued);
        try {
            await openWin(); // tab sesi kini di popover "Coretax windows" (meter di topbar)
            await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 2, null, { timeout: 6000 });
            const strip = await text('.sess-strip');
            assert.ok(strip.includes('#1') && strip.includes('#2'), 'jendela PIC yang sama bernomor: ' + strip);
            await page.waitForSelector('.sess-queue', { timeout: 4000 });
            assert.ok((await text('.sess-queue')).includes('1 queued'));
            await page.waitForSelector('#abar [data-run-hide]', { timeout: 4000 });
            assert.ok((await text('.content')).includes('Queued') && (await text('.content')).includes('Position 1'));
            await page.click('#abar [data-run-hide]');
            await page.waitForSelector('[data-run-show]', { timeout: 4000 });
            assert.ok((await text('.run-back')).includes('queued'), 'halaman fitur tampil dengan penanda proses yang antre');
            await page.click('[data-run-show]');
            await page.waitForSelector('#abar [data-run="stop"]', { timeout: 4000 });
            fakes.ctl.runCalls.length = 0;
            page.once('dialog', (d) => d.accept());
            await page.click('#abar [data-run="stop"]'); await pause(200);
            assert.deepStrictEqual(fakes.ctl.runCalls, ['stop']);
        } finally { fakes.ctl.run = null; fakes.ctl.sessions = []; }
        await page.waitForSelector('.sess-queue', { state: 'detached', timeout: 6000 });
    });

    // ------------------------------------------------ log
    await test('log aktivitas: dock terlipat memuat baris terakhir, dapat dibuka', async () => {
        assert.ok((await text('#dock-last')).length > 0);
        await page.click('#dock-toggle');
        assert.ok(await page.locator('#dock.open').isVisible());
        assert.ok(await page.locator('#log-view .log-line').count() > 0);
        await shot('19-log');
        await page.click('#dock-toggle');
    });
    await test('log dock: baris layout yang mendorong konten (tidak menimpa formulir), tertutup = satu baris, status & tinggi diingat', async () => {
        await page.click('.nav-item[data-nav="spt"]');
        await page.waitForSelector('#abar [data-act="start"]'); await pause(300);
        const geo = () => page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { content: r('#content').bottom, abar: r('#abar').bottom, dockTop: r('#dock').top, dockH: r('#dock').height, vh: window.innerHeight }; });
        const closed = await geo();
        assert.ok(closed.dockH <= 48, 'tertutup: satu baris (' + closed.dockH + ' px)');
        assert.ok(closed.abar <= closed.dockTop + 1 && closed.content <= closed.dockTop + 1, 'tertutup: konten & bilah aksi di atas strip log');
        await page.click('#dock-toggle');
        await page.waitForSelector('#dock.open');
        const open = await geo();
        assert.ok(open.dockH > 100, 'terbuka: panel log');
        assert.ok(open.content <= open.dockTop + 1, 'terbuka: area konten berakhir di atas log (tidak ditimpa)');
        assert.ok(open.abar <= open.dockTop + 1, 'terbuka: tombol utama tetap terlihat di atas log');
        assert.ok(await page.locator('#abar [data-act="start"]').isVisible());
        assert.strictEqual(await page.evaluate(() => localStorage.getItem('pilot.logOpen')), 'true', 'status terbuka diingat');
        // Seret tepi atas: tinggi berubah dan diingat.
        const g = await page.locator('#dock-resize').boundingBox();
        await page.mouse.move(g.x + 200, g.y + 4); await page.mouse.down(); await page.mouse.move(g.x + 200, g.y - 60, { steps: 4 }); await page.mouse.up();
        const after = await geo();
        assert.ok(after.dockH > open.dockH + 30, 'tinggi log bisa diubah dengan menyeret');
        assert.ok(Number(await page.evaluate(() => localStorage.getItem('pilot.logH'))) > open.dockH, 'tinggi diingat');
        await page.click('#dock-toggle');
        await page.waitForFunction(() => !document.querySelector('#dock').classList.contains('open'));
    });

    await test('tambah entitas dengan 1 PIC: langsung login otomatis setelah disimpan (tidak perlu pilih ulang)', async () => {
        await page.click('#entity-chip');
        await page.click('.pal-add');
        await page.waitForSelector('#entity-dialog');
        await page.fill('#led-name', 'CV Satu PIC Contoh');
        await page.fill('#led-npwp', '0678901234560001');
        await page.fill('[data-pic-field="name"][data-idx="0"]', 'Rani Contoh');
        await page.fill('[data-pic-field="npwp"][data-idx="0"]', '1111222233335555');
        await page.fill('[data-pic-field="password"][data-idx="0"]', 'sandiRani');
        const loginReq = page.waitForRequest((r) => r.url().includes('/api/actions/login-entity'), { timeout: 4000 });
        await page.click('#entity-dialog [data-act="save"]');
        const req = await loginReq;
        assert.ok(JSON.parse(req.postData()).entity.entity_name.includes('CV Satu PIC Contoh'));
        await pause(300);
    });

    await test('pilihan entitas hasil pemulihan (muat ulang) dilepas bila tak ada jendela Coretax-nya, dipertahankan bila jendelanya masih terbuka', async () => {
        const restore = async (sessions) => {
            fakes.ctl.sessions = sessions;
            await page.evaluate(() => localStorage.setItem('pilot.sel', JSON.stringify({ key: 'taxio_hub|MKA', picId: 'p-andi', name: 'MITRA KARYA ABADI, PT' })));
            await page.reload();
            await page.waitForSelector('#app .sidebar');
        };
        // Tanpa jendela: sempat tampil dari ingatan, lalu dilepas oleh polling sesi (tidak "nyangkut").
        await restore([]);
        await page.waitForFunction(() => /Select entity/.test((document.querySelector('#entity-chip') || {}).textContent || ''), null, { timeout: 8000 });
        // Dengan jendela PIC-nya masih terbuka: pilihan dipertahankan melewati beberapa kali polling.
        await restore([{ picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }]);
        await page.waitForTimeout(5500);
        assert.ok((await text('#entity-chip')).includes('MITRA KARYA ABADI'), 'pilihan tetap bila sesinya masih terbuka');
        fakes.ctl.sessions = [];
        await page.evaluate(() => localStorage.removeItem('pilot.sel'));
        await page.reload();
        await page.waitForSelector('#app .sidebar');
    });

    // ------------------------------------------------ halaman Runs
    // /api/runs dan route kontrol dijawab dari data tiruan (scripts/gui-test-runs-fixture.js) dan dicatat di `rcalls`;
    // kabar SSE 'runs' dikirim lewat lib/ui-events seperti server sungguhan.
    const runsFx = require('./gui-test-runs-fixture');
    const uiEvents = require('../lib/ui-events');
    let runsData = runsFx.runsFixture();
    const rcalls = [];
    const runsRouteMatcher = (u) => /^\/api\/runs(\/|$)|^\/api\/run\/(pause|resume|stop|retry|skip)$/.test(u.pathname);
    await page.route(runsRouteMatcher, async (route) => {
        const req = route.request(), u = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (req.method() === 'GET' && u.pathname === '/api/runs') return json(200, runsData);
        const m = /^\/api\/runs\/(.+)$/.exec(u.pathname);
        if (req.method() === 'GET' && m) { const d = runsFx.runDetail(runsData, decodeURIComponent(m[1])); return d ? json(200, d) : json(404, { error: 'tidak ada' }); }
        rcalls.push({ path: u.pathname, session: u.searchParams.get('session'), body: req.postData() ? JSON.parse(req.postData()) : null });
        return json(200, { ok: true });
    });
    const acceptDialogs = (d) => d.accept();
    page.on('dialog', acceptDialogs);
    const pushRuns = async (data) => { if (data) runsData = data; uiEvents.emit('runs'); };
    const row = (key) => page.locator('[data-flip="' + key + '"]');
    const waitCall = async (n) => { for (let i = 0; i < 40 && rcalls.length <= n; i++) await pause(50); assert.ok(rcalls.length > n, 'permintaan terkirim'); return rcalls[rcalls.length - 1]; };
    const clickCall = async (selector) => { const n = rcalls.length; await page.click(selector); return waitCall(n); };

    await test('Runs: item pertama sidebar (di atas Download) dengan lencana kuning = proses yang menunggu keputusan', async () => {
        await pushRuns();
        await page.waitForSelector('#nav-runs-badge');
        const first = await page.locator('.sb-nav .nav-item').first().getAttribute('data-nav');
        assert.strictEqual(first, 'runs');
        assert.ok((await text('.sb-nav .nav-item[data-nav="runs"]')).includes('Runs'));
        assert.strictEqual(await page.locator('.sb-nav .nav-group').first().locator('.nav-title').count(), 0, 'grup Runs tanpa judul');
        assert.strictEqual((await text('#nav-runs-badge')).trim(), '1');
        assert.ok(/warn/.test(await page.locator('#nav-runs-badge').getAttribute('class')));
        assert.ok((await page.locator('#nav-runs-badge').getAttribute('title')).includes('1 run needs your decision'));
        await page.keyboard.press('Control+b');
        await pause(350);
        assert.ok(await visible('.sb-nav .nav-item[data-nav="runs"] .nb'), 'lencana tampil di rel ikon');
        await shot('60-runs-nav-rail');
        await page.keyboard.press('Control+b');
        await pause(350);
    });
    await test('Runs: tiga bagian (Needs You / In Progress / Done) dengan baris yang benar; batch menjadi satu baris', async () => {
        await page.click('.nav-item[data-nav="runs"]');
        await page.waitForSelector('[data-sec="needs"]');
        assert.deepStrictEqual(await page.locator('.rn-sec').evaluateAll((els) => els.map((e) => e.dataset.sec)), ['needs', 'prog', 'done']);
        assert.deepStrictEqual(await page.locator('.rn-sec-h h2').allInnerTexts(), ['Needs You', 'In Progress', 'Done']);
        assert.deepStrictEqual(await page.locator('.rn-sec-h .rn-count').allInnerTexts(), ['1', '5', '4']);
        const keys = (sec) => page.locator('[data-sec="' + sec + '"] .rn-list > .rn-row').evaluateAll((els) => els.map((e) => e.dataset.flip));
        assert.deepStrictEqual(await keys('needs'), ['run:101']);
        assert.deepStrictEqual(await keys('prog'), ['run:102', 'run:103', 'run:106', 'batch:b-masa-1026', 'run:104']);
        assert.deepStrictEqual(await keys('done'), ['run:110', 'run:111', 'run:112', 'batch:b-old']);
        assert.strictEqual(await page.locator('.rn-subs').count(), 0, 'baris batch tertutup dulu');
        await shot('61-runs-page');
    });
    await test('Runs: baris Needs You menampilkan masalah dan pilihan dari hold.choices; tiap pilihan memanggil route kontrol dengan run:<id>', async () => {
        const r = row('run:101');
        const t = await r.innerText();
        assert.ok(t.includes('PT Contoh Sejahtera Abadi') && t.includes('PIC ANDI #1'), t);
        assert.ok(t.includes('The Lampiran table for 04/2026 could not be read before the time limit'));
        assert.deepStrictEqual(await r.locator('.rn-choices .btn').allInnerTexts(), ['Try again', 'Skip PPh 21/26 / 0426', 'Stop']);
        assert.ok(t.includes('3 of 10'));
        let c = await clickCall('[data-flip="run:101"] [data-rn-act="retry"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/retry', 'run:101']);
        c = await clickCall('[data-flip="run:101"] [data-rn-act="skip"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/skip', 'run:101']);
        c = await clickCall('[data-flip="run:101"] [data-rn-act="stop"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/stop', 'run:101']);
    });
    await test('Runs: In Progress memuat berjalan, dijeda, berhenti dulu, dan antre; hanya Pause/Resume + Stop; catatan antre', async () => {
        const run = row('run:102'), t = await run.innerText();
        assert.ok(t.includes('MITRA KARYA ABADI, PT') && t.includes('PIC ANDI #2') && t.includes('4 of 12') && t.includes('0526'), t);
        assert.deepStrictEqual(await run.locator('.rn-ctl .btn').allInnerTexts(), ['Pause', 'Stop']);
        assert.deepStrictEqual(await row('run:103').locator('.rn-ctl .btn').allInnerTexts(), ['Resume', 'Stop']);
        const stopping = row('run:106');
        assert.ok((await stopping.innerText()).includes('Stopping…'));
        assert.strictEqual(await stopping.locator('[data-rn-act]').count(), 0, 'tidak ada tombol saat berhenti');
        const q = row('run:104');
        assert.strictEqual((await q.locator('.rn-note').innerText()).trim(), 'Waiting · #2 in line');
        assert.ok((await q.locator('.rn-note').getAttribute('title')).includes('All Coretax windows of this PIC are in use'));
        assert.strictEqual(await q.locator('[data-rn-act="stop"]').getAttribute('aria-label'), 'Cancel this queued run');
        let c = await clickCall('[data-flip="run:102"] [data-rn-act="pause"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/pause', 'run:102']);
        c = await clickCall('[data-flip="run:103"] [data-rn-act="resume"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/resume', 'run:103']);
        c = await clickCall('[data-flip="run:102"] [data-rn-act="stop"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/stop', 'run:102']);
        c = await clickCall('[data-flip="run:104"] [data-rn-act="stop"]');
        assert.deepStrictEqual([c.path, c.session], ['/api/run/stop', 'run:104']);
        const d = runsFx.runsFixture(); d.inProgress[0].pauseRequested = true;
        await pushRuns(d);
        await page.waitForFunction(() => /Pausing…/.test((document.querySelector('[data-flip="run:102"] .rn-ctl') || {}).textContent || ''));
        await pushRuns(runsFx.runsFixture());
        await page.waitForFunction(() => !/Pausing…/.test((document.querySelector('[data-flip="run:102"] .rn-ctl') || {}).textContent || ''));
    });
    await test('Runs: Done memuat selesai / gagal / dihentikan dengan ikon, teks hasil, tombol folder, dan Clear', async () => {
        const ok = row('run:110'), bad = row('run:111'), stop = row('run:112');
        assert.ok((await ok.innerText()).includes('SELESAI: 10 of 10 Masa Pajak downloaded'));
        assert.ok(await ok.locator('.rn-ico.ok').count() && await bad.locator('.rn-ico.bad').count() && await stop.locator('.rn-ico.mute').count(), 'ikon centang / silang / henti');
        assert.ok((await bad.innerText()).includes('GAGAL: Coretax rejected the login for this PIC'));
        assert.strictEqual(await bad.locator('[data-rn-folder]').count(), 0, 'tanpa folder bila outputDir kosong');
        let c = await clickCall('[data-flip="run:110"] [data-rn-folder]');
        assert.deepStrictEqual([c.path, c.body], ['/api/runs/open-folder', { key: 'run:110' }]);
        c = await clickCall('[data-rn-clear]');
        assert.strictEqual(c.path, '/api/runs/clear-done');
    });
    await test('Runs: batch berjalan = satu baris di In Progress ("2 of 6 clients"), dibuka ke baris per klien, Stop all -> stop-batch', async () => {
        const b = row('batch:b-masa-1026'), t = await b.innerText();
        assert.ok(t.includes('SPT Masa Pajak 10/2026 for 6 clients') && t.includes('2 of 6 clients') && t.includes('1 running') && t.includes('3 waiting'), t);
        const sub1 = await b.locator('.rn-head .rn-t2').first().innerText();
        assert.ok(/^SPT\b/.test(sub1) && sub1 !== 'spt' && sub1.includes('Masa Pajak'), 'baris kedua batch: nama fitur ramah + parameter, bukan id mentah: ' + sub1);
        assert.strictEqual((await row('batch:b-old').locator('.rn-head .rn-t2').first().innerText()).split(' · ')[0], 'Bukti Potong Saya');
        await b.locator('.rn-head').first().click();
        await page.waitForSelector('[data-flip="batch:b-masa-1026"] .rn-subs');
        assert.strictEqual(await b.locator('.rn-row.sub').count(), 6);
        assert.ok((await b.locator('.rn-subs').innerText()).includes('Waiting · #3 in line'));
        await shot('62-runs-batch-expanded');
        const c = await clickCall('[data-rn-stop-batch="b-masa-1026"]');
        assert.deepStrictEqual([c.path, c.body], ['/api/runs/stop-batch', { id: 'b-masa-1026' }]);
        await b.locator('.rn-head').first().click();
        await page.waitForFunction(() => !document.querySelector('[data-flip="batch:b-masa-1026"] .rn-subs'));
        const old = row('batch:b-old');
        assert.ok((await old.innerText()).includes('2 of 2 clients'));
        assert.strictEqual(await old.locator('[data-rn-stop-batch]').count(), 0, 'tanpa Stop untuk batch selesai');
        await old.locator('.rn-head').first().click();
        await page.waitForSelector('[data-flip="batch:b-old"] .rn-subs');
        assert.strictEqual(await old.locator('.rn-row.sub').count(), 2);
        await old.locator('.rn-head').first().click();
    });
    await test('Runs: klik baris membuka rencana per item + log terakhir di tempat, ikut diperbarui; tampilan proses tidak menggantikan halaman', async () => {
        await row('run:102').locator('.rn-head').first().click();
        await page.waitForSelector('[data-flip="run:102"] .rn-detail .rn-log .log-line');
        assert.strictEqual(await row('run:102').locator('.qpill').count(), 10);
        assert.ok((await row('run:102').locator('.rn-log').innerText()).includes('Masa Pajak 0226 downloaded'));
        await shot('63-runs-row-expanded');
        const d = runsFx.runsFixture(); d.inProgress[0].progress.done = 5;
        await pushRuns(d);
        await page.waitForFunction(() => /5 of 12/.test((document.querySelector('[data-flip="run:102"]') || {}).textContent || ''));
        assert.ok(await row('run:102').locator('.rn-detail').count(), 'tetap terbuka saat diperbarui');
        fakes.ctl.run = { active: true, paused: false, label: 'SPT PPh 21/26 · PT Contoh Sejahtera Abadi', controls: { stop: true, pause: true, skip: true, retry: true } };
        await pause(2200);
        assert.ok(await page.locator('.rn-sec').count() > 0 && !(await page.locator('.run-view').count()), 'halaman Runs tidak diganti tampilan proses');
        await page.click('.nav-item[data-nav="spt"]');
        await page.waitForSelector('.run-view');
        assert.ok(await visible('.run-view [data-go-runs]'), 'tautan "View in Runs" di tampilan proses');
        await shot('64-run-view-link');
        await page.click('.run-view [data-go-runs]');
        await page.waitForSelector('.rn-sec');
        fakes.ctl.run = null;
        await pause(1800);
        await row('run:102').locator('.rn-head').first().click();
    });
    await test('Runs: kabar SSE "runs" menggambar ulang; bagian kosong disembunyikan; keadaan kosong satu kalimat', async () => {
        const d = runsFx.runsFixture();
        const held = d.needsYou.shift(); held.state = 'running'; held.hold = null; d.inProgress.unshift(held);
        await pushRuns(d);
        await page.waitForFunction(() => !document.querySelector('[data-sec="needs"]'));
        assert.deepStrictEqual(await page.locator('.rn-sec').evaluateAll((els) => els.map((e) => e.dataset.sec)), ['prog', 'done'], 'Needs You tersembunyi saat kosong');
        assert.ok(!/warn/.test(await page.locator('#nav-runs-badge').getAttribute('class')), 'lencana netral');
        const only = runsFx.runsFixture(); only.needsYou = []; only.inProgress = []; only.batches = only.batches.filter((x) => x.id === 'b-old'); only.done = only.done.filter((r) => r.key === 'run:110' || (r.batch && r.batch.id === 'b-old'));
        await pushRuns(only);
        await page.waitForFunction(() => !document.querySelector('[data-sec="prog"]'));
        assert.deepStrictEqual(await page.locator('.rn-sec').evaluateAll((els) => els.map((e) => e.dataset.sec)), ['done']);
        assert.strictEqual(await page.locator('#nav-runs-badge').count(), 0, 'tanpa lencana bila tidak ada yang berjalan');
        await shot('65-runs-done-only');
        await pushRuns({ needsYou: [], inProgress: [], done: [], batches: [], limits: {} });
        await page.waitForSelector('.rn-empty');
        assert.ok((await text('.rn-empty')).includes('No runs yet today') && (await text('.rn-empty')).includes('Start one from a page in the sidebar'));
        assert.strictEqual(await page.locator('.rn-sec').count(), 0);
        await shot('66-runs-empty');
        await pushRuns(runsFx.runsFixture());
        await page.waitForSelector('[data-sec="needs"]');
    });

    // ------------------------------------------------ Restricted Editor
    await test('Restricted Editor: tanpa A1, PPh 21 dan BPMP/BPA1 terkunci, tanpa entitas manual dan Buka Coretax', async () => {
        await page.evaluate(() => fetch('/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"project":"taxio_hub"}' }));
        fakes.ctl.role = 'restricted_editor'; fakes.ctl.manual = { open: false, loggedIn: false, identity: '' };
        await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* */ } });
        await page.reload();
        await page.waitForSelector('.auth-form');
        await page.fill('#au-email', 'baru@contoh.com'); await page.fill('#au-pass', 'benar');
        await page.click('[data-au="login"]');
        await page.waitForSelector('#app .sidebar');
        assert.ok(!(await text('.sidebar')).includes('Annual PPh 21 Recap'), 'Annual PPh 21 Recap (A1) disembunyikan');
        assert.ok(!(await text('.sidebar')).includes('e-Bupot Upload'), 'e-Bupot Upload, Issue & Sign disembunyikan');
        assert.ok((await text('.sidebar')).includes('Restricted Editor'));
        assert.ok(!(await visible('#btn-open-coretax')), 'tanpa Buka Coretax');
        await page.click('#entity-chip');
        assert.ok(!(await visible('.pal-add')), 'tanpa tambah entitas manual');
        await page.keyboard.press('Escape');
        await page.locator('#entity-chip').click();
        await page.fill('#pal-q', 'sejahtera');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok(await page.locator('.tile[data-val="pph21"]').isDisabled());
        assert.strictEqual(await page.locator('.tile[data-val="pph21"]').getAttribute('aria-pressed'), 'false', 'PPh 21 tidak terpilih untuk Restricted');
        await page.click('.nav-item[data-nav="ebupot"]');
        assert.ok(await page.locator('.tile[data-val="bpmp"]').isDisabled());
        assert.ok(await page.locator('.tile[data-val="bpa1"]').isDisabled());
        await shot('20-restricted');
    });

    await test('Runs: Restricted Editor juga melihat Runs (proses miliknya sendiri)', async () => {
        assert.ok(await visible('.sb-nav .nav-item[data-nav="runs"]'));
        await page.click('.nav-item[data-nav="runs"]');
        await page.waitForSelector('.rn-sec');
        page.off('dialog', acceptDialogs);
        await page.unroute(runsRouteMatcher);
    });

    await test('tidak ada error JavaScript selama seluruh alur', async () => { assert.deepStrictEqual(errors, []); });

    await test('pemulihan sesi di latar: "Restoring Session…" (bukan form masuk), lalu offline -> Try again', async () => {
        const c2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
        const p2 = await c2.newPage();
        const pageErrors = [];
        p2.on('pageerror', (e) => pageErrors.push(e.message));
        let restore = { phase: 'restoring', email: 'uji@contoh.com', attempt: 1, nextRetryAt: null, error: '' };
        let retried = 0;
        await p2.route('**/api/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taxio_hub: { connected: false, label: 'Taxio Hub', restore: restore || undefined } }) }));
        await p2.route('**/api/session/retry', (route) => { retried++; restore = null; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taxio_hub: { connected: false, label: 'Taxio Hub' } }) }); });
        try {
            await p2.goto(BASE + '/?t=' + server.token);
            await p2.waitForSelector('.auth-form[data-restore="restoring"]');
            assert.ok((await p2.locator('.auth-form h2').innerText()).includes('Restoring Session'));
            assert.strictEqual(await p2.locator('#au-pass').count(), 0, 'form masuk tidak tampil selama pemulihan');
            restore = { phase: 'retrying', email: 'uji@contoh.com', attempt: 1, nextRetryAt: Date.now() + 30000, error: 'Taxio Hub tidak bisa dihubungi (fetch failed)' };
            await p2.waitForSelector('.auth-form[data-restore="retrying"]', { timeout: 6000 });
            assert.ok((await p2.locator('.auth-form .lead').innerText()).includes('is still saved'));
            await p2.click('[data-au="retry"]');
            await p2.waitForSelector('[data-au="login"]');
            assert.strictEqual(retried, 1);
            assert.deepStrictEqual(pageErrors, []);
        } finally { await c2.close(); }
    });

    await browser.close();
    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
    fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
