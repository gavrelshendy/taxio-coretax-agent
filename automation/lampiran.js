/* Coretax Agent - cetak lampiran SPT langsung dari tampilan Coretax melalui CDP. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');
const { log } = require('../lib/log');
const { sanitizeFilenamePart } = require('../lib/datatable');
const lampiranWidget = require('../lib/lampiran-widget');

const TAXTYPE_CONFIG = { ICT_RCIT: { formCode: '1771' }, ICT_PIT: { formCode: '1770' } };
const TAB_TITLE_SEL = '.p-tabview-title';
const TWO_VERSION_TABS = new Set(['L3', 'L4', 'L9']);
const TAB_ROW_CAP = { L9: 10 };
const COMPACT_ROWS = 50;
const PRINT_SCALE = 0.8;
const PRINT_STYLE_ID = '__ca_print_style';

async function waitForTabLabels(page) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const labels = await page.evaluate(`(() => {
            const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
            return [...new Set(Array.from(document.querySelectorAll(${JSON.stringify(TAB_TITLE_SEL)})).filter(visible).map(e=>(e.textContent||'').trim()).filter(Boolean))];
        })()`).catch(() => []);
        if (labels.length) return labels;
        await page.waitForTimeout(1000);
    }
    return [];
}

async function clickTab(page, label) {
    const loc = page.locator(TAB_TITLE_SEL).filter({ hasText: label });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const item = loc.nth(i);
        if (((await item.textContent().catch(() => '')) || '').trim() === label && await item.isVisible().catch(() => false)) {
            await item.click({ timeout: 5000 });
            await page.waitForTimeout(1400);
            return true;
        }
    }
    return false;
}

async function preparePageForPrint(page) {
    const css = `@page { size:A3 landscape !important; margin:8mm !important; }
      @media print { html,body{background:#fff!important} nav,aside,footer,[class*="sidebar" i],[class*="side-nav" i],[class*="footer" i],#__ca_lampiran_widget,#__ca_lampiran_chooser,#__ca_passphrase_widget{display:none!important}
      .p-datatable-wrapper,[class*="datatable" i],[class*="table-wrap" i],[class*="scroll" i]{overflow:visible!important}
      table{width:100%!important;max-width:100%!important;table-layout:auto!important;font-size:7.5pt!important}
      th,td{padding:2px 3px!important;white-space:normal!important;word-break:break-word!important;min-width:0!important} col,colgroup{width:auto!important} }`;
    await page.evaluate(`(()=>{let e=document.getElementById(${JSON.stringify(PRINT_STYLE_ID)});if(!e){e=document.createElement('style');e.id=${JSON.stringify(PRINT_STYLE_ID)};e.textContent=${JSON.stringify(css)}}document.head.appendChild(e)})()`).catch(() => {});
}

async function setUpTables(page, tabLabel, mode) {
    await page.evaluate(`(async()=>{
      const sleep=m=>new Promise(r=>setTimeout(r,m)),visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const cap=${JSON.stringify(mode)}==='print'?(${JSON.stringify(TAB_ROW_CAP)}[${JSON.stringify(tabLabel)}]||${COMPACT_ROWS}):0;
      for(const dd of Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(visible)){try{if((dd.className||'').includes('p-disabled'))continue;dd.click();await sleep(300);const items=Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(visible);if(!items.length){document.body.click();continue}let pick=items.length-1;if(cap){let bi=-1,bv=-1;items.forEach((it,i)=>{const v=parseInt((it.textContent||'').replace(/[^\\d]/g,''),10);if(!isNaN(v)&&v<=cap&&v>bv){bi=i;bv=v}});pick=bi>=0?bi:0}items[pick].click();await sleep(500)}catch(e){}}
    })()`).catch(() => {});
}

async function printPdf(session) {
    const r = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, scale: PRINT_SCALE });
    return Buffer.from(r.data, 'base64');
}

async function mergePdfs(buffers) {
    const out = await PDFDocument.create();
    for (const buf of buffers) {
        const src = await PDFDocument.load(buf);
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    return Buffer.from(await out.save());
}

async function detectYear(page) {
    const val = await page.locator('[formcontrolname="TaxYear"]').first().inputValue({ timeout: 2000 }).catch(() => '');
    const m = String(val).match(/\d{4}/);
    if (m) return m[0];
    const t = (await page.locator('body').innerText().catch(() => '')).match(/(?:Tahun Pajak|Tax Year)[^\d]*(\d{4})/i);
    return t ? t[1] : String(new Date().getFullYear());
}

/** Baca WP aktif dari pill akun Coretax. Ini sengaja tidak memakai nama entitas dari Taxio,
 * agar benar ketika user login manual maupun sedang impersonate. */
