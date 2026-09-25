/* File names of everything the SPT downloads save, in Taxio's convention (2026-09-26, the user's
 * choice): the entity's short code first, the period last, so a folder sorts by entity and a
 * document downloaded here is the same file Taxio saves.
 *
 *   Induk / BPE (as Taxio names them)   BAI - 1721 INDUK 0826.pdf        BAI - UNIFIKASI BPE 0826.pdf
 *   SPT with lampiran (package)         BAI - SPT Masa PPh 21 (Lengkap) 0826.pdf
 *                                       BAI - SPT Tahunan PPh Badan (Ringkas) 2025.pdf
 *   Lampiran on its own                 BAI - SPT Masa PPh 21 Lampiran (Lengkap) 0826.pdf
 *   Lampiran Excel                      BAI - SPT Masa PPh 21 0826.xlsx
 *   Pembetulan                          ... 0826 PB 1.pdf
 *
 * The short code is Taxio Hub's entity code ("BAI"). A manual Coretax login has none: the code is
 * then made from the taxpayer's name - its words' first letters, without the legal form
 * ("BERKAT ARTISAN INDONESIA, PT" -> "BAI").
 */
const titles={ICT_WIT:'SPT Masa PPh 21',ICT_WT:'SPT Masa PPh Unifikasi',VAT_VAT:'SPT Masa PPN',ICT_RCIT:'SPT Tahunan PPh Badan',ICT_PIT:'SPT Tahunan PPh OP'};
// Taxio's own words for the induk and BPE files.
const tokens={ICT_WIT:'1721',ICT_WT:'UNIFIKASI',VAT_VAT:'PPN',ICT_RCIT:'SPT TAHUNAN BADAN',ICT_PIT:'SPT TAHUNAN OP'};
const months=['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];
function periodCode(value){const s=String(value||'').trim();if(/^\d{4}$/.test(s))return s;const year=s.match(/20\d{2}/)?.[0];const month=months.findIndex(m=>s.toLowerCase().includes(m));if(year&&month>=0)return String(month+1).padStart(2,'0')+year.slice(2);return s;}
const LEGAL=/^(PT|CV|TBK|PERSERO|FIRMA|FA|UD|KOPERASI|KOP|YAYASAN|PERKUMPULAN|BUT|PERUM|PERSEROAN|TERBATAS|THE|DAN|&)$/i;
/** Taxio's short code, or one made from a taxpayer's name. '' when there is nothing to go on. */
function entityCode(value){
 let s=String(value||'').replace(/^Sesi Manual\s*[·:-]?\s*/i,'').replace(/[\\/:*?"<>|]/g,' ').trim();
 if(!s||/^(manual|sesi manual|spt)$/i.test(s))return '';
 // Already a code: one short word ("BAI", "PJS", "BBH-2").
 if(!/\s|,/.test(s)&&s.length<=8)return s.toUpperCase();
 const words=s.replace(/[.,()]/g,' ').split(/\s+/).filter(w=>w&&!LEGAL.test(w));
 return words.map(w=>w[0]).join('').toUpperCase().slice(0,6);
}
function pbTag(revision){const pb=String(revision||'').match(/\d+/)?.[0];return pb&&Number(pb)?' PB '+Number(pb):'';}
const MODE={Lengkap:'Lengkap',Full:'Lengkap',Ringkas:'Ringkas',Print:'Ringkas',Confidential:'Rahasia',Rahasia:'Rahasia'};
/** `part`: 'Induk' | 'BPE' | 'Lengkap' | 'Ringkas' | 'Confidential' (the package), or
 *  'Lampiran[ <section>] - <mode>' (the lampiran on their own). ext '' gives the stem. */
function filename(code,period,part,revision='',ext='pdf',entity=''){
 const e=entityCode(entity),pre=e?e+' - ':'',per=periodCode(period),pb=pbTag(revision),dot=ext?'.'+ext:'';
 const p=String(part||'').trim();
 if(/^(Induk|BPE)$/i.test(p))return pre+(tokens[code]||'SPT')+' '+p.toUpperCase()+' '+per+pb+dot;
 const lamp=p.match(/^Lampiran(.*?)\s*-\s*(\w+)$/i);
 if(lamp){const section=lamp[1].trim();return pre+(titles[code]||'SPT')+' Lampiran'+(section?' '+section:'')+' ('+(MODE[lamp[2]]||lamp[2])+') '+per+pb+dot;}
 return pre+(titles[code]||'SPT')+(MODE[p]?' ('+MODE[p]+')':p?' '+p:'')+' '+per+pb+dot;
}
/** The lampiran Excel beside a lampiran PDF stem: no mode, no "Lampiran". */
function excelName(stem){return String(stem).replace(/ Lampiran(?=[ (])/,'').replace(/ \((?:Lengkap|Ringkas|Rahasia)\)/,'')+'.xlsx';}
function tokenFilename(token,period,revision,entity=''){const t=token.toUpperCase();const code=/1721|PPH 21/.test(t)?'ICT_WIT':/UNIFIKASI/.test(t)?'ICT_WT':/PPN/.test(t)?'VAT_VAT':/BADAN/.test(t)?'ICT_RCIT':'ICT_PIT';const part=/BPE/.test(t)?'BPE':/INDUK/.test(t)?'Induk':/PRINT|RINGKAS/.test(t)?'Ringkas':/CONFIDENTIAL|RAHASIA/.test(t)?'Confidential':'Lengkap';return filename(code,period,part,revision,'pdf',entity);}
module.exports={filename,tokenFilename,periodCode,titles,entityCode,excelName};
