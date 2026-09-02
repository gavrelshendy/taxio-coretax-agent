const assert = require('assert');
const watchdog = require('../lib/coretax-watchdog');

const blacklist = ['ebupotbpa1', 'bpa1', 'ebupotmp', 'article-21-26-tax-return'];
const combinedReferenceUrl = 'https://coretaxdjp.pajak.go.id/referencedata/api/currentreferencedata/id-ID/PERIOD,COUNTRY_CODE,EBUPOTBPU_TAX_OBJECT,EBUPOTBPA1_TAX_OBJECT,EBUPOTMP_TAX_OBJECT,YES_NO';

assert.strictEqual(watchdog.isSafeSharedReferenceDataUrl(combinedReferenceUrl), true);
assert.strictEqual(watchdog.shouldBlockUrlByBlacklist(combinedReferenceUrl, blacklist), false);

assert.strictEqual(
    watchdog.shouldBlockUrlByBlacklist('https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotbpa1/issued', blacklist),
    true
);
assert.strictEqual(
    watchdog.shouldBlockUrlByBlacklist('https://coretaxdjp.pajak.go.id/withholding-slips-portal/id-ID/ebupotmp/issued', blacklist),
    true
);
assert.strictEqual(
    watchdog.shouldBlockUrlByBlacklist('https://coretaxdjp.pajak.go.id/article-21-26-tax-return/id-ID/search', blacklist),
    true
);

// A lookalike host must not gain the reference-data exemption.
assert.strictEqual(
    watchdog.isSafeSharedReferenceDataUrl('https://coretaxdjp.pajak.go.id.evil.test/referencedata/api/currentreferencedata/id-ID/EBUPOTBPA1_TAX_OBJECT'),
    false
);
assert.strictEqual(
    watchdog.shouldBlockUrlByBlacklist('https://coretaxdjp.pajak.go.id.evil.test/referencedata/api/currentreferencedata/id-ID/EBUPOTBPA1_TAX_OBJECT', blacklist),
    true
);

console.log(JSON.stringify({
    combinedReferenceAllowed: true,
    restrictedPortalStillBlocked: true,
    lookalikeHostRejected: true
}));
