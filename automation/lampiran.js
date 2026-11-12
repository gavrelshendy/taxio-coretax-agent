/* Coretax Agent - cetak lampiran SPT langsung dari tampilan Coretax melalui CDP. */
// The code lives in lib/lampiran-*.js, split by responsibility (see each file's header); this file
// stays the public entry point with the same exports, so callers keep requiring it.
const { TAXTYPE_CONFIG, PPN_API_GRIDS } = require('../lib/lampiran-config');
const { waitForTabLabels, clickTab, detectYear, detectActiveTaxpayerName } = require('../lib/lampiran-page');
const { preparePageForPrint } = require('../lib/lampiran-print-prep');
const { stampHeaderOnPdf, compactPpnOfficialIndukPdf, decodedPageContent, pageHasVisibleMarks, trimTrailingBlankPages, mergePdfs } = require('../lib/lampiran-print-pdf');
const { resetPaginators, paginatorIds, setActivePaginatorOwner, clearPaginatorOwners, printL1SnapshotPages, printAnnualDomPages, printPpnDomPages, printPaginatorPages } = require('../lib/lampiran-print-paginator');
const { replaceAnnualSnapshotRows, printAnnualApiPages, replaceUnifikasiSnapshotRows, printUnifikasiApiPages, replacePpnSnapshotRows, printPpnApiPages, replacePph21SnapshotWithOverview, printPph21ConfidentialOverview } = require('../lib/lampiran-print-api');
const { summarizePph21Grids, collectPph21ConfidentialSummary, sptStatus, downloadLampiran } = require('../lib/lampiran-download');
const { widgetPeriodCode, widgetPackageFilename, widgetComponentFilename, downloadWidgetSptPackage, installLampiranWidget } = require('../lib/lampiran-widget-package');

module.exports = {
    installLampiranWidget, downloadLampiran, mergePdfs, compactPpnOfficialIndukPdf,
    TAXTYPE_CONFIG, sptStatus, detectActiveTaxpayerName, preparePageForPrint,
    __test: { waitForTabLabels, clickTab, trimTrailingBlankPages, pageHasVisibleMarks, decodedPageContent, paginatorIds, printPaginatorPages,
        resetPaginators, setActivePaginatorOwner, clearPaginatorOwners, summarizePph21Grids,
        collectPph21ConfidentialSummary, replacePph21SnapshotWithOverview, printPph21ConfidentialOverview,
        replaceUnifikasiSnapshotRows, printUnifikasiApiPages, replacePpnSnapshotRows, printPpnApiPages,
        replaceAnnualSnapshotRows, printAnnualApiPages,
        printAnnualDomPages, printPpnDomPages, printL1SnapshotPages, stampHeaderOnPdf,
        compactPpnOfficialIndukPdf, detectYear, mergePdfs,
        PPN_API_GRIDS, widgetPeriodCode, widgetPackageFilename, widgetComponentFilename, downloadWidgetSptPackage }
};
