/* Coretax Agent - cetak lampiran SPT langsung dari tampilan Coretax melalui CDP. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, PDFArray, decodePDFRawStream } = require('pdf-lib');
const { log } = require('../lib/log');
const { sanitizeFilenamePart } = require('../lib/datatable');
const htmlToPdf = require('../lib/html-to-pdf');
const lampiranWidget = require('../lib/lampiran-widget');
const returnsheetGridApi = require('../lib/returnsheet-grid-api');

const RETURNSHEET_API = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const ZERO_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

const TAXTYPE_CONFIG = {
    ICT_RCIT: {
        formCode: 'SPT Tahunan PPh Badan', annual: true, pathKind: 'corporate-income-tax-return',
        rootSelector: 'rshshr-corporate-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN'
    },
    ICT_PIT: {
        formCode: 'SPT Tahunan PPh Orang Pribadi', annual: true, pathKind: 'personal-income-tax-return',
        rootSelector: 'rshshr-personal-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK ORANG PRIBADI'
    },
    ICT_WIT: {
        formCode: 'SPT MASA PPH 21-26', pathKind: 'article-21-26-tax-return',
        rootSelector: 'rshshr-article-twentyone-twentysix-tax-return',
        title: 'SPT MASA PAJAK PENGHASILAN (PPh) PASAL 21 DAN/ATAU PASAL 26',
        sourceTitle: 'PEMOTONGAN PPH PASAL 21 DAN/ATAU PASAL 26', repeatHeader: true
    },
    ICT_WT: {
        formCode: 'SPT MASA PPH UNIFIKASI', pathKind: 'withholding-tax-return',
        rootSelector: 'rshshr-withholding-return', title: 'SPT MASA PPH UNIFIKASI', repeatHeader: true
    },
    VAT_VAT: {
        formCode: 'SPT MASA PPN', pathKind: 'value-added-tax-return',
        rootSelector: 'rshshr-normal-value-add-tax-return',
        title: 'SURAT PEMBERITAHUAN MASA PAJAK PERTAMBAHAN NILAI (SPT MASA PPN)', repeatHeader: true
    }
};
const TAB_TITLE_SEL = '.p-tabview-title';
const TWO_VERSION_TABS = new Set(['L3', 'L4', 'L9']);
const TAB_ROW_CAP = { L9: 10 };
const COMPACT_ROWS = 50;
const PRINT_SCALE = 0.9;
const MONTHLY_PAGINATOR_SCALE = { 'ICT_WIT:L-III': 0.75, 'ICT_WT:DAFTAR-I': 0.75 };
const ANNUAL_PRINT_SCALE = {
    'ICT_PIT:Induk': 0.84, 'ICT_PIT:L-2': 0.88,
    'ICT_RCIT:Induk': 0.84, 'ICT_RCIT:L9': 0.8, 'ICT_RCIT:L11-B': 0.8
};
const PPH21_API_GRIDS = {
    'L-IA': ['/loadarticle2126/l1a-grid'],
    'L-IB': ['/loadarticle2126/l1b-bpa1-grid', '/loadarticle2126/l1b-bpa2-grid'],
    'L-II': ['/loadarticle2126/l2-bpa1-grid', '/loadarticle2126/l2-bpa2-grid'],
    'L-III': ['/loadarticle2126/l3-bp21-grid', '/loadarticle2126/l3-bp26-grid']
};
const UNIFIKASI_API_GRIDS = {
    'DAFTAR-I': ['/loadwtr/list-i-bpu-grid', '/loadwtr/list-i-bpnr-grid'],
    'DAFTAR-II': ['/loadwtr/list-ii-sp-grid', '/loadwtr/list-ii-cy-grid'],
    'LAMPIRAN-I': ['/loadwtr/attachment-i-grid']
};
const PPN_API_GRIDS = {
    'A-1': ['/loadndvat/la1-grid'],
    'A-2': ['/loadndvat/la2-grid'],
    'B-1': ['/loadndvat/lb1-grid'],
    'B-2': ['/loadndvat/lb2-grid'],
    'B-3': ['/loadndvat/lb3-grid'],
    'C': ['/loadndvat/lc-grid']
};
const ANNUAL_API_GRIDS = {
    ICT_RCIT: {
        'L3': [
            { suffix: '/loadcit/l3-table-b-grid', signature: 'NAMA PEMOTONG/PEMUNGUT.*NPWP.*JENIS PAJAK' }
        ],
        'L4': [
            { suffix: '/loadcit/l4-table-a-grid', signature: 'NPWP PEMOTONG/PEMUNGUT.*KODE OBJEK PAJAK' }
        ],
        'L9': [
            { suffix: '/loadcit/l9-table-1-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 0 },
            { suffix: '/loadcit/l9-table-2-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 5 },
            { suffix: '/loadcit/l9-table-3-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 7 }
        ]
    },
    ICT_PIT: {
        'L-1': [
            { suffix: '/loadpit/l1-table-a1-grid', signature: 'NOMOR AKUN.*ATAS NAMA' },
            { suffix: '/loadpit/l1-table-a2-grid', signature: 'LOKASI PENERIMA PINJAMAN' },
            { suffix: '/loadpit/l1-table-a3-grid', signature: 'NPWP BANK/INSTITUSI/PENERIMA INVESTASI' },
            { suffix: '/loadpit/l1-table-a4-grid', signature: 'MERK/MODEL' },
            { suffix: '/loadpit/l1-table-a5-grid', signature: 'UKURAN PROPERTI - TANAH' },
            { suffix: '/loadpit/l1-table-a6-grid', signature: 'BUKTI KEPEMILIKAN' },
            { suffix: '/loadpit/l1-table-d-grid', signature: 'NAMA PEMBERI KERJA' },
            { suffix: '/loadpit/l1-table-e-grid', signature: 'NAMA PEMOTONG/PEMUNGUT PPh' }
        ],
        'L-2': [
            { suffix: '/loadpit/l2-table-a-grid', signature: 'KODE OBJEK PAJAK.*DASAR PENGENAAN PAJAK' }
        ]
    }
};
const PPH21_LAMPIRAN_TITLES = {
    'L-IA': 'Daftar Pemotongan Bulanan Pajak Penghasilan Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya',
    'L-IB': 'Daftar Pemotongan Pajak Penghasilan Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya untuk Masa Pajak Terakhir',
    'L-II': 'Daftar Pemotongan Satu Tahun Pajak atau Bagian Tahun Pajak PPh Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya',
    'L-III': 'Daftar Pemotongan Pajak Penghasilan Pasal 21 dan/atau Pasal 26 selain Pegawai Tetap atau Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala'
};
const PRINT_STYLE_ID = '__ca_print_style';
const watchedContexts = new WeakSet();

async function waitForTabLabels(page) {
    const deadline = Date.now() + 25000;
    const started = Date.now();
    let best = [], previous = '', stable = 0;
    while (Date.now() < deadline) {
        const labels = await page.evaluate(`(() => {
            const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
            return [...new Set(Array.from(document.querySelectorAll(${JSON.stringify(TAB_TITLE_SEL)})).filter(visible).map(e=>(e.textContent||'').trim()).filter(Boolean))];
        })()`).catch(() => []);
        if (labels.length > best.length) best = labels;
        const signature = labels.join('|');
        stable = signature && signature === previous ? stable + 1 : 0;
        previous = signature;
        // Angular sering menampilkan tab Induk lebih dahulu, kemudian menyisipkan tab lampiran.
        // Jangan mengunci inventaris pada render parsial tersebut.
        if (labels.length > 1 && stable >= 3) return labels;
        if (labels.length === 1 && Date.now() - started >= 7000 && stable >= 5) return labels;
        await page.waitForTimeout(500);
    }
    return best;
}

async function clickTab(page, label) {
    const loc = page.locator(TAB_TITLE_SEL).filter({ hasText: label });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const item = loc.nth(i);
        if (((await item.textContent().catch(() => '')) || '').trim() === label && await item.isVisible().catch(() => false)) {
            await item.click({ timeout: 5000 });
            await page.waitForTimeout(1400);
            return true;
        }
    }
    return false;
}

async function waitForTabContentStable(page, rootSelector, { minWaitMs = 2000, timeoutMs = 12000 } = {}) {
    const started = Date.now();
    let previous = '', stable = 0;
    while (Date.now() - started < timeoutMs) {
        const state = await page.evaluate(`(()=>{
          const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
          const root=document.querySelector(${JSON.stringify(rootSelector)});if(!root)return{busy:true,snapshot:''};
          const busy=Array.from(root.querySelectorAll('.p-progress-spinner,.p-datatable-loading-overlay,.p-progressbar-indeterminate,.p-skeleton')).some(visible);
          const clean=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
          const tables=Array.from(root.querySelectorAll('table')).filter(visible).map(t=>clean(t.tBodies?.[0])+'|'+clean(t.tFoot));
          const pagers=Array.from(root.querySelectorAll('.p-paginator')).filter(visible).map(clean);
          return{busy,snapshot:(tables.join('||')+'###'+pagers.join('||')).slice(0,250000)};
        })()`).catch(() => ({ busy: true, snapshot: '' }));
        if (!state.busy && state.snapshot && state.snapshot === previous) stable++;
        else stable = 0;
        previous = state.snapshot;
        if (Date.now() - started >= minWaitMs && stable >= 3) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function preparePageForPrint(page, tabLabel, metadata) {
    const repeatHeader = !!(metadata && metadata.repeatHeader)
        || /PEMOTONGAN PPH PASAL 21 DAN\/ATAU PASAL 26/i.test(String(metadata && metadata.sourceTitle || ''));
    const css = `table.__ca_layout>colgroup[data-ca-layout]{display:none}
      @page { size:A3 landscape !important; margin:7mm 8mm 8mm !important; }
      #__ca_print_header,#__ca_l1d_snapshot,#__ca_repeat_snapshot,#__ca_annual_snapshot{display:none}
      @media print { html,body,nui-shell-twostep{background:#fff!important;background-image:none!important} .tw-shell-main{padding:0!important;transition:none!important} main.tw-content-wrap{margin-top:0!important;padding-top:0!important} nav,aside,footer,.p-tabview-nav-container,.p-tabview-nav-content,.p-tabview-nav,[class*="sidebar" i],[class*="side-nav" i],[class*="footer" i],#__ca_lampiran_widget,#__ca_lampiran_chooser,#__ca_lampiran_widget_v11036,#__ca_lampiran_chooser_v11036,#__ca_lampiran_widget_v11036final,#__ca_lampiran_chooser_v11036final,#__ca_lampiran_widget_v11037final,#__ca_lampiran_chooser_v11037final,#__ca_lampiran_widget_v11038final,#__ca_lampiran_chooser_v11038final,#__ca_lampiran_widget_v11039final,#__ca_lampiran_chooser_v11039final,#__ca_lampiran_widget_v11040final,#__ca_lampiran_chooser_v11040final,#__ca_lampiran_widget_v11041final,#__ca_lampiran_chooser_v11041final,#__ca_lampiran_widget_v11042final,#__ca_lampiran_chooser_v11042final,#__ca_lampiran_widget_v11043final,#__ca_lampiran_chooser_v11043final,#__ca_passphrase_widget{display:none!important}
      #__ca_lampiran_widget_v11044final,#__ca_lampiran_chooser_v11044final,#__ca_lampiran_widget_v1150final,#__ca_lampiran_chooser_v1150final,#__ca_lampiran_widget_v1150package,#__ca_lampiran_chooser_v1150package{display:none!important}
      .__ca_source_title{display:none!important}
      #__ca_print_header,.__ca_print_header_clone{display:grid!important;position:relative!important;z-index:2147483646!important;grid-template-columns:230px 1fr 320px;align-items:center;gap:18px;border-bottom:2px solid #172554;padding:0 5px 8px;margin:0 8mm 6px;background:#fff!important;break-inside:avoid;page-break-inside:avoid}
      #__ca_print_header img,.__ca_print_header_clone img{width:210px;height:auto;object-fit:contain}#__ca_print_header .ca-ph-title,.__ca_print_header_clone .ca-ph-title{text-align:center;color:#172554;font-size:15pt;font-weight:700;line-height:1.2}#__ca_print_header .ca-ph-sub,.__ca_print_header_clone .ca-ph-sub{text-align:center;color:#475569;font-size:11.5pt;font-weight:700;letter-spacing:.3px;margin-top:5px;text-transform:uppercase}#__ca_print_header .ca-ph-wp,.__ca_print_header_clone .ca-ph-wp{text-align:right;color:#172554;font-size:11pt;line-height:1.45;font-variant-numeric:tabular-nums}#__ca_print_header .ca-ph-wp span,.__ca_print_header_clone .ca-ph-wp span{display:block}#__ca_print_header .ca-ph-wp .ca-ph-name,.__ca_print_header_clone .ca-ph-wp .ca-ph-name{font-weight:700}
      body.__ca_repeat_header #__ca_print_header{display:none!important}
      body.__ca_repeat_snapshot_active>*:not(#__ca_repeat_snapshot){display:none!important}
      body.__ca_repeat_snapshot_active>#__ca_repeat_snapshot{display:block!important;width:100%!important;max-width:100%!important}
      body.__ca_annual_snapshot_active>*:not(#__ca_print_header):not(#__ca_annual_snapshot){display:none!important}
      body.__ca_annual_snapshot_active>#__ca_print_header{display:none!important}
      body.__ca_annual_snapshot_active>#__ca_annual_snapshot{display:block!important;width:100%!important;max-width:100%!important}
      #__ca_annual_snapshot>rshshr-corporate-income-tax-return,#__ca_annual_snapshot>rshshr-personal-income-tax-return{display:contents!important}
      #__ca_annual_snapshot p-tabview{display:contents!important}
      #__ca_annual_snapshot,#__ca_annual_snapshot>* ,#__ca_annual_snapshot .p-tabview-panels,#__ca_annual_snapshot .p-tabview-panel{break-before:auto!important;page-break-before:auto!important;break-inside:auto!important;page-break-inside:auto!important}
      #__ca_repeat_snapshot .__ca_print_header_clone{display:grid!important;margin:0 0 2mm!important;padding:0 1mm 2mm!important}
      #__ca_repeat_snapshot .__ca_repeat_page_header{break-before:page!important;page-break-before:always!important}
      button,.p-button{display:none!important}
      h1,h2{text-align:left!important;font-size:13pt!important;line-height:1.25!important;margin:8px 0 10px!important}
      .p-datatable-wrapper,[class*="datatable" i],[class*="table-wrap" i],[class*="scroll" i]{overflow:visible!important}
      p-table,.p-datatable,.p-datatable-wrapper,table.__ca_layout{break-inside:auto!important;page-break-inside:auto!important}
      table{width:100%!important;max-width:100%!important;table-layout:fixed!important;font-size:10pt!important}
      .__ca_document_row{display:flex!important;flex-wrap:nowrap!important;column-gap:0!important}
      .__ca_document_row>.__ca_document_label{flex:0 0 60%!important;width:60%!important;max-width:60%!important;padding:2px 8px 2px 15px!important;line-height:1.15!important}
      .__ca_document_row>.__ca_document_label,.__ca_document_row>.__ca_document_label *{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important;max-width:none!important}
      .__ca_document_row>.__ca_document_area{flex:0 0 40%!important;width:40%!important;max-width:40%!important;min-width:0!important}
      .__ca_document_area .p-fileupload-buttonbar{display:none!important}
      .__ca_document_area p-fileupload,.__ca_document_area .p-fileupload,.__ca_document_area .p-fileupload-content{height:30px!important;min-height:30px!important;max-height:30px!important;padding:0!important}
      .__ca_document_row{min-height:0!important;margin-top:0!important;margin-bottom:0!important;break-inside:avoid!important;page-break-inside:avoid!important}
      .__ca_document_section>br{display:none!important}
      .p-accordion-tab,.p-toggleable-content,.p-accordion-content{break-inside:auto!important;page-break-inside:auto!important}
      .p-accordion-header-link,.p-accordion-header-link *,.p-panel-header,.p-panel-header *,.p-fieldset-legend,.p-fieldset-legend *{text-decoration:none!important}
      .__ca_keep_together{break-inside:avoid!important;page-break-inside:avoid!important}
      .__ca_keep_with_next{break-after:avoid!important;page-break-after:avoid!important}
      .__ca_op_compact .p-accordion-content>br{display:none!important}
      .__ca_op_compact .form-group.row{min-height:0!important;margin-top:0!important;margin-bottom:0!important}
      .__ca_op_compact .col-form-label{padding-top:2px!important;padding-bottom:2px!important;line-height:1.15!important}
      .__ca_statement_compact .p-accordion-content{padding-top:6px!important;padding-bottom:6px!important}
      .__ca_statement_compact .form-group.row{min-height:0!important;margin-top:0!important;margin-bottom:0!important}
      .__ca_statement_compact .col-form-label{padding-top:2px!important;padding-bottom:2px!important;line-height:1.15!important}
      .__ca_annual_induk_compact .p-accordion-header-link{padding:5px 8px!important;min-height:0!important;text-decoration:none!important}
      .__ca_annual_induk_compact .p-accordion-header-link *{text-decoration:none!important}
      .__ca_annual_induk_compact .p-accordion-content{padding:4px 8px!important}
      .__ca_annual_induk_compact .form-group.row{min-height:0!important;margin-top:0!important;margin-bottom:1px!important}
      .__ca_annual_induk_compact .col-form-label{padding-top:2px!important;padding-bottom:2px!important;line-height:1.1!important}
      .__ca_annual_induk_compact .form-control,.__ca_annual_induk_compact .p-inputtext{height:23px!important;min-height:23px!important;padding-top:1px!important;padding-bottom:1px!important}
      .__ca_annual_induk_compact table.__ca_layout tbody td{padding:2px 3px!important;line-height:1.1!important}
      .__ca_corporate_induk_spacious .p-accordion-header-link{padding:6px 8px!important}
      .__ca_corporate_induk_spacious .p-accordion-content{padding:5px 8px!important}
      .__ca_corporate_induk_spacious .form-group.row{margin-bottom:2px!important}
      .__ca_corporate_induk_spacious .col-form-label{padding-top:2px!important;padding-bottom:2px!important;line-height:1.14!important}
      .__ca_corporate_induk_spacious .form-control,.__ca_corporate_induk_spacious .p-inputtext{height:24px!important;min-height:24px!important;padding-top:1px!important;padding-bottom:1px!important}
      .__ca_corporate_induk_spacious table.__ca_layout tbody td{padding:2px 3px!important;line-height:1.14!important}
      .__ca_monthly_induk_compact .p-accordion-header-link{padding:7px 9px!important;min-height:0!important;text-decoration:none!important}
      .__ca_monthly_induk_compact .p-accordion-header-link *{text-decoration:none!important}
      .__ca_monthly_induk_compact .p-accordion-content{padding:6px 9px!important}
      .__ca_monthly_induk_compact .form-group.row{min-height:0!important;margin-top:0!important;margin-bottom:2px!important}
      .__ca_monthly_induk_compact .col-form-label{padding-top:3px!important;padding-bottom:3px!important;line-height:1.16!important}
      .__ca_monthly_induk_compact .form-control,.__ca_monthly_induk_compact .p-inputtext{height:26px!important;min-height:26px!important;padding-top:2px!important;padding-bottom:2px!important}
      .__ca_monthly_induk_compact table.__ca_layout tbody td{padding:3px 4px!important;line-height:1.16!important}
      .__ca_monthly_detail_compact h1,.__ca_monthly_detail_compact h2{font-size:12pt!important;line-height:1.15!important;margin:4px 0 6px!important}
      .__ca_monthly_detail_compact .p-panel-header,.__ca_monthly_detail_compact .p-accordion-header-link{padding:7px 9px!important;min-height:0!important;text-decoration:none!important}
      .__ca_monthly_detail_compact .p-panel-header *,.__ca_monthly_detail_compact .p-accordion-header-link *{text-decoration:none!important}
      .__ca_monthly_detail_compact .p-panel-content,.__ca_monthly_detail_compact .p-accordion-content{padding:7px 9px!important}
      .__ca_monthly_detail_compact .form-group.row{min-height:0!important;margin-top:0!important;margin-bottom:2px!important}
      .__ca_monthly_detail_compact table.__ca_table_wide tbody td{padding:4px 4px!important;line-height:1.18!important}
      .__ca_annual_induk_compact .p-accordion-header-link,.__ca_monthly_induk_compact .p-accordion-header-link,.__ca_monthly_detail_compact .p-accordion-header-link,.__ca_monthly_detail_compact .p-panel-header{text-decoration:none!important}
      .__ca_annual_induk_compact .p-accordion-header-link *,.__ca_monthly_induk_compact .p-accordion-header-link *,.__ca_monthly_detail_compact .p-accordion-header-link *,.__ca_monthly_detail_compact .p-panel-header *{text-decoration:none!important}
      .__ca_annual_induk_compact .p-radiobutton-disabled,.__ca_monthly_induk_compact .p-radiobutton-disabled,.__ca_monthly_detail_compact .p-radiobutton-disabled{opacity:1!important}
      .__ca_annual_induk_compact .p-radiobutton-box,.__ca_monthly_induk_compact .p-radiobutton-box,.__ca_monthly_detail_compact .p-radiobutton-box{border:1.5px solid #cbd5e1!important;background:#edf2f5!important;opacity:1!important}
      .__ca_annual_induk_compact .p-radiobutton-box.p-highlight,.__ca_monthly_induk_compact .p-radiobutton-box.p-highlight,.__ca_monthly_detail_compact .p-radiobutton-box.p-highlight{border-color:#2196f3!important;background:#2196f3!important}
      .__ca_annual_induk_compact .p-radiobutton-box.p-highlight .p-radiobutton-icon,.__ca_monthly_induk_compact .p-radiobutton-box.p-highlight .p-radiobutton-icon,.__ca_monthly_detail_compact .p-radiobutton-box.p-highlight .p-radiobutton-icon{background:#fff!important;transform:none!important;width:7px!important;height:7px!important}
      .__ca_annual_induk_compact .p-radiobutton-label,.__ca_monthly_induk_compact .p-radiobutton-label,.__ca_monthly_detail_compact .p-radiobutton-label{color:#334155!important;opacity:1!important}
      .__ca_annual_induk_compact .p-radiobutton-label-active,.__ca_monthly_induk_compact .p-radiobutton-label-active,.__ca_monthly_detail_compact .p-radiobutton-label-active{color:#0f172a!important;font-weight:700!important}
      table.__ca_document_table{width:100%!important;min-width:100%!important;max-width:100%!important;font-size:7.5pt!important}
      table.__ca_document_table.p-datatable-table>thead.p-datatable-thead>tr>th,table.__ca_document_table.p-datatable-table>tbody>tr>td{height:auto!important;min-height:0!important;padding:0 2px!important;line-height:1!important}
      table.__ca_document_table thead th *{height:auto!important;min-height:0!important;line-height:1!important}
      table.__ca_document_table .ng-th__grip,table.__ca_document_table .p-column-resizer{display:none!important}
      table.__ca_document_table th.__ca_col_action,table.__ca_document_table td.__ca_col_action{display:none!important}
      table.__ca_document_table td:nth-child(2){white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}
      table.__ca_table_wide{font-size:9.5pt!important}
      table.__ca_layout thead,table.__ca_layout thead tr,table.__ca_layout thead th,table.__ca_layout thead th *{background:#eaf0f4!important;color:#172554!important}
      table.__ca_layout thead tr,table.__ca_layout thead th{height:auto!important;min-height:0!important}
      table.__ca_layout thead th{font-size:9.5pt!important;font-weight:600!important;text-align:center!important;vertical-align:middle!important;white-space:normal!important;overflow:visible!important;text-overflow:clip!important}
      table.__ca_layout thead th *{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;height:auto!important;min-height:0!important}
      .p-datatable-header,.p-paginator,.p-sortable-column-icon,.p-sortable-column-badge,.p-dropdown-panel,.p-dropdown-items-wrapper,.p-connected-overlay,tr.__ca_filter_row,table.__ca_filter_table{display:none!important}
      th,td{padding:3px 4px!important;white-space:normal!important;word-break:normal!important;overflow-wrap:anywhere!important;min-width:0!important;line-height:1.25!important}
      table.__ca_layout tbody td *{white-space:inherit!important;overflow:visible!important;text-overflow:clip!important;max-width:100%!important}
      table.__ca_layout td .p-inputgroup,table.__ca_layout td .p-inputnumber,table.__ca_layout td [class*="input-group" i]{width:100%!important;min-width:0!important;max-width:100%!important}
      table.__ca_layout td .p-inputgroup,table.__ca_layout td [class*="input-group" i]{display:flex!important}
      table.__ca_layout td p-inputnumber{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important}
      table.__ca_layout td .p-inputgroup p-inputnumber,table.__ca_layout td [class*="input-group" i] p-inputnumber{flex:1 1 auto!important;width:1%!important}
      table.__ca_layout td .p-inputgroup>input,table.__ca_layout td .p-inputnumber>input,table.__ca_layout td [class*="input-group" i]>input{flex:1 1 auto!important;width:100%!important;min-width:0!important;max-width:100%!important}
      table.__ca_layout td .p-inputgroup-addon,table.__ca_layout td [class*="input-group" i]>span{flex:0 0 auto!important;white-space:nowrap!important}
      table.__ca_layout td .p-inputgroup-addon{width:42px!important;min-width:42px!important;justify-content:center!important}
      table.__ca_layout td .p-inputnumber-input{text-align:right!important}
      th.__ca_col_action,td.__ca_col_action{visibility:hidden!important;padding:0!important;border:0!important;width:0!important;max-width:0!important;font-size:0!important;overflow:hidden!important}
      th.__ca_col_no,td.__ca_col_no{text-align:center!important}th.__ca_col_no{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}
      th.__ca_col_date,td.__ca_col_date{text-align:center!important;white-space:nowrap!important;font-variant-numeric:tabular-nums!important}
      th.__ca_col_id,td.__ca_col_id{text-align:center!important;white-space:nowrap!important;font-variant-numeric:tabular-nums!important}
      th.__ca_center,td.__ca_center,th.__ca_center *,td.__ca_center *{text-align:center!important}
      td.__ca_col_account{white-space:nowrap!important;overflow:visible!important}
      th.__ca_numeric,td.__ca_numeric{text-align:right!important;white-space:nowrap!important;padding-left:1px!important;padding-right:2px!important;font-variant-numeric:tabular-nums!important}
      table.__ca_layout>colgroup[data-ca-layout]{display:table-column-group!important}
      table.__ca_layout>colgroup:not([data-ca-layout]){display:none!important}
      table.__ca_layout>colgroup[data-ca-layout]>col{width:var(--ca-width)!important;min-width:0!important}
      table.__ca_layout tfoot td.__ca_total_label,table.__ca_layout tfoot td.__ca_total_label *{white-space:nowrap!important;overflow:visible!important;overflow-wrap:normal!important;word-break:normal!important;font-size:7.5pt!important;line-height:1.1!important}
      table.__ca_sibling_empty_table thead,table.__ca_sibling_empty_table tbody{display:none!important}table.__ca_sibling_empty_table{margin:0!important}
      .__ca_paginator_owner_hidden{display:none!important}
      #__ca_l1d_snapshot{display:block!important;width:100%!important}
      body.__ca_l1d_snapshot_active>*:not(#__ca_l1d_snapshot){display:none!important}
      #__ca_l1d_snapshot .__ca_l1d_page{display:block!important;width:100%!important;break-after:page!important;page-break-after:always!important}
      #__ca_l1d_snapshot .__ca_l1d_page:last-child{break-after:auto!important;page-break-after:auto!important}
      #__ca_l1d_snapshot .__ca_l1d_section{display:block!important;width:100%!important;margin:0!important;padding:0 8mm!important;break-inside:avoid!important;page-break-inside:avoid!important}
      #__ca_l1d_snapshot .p-accordion-header{margin:0!important}
      #__ca_l1d_snapshot .p-accordion-header-link{padding:5px 8px!important;min-height:0!important}
      #__ca_l1d_snapshot .p-accordion-content{padding:5px 8px 0!important}
      #__ca_l1d_snapshot .__ca_l1d_page{--ca-l1d-font:7.35pt;--ca-l1d-head-font:7.2pt;--ca-l1d-control:21px;--ca-l1d-cell-y:1px;--ca-l1d-line:1.08}
      #__ca_l1d_snapshot table.__ca_layout{font-size:var(--ca-l1d-font)!important}
      #__ca_l1d_snapshot table.__ca_layout thead th{font-size:var(--ca-l1d-head-font)!important;padding:2px 3px!important;line-height:1.08!important}
      #__ca_l1d_snapshot table.__ca_layout tbody td{padding:var(--ca-l1d-cell-y) 3px!important;line-height:var(--ca-l1d-line)!important;height:auto!important;min-height:0!important}
      #__ca_l1d_snapshot table.__ca_layout input,#__ca_l1d_snapshot table.__ca_layout .p-inputtext{height:var(--ca-l1d-control)!important;min-height:var(--ca-l1d-control)!important;padding:0 3px!important;font-size:var(--ca-l1d-head-font)!important;line-height:1!important}
      #__ca_l1d_snapshot table.__ca_layout .p-inputgroup-addon{height:var(--ca-l1d-control)!important;min-height:var(--ca-l1d-control)!important;width:34px!important;min-width:34px!important;padding:0 2px!important;font-size:var(--ca-l1d-head-font)!important}
      #__ca_l1d_snapshot .__ca_l1d_balance_row{display:flex!important;align-items:stretch!important}
      #__ca_l1d_snapshot .__ca_l1d_balance_col{display:flex!important;flex-direction:column!important}
      #__ca_l1d_snapshot .__ca_l1d_balance_host{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important}
      #__ca_l1d_snapshot .__ca_l1d_balance_component{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important}
      #__ca_l1d_snapshot .__ca_l1d_balance_component>form{flex:0 0 auto!important}
      #__ca_l1d_snapshot table.__ca_l1d_total_table{margin-top:auto!important}
      #__ca_l1d_snapshot table.__ca_l1d_total_table td{font-weight:700!important;background:#f1f5f9!important}
      }`;
    await page.evaluate(`(()=>{
      document.getElementById('__ca_l1d_snapshot')?.remove();document.body.classList.remove('__ca_l1d_snapshot_active');document.getElementById('__ca_annual_snapshot')?.remove();document.body.classList.remove('__ca_annual_snapshot_active');
      document.querySelectorAll('table.__ca_balance_table').forEach(table=>{table.classList.remove('__ca_balance_table');table.style.removeProperty('height')});
      const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
        const profile=h=>{h=(h||'').replace(/\\s+/g,' ').replace(/(?:SILAKAN )?PILIH [^>]+/g,'').trim().toUpperCase();if(/^TINDAKAN$/.test(h))return['action',0];if(/^(NO\\.?|NOMOR|NO\\. URUT)$/.test(h))return['no',4];if(/(?:LOKASI.*PROPERTI|PROPERTI.*LOKASI|LOKASI HARTA)/.test(h))return['location',28];if(/^ATAS NAMA$/.test(h))return['short',15];if(/(?:UKURAN.*PROPERTI|PROPERTI.*UKURAN)/.test(h))return['short',7];if(/NITKU|ID TEMPAT KEGIATAN USAHA|IDENTITAS SUBUNIT ORGANISASI|IDENTITAS AKUN/.test(h))return['id',22];if(/NPWP|NIK|(?:^|\\/)TIN(?:$|\\s)|NOMOR IDENTITAS|IDENTITAS PENERIMA/.test(h))return['id',17];if(/FILENAME|NAMA FILE|NAMA DOKUMEN/.test(h))return['filename',32];if(/NAMA AKUN/.test(h))return['account',32];if(/KODE DAN NOMOR SERI|KODE.*FAKTUR|NOMOR SERI FAKTUR/.test(h))return['code',18];if(/KODE PENYESUAIAN/.test(h))return['code',10];if(/KODE OBJEK/.test(h))return['code',10];if(/KODE AKUN|KODE HARTA|^KODE$/.test(h))return['code',5];if(/NOMOR BUKTI POTONG|BUKTI POTONG.*NOMOR|NOMOR DOKUMEN|DOKUMEN.*NOMOR/.test(h))return['code',17];if(/MASA PE+ROLEHAN PENGHASILAN/.test(h))return['short',16];if(/BULAN\\/TAHUN|TANGGAL|TAHUN PEROLEHAN/.test(h))return['date',11];if(/NEGARA/.test(h))return['short',10];if(/JENIS PAJAK/.test(h))return['short',13];if(/UANG PERSEDIAAN \\/ PEMBAYARAN LANGSUNG/.test(h))return['short',15];if(/FASILITAS (?:PERPAJAKAN|PPH)|METODE.*(?:KOMERSIAL|FISKAL)|^(?:KOMERSIAL|FISKAL)$/.test(h))return['short',12];if(/TINGKAT|PERSENTASE|(?:^|>)\\s*%/.test(h))return['numeric',8];if(/^NILAI$/.test(h))return['numeric',15];if(/NILAI|JUMLAH|DPP|^PPN(?:BM)?(?:\\s|$)|PAJAK PENGHASILAN|PAJAK TERUTANG|BIAYA|AMOUNT|RUPIAH|KOMPENSASI|HARGA|PEROLEHAN|PENYUSUTAN|PENGHASILAN BRUTO|SALDO|PIUTANG|UTANG|LUAS|MODAL DISETOR|DIVIDEN/.test(h))return['numeric',12];if(/NAMA/.test(h))return['name',16];if(/DESKRIPSI|KETERANGAN|ALAMAT|KELOMPOK|JENIS|METODE|ALASAN|PEKERJAAN|KEGIATAN USAHA|OBJEK PAJAK|BENTUK HUBUNGAN/.test(h))return['long',22];if(/LOKASI|UKURAN|SUMBER KEPEMILIKAN|KEPEMILIKAN|NOMOR AKUN|NOMOR POLISI|NOMOR SERTIFIKAT|REGISTRASI|MATA UANG|HUBUNGAN|KATEGORI|TIPE|MERK|JABATAN|STATUS|KAP-KJS/.test(h))return['short',11];return['default',12]};
      const classOf=k=>k==='action'?'__ca_col_action':k==='no'?'__ca_col_no':k==='date'?'__ca_col_date':k==='id'?'__ca_col_id':k==='account'?'__ca_col_account':k==='numeric'?'__ca_numeric':k==='code'||k==='short'||k==='location'?'__ca_center':'';
      for(const table of Array.from(document.querySelectorAll('table')).filter(visible)){
        table.classList.remove('__ca_table_wide','__ca_filter_table','__ca_document_table','__ca_layout');table.querySelectorAll('colgroup[data-ca-layout]').forEach(e=>e.remove());
        table.querySelectorAll('th,td').forEach(c=>c.classList.remove('__ca_col_action','__ca_col_no','__ca_col_date','__ca_col_id','__ca_col_account','__ca_numeric','__ca_center'));
        const rows=Array.from(table.tHead?table.tHead.rows:[]),grid=[],meta=[];let cols=0;
        rows.forEach((row,ri)=>{grid[ri]=grid[ri]||[];let pos=0;for(const th of Array.from(row.cells)){while(grid[ri][pos])pos++;const cs=th.colSpan||1,rs=th.rowSpan||1,text=(th.textContent||'').replace(/\\s+/g,' ').trim();for(let r=ri;r<ri+rs;r++){grid[r]=grid[r]||[];for(let c=pos;c<pos+cs;c++)grid[r][c]=true}for(let c=pos;c<pos+cs;c++){meta[c]=meta[c]||{texts:[],controls:false,cells:[]};if(text)meta[c].texts.push(text);meta[c].controls=meta[c].controls||!!th.querySelector('input,select,.p-dropdown,.p-calendar,.p-column-filter');meta[c].cells.push(th)}pos+=cs;cols=Math.max(cols,pos)}});
        if(!cols)continue;for(let i=0;i<cols;i++)meta[i]=meta[i]||{texts:[],controls:false,cells:[]};
        for(const row of rows){row.classList.toggle('__ca_filter_row',!!row.querySelector('input,select,.p-column-filter,.p-dropdown,.p-calendar'));for(const th of Array.from(row.cells)){const walker=document.createTreeWalker(th,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())node.nodeValue=node.nodeValue.replace(/NPWPW/g,'NPWP').replace(/\\(Rp\\.\\)Rp\\.\\)/g,'(Rp.)');th.style.setProperty('background-color','#eaf0f4','important');th.style.setProperty('color','#172554','important');th.querySelectorAll('*').forEach(e=>{e.style.setProperty('background-color','transparent','important');e.style.setProperty('color','#172554','important')})}}
        const meaningful=meta.some(m=>m.texts.some(t=>!/^SILAKAN PILIH|^PILIH /i.test(t)));if(!meaningful&&meta.some(m=>m.controls)){table.classList.add('__ca_filter_table');continue}
        const headerLabels=meta.map(m=>(m.texts[m.texts.length-1]||'').replace(/\\s+/g,' ').trim().toUpperCase());if(/^NO\\.?$/.test(headerLabels[0])&&headerLabels[1]==='NAMA DOKUMEN'){table.classList.add('__ca_document_table');const row=table.closest('.form-group.row');if(row){const scope=row.closest('.p-accordion-content')||row.parentElement;scope.classList.add('__ca_document_section');for(const candidate of Array.from(scope.querySelectorAll('.form-group.row'))){if(candidate.children.length>=1){candidate.classList.add('__ca_document_row');candidate.children[0].classList.add('__ca_document_label');if(candidate.children.length>=2)candidate.children[candidate.children.length-1].classList.add('__ca_document_area')}}}}
        const bodyRows=Array.from(table.tBodies).flatMap(b=>Array.from(b.rows)).slice(0,60);
        meta.forEach((m,col)=>{let seen=0,num=0,id=0,date=0,checks=0,maxLen=0;const leaf=m.texts[m.texts.length-1]||'',full=m.texts.join(' > ');for(const tr of bodyRows){const cell=tr.cells[col];if(!cell)continue;if(cell.querySelector('input[type="checkbox"],button,.p-button'))checks++;const clone=cell.cloneNode(true);clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach(e=>e.remove());const v=(clone.textContent||'').replace(/\\s+/g,' ').trim();if(!v||/^(?:TIDAK ADA DATA|NO RECORDS?)/i.test(v))continue;seen++;maxLen=Math.max(maxLen,v.length);if(/^(Rp\\.?\\s*)?[-(]?[0-9.,]+[)]?$/.test(v))num++;if(/^\\d{15,22}$/.test(v.replace(/\\D/g,'')))id++;if(/^\\d{1,2}[-\\/]\\d{1,2}[-\\/]\\d{2,4}$/.test(v))date++}let p=profile(full||leaf);if(!leaf&&!seen&&!m.controls)p=['action',0];else if(checks&&checks>=Math.max(1,bodyRows.length*.5))p=['action',0];else if(seen&&id/seen>=.7)p=['id',Math.max(17,Math.min(23,maxLen+1))];else if(seen&&date/seen>=.7)p=['date',11];else if(seen>=1&&num/seen>=.7&&p[0]==='default')p=['numeric',12];if(p[0]==='id')p[1]=Math.max(p[1],Math.min(23,maxLen+1));if(p[0]==='numeric')p[1]=Math.max(p[1],6,Math.min(17,maxLen+2));if(p[0]==='name')p[1]=Math.max(14,Math.min(24,8+maxLen*.45));if(p[0]==='account')p[1]=Math.max(26,Math.min(36,10+maxLen*.5));if(p[0]==='long')p[1]=Math.max(16,Math.min(30,10+maxLen*.35));if(p[0]==='filename')p[1]=Math.max(28,Math.min(42,12+maxLen*.5));if(m.controls&&p[0]==='default')p=['dropdown',14];m.kind=p[0];m.weight=p[1];const cl=classOf(m.kind);if(cl){m.cells.filter(c=>c.colSpan===1).forEach(c=>c.classList.add(cl));for(const tr of bodyRows)if(tr.cells[col])tr.cells[col].classList.add(cl)}});
        meta.forEach((m,col)=>{
          const heading=(m.texts.join(' > ')||'').replace(/\\s+/g,' ').trim().toUpperCase();
          if(/(?:^|>)\\s*ATAS NAMA(?:\\s|$)/.test(heading)){
            m.cells.filter(c=>c.colSpan===1).forEach(c=>c.classList.add('__ca_center'));
            for(const tr of bodyRows)if(tr.cells[col])tr.cells[col].classList.add('__ca_center');
          }
          if(/LOKASI HARTA/.test(heading)){
            for(const tr of bodyRows){
              const cell=tr.cells[col];if(!cell)continue;
              const valueNode=cell.cloneNode(true);valueNode.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach(e=>e.remove());
              const value=(valueNode.textContent||'').replace(/\\s+/g,' ').trim();
              if(/^(?:INDONESIA|SINGAPURA|MALAYSIA|THAILAND|VIETNAM|FILIPINA|BRUNEI|KAMBOJA|LAOS|MYANMAR|TIMOR LESTE|JEPANG|CHINA|HONG KONG|TAIWAN|KOREA SELATAN|INDIA|AUSTRALIA|SELANDIA BARU|AMERIKA SERIKAT|KANADA|INGGRIS|BELANDA|JERMAN|PRANCIS|SWISS|UNI EMIRAT ARAB)$/i.test(value))cell.classList.add('__ca_center');
            }
          }
        });
        for(const row of Array.from(table.tFoot?.rows||[])){
          const cells=Array.from(row.cells),labelIndex=cells.findIndex(cell=>/^(?:JUMLAH|TOTAL)\\b/i.test((cell.textContent||'').replace(/\\s+/g,' ').trim()));
          if(labelIndex<0)continue;
          const labelCell=cells[labelIndex];labelCell.classList.add('__ca_total_label');
          for(let index=labelIndex-1;index>=0;index--){const cell=cells[index],text=(cell.textContent||'').replace(/\\u00a0/g,' ').trim();if(text)break;labelCell.colSpan+=(cell.colSpan||1);cell.remove()}
        }
        const total=meta.reduce((n,m)=>n+m.weight,0)||1,cg=document.createElement('colgroup');cg.dataset.caLayout='1';meta.forEach(m=>{const col=document.createElement('col');col.style.setProperty('--ca-width',m.weight?((m.weight/total)*100).toFixed(3)+'%':'0%');cg.appendChild(col)});table.insertBefore(cg,table.firstChild);table.classList.add('__ca_layout');if(cols>=11)table.classList.add('__ca_table_wide');
      }
      const contentTables=Array.from(document.querySelectorAll('table.__ca_layout')).filter(visible),hasRows=table=>Array.from(table.tBodies).flatMap(body=>Array.from(body.rows)).some(row=>{const text=(row.textContent||'').replace(/\\s+/g,' ').trim();return text&&!/^(?:TIDAK ADA DATA(?: YANG DITEMUKAN)?\.?|NO RECORDS?(?: FOUND)?\.?)$/i.test(text)});if(contentTables.some(hasRows))for(const table of contentTables)table.classList.toggle('__ca_sibling_empty_table',!hasRows(table));
      for(const tab of document.querySelectorAll('p-accordiontab,.p-accordion-tab')){const heading=(tab.querySelector('.p-accordion-header')?.textContent||'').replace(/\\s+/g,' ').trim().toUpperCase();if(/PERNYATAAN/.test(heading))tab.classList.add('__ca_statement_compact');if(/^K\\.?\\s+PERNYATAAN/.test(heading))tab.classList.add('__ca_keep_together','__ca_op_compact');if(/^J\\.?\\s+LAMPIRAN TAMBAHAN/.test(heading))tab.classList.add('__ca_op_compact','__ca_keep_with_next')}
      let e=document.getElementById(${JSON.stringify(PRINT_STYLE_ID)});if(!e){e=document.createElement('style');e.id=${JSON.stringify(PRINT_STYLE_ID)}}e.textContent=${JSON.stringify(css)};document.head.appendChild(e)
    })()`).catch((error) => { log('[Lampiran] Gagal menyiapkan tabel cetak: ' + error.message); });
    // Kirim sebagai source string: fungsi callback Playwright tidak dapat diserialisasi
    // ketika automation/lampiran.js berjalan dari snapshot EXE pkg.
    const packagedHeaderPayload = { label: tabLabel || '', entity: metadata && metadata.entity,
        year: metadata && metadata.year, periodLabel: metadata && metadata.periodLabel,
        rootSelector: metadata && metadata.rootSelector, formTitle: metadata && metadata.formTitle,
        sourceTitle: metadata && metadata.sourceTitle, repeatHeader, annual: !!(metadata && metadata.annual) };
    const packagedHeaderResult = await page.evaluate(`(()=>{
      const p=${JSON.stringify(packagedHeaderPayload)},clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
       const root=document.querySelector(p.rootSelector)||document.querySelector('rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return,rshshr-withholding-return,rshshr-normal-value-add-tax-return');if(!root)return{ok:false,reason:'root-not-found'};document.body.classList.toggle('__ca_repeat_header',!!p.repeatHeader);root.classList.toggle('__ca_monthly_induk_compact',!!p.repeatHeader&&clean(p.label).toUpperCase()==='INDUK');root.classList.toggle('__ca_monthly_detail_compact',!!p.repeatHeader&&clean(p.label).toUpperCase()!=='INDUK');root.classList.toggle('__ca_annual_induk_compact',!!p.annual&&clean(p.label).toUpperCase()==='INDUK');root.classList.toggle('__ca_corporate_induk_spacious',root.matches('rshshr-corporate-income-tax-return')&&clean(p.label).toUpperCase()==='INDUK');
      let h=document.getElementById('__ca_print_header');if(!h){h=document.createElement('div');h.id='__ca_print_header';h.innerHTML='<div class="ca-ph-logo"></div><div><div class="ca-ph-title"></div><div class="ca-ph-sub"></div></div><div class="ca-ph-wp"></div>';document.body.prepend(h)}else if(h.parentNode!==document.body)document.body.prepend(h);
      const logo=Array.from(document.images).find(i=>/Logo-Coretax-DJP-Kemenkeu/i.test(i.src)),box=h.querySelector('.ca-ph-logo');box.replaceChildren();if(logo){const copy=logo.cloneNode();copy.removeAttribute('style');box.appendChild(copy)}
       const title=clean(p.formTitle)||'SURAT PEMBERITAHUAN (SPT)',sourceTitle=clean(p.sourceTitle)||title,label=clean(p.label||'SPT').toUpperCase();h.querySelector('.ca-ph-title').textContent=title;
       const source=Array.from(root.querySelectorAll('h1,h2,h3')).find(e=>clean(e.textContent).toUpperCase()===sourceTitle.toUpperCase());if(source)source.classList.add('__ca_source_title');
       const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},detected=Array.from(root.querySelectorAll('h1,h2,h3')).filter(visible).map(e=>clean(e.textContent)).find(t=>{const u=t.toUpperCase();return u&&u!==title.toUpperCase()&&u!==sourceTitle.toUpperCase()&&u!=='HEADER'&&u!==label&&!/^LAMPIRAN\\s/.test(u)})||'';
       const name=detected||({L9:'DAFTAR PENYUSUTAN DAN AMORTISASI FISKAL'})[label]||'',codeOnly=root.matches('rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return')||/ORANG PRIBADI/i.test(title),prefix=/^LAMPIRAN(?:\\s|-)/.test(label)?label:'LAMPIRAN '+label;h.querySelector('.ca-ph-sub').textContent=(label==='INDUK'?'LAMPIRAN INDUK':codeOnly?prefix:prefix+(name?' - '+name:'')).toUpperCase();
      const year=clean(p.year)||clean((document.querySelector('[formcontrolname="TaxYear"]')||{}).value),tinField=document.querySelector('[formcontrolname="Tin"],[formcontrolname="CollectorTin"]');let tin=clean(tinField&&(tinField.value||tinField.textContent));if(!tin)tin=(Array.from(document.querySelectorAll('header *,nav *')).map(e=>clean(e.textContent)).join(' ').match(/\\d{15,16}/)||[''])[0];
       if(root.matches('rshshr-withholding-return')&&/^DAFTAR-/.test(label))h.querySelector('.ca-ph-sub').textContent=label;
       const wp=h.querySelector('.ca-ph-wp');wp.replaceChildren();const n=document.createElement('span');n.textContent=tin?'NPWP: '+tin:'NPWP: -';wp.appendChild(n);const period=clean(p.periodLabel)||(year&&'Tahun '+year),line=document.createElement('span');line.className='ca-ph-name';line.textContent=[clean(p.entity)||'WAJIB PAJAK',period&&period.toUpperCase()].filter(Boolean).join(' · ');wp.appendChild(line);return{ok:true,parent:h.parentElement&&h.parentElement.tagName};
    })()`).catch(error=>({ok:false,reason:error.message}));
    if (!packagedHeaderResult || !packagedHeaderResult.ok) log('[Lampiran kop paket] Gagal ' + String(tabLabel || '') + ': ' + JSON.stringify(packagedHeaderResult));
    const headerResult = packagedHeaderResult || await page.evaluate((payload) => {
        const label = payload && payload.label;
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const root = document.querySelector(payload && payload.rootSelector) || document.querySelector('rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return,rshshr-withholding-return,rshshr-normal-value-add-tax-return');
        if (!root) return { ok: false, reason: 'root-not-found' };
        document.body.classList.toggle('__ca_repeat_header', !!(payload && payload.repeatHeader));
        root.classList.toggle('__ca_monthly_induk_compact', !!(payload && payload.repeatHeader) && clean(payload && payload.label).toUpperCase() === 'INDUK');
        root.classList.toggle('__ca_monthly_detail_compact', !!(payload && payload.repeatHeader) && clean(payload && payload.label).toUpperCase() !== 'INDUK');
        root.classList.toggle('__ca_annual_induk_compact', !!(payload && payload.annual) && clean(payload && payload.label).toUpperCase() === 'INDUK');
        root.classList.toggle('__ca_corporate_induk_spacious', root.matches('rshshr-corporate-income-tax-return') && clean(payload && payload.label).toUpperCase() === 'INDUK');
        let header = document.getElementById('__ca_print_header');
        if (!header) {
            header = document.createElement('div'); header.id = '__ca_print_header';
            header.innerHTML = '<div class="ca-ph-logo"></div><div><div class="ca-ph-title"></div><div class="ca-ph-sub"></div></div><div class="ca-ph-wp"></div>';
            document.body.prepend(header);
        } else if (header.parentNode !== document.body) {
            document.body.prepend(header);
        }
        const logo = [...document.images].find((img) => /Logo-Coretax-DJP-Kemenkeu/i.test(img.src));
        const logoBox = header.querySelector('.ca-ph-logo'); logoBox.replaceChildren();
        if (logo) { const copy = logo.cloneNode(); copy.removeAttribute('style'); logoBox.appendChild(copy); }
        const formTitle = clean(payload && payload.formTitle) || 'SURAT PEMBERITAHUAN (SPT)';
        const sourceTitle = clean(payload && payload.sourceTitle) || formTitle;
        [...root.querySelectorAll('h1,h2,h3')].find((heading) => clean(heading.textContent).toUpperCase() === sourceTitle.toUpperCase())?.classList.add('__ca_source_title');
        header.querySelector('.ca-ph-title').textContent = formTitle;
        const normalizedLabel = clean(label || 'SPT').toUpperCase();
        const visibleHeading = (node) => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
        const detectedLampiranName = Array.from(root.querySelectorAll('h1,h2,h3')).filter(visibleHeading).map((node) => clean(node.textContent)).find((text) => {
            const upper = text.toUpperCase(); return upper && upper !== formTitle.toUpperCase() && upper !== sourceTitle.toUpperCase() && upper !== 'HEADER' && upper !== normalizedLabel && !/^LAMPIRAN\\s/.test(upper);
        }) || '';
        const fallbackNames = { L9: 'DAFTAR PENYUSUTAN DAN AMORTISASI FISKAL' };
        const lampiranName = detectedLampiranName || fallbackNames[normalizedLabel] || '';
        const codeOnlyLampiran = root.matches('rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return') || /ORANG PRIBADI/i.test(formTitle);
        const directUnifikasiCode = root.matches('rshshr-withholding-return') && /^DAFTAR-/.test(normalizedLabel);
        const lampiranPrefix = /^LAMPIRAN(?:\\s|-)/.test(normalizedLabel) ? normalizedLabel : 'LAMPIRAN ' + normalizedLabel;
        header.querySelector('.ca-ph-sub').textContent = (normalizedLabel === 'INDUK' ? 'LAMPIRAN INDUK' : directUnifikasiCode ? normalizedLabel : codeOnlyLampiran ? lampiranPrefix : lampiranPrefix + (lampiranName ? ' - ' + lampiranName : '')).toUpperCase();
        const year = clean(payload && payload.year) || clean(document.querySelector('[formcontrolname="TaxYear"]')?.value) || '';
        const tinField = document.querySelector('[formcontrolname="Tin"],[formcontrolname="CollectorTin"]');
        let tin = clean(tinField && (tinField.value || tinField.textContent));
        const candidates = [...document.querySelectorAll('header *,nav *')].map((el) => clean(el.textContent));
        if (!tin) tin = (candidates.join(' ').match(/\d{15,16}/) || [''])[0];
        const name = clean(payload && payload.entity) || 'WAJIB PAJAK';
        const wp = header.querySelector('.ca-ph-wp'); wp.replaceChildren();
        const npwpLine = document.createElement('span'); npwpLine.textContent = tin ? 'NPWP: ' + tin : 'NPWP: -'; wp.appendChild(npwpLine);
        const periodLabel = clean(payload && payload.periodLabel) || (year && 'Tahun ' + year);
        const nameLine = document.createElement('span'); nameLine.className = 'ca-ph-name';
        nameLine.textContent = [name, periodLabel && periodLabel.toUpperCase()].filter(Boolean).join(' · '); wp.appendChild(nameLine);
        return { ok: true, parent: header.parentElement && header.parentElement.tagName, text: header.innerText };
    }, { label: tabLabel || '', entity: metadata && metadata.entity, year: metadata && metadata.year,
        periodLabel: metadata && metadata.periodLabel, rootSelector: metadata && metadata.rootSelector,
        formTitle: metadata && metadata.formTitle, sourceTitle: metadata && metadata.sourceTitle,
        repeatHeader, annual: !!(metadata && metadata.annual) }).catch((error) => ({ ok: false, reason: error.message }));
    if (!headerResult || !headerResult.ok) log('[Lampiran kop] Gagal ' + String(tabLabel || '') + ': ' + JSON.stringify(headerResult));
    else log('[Lampiran kop] Aktif ' + String(tabLabel || '') + ': ' + headerResult.parent);
    if (repeatHeader) {
        const repeatResult = await page.evaluate(`(()=>{
          const p=${JSON.stringify({ rootSelector: metadata && metadata.rootSelector, label: tabLabel || '' })};document.body.classList.add('__ca_repeat_snapshot_active');
          window.__ca_rebuildRepeatSnapshot=()=>{document.getElementById('__ca_repeat_snapshot')?.remove();const root=document.querySelector(p.rootSelector),header=document.getElementById('__ca_print_header');if(!root||!header)return{ok:false,reason:!root?'root-not-found':'header-not-found'};
            const sync=(source,clone)=>{const a=source.querySelectorAll('input,textarea,select'),b=clone.querySelectorAll('input,textarea,select');a.forEach((control,index)=>{const target=b[index];if(!target)return;target.value=control.value||'';target.setAttribute('value',control.value||'');if('checked'in control){target.checked=control.checked;if(control.checked)target.setAttribute('checked','');else target.removeAttribute('checked')}if(control.tagName==='SELECT')Array.from(target.options).forEach((option,i)=>option.selected=!!control.options[i]?.selected)})};
            const makeHeader=(pageBreak=false)=>{const copy=header.cloneNode(true);copy.removeAttribute('id');copy.classList.add('__ca_print_header_clone');if(pageBreak)copy.classList.add('__ca_repeat_page_header');return copy};
            const snapshot=document.createElement('div');snapshot.id='__ca_repeat_snapshot';const copy=root.cloneNode(true);sync(root,copy);snapshot.append(makeHeader(),copy);
            const clean=v=>String(v||'').replace(/\s+/g,' ').trim().toUpperCase(),insertBefore=target=>{if(target?.parentNode)target.parentNode.insertBefore(makeHeader(true),target)};
            if(!copy.classList.contains('__ca_paginator_owner_mode')){
            if(clean(p.label)==='INDUK'){const marker=Array.from(copy.querySelectorAll('.p-accordion-header')).find(node=>/^C\\.?\\s+PAJAK PENGHASILAN PASAL 26/.test(clean(node.textContent))),target=marker?.closest('p-accordiontab,.p-accordion-tab')||marker?.parentElement;insertBefore(target)}
            if(clean(p.label)==='L-III'){const markers=Array.from(copy.querySelectorAll('.p-fieldset-legend-text,.p-panel-header,.p-accordion-header,legend')).filter(node=>clean(node.textContent)==='BP26');const marker=markers[0],target=marker?.closest('p-fieldset,.p-fieldset,p-panel,.p-panel,p-accordiontab,.p-accordion-tab')||marker?.parentElement;if(target&&!target.querySelector('table.__ca_sibling_empty_table'))insertBefore(target)}
            }
            document.body.appendChild(snapshot);return{ok:true,breaks:snapshot.querySelectorAll('.__ca_repeat_page_header').length}};return window.__ca_rebuildRepeatSnapshot();
        })()`).catch(error=>({ok:false,reason:error.message}));
        if (!repeatResult || !repeatResult.ok) log('[Lampiran kop ulang] Gagal ' + String(tabLabel || '') + ': ' + JSON.stringify(repeatResult));
    } else {
        await page.evaluate(`(()=>{document.getElementById('__ca_repeat_snapshot')?.remove();document.body.classList.remove('__ca_repeat_snapshot_active');delete window.__ca_rebuildRepeatSnapshot})()`).catch(() => {});
    }
    const l1Snapshot = await setUpL1PrintSnapshot(page, tabLabel, metadata);
    if (l1Snapshot && l1Snapshot.ok) log('[Lampiran L1] Snapshot dinamis aktif ' + String(tabLabel || '') + ': ' + JSON.stringify(l1Snapshot));
    else if (l1Snapshot && !l1Snapshot.skipped) log('[Lampiran L1] Snapshot dilewati ' + String(tabLabel || '') + ': ' + JSON.stringify(l1Snapshot));
}

/**
 * L1-A/L1-B/L1-D dapat memiliki jumlah baris berbeda. Snapshot ini hanya aktif
 * ketika DOM memang memiliki pasangan semantik Laba Rugi + Posisi Keuangan.
 * Karena bagian asli dikloning, font, warna, dan struktur Coretax tetap dipakai.
 */
