/* Lampiran printing: reading the open Coretax SPT page - tab strip (list, open, wait until
 * stable), table page size, tax year/period and the active taxpayer's NPWP/name. Split out of
 * automation/lampiran.js (still the public entry point). */
const { sanitizeFilenamePart } = require('./datatable');
const { TAB_TITLE_SEL, TAB_ROW_CAP, COMPACT_ROWS } = require('./lampiran-config');

async function waitForTabLabels(page) {
    const deadline = Date.now() + 25000;
    const started = Date.now();
    let best = [], previous = '', stable = 0;
    while (Date.now() < deadline) {
        const labels = await page.evaluate(`(() => {
            const visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
            return [...new Set(Array.from(document.querySelectorAll(${JSON.stringify(TAB_TITLE_SEL)})).filter(visible).map(e=>(e.textContent||'').trim()).filter(Boolean))];
        })()`).catch(() => []);
        if (labels.length > best.length) best = labels;
        const signature = labels.join('|');
        stable = signature && signature === previous ? stable + 1 : 0;
        previous = signature;
        // Angular sering menampilkan tab Induk lebih dahulu, kemudian menyisipkan tab lampiran.
        // Jangan mengunci inventaris pada render parsial tersebut.
        if (labels.length > 1 && stable >= 3) return labels;
        if (labels.length === 1 && Date.now() - started >= 7000 && stable >= 5) return labels;
        await page.waitForTimeout(500);
    }
    return best;
}

/** Opens tab `label`. Angular rebuilds the tab strip now and then (after the SPT page loads, after a
 *  big table reloads): a Playwright click on a header found a moment earlier then waits for an element
 *  that is gone and times out ("waiting for locator('.p-tabview-title')...", seen live 2026-10-20 on a
 *  Badan with a 58.914-row L3). So the header is looked up again on every attempt, clicked with a real
 *  (Playwright) mouse click and a short timeout - a DOM element.click() did NOT open Unifikasi's
 *  DAFTAR-I (live 2026-10-20) - until the tab reports itself active (li.p-highlight / aria-selected),
 *  up to 20 s. A strip without those markers is taken as open after one click, like before. */
async function clickTab(page, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    // One look at the strip: where the tab is now (centre, scrolled into view), whether it is active, and
    // whether the strip marks its active tab at all (Coretax: li.p-highlight + aria-selected only there).
    const look = () => page.evaluate(({ sel, label }) => {
        const visible = (e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; };
        const titles = Array.from(document.querySelectorAll(sel)).filter(visible);
        const isActive = (t) => { const link = t.closest('a,[role=tab]') || t, li = t.closest('li'); return !!(li && li.classList.contains('p-highlight')) || link.getAttribute('aria-selected') === 'true'; };
        const title = titles.find((e) => (e.textContent || '').trim() === label);
        if (!title) return { found: false };
        // Centred, not 'nearest': scrolled down in a long lampiran, 'nearest' parks the strip under
        // Coretax's fixed top bar and the click lands on the bar (live 2026-10-20, L4 never opened).
        title.scrollIntoView({ block: 'center', inline: 'center' });
        const r = title.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y), tab = title.closest('li') || title.closest('a,[role=tab]') || title;
        const desc = (e) => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '-';
        return { found: true, active: isActive(title), marked: titles.some(isActive), x: Math.round(x), y: Math.round(y), clickable: !!hit && (tab.contains(hit) || title.contains(hit)),
            cover: desc(hit), viewport: window.innerWidth + 'x' + window.innerHeight };
    }, { sel: TAB_TITLE_SEL, label }).catch(() => ({ found: false }));
    // Ways to click, taken in turn until the tab is active: a real mouse click at its position (Coretax
    // keeps rebuilding the strip, so a handle found a moment earlier is already gone - live 2026-10-20,
    // MERATUS LINE), the tab link's own click() in the page, then Playwright's click with force. One of
    // them failed in a user's window and not in mine (2026-10-21), so none is relied on alone.
    const ways = [
        async (s) => { if (s.clickable) await page.mouse.click(s.x, s.y); else await page.evaluate(() => window.scrollTo(0, 0)); },
        () => page.evaluate(({ sel, label }) => { const t = Array.from(document.querySelectorAll(sel)).find((e) => (e.textContent || '').trim() === label); const link = t && (t.closest('a,[role=tab]') || t); if (link) { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); link.click(); } }, { sel: TAB_TITLE_SEL, label }),
        () => page.locator(TAB_TITLE_SEL).filter({ hasText: label }).first().click({ force: true, timeout: 2500 })
    ];
    let last = { found: false }, attempt = 0;
    while (Date.now() < deadline) {
        last = await look();
        if (last.found && last.active) { await page.waitForTimeout(attempt ? 1400 : 600); return true; }
        if (!last.found) { await page.waitForTimeout(500); continue; }
        await ways[attempt++ % ways.length](last).catch(() => {});
        await page.waitForTimeout(1200);
        const after = await look();
        if (after.found && after.active) { await page.waitForTimeout(400); return true; }
        // A strip that never marks an active tab cannot be checked: one click is all the old code did.
        if (after.found && !after.marked) return true;
        last = after;
    }
    clickTab.lastFailure = last.found
        ? 'tab ada, tidak aktif setelah ' + attempt + ' klik; titik (' + last.x + ',' + last.y + ') tertutup ' + (last.clickable ? 'tidak' : last.cover) + ', jendela ' + last.viewport
        : 'tab "' + label + '" tidak terlihat';
    return false;
}

