/* Lampiran printing: page-by-page printing through Coretax's table paginators (and the DOM
 * fallbacks for annual SPT, PPN and the L1 snapshot). Split out of automation/lampiran.js
 * (still the public entry point). */
const { PDFDocument } = require('pdf-lib');
const { log } = require('./log');
const { PRINT_SCALE } = require('./lampiran-config');
const { waitForTabContentStable } = require('./lampiran-page');
const { printPdf, printAdaptivePdf, stampHeaderOnPdf } = require('./lampiran-print-pdf');

async function resetPaginators(page) {
    const count = await page.evaluate(`(()=>{let n=0;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};for(const p of Array.from(document.querySelectorAll('.p-paginator')).filter(visible)){const b=p.querySelector('.p-paginator-first');if(b&&!b.disabled&&!b.classList.contains('p-disabled')){b.click();n++}}return n})()`).catch(() => 0);
    if (count) await page.waitForTimeout(700);
}

async function paginatorIds(page) {
    return page.evaluate(`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      // Angular mempertahankan panel tab lama di DOM. ID dari tab sebelumnya harus dibuang
      // agar locator tidak menekan paginator tersembunyi yang kebetulan memiliki ID sama.
      document.querySelectorAll('[data-ca-paginator-id]').forEach(node=>node.removeAttribute('data-ca-paginator-id'));
      document.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{node.removeAttribute('data-ca-paginator-owner-id');node.classList.remove('__ca_paginator_owner_hidden')});
      document.querySelectorAll('.__ca_paginator_owner_mode').forEach(node=>node.classList.remove('__ca_paginator_owner_mode'));
      let n=0;return Array.from(document.querySelectorAll('.p-paginator')).filter(visible).map(p=>{const text=(p.textContent||'').replace(/\\s+/g,' ').trim(),m=text.match(/(?:of|dari)\\s+([\\d.,]+)\\s+(?:entries|entri)/i),total=m?parseInt(m[1].replace(/[.,]/g,''),10):0,id=String(n++),owner=p.closest('p-table')||p.closest('.p-datatable')||p.parentElement;p.dataset.caPaginatorId=id;if(owner)owner.dataset.caPaginatorOwnerId=id;return{id,total,text}}).filter(x=>x.total>0)})()`).catch(() => []);
}

async function setActivePaginatorOwner(page, rootSelector, activeId) {
    return page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(rootSelector || '')})||document.body,active=${JSON.stringify(String(activeId))},owners=Array.from(root.querySelectorAll('[data-ca-paginator-owner-id]'));if(!owners.length)return{ok:false,reason:'owner-not-found'};root.classList.add('__ca_paginator_owner_mode');for(const owner of owners)owner.classList.toggle('__ca_paginator_owner_hidden',owner.dataset.caPaginatorOwnerId!==active);window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot();return{ok:true,owners:owners.length,active}})()`).catch(error=>({ok:false,reason:error.message}));
}

async function clearPaginatorOwners(page, rootSelector) {
    await page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(rootSelector || '')})||document.body;root.classList.remove('__ca_paginator_owner_mode');root.querySelectorAll('.__ca_paginator_owner_hidden').forEach(owner=>owner.classList.remove('__ca_paginator_owner_hidden'));root.querySelectorAll('[data-ca-paginator-id]').forEach(node=>node.removeAttribute('data-ca-paginator-id'));root.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>node.removeAttribute('data-ca-paginator-owner-id'));window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()})()`).catch(() => {});
}

