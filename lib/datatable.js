/* Coretax Agent - generic PrimeNG datatable helpers shared across every Coretax listing page
   (e-Bupot, SPT, and any future one) - extracted from automation/ebupot.js (originally written
   only for that page) once automation/spt.js needed the exact same "filter cell beneath a
   header", "Bulan Tahun dropdown", "paginator", and "event-driven single-file download"
   mechanics against a DIFFERENT Coretax page with an identical PrimeNG structure. Kept as one
   shared module instead of a second copy so a fix made for one page (e.g. the BPA1
   stale-filter-state lesson baked into setMasaPajakFilter's clearing step) automatically
   benefits every page that uses it, rather than silently drifting apart. */
const path = require('path');
const fs = require('fs');
const { masaToIndoLabel } = require('./masa');

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Waits for a PrimeNG-style datatable to finish reloading after a filter/page change - the
 *  loading overlay's presence/absence is a real signal from the page, not a guessed delay. */
async function waitForTableSettled(page, timeoutMs) {
    const end = Date.now() + (timeoutMs || 15000);
    const overlay = page.locator('.p-datatable-loading-overlay, .p-datatable-loading-icon').first();
    // The loading overlay appearing then disappearing IS the "done" signal. Deliberately NO
    // waitForLoadState('networkidle') here: Coretax is an SPA that often keeps a connection
    // open, so networkidle rarely fires and its timeout became a fixed ~2.5s tax on EVERY page
    // turn (the "delay" felt when clicking next). Overlay-based waiting is both correct and fast.
    const appeared = await overlay.waitFor({ state: 'visible', timeout: 400 }).then(() => true).catch(() => false);
    if (appeared) await overlay.waitFor({ state: 'hidden', timeout: Math.max(200, end - Date.now()) }).catch(() => {});
    else await page.waitForTimeout(120); // no overlay shown = fast response; a tiny settle only
}

/** Finds the header cell matching `headerText` and returns the filter-row cell directly
 *  beneath it (PrimeNG's standard header-row + filter-row column layout). Tries the same
 *  column index in the next row if a direct text match inside the filter row itself fails. */
async function filterCellForHeader(page, headerText) {
    const headerCell = page.locator('th', { hasText: headerText }).first();
    await headerCell.waitFor({ state: 'visible', timeout: 10000 });
    const headerRow = headerCell.locator('xpath=ancestor::tr[1]');
    const allHeaders = headerRow.locator('th');
    const count = await allHeaders.count();
    let colIndex = -1;
    for (let i = 0; i < count; i++) {
        const t = (await allHeaders.nth(i).innerText().catch(() => '')).trim();
        if (t.toLowerCase().indexOf(headerText.toLowerCase()) !== -1) { colIndex = i; break; }
    }
    if (colIndex === -1) throw new Error('Kolom "' + headerText + '" tidak ditemukan.');
    // Filter row is typically the row immediately after the header row, same column index.
    const filterRow = headerRow.locator('xpath=following-sibling::tr[1]');
    return filterRow.locator('th,td').nth(colIndex);
}

/** Sets a single-period "Bulan Tahun" dropdown filter (e.g. e-Bupot's/SPT's "Masa Pajak"
 *  column) to the given MMYY, beneath the column whose header text is `headerText`. Tries a
 *  native <select>, then a text input (type + Enter), then a PrimeNG dropdown-click pattern
 *  (open, click the matching option), in that order. */
async function setSingleMasaFilter(page, headerText, mmYY) {
    const label = masaToIndoLabel(mmYY);
    const cell = await filterCellForHeader(page, headerText);
    // Clear any existing value first. `.p-column-filter-clear-button` (the funnel/pi-filter-slash
    // icon) confirmed live as Coretax's actual per-column "reset filter" control - added
    // alongside the dropdown's own inline clear-icon since either can be present depending on
    // the column's filter type.
    const clearBtn = cell.locator('.p-multiselect-clear-icon, .p-dropdown-clear-icon, .p-column-filter-clear-button, [aria-label="Clear"]').first();
    if (await clearBtn.isVisible({ timeout: 500 }).catch(() => false)) await clearBtn.click({ timeout: 2000 }).catch(() => {});

    const nativeSelect = cell.locator('select').first();
    if (await nativeSelect.isVisible({ timeout: 500 }).catch(() => false)) {
        await nativeSelect.selectOption({ label }).catch(() => nativeSelect.selectOption(mmYY).catch(() => {}));
        return;
    }
    const textInput = cell.locator('input[type="text"], input:not([type])').first();
    if (await textInput.isVisible({ timeout: 500 }).catch(() => false)) {
        await textInput.click({ timeout: 2000 }).catch(() => {});
        await textInput.fill(label).catch(() => {});
        // PrimeNG dropdown-style inputs open a panel of matching options on type - click it if one appears.
        const option = page.locator('li, .p-dropdown-item, .p-multiselect-item', { hasText: label }).first();
        if (await option.isVisible({ timeout: 3000 }).catch(() => false)) { await option.click({ timeout: 2000 }).catch(() => {}); }
        else { await textInput.press('Enter').catch(() => {}); }
        await page.keyboard.press('Escape').catch(() => {});
        return;
    }
    // Last resort: click the cell itself to open whatever dropdown it is, then click the option.
    await cell.click({ timeout: 2000 }).catch(() => {});
    const option = page.locator('li, .p-dropdown-item, .p-multiselect-item', { hasText: label }).first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click({ timeout: 2000 });
    await page.keyboard.press('Escape').catch(() => {});
}

