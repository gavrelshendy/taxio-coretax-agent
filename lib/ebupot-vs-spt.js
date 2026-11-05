/* Bukti potong e-Bupot (Telah Terbit, sekarang) vs yang terlapor di SPT (lampiran di rekap Mode A1), per masa dan per
 * Nomor Bukti Potong (permintaan 2026-11-05): bukti potong bisa dibetulkan (bruto / PPh / kode objek pajak / NIK berubah),
 * dihapus / dibatalkan, atau ditambah sesudah SPT dilaporkan - tanpa pembetulan SPT, rekap (yang dibaca dari SPT) tidak
 * menunjukkannya. Pasangan: L-IA <-> BPMP, L-II <-> BPA1 (L-II memuat bruto satu periode penuh, sama dengan BPA1),
 * L-III <-> BP21.
 *
 * Nama field bruto / PPh daftar BPA1 dan BP21 belum pernah dikalibrasi live: nilai hanya dibandingkan bila field itu
 * cocok di sebagian besar bukti potong yang ada di keduanya; selain itu perbandingan nilai jenis itu dimatikan dan
 * dicatat (dengan nama field yang tersedia), supaya tidak muncul ratusan "berubah" palsu. */
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const TYPES = [
    { type: 'bpmp', label: 'BPMP', sheet: 'L-IA', endpoint: 'getebupotmpissued', property: 'TaxPeriodCode' },
    { type: 'bpa1', label: 'BPA1', sheet: 'L-II', endpoint: 'getebupotbpa1issued', property: 'IncomePeriodCodeEnd' },
    { type: 'bp21', label: 'BP21', sheet: 'L-III', endpoint: 'getebupotbp21issued', property: 'TaxPeriodCode' }
];
const GROSS = ['GrossIncome', 'TaxBase', 'TotalGrossIncome', 'Gross'];
// Field yang sudah terbukti live: BPMP (automation/bpmp-amend.js - pembetulan + pemeriksaan per kolom), BP21 (kolom ekspor
// automation/ebupot.js). Dipakai langsung bila ada; BPA1 belum pernah dilihat live -> lewat kalibrasi.
const KNOWN = { bpmp: { gross: ['GrossIncome'], tax: ['IncomeTaxWithheld', 'IncomeTax'] }, bp21: { gross: ['TaxBase'], tax: ['IncomeTax'] } };
const TAX = ['IncomeTax', 'IncomeTaxWithheld', 'Article21IncomeTax', 'IncomeTaxPayable'];

