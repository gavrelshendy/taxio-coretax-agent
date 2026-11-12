/* Upload Format Impor Coretax (BPMP, BP21, BPA1, BPPU) dan Buat Konsep SPT - lihat docs/coretax-upload-konsep.md.
 *
 * Masukan: Excel template impor DJP (tabel dengan XML map: setiap kolom terikat ke elemen XML, mis. "Penghasilan Kotor"
 * -> Gross) atau file XML impor. Jenis dikenali dari elemen root (MmPayrollBulk, Bp21Bulk, A1Bulk, BpuBulk); XML disusun
 * dengan urutan elemen template resmi Coretax.
 * Upload: satu langkah (validate-upload-xml = validasi + buat di Belum Terbit, berjalan di latar); hasilnya dibaca dari
 * XML monitoring. TIDAK menerbitkan / menandatangani apa pun.
 * Konsep SPT: POST /createreturnsheet (Normal atau Pembetulan sesuai pilihan Coretax), tanpa lapor / tanda tangan. */
const JSZip = require('jszip');


const EB_API = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';
const RS_API = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const EB_PAGE = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotmp/issued';
const RS_PAGE = 'https://coretaxdjp.pajak.go.id/returnsheets-portal/id-ID/submitted-returnsheets';

/** Urutan elemen = template resmi Coretax (DownloadWithholdingSlips/download-template). */
const TYPES = {
    mp: { label: 'BPMP', ebupot: 'EBUPOTMP', root: 'MmPayrollBulk', list: 'ListOfMmPayroll', item: 'MmPayroll', spt: 'ICT_WIT',
        fields: ['TaxPeriodMonth', 'TaxPeriodYear', 'CounterpartOpt', 'CounterpartPassport', 'CounterpartTin', 'StatusTaxExemption', 'Position', 'TaxCertificate', 'TaxObjectCode', 'Gross', 'Rate', 'IDPlaceOfBusinessActivity', 'WithholdingDate'] },
    bp21: { label: 'BP21', ebupot: 'EBUPOTBP21', root: 'Bp21Bulk', list: 'ListOfBp21', item: 'Bp21', spt: 'ICT_WIT',
        fields: ['TaxPeriodMonth', 'TaxPeriodYear', 'CounterpartTin', 'IDPlaceOfBusinessActivityOfIncomeRecipient', 'StatusTaxExemption', 'TaxCertificate', 'TaxObjectCode', 'Gross', 'Deemed', 'Rate', 'Document', 'DocumentNumber', 'DocumentDate', 'IDPlaceOfBusinessActivity', 'WithholdingDate'] },
    bpa1: { label: 'BPA1', ebupot: 'EBUPOTBPA1', root: 'A1Bulk', list: 'ListOfA1', item: 'A1', spt: 'ICT_WIT',
        fields: ['WorkForSecondEmployer', 'TaxPeriodMonthStart', 'TaxPeriodMonthEnd', 'TaxPeriodYear', 'CounterpartOpt', 'CounterpartPassport', 'CounterpartTin', 'TaxExemptOpt', 'StatusOfWithholding', 'CounterpartPosition', 'TaxObjectCode', 'NumberOfMonths', 'SalaryPensionJhtTht', 'GrossUpOpt', 'IncomeTaxBenefit', 'OtherBenefit', 'Honorarium', 'InsurancePaidByEmployer', 'Natura', 'TantiemBonusThr', 'PensionContributionJhtThtFee', 'Zakat', 'PrevWhTaxSlip', 'TaxCertificate', 'Article21IncomeTax', 'IDPlaceOfBusinessActivity', 'WithholdingDate'] },
    bpu: { label: 'BPPU', ebupot: 'EBUPOTBPU', root: 'BpuBulk', list: 'ListOfBpu', item: 'Bpu', spt: 'ICT_WT',
        fields: ['TaxPeriodMonth', 'TaxPeriodYear', 'CounterpartTin', 'IDPlaceOfBusinessActivityOfIncomeRecipient', 'TaxCertificate', 'TaxObjectCode', 'TaxBase', 'Rate', 'Document', 'DocumentNumber', 'DocumentDate', 'IDPlaceOfBusinessActivity', 'GovTreasurerOpt', 'SP2DNumber', 'WithholdingDate'] }
};
const byRoot = (root) => Object.keys(TYPES).find((k) => TYPES[k].root === root) || null;
const DATE_FIELDS = new Set(['WithholdingDate', 'DocumentDate']);
const TIN_FIELDS = new Set(['CounterpartTin']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Nilai sel Excel -> teks elemen XML. */
function cellText(field, v) {
    if (v && typeof v === 'object' && !(v instanceof Date)) v = 'result' in v ? v.result : v.richText ? v.richText.map((r) => r.text).join('') : 'text' in v ? v.text : v;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) { const p = (n) => String(n).padStart(2, '0'); return v.getUTCFullYear() + '-' + p(v.getUTCMonth() + 1) + '-' + p(v.getUTCDate()); }
    if (typeof v === 'number') return TIN_FIELDS.has(field) ? v.toFixed(0) : String(Math.round(v * 1e8) / 1e8);
    let s = String(v).trim();
    if (DATE_FIELDS.has(field)) { const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s); if (m) s = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
    return s;
}

