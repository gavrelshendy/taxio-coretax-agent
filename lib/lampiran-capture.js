/* Read-only capture of every table page. Never marks a partial capture complete. */
const runcontrol = require('./runcontrol');
const { log } = require('./log');
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
        // Cell texts and leaf headings too, so a table too large for a PDF can be split off into the
        // Excel lampiran's own full-list sheet (lib/lampiran-big-table.js) whichever way it was read.
        const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
        const cellText = c => { const x = c.cloneNode(true); x.querySelectorAll('.p-column-title').forEach(n => n.remove()); return clean(x.textContent); };
        const grid = [];
        [...(table.tHead ? table.tHead.rows : [])].forEach((tr, r) => { grid[r] = grid[r] || []; let c = 0; for (const cell of tr.cells) { while (grid[r][c] !== undefined) c++; for (let dr = 0; dr < (cell.rowSpan || 1); dr++) for (let dc = 0; dc < (cell.colSpan || 1); dc++) { grid[r + dr] = grid[r + dr] || []; grid[r + dr][c + dc] = cellText(cell); } c += cell.colSpan || 1; } });
        const width = Math.max(0, ...grid.map(g => g.length));
        const leaf = Array.from({ length: width }, (_, c) => [...new Set(grid.map(g => g[c] || '').filter(Boolean))].join(' - '));
        return { bodies, rows: rows.length, footer: table.tFoot?.outerHTML || '', texts: rows.map(r => [...r.cells].map(cellText)), leaf };
    });
}
async function collectTabOnce(page, rootSelector, label) {
    await runcontrol.checkpoint();
    const root = page.locator(rootSelector).first();
    const panels = root.locator('.p-tabview-panel:visible');
    const panel = await panels.count() ? panels.first() : root;
    const owners = panel.locator('p-table:visible');
    const tables = [];
    // Tabel ditandai SEKALI di awal lalu dirujuk lewat tanda itu. Merujuk lewat urutan
    // "p-table:visible" (nth) bergeser bila tabel lain sementara tidak terlihat saat tabel
    // sebelumnya dibaca berhalaman-halaman. Bila Angular membuat ulang tabelnya (tanda hilang),
    // tabel ditandai ulang; bila JUMLAH tabel berubah, bacaan dianggap tidak konsisten (data bisa
    // kurang) dan dibaca ulang dari awal, bukan dilanjutkan dengan tabel yang tersisa.
    let token = 'o' + Date.now().toString(36);
    const tagAll = (t) => owners.evaluateAll((nodes, tok) => { nodes.forEach((n, i) => n.setAttribute('data-ca-owner', tok + '-' + i)); return nodes.length; }, t);
    const describe = () => owners.evaluateAll((nodes) => nodes.map((n) => ({ kepala: ((n.querySelector('thead') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50), baris: n.querySelectorAll('tbody tr').length }))).catch(() => []);
    const ownerTotal = await tagAll(token);
    log('[Capture] ' + label + ': ' + ownerTotal + ' tabel: ' + JSON.stringify(await describe()));
    const ownerAt = async (index) => {
        const find = () => panel.locator('[data-ca-owner="' + token + '-' + index + '"]').first();
        if (await find().count()) return find();
        await page.waitForTimeout(1500);
        if (await find().count()) return find();
        token = 'o' + Date.now().toString(36) + 'r';
        const now = await tagAll(token);
        if (now !== ownerTotal) {
            const e = new Error(label + ': jumlah tabel berubah saat dibaca (' + ownerTotal + ' -> ' + now + ').');
            e.tableShift = true; e.detail = await describe();
            throw e;
        }
        return find();
    };
    for (let index = 0; index < ownerTotal; index++) {
        let owner = await ownerAt(index);
        if (!await owner.locator('table').count()) continue;
        // Angular dapat membuat ulang tabel saat berhalaman (tabel 500 baris): tanda hilang dan
        // locator menunggu 30 dtk lalu gagal. Rujukan disegarkan sebelum dipakai (ownerAt menandai
        // ulang dan menolak bila jumlah tabel berubah).
        const alive = async () => { if (!await owner.count()) owner = await ownerAt(index); };
        const pgOf = () => owner.locator('.p-paginator').first();
        const paged = !!await pgOf().count();
        const canClick = async button => await button.count() && await button.evaluate(n => !n.disabled && !n.classList.contains('p-disabled'));
        const firstOf = () => pgOf().locator('.p-paginator-first');
        const read = async () => { await alive(); return readOwner(owner); };
        const settle = async () => {
            await page.waitForTimeout(350);
            await alive();
            await owner.locator('.p-datatable-loading-overlay:visible,.p-progress-spinner:visible').waitFor({state:'hidden',timeout:20000}).catch(async e => {
                if (await owner.locator('.p-datatable-loading-overlay:visible,.p-progress-spinner:visible').count()) throw e;
            });
        };
        if (paged && await canClick(firstOf())) { await firstOf().click(); await settle(); }
        const report = paged ? await pgOf().textContent() : '';
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
                await alive();
                const next = pgOf().locator('.p-paginator-next');
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
            tables.push({ index, expected, collectedRows: count, bodies: chunks[0].bodies.map((_, j) => chunks.map(c => c.bodies[j] || '').join('')), footer: chunks.at(-1).footer,
                rows: chunks.flatMap(c => c.texts), headers: chunks[0].leaf });
        } finally {
            try { await alive(); if (paged && await canClick(firstOf())) { await firstOf().click(); await settle(); } } catch (_) { /* kembali ke halaman 1 hanya kosmetik */ }
        }
        await alive();
        await owner.evaluate((n, i) => n.setAttribute('data-op-table', String(i)), index);
    }
    return { label, html: await snapshotPanel(panel), tables };
}
/** The tab panel as print-ready HTML: form values written into the markup, scripts and handlers out. */
function snapshotPanel(panel) {
    return panel.evaluate(node => {
        const clone = node.cloneNode(true), source = node.querySelectorAll('input,textarea,select'), target = clone.querySelectorAll('input,textarea,select');
        source.forEach((n, i) => { const x = target[i]; x.setAttribute('value', n.value || ''); x.toggleAttribute('checked', !!n.checked); if(n.tagName==='TEXTAREA')x.textContent=n.value; if(n.tagName==='SELECT')[...x.options].forEach((o,j)=>o.toggleAttribute('selected',j===n.selectedIndex)); });
        clone.querySelectorAll('script,input[type=password],[id^=__ca_]').forEach(n=>n.remove());
        clone.querySelectorAll('[data-ca-owner]').forEach(n=>n.removeAttribute('data-ca-owner'));
        clone.querySelectorAll('*').forEach(n=>{for(const a of [...n.attributes])if(/^on|^(href|src|nonce|formaction)$/i.test(a.name))n.removeAttribute(a.name)});
        return clone.outerHTML;
    });
}
/** Same result as collectTab, but every row comes from `provide(headers, index)` (Coretax's grid
 *  API) instead of paging the tables. The tab must hold exactly `tableCount` tables (in the order
 *  the provider knows them). Each is accepted only when it agrees with the page: as many rows as its
 *  paginator's "dari N entri", and every cell of its first page identical to what Coretax shows.
 *  Anything else throws, and the caller reads the tab page by page instead.
 *  `tableCount` null = any number of tables (SPT Badan); `provide(headers, index, shown)` may then
 *  return null for a table that is not an API grid - it is taken from the screen, which is only
 *  allowed when the screen holds all of its rows (no further pages). `shown.leafHeaders` are the
 *  bottom-level headings of a grouped header (e.g. "BUKTI POTONG/SSP/SSPCP - NOMOR"). */