const text = (v) => v && typeof v === 'object' ? ('result' in v ? v.result : v.richText ? v.richText.map((r) => r.text).join('') : v.text) : v;
const str = (v) => String(text(v) ?? '').trim();
const num = (v) => { const t = text(v); if (t === '' || t == null) return null; const n = typeof t === 'number' ? t : Number(String(t).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n < 0 ? '-' : '') + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Bukti potong per lampiran dari rekap: {type: Map(nomor -> {masa, number, nik, name, kop, gross, tax})}. */
function readSpt(wb) {
    const out = {};
    for (const t of TYPES) {
        const ws = wb.getWorksheet(t.sheet), map = new Map(); out[t.type] = map;
        if (!ws) continue;
        let head = 0; ws.eachRow((r, n) => { if (!head && n > 5 && str(r.getCell(1).value) === 'Masa') head = n; });
        if (!head) continue;
        const cols = []; ws.getRow(head).eachCell((c, i) => { cols[i] = str(c.value); });
        const at = (re) => cols.findIndex((h) => h && re.test(h));
        const c = { no: at(/NOMOR BUKTI/i), nik: at(/NIK|NPWP/i), name: at(/^NAMA/i), kop: at(/KODE OBJEK/i), gross: at(/BRUTO|DASAR PENGENAAN/i), tax: at(/^PAJAK PENGHASILAN|^PPH/i) };
        if (c.no < 0) continue;
        for (let n = head + 1; n <= ws.rowCount; n++) {
            const r = ws.getRow(n), m = MONTHS.indexOf(str(r.getCell(1).value)); if (m < 0) break;
            const number = str(r.getCell(c.no).value); if (!number) continue;
            map.set(number, { masa: m + 1, number, nik: c.nik > 0 ? str(r.getCell(c.nik).value) : '', name: c.name > 0 ? str(r.getCell(c.name).value) : '',
                kop: c.kop > 0 ? str(r.getCell(c.kop).value) : '', gross: c.gross > 0 ? num(r.getCell(c.gross).value) : null, tax: c.tax > 0 ? num(r.getCell(c.tax).value) : null });
        }
    }
    return out;
}
const masaOf = (map) => [...new Set([...map.values()].map((x) => x.masa))];

/** Telah Terbit per jenis untuk masa yang ada di rekap: list(endpoint, kode masa, properti filter) dari bpmp-amend openSession. */
async function fetchIssued(list, year, spt, months) {
    const out = {};
    for (const t of TYPES) {
        out[t.type] = new Map();
        for (const m of months) {
            const mm = String(m).padStart(2, '0');
            for (const r of await list(t.endpoint, mm + mm + year, t.property)) if (r.WithholdingSlipsNumber) out[t.type].set(String(r.WithholdingSlipsNumber), { ...r, _masa: m });
        }
    }
    return out;
}

/** Field terbukti (`known`) bila ada di data; selain itu field pertama dari `names` yang nilainya sama dengan SPT pada
 *  sebagian besar bukti potong yang ada di keduanya. */
function calibrate(pairs, names, key, known = []) {
    const f0 = known.find((f) => pairs.some(([, e]) => e[f] != null));
    if (f0) return { field: f0, rate: 1, tested: pairs.length, known: true };
    const tested = pairs.filter(([s]) => s[key] != null);
    if (!tested.length) return { field: null, rate: 0, tested: 0 };
    let best = { field: null, rate: 0, tested: tested.length };
    for (const f of names) {
        const hit = tested.filter(([s, e]) => e[f] != null && Math.abs(Number(e[f]) - s[key]) < 1).length / tested.length;
        if (hit > best.rate) best = { field: f, rate: hit, tested: tested.length };
    }
    return best.rate >= 0.5 ? best : { ...best, field: null };
}

/** Selisih per bukti potong. Hasil: {diffs: [...], same: Set(nomor), notes: [...], counts}. */
function compare(spt, issued) {
    const diffs = [], same = new Set(), replaced = new Map(), notes = [], counts = {};
    for (const t of TYPES) {
        const s = spt[t.type] || new Map(), e = issued[t.type] || new Map();
        const pairs = [...s.values()].filter((x) => e.has(x.number)).map((x) => [x, e.get(x.number)]);
        const k = KNOWN[t.type] || {}, g = calibrate(pairs, GROSS, 'gross', k.gross), x = calibrate(pairs, TAX, 'tax', k.tax);
        if (pairs.length && !g.field) notes.push(t.label + ': bruto tidak dibandingkan - field e-Bupot belum dikenali (' + Object.keys(pairs[0][1]).filter((k) => /Income|Tax|Gross|Base/i.test(k)).join(', ') + ').');
        if (pairs.length && !x.field) notes.push(t.label + ': PPh tidak dibandingkan - field e-Bupot belum dikenali.');
        const c = counts[t.label] = { compared: pairs.length, changed: 0, removed: 0, added: 0, replaced: 0, cancel: 0, cancelled: 0 };
        const ebGross = (eb) => (g.field ? Number(eb[g.field]) : null), ebTax = (eb) => (x.field ? Number(eb[x.field]) : null);
        // Bruto 0 dan PPh 0 = bukti potong kosong (permintaan 2026-11-05): yang masih Telah Terbit masuk draft Pembetulan
        // untuk dibatalkan / dihapus di Coretax; yang sudah tidak ada di Telah Terbit = sudah dibatalkan, tidak dicatat.
        const zero = (gross, tax) => gross === 0 && tax === 0;
        const cancel = (eb, masa, sp) => {
            c.cancel++;
            diffs.push({ kind: 'Batalkan', type: t.label, sheet: t.sheet, masa, number: String(eb.WithholdingSlipsNumber), nik: String(eb.TaxIdentificationNumber || (sp && sp.nik) || ''), name: String(eb.Name || (sp && sp.name) || '').trim(),
                kop: String(eb.TaxObjectCode || (sp && sp.kop) || ''), gross: 0, tax: 0, sGross: sp ? sp.gross : null, sTax: sp ? sp.tax : null, eGross: 0, eTax: 0, detail: 'Bruto 0 dan PPh 0 - batalkan / hapus bukti potong ini di Coretax' });
        };
        const diffOf = (sp, eb, withNik) => {
            const parts = [];
            if (withNik && sp.nik && eb.TaxIdentificationNumber && sp.nik !== String(eb.TaxIdentificationNumber)) parts.push('NIK ' + sp.nik + ' → ' + eb.TaxIdentificationNumber);
            if (sp.kop && eb.TaxObjectCode && sp.kop !== String(eb.TaxObjectCode)) parts.push('kode objek pajak ' + sp.kop + ' → ' + eb.TaxObjectCode);
            if (g.field && sp.gross != null && Math.abs(ebGross(eb) - sp.gross) >= 1) parts.push('bruto ' + fmt(sp.gross) + ' → ' + fmt(ebGross(eb)));
            if (x.field && sp.tax != null && Math.abs(ebTax(eb) - sp.tax) >= 1) parts.push('PPh ' + fmt(sp.tax) + ' → ' + fmt(ebTax(eb)));
            return parts;
        };
        for (const [sp, eb] of pairs) {
            if (zero(ebGross(eb), ebTax(eb))) { cancel(eb, sp.masa, sp); continue; }
            const parts = diffOf(sp, eb, true);
            if (!parts.length) { same.add(sp.number); continue; }
            c.changed++;
            diffs.push({ kind: 'Berubah', type: t.label, sheet: t.sheet, masa: sp.masa, number: sp.number, nik: String(eb.TaxIdentificationNumber || sp.nik), name: String(eb.Name || sp.name).trim(), kop: String(eb.TaxObjectCode || sp.kop),
                gross: g.field ? ebGross(eb) : sp.gross, tax: x.field ? ebTax(eb) : sp.tax, sGross: sp.gross, sTax: sp.tax, eGross: ebGross(eb), eTax: ebTax(eb), detail: 'Berubah sesudah SPT dilaporkan: ' + parts.join(', ') });
        }
        const gone = [...s.values()].filter((sp) => !e.has(sp.number));
        const fresh = [...e.values()].filter((eb) => !s.has(String(eb.WithholdingSlipsNumber)));
        // Diterbitkan ulang dengan nomor baru (NIK dan masa sama): satu pasangan, bukan "dihapus" + "baru". Nilai sama =
        // cocok dengan SPT (hanya nomornya yang berganti); nilai berbeda = satu baris di nomor baru.
        const key = (masa, nik) => masa + '|' + nik, pool = new Map();
        for (const eb of fresh) { const k = key(eb._masa, String(eb.TaxIdentificationNumber || '')); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(eb); }
        const paired = new Set();
        for (const sp of gone) {
            const cand = pool.get(key(sp.masa, sp.nik)); if (!cand || !cand.length) continue;
            const eb = cand.shift(), no = String(eb.WithholdingSlipsNumber); paired.add(sp.number); paired.add(no);
            c.replaced++; replaced.set(sp.number, no);
            if (zero(ebGross(eb), ebTax(eb))) { cancel(eb, sp.masa, sp); continue; }
            const parts = diffOf(sp, eb, false);
            if (!parts.length) { same.add(sp.number); same.add(no); continue; }
            c.changed++;
            diffs.push({ kind: 'Diganti', type: t.label, sheet: t.sheet, masa: sp.masa, number: no, nik: sp.nik, name: String(eb.Name || sp.name).trim(), kop: String(eb.TaxObjectCode || sp.kop),
                gross: ebGross(eb), tax: ebTax(eb), sGross: sp.gross, sTax: sp.tax, eGross: ebGross(eb), eTax: ebTax(eb), detail: 'Diterbitkan ulang sesudah SPT dilaporkan (nomor ' + sp.number + ' → ' + no + '): ' + parts.join(', ') });
        }
        // Dihapus / dibatalkan: di SPT, tidak lagi di Telah Terbit masa itu (hanya untuk masa yang daftarnya diambil).
        for (const sp of gone) if (!paired.has(sp.number)) {
            if (zero(sp.gross, sp.tax)) { c.cancelled++; continue; }
            c.removed++;
            diffs.push({ kind: 'Dihapus', type: t.label, sheet: t.sheet, masa: sp.masa, number: sp.number, nik: sp.nik, name: sp.name, kop: sp.kop, gross: sp.gross, tax: sp.tax, sGross: sp.gross, sTax: sp.tax, eGross: null, eTax: null,
                detail: 'Tidak ada lagi di e-Bupot ' + t.label + ' Telah Terbit (dihapus / dibatalkan sesudah SPT dilaporkan)' });
        }
        // Baru: Telah Terbit, tidak ada di lampiran SPT masa itu.
        for (const eb of fresh) if (!paired.has(String(eb.WithholdingSlipsNumber))) {
            if (zero(ebGross(eb), ebTax(eb))) { cancel(eb, eb._masa); continue; }
            c.added++;
            diffs.push({ kind: 'Baru', type: t.label, sheet: t.sheet, masa: eb._masa, number: String(eb.WithholdingSlipsNumber), nik: String(eb.TaxIdentificationNumber || ''), name: String(eb.Name || '').trim(), kop: String(eb.TaxObjectCode || ''),
                gross: ebGross(eb), tax: ebTax(eb), sGross: null, sTax: null, eGross: ebGross(eb), eTax: ebTax(eb),
                detail: 'Ada di e-Bupot ' + t.label + ' Telah Terbit, belum ada di lampiran SPT' + (eb.IsReportedToTaxReturn ? ' (Coretax menandainya sudah dilaporkan - periksa masa lain)' : '') });
        }
    }
    return { diffs, same, replaced, notes, counts, checkedAt: new Date() };
}

/** Jalankan untuk rekap `file` (dibaca), dengan sesi e-Bupot di `context`; hasil ditulis ke rekap lewat lib/bpmp-report.js. */
async function run({ context, npwp, file, year, emit = () => {} }) {
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const spt = readSpt(wb), months = [...new Set(TYPES.flatMap((t) => masaOf(spt[t.type])))].sort((a, b) => a - b);
    if (!months.length) { emit('Cek e-Bupot vs SPT: tidak ada bukti potong di lampiran rekap - dilewati.'); return null; }
    const s = await require('../automation/bpmp-amend').openSession(context, npwp);
    let issued;
    try { issued = await fetchIssued(s.list, String(year), spt, months); } finally { await s.close(); }
    const result = compare(spt, issued);
    const sum = Object.entries(result.counts).map(([k, c]) => k + ' ' + c.compared + ' dibandingkan' + (c.changed + c.removed + c.added + c.replaced + c.cancel + c.cancelled ? ' (' + [c.changed && c.changed + ' berubah', c.removed && c.removed + ' dihapus', c.added && c.added + ' baru', c.replaced && c.replaced + ' diterbitkan ulang dengan nomor baru', c.cancel && c.cancel + ' bernilai 0 perlu dibatalkan', c.cancelled && c.cancelled + ' bernilai 0 sudah dibatalkan'].filter(Boolean).join(', ') + ')' : '')).join(' · ');
    emit('Cek e-Bupot vs SPT ' + year + ' (masa ' + months.join(', ') + '): ' + sum + '.');
    for (const n of result.notes) emit('Cek e-Bupot vs SPT: ' + n);
    for (const d of result.diffs.slice(0, 20)) emit('BEDA  ' + d.type + ' ' + d.number + ' masa ' + MONTHS[d.masa - 1] + ' · ' + d.nik + ' ' + d.name + ' · ' + d.detail);
    if (result.diffs.length > 20) emit('... dan ' + (result.diffs.length - 20) + ' lagi - lihat sheet Pembetulan (kolom Jenis = e-Bupot ≠ SPT).');
    const out = await require('./bpmp-report').writeReport({ file, year: String(year), results: [], compare: result });
    emit('Hasil cek ditulis ke ' + out.file + (out.locked ? ' (Excel rekap sedang terbuka - disimpan terpisah).' : '.'));
    return result;
}

module.exports = { TYPES, readSpt, fetchIssued, compare, calibrate, run };
