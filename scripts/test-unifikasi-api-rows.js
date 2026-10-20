// Lampiran Unifikasi dari API grid harus tampil persis seperti tabel Coretax (fixture: tangkapan live
// BIRU BIANTI September 2026 DAFTAR-I BPPU, NIK/nama disamarkan). Judul kolom tiap grid harus sama dengan
// definisi Coretax; kode di luar referensi resmi ditolak (tabel lalu dibaca lewat paginator).
const assert=require('assert'),path=require('path');
const {toDisplayRows,COLUMNS,GRIDS}=require('../lib/lampiran-api-unifikasi');
module.exports=async function(){
 const fx=require(path.join(__dirname,'fixtures','unifikasi-api-rows.json'));
 assert.deepStrictEqual(toDisplayRows(fx.endpoint,fx.headers,fx.api,fx.lists),fx.screen);
 // Judul kolom layar tiap grid lain cocok dengan definisinya (tabel kosong pun diperiksa).
 for(const [ep,headers] of Object.entries(fx.headersOther)){
  assert.ok(COLUMNS[ep],ep);
  const sample=Object.fromEntries(COLUMNS[ep].filter(c=>c[1]).map(([,f,fmt])=>[f,fmt==='money'||fmt==='rate'?1:fmt==='date'?'2026-09-30T00:00:00+07:00':fmt.startsWith('ref')?Object.keys(fx.lists[fmt.split(':')[1]])[0]:'x']));
  assert.equal(toDisplayRows(ep,headers,[sample],fx.lists).length,1,ep);
 }
 assert.deepStrictEqual(Object.values(GRIDS).flat().sort(),Object.keys(COLUMNS).sort());
 const row=fx.api[0],col=h=>fx.headers.indexOf(h);
 assert.equal(toDisplayRows(fx.endpoint,fx.headers,[{...row,PaymentMethod:'IMPREST'}],fx.lists)[0][col('UANG PERSEDIAAN / PEMBAYARAN LANGSUNG (UNTUK WP INSTANSI PEMERINTAH DENGAN DANA APBN)')],'Mekanisme Uang Persediaan');
 assert.equal(toDisplayRows(fx.endpoint,fx.headers,[{...row,TaxRate:1.75}],fx.lists)[0][col('TINGKAT (%)')],'1,75');
 assert.equal(toDisplayRows(fx.endpoint,fx.headers,[row],fx.lists)[0][0],'1.');
 assert.throws(()=>toDisplayRows(fx.endpoint,fx.headers,[{...row,TaxCertificate:'99'}],fx.lists),/tidak ada di referensi/);
 assert.throws(()=>toDisplayRows(fx.endpoint,fx.headers,[{...row,PaymentMethod:'CASH'}],fx.lists),/tidak ada di referensi/);
 assert.throws(()=>toDisplayRows(fx.endpoint,[...fx.headers.slice(0,-1),'KOLOM LAIN'],fx.api,fx.lists),/berbeda dari definisi/);
 assert.throws(()=>toDisplayRows('/loadwtr/belum-ada',fx.headers,fx.api,fx.lists),/belum terpetakan/);
 console.log('PASS: Unifikasi API rows = layar Coretax ('+fx.api.length+' baris BPPU); 5 grid sesuai definisi Coretax; kode/kolom asing ditolak.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
