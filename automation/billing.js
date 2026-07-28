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

   IMPORTANT LIMITATION - idempotency guard (confirmed live): paymentportal/api/
   activebillingcode/list's row shape for a self-billed (not SPT-linked) code does NOT expose
   TaxTypeCode/TaxPaymentCode/TaxPeriodCode at all (PeriodCode and ReturnSheetTypeCode were both
   null on the real test record) - there is no field on this endpoint to match a listed active
   code back to a specific KAP-KJS+period. findLikelyExistingBilling below falls back to
   matching on Nominal alone, which catches the realistic everyday risk (an accidental same-
   amount re-run for the same entity) but is NOT a period-exact guarantee - two different months
   that happen to bill the same amount would collide. Hardening this properly needs either a
   billing-detail-by-RecordId endpoint (not found yet) or cross-checking accounting-portal/
   balancesheet-light (confirmed by the user to be the correct place to check PAID status,
   filtered by TaxTypeCode + masa - not yet integrated here, left as a follow-up). */
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

/** Same technique, but createbillingcode answers with raw PDF bytes, not JSON. page.evaluate
 *  can't return a Buffer/ArrayBuffer directly, so the bytes are base64-encoded inside the page
 *  and decoded back to a Buffer on this side. */
async function apiPostBinary(page, authState, url, bodyObj) {
    const expr = '(async () => {'
        + 'try {'
        + '  const r = await fetch(' + JSON.stringify(url) + ', {'
        + '    method: "POST",'
        + '    headers: { "Content-Type": "application/json", "Authorization": ' + JSON.stringify(authState.authorization) + ', "x-dgt-code": ' + JSON.stringify(authState.dgtCode) + ' },'
        + '    credentials: "include",'
        + '    body: ' + JSON.stringify(JSON.stringify(bodyObj))
        + '  });'
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

/** Best-effort duplicate guard - see the module header comment for why this can't be an exact
 *  KAP-KJS+period match. Matches on Nominal alone: catches an accidental same-amount re-run,
 *  not a full guarantee against every possible duplicate. */
async function findLikelyExistingBilling(page, authState, nominal) {
    const { status, json } = await apiPost(page, authState, API_PAYMENT + '/activebillingcode/list', {
        TaxpayerAggregateIdentifier: authState.taxpayerId, Currency: 'IDR', First: 0, Rows: 50, SortField: '', SortOrder: 1, Filters: [], LanguageId: 'id-ID'
    });
    if (status !== 200 || !json || json.IsSuccessful === false) return null;
    const rows = (json.Payload && json.Payload.Data) || [];
    return rows.find((r) => Number(r.Nominal) === Number(nominal)) || null;
}

function buildBillingFilename(entityCode, mmYY) {
    return sanitizeFilenamePart(entityCode) + ' - Billing PPh 25 ' + mmYY + '.pdf';
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

    const dup = await findLikelyExistingBilling(page, authState, nominal);
    if (dup) {
        log('Kode Billing dengan nominal sama (Rp ' + nominal.toLocaleString('id-ID') + ') sudah aktif: ' + dup.BillingCode + ' (kedaluwarsa ' + dup.BillingCodeExpirationTime + ') - dilewati, tidak membuat kode baru.');
        return { created: false, reason: 'duplicate', billingCode: dup.BillingCode };
    }

    await runcontrol.checkpoint();
    const info = await fetchGeneralInfo(page, authState);
    const taxPeriodCode = await resolveTaxPeriodCode(page, authState, taxTypeAndPaymentCode, mmYY);

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

    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');
    const saveDir = path.join(saveRoot, entity.entity_id, 'PPh25');
    fs.mkdirSync(saveDir, { recursive: true });
    const filePath = path.join(saveDir, buildBillingFilename(entity.entity_id, mmYY));
    fs.writeFileSync(filePath, Buffer.from(result.base64, 'base64'));
    log('Kode Billing PPh 25 dibuat: ' + path.basename(filePath));

    if (opts.compFolder) {
        try {
            fs.mkdirSync(opts.compFolder, { recursive: true });
            const dest = path.join(opts.compFolder, path.basename(filePath));
            if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
            fs.copyFileSync(filePath, dest);
        } catch (e) { log('Gagal menyalin ke folder compliance: ' + e.message); }
    }

    return { created: true, filePath };
}

module.exports = { runBillingPph25 };
