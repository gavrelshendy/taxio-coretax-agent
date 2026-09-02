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
const { masaToIndoLabel, parseMasaListInput, parseAnnualYearListInput, annualYearToTaxPeriodCode, annualYearToIndoLabel } = require('../lib/masa');
const runcontrol = require('../lib/runcontrol');
const htmlToPdf = require('../lib/html-to-pdf');
const { _sleep, sanitizeFilenamePart } = require('../lib/datatable');
const billing = require('./billing');
const lampiran = require('./lampiran');

const SPT_URL = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';
const API_BASE = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const DOC_MGMT_API_BASE = 'https://coretaxdjp.pajak.go.id/documentmanagementportal/api';
const ZERO_DOC_ID = '00000000-0000-0000-0000-000000000000'; // sentinel meaning "never generated yet"

// CONFIRMED LIVE 2026-07-27 (see header comment) - do not "correct" WIT/WT without re-verifying.
// badan/spt_op CONFIRMED LIVE 2026-08-05 (real user manual click-through, network-captured):
// SPT Badan (annual PPh Badan) and SPT Orang Pribadi (annual individual PPh) use the EXACT same
// returnsheetssubmitted/download-returnsheet-document/view-receipt endpoints as the masa-based
// types above - only the TaxTypeCode and the period-code SHAPE differ (see `annual: true` below,
// which routes these through parseAnnualYearListInput/annualYearToTaxPeriodCode instead of the
// monthly MMYY parsing). spt_op additionally never goes through impersonation at all - Coretax
// disables the SPT OP menu entirely while impersonating a Badan entity, and chrome.js's
// switchToEntity() already special-cases `entity.individual` to skip impersonation, matching
// exactly how e-Bupot's own Bukti Potong download already works for individual taxpayers.
const JENIS_PAJAK = {
    pph21: { taxTypeCode: 'ICT_WIT', sptToken: '1721 INDUK', bpeToken: '1721 BPE', packageToken: 'SPT MASA PPH 21' },
    unifikasi: { taxTypeCode: 'ICT_WT', sptToken: 'UNIFIKASI INDUK', bpeToken: 'UNIFIKASI BPE', packageToken: 'SPT MASA PPH UNIFIKASI' },
    ppn: { taxTypeCode: 'VAT_VAT', sptToken: 'PPN INDUK', bpeToken: 'PPN BPE', packageToken: 'SPT MASA PPN' },
    badan: { taxTypeCode: 'ICT_RCIT', sptToken: 'SPT Tahunan PPh Badan Induk', bpeToken: 'SPT Tahunan PPh Badan BPE', packageToken: 'SPT TAHUNAN PPH BADAN', annual: true },
    spt_op: { taxTypeCode: 'ICT_PIT', sptToken: 'SPT Tahunan PPh Orang Pribadi Induk', bpeToken: 'SPT Tahunan PPh Orang Pribadi BPE', packageToken: 'SPT TAHUNAN PPH ORANG PRIBADI', annual: true, requiresIndividual: true }
};
const JENIS_PAJAK_LABELS = { pph21: 'PPh 21/26', unifikasi: 'PPh Unifikasi', ppn: 'PPN', badan: 'PPh Badan (Tahunan)', spt_op: 'PPh Orang Pribadi (Tahunan)' };
const TAXTYPE_TO_JENIS = { ICT_WIT: 'pph21', ICT_WT: 'unifikasi', VAT_VAT: 'ppn', ICT_RCIT: 'badan', ICT_PIT: 'spt_op' };

/** "0326" -> "03032026" - same MM+MM+YYYY period-code convention confirmed for ebupot.js,
 *  confirmed live here too (e.g. Feb 2025 -> "02022025"). */
function mmYYToTaxPeriodCode(mmYY) {
    const mm = mmYY.slice(0, 2);
    return mm + mm + '20' + mmYY.slice(2);
}

