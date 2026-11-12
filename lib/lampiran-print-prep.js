/* Lampiran printing: prepares the Coretax page for Chrome's printToPDF - injected print CSS,
 * kop header, table column layout, repeat-header snapshot, L1 snapshot. Split out of
 * automation/lampiran.js (still the public entry point). */
const { log } = require('./log');
const { PRINT_STYLE_ID } = require('./lampiran-config');

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
      body.__ca_print_op rshshr-personal-income-tax-return,
      body.__ca_print_op rshshr-personal-income-tax-return h1,
      body.__ca_print_op rshshr-personal-income-tax-return h2,
      body.__ca_print_op rshshr-personal-income-tax-return h3,
      body.__ca_print_op rshshr-personal-income-tax-return label,
      body.__ca_print_op rshshr-personal-income-tax-return input,
      body.__ca_print_op rshshr-personal-income-tax-return select,
      body.__ca_print_op rshshr-personal-income-tax-return textarea,
      body.__ca_print_op rshshr-personal-income-tax-return table,
      body.__ca_print_op rshshr-personal-income-tax-return th,
      body.__ca_print_op rshshr-personal-income-tax-return td,
      body.__ca_print_op rshshr-personal-income-tax-return .p-component:not(.pi),
      body.__ca_print_op rshshr-personal-income-tax-return .p-inputtext,
      body.__ca_print_op rshshr-personal-income-tax-return .p-dropdown-label,
      body.__ca_print_op rshshr-personal-income-tax-return .p-accordion-header-text,
      body.__ca_print_op .__ca_print_header_clone,
      body.__ca_print_op #__ca_print_header{font-family:"Arial Narrow",Arial,sans-serif!important}
      body.__ca_print_op rshshr-personal-income-tax-return,
      body.__ca_print_op rshshr-personal-income-tax-return label,
      body.__ca_print_op rshshr-personal-income-tax-return input,
      body.__ca_print_op rshshr-personal-income-tax-return select,
      body.__ca_print_op rshshr-personal-income-tax-return textarea,
      body.__ca_print_op rshshr-personal-income-tax-return table,
      body.__ca_print_op rshshr-personal-income-tax-return td,
      body.__ca_print_op rshshr-personal-income-tax-return .p-inputtext,
      body.__ca_print_op rshshr-personal-income-tax-return .p-dropdown-label,
      body.__ca_print_op rshshr-personal-income-tax-return .p-radiobutton-label{color:#263746!important}
      body.__ca_print_op #__ca_print_header,body.__ca_print_op .__ca_print_header_clone{border-bottom-color:#17365d!important}
      body.__ca_print_op #__ca_print_header .ca-ph-title,body.__ca_print_op .__ca_print_header_clone .ca-ph-title,
      body.__ca_print_op #__ca_print_header .ca-ph-wp,body.__ca_print_op .__ca_print_header_clone .ca-ph-wp{color:#17365d!important}
      body.__ca_print_op #__ca_print_header .ca-ph-sub,body.__ca_print_op .__ca_print_header_clone .ca-ph-sub{color:#46586a!important}
      body.__ca_print_op rshshr-personal-income-tax-return .p-accordion-header-link,
      body.__ca_print_op rshshr-personal-income-tax-return .p-panel-header,
      body.__ca_print_op rshshr-personal-income-tax-return .p-fieldset-legend{
        padding:5px 8px!important;background:#e7edf2!important;color:#17365d!important;border-color:#aebbc6!important
      }
      body.__ca_print_op rshshr-personal-income-tax-return .p-accordion-header-link *,
      body.__ca_print_op rshshr-personal-income-tax-return .p-panel-header *,
      body.__ca_print_op rshshr-personal-income-tax-return .p-fieldset-legend *{background:transparent!important;color:#17365d!important}
      body.__ca_print_op rshshr-personal-income-tax-return .p-accordion-content,
      body.__ca_print_op rshshr-personal-income-tax-return .p-panel-content,
      body.__ca_print_op rshshr-personal-income-tax-return .p-fieldset-content{
        padding:5px 8px!important;border-color:#aebbc6!important;background:#fff!important;color:#263746!important
      }
      body.__ca_print_op rshshr-personal-income-tax-return .form-group.row{margin-top:0!important;margin-bottom:1px!important}
      body.__ca_print_op rshshr-personal-income-tax-return .col-form-label{padding-top:2px!important;padding-bottom:2px!important}
      body.__ca_print_op rshshr-personal-income-tax-return input.form-control,
      body.__ca_print_op rshshr-personal-income-tax-return .p-inputtext,
      body.__ca_print_op rshshr-personal-income-tax-return .p-dropdown,
      body.__ca_print_op rshshr-personal-income-tax-return .p-inputgroup-addon{
        padding-top:1px!important;padding-bottom:1px!important;background:#f3f5f7!important;color:#263746!important;border-color:#b8c3cc!important
      }
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout thead,
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout thead tr,
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout thead th,
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout thead th *{background:#e7edf2!important;color:#17365d!important}
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout th,
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout td{border-color:#b8c3cc!important}
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout tbody tr:nth-child(even)>td{background:#f8fafb!important}
      body.__ca_print_op rshshr-personal-income-tax-return table.__ca_layout tfoot td{background:#edf1f4!important;color:#17365d!important;border-color:#aebbc6!important}
      body.__ca_print_op rshshr-personal-income-tax-return .p-radiobutton-box{border-color:#aebbc6!important;background:#f3f5f7!important}
      body.__ca_print_op rshshr-personal-income-tax-return .p-radiobutton-box.p-highlight{border-color:#17365d!important;background:#17365d!important}
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
       const root=document.querySelector(p.rootSelector)||document.querySelector('rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return,rshshr-withholding-return,rshshr-normal-value-add-tax-return');if(!root)return{ok:false,reason:'root-not-found'};document.body.classList.toggle('__ca_repeat_header',!!p.repeatHeader);document.body.classList.toggle('__ca_print_op',root.matches('rshshr-personal-income-tax-return'));root.classList.toggle('__ca_monthly_induk_compact',!!p.repeatHeader&&clean(p.label).toUpperCase()==='INDUK');root.classList.toggle('__ca_monthly_detail_compact',!!p.repeatHeader&&clean(p.label).toUpperCase()!=='INDUK');root.classList.toggle('__ca_annual_induk_compact',!!p.annual&&clean(p.label).toUpperCase()==='INDUK');root.classList.toggle('__ca_corporate_induk_spacious',root.matches('rshshr-corporate-income-tax-return')&&clean(p.label).toUpperCase()==='INDUK');
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

module.exports = { preparePageForPrint };
