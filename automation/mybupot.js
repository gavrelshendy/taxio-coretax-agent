/* Coretax Agent - "Bukti Potong Saya" (My Withholding Slips - RECEIVED, not issued) download
   automation. Sibling to automation/ebupot.js (which handles the ISSUED side); built direct-to-
   API from the start per explicit user direction, same technique/rationale as ebupot.js's own
   header comment (auth-header capture + page.evaluate string literals for pkg's bytecode
   Function.toString() constraint).

   Live investigation 2026-07-27 (PIC Fredi Setyawan, entities PT Pesona Natasha Gemilang / PT
   Berkat Kana Abadi) found:
     - Listing endpoint: `POST withholdingslipsportal/api/GetMyWithholdingSlip`, one endpoint for
       ALL 8 types (unlike the issued side's one-endpoint-per-type), differentiated by a
       `WithholdingType` body field.
     - The 8 real type codes came from Coretax's own compiled Angular bundle's literal
       `jenisBuktiPotongOptions` array (read via an in-page fetch() of the bundle's own JS text,
       zero UI clicking) - NOT from clicking through the dropdown, which is unreliable (confirmed
       live: a click-cycling attempt kept re-selecting the same option). Two sidebar menu items
       ("Penyetoran Sendiri", "Pemotongan Secara Digunggung") that looked like extra dropdown
       options in the page's own text snapshot turned out to be unrelated sibling pages, not
       part of this dropdown at all - confirmed by both the bundle array (only 8 entries) and by
       both codes being rejected ("Invalid Request") when tried.
     - Download endpoint: the EXACT SAME `withholdingslipsportal/api/DownloadWithholdingSlips/
       download-pdf-document` endpoint ebupot.js already uses for the issued side works
       unchanged for received slips too (confirmed live, first try, real PDF back) - just pass
       the matching `EbupotType` code.
     - CRITICAL split, confirmed live by the user directly: BPMP/BP21/BPA1/BPA2 are
       employment-income slips received by the PIC as an INDIVIDUAL (their own personal
       taxpayer identity - the JWT's own `taxpayer_id`, never an impersonated company's), while
       BPPU/BPNR/BP26/BPATC are received by whichever COMPANY is impersonated, same as every
       other feature in this app. Confirmed live for BPA1 (a real row only appeared under
       Fredi's own un-impersonated login, and the real download request Coretax's own frontend
       sent used his personal `TaxpayerAggregateIdentifier`, NOT the row's own field of that
       name - see `IS_PERSONAL` below) and for BPPU (real data + a working download under PNG-
       impersonated login, using the row's OWN `TaxpayerAggregateIdentifier`, matching
       ebupot.js's existing pattern exactly). BPMP/BP21/BPA2 were not each individually
       live-verified this session - spot-check on first real use.
     - Per explicit user correction: BPPU/BPNR/BP26/BPATC *can* also be received by a PIC
       personally, not just by a company they're impersonating - this is why the module doesn't
       split into a "personal phase" and an "entity phase" (an earlier version of this file did,
       and got it backwards). Whatever identity the SELECTED ENTITY resolves to (an impersonated
       company, or - for `entity.individual===true` - the PIC's own direct login, since
       chrome.js's switchToEntity already skips real impersonation for individual entities) is
       what every selected type is fetched/downloaded under, uniformly. The GUI's own job is
       just to disable BPMP/BP21/BPA1/BPA2 when the selected entity isn't individual (they have
       no data under a company), which it does. The BPPU/BPNR/BP26/BPATC download rule (row's
       own `TaxpayerAggregateIdentifier`) was only live-confirmed under an impersonated-company
       session, not yet under a personal one - spot-check the first real personal-entity run.
     - Period filtering differs per type (mirrors ebupot.js's own BPA1-is-different finding on
       the issued side): most types filter on `TaxPeriodCode` (MM+MM+YYYY, same convention as
       every other module here), but BPA1 uses `IncomePeriodCodeEnd` instead - confirmed live
       (`TaxPeriodCode` throws an ODP-8026 SQL error - "Invalid identifier" - for BPA1, in BOTH
       an impersonated-company AND a personal-identity request, so it's genuinely the wrong
       column, not an identity problem). BPA2 threw the same SQL error for EVERY period-filter
       property name tried (TaxPeriodCode, IncomePeriodCodeEnd, IncomePeriodCodeStart) - treated
       here as having NO working server-side period filter; `fetchAllRowsNoFilter` pages through
       everything and filters client-side instead. Revisit if Coretax ever fixes this.
     - Row shape returned by the listing endpoint already carries every field the download call
       needs (RecordId, WithholdingslipsAggregateIdentifier, DocumentFormAggregateIdentifier,
       TaxpayerAggregateIdentifier, TaxIdentificationNumber, LastUpdatedDate) - no per-row detail
       view needed, same as ebupot.js. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');
const loginStatus = require('../lib/login-status');
const entitiesLib = require('../lib/entities');
const { masaToIndoLabel, parseMasaListInput } = require('../lib/masa');
const excel = require('../lib/excel');
const runcontrol = require('../lib/runcontrol');
const { _sleep, sanitizeFilenamePart } = require('../lib/datatable');

const BOOTSTRAP_URL = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/my-withholding-slips';
const API_BASE = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';

// CONFIRMED LIVE 2026-07-27 - codes read straight from Coretax's own bundle (see header). The
// `personal` flag and `periodProp` per type are the two things that differ from a naive "just
// like BPPU" copy-paste - see header comment for how each was established.
const BUKTI_TYPES = {
    bppu: { code: 'EBUPOTBPU', label: 'BPPU', personal: false, periodProp: 'TaxPeriodCode' },
    bpnr: { code: 'EBUPOTBPNR', label: 'BPNR', personal: false, periodProp: 'TaxPeriodCode' },
    bp26: { code: 'EBUPOTBP26', label: 'BP 26', personal: false, periodProp: 'TaxPeriodCode' },
    bpatc: { code: 'EBUPOTBPATC', label: 'Dokumen yang Dipersamakan', personal: false, periodProp: 'TaxPeriodCode' },
    bpmp: { code: 'EBUPOTMP', label: 'BPMP (Bulanan Pegawai Tetap)', personal: true, periodProp: 'TaxPeriodCode' },
    bp21: { code: 'EBUPOTBP21', label: 'BP 21', personal: true, periodProp: 'TaxPeriodCode' },
    bpa1: { code: 'EBUPOTBPA1', label: 'BP A1', personal: true, periodProp: 'IncomePeriodCodeEnd' },
    bpa2: { code: 'EBUPOTBPA2', label: 'BP A2', personal: true, periodProp: null } // no working server-side period filter - see header
};
const BUKTI_TYPE_LABELS = Object.fromEntries(Object.entries(BUKTI_TYPES).map(([k, v]) => [k, v.label]));

/** "0326" -> "03032026" - same MM+MM+YYYY convention confirmed for every other module here. */
function mmYYToTaxPeriodCode(mmYY) {
    const mm = mmYY.slice(0, 2);
    return mm + mm + '20' + mmYY.slice(2);
}

