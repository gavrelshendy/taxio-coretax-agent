/* Cari, ubah (pembetulan) dan batalkan bukti potong e-Bupot Telah Terbit lewat API Coretax - SEMUA jenis: BPMP, BP21,
 * BP26, BPA1, BPA2, BPPU, BPNR, SP, CY. Dipakai MCP (mcp/taxio-pilot-mcp.js) lewat gui/server.js.
 *
 * Pemetaan per jenis diambil dari aplikasi Coretax sendiri (bundle withholding-slips-portal, 2026-11-11): fungsi submit()
 * tiap formulir menyusun body kiriman dari isian formulir (= detail /viewebupot<jenis>), lalu
 *  - BPMP, SP, CY: POST /amendebupot<jenis> langsung (BPMP terbukti live 2026-10-19, automation/bpmp-amend.js);
 *  - BP21, BP26, BPA1, BPA2, BPPU, BPNR: POST /amendebupot<jenis>/validate (diperiksa Coretax, belum disimpan) lalu
 *    POST /amendebupot<jenis> + SignParameter {Type:'02', Provider, SignerID, SignerPassword} + SignedTaxpayerAggregateIdentifier
 *    (dialog "sign outside document" Coretax; bentuknya sama dengan Issue & Sign, lib/coretax-issue.js).
 * Batal: POST /cancelebupot<jenis> {EBUPOTIdentifiers} (+ SignParameter untuk jenis bertanda tangan) - komponen grid Coretax.
 *
 * Pengaman: pratinjau (sebelum -> sesudah per bukti potong; jenis bertanda tangan juga diuji ke /validate tanpa disimpan)
 * memberi kode konfirmasi = sidik rencana; kirim hanya bila rencana yang disusun ulang saat kirim menghasilkan kode yang
 * sama. Tiap bukti potong dicadangkan (JSON) sebelum dikirim, diperiksa ulang sesudahnya, berhenti di kegagalan pertama.
 * Identitas penerima, masa, kode objek, kode akun pajak tidak bisa diubah di sini (Ganti NIK: alur Pembetulan NIK). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';
const CERT_URL = 'https://coretaxdjp.pajak.go.id/registrationportal/api/DigitalCertificate/digitalCertificateList';
const VALIDATE_SIGN_URL = 'https://coretaxdjp.pajak.go.id/documentmanagementportal/api/documentOutbound/validate-sign';
const PTKP = ['TK0', 'TK1', 'TK2', 'TK3', 'K0', 'K1', 'K2', 'K3'];
// Kategori TER (PP 58/2023): BPMP ganti PTKP lintas kategori mengubah tarif - tarif baru wajib disebut.
const TER = { TK0: 'A', TK1: 'A', K0: 'A', TK2: 'B', TK3: 'B', K1: 'B', K2: 'B', K3: 'C' };
const MAX = 300;

/* Body kiriman per jenis = urutan kunci submit() formulir Coretax. period: properti saringan masa daftar.
 * tax: isian PPh; base: dasar pengenaan; deemed: persen penghasilan neto (bila ada). simple: PPh = bulat(base x tarif / 100)
 * boleh dihitung Pilot (selain itu PPh wajib disebut bila bruto / tarif berubah - dicek Coretax lewat /validate). */
