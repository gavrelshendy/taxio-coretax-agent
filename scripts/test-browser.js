// Chrome bawaan: versi terbaca dari Playwright yang terpasang (juga di dalam exe), SHA-256-nya dikunci,
// dan CORETAX_BUNDLED_CHROME=0 kembali ke Chrome terpasang tanpa mengunduh apa pun.
const assert=require('assert');
module.exports=async function(){
 const browser=require('../lib/browser');
 assert.match(String(browser.VERSION),/^\d+\.\d+\.\d+\.\d+$/,'versi Chrome Playwright terbaca');
 assert.match(String(browser.SHA256[browser.VERSION]),/^[0-9a-f]{64}$/,'SHA-256 untuk versi '+browser.VERSION+' dikunci di lib/browser.js');
 const before=process.env.CORETAX_BUNDLED_CHROME;process.env.CORETAX_BUNDLED_CHROME='0';
 try{assert.deepStrictEqual(await browser.launchOptions(),{channel:'chrome',bundled:false});}
 finally{if(before===undefined)delete process.env.CORETAX_BUNDLED_CHROME;else process.env.CORETAX_BUNDLED_CHROME=before;}
 console.log('PASS: Chrome bawaan '+browser.VERSION+' (SHA-256 dikunci); bisa dimatikan ke Chrome terpasang.');
};
if(require.main===module)module.exports().catch(e=>{console.error(e);process.exitCode=1});
