/* Lampiran widget: installs the floating "Lampiran" widget in Coretax (binding + init script)
 * and builds its BPE - Induk - Lampiran package. Split out of automation/lampiran.js (still the
 * public entry point). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');
const htmlToPdf = require('./html-to-pdf');
const lampiranWidget = require('./lampiran-widget');
const returnsheetGridApi = require('./returnsheet-grid-api');
const { RETURNSHEET_API, ZERO_DOCUMENT_ID, TAXTYPE_CONFIG } = require('./lampiran-config');
const { mergePdfs } = require('./lampiran-print-pdf');
const { downloadLampiran } = require('./lampiran-download');

const watchedContexts = new WeakSet();

const WIDGET_PACKAGE_TOKENS = {
    ICT_WIT: 'SPT MASA PPH 21',
    ICT_WT: 'SPT MASA PPH UNIFIKASI',
    VAT_VAT: 'SPT MASA PPN',
    ICT_RCIT: 'SPT TAHUNAN PPH BADAN',
    ICT_PIT: 'SPT TAHUNAN PPH ORANG PRIBADI'
};

function widgetPeriodCode(row, taxTypeCode, taxYearHint) {
    if (TAXTYPE_CONFIG[taxTypeCode] && TAXTYPE_CONFIG[taxTypeCode].annual) {
        const hinted = String(taxYearHint || '').match(/(?:19|20)\d{2}/);
        if (hinted) return hinted[0];
        const fromRow = String(row && (row.TaxYear || row.TaxPeriodCode) || '').match(/(?:19|20)\d{2}/);
        return fromRow ? fromRow[0] : String(new Date().getFullYear());
    }
    const digits = String(row && row.TaxPeriodCode || '').replace(/\D/g, '');
    if (digits.length >= 6) return digits.slice(0, 2) + digits.slice(-2);
    if (digits.length === 4) return digits;
    return '';
}

function widgetPackageFilename(entityName, taxTypeCode, mode, periodCode) {
    return require('../lib/spt-filenames').filename(taxTypeCode,periodCode,mode==='print'?'Ringkas':mode==='confidential'?'Confidential':'Lengkap','','pdf',entityName);
}

function widgetComponentFilename(entityName, taxTypeCode, component, periodCode, revision='') {
    return require('../lib/spt-filenames').filename(taxTypeCode,periodCode,component==='INDUK'?'Induk':component,revision,'pdf',entityName);
}

async function findWidgetReturnRow(page, taxpayerId, recordId, taxTypeCode, aggregateId) {
    const batchSize = 100;
    for (let first = 0, guard = 0; guard++ < 100; first += batchSize) {
        const body = {
            TaxpayerAggregateIdentifier: taxpayerId, isArchieved: false, First: first, Rows: batchSize,
            SortField: '', SortOrder: 1,
            Filters: [{ PropertyName: 'TaxTypeCode', Value: [taxTypeCode], MatchMode: 'contains', CaseSensitive: true, AsString: false }],
            LanguageId: 'id-ID'
        };
        const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/returnsheetssubmitted', body);
        if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
            throw new Error('Daftar SPT untuk BPE/Induk gagal dibaca (HTTP ' + (response && response.status || 0) + ').');
        }
        const rows = response.json.Payload && Array.isArray(response.json.Payload.Data) ? response.json.Payload.Data : [];
        const found = rows.find((row) => String(row.RecordId || row.ReturnSheetRecordIdentifier || '') === String(recordId || '')
            || String(row.AggregateIdentifier || '') === String(aggregateId || ''));
        if (found) return found;
        if (rows.length < batchSize) break;
    }
    throw new Error('Data induk SPT yang sedang dibuka tidak ditemukan pada backend Coretax.');
}

async function fetchWidgetInduk(page, taxpayerId, row) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        DocumentAggregateIdentifier: row.DocumentFormAggregateIdentifier || ZERO_DOCUMENT_ID,
        TaxpayerAggregateIdentifier: taxpayerId,
        LetterNumber: row.ReturnSheetNumber,
        DocumentDate: String(row.LastUpdatedDate || '').slice(0, 19),
        IsReceipt: false,
        SignParameter: null
    };
    const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/downloadreturnsheet/download-returnsheet-document', body);
    if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false) {
        throw new Error('Induk gagal diunduh (HTTP ' + (response && response.status || 0) + ').');
    }
    if (response.json.Payload && response.json.Payload.IsError) {
        throw new Error('Induk belum siap diunduh: ' + (response.json.Payload.ErrorMessage || 'dokumen masih dibuat Coretax') + '.');
    }
    if (!response.json.Content) throw new Error('Induk tidak dikembalikan oleh Coretax.');
    return Buffer.from(response.json.Content, 'base64');
}

async function fetchWidgetBpe(page, taxpayerId, row) {
    const body = {
        ReturnSheetRecordIdentifier: row.RecordId,
        ReturnSheetAggregateIdentifier: row.AggregateIdentifier,
        TaxpayerAggregateIdentifier: taxpayerId
    };
    const response = await returnsheetGridApi.authenticatedPost(page, RETURNSHEET_API + '/downloadreturnsheet/view-receipt', body);
    if (!response || response.status !== 200 || !response.json || response.json.IsSuccessful === false || !response.json.Payload) return null;
    const tempPath = path.join(os.tmpdir(), 'coretax-agent-widget-bpe-' + process.pid + '-' + Date.now() + '.pdf');
    try {
        await htmlToPdf.renderHtmlToPdf(response.json.Payload, tempPath);
        return fs.readFileSync(tempPath);
    } finally {
        try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch (_) {}
    }
}

async function downloadWidgetSptPackage(page, ctx, taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout, lampiranFormat = 'pdf') {
    require('../lib/spt-access').assertAllowed(taxTypeCode,ctx,page);
    const row = await findWidgetReturnRow(page, taxpayerId, recordId, taxTypeCode, aggregateId);
    const revision=row.ReturnSheetModel?.match(/(?:amendment|pembetulan)\s+(\d+)/i)?.[1];
    ctx = { ...ctx, lampiranFormat, fileSuffix: revision ? 'PB '+revision : '' };
    const lampiranCtx = outputLayout === 'combined' ? { ...ctx, compFolder: null } : ctx;
    const lampiranResult = await downloadLampiran(page, lampiranCtx, taxpayerId, recordId, taxTypeCode, mode, taxYearHint, outputLayout);
    if (!lampiranResult || !lampiranResult.ok) return lampiranResult;
    const periodCode = widgetPeriodCode(row, taxTypeCode, taxYearHint);
    const [bpeBuffer, rawIndukBuffer] = await Promise.all([
        fetchWidgetBpe(page, taxpayerId, row).catch((error) => { log('[Lampiran widget] BPE tidak tersedia - ' + error.message + ' - dilewati.'); return null; }),
        fetchWidgetInduk(page, taxpayerId, row)
    ]);
    const indukBuffer = rawIndukBuffer;
    if (outputLayout === 'combined' && lampiranFormat !== 'excel') {
        if (!lampiranResult.combinedPath || !fs.existsSync(lampiranResult.combinedPath)) throw new Error('PDF lampiran gabungan tidak ditemukan.');
        const ordered = [...(bpeBuffer ? [bpeBuffer] : []), indukBuffer, fs.readFileSync(lampiranResult.combinedPath)];
        const finalPath = path.join(lampiranResult.dir, require('../lib/spt-filenames').filename(taxTypeCode,periodCode,mode==='print'?'Ringkas':mode==='confidential'?'Confidential':'Lengkap',row.ReturnSheetModel?.match(/(?:amendment|pembetulan)\s+(\d+)/i)?.[1],'pdf',lampiranResult.entityKey||lampiranResult.entityName));
        fs.writeFileSync(finalPath, await mergePdfs(ordered));
        try { fs.rmSync(lampiranResult.combinedPath, { force: true }); } catch (_) {}
        if (ctx.compFolder) {
            fs.mkdirSync(ctx.compFolder, { recursive: true });
            fs.copyFileSync(finalPath, path.join(ctx.compFolder, path.basename(finalPath)));
        }
        log('[Lampiran widget] Tersimpan paket BPE - Induk - Lampiran: ' + finalPath);
        const extras = lampiranResult.paths.filter(file => /\.xlsx$/i.test(file));
        if (ctx.compFolder) for (const file of extras) fs.copyFileSync(file, path.join(ctx.compFolder, path.basename(file)));
        return { ...lampiranResult, count: 1 + extras.length, paths: [finalPath, ...extras], combinedPath: finalPath, bpeIncluded: !!bpeBuffer, indukIncluded: true };
    }
    const extraPaths = [];
    if (bpeBuffer) {
        const bpePath = path.join(lampiranResult.dir, widgetComponentFilename(lampiranResult.entityKey || lampiranResult.entityName, taxTypeCode, 'BPE', periodCode, revision));
        fs.writeFileSync(bpePath, bpeBuffer); extraPaths.push(bpePath);
    }
    const indukPath = path.join(lampiranResult.dir, widgetComponentFilename(lampiranResult.entityKey || lampiranResult.entityName, taxTypeCode, 'INDUK', periodCode, revision));
    fs.writeFileSync(indukPath, indukBuffer); extraPaths.push(indukPath);
    if (ctx.compFolder) for (const filePath of extraPaths) {
        fs.mkdirSync(ctx.compFolder, { recursive: true });
        fs.copyFileSync(filePath, path.join(ctx.compFolder, path.basename(filePath)));
    }
    log('[Lampiran widget] Tersimpan terpisah: ' + extraPaths.map((filePath) => path.basename(filePath)).join(', '));
    return { ...lampiranResult, count: lampiranResult.count + extraPaths.length, paths: [...extraPaths, ...lampiranResult.paths], bpeIncluded: !!bpeBuffer, indukIncluded: true };
}

const widgetBindings = new WeakMap(); // browserContext -> { ctx, page } yang dipakai binding tunggal
async function installLampiranWidget(page, { saveRoot, entityCode, compFolder, restricted }) {
    const ctx = { saveRoot: saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), entityCode, compFolder, restricted };
    const browserContext = page.context();
    // Sumber data grid lengkap ditangkap pasif sejak sebelum halaman SPT dibuka. Header
    // autentikasi hanya disimpan di memori proses dan tidak pernah ditulis ke log/fixture.
    returnsheetGridApi.watchContext(browserContext);
    // exposeFunction hanya boleh SEKALI per context. Jendela Chrome yang dipakai ulang (ganti
    // PIC/entitas) dulu memasangnya lagi -> galat "already registered" dan binding lama tetap
    // memakai entitas/folder lama. Sekarang binding dipasang sekali dan keadaannya diperbarui.
    const existing = widgetBindings.get(browserContext);
    if (existing) { existing.ctx = ctx; existing.page = page; }
    else {
        const state = { ctx, page };
        widgetBindings.set(browserContext, state);
        try { await browserContext.exposeFunction('__ca_downloadSptPackageV1150', (taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout, lampiranFormat) => {
            log('[Lampiran engine v1.15.0-final] Binding paket aktif untuk ' + taxTypeCode + ' mode ' + mode + ', output ' + outputLayout + '.');
            // Cari tab yang benar saat tombol diklik. `page` awal dapat berbeda karena Coretax bisa
            // membuka form SPT pada tab baru setelah widget pertama kali dipasang.
            const active = browserContext.pages().find(p => !p.isClosed() && p.url().includes(String(taxpayerId)) && p.url().includes(String(recordId)))
                || browserContext.pages().find(p => !p.isClosed() && /\/(corporate-income-tax-return|personal-income-tax-return|article-21-26-tax-return|withholding-tax-return|value-added-tax-return)\//i.test(p.url())) || state.page;
            return downloadWidgetSptPackage(active, state.ctx, taxpayerId, recordId, aggregateId, taxTypeCode, mode, taxYearHint, outputLayout, lampiranFormat);
        }); } catch (e) { widgetBindings.delete(browserContext); log('[Lampiran engine v1.15.0-final] Gagal memasang binding baru: ' + e.message); }
    }
    const script = lampiranWidget.buildLampiranWidgetScript(require('../lib/spt-access').isRestricted(restricted));
    try { await browserContext.addInitScript({ content: script }); }
    catch (e) { log('[Lampiran] Gagal memasang init script: ' + e.message); }

    const applyToPage = async (targetPage) => {
        if (!targetPage || targetPage.isClosed()) return;
        try { await targetPage.evaluate(script); }
        catch (e) { log('[Lampiran] Gagal memasang widget pada tab ' + targetPage.url() + ': ' + e.message); }
    };
    // Pasang pada SEMUA tab yang sudah ada, bukan hanya tab yang dipakai saat login.
    await Promise.all(browserContext.pages().map(applyToPage));
    if (!watchedContexts.has(browserContext)) {
        watchedContexts.add(browserContext);
        // Coretax dapat membuka view SPT di tab baru. addInitScript adalah lapisan pertama;
        // evaluasi eksplisit setelah DOM siap menjadi lapisan pemulihan jika init script pernah
        // terlewat pada context hasil reconnect/reuse.
        browserContext.on('page', (newPage) => {
            newPage.once('domcontentloaded', () => applyToPage(newPage));
            setTimeout(() => applyToPage(newPage), 1500);
        });
    }
    log('[Lampiran] Widget siap pada ' + browserContext.pages().length + ' tab Coretax.');
}

module.exports = { widgetPeriodCode, widgetPackageFilename, widgetComponentFilename, downloadWidgetSptPackage, installLampiranWidget };
