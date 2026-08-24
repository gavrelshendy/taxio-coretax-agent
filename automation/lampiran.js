/* Coretax Agent - "Unduh Lampiran Lengkap" (PDF identik dengan tampilan Coretax asli).

   KONTEKS (live investigation 2026-08-21, entitas PT Taka Oozora Semesta, PPh Badan 2025):
   Coretax TIDAK PERNAH menyediakan PDF untuk Lampiran (L1-A, L2, L4, L6, L8, L11-B, dst) - hanya
   Induk (via automation/spt.js -> download-returnsheet-document). Lampiran cuma bisa dilihat
   sebagai halaman web interaktif (klik ikon "mata" di listing SPT, tab Induk/L1-A/L2/dst di
   atas), sebelumnya harus di-screenshot manual satu per satu.

   PERCOBAAN PERTAMA (dibuang): rekonstruksi HTML sendiri dari JSON prefillreturnsheet/
   corporate-income - JAUH dari identik (label bahasa Inggris hasil scrape sementara Coretax
   user bisa dalam Bahasa Indonesia, struktur kotak-dalam-kotak untuk tree neraca, kehilangan
   radio button/kotak hint biru "Ya, silahkan mengisi Lampiran X"). User eksplisit minta
   "identik, bukan mendekati".

   PENDEKATAN FINAL (jauh lebih baik + lebih sederhana): CETAK HALAMAN CORETAX YANG
   SESUNGGUHNYA ke PDF lewat CDP `Page.printToPDF`, bukan rekonstruksi data. CONFIRMED LIVE:
   walau window otomasi berjalan headed (headless:false, supaya user bisa lihat), CDP
   printToPDF tetap jalan pada halaman headed (beda dengan Playwright's page.pdf() yang
   didokumentasikan cuma untuk Chromium headless - ternyata utuh berfungsi via CDP langsung).
   Hasilnya PIXEL-IDENTIK dengan apa yang user lihat di layar - bahasa apa pun, radio
   button/hint box asli, tanpa perlu tahu apa pun soal skema field Coretax.

   Form 1771 punya beberapa TAB (Induk, L1-A, L2, L4, L6, L8, L11-B) - tiap tab di-klik satu per
   satu, di-print terpisah (CDP cuma nangkep apa yang VISIBLE saat itu - panel tab lain yang
   hidden via CSS tidak ikut kecetak meski ada di DOM), lalu digabung jadi satu PDF pakai
   pdf-lib (pure JS, aman untuk pkg).

   Pemicu unduhan: widget di halaman (lib/lampiran-widget.js) - tombol mengambang persis pola
   tombol "Salin Passphrase" yang sudah ada (coretax-watchdog.js), BUKAN lewat menu GUI Coretax
   Agent - permintaan eksplisit user supaya alurnya tidak "lewat mana-mana".

   Baru dibangun untuk PPh Badan (ICT_RCIT / corporate-income-tax-return). SPT OP (1770) belum
   diverifikasi live - URL pattern-nya kemungkinan beda, JANGAN diasumsikan sama tanpa
   investigasi ulang. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('../lib/log');
const { sanitizeFilenamePart } = require('../lib/datatable');
const lampiranWidget = require('../lib/lampiran-widget');

// TaxTypeCode -> nama file resmi. Cuma ICT_RCIT yang sudah diverifikasi live.
const TAXTYPE_CONFIG = {
    ICT_RCIT: { formCode: '1771' }
};


// CONFIRMED LIVE 2026-08-21: role="tab" generik ke-detect 12+ elemen (ikut nangkep menu
// navigasi atas Coretax - "Portal Saya"/"e-Faktur"/"eBUPOT" dst juga pakai role tab), bukan
// cuma 7 tab form yang dimaksud - looping ke SEMUANYA nyaris menggantung (banyak timeout).
// Daftar label eksak (ID + EN, tab pertama beda nama tergantung bahasa halaman) jauh lebih
// aman - HANYA diverifikasi untuk PPh Badan (ICT_RCIT).
const TAB_LABELS_BY_TAXTYPE = {
    ICT_RCIT: ['Induk', 'Main Form', 'L1-A', 'L2', 'L4', 'L6', 'L8', 'L11-B']
};

/** Tab form (Induk/L1-A/L2/dst) - dicocokkan by EXACT text match terhadap daftar label yang
 *  sudah diverifikasi live, bukan discovery generik (lihat komentar di atas). Entitas yang
 *  tidak punya lampiran tertentu (mis. L11-B tidak relevan) otomatis dilewati - isVisible()
 *  akan false untuk label yang tidak ada di halaman ini. */