/** XML impor dari baris {elemen: teks}. */
function buildXml(type, tin, rows) {
    const t = TYPES[type];
    const item = (r) => '    <' + t.item + '>\n' + t.fields.map((f) => { const v = r[f] == null ? '' : String(r[f]); return '      ' + (v === '' ? '<' + f + ' />' : '<' + f + '>' + esc(v) + '</' + f + '>'); }).join('\n') + '\n    </' + t.item + '>';
    return '<?xml version="1.0" encoding="utf-8"?>\n<' + t.root + ' xsi:noNamespaceSchemaLocation="schema.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <TIN>' + esc(tin) + '</TIN>\n  <' + t.list + '>\n'
        + rows.map(item).join('\n') + '\n  </' + t.list + '>\n</' + t.root + '>\n';
}

/** File XML impor -> {type, tin, count, xml}. */
function readXml(buf) {
    const xml = buf.toString('utf8').replace(/^﻿/, '');
    const root = (/<([A-Za-z0-9]+)[\s>][\s\S]*?<TIN>/.exec(xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '')) || [])[1];
    const type = byRoot(root);
    if (!type) throw new Error('XML tidak dikenali (root "' + (root || '?') + '"). Yang didukung: ' + Object.values(TYPES).map((t) => t.root + ' (' + t.label + ')').join(', ') + '.');
    const tin = ((/<TIN>\s*([^<]*?)\s*<\/TIN>/.exec(xml) || [])[1] || '').trim();
    const count = (xml.match(new RegExp('<' + TYPES[type].item + '>', 'g')) || []).length;
    return { type, tin, count, xml, source: 'xml' };
}

