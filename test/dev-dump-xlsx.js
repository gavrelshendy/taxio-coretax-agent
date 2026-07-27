/* TEMPORARY dev tool - not part of the app. Raw dump of an xlsx's sheets/headers/rows via
   exceljs directly (bypassing lib/excel.js's header-as-plain-string assumption, which doesn't
   handle rich-text/formula header cells) so Claude can see the exact column layout of a
   reference file. Usage: node dev-dump-xlsx.js "<path>" */
const ExcelJS = require('exceljs');

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node dev-dump-xlsx.js <path>'); process.exit(1); }

function cellText(v) {
    if (v && typeof v === 'object') {
        if ('text' in v) return v.text;
        if ('richText' in v) return v.richText.map((r) => r.text).join('');
        if ('result' in v) return v.result;
        return JSON.stringify(v);
    }
    return v;
}

(async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    wb.worksheets.forEach((sheet, idx) => {
        console.log('=== Sheet ' + idx + ': "' + sheet.name + '" (' + sheet.rowCount + ' rows, ' + sheet.columnCount + ' cols) ===');
        const maxRows = Math.min(sheet.rowCount, 6);
        for (let r = 1; r <= maxRows; r++) {
            const row = sheet.getRow(r);
            const vals = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => { vals.push(col + ':' + JSON.stringify(cellText(cell.value))); });
            console.log('row ' + r + ': ' + vals.join(' | '));
        }
    });
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
