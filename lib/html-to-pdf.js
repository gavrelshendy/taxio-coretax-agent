/* Coretax Agent - renders a standalone HTML string (Coretax's "View Receipt"/BPE content, read
   verbatim from its <iframe srcdoc="...">) into an A4 PDF file.

   NOT a screenshot: the BPE content turned out to be a complete, self-contained HTML document
   (its own <title>, full inline CSS, an email-template-style layout) rather than something that
   needs pixel-capturing - confirmed by reading the live srcdoc during this feature's design.
   Rendering it as real vector text via a headless Chromium page produces a crisper, more
   reliable result than rasterizing a screenshot, and sidesteps needing to fit an arbitrary
   modal's on-screen size into an A4 page.

   Playwright's page.pdf() only works on a page running in Chromium HEADLESS mode - the
   automation's own visible window (headless:false, channel:'chrome', so the user can watch it
   work) can't do this directly. So this module owns one small, separate, lazily-launched
   headless Chromium instance dedicated to HTML->PDF rendering, reused across an entire run
   (launching a browser per receipt would be needlessly slow). */
const { chromium } = require('playwright');

let browserPromise = null;
function getBrowser() {
    if (!browserPromise) browserPromise = chromium.launch({ headless: true });
    return browserPromise;
}

/** Renders `html` (a full standalone document) to an A4 PDF at `outPath`. */
async function renderHtmlToPdf(html, outPath) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
        await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
    } finally {
        await page.close().catch(() => {});
    }
}

/** Call once when a whole run is done - closes the shared headless browser instead of leaving
 *  it running for the lifetime of the whole Coretax Agent process. */
async function closeRenderer() {
    if (!browserPromise) return;
    try { const b = await browserPromise; await b.close(); } catch (e) { /* already gone */ }
    browserPromise = null;
}

module.exports = { renderHtmlToPdf, closeRenderer };
