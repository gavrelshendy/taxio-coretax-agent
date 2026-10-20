const capturedContexts = new WeakMap();

/** Removes Coretax's remembered table paging/filters ("grid-state-*" in localStorage) on SPT pages,
 *  before the page's own scripts read them. Returns how many were removed (used by resetGridState). */
const GRID_STATE_RESET = `(() => { try {
    if (!/-tax-return\\//.test(location.pathname)) return 0;
    const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^grid-state-/.test(k)) keys.push(k); }
    keys.forEach((k) => localStorage.removeItem(k)); return keys.length;
} catch (e) { return 0; } })()`;

/** For a page already open: true when some table there remembers a page other than the first or a
 *  filter - its grid state is removed and the caller must reload the page. */
async function resetGridState(page) {
    return page.evaluate(() => {
        let stale = false;
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^grid-state-/.test(k)) keys.push(k); }
        for (const k of keys) {
            try {
                const s = JSON.parse(localStorage.getItem(k) || '{}');
                const filtered = JSON.stringify(s.filters || {}).match(/"value":(?!null)/);
                if ((s.first || 0) > 0 || filtered) stale = true;
            } catch (e) { stale = true; }
            localStorage.removeItem(k);
        }
        return stale;
    }).catch(() => false);
}

function cleanPath(url) {
    try { return new URL(url).pathname.toLowerCase(); }
    catch (_) { return String(url || '').split('?')[0].toLowerCase(); }
}