/** Cross-check (opt-in) - dipakai automation/billing.js's Buku Besar lookup terhadap masa yang
 *  SAMA dengan SPT yang sedang di-download, sekadar informasi tambahan di log (tidak mengubah
 *  apa pun, tidak menghentikan proses SPT-nya sendiri).
 *
 *  DENGAN SENGAJA memakai mmYYToTaxPeriodCode (hand-constructed) di atas, BUKAN
 *  billing.js's resolveTaxPeriodCode - resolveTaxPeriodCode mengambil daftar periode yang
 *  MASIH BISA dibuatkan Kode Billing baru, dan MENOLAK (throw) masa yang sudah lewat/ditutup -
 *  persis masa yang justru paling relevan dicek di sini (sudah lunas = biasanya sudah tidak
 *  muncul di daftar "bisa dibuat baru" itu). checkAlreadyPaid sendiri cuma butuh PeriodCode
 *  untuk dicocokkan APA ADANYA terhadap data ledger Coretax, bukan untuk membuat apa pun - jadi
 *  aman pakai bentuk hand-constructed. Diverifikasi live 2026-08-20 terhadap referensi yang
 *  sudah didokumentasikan billing.js sendiri (DION FARMA ABADI masa 06/2026, Rp 58.327.235,
 *  lunas): PeriodCode "06062026" hasil mmYYToTaxPeriodCode cocok PERSIS dengan PeriodCode yang
 *  dikembalikan Coretax pada baris ledger yang sama. */
async function checkPph25ForMasa(page, authState, entity, mmYY, emit) {
    try {
        const taxTypeCode = billing.TAX_TYPE_CODE[entity.individual ? 'individual' : 'badan'];
        const periodCode = mmYYToTaxPeriodCode(mmYY);
        const paid = await billing.checkAlreadyPaid(page, authState, taxTypeCode, billing.TAX_PAYMENT_CODE, periodCode);
        if (paid) {
            const tgl = String(paid.TransactionDate || '').slice(0, 10);
            emit('PPh 25 masa ' + mmYY + ': SUDAH DIBAYAR (Rp ' + Math.abs(Number(paid.Amount) || 0).toLocaleString('id-ID') + ', lunas di Buku Besar' + (tgl ? ', ' + tgl : '') + ').');
        } else {
            emit('PPh 25 masa ' + mmYY + ': BELUM/TIDAK ditemukan lunas di Buku Besar.');
        }
        return paid;
    } catch (e) {
        emit('Cek PPh 25 masa ' + mmYY + ' gagal: ' + e.message + ' - dilewati, tidak memengaruhi download SPT.');
        return null;
    }
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

function buildLampiranViewCandidates(row, authState) {
    const config = lampiran.TAXTYPE_CONFIG[row.TaxTypeCode];
    if (!config) return [];
    const unique = (values) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
    const taxpayerIds = unique([authState.taxpayerId, row.TaxpayerAggregateIdentifier]);
    const recordIds = unique([row.RecordId, row.ReturnSheetRecordIdentifier]);
    const routeCodes = unique([
        ['ICT_WT', 'VAT_VAT'].includes(row.TaxTypeCode) ? row.TaxPeriodCode : row.TaxTypeCode,
        row.TaxTypeCode,
        row.TaxPeriodCode,
        row.ReturnSheetTypeCode
    ]);
    const aggregateIds = unique([
        row.AggregateIdentifier,
        row.ReturnSheetAggregateIdentifier,
        row.FormAggregateIdentifier
    ]);
    const urls = [];
    for (const taxpayerId of taxpayerIds) for (const recordId of recordIds) {
        for (const routeCode of routeCodes) for (const aggregateId of aggregateIds) {
            urls.push('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/' + config.pathKind + '/'
                + taxpayerId + '/' + recordId + '/' + routeCode + '/' + aggregateId + '?view=true');
        }
    }
    return unique(urls);
}

async function openLampiranView(page, row, authState, emit) {
    const config = lampiran.TAXTYPE_CONFIG[row.TaxTypeCode];
    if (!config) throw new Error('Jenis lampiran ' + row.TaxTypeCode + ' belum didukung.');
    const candidates = buildLampiranViewCandidates(row, authState);
    for (let index = 0; index < candidates.length; index++) {
        const url = candidates[index];
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector(config.rootSelector, { timeout: 20000 });
            emit('Halaman Lampiran terbuka (' + (index + 1) + '/' + candidates.length + ').');
            return url;
        } catch (e) {
            if (index === candidates.length - 1) throw new Error('Halaman Lampiran tidak dapat dibuka: ' + e.message);
        }
    }
    throw new Error('Alamat halaman Lampiran tidak tersedia pada data SPT.');
}