async function discoverTabs(page, taxTypeCode) {
    const candidates = TAB_LABELS_BY_TAXTYPE[taxTypeCode] || [];
    const found = [];
    for (const label of candidates) {
        const loc = page.getByText(label, { exact: true }).first();
        const visible = await loc.isVisible({ timeout: 800 }).catch(() => false);
        if (visible) found.push(loc);
    }
    return found;
}

/** Menyiapkan halaman untuk dicetak: memaksa orientasi LANDSCAPE lewat @page milik kita sendiri,
 *  dan menyembunyikan kerangka aplikasi (nav kiri, footer DJP, widget kita) yang bukan bagian
 *  dari formulir.
 *
 *  AKAR MASALAH LANDSCAPE (ditemukan live 2026-08-21 lewat deteksi @page REKURSIF - deteksi
 *  non-rekursif sebelumnya melewatkannya karena rule-nya bersarang di dalam @media):
 *  CORETAX SENDIRI mendeklarasikan `@page { size: a3; }` di stylesheet-nya. Chrome memberi
 *  PRIORITAS pada CSS @page di atas parameter CDP printToPDF - itu sebabnya `landscape: true`
 *  DIABAIKAN TOTAL dan paperWidth/paperHeight yang kita kirim selalu dinormalkan balik jadi
 *  potrait (dibuktikan: apa pun kombinasi paperWidth/paperHeight/landscape yang dicoba, hasilnya
 *  selalu 8.28x11.69, dan tanpa /Rotate - jadi memang benar-benar potrait, bukan sekadar
 *  metadata rotasi). Di halaman kosong (about:blank, tanpa @page) parameter yang sama bekerja
 *  normal - itu yang sempat menyesatkan.
 *
 *  Fix: inject @page milik kita SETELAH stylesheet Coretax (rule terakhir dengan spesifisitas
 *  sama = menang), lalu cetak dengan `preferCSSPageSize: true` supaya Chrome memakai ukuran dari
 *  CSS itu. Terverifikasi live: hasilnya 11.69x8.26in - landscape sungguhan. */
const PRINT_STYLE_ID = '__ca_print_style';
async function preparePageForPrint(page) {
    // Catatan soal "blok krem" di ekor halaman terakhir (dikira halaman blank oleh user):
    // itu BUKAN elemen tersendiri, melainkan background <body> Coretax sendiri
    // (rgb(245,244,239), dikonfirmasi via getComputedStyle live). Per spesifikasi CSS,
    // background body merambat ke kanvas cetak dan mengisi SELURUH area halaman - jadi sisa
    // ruang kosong di halaman terakhir ikut berwarna krem dan terlihat seperti blok aneh.
    // Diputihkan khusus saat cetak supaya sisa ruang itu tampil sebagai margin putih biasa
    // (ruang sisa di halaman terakhir sendiri tidak bisa dihilangkan - itu wajar di dokumen
    // cetak mana pun, kecuali tinggi konten kebetulan pas kelipatan tinggi halaman).
    const css = `
        @page { size: A4 landscape; margin: 8mm; }
        @media print {
            html, body { background: #ffffff !important; }
            nav, aside, footer, [class*="sidebar" i], [class*="side-nav" i], [class*="footer" i],
            #__ca_lampiran_widget, #__ca_passphrase_widget { display: none !important; }
        }
    `;
    // Idempoten: kalau sudah pernah dipasang cukup pastikan tetap jadi elemen TERAKHIR di <head>
    // (Angular bisa menyisipkan style baru setelahnya saat re-render antar tab).
    const script = `(() => {
        try {
            let el = document.getElementById(${JSON.stringify(PRINT_STYLE_ID)});
            if (!el) {
                el = document.createElement('style');
                el.id = ${JSON.stringify(PRINT_STYLE_ID)};
                el.textContent = ${JSON.stringify(css)};
            }
            document.head.appendChild(el); // appendChild memindahkan ke posisi terakhir kalau sudah ada
        } catch (e) {}
    })();`;
    await page.evaluate(script).catch(() => {});
}