function decodeJwtTaxpayerId(bearerToken) {
    try {
        const token = String(bearerToken || '').replace(/^Bearer\s+/i, '');
        const payloadB64 = token.split('.')[1];
        const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json).taxpayer_id || null;
    } catch (e) { return null; }
}

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

/** Same literal-string-not-fn-arg technique as ebupot.js's apiPost - required for the packaged
 *  exe (pkg's bytecode compilation breaks Function.toString()-based serialization). */
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

/** Filename: "MMYY - JENIS - Nomor Pemotongan - NPWP Pemotong - Nama Pemotong.pdf". Emphasizes
 *  the counterpart (whoever withheld/issued this TO the PIC) since that's the varying,
 *  identifying field for RECEIVED slips - mirrors the spirit of the issued-side spec (which
 *  emphasizes the recipient instead, for the same reason) but isn't a spec the user dictated
 *  explicitly for this feature; adjust the format here if a different convention is wanted. */
function buildFilename(mmYY, jenisLabel, nomorPemotongan, npwpPemotong, namaPemotong) {
    const namaShort = sanitizeFilenamePart(namaPemotong || '').split(/\s+/).slice(0, 2).join(' ');
    const parts = [mmYY, sanitizeFilenamePart(jenisLabel), sanitizeFilenamePart(nomorPemotongan), sanitizeFilenamePart(npwpPemotong), namaShort].filter(Boolean);
    return parts.join(' - ') + '.pdf';
}

const SIZE_STEPS = [10, 25, 50, 100, 250, 500];

/** Pages through one masa/type combo's listing. `TotalRecords` reliability was never confirmed
 *  either way for this endpoint - uses the same defensive "stop when a page comes back shorter
 *  than requested" rule already proven safe for ebupot.js (whose TotalRecords WAS confirmed
 *  unreliable) rather than assume better here without evidence. */
