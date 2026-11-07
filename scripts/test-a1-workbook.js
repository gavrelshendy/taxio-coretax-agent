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
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(result.file);const ws=wb.getWorksheet('L-IA');
 // Rekap: kop 1-3, satu baris kosong, total di atas judul kolom (baris 5 SUBTOTAL mengikuti filter, baris 6 SUM setahun), judul kolom baris 7, data mulai baris 8;
 // tidak ada lagi baris total per masa di bawah tabel.
 assert.equal(ws.getCell('A7').value,'Masa');assert.equal(ws.getCell('A8').value,'Januari');assert.equal(ws.getCell('D8').value,200);assert.equal(ws.getCell('D9').value,300);assert.equal(ws.getCell('C8').value,'0012345678901234');assert.equal(ws.getCell('A4').value,null);assert(ws.getCell('A3').font.bold,'tahun tebal');
 assert.equal(ws.getCell('D5').value.formula,'SUBTOTAL(109,D8:D9)');assert.equal(ws.getCell('D5').value.result,500);assert.equal(ws.getCell('D6').value.formula,'SUM(D8:D9)');assert.equal(ws.rowCount,9);
 assert.match(ws.getCell('A6').value,/^TOTAL SETAHUN \(2 BARIS\)$/);assert.equal(ws.views[0].ySplit,7);
 // Susunan rekap: Ringkasan, NIK, Pembetulan, Draft SPT Desember di depan, lalu lampiran; tanpa sel gabungan.
 assert.deepEqual(wb.worksheets.map(s=>s.name),['Ringkasan','NIK','Pembetulan','Draft SPT Desember','L-IA']);assert.equal(wb.getWorksheet('Ringkasan').getCell(9,1).value,'Januari');assert.equal(wb.getWorksheet('Ringkasan').getCell(20,1).value,'Desember');
 // Kop 3 baris di setiap sheet rekap: nama entitas, judul sheet, tahun.
 for(const [s,t] of [['Ringkasan','Ringkasan'],['NIK','NIK'],['Pembetulan','Pembetulan'],['Draft SPT Desember','Draft SPT Desember'],['L-IA','Lampiran L-IA']])assert.deepEqual([1,2,3].map(r=>wb.getWorksheet(s).getCell(r,1).value),['Entitas Uji',t,'Tahun 2026'],s);
 assert.equal(wb.worksheets.reduce((a,s)=>a+Object.keys(s._merges||{}).length,0),0);
 // Failure of the latest revision must never fall back to the normal return.
 book.record('0126',amended,undefined,false);result=await book.save(dir,'ENTITAS UJI');assert(result.partial);assert.equal(result.selected,1);assert(result.file.includes('BELUM LENGKAP'));
 const changed=sheet('100');changed[0].tables[0].headers[2]='Kolom baru';assert.throws(()=>combine([{masa:'0126',sheets:sheet('100')},{masa:'0226',sheets:changed}]),/Susunan kolom/);
 const available=new AnnualWorkbook(2026);
 for(let m=1;m<=12;m++){const masa=String(m).padStart(2,'0')+'26';available.register(masa,m<=8?[normal]:[]);if(m<=8)available.record(masa,normal,sheet('239.487.131'),true);}
 const ytd=await available.save(dir,'ENTITAS UJI');assert.equal(ytd.partial,false);assert.equal(ytd.selected,8);assert(ytd.control.slice(8).every(row=>row[2]==='Belum ada SPT'));
 const yearBook=new ExcelJS.Workbook();await yearBook.xlsx.readFile(ytd.file);assert.equal(yearBook.getWorksheet('L-IA').getCell('D6').value.result,1915897048);
 const empty=await new AnnualWorkbook(2026).save(dir,'ENTITAS UJI');assert(empty.partial);assert.equal(empty.selected,0);

 // Sheet NIK (SUMIFS; kop baris 1-3, total 4-5, judul kolom 6) + NIK sementara 9990000000999000 dipisah per nomor di belakang # dan disorot.
 const rows=[['1','1111111111111111','BUDI','1.000'],['2','9990000000999000','penerima penghasilan#1213123','500'],['3','9990000000999000','penerima penghasilan#9999','700']];
 const bpmpSheet=(rs)=>[{label:'L-IA',tables:[{title:'Tabel',headers:['No.','NIK/NPWP','Nama','Penghasilan Bruto (Rp)'],rows:rs,moneyCols:[3],totals:{3:sumAmounts(rs.map(r=>r[3]))},sourceTotals:[],records:true}],fields:[],otherText:''}];
 const tb=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)tb.register(String(m).padStart(2,'0')+'26',[]);
 tb.register('0126',[normal]);tb.record('0126',normal,bpmpSheet(rows),true);tb.register('0226',[normal]);tb.record('0226',normal,bpmpSheet([['1','1111111111111111','BUDI','2.000'],['2','9990000000999000','penerima penghasilan#1213123','250']]),true);
 const tr=await tb.save(dir,'ENTITAS UJI');assert.equal(tr.tempNikRows,3,'hanya baris lampiran yang dihitung');
 const twb=new ExcelJS.Workbook();await twb.xlsx.readFile(tr.file);const sum=twb.getWorksheet('NIK');assert(sum,'sheet NIK ada');
 const cell=(r,c)=>{const v=sum.getCell(r,c).value;return v&&typeof v==="object"&&v.formula?(v.result||0):v;};
 // Kolom: NIK, Nama, NIK lama, NIK Baru, Nama Baru, Kategori, Keterangan, Jumlah masa (8), Bruto (9), Jan..Des Bruto (10..21).
 assert.deepEqual(sum.getRow(6).values.slice(1,10),['NIK','Nama','NIK lama (dari #)','NIK Baru','Nama Baru','Kategori','Keterangan','Jumlah masa','Penghasilan Bruto (Rp)']);
 assert.equal(cell(7,1),'1111111111111111');assert.equal(cell(7,8),2);assert.equal(cell(7,9),3000);
 assert.equal(cell(8,3),'1213123');assert.equal(cell(8,9),750);assert.equal(cell(9,3),'9999');assert.equal(cell(9,9),700);
 assert.match(sum.getCell(7,9).value.formula,/^SUMIFS\('L-IA'!\$E\$8:\$E\$12,'L-IA'!\$C\$8:\$C\$12,\$A7&"\*"\)$/);
 assert.match(sum.getCell(8,9).value.formula,/'L-IA'!\$D\$8:\$D\$12,"\*#"&\$C8\)$/);
 assert.equal(sum.getCell(8,1).fill.fgColor.argb,'FFFCE4D6');assert.notEqual((sum.getCell(7,1).fill||{}).fgColor?.argb,'FFFCE4D6');
 assert.equal(sum.getCell(7,4).fill.fgColor.argb,'FFE2EFDA');assert.equal(sum.getCell(8,5).fill.fgColor.argb,'FFE2EFDA');
 assert.equal(twb.getWorksheet('L-IA').getCell('C9').fill.fgColor.argb,'FFFCE4D6');assert.notEqual((twb.getWorksheet('L-IA').getCell('C8').fill||{}).fgColor?.argb,'FFFCE4D6');
 assert.equal(sum.autoFilter,'A6:V9');assert.equal(sum.rowCount,9,'tidak ada baris total di bawah');
 // Baris 4: total mengikuti filter (SUBTOTAL); baris 5: selisih seluruh baris terhadap L-IA.
 assert.equal(cell(4,1),'TOTAL (sesuai filter)');assert.equal(cell(4,9),4450);assert.equal(sum.getCell(4,9).value.formula,'SUBTOTAL(109,I7:I9)');
 assert.equal(sum.getCell(5,9).value.formula,"SUM(I7:I9)-SUM('L-IA'!$E$8:$E$12)");
 // Per masa menyamping: kolom 10..21 = Jan..Des (Bruto).
 assert.equal(cell(7,10),1000);assert.equal(cell(7,11),2000);assert.equal(cell(7,12),0);assert.equal(cell(8,10),500);assert.equal(cell(8,11),250);assert.equal(cell(9,10),700);assert.equal(cell(4,10),2200);assert.equal(cell(4,11),2250);
 assert.match(sum.getCell(7,11).value.formula,/,'L-IA'!\$A\$8:\$A\$12,"Februari"\)$/);assert.equal(sum.getCell(6,10).value,'Bruto Jan');assert.equal(sum.getCell(6,21).value,'Bruto Des');
 assert.equal(sum.getCell(6,10).fill.fgColor.argb,'FFBDD7EE');assert.equal(sum.getCell(7,10).border.left.style,'thin');

 // NIK salah ketik di nomor urut: baris # diurutkan tepat di atas NIK benarnya, diwarnai berbeda, dan masuk sheet Pembetulan.
 const L=(rs)=>[{label:'L-IA',tables:[{title:'Tabel',headers:['No.','NIK/NPWP','Nama','Nomor Bukti Potong','Tanggal Bukti Pemotongan','Kode Objek Pajak','Penghasilan Bruto (Rp)','Pajak Penghasilan (Rp)'],rows:rs,moneyCols:[6,7],totals:{6:sumAmounts(rs.map(r=>r[6])),7:sumAmounts(rs.map(r=>r[7]))},sourceTotals:[],records:true}],fields:[],otherText:''}];
 const nb=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)nb.register(String(m).padStart(2,'0')+'26',[]);
 nb.register('0126',[normal]);nb.record('0126',normal,L([['1','9990000000999000','penerima penghasilan#3403060611030000','BP-JAN-1','31-01-2026','21-100-01','5.000','0'],['2','5555555555555555','ANI','BP-JAN-2','31-01-2026','21-100-01','4.000','0'],['3','1234567890120000','CICI','BP-JAN-3','31-01-2026','21-100-01','1.000','0']]),true);
 nb.register('0226',[normal]);nb.record('0226',normal,L([['1','3403060611030001','DODI','BP-FEB-1','28-02-2026','21-100-01','6.000','0'],['2','5555555555550001','ANA','BP-FEB-2','28-02-2026','21-100-01','2.000','0'],['3','9990000000999000','penerima penghasilan#7777','BP-FEB-3','28-02-2026','21-100-01','3.000','0']]),true);
 const ndir=path.join(dir,'nik');const nr=await nb.save(ndir,'ENTITAS UJI','UJI');assert.equal(nr.draftRows,3);assert(nr.file.endsWith('UJI 2026 - Rekap SPT PPh 21 Setahun (A1).xlsx'));
 const nwb=new ExcelJS.Workbook();await nwb.xlsx.readFile(nr.file);const ns=nwb.getWorksheet('NIK'),note=()=>ns.getRow(6).values.indexOf('Catatan');
 const ids=[7,8,9,10,11,12].map(r=>[ns.getCell(r,1).value,ns.getCell(r,3).value]);
 assert.deepEqual(ids,[['1234567890120000',''],['9990000000999000','3403060611030000'],['3403060611030001',''],['5555555555550001',''],['5555555555555555',''],['9990000000999000','7777']]);
 const fillOf=r=>(ns.getCell(r,1).fill||{}).fgColor?.argb;
 assert.equal(fillOf(7),'FFFCE4D6');assert.equal(fillOf(8),'FFFCE4D6');assert.equal(fillOf(9),'FFDDEBF7');assert.equal(fillOf(10),'FFFFF2CC');assert.equal(fillOf(11),'FFFFF2CC');assert.equal(fillOf(12),'FFFCE4D6');
 const nc=note();assert.match(ns.getCell(8,nc).value,/usulan NIK benar 3403060611030001/);assert.match(ns.getCell(9,nc).value,/3403060611030000/);assert.match(ns.getCell(12,nc).value,/isi NIK benar secara manual/);
 // Isian NIK Baru / Nama Baru terisi otomatis hanya bila usulannya tunggal.
 assert.deepEqual([ns.getCell(8,4).value,ns.getCell(8,5).value],['3403060611030001','DODI']);assert.ok(!ns.getCell(7,4).value&&!ns.getCell(12,4).value&&!ns.getCell(9,4).value);
 // Kategori (pengganti sheet Analisis NIK) dan Keterangan: tindakan dalam bahasa biasa, tanpa kode kasus.
 assert.deepEqual([7,8,9,10,11,12].map(r=>ns.getCell(r,6).value),['Isi manual (KTP)','Otomatis','Usulan pengganti','Periksa','Periksa','Isi manual (KTP)']);
 assert.deepEqual([7,8,9,10,11,12].map(r=>ns.getCell(r,7).value),['NIK salah → isi NIK Baru dari KTP','NIK salah → ganti 3403060611030001','NIK benar (pengganti 3403060611030000)','Mirip 5555555555555555 → cek orang yang sama','Mirip 5555555555550001 → cek orang yang sama','NIK salah → isi NIK Baru dari KTP']);
 assert.ok(!(ns.getCell(8,1).border||{}).top);
 assert.deepEqual(nr.nik,{nik:3,bukti:3,auto:{cases:1,nik:1},check:{cases:1,nik:2},manual:{cases:2,nik:2}});
 assert.deepEqual(nwb.worksheets.map(s=>s.name),['Ringkasan','NIK','Pembetulan','Draft SPT Desember','L-IA']);
 const rk=nwb.getWorksheet('Ringkasan');assert.match(rk.getCell(5,1).value,/NIK bermasalah \(data SPT\): 3 NIK · 3 bukti potong/);// Ringkasan: banyaknya bukti potong bermasalah / dibetulkan per masa (COUNTIFS ke Pembetulan).
 assert.equal(rk.getCell(9,5).value.result,2);assert.equal(rk.getCell(10,5).value.result,1);assert.equal(rk.getCell(9,5).value.formula,'COUNTIFS(Pembetulan!$A:$A,$A9)');
 const dr=nwb.getWorksheet('Pembetulan'),drow=r=>dr.getRow(r).values.slice(1),res=v=>v&&v.formula!==undefined?v.result:v;
 assert.deepEqual(drow(5).slice(0,7),['Januari','BP-JAN-3','31-01-2026','21-100-01','1234567890120000','CICI','']);
 assert.deepEqual(drow(6).slice(0,7),['Januari','BP-JAN-1','31-01-2026','21-100-01','9990000000999000','penerima penghasilan#3403060611030000','3403060611030000']);
 assert.equal(dr.getCell(6,8).value.formula,"IF('NIK'!$D$8=\"\",\"\",'NIK'!$D$8)");assert.equal(res(dr.getCell(6,8).value),'3403060611030001');assert.equal(res(dr.getCell(6,9).value),'DODI');
 assert.equal(drow(6)[9],'Ganti NIK');assert.equal(drow(6)[10],5000);assert.equal(drow(6)[12],'Draft');assert.equal(drow(7)[1],'BP-FEB-3');assert.equal(dr.getCell(7,8).fill.fgColor.argb,'FFFCE4D6');assert.equal(dr.getCell(6,8).fill.fgColor.argb,'FFE2EFDA');
 const clean=new ExcelJS.Workbook();await clean.xlsx.readFile((await available.save(path.join(dir,'bersih'),'ENTITAS UJI')).file);{let n=0;clean.getWorksheet('Pembetulan').eachRow((r,i)=>{if(i>4&&r.getCell(2).value)n++;});assert.equal(n,0,'rekap bersih: Pembetulan tanpa baris (hanya baris cadangan siap isi)');}assert.equal(clean.getWorksheet('Ringkasan').getCell(5,1).value,'Tidak ada NIK bermasalah di data SPT.');

 // Laporan pembetulan di file yang sama (lib/bpmp-report.js), riwayat dibaca lagi, dan semuanya ikut saat rekap ditimpa.
 const report=require('../lib/bpmp-report'),amendLib=require('../automation/bpmp-amend');
 {const w=new ExcelJS.Workbook();await w.xlsx.readFile(nr.file);const s=w.getWorksheet('NIK');s.getCell(12,4).value='7777777777770001';s.getCell(12,5).value='TUJUH';await w.xlsx.writeFile(nr.file);}
 const out=await report.writeReport({file:nr.file,year:'2026',results:[{number:'BP-FEB-3',period:'02022026',old:'7777',newNik:'7777777777770001',newName:'TUJUH',coretaxName:'TUJUH',status:'DIBETULKAN'}],checks:new Map([['BP-FEB-3','BENAR']]),
  sweep:{total:6,checkedAt:new Date(2026,10,5,10,0),problems:[{number:'BP-JAN-1',nik:'9990000000999000',name:'penerima penghasilan#3403060611030000',masa:'01',why:'NIK sementara'}],sptMasa:[{masa:'02',amended:1,notReported:1}],amendedSlips:[{number:'BP-FEB-3',masa:'02',nik:'7777777777770001',name:'TUJUH',reported:false}]}});
 assert.deepEqual(out,{file:nr.file,locked:false});
 const after=async()=>{const w=new ExcelJS.Workbook();await w.xlsx.readFile(nr.file);const p=w.getWorksheet('Pembetulan'),h=report.headerMap(p),find=no=>{let f=null;p.eachRow((r,n)=>{if(n>1&&res(r.getCell(h.get('Nomor Bukti Potong')).value)===no)f=r;});return f;};return {w,p,h,find};};
 let a=await after();
 assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Status')).value,'DIBETULKAN');assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Pemeriksaan Ulang')).value,'BENAR');
 assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Cek Coretax')).value,'Sudah benar · 05/11/2026 10:00');assert.equal(a.find('BP-JAN-1').getCell(a.h.get('Cek Coretax')).value,'Masih bermasalah · 05/11/2026 10:00');
 const rk2=a.w.getWorksheet('Ringkasan');assert.equal(rk2.getCell(10,7).value.result,'PERLU pembetulan SPT Masa PPh 21');assert.equal(rk2.getCell(9,7).value.result,'Tidak ada bukti potong pembetulan');
 // Angka Ringkasan = COUNTIFS ke sheet Pembetulan (bisa ditelusuri); catatan per bukti potong di sebelah tabel L-IA.
 assert.equal(rk2.getCell(10,6).value.formula,'COUNTIFS(Pembetulan!$A:$A,$A10,Pembetulan!$R:$R,"<>")');assert.equal(rk2.getCell(10,6).value.result,1);assert.equal(rk2.getCell(10,5).value.result,1);assert(rk2.getCell(10,7).value.formula.includes('COUNTIFS(Pembetulan!$A:$A,$A10,Pembetulan!$R:$R,"Belum")'));
 assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Dilaporkan di SPT')).value,'Belum');
 {const lia=a.w.getWorksheet('L-IA');let head=0;lia.eachRow((r,n)=>{if(!head&&r.getCell(1).value==='Masa')head=n;});const hm=report.headerMap(lia,head),nc=hm.get('Catatan Pembetulan'),no=hm.get('Nomor Bukti Potong')||[...hm].find(([k])=>/NOMOR BUKTI/i.test(k))[1];
  let feb3=null;lia.eachRow((r,n)=>{if(n>head&&r.getCell(no).value==='BP-FEB-3')feb3=r;});assert(nc,'kolom Catatan Pembetulan ada');lia.eachRow((r,n)=>{if(n>head)r.eachCell((c,i)=>{if(i!==nc)assert.notEqual(c.font&&c.font.color&&c.font.color.argb,'FFC00000','sel L-IA baris '+n+' kolom '+i+' ikut merah (gaya bersama ExcelJS)');});});assert.equal(feb3.getCell(nc).value.result,'DIBETULKAN · belum dilaporkan di SPT');assert(feb3.getCell(nc).value.formula.startsWith('IFERROR(')&&feb3.getCell(nc).value.formula.includes('INDEX(Pembetulan!$M:$M,MATCH('));}
 assert.match(rk2.getCell(5,1).value,/dicek 05\/11\/2026 10:00\): 1 NIK · 1 bukti potong/);assert.equal(rk2.getCell(6,1).value,'SPT Masa yang perlu dibetulkan: Februari.');
 assert.equal(a.w.worksheets.reduce((s,x)=>s+Object.keys(x._merges||{}).length,0),0);
 let parsed=await amendLib.readTargets(fs.readFileSync(nr.file));
 assert.deepEqual(parsed.targets.map(t=>t.old),['3403060611030000']);assert.match(parsed.skipped.join(' '),/7777: NIK lama tidak terbaca/);assert.equal(parsed.previous.get('7777')[0].status,'DIBETULKAN');
 // Unduh setahun lagi (file yang sama ditimpa): isian NIK Baru dan status pembetulan tetap ada.
 await nb.save(ndir,'ENTITAS UJI','UJI');a=await after();
 assert.equal(a.w.getWorksheet('NIK').getCell(12,4).value,'7777777777770001');assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Status')).value,'DIBETULKAN');
 assert.equal(res(a.find('BP-FEB-3').getCell(a.h.get('NIK Baru')).value),'7777777777770001');assert.equal(a.w.getWorksheet('Ringkasan').getCell(10,7).value.result,'PERLU pembetulan SPT Masa PPh 21');assert.equal(a.find('BP-FEB-3').getCell(a.h.get('Dilaporkan di SPT')).value,'Belum','Dilaporkan di SPT ikut saat rekap ditimpa');
 // Konversi Excel lama ke susunan baru membawa isian dan status yang sama.
 const conv=await require('../lib/a1-import').convertA1Workbook(nr.file,path.join(dir,'konversi'),'UJI');assert.equal(conv.result.carriedInputs,2);
 parsed=await amendLib.readTargets(fs.readFileSync(conv.result.file));assert.equal(parsed.previous.get('7777')[0].status,'DIBETULKAN');assert.equal(parsed.targets.length,1);

 // Lanjutkan proses: hanya baris lengkap yang di-cache; RecordId/versi lain atau cache rusak tidak dipakai.
 const cacheDir=path.join(dir,'.a1-cache'),first=new AnnualWorkbook(2026);first.cacheDir=cacheDir;
 first.record('0126',normal,sheet('100'),true);first.record('0226',normal,sheet('300'),false);first.record('0326',normal,undefined,true);
 const next=new AnnualWorkbook(2026);next.cacheDir=cacheDir;
 assert.deepEqual(next.cached('0126',normal),sheet('100'));assert.equal(next.cached('0226',normal),null);assert.equal(next.cached('0326',normal),null);
 assert.equal(next.cached('0126',amended),null);assert.equal(next.cached('0126',{RecordId:'normal',ReturnSheetModel:'Amendment 001'}),null);
 fs.writeFileSync(path.join(cacheDir,'0426-normal.json'),'{rusak');assert.equal(next.cached('0426',normal),null);
 for(let m=1;m<=12;m++)next.register(String(m).padStart(2,'0')+'26',[]);next.register('0126',[normal]);next.record('0126',normal,next.cached('0126',normal),true,true);
 const resumed=await next.save(dir,'ENTITAS UJI');assert.equal(resumed.partial,false);assert.equal(resumed.control[0][2],'Lengkap (dari proses sebelumnya)');
 assert(!fs.readdirSync(cacheDir).some(f=>f.endsWith('.tmp')));
 // Sumber hasil sebelumnya: Excel Mode A1 format terbaru (ada sheet Analisis NIK dll.) terbaca balik per masa,
 // dan hanya dipakai bila versi pembetulannya sama dengan Coretax.
 const src=require('../lib/a1-source'),srcDir=path.join(dir,'sumber'),a1Dir=path.join(dir,'kosong');
 const prev=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)prev.register(String(m).padStart(2,'0')+'26',m<=2?[m===1?normal:amended]:[]);
 prev.record('0126',normal,L([['1','3403060611030001','DODI','BP-JAN-1','31-01-2026','21-100-01','6.000','0']]),true);prev.record('0226',amended,L([['1','3403060611030001','DODI','BP-FEB-1','28-02-2026','21-100-01','7.000','0']]),true);
 const prevFile=(await prev.save(srcDir,'ENTITAS UJI')).file;
 const seen=await src.inspect({a1Dir,source:prevFile,year:'2026',sptDir:path.join(dir,'spt-kosong')});
 assert.equal(seen.excel,prevFile);assert.deepEqual(seen.rows.slice(0,3).map(r=>[r.masa,r.excel&&r.excel.revision,r.excel&&r.excel.data,r.pdf]),[['Januari',0,'Lengkap',false],['Februari',1,'Lengkap',false],['Maret',null,'Belum ada SPT',false]]);
 const loaded=await src.load({a1Dir,source:srcDir,year:'2026'});
 assert.deepEqual(Object.keys(loaded.seed).sort(),['0126','0226']);
 const fresh=new AnnualWorkbook(2026);fresh.seed=loaded.seed;
 assert.equal(fresh.seeded('0126',{RecordId:'baru',ReturnSheetModel:'Normal'})[0].tables[0].rows[0][6],'6.000');
 assert.equal(fresh.seeded('0226',{RecordId:'x',ReturnSheetModel:'Pembetulan 2'}),null,'pembetulan baru di Coretax -> tidak dipakai ulang');
 assert.equal(fresh.seeded('0326',normal),null);
 const {a1SaveRoot}=require('../automation/spt').__test,root=path.join(dir,'CoretaxAgent');
 for(const chosen of [root,path.join(root,'PJS'),path.join(root,'pjs','SPT'),path.join(root,'PJS','SPT','A1'),path.join(root,'PJS','SPT','A1','2026')])assert.equal(a1SaveRoot(chosen,'PJS'),root,chosen);
 assert.equal(a1SaveRoot(path.join(root,'PJS','Arsip'),'PJS'),path.join(root,'PJS','Arsip'));
 fs.mkdirSync(path.join(root,'PJS','PJS','SPT'),{recursive:true});assert.equal(a1SaveRoot(path.join(root,'PJS'),'PJS'),path.join(root,'PJS'));
 console.log('PASS: A1 latest revision; all-version PDF completeness; annual totals; Masa; IDs; no fallback on failure; schema mismatch; resume cache; folder lama; susunan Ringkasan/NIK/Pembetulan; laporan + carry-over.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
