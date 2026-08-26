/* Coretax Agent - cetak lampiran SPT langsung dari tampilan Coretax melalui CDP. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, PDFArray } = require('pdf-lib');
const { log } = require('../lib/log');
const { sanitizeFilenamePart } = require('../lib/datatable');
const lampiranWidget = require('../lib/lampiran-widget');

const TAXTYPE_CONFIG = {
    ICT_RCIT: {
        formCode: '1771', annual: true, pathKind: 'corporate-income-tax-return',
        rootSelector: 'rshshr-corporate-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN'
    },
    ICT_PIT: {
        formCode: '1770', annual: true, pathKind: 'personal-income-tax-return',
        rootSelector: 'rshshr-personal-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK ORANG PRIBADI'
    },
    ICT_WIT: {
        formCode: 'SPT MASA PPH 21-26', pathKind: 'article-21-26-tax-return',
        rootSelector: 'rshshr-article-twentyone-twentysix-tax-return',
        title: 'PEMOTONGAN PPH PASAL 21 DAN/ATAU PASAL 26'
    },
    ICT_WT: {
        formCode: 'SPT MASA PPH UNIFIKASI', pathKind: 'withholding-tax-return',
        rootSelector: 'rshshr-withholding-return', title: 'SPT MASA PPH UNIFIKASI'
    },
    VAT_VAT: {
        formCode: 'SPT MASA PPN', pathKind: 'value-added-tax-return',
        rootSelector: 'rshshr-normal-value-add-tax-return',
        title: 'SURAT PEMBERITAHUAN MASA PAJAK PERTAMBAHAN NILAI (SPT MASA PPN)'
    }
};
const TAB_TITLE_SEL = '.p-tabview-title';
const TWO_VERSION_TABS = new Set(['L3', 'L4', 'L9']);
const TAB_ROW_CAP = { L9: 10 };
const COMPACT_ROWS = 50;
const PRINT_SCALE = 0.9;
const PRINT_STYLE_ID = '__ca_print_style';
const watchedContexts = new WeakSet();

async function waitForTabLabels(page) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const labels = await page.evaluate(`(() => {
            const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
            return [...new Set(Array.from(document.querySelectorAll(${JSON.stringify(TAB_TITLE_SEL)})).filter(visible).map(e=>(e.textContent||'').trim()).filter(Boolean))];
        })()`).catch(() => []);
        if (labels.length) return labels;
        await page.waitForTimeout(1000);
    }
    return [];
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

async function preparePageForPrint(page, tabLabel, metadata) {
    const css = `table.__ca_layout>colgroup[data-ca-layout]{display:none}
      @page { size:A3 landscape !important; margin:8mm !important; }
      #__ca_print_header{display:none}
      @media print { html,body,nui-shell-twostep{background:#fff!important;background-image:none!important} main.tw-content-wrap{margin-top:0!important;padding-top:0!important} nav,aside,footer,.p-tabview-nav-container,.p-tabview-nav-content,.p-tabview-nav,[class*="sidebar" i],[class*="side-nav" i],[class*="footer" i],#__ca_lampiran_widget,#__ca_lampiran_chooser,#__ca_passphrase_widget{display:none!important}
      .__ca_source_title{display:none!important}
      #__ca_print_header{display:grid!important;grid-template-columns:180px 1fr 300px;align-items:center;gap:16px;border-bottom:2px solid #172554;padding:0 4px 10px;margin:0 0 12px;break-inside:avoid;page-break-inside:avoid}
      #__ca_print_header img{width:160px;height:auto;object-fit:contain}#__ca_print_header .ca-ph-title{text-align:center;color:#172554;font-size:14pt;font-weight:700;line-height:1.2}#__ca_print_header .ca-ph-sub{text-align:center;color:#475569;font-size:11pt;font-weight:700;letter-spacing:.3px;margin-top:5px;text-transform:uppercase}#__ca_print_header .ca-ph-wp{text-align:right;color:#172554;font-size:10.5pt;line-height:1.45;font-variant-numeric:tabular-nums}#__ca_print_header .ca-ph-wp span{display:block}#__ca_print_header .ca-ph-wp .ca-ph-name{font-weight:700}
      button,.p-button{display:none!important}
      h1,h2{text-align:left!important;font-size:13pt!important;line-height:1.25!important;margin:8px 0 10px!important}
      .p-datatable-wrapper,[class*="datatable" i],[class*="table-wrap" i],[class*="scroll" i]{overflow:visible!important}
      table{width:100%!important;max-width:100%!important;table-layout:fixed!important;font-size:10pt!important}
      table.__ca_table_wide{font-size:9.5pt!important}
      table.__ca_layout thead,table.__ca_layout thead tr,table.__ca_layout thead th,table.__ca_layout thead th *{background:#eaf0f4!important;color:#172554!important}
      table.__ca_layout thead tr,table.__ca_layout thead th{height:auto!important;min-height:0!important}
      table.__ca_layout thead th{font-size:9.5pt!important;font-weight:600!important;text-align:center!important;vertical-align:middle!important;white-space:normal!important;overflow:visible!important;text-overflow:clip!important}
      table.__ca_layout thead th *{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;height:auto!important;min-height:0!important}
      .p-datatable-header,.p-paginator,.p-sortable-column-icon,.p-sortable-column-badge,tr.__ca_filter_row,table.__ca_filter_table{display:none!important}
      th,td{padding:3px 4px!important;white-space:normal!important;word-break:normal!important;overflow-wrap:anywhere!important;min-width:0!important;line-height:1.25!important}
      table.__ca_layout tbody td *{white-space:inherit!important;overflow:visible!important;text-overflow:clip!important;max-width:100%!important}
      th.__ca_col_action,td.__ca_col_action{visibility:hidden!important;padding:0!important;border:0!important;width:0!important;max-width:0!important;font-size:0!important;overflow:hidden!important}
      th.__ca_col_no,td.__ca_col_no{text-align:center!important}th.__ca_col_no{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}
      th.__ca_col_date,td.__ca_col_date{text-align:center!important;white-space:nowrap!important;font-variant-numeric:tabular-nums!important}
      th.__ca_col_id,td.__ca_col_id{white-space:nowrap!important;font-variant-numeric:tabular-nums!important}
      td.__ca_col_account{white-space:nowrap!important;overflow:visible!important}
      th.__ca_numeric,td.__ca_numeric{text-align:right!important;white-space:nowrap!important;padding-left:1px!important;padding-right:2px!important;font-variant-numeric:tabular-nums!important}
      table.__ca_layout>colgroup[data-ca-layout]{display:table-column-group!important}
      table.__ca_layout>colgroup:not([data-ca-layout]){display:none!important}
      table.__ca_layout>colgroup[data-ca-layout]>col{width:var(--ca-width)!important;min-width:0!important} }`;
    await page.evaluate(`(()=>{
      const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const profile=h=>{h=(h||'').replace(/\\s+/g,' ').replace(/(?:SILAKAN )?PILIH [^>]+/g,'').trim().toUpperCase();if(/^TINDAKAN$/.test(h))return['action',0];if(/^(NO\\.?|NOMOR|NO\\. URUT)$/.test(h))return['no',4];if(/NITKU|ID TEMPAT KEGIATAN USAHA|IDENTITAS SUBUNIT ORGANISASI/.test(h))return['id',22];if(/NPWP|NIK|(?:^|\\/)TIN(?:$|\\s)|NOMOR IDENTITAS|IDENTITAS PENERIMA/.test(h))return['id',17];if(/FILENAME|NAMA FILE/.test(h))return['filename',32];if(/NAMA AKUN/.test(h))return['account',32];if(/KODE DAN NOMOR SERI|KODE.*FAKTUR|NOMOR SERI FAKTUR/.test(h))return['code',18];if(/KODE PENYESUAIAN/.test(h))return['code',15];if(/KODE OBJEK/.test(h))return['code',10];if(/KODE AKUN|KODE HARTA|^KODE$/.test(h))return['code',5];if(/NOMOR BUKTI POTONG|BUKTI POTONG.*NOMOR|NOMOR DOKUMEN|DOKUMEN.*NOMOR/.test(h))return['code',17];if(/BULAN\\/TAHUN|TANGGAL|TAHUN PEROLEHAN/.test(h))return['date',11];if(/NEGARA/.test(h))return['short',10];if(/JENIS PAJAK/.test(h))return['short',13];if(/METODE.*(?:KOMERSIAL|FISKAL)|^(?:KOMERSIAL|FISKAL)$/.test(h))return['short',12];if(/TINGKAT|PERSENTASE|(?:^|>)\\s*%/.test(h))return['numeric',8];if(/NILAI|JUMLAH|DPP|^PPN(?:BM)?(?:\\s|$)|PAJAK PENGHASILAN|PAJAK TERUTANG|BIAYA|AMOUNT|RUPIAH|KOMPENSASI|HARGA|PEROLEHAN|PENYUSUTAN|PENGHASILAN BRUTO|SALDO|PIUTANG|UTANG|LUAS|MODAL DISETOR|DIVIDEN/.test(h))return['numeric',12];if(/NAMA/.test(h))return['name',16];if(/DESKRIPSI|KETERANGAN|ALAMAT|KELOMPOK|JENIS|METODE|ALASAN|PEKERJAAN|KEGIATAN USAHA|OBJEK PAJAK|BENTUK HUBUNGAN/.test(h))return['long',22];if(/LOKASI|UKURAN|SUMBER KEPEMILIKAN|KEPEMILIKAN|NOMOR AKUN|NOMOR POLISI|NOMOR SERTIFIKAT|REGISTRASI|MATA UANG|HUBUNGAN|KATEGORI|TIPE|MERK|JABATAN|STATUS|KAP-KJS/.test(h))return['short',11];return['default',12]};
      const classOf=k=>k==='action'?'__ca_col_action':k==='no'?'__ca_col_no':k==='date'?'__ca_col_date':k==='id'?'__ca_col_id':k==='account'?'__ca_col_account':k==='numeric'?'__ca_numeric':'';
      for(const table of Array.from(document.querySelectorAll('table')).filter(visible)){
        table.classList.remove('__ca_table_wide','__ca_filter_table','__ca_layout');table.querySelectorAll('colgroup[data-ca-layout]').forEach(e=>e.remove());
        table.querySelectorAll('th,td').forEach(c=>c.classList.remove('__ca_col_action','__ca_col_no','__ca_col_date','__ca_col_id','__ca_col_account','__ca_numeric'));
        const rows=Array.from(table.tHead?table.tHead.rows:[]),grid=[],meta=[];let cols=0;
        rows.forEach((row,ri)=>{grid[ri]=grid[ri]||[];let pos=0;for(const th of Array.from(row.cells)){while(grid[ri][pos])pos++;const cs=th.colSpan||1,rs=th.rowSpan||1,text=(th.textContent||'').replace(/\\s+/g,' ').trim();for(let r=ri;r<ri+rs;r++){grid[r]=grid[r]||[];for(let c=pos;c<pos+cs;c++)grid[r][c]=true}for(let c=pos;c<pos+cs;c++){meta[c]=meta[c]||{texts:[],controls:false,cells:[]};if(text)meta[c].texts.push(text);meta[c].controls=meta[c].controls||!!th.querySelector('input,select,.p-dropdown,.p-calendar,.p-column-filter');meta[c].cells.push(th)}pos+=cs;cols=Math.max(cols,pos)}});
        if(!cols)continue;for(let i=0;i<cols;i++)meta[i]=meta[i]||{texts:[],controls:false,cells:[]};
        for(const row of rows){row.classList.toggle('__ca_filter_row',!!row.querySelector('input,select,.p-column-filter,.p-dropdown,.p-calendar'));for(const th of Array.from(row.cells)){const walker=document.createTreeWalker(th,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())node.nodeValue=node.nodeValue.replace(/NPWPW/g,'NPWP').replace(/\\(Rp\\.\\)Rp\\.\\)/g,'(Rp.)');th.style.setProperty('background-color','#eaf0f4','important');th.style.setProperty('color','#172554','important');th.querySelectorAll('*').forEach(e=>{e.style.setProperty('background-color','transparent','important');e.style.setProperty('color','#172554','important')})}}
        const meaningful=meta.some(m=>m.texts.some(t=>!/^SILAKAN PILIH|^PILIH /i.test(t)));if(!meaningful&&meta.some(m=>m.controls)){table.classList.add('__ca_filter_table');continue}
        const bodyRows=Array.from(table.tBodies).flatMap(b=>Array.from(b.rows)).slice(0,60);
        meta.forEach((m,col)=>{let seen=0,num=0,id=0,date=0,checks=0,maxLen=0;const leaf=m.texts[m.texts.length-1]||'',full=m.texts.join(' > ');for(const tr of bodyRows){const cell=tr.cells[col];if(!cell)continue;if(cell.querySelector('input[type="checkbox"],button,.p-button'))checks++;const clone=cell.cloneNode(true);clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach(e=>e.remove());const v=(clone.textContent||'').replace(/\\s+/g,' ').trim();if(!v||/^(?:TIDAK ADA DATA|NO RECORDS?)/i.test(v))continue;seen++;maxLen=Math.max(maxLen,v.length);if(/^(Rp\\.?\\s*)?[-(]?[0-9.,]+[)]?$/.test(v))num++;if(/^\\d{15,22}$/.test(v.replace(/\\D/g,'')))id++;if(/^\\d{1,2}[-\\/]\\d{1,2}[-\\/]\\d{2,4}$/.test(v))date++}let p=profile(full||leaf);if(!leaf&&!seen&&!m.controls)p=['action',0];else if(checks&&checks>=Math.max(1,bodyRows.length*.5))p=['action',0];else if(seen&&id/seen>=.7)p=['id',Math.max(17,Math.min(23,maxLen+1))];else if(seen&&date/seen>=.7)p=['date',11];else if(seen>=1&&num/seen>=.7&&p[0]==='default')p=['numeric',12];if(p[0]==='id')p[1]=Math.max(p[1],Math.min(23,maxLen+1));if(p[0]==='numeric')p[1]=Math.max(6,Math.min(17,maxLen+2));if(p[0]==='name')p[1]=Math.max(14,Math.min(24,8+maxLen*.45));if(p[0]==='account')p[1]=Math.max(26,Math.min(36,10+maxLen*.5));if(p[0]==='long')p[1]=Math.max(16,Math.min(30,10+maxLen*.35));if(p[0]==='filename')p[1]=Math.max(28,Math.min(42,12+maxLen*.5));if(m.controls&&p[0]==='default')p=['dropdown',14];m.kind=p[0];m.weight=p[1];const cl=classOf(m.kind);if(cl){m.cells.filter(c=>c.colSpan===1).forEach(c=>c.classList.add(cl));for(const tr of bodyRows)if(tr.cells[col])tr.cells[col].classList.add(cl)}});
        const total=meta.reduce((n,m)=>n+m.weight,0)||1,cg=document.createElement('colgroup');cg.dataset.caLayout='1';meta.forEach(m=>{const col=document.createElement('col');col.style.setProperty('--ca-width',m.weight?((m.weight/total)*100).toFixed(3)+'%':'0%');cg.appendChild(col)});table.insertBefore(cg,table.firstChild);table.classList.add('__ca_layout');if(cols>=11)table.classList.add('__ca_table_wide');
      }
      let e=document.getElementById(${JSON.stringify(PRINT_STYLE_ID)});if(!e){e=document.createElement('style');e.id=${JSON.stringify(PRINT_STYLE_ID)}}e.textContent=${JSON.stringify(css)};document.head.appendChild(e)
    })()`).catch((error) => { log('[Lampiran] Gagal menyiapkan tabel cetak: ' + error.message); });
    await page.evaluate((payload) => {
        const label = payload && payload.label;
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const root = document.querySelector(payload && payload.rootSelector) || document.querySelector('rshshr-corporate-income-tax-return,rshshr-personal-income-tax-return,rshshr-article-twentyone-twentysix-tax-return,rshshr-withholding-return,rshshr-normal-value-add-tax-return');
        if (!root) return;
        let header = document.getElementById('__ca_print_header');
        if (!header) {
            header = document.createElement('div'); header.id = '__ca_print_header';
            header.innerHTML = '<div class="ca-ph-logo"></div><div><div class="ca-ph-title"></div><div class="ca-ph-sub"></div></div><div class="ca-ph-wp"></div>';
            root.prepend(header);
        }
        const logo = [...document.images].find((img) => /Logo-Coretax-DJP-Kemenkeu/i.test(img.src));
        const logoBox = header.querySelector('.ca-ph-logo'); logoBox.replaceChildren();
        if (logo) { const copy = logo.cloneNode(); copy.removeAttribute('style'); logoBox.appendChild(copy); }
        const formTitle = clean(payload && payload.formTitle) || 'SURAT PEMBERITAHUAN (SPT)';
        [...root.querySelectorAll('h1,h2,h3')].find((heading) => clean(heading.textContent).toUpperCase() === formTitle.toUpperCase())?.classList.add('__ca_source_title');
        header.querySelector('.ca-ph-title').textContent = formTitle;
        header.querySelector('.ca-ph-sub').textContent = ('LAMPIRAN ' + clean(label || 'SPT')).toUpperCase();
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
        nameLine.textContent = [name, periodLabel].filter(Boolean).join(' · '); wp.appendChild(nameLine);
    }, { label: tabLabel || '', entity: metadata && metadata.entity, year: metadata && metadata.year,
        periodLabel: metadata && metadata.periodLabel, rootSelector: metadata && metadata.rootSelector,
        formTitle: metadata && metadata.formTitle }).catch(() => {});
}

async function setUpTables(page, tabLabel, mode) {
    await page.evaluate(`(async()=>{
      const sleep=m=>new Promise(r=>setTimeout(r,m)),visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const cap=${JSON.stringify(mode)}==='print'?(${JSON.stringify(TAB_ROW_CAP)}[${JSON.stringify(tabLabel)}]||${COMPACT_ROWS}):0;
      for(const dd of Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(visible)){try{if((dd.className||'').includes('p-disabled'))continue;dd.click();await sleep(300);const items=Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(visible);if(!items.length){document.body.click();continue}let pick=items.length-1;if(cap){let bi=-1,bv=-1;items.forEach((it,i)=>{const v=parseInt((it.textContent||'').replace(/[^\\d]/g,''),10);if(!isNaN(v)&&v<=cap&&v>bv){bi=i;bv=v}});pick=bi>=0?bi:0}items[pick].click();await sleep(500)}catch(e){}}
    })()`).catch(() => {});
}

async function printPdf(session) {
    const r = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, scale: PRINT_SCALE });
    return trimTrailingBlankPages(Buffer.from(r.data, 'base64'));
}

function pageContentBytes(pdf, page) {
    const contents = page.node.Contents();
    if (!contents) return 0;
    const refs = contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents];
    return refs.reduce((sum, ref) => {
        const stream = pdf.context.lookup(ref);
        return sum + (stream && stream.contents ? stream.contents.length : 0);
    }, 0);
}

async function trimTrailingBlankPages(buffer) {
    const pdf = await PDFDocument.load(buffer);
    let changed = false;
    while (pdf.getPageCount() > 1 && pageContentBytes(pdf, pdf.getPages().at(-1)) <= 1000) {
        pdf.removePage(pdf.getPageCount() - 1);
        changed = true;
    }
    return changed ? Buffer.from(await pdf.save()) : buffer;
}

async function mergePdfs(buffers) {
    const out = await PDFDocument.create();
    for (const buf of buffers) {
        const src = await PDFDocument.load(buf);
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    return Buffer.from(await out.save());
}

async function detectYear(page) {
    const val = await page.locator('[formcontrolname="TaxYear"]').first().inputValue({ timeout: 2000 }).catch(() => '');
    const m = String(val).match(/\d{4}/);
    if (m) return m[0];
    const t = (await page.locator('body').innerText().catch(() => '')).match(/(?:Tahun Pajak|Tax Year)[^\d]*(\d{4})/i);
    return t ? t[1] : String(new Date().getFullYear());
}

async function detectTaxPeriod(page, config) {
    const year = await detectYear(page);
    if (config.annual) return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
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
    return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
}

async function resetPaginators(page) {
    const count = await page.evaluate(`(()=>{let n=0;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};for(const p of Array.from(document.querySelectorAll('.p-paginator')).filter(visible)){const b=p.querySelector('.p-paginator-first');if(b&&!b.disabled&&!b.classList.contains('p-disabled')){b.click();n++}}return n})()`).catch(() => 0);
    if (count) await page.waitForTimeout(700);
}

async function paginatorIds(page) {
    return page.evaluate(`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};let n=0;return Array.from(document.querySelectorAll('.p-paginator')).filter(visible).map(p=>{const text=(p.textContent||'').replace(/\s+/g,' ').trim(),m=text.match(/(?:of|dari)\s+([\d.,]+)\s+(?:entries|entri)/i),total=m?parseInt(m[1].replace(/[.,]/g,''),10):0;p.dataset.caPaginatorId=String(n++);return{id:p.dataset.caPaginatorId,total}}).filter(x=>x.total>0)})()`).catch(() => []);
}

async function printPaginatorPages(page, session, mode) {
    await resetPaginators(page);
    const ids = await paginatorIds(page);
    const buffers = [await printPdf(session)];
    if (mode !== 'full') return buffers;
    for (const state of ids) {
        const paginator = page.locator(`.p-paginator[data-ca-paginator-id="${state.id}"]`);
        let guard = 0;
        while (guard++ < 10000) {
            const next = paginator.locator('.p-paginator-next').first();
            const disabled = await next.evaluate((button) => button.disabled || button.classList.contains('p-disabled')).catch(() => true);
            if (disabled) break;
            const before = await paginator.innerText().catch(() => '');
            await next.click({ timeout: 5000 });
            await page.waitForTimeout(650);
            const after = await paginator.innerText().catch(() => '');
            if (after === before) break;
            buffers.push(await printPdf(session));
        }
        const first = paginator.locator('.p-paginator-first').first();
        const canReset = await first.evaluate((button) => !button.disabled && !button.classList.contains('p-disabled')).catch(() => false);
        if (canReset) { await first.click({ timeout: 5000 }); await page.waitForTimeout(650); }
    }
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

async function downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode, mode) {
    if (!TAXTYPE_CONFIG[taxTypeCode]) return { ok: false, error: 'Jenis SPT ini belum didukung.' };
    mode = mode === 'full' ? 'full' : 'print';
    try {
        const labels = await waitForTabLabels(page);
        if (!labels.length) return { ok: false, error: 'Tab lampiran belum muncul. Tunggu halaman selesai dimuat lalu coba lagi.' };
        const session = await page.context().newCDPSession(page);
        const config = TAXTYPE_CONFIG[taxTypeCode];
        const period = await detectTaxPeriod(page, config);
        const year = period.year;
        const detected = await detectActiveTaxpayerName(page);
        const entity = detected !== 'SPT' ? detected : sanitizeFilenamePart(ctx.entityCode || taxpayerId || 'SPT');
        const dir = path.join(ctx.saveRoot, entity, 'SPT', String(year));
        fs.mkdirSync(dir, { recursive: true });
        const saved = [], buffers = [];
        for (const label of labels) {
            if (!await clickTab(page, label)) { log('[Lampiran] Tab tidak dapat dibuka: ' + label); continue; }
            const suffix = (!config.annual || TWO_VERSION_TABS.has(label)) ? (mode === 'print' ? ' (Print)' : ' (Lengkap)') : '';
            await setUpTables(page, label, mode);
            await preparePageForPrint(page, label, { entity, year, periodLabel: period.headerLabel,
                rootSelector: config.rootSelector, formTitle: config.title });
            await page.waitForTimeout(300);
            try {
                const pageBuffers = await printPaginatorPages(page, session, mode);
                const buf = pageBuffers.length === 1 ? pageBuffers[0] : await mergePdfs(pageBuffers);
                const outPath = path.join(dir, filename(entity, config, label + suffix, period.fileLabel));
                fs.writeFileSync(outPath, buf); saved.push(outPath); buffers.push(buf);
                if (ctx.compFolder) { fs.mkdirSync(ctx.compFolder, { recursive: true }); fs.copyFileSync(outPath, path.join(ctx.compFolder, path.basename(outPath))); }
                log('[Lampiran] Tersimpan: ' + outPath);
            } catch (e) { log('[Lampiran] Gagal cetak ' + label + ': ' + e.message); }
        }
        if (!buffers.length) return { ok: false, error: 'Tidak ada lampiran yang berhasil dicetak.' };
        const mergedLabel = mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)';
        const mergedPath = path.join(dir, filename(entity, config, mergedLabel, period.fileLabel));
        fs.writeFileSync(mergedPath, await mergePdfs(buffers)); saved.push(mergedPath);
        if (ctx.compFolder) fs.copyFileSync(mergedPath, path.join(ctx.compFolder, path.basename(mergedPath)));
        try { await clickTab(page, labels[0]); } catch (e) {}
        return { ok: true, count: saved.length, paths: saved, dir, entityName: entity, mode };
    } catch (e) { return { ok: false, error: e.message }; }
}

async function installLampiranWidget(page, { saveRoot, entityCode, compFolder }) {
    const ctx = { saveRoot: saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), entityCode, compFolder };
    const browserContext = page.context();
    try { await browserContext.exposeFunction('__ca_downloadLampiran', (taxpayerId, recordId, taxTypeCode, mode) => {
        // Cari tab yang benar saat tombol diklik. `page` awal dapat berbeda karena Coretax bisa
        // membuka form SPT pada tab baru setelah widget pertama kali dipasang.
        const active = browserContext.pages().find(p => !p.isClosed() && p.url().includes(String(taxpayerId)) && p.url().includes(String(recordId)))
            || browserContext.pages().find(p => !p.isClosed() && /\/(corporate-income-tax-return|personal-income-tax-return|article-21-26-tax-return|withholding-tax-return|value-added-tax-return)\//i.test(p.url())) || page;
        return downloadLampiran(active, ctx, taxpayerId, recordId, taxTypeCode, mode);
    }); } catch (e) {}
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

module.exports = { installLampiranWidget, downloadLampiran, TAXTYPE_CONFIG, detectActiveTaxpayerName, preparePageForPrint };
