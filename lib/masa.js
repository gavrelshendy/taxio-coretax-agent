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

/** A bare 4-digit YEAR (e.g. "2025", per explicit user shorthand: typing just the year means
 *  the whole year, "0125-1225") is distinguished from an MMYY token by trying MMYY FIRST - any
 *  real year the user would type starts "20xx", and "20" is never a valid month (1-12), so the
 *  two never collide: "1225" (a real MMYY, December's last 2 digits "25") still parses as MMYY
 *  since "12" IS a valid month, while "2025" falls through to this branch since "20" isn't. */
function isBareYear(seg) {
    return /^\d{4}$/.test(seg) && !isValidMasa(seg);
}
function bareYearToMonths(seg) {
    const yy = seg.slice(2);
    const out = [];
    for (let m = 1; m <= 12; m++) out.push(String(m).padStart(2, '0') + yy);
    return out;
}

/** Expands one segment ("0126", "0126-0526", or a bare year like "2026") into an array of
 *  individual MMYY strings. */
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
    if (isBareYear(seg)) return bareYearToMonths(seg);
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

/** SPT Badan/SPT Orang Pribadi (annual returns, live-confirmed 2026-08-05): one calendar year IS
 *  one tax period, not 12 - Coretax's own TaxPeriodCode for these is "01" (start month) + "12"
 *  (end month) + YYYY, e.g. "01122025" for all of 2025. Deliberately separate from
 *  isBareYear/bareYearToMonths above, which expands a bare year into 12 individual MONTHLY
 *  periods for e-Bupot's unrelated per-month masa filter - annual SPT needs the opposite: the
 *  whole year collapsed into a single period code. */
function isValidYear(yyyy) {
    return /^(19|20)\d{2}$/.test(yyyy);
}
function parseAnnualYearListInput(input) {
    const segs = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
    if (!segs.length) throw new Error('Tahun wajib diisi.');
    const set = new Set();
    for (const seg of segs) {
        const rangeMatch = seg.match(/^(\d{4})\s*-\s*(\d{4})$/);
        if (rangeMatch) {
            let [, a, b] = rangeMatch;
            if (!isValidYear(a) || !isValidYear(b)) throw new Error('Tahun tidak valid: "' + seg + '"');
            let ai = parseInt(a, 10), bi = parseInt(b, 10);
            if (ai > bi) [ai, bi] = [bi, ai];
            for (let y = ai; y <= bi; y++) set.add(String(y));
            continue;
        }
        if (!isValidYear(seg)) throw new Error('Tahun tidak valid: "' + seg + '"');
        set.add(seg);
    }
    return Array.from(set).sort();
}
function annualYearToTaxPeriodCode(year) {
    return '01' + '12' + year;
}
function annualYearToIndoLabel(year) {
    return 'Tahun ' + year;
}

module.exports = {
    masaToIndoLabel, isValidMasa, parseMasaListInput, parseMasaRangeRuns, parseKodeObjekInput,
    isValidYear, parseAnnualYearListInput, annualYearToTaxPeriodCode, annualYearToIndoLabel
};
