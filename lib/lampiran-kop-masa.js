/* Kop and theme of the SPT Masa lampiran PDFs (PPh 21/26, PPh Unifikasi, PPN), drawn after the
 * Induk that Coretax itself prints for these returns, so a lampiran bound behind its Induk reads
 * as the same document: the Kemenkeu/DJP block on the left, the return's title centred on the
 * page, the yellow badge on the right, and a grey band of white value boxes beneath (NPWP, name,
 * masa, status). Colours and fonts were read off Coretax's Induk PDFs: grey #D3D3D3, yellow
 * #FFD700, section blue #004080, Arial for the kop and Arial Narrow for the tables.
 * The annual SPT (Badan/OP) keeps its PER-11 form kop and never comes here. */
const fs = require('fs');
const path = require('path');

const logo = fs.readFileSync(path.join(__dirname, '../gui/public/assets/kemenkeu-logo.png')).toString('base64');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The Induk's own title lines for each return.
const TITLES = {
    ICT_WIT: ['SURAT PEMBERITAHUAN (SPT) MASA', 'PAJAK PENGHASILAN (PPh) PASAL 21 DAN/ATAU PASAL 26'],
    ICT_WT: ['SURAT PEMBERITAHUAN MASA', 'PAJAK PENGHASILAN (PPh) UNIFIKASI'],
    VAT_VAT: ['SURAT PEMBERITAHUAN MASA', 'PAJAK PERTAMBAHAN NILAI (SPT MASA PPN)']
};
// The Induk's own band labels (PPN says "NORMAL/PEMBETULAN", Unifikasi "STATUS SPT").
const BAND = {
    ICT_WIT: ['NPWP/NIK', 'NAMA PEMOTONG', 'MASA PAJAK', 'STATUS'],
    ICT_WT: ['NPWP/NIK', 'NAMA PEMOTONG/PEMUNGUT', 'MASA PAJAK', 'STATUS SPT'],
    VAT_VAT: ['NPWP', 'NAMA PKP', 'MASA PAJAK', 'NORMAL/PEMBETULAN']
};

/** Runs in the print page after the tables are final. Every lampiran opens the same way under the
 *  kop: its list title ("DAFTAR PAJAK KELUARAN ...") as a blue section bar, the separator Coretax
 *  already uses for "TABEL I. BPPU". PPN and PPh 21 print that title as a plain heading, so it is
 *  turned into the bar; what the kop already says is dropped - the bare code bar ("DAFTAR-I",
 *  "LIST-IA" = the badge) and Unifikasi's Masa Pajak / NPWP box (= the band). */
function prepareBody({ fontFace }) {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const outside = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,.p-panel-header,.p-accordion-header-link')].filter((n) => !n.closest('table'));
    const code = (t) => /^(?:DAFTAR|LIST|LAMPIRAN)-[A-Z0-9-]+$/i.test(t);
    let titled = false;
    for (const n of outside) {
        const t = clean(n.textContent);
        if (!t) continue;
        if (code(t)) { n.remove(); continue; }
        if (!titled && /^(?:DAFTAR|RINGKASAN)\s/i.test(t)) {
            titled = true;
            if (/^H\d$/.test(n.tagName)) { const bar = document.createElement('div'); bar.className = 'p-panel-header masa-title'; bar.textContent = t; n.replaceWith(bar); }
            else n.classList.add('masa-title');
        }
    }
    document.querySelectorAll('.financial-row').forEach((r) => { if (/^(?:Masa Pajak|NPWP)$/i.test(clean(r.firstElementChild && r.firstElementChild.textContent))) r.remove(); });
    // A panel left with nothing in it (its header gone and no table) would print as a blank gap.
    document.querySelectorAll('.p-panel').forEach((p) => { if (!clean(p.textContent) && !p.querySelector('table')) p.remove(); });
    const style = document.createElement('style');
    style.textContent = fontFace
        + "body,body *{font-family:'Arial Narrow','Roboto Condensed',Arial,sans-serif!important}"
        // One blue bar per lampiran (its title); sub-sections (TABEL I. BPPU, BPA1, BP21) stay grey.
        + '.p-panel-header,.p-accordion-header-link{background:#EBEBEB!important;color:#000!important}.p-panel-header *,.p-accordion-header-link *{color:#000!important}'
        + '.masa-title{background:#004080!important}.masa-title,.masa-title *{color:#fff!important}'
        + 'th{background:#D3D3D3!important;color:#000!important;font-weight:700!important}'
        + 'table .control-total td,table tfoot td{background:#D3D3D3!important;font-weight:700!important}'
        + '.p-panel-header,.p-accordion-header-link{font-weight:700!important;font-size:9.5pt!important;padding:1.6mm 2.5mm!important;margin:0 0 2.5mm!important}'
        + 'table .control-end .omitted td,table .omitted td{background:#F2F2F2!important;color:#333!important;font-style:italic!important}'
        + 'body>*:first-child,.p-tabview-panel>*:first-child{margin-top:0!important}';
    document.head.append(style);
}

