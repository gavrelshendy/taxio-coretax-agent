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
    const targets = [], skipped = [], cancels = [], exclude = new Set();
    ws.eachRow((row, n) => {
        if (n <= headRow) return;
        const nik = String(text(row.getCell(cNik).value) || '').trim();
        const raw = text(row.getCell(cNew).value); if (raw === null || raw === undefined || raw === '') return;
        if (!/^\d{16}$/.test(nik)) { if (nik) skipped.push('Sheet NIK baris ' + n + ' (NIK "' + nik + '"): NIK bukan 16 digit - bila NIK di L-IA diubah manual, kembalikan dan isi NIK Baru per bukti potong di sheet Pembetulan.'); return; }
        const old = nik === TEMP ? String(text(row.getCell(cOld).value) || '').trim() : nik;
        if (typeof raw === 'number') { skipped.push(old + ': NIK Baru tersimpan sebagai angka (digit akhir bisa hilang) - ketik ulang sebagai teks.'); return; }
        const newNik = String(raw).trim(), newName = String(text(row.getCell(cName).value) || '').trim();
        if (!/^\d{16}$/.test(newNik)) { skipped.push(old + ': NIK Baru "' + newNik + '" bukan 16 digit.'); return; }
        if (!newName) { skipped.push(old + ': Nama Baru kosong.'); return; }
        if (!/^\d{16}$/.test(old)) { skipped.push((old || nik) + ': NIK lama tidak terbaca.'); return; }
        targets.push({ temp: nik === TEMP, old, newNik, newName });
    });
    // Isian per bukti potong di sheet Pembetulan: NIK Baru diketik langsung (bukan rumus ke sheet NIK). Untuk NIK yang
    // dipakai dua orang - hanya bukti potong yang diisi yang dibetulkan; sisanya tetap.
    const pb = wb.getWorksheet('Pembetulan');
    if (pb) {
        const R = require('../lib/bpmp-report'), hr = R.detectHead(pb), h = R.headerMap(pb, hr), g = (r, k) => (h.has(k) ? r.getCell(h.get(k)).value : null);
        if (h.has('Nomor Bukti Potong') && h.has('NIK Baru')) pb.eachRow((row, n) => {
            if (n <= hr) return;
            const number = String(text(g(row, 'Nomor Bukti Potong')) || '').trim(); if (!number) return;
            const slipNik = String(text(g(row, 'NIK di Bukti Potong')) || '').trim(), temp = slipNik === TEMP;
            // NIK sementara tanpa "#NIK lama" di nama (NIK asli sama sekali tidak bisa dipakai): dikenali dari nomornya saja.
            const old = temp ? (String(text(g(row, 'NIK Lama (dari #)')) || '').trim() || TEMP) : slipNik;
            const status = String(text(g(row, 'Status')) || ''), tind = String(text(g(row, 'Tindakan')) || '').trim();
            // Tindakan: Biarkan = bukti potong ini dilewati (juga oleh isian sheet NIK); Batalkan = dibatalkan sesudah konfirmasi.
            if (tind === 'Biarkan') { exclude.add(number); return; }
            if (tind === 'Batalkan') {
                exclude.add(number);
                if (!/^(Dibatalkan|Sudah dibatalkan)/.test(status)) cancels.push({ number, nik: slipNik, name: String(text(g(row, 'Nama di Bukti Potong')) || '').trim(), masa: String(text(g(row, 'Masa')) || '').trim(), gross: text(g(row, 'Penghasilan Bruto (Rp)')) });
                return;
            }
            if (tind && tind !== 'Ganti NIK') { skipped.push(number + ': Tindakan "' + tind + '" tidak dikenal - pilih Ganti NIK, Batalkan atau Biarkan.'); exclude.add(number); return; }
            const cell = g(row, 'NIK Baru'); if (cell === null || cell === undefined || cell === '' || (typeof cell === 'object' && cell.formula)) return;
            if (/^DIBETULKAN/.test(status)) return;
            const raw = text(cell);
            if (typeof raw === 'number') { skipped.push(number + ': NIK Baru tersimpan sebagai angka - ketik ulang sebagai teks.'); return; }
            const newNik = String(raw).trim(), newName = String(text(g(row, 'Nama Baru')) || '').trim();
            if (!/^\d{16}$/.test(newNik)) { skipped.push(number + ': NIK Baru "' + newNik + '" bukan 16 digit.'); return; }
            if (!newName) { skipped.push(number + ': Nama Baru kosong.'); return; }
            if (!/^\d{16}$/.test(old)) { skipped.push(number + ': NIK di Bukti Potong "' + slipNik + '" tidak terbaca - harus sama dengan NIK di Coretax.'); return; }
            if (newNik === old) return;
            // Masa dari Excel: bukti potong bisa diambil langsung per nomor (tanpa membaca setahun).
            const masa = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'].indexOf(String(text(g(row, 'Masa')) || '').trim()) + 1;
            targets.push({ temp, old, newNik, newName, number, masa: masa || null });
        });
    }
    // Hasil pembetulan sebelumnya (sheet "Pembetulan", lib/bpmp-report.js) - untuk melanjutkan tanpa mengulang.
    const previous = require('../lib/bpmp-report').readPrevious(wb);
    // Tahun dari kop lampiran ("... · Tahun 2026").
    let year = null;
    for (const sheet of wb.worksheets) { const m = /Tahun (20\d{2})/.exec(String(text(sheet.getCell(3, 1).value) || '')); if (m) { year = m[1]; break; } }
    return { targets, skipped, year, previous, cancels, exclude };
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
    // Satu bukti potong (cek sesudah kirim): disaring nomornya di server - satu permintaan kecil, bukan seluruh masa
    // (ribuan baris). Bila saringan nomor tidak didukung / tidak ketemu, jatuh ke daftar masa lengkap.
    const find = async (endpoint, code, number) => {
        try {
            const r = await post(API + '/' + endpoint, { First: 0, Rows: 50, SortField: '', SortOrder: 1, Filters: [{ PropertyName: 'TaxPeriodCode', Value: code, MatchMode: 'equals', CaseSensitive: true, AsString: false }, { PropertyName: 'WithholdingSlipsNumber', Value: number, MatchMode: 'equals', CaseSensitive: true, AsString: true }], LanguageId: 'id-ID', TaxpayerAggregateIdentifier: auth.claims.taxpayer_id });
            const hit = r.status === 200 && r.json && ((r.json.Payload && r.json.Payload.Data) || []).find((x) => x.WithholdingSlipsNumber === number);
            if (hit) return hit;
        } catch (e) { /* jatuh ke daftar lengkap */ }
        return (await list(endpoint, code)).find((x) => x.WithholdingSlipsNumber === number) || null;
    };
    const lookup = (nik) => page.evaluate(`(${LOOKUP_IN_PAGE})(${JSON.stringify([API, auth, auth.claims.identifier, nik])})`);
    return { page, auth, post, list, find, lookup, close };
}