const SPEC = {
    mp: { label: 'BPMP', sign: false, period: 'TaxPeriodCode', base: 'GrossIncome', tax: 'IncomeTaxWithheld', simple: true, taxpayerType: true,
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'IsForeignEmployee', 'TaxpayerType', 'TaxIdentificationNumber', 'Name', 'Position', 'TaxCertificateCode', 'TaxObjectCode', 'TaxArticle', 'TaxObjectReferenceCode', 'GrossIncome', 'TaxRate', 'IncomeTaxWithheld', 'RevenueCode', 'BranchId', 'TaxExemptionStatus'] },
    bp21: { label: 'BP21', sign: true, period: 'TaxPeriodCode', base: 'TaxBase', tax: 'IncomeTax', deemed: 'DeemedNetIncome',
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxIdentificationNumber', 'Name', 'BranchIdIncomeRecipient', 'TaxCertificateCode', 'TaxObjectReferenceCode', 'TaxArticle', 'TaxObjectCode', 'IncomeTaxStatus', 'TaxBase', 'TaxRate', 'IncomeTax', 'PreviouslyPaidGrossIncome', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'PaymentMethod', 'IDPlaceOfBusinessActivity', 'IpAddress', 'MacAddress', 'Number', 'TaxExemptionStatus', 'DeemedNetIncome'] },
    bp26: { label: 'BP26', sign: true, period: 'TaxPeriodCode', base: 'GrossIncome', tax: 'IncomeTax', deemed: 'DeemedNetIncome',
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxCertificateCode', 'ReceiptNumber', 'TaxIdentificationNumber', 'Name', 'Address', 'CountryOfOrigin', 'DOB', 'BirthCityCode', 'PassportNumber', 'KITASNumber', 'TaxObjectReferenceCode', 'TaxArticle', 'TaxObjectCode', 'IncomeTaxStatus', 'GrossIncome', 'DeemedNetIncome', 'TaxRate', 'IncomeTax', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'PaymentMethod', 'BranchId', 'IpAddress', 'MacAddress'] },
    bpnr: { label: 'BPNR', sign: true, period: 'TaxPeriodCode', base: 'GrossIncome', tax: 'IncomeTax', deemed: 'DeemedNetIncome',
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxObjectReferenceCode', 'TaxCertificateCode', 'ReceiptNumber', 'TaxIdentificationNumber', 'TIN', 'Name', 'Address', 'CountryCode', 'DOB', 'BirthCityCode', 'PassportNumber', 'KITASNumber', 'TaxObjectId', 'TaxObjectCode', 'TaxArticle', 'IncomeTaxStatus', 'GrossIncome', 'DeemedNetIncome', 'TaxRate', 'IncomeTax', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'PaymentMethod', 'SP2DNumber', 'BranchId'] },
    bpu: { label: 'BPPU', sign: true, period: 'TaxPeriodCode', base: 'TaxBase', tax: 'IncomeTax', simple: true,
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxCertificateCode', 'TaxIdentificationNumber', 'Name', 'BranchIdIncomeRecipient', 'TaxObjectReferenceCode', 'TaxObjectCode', 'TaxArticle', 'IncomeTaxStatus', 'TaxBase', 'TaxRate', 'IncomeTax', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'PaymentMethod', 'SP2DNumber', 'BranchId', 'LastUpdatedDate'] },
    bpa1: { label: 'BPA1', sign: true, period: 'IncomePeriodCodeEnd', base: 'GrossIncomeTotal', tax: 'Article21TaxWithheld', taxpayerType: true,
        keys: ['IncomePeriodCodeStart', 'IncomePeriodCodeEnd', 'WithholdingSlipsStatus', 'IsForeignEmployee', 'TaxpayerType', 'TaxIdentificationNumber', 'Name', 'Address', 'PassportNumber', 'CountryCode', 'Gender', 'TaxExemptionStatus', 'Position', 'TaxObjectCode', 'TaxArticle', 'TaxObjectReferenceCode', 'BPA1Status', 'GrossIncomeSalary', 'GrossIncomeTaxBenefit', 'GrossIncomeOtherBenefit', 'GrossIncomeHonorarium', 'GrossIncomeInsurance', 'GrossIncomeNatura', 'GrossIncomeBonus', 'GrossIncomeTotal', 'DeductionFee', 'DeductionPensionContribution', 'DeductionTotal', 'IncomeTaxNetIncome', 'PreviousWithholdingSlipsNumber', 'IncomeTaxPreviousNetIncome', 'IncomeTaxTotalNetIncome', 'IncomeTaxExemption', 'IncomeTaxTaxableIncome', 'Article21TaxableIncome', 'Article21PreviousTaxWithheld', 'Article21TaxLiabilityCanBeCredited', 'Article21TaxLiability', 'Article21TaxWithheld', 'Article21TaxUnderPayment', 'IsArticle21TaxUnderPaymentByGov', 'RevenueCode', 'IDPlaceOfBusinessActivity', 'IsGrossUp', 'NumberOfMonths', 'ZakatReligiousDonations', 'TaxFacilityForTaxPeriod', 'WorkingForASecondEmployer'] },
    bpa2: { label: 'BPA2', sign: true, period: 'TaxPeriodCodeEnd', base: 'GrossIncomeTotal', tax: 'Article21TaxWithheld', taxpayerType: true,
        keys: ['TaxPeriodCodeStart', 'TaxPeriodCodeEnd', 'WithholdingSlipsStatus', 'TaxpayerType', 'TaxIdentificationNumber', 'Name', 'Address', 'NIP', 'Gender', 'Class', 'TaxExemptionStatus', 'Position', 'TaxObjectCode', 'TaxArticle', 'TaxObjectReferenceCode', 'BPA2Status', 'GrossIncomeSalary', 'GrossIncomeWife', 'GrossIncomeChildren', 'GrossIncomeImprovement', 'GrossIncomeStructural', 'GrossIncomeRice', 'GrossIncomeOther', 'GrossIncomeOtherFixed', 'GrossIncomeTotal', 'DeductionFee', 'DeductionPensionContribution', 'DeductionTotal', 'IncomeTaxNetIncome', 'PreviousWithholdingSlipsNumber', 'IncomeTaxPreviousNetIncome', 'IncomeTaxTotalNetIncome', 'IncomeTaxExemption', 'IncomeTaxTaxableIncome', 'Article21TaxableIncome', 'Article21PreviousTaxWithheld', 'Article21TaxLiabilityCanBeCredited', 'Article21TaxLiability', 'Article21TaxWithheld', 'Article21TaxUnderPayment', 'RevenueCode', 'IDPlaceOfBusinessActivity', 'NumberOfMonths', 'ZakatReligiousDonations', 'WorkingForASecondEmployer'] },
    sp: { label: 'SP', sign: false, period: 'TaxPeriodCode', base: 'TaxBase', tax: 'IncomeTax',
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxCertificateCode', 'TaxObjectReferenceCode', 'TaxObjectCode', 'TaxArticle', 'IncomeTaxStatus', 'TaxBase', 'TaxRate', 'IncomeTax', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'BranchId', 'IncomeFromIndonesiaTaxBase', 'IncomeFromIndonesiaIncomeTax', 'IncomeFromForeignCountriesTaxBase', 'IncomeFromForeignCountriesIncomeTax', 'IncomeTaxArticle24ThatCanBeCreditedIncomeTax', 'IncomeTaxWithheldByOtherParty', 'SelfPaymentIncomeTax'] },
    cy: { label: 'CY', sign: false, period: 'TaxPeriodCode', base: 'TaxBase', tax: 'IncomeTax', simple: true,
        keys: ['TaxPeriodCode', 'WithholdingSlipsStatus', 'TaxCertificateCode', 'TaxObjectReferenceCode', 'TaxObjectCode', 'TaxArticle', 'IncomeTaxStatus', 'TaxBase', 'TaxRate', 'IncomeTax', 'RevenueCode', 'DocumentType', 'DocumentNumber', 'DocumentDate', 'BranchId'] }
};
const KINDS = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, v.label]));
// Tidak bisa diubah lewat alat ini: identitas, masa, status, kode objek & turunannya, pengenal rekaman.
const LOCKED = new Set(['TaxPeriodCode', 'IncomePeriodCodeStart', 'IncomePeriodCodeEnd', 'TaxPeriodCodeStart', 'TaxPeriodCodeEnd', 'WithholdingSlipsStatus', 'TaxpayerType', 'TaxIdentificationNumber', 'TIN', 'Name',
    'TaxObjectCode', 'TaxObjectReferenceCode', 'TaxObjectId', 'TaxArticle', 'RevenueCode', 'IpAddress', 'MacAddress', 'Number', 'LastUpdatedDate', 'PassportNumber', 'KITASNumber', 'NIP']);
// Nama singkat (MCP / pengguna) -> isian Coretax.
const ALIAS = { ptkp: 'TaxExemptionStatus', position: 'Position', rate: 'TaxRate', document: 'DocumentNumber', documentDate: 'DocumentDate', documentType: 'DocumentType', certificate: 'TaxCertificateCode', nitku: 'BranchIdIncomeRecipient' };

const normPtkp = (v) => { const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return PTKP.includes(s) ? s : null; };
const num = (v) => { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(/,/g, '.')); return Number.isFinite(n) ? n : null; };
const taxOf = (gross, rate) => Math.round(gross * rate / 100);
const same = (a, b) => (a == null || a === '' ? '' : String(a)) === (b == null || b === '' ? '' : String(b));

