/* Pembetulan NIK BPMP Telah Terbit lewat API Coretax (tanpa mengetik di formulir), dari kolom hijau
 * NIK Baru / Nama Baru sheet "NIK" Excel Rekap PPh 21 Setahun (A1). Dipakai menu OTOMASI "Pembetulan NIK BPMP"
 * (gui/server.js) dan scripts/bpmp-amend.js.
 *
 * Alurnya sama dengan formulir "Ubah" Coretax: NIK baru divalidasi lewat /taxpayerdetail (respons terenkripsi
 * RSA-OAEP + AES-CBC, dibuka di browser seperti aplikasi Coretax), lalu /amendebupotmp dengan isian bukti potong
 * yang sama persis kecuali NIK dan Nama. Tanpa `submit`: hanya validasi + pratinjau. Dengan `submit`: kirim HANYA
 * bila nama resmi dari Coretax sama dengan Nama Baru di Excel; tiap bukti potong dicadangkan dulu, diperiksa ulang
 * sesudahnya (AMENDMENT, NIK baru, nomor tetap, bruto sama), dan proses berhenti di kegagalan pertama. Setelah
 * kirim, check() membandingkan setiap bukti potong per kolom dengan cadangannya.
 *
 * Terbukti live 2026-10-19 (BIRU BIANTI): 19 bukti potong April-Mei dibetulkan, 19/19 lolos pemeriksaan.
 * Tanggal pemotongan pembetulan = tanggal hari pembetulan (perilaku standar Coretax, juga lewat formulir). */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const API = 'https://coretaxdjp.pajak.go.id/withholdingslipsportal/api';
const ISSUED_URL = 'https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotmp/issued';
const TEMP = '9990000000999000';
// Boleh berubah karena pembetulan; kolom lain harus identik dengan cadangan.
const ALLOWED = new Set(['RecordId', 'WithholdingslipsAggregateIdentifier', 'TaxIdentificationNumber', 'Name', 'WithholdingSlipsStatus', 'CreationDate', 'IsReportedToTaxReturn', 'LastUpdatedDate', 'WithholdingSlipsDate']);

/** Isian NIK Baru / Nama Baru dari sheet "NIK" (rekap 2026-11-05, judul kolom di baris 1), atau "BPMP per NIK"
 *  Excel Mode A1 sebelumnya (judul kolom di baris 5). Kolom dicari menurut judulnya, bukan posisinya. */
async function readTargets(source) {
    const wb = new ExcelJS.Workbook();
    if (Buffer.isBuffer(source)) await wb.xlsx.load(source); else await wb.xlsx.readFile(source);
    const ws = wb.getWorksheet('NIK') || wb.getWorksheet('BPMP per NIK');
    if (!ws) throw new Error('Sheet "NIK" tidak ada - pakai Excel Rekap PPh 21 Setahun (A1) format terbaru.');
    // Baris judul: kolom A = "NIK" dan B = "Nama" (sheet NIK: baris 6, di bawah kop dan total; BPMP per NIK lama: baris 5).
    let headRow = 0; ws.eachRow((row, n) => { if (!headRow && n <= 10 && String(row.getCell(1).value || '').trim() === 'NIK' && String(row.getCell(2).value || '').trim() === 'Nama') headRow = n; });
    if (!headRow) throw new Error('Judul kolom sheet ' + ws.name + ' tidak ditemukan - susun ulang Excel dengan format terbaru.');
    const col = new Map();
    ws.getRow(headRow).eachCell((c, i) => col.set(String(c.value || '').trim(), i));
    const [cNik, cOld, cNew, cName] = ['NIK', 'NIK lama (dari #)', 'NIK Baru', 'Nama Baru'].map((h) => col.get(h));
    if (!cNik || !cOld || !cNew || !cName) throw new Error('Kolom NIK Baru / Nama Baru tidak ditemukan di sheet ' + ws.name + ' - susun ulang Excel dengan format terbaru.');
    const text = (v) => v && typeof v === 'object' ? ('result' in v ? v.result : v.text) : v;
    const targets = [], skipped = [];
    ws.eachRow((row, n) => {
        if (n <= headRow) return;
        const nik = String(text(row.getCell(cNik).value) || '').trim(); if (!/^\d{16}$/.test(nik)) return;
        const raw = text(row.getCell(cNew).value); if (raw === null || raw === undefined || raw === '') return;
        const old = nik === TEMP ? String(text(row.getCell(cOld).value) || '').trim() : nik;
        if (typeof raw === 'number') { skipped.push(old + ': NIK Baru tersimpan sebagai angka (digit akhir bisa hilang) - ketik ulang sebagai teks.'); return; }
        const newNik = String(raw).trim(), newName = String(text(row.getCell(cName).value) || '').trim();
        if (!/^\d{16}$/.test(newNik)) { skipped.push(old + ': NIK Baru "' + newNik + '" bukan 16 digit.'); return; }
        if (!newName) { skipped.push(old + ': Nama Baru kosong.'); return; }
        if (!/^\d{16}$/.test(old)) { skipped.push((old || nik) + ': NIK lama tidak terbaca.'); return; }
        targets.push({ temp: nik === TEMP, old, newNik, newName });
    });
    // Hasil pembetulan sebelumnya (sheet "Pembetulan", lib/bpmp-report.js) - untuk melanjutkan tanpa mengulang.
    const previous = require('../lib/bpmp-report').readPrevious(wb);
    // Tahun dari kop lampiran ("... · Tahun 2026").
    let year = null;
    for (const sheet of wb.worksheets) { const m = /Tahun (20\d{2})/.exec(String(text(sheet.getCell(3, 1).value) || '')); if (m) { year = m[1]; break; } }
    return { targets, skipped, year, previous };
}

