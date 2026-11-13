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
        post: (id) => ['/prefillreturnsheet/withholding-tax', { RecordId: id }], status: (id) => ['/prefillreturnsheet/withholding-tax', { RecordId: id }] }
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

/** Induk SPT Masa PPh 21/26 dibuat ulang 1:1 dengan formulir resmi Coretax (tata letak, warna dan teks dari PDF Induk
 *  resmi: kop Kemenkeu, badge INDUK kuning, pita abu-abu, bilah biru #004080), dari FormData konsep, bertanda air DRAFT.
 *  ident: {TIN, Name, Address, PhoneNo} dari respons prefill Coretax. */
function indukHtml({ code, model, fd, ident = {}, posting }) {
    const logo = require('fs').readFileSync(require('path').join(__dirname, '../gui/public/assets/kemenkeu-logo.png')).toString('base64');
    const amend = model === 'AMENDMENT';
    const v = (n) => rp(n);
    // Baris 5 "pada SPT yang Dibetulkan" = baris 4 - baris 6 pada pembetulan; SPT Normal 0.
    const sec = (p, kap) => {
        const r4 = fd[p + 'IncomeTaxUnderpaidOverpaid'], r6 = amend ? fd[p + 'IncomeTaxUnderpaidOverpaidDueToAmendment'] : 0, r5 = amend ? (Number(r4) || 0) - (Number(r6) || 0) : 0;
        const art = p === 'A21' ? '21' : '26', L = p === 'A21' ? 'B' : 'C';
        const row = (no, text, k, val) => '<tr><td class="no">' + no + '.</td><td>' + text + '</td><td class="kap">' + k + '</td><td class="amt">' + v(val) + '</td></tr>';
        const head = (a, b, c, d) => '<tr class="th"><td>NO</td><td>URAIAN</td><td>KAP-KJS</td><td>JUMLAH (Rp)</td></tr><tr class="code"><td>' + a + '</td><td>' + b + '</td><td>' + c + '</td><td>' + d + '</td></tr>';
        return '<div class="bar">' + L + '. PAJAK PENGHASILAN PASAL ' + art + '</div>'
            + '<div class="sub">I. PAJAK PENGHASILAN PASAL ' + art + ' YANG DILAKUKAN PEMOTONGAN</div>'
            + '<table class="t">' + head(L + '.1', L + '.2', L + '.3', L + '.4')
            + row(1, 'PPh Pasal ' + art + ' yang Dipotong', kap, fd[p + 'IncomeTaxWithheld'])
            + row(2, 'Kelebihan Penyetoran PPh Pasal ' + art + ' dari Masa Pajak Sebelumnya', '', fd[p + 'CarryForward'])
            + row(3, 'Pembayaran PPh Pasal ' + art + ' dengan SP2D <i>(Hanya untuk Instansi Pemerintah)</i>', '', fd[p + 'PaymentWithSP2D'])
            + row(4, 'PPh Pasal ' + art + ' yang Kurang (Lebih) Disetor (1-2-3) <i>(Apabila ada lebih setor akan dikompensasikan)</i>', '', r4)
            + row(5, 'PPh Pasal ' + art + ' yang Kurang (Lebih) Disetor pada SPT yang Dibetulkan', '', r5)
            + row(6, 'PPh Pasal ' + art + ' yang Kurang (Lebih) Disetor Karena Pembetulan (4-5) <i>(Apabila ada Lebih Setor akan dikompensasikan)</i>', '', r6)
            + '</table><div class="sub">II. PAJAK PENGHASILAN PASAL ' + art + ' DITANGGUNG PEMERINTAH</div>'
            + '<table class="t">' + head(L + '.5', L + '.6', L + '.7', L + '.8') + row(1, 'PPh Pasal ' + art + ' Ditanggung Pemerintah', kap, fd[p + 'IncomeTaxBorneByGovernment']) + '</table>';
    };
    return '<!doctype html><html><head><meta charset="utf-8"><style>'
        + '@page{size:A4;margin:9mm 10mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;font-size:8.6pt;color:#000;margin:0;position:relative}'
        + '.wm{position:fixed;top:38%;left:8%;font-size:150pt;font-weight:bold;color:rgba(200,0,0,.12);transform:rotate(-32deg);letter-spacing:12pt;z-index:0;pointer-events:none}'
        + '.kop{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:4mm}.dept{display:flex;align-items:center;gap:3mm;font-size:8.5pt;line-height:1.3;white-space:nowrap}'
        + '.title{text-align:center;font-weight:bold;font-size:10.5pt;line-height:1.25}.badge{justify-self:end;width:46mm;height:16mm;background:#FFD700;display:flex;align-items:center;justify-content:center;font-size:20pt;font-weight:bold}'
        + '.band{margin-top:3mm;background:#D3D3D3;padding:1.4mm 2mm 1.8mm;display:grid;grid-template-columns:1fr 1fr 1fr;column-gap:2.5mm;text-align:center}.band b{display:block;font-size:7.6pt;margin-bottom:.8mm}.band span{display:block;background:#fff;padding:.9mm;font-size:8.6pt}'
        + '.bar{margin-top:3mm;background:#004080;color:#fff;font-weight:bold;padding:1.3mm 2mm;font-size:8.6pt}.sub{background:#D3D3D3;font-weight:bold;padding:1mm 2mm;font-size:8pt}'
        + '.idt{width:100%;border-collapse:collapse;margin:1mm 0}.idt td{padding:.8mm 2mm;vertical-align:top}.idt td:first-child{width:32mm;white-space:nowrap}.idt td:nth-child(2){width:4mm}'
        + '.t{width:100%;border-collapse:collapse}.t td{padding:1mm 2mm;border-bottom:1px solid #e3e3e3}.t .th td{background:#D3D3D3;font-weight:bold;text-align:center;border:none;padding:1mm 2mm 0}.t .code td{background:#D3D3D3;font-size:6pt;text-align:center;font-weight:bold;padding:0 2mm .8mm;border:none}'
        + '.t td.no{width:10mm;text-align:center}.t td.kap{width:30mm;text-align:center}.t td.amt{width:34mm;text-align:right}.t td:nth-child(2){font-family:"Arial Narrow",Arial,sans-serif}'
        + '.d{margin-top:4mm;border:1px solid #999;padding:0}.d .h{text-align:center;font-weight:bold;padding:1.4mm;border-bottom:1px solid #999}.d table{width:100%;border-collapse:collapse}.d td{padding:1.2mm 2mm;vertical-align:top}'
        + '.box{display:inline-block;width:5mm;height:4.4mm;border:1px solid #000;text-align:center;line-height:4.4mm;margin-right:2mm}.sign{border:1px dashed #c00000;color:#c00000;text-align:center;font-weight:bold;padding:4mm 2mm;width:42mm}'
        + '.foot{margin-top:3mm;font-size:6.5pt;color:#555}</style></head><body><div class="wm">DRAFT</div>'
        + '<div class="kop"><div class="dept"><img src="data:image/png;base64,' + logo + '" style="width:13.7mm;height:13mm;object-fit:contain"><div>KEMENTERIAN KEUANGAN<br>REPUBLIK INDONESIA<br><b>DIREKTORAT JENDERAL PAJAK</b></div></div>'
        + '<div class="title">SURAT PEMBERITAHUAN (SPT) MASA<br>PAJAK PENGHASILAN (PPh)<br>PASAL 21 DAN/ATAU PASAL 26</div><div class="badge">INDUK</div></div>'
        + '<div class="band"><div><b>MASA PAJAK</b><span>' + (+code.slice(0, 2)) + '</span></div><div><b>TAHUN PAJAK</b><span>' + code.slice(4) + '</span></div><div><b>STATUS</b><span>' + (amend ? 'PEMBETULAN' : 'NORMAL') + '</span></div></div>'
        + '<div class="bar">A. IDENTITAS PEMOTONG</div><table class="idt">'
        + '<tr><td>A.1 NPWP/NIK</td><td>:</td><td>' + esc(ident.TIN || '') + '</td></tr><tr><td>A.2 Nama</td><td>:</td><td>' + esc(ident.Name || '') + '</td></tr>'
        + '<tr><td>A.3 Alamat</td><td>:</td><td>' + esc(ident.Address || '') + '</td></tr><tr><td>A.4 No. Telepon</td><td>:</td><td>' + esc(ident.PhoneNo || '') + '</td></tr></table>'
        + sec('A21', '411121-100') + sec('A26', '411127-100')
        + '<div class="d"><div class="h">D. PERNYATAAN DAN TANDA TANGAN PEMOTONG</div><table><tr><td style="width:10mm">D.1</td><td><span class="box">X</span>Wajib Pajak</td><td rowspan="5" style="width:48mm"><div class="sign">DRAFT<br><span style="font-weight:normal;font-size:7pt">belum ditandatangani</span></div></td></tr>'
        + '<tr><td>D.2</td><td><span class="box"></span>Kuasa</td></tr><tr><td>D.3</td><td>Nama :</td></tr><tr><td>D.4</td><td>Tanggal :</td></tr>'
        + '<tr><td>D.5</td><td>Pernyataan Wajib Pajak<br>Dengan menyadari sepenuhnya atas segala akibatnya termasuk sanksi-sanksi sesuai dengan ketentuan yang berlaku, saya menyatakan bahwa apa yang telah saya beritahukan di atas beserta lampiran-lampirannya adalah benar, lengkap dan jelas.</td></tr></table></div>'
        + '<div class="foot">DRAFT dibuat ulang oleh Taxio Pilot dari Konsep SPT di Coretax (posting ' + esc(posting || '-') + ', ' + new Date().toLocaleString('id-ID') + '). Bukan dokumen resmi; belum ditandatangani dan belum dilaporkan.</div></body></html>';
}