/** '1026' / '102026' / '10102026' -> {code:'10102026', month:10, year:'2026'}. */
function periodOf(p) {
    const s = String(p || '').replace(/\D/g, '');
    let mm, yyyy;
    if (s.length === 4) { mm = s.slice(0, 2); yyyy = '20' + s.slice(2); }
    else if (s.length === 6) { mm = s.slice(0, 2); yyyy = s.slice(2); }
    else if (s.length === 8) { mm = s.slice(0, 2); yyyy = s.slice(4); }
    if (!mm || +mm < 1 || +mm > 12 || !/^20\d{2}$/.test(yyyy)) throw new Error('Masa tidak valid: "' + p + '" (contoh 1026 = Oktober 2026).');
    return { code: mm + mm + yyyy, month: +mm, year: yyyy, label: mm + '/' + yyyy };
}
const spec = (type) => { const t = SPEC[type || 'mp']; if (!t) throw new Error('Jenis tidak dikenal: ' + type + ' (' + Object.keys(SPEC).join(', ') + ').'); return t; };
const grossOf = (r) => r.GrossIncome ?? r.TaxBase ?? r.GrossIncomeTotal ?? null;
const taxOfRow = (r) => r.IncomeTaxWithheld ?? r.IncomeTax ?? r.Article21TaxWithheld ?? null;
const periodLabel = (r) => { const p = String(r.TaxPeriodCode || r.IncomePeriodCodeEnd || r.TaxPeriodCodeEnd || ''); return p.length === 8 ? p.slice(2, 4) + '/' + p.slice(4) : p; };
const slim = (r) => ({ number: r.WithholdingSlipsNumber, period: periodLabel(r), nik: r.TaxIdentificationNumber, name: String(r.Name || '').trim(),
    ptkp: r.TaxExemptionStatus || null, taxObject: r.TaxObjectCode, gross: grossOf(r), rate: r.TaxRate ?? null, tax: taxOfRow(r), position: r.Position ? String(r.Position).trim() : null,
    ...(r.DocumentNumber ? { document: r.DocumentNumber } : {}), status: r.WithholdingSlipsStatus, reportedInSpt: !!r.IsReportedToTaxReturn });

// page.__session: sesi tiruan untuk tes (scripts/test-ebupot-edit.js).
async function session(page, npwp, type = 'mp') { return page.__session || require('../automation/bpmp-amend').openSession(page.context(), npwp, { type }); }
async function view(s, type, recordId) {
    const r = await s.post(API + '/viewebupot' + type, { RecordId: recordId });
    const v = r.json && r.json.Payload && r.json.Payload.Result;
    if (!v || v.RecordId !== recordId) throw new Error('Detail bukti potong tidak terbaca (HTTP ' + r.status + ').');
    return v;
}
const listIssued = (s, type, p) => s.list('getebupot' + type + 'issued', p.code, spec(type).period);

/** Bukti potong satu jenis & masa (Telah Terbit, atau Belum Terbit bila issued=false), disaring NIK / sebagian nama / nomor.
 *  Hanya membaca. Detail (mis. PTKP, posisi) dibuka bila hasilnya sedikit atau detail=true. */
