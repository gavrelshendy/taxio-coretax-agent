/* Coretax Agent - PPh 25 self-billing (Kode Billing) generation automation.
   Built API-first from day one (live reverse-engineering session, 2026-07-28, against a real
   account) - unlike SPT/e-Bupot, which shipped as click-based first and were rewritten to API
   calls only after the endpoints got discovered later, this one skips straight to direct API
   calls since the whole flow was captured live before any code was written.

   Confirmed live 2026-07-28 (TaxTypeCode 411125/TaxPaymentCode 100, individual account,
   Rp 10.000 test - real Kode Billing "042297580098657" issued and paid-status confirmed active):
     1) POST registrationportal/api/generalinformation/view {AggregateIdentifier} ->
        GeneralInformation.{Name, UniqueIdentificationNumber, MainAddress.FullAddressDetail,
        MainAddress.AreaCode}. FullAddressDetail is already the fully-resolved human-readable
        address (subdistrict/district/city/province names, not just codes) - no separate
        reference-data lookup needed. AreaCode is what the create call calls LocationCode.
     2) POST paymentportal/api/createbillingcode/get-tax-period
        {TaxpayerAggregateIdentifier, TaxTypeAndTaxPaymentCode, LanguageId} -> list of periods,
        each with its own Code field (opaque, MM+MM+YYYY-shaped but CONFIRMED not safe to
        hand-construct - always resolved by matching ParameterDataList.StartDate against the
        target month instead, same defensive style as spt.js never trusting derived IDs).
     3) POST paymentportal/api/createbillingcode/check-accounting
        {TaxpayerAggregateIdentifier, TaxTypeCode, TaxPaymentCode, TaxPeriodCode} -> pass/fail
        pre-validation the real UI also does before letting you submit. Best-effort here - not
        fatal if it errors, mirrors the flow without gating on it.
     4) POST paymentportal/api/createbillingcode {..., BillingDetails:[{TaxTypeCode,
        TaxPaymentCode, TaxPeriodCode, Nominal, ...}], LocationCode, ...} -> raw PDF bytes
        DIRECTLY in the response body (not a JSON-wrapped base64 Content field like SPT/
        e-Bupot's endpoints) - fetched as base64 from inside the page and decoded back to a
        Buffer here, see apiPostBinary.

   TWO idempotency guards run before ever creating anything (confirmed live 2026-07-28 against
   DFA's real, already-paid PPh 25 for masa 06/2026, Rp 58.327.235):
     5) checkAlreadyPaid() - POST accountingportal/api/taxpayeraccounting/list (Buku Besar),
        matched client-side by RevenueCode+PaymentCode+PeriodCode, AmountLeft<=0 = fully paid.
        This is the DEFINITIVE check: a paid period drops off activebillingcode/list entirely
        (confirmed live - DFA's paid record does not appear there), so without this check a
        paid period would look "never billed" and get a redundant new code. Must run BEFORE the
        duplicate guard below. Uses an explicit wide TransactionDate window (last year through
        next year) since Coretax's own default (omitting that filter) silently narrows to the
        last 30 days - confirmed via the Buku Besar UI's own disclaimer text.
     6) findLikelyExistingBilling() - paymentportal/api/activebillingcode/list. CORRECTED
        2026-08-14 (real user bug report - a masa 08 request with the same Nominal as an
        existing masa 07 code silently matched and returned the WRONG period's PDF under the
        requested filename): rows DO carry their own PeriodCode (confirmed live, same
        MM+MM+YYYY format resolveTaxPeriodCode produces) - the earlier "null on every
        self-billed record" claim here was wrong, or at least not universal; it may have been
        specific to records also missing LocationCode (see the guard in runBillingPph25) rather
        than a property of self-billed codes generally. Now matches on Nominal AND PeriodCode
        together. A record with a null PeriodCode (an incomplete legacy record from before the
        LocationCode fix) simply never matches as a duplicate of any real request going forward,
        rather than being trusted. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log } = require('../lib/log');
const chrome = require('../lib/chrome');
const entitiesLib = require('../lib/entities');
const runcontrol = require('../lib/runcontrol');
const { _sleep, sanitizeFilenamePart } = require('../lib/datatable');

const API_PAYMENT = 'https://coretaxdjp.pajak.go.id/paymentportal/api';
const API_REGISTRATION = 'https://coretaxdjp.pajak.go.id/registrationportal/api';
const API_ACCOUNTING = 'https://coretaxdjp.pajak.go.id/accountingportal/api';
const SELF_BILLING_URL = 'https://coretaxdjp.pajak.go.id/payment-portal/id-ID/self-billing';

// KAP-KJS per taxpayer profile - confirmed live 2026-07-28 via createbillingcode/get-taxtype-
// taxpayment's full code list. "100" is the plain "- Masa" variant for both profiles; NOT
// 411125's "-101 OP Pengusaha Tertentu" sibling, a different individual sub-category.
const TAX_TYPE_CODE = { individual: '411125', badan: '411126' };
const TAX_PAYMENT_CODE = '100';

function decodeJwtTaxpayerId(bearerToken) {
    try {
        const token = String(bearerToken || '').replace(/^Bearer\s+/i, '');
        const payloadB64 = token.split('.')[1];
        const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json).taxpayer_id || null;
    } catch (e) { return null; }
}

/** Broader than ebupot.js/spt.js's own portal-path-scoped captures - billing needs headers
 *  usable against BOTH paymentportal and registrationportal, and the bearer token is confirmed
 *  the same across Coretax's whole API surface regardless of which endpoint first fires it, so
 *  matching on host alone is simpler and equally correct. */
