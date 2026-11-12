/* Lampiran download: downloadLampiran - every tab read (grid API or paginator) and rendered by
 * lib/lampiran-export.js, or the Confidential PPh 21 summary. Split out of automation/lampiran.js
 * (still the public entry point). */
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { sanitizeFilenamePart } = require('./datatable');
const returnsheetGridApi = require('./returnsheet-grid-api');
const { TAXTYPE_CONFIG, PPH21_API_GRIDS, PPH21_LAMPIRAN_TITLES } = require('./lampiran-config');
const { waitForTabLabels, clickTab, waitForTabContentStable, setUpTables, detectTaxPeriod, detectActiveTaxpayerTin, detectActiveTaxpayerName } = require('./lampiran-page');

function summarizePph21Grids(grids) {
    return (Array.isArray(grids) ? grids : []).reduce((summary, grid) => {
        const rows = Array.isArray(grid && grid.rows) ? grid.rows : [];
        summary.count += Number.isFinite(Number(grid && grid.total)) ? Number(grid.total) : rows.length;
        for (const row of rows) {
            const grossIncome = Number(row && row.GrossIncome);
            const incomeTax = Number(row && row.IncomeTax);
            if (Number.isFinite(grossIncome)) summary.grossIncome += grossIncome;
            if (Number.isFinite(incomeTax)) summary.incomeTax += incomeTax;
        }
        return summary;
    }, { count: 0, grossIncome: 0, incomeTax: 0 });
}

async function collectPph21ConfidentialSummary(page, tabLabel) {
    const suffixes = PPH21_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const summary = summarizePph21Grids(grids);
    return { code: tabLabel, title: PPH21_LAMPIRAN_TITLES[tabLabel] || tabLabel, ...summary };
}

function filename(entity, config, label, periodLabel, revision='') {
    const code=Object.keys(TAXTYPE_CONFIG).find(key=>TAXTYPE_CONFIG[key]===config);
    const mode=/Rahasia|Confidential/i.test(label)?'Confidential':/Ringkas|Print/i.test(label)?'Ringkas':'Lengkap';
    const section=label.replace(/GABUNGAN|\((?:Rahasia|Confidential|Ringkas|Print|Lengkap)\)/gi,'').trim();
    return require('../lib/spt-filenames').filename(code,periodLabel,'Lampiran'+(section?' '+section:'')+' - '+mode,revision,'pdf',entity);
}

/** The kop's NORMAL/PEMBETULAN box, from the revision suffix the caller names the files with
 *  ("PB 2" = Pembetulan ke-2); '' when the caller did not say. */
function sptStatus(fileSuffix) {
    const m = String(fileSuffix ?? '').match(/PB\s*(\d+)/i);
    return m ? 'PEMBETULAN ' + m[1] : fileSuffix === undefined ? '' : 'NORMAL';
}

/** Reader of `label`'s rows from Coretax's grid API for lib/lampiran-capture.js collectTabFromRows, or
 *  null when that lampiran has no API mapping (or it was turned off). */