async function find(page, { npwp, type = 'mp', issued = true, period, nik, name, numbers, detail = false }) {
    const t = spec(type), p = periodOf(period), s = await session(page, npwp, type);
    try {
        let rows = await s.list('getebupot' + type + (issued === false ? 'notissued' : 'issued'), p.code, t.period);
        const nums = new Set((numbers || []).map(String)), q = String(name || '').trim().toUpperCase();
        if (nik) rows = rows.filter((r) => r.TaxIdentificationNumber === String(nik).replace(/\D/g, ''));
        if (q) rows = rows.filter((r) => String(r.Name || '').toUpperCase().includes(q));
        if (nums.size) rows = rows.filter((r) => nums.has(String(r.WithholdingSlipsNumber)));
        const total = rows.length;
        rows = rows.slice(0, MAX);
        if (issued !== false && (detail || rows.length <= 40)) rows = await Promise.all(rows.map(async (r) => ({ ...r, ...(await view(s, type, r.RecordId).catch(() => ({}))) })));
        const out = rows.map(slim);
        return { type: t.label, state: issued === false ? 'Belum Terbit' : 'Telah Terbit', period: p.label, total, shown: out.length, slips: out,
            totals: { gross: out.reduce((a, r) => a + (r.gross || 0), 0), tax: out.reduce((a, r) => a + (r.tax || 0), 0) } };
    } finally { await s.close(); }
}

