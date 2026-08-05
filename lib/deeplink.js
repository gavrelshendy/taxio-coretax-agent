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
const { execFileSync, execFile } = require('child_process');
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
        individual: p.get('individual') === '1',
        path: p.get('path') || '',
        nominal: p.get('nominal') || ''
    };
}

const TYPE_KEY_MAP = { pph21: 'pph21', unifikasi: 'unifikasi', ppn: 'ppn', badan: 'badan', spt_op: 'spt_op' };

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
 *  one to finish, then run) rather than silently colliding or silently dropping the click. */
const _pendingDeepLinks = [];
let _deepLinkRunnerActive = false;

async function dispatch(rawUrl) {
    _pendingDeepLinks.push(rawUrl);
    if (_deepLinkRunnerActive) { log('Deep link taxio-coretax:// diterima - menunggu proses sebelumnya selesai (antre).'); return; }
    _deepLinkRunnerActive = true;
    try {
        while (_pendingDeepLinks.length) {
            const next = _pendingDeepLinks.shift();
            await runOneDeepLink(next);
        }
    } finally {
        _deepLinkRunnerActive = false;
    }
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

    try { runcontrol.start((params.action || 'login') + ' · ' + (params.name || params.entity || params.pic) + ' (dari Taxio)'); }
    catch (e) { log('Deep link taxio-coretax:// ditolak: ' + e.message); return; }

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
                                await fbPage.goto(params.redirect, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('Gagal navigasi: ' + e.message));
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

            if (params.action === 'billing-pph25' && params.masa && params.nominal) {
                await runBillingPph25({
                    manualPage: page, entity, masaInput: params.masa, nominal: params.nominal, compFolder: params.comp_folder || undefined
                }).catch((e) => log('Deep link: gagal membuat Kode Billing PPh 25: ' + e.message));
            }
        }
        log('Deep link selesai - masuk sebagai "' + (params.name || params.entity) + '". Jendela dibiarkan terbuka.');
    } catch (e) {
        log('Deep link taxio-coretax:// gagal: ' + (e.stack || e.message));
        showErrorPopup('Coretax Agent gagal memproses permintaan dari Taxio: ' + e.message);
    } finally {
        runcontrol.finish();
    }
}

/** Registers taxio-coretax:// (HKCU, no admin needed) to launch THIS built exe directly -
 *  replaces whatever the legacy coretax-helper.exe had registered, per explicit user direction.
 *  Only does anything when actually running as the packaged exe (`process.pkg` - set by
 *  @yao-pkg/pkg) - in dev (`node main.js`) `process.execPath` points at node.exe itself, which
 *  would register a broken command, so this is a deliberate no-op there. Idempotent: safe to
 *  call on every normal startup (re-asserts the same values, e.g. after the exe moves). */
function registerProtocolHandler() {
    if (!process.pkg) return;
    try {
        const exePath = process.execPath;
        const classesKey = 'HKCU\\Software\\Classes\\taxio-coretax';
        execFileSync('reg', ['add', classesKey, '/ve', '/d', 'URL:Taxio Coretax Login Protocol', '/f'], { windowsHide: true });
        execFileSync('reg', ['add', classesKey, '/v', 'URL Protocol', '/d', '', '/f'], { windowsHide: true });
        const command = '"' + exePath + '" "%1"';
        execFileSync('reg', ['add', classesKey + '\\shell\\open\\command', '/ve', '/d', command, '/f'], { windowsHide: true });
        log('Protokol taxio-coretax:// terdaftar ke Coretax Agent: ' + command);
    } catch (e) {
        log('Gagal mendaftarkan protokol taxio-coretax://: ' + e.message);
    }
}

module.exports = { parseIncomingUrl, dispatch, registerProtocolHandler };
