/* Chrome automation primitives: Coretax login - finding visible controls, the Altcha checkbox,
 * detecting an existing portal session, the login form / "Pilih Akun" flow, logout detection,
 * clearing Coretax site data, and logging rejected API calls. Split out of lib/chrome.js (still
 * the public entry point). */
const { log } = require('./log');
const { bringChromeToFrontOnWindows } = require('./chrome-window');
const { _sleep } = require('./chrome-profile');

const CORETAX_LOGIN_URL = 'https://coretaxdjp.pajak.go.id/identityproviderportal/Account/Login';

async function firstVisible(page, locators, timeout) {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
        for (const loc of locators) {
            try {
                if (await loc.first().isVisible({ timeout: 250 }).catch(() => false)) return loc.first();
            } catch (e) { /* keep trying */ }
        }
        await page.waitForTimeout(250);
    }
    return null;
}

async function clickAltchaCheckbox(page) {
    const box = await firstVisible(page, [
        page.locator('input[type="checkbox"][id^="altcha_checkbox"]'),
        page.getByLabel(/Saya bukan robot/i),
        page.locator('input[type="checkbox"]').first()
    ], 8000);
    if (!box) throw new Error('Checkbox verifikasi (Altcha) tidak ditemukan.');
    await box.click({ noWaitAfter: true, timeout: 8000, force: true });
    const end = Date.now() + 6000;
    let checked = false;
    while (Date.now() < end) {
        checked = await box.isChecked().catch(() => false);
        if (checked) break;
        await page.waitForTimeout(200);
    }
    if (!checked) throw new Error('Checkbox verifikasi belum tercentang setelah diklik.');
}

/** True when the tab is already inside the Coretax portal (not the identity provider) and holds
 *  an OIDC token that hasn't expired. In that state opening /Account/Login again is harmful:
 *  Coretax answers it with the "Pilih Akun" picker instead of a redirect (seen live 2026-09-25,
 *  second action on the same PIC a few seconds after a good login), and the run got stuck there.
 *  String IIFE for the same pkg-bytecode reason as verifyImpersonationByCode below. */
async function hasPortalSession(page) {
    const url = page.url();
    if (url.indexOf('coretaxdjp.pajak.go.id') === -1 || url.indexOf('/identityproviderportal') !== -1) return false;
    const code = `(() => {
        const live = (token) => {
            const parts = String(token || '').split('.');
            if (parts.length !== 3) return false;
            try {
                const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                return !!(p && p.sub != null && (!p.exp || p.exp * 1000 > Date.now() + 60000));
            } catch (e) { return false; }
        };
        const scan = (store) => {
            if (!store) return false;
            for (let i = 0; i < store.length; i++) {
                let v = '';
                try { v = store.getItem(store.key(i)) || ''; } catch (e) { continue; }
                if (live(v)) return true;
                const m = v.match(/"access_token"\\s*:\\s*"([^"]+)"/);
                if (m && live(m[1])) return true;
            }
            return false;
        };
        try { if (scan(window.sessionStorage)) return true; } catch (e) { }
        try { if (scan(window.localStorage)) return true; } catch (e) { }
        // Coretax memindahkan sesinya ke cookie httpOnly (2026-10-02): tidak ada token di storage sama
        // sekali, jadi pemindaian di atas selalu gagal dan setiap aksi membuka /Account/Login ->
        // "Pilih Akun" -> "Lanjutkan" (~14 detik terbuang, dilaporkan live 2026-10-05). Tombol akun di
        // topbar hanya ada bila sudah login, jadi keberadaannya menandai sesi aktif.
        if (document.querySelector('.tw-profilebtn-wide')) return true;
        return false;
    })()`;
    return page.evaluate(code).catch(() => false);
}

/** Waits until the page has really left the identity provider (login form AND "Pilih Akun")
 *  and landed in the portal. */
async function waitForPortal(page, timeout) {
    return page.waitForURL((u) => String(u).indexOf('/identityproviderportal') === -1, { timeout }).then(() => true).catch(() => false);
}

/** Koneksi tidak stabil (hotspot seluler, dilaporkan 2026-10-28) kadang tidak menjangkau Coretax
 *  sesaat: goto habis waktu dan aksi gagal, padahal percobaan berikutnya lancar. Ulangi hanya untuk
 *  timeout/galat jaringan; galat lain langsung dilempar. */