// CONFIRMED LIVE 2026-08-21 (user feedback dengan screenshot): A4 potrait bikin tabel lebar
// (neraca L1-A, daftar bulan L11-B, kolom L4) kepotong/bolong; landscape + scale diperkecil
// jauh lebih pas dan bikin "Laporan Laba Rugi"/"Laporan Posisi Keuangan" tetap berdampingan
// (bukan numpuk vertikal) kayak di layar aslinya. Diverifikasi live - INI YANG DIPAKAI.
//
// DUA percobaan "satu halaman custom setinggi konten" (supaya tidak ada sisa halaman kosong
// di ekor) SUDAH DICOBA DAN DIBUANG - jangan diulang tanpa alasan baru:
//   1) Ukur scrollHeight di lebar viewport PENUH lalu bagi PRINT_SCALE - salah total, konten
//      Coretax responsive (tinggi beda jauh tergantung lebar render), hasil kacau + landscape
//      keikutan hilang.
//   2) Resize JENDELA (via CDP Browser.setWindowBounds, pola sama revealWindow()) ke lebar
//      cetak, ukur di sana, lalu kembalikan ukuran jendela - masih GAGAL: CDP Page.printToPDF
//      ternyata punya jalur layout SENDIRI yang independen dari ukuran window browser
//      sesungguhnya (paperWidth/scale menentukan reflow-nya sendiri, bukan window resize),
//      dikonfirmasi via inspeksi /MediaBox mentah pada PDF hasil - benar-benar 3 halaman FISIK
//      terpisah @43in masing-masing padahal seharusnya 1 halaman, bukan artefak viewer preview.
// Kesimpulan: ukuran A4 landscape tetap adalah yang paling reliable saat ini - satu sisa
// halaman kosong di ekor beberapa tab adalah trade-off kosmetik yang diterima, ketimbang
// pendekatan dinamis yang berulang kali terbukti tidak bisa diandalkan.
const PRINT_SCALE = 0.8;

async function printCurrentStateToPdfBuffer(session) {
    // Ukuran & margin halaman datang dari @page yang di-inject preparePageForPrint() (lihat
    // penjelasan lengkap di sana) - JANGAN kirim paperWidth/paperHeight/landscape di sini:
    // semuanya akan kalah oleh @page milik Coretax sendiri. preferCSSPageSize:true adalah kunci
    // yang membuat Chrome memakai @page kita.
    const result = await session.send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        scale: PRINT_SCALE
    });
    return Buffer.from(result.data, 'base64');
}

// Satu file PER TAB (bukan digabung) - permintaan eksplisit user ("filenya jadi banyak aja")
// supaya tiap lampiran bisa dibuka/di-print sendiri tanpa terkunci ke ukuran gabungan.
function buildOutPath(saveRoot, entityCode, year, taxTypeCode, tabLabel) {
    const cfg = TAXTYPE_CONFIG[taxTypeCode] || {};
    const dir = path.join(saveRoot, entityCode, 'SPT', String(year));
    fs.mkdirSync(dir, { recursive: true });
    const filename = sanitizeFilenamePart(entityCode) + ' - ' + (cfg.formCode || taxTypeCode) + ' LAMPIRAN ' + sanitizeFilenamePart(tabLabel) + ' ' + year + '.pdf';
    return path.join(dir, filename);
}

/** Cari tahun pajak dari field formulir itu sendiri (formcontrolname="TaxYear", terverifikasi
 *  live di kamus label sebelumnya) - HARUS baca .inputValue(), bukan innerText(): nilai kotak
 *  input tidak pernah masuk innerText (itu properti DOM, bukan teks yang dirender), ditemukan
 *  live 2026-08-21 setelah fallback regex-nya salah nangkep tahun lain di halaman (filename
 *  jadi "2026" padahal SPT-nya 2025). Fallback ke regex teks kalau field tidak ketemu. */
