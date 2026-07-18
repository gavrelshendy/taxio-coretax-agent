/* Coretax Agent - e-Bupot PDF download automation (automation feature #1).
   Spec: "Coretax Agent/Download PDF EBUPOT otomatis.pdf" (user-provided).

   Replaces the user's earlier approach (a Chrome extension that queried
   `document.querySelectorAll('#DownloadButton')` and fired every click at once with a fixed
   2s*index stagger - unreliable: duplicate/skipped downloads, and no recovery from Coretax's
   mid-run auto-logout). This version, per the user's explicit direction:
     - is code-based, not visual-based: every "is this done yet" check reads real page/network
       state (a fired `download` event, a paginator button's disabled attribute, a loading
       overlay's presence) - never a screenshot/eyeballed heuristic;
     - never uses a fixed delay to pace itself - every wait is event-driven with a generous
       ceiling, so a fast Coretax response finishes fast and a slow one just gets more patience
       instead of the whole run being paced to the slowest case;
     - downloads strictly one row at a time, waiting for that specific row's download to
       actually complete before moving to the next - eliminates the extension's duplicate/
       skip problem by construction;
     - tracks already-downloaded reference numbers per filter combination, so a mid-run
       re-login (Coretax's session timeout during a long run) can safely resume without
       re-downloading or losing rows.

   NOTE ON SELECTOR CERTAINTY: this file was written from the user's written spec + a few
   screenshots, without live access to the actual Coretax e-Bupot pages (unlike the original
   SPT flow in coretax-helper/run.js, which was iterated against the live site over multiple
   rounds - see its own "confirmed by direct inspection" comments). Every DOM lookup below
   uses the same multi-strategy, resilient pattern already proven in this codebase (try
   several locator strategies, first visible match wins) specifically because the exact
   selectors are the least certain part of this file - expect to adjust `setColumnFilterByHeader`,
   `getDownloadButton`, and the header-name lists in `extractRowFields` after a first live run. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const entitiesLib = require('../lib/entities');
const { masaToIndoLabel, parseMasaListInput, parseKodeObjekInput } = require('../lib/masa');
const excel = require('../lib/excel');
const runcontrol = require('../lib/runcontrol');
const {
    _sleep, waitForTableSettled, filterCellForHeader, setSingleMasaFilter, setPageSize,
    getDataRows, getHeaderIndexMap, findHeaderIndex, rowCellText, sanitizeFilenamePart,
    snapshotDir, waitForNewCompletedFile, moveFile, isNextPageDisabled, goToNextPage
} = require('../lib/datatable');
// Generic helper, e-Bupot-specific name kept as a thin alias (this page's period column is
// also literally called "Masa Pajak") so every existing call site below stays unchanged.
const setMasaPajakFilter = (page, mmYY) => setSingleMasaFilter(page, 'Masa Pajak', mmYY);

const BUPOT_URLS = {
    bppu: 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbpu/issued',
    bp21: 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbp21/issued',
    bpa1: 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbpa1/issued',
    bpmp: 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotmp/issued'
};
const BUPOT_LABELS = { bppu: 'BPPU', bp21: 'BP21', bpa1: 'BPA1', bpmp: 'BPMP' };
const HAS_KODE_OBJEK_FILTER = { bppu: true, bp21: true, bpa1: false, bpmp: false };
// BPMP has no per-slip PDF - it's Excel-only by nature, so PDF output is force-disabled for
// it regardless of the user's output-mode choice. The other three can do either.
const BUPOT_PDF_CAPABLE = { bppu: true, bp21: true, bpa1: true, bpmp: false };
// BPMP's period filter is assumed to be a single "Masa Pajak" dropdown like BP21/BPPU
// (unverified against the live page - adjust if a first live run logs "Kolom ... tidak
// ditemukan"). BPA1 is the only one using the awal/akhir range pair.
const BUPOT_USES_RANGE_FILTER = { bpa1: true };

/** Sets BPA1's "Masa Akhir Periode Penghasilan" filter ONLY. CORRECTED per explicit live
 *  user direction after a real "Tidak ada data" false-negative (PESONA NATASHA GEMILANG, BPA1,
 *  Juni 2026): the previous version also constrained "Masa Awal Periode Penghasilan" to the
 *  same single period, which is wrong - a BPA1 slip's start-of-income-period is very often
 *  earlier than its end period, so pinning both to the same month excluded genuinely matching
 *  rows. "Masa Awal" must never be SET - and, confirmed live in the same debugging session,
 *  merely not-setting it isn't enough either: Coretax's filter state persists across page
 *  navigations within a session, so a stale "Masa Awal" value from an earlier run/combo (e.g.
 *  before this fix, or a prior masa in the same run) silently kept re-narrowing every
 *  subsequent BPA1 filter to the SAME false "Tidak ada data" result. So: explicitly CLEAR
 *  "Masa Awal" every time, don't just leave it alone. */
async function setBpa1RangeFilter(page, mmYY) {
    const startCell = await filterCellForHeader(page, 'Masa Awal Periode Penghasilan');
    const startClear = startCell.locator('.p-multiselect-clear-icon, .p-dropdown-clear-icon, .p-column-filter-clear-button, [aria-label="Clear"]').first();
    if (await startClear.isVisible({ timeout: 500 }).catch(() => false)) await startClear.click({ timeout: 2000 }).catch(() => {});

    const cell = await filterCellForHeader(page, 'Masa Akhir Periode Penghasilan');
    const label = masaToIndoLabel(mmYY);
    const clearBtn = cell.locator('.p-multiselect-clear-icon, .p-dropdown-clear-icon, .p-column-filter-clear-button, [aria-label="Clear"]').first();
    if (await clearBtn.isVisible({ timeout: 500 }).catch(() => false)) await clearBtn.click({ timeout: 2000 }).catch(() => {});
    await cell.click({ timeout: 2000 }).catch(() => {});
    const textInput = cell.locator('input').first();
    if (await textInput.isVisible({ timeout: 800 }).catch(() => false)) await textInput.fill(label).catch(() => {});
    const option = page.locator('li, .p-dropdown-item, .p-multiselect-item', { hasText: label }).first();
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) await option.click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
}

