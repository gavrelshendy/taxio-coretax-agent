const capturedContexts = new WeakMap();

function cleanPath(url) {
    try { return new URL(url).pathname.toLowerCase(); }
    catch (_) { return String(url || '').split('?')[0].toLowerCase(); }
}

function watchContext(context) {
    if (capturedContexts.has(context)) return capturedContexts.get(context);
    const state = { authorization: '', dgtCode: '', requests: new Map(), requestVariants: new Map() };
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

async function fetchCapturedRows(page, state, pathname, request, { batchSize = 500 } = {}) {
    const baseBody = { ...request.body };
    const rows = [];
    let total = null;
    for (let first = 0, guard = 0; guard++ < 10000; first = rows.length) {
        const body = { ...baseBody, First: first, Rows: batchSize };
        const response = await apiPost(page, state, request.url, body);
        if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
            throw new Error('API grid gagal ' + pathname + ' (HTTP ' + (response && response.status || 0) + ').');
        }
        const payload = response.json.Payload || {};
        const pageRows = Array.isArray(payload.Data) ? payload.Data : [];
        if (total === null) total = Number(payload.TotalRecords);
        rows.push(...pageRows);
        if (!pageRows.length || pageRows.length < batchSize || (Number.isFinite(total) && rows.length >= total)) break;
    }
    if (Number.isFinite(total) && rows.length !== total) {
        throw new Error('Data grid tidak lengkap ' + pathname + ': backend ' + total + ', terambil ' + rows.length + '.');
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

module.exports = { watchContext, gridRequests, dataRequests, dataRequestVariants,
    fetchAllRows, fetchAllRowsFromRequest, authenticatedPost, cleanPath };