/** Validasi NIK seperti formulir Coretax: daftarkan kunci publik RSA lalu buka respons /taxpayerdetail. */
const LOOKUP_IN_PAGE = `async ([api,auth,userId,nik])=>{
 const b64=buf=>{const b=new Uint8Array(buf);let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(s);};
 const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer;
 const headers={'Content-Type':'application/json',Authorization:auth.authorization,'x-dgt-code':auth.dgtCode};
 const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:4096,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
 const spki=b64(await crypto.subtle.exportKey('spki',keys.publicKey));
 const reg=await fetch(api+'/encryption/generate-key',{method:'POST',credentials:'include',headers,body:JSON.stringify({UserId:userId,PublicKeySpkiB64:spki})});
 if(!reg.ok)return {error:'generate-key HTTP '+reg.status};
 const r=await fetch(api+'/taxpayerdetail',{method:'POST',credentials:'include',headers,body:JSON.stringify({TaxIdentificationNumber:nik})});
 const j=await r.json().catch(()=>null);
 if(!r.ok||!j||!j.Payload)return {error:'taxpayerdetail HTTP '+r.status+' '+JSON.stringify(j&&(j.Message||j.Errors)).slice(0,200)};
 let m=j.Payload.Message;if(typeof m==='string'){try{m=JSON.parse(m);}catch(e){return {error:'pesan tidak terenkripsi: '+m.slice(0,200)};}}
 const aes=await crypto.subtle.decrypt({name:'RSA-OAEP'},keys.privateKey,unb64(m.WrappedKeyB64));
 const key=await crypto.subtle.importKey('raw',aes,{name:'AES-CBC',length:256},false,['decrypt']);
 const plain=await crypto.subtle.decrypt({name:'AES-CBC',iv:new Uint8Array(unb64(m.IVB64))},key,unb64(m.CipherTextB64));
 return {payload:JSON.parse(new TextDecoder().decode(plain))};
}`;

