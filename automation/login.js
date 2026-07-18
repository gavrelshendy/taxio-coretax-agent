/* Coretax Agent - standalone "Login Coretax" action (login + impersonate only, no download
   afterwards). Requested explicitly: previously the only way to get a logged-in/impersonated
   Coretax window was to fill in the whole e-Bupot form and start a download - there was no way
   to just log in first, confirm it worked, and decide what to do next. This shares the exact
   same login+impersonate+verify sequence as the e-Bupot flow (lib/chrome.js's
   loginAndImpersonate, which only reports success once Coretax's own JWT `sub` claim actually
   reflects the target entity - see that function's header comment) so "confirmed" here means
   the same thing it means mid-download-run. */
const path = require('path');
const os = require('os');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const entitiesLib = require('../lib/entities');
const runcontrol = require('../lib/runcontrol');
const loginStatus = require('../lib/login-status');

/** `opts`: { client, orgId, entity ({entity_id, entity_name, npwp, individual}), picId } */
async function runLoginOnly(opts) {
    const { client, orgId, entity, picId } = opts;
    log('Login Coretax untuk entitas "' + entity.entity_name + '" (tanpa download)...');
    const cred = await entitiesLib.getCredential(client, orgId, picId);
    const { page } = await chrome.launchOrReuseContext(picId, async (download) => {
        try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
    });
    await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint });
    const coretaxAs = (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
    runcontrol.setCoretaxAs(coretaxAs);
    loginStatus.set(picId, entity);
    log('BERHASIL login & terkonfirmasi impersonate sebagai: ' + coretaxAs + '. Jendela dibiarkan terbuka - silakan pilih & mulai download kapan saja.');
    showPopup('Berhasil login & impersonate sebagai "' + entity.entity_name + '".', 'Coretax Agent', 'Information');
}

module.exports = { runLoginOnly };
