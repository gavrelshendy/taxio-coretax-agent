// node scripts/a1-convert.js "<Mode A1 - 2026.xlsx>" "<folder hasil>"
// Menyusun ulang Excel Mode A1 lama ke format terbaru tanpa membuka Coretax.
const path=require('path');
const {convertA1Workbook}=require('../lib/a1-import');
const [file,out]=process.argv.slice(2);
if(!file){console.error('Pakai: node scripts/a1-convert.js <file.xlsx> [folder hasil]');process.exit(1);}
convertA1Workbook(file,out||path.join(path.dirname(file),'A1 format baru')).then(({entity,result})=>{
 console.log(entity+' -> '+result.file);
 console.log('Masa terbaca: '+result.selected+(result.partial?' (BELUM LENGKAP)':'')+' · baris NIK sementara: '+result.tempNikRows+' · Draft Pembetulan: '+result.draftRows+' bukti potong');
}).catch(e=>{console.error(e.message);process.exitCode=1;});
