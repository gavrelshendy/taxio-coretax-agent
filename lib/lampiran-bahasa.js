// Translate display labels only; never alter names, identifiers or transaction values.
module.exports = () => {
 const labels = new Map([
  ['TOTAL INCOME TAX TO BE PAID','JUMLAH PAJAK PENGHASILAN YANG HARUS DIBAYAR'],
  ['TOTAL INCOME PAX TO BE PAID','JUMLAH PAJAK PENGHASILAN YANG HARUS DIBAYAR'],
  ['TOTAL GROSS INCOME','JUMLAH PENGHASILAN BRUTO'],
  ['TOTAL INCOME TAX','JUMLAH PAJAK PENGHASILAN'],
  ['TOTAL ENTERTAINMENT','TOTAL JAMUAN'],
  ['LAND AND/OR BUILDING RENTAL','Persewaan tanah dan/atau bangunan'],
  ['CONSTRUCTION WORK CARRIED OUT BY SERVICE PROVIDERS WHO HAVE A SMALL QUALIFICATION BUSINESS ENTITY CERTIFICATE OR WORK COMPETENCY CERTIFICATE FOR INDIVIDUAL BUSINESS','Pekerjaan konstruksi oleh penyedia jasa yang memiliki sertifikat badan usaha kualifikasi kecil atau sertifikat kompetensi kerja untuk usaha orang perseorangan'],
  ['CONSTRUCTION WORK CARRIED OUT BY SERVICE PROVIDERS WHO DO NOT HAVE A BUSINESS ENTITY CERTIFICATE OR WORK COMPETENCY CERTIFICATE FOR INDIVIDUAL BUSINESS','Pekerjaan konstruksi oleh penyedia jasa yang tidak memiliki sertifikat badan usaha atau sertifikat kompetensi kerja untuk usaha orang perseorangan'],
  ['WITHHOLDING OR COLLECTION OF INCOME TAX ON SALES OF GOODS OR DELIVERY OF SERVICES MADE BY TAXPAYERS WITH CERTAIN GROSS TURNOVER IN ACCORDANCE WITH GOVERNMENT REGULATION NUMBER 23 YEAR 2018 OR GOVERNMENT REGULATION NUMBER 55 YEAR 2022.','Pemotongan atau pemungutan pajak penghasilan atas penjualan barang atau penyerahan jasa oleh wajib pajak dengan peredaran bruto tertentu sesuai Peraturan Pemerintah Nomor 23 Tahun 2018 atau Peraturan Pemerintah Nomor 55 Tahun 2022.'],
  ['NO RECORDS FOUND','Tidak ada data yang ditemukan.'],
  ['NO DATA FOUND','Tidak ada data yang ditemukan.'],
  ['NO RECORDS FOUND.','Tidak ada data yang ditemukan.']
 ]);
 const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
 const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){
  if(node.parentElement?.closest('script,style'))continue;
  const value=node.textContent.replace(/\s+/g,' ').trim();
  const translated=labels.get(value.toUpperCase());
  if(translated)node.textContent=translated;
  else if(/^LIST-[A-Z0-9-]+$/i.test(value))node.textContent=value.replace(/^LIST-/i,'DAFTAR-');
 }
};
