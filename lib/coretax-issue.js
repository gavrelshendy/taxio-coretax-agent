/* Terbitkan (issue) bukti potong Belum Terbit e-Bupot - opsi 2 yang disepakati 2026-11-07: Pilot menerbitkan sesudah
 * pengguna melihat daftar dan menyetujuinya; BPMP tanpa tanda tangan, BP21 / BPA1 / BPPU ditandatangani dengan passphrase
 * PIC yang tersimpan di Pilot. Lapor SPT tetap manual. Lihat docs/coretax-upload-konsep.md.
 *
 * Dua langkah: preview() -> daftar + kode konfirmasi (hash RecordId); issue() hanya berjalan bila kode itu masih cocok
 * dengan daftar Belum Terbit saat itu (tidak ada yang bertambah / berubah sejak preview). */
const crypto = require('crypto');
const { TYPES } = require('./coretax-import');

const EB_API = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';
const EB_PAGE = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotmp/issued';
const CERT_URL = 'https://coretaxdjp.pajak.go.id/registrationportal/api/DigitalCertificate/digitalCertificateList';
const VALIDATE_SIGN_URL = 'https://coretaxdjp.pajak.go.id/documentmanagementportal/api/documentOutbound/validate-sign';
const NEEDS_SIGN = new Set(['bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr']);
const UNDER = ['IsUnderAudit', 'IsUnderObjectionValue', 'IsUnderObjectionWithdrawalReviewValue', 'WasUnderObjectionValue', 'IsUnderOpenInvestigation', 'UnderRefund'];

/** "MMYY" / "MMYYYY" / "MMMMYYYY" -> "MMMMYYYY". */
function periodCode(p) {
    const d = String(p || '').replace(/\D/g, '');
    if (/^\d{8}$/.test(d)) return d;
    if (/^\d{6}$/.test(d)) return d.slice(0, 2) + d.slice(0, 2) + d.slice(2);
    if (/^\d{4}$/.test(d)) return d.slice(0, 2) + d.slice(0, 2) + '20' + d.slice(2);
    throw new Error('Masa tidak valid: ' + p + ' (pakai MMYY).');
}
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const grossOf = (r) => num(r.GrossIncome ?? r.TaxBase ?? r.SalaryPensionJhtTht);
const taxOf = (r) => num(r.IncomeTaxWithheld ?? r.IncomeTax ?? r.Article21IncomeTax);

/** Sesi e-Bupot dari halaman yang sudah login & impersonate (fetch dari dalam halaman Coretax). */
async function session(page) {
    const context = page.context(), auth = {};
    const on = (req) => { if (!req.url().includes('/withholdingslipsportal/api/')) return; const h = req.headers(); if (h.authorization) auth.authorization = h.authorization; if (h['x-dgt-code']) auth.dgtCode = h['x-dgt-code']; };
    context.on('request', on);
    try { await page.goto(EB_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }); for (let i = 0; i < 80 && !auth.authorization; i++) await page.waitForTimeout(500); }
    finally { context.off('request', on); }
    if (!auth.authorization) throw new Error('Sesi e-Bupot Coretax tidak tertangkap - pastikan jendela PIC sudah login.');
    const claims = JSON.parse(Buffer.from(auth.authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    const H = { Authorization: auth.authorization, ...(auth.dgtCode ? { 'x-dgt-code': auth.dgtCode } : {}) };
    const post = (u, body) => page.evaluate(async ([u, body, H]) => {
        const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j };
    }, [u, body, H]);
    return { claims, taxpayerId: claims.taxpayer_id, post };
}