/** Tab e-Bupot BPMP di jendela PIC + otorisasi API-nya; menolak bila jendela bukan entitas `npwp`. */
async function openSession(context, npwp) {
    const auth = {};
    const onRequest = (req) => {
        if (!req.url().includes('/withholdingslipsportal/api/')) return;
        const h = req.headers();
        if (h.authorization) { auth.authorization = h.authorization; try { auth.claims = JSON.parse(Buffer.from(h.authorization.split(' ')[1].split('.')[1], 'base64url').toString()); } catch (e) {} }
        if (h['x-dgt-code']) auth.dgtCode = h['x-dgt-code'];
    };
    context.on('request', onRequest);
    const page = await context.newPage();
    await page.goto(ISSUED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 60 && !(auth.authorization && auth.claims); i++) await page.waitForTimeout(500);
    const close = async () => { context.off('request', onRequest); await page.close().catch(() => {}); };
    if (!auth.claims) { await close(); throw new Error('Sesi API e-Bupot Coretax tidak tertangkap - pastikan jendela PIC sudah login.'); }
    if (npwp && auth.claims.sub !== npwp) { await close(); throw new Error('Jendela Coretax sedang sebagai ' + auth.claims.sub + ' (' + auth.claims.full_name + '), bukan ' + npwp + ' - dihentikan.'); }
    const post = (url, body) => page.evaluate(async ([url, body, a]) => { const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Authorization: a.authorization, 'x-dgt-code': a.dgtCode }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j }; }, [url, body, auth]);
    // property: filter masa - TaxPeriodCode (BPMP, BP21), IncomePeriodCodeEnd (BPA1; automation/ebupot.js PERIOD_FILTER_PROPERTY).
    const list = async (endpoint, code, property = 'TaxPeriodCode') => {
        const rows = [];
        for (let first = 0; ; first += 500) {
            const r = await post(API + '/' + endpoint, { First: first, Rows: 500, SortField: '', SortOrder: 1, Filters: [{ PropertyName: property, Value: code, MatchMode: 'equals', CaseSensitive: true, AsString: false }], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: auth.claims.taxpayer_id });
            if (r.status !== 200 || !r.json) throw new Error('Daftar ' + endpoint + ' ' + code + ' gagal: HTTP ' + r.status);
            const d = (r.json.Payload && r.json.Payload.Data) || []; rows.push(...d);
            if (d.length < 500) break;
        }
        return rows;
    };
    const lookup = (nik) => page.evaluate(`(${LOOKUP_IN_PAGE})(${JSON.stringify([API, auth, auth.claims.identifier, nik])})`);
    return { page, auth, post, list, lookup, close };
}

/** Nama Excel vs nama resmi Coretax untuk NIK Baru. 'same': sama setelah huruf besar, tanda baca dan spasi
 *  dirapikan. 'similar': jumlah kata sama, tiap kata berawalan huruf sama dan beda paling banyak sepertiga
 *  hurufnya (jarak edit), total beda <= 3 huruf, dan minimal satu kata persis sama. Nama satu kata tidak pernah
 *  'similar' (RINA/RITA bisa dua orang berbeda)
 *  - salah eja seperti BUDI SANTOSO / BUDI SANTOSA. Selain itu 'different': kemungkinan NIK milik orang lain. */
const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}
function nameMatch(excelName, coretaxName) {
    const a = normName(excelName), b = normName(coretaxName);
    if (!a || !b) return 'different';
    if (a === b) return 'same';
    const ta = a.split(' '), tb = b.split(' ');
    if (ta.length !== tb.length || ta.length < 2) return 'different';
    let total = 0, exact = 0;
    for (let i = 0; i < ta.length; i++) {
        if (ta[i][0] !== tb[i][0]) return 'different';
        const d = editDistance(ta[i], tb[i]);
        if (d > Math.ceil(Math.max(ta[i].length, tb[i].length) / 3)) return 'different';
        total += d; if (!d) exact++;
    }
    if (total > 3 || !exact) return 'different';
    return 'similar';
}

/** Uji (submit=false) atau kirim pembetulan untuk `targets`. Mengembalikan baris hasil per bukti potong.
 *  allowSimilar: nama 'similar' (lihat nameMatch) ikut dikirim, dengan nama resmi Coretax. previous: hasil
 *  pembetulan sebelumnya dari Excel, hanya untuk pesan - yang dicari tetap bukti potong yang MASIH ber-NIK lama. */
