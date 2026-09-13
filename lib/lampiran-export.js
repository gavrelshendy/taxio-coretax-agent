const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');
const layout = require('./lampiran-snapshot-layout');
const monthlyLayout = require('./lampiran-layout-monthly');
const badanLayout = require('./lampiran-layout-badan');
const unifikasiLayout = require('./lampiran-layout-unifikasi');
const finalize = require('./lampiran-finalize');
const references = require('./lampiran-tax-object-id.json');
const esc = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNumber = '#,##0';
const numberFormat = value => Number.isInteger(value) ? '#,##0' : '#,##0.00';
const logo = fs.readFileSync(path.join(__dirname, '../gui/public/assets/coretax-print-logo.png')).toString('base64');
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
async function renderTabs(tabs,meta,{mode='full',format='pdf',dir,stem,outputLayout='combined',renderSession}={}){
    const browser=renderSession?await renderSession.getBrowser():await chromium.launch({channel:'chrome',headless:true});
    let page;
    const sheets=[],buffers=[],paths=[];
    try{
        page=await browser.newPage({viewport:{width:1172,height:800}});
        await page.route('**/*',r=>r.abort());
        for(const tab of tabs){
            await page.setContent('<meta charset="utf-8"><style>'+layout.css+'</style>'+tab.html);
            await page.evaluate(layout.prepare,tab);
            if(meta.taxTypeCode==='ICT_RCIT'&&tab.label==='L11-B')await page.evaluate(()=>{
                document.querySelectorAll('p-radiobutton').forEach(n=>{const span=document.createElement('span');span.textContent=(n.querySelector('.p-inputtext')?.textContent||'')+' '+(n.getAttribute('label')||'');n.replaceWith(span);});
                document.querySelectorAll('.p-field-checkbox').forEach(n=>{n.style.display='flex';n.style.gap='8mm';n.style.breakInside='avoid';});
            });
            if(meta.taxTypeCode==='ICT_RCIT')await page.evaluate(badanLayout,tab);
            await page.evaluate(meta.taxTypeCode==='ICT_WT'?unifikasiLayout:monthlyLayout,{...tab,references});
            await page.evaluate(require('./lampiran-bahasa'));
            const model=await page.evaluate(finalize,{mode,taxTypeCode:meta.taxTypeCode,references});
            if(format!=='excel'&&meta.taxTypeCode==='ICT_WT')await page.evaluate(require('./lampiran-pdf-unifikasi'));
            const overflow = await page.evaluate(() => [...document.querySelectorAll('td,th')].filter(c=>c.getBoundingClientRect().width>0&&c.scrollWidth>c.clientWidth+2).map(c=>c.textContent.trim()));
            if(format!=='excel'&&overflow.length)throw new Error('Kolom PDF belum cukup lebar pada '+tab.label+': '+overflow.slice(0,3).join(', '));
            sheets.push({label:tab.label,...model});
            if(format==='excel')continue;
            await page.evaluate(()=>document.fonts.ready);
            await page.evaluate(require('./lampiran-paginate'));
            const pdf=await page.pdf({width:'330mm',height:'210mm',printBackground:true,displayHeaderFooter:true,margin:{top:'24mm',bottom:'14mm',left:'10mm',right:'10mm'},headerTemplate:`<div style="width:100%;margin:0 10mm;padding-bottom:3mm;border-bottom:1px solid #222b5c;display:flex;justify-content:space-between;font:10px Arial;color:#222b5c"><img src="data:image/png;base64,${logo}" style="width:46mm;height:8mm;object-fit:contain;margin-right:5mm"><b>${esc(meta.title)}<br>LAMPIRAN ${esc(tab.label)}</b><div style="text-align:right">${esc(meta.entity)}<br>${esc(meta.period)}</div></div>`,footerTemplate:`<div style="width:100%;margin:0 10mm;display:flex;justify-content:space-between;font:9px Arial;color:#586174"><span>${mode==='confidential'?'Confidential · Tanpa rincian penerima':mode==='print'?'PDF ringkas · Maksimal 50 baris per tabel':'PDF lengkap'} · Total seluruh data</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`});
            buffers.push(pdf);
            if(outputLayout!=='combined'){const file=path.join(dir,stem+' - '+tab.label.replace(/[\\/:*?"<>|]/g,'_')+'.pdf');fs.writeFileSync(file,pdf);paths.push(file);}
        }
        let combinedPath=null,excelPath=null;
        if(buffers.length&&outputLayout!=='separate'){const doc=await PDFDocument.create();for(const buffer of buffers){const p=await PDFDocument.load(buffer);for(const page of await doc.copyPages(p,p.getPageIndices()))doc.addPage(page);}combinedPath=path.join(dir,stem+'.pdf');fs.writeFileSync(combinedPath,await doc.save());paths.push(combinedPath);}
        if(format!=='pdf'){excelPath=path.join(dir,stem.replace(/ \((?:Print|Ringkas|Lengkap|Confidential|Rahasia)\)/g,'').replace(/ - (?:Ringkas|Lengkap|Confidential)$/,'')+'.xlsx');await writeWorkbook(sheets,meta,excelPath);paths.push(excelPath);}
        return {paths,combinedPath,excelPath,sheets};
    }finally{if(renderSession){if(page)await page.close();}else await browser.close();}
}
function createRenderSession(){let pending;return {getBrowser(){return pending||(pending=chromium.launch({channel:'chrome',headless:true}));},async close(){if(pending){const browser=await pending;pending=undefined;await browser.close();}}};}

module.exports={renderTabs,writeWorkbook,numeric,typed,createRenderSession};