/** The list's own title ("DAFTAR PAJAK KELUARAN ..."), read without changing the page - the
 *  Excel copy carries it as the bar under its kop. */
function listTitle() {
    for (const n of document.querySelectorAll('h1,h2,h3,h4,h5,h6,.p-panel-header,.p-accordion-header-link')) {
        if (n.closest('table')) continue;
        const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(?:DAFTAR|RINGKASAN)\s/i.test(t)) return t;
    }
    return '';
}

/** Chromium prints header templates as a separate document: every element carries its own font
 *  size and family, and fills need print-color-adjust or they are dropped. */
function header({ meta, label, mode }) {
    const code = meta.taxTypeCode;
    const ink = '-webkit-print-color-adjust:exact;print-color-adjust:exact';
    const fam = 'font-family:Arial,Helvetica,sans-serif';
    const lines = TITLES[code] || [String(meta.title || '')];
    const band = BAND[code] || ['NPWP', 'NAMA', 'MASA PAJAK', 'STATUS'];
    const badge = mode === 'confidential' ? 'RINGKASAN' : /^(?:DAFTAR|LAMPIRAN)-/i.test(label) ? label : 'LAMPIRAN ' + label;
    const values = [meta.entityNpwp || '-', meta.entity || '-', String(meta.period || '').replace(/^Masa Pajak\s*/i, '') || '-', meta.status || '-'];
    // The kop only says whose return it is; the list's own title opens the body as its first bar.
    // The emblem (Coretax's own, lifted with its transparency from an Induk PDF) and the three-line
    // block keep the Induk's proportions (13.7 mm, 8.5 pt).
    return `<div style="width:100%;margin:0 10mm;padding-top:4mm;${fam};color:#000">`
        + `<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:4mm">`
        + `<div style="display:flex;align-items:center;gap:3mm">`
        + `<img src="data:image/png;base64,${logo}" style="width:13.7mm;height:13mm;object-fit:contain">`
        + `<div style="font-size:8.5pt;line-height:1.3;${fam}">KEMENTERIAN KEUANGAN<br>REPUBLIK INDONESIA<br><b style="font-size:8.5pt;${fam}">DIREKTORAT JENDERAL PAJAK</b></div></div>`
        + `<div style="text-align:center;${fam}">`
        + `<div style="font-size:12pt;font-weight:bold;${fam}">${esc(lines[0])}</div>`
        + (lines[1] ? `<div style="font-size:10pt;font-weight:bold;margin-top:.6mm;${fam}">${esc(lines[1])}</div>` : '')
        + `</div>`
        + `<div style="justify-self:end;width:50mm;min-height:14mm;background:#FFD700;display:flex;flex-direction:column;align-items:center;justify-content:center;${ink}">`
        + `<div style="font-size:13pt;font-weight:bold;${fam}">${esc(badge)}</div>`
        + `<div style="font-size:8pt;font-weight:bold;margin-top:.5mm;${fam}">Halaman <span class="pageNumber" style="font-size:8pt"></span></div></div>`
        + `</div>`
        + `<div style="margin-top:2.5mm;background:#D3D3D3;padding:1.2mm 2mm 1.6mm;display:grid;grid-template-columns:1.1fr 2.2fr 1fr 1fr;column-gap:2.5mm;${ink}">`
        + band.map((b, i) => `<div style="text-align:center;${fam}"><div style="font-size:6.8pt;font-weight:bold;margin-bottom:.6mm;${fam}">${esc(b)}</div>`
            + `<div style="background:#fff;font-size:8pt;padding:.7mm 1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${ink};${fam}">${esc(values[i])}</div></div>`).join('')
        + `</div></div>`;
}

module.exports = { prepareBody, header, listTitle, TITLES };