function watchContext(context) {
    if (capturedContexts.has(context)) return capturedContexts.get(context);
    // codeLists: every code -> text list the page itself loaded (reference data, dropdown options), as
    // [{ source, map }]. A lampiran column showing text for a code (L9 "0710" -> "Peralatan Lainnya")
    // takes the list that agrees with every pair on its first page (lib/lampiran-api-cit.js).
    // Any Coretax JSON response, GET or POST, except the grid data itself: L9's asset-group names did not
    // come from a referencedata GET (live 2026-10-20, MERATUS LINE). jsonSources: what was looked at,
    // for the log when a code stays unexplained.
    const state = { authorization: '', dgtCode: '', requests: new Map(), requestVariants: new Map(), codeLists: [], jsonSources: [] };
    // Coretax keeps every SPT table's paging and filters in localStorage ("grid-state-<hash>":
    // {"first":800,"rows":50,"filters":...}) across sessions, and L9's group tables share one: after
    // an earlier read stopped on page 17, L9 opened at rows 801-850, and the groups with fewer rows
    // showed "0 dari 0 entri" - read as empty, silently (live 2026-10-20, MERATUS LINE). Every SPT page
    // therefore starts from page 1 without filters.
    context.addInitScript(GRID_STATE_RESET).catch(() => {});
    state.listenMs = 0; state.listenCount = 0;
    context.on('response', async (response) => {
        if (process.env.CORETAX_NO_CODELIST_CAPTURE === '1') return;
        const started = Date.now();
        try {
            const url = response.url();
            if (!/^https:\/\/coretaxdjp\.pajak\.go\.id\//i.test(url) || /\/load[a-z0-9]+\/[a-z0-9-]*grid\b/i.test(url)) return;
            if (!/json/i.test((response.headers() || {})['content-type'] || '')) return;
            if (Number((response.headers() || {})['content-length'] || 0) > 5e6) return;
            const lists = codeListsOf(await response.json(), cleanPath(url));
            if (state.jsonSources.length < 300) state.jsonSources.push(cleanPath(url) + (lists.length ? ' (' + lists.length + ' daftar)' : ''));
            for (const list of lists) if (state.codeLists.length < 5000) state.codeLists.push(list);
        } catch (_) { /* best effort: a missing list only means the page-1 pairs must do */ }
        finally { state.listenMs += Date.now() - started; state.listenCount++; }
    });
    context.on('request', (request) => {
        if (!/\/returnsheetportal\/api\//i.test(request.url())) return;
        const headers = request.headers();
        if (headers.authorization) state.authorization = headers.authorization;
        if (headers['x-dgt-code']) state.dgtCode = headers['x-dgt-code'];
        let body = null;
        try { body = JSON.parse(request.postData() || 'null'); } catch (_) { body = null; }
        if (request.method() === 'POST' && body && typeof body === 'object') {
            const pathname = cleanPath(request.url());
            const captured = { url: request.url(), body };
            state.requests.set(pathname, captured);
            if (!state.requestVariants.has(pathname)) state.requestVariants.set(pathname, new Map());
            const signatureBody = { ...body };
            if ('First' in signatureBody) signatureBody.First = 0;
            if ('first' in signatureBody) signatureBody.first = 0;
            if ('Rows' in signatureBody) signatureBody.Rows = 0;
            if ('rows' in signatureBody) signatureBody.rows = 0;
            const variantKey = JSON.stringify(signatureBody);
            state.requestVariants.get(pathname).set(variantKey, captured);
        }
    });
    capturedContexts.set(context, state);
    return state;
}

/** Code -> text lists inside a JSON response: Coretax reference data ({ReferenceDataType, Details:
 *  [{Code, CodeDescription}]}) and any array of objects carrying a code field and a text field. */
function codeListsOf(json, source) {
    const out = [];
    const CODE = /^(Code|Value|Id|Key|.*Code)$/i, TEXT = /^(CodeDescription|Description|Name|Label|Text|.*Name|.*Description)$/i;
    const visit = (node, where, depth, inArray = false) => {
        if (!node || typeof node !== 'object' || depth > 6) return;
        if (Array.isArray(node)) {
            const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
            if (objs.length >= 2 && objs.length === node.length) {
                const keys = Object.keys(objs[0]);
                for (const k of keys.filter((k) => CODE.test(k))) for (const t of keys.filter((t) => t !== k && TEXT.test(t))) {
                    const map = {};
                    let ok = true;
                    for (const o of objs) { const c = o[k], v = o[t]; if (c === null || c === undefined || typeof v !== 'string') { ok = false; break; } map[String(c)] = v.replace(/\s+/g, ' ').trim(); }
                    if (ok) out.push({ source: where + ' ' + k + '->' + t, map });
                }
            }
            node.forEach((x) => visit(x, where, depth + 1, true));
            return;
        }
        // A plain key -> text object (a translation file section: { "0710": "Peralatan Lainnya" }) - not
        // a record inside a list, whose field -> value pairs are just noise.
        const texts = inArray ? [] : Object.entries(node).filter(([, v]) => typeof v === 'string');
        if (texts.length >= 2) out.push({ source: where + ' {}', map: Object.fromEntries(texts.map(([k, v]) => [k, v.replace(/\s+/g, ' ').trim()])) });
        for (const [k, v] of Object.entries(node)) visit(v, k === 'Details' && node.ReferenceDataType ? where + '#' + node.ReferenceDataType : where + '.' + k, depth + 1);
    };
    visit(json, source, 0);
    return out;
}

/** Code -> text lists the web app keeps in localStorage/sessionStorage (reference data it cached on an
 *  earlier visit, so no request is made now). */
async function storedCodeLists(page) {
    const values = await page.evaluate(() => {
        const out = [];
        for (const store of [window.localStorage, window.sessionStorage]) {
            try { for (let i = 0; i < store.length; i++) { const k = store.key(i), v = store.getItem(k); if (v && v.length < 5e6 && /^[[{]/.test(v.trim())) out.push([k, v]); } } catch (e) { }
        }
        return out;
    }).catch(() => []);
    const lists = [];
    for (const [key, value] of values) { try { lists.push(...codeListsOf(JSON.parse(value), 'storage:' + key)); } catch (_) { } }
    // Coretax's reference data lives in IndexedDB (e-tax-database / referenceDataStore: one record per
    // ReferenceDataType + language, refreshed only when its checksum changes - so it never shows up on
    // the network): L9's "0405" -> "Kendaraan Angkutan" is TANGIBLE_ASSET there (live 2026-10-20).
    const idb = await page.evaluate(async () => {
        const out = [];
        const dbs = indexedDB.databases ? await indexedDB.databases().catch(() => []) : [];
        for (const info of dbs) {
            let db;
            try { db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onupgradeneeded = () => { r.transaction.abort(); rej(new Error('new')); }; }); } catch (e) { continue; }
            for (const store of [...db.objectStoreNames]) {
                const all = await new Promise((res) => { try { const rq = db.transaction(store, 'readonly').objectStore(store).getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); } catch (e) { res([]); } });
                for (const rec of all) {
                    if (!rec || !Array.isArray(rec.Details)) continue;
                    const where = 'idb:' + info.name + '/' + store + '#' + (rec.ReferenceDataType || '?') + (rec.language ? '/' + rec.language : '');
                    const desc = {}, name = {};
                    for (const d of rec.Details) { if (!d || d.Code == null) continue; if (typeof d.CodeDescription === 'string') desc[String(d.Code)] = d.CodeDescription.replace(/\s+/g, ' ').trim(); if (typeof d.CodeName === 'string') name[String(d.Code)] = d.CodeName.replace(/\s+/g, ' ').trim(); }
                    if (Object.keys(desc).length) out.push({ source: where + ' Code->CodeDescription', map: desc });
                    if (Object.keys(name).length) out.push({ source: where + ' Code->CodeName', map: name });
                }
            }
            db.close();
        }
        return out;
    }).catch(() => []);
    return lists.concat(idb);
}

/** Code -> text lists written into the web app's own JavaScript (L9's asset groups: "0405" -> its name
 *  is in no response and no storage - live 2026-10-20). Every script the page loaded is read back from
 *  the browser cache and its object literals { a:"0405", b:"..." } grouped per key pair; only lists that
 *  agree with every `pairs` entry (page-1 code -> text) and add something are returned. */
async function bundleCodeLists(page, pairs) {
    const known = (pairs || []).filter(([k, v]) => k && v);
    if (!known.length) return [];
    return page.evaluate(async (known) => {
        const urls = [...new Set([...performance.getEntriesByType('resource').map((e) => e.name), ...[...document.scripts].map((s) => s.src)]
            .filter((u) => /^https:\/\/coretaxdjp\.pajak\.go\.id\/.*\.js(\?|$)/i.test(u)))];
        const groups = new Map();
        const prop = /([A-Za-z_$][\w$]*|"[^"]+"):"((?:[^"\\]|\\.){1,200})"/g;
        for (const url of urls) {
            let text = '';
            try { text = await (await fetch(url, { cache: 'force-cache' })).text(); } catch (e) { continue; }
            if (!known.some(([k]) => text.includes('"' + k + '"'))) continue;
            for (const m of text.matchAll(/\{[^{}]{4,600}\}/g)) {
                const props = [...m[0].matchAll(prop)].map((p) => [p[1].replace(/"/g, ''), p[2]]);
                if (props.length < 2) continue;
                for (const [a, va] of props) for (const [b, vb] of props) {
                    if (a === b) continue;
                    const key = url.split('/').pop() + ' ' + a + '->' + b;
                    if (!groups.has(key)) groups.set(key, {});
                    const map = groups.get(key);
                    if (!(va in map)) map[va] = vb;
                }
            }
        }
        const out = [];
        for (const [source, map] of groups) {
            if (Object.keys(map).length < 2) continue;
            if (known.every(([k, v]) => map[k] === v)) out.push({ source: 'js:' + source, map });
        }
        return out;
    }, known).catch(() => []);
}

function gridRequests(context) {
    return dataRequests(context).filter((request) => /(?:grid|list)$/i.test(request.pathname));
}

/** Annual SPT also uses pageable endpoints whose path does not end in `grid`/`list`.
 * Keep this broader inventory separate so monthly mappings remain conservative. */
function dataRequests(context) {
    const state = watchContext(context);
    return Array.from(state.requests.entries())
        .filter(([, request]) => request.body && ('Rows' in request.body || 'rows' in request.body))
        .map(([pathname, request]) => ({ pathname, url: request.url, body: { ...request.body } }));
}

function dataRequestVariants(context) {
    const state = watchContext(context);
    const variants = [];
    for (const [pathname, byBody] of state.requestVariants.entries()) {
        for (const [variantKey, request] of byBody.entries()) {
            if (!request.body || (!('Rows' in request.body) && !('rows' in request.body))) continue;
            variants.push({ pathname, variantKey, url: request.url, body: { ...request.body } });
        }
    }
    return variants;
}

async function waitForRequest(context, suffix, timeoutMs = 6000) {
    const state = watchContext(context);
    const wanted = String(suffix || '').toLowerCase();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const found = Array.from(state.requests.entries()).find(([pathname]) => pathname.endsWith(wanted));
        if (found && state.authorization) return { state, pathname: found[0], request: found[1] };
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
}

async function apiPost(page, state, url, body) {
    const expression = '(async()=>{try{const r=await fetch(' + JSON.stringify(url) + ',{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","Authorization":' + JSON.stringify(state.authorization) + ',"x-dgt-code":' + JSON.stringify(state.dgtCode) + '},body:' + JSON.stringify(JSON.stringify(body)) + '});let j=null;try{j=await r.json()}catch(e){}return{status:r.status,json:j}}catch(e){return{status:0,json:null,error:String(e&&e.message||e)}}})()';
    return page.evaluate(expression);
}

async function authenticatedPost(page, url, body) {
    const state = watchContext(page.context());
    if (!state.authorization) throw new Error('Header autentikasi Coretax belum tertangkap.');
    return apiPost(page, state, url, body);
}

async function fetchCapturedRows(page, state, pathname, request, { batchSize = 500, parallel = 4 } = {}) {
    const baseBody = { ...request.body };
    const fetchPage = async (first) => {
        const response = await apiPost(page, state, request.url, { ...baseBody, First: first, Rows: batchSize });
        if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
            throw new Error('API grid gagal ' + pathname + ' (HTTP ' + (response && response.status || 0) + ').');
        }
        const payload = response.json.Payload || {};
        return { total: Number(payload.TotalRecords), rows: Array.isArray(payload.Data) ? payload.Data : [] };
    };
    // Page 1 gives the total; the other pages are fetched a few at a time (L9 MERATUS LINE: 140 pages,
    // 80 s one by one) and put back in order. Order is stable across requests (checked live 2026-10-20).
    const head = await fetchPage(0);
    const total = head.total;
    const pages = [head.rows];
    if (Number.isFinite(total) && head.rows.length === batchSize && total > batchSize) {
        const offsets = [];
        for (let first = batchSize; first < total; first += batchSize) offsets.push(first);
        const results = new Array(offsets.length);
        let next = 0;
        const worker = async () => { while (next < offsets.length) { const i = next++; results[i] = (await fetchPage(offsets[i])).rows; } };
        await Promise.all(Array.from({ length: Math.min(parallel, offsets.length) }, worker));
        pages.push(...results);
    }
    const rows = [].concat(...pages);
    if (Number.isFinite(total) && rows.length !== total) {
        throw new Error('Data grid tidak lengkap ' + pathname + ': backend ' + total + ', terambil ' + rows.length + '.');
    }
    // No row twice (a page boundary that shifted would repeat one and drop another).
    const ids = rows.map((r) => r && r.RecordId).filter((id) => id !== null && id !== undefined && id !== '');
    if (ids.length === rows.length && rows.length && new Set(ids).size !== rows.length) {
        throw new Error('Data grid ganda ' + pathname + ': ' + rows.length + ' baris, ' + new Set(ids).size + ' RecordId unik.');
    }
    return {
        endpoint: pathname,
        request: { ...baseBody, First: 0, Rows: batchSize },
        total: Number.isFinite(total) ? total : rows.length,
        rows
    };
}

async function fetchAllRowsFromRequest(page, requestInfo, options = {}) {
    const state = watchContext(page.context());
    if (!state.authorization) throw new Error('Header autentikasi Coretax belum tertangkap.');
    if (!requestInfo || !requestInfo.url || !requestInfo.body) throw new Error('Request grid tidak valid.');
    return fetchCapturedRows(page, state, requestInfo.pathname || cleanPath(requestInfo.url), requestInfo, options);
}

async function fetchAllRows(page, suffix, { batchSize = 500, timeoutMs = 6000 } = {}) {
    const captured = await waitForRequest(page.context(), suffix, timeoutMs);
    if (!captured) throw new Error('Request grid Coretax belum tertangkap: ' + suffix);
    return fetchCapturedRows(page, captured.state, captured.pathname, captured.request, { batchSize });
}

/** The request Coretax itself made for `suffix` for this one SPT (its ReturnSheetRecordId), or
 *  null. Looked up among every variant seen, not just the latest per path: in a run over several
 *  masa in one window, the latest la2-grid request can belong to the previous SPT. */
function findRequestForRecord(context, suffix, recordId) {
    const wanted = String(suffix || '').toLowerCase();
    const record = String(recordId || '').toLowerCase();
    for (const v of dataRequestVariants(context).reverse()) {
        if (!v.pathname.endsWith(wanted)) continue;
        if (String(v.body.ReturnSheetRecordId || '').toLowerCase() === record) return v;
    }
    return null;
}

function hasAuthorization(context) { return !!watchContext(context).authorization; }

module.exports = { watchContext, resetGridState, GRID_STATE_RESET, codeListsOf, storedCodeLists, bundleCodeLists, gridRequests, dataRequests, dataRequestVariants,
    fetchAllRows, fetchAllRowsFromRequest, authenticatedPost, cleanPath, findRequestForRecord, hasAuthorization };