/** Baris file revisi BPMP (XML / Excel template impor) -> perubahan per NIK + kode objek. */
async function readRevision(filePath, npwp) {
    const imp = require('./coretax-import');
    const d = await imp.prepare(fs.readFileSync(filePath), path.basename(filePath), npwp);
    if (d.type !== 'mp') throw new Error('File revisi saat ini hanya untuk BPMP (MmPayroll); file ini ' + d.label + ' - untuk jenis lain sebutkan perubahan per nomor.');
    let rows = d.rows;
    if (!rows) {
        rows = [...d.xml.matchAll(/<MmPayroll>([\s\S]*?)<\/MmPayroll>/g)].map((m) => {
            const o = {};
            for (const f of imp.TYPES.mp.fields) { const x = new RegExp('<' + f + '>\\s*([^<]*?)\\s*</' + f + '>').exec(m[1]); o[f] = x ? x[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; }
            return o;
        });
    }
    return rows.map((r, i) => ({ line: i + 1, period: periodOf(String(r.TaxPeriodMonth).padStart(2, '0') + String(r.TaxPeriodYear)), nik: String(r.CounterpartTin || '').replace(/\D/g, ''), taxObject: String(r.TaxObjectCode || '').trim(),
        fields: { ...(r.StatusTaxExemption ? { TaxExemptionStatus: r.StatusTaxExemption } : {}), ...(num(r.Gross) != null ? { GrossIncome: num(r.Gross) } : {}), ...(num(r.Rate) != null ? { TaxRate: num(r.Rate) } : {}), ...(r.Position ? { Position: String(r.Position).trim() } : {}) } }));
}

/** Isian perubahan (nama Coretax atau alias; gross/tax mengikuti jenis) -> {Coretax: nilai} atau error. */
function normFields(type, raw) {
    const t = spec(type), out = {}, bad = [];
    for (const [k0, v] of Object.entries(raw || {})) {
        if (v === undefined) continue;
        const k = k0 === 'gross' ? t.base : k0 === 'tax' ? t.tax : ALIAS[k0] || k0;
        if (!t.keys.includes(k)) { bad.push(k0 + ' (bukan isian ' + t.label + ')'); continue; }
        if (LOCKED.has(k)) { bad.push(k0 + ' (tidak bisa diubah di sini)'); continue; }
        if (k === 'TaxExemptionStatus') { const p = normPtkp(v); if (!p) { bad.push('PTKP "' + v + '" (' + PTKP.join(', ') + ')'); continue; } out[k] = p; continue; }
        out[k] = typeof v === 'string' && num(v) != null && /^(Gross|Tax(Base|Rate)|IncomeTax|Deduction|Article21|Deemed|Zakat|NumberOf|Previously)/.test(k) ? num(v) : v;
    }
    return { fields: out, bad };
}

/** Body kiriman = isian formulir Coretax (detail) dengan perubahan; urutan kunci = submit() Coretax. */
function buildBody(type, v, fields, taxpayerType) {
    const t = spec(type), b = {};
    for (const k of t.keys) {
        if (k in fields) { b[k] = fields[k]; continue; }
        if (k === 'TaxpayerType') { b[k] = taxpayerType; continue; }
        if (k === 'IpAddress' || k === 'MacAddress' || k === 'Number') { b[k] = ''; continue; }
        if (k === 'TIN') { b[k] = v.TaxIdentificationNumber; continue; }
        if (k === 'IDPlaceOfBusinessActivity') { b[k] = v.IDPlaceOfBusinessActivity ?? v.BranchId ?? null; continue; }
        if (k === 'IsForeignEmployee' || k === 'WorkingForASecondEmployer' || k === 'IsGrossUp') { b[k] = v[k] === true || v[k] === 'YES'; continue; }
        if (k === 'Position') { b[k] = v.Position ? String(v.Position).trim() : null; continue; }
        if (k === 'TaxObjectReferenceCode' && type === 'mp') { b[k] = String(v.TaxObjectReferenceCode); continue; }
        if (k === 'NumberOfMonths') { b[k] = v[k] ?? 0; continue; }
        b[k] = v[k] === undefined ? null : v[k];
    }
    b.RecordId = v.RecordId;
    b.WithholdingslipsAggregateIdentifier = v.WithholdingslipsAggregateIdentifier;
    return b;
}

/** Rencana pembetulan satu jenis. input: {type, changes:[{number, period, fields:{...} | ptkp/gross/rate/tax/position...}]}
 *  atau (BPMP) {filePath}. Jenis bertanda tangan: tiap rencana diuji ke /validate (tidak disimpan). Hanya membaca. */
async function plan(s, { type = 'mp', npwp, changes, filePath, check = true }) {
    const t = spec(type), notes = [], items = [];
    let wants;
    if (filePath) {
        if (type !== 'mp') throw new Error('File revisi saat ini hanya untuk BPMP.');
        wants = (await readRevision(filePath, npwp)).map((w) => ({ ...w, source: 'baris ' + w.line }));
    } else {
        if (!Array.isArray(changes) || !changes.length) throw new Error('Sebutkan perubahan ({number, period, fields}) atau file revisi (BPMP).');
        wants = changes.map((c, i) => {
            const { number, period, fields, ...short } = c || {};
            return { source: 'nomor ' + (number || '?'), number: String(number || '').trim(), period: periodOf(period), raw: { ...short, ...(fields || {}) }, line: i + 1 };
        });
    }
    if (wants.length > MAX) throw new Error('Maksimal ' + MAX + ' bukti potong per proses (ada ' + wants.length + ').');
    const lists = new Map(), used = new Set(), types = new Map();
    const listOf = async (p) => { if (!lists.has(p.code)) lists.set(p.code, await listIssued(s, type, p)); return lists.get(p.code); };
    for (const w of wants) {
        const nf = normFields(type, w.fields || w.raw);
        if (nf.bad.length) { notes.push(w.source + ': ' + nf.bad.join('; ') + ' - dilewati.'); continue; }
        if (!Object.keys(nf.fields).length) { notes.push(w.source + ': tidak ada isian yang diubah - dilewati.'); continue; }
        const list = await listOf(w.period);
        const hits = w.number ? list.filter((r) => String(r.WithholdingSlipsNumber) === w.number)
            : list.filter((r) => r.TaxIdentificationNumber === w.nik && (!w.taxObject || r.TaxObjectCode === w.taxObject) && !used.has(r.RecordId));
        if (!hits.length) { notes.push(w.source + ': ' + (w.number ? 'nomor ' + w.number : 'NIK ' + w.nik + (w.taxObject ? ' kode ' + w.taxObject : '')) + ' tidak ada di ' + t.label + ' Telah Terbit ' + w.period.label + ' - dilewati' + (w.number ? '' : ' (bukti potong baru: pakai upload)') + '.'); continue; }
        if (hits.length > 1) { notes.push(w.source + ': NIK ' + w.nik + ' punya ' + hits.length + ' ' + t.label + ' ' + w.period.label + ' (' + hits.map((h) => h.WithholdingSlipsNumber).join(', ') + ') - sebutkan nomornya; dilewati.'); continue; }
        const r = hits[0]; used.add(r.RecordId);
        const v = await view(s, type, r.RecordId);
        if (!['NORMAL', 'AMENDMENT'].includes(v.WithholdingSlipsStatus)) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' berstatus ' + v.WithholdingSlipsStatus + ' - dilewati.'); continue; }
        if (v.ESignStatus === 'SIGNING_IN_PROGRESS') { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' sedang proses tanda tangan di Coretax - coba lagi nanti; dilewati.'); continue; }
        const f = { ...nf.fields };
        // PPh: BPMP / BPPU / CY dihitung (bulat dasar x tarif / 100, sama dengan Coretax); jenis lain wajib disebut bila uang berubah.
        const moneyChanged = [t.base, 'TaxRate', t.deemed].filter(Boolean).some((k) => k in f && !same(f[k], v[k]));
        if (moneyChanged && !(t.tax in f)) {
            if (t.simple) f[t.tax] = taxOf(f[t.base] ?? v[t.base], f.TaxRate ?? v.TaxRate);
            else { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' ' + t.label + ' - dasar / tarif berubah, sebutkan juga PPh-nya (' + t.tax + ')' + (type.startsWith('bpa') ? ' beserta isian turunannya (total bruto, neto, PKP, PPh terutang)' : '') + '; dilewati.'); continue; }
        }
        if (type === 'mp' && 'TaxExemptionStatus' in f && TER[f.TaxExemptionStatus] !== TER[v.TaxExemptionStatus] && !('TaxRate' in f)) {
            notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' PTKP ' + v.TaxExemptionStatus + ' -> ' + f.TaxExemptionStatus + ' pindah kategori TER ' + TER[v.TaxExemptionStatus] + ' -> ' + TER[f.TaxExemptionStatus] + ' - sebutkan tarif barunya; dilewati.'); continue;
        }
        const changed = Object.keys(f).filter((k) => !same(f[k], v[k]));
        if (!changed.length) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' sudah sesuai - dilewati.'); continue; }
        const before = Object.fromEntries(changed.map((k) => [k, v[k] ?? null])), after = Object.fromEntries(changed.map((k) => [k, f[k]]));
        const item = { recordId: r.RecordId, number: r.WithholdingSlipsNumber, period: periodLabel(v), nik: r.TaxIdentificationNumber, name: String(r.Name || '').trim(), reportedInSpt: !!v.IsReportedToTaxReturn,
            changed, before, after, taxBefore: v[t.tax] ?? 0, taxAfter: t.tax in f ? f[t.tax] : v[t.tax] ?? 0 };
        if (t.sign && check) {
            // Diperiksa Coretax tanpa disimpan (langkah sebelum dialog tanda tangan di formulir Coretax).
            if (t.taxpayerType && !types.has(r.TaxIdentificationNumber)) types.set(r.TaxIdentificationNumber, await taxpayerTypeOf(s, v));
            const res = await s.post(API + '/amendebupot' + type + '/validate', buildBody(type, v, f, types.get(r.TaxIdentificationNumber)));
            const ok = res.status === 200 && res.json && res.json.IsSuccessful !== false;
            item.coretaxCheck = ok ? 'lolos' : 'DITOLAK: ' + msgOf(res);
            if (!ok) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' ditolak pemeriksaan Coretax (' + msgOf(res) + ') - dilewati.'); continue; }
        }
        items.push(item);
    }
    const token = items.length ? crypto.createHash('sha256').update(type + JSON.stringify(items.map((x) => [x.recordId, x.before, x.after]))).digest('hex').slice(0, 12) : null;
    return { type: t.label, needsSign: t.sign, items, notes, token,
        totals: { taxBefore: items.reduce((a, x) => a + (x.taxBefore || 0), 0), taxAfter: items.reduce((a, x) => a + (x.taxAfter || 0), 0) },
        periodsReported: [...new Set(items.filter((x) => x.reportedInSpt).map((x) => x.period))] };
}
const msgOf = (res) => { const j = res && res.json; const m = j && (j.Message || j.Errors || j.Payload); return (typeof m === 'string' ? m : JSON.stringify(m || ('HTTP ' + (res && res.status)))).slice(0, 300); };
async function taxpayerTypeOf(s, v) {
    if (v.TaxpayerType) return v.TaxpayerType;
    const p = await s.lookup(v.TaxIdentificationNumber);
    if (p.error || !p.payload) throw new Error(v.WithholdingSlipsNumber + ': data NIK tidak terbaca dari Coretax (' + (p.error || 'kosong') + ').');
    return p.payload.TaxpayerType;
}

