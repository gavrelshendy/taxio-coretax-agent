const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const esc = (value) => clean(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const TITLES = {
    Induk: 'SPT Tahunan PPh Wajib Pajak Badan',
    'L1-D': 'Rekonsiliasi Laporan Keuangan - Jasa',
    L2: 'Daftar Kepemilikan dan Transaksi Afiliasi',
    L3: 'Kredit Pajak Dalam Negeri dan Luar Negeri',
    L4: 'Penghasilan Final dan Bukan Objek Pajak',
    L6: 'Angsuran Pajak Penghasilan Tahun Berjalan',
    L8: 'Fasilitas Pengurangan Tarif PPh Pasal 31E',
    L9: 'Daftar Penyusutan dan Amortisasi Fiskal',
    'L11-B': 'Penghitungan Biaya Pinjaman',
};
const TABLE_TITLES = {
    'L1-D': ['Laporan Laba Rugi', 'Posisi Keuangan - Aset', 'Posisi Keuangan - Liabilitas dan Ekuitas'],
    L2: ['Pemegang Saham, Pengurus, dan Komisaris', 'Penyertaan Modal, Utang, dan Piutang Afiliasi'],
    L3: ['Penghasilan dan Kredit Pajak Luar Negeri', 'Pengembalian PPh Luar Negeri Tahun Sebelumnya', 'PPh Dipotong/Dipungut Pihak Lain'],
    L4: ['Penghasilan yang Dikenakan PPh Final', 'Penghasilan yang Tidak Termasuk Objek Pajak'],
    L8: ['Penghitungan Fasilitas Pengurangan Tarif PPh'],
    L9: ['Harta Berwujud - Kelompok 1', 'Harta Berwujud - Kelompok 2', 'Harta Berwujud - Kelompok 3', 'Harta Berwujud - Kelompok 4', 'Harta Berwujud - Kelompok Lainnya', 'Bangunan Permanen', 'Bangunan Tidak Permanen', 'Harta Tidak Berwujud - Kelompok 1', 'Harta Tidak Berwujud - Kelompok 2', 'Harta Tidak Berwujud - Kelompok 3', 'Harta Tidak Berwujud - Kelompok 4', 'Harta Tidak Berwujud - Kelompok Lainnya'],
    'L11-B': ['Rata-Rata Saldo Utang', 'Rata-Rata Saldo Modal', 'Biaya Pinjaman yang Dapat Diperhitungkan'],
};

function stripHtml(value) {
    return clean(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
}

function metadataFromFixture(fixture) {
    const html = fixture.tabs.map((tab) => tab.rootHtml || '').join('\n');
    const fields = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/gi)].map((match) => {
        const tag = match[0];
        return {
            name: clean((tag.match(/formcontrolname="([^"]*)"/i) || [])[1]),
            value: clean((tag.match(/value="([^"]*)"/i) || [])[1]),
        };
    });
    const values = fields.map((field) => field.value).filter(Boolean);
    const allText = stripHtml(html);
    const npwp = (values.find((v) => /^\d{15,16}$/.test(v)) || (allText.match(/\b\d{15,16}\b/) || [])[0] || '-');
    const year = (values.find((v) => /^20\d{2}$/.test(v)) || (allText.match(/\b20\d{2}\b/) || [])[0] || '-');
    const name = fields.find((field) => /^Name$/i.test(field.name) && field.value)?.value || (fixture.entityName || 'WAJIB PAJAK');
    return { name, npwp, year, form: 'SPT Tahunan PPh Badan' };
}

function flattenHeader(rows) {
    if (!rows || !rows.length) return [];
    const grid = [];
    rows.forEach((row, ri) => {
        grid[ri] = grid[ri] || [];
        let col = 0;
        row.forEach((cell) => {
            while (grid[ri][col]) col++;
            const cs = cell.colSpan || 1, rs = cell.rowSpan || 1;
            for (let r = ri; r < ri + rs; r++) {
                grid[r] = grid[r] || [];
                for (let c = col; c < col + cs; c++) grid[r][c] = clean(cell.text);
            }
            col += cs;
        });
    });
    const count = Math.max(...grid.map((row) => row.length));
    return Array.from({ length: count }, (_, col) => clean(grid.map((row) => row[col]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' - ')));
}

function isUiRow(row) {
    const text = clean(row.map((cell) => cell.text).join(' '));
    return !text || /^(?:Silakan Pilih|Pilih Jenis Pajak|Pilih Kelompok|Tidak ada data|No records?)/i.test(text);
}

function isTotalRow(row) {
    return /^(?:JUMLAH|TOTAL)\b/i.test(clean(row.map((cell) => cell.text).join(' '))) || row.some((cell) => /^(?:JUMLAH|TOTAL)\b/i.test(clean(cell.text)));
}

function tableModel(table, tableNo, tabLabel) {
    const first = table.pages && table.pages[0];
    if (!first) return null;
    const headers = flattenHeader(first.headers);
    const rows = [];
    const totals = [];
    const seen = new Set();
    for (const [pageIndex, page] of table.pages.entries()) {
        for (const row of page.body || []) {
            if (isUiRow(row)) continue;
            const normalized = row.map((cell) => clean(cell.text));
            const signature = JSON.stringify(normalized);
            if (seen.has(signature) && !/^\d+[.)]?\s/.test(normalized[0] || '')) continue;
            seen.add(signature);
            (isTotalRow(row) ? totals : rows).push(normalized);
        }
        if (pageIndex === table.pages.length - 1) {
            for (const row of page.footer || []) totals.push(row.map((cell) => clean(cell.text)));
        }
    }
    const title = clean(first.title) || TABLE_TITLES[tabLabel]?.[tableNo] || `Bagian ${tableNo + 1}`;
    if (!rows.length && totals.every((row) => row.every((value) => !clean(value) || /^(?:JUMLAH|TOTAL|0|Rp\.?)$/i.test(clean(value))))) return null;
    return { title, headers, rows, totals };
}

function kindFor(header, values) {
    const h = clean(header).toUpperCase();
    const populated = values.filter(Boolean);
    const numeric = populated.filter((v) => /^(?:Rp\.?\s*)?[-(]?[\d.,]+[)]?$/.test(v)).length;
    if (/^NO\.?$/.test(h)) return { kind: 'no', weight: 4 };
    if (/NPWP|NIK|IDENTITAS|NOMOR BUKTI|BUKTI.*NOMOR/.test(h)) return { kind: 'id', weight: 17 };
    if (/TANGGAL|BULAN|TAHUN/.test(h)) return { kind: 'date', weight: 11 };
    if (/NILAI|JUMLAH|DPP|PAJAK|PPh|BIAYA|AMOUNT|RUPIAH|SALDO|MODAL|DIVIDEN|UTANG|PIUTANG|%/.test(h) || (populated.length && numeric / populated.length > .7)) return { kind: 'numeric', weight: 12 };
    if (/KETERANGAN|DESKRIPSI|ALAMAT|JENIS PENGHASILAN|OBJEK PAJAK|KELOMPOK/.test(h)) return { kind: 'long', weight: 24 };
    if (/NAMA/.test(h)) return { kind: 'name', weight: 18 };
    if (/KODE/.test(h)) return { kind: 'code', weight: 9 };
    return { kind: 'text', weight: 13 };
}

function renderTable(model) {
    if (!model || (!model.rows.length && !model.totals.length)) return '';
    const count = Math.max(model.headers.length, ...model.rows.map((r) => r.length), ...model.totals.map((r) => r.length));
    const headers = Array.from({ length: count }, (_, index) => model.headers[index] || `Kolom ${index + 1}`);
    const profiles = headers.map((header, index) => kindFor(header, model.rows.map((row) => row[index] || '')));
    const totalWeight = profiles.reduce((sum, p) => sum + p.weight, 0);
    const rowHtml = (row, cls = '') => `<tr class="${cls}">${headers.map((_, index) => `<td class="${profiles[index].kind}">${esc(row[index] || '')}</td>`).join('')}</tr>`;
    return `<section class="table-section"><h2>${esc(model.title)}</h2><table><colgroup>${profiles.map((p) => `<col style="width:${(p.weight / totalWeight * 100).toFixed(2)}%">`).join('')}</colgroup><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${model.rows.map((row) => rowHtml(row)).join('')}${model.totals.map((row) => rowHtml(row, 'total')).join('')}</tbody></table></section>`;
}

function renderSummary(tab) {
    const text = stripHtml(tab.rootHtml);
    const candidates = [...text.matchAll(/(?:TAHUN PAJAK|NPWP|NOMOR IDENTITAS WP|PENGHASILAN NETO FISKAL|PPh TERUTANG|ANGSURAN PPh PASAL 25)[^\d]{0,80}([\d.,]{1,24})/gi)]
        .map((m) => [clean(m[0].slice(0, m[0].lastIndexOf(m[1]))), clean(m[1])]);
    const unique = candidates.filter((item, index, all) => all.findIndex((x) => x[0] === item[0] && x[1] === item[1]) === index).slice(0, 24);
    if (!unique.length) return '<div class="empty">Tidak terdapat tabel rincian pada lampiran ini. Data identitas dan periode tetap dicantumkan pada kop.</div>';
    return `<section class="summary"><h2>Ringkasan Nilai SPT</h2>${unique.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</section>`;
}

function htmlForTab(fixture, tab) {
    const meta = metadataFromFixture(fixture);
    const models = (tab.tables || []).map((table, index) => tableModel(table, index, tab.label)).filter(Boolean);
    const content = models.map(renderTable).filter(Boolean).join('') || renderSummary(tab);
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      @page{size:A3 landscape;margin:24mm 12mm 15mm}*{box-sizing:border-box}body{margin:0;color:#4b5563;font:9pt Arial,sans-serif}.table-section{break-after:page}.table-section:last-child{break-after:auto}h1{margin:0 0 5mm;color:#172554;font-size:15pt}h2{margin:0 0 3mm;color:#172554;font-size:10.5pt;text-transform:uppercase}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8.2pt}thead{display:table-header-group}th{background:#eaf0f4;color:#172554;text-align:center;font-size:7.5pt;line-height:1.15}th,td{border:1px solid #cbd5e1;padding:1.4mm 1.2mm;vertical-align:top;overflow-wrap:anywhere}td.numeric{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td.no,td.date{text-align:center;white-space:nowrap}td.id{white-space:nowrap;font-variant-numeric:tabular-nums}.total td{font-weight:700;background:#f1f5f9}.empty{border:1px solid #cbd5e1;padding:8mm;background:#f8fafc}.summary{max-width:80%;margin:auto}.summary>div{display:grid;grid-template-columns:2fr 1fr;border-bottom:1px solid #e2e8f0;padding:2mm}.summary strong{text-align:right}
    </style></head><body><main>${content}</main></body></html>`;
}

function printTemplates(fixture, tab) {
    const meta = metadataFromFixture(fixture);
    const header = `<div style="font-family:Arial;width:100%;margin:0 12mm 2mm;padding:0 0 2.5mm;border-bottom:2px solid #172554;color:#172554;display:grid;grid-template-columns:1fr 2fr 1fr;align-items:end"><div style="font-size:13px;font-weight:700">DIREKTORAT JENDERAL PAJAK<div style="font-size:8px;font-weight:600;color:#475569">CORETAX</div></div><div style="text-align:center;font-size:10px;font-weight:700">${esc(meta.form)}<div style="font-size:8px;margin-top:2px">LAMPIRAN ${esc(tab.label)} - ${esc(TITLES[tab.label] || tab.label)}</div></div><div style="text-align:right;font-size:8px"><b>${esc(meta.name)}</b><br>NPWP ${esc(meta.npwp)} · Tahun ${esc(meta.year)}</div></div>`;
    const footer = `<div style="font-family:Arial;width:100%;margin:2mm 12mm 0;padding-top:2mm;border-top:1px solid #9fb0c0;color:#607080;font-size:7px;display:flex;justify-content:space-between"><span>Disusun dari data SPT Coretax - ${esc(tab.label)}</span><span>Halaman <span class="pageNumber"></span> dari <span class="totalPages"></span></span></div>`;
    return { header, footer };
}

async function merge(buffers) {
    const out = await PDFDocument.create();
    for (const buffer of buffers) {
        const src = await PDFDocument.load(buffer);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((page) => out.addPage(page));
    }
    return Buffer.from(await out.save());
}

async function renderFixture(fixture, browser, outputDir, options = {}) {
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = [], buffers = [];
    const meta = metadataFromFixture(fixture);
    for (const tab of fixture.tabs) {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        await page.setContent(htmlForTab(fixture, tab), { waitUntil: 'load' });
        const templates = printTemplates(fixture, tab);
        const buffer = await page.pdf({ format: 'A3', landscape: true, printBackground: true, preferCSSPageSize: true,
            displayHeaderFooter: true, headerTemplate: templates.header, footerTemplate: templates.footer });
        await page.close();
        const suffix = options.suffix || 'Lengkap';
        const name = `${meta.name} - SPT Tahunan PPh Badan LAMPIRAN ${tab.label} (${suffix}) ${meta.year}.pdf`;
        const output = path.join(outputDir, name);
        fs.writeFileSync(output, buffer);
        outputs.push(output); buffers.push(buffer);
    }
    const combined = path.join(outputDir, `${meta.name} - SPT Tahunan PPh Badan LAMPIRAN GABUNGAN (${options.suffix || 'Lengkap'}) ${meta.year}.pdf`);
    fs.writeFileSync(combined, await merge(buffers));
    outputs.push(combined);
    return outputs;
}

module.exports = { renderFixture, htmlForTab, metadataFromFixture, tableModel, kindFor };
