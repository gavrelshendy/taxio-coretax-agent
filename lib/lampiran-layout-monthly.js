module.exports=()=>{
 const style=document.createElement('style');style.textContent=`thead{break-inside:avoid!important}.keep{break-inside:auto!important}p-table{margin-top:0!important} .p-panel-header{margin-bottom:0!important} h1,h2,h3,h4,h5,h6{margin:0 0 3mm!important}p{margin:0 0 2mm!important}.col-12,.row,.grid{padding:0!important;margin:0!important}.p-panel-header,.p-accordion-header-link{margin:3mm 0!important;padding:2mm!important}.p-panel{margin:0 0 3mm!important}.p-panel-content,.p-toggleable-content,.p-accordion-content{margin:0!important;padding:0!important}table.compact *{font-size:8pt!important;line-height:1.25!important}table.wide *{font-size:7.5pt!important;line-height:1.22!important}table.compact th,table.compact td{padding:1.1mm .7mm!important}table.source-totals td{background:#eef2f5!important}.p-datatable{display:block!important}`;document.head.append(style);
 document.querySelectorAll('br').forEach(n=>{if(!n.closest('table'))n.replaceWith(document.createTextNode(' '))});
 document.querySelectorAll('table').forEach(table=>{
 const head=table.tHead?.rows[0];if(!head)return;const labels=[...head.cells].map(c=>c.textContent.trim());const n=labels.length;
 const rows=[...table.tBodies].flatMap(b=>[...b.rows]);
 const data=rows.filter(r=>r.cells.length===n&&r.cells[0].colSpan===1);
 if(/^NO\.?$/i.test(labels[0]))data.forEach((r,i)=>{r.cells[0].textContent=(i+1).toLocaleString('id-ID');r.cells[0].style.setProperty('text-align','center','important')});

 const center=/^(NO\.?$|NIK|NPWP|Nomor Identitas|ID TEMPAT|NITKU|FASILITAS|Negara|STATUS|KAP-KJS|JENIS PAJAK|KODE|NOMOR BUKTI|TANGGAL|Faktur Pajak|Dokumen Tertentu|UANG PERSEDIAAN)/i;
 data.forEach(r=>[...r.cells].forEach((c,i)=>{if(center.test(labels[i]))c.style.setProperty('text-align','center','important')}));
 if(n<12)return;
 table.classList.add('compact');if(n>=16)table.classList.add('wide');
 const ctx=document.createElement('canvas').getContext('2d');ctx.font=(n>=16?'10':'10.667')+'px Segoe UI';const measure=v=>ctx.measureText(v).width/3.7795+1.8;
 const widths=labels.map((v,i)=>/^NO\.?$/i.test(v)?7:/^OBJEK PAJAK$/i.test(v)?40:/^NAMA$/i.test(v)?29:/FASILITAS/i.test(v)?21:/UANG PERSEDIAAN/i.test(v)?15:/NITKU|ID TEMPAT/i.test(v)?29:/NIK|NPWP/i.test(v)?26:/TANGGAL/i.test(v)?18:/KAP-KJS/i.test(v)?15:/STATUS/i.test(v)?15:/Negara/i.test(v)?15:/NOMOR BUKTI/i.test(v)?19:/KODE OBJEK/i.test(v)?16:/TARIF|TINGKAT/i.test(v)?11:/JENIS PAJAK/i.test(v)?16:23);
 data.forEach(r=>[...r.cells].forEach((c,i)=>{const val=c.textContent.trim();if(/^[\d.,]+$/.test(val)||/NOMOR BUKTI|TANGGAL|KAP-KJS|KODE OBJEK/.test(labels[i]))widths[i]=Math.max(widths[i],measure(val));if(/JENIS PAJAK|Negara|STATUS|KODE OBJEK|KAP-KJS/.test(labels[i]))c.style.setProperty('text-align','center','important')}));
 table.querySelectorAll('colgroup').forEach(c=>c.remove());const cg=document.createElement('colgroup');const sum=widths.reduce((a,b)=>a+b,0);widths.forEach(w=>{const c=document.createElement('col');c.style.width=(w/sum*100)+'%';cg.append(c)});table.prepend(cg);
 });
 document.querySelectorAll('*').forEach(n=>{if(n.tagName.includes('-')&&!n.closest('table'))n.style.display='block'});
 document.querySelectorAll('.p-panel-header,.p-accordion-header-link').forEach(n=>{if(!n.textContent.trim())n.remove()});
};