/** Sets the "Kode Objek Pajak" free-text filter (BPPU/BP21 only). Empty string clears it
 *  (spec's "default all"). */
async function setKodeObjekFilter(page, kode) {
    const cell = await filterCellForHeader(page, 'Kode Objek Pajak');
    const input = cell.locator('input').first();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(kode || '');
    await input.press('Enter').catch(() => {});
}

/** Sorts by "Nomor Pemotongan" once so row order stays stable across a mid-run re-login -
 *  the exact workaround the user's own spec describes using manually. */
async function sortByNomorPemotongan(page) {
    const header = page.locator('th:has-text("Nomor Pemotongan"), th:has-text("Nomor Bukti"), .p-sortable-column:has-text("Nomor Pemotongan")').first();
    const visible = await header.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (visible) {
        await header.click({ timeout: 3000, force: true, noWaitAfter: true }).catch(() => {});
        await waitForTableSettled(page, 8000);
        return true;
    }
    return false;
}

/** Reads the fields needed for the target filename from a row, matching by column header
 *  name (robust to column reordering) rather than a hardcoded index. Falls back gracefully -
 *  a run should never hard-crash just because one field wasn't where expected. */
async function extractRowFields(row, headerMap) {
    const refIdx = findHeaderIndex(headerMap, [/nomor pemotongan/, /nomor bukti/]);
    const kodeIdx = findHeaderIndex(headerMap, [/kode objek/]);
    // NIK: prefer an explicit NPWP/NIK header; \bnik\b so "Tanda Tangan Elektronik" never matches.
    const nikIdx = findHeaderIndex(headerMap, [/npwp\s*\/?\s*nik/, /\bnik\b/, /npwp/]);
    const namaIdx = findHeaderIndex(headerMap, [/\bnama\b/]);
    const [ref, kodeObjek, nik, nama] = await Promise.all([
        rowCellText(row, refIdx), rowCellText(row, kodeIdx), rowCellText(row, nikIdx), rowCellText(row, namaIdx)
    ]);
    return { ref: ref || null, kodeObjek: kodeObjek || '', nik: nik || '', nama: nama || '' };
}

/** Filename per the user's exact spec: "MMYY - Kode Objek Pajak - Nomor Pemotongan - NIK -
 *  NAMA.pdf", name capped at 2 words. Nomor Pemotongan in the name is what makes every slip's
 *  filename unique - without it, one person's Normal + Pembetulan slips (same masa/kode/NIK)
 *  collapsed onto one filename and silently overwrote each other, which is why downloads
 *  previously "felt incomplete". */
function buildTargetFilename(mmYY, kodeObjek, ref, nik, nama) {
    const namaShort = sanitizeFilenamePart(nama).split(/\s+/).slice(0, 2).join(' ');
    const parts = [mmYY, sanitizeFilenamePart(kodeObjek), sanitizeFilenamePart(ref), sanitizeFilenamePart(nik), namaShort].filter(Boolean);
    return parts.join(' - ') + '.pdf';
}

/** The row's download icon. Tries the id the user's own extension code used first
 *  (`#DownloadButton`, scoped to this row so it's safe even if the id isn't unique across
 *  rows), then falls back to icon-class guesses matching the same "red PDF/download icon"
 *  pattern already proven for the SPT flow. */
function getDownloadButton(row) {
    return row.locator('#DownloadButton, button:has(.pi-file-pdf), button:has(.pi-download), a:has(.pi-file-pdf)').first();
}

/** Downloads one row's PDF straight to `targetPath`. Returns 'downloaded' | 'not-ready'
 *  (button was there but no file materialized - caller may retry after a refresh) |
 *  'not-found' (no download control in this row at all). Purely event-driven: races
 *  Playwright's own `download` event against the click, with a filesystem-watch fallback for
 *  the case where the real (non-Playwright-intercepted) Chrome handled the save itself -
 *  identical two-tier strategy already proven in coretax-helper's SPT download flow. */
async function downloadRow(page, row, targetPath, timeoutMs) {
    const btn = getDownloadButton(row);
    const attached = await btn.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);
    if (!attached) return 'not-found';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    // Snapshot the BROWSER's default Downloads dir (not our save folder) - that's where the
    // reused-window fallback file lands (see waitForNewCompletedFile's note).
    const before = snapshotDir(chrome.DOWNLOAD_DIR);
    // NOTE: chrome.downloadFlag.automated is set/reset by the CALLER (downloadCurrentResultSet),
    // scoped to the whole row's retry sequence rather than this one call - see that call site's
    // comment for why (a slow Coretax can make this exact attempt's click succeed AFTER this
    // function has already given up and moved to the next retry attempt).
    try {
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: timeoutMs }),
            // Direct DOM element click bypasses visual overlays (e.g. open navbar/dropdown popups)
            btn.evaluate(el => el.click()).catch(() => btn.click({ noWaitAfter: true, timeout: 5000, force: true }))
        ]);
        await download.saveAs(targetPath);
        const tempPath = await download.path().catch(() => null);
        if (tempPath && fs.existsSync(tempPath) && tempPath !== targetPath) { try { fs.rmSync(tempPath, { force: true }); } catch (e) {} }
        return 'downloaded';
    } catch (e) {
        const newFile = await waitForNewCompletedFile(chrome.DOWNLOAD_DIR, before, /\.pdf$/i, timeoutMs);
        if (newFile) {
            try { moveFile(path.join(chrome.DOWNLOAD_DIR, newFile), targetPath); }
            catch (re) { /* keep it where Chrome put it if the move fails; still downloaded */ }
            return 'downloaded';
        }
        return 'not-ready';
    }
}