async function run({ context, npwp, targets, year, submit, outDir, allowSimilar = false, previous = new Map(), emit = () => {} }) {
    fs.mkdirSync(outDir, { recursive: true });
    const s = await openSession(context, npwp);
    const results = [], checked = new Map();
    const save = () => fs.writeFileSync(path.join(outDir, 'hasil.json'), JSON.stringify(results, null, 1));
    try {
        const all = [];
        for (let m = 1; m <= 12; m++) { const mm = String(m).padStart(2, '0'); all.push(...await s.list('getebupotmpissued', mm + mm + year)); }
        for (const t of targets) {
            const slips = all.filter((r) => t.temp ? String(r.Name || '').trim().endsWith('#' + t.old) && r.TaxIdentificationNumber === TEMP : r.TaxIdentificationNumber === t.old);
            if (!slips.length) {
                const done = (previous.get(t.old) || []).filter((p) => /^DIBETULKAN/.test(p.status));
                emit(done.length ? 'SUDAH ' + t.old + ' -> ' + done[0].newNik + ' ' + done[0].name + ': ' + done.length + ' bukti potong dibetulkan ' + done[0].at + ' (sheet Pembetulan) - dilewati.' : t.old + ': tidak ada BPMP terbit ber-NIK ini (mungkin sudah dibetulkan).');
                continue;
            }
            if (!checked.has(t.newNik)) checked.set(t.newNik, await s.lookup(t.newNik));
            const found = checked.get(t.newNik), person = found.payload || {};
            const officialName = String(person.Name || '').trim();
            for (const slip of slips) {
                const label = t.old + ' -> ' + t.newNik + ' · ' + slip.WithholdingSlipsNumber + ' masa ' + slip.TaxPeriodCode.slice(0, 2) + '/' + year;
                const result = { old: t.old, newNik: t.newNik, newName: t.newName, number: slip.WithholdingSlipsNumber, period: slip.TaxPeriodCode, recordId: slip.RecordId, coretaxName: officialName };
                if (found.error) { result.status = 'GAGAL: validasi NIK - ' + found.error; results.push(result); emit('GAGAL ' + label + ' · validasi NIK gagal: ' + found.error); if (submit) throw new Error('validasi NIK gagal'); continue; }
                const match = nameMatch(t.newName, officialName);
                if (match === 'different') { result.status = 'BEDA NAMA - tidak dikirim'; results.push(result); emit('BEDA  ' + label + ' · Coretax: "' + officialName + '" vs Excel: "' + t.newName + '"'); continue; }
                if (match === 'similar' && !allowSimilar) { result.status = 'NAMA MIRIP - tidak dikirim'; results.push(result); emit('MIRIP ' + label + ' · Coretax: "' + officialName + '" ≈ Excel: "' + t.newName + '" - cocokkan KTP, lalu centang "Kirim juga yang namanya mirip".'); continue; }
                if (match === 'similar') result.note = 'nama mirip, dipakai nama resmi Coretax';
                const view = await s.post(API + '/viewebupotmp', { RecordId: slip.RecordId });
                const v = view.json && view.json.Payload && view.json.Payload.Result;
                if (!v || v.RecordId !== slip.RecordId) throw new Error(label + ': detail bukti potong tidak terbaca');
                fs.writeFileSync(path.join(outDir, 'cadangan-' + slip.WithholdingSlipsNumber + '.json'), JSON.stringify({ listing: slip, view: view.json }, null, 1));
                if (!['NORMAL', 'AMENDMENT'].includes(v.WithholdingSlipsStatus)) throw new Error(label + ': status ' + v.WithholdingSlipsStatus + ' bukan Normal/Pembetulan');
                // Isian sama dengan yang dikirim formulir "Ubah" Coretax (submit() pada form EBUPOT MP).
                const body = { TaxPeriodCode: v.TaxPeriodCode, WithholdingSlipsStatus: v.WithholdingSlipsStatus, IsForeignEmployee: !!v.IsForeignEmployee, TaxpayerType: person.TaxpayerType,
                    TaxIdentificationNumber: t.newNik, Name: officialName, Position: v.Position ? String(v.Position).trim() : null, TaxCertificateCode: v.TaxCertificateCode, TaxObjectCode: v.TaxObjectCode, TaxArticle: v.TaxArticle,
                    TaxObjectReferenceCode: String(v.TaxObjectReferenceCode), GrossIncome: v.GrossIncome, TaxRate: v.TaxRate, IncomeTaxWithheld: v.IncomeTaxWithheld, RevenueCode: v.RevenueCode, BranchId: v.BranchId,
                    TaxExemptionStatus: v.TaxExemptionStatus, RecordId: v.RecordId, WithholdingslipsAggregateIdentifier: v.WithholdingslipsAggregateIdentifier };
                if (!submit) { result.status = 'SIAP (uji, tidak dikirim)'; results.push(result); emit('SIAP  ' + label + ' · nama Coretax ' + officialName); continue; }
                const res = await s.post(API + '/amendebupotmp', body);
                if (res.status !== 200 || !res.json || res.json.IsSuccessful === false) {
                    result.status = 'GAGAL: ditolak Coretax'; results.push(result); save();
                    throw new Error(label + ': ditolak Coretax - HTTP ' + res.status + ' ' + JSON.stringify(res.json && (res.json.Message || res.json.Errors || res.json.Payload)).slice(0, 300));
                }
                const after = (await s.list('getebupotmpissued', slip.TaxPeriodCode)).find((r) => r.WithholdingSlipsNumber === slip.WithholdingSlipsNumber);
                const ok = after && after.WithholdingSlipsStatus === 'AMENDMENT' && after.TaxIdentificationNumber === t.newNik && after.GrossIncome === slip.GrossIncome;
                result.status = ok ? 'DIBETULKAN' + (result.note ? ' (' + result.note + ')' : '') : 'PERIKSA - hasil tidak sesuai'; results.push(result); save();
                emit((ok ? 'OK    ' : 'CEK   ') + label + ' · ' + (after ? after.WithholdingSlipsStatus + ' ' + after.TaxIdentificationNumber + ' ' + after.Name : 'tidak ditemukan di Telah Terbit'));
                if (!ok) throw new Error(label + ': verifikasi sesudah kirim tidak sesuai');
            }
        }
    } catch (e) { e.results = results; throw e; } finally { save(); await s.close(); }
    return results;
}

