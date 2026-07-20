/* Coretax Agent - automation feature #3: bulk-fill the e-Reporting Realisasi Investasi (Dividen)
   form (service AS.39-01 / FormId "FC AL_03_1_AS_39_FORM001"), which Coretax has no native import
   for. Unlike ebupot.js/spt.js (which drive PrimeNG tables click-by-click), this one INJECTS rows
   straight into the form's own draft store, because that form persists its draft in the browser's
   IndexedDB ("e-tax-database" store "autoSavedForms") and re-reads it on page load.

   Mechanism (all CONFIRMED LIVE 2026-07-19 against a real session, see the repo's dev-inspect
   findings): the running Angular app holds the form in memory and autosaves it to that IndexedDB
   record; on a fresh page load it re-populates the two grids AND the top "Kota/Kabupaten" select
   from that same record. So we: (1) read Coretax's own reference-code dictionaries from the live
   IndexedDB, (2) translate the Excel's human labels to those codes and validate every row against
   the form's own rules, (3) write the rows + City into the draft record, (4) reload so the app
   renders them. Crucially the app RE-VALIDATES injected data - the bottom "Simpan" stays disabled
   if any row is invalid or a required field is empty - so bad data physically can't be saved even
   though we bypassed the per-field modal. The real filing (Create PDF -> Sign -> Kirim) is always
   the user's own manual step afterwards; this feature only fills the draft.

   Manual-session only: the user logs into Coretax by hand, creates the AS.39-01 draft case, and
   opens its "Alur Kasus" page; we operate on that live window (chrome.getManualPage()). No
   PIC/impersonate flow (that's ebupot/spt's world). */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { log, showPopup } = require('../lib/log');
const chrome = require('../lib/chrome');

const FORM_ID = 'FC AL_03_1_AS_39_FORM001';

// Exact column order per the form's own schema (columnGrids, confirmed live) - used to map a
// scraped row's tab-separated cell values back to named fields regardless of the source Excel's
// own column order. First entry in each is the icon (edit/delete) column - always blank text.
const DIVIDEND_GRID_COLUMNS = ['', 'Pelaporan Ke-', 'Tahun Pelaporan', 'Jenis Penghasilan', 'Pemberi Penghasilan',
    'Laba Setelah Pajak (Kurs)', 'Laba Setelah Pajak (Nominal)', 'Proporsi Kepemilikan Saham',
    'Tanggal Diterima', 'Jumlah Dividen Dibagikan (Kurs)', 'Jumlah Dividen Dibagikan (Nominal)',
    'Jumlah Dividen Diinvestasikan (Kurs)', 'Jumlah Dividen Diinvestasikan (Nominal)'];
const INVESTMENT_GRID_COLUMNS = ['', 'Pelaporan Ke-', 'Tahun Pelaporan', 'Tanggal Investasi', 'Bentuk Investasi',
    'Nilai Investasi (Kurs)', 'Nilai Investasi (Nominal)'];
const CREATE_REQUEST_URL = 'https://coretaxdjp.pajak.go.id/taxpayer-services-portal/id-ID/create-administrative-service-request';
const SERVICE_TILE_TEXT = 'LA.39-01 Laporan Realisasi Investasi';

/** Automates Portal Saya -> Buat Permohonan Layanan Administrasi -> e-Pelaporan -> Laporan
 *  Realisasi Investasi -> Lanjut -> Alur Kasus, landing exactly where runDividenImport expects
 *  to be. CONFIRMED LIVE (2026-07-19) click-by-click via a manual session - this is the same
 *  sequence, just automated. Requires an already-logged-in manual page (login itself stays
 *  manual per explicit user direction - this only automates the navigation after that). */