function attachApiAuthCapture(page) {
    const state = { authorization: null, dgtCode: null, taxpayerId: null };
    page.context().on('request', (req) => {
        if (req.url().indexOf('coretaxdjp.pajak.go.id/') === -1) return;
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

/** Same fetch-from-inside-the-page technique as spt.js/ebupot.js (string source, not fn+arg -
 *  pkg strips function source text, breaking page.evaluate(fn, arg)'s serialization). */
/** Timeout added 2026-07-30 (same fix as spt.js - see its comment there for the confirmed-live
 *  hang this fixes: no timeout meant a stalled Coretax response froze the whole run forever with
 *  zero further log output). */
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

/** Same technique, but createbillingcode answers with raw PDF bytes, not JSON. page.evaluate
 *  can't return a Buffer/ArrayBuffer directly, so the bytes are base64-encoded inside the page
 *  and decoded back to a Buffer on this side. */
/** Timeout added 2026-07-30 (same fix as spt.js/apiPost above). */
async function apiPostBinary(page, authState, url, bodyObj) {
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
        + '  if (!r.ok) { let errJson = null; try { errJson = await r.json(); } catch (e) {} return { status: r.status, errJson }; }'
        + '  const buf = await r.arrayBuffer();'
        + '  const bytes = new Uint8Array(buf);'
        + '  let binary = "";'
        + '  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);'
        + '  return { status: r.status, base64: btoa(binary) };'
        + '} catch (e) {'
        + '  return { status: 0, error: String(e) };'
        + '}'
        + '})()';
    return page.evaluate(expr);
}

/** "0626" -> "2026-06-" (a StartDate prefix match) - the period Code itself is CONFIRMED opaque
 *  and never hand-constructed; always fetch the live list and match by calendar month instead
 *  (same defensive philosophy spt.js uses for every other Coretax-assigned ID). */
function mmYYToStartDatePrefix(mmYY) {
    const mm = mmYY.slice(0, 2), yy = mmYY.slice(2);
    return '20' + yy + '-' + mm + '-';
}

async function resolveTaxPeriodCode(page, authState, taxTypeAndPaymentCode, mmYY) {
    const { status, json } = await apiPost(page, authState, API_PAYMENT + '/createbillingcode/get-tax-period', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, TaxTypeAndTaxPaymentCode: taxTypeAndPaymentCode, LanguageId: 'id-ID'
    });
    if (status !== 200 || !json || json.IsSuccessful === false) throw new Error('Gagal mengambil daftar periode: HTTP ' + status);
    const prefix = mmYYToStartDatePrefix(mmYY);
    const match = (json.Payload || []).find((r) => r.ParameterDataList && String(r.ParameterDataList.StartDate || '').indexOf(prefix) === 0);
    if (!match) throw new Error('Masa pajak ' + mmYY + ' tidak tersedia untuk pembuatan Kode Billing (mungkin sudah lewat atau belum dibuka Coretax).');
    return match.Code;
}

async function fetchGeneralInfo(page, authState) {
    const { status, json } = await apiPost(page, authState, API_REGISTRATION + '/generalinformation/view', {
        AggregateIdentifier: authState.taxpayerId
    });
    if (status !== 200 || !json || json.IsSuccessful === false || !json.Payload || !json.Payload.GeneralInformation) {
        throw new Error('Gagal mengambil data identitas wajib pajak: HTTP ' + status);
    }
    const gi = json.Payload.GeneralInformation;
    const addr = gi.MainAddress || {};
    return {
        name: gi.Name || '',
        tin: gi.UniqueIdentificationNumber || '',
        address: addr.FullAddressDetail || addr.AddressDetail || '',
        locationCode: addr.AreaCode || addr.Subdistrict || ''
    };
}

/** Duplicate guard: an active/unpaid billing code for the SAME period AND nominal already
 *  exists. See the CONFIRMED LIVE comment below for why this now checks PeriodCode too, not
 *  just Nominal. */
async function findLikelyExistingBilling(page, authState, nominal, periodCode) {
    const { status, json } = await apiPost(page, authState, API_PAYMENT + '/activebillingcode/list', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, Currency: 'IDR', First: 0, Rows: 50, SortField: '', SortOrder: 1, Filters: [], LanguageId: 'id-ID'
    });
    if (status !== 200 || !json || json.IsSuccessful === false) return null;
    const rows = (json.Payload && json.Payload.Data) || [];
    // CONFIRMED LIVE 2026-08-14: activebillingcode/list rows DO carry their own PeriodCode
    // (same MM+MM+YYYY format resolveTaxPeriodCode already produces, e.g. "07072026") - the
    // "Nominal-only, no period match available" limitation described in the module header
    // comment was never actually verified against a real response. Real bug this caused: a
    // masa 08 request with the same Nominal as an existing masa 07 code matched and silently
    // handed back the WRONG period's PDF, reported as if it were the requested one - only
    // caught because the user opened the file and found masa 07's data under a masa 08 filename.
    // Still Nominal-first (a genuinely different period will essentially never coincidentally
    // share both the exact PeriodCode AND Nominal, so this isn't loosening the match, only
    // correcting it), but now requires the period to actually match too - a same-nominal record
    // for a DIFFERENT period no longer counts as a duplicate of THIS request.
    return rows.find((r) => Number(r.Nominal) === Number(nominal) && r.PeriodCode === periodCode) || null;
}

/** Downloads the PDF of an ALREADY-EXISTING active billing code (the "Lihat" button's action
 *  in Daftar Kode Billing Aktif) - confirmed live 2026-07-28 clicking a real code. DocumentId
 *  is the record's own BillingCode (not a separate ID); AggregateIdentifier is the record's own
 *  AggregateIdentifier field - both already present on whatever findLikelyExistingBilling
 *  returned, no extra lookup needed. Same raw-PDF-bytes response shape as createbillingcode. */
async function downloadExistingBillingCode(page, authState, record) {
    const result = await apiPostBinary(page, authState, API_PAYMENT + '/activebillingcode/download', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, DocumentId: record.BillingCode, AggregateIdentifier: record.AggregateIdentifier
    });
    if (result.status !== 200 || !result.base64) {
        throw new Error('Gagal mengunduh Kode Billing yang sudah ada: HTTP ' + result.status);
    }
    return Buffer.from(result.base64, 'base64');
}

