/* Coretax Agent - Chrome/Playwright automation primitives.
   Ported from the proven, live-tested logic in Taxio's coretax-helper/run.js (login form
   fill, Altcha checkbox, entity impersonation switch, code-first impersonation verification,
   per-PIC persistent profile + CDP-reuse-for-already-open-window pattern). Deliberately a
   separate profile namespace (.coretax-agent-profile, not .taxio-coretax-profile) so this new
   standalone app never touches or collides with the existing, unmodified coretax-helper.

   Split into composable pieces (ensureLoggedIn / switchToEntity) rather than one big
   handleLogin(), since e-Bupot automation needs the same "get logged in as this PIC,
   impersonating this entity" prefix but a completely different action afterwards (navigate to
   a bupot listing + filter + paginate, instead of navigate to a redirect + download SPT). */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');
const { log } = require('./log');

const { exec } = require('child_process');

function bringChromeToFrontOnWindows() {
    if (process.platform === 'win32') {
        const script = `(New-Object -ComObject WScript.Shell).AppActivate('Chrome')`;
        // windowsHide: true matters here specifically - exec() always launches through cmd.exe,
        // and this runs on every context launch/reuse (several times per run), so without it a
        // console window visibly flashes each time in the packaged exe (which otherwise has none).
        exec(`powershell -Command "${script}"`, { windowsHide: true }, () => { });
    }
}

const CORETAX_LOGIN_URL = 'https://coretaxdjp.pajak.go.id/identityproviderportal/Account/Login';
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');
const PROFILE_ROOT = path.join(os.homedir(), '.coretax-agent-profile');

// Shared with automation/ebupot.js (and any future automation module): set true for the
// duration of an automated row-download click so the context-level manual-download listener
// below can skip it - without this, BOTH the automated code's own download.saveAs(renamed
// path) AND this listener's download.saveAs(original Coretax filename) fire for the exact
// same download event, leaving two copies of every file on disk (one bug report already
// traced back to this missing guard - the original coretax-helper had it as _isAutomatedDownloading).
const downloadFlag = { automated: false };

const ANTI_NAG_FLAGS = [
    '--disable-features=Translate,TranslateUI,PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication',
    '--disable-sync',
    '--password-store=basic',
    '--no-default-browser-check',
    '--no-first-run',

    '--start-maximized'
];

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