/** SignParameter Coretax untuk penandatangan {nik, passphrase} (sama dengan lib/coretax-issue.js issue()). */
async function signParam(s, signer, emit) {
    if (!signer || !signer.nik || !signer.passphrase) throw new Error('Jenis ini perlu tanda tangan: NIK dan passphrase PIC belum tersedia di Pilot.');
    const certs = await s.post(CERT_URL, { SignerId: signer.nik });
    const list = ((certs.json && certs.json.Payload) || []).slice().sort((a, b) => String(a.Code).localeCompare(String(b.Code)));
    if (!list.length) throw new Error('Sertifikat elektronik penandatangan tidak ditemukan di Coretax.');
    const provider = list[0].Code;
    if (provider === '00' || provider === '08') {
        const v = await s.post(VALIDATE_SIGN_URL, { Nik: signer.nik, Passphrase: signer.passphrase });
        if (!(v.json && v.json.IsSuccessful && v.json.Payload && Number(v.json.Payload.KodeResponse) === 1)) throw new Error('Passphrase ditolak Coretax: ' + ((v.json && v.json.Payload && v.json.Payload.ErrMessage) || (v.json && v.json.Message) || 'HTTP ' + v.status) + '. Tidak ada yang dikirim.');
    }
    emit('Tanda tangan: sertifikat ' + provider + ', passphrase PIC valid.');
    const c = (s.auth && s.auth.claims) || s.claims || {};
    return { SignParameter: { Type: '02', Provider: provider, SignerID: signer.nik, SignerPassword: signer.passphrase }, SignedTaxpayerAggregateIdentifier: c.Impersonating && c.RepresentativeId ? c.RepresentativeId : c.taxpayer_id };
}

async function previewAmend(page, input) {
    spec(input.type || 'mp');
    const s = await session(page, input.npwp, input.type || 'mp');
    try { return await plan(s, input); } finally { await s.close(); }
}

/** Kirim pembetulan - hanya bila rencana sekarang = pratinjau (kode sama). signer {nik, passphrase} untuk jenis bertanda tangan. */
async function amend(page, { token, outDir, signer, emit = () => {}, shouldStop = () => false, ...input }) {
    if (!token) throw new Error('Kode konfirmasi pratinjau wajib - jalankan pratinjau dulu.');
    const type = input.type || 'mp', t = spec(type), s = await session(page, input.npwp, type), results = [];
    try {
        const p = await plan(s, { ...input, check: true });
        p.notes.forEach((n) => emit('LEWATI ' + n));
        if (p.token !== token) throw new Error('Data di Coretax berubah sejak pratinjau (kode ' + token + ' tidak cocok lagi) - lihat pratinjau baru dulu.');
        const sign = t.sign ? await signParam(s, signer, emit) : null;
        fs.mkdirSync(outDir, { recursive: true });
        const types = new Map();
        for (const x of p.items) {
            if (shouldStop()) { emit('Dihentikan pengguna - ' + results.length + ' dari ' + p.items.length + ' sudah dikirim, sisanya tidak.'); break; }
            const label = t.label + ' ' + x.number + ' masa ' + x.period + ' · ' + x.nik + ' ' + x.name;
            const v = await view(s, type, x.recordId);
            fs.writeFileSync(path.join(outDir, 'cadangan-' + type + '-' + x.number + '.json'), JSON.stringify({ view: v, plan: x }, null, 1));
            if (t.taxpayerType && !types.has(x.nik)) types.set(x.nik, await taxpayerTypeOf(s, v));
            const body = buildBody(type, v, x.after, types.get(x.nik));
            if (t.sign) {
                const chk = await s.post(API + '/amendebupot' + type + '/validate', body);
                if (!(chk.status === 200 && chk.json && chk.json.IsSuccessful !== false)) { results.push({ ...x, status: 'GAGAL: ditolak pemeriksaan Coretax' }); throw Object.assign(new Error(label + ': ditolak pemeriksaan Coretax - ' + msgOf(chk)), { results }); }
                Object.assign(body, sign);
            }
            const res = await s.post(API + '/amendebupot' + type, body);
            if (res.status !== 200 || !res.json || res.json.IsSuccessful === false) {
                results.push({ ...x, status: 'GAGAL: ditolak Coretax' });
                throw Object.assign(new Error(label + ': ditolak Coretax - ' + msgOf(res)), { results });
            }
            // Jenis bertanda tangan bisa diproses di latar (ESignStatus): tunggu sampai hasilnya terbaca.
            let nv = null;
            for (let i = 0; i < (t.sign ? 20 : 1); i++) {
                if (i) await new Promise((r) => setTimeout(r, 3000));
                const now = (await listIssued(s, type, periodOf(x.period.replace('/', '')))).find((r) => r.WithholdingSlipsNumber === x.number);
                nv = now ? await view(s, type, now.RecordId).catch(() => now) : null;
                if (nv && nv.WithholdingSlipsStatus === 'AMENDMENT' && x.changed.every((k) => same(nv[k], x.after[k]))) break;
            }
            const ok = !!nv && nv.WithholdingSlipsStatus === 'AMENDMENT' && x.changed.every((k) => same(nv[k], x.after[k]));
            results.push({ ...x, status: ok ? 'DIBETULKAN' : 'PERIKSA - hasil tidak sesuai', now: nv ? slim(nv) : null });
            emit((ok ? 'OK    ' : 'CEK   ') + label + ' · ' + x.changed.map((k) => k + ' ' + x.before[k] + ' -> ' + x.after[k]).join(', '));
            if (!ok) throw Object.assign(new Error(label + ': pemeriksaan sesudah kirim tidak sesuai - berhenti.'), { results });
        }
        fs.writeFileSync(path.join(outDir, 'hasil.json'), JSON.stringify(results, null, 1));
        return { results, notes: p.notes, periodsReported: p.periodsReported };
    } finally { await s.close(); }
}

