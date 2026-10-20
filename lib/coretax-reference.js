/* Coretax's own reference lists (code -> text), fetched live from the same endpoint its web app uses
 * (referencedata/api/currentreferencedata/<lang>/<TYPE,...>), in the language of the open page, and
 * cached per browser context. Used to show API codes (fasilitas, status, negara, objek pajak, ...)
 * exactly as Coretax's own tables do - never a hand-written translation. */
const gridApi = require('./returnsheet-grid-api');

const cache = new WeakMap();

/** {kind: {code: text}} for `types` = {kind: 'REFERENCE_TYPE'}. Throws when a list is missing. */
async function referenceLists(page, types) {
    const lang = (/\/(id-ID|en-US)\//.exec(page.url()) || [, 'id-ID'])[1];
    const context = page.context();
    if (!cache.has(context)) cache.set(context, new Map());
    const byType = cache.get(context);
    const missing = [...new Set(Object.values(types))].filter((type) => !byType.has(lang + '|' + type));
    if (missing.length) {
        const state = gridApi.watchContext(context);
        if (!state.authorization) throw new Error('header autentikasi Coretax belum tertangkap');
        const url = 'https://coretaxdjp.pajak.go.id/referencedata/api/currentreferencedata/' + lang + '/' + missing.join(',');
        const res = await page.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include',headers:{'Content-Type':'application/json',Authorization:${JSON.stringify(state.authorization)},'x-dgt-code':${JSON.stringify(state.dgtCode)}}});let j=null;try{j=await r.json()}catch(e){}return{status:r.status,json:j}})()`);
        for (const found of (res && res.json && res.json.Payload) || []) {
            if (Array.isArray(found.Details) && found.Details.length) byType.set(lang + '|' + found.ReferenceDataType, Object.fromEntries(found.Details.map((d) => [String(d.Code), String(d.CodeDescription)])));
        }
        for (const type of missing) if (!byType.has(lang + '|' + type)) throw new Error('referensi ' + type + ' tidak terbaca (HTTP ' + (res && res.status) + ')');
    }
    return Object.fromEntries(Object.entries(types).map(([kind, type]) => [kind, byType.get(lang + '|' + type)]));
}

module.exports = { referenceLists };
