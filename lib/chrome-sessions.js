/* Chrome automation primitives: the live Chrome windows this process owns - the manual-login
 * window and the per-PIC automation windows (launch or reuse), their status for the GUI, and
 * listing / focusing / closing them. Owns manualSession and _liveContexts. Split out of
 * lib/chrome.js (still the public entry point). */
const path = require('path');
const { chromium } = require('playwright');
const { log } = require('./log');
const runcontrol = require('./runcontrol');
const uiEvents = require('./ui-events'); // jendela dibuka / ditutup -> dashboard memuat ulang daftar sesi segera
const watchdog = require('./coretax-watchdog');
const lampiran = require('../automation/lampiran');
const { bringChromeToFrontOnWindows, hideWindowOffscreen } = require('./chrome-window');
const { DOWNLOAD_DIR, _nativeDownloads, useNativeDownloads, isAutomatedDownload, installBillingBlobDownloadBridge } = require('./chrome-downloads');
const { browserLaunch, ANTI_NAG_FLAGS, noWpadFlags, disableAnnoyingPrompts, _normDir, terminateProfileProcesses } = require('./chrome-profile');
const { CORETAX_LOGIN_URL } = require('./chrome-login');

function _setupBlockedHitTracking(context, page, picId) {
    try {
        context.exposeFunction('__ca_onBlockedHit', (url) => {
            log('[PERINGATAN KEAMANAN] Akun Terbatas mencoba mengakses URL diblokir: ' + url + ' (PIC: ' + picId + ')');
        }).catch(() => {});
    } catch (e) {}
}

// The one live manual-login window (Playwright still controls it, we just don't automate the
// login itself). Kept so the GUI can poll its login state and run features on its session.
let manualSession = null; // { context, page, userDataDir }

/** Opens a plain Coretax window for manual use - no credentials, no automation, no impersonate.
 *  The user logs in themselves; because Playwright still owns the window, the GUI can later read
 *  its login state (getManualStatus) and run e-Bupot on whatever account/entity is active there
 *  (runEbupotDownload with manualPage), no PIC/impersonate step. */
async function openCoretaxManual(restricted = false, allowedEbupotSections = null) {
    if (manualSession && manualSession.page && !manualSession.page.isClosed()) {
        await manualSession.page.bringToFront().catch(() => { });
        log('Jendela Coretax manual sudah terbuka - dibawa ke depan.');
        return true;
    }
    const { options: browserOptions, userDataDir } = await browserLaunch('_manual');
    disableAnnoyingPrompts(userDataDir);
    log('Membuka Coretax untuk login manual (Anda ketik sendiri di jendela yang terbuka)...');
    try {
        const extraFlags = restricted ? ['--window-position=-32000,-32000'] : [];
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, ...browserOptions, viewport: null,
            acceptDownloads: true, downloadsPath: DOWNLOAD_DIR,
            args: ANTI_NAG_FLAGS.concat(noWpadFlags(), extraFlags), ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'], chromiumSandbox: true
        });

        const watchdogScript = watchdog.buildWatchdogInitScript(allowedEbupotSections, false, restricted);
        await context.addInitScript({ content: watchdogScript }).catch(() => {});
        watchdog.installNetworkGuard(context, allowedEbupotSections, restricted, (url) => log('[SECURITY] Diblokir di lapisan jaringan: ' + url));

        context.on('download', async (download) => {
            if (_nativeDownloads.has(context) && !isAutomatedDownload(context)) return; // Chrome sendiri yang menyimpan
            try { await download.saveAs(path.join(DOWNLOAD_DIR, download.suggestedFilename())); } catch (e) { }
        });
        context.on('close', () => { manualSession = null; log('Jendela Coretax manual ditutup.'); uiEvents.emit('sessions'); });
        const page = context.pages()[0] || await context.newPage();
        manualSession = { context, page, userDataDir };
        uiEvents.emit('sessions');
        await useNativeDownloads(context);
        await installBillingBlobDownloadBridge(context, page);
        // Sesi manual tidak pernah lewat loginAndImpersonate() (user login/impersonate sendiri
        // di jendela ini) - widget Lampiran perlu dipasang di sini juga, bukan cuma di jalur
        // otomatis, supaya tombolnya tetap muncul untuk pemakaian manual seperti ini.
        try { await lampiran.installLampiranWidget(page, {}); } catch (e) {}
        await page.goto(CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { });
        log('Jendela Coretax siap - silakan login manual. GUI akan otomatis mendeteksi begitu Anda berhasil login.');
        return true;
    } catch (e) {
        log('Gagal membuka Coretax manual: ' + e.message + ' - kemungkinan jendela profil "manual" sudah terbuka; cek taskbar Anda.');
        return false;
    }
}