async function setUpL1PrintSnapshot(page, tabLabel, metadata) {
    if (!/^L1-[A-Z0-9]+$/i.test(String(tabLabel || '').trim())) return { skipped: true, reason: 'not-l1-family' };
    const payload = { label: String(tabLabel || '').trim(), rootSelector: metadata && metadata.rootSelector };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
      document.getElementById('__ca_l1d_snapshot')?.remove();document.body.classList.remove('__ca_l1d_snapshot_active');
      const root=document.querySelector(p.rootSelector)||document.querySelector('rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return');
      if(!root)return{ok:false,reason:'root-not-found'};
      const all=Array.from(root.querySelectorAll('p-accordiontab'));
      const candidates=all.length?all:Array.from(root.querySelectorAll('.p-accordion-tab'));
      const heading=node=>clean(node.querySelector('.p-accordion-header')?.textContent).toUpperCase();
      const laba=candidates.find(node=>/^A\\.?\\s*LAPORAN LABA RUGI(?:\\s|$)/.test(heading(node)));
      const posisi=candidates.find(node=>/^B\\.?\\s*LAPORAN POSISI KEUANGAN(?:\\s|$)/.test(heading(node)));
      if(!laba||!posisi)return{ok:false,skipped:true,reason:'semantic-sections-not-found',headings:candidates.map(heading).filter(Boolean)};
      const syncControls=(source,clone)=>{
        const sources=source.querySelectorAll('input,textarea,select'),targets=clone.querySelectorAll('input,textarea,select');
        sources.forEach((control,index)=>{const target=targets[index];if(!target)return;target.value=control.value||'';target.setAttribute('value',control.value||'');if('checked'in control){target.checked=control.checked;if(control.checked)target.setAttribute('checked','');else target.removeAttribute('checked')}if(control.tagName==='SELECT')Array.from(target.options).forEach((option,i)=>option.selected=!!control.options[i]?.selected)});
      };
      const header=document.getElementById('__ca_print_header');if(!header)return{ok:false,reason:'header-not-found'};
      const snapshot=document.createElement('div');snapshot.id='__ca_l1d_snapshot';snapshot.dataset.caL1Variant=p.label.toUpperCase();
      const makePage=(source,kind)=>{
        const pageBox=document.createElement('section');pageBox.className='__ca_l1d_page __ca_l1d_page_'+kind;
        const headerCopy=header.cloneNode(true);headerCopy.removeAttribute('id');headerCopy.classList.add('__ca_print_header_clone');pageBox.appendChild(headerCopy);
        const section=source.cloneNode(true);syncControls(source,section);section.classList.add('__ca_l1d_section');pageBox.appendChild(section);
        const tables=Array.from(section.querySelectorAll('table.__ca_layout'));
        const density=Math.max(0,...tables.map(table=>table.rows.length));
        // Jangan mengecilkan seluruh L1 hanya agar tiap bagian muat satu lembar. Biarkan
        // Chrome memecah Laba Rugi/Neraca menjadi maksimal dua lembar dengan ukuran terbaca.
        const sizing=kind==='profit_loss'
          ?(density>42?{font:'8.15pt',head:'7.85pt',control:'23px',cellY:'3px',line:'1.1'}:{font:'8.5pt',head:'8.1pt',control:'24px',cellY:'3.5px',line:'1.12'})
          :(density>35?{font:'8.1pt',head:'7.8pt',control:'23px',cellY:'2px',line:'1.08'}:{font:'8.4pt',head:'8pt',control:'24px',cellY:'2.5px',line:'1.1'});
        pageBox.style.setProperty('--ca-l1d-font',sizing.font);pageBox.style.setProperty('--ca-l1d-head-font',sizing.head);pageBox.style.setProperty('--ca-l1d-control',sizing.control);pageBox.style.setProperty('--ca-l1d-cell-y',sizing.cellY);pageBox.style.setProperty('--ca-l1d-line',sizing.line);
        return{pageBox,section,density,sizing};
      };
      const first=makePage(laba,'profit_loss'),second=makePage(posisi,'balance');
      const totals=[];
      const balanceTables=Array.from(second.section.querySelectorAll('table.__ca_layout')).filter(table=>/Jumlah Aset|Jumlah Liabilitas dan Ekuitas/i.test(clean(table.textContent)));
      for(const table of balanceTables){
        const totalRow=Array.from(table.rows).find(row=>/Jumlah Aset|Jumlah Liabilitas dan Ekuitas/i.test(clean(row.textContent)));if(!totalRow)continue;
        const values=Array.from(totalRow.querySelectorAll('input,textarea,select')).map(control=>control.value||'');
        const footer=table.cloneNode(false);footer.classList.add('__ca_l1d_total_table');footer.removeAttribute('style');
        const layout=table.querySelector(':scope>colgroup[data-ca-layout]');if(layout)footer.appendChild(layout.cloneNode(true));
        const body=document.createElement('tbody');body.className=table.tBodies[0]?.className||'';body.appendChild(totalRow);footer.appendChild(body);
        let component=table.parentElement;while(component&&component!==second.section&&!(/^RSH-/.test(component.tagName)&&/GRID/.test(component.tagName)))component=component.parentElement;
        if(!component||component===second.section)component=table.parentElement;
        component.classList.add('__ca_l1d_balance_component');component.appendChild(footer);
        const column=component.closest('.col-md-6,.col-sm-6,.col-6');if(column){column.classList.add('__ca_l1d_balance_col');let host=component;while(host.parentElement&&host.parentElement!==column)host=host.parentElement;host.classList.add('__ca_l1d_balance_host');column.parentElement?.classList.add('__ca_l1d_balance_row')}
        totals.push({label:clean(totalRow.textContent),values});
      }
      const splitBalanced=(entry,threshold)=>{
        const primary=Array.from(entry.section.querySelectorAll('table.__ca_layout')).filter(table=>!table.classList.contains('__ca_l1d_total_table'));
        const density=Math.max(0,...primary.map(table=>Array.from(table.tBodies).reduce((sum,body)=>sum+body.rows.length,0)));
        if(density<=threshold)return[entry.pageBox];
        return[0,1].map(part=>{const box=entry.pageBox.cloneNode(true);for(const table of Array.from(box.querySelectorAll('table.__ca_layout'))){if(table.classList.contains('__ca_l1d_total_table')){if(part===0)table.remove();continue}for(const body of Array.from(table.tBodies)){const rows=Array.from(body.rows),cut=Math.ceil(rows.length/2);rows.forEach((row,index)=>{if(part===0?index>=cut:index<cut)row.remove()})}}return box});
      };
      const pages=[...splitBalanced(first,42),...splitBalanced(second,32)];snapshot.append(...pages);document.body.appendChild(snapshot);document.body.classList.add('__ca_l1d_snapshot_active');
      return{ok:true,variant:p.label.toUpperCase(),pages:pages.length,rows:{profitLoss:first.density,balance:second.density},sizing:{profitLoss:first.sizing,balance:second.sizing},totals};
    })()`).catch(error=>({ ok: false, reason: error.message }));
}

async function setUpTables(page, tabLabel, mode, taxTypeCode) {
    await page.evaluate(`(async()=>{
      const sleep=m=>new Promise(r=>setTimeout(r,m)),visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const monthlyFull=${JSON.stringify(mode)}==='full'&&['ICT_WIT','ICT_WT','VAT_VAT'].includes(${JSON.stringify(taxTypeCode || '')}),cap=monthlyFull?25:(${JSON.stringify(mode)}==='print'?(${JSON.stringify(TAB_ROW_CAP)}[${JSON.stringify(tabLabel)}]||${COMPACT_ROWS}):0);
      for(const dd of Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(visible)){try{if((dd.className||'').includes('p-disabled'))continue;dd.click();await sleep(300);const items=Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(visible);if(!items.length){document.body.click();continue}let pick=items.length-1;if(cap){let bi=-1,bv=-1;items.forEach((it,i)=>{const v=parseInt((it.textContent||'').replace(/[^\\d]/g,''),10);if(!isNaN(v)&&v<=cap&&v>bv){bi=i;bv=v}});pick=bi>=0?bi:0}items[pick].click();await sleep(500)}catch(e){}}
    })()`).catch(() => {});
}

async function printPdf(session, scale = PRINT_SCALE) {
    const r = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, scale });
    return trimTrailingBlankPages(Buffer.from(r.data, 'base64'));
}

async function printAdaptivePdf(session, scale = PRINT_SCALE, enabled = false) {
    let bestScale = Number(scale) || PRINT_SCALE;
    let best = await printPdf(session, bestScale);
    let bestPages = (await PDFDocument.load(best)).getPageCount();
    if (!enabled || bestPages <= 1) return best;
    // Coba rapatkan sedikit hanya bila sebuah state benar-benar mengurangi jumlah lembar.
    // Jika jumlah lembar tetap, kembalikan ukuran awal agar teks tidak diperkecil sia-sia.
    for (const factor of [0.96, 0.92, 0.88]) {
        const candidateScale = Math.max(0.8, (Number(scale) || PRINT_SCALE) * factor);
        if (candidateScale >= bestScale - 0.001) continue;
        const candidate = await printPdf(session, candidateScale);
        const pages = (await PDFDocument.load(candidate)).getPageCount();
        if (pages < bestPages) {
            best = candidate;
            bestPages = pages;
            bestScale = candidateScale;
            if (pages === 1) break;
        }
    }
    return best;
}

async function stampHeaderOnPdf(contentBuffer, headerBuffer, bandHeight = 78) {
    const content = await PDFDocument.load(contentBuffer);
    const header = await PDFDocument.load(headerBuffer);
    const output = await PDFDocument.create();
    const sourceHeader = header.getPage(0);
    const sourceSize = sourceHeader.getSize();
    const cropHeight = Math.min(bandHeight, sourceSize.height);
    for (const sourcePage of content.getPages()) {
        const size = sourcePage.getSize();
        const page = output.addPage([size.width, size.height]);
        const embeddedContent = await output.embedPage(sourcePage);
        const embeddedHeader = await output.embedPage(sourceHeader, {
            left: 0, bottom: sourceSize.height - cropHeight, right: sourceSize.width, top: sourceSize.height
        });
        const scale = (size.height - cropHeight) / size.height;
        const contentWidth = size.width * scale;
        page.drawPage(embeddedContent, { x: (size.width - contentWidth) / 2, y: 0,
            width: contentWidth, height: size.height - cropHeight });
        page.drawPage(embeddedHeader, { x: 0, y: size.height - cropHeight, width: size.width, height: cropHeight });
    }
    return Buffer.from(await output.save());
}

/**
 * PDF Induk PPN resmi Coretax kadang menyisipkan satu halaman tengah yang hanya
 * memuat kelanjutan satu baris form (contoh: "Nama Pemilik Rekening"). Halaman
 * tersebut tidak boleh langsung dihapus karena walaupun kosong pada sebagian SPT,
 * nilainya dapat terisi pada SPT lain. Lipat pita atas halaman yatim ke ruang yang
 * sengaja dibuat di bawah halaman sebelumnya, lalu pertahankan halaman berikutnya.
 *
 * Deteksi dibuat konservatif dan khusus dipanggil untuk VAT_VAT: hanya halaman
 * tengah tanpa gambar, stream sangat kecil, dan maksimal enam operasi teks.
 */
async function compactPpnOfficialIndukPdf(buffer, bandHeight = 52) {
    const source = await PDFDocument.load(buffer);
    if (source.getPageCount() < 3) return buffer;
    const sparse = new Set();
    for (let index = 1; index < source.getPageCount() - 1; index++) {
        const content = decodedPageContent(source, source.getPage(index));
        if (content === null) continue;
        const textOps = (content.match(/(?:^|\s)(?:Tj|TJ)(?=\s|$)/gm) || []).length;
        const images = (content.match(/(?:^|\s)Do(?=\s|$)/gm) || []).length;
        const paints = (content.match(/(?:^|\s)(?:f\*?|F|S|s|B\*?|b\*?)(?=\s|$)/gm) || []).length;
        if (content.length <= 4000 && textOps <= 6 && images === 0 && paints <= 24) sparse.add(index);
    }
    if (!sparse.size) return buffer;

    const output = await PDFDocument.create();
    for (let index = 0; index < source.getPageCount(); index++) {
        if (sparse.has(index)) continue;
        const nextIndex = index + 1;
        if (sparse.has(nextIndex)) {
            const page = source.getPage(index), size = page.getSize();
            const orphan = source.getPage(nextIndex), orphanSize = orphan.getSize();
            const band = Math.min(Number(bandHeight) || 52, size.height * 0.08, orphanSize.height);
            const target = output.addPage([size.width, size.height]);
            const main = await output.embedPage(page);
            const strip = await output.embedPage(orphan, {
                left: 0, bottom: orphanSize.height - band, right: orphanSize.width, top: orphanSize.height
            });
            target.drawPage(main, { x: 0, y: band, width: size.width, height: size.height - band });
            target.drawPage(strip, { x: 0, y: 0, width: size.width, height: band });
            index = nextIndex;
            continue;
        }
        const [copied] = await output.copyPages(source, [index]);
        output.addPage(copied);
    }
    return Buffer.from(await output.save());
}

function pageContentStreams(pdf, page) {
    const contents = page.node.Contents();
    if (!contents) return [];
    const refs = contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents];
    return refs.map((ref) => pdf.context.lookup(ref)).filter(Boolean);
}

function decodedPageContent(pdf, page) {
    const chunks = [];
    for (const stream of pageContentStreams(pdf, page)) {
        try {
            if (typeof stream.getUnencodedContents === 'function') {
                chunks.push(Buffer.from(stream.getUnencodedContents()));
            } else if (stream.dict && stream.contents) {
                chunks.push(Buffer.from(decodePDFRawStream(stream).decode()));
            } else if (stream.contents) {
                chunks.push(Buffer.from(stream.contents));
            }
        } catch (error) {
            // Jika stream tidak dapat didekode, anggap berisi agar halaman tidak terhapus.
            return null;
        }
    }
    return Buffer.concat(chunks).toString('latin1');
}

function pageHasVisibleMarks(pdf, page) {
    const content = decodedPageContent(pdf, page);
    if (content === null) return true;
    if (!content.trim()) return false;
    const hasOperator = (operators) => new RegExp(
        '(?:^|[\\s\\[\\]<>()\\/])(?:' + operators + ')(?=[\\s\\[\\]<>()\\/]|$)', 'm'
    ).test(content);
    // Teks, gambar, dan shading selalu dipertahankan, sekecil apa pun stream-nya.
    if (hasOperator('Tj|TJ|Do|BI|sh|[\'\"]')) return true;

    // Chromium membuat halaman ekstra yang hanya berisi bidang putih. Path tetap
    // dianalisis karena garis/diagram nonputih tanpa teks adalah konten yang sah.
    const tokens = content.replace(/%[^\r\n]*/g, ' ').match(/\S+/g) || [];
    const stateStack = [];
    let fillWhite = false; // warna default PDF adalah hitam
    let strokeWhite = false;
    let numbers = [];
    const values = (count) => numbers.slice(-count).map(Number);
    const allFinite = (items) => items.length > 0 && items.every(Number.isFinite);
    for (const token of tokens) {
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
            numbers.push(token);
            if (numbers.length > 8) numbers = numbers.slice(-8);
            continue;
        }
        if (token === 'q') stateStack.push({ fillWhite, strokeWhite });
        else if (token === 'Q') {
            const previous = stateStack.pop();
            if (previous) ({ fillWhite, strokeWhite } = previous);
        } else if (token === 'rg' || token === 'RG') {
            const color = values(3);
            const white = allFinite(color) && color.every((value) => value >= 0.999);
            if (token === 'rg') fillWhite = white; else strokeWhite = white;
        } else if (token === 'g' || token === 'G') {
            const color = values(1);
            const white = allFinite(color) && color[0] >= 0.999;
            if (token === 'g') fillWhite = white; else strokeWhite = white;
        } else if (token === 'k' || token === 'K') {
            const color = values(4);
            const white = allFinite(color) && color.every((value) => Math.abs(value) <= 0.001);
            if (token === 'k') fillWhite = white; else strokeWhite = white;
        } else if (token === 'sc' || token === 'scn') fillWhite = false;
        else if (token === 'SC' || token === 'SCN') strokeWhite = false;
        else if (/^(?:f\*?|F)$/.test(token) && !fillWhite) return true;
        else if (/^(?:S|s)$/.test(token) && !strokeWhite) return true;
        else if (/^(?:B\*?|b\*?)$/.test(token) && (!fillWhite || !strokeWhite)) return true;
        numbers = [];
    }
    return false;
}

async function trimTrailingBlankPages(buffer) {
    const pdf = await PDFDocument.load(buffer);
    const blankIndexes = [];
    for (let index = 0; index < pdf.getPageCount(); index++) {
        if (!pageHasVisibleMarks(pdf, pdf.getPage(index))) blankIndexes.push(index);
    }
    // Halaman kosong dapat muncul di awal atau di tengah ketika custom element Angular
    // dipindahkan utuh oleh mesin print Chrome. Buang semua halaman yang benar-benar tidak
    // memiliki mark terlihat, tetapi pertahankan satu halaman jika dokumennya seluruhnya kosong.
    if (blankIndexes.length >= pdf.getPageCount()) blankIndexes.splice(1);
    if (!blankIndexes.length) return buffer;
    for (const index of blankIndexes.sort((a, b) => b - a)) pdf.removePage(index);
    return Buffer.from(await pdf.save());
}

async function mergePdfs(buffers) {
    const out = await PDFDocument.create();
    for (const buf of buffers) {
        const src = await PDFDocument.load(buf);
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    return Buffer.from(await out.save());
}

async function detectYear(page, timeoutMs = 30000) {
    // Tab dapat muncul lebih dahulu daripada nilai form SPT. Jangan langsung
    // memakai tahun kalender karena akan menghasilkan folder/kop yang salah.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const values = await page.locator('[formcontrolname="TaxYear"],[formcontrolname="TaxPeriodYear"],[formcontrolname="PeriodYear"]')
            .evaluateAll((nodes) => nodes.map((node) => node.value || node.textContent || '')).catch(() => []);
        for (const value of values) {
            const match = String(value).match(/(?:19|20)\d{2}/);
            if (match) return match[0];
        }
        const text = await page.locator('body').innerText().catch(() => '');
        const textMatch = text.match(/(?:Tahun Pajak|Tax Year)[^\d]*((?:19|20)\d{2})/i);
        if (textMatch) return textMatch[1];
        await page.waitForTimeout(300);
    }
    // Jangan pernah menebak tahun berjalan. Pada SPT lama, fallback tersebut membuat kop dan
    // nama file tampak sah tetapi salah tahun ketika Angular terlambat mengisi TaxYear.
    return '';
}

async function detectTaxPeriod(page, config) {
    const year = await detectYear(page, config.annual ? 60000 : 10000);
    if (config.annual) {
        if (!year) throw new Error('Tahun Pajak belum tersedia di halaman Coretax. Tunggu form selesai dimuat lalu coba lagi.');
        return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
    }
    const names = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const compact = await page.locator('[formcontrolname="Period"],[formcontrolname="TaxPeriodYear"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    const compactMatch = String(compact).match(/^(0?[1-9]|1[0-2])(\d{4})$/);
    if (compactMatch) {
        const month = names[Number(compactMatch[1]) - 1];
        return { year: compactMatch[2], fileLabel: month + ' ' + compactMatch[2], headerLabel: 'Masa Pajak ' + month + ' ' + compactMatch[2] };
    }
    const monthValue = await page.locator('[formcontrolname="TaxPeriodMonth"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    const yearValue = await page.locator('[formcontrolname="TaxPeriodYear"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    if (/^(?:[1-9]|1[0-2])$/.test(monthValue) && /^\d{4}$/.test(yearValue)) {
        const month = names[Number(monthValue) - 1];
        return { year: yearValue, fileLabel: month + ' ' + yearValue, headerLabel: 'Masa Pajak ' + month + ' ' + yearValue };
    }
    const text = await page.locator('body').innerText().catch(() => '');
    const months = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember';
    const match = text.match(new RegExp('Masa Pajak\\s*(' + months + ')\\s*(\\d{4})', 'i'));
    if (match) {
        const month = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        return { year: match[2], fileLabel: month + ' ' + match[2], headerLabel: 'Masa Pajak ' + month + ' ' + match[2] };
    }
    const urlDate = page.url().match(/\/(\d{2})(\d{2})(\d{4})\//);
    if (urlDate) {
        const month = names[Math.max(0, Math.min(11, Number(urlDate[2]) - 1))];
        return { year: urlDate[3], fileLabel: month + ' ' + urlDate[3], headerLabel: 'Masa Pajak ' + month + ' ' + urlDate[3] };
    }
    const fallbackYear = year || String(new Date().getFullYear());
    return { year: fallbackYear, fileLabel: fallbackYear, headerLabel: 'Tahun ' + fallbackYear };
}

async function resetPaginators(page) {
    const count = await page.evaluate(`(()=>{let n=0;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};for(const p of Array.from(document.querySelectorAll('.p-paginator')).filter(visible)){const b=p.querySelector('.p-paginator-first');if(b&&!b.disabled&&!b.classList.contains('p-disabled')){b.click();n++}}return n})()`).catch(() => 0);
    if (count) await page.waitForTimeout(700);
}

async function paginatorIds(page) {
    return page.evaluate(`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      // Angular mempertahankan panel tab lama di DOM. ID dari tab sebelumnya harus dibuang
      // agar locator tidak menekan paginator tersembunyi yang kebetulan memiliki ID sama.
      document.querySelectorAll('[data-ca-paginator-id]').forEach(node=>node.removeAttribute('data-ca-paginator-id'));
      document.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{node.removeAttribute('data-ca-paginator-owner-id');node.classList.remove('__ca_paginator_owner_hidden')});
      document.querySelectorAll('.__ca_paginator_owner_mode').forEach(node=>node.classList.remove('__ca_paginator_owner_mode'));
      let n=0;return Array.from(document.querySelectorAll('.p-paginator')).filter(visible).map(p=>{const text=(p.textContent||'').replace(/\\s+/g,' ').trim(),m=text.match(/(?:of|dari)\\s+([\\d.,]+)\\s+(?:entries|entri)/i),total=m?parseInt(m[1].replace(/[.,]/g,''),10):0,id=String(n++),owner=p.closest('p-table')||p.closest('.p-datatable')||p.parentElement;p.dataset.caPaginatorId=id;if(owner)owner.dataset.caPaginatorOwnerId=id;return{id,total,text}}).filter(x=>x.total>0)})()`).catch(() => []);
}

async function setActivePaginatorOwner(page, rootSelector, activeId) {
    return page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(rootSelector || '')})||document.body,active=${JSON.stringify(String(activeId))},owners=Array.from(root.querySelectorAll('[data-ca-paginator-owner-id]'));if(!owners.length)return{ok:false,reason:'owner-not-found'};root.classList.add('__ca_paginator_owner_mode');for(const owner of owners)owner.classList.toggle('__ca_paginator_owner_hidden',owner.dataset.caPaginatorOwnerId!==active);window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot();return{ok:true,owners:owners.length,active}})()`).catch(error=>({ok:false,reason:error.message}));
}

