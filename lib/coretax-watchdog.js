/* Coretax Agent - Watchdog & Security Layer (URL blacklist/whitelist, zone model, overlay, menu lock).
   Protects Restricted Editor accounts from navigating to unauthorized Coretax portals, switching entities,
   or viewing restricted pages. */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'watchdog.json');

const DEFAULT_BLACKLIST = [
    'case-management-portal',
    'case-management',
    'casemanagement',
    'user-management-portal',
    'user-management',
    'usermanagement',
    'password-change',
    'passwordchange',
    'changepassword',
    'change-password',
    'resetpassword',
    'reset-password',
    'password',
    'katasandi',
    'kata-sandi',
    'ubah-kata-sandi',
    'ganti-kata-sandi',
    'article-21-26-tax-return',
    'article-21',
    'article21',
    'pph21',
    'pph-21',
    'ebupotbpmp',
    'ebupotmp',
    'ebupot-mp',
    'Bukti Pemotongan Bulanan Pegawai Tetap',
    'ebupotbpa1',
    'ebupotbpa2',
    'bpa1',
    'bpa2',
    'Bukti Pemotongan A1',
    'Bukti Pemotongan A2',
    'Pemotongan A1',
    'Pemotongan A2',
    'notifikasi',
    "notification",
    'pengukuhan-pkp',
    'pbb-p5l',
    'penghapusan-pencabutan',
    'my-representatives',
    'my-taxpayers',
    'two-fa-configuration'
];

// Empty on purpose (2026-07-23): registration-portal/my-profile is open by default now - see
// REGISTRATION_EXPLICIT_BLOCKED_SUBS in buildWatchdogInitScript for the 3 routes that stay
// blocked instead. A non-empty zone here is a SEPARATE default-deny mechanism from that list
// (checkUrl's own ZONES loop) - having both caused "my-profile" itself to stay blocked even after
// REGISTRATION_EXPLICIT_BLOCKED_SUBS was fixed to allow it, since the bare my-profile landing page
// doesn't match any of a zone's own allow-listed sub-items.
const DEFAULT_ZONES = {};

const UNRESTRICTED_PORTALS = [
    'e-invoice-portal',
    'payment-portal',
    'accounting-portal',
    'taxpayer-services-portal'
];

const EBUPOT_WHITELIST_ALL = ['21-26', '22', '23', 'unification', 'non-resident'];

function loadWatchdogConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                blacklistPatterns: parsed.blacklistPatterns || DEFAULT_BLACKLIST,
                zones: parsed.zones || DEFAULT_ZONES
            };
        }
    } catch (e) {}
    return {
        blacklistPatterns: DEFAULT_BLACKLIST,
        zones: DEFAULT_ZONES
    };
}

// Node-side mirror of buildWatchdogInitScript's isEbupotSectionAllowed - needed here (not just
// in-page) because installNetworkGuard() runs in Node via context.route(), which sees raw
// request bodies before they ever reach a page's JS, unlike the in-page watchdog which can only
// react to clicks/navigation and never saw a bare fetch()/XHR to begin with.
function isEbupotTypeAllowedForNetworkGuard(ebupotType, allowedEbupotSections) {
    const allowed = allowedEbupotSections || EBUPOT_WHITELIST_ALL;
    const str = String(ebupotType || '').toLowerCase();
    // Absolute block, not admin-configurable via allowedEbupotSections - explicit user request
    // 2026-08-10 (BPMP promoted from allowlist-gated to absolute, same treatment BPA1/BPA2
    // already had).
    if (str.includes('bpa1') || str.includes('bpa2') || str.includes('bpmp') || str === 'ebupotmp') return false;
    if (str.includes('bpnr') || str.includes('bp26')) {
        return allowed.some(s => ['bpnr', 'bp26', 'non-resident', '26'].includes(String(s).toLowerCase()));
    }
    return true;
}

// Coretax loads shared lookup values (including PERIOD for the Masa Pajak dropdown) through
// one combined reference-data URL. That URL also names lookup groups for BPA1/BPA2/BPMP, so a
// raw substring blacklist would block the whole response and accidentally remove otherwise
// allowed BPU periods. This exception is deliberately limited to the official Coretax host and
// the read-only current-reference-data path; transactional portal/API URLs remain blacklisted.
function isSafeSharedReferenceDataUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:'
            && parsed.hostname.toLowerCase() === 'coretaxdjp.pajak.go.id'
            && parsed.pathname.toLowerCase().startsWith('/referencedata/api/currentreferencedata/');
    } catch (e) {
        return false;
    }
}

