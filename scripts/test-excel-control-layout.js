const assert=require('assert'),fs=require('fs'),path=require('path'),ExcelJS=require('exceljs');
module.exports=async function(dir){
 dir=dir||fs.mkdtempSync(path.join(require('os').tmpdir(),'excel-control-'));
 const file=path.join(dir,'Kontrol Excel.xlsx');
 const label='Januari — JUMLAH TOTAL PENGHASILAN BRUTO DAN PAJAK PENGHASILAN YANG DITANGGUNG OLEH PEMERINTAH SERTA PAJAK PENGHASILAN YANG DIPOTONG';
 await require('../lib/lampiran-export').writeWorkbook([{label:'L-IA',fields:[],otherText:'',tables:[{title:'Tabel contoh',headers:['Masa','No.','NIK','Nama','Nomor Bukti','Penghasilan Bruto (Rp)','Pajak Penghasilan (Rp)'],rows:[['Januari','1','0012345678901234','Penerima contoh','00001','1.000','100']],moneyCols:[5,6],totals:{5:'1.000',6:'100'},sourceTotals:[{label,values:{5:'1.000',6:'100'}}],differences:{5:'0',6:'0'}}]}],{entity:'CONTOH',title:'SPT PPh 21',period:'2026'},file);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);const ws=wb.worksheets[0];
 assert.equal(ws.getCell('A10').value,label);assert.equal(ws.getCell('E10').master.address,'A10');assert.equal(ws.getCell('F10').value,1000);assert.equal(ws.getCell('G10').value,100);assert(ws.getRow(10).height<=50);assert.equal(ws.getCell('F9').value.result,1000);assert.equal(ws.getCell('C8').value,'0012345678901234');assert(!ws.getCell('C8').isMerged);assert.equal(ws.getCell('E11').master.address,'A11');
 console.log('PASS: total labels merge only blank cells; compact height; numeric values, formulas and recipient columns unchanged.');return file;
};
if(require.main===module)module.exports(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1});