/** Checks Coretax's own general ledger (Buku Besar) for whether this KAP-KJS+period has
 *  already been fully paid - confirmed live 2026-07-28 against a real settled PPh 25 record: a
 *  fully-paid transaction shows AmountLeft: 0 (Amount is the original amount owed, AmountLeft
 *  is what's still outstanding - same shape as an invoice/AR balance). This is the definitive
 *  check the Nominal-only activebillingcode/list guard can't do: a PAID period drops off the
 *  active-codes list entirely (confirmed live - DFA's real paid PPh 25 for 06062026 does not
 *  appear there), so without this check a paid period would incorrectly look "never billed" and
 *  get a redundant new code.
 *
 *  Uses an explicit wide TransactionDate window (last year through next year) because Coretax's
 *  own default - omitting the TransactionDate filter entirely - silently narrows results to the
 *  last 30 days (confirmed via the Buku Besar UI's own disclaimer text), which would miss
 *  anything paid earlier than that relative to whenever this happens to run. */
async function checkAlreadyPaid(page, authState, taxTypeCode, taxPaymentCode, periodCode) {
    const now = new Date();
    const from = new Date(now.getFullYear() - 1, 0, 1);
    const to = new Date(now.getFullYear() + 1, 0, 1);
    const fmt = (d) => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    const { status, json } = await apiPost(page, authState, API_ACCOUNTING + '/taxpayeraccounting/list', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, First: 0, Rows: 200, SortField: 'PostingDate', SortOrder: -1,
        Filters: [
            { PropertyName: 'Amount', Value: 0, MatchMode: 'notEquals' },
            { PropertyName: 'IsCancelled', Value: 0, MatchMode: 'equals' },
            { PropertyName: 'TransactionDate', Value: [fmt(from), fmt(to)], MatchMode: 'between' }
        ],
        LanguageId: 'id-ID'
    });
    if (status !== 200 || !json || json.IsSuccessful === false) return null;
    const rows = (json.Payload && json.Payload.Data) || [];
    return rows.find((r) => r.RevenueCode === taxTypeCode && r.PaymentCode === taxPaymentCode && r.PeriodCode === periodCode && Number(r.AmountLeft) <= 0) || null;
}