async function clearPaginatorOwners(page, rootSelector) {
    await page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(rootSelector || '')})||document.body;root.classList.remove('__ca_paginator_owner_mode');root.querySelectorAll('.__ca_paginator_owner_hidden').forEach(owner=>owner.classList.remove('__ca_paginator_owner_hidden'));root.querySelectorAll('[data-ca-paginator-id]').forEach(node=>node.removeAttribute('data-ca-paginator-id'));root.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>node.removeAttribute('data-ca-paginator-owner-id'));window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()})()`).catch(() => {});
}

async function replaceAnnualSnapshotRows(page, rootSelector, items) {
    const payload = { rootSelector, items };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=value=>String(value??'').replace(/\\s+/g,' ').trim(),upper=value=>clean(value).toUpperCase();
      const visible=node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
      const source=document.querySelector(p.rootSelector);if(!source)return{ok:false,reason:'root-not-found'};
      source.querySelectorAll('[data-ca-annual-table-index]').forEach(node=>node.removeAttribute('data-ca-annual-table-index'));
      const sourceOwners=Array.from(source.querySelectorAll('p-table')).filter(visible);sourceOwners.forEach((owner,index)=>owner.dataset.caAnnualTableIndex=String(index));
      source.querySelectorAll('[data-ca-annual-active-panel]').forEach(node=>node.removeAttribute('data-ca-annual-active-panel'));const activePanel=Array.from(source.querySelectorAll('.p-tabview-panel')).find(visible);if(activePanel)activePanel.dataset.caAnnualActivePanel='1';
      const sync=(a,b)=>{const left=a.querySelectorAll('input,textarea,select'),right=b.querySelectorAll('input,textarea,select');left.forEach((control,index)=>{const target=right[index];if(!target)return;target.value=control.value||'';target.setAttribute('value',control.value||'');if('checked'in control){target.checked=control.checked;target.toggleAttribute('checked',!!control.checked)}if(control.tagName==='SELECT')Array.from(target.options).forEach((option,i)=>option.selected=!!control.options[i]?.selected)})};
      document.getElementById('__ca_annual_snapshot')?.remove();const snapshot=document.createElement('div');snapshot.id='__ca_annual_snapshot';const root=source.cloneNode(true);sync(source,root);const header=document.getElementById('__ca_print_header');let headerCopy=null;if(header){headerCopy=header.cloneNode(true);headerCopy.removeAttribute('id');headerCopy.classList.add('__ca_print_header_clone')}source.querySelectorAll('[data-ca-annual-active-panel]').forEach(node=>node.removeAttribute('data-ca-annual-active-panel'));snapshot.appendChild(root);if(headerCopy)snapshot.prepend(headerCopy);document.body.appendChild(snapshot);document.body.classList.add('__ca_annual_snapshot_active');
      const date=value=>{const match=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return match?match[3]+'-'+match[2]+'-'+match[1]:clean(value)};
      const monthYear=value=>{const match=clean(value).match(/^(\\d{4})-(\\d{2})/);return match?match[2]+'-'+match[1]:clean(value)};
      const number=value=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:0,maximumFractionDigits:2});
      const mapped=(heading,row,index,endpoint)=>{const h=upper(heading),ep=String(endpoint||'').toLowerCase();
        if(/^TINDAKAN$|^ACTION$/.test(h))return['',true];if(/^NO\\.?$/.test(h))return[index+1,true];if(/^KODE$/.test(h))return[row.Code,true];if(/^DESKRIPSI$/.test(h))return[row.Description,true];if(/^KETERANGAN$/.test(h))return[row.Remark??row.Notes,true];
        if(ep.includes('l3-table-b-grid')){if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/NPWP.*PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/JENIS PAJAK/.test(h))return[row.TaxType,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/PPH YANG DIPOTONG\\/DIPUNGUT/.test(h))return[row.IncomeTax,true];if(/BUKTI POTONG.*NOMOR/.test(h))return[row.WithholdingSlipsNumber,true];if(/BUKTI POTONG.*TANGGAL/.test(h))return[row.WithholdingSlipsDate,true]}
        if(ep.includes('l4-table-a-grid')){if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];if(/^OBJEK PAJAK$/.test(h))return[row.TaxObject,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/TINGKAT/.test(h))return[row.TaxRate,true];if(/PPH FINAL TERUTANG/.test(h))return[row.IncomeTax,true]}
        if(/l9-table-[123]-grid/.test(ep)){if(/KODE HARTA/.test(h))return[clean(row.CodeOfAsset)?row.CodeOfAsset:row.GroupAssetType,true];if(/KELOMPOK\\/JENIS HARTA/.test(h))return[row.GroupAssetType,true];if(/BULAN\\/TAHUN PEROLEHAN/.test(h))return[monthYear(row.MonthYearAcquisition),true];if(/BIAYA PEROLEHAN/.test(h))return[row.AcquisitionPrice,true];if(/NILAI SISA BUKU/.test(h))return[row.RemainingBeginningValue,true];if(/(?:METODE|PILIH).*KOMERSIAL|^KOMERSIAL$/.test(h))return[row.MethodCommercial,true];if(/(?:METODE|PILIH).*FISKAL|^FISKAL$/.test(h))return[row.MethodFiscal,true];if(/PENYUSUTAN\\/AMORTISASI FISKAL TAHUN INI/.test(h))return[row.FiscalYearValue,true]}
        if(ep.includes('l1-table-a1-grid')){if(/NOMOR AKUN/.test(h))return[row.AccountNumber,true];if(/ATAS NAMA/.test(h))return[row.OnBehalfOf,true];if(/NAMA BANK\\/INSTITUSI/.test(h))return[row.BankInstitutionName,true];if(/LOKASI HARTA/.test(h))return[row.CountryLocated,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/^SALDO$/.test(h))return[row.Balance,true]}
        if(ep.includes('l1-table-a2-grid')){if(/LOKASI PENERIMA PINJAMAN/.test(h))return[row.CountryRecipient,true];if(/NIK\\/NPWP PENERIMA PINJAMAN/.test(h))return[row.TinOfRecipient,true];if(/NAMA PENERIMA PINJAMAN/.test(h))return[row.NameOfRecipient,true];if(/TAHUN DIMULAI/.test(h))return[row.YearOfReceivable,true];if(/NILAI PIUTANG/.test(h))return[row.ReceivableValue,true];if(/SALDO PIUTANG/.test(h))return[row.CurrentBalance,true]}
        if(ep.includes('l1-table-a3-grid')){if(/LOKASI HARTA/.test(h))return[row.CountryLocated,true];if(/NPWP BANK\\/INSTITUSI\\/PENERIMA INVESTASI/.test(h))return[row.TinOfRecipient,true];if(/NAMA BANK\\/INSTITUSI\\/PENERIMA INVESTASI/.test(h))return[row.NameOfRecipient,true];if(/NOMOR AKUN/.test(h))return[row.AccountNumber,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance,true]}
        if(ep.includes('l1-table-a4-grid')){if(/^TIPE$/.test(h))return[row.Type??row.Description,true];if(/MERK\\/MODEL/.test(h))return[row.BrandModel,true];if(/NOMOR POLISI\\/REGISTRASI/.test(h))return[row.RegistrationNumber,true];if(/^KEPEMILIKAN$/.test(h))return[row.Ownership,true];if(/NIK\\/NPWP PEMILIK/.test(h))return[row.OwnerTIN,true];if(/NAMA PEMILIK/.test(h))return[row.OwnerName,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance??row.FairMarketValue,true]}
        if(ep.includes('l1-table-a5-grid')){if(/LOKASI HARTA/.test(h))return[row.LocationOfAsset,true];if(/UKURAN PROPERTI - TANAH/.test(h))return[row.PropertyTypeLand,true];if(/UKURAN PROPERTI - BANGUNAN/.test(h))return[row.PropertyTypeBuilding,true];if(/SUMBER KEPEMILIKAN/.test(h))return[row.SourceOfOwnership,true];if(/NOMOR SERTIFIKAT/.test(h))return[row.CertificateNumber,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.FairMarketValue,true]}
        if(ep.includes('l1-table-a6-grid')){if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/BUKTI KEPEMILIKAN|NOMOR AKUN/.test(h))return[row.OwnershipEvidence??row.AccountNumber,true];if(/INFORMASI TAMBAHAN/.test(h))return[row.AdditionalInformation,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance??row.FairMarketValue,true]}
        if(ep.includes('l1-table-d-grid')){if(/NAMA PEMBERI KERJA/.test(h))return[row.NameOfEmployer,true];if(/NOMOR IDENTITAS PEMBERI KERJA/.test(h))return[row.TinOfEmployer,true];if(/^PENGHASILAN BRUTO$/.test(h))return[row.GrossIncome,true];if(/PENGURANG PENGHASILAN BRUTO/.test(h))return[row.DeductionOfGrossIncome,true];if(/PENGHASILAN NETO/.test(h))return[row.NetIncome,true]}
        if(ep.includes('l1-table-e-grid')){if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.TaxpayerName,true];if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NOMOR BUKTI/.test(h))return[row.WithholdingSlipNumber,true];if(/TANGGAL BUKTI/.test(h))return[row.WithholdingSlipsDate,true];if(/JENIS PAJAK/.test(h))return[row.TaxType,true];if(/PENGHASILAN BRUTO/.test(h))return[row.TaxBase,true];if(/PPh YANG DIPOTONG\\/DIPUNGUT/i.test(h))return[row.IncomeTax,true]}
        if(ep.includes('l2-table-a-grid')){if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];if(/JENIS PENGHASILAN/.test(h))return[row.TaxObject,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/PPh TERUTANG/i.test(h))return[row.WithholdingTax,true]}
        return['',false]};
      const cellText=cell=>{const clone=cell.cloneNode(true);clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach(node=>node.remove());return clean(clone.textContent)};
      const put=(cell,value)=>{let text=clean(value);if(typeof value==='number')text=number(value);else if(/^\\d{4}-\\d{2}-\\d{2}/.test(text))text=date(text);else if(text==='IDN')text='Indonesia';else if(text==='ARTICLE21')text='Pasal 21';
        // Clone kontrol Angular tidak lagi memiliki change detection. Nilai properti value dapat
        // terlihat di DOM tetapi kosong saat dicetak, jadi isi baris tambahan dibuat statis.
        const mobile=Array.from(cell.querySelectorAll('.p-column-title,[class*="column-title" i]')).map(node=>node.cloneNode(true));cell.replaceChildren(...mobile,document.createTextNode(text));return text};
      const results=[],usedOwners=new Set();
      for(const item of p.items){const regex=new RegExp(item.signature,'i'),owners=Array.from(root.querySelectorAll('p-table[data-ca-annual-table-index]'));let selected=null;
        for(const owner of owners){if(usedOwners.has(owner))continue;if(Number.isInteger(item.tableIndex)&&Number(owner.dataset.caAnnualTableIndex)!==item.tableIndex)continue;const table=owner.querySelector('table');if(!table?.tHead)continue;const rows=Array.from(table.tHead.rows),head=rows.sort((a,b)=>b.cells.length-a.cells.length)[0],signature=clean(table.tHead.textContent);if(regex.test(signature)){selected={owner,table,head};usedOwners.add(owner);break}}
        if(!selected){if(item.total>0)return{ok:false,reason:'table-not-found',endpoint:item.endpoint,signature:item.signature};results.push({endpoint:item.endpoint,total:item.total,visible:0,appended:0});continue}
        const headerRow=Array.from(selected.head.cells).map(cell=>clean(cell.textContent)),body=selected.table.tBodies[0],existing=Array.from(body?.rows||[]).filter(row=>!/TIDAK ADA DATA|NO RECORDS?/i.test(clean(row.textContent)));
        // Tabel L9 memakai header bertingkat dan satu baris filter dengan sembilan sel.
        // Baris filter itulah yang memiliki jumlah sel terbanyak, tetapi sebagian besar
        // judulnya kosong. PrimeNG menaruh judul daun yang benar di .p-column-title pada
        // setiap sel data; gunakan itu sebagai sumber utama agar tanggal, angka, kode,
        // serta keterangan tidak dipetakan sebagai kolom tanpa nama lalu dikosongkan.
        const headers=existing[0]&&existing[0].cells.length===headerRow.length
          ? Array.from(existing[0].cells).map((cell,index)=>clean(cell.querySelector('.p-column-title,[class*="column-title" i]')?.textContent)||headerRow[index]||'')
          : headerRow;
        const unmapped=headers.filter(header=>header&&!mapped(header,item.rows[0]||{},0,item.endpoint)[1]);if(unmapped.length&&item.total>existing.length)return{ok:false,reason:'unmapped-headers',endpoint:item.endpoint,unmapped};
        const lookups=headers.map(()=>new Map());for(let index=0;index<Math.min(existing.length,item.rows.length);index++){headers.forEach((header,column)=>{const raw=mapped(header,item.rows[index],index,item.endpoint)[0],shown=cellText(existing[index].cells[column]);if(clean(raw)&&shown)lookups[column].set(clean(raw),shown)})}
        const fallbackTemplate=existing[existing.length-1]||body?.rows?.[0];if(item.rows.length&&!fallbackTemplate)return{ok:false,reason:'row-template-not-found',endpoint:item.endpoint};
        const replacement=body.cloneNode(false),isNumeric=header=>/DASAR PENGENAAN|PENGHASILAN BRUTO|(?:^| )PPH(?: |$)|NILAI|BIAYA|JUMLAH|TINGKAT|PENYUSUTAN|HARGA|SALDO/i.test(header),isCentered=header=>/^(?:NO[.]?|KODE|KOMERSIAL|FISKAL)$|NPWP|NIK|JENIS PAJAK|KODE (?:OBJEK|HARTA)|BUKTI POTONG.*(?:NOMOR|TANGGAL)|BULAN[^A-Z0-9]TAHUN|METODE|PILIH (?:KOMERSIAL|FISKAL)/i.test(header);
        for(let index=0;index<item.rows.length;index++){const template=existing[Math.min(index,Math.max(0,existing.length-1))]||fallbackTemplate,row=template.cloneNode(true);if(row.cells.length!==headers.length)return{ok:false,reason:'column-count-mismatch',endpoint:item.endpoint,row:index,expected:headers.length,actual:row.cells.length};let expectedValues=0,printedValues=0;headers.forEach((header,column)=>{const result=mapped(header,item.rows[index],index,item.endpoint);let value=result[0],known=lookups[column].get(clean(value));if(known)value=known;if(result[1]&&clean(value)!=='')expectedValues++;const cell=row.cells[column],printed=put(cell,value);cell.classList.toggle('__ca_numeric',isNumeric(header));cell.classList.toggle('__ca_center',!isNumeric(header)&&isCentered(header));if(result[1]&&clean(printed)!=='')printedValues++});if(printedValues!==expectedValues)return{ok:false,reason:'static-value-mismatch',endpoint:item.endpoint,row:index,expectedValues,printedValues};replacement.appendChild(row)}
        body.replaceWith(replacement);const finalRows=Array.from(replacement.rows||[]).filter(row=>!/TIDAK ADA DATA|NO RECORDS?/i.test(clean(row.textContent))).length;if(finalRows!==item.total)return{ok:false,reason:'row-count-mismatch',endpoint:item.endpoint,expected:item.total,actual:finalRows};
        results.push({endpoint:item.endpoint,total:item.total,visible:existing.length,appended:Math.max(0,item.total-existing.length),staticRows:finalRows,headers})}
      return{ok:true,tables:results};
    })()`).catch(error=>({ ok: false, reason: error.message }));
}

