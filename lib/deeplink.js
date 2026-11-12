/* Coretax Agent - taxio-coretax:// deep-link handling. Replaces the legacy coretax-helper.exe
   as the registered handler for this scheme (explicit user direction: "ganti langsung") - a
   click on "Login Coretax" / "Download SPT" etc in Taxio or Taxio.me should feel exactly like
   it did with the old tool, just driven by this app's own automation underneath.

   Param shape and RPC names copied verbatim from Taxio/coretax-helper/run.js's
   parseIncomingUrl()/markSptCompliance() - the web apps (coretax.js/compliance.js) that BUILD
   these URLs are untouched, so this side has to match them exactly, not the other way around.

   Auth model (also copied from the legacy tool, see lib/session-store.js's connectWithToken):
   the URL carries a Supabase access_token from the ALREADY-LOGGED-IN Taxio web session, not a
   Coretax username/password - this app never prompts for Taxio credentials when invoked this
   way, only uses that token to fetch the target PIC's stored Coretax credential (same RPC this
   app's own GUI path already uses) and to write back compliance status afterward. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { log, showPopup, showErrorPopup } = require('./log');
const PROJECTS = require('./supabase-projects');
const sessionStore = require('./session-store');
const entitiesLib = require('./entities');
const chrome = require('./chrome');
const compliance = require('./compliance');
const runcontrol = require('./runcontrol');
const { runSptDownload } = require('../automation/spt');
const { runBillingPph25 } = require('../automation/billing');

function parseIncomingUrl(raw) {
    const u = new URL(raw);
    const p = new URLSearchParams(u.search);
    return {
        org: p.get('org'), entity: p.get('entity'), pic: p.get('pic'),
        npwp: p.get('npwp') || '', name: p.get('name') || '',
        token: p.get('token'), redirect: p.get('redirect') || '',
        action: p.get('action') || '', masa: p.get('masa') || '', types: p.get('types') || '',
        year: p.get('year') || '', uid: p.get('uid') || '', uemail: p.get('uemail') || '',
        sbUrl: p.get('sbUrl') || '', sbAnonKey: p.get('sbAnonKey') || '',
        comp_folder: p.get('comp_folder') || '',
        a1_year: p.get('a1_year') || '', a1_folder: p.get('a1_folder') || '', // action mode-a1 (Taxio Hub A1 Preparation)
        individual: p.get('individual') === '1',
        path: p.get('path') || '',
        nominal: p.get('nominal') || ''
    };
}

/** Deep link mode-a1: tahun pajak 2025 ke atas; folder dari URL hanya diterima bila path absolut bernama "A1 preparation". */
const validA1Year = (y) => /^20\d{2}$/.test(String(y)) && Number(y) >= 2025;
const validA1Folder = (f) => path.isAbsolute(String(f)) && /^a1 preparation$/i.test(path.basename(String(f).replace(/[\\/]+$/, '')));

/** SECURITY (2026-11-12 audit): `redirect` arrives in a taxio-coretax:// URL that ANY web page
 *  can trigger through the registered protocol, and it is opened with page.goto() inside a
 *  Coretax window that is already logged in (and impersonating a client). Taxio Hub only ever
 *  sends Coretax pages, so only plain https://coretaxdjp.pajak.go.id/... is accepted - no other
 *  scheme/host/port, no credentials in the URL. Anything else: the redirect (and the actions
 *  that run on the redirected page) is refused; the login itself still happens. */
const REDIRECT_HOST = 'coretaxdjp.pajak.go.id';
function isAllowedRedirect(raw) {
    // Chrome parses the string with the same WHATWG URL rules as `new URL`, so checking the
    // parsed host is checking where goto() will actually go (e.g. "https:\\evil.example" parses
    // to host evil.example and is refused).
    if (typeof raw !== 'string' || !raw) return false;
    let u;
    try { u = new URL(raw); } catch (e) { return false; }
    return u.protocol === 'https:' && u.hostname === REDIRECT_HOST && u.port === '' && !u.username && !u.password;
}

const TYPE_KEY_MAP ={ pph21: 'pph21', unifikasi: 'unifikasi', ppn: 'ppn', badan: 'badan', spt_op: 'spt_op' };

/** Handles the one non-Coretax action the legacy tool also supported: opening a local file/
 *  folder path (e.g. "reveal in Explorer" from Taxio's own UI) - explicitly called out by the
 *  user as a feature to keep, not drop, in this replacement. */
