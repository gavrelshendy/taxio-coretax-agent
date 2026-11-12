/* Lampiran printing: PDF buffers - printToPDF (adaptive scale), stamping a kop band on every
 * page, folding the PPN Induk's orphan page, dropping blank pages, merging. Split out of
 * automation/lampiran.js (still the public entry point). */
const { PDFDocument, PDFArray, decodePDFRawStream } = require('pdf-lib');
const { PRINT_SCALE } = require('./lampiran-config');

async function printPdf(session, scale = PRINT_SCALE) {
    const r = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, scale });
    return trimTrailingBlankPages(Buffer.from(r.data, 'base64'));
}

async function printAdaptivePdf(session, scale = PRINT_SCALE, enabled = false) {
    let bestScale = Number(scale) || PRINT_SCALE;
    let best = await printPdf(session, bestScale);
    let bestPages = (await PDFDocument.load(best)).getPageCount();
    if (!enabled || bestPages <= 1) return best;
    // Coba rapatkan sedikit hanya bila sebuah state benar-benar mengurangi jumlah lembar.
    // Jika jumlah lembar tetap, kembalikan ukuran awal agar teks tidak diperkecil sia-sia.
    for (const factor of [0.96, 0.92, 0.88]) {
        const candidateScale = Math.max(0.8, (Number(scale) || PRINT_SCALE) * factor);
        if (candidateScale >= bestScale - 0.001) continue;
        const candidate = await printPdf(session, candidateScale);
        const pages = (await PDFDocument.load(candidate)).getPageCount();
        if (pages < bestPages) {
            best = candidate;
            bestPages = pages;
            bestScale = candidateScale;
            if (pages === 1) break;
        }
    }
    return best;
}

async function stampHeaderOnPdf(contentBuffer, headerBuffer, bandHeight = 78) {
    const content = await PDFDocument.load(contentBuffer);
    const header = await PDFDocument.load(headerBuffer);
    const output = await PDFDocument.create();
    const sourceHeader = header.getPage(0);
    const sourceSize = sourceHeader.getSize();
    const cropHeight = Math.min(bandHeight, sourceSize.height);
    for (const sourcePage of content.getPages()) {
        const size = sourcePage.getSize();
        const page = output.addPage([size.width, size.height]);
        const embeddedContent = await output.embedPage(sourcePage);
        const embeddedHeader = await output.embedPage(sourceHeader, {
            left: 0, bottom: sourceSize.height - cropHeight, right: sourceSize.width, top: sourceSize.height
        });
        const scale = (size.height - cropHeight) / size.height;
        const contentWidth = size.width * scale;
        page.drawPage(embeddedContent, { x: (size.width - contentWidth) / 2, y: 0,
            width: contentWidth, height: size.height - cropHeight });
        page.drawPage(embeddedHeader, { x: 0, y: size.height - cropHeight, width: size.width, height: cropHeight });
    }
    return Buffer.from(await output.save());
}

/**
 * PDF Induk PPN resmi Coretax kadang menyisipkan satu halaman tengah yang hanya
 * memuat kelanjutan satu baris form (contoh: "Nama Pemilik Rekening"). Halaman
 * tersebut tidak boleh langsung dihapus karena walaupun kosong pada sebagian SPT,
 * nilainya dapat terisi pada SPT lain. Lipat pita atas halaman yatim ke ruang yang
 * sengaja dibuat di bawah halaman sebelumnya, lalu pertahankan halaman berikutnya.
 *
 * Deteksi dibuat konservatif dan khusus dipanggil untuk VAT_VAT: hanya halaman
 * tengah tanpa gambar, stream sangat kecil, dan maksimal enam operasi teks.
 */
async function compactPpnOfficialIndukPdf(buffer, bandHeight = 52) {
    const source = await PDFDocument.load(buffer);
    if (source.getPageCount() < 3) return buffer;
    const sparse = new Set();
    for (let index = 1; index < source.getPageCount() - 1; index++) {
        const content = decodedPageContent(source, source.getPage(index));
        if (content === null) continue;
        const textOps = (content.match(/(?:^|\s)(?:Tj|TJ)(?=\s|$)/gm) || []).length;
        const images = (content.match(/(?:^|\s)Do(?=\s|$)/gm) || []).length;
        const paints = (content.match(/(?:^|\s)(?:f\*?|F|S|s|B\*?|b\*?)(?=\s|$)/gm) || []).length;
        if (content.length <= 4000 && textOps <= 6 && images === 0 && paints <= 24) sparse.add(index);
    }
    if (!sparse.size) return buffer;

    const output = await PDFDocument.create();
    for (let index = 0; index < source.getPageCount(); index++) {
        if (sparse.has(index)) continue;
        const nextIndex = index + 1;
        if (sparse.has(nextIndex)) {
            const page = source.getPage(index), size = page.getSize();
            const orphan = source.getPage(nextIndex), orphanSize = orphan.getSize();
            const band = Math.min(Number(bandHeight) || 52, size.height * 0.08, orphanSize.height);
            const target = output.addPage([size.width, size.height]);
            const main = await output.embedPage(page);
            const strip = await output.embedPage(orphan, {
                left: 0, bottom: orphanSize.height - band, right: orphanSize.width, top: orphanSize.height
            });
            target.drawPage(main, { x: 0, y: band, width: size.width, height: size.height - band });
            target.drawPage(strip, { x: 0, y: 0, width: size.width, height: band });
            index = nextIndex;
            continue;
        }
        const [copied] = await output.copyPages(source, [index]);
        output.addPage(copied);
    }
    return Buffer.from(await output.save());
}