function removeIntermediateFiles(paths, keepPath, emit) {
    for (const candidate of paths) {
        if (!candidate || candidate === keepPath || !fs.existsSync(candidate)) continue;
        try { fs.rmSync(candidate, { force: true }); }
        catch (e) { emit('Peringatan: file sementara tidak dapat dibersihkan - ' + path.basename(candidate) + ': ' + e.message); }
    }
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
async function fetchAllRows(page, authState, taxTypeCodes, taxPeriodCode, sizeState, emit) {
    const filters = [
        { PropertyName: 'TaxTypeCode', Value: taxTypeCodes, MatchMode: 'contains', CaseSensitive: true, AsString: false },
        { PropertyName: 'TaxPeriodCode', Value: taxPeriodCode, MatchMode: 'equals', CaseSensitive: true, AsString: false }
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

/** CONFIRMED LIVE 2026-08-05 (real user report - generate suddenly failing with HTTP 400 on
 *  every row, reproduced by watching a live manual click-through with network capture): Coretax
 *  added a REQUIRED e-signing step to download-returnsheet-document at some point after this
 *  file's original 2026-07-27 rewrite (which correctly found `SignParameter:null` worked fine
 *  back then - not a mistake, a genuine platform change). The captured working sequence for one
 *  manual click was: check-signing-info (already called elsewhere) -> THIS validate-sign call
 *  (Nik + Passphrase, confirms the PIC's own signing passphrase before attempting anything) ->
 *  download-returnsheet-document, now requiring a populated SignParameter
 *  {Type:"02",Provider:"00",SignerID:<NIK>,SignerPassword:<passphrase>} in the body instead of
 *  null - omitting it is exactly what produces the HTTP 400. NIK here is the PIC's OWN Coretax
 *  login username (cred.username in chrome.js's loginAndImpersonate) - the passphrase is the
 *  same one already stored per-PIC and used for the copy-passphrase widget elsewhere
 *  (entitiesLib.getPassphrase). Called once per PIC session (not per row) as a fail-fast check -
 *  a wrong/missing passphrase surfaces here with a clear message instead of a confusing 400
 *  later on every single row. */
async function validateSign(page, authState, nik, passphrase) {
    if (!nik || !passphrase) throw new Error('PIC ini belum punya passphrase tanda tangan tersimpan di Taxio - isi dulu lewat "Manage Coretax PIC" sebelum download SPT.');
    const body = { Nik: nik, Passphrase: passphrase, TaxpayerAggregateIdentifier: authState.taxpayerId };
    const { status, json } = await apiPost(page, authState, DOC_MGMT_API_BASE + '/documentOutbound/validate-sign', body);
    if (status === 401) { const e = new Error('Sesi berakhir (401) saat validasi passphrase tanda tangan.'); e.isSessionExpired = true; throw e; }
    const ok = status === 200 && json && json.IsSuccessful !== false && json.Payload && json.Payload.IsSuccessful;
    if (!ok) {
        const msg = (json && json.Payload && json.Payload.ErrMessage) || (json && json.Message) || ('HTTP ' + status);
        throw new Error('Passphrase tanda tangan ditolak Coretax: ' + msg);
    }
    return { Type: '02', Provider: '00', SignerID: nik, SignerPassword: passphrase };
}

/** One attempt at generating-or-downloading a row's SPT PDF. Returns {ready:true, buffer} once
 *  the PDF is available, or {ready:false} if Coretax is still generating it (CONFIRMED LIVE
 *  response shape: `Payload.IsError:true, ErrorMessage:"Generate Document is In Progress"`) -
 *  callers wait + re-fetch the row's listing state before retrying, same as the old click-based
 *  version's generate-then-refresh loop. */
async function tryFetchPdf(page, authState, row, signParam) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier || ZERO_DOC_ID,
        TaxpayerAggregateIdentifier: authState.taxpayerId,
        LetterNumber: row.ReturnSheetNumber,
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        IsReceipt: false,
        SignParameter: signParam || null
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
    const { page, authState, saveDir, entityCode, mmYY, taxTypeCodes, sizeState, compFolder, onRowDone, signParam, isAnnual,
        includeLampiran, lampiranMode, outputLayout, saveRoot, log: emit } = ctx;
    const taxPeriodCode = isAnnual ? annualYearToTaxPeriodCode(mmYY) : mmYYToTaxPeriodCode(mmYY);
    let downloadedAny = false;
    const rows = await fetchAllRows(page, authState, taxTypeCodes, taxPeriodCode, sizeState, emit);
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
        const packageModeSuffix = lampiranMode === 'print' ? ' (Print)' : lampiranMode === 'confidential' ? ' (Confidential)' : '';
        const packagePath = path.join(saveDir, buildSptFilename(entityCode, meta.packageToken + packageModeSuffix, mmYY, pbSuffix));
        if (includeLampiran && outputLayout === 'combined' && fs.existsSync(packagePath)) {
            if (onRowDone) { try { onRowDone(jenisKey, mmYY, true); } catch (e) {} }
            continue;
        }
        if (!includeLampiran && fs.existsSync(sptPath) && fs.existsSync(bpePath)) {
            // Sudah ada dari sebelumnya - baris ini genuinely sukses (filenya nyata di disk),
            // tapi tanpa ini onRowDone tidak pernah dipanggil untuk baris ini sama sekali, jadi
            // checkbox Jenis Pajak di GUI tidak pernah ditandai selesai walau downloadnya
            // (dulu atau sekarang) benar-benar berhasil. Ditemukan live 2026-08-20.
            if (onRowDone) { try { onRowDone(jenisKey, mmYY, true); } catch (e) {} }
            continue;
        }

        let rowOk = true;

        // BPE first: it's a single fast fetch (no server-side "still generating" wait), so it
        // should never sit blocked behind a slow/stuck SPT induk. Explicit user request
        // 2026-07-30: if BPE can download, download it - don't make it wait on the induk.
        if (!fs.existsSync(bpePath)) {
            try {
                const html = await fetchBpeHtml(page, authState, row);
                fs.mkdirSync(saveDir, { recursive: true });
                await htmlToPdf.renderHtmlToPdf(html, bpePath);
                downloadedAny = true;
                emit('Terunduh: ' + path.basename(bpePath));
            } catch (e) {
                if (e.isSessionExpired) throw e;
                emit('Baris ke-' + (i + 1) + ': BPE tidak tersedia - ' + e.message + ' - dilewati tanpa menghentikan SPT/Lampiran.');
            }
        }

        if (!fs.existsSync(sptPath)) {
            // CONFIRMED LIVE 2026-07-30 (real Coretax platform-side stuck document, reproduced
            // both via automation and via a manual UI click - see apiPost's header comment): a
            // single row's fetch failing (timeout, or genuinely stuck server-side generation)
            // used to throw all the way out of this function uncaught, pausing the ENTIRE run
            // and blocking every OTHER row - including ones that would have downloaded fine on
            // their own. Explicit user request: one bad row should fail/skip on its own, not
            // take the whole batch down with it. Mirrors the try/catch the BPE fetch above -
            // this was a pre-existing inconsistency between the two, not a deliberate design
            // difference. isSessionExpired still propagates (correctly - every remaining row
            // needs a fresh login too, so pausing there is the right call).
            let result = { ready: false };
            let caughtError = null;
            try {
                result = await tryFetchPdf(page, authState, row, signParam);
                let attempt = 0;
                while (!result.ready && attempt < GENERATE_POLL_ATTEMPTS) {
                    await runcontrol.checkpoint();
                    if (attempt === 0) emit('Baris ke-' + (i + 1) + ' (' + JENIS_PAJAK_LABELS[jenisKey] + ', ' + (row.ReturnSheetModel || 'Normal') + '): PDF belum tersedia - meminta pembuatan...');
                    await _sleep(GENERATE_POLL_WAIT_MS);
                    // Re-fetch this row's own fresh state (DocumentFormAggregateIdentifier only
                    // populates once generation finishes server-side) rather than trusting the
                    // stale copy from the initial listing fetch.
                    const refreshed = await fetchAllRows(page, authState, taxTypeCodes, taxPeriodCode, sizeState, () => {});
                    const match = refreshed.find((r) => r.RecordId === row.RecordId) || row;
                    row = match;
                    result = await tryFetchPdf(page, authState, row, signParam);
                    attempt++;
                }
            } catch (e) {
                if (e.isSessionExpired) throw e;
                caughtError = e;
                result = { ready: false };
            }
            if (result.ready) {
                fs.mkdirSync(saveDir, { recursive: true });
                const officialBuffer = jenisKey === 'ppn'
                    ? await lampiran.compactPpnOfficialIndukPdf(result.buffer) : result.buffer;
                fs.writeFileSync(sptPath, officialBuffer);
                downloadedAny = true;
                emit('Terunduh: ' + path.basename(sptPath));
            } else {
                rowOk = false;
                if (caughtError) {
                    emit('Baris ke-' + (i + 1) + ': SPT PDF gagal terunduh - ' + caughtError.message + ' - dilewati, bisa diulang manual.');
                } else {
                    emit('Baris ke-' + (i + 1) + ': SPT PDF gagal terunduh (masih dalam proses pembuatan setelah ' + GENERATE_POLL_ATTEMPTS + ' percobaan) - dilewati, bisa diulang manual.');
                }
            }
        }

        let lampiranResult = null;
        if (includeLampiran && rowOk && fs.existsSync(sptPath)) {
            try {
                await openLampiranView(page, row, authState, emit);
                lampiranResult = await lampiran.downloadLampiran(page, {
                    saveRoot,
                    outputDir: saveDir,
                    entityCode,
                    entityName: entityCode,
                    compFolder: null
                }, authState.taxpayerId, row.RecordId, row.TaxTypeCode, lampiranMode,
                isAnnual ? mmYY : '', outputLayout);
                if (!lampiranResult || !lampiranResult.ok) {
                    throw new Error((lampiranResult && lampiranResult.error) || 'Lampiran tidak berhasil dibuat.');
                }
                downloadedAny = true;
                emit('Lampiran selesai: ' + lampiranResult.count + ' file (' + outputLayout + ').');
            } catch (e) {
                if (e.isSessionExpired) throw e;
                rowOk = false;
                emit('Baris ke-' + (i + 1) + ': Lampiran gagal dibuat - ' + e.message + '.');
            }
        }

        const basePaths = [bpePath, sptPath].filter((candidate) => fs.existsSync(candidate));
        const lampiranPaths = lampiranResult && Array.isArray(lampiranResult.paths) ? lampiranResult.paths : [];
        if (includeLampiran && outputLayout === 'combined' && rowOk && fs.existsSync(sptPath) && lampiranResult && lampiranResult.combinedPath) {
            const orderedPaths = [
                ...(fs.existsSync(bpePath) ? [bpePath] : []),
                sptPath,
                lampiranResult.combinedPath
            ];
            const merged = await lampiran.mergePdfs(orderedPaths.map((candidate) => fs.readFileSync(candidate)));
            fs.writeFileSync(packagePath, merged);
            downloadedAny = true;
            emit('Tersimpan gabungan (BPE - Induk - Lampiran): ' + path.basename(packagePath));
            removeIntermediateFiles([...basePaths, ...lampiranPaths], packagePath, emit);
            copyToCompliance(packagePath, compFolder, emit);
        } else if (includeLampiran && outputLayout === 'separate' && lampiranResult && lampiranResult.ok) {
            for (const filePath of [...basePaths, ...lampiranPaths]) copyToCompliance(filePath, compFolder, emit);
        } else {
            // Tanpa Lampiran, atau bila pembuatan Lampiran gagal, pertahankan hasil BPE/Induk
            // yang sudah berhasil agar proses parsial tidak hilang.
            for (const filePath of basePaths) copyToCompliance(filePath, compFolder, emit);
        }

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
    const { client, orgId, entity, jenisPajakKeys } = opts;
    const checkPph25 = !!opts.checkPph25;
    const includeLampiran = !!opts.includeLampiran;
    const lampiranMode = ['print', 'full', 'confidential'].includes(opts.lampiranMode) ? opts.lampiranMode : 'print';
    const outputLayout = ['combined', 'separate'].includes(opts.outputLayout) ? opts.outputLayout : 'combined';
    // Reassignable (not const) - the automatic fallback-PIC retry pass further down needs to
    // point login/cred at a DIFFERENT linked PIC after the first pass finishes, and
    // loginAndImpersonate()/openSptAndPrep() below close over this as a free variable so
    // reassigning it here is what makes the retry actually use the new PIC.
    let picId = opts.picId;
    const keys = (jenisPajakKeys || []).filter((k) => JENIS_PAJAK[k]);
    if (!keys.length) throw new Error('Jenis pajak belum dipilih.');
    if (includeLampiran && lampiranMode === 'confidential' && !(keys.length === 1 && keys[0] === 'pph21')) {
        throw new Error('Mode Confidential hanya tersedia bila PPh 21/26 dipilih sendiri.');
    }
    // SPT Badan/OP (annual) use a whole-year TaxPeriodCode, incompatible with the monthly masa
    // types above - reject a mixed selection rather than silently misinterpreting the input.
    const annualFlags = keys.map((k) => !!JENIS_PAJAK[k].annual);
    if (annualFlags.some(Boolean) && !annualFlags.every(Boolean)) {
        throw new Error('Tidak bisa menggabungkan SPT tahunan (Badan/Orang Pribadi) dengan SPT masa bulanan dalam satu proses - pilih salah satu jenis dulu.');
    }
    const isAnnual = annualFlags[0];
    // SPT OP never goes through impersonation (Coretax disables that menu entirely while
    // impersonating a Badan entity) - see JENIS_PAJAK's header comment.
    if (keys.some((k) => JENIS_PAJAK[k].requiresIndividual) && !opts.manualPage && !entity.individual) {
        throw new Error('SPT Orang Pribadi hanya bisa diproses untuk entitas Individual (login langsung, tanpa impersonate).');
    }
    const masaList = isAnnual ? parseAnnualYearListInput(opts.masaInput) : parseMasaListInput(opts.masaInput);
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');

    const manual = !!opts.manualPage;
    // Declared at function scope (not inside the `else` below) - loginAndImpersonate() below
    // closes over these; a block-scoped `const` inside `else` previously left them undefined by
    // the time it ran, throwing "restricted is not defined" on every normal (non-manual) run.
    const restricted = !!opts.restricted;
    // Reassignable - the fallback-PIC pass fetches this PIC's OWN passphrase (each PIC has their
    // own e-signing passphrase; reusing the originally-selected PIC's would show the wrong one in
    // the copy-passphrase widget for the fallback PIC's window).
    let passphrase = opts.passphrase || null;
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
    // Reassignable - same reason as `picId` above, needs a fresh capture state bound to the
    // fallback pass's own page/context.
    let authState = attachApiAuthCapture(page);

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

    // Coretax now requires a signed SignParameter on every download-returnsheet-document call
    // (see validateSign()'s header comment) - resolve it once per PIC session, right after
    // openSptAndPrep() so authState is definitely populated (waitForAuthCaptured already ran
    // inside it). manual mode has no `cred` of its own - opts.nik lets a caller that already
    // knows the PIC's credential (deeplink.js does its own getCredential/getPassphrase) supply
    // it; a caller with neither (a genuinely hands-off manual session) just gets signParam=null,
    // same as before this fix - individual rows will surface the real Coretax error if signing
    // truly is required. A validate-sign failure warns and continues rather than aborting the
    // whole run, so a stale/misconfigured passphrase degrades to the old per-row failure mode
    // instead of blocking everything up front.
    let signParam = null;
    const signerNik = manual ? opts.nik : (cred && cred.username);
    if (signerNik && passphrase) {
        try { signParam = await validateSign(page, authState, signerNik, passphrase); }
        catch (e) {
            if (e.isSessionExpired) throw e;
            log('Peringatan: ' + e.message + ' - lanjut tanpa tanda tangan (baris mungkin gagal digenerate).');
        }
    }

    // Widget "Unduh Lampiran Lengkap" (lihat automation/lampiran.js) - dipasang di sini (bukan
    // cuma untuk jenis SPT Badan) supaya tersedia begitu saja kalau user membuka halaman "view"
    // SPT mana pun secara manual di jendela yang sama setelah run ini - fitur mendeteksi sendiri
    // via URL apakah halaman yang sedang dibuka didukung, jadi aman dipasang tanpa syarat di sini.
    await lampiran.installLampiranWidget(page, { saveRoot, entityCode: entity.entity_id, compFolder: opts.compFolder })
        .catch((e) => log('Peringatan: widget Lampiran gagal dipasang: ' + e.message));

    const stats = { downloaded: 0, combosDone: 0, combosSkipped: 0, combosEmpty: 0 };
    let stopped = false;

    const taxTypeCodes = keys.map((k) => JENIS_PAJAK[k].taxTypeCode);
    const jenisLabel = keys.map((k) => JENIS_PAJAK_LABELS[k]).join(' + ');
    const combos = masaList.map((mmYY) => ({ mmYY, comboLabel: jenisLabel + ' / ' + (isAnnual ? annualYearToIndoLabel(mmYY) : masaToIndoLabel(mmYY)) }));
    const sizeState = { current: SIZE_STEPS.includes(Number(opts.pageSize)) ? Number(opts.pageSize) : SIZE_DEFAULT };

    // Some entities have more than one PIC linked on Coretax's side (e.g. Dion Farma Abadi -
    // Fredi Setyawan AND Ronald Tony) - an SPT can only ever be fetched by whichever PIC actually
    // signed it, so a row failing under the requested PIC doesn't necessarily mean it's stuck; it
    // may just need the OTHER PIC's session. Track PER (jenisKey, masa) - NOT masa alone - which
    // rows genuinely fail (not "still generating", not session-expiry - those already retry/pause
    // on their own) so a fallback-PIC pass further down can retry only the masa that still have a
    // failure. CONFIRMED LIVE 2026-08-04: one masa combo covers several tax types at once (PPh21,
    // Unifikasi, PPN all share the same mmYY) - tracking failure keyed by mmYY alone meant a LATER
    // row's success for the same masa (e.g. Unifikasi) cleared an EARLIER row's genuine failure
    // (PPN) for that same masa, so the fallback never triggered even though a row had truly failed.
    const failedPairs = new Set(); // "jenisKey|mmYY"
    const failedMmYYSet = () => new Set(Array.from(failedPairs, (p) => p.slice(p.indexOf('|') + 1)));
    const baseOnRowDone = opts.onRowDone;
    const trackingOnRowDone = (jk, m, ok) => {
        const key = jk + '|' + m;
        if (ok) failedPairs.delete(key); else failedPairs.add(key);
        if (baseOnRowDone) baseOnRowDone(jk, m, ok);
    };

    async function runCombo(combo) {
        const { mmYY, comboLabel } = combo;
        const emit = (m) => log('[SPT ' + comboLabel + '] ' + m);
        try {
            const saveDir = path.join(saveRoot, entity.entity_id, 'SPT', mmYY);
            for (let sessionRetries = 0; ; sessionRetries++) {
                try {
                    const result = await processSptCombo({
                        page, authState, saveDir, entityCode: entity.entity_id, mmYY, taxTypeCodes, sizeState,
                        compFolder: opts.compFolder, onRowDone: trackingOnRowDone, signParam, isAnnual,
                        includeLampiran, lampiranMode, outputLayout, saveRoot,
                        log: emit
                    });
                    if (result.downloadedAny) stats.downloaded++;
                    // foundAny:false ("Tidak ada data untuk filter ini.") sebelumnya cuma
                    // sebaris log yang gampang terlewat - dihitung terpisah di sini supaya
                    // ringkasan akhir bisa membedakan "memang tidak ada data" dari kegagalan.
                    else if (!result.foundAny) stats.combosEmpty++;
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
            // Opt-in, sekali per masa (bukan per jenis pajak - PPh 25 tidak terkait jenis SPT
            // yang dipilih). Cuma untuk SPT bulanan - PPh 25 adalah angsuran bulanan, tidak
            // relevan untuk kombinasi tahunan (Badan/OP).
            if (checkPph25 && !isAnnual) await checkPph25ForMasa(page, authState, entity, mmYY, emit);
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

        // Fallback-PIC pass: explicit request 2026-08-04 (Dion Farma Abadi cs. - entities with
        // more than one linked Coretax PIC). Only the masa that had a genuine failure get
        // retried, under each remaining linked PIC in turn, stopping as soon as none are left
        // failing. processSptCombo's own existsSync-skip means a masa that partially succeeded
        // under the first PIC just picks up whatever's still missing here - no double-downloads.
        const fallbackPicIds = (opts.fallbackPicIds || []).filter((id) => id && id !== picId);
        if (!manual && !stopped && fallbackPicIds.length) {
            for (const fbPicId of fallbackPicIds) {
                const retryMmYY = failedMmYYSet();
                if (!retryMmYY.size) break;
                log('Beberapa SPT gagal terunduh sebagai PIC sebelumnya (mungkin bukan penandatangannya) - mencoba ulang ' + retryMmYY.size + ' masa sebagai PIC lain yang tertaut ke entitas ini...');
                try {
                    cred = await entitiesLib.getCredential(client, orgId, fbPicId);
                    passphrase = await entitiesLib.getPassphrase(client, orgId, fbPicId).catch(() => null);
                    ({ page } = await chrome.launchOrReuseContext(fbPicId, async (download) => {
                        try {
                            await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename()));
                            await download.delete().catch(() => {});
                        } catch (e) {}
                    }, restricted, allowedEbupotSections));
                    authState = attachApiAuthCapture(page);
                    picId = fbPicId;
                    await loginAndImpersonate();
                    runcontrol.setCoretaxAs((entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name + ' (PIC lain)');
                    loginStatus.set(picId, entity);
                    await openSptAndPrep();
                    signParam = null;
                    if (cred.username && passphrase) {
                        try { signParam = await validateSign(page, authState, cred.username, passphrase); }
                        catch (e) {
                            if (e.isSessionExpired) throw e;
                            log('Peringatan: ' + e.message + ' - lanjut tanpa tanda tangan (baris mungkin gagal digenerate).');
                        }
                    }
                } catch (e) {
                    log('Gagal masuk sebagai PIC lain (' + fbPicId + '): ' + e.message + ' - dilewati.');
                    continue;
                }
                const retryCombos = combos.filter((c) => retryMmYY.has(c.mmYY));
                let j = 0;
                while (j < retryCombos.length) {
                    const action2 = await runCombo(retryCombos[j]);
                    if (action2 === 'retry') continue;
                    else if (action2 === 'back') j = Math.max(0, j - 1);
                    else j++;
                }
            }
            const stillFailing = failedMmYYSet();
            if (stillFailing.size) log('Masih ada ' + stillFailing.size + ' masa yang gagal setelah dicoba di semua PIC tertaut - kemungkinan memang belum digenerate di Coretax.');
        }
    } catch (e) {
        if (!(e && e.isStop)) throw e;
    } finally {
        await htmlToPdf.closeRenderer().catch(() => {});
    }

    // Rincian eksplisit, bukan cuma "N kombinasi selesai" - angka itu sendirian ambigu karena
    // naik sama saja baik kombinasinya benar-benar mengunduh dokumen maupun cuma menemukan 0
    // data (SPT belum di-generate Coretax untuk masa itu) - keduanya dulu terlihat identik di
    // ringkasan akhir.
    const parts = [stats.combosDone + ' kombinasi diproses'];
    parts.push((stats.downloaded) + ' ada dokumen terunduh');
    if (stats.combosEmpty) parts.push(stats.combosEmpty + ' tidak ada data di Coretax');
    if (stats.combosSkipped) parts.push(stats.combosSkipped + ' dilewati/gagal');
    const doneMsg = (stopped ? 'DIHENTIKAN' : 'SELESAI') + ': SPT "' + entity.entity_name + '" - ' + parts.join(', ') + '.';
    log(doneMsg + ' Jendela dibiarkan terbuka.');
    showPopup(doneMsg, 'Coretax Agent', stopped ? 'Warning' : 'Information');
}

module.exports = { runSptDownload, JENIS_PAJAK, JENIS_PAJAK_LABELS, SPT_URL,
    __test: { buildSptFilename, buildLampiranViewCandidates, parseModelSptSuffix } };
