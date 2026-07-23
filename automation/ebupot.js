/* Coretax Agent - e-Bupot PDF download automation (automation feature #1).
   Spec: "Coretax Agent/Download PDF EBUPOT otomatis.pdf" (user-provided).

   REWRITTEN from the original click-based version to call Coretax's own listing/PDF APIs
   directly, per live investigation (2026-07-19/20) that found:
     - the "getebupot<type>issued" listing endpoints (bp21/bpu/bpa1/mp) return every field
       needed to build a PDF request - RecordId, WithholdingslipsAggregateIdentifier,
       DocumentFormAggregateIdentifier, TaxIdentificationNumber, LastUpdatedDate - with NO
       need to open a row's detail view first;
     - the `authorization` (Bearer JWT) + `x-dgt-code` headers Angular's own HTTP interceptor
       attaches are stable for the whole session (not per-request/nonce), so headers captured
       from ANY real request the SPA fires (even the listing call itself) can be reused,
       unmodified, for every subsequent listing page AND every row's PDF fetch - CONFIRMED
       LIVE by fetching a PDF for a row that was never clicked or opened, using only headers
       taken from the page's own listing request;
     - the JWT payload itself carries a `taxpayer_id` claim equal to the
       `TaxpayerAggregateIdentifier` every request body needs, so the impersonated entity's ID
       never needs a separate lookup - just decode the captured token;
     - `TotalRecords` in the listing response is unreliable (confirmed to echo back whatever
       `Rows` was requested rather than a true count) - never trust it; the correct
       stop-condition is `Data.length < Rows requested`;
     - the four bupot types share an identical request/response shape, differing only in
       endpoint name, EbupotType code, and (BPA1 only) the period filter's property name
       (`IncomePeriodCodeEnd` instead of `TaxPeriodCode`) - see LISTING_ENDPOINT /
       EBUPOT_TYPE_CODE / PERIOD_FILTER_PROPERTY below, each individually verified live.
   This eliminates the previous version's entire reliability surface: per-row download-event
   racing, Coretax's "Ekspor ke Excel" button silently returning 0 rows under load, and UI
   pagination - replaced by direct fetch() calls issued from inside the already-authenticated
   page (via page.evaluate, so real browser cookies/session are used automatically). The
   browser window only needs to be parked on ANY working e-Bupot page (BP21's, always used
   regardless of which type the user picked) long enough to observe one authenticated request
   and capture its headers - every subsequent call for every type reuses them.

   Retry/pause/skip/back/stop control flow, filename convention (buildTargetFilename), and the
   overall combo-by-combo (masa x kode) run structure are carried over unchanged from the
   click-based version so the GUI's run-control panel keeps working identically. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const loginStatus = require('../lib/login-status');
const entitiesLib = require('../lib/entities');
const { masaToIndoLabel, parseMasaListInput, parseKodeObjekInput } = require('../lib/masa');
const excel = require('../lib/excel');
const runcontrol = require('../lib/runcontrol');
const { _sleep, sanitizeFilenamePart } = require('../lib/datatable');

// Every type's listing/PDF calls are fired from THIS one page - BP21 issued is the only route
// confirmed to load directly by URL (BPPU's equivalent direct-URL guess 404's; the real BPPU/
// BPA1/BPMP pages are only reachable via in-app sidebar navigation). Since the auth token and
// x-dgt-code are session-wide, not page-specific (confirmed live: a header captured on this
// page successfully fetched BPPU/BPA1/BPMP data), there's no need to actually navigate to each
// type's own page at all - this URL is just the anchor used to get a real authenticated
// request captured.
const BOOTSTRAP_URL = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbp21/issued';
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

// Listing endpoint (under /withholdingslipsportal/api/), the period filter's PropertyName, and
// the EbupotType code the PDF endpoint expects - each confirmed live per type on 2026-07-19/20.
const LISTING_ENDPOINT = { bp21: 'getebupotbp21issued', bppu: 'getebupotbpuissued', bpa1: 'getebupotbpa1issued', bpmp: 'getebupotmpissued' };
const PERIOD_FILTER_PROPERTY = { bp21: 'TaxPeriodCode', bppu: 'TaxPeriodCode', bpmp: 'TaxPeriodCode', bpa1: 'IncomePeriodCodeEnd' };
const EBUPOT_TYPE_CODE = { bp21: 'EBUPOTBP21', bppu: 'EBUPOTBPU', bpa1: 'EBUPOTBPA1' }; // bpmp: pdf n/a
const API_BASE = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';

/** "0326" -> "03032026" - the MM+MM+YYYY period-code format Coretax's own filters use,
 *  confirmed live against both TaxPeriodCode and BPA1's IncomePeriodCodeEnd. */