function buildBillingFilename(entityCode, mmYY) {
    return sanitizeFilenamePart(entityCode) + ' - Billing PPh 25 ' + mmYY + '.pdf';
}

/** Shared by both the "create new" and "existing code found" paths - same destination/naming
 *  convention either way, since from the user's perspective the point is having the PDF
 *  locally, not whether this run happened to create it or just fetched an already-existing one. */
/** Moves rather than copies into compFolder as of 2026-07-30 (explicit user request, same
 *  change as spt.js's copyToCompliance) - once safely in the compliance folder, the
 *  CoretaxAgent-local copy is removed instead of kept alongside it. Only removes filePath after
 *  copyFileSync succeeds. The returned filePath then points at the compliance-folder location
 *  when a move happened - fine here since no caller re-reads the file after this returns (the
 *  deep-link path discards the whole result, only checking .catch()). */
function saveBillingPdf(entity, mmYY, buffer, saveRoot, compFolder) {
    const root = saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');
    const saveDir = path.join(root, entity.entity_id, 'PPh25');
    fs.mkdirSync(saveDir, { recursive: true });
    const filePath = path.join(saveDir, buildBillingFilename(entity.entity_id, mmYY));
    fs.writeFileSync(filePath, buffer);
    if (compFolder) {
        try {
            fs.mkdirSync(compFolder, { recursive: true });
            const dest = path.join(compFolder, path.basename(filePath));
            if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
            fs.copyFileSync(filePath, dest);
            fs.rmSync(filePath, { force: true });
            return dest;
        } catch (e) { log('Gagal memindahkan ke folder compliance: ' + e.message); }
    }
    return filePath;
}

