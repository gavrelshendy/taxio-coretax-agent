/* Coretax Agent - SPT PDF + BPE download automation (automation feature #2).
   Spec: "Coretax Agent/download SPT.pdf" (user-provided) + live DOM inspection against a real
   session (BAI/BKA/PNG entities, 2026-07-18) - the spec's screenshots don't show real
   selectors, so every id/class below was confirmed live before being written here (see the
   inline "CONFIRMED LIVE" notes), the same discipline already proven for automation/ebupot.js.

   Shares its generic PrimeNG datatable mechanics (filter cells, pagination, event-driven
   single-file download) with ebupot.js via lib/datatable.js rather than duplicating them.

   Two things this page does that e-Bupot's pages don't:
     - "Model SPT" (Normal vs "Amendment NNN") changes the target filename (adds " PB N");
     - the PDF-download button has an on-demand GENERATE step: a not-yet-generated SPT shows a
       grey #RequestDownloadPdfButton (click it, wait, refresh) which becomes a red
       #SubmittedDownloadPdfButton once ready (confirmed live: usually ~4s, and only needs
       requesting once - a later run sees it already generated).
     - a SECOND artifact per row: the "View Receipt" (BPE) modal's <iframe srcdoc="..."> turned
       out to be a complete, self-contained HTML document (own <title>, full inline CSS) - not
       something that needs a screenshot at all. Rendered straight to an A4 PDF via
       lib/html-to-pdf.js's headless-Chromium renderer, which produces crisper vector text than
       rasterizing a screenshot would and sidesteps fitting an arbitrary on-screen size to A4. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const entitiesLib = require('../lib/entities');
const { masaToIndoLabel, parseMasaListInput } = require('../lib/masa');
const runcontrol = require('../lib/runcontrol');
const htmlToPdf = require('../lib/html-to-pdf');
const {
    _sleep, waitForTableSettled, filterCellForHeader,
    getDataRows, getHeaderIndexMap, findHeaderIndex, rowCellText, sanitizeFilenamePart,
    downloadViaClick
} = require('../lib/datatable');

const SPT_URL = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';

// CONFIRMED LIVE (2026-07-18): the "Jenis Pajak" filter is a p-multiselect whose checkbox
// labels are these exact strings; "Jenis Surat Pemberitahuan Pajak" column text and filename
// tokens (SPT vs BPE) per the user's spec.
const JENIS_PAJAK = {
    pph21: { checkboxLabel: 'PPh Pasal 21/26', jenisSurat: 'SPT Masa PPh Pasal 21/26', sptToken: '1721 INDUK', bpeToken: '1721 BPE' },
    unifikasi: { checkboxLabel: 'PPh Unifikasi', jenisSurat: 'SPT Masa PPh Unifikasi', sptToken: 'UNIFIKASI INDUK', bpeToken: 'UNIFIKASI BPE' },
    ppn: { checkboxLabel: 'PPN', jenisSurat: 'SPT Masa PPN', sptToken: 'PPN INDUK', bpeToken: 'PPN BPE' }
};
const JENIS_PAJAK_LABELS = { pph21: 'PPh 21/26', unifikasi: 'PPh Unifikasi', ppn: 'PPN' };

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Matches an option's FULL, exact text (anchored regex) rather than Playwright's default
 *  substring `hasText` - CONFIRMED LIVE this matters here: "PPN" as a substring also matches
 *  "PPN Bagi PKP yang Menggunakan...", "PPN Bagi Pemungut PPN PMSE", etc in the Jenis Pajak
 *  list, and (even more visibly, per a live screenshot) searching "Januari 2025" in the Masa
 *  Pajak dropdown returns the exact "Januari 2025" entry MIXED IN with several range entries
 *  that also contain that string ("Oktober 2024 - Januari 2025", "Februari 2024 - Januari
 *  2025", ...) - a plain substring match would click whichever of those happens to be first. */
function exactOptionLocator(page, panelSelector, label) {
    return page.locator(panelSelector).filter({ hasText: new RegExp('^\\s*' + escapeRegExp(label) + '\\s*$') }).first();
}

