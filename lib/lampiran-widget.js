/* Widget desktop pada halaman SPT: user memilih SATU mode sebelum proses dimulai. */
const URL_KIND_TO_TAXTYPE = {
    'corporate-income-tax-return': 'ICT_RCIT',
    'personal-income-tax-return': 'ICT_PIT',
    'article-21-26-tax-return': 'ICT_WIT',
    'withholding-tax-return': 'ICT_WT',
    'value-added-tax-return': 'VAT_VAT'
};

function buildLampiranWidgetScript(blockPph21 = false) {
    const kindMapJson = JSON.stringify(URL_KIND_TO_TAXTYPE);
    return `(() => {
      const MAP=${kindMapJson}, BTN='__ca_lampiran_widget_v1150package', CHOOSER='__ca_lampiran_chooser_v1150package';
      const RE=new RegExp('/('+Object.keys(MAP).join('|')+')/([0-9a-f-]{30,36})/([0-9a-f-]{30,36})/(\\\\w+)/([0-9a-f-]{30,36})','i');
      const target=()=>{const m=RE.exec(location.pathname);return m?{kind:m[1],taxpayerId:m[2],recordId:m[3],aggregateId:m[5]}:null};
      function reset(btn){setTimeout(()=>{btn.innerHTML='📄 Unduh SPT + Lampiran';btn.disabled=false},6000)}
      async function run(btn,mode,outputLayout,lampiranFormat){
        const t=target();if(!t)return;
        btn.disabled=true;btn.innerHTML='⏳ Menyiapkan unduhan...';
        try{if(typeof window.__ca_downloadSptPackageV1150!=='function')throw new Error('Mesin paket SPT v1.15.0 belum aktif - tutup dan buka ulang Coretax Agent');const y=(document.querySelector('[formcontrolname="TaxYear"]')||{}).value||'';const r=await window.__ca_downloadSptPackageV1150(t.taxpayerId,t.recordId,t.aggregateId,MAP[t.kind],mode,y,outputLayout,lampiranFormat);btn.innerHTML=r&&r.ok?'✅ '+r.count+' file tersimpan':'❌ '+((r&&r.error)||'Gagal')}
        catch(e){btn.innerHTML='❌ '+(e&&e.message?e.message:'Gagal')}
        reset(btn);
      }
      function choose(btn){
        const old=document.getElementById(CHOOSER);if(old){old.remove();return}
        const t=target();
        const box=document.createElement('div');box.id=CHOOSER;
        box.style.cssText='position:fixed;bottom:60px;left:16px;z-index:2147483647;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:12px;width:300px;font-family:sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;color:#1a202c';
        box.innerHTML='<div style="font-weight:700;margin-bottom:10px">Unduh SPT + Lampiran</div>'+
          '<label style="display:block;font-weight:600;margin-bottom:4px">Format lampiran</label>'+
          '<select id="__ca_format" style="width:100%;padding:8px;margin-bottom:10px"><option value="pdf">PDF</option><option value="excel">Excel</option><option value="both">PDF dan Excel</option></select>'+
          '<div id="__ca_pdf_options"><label style="display:block;font-weight:600;margin-bottom:4px">Isi PDF lampiran</label>'+
          '<select id="__ca_mode" style="width:100%;border:1px solid #94a3b8;border-radius:7px;padding:8px 9px;margin-bottom:10px;background:#fff;color:#1a202c">'+
            '<option value="print">PDF ringkas (50 baris per tabel)</option><option value="full">PDF lengkap (seluruh baris)</option>'+
            (t&&t.kind==='article-21-26-tax-return'?'<option value="confidential">Rahasia — tanpa rincian penerima</option>':'')+'</select>'+
          '<label style="display:block;font-weight:600;margin-bottom:4px">Susunan PDF</label>'+
          '<select id="__ca_output" style="width:100%;border:1px solid #94a3b8;border-radius:7px;padding:8px 9px;margin-bottom:11px;background:#fff;color:#1a202c"><option value="combined">Gabungkan dokumen PDF</option><option value="separate">Pisahkan per dokumen</option></select></div>'+
          '<button id="__ca_start" style="width:100%;background:#0D9488;color:#fff;border:0;border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:700">Mulai Unduh</button>'+
          '<div style="font-size:10.5px;color:#64748b;margin-top:7px;line-height:1.35">BPE dan Induk tetap PDF asli. Excel memuat seluruh rincian, satu sheet per lampiran. PDF ringkas menampilkan indikator baris tersembunyi dan total seluruh data.</div>';
        document.documentElement.appendChild(box);
        box.querySelector('#__ca_format').onchange=()=>{box.querySelector('#__ca_pdf_options').style.display=box.querySelector('#__ca_format').value==='excel'?'none':'block'};
        box.querySelector('#__ca_start').onclick=()=>{const format=box.querySelector('#__ca_format').value,mode=format==='excel'?'full':box.querySelector('#__ca_mode').value,output=box.querySelector('#__ca_output').value;box.remove();run(btn,mode,output,format)};
      }
      function ensure(){
        if(!document.documentElement)return;
        const t=target();let btn=document.getElementById(BTN);
        if(!t||(${JSON.stringify(blockPph21)}&&t.kind==='article-21-26-tax-return')){if(btn)btn.remove();const c=document.getElementById(CHOOSER);if(c)c.remove();return}
        if(!btn){btn=document.createElement('button');btn.id=BTN;btn.style.cssText='position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0D9488;color:#F8FAFC;border:1px solid #0F766E;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);font-family:sans-serif';btn.innerHTML='📄 Unduh SPT + Lampiran';btn.onclick=e=>{e.preventDefault();e.stopPropagation();if(!btn.disabled)choose(btn)};document.documentElement.appendChild(btn)}
      }
      // Jangan percaya interval peninggalan build lama pada tab yang dipakai ulang. Interval
      // tersebut bisa masih punya id tetapi callback/script lamanya sudah tidak efektif, sehingga
      // build baru mengira widget aktif padahal tombol tidak ada. Selalu ganti dengan callback
      // versi yang sedang berjalan.
      document.querySelectorAll('[id^="__ca_lampiran_widget"],[id^="__ca_lampiran_chooser"]').forEach(legacy=>{if(legacy.id!==BTN&&legacy.id!==CHOOSER)legacy.remove()});
      if(window.__ca_lampiran_widget_interval)clearInterval(window.__ca_lampiran_widget_interval);
      if(window.__ca_lampiran_widget_interval_v11036)clearInterval(window.__ca_lampiran_widget_interval_v11036);
      if(window.__ca_lampiran_widget_interval_v11036final)clearInterval(window.__ca_lampiran_widget_interval_v11036final);
      if(window.__ca_lampiran_widget_interval_v11039final)clearInterval(window.__ca_lampiran_widget_interval_v11039final);
      if(window.__ca_lampiran_widget_interval_v11040final)clearInterval(window.__ca_lampiran_widget_interval_v11040final);
      if(window.__ca_lampiran_widget_interval_v11041final)clearInterval(window.__ca_lampiran_widget_interval_v11041final);
      if(window.__ca_lampiran_widget_interval_v11042final)clearInterval(window.__ca_lampiran_widget_interval_v11042final);
      if(window.__ca_lampiran_widget_interval_v11043final)clearInterval(window.__ca_lampiran_widget_interval_v11043final);
      if(window.__ca_lampiran_widget_interval_v11044final)clearInterval(window.__ca_lampiran_widget_interval_v11044final);
      if(window.__ca_lampiran_widget_interval_v1150final)clearInterval(window.__ca_lampiran_widget_interval_v1150final);
      if(window.__ca_lampiran_widget_interval_v1150package)clearInterval(window.__ca_lampiran_widget_interval_v1150package);
      ensure();window.__ca_lampiran_widget_interval_v1150package=setInterval(ensure,1000);
    })();`;
}

module.exports = { buildLampiranWidgetScript, URL_KIND_TO_TAXTYPE };