async function openNewCase(page, emit) {
    const log_ = emit || log;
    if (chrome.isLoggedOut(page)) throw new Error('Belum login ke Coretax - login dulu di jendela yang terbuka.');

    log_('Membuka halaman "Buat Permohonan Layanan Administrasi"...');
    await page.goto(CREATE_REQUEST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (chrome.isLoggedOut(page)) throw new Error('Sesi berakhir saat membuka halaman permohonan - login ulang dulu.');

    log_('Memilih layanan "' + SERVICE_TILE_TEXT + '"...');
    let tile = page.getByText(SERVICE_TILE_TEXT, { exact: false }).first();
    let tileVisible = await tile.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!tileVisible) {
        // Fresh session: no "Jenis Pelayanan Wajib Pajak" category is pre-selected, so the right
        // panel shows nothing yet ("Silakan pilih Jenis Pelayanan Wajib Pajak..."). CONFIRMED
        // LIVE: the page has TWO "Cari" boxes - a global top-bar search ("Cari layanan...", which
        // opens an unrelated overlay and returns "Tidak ada hasil" for this) and the sidebar's OWN
        // filter (placeholder is the bare word "Cari", exact) - must target the sidebar one
        // specifically via an exact placeholder match, or the global one wins by DOM order.
        log_('Kategori belum terpilih - memfilter daftar "Jenis Pelayanan Wajib Pajak" di sidebar...');
        const sidebarSearch = page.getByPlaceholder('Cari', { exact: true }).first();
        const searchVisible = await sidebarSearch.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!searchVisible) throw new Error('Kotak pencarian sidebar "Jenis Pelayanan Wajib Pajak" tidak ditemukan.');
        await sidebarSearch.fill('e-Pelaporan').catch(() => {});
        await page.waitForTimeout(800);
        const category = page.getByText(/AS\.39\b/i).first();
        const categoryVisible = await category.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!categoryVisible) throw new Error('Kategori "AS.39" tidak ditemukan di sidebar setelah difilter "Investasi".');
        await category.click({ timeout: 5000 });
        tile = page.getByText(SERVICE_TILE_TEXT, { exact: false }).first();
        tileVisible = await tile.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    }
    if (!tileVisible) throw new Error('Layanan "' + SERVICE_TILE_TEXT + '" tidak ditemukan (sudah dicoba pilih kategori juga) - Coretax mungkin mengubah menunya.');
    await tile.click({ timeout: 5000 });

    log_('Konfirmasi ("Lanjut")...');
    const lanjut = page.getByRole('button', { name: /^Lanjut$/i }).first();
    const lanjutVisible = await lanjut.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!lanjutVisible) throw new Error('Tombol "Lanjut" tidak muncul setelah memilih layanan.');
    await lanjut.click({ timeout: 5000 });

    log_('Menunggu kasus baru dibuat...');
    await page.waitForURL(/case-overview|case-routing/i, { timeout: 30000 }).catch(() => {});
    if (chrome.isLoggedOut(page)) throw new Error('Sesi berakhir saat kasus dibuat - login ulang dulu.');

    log_('Membuka "Alur Kasus"...');
    const alurKasus = page.getByText('Alur Kasus', { exact: true }).first();
    const alurVisible = await alurKasus.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!alurVisible) throw new Error('Menu "Alur Kasus" tidak ditemukan - kasus mungkin belum selesai dibuat.');
    await alurKasus.click({ timeout: 5000 });

    // Wait for the form iframe itself (case-components-portal/.../form-render) to attach - that's
    // the concrete signal the Dividen import can now find its draft record, not just "some page
    // navigated". A generous timeout: this iframe's own bootstrap (schema + reference data
    // fetches) is the slowest part of the whole sequence.
    const formFrame = await page.waitForEvent('framenavigated', {
        predicate: (f) => /case-components-portal\/.+\/form-render\//i.test(f.url()),
        timeout: 20000
    }).catch(() => null);
    if (!formFrame) {
        // Fall back to polling page.frames() - framenavigated can fire before this call attaches
        // its listener if the iframe was already mid-navigation.
        const deadline = Date.now() + 15000;
        let found = false;
        while (Date.now() < deadline) {
            if (page.frames().some((f) => /case-components-portal\/.+\/form-render\//i.test(f.url()))) { found = true; break; }
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!found) throw new Error('Form e-Reporting tidak termuat setelah membuka Alur Kasus.');
    }

    // The iframe attaching only means its OWN document started loading - Coretax's Angular app
    // inside it still needs to fetch its schema/reference data and only THEN creates this case's
    // own record in IndexedDB "autoSavedForms" (CONFIRMED LIVE: importing immediately after the
    // iframe attached failed with "draft form belum ada" - the record genuinely didn't exist yet,
    // this isn't just a rendering delay). So wait for THAT record specifically, keyed by this
    // case's own aggregateId, before calling the case ready - the same signal runDividenImport
    // itself needs to succeed.
    const aggregateId = extractAggregateId(page.url());

    // Actively trigger Angular's initial autosave write instead of passively waiting on its own
    // timer (which can take up to ~1 min): opening (then closing) the "Tambah Data" modal forces
    // the form component to instantiate, which appears to be what makes it persist its initial
    // state. Best-effort - if the button isn't found yet, the patient poll below still catches it.
    log_('Memicu draft awal (buka lalu tutup "Tambah Data")...');
    const tambahData = page.getByText('Tambah Data', { exact: true }).first();
    const tambahVisible = await tambahData.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (tambahVisible) {
        await tambahData.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
    }

    log_('Menunggu draft form-nya siap (bisa sampai ~1 menit untuk kasus baru)...');
    // CONFIRMED LIVE: a brand-new case's autoSavedForms record is created by Coretax's own
    // Angular app asynchronously, well after the form visibly renders - 30s wasn't always enough,
    // ~1 min reliably was. Patient timeout, not a sign anything's wrong; log a nudge partway
    // through so a long wait doesn't look stuck.
    const nudgeAt = Date.now() + 20000;
    let nudged = false;
    const result = await waitForDraftRecord(page, aggregateId, 90000, () => {
        if (!nudged && Date.now() > nudgeAt) { nudged = true; log_('Masih menunggu draft-nya siap (normal untuk kasus baru, mohon tunggu)...'); }
    });
    if (!result.found) {
        throw new Error('Draft form belum siap setelah 90 detik (dicari: ' + aggregateId + ', ditemukan di IndexedDB: ['
            + (result.seen || []).join(', ') + ']) - coba lagi, atau buka "Alur Kasus" ulang secara manual.');
    }
    log_('Kasus baru siap di halaman Alur Kasus.');
}

/** Polls IndexedDB "e-tax-database"/"autoSavedForms" until a record for `aggregateId` exists.
 *  Returns {found, seen} - `seen` is the last poll's list of aggregateIdentifiers actually
 *  present, kept even on failure so a caller can log it for debugging a mismatch. */
async function waitForDraftRecord(page, aggregateId, timeoutMs, onTick) {
    const code = `(async () => {
        const AGG = ${JSON.stringify(aggregateId)};
        try {
            const open = indexedDB.open('e-tax-database');
            const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
            if (!Array.from(db.objectStoreNames).includes('autoSavedForms')) return { found:false, seen:['(no autoSavedForms store)'] };
            const all = await new Promise((res) => { const r = db.transaction('autoSavedForms','readonly').objectStore('autoSavedForms').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
            return { found: all.some((x) => x.aggregateIdentifier === AGG), seen: all.map((x) => x.aggregateIdentifier + ' (formId=' + x.formId + ')') };
        } catch (e) { return { found:false, seen:['(error: ' + e.message + ')'] }; }
    })()`;
    const deadline = Date.now() + timeoutMs;
    let last = { found: false, seen: [] };
    while (Date.now() < deadline) {
        last = await page.evaluate(code).catch((e) => ({ found: false, seen: ['(evaluate threw: ' + e.message + ')'] }));
        if (last.found) return last;
        if (onTick) onTick();
        await new Promise((r) => setTimeout(r, 700));
    }
    return last;
}

// --- small cell/value helpers ----------------------------------------------------------------
function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
        if (v instanceof Date) return v;
        if ('text' in v) return v.text;
        if ('result' in v) return v.result;
        if ('richText' in v) return v.richText.map((r) => r.text).join('');
        return String(v);
    }
    return v;
}
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Accepts an exceljs Date cell OR a string ("YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY",
 *  "YYYY/MM/DD") and returns canonical "YYYY-MM-DD", or null if unparseable. */