/** Sets the page-size (paginator "rows per page" dropdown, bottom-right) to `size`. */
async function setPageSize(page, size) {
    const targetSize = String(size);
    // MUST be strictly scoped inside .p-paginator to NEVER touch top navbar menus
    const paginator = page.locator('.p-paginator').first();
    const pagVisible = await paginator.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!pagVisible) return false;

    const dropdown = paginator.locator('.p-dropdown, .p-paginator-rpp-options').first();
    const visible = await dropdown.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!visible) return false;

    // Check if dropdown text already matches `size`
    const currentText = (await dropdown.innerText().catch(() => '')).trim();
    if (currentText === targetSize) return true;

    // Move mouse down to the paginator area to ensure no hover remains on the top navbar
    await page.mouse.move(500, 750).catch(() => {});

    // Open paginator dropdown by clicking its trigger/label
    const trigger = dropdown.locator('.p-dropdown-trigger, .p-dropdown-label').first();
    if (await trigger.isVisible({ timeout: 1000 }).catch(() => false)) {
        await trigger.click({ timeout: 2000, force: true });
    } else {
        await dropdown.click({ timeout: 2000, force: true });
    }

    // Wait for dropdown panel to appear
    const panel = page.locator('.p-dropdown-panel, .p-dropdown-items').first();
    await panel.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    // Select option (10, 25, 50, 100) inside the panel
    const option = page.locator('.p-dropdown-panel li, .p-dropdown-panel p-dropdownitem, .p-dropdown-item')
        .filter({ hasText: new RegExp('^\\s*' + targetSize + '\\s*$') }).first();
    const optVisible = await option.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (optVisible) {
        await option.click({ timeout: 2000, force: true });
        await waitForTableSettled(page, 15000);
        return true;
    }
    // Fallback: search by substring
    const fallbackOpt = page.locator('.p-dropdown-panel li, .p-dropdown-item', { hasText: targetSize }).first();
    if (await fallbackOpt.isVisible({ timeout: 1500 }).catch(() => false)) {
        await fallbackOpt.click({ timeout: 2000, force: true });
        await waitForTableSettled(page, 15000);
        return true;
    }
    return false;
}

function getDataRows(page) {
    // Body rows only - PrimeNG puts header+filter rows in <thead>, data in <tbody>.
    return page.locator('table.p-datatable-table > tbody > tr, .p-datatable-tbody > tr');
}

async function getHeaderIndexMap(page) {
    const headers = page.locator('table.p-datatable-table thead th, .p-datatable-thead th');
    const count = await headers.count();
    const map = {};
    for (let i = 0; i < count; i++) {
        const t = (await headers.nth(i).innerText().catch(() => '')).trim().toLowerCase();
        if (t) map[t] = i;
    }
    return map;
}
/** Candidates are RegExps tried in order against the lowercased header texts. Regex (not
 *  substring) matching matters here: a plain "nik" substring match hits "Status Tanda Tangan
 *  Elektro**nik**" - which is exactly the bug that once put "Done" into filenames where the
 *  NIK belonged. \b word boundaries prevent that ('elektronik' has no boundary before 'nik'). */
function findHeaderIndex(map, candidates) {
    for (const re of candidates) {
        const key = Object.keys(map).find(k => re.test(k));
        if (key !== undefined) return map[key];
    }
    return -1;
}

async function rowCellText(row, index) {
    if (index < 0) return '';
    const cells = row.locator('td');
    const text = await cells.nth(index).innerText().catch(() => '');
    return text.trim();
}

function sanitizeFilenamePart(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
}

function snapshotDir(dir) {
    try { return new Set(fs.readdirSync(dir)); } catch (e) { return new Set(); }
}
/** Watches `dir` for a brand-new, fully-written file matching `extRe`. Used as the fallback
 *  when Playwright's own `download` event doesn't fire - the reused-window (CDP) path, where
 *  the real Chrome handles the save itself. NOTE: in that path Chrome saves into the browser's
 *  own default Downloads dir - NOT the caller's per-combo save folder - so callers must watch
 *  THERE and move the file afterwards. */
