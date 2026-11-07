/* Konsep SPT: Posting (isi lampiran dari bukti potong Telah Terbit) dan unduh konsep untuk diperiksa sebelum lapor.
 * Lampiran (L-IA, L-IB, L-II, L-III / lampiran Unifikasi) memakai alat unduh SPT yang sudah ada (automation/lampiran.js
 * downloadLampiran) pada form konsep; Induk dibuat ulang dari FormData konsep (konsep belum punya Induk resmi / BPE),
 * lalu digabung jadi satu PDF "KONSEP". Tidak menandatangani / melapor. Lihat docs/coretax-upload-konsep.md. */
const fs = require('fs');
const path = require('path');

const RS = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const RS_PAGE = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';
const KINDS = {
    ICT_WIT: { label: 'PPh 21/26', route: (tp, r) => 'article-21-26-tax-return/' + tp + '/' + r.RecordId + '/ICT_WIT/' + r.AggregateIdentifier,
        post: (id) => ['/prefillreturnsheet/article-2126', { RecordId: id, onManualClick: true }], status: (id) => ['/prefillreturnsheet/article-2126', { RecordId: id, onManualClick: false }] },
    ICT_WT: { label: 'Unifikasi', route: (tp, r) => 'withholding-tax-return/' + tp + '/' + r.RecordId + '/' + r.TaxPeriodCode + '/' + r.AggregateIdentifier,
        post: (id) => ['/prefillreturnsheet/withholding-tax', { RecordId: id }], status: null }
};
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const rp = (n) => (Number(n) || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const periodCode = (p) => require('./coretax-issue').periodCode(p);

/** Sesi portal SPT di tab yang sudah login & impersonate (tab baru kehilangan impersonate -> 401). */
async function session(page) {
    const context = page.context(), auth = {};
    const on = (req) => { if (!req.url().includes('/returnsheetportal/api/')) return; const h = req.headers(); if (h.authorization) auth.authorization = h.authorization; if (h['x-dgt-code']) auth.dgtCode = h['x-dgt-code']; };
    context.on('request', on);
    try {
        await page.goto(RS_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        for (let i = 0; i < 80 && !auth.authorization; i++) await page.waitForTimeout(500);
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    } finally { context.off('request', on); }
    if (!auth.authorization) throw new Error('Sesi SPT Coretax tidak tertangkap - pastikan jendela PIC sudah login.');
    const claims = JSON.parse(Buffer.from(auth.authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    const post = (u, body) => page.evaluate(async ([u, body, a]) => {
        const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: a.authorization, ...(a.dgtCode ? { 'x-dgt-code': a.dgtCode } : {}) }, body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j };
    }, [u, body, auth]);
    return { taxpayerId: claims.taxpayer_id, post };
}

async function findKonsep(s, taxType, code) {
    const r = await s.post(RS + '/returnsheetsnotsubmitted', { First: 0, Rows: 50, SortField: '', SortOrder: 1, Filters: [], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: s.taxpayerId });
    const row = ((r.json && r.json.Payload && r.json.Payload.Data) || []).find((x) => x.TaxTypeCode === taxType && x.TaxPeriodCode === code);
    if (!row) throw new Error('Konsep SPT ' + KINDS[taxType].label + ' masa ' + code + ' tidak ada di Konsep SPT Coretax - buat konsepnya dulu.');
    return row;
}

/** Induk dibuat ulang dari FormData konsep PPh 21/26 (bagian B dan C seperti formulir resmi) - HTML untuk PDF. */
function indukHtml({ entity, npwp, code, model, fd, posting }) {
    const masa = MONTHS[+code.slice(0, 2) - 1] + ' ' + code.slice(4);
    const row = (no, label, kap, v) => '<tr><td class="c">' + no + '</td><td>' + esc(label) + '</td><td class="c">' + kap + '</td><td class="r">' + rp(v) + '</td></tr>';
    const sec = (title, rows) => '<tr class="h"><td colspan="4">' + esc(title) + '</td></tr>' + rows.join('');
    const f1a = (fd.Form1A || {}).GrossIncomeAndIncomeTaxWithheld || {}, f3 = (fd.Form3 || {}).Article21GrossIncomeAndIncomeTaxWithheld || {}, f2 = fd.Form2 || {}, f1b = (fd.Form1B || {}).GrossIncomeAndIncomeTaxWithheld || {};
    return '<!doctype html><html><head><meta charset="utf-8"><style>body{font:11px Arial,sans-serif;margin:28px}h1{font-size:15px;margin:0}h2{font-size:12px;margin:2px 0 10px}.konsep{border:2px solid #c00000;color:#c00000;font-weight:bold;padding:4px 10px;display:inline-block;margin:8px 0}'
        + 'table{border-collapse:collapse;width:100%;margin-top:8px}td,th{border:1px solid #999;padding:4px 6px}.c{text-align:center}.r{text-align:right}tr.h td{background:#dce6f1;font-weight:bold}.meta td{border:none;padding:2px 6px}</style></head><body>'
        + '<h1>SURAT PEMBERITAHUAN (SPT) MASA PAJAK PENGHASILAN (PPh) PASAL 21 DAN/ATAU PASAL 26</h1><h2>INDUK - dibuat ulang dari Konsep SPT Coretax</h2>'
        + '<div class="konsep">KONSEP - BELUM DILAPORKAN, BUKAN DOKUMEN RESMI</div>'
        + '<table class="meta"><tr><td>Pemotong</td><td>: ' + esc(entity) + '</td></tr><tr><td>NPWP</td><td>: ' + esc(npwp || '') + '</td></tr><tr><td>Masa Pajak</td><td>: ' + masa + '</td></tr><tr><td>Status</td><td>: ' + (model === 'AMENDMENT' ? 'Pembetulan' : 'Normal') + '</td></tr><tr><td>Posting</td><td>: ' + esc(posting || '-') + '</td></tr></table>'
        + '<table><tr><th>NO</th><th>URAIAN</th><th>KAP-KJS</th><th>JUMLAH (Rp)</th></tr>'
        + sec('B. PAJAK PENGHASILAN PASAL 21 - I. YANG DILAKUKAN PEMOTONGAN', [
            row(1, 'PPh Pasal 21 yang Dipotong', '411121-100', fd.A21IncomeTaxWithheld), row(2, 'Kelebihan Penyetoran PPh Pasal 21 dari Masa Pajak Sebelumnya', '', fd.A21CarryForward),
            row(3, 'Pembayaran PPh Pasal 21 dengan SP2D', '', fd.A21PaymentWithSP2D), row(4, 'PPh Pasal 21 yang Kurang (Lebih) Disetor', '411121-100', fd.A21IncomeTaxUnderpaidOverpaid),
            row(5, 'PPh Pasal 21 yang Kurang (Lebih) Disetor Karena Pembetulan', '', fd.A21IncomeTaxUnderpaidOverpaidDueToAmendment)])
        + sec('B. II. PPh PASAL 21 DITANGGUNG PEMERINTAH', [row(1, 'PPh Pasal 21 Ditanggung Pemerintah', '411121-100', fd.A21IncomeTaxBorneByGovernment)])
        + sec('C. PAJAK PENGHASILAN PASAL 26 - I. YANG DILAKUKAN PEMOTONGAN', [
            row(1, 'PPh Pasal 26 yang Dipotong', '411127-100', fd.A26IncomeTaxWithheld), row(2, 'Kelebihan Penyetoran PPh Pasal 26 dari Masa Pajak Sebelumnya', '', fd.A26CarryForward),
            row(3, 'Pembayaran PPh Pasal 26 dengan SP2D', '', fd.A26PaymentWithSP2D), row(4, 'PPh Pasal 26 yang Kurang (Lebih) Disetor', '411127-100', fd.A26IncomeTaxUnderpaidOverpaid),
            row(5, 'PPh Pasal 26 yang Kurang (Lebih) Disetor Karena Pembetulan', '', fd.A26IncomeTaxUnderpaidOverpaidDueToAmendment)])
        + sec('C. II. PPh PASAL 26 DITANGGUNG PEMERINTAH', [row(1, 'PPh Pasal 26 Ditanggung Pemerintah', '411127-100', fd.A26IncomeTaxBorneByGovernment)])
        + '</table><table><tr><th>LAMPIRAN</th><th>PENGHASILAN BRUTO (Rp)</th><th>PPh (Rp)</th></tr>'
        + '<tr><td>L-IA Pegawai Tetap (BPMP)</td><td class="r">' + rp(f1a.GrossIncome) + '</td><td class="r">' + rp(f1a.IncomeTax) + '</td></tr>'
        + '<tr><td>L-IB Masa Pajak Terakhir (BPA1/BPA2)</td><td class="r">' + rp(f1b.GrossIncome) + '</td><td class="r">' + rp(f1b.IncomeTax) + '</td></tr>'
        + '<tr><td>L-II Satu Tahun / Bagian Tahun</td><td class="r">' + rp(f2.TotalGrossIncome) + '</td><td class="r">' + rp(f2.TotalIncomeTax) + '</td></tr>'
        + '<tr><td>L-III Selain Pegawai Tetap (BP21/BP26)</td><td class="r">' + rp(f3.GrossIncome) + '</td><td class="r">' + rp(f3.IncomeTax) + '</td></tr></table>'
        + '<p style="color:#555;margin-top:14px">Dibuat Taxio Pilot ' + new Date().toLocaleString('id-ID') + ' dari data Konsep SPT di Coretax. Periksa, lalu tanda tangani dan laporkan sendiri di Coretax.</p></body></html>';
}

/** Posting (opsional) lalu unduh konsep. opts: {taxType, period, post, saveRoot, entityName, entityCode, entityNpwp, emit}. */
async function downloadKonsep(page, { taxType = 'ICT_WIT', period, post = false, outDir, entityName, entityCode, entityNpwp, emit = () => {} }) {
    const kind = KINDS[taxType]; if (!kind) throw new Error('Jenis SPT konsep: ICT_WIT (PPh 21/26) atau ICT_WT (Unifikasi).');
    const code = periodCode(period), s = await session(page);
    let row = await findKonsep(s, taxType, code);
    let fd = null, posting = '';
    if (post) {
        const [u, b] = kind.post(row.RecordId);
        emit('Posting Konsep SPT ' + kind.label + ' masa ' + code + '...');
        const r = await s.post(RS + u, { ...b, TaxpayerAggregateIdentifier: s.taxpayerId });
        if (!(r.status === 200 && r.json && r.json.IsSuccessful)) throw new Error('Posting ditolak Coretax: ' + ((r.json && r.json.Message) || 'HTTP ' + r.status));
        fd = r.json.Payload && r.json.Payload.FormData ? JSON.parse(r.json.Payload.FormData) : null;
    }
    if (kind.status) {
        // Status posting (sama dengan saat form dibuka): tunggu selesai bila sedang berjalan.
        for (let i = 0; i < 60; i++) {
            const [u, b] = kind.status(row.RecordId);
            const r = await s.post(RS + u, { ...b, TaxpayerAggregateIdentifier: s.taxpayerId });
            const P = (r.json && r.json.Payload) || {};
            if (P.FormData) fd = JSON.parse(P.FormData);
            posting = P.PrefillStatus ? P.PrefillStatus + (P.PrefillLastUpdated ? ' ' + P.PrefillLastUpdated : '') : 'belum pernah';
            if (!P.PrefillStatus || /COMPLETED|FAILED/i.test(P.PrefillStatus)) break;
            await page.waitForTimeout(3000);
        }
        emit('Status posting: ' + posting + '.');
        if (/FAILED/i.test(posting)) throw new Error('Posting di Coretax gagal (status FAILED) - coba Posting SPT lagi di form konsep.');
    }
    // Lampiran: alat unduh SPT yang ada, pada form konsep.
    const tp = s.taxpayerId;
    await page.goto('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/' + kind.route(tp, row), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    fs.mkdirSync(outDir, { recursive: true });
    const lampiran = require('../automation/lampiran');
    emit('Unduh lampiran konsep (alat unduh SPT)...');
    const lr = await lampiran.downloadLampiran(page, { outputDir: outDir, saveRoot: outDir, entityName, entityCode, entityNpwp, lampiranFormat: 'both', fileSuffix: '' }, tp, row.RecordId, taxType, 'full', '', 'combined');
    if (!lr.ok) throw new Error('Lampiran konsep gagal diunduh: ' + lr.error);
    // Induk dibuat ulang (PPh 21/26), digabung di depan lampiran.
    const stem = (entityCode ? entityCode + ' - ' : '') + 'Konsep SPT ' + kind.label.replace('/', '-') + ' ' + code.slice(0, 2) + code.slice(6);
    let combined = lr.combinedPath || (lr.paths || []).find((p) => /\.pdf$/i.test(p));
    if (taxType === 'ICT_WIT' && fd) {
        const indukPdf = path.join(outDir, stem + ' - Induk (dibuat ulang).pdf');
        await require('./html-to-pdf').renderHtmlToPdf(indukHtml({ entity: entityName || entityCode || '', npwp: entityNpwp, code, model: row.ReturnSheetModel, fd, posting }), indukPdf);
        if (combined) {
            const merged = await lampiran.mergePdfs([fs.readFileSync(indukPdf), fs.readFileSync(combined)]);
            combined = path.join(outDir, stem + ' (KONSEP).pdf'); fs.writeFileSync(combined, merged);
        } else combined = indukPdf;
    }
    const excel = lr.excelPath || (lr.paths || []).find((p) => /\.xlsx$/i.test(p)) || null;
    return { ok: true, period: code, model: row.ReturnSheetModel, posting, pdf: combined, excel, dir: outDir,
        totals: fd && taxType === 'ICT_WIT' ? { pph21: fd.A21IncomeTaxWithheld, pph26: fd.A26IncomeTaxWithheld, l1aGross: ((fd.Form1A || {}).GrossIncomeAndIncomeTaxWithheld || {}).GrossIncome, l3Gross: ((fd.Form3 || {}).Article21GrossIncomeAndIncomeTaxWithheld || {}).GrossIncome } : null };
}

module.exports = { downloadKonsep, indukHtml, KINDS };