async function printL1SnapshotPages(page, session, printScale) {
    const pageCount = await page.locator('#__ca_l1d_snapshot .__ca_l1d_page').count();
    if (!pageCount) return [await printPdf(session, printScale)];
    const buffers = [];
    await page.evaluate(`(()=>{document.getElementById('__ca_l1d_single_page_style')?.remove();const style=document.createElement('style');style.id='__ca_l1d_single_page_style';document.head.appendChild(style);document.body.classList.add('__ca_l1d_single_page')})()`);
    try {
        for (let index = 0; index < pageCount; index++) {
            await page.evaluate(`(()=>{document.querySelectorAll('#__ca_l1d_snapshot .__ca_l1d_page').forEach((node,i)=>{if(i===${index})node.dataset.caPrintActive='1';else node.removeAttribute('data-ca-print-active')})})()`);
            await page.evaluate(`(()=>{const style=document.getElementById('__ca_l1d_single_page_style');style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page{display:none!important;break-after:auto!important;page-break-after:auto!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page[data-ca-print-active="1"]{display:block!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_section{display:none!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}'})()`);
            const headerBuffer = await printPdf(session, 1);
            await page.evaluate(`(()=>{const style=document.getElementById('__ca_l1d_single_page_style');style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page{display:none!important;break-after:auto!important;page-break-after:auto!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_page[data-ca-print-active="1"]{display:block!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_print_header_clone{display:none!important}body.__ca_l1d_single_page #__ca_l1d_snapshot .__ca_l1d_section{display:block!important;break-inside:auto!important;page-break-inside:auto!important;padding-top:2mm!important}body.__ca_l1d_single_page #__ca_l1d_snapshot table thead{display:table-header-group!important}body.__ca_l1d_single_page #__ca_l1d_snapshot table tbody tr{break-inside:avoid!important;page-break-inside:avoid!important}}'})()`);
            let scale = Math.max(Number(printScale) || PRINT_SCALE, 0.88);
            let buffer = await printPdf(session, scale);
            let physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            if (physicalPages === 2) {
                // Cegah halaman kedua yang hanya berisi beberapa baris. Gunakan satu lembar
                // hanya bila penurunan moderat benar-benar membuat seluruh bagian muat.
                for (const factor of [0.96, 0.92, 0.88]) {
                    const candidateScale = Math.max(0.8, (Number(printScale) || PRINT_SCALE) * factor);
                    const candidate = await printPdf(session, candidateScale);
                    const candidatePages = (await PDFDocument.load(candidate)).getPageCount();
                    if (candidatePages === 1) {
                        scale = candidateScale;
                        buffer = candidate;
                        physicalPages = 1;
                        break;
                    }
                }
            }
            // Satu bagian semantik boleh memakai dua lembar. Turunkan sedikit hanya bila
            // melebihi batas itu; jangan lagi merampingkan L1 sampai sulit dibaca.
            for (let attempt = 0; physicalPages > 2 && attempt < 3; attempt++) {
                scale = Math.max(0.78, scale * 0.94);
                buffer = await printPdf(session, scale);
                physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            }
            if (physicalPages < 1 || physicalPages > 2) throw new Error('Snapshot L1 bagian ' + (index + 1) + ' menghasilkan ' + physicalPages + ' halaman fisik; batasnya 1-2.');
            buffers.push(await stampHeaderOnPdf(buffer, headerBuffer));
        }
        return buffers;
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_l1d_single_page');document.getElementById('__ca_l1d_single_page_style')?.remove();document.querySelectorAll('#__ca_l1d_snapshot .__ca_l1d_page').forEach(node=>node.removeAttribute('data-ca-print-active'))})()`).catch(() => {});
    }
}

async function printAnnualDomPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale) {
    const ownsL1Pages = await page.evaluate(`document.body.classList.contains('__ca_l1d_snapshot_active')`).catch(() => false);
    if (ownsL1Pages) return printL1SnapshotPages(page, session, printScale);
    await page.evaluate(`(()=>{document.getElementById('__ca_annual_dom_page_style')?.remove();const style=document.createElement('style');style.id='__ca_annual_dom_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_annual_dom_header_only>*:not(#__ca_print_header){display:none!important}body.__ca_annual_dom_header_only #__ca_print_header{display:grid!important;position:static!important;margin:0 8mm!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_annual_dom_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_dom_header_only');const style=document.getElementById('__ca_annual_dom_page_style');if(style)style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}#__ca_print_header{display:none!important}table tfoot{display:table-row-group!important}}'})()`);
        const buffers = await printPaginatorPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale, true);
        return Promise.all(buffers.map((buffer) => stampHeaderOnPdf(buffer, headerBuffer)));
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_dom_header_only');document.getElementById('__ca_annual_dom_page_style')?.remove()})()`).catch(() => {});
    }
}

