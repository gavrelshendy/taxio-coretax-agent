const state=require('./state');
function isRestricted(explicit=false){return !!explicit||state.connectedProjectIds().some(id=>{const s=state.get(id);return [s?.role,s?.membership?.role].some(role=>String(role||'').toLowerCase().includes('restricted'));});}
function assertAllowed(taxTypeCode,ctx={},page){
 if(isRestricted(ctx.restricted)&&(taxTypeCode==='ICT_WIT'||page?.url?.().includes('/article-21-26-tax-return/')))throw Error('Seluruh unduhan SPT PPh 21 diblokir untuk pengguna Restricted.');
}
module.exports={isRestricted,assertAllowed};