/** Sets the "Jenis Pajak" multi-select filter to check EXACTLY `checkboxLabels` (and nothing
 *  else) - revised per explicit user direction: check every requested type AT ONCE (e.g. PPN +
 *  PPh 21/26 together) rather than looping one type at a time, since the multiselect already
 *  supports it and doing so cuts the number of filter-reapply cycles from
 *  jenisKeys.length*masaList.length down to just masaList.length. Always clears first (the
 *  exact BPA1 stale-filter lesson: a previous combo's checked box left checked would silently
 *  widen this one). Confirmed live the panel has a search box - used per label instead of
 *  scrolling a virtualized list to find e.g. "PPh Unifikasi". */
async function setJenisPajakFilters(page, checkboxLabels) {
    const cell = await filterCellForHeader(page, 'Jenis Pajak');
    const clearBtn = cell.locator('.p-multiselect-clear-icon, .p-column-filter-clear-button, [aria-label="Clear"]').first();
    if (await clearBtn.isVisible({ timeout: 500 }).catch(() => false)) await clearBtn.click({ timeout: 2000 }).catch(() => {});
    await cell.locator('.p-multiselect').click({ timeout: 2000 }).catch(() => {});
    const searchInput = page.locator('.p-multiselect-panel input[type="text"], .p-multiselect-filter-container input').first();
    const hasSearch = await searchInput.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    for (const label of checkboxLabels) {
        if (hasSearch) {
            await searchInput.fill(label).catch(() => {});
            await page.waitForTimeout(500);
        }
        const item = exactOptionLocator(page, '.p-multiselect-panel li, .p-multiselect-item', label);
        await item.waitFor({ state: 'visible', timeout: 5000 });
        await item.click({ timeout: 2000 });
        if (hasSearch) { await searchInput.fill('').catch(() => {}); await page.waitForTimeout(300); }
    }
    await page.keyboard.press('Escape').catch(() => {});
}

/** Sets the "Masa Pajak" filter to the EXACT single month `mmYY`. CONFIRMED LIVE this column's
 *  dropdown is NOT the same simple per-month picker as e-Bupot's "Masa Pajak" - its default
 *  option list is a bunch of coarse preset RANGES ("Agustus 2025 - Juli 2026", etc.), and even
 *  after typing a specific month into its search box, the exact single-month entry appears
 *  mixed in among several range entries that also contain that month as their start/end
 *  (confirmed via live screenshot: searching "Januari 2025" surfaces "Januari 2025" itself
 *  alongside "Oktober 2024 - Januari 2025", "November 2024 - Januari 2025", etc). Per explicit
 *  user direction, filtering (not paginating and text-matching every row - row order isn't
 *  reliably sorted by masa, confirmed live) is still the right approach here; it just needs an
 *  EXACT text match on the option, not a substring one. */
async function setSptMasaFilter(page, mmYY) {
    const label = masaToIndoLabel(mmYY);
    const cell = await filterCellForHeader(page, 'Masa Pajak');
    const clearBtn = cell.locator('.p-multiselect-clear-icon, .p-dropdown-clear-icon, .p-column-filter-clear-button, [aria-label="Clear"]').first();
    if (await clearBtn.isVisible({ timeout: 500 }).catch(() => false)) await clearBtn.click({ timeout: 2000 }).catch(() => {});
    await cell.locator('.p-dropdown').click({ timeout: 2000 }).catch(() => {});
    const searchInput = page.locator('.p-dropdown-panel input[type="text"], .p-dropdown-filter-container input').first();
    if (await searchInput.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
        await searchInput.fill(label).catch(() => {});
        await page.waitForTimeout(600);
    }
    const option = exactOptionLocator(page, '.p-dropdown-panel li, .p-dropdown-item', label);
    const found = await option.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!found) { await page.keyboard.press('Escape').catch(() => {}); throw new Error('Masa "' + label + '" tidak ditemukan di daftar SPT (mungkin tidak ada data untuk periode ini).'); }
    await option.click({ timeout: 2000 });
    await page.keyboard.press('Escape').catch(() => {});
}

/** "Normal" -> null (no filename suffix); "Amendment 001" -> "1" (leading zeros stripped) per
 *  the spec's "Kalo ammendment X -> MMYY PB X" naming rule. */
function parseModelSptSuffix(modelText) {
    const m = /amendment\s+0*(\d+)/i.exec(modelText || '');
    return m ? String(parseInt(m[1], 10)) : null;
}

