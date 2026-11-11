/* Ubah isian dan batalkan BPMP Telah Terbit lewat API Coretax - untuk MCP (mcp/taxio-pilot-mcp.js) dan GUI.
 *
 * Ubah (pembetulan): jalur yang sama dengan Pembetulan NIK (automation/bpmp-amend.js, /amendebupotmp, terbukti live
 * 2026-10-19), tetapi isian yang boleh berubah: Status PTKP, bruto, tarif (TER), posisi. PPh dihitung ulang =
 * bulat(bruto x tarif / 100) - sama dengan Coretax (contoh nyata: 7.572.265 x 1,5% = 113.583,975 -> 113.584).
 * Nomor bukti potong tetap, status menjadi Pembetulan (AMENDMENT).
 * Sumber perubahan: daftar {nomor, isian baru} ATAU file revisi (XML / Excel template impor BPMP): baris file dicocokkan
 * ke BPMP Telah Terbit masa yang sama menurut NIK + kode objek pajak.
 *
 * Pengaman: pratinjau (sebelum -> sesudah per bukti potong) memberi kode konfirmasi = sidik isi rencana; kirim hanya
 * bila rencana yang disusun ulang saat kirim menghasilkan kode yang sama (Coretax belum berubah sejak pratinjau).
 * Setiap bukti potong dicadangkan (JSON) sebelum dikirim, diperiksa ulang sesudahnya, dan proses berhenti di kegagalan
 * pertama. Batalkan: /cancelebupotmp (lib/ebupot-vs-spt.js cancelOne), juga dengan pratinjau + kode. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';
const PTKP = ['TK0', 'TK1', 'TK2', 'TK3', 'K0', 'K1', 'K2', 'K3'];
// Kategori TER (PP 58/2023): ganti PTKP lintas kategori mengubah tarif - tarif baru wajib disebut.
const TER = { TK0: 'A', TK1: 'A', K0: 'A', TK2: 'B', TK3: 'B', K1: 'B', K2: 'B', K3: 'C' };
const FIELDS = { ptkp: 'TaxExemptionStatus', gross: 'GrossIncome', rate: 'TaxRate', position: 'Position' };
const MAX = 300;

const normPtkp = (v) => { const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return PTKP.includes(s) ? s : null; };
const num = (v) => { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(/,/g, '.')); return Number.isFinite(n) ? n : null; };
const taxOf = (gross, rate) => Math.round(gross * rate / 100);

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

const slim = (r) => ({ number: r.WithholdingSlipsNumber, period: String(r.TaxPeriodCode || '').slice(0, 2) + '/' + String(r.TaxPeriodCode || '').slice(4), nik: r.TaxIdentificationNumber, name: String(r.Name || '').trim(),
    ptkp: r.TaxExemptionStatus || null, taxObject: r.TaxObjectCode, gross: r.GrossIncome, rate: r.TaxRate, tax: r.IncomeTaxWithheld, position: r.Position ? String(r.Position).trim() : null,
    status: r.WithholdingSlipsStatus, reportedInSpt: !!r.IsReportedToTaxReturn });

// page.__session: sesi tiruan untuk tes (scripts/test-ebupot-edit.js).
async function session(page, npwp) { return page.__session || require('../automation/bpmp-amend').openSession(page.context(), npwp); }
async function view(s, recordId) {
    const r = await s.post(API + '/viewebupotmp',{ RecordId: recordId });
    const v = r.json && r.json.Payload && r.json.Payload.Result;
    if (!v || v.RecordId !== recordId) throw new Error('Detail bukti potong tidak terbaca (HTTP ' + r.status + ').');
    return v;
}

// Jenis yang bisa dicari: daftar Telah Terbit / Belum Terbit (endpoint sama dengan lib/coretax-issue.js, automation/ebupot.js).
const KINDS = { mp: 'BPMP', bp21: 'BP21', bpa1: 'BPA1', bpu: 'BPPU' };
const grossOf = (r) => r.GrossIncome ?? r.TaxBase ?? r.SalaryPensionJhtTht ?? null;
const taxOfRow = (r) => r.IncomeTaxWithheld ?? r.IncomeTax ?? r.Article21IncomeTax ?? null;

/** Bukti potong satu jenis & masa (Telah Terbit, atau Belum Terbit bila issued=false), disaring NIK / sebagian nama / nomor.
 *  Hanya membaca. Detail (PTKP, posisi) dibuka untuk BPMP. */