async function waitForNewCompletedFile(dir, beforeSet, extRe, timeoutMs) {
    const end = Date.now() + Math.max(timeoutMs || 0, 4000);
    while (Date.now() < end) {
        let files; try { files = fs.readdirSync(dir); } catch (e) { files = []; }
        const stillDownloading = files.some(f => /\.crdownload$/i.test(f));
        const candidates = files.filter(f => !beforeSet.has(f) && extRe.test(f));
        if (candidates.length && !stillDownloading) {
            let best = null, bestT = 0;
            for (const f of candidates) {
                try { const t = fs.statSync(path.join(dir, f)).mtimeMs; if (t >= bestT) { bestT = t; best = f; } } catch (e) {}
            }
            if (best) return best;
        }
        await _sleep(250);
    }
    return null;
}
/** Moves a file across directories, tolerating cross-device rename failure. */
function moveFile(src, dest) {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    try { fs.renameSync(src, dest); }
    catch (e) { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
}

/** Confirmed live that pkg's default bytecode compilation was the actual root cause of a related
 *  failure (locator.evaluate() throwing "not well-serializable" only inside the packaged exe,
 *  never in `node main.js`, because bytecode strips function source so Playwright's
 *  Function.toString()-based serializer chokes on it) - fixed by reading the `class` attribute
 *  as a plain string (below) instead of running classList.contains() in-page via evaluate(),
 *  which sidesteps function serialization entirely. This retry is still worth keeping
 *  defensively: a page/table action can leave the paginator transiently unreadable for a
 *  moment, and a single failed read here would otherwise silently truncate a real multi-page
 *  result to "just page 1" - the worst possible failure mode for a download tool. */
async function isNextPageDisabled(page) {
    await waitForTableSettled(page, 8000); // let any post-export/post-download reload finish first
    async function readOnce() {
        const nextBtn = page.locator('.p-paginator-next').last();
        const attr = await nextBtn.getAttribute('disabled');
        if (attr !== null) return true;
        const cls = await nextBtn.getAttribute('class');
        return cls != null && /(^|\s)p-disabled(\s|$)/.test(cls);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const disabled = await readOnce();
            if (!disabled) return false; // definitely more pages - no need to re-confirm this one
            await _sleep(400); // looked disabled - could be a mid-reload blip, confirm before trusting it
        } catch (e) {
            await _sleep(400); // couldn't even read it - same idea, give the DOM a moment to settle
        }
    }
    // Still reads as disabled (or unreadable) after several tries - genuinely no more pages.
    return true;
}
async function goToNextPage(page) {
    const nextBtn = page.locator('.p-paginator-next').last();
    await nextBtn.dispatchEvent('click').catch(() => nextBtn.click({ timeout: 3000, force: true, noWaitAfter: true }));
    await waitForTableSettled(page, 8000);
}

/** Clicks `btnLocator` and saves the resulting download to `targetPath`, racing Playwright's
 *  own `download` event against the click with a filesystem-watch fallback for the reused-
 *  window (CDP) path where the real Chrome handles the save itself. Returns 'downloaded' or
 *  'not-ready' (click landed but no file materialized within `timeoutMs` - caller may retry
 *  after a refresh). Caller owns chrome.downloadFlag scoping around this call (see
 *  automation/ebupot.js's per-row comment for why that must span an entire retry sequence,
 *  not just one call) - this helper doesn't touch that flag itself. */
async function downloadViaClick(page, btnLocator, downloadDir, targetPath, timeoutMs) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const before = snapshotDir(downloadDir);
    try {
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: timeoutMs }),
            btnLocator.dispatchEvent('click').catch(() => btnLocator.click({ noWaitAfter: true, timeout: 5000, force: true }))
        ]);
        await download.saveAs(targetPath);
        const tempPath = await download.path().catch(() => null);
        if (tempPath && fs.existsSync(tempPath) && tempPath !== targetPath) { try { fs.rmSync(tempPath, { force: true }); } catch (e) {} }
        return 'downloaded';
    } catch (e) {
        const newFile = await waitForNewCompletedFile(downloadDir, before, /\.pdf$/i, timeoutMs);
        if (newFile) {
            try { moveFile(path.join(downloadDir, newFile), targetPath); } catch (re) { /* keep it where Chrome put it if the move fails */ }
            return 'downloaded';
        }
        return 'not-ready';
    }
}

module.exports = {
    _sleep, waitForTableSettled, filterCellForHeader, setSingleMasaFilter, setPageSize,
    getDataRows, getHeaderIndexMap, findHeaderIndex, rowCellText, sanitizeFilenamePart,
    snapshotDir, waitForNewCompletedFile, moveFile, isNextPageDisabled, goToNextPage, downloadViaClick
};
