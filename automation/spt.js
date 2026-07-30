/* Coretax Agent - SPT PDF + BPE download automation (automation feature #2).

   REWRITTEN 2026-07-27 from the original click-based version to call Coretax's own listing/
   download APIs directly, mirroring automation/ebupot.js's proven approach - per live
   investigation (PIC Fredi Setyawan, entities PT Pesona Natasha Gemilang and PT Berkat Kana
   Abadi) that found:
     - the listing endpoint (`returnsheetportal/api/returnsheetssubmitted`) returns every field
       needed to drive a download - RecordId, AggregateIdentifier, TaxTypeCode,
       DocumentFormAggregateIdentifier, ReturnSheetNumber, ReturnSheetModel, LastUpdatedDate -
       with no need to open/scroll a DOM table at all;
     - the three UI "Jenis Pajak" checkboxes map to TaxTypeCode values CONFIRMED LIVE by
       checking each box alone and reading the resulting filter's own Filters.TaxTypeCode value
       (not guessed/order-matched): PPh 21/26 -> `ICT_WIT`, PPh Unifikasi -> `ICT_WT`,
       PPN -> `VAT_VAT` (yes, WIT=21/26 and WT=Unifikasi - counter-intuitive but empirically
       confirmed, don't "fix" this mapping without re-verifying live);
     - the auth token capture technique, apiPost-as-string-literal packaging workaround, and
       overall combo/retry/pause/skip/back/stop control-flow are carried over unchanged from
       automation/ebupot.js's own header comment (same rationale, same pkg bytecode constraint);
     - one PDF-download call (`downloadreturnsheet/download-returnsheet-document`) covers BOTH
       "generate on demand" and "download once ready" - call it with whatever
       DocumentFormAggregateIdentifier the listing currently shows (an all-zero sentinel GUID if
       never generated); a still-generating document responds 200 with
       `Payload:{IsError:true,ErrorMessage:"Generate Document is In Progress",ErrorCode:1}`
       (CONFIRMED LIVE against PT Berkat Kana Abadi, Feb 2025 PPh21/26 Amendment 001) rather than
       an HTTP error - poll by re-fetching the listing (which eventually reports a real
       DocumentFormAggregateIdentifier) and retrying, exactly like the old click-based version's
       generate-then-refresh loop, just without ever touching the DOM;
     - the "View Receipt" (BPE) endpoint (`downloadreturnsheet/view-receipt`) returns the same
       complete standalone HTML document the old version had to open a modal and read an
       iframe's `srcdoc` to get - here it's just `Payload`, a plain string, no DOM interaction
       needed at all.
   This eliminates the previous version's entire DOM/PrimeNG reliability surface: multiselect
   filter panels, exact-vs-substring option matching, table-settle waits, click/download-event
   racing - replaced by direct fetch() calls issued from inside the already-authenticated page
   (via page.evaluate, so real browser cookies/session apply automatically), same as ebupot.js. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const loginStatus = require('../lib/login-status');
const entitiesLib = require('../lib/entities');
const { masaToIndoLabel, parseMasaListInput } = require('../lib/masa');
const runcontrol = require('../lib/runcontrol');
const htmlToPdf = require('../lib/html-to-pdf');
const { _sleep, sanitizeFilenamePart } = require('../lib/datatable');

const SPT_URL = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';
const API_BASE = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const ZERO_DOC_ID = '00000000-0000-0000-0000-000000000000'; // sentinel meaning "never generated yet"

// CONFIRMED LIVE 2026-07-27 (see header comment) - do not "correct" WIT/WT without re-verifying.
const JENIS_PAJAK = {
    pph21: { taxTypeCode: 'ICT_WIT', sptToken: '1721 INDUK', bpeToken: '1721 BPE' },
    unifikasi: { taxTypeCode: 'ICT_WT', sptToken: 'UNIFIKASI INDUK', bpeToken: 'UNIFIKASI BPE' },
    ppn: { taxTypeCode: 'VAT_VAT', sptToken: 'PPN INDUK', bpeToken: 'PPN BPE' }
};
const JENIS_PAJAK_LABELS = { pph21: 'PPh 21/26', unifikasi: 'PPh Unifikasi', ppn: 'PPN' };
const TAXTYPE_TO_JENIS = { ICT_WIT: 'pph21', ICT_WT: 'unifikasi', VAT_VAT: 'ppn' };

/** "0326" -> "03032026" - same MM+MM+YYYY period-code convention confirmed for ebupot.js,
 *  confirmed live here too (e.g. Feb 2025 -> "02022025"). */
