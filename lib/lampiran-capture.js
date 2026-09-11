/* Read-only capture of every table page. Never marks a partial capture complete. */
const runcontrol = require('./runcontrol');
async function readOwner(owner) {
    return owner.evaluate(node => {
        const clone = node.cloneNode(true);
        const source = node.querySelectorAll('input,textarea,select');
        const dest = clone.querySelectorAll('input,textarea,select');
        source.forEach((input, i) => {
            const target = dest[i];
            target.setAttribute('value', input.value || '');
            target.toggleAttribute('checked', !!input.checked);
            if (input.tagName === 'TEXTAREA') target.textContent = input.value;
            if (input.tagName === 'SELECT') [...target.options].forEach((o, j) => o.toggleAttribute('selected', j === input.selectedIndex));
        });
        clone.querySelectorAll('script,input[type=password]').forEach(n => n.remove());
        const table = clone.matches('table') ? clone : clone.querySelector('table');
        if (!table) throw Error('Tabel Coretax tidak ditemukan.');
        const bodies = [...table.tBodies].map(b => b.innerHTML);
        const rows = [...table.tBodies].flatMap(b => [...b.rows]).filter(r => !/Tidak ada data|No records|No data found/i.test(r.textContent));
        return { bodies, rows: rows.length, footer: table.tFoot?.outerHTML || '' };
    });
}
async function collectTab(page, rootSelector, label) {
    await runcontrol.checkpoint();
    const root = page.locator(rootSelector).first();
    const panels = root.locator('.p-tabview-panel:visible');
    const panel = await panels.count() ? panels.first() : root;
    const owners = panel.locator('p-table:visible');
    const tables = [];
    for (let index = 0; index < await owners.count(); index++) {
        const owner = owners.nth(index);
        if (!await owner.locator('table').count()) continue;
        const pg = owner.locator('.p-paginator').first();
        const paged = !!await pg.count();
        const canClick = async button => await button.count() && await button.evaluate(n => !n.disabled && !n.classList.contains('p-disabled'));
        const first = pg.locator('.p-paginator-first');
        const read = () => readOwner(owner);
        const settle = async () => {
            await page.waitForTimeout(350);
            await owner.locator('.p-datatable-loading-overlay:visible,.p-progress-spinner:visible').waitFor({state:'hidden',timeout:20000}).catch(async e => {
                if (await owner.locator('.p-datatable-loading-overlay:visible,.p-progress-spinner:visible').count()) throw e;
            });
        };
        if (paged && await canClick(first)) { await first.click(); await settle(); }
        const report = paged ? await pg.textContent() : '';
        const match = report.match(/(?:dari|of)\s+([\d.,]+)\s+(?:entri|entries)/i);
        const expected = match ? Number(match[1].replace(/\D/g, '')) : null;
        const chunks = [], seen = new Set();
        let count = 0, finished = false;
        try {
            for (let guard = 0; guard < 10000; guard++) {
                await runcontrol.checkpoint();
                await settle();
                const data = await read();
                const signature = data.bodies.join('');
                if (seen.has(signature) && data.rows) throw Error(label + ': halaman berulang, unduhan dibatalkan agar data tidak ganda.');
                seen.add(signature); chunks.push(data); count += data.rows;
                const next = pg.locator('.p-paginator-next');
                if (!paged || !await canClick(next)) { finished = true; break; }
                await next.click();
                let changed = false;
                for (let retry = 0; retry < 40; retry++) {
                    await page.waitForTimeout(250);
                    if ((await read()).bodies.join('') !== signature) { changed = true; break; }
                }
                if (!changed) throw Error(label + ': halaman tabel tidak berganti.');
            }
            if (!finished || (expected !== null && expected !== count)) throw Error(label + ': data belum lengkap (' + count + '/' + (expected ?? '?') + ' baris).');
            tables.push({ index, expected, collectedRows: count, bodies: chunks[0].bodies.map((_, j) => chunks.map(c => c.bodies[j] || '').join('')), footer: chunks.at(-1).footer });
        } finally {
            if (paged && await canClick(first)) { await first.click(); await settle(); }
        }
        await owner.evaluate((n, i) => n.setAttribute('data-op-table', String(i)), index);
    }
    const html = await panel.evaluate(node => {
        const clone = node.cloneNode(true), source = node.querySelectorAll('input,textarea,select'), target = clone.querySelectorAll('input,textarea,select');
        source.forEach((n, i) => { const x = target[i]; x.setAttribute('value', n.value || ''); x.toggleAttribute('checked', !!n.checked); if(n.tagName==='TEXTAREA')x.textContent=n.value; if(n.tagName==='SELECT')[...x.options].forEach((o,j)=>o.toggleAttribute('selected',j===n.selectedIndex)); });
        clone.querySelectorAll('script,input[type=password],[id^=__ca_]').forEach(n=>n.remove());
        clone.querySelectorAll('*').forEach(n=>{for(const a of [...n.attributes])if(/^on|^(href|src|nonce|formaction)$/i.test(a.name))n.removeAttribute(a.name)});
        return clone.outerHTML;
    });
    return { label, html, tables };
}
module.exports = { collectTab };