/** Belum Terbit satu jenis & masa (semua halaman). BPA1 difilter IncomePeriodCodeEnd. */
async function listNotIssued(s, type, code) {
    const rows = [];
    for (let first = 0; ; first += 200) {
        const r = await s.post(EB_API + '/getebupot' + type + 'notissued', { First: first, Rows: 200, SortField: '', SortOrder: 1, Filters: [{ PropertyName: type === 'bpa1' ? 'IncomePeriodCodeEnd' : 'TaxPeriodCode', Value: code, MatchMode: 'equals', CaseSensitive: true, AsString: false }], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: s.taxpayerId });
        if (r.status !== 200) throw new Error('Daftar Belum Terbit ' + type + ' ' + code + ' gagal: HTTP ' + r.status);
        const d = (r.json && r.json.Payload && r.json.Payload.Data) || []; rows.push(...d);
        if (d.length < 200) break;
    }
    return rows;
}
const tokenOf = (rows) => crypto.createHash('sha256').update(rows.map((r) => r.RecordId + ':' + r.WithholdingSlipsStatus + ':' + grossOf(r) + ':' + taxOf(r)).sort().join('|')).digest('hex').slice(0, 12);

/** Pratinjau terbitkan: daftar Belum Terbit siap terbit + total + kode konfirmasi. Tidak mengubah apa pun. */
async function preview(page, { type, period }) {
    if (!TYPES[type]) throw new Error('Jenis tidak dikenal: ' + type + ' (mp, bp21, bpa1, bpu).');
    const code = periodCode(period), s = await session(page);
    const all = await listNotIssued(s, type, code);
    const ready = all.filter((r) => r.WithholdingSlipsStatus === 'SUBMITTED' && !UNDER.some((k) => r[k] === true));
    const skipped = all.filter((r) => !ready.includes(r)).map((r) => ({ nik: r.TaxIdentificationNumber, name: r.Name, status: r.WithholdingSlipsStatus, reason: UNDER.find((k) => r[k] === true) || 'status ' + r.WithholdingSlipsStatus }));
    return {
        type, label: TYPES[type].label, period: code, needsSign: NEEDS_SIGN.has(type), count: ready.length, skipped,
        totalGross: ready.reduce((a, r) => a + grossOf(r), 0), totalTax: ready.reduce((a, r) => a + taxOf(r), 0),
        slips: ready.map((r) => ({ nik: r.TaxIdentificationNumber, name: r.Name, gross: grossOf(r), tax: taxOf(r), objectCode: r.TaxObjectCode })),
        token: ready.length ? tokenOf(ready) : null,
        rows: ready // baris Coretax lengkap untuk laporan Excel (server tidak mengirimnya ke GUI / MCP)
    };
}

/** Terbitkan Belum Terbit jenis & masa itu - HANYA bila `token` sama dengan pratinjau. `signer` {nik, passphrase} untuk
 *  jenis bertanda tangan. Satu permintaan per kelompok (maks `batch`), lalu dihitung ulang dari Belum Terbit. */