function mmYYToTaxPeriodCode(mmYY) {
    const mm = mmYY.slice(0, 2);
    return mm + mm + '20' + mmYY.slice(2);
}

/** Pulls the `taxpayer_id` claim out of a captured Bearer JWT - this is exactly the
 *  TaxpayerAggregateIdentifier every listing/PDF request body needs, so the impersonated
 *  entity's internal ID never needs its own lookup call. */
function decodeJwtTaxpayerId(bearerToken) {
    try {
        const token = String(bearerToken || '').replace(/^Bearer\s+/i, '');
        const payloadB64 = token.split('.')[1];
        const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json).taxpayer_id || null;
    } catch (e) { return null; }
}

/** Passively watches every request this page's context fires and keeps the latest
 *  `authorization`/`x-dgt-code` headers (+ the taxpayer id decoded from them) - confirmed live
 *  that these are stable for the whole session, not per-request, so "latest seen" is always
 *  usable. Attach ONCE per page; a re-login naturally refreshes it via openBupotAndPrep's own
 *  re-navigation firing a fresh authenticated request. */
function attachApiAuthCapture(page) {
    const state = { authorization: null, dgtCode: null, taxpayerId: null };
    page.context().on('request', (req) => {
        if (req.url().indexOf('/withholdingslipsportal/api/') === -1) return;
        const h = req.headers();
        if (h.authorization) { state.authorization = h.authorization; state.taxpayerId = decodeJwtTaxpayerId(h.authorization) || state.taxpayerId; }
        if (h['x-dgt-code']) state.dgtCode = h['x-dgt-code'];
    });
    return state;
}
async function waitForAuthCaptured(authState, timeoutMs) {
    const start = Date.now();
    while (!authState.authorization || !authState.taxpayerId) {
        if (Date.now() - start > timeoutMs) return false;
        await _sleep(300);
    }
    return true;
}

/** Fires an authenticated POST from INSIDE the page (so real browser cookies/session apply
 *  automatically) using the captured headers. Returns {status, json}; never throws on a
 *  non-2xx or unparsable body - callers decide what that means.
 *
 *  Built as a literal source STRING (not `page.evaluate(fn, arg)`) on purpose: pkg's packaged
 *  exe strips original function source text, so Playwright's normal fn+arg form - which needs
 *  to `.toString()` the closure to ship it to the browser - throws "Passed function is not
 *  well-serializable!" once compiled, even though the exact same code runs fine under plain
 *  `node` (confirmed live: every dev-test run during development used plain `node` and never
 *  hit this; the packaged .exe did on first real use). A string given to `page.evaluate` needs
 *  no such round-trip, so it's immune to this - same technique already proven live via the
 *  investigation bridge's `frame.evaluate(cmd.expr)` calls. */
async function apiPost(page, authState, url, bodyObj) {
    const expr = '(async () => {'
        + 'try {'
        + '  const r = await fetch(' + JSON.stringify(url) + ', {'
        + '    method: "POST",'
        + '    headers: { "Content-Type": "application/json", "Authorization": ' + JSON.stringify(authState.authorization) + ', "x-dgt-code": ' + JSON.stringify(authState.dgtCode) + ' },'
        + '    credentials: "include",'
        + '    body: ' + JSON.stringify(JSON.stringify(bodyObj))
        + '  });'
        + '  let json = null;'
        + '  try { json = await r.json(); } catch (e) {}'
        + '  return { status: r.status, json };'
        + '} catch (e) {'
        + '  return { status: 0, json: null };'
        + '}'
        + '})()';
    return page.evaluate(expr);
}

/** Filename per the user's exact spec: "MMYY - Kode Objek Pajak - Nomor Pemotongan - NIK -
 *  NAMA.pdf", name capped at 2 words. Nomor Pemotongan in the name is what makes every slip's
 *  filename unique - without it, one person's Normal + Pembetulan slips (same masa/kode/NIK)
 *  collapsed onto one filename and silently overwrote each other. */