/** Induk SPT Masa PPh Unifikasi dibuat ulang 1:1 dengan formulir resmi Coretax (kop, badge INDUK, pita MASA PAJAK / STATUS
 *  SPT, A. identitas, B. tabel per Pasal & KJS dengan kolom B.1-B.8, pernyataan C.1-C.5), dari FormData konsep, bertanda air
 *  DRAFT. FormData Unifikasi: IncomeTaxes = pohon Pasal -> KJS, Total*. */
function indukUnifHtml({ code, model, fd, ident = {}, posting }) {
    const logo = require('fs').readFileSync(require('path').join(__dirname, '../gui/public/assets/kemenkeu-logo.png')).toString('base64');
    const masa = MONTHS[+code.slice(0, 2) - 1] + ' ' + code.slice(4);
    const pasal = (n) => String(n || '').replace(/^Article\s+4\s+Section\s+2$/i, 'PPh Pasal 4 ayat 2').replace(/^Article\s+(\d+)$/i, 'PPh Pasal $1');
    const kjs = (n) => String(n || '').replace(/^KJS:\s*/i, 'KJS : ');
    const num = (x) => '<td class="amt">' + rp(x) + '</td>', grey = '<td class="grey"></td>';
    let rows = '';
    (fd.IncomeTaxes || []).forEach((g, i) => {
        const d = g.data || {}, kids = g.children || [];
        rows += '<tr class="art"><td class="no">' + (d.No || i + 1) + '</td><td>' + esc(pasal(d.Name)) + '</td>' + num(d.TotalSelfPayment) + num(d.TotalWithholding) + num(d.TotalIncomeTaxByGovernment) + num(d.TotalIncomeTaxPaid) + num(d.TotalIncomeTaxPaidPreviousReturn) + num(d.TotalIncomeTaxAmendment) + '</tr>';
        for (const k of kids) { const x = k.data || {}; rows += '<tr><td></td><td>' + esc(kjs(x.Name)) + '</td>' + num(x.TotalSelfPayment) + num(x.TotalWithholding) + grey + num(x.TotalIncomeTaxPaid) + num(x.TotalIncomeTaxPaidPreviousReturn) + num(x.TotalIncomeTaxAmendment) + '</tr>'; }
    });
    rows += '<tr class="tot"><td class="no">' + ((fd.IncomeTaxes || []).length + 1) + '</td><td>Total Pajak Penghasilan</td>' + num(fd.TotalSelfPayment) + num(fd.TotalWithholding) + num(fd.TotalIncomeTaxByGoverment) + num(fd.TotalIncomeTaxPaid) + num(fd.TotalIncomeTaxPaidPreviousReturn) + grey + '</tr>';
    return '<!doctype html><html><head><meta charset="utf-8"><style>'
        + '@page{size:A4;margin:9mm 10mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;font-size:8.4pt;color:#000;margin:0}'
        + '.wm{position:fixed;top:38%;left:8%;font-size:150pt;font-weight:bold;color:rgba(200,0,0,.12);transform:rotate(-32deg);letter-spacing:12pt;z-index:0;pointer-events:none}'
        + '.kop{display:grid;grid-template-columns:auto 1fr auto;align-items:start;column-gap:4mm}.dept{display:flex;align-items:center;gap:3mm;font-size:7.6pt;line-height:1.15;white-space:nowrap}'
        + '.title{text-align:center;font-weight:bold;font-size:11pt;padding-top:1mm}.badge{width:46mm;height:16mm;background:#FFD700;display:flex;align-items:center;justify-content:center;font-size:18pt;font-weight:bold}'
        + '.band{margin-top:3mm;background:#D3D3D3;padding:1.2mm 2mm 1.6mm;display:grid;grid-template-columns:1fr 1fr;column-gap:2.5mm;text-align:center}.band b{display:block;font-size:7.6pt;margin-bottom:.8mm}.band span{display:block;background:#fff;padding:.7mm;font-size:8.4pt;width:70%;margin:0 auto}'
        + '.bar{margin-top:2mm;background:#004080;color:#fff;font-weight:bold;padding:.9mm 2mm;font-size:8.4pt}'
        + '.idt{width:100%;border-collapse:collapse}.idt td{padding:.8mm 2mm;vertical-align:top}.idt td:first-child{width:9mm}.idt td:nth-child(2){width:28mm}.idt td:nth-child(3){width:4mm}'
        + '.t{width:100%;border-collapse:collapse;font-family:"Arial Narrow",Arial,sans-serif}.t th{background:#D3D3D3;font-weight:bold;font-size:7.4pt;padding:1mm;text-align:center;vertical-align:top}.t tr.code td{background:#D3D3D3;font-size:5.8pt;text-align:center;padding:0 1mm .6mm}'
        + '.t td{padding:1.1mm 1.5mm;border-bottom:1px solid #e3e3e3}.t td.no{width:8mm;text-align:center}.t td.amt{text-align:right}.t td.grey{background:#A9A9A9}.t tr.art td{border-top:1px solid #888}.t tr.tot td{font-weight:bold;border-top:1px solid #888}'
        + '.d{margin-top:3mm;border:1px solid #999}.d .h{text-align:center;font-weight:bold;padding:1.4mm}.d table{width:100%;border-collapse:collapse}.d td{padding:1mm 2mm;vertical-align:top}'
        + '.sign{border:1px dashed #c00000;color:#c00000;text-align:center;font-weight:bold;padding:4mm 2mm}.foot{margin-top:3mm;font-size:6.5pt;color:#555}</style></head><body><div class="wm">DRAFT</div>'
        + '<div class="kop"><div class="dept"><img src="data:image/png;base64,' + logo + '" style="width:13.7mm;height:13mm;object-fit:contain"><div>KEMENTERIAN KEUANGAN<br>REPUBLIK INDONESIA<br><b>DIREKTORAT JENDERAL PAJAK</b></div></div>'
        + '<div class="title">SURAT PEMBERITAHUAN MASA PPH UNIFIKASI</div><div class="badge">INDUK</div></div>'
        + '<div class="band"><div><b>MASA PAJAK</b><span>' + masa + '</span></div><div><b>STATUS SPT</b><span>' + (model === 'AMENDMENT' ? 'PEMBETULAN' : 'NORMAL') + '</span></div></div>'
        + '<div class="bar">A. IDENTITAS PEMOTONG DAN/ATAU PEMUNGUT PPH</div><table class="idt">'
        + '<tr><td>A.1</td><td>NPWP/NIK</td><td>:</td><td>' + esc(ident.TIN || '') + '</td></tr><tr><td>A.2</td><td>NAMA</td><td>:</td><td>' + esc(ident.Name || '') + '</td></tr>'
        + '<tr><td>A.3</td><td>ALAMAT</td><td>:</td><td>' + esc(ident.Address || '') + '</td></tr><tr><td>A.4</td><td>NO. TELEPON</td><td>:</td><td>' + esc(ident.PhoneNo || '') + '</td></tr></table>'
        + '<div class="bar">B. PAJAK PENGHASILAN</div><table class="t"><tr><th rowspan="2">NO</th><th rowspan="2">DETIL</th><th colspan="2">PAJAK PENGHASILAN</th><th rowspan="2">PPH YANG DITANGGUNG PEMERINTAH</th><th rowspan="2">JUMLAH PPH YANG HARUS DISETOR</th><th rowspan="2">JUMLAH PPH YANG TELAH DISETOR PADA SPT YANG DIBETULKAN</th><th rowspan="2">PPH KURANG (LEBIH) SETOR KARENA PEMBETULAN</th></tr>'
        + '<tr><th>SETOR SENDIRI</th><th>PEMOTONGAN DAN/ATAU PEMUNGUTAN PPH</th></tr><tr class="code"><td>B.1</td><td>B.2</td><td>B.3</td><td>B.4</td><td>B.5</td><td>B.6</td><td>B.7</td><td>B.8</td></tr>' + rows + '</table>'
        + '<div class="d"><div class="h">PERNYATAAN DAN TANDA TANGAN</div><table><tr><td style="width:9mm">C.1</td><td colspan="3">Wajib Pajak</td><td rowspan="4" style="width:46mm">C.5 QR Code :<div class="sign">DRAFT<br><span style="font-weight:normal;font-size:7pt">belum ditandatangani</span></div></td></tr>'
        + '<tr><td>C.2</td><td style="width:22mm">NAMA</td><td style="width:4mm">:</td><td></td></tr><tr><td>C.3</td><td>TANGGAL</td><td>:</td><td></td></tr>'
        + '<tr><td>C.4</td><td colspan="3">PERNYATAAN WAJIB PAJAK<br>Dengan menyadari sepenuhnya akan segala akibatnya termasuk sanksi-sanksi sesuai dengan ketentuan perundang-undangan yang berlaku, saya menyatakan bahwa apa yang telah saya beritahukan di atas beserta lampiran-lampirannya adalah benar, lengkap dan jelas</td></tr></table></div>'
        + '<div class="foot">DRAFT dibuat ulang oleh Taxio Pilot dari Konsep SPT di Coretax (' + esc(posting || 'posting') + ', ' + new Date().toLocaleString('id-ID') + '). Bukan dokumen resmi; belum ditandatangani dan belum dilaporkan.</div></body></html>';
}

