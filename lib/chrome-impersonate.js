/* Chrome automation primitives: entity impersonation - reading which account is really active
 * (code-first), switching the impersonated entity, and the shared "log in as this PIC, then
 * impersonate this entity" sequence with retries. Split out of lib/chrome.js (still the public
 * entry point). */
const path = require('path');
const fs = require('fs');
const { log } = require('./log');
const watchdog = require('./coretax-watchdog');
const lampiran = require('../automation/lampiran');
const { bringChromeToFrontOnWindows, hideWindowOffscreen, revealWindow } = require('./chrome-window');
const { _sleep } = require('./chrome-profile');
const { firstVisible, ensureLoggedIn, clearCoretaxSiteData, attachApiErrorLog } = require('./chrome-login');
const { liveUserDataDir } = require('./chrome-sessions'); // folder profil JENDELA proses ini (satu PIC bisa punya beberapa)

// Code-level impersonation/session check. CONFIRMED BY LIVE INSPECTION (2026-07-18, real
// Coretax session, entity BERKAT KANA ABADI / NPWP 0317927093541000) that the original
// "does ANY storage value contain the target NPWP's digits" scan produces a FALSE POSITIVE:
// `localStorage['taxpayers-for-representative-portal-<PIC_NPWP>']` is the PIC's list of every
// entity it CAN impersonate, and already contains the target NPWP before the switch even starts
// - so the old scan reported "confirmed" within ~500ms of the click, well before Coretax had
// actually finished switching (this is exactly the "belum ke-load sempurna tapi keklaim sukses"
// bug reported live: impersonate looked confirmed then subsequent pages acted as the wrong/PIC
// account). The one value that actually flips to the target only once the switch has truly
// completed is the active OIDC access token's `sub` claim (found live: BEFORE switching, `sub`
// equals the PIC's own NPWP; AFTER a real switch completes, `sub` becomes the impersonated
// entity's NPWP and the same token gains `"Impersonating":"true"`). So: decode that token and
// compare `sub` for an EXACT digit match - never substring-scan arbitrary storage keys again.
async function verifyImpersonationByCode(page, targetNpwp) {
    const want = String(targetNpwp || '').replace(/\D/g, '');
    if (!want) return null;
    // Built as a self-invoking STRING (not a JS function reference) on purpose: pkg's packaged
    // exe compiles this file to V8 bytecode, which strips function source text, so passing a
    // real function to page.evaluate() makes Playwright's Function.prototype.toString()-based
    // serializer throw "Passed function is not well-serializable!" - CONFIRMED LIVE as the actual
    // cause of the 30s+ impersonate-confirm fallback (this evaluate() failed on every attempt
    // inside the exe, never in `node main.js`). A string literal never goes through toString(),
    // so it's immune to bytecode compilation either way - args are embedded via JSON instead of
    // the normal evaluate(fn, arg) channel, and the IIFE runs itself without needing Playwright's
    // isFunction flag at all.
    const code = `(() => {
        const wantDigits = ${JSON.stringify(want)};
        const jwtSub = (token) => {
            const parts = String(token || '').split('.');
            if (parts.length !== 3) return null;
            try {
                const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                return payload && payload.sub != null ? String(payload.sub) : null;
            } catch (e) { return null; }
        };
        const findSub = (store) => {
            if (!store) return null;
            for (let i = 0; i < store.length; i++) {
                let v = '';
                try { v = store.getItem(store.key(i)) || ''; } catch (e) { continue; }
                let sub = jwtSub(v);
                if (sub) return sub;
                const m = v.match(/"access_token"\\s*:\\s*"([^"]+)"/);
                if (m) { sub = jwtSub(m[1]); if (sub) return sub; }
            }
            return null;
        };
        let sub = null;
        try { sub = findSub(window.sessionStorage); } catch (e) { }
        if (!sub) { try { sub = findSub(window.localStorage); } catch (e) { } }
        // Coretax moved its session into httpOnly cookies (confirmed live 2026-10-02: no token
        // left in either storage, every switch waited out the full 30s). The account button in
        // the top bar then says who is active: the entity's NPWP plus an IMPERSONATE chip once
        // the switch is done, the PIC's own NIK without it before. (The representative list,
        // which holds every entity's NPWP from the start, is a different element.)
        if (sub === null) {
            const chip = document.querySelector('.tw-profile-imp-chip');
            const btn = (chip && chip.closest('button')) || document.querySelector('.tw-profilebtn-wide');
            if (!btn) return null;
            if (!chip || !btn.contains(chip)) return false;
            // textContent, bukan innerText: di jendela otomasi yang sempit Coretax menyembunyikan teks
            // NPWP/nama di tombol ini (responsif), dan innerText melewatkan teks tersembunyi - live
            // 2026-10-05 hanya terbaca "IMPERSONATE" sehingga impersonate yang sudah berhasil dianggap gagal.
            const npwpEl = btn.querySelector('.tw-profile-npwp');
            sub = (((npwpEl && npwpEl.textContent) || btn.textContent || '').match(/\\d[\\d.\\-\\s]{13,}\\d/) || [''])[0];
            if (!sub) return null;
        }
        // Dua backslash: ini isi template string, jadi satu backslash tunggal akan hilang dan regex
        // di halaman menjadi /D/g (menghapus huruf D, bukan non-angka) - NPWP berformat "05.033.147.3-401.2000"
        // lalu tak pernah cocok dengan 16 digit polos.
        const sDigits = sub.replace(/\\D/g, '');
        const wDigits = wantDigits.replace(/\\D/g, '');
        if (!sDigits || !wDigits) return false;
        if (sDigits === wDigits) return true;
        if (sDigits.length >= 15 && wDigits.length >= 15 && sDigits.slice(0, 15) === wDigits.slice(0, 15)) return true;
        if (sDigits.includes(wDigits) || wDigits.includes(sDigits)) return true;
        return false;
    })()`;
    try {
        return await page.evaluate(code);
    } catch (e) {
        // CONFIRMED LIVE: this consistently throws for the ENTIRE 30s confirm window on some
        // switches, then the visual fallback succeeds immediately after - the switch itself was
        // genuinely fine, this evaluate() just kept losing its execution context (Coretax's
        // post-switch flow does more than one redirect in sequence). Tag that specific failure
        // mode so the caller's poll loop can retry it almost immediately instead of waiting out
        // its normal cadence - the JWT becomes readable the instant the context stabilizes.
        if (/execution context was destroyed|context.*destroyed|target closed/i.test(e.message || '')) {
            const err = new Error('navigating'); err.navigating = true; throw err;
        }
        return null;
    }
}