/** Cetak fallback DOM PPN tanpa menggantungkan kop pada aliran halaman Chromium.
 * Kop dicetak sekali sebagai pita vektor, isi dicetak tanpa kop, lalu pita tersebut
 * distempel ke setiap halaman fisik. Ini terutama menangani INDUK yang tidak punya
 * paginator tetapi dapat mengalir ke dua atau tiga halaman. */
async function printPpnDomPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector, printScale, tabLabel) {
    await page.evaluate(`(()=>{document.getElementById('__ca_ppn_dom_page_style')?.remove();const style=document.createElement('style');style.id='__ca_ppn_dom_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_ppn_header_only #__ca_repeat_snapshot>*:not(.__ca_print_header_clone){display:none!important}body.__ca_ppn_header_only #__ca_repeat_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_ppn_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_ppn_header_only');const style=document.getElementById('__ca_ppn_dom_page_style');if(style)style.textContent='@media print{#__ca_print_header,#__ca_repeat_snapshot .__ca_print_header_clone{display:none!important}#__ca_repeat_snapshot .__ca_repeat_page_header{break-before:auto!important;page-break-before:auto!important}}'})()`);
        const buffers = await printPaginatorPages(page, session, mode, stableRootSelector, paginatorStates, rootSelector,
            printScale, String(tabLabel || '').toUpperCase() === 'INDUK');
        return Promise.all(buffers.map((buffer) => stampHeaderOnPdf(buffer, headerBuffer)));
    } finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_ppn_header_only');document.getElementById('__ca_ppn_dom_page_style')?.remove()})()`).catch(() => {});
    }
}

async function printPaginatorPages(page, session, mode, stableRootSelector = '', ids = [], rootSelector = '', printScale = PRINT_SCALE, compactOverflow = false) {
    if (mode !== 'full' || !ids.length) return [await printAdaptivePdf(session, printScale, compactOverflow)];
    const buffers = [];
    for (const state of ids) {
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) log('[Lampiran paginator] Owner tidak ditemukan untuk ' + state.id + ': ' + JSON.stringify(owner));
        const paginator = page.locator(`.p-paginator[data-ca-paginator-id="${state.id}"]`).first();
        buffers.push(await printAdaptivePdf(session, printScale, compactOverflow));
        let guard = 0;
        while (guard++ < 10000) {
            const next = paginator.locator('.p-paginator-next').first();
            const disabled = await next.evaluate((button) => button.disabled || button.classList.contains('p-disabled')).catch(() => true);
            if (disabled) break;
            const before = await paginator.textContent().catch(() => '');
            await next.evaluate((button) => button.click()).catch(() => {});
            await page.waitForTimeout(650);
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector, { minWaitMs: 700, timeoutMs: 8000 });
            await page.evaluate(`window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()`).catch(() => {});
            const after = await paginator.textContent().catch(() => '');
            if (after === before) break;
            buffers.push(await printAdaptivePdf(session, printScale, compactOverflow));
        }
        const first = paginator.locator('.p-paginator-first').first();
        const canReset = await first.evaluate((button) => !button.disabled && !button.classList.contains('p-disabled')).catch(() => false);
        if (canReset) {
            await first.evaluate((button) => button.click()).catch(() => {});
            await page.waitForTimeout(650);
            if (stableRootSelector) await waitForTabContentStable(page, stableRootSelector, { minWaitMs: 700, timeoutMs: 8000 });
        }
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

module.exports = { resetPaginators, paginatorIds, setActivePaginatorOwner, clearPaginatorOwners, printL1SnapshotPages, printAnnualDomPages, printPpnDomPages, printPaginatorPages };