function disableAnnoyingPrompts(userDataDir) {
    try {
        const prefsDir = path.join(userDataDir, 'Default');
        fs.mkdirSync(prefsDir, { recursive: true });
        const prefsPath = path.join(prefsDir, 'Preferences');
        let prefs = {};
        if (fs.existsSync(prefsPath)) {
            try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch (e) { prefs = {}; }
        }
        prefs.credentials_enable_service = false;
        prefs.profile = prefs.profile || {};
        prefs.profile.password_manager_enabled = false;
        prefs.profile.password_manager_leak_detection = false;
        prefs.signin = prefs.signin || {}; prefs.signin.allowed = false; prefs.signin.allowed_on_next_startup = false;
        prefs.translate = prefs.translate || {}; prefs.translate.enabled = false;
        prefs.translate_blocked_languages = ['id', 'en'];
        prefs.download = prefs.download || {};
        prefs.download.default_directory = DOWNLOAD_DIR;
        prefs.download.prompt_for_download = false;
        prefs.download.directory_upgrade = true;
        prefs.plugins = prefs.plugins || {};
        prefs.plugins.always_open_pdf_externally = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch (e) {
        log('Tidak bisa menonaktifkan prompt simpan-sandi/terjemahan (bukan fatal): ' + e.message);
    }
}

function portForPic(picId) {
    let hash = 0;
    for (let i = 0; i < picId.length; i++) hash = (hash * 31 + picId.charCodeAt(i)) >>> 0;
    // Different base range from coretax-helper's 9300-9699, so a machine running BOTH tools
    // for the same PIC at once can never collide on the same debug port.
    return 9700 + (hash % 400);
}

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
        if (sub === null) return null;
        return sub.replace(/\\D/g, '') === wantDigits;
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

// The one live manual-login window (Playwright still controls it, we just don't automate the
// login itself). Kept so the GUI can poll its login state and run features on its session.
let manualSession = null; // { context, page }

/** Opens a plain Coretax window for manual use - no credentials, no automation, no impersonate.
 *  The user logs in themselves; because Playwright still owns the window, the GUI can later read
 *  its login state (getManualStatus) and run e-Bupot on whatever account/entity is active there
 *  (runEbupotDownload with manualPage), no PIC/impersonate step. */
async function openCoretaxManual() {
    if (manualSession && manualSession.page && !manualSession.page.isClosed()) {
        await manualSession.page.bringToFront().catch(() => { });
        log('Jendela Coretax manual sudah terbuka - dibawa ke depan.');
        return true;
    }
    const userDataDir = path.join(PROFILE_ROOT, '_manual');
    disableAnnoyingPrompts(userDataDir);
    log('Membuka Coretax untuk login manual (Anda ketik sendiri di jendela yang terbuka)...');
    try {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, channel: 'chrome', viewport: null,
            acceptDownloads: true, downloadsPath: DOWNLOAD_DIR,
            args: ANTI_NAG_FLAGS.slice(), ignoreDefaultArgs: ['--enable-automation']
        });
        context.on('download', async (download) => {
            try { await download.saveAs(path.join(DOWNLOAD_DIR, download.suggestedFilename())); } catch (e) { }
        });
        context.on('close', () => { manualSession = null; log('Jendela Coretax manual ditutup.'); });
        const page = context.pages()[0] || await context.newPage();
        manualSession = { context, page };
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

/** {open, loggedIn, identity} for the GUI's manual-login status poll. */
async function getManualStatus() {
    const open = !!(manualSession && manualSession.context);
    if (!open) return { open: false, loggedIn: false, identity: '' };
    const page = getManualPage();
    if (!page) return { open: true, loggedIn: false, identity: '' };
    const url = page.url();
    const loggedIn = url.indexOf('coretaxdjp.pajak.go.id') !== -1 && url.indexOf('/Account/Login') === -1 && url.indexOf('about:blank') === -1;
    const identity = loggedIn ? await getActiveIdentity(page) : '';
    return { open: true, loggedIn, identity };
}

// Caches the ORIGINAL Playwright-native {context, page} per PIC for the lifetime of this one
// long-running process, since Chrome's profile lock rejects a second launchPersistentContext
// while the first run's window is still open (by design - "Jendela dibiarkan terbuka"), which
// would otherwise force every later action onto the CDP-reconnect fallback below. (The 30s+
// impersonate-confirm slowness and the page-1-only pagination bug LOOKED CDP-related at first,
// but were confirmed live to actually be pkg's bytecode compilation breaking evaluate()
// serialization in the packaged exe - see verifyImpersonationByCode/isNextPageDisabled - and
// reproduced on a freshly-launched, non-CDP context too. This cache is still worth keeping
// since it's cheap and avoids CDP reconnects for a PIC this same process already has open.
const _liveContexts = new Map(); // picId -> { context, page, userDataDir }

/** Launches a fresh Chrome window for this PIC, reuses this process's own cached
 *  context/page if one's already open for it (no CDP round-trip at all), or - only if this
 *  process has no memory of it (e.g. a window left open from a PREVIOUS app run) - falls back
 *  to attaching over CDP. Returns {context, page, reused}. */
async function launchOrReuseContext(picId, onManualDownload) {
    const cached = _liveContexts.get(picId);
    if (cached && !cached.page.isClosed()) {
        log('Menggunakan jendela Chrome yang sudah terbuka untuk PIC ini (proses yang sama, tidak perlu buka/sambung ulang).');
        await cached.page.bringToFront().catch(() => { });
        bringChromeToFrontOnWindows();
        return { context: cached.context, page: cached.page, reused: true, userDataDir: cached.userDataDir };
    }
    if (cached) _liveContexts.delete(picId); // was closed - stale entry, fall through to relaunch

    const userDataDir = path.join(PROFILE_ROOT, picId);
    disableAnnoyingPrompts(userDataDir);
    const debugPort = portForPic(picId);

    log('Membuka Chrome (profil Coretax Agent, terpisah dari profil harian & dari Coretax Helper lama)...');
    try {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'chrome',
            viewport: null,
            acceptDownloads: true,
            downloadsPath: DOWNLOAD_DIR,
            args: ANTI_NAG_FLAGS.concat(['--remote-debugging-port=' + debugPort]),
            ignoreDefaultArgs: ['--enable-automation']
        });
        if (onManualDownload) context.on('download', (download) => { if (!downloadFlag.automated) return onManualDownload(download); });
        const page = context.pages()[0] || await context.newPage();
        await page.bringToFront().catch(() => { });
        bringChromeToFrontOnWindows();
        _liveContexts.set(picId, { context, page, userDataDir });
        context.on('close', () => { const c = _liveContexts.get(picId); if (c && c.context === context) _liveContexts.delete(picId); });
        return { context, page, reused: false, userDataDir };
    } catch (launchErr) {
        log('Chrome tidak mau dibuka baru (' + launchErr.message + ') - mencoba menyambung ke jendela yang sudah terbuka...');
        const existing = await Promise.race([
            chromium.connectOverCDP('http://127.0.0.1:' + debugPort, { timeout: 3000 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('connectOverCDP hard timeout')), 5000))
        ]);
        const context = existing.contexts()[0];
        if (!context) throw new Error('Tidak ada context ditemukan di jendela yang tersambung.');
        const pages = context.pages();
        const page = pages.find(p => p.url().indexOf('coretaxdjp.pajak.go.id') !== -1) || pages[0] || await context.newPage();
        await page.bringToFront().catch(() => { });
        bringChromeToFrontOnWindows();
        // Cache this too - THIS process now knows about it, so the NEXT action against the same
        // PIC (within this same process) can reuse it directly instead of reconnecting via CDP
        // again (the whole point: only ever pay the unreliable-CDP cost once, at most).
        _liveContexts.set(picId, { context, page, userDataDir });
        context.on('close', () => { const c = _liveContexts.get(picId); if (c && c.context === context) _liveContexts.delete(picId); });
        return { context, page, reused: true, userDataDir };
    }
}

