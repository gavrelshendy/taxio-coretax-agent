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

const TEMP_NIK='9990000000999000';
const FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE699'}};
const sheetName=label=>label.replace(/[\/*?:\[\]]/g,' ').slice(0,31)||'Lampiran';
const toNumber=text=>Number(String(text).replace(/\./g,'').replace(',','.'));
/** Baris ber-NIK sementara (NIK asli tidak terbaca sistem lalu digantikan) disorot di semua sheet. */
function highlightTempNik(wb){
 let count=0;
 for(const ws of wb.worksheets){
  if(ws.name==='Kontrol')continue;
  ws.eachRow((row,number)=>{
   if(number<8)return;
   let hit=false;row.eachCell(cell=>{if(typeof cell.value==='string'&&cell.value.trim()===TEMP_NIK)hit=true;});
   if(!hit)return;count++;
   const width=Math.max(...ws.columns.map((c,i)=>c.width?i+1:0),row.cellCount);
   for(let c=1;c<=width;c++){const cell=row.getCell(c);cell.style={...cell.style,fill:FILL,font:{...cell.font,bold:true}};}
  });
 }
 return count;
}
/** BPMP (L-IA) dijumlahkan per NIK dengan SUMIFS. NIK sementara 9990000000999000 tidak boleh digabung
 *  satu (itu banyak orang berbeda): dipisah per nomor NIK lama di belakang tanda # pada nama,
 *  mis. "penerima penghasilan#1213123", dan disorot. Kriteria NIK diberi "*" agar Excel membandingkannya
 *  sebagai TEKS: tanpa itu SUMIFS mengubah NIK 16 digit jadi angka dan hanya membedakan 15 digit pertama. */
function addBpmpSummary(wb,sheets){
 const source=sheets.find(sheet=>sheet.label==='L-IA'),table=source&&source.tables[0];
 if(!table||!table.rows.length)return false;
 const ws0=wb.getWorksheet(sheetName('L-IA'));if(!ws0)return false;
 const nik=table.headers.findIndex(h=>/NIK|NPWP/i.test(h)),nama=table.headers.findIndex((h,i)=>i!==nik&&/^NAMA/i.test(h));
 if(nik<0)return false;
 const money=table.moneyCols.filter(c=>!/TARIF|TINGKAT/i.test(table.headers[c]));
 const first=8,last=7+table.rows.length,range=i=>"'"+ws0.name+"'!$"+ws0.getColumn(i+1).letter+'$'+first+':$'+ws0.getColumn(i+1).letter+'$'+last;
 const groups=new Map();
 for(const row of table.rows){
  const id=String(row[nik]||'').trim(),name=nama>=0?String(row[nama]||'').trim():'';
  let key='N|'+id,old='';
  if(id===TEMP_NIK){const m=/#\s*(\d+)\s*$/.exec(name);old=m?m[1]:'';key='T|'+(old||name.toLowerCase());}
  if(!groups.has(key))groups.set(key,{id,name,old,temp:id===TEMP_NIK,values:money.map(()=>[]),months:money.map(()=>Array.from({length:12},()=>[]))});
  const g=groups.get(key),m=months.indexOf(String(row[0]||'').trim());money.forEach((c,i)=>{g.values[i].push(row[c]);if(m>=0)g.months[i][m].push(row[c]);});
 }
 const ws=wb.addWorksheet('BPMP per NIK',{views:[{state:'frozen',xSplit:2,ySplit:5}]});
 ws.addRow(['BPMP (L-IA) — jumlah per NIK, seluruh masa']);
 ws.addRow(['Setiap angka = SUMIFS terhadap sheet L-IA. Total dan selisih terhadap sheet L-IA ada di bawah tabel.']);
 ws.addRow(['Baris BERWARNA = NIK sementara '+TEMP_NIK+' (NIK asli tidak terbaca sistem). Dipisah per nomor NIK lama di belakang # pada nama, bukan digabung satu.']);
 const nMoney=money.length,monthStart=5+nMoney,short=months.map(m=>m.slice(0,3));
 const groupRow=ws.addRow([]);
 groupRow.getCell(5).value='TOTAL SELURUH MASA';if(nMoney>1)ws.mergeCells(4,5,4,4+nMoney);
 money.forEach((c,i)=>{const from=monthStart+i*12;groupRow.getCell(from).value=String(table.headers[c]).toUpperCase().replace('(RP)','(Rp)')+' — PER MASA';ws.mergeCells(4,from,4,from+11);});
 groupRow.eachCell({includeEmpty:false},cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF222B5C'}};cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.alignment={horizontal:'center',vertical:'middle'};});groupRow.height=20;
 const headers=['NIK','Nama','NIK lama (dari #)','Jumlah masa',...money.map(c=>table.headers[c]),...money.flatMap(()=>short)];
 ws.addRow(headers);
 const head=ws.getRow(5);head.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFDD44'}};cell.font={bold:true};cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};});head.height=32;
 let r=5;
 for(const g of groups.values()){
  r++;
  const byName=g.temp&&nama>=0?(g.old?'"*#"&$C'+r:'$B'+r):'';
  const cond=range(nik)+',$A'+r+'&"*"'+(byName?','+range(nama)+','+byName:'');
  const row=ws.addRow([g.id,g.name,g.old,{formula:'COUNTIFS('+cond+')',result:g.values[0]?g.values[0].length:0},...money.map((c,i)=>({formula:'SUMIFS('+range(c)+','+cond+')',result:toNumber(sumAmounts(g.values[i]))})),...money.flatMap((c,i)=>months.map((name,m)=>({formula:'SUMIFS('+range(c)+','+cond+','+range(0)+',"'+name+'")',result:g.months[i][m].length?toNumber(sumAmounts(g.months[i][m])):0})))]);
  row.getCell(1).numFmt='@';row.getCell(3).numFmt='@';
  for(let i=0;i<money.length;i++)row.getCell(5+i).numFmt='#,##0';
  for(let c=monthStart;c<monthStart+nMoney*12;c++)row.getCell(c).numFmt='#,##0;-#,##0;"-"';
  if(g.temp)row.eachCell({includeEmpty:true},cell=>{cell.style={...cell.style,fill:FILL,font:{bold:true}};});
 }
 const total=ws.addRow(['Total']),diff=ws.addRow(['Selisih terhadap sheet L-IA (harus 0)']);
 money.forEach((c,i)=>{const letter=ws.getColumn(5+i).letter,sum=[...groups.values()].reduce((a,g)=>a+toNumber(sumAmounts(g.values[i])),0);
  total.getCell(5+i).value={formula:'SUM('+letter+'6:'+letter+r+')',result:sum};total.getCell(5+i).numFmt='#,##0';
  diff.getCell(5+i).value={formula:letter+total.number+'-SUM('+range(c)+')',result:0};diff.getCell(5+i).numFmt='#,##0';});
 money.forEach((c,i)=>months.forEach((name,m)=>{const col=monthStart+i*12+m,letter=ws.getColumn(col).letter,sum=[...groups.values()].reduce((a,g)=>a+(g.months[i][m].length?toNumber(sumAmounts(g.months[i][m])):0),0);total.getCell(col).value={formula:'SUM('+letter+'6:'+letter+r+')',result:sum};total.getCell(col).numFmt='#,##0;-#,##0;"-"';}));
 total.font={bold:true};total.eachCell({includeEmpty:true},cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEEF2F5'}};});
 ws.columns.forEach((col,i)=>col.width=i===0?20:i===1?34:i<4?18:i<monthStart-1?20:15);
 ws.getRow(1).font={bold:true,size:14};
 return true;
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
  const sheets=combine(selected);
  await writeWorkbook(sheets,{entity,title:'Mode A1 — SPT PPh 21',period:'Tahun '+this.year},file);
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);
  addBpmpSummary(wb,sheets);const flagged=highlightTempNik(wb);
  const ws=wb.addWorksheet('Kontrol',{views:[{state:'frozen',ySplit:4}]});
  ws.addRow(['MODE A1 — '+this.year]);ws.addRow(['Excel: versi terakhir setiap masa. PDF: lengkap dan rahasia untuk seluruh versi.']);
  ws.addRow([partial?'BELUM LENGKAP — periksa masa di bawah.':'Seluruh masa telah diperiksa.']);
  ws.addRow(['Masa','Pembetulan terakhir (0 = normal)','Data Excel','PDF']);control.forEach(row=>ws.addRow(row));
  ws.columns.forEach((col,i)=>col.width=i===0?18:40);ws.eachRow(row=>row.eachCell(cell=>{cell.font={name:'Calibri',size:11};cell.alignment={wrapText:true,vertical:'top'};}));ws.getRow(2).height=45;ws.getRow(4).font={bold:true};
  await wb.xlsx.writeFile(file);return {file,partial,selected:selected.length,control,tempNikRows:flagged};
 }
}
module.exports={AnnualWorkbook,combine,revision,sumAmounts,TEMP_NIK,addBpmpSummary,highlightTempNik};