/** Pratinjau batal: nomor-nomor satu jenis & masa di Telah Terbit. */
async function cancelPlan(s, { type = 'mp', period, numbers }) {
    const t = spec(type), p = periodOf(period), want = [...new Set((numbers || []).map((n) => String(n).trim()).filter(Boolean))];
    if (!want.length) throw new Error('Sebutkan nomor bukti potong yang dibatalkan.');
    if (want.length > MAX) throw new Error('Maksimal ' + MAX + ' bukti potong per proses.');
    const list = await listIssued(s, type, p), notes = [], rows = [];
    for (const n of want) { const r = list.find((x) => String(x.WithholdingSlipsNumber) === n); if (r) rows.push(r); else notes.push(n + ': tidak ada di ' + t.label + ' Telah Terbit ' + p.label + ' - dilewati.'); }
    const token = rows.length ? crypto.createHash('sha256').update('cancel|' + type + '|' + rows.map((r) => r.RecordId + ':' + r.WithholdingSlipsStatus + ':' + taxOfRow(r)).sort().join('|')).digest('hex').slice(0, 12) : null;
    return { t, p, rows, notes, token };
}
async function previewCancel(page, { npwp, ...input }) {
    spec(input.type || 'mp');
    const s = await session(page, npwp, input.type || 'mp');
    try {
        const c = await cancelPlan(s, input);
        return { type: c.t.label, needsSign: c.t.sign, period: c.p.label, token: c.token, notes: c.notes, slips: c.rows.map(slim),
            totals: { gross: c.rows.reduce((a, r) => a + (grossOf(r) || 0), 0), tax: c.rows.reduce((a, r) => a + (taxOfRow(r) || 0), 0) }, reportedInSpt: c.rows.filter((r) => r.IsReportedToTaxReturn).length };
    } finally { await s.close(); }
}
async function cancel(page, { npwp, token, signer, emit = () => {}, shouldStop = () => false, ...input }) {
    if (!token) throw new Error('Kode konfirmasi pratinjau wajib - jalankan pratinjau batal dulu.');
    const type = input.type || 'mp', s = await session(page, npwp, spec(type) && type), done = [];
    try {
        const c = await cancelPlan(s, input);
        c.notes.forEach((n) => emit('LEWATI ' + n));
        if (c.token !== token) throw new Error('Daftar berubah sejak pratinjau (kode ' + token + ' tidak cocok lagi) - lihat pratinjau baru dulu.');
        const sign = c.t.sign ? await signParam(s, signer, emit) : null;
        for (const r of c.rows) {
            if (shouldStop()) { emit('Dihentikan pengguna - sisa pembatalan tidak dikirim.'); break; }
            const id = { RecordIdentifier: r.RecordId, UnderAuditValue: r.IsUnderAudit, UnderObjectionValue: r.IsUnderObjectionValue, UnderObjectionWithdrawalReviewValue: r.IsUnderObjectionWithdrawalReviewValue,
                WasUnderObjectionValue: r.WasUnderObjectionValue, UnderOpenInvestigation: r.IsUnderOpenInvestigation, WithholdingSlipsStatus: r.WithholdingSlipsStatus, UnderRefund: r.UnderRefund };
            if (r.WithholdingslipsAggregateIdentifier != null) id.WithholdingslipsAggregateIdentifier = r.WithholdingslipsAggregateIdentifier;
            let ok = false, pending = false, msg = '';
            try {
                const res = await s.post(API + '/cancelebupot' + type, { EBUPOTIdentifiers: [id], ...(sign || {}) });
                const accepted = res.status === 200 && !!(res.json && res.json.IsSuccessful);
                msg = accepted ? '' : msgOf(res);
                if (accepted) {
                    for (let i = 0; i < (c.t.sign ? 80 : 3); i++) {
                        if (i) await new Promise((x) => setTimeout(x, 3000));
                        const still = (await listIssued(s, type, c.p)).find((x) => x.WithholdingSlipsNumber === r.WithholdingSlipsNumber);
                        if (!still || still.WithholdingSlipsStatus === 'CANCELLED') { ok = true; break; }
                        if (still.ESignStatus) msg = 'tanda tangan ' + still.ESignStatus;
                    }
                    // Diterima Coretax tetapi belum hilang dari Telah Terbit: diproses di latar (pernah selesai beberapa menit kemudian).
                    if (!ok) { pending = true; msg = 'diterima Coretax, masih diproses' + (msg ? ' (' + msg + ')' : '') + ' - cek lagi beberapa menit lagi dengan find_ebupot'; }
                }
            } catch (e) { msg = e.message; }
            done.push({ number: r.WithholdingSlipsNumber, ok, pending, msg });
            emit((ok ? 'DIBATALKAN  ' : pending ? 'DIPROSES    ' : 'GAGAL BATAL ') + c.t.label + ' ' + r.WithholdingSlipsNumber + ' masa ' + c.p.label + ' · ' + r.TaxIdentificationNumber + ' ' + String(r.Name || '').trim() + (ok ? '' : ': ' + msg));
            if (!ok && !pending) break;
        }
        return { done, reported: c.rows.some((r) => r.IsReportedToTaxReturn) };
    } finally { await s.close(); }
}