/** Returns the most relevant tab of the manual window - scans ALL tabs (Coretax may open the
 *  dashboard/eBupot in a new tab, not the one we started on), preferring a Coretax tab that's
 *  past the login screen. */
function getManualPage() {
    if (!manualSession || !manualSession.context) return null;
    let pages = [];
    try { pages = manualSession.context.pages().filter((p) => !p.isClosed()); } catch (e) { }
    if (!pages.length) return null;
    const loggedInTab = pages.find((p) => p.url().indexOf('coretaxdjp.pajak.go.id') !== -1 && p.url().indexOf('/Account/Login') === -1);
    if (loggedInTab) return loggedInTab;
    const anyCoretax = pages.find((p) => p.url().indexOf('coretaxdjp.pajak.go.id') !== -1);
    return anyCoretax || pages[0];
}

/** Best-effort read of who's active in the manual window (NPWP + name from the top account
 *  pill). Heuristic - Coretax's header markup isn't fixed - so it's only for display; the run
 *  itself works regardless of whether we could name the account. */
async function getActiveIdentity(page) {
    // Self-invoking STRING, not a function reference - see the comment in verifyImpersonationByCode
    // for why (pkg's packaged exe compiles this file to bytecode, which breaks Function.toString()
    // based serialization for real function references, but never touches string literals).
    const code = `(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const bad = /impersonate|coretax|djp|beranda|portal|masuk|keluar|selamat|cari layanan|dashboard|profil|logout|^indonesia$|wajib pajak|pengguna/i;
        const npwpRe = /\\b\\d{15,16}\\b/;
        const fullText = document.body.innerText || '';
        const npwpMatch = fullText.match(npwpRe);
        const npwp = npwpMatch ? npwpMatch[0] : '';
        const lines = fullText.split('\\n').map(clean).filter(Boolean);
        let name = '';
        const npwpIdx = npwp ? lines.findIndex((l) => l.indexOf(npwp) !== -1) : -1;
        const scan = npwpIdx >= 0 ? lines.slice(Math.max(0, npwpIdx - 2), npwpIdx + 4) : lines.slice(0, 30);
        for (const l of scan) {
            const t = l.replace(npwp, '').trim();
            if (t.length >= 3 && t.length < 70 && /[A-Za-z]{3,}/.test(t) && !bad.test(t) && !/^\\d+$/.test(t)) { name = t; break; }
        }
        return [npwp, name].filter(Boolean).join(' · ');
    })()`;
    try {
        return await page.evaluate(code);
    } catch (e) { return ''; }
}

/** {open, loggedIn, identity} untuk sebuah page Playwright yang sudah ada - dipakai bersama oleh
 *  getManualStatus (sesi polos) dan getEntityStatus (jendela per-PIC otomatis) di bawah, supaya
 *  tombol "segarkan status" di GUI bisa membaca siapa yang BENAR-BENAR sedang login sekarang,
 *  bukan cuma menebak dari histori aksi terakhir (lib/login-status.js). */
async function statusForPage(page) {
    if (!page) return { open: false, loggedIn: false, identity: '' };
    const url = page.url();
    // /identityproviderportal (Pilih Akun, Logout, dsb.) adalah halaman identitas, bukan portal: halaman
    // "Anda Telah Keluar" dulu terbaca sebagai "sudah login" dan sesinya tampil hijau di tab sesi.
    const loggedIn = url.indexOf('coretaxdjp.pajak.go.id') !== -1 && url.indexOf('/Account/Login') === -1 && url.indexOf('/identityproviderportal') === -1 && url.indexOf('about:blank') === -1;
    const identity = loggedIn ? await getActiveIdentity(page) : '';
    return { open: true, loggedIn, identity };
}

