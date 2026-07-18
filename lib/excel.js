/* Coretax Agent - Excel helpers for the e-Bupot cross-check/summary feature.
   Uses exceljs (pure JS, actively maintained) rather than the more commonly-seen `xlsx`
   package, which has unpatched high-severity advisories (prototype pollution / ReDoS) on the
   npm-published line - not worth the risk even though we only ever read files we generated
   ourselves via Coretax's own export button. */
const ExcelJS = require('exceljs');
const { log } = require('./log');

/** Reads the first worksheet of an .xlsx file as an array of plain objects, keyed by the
 *  first row's header text (trimmed). Coretax's own exported column names are used as-is -
 *  callers match against them by substring the same way extractRowFields() matches table
 *  headers, so exact casing/wording differences are tolerated. */
async function readWorkbookRows(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheet = wb.worksheets[0];
    if (!sheet) return [];
    const headerRow = sheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => { headers[colNumber] = String(cell.value ?? '').trim(); });
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {};
        let hasValue = false;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const key = headers[colNumber];
            if (!key) return;
            const v = cell.value;
            obj[key] = (v && typeof v === 'object' && 'text' in v) ? v.text : v; // hyperlink/rich-text cells
            if (obj[key] !== null && obj[key] !== undefined && obj[key] !== '') hasValue = true;
        });
        if (hasValue) rows.push(obj);
    });
    return rows;
}

/** Writes `rows` (array of plain objects) to a fresh .xlsx at `outPath`, with `columns` (in
 *  order) as the header row. Bold header, auto width, tolerant of missing keys per row. */
async function writeCombinedWorkbook(rows, columns, outPath) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Ringkasan');
    sheet.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(14, c.length + 2) }));
    sheet.getRow(1).font = { bold: true };
    rows.forEach((r) => sheet.addRow(r));
    const fs = require('fs');
    fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
    await wb.xlsx.writeFile(outPath);
    log('Ringkasan Excel tersimpan di: ' + outPath);
}

module.exports = { readWorkbookRows, writeCombinedWorkbook };
