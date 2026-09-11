// Only aggregate fields enter the printable document; recipient rows are never copied.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function format(value){
 if(!Number.isFinite(Number(value)))throw Error('Nilai ringkasan Confidential tidak valid.');
 const [whole,decimal]=Number(value).toFixed(2).split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(decimal==='00'?'':','+decimal);
}
function summaryTab(summaries){
 const expected=['L-IA','L-IB','L-II','L-III'];
 if(summaries.length!==4||expected.some(code=>summaries.filter(s=>s.code===code).length!==1))throw Error('Ringkasan Confidential harus mencakup L-IA, L-IB, L-II, dan L-III.');
 const rows=expected.map(code=>{const s=summaries.find(s=>s.code===code);if(!Number.isSafeInteger(s.count)||s.count<0)throw Error('Jumlah data Confidential tidak valid.');return '<tr>'+[s.code,s.title,format(s.count),format(s.grossIncome),format(s.incomeTax)].map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>';}).join('');
 return {label:'L1-L3',tables:[],html:'<style>table.confidential col:nth-child(1){width:8%!important}table.confidential col:nth-child(2){width:52%!important}table.confidential col:nth-child(3){width:8%!important}table.confidential col:nth-child(4){width:17%!important}table.confidential col:nth-child(5){width:15%!important}table.confidential td:nth-child(3){text-align:center!important}</style><section class="p-panel"><div class="p-panel-header">RINGKASAN LAMPIRAN PPh PASAL 21 DAN/ATAU PASAL 26</div><p>Confidential — tanpa rincian penerima. Jumlah data dan total ditampilkan per lampiran.</p><table class="confidential"><thead><tr>'+['KODE','JUDUL LAMPIRAN','JUMLAH DATA','TOTAL PENGHASILAN BRUTO (Rp)','TOTAL PPh (Rp)'].map(v=>'<th>'+v+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></section>'};
}
async function renderConfidential(summaries,meta,options){return require('./lampiran-export').renderTabs([summaryTab(summaries)],meta,{...options,mode:'confidential',format:'pdf'});}
module.exports={summaryTab,renderConfidential,format};
