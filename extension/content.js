/* Coretax - Unduh Lampiran SPT (content script).

   Versi extension dari fitur "Unduh Lampiran Lengkap" di aplikasi Coretax Agent
   (automation/lampiran.js + lib/lampiran-widget.js). Bedanya: TIDAK ada Playwright dan TIDAK ada
   koneksi ke Taxio - user login sendiri di browser-nya, lalu klik tombol yang muncul di halaman.

   Seluruh logika DOM (deteksi tab, pindah tab, expand tabel, CSS cetak) di sini berjalan LANGSUNG
   di halaman - di aplikasi hal yang sama harus lewat page.evaluate(). Yang tidak bisa dikerjakan
   content script cuma dua: mencetak PDF dan menyimpan file - keduanya didelegasikan ke
   background.js (chrome.debugger + chrome.downloads).

   Catatan penting yang dibawa dari hasil investigasi live di aplikasi (jangan diubah tanpa uji
   ulang - semuanya sudah terbukti bermasalah sekali):
     - Coretax mendeklarasikan `@page { size: a3 }` sendiri, dan Chrome memprioritaskan CSS @page
       di atas parameter cetak. Maka orientasi HARUS dipaksa lewat @page milik kita + dicetak
       dengan preferCSSPageSize:true (lihat background.js).
     - Tabel lebar duduk dalam kontainer overflow-x:auto - kalau tidak dibuka, kolom kanan hilang
       saat dicetak. Dibuka DAN tabelnya di-reflow agar muat lebar kertas.
     - Panel semua tab ada bersamaan di DOM, jadi pencarian elemen harus dibatasi yang TAMPIL.
     - Elemen tab harus dicari ULANG tiap kali (Angular me-render ulang strip tab), dan hasil
       perpindahan tab harus DIVERIFIKASI - kalau tidak, bisa tercetak isi tab yang sama dua kali.
*/
(() => {
    'use strict';

    const KIND_TO_TAXTYPE = {
        'corporate-income-tax-return': 'ICT_RCIT',  // SPT Badan 1771
        'personal-income-tax-return': 'ICT_PIT'     // SPT Orang Pribadi 1770
    };
    const FORM_CODE = { ICT_RCIT: '1771', ICT_PIT: '1770' };
    // Cocok untuk halaman SPT terlapor (…?view=true) MAUPUN konsep/draft (…/01122025) - keduanya
    // sudah diverifikasi live.
    const URL_RE = new RegExp('/(' + Object.keys(KIND_TO_TAXTYPE).join('|') +
        ')/([0-9a-f-]{30,36})/([0-9a-f-]{30,36})/(\\w+)/([0-9a-f-]{30,36})', 'i');

    // Selector class PrimeNG, BUKAN pencocokan teks: penamaan tab Badan ("L1-B", "L10-A") dan OP
    // ("L-1", "L-3A-4") polanya berbeda, jadi regex teks apa pun akan gagal di salah satunya.
    const TAB_TITLE_SEL = '.p-tabview-title';
    const MAX_ROWS_TO_EXPAND = 300;   // tabel lebih besar dari ini -> dibatasi
    const COMPACT_ROWS = 50;          // jumlah baris pada mode compact
    const TAB_ROW_CAP = { 'L9': 10 }; // batas khusus per tab
    // Tab yang menghasilkan DUA file: "(Print)" dibatasi + "(Lengkap)" seluruh baris.
    const TWO_VERSION_TABS = ['L3', 'L4', 'L9'];
    const PRINT_STYLE_ID = '__ca_print_style';
    const BTN_ID = '__ca_lampiran_widget';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function parseTarget() {
        const m = URL_RE.exec(window.location.pathname);
        return m ? { kind: m[1], taxTypeCode: KIND_TO_TAXTYPE[m[1]] } : null;
    }

    function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    // ---------- Persiapan cetak ----------
    function preparePageForPrint() {
        const css = `
            @page { size: A3 landscape; margin: 8mm; }
            @media print {
                html, body { background: #ffffff !important; }
                nav, aside, footer, [class*="sidebar" i], [class*="side-nav" i], [class*="footer" i],
                #${BTN_ID} { display: none !important; }
                .p-datatable-wrapper, [class*="datatable" i], [class*="table-wrap" i],
                [class*="scroll" i] { overflow: visible !important; }
                table { width: 100% !important; max-width: 100% !important;
                        table-layout: auto !important; font-size: 7.5pt !important; }
                th, td { padding: 2px 3px !important; white-space: normal !important;
                         word-break: break-word !important; min-width: 0 !important; }
                col, colgroup { width: auto !important; }
            }`;
        let el = document.getElementById(PRINT_STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = PRINT_STYLE_ID;
            el.textContent = css;
        }
        // appendChild memindahkan ke posisi terakhir supaya selalu menang atas style Coretax.
        document.head.appendChild(el);
    }

    // ---------- Tab ----------
    function discoverTabLabels() {
        const seen = [];
        Array.from(document.querySelectorAll(TAB_TITLE_SEL)).forEach((el) => {
            const t = (el.textContent || '').trim();
            if (!t || seen.indexOf(t) !== -1 || !isVisible(el)) return;
            seen.push(t);
        });
        return seen;
    }

    function findTab(label) {
        return Array.from(document.querySelectorAll(TAB_TITLE_SEL)).find(
            (e) => (e.textContent || '').trim() === label && isVisible(e)) || null;
    }

    function panelSignature() {
        const t = (document.body.innerText || '').replace(/\s+/g, ' ');
        return t.length + '|' + t.slice(0, 400);
    }

    // ---------- Tabel ----------
    /** Tabel PrimeNG default hanya menampilkan 10 baris pertama; sisanya tidak ikut tercetak.
     *  Di sini dropdown "rows per page" tiap tabel yang TAMPIL diatur: tampilkan semua, atau
     *  dibatasi kalau tabelnya besar / tab-nya punya batas khusus. */
    async function setUpTables(tabLabel, mode) {
        const tabCap = TAB_ROW_CAP[String(tabLabel || '').trim()] || 0;
        const dropdowns = Array.from(document.querySelectorAll('.p-paginator-rpp-options')).filter(isVisible);
        let done = 0;

        for (const dd of dropdowns) {
            try {
                if ((dd.className || '').indexOf('p-disabled') !== -1) continue; // tabel kosong

                const pag = dd.closest('.p-paginator');
                const txt = pag ? (pag.textContent || '') : '';
                const m = txt.match(/(?:of|dari)\s+([\d.,]+)\s+(?:entries|entri)/i);
                const total = m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : 0;
                // 'all' = tanpa batas, 'compact' = paksa batasi, selain itu otomatis.
                let cap;
                if (mode === 'all') cap = 0;
                else if (mode === 'compact') cap = tabCap || COMPACT_ROWS;
                else cap = tabCap || (total > MAX_ROWS_TO_EXPAND ? COMPACT_ROWS : 0); // 0 = semua

                const current = parseInt((dd.textContent || '').replace(/[^\d]/g, ''), 10);
                if (cap && current === cap) continue; // sudah pas

                dd.click();
                await sleep(350);
                const items = Array.from(document.querySelectorAll('.p-dropdown-panel .p-dropdown-item')).filter(isVisible);
                if (!items.length) { document.body.click(); continue; }

                let pick = items.length - 1; // default: opsi terbesar = tampilkan semua
                if (cap) {
                    const vals = items.map((it) => {
                        const d = (it.textContent || '').replace(/[^\d]/g, '');
                        return d ? parseInt(d, 10) : NaN;
                    });
                    let best = -1;
                    vals.forEach((v, i) => { if (!isNaN(v) && v <= cap && (best === -1 || v > vals[best])) best = i; });
                    pick = best !== -1 ? best : 0;
                }
                items[pick].click();
                done++;
                await sleep(500);
            } catch (e) { /* satu tabel gagal jangan menggagalkan sisanya */ }
        }
        return done;
    }

    // ---------- Identitas untuk nama file ----------
    function readFieldValue(name) {
        const el = document.querySelector('[formcontrolname="' + name + '"]');
        if (!el) return '';
        return (el.value != null ? String(el.value) : (el.textContent || '')).trim();
    }
    function sanitize(s) {
        return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    function detectYear() {
        const v = readFieldValue('TaxYear').match(/\d{4}/);
        if (v) return v[0];
        const t = (document.body.innerText || '').match(/(?:Tahun Pajak|Tax Year)[^\d]*(\d{4})/i);
        return t ? t[1] : String(new Date().getFullYear());
    }
    function detectEntity() {
        // Nama file mengikuti WP AKTIF pada pill akun Coretax, bukan field nama pada SPT.
        // Ini penting saat PIC sedang impersonate: field form dapat tetap memuat nama pihak
        // lain, sedangkan pill header adalah sumber sesi yang benar.
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const tidy = (s) => clean(s).replace(/\bIMPERSONATE\b/ig, '')
            .replace(/\b\d{15,16}\b/g, '').replace(/[·|]+/g, ' ').trim();
        const topVisible = (e) => {
            const r = e.getBoundingClientRect(), c = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && r.top < 150 && c.display !== 'none' && c.visibility !== 'hidden';
        };
        const pools = [];
        const imp = Array.from(document.querySelectorAll('body *')).find(
            (e) => topVisible(e) && /IMPERSONATE/i.test(clean(e.textContent)) && clean(e.textContent).length < 40);
        if (imp) {
            let p = imp;
            for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
                if (topVisible(p)) pools.push(p.title, p.getAttribute('aria-label'), p.textContent);
            }
        }
        Array.from(document.querySelectorAll('header [title],header [aria-label],header button,header [role="button"],nav [role="button"]'))
            .filter(topVisible).forEach((e) => pools.push(e.title, e.getAttribute('aria-label'), e.textContent));
        let best = '';
        const score = (s) => { s = tidy(s); return (!s || s.length < 3 || s.length > 100) ? -1 : (/[A-Za-z]{3}/.test(s) ? 10 : 0) + s.split(' ').length; };
        for (const raw of pools) {
            const s = tidy(raw);
            if (score(s) > score(best) && !/portal|beranda|profil|logout|bahasa|notifikasi/i.test(s)) best = s;
        }
        const name = readFieldValue('Name');
        const tin = readFieldValue('Tin') || readFieldValue('CollectorTin');
        return sanitize(best || name || tin) || 'SPT';
    }

    // ---------- Alur utama ----------
    /** `mode`: 'print' (lampiran berdaftar panjang dibatasi - cepat) atau 'full' (seluruh baris).
     *  Dipilih user di awal, bukan dicetak dua-duanya sekaligus: pada WP dengan bukti potong
     *  ratusan ribu baris, mencetak dua versi berarti menunggu dua kali lebih lama tanpa perlu. */
    async function runDownload(btn, mode) {
        const target = parseTarget();
        if (!target) return;

        const setLabel = (s) => { btn.innerHTML = s; };
        preparePageForPrint();

        // Tunggu tab muncul - tombol ini tampil begitu URL berubah, sementara Angular masih
        // merender formulirnya beberapa detik (lihat catatan yang sama di automation/lampiran.js).
        let labels = discoverTabLabels();
        const tabDeadline = Date.now() + 25000;
        while (!labels.length && Date.now() < tabDeadline) {
            setLabel('⏳ Menunggu halaman SPT dimuat...');
            await sleep(1000);
            labels = discoverTabLabels();
        }
        if (!labels.length) { setLabel('❌ Tab lampiran belum muncul - coba lagi'); return; }

        const entity = detectEntity();
        const year = detectYear();
        const formCode = FORM_CODE[target.taxTypeCode] || target.taxTypeCode;

        const begin = await chrome.runtime.sendMessage({
            type: 'beginPrintSession', entity, year, formCode,
            mergeName: mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)'
        });
        if (!begin || !begin.ok) { setLabel('❌ ' + ((begin && begin.error) || 'Gagal menyiapkan pencetakan')); return; }

        let saved = 0, failed = 0;
        const pages = []; // halaman tiap lampiran, untuk berkas gabungan di akhir
        let prevSig = panelSignature();
        try {
            for (let i = 0; i < labels.length; i++) {
                const label = labels[i];
                setLabel('⏳ ' + label + ' (' + (i + 1) + '/' + labels.length + ')');

                // Cari ulang elemen tab SETIAP kali - strip tab di-render ulang tiap perpindahan.
                let switched = false;
                for (let attempt = 0; attempt < 2 && !switched; attempt++) {
                    const tab = findTab(label);
                    if (!tab) break;
                    tab.click();
                    await sleep(1400);
                    const sig = panelSignature();
                    // Tab pertama memang sudah aktif sejak awal, jadi tidak harus berubah.
                    if (i === 0 || sig !== prevSig) { switched = true; prevSig = sig; }
                }
                if (!switched && i > 0) { failed++; continue; } // hindari menyimpan duplikat

                // Hanya SATU versi per tab, sesuai mode yang dipilih user di awal. Sufiks nama
                // dipakai hanya untuk lampiran yang memang punya dua versi, supaya hasil mode
                // Print dan Lengkap tidak saling menimpa kalau dijalankan dua kali.
                const twoVersion = TWO_VERSION_TABS.indexOf(label) !== -1;
                const suffix = twoVersion ? (mode === 'print' ? ' (Print)' : ' (Lengkap)') : '';
                const tableMode = mode === 'print' ? 'compact' : 'all';

                setLabel('⏳ ' + label + ' (' + (i + 1) + '/' + labels.length + ')');
                await setUpTables(label, tableMode);
                preparePageForPrint();
                await sleep(300);

                const filename = 'CoretaxLampiran/' + entity + '/' + year + '/' +
                    entity + ' - ' + formCode + ' LAMPIRAN ' + sanitize(label + suffix) + ' ' + year + '.pdf';
                const res = await chrome.runtime.sendMessage({ type: 'printTab', filename });
                if (res && res.ok) { saved++; if (res.b64) pages.push(res.b64); } else failed++;
            }
        } finally {
            if (pages.length) {
                setLabel('⏳ Menggabungkan ' + pages.length + ' lampiran...');
                const mergeName = mode === 'print' ? 'GABUNGAN (Print)' : 'GABUNGAN (Lengkap)';
                const mf = 'CoretaxLampiran/' + entity + '/' + year + '/' +
                    entity + ' - ' + formCode + ' LAMPIRAN ' + mergeName + ' ' + year + '.pdf';
                const mres = await chrome.runtime.sendMessage({ type: 'mergeAndSave', list: pages, filename: mf });
                if (mres && mres.ok) saved++; else failed++;
            }
            await chrome.runtime.sendMessage({ type: 'endPrintSession' });
            const first = findTab(labels[0]);
            if (first) first.click(); // kembalikan ke tab awal
        }

        setLabel(saved ? ('✅ ' + saved + ' file tersimpan' + (failed ? ' (' + failed + ' gagal)' : '')) : '❌ Tidak ada yang tersimpan');
    }

    // ---------- Pilihan mode ----------
    const CHOOSER_ID = '__ca_lampiran_chooser';
    function showModeChooser(btn) {
        const old = document.getElementById(CHOOSER_ID);
        if (old) { old.remove(); return; } // klik kedua = tutup
        const box = document.createElement('div');
        box.id = CHOOSER_ID;
        box.style.cssText = 'position:fixed;bottom:60px;left:16px;z-index:2147483647;background:#fff;' +
            'border:1px solid #cbd5e1;border-radius:10px;padding:12px;width:290px;font-family:sans-serif;' +
            'box-shadow:0 8px 24px rgba(0,0,0,0.18);font-size:12px;color:#1a202c;';
        box.innerHTML =
            '<div style="font-weight:700;margin-bottom:8px;">Pilih versi yang diunduh</div>' +
            '<button id="__ca_m_print" style="width:100%;text-align:left;background:#0D9488;color:#fff;border:none;' +
            'border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:7px;">' +
            '📄 Versi Print <span style="font-weight:400;">- cepat</span><br>' +
            '<span style="font-weight:400;font-size:11px;opacity:.9;">Lampiran berdaftar panjang dibatasi 50 baris</span></button>' +
            '<button id="__ca_m_full" style="width:100%;text-align:left;background:#fff;color:#1a202c;border:1px solid #cbd5e1;' +
            'border-radius:7px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:600;">' +
            '📚 Versi Lengkap <span style="font-weight:400;">- seluruh baris</span><br>' +
            '<span style="font-weight:400;font-size:11px;color:#b45309;">⚠️ Bisa sangat lama bila bukti potong ribuan baris</span></button>';
        document.documentElement.appendChild(box);

        const start = async (mode) => {
            box.remove();
            btn.disabled = true;
            try { await runDownload(btn, mode); }
            catch (err) { btn.innerHTML = '❌ ' + (err && err.message ? err.message : 'Gagal'); }
            setTimeout(() => { btn.innerHTML = '📄 Unduh Lampiran Lengkap'; btn.disabled = false; }, 6000);
        };
        box.querySelector('#__ca_m_print').onclick = () => start('print');
        box.querySelector('#__ca_m_full').onclick = () => start('full');
    }

    // ---------- Tombol ----------
    function ensureWidget() {
        if (!document.documentElement) return;
        const target = parseTarget();
        let btn = document.getElementById(BTN_ID);
        if (!target) { if (btn) btn.remove(); return; }
        if (btn) return;

        btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0D9488;' +
            'color:#F8FAFC;border:1px solid #0F766E;padding:8px 14px;border-radius:8px;font-size:12px;' +
            'font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);font-family:sans-serif;';
        btn.innerHTML = '📄 Unduh Lampiran Lengkap';
        btn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (btn.disabled) return;
            showModeChooser(btn);
        };
        document.documentElement.appendChild(btn); // ke <html>, lebih tahan re-render <body>
    }

    ensureWidget();
    // Coretax adalah SPA - URL bisa berubah tanpa reload, dan Angular bisa menghapus tombol kita.
    setInterval(ensureWidget, 1000);
})();