async function detectActiveTaxpayerName(page) {
    const value = await page.evaluate(`(() => {
      const clean=s=>(s||'').replace(/\\s+/g,' ').trim();
      const tidy=s=>clean(s).replace(/\\bIMPERSONATE\\b/ig,'').replace(/\\b\\d{15,16}\\b/g,'').replace(/[·|]+/g,' ').trim();
      const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&r.top<150&&c.display!=='none'&&c.visibility!=='hidden'};
      const score=s=>{s=tidy(s);if(!s||s.length<3||s.length>100)return-1;return(/[A-Za-z]{3}/.test(s)?10:0)+s.split(' ').length};
      const pools=[];
      const imp=Array.from(document.querySelectorAll('body *')).find(e=>visible(e)&&/IMPERSONATE/i.test(clean(e.textContent))&&clean(e.textContent).length<40);
      if(imp){let p=imp;for(let i=0;i<6&&p;i++,p=p.parentElement)if(visible(p))pools.push(p.title,p.getAttribute('aria-label'),p.textContent)}
      Array.from(document.querySelectorAll('header [title],header [aria-label],header button,header [role="button"],nav [role="button"]')).filter(visible).forEach(e=>pools.push(e.title,e.getAttribute('aria-label'),e.textContent));
      let best='';for(const raw of pools){const s=tidy(raw);if(score(s)>score(best)&&!/portal|beranda|profil|logout|bahasa|notifikasi/i.test(s))best=s}if(best)return best;
      const n=document.querySelector('[formcontrolname="Name"]');return clean(n&&(n.value||n.textContent));
    })()`).catch(() => '');
    return sanitizeFilenamePart(value || 'SPT');
}

function filename(entity, formCode, label, year) {
    return `${sanitizeFilenamePart(entity)} - ${formCode} LAMPIRAN ${sanitizeFilenamePart(label)} ${year}.pdf`;
}

async function downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode, mode) {
    if (!TAXTYPE_CONFIG[taxTypeCode]) return { ok: false, error: 'Jenis SPT ini belum didukung.' };
    mode = mode === 'full' ? 'full' : 'print';
    try {
        const labels = await waitForTabLabels(page);
        if (!labels.length) return { ok: false, error: 'Tab lampiran belum muncul. Tunggu halaman selesai dimuat lalu coba lagi.' };
        const session = await page.context().newCDPSession(page);
        const year = await detectYear(page);
        const detected = await detectActiveTaxpayerName(page);
        const entity = detected !== 'SPT' ? detected : sanitizeFilenamePart(ctx.entityCode || taxpayerId || 'SPT');
        const formCode = TAXTYPE_CONFIG[taxTypeCode].formCode;
        const dir = path.join(ctx.saveRoot, entity, 'SPT', String(year));
        fs.mkdirSync(dir, { recursive: true });
        const saved = [], buffers = [];
        for (const label of labels) {
            if (!await clickTab(page, label)) { log('[Lampiran] Tab tidak dapat dibuka: ' + label); continue; }
            const suffix = TWO_VERSION_TABS.has(label) ? (mode === 'print' ? ' (Print)' : ' (Lengkap)') : '';
            await setUpTables(page, label, mode);
            await preparePageForPrint(page);
            await page.waitForTimeout(300);
            try {
                const buf = await printPdf(session);
                const outPath = path.join(dir, filename(entity, formCode, label + suffix, year));
                fs.writeFileSync(outPath, buf); saved.push(outPath); buffers.push(buf);
                if (ctx.compFolder) { fs.mkdirSync(ctx.compFolder, { recursive: true }); fs.copyFileSync(outPath, path.join(ctx.compFolder, path.basename(outPath))); }
                log('[Lampiran] Tersimpan: ' + outPath);
            } catch (e) { log('[Lampiran] Gagal cetak ' + label + ': ' + e.message); }
        }
        if (!buffers.length) return { ok: false, error: 'Tidak ada lampiran yang berhasil dicetak.' };
        const mergedLabel = mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)';
        const mergedPath = path.join(dir, filename(entity, formCode, mergedLabel, year));
        fs.writeFileSync(mergedPath, await mergePdfs(buffers)); saved.push(mergedPath);
        if (ctx.compFolder) fs.copyFileSync(mergedPath, path.join(ctx.compFolder, path.basename(mergedPath)));
        try { await clickTab(page, labels[0]); } catch (e) {}
        return { ok: true, count: saved.length, paths: saved, dir, entityName: entity, mode };
    } catch (e) { return { ok: false, error: e.message }; }
}

async function installLampiranWidget(page, { saveRoot, entityCode, compFolder }) {
    const ctx = { saveRoot: saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), entityCode, compFolder };
    try { await page.context().exposeFunction('__ca_downloadLampiran', (taxpayerId, recordId, taxTypeCode, mode) => downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode, mode)); } catch (e) {}
    const script = lampiranWidget.buildLampiranWidgetScript();
    try { await page.context().addInitScript({ content: script }); await page.evaluate(script); }
    catch (e) { log('[Lampiran] Gagal memasang widget: ' + e.message); }
}

module.exports = { installLampiranWidget, downloadLampiran, TAXTYPE_CONFIG, detectActiveTaxpayerName };