/** Pemeriksaan independen (hanya membaca): bukti potong yang DIBETULKAN di `dirs` dibuka lagi dari Coretax
 *  dan dibandingkan per kolom dengan cadangannya; versi lamanya harus ada di Tidak Valid sebagai AMENDED. */
async function check({ context, npwp, dirs, emit = () => {} }) {
    const backups = new Map(), expected = new Map();
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const file of dirs.flatMap(walk)) {
        if (/hasil\.json$/.test(file)) for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) if (/^DIBETULKAN/.test(r.status)) expected.set(r.number, r);
        if (/cadangan-.*\.json$/.test(file)) { const v = JSON.parse(fs.readFileSync(file, 'utf8')).view.Payload.Result; backups.set(v.WithholdingSlipsNumber + '|' + v.RecordId, v); }
    }
    const s = await openSession(context, npwp);
    const cache = new Map(), get = async (ep, code) => { if (!cache.has(ep + code)) cache.set(ep + code, await s.list(ep, code)); return cache.get(ep + code); };
    let ok = 0, bad = 0;
    const details = new Map();
    try {
        for (const [number, exp] of expected) {
            const before = backups.get(number + '|' + exp.recordId); if (!before) continue;
            const problems = [];
            const now = (await get('getebupotmpissued', before.TaxPeriodCode)).find((r) => r.WithholdingSlipsNumber === number);
            if (!now) problems.push('tidak ada di Telah Terbit');
            else {
                const after = (await s.post(API + '/viewebupotmp', { RecordId: now.RecordId })).json.Payload.Result;
                if (after.TaxIdentificationNumber !== exp.newNik) problems.push('NIK ' + after.TaxIdentificationNumber);
                if (normName(after.Name) !== normName(exp.coretaxName || exp.newName)) problems.push('Nama ' + after.Name);
                if (after.WithholdingSlipsStatus !== 'AMENDMENT') problems.push('status ' + after.WithholdingSlipsStatus);
                if (String(after.WithholdingSlipsDate).slice(0, 10) !== String(after.CreationDate).slice(0, 10)) problems.push('tanggal pemotongan ' + after.WithholdingSlipsDate + ' bukan tanggal pembetulan');
                for (const k of Object.keys(before)) if (!ALLOWED.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])) problems.push(k + ': ' + JSON.stringify(before[k]) + ' -> ' + JSON.stringify(after[k]));
            }
            const old = (await get('getebupotmpinvalid', before.TaxPeriodCode)).find((r) => r.RecordId === before.RecordId);
            if (!old || old.WithholdingSlipsStatus !== 'AMENDED') problems.push('versi lama tidak ada di Tidak Valid sebagai AMENDED');
            details.set(number, problems.length ? 'MASALAH: ' + problems.join(' · ') : 'BENAR');
            if (problems.length) { bad++; emit('MASALAH ' + number + ' masa ' + before.TaxPeriodCode.slice(0, 2) + ' · ' + problems.join(' · ')); }
            else { ok++; emit('BENAR   ' + number + ' masa ' + before.TaxPeriodCode.slice(0, 2) + ' · ' + exp.old + ' -> ' + exp.newNik + ' ' + exp.newName + ' · kolom lain identik'); }
        }
    } finally { await s.close(); }
    return { ok, bad, details };
}

/** NIK bermasalah, aturan yang sama dengan sheet NIK rekap Mode A1 (lib/a1-workbook.js nikIssues): NIK
 *  sementara, atau nomor urut 0000. Ditambah: bukan 16 digit. Pegawai asing (paspor, bukan NIK) dikecualikan. */