/** BPMP Telah Terbit Januari-Desember `year`, 4 masa sekaligus (dulu satu per satu: ~1 menit untuk ~2.500 BPMP/masa).
 *  Mengembalikan larik 12 masa; setiap baris diberi _masa (1-12). */
async function listYear(s, year, emit, endpoint = 'getebupotmpissued') {
    const out = new Array(12); let next = 0;
    const worker = async () => {
        for (;;) {
            const m = ++next; if (m > 12) return;
            const mm = String(m).padStart(2, '0'), rows = await s.list(endpoint, mm + mm + year);
            out[m - 1] = rows.map((r) => ({ ...r, _masa: m }));
            if (emit) emit('  masa ' + mm + '/' + year + ': ' + rows.length + ' BPMP');
        }
    };
    await Promise.all([1, 2, 3, 4].map(worker));
    return out;
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
/** Banyaknya huruf yang berbeda antara dua nama, tanpa memperhitungkan spasi dan tanda baca. */
function nameGap(a, b) { return editDistance(normName(a).replace(/ /g, ''), normName(b).replace(/ /g, '')); }
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
async function run({ context, npwp, targets, year, submit, outDir, allowSimilar = false, previous = new Map(), exclude = new Set(), emit = () => {}, session = null }) {
    fs.mkdirSync(outDir, { recursive: true });
    const s = session || await openSession(context, npwp);
    const results = [], checked = new Map();
    const save = () => fs.writeFileSync(path.join(outDir, 'hasil.json'), JSON.stringify(results, null, 1));
    try {
        const all = [];
        // Membaca 12 masa bisa lebih dari semenit: tulis kemajuannya supaya tidak tampak macet.
        // Hanya isian per bukti potong (nomor + masa dari Excel): ambil nomor itu saja. Ada isian sheet NIK (NIK lama bisa
        // ada di masa mana pun, termasuk bukti potong yang terbit sesudah rekap dibuat) atau ada nomor yang tidak ketemu
        // di masanya: baca setahun - lebih lama, tetapi tidak ada yang terlewat.
        const direct = targets.length && targets.every((t) => t.number && t.masa);
        let readYear = !direct;
        if (direct) {
            emit('Mengambil ' + targets.length + ' bukti potong langsung dari Coretax (per nomor, tanpa membaca setahun)...');
            for (const t of targets) {
                const mm = String(t.masa).padStart(2, '0'), r = await s.find('getebupotmpissued', mm + mm + year, t.number);
                if (r) all.push(r); else { emit(t.number + ': tidak ada di BPMP Telah Terbit masa ' + mm + '/' + year + ' - membaca setahun untuk memastikan.'); readYear = true; break; }
            }
        }
        if (readYear) {
            all.length = 0;
            emit('Membaca BPMP Telah Terbit ' + year + ' (Januari-Desember) dari Coretax...');
            for (const rows of await listYear(s, year, emit)) all.push(...rows);
        }
        // Isian per bukti potong (sheet Pembetulan, t.number) didahulukan: bukti potong itu tidak ikut isian per NIK
        // (satu NIK bisa dipakai dua orang - mis. sebagian BPMP ber-NIK A sebenarnya milik B).
        // exclude: Tindakan Biarkan / Batalkan di sheet Pembetulan - tidak ikut diganti NIK-nya.
        const perSlip = new Set([...targets.filter((t) => t.number).map((t) => t.number), ...exclude]);
        for (const t of targets) {
            const slips = t.number
                ? all.filter((r) => String(r.WithholdingSlipsNumber) === t.number && (t.temp ? r.TaxIdentificationNumber === TEMP : r.TaxIdentificationNumber === t.old))
                : all.filter((r) => !perSlip.has(String(r.WithholdingSlipsNumber)) && (t.temp ? String(r.Name || '').trim().endsWith('#' + t.old) && r.TaxIdentificationNumber === TEMP : r.TaxIdentificationNumber === t.old));
            if (t.number && !slips.length) {
                const now = all.find((r) => String(r.WithholdingSlipsNumber) === t.number);
                emit(now && now.TaxIdentificationNumber === t.newNik ? 'SUDAH ' + t.number + ': NIK sudah ' + t.newNik + ' - dilewati.'
                    : t.number + ': tidak ada BPMP terbit bernomor ini dengan NIK ' + t.old + (now ? ' (NIK di Coretax ' + now.TaxIdentificationNumber + ')' : ' (mungkin sudah dibetulkan / diganti nomor baru)') + ' - dilewati.');
                continue;
            }
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
                // NIK salah: NIK di bukti potong valid (16 digit, bukan sementara / 0000) tetapi milik orang lain.
                const kind = t.temp || nikProblem(slip) ? 'NIK bermasalah' : 'NIK salah';
                const result = { old: t.old, newNik: t.newNik, newName: t.newName, number: slip.WithholdingSlipsNumber, period: slip.TaxPeriodCode, recordId: slip.RecordId, coretaxName: officialName,
                    kind, slipNik: String(slip.TaxIdentificationNumber || ''), slipName: String(slip.Name || '').trim(), gross: slip.GrossIncome, tax: slip.IncomeTaxWithheld };
                if (found.error) { result.status = 'GAGAL: validasi NIK - ' + found.error; results.push(result); emit('GAGAL ' + label + ' · validasi NIK gagal: ' + found.error); if (submit) throw new Error('validasi NIK gagal'); continue; }
                const match = nameMatch(t.newName, officialName);
                if (match === 'different') { result.status = 'BEDA NAMA - tidak dikirim'; results.push(result); emit('BEDA  ' + label + ' · Coretax: "' + officialName + '" vs Excel: "' + t.newName + '"'); continue; }
                // Beda satu huruf saja (mis. R. BAGAS PRIYANTO / R.BAGAS PRYANTO): salah ketik, dikirim dengan nama resmi Coretax.
                const minor = match === 'similar' && nameGap(t.newName, officialName) <= 1;
                if (match === 'similar' && !allowSimilar && !minor) { result.status = 'NAMA MIRIP - tidak dikirim'; results.push(result); emit('MIRIP ' + label + ' · Coretax: "' + officialName + '" ≈ Excel: "' + t.newName + '" - cocokkan KTP, lalu centang "Kirim juga yang namanya mirip".'); continue; }
                if (match === 'similar') result.note = (minor ? 'nama beda 1 huruf' : 'nama mirip') + ', dipakai nama resmi Coretax';
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
                const after = await s.find('getebupotmpissued', slip.TaxPeriodCode, slip.WithholdingSlipsNumber);
                const ok = after && after.WithholdingSlipsStatus === 'AMENDMENT' && after.TaxIdentificationNumber === t.newNik && after.GrossIncome === slip.GrossIncome;
                result.status = ok ? 'DIBETULKAN' + (result.note ? ' (' + result.note + ')' : '') : 'PERIKSA - hasil tidak sesuai'; results.push(result); save();
                emit((ok ? 'OK    ' : 'CEK   ') + label + ' · ' + (after ? after.WithholdingSlipsStatus + ' ' + after.TaxIdentificationNumber + ' ' + after.Name : 'tidak ditemukan di Telah Terbit'));
                if (!ok) throw new Error(label + ': verifikasi sesudah kirim tidak sesuai');
            }
        }
    } catch (e) { e.results = results; throw e; } finally { save(); if (!session) await s.close(); }
    return results;
}