async function fetchAllRows(page, authState, typeDef, mmYY, sizeState, emit) {
    const filters = typeDef.periodProp
        ? [{ MatchMode: 'equals', PropertyName: typeDef.periodProp, Value: mmYYToTaxPeriodCode(mmYY) }]
        : [];
    const all = [];
    let first = 0;
    for (;;) {
        await runcontrol.checkpoint();
        const override = Number(runcontrol.takePageSizeOverride());
        if (override) { sizeState.current = override; emit('Baris per pengambilan diubah manual ke ' + override + '.'); }
        runcontrol.reportPageSize(sizeState.current);
        const body = { WithholdingType: typeDef.code, TaxPeriod: '', TaxYear: '', First: first, Rows: sizeState.current, SortField: '', SortOrder: 1, Filters: filters, LanguageId: 'id-ID', TaxpayerAggregateIdentifier: authState.taxpayerId };
        const { status, json } = await apiPost(page, authState, API_BASE + '/GetMyWithholdingSlip', body);
        if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil data.'); e.isSessionExpired = true; throw e; }
        if (status !== 200 || !json || json.IsSuccessful === false) {
            throw new Error('Gagal mengambil data (' + typeDef.code + '): HTTP ' + status + (json && json.Message ? ' - ' + json.Message : ''));
        }
        let pageRows = (json.Payload && json.Payload.Data) || [];
        // BPA2 (periodProp:null) has no working server-side period filter - filter client-side
        // against whatever period-ish field the row actually carries.
        if (!typeDef.periodProp) {
            const targetCode = mmYYToTaxPeriodCode(mmYY);
            pageRows = pageRows.filter((r) => r.TaxPeriodCode === targetCode || r.IncomePeriodCodeEnd === targetCode || r.IncomePeriodCodeStart === targetCode);
        }
        all.push(...pageRows);
        const rawLen = (json.Payload && json.Payload.Data || []).length;
        if (rawLen) emit('Data diambil: ' + all.length + ' baris' + (rawLen === sizeState.current ? ' (lanjut...)' : '.'));
        if (rawLen < sizeState.current) break;
        first += sizeState.current;
    }
    return all;
}

/** Fetches one row's PDF - same endpoint ebupot.js already uses for the issued side.
 *  `TaxpayerAggregateIdentifier` differs by category (CONFIRMED LIVE, see header): the
 *  session's OWN identity for personal types, the row's own field for entity types. */
async function fetchPdfForRow(page, authState, typeDef, row) {
    const taxpayerId = typeDef.personal ? authState.taxpayerId : row.TaxpayerAggregateIdentifier;
    const body = {
        WithholdingSlipsAggregateIdentifier: row.WithholdingslipsAggregateIdentifier,
        WithholdingSlipsRecordIdentifier: row.RecordId,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier,
        TaxpayerAggregateIdentifier: taxpayerId,
        EbupotType: typeDef.code,
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        TaxIdentificationNumber: row.TaxIdentificationNumber
    };
    const { status, json } = await apiPost(page, authState, API_BASE + '/DownloadWithholdingSlips/download-pdf-document', body);
    if (status === 401) { const e = new Error('Sesi berakhir (401) saat mengambil PDF.'); e.isSessionExpired = true; throw e; }
    const data = json && json.Payload && json.Payload.Message ? json.Payload.Message.Data : null;
    if (status !== 200 || !json || json.IsSuccessful === false || !data) {
        throw new Error('Gagal mengambil PDF: HTTP ' + status + (json && json.Errors ? ' - ' + JSON.stringify(json.Errors) : (json && json.Message) || ''));
    }
    return Buffer.from(data, 'base64');
}

