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
 const html=fs.readFileSync(path.join(__dirname,'../gui/public/index.html'),'utf8');
 await p.setContent(html.replace(/<script[\s\S]*?<\/script>/g,''));
 const app=fs.readFileSync(path.join(__dirname,'../gui/public/app.js'),'utf8');const start=app.indexOf('  function updateSptLampiranOptions() {'),end=app.indexOf("  document.querySelectorAll('.spt-jenis').forEach",start);
 await p.evaluate('const $=id=>document.getElementById(id);'+app.slice(start,end)+';window.updateSptLampiranOptions=updateSptLampiranOptions;');
 await p.evaluate(()=>{document.getElementById('spt-download-lampiran').checked=true;document.getElementById('spt-lampiran-format').value='excel';});await p.evaluate(()=>window.updateSptLampiranOptions());assert.equal(await p.locator('#spt-pdf-options').evaluate(n=>n.style.display),'none');
 await p.evaluate(()=>document.getElementById('spt-lampiran-format').value='both');await p.evaluate(()=>window.updateSptLampiranOptions());assert.equal(await p.locator('#spt-pdf-options').evaluate(n=>n.style.display),'block');
 assert.deepStrictEqual(await p.locator('#feature-tabs-download button').allTextContents(),['SPT','e-Bupot','Pajak Masukan','Bukti Potong Saya']);
 await p.evaluate("var sessionSummary={};var PROJECT_ORDER=['taxio_hub'];const $=id=>document.getElementById(id);"+app.slice(app.indexOf('  function isA1Restricted()'),app.indexOf('  // ---------- Connections bar'))+app.slice(app.indexOf("  let activeMode = 'download';"),app.indexOf('  // ---------- Dividen import'))+";window.setA1TestRole=role=>{sessionSummary={taxio_hub:{connected:true,role}};applyA1Access();};");
 await p.evaluate(()=>{document.getElementById('main-layout').style.display='grid';document.getElementById('action-form-body').style.display='block';});
 await p.locator('[data-mode="import"]').click();await p.locator('[data-feature="a1"]').click();
 assert(await p.locator('#feature-a1').isVisible());assert(await p.locator('#dl-fields').isVisible());await p.locator('#a1-year').fill('2026');
 await p.evaluate("window.setA1TestRole('restricted_editor');");assert(!(await p.locator('[data-feature=\"a1\"]').isVisible()));assert(!(await p.locator('#feature-a1').isVisible()));assert(await p.locator('.spt-jenis[value=\"pph21\"]').isDisabled());assert(!(await p.locator('.spt-jenis[value=\"pph21\"]').isChecked()));
 await p.evaluate("window.setA1TestRole('admin');");assert(await p.locator('[data-feature=\"a1\"]').isVisible());
 await p.locator('[data-mode="download"]').click();assert(await p.locator('#feature-spt').isVisible());assert(!(await p.locator('#feature-a1').isVisible()));
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
 const secret=require('../lib/lampiran-confidential');
 const summaries=['L-IA','L-IB','L-II','L-III'].map((code,i)=>({code,title:'Judul lampiran '+code,count:i,grossIncome:239487131,incomeTax:i===1?-101168:44500979,recipientName:'RECIPIENT_PRIVATE_SENTINEL',rows:[{NIK:'1234567890123456'}]}));
 assert(!secret.summaryTab(summaries).html.includes('RECIPIENT_PRIVATE_SENTINEL'));assert(!secret.summaryTab(summaries).html.includes('1234567890123456'));assert.throws(()=>secret.summaryTab(summaries.slice(1)),/harus mencakup/);assert.equal(secret.format(239487131),'239.487.131');
 const secretResult=await secret.renderConfidential(summaries,{entity:'ENTITAS UJI',period:'Juli 2026',title:'SPT Masa PPh 21',taxTypeCode:'ICT_WIT'},{dir,stem:'Confidential',outputLayout:'combined'});
 assert.equal(secretResult.paths.length,1);assert.equal(secretResult.sheets[0].tables[0].rows.length,4);assert.equal((await require('pdf-lib').PDFDocument.load(fs.readFileSync(secretResult.combinedPath))).getPageCount(),1);
 console.log('PASS: Confidential uses shared PDF renderer; four aggregate rows; no recipient details; negative and large totals.');
 console.log('PASS: actual PDF + Excel files for all five tax types. Packaged runtime: '+!!process.pkg);
 console.log('PASS: 0/50/51/615 rows; full totals; negative cents; text identifiers; dates; pagination completeness; PDF/Excel menu.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