function shouldBlockUrlByBlacklist(url, blacklistPatterns) {
    if (isSafeSharedReferenceDataUrl(url)) return false;
    const urlLow = String(url || '').toLowerCase();
    return (blacklistPatterns || []).some((pattern) => urlLow.includes(String(pattern).toLowerCase()));
}

/**
 * Blocks disallowed requests at the network layer itself (Playwright context.route()), not just
 * clicks/navigation - closes the gap where a restricted editor with DevTools access to the
 * automation's Chrome window (or anything else capable of firing a raw fetch/XHR) could call
 * Coretax's own API directly for a blacklisted URL or a disallowed e-Bupot type, bypassing the
 * in-page watchdog entirely since it only reacts to clicks and SPA navigation. Confirmed live
 * 2026-07-27: a manual fetch() to GetMyWithholdingSlip with EbupotType:'EBUPOTMP' reached the
 * real server with zero interception when only the in-page watchdog was active.
 * @param {import('playwright').BrowserContext} context
 * @param {Array<string>|null} allowedEbupotSections
 * @param {boolean} isRestricted
 * @param {(url: string) => void} [onBlockedHit]
 */
function installNetworkGuard(context, allowedEbupotSections = null, isRestricted = true, onBlockedHit = null) {
    if (!isRestricted) return;
    const config = loadWatchdogConfig();
    const blacklist = config.blacklistPatterns.map((p) => String(p).toLowerCase());

    context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();

        if (shouldBlockUrlByBlacklist(url, blacklist)) {
            if (onBlockedHit) { try { onBlockedHit(url); } catch (e) {} }
            return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Blocked by Coretax Agent restricted-editor policy.' }) });
        }

        if (req.method() === 'POST') {
            let ebupotType = null;
            try {
                const postData = req.postData();
                if (postData) ebupotType = JSON.parse(postData).EbupotType || null;
            } catch (e) {}
            if (ebupotType && !isEbupotTypeAllowedForNetworkGuard(ebupotType, allowedEbupotSections)) {
                if (onBlockedHit) { try { onBlockedHit(url + ' (EbupotType: ' + ebupotType + ')'); } catch (e) {} }
                return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Blocked: jenis e-Bupot ini di luar akses Restricted Editor Anda.' }) });
            }
        }

        return route.continue();
    });
}

/**
 * Builds the injectable script string for Playwright page.addInitScript()
 * @param {Array<string>|null} allowedEbupotSections
 * @param {boolean} lockImpersonate
 * @param {boolean} isRestricted
 */
