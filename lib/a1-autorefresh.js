'use strict';
/* Perbarui rekap. Pemantauan otomatis DIMATIKAN atas permintaan pengguna (2026-11-09: "mending saya manual aja") - hanya
 * lewat tombol Perbarui rekap, dengan log apa saja yang berubah. Kode pemantau dibiarkan (AUTO = false) bila suatu saat
 * diaktifkan lagi. Latar belakang (permintaan 2026-11-09): pengguna mengetik NIK Baru di sheet Pembetulan untuk orang yang belum
 * punya baris di sheet NIK -> angkanya sudah pindah lewat rumus (kolom L-IA "NIK setelah pembetulan"), tetapi barisnya baru
 * bisa dibuat dengan menyusun ulang rekap. Pilot memantau rekap yang dipakai di sesi ini; begitu file berubah dan Excel
 * sudah ditutup, Pilot memeriksa apakah ada NIK setelah pembetulan yang belum punya baris, dan bila ada menyusun ulang rekap
 * di tempat (lib/a1-import.js convertA1Workbook, tanpa Coretax, isian ikut). Tanpa makro: file tetap .xlsx biasa. */
const fs = require('fs'), os = require('os'), path = require('path');
const { log, showPopup } = require('./log');

const NAME = /^(.*?)\s*(20\d{2}) - Rekap SPT PPh 21 Setahun \(A1\)/i;
const TEMP_NIK = '9990000000999000';
const AUTO = false;
const files = new Map();
let timer = null, busy = false;

const text = (v) => String(v && typeof v === 'object' ? (v.result ?? v.text ?? '') : v ?? '').trim();
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return null; } };

/** Pantau rekap ini (dipanggil saat Pilot memakai / menulis rekap). */
function watch(file) {
    try {
        if (!file || !/\.xlsx$/i.test(file) || !NAME.test(path.basename(file)) || !fs.existsSync(file)) return;
        const k = path.resolve(file);
        if (!files.has(k)) files.set(k, { mtime: mtime(k), dirty: false });
        if (AUTO && !timer) { timer = setInterval(() => tick().catch(() => {}), 15000); if (timer.unref) timer.unref(); }
    } catch (e) { /* abaikan */ }
}
/** Pilot sendiri baru menulis file ini: bukan perubahan dari pengguna. */
function own(file) { const k = path.resolve(file || ''); const f = files.get(k); if (f) { f.mtime = mtime(k); f.dirty = false; } else watch(file); }
/** Masih dibuka di Excel: ada file kunci "~$<nama>" atau file tidak bisa dibuka untuk ditulis. */
function locked(file) {
    if (fs.existsSync(path.join(path.dirname(file), '~$' + path.basename(file)))) return true;
    try { fs.closeSync(fs.openSync(file, 'r+')); return false; } catch (e) { return true; }
}
/** NIK setelah pembetulan (L-IA) yang belum punya baris di sheet NIK -> [{nik}]. */
async function missingPeople(file) {
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const l = wb.getWorksheet('L-IA'), nk = wb.getWorksheet('NIK');
    if (!l || !nk) return [];
    let head = 0; l.eachRow((r, n) => { if (!head && n > 5 && text(r.getCell(1).value) === 'Masa') head = n; });
    if (!head) return [];
    let col = 0; l.getRow(head).eachCell((c, i) => { if (text(c.value) === 'NIK setelah pembetulan') col = i; });
    if (!col) return [];
    let nh = 0; nk.eachRow((r, n) => { if (!nh && n <= 10 && text(r.getCell(1).value) === 'NIK' && text(r.getCell(2).value) === 'Nama') nh = n; });
    const have = new Set(); nk.eachRow((r, n) => { if (n > nh) have.add(text(r.getCell(1).value)); });
    const miss = new Set();
    for (let n = head + 1; n <= l.rowCount; n++) {
        const v = text(l.getCell(n, col).value);
        if (/^\d{16}$/.test(v) && v !== TEMP_NIK && !have.has(v)) miss.add(v);
    }
    return [...miss];
}
/** Susun ulang rekap di tempat: dikerjakan di folder sementara (rekap lain di folder yang sama tidak ikut terbaca), lalu
 *  disalin kembali ke nama file yang sama. */