function pageContentStreams(pdf, page) {
    const contents = page.node.Contents();
    if (!contents) return [];
    const refs = contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents];
    return refs.map((ref) => pdf.context.lookup(ref)).filter(Boolean);
}

function decodedPageContent(pdf, page) {
    const chunks = [];
    for (const stream of pageContentStreams(pdf, page)) {
        try {
            if (typeof stream.getUnencodedContents === 'function') {
                chunks.push(Buffer.from(stream.getUnencodedContents()));
            } else if (stream.dict && stream.contents) {
                chunks.push(Buffer.from(decodePDFRawStream(stream).decode()));
            } else if (stream.contents) {
                chunks.push(Buffer.from(stream.contents));
            }
        } catch (error) {
            // Jika stream tidak dapat didekode, anggap berisi agar halaman tidak terhapus.
            return null;
        }
    }
    return Buffer.concat(chunks).toString('latin1');
}

function pageHasVisibleMarks(pdf, page) {
    const content = decodedPageContent(pdf, page);
    if (content === null) return true;
    if (!content.trim()) return false;
    const hasOperator = (operators) => new RegExp(
        '(?:^|[\\s\\[\\]<>()\\/])(?:' + operators + ')(?=[\\s\\[\\]<>()\\/]|$)', 'm'
    ).test(content);
    // Teks, gambar, dan shading selalu dipertahankan, sekecil apa pun stream-nya.
    if (hasOperator('Tj|TJ|Do|BI|sh|[\'\"]')) return true;

    // Chromium membuat halaman ekstra yang hanya berisi bidang putih. Path tetap
    // dianalisis karena garis/diagram nonputih tanpa teks adalah konten yang sah.
    const tokens = content.replace(/%[^\r\n]*/g, ' ').match(/\S+/g) || [];
    const stateStack = [];
    let fillWhite = false; // warna default PDF adalah hitam
    let strokeWhite = false;
    let numbers = [];
    const values = (count) => numbers.slice(-count).map(Number);
    const allFinite = (items) => items.length > 0 && items.every(Number.isFinite);
    for (const token of tokens) {
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
            numbers.push(token);
            if (numbers.length > 8) numbers = numbers.slice(-8);
            continue;
        }
        if (token === 'q') stateStack.push({ fillWhite, strokeWhite });
        else if (token === 'Q') {
            const previous = stateStack.pop();
            if (previous) ({ fillWhite, strokeWhite } = previous);
        } else if (token === 'rg' || token === 'RG') {
            const color = values(3);
            const white = allFinite(color) && color.every((value) => value >= 0.999);
            if (token === 'rg') fillWhite = white; else strokeWhite = white;
        } else if (token === 'g' || token === 'G') {
            const color = values(1);
            const white = allFinite(color) && color[0] >= 0.999;
            if (token === 'g') fillWhite = white; else strokeWhite = white;
        } else if (token === 'k' || token === 'K') {
            const color = values(4);
            const white = allFinite(color) && color.every((value) => Math.abs(value) <= 0.001);
            if (token === 'k') fillWhite = white; else strokeWhite = white;
        } else if (token === 'sc' || token === 'scn') fillWhite = false;
        else if (token === 'SC' || token === 'SCN') strokeWhite = false;
        else if (/^(?:f\*?|F)$/.test(token) && !fillWhite) return true;
        else if (/^(?:S|s)$/.test(token) && !strokeWhite) return true;
        else if (/^(?:B\*?|b\*?)$/.test(token) && (!fillWhite || !strokeWhite)) return true;
        numbers = [];
    }
    return false;
}

async function trimTrailingBlankPages(buffer) {
    const pdf = await PDFDocument.load(buffer);
    const blankIndexes = [];
    for (let index = 0; index < pdf.getPageCount(); index++) {
        if (!pageHasVisibleMarks(pdf, pdf.getPage(index))) blankIndexes.push(index);
    }
    // Halaman kosong dapat muncul di awal atau di tengah ketika custom element Angular
    // dipindahkan utuh oleh mesin print Chrome. Buang semua halaman yang benar-benar tidak
    // memiliki mark terlihat, tetapi pertahankan satu halaman jika dokumennya seluruhnya kosong.
    if (blankIndexes.length >= pdf.getPageCount()) blankIndexes.splice(1);
    if (!blankIndexes.length) return buffer;
    for (const index of blankIndexes.sort((a, b) => b - a)) pdf.removePage(index);
    return Buffer.from(await pdf.save());
}

async function mergePdfs(buffers) {
    const out = await PDFDocument.create();
    for (const buf of buffers) {
        const src = await PDFDocument.load(buf);
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    return Buffer.from(await out.save());
}

module.exports = { printPdf, printAdaptivePdf, stampHeaderOnPdf, compactPpnOfficialIndukPdf, decodedPageContent, pageHasVisibleMarks, trimTrailingBlankPages, mergePdfs };