function toISODate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
        const y = v.getUTCFullYear(), m = String(v.getUTCMonth() + 1).padStart(2, '0'), d = String(v.getUTCDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    m = /^(\d{4})[/](\d{1,2})[/](\d{1,2})$/.exec(s);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return null;
}

/** Number from a numeric cell or a string. Rejects blanks. Tolerates a decimal comma
 *  ("1234,5") but NOT thousand separators (the template tells users not to use them). */
function toNumber(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(/\s/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return NaN; // looks like "1.234.567" thousand-sep -> reject
    return Number(s.replace(',', '.'));
}

// --- read a sheet as [{header: value}] using row 1 as headers --------------------------------
function readSheetObjects(sheet) {
    if (!sheet) return [];
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = norm(cellText(cell.value)); });
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {}; let has = false;
        row.eachCell({ includeEmpty: true }, (cell, col) => {
            const key = headers[col]; if (!key) return;
            const val = cellText(cell.value);
            obj[key] = val;
            if (val !== '' && val != null) has = true;
        });
        if (has) rows.push({ _row: rowNumber, ...obj });
    });
    return rows;
}
/** First header key that CONTAINS every token in `tokens` (already normalized). */
function pick(obj, tokens) {
    for (const k of Object.keys(obj)) { if (tokens.every((t) => k.indexOf(t) !== -1)) return obj[k]; }
    return undefined;
}

// --- parse the whole template buffer ---------------------------------------------------------
async function parseTemplate(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const getSheet = (re) => wb.worksheets.find((s) => re.test(s.name)) || null;

    // Info Umum: a two-column key/value sheet; find the Kota/Kabupaten value.
    let city = '';
    const infoSheet = getSheet(/info/i);
    if (infoSheet) {
        infoSheet.eachRow((row) => {
            const k = norm(cellText(row.getCell(1).value));
            if (k.indexOf('kota') !== -1 || k.indexOf('kabupaten') !== -1) city = String(cellText(row.getCell(2).value) || '').trim();
        });
    }

    const dividen = readSheetObjects(getSheet(/dividen/i)).map((o) => ({
        _row: o._row,
        pelaporan: pick(o, ['pelaporan']),
        tahun: pick(o, ['tahun']),
        jenis: pick(o, ['jenis']),
        pemberi: pick(o, ['pemberi']),
        tanggal: pick(o, ['tanggal']),
        kursBagi: pick(o, ['kurs', 'dibagikan']),
        nomBagi: pick(o, ['nominal', 'dibagikan']),
        kursInv: pick(o, ['kurs', 'diinvestasikan']),
        nomInv: pick(o, ['nominal', 'diinvestasikan']),
        kursLaba: pick(o, ['kurs', 'laba']),
        nomLaba: pick(o, ['nominal', 'laba']),
        proporsi: pick(o, ['proporsi']),
    }));

    const investasi = readSheetObjects(getSheet(/investasi/i)).map((o) => ({
        _row: o._row,
        pelaporan: pick(o, ['pelaporan']),
        tahun: pick(o, ['tahun']),
        tanggal: pick(o, ['tanggal']),
        bentuk: pick(o, ['bentuk']),
        kurs: pick(o, ['kurs']),
        nominal: pick(o, ['nominal']),
    }));

    return { city, dividen, investasi };
}

