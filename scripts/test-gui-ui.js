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

const PORT = 52433;
const BASE = 'http://127.0.0.1:' + PORT;
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
    await createGuiServer(PORT);
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_INTERNET|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

    // Aksi otomasi dicegat di browser: dicatat lalu dijawab 202, tidak sampai ke server.
    const calls = [];
    await page.route('**/api/actions/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url()).pathname;
        if (url.endsWith('/open-coretax')) return route.continue();
        if (url.endsWith('/pick-file')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canceled: false, fileName: 'faktur-uji.xlsx', fileBase64: 'AAAA' }) });
        if (url.endsWith('/pick-folder')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canceled: true }) });
        calls.push({ url, body: req.postDataJSON() });
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ started: true }) });
    });
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
    const text = (sel) => page.locator(sel).first().innerText();
    const visible = (sel) => page.locator(sel).first().isVisible();
    const lastCall = () => calls[calls.length - 1];
    const pause = (ms) => page.waitForTimeout(ms);
    // Kosongkan sesi palsu; pilihan entitas otomatis lepas (jendela hilang), lalu pilih lagi Sejahtera/ANDI.
    const sessionsGoneThenReselect = async () => {
        fakes.ctl.sessions = [];
        await page.waitForFunction(() => document.querySelector('#entity-chip').textContent.includes('Pilih entitas'), null, { timeout: 7000 });
        await page.click('#entity-chip');
        await page.fill('#pal-q', 'sejahtera'); await page.keyboard.press('Enter');
        await page.waitForSelector('#palette', { state: 'detached' });
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'));
    };

    console.log('gui ui');
    await page.goto(BASE + '/');
    await page.waitForSelector('.auth-form');

    // ------------------------------------------------ masuk / daftar
    await test('layar masuk: pesan otomasi, tanpa jalan masuk manual tanpa akun', async () => {
        assert.strictEqual(await text('.hero-body h1'), 'Coretax berjalan sendiri.');
        assert.ok(await visible('#au-email') && await visible('#au-pass'));
        const html = await page.content();
        assert.ok(!/Masuk Coretax manual/.test(html), 'tidak boleh ada masuk manual tanpa akun Taxio');
        await shot('01-masuk');
    });
    await test('daftar: inisial, email, kata sandi; galat memakai kalimat Taxio Hub', async () => {
        await page.click('[data-au="to-daftar"]');
        await page.waitForSelector('#au-initial');
        await page.click('[data-au="signup"]');
        assert.strictEqual(await text('#au-error'), 'Inisial wajib diisi.');
        await page.fill('#au-initial', 'sga');
        assert.strictEqual(await page.inputValue('#au-initial'), 'SGA', 'inisial otomatis huruf besar');
        await page.fill('#au-email', 'baru@contoh.com'); await page.fill('#au-pass', '123');
        await page.click('[data-au="signup"]');
        assert.strictEqual(await text('#au-error'), 'Kata sandi minimal 6 karakter.');
        await shot('02-daftar');
    });
    await test('daftar sukses: layar cek email dengan langkah 2 berjalan', async () => {
        await page.fill('#au-pass', '123456');
        await page.click('[data-au="signup"]');
        await page.waitForSelector('.progress-steps');
        assert.ok((await text('.auth-form h2')).includes('Cek email Anda'));
        assert.strictEqual(await page.locator('.pstep.done').count(), 1);
        assert.ok((await page.locator('.pstep.now .tx b').innerText()).includes('Konfirmasi email'));
        await shot('03-cek-email');
    });
    await test('setelah konfirmasi: kembali ke masuk dengan email terisi, lalu status menunggu admin', async () => {
        await page.click('[data-au="to-masuk"]');
        await page.waitForSelector('[data-au="login"]');
        assert.strictEqual(await page.inputValue('#au-email'), 'baru@contoh.com');
        await page.fill('#au-pass', 'benar');
        await page.click('[data-au="login"]');
        await page.waitForSelector('.progress-steps');
        assert.ok((await text('.auth-form h2')).includes('Menunggu admin'));
        assert.ok((await text('.auth-form .lead')).includes('assignment grup oleh admin'));
        assert.ok((await text('.auth-form .lead')).includes('SGA'), 'inisial yang diajukan tampil');
        assert.strictEqual(await page.locator('.pstep.done').count(), 2);
        await shot('04-menunggu-admin');
    });
    await test('periksa status saat masih menunggu: tetap di layar status', async () => {
        await page.click('[data-au="check"]');
        await page.waitForSelector('#notice-stack .notice');
        assert.ok((await text('#notice-stack .notice')).includes('Belum ada perubahan'));
        assert.ok(await visible('.progress-steps'));
    });
    await test('setelah admin menempatkan ke grup: periksa status membuka aplikasi', async () => {
        fakes.ctl.reg.active = true;
        await page.click('[data-au="check"]');
        await page.waitForSelector('#app .sidebar');
        assert.ok(await visible('.topbar'));
    });

    // ------------------------------------------------ kerangka aplikasi
    await test('sidebar: grup Unduh dan Otomasi; Billing di Otomasi dengan tanda BARU', async () => {
        const titles = await page.locator('.nav-title').allInnerTexts();
        assert.deepStrictEqual(titles, ['UNDUH', 'OTOMASI']);
        const items = await page.locator('.nav-item[data-nav]').allInnerTexts();
        assert.ok(items.join('|').includes('Kode Billing PPh 25'));
        const billing = page.locator('.nav-item[data-nav="billing"]');
        assert.ok((await billing.innerText()).includes('BARU'));
        const otomasi = page.locator('.nav-group').nth(1);
        assert.ok((await otomasi.innerText()).includes('Kode Billing PPh 25'));
        assert.ok(!(await page.locator('.nav-group').nth(0).innerText()).includes('Billing'));
        assert.ok((await page.locator('.nav-group').nth(0).innerText()).includes('SPT PPh 21 Setahun'), 'A1 tersedia untuk anggota biasa');
    });
    await test('tanpa entitas: kartu pilih entitas dan tombol mulai nonaktif', async () => {
        assert.ok((await text('.col-main')).includes('Pilih entitas dulu'));
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled());
        await shot('05-tanpa-entitas');
    });

    // ------------------------------------------------ palet entitas
    await test('palet Grup: satu baris per entitas, yang tanpa PIC disembunyikan, ada keterangan', async () => {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#palette .ent');
        const names = await page.locator('#pal-body .ent .ent-tx b').allInnerTexts();
        assert.deepStrictEqual(names, ['Budi Contoh Santoso', 'CV Sample Niaga Mandiri', 'MITRA KARYA ABADI, PT', 'PT Contoh Sejahtera Abadi']);
        assert.strictEqual(names.filter((n) => n.startsWith('MITRA KARYA')).length, 1, 'MKA hanya sekali walau 2 PIC');
        assert.ok((await text('#pal-body')).includes('2 PIC Coretax'));
        assert.ok((await text('#pal-body .pal-note')).includes('disembunyikan'));
        assert.ok(!(await text('#pal-body')).includes('MITRA LESTARI'), 'entitas tanpa PIC tidak di daftar awal');
        await shot('06-palet-grup');
    });
    await test('palet: pencarian menampilkan entitas tanpa PIC dengan keterangan, tidak bisa dipilih', async () => {
        await page.fill('#pal-q', 'mitra');
        const names = await page.locator('#pal-body .ent .ent-tx b').allInnerTexts();
        assert.deepStrictEqual(names, ['MITRA KARYA ABADI, PT', 'MITRA LESTARI UTAMA, PT']);
        const unlinked = page.locator('#pal-body .ent.unlinked');
        assert.ok((await unlinked.innerText()).includes('BELUM ADA PIC'));
        assert.ok((await unlinked.innerText()).includes('Manage Coretax PIC'));
        assert.ok((await unlinked.innerText()).includes('Pakai login manual'));
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
        assert.ok((await radios.first().innerText()).includes('UTAMA'));
        assert.strictEqual(await radios.first().getAttribute('aria-checked'), 'true', 'PIC utama terpilih bawaan');
        await shot('08-palet-pic');
        await radios.nth(1).click();
        await page.waitForSelector('#palette', { state: 'detached' });
        const chip = await text('#entity-chip');
        assert.ok(chip.includes('MITRA KARYA ABADI'));
        assert.ok(chip.includes('PIC RINA WIJAYA'));
        assert.ok(chip.includes('OTOMATIS'));
        assert.ok((await text('.status-pill')).includes('Belum masuk Coretax'));
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
        assert.ok(hi.includes('ANDI PRATAMA') && hi.includes('UTAMA'), '↑ memindah highlight ke PIC lain, belum login');
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
        assert.ok((await text('#entity-chip')).includes('OTOMATIS'));
    });

    // ------------------------------------------------ halaman SPT
    await test('SPT: bawaan PPh 21/26 dan bulan lalu, ringkasan menghitung kombinasi', async () => {
        assert.strictEqual(await page.locator('.tile[data-val="pph21"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await page.locator('.chip[data-val="' + PREV_MMYY + '"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await text('#rail .big-num b'), '1');
        assert.ok((await text('#rail')).includes('Otomatis · PIC ANDI PRATAMA'));
        await shot('09-spt');
    });
    await test('SPT: pilih beberapa jenis dan masa memperbarui hitungan; kode diketik memilih chip', async () => {
        await page.click('.tile[data-val="ppn"]');
        await page.click('.pp [data-pp="quick"][data-val="q1"]');
        assert.strictEqual(await text('#rail .big-num b'), '6', '2 jenis x 3 masa');
        await page.click('.pp [data-pp="text"]');
        await page.fill('.pp [data-pp-input]', '0126-0326;0526');
        assert.ok((await text('.pp .summary-line')).includes('4 masa'));
        assert.ok((await text('.pp .code-chip')).includes('0126-0326;0526'));
        await page.fill('.pp [data-pp-input]', '1326');
        assert.ok((await text('.pp [data-pp-error]')).includes('Masa tidak valid'));
        await page.fill('.pp [data-pp-input]', '0126-0326');
    });
    await test('SPT: tahunan eksklusif, memakai chip tahun; OP terkunci untuk Badan', async () => {
        assert.ok(await page.locator('.tile[data-val="spt_op"]').isDisabled());
        await page.click('.tile[data-val="badan"]');
        assert.strictEqual(await page.locator('.tile[data-val="pph21"]').getAttribute('aria-pressed'), 'false');
        assert.strictEqual(await page.locator('.tile[data-val="badan"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(await page.locator('.pp .chip').count(), 6);
        assert.ok((await text('.col-main')).includes('Tahun pajak'));
        assert.ok(!(await text('.col-main')).includes('Cek juga status PPh 25'), 'PPh 25 hanya untuk masa');
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
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled(), 'tanpa jenis: tombol mulai terkunci');
        assert.ok(!(await visible('#eb-kode')), 'tanpa jenis kode objek tidak relevan');
        await page.click('.tile[data-val="bpmp"]');
        assert.ok(!(await visible('#eb-kode')), 'tanpa BP21/BPPU kode objek tidak relevan');
        assert.ok(await page.locator('.doc-row [data-act="pdf"]').isDisabled(), 'BPMP saja: PDF terkunci');
        await page.click('.tile[data-val="bp21"]');
        assert.ok(await visible('#eb-kode'), 'dengan BP21 kode objek tampil');
        await page.fill('#eb-kode', '21-100-35');
        await page.click('.pp [data-pp="quick"][data-val="q1"]');
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
        await page.click('.pp [data-pp="quick"][data-val="q1"]');
        const before = calls.length;
        await page.click('#rail [data-act="start"]'); await pause(800);
        const eb = calls.slice(before).filter((x) => x.url === '/api/actions/download-ebupot');
        assert.deepStrictEqual(eb.map((x) => x.body.bupotType), ['bppu'], 'hanya satu permintaan: BPPU');
    });
    await test('Bukti Potong Saya: jenis milik PIC pribadi terkunci untuk entitas Badan', async () => {
        await page.click('.nav-item[data-nav="bpsaya"]');
        await page.waitForSelector('.tile[data-val="bppu"]');
        for (const k of ['bpmp', 'bp21', 'bpa1', 'bpa2']) assert.ok(await page.locator('.tile[data-val="' + k + '"]').isDisabled(), k + ' terkunci');
        for (const k of ['bppu', 'bpnr', 'bp26', 'bpatc']) assert.ok(!(await page.locator('.tile[data-val="' + k + '"]').isDisabled()), k + ' terbuka');
        assert.ok((await text('.tile[data-val="bpa1"]')).includes('BP A1'));
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
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled(), 'tanpa jenis dokumen');
        await page.click('[data-act="eall"]');
        assert.strictEqual(await page.locator('#efaktur-types .chip[aria-pressed="true"]').count(), 8);
        await page.click('[data-act="efmt"][data-val="excel"]'); await page.click('[data-act="efmt"][data-val="csv"]');
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled(), 'tanpa format');
        await page.click('[data-act="efmt"][data-val="excel"]');
        assert.ok(!(await page.locator('#rail [data-act="start"]').isDisabled()));
        await shot('21-efaktur');
    });
    await test('Billing: nominal berformat ribuan, masa satu bulan, tombol aktif hanya bila lengkap', async () => {
        await page.click('.nav-item[data-nav="billing"]');
        await page.waitForSelector('#bl-nominal');
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled(), 'nominal kosong');
        await page.fill('#bl-nominal', '1500000');
        assert.strictEqual(await page.inputValue('#bl-nominal'), '1.500.000');
        assert.ok(!(await page.locator('#rail [data-act="start"]').isDisabled()));
        assert.ok((await text('#rail .big-num')).includes('1.500.000'));
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
        assert.ok(!(await text('#pal-body')).toUpperCase().includes('SESI AKTIF'));
        assert.ok(await visible('#pal-body .ent'), 'daftar entitas tetap tampil seperti biasa');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#palette', { state: 'detached' });
        // Dialog Pengaturan juga tidak lagi menyebut ini - itu murni soal akun/versi app.
        await page.click('#open-settings');
        await page.waitForSelector('#settings');
        assert.ok(!(await text('#settings')).toLowerCase().includes('sesi coretax aktif'));
        assert.ok(!(await page.locator('#btn-sessions').count()), 'tombol topbar terpisah untuk ini sudah dihapus');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settings', { state: 'detached' });
    });
    await test('topbar: tab sesi menampilkan jendela yang benar-benar terbuka, tab entitas terpilih menyala, X menutupnya; tidak terpotong di jendela sempit', async () => {
        fakes.ctl.sessions = [
            { picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: '0123456780910000 · PT CONTOH SEJAHTERA ABADI' },
            { picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }
        ];
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 2, null, { timeout: 6000 });
        const tabs = page.locator('.sess-tab');
        assert.ok((await tabs.nth(0).getAttribute('class')).includes('active'), 'tab sesi entitas terpilih (p-andi) menyala');
        assert.ok(!(await tabs.nth(1).getAttribute('class')).includes('active'), 'tab sesi lain tidak menyala');
        assert.ok((await text('.sess-strip')).includes('Sesi baru'), 'tombol Sesi baru ada');
        // Jendela sempit: semua bagian topbar harus tetap di dalam layar (membungkus, bukan terpotong).
        await page.setViewportSize({ width: 720, height: 800 });
        await pause(200);
        const fit = await page.evaluate(() => {
            const w = window.innerWidth;
            const els = Array.from(document.querySelectorAll('.topbar .title, .topbar .status-pill, #entity-chip, .sess-tab, .sess-new'));
            return { over: els.filter((e) => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > w + 1; }).map((e) => e.className || e.id), scrollW: document.documentElement.scrollWidth, w };
        });
        assert.deepStrictEqual(fit.over, [], 'tidak ada bagian topbar yang melewati tepi layar');
        assert.ok(fit.scrollW <= fit.w + 1, 'tidak ada scroll horizontal halaman');
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
    await test('antrean: centang beberapa entitas satu sesi, Mulai Otomasi mengunduh berurutan (pindah entitas lalu unduh, per entitas)', async () => {
        fakes.ctl.sessions = [{ picId: 'p-rina', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }];
        await page.click('.nav-item[data-nav="faktur"]');
        await page.waitForSelector('.pp');
        await page.waitForFunction(() => document.querySelectorAll('.sess-tab').length === 1, null, { timeout: 6000 });
        await page.locator('.sess-tab .sess-drop').click();
        await page.waitForSelector('.sess-pop');
        await page.click('[data-sp-all]');
        await shot('sesi-popover-antrean');
        assert.ok((await text('.sess-pop')).includes('2 dipilih'), 'dua entitas tercentang');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => /Antrean unduhan: 2 entitas/.test(document.body.textContent), null, { timeout: 3000 });
        const before = calls.length;
        await page.click('#rail [data-act="start"]');
        const seqNow = () => calls.slice(before).map((c) => c.url.replace('/api/actions/', '') + ':' + ((c.body && c.body.entity) || {}).entity_id);
        for (let i = 0; i < 60 && seqNow().length < 4; i++) await pause(500);
        assert.deepStrictEqual(seqNow(), ['login-entity:SNM', 'download-efaktur:SNM', 'login-entity:MKA', 'download-efaktur:MKA'], 'tiap entitas: pindah dulu, baru unduh; berurutan');
        await page.waitForFunction(() => /Antrean selesai: 2 dari 2/.test(document.body.textContent), null, { timeout: 8000 });
        assert.ok(!(await text('#content')).includes('Antrean unduhan:'), 'bar antrean hilang setelah selesai');
        await page.click('.nav-item[data-nav="spt"]');
        await sessionsGoneThenReselect();
    });
    await test('topbar: jendela sesi entitas terpilih hilang -> pilihan otomatis dilepas ("Pilih entitas")', async () => {
        assert.ok((await text('#entity-chip')).includes('PT Contoh Sejahtera Abadi'));
        fakes.ctl.sessions = [{ picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: 'x' }];
        await page.waitForFunction(() => window.Pilot.state.sessions.length === 1, null, { timeout: 6000 });
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
            await page.waitForSelector('.sess-tab.busy', { timeout: 4000 });
            assert.ok((await text('.sess-tab.busy')).includes('Sedang berjalan'), 'tab sesi yang sibuk diberi penanda');
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
            assert.ok(/Sesi PIC ini sedang menjalankan "e-Bupot BPPU/.test(await page.textContent('body')), 'pengguna diberi tahu kenapa login belum jalan');
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
        assert.ok((await text('#entity-dialog')).includes('WAJIB, BOLEH LEBIH DARI SATU'));
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
        assert.ok(chip.includes('CV Klien Baru Sejahtera') && chip.includes('OTOMATIS') && chip.includes('PIC Ani Sample Wijaya'));
        await page.click('.nav-item[data-nav="spt"]');
        assert.ok(!(await visible('.banner')), 'tidak ada banner login manual untuk entitas lokal berkredensial');
        assert.ok(!(await page.locator('#rail [data-act="start"]').isDisabled()));
        assert.ok((await text('.status-pill')).includes('Belum masuk Coretax'), 'status login umum, bukan status jendela manual');
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
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled(), 'belum ada file');
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
        await page.waitForFunction(() => /Belum membuka Coretax/.test(document.querySelector('.status-pill')?.innerText || ''), null, { timeout: 3000 });
        const banner = await text('.banner');
        assert.ok(banner.includes('Coretax dibuka di jendela terpisah'), 'banner login manual polos tetap ada untuk jalur ini');
        assert.ok(await page.locator('#rail [data-act="start"]').isDisabled());
    });
    await test('Dividen: hanya butuh sesi manual polos, tanpa entitas; impor mengirim file', async () => {
        // Dividen selalu memakai jendela Coretax manual (bukan entitas terpilih) - simulasikan
        // pengguna sudah login di sana, terlepas dari entitas apa pun yang sedang dipilih.
        fakes.ctl.manual.loggedIn = true; fakes.ctl.manual.identity = '0678901234560000 · SESI MANUAL UJI';
        await page.evaluate(() => window.Pilot.manual.poll());
        await page.waitForFunction(() => /Login manual aktif/.test(document.querySelector('.status-pill')?.innerText || ''), null, { timeout: 3000 });
        await page.click('.nav-item[data-nav="dividen"]');
        await page.waitForSelector('.dropzone');
        assert.ok(!(await text('.col-main')).includes('Pilih entitas dulu'));
        assert.ok(await page.locator('[data-act="import"]').isDisabled(), 'belum ada file');
        await page.click('[data-act="pick-file"]');
        await page.waitForSelector('.dropzone.filled');
        assert.ok(!(await page.locator('[data-act="import"]').isDisabled()));
        await page.click('[data-act="import"]'); await pause(300);
        assert.strictEqual(lastCall().url, '/api/actions/import-dividen');
        assert.strictEqual(lastCall().body.fileName, 'faktur-uji.xlsx');
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
        assert.ok((await text('.banner.warn')).includes('Proses ditahan'));
        assert.ok((await text('.banner.warn')).includes('Tabel lampiran tidak terbaca'));
        assert.strictEqual(await text('.big-num b'), '2');
        assert.ok((await text('.big-num')).includes('/ 5'));
        assert.ok((await text('.tally')).includes('PPh Unifikasi · 1 ok, 1 gagal'));
        assert.strictEqual(await page.locator('[data-run-size="50"]').getAttribute('aria-pressed'), 'true');
        assert.ok((await text('.status-pill')).includes('Sedang berjalan'));
        await shot('18-berjalan');
    });
    await test('kontrol proses: Ulang, Lewati, Mundur, Jeda/Lanjut dan Hentikan menghubungi server', async () => {
        fakes.ctl.runCalls.length = 0;
        await page.click('.banner.warn [data-run="retry"]'); await pause(150);
        await page.click('.banner.warn [data-run="skip"]'); await pause(150);
        await page.click('.banner.warn [data-run="back"]'); await pause(150);
        await page.click('.ctl-grid [data-run="pause"]'); await pause(150); // paused=true -> Lanjut -> resume
        page.once('dialog', (d) => d.accept());
        await page.click('.rail [data-run="stop"]'); await pause(200);
        assert.deepStrictEqual(fakes.ctl.runCalls, ['retry', 'skip', 'back', 'resume', 'stop']);
    });
    await test('proses selesai: kembali ke halaman dengan ringkasan hasil yang bisa ditutup', async () => {
        fakes.ctl.run = { active: false, paused: false, label: '', jenisRequested: ['pph21'], jenisTally: { pph21: { ok: 5, fail: 0 } }, plan: { items: [{ label: 'a', short: '0126' }, { label: 'b', short: '0226' }], states: ['ok', 'skip'], index: 1 } };
        await page.waitForSelector('.qpill', { state: 'detached', timeout: 5000 });
        await page.waitForSelector('.banner [data-dismiss-run]', { timeout: 5000 });
        assert.ok((await text('.content .banner')).includes('1 selesai, 1 dilewati'));
        await page.click('[data-dismiss-run]');
        assert.ok(!(await visible('[data-dismiss-run]')));
        fakes.ctl.run = null;
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
        await page.waitForFunction(() => /Pilih entitas/.test((document.querySelector('#entity-chip') || {}).textContent || ''), null, { timeout: 8000 });
        // Dengan jendela PIC-nya masih terbuka: pilihan dipertahankan melewati beberapa kali polling.
        await restore([{ picId: 'p-andi', kind: 'entity', open: true, loggedIn: true, identity: '0317927093541000 · MITRA KARYA ABADI' }]);
        await page.waitForTimeout(5500);
        assert.ok((await text('#entity-chip')).includes('MITRA KARYA ABADI'), 'pilihan tetap bila sesinya masih terbuka');
        fakes.ctl.sessions = [];
        await page.evaluate(() => localStorage.removeItem('pilot.sel'));
        await page.reload();
        await page.waitForSelector('#app .sidebar');
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
        assert.ok(!(await text('.sidebar')).includes('SPT PPh 21 Setahun'), 'A1 disembunyikan');
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

    await test('tidak ada error JavaScript selama seluruh alur', async () => { assert.deepStrictEqual(errors, []); });

    await browser.close();
    console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : '.'));
    fs.rmSync(process.env.TAXIO_PILOT_DATA_DIR, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
