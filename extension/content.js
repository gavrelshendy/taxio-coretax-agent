/* Coretax - Unduh Lampiran SPT (content script).

   Versi extension dari fitur "Unduh Lampiran Lengkap" di aplikasi Coretax Agent
   (automation/lampiran.js + lib/lampiran-widget.js). Bedanya: TIDAK ada Playwright dan TIDAK ada
   koneksi ke Taxio - user login sendiri di browser-nya, lalu klik tombol yang muncul di halaman.

   Seluruh logika DOM (deteksi tab, pindah tab, expand tabel, CSS cetak) di sini berjalan LANGSUNG
   di halaman - di aplikasi hal yang sama harus lewat page.evaluate(). Yang tidak bisa dikerjakan
   content script cuma dua: mencetak PDF dan menyimpan file - keduanya didelegasikan ke
   background.js (chrome.debugger + chrome.downloads).

   Catatan penting yang dibawa dari hasil investigasi live di aplikasi (jangan diubah tanpa uji
   ulang - semuanya sudah terbukti bermasalah sekali):
     - Coretax mendeklarasikan `@page { size: a3 }` sendiri, dan Chrome memprioritaskan CSS @page
       di atas parameter cetak. Maka orientasi HARUS dipaksa lewat @page milik kita + dicetak
       dengan preferCSSPageSize:true (lihat background.js).
     - Tabel lebar duduk dalam kontainer overflow-x:auto - kalau tidak dibuka, kolom kanan hilang
       saat dicetak. Dibuka DAN tabelnya di-reflow agar muat lebar kertas.
     - Panel semua tab ada bersamaan di DOM, jadi pencarian elemen harus dibatasi yang TAMPIL.
     - Elemen tab harus dicari ULANG tiap kali (Angular me-render ulang strip tab), dan hasil
       perpindahan tab harus DIVERIFIKASI - kalau tidak, bisa tercetak isi tab yang sama dua kali.
*/
(() => {
    'use strict';

    const SPT_CONFIG = {
        ICT_RCIT: { formCode: '1771', annual: true, kind: 'corporate-income-tax-return',
            root: 'rshshr-corporate-income-tax-return', title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN' },
        ICT_PIT: { formCode: '1770', annual: true, kind: 'personal-income-tax-return',
            root: 'rshshr-personal-income-tax-return', title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK ORANG PRIBADI' },
        ICT_WIT: { formCode: 'SPT MASA PPH 21-26', kind: 'article-21-26-tax-return',
            root: 'rshshr-article-twentyone-twentysix-tax-return', title: 'PEMOTONGAN PPH PASAL 21 DAN/ATAU PASAL 26' },
        ICT_WT: { formCode: 'SPT MASA PPH UNIFIKASI', kind: 'withholding-tax-return',
            root: 'rshshr-withholding-return', title: 'SPT MASA PPH UNIFIKASI' },
        VAT_VAT: { formCode: 'SPT MASA PPN', kind: 'value-added-tax-return',
            root: 'rshshr-normal-value-add-tax-return', title: 'SURAT PEMBERITAHUAN MASA PAJAK PERTAMBAHAN NILAI (SPT MASA PPN)' }
    };
    const KIND_TO_TAXTYPE = Object.fromEntries(Object.entries(SPT_CONFIG).map(([code, config]) => [config.kind, code]));
    // Cocok untuk halaman SPT terlapor (…?view=true) MAUPUN konsep/draft (…/01122025) - keduanya
    // sudah diverifikasi live.
    const URL_RE = new RegExp('/(' + Object.keys(KIND_TO_TAXTYPE).join('|') +
        ')/([0-9a-f-]{30,36})/([0-9a-f-]{30,36})/(\\w+)/([0-9a-f-]{30,36})', 'i');

    // Selector class PrimeNG, BUKAN pencocokan teks: penamaan tab Badan ("L1-B", "L10-A") dan OP
    // ("L-1", "L-3A-4") polanya berbeda, jadi regex teks apa pun akan gagal di salah satunya.
    const TAB_TITLE_SEL = '.p-tabview-title';
    const MAX_ROWS_TO_EXPAND = 300;   // tabel lebih besar dari ini -> dibatasi
    const COMPACT_ROWS = 50;          // jumlah baris pada mode compact
    const TAB_ROW_CAP = { 'L9': 10 }; // batas khusus per tab
    // Tab yang menghasilkan DUA file: "(Print)" dibatasi + "(Lengkap)" seluruh baris.
    const TWO_VERSION_TABS = ['L3', 'L4', 'L9'];
    const PRINT_STYLE_ID = '__ca_print_style';
    const BTN_ID = '__ca_lampiran_widget';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function parseTarget() {
        const m = URL_RE.exec(window.location.pathname);
        return m ? { kind: m[1], taxTypeCode: KIND_TO_TAXTYPE[m[1]], config: SPT_CONFIG[KIND_TO_TAXTYPE[m[1]]] } : null;
    }

    function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    // ---------- Persiapan cetak ----------
    function preparePageForPrint(tabLabel, metadata) {
        const css = `
            table.__ca_layout > colgroup[data-ca-layout] { display: none; }
            #__ca_print_header { display: none; }
            @page { size: A3 landscape; margin: 8mm; }
            @media print {
                html, body, nui-shell-twostep { background: #ffffff !important;
                    background-image: none !important; }
                main.tw-content-wrap { margin-top: 0 !important; padding-top: 0 !important; }
                nav, aside, footer, .p-tabview-nav-container, .p-tabview-nav-content, .p-tabview-nav,
                [class*="sidebar" i], [class*="side-nav" i], [class*="footer" i],
                #${BTN_ID}, button, .p-button { display: none !important; }
                .__ca_source_title { display: none !important; }
                #__ca_print_header { display: grid !important; grid-template-columns: 180px 1fr 300px;
                    align-items: center; gap: 16px; border-bottom: 2px solid #172554;
                    padding: 0 4px 10px; margin: 0 0 12px; break-inside: avoid;
                    page-break-inside: avoid; }
                #__ca_print_header img { width: 160px; height: auto; object-fit: contain; }
                #__ca_print_header .ca-ph-title { text-align: center; color: #172554;
                    font-size: 14pt; font-weight: 700; line-height: 1.2; }
                #__ca_print_header .ca-ph-sub { text-align: center; color: #475569;
                    font-size: 11pt; font-weight: 700; letter-spacing: .3px;
                    margin-top: 5px; text-transform: uppercase; }
                #__ca_print_header .ca-ph-wp { text-align: right; color: #172554;
                    font-size: 10.5pt; line-height: 1.45; font-variant-numeric: tabular-nums; }
                #__ca_print_header .ca-ph-wp span { display: block; }
                #__ca_print_header .ca-ph-wp .ca-ph-name { font-weight: 700; }
                h1, h2 { text-align: left !important; font-size: 13pt !important;
                    line-height: 1.25 !important; margin: 8px 0 10px !important; }
                .p-datatable-wrapper, [class*="datatable" i], [class*="table-wrap" i],
                [class*="scroll" i] { overflow: visible !important; }
                table { width: 100% !important; max-width: 100% !important;
                        table-layout: fixed !important; font-size: 10pt !important; }
                table.__ca_table_wide { font-size: 9.5pt !important; }
                table.__ca_layout thead, table.__ca_layout thead tr,
                table.__ca_layout thead th, table.__ca_layout thead th * {
                    background: #eaf0f4 !important; color: #172554 !important; }
                table.__ca_layout thead tr, table.__ca_layout thead th {
                    height: auto !important; min-height: 0 !important; }
                table.__ca_layout thead th { font-size: 9.5pt !important; font-weight: 600 !important;
                    text-align: center !important; vertical-align: middle !important;
                    white-space: normal !important; overflow: visible !important;
                    text-overflow: clip !important; }
                table.__ca_layout thead th * { white-space: normal !important; overflow: visible !important;
                    text-overflow: clip !important; height: auto !important; min-height: 0 !important; }
                .p-datatable-header, .p-paginator, tr.__ca_filter_row,
                table.__ca_filter_table, .p-sortable-column-icon,
                .p-sortable-column-badge { display: none !important; }
                th, td { padding: 3px 4px !important; white-space: normal !important;
                         word-break: normal !important; overflow-wrap: anywhere !important;
                         min-width: 0 !important; line-height: 1.25 !important; }
                table.__ca_layout tbody td * { white-space: inherit !important;
                    overflow: visible !important; text-overflow: clip !important;
                    max-width: 100% !important; }
                th.__ca_col_action, td.__ca_col_action { visibility: hidden !important;
                    padding: 0 !important; border: 0 !important; width: 0 !important;
                    max-width: 0 !important; font-size: 0 !important; overflow: hidden !important; }
                th.__ca_col_no, td.__ca_col_no { text-align: center !important; }
                th.__ca_col_no { white-space: nowrap !important; overflow-wrap: normal !important;
                    word-break: normal !important; }
                th.__ca_col_date, td.__ca_col_date { text-align: center !important;
                    white-space: nowrap !important; font-variant-numeric: tabular-nums !important; }
                th.__ca_col_id, td.__ca_col_id { white-space: nowrap !important;
                    font-variant-numeric: tabular-nums !important; }
                td.__ca_col_account { white-space: nowrap !important; overflow: visible !important; }
                th.__ca_numeric, td.__ca_numeric { text-align: right !important;
                    white-space: nowrap !important; padding-left: 1px !important;
                    padding-right: 2px !important; font-variant-numeric: tabular-nums !important; }
                table.__ca_layout > colgroup[data-ca-layout] { display: table-column-group !important; }
                table.__ca_layout > colgroup:not([data-ca-layout]) { display: none !important; }
                table.__ca_layout > colgroup[data-ca-layout] > col { width: var(--ca-width) !important;
                    min-width: 0 !important; }
            }`;
        const profileForHeader = (text) => {
            const h = String(text || '').replace(/\s+/g, ' ')
                .replace(/(?:SILAKAN )?PILIH [^>]+/g, '').trim().toUpperCase();
            if (/^TINDAKAN$/.test(h)) return ['action', 0];
            if (/^(NO\.?|NOMOR|NO\. URUT)$/.test(h)) return ['no', 4];
            if (/NITKU|ID TEMPAT KEGIATAN USAHA|IDENTITAS SUBUNIT ORGANISASI/.test(h)) return ['id', 22];
            if (/NPWP|NIK|(?:^|\/)TIN(?:$|\s)|NOMOR IDENTITAS|IDENTITAS PENERIMA/.test(h)) return ['id', 17];
            if (/FILENAME|NAMA FILE/.test(h)) return ['filename', 32];
            if (/NAMA AKUN/.test(h)) return ['account', 32];
            if (/KODE DAN NOMOR SERI|KODE.*FAKTUR|NOMOR SERI FAKTUR/.test(h)) return ['code', 18];
            if (/KODE PENYESUAIAN/.test(h)) return ['code', 15];
            if (/KODE OBJEK/.test(h)) return ['code', 10];
            if (/KODE AKUN|KODE HARTA|^KODE$/.test(h)) return ['code', 5];
            if (/NOMOR BUKTI POTONG|BUKTI POTONG.*NOMOR|NOMOR DOKUMEN|DOKUMEN.*NOMOR/.test(h)) return ['code', 17];
            if (/BULAN\/TAHUN|TANGGAL|TAHUN PEROLEHAN/.test(h)) return ['date', 11];
            if (/NEGARA/.test(h)) return ['short', 10];
            if (/JENIS PAJAK/.test(h)) return ['short', 13];
            if (/METODE.*(?:KOMERSIAL|FISKAL)|^(?:KOMERSIAL|FISKAL)$/.test(h)) return ['short', 12];
            if (/TINGKAT|PERSENTASE|(?:^|>)\s*%/.test(h)) return ['numeric', 8];
            if (/NILAI|JUMLAH|DPP|^PPN(?:BM)?(?:\s|$)|PAJAK PENGHASILAN|PAJAK TERUTANG|BIAYA|AMOUNT|RUPIAH|KOMPENSASI|HARGA|PEROLEHAN|PENYUSUTAN|PENGHASILAN BRUTO|SALDO|PIUTANG|UTANG|LUAS|MODAL DISETOR|DIVIDEN/.test(h)) return ['numeric', 12];
            if (/NAMA/.test(h)) return ['name', 16];
            if (/DESKRIPSI|KETERANGAN|ALAMAT|KELOMPOK|JENIS|METODE|ALASAN|PEKERJAAN|KEGIATAN USAHA|OBJEK PAJAK|BENTUK HUBUNGAN/.test(h)) return ['long', 22];
            if (/LOKASI|UKURAN|SUMBER KEPEMILIKAN|KEPEMILIKAN|NOMOR AKUN|NOMOR POLISI|NOMOR SERTIFIKAT|REGISTRASI|MATA UANG|HUBUNGAN|KATEGORI|TIPE|MERK|JABATAN|STATUS|KAP-KJS/.test(h)) return ['short', 11];
            return ['default', 12];
        };
        const classForKind = (kind) => kind === 'action' ? '__ca_col_action' :
            kind === 'no' ? '__ca_col_no' : kind === 'date' ? '__ca_col_date' : kind === 'id' ? '__ca_col_id' :
                kind === 'account' ? '__ca_col_account' : kind === 'numeric' ? '__ca_numeric' : '';
        Array.from(document.querySelectorAll('table')).filter(isVisible).forEach((table) => {
            table.classList.remove('__ca_table_wide', '__ca_filter_table', '__ca_layout');
            table.querySelectorAll('colgroup[data-ca-layout]').forEach((el) => el.remove());
            table.querySelectorAll('th,td').forEach((cell) => cell.classList.remove(
                '__ca_col_action', '__ca_col_no', '__ca_col_date', '__ca_col_id', '__ca_col_account', '__ca_numeric'));
            const rows = Array.from(table.tHead ? table.tHead.rows : []);
            const grid = [], meta = [];
            let cols = 0;
            rows.forEach((row, rowIndex) => {
                grid[rowIndex] = grid[rowIndex] || [];
                let position = 0;
                Array.from(row.cells).forEach((th) => {
                    while (grid[rowIndex][position]) position++;
                    const colSpan = th.colSpan || 1, rowSpan = th.rowSpan || 1;
                    const text = (th.textContent || '').replace(/\s+/g, ' ').trim();
                    for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
                        grid[r] = grid[r] || [];
                        for (let c = position; c < position + colSpan; c++) grid[r][c] = true;
                    }
                    for (let c = position; c < position + colSpan; c++) {
                        meta[c] = meta[c] || { texts: [], controls: false, cells: [] };
                        if (text) meta[c].texts.push(text);
                        meta[c].controls = meta[c].controls || !!th.querySelector(
                            'input,select,.p-dropdown,.p-calendar,.p-column-filter');
                        meta[c].cells.push(th);
                    }
                    position += colSpan;
                    cols = Math.max(cols, position);
                });
            });
            if (!cols) return;
            for (let i = 0; i < cols; i++) meta[i] = meta[i] || { texts: [], controls: false, cells: [] };
            rows.forEach((row) => {
                row.classList.toggle('__ca_filter_row', !!row.querySelector(
                    'input,select,.p-column-filter,.p-dropdown,.p-calendar'));
                Array.from(row.cells).forEach((th) => {
                    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
                    let node;
                    while ((node = walker.nextNode())) node.nodeValue = node.nodeValue
                        .replace(/NPWPW/g, 'NPWP').replace(/\(Rp\.\)Rp\.\)/g, '(Rp.)');
                    th.style.setProperty('background-color', '#eaf0f4', 'important');
                    th.style.setProperty('color', '#172554', 'important');
                    th.querySelectorAll('*').forEach((element) => {
                        element.style.setProperty('background-color', 'transparent', 'important');
                        element.style.setProperty('color', '#172554', 'important');
                    });
                });
            });
            const meaningful = meta.some((item) => item.texts.some((text) =>
                !/^SILAKAN PILIH|^PILIH /i.test(text)));
            if (!meaningful && meta.some((item) => item.controls)) {
                table.classList.add('__ca_filter_table');
                return;
            }
            const bodyRows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)).slice(0, 60);
            meta.forEach((item, col) => {
                let seen = 0, numeric = 0, identity = 0, date = 0, checks = 0, maxLength = 0;
                const leafHeader = item.texts[item.texts.length - 1] || '';
                const fullHeader = item.texts.join(' > ');
                bodyRows.forEach((tr) => {
                    const cell = tr.cells[col]; if (!cell) return;
                    if (cell.querySelector('input[type="checkbox"],button,.p-button')) checks++;
                    const clone = cell.cloneNode(true);
                    clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach((el) => el.remove());
                    const value = (clone.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!value || /^(?:TIDAK ADA DATA|NO RECORDS?)/i.test(value)) return;
                    seen++; maxLength = Math.max(maxLength, value.length);
                    if (/^(Rp\.?\s*)?[-(]?[0-9.,]+[)]?$/.test(value)) numeric++;
                    if (/^\d{15,22}$/.test(value.replace(/\D/g, ''))) identity++;
                    if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(value)) date++;
                });
                let profile = profileForHeader(fullHeader || leafHeader);
                if (!leafHeader && !seen && !item.controls) profile = ['action', 0];
                else if (checks && checks >= Math.max(1, bodyRows.length * 0.5)) profile = ['action', 0];
                else if (seen && identity / seen >= 0.7) profile = ['id', Math.max(17, Math.min(23, maxLength + 1))];
                else if (seen && date / seen >= 0.7) profile = ['date', 11];
                else if (seen >= 1 && numeric / seen >= 0.7 && profile[0] === 'default') profile = ['numeric', 12];
                if (profile[0] === 'id') profile[1] = Math.max(profile[1], Math.min(23, maxLength + 1));
                if (profile[0] === 'numeric') profile[1] = Math.max(6, Math.min(17, maxLength + 2));
                if (profile[0] === 'name') profile[1] = Math.max(14, Math.min(24, 8 + maxLength * 0.45));
                if (profile[0] === 'account') profile[1] = Math.max(26, Math.min(36, 10 + maxLength * 0.5));
                if (profile[0] === 'long') profile[1] = Math.max(16, Math.min(30, 10 + maxLength * 0.35));
                if (profile[0] === 'filename') profile[1] = Math.max(28, Math.min(42, 12 + maxLength * 0.5));
                if (item.controls && profile[0] === 'default') profile = ['dropdown', 14];
                item.kind = profile[0]; item.weight = profile[1];
                const cls = classForKind(item.kind);
                if (cls) {
                    item.cells.filter((cell) => cell.colSpan === 1).forEach((cell) => cell.classList.add(cls));
                    bodyRows.forEach((tr) => { if (tr.cells[col]) tr.cells[col].classList.add(cls); });
                }
            });
            const total = meta.reduce((sum, item) => sum + item.weight, 0) || 1;
            const colgroup = document.createElement('colgroup');
            colgroup.dataset.caLayout = '1';
            meta.forEach((item) => {
                const col = document.createElement('col');
                col.style.setProperty('--ca-width', item.weight ?
                    ((item.weight / total) * 100).toFixed(3) + '%' : '0%');
                colgroup.appendChild(col);
            });
            table.insertBefore(colgroup, table.firstChild);
            table.classList.add('__ca_layout');
            if (cols >= 11) table.classList.add('__ca_table_wide');
        });
        let el = document.getElementById(PRINT_STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = PRINT_STYLE_ID;
        }
        el.textContent = css;
        // appendChild memindahkan ke posisi terakhir supaya selalu menang atas style Coretax.
        document.head.appendChild(el);

        const root = document.querySelector(metadata && metadata.rootSelector) || document.querySelector(
            'rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return,' +
            'rshshr-article-twentyone-twentysix-tax-return,rshshr-withholding-return,' +
            'rshshr-normal-value-add-tax-return');
        if (root) {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            let header = document.getElementById('__ca_print_header');
            if (!header) {
                header = document.createElement('div'); header.id = '__ca_print_header';
                header.innerHTML = '<div class="ca-ph-logo"></div><div><div class="ca-ph-title"></div>' +
                    '<div class="ca-ph-sub"></div></div><div class="ca-ph-wp"></div>';
                root.prepend(header);
            }
            const logo = Array.from(document.images).find((img) =>
                /Logo-Coretax-DJP-Kemenkeu/i.test(img.src));
            const logoBox = header.querySelector('.ca-ph-logo'); logoBox.replaceChildren();
            if (logo) { const copy = logo.cloneNode(); copy.removeAttribute('style'); logoBox.appendChild(copy); }
            const formTitle = clean(metadata && metadata.formTitle) || 'SURAT PEMBERITAHUAN (SPT)';
            Array.from(root.querySelectorAll('h1,h2,h3')).find((heading) =>
                clean(heading.textContent).toUpperCase() === formTitle.toUpperCase())?.classList.add('__ca_source_title');
            header.querySelector('.ca-ph-title').textContent = formTitle;
            header.querySelector('.ca-ph-sub').textContent =
                ('LAMPIRAN ' + clean(tabLabel || 'SPT')).toUpperCase();
            const year = (metadata && metadata.year) || detectYear();
            const tinField = document.querySelector('[formcontrolname="Tin"],[formcontrolname="CollectorTin"]');
            let tin = clean(tinField && (tinField.value || tinField.textContent));
            const candidates = Array.from(document.querySelectorAll('header *,nav *'))
                .map((node) => clean(node.textContent));
            if (!tin) tin = (candidates.join(' ').match(/\d{15,16}/) || [''])[0];
            const name = clean(metadata && metadata.entity) || 'WAJIB PAJAK';
            const wp = header.querySelector('.ca-ph-wp'); wp.replaceChildren();
            const npwpLine = document.createElement('span');
            npwpLine.textContent = tin ? 'NPWP: ' + tin : 'NPWP: -'; wp.appendChild(npwpLine);
            const nameLine = document.createElement('span'); nameLine.className = 'ca-ph-name';
            const periodLabel = clean(metadata && metadata.periodLabel) || (year && 'Tahun ' + year);
            nameLine.textContent = [name, periodLabel].filter(Boolean).join(' · ');
            wp.appendChild(nameLine);
        }
    }

    // ---------- Tab ----------
    function discoverTabLabels() {
        const seen = [];
        Array.from(document.querySelectorAll(TAB_TITLE_SEL)).forEach((el) => {
            const t = (el.textContent || '').trim();
            if (!t || seen.indexOf(t) !== -1 || !isVisible(el)) return;
            seen.push(t);
        });
        return seen;
    }

    function findTab(label) {
        return Array.from(document.querySelectorAll(TAB_TITLE_SEL)).find(
            (e) => (e.textContent || '').trim() === label && isVisible(e)) || null;
    }

    function panelSignature() {
        const t = (document.body.innerText || '').replace(/\s+/g, ' ');
        return t.length + '|' + t.slice(0, 400);
    }

    // ---------- Tabel ----------
    /** Tabel PrimeNG default hanya menampilkan 10 baris pertama; sisanya tidak ikut tercetak.
     *  Di sini dropdown "rows per page" tiap tabel yang TAMPIL diatur: tampilkan semua, atau
     *  dibatasi kalau tabelnya besar / tab-nya punya batas khusus. */
    async function setUpTables(tabLabel, mode) {
        const tabCap = TAB_ROW_CAP[String(tabLabel || '').trim()] || 0;
        const dropdowns = Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(isVisible);
        let done = 0;

        for (const dd of dropdowns) {
            try {
                if ((dd.className || '').indexOf('p-disabled') !== -1) continue; // tabel kosong

                const pag = dd.closest('.p-paginator');
                const txt = pag ? (pag.textContent || '') : '';
                const m = txt.match(/(?:of|dari)\s+([\d.,]+)\s+(?:entries|entri)/i);
                const total = m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : 0;
                // 'all' = tanpa batas, 'compact' = paksa batasi, selain itu otomatis.
                let cap;
                if (mode === 'all') cap = 0;
                else if (mode === 'compact') cap = tabCap || COMPACT_ROWS;
                else cap = tabCap || (total > MAX_ROWS_TO_EXPAND ? COMPACT_ROWS : 0); // 0 = semua

                const current = parseInt((dd.textContent || '').replace(/[^\d]/g, ''), 10);
                if (cap && current === cap) continue; // sudah pas

                dd.click();
                await sleep(350);
                const items = Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(isVisible);
                if (!items.length) { document.body.click(); continue; }

                let pick = items.length - 1; // default: opsi terbesar = tampilkan semua
                if (cap) {
                    const vals = items.map((it) => {
                        const d = (it.textContent || '').replace(/[^\d]/g, '');
                        return d ? parseInt(d, 10) : NaN;
                    });
                    let best = -1;
                    vals.forEach((v, i) => { if (!isNaN(v) && v <= cap && (best === -1 || v > vals[best])) best = i; });
                    pick = best !== -1 ? best : 0;
                }
                items[pick].click();
                done++;
                await sleep(500);
            } catch (e) { /* satu tabel gagal jangan menggagalkan sisanya */ }
        }
        return done;
    }

    async function resetPaginators() {
        let clicked = 0;
        Array.from(document.querySelectorAll('.p-paginator')).filter(isVisible).forEach((paginator) => {
            const first = paginator.querySelector('.p-paginator-first');
            if (first && !first.disabled && !first.classList.contains('p-disabled')) { first.click(); clicked++; }
        });
        if (clicked) await sleep(700);
    }

    function paginatorStates() {
        return Array.from(document.querySelectorAll('.p-paginator')).filter(isVisible).map((paginator) => {
            const text = (paginator.textContent || '').replace(/\s+/g, ' ').trim();
            const match = text.match(/(?:of|dari)\s+([\d.,]+)\s+(?:entries|entri)/i);
            return { index: Array.from(document.querySelectorAll('.p-paginator')).filter(isVisible).indexOf(paginator), total: match ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0 };
        }).filter((state) => state.total > 0);
    }

    // Angular mengganti node paginator setelah cetak/pindah halaman. Selalu ambil node saat ini
    // dari urutan visualnya; data-* yang ditempel pada node lama tidak bertahan setelah re-render.
    function paginatorAtVisibleIndex(index) {
        return Array.from(document.querySelectorAll('.p-paginator')).filter(isVisible)[index] || null;
    }

    async function capturePagedPdfs(mode) {
        await resetPaginators();
        const states = paginatorStates();
        const first = await chrome.runtime.sendMessage({ type: 'captureTab' });
        if (!first || !first.ok || !first.b64) throw new Error((first && first.error) || 'Gagal mencetak halaman pertama.');
        const list = [first.b64];
        if (mode !== 'full') return { list, states };
        for (const state of states) {
            let guard = 0;
            while (guard++ < 10000) {
                const paginator = paginatorAtVisibleIndex(state.index);
                if (!paginator) break;
                const next = paginator.querySelector('.p-paginator-next');
                if (!next || next.disabled || next.classList.contains('p-disabled')) break;
                const before = (paginator.textContent || '').replace(/\s+/g, ' ').trim();
                next.click(); await sleep(650);
                const after = (paginator.textContent || '').replace(/\s+/g, ' ').trim();
                if (after === before) break;
                const captured = await chrome.runtime.sendMessage({ type: 'captureTab' });
                if (!captured || !captured.ok || !captured.b64) throw new Error((captured && captured.error) || 'Gagal mencetak lanjutan paginator.');
                list.push(captured.b64);
            }
            const paginator = paginatorAtVisibleIndex(state.index);
            if (!paginator) continue;
            const firstButton = paginator.querySelector('.p-paginator-first');
            if (firstButton && !firstButton.disabled && !firstButton.classList.contains('p-disabled')) {
                firstButton.click(); await sleep(650);
            }
        }
        return { list, states };
    }

    // ---------- Identitas untuk nama file ----------
    function readFieldValue(name) {
        const el = document.querySelector('[formcontrolname="' + name + '"]');
        if (!el) return '';
        return (el.value != null ? String(el.value) : (el.textContent || '')).trim();
    }
    function sanitize(s) {
        return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    function detectYear() {
        const v = readFieldValue('TaxYear').match(/\d{4}/);
        if (v) return v[0];
        const t = (document.body.innerText || '').match(/(?:Tahun Pajak|Tax Year)[^\d]*(\d{4})/i);
        return t ? t[1] : String(new Date().getFullYear());
    }
    function detectPeriod(config) {
        const year = detectYear();
        if (config.annual) return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
        const names = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
        const compact = readFieldValue('Period') || readFieldValue('TaxPeriodYear');
        const compactMatch = compact.match(/^(0?[1-9]|1[0-2])(\d{4})$/);
        if (compactMatch) {
            const month = names[Number(compactMatch[1]) - 1];
            return { year: compactMatch[2], fileLabel: month + ' ' + compactMatch[2], headerLabel: 'Masa Pajak ' + month + ' ' + compactMatch[2] };
        }
        const monthValue = readFieldValue('TaxPeriodMonth');
        const yearValue = readFieldValue('TaxPeriodYear');
        if (/^(?:[1-9]|1[0-2])$/.test(monthValue) && /^\d{4}$/.test(yearValue)) {
            const month = names[Number(monthValue) - 1];
            return { year: yearValue, fileLabel: month + ' ' + yearValue, headerLabel: 'Masa Pajak ' + month + ' ' + yearValue };
        }
        const months = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember';
        const match = (document.body.innerText || '').match(new RegExp('Masa Pajak\\s*(' + months + ')\\s*(\\d{4})', 'i'));
        if (match) {
            const month = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
            return { year: match[2], fileLabel: month + ' ' + match[2], headerLabel: 'Masa Pajak ' + month + ' ' + match[2] };
        }
        const urlDate = location.pathname.match(/\/(\d{2})(\d{2})(\d{4})\//);
        if (urlDate) {
            const month = names[Math.max(0, Math.min(11, Number(urlDate[2]) - 1))];
            return { year: urlDate[3], fileLabel: month + ' ' + urlDate[3], headerLabel: 'Masa Pajak ' + month + ' ' + urlDate[3] };
        }
        return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
    }
    function detectEntity() {
        // Nama file mengikuti WP AKTIF pada pill akun Coretax, bukan field nama pada SPT.
        // Ini penting saat PIC sedang impersonate: field form dapat tetap memuat nama pihak
        // lain, sedangkan pill header adalah sumber sesi yang benar.
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        // textContent pill Coretax tidak selalu memiliki spasi pemisah antara NPWP, nama, dan
        // label Impersonate. Hapus berdasarkan bentuknya tanpa bergantung pada batas kata.
        const tidy = (s) => clean(s).replace(/IMPERSONATE/ig, '')
            .replace(/\d{15,16}/g, '').replace(/[·|]+/g, ' ').trim();
        const topVisible = (e) => {
            const r = e.getBoundingClientRect(), c = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && r.top < 150 && c.display !== 'none' && c.visibility !== 'hidden';
        };
        const pools = [];
        const imp = Array.from(document.querySelectorAll('body *')).find(
            (e) => topVisible(e) && /IMPERSONATE/i.test(clean(e.textContent)) && clean(e.textContent).length < 40);
        if (imp) {
            let p = imp;
            for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
                if (topVisible(p)) pools.push(p.title, p.getAttribute('aria-label'), p.textContent);
            }
        }
        Array.from(document.querySelectorAll('header [title],header [aria-label],header button,header [role="button"],nav [role="button"]'))
            .filter(topVisible).forEach((e) => pools.push(e.title, e.getAttribute('aria-label'), e.textContent));
        let best = '';
        const score = (s) => { s = tidy(s); return (!s || s.length < 3 || s.length > 100) ? -1 : (/[A-Za-z]{3}/.test(s) ? 10 : 0) + s.split(' ').length; };
        for (const raw of pools) {
            const s = tidy(raw);
            if (score(s) > score(best) && !/portal|beranda|profil|logout|bahasa|notifikasi/i.test(s)) best = s;
        }
        const name = readFieldValue('Name');
        const tin = readFieldValue('Tin') || readFieldValue('CollectorTin');
        return sanitize(best || name || tin) || 'SPT';
    }

    // ---------- Alur utama ----------
    /** `mode`: 'print' (lampiran berdaftar panjang dibatasi - cepat) atau 'full' (seluruh baris).
     *  Dipilih user di awal, bukan dicetak dua-duanya sekaligus: pada WP dengan bukti potong
     *  ratusan ribu baris, mencetak dua versi berarti menunggu dua kali lebih lama tanpa perlu. */
    async function runDownload(btn, mode) {
        const target = parseTarget();
        if (!target) return;

        const setLabel = (s) => { btn.innerHTML = s; };
        preparePageForPrint();

        // Tunggu tab muncul - tombol ini tampil begitu URL berubah, sementara Angular masih
        // merender formulirnya beberapa detik (lihat catatan yang sama di automation/lampiran.js).
        let labels = discoverTabLabels();
        const tabDeadline = Date.now() + 25000;
        while (!labels.length && Date.now() < tabDeadline) {
            setLabel('⏳ Menunggu halaman SPT dimuat...');
            await sleep(1000);
            labels = discoverTabLabels();
        }
        if (!labels.length) { setLabel('❌ Tab lampiran belum muncul - coba lagi'); return; }

        const entity = detectEntity();
        const config = target.config;
        const period = detectPeriod(config);
        const year = period.year;
        const formCode = config.formCode;

        const begin = await chrome.runtime.sendMessage({
            type: 'beginPrintSession', entity, year, formCode,
            mergeName: mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)'
        });
        if (!begin || !begin.ok) { setLabel('❌ ' + ((begin && begin.error) || 'Gagal menyiapkan pencetakan')); return; }

        let saved = 0, failed = 0;
        const pages = []; // halaman tiap lampiran, untuk berkas gabungan di akhir
        let prevSig = panelSignature();
        try {
            for (let i = 0; i < labels.length; i++) {
                const label = labels[i];
                setLabel('⏳ ' + label + ' (' + (i + 1) + '/' + labels.length + ')');

                // Cari ulang elemen tab SETIAP kali - strip tab di-render ulang tiap perpindahan.
                let switched = false;
                for (let attempt = 0; attempt < 2 && !switched; attempt++) {
                    const tab = findTab(label);
                    if (!tab) break;
                    tab.click();
                    await sleep(1400);
                    const sig = panelSignature();
                    // Tab pertama memang sudah aktif sejak awal, jadi tidak harus berubah.
                    if (i === 0 || sig !== prevSig) { switched = true; prevSig = sig; }
                }
                if (!switched && i > 0) { failed++; continue; } // hindari menyimpan duplikat

                // Hanya SATU versi per tab, sesuai mode yang dipilih user di awal. Sufiks nama
                // dipakai hanya untuk lampiran yang memang punya dua versi, supaya hasil mode
                // Print dan Lengkap tidak saling menimpa kalau dijalankan dua kali.
                const twoVersion = !config.annual || TWO_VERSION_TABS.indexOf(label) !== -1;
                const suffix = twoVersion ? (mode === 'print' ? ' (Print)' : ' (Lengkap)') : '';
                const tableMode = mode === 'print' ? 'compact' : 'all';

                setLabel('⏳ ' + label + ' (' + (i + 1) + '/' + labels.length + ')');
                await setUpTables(label, tableMode);
                preparePageForPrint(label, { entity, year, periodLabel: period.headerLabel,
                    rootSelector: config.root, formTitle: config.title });
                await sleep(300);

                const prefix = config.annual ? formCode + ' LAMPIRAN' : formCode;
                const filename = 'CoretaxLampiran/' + entity + '/' + year + '/' +
                    entity + ' - ' + prefix + ' ' + sanitize(label + suffix) + ' ' + period.fileLabel + '.pdf';
                const capture = await capturePagedPdfs(mode);
                const captures = capture.list;
                const totalInfo = capture.states.length ? ' · ' + capture.states.map((state) => state.total.toLocaleString('id-ID')).join(' + ') + ' entri' : '';
                setLabel('⏳ ' + label + totalInfo + ' (' + (i + 1) + '/' + labels.length + ')');
                let res;
                if (captures.length === 1) {
                    res = await chrome.runtime.sendMessage({ type: 'saveBase64', base64: captures[0], filename });
                    if (res && res.ok) res.b64 = captures[0];
                } else {
                    res = await chrome.runtime.sendMessage({ type: 'mergeAndSave', list: captures, filename, returnBase64: true });
                }
                if (res && res.ok) { saved++; if (res.b64) pages.push(res.b64); } else failed++;
            }
        } finally {
            if (pages.length) {
                setLabel('⏳ Menggabungkan ' + pages.length + ' lampiran...');
                const mergeName = mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)';
                const prefix = config.annual ? formCode + ' LAMPIRAN' : formCode;
                const mf = 'CoretaxLampiran/' + entity + '/' + year + '/' +
                    entity + ' - ' + prefix + ' ' + mergeName + ' ' + period.fileLabel + '.pdf';
                const mres = await chrome.runtime.sendMessage({ type: 'mergeAndSave', list: pages, filename: mf });
                if (mres && mres.ok) saved++; else failed++;
            }
            await chrome.runtime.sendMessage({ type: 'endPrintSession' });
            const first = findTab(labels[0]);
            if (first) first.click(); // kembalikan ke tab awal
        }

        setLabel(saved ? ('✅ ' + saved + ' file tersimpan' + (failed ? ' (' + failed + ' gagal)' : '')) : '❌ Tidak ada yang tersimpan');
    }

    // ---------- Pilihan mode ----------
    const CHOOSER_ID = '__ca_lampiran_chooser';
    function showModeChooser(btn) {
        const old = document.getElementById(CHOOSER_ID);
        if (old) { old.remove(); return; } // klik kedua = tutup
        const box = document.createElement('div');
        box.id = CHOOSER_ID;
        box.style.cssText = 'position:fixed;bottom:60px;left:16px;z-index:2147483647;background:#fff;' +
            'border:1px solid #cbd5e1;border-radius:10px;padding:12px;width:290px;font-family:sans-serif;' +
            'box-shadow:0 8px 24px rgba(0,0,0,0.18);font-size:12px;color:#1a202c;';
        box.innerHTML =
            '<div style="font-weight:700;margin-bottom:8px;">Pilih versi yang diunduh</div>' +
            '<button id="__ca_m_print" style="width:100%;text-align:left;background:#0D9488;color:#fff;border:none;' +
            'border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:7px;">' +
            '📄 Versi Print <span style="font-weight:400;">- cepat</span><br>' +
            '<span style="font-weight:400;font-size:11px;opacity:.9;">Halaman pertama tiap tabel; termasuk PDF gabungan</span></button>' +
            '<button id="__ca_m_full" style="width:100%;text-align:left;background:#fff;color:#1a202c;border:1px solid #cbd5e1;' +
            'border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600;">' +
            '📚 Versi Lengkap <span style="font-weight:400;">- seluruh baris</span><br>' +
            '<span style="font-weight:400;font-size:11px;color:#b45309;">⚠️ Bisa sangat lama bila bukti potong ribuan baris</span></button>';
        document.documentElement.appendChild(box);

        const start = async (mode) => {
            box.remove();
            btn.disabled = true;
            try { await runDownload(btn, mode); }
            catch (err) { btn.innerHTML = '❌ ' + (err && err.message ? err.message : 'Gagal'); }
            setTimeout(() => { btn.innerHTML = '📄 Unduh Lampiran Lengkap'; btn.disabled = false; }, 6000);
        };
        box.querySelector('#__ca_m_print').onclick = () => start('print');
        box.querySelector('#__ca_m_full').onclick = () => start('full');
    }

    // ---------- Tombol ----------
    function ensureWidget() {
        if (!document.documentElement) return;
        const target = parseTarget();
        let btn = document.getElementById(BTN_ID);
        if (!target) { if (btn) btn.remove(); return; }
        if (btn) return;

        btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0D9488;' +
            'color:#F8FAFC;border:1px solid #0F766E;padding:8px 14px;border-radius:8px;font-size:12px;' +
            'font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);font-family:sans-serif;';
        btn.innerHTML = '📄 Unduh Lampiran Lengkap';
        btn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (btn.disabled) return;
            showModeChooser(btn);
        };
        document.documentElement.appendChild(btn); // ke <html>, lebih tahan re-render <body>
    }

    ensureWidget();
    // Coretax adalah SPA - URL bisa berubah tanpa reload, dan Angular bisa menghapus tombol kita.
    setInterval(ensureWidget, 1000);
})();