async function issue(page, { type, period, token, signer, emit = () => {}, batch = 50 }) {
    if (!TYPES[type]) throw new Error('Jenis tidak dikenal: ' + type);
    if (!token) throw new Error('Kode konfirmasi pratinjau wajib - jalankan pratinjau terbitkan dulu.');
    const code = periodCode(period), s = await session(page);
    const ready = (await listNotIssued(s, type, code)).filter((r) => r.WithholdingSlipsStatus === 'SUBMITTED' && !UNDER.some((k) => r[k] === true));
    if (!ready.length) throw new Error('Tidak ada bukti potong Belum Terbit ' + TYPES[type].label + ' masa ' + code + '.');
    if (tokenOf(ready) !== token) throw new Error('Daftar Belum Terbit berubah sejak pratinjau (kode ' + token + ' tidak cocok lagi) - lihat pratinjau baru sebelum menerbitkan.');
    let sign = null;
    if (NEEDS_SIGN.has(type)) {
        if (!signer || !signer.nik || !signer.passphrase) throw new Error(TYPES[type].label + ' perlu tanda tangan: NIK dan passphrase PIC belum tersedia di Pilot.');
        const certs = await s.post(CERT_URL, { SignerId: signer.nik });
        const list = ((certs.json && certs.json.Payload) || []).slice().sort((a, b) => String(a.Code).localeCompare(String(b.Code)));
        if (!list.length) throw new Error('Sertifikat elektronik penandatangan tidak ditemukan di Coretax.');
        const provider = list[0].Code;
        if (provider === '00' || provider === '08') {
            const v = await s.post(VALIDATE_SIGN_URL, { Nik: signer.nik, Passphrase: signer.passphrase });
            if (!(v.json && v.json.IsSuccessful && v.json.Payload && Number(v.json.Payload.KodeResponse) === 1)) throw new Error('Passphrase ditolak Coretax: ' + ((v.json && v.json.Payload && v.json.Payload.ErrMessage) || (v.json && v.json.Message) || 'HTTP ' + v.status) + '. Tidak ada yang diterbitkan.');
        }
        sign = { Type: '02', Provider: provider, SignerID: signer.nik, SignerPassword: signer.passphrase };
        emit('Tanda tangan: sertifikat ' + provider + ', passphrase PIC valid.');
    }
    const signedBy = s.claims.Impersonating && s.claims.RepresentativeId ? s.claims.RepresentativeId : s.taxpayerId;
    let sent = 0;
    for (let i = 0; i < ready.length; i += batch) {
        const part = ready.slice(i, i + batch).map((r) => {
            const id = { RecordIdentifier: r.RecordId, UnderAuditValue: r.IsUnderAudit, UnderObjectionValue: r.IsUnderObjectionValue, UnderObjectionWithdrawalReviewValue: r.IsUnderObjectionWithdrawalReviewValue,
                WasUnderObjectionValue: r.WasUnderObjectionValue, UnderOpenInvestigation: r.IsUnderOpenInvestigation, WithholdingSlipsStatus: r.WithholdingSlipsStatus, UnderRefund: r.UnderRefund };
            if (r.WithholdingslipsAggregateIdentifier != null) id.WithholdingslipsAggregateIdentifier = r.WithholdingslipsAggregateIdentifier;
            return id;
        });
        const body = { EBUPOTIdentifiers: part, ...(sign ? { SignParameter: sign, SignedTaxpayerAggregateIdentifier: signedBy } : {}) };
        const r = await s.post(EB_API + '/issueebupot' + type, body);
        if (!(r.status === 200 && r.json && r.json.IsSuccessful)) throw new Error('Terbitkan ditolak Coretax (kelompok ' + (i / batch + 1) + '): ' + ((r.json && (r.json.Message || r.json.Payload)) || 'HTTP ' + r.status) + (sent ? ' - ' + sent + ' bukti potong sebelumnya sudah dikirim.' : ''));
        sent += part.length;
        emit('Terbitkan ' + TYPES[type].label + ' ' + code + ': ' + sent + '/' + ready.length + ' dikirim.');
    }
    // Penerbitan bisa diproses di latar: hitung sisa Belum Terbit.
    let left = ready.length;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(3000);
        const now = await listNotIssued(s, type, code);
        left = now.filter((r) => ready.some((x) => x.RecordId === r.RecordId)).length;
        if (!left) break;
    }
    // Laporan: baris Telah Terbit yang cocok (NIK + bruto) dengan yang diterbitkan, lengkap dengan nomor bukti potong.
    const want = new Map(); for (const r of ready) { const k = r.TaxIdentificationNumber + '|' + grossOf(r); want.set(k, (want.get(k) || 0) + 1); }
    const issuedRows = [];
    try {
        for (let first = 0; ; first += 200) {
            const q = await s.post(EB_API + '/getebupot' + type + 'issued', { First: first, Rows: 200, SortField: '', SortOrder: 1, Filters: [{ PropertyName: type === 'bpa1' ? 'IncomePeriodCodeEnd' : 'TaxPeriodCode', Value: code, MatchMode: 'equals', CaseSensitive: true, AsString: false }], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: s.taxpayerId });
            const d = (q.json && q.json.Payload && q.json.Payload.Data) || [];
            for (const r of d) { const k = r.TaxIdentificationNumber + '|' + grossOf(r); if (want.get(k)) { want.set(k, want.get(k) - 1); issuedRows.push(r); } }
            if (d.length < 200) break;
        }
    } catch (e) { emit('Daftar Telah Terbit untuk laporan gagal dibaca: ' + e.message); }
    return { type, label: TYPES[type].label, period: code, sent, issued: ready.length - left, pending: left, signed: !!sign, rows: issuedRows };
}

module.exports = { preview, issue, periodCode, NEEDS_SIGN, tokenOf };
