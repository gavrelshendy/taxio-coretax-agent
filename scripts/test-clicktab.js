// Uji clickTab (automation/lampiran.js) pada deretan tab tiruan bermarkup PrimeNG:
// 1) klik biasa, 2) deretan dibangun ulang tiap 300 ms (elemen lama lepas), 3) aktif terlambat, 4) label tidak ada.
const path = require('path');
const root = process.argv[2] || require('path').join(__dirname, '..');
const { chromium } = require(path.join(root, 'node_modules/playwright'));
const { clickTab } = require(path.join(root, 'automation/lampiran.js')).__test || {};
const strip = (opts) => (opts.fixedBar ? '<div style="position:fixed;top:0;left:0;right:0;height:130px;background:#ccc;z-index:9">BAR</div><div style="height:200px"></div>' : '')
    + `<ul role="tablist" id="ul"></ul>` + (opts.fixedBar ? '<div style="height:5000px">isi panjang</div>' : '') + `<script>
  const labels=['Induk','DAFTAR-I','DAFTAR-II'];let active='Induk';
  function render(){document.getElementById('ul').innerHTML=labels.map(l=>'<li role="presentation" class="'+(l===active?'p-highlight':'')+'"><a role="tab" aria-selected="'+(l===active)+'"><span class="p-tabview-title">'+l+'</span></a></li>').join('');
    document.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{if(!e.isTrusted)return;const l=a.textContent.trim();setTimeout(()=>{active=l;render();},${opts.delay || 0});}));}
  render();${opts.rebuild ? 'setInterval(render,300);' : ''}
</script>`;
(async () => {
    if (!clickTab) { console.log('FAIL: clickTab tidak diekspor lewat __test'); process.exit(1); }
    const browser = await chromium.launch({ ...(await require(path.join(root, 'lib/browser')).launchOptions()), headless: true });
    let fail = 0;
    for (const [name, opts, label, want] of [['klik biasa', {}, 'DAFTAR-I', true], ['dibangun ulang', { rebuild: true }, 'DAFTAR-II', true],
        ['aktif terlambat (2,5 dtk)', { delay: 2500 }, 'DAFTAR-I', true], ['label tidak ada', {}, 'L9', false],
        ['tergulir, tab di bawah bar tetap', { fixedBar: true, rebuild: true }, 'DAFTAR-II', true]]) {
        const page = await browser.newPage();
        await page.setContent(strip(opts));
        if (opts.fixedBar) await page.evaluate(() => { window.scrollTo(0, 3000); });
        const t = Date.now();
        const ok = await clickTab(page, label, want ? 20000 : 3000);
        const act = await page.evaluate(() => (document.querySelector('li.p-highlight') || {}).textContent);
        const pass = ok === want && (!want || act === label);
        if (!pass) fail++;
        console.log((pass ? 'ok   ' : 'FAIL ') + name + ': hasil ' + ok + ', aktif "' + act + '", ' + (Date.now() - t) + ' ms');
        await page.close();
    }
    await browser.close();
    process.exit(fail ? 1 : 0);
})();
