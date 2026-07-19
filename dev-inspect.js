/* TEMPORARY dev tool - not part of the Coretax Agent app itself. Opens its OWN persistent Chrome
   context pointed at the SAME manual-login profile folder the app's own openCoretaxManual()
   uses (chrome.PROFILE_ROOT + '_manual') - so it shares whatever login session is already there
   - but tracks the context directly instead of going through lib/chrome.js's getManualPage(),
   because that helper only guesses at ONE "most relevant" tab and Coretax is known to open case
   pages in a new tab, leaving the guess pointed at a stale tab. This script never imports or
   calls anything that touches the app's real automation paths (login/impersonate/ebupot/spt) -
   only the two constants below. Safe to delete once the new feature is done.

   Usage: `node dev-inspect.js`, leave it running. Log into Coretax in the window it opens and
   navigate to whatever page/feature you want to show. Commands are dropped as .dev-inspect/cmd.json:
     {"id": 1, "action": "screenshot"}                      -> .dev-inspect/out-1.png (active tab)
     {"id": 1, "action": "html", "selector": "body"}         -> .dev-inspect/out-1.html (outerHTML)
     {"id": 1, "action": "options", "selector": "li"}       -> .dev-inspect/out-1.json (text list)
     {"id": 1, "action": "frametext"}                        -> .dev-inspect/out-1.frameN.txt per frame, ACROSS ALL TABS
     {"id": 1, "action": "url"}                              -> .dev-inspect/out-1.json ({url})

   "active tab" = the last page in context.pages() that isn't closed (Chrome/Playwright appends
   newly-opened tabs to the end), which is usually the one actually being looked at; "frametext"
   instead dumps every frame of every tab so a mis-guess still turns up in the grep. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const chrome = require('./lib/chrome'); // only for the two shared constants below

const DIR = path.join(__dirname, '.dev-inspect');
fs.mkdirSync(DIR, { recursive: true });
const CMD_FILE = path.join(DIR, 'cmd.json');
try { fs.unlinkSync(CMD_FILE); } catch (e) {}

let lastId = 0;
let context = null;
const networkLog = []; // rolling capture of xhr/fetch calls, for the Option-B feasibility probe
const MAX_NETWORK_LOG = 500;
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-xsrf-token'];

function redactHeaders(h) {
    const out = {};
    for (const k of Object.keys(h || {})) out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? '<redacted>' : h[k];
    return out;
}

function attachNetworkCapture(ctx) {
    const pending = new Map(); // request -> log entry
    // Deliberately NO resourceType filter anymore - an xhr/fetch/document-POST-only filter
    // captured plenty of traffic (referencedata/casemanagementportal calls) but NOTHING from the
    // moment the Tambah Data modal's actual Simpan click happened, even though the row visibly
    // saved - so whatever that save actually is, it isn't one of those three types. Logging
    // everything (plus websockets, attached separately below) until we see what it really is.
    ctx.on('request', (req) => {
        const type = req.resourceType();
        const entry = {
            ts: new Date().toISOString(), method: req.method(), url: req.url(),
            resourceType: type, headers: redactHeaders(req.headers()),
            postData: req.postData() || null, status: null, responseBody: null
        };
        pending.set(req, entry);
        networkLog.push(entry);
        if (networkLog.length > MAX_NETWORK_LOG) networkLog.shift();
    });
    ctx.on('requestfinished', async (req) => {
        const entry = pending.get(req);
        if (!entry) return;
        pending.delete(req);
        try {
            const res = await req.response();
            if (!res) return;
            entry.status = res.status();
            const ct = (res.headers()['content-type'] || '');
            if (ct.includes('json') || ct.includes('text')) {
                const body = await res.text().catch(() => null);
                entry.responseBody = body && body.length > 5000 ? body.slice(0, 5000) + '...(truncated)' : body;
            }
        } catch (e) { /* response unavailable, leave as null */ }
    });
    // WebSocket frames too - if the modal's Simpan pushes data over a socket instead of a
    // request, this is the only place it would show up.
    ctx.on('page', (p) => attachWsCapture(p));
    for (const p of ctx.pages()) attachWsCapture(p);
}