/* Dashboard polls (manual status every 2 s, session list every 4 s) used to end in a full
 * document.body.innerText read of every live Coretax window, all the time - also while automation was
 * driving those same pages. cachedStatusForPage() keeps each page's last status for STATUS_CACHE_MS
 * (same URL), and while a run is active on that page's session (lib/runcontrol.js isBusy) it reuses the
 * last one instead of reading the page again. Concurrent callers share one read. Only the polls use it;
 * the explicit "refresh status" button (getEntityStatus) still reads the page now. */
const STATUS_CACHE_MS = 4000;
const _statusCache = new WeakMap(); // page -> { at, url, value, pending }
function _pageUrl(page) { try { return page.url(); } catch (e) { return ''; } }
async function cachedStatusForPage(page, sessionKey) {
    if (!page) return statusForPage(page);
    const hit = _statusCache.get(page);
    if (hit && hit.pending) return hit.pending.then((v) => Object.assign({}, v));
    const busy = !!sessionKey && runcontrol.isBusy(sessionKey);
    if (hit && hit.value && (busy || (Date.now() - hit.at < STATUS_CACHE_MS && hit.url === _pageUrl(page)))) return Object.assign({}, hit.value);
    const entry = { at: 0, url: _pageUrl(page), value: hit && hit.value, pending: null };
    entry.pending = statusForPage(page).then((value) => { entry.value = value; entry.at = Date.now(); return value; })
        .finally(() => { entry.pending = null; });
    _statusCache.set(page, entry);
    return entry.pending.then((v) => Object.assign({}, v));
}

/** {open, loggedIn, identity} for the GUI's manual-login status poll. `opts.cached`: the dashboard poll
 *  (see cachedStatusForPage); other callers (start of a manual run) read the page as before. */
async function getManualStatus(opts) {
    const open = !!(manualSession && manualSession.context);
    if (!open) return { open: false, loggedIn: false, identity: '' };
    return opts && opts.cached ? cachedStatusForPage(getManualPage(), 'manual') : statusForPage(getManualPage());
}

/** Sama seperti getManualStatus tapi untuk jendela otomatis (Taxio Hub ATAU entitas lokal
 *  berkredensial) yang sedang terbuka untuk PIC ini di proses ini - dipakai tombol "segarkan
 *  status" di topbar supaya pengguna bisa mengecek ulang identitas yang aktif sekarang tanpa
 *  menunggu aksi baru. Tidak membuka jendela baru: kalau belum ada yang terbuka untuk PIC ini,
 *  cukup bilang {open:false} - biarkan pengguna klik "Masuk Coretax" dulu. */
async function getEntityStatus(picId) {
    return statusForPage(getLiveEntityPage(picId));
}

// Caches the ORIGINAL Playwright-native {context, page} per PIC for the lifetime of this one
// long-running process, since Chrome's profile lock rejects a second launchPersistentContext
// while the first run's window is still open (by design - "Jendela dibiarkan terbuka"), which
// would otherwise force every later action onto the leftover-window fallback below (formerly a
// CDP reconnect, now closing the leftover Chrome - which must never hit a window THIS process
// still owns, hence the cache). (The 30s+
// impersonate-confirm slowness and the page-1-only pagination bug LOOKED CDP-related at first,
// but were confirmed live to actually be pkg's bytecode compilation breaking evaluate()
// serialization in the packaged exe - see verifyImpersonationByCode/isNextPageDisabled - and
// reproduced on a freshly-launched, non-CDP context too. This cache is still worth keeping
// since it's cheap and avoids CDP reconnects for a PIC this same process already has open.
const _liveContexts = new Map(); // picId -> { context, page, userDataDir }