async function printAnnualApiPages(page, session, taxTypeCode, tabLabel, rootSelector, printScale) {
    const mappings = ANNUAL_API_GRIDS[taxTypeCode] && ANNUAL_API_GRIDS[taxTypeCode][tabLabel];
    if (!mappings) return null;
    const variants = returnsheetGridApi.dataRequestVariants(page.context());
    const available = new Set(variants.map((request) => request.pathname));
    const active = mappings.filter((mapping) => Array.from(available).some((pathname) => pathname.endsWith(mapping.suffix)));
    if (!active.length) return null;
    const items = [];
    for (const mapping of active) {
        if (mapping.allVariants) {
            const matched = variants.filter((request) => request.pathname.endsWith(mapping.suffix));
            for (let index = 0; index < matched.length; index++) {
                const grid = await returnsheetGridApi.fetchAllRowsFromRequest(page, matched[index]);
                if (grid.total > 0) items.push({ ...mapping, tableIndex: mapping.tableIndexOffset + index,
                    endpoint: grid.endpoint, total: grid.total, rows: grid.rows });
            }
        } else {
            const grid = await returnsheetGridApi.fetchAllRows(page, mapping.suffix);
            items.push({ ...mapping, endpoint: grid.endpoint, total: grid.total, rows: grid.rows });
        }
    }
    if (!items.length) return null;
    const rendered = await replaceAnnualSnapshotRows(page, rootSelector, items);
    if (!rendered || !rendered.ok) throw new Error('Renderer API tahunan ' + tabLabel + ' gagal: ' + JSON.stringify(rendered));
    for (const table of rendered.tables) log('[Lampiran API tahunan] ' + tabLabel + ': ' + table.total + '/' + table.total + ' baris dari ' + table.endpoint + ' (tambahan ' + table.appended + ').');
    await page.evaluate(`(()=>{document.getElementById('__ca_annual_page_style')?.remove();const style=document.createElement('style');style.id='__ca_annual_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_annual_header_only #__ca_annual_snapshot>*:not(.__ca_print_header_clone){display:none!important}body.__ca_annual_header_only #__ca_annual_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_annual_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_header_only');const style=document.getElementById('__ca_annual_page_style');if(style)style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}body.__ca_annual_snapshot_active #__ca_annual_snapshot .__ca_print_header_clone{display:none!important}body.__ca_annual_snapshot_active #__ca_annual_snapshot table tfoot{display:table-row-group!important}}'})()`);
        const contentBuffer = await printPdf(session, printScale);
        return [await stampHeaderOnPdf(contentBuffer, headerBuffer)];
    }
    finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_header_only');document.getElementById('__ca_annual_page_style')?.remove();document.getElementById('__ca_annual_snapshot')?.remove();document.body.classList.remove('__ca_annual_snapshot_active');document.querySelectorAll('[data-ca-annual-table-index]').forEach(node=>node.removeAttribute('data-ca-annual-table-index'))})()`).catch(() => {});
    }
}