async function gotoCoretaxLogin(page) {
    const attempts = 3;
    for (let i = 1; ; i++) {
        try { return await page.goto(CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch (e) {
            if (!/Timeout|net::ERR_/i.test(e.message || '') || i >= attempts || page.isClosed()) throw e;
            log('Coretax belum merespons (percobaan ' + i + '/' + attempts + ') - mencoba lagi...');
            await _sleep(2000);
        }
    }
}

/** Fills the login form if needed; no-op (fast path) if the session is already active.
 *  Returns true if we land in a logged-in state either way, false on a hard failure. */
async function ensureLoggedIn(page, cred) {
    bringChromeToFrontOnWindows(page);
    log('Memeriksa apakah PIC "' + cred.pic_name + '" sudah dalam keadaan login...');
    if (await hasPortalSession(page)) {
        log('Sesi sudah aktif - lewati login.');
        return true;
    }
    await gotoCoretaxLogin(page);
    await Promise.race([
        page.waitForURL(u => String(u).indexOf('/Account/Login') === -1, { timeout: 4000 }).then(() => 'redirect'),
        page.waitForSelector('#userid', { timeout: 4000 }).then(() => 'login_form')
    ]).catch(() => { });
    const stillOnLoginPage = page.url().indexOf('/Account/Login') !== -1;
    if (!stillOnLoginPage) {
        log('Sesi sudah aktif - lewati login.');
        return true;
    }
    // Coretax 2026 tidak selalu menampilkan form kredensial di URL /Account/Login. Jika
    // sebuah sesi masih aktif, halaman yang sama berubah menjadi "Pilih Akun" dan hanya
    // menyediakan tombol "Lanjutkan sebagai <akun>" / "Masuk dengan akun lain".
    // Profil Chrome dipisah per PIC, jadi akun yang ditawarkan selalu milik PIC ini sendiri:
    // "Lanjutkan" adalah jalan yang benar (entitas tujuan tetap diganti oleh switchToEntity
    // sesudahnya, dan diverifikasi lewat token). "Masuk dengan akun lain" hanya cadangan bila
    // "Lanjutkan" tidak membawa keluar dari halaman identitas - dulu ini jalur utama dan
    // membuat run tersangkut di "Pilih Akun" (live 2026-09-25).
    const initialUserField = await firstVisible(page, [page.locator('#userid'), page.getByPlaceholder(/NIK.*NPWP/i)], 1200);
    if (!initialUserField) {
        const continueAs = await firstVisible(page, [
            page.getByRole('button', { name: /^\s*(Lanjutkan sebagai|Continue as)\b/i }),
            page.getByText(/^\s*(Lanjutkan sebagai|Continue as)\b/i)
        ], 2500);
        if (continueAs) {
            log('Halaman Pilih Akun terdeteksi - melanjutkan dengan akun PIC yang tersimpan.');
            await continueAs.click({ noWaitAfter: true, timeout: 8000, force: true }).catch(() => {});
            if (await waitForPortal(page, 20000)) {
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                log('Sesi dilanjutkan - lewati login.');
                return true;
            }
            log('"Lanjutkan" tidak membuka portal - beralih ke login ulang.');
        }
        const useAnotherAccount = await firstVisible(page, [
            page.getByRole('button', { name: /Masuk dengan akun lain|Use another account/i }),
            page.getByText(/Masuk dengan akun lain|Use another account/i, { exact: true })
        ], 4000);
        if (useAnotherAccount) {
            log('Halaman Pilih Akun terdeteksi - memilih "Masuk dengan akun lain" agar dapat login sebagai PIC yang benar.');
            await useAnotherAccount.click({ noWaitAfter: true, timeout: 8000, force: true });
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(400);
        }
    }
    log('Belum login (atau sesi berakhir) - menjalankan proses login penuh...');
    const userField = await firstVisible(page, [page.locator('#userid'), page.getByPlaceholder(/NIK.*NPWP/i)], 12000);
    const passField = await firstVisible(page, [page.locator('#password')], 8000);
    if (!userField || !passField) { log('Field ID Pengguna/Kata Sandi tidak ditemukan.'); return false; }
    await userField.fill(cred.username);
    await passField.fill(cred.password);
    try { await clickAltchaCheckbox(page); } catch (e) { log('Verifikasi Altcha gagal: ' + e.message); return false; }
    const loginBtn = await firstVisible(page, [
        page.locator('#loginButton'),
        page.getByRole('button', { name: /^Masuk$/i }),
        page.getByText(/^Masuk$/i)
    ], 8000);
    if (!loginBtn) { log('Tombol "Masuk" tidak ditemukan.'); return false; }
    await loginBtn.click({ noWaitAfter: true, timeout: 10000, force: true });
    await waitForPortal(page, 20000);
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForTimeout(400);
    // CONFIRMED LIVE: a rejected login (wrong username/password, locked account, etc.) leaves
    // Coretax on the SAME /Account/Login URL with just an inline error banner ("Login Gagal -
    // Username atau kata sandi tidak valid") - waitForURL above then genuinely times out and its
    // rejection was silently swallowed by .catch(), after which this function used to log
    // "Berhasil login." and return true UNCONDITIONALLY. That reported a real credential
    // failure as success - the caller (and everything downstream: impersonate, the standalone
    // Login button, e-Bupot's whole run) proceeded believing it was authenticated when it
    // wasn't. Never assume; check where we actually ended up.
    if (page.url().indexOf('/Account/Login') !== -1) {
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const looksRejected = /login gagal|tidak valid|kata sandi salah|akun.*terkunci/i.test(bodyText);
        log('Login GAGAL - masih di halaman login' + (looksRejected ? ' (Coretax: kredensial ditolak - periksa username/kata sandi PIC ini).' : ' (alasan tidak diketahui - cek jendela Coretax).'));
        if (looksRejected) throw Object.assign(new Error('Kredensial PIC "' + cred.pic_name + '" ditolak Coretax (username/kata sandi salah).'), { credentialRejected: true });
        return false;
    }
    // Keluar dari form login saja belum cukup: halaman identitas lain ("Pilih Akun") juga
    // bukan portal. Hanya laporkan berhasil bila sudah benar-benar di portal.
    if (page.url().indexOf('/identityproviderportal') !== -1) {
        log('Login belum sampai portal - masih di halaman identitas Coretax (' + page.url().replace(/[?#].*$/, '') + ').');
        // Isi halamannya menjelaskan sebabnya (live 2026-10-05: Coretax mengeluarkan akun segera setelah
        // login berhasil - "Sesi Anda telah diakhiri dengan aman"), tapi sebelumnya tidak pernah dicatat.
        const idpText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
        if (idpText) log('Isi halaman Coretax: "' + idpText + '"');
        if (/telah keluar|diakhiri dengan aman|telah berakhir|sesi.*(habis|berakhir)/i.test(idpText)) {
            log('Coretax mengeluarkan akun PIC "' + cred.pic_name + '" segera setelah login. Biasanya sesi PIC ini masih aktif di tempat lain (browser/perangkat lain atau jendela yang ditutup paksa): tutup sesi itu atau tunggu beberapa menit sampai kedaluwarsa, lalu coba lagi. Pilot tidak mengulang login terus-menerus supaya akun tidak terkena pembatasan.');
            // Mengulang di sini hanya menambah jumlah login yang ditolak (live 2026-10-05: 3 percobaan beruntun tiap klik).
            throw Object.assign(new Error('Coretax langsung mengeluarkan akun PIC "' + cred.pic_name + '" setelah login. Tunggu beberapa menit lalu coba lagi.'), { forcedLogout: true });
        }
        return false;
    }
    log('Berhasil login.');
    return true;
}

/** True if the page has been kicked back to the login screen (Coretax's session-timeout
 *  behavior mid-run) - checked between rows/pages during long e-Bupot download loops. */
function isLoggedOut(page) {
    return page.url().indexOf('/Account/Login') !== -1 || page.url().indexOf('/identityproviderportal') !== -1 && page.url().indexOf('/Account/Login') !== -1;
}

/** Menghapus cookie, storage, dan cache situs Coretax di profil Chrome halaman ini (profil lain tak tersentuh). */
async function clearCoretaxSiteData(page) {
    log('Membersihkan data situs Coretax (cookie, storage, cache) di profil Chrome PIC ini, lalu login ulang sekali...');
    const context = page.context();
    try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.clearDataForOrigin', { origin: 'https://coretaxdjp.pajak.go.id', storageTypes: 'all' });
        await cdp.detach().catch(() => {});
    } catch (e) { log('Gagal membersihkan storage Coretax: ' + e.message); }
    await context.clearCookies({ domain: /pajak\.go\.id$/ }).catch(() => context.clearCookies().catch(() => {}));
}

/** Mencatat permintaan API Coretax yang ditolak server (status 400/500+) ke log aktivitas: metode,
 *  alamat, isi permintaan, dan pesan balasan (dipotong). Toast "Operasi Gagal - Http failure response
 *  for 400" yang tampil di jendela Coretax tidak meninggalkan jejak apa pun di log, sehingga
 *  penyebabnya (filter masa, jenis bukti potong, dsb.) tidak bisa ditelusuri. Dipasang sekali per
 *  halaman, maksimal 8 catatan per halaman supaya log tidak banjir. Tidak mengubah/menahan permintaan. */
function attachApiErrorLog(page) {
    if (!page || page.__caApiErrLog) return;
    page.__caApiErrLog = true;
    let count = 0;
    page.on('response', async (resp) => {
        try {
            const status = resp.status();
            if (count >= 8 || (status !== 400 && status < 500)) return;
            const url = resp.url();
            if (url.indexOf('coretaxdjp.pajak.go.id') === -1) return;
            if (!/\/(api|[a-z-]+-portal)\//i.test(url) && !/Get|List|Search|Download|Export/i.test(url)) return;
            count++;
            const req = resp.request();
            const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; };
            const body = await resp.text().catch(() => '');
            log('[Coretax ' + status + '] ' + req.method() + ' ' + cut(url.replace('https://coretaxdjp.pajak.go.id', ''), 160)
                + (req.postData() ? ' - permintaan: ' + cut(req.postData(), 220) : '') + ' - balasan: ' + (cut(body, 220) || '(kosong)'));
        } catch (e) { /* diagnostik saja */ }
    });
}

module.exports = {
    CORETAX_LOGIN_URL, firstVisible, clickAltchaCheckbox, hasPortalSession, waitForPortal, gotoCoretaxLogin, ensureLoggedIn,
    isLoggedOut, clearCoretaxSiteData, attachApiErrorLog
};
