// Lampiran PPh 21 dari API grid harus tampil persis seperti tabel Coretax (fixture: tangkapan live
// BIRU BIANTI September 2026, NIK/nama disamarkan): rupiah, tarif 2 desimal, tanggal, masa perolehan,
// kode fasilitas/status/negara lewat referensi Coretax. Kolom atau kode yang tidak dikenal harus GAGAL
// (lalu tabel dibaca lewat paginator), bukan ditebak.
const assert=require('assert'),path=require('path');
const {toDisplayRows,GRIDS}=require('../lib/lampiran-api-pph21');
module.exports=async function(){
 const fx=require(path.join(__dirname,'fixtures','pph21-api-rows.json'));
 let rows=0;
 for(const t of fx.tables){
  assert.ok(GRIDS[t.label].some(g=>g.endsWith('/'+t.grid)),t.grid);
  const built=toDisplayRows(t.headers,t.api,fx.lists);
  assert.deepStrictEqual(built,t.screen,t.label+' '+t.grid);rows+=built.length;
 }
 assert.ok(rows>=12,'fixture berisi baris');
 const ia=fx.tables.find(t=>t.grid==='l1a-grid');
 // Kode di luar referensi, kolom asing, dan kode kosong ditolak.
 assert.throws(()=>toDisplayRows(ia.headers,[{...ia.api[0],TaxCertificate:'99'}],fx.lists),/tidak ada di referensi/);
 assert.throws(()=>toDisplayRows(ia.headers,[{...ia.api[0],Status:'AMENDMENT_X'}],fx.lists),/tidak ada di referensi/);
 assert.throws(()=>toDisplayRows([...ia.headers,'KOLOM BARU'],ia.api,fx.lists),/belum terpetakan/);
 assert.throws(()=>toDisplayRows(ia.headers,[{...ia.api[0],CountryCode:null}],fx.lists),/kosong/);
 // Pembetulan, tarif desimal, negatif dibulatkan menjauhi nol.
 const [r]=toDisplayRows(ia.headers,[{...ia.api[0],Status:'AMENDMENT',TaxRate:1.5,GrossIncome:-1.5,IncomeTax:1234567.5}],fx.lists);
 const col=h=>ia.headers.findIndex(x=>x.startsWith(h));
 assert.equal(r[col('STATUS')],'Pembetulan');assert.equal(r[col('TARIF')],'1,50');assert.equal(r[col('PENGHASILAN BRUTO')],'-2');assert.equal(r[col('PAJAK PENGHASILAN')],'1.234.568');
 const ii=fx.tables.find(t=>t.grid==='l2-bpa1-grid');
 assert.throws(()=>toDisplayRows(ii.headers,[{...ii.api[0],IncomePeriodStart:'13132026'}],fx.lists),/kode masa/);
 assert.deepStrictEqual(toDisplayRows(ia.headers,[],{}),[]);
 console.log('PASS: PPh 21 API rows = layar Coretax ('+rows+' baris, 7 tabel); kode/kolom asing ditolak; pembetulan/tarif/pembulatan.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