/** Closes every Chrome window this process has opened - the per-PIC automation windows
 *  (_liveContexts) AND the manual-login session (manualSession), if any. These are launched via
 *  chromium.launchPersistentContext(), a genuinely separate OS process from this Node process -
 *  quitting Coretax Agent (process.exit()) does NOT touch them on its own, so any window left
 *  open (including a restricted editor's hidden off-screen one) survives as an orphan process
 *  after "quit" unless this is called first. Confirmed live 2026-07-27: the app's own dashboard/
 *  tray closed fine, but a Chrome window opened earlier for an impersonate test kept running. */
async function closeAllAutomationWindows() {
    const contexts = [...Array.from(_liveContexts.values()).map((c) => c.context)];
    if (manualSession && manualSession.context) contexts.push(manualSession.context);
    _liveContexts.clear();
    manualSession = null;
    await Promise.all(contexts.map((ctx) => ctx.close().catch(() => {})));
}

function getLiveEntityPage(picId) {
    const cached = _liveContexts.get(picId);
    if (cached && cached.page && !cached.page.isClosed()) {
        return cached.page;
    }
    return null;
}

/** Semua jendela Chrome yang proses ini punya SEKARANG - satu per PIC yang pernah dipakai
 *  (_liveContexts), plus sesi manual polos kalau sedang terbuka. Dipakai GUI untuk menampilkan
 *  daftar "sesi Coretax aktif" (bisa lebih dari satu terbuka bersamaan). Jendela yang sudah
 *  ditutup (oleh pengguna langsung, bukan lewat app) sudah otomatis tersingkir dari
 *  _liveContexts/manualSession lewat listener 'close' masing-masing (lihat launchOrReuseContext
 *  dan openCoretaxManual) - daftar ini jadi selalu mencerminkan kondisi NYATA saat ini, tanpa
 *  perlu polling terus-menerus dari sisi sini. */
async function listLiveSessions() {
    const entries = Array.from(_liveContexts.entries()).filter(([, c]) => c.page && !c.page.isClosed());
    const sessions = await Promise.all(entries.map(async ([picId, c]) => {
        const st = await cachedStatusForPage(c.page, picId).catch(() => ({ open: true, loggedIn: false, identity: '' }));
        return { picId, kind: 'entity', open: true, loggedIn: st.loggedIn, identity: st.identity };
    }));
    if (manualSession && manualSession.context) {
        const st = await getManualStatus({ cached: true });
        sessions.push({ picId: 'manual', kind: 'manual', open: st.open, loggedIn: st.loggedIn, identity: st.identity });
    }
    return sessions;
}

/** Membawa satu jendela sesi ke depan (dobel klik taskbar). page.bringToFront() saja TIDAK
 *  cukup - itu cuma mengaktifkan tab di dalam Chrome-nya sendiri lewat CDP, tidak mengangkat
 *  jendela Chrome itu ke depan window lain di Windows (termasuk jendela app ini sendiri) -
 *  bringChromeToFrontOnWindows() (AppActivate) yang melakukan itu, sama seperti dipakai
 *  berpasangan di launchOrReuseContext. Ini TIDAK menyingkap posisi jendela yang sengaja
 *  disembunyikan off-screen untuk Restricted Editor - hanya Z-order fokusnya yang berubah,
 *  posisinya tetap di luar layar (revealWindow, yang memindahkan posisi, tetap dipakai secara
 *  eksplisit hanya di alur login, bukan di sini). */
async function bringSessionToFront(picId) {
    const page = picId === 'manual' ? getManualPage() : getLiveEntityPage(picId);
    if (!page) return false;
    await page.bringToFront().catch(() => {});
    bringChromeToFrontOnWindows(page);
    return true;
}

/** Folder profil Chrome yang jendelanya sedang dibuka proses ini (per PIC + sesi manual) - perawatan profil
 *  (lib/profile-housekeeping.js) tidak pernah menghapusnya. */
function openProfileDirs() {
    const dirs = Array.from(_liveContexts.values()).map((c) => c.userDataDir).filter(Boolean);
    if (manualSession && manualSession.userDataDir) dirs.push(manualSession.userDataDir);
    return dirs;
}

