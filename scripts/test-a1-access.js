const assert=require('assert');
const state=require('../lib/state');
const runcontrol=require('../lib/runcontrol');
const {createGuiServer}=require('../gui/server');
const {runSptDownload}=require('../automation/spt');
module.exports=async function(){
 const saved={...state.getAll()};const server=await createGuiServer(0);
 const url='http://127.0.0.1:'+server.address().port+'/api/actions/download-spt';
 const post=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  for(const session of [{role:'restricted_editor'},{role:'admin',membership:{role:'restricted-editor'}},{role:' Restricted_Editor '}]){
   state.set('taxio_hub',{client:{},session:{},...session});
   for(const project of ['taxio_hub','manual','forged-project']){
    const response=await post({a1Year:'2026',entity:{project},restricted:false,role:'admin'});
    assert.equal(response.status,403);assert.match((await response.json()).error,/Restricted/);assert.equal(runcontrol.status().active,false);
   }
  }
  for(const format of ['pdf','excel','both'])for(const mode of ['full','print','confidential']){
   const response=await post({entity:{project:'manual'},jenisPajakKeys:['unifikasi','pph21'],masaInput:'0126',lampiranFormat:format,lampiranMode:mode,restricted:false});assert.equal(response.status,403);
  }
  const lampiran=require('../automation/lampiran');
  await assert.rejects(lampiran.downloadLampiran(null,{},'taxpayer','record','ICT_WIT','confidential'),/Restricted/);
  await assert.rejects(lampiran.__test.downloadWidgetSptPackage(null,{},'taxpayer','record','aggregate','ICT_WIT','full','2026','combined','excel'),/Restricted/);
  await assert.rejects(lampiran.downloadLampiran({url:()=>'/article-21-26-tax-return/record'},{},'taxpayer','record','VAT_VAT','full'),/Restricted/);
  await assert.rejects(runSptDownload({jenisPajakKeys:['pph21'],restricted:false}),/Restricted/);
  // An unrestricted role passes authorization and reaches year validation.
  state.set('taxio_hub',{client:{},session:{},role:'admin'});
  assert.equal((await post({a1Year:'invalid',entity:{project:'taxio_hub'}})).status,400);
  await assert.rejects(runSptDownload({a1Year:2026,restricted:true}),/Restricted/);
  console.log('PASS: A1 restricted HTTP 403; membership role; manual and forged project bypass; spoofed role; automation guard; no job started.');
 }finally{
  await new Promise(resolve=>server.close(resolve));
  for(const id of Object.keys(state.getAll()))state.clear(id);for(const[id,value]of Object.entries(saved))state.set(id,value);
 }
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
