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

 // BPMP per NIK (SUMIFS) + NIK sementara 9990000000999000 dipisah per nomor di belakang # dan disorot.
 const bpmp=(nik,name,value)=>[nik,name,value];
 const rows=[['1','1111111111111111','BUDI','1.000'],['2','9990000000999000','penerima penghasilan#1213123','500'],['3','9990000000999000','penerima penghasilan#9999','700']];
 const bpmpSheet=(rs)=>[{label:'L-IA',tables:[{title:'Tabel',headers:['No.','NIK/NPWP','Nama','Penghasilan Bruto (Rp)'],rows:rs,moneyCols:[3],totals:{3:sumAmounts(rs.map(r=>r[3]))},sourceTotals:[],records:true}],fields:[],otherText:''}];
 const tb=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)tb.register(String(m).padStart(2,'0')+'26',[]);
 tb.register('0126',[normal]);tb.record('0126',normal,bpmpSheet(rows),true);tb.register('0226',[normal]);tb.record('0226',normal,bpmpSheet([['1','1111111111111111','BUDI','2.000'],['2','9990000000999000','penerima penghasilan#1213123','250']]),true);
 const tr=await tb.save(dir,'ENTITAS UJI');assert.equal(tr.tempNikRows,4);
 const twb=new ExcelJS.Workbook();await twb.xlsx.readFile(tr.file);const sum=twb.getWorksheet('BPMP per NIK');assert(sum,'sheet BPMP per NIK ada');
 const cell=(r,c)=>{const v=sum.getCell(r,c).value;return v&&typeof v==="object"&&v.formula?(v.result||0):v;};
 assert.equal(cell(6,1),'1111111111111111');assert.equal(cell(6,5),3000);
 assert.equal(cell(7,3),'1213123');assert.equal(cell(7,5),750);assert.equal(cell(8,3),'9999');assert.equal(cell(8,5),700);
 assert.match(sum.getCell(6,5).value.formula,/^SUMIFS\('L-IA'!\$E\$8:\$E\$12,'L-IA'!\$C\$8:\$C\$12,\$A6&"\*"\)$/);
 assert.match(sum.getCell(7,5).value.formula,/'L-IA'!\$D\$8:\$D\$12,"\*#"&\$C7\)$/);
 assert.equal(sum.getCell(7,1).fill.fgColor.argb,'FFFFE699');assert.notEqual((sum.getCell(6,1).fill||{}).fgColor?.argb,'FFFFE699');
 assert.equal(twb.getWorksheet('L-IA').getCell('C9').fill.fgColor.argb,'FFFFE699');assert.notEqual((twb.getWorksheet('L-IA').getCell('C8').fill||{}).fgColor?.argb,'FFFFE699');
 assert.equal(cell(9,5),4450);
 // Ringkasan menyamping per masa: kolom 6..17 = Jan..Des (Bruto).
 assert.equal(cell(6,6),1000);assert.equal(cell(6,7),2000);assert.equal(cell(6,8),0);assert.equal(cell(7,6),500);assert.equal(cell(7,7),250);assert.equal(cell(8,6),700);assert.equal(cell(9,6),2200);assert.equal(cell(9,7),2250);
 assert.match(sum.getCell(6,7).value.formula,/,'L-IA'!\$A\$8:\$A\$12,"Februari"\)$/);assert.equal(sum.getCell(5,6).value,'Jan');assert.equal(sum.getCell(5,17).value,'Des');
 console.log('PASS: A1 latest revision; all-version PDF completeness; annual totals; Masa; IDs; no fallback on failure; schema mismatch.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
