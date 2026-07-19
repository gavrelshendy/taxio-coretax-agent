/* TEMPORARY - tests the new crosscheck feature end-to-end: create case, import (auto-generates
   control file), then also run the standalone Cek Hasil (runDividenCheck) against the same case,
   and print both control files' Ringkasan Perbandingan sheet for inspection.
   Run: node dev-e2e-crosscheck-test.js */
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');
const chrome = require('./lib/chrome');
const dividen = require('./automation/dividen');

const TEST_FILE = path.join(__dirname, 'Test Impor Dividen - Coretax Agent.xlsx');

async function dumpControlFile(p) {
    console.log('--- Reading control file:', p, '---');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const sum = wb.getWorksheet('Ringkasan Perbandingan');
    for (let r = 1; r <= sum.rowCount; r++) console.log(r, JSON.stringify(sum.getRow(r).values));
}

(async () => {
    const userDataDir = path.join(chrome.PROFILE_ROOT, '_manual');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, channel: 'chrome', viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    const page = context.pages()[0] || await context.newPage();

    console.log('=== Checking login ===');
    await page.goto(chrome.CORETAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
        if (!chrome.isLoggedOut(page)) { loggedIn = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('Login:', loggedIn);
    if (!loggedIn) { await context.close(); return; }

    console.log('=== Creating new case ===');
    await dividen.openNewCase(page, (m) => console.log('  [nav] ' + m));
    console.log('Case URL:', page.url());

    const fileBuffer = fs.readFileSync(TEST_FILE);
    console.log('=== Import (with auto control-file) ===');
    let importControlPath = null;
    const origLog = require('./lib/log').log;
    // Capture the logged control-file path (runDividenImport logs it, doesn't return it directly)
    const logs = [];
    const unsub = require('./lib/log').onLogLine((e) => { logs.push(e.line || e.msg || ''); });
    try {
        await dividen.runDividenImport({ manualPage: page, fileBuffer });
    } catch (e) { console.log('Import error:', e.message); }
    unsub();
    const pathLine = logs.find((l) => /File pembanding tersimpan:/.test(l));
    if (pathLine) importControlPath = pathLine.split('File pembanding tersimpan:')[1].trim();
    console.log('Import auto control file:', importControlPath);
    if (importControlPath && fs.existsSync(importControlPath)) await dumpControlFile(importControlPath);

    console.log('=== Standalone Cek Hasil ===');
    const checkPath = await dividen.runDividenCheck({ manualPage: page, fileBuffer });
    console.log('Cek Hasil control file:', checkPath);
    if (checkPath && fs.existsSync(checkPath)) await dumpControlFile(checkPath);

    console.log('Done.');
})().catch((e) => console.error('Failed:', e.stack || e));