/** Switches the active impersonated entity (skips entirely for `individual` entities, which
 *  log in with their own NIK and have nothing to impersonate). Returns true on confirmed
 *  success, false if it couldn't confirm within the timeout (caller may still proceed). */
async function switchToEntity(page, cred, { npwp, name, individual, entityCode, userDataDir }) {
    if (individual) {
        log('Entitas ini Individual - tidak perlu impersonate akun perwakilan.');
        return true;
    }
    const target = npwp || name;
    if (!target) { log('Tidak ada NPWP/nama entitas untuk dicari.'); return false; }

    // Fast path: check if target entity is ALREADY active before opening menu
    try {
        const alreadyActive = await verifyImpersonationByCode(page, npwp).catch(() => false);
        if (alreadyActive === true) {
            log('Entitas target ("' + target + '") SUDAH aktif di sesi ini (fast path).');
            return true;
        }
    } catch (e) {}

    await page.bringToFront().catch(() => { });

    const accountPill = await firstVisible(page, [
        page.locator('.user-info, .account-info, [class*="account"], [class*="profile"]').first(),
        page.getByText(cred.username, { exact: false }),
        page.getByText(/IMPERSONATE/i)
    ], 8000);
    if (!accountPill) { log('Tombol akun (pojok kanan atas) tidak ditemukan.'); return false; }

    // Open account menu modal
    await accountPill.dispatchEvent('click').catch(() => { });
    await accountPill.click({ noWaitAfter: true, timeout: 5000, force: true }).catch(() => { });

    // Ensure search input is visible before filling
    const searchInput = page.getByPlaceholder(/Cari NPWP atau nama/i).first();
    let searchVisible = await searchInput.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!searchVisible) {
        // Re-try clicking accountPill if modal didn't open on first click
        await accountPill.click({ timeout: 4000, force: true }).catch(() => { });
        searchVisible = await searchInput.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    }
    if (!searchVisible) { log('Kotak pencarian akun perwakilan tidak ditemukan/terbuka.'); return false; }

    // Cari pakai NPWP dulu; bila barisnya tak muncul, cari pakai nama (tanpa PT/CV dsb., lalu kata
    // pertamanya saja - nama di Taxio Hub bisa beda dengan Coretax, mis. "HIJAU BUMIKU INDAH, PT" vs
    // "HIJAUKU BUMIKU INDAH"). Daftar Coretax menampilkan NPWP di bawah nama, jadi bila NPWP diketahui
    // yang diklik tetap baris ber-NPWP itu - pencarian nama tak bisa memilih entitas yang salah.
    const nameCore = String(name || '').replace(/[.,]/g, ' ').replace(/\b(PT|CV|TBK|PERSERO|FIRMA|UD|KOPERASI)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const queries = [...new Set([npwp, nameCore, nameCore.split(' ')[0]].filter(q => q && q.length >= 3))];
    let entityRow = null;
    for (const query of queries) {
        await searchInput.focus().catch(() => { });
        await searchInput.clear().catch(() => { });
        await searchInput.fill(query);
        await page.waitForTimeout(1000);
        const row = page.getByText(npwp || nameCore, { exact: false }).first();
        if (await row.waitFor({ state: 'visible', timeout: query === queries[0] ? 6000 : 4000 }).then(() => true).catch(() => false)) { entityRow = row; break; }
        log('Pencarian akun perwakilan "' + query + '" tidak menemukan entitas' + (query === queries[queries.length - 1] ? '.' : ' - coba kata kunci lain...'));
    }
    if (!entityRow) { log('Entitas "' + target + '" tidak ditemukan di daftar akun perwakilan.'); return false; }
    await entityRow.click({ timeout: 6000, force: true });

    if (userDataDir && entityCode) {
        try { fs.writeFileSync(path.join(userDataDir, 'last_entity.txt'), String(entityCode).trim()); } catch (e) { }
    }

    log('Menunggu proses impersonasi BENAR-BENAR selesai untuk "' + target + '"...');
    await page.getByPlaceholder(/Cari NPWP atau nama/i).first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => { });
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForTimeout(400);
    let confirmedBy = '';
    const confirmDeadline = Date.now() + 30000;
    // `null` = akun aktif TIDAK terbaca sama sekali (bukan "belum berpindah" - itu `false`), mis.
    // Coretax mengubah tampilan/penyimpanan sesinya. Menunggu 30 detik penuh untuk sesuatu yang tak
    // akan pernah terbaca membuat setiap impersonate terasa macet (dilaporkan live 2026-10-05), jadi
    // setelah ~5 detik terus-menerus tak terbaca langsung pakai konfirmasi teks halaman.
    let unreadable = 0;
    while (Date.now() < confirmDeadline) {
        let codeOk;
        try { codeOk = await verifyImpersonationByCode(page, npwp); }
        catch (e) {
            if (e && e.navigating) { await _sleep(120); continue; }
            codeOk = null;
        }
        if (codeOk === true) { confirmedBy = 'kode (session storage/JWT/tombol akun)'; break; }
        if (codeOk === null) {
            if (++unreadable >= 8) {
                const seen = await page.getByText(target, { exact: false }).first().isVisible({ timeout: 1500 }).catch(() => false);
                if (seen) { confirmedBy = 'teks di halaman (akun aktif tak terbaca)'; break; }
            }
        } else unreadable = 0;
        await _sleep(600);
    }
    if (!confirmedBy) {
        // Which account Coretax's top bar shows as active: tells at once whether the switch never
        // happened or Coretax knows the entity under another number than Taxio Hub's.
        const active = await page.evaluate(`(() => { const b = document.querySelector('.tw-profilebtn-wide'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`).catch(() => null);
        log('[Impersonate] Akun aktif di Coretax: ' + (active || '(tidak terbaca)') + ' - dicari: ' + String(npwp || '').replace(/\D/g, '') + '.');
        const codeState = await verifyImpersonationByCode(page, npwp).catch(() => null);
        if (codeState === null) {
            const seen = await page.getByText(target, { exact: false }).first().isVisible({ timeout: 1500 }).catch(() => false);
            if (seen) confirmedBy = 'teks di halaman (kode tak terbaca)';
        }
    }
    if (confirmedBy) {
        log('Entitas target ("' + target + '") TERKONFIRMASI aktif via ' + confirmedBy + '.');
        return true;
    }
    log('Entitas target ("' + target + '") TIDAK terkonfirmasi dalam 30 detik - dianggap GAGAL (tidak melanjutkan dengan akun yang mungkin salah).');
    return false;
}