/** Batalkan BPMP yang Tindakan-nya "Batalkan" di sheet Pembetulan - hanya nomor yang ada di `confirmed` (dikonfirmasi
 *  pengguna setelah melihat daftarnya). Bukti potong harus masih Telah Terbit dengan NIK yang sama seperti di Excel.
 *  Mengembalikan [{row, ok, msg, number}] (bentuk sama dengan lib/ebupot-vs-spt.js autoCancelZero). */
async function cancelSlips({ context, npwp, year, cancels, confirmed, emit = () => {} }) {
    const ok = new Set(confirmed || []), todo = cancels.filter((c) => ok.has(c.number));
    for (const c of cancels) if (!ok.has(c.number)) emit('LEWATI BATAL ' + c.number + ': belum dikonfirmasi.');
    if (!todo.length) return [];
    const s = await openSession(context, npwp), done = [];
    try {
        const all = [];
        for (const rows of await listYear(s, year)) all.push(...rows);
        for (const c of todo) {
            const r = all.find((x) => String(x.WithholdingSlipsNumber) === c.number);
            if (!r) { emit('LEWATI BATAL ' + c.number + ': tidak ada di BPMP Telah Terbit ' + year + ' (sudah dibatalkan / diganti?).'); continue; }
            if (c.nik && r.TaxIdentificationNumber !== c.nik) { emit('LEWATI BATAL ' + c.number + ': NIK di Coretax ' + r.TaxIdentificationNumber + ' berbeda dengan Excel ' + c.nik + ' - periksa dulu.'); continue; }
            const x = await require('../lib/ebupot-vs-spt').cancelOne(s, r, year);
            done.push({ ...x, number: c.number });
            emit((x.ok ? 'DIBATALKAN  ' : 'GAGAL BATAL ') + 'BPMP ' + c.number + ' masa ' + r._masa + '/' + year + ' · ' + r.TaxIdentificationNumber + ' ' + String(r.Name || '').trim() + (x.ok ? (r.IsReportedToTaxReturn ? ' - sudah dilaporkan di SPT, SPT Masa perlu dibetulkan.' : '.') : ': ' + x.msg + ' - batalkan manual di e-Bupot.'));
        }
    } finally { await s.close(); }
    return done;
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
        const byMasa = await listYear(s, year);
        for (let m = 1; m <= 12; m++) {
            const mm = String(m).padStart(2, '0'), rows = byMasa[m - 1];
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

module.exports = { readTargets, run, cancelSlips, listYear, check, sweep, nikProblem, nameMatch, nameGap, openSession };