function buildWatchdogInitScript(allowedEbupotSections = null, lockImpersonate = false, isRestricted = true) {
    const config = loadWatchdogConfig();
    const blacklist = JSON.stringify(config.blacklistPatterns);
    const zones = JSON.stringify(config.zones);
    const unrestricted = JSON.stringify(UNRESTRICTED_PORTALS);
    const ebupotAllowed = JSON.stringify(allowedEbupotSections || EBUPOT_WHITELIST_ALL);
    const doIsRestricted = !!isRestricted;
    // NOT `|| doIsRestricted` - lockImpersonate is a genuinely separate, caller-controlled stage
    // (unlocked while the automation itself still needs to click through switchToEntity, locked
    // only once loginAndImpersonate has confirmed a switch). Forcing it true for every restricted
    // account regardless of the caller's intent made the automation's own impersonate click get
    // blocked by the click-interceptor below before it ever got a chance to run.
    const doLockImpersonate = !!lockImpersonate;

    return `(() => {
        const IS_RESTRICTED = ${doIsRestricted};
        if (!IS_RESTRICTED) return;

        // Nothing to protect on Coretax's own login page (no case data, no impersonate menu,
        // Coretax itself won't let an unauthenticated session reach any other portal page) - and
        // staying off it entirely removes any chance of the capturing-phase click/mousedown/
        // pointerdown interceptors or the 50ms polling loop interfering with the Altcha
        // checkbox / credential form during automated login.
        if (/\\/account\\/login/i.test(window.location.pathname)) return;

        // Re-entry setup: update the lock state and trigger check immediately if already active
        if (window.__ca_watchdog_active) {
            window.__ca_lock_impersonate = ${doLockImpersonate};
            if (typeof disableBlockedElements === 'function') {
                disableBlockedElements();
            }
            return;
        }

        window.__ca_watchdog_active = true;
        window.__ca_lock_impersonate = ${doLockImpersonate};

        const BLACKLIST_PATTERNS = ${blacklist};
        const ZONES = ${zones};
        const UNRESTRICTED_PORTALS = ${unrestricted};
        const EBUPOT_ALLOWED = ${ebupotAllowed};
        const SAFE_FALLBACK_URL = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbp21/issued';

        const PORTAL_SAYA_BLOCKED_LABELS = [
            'notifikasi saya',
            'kasus saya',
            'kasus berjalan saya',
            'pengukuhan pkp',
            'pendaftaran objek pajak pbb p5l',
            'penghapusan & pencabutan',
            'perubahan data',
            'identitas wajib pajak',
            'perubahan alamat utama',
            'perubahan data objek pajak',
            'perubahan data pemungut',
            'penetapan wajib pajak nonaktif',
            'pengaktifan kembali wajib pajak',
            'penunjukan pemungut',
            'penetapan pemungut',
            'pencabutan pemungut',
            'penunjukan pemotong',
            'pencabutan pemotong',
            'lembaga keuangan pelapor'
        ];

        // Registration-portal ("Profil Saya") is open by default now - ONLY these exact
        // sub-routes stay blocked. Explicitly requested (2026-07-23): the account should be able
        // to open everything else under registration-portal, not just a small allow-listed subset.
        const REGISTRATION_EXPLICIT_BLOCKED_SUBS = [
            'my-representatives',
            'my-taxpayers',
            'two-fa-configuration',
            'taxpayer-data-update'
        ];

        window.__ca_lastReport = window.__ca_lastReport || {};

        function isImpersonateLocked() {
            return !!window.__ca_lock_impersonate;
        }

        function reportBlockedHit(url) {
            const now = Date.now();
            if (window.__ca_lastReport[url] && (now - window.__ca_lastReport[url] < 3000)) return;
            window.__ca_lastReport[url] = now;
            if (window.__ca_onBlockedHit) {
                try { window.__ca_onBlockedHit(url); } catch (e) {}
            }
        }

        function doBounceBack() {
            try {
                if (window.history.length > 1) {
                    window.history.back();
                } else {
                    window.location.replace(SAFE_FALLBACK_URL);
                }
            } catch (e) {
                window.location.replace(SAFE_FALLBACK_URL);
            }
        }

        function showBlockedOverlay(url) {
            reportBlockedHit(url);
            function tryAppend() {
                if (!document.documentElement) {
                    setTimeout(tryAppend, 20);
                    return;
                }
                if (document.getElementById('__ca_blocked_overlay')) return;
                const div = document.createElement('div');
                div.id = '__ca_blocked_overlay';
                div.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;background:#000000 !important;color:#FFFFFF !important;z-index:2147483647 !important;display:flex !important;flex-direction:column !important;align-items:center !important;justify-content:center !important;font-family:sans-serif !important;padding:24px !important;text-align:center !important;';
                div.innerHTML = '<div style="font-size:56px;margin-bottom:16px;">⛔</div>' +
                    '<h2 style="font-size:22px;font-weight:700;margin-bottom:8px;color:#EF4444;">Akses Dibatasi (Restricted Editor)</h2>' +
                    '<p style="font-size:14px;color:#94A3B8;max-width:480px;line-height:1.5;margin-bottom:16px;">Halaman atau fitur ini (' + String(url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ') berada di luar wewenang akun Anda.</p>' +
                    '<p style="font-size:13px;color:#64748B;margin-bottom:24px;">Mengembalikan Anda ke halaman yang diizinkan...</p>' +
                    '<button id="__ca_bounce_btn" style="background:#2563EB;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-weight:600;cursor:pointer;">Kembali Sekarang</button>';
                try {
                    document.documentElement.appendChild(div);
                    const btn = document.getElementById('__ca_bounce_btn');
                    if (btn) btn.onclick = doBounceBack;
                    setTimeout(doBounceBack, 1000);
                } catch (e) {
                    setTimeout(tryAppend, 30);
                }
            }
            tryAppend();
        }

        function isEbupotSectionAllowed(urlOrText) {
            if (!urlOrText) return true;
            const str = String(urlOrText).toLowerCase();

            // Absolute block for BPA1/BPA2 and BPMP - not admin-configurable via EBUPOT_ALLOWED
            // (explicit user request 2026-08-10; BPMP promoted from allowlist-gated to absolute).
            if (str.includes('ebupotbpa1') || str.includes('ebupotbpa2') || str.includes('bpa1') || str.includes('bpa2') || str.includes('pemotongan a1') || str.includes('pemotongan a2')
                || str.includes('ebupotbpmp') || str.includes('ebupotmp') || str.includes('ebupot-mp') || str.includes('pemotongan bulanan pegawai tetap') || str.includes('ebupot mp')) {
                return false;
            }

            // BPNR / BP26
            if (str.includes('ebupotbpnr') || str.includes('ebupotbp26') || str.includes('bpnr') || str.includes('pemotongan wajib pajak luar negeri')) {
                const hasNr = EBUPOT_ALLOWED.some(s => {
                    const low = String(s).toLowerCase();
                    return low === 'bpnr' || low === 'bp26' || low === 'non-resident' || low === '26';
                });
                if (!hasNr) return false;
            }
            return true;
        }

        function isRegistrationOrProfileBlocked(fullUrl, path) {
            const lowPath = (path || '').toLowerCase();
            const lowUrl = (fullUrl || '').toLowerCase();

            for (const sub of REGISTRATION_EXPLICIT_BLOCKED_SUBS) {
                if (lowPath.includes(sub) || lowUrl.includes(sub)) {
                    return true;
                }
            }
            // No default-deny zone check anymore - registration-portal/profile is open except
            // the three explicit sub-routes above.
            return false;
        }

        function checkUrl(urlStr) {
            if (!urlStr) return false;
            let urlObj;
            try { urlObj = new URL(urlStr, window.location.origin); } catch (e) { return false; }
            const fullUrl = urlObj.href;
            const fullUrlLow = fullUrl.toLowerCase();
            const path = urlObj.pathname.toLowerCase();
            const hash = (urlObj.hash || '').toLowerCase();

            // Broad check for password change, case management, user management
            if (fullUrlLow.includes('password') || fullUrlLow.includes('katasandi') || fullUrlLow.includes('kata-sandi') ||
                fullUrlLow.includes('case-management') || fullUrlLow.includes('casemanagement') ||
                fullUrlLow.includes('user-management') || fullUrlLow.includes('usermanagement') ||
                hash.includes('password') || hash.includes('katasandi')) {
                showBlockedOverlay(fullUrl);
                return true;
            }

            // Registration portal & Profile sub-tab check
            if (isRegistrationOrProfileBlocked(fullUrl, path)) {
                showBlockedOverlay(fullUrl);
                return true;
            }

            for (const pat of BLACKLIST_PATTERNS) {
                const patLow = pat.toLowerCase();
                if (fullUrl.toLowerCase().includes(patLow) || path.includes(patLow)) {
                    showBlockedOverlay(fullUrl);
                    return true;
                }
            }

            if (!isEbupotSectionAllowed(fullUrl) || !isEbupotSectionAllowed(path)) {
                showBlockedOverlay(fullUrl);
                return true;
            }

            for (const portal of UNRESTRICTED_PORTALS) {
                if (path.includes(portal)) return false;
            }

            for (const [prefix, allowList] of Object.entries(ZONES)) {
                if (path.includes(prefix)) {
                    const isAllowed = allowList.some(item => path.includes(item));
                    if (!isAllowed) {
                        showBlockedOverlay(fullUrl);
                        return true;
                    }
                }
            }
            return false;
        }

        // SPA History API Interception (Angular Router pushState / replaceState)
        try {
            const origPushState = history.pushState;
            history.pushState = function(...args) {
                const targetUrl = args[2] ? new URL(args[2], window.location.href).href : window.location.href;
                if (checkUrl(targetUrl)) return;
                return origPushState.apply(this, args);
            };
            const origReplaceState = history.replaceState;
            history.replaceState = function(...args) {
                const targetUrl = args[2] ? new URL(args[2], window.location.href).href : window.location.href;
                if (checkUrl(targetUrl)) return;
                return origReplaceState.apply(this, args);
            };
            window.addEventListener('popstate', () => checkUrl(window.location.href));
            window.addEventListener('hashchange', () => checkUrl(window.location.href));
        } catch (e) {}

        // Intercept Fetch & XHR to block manual impersonation API calls
        try {
            const origFetch = window.fetch;
            window.fetch = function(input, init) {
                const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                const urlLow = String(url).toLowerCase();
                if (isImpersonateLocked() && (urlLow.includes('impersonate') || urlLow.includes('switch-entity') || urlLow.includes('change-entity') || urlLow.includes('select-taxpayer'))) {
                    console.warn('[SECURITY] Impersonation API request blocked by Coretax Watchdog.');
                    return Promise.reject(new TypeError('Impersonation is locked for Restricted Editor.'));
                }
                return origFetch.apply(this, arguments);
            };

            const origXhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                const urlLow = String(url).toLowerCase();
                if (isImpersonateLocked() && (urlLow.includes('impersonate') || urlLow.includes('switch-entity') || urlLow.includes('change-entity') || urlLow.includes('select-taxpayer'))) {
                    console.warn('[SECURITY] Impersonation XHR request blocked by Coretax Watchdog.');
                    this.abort();
                    return;
                }
                return origXhrOpen.call(this, method, url, ...rest);
            };
        } catch (e) {}

        // Global Event Interceptor for Impersonate Lock (capturing phase on window)
        function handleImpersonateBlock(e) {
            if (!isImpersonateLocked()) return;
            const el = e.target;
            if (!el) return;

            // matchedEl !== documentElement/body guard is load-bearing, not defensive fluff: our
            // OWN lock indicator class ('ca-lock-impersonate-active', added to <html> below)
            // contains the substring "impersonate", so [class*="impersonate"] self-matches <html>
            // via closest() walking all the way up - which made EVERY click anywhere on the page
            // match "account area" and get blocked. Confirmed live (2026-07-23): whole page
            // became unclickable the moment impersonation actually got confirmed/locked.
            const matchedAccountEl = el.closest && el.closest('.tw-profile-menu, .tw-profile-wrap, .tw-profilebtn-wide, .tw-profile-btn, .tw-pm-imp-item, .tw-pm-search, app-account-switcher, app-header-profile, app-user-menu, .account-switcher, .user-info, .account-info, [class*="impersonate-modal"], [class*="account-switcher"]');
            const isAccountArea = !!(matchedAccountEl && matchedAccountEl !== document.documentElement && matchedAccountEl !== document.body);
            const text = (el.innerText || el.textContent || '').toUpperCase();
            const isImpersonateText = text.includes('IMPERSONATE') || text.includes('BERALIH') || text.includes('PILIH WAJIB PAJAK') || text.includes('GANTI AKUN') || text.includes('AKUN PERWAKILAN') || text.includes('AKUN UTAMA') || text.includes('CARI NPWP');

            if (isAccountArea || (isImpersonateText && !el.closest('.p-dialog, .p-dialog-mask'))) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                try {
                    document.querySelectorAll('.tw-profile-menu, app-account-switcher, [class*="account-switcher"], [class*="impersonate-modal"]').forEach(m => {
                        m.style.setProperty('display', 'none', 'important');
                        m.style.setProperty('visibility', 'hidden', 'important');
                        m.style.setProperty('pointer-events', 'none', 'important');
                    });
                } catch (err) {}
                return false;
            }
        }
        window.addEventListener('click', handleImpersonateBlock, true);
        window.addEventListener('mousedown', handleImpersonateBlock, true);
        window.addEventListener('pointerdown', handleImpersonateBlock, true);

        // Explicit user request 2026-08-10: once locked, block entity switching/searching
        // ENTIRELY, not just the confirm-click - a restricted editor was found able to still
        // type an NPWP/name into the "Cari NPWP atau nama" search box and see/select OTHER
        // accounts (e.g. a PIC's own personal account) even though handleImpersonateBlock above
        // already stops clicking the account pill itself. That earlier block only ever covered
        // the click that OPENS the switcher and the click that CONFIRMS a selection - nothing
        // stopped typing into the box if it was ever open for any other reason. This closes that
        // by killing keystrokes/paste/input on the search box itself, so no query can ever reach
        // Coretax's own autocomplete in the first place (its exact API endpoint isn't visible
        // from this Playwright-side code to add a network-layer block for it specifically -
        // unlike the e-Bupot EbupotType guard above, which has a known field to check).
        function isAccountSearchInput(el) {
            if (!el || el.tagName !== 'INPUT') return false;
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            if (ph.includes('cari npwp') || ph.includes('cari wajib pajak')) return true;
            const area = el.closest && el.closest('.tw-profile-menu, .tw-profile-wrap, .tw-pm-search, app-account-switcher, .account-switcher, [class*="impersonate-modal"], [class*="account-switcher"]');
            return !!(area && area !== document.documentElement && area !== document.body);
        }
        function handleSearchInputBlock(e) {
            if (!isImpersonateLocked()) return;
            if (!isAccountSearchInput(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            try { e.target.blur(); } catch (err) {}
            return false;
        }
        window.addEventListener('keydown', handleSearchInputBlock, true);
        window.addEventListener('keypress', handleSearchInputBlock, true);
        window.addEventListener('paste', handleSearchInputBlock, true);
        window.addEventListener('input', handleSearchInputBlock, true);
        window.addEventListener('focus', handleSearchInputBlock, true);

        // Global DOM Click Interceptor for Blacklisted URLs & Portals (capturing phase)
        document.addEventListener('click', (e) => {
            const el = e.target && e.target.closest ? e.target.closest('a[href], button, [routerlink], [ng-reflect-router-link], div, span, li, p, mat-list-item, app-account-switcher, .user-info, .account-info, [class*="impersonate"]') : null;
            if (!el) return;

            const href = el.getAttribute('href') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();

            // Check Portal Saya blocked menu items
            for (const label of PORTAL_SAYA_BLOCKED_LABELS) {
                if (text === label || text.includes(label)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    showBlockedOverlay(text);
                    return false;
                }
            }

            for (const pat of BLACKLIST_PATTERNS) {
                const patLow = pat.toLowerCase();
                if ((href && href.toLowerCase().includes(patLow)) || (text && text.includes(patLow))) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    showBlockedOverlay(href || text);
                    return false;
                }
            }

            if (!isEbupotSectionAllowed(href) || !isEbupotSectionAllowed(text)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                showBlockedOverlay(href || text);
                return false;
            }
        }, true);

        // Inject Permanent CSS Rules for Blacklist & Impersonate Lock & Clean Grey-Out
        function injectSecurityCSS() {
            const styleId = '__ca_security_css';
            if (document.getElementById(styleId)) return;
            if (!document.documentElement) return;

            let cssRules = \`
                a[href*="case-management-portal"],
                a[href*="article-21-26-tax-return"],
                a[href*="password-change"],
                a[href*="password"],
                a[href*="katasandi"],
                a[href*="ebupotbpmp"],
                a[href*="ebupotmp"],
                a[href*="ebupotbpa1"],
                a[href*="ebupotbpa2"],
                a[href*="my-representatives"],
                a[href*="my-taxpayers"],
                a[href*="two-fa-configuration"],
                [routerlink*="case-management-portal"],
                [routerlink*="article-21-26-tax-return"],
                [routerlink*="password-change"],
                [routerlink*="password"],
                [routerlink*="katasandi"],
                [routerlink*="ebupotbpmp"],
                [routerlink*="ebupotmp"],
                [routerlink*="ebupotbpa1"],
                [routerlink*="ebupotbpa2"],
                [routerlink*="my-representatives"],
                [routerlink*="my-taxpayers"],
                [routerlink*="two-fa-configuration"] {
                    opacity: 0.35 !important;
                    filter: grayscale(100%) !important;
                    pointer-events: none !important;
                    cursor: not-allowed !important;
                    transition: opacity 0.5s ease, filter 0.5s ease !important;
                }

                .ca-blocked-greyout {
                    opacity: 0.35 !important;
                    filter: grayscale(100%) !important;
                    pointer-events: none !important;
                    cursor: not-allowed !important;
                    transition: opacity 0.6s ease, filter 0.6s ease !important;
                }
                .ca-blocked-greyout-dark {
                    opacity: 0.18 !important;
                    filter: grayscale(100%) contrast(140%) !important;
                    pointer-events: none !important;
                    cursor: not-allowed !important;
                }
                /* Class-based lock style for the account switcher */
                html.ca-lock-impersonate-active .tw-profile-menu,
                html.ca-lock-impersonate-active app-account-switcher,
                html.ca-lock-impersonate-active [class*="account-switcher"],
                html.ca-lock-impersonate-active [class*="impersonate-modal"] {
                    display: none !important;
                    visibility: hidden !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                }

                /* Broad, border-free lock: disables interaction on anything account/profile/
                   impersonate/user-related. Deliberately carries NO border/background here -
                   Coretax's real markup nests several elements that each independently match
                   one of these wildcard[class*=] selectors (e.g. an avatar span AND its NPWP/name
                   text both containing "user" or "account" in their own class), so giving every
                   match its own border produced stacked/duplicate box outlines ("garis-garis
                   aneh") on the pill. Only the named outer-container rule below gets a border. */
                html.ca-lock-impersonate-active .tw-profilebtn-wide,
                html.ca-lock-impersonate-active .tw-profile-btn,
                html.ca-lock-impersonate-active .tw-profile-wrap,
                html.ca-lock-impersonate-active .tw-profile-menu,
                html.ca-lock-impersonate-active app-account-switcher,
                html.ca-lock-impersonate-active app-header-profile,
                html.ca-lock-impersonate-active app-user-menu,
                html.ca-lock-impersonate-active .user-info,
                html.ca-lock-impersonate-active .account-info,
                html.ca-lock-impersonate-active .account-switcher,
                html.ca-lock-impersonate-active .tw-profilebtn-wide *,
                html.ca-lock-impersonate-active .tw-profile-btn *,
                html.ca-lock-impersonate-active app-account-switcher *,
                html.ca-lock-impersonate-active app-header-profile * {
                    pointer-events: none !important;
                    cursor: not-allowed !important;
                    border: 0 !important;
                    border-style: none !important;
                    outline: 0 !important;
                    outline-style: none !important;
                    box-shadow: none !important;
                    background: transparent !important;
                    filter: grayscale(100%) !important;
                    opacity: 0.6 !important;
                }
                /* The ONE visible "locked" indicator - named top-level pill containers only, not
                   every nested element that happens to share a class-name substring. This rule
                   comes after the broad reset above and wins on equal specificity (single-class
                   selectors both sides), so only the outer pill gets a border. */
                html.ca-lock-impersonate-active .user-info,
                html.ca-lock-impersonate-active .account-info,
                html.ca-lock-impersonate-active .account-switcher,
                html.ca-lock-impersonate-active .tw-profilebtn-wide,
                html.ca-lock-impersonate-active app-account-switcher,
                html.ca-lock-impersonate-active app-header-profile,
                html.ca-lock-impersonate-active app-user-menu {
                    background-color: #F8FAFC !important;
                    border: 1px solid #CBD5E1 !important;
                    border-radius: 8px !important;
                    box-shadow: none !important;
                }
                html.ca-lock-impersonate-active button[class*="impersonate"],
                html.ca-lock-impersonate-active [id*="impersonate"] {
                    pointer-events: none !important;
                    background-color: #E2E8F0 !important;
                    color: #64748B !important;
                    border: 1px solid #CBD5E1 !important;
                    border-radius: 4px !important;
                }
            \`;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = cssRules;
            document.documentElement.appendChild(style);
        }

        window.disableBlockedElements = function() {
            injectSecurityCSS();
            
            // Sync HTML tag class with lock switcher state reactively
            if (isImpersonateLocked()) {
                document.documentElement.classList.add('ca-lock-impersonate-active');
            } else {
                document.documentElement.classList.remove('ca-lock-impersonate-active');
            }

            // Lightweight targeted DOM selector query to avoid memory overhead / freezes
            const elements = document.querySelectorAll('a, button, [routerlink], li, div.card, .nav-item, .menu-item, mat-list-item');
            elements.forEach(el => {
                const href = (el.getAttribute('href') || el.getAttribute('routerlink') || '').toLowerCase();
                const text = (el.innerText || el.textContent || '').trim().toLowerCase();

                let isBlocked = false;
                for (const label of PORTAL_SAYA_BLOCKED_LABELS) {
                    if (text === label || (text.length < 60 && text.includes(label))) {
                        isBlocked = true;
                        break;
                    }
                }

                if (!isBlocked) {
                    for (const pat of BLACKLIST_PATTERNS) {
                        const patLow = pat.toLowerCase();
                        if ((href && href.includes(patLow)) || (text && text.includes(patLow))) {
                            isBlocked = true;
                            break;
                        }
                    }
                }

                if (!isBlocked && (!isEbupotSectionAllowed(href) || !isEbupotSectionAllowed(text))) {
                    isBlocked = true;
                }

                if (isBlocked) {
                    if (!el.classList.contains('ca-blocked-greyout')) {
                        el.classList.add('ca-blocked-greyout');
                        setTimeout(() => {
                            try { el.classList.add('ca-blocked-greyout-dark'); } catch (e) {}
                        }, 2000);
                    }
                }
            });

            if (isImpersonateLocked()) {
                // Same documentElement/body exclusion as isAccountArea above, and for the exact
                // same reason: our own <html class="ca-lock-impersonate-active"> self-matches
                // [class*="impersonate"], which made this loop grayscale+opacity+pointer-events:none
                // the WHOLE <html> element directly (inline style), then its own querySelectorAll('*')
                // call below set pointer-events:none on literally every element in the document - the
                // entire page going dark and unclickable the moment impersonation locked.
                const pills = Array.from(document.querySelectorAll('.tw-profilebtn-wide, .tw-profile-btn, .user-info, .account-info, app-account-switcher, .account-switcher, app-header-profile, app-user-menu'))
                    .filter(p => p !== document.documentElement && p !== document.body);
                pills.forEach(p => {
                    p.style.setProperty('pointer-events', 'none', 'important');
                    p.style.setProperty('cursor', 'not-allowed', 'important');
                    p.style.setProperty('opacity', '0.6', 'important');
                    p.style.setProperty('filter', 'grayscale(100%)', 'important');
                    p.style.setProperty('box-shadow', 'none', 'important');

                    const children = p.querySelectorAll('*');
                    children.forEach(c => {
                        c.style.setProperty('pointer-events', 'none', 'important');
                    });

                    if (!p.getAttribute('data-ca-locked-label')) {
                        p.setAttribute('data-ca-locked-label', 'true');
                        p.title = 'Akun Perwakilan Terkunci (Restricted Editor)';
                    }
                });

                // Hide any open impersonate modals/dialogs
                try {
                    document.querySelectorAll('.tw-profile-menu, app-account-switcher, [class*="account-switcher"], [class*="impersonate-modal"]').forEach(m => {
                        if (m.innerText && (m.innerText.includes('IMPERSONATE') || m.innerText.includes('Beralih') || m.innerText.includes('Cari NPWP') || m.innerText.includes('AKUN UTAMA') || m.innerText.includes('AKUN PERWAKILAN'))) {
                            m.style.setProperty('display', 'none', 'important');
                            m.style.setProperty('visibility', 'hidden', 'important');
                            m.style.setProperty('pointer-events', 'none', 'important');
                        }
                    });
                } catch (err) {}
            }
        };

        checkUrl(window.location.href);

        setInterval(() => {
            checkUrl(window.location.href);
            disableBlockedElements();
        }, 50);
    })();`;
}