async function waitForTabContentStable(page, rootSelector, { minWaitMs = 2000, timeoutMs = 12000 } = {}) {
    const started = Date.now();
    let previous = '', stable = 0;
    while (Date.now() - started < timeoutMs) {
        const state = await page.evaluate(`(()=>{
          const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
          const root=document.querySelector(${JSON.stringify(rootSelector)});if(!root)return{busy:true,snapshot:''};
          const busy=Array.from(root.querySelectorAll('.p-progress-spinner,.p-datatable-loading-overlay,.p-progressbar-indeterminate,.p-skeleton')).some(visible);
          const clean=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
          const tables=Array.from(root.querySelectorAll('table')).filter(visible).map(t=>clean(t.tBodies?.[0])+'|'+clean(t.tFoot));
          const pagers=Array.from(root.querySelectorAll('.p-paginator')).filter(visible).map(clean);
          return{busy,snapshot:(tables.join('||')+'###'+pagers.join('||')).slice(0,250000)};
        })()`).catch(() => ({ busy: true, snapshot: '' }));
        if (!state.busy && state.snapshot && state.snapshot === previous) stable++;
        else stable = 0;
        previous = state.snapshot;
        if (Date.now() - started >= minWaitMs && stable >= 3) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function setUpTables(page, tabLabel, mode, taxTypeCode) {
    await page.evaluate(`(async()=>{
      const sleep=m=>new Promise(r=>setTimeout(r,m)),visible=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const monthlyFull=${JSON.stringify(mode)}==='full'&&['ICT_WIT','ICT_WT','VAT_VAT'].includes(${JSON.stringify(taxTypeCode || '')}),cap=monthlyFull?25:(${JSON.stringify(mode)}==='print'?(${JSON.stringify(TAB_ROW_CAP)}[${JSON.stringify(tabLabel)}]||${COMPACT_ROWS}):0);
      for(const dd of Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(visible)){try{if((dd.className||'').includes('p-disabled'))continue;dd.click();await sleep(300);const items=Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(visible);if(!items.length){document.body.click();continue}let pick=items.length-1;if(cap){let bi=-1,bv=-1;items.forEach((it,i)=>{const v=parseInt((it.textContent||'').replace(/[^\\d]/g,''),10);if(!isNaN(v)&&v<=cap&&v>bv){bi=i;bv=v}});pick=bi>=0?bi:0}items[pick].click();await sleep(500)}catch(e){}}
    })()`).catch(() => {});
}

async function detectYear(page, timeoutMs = 30000) {
    // Tab dapat muncul lebih dahulu daripada nilai form SPT. Jangan langsung
    // memakai tahun kalender karena akan menghasilkan folder/kop yang salah.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const values = await page.locator('[formcontrolname="TaxYear"],[formcontrolname="TaxPeriodYear"],[formcontrolname="PeriodYear"]')
            .evaluateAll((nodes) => nodes.map((node) => node.value || node.textContent || '')).catch(() => []);
        for (const value of values) {
            const match = String(value).match(/(?:19|20)\d{2}/);
            if (match) return match[0];
        }
        const text = await page.locator('body').innerText().catch(() => '');
        const textMatch = text.match(/(?:Tahun Pajak|Tax Year)[^\d]*((?:19|20)\d{2})/i);
        if (textMatch) return textMatch[1];
        await page.waitForTimeout(300);
    }
    // Jangan pernah menebak tahun berjalan. Pada SPT lama, fallback tersebut membuat kop dan
    // nama file tampak sah tetapi salah tahun ketika Angular terlambat mengisi TaxYear.
    return '';
}

async function detectTaxPeriod(page, config) {
    const year = await detectYear(page, config.annual ? 60000 : 10000);
    if (config.annual) {
        if (!year) throw new Error('Tahun Pajak belum tersedia di halaman Coretax. Tunggu form selesai dimuat lalu coba lagi.');
        return { year, fileLabel: year, headerLabel: 'Tahun ' + year };
    }
    const names = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const compact = await page.locator('[formcontrolname="Period"],[formcontrolname="TaxPeriodYear"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    const compactMatch = String(compact).match(/^(0?[1-9]|1[0-2])(\d{4})$/);
    if (compactMatch) {
        const month = names[Number(compactMatch[1]) - 1];
        return { year: compactMatch[2], fileLabel: month + ' ' + compactMatch[2], headerLabel: 'Masa Pajak ' + month + ' ' + compactMatch[2] };
    }
    const monthValue = await page.locator('[formcontrolname="TaxPeriodMonth"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    const yearValue = await page.locator('[formcontrolname="TaxPeriodYear"]').first().inputValue({ timeout: 1500 }).catch(() => '');
    if (/^(?:[1-9]|1[0-2])$/.test(monthValue) && /^\d{4}$/.test(yearValue)) {
        const month = names[Number(monthValue) - 1];
        return { year: yearValue, fileLabel: month + ' ' + yearValue, headerLabel: 'Masa Pajak ' + month + ' ' + yearValue };
    }
    const text = await page.locator('body').innerText().catch(() => '');
    const months = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember';
    const match = text.match(new RegExp('Masa Pajak\\s*(' + months + ')\\s*(\\d{4})', 'i'));
    if (match) {
        const month = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        return { year: match[2], fileLabel: month + ' ' + match[2], headerLabel: 'Masa Pajak ' + month + ' ' + match[2] };
    }
    const urlDate = page.url().match(/\/(\d{2})(\d{2})(\d{4})\//);
    if (urlDate) {
        const month = names[Math.max(0, Math.min(11, Number(urlDate[2]) - 1))];
        return { year: urlDate[3], fileLabel: month + ' ' + urlDate[3], headerLabel: 'Masa Pajak ' + month + ' ' + urlDate[3] };
    }
    const fallbackYear = year || String(new Date().getFullYear());
    return { year: fallbackYear, fileLabel: fallbackYear, headerLabel: 'Tahun ' + fallbackYear };
}

/** NPWP WP aktif, dari field Tin di halaman SPT atau dari header akun Coretax. Dipakai bila NPWP
 *  tidak datang dari Taxio (login manual): kop lampiran PER-11 mencetak NPWP per kotak digit. */
async function detectActiveTaxpayerTin(page) {
    return page.evaluate(`(() => {
      const clean=s=>(s||'').replace(/\\s+/g,' ').trim();
      const field=document.querySelector('[formcontrolname="Tin"]');
      const fromField=clean(field&&(field.value||field.textContent)).replace(/\\D/g,'');
      if(/^\\d{15,16}$/.test(fromField))return fromField;
      const head=Array.from(document.querySelectorAll('header *,nav *')).map(e=>clean(e.textContent)).join(' ');
      return (head.match(/\\d{15,16}/)||[''])[0];
    })()`).catch(() => '');
}

/** Baca WP aktif dari pill akun Coretax. Ini sengaja tidak memakai nama entitas dari Taxio,
 * agar benar ketika user login manual maupun sedang impersonate. */
async function detectActiveTaxpayerName(page) {
    const value = await page.evaluate(`(() => {
      const clean=s=>(s||'').replace(/\\s+/g,' ').trim();
      // Header Coretax merender NPWP + nama + label tanpa separator pada textContent
      // (contoh: 0769...4000RWES DREAM SOCIETYImpersonate), jadi jangan gunakan \b.
      const tidy=s=>clean(s).replace(/IMPERSONATE/ig,'').replace(/\\d{15,16}/g,'').replace(/[·|]+/g,' ').trim();
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

module.exports = { waitForTabLabels, clickTab, waitForTabContentStable, setUpTables, detectYear, detectTaxPeriod, detectActiveTaxpayerTin, detectActiveTaxpayerName };
