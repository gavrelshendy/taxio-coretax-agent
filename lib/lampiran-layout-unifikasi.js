module.exports=({references:objectMap})=>{

 const translationAudit=[];
 const style=document.createElement('style');style.textContent=`thead{break-inside:avoid!important}.keep{break-inside:auto!important}p-table{margin-top:0!important} .p-panel-header{margin-bottom:0!important} h1,h2,h3,h4,h5,h6{margin:0 0 3mm!important}p{margin:0 0 2mm!important}.col-12,.row,.grid{padding:0!important;margin:0!important}.p-panel-header,.p-accordion-header-link{margin:3mm 0!important;padding:2mm!important}.p-panel{margin:0 0 3mm!important}.p-panel-content,.p-toggleable-content,.p-accordion-content{margin:0!important;padding:0!important}table.compact *{font-size:8pt!important;line-height:1.25!important}table.wide *{font-size:7.5pt!important;line-height:1.22!important}table.compact th,table.compact td{padding:1.1mm .7mm!important}table.source-totals td{background:#eef2f5!important}.p-datatable{display:block!important}`;document.head.append(style);
 // A <br> the Coretax markup leaves between a table's body and its foot is not inside any cell, so
 // it renders as a stray line box - a ~33px gap above the totals, most visible once a table has
 // little content. Inside a cell a <br> is a real line break and stays.
 document.querySelectorAll('br').forEach(n=>{if(!n.closest('table'))n.replaceWith(document.createTextNode(' '));else if(!n.closest('td,th'))n.remove()});
 // Pin every column that would otherwise fall below the longest word of its own header, then
 // rescale the rest into what is left of the 310mm body.
 const fit=(widths,heads)=>{
  const pinned=widths.map(()=>false);
  for(let pass=0;pass<widths.length;pass++){
   const fixed=widths.reduce((a,w,i)=>a+(pinned[i]?heads[i]:0),0),flex=widths.reduce((a,w,i)=>a+(pinned[i]?0:w),0);
   if(flex<=0||fixed>=310)break;
   const scale=(310-fixed)/flex,next=widths.findIndex((w,i)=>!pinned[i]&&w*scale<heads[i]);
   if(next<0){widths.forEach((w,i)=>{widths[i]=pinned[i]?heads[i]:w*scale});break}
   pinned[next]=true;
  }
  return widths;
 };
 const sized=[];
 document.querySelectorAll('table').forEach(table=>{
 const head=table.tHead?.rows[0];if(!head)return;const labels=[...head.cells].map(c=>c.textContent.trim());const n=labels.length;
 const rows=[...table.tBodies].flatMap(b=>[...b.rows]);rows.forEach(r=>[...r.cells].forEach(c=>c.textContent=c.textContent.trim()));
 const data=rows.filter(r=>r.cells.length===n&&r.cells[0].colSpan===1);
 if(/^NO\.?$/i.test(labels[0]))data.forEach((r,i)=>{r.cells[0].textContent=(i+1).toLocaleString('id-ID');r.cells[0].style.setProperty('text-align','center','important')});

 const center=/^(NO\.?$|NIK|NPWP|Nomor Identitas|ID TEMPAT|NITKU|FASILITAS|Negara|STATUS|KAP-KJS|JENIS PAJAK|KODE|NOMOR BUKTI|TANGGAL|Faktur Pajak|Dokumen Tertentu|UANG PERSEDIAAN)/i;
 data.forEach(r=>[...r.cells].forEach((c,i)=>{if(center.test(labels[i]))c.style.setProperty('text-align','center','important')}));

 const codeColumn=labels.findIndex(v=>/^KODE OBJEK PAJAK$/i.test(v)),objectColumn=labels.findIndex(v=>/^OBJEK PAJAK$/i.test(v)),taxColumn=labels.findIndex(v=>/^JENIS PAJAK$/i.test(v));
 if(codeColumn>=0&&objectColumn>=0&&taxColumn>=0)data.forEach(r=>{if(!/^(PPh\s*)?Pasal\s*23$/i.test(r.cells[taxColumn].textContent.trim()))return;const code=r.cells[codeColumn].textContent.trim();if(!objectMap[code])throw Error('Referensi objek PPh 23 tidak ditemukan: '+code);translationAudit.push({code,before:r.cells[objectColumn].textContent.trim(),after:objectMap[code]});r.cells[objectColumn].textContent=objectMap[code]});
 document.body.dataset.translationAudit=JSON.stringify(translationAudit);
 if(n<12)return;
 table.classList.add('compact');if(n>=16)table.classList.add('wide');
 const ctx=document.createElement('canvas').getContext('2d');ctx.font=(n>=16?'10':'10.667')+'px Segoe UI';const measure=v=>ctx.measureText(v).width/3.7795+1.8;
 const widths=labels.map((v,i)=>/^NO\.?$/i.test(v)?7:/^OBJEK PAJAK$/i.test(v)?40:/^NAMA$/i.test(v)?29:/FASILITAS/i.test(v)?21:/UANG PERSEDIAAN/i.test(v)?22:/NITKU|ID TEMPAT/i.test(v)?36:/NIK|NPWP/i.test(v)?26:/TANGGAL/i.test(v)?18:/KAP-KJS/i.test(v)?15:/STATUS/i.test(v)?15:/Negara/i.test(v)?15:/NOMOR BUKTI/i.test(v)?19:/KODE OBJEK/i.test(v)?16:/TARIF|TINGKAT/i.test(v)?11:/JENIS PAJAK/i.test(v)?16:23);
 data.forEach(r=>[...r.cells].forEach((c,i)=>{const val=c.textContent.trim();if(/^[\d.,]+$/.test(val)||/NOMOR BUKTI|TANGGAL|KAP-KJS|KODE OBJEK/.test(labels[i]))widths[i]=Math.max(widths[i],measure(val));if(/JENIS PAJAK|Negara|STATUS|KODE OBJEK|KAP-KJS/.test(labels[i]))c.style.setProperty('text-align','center','important')}));
 // Header cells wrap with overflow-wrap:anywhere and these widths are then normalised to the
 // 310mm body, so a column can end up narrower than the longest word of its own header and split
 // that word ("TINGKA/T (%)"). `heads` is what that longest word needs.
 ctx.font='600 '+(n>=16?'10':'10.667')+'px Segoe UI';
 const heads=labels.map(v=>Math.max(0,...String(v).split(/[\s/()-]+/).filter(Boolean).map(measure)));
 ctx.font=(n>=16?'10':'10.667')+'px Segoe UI';
 // A column the form defines but this filer never uses (UANG PERSEDIAAN only applies to
 // government-budget filers, for instance) keeps its full reserved width for nothing; give that
 // space back to the columns that carry data, down to what its own header still needs.
 if(data.length)labels.forEach((v,i)=>{if(data.every(r=>!r.cells[i].textContent.trim()))widths[i]=Math.min(widths[i],heads[i])});
 sized.push({table,widths,heads,key:JSON.stringify(labels),empty:!data.length});
 });
 // Sibling tables sharing one header (TABEL I. BPPU / TABEL II. BPNR) are laid out on a single
 // grid. Sized apart, an empty sibling has no data to widen its columns, so every boundary drifts
 // a few millimetres against the table above it and the two read as unrelated.
 const groups=new Map();
 for(const item of sized){if(!groups.has(item.key))groups.set(item.key,[]);groups.get(item.key).push(item)}
 for(const group of groups.values()){
  const source=group.filter(i=>!i.empty).length?group.filter(i=>!i.empty):group;
  const widths=fit(source[0].widths.map((_,i)=>Math.max(...source.map(s=>s.widths[i]))),source[0].heads);
  const sum=widths.reduce((a,b)=>a+b,0);
  for(const {table} of group){
   table.querySelectorAll('colgroup').forEach(c=>c.remove());
   const cg=document.createElement('colgroup');
   widths.forEach(w=>{const c=document.createElement('col');c.style.width=(w/sum*100)+'%';cg.append(c)});
   table.prepend(cg);
  }
 }
 document.querySelectorAll('*').forEach(n=>{if(n.tagName.includes('-')&&!n.closest('table'))n.style.display='block'});
 document.querySelectorAll('.p-panel-header,.p-accordion-header-link').forEach(n=>{if(!n.textContent.trim())n.remove()});
};