// --- read Coretax's own reference-code dictionaries from the live IndexedDB ------------------
// Returns { income, currency, form, city } each a { normalizedLabel: CODE } map, plus
// fullYearPeriods (a { code: true } set of "0112YYYY" period codes actually offered).
async function readRefMaps(page) {
    const code = `(async () => {
        const open = indexedDB.open('e-tax-database');
        const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
        if (!Array.from(db.objectStoreNames).includes('referenceDataStore')) return null;
        const tx = db.transaction('referenceDataStore', 'readonly');
        const all = await new Promise((res) => { const r = tx.objectStore('referenceDataStore').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
        const nrm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
        const byType = (t) => { const x = all.find((a) => a.ReferenceDataType === t); return x && x.Details || []; };
        const mapByDesc = (t) => { const o = {}; byType(t).forEach((d) => { if (d.CodeDescription) o[nrm(d.CodeDescription)] = d.Code; }); return o; };
        const mapByName = (t) => { const o = {}; byType(t).forEach((d) => { if (d.CodeName) o[nrm(d.CodeName)] = d.Code; }); return o; };
        const fy = {}; byType('PERIOD').forEach((d) => { if (String(d.Code).slice(0, 4) === '0112') fy[d.Code] = true; });
        return { income: mapByDesc('E-REPORTING_INCOME_TYPE'), currency: mapByName('CURRENCY'), form: mapByName('E-REPORTING_FORM_OF_INVESTMENT'), city: mapByName('CITY'), fullYearPeriods: fy };
    })()`;
    return page.evaluate(code);
}

// --- translate + validate --------------------------------------------------------------------
function resolvePeriod(label, maps, errors, where) {
    const s = String(label == null ? '' : label);
    const y = /(\d{4})/.exec(s);
    if (!y) { errors.push(where + ': "Dividen atas Tahun" tidak dikenali (contoh benar: "Januari - Desember 2025").'); return null; }
    const codeGuess = '0112' + y[1];
    if (maps.fullYearPeriods && Object.keys(maps.fullYearPeriods).length && !maps.fullYearPeriods[codeGuess]) {
        errors.push(where + ': periode "' + s + '" (tahun ' + y[1] + ') tidak tersedia di daftar Coretax.'); return null;
    }
    return codeGuess;
}
function resolveCode(map, label, kind, errors, where) {
    if (label == null || String(label).trim() === '') { errors.push(where + ': ' + kind + ' wajib diisi.'); return null; }
    const code = map[norm(label)];
    if (!code) { errors.push(where + ': ' + kind + ' "' + String(label).trim() + '" tidak ada di daftar Coretax (cek sheet Referensi).'); return null; }
    return code;
}
function reqInt13(v, errors, where, field) {
    const n = toNumber(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3) { errors.push(where + ': "' + field + '" harus 1, 2, atau 3.'); return null; }
    return n;
}
function reqAmount(v, errors, where, field) {
    const n = toNumber(v);
    if (!Number.isFinite(n) || n < 1) { errors.push(where + ': "' + field + '" harus angka minimal 1.'); return null; }
    return n;
}
function reqDate(v, errors, where, field) {
    const d = toISODate(v);
    if (!d) { errors.push(where + ': "' + field + '" bukan tanggal yang valid (pakai format YYYY-MM-DD).'); return null; }
    return d;
}

