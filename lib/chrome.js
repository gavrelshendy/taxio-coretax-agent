/* Coretax Agent - Chrome/Playwright automation primitives.
   Ported from the proven, live-tested logic in Taxio's coretax-helper/run.js (login form
   fill, Altcha checkbox, entity impersonation switch, code-first impersonation verification,
   per-PIC persistent profile; the old CDP-reuse-for-already-open-window pattern was replaced
   2026-11-12 by closing the leftover window - see terminateProfileProcesses). Deliberately a
   separate profile namespace (originally ~/.coretax-agent-profile, not .taxio-coretax-profile;
   since Tahap 1 %LOCALAPPDATA%\TaxioPilot\profiles\, see lib/paths.js) so this new
   standalone app never touches or collides with the existing, unmodified coretax-helper.

   Split into composable pieces (ensureLoggedIn / switchToEntity) rather than one big
   handleLogin(), since e-Bupot automation needs the same "get logged in as this PIC,
   impersonating this entity" prefix but a completely different action afterwards (navigate to
   a bupot listing + filter + paginate, instead of navigate to a redirect + download SPT). */
// The code lives in lib/chrome-*.js, split by responsibility (see each file's header); this file
// stays the public entry point with the same exports, so callers keep requiring it.
const { hideWindowOffscreen, revealWindow } = require('./chrome-window');
const { DOWNLOAD_DIR, downloadFlag, markAutomatedDownload, clearDownloadTemp, BILLING_BLOB_BRIDGE_INIT } = require('./chrome-downloads');
const { PROFILE_ROOT, PROFILE_ROOT_BUNDLED, _sleep, userDataDirFromCommandLine, isOwnProfileDir, findProfileProcessPids, terminateProfileProcesses, listChromeProcesses } = require('./chrome-profile');
const { CORETAX_LOGIN_URL, firstVisible, clickAltchaCheckbox, ensureLoggedIn, hasPortalSession, attachApiErrorLog, isLoggedOut } = require('./chrome-login');
const { openCoretaxManual, getManualPage, getManualStatus, getEntityStatus, launchOrReuseContext, getLiveEntityPage, listLiveSessions, bringSessionToFront, closeLiveSession, closeAllAutomationWindows, openProfileDirs } = require('./chrome-sessions');
const { verifyImpersonationByCode, switchToEntity, loginAndImpersonate } = require('./chrome-impersonate');

module.exports = {
    CORETAX_LOGIN_URL, DOWNLOAD_DIR, PROFILE_ROOT, downloadFlag, markAutomatedDownload, clearDownloadTemp, BILLING_BLOB_BRIDGE_INIT,
    firstVisible, clickAltchaCheckbox, verifyImpersonationByCode,
    openCoretaxManual, getManualPage, getManualStatus, getEntityStatus, launchOrReuseContext, getLiveEntityPage,
    listLiveSessions, bringSessionToFront, closeLiveSession,
    ensureLoggedIn, hasPortalSession, switchToEntity, loginAndImpersonate, attachApiErrorLog, isLoggedOut, revealWindow, hideWindowOffscreen, _sleep,
    closeAllAutomationWindows, openProfileDirs,
    userDataDirFromCommandLine, isOwnProfileDir, findProfileProcessPids, terminateProfileProcesses, listChromeProcesses, PROFILE_ROOT_BUNDLED
};
