/* MMYY period parsing/formatting shared by the e-Bupot automation.
   Input format from the GUI (per the user's own spec): a semicolon-separated list
   ("0126;0226"), a single dash-range ("0126-0526"), or a mix of both
   ("0126;0326-0526") - each list segment can itself be a range. */

const MONTH_NAMES_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function isValidMasa(mmYY) {
    if (!/^\d{4}$/.test(mmYY)) return false;
    const m = parseInt(mmYY.slice(0, 2), 10);
    return m >= 1 && m <= 12;
}

function masaToIndoLabel(mmYY) {
    if (!isValidMasa(mmYY)) return '';
    const m = parseInt(mmYY.slice(0, 2), 10);
    const y = '20' + mmYY.slice(2);
    return MONTH_NAMES_ID[m - 1] + ' ' + y;
}

function masaToIndex(mmYY) {
    const m = parseInt(mmYY.slice(0, 2), 10);
    const y = parseInt(mmYY.slice(2), 10);
    return y * 12 + (m - 1);
}
function indexToMasa(idx) {
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    return String(m).padStart(2, '0') + String(y).padStart(2, '0');
}

/** Expands one segment ("0126" or "0126-0526") into an array of individual MMYY strings. */
function expandSegment(seg) {
    seg = seg.trim();
    if (!seg) return [];
    const rangeMatch = seg.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (rangeMatch) {
        const [, startStr, endStr] = rangeMatch;
        if (!isValidMasa(startStr) || !isValidMasa(endStr)) throw new Error('Masa tidak valid: "' + seg + '"');
        let a = masaToIndex(startStr), b = masaToIndex(endStr);
        if (a > b) [a, b] = [b, a];
        const out = [];
        for (let i = a; i <= b; i++) out.push(indexToMasa(i));
        return out;
    }
    if (!isValidMasa(seg)) throw new Error('Masa tidak valid: "' + seg + '"');
    return [seg];
}

/** For BPPU/BP21 (single "Masa Pajak" filter, applied one month at a time): flattens the
 *  whole input into a deduped, chronologically sorted list of individual MMYY values. */
function parseMasaListInput(input) {
    const segs = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
    if (!segs.length) throw new Error('Masa wajib diisi.');
    const set = new Set();
    for (const seg of segs) for (const mmYY of expandSegment(seg)) set.add(mmYY);
    return Array.from(set).sort((a, b) => masaToIndex(a) - masaToIndex(b));
}

/** For BPA1 (a "Masa Awal/Akhir Periode Penghasilan" RANGE filter, applied as one pair per
 *  run, not per month): each ";"-separated segment becomes one {start, end} run - a bare
 *  month means start=end, a "a-b" segment is used as-is. */
function parseMasaRangeRuns(input) {
    const segs = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
    if (!segs.length) throw new Error('Masa wajib diisi.');
    return segs.map(seg => {
        const rangeMatch = seg.match(/^(\d{4})\s*-\s*(\d{4})$/);
        if (rangeMatch) {
            let [, a, b] = rangeMatch;
            if (!isValidMasa(a) || !isValidMasa(b)) throw new Error('Masa tidak valid: "' + seg + '"');
            if (masaToIndex(a) > masaToIndex(b)) [a, b] = [b, a];
            return { start: a, end: b };
        }
        if (!isValidMasa(seg)) throw new Error('Masa tidak valid: "' + seg + '"');
        return { start: seg, end: seg };
    });
}

function parseKodeObjekInput(input) {
    return String(input || '').split(';').map(s => s.trim()).filter(Boolean);
}

module.exports = { masaToIndoLabel, isValidMasa, parseMasaListInput, parseMasaRangeRuns, parseKodeObjekInput };
