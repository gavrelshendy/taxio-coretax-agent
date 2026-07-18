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
const { execFileSync } = require('child_process');
const { log, showPopup, showErrorPopup } = require('./log');
const sessionStore = require('./session-store');
const entitiesLib = require('./entities');
const chrome = require('./chrome');
const compliance = require('./compliance');
const { runSptDownload } = require('../automation/spt');

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
        path: p.get('path') || ''
    };
}

const TYPE_KEY_MAP = { pph21: 'pph21', unifikasi: 'unifikasi', ppn: 'ppn' };

/** Handles the one non-Coretax action the legacy tool also supported: opening a local file/
 *  folder path (e.g. "reveal in Explorer" from Taxio's own UI) - explicitly called out by the
 *  user as a feature to keep, not drop, in this replacement. */
function handleOpenPath(targetPath) {
    if (!targetPath) { log('Deep link "open": path kosong.'); return; }
    const sanitized = targetPath.replace(/[&|;"]/g, '');
    require('child_process').exec('start "" "' + sanitized + '"', (err) => {
        if (err) log('Gagal membuka path: ' + err.message);
        else log('Path dibuka: ' + sanitized);
    });
}

/** Runs the actual automation for one taxio-coretax:// invocation. Never throws outward -
 *  errors are logged + surfaced via a Windows popup, matching the legacy tool's own top-level
 *  handling, since there's no dashboard "run failed" UI for a deep-link-triggered run. */
async function dispatch(rawUrl) {
    let params;
    try { params = parseIncomingUrl(rawUrl); }
    catch (e) { log('Gagal mem-parsing taxio-coretax:// URL: ' + e.message); return; }

    if (params.action === 'open') { handleOpenPath(params.path); return; }

    if (!params.org || !params.pic || !params.token) {
        log('Deep link taxio-coretax:// kekurangan parameter wajib (org/pic/token).');
        return;
    }

    try {
        const { client } = await sessionStore.connectWithToken(params.sbUrl, params.sbAnonKey, params.token);
        const cred = await entitiesLib.getCredential(client, params.org, params.pic);
        const entity = { entity_id: params.entity, entity_name: params.name || params.entity, npwp: params.npwp, individual: params.individual };

        const { page } = await chrome.launchOrReuseContext(params.pic, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
        });
        await chrome.loginAndImpersonate(page, cred, entity, params.pic, {});

        if (params.redirect) {
            log('Deep link: navigasi ke ' + params.redirect);
            await page.goto(params.redirect, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('Gagal navigasi: ' + e.message));

            if (params.action === 'download-spt' && params.masa) {
                const jenisPajakKeys = (params.types || '').split(',').map((t) => t.trim()).filter(Boolean)
                    .map((t) => TYPE_KEY_MAP[t]).filter(Boolean);
                if (jenisPajakKeys.length) {
                    // `comp_folder` (already resolved by Taxio to include the masa subfolder -
                    // see coretax.js's downloadSptCoretax) is a SEPARATE copy destination, not a
                    // redirect of where the automation itself saves - mirrors the legacy tool's
                    // own copyToCompliance(), which never replaced the primary Downloads save.
                    await runSptDownload({
                        manualPage: page, entity, jenisPajakKeys, masaInput: params.masa, compFolder: params.comp_folder || undefined,
                        onRowDone: (jenisKey, mmYY, ok) => { if (ok) compliance.markSptCompliance(client, params, jenisKey); }
                    }).catch((e) => log('Deep link: gagal download SPT: ' + e.message));
                }
            }
        }
        log('Deep link selesai - masuk sebagai "' + (params.name || params.entity) + '". Jendela dibiarkan terbuka.');
    } catch (e) {
        log('Deep link taxio-coretax:// gagal: ' + (e.stack || e.message));
        showErrorPopup('Coretax Agent gagal memproses permintaan dari Taxio: ' + e.message);
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