// Literal requires: pkg only bundles modules it can see by name (a require(variable) is left out of
// the exe, which would silently put every lampiran back on the paginator).
const LAMPIRAN_API = {
    ICT_WIT: { load: () => require('../lib/lampiran-api-pph21'), env: 'CORETAX_PPH21_API' },
    ICT_WT: { load: () => require('../lib/lampiran-api-unifikasi'), env: 'CORETAX_UNIFIKASI_API' },
    VAT_VAT: { load: () => require('../lib/lampiran-api-ppn'), env: 'CORETAX_PPN_API' },
    // SPT Tahunan (Badan, OP), setiap lampiran: tabel yang berhalaman (dan L3/L4/L9/L10-A Badan) dari
    // API, tabel yang sudah tampil utuh dibaca dari layar; format kolom dikalibrasi dari halaman 1.
    // Tanpa mengatur ukuran halaman dulu: itu memakan waktu (L9 MERATUS LINE 79 dtk untuk 12 tabel) dan
    // kebenaran tidak bergantung padanya - pilihan field yang ambigu tetap diuji di SEMUA baris.
    ICT_RCIT: { load: () => require('../lib/lampiran-api-cit'), env: 'CORETAX_CIT_API', anyTables: true, setUp: false, allLabels: true },
    ICT_PIT: { load: () => require('../lib/lampiran-api-cit'), env: 'CORETAX_PIT_API', anyTables: true, setUp: false, allLabels: true }
};
function lampiranApiReader(page, taxTypeCode, label) {
    const spec = LAMPIRAN_API[taxTypeCode];
    if (!spec || process.env[spec.env] === '0') return null;
    const reader = spec.load(), grids = reader.GRIDS[label] || (spec.allLabels ? [] : null);
    if (!grids) return null;
    return { tables: spec.anyTables ? null : Array.isArray(grids) ? grids.length : 1, setUp: !!spec.setUp,
        rows: (headers, index, shown) => reader.displayRows(page, label, headers, index, shown) };
}