function handleOpenPath(targetPath) {
    if (!targetPath) { log('Deep link "open": path kosong.'); return; }
    // SECURITY: this handler is reachable by ANY website via the system-registered
    // taxio-coretax:// protocol, so `targetPath` is fully attacker-controlled. The old code
    // did `exec('start "" "' + path + '"')` after stripping only `& | ; "` - which still let a
    // crafted path LAUNCH arbitrary local/UNC executables (e.g. \\attacker\share\evil.exe) or a
    // URL/other protocol. This version never touches a shell and never executes the target: it
    // only REVEALS it in Explorer (a directory opens itself; a file is highlighted via
    // /select), after rejecting anything that isn't a plain, existing, local absolute path.
    const raw = String(targetPath);
    if (/^\\\\/.test(raw)) { log('Deep link "open" ditolak (UNC/remote path tidak diizinkan): ' + raw); return; }
    const p = path.resolve(raw);
    if (!/^[a-zA-Z]:[\\/]/.test(p)) { log('Deep link "open" ditolak (bukan path lokal absolut): ' + raw); return; }
    let st;
    try { st = fs.statSync(p); } catch (e) { log('Deep link "open" ditolak (path tidak ditemukan): ' + p); return; }
    // execFile (no shell) + explorer /select = zero metacharacter surface, and Explorer's
    // /select can only highlight the file, never run it.
    const args = st.isDirectory() ? [p] : ['/select,', p];
    execFile('explorer.exe', args, { windowsHide: true }, () => { /* explorer often exits non-zero; ignore */ });
    log('Path dibuka di Explorer: ' + p);
}

/** Runs the actual automation for one taxio-coretax:// invocation. Never throws outward -
 *  errors are logged + surfaced via a Windows popup, matching the legacy tool's own top-level
 *  handling, since there's no dashboard "run failed" UI for a deep-link-triggered run.
 *
 *  CONFIRMED LIVE (first real-world use via Taxio's own "Download SPT" button, not just my own
 *  single scripted test): this function used to launch straight into the automation with NO
 *  single-flight guard at all - unlike every GUI-triggered run, which calls runcontrol.start()
 *  (throws if one's already active). Taxio's UI gives no visible feedback while a deep link is
 *  being processed, so a user who clicks the button again (reasonably, since nothing looks like
 *  it's happening) fires a SECOND dispatch() that runs concurrently with the first - both
 *  fighting over the exact same reused Chrome page (chrome.launchOrReuseContext is keyed by
 *  PIC), each setting filters and reading rows out from under the other. That's what produced
 *  the blank "Jenis Pajak" rows, the stuck-feeling impersonate wait, and the ~30s-interval
 *  runaway retries seen live. If a run is already active, queue this one (wait for the current
 *  one to finish, then run) rather than silently colliding or silently dropping the click.
 *
 *  Sejak semua perintah bisa paralel (2026-11-13) antreannya SAMA dengan proses dari dashboard (lib/runcontrol.js):
 *  setiap tautan mendapat jendela PIC-nya sendiri ("<pic>", "<pic>~2", ... sampai batas per PIC) dan hanya antre bila
 *  semua jendela PIC itu (atau batas total) sedang dipakai, atau bila unduhan SPT / billing entitas yang sama masih
 *  berjalan (kunci keluaran). Tautan IDENTIK yang datang selagi yang pertama masih antre/berjalan (klik ganda di Taxio
 *  Hub) dicatat lalu diabaikan - hasilnya sama persis. */
const DEEPLINK_LOCKS = { 'download-spt': 'spt', 'mode-a1': 'spt', 'billing-pph25': 'billing' };

async function dispatch(rawUrl) {
    // Tautan yang datang saat aplikasi baru dibuka: tunggu (terbatas) pemulihan sesi Taxio Hub di latar
    // (lib/session-restore.js) selesai dulu, supaya tidak bertabrakan dengan Taxio Hub / jendela yang sama.
    await require('./session-restore').waitIfRestoring().catch(() => {});
    return runcontrol.isolate(() => runOneDeepLink(rawUrl));
}