function mmYYToTaxPeriodCode(mmYY) {
    const mm = mmYY.slice(0, 2);
    return mm + mm + '20' + mmYY.slice(2);
}

/** Pulls the `taxpayer_id` claim out of a captured Bearer JWT - the impersonated entity's own
 *  TaxpayerAggregateIdentifier, same technique as ebupot.js's decodeJwtTaxpayerId. */
function decodeJwtTaxpayerId(bearerToken) {
    try {
        const token = String(bearerToken || '').replace(/^Bearer\s+/i, '');
        const payloadB64 = token.split('.')[1];
        const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json).taxpayer_id || null;
    } catch (e) { return null; }
}

/** Passively watches every request this page's context fires and keeps the latest
 *  `authorization`/`x-dgt-code` headers (+ decoded taxpayer id) - same rationale as ebupot.js's
 *  attachApiAuthCapture: stable for the whole session, so "latest seen" is always usable. */
function attachApiAuthCapture(page) {
    const state = { authorization: null, dgtCode: null, taxpayerId: null };
    page.context().on('request', (req) => {
        if (req.url().indexOf('/returnsheetportal/api/') === -1) return;
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

/** Fires an authenticated POST from INSIDE the page. Built as a literal source STRING (not
 *  `page.evaluate(fn, arg)`) for the exact same pkg-packaging reason documented in ebupot.js's
 *  apiPost - Function.toString()-based serialization breaks once compiled to bytecode. */
/** CONFIRMED LIVE BUG 2026-07-30 (real user, reproduced identically twice): this fetch() had no
 *  timeout at all - if Coretax's backend just never answers (network stall, server hang), the
 *  fetch never resolves, page.evaluate() never resolves, and the WHOLE run sits frozen forever
 *  right after "Total data: N baris." with zero further log output, until the user force-closes
 *  the app. AbortController below turns an indefinite hang into an explicit failure after 30s,
 *  which the existing status!==200 handling in every caller (tryFetchPdf, fetchBpeHtml, etc.)
 *  already knows how to surface as a real logged error instead of silence. */
async function apiPost(page, authState, url, bodyObj) {
    const expr = '(async () => {'
        + 'try {'
        + '  const ctrl = new AbortController();'
        + '  const timer = setTimeout(() => ctrl.abort(), 30000);'
        + '  let r;'
        + '  try {'
        + '    r = await fetch(' + JSON.stringify(url) + ', {'
        + '      method: "POST",'
        + '      headers: { "Content-Type": "application/json", "Authorization": ' + JSON.stringify(authState.authorization) + ', "x-dgt-code": ' + JSON.stringify(authState.dgtCode) + ' },'
        + '      credentials: "include",'
        + '      body: ' + JSON.stringify(JSON.stringify(bodyObj)) + ','
        + '      signal: ctrl.signal'
        + '    });'
        + '  } finally { clearTimeout(timer); }'
        + '  let json = null;'
        + '  try { json = await r.json(); } catch (e) {}'
        + '  return { status: r.status, json };'
        + '} catch (e) {'
        + '  return { status: 0, json: null };'
        + '}'
        + '})()';
    return page.evaluate(expr);
}

/** "Normal" -> null (no filename suffix); "Amendment 001" -> "1" (leading zeros stripped) per
 *  the spec's "Kalo ammendment X -> MMYY PB X" naming rule. Unchanged from the click-based
 *  version - still reads the SAME ReturnSheetModel text, just from JSON now instead of a DOM
 *  cell. */
function parseModelSptSuffix(modelText) {
    const m = /amendment\s+0*(\d+)/i.exec(modelText || '');
    return m ? String(parseInt(m[1], 10)) : null;
}

/** Per the spec's exact format: "ENTITY CODE - <token> MMYY[ PB N]". Unchanged from the
 *  click-based version. */
function buildSptFilename(entityCode, token, mmYY, pbSuffix) {
    const suffix = mmYY + (pbSuffix ? ' PB ' + pbSuffix : '');
    return sanitizeFilenamePart(entityCode) + ' - ' + token + ' ' + suffix + '.pdf';
}

/** Mirrors coretax-helper/run.js's copyToCompliance() - unchanged from the click-based
 *  version. Best-effort; never fails the download itself over this. */
/** Moves rather than copies as of 2026-07-30 (explicit user request): once the file is safely
 *  in the compliance folder, the CoretaxAgent-local copy under Downloads/CoretaxAgent/ is
 *  removed instead of being kept alongside it. Only deletes srcPath AFTER copyFileSync succeeds
 *  (never on a failed/partial copy, so nothing is ever lost). Tradeoff worth knowing: the
 *  existsSync(sptPath) "already downloaded" skip-check elsewhere in this file can no longer see
 *  a file that's been moved out - re-running the same masa later will re-fetch, re-copy, and
 *  re-delete it again rather than skipping. Harmless (idempotent end result) but not free. */
function copyToCompliance(srcPath, compFolder, emit) {
    if (!compFolder) return;
    try {
        fs.mkdirSync(compFolder, { recursive: true });
        const dest = path.join(compFolder, path.basename(srcPath));
        if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
        fs.copyFileSync(srcPath, dest);
        fs.rmSync(srcPath, { force: true });
    } catch (e) {
        emit('Gagal memindahkan ke folder compliance: ' + e.message);
    }
}

const SIZE_STEPS = [10, 25, 50, 100, 250, 500];

/** Pages through one masa's listing (ALL requested TaxTypeCodes at once, matching the old
 *  multiselect-checks-several-at-once behavior) until a page comes back shorter than requested -
 *  `TotalRecords`'s reliability was never checked live for THIS endpoint (only confirmed
 *  UNRELIABLE for ebupot's), so the same defensive stop-condition is used rather than trusting
 *  it. Throws with `.isSessionExpired = true` on a 401. */
async function fetchAllRows(page, authState, taxTypeCodes, mmYY, sizeState, emit) {
    const filters = [
        { PropertyName: 'TaxTypeCode', Value: taxTypeCodes, MatchMode: 'contains', CaseSensitive: true, AsString: false },
        { PropertyName: 'TaxPeriodCode', Value: mmYYToTaxPeriodCode(mmYY), MatchMode: 'equals', CaseSensitive: true, AsString: false }
    ];
    const all = [];
    let first = 0;
    for (;;) {
        await runcontrol.checkpoint();
        const override = Number(runcontrol.takePageSizeOverride());
        if (override) { sizeState.current = override; emit('Baris per pengambilan diubah manual ke ' + override + '.'); }
        runcontrol.reportPageSize(sizeState.current);
        const body = { TaxpayerAggregateIdentifier: authState.taxpayerId, isArchieved: false, First: first, Rows: sizeState.current, SortField: '', SortOrder: 1, Filters: filters, LanguageId: 'id-ID' };
        const { status, json } = await apiPost(page, authState, API_BASE + '/returnsheetssubmitted', body);
        if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil data.'); e.isSessionExpired = true; throw e; }
        if (status !== 200 || !json || json.IsSuccessful === false) {
            throw new Error('Gagal mengambil data SPT: HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : ''));
        }
        const pageRows = (json.Payload && json.Payload.Data) || [];
        all.push(...pageRows);
        if (pageRows.length) emit('Data diambil: ' + all.length + ' baris' + (pageRows.length === sizeState.current ? ' (lanjut...)' : '.'));
        if (pageRows.length < sizeState.current) break;
        first += sizeState.current;
    }
    return all;
}

/** One attempt at generating-or-downloading a row's SPT PDF. Returns {ready:true, buffer} once
 *  the PDF is available, or {ready:false} if Coretax is still generating it (CONFIRMED LIVE
 *  response shape: `Payload.IsError:true, ErrorMessage:"Generate Document is In Progress"`) -
 *  callers wait + re-fetch the row's listing state before retrying, same as the old click-based
 *  version's generate-then-refresh loop. */
async function tryFetchPdf(page, authState, row) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier || ZERO_DOC_ID,
        TaxpayerAggregateIdentifier: authState.taxpayerId,
        LetterNumber: row.ReturnSheetNumber,
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        IsReceipt: false,
        SignParameter: null
    };
    const { status, json } = await apiPost(page, authState, API_BASE + '/downloadreturnsheet/download-returnsheet-document', body);
    if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil PDF SPT.'); e.isSessionExpired = true; throw e; }
    if (status !== 200 || !json || json.IsSuccessful === false) {
        throw new Error('Gagal mengambil PDF SPT: HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : ''));
    }
    if (json.Payload && json.Payload.IsError) return { ready: false }; // still generating - not an error to surface
    if (!json.Content) return { ready: false };
    return { ready: true, buffer: Buffer.from(json.Content, 'base64') };
}

/** Fetches the BPE (View Receipt) as a ready-to-render standalone HTML document - the API
 *  returns the exact same complete HTML the old version had to open a modal and read an
 *  iframe's `srcdoc` to get, so no DOM interaction is needed at all here. */
async function fetchBpeHtml(page, authState, row) {
    const body = { ReturnSheetRecordIdentifier: row.RecordId, ReturnSheetAggregateIdentifier: row.AggregateIdentifier, TaxpayerAggregateIdentifier: authState.taxpayerId };
    const { status, json } = await apiPost(page, authState, API_BASE + '/downloadreturnsheet/view-receipt', body);
    if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil BPE.'); e.isSessionExpired = true; throw e; }
    if (status !== 200 || !json || json.IsSuccessful === false || !json.Payload) {
        throw new Error('Gagal mengambil BPE: HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : ''));
    }
    return json.Payload;
}

// How long to keep polling a single row that's still generating - CONFIRMED LIVE a real
// generation can take well over a minute (PT Berkat Kana Abadi's Feb 2025 PPh21/26 Amendment
// 001 case), so this is generous: up to 12 attempts * 5s = 60s per row before giving up.
const GENERATE_POLL_ATTEMPTS = 12;
const GENERATE_POLL_WAIT_MS = 5000;

/** Runs one already-filtered (all requested Jenis Pajak + exact Masa Pajak) combo entirely via
 *  the API - fetches every matching row, generates+downloads each row's SPT PDF (polling if
 *  Coretax is still rendering it) and BPE, skipping anything already on disk. A session-expiry
 *  mid-fetch bubbles up (`.isSessionExpired`) for the caller to re-login and re-run this combo. */
async function processSptCombo(ctx) {
    const { page, authState, saveDir, entityCode, mmYY, taxTypeCodes, sizeState, compFolder, onRowDone, log: emit } = ctx;
    let downloadedAny = false;
    const rows = await fetchAllRows(page, authState, taxTypeCodes, mmYY, sizeState, emit);
    if (!rows.length) { emit('Tidak ada data untuk filter ini.'); return { downloadedAny: false, foundAny: false }; }
    emit('Total data: ' + rows.length + ' baris.');

    for (let i = 0; i < rows.length; i++) {
        await runcontrol.checkpoint();
        let row = rows[i];
        const jenisKey = TAXTYPE_TO_JENIS[row.TaxTypeCode];
        if (!jenisKey) { emit('Baris ke-' + (i + 1) + ': TaxTypeCode "' + row.TaxTypeCode + '" tidak dikenali - dilewati.'); continue; }
        const meta = JENIS_PAJAK[jenisKey];
        const pbSuffix = parseModelSptSuffix(row.ReturnSheetModel);
        const sptPath = path.join(saveDir, buildSptFilename(entityCode, meta.sptToken, mmYY, pbSuffix));
        const bpePath = path.join(saveDir, buildSptFilename(entityCode, meta.bpeToken, mmYY, pbSuffix));
        if (fs.existsSync(sptPath) && fs.existsSync(bpePath)) continue; // already have both artifacts

        let rowOk = true;
        if (!fs.existsSync(sptPath)) {
            let result = await tryFetchPdf(page, authState, row);
            let attempt = 0;
            while (!result.ready && attempt < GENERATE_POLL_ATTEMPTS) {
                await runcontrol.checkpoint();
                if (attempt === 0) emit('Baris ke-' + (i + 1) + ' (' + JENIS_PAJAK_LABELS[jenisKey] + ', ' + (row.ReturnSheetModel || 'Normal') + '): PDF belum tersedia - meminta pembuatan...');
                await _sleep(GENERATE_POLL_WAIT_MS);
                // Re-fetch this row's own fresh state (DocumentFormAggregateIdentifier only
                // populates once generation finishes server-side) rather than trusting the
                // stale copy from the initial listing fetch.
                const refreshed = await fetchAllRows(page, authState, taxTypeCodes, mmYY, sizeState, () => {});
                const match = refreshed.find((r) => r.RecordId === row.RecordId) || row;
                row = match;
                result = await tryFetchPdf(page, authState, row);
                attempt++;
            }
            if (result.ready) {
                fs.mkdirSync(saveDir, { recursive: true });
                fs.writeFileSync(sptPath, result.buffer);
                downloadedAny = true;
                emit('Terunduh: ' + path.basename(sptPath));
                copyToCompliance(sptPath, compFolder, emit);
            } else {
                rowOk = false;
                emit('Baris ke-' + (i + 1) + ': SPT PDF gagal terunduh (masih dalam proses pembuatan setelah ' + GENERATE_POLL_ATTEMPTS + ' percobaan) - dilewati, bisa diulang manual.');
            }
        } else copyToCompliance(sptPath, compFolder, emit);

        if (!fs.existsSync(bpePath)) {
            try {
                const html = await fetchBpeHtml(page, authState, row);
                fs.mkdirSync(saveDir, { recursive: true });
                await htmlToPdf.renderHtmlToPdf(html, bpePath);
                emit('Terunduh: ' + path.basename(bpePath));
                copyToCompliance(bpePath, compFolder, emit);
            } catch (e) {
                if (e.isSessionExpired) throw e;
                rowOk = false;
                emit('Baris ke-' + (i + 1) + ': BPE gagal terunduh - ' + e.message + ' - dilewati, bisa diulang manual.');
            }
        } else copyToCompliance(bpePath, compFolder, emit);

        if (onRowDone) { try { onRowDone(jenisKey, mmYY, rowOk); } catch (e) {} }
    }
    return { downloadedAny, foundAny: true };
}

const SIZE_DEFAULT = 10;

/** Top-level entry point. `opts`: unchanged shape from the click-based version -
 *   client, orgId, entity ({entity_id, entity_name, npwp, individual}), picId,
 *   jenisPajakKeys (array of 'pph21'|'unifikasi'|'ppn'), masaInput (string, e.g. "0125-1225"
 *   or a single "0626"), saveRoot (optional), manualPage (optional, manual-session mode),
 *   compFolder (optional), onRowDone (optional (jenisKey, mmYY, ok) => void). */
async function runSptDownload(opts) {
    const { client, orgId, entity, picId, jenisPajakKeys } = opts;
    const keys = (jenisPajakKeys || []).filter((k) => JENIS_PAJAK[k]);
    if (!keys.length) throw new Error('Jenis pajak belum dipilih.');
    const masaList = parseMasaListInput(opts.masaInput);
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');

    const manual = !!opts.manualPage;
    // Declared at function scope (not inside the `else` below) - loginAndImpersonate() below
    // closes over these; a block-scoped `const` inside `else` previously left them undefined by
    // the time it ran, throwing "restricted is not defined" on every normal (non-manual) run.
    const restricted = !!opts.restricted;
    const passphrase = opts.passphrase || null;
    const allowedEbupotSections = opts.allowedEbupotSections || null;
    log('Memulai download SPT (' + keys.map((k) => JENIS_PAJAK_LABELS[k]).join(', ') + ')'
        + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');
    let cred = null, page;
    if (manual) {
        page = opts.manualPage;
        if (chrome.isLoggedOut(page)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
    } else {
        cred = await entitiesLib.getCredential(client, orgId, picId);
        ({ page } = await chrome.launchOrReuseContext(picId, async (download) => {
            try {
                await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename()));
                await download.delete().catch(() => {});
            } catch (e) {}
        }, restricted, allowedEbupotSections));
    }
    const authState = attachApiAuthCapture(page);

    async function loginAndImpersonate() {
        if (manual) {
            if (chrome.isLoggedOut(page)) throw new Error('Sesi manual berakhir - silakan login ulang di jendela Coretax lalu klik 🔁 Ulang.');
            return;
        }
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint, restricted, passphrase, allowedEbupotSections });
    }
    await loginAndImpersonate();

    try {
        const coretaxAs = manual
            ? await chrome.getManualStatus().then((s) => s.identity).catch(() => '')
            : (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
        runcontrol.setCoretaxAs(coretaxAs || entity.entity_name);
        if (!manual) loginStatus.set(picId, entity);
    } catch (e) {}

    async function openSptAndPrep() {
        const NAV_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
            await runcontrol.checkpoint();
            try {
                await page.goto(SPT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                if (chrome.isLoggedOut(page)) {
                    log('Halaman SPT memantulkan ke login - login ulang lalu buka lagi...');
                    await loginAndImpersonate();
                    continue;
                }
                const captured = await waitForAuthCaptured(authState, 20000);
                if (!captured) throw new Error('Tidak berhasil menangkap sesi API Coretax (authorization header) dari halaman.');
                return;
            } catch (e) {
                if (attempt === NAV_ATTEMPTS) throw new Error('Gagal membuka halaman SPT setelah ' + NAV_ATTEMPTS + ' percobaan: ' + e.message);
                const waitMs = 3000 * attempt;
                log('Gagal membuka halaman SPT (percobaan ' + attempt + '/' + NAV_ATTEMPTS + '): ' + e.message + ' - coba lagi dalam ' + (waitMs / 1000) + ' detik...');
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
    }
    async function reLoginAndReopen() {
        await loginAndImpersonate();
        await openSptAndPrep();
    }
    await openSptAndPrep();

    const stats = { downloaded: 0, combosDone: 0, combosSkipped: 0 };
    let stopped = false;

    const taxTypeCodes = keys.map((k) => JENIS_PAJAK[k].taxTypeCode);
    const jenisLabel = keys.map((k) => JENIS_PAJAK_LABELS[k]).join(' + ');
    const combos = masaList.map((mmYY) => ({ mmYY, comboLabel: jenisLabel + ' / ' + masaToIndoLabel(mmYY) }));
    const sizeState = { current: SIZE_STEPS.includes(Number(opts.pageSize)) ? Number(opts.pageSize) : SIZE_DEFAULT };

    async function runCombo(combo) {
        const { mmYY, comboLabel } = combo;
        const emit = (m) => log('[SPT ' + comboLabel + '] ' + m);
        try {
            const saveDir = path.join(saveRoot, entity.entity_id, 'SPT', mmYY);
            for (let sessionRetries = 0; ; sessionRetries++) {
                try {
                    const result = await processSptCombo({
                        page, authState, saveDir, entityCode: entity.entity_id, mmYY, taxTypeCodes, sizeState,
                        compFolder: opts.compFolder, onRowDone: opts.onRowDone ? (jk, m, ok) => opts.onRowDone(jk, m, ok) : null,
                        log: emit
                    });
                    if (result.downloadedAny) stats.downloaded++;
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
