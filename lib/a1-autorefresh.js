'use strict';
/* Perbarui rekap otomatis (permintaan 2026-11-09): pengguna mengetik NIK Baru di sheet Pembetulan untuk orang yang belum
 * punya baris di sheet NIK -> angkanya sudah pindah lewat rumus (kolom L-IA "NIK setelah pembetulan"), tetapi barisnya baru
 * bisa dibuat dengan menyusun ulang rekap. Pilot memantau rekap yang dipakai di sesi ini; begitu file berubah dan Excel
 * sudah ditutup, Pilot memeriksa apakah ada NIK setelah pembetulan yang belum punya baris, dan bila ada menyusun ulang rekap
 * di tempat (lib/a1-import.js convertA1Workbook, tanpa Coretax, isian ikut). Tanpa makro: file tetap .xlsx biasa. */
const fs = require('fs'), os = require('os'), path = require('path');
const { log, showPopup } = require('./log');

const NAME = /^(.*?)\s*(20\d{2}) - Rekap SPT PPh 21 Setahun \(A1\)/i;
const TEMP_NIK = '9990000000999000';
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
        if (!timer) { timer = setInterval(() => tick().catch(() => {}), 15000); if (timer.unref) timer.unref(); }
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
async function refreshInPlace(file, emit = log) {
    const m = NAME.exec(path.basename(file)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-rekap-'));
    try {
        const { result } = await require('./a1-import').convertA1Workbook(file, tmp, m ? m[1] : '');
        fs.copyFileSync(result.file, file);
        own(file);
        emit('Rekap disusun ulang: ' + file + ' · isian dibawa: ' + (result.carriedInputs || 0) + '.');
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
module.exports = { watch, own, refreshInPlace, missingPeople, locked, _tick: tick, _files: files };