function attachWsCapture(page) {
    page.on('websocket', (ws) => {
        networkLog.push({ ts: new Date().toISOString(), method: 'WS-OPEN', url: ws.url(), resourceType: 'websocket' });
        ws.on('framesent', (f) => networkLog.push({ ts: new Date().toISOString(), method: 'WS-SENT', url: ws.url(), resourceType: 'websocket', postData: String(f.payload).slice(0, 3000) }));
        ws.on('framereceived', (f) => networkLog.push({ ts: new Date().toISOString(), method: 'WS-RECV', url: ws.url(), resourceType: 'websocket', responseBody: String(f.payload).slice(0, 1500) }));
    });
}

const DEFAULT_OPTION_SELECTOR = '[role="option"], li, .p-dropdown-item, .p-multiselect-item, .select2-results__option, option';

function activePage() {
    if (!context) return null;
    const pages = context.pages().filter((p) => !p.isClosed());
    return pages.length ? pages[pages.length - 1] : null;
}

function allFramesAllTabs() {
    if (!context) return [];
    const pages = context.pages().filter((p) => !p.isClosed());
    const out = [];
    for (const p of pages) for (const f of p.frames()) out.push({ page: p, frame: f });
    return out;
}

async function firstNonEmptyAcrossFrames(page, fn) {
    for (const frame of page.frames()) {
        try {
            const result = await fn(frame);
            if (result && (Array.isArray(result) ? result.length : true)) return { frame, result };
        } catch (e) { /* try next frame */ }
    }
    return null;
}