function buildRows(parsed, maps) {
    const errors = [];
    const cityCode = resolveCode(maps.city, parsed.city, 'Kota/Kabupaten (sheet Info Umum)', errors, 'Info Umum');

    const dividend = parsed.dividen.map((r) => {
        const where = 'Dividen baris ' + r._row;
        const row = {
            Period1: reqInt13(r.pelaporan, errors, where, 'Pelaporan Ke-'),
            DividendOrOtherIncomeReportsAction: null,
            FiscalYear1: resolvePeriod(r.tahun, maps, errors, where),
            IncomeType: resolveCode(maps.income, r.jenis, 'Jenis Penghasilan', errors, where),
            IncomeProvider: (r.pemberi == null || String(r.pemberi).trim() === '') ? (errors.push(where + ': "Pemberi Penghasilan" wajib diisi.'), null) : String(r.pemberi).trim(),
            CurrencyNi: null, AmountNi: null, ProportionShareholding: null,
            DateOfAcquisition: reqDate(r.tanggal, errors, where, 'Tanggal Diterima'),
            CurrencyDividendDistributed: resolveCode(maps.currency, r.kursBagi, 'Kurs Dividen Dibagikan', errors, where),
            AmountDividendDistributed: reqAmount(r.nomBagi, errors, where, 'Nominal Dividen Dibagikan'),
            CurrencyDividendInvested: resolveCode(maps.currency, r.kursInv, 'Kurs Dividen Diinvestasikan', errors, where),
            AmountDividendInvested: reqAmount(r.nomInv, errors, where, 'Nominal Dividen Diinvestasikan'),
        };
        // Optional LN (Dividen Luar Negeri) fields - only validate when the user filled them.
        if (r.kursLaba != null && String(r.kursLaba).trim() !== '') row.CurrencyNi = resolveCode(maps.currency, r.kursLaba, 'Laba Setelah Pajak (Kurs)', errors, where);
        if (r.nomLaba != null && String(r.nomLaba).trim() !== '') row.AmountNi = reqAmount(r.nomLaba, errors, where, 'Laba Setelah Pajak (Nominal)');
        if (r.proporsi != null && String(r.proporsi).trim() !== '') {
            const p = toNumber(r.proporsi);
            if (!Number.isFinite(p) || p < 0 || p > 100) errors.push(where + ': "Proporsi Kepemilikan Saham (%)" harus 0-100.');
            else row.ProportionShareholding = p;
        }
        return row;
    });

    const investment = parsed.investasi.map((r) => {
        const where = 'Investasi baris ' + r._row;
        return {
            Period2: reqInt13(r.pelaporan, errors, where, 'Pelaporan Ke-'),
            InvestmentReportsAction: null,
            FiscalYear2: resolvePeriod(r.tahun, maps, errors, where),
            DateInvestment: reqDate(r.tanggal, errors, where, 'Tanggal Investasi'),
            FormInvestment: resolveCode(maps.form, r.bentuk, 'Bentuk Investasi', errors, where),
            CurrencyInvestment: resolveCode(maps.currency, r.kurs, 'Kurs Nilai Investasi', errors, where),
            AmountInvestment: reqAmount(r.nominal, errors, where, 'Nominal Nilai Investasi'),
        };
    });

    if (!dividend.length && !investment.length) errors.push('Tidak ada baris data di sheet Dividen maupun Investasi.');
    return { cityCode, dividend, investment, errors };
}

// --- inject into the draft record + reload ---------------------------------------------------
function extractAggregateId(url) {
    const m = /(?:case-routing|case-overview|form-render)\/([0-9a-f-]{36})/i.exec(url || '');
    return m ? m[1] : null;
}

