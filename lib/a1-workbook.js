const fs=require('fs'),path=require('path'),ExcelJS=require('exceljs');
const {writeWorkbook}=require('./lampiran-export');
const months=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function revision(row){
 const text=String(row.ReturnSheetModel||'Normal').trim();
 if(/^normal$/i.test(text))return 0;
 const m=/(?:amendment|pembetulan)\s*0*(\d+)/i.exec(text);
 if(!m)throw Error('Versi SPT tidak dikenali: '+text);
 return Number(m[1]);
}
function sumAmounts(values){
 let cents=0n;
 for(const raw of values){const value=String(raw||'0').replace(/\./g,'');if(!/^-?\d+(,\d{1,2})?$/.test(value))throw Error('Total tidak valid: '+raw);const [a,b='']=value.replace(/^-/,'').split(',');cents+=(value.startsWith('-')?-1n:1n)*(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));}
 const negative=cents<0n,c=negative?-cents:cents;return(negative?'-':'')+(c/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(c%100n?','+String(c%100n).padStart(2,'0'):'');
}
function combine(selected){
 const sheets=new Map();
 for(const item of selected){
  const masa=months[Number(item.masa.slice(0,2))-1];
  for(const sheet of item.sheets){
   if(!sheets.has(sheet.label))sheets.set(sheet.label,{label:sheet.label,tables:[],fields:[],otherText:''});
   const target=sheets.get(sheet.label);
   sheet.tables.forEach((table,i)=>{
    const headers=['Masa',...table.headers];
    if(!target.tables[i])target.tables[i]={...table,headers,rows:[],moneyCols:table.moneyCols.map(c=>c+1),totals:{},sourceTotals:[],differences:undefined};
    const dest=target.tables[i];
    if(JSON.stringify(dest.headers)!==JSON.stringify(headers))throw Error('Susunan kolom berubah pada '+sheet.label+' / '+masa+'. Excel tidak digabung agar data tidak salah kolom.');
    dest.rows.push(...table.rows.map(row=>[masa,...row]));
    for(const[col,v]of Object.entries(table.totals))dest.totals[Number(col)+1]=sumAmounts([dest.totals[Number(col)+1]||'0',v]);
    const shifted=values=>Object.fromEntries(Object.entries(values).map(([col,v])=>[Number(col)+1,v]));
    if(Object.keys(table.totals).length)dest.sourceTotals.push({label:'Total '+masa,values:shifted(table.totals)});
    for(const total of table.sourceTotals)dest.sourceTotals.push({label:masa+' — '+total.label,values:shifted(total.values)});
    if(table.differences)dest.sourceTotals.push({label:masa+' — Selisih total hitung terhadap sumber',values:shifted(table.differences)});
   });
   target.fields.push(...sheet.fields.map(row=>[masa+' — '+row[0],...row.slice(1)]));
  }
 }
 return [...sheets.values()];
}
class AnnualWorkbook {
 constructor(year){this.year=String(year);this.periods=new Map();this.completed=new Map();}
 register(masa,rows){this.periods.set(masa,rows.map(row=>({...row,revision:revision(row)})));}
 record(masa,row,sheets,pdfOk){this.completed.set(masa+'|'+row.RecordId,{masa,row,sheets,pdfOk});}
 async save(dir,entity){
  const selected=[],control=[];let partial=false;
  for(let m=1;m<=12;m++){
   const masa=String(m).padStart(2,'0')+this.year.slice(2),rows=this.periods.get(masa);
   if(!rows){partial=true;control.push([months[m-1],'','Belum diperiksa','Belum lengkap']);continue;}
   if(!rows.length){control.push([months[m-1],'','Belum ada SPT','Belum ada SPT']);continue;}
   const latest=Math.max(...rows.map(row=>row.revision));
   const candidates=rows.filter(row=>row.revision===latest);
   const ids=[...new Set(candidates.map(row=>row.RecordId))];
   if(ids.length!==1){partial=true;control.push([months[m-1],latest,'Versi terakhir ambigu','Perlu diperiksa']);continue;}
   const data=this.completed.get(masa+'|'+ids[0]);
   const pdfOk=rows.every(row=>this.completed.get(masa+'|'+row.RecordId)?.pdfOk);
   if(data?.sheets)selected.push(data);else partial=true;
   if(!pdfOk)partial=true;
   control.push([months[m-1],latest,data?.sheets?'Lengkap':'Gagal dibaca',pdfOk?'Lengkap, semua versi':'Belum lengkap']);
  }
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'Mode A1 - '+this.year+(partial?' - BELUM LENGKAP':'')+'.xlsx');
  await writeWorkbook(combine(selected),{entity,title:'Mode A1 — SPT PPh 21',period:'Tahun '+this.year},file);
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);
  const ws=wb.addWorksheet('Kontrol',{views:[{state:'frozen',ySplit:4}]});
  ws.addRow(['MODE A1 — '+this.year]);ws.addRow(['Excel: versi terakhir setiap masa. PDF: lengkap dan rahasia untuk seluruh versi.']);
  ws.addRow([partial?'BELUM LENGKAP — periksa masa di bawah.':'Seluruh masa telah diperiksa.']);
  ws.addRow(['Masa','Pembetulan terakhir (0 = normal)','Data Excel','PDF']);control.forEach(row=>ws.addRow(row));
  ws.columns.forEach((col,i)=>col.width=i===0?18:40);ws.eachRow(row=>row.eachCell(cell=>{cell.font={name:'Calibri',size:11};cell.alignment={wrapText:true,vertical:'top'};}));ws.getRow(2).height=45;ws.getRow(4).font={bold:true};
  await wb.xlsx.writeFile(file);return {file,partial,selected:selected.length,control};
 }
}
module.exports={AnnualWorkbook,combine,revision,sumAmounts};
