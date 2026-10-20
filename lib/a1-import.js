const ExcelJS=require('exceljs');
const {AnnualWorkbook}=require('./a1-workbook');
const months=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const DERIVED=new Set(['BPMP per NIK','Analisis NIK','Draft Pembetulan','Kontrol']);

/** Excel cell back to the text Coretax shows ("1.234.567", "31-01-2026"), as the lampiran model stores it. */
function text(value){
 if(value===null||value===undefined)return '';
 if(value instanceof Date){const p=n=>String(n).padStart(2,'0');return p(value.getUTCDate())+'-'+p(value.getUTCMonth()+1)+'-'+value.getUTCFullYear();}
 if(typeof value==='object'){if('result' in value)return text(value.result);if(value.richText)return value.richText.map(r=>r.text).join('');if('text' in value)return String(value.text);}
 if(typeof value==='number'){
  const neg=value<0,abs=Math.abs(value),int=Math.trunc(abs),frac=Math.round((abs-int)*100);
  return (neg?'-':'')+String(int).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(frac?','+String(frac).padStart(2,'0').replace(/0$/,''):'');
 }
 return String(value);
}
const masaOf=label=>{const m=/^(\S+)/.exec(label);return m&&months.includes(m[1])?m[1]:null;};

/** Membaca Excel Mode A1 buatan Pilot kembali menjadi model per masa, untuk disusun ulang dengan format terbaru. */
async function readA1Workbook(file){
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);
 const kop=wb.worksheets.find(ws=>!DERIVED.has(ws.name));
 const band=kop?String(text(kop.getCell(3,1).value)).split(/\s+·\s+/):[];
 const year=(band.map(s=>/Tahun (\d{4})/.exec(s)).find(Boolean)||/(\d{4})/.exec(file)||[])[1];
 const entity=band.find(s=>!/^NPWP |^Tahun \d{4}$/.test(s))||'';
 const perMasa=new Map(months.map(m=>[m,[]]));
 // Kontrol: versi pembetulan dan status per masa.
 const control=new Map(),ks=wb.getWorksheet('Kontrol');
 if(ks)ks.eachRow((row,n)=>{const m=text(row.getCell(1).value);if(n>4&&months.includes(m))control.set(m,{revision:row.getCell(2).value,data:text(row.getCell(3).value),pdf:text(row.getCell(4).value)});});
 // Setiap masa yang datanya lengkap mendapat SEMUA tabel sheet itu (yang kosong juga), agar urutan tabel antarmasa tetap sama.
 const filled=months.filter(m=>/^Lengkap/.test(control.get(m)?.data||''));
 for(const ws of wb.worksheets){
  if(DERIVED.has(ws.name))continue;
  const sheets=new Map();const sheetOf=m=>{if(!sheets.has(m))sheets.set(m,{label:ws.name,tables:[],fields:[],otherText:''});return sheets.get(m);};
  let r=6;
  while(r<=ws.rowCount){
   const first=text(ws.getCell(r,1).value);
   if(first==='Masa'){
    const headerRow=ws.getRow(r),width=headerRow.cellCount,headers=[];
    for(let c=2;c<=width;c++)headers.push(text(headerRow.getCell(c).value));
    const title=text(ws.getCell(r-1,1).value);
    const moneyCols=headers.map((h,i)=>/\(Rp\)/i.test(h)?i:-1).filter(i=>i>=0);
    const tables=new Map();
    const tableOf=m=>{if(!tables.has(m)){const t={title,headers,rows:[],moneyCols,totals:{},sourceTotals:[],differences:undefined,records:true};tables.set(m,t);}return tables.get(m);};
    const values=row=>{const out={};for(let c=2;c<=width;c++){const v=row.getCell(c).value;if(v!==null&&v!==undefined&&v!=='')out[c-2]=text(v);}return out;};
    r++;
    for(;r<=ws.rowCount;r++){
     const row=ws.getRow(r),label=text(row.getCell(1).value);
     if(!label)break;
     if(/^JUMLAH \([\d.]+ BARIS\)$/.test(label)||label==='Tidak ada data yang ditemukan.')continue; // jumlah setahun dihitung ulang saat disusun
     if(months.includes(label)){const cells=[];for(let c=2;c<=width;c++)cells.push(text(row.getCell(c).value));tableOf(label).rows.push(cells);continue;}
     const total=/^Total (\S+)$/.exec(label);
     if(total&&months.includes(total[1])){const v=values(row);for(const k of Object.keys(v))if(!moneyCols.includes(+k))delete v[k];tableOf(total[1]).totals=v;continue;}
     const m=masaOf(label),rest=label.replace(/^\S+ — /,'');
     if(m&&rest!==label){const v=values(row);if(rest==='Selisih total hitung terhadap sumber')tableOf(m).differences=v;else tableOf(m).sourceTotals.push({label:rest,values:v});continue;}
     throw Error(ws.name+' baris '+r+': baris tidak dikenali "'+label+'"');
    }
    const unknown=[...tables.keys()].filter(m=>!filled.includes(m));
    if(unknown.length)throw Error(ws.name+': ada data masa '+unknown.join(', ')+' padahal sheet Kontrol tidak mencatatnya lengkap.');
    for(const m of filled)sheetOf(m).tables.push(tableOf(m));
    continue;
   }
   if(first==='Bagian formulir'){
    for(r++;r<=ws.rowCount;r++){const row=ws.getRow(r),label=text(row.getCell(1).value),m=masaOf(label);if(!m||!label.includes(' — '))break;const cells=[label.replace(/^\S+ — /,'')];for(let c=2;c<=row.cellCount;c++)cells.push(text(row.getCell(c).value));sheetOf(m).fields.push(cells);}
    continue;
   }
   r++;
  }
  for(const[m,s]of sheets)perMasa.get(m).push(s);
 }
 return {entity,year,perMasa,control};
}

/** Susun ulang Excel Mode A1 lama ke format terbaru (BPMP per NIK + isian NIK Baru, Draft Pembetulan, ...). */
async function convertA1Workbook(file,outDir){
 const {entity,year,perMasa,control}=await readA1Workbook(file);
 if(!year)throw Error('Tahun tidak terbaca dari '+file);
 const book=new AnnualWorkbook(year);
 months.forEach((name,i)=>{
  const masa=String(i+1).padStart(2,'0')+year.slice(2),c=control.get(name),sheets=perMasa.get(name);
  if(!c||c.data==='Belum diperiksa')return;
  if(c.data==='Belum ada SPT'){book.register(masa,[]);return;}
  const rev=Number(c.revision)||0,row={RecordId:'impor-'+masa,ReturnSheetModel:rev?'Pembetulan '+rev:'Normal'};
  book.register(masa,[row]);
  book.record(masa,row,/^Lengkap/.test(c.data)?sheets:undefined,/^Lengkap/.test(c.pdf));
 });
 return {entity,year,result:await book.save(outDir,entity)};
}
module.exports={readA1Workbook,convertA1Workbook,text};