/** Coretax's native "Ekspor ke Excel" toolbar button - confirmed from the user's live
 *  screenshot: the green document icon in the icon cluster above the table (refresh / grey
 *  doc / GREEN doc / red doc / clear-filter), with a literal "Ekspor ke Excel" tooltip on
 *  hover. PrimeNG's excel icon class is `.pi-file-excel`; tooltip/aria fallbacks cover a
 *  build that renders the label differently. */
function getExcelToolbarButton(page) {
    return page.locator(
        'button:has(.pi-file-excel), ' +
        'button[aria-label*="Ekspor ke Excel" i], ' +
        'button[title*="Ekspor ke Excel" i], ' +
        'button[aria-label*="Excel" i], ' +
        'button[title*="Excel" i]'
    ).first();
}

/** Exports the CURRENTLY DISPLAYED page to a temp .xlsx, parses it, and returns its rows.
 *  Timeout SCALES with `pageSize` - CONFIRMED LIVE (BAI/BP21 Juni 2026, real Coretax) that a
 *  flat ~4s+3s ceiling made the export fail near-consistently at page size 100 while the exact
 *  same button succeeded reliably at 25/50: generating a bigger export server-side genuinely
 *  takes longer, so a fixed "fast" timeout was punishing large pages specifically, which then
 *  silently starved the Ringkasan/cross-check of that page's rows (see the caller's handling of
 *  an empty return). Scaling costs nothing on the happy path - Promise.all resolves the moment
 *  the download event fires, a bigger ceiling only matters when the site is genuinely slower. */
async function exportPageToExcel(page, tempDir, emit, pageSize) {
    const btn = getExcelToolbarButton(page);
    const visible = await btn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    if (!visible) return [];
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.xlsx');
    const before = snapshotDir(chrome.DOWNLOAD_DIR);
    chrome.downloadFlag.automated = true;
    const n = Number(pageSize) || 50;
    const eventTimeoutMs = Math.min(20000, 4000 + n * 150); // 25->7.75s, 50->11.5s, 100->19s
    const fallbackPollMs = Math.min(15000, 3000 + n * 100); // 25->5.5s, 50->8s, 100->13s
    try {
        try {
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: eventTimeoutMs }),
                btn.evaluate(el => el.click()).catch(() => btn.click({ noWaitAfter: true, timeout: 3000, force: true }))
            ]);
            await download.saveAs(tempPath);
        } catch (evErr) {
            const newFile = await waitForNewCompletedFile(chrome.DOWNLOAD_DIR, before, /\.xlsx?$/i, fallbackPollMs);
            if (!newFile) throw evErr;
            moveFile(path.join(chrome.DOWNLOAD_DIR, newFile), tempPath);
        }
        return await excel.readWorkbookRows(tempPath);
    } catch (e) {
        return [];
    } finally {
        chrome.downloadFlag.automated = false;
        try { fs.rmSync(tempPath, { force: true }); } catch (e) {}
    }
}

/** Combines every page's exported Excel rows for one filter combination into a single,
 *  de-duplicated, client-ready summary - with a "Status Download PDF" column cross-checking
 *  each row's reference number against what was actually downloaded, per the user's own
 *  request ("cek dengan pdf yg didownload sudah cocok blm"). Written into the same folder as
 *  that combination's PDFs. Non-fatal if there's nothing to combine (e.g. the Excel button
 *  was never found) - the PDF download itself already succeeded or failed independently. */
async function finalizeCombinedExcel(excelRows, downloadedRefs, saveDir, bupotLabel, periodLabelForFile, emit, crossCheckPdf) {
    if (!excelRows.length) { emit('Tidak ada data Excel untuk digabungkan (mungkin tidak ada data, atau export gagal).'); return { total: 0, belum: 0 }; }
    const refKey = Object.keys(excelRows[0]).find((k) => k.toLowerCase().indexOf('nomor pemotongan') !== -1) || null;
    const seen = new Set();
    const deduped = [];
    for (const row of excelRows) {
        const ref = refKey ? String(row[refKey] ?? '').trim() : null;
        if (ref) { if (seen.has(ref)) continue; seen.add(ref); }
        // Only add the PDF cross-check column when PDFs were actually being downloaded -
        // in Excel-only mode (BPMP) it would be meaningless (everything would read "Belum").
        deduped.push(crossCheckPdf
            ? Object.assign({}, row, { 'Status Download PDF': ref ? (downloadedRefs.has(ref) ? 'Sudah' : 'Belum') : 'Tidak diketahui' })
            : Object.assign({}, row));
    }
    const columns = Object.keys(deduped[0]);
    const outPath = path.join(saveDir, 'Ringkasan ' + bupotLabel + ' ' + sanitizeFilenamePart(periodLabelForFile) + '.xlsx');
    await excel.writeCombinedWorkbook(deduped, columns, outPath);
    if (!crossCheckPdf) { emit('Ringkasan Excel: ' + deduped.length + ' baris tersimpan.'); return { total: deduped.length, belum: 0 }; }
    const belum = deduped.filter((r) => r['Status Download PDF'] === 'Belum').length;
    emit('Ringkasan Excel: ' + deduped.length + ' baris (' + (deduped.length - belum) + ' sudah terunduh PDF-nya' + (belum ? ', ' + belum + ' BELUM - lihat kolom "Status Download PDF"' : ', semua cocok') + ').');
    return { total: deduped.length, belum };
}