async function printL1SnapshotPages(page, session, printScale) {
    const pageCount = await page.locator('#__ca_l1d_snapshot .__ca_l1d_page').count();
    if (!pageCount) return [await printPdf(session, printScale)];
    const buffers = [];
    await page.evaluate(`(()=>{document.getElementById('__ca_l1d_single_page_style')?.remove();const style=document.createElement('style');style.id='__ca_l1d_single_page_style';document.head.appendChild(style);document.body.classList.add('__ca_l1d_single_page')})()`);
    try {
        for (let index = 0; index < pageCount; index++) {
            await page.evaluate(`(()=>{document.querySelectorAll('#__ca_l1d_snapshot .__ca_l1d_page').forEach((node,i)=>{if(i===${index})node.dataset.caPrintActive='1';else node.removeAttribute('data-ca-print-active')})})()`);
            await page.evaluate(`(()=>{const style=document.getElementById('__ca_l1d_single_page_style');style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page{display:none!important;break-after:auto!important;page-break-after:auto!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page[data-ca-print-active="1"]{display:block!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_section{display:none!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}'})()`);
            const headerBuffer = await printPdf(session, 1);
            await page.evaluate(`(()=>{const style=document.getElementById('__ca_l1d_single_page_style');style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page{display:none!important;break-after:auto!important;page-break-after:auto!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page[data-ca-print-active="1"]{display:block!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_print_header_clone{display:none!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_section{display:block!important;break-inside:auto!important;page-break-inside:auto!important;padding-top:2mm!important}body.__ca_l1d_single_page #__ca_l1d_snapshot table thead{display:table-header-group!important}body.__ca_l1d_single_page #__ca_l1d_snapshot table tbody tr{break-inside:avoid!important;page-break-inside:avoid!important}}'})()`);
            let scale = Math.max(Number(printScale) || PRINT_SCALE, 0.88);
            let buffer = await printPdf(session, scale);
            let physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            if (physicalPages === 2) {
                // Cegah halaman kedua yang hanya berisi beberapa baris. Gunakan satu lembar
                // hanya bila penurunan moderat benar-benar membuat seluruh bagian muat.
                for (const factor of [0.96, 0.92, 0.88]) {
                    const candidateScale = Math.max(0.8, (Number(printScale) || PRINT_SCALE) * factor);
                    const candidate = await printPdf(session, candidateScale);
                    const candidatePages = (await PDFDocument.load(candidate)).getPageCount();
                    if (candidatePages === 1) {
                        scale = candidateScale;
                        buffer = candidate;
                        physicalPages = 1;
                        break;
                    }
                }
            }
            // Satu bagian semantik boleh memakai dua lembar. Turunkan sedikit hanya bila
            // melebihi batas itu; jangan lagi merampingkan L1 sampai sulit dibaca.
            for (let attempt = 0; physicalPages > 2 && attempt < 3; attempt++) {
                scale = Math.max(0.78, scale * 0.94);
                buffer = await printPdf(session, scale);
                physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            }
            if (physicalPages < 1 || physicalPages > 2) throw new Error('Snapshot L1 bagian ' + (index + 1) + ' menghasilkan ' + physicalPages + ' halaman fisik; batasnya 1-2.');
            buffers.push(await stampHeaderOnPdf(buffer, headerBuffer));
        }
        return buffers;
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_l1d_single_page');document.getElementById('__ca_l1d_single_page_style')?.remove();document.querySelectorAll('#__ca_l1d_snapshot .__ca_l1d_page').forEach(node=>node.removeAttribute('data-ca-print-active'))})()`).catch(() => {});
    }
}