async function injectAndReload(page, aggregateId, payload) {
    const code = `(async () => {
        const AGG = ${JSON.stringify(aggregateId)};
        const P = ${JSON.stringify(payload)};
        const open = indexedDB.open('e-tax-database');
        const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
        const s = 'autoSavedForms';
        if (!Array.from(db.objectStoreNames).includes(s)) return { ok:false, reason:'no-store' };
        const all = await new Promise((res) => { const r = db.transaction(s,'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
        let rec = all.find((x) => x.aggregateIdentifier === AGG) || (all.length === 1 ? all[0] : null);
        if (!rec) return { ok:false, reason:'no-record', count: all.length };
        rec.data = rec.data || {};
        rec.data.City = P.cityCode;
        rec.data.DividendOrOtherIncomeReports = P.dividend;
        rec.data.InvestmentReports = P.investment;
        await new Promise((res, rej) => { const r = db.transaction(s,'readwrite').objectStore(s).put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
        return { ok:true, div: P.dividend.length, inv: P.investment.length };
    })()`;
    const result = await page.evaluate(code);
    if (result && result.ok) {
        // Reload immediately, before any interaction can trigger the app's autosave to clobber
        // our write - the whole reliability trick. Reloads the top case page so the form iframe
        // re-reads the draft from IndexedDB on a fresh load.
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    return result;
}

/** Top-level entry point. `opts`: { manualPage, fileBuffer }. */
async function runDividenImport(opts) {
    const page = opts.manualPage;
    if (!page) throw new Error('Sesi manual belum ada - klik "Login Coretax" dan login dulu.');
    if (page.isClosed && page.isClosed()) throw new Error('Jendela Coretax sudah tertutup.');

    const url = page.url();
    if (url.indexOf('coretaxdjp.pajak.go.id') === -1) throw new Error('Jendela Coretax tidak berada di situs Coretax. Buka kasus e-Reporting dulu.');
    const aggregateId = extractAggregateId(url);
    if (!aggregateId) throw new Error('Buka halaman "Alur Kasus" pada kasus e-Reporting Realisasi Investasi dulu (URL kasus belum terbaca).');

    log('Membaca file template...');
    const parsed = await parseTemplate(opts.fileBuffer);
    log('Template dibaca: ' + parsed.dividen.length + ' baris dividen, ' + parsed.investasi.length + ' baris investasi, kota "' + (parsed.city || '(kosong)') + '".');

    log('Membaca daftar kode referensi dari sesi Coretax...');
    const maps = await readRefMaps(page);
    if (!maps) throw new Error('Data referensi Coretax belum termuat - buka halaman "Alur Kasus" kasus ini dulu, tunggu tabel muncul, lalu coba lagi.');

    const { cityCode, dividend, investment, errors } = buildRows(parsed, maps);
    if (errors.length) {
        log('IMPOR DIBATALKAN - ada ' + errors.length + ' masalah pada data (tidak ada yang dikirim):');
        errors.slice(0, 40).forEach((e) => log('  • ' + e));
        if (errors.length > 40) log('  • ...dan ' + (errors.length - 40) + ' lagi.');
        showPopup('Impor dibatalkan: ' + errors.length + ' baris/isian tidak valid. Lihat log & perbaiki file Excel.', 'Coretax Agent', 'Warning');
        throw Object.assign(new Error('Validasi gagal'), { validation: true });
    }

    log('Semua ' + (dividend.length + investment.length) + ' baris valid. Memasukkan ke draft Coretax...');
    const result = await injectAndReload(page, aggregateId, { cityCode, dividend, investment });
    if (!result || !result.ok) {
        const why = result && result.reason === 'no-record'
            ? 'draft form belum ada di jendela ini - pastikan halaman "Alur Kasus" kasus e-Reporting sudah terbuka.'
            : (result && result.reason === 'no-store' ? 'penyimpanan draft Coretax tidak ditemukan.' : 'alasan tidak diketahui.');
        throw new Error('Gagal memasukkan data: ' + why);
    }

    log('Data masuk ke draft (' + result.div + ' baris dividen + ' + result.inv + ' baris investasi) - menunggu halaman selesai dimuat ulang...');
    const saveOutcome = await trySaveDraft(page);
    let doneMsg;
    if (saveOutcome === 'saved') {
        doneMsg = 'SELESAI: ' + result.div + ' baris dividen + ' + result.inv + ' baris investasi dimasukkan DAN TERSIMPAN ke draft Coretax.';
        log(doneMsg + ' Silakan PERIKSA di jendela Coretax, lalu lanjutkan Create PDF → Sign → Kirim sendiri.');
    } else {
        doneMsg = 'SELESAI: ' + result.div + ' baris dividen + ' + result.inv + ' baris investasi dimasukkan ke draft (belum tersimpan otomatis).';
        log(doneMsg + ' Silakan PERIKSA di jendela Coretax, lalu klik Simpan sendiri → Create PDF → Sign → Kirim.');
        log('Catatan: kalau tombol "Simpan" masih abu-abu, berarti masih ada isian wajib yang kosong/keliru (mis. Kota/Kabupaten) - Coretax memvalidasi ulang data yang dimasukkan.');
    }

    // Always produce the crosscheck/control file - a genuine independent verification (scrapes
    // the LIVE rendered grid, not our own in-memory copy) rather than just trusting the injection
    // reported success. Best-effort: a scrape failure never undoes a successful import.
    let controlPath = null;
    try {
        log('Membuat file pembanding (crosscheck) hasil impor...');
        const scraped = await scrapeLiveGrids(page);
        controlPath = controlFileOutPath('Hasil Impor Dividen');
        await writeControlFile(parsed, scraped, controlPath);
        log('File pembanding tersimpan: ' + controlPath);
    } catch (e) {
        log('Gagal membuat file pembanding (impor tetap berhasil): ' + e.message);
    }

    showPopup(doneMsg + (saveOutcome === 'saved' ? '\nLanjutkan Sign/Kirim sendiri di Coretax.' : '\nPeriksa dulu, lalu Simpan/Kirim sendiri di Coretax.')
        + (controlPath ? ('\nFile pembanding: ' + controlPath) : ''), 'Coretax Agent', 'Information');
}

/** Best-effort: after the post-injection reload settles, click the form's own "Simpan" button
 *  IF it's enabled (Coretax disables it while any required field is invalid/empty - the same
 *  re-validation guarantee that makes injection safe, see the file header). Returns 'saved' |
 *  'disabled' (still greyed out after the full timeout - some field still needs attention) |
 *  'not-found' (button never appeared at all). Never throws - a failure here just means the user
 *  does this one click themselves, nothing is lost.
 *
 *  CONFIRMED LIVE at 800 rows: Coretax's own client-side re-validation of a large row count is
 *  not instant - the button can sit disabled for several seconds after the page settles before
 *  flipping to enabled. So this must keep polling on "disabled", not treat the first sighting of
 *  it as final - only 'not-found' (button never rendered) is unrecoverable within the timeout. */
async function trySaveDraft(page) {
    const deadline = Date.now() + 45000;
    let sawButton = false;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            const btn = frame.locator('button.btn-primary', { hasText: 'Simpan' }).first();
            const count = await btn.count().catch(() => 0);
            if (!count) continue;
            sawButton = true;
            const disabled = await btn.isDisabled().catch(() => true);
            if (disabled) break; // keep polling - may still be mid-validation
            await btn.click({ timeout: 5000 }).catch(() => {});
            return 'saved';
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return sawButton ? 'disabled' : 'not-found';
}

// --- crosscheck: scrape the LIVE rendered grids (ground truth, independent of anything we wrote
// ourselves) and compare against the source Excel, for a genuine post-import control file -------

/** Finds the Nth `.p-datatable` (0 = Dividen, 1 = Investasi) across every frame (the form lives
 *  in an iframe). Returns {frame, grid} or null. */
async function findGrid(page, gridIndex) {
    for (const frame of page.frames()) {
        const grid = frame.locator('.p-datatable').nth(gridIndex);
        const count = await grid.count().catch(() => 0);
        if (!count) continue;
        const visible = await grid.isVisible().catch(() => false);
        if (visible) return { frame, grid };
    }
    return null;
}

/** Scrapes every row of one grid across all its pages, as raw tab-separated cell arrays (a
 *  browser inserts a real tab between adjacent <td> cells' innerText - CONFIRMED LIVE reliable
 *  for these PrimeNG tables). Bumps this grid's OWN paginator to its largest page size first
 *  (best-effort) to minimize page turns. Returns an array of string arrays (one per row). */
async function scrapeGridRows(grid) {
    // Best-effort: open this grid's own paginator size dropdown and pick the largest option.
    try {
        const paginator = grid.locator('.p-paginator').first();
        const dropdown = paginator.locator('.p-dropdown, .p-paginator-rpp-options').first();
        if (await dropdown.isVisible({ timeout: 1500 }).catch(() => false)) {
            await dropdown.click({ timeout: 2000, force: true }).catch(() => {});
            const panel = grid.page().locator('.p-dropdown-panel, .p-dropdown-items').first();
            await panel.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
            const options = panel.locator('.p-dropdown-item, li');
            const n = await options.count().catch(() => 0);
            if (n) { await options.nth(n - 1).click({ timeout: 2000, force: true }).catch(() => {}); await grid.page().waitForTimeout(600); }
            else await grid.page().keyboard.press('Escape').catch(() => {});
        }
    } catch (e) { /* not fatal - just paginate at whatever size it already is */ }

    const rows = [];
    for (let guard = 0; guard < 200; guard++) { // hard ceiling so a stuck paginator can't loop forever
        const trs = grid.locator('tbody > tr');
        const n = await trs.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
            const text = await trs.nth(i).innerText().catch(() => '');
            if (/tidak ada data/i.test(text)) continue;
            rows.push(text.split('\t'));
        }
        const nextBtn = grid.locator('.p-paginator-next').last();
        const hasNext = await nextBtn.count().catch(() => 0);
        if (!hasNext) break;
        const disabledAttr = await nextBtn.getAttribute('disabled').catch(() => 'true');
        const cls = await nextBtn.getAttribute('class').catch(() => '');
        if (disabledAttr !== null || /(^|\s)p-disabled(\s|$)/.test(cls || '')) break;
        await nextBtn.click({ timeout: 3000, force: true, noWaitAfter: true }).catch(() => {});
        await grid.page().waitForTimeout(500);
    }
    return rows;
}