/** NIK / NPWP terdaftar di Coretax? (/taxpayerdetail, sama dengan formulir Coretax - automation/bpmp-amend.js LOOKUP_IN_PAGE).
 *  NIK yang tidak dikenal Coretax DIGANTI 9990000000999000 saat upload / simpan bukti potong (nama jadi
 *  "PENERIMA PENGHASILAN#<NIK>") - kasus 2026-11-12: pengganti BP21 terbit lagi dengan NIK sementara.
 *  Hasil per nomor: {status: 'terdaftar' | 'tidak ditemukan' | 'tidak bisa dicek', name, type, error}. */
// Berurutan (concurrency 1): setiap cek mendaftarkan kunci RSA baru untuk pengguna yang sama di Coretax
// (/encryption/generate-key) - cek paralel saling menimpa kunci dan menggantung (uji live 2026-11-12).
async function checkIds(s, ids, { concurrency = 1 } = {}) {
    const want = [...new Set((ids || []).map((x) => String(x).replace(/\D/g, '')).filter((x) => /^\d{15,16}$/.test(x)))].map((x) => (x.length === 15 ? '0' + x : x));
    const out = new Map(); let i = 0;
    const worker = async () => {
        while (i < want.length) {
            const id = want[i++];
            if (id === '9990000000999000') { out.set(id, { status: 'tidak ditemukan', error: 'NIK sementara Coretax (bukan NIK orang)' }); continue; }
            // Uji live 2026-11-12: jawaban Coretax untuk cek beruntun tidak selalu konsisten - NIK yang sama bisa dijawab
            // lengkap (nama) lalu kosong (IsFound false TANPA pesan). Karena hasilnya dipakai memblokir upload:
            //  - terdaftar: ada nama (atau IsFound true);
            //  - tidak ditemukan: HANYA bila Coretax memberi pesan tegas "... tidak ditemukan" (ErrMessage);
            //  - jawaban kosong: dicoba lagi sesudah jeda; tetap kosong = "tidak bisa dicek" (tidak memblokir).
            let res = null;
            for (let attempt = 0; attempt < 3 && !res; attempt++) {
                if (attempt || i > 1) await new Promise((x) => setTimeout(x, attempt ? 2500 * attempt : 1200));
                try {
                    const r = await s.lookup(id);
                    const p = r && r.payload, name = p && String(p.Name || p.TaxpayerName || p.FullName || '').trim();
                    const msg = p && p.ErrMessage ? String(p.ErrMessage) : '';
                    if (name || (p && p.IsFound === true)) res = { status: 'terdaftar', name: name || null, type: (p && p.TaxpayerType) || null };
                    else if (p && p.IsFound === false && /tidak ditemukan|not found/i.test(msg)) res = { status: 'tidak ditemukan', error: 'Coretax: ' + msg.slice(0, 160) };
                    else if (attempt === 2) res = { status: 'tidak bisa dicek', error: p ? 'Coretax menjawab tanpa nama dan tanpa pesan (diulang 3 kali)' : (r && r.error) || 'tanpa jawaban' };
                } catch (e) { if (attempt === 2) res = { status: 'tidak bisa dicek', error: e.message }; }
            }
            out.set(id, res);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, want.length) }, worker));
    return want.map((id) => ({ id, ...out.get(id) }));
}
async function checkNik(page, { npwp, ids }) {
    const list = [...new Set((ids || []).map(String))];
    if (!list.length) throw new Error('Sebutkan NIK / NPWP yang dicek.');
    if (list.length > 300) throw new Error('Maksimal 300 NIK / NPWP sekali cek.');
    const s = await session(page, npwp);
    try { return await checkIds(s, list); } finally { await s.close(); }
}

module.exports = { checkIds, checkNik, find, previewAmend, amend, previewCancel, cancel, periodOf, readRevision, taxOf, normPtkp, normFields, buildBody, TER, SPEC, KINDS };
