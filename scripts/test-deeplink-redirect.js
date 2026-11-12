/* Offline tests for lib/deeplink.js isAllowedRedirect(): a taxio-coretax:// `redirect` (which
 * any web page can trigger) may only send the logged-in Coretax window to
 * https://coretaxdjp.pajak.go.id/... . No browser, no network. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-deeplink-'));
process.env.TAXIO_PILOT_LOG_FILE = path.join(TMP, 'test.log');
process.env.TAXIO_PILOT_DATA_DIR = path.join(TMP, 'data');
const { isAllowedRedirect, parseIncomingUrl } = require('../lib/deeplink');

const allowed = [
    'https://coretaxdjp.pajak.go.id/returnsheets-portal/myreturnsheets',
    'https://coretaxdjp.pajak.go.id/',
    'https://CORETAXDJP.pajak.go.id/e-bupot-portal/bupot?x=1#y',
    'https://coretaxdjp.pajak.go.id:443/registration-portal/'
];
const refused = [
    '', null, undefined, 42, 'not a url', '/relative/path',
    'http://coretaxdjp.pajak.go.id/',                       // not https
    'https://coretaxdjp.pajak.go.id:8443/',                 // other port
    'https://coretaxdjp.pajak.go.id.evil.example/',         // suffix trick
    'https://evil.example/?u=https://coretaxdjp.pajak.go.id/',
    'https://evilcoretaxdjp.pajak.go.id/',
    'https://pajak.go.id/',
    'https://user:pass@coretaxdjp.pajak.go.id/',            // credentials
    'https://coretaxdjp.pajak.go.id@evil.example/',         // userinfo trick -> host evil.example
    'https:\\\\evil.example\\coretaxdjp.pajak.go.id',       // backslashes parse as host evil.example
    'javascript:alert(1)//https://coretaxdjp.pajak.go.id/',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'chrome://settings',
    'https://xn--coretaxdjp-xyz.pajak.go.id/'
];

let failed = 0;
for (const u of allowed) {
    if (isAllowedRedirect(u) === true) console.log('PASS allowed  ' + u);
    else { failed++; console.log('FAIL should be allowed: ' + u); }
}
for (const u of refused) {
    if (isAllowedRedirect(u) === false) console.log('PASS refused  ' + String(u));
    else { failed++; console.log('FAIL should be refused: ' + String(u)); }
}

// End to end through the URL parser the dispatcher uses (redirect arrives URL-encoded).
const enc = (r) => 'taxio-coretax://login?org=o&pic=p&token=t&redirect=' + encodeURIComponent(r);
try {
    assert.strictEqual(isAllowedRedirect(parseIncomingUrl(enc('https://coretaxdjp.pajak.go.id/returnsheets-portal/')).redirect), true);
    assert.strictEqual(isAllowedRedirect(parseIncomingUrl(enc('https://evil.example/')).redirect), false);
    console.log('PASS parsed deep link redirect');
} catch (e) { failed++; console.log('FAIL parsed deep link redirect\n' + e.stack); }

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