async function printAnnualDomPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale) {
    const ownsL1Pages = await page.evaluate(`document.body.classList.contains('__ca_l1d_snapshot_active')`).catch(() => false);
    if (ownsL1Pages) return printL1SnapshotPages(page, session, printScale);
    await page.evaluate(`(()=>{document.getElementById('__ca_annual_dom_page_style')?.remove();const style=document.createElement('style');style.id='__ca_annual_dom_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_annual_dom_header_only>*:not(#__ca_print_header){display:none!important}body.__ca_annual_dom_header_only #__ca_print_header{display:grid!important;position:static!important;margin:0 8mm!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_annual_dom_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_dom_header_only');const style=document.getElementById('__ca_annual_dom_page_style');if(style)style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}#__ca_print_header{display:none!important}table tfoot{display:table-row-group!important}}'})()`);
        const buffers = await printPaginatorPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale, true);
        return Promise.all(buffers.map((buffer) => stampHeaderOnPdf(buffer, headerBuffer)));
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_dom_header_only');document.getElementById('__ca_annual_dom_page_style')?.remove()})()`).catch(() => {});
    }
}

/** Cetak fallback DOM PPN tanpa menggantungkan kop pada aliran halaman Chromium.
 * Kop dicetak sekali sebagai pita vektor, isi dicetak tanpa kop, lalu pita tersebut
 * distempel ke setiap halaman fisik. Ini terutama menangani INDUK yang tidak punya
 * paginator tetapi dapat mengalir ke dua atau tiga halaman. */
async function printPpnDomPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale, tabLabel) {
    await page.evaluate(`(()=>{document.getElementById('__ca_ppn_dom_page_style')?.remove();const style=document.createElement('style');style.id='__ca_ppn_dom_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_ppn_header_only #__ca_repeat_snapshot>*:not(.__ca_print_header_clone){display:none!important}body.__ca_ppn_header_only #__ca_repeat_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_ppn_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_ppn_header_only');const style=document.getElementById('__ca_ppn_dom_page_style');if(style)style.textContent='@media print{#__ca_print_header,#__ca_repeat_snapshot .__ca_print_header_clone{display:none!important}#__ca_repeat_snapshot .__ca_repeat_page_header{break-before:auto!important;page-break-before:auto!important}}'})()`);
        const buffers = await printPaginatorPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector,
            printScale, String(tabLabel || '').toUpperCase() === 'INDUK');
        return Promise.all(buffers.map((buffer) => stampHeaderOnPdf(buffer, headerBuffer)));
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_ppn_header_only');document.getElementById('__ca_ppn_dom_page_style')?.remove()})()`).catch(() => {});
    }
}

async function replacePph21SnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tHead.rows[0]?.cells.length||0)-(a.tHead.rows[0]?.cells.length||0))[0];if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0],headers=Array.from(headerRow.cells).map(cell=>clean(cell.textContent));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const date=value=>{const m=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:clean(value)};
      const number=(value,digits=0)=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:digits,maximumFractionDigits:digits});
      const title=value=>clean(value).toLowerCase().replace(/(^|\\s)\\S/g,char=>char.toUpperCase());
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true];
        if(/NIK\\/NPWP|NOMOR IDENTITAS/.test(h))return[row.TIN??row.Tin,true];
        if(/^NAMA$|NAMA PEMOTONG|NAMA PENERIMA/.test(h))return[row.Name,true];
        if(/JENIS PAJAK/.test(h))return[row.TaxArticle,true];
        if(/NOMOR BUKTI POTONG/.test(h))return[row.WithholdingSlipsNumber??row.WithholdingNumber,true];
        if(/TANGGAL BUKTI PEMOTONGAN/.test(h))return[date(row.WithholdingSlipsDate??row.WithholdingDate),true];
        if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];
        if(/OBJEK PAJAK/.test(h))return[row.TaxObject,true];
        if(/PENGHASILAN BRUTO/.test(h))return[number(row.GrossIncome),true];
        if(/TARIF PAJAK/.test(h))return[number(row.TaxRate,2),true];
        if(/PAJAK PENGHASILAN/.test(h))return[number(row.IncomeTax),true];
        if(/FASILITAS PERPAJAKAN/.test(h)){const value=clean(row.TaxCertificate);return[value==='9'?'Tanpa Fasilitas':value,true]}
        if(/^NEGARA$/.test(h)){const value=clean(row.CountryCode);return[value==='IDN'?'Indonesia':value,true]}
        if(/MASA PE+ROLEHAN PENGHASILAN/.test(h))return[row.IncomePeriod??[row.IncomePeriodStart,row.IncomePeriodEnd].filter(Boolean).join(' - '),true];
        if(/ID TEMPAT KEGIATAN USAHA|NITKU/.test(h))return[row.PlaceOfBusinessID,true];
        if(/KAP-KJS/.test(h))return[row.RevenueCode,true];
        if(/^STATUS$/.test(h))return[title(row.Status),true];
        return['',false]};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';headers.forEach((header,column)=>{const td=document.createElement('td');td.className=classes[column]||'';td.textContent=clean(mapped(header,row,index)[0]);tr.appendChild(td)});body.appendChild(tr)});
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printAdaptiveApiGrid(page, session, printScale, options) {
    const allRows = options.rows || [];
    const maxRows = Math.max(1, Number(options.maxRows) || 25);
    let preferredRows = maxRows;
    const buffers = [];
    for (let offset = 0; offset < allRows.length;) {
        let count = Math.min(preferredRows, allRows.length - offset);
        let accepted = null;
        while (count >= 1) {
            await page.evaluate(`window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()`).catch(() => {});
            const chunk = allRows.slice(offset, offset + count);
            const finalChunk = !!options.isLastGrid && offset + count >= allRows.length;
            const rendered = await options.render(chunk, offset, finalChunk);
            if (!rendered || !rendered.ok) throw new Error(options.errorLabel + ' gagal: ' + JSON.stringify(rendered));
            const buffer = await printPdf(session, printScale);
            const physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            if (physicalPages === 1) {
                accepted = buffer;
                preferredRows = Math.min(preferredRows, count);
                break;
            }
            if (count === 1) {
                throw new Error(options.errorLabel + ' masih menghasilkan ' + physicalPages + ' halaman fisik untuk satu baris.');
            }
            count--;
        }
        buffers.push(accepted);
        offset += count;
    }
    return buffers;
}