const ROW_TIMEOUTS_MS = [5000, 10000]; // fast 5s attempt on Pass 1; gap-filling pass re-walks for any missed rows

/** Runs the paginate-and-download loop for ONE already-filtered result set (one masa/kode -
 *  or one BPA1 range - combination), with logout-mid-run recovery. `downloadedRefs` is a
 *  Set the caller keeps across the whole entity+bupot run so a re-login-triggered restart of
 *  this same combination never re-downloads or drops a row. */
// Page-size ladder for adaptive/override stepping.
const SIZE_STEPS = [10, 25, 50, 100];
function stepSize(current, dir) {
    const i = SIZE_STEPS.indexOf(current);
    if (i === -1) return current;
    const j = Math.min(SIZE_STEPS.length - 1, Math.max(0, i + dir));
    return SIZE_STEPS[j];
}
const SLOW_PAGE_MS = 40000; // a page cycle slower than this => step down (adaptive)
const FAST_PAGE_MS = 14000; // two consecutive pages faster than this => step up (adaptive)

async function downloadCurrentResultSet(ctx) {
    const { page, saveDir, mmYYForFilename, downloadedRefs, reapplyFilters, excelRows, sizeState, log: emit } = ctx;
    const pdfEnabled = ctx.pdfEnabled !== false; // default true; false = Excel-only (e.g. BPMP)
    // Dismiss any open top navbar menu overlays (e.g. open eBUPOT dropdown menu) so they don't cover table controls
    await page.keyboard.press('Escape').catch(() => {});
    let pageNum = 1;
    let downloadedCount = 0;
    let anyExportFailed = false;
    let consecutiveFast = 0;
    let consecutiveSlow = 0;
    if (sizeState) runcontrol.reportPageSize(sizeState.current);
    outer: for (;;) {
        await runcontrol.checkpoint();
        // Live manual page-size override (user forces a size mid-run from the GUI). Applied at
        // the page boundary: setting the paginator resets Coretax to page 1, so we re-walk from
        // there - safe & cheap because already-downloaded slips are skipped by file existence.
        if (sizeState) {
            const ov = runcontrol.takePageSizeOverride();
            if (ov && SIZE_STEPS.includes(Number(ov)) && Number(ov) !== sizeState.current) {
                sizeState.current = Number(ov); sizeState.adaptive = false; // manual override turns off auto
                emit('Baris per halaman diubah manual ke ' + sizeState.current + ' - menerapkan...');
                await setPageSize(page, sizeState.current);
                await waitForTableSettled(page, 15000);
                runcontrol.reportPageSize(sizeState.current);
                pageNum = 1; consecutiveFast = 0; consecutiveSlow = 0;
            }
        }
        if (chrome.isLoggedOut(page)) {
            emit('Sesi Coretax berakhir di tengah proses (auto-logout) - login ulang dan melanjutkan...');
            await reapplyFilters();
            pageNum = 1; // Coretax always lands back on page 1 after a fresh filter apply
            continue;
        }
        const pageStart = Date.now();
        const headerMap = pdfEnabled ? await getHeaderIndexMap(page) : {};
        const rows = getDataRows(page);
        const count = await rows.count();
        // Empty result set: Coretax renders a single "Tidak ada data yang ditemukan" row.
        // Detect it up front instead of burning ~90s of download retries on a fake row.
        if (count === 0) { emit('Tidak ada data untuk filter ini.'); break; }
        if (count === 1) {
            const rowText = (await rows.first().innerText().catch(() => '')).toLowerCase();
            if (rowText.indexOf('tidak ada data') !== -1) { emit('Tidak ada data untuk filter ini.'); break; }
        }
        emit('Halaman ' + pageNum + ': ' + count + ' baris.');
        // Excel-only mode (BPMP, or user's choice): no per-slip PDF exists / is wanted - skip
        // straight to the page's Excel export below, no row loop at all.
        for (let i = 0; pdfEnabled && i < count; i++) {
            await runcontrol.checkpoint(); // pause/skip/stop takes effect between rows, never mid-download
            const row = rows.nth(i);
            const fields = await extractRowFields(row, headerMap);
            if (fields.ref && downloadedRefs.has(fields.ref)) { continue; } // already got this one
            const filename = buildTargetFilename(mmYYForFilename, fields.kodeObjek, fields.ref, fields.nik, fields.nama);
            const targetPath = path.join(saveDir, filename);
            // Completeness/idempotency primitive: the filename carries the unique Nomor
            // Pemotongan, so an existing file IS proof this slip is already downloaded. Skip it.
            // This is what makes Retry/Back/resume safe and cheap - they re-walk the pages but
            // only ever download the genuine gaps, never re-fetch what's already on disk.
            if (fs.existsSync(targetPath)) {
                if (fields.ref) downloadedRefs.add(fields.ref);
                continue;
            }
            // Suppress the context-level manual-download listener (lib/chrome.js) for this
            // WHOLE row, across every retry attempt - not per-attempt. A very slow Coretax can
            // make attempt 1's click actually land AFTER attempt 1's own timeout already gave up
            // (result='not-ready') and attempt 2 already started; if the flag had been reset in
            // between (as it used to be, inside downloadRow itself), that late-arriving download
            // event slips through with the flag off and gets ALSO saved by the manual listener
            // under Coretax's own filename - a real, slow-Coretax-triggered duplicate-file bug.
            // The trailing grace period after the last attempt catches the same race for the
            // FINAL attempt's own late arrival.
            let result = 'not-ready';
            chrome.downloadFlag.automated = true;
            try {
                for (let attempt = 0; attempt < ROW_TIMEOUTS_MS.length && result === 'not-ready'; attempt++) {
                    await runcontrol.checkpoint(); // stay responsive during a slow multi-retry row
                    result = await downloadRow(page, row, targetPath, ROW_TIMEOUTS_MS[attempt]);
                }
            } finally {
                if (result === 'not-ready') await _sleep(1500); // grace window for a late straggler from the last attempt
                chrome.downloadFlag.automated = false;
            }
            if (result === 'downloaded') {
                downloadedCount++;
                if (fields.ref) downloadedRefs.add(fields.ref);
                emit('Terunduh (' + (i + 1) + '/' + count + ' hal.' + pageNum + '): ' + filename);
            } else if (result === 'not-found') {
                emit('Baris ke-' + (i + 1) + ': tombol download tidak ditemukan - dilewati.');
            } else {
                // A row failing all retries is ALSO how a mid-page session timeout manifests -
                // check for it here so recovery starts now, not 40+ slow rows later.
                if (chrome.isLoggedOut(page)) continue outer;
                emit('Baris ke-' + (i + 1) + ' (' + filename + '): gagal terunduh setelah beberapa percobaan - dilewati, bisa diulang manual.');
            }
        }
        let exportOk = true;
        if (excelRows) {
            const pageRows = await exportPageToExcel(page, saveDir, emit, sizeState ? sizeState.current : count);
            exportOk = pageRows.length > 0;
            if (pageRows.length) { excelRows.push(...pageRows); emit('Export Excel halaman ' + pageNum + ': ' + pageRows.length + ' baris ditambahkan ke ringkasan.'); }
            // CONFIRMED LIVE (BAI/BP21 Juni 2026): a slow Coretax can make this page's export
            // silently return 0 rows while the page itself has real data - previously that just
            // fell through with no log line at all, so this page's rows quietly never made it
            // into the combined Ringkasan/cross-check, yet the run could still end reporting
            // "semua cocok" (because the missing rows were never compared against anything -
            // absence of evidence read as absence of a gap). Loud warning instead: the PDFs
            // already on disk for this page are still fine, but this page's rows are NOT
            // reflected in this pass's Ringkasan/completeness verdict.
            else { anyExportFailed = true; emit('⚠ Export Excel halaman ' + pageNum + ' GAGAL - baris di halaman ini belum masuk ringkasan/cross-check kali ini (PDF yang sudah terunduh tetap aman; ulangi kombinasi ini untuk mencakupnya).'); }
        }
        // Adaptive page size (Auto mode): back off when a page cycle is CONSISTENTLY slow or
        // its export keeps failing; step up when it's consistently fast. Both directions now
        // require 2 consecutive signals (previously step-down fired on a single slow/failed
        // page while step-up needed 2 - that asymmetry, confirmed live against a real 196-row
        // BP21 listing, made the size ping-pong 100->50->100->50 over and over, each change
        // forcing a full, expensive re-walk from page 1 - which IS the "next halaman kerasa
        // lama" feeling: not any one click being slow, but the auto-sizer itself thrashing).
        // Any change that does go through re-applies the size and re-walks from page 1 (cheap:
        // already-downloaded slips are skipped).
        if (sizeState && sizeState.adaptive) {
            const elapsed = Date.now() - pageStart;
            let newSize = sizeState.current;
            if ((elapsed > SLOW_PAGE_MS || !exportOk) && sizeState.current > SIZE_STEPS[0]) {
                consecutiveFast = 0;
                consecutiveSlow++;
                if (consecutiveSlow >= 2) {
                    newSize = stepSize(sizeState.current, -1); consecutiveSlow = 0;
                    emit('Web terasa lambat (' + Math.round(elapsed / 1000) + 's/halaman) - turunkan baris per halaman ke ' + newSize + '.');
                }
            } else if (elapsed < FAST_PAGE_MS && exportOk && sizeState.current < SIZE_STEPS[SIZE_STEPS.length - 1]) {
                consecutiveSlow = 0;
                consecutiveFast++;
                if (consecutiveFast >= 2) { newSize = stepSize(sizeState.current, +1); consecutiveFast = 0; emit('Web terasa cepat - naikkan baris per halaman ke ' + newSize + '.'); }
            } else {
                consecutiveFast = 0; consecutiveSlow = 0;
            }
            if (newSize !== sizeState.current) {
                sizeState.current = newSize;
                await setPageSize(page, newSize);
                await waitForTableSettled(page, 15000);
                runcontrol.reportPageSize(newSize);
                pageNum = 1;
                continue; // re-walk from page 1 at the new size
            }
        }
        const nextDisabled = await isNextPageDisabled(page);
        if (nextDisabled) break;
        await goToNextPage(page);
        pageNum++;
    }
    return { downloadedCount, anyExportFailed };
}

