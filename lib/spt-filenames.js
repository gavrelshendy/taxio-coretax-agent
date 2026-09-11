const titles={ICT_WIT:'SPT Masa PPh 21',ICT_WT:'SPT Masa PPh Unifikasi',VAT_VAT:'SPT Masa PPN',ICT_RCIT:'SPT Tahunan PPh Badan',ICT_PIT:'SPT Tahunan PPh Orang Pribadi'};
const months=['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];
function periodCode(value){const s=String(value||'').trim();if(/^\d{4}$/.test(s))return s;const year=s.match(/20\d{2}/)?.[0];const month=months.findIndex(m=>s.toLowerCase().includes(m));if(year&&month>=0)return String(month+1).padStart(2,'0')+year.slice(2);return s;}
function filename(code,period,part,revision='',ext='pdf'){
 const pb=String(revision||'').match(/\d+/)?.[0];
 return [titles[code]||'SPT',periodCode(period),pb&&Number(pb)?'PB '+Number(pb):''].filter(Boolean).join(' ')+(part?' - '+part:'')+(ext?'.'+ext:'');
}
function tokenFilename(token,period,revision){const t=token.toUpperCase();const code=/1721|PPH 21/.test(t)?'ICT_WIT':/UNIFIKASI/.test(t)?'ICT_WT':/PPN/.test(t)?'VAT_VAT':/BADAN/.test(t)?'ICT_RCIT':'ICT_PIT';const part=/BPE/.test(t)?'BPE':/INDUK/.test(t)?'Induk':/PRINT|RINGKAS/.test(t)?'Ringkas':/CONFIDENTIAL|RAHASIA/.test(t)?'Confidential':'Lengkap';return filename(code,period,part,revision);}
module.exports={filename,tokenFilename,periodCode,titles};
