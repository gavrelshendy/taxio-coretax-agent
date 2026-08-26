/* Widget desktop pada halaman SPT: user memilih SATU mode sebelum proses dimulai. */
const URL_KIND_TO_TAXTYPE = {
    'corporate-income-tax-return': 'ICT_RCIT',
    'personal-income-tax-return': 'ICT_PIT',
    'article-21-26-tax-return': 'ICT_WIT',
    'withholding-tax-return': 'ICT_WT',
    'value-added-tax-return': 'VAT_VAT'
};

function buildLampiranWidgetScript() {
    const kindMapJson = JSON.stringify(URL_KIND_TO_TAXTYPE);
    return `(() => {
      const MAP=${kindMapJson}, BTN='__ca_lampiran_widget', CHOOSER='__ca_lampiran_chooser';
      const RE=new RegExp('/('+Object.keys(MAP).join('|')+')/([0-9a-f-]{30,36})/([0-9a-f-]{30,36})/(\\\\w+)/([0-9a-f-]{30,36})','i');
      const target=()=>{const m=RE.exec(location.pathname);return m?{kind:m[1],taxpayerId:m[2],recordId:m[3]}:null};
      function reset(btn){setTimeout(()=>{btn.innerHTML='📄 Unduh Lampiran SPT';btn.disabled=false},6000)}
      async function run(btn,mode){
        const t=target();if(!t)return;
        btn.disabled=true;btn.innerHTML=mode==='print'?'⏳ Membuat versi Print...':'⏳ Membuat versi Lengkap...';
        try{const r=await window.__ca_downloadLampiran(t.taxpayerId,t.recordId,MAP[t.kind],mode);btn.innerHTML=r&&r.ok?'✅ '+r.count+' file tersimpan':'❌ '+((r&&r.error)||'Gagal')}
        catch(e){btn.innerHTML='❌ '+(e&&e.message?e.message:'Gagal')}
        reset(btn);
      }
      function choose(btn){
        const old=document.getElementById(CHOOSER);if(old){old.remove();return}
        const box=document.createElement('div');box.id=CHOOSER;
        box.style.cssText='position:fixed;bottom:60px;left:16px;z-index:2147483647;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:12px;width:300px;font-family:sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;color:#1a202c';
        box.innerHTML='<div style="font-weight:700;margin-bottom:8px">Pilih versi PDF</div>'+
          '<button id="__ca_mode_print" style="width:100%;text-align:left;background:#0D9488;color:#fff;border:0;border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:7px">📄 Versi Print (cepat)<br><span style="font-weight:400;font-size:11px;opacity:.9">L3/L4/L9 dibatasi; termasuk PDF gabungan</span></button>'+
          '<button id="__ca_mode_full" style="width:100%;text-align:left;background:#fff;color:#1a202c;border:1px solid #cbd5e1;border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600">📚 Versi Lengkap (semua baris)<br><span style="font-weight:400;font-size:11px;color:#b45309">⚠️ Dapat sangat lama bila datanya ribuan baris</span></button>';
        document.documentElement.appendChild(box);
        box.querySelector('#__ca_mode_print').onclick=()=>{box.remove();run(btn,'print')};
        box.querySelector('#__ca_mode_full').onclick=()=>{box.remove();run(btn,'full')};
      }
      function ensure(){
        if(!document.documentElement)return;
        const t=target();let btn=document.getElementById(BTN);
        if(!t){if(btn)btn.remove();const c=document.getElementById(CHOOSER);if(c)c.remove();return}
        if(!btn){btn=document.createElement('button');btn.id=BTN;btn.style.cssText='position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0D9488;color:#F8FAFC;border:1px solid #0F766E;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);font-family:sans-serif';btn.innerHTML='📄 Unduh Lampiran SPT';btn.onclick=e=>{e.preventDefault();e.stopPropagation();if(!btn.disabled)choose(btn)};document.documentElement.appendChild(btn)}
      }
      // Jangan percaya interval peninggalan build lama pada tab yang dipakai ulang. Interval
      // tersebut bisa masih punya id tetapi callback/script lamanya sudah tidak efektif, sehingga
      // build baru mengira widget aktif padahal tombol tidak ada. Selalu ganti dengan callback
      // versi yang sedang berjalan.
      if(window.__ca_lampiran_widget_interval)clearInterval(window.__ca_lampiran_widget_interval);
      ensure();window.__ca_lampiran_widget_interval=setInterval(ensure,1000);
    })();`;
}

module.exports = { buildLampiranWidgetScript, URL_KIND_TO_TAXTYPE };
