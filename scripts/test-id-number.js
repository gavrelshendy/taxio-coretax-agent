// Angka gaya Indonesia tanpa Intl (exe tidak membawa data locale id-ID): rupiah bulat dan desimal koma,
// dibulatkan setengah menjauhi nol dari nilai desimalnya seperti pipa angka Angular di layar Coretax.
const assert=require('assert');
const {money,fixed}=require('../lib/id-number');
module.exports=async function(){
 for(const [v,e] of [[2646648,'2.646.648'],[0,'0'],[999,'999'],[1000,'1.000'],[-1.5,'-2'],[1.5,'2'],[1234567.5,'1.234.568'],[-0.4,'0'],['317906190','317.906.190'],[14819820731.67,'14.819.820.732']])assert.equal(money(v),e,'money '+v);
 for(const [v,e] of [[1.5,'1,50'],[0,'0,00'],[1,'1,00'],[1.755,'1,76'],[2.005,'2,01'],[1000,'1.000,00'],[-1.25,'-1,25'],[-0.001,'0,00']])assert.equal(fixed(v,2),e,'fixed '+v);
 console.log('PASS: angka Indonesia tanpa Intl (titik ribuan, desimal koma, pembulatan desimal menjauhi nol).');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