/** Top-level entry point. `opts`:
 *   client, orgId, currentUserId, entity ({entity_id, entity_name, npwp, individual}),
 *   picId, bupotType ('bppu'|'bp21'|'bpa1'), masaInput (string), kodeInput (string),
 *   saveRoot (string, base folder - defaults to Downloads/CoretaxAgent) */
async function runEbupotDownload(opts) {
    const { client, orgId, entity, picId, bupotType } = opts;
    if (!BUPOT_URLS[bupotType]) throw new Error('Jenis bupot tidak dikenal: ' + bupotType);
    const bupotLabel = BUPOT_LABELS[bupotType];
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');

    // Output mode: 'excel_only' skips per-slip PDF downloads entirely (only the combined Excel
    // summary is produced). Forced on for BPMP, which has no per-slip PDF at all.
    const pdfEnabled = !!BUPOT_PDF_CAPABLE[bupotType] && opts.outputMode !== 'excel_only';
    // Manual mode: the user already logged into Coretax (and possibly already picked the entity)
    // in the manual window - we run the download loop on THAT session, skipping the whole
    // credential fetch / PIC login / impersonate sequence.
    const manual = !!opts.manualPage;
    log('Memulai ' + (pdfEnabled ? 'download PDF + Excel' : 'download Excel saja') + ' e-Bupot ' + bupotLabel
        + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');
    let cred = null, page, context;
    if (manual) {
        page = opts.manualPage;
        if (chrome.isLoggedOut(page)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
    } else {
        cred = await entitiesLib.getCredential(client, orgId, picId);
        ({ context, page } = await chrome.launchOrReuseContext(picId, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
        }));
    }

    // Login + impersonate, verified and retried: a slow Coretax often "succeeds" at the click
    // level but doesn't actually finish switching the active entity - proceeding then would
    // silently pull the WRONG entity's data (or none). switchToEntity confirms via the SPA's
    // own session state (code-level, not visual), and we retry the whole login+switch if it
    // can't confirm, rather than pressing on. Individual entities have nothing to impersonate,
    // so login alone is enough for them. Shared with the standalone Login action (lib/chrome.js
    // loginAndImpersonate) so both paths use the exact same, single-sourced retry logic.
    async function loginAndImpersonate() {
        // Manual mode: the user handled login + entity selection themselves. Just confirm the
        // session is still alive; if it timed out we can't re-login for them (no credentials).
        if (manual) {
            if (chrome.isLoggedOut(page)) throw new Error('Sesi manual berakhir - silakan login ulang di jendela Coretax lalu klik 🔁 Ulang.');
            return;
        }
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint });
    }
    await loginAndImpersonate();

    // Report who we're actually logged into Coretax as (NPWP + name) for the GUI's "Login as"
    // bar. For automation that's the impersonated entity; for manual it's read live from the
    // window's account pill. This is the Coretax account, NOT the Taxio/gmail login.
    try {
        let coretaxAs;
        if (manual) coretaxAs = await chrome.getManualStatus().then((s) => s.identity).catch(() => '');
        else coretaxAs = (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
        runcontrol.setCoretaxAs(coretaxAs || entity.entity_name);
    } catch (e) {}

    // Page size: 'auto' = adaptive (starts at 25 - a middle ground that's cheap to size back
    // down from OR up from on the very first page cycle - backs off to 10 when the site is
    // slow, steps up toward 50/100 when fast; see downloadCurrentResultSet). A fixed number =
    // that size, no auto-adjust (but the user can still override live from the GUI). Shared
    // mutable object so the adaptive/override logic and openBupotAndPrep always agree on the
    // current size.
    const sizeState = String(opts.pageSize) === 'auto'
        ? { current: 25, adaptive: true }
        : { current: SIZE_STEPS.includes(Number(opts.pageSize)) ? Number(opts.pageSize) : 25, adaptive: false };
    async function openBupotAndPrep() {
        const NAV_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
            await runcontrol.checkpoint();
            try {
                await page.goto(BUPOT_URLS[bupotType], { waitUntil: 'domcontentloaded', timeout: 45000 });
                // Inject style to disable hover dropdown popups on the top navigation bar so mouse movements never trigger them
                await page.addStyleTag({
                    content: `
                        .p-menubar .p-submenu-list, .p-tieredmenu, .p-menuoverlay {
                            display: none !important;
                            visibility: hidden !important;
                            pointer-events: none !important;
                        }
                    `
                }).catch(() => {});
                if (chrome.isLoggedOut(page)) {
                    log('Halaman ' + bupotLabel + ' memantulkan ke login - login ulang lalu buka lagi...');
                    await chrome.ensureLoggedIn(page, cred);
                    await chrome.switchToEntity(page, cred, {
                        npwp: entity.npwp, name: entity.entity_name, individual: entity.individual,
                        entityCode: entity.entity_id, userDataDir: path.join(chrome.PROFILE_ROOT, picId)
                    });
                    continue;
                }
                await waitForTableSettled(page, 20000);
                // Confirm the datatable actually rendered - a blank/errored page has no table
                // at all. If it's missing, that's a failed load worth retrying, not a real
                // "no data" (which DOES render a table, with a "Tidak ada data" row).
                const tableThere = await page.locator('table.p-datatable-table, .p-datatable-tbody, .p-paginator').first()
                    .isVisible({ timeout: 8000 }).catch(() => false);
                if (!tableThere) throw new Error('Tabel eBupot tidak muncul (halaman mungkin gagal dimuat).');
                await sortByNomorPemotongan(page);
                await setPageSize(page, sizeState.current);
                runcontrol.reportPageSize(sizeState.current);
                return; // loaded successfully
            } catch (e) {
                if (attempt === NAV_ATTEMPTS) throw new Error('Gagal membuka halaman ' + bupotLabel + ' setelah ' + NAV_ATTEMPTS + ' percobaan: ' + e.message);
                const waitMs = 3000 * attempt; // 3s, 6s, 9s backoff
                log('Gagal membuka halaman ' + bupotLabel + ' (percobaan ' + attempt + '/' + NAV_ATTEMPTS + '): ' + e.message + ' - coba lagi dalam ' + (waitMs / 1000) + ' detik...');
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
    }
    async function reLoginAndReopen() {
        // Manual mode can't auto-recover a timed-out session (no stored creds) - just re-open
        // the page; loginAndImpersonate() throws a clear "login ulang" message if still logged out.
        await loginAndImpersonate();
        await openBupotAndPrep();
    }

    await openBupotAndPrep();

    // Overall run stats, reported at the end (log + Windows popup) so the user gets a
    // positive "it finished, and here's whether everything matched" signal instead of having
    // to infer completion from the log going quiet.
    const stats = { downloaded: 0, excelTotal: 0, excelBelum: 0, combosDone: 0, combosSkipped: 0 };
    let stopped = false;

    // Build the full ordered list of filter combinations up front, so the run loop below can
    // navigate it by index - that's what makes the Retry (redo current) and Back (previous)
    // controls possible. Each combo carries: fileMasa (clean MMYY / MMYY-MMYY, the first part
    // of every PDF filename) kept SEPARATE from ringkasanLabel (which may carry a "kode-..."
    // suffix so two kode combos' Ringkasan files don't overwrite each other) - conflating the
    // two once put "0126 kode-21-100-35" into PDF filenames.
    // BPA1 is now structurally identical to BP21/BPPU here - one masa value per combo, applied
    // one month at a time (see setBpa1RangeFilter's header comment for why a real start/end
    // RANGE filter was dropped: only "Masa Akhir Periode Penghasilan" should ever be touched).
    const combos = [];
    const masaList = parseMasaListInput(opts.masaInput);
    const kodeList = HAS_KODE_OBJEK_FILTER[bupotType] ? parseKodeObjekInput(opts.kodeInput) : [];
    const kodeCombos = kodeList.length ? kodeList : [null]; // null = no filter = "default all"
    for (const mmYY of masaList) {
        for (const kode of kodeCombos) {
            combos.push({
                comboLabel: masaToIndoLabel(mmYY) + (kode ? (' / kode ' + kode) : ' / semua kode'),
                fileMasa: mmYY, ringkasanLabel: mmYY + (kode ? (' kode-' + kode) : ''), saveSubdir: mmYY,
                applyFilters: async () => {
                    if (BUPOT_USES_RANGE_FILTER[bupotType]) await setBpa1RangeFilter(page, mmYY);
                    else await setMasaPajakFilter(page, mmYY);
                    if (HAS_KODE_OBJEK_FILTER[bupotType]) await setKodeObjekFilter(page, kode || '');
                    await waitForTableSettled(page, 15000);
                }
            });
        }
    }

    // Runs one combo. Returns 'next' (advance) | 'retry' (redo this one) | 'back' (previous).
    // Because every already-downloaded slip is skipped by file-existence, retry/back only fill
    // gaps - so overriding an error by re-running a combo never re-downloads or misses rows.
    async function runCombo(combo) {
        const { comboLabel, fileMasa, ringkasanLabel, saveSubdir, applyFilters } = combo;
        log('Filter: ' + comboLabel + ' (' + (combos.indexOf(combo) + 1) + '/' + combos.length + ')');
        const emit = (m) => log('[' + bupotLabel + ' ' + comboLabel + '] ' + m);
        async function prepFilteredTable() {
            await sortByNomorPemotongan(page);
            if (sizeState && sizeState.current) {
                await setPageSize(page, sizeState.current);
                runcontrol.reportPageSize(sizeState.current);
            }
            await waitForTableSettled(page, 15000);
        }

        try {
            await applyFilters();
            await prepFilteredTable();
            const saveDir = path.join(saveRoot, entity.entity_id, bupotLabel, saveSubdir);
            const downloadedRefs = new Set();
            let gotCount = 0;
            let summary = { total: 0, belum: 0 };
            // Auto gap-fill: walk the pages, cross-check against the Excel export, and if any
            // rows are still "Belum" (in Excel but no PDF on disk), automatically re-walk to
            // grab just those - re-walking is cheap because every already-downloaded file is
            // skipped by existence. Repeat until nothing's missing or a pass stops making
            // progress (avoids looping forever on a genuinely un-downloadable row). This is the
            // "download -> compare with Excel -> re-download whatever was missed" loop.
            // Excel-only mode has nothing to gap-fill against (no PDFs), so a single pass.
            const MAX_PASSES = pdfEnabled ? 3 : 1;
            for (let pass = 1; pass <= MAX_PASSES; pass++) {
                const excelRows = [];
                const result = await downloadCurrentResultSet({
                    page, saveDir, mmYYForFilename: fileMasa,
                    downloadedRefs, excelRows, pdfEnabled, sizeState,
                    reapplyFilters: async () => { await reLoginAndReopen(); await applyFilters(); await prepFilteredTable(); },
                    log: emit
                });
                gotCount += result.downloadedCount;
                summary = await finalizeCombinedExcel(excelRows, downloadedRefs, saveDir, bupotLabel, ringkasanLabel, emit, pdfEnabled);
                // A page whose Excel export failed never made it into `excelRows` at all, so
                // `summary.belum` (computed only from rows that WERE exported) can read 0 -
                // falsely "COCOK" - even though a whole page's worth of rows were never actually
                // checked (confirmed live: BAI/BP21 Juni 2026 under a slow Coretax). Treat a
                // failed export exactly like a "belum" gap: worth an automatic retry pass, since
                // re-walking re-attempts that page's export too.
                if ((summary.belum === 0 && !result.anyExportFailed) || summary.total === 0) break;
                if (pass < MAX_PASSES) {
                    const why = summary.belum > 0
                        ? ('Masih ada ' + summary.belum + ' baris belum ter-download')
                        : 'Sebagian halaman gagal ter-export ke Excel (belum tercek lengkap)';
                    emit(why + ' - mengulang otomatis untuk mengisi yang kelewat (percobaan ' + (pass + 1) + '/' + MAX_PASSES + ')...');
                    await applyFilters();
                    await prepFilteredTable();
                }
            }
            stats.downloaded += gotCount;
            stats.excelTotal += summary.total;
            stats.excelBelum += summary.belum;
            stats.combosDone++;
            return 'next';
        } catch (e) {
            if (e && e.isRetry) { emit('Diulang dari awal atas permintaan pengguna.'); return 'retry'; }
            if (e && e.isBack) { emit('Mundur ke kombinasi sebelumnya atas permintaan pengguna.'); return 'back'; }
            if (e && e.isSkip) { emit('Dilewati atas permintaan pengguna.'); stats.combosSkipped++; return 'next'; }
            if (e && e.isStop) { stopped = true; throw e; }
            // Browser window closed by the user = nothing further can possibly succeed.
            if (typeof page.isClosed === 'function' && page.isClosed()) {
                emit('Jendela browser ditutup - proses dihentikan.');
                stopped = true;
                throw Object.assign(new Error('Jendela browser ditutup.'), { isStop: true });
            }
            // A combo failed (impersonate not confirmed, page didn't load, filter control not
            // found, ...). Instead of silently skipping, HOLD the run and hand control back to
            // the user: they can 🔁 Ulang (agent re-does login+impersonate+filter from scratch),
            // ⏭ Lewati, ⏮ Mundur, or manually fix the browser then ▶ Lanjut. checkpoint() below
            // blocks here until one of those is chosen.
            const curIdx = combos.indexOf(combo);
            const nextCombo = combos[curIdx + 1];
            const prevCombo = combos[curIdx - 1];
            emit('Kombinasi ini GAGAL: ' + e.message);
            emit('Posisi: ' + (curIdx + 1) + '/' + combos.length + ' (' + comboLabel + '). '
                + '⏭ Lewati => ' + (nextCombo ? ('lanjut ke "' + nextCombo.comboLabel + '"') : 'tidak ada lagi, proses selesai') + '. '
                + '⏮ Mundur => ' + (prevCombo ? ('kembali ke "' + prevCombo.comboLabel + '"') : 'sudah di kombinasi pertama') + '. '
                + '🔁 Ulang => coba lagi "' + comboLabel + '" dari awal.');
            runcontrol.pauseForDecision(e.message);
            try {
                await runcontrol.checkpoint(); // blocks while paused; throws on retry/back/skip/stop
            } catch (ctl) {
                if (ctl && ctl.isRetry) { emit('Diulang atas permintaan pengguna.'); return 'retry'; }
                if (ctl && ctl.isBack) { emit('Mundur atas permintaan pengguna.'); return 'back'; }
                if (ctl && ctl.isSkip) { emit('Dilewati atas permintaan pengguna.'); stats.combosSkipped++; return 'next'; }
                if (ctl && ctl.isStop) { stopped = true; throw ctl; }
            }
            // Fell through = the user hit ▶ Lanjut after fixing things manually. Re-run this
            // same combo; file-exists-skip means already-downloaded slips are left alone, so a
            // manual fix + continue safely picks up only what's missing.
            emit('Dilanjutkan setelah jeda - mengulang kombinasi ini (file yang sudah ada dilewati).');
            return 'retry';
        }
    }

    try {
        let i = 0;
        while (i < combos.length) {
            const action = await runCombo(combos[i]);
            if (action === 'retry') continue;            // redo combos[i]
            else if (action === 'back') i = Math.max(0, i - 1);
            else i++;                                     // 'next'
        }
    } catch (e) {
        if (!(e && e.isStop)) throw e;
    }

    let verdict;
    if (!pdfEnabled) {
        verdict = stats.excelTotal ? ('Ringkasan Excel: ' + stats.excelTotal + ' baris.') : 'Tidak ada data / export Excel gagal.';
    } else if (stats.excelTotal) {
        verdict = stats.excelBelum === 0
            ? 'Semua ' + stats.excelTotal + ' baris di ringkasan Excel sudah ada PDF-nya - COCOK.'
            : stats.excelBelum + ' dari ' + stats.excelTotal + ' baris di ringkasan Excel BELUM ada PDF-nya - cek kolom "Status Download PDF" di file Ringkasan.';
    } else {
        verdict = 'Cross-check Excel tidak tersedia (export gagal/tidak ditemukan).';
    }
    const doneMsg = (stopped ? 'DIHENTIKAN' : 'SELESAI') + ': e-Bupot ' + bupotLabel + ' "' + entity.entity_name + '" - '
        + (pdfEnabled ? (stats.downloaded + ' PDF terunduh, ') : '') + stats.combosDone + ' kombinasi selesai'
        + (stats.combosSkipped ? (', ' + stats.combosSkipped + ' dilewati/gagal') : '') + '. ' + verdict;
    log(doneMsg + ' Jendela dibiarkan terbuka.');
    showPopup(doneMsg, 'Coretax Agent', stopped || stats.excelBelum ? 'Warning' : 'Information');
}

module.exports = { runEbupotDownload, BUPOT_URLS, BUPOT_LABELS, HAS_KODE_OBJEK_FILTER, BUPOT_PDF_CAPABLE };
