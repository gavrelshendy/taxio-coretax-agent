/* In-page "Unduh Lampiran Lengkap" widget - SAMA POLA dengan buildPassphraseWidgetScript di
   coretax-watchdog.js (tombol mengambang, self-healing tiap 1 detik kalau Angular SPA
   me-re-render dan menghapusnya), bedanya tombol ini cuma tampil ketika URL halaman sedang
   berada di sebuah SPT view page (.../corporate-income-tax-return/{taxpayerId}/{recordId}/
   {taxType}/{formId}?view=true) - dideteksi lewat regex terhadap location.pathname, BUKAN lewat
   scraping DOM, supaya tidak rapuh terhadap perubahan tampilan Coretax.

   Klik tombol memanggil window.__ca_downloadLampiran() (Node-side, lihat automation/lampiran.js)
   dengan {taxpayerId, recordId, taxTypeCode} yang diparse dari URL - Node yang urus sisanya
   (fetch data lengkap, render PDF, simpan file), halaman ini cuma UI + parsing URL. */

// TaxTypeCode yang sudah punya kamus label (lihat automation/lampiran-labels/) - dipetakan dari
// segmen URL Coretax sendiri, BUKAN ditebak dari nama Bahasa Inggris di URL (lebih stabil).
const URL_KIND_TO_TAXTYPE = {
    'corporate-income-tax-return': 'ICT_RCIT',
    // SPT OP 1770 - diverifikasi live 2026-08-21 pada akun SOHENDRA SO. Perhatikan segmen URL-nya
    // "personal-…", BUKAN "individual-…" seperti dugaan awal.
    'personal-income-tax-return': 'ICT_PIT'
};

function buildLampiranWidgetScript() {
    const kindMapJson = JSON.stringify(URL_KIND_TO_TAXTYPE);
    return `(() => {
        const KIND_TO_TAXTYPE = ${kindMapJson};
        const URL_RE = new RegExp('/(' + Object.keys(KIND_TO_TAXTYPE).join('|') + ')/([0-9a-f-]{30,36})/([0-9a-f-]{30,36})/(\\\\w+)/([0-9a-f-]{30,36})', 'i');

        function parseTarget() {
            const m = URL_RE.exec(window.location.pathname);
            if (!m) return null;
            return { kind: m[1], taxpayerId: m[2], recordId: m[3], taxTypeCodeInUrl: m[4], formId: m[5] };
        }

        function applyClickHandler(btn) {
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const target = parseTarget();
                if (!target) return;
                if (typeof window.__ca_downloadLampiran !== 'function') {
                    btn.innerHTML = '⚠️ Fitur belum siap';
                    setTimeout(() => { btn.innerHTML = '📄 Unduh Lampiran Lengkap'; }, 2500);
                    return;
                }
                btn.disabled = true;
                btn.innerHTML = '⏳ Memproses...';
                try {
                    const result = await window.__ca_downloadLampiran(target.taxpayerId, target.recordId, KIND_TO_TAXTYPE[target.kind]);
                    if (result && result.ok) {
                        btn.innerHTML = '✅ ' + (result.count || 1) + ' file tersimpan!';
                    } else {
                        btn.innerHTML = '❌ ' + ((result && result.error) || 'Gagal');
                    }
                } catch (err) {
                    btn.innerHTML = '❌ Gagal: ' + (err && err.message ? err.message : 'error');
                }
                setTimeout(() => { btn.innerHTML = '📄 Unduh Lampiran Lengkap'; btn.disabled = false; }, 3000);
            };
        }

        function ensureWidget() {
            if (!document.documentElement) return;
            const target = parseTarget();
            let btn = document.getElementById('__ca_lampiran_widget');
            if (!target) {
                if (btn) btn.remove();
                return;
            }
            if (!btn) {
                btn = document.createElement('button');
                btn.id = '__ca_lampiran_widget';
                btn.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0D9488;color:#F8FAFC;border:1px solid #0F766E;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;align-items:center;gap:6px;font-family:sans-serif;';
                btn.innerHTML = '📄 Unduh Lampiran Lengkap';
                try { document.documentElement.appendChild(btn); } catch (e) { return; }
            }
            applyClickHandler(btn);
        }

        ensureWidget();
        if (!window.__ca_lampiran_widget_interval) {
            window.__ca_lampiran_widget_interval = setInterval(ensureWidget, 1000);
        }
    })();`;
}

module.exports = { buildLampiranWidgetScript, URL_KIND_TO_TAXTYPE };