async function detectYear(page) {
    const val = await page.locator('[formcontrolname="TaxYear"]').first().inputValue({ timeout: 2000 }).catch(() => null);
    const fromField = val && val.match(/\d{4}/);
    if (fromField) return fromField[0];
    const text = await page.locator('body').innerText().catch(() => '');
    const m = text.match(/Tahun Pajak[^\d]*(\d{4})/i) || text.match(/Tax Year[^\d]*(\d{4})/i);
    return m ? m[1] : String(new Date().getFullYear());
}

/** Dipanggil dari widget (via exposeFunction). `ctx`: { saveRoot, entityCode, compFolder }. */
async function downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode) {
    if (!taxTypeCode || !TAXTYPE_CONFIG[taxTypeCode]) {
        return { ok: false, error: 'Jenis SPT ini belum didukung (baru PPh Badan).' };
    }
    try {
        await preparePageForPrint(page);
        const tabs = await discoverTabs(page, taxTypeCode);
        if (!tabs.length) return { ok: false, error: 'Tidak menemukan tab form (Induk/L1-A/dst) di halaman ini.' };

        const session = await page.context().newCDPSession(page);
        const year = await detectYear(page);
        const entityCode = ctx.entityCode || sanitizeFilenamePart(taxpayerId || 'ENTITY');
        const savedPaths = [];
        for (let i = 0; i < tabs.length; i++) {
            const label = ((await tabs[i].textContent().catch(() => '')) || ('tab-' + i)).trim();
            try {
                await tabs[i].click({ timeout: 5000 });
            } catch (e) {
                log('[Lampiran] Gagal klik tab "' + label + '": ' + e.message + ' - dilewati.');
                continue;
            }
            await page.waitForTimeout(1200);
            await preparePageForPrint(page);
            try {
                const buf = await printCurrentStateToPdfBuffer(session);
                const outPath = buildOutPath(ctx.saveRoot, entityCode, year, taxTypeCode, label);
                fs.writeFileSync(outPath, buf);
                savedPaths.push(outPath);
                log('[Lampiran] Tersimpan (' + label + ', ' + buf.length + ' bytes): ' + outPath);
                if (ctx.compFolder) {
                    try {
                        fs.mkdirSync(ctx.compFolder, { recursive: true });
                        fs.copyFileSync(outPath, path.join(ctx.compFolder, path.basename(outPath)));
                    } catch (e) { log('[Lampiran] Gagal menyalin ke compliance (' + label + '): ' + e.message); }
                }
            } catch (e) {
                log('[Lampiran] Gagal cetak tab "' + label + '": ' + e.message + ' - dilewati.');
            }
        }
        if (!savedPaths.length) return { ok: false, error: 'Tidak ada satu pun tab yang berhasil dicetak.' };

        // Kembali ke tab pertama (Induk) - jangan tinggalkan user di tab terakhir yang dicetak.
        try { await tabs[0].click({ timeout: 3000 }); } catch (e) {}
        return { ok: true, count: savedPaths.length, paths: savedPaths, dir: path.dirname(savedPaths[0]) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Memasang widget "Unduh Lampiran Lengkap" pada `page`. Aman dipanggil berkali-kali untuk page
 *  yang sama (exposeFunction gagal diam-diam kalau sudah pernah dipasang - itu OK). */
async function installLampiranWidget(page, { saveRoot, entityCode, compFolder }) {
    const ctx = { saveRoot: saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent'), entityCode, compFolder };
    try {
        await page.context().exposeFunction('__ca_downloadLampiran', (taxpayerId, recordId, taxTypeCode) => downloadLampiran(page, ctx, taxpayerId, recordId, taxTypeCode));
    } catch (e) {
        // Sudah pernah di-expose sebelumnya di context yang sama - function-nya masih terpasang.
    }

    const script = lampiranWidget.buildLampiranWidgetScript();
    try {
        await page.context().addInitScript({ content: script });
        await page.evaluate(script);
    } catch (e) {
        log('[Lampiran] Gagal memasang widget: ' + e.message);
    }
}

module.exports = { installLampiranWidget, downloadLampiran, TAXTYPE_CONFIG };