/** Ringkasan rekap untuk log Perbarui rekap: orang di sheet NIK (NIK -> nama, bruto), Draft Desember, Kontrol, isian. */
async function summary(file) {
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const out = { people: new Map(), draft: new Set(), kontrol: null, perSlip: 0, invalid: [] };
    const nk = wb.getWorksheet('NIK');
    if (nk) {
        let nh = 0; nk.eachRow((r, n) => { if (!nh && n <= 10 && text(r.getCell(1).value) === 'NIK' && text(r.getCell(2).value) === 'Nama') nh = n; });
        nk.eachRow((r, n) => { if (n > nh) { const id = text(r.getCell(1).value); if (/^\d{16}$/.test(id) && id !== TEMP_NIK) out.people.set(id, { name: text(r.getCell(2).value), bruto: Number(text(r.getCell(9).value)) || 0 }); } });
        // Kontrol dihitung sendiri (nilai tersimpan rumus Kontrol di file tulisan Pilot selalu 0 sampai Excel menghitungnya):
        // jumlah bruto semua baris sheet NIK (termasuk NIK sementara) - jumlah bruto L-IA.
        let sumNik = 0; nk.eachRow((r, n) => { if (n > nh && text(r.getCell(1).value)) sumNik += Number(text(r.getCell(9).value)) || 0; });
        const l = wb.getWorksheet('L-IA'); let lh = 0, bc = 0, sumL = 0;
        if (l) {
            l.eachRow((r, n) => { if (!lh && n > 5 && text(r.getCell(1).value) === 'Masa') lh = n; });
            if (lh) l.getRow(lh).eachCell((c, i) => { if (!bc && /BRUTO/i.test(text(c.value))) bc = i; });
            const num = (v) => typeof v === 'number' ? v : Number(String(text(v)).replace(/\./g, '').replace(',', '.')) || 0;
            if (bc) for (let n = lh + 1; n <= l.rowCount; n++) { if (!text(l.getCell(n, 1).value) || !text(l.getCell(n, 5).value)) continue; sumL += num(l.getCell(n, bc).value); }
            out.kontrol = Math.round(sumNik - sumL);
        }
    }
    const d = wb.getWorksheet('Draft SPT Desember');
    if (d) { let dh = 0; d.eachRow((r, n) => { if (!dh && text(r.getCell(1).value) === 'NIK') dh = n; }); d.eachRow((r, n) => { if (n > dh && /^\d{16}$/.test(text(r.getCell(1).value))) out.draft.add(text(r.getCell(1).value)); }); }
    const pb = wb.getWorksheet('Pembetulan');
    if (pb) { const R = require('./bpmp-report'), hr = R.detectHead(pb), h = R.headerMap(pb, hr); if (h.has('NIK Baru')) pb.eachRow((r, n) => { const v = r.getCell(h.get('NIK Baru')).value; if (n > hr && R.isLiteral(v)) { if (/^\d{16}$/.test(text(v))) out.perSlip++; else out.invalid.push(text(r.getCell(h.get('Nomor Bukti Potong')).value) + ' "' + text(v) + '"'); } }); }
    return out;
}
const rp = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const names = (list) => list.slice(0, 10).join(', ') + (list.length > 10 ? ', … (+' + (list.length - 10) + ')' : '');
async function refreshInPlace(file, emit = log) {
    // Satu penulis per rekap (lib/file-lock.js): Pembetulan / Unduh setahun bisa menulis berkas yang sama bersamaan.
    return require('./file-lock').withFileLock(file, () => refreshInPlaceNow(file, emit));
}
async function refreshInPlaceNow(file, emit) {
    const m = NAME.exec(path.basename(file)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-rekap-')), t0 = Date.now();
    try {
        emit('Perbarui rekap 1/3: membaca rekap dan isian (sheet NIK, Pembetulan, Draft SPT Desember)...');
        const before = await summary(file);
        emit('  ' + before.people.size + ' orang di sheet NIK · ' + before.draft.size + ' di Draft SPT Desember · ' + before.perSlip + ' isian NIK Baru per bukti potong di sheet Pembetulan' + (before.kontrol ? ' · Kontrol sheet NIK belum 0 (selisih ' + rp(before.kontrol) + ')' : '') + '.');
        if (before.invalid.length) emit('  PERHATIAN: ' + before.invalid.length + ' isian NIK Baru bukan 16 digit - tidak dipakai (perbaiki lalu Perbarui rekap lagi): ' + names(before.invalid) + '.');
        // Stop / Jeda: sebelum menyusun ulang dan sebelum rekap ditimpa (satu salin berkas utuh, tidak pernah setengah ditulis).
        const rc = require('./runcontrol');
        const safePoint = async () => { try { await rc.checkpoint(); } catch (e) { if (e && e.isStop) emit('Dihentikan sebelum rekap ditulis - ' + path.basename(file) + ' tidak berubah.'); throw e; } };
        await safePoint();
        emit('Perbarui rekap 2/3: menyusun ulang sheet NIK, Pembetulan dan Draft SPT Desember (tanpa Coretax)...');
        const { result } = await require('./a1-import').convertA1Workbook(file, tmp, m ? m[1] : '');
        await safePoint();
        fs.copyFileSync(result.file, file);
        own(file);
        emit('Perbarui rekap 3/3: memeriksa hasil...');
        const after = await summary(file);
        const added = [...after.people.keys()].filter((k) => !before.people.has(k)), removed = [...before.people.keys()].filter((k) => !after.people.has(k));
        const moved = [...after.people.keys()].filter((k) => before.people.has(k) && Math.abs(after.people.get(k).bruto - before.people.get(k).bruto) >= 1);
        const dAdd = [...after.draft].filter((k) => !before.draft.has(k)), dDel = [...before.draft].filter((k) => !after.draft.has(k));
        const nm = (s) => (k) => (s.people.get(k) || {}).name || k;
        emit('  Sheet NIK: ' + after.people.size + ' orang' + (added.length ? ' · baris baru: ' + names(added.map(nm(after))) : '') + (removed.length ? ' · baris hilang (tidak ada bukti potong lagi): ' + names(removed.map(nm(before))) : '') + (!added.length && !removed.length ? ' · tidak ada orang baru / hilang' : '') + '.');
        if (moved.length) emit('  Jumlah berubah (bukti potong pindah NIK): ' + names(moved.map((k) => nm(after)(k) + ' ' + rp(before.people.get(k).bruto) + ' -> ' + rp(after.people.get(k).bruto))) + '.');
        emit('  Draft SPT Desember: ' + after.draft.size + ' orang' + (dAdd.length ? ' · masuk: ' + names(dAdd.map(nm(after))) : '') + (dDel.length ? ' · keluar: ' + names(dDel.map(nm(before))) : '') + '.');
        emit('  Kontrol sheet NIK: ' + (after.kontrol ? 'selisih ' + rp(after.kontrol) + ' - periksa' : '0 (cocok dengan L-IA)') + ' · isian dibawa: ' + (result.carriedInputs || 0) + ' NIK + ' + after.perSlip + ' per bukti potong · ' + Math.round((Date.now() - t0) / 1000) + ' dtk.');
        emit('Rekap disimpan: ' + file);
        return result;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function tick() {
    if (busy) return;
    const rc = require('./runcontrol');
    for (const [file, f] of files) {
        const now = mtime(file);
        if (now === null) { files.delete(file); continue; }
        if (now !== f.mtime) { f.mtime = now; f.dirty = true; }
        if (!f.dirty || locked(file) || rc.anyActive()) continue;
        f.dirty = false; busy = true;
        try {
            const miss = await missingPeople(file);
            if (!miss.length) continue;
            try { rc.start('Auto-refresh rekap · ' + path.basename(file)); } catch (e) { f.dirty = true; continue; }
            try {
                log('Perbarui rekap otomatis: ' + miss.length + ' NIK baru dari sheet Pembetulan belum punya baris di sheet NIK (' + miss.slice(0, 5).join(', ') + (miss.length > 5 ? ', …' : '') + ') - menyusun ulang ' + path.basename(file) + '...');
                await refreshInPlace(file);
                showPopup('Rekap ' + path.basename(file) + ' diperbarui otomatis: ' + miss.length + ' orang baru sekarang punya baris di sheet NIK dan Draft SPT Desember.', 'Perbarui rekap', 'Info');
            } finally { rc.finish(); }
        } catch (e) { log('Perbarui rekap otomatis gagal (' + path.basename(file) + '): ' + e.message); }
        finally { busy = false; }
    }
}
module.exports = { watch, own, refreshInPlace, summary, missingPeople, locked, _tick: tick, _files: files };