/** Fills the login form if needed; no-op (fast path) if the session is already active.
 *  Returns true if we land in a logged-in state either way, false on a hard failure. */
async function ensureLoggedIn(page, cred) {
    bringChromeToFrontOnWindows();
    await page.goto(CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('Memeriksa apakah PIC "' + cred.pic_name + '" sudah dalam keadaan login...');
    await Promise.race([
        page.waitForURL(u => String(u).indexOf('/Account/Login') === -1, { timeout: 4000 }).then(() => 'redirect'),
        page.waitForSelector('#userid', { timeout: 4000 }).then(() => 'login_form')
    ]).catch(() => { });
    const stillOnLoginPage = page.url().indexOf('/Account/Login') !== -1;
    if (!stillOnLoginPage) {
        log('Sesi sudah aktif - lewati login.');
        return true;
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
    await page.waitForURL(u => String(u).indexOf('/Account/Login') === -1, { timeout: 20000 }).catch(() => { });
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
        // A CONFIRMED credential rejection (Coretax's own error text, not just a timing fluke)
        // will fail identically on every retry - the caller's usual 3-attempt/backoff loop is
        // for transient issues (slow page, element not found yet), not "the password is wrong".
        // Throwing this distinct, marked error lets the caller bail immediately instead of
        // burning ~60s re-trying the exact same doomed credential three times.
        if (looksRejected) throw Object.assign(new Error('Kredensial PIC "' + cred.pic_name + '" ditolak Coretax (username/kata sandi salah).'), { credentialRejected: true });
        return false;
    }
    log('Berhasil login.');
    return true;
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

    await searchInput.focus().catch(() => { });
    await searchInput.fill(target);
    await page.waitForTimeout(800);

    const entityRow = page.getByText(target, { exact: false }).first();
    const rowVisible = await entityRow.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (!rowVisible) { log('Entitas "' + target + '" tidak ditemukan di daftar akun perwakilan.'); return false; }
    await entityRow.click({ timeout: 6000, force: true });

    if (userDataDir && entityCode) {
        try { fs.writeFileSync(path.join(userDataDir, 'last_entity.txt'), String(entityCode).trim()); } catch (e) { }
    }

    log('Menunggu proses impersonasi BENAR-BENAR selesai untuk "' + target + '"...');
    await page.getByPlaceholder(/Cari NPWP atau nama/i).first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => { });
    // Impersonate is the ONE step we refuse to assume - proceeding on a half-switched account
    // silently pulls the wrong entity's data. So confirmation REQUIRES the code-level signal:
    // Coretax's own SPA session state (sessionStorage/localStorage, incl. decoded JWT claims)
    // must actually contain the target NPWP. Rendered text alone is NOT accepted (a stale
    // pill/badge from the previous entity can show the right text mid-transition). We also wait
    // for the post-switch reload to settle first, and give it a generous 30s - a slow switch is
    // common and fine, an unconfirmed one is not. Visual text is only a last-resort signal when
    // the code state genuinely can't be read at all (evaluate blocked), logged distinctly.
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForTimeout(400);
    let confirmedBy = '';
    const confirmDeadline = Date.now() + 30000;
    while (Date.now() < confirmDeadline) {
        let codeOk;
        try { codeOk = await verifyImpersonationByCode(page, npwp); }
        catch (e) {
            // Tagged "navigating" (execution context destroyed mid-check) - the page is
            // actively transitioning between the several redirects Coretax's own post-switch
            // flow does; retry almost immediately instead of waiting the normal 600ms so the
            // JWT gets caught the instant the context settles, rather than potentially missing
            // several stable windows between fixed-interval polls.
            if (e && e.navigating) { await _sleep(120); continue; }
            codeOk = null;
        }
        if (codeOk === true) { confirmedBy = 'kode (session storage/JWT)'; break; }
        await _sleep(600);
    }
    if (!confirmedBy) {
        // Code never confirmed. Only if we literally couldn't read the SPA state at all (null,
        // not a definite false) do we fall back to a visual check - otherwise treat as failure.
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

/** True if the page has been kicked back to the login screen (Coretax's session-timeout
 *  behavior mid-run) - checked between rows/pages during long e-Bupot download loops. */
function isLoggedOut(page) {
    return page.url().indexOf('/Account/Login') !== -1 || page.url().indexOf('/identityproviderportal') !== -1 && page.url().indexOf('/Account/Login') !== -1;
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
async function loginAndImpersonate(page, cred, entity, picId, opts) {
    const ATTEMPTS = (opts && opts.attempts) || 3;
    const checkpoint = (opts && opts.checkpoint) || (async () => {});
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        await checkpoint();
        // ensureLoggedIn THROWS (rather than returning false) for a CONFIRMED credential
        // rejection (Coretax's own error text, not a timing fluke) - that propagates straight
        // out of this loop with no retry, per explicit direction: a wrong password will fail
        // identically every time, so don't burn the usual 3-attempt/backoff budget on it.
        const loggedIn = await ensureLoggedIn(page, cred);
        if (!loggedIn) {
            if (attempt === ATTEMPTS) throw new Error('Gagal login sebagai PIC "' + cred.pic_name + '" setelah ' + ATTEMPTS + ' percobaan.');
            log('Login belum berhasil (percobaan ' + attempt + '/' + ATTEMPTS + ') - coba lagi...');
            await _sleep(3000 * attempt);
            continue;
        }
        const switched = await switchToEntity(page, cred, {
            npwp: entity.npwp, name: entity.entity_name, individual: entity.individual,
            entityCode: entity.entity_id, userDataDir: path.join(PROFILE_ROOT, picId)
        });
        if (switched || entity.individual) return;
        if (attempt === ATTEMPTS) throw new Error('Gagal beralih ke entitas "' + entity.entity_name + '" (impersonate tak terkonfirmasi) setelah ' + ATTEMPTS + ' percobaan - Coretax mungkin sedang lambat.');
        log('Impersonate "' + entity.entity_name + '" belum terkonfirmasi (percobaan ' + attempt + '/' + ATTEMPTS + ') - coba lagi...');
        await _sleep(3000 * attempt);
    }
}

module.exports = {
    CORETAX_LOGIN_URL, DOWNLOAD_DIR, PROFILE_ROOT, downloadFlag,
    firstVisible, clickAltchaCheckbox, verifyImpersonationByCode,
    openCoretaxManual, getManualPage, getManualStatus, launchOrReuseContext, ensureLoggedIn, switchToEntity,
    loginAndImpersonate, isLoggedOut, _sleep
};