async function runCommand(cmd) {
    const page = activePage();
    if (!page) { console.log('No page open yet.'); return; }
    const outBase = path.join(DIR, 'out-' + cmd.id);
    try {
        if (cmd.action === 'screenshot') {
            await page.screenshot({ path: outBase + '.png', fullPage: !!cmd.fullPage });
            console.log('Wrote ' + outBase + '.png (' + page.url() + ')');
        } else if (cmd.action === 'html') {
            const sel = cmd.selector || 'body';
            const found = await firstNonEmptyAcrossFrames(page, async (frame) => {
                const count = await frame.locator(sel).count();
                if (!count) return null;
                return frame.locator(sel).first().evaluate((el) => el.outerHTML);
            });
            if (!found) { console.log('No match for selector "' + sel + '" in any frame.'); return; }
            fs.writeFileSync(outBase + '.html', found.result, 'utf8');
            console.log('Wrote ' + outBase + '.html (selector "' + sel + '", frame ' + found.frame.url() + ')');
        } else if (cmd.action === 'options') {
            const sel = cmd.selector || DEFAULT_OPTION_SELECTOR;
            const found = await firstNonEmptyAcrossFrames(page, async (frame) => {
                const texts = await frame.locator(sel).allTextContents();
                return texts.map((t) => t.trim()).filter(Boolean);
            });
            const list = found ? found.result : [];
            fs.writeFileSync(outBase + '.json', JSON.stringify(list, null, 2), 'utf8');
            console.log('Wrote ' + outBase + '.json (' + list.length + ' options, frame ' + (found ? found.frame.url() : 'none') + ')');
        } else if (cmd.action === 'frametext') {
            const entries = allFramesAllTabs();
            const manifest = [];
            for (let i = 0; i < entries.length; i++) {
                const { page: p, frame } = entries[i];
                let text = '';
                try { text = await frame.locator('body').innerText({ timeout: 2000 }); } catch (e) { text = '(no body / ' + e.message + ')'; }
                const fname = outBase + '.frame' + i + '.txt';
                fs.writeFileSync(fname, text, 'utf8');
                manifest.push({ i, tabUrl: p.url(), frameUrl: frame.url(), file: path.basename(fname) });
            }
            fs.writeFileSync(outBase + '.manifest.json', JSON.stringify(manifest, null, 2));
            console.log('Wrote ' + entries.length + ' frame text dumps across ' + context.pages().length + ' tab(s), see ' + outBase + '.manifest.json');
        } else if (cmd.action === 'click') {
            // Clicks the first matching element across frames (by selector or visible text).
            const sel = cmd.selector || ('text=' + cmd.text);
            const found = await firstNonEmptyAcrossFrames(page, async (frame) => {
                const loc = frame.locator(sel).first();
                if (!(await loc.count())) return null;
                await loc.click({ timeout: 5000 });
                return 'clicked';
            });
            console.log(found ? ('Clicked "' + sel + '" in frame ' + found.frame.url()) : ('No match to click for "' + sel + '"'));
        } else if (cmd.action === 'fill') {
            const found = await firstNonEmptyAcrossFrames(page, async (frame) => {
                const loc = frame.locator(cmd.selector).first();
                if (!(await loc.count())) return null;
                await loc.fill(String(cmd.value), { timeout: 5000 });
                return 'filled';
            });
            console.log(found ? ('Filled "' + cmd.selector + '" in frame ' + found.frame.url()) : ('No match to fill for "' + cmd.selector + '"'));
        } else if (cmd.action === 'eval') {
            // Runs cmd.expr (a JS expression STRING) in each frame; writes the first frame whose
            // result is non-null/non-undefined. Result is JSON-serialized. Swiss-army probe so we
            // can inspect localStorage/sessionStorage/Angular state/grid contents without adding a
            // new bespoke action (and restart) each time.
            const results = [];
            for (const frame of page.frames()) {
                try {
                    const r = await frame.evaluate(cmd.expr);
                    results.push({ frame: frame.url(), result: r });
                } catch (e) {
                    results.push({ frame: frame.url(), error: e.message });
                }
            }
            fs.writeFileSync(outBase + '.json', JSON.stringify(results, null, 2), 'utf8');
            console.log('Wrote ' + outBase + '.json (eval across ' + results.length + ' frame(s))');
        } else if (cmd.action === 'dump-network') {
            const filter = cmd.filter;
            const matched = filter ? networkLog.filter((e) => e.url.toLowerCase().includes(String(filter).toLowerCase())) : networkLog.slice();
            fs.writeFileSync(outBase + '.json', JSON.stringify(matched, null, 2), 'utf8');
            console.log('Wrote ' + outBase + '.json (' + matched.length + ' of ' + networkLog.length + ' captured calls' + (filter ? ', filtered by "' + filter + '"' : '') + ')');
        } else if (cmd.action === 'url') {
            fs.writeFileSync(outBase + '.json', JSON.stringify({ url: page.url(), allTabs: context.pages().map((p) => p.url()) }, null, 2));
            console.log('URL: ' + page.url());
        } else {
            console.log('Unknown action: ' + cmd.action);
        }
    } catch (e) {
        fs.writeFileSync(outBase + '.error.txt', String(e && e.stack || e));
        console.log('Command failed: ' + e.message);
    }
}

function poll() {
    fs.readFile(CMD_FILE, 'utf8', (err, data) => {
        if (!err && data) {
            try {
                const cmd = JSON.parse(data);
                if (cmd.id !== lastId) {
                    lastId = cmd.id;
                    runCommand(cmd);
                }
            } catch (e) { /* ignore partial writes */ }
        }
        setTimeout(poll, 400);
    });
}

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        acceptDownloads: true, downloadsPath: chrome.DOWNLOAD_DIR,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    attachNetworkCapture(context);
    const page = context.pages()[0] || await context.newPage();
    if (page.url() === 'about:blank') await page.goto(chrome.CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log('Chrome window opened (shares your existing manual-login session) - navigate to the page you want to show.');
    console.log('Waiting for commands in ' + CMD_FILE);
    poll();
})();