/** Full "log in as this PIC, then (if not Individual) impersonate this entity" sequence with
 *  retries - the ONE shared place every automation entry point (e-Bupot download, and the
 *  standalone "Login" action below) goes through, so there's a single definition of how many
 *  attempts/backoff to use and what "success" means (switchToEntity's code-level, JWT-`sub`
 *  confirmation above - never assumed). Previously this retry loop was duplicated inline inside
 *  automation/ebupot.js; extracted here so the new standalone Login button can share the exact
 *  same, already-hardened logic instead of a second copy that could quietly drift out of sync.
 *  `entity` is {entity_id, entity_name, npwp, individual}. Throws with a clear Indonesian
 *  message on final failure; logs progress between attempts via the shared `log`. */
async function loginAndImpersonate(page, cred, entity, picId, opts = {}) {
    const ATTEMPTS = opts.attempts || 3;
    const checkpoint = opts.checkpoint || (async () => {});
    const restricted = !!opts.restricted;
    const passphrase = opts.passphrase || null;
    const allowedEbupotSections = opts.allowedEbupotSections || null;
    attachApiErrorLog(page);

    if (passphrase) {
        log('[Passphrase] Widget salin-passphrase dipasang untuk PIC "' + cred.pic_name + '" (muncul di pojok kanan bawah jendela Chrome).');
        try {
            const passScript = watchdog.buildPassphraseWidgetScript(passphrase);
            if (passScript) {
                await page.context().addInitScript({ content: passScript }).catch(() => {});
                await page.evaluate(passScript).catch(() => {});
            }
        } catch (e) {}
    }

    // Widget "Unduh Lampiran Lengkap" (automation/lampiran.js) - dipasang di sini, BUKAN di
    // masing-masing automation/*.js, supaya SETIAP login (SPT, e-Bupot, tombol Login biasa dsb)
    // otomatis dapat tombolnya begitu user membuka halaman view SPT secara manual sesudahnya -
    // sama persis alasan widget passphrase di atas dipasang di titik ini juga.
    try { await lampiran.installLampiranWidget(page, { entityCode: entity ? require('./entity-folder').folderCode(entity) : undefined, restricted }); } catch (e) {}

    let hideInterval = null;
    if (restricted) {
        await hideWindowOffscreen(page);
        hideInterval = setInterval(() => {
            hideWindowOffscreen(page);
        }, 1500);
    }

    let siteDataCleared = false;
    try {
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            await checkpoint();
            let loggedIn;
            try { loggedIn = await ensureLoggedIn(page, cred); }
            catch (e) {
                if (!e || !e.forcedLogout || siteDataCleared) throw e;
                // Live 2026-10-05: profil Chrome PIC yang usang membuat Coretax mengeluarkan akun tiap
                // kali login, sementara profil baru langsung normal. Bersihkan data situs Coretax di
                // profil ini lalu coba SEKALI lagi.
                siteDataCleared = true;
                await clearCoretaxSiteData(page);
                loggedIn = await ensureLoggedIn(page, cred);
            }
            if (!loggedIn) {
                if (attempt === ATTEMPTS) throw new Error('Gagal login sebagai PIC "' + cred.pic_name + '" setelah ' + ATTEMPTS + ' percobaan.');
                log('Login belum berhasil (percobaan ' + attempt + '/' + ATTEMPTS + ') - coba lagi...');
                await _sleep(3000 * attempt);
                continue;
            }
            const switched = await switchToEntity(page, cred, {
                npwp: entity.npwp, name: entity.entity_name, individual: entity.individual,
                entityCode: entity.entity_id, userDataDir: liveUserDataDir(picId)
            });
            if (switched || entity.individual) {
                if (hideInterval) { clearInterval(hideInterval); hideInterval = null; }
                if (restricted) {
                    try {
                        const lockWatchdog = watchdog.buildWatchdogInitScript(allowedEbupotSections, true, restricted);
                        await page.context().addInitScript({ content: lockWatchdog }).catch(() => {});
                        await page.evaluate(lockWatchdog).catch(() => {});
                    } catch (e) {}
                    await revealWindow(page);
                }
                await page.bringToFront().catch(() => {});
                bringChromeToFrontOnWindows(page);
                return;
            }
            if (attempt === ATTEMPTS) throw new Error('Gagal beralih ke entitas "' + entity.entity_name + '" (impersonate tak terkonfirmasi) setelah ' + ATTEMPTS + ' percobaan - Coretax mungkin sedang lambat.');
            log('Impersonate "' + entity.entity_name + '" belum terkonfirmasi (percobaan ' + attempt + '/' + ATTEMPTS + ') - coba lagi...');
            await _sleep(3000 * attempt);
        }
    } finally {
        if (hideInterval) clearInterval(hideInterval);
    }
}

module.exports = { verifyImpersonationByCode, switchToEntity, loginAndImpersonate };
