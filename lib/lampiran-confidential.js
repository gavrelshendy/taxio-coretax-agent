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
 const total=expected.reduce((a,code)=>{const s=summaries.find(x=>x.code===code);return{count:a.count+s.count,gross:a.gross+Math.round(Number(s.grossIncome)*100),tax:a.tax+Math.round(Number(s.incomeTax)*100)};},{count:0,gross:0,tax:0});
 const cell=v=>'<span>'+esc(v)+'</span>';
 const totalBar='<div class="conf-total">'+cell('TOTAL SELURUH LAMPIRAN')+cell(format(total.count))+cell(format(total.gross/100))+cell(format(total.tax/100))+'</div>';
 const css='table.confidential{width:100%!important;border-collapse:collapse!important;margin-top:6px!important}'
  +'table.confidential col:nth-child(1){width:7%!important}table.confidential col:nth-child(2){width:53%!important}table.confidential col:nth-child(3){width:8%!important}table.confidential col:nth-child(4){width:17%!important}table.confidential col:nth-child(5){width:15%!important}'
  +'table.confidential th{font-size:11px!important;padding:9px 8px!important;text-align:center!important;vertical-align:middle!important}'
  +'table.confidential td{font-size:11.5px!important;padding:9px 10px!important;vertical-align:middle!important;border-bottom:1px solid #d9dee8!important}'
  +'table.confidential td:nth-child(1){text-align:center!important;font-weight:700!important;color:#000!important}'
  +'table.confidential td:nth-child(2){text-align:left!important;line-height:1.45!important;color:#333!important}'
  +'table.confidential td:nth-child(3){text-align:center!important}table.confidential td:nth-child(4),table.confidential td:nth-child(5){text-align:right!important;font-variant-numeric:tabular-nums!important}'
  +'table.confidential tbody tr:nth-child(even) td{background:#f6f8fb!important}'
  +'div.conf-total span{display:inline-block!important;box-sizing:border-box!important;padding:0 10px!important}div.conf-total span:nth-child(1){width:60%!important;text-align:left!important}div.conf-total span:nth-child(2){width:8%!important;text-align:center!important}div.conf-total span:nth-child(3){width:17%!important;text-align:right!important}div.conf-total span:nth-child(4){width:15%!important;text-align:right!important}'
  +'div.conf-total{display:block!important;white-space:nowrap!important;width:100%!important;box-sizing:border-box!important;padding:10px 0!important;background:#D3D3D3!important;border-top:1.5px solid #808080!important;font-size:11.5px!important;font-weight:700!important;color:#000!important;font-variant-numeric:tabular-nums!important}'
  +'p.conf-note{margin:10px 2px 4px!important;font-size:10.5px!important;color:#586174!important;font-style:italic!important}';
 return {label:'L-IA s.d. L-III',tables:[],html:'<style>'+css+'</style><section class="p-panel"><div class="p-panel-header">RINGKASAN LAMPIRAN PPh PASAL 21 DAN/ATAU PASAL 26</div><p class="conf-note">Rahasia — tanpa rincian penerima. Jumlah data dan total ditampilkan per lampiran.</p><table class="confidential"><thead><tr>'+['KODE','JUDUL LAMPIRAN','JUMLAH DATA','TOTAL PENGHASILAN BRUTO (Rp)','TOTAL PPh (Rp)'].map(v=>'<th>'+v+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table>'+totalBar+'</section>'};
}
async function renderConfidential(summaries,meta,options){return require('./lampiran-export').renderTabs([summaryTab(summaries)],meta,{...options,mode:'confidential',format:'pdf'});}
module.exports={summaryTab,renderConfidential,format};