/** Top-level entry point.
 *  opts: client, orgId, entity ({entity_id, entity_name, npwp, individual}), picId,
 *  masaInput ("0626"), nominal (number or formatted string, digits extracted), saveRoot
 *  (optional), manualPage (optional, manual-session mode), compFolder (optional),
 *  restricted, allowedEbupotSections, passphrase. */
async function runBillingPph25(opts) {
    const { client, orgId, entity, picId } = opts;
    const mmYY = String(opts.masaInput || '').trim();
    const nominal = Number(String(opts.nominal || '').replace(/[^\d]/g, ''));
    if (!mmYY || mmYY.length !== 4) throw new Error('Masa pajak tidak valid: ' + opts.masaInput);
    if (!nominal || nominal <= 0) throw new Error('Nilai PPh 25 belum diisi untuk entitas ini - isi dulu di Compliance > Configuration.');

    const manual = !!opts.manualPage;
    const restricted = !!opts.restricted;
    const passphrase = opts.passphrase || null;
    const allowedEbupotSections = opts.allowedEbupotSections || null;
    log('Memulai pembuatan Kode Billing PPh 25 ' + mmYY + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');

    let cred = null, page;
    if (manual) {
        page = opts.manualPage;
        if (chrome.isLoggedOut(page)) throw new Error('Sesi manual belum login ke Coretax - silakan login dulu di jendela Coretax.');
    } else {
        cred = await entitiesLib.getCredential(client, orgId, picId);
        ({ page } = await chrome.launchOrReuseContext(picId, async (download) => {
            try { await download.saveAs(path.join(os.homedir(), 'Downloads', download.suggestedFilename())); await download.delete().catch(() => {}); } catch (e) {}
        }, restricted, allowedEbupotSections));
    }
    const authState = attachApiAuthCapture(page);

    if (!manual) {
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint, restricted, passphrase, allowedEbupotSections });
    } else if (chrome.isLoggedOut(page)) {
        throw new Error('Sesi manual berakhir - silakan login ulang di jendela Coretax.');
    }

    // Navigating to the self-billing page itself guarantees at least one authenticated request
    // fires to capture headers from, regardless of whether impersonation's own navigation
    // already did (manual mode never impersonates, so it can't be relied on there at all).
    await runcontrol.checkpoint();
    await page.goto(SELF_BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const captured = await waitForAuthCaptured(authState, 20000);
    if (!captured) throw new Error('Tidak berhasil menangkap sesi API Coretax (authorization header) dari halaman.');

    const taxTypeCode = TAX_TYPE_CODE[entity.individual ? 'individual' : 'badan'];
    const taxTypeAndPaymentCode = taxTypeCode + '-' + TAX_PAYMENT_CODE;
    const taxPeriodCode = await resolveTaxPeriodCode(page, authState, taxTypeAndPaymentCode, mmYY);

    // Check 1: already paid? (Buku Besar) - this is the definitive check; a paid period drops
    // off the active-codes list entirely, so this MUST run before the Nominal-based duplicate
    // guard below, not after - otherwise a paid period would look "never billed" and get billed
    // again.
    const paid = await checkAlreadyPaid(page, authState, taxTypeCode, TAX_PAYMENT_CODE, taxPeriodCode);
    if (paid) {
        log('PPh 25 masa ' + mmYY + ' SUDAH DIBAYAR (Rp ' + Number(paid.Amount).toLocaleString('id-ID') + ', lunas di Buku Besar, ' + paid.TransactionDate + ') - dilewati, tidak membuat kode baru.');
        return { created: false, reason: 'already_paid', paidAmount: paid.Amount };
    }

    // Check 2: an active/unpaid code already exists for THIS period? Download it (the "Lihat"
    // button's own action, confirmed live) instead of just warning, so the user still ends up
    // with the PDF locally even when this run doesn't create anything new.
    const dup = await findLikelyExistingBilling(page, authState, nominal, taxPeriodCode);
    if (dup) {
        log('Kode Billing dengan nominal sama (Rp ' + nominal.toLocaleString('id-ID') + ') sudah aktif: ' + dup.BillingCode + ' (kedaluwarsa ' + dup.BillingCodeExpirationTime + ') - dilewati, mengunduh yang sudah ada.');
        const buffer = await downloadExistingBillingCode(page, authState, dup);
        const filePath = saveBillingPdf(entity, mmYY, buffer, opts.saveRoot, opts.compFolder);
        log('Kode Billing PPh 25 (sudah ada) diunduh: ' + path.basename(filePath));
        return { created: false, reason: 'duplicate', billingCode: dup.BillingCode, filePath };
    }

    await runcontrol.checkpoint();
    const info = await fetchGeneralInfo(page, authState);
    // REVERTED 2026-08-14 - the hard block added earlier today assumed an empty locationCode
    // (from registrationportal/api/generalinformation/view) meant the billing code would be
    // unpayable. Directly contradicted by the user: creating a billing code for this same
    // entity manually through Coretax's own front-end works fine with a real address - meaning
    // this endpoint likely just isn't where Coretax's own UI gets the address from either
    // (same pattern as the DocumentAggregateIdentifier issue in ebupot.js: a bulk/general API
    // not having a field some other, more specific lookup does). The original "billing from
    // automation is always invalid" report is much more plausibly explained by the wrong-period
    // duplicate-match bug fixed earlier today (findLikelyExistingBilling) than by this. Only
    // logging now, not blocking - don't want to repeat the earlier mistake of asserting Coretax
    // will reject something without having actually verified it will.
    if (!info.locationCode) {
        log('[peringatan] Kode Wilayah kosong dari generalinformation/view untuk entitas ini - membuat Kode Billing tetap, tapi field ini mungkin tidak lengkap pada hasilnya.');
    }

    // Best-effort, mirrors the real UI's own flow before letting you submit - not fatal if it
    // errors, the create call itself is still the real gate.
    await apiPost(page, authState, API_PAYMENT + '/createbillingcode/check-accounting', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, TaxTypeCode: taxTypeCode, TaxPaymentCode: TAX_PAYMENT_CODE, TaxPeriodCode: taxPeriodCode
    }).catch(() => {});

    await runcontrol.checkpoint();
    const createBody = {
        ReturnSheetIdentifier: null,
        TaxpayerAggregateIdentifier: authState.taxpayerId,
        TaxpayerTinOrNik: info.tin,
        TaxpayerName: info.name,
        TaxpayerAddress: info.address,
        Currency: 'IDR',
        BillingDetails: [{
            RecordId: null, TransactionId: null, DocumentReferenceNumber: null,
            TaxTypeCode: taxTypeCode, TaxPaymentCode: TAX_PAYMENT_CODE, TaxPeriodCode: taxPeriodCode,
            TaxObjectNumber: null, TaxObjectAddress: null, Nominal: nominal,
            TaxObjectAddressSubDistrict: null, TaxObjectAddressDistrict: null, TaxObjectAddressCity: null, TaxObjectAddressProvince: null
        }],
        LocationCode: info.locationCode,
        DepositDesc: null, DepositMonth: null, DepositYear: null, Remark: null
    };
    const result = await apiPostBinary(page, authState, API_PAYMENT + '/createbillingcode', createBody);
    if (result.status !== 200 || !result.base64) {
        const msg = (result.errJson && (result.errJson.Message || (result.errJson.Errors || []).join(', '))) || ('HTTP ' + result.status);
        throw new Error('Gagal membuat Kode Billing: ' + msg);
    }

    const filePath = saveBillingPdf(entity, mmYY, Buffer.from(result.base64, 'base64'), opts.saveRoot, opts.compFolder);
    log('Kode Billing PPh 25 dibuat: ' + path.basename(filePath));

    return { created: true, filePath };
}

module.exports = { runBillingPph25 };