/** Excel template impor DJP -> {type, tin, count, rows, xml}. Kolom dibaca lewat XML map tabel (xpath), bukan judul kolom. */
async function readExcel(buf) {
    const zip = await JSZip.loadAsync(buf);
    const txt = async (n) => (zip.file(n) ? zip.file(n).async('string') : '');
    const wbXml = await txt('xl/workbook.xml'), wbRels = await txt('xl/_rels/workbook.xml.rels');
    const sheetOfFile = new Map(); // 'xl/worksheets/sheet1.xml' -> nama sheet
    for (const m of wbXml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
        const tgt = (new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"').exec(wbRels) || new RegExp('Target="([^"]+)"[^>]*Id="' + m[2] + '"').exec(wbRels) || [])[1];
        if (tgt) sheetOfFile.set('xl/' + tgt.replace(/^\/?xl\//, ''), m[1].replace(/&amp;/g, '&'));
    }
    const sheetOfPart = new Map(); // 'xl/tables/table1.xml' -> nama sheet
    for (const [file, name] of sheetOfFile) {
        const rels = await txt(file.replace(/worksheets\//, 'worksheets/_rels/') + '.rels');
        // Target relatif ("../tables/table1.xml") atau absolut ("/xl/tables/table1.xml").
        for (const m of rels.matchAll(/Target="([^"]+)"/g)) sheetOfPart.set(m[1].startsWith('/') ? m[1].slice(1) : 'xl/' + m[1].replace(/^\.\.\//, ''), name);
    }
    let table = null;
    for (const n of Object.keys(zip.files).filter((x) => /^xl\/tables\/table\d+\.xml$/.test(x))) {
        const x = await txt(n), cols = [...x.matchAll(/<tableColumn [^>]*?(?:\/>|>([\s\S]*?)<\/tableColumn>)/g)].map((m) => { const xp = (/xpath="([^"]+)"/.exec(m[1] || '') || [])[1]; return xp || null; });
        const root = cols.map((xp) => xp && xp.split('/')[1]).find(Boolean);
        if (byRoot(root)) { table = { part: n, ref: (/ref="([A-Z]+\d+:[A-Z]+\d+)"/.exec(x) || [])[1], cols, type: byRoot(root), header: !/headerRowCount="0"/.test(x) }; break; }
    }
    if (!table) throw new Error('Excel tidak memuat tabel impor Coretax (XML map). Pakai template impor DJP (sheet DATA) atau unggah file XML-nya.');
    const sheetName = sheetOfPart.get(table.part);
    // Sel dibaca langsung dari XML sheet (ExcelJS gagal memuat sebagian template DJP).
    const shared = [...(await txt('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
    const sheetCells = async (name) => {
        const file = [...sheetOfFile].find(([, n]) => n === name); const x = file ? await txt(file[0]) : '';
        const cells = new Map();
        for (const m of x.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = m[2], body = m[3] || '', t = (/\st="([^"]+)"/.exec(attrs) || [])[1];
            const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1], is = (/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body) || [])[1];
            cells.set(m[1], t === 's' ? shared[+v] : t === 'inlineStr' ? is : t === 'str' || t === 'e' ? v : t === 'b' ? v === '1' : v === undefined ? null : Number(v));
        }
        return cells;
    };
    const ws = await sheetCells(sheetName);
    const colL = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
    const [a, b] = table.ref.split(':'), colN = (s) => s.replace(/\d+/g, '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const c0 = colN(a), r0 = +a.replace(/\D/g, '') + (table.header ? 1 : 0), r1 = +b.replace(/\D/g, '');
    const fields = table.cols.map((xp) => xp && xp.split('/').pop());
    const serialDate = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    const rows = [];
    for (let r = r0; r <= r1; r++) {
        const o = {}; let any = false;
        fields.forEach((f, i) => { if (!f) return; let raw = ws.get(colL(c0 + i) + r); if (typeof raw === 'number' && DATE_FIELDS.has(f)) raw = serialDate(raw); const v = cellText(f, raw); o[f] = v; if (v !== '') any = true; });
        if (any) rows.push(o);
    }
    // TIN pemotong: sel tunggal ber-XML map (tableSingleCells), bila ada.
    let tin = '';
    for (const n of Object.keys(zip.files).filter((x) => /^xl\/tables\/tableSingleCells\d+\.xml$/.test(x))) {
        const x = await txt(n), m = /<singleXmlCell [^>]*r="([A-Z]+\d+)"[\s\S]*?xpath="\/[A-Za-z0-9]+\/TIN"/.exec(x);
        if (m) { const sws = await sheetCells(sheetOfPart.get(n) || sheetName); tin = cellText('CounterpartTin', sws.get(m[1])); }
    }
    return { type: table.type, tin, count: rows.length, rows, sheet: sheetName, source: 'excel' };
}

/** Excel atau XML -> data siap unggah untuk entitas berNPWP `npwp` (TIN di file harus sama; kosong = diisi NPWP entitas). */
async function prepare(buf, fileName, npwp) {
    const isXml = /\.xml$/i.test(fileName || '') || /^\s*(﻿)?<\?xml|^\s*</.test(buf.slice(0, 64).toString('utf8'));
    const d = isXml ? readXml(buf) : await readExcel(buf);
    const want = String(npwp || '').replace(/\D/g, '');
    const tin = String(d.tin || '').replace(/\D/g, '');
    if (tin && want && tin !== want && !(tin.length === 15 && '0' + tin === want)) throw new Error('NPWP pemotong di file (' + d.tin + ') berbeda dengan NPWP entitas (' + npwp + ') - file untuk entitas lain?');
    const useTin = tin.length === 15 ? '0' + tin : (tin || want);
    if (!/^\d{16}$/.test(useTin)) throw new Error('NPWP pemotong tidak terbaca (isi TIN di file, atau pilih entitas).');
    const problems = [];
    if (d.rows) d.rows.forEach((r, i) => {
        if (r.CounterpartTin !== undefined && r.CounterpartOpt !== 'Foreign' && !/^\d{16}$/.test(String(r.CounterpartTin))) problems.push('baris ' + (i + 1) + ': NPWP/NIK penerima "' + r.CounterpartTin + '" bukan 16 digit');
    });
    if (!d.count) throw new Error('Tidak ada baris data di file.');
    const xml = d.xml && d.tin === useTin ? d.xml : d.rows ? buildXml(d.type, useTin, d.rows) : d.xml.replace(/<TIN>[^<]*<\/TIN>/, '<TIN>' + useTin + '</TIN>');
    return { ...d, tin: useTin, xml, label: TYPES[d.type].label, problems };
}

// ---------- sesi Coretax (dari halaman yang sudah login & impersonate) ----------
async function apiSession(page, url, apiPart) {
    const context = page.context(), auth = {};
    const on = (req) => { if (!req.url().includes(apiPart)) return; const h = req.headers(); if (h.authorization) auth.authorization = h.authorization; if (h['x-dgt-code']) auth.dgtCode = h['x-dgt-code']; };
    context.on('request', on);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        for (let i = 0; i < 80 && !auth.authorization; i++) await page.waitForTimeout(500);
    } finally { context.off('request', on); }
    if (!auth.authorization) throw new Error('Sesi Coretax tidak tertangkap (' + apiPart + ') - pastikan jendela PIC sudah login.');
    const claims = JSON.parse(Buffer.from(auth.authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    const H = { Authorization: auth.authorization, ...(auth.dgtCode ? { 'x-dgt-code': auth.dgtCode } : {}) };
    const post = (u, body) => page.evaluate(async ([u, body, H]) => {
        const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j };
    }, [u, body, H]);
    const postFile = (u, fields, fileName, text) => page.evaluate(async ([u, fields, fileName, text, H]) => {
        const fd = new FormData(); fd.append('file', new Blob([text], { type: 'text/xml' }), fileName); for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const r = await fetch(u, { method: 'POST', credentials: 'include', headers: H, body: fd }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j };
    }, [u, fields, fileName, text, H]);
    return { taxpayerId: claims.taxpayer_id, claims, post, postFile };
}

/** Unggah XML ke Belum Terbit dan tunggu hasil XML monitoring. Hasil: {status, ok, created, errors[], message}. */
async function upload(page, prepared, { fileName, emit = () => {}, timeoutMs = 300000 } = {}) {
    const t = TYPES[prepared.type];
    const s = await apiSession(page, EB_PAGE.replace('/ebupotmp/', '/ebupot' + prepared.type + '/'), '/withholdingslipsportal/api/');
    const name = fileName || (t.label + ' ' + prepared.tin + ' Pilot ' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.xml');
    const started = Date.now() - 60000;
    emit('Upload ' + t.label + ': ' + prepared.count + ' bukti potong (' + name + ')...');
    const r = await s.postFile(EB_API + '/uploadcreateebupot' + prepared.type + '/validate-upload-xml', { TaxpayerAggregateIdentifier: s.taxpayerId }, name, prepared.xml);
    if (r.status !== 200 || !(r.json && r.json.IsSuccessful)) throw new Error('Upload ditolak Coretax: HTTP ' + r.status + (r.json && r.json.Message ? ' - ' + r.json.Message : ''));
    // Diproses di latar: baca XML monitoring sampai file ini selesai / gagal.
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        await page.waitForTimeout(3000);
        const m = await s.post(EB_API + '/withholdingslipsxmlmonitoring/xml-monitoring', { TaxpayerAggregateIdentifier: s.taxpayerId, EbupotType: t.ebupot });
        const list = (m.json && m.json.Payload && (Array.isArray(m.json.Payload) ? m.json.Payload : m.json.Payload.Data)) || [];
        const mine = list.filter((x) => x.FileName === name && Date.parse(x.CreationDate) >= started).sort((a, b) => Date.parse(b.CreationDate) - Date.parse(a.CreationDate))[0];
        if (!mine) continue;
        if (!last || last.Status !== mine.Status) emit('Upload ' + t.label + ': ' + mine.Status + '.');
        last = mine;
        if (/FINISHED|FAILED|ERROR/i.test(mine.Status)) break;
    }
    if (!last) return { ok: false, status: 'UNKNOWN', created: 0, errors: [], message: 'File terkirim, tetapi belum muncul di XML monitoring - cek menu Monitoring > XML di Coretax.', fileName: name };
    let errors = [];
    if (/FAILED|ERROR/i.test(last.Status)) { try { errors = JSON.parse(last.ErrorMessage); } catch (e) { errors = [{ Message: last.ErrorMessage }]; } }
    const created = Number((/(\d+)\s+EBUPOT\w*\s+successfully created/i.exec(last.ErrorMessage || '') || [])[1] || 0);
    return { ok: /FINISHED/i.test(last.Status) && !errors.length, status: last.Status, created, errors, message: last.ErrorMessage || '', fileName: name };
}

/** Buat Konsep SPT Masa (PPh 21/26 `ICT_WIT` atau Unifikasi `ICT_WT`) untuk masa "MMMMYYYY" / "MMYYYY"; model Normal atau
 *  Pembetulan sesuai pilihan Coretax. Hasil: {ok, model, message}. Tidak melapor / menandatangani. */
async function createKonsep(page, { taxType = 'ICT_WIT', period, emit = () => {} }) {
    const p = String(period || '').replace(/\D/g, '');
    const code = /^\d{8}$/.test(p) ? p : /^\d{6}$/.test(p) ? p.slice(0, 2) + p.slice(0, 2) + p.slice(2) : /^\d{4}$/.test(p) ? p.slice(0, 2) + p.slice(0, 2) + '20' + p.slice(2) : null;
    if (!code) throw new Error('Masa tidak valid: ' + period + ' (pakai MMYY, MMYYYY atau MMMMYYYY).');
    const s = await apiSession(page, RS_PAGE, '/returnsheetportal/api/');
    const details = (r) => (r.json && r.json.Payload && (r.json.Payload.Details || r.json.Payload.Data || r.json.Payload)) || [];
    const types = details(await s.post(RS_API + '/createreturnsheetreturnsheettypes', { TaxTypeCode: taxType }));
    const rst = (types[0] || {}).Code; if (!rst) throw new Error('Jenis SPT untuk ' + taxType + ' tidak tersedia.');
    const periods = details(await s.post(RS_API + '/createreturnsheettaxperiods', { TaxpayerAggregateIdentifier: s.taxpayerId, TaxTypeCode: taxType, ReturnSheetPeriodTypeCode: null, TaxObjectNumber: null }));
    if (Array.isArray(periods) && periods.length && !periods.some((x) => x.Code === code)) throw new Error('Masa ' + code + ' tidak tersedia untuk Buat Konsep SPT di Coretax.');
    const models = details(await s.post(RS_API + '/createreturnsheetreturnsheetmodels', { TaxpayerAggregateIdentifier: s.taxpayerId, TaxTypeCode: taxType, PeriodCode: code, ReturnSheetTypeCode: rst, TaxObjectNumber: '' }));
    const model = (models[0] || {}).Code; if (!model) throw new Error('Coretax tidak memberi pilihan Normal / Pembetulan untuk masa ' + code + ' (mungkin konsepnya sudah ada).');
    emit('Buat Konsep SPT ' + rst + ' masa ' + code + ' (' + model + ')...');
    const body = { TaxpayerAggregateIdentifier: s.taxpayerId, TaxPeriodCode: code, TaxTypeCode: taxType, ReturnSheetTypeCode: rst, ReturnSheetModelCode: model, TaxObjectNumber: '', isEffFlag: true, ReturnSheetPeriodType: null };
    let r = await s.post(RS_API + '/createreturnsheet', body);
    if (r.json && !r.json.IsSuccessful && /criteria|kriteria/i.test(r.json.Message || '')) r = await s.post(RS_API + '/createreturnsheet', { ...body, isEffFlag: false });
    const ok = r.status === 200 && !!(r.json && r.json.IsSuccessful);
    return { ok, model, period: code, returnSheetType: rst, message: (r.json && r.json.Message) || (ok ? '' : 'HTTP ' + r.status) };
}

module.exports = { TYPES, buildXml, readXml, readExcel, prepare, upload, createKonsep, cellText };