async function find(page, { npwp, type = 'mp', issued = true, period, nik, name, numbers, detail = false }) {
    if (!KINDS[type]) throw new Error('Jenis tidak dikenal: ' + type + ' (mp, bp21, bpa1, bpu).');
    const p = periodOf(period), s = await session(page, npwp);
    try {
        let rows = await s.list('getebupot' + type + (issued === false ? 'notissued' : 'issued'), p.code, type === 'bpa1' ? 'IncomePeriodCodeEnd' : 'TaxPeriodCode');
        if (type !== 'mp' || issued === false) detail = false;
        const nums = new Set((numbers || []).map(String)), q = String(name || '').trim().toUpperCase();
        if (nik) rows = rows.filter((r) => r.TaxIdentificationNumber === String(nik).replace(/\D/g, ''));
        if (q) rows = rows.filter((r) => String(r.Name || '').toUpperCase().includes(q));
        if (nums.size) rows = rows.filter((r) => nums.has(String(r.WithholdingSlipsNumber)));
        const total = rows.length;
        rows = rows.slice(0, MAX);
        // Daftar Coretax tidak selalu memuat PTKP / posisi - detail dibuka bila diminta (atau hasilnya sedikit).
        if (type === 'mp' && issued !== false && (detail || rows.length <= 40)) rows = await Promise.all(rows.map(async (r) => ({ ...r, ...(await view(s, r.RecordId).catch(() => ({}))) })));
        const out = rows.map((r) => ({ ...slim(r), gross: grossOf(r), tax: taxOfRow(r), ...(r.DocumentNumber ? { document: r.DocumentNumber } : {}) }));
        return { type: KINDS[type], state: issued === false ? 'Belum Terbit' : 'Telah Terbit', period: p.label, total, shown: out.length, slips: out,
            totals: { gross: out.reduce((a, r) => a + (r.gross || 0), 0), tax: out.reduce((a, r) => a + (r.tax || 0), 0) } };
    } finally { await s.close(); }
}