/** Per the spec's exact format: "ENTITY CODE - <token> MMYY[ PB N]" - ONE dash (after the
 *  entity code only); everything after that is space-separated, e.g. "BAI - PPN INDUK 0326.pdf"
 *  or "PJS - 1721 INDUK 0626 PB 1.pdf" for an amendment. */
function buildSptFilename(entityCode, token, mmYY, pbSuffix) {
    const suffix = mmYY + (pbSuffix ? ' PB ' + pbSuffix : '');
    return sanitizeFilenamePart(entityCode) + ' - ' + token + ' ' + suffix + '.pdf';
}

/** CONFIRMED LIVE: the toolbar's refresh icon, same "table needs a manual refresh after a
 *  server-side generate request" pattern the user's spec calls out. */
async function clickRefreshIcon(page) {
    const btn = page.locator('button:has(.pi-refresh)').first();
    const visible = await btn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!visible) return false;
    await btn.click({ noWaitAfter: true, timeout: 5000, force: true }).catch(() => {});
    return true;
}

/** Opens the row's "View Receipt" (BPE) modal, reads the iframe's full standalone HTML
 *  document straight from its `srcdoc` attribute (CONFIRMED LIVE: not a screenshot target at
 *  all - a complete <html> doc with its own <title>Bukti Penerimaan Elektronik</title> and
 *  inline CSS), renders it to an A4 PDF via the shared headless-Chromium renderer, and closes
 *  the modal. Returns true on success. */
async function downloadBpe(row, targetPath, page, emit) {
    const btn = row.locator('#ViewReceiptButton');
    const visible = await btn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!visible) { emit('Tombol "View Receipt" tidak ditemukan di baris ini - BPE dilewati.'); return false; }
    await btn.evaluate(el => el.click()).catch(() => btn.click({ timeout: 3000, force: true }).catch(() => {}));
    const iframe = page.locator('iframe[title="View Receipt"]').first();
    const iframeVisible = await iframe.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    let ok = false;
    if (iframeVisible) {
        const html = await iframe.getAttribute('srcdoc').catch(() => null);
        if (html) {
            try { await htmlToPdf.renderHtmlToPdf(html, targetPath); ok = true; }
            catch (e) { emit('Gagal membuat PDF BPE: ' + e.message); }
        } else {
            emit('Konten BPE kosong - dilewati.');
        }
    } else {
        emit('Modal "View Receipt" tidak terbuka - BPE dilewati.');
    }
    // Close the dialog regardless of outcome so the next row's actions aren't blocked by it.
    await page.locator('.p-dialog-header-close').first().click({ timeout: 2000, force: true }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return ok;
}

/** Mirrors coretax-helper/run.js's copyToCompliance(): a SEPARATE copy of each downloaded file
 *  alongside the original save, into whatever folder Taxio's own compliance settings resolved
 *  (`comp_folder`, from the deep link) - a legacy feature explicitly called out as one to keep,
 *  not drop, in this replacement. Best-effort; never fails the download itself over this. */
function copyToCompliance(srcPath, compFolder, emit) {
    if (!compFolder) return;
    try {
        fs.mkdirSync(compFolder, { recursive: true });
        const dest = path.join(compFolder, path.basename(srcPath));
        if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
        fs.copyFileSync(srcPath, dest);
    } catch (e) {
        emit('Gagal menyalin ke folder compliance: ' + e.message);
    }
}

const REQUEST_ROUNDS = 3; // matches the legacy tool's own retry depth for the generate-then-refresh cycle
// CONFIRMED LIVE: a row can show ready yet a single click doesn't fire a download (timing
// hiccup on the click/event race, not a broken row - the SAME row succeeded moments later) -
// two short attempts in place, same shape as e-Bupot's own proven ROW_TIMEOUTS_MS.
const ROW_RETRY_TIMEOUTS_MS = [8000, 15000];

const LABEL_TO_JENIS_KEY = new Map(Object.entries(JENIS_PAJAK).map(([k, v]) => [v.checkboxLabel, k]));