async function downloadComboData(ctx) {
    const { page, authState, typeKey, typeDef, saveDir, mmYY, downloadedRefs, sizeState, emit } = ctx;
    const rows = await fetchAllRows(page, authState, typeDef, mmYY, sizeState, emit);
    if (!rows.length) { emit('Tidak ada data untuk filter ini.'); return { downloadedCount: 0, rows: [] }; }
    emit('Total data: ' + rows.length + ' baris.');
    let downloadedCount = 0;
    fs.mkdirSync(saveDir, { recursive: true });
    for (let i = 0; i < rows.length; i++) {
        await runcontrol.checkpoint();
        const row = rows[i];
        const ref = row.WithholdingSlipsNumber || null;
        if (ref && downloadedRefs.has(ref)) continue;
        const filename = buildFilename(mmYY, typeDef.label, ref, row.TaxIdentificationNumber, row.Name || row.EmployerName);
        const targetPath = path.join(saveDir, filename);
        if (fs.existsSync(targetPath)) { if (ref) downloadedRefs.add(ref); continue; }
        let lastErr = null, ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            try {
                const pdfBuffer = await fetchPdfForRow(page, authState, typeDef, row);
                fs.writeFileSync(targetPath, pdfBuffer);
                ok = true;
            } catch (e) {
                if (e.isSessionExpired) throw e;
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
    return { downloadedCount, rows };
}

async function writeRingkasanExcel(rows, downloadedRefs, saveDir, typeLabel, periodLabelForFile, emit) {
    if (!rows.length) { emit('Tidak ada data untuk ringkasan Excel.'); return { total: 0, belum: 0 }; }
    const priorityColumns = ['TaxPeriodCode', 'IncomePeriodCodeStart', 'IncomePeriodCodeEnd', 'WithholdingSlipsNumber', 'TaxObjectCode', 'TaxArticle', 'TaxIdentificationNumber', 'Name', 'EmployerNik', 'EmployerName', 'WithholdingSlipsDate', 'TaxBase', 'TaxRate', 'IncomeTax', 'WithholdingSlipsStatus'];
    const allKeys = Object.keys(rows[0]);
    const ordered = priorityColumns.filter((k) => allKeys.includes(k)).concat(allKeys.filter((k) => priorityColumns.indexOf(k) === -1));
    const columns = ordered.concat(['Status Download PDF']);
    const outRows = rows.map((r) => {
        const out = {};
        for (const k of ordered) out[k] = r[k];
        const ref = r.WithholdingSlipsNumber;
        out['Status Download PDF'] = ref ? (downloadedRefs.has(ref) ? 'Sudah' : 'Belum') : 'Tidak diketahui';
        return out;
    });
    const outPath = path.join(saveDir, 'Ringkasan ' + sanitizeFilenamePart(typeLabel) + ' ' + sanitizeFilenamePart(periodLabelForFile) + '.xlsx');
    await excel.writeCombinedWorkbook(outRows, columns, outPath);
    const belum = outRows.filter((r) => r['Status Download PDF'] === 'Belum').length;
    emit('Ringkasan Excel: ' + outRows.length + ' baris (' + (outRows.length - belum) + ' sudah terunduh PDF-nya' + (belum ? ', ' + belum + ' BELUM' : ', semua cocok') + ').');
    return { total: outRows.length, belum };
}

/** Top-level entry point. `opts`:
 *   client, orgId, currentUserId, entity ({entity_id, entity_name, npwp, individual}), picId,
 *   buktiTypeKeys (array of BUKTI_TYPES keys), masaInput (string), saveRoot (optional),
 *   outputMode ('pdf_excel' default, or 'excel_only'). One login for the whole run - see the
 *   comment above `loginAndImpersonate` below for why personal- and entity-category types don't
 *   need separate login phases here (the caller/GUI is expected to only offer BPMP/BP21/BPA1/
 *   BPA2 when `entity.individual` is true, since they have no data under a company). */
async function runMyBuktiPotongDownload(opts) {
    const { client, orgId, entity, picId } = opts;
    const keys = (opts.buktiTypeKeys || []).filter((k) => BUKTI_TYPES[k]);
    if (!keys.length) throw new Error('Jenis bukti potong belum dipilih.');
    const saveRoot = opts.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');
    const pdfEnabled = opts.outputMode !== 'excel_only';
    const manual = !!opts.manualPage;
    const restricted = !!opts.restricted;
    const passphrase = opts.passphrase || null;
    const allowedEbupotSections = opts.allowedEbupotSections || null;

    log('Memulai download Bukti Potong Saya (' + keys.map((k) => BUKTI_TYPES[k].label).join(', ') + ')'
        + (manual ? ' (sesi manual)' : ' untuk entitas "' + entity.entity_name + '"') + '...');

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

    // ONE login for the whole run, no phase-splitting by type category - chrome.js's own
    // switchToEntity ALREADY skips real impersonation for `entity.individual===true` (logs in
    // directly with that identity's own credentials instead), so the resulting session's
    // authState.taxpayerId naturally IS the right "personal" identity when an individual entity
    // is selected, and the impersonated company's identity otherwise. The per-type rule in
    // fetchPdfForRow (personal types use authState.taxpayerId, entity types use the row's own
    // TaxpayerAggregateIdentifier) is what actually needs to differ - not the login flow. The
    // GUI is expected to disable BPMP/BP21/BPA1/BPA2 when a company entity is selected (they
    // have no data under a company anyway), rather than this module trying to run two identities
    // in one session.
    async function loginAndImpersonate() {
        if (manual) { if (chrome.isLoggedOut(page)) throw new Error('Sesi manual berakhir - silakan login ulang.'); return; }
        await chrome.loginAndImpersonate(page, cred, entity, picId, { checkpoint: runcontrol.checkpoint, restricted, passphrase, allowedEbupotSections });
    }
    await loginAndImpersonate();

    async function openAndPrep() {
        const NAV_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
            await runcontrol.checkpoint();
            try {
                await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                if (chrome.isLoggedOut(page)) { log('Halaman memantulkan ke login - login ulang...'); continue; }
                const captured = await waitForAuthCaptured(authState, 20000);
                if (!captured) throw new Error('Tidak berhasil menangkap sesi API Coretax.');
                return;
            } catch (e) {
                if (attempt === NAV_ATTEMPTS) throw new Error('Gagal membuka halaman Bukti Potong Saya setelah ' + NAV_ATTEMPTS + ' percobaan: ' + e.message);
                await new Promise((r) => setTimeout(r, 3000 * attempt));
            }
        }
    }

    await openAndPrep();

    const stats = { downloaded: 0, excelTotal: 0, excelBelum: 0, combosDone: 0, combosSkipped: 0 };
    let stopped = false;

    const masaList = parseMasaListInput(opts.masaInput);
    const sizeState = { current: SIZE_STEPS.includes(Number(opts.pageSize)) ? Number(opts.pageSize) : 100 };

    const combos = [];
    for (const typeKey of keys) for (const mmYY of masaList) combos.push({ typeKey, mmYY });

    async function runCombo(combo) {
        const { typeKey, mmYY } = combo;
        const typeDef = BUKTI_TYPES[typeKey];
        const comboLabel = typeDef.label + ' / ' + masaToIndoLabel(mmYY);
        const emit = (m) => log('[' + comboLabel + '] ' + m);
        try {
            // One folder per year (not per masa) - filenames already carry the masa (mmYY), see
            // buildFilename()/writeRingkasanExcel(), so nothing collides by sharing the folder.
            const saveDir = path.join(saveRoot, entity.entity_id, 'BuktiPotongSaya', typeKey, '20' + mmYY.slice(2));
            const downloadedRefs = new Set();
            let gotCount = 0, rows = [];
            for (let sessionRetries = 0; ; sessionRetries++) {
                try {
                    if (pdfEnabled) {
                        const result = await downloadComboData({ page, authState, typeKey, typeDef, saveDir, mmYY, downloadedRefs, sizeState, emit });
                        gotCount = result.downloadedCount; rows = result.rows;
                    } else {
                        rows = await fetchAllRows(page, authState, typeDef, mmYY, sizeState, emit);
                        if (rows.length) emit('Total data: ' + rows.length + ' baris.'); else emit('Tidak ada data untuk filter ini.');
                    }
                    break;
                } catch (e) {
                    if (e.isSessionExpired && sessionRetries < 3) {
                        emit('Sesi Coretax berakhir di tengah proses - login ulang...');
                        await loginAndImpersonate();
                        await openAndPrep();
                        continue;
                    }
                    throw e;
                }
            }
            fs.mkdirSync(saveDir, { recursive: true });
            const summary = await writeRingkasanExcel(rows, downloadedRefs, saveDir, typeDef.label, mmYY, emit);
            stats.downloaded += gotCount;
            stats.excelTotal += summary.total;
            stats.excelBelum += summary.belum;
            stats.combosDone++;
            return 'next';
        } catch (e) {
            if (e && e.isRetry) { emit('Diulang atas permintaan pengguna.'); return 'retry'; }
            if (e && e.isBack) { emit('Mundur atas permintaan pengguna.'); return 'back'; }
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
            emit('Dilanjutkan setelah jeda - mengulang kombinasi ini.');
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
        try {
            const coretaxAs = manual ? await chrome.getManualStatus().then((s) => s.identity).catch(() => '') : (entity.npwp ? entity.npwp + ' · ' : '') + entity.entity_name;
            runcontrol.setCoretaxAs(coretaxAs || entity.entity_name);
            if (!manual) loginStatus.set(picId, entity);
        } catch (e) {}
    } catch (e) {
        if (!(e && e.isStop)) throw e;
    }

    const doneMsg = (stopped ? 'DIHENTIKAN' : 'SELESAI') + ': Bukti Potong Saya "' + entity.entity_name + '" - '
        + (pdfEnabled ? (stats.downloaded + ' PDF terunduh, ') : '') + stats.combosDone + ' kombinasi selesai'
        + (stats.combosSkipped ? (', ' + stats.combosSkipped + ' dilewati/gagal') : '') + '.';
    log(doneMsg + ' Jendela dibiarkan terbuka.');
    showPopup(doneMsg, 'Coretax Agent', stopped ? 'Warning' : 'Information');
}

module.exports = { runMyBuktiPotongDownload, BUKTI_TYPES, BUKTI_TYPE_LABELS };
