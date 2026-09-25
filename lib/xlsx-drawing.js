/* Reads the floating shapes of an .xlsx, which exceljs does not expose.
 *
 * The PER-11 forms put part of their wording in text boxes rather than cells - the gold
 * "LAMPIRAN 13C" badge on every sheet, the numbered markers on the calculation forms - so a spec
 * built only from cells is missing exactly the labels the printed kop needs. The shapes live in
 * xl/drawings/*.xml inside the workbook's zip, reachable with nothing but zlib.
 */
const fs = require('fs');
const zlib = require('zlib');

function openZip(file) {
    const buf = fs.readFileSync(file);
    let p = buf.length - 22;
    while (p > 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
    let cd = buf.readUInt32LE(p + 16);
    const count = buf.readUInt16LE(p + 10);
    const offsets = new Map();
    for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(cd + 28), extraLen = buf.readUInt16LE(cd + 30), cmtLen = buf.readUInt16LE(cd + 32);
        offsets.set(buf.toString('utf8', cd + 46, cd + 46 + nameLen), buf.readUInt32LE(cd + 42));
        cd += 46 + nameLen + extraLen + cmtLen;
    }
    const sorted = [...offsets.values()].sort((a, b) => a - b);
    return (name) => {
        const off = offsets.get(name);
        if (off === undefined) return null;
        const method = buf.readUInt16LE(off + 8);
        const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
        let size = buf.readUInt32LE(off + 18);
        if (!size) size = (sorted.find((v) => v > off) ?? buf.length) - start;
        const raw = buf.subarray(start, start + size);
        return (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    };
}

/** Returns { [sheetName]: [{ text, fill, color, font, size, bold, from, to }] }. */
function shapesBySheet(file) {
    const read = openZip(file);
    const workbook = read('xl/workbook.xml') || '';
    const rels = read('xl/_rels/workbook.xml.rels') || '';
    const out = {};
    for (const m of workbook.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
        const target = (rels.match(new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"')) || [])[1];
        if (!target) continue;
        const sheetPath = 'xl/' + target.replace(/^\/?xl\//, '');
        const sheetXml = read(sheetPath) || '';
        const relId = (sheetXml.match(/<drawing[^>]*r:id="([^"]+)"/) || [])[1];
        out[m[1]] = [];
        if (!relId) continue;
        const sheetRels = read(sheetPath.replace('worksheets/', 'worksheets/_rels/') + '.rels') || '';
        const drawTarget = (sheetRels.match(new RegExp('Id="' + relId + '"[^>]*Target="([^"]+)"')) || [])[1];
        if (!drawTarget) continue;
        const xml = read('xl/' + drawTarget.replace(/^\.\.\//, '')) || '';
        out[m[1]] = [...xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)[\s\S]*?<\/xdr:\1>/g)]
            .map((x) => x[0])
            .map((s) => {
                const from = s.match(/<xdr:from>\s*<xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
                const to = s.match(/<xdr:to>\s*<xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
                const fills = [...s.matchAll(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/g)].map((f) => '#' + f[1].toUpperCase());
                const rPr = (s.match(/<a:rPr[^>]*\/?>/) || [''])[0];
                return {
                    text: [...s.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''),
                    fill: fills[0] || '', color: fills[1] || '',
                    font: (s.match(/typeface="([^"]+)"/) || [])[1] || '',
                    size: Number((rPr.match(/sz="(\d+)"/) || [])[1] || 0) / 100 || 0,
                    bold: /b="1"/.test(rPr),
                    from: from ? { col: +from[1], row: +from[2] } : null,
                    to: to ? { col: +to[1], row: +to[2] } : null,
                };
            })
            .filter((s) => s.text || s.fill);
    }
    return out;
}

module.exports = { shapesBySheet, openZip };