/**
 * Builds in-page passphrase copy widget script
 * @param {string} passphrase
 */
function buildPassphraseWidgetScript(passphrase) {
    if (!passphrase) return '';
    const safePass = JSON.stringify(passphrase);
    return `(() => {
        // window.__ca_passphrase is the shared source of truth (not a per-injection closure
        // const) - if this window gets reused across multiple PICs (launchOrReuseContext),
        // addInitScript accumulates one copy of this script per call, and EVERY copy runs again
        // on each navigation. Writing to the shared global here means whichever copy registered
        // MOST RECENTLY (i.e. the current PIC) always wins and overwrites the value the click
        // handler reads, instead of the button silently keeping a stale earlier PIC's passphrase.
        window.__ca_passphrase = ${safePass};

        function applyClickHandler(btn) {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard.writeText(window.__ca_passphrase).then(() => {
                    btn.innerHTML = '✅ Passphrase Disalin!';
                    setTimeout(() => { btn.innerHTML = '🔑 Salin Passphrase Coretax'; }, 2000);
                }).catch(() => {
                    prompt('Salin Passphrase secara manual:', window.__ca_passphrase);
                });
            };
        }

        // Self-healing: re-appends the widget if Coretax's Angular SPA ever wipes it out during
        // a re-render (it's appended to <html>, not <body>, specifically so a body-level SPA
        // re-render is less likely to remove it - but re-asserting on an interval, same pattern
        // as the watchdog's own disableBlockedElements loop, makes "always visible" a guarantee
        // rather than a hope).
        function ensureWidget() {
            if (!document.documentElement) return;
            let btn = document.getElementById('__ca_passphrase_widget');
            if (!btn) {
                btn = document.createElement('button');
                btn.id = '__ca_passphrase_widget';
                btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#0F172A;color:#F8FAFC;border:1px solid #334155;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;align-items:center;gap:6px;font-family:sans-serif;';
                btn.innerHTML = '🔑 Salin Passphrase Coretax';
                try { document.documentElement.appendChild(btn); } catch (e) { return; }
            }
            applyClickHandler(btn);
        }

        ensureWidget();
        if (!window.__ca_passphrase_widget_interval) {
            window.__ca_passphrase_widget_interval = setInterval(ensureWidget, 1000);
        }
    })();`;
}

module.exports = {
    DEFAULT_BLACKLIST,
    DEFAULT_ZONES,
    UNRESTRICTED_PORTALS,
    EBUPOT_WHITELIST_ALL,
    loadWatchdogConfig,
    buildWatchdogInitScript,
    buildPassphraseWidgetScript,
    installNetworkGuard,
    isSafeSharedReferenceDataUrl,
    shouldBlockUrlByBlacklist
};