async function downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode, mode, taxYearHint = '', outputLayout = 'combined') {
    require('../lib/spt-access').assertAllowed(taxTypeCode,ctx,page);
    if (!TAXTYPE_CONFIG[taxTypeCode]) return { ok: false, error: 'Jenis SPT ini belum didukung.' };
    mode = ['full', 'confidential'].includes(mode) ? mode : 'print';
    outputLayout = ['combined', 'separate', 'both'].includes(outputLayout) ? outputLayout : 'combined';
    if (mode === 'confidential' && taxTypeCode !== 'ICT_WIT') {
        return { ok: false, error: 'Mode rahasia saat ini hanya tersedia untuk PPh 21/26.' };
    }
    const format = ['pdf', 'excel', 'both'].includes(ctx.lampiranFormat) ? ctx.lampiranFormat : 'pdf';
    if(mode==='confidential'&&format==='pdf'){
        try{
            const config=TAXTYPE_CONFIG[taxTypeCode],period=await detectTaxPeriod(page,config);
            const entity=sanitizeFilenamePart(ctx.entityName||await detectActiveTaxpayerName(page)||ctx.entityCode||'SPT');
            const dir=ctx.outputDir||path.join(ctx.saveRoot,entity,'SPT',String(period.year));fs.mkdirSync(dir,{recursive:true});
            const labels=await waitForTabLabels(page),summaries=[];
            for(const label of ['L-IA','L-IB','L-II','L-III']){
                if(!labels.includes(label)||!await clickTab(page,label))throw Error('Lampiran Confidential tidak dapat dibuka: '+label);
                await waitForTabContentStable(page,config.rootSelector);
                summaries.push(await collectPph21ConfidentialSummary(page,label));
            }
            const stem=require('../lib/spt-filenames').filename(taxTypeCode,period.fileLabel,'Lampiran - Confidential',ctx.fileSuffix,'',ctx.entityCode||entity);
            const result=await require('../lib/lampiran-confidential').renderConfidential(summaries,{entity,entityNpwp:ctx.entityNpwp||await detectActiveTaxpayerTin(page),status:sptStatus(ctx.fileSuffix),period:period.headerLabel,title:config.title,taxTypeCode},{dir,stem,outputLayout});
            if(ctx.compFolder){fs.mkdirSync(ctx.compFolder,{recursive:true});for(const file of result.paths)fs.copyFileSync(file,path.join(ctx.compFolder,path.basename(file)));}
            await clickTab(page,'L-IA');
            return {ok:true,count:result.paths.length,paths:result.paths,combinedPath:result.combinedPath,dir,entityName:entity,entityKey:ctx.entityCode||entity,period,mode,outputLayout};
        }catch(e){return {ok:false,error:e.message};}
    }
    // The Confidential PDF case returned above; every other combination is rebuilt from the
    // captured tab HTML by lib/lampiran-export.js.
    try {
        const config = TAXTYPE_CONFIG[taxTypeCode];
        const period = config.annual && /^(19|20)\d{2}$/.test(String(taxYearHint))
            ? { year: taxYearHint, fileLabel: taxYearHint, headerLabel: 'Tahun ' + taxYearHint }
            : await detectTaxPeriod(page, config);
        const entity = sanitizeFilenamePart(ctx.entityName || await detectActiveTaxpayerName(page) || ctx.entityCode || 'SPT');
        const dir = ctx.outputDir || path.join(ctx.saveRoot, entity, 'SPT', String(period.year));
        fs.mkdirSync(dir, { recursive: true });
        // CORETAX_LAMPIRAN_TRACE=1: how long each step of each tab takes (diagnosis of a slow tab).
        // A table that remembers another page or a filter (Coretax's grid-state in localStorage) is
        // read wrong - by the API check and by the page-by-page path alike: start over from page 1.
        if (await returnsheetGridApi.resetGridState(page)) {
            log('[Lampiran] Posisi halaman/filter tabel yang tersimpan di Coretax dikembalikan ke halaman 1 - halaman SPT dimuat ulang.');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        }
        const traceOn = process.env.CORETAX_LAMPIRAN_TRACE === '1';
        let traceAt = Date.now();
        const trace = (what) => { if (traceOn) { log('[Lampiran trace] ' + what + ': ' + (Date.now() - traceAt) + ' ms'); traceAt = Date.now(); } };
        const labels = (await waitForTabLabels(page)).filter(label => !/^induk$/i.test(label) && (!ctx.onlyLabels?.length || ctx.onlyLabels.includes(label)));
        trace('daftar tab');
        if (!labels.length) throw new Error('Lampiran belum tersedia.');
        const tabs = [],confidentialSummaries=[];
        for (const label of labels) {
            if (!await clickTab(page, label)) throw new Error('Lampiran tidak dapat dibuka: ' + label + (clickTab.lastFailure ? ' (' + clickTab.lastFailure + ')' : ''));
            trace(label + ' klik tab');
            await waitForTabContentStable(page, config.rootSelector);
            trace(label + ' tunggu isi stabil');
            // Rows straight from Coretax's grid API, checked against the tables on screen; any table
            // that disagrees (or a code/column without a proven mapping) falls back to the paginator.
            // On by default since 2026-10-19 (user: "kalo emang bisa dan lebih cepat gas gaperlu
            // paginator"); CORETAX_<PPH21|UNIFIKASI|PPN>_API=0 turns one off.
            let tab = null;
            const apiReader = lampiranApiReader(page, taxTypeCode, label);
            if (apiReader) {
                try {
                    if (apiReader.setUp) {
                        await setUpTables(page, label, 'full', taxTypeCode);
                        await waitForTabContentStable(page, config.rootSelector, { minWaitMs: 700, timeoutMs: 8000 });
                        trace(label + ' atur ukuran halaman');
                    }
                    tab = await require('../lib/lampiran-capture').collectTabFromRows(page, config.rootSelector, label, apiReader.rows, apiReader.tables);
                    log('[Lampiran] ' + label + ': ' + tab.tables.map((t) => t.collectedRows).join(' + ') + ' baris diambil dari API Coretax, cocok dengan tampilan.');
                } catch (e) {
                    if (e && e.isStop) throw e;
                    // A tab whose tables all fit on screen needs no API: read as before, nothing to report.
                    if (/tidak ada tabel yang diambil lewat API/.test(e.message)) apiReader.benign = true;
                    if (!/tidak ada tabel yang diambil lewat API/.test(e.message)) log('[Lampiran] ' + label + ': API tidak dipakai (' + e.message + ') - tabel dibaca halaman demi halaman.');
                }
                trace(label + ' baca lewat API');
            }
            // Diagnosis only (CORETAX_API_ONLY=1): stop at the API's reason instead of paging for minutes.
            if (!tab && process.env.CORETAX_API_ONLY === '1' && apiReader && !apiReader.benign) throw new Error(label + ': API ditolak (CORETAX_API_ONLY) - lihat log');
            if (!tab) {
                await setUpTables(page, label, 'full', taxTypeCode);
                await waitForTabContentStable(page, config.rootSelector, { minWaitMs: 700, timeoutMs: 8000 });
                trace(label + ' atur ukuran halaman (paginator)');
                tab = await require('../lib/lampiran-capture').collectTab(page, config.rootSelector, label);
                trace(label + ' baca halaman demi halaman');
            }
            tabs.push(tab);
            if(ctx.returnSheets&&taxTypeCode==='ICT_WIT'&&PPH21_API_GRIDS[label]){try{confidentialSummaries.push(await collectPph21ConfidentialSummary(page,label));}catch(e){log('[Lampiran] Ringkasan Confidential '+label+' gagal dibaca: '+e.message);}}
            log('[Lampiran] ' + label + ': seluruh tabel berhasil dibaca.');
        }
        // (named after Taxio's entity code when there is one, else the taxpayer's name - see lib/spt-filenames.js)
        const stem = require('../lib/spt-filenames').filename(taxTypeCode,period.fileLabel,'Lampiran - '+(mode==='print'?'Ringkas':'Lengkap'),ctx.fileSuffix,'',ctx.entityCode||entity);
        const entityNpwp = ctx.entityNpwp || await detectActiveTaxpayerTin(page);
        // A table over 1.000 rows is too large for a PDF form (lib/lampiran-big-table.js): the PDF keeps
        // its first rows (Lengkap 1.000, Ringkas 50) and every row goes onto its own sheet of the
        // lampiran's Excel, which is then made even for a PDF-only request. Not for A1 (returnSheets:
        // its recap reads every row from the render) nor Rahasia.
        const bigTable = require('../lib/lampiran-big-table');
        const bigLists = ctx.returnSheets || mode === 'confidential' ? [] : bigTable.splitBigTables(tabs, mode === 'print' ? bigTable.SHOWN_ROWS : bigTable.BIG_ROWS);
        for (const tab of tabs) for (const t of tab.tables || []) { delete t.rows; delete t.headers; }
        const meta = { entity, entityNpwp, status: sptStatus(ctx.fileSuffix), period: period.headerLabel, title: config.title, taxTypeCode };
        const result = await require('../lib/lampiran-export').renderTabs(tabs, meta, {
            mode: mode === 'confidential' ? 'full' : mode, format: mode === 'confidential' ? 'excel' : format, dir, stem, outputLayout,renderSession:ctx.renderSession,layoutStyle:ctx.layoutStyle, bigLists
        });
        const { money } = require('../lib/id-number');
        for (const list of bigLists) log('[Lampiran] ' + list.label + ': ' + money(list.rows.length) + ' baris (lebih dari ' + money(bigTable.BIG_ROWS) + ') - PDF memuat baris 1–' + money(list.shown) + '; seluruh baris di sheet "' + list.sheetName + '" pada ' + path.basename(result.excelPath || ''));
        if (mode === 'confidential' && format === 'both') {
            const pdf = await downloadLampiran(page, { ...ctx, lampiranFormat: 'pdf' }, taxpayerId, recordId, taxTypeCode, mode, taxYearHint, outputLayout);
            if (!pdf.ok) throw new Error(pdf.error);
            result.paths.push(...pdf.paths); result.combinedPath = pdf.combinedPath;
        }
        if (ctx.compFolder) { fs.mkdirSync(ctx.compFolder, { recursive: true }); for (const file of result.paths) fs.copyFileSync(file, path.join(ctx.compFolder, path.basename(file))); }
        if(!ctx.returnSheets)await clickTab(page, labels[0]);
        return { ok: true, confidentialSummaries, count: result.paths.length, paths: result.paths, combinedPath: result.combinedPath, excelPath: result.excelPath, sheets: ctx.returnSheets ? result.sheets : undefined, dir, entityName: entity, entityKey: ctx.entityCode || entity, period, mode, outputLayout };
    } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { summarizePph21Grids, collectPph21ConfidentialSummary, sptStatus, downloadLampiran };
