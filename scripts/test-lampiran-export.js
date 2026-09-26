const assert=require('assert'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const finalize=require('../lib/lampiran-finalize');
const {collectTab}=require('../lib/lampiran-capture');
const {typed}=require('../lib/lampiran-export');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{const p=await browser.newPage();
 for(const size of [0,50,51,615]){
  const rows=Array.from({length:size},(_,i)=>`<tr><td>${i%10+1}</td><td>0012345678901234567890</td><td>${i===0?'-1,25':'1.000'}</td><td>2,00</td></tr>`).join('');
  const source=`<table><thead><tr><th>No.</th><th>NITKU</th><th>Penghasilan Bruto (Rp)</th><th>Tarif (%)</th></tr></thead><tbody>${rows}</tbody></table>`;
  await p.setContent(source);const model=await p.evaluate(finalize,{mode:'print',references:{}});
  assert.equal(model.tables[0].rows.length,size);assert.equal(await p.locator('tbody tr').count(),Math.min(50,size));
  assert.equal(await p.locator('.omitted').count(),size>50?1:0);assert.equal(Object.keys(model.tables[0].totals).length,1);
  const expected=size?((size-1)*1000-1.25):0;assert.equal(require('../lib/lampiran-export').numeric(model.tables[0].totals[2]),expected);
  await p.setContent(source);const full=await p.evaluate(finalize,{mode:'full',references:{}});assert.deepStrictEqual(full.tables,model.tables);assert.equal(await p.locator('tbody tr').count(),size);
 }
 await p.evaluate(()=>{document.querySelector('thead').style.height='160px';});
 await p.evaluate(require('../lib/lampiran-paginate'));
 assert.equal(await p.locator('tbody tr:not(.control-total)').count(),615);assert.equal(await p.locator('.control-end').count(),1);assert(await p.locator('table').count()>1);
 assert.strictEqual(typed('0012345678901234567890','NITKU'),'0012345678901234567890');assert(typed('01-07-2026','TANGGAL') instanceof Date);
 // A real paginator fixture tests the collector rather than merely checking generated output.
 await p.setContent(`<div id="root"><div class="p-tabview-panel"><p-table><table><thead><tr><th>No.</th><th>Nilai (Rp)</th></tr></thead><tbody></tbody></table><div class="p-paginator"><span></span><button class="p-paginator-first">First</button><button class="p-paginator-next">Next</button></div></p-table></div></div>`);
 await p.evaluate(()=>{let page=0;const draw=()=>{document.querySelector('tbody').innerHTML=Array.from({length:page===2?1:10},(_,i)=>'<tr><td>'+(i+1)+'</td><td>'+((page*10)+i+1)+'</td></tr>').join('');document.querySelector('.p-paginator span').textContent='Menampilkan '+(page*10+1)+' dari 21 entri';document.querySelector('.p-paginator-first').disabled=page===0;document.querySelector('.p-paginator-next').disabled=page===2;};document.querySelector('.p-paginator-first').onclick=()=>{page=0;draw()};document.querySelector('.p-paginator-next').onclick=()=>{page++;draw()};draw();});
 const tab=await collectTab(p,'#root','Fixture');assert.equal(tab.tables[0].collectedRows,21);assert.equal(tab.tables[0].expected,21);
 await p.evaluate(()=>{document.querySelector('.p-paginator span').textContent='dari 22 entri';document.querySelector('.p-paginator-next').disabled=true;});await assert.rejects(collectTab(p,'#root','Fixture'),/belum lengkap/);
﻿ // Pemeriksaan tampilan yang dulu ada di sini (opsi PDF lampiran tersembunyi saat format Excel, tombol A1 dan PPh 21
 // untuk Restricted, tab fitur) terikat ke id elemen dashboard lama. Sejak dashboard ditulis ulang (Taxio Pilot)
 // pemeriksaan yang sama dijalankan di scripts/test-gui-ui.js terhadap tampilan yang sebenarnya.

 // Remove only the PDF description column, retaining codes, totals and empty-row spans.
 await p.setContent('<table><colgroup><col style="width:20%"><col style="width:40%"><col style="width:40%"></colgroup><thead><tr><th>Kode Objek Pajak</th><th>Objek Pajak</th><th>Nilai (Rp)</th></tr></thead><tbody><tr><td>28-403-02</td><td>Land and/or building rental</td><td>1.000</td></tr><tr><td colspan="3">Tidak ada data</td></tr></tbody><tfoot><tr><td colspan="2">Total</td><td>1.000</td></tr></tfoot></table>');
 await p.evaluate(require('../lib/lampiran-pdf-unifikasi'));
 assert.equal(await p.locator('thead th').count(),2);assert.equal(await p.locator('tbody tr').first().textContent(),'28-403-021.000');
 assert.equal(await p.locator('tbody tr').last().locator('td').getAttribute('colspan'),'2');assert.equal(await p.locator('tfoot td').first().getAttribute('colspan'),'1');
 assert.equal(await p.locator('colgroup col').count(),2);
 await p.setContent('<table><thead><tr><th>No.</th><th>Penghasilan Bruto (Rp)</th></tr></thead><tbody><tr><td>1</td><td>100</td></tr></tbody><tfoot><tr><td>TOTAL INCOME PAX TO BE PAID</td><td>100</td></tr></tfoot></table>');
 await p.evaluate(require('../lib/lampiran-bahasa'));const translated=await p.evaluate(finalize,{mode:'full',references:{}});
 assert.equal(translated.tables[0].sourceTotals[0].label,'JUMLAH PAJAK PENGHASILAN YANG HARUS DIBAYAR');assert(!(await p.locator('tfoot').textContent()).includes('(Coretax)'));
 await require('./test-a1-workbook')();
 await require('./test-a1-access')();
 require('./test-spt-bpe-package');
 // Exercise every production rendering callback from the packaged executable too.
 const {renderTabs}=require('../lib/lampiran-export');
 const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'coretax-export-regression-'));
 const fixture={label:'L-IA',html:'<p-table data-op-table="0"><table><thead><tr><th>No.</th><th>NITKU</th><th>Penghasilan Bruto (Rp)</th></tr></thead><tbody></tbody></table></p-table>',tables:[{index:0,bodies:['<tr><td>1</td><td>0012345678901234567890</td><td>1.000</td></tr>'],footer:''}]};
 for(const taxTypeCode of ['ICT_WIT','ICT_WT','VAT_VAT','ICT_RCIT','ICT_PIT']){
  const result=await renderTabs([fixture],{entity:'UJI LOKAL',period:'Agustus 2026',title:'Uji lampiran',taxTypeCode},{mode:'print',format:'both',dir,stem:taxTypeCode,outputLayout:'combined'});
  assert.equal(result.paths.length,2);
  const pdf=await require('pdf-lib').PDFDocument.load(fs.readFileSync(result.combinedPath));assert(pdf.getPageCount()>0);
  const wb=new (require('exceljs').Workbook)();await wb.xlsx.readFile(result.excelPath);
  assert.equal(wb.worksheets.length,1);assert.equal(result.sheets[0].tables[0].rows[0][1],'0012345678901234567890');
 }
 // The annual SPT's Excel is the filled PER-11 form: one worksheet per form sheet, Coretax's
 // colours, amounts as numbers, identifiers as text.
 {
  const per11Pdf=require('../lib/lampiran-per11-pdf');const {amount}=require('../lib/lampiran-per11-excel');
  assert.deepEqual(amount('1.234.567',{h:'right'}),{value:1234567,numFmt:'#,##0'});assert.equal(amount('(1.234)',{h:'right'}).value,-1234);
  assert.equal(amount('0,2500',{h:'right'}).numFmt,'#,##0.0000');assert.equal(amount('0102',{h:'center'}),null);assert.equal(amount('2025',{h:'center'}),null);assert.equal(amount('3400000000000001',{h:'center'}),null);
  const model={tables:[{title:'A. DAFTAR PEMEGANG SAHAM/PEMILIK MODAL DAN JUMLAH DIVIDEN/PEMBAGIAN LABA YANG DIBAGIKAN SERTA DAFTAR SUSUNAN PENGURUS DAN KOMISARIS',headers:['NO.','NAMA','ALAMAT','NEGARA','NPWP/NIK','Jabatan','Modal Disetor / NILAI (Rp)','Modal Disetor / %','DIVIDEN/PEMBAGIAN LABA(Rp)'],rows:[['1','PEMEGANG UJI','JL UJI 1','Indonesia','3400000000000001','Komisaris','38.400.000','100,0000','0']],totals:{6:'38.400.000',8:'0'}}],fields:[]};
  const b=await chromium.launch({channel:'chrome',headless:true});
  try{
   const r=await per11Pdf.renderTab(b,{taxTypeCode:'ICT_RCIT',label:'L2',model,answers:null,npwp:'012345678901000',year:'2025',mode:'full'});
   assert(r&&r.excel.length===1&&r.fragments.length===1);
   const file=path.join(dir,'per11-excel.xlsx');
   await require('../lib/lampiran-export').writeWorkbook([{label:'L2',...model,per11Excel:{entries:r.excel,kind:r.kind}}],{entity:'UJI',title:'SPT',period:'2025'},file);
   const wb=new (require('exceljs').Workbook)();await wb.xlsx.readFile(file);
   const ws=wb.getWorksheet('Lampiran 2');assert(ws,'worksheet Lampiran 2');
   const cells=[];ws.eachRow(row=>row.eachCell(c=>cells.push(c)));
   assert(cells.some(c=>c.value===38400000),'amount as a number');assert(cells.some(c=>c.value==='3400000000000001'),'NPWP as text');
   assert(cells.some(c=>c.fill&&c.fill.fgColor&&c.fill.fgColor.argb==='FFFFD600'),'Coretax yellow in the kop');
  }finally{await b.close();}
  console.log('PASS: annual SPT Excel = filled PER-11 form (sheet per form, amounts numeric, identifiers text, Coretax colours).');
 }
 const secret=require('../lib/lampiran-confidential');
 const summaries=['L-IA','L-IB','L-II','L-III'].map((code,i)=>({code,title:'Judul lampiran '+code,count:i,grossIncome:239487131,incomeTax:i===1?-101168:44500979,recipientName:'RECIPIENT_PRIVATE_SENTINEL',rows:[{NIK:'1234567890123456'}]}));
 assert(!secret.summaryTab(summaries).html.includes('RECIPIENT_PRIVATE_SENTINEL'));assert(!secret.summaryTab(summaries).html.includes('1234567890123456'));assert.throws(()=>secret.summaryTab(summaries.slice(1)),/harus mencakup/);assert.equal(secret.format(239487131),'239.487.131');
 const secretResult=await secret.renderConfidential(summaries,{entity:'ENTITAS UJI',period:'Juli 2026',title:'SPT Masa PPh 21',taxTypeCode:'ICT_WIT'},{dir,stem:'Confidential',outputLayout:'combined'});
 assert.equal(secretResult.paths.length,1);assert.equal(secretResult.sheets[0].tables[0].rows.length,4);assert.equal((await require('pdf-lib').PDFDocument.load(fs.readFileSync(secretResult.combinedPath))).getPageCount(),1);
 await require('./test-excel-control-layout')(dir);
 const session=require('../lib/lampiran-export').createRenderSession();
 let shared;
 try{
  shared=await session.getBrowser();
  const first=await renderTabs([fixture],{entity:'UJI',period:'2026',title:'SPT',taxTypeCode:'ICT_WIT'},{dir,stem:'Shared full',mode:'full',format:'pdf',renderSession:session});
  const second=await secret.renderConfidential(summaries,{entity:'UJI',period:'2026',title:'SPT',taxTypeCode:'ICT_WIT'},{dir,stem:'Shared confidential',renderSession:session});
  assert.equal(await session.getBrowser(),shared);assert.equal(shared.contexts().length,0);assert(first.combinedPath&&second.combinedPath);
  await assert.rejects(secret.renderConfidential(summaries.slice(1),{},{renderSession:session}),/harus mencakup/);assert(shared.isConnected());
 }finally{await session.close();}assert(!shared.isConnected());
 console.log('PASS: full and Confidential reuse one browser; render pages and browser are closed.');
 console.log('PASS: Confidential uses shared PDF renderer; four aggregate rows; no recipient details; negative and large totals.');
 console.log('PASS: actual PDF + Excel files for all five tax types. Packaged runtime: '+!!process.pkg);
 console.log('PASS: 0/50/51/615 rows; full totals; negative cents; text identifiers; dates; pagination completeness; PDF/Excel menu.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
