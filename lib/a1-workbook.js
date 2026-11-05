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
 const sheets=new Map(),diffMonths=new Set();
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
    if(table.differences){dest.sourceTotals.push({label:masa+' — Selisih total hitung terhadap sumber',values:shifted(table.differences)});diffMonths.add(masa);}
   });
   target.fields.push(...sheet.fields.map(row=>[masa+' — '+row[0],...row.slice(1)]));
  }
 }
 // Masa yang barisnya tidak menjumlah ke total Coretax: ditandai di Ringkasan (total per masa tidak lagi dicetak di bawah tabel).
 return Object.assign([...sheets.values()],{diffMonths});
}

const TEMP_NIK='9990000000999000',PLACEHOLDER_NAME=/^PENERIMA PENGHASILAN\s*#/i;
const REPORT=require('./bpmp-report');
/** Sheet buatan rekap (bukan data Coretax). Susunan 2026-11-05: Ringkasan, NIK, Pembetulan, Draft SPT Desember, lalu lampiran. */
const DERIVED_SHEETS=new Set(['Ringkasan','NIK','Pembetulan','Draft SPT Desember','Draft Desember']);
// Palet rekap (audit warna 2026-11-05): judul kolom abu-abu, NIK salah oranye muda (tanpa huruf tebal), usulan biru muda,
// mirip kuning muda, isian hijau, baris total abu-abu muda.
const FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFFCE4D6'}},HEAD_FILL='FFD9D9D9';
const sheetName=label=>label.replace(/[\/*?:\[\]]/g,' ').slice(0,31)||'Lampiran';
const toNumber=text=>Number(String(text).replace(/\./g,'').replace(',','.'));
/** Baris ber-NIK sementara (NIK asli tidak terbaca sistem lalu digantikan) disorot di semua sheet. */
function highlightTempNik(wb){
 let count=0;
 for(const ws of wb.worksheets){
  if(DERIVED_SHEETS.has(ws.name))continue;
  ws.eachRow((row,number)=>{
   if(number<8)return;
   let hit=false;row.eachCell(cell=>{if(typeof cell.value==='string'&&cell.value.trim()===TEMP_NIK)hit=true;});
   if(!hit)return;count++;
   const width=Math.max(...ws.columns.map((c,i)=>c.width?i+1:0),row.cellCount);
   for(let c=1;c<=width;c++){const cell=row.getCell(c);cell.style={...cell.style,fill:FILL};}
  });
 }
 return count;
}
/** BPMP (L-IA) dijumlahkan per NIK dengan SUMIFS. NIK sementara 9990000000999000 tidak boleh digabung
 *  satu (itu banyak orang berbeda): dipisah per nomor NIK lama di belakang tanda # pada nama,
 *  mis. "penerima penghasilan#1213123", dan disorot. Kriteria NIK diberi "*" agar Excel membandingkannya
 *  sebagai TEKS: tanpa itu SUMIFS mengubah NIK 16 digit jadi angka dan hanya membedakan 15 digit pertama. */
function addBpmpSummary(wb,sheets,{entity,year}={}){
 const source=sheets.find(sheet=>sheet.label==='L-IA'),table=source&&source.tables[0];
 if(!table||!table.rows.length)return false;
 const ws0=wb.getWorksheet(sheetName('L-IA'));if(!ws0)return false;
 const nik=table.headers.findIndex(h=>/NIK|NPWP/i.test(h)),nama=table.headers.findIndex((h,i)=>i!==nik&&/^NAMA/i.test(h));
 if(nik<0)return false;
 const money=table.moneyCols.filter(c=>!/TARIF|TINGKAT/i.test(table.headers[c]));
 // Baris data L-IA: tepat di bawah judul kolom (baris berawalan "Masa"); di atasnya kop dan baris total.
 let headRow=0;ws0.eachRow((row,n)=>{if(!headRow&&n>5&&row.getCell(1).value==='Masa')headRow=n;});if(!headRow)headRow=7;
 const first=headRow+1,last=headRow+table.rows.length,range=i=>"'"+ws0.name+"'!$"+ws0.getColumn(i+1).letter+'$'+first+':$'+ws0.getColumn(i+1).letter+'$'+last;
 const groups=new Map();
 for(const row of table.rows){
  const id=String(row[nik]||'').trim(),name=nama>=0?String(row[nama]||'').trim():'';
  let key='N|'+id,old='';
  if(id===TEMP_NIK){const m=/#\s*(\d+)\s*$/.exec(name);old=m?m[1]:'';key='T|'+(old||name.toLowerCase());}
  if(!groups.has(key))groups.set(key,{key,id,name,old,temp:id===TEMP_NIK,count:0,masa:new Set(),values:money.map(()=>[]),months:money.map(()=>Array.from({length:12},()=>[]))});
  // NIK asli yang di satu masa masih bernama placeholder "PENERIMA PENGHASILAN#<NIK>" (ditemukan live Januari 2026: NIK
  // belum dikenali Coretax saat bukti potong dibuat, masa berikutnya sudah bernama asli) - pakai nama aslinya.
  if(!groups.get(key).temp&&PLACEHOLDER_NAME.test(groups.get(key).name)&&name&&!PLACEHOLDER_NAME.test(name))groups.get(key).name=name;
  const g=groups.get(key),m=months.indexOf(String(row[0]||'').trim());g.count++;if(m>=0)g.masa.add(m);money.forEach((c,i)=>{g.values[i].push(row[c]);if(m>=0)g.months[i][m].push(row[c]);});
 }
 // Urut NIK; baris NIK sementara diurutkan menurut NIK lamanya, jadi 3403060611030000 (#) tepat di atas 3403060611030001.
 const list=[...groups.values()].sort((a,b)=>cmp(nikKey(a),nikKey(b)));
 const issues=nikIssues(list),cases=nikCases(list,issues);
 const ws=wb.addWorksheet('NIK',{views:[{state:'frozen',xSplit:2,ySplit:6}]});
 // Kolom: NIK | Nama | NIK lama | NIK Baru | Nama Baru | Kategori | Keterangan | Jumlah masa | total per jenis | per masa | Catatan.
 // Kop baris 1-3; baris 4 total (SUBTOTAL: mengikuti filter), baris 5 selisih terhadap L-IA, judul kolom di baris 6 dengan filter.
 // Penjelasan warna ada di sheet Ringkasan. Pembaca sheet ini mencari baris judulnya (kolom A = "NIK").
 const COL_NEW=4,COL_KIND=6,COL_MONEY=9,nMoney=money.length,monthStart=COL_MONEY+nMoney,short=months.map(m=>m.slice(0,3));
 // Tiap jenis angka punya warnanya sendiri (Bruto biru, PPh oranye) dan judul bulannya menyebut jenisnya,
 // agar blok bulan Bruto dan PPh yang bersebelahan tidak tertukar.
 const kind=c=>/BRUTO/i.test(table.headers[c])?'Bruto':/PAJAK PENGHASILAN|PPH/i.test(table.headers[c])?'PPh':String(table.headers[c]).replace(/\s*\(Rp\)/i,'');
 const TONES=[['FF1F4E79','FFBDD7EE'],['FFC55A11','FFF8CBAD'],['FF375623','FFC6E0B4']],tone=i=>TONES[i%TONES.length];
 const blockOf=col=>col>=COL_MONEY&&col<monthStart?col-COL_MONEY:col>=monthStart&&col<monthStart+nMoney*12?Math.floor((col-monthStart)/12):-1;
 const headers=['NIK','Nama','NIK lama (dari #)','NIK Baru','Nama Baru','Kategori','Keterangan','Jumlah masa',...money.map(c=>table.headers[c]),...money.flatMap(c=>short.map(m=>kind(c)+' '+m)),'Catatan'];
 REPORT.writeKop(ws,{entity,title:'NIK',year});
 const total=ws.addRow(['TOTAL (sesuai filter)']),diff=ws.addRow(['Kontrol: total semua NIK − total L-IA (harus 0)']);
 ws.addRow(headers);
 const head=ws.getRow(6);head.eachCell(cell=>{const b=blockOf(cell.col);cell.fill=solid(cell.col===COL_NEW||cell.col===COL_NEW+1?'FFA9D08E':b>=0?tone(b)[1]:HEAD_FILL);cell.font={bold:true};cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};});head.height=32;
 const category=g=>{const issue=issues.get(g.key);if(!issue)return 'OK';if(issue.kind==='match')return 'Usulan pengganti';if(issue.kind==='near')return 'Periksa';return CASE_TYPES[cases.get(g.key).cat].short;};
 const nameOf=new Map(list.filter(g=>!g.temp).map(g=>[g.id,g.name]));
 let r=6;
 for(const g of list){
  r++;g.row=r;
  const issue=issues.get(g.key),only=issue&&issue.kind==='draft'&&issue.suggest.length===1?issue.suggest[0]:'';
  const byName=g.temp&&nama>=0?(g.old?'"*#"&$C'+r:'$B'+r):'';
  const cond=range(nik)+',$A'+r+'&"*"'+(byName?','+range(nama)+','+byName:'');
  const row=ws.addRow([g.id,g.name,g.old,only,only?nameOf.get(only)||'':'',category(g),issue?shortNote(issue):'',{formula:'COUNTIFS('+cond+')',result:g.count},...money.map((c,i)=>({formula:'SUMIFS('+range(c)+','+cond+')',result:toNumber(sumAmounts(g.values[i]))})),...money.flatMap((c,i)=>months.map((name,m)=>({formula:'SUMIFS('+range(c)+','+cond+','+range(0)+',"'+name+'")',result:g.months[i][m].length?toNumber(sumAmounts(g.months[i][m])):0})))]);
  for(const c of [1,3,COL_NEW])row.getCell(c).numFmt='@';
  for(let i=0;i<money.length;i++)row.getCell(COL_MONEY+i).numFmt='#,##0';
  for(let c=monthStart;c<monthStart+nMoney*12;c++)row.getCell(c).numFmt='#,##0;-#,##0;"-"';
  const note=monthStart+nMoney*12;
  if(issue){
   row.getCell(note).value=issue.note;
   for(let c=1;c<=note;c++){const cell=row.getCell(c);cell.style={...cell.style,fill:ISSUE_FILL[issue.kind]};}
  }
  for(const c of [COL_NEW,COL_NEW+1]){const cell=row.getCell(c);cell.style={...cell.style,fill:INPUT_FILL,font:{bold:!!cell.value}};}
 }
 ws.autoFilter={from:{row:6,column:1},to:{row:Math.max(7,r),column:monthStart+nMoney*12}};
 const rows=(letter)=>letter+'7:'+letter+Math.max(7,r);
 money.forEach((c,i)=>{const letter=ws.getColumn(COL_MONEY+i).letter,sum=[...groups.values()].reduce((a,g)=>a+toNumber(sumAmounts(g.values[i])),0);
  total.getCell(COL_MONEY+i).value={formula:'SUBTOTAL(109,'+rows(letter)+')',result:sum};total.getCell(COL_MONEY+i).numFmt='#,##0';
  diff.getCell(COL_MONEY+i).value={formula:'SUM('+rows(letter)+')-SUM('+range(c)+')',result:0};diff.getCell(COL_MONEY+i).numFmt='#,##0';});
 money.forEach((c,i)=>months.forEach((name,m)=>{const col=monthStart+i*12+m,letter=ws.getColumn(col).letter,sum=[...groups.values()].reduce((a,g)=>a+(g.months[i][m].length?toNumber(sumAmounts(g.months[i][m])):0),0);total.getCell(col).value={formula:'SUBTOTAL(109,'+rows(letter)+')',result:sum};total.getCell(col).numFmt='#,##0;-#,##0;"-"';}));
 const lastCol=monthStart+nMoney*12;
 for(let c=1;c<=lastCol;c++){total.getCell(c).fill=solid('FFF2F2F2');diff.getCell(c).fill=solid('FFF7F7F7');}
 total.font={bold:true};diff.font={italic:true};total.getCell(1).alignment=diff.getCell(1).alignment={wrapText:false};
 // Garis pemisah tebal di awal setiap blok angka (total, Bruto per masa, PPh per masa).
 const starts=[COL_MONEY,...money.map((c,i)=>monthStart+i*12)],divider={style:'thin',color:{argb:'FFA6A6A6'}};
 for(let rr=4;rr<=r;rr++)for(const c of starts){const cell=ws.getCell(rr,c);cell.style={...cell.style,border:{...(cell.border||{}),left:divider}};}
 ws.columns.forEach((col,i)=>col.width=i===0?20:i===1?34:i===2?18:i===3?20:i===4?30:i===5?18:i===6?44:i===7?12:i<monthStart-1?20:i===monthStart-1+nMoney*12?70:15);
 return {ws,table,nik,nama,list,issues,cases,COL_NEW};
}
const CASE_TYPES={
 auto:{short:'Otomatis',title:'Terisi otomatis — NIK valid pasangannya ada di data'},
 twin:{short:'Pasangan NIK salah',title:'Dua NIK lama bermasalah yang hanya beda di digit akhir — kemungkinan orang yang sama'},
 choose:{short:'Pilih kandidat',title:'Lebih dari satu NIK valid yang mirip — pilih yang sesuai KTP'},
 manual:{short:'Isi manual (KTP)',title:'Tidak ada NIK mirip di data — isi NIK Baru dari KTP'},
 check:{short:'Periksa',title:'NIK valid dengan 12 digit awal sama — periksa apakah orang yang sama'}};
/** Satu kasus = NIK bermasalah beserta NIK lain yang 12 digit awalnya sama (wilayah + tanggal lahir). */
function nikCases(list,issues){
 const prefix=g=>{const k=g.temp?g.old:g.id;return isNik(k)?k.slice(0,12):g.key;};
 const blocks=new Map();
 for(const g of list){if(!issues.has(g.key))continue;const p=prefix(g);if(!blocks.has(p))blocks.set(p,[]);blocks.get(p).push(g);}
 const cases=new Map();let n=0;
 for(const members of blocks.values()){
  const drafts=members.filter(g=>issues.get(g.key).kind==='draft'),has=test=>drafts.some(g=>test(issues.get(g.key).suggest.length));
  const cat=!drafts.length?'check':has(x=>x===1)?'auto':drafts.length>1?'twin':has(x=>x>1)?'choose':'manual';
  const kase={id:'K'+String(++n).padStart(2,'0'),cat,members};
  for(const g of members)cases.set(g.key,kase);
 }
 return cases;
}
/** Jumlah NIK bermasalah per kategori (dulu sheet Analisis NIK; kini kolom Kategori di sheet NIK). */
function nikSummary(bpmp){
 if(!bpmp)return {nik:0,bukti:0};
 const kases=[...new Set(bpmp.cases.values())],bad=bpmp.list.filter(g=>bpmp.issues.get(g.key)?.kind==='draft'),summary={};
 for(const cat of Object.keys(CASE_TYPES)){const these=kases.filter(k=>k.cat===cat);if(these.length)summary[cat]={cases:these.length,nik:these.flatMap(k=>k.members.filter(g=>cat==='check'||bpmp.issues.get(g.key).kind==='draft')).length};}
 return {nik:bad.length,bukti:bad.reduce((a,g)=>a+g.count,0),...summary};
}
const solid=argb=>({type:'pattern',pattern:'solid',fgColor:{argb}});
const ISSUE_FILL={draft:FILL,match:solid('FFDDEBF7'),near:solid('FFFFF2CC')},INPUT_FILL=solid('FFE2EFDA');
const isNik=id=>/^\d{16}$/.test(id);
const nikKey=g=>g.temp?(isNik(g.old)?g.old+'#':'~'+(g.old||g.name)):g.id;
const cmp=(a,b)=>a<b?-1:a>b?1:0;
/** NIK yang perlu dibetulkan: NIK sementara, atau NIK bernomor urut 0000 (nomor urut Dukcapil mulai 0001).
 *  Usulan penggantinya = NIK valid lain di L-IA dengan 12 digit awal sama (kode wilayah + tanggal lahir),
 *  karena kesalahan ketik biasanya hanya di nomor urut. Usulan tetap harus dicocokkan dengan KTP. */
function nikIssues(list){
 const valid=list.filter(g=>!g.temp&&isNik(g.id)&&!g.id.endsWith('0000'));
 const near=(id,self)=>[...new Set(valid.filter(v=>v!==self&&v.id!==id&&v.id.slice(0,12)===id.slice(0,12)).map(v=>v.id))];
 const issues=new Map(),matched=new Map();
 for(const g of list){
  const bad=g.temp||(isNik(g.id)&&g.id.endsWith('0000'));
  if(!bad)continue;
  const from=g.temp?g.old:g.id,suggest=isNik(from)?near(from,g):[];
  const why=g.temp?(isNik(from)?'NIK '+from+' tidak terbaca sistem':from?'NIK lama '+from+' bukan 16 digit':'NIK sementara tanpa NIK lama'):'Nomor urut NIK 0000 tidak lazim';
  // NIK lama yang 12 digit awalnya sama dengan NIK lama baris # lain: kemungkinan orang yang sama, dua kali salah ketik.
  const twins=isNik(from)?list.filter(o=>o!==g&&(o.temp?o.old:o.id)!==from&&(o.temp||o.id.endsWith('0000'))&&isNik(o.temp?o.old:o.id)&&(o.temp?o.old:o.id).slice(0,12)===from.slice(0,12)).map(o=>o.temp?o.old:o.id):[];
  issues.set(g.key,{kind:'draft',from,suggest,twins,note:why+(suggest.length===1?' — usulan NIK benar '+suggest[0]+'.':suggest.length?' — beberapa kandidat: '+suggest.join(', ')+'. Pilih yang sesuai KTP.':' — tidak ada NIK valid mirip, isi NIK benar secara manual.')+(twins.length?' Mirip NIK bermasalah lain '+twins.join(', ')+' (mungkin orang yang sama).':'')});
  for(const id of suggest){if(!matched.has(id))matched.set(id,[]);matched.get(id).push(from||g.name);}
 }
 for(const g of valid){
  if(matched.has(g.id))issues.set(g.key,{kind:'match',for:matched.get(g.id),note:'Usulan NIK benar untuk '+matched.get(g.id).join(', ')+'.'});
  else{const other=near(g.id,g);if(other.length)issues.set(g.key,{kind:'near',others:other,note:'12 digit awal sama dengan '+other.join(', ')+'. Periksa apakah orang yang sama.'});}
 }
 return issues;
}
/** Keterangan singkat per baris: apa masalahnya dan apa yang harus dilakukan. */
function shortNote(issue){
 if(issue.kind==='match')return 'NIK benar (pengganti '+issue.for.join(', ')+')';
 if(issue.kind==='near')return 'Mirip '+issue.others.join(', ')+' → cek orang yang sama';
 if(issue.suggest.length===1)return 'NIK salah → ganti '+issue.suggest[0];
 if(issue.suggest.length)return 'NIK salah → pilih '+issue.suggest.join(' / ');
 if(issue.twins.length)return 'NIK salah, mirip '+issue.twins.join(', ')+' → isi dari KTP';
 return 'NIK salah → isi NIK Baru dari KTP';
}
/** Pembetulan: satu baris per bukti potong ber-NIK bermasalah. NIK Baru / Nama Baru mengikuti sheet NIK;
 *  Status, Nama Resmi Coretax, Pemeriksaan Ulang, Waktu dan Cek Coretax diisi proses Pembetulan NIK BPMP
 *  (lib/bpmp-report.js). Mengembalikan baris per bukti potong (untuk jumlah per masa di Ringkasan). */
function addPembetulan(wb,bpmp,{entity,year}={}){
 const ws=wb.addWorksheet('Pembetulan',{views:[{state:'frozen',ySplit:4}]});
 const cols=REPORT.PB_COLS,at=name=>cols.findIndex(c=>c[0]===name)+1;
 REPORT.writeKop(ws,{entity,title:'Pembetulan',year});
 ws.addRow(cols.map(c=>c[0]));
 const head=ws.getRow(4);head.eachCell(cell=>{cell.fill=solid(cell.col===at('NIK Baru')||cell.col===at('Nama Baru')?'FFA9D08E':HEAD_FILL);cell.font={bold:true};cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};});head.height=32;
 cols.forEach(([,w],i)=>ws.getColumn(i+1).width=w);
 const rows=[];
 if(bpmp){
  const {table,nik,nama,list,issues}=bpmp,h=re=>table.headers.findIndex(x=>re.test(x));
  const col={no:h(/NOMOR BUKTI/i),date:h(/TANGGAL/i),kop:h(/KODE OBJEK/i),bruto:h(/BRUTO/i),pph:h(/^PAJAK PENGHASILAN/i)};
  const byKey=new Map(list.map(g=>[g.key,g]));
  for(const row of table.rows){
   const id=String(row[nik]||'').trim(),name=nama>=0?String(row[nama]||'').trim():'';
   let key='N|'+id;
   if(id===TEMP_NIK){const m=/#\s*(\d+)\s*$/.exec(name);key='T|'+(m?m[1]:name.toLowerCase());}
   const issue=issues.get(key);
   if(!issue||issue.kind!=='draft'||!byKey.has(key))continue;
   rows.push({row,id,name,issue,group:byKey.get(key),order:nikKey(byKey.get(key))});
  }
  rows.sort((a,b)=>months.indexOf(a.row[0])-months.indexOf(b.row[0])||cmp(a.order,b.order));
  const val=(row,c)=>c>=0?row[c]:'';
  const src=(g,offset)=>{const ref="'"+bpmp.ws.name+"'!$"+bpmp.ws.getColumn(bpmp.COL_NEW+offset).letter+'$'+g.row,v=bpmp.ws.getCell(g.row,bpmp.COL_NEW+offset).value||'';return {formula:'IF('+ref+'="","",'+ref+')',result:v};};
  for(const {row,id,name,issue,group} of rows){
   const r=ws.addRow([row[0],val(row,col.no),val(row,col.date),val(row,col.kop),id,name,id===TEMP_NIK?issue.from:'',src(group,0),src(group,1),toNumber(val(row,col.bruto)||'0'),toNumber(val(row,col.pph)||'0'),'Draft','','','','','','NIK bermasalah','',issue.note]);
   for(const c of [2,5,7,8])r.getCell(c).numFmt='@';r.getCell(10).numFmt='#,##0';r.getCell(11).numFmt='#,##0';
   for(const c of [8,9])r.getCell(c).fill=r.getCell(c).value.result?INPUT_FILL:FILL;
  }
 }
 ws.autoFilter={from:{row:4,column:1},to:{row:Math.max(5,ws.rowCount),column:cols.length}};
 return rows;
}
/** Ringkasan (sheet pertama): kalimat status + satu baris per masa. Kolom status SPT diisi proses Pembetulan NIK BPMP. */
function addRingkasan(wb,{year,entity,partial,control,perMasa,nik}){
 const ws=wb.addWorksheet('Ringkasan',{views:[{state:'frozen',ySplit:8}]});
 REPORT.writeKop(ws,{entity,title:'Ringkasan',year});
 ws.addRow([partial?'BELUM LENGKAP — periksa kolom Data Excel / PDF di tabel bawah.':'Seluruh masa telah diperiksa. Data Excel: versi terakhir setiap masa. PDF: lengkap dan rahasia untuk seluruh versi.']);
 ws.addRow([nik.nik?'NIK bermasalah (data SPT): '+nik.nik+' NIK · '+nik.bukti+' bukti potong — isi NIK Baru / Nama Baru di sheet NIK; rincian per bukti potong di sheet Pembetulan.':'Tidak ada NIK bermasalah di data SPT.']).font={bold:true};
 ws.addRow(['SPT Masa yang perlu dibetulkan: belum diperiksa (jalankan Pembetulan NIK BPMP atau "Periksa NIK bermasalah").']).font={bold:true};
 ws.addRow([]);
 ws.addRow(REPORT.RK_COLS.map(c=>c[0]));
 const head=ws.getRow(8);head.eachCell(cell=>{cell.fill=solid(HEAD_FILL);cell.font={bold:true};cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};});head.height=32;
 control.forEach((row,i)=>{const r=ws.addRow([...row,...Array(REPORT.RK_COLS.length-row.length).fill('')]);if(/^(Belum lengkap|Gagal|Perlu|Versi)/.test(String(row[2])+String(row[3])))r.font={color:{argb:'FFC00000'}};});
 ws.autoFilter={from:{row:8,column:1},to:{row:20,column:REPORT.RK_COLS.length}};
 ws.addRow([]);
 ws.addRow(['Sheet NIK: ORANYE MUDA = NIK salah (NIK sementara '+TEMP_NIK+' / nomor urut 0000) · BIRU = NIK benar pengganti yang diusulkan · KUNING MUDA = mirip NIK lain, cek. Kolom HIJAU NIK Baru / Nama Baru = isian pembetulan (cocokkan dengan KTP); filter kolom Kategori untuk melihat per jenis.']);
 ws.addRow(['Sheet Pembetulan: satu baris per bukti potong; kolom Status = hasil pembetulan terakhir, Cek Coretax = hasil pemeriksaan setahun terakhir langsung dari Coretax.']);
 REPORT.RK_COLS.forEach(([,w],i)=>ws.getColumn(i+1).width=w);ws.getColumn(1).width=14;
 return ws;
}
/** Sel yang tidak perlu diubah dikunci (permintaan 2026-11-05): proteksi lembar TANPA kata sandi - Review > Unprotect
 *  Sheet bila memang perlu - dengan filter, urutan kolom/baris dan lebar tetap bisa dipakai. Yang terbuka: NIK Baru /
 *  Nama Baru di sheet NIK dan sel hijau Draft SPT Desember (lib/a1-desember.js menandainya sendiri). */
async function protectSheets(wb){
 const nik=wb.getWorksheet('NIK');
 if(nik){let head=0;nik.eachRow((r,n)=>{if(!head&&n<=10&&r.getCell(1).value==='NIK'&&r.getCell(2).value==='Nama')head=n;});
  const h=new Map();if(head)nik.getRow(head).eachCell((c,i)=>h.set(String(c.value),i));
  if(head)nik.eachRow((r,n)=>{if(n>head&&/^\d{16}$/.test(String(r.getCell(1).value||'')))for(const k of ['NIK Baru','Nama Baru'])if(h.has(k))r.getCell(h.get(k)).protection={locked:false};});}
 for(const ws of wb.worksheets)await ws.protect('',{selectLockedCells:true,selectUnlockedCells:true,formatCells:false,formatColumns:true,formatRows:true,autoFilter:true,sort:false,insertRows:false,deleteRows:false});
}
/** Cache per baris SPT (RecordId) yang sudah lengkap, disimpan di folder A1. Proses berikutnya memakai
 *  ulang baris yang RecordId-nya sama (versi SPT tidak berubah) selama PDF-nya masih ada, sehingga
 *  hanya masa baru / pembetulan baru yang diunduh. Naikkan CACHE_VERSION bila bentuk sheet berubah. */
const CACHE_VERSION=1;
const cacheFile=(dir,masa,row)=>path.join(dir,masa+'-'+String(row.RecordId).replace(/[^\w-]/g,'_')+'.json');
class AnnualWorkbook {
 constructor(year){this.year=String(year);this.periods=new Map();this.completed=new Map();this.cacheDir=null;this.readDirs=[];this.seed={};}
 register(masa,rows){this.periods.set(masa,rows.map(row=>({...row,revision:revision(row)})));}
 /** persist: tulis cache walau dipakai ulang (data dari Excel lama -> berikutnya cukup dari cache). */
 record(masa,row,sheets,pdfOk,reused=false,persist=!reused){
  this.completed.set(masa+'|'+row.RecordId,{masa,row,sheets,pdfOk,reused});
  if(!this.cacheDir||!persist||!sheets||!pdfOk)return;
  fs.mkdirSync(this.cacheDir,{recursive:true});
  const file=cacheFile(this.cacheDir,masa,row),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:CACHE_VERSION,masa,recordId:row.RecordId,revision:revision(row),model:row.ReturnSheetModel||'Normal',savedAt:new Date().toISOString(),sheets}));
  fs.renameSync(tmp,file);
 }
 /** Sheet hasil proses sebelumnya untuk baris ini, atau null bila belum ada / tidak cocok. */
 cached(masa,row){
  for(const dir of [this.cacheDir,...this.readDirs].filter(Boolean)){
   try{
    const data=JSON.parse(fs.readFileSync(cacheFile(dir,masa,row),'utf8'));
    if(data.version!==CACHE_VERSION||data.masa!==masa||data.recordId!==row.RecordId||data.revision!==revision(row)||!Array.isArray(data.sheets))continue;
    return data.sheets;
   }catch(e){}
  }
  return null;
 }
 /** Data versi terakhir masa ini dari Excel Mode A1 lama (lib/a1-source.js), bila versinya sama dengan Coretax. */
 seeded(masa,row){
  const s=this.seed[masa];
  return s&&Array.isArray(s.sheets)&&s.sheets.length&&s.revision===revision(row)?s.sheets:null;
 }
 /** File: "<kode> <tahun> - Rekap SPT PPh 21 Setahun (A1).xlsx" (permintaan 2026-11-04, sebelumnya
  *  "Mode A1 - <tahun>"); `code` boleh kosong (konversi Excel lama tanpa kode entitas). */
 async save(dir,entity,code){
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
   control.push([months[m-1],latest,data?.sheets?(data.reused?'Lengkap (dari proses sebelumnya)':'Lengkap'):'Gagal dibaca',pdfOk?'Lengkap, semua versi':'Belum lengkap']);
  }
  fs.mkdirSync(dir,{recursive:true});
  const prefix=String(code||'').replace(/[\\/:*?"<>|]/g,'').trim();
  const base=path.join(dir,(prefix?prefix+' ':'')+this.year+' - Rekap SPT PPh 21 Setahun (A1)');
  const file=base+(partial?' - BELUM LENGKAP':'')+'.xlsx';
  // Rekap yang akan ditimpa (lengkap / belum lengkap): isian NIK Baru dan status pembetulannya ikut dibawa.
  let previous=null;
  for(const old of [base+'.xlsx',base+' - BELUM LENGKAP.xlsx'].filter(f=>fs.existsSync(f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)){
   try{previous=new ExcelJS.Workbook();await previous.xlsx.readFile(old);break;}catch(e){previous=null;}
  }
  const sheets=combine(selected);
  await writeWorkbook(sheets,{entity,title:'Mode A1 — SPT PPh 21',period:'Tahun '+this.year,totalsOnTop:true},file);
  for(const m of sheets.diffMonths||[]){const row=control.find(r=>r[0]===m);if(row)row[2]+=' — jumlah baris ≠ total Coretax, periksa';}
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);
  const bpmp=addBpmpSummary(wb,sheets,{entity,year:this.year}),flagged=highlightTempNik(wb),nik=nikSummary(bpmp||null),slips=addPembetulan(wb,bpmp||null,{entity,year:this.year});
  const perMasa=months.map(m=>slips.filter(x=>x.row[0]===m).length);
  // Draft BPA1 Desember dari L-IA (lib/a1-desember.js).
  const lia=sheets.find(s=>s.label==='L-IA');
  const lib=sheets.find(s=>s.label==='L-IB');
  require('./a1-desember').addDraftDesember(wb,{entity,table:lia&&lia.tables[0],ws0:wb.getWorksheet(sheetName('L-IA')),year:this.year,lib:lib&&lib.tables[0],wsLib:wb.getWorksheet(sheetName('L-IB'))});
  addRingkasan(wb,{year:this.year,entity,partial,control,perMasa,nik});
  // Urutan sheet: Ringkasan, NIK, Pembetulan, lalu lampiran dari Coretax.
  const order=['Ringkasan','NIK','Pembetulan','Draft SPT Desember'];
  wb.worksheets.forEach((s,i)=>{const k=order.indexOf(s.name);s.orderNo=k>=0?k:order.length+i;});
  if(previous)REPORT.carryOver(previous,wb);
  // Angka Ringkasan per masa = COUNTIFS ke sheet Pembetulan; catatan per bukti potong di sebelah tabel lampiran.
  REPORT.refreshRingkasan(wb);REPORT.refreshSlipNotes(wb);
  await protectSheets(wb);
  wb.views=[{activeTab:0}];
  await wb.xlsx.writeFile(file);return {file,partial,selected:selected.length,control,tempNikRows:flagged,draftRows:slips.length,nik};
 }
}
module.exports={AnnualWorkbook,combine,revision,sumAmounts,TEMP_NIK,DERIVED_SHEETS,addBpmpSummary,highlightTempNik,addPembetulan,nikIssues};