async function printPph21ApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = PPH21_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API ' + tabLabel,
            render: (rows, offset, finalChunk) => replacePph21SnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk)
        }));
        log('[Lampiran API] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

async function replaceUnifikasiSnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk, totals) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk, totals: totals || null };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      snapshot.querySelectorAll('table.__ca_sibling_empty_table').forEach(table=>{const section=table.closest('p-accordiontab,.p-accordion-tab,p-fieldset,.p-fieldset,p-panel,.p-panel')||table.parentElement;if(section&&!section.contains(owner))section.style.setProperty('display','none','important')});
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tHead.rows[0]?.cells.length||0)-(a.tHead.rows[0]?.cells.length||0))[0];if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0],headers=Array.from(headerRow.cells).map(cell=>clean(cell.textContent));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const date=value=>{const m=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:clean(value)};
      const number=(value,digits=0)=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:digits,maximumFractionDigits:digits});
      const title=value=>clean(value).toLowerCase().replace(/(^|\\s)\\S/g,char=>char.toUpperCase());
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true];
        if(/NIK\\/NPWP PENERIMA/.test(h))return[row.RecipientIdentificationNumber??row.TaxIdentificationNumber,true];
        if(/NAMA PENERIMA/.test(h))return[row.RecipientName??row.TaxpayerName,true];
        if(/IDENTITAS AKUN PENERIMA/.test(h))return[row.RecipientAccountId??row.RecipientAccountIdentifier??row.RecipientAccountID,true];
        if(/NIK\\/NPWP PEMBERI/.test(h))return[row.GiverIdentificationNumber??row.PayerIdentificationNumber,true];
        if(/NAMA PEMBERI/.test(h))return[row.GiverName??row.PayerName,true];
        if(/IDENTITAS AKUN PEMBERI/.test(h))return[row.GiverAccountId??row.PayerAccountIdentifier??row.PayerAccountID,true];
        if(/^NIK\\/NPWP$/.test(h))return[row.TaxIdentificationNumber,true];
        if(/^NAMA$/.test(h))return[row.TaxpayerName,true];
        if(/NOMOR BUKTI POTONG/.test(h))return[row.WithholdingSlipsNumber,true];
        if(/TANGGAL BUKTI POTONG/.test(h))return[date(row.WithholdingSlipsDate),true];
        if(/NOMOR DOKUMEN/.test(h))return[row.BillingDocumentNumber??row.DocumentNumber,true];
        if(/TANGGAL DOKUMEN/.test(h))return[date(row.BillingDocumentDate??row.DocumentDate),true];
        if(/JENIS PAJAK/.test(h))return[row.TaxArticle,true];
        if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];
        if(/^OBJEK PAJAK$/.test(h))return[row.TaxObject,true];
        if(/DASAR PENGENAAN PAJAK/.test(h))return[number(row.TaxBase),true];
        if(/TINGKAT/.test(h))return[number(row.TaxRate,2),true];
        if(/PAJAK PENGHASILAN/.test(h))return[number(row.IncomeTax),true];
        if(/FASILITAS PERPAJAKAN/.test(h)){const value=clean(row.TaxCertificate);return[value==='9'?'Tanpa Fasilitas':value,true]}
        if(/UANG PERSEDIAAN \\/ PEMBAYARAN LANGSUNG/.test(h))return[row.PaymentMethod,true];
        if(/NITKU|IDENTITAS SUBUNIT ORGANISASI/.test(h))return[row.BranchId,true];
        if(/^STATUS$/.test(h))return[title(row.Status),true];
        if(/KAP-KJS/.test(h))return[row.RevenueCode,true];
        return['',false]};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';headers.forEach((header,column)=>{const td=document.createElement('td');td.className=classes[column]||'';td.textContent=clean(mapped(header,row,index)[0]);tr.appendChild(td)});body.appendChild(tr)});
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else{snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});if(!table.tFoot&&p.totals){const dpp=headers.findIndex(header=>/DASAR PENGENAAN PAJAK/i.test(header)),pph=headers.findIndex(header=>/PAJAK PENGHASILAN/i.test(header));const foot=document.createElement('tfoot'),tr=document.createElement('tr'),cells=headers.map((header,index)=>{const td=document.createElement('td');td.className=classes[index]||'';tr.appendChild(td);return td});const labelAt=Math.max(0,(dpp>=0?dpp:pph)-1);cells[labelAt].textContent='JUMLAH';cells[labelAt].classList.add('__ca_total_label');if(dpp>=0){cells[dpp].textContent=number(p.totals.taxBase);cells[dpp].classList.add('__ca_numeric')}if(pph>=0){cells[pph].textContent=number(p.totals.incomeTax);cells[pph].classList.add('__ca_numeric')}foot.appendChild(tr);table.appendChild(foot)}}
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printUnifikasiApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = UNIFIKASI_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        const totals = grid.rows.reduce((sum, row) => {
            const taxBase = Number(row && row.TaxBase), incomeTax = Number(row && row.IncomeTax);
            if (Number.isFinite(taxBase)) sum.taxBase += taxBase;
            if (Number.isFinite(incomeTax)) sum.incomeTax += incomeTax;
            return sum;
        }, { taxBase: 0, incomeTax: 0 });
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API ' + tabLabel,
            render: (rows, offset, finalChunk) => replaceUnifikasiSnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk, totals)
        }));
        log('[Lampiran API] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

async function replacePpnSnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const scalar=value=>value&&typeof value==='object'?(value.Name??value.Description??value.Label??value.Code??value.Value??''):value;
      const pick=(row,...keys)=>{for(const key of keys){const value=row&&row[key];if(value!==undefined&&value!==null&&value!=='')return scalar(value)}return''};
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tBodies[0]?.rows[0]?.cells.length||b.tHead.rows[0]?.cells.length||0)-(a.tBodies[0]?.rows[0]?.cells.length||a.tHead.rows[0]?.cells.length||0))[0];
      if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0];
      const leafHeaders=Array.from(headerRow.cells).map(cell=>clean(cell.textContent).replace(/^Pilih\\s+/i,''));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const headers=template&&template.cells.length?Array.from(template.cells).map((cell,index)=>clean(cell.querySelector('.p-column-title,[class*="column-title" i]')?.textContent).replace(/^Pilih\\s+/i,'')||leafHeaders[index]||''):leafHeaders;
      if(!headers.length)return{ok:false,reason:'headers-not-found'};
      const date=value=>{const text=clean(scalar(value)),m=text.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:text};
      const number=value=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{maximumFractionDigits:0});
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(!h||/^(PILIH|AKSI|ACTION)$/.test(h))return['',true,''];
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true,p.rowOffset+index+1];
        if(/NPWP.*PENJUAL|NOMOR IDENTITAS WP.*PENJUAL/.test(h))return[pick(row,'SellerTin'),true,pick(row,'SellerTin')];
        if(/NAMA.*PENJUAL/.test(h)){const raw=pick(row,'SellerName','Name');return[raw,true,raw]}
        if(/NPWP.*PEMBELI|NOMOR IDENTITAS(?: WP)?.*PEMBELI/.test(h))return[pick(row,'BuyerTin'),true,pick(row,'BuyerTin')];
        if(/NAMA.*PEMBELI/.test(h)){const raw=pick(row,'BuyerName','Name');return[raw,true,raw]}
        if(/^NAMA |NAMA PENJUAL BARANG/.test(h))return[pick(row,'Name'),true,pick(row,'Name')];
        if(/NPWP\\/NIK\\/NOMOR PASPOR|NOMOR IDENTITAS WP/.test(h)){const tin=pick(row,'TIN');const fallback=clean(tin)==='0000000000000000'?pick(row,'DocumentNumberByBuyerInfor'):'';return[fallback||tin,true,fallback||tin]}
        if(/^NOMOR FAKTUR PAJAK\\/DOKUMEN TERTENTU|NOMOR BILLING/.test(h))return[pick(row,'BillingNumber'),true,pick(row,'BillingNumber')];
        if(/^TANGGAL FAKTUR PAJAK\\/DOKUMEN TERTENTU|TANGGAL BILLING/.test(h)){const raw=pick(row,'BillingDate');return[date(raw),true,raw]}
        if(/DOKUMEN TERTENTU.*NOMOR|FAKTUR PAJAK.*NOMOR/.test(h))return[pick(row,'DocumentNumber'),true,pick(row,'DocumentNumber')];
        if(/DOKUMEN TERTENTU.*TANGGAL|FAKTUR PAJAK.*TANGGAL/.test(h)){const raw=pick(row,'DocumentDate');return[date(raw),true,raw]}
        if(/JENIS PPN|JENIS PAJAK PERTAMBAHAN NILAI|TIPE TRANSAKSI PPN/.test(h))return[pick(row,'TypeOfVatName','TypeOfVatDescription','TypeOfVatLabel','TypeOfVat'),true,pick(row,'TypeOfVatName','TypeOfVatDescription','TypeOfVatLabel','TypeOfVat')];
        if(/KODE DAN NOMOR SERI/.test(h))return[pick(row,'CodeAndSerialNumber','TaxInvoiceCode'),true,pick(row,'CodeAndSerialNumber','TaxInvoiceCode')];
        if(/DPP NILAI LAIN/.test(h)){const raw=pick(row,'OtherTaxBase');return[number(raw),true,raw]}
        if(/HARGA JUAL|NILAI IMPOR|^DPP(?: \\(RUPIAH\\))?$/.test(h)){const raw=pick(row,'TaxBase');return[number(raw),true,raw]}
        if(/^PPNBM/.test(h)){const raw=pick(row,'STLG');return[number(raw),true,raw]}
        if(/^PPN(?: |\\()/.test(h)){const raw=pick(row,'VAT');return[number(raw),true,raw]}
        if(/^(KETERANGAN|INFORMASI)$/.test(h))return[pick(row,'Information'),true,pick(row,'Information')];
        return['',false,'']};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped,headers};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';const expected=[];const emptyMapped=[];
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';const expectedRow=[];headers.forEach((header,column)=>{const result=mapped(header,row,index),value=clean(result[0]),raw=scalar(result[2]);const td=document.createElement('td');td.className=classes[column]||'';const h=upper(header);if(/^NO\\.?$|NPWP|NIK|NOMOR PASPOR|NOMOR IDENTITAS|TANGGAL|NOMOR BILLING|^NOMOR FAKTUR|DOKUMEN TERTENTU.*NOMOR|FAKTUR PAJAK.*NOMOR|KODE DAN NOMOR SERI|JENIS PPN|TIPE TRANSAKSI PPN/.test(h))td.classList.add('__ca_center');if(/DPP|HARGA JUAL|NILAI IMPOR|^PPN(?: |\\()|^PPNBM/.test(h))td.classList.add('__ca_numeric');td.textContent=value;tr.appendChild(td);expectedRow.push(value);if(clean(raw)&&!value)emptyMapped.push({row:p.rowOffset+index+1,header})});body.appendChild(tr);expected.push(expectedRow)});
      if(emptyMapped.length)return{ok:false,reason:'mapped-value-empty',emptyMapped};
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      const actual=Array.from(body.rows).map(tr=>Array.from(tr.cells).map(td=>clean(td.textContent)));const mismatches=[];expected.forEach((row,r)=>row.forEach((value,c)=>{if(actual[r]?.[c]!==value)mismatches.push({row:r,column:c,expected:value,actual:actual[r]?.[c]})}));if(mismatches.length)return{ok:false,reason:'render-mismatch',mismatches:mismatches.slice(0,10)};
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printPpnApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = PPN_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid PPN ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data PPN ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel PPN ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API PPN ' + tabLabel,
            render: (rows, offset, finalChunk) => replacePpnSnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk)
        }));
        log('[Lampiran API PPN] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

function summarizePph21Grids(grids) {
    return (Array.isArray(grids) ? grids : []).reduce((summary, grid) => {
        const rows = Array.isArray(grid && grid.rows) ? grid.rows : [];
        summary.count += Number.isFinite(Number(grid && grid.total)) ? Number(grid.total) : rows.length;
        for (const row of rows) {
            const grossIncome = Number(row && row.GrossIncome);
            const incomeTax = Number(row && row.IncomeTax);
            if (Number.isFinite(grossIncome)) summary.grossIncome += grossIncome;
            if (Number.isFinite(incomeTax)) summary.incomeTax += incomeTax;
        }
        return summary;
    }, { count: 0, grossIncome: 0, incomeTax: 0 });
}

async function collectPph21ConfidentialSummary(page, tabLabel) {
    const suffixes = PPH21_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const summary = summarizePph21Grids(grids);
    return { code: tabLabel, title: PPH21_LAMPIRAN_TITLES[tabLabel] || tabLabel, ...summary };
}

async function replacePph21SnapshotWithOverview(page, rootSelector, summaries) {
    const payload = { rootSelector, summaries };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const root=snapshot.querySelector(p.rootSelector);if(!root)return{ok:false,reason:'root-not-found'};
      snapshot.querySelectorAll('.__ca_repeat_page_header').forEach(node=>node.remove());
      const sub=snapshot.querySelector('.__ca_print_header_clone .ca-ph-sub');if(sub)sub.textContent='LAMPIRAN L1-L3';
      const format=value=>Number(value||0).toLocaleString('id-ID',{minimumFractionDigits:0,maximumFractionDigits:2});
      const section=document.createElement('section');section.className='__ca_confidential_summary';
      section.style.cssText='margin:7mm 8mm 0;border:1px solid #d6dee6;border-radius:3px;overflow:hidden;background:#fff;color:#334155;font-family:inherit';
      const heading=document.createElement('div');heading.textContent='RINGKASAN LAMPIRAN PPh PASAL 21 DAN/ATAU PASAL 26';heading.style.cssText='padding:8px 10px;background:#f8fafc;border-bottom:1px solid #d6dee6;color:#172554;font-size:11pt;font-weight:700';section.appendChild(heading);
      const table=document.createElement('table');table.style.cssText='width:100%;table-layout:fixed;border-collapse:collapse;font-size:9.2pt';
      const colgroup=document.createElement('colgroup');['8%','52%','10%','15%','15%'].forEach(width=>{const col=document.createElement('col');col.style.width=width;colgroup.appendChild(col)});table.appendChild(colgroup);
      const thead=document.createElement('thead'),headRow=document.createElement('tr');
      ['KODE','JUDUL LAMPIRAN','JUMLAH DATA','TOTAL PENGHASILAN BRUTO (Rp)','TOTAL PPh (Rp)'].forEach(label=>{const th=document.createElement('th');th.textContent=label;th.style.cssText='padding:7px 8px;background:#eaf0f4;color:#172554;border-right:1px solid #d6dee6;text-align:center;font-weight:700;line-height:1.15';headRow.appendChild(th)});thead.appendChild(headRow);table.appendChild(thead);
      const tbody=document.createElement('tbody');
      p.summaries.forEach(summary=>{const row=document.createElement('tr'),values=[summary.code,summary.title,Number(summary.count||0).toLocaleString('id-ID'),format(summary.grossIncome),format(summary.incomeTax)];values.forEach((value,index)=>{const td=document.createElement('td');td.textContent=value;td.style.cssText='padding:8px;border-top:1px solid #d6dee6;border-right:1px solid #d6dee6;line-height:1.22;vertical-align:middle;font-variant-numeric:tabular-nums;text-align:'+(index===1?'left':index>=3?'right':'center')+(index===0?';font-weight:700':'');row.appendChild(td)});tbody.appendChild(row)});table.appendChild(tbody);section.appendChild(table);
      root.replaceChildren(section);return{ok:true,rows:p.summaries.length};
    })()`).catch(error=>({ok:false,reason:error.message}));
}

async function printPph21ConfidentialOverview(page, session, summaries, rootSelector, printScale) {
    const rendered = await replacePph21SnapshotWithOverview(page, rootSelector, summaries);
    if (!rendered || !rendered.ok) throw new Error('Renderer Confidential L1-L3 gagal: ' + JSON.stringify(rendered));
    log('[Lampiran Confidential] L1-L3 diringkas dalam satu halaman: ' + summaries.map(item => item.code + '=' + item.count).join(', ') + '.');
    return [await printPdf(session, printScale)];
}

async function printPaginatorPages(page, session, mode, stableRootSelector = '', ids = [], rootSelector = '', printScale = PRINT_SCALE, compactOverflow = false) {
    if (mode !== 'full' || !ids.length) return [await printAdaptivePdf(session, printScale, compactOverflow)];
    const buffers = [];
    for (const state of ids) {
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) log('[Lampiran paginator] Owner tidak ditemukan untuk ' + state.id + ': ' + JSON.stringify(owner));
        const paginator = page.locator(`.p-paginator[data-ca-paginator-id="${state.id}"]`).first();
        buffers.push(await printAdaptivePdf(session, printScale, compactOverflow));
        let guard = 0;
        while (guard++ < 10000) {
            const next = paginator.locator('.p-paginator-next').first();
            const disabled = await next.evaluate((button) => button.disabled || button.classList.contains('p-disabled')).catch(() => true);
            if (disabled) break;
            const before = await paginator.textContent().catch(() => '');
            await next.evaluate((button) => button.click()).catch(() => {});
            await page.waitForTimeout(650);
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector, { minWaitMs: 700, timeoutMs: 8000 });
            await page.evaluate(`window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()`).catch(() => {});
            const after = await paginator.textContent().catch(() => '');
            if (after === before) break;
            buffers.push(await printAdaptivePdf(session, printScale, compactOverflow));
        }
        const first = paginator.locator('.p-paginator-first').first();
        const canReset = await first.evaluate((button) => !button.disabled && !button.classList.contains('p-disabled')).catch(() => false);
        if (canReset) {
            await first.evaluate((button) => button.click()).catch(() => {});
            await page.waitForTimeout(650);
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector, { minWaitMs: 700, timeoutMs: 8000 });
        }
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

/** Baca WP aktif dari pill akun Coretax. Ini sengaja tidak memakai nama entitas dari Taxio,
 * agar benar ketika user login manual maupun sedang impersonate. */
async function detectActiveTaxpayerName(page) {
    const value = await page.evaluate(`(() => {
      const clean=s=>(s||'').replace(/\\s+/g,' ').trim();
      // Header Coretax merender NPWP + nama + label tanpa separator pada textContent
      // (contoh: 0769...4000RWES DREAM SOCIETYImpersonate), jadi jangan gunakan \b.
      const tidy=s=>clean(s).replace(/IMPERSONATE/ig,'').replace(/\\d{15,16}/g,'').replace(/[·|]+/g,' ').trim();
      const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&r.top<150&&c.display!=='none'&&c.visibility!=='hidden'};
      const score=s=>{s=tidy(s);if(!s||s.length<3||s.length>100)return-1;return(/[A-Za-z]{3}/.test(s)?10:0)+s.split(' ').length};
      const pools=[];
      const imp=Array.from(document.querySelectorAll('body *')).find(e=>visible(e)&&/IMPERSONATE/i.test(clean(e.textContent))&&clean(e.textContent).length<40);
      if(imp){let p=imp;for(let i=0;i<6&&p;i++,p=p.parentElement)if(visible(p))pools.push(p.title,p.getAttribute('aria-label'),p.textContent)}
      Array.from(document.querySelectorAll('header [title],header [aria-label],header button,header [role="button"],nav [role="button"]')).filter(visible).forEach(e=>pools.push(e.title,e.getAttribute('aria-label'),e.textContent));
      let best='';for(const raw of pools){const s=tidy(raw);if(score(s)>score(best)&&!/portal|beranda|profil|logout|bahasa|notifikasi/i.test(s))best=s}if(best)return best;
      const n=document.querySelector('[formcontrolname="Name"]');return clean(n&&(n.value||n.textContent));
    })()`).catch(() => '');
    return sanitizeFilenamePart(value || 'SPT');
}

function filename(entity, config, label, periodLabel) {
    const prefix = config.annual ? config.formCode + ' LAMPIRAN' : config.formCode;
    return `${sanitizeFilenamePart(entity)} - ${prefix} ${sanitizeFilenamePart(label)} ${periodLabel}.pdf`;
}

async function downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode, mode, taxYearHint = '', outputLayout = 'combined') {
    if (!TAXTYPE_CONFIG[taxTypeCode]) return { ok: false, error: 'Jenis SPT ini belum didukung.' };
    mode = ['full', 'confidential'].includes(mode) ? mode : 'print';
    outputLayout = ['combined', 'separate', 'both'].includes(outputLayout) ? outputLayout : 'combined';
    if (mode === 'confidential' && taxTypeCode !== 'ICT_WIT') {
        return { ok: false, error: 'Mode Confidential saat ini hanya tersedia untuk PPh 21/26.' };
    }
    try {
        const config = TAXTYPE_CONFIG[taxTypeCode];
        // Tangkap periode sebelum menunggu/inventarisasi tab. Angular Coretax dapat merender
        // ulang form sesaat setelah tab muncul dan mengosongkan TaxYear sementara; jika tahun
        // dibaca setelah itu, PDF berisiko salah tahun atau menunggu tanpa hasil.
        const hintedYear = /^(?:19|20)\d{2}$/.test(String(taxYearHint || '')) ? String(taxYearHint) : '';
        const period = config.annual && hintedYear
            ? { year: hintedYear, fileLabel: hintedYear, headerLabel: 'Tahun ' + hintedYear }
            : await detectTaxPeriod(page, config);
        const labels = await waitForTabLabels(page);
        if (!labels.length) return { ok: false, error: 'Tab lampiran belum muncul. Tunggu halaman selesai dimuat lalu coba lagi.' };
        const session = await page.context().newCDPSession(page);
        const year = period.year;
        const detected = await detectActiveTaxpayerName(page);
        const entity = sanitizeFilenamePart(ctx.entityName || (detected !== 'SPT' ? detected : ctx.entityCode || taxpayerId || 'SPT'));
        const dir = ctx.outputDir || path.join(ctx.saveRoot, entity, 'SPT', String(year));
        fs.mkdirSync(dir, { recursive: true });
        const saved = [], buffers = [];
        const stableRootSelector = config.repeatHeader ? config.rootSelector : '';
        const confidentialLabels = mode === 'confidential' ? labels.filter(label => PPH21_API_GRIDS[label]) : [];
        const confidentialSummaries = [];
        const lastConfidentialLabel = confidentialLabels[confidentialLabels.length - 1];
        for (const label of labels) {
            if (Array.isArray(ctx.onlyLabels) && ctx.onlyLabels.length && !ctx.onlyLabels.includes(label)) continue;
            if (!await clickTab(page, label)) { log('[Lampiran] Tab tidak dapat dibuka: ' + label); continue; }
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector);
            const modeLabel = mode === 'print' ? 'Print' : mode === 'confidential' ? 'Confidential' : 'Lengkap';
            const suffix = (!config.annual || TWO_VERSION_TABS.has(label)) ? ' (' + modeLabel + ')' : '';
            await setUpTables(page, label, mode === 'confidential' ? 'print' : mode, taxTypeCode);
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector, { minWaitMs: 700, timeoutMs: 8000 });
            // Reset paginator sebelum memasang kop. Klik paginator memicu render ulang Angular
            // dan dapat membuang elemen kop jika dilakukan setelah preparePageForPrint.
            await resetPaginators(page);
            // Inventarisasi dilakukan sebelum CSS cetak menyembunyikan paginator.
            // ID owner dipertahankan pada DOM agar semua halaman dapat ditelusuri tanpa
            // mencetak ulang tabel pasangan yang berbeda.
            const paginatorStates = await paginatorIds(page);
            if (paginatorStates.length) log('[Lampiran paginator] ' + label + ': ' + paginatorStates.map(state => state.total).join(', ') + ' entri.');
            await preparePageForPrint(page, label, { entity, year, periodLabel: period.headerLabel,
                rootSelector: config.rootSelector, formTitle: config.title, sourceTitle: config.sourceTitle,
                repeatHeader: config.repeatHeader, annual: config.annual });
            await page.waitForTimeout(300);
            // Angular Coretax dapat merender ulang root sesaat setelah tab dibuka dan membuang
            // elemen kop. Pasang ulang tepat sebelum print agar PDF paket selalu mendapat kop.
            await preparePageForPrint(page, label, { entity, year, periodLabel: period.headerLabel,
                rootSelector: config.rootSelector, formTitle: config.title, sourceTitle: config.sourceTitle,
                repeatHeader: config.repeatHeader, annual: config.annual });
            try {
                const printScale = config.annual
                    ? (ANNUAL_PRINT_SCALE[taxTypeCode + ':' + label] || PRINT_SCALE)
                    : stableRootSelector && paginatorStates.length
                        ? (MONTHLY_PAGINATOR_SCALE[taxTypeCode + ':' + label] || PRINT_SCALE) : PRINT_SCALE;
                let outputLabel = label + suffix;
                let apiBuffers = null;
                if (config.annual && mode === 'full') {
                    apiBuffers = await printAnnualApiPages(page, session, taxTypeCode, label, config.rootSelector, printScale);
                } else if (taxTypeCode === 'ICT_WIT' && mode === 'full') {
                    apiBuffers = await printPph21ApiPages(page, session, label, paginatorStates, config.rootSelector, printScale);
                } else if (taxTypeCode === 'ICT_WT' && mode === 'full') {
                    apiBuffers = await printUnifikasiApiPages(page, session, label, paginatorStates, config.rootSelector, printScale);
                } else if (taxTypeCode === 'VAT_VAT' && mode === 'full') {
                    apiBuffers = await printPpnApiPages(page, session, label, paginatorStates, config.rootSelector, printScale);
                } else if (taxTypeCode === 'ICT_WIT' && mode === 'confidential' && PPH21_API_GRIDS[label]) {
                    const summary = await collectPph21ConfidentialSummary(page, label);
                    confidentialSummaries.push(summary);
                    log('[Lampiran Confidential] ' + label + ': ' + summary.count + ' data, bruto ' + summary.grossIncome + ', PPh ' + summary.incomeTax + '.');
                    if (label !== lastConfidentialLabel) continue;
                    if (confidentialSummaries.length !== confidentialLabels.length) {
                        throw new Error('Ringkasan Confidential tidak lengkap: ' + confidentialSummaries.length + '/' + confidentialLabels.length + ' lampiran.');
                    }
                    apiBuffers = await printPph21ConfidentialOverview(page, session, confidentialSummaries, config.rootSelector, printScale);
                    outputLabel = 'L1-L3' + suffix;
                }
                const pageBuffers = apiBuffers || (config.annual
                    ? await printAnnualDomPages(page, session, mode, stableRootSelector, paginatorStates, config.rootSelector, printScale)
                    : taxTypeCode === 'VAT_VAT'
                        ? await printPpnDomPages(page, session, mode, stableRootSelector, paginatorStates, config.rootSelector, printScale, label)
                        : await printPaginatorPages(page, session, mode, stableRootSelector, paginatorStates, config.rootSelector, printScale));
                const buf = pageBuffers.length === 1 ? pageBuffers[0] : await mergePdfs(pageBuffers);
                buffers.push(buf);
                if (outputLayout !== 'combined') {
                    const outPath = path.join(dir, filename(entity, config, outputLabel, period.fileLabel));
                    fs.writeFileSync(outPath, buf); saved.push(outPath);
                    if (ctx.compFolder) { fs.mkdirSync(ctx.compFolder, { recursive: true }); fs.copyFileSync(outPath, path.join(ctx.compFolder, path.basename(outPath))); }
                    log('[Lampiran] Tersimpan: ' + outPath);
                }
            } catch (e) { log('[Lampiran] Gagal cetak ' + label + ': ' + e.message); }
        }
        if (!buffers.length) return { ok: false, error: 'Tidak ada lampiran yang berhasil dicetak.' };
        let mergedPath = null;
        if (outputLayout !== 'separate') {
            const mergedLabel = mode === 'print' ? 'GABUNGAN (Print)' : mode === 'confidential' ? 'GABUNGAN (Confidential)' : 'GABUNGAN (Lengkap)';
            mergedPath = path.join(dir, filename(entity, config, mergedLabel, period.fileLabel));
            fs.writeFileSync(mergedPath, await mergePdfs(buffers)); saved.push(mergedPath);
            if (ctx.compFolder) fs.copyFileSync(mergedPath, path.join(ctx.compFolder, path.basename(mergedPath)));
            log('[Lampiran] Tersimpan: ' + mergedPath);
        }
        try { await clickTab(page, labels[0]); } catch (e) {}
        return { ok: true, count: saved.length, paths: saved, combinedPath: mergedPath, dir, entityName: entity, period, mode, outputLayout };
    } catch (e) { return { ok: false, error: e.message }; }
}

const WIDGET_PACKAGE_TOKENS = {
    ICT_WIT: 'SPT MASA PPH 21',
    ICT_WT: 'SPT MASA PPH UNIFIKASI',
    VAT_VAT: 'SPT MASA PPN',
    ICT_RCIT: 'SPT TAHUNAN PPH BADAN',
    ICT_PIT: 'SPT TAHUNAN PPH ORANG PRIBADI'
};

function widgetPeriodCode(row, taxTypeCode, taxYearHint) {
    if (TAXTYPE_CONFIG[taxTypeCode] && TAXTYPE_CONFIG[taxTypeCode].annual) {
        const hinted = String(taxYearHint || '').match(/(?:19|20)\d{2}/);
        if (hinted) return hinted[0];
        const fromRow = String(row && (row.TaxYear || row.TaxPeriodCode) || '').match(/(?:19|20)\d{2}/);
        return fromRow ? fromRow[0] : String(new Date().getFullYear());
    }
    const digits = String(row && row.TaxPeriodCode || '').replace(/\D/g, '');
    if (digits.length >= 6) return digits.slice(0, 2) + digits.slice(-2);
    if (digits.length === 4) return digits;
    return '';
}

function widgetPackageFilename(entityName, taxTypeCode, mode, periodCode) {
    const token = WIDGET_PACKAGE_TOKENS[taxTypeCode] || TAXTYPE_CONFIG[taxTypeCode]?.formCode || 'SPT';
    const modeSuffix = mode === 'print' ? ' (Print)' : mode === 'confidential' ? ' (Confidential)' : '';
    return sanitizeFilenamePart(entityName) + ' - ' + token + modeSuffix + (periodCode ? ' ' + periodCode : '') + '.pdf';
}

function widgetComponentFilename(entityName, taxTypeCode, component, periodCode) {
    const token = WIDGET_PACKAGE_TOKENS[taxTypeCode] || TAXTYPE_CONFIG[taxTypeCode]?.formCode || 'SPT';
    return sanitizeFilenamePart(entityName) + ' - ' + token + ' ' + component + (periodCode ? ' ' + periodCode : '') + '.pdf';
}

async function findWidgetReturnRow(page, taxpayerId, recordId, taxTypeCode, aggregateId) {
    const batchSize = 100;
    for (let first = 0, guard = 0; guard++ < 100; first += batchSize) {
        const body = {
            TaxpayerAggregateIdentifier: taxpayerId, isArchieved: false, First: first, Rows: batchSize,
            SortField: '', SortOrder: 1,
            Filters: [{ PropertyName: 'TaxTypeCode', Value: [taxTypeCode], MatchMode: 'contains', CaseSensitive: true, AsString: false }],
            LanguageId: 'id-ID'
        };
        const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/returnsheetssubmitted', body);
        if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
            throw new Error('Daftar SPT untuk BPE/Induk gagal dibaca (HTTP ' + (response && response.status || 0) + ').');
        }
        const rows = response.json.Payload && Array.isArray(response.json.Payload.Data) ? response.json.Payload.Data : [];
        const found = rows.find((row) => String(row.RecordId || row.ReturnSheetRecordIdentifier || '') === String(recordId || '')
            || String(row.AggregateIdentifier || '') === String(aggregateId || ''));
        if (found) return found;
        if (rows.length < batchSize) break;
    }
    throw new Error('Data induk SPT yang sedang dibuka tidak ditemukan pada backend Coretax.');
}

async function fetchWidgetInduk(page, taxpayerId, row) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier || ZERO_DOCUMENT_ID,
        TaxpayerAggregateIdentifier: taxpayerId,
        LetterNumber: row.ReturnSheetNumber,
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        IsReceipt: false,
        SignParameter: null
    };
    const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/downloadreturnsheet/download-returnsheet-document', body);
    if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
        throw new Error('Induk gagal diunduh (HTTP ' + (response && response.status || 0) + ').');
    }
    if (response.json.Payload && response.json.Payload.IsError) {
        throw new Error('Induk belum siap diunduh: ' + (response.json.Payload.ErrorMessage || 'dokumen masih dibuat Coretax') + '.');
    }
    if (!response.json.Content) throw new Error('Induk tidak dikembalikan oleh Coretax.');
    return Buffer.from(response.json.Content, 'base64');
}

async function fetchWidgetBpe(page, taxpayerId, row) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        TaxpayerAggregateIdentifier: taxpayerId
    };
    const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/downloadreturnsheet/view-receipt', body);
    if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false || !response.json.Payload) return null;
    const tempPath = path.join(os.tmpdir(), 'coretax-agent-widget-bpe-' + process.pid + '-' + Date.now() + '.pdf');
    try {
        await htmlToPdf.renderHtmlToPdf(response.json.Payload, tempPath);
        return fs.readFileSync(tempPath);
    } finally {
        try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch (_) {}
    }
}

async function downloadWidgetSptPackage(page, ctx, taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout) {
    const lampiranCtx = outputLayout === 'combined' ? { ...ctx, compFolder: null } : ctx;
    const lampiranResult = await downloadLampiran(page, lampiranCtx, taxpayerId, recordId, taxTypeCode, mode, taxYearHint, outputLayout);
    if (!lampiranResult || !lampiranResult.ok) return lampiranResult;
    const row = await findWidgetReturnRow(page, taxpayerId, recordId, taxTypeCode, aggregateId);
    const periodCode = widgetPeriodCode(row, taxTypeCode, taxYearHint);
    const [bpeBuffer, rawIndukBuffer] = await Promise.all([
        fetchWidgetBpe(page, taxpayerId, row).catch((error) => { log('[Lampiran widget] BPE tidak tersedia - ' + error.message + ' - dilewati.'); return null; }),
        fetchWidgetInduk(page, taxpayerId, row)
    ]);
    const indukBuffer = taxTypeCode === 'VAT_VAT'
        ? await compactPpnOfficialIndukPdf(rawIndukBuffer) : rawIndukBuffer;
    if (outputLayout === 'combined') {
        if (!lampiranResult.combinedPath || !fs.existsSync(lampiranResult.combinedPath)) throw new Error('PDF lampiran gabungan tidak ditemukan.');
        const ordered = [...(bpeBuffer ? [bpeBuffer] : []), indukBuffer, fs.readFileSync(lampiranResult.combinedPath)];
        const finalPath = path.join(lampiranResult.dir, widgetPackageFilename(lampiranResult.entityName, taxTypeCode, mode, periodCode));
        fs.writeFileSync(finalPath, await mergePdfs(ordered));
        try { fs.rmSync(lampiranResult.combinedPath, { force: true }); } catch (_) {}
        if (ctx.compFolder) {
            fs.mkdirSync(ctx.compFolder, { recursive: true });
            fs.copyFileSync(finalPath, path.join(ctx.compFolder, path.basename(finalPath)));
        }
        log('[Lampiran widget] Tersimpan paket BPE - Induk - Lampiran: ' + finalPath);
        return { ...lampiranResult, count: 1, paths: [finalPath], combinedPath: finalPath, bpeIncluded: !!bpeBuffer, indukIncluded: true };
    }
    const extraPaths = [];
    if (bpeBuffer) {
        const bpePath = path.join(lampiranResult.dir, widgetComponentFilename(lampiranResult.entityName, taxTypeCode, 'BPE', periodCode));
        fs.writeFileSync(bpePath, bpeBuffer); extraPaths.push(bpePath);
    }
    const indukPath = path.join(lampiranResult.dir, widgetComponentFilename(lampiranResult.entityName, taxTypeCode, 'INDUK', periodCode));
    fs.writeFileSync(indukPath, indukBuffer); extraPaths.push(indukPath);
    if (ctx.compFolder) for (const filePath of extraPaths) {
        fs.mkdirSync(ctx.compFolder, { recursive: true });
        fs.copyFileSync(filePath, path.join(ctx.compFolder, path.basename(filePath)));
    }
    log('[Lampiran widget] Tersimpan terpisah: ' + extraPaths.map((filePath) => path.basename(filePath)).join(', '));
    return { ...lampiranResult, count: lampiranResult.count + extraPaths.length, paths: [...extraPaths, ...lampiranResult.paths], bpeIncluded: !!bpeBuffer, indukIncluded: true };
}

async function installLampiranWidget(page, { saveRoot, entityCode, compFolder }) {
    const ctx = { saveRoot: saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), entityCode, compFolder };
    const browserContext = page.context();
    // Sumber data grid lengkap ditangkap pasif sejak sebelum halaman SPT dibuka. Header
    // autentikasi hanya disimpan di memori proses dan tidak pernah ditulis ke log/fixture.
    returnsheetGridApi.watchContext(browserContext);
    try { await browserContext.exposeFunction('__ca_downloadSptPackageV1150', (taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout) => {
        log('[Lampiran engine v1.15.0-final] Binding paket aktif untuk ' + taxTypeCode + ' mode ' + mode + ', output ' + outputLayout + '.');
        // Cari tab yang benar saat tombol diklik. `page` awal dapat berbeda karena Coretax bisa
        // membuka form SPT pada tab baru setelah widget pertama kali dipasang.
        const active = browserContext.pages().find(p => !p.isClosed() && p.url().includes(String(taxpayerId)) && p.url().includes(String(recordId)))
            || browserContext.pages().find(p => !p.isClosed() && /\/(corporate-income-tax-return|personal-income-tax-return|article-21-26-tax-return|withholding-tax-return|value-added-tax-return)\//i.test(p.url())) || page;
        return downloadWidgetSptPackage(active, ctx, taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout);
    }); } catch (e) { log('[Lampiran engine v1.15.0-final] Gagal memasang binding baru: ' + e.message); }
    const script = lampiranWidget.buildLampiranWidgetScript();
    try { await browserContext.addInitScript({ content: script }); }
    catch (e) { log('[Lampiran] Gagal memasang init script: ' + e.message); }

    const applyToPage = async (targetPage) => {
        if (!targetPage || targetPage.isClosed()) return;
        try { await targetPage.evaluate(script); }
        catch (e) { log('[Lampiran] Gagal memasang widget pada tab ' + targetPage.url() + ': ' + e.message); }
    };
    // Pasang pada SEMUA tab yang sudah ada, bukan hanya tab yang dipakai saat login.
    await Promise.all(browserContext.pages().map(applyToPage));
    if (!watchedContexts.has(browserContext)) {
        watchedContexts.add(browserContext);
        // Coretax dapat membuka view SPT di tab baru. addInitScript adalah lapisan pertama;
        // evaluasi eksplisit setelah DOM siap menjadi lapisan pemulihan jika init script pernah
        // terlewat pada context hasil reconnect/reuse.
        browserContext.on('page', (newPage) => {
            newPage.once('domcontentloaded', () => applyToPage(newPage));
            setTimeout(() => applyToPage(newPage), 1500);
        });
    }
    log('[Lampiran] Widget siap pada ' + browserContext.pages().length + ' tab Coretax.');
}

module.exports = {
    installLampiranWidget, downloadLampiran, mergePdfs, compactPpnOfficialIndukPdf,
    TAXTYPE_CONFIG, detectActiveTaxpayerName, preparePageForPrint,
    __test: { waitForTabLabels, trimTrailingBlankPages, pageHasVisibleMarks, decodedPageContent, paginatorIds, printPaginatorPages,
        resetPaginators, setActivePaginatorOwner, clearPaginatorOwners, summarizePph21Grids,
        collectPph21ConfidentialSummary, replacePph21SnapshotWithOverview, printPph21ConfidentialOverview,
        replaceUnifikasiSnapshotRows, printUnifikasiApiPages, replacePpnSnapshotRows, printPpnApiPages,
        replaceAnnualSnapshotRows, printAnnualApiPages,
        printAnnualDomPages, printPpnDomPages, printL1SnapshotPages, stampHeaderOnPdf,
        compactPpnOfficialIndukPdf, detectYear, mergePdfs,
        PPN_API_GRIDS, widgetPeriodCode, widgetPackageFilename, widgetComponentFilename, downloadWidgetSptPackage }
};