/** Menutup satu sesi dari daftar - context.close() memicu listener 'close' yang sudah ada
 *  (hapus dari _liveContexts / manualSession = null), sama seperti kalau pengguna menutup
 *  jendelanya sendiri lewat tombol X Windows. */
async function closeLiveSession(picId) {
    const ctx = picId === 'manual' ? (manualSession && manualSession.context) : (_liveContexts.get(picId) && _liveContexts.get(picId).context);
    if (!ctx) return false;
    await ctx.close().catch(() => {});
    return true;
}

/** Launches a fresh Chrome window for this PIC, or reuses this process's own cached
 *  context/page if one's already open for it. If the launch fails because a window from a
 *  PREVIOUS app run still holds the PIC's profile, that leftover Chrome is closed and the launch
 *  retried once (it used to be re-attached over a per-PIC CDP port, removed 2026-11-12 - see
 *  terminateProfileProcesses). Returns {context, page, reused}. */
async function launchOrReuseContext(picId, onManualDownload, restricted = false, allowedEbupotSections = null) {
    runcontrol.assertWindowFree(picId);
    const cached = _liveContexts.get(picId);
    if (cached && cached.page.isClosed()) {
        // The tab we tracked was closed but this process's Chrome for the PIC is still open
        // (another tab, e.g. one Coretax opened itself): adopt that tab. Relaunching instead would
        // hit our OWN profile lock - and the leftover-window cleanup below must never be pointed
        // at a Chrome this process still owns.
        let open = [];
        try { open = cached.context.pages().filter((p) => !p.isClosed()); } catch (e) { /* context gone */ }
        if (open.length) cached.page = open.find((p) => p.url().indexOf('coretaxdjp.pajak.go.id') !== -1) || open[0];
    }
    if (cached && !cached.page.isClosed()) {
        await installBillingBlobDownloadBridge(cached.context, cached.page);
        await useNativeDownloads(cached.context);
        log('Menggunakan jendela Chrome yang sudah terbuka untuk PIC ini (proses yang sama, tidak perlu buka/sambung ulang).');
        // lockImpersonate=false here on purpose: this window is about to go through switchToEntity
        // again (possibly to a DIFFERENT entity than whatever it's currently on) - locking the
        // switcher now would block the automation's own click before it gets a chance to run.
        // loginAndImpersonate re-locks it once a switch is actually confirmed. Safe because the
        // window is off-screen for the whole unlocked window (see hideWindowOffscreen just below).
        const watchdogScript = watchdog.buildWatchdogInitScript(allowedEbupotSections, false, restricted);
        await cached.context.addInitScript({ content: watchdogScript }).catch(() => {});
        await cached.page.evaluate(watchdogScript).catch(() => {});
        watchdog.installNetworkGuard(cached.context, allowedEbupotSections, restricted, (url) => log('[PERINGATAN KEAMANAN] Diblokir di lapisan jaringan: ' + url + ' (PIC: ' + picId + ')'));

        if (!restricted) {
            await cached.page.bringToFront().catch(() => { });
            bringChromeToFrontOnWindows(cached.page);
        } else {
            await hideWindowOffscreen(cached.page);
        }
        return { context: cached.context, page: cached.page, reused: true, userDataDir: cached.userDataDir };
    }
    if (cached) _liveContexts.delete(picId); // was closed - stale entry, fall through to relaunch

    const { options: browserOptions, userDataDir } = await browserLaunch(picId);
    disableAnnoyingPrompts(userDataDir);

    log('Membuka Chrome (profil Taxio Pilot, terpisah dari profil harian)...');
    log('[SECURITY] Status Restricted Editor: ' + (restricted ? 'AKTIF (Off-Screen & Watchdog Terkunci)' : 'TIDAK AKTIF (Mode Bebas/Admin)'));
    // No --remote-debugging-port any more (see the "Leftover Chrome" comment above
    // userDataDirFromCommandLine): Playwright talks to its own Chrome over a private pipe.
    const extraFlags = restricted ? ['--window-position=-32000,-32000'] : [];
    const launchContext = () => chromium.launchPersistentContext(userDataDir, {
        headless: false,
        ...browserOptions,
        viewport: null,
        acceptDownloads: true,
        downloadsPath: DOWNLOAD_DIR,
        args: ANTI_NAG_FLAGS.concat(noWpadFlags(), extraFlags),
        ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'], chromiumSandbox: true
    });
    // Only the launch itself goes through the leftover-window fallback: a failure in the setup
    // steps below happens on a Chrome THIS call just opened, which must not be "cleaned up" as
    // a leftover.
    let context;
    try {
        context = await launchContext();
    } catch (launchErr) {
        if (restricted) {
            throw new Error('Gagal membuka Chrome baru untuk akun terbatas: ' + launchErr.message);
        }
        // Most common cause: a Chrome window for this PIC left over from a PREVIOUS app run
        // (crash, Task Manager kill) still holds the profile - close exactly those processes
        // and try once more.
        log('Chrome tidak mau dibuka baru (' + launchErr.message + ') - memeriksa jendela Chrome sisa sesi sebelumnya untuk PIC ini...');
        const ownsIt = Array.from(_liveContexts.values()).some((c) => c.userDataDir && _normDir(c.userDataDir) === _normDir(userDataDir));
        const killed = ownsIt ? 0 : await terminateProfileProcesses(userDataDir).catch((e) => { log('Gagal menutup Chrome sisa: ' + e.message); return 0; });
        if (!killed) {
            throw new Error('Gagal membuka Chrome untuk PIC ini (' + launchErr.message + '). Bila masih ada jendela Coretax dari sesi Taxio Pilot sebelumnya, tutup jendela itu lalu coba lagi.');
        }
        try {
            context = await launchContext();
            log('Chrome sisa sesi sebelumnya ditutup - jendela baru untuk PIC ini berhasil dibuka.');
        } catch (retryErr) {
            throw new Error('Gagal membuka Chrome untuk PIC ini (' + retryErr.message + '). Tutup jendela Coretax yang tersisa dari sesi Taxio Pilot sebelumnya (cek taskbar), lalu coba lagi.');
        }
    }

    {
        // lockImpersonate=false at initial launch, same reasoning as the reused-context branch
        // above: loginAndImpersonate's switchToEntity hasn't run yet, so the switcher must stay
        // usable BY THE AUTOMATION until a switch is confirmed, at which point it gets re-locked.
        const watchdogScript = watchdog.buildWatchdogInitScript(allowedEbupotSections, false, restricted);
        await context.addInitScript({ content: watchdogScript }).catch(() => {});
        watchdog.installNetworkGuard(context, allowedEbupotSections, restricted, (url) => log('[PERINGATAN KEAMANAN] Diblokir di lapisan jaringan: ' + url + ' (PIC: ' + picId + ')'));

        // Unduhan manual disimpan Chrome sendiri (useNativeDownloads); handler lama hanya bila itu gagal.
        if (onManualDownload) context.on('download', (download) => { if (!isAutomatedDownload(context) && !_nativeDownloads.has(context)) return onManualDownload(download); });
        const page = context.pages()[0] || await context.newPage();
        await useNativeDownloads(context);
        await installBillingBlobDownloadBridge(context, page);
        if (restricted) await page.evaluate(watchdogScript).catch(() => {});
        _setupBlockedHitTracking(context, page, picId);

        if (!restricted) {
            await page.bringToFront().catch(() => { });
            bringChromeToFrontOnWindows(page);
        } else {
            await hideWindowOffscreen(page);
        }
        _liveContexts.set(picId, { context, page, userDataDir });
        context.on('close', () => { const c = _liveContexts.get(picId); if (c && c.context === context) _liveContexts.delete(picId); uiEvents.emit('sessions'); });
        uiEvents.emit('sessions');
        return { context, page, reused: false, userDataDir };
    }
}

module.exports = {
    openCoretaxManual, getManualPage, getActiveIdentity, statusForPage, cachedStatusForPage, getManualStatus, getEntityStatus,
    _liveContexts, openProfileDirs, closeAllAutomationWindows, getLiveEntityPage, listLiveSessions, bringSessionToFront, closeLiveSession,
    launchOrReuseContext
};