/** Posting (opsional) lalu unduh konsep. opts: {taxType, period, post, saveRoot, entityName, entityCode, entityNpwp, emit}. */
async function downloadKonsep(page, { taxType = 'ICT_WIT', period, post = false, outDir, entityName, entityCode, entityNpwp, emit = () => {} }) {
    const kind = KINDS[taxType]; if (!kind) throw new Error('Jenis SPT konsep: ICT_WIT (PPh 21/26) atau ICT_WT (Unifikasi).');
    const code = periodCode(period), s = await session(page);
    let row = await findKonsep(s, taxType, code);
    let fd = null, posting = '', ident = {};
    // Stop / Jeda: sebelum Posting (satu permintaan tulis), di tiap putaran menunggu status posting, sebelum unduh lampiran
    // (lalu di antara tab / halaman lampiran - lib/lampiran-download.js, lib/lampiran-capture.js).
    const runcontrol = require('./runcontrol');
    let posted = false;
    const safePoint = async (what) => {
        try { return await runcontrol.checkpoint(); }
        catch (e) {
            if (e && e.isStop) emit('Dihentikan ' + what + ': ' + (post ? (posted ? 'Posting SUDAH dikirim ke Coretax' + (posting ? ' (status ' + posting + ')' : '') : 'Posting belum dikirim') + '; ' : '') + 'konsep belum diunduh.');
            throw e;
        }
    };
    if (post) {
        await safePoint('sebelum Posting');
        const [u, b] = kind.post(row.RecordId);
        emit('Posting Konsep SPT ' + kind.label + ' masa ' + code + '...');
        const r = await s.post(RS + u, { ...b, TaxpayerAggregateIdentifier: s.taxpayerId });
        if (!(r.status === 200 && r.json && r.json.IsSuccessful)) throw new Error('Posting ditolak Coretax: ' + ((r.json && r.json.Message) || 'HTTP ' + r.status));
        posted = true;
        fd = r.json.Payload && r.json.Payload.FormData ? JSON.parse(r.json.Payload.FormData) : null;
    }
    if (kind.status) {
        // Status posting (sama dengan saat form dibuka): tunggu selesai bila sedang berjalan.
        for (let i = 0; i < 60; i++) {
            if (i) await safePoint('saat menunggu status posting');
            const [u, b] = kind.status(row.RecordId);
            const r = await s.post(RS + u, { ...b, TaxpayerAggregateIdentifier: s.taxpayerId });
            const P = (r.json && r.json.Payload) || {};
            if (P.FormData) fd = JSON.parse(P.FormData);
            if (P.TIN) ident = { TIN: P.TIN, Name: P.Name, Address: P.Address, PhoneNo: P.PhoneNo };
            if (P.PrefillStatus === undefined) { posting = posting || ''; }
            posting = P.PrefillStatus ? P.PrefillStatus + (P.PrefillLastUpdated ? ' ' + P.PrefillLastUpdated : '') : 'belum pernah';
            if (!P.PrefillStatus || /COMPLETED|FAILED/i.test(P.PrefillStatus)) break;
            await page.waitForTimeout(3000);
        }
        emit('Status posting: ' + posting + '.');
        if (/FAILED/i.test(posting)) throw new Error('Posting di Coretax gagal (status FAILED) - coba Posting SPT lagi di form konsep.');
    }
    // Lampiran: alat unduh SPT yang ada, pada form konsep.
    await safePoint('sebelum unduh lampiran');
    const tp = s.taxpayerId;
    await page.goto('https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/' + kind.route(tp, row), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    fs.mkdirSync(outDir, { recursive: true });
    const lampiran = require('../automation/lampiran');
    emit('Unduh lampiran konsep (alat unduh SPT)...');
    const lr = await lampiran.downloadLampiran(page, { outputDir: outDir, saveRoot: outDir, entityName, entityCode, entityNpwp, lampiranFormat: 'both', fileSuffix: '' }, tp, row.RecordId, taxType, 'full', '', 'combined');
    // downloadLampiran mengembalikan galatnya sebagai { ok: false } - Stop di tengah lampiran tetap Stop (bukan "gagal").
    if (!lr.ok && runcontrol.stopRequested()) await safePoint('saat mengunduh lampiran');
    if (!lr.ok) throw new Error('Lampiran konsep gagal diunduh: ' + lr.error);
    // Induk dibuat ulang (PPh 21/26), digabung di depan lampiran.
    const stem = (entityCode ? entityCode + ' - ' : '') + 'Konsep SPT ' + kind.label.replace('/', '-') + ' ' + code.slice(0, 2) + code.slice(6);
    let combined = lr.combinedPath || (lr.paths || []).find((p) => /\.pdf$/i.test(p));
    // Alamat / telepon: respons Unifikasi tidak memuatnya - ambil dari profil wajib pajak (sama dengan yang dibaca form).
    if (fd && ident.TIN && !ident.Address) {
        try {
            const g = await s.post('https://coretaxdjp.pajak.go.id/registrationportal/api/generalinformation/view', { AggregateIdentifier: tp });
            const P = (g.json && g.json.Payload) || {}, find = (re) => { for (const [k, v] of Object.entries(P)) if (re.test(k) && typeof v === 'string' && v) return v; return ''; };
            ident.Address = find(/^(Full)?Address$|AddressDetail|^Alamat/i); ident.PhoneNo = find(/Phone|Telp|Telepon/i);
        } catch (e) {}
    }
    if (fd) {
        const indukPdf = path.join(outDir, stem + ' - Induk (DRAFT).pdf');
        const who = ident.TIN ? ident : { TIN: entityNpwp, Name: entityName };
        await require('./html-to-pdf').renderHtmlToPdf((taxType === 'ICT_WIT' ? indukHtml : indukUnifHtml)({ code, model: row.ReturnSheetModel, fd, ident: who, posting }), indukPdf);
        if (combined) {
            const merged = await lampiran.mergePdfs([fs.readFileSync(indukPdf), fs.readFileSync(combined)]);
            combined = path.join(outDir, stem + ' (KONSEP).pdf'); fs.writeFileSync(combined, merged);
        } else combined = indukPdf;
    }
    const excel = lr.excelPath || (lr.paths || []).find((p) => /\.xlsx$/i.test(p)) || null;
    return { ok: true, period: code, model: row.ReturnSheetModel, posting, pdf: combined, excel, dir: outDir,
        totals: fd && taxType === 'ICT_WIT' ? { pph21: fd.A21IncomeTaxWithheld, pph26: fd.A26IncomeTaxWithheld, l1aGross: ((fd.Form1A || {}).GrossIncomeAndIncomeTaxWithheld || {}).GrossIncome, l3Gross: ((fd.Form3 || {}).Article21GrossIncomeAndIncomeTaxWithheld || {}).GrossIncome } : null };
}

module.exports = { downloadKonsep, indukHtml, indukUnifHtml, KINDS };