async function collectTabFromRows(page, rootSelector, label, provide, tableCount = 1) {
    await runcontrol.checkpoint();
    const root = page.locator(rootSelector).first();
    const panels = root.locator('.p-tabview-panel:visible');
    const panel = await panels.count() ? panels.first() : root;
    const owners = panel.locator('p-table:visible');
    const count = await owners.count();
    if (tableCount !== null && count !== tableCount) throw new Error('tab berisi ' + count + ' tabel, diharapkan ' + tableCount);
    let fromApi = 0;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tables = [];
    for (let index = 0; index < count; index++) {
        const owner = owners.nth(index);
        if (!await owner.locator('table').count()) throw new Error('tabel ' + (index + 1) + ' belum termuat');
        await owner.locator('.p-datatable-loading-overlay:visible,.p-progress-spinner:visible').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
        const shown = await owner.evaluate((node) => {
            const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const table = node.querySelector('table');
            const cellText = (c) => { const x = c.cloneNode(true); x.querySelectorAll('.p-column-title').forEach((n) => n.remove()); return clean(x.textContent); };
            const headers = [...(table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells : [])].map(cellText);
            // Leaf headings: lay the header rows out on a grid (rowspan/colspan), then join the texts
            // stacked above each column. Header rows without text (filter rows) add nothing.
            const grid = [];
            [...(table.tHead ? table.tHead.rows : [])].forEach((tr, r) => {
                grid[r] = grid[r] || [];
                let c = 0;
                for (const cell of tr.cells) {
                    while (grid[r][c] !== undefined) c++;
                    for (let dr = 0; dr < (cell.rowSpan || 1); dr++) for (let dc = 0; dc < (cell.colSpan || 1); dc++) { grid[r + dr] = grid[r + dr] || []; grid[r + dr][c + dc] = cellText(cell); }
                    c += cell.colSpan || 1;
                }
            });
            const width = Math.max(0, ...grid.map((g) => g.length));
            const leafHeaders = Array.from({ length: width }, (_, c) => [...new Set(grid.map((g) => g[c] || '').filter(Boolean))].join(' - '));
            const rows = [...table.tBodies].flatMap((b) => [...b.rows]).filter((r) => !/Tidak ada data|No records|No data found/i.test(r.textContent)).map((r) => [...r.cells].map(cellText));
            const report = clean((node.querySelector('.p-paginator') || {}).textContent);
            const m = report.match(/(?:dari|of)\s+([\d.,]+)\s+(?:entri|entries)/i);
            const from = report.match(/(?:Menampilkan|Showing)\s+([\d.,]+)\s+(?:sampai|to)/i);
            return { start: from ? Number(from[1].replace(/\D/g, '')) : null, headers, leafHeaders, rows, total: m ? Number(m[1].replace(/\D/g, '')) : null, footer: table.tFoot ? table.tFoot.outerHTML : '', emptyBody: [...table.tBodies].map((b) => b.innerHTML).join('') };
        });
        const where = count > 1 ? 'tabel ' + (index + 1) + ': ' : '';
        // Page 1 is what the API's first rows are checked against; a table left on another page
        // (remembered grid state) would be compared with the wrong rows.
        if (shown.start !== null && shown.start > 1) throw new Error(where + 'tabel tidak di halaman 1 (mulai baris ' + shown.start + ')');
        const rows = await provide(shown.headers, index, shown);
        if (rows === null && tableCount === null) {
            // Not an API grid: keep the table as Coretax shows it - only when nothing is on other pages.
            if (shown.total !== null && shown.total !== shown.rows.length) throw new Error(where + 'tabel berhalaman tanpa API (' + shown.rows.length + '/' + shown.total + ' baris di layar)');
            // Read exactly as the page-by-page path reads a page (form values written into the markup).
            const data = await readOwner(owner);
            await owner.evaluate((n, i) => n.setAttribute('data-op-table', String(i)), index);
            tables.push({ index, expected: data.rows, collectedRows: data.rows, bodies: data.bodies, footer: data.footer, rows: data.texts, headers: data.leaf });
            continue;
        }
        fromApi++;
        const expected = shown.total === null ? shown.rows.length : shown.total;
        if (rows.length !== expected) throw new Error(where + 'API ' + rows.length + ' baris, Coretax menampilkan ' + expected);
        shown.rows.forEach((cells, i) => {
            const built = rows[i] || [];
            cells.forEach((cell, c) => { if (c > 0 && cell !== (built[c] ?? '')) throw new Error(where + 'baris ' + (i + 1) + ' kolom "' + shown.headers[c] + '": layar "' + cell + '", API "' + (built[c] ?? '') + '"'); });
        });
        const body = rows.length ? rows.map((r) => '<tr>' + r.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') : shown.emptyBody;
        await owner.evaluate((n, i) => n.setAttribute('data-op-table', String(i)), index);
        // rows/headers: the data itself, for a table too large for a PDF (lib/lampiran-big-table.js
        // splitBigTables, which also removes them before rendering).
        tables.push({ index, expected, collectedRows: rows.length, bodies: [body], footer: shown.footer, rows, headers: shown.leafHeaders });
    }
    if (!fromApi) throw new Error('tidak ada tabel yang diambil lewat API');
    return { label, html: await snapshotPanel(panel), tables, source: 'api' };
}
async function collectTab(page, rootSelector, label) {
    try { return await collectTabOnce(page, rootSelector, label); }
    catch (e) {
        if (!e.tableShift) throw e;
        log('[Capture] ' + e.message + ' Kondisi sekarang: ' + JSON.stringify(e.detail) + ' - membaca ulang tab dari awal.');
        await page.waitForTimeout(2500);
        try { return await collectTabOnce(page, rootSelector, label); }
        catch (e2) { if (e2.tableShift) e2.message += ' Kondisi: ' + JSON.stringify(e2.detail) + '. Tab tidak dibaca agar data tidak kurang; coba ulang, atau kirim log ini.'; throw e2; }
    }
}
module.exports = { collectTab, collectTabFromRows };
