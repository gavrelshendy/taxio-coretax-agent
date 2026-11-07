'use strict';
/** ExcelJS kehilangan headerRow tabel saat file dibaca lalu ditulis ulang: tabel jadi headerRowCount="0" tetapi masih
 *  membawa autoFilter, sehingga Excel menampilkan "We found a problem ... Removed Records: AutoFilter". Semua tabel yang
 *  kita tulis (LampiranTable*) memakai baris judul, jadi pulihkan sebelum setiap writeFile pada workbook hasil baca. */
function fixTables(wb) {
    let n = 0;
    for (const ws of wb.worksheets || []) {
        for (const t of Object.values(ws.tables || {})) {
            const m = t.table || t.model;
            if (!m) continue;
            if (m.headerRow !== true) { m.headerRow = true; n++; }
            if (m.totalsRow !== false) m.totalsRow = false;
        }
    }
    return n;
}
module.exports = { fixTables };