async function runOneDeepLink(rawUrl) {
    let params;
    try { params = parseIncomingUrl(rawUrl); }
    catch (e) { log('Gagal mem-parsing taxio-coretax:// URL: ' + e.message); return; }

    if (params.action === 'open') { handleOpenPath(params.path); return; }

    if (!params.org || !params.pic || !params.token) {
        log('Deep link taxio-coretax:// kekurangan parameter wajib (org/pic/token).');
        return;
    }

    // SECURITY: sbUrl/sbAnonKey arrive in an attacker-triggerable URL. Never let a deep link
    // point this app at an arbitrary Supabase endpoint - a hostile server could feed a forged
    // Coretax credential/passphrase straight into the real Coretax login flow. Only accept an
    // sbUrl that exactly matches one of our known projects; otherwise refuse before connecting.
    const KNOWN_SB_URLS = new Set(Object.values(PROJECTS).map((pr) => pr.url));
    if (!params.sbUrl || !KNOWN_SB_URLS.has(params.sbUrl)) {
        log('Deep link taxio-coretax:// ditolak: sbUrl tidak dikenal/kosong: ' + (params.sbUrl || '(kosong)'));
        return;
    }

    // Pool = PIC ini (sama seperti proses dari dashboard): jendela bebas PIC itu, atau antre.
    const entityId = String(params.entity || '');
    const sig = ['deeplink', params.action || 'login', entityId, params.pic, params.masa, params.types, params.a1_year, params.nominal, params.redirect].join('|');
    const lock = DEEPLINK_LOCKS[params.action] ? entityId + '|' + DEEPLINK_LOCKS[params.action] : '';
    let ready;
    try { ({ ready } = runcontrol.enqueue((params.action || 'login') + ' · ' + (params.name || params.entity || params.pic) + ' (from Taxio Hub)', { key: params.pic, tag: entityId.slice(0, 16), entity: entityId, feature: 'deeplink:' + (params.action || 'login'), sig, lock })); }
    catch (e) { log('Deep link taxio-coretax:// ditolak: ' + e.message); return; }
    try { await ready; }
    catch (e) { log('Deep link taxio-coretax:// dibatalkan sebelum mulai.'); runcontrol.finish(); return; }

    try {
        const { client, user } = await sessionStore.connectWithToken(params.sbUrl, params.sbAnonKey, params.token);
        const membership = user ? await entitiesLib.getMyOrgId(client, user.id).catch(() => null) : null;
        const restricted = !!(membership && String(membership.role || '').trim().toLowerCase() === 'restricted_editor');
        const allowedEbupotSections = (membership && membership.allowed_ebupot_sections) || null;
        const passphrase = await entitiesLib.getPassphrase(client, params.org, params.pic).catch(() => null);
        const cred = await entitiesLib.getCredential(client, params.org, params.pic);
        const entity = { entity_id: params.entity, entity_name: params.name || params.entity, npwp: params.npwp, individual: params.individual };

        const { page } = await chrome.launchOrReuseContext(params.pic, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
        }, restricted, allowedEbupotSections);
        await chrome.loginAndImpersonate(page, cred, entity, params.pic, { checkpoint: runcontrol.checkpoint, restricted, passphrase, allowedEbupotSections });

        // Taxio Hub builds comp_folder from the entity's "Folder Compliance" and the path aliases kept
        // in THAT browser's storage (%PROJECT_FILES% ...). When either is missing it sends the link
        // with no folder at all, and the files used to stay in Downloads without a word - while the
        // compliance tick still went through, so it looked as if the move had silently failed.
        if (['download-spt', 'billing-pph25'].includes(params.action)) {
            if (params.comp_folder) log('Folder compliance dari Taxio Hub: ' + params.comp_folder);
            else {
                const msg = 'Taxio Hub tidak mengirim folder compliance untuk ' + (params.name || params.entity) + ' - file tetap di Downloads\\CoretaxAgent. '
                    + 'Periksa "Folder Compliance" entitas ini (Compliance > Configuration) dan alias path (%PROJECT_FILES% dst.) di Settings Taxio Hub pada browser yang dipakai.';
                log(msg);
                showPopup(msg, 'Folder compliance kosong', 'warning');
            }
        }

        if (params.redirect && !isAllowedRedirect(params.redirect)) {
            log('Deep link: alamat tujuan ditolak (hanya https://' + REDIRECT_HOST + '/... yang diizinkan): ' + String(params.redirect).slice(0, 200) + ' - navigasi dan aksi lanjutan dilewati.');
            params.redirect = '';
        }
        if (params.redirect) {
            log('Deep link: navigasi ke ' + params.redirect);
            await page.goto(params.redirect, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('Gagal navigasi: ' + e.message));

            if (params.action === 'download-spt' && params.masa) {
                const jenisPajakKeys = (params.types || '').split(',').map((t) => t.trim()).filter(Boolean)
                    .map((t) => TYPE_KEY_MAP[t]).filter(Boolean);
                if (jenisPajakKeys.length) {
                    // Some entities have more than one Coretax PIC linked (e.g. Dion Farma Abadi
                    // - Fredi Setyawan & Ronald Tony) - an SPT can only ever be fetched by
                    // whichever PIC actually signed it. This deep-link path does its OWN
                    // login/impersonation up front (params.pic - whichever PIC Taxio's web UI
                    // resolved) and hands runSptDownload an already-logged-in page as "manual",
                    // so runSptDownload's own fallback-PIC retry (added for the GUI's own
                    // entity+PIC picker flow) never runs here - confirmed live 2026-08-04, a row
                    // failing with HTTP 400 via a deep link just gave up instead of trying the
                    // entity's other linked PIC. Track failed masa the same way and, if the
                    // entity has another linked PIC, log in as that PIC on its own page and retry
                    // ONLY the failed masa - processSptCombo's own skip-if-exists means a masa
                    // that partially succeeded just picks up what's still missing.
                    // `comp_folder` (already resolved by Taxio to include the masa subfolder -
                    // see coretax.js's downloadSptCoretax) is a SEPARATE copy destination, not a
                    // redirect of where the automation itself saves - mirrors the legacy tool's
                    // own copyToCompliance(), which never replaced the primary Downloads save.
                    //
                    // Tracked PER (jenisKey, masa) - NOT masa alone. CONFIRMED LIVE 2026-08-04:
                    // one masa combo covers several tax types at once (PPh21, Unifikasi, PPN all
                    // share the same mmYY) - tracking by mmYY alone meant a LATER row's success
                    // (e.g. Unifikasi) cleared an EARLIER row's genuine failure (PPN) for that
                    // same masa, so the fallback never triggered even though a row had truly failed.
                    const failedPairs = new Set(); // "jenisKey|mmYY"
                    const failedMmYYSet = () => new Set(Array.from(failedPairs, (p) => p.slice(p.indexOf('|') + 1)));
                    const trackAndMark = (jenisKey, mmYY, ok) => {
                        const key = jenisKey + '|' + mmYY;
                        if (ok) { failedPairs.delete(key); compliance.markSptCompliance(client, params, jenisKey); }
                        else failedPairs.add(key);
                    };
                    await runSptDownload({
                        manualPage: page, entity, jenisPajakKeys, masaInput: params.masa, compFolder: params.comp_folder || undefined,
                        onRowDone: trackAndMark, nik: cred.username, passphrase
                    }).catch((e) => log('Deep link: gagal download SPT: ' + e.message));

                    if (failedPairs.size) {
                        const fallbackPicIds = await entitiesLib.getOtherLinkedPicIds(client, params.org, params.entity, params.pic).catch(() => []);
                        for (const fbPicId of fallbackPicIds) {
                            const retryMmYY = failedMmYYSet();
                            if (!retryMmYY.size) break;
                            const retryMasa = Array.from(retryMmYY).join(';');
                            log('Beberapa SPT gagal terunduh sebagai PIC sebelumnya (mungkin bukan penandatangannya) - mencoba ulang sebagai PIC lain yang tertaut ke entitas ini...');
                            try {
                                const fbPassphrase = await entitiesLib.getPassphrase(client, params.org, fbPicId).catch(() => null);
                                const fbCred = await entitiesLib.getCredential(client, params.org, fbPicId);
                                const { page: fbPage } = await chrome.launchOrReuseContext(fbPicId, async (download) => {
                                    try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
                                }, restricted, allowedEbupotSections);
                                await chrome.loginAndImpersonate(fbPage, fbCred, entity, fbPicId, { checkpoint: runcontrol.checkpoint, restricted, passphrase: fbPassphrase, allowedEbupotSections });
                                if (!isAllowedRedirect(params.redirect)) throw new Error('alamat tujuan bukan halaman Coretax');
                                await fbPage.goto(params.redirect,{ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('Gagal navigasi: ' + e.message));
                                await runSptDownload({
                                    manualPage: fbPage, entity, jenisPajakKeys, masaInput: retryMasa, compFolder: params.comp_folder || undefined,
                                    onRowDone: trackAndMark, nik: fbCred.username, passphrase: fbPassphrase
                                }).catch((e) => log('Deep link: gagal download SPT (PIC lain): ' + e.message));
                            } catch (e) {
                                log('Gagal masuk sebagai PIC lain (' + fbPicId + '): ' + e.message + ' - dilewati.');
                            }
                        }
                        const stillFailing = failedMmYYSet();
                        if (stillFailing.size) log('Masih ada ' + stillFailing.size + ' masa yang gagal setelah dicoba di semua PIC tertaut - kemungkinan memang belum digenerate di Coretax.');
                    }
                }
            }

            // Mode A1 dari tab A1 Preparation Taxio Hub: rekap PPh 21 setahun (sama dengan halaman Mode A1 Pilot),
            // Excel rekap langsung ke folder yang di-resolve Hub (<Folder Tax Server entitas>\<tahun>\A1 preparation).
            if (params.action === 'mode-a1') {
                const year = String(params.a1_year || '');
                if (params.a1_folder && !validA1Folder(params.a1_folder)) { log('Mode A1: folder dari Taxio Hub diabaikan (' + params.a1_folder + ').'); params.a1_folder = ''; }
                if (restricted) { log('Mode A1 tidak tersedia untuk pengguna Restricted.'); showPopup('Mode A1 tidak tersedia untuk pengguna Restricted.', 'Mode A1', 'warning'); }
                else if (!validA1Year(year)) log('Mode A1: tahun tidak valid (' + year + ').');
                else {
                    const yy = year.slice(2);
                    if (params.a1_folder) log('Mode A1 - folder dari Taxio Hub: ' + params.a1_folder);
                    else log('Taxio Hub tidak mengirim folder A1 (Folder Tax Server entitas / alias %PROJECT_FILES% belum diatur) - rekap disimpan di Downloads\\CoretaxAgent.');
                    await runSptDownload({
                        manualPage: page, entity, jenisPajakKeys: ['pph21'], masaInput: '01' + yy + '-12' + yy, nik: cred.username, passphrase, restricted,
                        includeLampiran: true, includeBpe: true, includeInduk: true, lampiranMode: 'full', lampiranFormat: 'pdf', outputLayout: 'combined', checkPph25: false,
                        a1Year: year, a1Fresh: false, a1OutDir: params.a1_folder || undefined
                    }).catch((e) => log('Deep link: Mode A1 gagal: ' + e.message));
                }
            }

            if (params.action === 'billing-pph25' && params.masa && params.nominal) {
                await runBillingPph25({
                    manualPage: page, entity, masaInput: params.masa, nominal: params.nominal, compFolder: params.comp_folder || undefined
                }).catch((e) => log('Deep link: gagal membuat Kode Billing PPh 25: ' + e.message));
            }
        }
        log('Deep link selesai - masuk sebagai "' + (params.name || params.entity) + '". Jendela dibiarkan terbuka.');
    } catch (e) {
        // Jendela Coretax ditutup di tengah proses (biasanya oleh pengguna, mis. setelah login PIC
        // gagal berulang) - bukan galat aplikasi, cukup dicatat tanpa pesan Playwright mentah.
        if (/Target page, context or browser has been closed|Target closed/i.test(e.message || '')) {
            log('Jendela Coretax ' + (params.name || params.entity) + ' ditutup sebelum proses selesai - permintaan dari Taxio dibatalkan.');
            showPopup('Jendela Coretax untuk ' + (params.name || params.entity) + ' ditutup sebelum proses selesai, jadi permintaan dari Taxio dibatalkan. Klik lagi di Taxio Hub untuk mengulang.', 'Proses dibatalkan', 'warning');
            return;
        }
        log('Deep link taxio-coretax:// gagal: ' + (e.stack || e.message));
        showErrorPopup('Taxio Pilot gagal memproses permintaan dari Taxio: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

// Registering taxio-coretax:// to this app (HKCU, no admin; replaces whatever the legacy
// coretax-helper.exe or the old pkg exe registered, per explicit user direction) is done by the
// installed desktop app itself: electron/main.js app.setAsDefaultProtocolClient - never in dev,
// never in an isolated TAXIO_PILOT_DATA_DIR run.

/** The first taxio-coretax:// URL in a command line (argv of a cold start or a second launch). */
function findDeepLinkArg(argv) {
    return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().indexOf('taxio-coretax://') === 0) || null;
}

module.exports = { parseIncomingUrl, dispatch, findDeepLinkArg, validA1Year, validA1Folder, isAllowedRedirect };