function nikProblem(slip) {
    const id = String(slip.TaxIdentificationNumber || '').trim();
    if (slip.IsForeignEmployee) return null;
    if (id === TEMP) { const m = /#\s*(\S+)\s*$/.exec(String(slip.Name || '')); return 'NIK sementara' + (m ? ' (NIK lama ' + m[1] + ')' : ''); }
    if (!/^\d{16}$/.test(id)) return 'bukan 16 digit';
    if (id.endsWith('0000')) return 'nomor urut 0000';
    return null;
}

/** Penyisiran setahun (hanya membaca): seluruh BPMP Telah Terbit Januari-Desember `year`, langsung dari Coretax,
 *  diperiksa dengan nikProblem. Menjawab "masih ada NIK bermasalah?" setelah pembetulan - termasuk NIK yang
 *  tidak ada di Excel, baris yang dilewati, beda nama, dan bukti potong yang terbit setelah rekap dibuat.
 *  Tidak bergantung pada SPT Masa (Mode A1 baru berubah setelah SPT Masa-nya dibetulkan). */
async function sweep({ context, npwp, year, outDir, emit = () => {} }) {
    const s = await openSession(context, npwp);
    const problems = [], sptMasa = [], amendedSlips = [];
    let total = 0;
    try {
        for (let m = 1; m <= 12; m++) {
            const mm = String(m).padStart(2, '0'), rows = await s.list('getebupotmpissued', mm + mm + year);
            total += rows.length;
            const gross = (r) => Number(r.GrossIncome ?? r.TaxBase) || 0, tax = (r) => Number(r.IncomeTaxWithheld ?? r.IncomeTax) || 0;
            for (const r of rows) { const why = nikProblem(r); if (why) problems.push({ nik: r.TaxIdentificationNumber, name: String(r.Name || '').trim(), number: r.WithholdingSlipsNumber, masa: mm, status: r.WithholdingSlipsStatus, why, gross: gross(r), tax: tax(r) }); }
            // Bukti potong pembetulan yang belum dilaporkan di SPT = SPT Masa masa ini belum dibetulkan. (Semua 24 cadangan
            // uji live 2026-11-05 bernilai IsReportedToTaxReturn true sebelum dibetulkan; nilai sesudah SPT pembetulan belum terlihat live.)
            const amended = rows.filter((r) => r.WithholdingSlipsStatus === 'AMENDMENT');
            if (amended.length) sptMasa.push({ masa: mm, amended: amended.length, notReported: amended.filter((r) => !r.IsReportedToTaxReturn).length });
            // Per bukti potong, supaya Ringkasan bisa menghitungnya dengan COUNTIFS dari sheet Pembetulan.
            for (const r of amended) amendedSlips.push({ number: r.WithholdingSlipsNumber, masa: mm, nik: r.TaxIdentificationNumber, name: String(r.Name || "").trim(), reported: !!r.IsReportedToTaxReturn, gross: gross(r), tax: tax(r) });
        }
    } finally { await s.close(); }
    const people = [...new Set(problems.map((p) => p.nik + '|' + p.name))];
    if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'penyisiran-nik-' + year + '.json'), JSON.stringify({ year, total, problems }, null, 1)); }
    if (!problems.length) emit('PENYISIRAN ' + year + ': ' + total + ' BPMP Telah Terbit diperiksa - tidak ada NIK bermasalah lagi.');
    else {
        emit('PENYISIRAN ' + year + ': ' + total + ' BPMP Telah Terbit diperiksa - MASIH ADA ' + people.length + ' NIK bermasalah di ' + problems.length + ' bukti potong:');
        for (const p of problems) emit('MASIH  ' + p.nik + ' ' + p.name + ' · ' + p.number + ' masa ' + p.masa + '/' + year + ' · ' + p.why);
    }
    const pending = sptMasa.filter((m) => m.notReported).map((m) => m.masa);
    if (sptMasa.length) emit(pending.length ? 'SPT MASA PPh 21 belum dibetulkan: masa ' + pending.join(', ') + '/' + year + ' (bukti potong pembetulannya belum dilaporkan di SPT).' : 'SPT MASA PPh 21: semua bukti potong pembetulan ' + year + ' sudah dilaporkan di SPT.');
    return { total, problems, people: people.length, sptMasa, amendedSlips, checkedAt: new Date() };
}

module.exports = { readTargets, run, check, sweep, nikProblem, nameMatch, openSession };