/** Maps scraped tab-separated rows to named objects using `columns` (see DIVIDEND_GRID_COLUMNS/
 *  INVESTMENT_GRID_COLUMNS) - positional, since the grid's own column order is fixed by its
 *  schema regardless of the source Excel's column order. */
function namedRowsFromScrape(rawRows, columns) {
    return rawRows.map((cells) => {
        const obj = {};
        columns.forEach((name, i) => { if (name) obj[name] = (cells[i] || '').trim(); });
        return obj;
    });
}

/** Scrapes both live grids and returns {dividend: [...], investment: [...]} as named-column
 *  objects - the independent "what Coretax is actually showing right now" ground truth. */
async function scrapeLiveGrids(page) {
    const divGrid = await findGrid(page, 0);
    const invGrid = await findGrid(page, 1);
    const dividend = divGrid ? namedRowsFromScrape(await scrapeGridRows(divGrid.grid), DIVIDEND_GRID_COLUMNS) : [];
    const investment = invGrid ? namedRowsFromScrape(await scrapeGridRows(invGrid.grid), INVESTMENT_GRID_COLUMNS) : [];
    return { dividend, investment };
}

/** Builds the control/crosscheck .xlsx: raw source Excel rows, raw live-scraped Coretax rows,
 *  and a row-by-row "Ringkasan Perbandingan" (matched by POSITION - injection preserves array
 *  order, confirmed live) flagging any field that doesn't match. `sourceParsed` is parseTemplate's
 *  output (human-readable, pre-code-translation - the natural thing to eyeball against). */