/** Baris file revisi (XML / Excel template impor BPMP) -> [{period, nik, taxObject, ptkp, gross, rate, position}]. */
async function readRevision(filePath, npwp) {
    const imp = require('./coretax-import');
    const buf = fs.readFileSync(filePath);
    const d = await imp.prepare(buf, path.basename(filePath), npwp);
    if (d.type !== 'mp') throw new Error('File revisi harus BPMP (MmPayroll); file ini ' + d.label + '.');
    let rows = d.rows;
    if (!rows) {
        rows = [...d.xml.matchAll(/<MmPayroll>([\s\S]*?)<\/MmPayroll>/g)].map((m) => {
            const o = {};
            for (const f of imp.TYPES.mp.fields) { const x = new RegExp('<' + f + '>\\s*([^<]*?)\\s*</' + f + '>').exec(m[1]); o[f] = x ? x[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; }
            return o;
        });
    }
    return rows.map((r, i) => ({ line: i + 1, period: periodOf(String(r.TaxPeriodMonth).padStart(2, '0') + String(r.TaxPeriodYear)), nik: String(r.CounterpartTin || '').replace(/\D/g, ''), taxObject: String(r.TaxObjectCode || '').trim(),
        ptkp: r.StatusTaxExemption ? normPtkp(r.StatusTaxExemption) || 'INVALID:' + r.StatusTaxExemption : null, gross: num(r.Gross), rate: num(r.Rate), position: r.Position ? String(r.Position).trim() : null }));
}

/** Rencana pembetulan: [{recordId, number, ..., before, after, changed}] + catatan baris yang dilewati. Hanya membaca Coretax.
 *  input: {changes:[{number, period, ptkp?, gross?, rate?, position?}]} atau {filePath}. */
async function plan(s, { npwp, changes, filePath }) {
    const notes = [], items = [];
    let wants;
    if (filePath) wants = (await readRevision(filePath, npwp)).map((w) => ({ ...w, source: 'baris ' + w.line }));
    else {
        if (!Array.isArray(changes) || !changes.length) throw new Error('Sebutkan perubahan ({number, period, ptkp/gross/rate/position}) atau file revisi.');
        wants = changes.map((c, i) => {
            const ptkp = c.ptkp == null || c.ptkp === '' ? null : normPtkp(c.ptkp) || 'INVALID:' + c.ptkp;
            return { source: 'nomor ' + (c.number || '?'), number: String(c.number || '').trim(), period: periodOf(c.period), ptkp, gross: num(c.gross), rate: num(c.rate), position: c.position == null ? null : String(c.position).trim(), line: i + 1 };
        });
    }
    if (wants.length > MAX) throw new Error('Maksimal ' + MAX + ' bukti potong per proses (ada ' + wants.length + ').');
    const lists = new Map();
    const listOf = async (p) => { if (!lists.has(p.code)) lists.set(p.code, await s.list('getebupotmpissued', p.code)); return lists.get(p.code); };
    const used = new Set();
    for (const w of wants) {
        if (String(w.ptkp || '').startsWith('INVALID:')) { notes.push(w.source + ': Status PTKP "' + w.ptkp.slice(8) + '" tidak dikenal (' + PTKP.join(', ') + ') - dilewati.'); continue; }
        if (w.rate != null && (w.rate < 0 || w.rate > 50)) { notes.push(w.source + ': tarif ' + w.rate + '% di luar wajar - dilewati.'); continue; }
        if (w.gross != null && w.gross < 0) { notes.push(w.source + ': bruto negatif - dilewati.'); continue; }
        const list = await listOf(w.period);
        const hits = w.number ? list.filter((r) => String(r.WithholdingSlipsNumber) === w.number)
            : list.filter((r) => r.TaxIdentificationNumber === w.nik && (!w.taxObject || r.TaxObjectCode === w.taxObject) && !used.has(r.RecordId));
        if (!hits.length) { notes.push(w.source + ': ' + (w.number ? 'nomor ' + w.number : 'NIK ' + w.nik + (w.taxObject ? ' kode ' + w.taxObject : '')) + ' tidak ada di BPMP Telah Terbit ' + w.period.label + ' - dilewati (bukti potong baru: pakai upload).'); continue; }
        if (hits.length > 1) { notes.push(w.source + ': NIK ' + w.nik + ' punya ' + hits.length + ' BPMP ' + w.period.label + ' (' + hits.map((h) => h.WithholdingSlipsNumber).join(', ') + ') - sebutkan nomornya; dilewati.'); continue; }
        const r = hits[0]; used.add(r.RecordId);
        const v = await view(s, r.RecordId);
        if (!['NORMAL', 'AMENDMENT'].includes(v.WithholdingSlipsStatus)) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' berstatus ' + v.WithholdingSlipsStatus + ' - dilewati.'); continue; }
        const before = { ptkp: v.TaxExemptionStatus, gross: v.GrossIncome, rate: v.TaxRate, tax: v.IncomeTaxWithheld, position: v.Position ? String(v.Position).trim() : null };
        const after = { ptkp: w.ptkp || before.ptkp, gross: w.gross != null ? w.gross : before.gross, rate: w.rate != null ? w.rate : before.rate, position: w.position != null && w.position !== '' ? w.position : before.position };
        if (TER[after.ptkp] !== TER[before.ptkp] && w.rate == null) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' PTKP ' + before.ptkp + ' -> ' + after.ptkp + ' pindah kategori TER ' + TER[before.ptkp] + ' -> ' + TER[after.ptkp] + ' - sebutkan tarif barunya; dilewati.'); continue; }
        after.tax = taxOf(after.gross, after.rate);
        const changed = ['ptkp', 'gross', 'rate', 'position', 'tax'].filter((k) => String(after[k] ?? '') !== String(before[k] ?? ''));
        if (!changed.length) { notes.push(w.source + ': ' + r.WithholdingSlipsNumber + ' sudah sesuai - dilewati.'); continue; }
        items.push({ recordId: r.RecordId, number: r.WithholdingSlipsNumber, period: w.period.code, nik: r.TaxIdentificationNumber, name: String(r.Name || '').trim(), reportedInSpt: !!v.IsReportedToTaxReturn, before, after, changed });
    }
    const token = items.length ? crypto.createHash('sha256').update(JSON.stringify(items.map((x) => [x.recordId, x.before, x.after]))).digest('hex').slice(0, 12) : null;
    const sum = (k, side) => items.reduce((a, x) => a + (x[side][k] || 0), 0);
    return { items, notes, token, totals: { taxBefore: sum('tax', 'before'), taxAfter: sum('tax', 'after'), grossBefore: sum('gross', 'before'), grossAfter: sum('gross', 'after') },
        periodsReported: [...new Set(items.filter((x) => x.reportedInSpt).map((x) => x.period.slice(0, 2) + '/' + x.period.slice(4)))] };
}