/** Runs one already-filtered (Jenis Pajak(s) + exact Masa Pajak) combo. Revised per explicit
 *  user direction to check MULTIPLE Jenis Pajak at once (e.g. PPN + PPh 21/26 together) rather
 *  than looping one type at a time - so a combo's rows can now span more than one tax type, and
 *  each row's OWN "Jenis Pajak" column text (not a fixed combo-wide value) decides which
 *  filename token/meta applies. Requests generation for any row still showing the grey button,
 *  refreshes, and re-checks up to REQUEST_ROUNDS times, downloading the SPT PDF + BPE once each
 *  row's button is ready. `onRowDone(jenisKey, mmYY, ok)` lets the caller (the deep-link
 *  integration) mark Taxio's own compliance record the same way the legacy tool did - optional
 *  for the plain GUI-driven run. */
async function processSptCombo(ctx) {
    const { page, saveDir, entityCode, mmYY, compFolder, onRowDone, log: emit } = ctx;
    let downloadedAny = false;
    let foundAny = false;
    for (let round = 0; round < REQUEST_ROUNDS; round++) {
        await runcontrol.checkpoint();
        if (round > 0) {
            emit('Menunggu proses permintaan PDF selesai (percobaan ke-' + (round + 1) + '/' + REQUEST_ROUNDS + ')...');
            await _sleep(5000);
            await clickRefreshIcon(page);
            await waitForTableSettled(page, 10000);
        }
        const headerMap = await getHeaderIndexMap(page);
        const modelIdx = findHeaderIndex(headerMap, [/model spt/]);
        const jenisIdx = findHeaderIndex(headerMap, [/^jenis pajak$/]);
        const rows = getDataRows(page);
        const count = await rows.count();
        if (count === 0) { emit('Tidak ada data untuk filter ini.'); break; }
        if (count === 1) {
            const t = (await rows.first().innerText().catch(() => '')).toLowerCase();
            if (t.indexOf('tidak ada data') !== -1) { emit('Tidak ada data untuk filter ini.'); break; }
        }
        foundAny = true;
        let anyStillPending = false;
        for (let i = 0; i < count; i++) {
            await runcontrol.checkpoint();
            const row = rows.nth(i);
            const jenisText = await rowCellText(row, jenisIdx);
            const jenisKey = LABEL_TO_JENIS_KEY.get(jenisText);
            if (!jenisKey) { emit('Baris ke-' + (i + 1) + ': Jenis Pajak "' + jenisText + '" tidak dikenali - dilewati.'); continue; }
            const meta = JENIS_PAJAK[jenisKey];
            const modelText = await rowCellText(row, modelIdx);
            const pbSuffix = parseModelSptSuffix(modelText);
            const sptPath = path.join(saveDir, buildSptFilename(entityCode, meta.sptToken, mmYY, pbSuffix));
            const bpePath = path.join(saveDir, buildSptFilename(entityCode, meta.bpeToken, mmYY, pbSuffix));
            if (fs.existsSync(sptPath) && fs.existsSync(bpePath)) continue; // already have both artifacts
            const subBtn = row.locator('#SubmittedDownloadPdfButton');
            const isReady = (await subBtn.count()) > 0;
            if (!isReady) {
                const reqBtn = row.locator('#RequestDownloadPdfButton');
                if ((await reqBtn.count()) > 0) {
                    emit('Baris ke-' + (i + 1) + ' (' + jenisText + ', ' + modelText + '): PDF belum tersedia - meminta pembuatan...');
                    await reqBtn.click({ timeout: 3000, force: true }).catch(() => {});
                    anyStillPending = true;
                }
                continue; // re-checked next round after a refresh
            }
            let rowOk = true;
            if (!fs.existsSync(sptPath)) {
                // Short in-place retry (mirrors e-Bupot's own proven ROW_TIMEOUTS_MS pattern):
                // CONFIRMED LIVE that a row can show ready (#SubmittedDownloadPdfButton present)
                // yet a single click doesn't fire a download - re-checking moments later found
                // the SAME row still ready and downloadable, so this is a timing hiccup on the
                // click/event race, not a genuinely broken row. Retrying now (still within this
                // round) is far cheaper than falling through to a whole extra 5s-wait+refresh
                // combo-level round just to re-click a button that was already ready.
                let result = 'not-ready';
                for (let attempt = 0; attempt < ROW_RETRY_TIMEOUTS_MS.length && result === 'not-ready'; attempt++) {
                    await runcontrol.checkpoint();
                    chrome.downloadFlag.automated = true;
                    try { result = await downloadViaClick(page, subBtn, chrome.DOWNLOAD_DIR, sptPath, ROW_RETRY_TIMEOUTS_MS[attempt]); }
                    finally { chrome.downloadFlag.automated = false; }
                }
                if (result === 'downloaded') { downloadedAny = true; emit('Terunduh: ' + path.basename(sptPath)); copyToCompliance(sptPath, compFolder, emit); }
                else { rowOk = false; emit('Baris ke-' + (i + 1) + ': SPT PDF gagal terunduh - dilewati, bisa diulang manual.'); }
            } else copyToCompliance(sptPath, compFolder, emit); // already had it from an earlier run - still ensure the compliance copy exists
            if (!fs.existsSync(bpePath)) {
                const bpeOk = await downloadBpe(row, bpePath, page, emit);
                if (bpeOk) { emit('Terunduh: ' + path.basename(bpePath)); copyToCompliance(bpePath, compFolder, emit); }
                else rowOk = false;
            } else copyToCompliance(bpePath, compFolder, emit);
            if (onRowDone) { try { onRowDone(jenisKey, mmYY, rowOk); } catch (e) {} }
        }
        if (!anyStillPending) break;
    }
    return { downloadedAny, foundAny };
}