async function writeControlFile(sourceParsed, scraped, outPath) {
    const wb = new ExcelJS.Workbook();

    const addRaw = (name, rows, cols) => {
        const sheet = wb.addWorksheet(name);
        if (!rows.length) { sheet.addRow(['(tidak ada baris)']); return; }
        const headers = Object.keys(rows[0]);
        sheet.addRow(headers);
        sheet.getRow(1).font = { bold: true };
        rows.forEach((r) => sheet.addRow(headers.map((h) => r[h])));
    };
    addRaw('Dividen (Sumber Excel)', sourceParsed.dividen);
    addRaw('Investasi (Sumber Excel)', sourceParsed.investasi);
    addRaw('Dividen (Coretax - Live)', scraped.dividend);
    addRaw('Investasi (Coretax - Live)', scraped.investment);

    const summary = wb.addWorksheet('Ringkasan Perbandingan');
    summary.addRow(['Tabel', 'Baris Excel', 'Baris di Coretax', 'Status']);
    summary.getRow(1).font = { bold: true };
    const divStatus = sourceParsed.dividen.length === scraped.dividend.length ? 'COCOK (jumlah sama)' : 'BEDA JUMLAH - PERIKSA';
    const invStatus = sourceParsed.investasi.length === scraped.investment.length ? 'COCOK (jumlah sama)' : 'BEDA JUMLAH - PERIKSA';
    summary.addRow(['Dividen', sourceParsed.dividen.length, scraped.dividend.length, divStatus]);
    summary.addRow(['Investasi', sourceParsed.investasi.length, scraped.investment.length, invStatus]);
    summary.addRow([]);
    const detailHeaderRow = summary.addRow(['Detail per baris (Dividen) - pembanding kunci: Pemberi Penghasilan + Nominal Dibagikan']);
    detailHeaderRow.font = { bold: true };
    summary.addRow(['#', 'Pemberi (Excel)', 'Pemberi (Coretax)', 'Nominal (Excel)', 'Nominal (Coretax)', 'Cocok?']);
    for (let i = 0; i < Math.max(sourceParsed.dividen.length, scraped.dividend.length); i++) {
        const s = sourceParsed.dividen[i] || {};
        const c = scraped.dividend[i] || {};
        const sProv = String(s.pemberi || '').trim();
        const cProv = String(c['Pemberi Penghasilan'] || '').trim();
        const sAmt = String(s.nomBagi != null ? s.nomBagi : '').trim();
        const cAmt = String(c['Jumlah Dividen Dibagikan (Nominal)'] || '').replace(/[.,]/g, '').trim();
        const match = sProv === cProv && (!sAmt || sAmt.replace(/[.,]/g, '') === cAmt);
        summary.addRow([i + 1, sProv, cProv, sAmt, c['Jumlah Dividen Dibagikan (Nominal)'] || '', match ? 'Ya' : 'CEK MANUAL']);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await wb.xlsx.writeFile(outPath);
    return outPath;
}

function controlFileOutPath(prefix) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(os.homedir(), 'Downloads', 'CoretaxAgent', 'Dividen', prefix + ' ' + ts + '.xlsx');
}

/** Standalone "Cek Hasil" action: reads a source Excel (same template shape) and the CURRENT
 *  live grids on whatever case is open, writes a control file, does NOT touch the draft at all
 *  (read-only) - safe to run anytime, doesn't require this to be right after an import. */
async function runDividenCheck(opts) {
    const page = opts.manualPage;
    if (!page) throw new Error('Sesi manual belum ada - klik "Login Coretax" dan login dulu.');
    const url = page.url();
    if (url.indexOf('coretaxdjp.pajak.go.id') === -1) throw new Error('Jendela Coretax tidak berada di situs Coretax.');

    log('Cek Hasil: membaca file pembanding...');
    const parsed = await parseTemplate(opts.fileBuffer);
    log('Cek Hasil: membaca tabel LANGSUNG dari Coretax (bisa beberapa detik untuk banyak baris)...');
    const scraped = await scrapeLiveGrids(page);
    log('Cek Hasil: Excel = ' + parsed.dividen.length + ' dividen/' + parsed.investasi.length + ' investasi | Coretax = ' + scraped.dividend.length + ' dividen/' + scraped.investment.length + ' investasi.');

    const outPath = controlFileOutPath('Cek Hasil Dividen');
    await writeControlFile(parsed, scraped, outPath);
    log('Cek Hasil selesai. File pembanding: ' + outPath);
    showPopup('Cek Hasil selesai.\nFile: ' + outPath, 'Coretax Agent', 'Information');
    return outPath;
}

module.exports = { runDividenImport, runDividenCheck, openNewCase, FORM_ID };
// Internal helpers exposed only for offline unit testing (dev-test-dividen.js) - harmless to ship.
module.exports.__test = { parseTemplate, buildRows, toISODate, toNumber, scrapeLiveGrids, writeControlFile };