async function previewAmend(page, input) {
    const s = await session(page, input.npwp);
    try { return await plan(s, input); } finally { await s.close(); }
}

/** Kirim pembetulan - hanya bila rencana sekarang = pratinjau (kode sama). */
async function amend(page, { token, outDir, emit = () => {}, ...input }) {
    if (!token) throw new Error('Kode konfirmasi pratinjau wajib - jalankan pratinjau dulu.');
    const s = await session(page, input.npwp), results = [];
    try {
        const p = await plan(s, input);
        p.notes.forEach((n) => emit('LEWATI ' + n));
        if (p.token !== token) throw new Error('Data di Coretax berubah sejak pratinjau (kode ' + token + ' tidak cocok lagi) - lihat pratinjau baru dulu.');
        fs.mkdirSync(outDir, { recursive: true });
        const lookups = new Map();
        for (const x of p.items) {
            const label = x.number + ' masa ' + x.period.slice(0, 2) + '/' + x.period.slice(4) + ' · ' + x.nik + ' ' + x.name;
            const v = await view(s, x.recordId);
            fs.writeFileSync(path.join(outDir, 'cadangan-' + x.number + '.json'), JSON.stringify({ view: v, plan: x }, null, 1));
            if (!lookups.has(x.nik)) lookups.set(x.nik, await s.lookup(x.nik));
            const person = lookups.get(x.nik);
            if (person.error || !person.payload) throw new Error(label + ': data NIK tidak terbaca dari Coretax (' + (person.error || 'kosong') + ').');
            // Isian sama dengan formulir "Ubah" Coretax (automation/bpmp-amend.js); hanya PTKP / bruto / tarif / PPh / posisi yang berubah.
            const body = { TaxPeriodCode: v.TaxPeriodCode, WithholdingSlipsStatus: v.WithholdingSlipsStatus, IsForeignEmployee: !!v.IsForeignEmployee, TaxpayerType: person.payload.TaxpayerType,
                TaxIdentificationNumber: v.TaxIdentificationNumber, Name: v.Name, Position: x.after.position, TaxCertificateCode: v.TaxCertificateCode, TaxObjectCode: v.TaxObjectCode, TaxArticle: v.TaxArticle,
                TaxObjectReferenceCode: String(v.TaxObjectReferenceCode), GrossIncome: x.after.gross, TaxRate: x.after.rate, IncomeTaxWithheld: x.after.tax, RevenueCode: v.RevenueCode, BranchId: v.BranchId,
                TaxExemptionStatus: x.after.ptkp, RecordId: v.RecordId, WithholdingslipsAggregateIdentifier: v.WithholdingslipsAggregateIdentifier };
            const res = await s.post(API + '/amendebupotmp', body);
            if (res.status !== 200 || !res.json || res.json.IsSuccessful === false) {
                results.push({ ...x, status: 'GAGAL: ditolak Coretax' });
                throw Object.assign(new Error(label + ': ditolak Coretax - HTTP ' + res.status + ' ' + JSON.stringify(res.json && (res.json.Message || res.json.Errors || res.json.Payload)).slice(0, 300)), { results });
            }
            const now = await s.find('getebupotmpissued', x.period, x.number);
            const nv = now ? await view(s, now.RecordId).catch(() => now) : null;
            const ok = nv && nv.WithholdingSlipsStatus === 'AMENDMENT' && nv.IncomeTaxWithheld === x.after.tax && nv.GrossIncome === x.after.gross && (!nv.TaxExemptionStatus || nv.TaxExemptionStatus === x.after.ptkp);
            results.push({ ...x, status: ok ? 'DIBETULKAN' : 'PERIKSA - hasil tidak sesuai', now: nv ? slim(nv) : null });
            emit((ok ? 'OK    ' : 'CEK   ') + label + ' · ' + x.changed.map((k) => k + ' ' + x.before[k] + ' -> ' + x.after[k]).join(', '));
            if (!ok) throw Object.assign(new Error(label + ': pemeriksaan sesudah kirim tidak sesuai - berhenti.'), { results });
        }
        fs.writeFileSync(path.join(outDir, 'hasil.json'), JSON.stringify(results, null, 1));
        return { results, notes: p.notes, periodsReported: p.periodsReported };
    } finally { await s.close(); }
}

