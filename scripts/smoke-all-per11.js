/* Structural smoke test for the "formal" PER-11 renderer across EVERY lampiran sheet in both
 * specs (not just the ones already hand-verified with live data) - synthesizes a Coretax-shaped
 * tab HTML straight from each sheet's OWN spec columns (so no per-sheet data to hand-write), runs
 * it through the real renderTabs({layoutStyle:'formal'}) pipeline, and reports which tabs render
 * cleanly vs throw (column overflow, missing spec, crash). This does NOT verify visual fidelity
 * against the real Excel (that needs eyeballing or live data) - it only proves the pipeline
 * doesn't fall over on that sheet's particular shape (side-by-side neraca, multi-table, fields-
 * only calc sheet, duplicate column labels, etc).
 *
 *   node scripts/smoke-all-per11.js [op|badan|all]
 */
const fs = require('fs');
const path = require('path');
const { renderTabs } = require('../lib/lampiran-export');
const per11Op = require('../lib/lampiran-op-per11.json');
const per11Badan = require('../lib/lampiran-badan-per11.json');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Deliberately mixes zero/blank amounts in with real-looking ones (not a "clean" all-populated
// example) - the renderer must handle that mix the same way live Coretax data does.
const sampleValues = ['1.250.000', '0', '', '3.400.500', '87.650.250', '0', '925.000', '12.000.000.000', '0', '450.750'];
let seq = 0;
const nextValue = (moneyish) => {
    if (!moneyish) return 'Contoh ' + (++seq);
    return sampleValues[seq++ % sampleValues.length];
};

// NOTE: real Coretax tabs wrap each table in a `[data-op-table="N"]` element paired with a
// separately-captured `tab.tables[N]` paginated-body payload that lib/lampiran-snapshot-layout.js's
// `prepare()` re-injects (`document.querySelectorAll('[data-op-table]')...if(!t)throw Error('Missing
// table')`). lib/lampiran-layout-badan.js's L1-B/L11-A special cases key off that same attribute.
// Faking the attribute without also faking a matching paired `tables` payload just trades one
// crash for a guaranteed one on every tab, so this fixture leaves it out - L1-B and L11-A are the
// two labels this smoke test can't cover; they need a real/paired capture, not synthetic HTML.
let tableIndex = 0;
function tableHtml(title, headers, rows) {
    const idx = tableIndex++;
    return '<div class="p-panel"><div class="p-panel-header">' + esc(title) + '</div><div class="p-panel-content">'
        + '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
        + '<tbody>' + rows.map((r) => '<tr>' + r.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></div>';
}

// Mirrors how Coretax really presents a side-by-side neraca: TWO separate tables back to back
// (confirmed against lib/lampiran-layout-badan.js's pre-existing L1-B handling and this session's
// live Badan L1-D capture), not one wide table.
function neracaHtml(title) {
    const asetHeaders = ['KODE AKUN', 'NAMA AKUN', 'NILAI'];
    const liabHeaders = ['KODE AKUN', 'NAMA AKUN', 'NILAI'];
    const asetRows = [['1101', 'Kas dan Setara Kas', '450.000.000'], ['1102', 'Piutang Usaha', '0'], ['', 'Jumlah Aset', '450.000.000']];
    const liabRows = [['2102', 'Utang Usaha', '0'], ['3101', 'Modal Saham', '2.000.000.000'], ['', 'Jumlah Ekuitas', '2.000.000.000'], ['', 'Jumlah Liabilitas dan Ekuitas', '2.000.000.000']];
    return tableHtml(title, asetHeaders, asetRows) + tableHtml(title, liabHeaders, liabRows);
}

// Copied from lib/lampiran-finalize.js's own moneyCols detection so synthetic data lands in the
// same "must be a parseable number" columns finalize.js itself will demand for a "records" table
// (first header "NO."/"KODE HARTA"/"TANGGAL"/"NPWP"/"NIK"/"NOMOR (BUKTI|IDENTITAS)") - a text
// placeholder there throws "Angka kontrol tidak dapat dibaca", same as it would on bad live data.
const isMoneyHeader = (h) => !(/TARIF|PERSEN|TINGKAT|KODE|NOMOR|NPWP|NIK|TANGGAL|METODE|MATA UANG ASING/i.test(h)) && (/\bRp\b|Rupiah|PENGHASILAN BRUTO|PAJAK PENGHASILAN|DASAR PENGENAAN|\bDPP\b|^PPN$|^PPnBM$|JUMLAH BRUTO|NILAI|SALDO|HARGA|PLAFON|PIUTANG|PPh (?:TERUTANG|YANG|DIPOTONG)|PENGHASILAN NETO|KREDIT PAJAK/i.test(h));

function synthTableFromSpec(t) {
    if (t.sideBySide) return neracaHtml(t.title || 'LAPORAN POSISI KEUANGAN');
    const cols = t.columns || [];
    if (!cols.length) return '';
    const headers = cols.map((c) => c.label || c.num);
    const numbered = /^NO\.?$/i.test(headers[0] || '');
    const records = numbered || /^(KODE HARTA|TANGGAL|NPWP|NIK|NOMOR (?:BUKTI|IDENTITAS))/i.test(headers[0] || '');
    const moneyish = headers.map((h) => isMoneyHeader(h));
    const rows = [1, 2, 3].map((i) => headers.map((h, ci) => {
        if (ci === 0 && numbered) return String(i);
        // A "records" table's control-total check demands every moneyCols cell parse as a number
        // (or be blank/"-") - non-money cells can stay free text either way.
        if (records && moneyish[ci]) return sampleValues.filter((v) => v !== '')[i % 4];
        return nextValue(moneyish[ci]);
    }));
    return tableHtml(t.title || 'Tabel', headers, rows);
}

function synthFieldsHtml(n) {
    // Mirrors Coretax's `.financial-row` numbered-field sheets (OP's own L-4/L-5 pattern) for
    // sheets whose spec has zero "(1)(2)(3)..." tables - a plain field grid, not a data table.
    const rows = [];
    for (let i = 1; i <= n; i++) {
        rows.push('<div class="financial-row"><span>' + i + '. Baris contoh ' + i + '</span><span>' + nextValue(true) + '</span></div>');
    }
    return rows.join('');
}

async function smokeOp() {
    const tabs = ['L-1', 'L-2', 'L-3A-1', 'L-3A-2', 'L-3A-3', 'L-3A-4', 'L-3B', 'L-3C', 'L-3D', 'L-4', 'L-5'];
    const meta = { entity: 'CONTOH WAJIB PAJAK', entityNpwp: '0123456789012345', period: 'Tahun 2025', title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK ORANG PRIBADI', taxTypeCode: 'ICT_PIT' };
    const results = [];
    for (const label of tabs) {
        seq = 0; tableIndex = 0;
        const key = label.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const sheetNames = Object.keys(per11Op).filter((n) => n.toUpperCase().replace(/[^A-Z0-9]/g, '').startsWith(key));
        const tables = sheetNames.flatMap((n) => per11Op[n].tables);
        let html = tables.map(synthTableFromSpec).join('');
        if (!tables.length) html = synthFieldsHtml(8);
        html = '<div class="p-tabview-panel">' + html + '</div>';
        try {
            const out = await renderTabs([{ label, html, tables: [] }], meta, { mode: 'full', format: 'pdf', dir: path.join(__dirname, '..', '.smoke-output'), stem: 'smoke-op-' + label, outputLayout: 'combined', layoutStyle: 'formal' });
            results.push({ label, ok: true, pages: fs.existsSync(out.combinedPath) });
        } catch (e) {
            results.push({ label, ok: false, error: e.message });
        }
    }
    return results;
}

async function smokeBadan() {
    const tabs = ['L1-A', 'L1-B', 'L1-C', 'L1-D', 'L1-E', 'L1-F', 'L1-G', 'L1-H', 'L1-I', 'L1-J', 'L1-K', 'L1-L', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10-A', 'L10-B', 'L10-C', 'L10-D', 'L11-A', 'L11-B', 'L11-C', 'L12-A', 'L12-B', 'L13-A', 'L13-B', 'L13-C', 'L14'];
    const meta = { entity: 'CONTOH BADAN, PT', entityNpwp: '0123456789012000', period: 'Tahun 2025', title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN', taxTypeCode: 'ICT_RCIT' };
    const results = [];
    for (const label of tabs) {
        seq = 0; tableIndex = 0;
        const key = label.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const sheetNames = Object.keys(per11Badan).filter((n) => n.toUpperCase().replace(/[^A-Z0-9]/g, '') === key);
        const tables = sheetNames.flatMap((n) => per11Badan[n].tables);
        let html = tables.map(synthTableFromSpec).join('');
        if (!tables.length) html = synthFieldsHtml(8);
        html = '<div class="p-tabview-panel">' + html + '</div>';
        try {
            const out = await renderTabs([{ label, html, tables: [] }], meta, { mode: 'full', format: 'pdf', dir: path.join(__dirname, '..', '.smoke-output'), stem: 'smoke-badan-' + label, outputLayout: 'combined', layoutStyle: 'formal' });
            results.push({ label, ok: true, pages: fs.existsSync(out.combinedPath) });
        } catch (e) {
            results.push({ label, ok: false, error: e.message });
        }
    }
    return results;
}

(async () => {
    fs.mkdirSync(path.join(__dirname, '..', '.smoke-output'), { recursive: true });
    const which = process.argv[2] || 'all';
    const all = [];
    if (which === 'op' || which === 'all') all.push(...(await smokeOp()).map((r) => ({ ...r, group: 'OP' })));
    if (which === 'badan' || which === 'all') all.push(...(await smokeBadan()).map((r) => ({ ...r, group: 'Badan' })));
    let fail = 0;
    for (const r of all) {
        if (r.ok) console.log('OK   ', r.group, r.label);
        else { fail++; console.log('FAIL ', r.group, r.label, '->', r.error); }
    }
    console.log('\n' + (all.length - fail) + '/' + all.length + ' tabs rendered without error.');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