/** Top-level entry point. `opts`:
 *   client, orgId, entity ({entity_id, entity_name, npwp, individual}), picId,
 *   jenisPajakKeys (array of 'pph21'|'unifikasi'|'ppn'), masaInput (string, e.g. "0125-1225"
 *   or a single "0626"), saveRoot (optional), manualPage (optional, manual-session mode),
 *   compFolder (optional - a SEPARATE copy of each downloaded file also lands here, e.g.
 *   Taxio's own per-entity compliance folder; legacy tool's copyToCompliance() equivalent),
 *   onRowDone (optional (jenisKey, mmYY, ok) => void - compliance write-back hook). */
async function runSptDownload(opts) {
    const { client, orgId, entity, picId, jenisPajakKeys } = opts;
    const keys = (jenisPajakKeys || []).filter((k) => JENIS_PAJAK[k]);
    if (!keys.length) throw new Error('Jenis pajak belum dipilih.');
    const masaList = parseMasaListInput(opts.masaInput);
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');

    const manual = !!opts.manualPage;
    log('Memulai download SPT (' + keys.map((k) => JENIS_PAJAK_LABELS[k]).join(', ') + ')'
        + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');
    let cred = null, page;
    if (manual) {
        page = opts.manualPage;
        if (chrome.isLoggedOut(page)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
    } else {
        cred = await entitiesLib.getCredential(client, orgId, picId);
        ({ page } = await chrome.launchOrReuseContext(picId, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
        }));
    }

    async function loginAndImpersonate() {
        if (manual) {
            if (chrome.isLoggedOut(page)) throw new Error('Sesi manual berakhir - silakan login ulang di jendela Coretax lalu klik 🔁 Ulang.');
            return;
        }
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint });
    }
    await loginAndImpersonate();

    try {
        const coretaxAs = manual
            ? await chrome.getManualStatus().then((s) => s.identity).catch(() => '')
            : (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
        runcontrol.setCoretaxAs(coretaxAs || entity.entity_name);
    } catch (e) {}

    async function openSptAndPrep() {
        const NAV_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
            await runcontrol.checkpoint();
            try {
                await page.goto(SPT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                if (chrome.isLoggedOut(page)) {
                    log('Halaman SPT memantulkan ke login - login ulang lalu buka lagi...');
                    await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint });
                    continue;
                }
                await waitForTableSettled(page, 20000);
                const tableThere = await page.locator('table.p-datatable-table, .p-datatable-tbody, .p-paginator').first()
                    .isVisible({ timeout: 8000 }).catch(() => false);
                if (!tableThere) throw new Error('Tabel SPT tidak muncul (halaman mungkin gagal dimuat).');
                return;
            } catch (e) {
                if (attempt === NAV_ATTEMPTS) throw new Error('Gagal membuka halaman SPT setelah ' + NAV_ATTEMPTS + ' percobaan: ' + e.message);
                const waitMs = 3000 * attempt;
                log('Gagal membuka halaman SPT (percobaan ' + attempt + '/' + NAV_ATTEMPTS + '): ' + e.message + ' - coba lagi dalam ' + (waitMs / 1000) + ' detik...');
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
    }
    await openSptAndPrep();

    const stats = { downloaded: 0, combosDone: 0, combosSkipped: 0 };
    let stopped = false;

    // One combo per masa - the Jenis Pajak filter checks ALL requested types at once (per
    // explicit user revision), so a single filtered result set can contain rows of several
    // types; processSptCombo reads each row's own "Jenis Pajak" column to sort that out.
    const jenisLabel = keys.map((k) => JENIS_PAJAK_LABELS[k]).join(' + ');
    const combos = masaList.map((mmYY) => ({ mmYY, comboLabel: jenisLabel + ' / ' + masaToIndoLabel(mmYY) }));

    async function runCombo(combo) {
        const { mmYY, comboLabel } = combo;
        const emit = (m) => log('[SPT ' + comboLabel + '] ' + m);
        try {
            await setJenisPajakFilters(page, keys.map((k) => JENIS_PAJAK[k].checkboxLabel));
            await setSptMasaFilter(page, mmYY);
            await waitForTableSettled(page, 15000);
            const saveDir = path.join(saveRoot, entity.entity_id, 'SPT', mmYY);
            fs.mkdirSync(saveDir, { recursive: true });
            const result = await processSptCombo({
                page, saveDir, entityCode: entity.entity_id, mmYY, compFolder: opts.compFolder,
                onRowDone: opts.onRowDone ? (jk, m, ok) => opts.onRowDone(jk, m, ok) : null,
                log: emit
            });
            if (result.downloadedAny) stats.downloaded++;
            stats.combosDone++;
            return 'next';
        } catch (e) {
            if (e && e.isRetry) { emit('Diulang dari awal atas permintaan pengguna.'); return 'retry'; }
            if (e && e.isBack) { emit('Mundur ke kombinasi sebelumnya atas permintaan pengguna.'); return 'back'; }
            if (e && e.isSkip) { emit('Dilewati atas permintaan pengguna.'); stats.combosSkipped++; return 'next'; }
            if (e && e.isStop) { stopped = true; throw e; }
            if (typeof page.isClosed === 'function' && page.isClosed()) {
                emit('Jendela browser ditutup - proses dihentikan.');
                stopped = true;
                throw Object.assign(new Error('Jendela browser ditutup.'), { isStop: true });
            }
            const curIdx = combos.indexOf(combo);
            emit('Kombinasi ini GAGAL: ' + e.message);
            runcontrol.pauseForDecision(e.message);
            try {
                await runcontrol.checkpoint();
            } catch (ctl) {
                if (ctl && ctl.isRetry) { emit('Diulang atas permintaan pengguna.'); return 'retry'; }
                if (ctl && ctl.isBack) { emit('Mundur atas permintaan pengguna.'); return 'back'; }
                if (ctl && ctl.isSkip) { emit('Dilewati atas permintaan pengguna.'); stats.combosSkipped++; return 'next'; }
                if (ctl && ctl.isStop) { stopped = true; throw ctl; }
            }
            emit('Dilanjutkan setelah jeda - mengulang kombinasi ini (file yang sudah ada dilewati).');
            return 'retry';
        }
    }

    try {
        let i = 0;
        while (i < combos.length) {
            const action = await runCombo(combos[i]);
            if (action === 'retry') continue;
            else if (action === 'back') i = Math.max(0, i - 1);
            else i++;
        }
    } catch (e) {
        if (!(e && e.isStop)) throw e;
    } finally {
        await htmlToPdf.closeRenderer().catch(() => {});
    }

    const doneMsg = (stopped ? 'DIHENTIKAN' : 'SELESAI') + ': SPT "' + entity.entity_name + '" - '
        + stats.combosDone + ' kombinasi selesai' + (stats.combosSkipped ? (', ' + stats.combosSkipped + ' dilewati/gagal') : '') + '.';
    log(doneMsg + ' Jendela dibiarkan terbuka.');
    showPopup(doneMsg, 'Coretax Agent', stopped ? 'Warning' : 'Information');
}

module.exports = { runSptDownload, JENIS_PAJAK, JENIS_PAJAK_LABELS, SPT_URL };
