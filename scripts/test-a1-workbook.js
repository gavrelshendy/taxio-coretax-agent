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
 // Kolom: NIK, Nama, NIK lama, NIK Baru, Nama Baru, Keterangan, Jumlah masa (7), Bruto (8), Jan..Des Bruto (9..20).
 assert.deepEqual(sum.getRow(5).values.slice(1,9),['NIK','Nama','NIK lama (dari #)','NIK Baru','Nama Baru','Keterangan','Jumlah masa','Penghasilan Bruto (Rp)']);
 assert.equal(cell(6,1),'1111111111111111');assert.equal(cell(6,7),2);assert.equal(cell(6,8),3000);
 assert.equal(cell(7,3),'1213123');assert.equal(cell(7,8),750);assert.equal(cell(8,3),'9999');assert.equal(cell(8,8),700);
 assert.match(sum.getCell(6,8).value.formula,/^SUMIFS\('L-IA'!\$E\$8:\$E\$12,'L-IA'!\$C\$8:\$C\$12,\$A6&"\*"\)$/);
 assert.match(sum.getCell(7,8).value.formula,/'L-IA'!\$D\$8:\$D\$12,"\*#"&\$C7\)$/);
 assert.equal(sum.getCell(7,1).fill.fgColor.argb,'FFFFE699');assert.notEqual((sum.getCell(6,1).fill||{}).fgColor?.argb,'FFFFE699');
 assert.equal(sum.getCell(6,4).fill.fgColor.argb,'FFE2EFDA');assert.equal(sum.getCell(7,5).fill.fgColor.argb,'FFE2EFDA');
 assert.equal(twb.getWorksheet('L-IA').getCell('C9').fill.fgColor.argb,'FFFFE699');assert.notEqual((twb.getWorksheet('L-IA').getCell('C8').fill||{}).fgColor?.argb,'FFFFE699');
 assert.equal(cell(9,8),4450);
 // Ringkasan menyamping per masa: kolom 9..20 = Jan..Des (Bruto).
 assert.equal(cell(6,9),1000);assert.equal(cell(6,10),2000);assert.equal(cell(6,11),0);assert.equal(cell(7,9),500);assert.equal(cell(7,10),250);assert.equal(cell(8,9),700);assert.equal(cell(9,9),2200);assert.equal(cell(9,10),2250);
 assert.match(sum.getCell(6,10).value.formula,/,'L-IA'!\$A\$8:\$A\$12,"Februari"\)$/);assert.equal(sum.getCell(5,9).value,'Bruto Jan');assert.equal(sum.getCell(5,20).value,'Bruto Des');
 assert.equal(sum.getCell(5,9).fill.fgColor.argb,'FFBDD7EE');assert.equal(sum.getCell(9,9).border.left.style,'thin');

 // NIK salah ketik di nomor urut: baris # diurutkan tepat di atas NIK benarnya, diwarnai berbeda, dan masuk Draft Pembetulan.
 const L=(rs)=>[{label:'L-IA',tables:[{title:'Tabel',headers:['No.','NIK/NPWP','Nama','Nomor Bukti Potong','Tanggal Bukti Pemotongan','Kode Objek Pajak','Penghasilan Bruto (Rp)','Pajak Penghasilan (Rp)'],rows:rs,moneyCols:[6,7],totals:{6:sumAmounts(rs.map(r=>r[6])),7:sumAmounts(rs.map(r=>r[7]))},sourceTotals:[],records:true}],fields:[],otherText:''}];
 const nb=new AnnualWorkbook(2026);for(let m=1;m<=12;m++)nb.register(String(m).padStart(2,'0')+'26',[]);
 nb.register('0126',[normal]);nb.record('0126',normal,L([['1','9990000000999000','penerima penghasilan#3403060611030000','BP-JAN-1','31-01-2026','21-100-01','5.000','0'],['2','5555555555555555','ANI','BP-JAN-2','31-01-2026','21-100-01','4.000','0'],['3','1234567890120000','CICI','BP-JAN-3','31-01-2026','21-100-01','1.000','0']]),true);
 nb.register('0226',[normal]);nb.record('0226',normal,L([['1','3403060611030001','DODI','BP-FEB-1','28-02-2026','21-100-01','6.000','0'],['2','5555555555550001','ANA','BP-FEB-2','28-02-2026','21-100-01','2.000','0'],['3','9990000000999000','penerima penghasilan#7777','BP-FEB-3','28-02-2026','21-100-01','3.000','0']]),true);
 const nr=await nb.save(dir,'ENTITAS UJI');assert.equal(nr.draftRows,3);
 const nwb=new ExcelJS.Workbook();await nwb.xlsx.readFile(nr.file);const ns=nwb.getWorksheet('BPMP per NIK'),note=headers=>ns.getRow(5).values.indexOf('Catatan');
 const ids=[6,7,8,9,10,11].map(r=>[ns.getCell(r,1).value,ns.getCell(r,3).value]);
 assert.deepEqual(ids,[['1234567890120000',''],['9990000000999000','3403060611030000'],['3403060611030001',''],['5555555555550001',''],['5555555555555555',''],['9990000000999000','7777']]);
 const fillOf=r=>(ns.getCell(r,1).fill||{}).fgColor?.argb;
 assert.equal(fillOf(6),'FFFFE699');assert.equal(fillOf(7),'FFFFE699');assert.equal(fillOf(8),'FFDDEBF7');assert.equal(fillOf(9),'FFF8CBAD');assert.equal(fillOf(10),'FFF8CBAD');assert.equal(fillOf(11),'FFFFE699');
 const nc=note();assert.match(ns.getCell(7,nc).value,/usulan NIK benar 3403060611030001/);assert.match(ns.getCell(8,nc).value,/3403060611030000/);assert.match(ns.getCell(11,nc).value,/isi NIK benar secara manual/);
 // Isian NIK Baru / Nama Baru terisi otomatis hanya bila usulannya tunggal.
 assert.deepEqual([ns.getCell(7,4).value,ns.getCell(7,5).value],['3403060611030001','DODI']);assert.ok(!ns.getCell(6,4).value&&!ns.getCell(11,4).value&&!ns.getCell(8,4).value);
 // Keterangan: tindakan dalam bahasa biasa, tanpa kode kasus dan tanpa garis tebal.
 assert.deepEqual([6,7,8,9,10,11].map(r=>ns.getCell(r,6).value),['NIK salah → isi NIK Baru dari KTP','NIK salah → ganti 3403060611030001','NIK benar (pengganti 3403060611030000)','Mirip 5555555555555555 → cek orang yang sama','Mirip 5555555555550001 → cek orang yang sama','NIK salah → isi NIK Baru dari KTP']);
 assert.ok(!(ns.getCell(7,1).border||{}).top);
 assert.deepEqual(nr.nik,{nik:3,bukti:3,auto:{cases:1,nik:1},check:{cases:1,nik:2},manual:{cases:2,nik:2}});
 const an=nwb.getWorksheet('Analisis NIK'),atext=[];an.eachRow(row=>atext.push(row.values.slice(1).map(v=>v&&v.formula!==undefined?v.result:v).join(' | ')));
 assert.match(atext[1],/NIK bermasalah: 3 NIK lama · 3 bukti potong · masa Januari, Februari\./);
 assert.ok(atext.some(t=>/^A\. Terisi otomatis .* \(1 NIK\)$/.test(t)));assert.ok(atext.some(t=>/^3403060611030000 \| penerima penghasilan#3403060611030000 \| 3403060611030001 \| DODI \| NIK salah → ganti 3403060611030001 \| 1 \| Jan$/.test(t)));
 assert.ok(!atext.some(t=>/\bK\d\d\b/.test(t)));
 assert.deepEqual(nwb.worksheets.map(s=>s.name).slice(-4),['BPMP per NIK','Analisis NIK','Draft Pembetulan','Kontrol']);
 const dr=nwb.getWorksheet('Draft Pembetulan'),drow=r=>dr.getRow(r).values.slice(1),res=v=>v&&v.formula!==undefined?v.result:v;
 assert.deepEqual(drow(6).slice(0,8),[1,'Januari','BP-JAN-3','31-01-2026','21-100-01','1234567890120000','CICI','']);
 assert.deepEqual(drow(7).slice(0,8),[2,'Januari','BP-JAN-1','31-01-2026','21-100-01','9990000000999000','penerima penghasilan#3403060611030000','3403060611030000']);
 assert.equal(dr.getCell(7,9).value.formula,"IF('BPMP per NIK'!$D$7=\"\",\"\",'BPMP per NIK'!$D$7)");assert.equal(res(dr.getCell(7,9).value),'3403060611030001');assert.equal(res(dr.getCell(7,10).value),'DODI');
 assert.equal(drow(7)[11],5000);assert.equal(drow(8)[2],'BP-FEB-3');assert.equal(dr.getCell(8,9).fill.fgColor.argb,'FFFFE699');assert.equal(dr.getCell(7,9).fill.fgColor.argb,'FFE2EFDA');
 assert.match(String(dr.getCell(10,2).value),/Januari \(2 bukti potong\), Februari \(1 bukti potong\)/);
 const clean=new ExcelJS.Workbook();await clean.xlsx.readFile((await available.save(path.join(dir,'bersih'),'ENTITAS UJI')).file);assert.equal(clean.getWorksheet('Draft Pembetulan').getCell(6,2).value,'Tidak ada bukti potong dengan NIK bermasalah.');

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
 console.log('PASS: A1 latest revision; all-version PDF completeness; annual totals; Masa; IDs; no fallback on failure; schema mismatch; resume cache; folder lama.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
