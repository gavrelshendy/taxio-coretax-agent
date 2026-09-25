const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');
const layout = require('./lampiran-snapshot-layout');
const monthlyLayout = require('./lampiran-layout-monthly');
const badanLayout = require('./lampiran-layout-badan');
const unifikasiLayout = require('./lampiran-layout-unifikasi');
const opFormalLayout = require('./lampiran-layout-op-formal');
const per11Pdf = require('./lampiran-per11-pdf');
const per11Answers = require('./lampiran-per11-answers');
const per11Op = require('./lampiran-op-per11.json');
const per11Badan = require('./lampiran-badan-per11.json');
/** Coretax shows one tab where PER-11 splits the same lampiran across several printed pages (OP
 *  tab "L-1" = Excel sheets L1-1/L1-2/L1-3), so the tab's spec is those sheets' tables in order.
 *  Badan sheets map 1:1 to tabs (e.g. tab "L1-B" = sheet "L1B" alone), which this same
 *  prefix-match naturally resolves to a single sheet since no other Badan sheet name shares that
 *  prefix (confirmed: "L10A".startsWith("L1A") is false, so "L1-A" can't accidentally sweep up
 *  "L10-A"/"L11-A"/etc). */
function per11Spec(source,label){
    const key=String(label||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const names=Object.keys(source).filter(n=>n.toUpperCase().replace(/[^A-Z0-9]/g,'').startsWith(key));
    if(!names.length)return null;
    const first=source[names[0]];
    // Everything the renderer can lay out has to travel with the spec: besides the columns, that is
    // the kop wording, the calculation form, the declaration checklist and the outline a list is
    // grouped under. Leaving one out silently falls back to the plain-table rendering.
    return {lampiran:first.lampiran,perhatian:first.perhatian,sector:first.sector||'',subtitle:first.subtitle||'',
        form:first.form||null,checklist:first.checklist||null,outline:first.outline||null,
        index:first.index,tables:names.flatMap(n=>source[n].tables)};
}
const finalize = require('./lampiran-finalize');
const references = require('./lampiran-tax-object-id.json');
const esc = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNumber = '#,##0';
const numberFormat = value => Number.isInteger(value) ? '#,##0' : '#,##0.00';
const logo = fs.readFileSync(path.join(__dirname, '../gui/public/assets/coretax-print-logo.png')).toString('base64');
// Badan's PER-11 template is set in Montserrat (bold titles/PERHATIAN) and Roboto Condensed
// (everything else, including table bodies - in dark green, not black) - confirmed cell-by-cell
// against the real government Excel file, not Arial like OP's template genuinely is. Both are
// bundled locally (lib/fonts/) and inlined as data: URIs because the render page aborts all
// network requests (`page.route('**/*',r=>r.abort())` below), so a @font-face pointing at Google's
// CDN would silently fail to load.
const fontsDir = path.join(__dirname, 'fonts');
const b64Font = name => fs.readFileSync(path.join(fontsDir, name)).toString('base64');
const badanFontFace = `
@font-face{font-family:'Montserrat';font-weight:700;font-style:normal;src:url(data:font/woff2;base64,${b64Font('montserrat-700.woff2')}) format('woff2')}
@font-face{font-family:'Roboto Condensed';font-weight:400;font-style:normal;src:url(data:font/woff2;base64,${b64Font('roboto-condensed-400.woff2')}) format('woff2')}
@font-face{font-family:'Roboto Condensed';font-weight:700;font-style:normal;src:url(data:font/woff2;base64,${b64Font('roboto-condensed-700.woff2')}) format('woff2')}`;
function numeric(text) {
    const s=String(text??'').trim().replace(/^Rp\.?\s*/i,'');
    if(!/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(s))return null;
    const value=Number(s.replace(/\./g,'').replace(',','.'));
    return Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER?value:null;
}
function typed(text,header,money=false){
    if(/NPWP|NIK|NITKU|NOMOR|KODE|ID TEMPAT|KAP|AKUN/i.test(header))return String(text??'');
    if(/TANGGAL/i.test(header)){
        const m=String(text).match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if(m){const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));if(d.getUTCDate()===+m[1]&&d.getUTCMonth()===+m[2]-1)return d;}
        return text;
    }
    if(money||/^NO\.?$|TARIF|TINGKAT/i.test(header)){const n=numeric(text);if(n!==null)return n;}
    return String(text??'');
}
async function writeWorkbook(sheets, meta, filePath){
    const wb=new ExcelJS.Workbook();wb.creator='Coretax Agent';wb.calcProperties.fullCalcOnLoad=true;
    const used=new Set();let tableId=0;
    for(const sheet of sheets){
        // A PER-11 lampiran is written as its filled form, one worksheet per form sheet.
        if(sheet.per11Excel&&sheet.per11Excel.entries&&sheet.per11Excel.entries.length){require('./lampiran-per11-excel').addFormSheets(wb,sheet.per11Excel.entries,used,sheet.per11Excel.kind);continue;}
        let base=sheet.label.replace(/[\\/*?:\[\]]/g,' ').slice(0,31)||'Lampiran',name=base,i=2;
        while(used.has(name.toLowerCase()))name=base.slice(0,26)+' ('+(i++)+')';used.add(name.toLowerCase());
        const ws=wb.addWorksheet(name,{views:[{state:'frozen',ySplit:sheet.tables.length?7:5}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0}});
        ws.addRow([meta.entity]);ws.addRow([meta.title+' — '+sheet.label]);ws.addRow([meta.period]);ws.addRow(['Sumber: Coretax. Seluruh data lampiran; satu sheet per lampiran.']);ws.addRow([]);
        const controlRows=[];
        const trackControl=(row,values)=>{const cols=Object.keys(values).map(Number);if(cols.length)controlRows.push({row,first:Math.min(...cols)});};
        const sheetWidth=Math.max(4,...sheet.tables.map(t=>t.headers.length));
        for(let c=1;c<=sheetWidth;c++)ws.getColumn(c).width=22;
        for(let r=1;r<=4;r++){ws.mergeCells(r,1,r,sheetWidth);ws.getRow(r).height=r===1?24:20;}
        for(let r=1;r<=3;r++)ws.getRow(r).font={name:'Calibri',size:r===1?14:11,bold:true,color:{argb:'FF222B5C'}};
        ws.getRow(4).font={name:'Calibri',size:10,color:{argb:'FF586174'}};
        for(const model of sheet.tables){
            const n=model.headers.length;if(!n)continue;
            const titleRow=ws.addRow([model.title]);ws.mergeCells(titleRow.number,1,titleRow.number,n);titleRow.height=24;titleRow.font={bold:true,color:{argb:'FF222B5C'}};
            const names=new Set();const columns=model.headers.map((h,i)=>{let name=h||'Kolom '+(i+1);while(names.has(name.toLowerCase()))name+=' ('+(i+1)+')';names.add(name.toLowerCase());return {name,filterButton:true};});
            const start=ws.rowCount+1;
            const values=model.rows.map(row=>model.headers.map((h,col)=>typed(row[col]??'',h,model.moneyCols.includes(col))));
            if(values.length){ws.addTable({name:'LampiranTable'+(++tableId),ref:'A'+start,headerRow:true,totalsRow:false,style:{theme:'TableStyleLight9',showRowStripes:true},columns,rows:values});}
            else{ws.addRow(columns.map(c=>c.name));ws.addRow(['Tidak ada data yang ditemukan.']);}
            const end=start+values.length;
            ws.getRow(start).height=45;
            ws.getRow(start).eachCell(cell=>{cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};cell.font={name:'Calibri',size:10,bold:true,color:{argb:'FF212529'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFDD44'}};});
            for(let row=start+1;row<=end;row++)ws.getRow(row).eachCell((cell,col)=>{
                const h=model.headers[col-1];const isMoney=model.moneyCols.includes(col-1);
                cell.font={name:'Calibri',size:10};cell.alignment={vertical:'top',wrapText:true,horizontal:isMoney?'right':/^(NO\.?$|NIK|NPWP|KODE|NOMOR|TANGGAL|FASILITAS|ID TEMPAT|NITKU|JENIS PAJAK|NEGARA|STATUS|KAP)/i.test(h)?'center':'left'};
                cell.numFmt=cell.value instanceof Date?'dd-mm-yyyy':typeof cell.value==='number'?(/TARIF|TINGKAT/i.test(h)?'0.00':numberFormat(cell.value)):'@';
            });
            if(Object.keys(model.totals).length){
                const row=ws.addRow(['Total seluruh '+values.length.toLocaleString('id-ID')+' baris']);
                for(const [col,total] of Object.entries(model.totals)){
                    const cell=row.getCell(+col+1),letter=cell.address.replace(/\d+/g,'');
                    cell.value=values.length?{formula:`SUM(${letter}${start+1}:${letter}${end})`,result:numeric(total)}:0;
                    cell.numFmt=numberFormat(numeric(total));
                }
                trackControl(row,model.totals);
                row.font={name:'Calibri',size:10,bold:true};row.eachCell(c=>c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEEF2F5'}});
            }
            for(const total of model.sourceTotals){const row=ws.addRow([total.label]);for(const [col,v]of Object.entries(total.values)){row.getCell(+col+1).value=numeric(v)??v;row.getCell(+col+1).numFmt=numberFormat(numeric(v));}row.font={name:'Calibri',size:10};trackControl(row,total.values);}
            if(model.differences){const row=ws.addRow(['Selisih total hitung terhadap Coretax']);for(const[col,v]of Object.entries(model.differences)){row.getCell(+col+1).value=numeric(v);row.getCell(+col+1).numFmt=numberFormat(numeric(v));}row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE5DC'}};trackControl(row,model.differences);}
            ws.addRow([]);
            model.headers.forEach((h,col)=>{const width=/NAMA|OBJEK PAJAK|ALAMAT|KETERANGAN/i.test(h)?40:/NIK|NPWP|NITKU|ID TEMPAT/i.test(h)?30:22;ws.getColumn(col+1).width=Math.max(ws.getColumn(col+1).width||0,width);});
        }
        if(sheet.fields.length){ws.getColumn(1).width=Math.max(ws.getColumn(1).width||0,60);ws.addRow(['Bagian formulir']);sheet.fields.forEach(values=>{const row=ws.addRow(values.map((value,i)=>i?typed(value,values[0],true):value));row.eachCell((cell,col)=>{cell.numFmt=typeof cell.value==='number'?numberFormat(cell.value):'@';cell.alignment={wrapText:true,vertical:'top',horizontal:col>1?'right':'left'};});});}
        if(sheet.otherText){ws.addRow(['Keterangan lampiran']);for(const sentence of sheet.otherText.match(/.{1,200}(?:\s|$)/g)||[sheet.otherText]){const row=ws.addRow([sentence]);ws.mergeCells(row.number,1,row.number,sheetWidth);row.height=30;}}
        // Merge only the blank label area of control rows, outside the filterable data table.
        for(const {row,first} of controlRows){
            if(first>1)ws.mergeCells(row.number,1,row.number,first);
            const label=row.getCell(1);label.alignment={wrapText:true,vertical:'middle',horizontal:'left'};
            const width=Array.from({length:Math.max(1,first)},(_,i)=>ws.getColumn(i+1).width||22).reduce((a,b)=>a+b,0);
            row.height=Math.max(20,Math.ceil(String(label.value||'').length/Math.max(8,width-4))*15+4);
            row.eachCell(cell=>{if(typeof cell.value==='number'||cell.value?.formula)cell.alignment={horizontal:'right',vertical:'middle',wrapText:false};});
        }
        ws.eachRow(row=>{let lines=1;row.eachCell(cell=>{if(!cell.font?.name)cell.font={...cell.font,name:'Calibri',size:11};if(!cell.alignment)cell.alignment={vertical:'top',wrapText:true};if(typeof cell.value==='string'&&row.number>5&&!cell.isMerged)lines=Math.max(lines,Math.ceil(cell.value.length/Math.max(8,(ws.getColumn(cell.col).width||22)-3)));});row.height=Math.max(row.height||15,Math.min(180,lines*15));});
    }
    await wb.xlsx.writeFile(filePath);
}
async function renderTabs(tabs,meta,{mode='full',format='pdf',dir,stem,outputLayout='combined',renderSession,layoutStyle='coretax'}={}){
    // QA hook: CORETAX_DUMP_TABS=<dir> saves the exact renderTabs input so a lampiran can be
    // re-rendered offline (lib/lampiran-per11-excel.js is developed against these dumps).
    if(process.env.CORETAX_DUMP_TABS){try{fs.mkdirSync(process.env.CORETAX_DUMP_TABS,{recursive:true});fs.writeFileSync(path.join(process.env.CORETAX_DUMP_TABS,String(meta.taxTypeCode||'X')+'-'+Date.now()+'.json'),JSON.stringify({tabs,meta,options:{mode,format,layoutStyle}}));}catch(e){}}
    const browser=renderSession?await renderSession.getBrowser():await chromium.launch({channel:'chrome',headless:true});
    let page;
    const sheets=[],buffers=[],paths=[];
    // PER-11 pages are printed together (one font set for the whole document); anything else that
    // comes between them flushes what was collected first, so the page order stays the tabs' order.
    let per11Pending=[];
    const flushPer11=async()=>{if(per11Pending.length){buffers.push(await per11Pdf.printFragments(browser,per11Pending));per11Pending=[];}};
    try{
        page=await browser.newPage({viewport:{width:1172,height:800}});
        await page.route('**/*',r=>r.abort());
        for(const tab of tabs){
            await page.setContent('<meta charset="utf-8"><style>'+layout.css+'</style>'+tab.html);
            // PER-11 (Badan/OP) is drawn from the government workbook by lib/lampiran-per11-pdf.js.
            // Its Ya/Tidak answers and ticks are read here, before the snapshot layout below
            // flattens those controls into plain text.
            // The annual SPT (Badan/OP) always uses them, PDF and Excel alike: the older "Tampilan
            // Coretax" layout was retired for it (2026-09-26); layoutStyle only matters for the rest.
            const per11=per11Pdf.supports(meta.taxTypeCode);
            const answers=per11?await page.evaluate(per11Answers):null;
            await page.evaluate(layout.prepare,tab);
            if(meta.taxTypeCode==='ICT_RCIT'&&tab.label==='L11-B')await page.evaluate(()=>{
                document.querySelectorAll('p-radiobutton').forEach(n=>{const span=document.createElement('span');span.textContent=(n.querySelector('.p-inputtext')?.textContent||'')+' '+(n.getAttribute('label')||'');n.replaceWith(span);});
                document.querySelectorAll('.p-field-checkbox').forEach(n=>{n.style.display='flex';n.style.gap='8mm';n.style.breakInside='avoid';});
            });
            if(meta.taxTypeCode==='ICT_RCIT')await page.evaluate(badanLayout,tab);
            await page.evaluate(meta.taxTypeCode==='ICT_WT'?unifikasiLayout:monthlyLayout,{...tab,references});
            await page.evaluate(require('./lampiran-bahasa'));
            const model=await page.evaluate(finalize,{mode,taxTypeCode:meta.taxTypeCode,references});
            if(per11){
                try{
                    const year=(String(meta.period||'').match(/\d{4}/)||[''])[0];
                    const result=await per11Pdf.renderTab(browser,{taxTypeCode:meta.taxTypeCode,label:tab.label,model,answers,npwp:meta.entityNpwp||'',year,mode});
                    if(result&&result.fragments.length){
                        if(result.unplaced.length)try{require('./log').log('[Lampiran PER-11] '+tab.label+' - data tanpa tempat di formulir: '+result.unplaced.slice(0,5).join(' | '));}catch(e){}
                        // The Excel copy is the same filled form (lib/lampiran-per11-excel.js).
                        sheets.push({label:tab.label,...model,per11Excel:{entries:result.excel,kind:result.kind}});
                        if(format==='excel')continue;
                        if(outputLayout==='combined'){per11Pending.push(...result.fragments);continue;}
                        const pdf=await per11Pdf.printFragments(browser,result.fragments);
                        buffers.push(pdf);
                        {const file=path.join(dir,stem+' - '+tab.label.replace(/[\/:*?"<>|]/g,'_')+'.pdf');fs.writeFileSync(file,pdf);paths.push(file);}
                        continue;
                    }
                }catch(e){try{require('./log').log('[Lampiran PER-11] '+tab.label+' memakai tampilan cadangan: '+e.message);}catch(_){}}
            }
            const per11Source=meta.taxTypeCode==='ICT_PIT'?per11Op:meta.taxTypeCode==='ICT_RCIT'?per11Badan:null;
            const formal=format!=='excel'&&(layoutStyle==='formal'||per11)&&per11Source?per11Spec(per11Source,tab.label):null;
            if(formal)await page.evaluate(opFormalLayout,{model,mode,spec:formal,taxTypeCode:meta.taxTypeCode,badanFontFace:meta.taxTypeCode==='ICT_RCIT'?badanFontFace:''});
            if(format!=='excel'&&meta.taxTypeCode==='ICT_WT')await page.evaluate(require('./lampiran-pdf-unifikasi'));
            const overflow = await page.evaluate(() => [...document.querySelectorAll('td,th')].filter(c=>c.getBoundingClientRect().width>0&&c.scrollWidth>c.clientWidth+2).map(c=>c.textContent.trim()));
            if(format!=='excel'&&overflow.length)throw new Error('Kolom PDF belum cukup lebar pada '+tab.label+': '+overflow.slice(0,3).join(', '));
            sheets.push({label:tab.label,...model});
            if(format==='excel')continue;
            await page.evaluate(()=>document.fonts.ready);
            await page.evaluate(require('./lampiran-paginate'));
            // PER-11 puts its own kop on every printed page (PERHATIAN box | section index +
            // NIK/NPWP | LAMPIRAN/HALAMAN badge), so in formal mode the app's branded header is
            // replaced by that form header. Every element needs an explicit font-size: Chromium
            // renders header/footer templates in a separate document that defaults to 0.
            const per11Year=(String(meta.period||'').match(/\d{4}/)||[''])[0]||String(meta.period||'');
            // PER-11 prints identifiers one digit per box; `ink` forces the fills to print, which
            // Chromium otherwise drops inside header/footer templates.
            const ink='-webkit-print-color-adjust:exact;print-color-adjust:exact';
            const digits=(value,size)=>String(value||'').padEnd(size,' ').slice(0,size).split('')
                .map(d=>`<span style="display:inline-block;border:.25pt solid #000;background:#fff;color:#000;width:2.4mm;height:3.1mm;line-height:3.1mm;text-align:center;font-size:5.5pt;margin-right:.2mm;font-family:Arial,Helvetica,sans-serif;${ink}">${esc(d.trim())}</span>`).join('');
            // Chromium renders header/footer templates as their own isolated document, so every
            // element gets an explicit font-family rather than relying on inheritance from the
            // outer div - a bare browser default (not Arial) was leaking into the kop otherwise.
            const fam='font-family:Arial,Helvetica,sans-serif';
            const isBadan=meta.taxTypeCode==='ICT_RCIT';
            // The two SPT families' kops are genuinely different documents, not a recolor of the
            // same layout (verified cell-by-cell against both government Excel files): OP's kop is
            // a PERHATIAN box | lettered A-E section index + NIK/NPWP | LAMPIRAN+HALAMAN badge +
            // TAHUN PAJAK. Badan's is a PERHATIAN box (with an optional sector label like "JASA"
            // above it on the L1A-L1L sheets) | a title block (SPT TAHUNAN.../DALAM MATA UANG
            // RUPIAH/REKONSILIASI checkbox/NPWP + TAHUN PAJAK side by side) | a LAMPIRAN-only badge
            // (Badan's template has no "HALAMAN" text anywhere in its kop).
            const opHeader=()=>`<div style="width:100%;margin:0 8mm;${fam};color:#000">`
                +`<table style="width:100%;border-collapse:collapse;border:1pt solid #1f3864;table-layout:fixed"><tr>`
                +`<td style="width:25%;border-right:1pt solid #1f3864;padding:1.4mm 2mm;background:#d8d8d8;vertical-align:top;${ink}">`
                +`<div style="font-size:6.5pt;font-weight:bold;${fam}">PERHATIAN:</div>`
                +`<div style="font-size:5.2pt;line-height:1.25;${fam}">${esc(formal.perhatian||'')}</div></td>`
                +`<td style="border-right:1pt solid #1f3864;padding:1.4mm 2mm;background:#1f3864;color:#fff;vertical-align:top;${ink}">`
                +(formal.index||[]).map(x=>`<table style="width:100%;border-collapse:collapse"><tr>`
                    +`<td style="width:5mm;font-size:6pt;line-height:1.35;color:#fff;padding:0;vertical-align:top;${fam}">${esc(x.letter)}</td>`
                    +`<td style="font-size:6pt;line-height:1.35;color:#fff;padding:0;${fam}">${esc(x.title)}</td></tr></table>`).join('')
                +`<div style="font-size:6.5pt;margin-top:1.4mm;color:#fff;white-space:nowrap;text-align:center;${fam}">NIK/NPWP &nbsp;${digits(meta.entityNpwp,16)}</div></td>`
                // PER-11 keeps TAHUN PAJAK in the white area under the gold badge, not inside the
                // navy block.
                +`<td style="width:24%;padding:1.6mm 3mm;text-align:center;background:#fff;vertical-align:middle;${ink}">`
                +`<div style="background:#ffd966;border:.5pt solid #bf8f00;padding:1.4mm 1mm;${ink}">`
                +`<div style="font-size:10pt;font-weight:bold;${fam}">${esc(formal.lampiran||('LAMPIRAN '+tab.label))}</div>`
                +`<div style="font-size:7pt;margin-top:.8mm;${fam}">HALAMAN <span class="pageNumber"></span></div></div>`
                +`<div style="font-size:6.5pt;margin-top:1.6mm;white-space:nowrap;text-align:center;${fam}">TAHUN PAJAK &nbsp;${digits(per11Year,4)}</div></td>`
                +`</tr></table></div>`;
            // Verified against a real Excel export of the L1A kop (rendered via Excel COM, not
            // guessed from cell metadata alone): the gold badge only covers the TOP of the green
            // block (level with the three title lines) - green resumes below it, at the same
            // width, holding "TAHUN PAJAK/BAGIAN TAHUN PAJAK" beside a thin gold divider from the
            // REKONSILIASI/NPWP column. That is a 2x2 grid (title|badge / rekonsiliasi+NPWP|tahun
            // pajak), not three side-by-side blocks like OP. Column split (title block vs the
            // badge/TAHUN PAJAK column) measured from the sheet's actual column widths: ~78%/22%.
            const fMont="font-family:'Montserrat',Arial,sans-serif";
            const fRC="font-family:'Roboto Condensed',Arial,sans-serif";
            // A single flat table with rowspan, not a table nested inside a table cell: nesting
            // two separate border-collapse contexts left a hairline gap where the gold badge's own
            // border met the outer table's border (visible as a sliver of gold "leaking" past its
            // corner into the green) - one table avoids that collision entirely.
            const badanHeader=()=>`<div style="width:100%;margin:0 8mm;${fRC};color:#000">`
                +`<style>${badanFontFace}</style>`
                +`<table style="width:100%;border-collapse:collapse;border:1pt solid #2d471d;table-layout:fixed">`
                +`<colgroup><col style="width:21%"><col style="width:55%"><col style="width:24%"></colgroup>`
                +`<tr>`
                +`<td rowspan="2" style="border-right:1pt solid #2d471d;padding:1.4mm 2mm;background:#e7e6e6;color:#2d471d;vertical-align:top;${ink}">`
                +(formal.sector?`<div style="font-size:7.5pt;font-weight:bold;text-align:center;margin-bottom:1mm;${fMont}">${esc(formal.sector)}</div>`:'')
                +`<div style="font-size:6.5pt;font-weight:bold;${fMont}">PERHATIAN</div>`
                +`<div style="font-size:5.2pt;line-height:1.25;font-weight:bold;${fMont}">${esc(formal.perhatian||'')}</div></td>`
                +`<td style="background:#2d471d;color:#fff;padding:1.4mm 3mm .8mm;vertical-align:top;${ink}">`
                +`<div style="font-size:11pt;font-weight:bold;${fMont}">SPT TAHUNAN</div>`
                +`<div style="font-size:8.5pt;font-weight:bold;margin-top:.3mm;${fMont}">${esc(String(meta.title||'').replace(/^SPT TAHUNAN\s*/i,'')||'PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN')}</div>`
                +`<div style="font-size:6.5pt;font-weight:bold;margin-top:.8mm;${fMont}">DALAM MATA UANG RUPIAH</div></td>`
                +`<td style="background:#ffd966;border:.5pt solid #bf8f00;text-align:center;vertical-align:middle;${ink}">`
                +`<div style="font-size:10pt;font-weight:bold;${fRC}">${esc(formal.lampiran||('LAMPIRAN '+tab.label))}</div></td>`
                +`</tr><tr>`
                +`<td style="background:#2d471d;color:#fff;padding:0 3mm 1.4mm;vertical-align:top;${ink}">`
                // Each sheet names itself on this line - "ANGSURAN PPh TAHUN PAJAK BERJALAN" on L6,
                // "DAFTAR FASILITAS PENGURANGAN PPh BADAN" on L13-C. It was fixed text here, which
                // only ever matched the L1 reconciliation family.
                +`<div style="font-size:6.8pt;margin-top:1mm;${fRC}">&#9632;&nbsp;${esc(formal.subtitle||'REKONSILIASI LAPORAN KEUANGAN')}</div>`
                +`<div style="font-size:6.5pt;margin-top:1.8mm;white-space:nowrap;${fRC}">NPWP &nbsp;${digits(meta.entityNpwp,15)}</div></td>`
                +`<td style="background:#2d471d;color:#fff;border-left:.6pt solid #ffd966;text-align:center;padding:1mm 2mm 1.4mm;vertical-align:top;${ink}">`
                +`<div style="font-size:5.3pt;line-height:1.2;${fRC}">TAHUN PAJAK/<br>BAGIAN TAHUN PAJAK</div>`
                +`<div style="margin-top:1mm">${digits(per11Year,4)}</div></td>`
                +`</tr></table></div>`;
            const formalHeader=formal?(isBadan?badanHeader():opHeader()):'';
            // Badan's real kop has no "HALAMAN" text anywhere, so unlike OP it needs a plain page
            // number somewhere for a multi-page PDF to stay navigable - a small neutral footer
            // (not styled as part of the official kop) rather than inventing a HALAMAN line that
            // isn't in the source.
            const badanFooter=`<div style="width:100%;margin:0 10mm;text-align:right;font:8px Arial;color:#586174">Halaman <span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
            const pdf=await page.pdf({width:'330mm',height:'210mm',printBackground:true,displayHeaderFooter:true,margin:{top:formal?'34mm':'24mm',bottom:'14mm',left:'10mm',right:'10mm'},headerTemplate:formal?formalHeader:`<div style="width:100%;margin:0 10mm;padding-bottom:3mm;border-bottom:1px solid #222b5c;display:flex;justify-content:space-between;font:10px Arial;color:#222b5c"><img src="data:image/png;base64,${logo}" style="width:46mm;height:8mm;object-fit:contain;margin-right:5mm;flex:0 0 auto"><b style="flex:1;text-align:center;align-self:center">${esc(meta.title)}<br>LAMPIRAN ${esc(tab.label)}</b><div style="text-align:right;flex:0 0 auto">${esc(meta.entity)}<br>${esc(meta.period)}</div></div>`,footerTemplate:formal?(isBadan?badanFooter:`<div></div>`)/* OP's kop already carries HALAMAN n */:`<div style="width:100%;margin:0 10mm;display:flex;justify-content:space-between;font:9px Arial;color:#586174"><span>${mode==='confidential'?'Confidential · Tanpa rincian penerima':mode==='print'?'PDF ringkas · Maksimal 50 baris per tabel':'PDF lengkap'} · Total seluruh data</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`});
            await flushPer11();
            buffers.push(pdf);
            if(outputLayout!=='combined'){const file=path.join(dir,stem+' - '+tab.label.replace(/[\\/:*?"<>|]/g,'_')+'.pdf');fs.writeFileSync(file,pdf);paths.push(file);}
        }
        await flushPer11();
        let combinedPath=null,excelPath=null;
        if(buffers.length&&outputLayout!=='separate'){const doc=await PDFDocument.create();for(const buffer of buffers){const p=await PDFDocument.load(buffer);for(const page of await doc.copyPages(p,p.getPageIndices()))doc.addPage(page);}combinedPath=path.join(dir,stem+'.pdf');fs.writeFileSync(combinedPath,await doc.save());paths.push(combinedPath);}
        if(format!=='pdf'){excelPath=path.join(dir,require('./spt-filenames').excelName(stem.replace(/ \((?:Print|Confidential)\)/g,'').replace(/ - (?:Ringkas|Lengkap|Confidential)$/,'')));await writeWorkbook(sheets,meta,excelPath);paths.push(excelPath);}
        return {paths,combinedPath,excelPath,sheets};
    }finally{if(renderSession){if(page)await page.close();}else await browser.close();}
}
function createRenderSession(){let pending;return {getBrowser(){return pending||(pending=chromium.launch({channel:'chrome',headless:true}));},async close(){if(pending){const browser=await pending;pending=undefined;await browser.close();}}};}

// `per11Spec` is exported so a preview or test builds the spec exactly the way the export does.
// Rebuilding it by hand elsewhere is how the checklist and outline silently went missing from the
// real PDFs while the preview looked right.
module.exports={renderTabs,writeWorkbook,numeric,typed,createRenderSession,per11Spec};
