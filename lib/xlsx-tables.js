'use strict';
/** ExcelJS kehilangan headerRow tabel saat file dibaca lalu ditulis ulang: tabel jadi headerRowCount="0" tetapi masih
 *  membawa autoFilter, sehingga Excel menampilkan "We found a problem ... Removed Records: AutoFilter". Semua tabel yang
 *  kita tulis (LampiranTable*) memakai baris judul, jadi pulihkan sebelum setiap writeFile pada workbook hasil baca.
 *  Sekalian: kolom tambahan rekap di kanan tabel lampiran (NIK setelah pembetulan, Catatan Pembetulan) dimasukkan ke
 *  tabel supaya ikut punya tombol filter. */
const EXTRA = new Set(['NIK setelah pembetulan', 'Catatan Pembetulan']);
const colNo = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const colLetter = (n) => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const cellText = (v) => String(v && typeof v === 'object' ? (v.result ?? v.text ?? '') : v ?? '').trim();
function fixTables(wb) {
    let n = 0;
    for (const ws of wb.worksheets || []) {
        for (const t of Object.values(ws.tables || {})) {
            const m = t.table || t.model;
            if (!m) continue;
            if (m.headerRow !== true) { m.headerRow = true; n++; }
            if (m.totalsRow !== false) m.totalsRow = false;
            extend(ws, m);
        }
    }
    return n;
}
/** Tabel A7:O100 + judul "NIK setelah pembetulan" di P7 -> A7:P100 dengan kolom baru (filter ikut). */
function extend(ws, m) {
    const ref = m.tableRef || m.ref; if (!ref || !Array.isArray(m.columns)) return;
    const r = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref); if (!r) return;
    const head = +r[2], last = colNo(r[3]), names = new Set(m.columns.map((c) => c.name));
    let end = last;
    for (let c = last + 1; ; c++) {
        const name = cellText(ws.getCell(head, c).value);
        if (!EXTRA.has(name) || names.has(name)) break;
        m.columns.push({ name, filterButton: true, totalsRowFunction: 'none' }); names.add(name); end = c;
    }
    if (end === last) return;
    const nref = r[1] + head + ':' + colLetter(end) + r[4];
    m.tableRef = nref; if ('ref' in m) m.ref = nref;
    m.autoFilterRef = nref;
}
module.exports = { fixTables };