/** Pratinjau batal: nomor-nomor di BPMP Telah Terbit satu masa. */
async function cancelPlan(s, { period, numbers }) {
    const p = periodOf(period), want = [...new Set((numbers || []).map((n) => String(n).trim()).filter(Boolean))];
    if (!want.length) throw new Error('Sebutkan nomor bukti potong yang dibatalkan.');
    if (want.length > MAX) throw new Error('Maksimal ' + MAX + ' bukti potong per proses.');
    const list = await s.list('getebupotmpissued', p.code), notes = [], rows = [];
    for (const n of want) { const r = list.find((x) => String(x.WithholdingSlipsNumber) === n); if (r) rows.push({ ...r, _masa: p.month }); else notes.push(n + ': tidak ada di BPMP Telah Terbit ' + p.label + ' - dilewati.'); }
    const token = rows.length ? crypto.createHash('sha256').update('cancel|' + rows.map((r) => r.RecordId + ':' + r.WithholdingSlipsStatus + ':' + r.IncomeTaxWithheld).sort().join('|')).digest('hex').slice(0, 12) : null;
    return { p, rows, notes, token };
}
async function previewCancel(page, { npwp, period, numbers }) {
    const s = await session(page, npwp);
    try {
        const c = await cancelPlan(s, { period, numbers });
        return { period: c.p.label, token: c.token, notes: c.notes, slips: c.rows.map(slim), totals: { gross: c.rows.reduce((a, r) => a + (r.GrossIncome || 0), 0), tax: c.rows.reduce((a, r) => a + (r.IncomeTaxWithheld || 0), 0) },
            reportedInSpt: c.rows.filter((r) => r.IsReportedToTaxReturn).length };
    } finally { await s.close(); }
}
async function cancel(page, { npwp, period, numbers, token, emit = () => {} }) {
    if (!token) throw new Error('Kode konfirmasi pratinjau wajib - jalankan pratinjau batal dulu.');
    const s = await session(page, npwp), done = [];
    try {
        const c = await cancelPlan(s, { period, numbers });
        c.notes.forEach((n) => emit('LEWATI ' + n));
        if (c.token !== token) throw new Error('Daftar berubah sejak pratinjau (kode ' + token + ' tidak cocok lagi) - lihat pratinjau baru dulu.');
        const { cancelOne } = require('./ebupot-vs-spt');
        for (const r of c.rows) {
            const x = await cancelOne(s, r, c.p.year);
            done.push({ number: r.WithholdingSlipsNumber, ok: x.ok, msg: x.msg });
            emit((x.ok ? 'DIBATALKAN  ' : 'GAGAL BATAL ') + 'BPMP ' + r.WithholdingSlipsNumber + ' masa ' + c.p.label + ' · ' + r.TaxIdentificationNumber + ' ' + String(r.Name || '').trim() + (x.ok ? '' : ': ' + x.msg));
            if (!x.ok) break;
        }
        return { done, reported: c.rows.some((r) => r.IsReportedToTaxReturn) };
    } finally { await s.close(); }
}

module.exports = { find, previewAmend, amend, previewCancel, cancel, periodOf, readRevision, taxOf, normPtkp, TER, FIELDS, KINDS };
