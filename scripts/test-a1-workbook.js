const assert=require('assert'),fs=require('fs'),path=require('path'),ExcelJS=require('exceljs');
const {AnnualWorkbook,combine,revision,sumAmounts}=require('../lib/a1-workbook');
module.exports=async function(){
 const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'a1-regression-'));
 const sheet=value=>[{label:'L-IA',tables:[{title:'Tabel penerima',headers:['No.','NIK','Penghasilan Bruto (Rp)'],rows:[['1','0012345678901234',value]],moneyCols:[2],totals:{2:value},sourceTotals:[],records:true}],fields:[],otherText:''}];
 assert.equal(revision({ReturnSheetModel:'Amendment 002'}),2);assert.equal(revision({ReturnSheetModel:'Pembetulan 003'}),3);assert.throws(()=>revision({ReturnSheetModel:'Unknown'}));
 assert.equal(sumAmounts(['1.000','-1,25']),'998,75');
 assert.equal(sumAmounts(['239.487.131']),'239.487.131');
 assert.equal(sumAmounts([sumAmounts(['239.487.131']),'1.000']),'239.488.131');

 const book=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)book.register(String(m).padStart(2,'0')+'26',[]);
 const normal={RecordId:'normal',ReturnSheetModel:'Normal'},amended={RecordId:'amended',ReturnSheetModel:'Amendment 001'};
 book.register('0126',[normal,amended]);book.record('0126',normal,sheet('100'),true);book.record('0126',amended,sheet('200'),true);
 book.register('0226',[normal]);book.record('0226',normal,sheet('300'),true);
 let result=await book.save(dir,'ENTITAS UJI');assert.equal(result.partial,false);assert.equal(result.selected,2);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(result.file);const ws=wb.getWorksheet('L-IA');assert.equal(ws.getCell('A8').value,'Januari');assert.equal(ws.getCell('D8').value,200);assert.equal(ws.getCell('D9').value,300);assert.equal(ws.getCell('C8').value,'0012345678901234');assert.equal(ws.getCell('D10').value.result,500);assert.equal(wb.getWorksheet('Kontrol').rowCount,16);
 // Failure of the latest revision must never fall back to the normal return.
 book.record('0126',amended,undefined,false);result=await book.save(dir,'ENTITAS UJI');assert(result.partial);assert.equal(result.selected,1);assert(result.file.includes('BELUM LENGKAP'));
 const changed=sheet('100');changed[0].tables[0].headers[2]='Kolom baru';assert.throws(()=>combine([{masa:'0126',sheets:sheet('100')},{masa:'0226',sheets:changed}]),/Susunan kolom/);
 const available=new AnnualWorkbook(2026);
 for(let m=1;m<=12;m++){const masa=String(m).padStart(2,'0')+'26';available.register(masa,m<=8?[normal]:[]);if(m<=8)available.record(masa,normal,sheet('239.487.131'),true);}
 const ytd=await available.save(dir,'ENTITAS UJI');assert.equal(ytd.partial,false);assert.equal(ytd.selected,8);assert(ytd.control.slice(8).every(row=>row[2]==='Belum ada SPT'));
 const yearBook=new ExcelJS.Workbook();await yearBook.xlsx.readFile(ytd.file);assert.equal(yearBook.getWorksheet('L-IA').getCell('D16').value.result,1915897048);
 const empty=await new AnnualWorkbook(2026).save(dir,'ENTITAS UJI');assert(empty.partial);assert.equal(empty.selected,0);
 console.log('PASS: A1 latest revision; all-version PDF completeness; annual totals; Masa; IDs; no fallback on failure; schema mismatch.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