function buildTargetFilename(mmYY, kodeObjek, ref, nik, nama) {
    const namaShort = sanitizeFilenamePart(nama).split(/\s+/).slice(0, 2).join(' ');
    const parts = [mmYY, sanitizeFilenamePart(kodeObjek), sanitizeFilenamePart(ref), sanitizeFilenamePart(nik), namaShort].filter(Boolean);
    return parts.join(' - ') + '.pdf';
}

/** Pages through one masa/kode combo's listing until a page comes back shorter than requested
 *  - `TotalRecords` is confirmed unreliable (echoes back the requested `Rows`) so it's never
 *  used as a stop condition. `sizeState` is shared with the caller so a live GUI page-size
 *  override applies starting the very next fetch. Throws with `.isSessionExpired = true` on a
 *  401 so the caller can re-login and resume this same combo. */
async function fetchAllRows(page, authState, bupotType, mmYY, kode, sizeState, emit) {
    const endpoint = LISTING_ENDPOINT[bupotType];
    const periodProp = PERIOD_FILTER_PROPERTY[bupotType];
    const filters = [{ PropertyName: periodProp, Value: mmYYToTaxPeriodCode(mmYY), MatchMode: 'equals', CaseSensitive: true, AsString: false }];
    if (kode && HAS_KODE_OBJEK_FILTER[bupotType]) filters.push({ PropertyName: 'TaxObjectCode', Value: kode, MatchMode: 'contains', CaseSensitive: false, AsString: false });
    const all = [];
    let first = 0;
    for (;;) {
        await runcontrol.checkpoint();
        const override = Number(runcontrol.takePageSizeOverride());
        if (override) { sizeState.current = override; emit('Baris per pengambilan diubah manual ke ' + override + '.'); }
        runcontrol.reportPageSize(sizeState.current);
        const body = { First: first, Rows: sizeState.current, SortField: '', SortOrder: 1, Filters: filters, LanguageId: 'id-ID', TaxpayerAggregateIdentifier: authState.taxpayerId };
        const { status, json } = await apiPost(page, authState, API_BASE + '/' + endpoint, body);
        if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil data.'); e.isSessionExpired = true; throw e; }
        if (status !== 200 || !json || json.IsSuccessful === false) {
            throw new Error('Gagal mengambil data (' + endpoint + '): HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : ''));
        }
        const pageRows = (json.Payload && json.Payload.Data) || [];
        all.push(...pageRows);
        if (pageRows.length) emit('Data diambil: ' + all.length + ' baris' + (pageRows.length === sizeState.current ? ' (lanjut...)' : '.'));
        if (pageRows.length < sizeState.current) break;
        first += sizeState.current;
    }
    return kode && HAS_KODE_OBJEK_FILTER[bupotType] ? all.filter((r) => String(r.TaxObjectCode || '').indexOf(kode) !== -1) : all;
}

/** Fetches one row's PDF bytes directly - every field the body needs comes straight off the
 *  listing row, no per-row detail view needed (confirmed live: works for rows never opened). */
async function fetchPdfForRow(page, authState, bupotType, row) {
    const body = {
        WithholdingSlipsAggregateIdentifier: row.WithholdingslipsAggregateIdentifier,
        WithholdingSlipsRecordIdentifier: row.RecordId,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier,
        TaxpayerAggregateIdentifier: row.TaxpayerAggregateIdentifier,
        EbupotType: EBUPOT_TYPE_CODE[bupotType],
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        TaxIdentificationNumber: row.TaxIdentificationNumber
    };
    const { status, json } = await apiPost(page, authState, API_BASE + '/DownloadWithholdingSlips/download-pdf-document', body);
    if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil PDF.'); e.isSessionExpired = true; throw e; }
    const data = json && json.Payload && json.Payload.Message ? json.Payload.Message.Data : null;
    if (status !== 200 || !json || json.IsSuccessful === false || !data) {
        throw new Error('Gagal mengambil PDF: HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : ''));
    }
    return Buffer.from(data, 'base64');
}

/** Runs one masa/kode combo end-to-end: fetch every row via the listing API, download every
 *  row's PDF (unless Excel-only), skipping anything already on disk (filename-existence is
 *  still the idempotency primitive - safe, cheap resume after Retry/Back/a re-login restart).
 *  A session-expiry mid-fetch bubbles straight up (`.isSessionExpired`) for the caller to
 *  re-login and re-run this same combo - already-downloaded files are skipped on the redo. */
async function downloadComboData(ctx) {
    const { page, authState, bupotType, saveDir, mmYYForFilename, mmYY, kode, downloadedRefs, pdfEnabled, sizeState, emit } = ctx;
    const rows = await fetchAllRows(page, authState, bupotType, mmYY, kode, sizeState, emit);
    if (!rows.length) { emit('Tidak ada data untuk filter ini.'); return { downloadedCount: 0, rows: [] }; }
    emit('Total data: ' + rows.length + ' baris.');
    let downloadedCount = 0;
    if (pdfEnabled) {
        fs.mkdirSync(saveDir, { recursive: true });
        for (let i = 0; i < rows.length; i++) {
            await runcontrol.checkpoint(); // pause/skip/stop takes effect between rows
            const row = rows[i];
            const ref = row.WithholdingSlipsNumber || null;
            if (ref && downloadedRefs.has(ref)) continue;
            const filename = buildTargetFilename(mmYYForFilename, row.TaxObjectCode || '', ref, row.TaxIdentificationNumber, row.Name);
            const targetPath = path.join(saveDir, filename);
            if (fs.existsSync(targetPath)) { if (ref) downloadedRefs.add(ref); continue; }
            let lastErr = null, ok = false;
            for (let attempt = 0; attempt < 2 && !ok; attempt++) {
                try {
                    const pdfBuffer = await fetchPdfForRow(page, authState, bupotType, row);
                    fs.writeFileSync(targetPath, pdfBuffer);
                    ok = true;
                } catch (e) {
                    if (e.isSessionExpired) throw e; // bubble up - caller re-logs in and resumes this combo
                    lastErr = e;
                    await _sleep(800);
                }
            }
            if (ok) {
                downloadedCount++;
                if (ref) downloadedRefs.add(ref);
                emit('Terunduh (' + (i + 1) + '/' + rows.length + '): ' + filename);
            } else {
                emit('Baris ke-' + (i + 1) + ' (' + filename + '): gagal terunduh - ' + (lastErr ? lastErr.message : 'tidak diketahui') + ' - dilewati, bisa diulang manual.');
            }
        }
    }
    return { downloadedCount, rows };
}

/** Builds the combined Ringkasan Excel straight from the listing rows already fetched (the
 *  authoritative dataset itself, not a separate maybe-flaky export) - important fields first,
 *  then every other field the API returned, so this is always a strict superset of what
 *  Coretax's own "Ekspor ke Excel" button produced, never a subset. Adds "Status Download PDF"
 *  the same way the previous version did, per the user's own request ("cek dengan pdf yg
 *  didownload sudah cocok blm"). */
async function writeRingkasanExcel(rows, downloadedRefs, saveDir, bupotLabel, periodLabelForFile, pdfEnabled, emit) {
    if (!rows.length) { emit('Tidak ada data untuk ringkasan Excel.'); return { total: 0, belum: 0 }; }
    const priorityColumns = ['TaxPeriodCode', 'IncomePeriodCodeStart', 'IncomePeriodCodeEnd', 'WithholdingSlipsNumber', 'TaxObjectCode', 'TaxArticle', 'TaxIdentificationNumber', 'Name', 'WithholdingSlipsDate', 'TaxBase', 'TaxRate', 'IncomeTax', 'WithholdingSlipsStatus'];
    const allKeys = Object.keys(rows[0]);
    const ordered = priorityColumns.filter((k) => allKeys.includes(k)).concat(allKeys.filter((k) => priorityColumns.indexOf(k) === -1));
    const columns = pdfEnabled ? ordered.concat(['Status Download PDF']) : ordered;
    const outRows = rows.map((r) => {
        const out = {};
        for (const k of ordered) out[k] = r[k];
        if (pdfEnabled) { const ref = r.WithholdingSlipsNumber; out['Status Download PDF'] = ref ? (downloadedRefs.has(ref) ? 'Sudah' : 'Belum') : 'Tidak diketahui'; }
        return out;
    });
    const outPath = path.join(saveDir, 'Ringkasan ' + bupotLabel + ' ' + sanitizeFilenamePart(periodLabelForFile) + '.xlsx');
    await excel.writeCombinedWorkbook(outRows, columns, outPath);
    if (!pdfEnabled) { emit('Ringkasan Excel: ' + outRows.length + ' baris tersimpan.'); return { total: outRows.length, belum: 0 }; }
    const belum = outRows.filter((r) => r['Status Download PDF'] === 'Belum').length;
    emit('Ringkasan Excel: ' + outRows.length + ' baris (' + (outRows.length - belum) + ' sudah terunduh PDF-nya' + (belum ? ', ' + belum + ' BELUM - lihat kolom "Status Download PDF"' : ', semua cocok') + ').');
    return { total: outRows.length, belum };
}

const SIZE_STEPS = [10, 25, 50, 100, 250, 500];

/** Top-level entry point. `opts`:
 *   client, orgId, currentUserId, entity ({entity_id, entity_name, npwp, individual}),
 *   picId, bupotType ('bppu'|'bp21'|'bpa1'|'bpmp'), masaInput (string), kodeInput (string),
 *   saveRoot (string, base folder - defaults to Downloads/CoretaxAgent) */
async function runEbupotDownload(opts) {
    const { client, orgId, entity, picId, bupotType } = opts;
    if (!BUPOT_URLS[bupotType]) throw new Error('Jenis bupot tidak dikenal: ' + bupotType);
    const bupotLabel = BUPOT_LABELS[bupotType];
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');

    const pdfEnabled = !!BUPOT_PDF_CAPABLE[bupotType] && opts.outputMode !== 'excel_only';
    const manual = !!opts.manualPage;
    log('Memulai ' + (pdfEnabled ? 'download PDF + Excel' : 'download Excel saja') + ' e-Bupot ' + bupotLabel
        + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');
    let cred = null, page, context;
    if (manual) {
        page = opts.manualPage;
        if (chrome.isLoggedOut(page)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
    } else {
        const restricted = !!opts.restricted;
        const passphrase = opts.passphrase || null;
        const allowedEbupotSections = opts.allowedEbupotSections || null;
        cred = await entitiesLib.getCredential(client, orgId, picId);
        ({ context, page } = await chrome.launchOrReuseContext(picId, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); } catch (e) {}
        }, restricted, allowedEbupotSections));
    }
    const authState = attachApiAuthCapture(page);

    async function loginAndImpersonate() {
        if (manual) {
            if (chrome.isLoggedOut(page)) throw new Error('Sesi manual berakhir - silakan login ulang di jendela Coretax lalu klik 🔁 Ulang.');
            return;
        }
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint, restricted, passphrase, allowedEbupotSections: opts.allowedEbupotSections });
    }
    await loginAndImpersonate();

    try {
        let coretaxAs;
        if (manual) coretaxAs = await chrome.getManualStatus().then((s) => s.identity).catch(() => '');
        else coretaxAs = (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
        runcontrol.setCoretaxAs(coretaxAs || entity.entity_name);
        if (!manual) loginStatus.set(picId, entity);
    } catch (e) {}

    // Just anchors the page on a known-working route long enough to observe (and capture) one
    // authenticated request - no table/UI interaction needed at all anymore.
    async function openBupotAndPrep() {
        const NAV_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
            await runcontrol.checkpoint();
            try {
                await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                if (chrome.isLoggedOut(page)) {
                    log('Halaman e-Bupot memantulkan ke login - login ulang lalu buka lagi...');
                    await loginAndImpersonate();
                    continue;
                }
                const captured = await waitForAuthCaptured(authState, 20000);
                if (!captured) throw new Error('Tidak berhasil menangkap sesi API Coretax (authorization header) dari halaman.');
                return;
            } catch (e) {
                if (attempt === NAV_ATTEMPTS) throw new Error('Gagal membuka halaman e-Bupot setelah ' + NAV_ATTEMPTS + ' percobaan: ' + e.message);
                const waitMs = 3000 * attempt;
                log('Gagal membuka halaman e-Bupot (percobaan ' + attempt + '/' + NAV_ATTEMPTS + '): ' + e.message + ' - coba lagi dalam ' + (waitMs / 1000) + ' detik...');
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
    }
    async function reLoginAndReopen() {
        await loginAndImpersonate();
        await openBupotAndPrep();
    }

    await openBupotAndPrep();

    const stats = { downloaded: 0, excelTotal: 0, excelBelum: 0, combosDone: 0, combosSkipped: 0 };
    let stopped = false;

    const combos = [];
    const masaList = parseMasaListInput(opts.masaInput);
    const kodeList = HAS_KODE_OBJEK_FILTER[bupotType] ? parseKodeObjekInput(opts.kodeInput) : [];
    const kodeCombos = kodeList.length ? kodeList : [null];
    for (const mmYY of masaList) {
        for (const kode of kodeCombos) {
            combos.push({
                comboLabel: masaToIndoLabel(mmYY) + (kode ? (' / kode ' + kode) : ' / semua kode'),
                mmYY, fileMasa: mmYY, ringkasanLabel: mmYY + (kode ? (' kode-' + kode) : ''), saveSubdir: mmYY, kode
            });
        }
    }

    const sizeState = { current: SIZE_STEPS.includes(Number(opts.pageSize)) ? Number(opts.pageSize) : 100 };

    async function runCombo(combo) {
        const { comboLabel, mmYY, kode, fileMasa, ringkasanLabel, saveSubdir } = combo;
        log('Filter: ' + comboLabel + ' (' + (combos.indexOf(combo) + 1) + '/' + combos.length + ')');
        const emit = (m) => log('[' + bupotLabel + ' ' + comboLabel + '] ' + m);

        try {
            const saveDir = path.join(saveRoot, entity.entity_id, bupotLabel, saveSubdir);
            const downloadedRefs = new Set();
            let gotCount = 0, rows = [];
            // Mid-run auto-logout recovers transparently here (re-login + resume this same
            // combo, already-downloaded files skipped) rather than surfacing as a combo
            // failure - matches the click-based version's behavior.
            for (let sessionRetries = 0; ; sessionRetries++) {
                try {
                    const result = await downloadComboData({ page, authState, bupotType, saveDir, mmYYForFilename: fileMasa, mmYY, kode, downloadedRefs, pdfEnabled, sizeState, emit });
                    gotCount = result.downloadedCount; rows = result.rows;
                    break;
                } catch (e) {
                    if (e.isSessionExpired && sessionRetries < 3) {
                        emit('Sesi Coretax berakhir di tengah proses (auto-logout) - login ulang dan melanjutkan...');
                        await reLoginAndReopen();
                        continue;
                    }
                    throw e;
                }
            }
            const summary = await writeRingkasanExcel(rows, downloadedRefs, saveDir, bupotLabel, ringkasanLabel, pdfEnabled, emit);
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
            if (typeof page.isClosed === 'function' && page.isClosed()) {
                emit('Jendela browser ditutup - proses dihentikan.');
                stopped = true;
                throw Object.assign(new Error('Jendela browser ditutup.'), { isStop: true });
            }
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
    }

    let verdict;
    if (!pdfEnabled) {
        verdict = stats.excelTotal ? ('Ringkasan Excel: ' + stats.excelTotal + ' baris.') : 'Tidak ada data.';
    } else if (stats.excelTotal) {
        verdict = stats.excelBelum === 0
            ? 'Semua ' + stats.excelTotal + ' baris di ringkasan Excel sudah ada PDF-nya - COCOK.'
            : stats.excelBelum + ' dari ' + stats.excelTotal + ' baris di ringkasan Excel BELUM ada PDF-nya - cek kolom "Status Download PDF" di file Ringkasan.';
    } else {
        verdict = 'Tidak ada data.';
    }
    const doneMsg = (stopped ? 'DIHENTIKAN' : 'SELESAI') + ': e-Bupot ' + bupotLabel + ' "' + entity.entity_name + '" - '
        + (pdfEnabled ? (stats.downloaded + ' PDF terunduh, ') : '') + stats.combosDone + ' kombinasi selesai'
        + (stats.combosSkipped ? (', ' + stats.combosSkipped + ' dilewati/gagal') : '') + '. ' + verdict;
    log(doneMsg + ' Jendela dibiarkan terbuka.');
    showPopup(doneMsg, 'Coretax Agent', stopped || stats.excelBelum ? 'Warning' : 'Information');
}

module.exports = { runEbupotDownload, BUPOT_URLS, BUPOT_LABELS, HAS_KODE_OBJEK_FILTER, BUPOT_PDF_CAPABLE };
